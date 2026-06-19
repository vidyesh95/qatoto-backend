# BACKEND_STRUCTURE.md — Qatoto Auth API

> This document lives in the **frontend** repo because it defines the contract the
> frontend depends on. When you create the backend repo, copy this file there too.
>
> **Audience:** you, new to programming, building the Express backend.
> **Goal:** ship working auth (signup, login, logout, session, password reset) that
> the Next.js + TanStack Query frontend can call. Simple REST. No magic.

---

## 0. The one rule that governs everything

**The frontend is a hostile, untrusted presentation layer. The backend is the only
source of truth.** (This is the NON-NEGOTIABLE principle from the frontend's
`CLAUDE.md` — the same rule applies on the server, from the other side.)

Anyone can open DevTools, read your client JS, and forge any request to your API.
So the backend must **re-check every single thing**, every request, by itself:

- The 3-step signup UI (email → OTP → password) is **just UX**. The server must
  re-verify the OTP at the final step — never assume "step 2 happened".
- Never trust a client-sent user id, role, price, quantity, or country. Derive or
  re-verify them on the server.
- Validate the **shape** of every request body before you touch the database.

If you remember nothing else from this file, remember this.

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

That flag is a **temporary UI hint, not real auth**. Once your backend exists, the
real answer to "is this user logged in?" comes from `GET /auth/me` (see §6).
`localStorage` is the wrong place for a real session — see §7 (cookies vs localStorage).

**Google / Apple OAuth is out of scope for now.** It's a separate, harder feature.
Build email + password + OTP first; add OAuth later (§9).

---

## 2. The stack (kept deliberately small)

| Concern             | Pick                                                   | Why this one (for now)                                                                                                       |
| ------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Server framework    | **Express 5**                                          | The thing you're learning. Minimal, huge community.                                                                          |
| Language            | **TypeScript**                                         | Same language as the frontend — shared types, fewer bugs. Run it with `tsx` (executes `.ts` directly, no build step in dev). |
| Database            | **SQLite** via `better-sqlite3`                        | A file on disk. No DB server to install or run. Swap to Postgres when you deploy.                                            |
| Password hashing    | **Argon2** (`@node-rs/argon2`)                         | Modern memory-hard KDF (PHC winner). Native binding, ships own types. Never store raw passwords.                             |
| Cookie reading      | **cookie-parser**                                      | Tiny helper to read the session cookie.                                                                                      |
| CORS                | **cors**                                               | Lets the browser on `:3000` call the API on `:4000`.                                                                         |
| Sessions            | **hand-rolled** (a `sessions` table + a random cookie) | ~20 lines, no magic. You'll understand exactly what a session is.                                                            |
| Email / OTP sending | **`console.log` in dev**                               | Don't sign up for an email provider yet. Print the code to your terminal. Wire real email later.                             |

