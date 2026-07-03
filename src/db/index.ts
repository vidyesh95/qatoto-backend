import { readFileSync } from "node:fs";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type QueryResult, type QueryResultRow } from "pg";

import { config } from "#src/config/index.js";
import * as schema from "#src/db/schema.js";

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

export const pool = new Pool({
  connectionString,
  ssl,
  max: 20,
  // Recycle idle connections before the Aiven server reaps them out from under
  // us. A reaped idle socket surfaces later as a "read ETIMEDOUT" / "Connection
  // terminated unexpectedly" on the next checkout, so keep idle time short.
  idleTimeoutMillis: 10000,
  // Cross-region TLS handshake to Aiven can exceed 5s under load.
  connectionTimeoutMillis: 10000,
  // Send TCP keepalives so dead connections are detected and dropped early
  // instead of failing on first reuse.
  keepAlive: true,
});

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
