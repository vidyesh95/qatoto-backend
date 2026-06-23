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
      const parsedUrl = new URL(process.env.DATABASE_URL!);
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
});
