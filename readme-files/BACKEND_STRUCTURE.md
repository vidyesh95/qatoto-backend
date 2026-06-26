# BACKEND_STRUCTURE.md — Qatoto Auth & Identity API

> This document describes the auth + identity contract the Next.js + TanStack Query
> frontend depends on, and how it is wired on the server.
>
> **Goal:** working auth — OTP-gated signup, password login, OAuth (Google/GitHub),
> passkeys, logout, session, password reset — with **one user per email** (providers
> link onto the same account instead of duplicating it). On top of auth it owns the
> user's **identity surface**: a unique **handle** (username), a **display name**, and
> a **profile photo** (avatar).
> **Stack:** **Better Auth** (auth engine) + **Drizzle ORM** (DB layer) +
> **PostgreSQL** + **Cloudinary** (avatar storage) + **sharp** (image validation).
> Better Auth does the security-sensitive auth work — argon2id password hashing,
> sessions, cookies, OTP, CSRF, WebAuthn/passkeys — so we don't hand-roll crypto. We
> own its config, our `/signup/*` endpoints, the identity endpoints under `/users/*`
> and `/handles/*`, and our route guards.

---

## 0. The one rule that governs everything

**The frontend is a hostile, untrusted presentation layer. The backend is the only
source of truth.** (Same NON-NEGOTIABLE principle as `CLAUDE.md` §1.1, from the
server side.)

Anyone can open DevTools, read the client JS, and forge any request. So the backend
**re-checks every single thing**, every request, by itself:

- The 3-step signup UI (email → OTP → password) is **just UX**. The server re-verifies
  the OTP before it trusts the email — never assume "step 2 happened". An account is
  created **only** once the OTP is verified **and** a password is set, in one atomic
  server call (`POST /signup/complete`) — verifying an OTP alone never creates an
  account (no passwordless orphans).
- Never trust a client-sent user id, role, price, quantity, or country. Better Auth
  derives the user from the **session cookie**, never from the request body. Every
  identity endpoint (`PATCH /users/me`, `/users/me/photo`, `/users/me/handle`) takes
  the user id from `req.user` (the session), **never** from the body — so a caller can
  only ever change **themselves**.
- The **handle** is server-owned. It is exposed read-only on the session
  (`additionalFields … input:false`), so Better Auth's own update/signup paths can
  **never** write it. The only writer is `PATCH /users/me/handle`, which runs the
  rate-limit + reservation transaction. Handle policy (3–30 chars, charset, 2 changes
  / 14 days) is enforced **server-side**; the identical frontend check is UX only.
- The **photo** is server-validated. The multipart mimetype is untrusted — `sharp`
  decodes the bytes to prove they're a real image, bounds the dimensions, and
  re-encodes to strip EXIF / smuggled payloads before anything is stored.
- Validate the **shape** of every request body/query on any endpoint **you** write
  (Zod `.safeParse()`, `422` on failure). Better Auth validates its own endpoints;
  your custom routes are your responsibility.

Using a library does **not** relax this rule — it means the library does the re-checks
for its own endpoints. If you remember nothing else from this file, remember §0.

---

## 1. What the frontend expects

Flows the backend supports:

- **Sign up (3 steps):** `email → send OTP → verify 6-digit OTP → set password (min 8)`.
- **Sign in with password:** `email + password + "remember me"`.
- **Sign in with OAuth:** Google / GitHub (now **live**, see §5).
- **Sign in with passkey:** WebAuthn (now **live**; registration requires an existing
  session — no passkey-first onboarding).
- **Forgot password (3 steps):** `email → send OTP (type forget-password) → verify OTP → set new password`.
- **Set display name:** `PATCH /users/me { fullName }` (Unicode-aware, 1–100 chars).
- **Set / remove profile photo:** `PATCH /users/me/photo` (multipart) / `DELETE /users/me/photo`.
- **Claim / change handle:** live availability probe (`GET /handles/availability`) plus
  an authoritative set/revert (`PATCH /users/me/handle`), with a panel bootstrap
  (`GET /users/me/handle`). Every new user is auto-seeded a placeholder handle on signup.

The real answer to "is this user logged in?" comes from Better Auth's session
(`GET /api/auth/get-session`, or the `useSession()` hook — see §8). `localStorage` is
the wrong place for a real session — see §7. The session also carries the user's
**handle** (via `additionalFields`), so the navbar/avatar menu reads it directly.

**One user = one email.** A person who first signs in with Google and later adds a
password (or vice-versa) ends up as **one** account, not two — Better Auth's account
linking attaches the new provider onto the existing user. See §5a / §6.

---

## 2. The stack

| Concern          | Pick                                           | Why this one                                                                                       |
| ---------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Server framework | **Express 5**                                  | Minimal, huge community. Run with `tsx` (no build step in dev).                                    |
| Language         | **TypeScript** (strict)                        | Same language as the frontend — shared types, fewer bugs.                                          |
| Auth engine      | **Better Auth** (`^1.6`)                       | Password hashing, sessions, cookies, OTP, CSRF, OAuth, WebAuthn. Don't roll your own crypto.       |
| Database ORM     | **Drizzle ORM**                                | Type-safe queries + migrations. The tables live in `src/db/schema.ts`.                             |
| Database         | **PostgreSQL** via `pg`                        | Strict types, same engine as prod. `UNIQUE(email)` / `UNIQUE(handle)` enforced at the DB.          |
| Passkeys         | **`@better-auth/passkey`**                     | WebAuthn relying-party + ceremony handling.                                                        |
| OTP / OAuth      | **`emailOTP` + social config**                 | OTP for signup/reset; Google + GitHub OAuth.                                                       |
| Anonymous        | **`anonymous` plugin**                         | Pre-auth guest sessions that can later upgrade to a real account.                                  |
| Avatar storage   | **Cloudinary** (`src/lib/cloudinary.ts`)       | One deterministic asset per user (`qatoto/avatars/<userId>`). Creds optional → `NOT_CONFIGURED`.   |
| Image processing | **sharp** (`src/lib/image.ts`)                 | Decodes uploads to prove they're real images, bounds dimensions, re-encodes to webp + strips EXIF. |
| File uploads     | **multer** (`src/middleware/upload-avatar.ts`) | In-memory multipart parse for the `photo` field, 5 MB cap, first-pass mimetype gate.               |
| Email delivery   | **Brevo** (`src/lib/email.ts`)                 | Real transactional email. In dev the OTP is **also** `console.log`'d so you can test offline.      |
| Security headers | **helmet**                                     | Sensible default response headers.                                                                 |
| Cookies          | **cookie-parser**                              | Parses cookies for your own routes (Better Auth reads/writes its own signed cookies).              |
| CORS             | **cors**                                       | Lets the browser on the frontend origin call the API, with credentials.                            |

