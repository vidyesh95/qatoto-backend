# AUTH_SETUP.md — Qatoto Backend Auth

Step-by-step setup for the Qatoto auth + identity API. Derived from
[BACKEND_STRUCTURE.md](BACKEND_STRUCTURE.md) — read that for the _why_ and the full
annotated configs; this file is the _how_ (commands + files to stand up signup, login,
logout, session, password reset, OAuth, passkeys, and the identity surface — handle,
display name, profile photo).

**Stack:** Express 5 · TypeScript (`tsx`) · Better Auth · Drizzle ORM · PostgreSQL
(`pg`) · Cloudinary + sharp (avatars). Better Auth owns the security-sensitive work
(argon2id hashing via `@node-rs/argon2`, sessions, httpOnly cookies, OTP, CSRF, OAuth,
WebAuthn/passkeys). You wire its config — you don't roll crypto.

---

## 0. The rule that governs everything

**Frontend is hostile and untrusted. Backend is the only source of truth.** Anyone can
open DevTools and forge any request. So the server re-checks every request itself:

- The 3-step signup UI (email → OTP → password) is **just UX**. The server re-verifies
  the OTP before trusting the email — never assume "step 2 happened". The account is
  created **only** once the OTP is verified **and** a password is set, in one atomic
  server call — verifying an OTP alone never mints an account.
- Never trust a client-sent user id, role, price, quantity, or country. Derive the user
  from the session cookie, never from the request body. Every identity write
  (`PATCH /users/me`, `/users/me/photo`, `/users/me/handle`) takes the id from the
  session — a caller can only change **themselves**.
- The **handle** is server-owned (Better Auth `additionalFields … input:false`); only
  `PATCH /users/me/handle` writes it, behind the rate-limit + reservation transaction.
  The **photo** is server-validated (sharp re-decodes/​re-encodes the bytes, strips EXIF).
- Validate the **shape** of every request body/query on any endpoint **you** write.
  Better Auth validates its own endpoints; your custom routes are your responsibility.

Using a library does not relax this rule — it just means the library does the re-checks
for its own endpoints.

---

## 1. Prerequisites

- **Node ≥ 24** (repo pins `engines.node >= 24.0.0`; uses global `fetch`, `Buffer…base64url`).
- **pnpm** (`packageManager: pnpm@11.8.0`). `npm run <script>` also works for the scripts.
- A terminal in the repo root (`qatoto-backend/`).
- A reachable **PostgreSQL** (this repo targets managed Aiven over TLS — see §5a/§12).

---

## 2. Install dependencies

```bash
# runtime
pnpm add express better-auth @better-auth/passkey @node-rs/argon2 \
  drizzle-orm pg cors helmet cookie-parser dotenv zod \
  cloudinary multer sharp \
  express-rate-limit http-errors morgan debug

# dev tooling: TypeScript, zero-config TS runner, Drizzle CLI, tests, formatter/linter, type defs
pnpm add -D typescript tsx drizzle-kit vitest supertest oxfmt oxlint \
  @types/node @types/express @types/pg @types/cors @types/cookie-parser \
  @types/morgan @types/multer @types/http-errors @types/supertest
```

Pick a Postgres:

```bash
# Option A — Docker (local container, no TLS)
docker run --name qatoto-pg -e POSTGRES_PASSWORD=password \
  -e POSTGRES_DB=qatoto -p 5432:5432 -d postgres:16

# Option B — Managed (Aiven / Neon / RDS / Supabase). Put the connection string in
#            DATABASE_URL (§12). For Aiven-style TLS, also set DATABASE_CA_CERT_PATH.
```

**NOT installed separately** (handled by Better Auth): no `bcrypt` (we use
`@node-rs/argon2` — napi-rs native bindings, faster + stronger than scrypt), no
hand-rolled sessions / OTP / passkey tables (Better Auth owns those — see §6).

---

## 3. package.json scripts

`"type": "module"`, an `imports` map so `#src/*` resolves to TS in dev and JS in prod,
and these scripts:

```jsonc
{
    "type": "module",
    "imports": {
        "#src/*.js": { "development": "./src/*.ts", "default": "./dist/*.js" },
        "#src/*": { "development": "./src/*.ts", "default": "./dist/*.js" },
    },
    "scripts": {
        "dev": "tsx watch --conditions=development src/index.ts",
        "build": "tsc",
        "start": "node dist/index.js",
        "typecheck": "tsc --noEmit && tsc --noEmit -p tsconfig.scripts.json && tsc --noEmit -p tsconfig.test.json",
        "test": "vitest run",
        "db:generate": "drizzle-kit generate", // schema.ts → SQL migration
        "db:migrate": "drizzle-kit migrate", // apply migration
        "db:cleanup-orphans": "tsx --conditions=development scripts/cleanup-orphan-signups.ts",
        "db:cleanup-handle-reservations": "tsx --conditions=development scripts/cleanup-expired-handle-reservations.ts",
        "db:backfill-handles": "tsx --conditions=development scripts/backfill-handles.ts",
        "db:backfill-oauth-profile": "tsx --conditions=development scripts/backfill-oauth-profile.ts",
        "fmt": "oxfmt",
        "lint": "oxlint",
    },
}
```

| Script                           | Does                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| `dev`                            | Auto-restarts on save, runs TS directly via `tsx` — no build step.                   |
| `build`                          | `tsc` → plain JS in `dist/` for deploy.                                              |
| `db:generate`                    | Diffs the **hand-maintained** `src/db/schema.ts` into a SQL migration (drizzle-kit). |
| `db:migrate`                     | Applies pending migrations to Postgres.                                              |
| `db:backfill-*` / `db:cleanup-*` | One-off / cron maintenance scripts — see §11 and BACKEND_STRUCTURE §5g.              |

> **Changed from the old flow:** the schema is **not** generated from `auth.ts` by the
> Better Auth CLI anymore. `src/db/schema.ts` is committed and edited by hand; `db:generate`
> only turns it into SQL. See §6.

Then create `tsconfig.json` (+ `tsconfig.scripts.json`, `tsconfig.test.json`),
`drizzle.config.ts`, and `.env` (§12).

---

## 4. Folder structure

```text
qatoto-backend/
├── src/
│   ├── index.ts                       # loads env, starts the HTTP server (app.listen)
│   ├── app.ts                         # builds the Express app: helmet, cors, Better Auth mount, routers
│   ├── config/index.ts                # Zod-parsed env (THROWS on missing required vars — fail-fast boot)
│   ├── lib/
│   │   ├── auth.ts                     # the Better Auth instance (adapter, email+pw, OTP, OAuth, passkey, anonymous, hooks)
│   │   ├── email.ts                    # Brevo transactional email
│   │   ├── cloudinary.ts               # avatar upload/delete
│   │   └── image.ts                    # sharp avatar validation + normalization
│   ├── db/
│   │   ├── index.ts                    # Postgres pool (SSL/CA, keepAlive) + Drizzle + query() helper
│   │   └── schema.ts                   # COMMITTED schema: user/session/account/verification/passkey/handle_reservations
│   ├── controllers/                    # auth.controller, users.controller, handle.controller
│   ├── middleware/                     # require-auth, rate-limit, upload-avatar, validate, request-id, error-handler, not-found
│   ├── routes/                         # index (/,/health), auth.routes, users.routes, handles.routes
│   ├── services/                       # users.service, handle.service
│   └── types/                          # express.d.ts (req.user) + index.ts (Result, ApiResponse)
├── scripts/                            # cleanup-orphan-signups, cleanup-expired-handle-reservations, backfill-handles, backfill-oauth-profile
├── drizzle.config.ts
├── tsconfig.json  tsconfig.scripts.json  tsconfig.test.json
├── .env                                # NEVER commit
└── package.json
```

