import { existsSync, readFileSync } from "node:fs";

import "dotenv/config";
import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");

const caCertPath = process.env.DATABASE_CA_CERT_PATH;

if (caCertPath && !existsSync(caCertPath)) {
  throw new Error(
    `DATABASE_CA_CERT_PATH=${caCertPath} is not a file. ` +
      "Paste the Aiven CA PEM into DATABASE_CA_CERT, or mount the cert at that path.",
  );
}

function postgresMigrateCredentials(databaseUrl: string, caCertificatePath: string | undefined) {
  const urlRequestsTls = /[?&]sslmode=/i.test(databaseUrl);
  if (!caCertificatePath && !urlRequestsTls) {
    return { url: databaseUrl };
  }

  // drizzle-kit's pg connector ignores `ssl` whenever `url` is present, so TLS
  // settings have to be discrete fields. Without a CA, encrypt but do not verify
  // — Aiven's cert is not in the public trust store (SELF_SIGNED_CERT_IN_CHAIN).
  const parsedUrl = new URL(databaseUrl);
  return {
    host: parsedUrl.hostname,
    port: parsedUrl.port ? Number(parsedUrl.port) : 5432,
    user: decodeURIComponent(parsedUrl.username),
    password: decodeURIComponent(parsedUrl.password),
    database: parsedUrl.pathname.replace(/^\//, ""),
    ssl: caCertificatePath
      ? { rejectUnauthorized: true, ca: readFileSync(caCertificatePath).toString() }
      : { rejectUnauthorized: false },
  };
}

const databaseCredentials = postgresMigrateCredentials(process.env.DATABASE_URL, caCertPath);

const schemaPath = "./src/db/schema.ts";

export default defineConfig({
  dialect: "postgresql",
  // The production image ships SQL under `out/` and does not copy `src/`. `migrate`
  // only reads those SQL files; `schema` is for generate/push on a developer machine.
  ...(existsSync(schemaPath) ? { schema: schemaPath } : {}),
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
