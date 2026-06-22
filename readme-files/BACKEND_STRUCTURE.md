# BACKEND_STRUCTURE.md — Qatoto Auth API

> This document describes the auth contract the Next.js + TanStack Query frontend
> depends on, and how it is wired on the server.
>
> **Goal:** working auth — OTP-gated signup, password login, OAuth (Google/GitHub),
> passkeys, logout, session, password reset — with **one user per email** (providers
> link onto the same account instead of duplicating it).
> **Stack:** **Better Auth** (auth engine) + **Drizzle ORM** (DB layer) +
> **PostgreSQL**. Better Auth does the security-sensitive work — argon2id password
> hashing, sessions, cookies, OTP, CSRF, WebAuthn/passkeys — so we don't hand-roll
> crypto. We own its config, our `/signup/*` endpoints, and our route guards.

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
  derives the user from the **session cookie**, never from the request body.
- Validate the **shape** of every request body on any endpoint **you** write (Zod
  `.safeParse()`, `422` on failure). Better Auth validates its own endpoints; your
  custom routes are your responsibility.

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

The real answer to "is this user logged in?" comes from Better Auth's session
(`GET /api/auth/get-session`, or the `useSession()` hook — see §8). `localStorage` is
the wrong place for a real session — see §7.

**One user = one email.** A person who first signs in with Google and later adds a
password (or vice-versa) ends up as **one** account, not two — Better Auth's account
linking attaches the new provider onto the existing user. See §5e / §6.

---

## 2. The stack

| Concern          | Pick                           | Why this one                                                                                  |
| ---------------- | ------------------------------ | --------------------------------------------------------------------------------------------- |
| Server framework | **Express 5**                  | Minimal, huge community. Run with `tsx` (no build step in dev).                               |
| Language         | **TypeScript** (strict)        | Same language as the frontend — shared types, fewer bugs.                                     |
| Auth engine      | **Better Auth** (`^1.6`)       | Password hashing, sessions, cookies, OTP, CSRF, OAuth, WebAuthn. Don't roll your own crypto.  |
| Database ORM     | **Drizzle ORM**                | Type-safe queries + migrations. The auth tables live in `src/db/schema.ts`.                   |
| Database         | **PostgreSQL** via `pg`        | Strict types, same engine as prod. `UNIQUE(email)` enforces one-user-per-email at the DB.     |
| Passkeys         | **`@better-auth/passkey`**     | WebAuthn relying-party + ceremony handling.                                                   |
| OTP / OAuth      | **`emailOTP` + social config** | OTP for signup/reset; Google + GitHub OAuth.                                                  |
| Anonymous        | **`anonymous` plugin**         | Pre-auth guest sessions that can later upgrade to a real account.                             |
| Email delivery   | **Brevo** (`src/lib/email.ts`) | Real transactional email. In dev the OTP is **also** `console.log`'d so you can test offline. |
| Security headers | **helmet**                     | Sensible default response headers.                                                            |
| Cookies          | **cookie-parser**              | Parses cookies for your own routes (Better Auth reads/writes its own signed cookies).         |
| CORS             | **cors**                       | Lets the browser on the frontend origin call the API, with credentials.                       |

**Still NOT hand-rolled:** no `bcrypt` (argon2id via `@node-rs/argon2`), no hand-written
sessions / OTP / passkey tables (Better Auth owns those — see §4).

Runtime deps (from `package.json`):

```bash
express better-auth @better-auth/passkey @node-rs/argon2 \
  drizzle-orm pg cors helmet cookie-parser dotenv \
  express-rate-limit http-errors morgan debug
```

`package.json` (`"type": "module"`) scripts that matter:

```jsonc
{
    "scripts": {
        "dev": "tsx watch --conditions=development src/index.ts", // auto-restart, TS direct
        "build": "tsc",
        "start": "node dist/index.js",
        "db:generate": "drizzle-kit generate", // schema → SQL migration
        "db:migrate": "drizzle-kit migrate", // apply migration
        "db:cleanup-orphans": "tsx --conditions=development scripts/cleanup-orphan-signups.ts",
        "typecheck": "tsc --noEmit && tsc --noEmit -p tsconfig.scripts.json && tsc --noEmit -p tsconfig.test.json",
        "test": "vitest run",
    },
}
```

> Schema note: the Drizzle tables in `src/db/schema.ts` are committed to the repo (not
> regenerated from auth config on every change). When you add/remove a Better Auth plugin
> that needs columns, update `schema.ts` and run `db:generate` + `db:migrate`.

---

## 3. Folder structure