> This is the real, nested layout. The old flat `src/auth.ts` / `src/db.ts` /
> `src/auth-schema.ts` from earlier drafts no longer exists.

---

## 5. Wire the files

### 5a. `src/db/index.ts` — the database

Env is read through the Zod-parsed `config` (not `process.env` directly). The pool is
hardened for a managed remote Postgres: explicit TLS via a CA cert, short idle recycling,
TCP keepalives.

```ts
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "#src/config/index.js";
import * as schema from "#src/db/schema.js";

const ssl = config.DATABASE_CA_CERT_PATH
    ? { rejectUnauthorized: true, ca: readFileSync(config.DATABASE_CA_CERT_PATH).toString() }
    : undefined;

// When we supply our own CA, strip `sslmode` from the URL — pg-connection-string treats
// `sslmode=require` as verify-full and would override our `ssl` object (SELF_SIGNED_CERT_IN_CHAIN).
const connectionString = ssl
    ? config.DATABASE_URL.replace(/([?&])sslmode=[^&]*&?/, "$1").replace(/[?&]$/, "")
    : config.DATABASE_URL;

export const pool = new Pool({
    connectionString,
    ssl,
    max: 20,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
    keepAlive: true,
});
export const db = drizzle(pool, { schema });
pool.on("error", (err) => console.error("Unexpected error on idle database client", err));
```

> A `Pool` reuses open connections instead of dialing a fresh one per request. The driver
> import here + `provider: "pg"` in `auth.ts` are the only Postgres-specific lines.

### 5b. `src/lib/auth.ts` — the Better Auth instance

The live instance enables email+password, email-OTP, Google/GitHub OAuth, passkeys, and
anonymous sessions, plus identity hooks. Condensed shape below — see
**BACKEND_STRUCTURE §5a** for the fully annotated version.

```ts
import { passkey } from "@better-auth/passkey";
import { hash, verify } from "@node-rs/argon2";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { anonymous, emailOTP } from "better-auth/plugins";
import { config } from "#src/config/index.js";
import { db } from "#src/db/index.js";
import { assignPlaceholderHandle } from "#src/services/handle.service.js";

export const auth = betterAuth({
    database: drizzleAdapter(db, { provider: "pg" }),
    secret: config.BETTER_AUTH_SECRET,
    baseURL: config.BETTER_AUTH_URL,
    trustedOrigins: [config.FRONTEND_URL],

    // handle exposed read-only on the session; input:false → never client-writable here.
    user: { additionalFields: { handle: { type: "string", required: false, input: false } } },

    // Guards Better Auth's OWN endpoints (NOT our /signup/* auth.api calls — see §11).
    rateLimit: {
        enabled: true,
        window: 60,
        max: 100,
        customRules: {/* see BACKEND_STRUCTURE §5a */},
    },

    // On every new user: stamp imageSource if OAuth seeded an image, then seed a placeholder handle.
    databaseHooks: {
        user: {
            create: {
                after: async (u) => {
                    if (u.image) {
                        /* set imageSource = "oauth" */
                    }
                    await assignPlaceholderHandle(u.id, u.name, u.email); // failure logged, not fatal
                },
            },
        },
    },

    // One user = one email. google/github trusted; email-password NOT (must prove via OTP).
    // allowDifferentEmails:true → a signed-in user may link a trusted provider on a DIFFERENT
    // email and stay one user (session is the trust anchor; never auto-merges at sign-in).
    // updateUserInfoOnLink:false → a link never overwrites a user-set name/photo.
    account: {
        accountLinking: {
            enabled: true,
            trustedProviders: ["google", "github"],
            allowDifferentEmails: true,
            updateUserInfoOnLink: false,
        },
    },

    // hooks.before guard forbids unlinking the ORIGINAL (earliest-created) provider. (§7a)
    hooks: {/* before: createAuthMiddleware(... /unlink-account ...) */},

    emailAndPassword: {
        enabled: true,
        minPasswordLength: 8,
        password: { hash: (p) => hash(p), verify: ({ hash: h, password }) => verify(h, password) },
    },
    socialProviders: {
        google: { clientId: config.GOOGLE_CLIENT_ID, clientSecret: config.GOOGLE_CLIENT_SECRET },
        github: { clientId: config.GITHUB_CLIENT_ID, clientSecret: config.GITHUB_CLIENT_SECRET },
    },
    plugins: [
        anonymous(),
        passkey({
            rpID: new URL(config.FRONTEND_URL).hostname,
            rpName: "Qatoto",
            origin: new URL(config.FRONTEND_URL).origin,
            registration: { requireSession: true, extensions: { credProps: true } }, // no passkey-first onboarding
            authentication: { extensions: { credProps: true } },
        }),
        emailOTP({
            disableSignUp: true, // OTP alone NEVER creates a user
            async sendVerificationOTP({ email, otp, type }) {
                if (config.NODE_ENV === "development")
                    console.log(`OTP for ${email} (${type}): ${otp}`);
                // ...send via Brevo (src/lib/email.ts); NOT_CONFIGURED tolerated in dev, else throw.
            },
        }),
    ],
});
```

