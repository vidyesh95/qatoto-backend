import { sql, type SQL } from "drizzle-orm";

/**
 * Binds a UTC instant into a raw `sql` template against a `timestamp` column.
 *
 * ## ⚠️ WHY THIS EXISTS — a silent, off-by-a-timezone comparison
 *
 * Inside `db.execute(sql\`… WHERE as_of < ${asOf}\`)`, a JS `Date` does NOT go through the
 * drizzle column mapper — there is no column to map to, so node-pg serialises it directly,
 * and it does so in the PROCESS's local zone. Against a `timestamp without time zone`
 * column that has been storing UTC, the two sides are then offset by whatever the server's
 * offset happens to be.
 *
 * Observed: a row stored at `2026-08-03 00:00:00` compared `< ` a Date for the same instant
 * returned TRUE on a machine at UTC+05:30, because the parameter arrived as `05:30:00`.
 * Every window boundary in every recompute was quietly widened by the local offset.
 *
 * IT IS INVISIBLE IN PRODUCTION, which is what makes it worth a module. `src/worker.ts`
 * hard-asserts `TZ=UTC`, so the offset there is zero and every query is correct. The bug
 * only appears on a developer machine — where it produces plausible, slightly wrong
 * numbers rather than an error, and where it is most likely to be dismissed as noise.
 *
 * This is the write-side twin of the read-side hazard `src/db/index.ts` already handles
 * with its UTC parser for OID 1114.
 *
 * ## Why this formulation
 *
 * `'…Z'::timestamptz` is parsed as UTC because the literal carries an explicit offset —
 * the session's `TimeZone` cannot influence it. `AT TIME ZONE 'UTC'` then converts to a
 * `timestamp` whose wall-clock reading IS the UTC instant, which is exactly what the
 * column stores. The result does not depend on the server's zone at any step.
 *
 * Drizzle's query builder (`eq(table.asOf, someDate)`) is unaffected and needs no help —
 * it knows the column and uses its mapper. Only raw `sql` templates need this.
 */
export function utcTimestamp(instant: Date): SQL {
  return sql`${instant.toISOString()}::timestamptz AT TIME ZONE 'UTC'`;
}
