# BACKEND_STRUCTURE.md — Qatoto Auth API

> This document lives in the **frontend** repo because it defines the contract the
> frontend depends on. When you create the backend repo, copy this file there too.
>
> **Audience:** you, new to programming, building the Express backend.
> **Goal:** ship working auth (signup, login, logout, session, password reset) that
> the Next.js + TanStack Query frontend can call.
> **Stack decision:** we use **Better Auth** (the auth engine) + **Drizzle ORM** (the
> database layer) + **PostgreSQL** (the database). Better Auth does the
> security-sensitive work — password hashing, sessions, cookies, OTP — so you don't
> hand-roll crypto. You learn its config and how to wire it, not how to reinvent it.

---

## 0. The one rule that governs everything

**The frontend is a hostile, untrusted presentation layer. The backend is the only
source of truth.** (This is the NON-NEGOTIABLE principle from the frontend's
`CLAUDE.md` — the same rule applies on the server, from the other side.)

Anyone can open DevTools, read your client JS, and forge any request to your API.
So the backend must **re-check every single thing**, every request, by itself:

- The 3-step signup UI (email → OTP → password) is **just UX**. The server must re-verify
  the OTP before it trusts the email — never assume "step 2 happened". The account is
  created **only** once the OTP is verified **and** a password is set, in one atomic
  server call — verifying an OTP alone never creates an account (no passwordless orphans).
- Never trust a client-sent user id, role, price, quantity, or country. Derive or
  re-verify them on the server. Better Auth derives the user from the session cookie,
  never from the request body.
- Validate the **shape** of every request body on any endpoint **you** write. Better
  Auth validates its own endpoints; your custom routes are your responsibility.

Using a library does **not** relax this rule — it just means the library is doing the
re-checks for its own endpoints. If you remember nothing else from this file, remember §0.

---

## 1. What the frontend already expects

Read these to see the exact flows you must support:

- Sign up (3 steps): [sign-up.tsx](src/components/auth/sign-up.tsx)
  `email → send OTP → verify 6-digit OTP → set password (min 8) + "remember me"`
- Sign in (OAuth landing + link to password): [sign-in.tsx](src/components/auth/sign-in.tsx)
- Sign in with password: [sign-in-with-password.tsx](src/components/auth/sign-in-with-password.tsx)
  `email + password + "remember me"`
- Forgot password (3 steps, same OTP shape): [forgot-password.tsx](src/components/auth/forgot-password.tsx)
  `email → send OTP → verify OTP → set new password`