### 5c. `src/app.ts` + `src/index.ts` — mount on Express

**Order matters.** Better Auth mounts **before** `express.json()` — it parses its own
request bodies off the raw stream. (Avatar uploads are multipart, parsed by `multer`
inside the `/users/me/photo` route, so the global JSON parser never touches them either.)

```ts
import { toNodeHandler } from "better-auth/node";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import logger from "morgan";
import { config } from "#src/config/index.js";
import { auth } from "#src/lib/auth.js";
// ... requestId, error/not-found handlers, routers ...

const app = express();
app.set("trust proxy", 1); // behind nginx / LB
app.use(helmet());
app.use(cors({ origin: config.FRONTEND_URL, credentials: true })); // exact origin, allow cookies
app.use(requestId);
app.use(logger("dev"));

// Better Auth catch-all — BEFORE express.json(). NOTE: toNodeHandler(auth.handler).
app.all("/api/auth/*splat", toNodeHandler(auth.handler));

app.use(express.json({ limit: "10kb" })); // YOUR routes only
app.use(express.urlencoded({ extended: false, limit: "10kb" }));
app.use(cookieParser());

app.use("/", indexRouter); // /, /health
app.use("/", authRouter); // /signup/start, /signup/complete, /me
app.use("/users", usersRouter); // PATCH /users/me, /users/me/photo, /users/me/handle, ...
app.use("/handles", handlesRouter); // /handles/availability

app.use(notFoundHandler);
app.use(errorHandler);
export default app;
```

`src/index.ts` loads env, then `app.listen(config.PORT)`.

Sanity check: `GET http://localhost:8000/health` → `{ status: "success", ... }`.

---

## 6. The schema + migrate

You **do** maintain the schema by hand — it lives committed in `src/db/schema.ts` (not
CLI-generated from `auth.ts` anymore). Edit it, then:

```bash
pnpm db:generate   # drizzle-kit diffs schema.ts → a SQL migration file
pnpm db:migrate    # applies pending migrations to Postgres
```

Tables (auth-owned + the identity columns/table we own):

