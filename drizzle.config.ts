import { readFileSync } from "node:fs";

import "dotenv/config";
import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");

const caCertPath = process.env.DATABASE_CA_CERT_PATH;

// drizzle-kit's pg connector ignores the `ssl` config whenever `url` is present
// (it builds `new Pool({ connectionString })` and drops `ssl`). When we supply a
// CA we therefore pass discrete connection fields instead of a URL, which makes
// drizzle-kit take the `{ ...credentials, ssl }` branch and honor our CA.
const databaseCredentials = caCertPath
  ? (() => {
      const parsedUrl = new URL(process.env.DATABASE_URL);
      return {
        host: parsedUrl.hostname,
        port: parsedUrl.port ? Number(parsedUrl.port) : 5432,
        user: decodeURIComponent(parsedUrl.username),
        password: decodeURIComponent(parsedUrl.password),
        database: parsedUrl.pathname.replace(/^\//, ""),
        ssl: { rejectUnauthorized: true, ca: readFileSync(caCertPath).toString() },
      };
    })()
  : { url: process.env.DATABASE_URL };

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: databaseCredentials,
  // Drizzle owns `public` and NOTHING else. pg-boss creates and migrates its own
  // `pgboss` schema (src/lib/jobs.ts), and its tables are deliberately absent from
  // src/db/schema.ts — declaring them would put them in the snapshot, and the next
  // pg-boss version bump (which changes its own DDL) would generate a destructive diff
  // against a schema drizzle should never have known about.
  //
  // NOTE: this only affects `push` and `pull`. `generate` composes from the snapshot
  // without connecting, and `migrate` just applies the SQL files — neither can see
  // pgboss. That is why today's workflow is safe, and why `drizzle-kit push` MUST NEVER
  // be added as a script: it introspects the live catalog and has open bugs emitting
  // DROP SCHEMA for non-public schemas EVEN WITH this filter set.
  schemaFilter: ["public"],
});
