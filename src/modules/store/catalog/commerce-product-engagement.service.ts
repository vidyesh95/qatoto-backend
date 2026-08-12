import { and, asc, desc, eq, gt, inArray, lt, or, sql, type SQL } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceProductEngagement,
  commerceProductShare,
  commerceProductStats,
} from "#src/db/schema.js";
import { decodeTimestampStoreCursor, encodeStoreCursor } from "#src/modules/store/store-cursor.js";
import type { Result } from "#src/types/index.js";
// From `utc-day.js` and NOT `viewer-fingerprint.js`, which reads `config` at module scope:
// this service is imported by the product read path, and a unit test of that path must not
// need a populated environment to name a UTC day.
import { utcDayStringOf } from "#src/lib/utc-day.js";
/**
 * THIS MODULE TAKES PRODUCT IDS, NOT SLUGS, and deliberately does not import
 * `store-catalog.service`.
 *
 * `store-catalog` imports `loadProductEngagements` to put the counters on the product
 * detail projection. If this file also imported the catalog's slug resolver the two
 * would form an import cycle — which ESM tolerates right up until one of them needs a
 * value from the other at module-evaluation time. Slug resolution therefore happens in
 * the controller, which is allowed to depend on both.
 */

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DatabaseExecutor = DatabaseTransaction | typeof db;

export type ProductEngagementKind =
  (typeof commerceProductEngagement.$inferSelect)["engagementKind"];

/**
 * Request-derived facts an engagement write may record (STORE Phase 13).
 *
 * `subnetHash` is a salted, truncated network key — see `client-subnet.ts`. It is
 * OPTIONAL AND NULLABLE ON PURPOSE at every layer: a request whose address cannot be
 * derived has no honest value here, and substituting a placeholder would make every such
 * request look like one enormous colluding network. The subnet guard skips a product
 * whose hashed sample is too small rather than reading a null as low concentration.
 *
 * `occurredAt` is injected so the seed and the tests can write backdated rows without
 * this module reading a clock they cannot control.
 */
export interface EngagementRequestContext {
  readonly subnetHash?: string | null;
  readonly occurredAt?: Date;
}

/**
 * The only way a public engagement write fails: the product is not publicly eligible,
 * which is indistinguishable from "does not exist" on purpose (§11 anti-enumeration).
 */
export type CommerceProductEngagementError = { type: "NOT_FOUND" };

export interface ProductViewerEngagement {
  readonly hasSaved: boolean;
  readonly hasBookmarked: boolean;
}

export interface ProductEngagementProjection {
  readonly savedCount: number;
  readonly bookmarkedCount: number;
  readonly shareCount: number;
  readonly questionCount: number;
  readonly answeredQuestionCount: number;
  /** Counted views — sessions that cleared the dwell threshold (STORE Phase 13). */
  readonly viewCount: number;
  /**
   * Distinct viewers, or `null` when the nightly rollup has not written one yet.
   *
   * NULL IS NOT ZERO. No transaction can maintain a DISTINCT count incrementally, so this
   * is computed by the rollup or not at all, and a zero would state a false denominator to
   * any client trying to reason about reach. Same rule as `viewer` below.
   */
  readonly uniqueViewerCount: number | null;
  /**
   * `null` for an anonymous caller, NOT `{hasSaved: false}`.
   *
   * "You have not saved this" and "we do not know who you are" are different facts,
   * and a definite `false` for a signed-out visitor teaches the client to render a
   * negative it has no basis for. Same reasoning as `video_stats.uniqueViewerCount`
   * being nullable rather than defaulting to zero.
   */
  readonly viewer: ProductViewerEngagement | null;
}

export const EMPTY_PRODUCT_ENGAGEMENT: ProductEngagementProjection = {
  savedCount: 0,
  bookmarkedCount: 0,
  shareCount: 0,
  questionCount: 0,
  answeredQuestionCount: 0,
  viewCount: 0,
  uniqueViewerCount: null,
  viewer: null,
};

/**
 * Mints the stats row for a product if it is missing.
 *
 * Called from THREE places — the migration backfill, product creation, and the top of
 * every toggle transaction — and the third is not redundant. Products have creation
 * paths this phase does not own, and a missing stats row makes the counter UPDATE
 * affect zero rows and lose the count with no error at all. `ensureVideoStatsRows`
 * carries the same warning for the same reason.
 */