Install (once you've run `npm init`):

```bash
# runtime dependencies
npm install express better-sqlite3 @node-rs/argon2 cookie-parser cors

# dev tooling: TypeScript, a zero-config TS runner, and type definitions
# (@node-rs/argon2 bundles its own types — no @types package needed)
npm install -D typescript tsx @types/node @types/express \
  @types/better-sqlite3 @types/cookie-parser @types/cors
```

Then create a `tsconfig.json` (`npx tsc --init` gives you a sensible default) and add
scripts to `package.json`:

```jsonc
{
    "type": "module",
    "scripts": {
        "dev": "tsx watch src/index.ts", // auto-restarts on save, runs TS directly — no build step
        "build": "tsc", // compile to plain JS when you deploy
        "start": "node dist/index.js",
    },
}
```

**Why TypeScript here?** Your frontend is TypeScript already. Matching it means the
same `User` / response types can describe both sides of the wire, and the compiler
catches a whole class of typos before you ever run the server. `tsx` keeps the dev
loop as fast as plain JS — you run `.ts` files directly, no separate build step.

> **Why hand-rolled sessions instead of a library?** A session is just: "on login,
> generate a random unguessable id, store it in a table next to the user id, and put
> that id in an httpOnly cookie. On each request, look the cookie up." That's it.
> Doing it by hand once teaches you what every session library does under the hood.

---

## 3. Folder structure

Keep it flat. You can split later if a file gets big.

```text
qatoto-backend/
├── src/
│   ├── index.ts            # creates the Express app, mounts routes, starts the server
│   ├── db.ts               # opens the SQLite file, creates tables on boot
│   ├── auth.ts             # all /auth/* routes (start here as ONE file; split later)
│   ├── otp.ts              # generate + verify OTP codes
│   ├── email.ts            # "send" an email (console.log in dev)
│   ├── require-auth.ts     # middleware: reads session cookie, attaches req.user
│   └── types/express.d.ts  # tells TypeScript about the custom `req.user` (see §7)
├── tsconfig.json           # TypeScript settings
├── .env                    # secrets + config (NEVER commit this)
├── .gitignore              # ignore node_modules, dist/, *.sqlite, .env
└── package.json            # "type": "module" + your dev/build/start scripts
```

Start even simpler if you want: everything in `index.ts`, then extract files once it
gets crowded. Fewer files = less to hold in your head on day one.

---

## 4. The data (SQLite tables)

Create these once when the server boots (in `db.js`). Plain SQL — you'll read it fine.

```sql
-- A registered person.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,                       -- crypto.randomUUID()
  email         TEXT UNIQUE NOT NULL,                   -- one account per email
  password_hash TEXT NOT NULL,                          -- argon2 hash, NEVER the raw password
  display_name  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A one-time code we emailed, waiting to be used.
CREATE TABLE IF NOT EXISTS otps (
  email      TEXT NOT NULL,
  code_hash  TEXT NOT NULL,                             -- hash of the 6 digits, not the digits
  purpose    TEXT NOT NULL,                             -- 'signup' | 'reset'
  expires_at TEXT NOT NULL,                             -- ~10 minutes out
  attempts   INTEGER NOT NULL DEFAULT 0                 -- lock out after too many wrong tries
);

-- A logged-in session. The cookie holds `id`; everything else stays server-side.
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,                          -- crypto.randomUUID(), the cookie value
  user_id    TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
```

Rules that protect you:

- Store the **hash** of the OTP, never the raw code (same reason you hash passwords).
- OTPs **expire** (~10 min) and are **single-use** (delete on success).
- The session cookie holds only a random id. The browser learns nothing from it.

---

## 5. The API (simple REST)

Seven endpoints. `purpose` (`"signup"` or `"reset"`) lets ONE OTP system serve both
the signup and forgot-password flows.

### Success and error shape (every endpoint)

This mirrors the frontend's `ActionResponse<T>` pattern (`CLAUDE.md` → Pattern 3), so
your TanStack Query code can branch on it cleanly.

```jsonc
// 2xx success
{ "data": { /* whatever the endpoint returns */ } }

// non-2xx failure (use the right HTTP status too: 400, 401, 409, 429…)
{ "error": { "code": "INVALID_OTP", "message": "That code is wrong or expired." } }
```

A `user` object is always: `{ "id", "email", "displayName", "createdAt" }`.
**Never** include `password_hash` in any response.

### The endpoints

| Method & path               | Body                              | Success                                        | Notes                                                                                                                                                                 |
| --------------------------- | --------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/otp/send`       | `{ email, purpose }`              | `{ data: { sent: true } }`                     | Generate code, store hash + expiry, "email" it (console.log in dev). Always return the same response whether or not the email exists — don't leak who has an account. |
| `POST /auth/otp/verify`     | `{ email, otp, purpose }`         | `{ data: { valid: true } }`                    | **UX only** — lets the UI move from step 2 → step 3. Does NOT consume the code. The real check happens below.                                                         |
| `POST /auth/signup`         | `{ email, otp, password }`        | `201 { data: { user } }` + sets session cookie | Re-verify OTP. Reject if email taken (`409 EMAIL_TAKEN`) or password < 8 (`400 WEAK_PASSWORD`). Hash password, insert user, create session.                           |
| `POST /auth/login`          | `{ email, password, rememberMe }` | `{ data: { user } }` + sets session cookie     | On wrong email OR password, return the SAME generic `401 INVALID_CREDENTIALS`. `rememberMe` only changes cookie lifetime.                                             |
| `POST /auth/password/reset` | `{ email, otp, password }`        | `{ data: { reset: true } }`                    | Re-verify OTP (`purpose: 'reset'`), hash new password, update user. Optionally delete their other sessions.                                                           |
| `GET  /auth/me`             | — (reads cookie)                  | `{ data: { user } }` or `401 UNAUTHENTICATED`  | The real "am I logged in?" check. The frontend calls this with TanStack Query.                                                                                        |
| `POST /auth/logout`         | — (reads cookie)                  | `{ data: { ok: true } }`                       | Delete the session row, clear the cookie.                                                                                                                             |

### Error codes to use

`VALIDATION_ERROR` (bad body shape), `INVALID_OTP`, `OTP_EXPIRED`, `EMAIL_TAKEN`,
`INVALID_CREDENTIALS`, `WEAK_PASSWORD`, `UNAUTHENTICATED`, `RATE_LIMITED`.

> **Why split `verify` from `signup`?** The UI has a "Verify" button on step 2 that
> just needs a yes/no so it can show step 3. But security can't live there — a forged
> request could skip straight to `signup`. So `signup` **re-verifies the OTP itself**.
> `verify` is a convenience; `signup`/`reset` are the gatekeepers. This is rule §0 in action.

---

## 6. How a request flows (signup, end to end)

```text
1. UI step 1: POST /auth/otp/send { email, purpose: "signup" }
   → server makes a 6-digit code, stores argon2(code) + expiry + purpose,
     console.log("OTP for a@b.com: 482913"), returns { data: { sent: true } }

2. UI step 2: POST /auth/otp/verify { email, otp, purpose: "signup" }
   → server checks the code is right + not expired (does NOT delete it),
     returns { data: { valid: true } } so the UI advances to step 3

3. UI step 3: POST /auth/signup { email, otp, password }
   → server RE-checks the OTP, checks email not taken, checks password length,
     argon2-hashes the password, INSERTs the user, DELETEs the OTP,
     creates a session row, sets the httpOnly session cookie,
     returns 201 { data: { user } }

4. Frontend: invalidate the ['auth','me'] query → navbar now shows the logged-in state
```

Login and reset are shorter versions of the same shapes.

---

## 7. Sessions & cookies (the security heart)

When the user logs in or finishes signup:

```js
const sessionId = crypto.randomUUID();
db.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)").run(
    sessionId,
    user.id,
    expiresAtIso,
);