| Table                 | Holds                                                                                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user`                | id, email (**UNIQUE**), name, emailVerified, `image`, `imageSource`, **`handle` (UNIQUE)**, name/handle bookkeeping, timestamps. **No raw password here.** |
| `account`             | the argon2id password hash (credential rows) + OAuth tokens; one row per provider, same `userId`.                                                          |
| `session`             | one row per logged-in session — the cookie holds only an opaque reference.                                                                                 |
| `verification`        | short-lived OTP records — hashed, expiring, single-use.                                                                                                    |
| `passkey`             | WebAuthn credentials keyed to a user.                                                                                                                      |
| `handle_reservations` | a previously-held handle parked 14 days (revert window). See BACKEND_STRUCTURE §5g.                                                                        |

> **Migrations gotcha (TLS):** `drizzle-kit migrate` does **not** read the app pool. With
> a CA-cert managed DB it can fail **silently** if you hand it the CA-cert connection URL.
> In `drizzle.config.ts`, use **discrete** credentials (`host`/`port`/`user`/`password`/
> `database` + `ssl`), not the `url`. Re-run `db:generate` + `db:migrate` after any schema change.

---

## 7. The endpoints

### 7a. Free, from Better Auth (under `/api/auth`)

You don't write these — the §5b config creates them.

| Method & path                                    | Body                              | Purpose                                                                                           |
| ------------------------------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------- |
| `POST /api/auth/email-otp/send-verification-otp` | `{ email, type }`                 | Generate + send a 6-digit OTP. `type`: `"sign-in"`, `"email-verification"`, `"forget-password"`.  |
| `POST /api/auth/sign-in/email-otp`               | `{ email, otp }`                  | OTP login for **existing** users. `disableSignUp: true` → never creates a user (no orphans).      |
| `POST /api/auth/email-otp/reset-password`        | `{ email, otp, password }`        | Forgot-password: verify a `forget-password` OTP, set the new password.                            |
| `POST /api/auth/sign-in/email`                   | `{ email, password, rememberMe }` | Password login. `rememberMe` controls cookie lifetime. Wrong email/password → same generic error. |
| `GET  /api/auth/sign-in/social` (+ callback)     | provider redirect                 | Google / GitHub OAuth. Verified-email match → links onto the existing user (one account).         |
| `POST /api/auth/passkey/*`                       | WebAuthn ceremony                 | Register / authenticate passkeys. Registration requires an existing session.                      |
| `POST /api/auth/sign-in/anonymous`               | —                                 | Guest session (anonymous plugin), upgradable later.                                               |
| `POST /api/auth/unlink-account`                  | `{ providerId, accountId? }`      | Unlink a provider — but a `hooks.before` guard **forbids unlinking the original provider** (403). |
| `POST /api/auth/sign-out`                        | — (reads cookie)                  | Ends the session, clears the cookie.                                                              |
| `GET  /api/auth/get-session`                     | — (reads cookie)                  | The real "am I logged in?" check. Returns session + user (incl. `handle`), or null.               |

### 7b. The signup endpoints YOU write — `src/controllers/auth.controller.ts`

Account creation is deferred to the very end so a half-finished signup never leaves a
row. Both public; bodies validated with Zod `.strict()` (`422` on failure).

| Method & path           | Body                              | Creates a user?                                                    |
| ----------------------- | --------------------------------- | ------------------------------------------------------------------ |
| `POST /signup/start`    | `{ email }`                       | No — just sends the OTP. Generic 200 (no email-exists probe).      |
| `POST /signup/complete` | `{ email, otp, password, name? }` | Resolves to exactly **one** user via three paths (below).          |
| `GET  /me`              | — (session cookie)                | Returns `req.user` (`{ id, email, name, emailVerified, handle }`). |

`/signup/complete` looks up the email and takes one path:

```text
├─ Path A — no user yet:   checkVerificationOTP → signUpEmail → mark emailVerified → session   → 201
│            (the create hook also seeds a placeholder handle + stamps imageSource)
│            bad/expired OTP → 401, nothing created;  missing password → 422 at the boundary.
├─ Path B — user has a `credential` account already:  re-signup → 409 ("sign in instead").
└─ Path C — user is OAuth-only:  signInEmailOTP (proves ownership + mints session)
             → setPassword (session-scoped) attaches the password to the SAME user        → 201 linked
```

Path C is what makes "signed up with Google, later set a password" collapse into one
account. There is no verified-but-passwordless state — `disableSignUp:true` + passkey
`requireSession:true` + password-in-the-same-call block every orphan path.

### 7c. Identity endpoints YOU write — profile + handle

Session-guarded (`requireAuth`); the id comes from the session, never the body. Full
detail in **BACKEND_STRUCTURE §5f (profile/photo)** and **§5g (handle)**.

| Method & path                  | Input                          | Purpose                                                                                 |
| ------------------------------ | ------------------------------ | --------------------------------------------------------------------------------------- |
| `PATCH  /users/me`             | `{ fullName }`                 | Set display name (`nameSetByUser` lock vs OAuth overwrite).                             |
| `PATCH  /users/me/photo`       | `multipart`, field **`photo`** | multer (5 MB) → sharp validate/normalize → Cloudinary → `image` + `imageSource:"user"`. |
| `DELETE /users/me/photo`       | —                              | Remove the Cloudinary asset, clear `image`/`imageSource`.                               |
| `GET    /users/me/handle`      | — (session)                    | Panel bootstrap: handle + rate-limit + revert metadata.                                 |
| `PATCH  /users/me/handle`      | `{ handle }`                   | Authoritative set/revert in one atomic transaction (2 changes / 14 days).               |
| `GET    /handles/availability` | `?handle=<raw>`                | Tier-1 live availability probe (rate-limited 60/min/user).                              |

---

## 8. Sessions, cookies, protecting your routes

Better Auth sets the session cookie on login / OTP signup / OAuth / passkey / password
reset — httpOnly, `secure` in production, `sameSite: "lax"`, signed, expiry it manages.
`rememberMe` extends lifetime. You don't write `res.cookie(...)`. The session **user**
also carries `handle` (via `additionalFields`).

For **your own** protected routes, ask Better Auth who the user is —
`src/middleware/require-auth.ts`:

```ts
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "#src/lib/auth.js";

export async function requireAuth(req, res, next) {
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

Teach TS about `req.user` — `src/types/express.d.ts` (ambient, no top-level import/export
so it merges into the global Express namespace):

```ts
declare namespace Express {
    interface Request {
        user?: {
            readonly id: string;
            readonly email: string;
            readonly name: string;
            readonly emailVerified: boolean;
            readonly handle: string | null;
        };
    }
}
```

**Why a cookie and not `localStorage`?** Any malicious script can read `localStorage`
(XSS) and steal the session. Better Auth uses an **httpOnly** cookie — invisible to page
JS; the browser attaches it automatically.

---

## 9. How a request flows (signup, end to end)

```text
1. UI step 1 (enter email):
   POST /signup/start { email }
   → forwards to send-verification-otp; stores a hashed, expiring OTP; sends email
     (dev also console.log("OTP for a@b.com (sign-in): 482913")). NO user created.

2. UI step 2 (OTP) + step 3 (password) — on final submit, ONE call:
   POST /signup/complete { email, otp, password }   (your endpoint, §7b)
   → verifies the OTP, CREATES the user (emailVerified=true) WITH the password atomically,
     the create hook seeds a placeholder handle, and the session cookie is set.
     Bad OTP or no password → no user.

3. Frontend: useSession() → navbar shows logged-in state (incl. session.user.handle).
```

- **Login:** `POST /api/auth/sign-in/email { email, password, rememberMe }`.
- **OAuth:** `sign-in/social` (Google/GitHub) — verified-email match links onto the
  existing user; a link never overwrites a user-set name/photo. `allowDifferentEmails:
true` also lets a **signed-in** user link a trusted provider on a different email
  (session is the trust anchor — no sessionless auto-merge).
- **Forgot password:** `send-verification-otp { email, type: "forget-password" }` →
  `email-otp/reset-password { email, otp, password }`. No custom endpoint needed.
- **Identity:** `PATCH /users/me` (name), `PATCH`/`DELETE /users/me/photo`, handle via
  `GET /handles/availability` → `PATCH /users/me/handle`.

---

## 10. Connecting the frontend (CORS + client)

Frontend on `http://localhost:3000`, API on `http://localhost:8000` → different origin,
so the server must opt in.

- **CORS** (server): name the exact origin (`config.FRONTEND_URL`, not `*`), allow
  credentials — set in §5c.
- **`sameSite: "lax"`** lets the cookie ride along on `localhost → localhost` in dev. In
  prod, put the API on a subdomain (`api.qatoto.com`) to stay same-site with `qatoto.com`.

### Frontend — the Better Auth React client

Add `passkeyClient` and `inferAdditionalFields` so the client type includes
`session.user.handle`:

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
const { data: session } = useSession(); // session.user.handle available
await signIn.email({ email, password, rememberMe }); // login
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

// Identity (all need credentials: "include")
await fetch("http://localhost:8000/users/me", {
    method: "PATCH",
    credentials: "include" /* {fullName} */,
});
await fetch("http://localhost:8000/users/me/handle", {
    method: "PATCH",
    credentials: "include" /* {handle} */,
});
const form = new FormData();
form.append("photo", file); // DO NOT set Content-Type — browser sets the boundary
await fetch("http://localhost:8000/users/me/photo", {
    method: "PATCH",
    body: form,
    credentials: "include",
});

