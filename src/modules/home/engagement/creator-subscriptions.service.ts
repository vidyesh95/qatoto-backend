import { and, desc, eq, lt, or, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { creatorStats, creatorSubscription, user } from "#src/db/schema.js";
import { decodeInstantCursor, encodeInstantCursor } from "#src/lib/instant-cursor.js";
import type { Result } from "#src/types/index.js";

/**
 * Channel subscriptions — HOME_BACKEND_STRUCTURE.md §3.1, §5.2.
 *
 * `PUT`/`DELETE /creators/:creatorId/subscribe`, idempotent by verb: the primary key on
 * `(subscriberId, creatorId)` is the mechanism, so neither verb needs an idempotency
 * key and a double-tap is harmless.
 */

export type CreatorSubscriptionError =
  | { readonly type: "CREATOR_NOT_FOUND"; readonly creatorId: string }
  | { readonly type: "SELF_SUBSCRIPTION_FORBIDDEN"; readonly creatorId: string }
  // Payload-free, and identical to the arm `FeedPreferenceError` and `VideoEngagementError`
  // declare. TypeScript collapses matching arms, so `EngagementDomainError` still carries ONE
  // `CURSOR_MALFORMED` and its existing 422 answers this list too.
  | { readonly type: "CURSOR_MALFORMED" };

export interface SubscriptionOutcome {
  readonly isSubscribed: boolean;
  readonly subscriberCount: number;
}

export async function setCreatorSubscription(input: {
  readonly subscriberId: string;
  readonly creatorId: string;
  readonly shouldBeSubscribed: boolean;
}): Promise<Result<SubscriptionOutcome, CreatorSubscriptionError>> {
  // Checked in TypeScript before the write rather than caught as a CHECK violation.
  // The constraint stays as the backstop — it is what makes this true at rest — but a
  // 23514 climbing out of a service is an unhandled 500, not a clean 403.
  if (input.subscriberId === input.creatorId) {
    return {
      success: false,
      error: { type: "SELF_SUBSCRIPTION_FORBIDDEN", creatorId: input.creatorId },
    };
  }

  const outcome = await db.transaction(async (tx) => {
    // ANY user can be subscribed to, not just one who has published — a channel with no
    // videos yet is a real thing to follow. So this checks existence, not creator-ness.
    const [targetCreator] = await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, input.creatorId));

    if (!targetCreator) return { kind: "missing" } as const;

    // Minted here as well as at video create, because a creator with zero videos has
    // no stats row yet and the UPDATE below would otherwise affect nothing and lose
    // the count silently.
    await tx.insert(creatorStats).values({ userId: input.creatorId }).onConflictDoNothing();

    const affectedRows = input.shouldBeSubscribed
      ? await tx
          .insert(creatorSubscription)
          .values({ subscriberId: input.subscriberId, creatorId: input.creatorId })
          .onConflictDoNothing()
          .returning({ creatorId: creatorSubscription.creatorId })
      : await tx
          .delete(creatorSubscription)
          .where(
            and(
              eq(creatorSubscription.subscriberId, input.subscriberId),
              eq(creatorSubscription.creatorId, input.creatorId),
            ),
          )
          .returning({ creatorId: creatorSubscription.creatorId });

    if (affectedRows.length === 0) {
      const [stats] = await tx
        .select({ subscriberCount: creatorStats.subscriberCount })
        .from(creatorStats)
        .where(eq(creatorStats.userId, input.creatorId));
      return { kind: "settled", subscriberCount: stats?.subscriberCount ?? 0 } as const;
    }

    const [stats] = await tx
      .update(creatorStats)
      .set({
        subscriberCount: input.shouldBeSubscribed
          ? sql`${creatorStats.subscriberCount} + 1`
          : sql`GREATEST(${creatorStats.subscriberCount} - 1, 0)`,
      })
      .where(eq(creatorStats.userId, input.creatorId))
      .returning({ subscriberCount: creatorStats.subscriberCount });

    return { kind: "settled", subscriberCount: stats?.subscriberCount ?? 0 } as const;
  });

  if (outcome.kind === "missing") {
    return { success: false, error: { type: "CREATOR_NOT_FOUND", creatorId: input.creatorId } };
  }

  return {
    success: true,
    value: {
      isSubscribed: input.shouldBeSubscribed,
      subscriberCount: outcome.subscriberCount,
    },
  };
}