**Still NOT hand-rolled:** no `bcrypt` (argon2id via `@node-rs/argon2`), no hand-written
sessions / OTP / passkey tables (Better Auth owns those — see §4).

Runtime deps (from `package.json`):

```bash
express better-auth @better-auth/passkey @node-rs/argon2 \
  drizzle-orm pg cors helmet cookie-parser dotenv \
  cloudinary multer sharp \
  express-rate-limit http-errors morgan debug
```

`package.json` (`"type": "module"`) scripts that matter:

```jsonc
{
    "scripts": {
        "dev": "tsx watch --conditions=development src/index.ts", // auto-restart, TS direct
        "build": "tsc",
        "start": "node dist/index.js",
        "typecheck": "tsc --noEmit && tsc --noEmit -p tsconfig.scripts.json && tsc --noEmit -p tsconfig.test.json",
        "test": "vitest run",
        "db:generate": "drizzle-kit generate", // schema → SQL migration
        "db:migrate": "drizzle-kit migrate", // apply migration
        "db:cleanup-orphans": "tsx --conditions=development scripts/cleanup-orphan-signups.ts",
        "db:cleanup-handle-reservations": "tsx --conditions=development scripts/cleanup-expired-handle-reservations.ts",
        "db:backfill-handles": "tsx --conditions=development scripts/backfill-handles.ts",
        "db:backfill-oauth-profile": "tsx --conditions=development scripts/backfill-oauth-profile.ts",
        "fmt": "oxfmt", // formatting via oxfmt
        "lint": "oxlint", // linting via oxlint
    },
}
```

> Schema note: the Drizzle tables in `src/db/schema.ts` are committed to the repo (not
> regenerated from auth config on every change). When you add/remove a Better Auth plugin
> that needs columns, or add identity columns (handle, image, …), update `schema.ts` and
> run `db:generate` + `db:migrate`.

---

## 3. Folder structure

```text
qatoto-backend/
├── src/
│   ├── index.ts                          # loads env, starts the HTTP server
│   ├── app.ts                            # builds the Express app: helmet, cors, Better Auth mount, routes
│   ├── config/index.ts                   # Zod-parsed env (DATABASE_URL, BETTER_AUTH_*, OAuth, Brevo, Cloudinary, DATABASE_CA_CERT_PATH)
│   ├── lib/
│   │   ├── auth.ts                        # the Better Auth instance (adapter, email+pw, OTP, OAuth, passkey, anonymous, hooks)
│   │   ├── email.ts                       # Brevo transactional email (Result-typed)
│   │   ├── cloudinary.ts                  # avatar upload/delete (Result-typed; deterministic per-user public id)
│   │   └── image.ts                       # sharp avatar validation + normalization (Result-typed)
│   ├── db/
│   │   ├── index.ts                       # Postgres pool (SSL/CA, keepAlive) + Drizzle + query() helper
│   │   └── schema.ts                      # user / session / account / verification / passkey / handle_reservations tables
│   ├── controllers/
│   │   ├── auth.controller.ts             # /signup/start, /signup/complete, /me handlers
│   │   ├── users.controller.ts            # /users, /users/:id, PATCH /users/me, photo handlers
│   │   └── handle.controller.ts           # handle metadata, availability, set/revert handlers
│   ├── middleware/
│   │   ├── require-auth.ts                # session guard for YOUR routes → req.user (incl. handle)
│   │   ├── rate-limit.ts                  # Express limiters on /signup/* and /handles/availability
│   │   ├── upload-avatar.ts               # multer memory upload for the `photo` field (5 MB cap)
│   │   ├── validate.ts, request-id.ts, error-handler.ts, not-found.ts
│   ├── routes/
│   │   ├── index.ts                       # / and /health
│   │   ├── auth.routes.ts                 # /signup/start, /signup/complete, /me
│   │   ├── users.routes.ts                # /users, PATCH /users/me, /users/me/photo, /users/me/handle
│   │   └── handles.routes.ts              # /handles/availability
│   ├── services/
│   │   ├── users.service.ts               # updateUserName / updateUserPhoto / deleteUserPhoto (PublicUser)
│   │   └── handle.service.ts              # handle validation, availability, set/revert txn, placeholder seeding
│   ├── types/
├── scripts/
│   ├── cleanup-orphan-signups.ts          # one-time orphan cleanup (see §5e)
│   ├── cleanup-expired-handle-reservations.ts  # daily cron: purge dead reservations (§5g)
│   ├── backfill-handles.ts                # one-off: seed placeholder handles for pre-hook users (§5g)
│   └── backfill-oauth-profile.ts          # one-off: copy name/image from already-linked OAuth (§5g)
├── drizzle.config.ts
└── .env                                   # NEVER commit
```

---

## 4. The data (Better Auth owns the auth schema; we own the identity columns)

Tables in `src/db/schema.ts`:

