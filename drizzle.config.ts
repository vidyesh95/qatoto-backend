/// <reference types="node" />
import { readFileSync } from "node:fs";

import "dotenv/config";
import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");

const caCertPath = process.env.DATABASE_CA_CERT_PATH;

// Same handling as src/db/index.ts: when we supply a CA, strip `sslmode` from the
// URL so it doesn't override our explicit ssl config (SELF_SIGNED_CERT_IN_CHAIN).
const url = caCertPath
  ? process.env.DATABASE_URL.replace(/([?&])sslmode=[^&]*&?/, "$1").replace(/[?&]$/, "")
  : process.env.DATABASE_URL;

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url,
    ssl: caCertPath
      ? { rejectUnauthorized: true, ca: readFileSync(caCertPath).toString() }
      : undefined,
  },
});
