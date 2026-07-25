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
  // --- Background jobs (§4e). pg-boss owns its own Postgres schema exclusively; it is
  //     deliberately NOT declared in src/db/schema.ts, so drizzle never diffs it.
  // The API pool's ceiling. The managed instance reports max_connections = 20 FOR THE
  // WHOLE SERVER, shared across the API, every worker, and every db:* script — so this
  // defaults well below that. Raising it does not buy throughput; it converts an
  // invisible in-pool wait into `FATAL: too many clients` in whichever process asks last.
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(8),
  // The worker's own, separate pool. pg-boss polls every queue on an interval, so its
  // demand is steady and concurrent rather than request-shaped.
  WORKER_DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(4),
  JOBS_SCHEMA: z.string().min(1).default("pgboss"),
  // How many jobs one worker process runs concurrently. Kept low by default because the
  // recompute jobs run full-table scans, and the worker shares a database with the API.
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(2),
  // Runs the job workers INSIDE the API process. A single-terminal convenience for local
  // development only — it is refused in production below, because a CPU-bound scoring job
  // sharing an event loop with HTTP handlers turns every recompute into a p99 latency
  // spike on every request.
  WORKER_INLINE: z
    .string()
    .optional()
    .transform((rawValue) => rawValue === "true"),
  // --- Geocoding (§6). Problem reports carry a free-text location; the server resolves
  //     it to coordinates and a country, because §6 forbids client-claimed geography.
  //
  // Results are CACHED PERMANENTLY in `geocode_cache` and never re-fetched, which is what
  // keeps the clustering job deterministic — an external geocoder is not a pure function.
  GEOCODING_PROVIDER: z.enum(["nominatim", "none"]).default("nominatim"),
  GEOCODING_BASE_URL: z.url().default("https://nominatim.openstreetmap.org"),
  // Nominatim's usage policy REQUIRES a genuine identifying User-Agent with contact
  // details. Requests without one are blocked, so this is not optional politeness.
  GEOCODING_USER_AGENT: z.string().min(1).default("Qatoto/0.1 (backend@qatoto.com)"),
  // Nominatim permits at most 1 request/second. The worker serializes calls to honour it.
  GEOCODING_MIN_INTERVAL_MS: z.coerce.number().int().min(0).default(1_100),
  GEOCODING_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(10_000),
  // --- Studio video (STUDIO_BACKEND_STRUCTURE.md §9). The creator pastes a YouTube link
  //     and the server proves the video exists, is public and permits embedding with ONE
  //     oEmbed call before the row is written.
  //
  // No API key and no quota: oEmbed is not the YouTube Data API. This bounds the call so a
  // hanging request cannot hold an Express worker — a timeout is a 502, never a 500.
  // Defaulted rather than required so an existing deployment (and app.test.ts, which stubs
  // env explicitly) keeps booting without a new variable.
  YOUTUBE_OEMBED_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(3_000),
  // --- Daily-log analysis (R_AND_D_BACKEND_STRUCTURE.md §8). One Gemini call per
  //     submitted log returns the transcript, the summary chips, the extracted claims and
  //     the evidence links together — two calls would spend a free-tier request budget
  //     twice on the same tokens.
  //
  // OPTIONAL, like Cloudinary and Brevo: with no key the submit path records
  // `analysis_status = 'skipped_unconfigured'` and the log keeps its narrative. That is
  // an operator fact, not a member's problem, and it is deliberately NOT `failed` — nor
  // is it ever a fabricated chip.
  GEMINI_API_KEY: z.string().min(1).optional(),
  // A THINKING model (the API reports `thinking: true` for it), which is why
  // src/lib/gemini.ts pins `thinkingConfig.thinkingLevel` rather than leaving the default:
  // transcription and claim extraction are mechanical, and unbounded reasoning spends
  // latency and free-tier quota on a task with nothing to reason about.
  GEMINI_MODEL: z.string().min(1).default("gemini-3.5-flash-lite"),
  // Generous: the model watches a video end to end. It still has to be BOUNDED, because
  // the call runs in a worker whose job slot it would otherwise hold indefinitely.
  //
  // A TIMEOUT IS CLASSIFIED RETRYABLE, so a value that is merely tight does not fail fast —
  // it burns five exponential-backoff attempts before an operator sees anything. Three
  // minutes covers a long log; the ceiling below still bounds the worst case.
  GEMINI_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(180_000),
  // `maxOutputTokens` is a CAP, NOT A RESERVATION — an unused ceiling costs nothing, and
  // the model's own limit is 65_536. Under-sizing it is what costs: a truncated response
  // comes back as `finishReason: MAX_TOKENS`, which src/lib/gemini.ts classifies PERMANENT,
  // so an 8k budget turns every long daily log into a dead-lettered `failed` analysis
  // rather than a retry. A 400-segment transcript plus chips and claims sits well inside
  // this.
  GEMINI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(65_536).default(32_768),

  // --- §9 integration consent (docs/R_AND_D_BACKEND_STRUCTURE.md §9.10).
  //
  // The key that envelope-encrypts third-party access tokens at rest. OPTIONAL, and its
  // absence DISABLES the connect routes with 503 rather than degrading to a default key —
  // a default key is indistinguishable from plaintext to anyone who has read the source.
  // §9.10 specifies a KMS-held key; src/lib/token-encryption.ts isolates the derivation
  // into one function so that swap is an edit rather than a migration.
  INTEGRATION_TOKEN_SECRET: z.string().min(32).optional(),
  // The GitHub App that grounds code artifacts. All three are required together, and
  // without them `POST …/integrations` answers 503 INTEGRATION_UNCONFIGURED and grounding
  // falls back to the evidence links §8 already stored.
  GITHUB_APP_ID: z.string().min(1).optional(),
  GITHUB_APP_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_APP_CLIENT_SECRET: z.string().min(1).optional(),
  // Bounds an artifact-grounding fetch so a hanging provider cannot hold a worker slot.
  INTEGRATION_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),

  // --- §7 funding and escrow (docs/R_AND_D_BACKEND_STRUCTURE.md §7).
  //
  // THE REGULATORY GATE, checked AT THE API — before creating a round, before opening one,
  // before accepting a pledge, and in the /funding/deals filter. PROOF_OF_EFFORT_SPEC.md
  // §1 sequences reward crowdfunding in Year 1 and true equity crowdfunding in Year 3+,
  // behind FINRA/SEC registration or a licensed broker-dealer partner. A disabled type is
  // invisible AND un-pledgeable over HTTP, which is what makes hiding the chip in
  // funding-deal-filter-grid.tsx cosmetic rather than load-bearing.
  //
  // Empty resolves to the default rather than to "nothing enabled": an operator who
  // clears the variable meant "reset", and a deployment that silently refuses every round
  // type is an outage that looks like a policy.
  ENABLED_FUNDING_ROUND_TYPES: commaSeparatedList
    .pipe(z.array(z.enum(["crowdfunding", "equity", "venture"])))
    .transform((types): readonly ("crowdfunding" | "equity" | "venture")[] =>
      types.length > 0 ? types : ["crowdfunding"],
    ),
  // The platform's cut of a pledge, in basis points. **0, AND IT STAYS 0** (§0).
  //
  // QATOTO CHARGES NOBODY — not a founder, an employee, an employer or an investor. This
  // variable survives only because migration 0016's historical rows were priced with it,
  // and removing it would make those rows unexplainable. A nonzero value is an explicit
  // business decision that also changes the LEGAL analysis, because in several US states
  // the money-transmitter definition turns partly on being compensated for the service
  // (§7A.6 item 1). It is not a knob to turn without counsel.
  //
  // DERIVED FROM THIS, NEVER SENT: `platformFeeInCents` is on §7's rejected-keys list, so
  // a body carrying one is a 422. The cap stays at 2000 rather than 0 so the historical
  // rows' value remains expressible when replaying them.
  PLATFORM_FEE_BASIS_POINTS: z.coerce.number().int().min(0).max(2_000).default(0),
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

// Inline workers are a local-development convenience and a production incident waiting to
// happen: the §6 recompute jobs scan every cluster, and §9's pipeline will be CPU-bound,
// so sharing the API's event loop turns each run into a latency spike on every in-flight
// request. Deployments run `pnpm start:worker` as its own process instead.
if (config.NODE_ENV === "production" && config.WORKER_INLINE) {
  throw new Error(
    "WORKER_INLINE must not be enabled in production — run the worker as a separate process (`pnpm start:worker`).",
  );
}