| Table                 | What it holds                                                                                                                                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user`                | id, `name` (notNull), `nameSetByUser`, **`email` (UNIQUE)**, emailVerified, `image`, `imageSource`, **`handle` (UNIQUE, nullable)**, `handleUpdatedAt`, `handleChangeCount`, `handleWindowStartedAt`, `isAnonymous`, timestamps. **No raw password here.** |
| `account`             | one row **per provider** for a user: `providerId` (`credential` / `google` / `github`), the argon2id `password` hash for credential rows, OAuth tokens for the rest. Account linking = multiple `account` rows pointing at the **same** `userId`.          |
| `session`             | one row per logged-in session — the cookie holds only an opaque token; everything else stays server-side. Indexed on `userId`.                                                                                                                             |
| `verification`        | short-lived OTP / verification records (hashed, expiring, single-use).                                                                                                                                                                                     |
| `passkey`             | WebAuthn credentials (publicKey, counter, deviceType, transports…) keyed to a user.                                                                                                                                                                        |
| `handle_reservations` | a handle a user **previously** held, parked for 14 days. PK is `reserved_handle` (the normalized string → one reservation per handle); also `userId` (FK, cascade), `expiresAt`, `createdAt`. Indexed on `userId` and `expiresAt`. See §5g.                |

**Identity columns on `user`** (we own these; Better Auth owns the rest):

- `name` (notNull) — display name. `nameSetByUser` (bool, default false) flips to `true`
  once the user sets it via `PATCH /users/me`; it marks the name **user-owned** so OAuth
  account linking never overwrites it (`updateUserInfoOnLink: false`).
- `image` (nullable) — avatar URL. `imageSource` is a Postgres enum `image_source`
  (`"oauth" | "user"`, nullable): `"oauth"` = seeded from a provider profile at first
  sign-in; `"user"` = the user uploaded their own photo. `"user"` is a **lock** — OAuth
  must never overwrite a user-owned photo (mirrors `nameSetByUser`).
- `handle` (UNIQUE, nullable) — the active handle, stored **normalized** (lowercased, no
  leading `@`). UNIQUE so no two users share one; `NULL` until claimed (Postgres UNIQUE
  permits many NULLs). The leading `@` is display-only and never stored. Exposed on the
  session via Better Auth `additionalFields`.
- `handleUpdatedAt`, `handleChangeCount`, `handleWindowStartedAt` — rate-limit
  bookkeeping for the 2-changes-per-14-days window (§5g). The server is the sole
  authority; the client only previews the lock.

The `UNIQUE(email)` on `user` is the structural guarantee behind "one user = one email":
a second provider reporting the same verified email links onto the existing row rather
than inserting a duplicate. `UNIQUE(handle)` is the equivalent guarantee for handles and
the final race-guard behind the SELECT-based availability checks.

Protections still hold: OTPs hashed/expiring/single-use; password hashed (argon2id),
never stored or returned in plaintext; session cookie carries only an opaque reference.

Re-run `npm run db:generate && npm run db:migrate` after a schema change.

---

## 5. The setup + the API

### 5a. The Better Auth instance — `src/lib/auth.ts`

```ts
import { passkey } from "@better-auth/passkey";
import { hash, verify } from "@node-rs/argon2";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { anonymous, emailOTP } from "better-auth/plugins";
import { assignPlaceholderHandle } from "#src/services/handle.service.js";

export const auth = betterAuth({
    database: drizzleAdapter(db, { provider: "pg" }),
    secret: config.BETTER_AUTH_SECRET,
    baseURL: config.BETTER_AUTH_URL,
    trustedOrigins: [config.FRONTEND_URL],

    // Expose handle on the session so session.user.handle drives menu/avatar display
    // (the frontend mirrors it via inferAdditionalFields). input:false → the handle is
    // NEVER client-writable through Better Auth's own update/signup paths; it is owned
    // solely by PATCH /users/me/handle (src/services/handle.service.ts).
    user: {
        additionalFields: {
            handle: { type: "string", required: false, input: false },
        },
    },

    // Rate limits Better Auth's OWN HTTP endpoints (forgot-password, password login,
    // OTP). Does NOT cover our server-side auth.api calls in /signup/* — those are
    // limited in Express (src/middleware/rate-limit.ts). Enabled in ALL envs.
    rateLimit: {
        enabled: true,
        window: 60,
        max: 100,
        customRules: {
            "/email-otp/send-verification-otp": { window: 60, max: 3 },
            "/sign-in/email-otp": { window: 60, max: 5 },
            "/email-otp/reset-password": { window: 60, max: 5 },
            "/sign-in/email": { window: 10, max: 5 },
        },
    },

    // On every NEW user (Google, GitHub, email/password): if the provider seeded an
    // image, stamp imageSource = "oauth" (marks it provider-owned). Then seed a unique
    // randomized placeholder handle (e.g. user_vidyesh_7a9f) so every signup path lands
    // with a handle. A handle-seed failure is logged, NOT fatal — account creation wins.
    databaseHooks: {
        user: {
            create: {
                after: async (createdUser) => {
                    if (createdUser.image) {
                        await db
                            .update(user)
                            .set({ imageSource: "oauth" })
                            .where(eq(user.id, createdUser.id));
                    }
                    const placeholderResult = await assignPlaceholderHandle(
                        createdUser.id,
                        createdUser.name,
                        createdUser.email,
                    );
                    if (!placeholderResult.success) {
                        console.error(
                            `Failed to assign placeholder handle to user ${createdUser.id}: ...`,
                        );
                    }
                },
            },
        },
    },

    // One user = one email. google/github are trusted (first-party OAuth). "email-password"
    // is deliberately NOT trusted — a credential signup must prove the email via OTP (our
    // /signup/complete, Path C) before it can ride onto an existing OAuth account.
    // updateUserInfoOnLink:false → linking a 2nd provider must NOT overwrite the local
    // name/image (would clobber a user-set name/photo). OAuth still seeds name/image at
    // FIRST sign-in (user creation); only the link-time overwrite is suppressed.
    account: {
        accountLinking: {
            enabled: true,
            trustedProviders: ["google", "github"],
            updateUserInfoOnLink: false,
        },
    },

    // Server-side guard on Better Auth's own POST /unlink-account. Its built-in check only
    // blocks unlinking the LAST account — it does NOT protect the ORIGINAL provider (the
    // one the account was created with), which owns the verified identity. We forbid
    // unlinking that earliest-created account outright. Frontend hides the button (UX
    // only); a hostile client can still POST raw, so the check lives here.
    hooks: {
        before: createAuthMiddleware(async (ctx) => {
            if (ctx.path !== "/unlink-account") return;
            const session = await getSessionFromCtx(ctx);
            if (!session) return;
            // ... parse body, load the user's accounts oldest-first ...
            // if the request targets the original (earliest-created) account:
            //   throw new APIError("FORBIDDEN", { message: "The original sign-in provider cannot be unlinked." });
        }),
    },

    emailAndPassword: {
        enabled: true,
        minPasswordLength: 8,
        password: {
            hash: (password) => hash(password),
            verify: ({ hash: passwordHash, password }) => verify(passwordHash, password),
        },
    },

    socialProviders: {
        google: { clientId: config.GOOGLE_CLIENT_ID, clientSecret: config.GOOGLE_CLIENT_SECRET },
        github: { clientId: config.GITHUB_CLIENT_ID, clientSecret: config.GITHUB_CLIENT_SECRET },
    },

    plugins: [
        anonymous(),
        passkey({
            // WebAuthn relying-party identity derives from the FRONTEND origin (the ceremony
            // runs in the user's browser there), NOT the API origin.
            rpID: new URL(config.FRONTEND_URL).hostname,
            rpName: "Qatoto",
            origin: new URL(config.FRONTEND_URL).origin,
            // requireSession: account creation is owned solely by /signup/complete. No
            // passkey-first onboarding (would mint orphan users), mirroring emailOTP below.
            registration: { requireSession: true, extensions: { credProps: true } },
            authentication: { extensions: { credProps: true } },
        }),
        emailOTP({
            // OTP alone NEVER creates a user. Account creation is owned by /signup/complete
            // (verified OTP + password, atomic) → no passwordless orphans.
            disableSignUp: true,
            async sendVerificationOTP({ email, otp, type }) {
                if (config.NODE_ENV === "development")
                    console.log(`OTP for ${email} (${type}): ${otp}`);
                const subject =
                    type === "forget-password"
                        ? "Reset your Qatoto password"
                        : "Your Qatoto verification code";
                const sendResult = await sendTransactionalEmail({
                    toEmail: email,
                    subject /* html+text */,
                });
                if (!sendResult.success) {
                    // NOT_CONFIGURED in dev is fine (code already logged); fail loudly otherwise.
                    if (
                        sendResult.error.type === "NOT_CONFIGURED" &&
                        config.NODE_ENV === "development"
                    )
                        return;
                    throw new Error(
                        `Failed to send OTP email: ${JSON.stringify(sendResult.error)}`,
                    );
                }
            },
        }),
    ],
});
```

### 5b. The database — `src/db/index.ts`

A `Pool` reuses open connections instead of dialing a fresh one per request. The pool is
hardened for a managed remote Postgres (Aiven): explicit TLS with a CA cert, short idle
timeout (so the server doesn't reap a socket out from under us), and TCP keepalives.

```ts
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