// Forgot password
await authClient.emailOtp.sendVerificationOtp({ email, type: "forget-password" });
await authClient.emailOtp.resetPassword({ email, otp, password });

await signOut();
```

---

## 11. Build order

Each step is a small, runnable win.

0. **Check tools.** Node ≥ 24, pnpm.
1. **Hello server.** Install Express + `tsx`, trivial `/health` route, run, open it.
2. **Database + Drizzle.** Start Postgres, add `pg` + `drizzle-orm`, write `db/index.ts`,
   `drizzle.config.ts`, and `db/schema.ts`.
3. **Better Auth, email+password.** Write `lib/auth.ts`, mount in `app.ts` (§5c), run
   `db:generate` + `db:migrate`, hit `/health` + `/api/auth/get-session`.
4. **Password login + session.** Test `sign-in/email`, then `requireAuth` (§8) on a route.
5. **OTP plugin + OTP-gated signup.** `/signup/start` → `/signup/complete` (the only
   user-creating path). `disableSignUp: true`.
6. **Logout + forgot-password.** `sign-out`; then `send-verification-otp`
   (`forget-password`) and `email-otp/reset-password`.

### Already done (live in the repo)

- **OAuth** (Google + GitHub) with account linking; original provider can't be unlinked.
- **Passkeys** (`@better-auth/passkey`, `requireSession`).
- **Anonymous** guest sessions.
- **Real email** via Brevo (`src/lib/email.ts`); dev still console.log's the OTP.
- **Rate limiting** (below).
- **Identity:** display name (`PATCH /users/me`), profile photo (multer → sharp →
  Cloudinary), handles (placeholder seeding, availability + atomic set/revert, 2/14-day
  limit, 14-day revert reservations + daily cron). See BACKEND_STRUCTURE §5f/§5g.
- **Maintenance scripts:** `db:cleanup-orphans`, `db:cleanup-handle-reservations`,
  `db:backfill-handles`, `db:backfill-oauth-profile`.

### Later (explicitly NOT now)

- **Shared rate-limit store for prod.** Both limiters are **in-memory** (per-process).
  Multi-instance / serverless lets attackers round-robin instances → move to a shared
  store: Express limiters → `rate-limit-redis`; Better Auth → `rateLimit.storage:
"database"` (adds a `rateLimit` table) or `"secondary-storage"`.
- **Lock down `GET /users` / `GET /users/:id`** — currently public list/read endpoints.

### Already done: OTP / auth rate limiting

Two layers (Better Auth's limiter does **not** cover `auth.api` server-side calls):

- **Express limiters** ([src/middleware/rate-limit.ts](../src/middleware/rate-limit.ts)):
  `/signup/start` per-IP (8/15min) + per-email (4/15min); `/signup/complete` per-IP
  (12/15min); `/handles/availability` per-user (60/min).
- **Better Auth `rateLimit`** ([src/lib/auth.ts](../src/lib/auth.ts)):
  `send-verification-otp` 3/60s, `sign-in/email-otp` 5/60s, `reset-password` 5/60s,
  `sign-in/email` 5/10s. Enabled in all envs (BA defaults to prod-only).

---

## 12. .env

Env is Zod-parsed in `src/config/index.ts` and **`config = envSchema.parse(process.env)`
THROWS at boot** if a required var is missing — including the OAuth secrets. So you can't
boot without `GOOGLE_*` / `GITHUB_*` set, even if you don't use OAuth yet (use throwaway
values to get the server up).

```bash
# Required
BETTER_AUTH_SECRET=<long random string, ≥16 chars>
BETTER_AUTH_URL=http://localhost:8000          # the API origin
FRONTEND_URL=http://localhost:3000             # exact frontend origin (CORS + passkey rpID/origin)
DATABASE_URL=postgresql://postgres:password@localhost:5432/qatoto
GOOGLE_CLIENT_ID=...                           # required at boot (throwaway ok in dev)
GOOGLE_CLIENT_SECRET=...
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...