export async function ensureCommerceProductStatsRow(
  executor: DatabaseExecutor,
  productId: string,
): Promise<void> {
  await executor.insert(commerceProductStats).values({ productId }).onConflictDoNothing();
}

/**
 * Counter deltas as literal `.set()` payloads, one per kind.
 *
 * NOT a dynamic `{ [column.name]: ... }`: drizzle's `.set()` is keyed by the TypeScript
 * property name (`savedCount`), while `column.name` is the DATABASE name
 * (`saved_count`). A computed key widens the object type enough that the compiler
 * accepts the mismatch and the update silently sets nothing.
 */
function buildEngagementCounterDelta(
  engagementKind: ProductEngagementKind,
  direction: "increment" | "decrement",
): { savedCount: SQL } | { bookmarkedCount: SQL } {
  const column =
    engagementKind === "saved"
      ? commerceProductStats.savedCount
      : commerceProductStats.bookmarkedCount;
  // GREATEST floors at zero: a drifted counter must not go negative and trip
  // `commerce_product_stats_counters_non_negative_ck` on an ordinary un-save.
  const delta = direction === "increment" ? sql`${column} + 1` : sql`GREATEST(${column} - 1, 0)`;
  return engagementKind === "saved" ? { savedCount: delta } : { bookmarkedCount: delta };
}

/**
 * Save or bookmark a product for the calling USER (Appendix A11).
 *
 * THE NO-DOUBLE-COUNT SHAPE, taken from `setVideoSave`: insert with
 * `onConflictDoNothing().returning()` and move the counter ONLY when a row actually
 * appeared. Checking "does a row exist?" and then inserting would let two concurrent
 * taps both see nothing and both increment, permanently inflating the count for one
 * save.
 *
 * Idempotent by verb, which is why the route carries no idempotency key: a repeated
 * PUT returns the same state instead of counting twice.
 */
export async function setProductEngagement(
  viewerUserId: string,
  productId: string,
  engagementKind: ProductEngagementKind,
  options: EngagementRequestContext = {},
): Promise<ProductEngagementProjection> {
  const occurredAt = options.occurredAt ?? new Date();

  await db.transaction(async (transaction) => {
    await ensureCommerceProductStatsRow(transaction, productId);

    const inserted = await transaction
      .insert(commerceProductEngagement)
      .values({
        productId: productId,
        userId: viewerUserId,
        engagementKind,
        subnetHash: options.subnetHash ?? null,
        createdAt: occurredAt,
      })
      .onConflictDoNothing()
      .returning();

    if (inserted.length === 0) return;

    await transaction
      .update(commerceProductStats)
      .set({
        ...buildEngagementCounterDelta(engagementKind, "increment"),
        lastEngagementAt: occurredAt,
      })
      .where(eq(commerceProductStats.productId, productId));
  });

  return loadSingleProductEngagement(productId, viewerUserId);
}

/** Undo a save or bookmark (Appendix A11). Idempotent: clearing twice is not an error. */
export async function clearProductEngagement(
  viewerUserId: string,
  productId: string,
  engagementKind: ProductEngagementKind,
): Promise<ProductEngagementProjection> {
  await db.transaction(async (transaction) => {
    await ensureCommerceProductStatsRow(transaction, productId);

    const removed = await transaction
      .delete(commerceProductEngagement)
      .where(
        and(
          eq(commerceProductEngagement.productId, productId),
          eq(commerceProductEngagement.userId, viewerUserId),
          eq(commerceProductEngagement.engagementKind, engagementKind),
        ),
      )
      .returning();

    if (removed.length === 0) return;

    await transaction
      .update(commerceProductStats)
      .set(buildEngagementCounterDelta(engagementKind, "decrement"))
      .where(eq(commerceProductStats.productId, productId));
  });

  return loadSingleProductEngagement(productId, viewerUserId);
}

