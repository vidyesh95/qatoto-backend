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

/**
 * Aiven (and the same class of managed Postgres) puts `sslmode=require` on the
 * URL. pg-connection-string treats that as verify-full, and Aiven's cert is not
 * in the public trust store, so a missing CA dies with SELF_SIGNED_CERT_IN_CHAIN.
 *
 * With a CA we verify. Without one we still encrypt, but we do not verify the
 * server — that is what lets Dokploy boot when DATABASE_CA_CERT_PATH is unset.
 */
function postgresPoolSslOption():
  | { readonly rejectUnauthorized: true; readonly ca: string }
  | { readonly rejectUnauthorized: false }
  | undefined {
  if (config.DATABASE_CA_CERT_PATH) {
    return {
      rejectUnauthorized: true,
      ca: readFileSync(config.DATABASE_CA_CERT_PATH).toString(),
    };
  }
  if (/[?&]sslmode=/i.test(config.DATABASE_URL)) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

function stripSslModeQueryParameter(databaseUrl: string): string {
  return databaseUrl.replace(/([?&])sslmode=[^&]*&?/, "$1").replace(/[?&]$/, "");
}

const ssl = postgresPoolSslOption();
const connectionString = ssl
  ? stripSslModeQueryParameter(config.DATABASE_URL)
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
 *
 * ## ⚠️ THE WORKER'S SHARE IS THE SUM OF BOTH POOLS, NOT `WORKER_DATABASE_POOL_MAX`
 *
 * This is the one number that is easy to get wrong when budgeting. `src/worker.ts` creates a
 * dedicated pool for pg-boss's pollers AND imports `db`, whose handlers draw from the SHARED
 * `pool` below — so a worker process can hold `DATABASE_POOL_MAX + WORKER_DATABASE_POOL_MAX`
 * connections, not the latter alone. `src/worker.ts:768-769` is the only other place that
 * says so, at shutdown, where it must end both.
 *
 * A `pnpm db:*` script inherits the shared pool too, so its ceiling is `DATABASE_POOL_MAX`.
 *
 * ⚠️ These are CEILINGS, not reservations — `pg.Pool` connects on demand, so a sequential
 * seed script holds exactly one. The exposure is concurrency spikes, which is why lowering
 * the ceilings costs no throughput.
 *
 * `logConnectionBudget()` at the bottom of this file MEASURES the server's side of this
 * rather than trusting the paragraph above, and every runtime process calls it at boot.
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

/**
 * Fraction of the server's connections one process may claim before this warns.
 *
 * Not a hard limit — nothing enforces it, because the only honest enforcement is refusing to
 * boot, and a service that will not start is worse than one that is over-provisioned. The
 * number comes from the budget this repo actually runs: API + worker + one `db:*` script + a
 * reserve for the provider's own management sessions, psql and drizzle-kit, means no single
 * process should be reaching for half the server on its own.
 */
const SAFE_PROCESS_SHARE_PERCENT = 40;

/**
 * Logs this process's share of the server-wide connection budget, MEASURED.
 *
 * ## ⚠️ WHY THIS EXISTS AT ALL, WHEN FIVE COMMENTS ALREADY STATE THE NUMBER
 *
 * `max_connections = 20` is asserted in prose in five files — the docblock above,
 * `src/config/index.ts`, `src/worker.ts`, `src/middleware/rate-limit-store.ts` and
 * `src/modules/auth/privacy/data-export.service.ts` — and read from the server by NONE of
 * them. Every one of those sentences goes silently wrong the day the database moves to a
 * bigger plan, and `DATABASE_POOL_MAX` keeps its low default with nothing to say so: the
 * failure mode of a migration is not an error, it is a permanent 10x under-use nobody sees.
 *
 * One `SHOW max_connections` at boot turns the claim into an observation. It is also the
 * migration checklist in one line — the first boot against a larger server prints the gap.
 *
 * ⚠️ NEVER THROWS AND NEVER BLOCKS THE BOOT. A budget log that can prevent the API from
 * starting has inverted its own purpose, so every failure here degrades to a warning.
 */
export async function logConnectionBudget(
  processLabel: string,
  processConnectionCeiling: number,
): Promise<void> {
  try {
    const result = await pool.query<{ max_connections: string }>("SHOW max_connections");
    const serverMaxConnections = Number(result.rows[0]?.max_connections);

    if (!Number.isFinite(serverMaxConnections) || serverMaxConnections <= 0) {
      console.warn(
        `Connection budget: ${processLabel} may hold up to ${processConnectionCeiling} ` +
          `connections; the server did not report a usable max_connections.`,
      );
      return;
    }

    const sharePercent = Math.round((processConnectionCeiling / serverMaxConnections) * 100);
    const summary =
      `Connection budget: ${processLabel} may hold up to ${processConnectionCeiling} of the ` +
      `server's ${serverMaxConnections} connections (${sharePercent}%).`;

    if (sharePercent > SAFE_PROCESS_SHARE_PERCENT) {
      console.warn(
        `${summary} That leaves too little for the other processes sharing this server — ` +
          `lower DATABASE_POOL_MAX / WORKER_DATABASE_POOL_MAX, or move to a larger plan.`,
      );
      return;
    }

    console.log(summary);
  } catch (error: unknown) {
    // A failure here says nothing about whether the service can serve traffic.
    console.warn("Connection budget: could not read max_connections from the server.", error);
  }
}