// When a CA cert path is set, verify the server cert against it.
const ssl = config.DATABASE_CA_CERT_PATH
    ? { rejectUnauthorized: true, ca: readFileSync(config.DATABASE_CA_CERT_PATH).toString() }
    : undefined;

// Strip `sslmode` from the URL when we supply our own `ssl` — pg-connection-string
// treats `sslmode=require` as `verify-full` and would override our `ssl` object,
// breaking CA verification with SELF_SIGNED_CERT_IN_CHAIN. Our `ssl` is the only source.
const connectionString = ssl
    ? config.DATABASE_URL.replace(/([?&])sslmode=[^&]*&?/, "$1").replace(/[?&]$/, "")
    : config.DATABASE_URL;

export const pool = new Pool({
    connectionString,
    ssl,
    max: 20,
    idleTimeoutMillis: 10000, // recycle before Aiven reaps idle sockets
    connectionTimeoutMillis: 10000,
    keepAlive: true,
});
export const db = drizzle(pool, { schema });

// Idle clients dropped by the remote server emit 'error' here — log, never exit.
pool.on("error", (err) => console.error("Unexpected error on idle database client", err));

// Thin raw-SQL helper (used by a couple of legacy read paths in users.service).
export async function query(text: string, params?: unknown[]) {
    /* pool.query + dev timing */
}
```

> The driver import + `provider: "pg"` in `auth.ts` are the only Postgres-specific lines.
> **Migrations gotcha:** `drizzle-kit` does NOT read this pool — for `db:migrate` against
> an SSL provider, configure discrete credentials (not a CA-cert URL) in `drizzle.config.ts`,
> or migrations fail silently.

### 5c. Mounting on Express — `src/app.ts`

**Order matters.** The Better Auth handler mounts **before** `express.json()`, because
it parses its own request bodies off the raw stream. A body parser ahead of it consumes
the stream and breaks every auth POST. (Avatar uploads are multipart and parsed by
`multer` **inside** the `/users/me/photo` route, so the global `express.json()` never
touches them either.)

```ts
const app = express();
app.set("trust proxy", 1); // behind nginx / load balancer
app.use(helmet()); // security headers
app.use(cors({ origin: config.FRONTEND_URL, credentials: true })); // exact origin, allow cookies
app.use(requestId); // request tracing
app.use(logger("dev")); // morgan

// Better Auth catch-all — BEFORE express.json(). Express 5 splat syntax "*splat".
app.all("/api/auth/*splat", toNodeHandler(auth.handler));

app.use(express.json({ limit: "10kb" })); // YOUR routes only
app.use(express.urlencoded({ extended: false, limit: "10kb" }));
app.use(cookieParser());

app.use("/", indexRouter); // /, /health
app.use("/", authRouter); // /signup/start, /signup/complete, /me
app.use("/users", usersRouter); // /users, PATCH /users/me, /users/me/photo, /users/me/handle
app.use("/handles", handlesRouter); // /handles/availability