/**
 * Record a share (Appendix A11, hardened in STORE Phase 13).
 *
 * WHAT CHANGED AND WHY. Until Phase 13 every call inserted a row and incremented
 * `shareCount` — including an anonymous one, repeatedly, braked only by a
 * 60-per-15-minutes limiter. That was harmless exactly as long as nothing read the
 * counter. Phase 13 makes the ranking engine read it, so an anonymous stranger would have
 * been able to push a ranking input for free.
 *
 * The video domain settled this long ago in the opposite direction: `recordVideoShare`
 * moves its counter only for a signed-in sharer, specifically so an anonymous caller
 * cannot push a ranking input. Commerce now inherits the rule, plus a per-user-per-day
 * bucket — the shape this table's own schema comment already prescribed.
 *
 * ANONYMOUS ROWS ARE STILL WRITTEN. A share by a signed-out visitor is a real event and
 * dropping it would destroy evidence an operator may want; it simply never sets `counted`
 * and never moves the counter.
 *
 * The counter moves only when a row actually appeared — `onConflictDoNothing().returning()`
 * and a length check, the same no-double-count shape `setProductEngagement` uses. A second
 * share of one product by one user on one day is therefore a no-op rather than an error.
 */
export async function recordProductShare(
  viewerUserId: string | null,
  productId: string,
  options: EngagementRequestContext = {},
): Promise<ProductEngagementProjection> {
  const occurredAt = options.occurredAt ?? new Date();
  const shareDayBucket = utcDayStringOf(occurredAt);
  const isCountable = viewerUserId !== null;

  await db.transaction(async (transaction) => {
    await ensureCommerceProductStatsRow(transaction, productId);

    const inserted = await transaction
      .insert(commerceProductShare)
      .values({
        productId,
        userId: viewerUserId,
        shareDayBucket,
        subnetHash: options.subnetHash ?? null,
        counted: isCountable,
        createdAt: occurredAt,
      })
      .onConflictDoNothing()
      .returning({ id: commerceProductShare.id });

    if (inserted.length === 0) return;

    // An anonymous row exists but never counts, so nothing downstream moves for it —
    // including `lastEngagementAt`, which feeds staleness reads.
    if (!isCountable) return;

    await transaction
      .update(commerceProductStats)
      .set({
        shareCount: sql`${commerceProductStats.shareCount} + 1`,
        lastEngagementAt: occurredAt,
      })
      .where(eq(commerceProductStats.productId, productId));
  });

  return loadSingleProductEngagement(productId, viewerUserId);
}

async function loadSingleProductEngagement(
  productId: string,
  viewerUserId: string | null,
): Promise<ProductEngagementProjection> {
  const engagements = await loadProductEngagements([productId], viewerUserId);
  return engagements.get(productId) ?? EMPTY_PRODUCT_ENGAGEMENT;
}

/**
 * Loads counters and per-viewer state for a set of products (Appendix A11).
 *
 * Two queries regardless of how many ids are passed — one for the stats rows, one for
 * the viewer's own engagement rows — so this is safe to call from a list projection
 * as well as the detail page.
 */
export async function loadProductEngagements(
  productIds: readonly string[],
  viewerUserId: string | null,
): Promise<ReadonlyMap<string, ProductEngagementProjection>> {
  const engagements = new Map<string, ProductEngagementProjection>();
  if (productIds.length === 0) return engagements;

  const [statsRows, viewerRows] = await Promise.all([
    db
      .select()
      .from(commerceProductStats)
      .where(inArray(commerceProductStats.productId, [...productIds])),
    viewerUserId === null
      ? Promise.resolve([])
      : db
          .select({
            productId: commerceProductEngagement.productId,
            engagementKind: commerceProductEngagement.engagementKind,
          })
          .from(commerceProductEngagement)
          .where(
            and(
              inArray(commerceProductEngagement.productId, [...productIds]),
              eq(commerceProductEngagement.userId, viewerUserId),
            ),
          ),
  ]);

  const viewerStateByProduct = new Map<string, { hasSaved: boolean; hasBookmarked: boolean }>();
  for (const row of viewerRows) {
    const current = viewerStateByProduct.get(row.productId) ?? {
      hasSaved: false,
      hasBookmarked: false,
    };
    if (row.engagementKind === "saved") current.hasSaved = true;
    if (row.engagementKind === "bookmarked") current.hasBookmarked = true;
    viewerStateByProduct.set(row.productId, current);
  }

  const statsByProduct = new Map(statsRows.map((row) => [row.productId, row]));

  for (const productId of productIds) {
    const stats = statsByProduct.get(productId);
    engagements.set(productId, {
      savedCount: stats?.savedCount ?? 0,
      bookmarkedCount: stats?.bookmarkedCount ?? 0,
      shareCount: stats?.shareCount ?? 0,
      questionCount: stats?.questionCount ?? 0,
      answeredQuestionCount: stats?.answeredQuestionCount ?? 0,
      viewCount: stats?.viewCount ?? 0,
      uniqueViewerCount: stats?.uniqueViewerCount ?? null,
      viewer:
        viewerUserId === null
          ? null
          : (viewerStateByProduct.get(productId) ?? { hasSaved: false, hasBookmarked: false }),
    });
  }
  return engagements;
}