```text
qatoto-backend/
├── src/
│   ├── index.ts                       # loads env, starts the HTTP server
│   ├── app.ts                         # builds the Express app: helmet, cors, Better Auth mount, routes
│   ├── config/index.ts                # Zod-parsed env (DATABASE_URL, BETTER_AUTH_*, OAuth, Brevo...)
│   ├── lib/
│   │   ├── auth.ts                     # the Better Auth instance (adapter, email+pw, OTP, OAuth, passkey, anonymous)
│   │   └── email.ts                    # Brevo transactional email (Result-typed)
│   ├── db/
│   │   ├── index.ts                    # Postgres pool + Drizzle
│   │   └── schema.ts                   # user / session / account / verification / passkey tables
│   ├── controllers/auth.controller.ts  # /signup/start, /signup/complete, /me handlers
│   ├── middleware/
│   │   ├── require-auth.ts             # session guard for YOUR routes → req.user
│   │   ├── rate-limit.ts               # Express limiters on /signup/*
│   │   ├── validate.ts, request-id.ts, error-handler.ts, not-found.ts
│   ├── routes/
│   │   ├── index.ts                    # / and /health
│   │   ├── auth.routes.ts              # /signup/start, /signup/complete, /me
│   │   └── users.routes.ts
│   ├── services/  types/
├── scripts/cleanup-orphan-signups.ts  # one-time orphan cleanup (see §5e)
├── drizzle.config.ts
└── .env                               # NEVER commit
```

---

## 4. The data (Better Auth owns the schema)

Tables in `src/db/schema.ts`:

| Table          | What it holds                                                                                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user`         | id, name, **`email` (UNIQUE)**, emailVerified, image, `isAnonymous`, timestamps. **No raw password here.**                                                                                                                                        |
| `account`      | one row **per provider** for a user: `providerId` (`credential` / `google` / `github`), the argon2id `password` hash for credential rows, OAuth tokens for the rest. Account linking = multiple `account` rows pointing at the **same** `userId`. |
| `session`      | one row per logged-in session — the cookie holds only an opaque token; everything else stays server-side.                                                                                                                                         |
| `verification` | short-lived OTP / verification records (hashed, expiring, single-use).                                                                                                                                                                            |
| `passkey`      | WebAuthn credentials (publicKey, counter, deviceType, transports…) keyed to a user.                                                                                                                                                               |

The `UNIQUE(email)` on `user` is the structural guarantee behind "one user = one email":
a second provider reporting the same verified email links onto the existing row rather
than inserting a duplicate.

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
import { anonymous, emailOTP } from "better-auth/plugins";
import { config } from "#src/config/index.js";
import { db } from "#src/db/index.js";
import { sendTransactionalEmail } from "#src/lib/email.js";

export const auth = betterAuth({
    database: drizzleAdapter(db, { provider: "pg" }),
    secret: config.BETTER_AUTH_SECRET,
    baseURL: config.BETTER_AUTH_URL,
    trustedOrigins: [config.FRONTEND_URL],

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

    // One user = one email. A provider reporting a VERIFIED matching email links onto
    // the existing user instead of minting a second row. google/github are trusted
    // (first-party OAuth). "email-password" is deliberately NOT trusted — a credential
    // signup must prove the email via OTP (our /signup/complete) before it can ride onto
    // an existing OAuth account, else account-takeover via unverified password signup.
    account: {
        accountLinking: { enabled: true, trustedProviders: ["google", "github"] },
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

```ts
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "#src/db/schema.js";
import { config } from "#src/config/index.js";

const pool = new Pool({ connectionString: config.DATABASE_URL });
export const db = drizzle(pool, { schema });
```

> A `Pool` reuses open connections instead of dialing a fresh one per request. The
> driver import + `provider: "pg"` in `auth.ts` are the only Postgres-specific lines.

### 5c. Mounting on Express — `src/app.ts`

**Order matters.** The Better Auth handler mounts **before** `express.json()`, because
it parses its own request bodies off the raw stream. A body parser ahead of it consumes
the stream and breaks every auth POST.

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
app.use("/users", usersRouter);

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
| `POST /api/auth/sign-out`                        | — (reads cookie)                  | Ends the session, clears the cookie.                                                             |
| `GET  /api/auth/get-session`                     | — (reads cookie)                  | The real "am I logged in?" check. Returns session + user, or null.                               |

### 5e. The two endpoints YOU write — `src/controllers/auth.controller.ts`

OTP-gated signup, account created at the end so a half-finished signup leaves no row.
Both are **public** (no session yet) and validated with Zod `.strict()` (`422` on failure).

| Method & path           | Body                              | Creates a user?                                                   |
| ----------------------- | --------------------------------- | ----------------------------------------------------------------- |
| `POST /signup/start`    | `{ email }`                       | No — sends the OTP. Generic 200 (can't probe which emails exist). |
| `POST /signup/complete` | `{ email, otp, password, name? }` | Resolves to exactly **one** user via three paths (below).         |
| `GET  /me`              | — (session cookie)                | Returns `req.user` (requires auth).                               |

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
   → Path A creates the user (emailVerified = true) WITH the password atomically and
     sets the httpOnly session cookie. Bad OTP → 401, no user; missing password → 422.

3. Frontend: useSession() → navbar shows logged-in state.
```

