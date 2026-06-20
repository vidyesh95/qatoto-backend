import { readFileSync } from "node:fs";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { config } from "#src/config/index.js";
import * as schema from "#src/db/schema.js";

const ssl = config.DATABASE_CA_CERT_PATH
  ? {
      rejectUnauthorized: true,
      ca: readFileSync(config.DATABASE_CA_CERT_PATH).toString(),
    }
  : undefined;

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  ssl,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

export const db = drizzle(pool, { schema });

pool.on("error", (err) => {
  console.error("Unexpected error on idle database client", err);
  process.exit(1);
});

/**
 * Helper to run a single query against the pool.
 */
export async function query(text: string, params?: unknown[]) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;

  if (config.NODE_ENV === "development") {
    console.log("Executed query", { text, duration, rows: result.rowCount });
  }

  return result;
}
