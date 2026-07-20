import { z } from "zod";

/**
 * Parses a comma-separated env var into a trimmed, empty-filtered list.
 * Absent or blank yields `[]`.
 *
 * Every native-client setting below is optional on purpose: a dev machine has no
 * Android app and no iOS bundle, and must still boot and serve web auth unchanged.
 * Spreading `[]` into an options array is a provable no-op.
 */
const commaSeparatedList = z
  .string()
  .optional()
  .transform((rawValue) =>
    (rawValue ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );

const envSchema = z.object({
  PORT: z.coerce.number().default(8000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATABASE_URL: z.url(),
  DATABASE_CA_CERT_PATH: z.string().optional(),
  BETTER_AUTH_SECRET: z.string().min(16),
  BETTER_AUTH_URL: z.url(),
  FRONTEND_URL: z.url(),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: z.string().min(1),
  BREVO_API_KEY: z.string().min(1).optional(),
  BREVO_SENDER_EMAIL: z.email().optional(),
  BREVO_SENDER_NAME: z.string().min(1).default("Qatoto"),
  // Cloudinary credentials for avatar uploads. Optional like Brevo: absent in
  // dev means the photo endpoints return NOT_CONFIGURED instead of crashing boot.
  CLOUDINARY_CLOUD_NAME: z.string().min(1).optional(),
  CLOUDINARY_API_KEY: z.string().min(1).optional(),
  CLOUDINARY_API_SECRET: z.string().min(1).optional(),
  // Extra WebAuthn ceremony origins accepted ALONGSIDE the FRONTEND_URL origin
  // (R_AND_D_BACKEND_STRUCTURE.md §4a). Android sends
  // "android:apk-key-hash:<base64url sha256 of the release signing cert>"; iOS sends
  // the https origin of its associated domain. The web origin is added in CODE and
  // must never be listed here. No trailing slash: SimpleWebAuthn compares
  // expectedOrigin by exact string, so "https://x.com/" never matches "https://x.com".
  PASSKEY_NATIVE_ORIGINS: commaSeparatedList.pipe(
    z.array(
      z
        .string()
        .regex(
          /^(android:apk-key-hash:[A-Za-z0-9_-]+|https:\/\/[^/\s]+)$/,
          "Must be android:apk-key-hash:<hash> or an https origin with no trailing slash",
        ),
    ),
  ),
  // Native deep-link schemes appended to Better Auth's trustedOrigins (§4a). Better
  // Auth compares http/https entries by EXACT origin and everything else by PREFIX,
  // so each value must END with "://" — registering "qatoto" matches nothing, while
  // "qatoto://" matches "qatoto://auth-callback".
  NATIVE_DEEP_LINK_SCHEMES: commaSeparatedList.pipe(
    z.array(
      z
        .string()
        .regex(
          /^[a-z][a-z0-9+.-]*:\/\/$/,
          'Must be a lowercase URI scheme ending in "://", e.g. "qatoto://"',
        ),
    ),
  ),
});

export const config = envSchema.parse(process.env);
export type Config = z.infer<typeof envSchema>;

// Every table in src/db/schema.ts uses plain `timestamp` (not `timestamptz`), which
// node-postgres parses in the SERVER PROCESS's local zone. The schema therefore
// already depends silently on the process running in UTC — this assertion makes that
// dependency explicit and loud instead of producing timestamps that are wrong by the
// host's offset. Production only: a developer's laptop is not in UTC and must boot.
if (config.NODE_ENV === "production" && process.env.TZ !== "UTC") {
  throw new Error(
    `TZ must be "UTC" in production (received ${process.env.TZ ?? "unset"}): ` +
      "`timestamp` columns are parsed in the server's local zone.",
  );
}
