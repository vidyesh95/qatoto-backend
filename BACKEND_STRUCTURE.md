# BACKEND_STRUCTURE.md — Qatoto Auth API

> This document lives in the **frontend** repo because it defines the contract the
> frontend depends on. When you create the backend repo, copy this file there too.
>
> **Audience:** you, new to programming, building the Express backend.
> **Goal:** ship working auth (signup, login, logout, session, password reset) that
> the Next.js + TanStack Query frontend can call.
> **Stack decision:** we use **Better Auth** (the auth engine) + **Drizzle ORM** (the
> database layer) + **SQLite** (the database file). Better Auth does the
> security-sensitive work — password hashing, sessions, cookies, OTP — so you don't
> hand-roll crypto. You learn its config and how to wire it, not how to reinvent it.

---

## 0. The one rule that governs everything

**The frontend is a hostile, untrusted presentation layer. The backend is the only
source of truth.** (This is the NON-NEGOTIABLE principle from the frontend's
`CLAUDE.md` — the same rule applies on the server, from the other side.)

Anyone can open DevTools, read your client JS, and forge any request to your API.
So the backend must **re-check every single thing**, every request, by itself:

- The 3-step signup UI (email → OTP → password) is **just UX**. The server (via Better
  Auth) must re-verify the OTP before it trusts the email — never assume "step 2 happened".
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

| Concern          | Pick                            | Why this one                                                                                           |
| ---------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Server framework | **Express 5**                   | The thing you're learning. Minimal, huge community.                                                    |
| Language         | **TypeScript**                  | Same language as the frontend — shared types, fewer bugs. Run with `tsx` (no build step in dev).       |
| Auth engine      | **Better Auth**                 | Handles password hashing, sessions, cookies, OTP, CSRF. Don't roll your own crypto.                    |
| Database ORM     | **Drizzle ORM**                 | Type-safe queries + migrations. Better Auth generates its tables as a Drizzle schema for you.          |
| Database         | **SQLite** via `better-sqlite3` | A file on disk. No DB server to install. Drizzle lets you swap to Postgres later by changing one line. |
| OTP delivery     | **`console.log` in dev**        | Don't sign up for an email provider yet. Better Auth hands you the code in a callback — print it.      |
| CORS             | **cors**                        | Lets the browser on `:3000` call the API on `:4000`.                                                   |

**What you are NOT installing (Better Auth does it):** no `bcrypt` (Better Auth hashes
passwords with **scrypt** by default), no `cookie-parser` (Better Auth reads/writes its
own signed cookies), no hand-rolled `sessions` table or OTP table (Better Auth owns
those — see §4).

Install (after `npm init`):

```bash
# runtime dependencies
npm install express better-auth better-sqlite3 drizzle-orm cors

# dev tooling: TypeScript, a zero-config TS runner, Drizzle's CLI, and type definitions
npm install -D typescript tsx drizzle-kit \
  @types/node @types/express @types/better-sqlite3 @types/cors
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
│   ├── db.ts               # opens the SQLite file, wraps it with Drizzle
│   ├── auth-schema.ts       # GENERATED by `npx @better-auth/cli generate` — don't hand-edit
│   ├── require-auth.ts     # middleware for YOUR routes: reads the Better Auth session, attaches req.user
│   └── routes.ts           # your own non-auth routes + the one custom "set initial password" endpoint (§5)
├── drizzle.config.ts       # tells drizzle-kit where the schema + sqlite file are
├── tsconfig.json
├── .env                    # BETTER_AUTH_SECRET, BETTER_AUTH_URL, etc. NEVER commit this
├── .gitignore              # node_modules, dist/, *.sqlite, .env
└── package.json
```

---

## 4. The data (Better Auth owns the schema)

**You do not hand-write SQL tables.** You describe what you want in `auth.ts` (§5), then
run the CLI and it generates the Drizzle schema for you:

```bash
npm run db:generate   # reads auth.ts → writes src/auth-schema.ts (Drizzle table definitions)
npm run db:migrate    # drizzle-kit turns that schema into SQL and applies it to sqlite.db
```