/**
 * One channel the caller follows, as `GET /users/me/subscriptions` returns it.
 *
 * `subscriberCount` IS THE ONLY NUMBER HERE, and it is already public — the watch payload
 * carries it on every video. Nothing else on this row is a count: a "you have watched 12 of
 * their videos" figure would be a per-pair aggregate nobody has asked for, and a "new since
 * you last looked" badge needs a last-seen clock that does not exist.
 *
 * `handle` and `imageUrl` are nullable because an account with neither is a real account —
 * the same reason `MutedCreatorRow` declares them that way.
 */
export interface SubscribedCreatorRow {
  readonly creatorId: string;
  readonly handle: string | null;
  readonly name: string;
  readonly imageUrl: string | null;
  readonly subscriberCount: number;
  readonly subscribedAt: Date;
}

/**
 * The caller's own subscriptions — `GET /users/me/subscriptions`.
 *
 * THE READ THAT WAS MISSING. `PUT /creators/:creatorId/subscribe` has been writing this table
 * since §3.1 and nothing listed it back, so the one place a subscription was visible at all was
 * the button on a video by that creator — which you have to already be watching to reach.
 *
 * PAGINATED, WHERE `listMutedCreators` IS NOT, and the asymmetry is deliberate rather than an
 * inconsistency between two functions with the same shape. That one is unpaginated on a stated
 * test — "machinery for a page that cannot exist", because muting is an act against a channel
 * and tops out in the tens. Subscribing is equally deliberate but accumulates for years and
 * routinely reaches the hundreds, so the same test rules a cursor IN. Keyset on
 * `(created_at, creator_id)`; the trailing id is what makes it total, because two subscriptions
 * seconds apart can share a millisecond and a cursor on a non-unique column skips the loser.
 *
 * NO EXISTENCE GATE ON THE CREATOR, unlike `setCreatorSubscription` directly above. That write
 * checks `user` because storing a subscription to a nonexistent id would be a row that follows
 * nothing forever. This read needs no such check: the `ON DELETE cascade` on both foreign keys
 * means a deleted account takes its subscription rows with it, so the `innerJoin` below is a
 * join for the name and image rather than a filter, and it drops nothing.
 *
 * NO PUBLISHED-VIDEO REQUIREMENT EITHER. `setCreatorSubscription` says it in as many words — a
 * channel with no videos yet is a real thing to follow — and hiding those rows here would make
 * the subscription unliftable from the one surface that lists it.
 *
 * `leftJoin(creatorStats)` + COALESCE, exactly as `video-watch.service.ts` does it: a creator
 * whose stats row has not been minted is a real creator with zero subscribers, and an
 * `innerJoin` would silently drop them out of somebody's subscription list.
 */
export async function listMySubscriptions(input: {
  readonly subscriberId: string;
  readonly limit: number;
  readonly cursor: string | null;
}): Promise<
  Result<
    { readonly rows: readonly SubscribedCreatorRow[]; readonly nextCursor: string | null },
    CreatorSubscriptionError
  >
> {
  const decodedCursor = input.cursor === null ? null : decodeInstantCursor(input.cursor);
  if (input.cursor !== null && decodedCursor === null) {
    return { success: false, error: { type: "CURSOR_MALFORMED" } };
  }

  // Newest first — the channel somebody just followed is the one they are looking for. Both
  // columns sort the same direction, or the page boundary skips rows.
  const cursorCondition =
    decodedCursor === null
      ? undefined
      : or(
          lt(creatorSubscription.createdAt, decodedCursor.instant),
          and(
            eq(creatorSubscription.createdAt, decodedCursor.instant),
            lt(creatorSubscription.creatorId, decodedCursor.id),
          ),
        );

  // The extra row is the has-next-page proof, without a COUNT over every subscription.
  const rows = await db
    .select({
      creatorId: user.id,
      handle: user.handle,
      name: user.name,
      imageUrl: user.image,
      subscriberCount: sql<number>`COALESCE(${creatorStats.subscriberCount}, 0)`,
      subscribedAt: creatorSubscription.createdAt,
    })
    .from(creatorSubscription)
    .innerJoin(user, eq(user.id, creatorSubscription.creatorId))
    .leftJoin(creatorStats, eq(creatorStats.userId, creatorSubscription.creatorId))
    .where(and(eq(creatorSubscription.subscriberId, input.subscriberId), cursorCondition))
    .orderBy(desc(creatorSubscription.createdAt), desc(creatorSubscription.creatorId))
    .limit(input.limit + 1);

  const pageRows = rows.slice(0, input.limit);
  const lastRow = pageRows.at(-1);
  const nextCursor =
    rows.length > input.limit && lastRow !== undefined
      ? encodeInstantCursor({ instant: lastRow.subscribedAt, id: lastRow.creatorId })
      : null;

  return { success: true, value: { rows: pageRows, nextCursor } };
}
