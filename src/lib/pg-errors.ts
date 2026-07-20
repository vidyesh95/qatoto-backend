/**
 * Postgres SQLSTATE detection, in one place.
 *
 * WHY THIS EXISTS. drizzle-orm 0.45 wraps every driver failure in a
 * `DrizzleQueryError` and hangs the original `pg` error off `.cause`. So the SQLSTATE
 * is at `error.cause.code`, NOT at `error.code`:
 *
 *   ctor=DrizzleQueryError  topLevelCode=undefined  causeCode=23505
 *
 * A check that reads only the top level silently returns false for EVERY constraint
 * violation, which turns an expected domain outcome (409 SKU_TAKEN, 409 TAKEN,
 * a slug-collision retry) into an unhandled re-throw and a 500. The failure mode is
 * quiet: the happy path is unaffected and only the race loses.
 *
 * These helpers walk the cause chain, so they work whether the driver error arrives
 * wrapped or bare — which also keeps them correct if a future drizzle version stops
 * wrapping.
 */

/** Unique constraint or exclusion violation. */
export const PG_UNIQUE_VIOLATION = "23505";
/** CHECK constraint violation. Always a programmer error in this codebase — see below. */
export const PG_CHECK_VIOLATION = "23514";
/** Foreign key violation, e.g. an onDelete: "restrict" parent that still has children. */
export const PG_FOREIGN_KEY_VIOLATION = "23503";

/** Custom SQLSTATE raised by the append-only triggers in migration 0010 (§4f). */
export const QATOTO_APPEND_ONLY_VIOLATION = "QT001";

/**
 * Reads a Postgres SQLSTATE out of an error, unwrapping drizzle's wrapper.
 * Returns undefined when the error did not come from the driver.
 */
export function readSqlStateCode(error: unknown): string | undefined {
  let current: unknown = error;

  // Bounded rather than `while (true)`: a malformed cause cycle must not hang a
  // request thread.
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    const candidate: { readonly code?: unknown; readonly cause?: unknown } = current;
    if (typeof candidate.code === "string") {
      return candidate.code;
    }
    current = candidate.cause;
  }

  return undefined;
}

/**
 * A unique-constraint violation — the race-safe authority for every uniqueness rule in
 * this codebase. Let the INSERT try, then translate this ONE code into a domain
 * `Result` (an expected operational failure). Every other error re-throws
 * (CLAUDE.md §3.3).
 */
export function isUniqueViolation(error: unknown): boolean {
  return readSqlStateCode(error) === PG_UNIQUE_VIOLATION;
}

/**
 * A foreign-key violation. Under the §4f cascade policy this usually means a
 * `restrict` parent still has children — e.g. deleting a user who has founded a
 * project. That is the policy WORKING, so callers translate it into a domain error
 * rather than a 500.
 */
export function isForeignKeyViolation(error: unknown): boolean {
  return readSqlStateCode(error) === PG_FOREIGN_KEY_VIOLATION;
}

/**
 * Deliberately NO `isCheckViolation` helper, and this comment is the reason.
 *
 * Every CHECK in migration 0010 is defense-in-depth: each invariant ALSO has a Zod
 * refine or a service pre-check, and the one genuine race (slots_filled_count vs
 * slots_total) is closed by row locking in the accept transaction. So a 23514 that
 * actually reaches the application is a BUG, and CLAUDE.md §3.3 says a bug must throw
 * rather than become a `Result`. Adding a helper here would invite exactly the
 * opposite — treating an invariant violation as a routine domain outcome, which is how
 * a constraint stops being a constraint. The same reasoning covers QT001.
 */