app.use(notFoundHandler);
app.use(errorHandler);
```

`src/index.ts` loads env, then `app.listen(config.PORT)`.

### 5d. The endpoints Better Auth gives you (free, under `/api/auth`)

You don't write these — enabling the config above creates them.

| Method & path                                    | Body                              | Purpose                                                                                          |
| ------------------------------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------ |
| `POST /api/auth/email-otp/send-verification-otp` | `{ email, type }`                 | Generate + send a 6-digit OTP. `type`: `"sign-in"`, `"email-verification"`, `"forget-password"`. |
| `POST /api/auth/sign-in/email-otp`               | `{ email, otp }`                  | OTP login for **existing** users. `disableSignUp: true` → never creates a user. Signup uses §5e. |
| `POST /api/auth/email-otp/reset-password`        | `{ email, otp, password }`        | Forgot-password: verify a `forget-password` OTP, set new password.                               |
| `POST /api/auth/sign-in/email`                   | `{ email, password, rememberMe }` | Password login. Wrong email or password → same generic error.                                    |
| `GET  /api/auth/sign-in/social` (+ callback)     | provider redirect                 | Google / GitHub OAuth. Verified-email match → links onto the existing user (one account).        |
| `POST /api/auth/passkey/*`                       | WebAuthn ceremony                 | Register / authenticate passkeys. Registration requires an existing session.                     |
| `POST /api/auth/sign-in/anonymous`               | —                                 | Guest session (anonymous plugin), upgradable to a real account later.                            |
| `POST /api/auth/unlink-account`                  | `{ providerId, accountId? }`      | Unlink a provider — but our `hooks.before` **forbids unlinking the original provider** (§5a).    |
| `POST /api/auth/sign-out`                        | — (reads cookie)                  | Ends the session, clears the cookie.                                                             |
| `GET  /api/auth/get-session`                     | — (reads cookie)                  | The real "am I logged in?" check. Returns session + user (incl. `handle`), or null.              |

### 5e. The signup endpoints YOU write — `src/controllers/auth.controller.ts`

OTP-gated signup, account created at the end so a half-finished signup leaves no row.
Both are **public** (no session yet) and validated with Zod `.strict()` (`422` on failure).

| Method & path           | Body                              | Creates a user?                                                                    |
| ----------------------- | --------------------------------- | ---------------------------------------------------------------------------------- |
| `POST /signup/start`    | `{ email }`                       | No — sends the OTP. Generic 200 (can't probe which emails exist).                  |
| `POST /signup/complete` | `{ email, otp, password, name? }` | Resolves to exactly **one** user via three paths (below).                          |
| `GET  /me`              | — (session cookie)                | Returns `req.user` (requires auth) — `{ id, email, name, emailVerified, handle }`. |

`/signup/complete` looks up the email, then takes one of **three** paths:

```text
POST /signup/complete { email, otp, password, name? }
 ├─ Path A — no user yet:
 │    checkVerificationOTP → (valid) signUpEmail → mark emailVerified → session.   → 201 created
 │    bad/expired OTP → 401, nothing created.  missing password → 422 at boundary.
 │
 ├─ Path B — user exists AND already has a `credential` account row:
 │    genuine re-signup → 409 ("sign in instead"). Nothing duplicated.
 │
 └─ Path C — user exists but is OAuth-only (no credential row):
      signInEmailOTP (proves ownership + mints a session for THIS user)
        → setPassword (session-scoped: replays that session) attaches the password
          to the SAME user — no second row.                                        → 201 linked
      bad/expired OTP → 401.
```

Path C is what makes "signed up with Google, later set a password" collapse into one
account. `setPassword` is session-scoped, so the controller replays the freshly minted
session cookie (`setCookiesToCookieHeader` → `Headers({ cookie })`) into the `auth.api`
call. Errors are mapped from Better Auth's `APIError`: bad OTP → `401`, email already
fully registered / race on `signUpEmail` → `409`.

#### No orphans — by construction

`disableSignUp: true` blocks `sign-in/email-otp` from minting a user, `passkey`
registration requires a session, and `/signup/complete` demands the password in the same
call as the OTP. So there is no "verified-but-passwordless" state.

> **Migrating from the old flow:** passwordless orphan rows from the previous
> `sign-in/email-otp`-creates-the-user design are stranded. One-time cleanup:
> `npm run db:cleanup-orphans` (dry run) → `npm run db:cleanup-orphans -- --delete`
> (see [scripts/cleanup-orphan-signups.ts](../scripts/cleanup-orphan-signups.ts)).

### 5f. The profile endpoints YOU write — `src/controllers/users.controller.ts`

Display name and profile photo. All `/users/me*` routes are session-guarded by
`requireAuth`; the user id comes from `req.user`, never the body, so a caller can only
change **themselves** (§0). `/me`-prefixed routes are declared **before** `/:id` so
"me" is never swallowed as an id param. Success returns the `PublicUser`
(`{ id, name, email, image, imageSource, emailVerified }`) the frontend reads back.

| Method & path            | Body / input                             | Behavior & statuses                                                                                          |
| ------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `GET    /users`          | —                                        | List up to 100 users (raw `query`). **Currently public.**                                                    |
| `GET    /users/:id`      | —                                        | One user by id, or `404`. **Currently public.**                                                              |
| `PATCH  /users/me`       | `{ fullName }` (`.strict()`)             | Set display name → marks `nameSetByUser: true`. `200` PublicUser · `422` validation · `404` user gone.       |
| `PATCH  /users/me/photo` | `multipart/form-data`, field **`photo`** | Validate+normalize bytes, upload to Cloudinary, stamp `imageSource: "user"`. Statuses below.                 |
| `DELETE /users/me/photo` | —                                        | Delete the Cloudinary asset, clear `image` + `imageSource` (re-allows OAuth re-seed). `200` · `503/502/404`. |

`PATCH /users/me`'s `fullName` is parsed by `FullNameSchema`: trimmed, 1–100 chars,
Unicode-aware regex `^[\p{L}\p{M}][\p{L}\p{M} '.-]*$` (must start with a letter/mark, so
it can't be pure punctuation). Setting the name deliberately overrides any value OAuth
seeded.

`PATCH /users/me/photo` status map (from the service's typed `Result` errors):

| Service error                             | HTTP  | Meaning                                 |
| ----------------------------------------- | ----- | --------------------------------------- |
| missing `req.file`                        | `422` | No `photo` field on the multipart body. |
| `NOT_AN_IMAGE`                            | `422` | Bytes don't decode as a raster image.   |
| `UNSUPPORTED_FORMAT`                      | `422` | Not JPEG/PNG/WebP.                      |
| `DIMENSIONS_TOO_SMALL`                    | `422` | Smaller than 64×64.                     |
| `DIMENSIONS_TOO_LARGE`                    | `422` | Larger than 8192 on a side.             |
| `NOT_CONFIGURED`                          | `503` | Cloudinary creds absent.                |
| `UPLOAD_FAILED` / `DELETE_FAILED`         | `502` | Storage provider error.                 |
| `USER_NOT_FOUND`                          | `404` | Row vanished mid-request.               |
| (size cap, in `upload-avatar` middleware) | `413` | File exceeds the 5 MB limit.            |

**The avatar pipeline** (`upload-avatar.ts` → `image.ts` → `cloudinary.ts`):

1. **`uploadAvatarPhoto`** (multer, memory storage): single `photo` field, **5 MB** cap
   (`413` on overflow), `files: 1`, first-pass `image/*` mimetype gate. The byte cap is a
   cheap guard **before** decoding — the mimetype is untrusted, `sharp` is authoritative.
2. **`validateAndNormalizeAvatar`** (sharp): decode to **prove** it's a real image (decode
   failure → `NOT_AN_IMAGE`); accept only `jpeg`/`png`/`webp`; reject `< 64px` or
   `> 8192px`; cap decoded pixels at `8192²` to blunt **decompression bombs**. Then
   re-encode: auto-orient via EXIF, **strip all metadata**, downscale to fit `1024×1024`
   (never enlarge), emit **webp q85**. The output buffer carries no EXIF / smuggled payload.
3. **`uploadUserAvatar`** (Cloudinary): upload the normalized buffer to the **deterministic**
   public id `qatoto/avatars/<userId>` with `overwrite: true, invalidate: true`. One asset
   per user — replacing a photo can't orphan the old one; no extra DB column needed. Returns
   the `secure_url`, which the service stores in `user.image`.

### 5g. The handle endpoints YOU write — `src/controllers/handle.controller.ts` + `handle.service.ts`

The handle is a unique, user-visible username. It is **server-owned** (`input:false` on
the session field) and governed by a **two-tier** design:

- **Tier 1 — `GET /handles/availability?handle=<raw>`** (in `handles.routes.ts`): a
  read-only, debounced **preview**. Auth-required (so the result can tell the caller's
  own current/revertable handle from a stranger's), and rate-limited per **user** at
  **60 / min** (`handleAvailabilityLimiter`). Returns a discriminated `data.status`:
  `available` · `taken` (+ up to 4 free `suggestions`) · `revertable` (caller's own live
  reservation) · `current` (already theirs) · `invalid` (+ a user-facing `reason`).
  Invalid input is a normal `200` preview, not a 4xx.
- **Tier 2 — `PATCH /users/me/handle { handle }`** (in `users.routes.ts`): the
  **authoritative** set/revert and the real trust boundary. The body handle is
  re-normalized, regex-validated, rate-limited, and availability-re-checked **inside one
  atomic transaction** (`SELECT … FOR UPDATE` on the user row + target reservation). The
  case (claim vs revert) is decided **server-side** from ownership — the client never picks it.
- **`GET /users/me/handle`**: panel bootstrap — current handle plus rate-limit state
  (`changesRemaining`, `isChangeLocked`, `cooldownResetAt`) and a one-tap revert
  affordance (`revertableHandle`, `revertableExpiresAt`).

| Method & path                 | Input                      | Behavior & statuses                                                                                     |
| ----------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `GET   /users/me/handle`      | — (session)                | `200` `HandleMetadata` · `404` user gone.                                                               |
| `GET   /handles/availability` | `?handle=<raw>` (query)    | `200` `HandleAvailability` (status union) · `422` query parse fail. Rate-limited 60/min/user.           |
| `PATCH /users/me/handle`      | `{ handle }` (`.strict()`) | `200` `SetHandleSuccess` · `422` `INVALID`/`TAKEN` · `429` `RATE_LIMITED` (+`cooldownResetAt`) · `404`. |

**Handle policy** (all server-side, in `handle.service.ts`):

- **Normalization:** trim → drop a single leading `@` → lowercase. Stored canonical.
- **Validation:** regex `^[a-z0-9._-]{3,30}$` — 3–30 chars of lowercase letters, digits,
  dot, underscore, hyphen. The single gate every server path runs before touching the DB.
- **Rate limit:** `MAX_HANDLE_CHANGES_PER_WINDOW = 2` changes per rolling **14-day** window
  (`HANDLE_WINDOW_DAYS`). Tracked on `user.handleChangeCount` / `handleWindowStartedAt`; a
  no-op (setting your current handle) doesn't consume a change. At the cap → `429` with the
  `cooldownResetAt` instant the panel surfaces.
- **Reservations (revert):** when you change away from a handle, the old one is **parked**
  in `handle_reservations` for 14 days. While live it's (a) blocked from anyone else and
  (b) revertable by you (Case 2). Once `expires_at < NOW()` the hold is dead — it reads as
  available and is lazy-deleted on the next touch (plus the daily cron sweep).
- **Race guard:** the `user.handle` UNIQUE and `handle_reservations` PK back the
  SELECT-based re-check; a concurrent claim surfaces as Postgres `23505` → mapped to `TAKEN`.

**Placeholder handles & OAuth profile backfill (the supporting scripts):**

- **`assignPlaceholderHandle`** runs from the Better Auth user-create hook (§5a), seeding
  every new user a unique randomized handle (`user_<base>_<4hex>`, e.g. `user_vidyesh_7a9f`,
  or `user_<8 digits>` with no usable name/email). Stored as the active handle **without**
  consuming the rate-limit window. Idempotent (`WHERE handle IS NULL`), never clobbers.
- **`npm run db:backfill-handles`** — one-off: seed placeholder handles for users who
  predate the hook (`handle IS NULL`). Dry-run by default; `-- --apply` to write.
- **`npm run db:backfill-oauth-profile`** — one-off: copy `name`/`image` from an
  already-linked OAuth account (Google `id_token` decode / GitHub `/user` API) onto users
  who linked before `updateUserInfoOnLink` mattered. Conservative: `image` only when null,
  `name` only when it's still the email-prefix fallback. Dry-run by default; `-- --apply`.
- **`npm run db:cleanup-handle-reservations`** — daily off-peak cron: hard-delete dead
  reservations (`purgeExpiredHandleReservations`). Pure housekeeping — lazy reads already
  treat expired holds as available.

---

## 6. How a request flows

**Signup (3-step UI):**

```text
1. UI step 1 (email):
   POST /signup/start { email }
   → forwards to send-verification-otp; stores a hashed, expiring OTP; sends email
     (dev: also console.log("OTP for a@b.com (sign-in): 482913")). NO user created.

2. UI steps 2+3 (OTP + password), ONE final call:
   POST /signup/complete { email, otp, password }
   → Path A creates the user (emailVerified = true) WITH the password atomically, seeds a
     placeholder handle + stamps imageSource (user-create hook), and sets the httpOnly
     session cookie. Bad OTP → 401, no user; missing password → 422.

3. Frontend: useSession() → navbar shows logged-in state (incl. session.user.handle).
```

If the user bails before the final call, no account exists — nothing to recover.

**Login:** `POST /api/auth/sign-in/email { email, password, rememberMe }`.

**OAuth:** `sign-in/social` (Google/GitHub). If the verified email already exists, the
provider links onto that user — **one** account, not a duplicate (§5a `accountLinking`).
A brand-new OAuth user is seeded `name`/`image` (with `imageSource: "oauth"`) and a
placeholder handle at creation; a **link** onto an existing user does NOT overwrite their
name/photo (`updateUserInfoOnLink: false`).

**Add a password to an OAuth-only account:** run `/signup/complete` for that email →
**Path C** attaches the credential to the same user.

**Passkey:** register only while signed in (`requireSession: true`); authenticate via
`passkey/*`.

**Forgot password:** step 1 → `send-verification-otp { email, type: "forget-password" }`;
final → `email-otp/reset-password { email, otp, password }`. No custom endpoint.

**Set display name:** `PATCH /users/me { fullName }` → overrides any OAuth-seeded name and
locks it (`nameSetByUser: true`).

**Set / remove profile photo:** `PATCH /users/me/photo` (multipart `photo`) → sharp
validate+normalize → Cloudinary upload → `image` + `imageSource: "user"`. `DELETE
/users/me/photo` removes the asset and clears both fields (re-allows OAuth re-seed).

**Change a handle:** Tier 1 `GET /handles/availability?handle=…` debounced as the user
types → Tier 2 `PATCH /users/me/handle { handle }` commits inside the atomic transaction
(parks the old handle for 14 days; consumes one of 2 changes / 14 days). To revert, set a
handle the caller still holds a live reservation on (Case 2) — still a real change that
consumes one of the 2/14-day allowance; only re-setting your **current** active handle is
a free no-op.

---

## 7. Sessions & cookies

On login, OTP signup, OAuth, passkey, or password reset, **Better Auth sets the session
cookie** — httpOnly, `secure` in production, `sameSite: "lax"`, signed, server-managed
expiry. `rememberMe` extends lifetime. You don't write `res.cookie(...)` or generate
session ids. The session **user** also carries `handle` (via `additionalFields`), so the
client reads `session.user.handle` directly for the navbar/avatar menu.

For **your own** protected routes, ask Better Auth who the user is — `src/middleware/require-auth.ts`:

```ts
export async function requireAuth(req, res, next): Promise<void> {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session) {
        res.status(401).json({ status: "error", statusCode: 401, message: "Please sign in." });
        return;
    }
    req.user = {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        emailVerified: session.user.emailVerified,
        handle: session.user.handle ?? null, // exposed via additionalFields
    };
    next();
}
```

`req.user` is declared via a global Express augmentation (`src/types/express.d.ts`) and
now includes `handle`. Zero-trust: the session is re-derived server-side on every request
— the frontend cannot assert identity.

**Why a cookie, not `localStorage`?** A real token in `localStorage` is XSS-stealable by
any script on the page. Better Auth's httpOnly cookie is invisible to page JS and
attached automatically by the browser.

---

## 8. Connecting to the frontend (CORS + the Better Auth client)

Frontend and API run on different origins, so the browser blocks the call unless the
server opts in.

- **CORS** (server): name the exact origin (`config.FRONTEND_URL`, never `*`) and allow
  credentials — set in §5c.
- **`sameSite: "lax"`** (cookie default) rides along on `localhost → localhost` in dev.
  In prod, put the API on a subdomain (`api.qatoto.com`) to stay same-site with `qatoto.com`.

Frontend client (typed, sends cookies automatically). Add `inferAdditionalFields` so the
client type includes `session.user.handle`:

```ts
// src/lib/auth-client.ts (frontend)
import { createAuthClient } from "better-auth/react";
import { emailOTPClient, inferAdditionalFields } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";

export const authClient = createAuthClient({
    baseURL: "http://localhost:8000",
    plugins: [
        emailOTPClient(),
        passkeyClient(),
        inferAdditionalFields({ user: { handle: { type: "string" } } }),
    ],
});
export const { useSession, signIn, signOut } = authClient;
```

```ts
const { data: session } = useSession(); // "am I logged in?" → session.user.handle
await signIn.email({ email, password, rememberMe }); // password login
await signIn.social({ provider: "google" }); // OAuth
await authClient.passkey.addPasskey(); // register passkey (needs session)

// Signup — your endpoints; pass credentials: "include" on the raw fetch
await fetch("http://localhost:8000/signup/start", {
    method: "POST",
    credentials: "include" /* {email} */,
});
await fetch("http://localhost:8000/signup/complete", {
    method: "POST",
    credentials: "include" /* {email,otp,password} */,
});