Today the frontend fakes login with a `localStorage` flag called
`qatoto_authenticated` (set in [sign-in.tsx:11](src/components/auth/sign-in.tsx#L11),
read in [navbar.tsx:50](src/components/home/layout/navbar.tsx#L50), cleared on logout
in [account-menu.tsx:105](src/components/home/account/account-menu.tsx#L105)).

That flag is a **temporary UI hint, not real auth**. Once the backend exists, the real
answer to "is this user logged in?" comes from Better Auth's session (the
`GET /api/auth/get-session` endpoint, or the `useSession()` hook — see §6).
`localStorage` is the wrong place for a real session — see §7.

**Google / Apple OAuth is out of scope for now.** Better Auth makes it a later add
(`socialProviders` in the config). Build email + password + OTP first; add OAuth in §9.

---

## 2. The stack (kept deliberately small)

| Concern          | Pick                     | Why this one                                                                                       |
| ---------------- | ------------------------ | -------------------------------------------------------------------------------------------------- |
| Server framework | **Express 5**            | The thing you're learning. Minimal, huge community.                                                |
| Language         | **TypeScript**           | Same language as the frontend — shared types, fewer bugs. Run with `tsx` (no build step in dev).   |
| Auth engine      | **Better Auth**          | Handles password hashing, sessions, cookies, OTP, CSRF. Don't roll your own crypto.                |
| Database ORM     | **Drizzle ORM**          | Type-safe queries + migrations. Better Auth generates its tables as a Drizzle schema for you.      |
| Database         | **PostgreSQL** via `pg`  | Strict types, same engine as prod. Run locally via Docker or Neon free tier — no SQLite surprises. |
| OTP delivery     | **`console.log` in dev** | Don't sign up for an email provider yet. Better Auth hands you the code in a callback — print it.  |
| CORS             | **cors**                 | Lets the browser on `:3000` call the API on `:8000`.                                               |

**What you are NOT installing (Better Auth does it):** no `bcrypt` (we use
`@node-rs/argon2` — napi-rs native bindings, faster and stronger than scrypt), no
`cookie-parser` (Better Auth reads/writes its
own signed cookies), no hand-rolled `sessions` table or OTP table (Better Auth owns
those — see §4).

Install (after `npm init`):

```bash
# runtime dependencies
npm install express better-auth pg drizzle-orm cors @node-rs/argon2

# dev tooling: TypeScript, a zero-config TS runner, Drizzle's CLI, and type definitions
npm install -D typescript tsx drizzle-kit \
  @types/node @types/express @types/pg @types/cors
```

You also need a running Postgres. Pick one:

```bash
# Option A — Docker (local container)
docker run --name qatoto-pg -e POSTGRES_PASSWORD=password \
  -e POSTGRES_DB=qatoto -p 5432:5432 -d postgres:16

# Option B — Neon (https://neon.tech) free serverless Postgres, no Docker.
#            Copy its connection string straight into DATABASE_URL.
```

`package.json` (`"type": "module"`) scripts:

```jsonc
{
    "type": "module",
    "scripts": {
        "dev": "tsx watch src/index.ts", // auto-restarts on save, runs TS directly — no build step
        "build": "tsc", // compile to plain JS when you deploy
        "start": "node dist/index.js",
        "db:generate": "npx @better-auth/cli generate", // writes the Drizzle schema from your auth config
        "db:migrate": "drizzle-kit generate && drizzle-kit migrate", // create + apply the SQL migration
    },
}
```

Also create `tsconfig.json` (`npx tsc --init`) and a `.env` (see §10).

> **Why a library instead of hand-rolling sessions?** Hand-rolling teaches you the
> mechanics, but it also means _you_ own every bug in password hashing, cookie flags,
> OTP expiry, and CSRF — the exact places a mistake becomes a breach. Better Auth ships
> those correct by default. You'll still see what it does: read §7 and the generated
> schema in §4, and you'll understand a session as well as if you'd written it.

---

## 3. Folder structure

Keep it flat. Split later if a file gets big.

```text
qatoto-backend/
├── src/
│   ├── index.ts            # creates the Express app, mounts Better Auth + your routes, starts the server
│   ├── auth.ts             # the Better Auth instance (config: db adapter, email+password, OTP plugin)
│   ├── db.ts               # opens the Postgres connection pool, wraps it with Drizzle
│   ├── auth-schema.ts       # GENERATED by `npx @better-auth/cli generate` — don't hand-edit
│   ├── require-auth.ts     # middleware for YOUR routes: reads the Better Auth session, attaches req.user
│   └── routes.ts           # your own non-auth routes + the custom /signup/start + /signup/complete endpoints (§5)
├── drizzle.config.ts       # tells drizzle-kit where the schema + DATABASE_URL are
├── tsconfig.json
├── .env                    # BETTER_AUTH_SECRET, BETTER_AUTH_URL, DATABASE_URL. NEVER commit this
├── .gitignore              # node_modules, dist/, .env
└── package.json
```

---

## 4. The data (Better Auth owns the schema)

**You do not hand-write SQL tables.** You describe what you want in `auth.ts` (§5), then
run the CLI and it generates the Drizzle schema for you:

```bash
npm run db:generate   # reads auth.ts → writes src/auth-schema.ts (Drizzle table definitions)
npm run db:migrate    # drizzle-kit turns that schema into SQL and applies it to your Postgres DB
```

With email+password + the email-OTP plugin enabled, Better Auth generates roughly these
tables (you'll see them in `auth-schema.ts`):

| Table          | What it holds                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------- |
| `user`         | id, email, name, emailVerified, createdAt — the registered person. **No raw password here.**        |
| `account`      | the password hash (argon2id via `@node-rs/argon2`) and any OAuth provider links, keyed to a user.   |
| `session`      | one row per logged-in session — the cookie holds a reference, everything else stays server-side.    |
| `verification` | short-lived OTP / verification records (the email-OTP plugin stores codes here, hashed + expiring). |

The same protections from the hand-rolled version still hold — Better Auth just enforces
them for you: OTPs are hashed, expiring, and single-use; the password is hashed, never
stored or returned in plaintext; the session cookie carries only an opaque reference.

Re-run `npm run db:generate && npm run db:migrate` whenever you change `auth.ts` in a way
that adds fields or plugins.

---

## 5. The setup + the API

### 5a. The Better Auth instance — `src/auth.ts`

```ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP } from "better-auth/plugins";
import { hash, verify } from "@node-rs/argon2";
import { db } from "./db";

export const auth = betterAuth({
    database: drizzleAdapter(db, { provider: "pg" }),

    // email + password sign-in. Passwords hashed with argon2id via @node-rs/argon2 (native bindings).
    emailAndPassword: {
        enabled: true,
        minPasswordLength: 8,
        password: {
            hash: (password) => hash(password),
            verify: ({ hash: passwordHash, password }) => verify(passwordHash, password),
        },
    },

    // the OTP plugin powers both signup-verification and forgot-password.
    plugins: [
        emailOTP({
            // Never let an OTP alone create a user — account creation is owned by
            // POST /signup/complete (OTP + password together). No passwordless orphans.
            disableSignUp: true,
            // in dev: print the code. Wire a real email provider here later (§9).
            async sendVerificationOTP({ email, otp, type }) {
                console.log(`OTP for ${email} (${type}): ${otp}`);
            },
        }),
    ],
});
```

### 5b. The database — `src/db.ts`

```ts
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./auth-schema";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });
```

> A `Pool` reuses open connections instead of dialing a fresh one per request. The
> driver import here + `provider: "pg"` in `auth.ts` are the only Postgres-specific
> lines — swapping providers later means changing just these. That's the payoff for
> using an ORM instead of raw SQL strings.

### 5c. Mounting on Express — `src/index.ts`

**Order matters.** The Better Auth handler must be mounted **before** `express.json()`,
because it parses its own request bodies. Put `express.json()` after it, for your own routes.

```ts
import express from "express";
import cors from "cors";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./auth";

const app = express();

// 1. CORS first — name the exact frontend origin, allow credentials (cookies).
app.use(cors({ origin: "http://localhost:3000", credentials: true }));

// 2. Better Auth catch-all. Note the Express 5 splat syntax: "*splat".
app.all("/api/auth/*splat", toNodeHandler(auth));

// 3. JSON body parser AFTER Better Auth, for your own routes.
app.use(express.json());

// 4. Your own routes go here (see routes.ts).

app.listen(8000, () => console.log("API on http://localhost:8000"));
```

Sanity check after this step: `GET http://localhost:8000/api/auth/ok` should respond.

### 5d. The endpoints Better Auth gives you (free, under `/api/auth`)

You don't write these — enabling the config above creates them.

| Method & path                                    | Body                              | Purpose                                                                                                             |
| ------------------------------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/email-otp/send-verification-otp` | `{ email, type }`                 | Generate + "send" a 6-digit OTP. `type`: `"sign-in"`, `"email-verification"`, or `"forget-password"`.               |
| `POST /api/auth/sign-in/email-otp`               | `{ email, otp }`                  | OTP login for **existing** users. With `disableSignUp: true` it never creates a user (no orphans). Signup uses §5e. |
| `POST /api/auth/email-otp/reset-password`        | `{ email, otp, password }`        | Forgot-password: verify a `forget-password` OTP and set the new password.                                           |
| `POST /api/auth/sign-in/email`                   | `{ email, password, rememberMe }` | Password login. `rememberMe` controls cookie lifetime. Wrong email or password → same generic error.                |
| `POST /api/auth/sign-out`                        | — (reads cookie)                  | Ends the session, clears the cookie.                                                                                |
| `GET  /api/auth/get-session`                     | — (reads cookie)                  | The real "am I logged in?" check. Returns the session + user, or null.                                              |

### 5e. The two endpoints YOU write — OTP-gated signup, account created at the end

Account creation is deferred to the very last step so a half-finished signup never leaves
a row behind. Two **public** endpoints, and **only the second one creates a user**:

| Method & path           | Body                              | Creates a user?                                                       |
| ----------------------- | --------------------------------- | --------------------------------------------------------------------- |
| `POST /signup/start`    | `{ email }`                       | No — just sends the OTP. Generic 200 (can't probe which emails exist) |
| `POST /signup/complete` | `{ email, otp, password, name? }` | **Yes — and only here.** Verifies the OTP, then creates user+password |

```ts
// src/controllers/auth.controller.ts — both mounted after express.json(), PUBLIC (no session yet).
import { APIError } from "better-auth/api";
import { eq } from "drizzle-orm";
import { db } from "#src/db/index.js";
import { user } from "#src/db/schema.js";
import { auth } from "#src/lib/auth.js";

// POST /signup/start  { email } — sends the code. Creates NO account.
await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });

// POST /signup/complete  { email, otp, password, name? } — the ONLY place a user is born.
// 1. Verify the OTP first. No user exists yet — a bad/expired code creates nothing.
await auth.api.checkVerificationOTP({ body: { email, otp, type: "sign-in" } });
// 2. OTP good → NOW create the account + password atomically, and open the session.
const { headers } = await auth.api.signUpEmail({
    body: { email, password, name },
    returnHeaders: true, // forward the session Set-Cookie onto the Express response
});
// 3. The OTP proved email ownership → mark verified.
await db.update(user).set({ emailVerified: true }).where(eq(user.email, email));
```

> Validate the body shape here (`§0`) — these are your endpoints, so the re-checks are
> yours (Zod `.strict()`, `422` on failure). `password` is **required** by the schema, so a
> request without one is rejected at the boundary and **no account is created**. Wrap the
> Better Auth calls and map their `APIError` to HTTP: a bad OTP → `401`, an email that
> already has a full account → `409` ("sign in instead").

#### No orphans — by construction

Because `disableSignUp: true` blocks `sign-in/email-otp` from ever minting a user, and the
only creation path (`/signup/complete`) demands the password in the **same call** as the OTP,
there is no "verified-but-passwordless" state to recover from:

```text
send-otp → /signup/complete { email, otp, password }
   ├─ bad / expired OTP  → 401, nothing created.
   ├─ missing password   → 422 at the Zod boundary, nothing created.
   └─ both present        → user + credential created, verified, session opened. ✅
```

A second `/signup/complete` for an email that already has an account returns **409**
("sign in instead") — it never duplicates or orphans anything. The signup UI may surface
that 409 as "email already registered, please sign in."

> **Migrating from the old two-phase flow:** any passwordless orphan rows left by the
> previous `sign-in/email-otp`-creates-the-user design are now stranded (can't log in, and
> `/signup/complete` 409s). Run the one-time cleanup to find/remove them:
> `npm run db:cleanup-orphans` (dry run) → `npm run db:cleanup-orphans -- --delete`
> (see [scripts/cleanup-orphan-signups.ts](../scripts/cleanup-orphan-signups.ts)).

---

## 6. How a request flows (signup, end to end)

The frontend keeps its 3-step UI; the calls map onto Better Auth like this:

```text
1. UI step 1 (enter email):
   POST /signup/start { email }
   → your endpoint forwards to Better Auth's send-verification-otp; it stores a hashed,
     expiring OTP and console.log("OTP for a@b.com (sign-in): 482913"). NO user created.

2. UI step 2 (enter 6-digit OTP)  +  3. UI step 3 (set password):
   On final submit, fire ONE call:

   POST /signup/complete { email, otp, password }   (your endpoint, §5e)
   → verifies the OTP, then CREATES the user (emailVerified = true) WITH the password in
     one atomic step, and sets the httpOnly session cookie. The user is now logged in.
     A bad OTP → 401 and no user; a missing password → 422 and no user.

4. Frontend: useSession() (or invalidate the ['auth','me'] query) → navbar shows logged-in state.
```

> **If the user bails before submitting the final step** (no `/signup/complete` call), no
> account exists at all — they simply start over. There is no orphan to recover, because the
> OTP alone never created anything (`disableSignUp: true`, §5e).

- **Login** (`sign-in-with-password.tsx`): one call, `POST /api/auth/sign-in/email`
  `{ email, password, rememberMe }`.
- **Forgot password** (`forgot-password.tsx`, 3 steps): step 1 →
  `send-verification-otp { email, type: "forget-password" }`; final step →
  `email-otp/reset-password { email, otp, password }`. No custom endpoint needed.

> **Why a custom `/signup/complete` instead of Better Auth's `sign-in/email-otp`?** The
> built-in OTP sign-in creates the user the moment the code is verified — before a password
> exists — which is exactly the orphan we want to avoid. So we disable that auto-signup and
> own one endpoint that verifies the OTP **and** sets the password together. This is §0 in
> action: the OTP is the gate, and the server enforces "account only when fully signed up."

---

## 7. Sessions & cookies (Better Auth handles the security heart)

When the user logs in, finishes OTP signup, or resets their password, **Better Auth sets
the session cookie for you** — httpOnly, `secure` in production, `sameSite: "lax"`, signed,
with an expiry it manages. `rememberMe` on password login extends the lifetime. You don't
write `res.cookie(...)` and you don't generate session ids.

For **your own** protected routes, ask Better Auth who the user is instead of querying the
DB yourself:

```ts
// src/require-auth.ts
import type { Request, Response, NextFunction } from "express";
import { auth } from "./auth";
import { fromNodeHeaders } from "better-auth/node";

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session) {
        return res
            .status(401)
            .json({ error: { code: "UNAUTHENTICATED", message: "Please sign in." } });
    }
    req.user = session.user; // typed by Better Auth
    next();
}
```

To teach TypeScript about `req.user`, add `src/types/express.d.ts`:

```ts
import "express";

