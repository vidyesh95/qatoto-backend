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
 * This is the write-side twin of the read-side hazard `utcDateFromRow` below handles. It is
 * NOT handled by the parser in `src/db/index.ts` — see that function's comment for why.
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

/**
 * Converts a timestamp column read through `db.execute` into a real `Date`.
 *
 * ## ⚠️ WHY THIS EXISTS — `db.execute<T>` is a CLAIM, not a parse instruction
 *
 * `db.execute<{ published_at: Date }>` does not convert anything. The row is whatever
 * node-pg produced, and for temporal columns under drizzle that is a bare STRING:
 * `drizzle-orm/node-postgres/session.js` overrides `getTypeParser` on every prepared query
 * and returns `(val) => val` for TIMESTAMP, TIMESTAMPTZ, DATE and INTERVAL. Drizzle's typed
 * select layer recovers from that with the column's own codec — `PgTimestamp.mapFromDriver`
 * appends `'+0000'` and builds the Date. A raw `db.execute` has no column to map to, so
 * nothing recovers and the string is handed on under a `Date` annotation nobody checked.
 *
 * Observed: `GET /feed/videos` served `publishedAt: '2026-08-02 17:36:54.105'` while
 * `GET /feed/watch/:id` served `'2026-08-02T17:36:54.105Z'` for the SAME column, because the
 * first goes through `db.execute` and the second through the query builder. With no `T` and
 * no zone, `Date.parse` reads it as LOCAL time, so every "posted X ago" on the homepage was
 * off by the viewer's UTC offset, and `<time dateTime="2026-08-02 17:36:54.105">` is not a
 * valid `datetime` attribute either.
 *
 * PREFER THE QUERY BUILDER when the choice exists — `latestSnapshotAsOf` in
 * `src/services/feed.service.ts` documents that call. This function is for the raw queries
 * that cannot be expressed that way.
 *
 * Accepting `Date` as well as `string` is deliberate: if drizzle ever stops overriding the
 * parser, this becomes a no-op instead of a crash.
 */
export function utcDateFromRow(value: string | Date | null): Date | null {
  if (value === null) return null;
  if (value instanceof Date) return value;
  // Postgres text form: `YYYY-MM-DD HH:MM:SS[.mmm]`, no zone. The schema stores UTC.
  return new Date(`${value.replace(" ", "T")}Z`);
}