// Identity — your endpoints (all need credentials: "include")
await fetch("http://localhost:8000/users/me", {
    method: "PATCH",
    credentials: "include" /* {fullName} */,
});
await fetch("http://localhost:8000/users/me/handle", {
    method: "PATCH",
    credentials: "include" /* {handle} */,
});
await fetch(`http://localhost:8000/handles/availability?handle=${h}`, { credentials: "include" });

// Profile photo — multipart, DO NOT set Content-Type (the browser sets the boundary)
const form = new FormData();
form.append("photo", file);
await fetch("http://localhost:8000/users/me/photo", {
    method: "PATCH",
    body: form,
    credentials: "include",
});
await fetch("http://localhost:8000/users/me/photo", { method: "DELETE", credentials: "include" });

// Forgot password
await authClient.emailOtp.sendVerificationOtp({ email, type: "forget-password" });
await authClient.emailOtp.resetPassword({ email, otp, password });

await signOut();
```

---

## 9. Status / build order

Done and live:

0. Hello server, DB + Drizzle, Better Auth (email+password), password login + session.
1. OTP plugin + OTP-gated signup (`/signup/start` → `/signup/complete`).
2. Logout, forgot-password.
3. **OAuth** (Google + GitHub) with account linking (one user = one email); original
   provider cannot be unlinked.
4. **Passkeys** (`@better-auth/passkey`, `requireSession`).
5. **Anonymous** guest sessions.
6. **Real email** via Brevo (`src/lib/email.ts`); dev still console.log's the OTP.
7. **Rate limiting** (below).
8. **Display name** (`PATCH /users/me`, `nameSetByUser` lock).
9. **Profile photo / avatar** (`PATCH`/`DELETE /users/me/photo`) — multer → sharp
   validate/normalize → Cloudinary; `imageSource` lock; `DATABASE`/Cloudinary creds optional.
10. **Handles** — placeholder seeding on signup, Tier-1 availability + Tier-2 atomic
    set/revert, 2-changes/14-days rate limit, 14-day revert reservations + daily cron.
11. **Backfill scripts** — placeholder handles, OAuth name/image profile.

### Later (NOT now)

- Managed Postgres + pooling for prod (Neon, RDS, Supabase). _(Current pool already
  hardened for Aiven: CA-cert TLS, idle recycling, keepAlive — see §5b.)_
- **Shared rate-limit store for prod.** All limiters are **in-memory** (per-process).
  Multi-instance/serverless lets attackers round-robin instances → move to a shared
  store: Express limiters → `rate-limit-redis`; Better Auth → `rateLimit.storage:
"database"` (adds a `rateLimit` table) or `"secondary-storage"`.
- **Lock down `GET /users` / `GET /users/:id`** — currently public list/read endpoints.

### Rate limiting (done)

Layers (Better Auth's limiter does **not** cover server-side `auth.api` calls, so the
custom routes need their own):

- **Express limiters** (`src/middleware/rate-limit.ts`): `/signup/start` capped
  **per-IP** (8/15min) **and per-email** (4/15min) (stops OTP spam + inbox-bombing);
  `/signup/complete` capped **per-IP** (12/15min); `/handles/availability` capped
  **per-user** (60/min). 429 returns the standard ApiResponse envelope with `retryAfterSeconds`.
- **Better Auth `rateLimit`** (`src/lib/auth.ts`): `send-verification-otp` 3/60s,
  `sign-in/email-otp` 5/60s, `reset-password` 5/60s, `sign-in/email` 5/10s. Enabled in
  all envs.
- **Handle changes** are separately governed by the **2 changes / 14 days** policy in the
  service (a domain rule, not an HTTP limiter) — see §5g.

---

## 10. Security checklist

- [ ] Server re-validates **every** request — the UI's steps prove nothing (§0).
- [ ] Env (`BETTER_AUTH_SECRET` ≥16 chars, `DATABASE_URL`, OAuth secrets, `BREVO_API_KEY`,
      `CLOUDINARY_*`, `DATABASE_CA_CERT_PATH`) is in `.env`, **git-ignored**, Zod-parsed
      (`src/config/index.ts`). Brevo + Cloudinary creds are optional → `NOT_CONFIGURED`.
- [ ] `BETTER_AUTH_URL` = API origin; `FRONTEND_URL` = exact frontend origin.
- [ ] Passwords hashed with **argon2id** (`@node-rs/argon2`) — never stored/returned plaintext.
- [ ] OTPs hashed, expiring, single-use (`verification` table) — don't disable that.
- [ ] Session lives in Better Auth's **httpOnly** cookie, never in `localStorage`.
- [ ] Login errors stay **generic** — never reveal whether an email exists.
- [ ] Body/query shape validated on **your** endpoints before any action; id always from
      `req.user` (session), never the body — a caller can only change themselves.
- [ ] Account created **only** by `/signup/complete` (OTP + password atomic);
      `disableSignUp: true` + passkey `requireSession: true` block orphan creation.
- [ ] **One user = one email**: `UNIQUE(email)` + account linking; `email-password` is
      NOT a trusted linker (must prove email via OTP first — Path C). `updateUserInfoOnLink:
  false` so a link can't overwrite a user-set name/photo. **Original provider can't be
      unlinked** (`hooks.before`).
- [ ] **Handle is server-owned:** `input:false` on the session field (Better Auth can't
      write it); normalization + regex (3–30, `[a-z0-9._-]`) + 2/14-day rate limit +
      reservation logic enforced server-side in one atomic transaction; `UNIQUE(handle)`
      is the race guard. `UNIQUE(handle)` permits NULL until claimed.
- [ ] **Photo is server-validated:** multipart mimetype untrusted — `sharp` decodes to
      prove it's a real image, bounds dimensions (64–8192px), caps decoded pixels
      (decompression bombs), re-encodes to webp + **strips EXIF**. multer 5 MB cap (`413`).
      `imageSource: "user"` locks it against OAuth overwrite.
- [ ] OTP / login / availability endpoints **rate limited** — Express per-IP + per-email on
      `/signup/*`, per-user on `/handles/availability`; Better Auth `rateLimit` on its own
      routes. (Prod: move to a shared store.)
- [ ] Passkey `rpID`/`origin` derive from the **frontend** origin, not the API.
- [ ] CORS names the **exact** frontend origin, never `*`, with `credentials: true`.
- [ ] Better Auth handler mounted **before** `express.json()` (§5c); helmet on; DB pool
      uses verified TLS (CA cert) when `DATABASE_CA_CERT_PATH` is set.