With email+password + the email-OTP plugin enabled, Better Auth generates roughly these
tables (you'll see them in `auth-schema.ts`):

| Table          | What it holds                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------- |
| `user`         | id, email, name, emailVerified, createdAt — the registered person. **No raw password here.**        |
| `account`      | the password hash (scrypt) and any OAuth provider links, keyed to a user.                           |
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
import { db } from "./db";

export const auth = betterAuth({
    database: drizzleAdapter(db, { provider: "sqlite" }),

    // email + password sign-in. Better Auth hashes with scrypt; we enforce min length here too.
    emailAndPassword: {
        enabled: true,
        minPasswordLength: 8,
    },

    // the OTP plugin powers both signup-verification and forgot-password.
    plugins: [
        emailOTP({
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
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import * as schema from "./auth-schema";

const sqlite = new Database(process.env.DATABASE_FILE ?? "sqlite.db");
export const db = drizzle(sqlite, { schema });
```

> To move to Postgres at deploy time you change the driver import here and
> `provider: "pg"` in `auth.ts` — the rest of your code doesn't change. That's the
> payoff for using an ORM instead of raw SQL strings.

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
app.use(cors({ origin: "https://localhost:3000", credentials: true }));

// 2. Better Auth catch-all. Note the Express 5 splat syntax: "*splat".
app.all("/api/auth/*splat", toNodeHandler(auth));

// 3. JSON body parser AFTER Better Auth, for your own routes.
app.use(express.json());

// 4. Your own routes go here (see routes.ts).

app.listen(4000, () => console.log("API on http://localhost:4000"));
```

Sanity check after this step: `GET http://localhost:4000/api/auth/ok` should respond.

### 5d. The endpoints Better Auth gives you (free, under `/api/auth`)

You don't write these — enabling the config above creates them.

| Method & path                                    | Body                              | Purpose                                                                                                              |
| ------------------------------------------------ | --------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/email-otp/send-verification-otp` | `{ email, type }`                 | Generate + "send" a 6-digit OTP. `type`: `"sign-in"`, `"email-verification"`, or `"forget-password"`.                |
| `POST /api/auth/sign-in/email-otp`               | `{ email, otp }`                  | Verify OTP. **Creates the user if they don't exist** + signs them in. (This is how we do OTP-gated signup — see §6.) |
| `POST /api/auth/email-otp/reset-password`        | `{ email, otp, password }`        | Forgot-password: verify a `forget-password` OTP and set the new password.                                            |
| `POST /api/auth/sign-in/email`                   | `{ email, password, rememberMe }` | Password login. `rememberMe` controls cookie lifetime. Wrong email or password → same generic error.                 |
| `POST /api/auth/sign-out`                        | — (reads cookie)                  | Ends the session, clears the cookie.                                                                                 |
| `GET  /api/auth/get-session`                     | — (reads cookie)                  | The real "am I logged in?" check. Returns the session + user, or null.                                               |

### 5e. The one endpoint YOU write — set the initial password after OTP signup

Better Auth **cannot verify an OTP for a user that doesn't exist yet** (you'd get
`USER_NOT_FOUND`). So OTP-gated signup is two phases: the OTP call creates the verified
user (no password yet), then a tiny endpoint of yours sets their first password. This is
the one place you call Better Auth's server API directly:

```ts
// src/routes.ts — mounted after express.json(), behind requireAuth (§7)
import { auth } from "./auth";
import { fromNodeHeaders } from "better-auth/node";

// POST /set-initial-password  { password }
router.post("/set-initial-password", requireAuth, async (req, res) => {
    const password = req.body?.password;
    if (typeof password !== "string" || password.length < 8) {
        return res.status(400).json({
            error: { code: "WEAK_PASSWORD", message: "Password must be at least 8 characters." },
        });
    }

    // GUARD: setPassword is for credential-less accounts (OTP/social) only — calling it on a
    // user who ALREADY has a password errors. A user who wanders back into signup after
    // finishing once would hit that. Check first; no-op if they're already set up.
    const accounts = await auth.api.listUserAccounts({ headers: fromNodeHeaders(req.headers) });
    const hasPassword = accounts.some((account) => account.providerId === "credential");
    if (hasPassword) {
        return res.json({ data: { ok: true, alreadySet: true } }); // route them to home, not an error
    }

    // setPassword does NOT require a current password — exactly what we want for the
    // OTP-created (passwordless) user finishing signup.
    await auth.api.setPassword({
        body: { newPassword: password },
        headers: fromNodeHeaders(req.headers), // proves WHICH user, from their session cookie
    });
    res.json({ data: { ok: true } });
});
```

> Validate the body shape here (`§0`) — this is your endpoint, so the re-check is yours.
> The `hasPassword` guard also makes this endpoint **idempotent**: calling it twice is safe.

#### The orphan edge case — and why it self-heals

What if a user enters their email + OTP (which **creates the verified user**), then closes the
browser **before** setting a password? They now have an account with a verified email and **no
password** — they can't password-login, and they're about to "sign up" again. Are they stuck?

**No.** `sign-in/email-otp` is "**create the user if new, otherwise just sign in**", so the
second attempt recovers automatically:

```text
Visit 1:  send-otp → sign-in/email-otp (CREATES verified user, no password) → browser closed.
          Orphan: verified email, no password. Can't password-login yet.
Visit 2:  same email → send-otp → sign-in/email-otp → user ALREADY exists → just SIGNS IN.
          → /set-initial-password → password lands. ✅ account finished, recovered.
```

For this to work, **two rules** (both already encoded above + in §6):

1. **The signup UI must NOT pre-block "email already registered."** The email _is_ registered
   (the passwordless orphan), but blocking would trap the user forever. Let the OTP flow run —
   step 2 signs them into the existing account instead of creating a duplicate.
2. **`/set-initial-password` must no-op when a password already exists** (the `hasPassword`
   guard above) — so a fully-signed-up user who re-enters signup just gets logged in, not an error.

**Security:** an orphan is not a hole — only someone with a fresh OTP to that inbox can sign
into it, and with no password there's no password-login surface to attack. It simply waits to
be claimed.

> **ponytail:** no orphan-cleanup cron for now. If verified-but-passwordless rows ever pile up,
> add a sweep that deletes them after N days. Skip it until that's a real problem.

---

## 6. How a request flows (signup, end to end)

The frontend keeps its 3-step UI; the calls map onto Better Auth like this:

```text
1. UI step 1 (enter email):
   POST /api/auth/email-otp/send-verification-otp { email, type: "sign-in" }
   → Better Auth stores a hashed, expiring OTP and calls sendVerificationOTP,
     which console.log("OTP for a@b.com (sign-in): 482913"). Returns success.

2. UI step 2 (enter 6-digit OTP)  +  3. UI step 3 (set password):
   On final submit, fire two calls in order:

   a. POST /api/auth/sign-in/email-otp { email, otp }
      → verifies the OTP, CREATES the user (emailVerified = true) if new,
        and sets the httpOnly session cookie. The user is now logged in.

   b. POST /set-initial-password { password }   (your endpoint, §5e; cookie rides along)
      → sets their first password so they can log in with email+password next time.

4. Frontend: useSession() (or invalidate the ['auth','me'] query) → navbar shows logged-in state.
```

> **If the user bails after step 2a** (OTP done, browser closed before the password), they
> become a verified-but-passwordless "orphan." This is **not** a dead end — re-running the same
> signup flow signs them back into that account (step 2a logs in instead of creating) and step
> 2b finishes it. See "The orphan edge case" in §5e for the two rules that make this self-heal
> (don't pre-block known emails; `/set-initial-password` no-ops if a password already exists).

- **Login** (`sign-in-with-password.tsx`): one call, `POST /api/auth/sign-in/email`
  `{ email, password, rememberMe }`.
- **Forgot password** (`forgot-password.tsx`, 3 steps): step 1 →
  `send-verification-otp { email, type: "forget-password" }`; final step →
  `email-otp/reset-password { email, otp, password }`. No custom endpoint needed.

> **Why this two-phase signup?** The frontend asks for email → OTP → password, but Better
> Auth proves email ownership by creating-and-verifying the account, then attaches a
> password. Reversing it (password first, verify later) would change the built UI. So we
> keep the UI and accept one tiny custom endpoint. This is §0 in action: the OTP is the
> gate, and the server — not the UI step counter — enforces it.

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

The browser runs the frontend on `https://localhost:3000` (Next dev uses https) and your
API on `http://localhost:4000`. Different port = **different origin**, so the browser
blocks the call unless the server opts in.

- **CORS** (server) decides whether the browser is _allowed_ to call. Name the exact
  origin (not `*`) and allow credentials — already set in §5c:
  `cors({ origin: "https://localhost:3000", credentials: true })`.
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
    baseURL: "http://localhost:4000", // the API origin; cookies are sent automatically
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

// Signup (the two-phase flow from §6)
await authClient.emailOtp.sendVerificationOtp({ email, type: "sign-in" }); // step 1
await signIn.emailOtp({ email, otp }); // step 2 (creates + logs in)
await fetch("http://localhost:4000/set-initial-password", {
    // step 3 (your endpoint)
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ password }),
});

// Forgot password
await authClient.emailOtp.sendVerificationOtp({ email, type: "forget-password" });
await authClient.emailOtp.resetPassword({ email, otp, password });

// Logout
await signOut();
```

> The Better Auth client sends cookies for its own calls automatically. For your **own**
> endpoints (like `/set-initial-password`) you still pass `credentials: "include"` on the
> raw `fetch`, exactly as before. You can keep using TanStack Query to wrap these
> mutations if you prefer its caching/invalidation — `useSession()` already covers the
> "am I logged in?" read, so the manual `['auth','me']` query is no longer required.

---

## 9. Build order — do them in THIS order

Each step is a small, runnable win. Don't skip ahead.

0. **Check tools.** `node --version` (you have v26). Install nothing else yet.
1. **Hello server.** `npm init`, install Express + TypeScript (`tsx`), write a trivial
   route, run with `tsx`, open it. → **Lesson 01**
2. **Database + Drizzle.** Add `better-sqlite3` + `drizzle-orm`, write `db.ts`, write a
   `drizzle.config.ts`.
3. **Better Auth, email+password only.** Write `auth.ts` (just `emailAndPassword`), mount
   it in `index.ts` (§5c), run `db:generate` + `db:migrate`, hit `/api/auth/ok`.
4. **Password login + session.** Test `sign-in/email`, then `requireAuth` (§7) on a dummy
   protected route + `get-session`.
5. **OTP plugin.** Add `emailOTP` to `auth.ts`, re-generate the schema, watch the code
   print to your terminal on `send-verification-otp`.
6. **OTP signup.** Wire the two-phase flow (§6): `sign-in/email-otp` + your
   `/set-initial-password` endpoint.
7. **Logout.** `sign-out`.
8. **Forgot password.** `send-verification-otp` (`forget-password`) + `email-otp/reset-password`.
9. **Wire the frontend.** Add `cors`, create the `authClient` (§8), swap the `localStorage`
   flag for `useSession()`.

### Later (explicitly NOT now)

- Google / Apple OAuth (`socialProviders` in `auth.ts`)
- Real email delivery (nodemailer, Resend, or Postmark) inside `sendVerificationOTP`
- Rate limiting (Better Auth has built-in rate-limit options — turn them up for prod)
- Move SQLite → Postgres (change the Drizzle driver + `provider`)

---

## 10. Security checklist (pin this above your desk)

Better Auth handles most of these by default — your job is to not undo them and to set the
config/env correctly.

- [ ] Server re-validates **every** request — the UI's steps prove nothing (§0).
- [ ] `BETTER_AUTH_SECRET` is set in `.env` (a long random string) and **git-ignored**.
- [ ] `BETTER_AUTH_URL` matches the API origin (`http://localhost:4000` in dev).
- [ ] Passwords are hashed by Better Auth (**scrypt**) — never stored or returned in plaintext.
- [ ] OTPs are hashed, expiring, single-use (Better Auth's `verification` table) — don't disable that.
- [ ] Session lives in Better Auth's **httpOnly** cookie, never in `localStorage`.
- [ ] Login errors stay **generic** — don't add code that reveals whether the email exists.
- [ ] Body shape is validated on **your** endpoints (e.g. `/set-initial-password`) before any action.
- [ ] CORS names the **exact** frontend origin, never `*`, with `credentials: true`.
- [ ] The Better Auth handler is mounted **before** `express.json()` (§5c).

---
