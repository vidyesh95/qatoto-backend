import { sql } from "drizzle-orm";

/**
 * The scheduling-window predicate every merchandising table shares: hero slides,
 * rails, rail placements, pathways, pathway items and pathway slots.
 *
 * It lives in `lib` rather than in one of the services because both
 * `store-merchandising.service` (hero/rails/home) and `store-pathways.service` (sets)
 * need it, and having either import the other would make the pair circular.
 *
 * An absent bound is open: no `startsAt` means "already started", no `endsAt` means
 * "never ends". `endsAt` is exclusive, matching the CHECK constraints.
 */
export function merchandisingWindowOpen(table: {
  readonly startsAt: unknown;
  readonly endsAt: unknown;
}) {
  return sql`(
    (${table.startsAt} IS NULL OR ${table.startsAt} <= now())
    AND (${table.endsAt} IS NULL OR ${table.endsAt} > now())
  )`;
}