# Optional
DATABASE_CA_CERT_PATH=/path/to/ca.pem          # set for Aiven-style TLS (see §5a/§6)
BREVO_API_KEY=...                              # absent → email NOT_CONFIGURED (dev: OTP still logged)
BREVO_SENDER_EMAIL=no-reply@qatoto.com
BREVO_SENDER_NAME=Qatoto                        # defaults to "Qatoto"
CLOUDINARY_CLOUD_NAME=...                       # absent → photo endpoints return NOT_CONFIGURED
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...
# PORT=8000   NODE_ENV=development              # have defaults
```

All of `.env` is **git-ignored**.

---

## 13. Security checklist (pin above your desk)

Better Auth handles most by default — your job: don't undo them, set config/env right.

- [ ] Server re-validates **every** request — the UI's steps prove nothing (§0).
- [ ] All secrets (`BETTER_AUTH_SECRET` ≥16, `DATABASE_URL`, OAuth, `BREVO_API_KEY`,
      `CLOUDINARY_*`) in `.env`, **git-ignored**, Zod-parsed (boot fails fast if missing).
- [ ] `BETTER_AUTH_URL` = API origin; `FRONTEND_URL` = exact frontend origin.
- [ ] Passwords hashed with **argon2id** (`@node-rs/argon2`) — never stored/returned plaintext.
- [ ] OTPs hashed, expiring, single-use (`verification` table) — don't disable that.
- [ ] Session in Better Auth's **httpOnly** cookie, never `localStorage`.
- [ ] Login errors stay **generic** — don't reveal whether the email exists.
- [ ] Body/query shape validated on **your** endpoints before any action; id from the
      session (`req.user`), never the body — a caller can only change themselves.
- [ ] Account created **only** by `/signup/complete` (OTP + password atomic);
      `disableSignUp: true` + passkey `requireSession: true` block orphans.
- [ ] **One user = one email:** `UNIQUE(email)` + account linking; `email-password` NOT a
      trusted linker (prove email via OTP — Path C). `updateUserInfoOnLink:false`;
      `allowDifferentEmails:true` (signed-in different-email link, trustedProviders only, no
      sessionless auto-merge); original provider can't be unlinked.
- [ ] **Handle server-owned** (`input:false`); normalization + regex + 2/14-day limit +
      reservations enforced server-side; `UNIQUE(handle)` is the race guard.
- [ ] **Photo server-validated** (sharp re-decode/re-encode, strip EXIF, bound dimensions,
      decompression-bomb cap); multer 5 MB cap; `imageSource:"user"` locks vs OAuth.
- [ ] OTP / login / availability endpoints **rate limited** (Express + Better Auth). Prod:
      shared store.
- [ ] Passkey `rpID`/`origin` from the **frontend** origin, not the API.
- [ ] CORS names the **exact** frontend origin, never `*`, with `credentials: true`.
- [ ] Better Auth handler mounted **before** `express.json()` (§5c); helmet on; DB pool
      uses verified TLS (CA cert) when `DATABASE_CA_CERT_PATH` is set.