declare global {
    namespace Express {
        interface Request {
            user?: { id: string; email: string; name: string | null; emailVerified: boolean };
        }
    }
}
```

**Why a cookie and not `localStorage`?** The current frontend stores its fake flag in
`localStorage`. For a _real_ token that's dangerous: any malicious script on the page can
read `localStorage` and steal the session (XSS). Better Auth uses an **httpOnly** cookie —
invisible to page JavaScript; the browser attaches it automatically. So: real session →
httpOnly cookie (Better Auth's default). The `localStorage` flag stays only as an optional
cosmetic hint, if at all.

---

## 8. Connecting to the frontend (CORS + the Better Auth client)

The browser runs the frontend on `http://localhost:3000` and your
API on `http://localhost:8000`. Different port = **different origin**, so the browser
blocks the call unless the server opts in.

- **CORS** (server) decides whether the browser is _allowed_ to call. Name the exact
  origin (not `*`) and allow credentials — already set in §5c:
  `cors({ origin: "http://localhost:3000", credentials: true })`.
- **`sameSite: "lax"`** (Better Auth's cookie default) lets the cookie ride along on
  `localhost → localhost` in dev. In production, put the API on a subdomain like
  `api.qatoto.com` so it stays same-site with `qatoto.com`.

### Frontend side — use the Better Auth React client

Better Auth ships a typed client that replaces the manual `localStorage` flag and most
hand-written fetches. Install `better-auth` in the frontend and create the client once:

```ts
// src/lib/auth-client.ts (frontend)
import { createAuthClient } from "better-auth/react";
import { emailOTPClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
    baseURL: "http://localhost:8000", // the API origin; cookies are sent automatically
    plugins: [emailOTPClient()],
});

export const { useSession, signIn, signOut } = authClient;
```

Then:

```ts
// "Am I logged in?" — one hook, used everywhere (replaces the localStorage flag)
const { data: session, isPending } = useSession();
const isLoggedIn = !!session;

// Login
await signIn.email({ email, password, rememberMe });

// Signup (§6) — the account is created only by the final call (OTP + password together)
await fetch("http://localhost:8000/signup/start", {
    // step 1: send the code (creates no account)
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email }),
});
await fetch("http://localhost:8000/signup/complete", {
    // step 2 + 3: verify OTP AND set password → account created, session opened
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email, otp, password }),
});

// Forgot password
await authClient.emailOtp.sendVerificationOtp({ email, type: "forget-password" });
await authClient.emailOtp.resetPassword({ email, otp, password });

// Logout
await signOut();
```

> The Better Auth client sends cookies for its own calls automatically. For your **own**
> endpoints (like `/signup/start` and `/signup/complete`) you still pass `credentials: "include"` on the
> raw `fetch`, exactly as before. You can keep using TanStack Query to wrap these
> mutations if you prefer its caching/invalidation — `useSession()` already covers the
> "am I logged in?" read, so the manual `['auth','me']` query is no longer required.

---

## 9. Build order — do them in THIS order

Each step is a small, runnable win. Don't skip ahead.

0. **Check tools.** `node --version` (you have v26). Install nothing else yet.
1. **Hello server.** `npm init`, install Express + TypeScript (`tsx`), write a trivial
   route, run with `tsx`, open it. → **Lesson 01**
2. **Database + Drizzle.** Start Postgres (Docker or Neon), add `pg` + `drizzle-orm`,
   write `db.ts`, write a `drizzle.config.ts`.
3. **Better Auth, email+password only.** Write `auth.ts` (just `emailAndPassword`), mount
   it in `index.ts` (§5c), run `db:generate` + `db:migrate`, hit `/api/auth/ok`.
4. **Password login + session.** Test `sign-in/email`, then `requireAuth` (§7) on a dummy
   protected route + `get-session`.
5. **OTP plugin.** Add `emailOTP` to `auth.ts`, re-generate the schema, watch the code
   print to your terminal on `send-verification-otp`.
6. **OTP signup.** Wire the flow (§6): `/signup/start` → `/signup/complete` (the only
   user-creating call). Set `disableSignUp: true` on the OTP plugin.
7. **Logout.** `sign-out`.
8. **Forgot password.** `send-verification-otp` (`forget-password`) + `email-otp/reset-password`.
9. **Wire the frontend.** Add `cors`, create the `authClient` (§8), swap the `localStorage`
   flag for `useSession()`.

### Later (explicitly NOT now)

- Google / Apple OAuth (`socialProviders` in `auth.ts`)
- Real email delivery (nodemailer, Resend, or Postmark) inside `sendVerificationOTP`
- Managed Postgres + connection pooling for prod (e.g. Neon, RDS, Supabase)
- **Shared rate-limit store for prod.** Rate limiting is already DONE (see below), but
  both limiters use an **in-memory** store — per-process only. Multi-instance / serverless
  deploys let attackers round-robin instances, so move to a shared store: the Express
  limiters → `rate-limit-redis`; Better Auth → `rateLimit.storage: "database"` (adds a
  `rateLimit` table) or `"secondary-storage"`.

### Already done: OTP / auth rate limiting

Two layers (Better Auth's limiter does **not** cover `auth.api` server-side calls, so the
custom routes need their own):

- **Express limiters** (`src/middleware/rate-limit.ts`) on the custom routes: `/signup/start`
  is capped **per-IP (8/15min)** and **per-email (4/15min)** — stops OTP spam + inbox-bombing;
  `/signup/complete` is capped **per-IP (12/15min)**. 429 returns the standard ApiResponse
  envelope with `retryAfterSeconds`.
- **Better Auth `rateLimit`** (`src/auth.ts`) on its own endpoints — `send-verification-otp`
  3/60s, `sign-in/email-otp` 5/60s, `reset-password` 5/60s, `sign-in/email` 5/10s. Enabled
  in all envs (BA defaults to prod-only).

---

## 10. Security checklist (pin this above your desk)

Better Auth handles most of these by default — your job is to not undo them and to set the
config/env correctly.

- [ ] Server re-validates **every** request — the UI's steps prove nothing (§0).
- [ ] `BETTER_AUTH_SECRET` is set in `.env` (a long random string) and **git-ignored**.
- [ ] `BETTER_AUTH_URL` matches the API origin (`http://localhost:8000` in dev).
- [ ] `DATABASE_URL` points at your Postgres and is **git-ignored** (it holds the DB password).
- [ ] Passwords are hashed with **argon2id** (`@node-rs/argon2`) — never stored or returned in plaintext.
- [ ] OTPs are hashed, expiring, single-use (Better Auth's `verification` table) — don't disable that.
- [ ] Session lives in Better Auth's **httpOnly** cookie, never in `localStorage`.
- [ ] Login errors stay **generic** — don't add code that reveals whether the email exists.
- [ ] Body shape is validated on **your** endpoints (`/signup/start`, `/signup/complete`) before any action.
- [ ] Account is created **only** by `/signup/complete` (OTP + password atomic); `disableSignUp: true` blocks OTP-only orphans.
- [ ] OTP / login endpoints are **rate limited** — Express per-IP + per-email on `/signup/*`, Better Auth `rateLimit` on its own routes. (Prod: move to a shared store.)
- [ ] CORS names the **exact** frontend origin, never `*`, with `credentials: true`.
- [ ] The Better Auth handler is mounted **before** `express.json()` (§5c).

---
