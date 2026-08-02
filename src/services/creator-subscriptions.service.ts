import { and, eq, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { creatorStats, creatorSubscription, user } from "#src/db/schema.js";
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
  | { readonly type: "SELF_SUBSCRIPTION_FORBIDDEN"; readonly creatorId: string };

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
