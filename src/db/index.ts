import { readFileSync } from "node:fs";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, types as pgTypes, type QueryResult, type QueryResultRow } from "pg";

import { config } from "#src/config/index.js";
import * as schema from "#src/db/schema.js";

/**
 * Parse `timestamp without time zone` as UTC, not as the process's local zone.
 *
 * THE BUG THIS FIXES. Every one of the 84 `timestamp(...)` columns in schema.ts is
 * `without time zone`, and node-postgres's default parser for that type (OID 1114) builds
 * a Date using the SERVER PROCESS's local zone. So a row written as UTC midnight reads
 * back as midnight-in-whatever-zone-the-host-is-in — on a UTC+5:30 machine, that is
 * 18:30 the previous day. The value silently changes meaning on its way out of the
 * database, and nothing errors.
 *
 * src/config/index.ts already asserts `TZ === "UTC"` in production, which acknowledged
 * this dependency but only covered one environment: every developer machine and every CI
 * runner outside UTC was reading offset timestamps the whole time.
 *
 * §6 makes it acute rather than merely untidy. Job `asOf` values are PERSISTED and later
 * compared for byte-identity (§4c rule 3), and `wholeDaysBetweenUtcDayStarts` throws on
 * an instant that is not exactly on a UTC day boundary — so a round-tripped asOf would
 * either throw or, worse, quietly re-bucket a cluster's recency score.
 *
 * Postgres hands us a bare `YYYY-MM-DD HH:MM:SS[.ffffff]` string with no offset. Appending
 * "Z" states the convention the schema already assumes: these columns hold UTC.
 *
 * ## ⚠️ THIS DOES NOT REACH DRIZZLE QUERIES — do not rely on it
 *
 * The comment above described this as global. It is not.
 * `drizzle-orm/node-postgres/session.js` builds every prepared query with its own
 * `types.getTypeParser`, which returns `(val) => val` for TIMESTAMP, TIMESTAMPTZ, DATE and
 * INTERVAL. That override wins, so the parser registered here is never consulted by `db`.
 *
 * Nothing was broken by that for the query BUILDER: drizzle re-parses with the column's own
 * codec (`PgTimestamp.mapFromDriver` appends `'+0000'`), which is the same UTC convention.
 * The gap is `db.execute`, which has no column to map to — its rows carry raw strings under
 * whatever `Date` annotation the call site claimed. Those must be converted explicitly with
 * `utcDateFromRow` from `src/lib/sql-time.ts`; see that function for the bug it fixes.
 *
 * This registration is KEPT because it still covers a raw `pg` client that bypasses drizzle
 * — `query()` at the bottom of this file goes straight to `pool.query`.
 */
pgTypes.setTypeParser(pgTypes.builtins.TIMESTAMP, (rawValue: string) =>
  rawValue === null ? null : new Date(`${rawValue.replace(" ", "T")}Z`),
);

const ssl = config.DATABASE_CA_CERT_PATH
  ? {
      rejectUnauthorized: true,
      ca: readFileSync(config.DATABASE_CA_CERT_PATH).toString(),
    }
  : undefined;

// When we supply our own CA, drop any `sslmode` from the connection string.
// pg-connection-string treats `sslmode=require` as `verify-full` and builds its
// own ssl config that overrides our `ssl` object, breaking CA verification with
// SELF_SIGNED_CERT_IN_CHAIN. Our explicit `ssl` is the single source of truth.
const connectionString = ssl
  ? config.DATABASE_URL.replace(/([?&])sslmode=[^&]*&?/, "$1").replace(/[?&]$/, "")
  : config.DATABASE_URL;

/**
 * Shared pool tuning.
 *
 * CONNECTION BUDGET IS A HARD, SHARED RESOURCE. The managed instance this connects to
 * reports `max_connections = 20` for the WHOLE SERVER — not per client — and a handful are
 * always taken by other sessions. Every process that connects draws from that same
 * twenty: the API, each worker, every `pnpm db:*` script, and any open psql.
 *
 * `DATABASE_POOL_MAX` therefore defaults deliberately low. Over-provisioning here does not
 * buy throughput; it converts a queue-inside-the-pool (harmless, invisible) into
 * `FATAL: sorry, too many clients already` (SQLSTATE 53300) in whichever process happens
 * to ask last — which is how a background worker takes down the API.
 */
const POOL_TUNING = {
  ssl,
  // Recycle idle connections before the Aiven server reaps them out from under
  // us. A reaped idle socket surfaces later as a "read ETIMEDOUT" / "Connection
  // terminated unexpectedly" on the next checkout, so keep idle time short.
  idleTimeoutMillis: 10000,
  // Cross-region TLS handshake to Aiven can exceed 5s under load.
  connectionTimeoutMillis: 10000,
  // Send TCP keepalives so dead connections are detected and dropped early
  // instead of failing on first reuse.
  keepAlive: true,
} as const;

export const pool = new Pool({
  connectionString,
  ...POOL_TUNING,
  max: config.DATABASE_POOL_MAX,
});

/**
 * Builds a SEPARATE pool for a process that must not compete with the API's.
 *
 * The worker needs its own: pg-boss polls every queue on an interval, so its connection
 * demand is steady and concurrent rather than request-shaped, and sharing the API's pool
 * makes a slow scoring job starve HTTP handlers. The caller owns the returned pool and
 * must `end()` it.
 */
export function createDedicatedPool(maxConnections: number): Pool {
  return new Pool({ connectionString, ...POOL_TUNING, max: maxConnections });
}

export const db = drizzle(pool, { schema });

// Idle clients dropped by the remote server (Aiven idle reaping, network NAT
// timeouts) emit 'error' here. The pool has already discarded the broken
// client, so this is a recoverable event — log it, never exit the process.
pool.on("error", (err) => {
  console.error("Unexpected error on idle database client", err);
});

/**
 * Helper to run a single query against the pool.
 */
export async function query<Row extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<Row>> {
  const start = Date.now();
  const result = await pool.query<Row>(text, params);
  const duration = Date.now() - start;

  if (config.NODE_ENV === "development") {
    console.log("Executed query", { text, duration, rows: result.rowCount });
  }

  return result;
}