res.cookie("session", sessionId, {
    httpOnly: true, // JS on the page CANNOT read it → safe from XSS
    secure: process.env.NODE_ENV === "production", // https only in prod; http is fine on localhost
    sameSite: "lax", // basic CSRF protection
    maxAge: rememberMe ? THIRTY_DAYS_MS : DAY_MS, // "remember me" = longer cookie
});
```

`requireAuth` middleware on protected routes:

```ts
import type { Request, Response, NextFunction } from "express";

export function requireAuth(req: Request, res: Response, next: NextFunction) {
    const sessionId = req.cookies.session;
    if (!sessionId)
        return res
            .status(401)
            .json({ error: { code: "UNAUTHENTICATED", message: "Please sign in." } });

    const session = db
        .prepare("SELECT * FROM sessions WHERE id = ? AND expires_at > datetime('now')")
        .get(sessionId);
    if (!session)
        return res
            .status(401)
            .json({ error: { code: "UNAUTHENTICATED", message: "Session expired." } });

    req.user = db
        .prepare("SELECT id, email, display_name, created_at FROM users WHERE id = ?")
        .get(session.user_id);
    next();
}
```

**TypeScript note — teaching `req.user` to exist.** Express's `Request` type has no
`user` property, so TypeScript will complain on the line above. Declare it once in
`src/types/express.d.ts` and the compiler is happy everywhere:

```ts
import "express";

declare global {
    namespace Express {
        interface Request {
            user?: { id: string; email: string; display_name: string | null; created_at: string };
        }
    }
}
```

**Why a cookie and not `localStorage`?** The current frontend stores its fake flag in
`localStorage`. For a _real_ token that's dangerous: any malicious script on the page
can read `localStorage` and steal the session (an XSS attack). An **httpOnly** cookie
is invisible to page JavaScript — the browser attaches it automatically and JS can't
read it. So: real session → httpOnly cookie. The `localStorage` flag stays only as an
optional cosmetic hint, if at all.

---

## 8. Connecting to the frontend (CORS + TanStack Query)

The browser runs the frontend on `https://localhost:3000` (Next dev uses https) and
your API on `http://localhost:4000`. Different port = **different origin**, so the
browser blocks the call unless the server opts in. Two separate mechanisms — don't
confuse them:

- **CORS** decides whether the browser is _allowed_ to call a different origin. You
  must name the exact frontend origin (not `*`) and allow credentials:

    ```js
    app.use(cors({ origin: "https://localhost:3000", credentials: true }));
    ```

- **The cookie's `sameSite`** decides whether the cookie rides along. `localhost` →
  `localhost` counts as the _same site_ (port doesn't matter for "site"), so
  `sameSite: "lax"` works in dev. In production, put the API on a subdomain like
  `api.qatoto.com` so it stays same-site with `qatoto.com`.

On the **frontend**, every auth call must opt in to sending cookies:

```ts
fetch(`${API_URL}/auth/me`, { credentials: "include" }); // <-- without this, the cookie is NOT sent
```

### TanStack Query usage (the frontend side of this contract)

You already have `@tanstack/react-query` installed. The pattern:

```ts
// "Am I logged in?" — one query, used everywhere (replaces the localStorage flag)
const { data, isPending } = useQuery({
    queryKey: ["auth", "me"],
    queryFn: async () => {
        const response = await fetch(`${API_URL}/auth/me`, { credentials: "include" });
        if (response.status === 401) return null; // not logged in
        return (await response.json()).data.user;
    },
});

// Login — a mutation that, on success, refreshes the "me" query
const loginMutation = useMutation({
    mutationFn: (credentials) =>
        fetch(`${API_URL}/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify(credentials),
        }).then((response) => response.json()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["auth", "me"] }),
});
```

Signup, logout, and reset are the same `useMutation` shape pointed at their endpoints.
Logout's `onSuccess` also invalidates `["auth", "me"]`.

---

## 9. Build order — do them in THIS order

Each step is a small, runnable win. Don't skip ahead; each one builds on the last.

0. **Check tools.** `node --version` (you have v26). Install nothing else yet.
1. **Hello server.** `npm init`, install Express + TypeScript (`tsx`), write `GET /health`
   that returns `{ data: { ok: true } }`. Run with `tsx`, open it in the browser. → **Lesson 01**
2. **Database.** Add `better-sqlite3`, create the three tables on boot (§4).
3. **Send OTP.** `POST /auth/otp/send` — generate a 6-digit code, store its hash,
   `console.log` it. (No real email yet.)
4. **Signup.** `POST /auth/signup` — re-verify OTP, `argon2.hash` the password, insert the
   user, create a session, set the cookie.
5. **Login.** `POST /auth/login` — look up user, `argon2.verify`, create session.
6. **Who am I.** `requireAuth` middleware + `GET /auth/me`.
7. **Logout.** `POST /auth/logout` — delete session, clear cookie.
8. **Forgot password.** `POST /auth/password/reset` — reuse OTP with `purpose: "reset"`.
9. **Wire the frontend.** Add `cors`, point the frontend at the API with
   `credentials: "include"`, swap the `localStorage` flag for the `["auth","me"]` query.

### Later (explicitly NOT now)

- Google / Apple OAuth
- Real email delivery (nodemailer, or a provider like Resend/Postmark)
- Rate limiting on `/auth/otp/send` and `/auth/login` (`express-rate-limit`)
- Move SQLite → Postgres for deployment

---

## 10. Security checklist (pin this above your desk)

- [ ] Server re-validates **every** request — the UI's steps prove nothing (§0).
- [ ] Passwords are **argon2-hashed**, never stored or returned in plaintext.
- [ ] OTPs are **hashed, expiring, single-use**, with an attempt limit.
- [ ] Session lives in an **httpOnly** cookie, never in `localStorage`.
- [ ] Login errors are **generic** ("invalid email or password") — don't reveal which.
- [ ] `otp/send` returns the **same response** whether the email exists or not.
- [ ] Request bodies are **shape-validated** before any DB call.
- [ ] No secrets in code — config comes from `.env`, which is **git-ignored**.
- [ ] CORS names the **exact** frontend origin, never `*`, with `credentials: true`.

---

_Your teacher (the agent) can expand any section into a hands-on lesson — just ask._
_Start with `teaching/lessons/0001-first-express-server.html`._