/**
 * One page of the caller's own saved / bookmarked product IDS.
 *
 * IT RETURNS IDS, NOT CARDS, and that is this module's standing rule rather than a shortcut: the
 * header above explains that importing `store-catalog.service` here would close an import cycle,
 * because the catalog already imports `loadProductEngagements` to put counters on a product page.
 * The controller depends on both and is where an id becomes a card.
 *
 * WHY THE READ EXISTS AT ALL (A11). The toggles have shipped since Phase 13 and nothing ever listed
 * what they produced — a buyer could save two hundred products and had no route that would tell
 * them which. The counters were readable per-product; the set was not readable at all.
 *
 * USER-SCOPED, matching the writes. An organization-keyed list would put a single tap behind staff
 * verification and let any `viewer`-role colleague empty the team's list; A11 records that the
 * shared sourcing shortlist is a different, named, permissioned object and is NOT this.
 *
 * `kind` ABSENT MEANS BOTH KINDS, not a default to one. Save and bookmark are independent toggles
 * with independent counters, and a caller who asks for neither is asking for everything they have
 * marked. A product marked BOTH ways appears once — `selectDistinct` over the id, because the
 * caller wants a list of products, not a list of engagements.
 *
 * ORDERED `(createdAt DESC, productId ASC)` — most recently marked first, which is the only order a
 * list like this is ever read in. `productId` breaks the tie so the keyset cannot drop a row when
 * two saves share a millisecond.
 */
export async function listSavedProductIds(input: {
  readonly userId: string;
  readonly kind?: ProductEngagementKind;
  readonly limit: number;
  readonly cursor?: string;
}): Promise<
  Result<
    {
      readonly productIds: readonly string[];
      readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
    },
    { type: "INVALID_CURSOR" }
  >
> {
  const decodedCursor =
    input.cursor === undefined ? null : decodeTimestampStoreCursor(input.cursor);
  if (input.cursor !== undefined && decodedCursor === null) {
    return { success: false, error: { type: "INVALID_CURSOR" } };
  }

  const filters: SQL[] = [eq(commerceProductEngagement.userId, input.userId)];
  if (input.kind !== undefined) {
    filters.push(eq(commerceProductEngagement.engagementKind, input.kind));
  }
  if (decodedCursor !== null) {
    const keyset = or(
      lt(commerceProductEngagement.createdAt, decodedCursor.sortKey),
      and(
        eq(commerceProductEngagement.createdAt, decodedCursor.sortKey),
        gt(commerceProductEngagement.productId, decodedCursor.id),
      ),
    );
    if (keyset) filters.push(keyset);
  }

  const rows = await db
    .select({
      productId: commerceProductEngagement.productId,
      createdAt: commerceProductEngagement.createdAt,
    })
    .from(commerceProductEngagement)
    .where(and(...filters))
    .orderBy(desc(commerceProductEngagement.createdAt), asc(commerceProductEngagement.productId))
    .limit(input.limit + 1);

  const pageRows = rows.slice(0, input.limit);
  const lastRow = pageRows[pageRows.length - 1];
  const hasMore = rows.length > input.limit;
  const nextCursor =
    hasMore && lastRow
      ? encodeStoreCursor({ sortKey: lastRow.createdAt.toISOString(), id: lastRow.productId })
      : null;

  /**
   * DEDUPED AFTER THE PAGE, not with `selectDistinct`, and the difference matters.
   *
   * A product marked both ways is two rows with two different `createdAt`s, so a distinct over the
   * id alone cannot be expressed alongside this keyset — Postgres requires the ORDER BY terms in
   * the select list. Deduping the page instead can make a page shorter than `limit`, which is
   * already true of this endpoint for a different reason: `resolveEligibleProductCardsByIds` drops
   * any product that is no longer eligible. `hasMore` and the cursor stay honest either way, which
   * is what a keyset caller actually depends on.
   */
  const seen = new Set<string>();
  const productIds = pageRows.flatMap((row) =>
    seen.has(row.productId) ? [] : (seen.add(row.productId), [row.productId]),
  );

  return { success: true, value: { productIds, page: { nextCursor, hasMore } } };
}
