import { and, eq, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceProductStats,
  commerceProductViewSession,
  type commerceProductViewSourceEnum,
} from "#src/db/schema.js";
import { computeCommerceViewerFingerprint, utcDayStringOf } from "#src/lib/viewer-fingerprint.js";
import { ensureCommerceProductStatsRow } from "#src/modules/store/catalog/commerce-product-engagement.service.js";
import { computeClientSubnetHash } from "#src/modules/store/client-subnet.js";
import {
  clampViewDwellSeconds,
  isCountedViewDwell,
} from "#src/modules/store/commerce-view-clamp.js";

/**
 * The product view beacon (STORE Phase 13).
 *
 * WHY THIS EXISTS AT ALL. Before Phase 13 the store observed no views. Saves, bookmarks,
 * shares and questions were counted; attention was not. A conversion rate is orders over
 * views, so with no view there was no denominator — and the spec's MAD spike triggers and
 * conversion kill-switch had no input whatsoever. Every other signal in the ranking engine
 * could have been built without this file; those two could not.
 *
 * WHAT MAKES IT SAFE TO EXPOSE. This is the second unauthenticated write on the platform
 * and it sits on the store's hottest read path, so the guards are load-bearing rather than
 * ceremonial:
 *
 *   1. `commerce_product_view_session_unq` — one row per (product, fingerprint, UTC day).
 *      A loop cannot manufacture rows, only rewrite its own, and the fingerprint is
 *      server-derived from a secret the caller does not hold.
 *   2. `clampViewDwellSeconds` — the client proposes a total; the server bounds it by wall
 *      time. Attention cannot be asserted, only accumulated.
 *   3. The anonymous gate — an anonymous session counts toward `view_count`, because it is
 *      real traffic, and never toward conversion, because there is nobody to match an
 *      order to. Farming conversion therefore requires real accounts placing real orders.
 *   4. The route's own limiter, and the eligibility check the controller performs before
 *      calling in: a draft, suspended or unapproved listing is a 404 here exactly as it is
 *      everywhere else.
 *
 * IT IS ALSO WHERE A SUBNET FIRST REACHES THE DATABASE. Hashed, truncated to a network
 * block, and never as an address — see `client-subnet.ts`.
 */

type ProductViewSource = (typeof commerceProductViewSourceEnum.enumValues)[number];

export interface RecordProductViewInput {
  readonly productId: string;
  /** NULL for an anonymous reader. THE GATE — see the header. */
  readonly viewerUserId: string | null;
  /** From `req.ip` only. Never a hand-parsed `x-forwarded-for`. */
  readonly clientIp: string | undefined;
  readonly userAgent: string;
  readonly viewSource: ProductViewSource;
  /** The client's claim. Bounded by `clampViewDwellSeconds` before it is believed. */
  readonly claimedDwellSeconds: number;
  /** Injected so the seed and tests can write backdated sessions. */
  readonly occurredAt?: Date;
}

export interface ProductViewBeaconResult {
  /** What the server actually recorded, so a client can reconcile rather than guess. */
  readonly dwellSeconds: number;
  /** Whether this session has cleared the threshold and entered `view_count`. */
  readonly isCountedView: boolean;
}

/**
 * Records or extends today's view session for one viewer and product.
 *
 * Returns a plain value rather than a `Result`: there is no expected domain failure here.
 * The product's eligibility was decided before this was called, and every other outcome —
 * a first beacon, a repeat beacon, a beacon claiming an impossible total — is a normal
 * write. A genuine database fault throws, which is what §3.3 reserves `throw` for.
 */
export async function recordProductViewBeacon(
  input: RecordProductViewInput,
): Promise<ProductViewBeaconResult> {
  const observedAt = input.occurredAt ?? new Date();
  const utcDayString = utcDayStringOf(observedAt);

  const viewerFingerprint = computeCommerceViewerFingerprint({
    utcDayString,
    viewerUserId: input.viewerUserId,
    clientIp: input.clientIp ?? "",
    userAgent: input.userAgent,
  });
  const subnetHash = computeClientSubnetHash(input.clientIp);

  return db.transaction(async (transaction) => {
    await ensureCommerceProductStatsRow(transaction, input.productId);

    /*
     * FOR UPDATE, and it is not optional. Two beacons from one session arriving together
     * would otherwise both read `is_counted_view = false`, both decide they caused the
     * transition, and both increment `view_count` — permanently inflating the denominator
     * every conversion rate divides by. The lock makes the transition happen once.
     */
    const [existing] = await transaction
      .select({
        id: commerceProductViewSession.id,
        dwellSeconds: commerceProductViewSession.dwellSeconds,
        isCountedView: commerceProductViewSession.isCountedView,
        firstBeaconAt: commerceProductViewSession.firstBeaconAt,
      })
      .from(commerceProductViewSession)
      .where(
        and(
          eq(commerceProductViewSession.productId, input.productId),
          eq(commerceProductViewSession.viewerFingerprint, viewerFingerprint),
          eq(commerceProductViewSession.viewDayBucket, utcDayString),
        ),
      )
      .for("update");

    const firstBeaconAt = existing?.firstBeaconAt ?? observedAt;
    const dwellSeconds = clampViewDwellSeconds({
      claimedTotalDwellSeconds: input.claimedDwellSeconds,
      storedDwellSeconds: existing?.dwellSeconds ?? 0,
      firstBeaconAt,
      observedAt,
    });
    const isCountedView = isCountedViewDwell(dwellSeconds);

    if (existing === undefined) {
      await transaction.insert(commerceProductViewSession).values({
        productId: input.productId,
        viewerId: input.viewerUserId,
        viewerFingerprint,
        viewDayBucket: utcDayString,
        viewSource: input.viewSource,
        subnetHash,
        dwellSeconds,
        isCountedView,
        firstBeaconAt: observedAt,
        lastBeaconAt: observedAt,
      });
    } else {
      await transaction
        .update(commerceProductViewSession)
        .set({
          dwellSeconds,
          isCountedView,
          lastBeaconAt: observedAt,
          /*
           * The subnet is written only if the row does not already carry one. A session
           * that began on an office network and continued on a phone is one session, and
           * letting the last beacon win would let an attacker launder concentration by
           * finishing every session from a different block.
           */
          ...(subnetHash !== null && existing.id !== undefined
            ? { subnetHash: sql`coalesce(${commerceProductViewSession.subnetHash}, ${subnetHash})` }
            : {}),
        })
        .where(eq(commerceProductViewSession.id, existing.id));
    }

    // The counter moves ONCE, on the transition — never on every beacon.
    const crossedThreshold = isCountedView && !(existing?.isCountedView ?? false);
    if (crossedThreshold) {
      await transaction
        .update(commerceProductStats)
        .set({ viewCount: sql`${commerceProductStats.viewCount} + 1` })
        .where(eq(commerceProductStats.productId, input.productId));
    }

    return { dwellSeconds, isCountedView };
  });
}
