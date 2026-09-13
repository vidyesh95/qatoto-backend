import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * The two SQL expressions every denormalised counter on the home surface moves by.
 *
 * WHY THESE ARE SQL RATHER THAN JAVASCRIPT. `column + 1` computed in TypeScript means reading the
 * value, adding to it, and writing it back — three steps with a gap between them that a second
 * writer fits into exactly. Two people liking the same video in the same millisecond both read 7,
 * both write 8, and one like is gone. As SQL the arithmetic happens inside the UPDATE, where the
 * row is already locked, so the same pair yields 9.
 *
 * WHY `decrement` FLOORS AT ZERO. A counter is a read cache, not a ledger: it can already be out of
 * step with its source rows after an erasure, which deletes rows in raw SQL with no counter update.
 * `GREATEST(col - 1, 0)` means a repeated delete — a double-tapped unlike, a retried request — is
 * idempotent rather than a slide into negative numbers that every read then has to defend against.
 * The `_nonnegative_ck` on each stats table is the backstop; this is the thing that stops it firing.
 *
 * ⚠️ NEITHER OF THESE IS A SUBSTITUTE FOR MOVING THE COUNTER IN THE SAME TRANSACTION AS THE ROW
 * THAT CAUSED IT. `video-engagement.service.ts` states that discipline and the reason for it: a
 * like that commits without its counter is a like that disappears from the UI until a reconciler
 * runs, and that reconciler is the job we are trying not to need.
 *
 * PROMOTED OUT OF `video-engagement.service.ts`, WHERE IT HAD ALREADY BEEN COPIED ONCE into
 * `video-comments.service.ts` with a narrower column type. The blueprint engagement path would have
 * been the third copy; the second was already one too many.
 */

/** `+ n`, as SQL, so two concurrent writers cannot read-modify-write over each other. */
export function increment(column: AnyPgColumn, amount = 1): ReturnType<typeof sql> {
  return sql`${column} + ${amount}`;
}

/** Floors at zero, so a repeated delete cannot drive a counter negative. */
export function decrement(column: AnyPgColumn): ReturnType<typeof sql> {
  return sql`GREATEST(${column} - 1, 0)`;
}