If the user bails before the final call, no account exists — nothing to recover.

**Login:** `POST /api/auth/sign-in/email { email, password, rememberMe }`.

**OAuth:** `sign-in/social` (Google/GitHub). If the verified email already exists, the
provider links onto that user — **one** account, not a duplicate (§5a `accountLinking`).

**Add a password to an OAuth-only account:** run `/signup/complete` for that email →
**Path C** attaches the credential to the same user.

**Passkey:** register only while signed in (`requireSession: true`); authenticate via
`passkey/*`.

**Forgot password:** step 1 → `send-verification-otp { email, type: "forget-password" }`;
final → `email-otp/reset-password { email, otp, password }`. No custom endpoint.

---

## 7. Sessions & cookies

On login, OTP signup, OAuth, passkey, or password reset, **Better Auth sets the session
cookie** — httpOnly, `secure` in production, `sameSite: "lax"`, signed, server-managed
expiry. `rememberMe` extends lifetime. You don't write `res.cookie(...)` or generate
session ids.

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
    };
    next();
}
```

`req.user` is declared via a global Express augmentation (`src/types`). Zero-trust: the
session is re-derived server-side on every request — the frontend cannot assert identity.

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

Frontend client (typed, sends cookies automatically):

```ts
// src/lib/auth-client.ts (frontend)
import { createAuthClient } from "better-auth/react";
import { emailOTPClient } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";

export const authClient = createAuthClient({
    baseURL: "http://localhost:8000",
    plugins: [emailOTPClient(), passkeyClient()],
});
export const { useSession, signIn, signOut } = authClient;
```

```ts
const { data: session } = useSession(); // "am I logged in?"
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
3. **OAuth** (Google + GitHub) with account linking (one user = one email).
4. **Passkeys** (`@better-auth/passkey`, `requireSession`).
5. **Anonymous** guest sessions.
6. **Real email** via Brevo (`src/lib/email.ts`); dev still console.log's the OTP.
7. **Rate limiting** (below).

### Later (NOT now)

- Managed Postgres + pooling for prod (Neon, RDS, Supabase).
- **Shared rate-limit store for prod.** Both limiters are **in-memory** (per-process).
  Multi-instance/serverless lets attackers round-robin instances → move to a shared
  store: Express limiters → `rate-limit-redis`; Better Auth → `rateLimit.storage:
"database"` (adds a `rateLimit` table) or `"secondary-storage"`.

### Rate limiting (done)

Two layers (Better Auth's limiter does **not** cover server-side `auth.api` calls, so the
custom routes need their own):

- **Express limiters** (`src/middleware/rate-limit.ts`): `/signup/start` capped
  **per-IP** and **per-email** (stops OTP spam + inbox-bombing); `/signup/complete`
  capped **per-IP**. 429 returns the standard ApiResponse envelope with `retryAfterSeconds`.
- **Better Auth `rateLimit`** (`src/lib/auth.ts`): `send-verification-otp` 3/60s,
  `sign-in/email-otp` 5/60s, `reset-password` 5/60s, `sign-in/email` 5/10s. Enabled in
  all envs.

---

## 10. Security checklist

- [ ] Server re-validates **every** request — the UI's steps prove nothing (§0).
- [ ] `BETTER_AUTH_SECRET` (≥16 chars), `DATABASE_URL`, OAuth secrets, `BREVO_API_KEY`
      are in `.env` and **git-ignored**. Env is Zod-parsed (`src/config/index.ts`).
- [ ] `BETTER_AUTH_URL` = API origin; `FRONTEND_URL` = exact frontend origin.
- [ ] Passwords hashed with **argon2id** (`@node-rs/argon2`) — never stored/returned plaintext.
- [ ] OTPs hashed, expiring, single-use (`verification` table) — don't disable that.
- [ ] Session lives in Better Auth's **httpOnly** cookie, never in `localStorage`.
- [ ] Login errors stay **generic** — never reveal whether an email exists.
- [ ] Body shape validated on **your** endpoints (`/signup/*`) before any action.
- [ ] Account created **only** by `/signup/complete` (OTP + password atomic);
      `disableSignUp: true` + passkey `requireSession: true` block orphan creation.
- [ ] **One user = one email**: `UNIQUE(email)` + account linking; `email-password` is
      NOT a trusted linker (must prove email via OTP first — Path C).
- [ ] OTP / login endpoints **rate limited** — Express per-IP + per-email on `/signup/*`,
      Better Auth `rateLimit` on its own routes. (Prod: move to a shared store.)
- [ ] Passkey `rpID`/`origin` derive from the **frontend** origin, not the API.
- [ ] CORS names the **exact** frontend origin, never `*`, with `credentials: true`.
- [ ] Better Auth handler mounted **before** `express.json()` (§5c); helmet on.
