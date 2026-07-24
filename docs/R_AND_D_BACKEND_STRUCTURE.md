# R_AND_D_BACKEND_STRUCTURE.md — Qatoto Research & Development: Pipeline API

> This document describes the **research & development** contract the Next.js frontend depends
> on, and how it is wired on the Express backend (`/Users/vinitchuri/code/backend/qatoto-backend`).
> It is the sibling of [BACKEND_STRUCTURE.md](BACKEND_STRUCTURE.md) (auth & identity),
> [STORE_BACKEND_STRUCTURE.md](STORE_BACKEND_STRUCTURE.md) (commerce) and
> [STUDIO_BACKEND_STRUCTURE.md](STUDIO_BACKEND_STRUCTURE.md) (video) — same voice, same layering,
> same envelope — scoped to the whole `/research-and-development` surface.
>
> **Goal:** run Qatoto's concept-to-consumer pipeline server-side — post an idea, form a team for
> equity, log daily work, have that work _verified_ into a dynamic equity ledger, raise money into
> escrow, and release it against milestones — with the backend as the only source of truth for
> every number involved.
>
> **Stack (mostly reused):** **Express 5** + **Drizzle ORM** + **PostgreSQL** + **zod** +
> **Cloudinary** (images) + **sharp** + **multer** + **express-rate-limit** + **pg-boss** (the job
> runner, shipped with §6), all already installed. The only genuinely new dependency this domain
> still adds is an **LLM provider** for §8/§9 analysis — **Gemini on the AI Studio free tier**,
> called with plain `fetch`, no SDK. Better Auth already owns identity; this feature owns the
> `/research-projects/*`, `/discovery/*`, `/funding/*` and `/research-programs/*` routes and ~60 new
> tables.
>
> **Status:** the entire R&D frontend is **pure UI over static mocks** —
> [R_AND_D_STRUCTURE.md](R_AND_D_STRUCTURE.md) §10 and every file under
> `src/mocks/research-and-development/` say so explicitly. Every funding figure, equity share,
> escrow row, opportunity score and verification verdict on the surface today is fabricated. The
> R&D domain does **not** exist in the backend at all (greenfield: `src/db/schema.ts` has the auth
> tables plus three commerce tables and nothing else). This doc is the spec the backend-integration
> phase implements.
>
> **Scope:** all ten routes in [R_AND_D_STRUCTURE.md](R_AND_D_STRUCTURE.md) §3, plus Project
> Immortal (§10) and the full Proof-of-Effort mechanism spec'd in
> [PROOF_OF_EFFORT_SPEC.md](PROOF_OF_EFFORT_SPEC.md) (§9). Build order — what ships first and what
> waits — is §16.
>
> ---
>
> ## ⚠️ Read this first — the zero-cost stack
>
> This document was drafted against three paid dependencies. **All three are deferred**, on cost
> grounds, exactly as [STUDIO_BACKEND_STRUCTURE.md](STUDIO_BACKEND_STRUCTURE.md) deferred Livepeer
> for the Creator Studio. What ships instead:
>
> | Concern                                  | Drafted (deferred)             | **Ships now**                                                                                                                                                                                                      |
> | ---------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
> | Daily-log video (§8)                     | Livepeer direct upload         | **An optional pasted YouTube link**, parsed to an 11-char id and proven with one free oEmbed call. A log may also be text-only.                                                                                    |
> | Workshop files (§8), papers (§10)        | S3-compatible presigned upload | **An external link** to a host allowlist (Drive, Dropbox, GitHub, OneDrive, Figma, Notion). The backend stores a URL.                                                                                              |
> | Transcription + claim extraction (§8/§9) | Whisper-class ASR + a paid LLM | **Gemini, AI Studio free tier**, one structured call per log. No key configured → the analysis records `skipped_unconfigured`.                                                                                     |
> | Escrow money movement (§7)               | Stripe Connect + Treasury      | **A ledger-only provider adapter with manual settlement.** The double-entry ledger, four-eyes release, hash chain and reconciliation are all built for real; only the outbound cash call is stubbed behind a seam. |
>
> **The backend still never touches video bytes, file bytes or customer funds.** That was already
> true of the drafted design for video; it is now true of all three.
>
> **What must NOT be built:** the Livepeer upload/transcode/playback-token path, the S3 presigned
> upload + `/complete` + `HEAD`-sizing path, the three signature-verified webhook routes
> (`/webhooks/livepeer`, `/webhooks/object-storage`, `/webhooks/payments/stripe`), and the Stripe
> SDK. All of it is preserved in **[Appendix A](#appendix-a--deferred-paid-infrastructure)** so
> switching back is a re-read, not a redesign.
>
> **Forward compatibility is in the schema, not in a promise.** `workshop_file.source` carries a
> `hosted` variant beside `external_link`, `daily_log.videoSource` carries `hosted` beside `youtube`
> and `none`, and `storageProvider` / `objectKey` sit nullable and unwritten — the same shape the
> studio domain uses for `videoSourceEnum` + the dead provider columns. No table drop, no rename.
>
> **Where a section below still says Livepeer, S3 or Stripe as if it ships,** the amended text in
> §2, §4e, §7, §8, §10 and §11 wins, and the original wording is in Appendix A.

---

## 0. The one rule that governs everything

**The frontend is a hostile, untrusted presentation layer. The backend is the only source of
truth.** (Same NON-NEGOTIABLE principle as [CLAUDE.md](CLAUDE.md) §"thin client",
BACKEND_STRUCTURE.md §0 and STORE §0, applied to equity and money.)

Anyone can open DevTools, decompile the Android APK, or point `curl` at the API. So for every
mutation the backend **re-checks everything, every request, by itself**:

- **Identity is server-derived.** Every actor id comes from `req.user.id` (§4a), **never** from a
  request body. A project's `founderUserId`, a pledge's `backerUserId`, a claim's `memberUserId`
  are all stamped from the session.
- **No request body ever carries a value the server owns.** Not a price, not an equity share, not
  a slice count, not an hour count, not a fair-market rate, not an opportunity score, not a
  verification verdict, not a status. The client sends **ids and intent**; the server looks the
  real value up in its own rows. This is the rule that answers _"what if the client edits $1,000
  into ¥10 and posts it back?"_ — there is no field to edit. `POST
/funding-rounds/:roundId/pledges` accepts exactly `{ amountInCents }` and still re-bounds it
  against the round's own min/max; `POST /milestones/:milestoneId/escrow-releases` accepts **no
  amount at all** and snapshots `milestone.escrowReleaseAmountInCents` server-side at request time.
- **Equity is computed, never asserted.** A member's share is the output of the Slicing Pie formula
  (§9) over verified contributions. There is no writable `equityShare` column anywhere in this
  schema and no endpoint that sets one. A founder cannot type a number into someone's stake.
- **Every project-scoped route re-checks membership**, not just a session (§4a). Failure is
  **`404`**, not `403` — a stranger must not be able to probe which project ids exist.
- **Money never touches a float** and never leaves int4 range (§4b). Arithmetic is integer-only and
  runs through one shared module so two servers compute bit-identical results (§4c).
- **Financial and audit history is append-only and never cascades** (§4f). Deleting a user must not
  be able to erase a ledger.
- **Validate the shape of every body/query** with Zod `.safeParse()` → `422`, using `.strict()` to
  reject unknown keys (the prevailing controller style in this backend).

If you remember nothing else from this file, remember §0.

---

## 1. What the frontend expects

Ten routes, all under `(home)`, all rendering mocks today. The contract each one needs:

| Route                                                    | Surface                    | Needs from the backend                                                  |
| -------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------- |
| `/research-and-development`                              | Pipeline landing           | Project rail, top problem clusters, market insights, open roles         |
| `/research-and-development/new`                          | 4-step idea wizard         | Create a `draft` project from `NewIdeaDraft`                            |
| `/research-and-development/project/[id]`                 | Detail, 5 tabs             | Project + team + milestones + daily logs + funding + escrow ledger      |
| `/research-and-development/project/[id]/workshop`        | Boards / Files / Chat      | Kanban, file store, team chat                                           |
| `/research-and-development/project/[id]/proof-of-effort` | Slicing Pie ledger, 5 tabs | Slice breakdown, verification runs, disputes, optimization, audit trail |
| `/research-and-development/problem-map`                  | Civic Pulse                | Problem clusters with geo + opportunity scores                          |
| `/research-and-development/knowledge-hub`                | Market intel               | Insights + demand-signal leaderboard                                    |
| `/research-and-development/talent`                       | Talent directory           | Filterable talent profiles + open roles                                 |
| `/research-and-development/funding`                      | Investor deal flow         | Open rounds + investor-confidence signal                                |
| `/research-and-development/projects/project-immortal`    | Moonshot program           | Branch tree, papers, posts, ideas, contributors, stats                  |

### The wire-format contract

The frontend types today carry **pre-formatted display strings** — `"$6,000"`, `"62%"`,
`"148 hrs"`, `"1.8 MB"`, `"Locks in 9h 14m"`. Every file header under
`src/types/research-and-development/` states this as deliberate: _"every figure arrives as a
pre-computed display string."_

**That changes.** The backend sends **raw integers in explicitly named units**, and each client
formats:

| Kind         | Wire field     | Unit                                                        |
| ------------ | -------------- | ----------------------------------------------------------- |
| Money        | `…InCents`     | integer cents, always with an ISO 4217 `currency` alongside |
| Equity       | `…BasisPoints` | integer basis points, `10000` = 100%                        |
| Effort       | `…Minutes`     | integer minutes                                             |
| File size    | `…Bytes`       | integer bytes                                               |
| Score        | `…Points`      | integer, stated range                                       |
| Instant      | `…At`          | ISO-8601 UTC                                                |
| Calendar day | `…Date`        | ISO-8601 date-only `YYYY-MM-DD`                             |

Three reasons this is not negotiable:

1. **Three first-class clients.** Web, native Kotlin/Android, and native Swift/iOS. Native clients
   format money and dates through `NumberFormatter` / `RelativeDateTimeFormatter` /
   `android.icu.text`. A server-rendered `"$6,000"` ships USD and English to every device on earth
   and cannot be localized downstream.
2. **Sorting and filtering.** A string `"$1,450"` cannot be compared, summed, or ranked. The
   server does the heavy queries (§0, CLAUDE.md §"Performance"), but the client still needs
   numbers for progress-bar widths and local ordering.
3. **Durations are stale on arrival.** `"Locks in 9h 14m"` is wrong the moment it is serialized.
   The server sends `locksAt`; the client counts down.

§15 lists every frontend type that must change shape as a result.

> **This is not the security mechanism.** Sending raw numbers does not stop tampering — §0 does.
> The client never sends money back at all, so there is nothing for it to falsify. The wire format
> is a localization and correctness decision; the value-integrity decision is §0.

---

## 2. The stack

Most of this is already installed for auth, store and studio. One addition is genuinely new — the
LLM provider. The other two rows the first draft called new (object storage, payments) are
**deferred to [Appendix A](#appendix-a--deferred-paid-infrastructure)** and replaced by a link and a
ledger seam respectively.

| Concern           | Pick                                      | Why / reuse                                                                                                                                                                                                                                                                                                                   |
| ----------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server framework  | **Express 5**                             | Same app, four more routers.                                                                                                                                                                                                                                                                                                  |
| Language          | **TypeScript** (strict, ESM `#src/*`)     | Shared shapes with the frontend.                                                                                                                                                                                                                                                                                              |
| Database ORM      | **Drizzle ORM**                           | New tables in `src/db/schema.ts`; `pnpm db:generate && db:migrate`.                                                                                                                                                                                                                                                           |
| Database          | **PostgreSQL** via `pg`                   | FKs, enums, partial + unique indexes, `bigint` money.                                                                                                                                                                                                                                                                         |
| Validation        | **zod**                                   | Inline `.safeParse()` in the controller → `422` (prevailing style).                                                                                                                                                                                                                                                           |
| Image storage     | **Cloudinary** (`src/lib/cloudinary.ts`)  | Project covers, avatars — reuse the product-image helpers.                                                                                                                                                                                                                                                                    |
| Image processing  | **sharp** (`src/lib/image.ts`)            | Reuse `validateAndNormalizeImage`; also the EXIF reader for §9 receipt forensics.                                                                                                                                                                                                                                             |
| Daily-log video   | **A YouTube link** (`src/lib/youtube.ts`) | Reuse the STUDIO §9 path verbatim: parse the URL to an 11-char id, prove it with one free oEmbed call, store the id. The backend never touches video bytes, and neither does any provider we pay. Video is **optional** — a log may be text-only.                                                                             |
| Rate limiting     | **express-rate-limit**                    | New named limiters per §4a.                                                                                                                                                                                                                                                                                                   |
| **Job runner**    | **pg-boss**                               | Postgres-backed queue, installed with §6. Same database, same transaction, no new infrastructure. §8 and §9 cannot exist without it.                                                                                                                                                                                          |
| **LLM analysis**  | **Gemini, AI Studio free tier** ⟵ NEW     | One structured-output call per daily log returns the transcript, the summary chips and the extracted claims together — two jobs would be two calls against a free quota. Plain `fetch`, no SDK, injectable for tests, `temperature: 0`. Absent key → `skipped_unconfigured`, never a fabricated verdict.                      |
| Workshop files    | **An external link**                      | Deferred from S3 on cost. The member pastes a Drive/Dropbox/GitHub/OneDrive/Figma/Notion URL; the server allowlists the host and stores the URL. `sizeBytes` is **NULL**, never a client claim. `source = 'hosted'` + `objectKey` stay in the schema, unwritten, for [Appendix A](#appendix-a--deferred-paid-infrastructure). |
| Payments / escrow | **A ledger-only provider adapter**        | Deferred from Stripe. §7's double-entry ledger, four-eyes release, hash chain and reconciliation are built for real; settlement flips through an internal, auditor-gated adapter instead of a card network. Qatoto still custodies nothing — it moves no money at all yet.                                                    |

**Money is integer cents everywhere, in `bigint` columns** (§4b). **Equity is integer basis
points.** No `numeric`, no floats, ever.

---

## 3. Folder structure (additions)

Following the existing route → controller → service → db layering:

```text
qatoto-backend/
├── src/
│   ├── db/
│   │   └── schema.ts                          # + ~60 R&D tables, enums, relations (§4d, §5–§10)
│   ├── routes/
│   │   ├── research-projects.routes.ts        # NEW — projects, team, roles, applications, invites
│   │   ├── discovery.routes.ts                # NEW — problem clusters, insights, signals, talent
│   │   ├── funding.routes.ts                  # NEW — rounds, pledges, milestones, escrow
│   │   ├── workshop.routes.ts                 # NEW — board, files, chat, daily logs
│   │   ├── proof-of-effort.routes.ts          # NEW — slice ledger, claims, disputes, audit
│   │   ├── research-programs.routes.ts        # NEW — Project Immortal
│   │                                          # NO webhooks.routes.ts — nothing signature-
│   │                                          # verified ships; see Appendix A
│   ├── controllers/                           # NEW — one per router above
│   ├── services/
│   │   ├── research-projects.service.ts       # NEW
│   │   ├── project-membership.service.ts      # NEW — requireProjectRole lives here (§4a)
│   │   ├── discovery.service.ts               # NEW
│   │   ├── funding.service.ts                 # NEW
│   │   ├── escrow.service.ts                  # NEW — append-only ledger + hash chain
│   │   ├── workshop-board.service.ts          # NEW — columns, tasks, lexicographic ranks (§8)
│   │   ├── workshop-files.service.ts          # NEW — external links, host allowlist (§8)
│   │   ├── workshop-chat.service.ts           # NEW — keyset chat + read state (§8)
│   │   ├── daily-logs.service.ts              # NEW — drafts, YouTube attach, submit (§8)
│   │   ├── slicing-pie.service.ts             # NEW — the deterministic equity formula (§9)
│   │   ├── verification.service.ts            # NEW — the 4-step pipeline (§9)
│   │   └── research-programs.service.ts       # NEW
│   ├── middleware/
│   │   ├── require-identified-user.ts         # NEW — requireAuth is NOT enough (§4a)
│   │   ├── rate-limit.ts                      # + ~12 new named limiters (§4a)
│   │                                          # NO new upload-*.ts: workshop files are links
│   ├── lib/
│   │   ├── auth.ts                            # + bearer() plugin, multi-origin passkey (§4a)
│   │   ├── money.ts                           # NEW — THE one arithmetic module (§4c)
│   │   ├── canonical-hash.ts                  # NEW — the audit chain hash (§4c)
│   │   ├── jobs.ts                            # NEW — pg-boss bootstrap + job registry (§4e)
│   │   ├── youtube.ts                         # REUSED from the studio domain (§8)
│   │   ├── gemini.ts                          # NEW — the one LLM call, structured output (§8)
│   │   ├── lexorank.ts                        # NEW — kanban rank strings, COLLATE "C"-safe (§8)
│   │   ├── external-link.ts                   # NEW — file-link host allowlist (§8)
│   │   └── daily-log-streak.ts                # NEW — the pure streak fold (§8)
│   ├── jobs/                                  # NEW — one file per scheduled/async worker (§4e)
│   └── app.ts                                 # + 6 routers. No raw-body mount: no webhooks
```

`req.user` is attached by `requireAuth` (`src/middleware/require-auth.ts`) and typed via the ambient
augmentation in `src/types/express.d.ts` — but see §4a, because `requireAuth` alone is **not** a
sufficient guard for this domain.

---

## 4. Shared foundations — declared ONCE

> **Why this section exists.** This contract was drafted domain-by-domain and the drafts collided
> hard: `project_member` was defined three times with three different role enums;
> `project_governance_role` was defined as _both_ a `pgEnum` and a `pgTable` (Postgres puts them in
> one namespace — the migration simply fails); `compensation_kind` appeared three times, kebab-case
> in one draft and snake_case in two; and the Slicing Pie formula was written three ways, all three
> non-deterministic.
>
> Everything cross-cutting is therefore declared here and **only** here. §5–§10 reference these; no
> domain section re-declares a shared enum, a shared table, or a shared rule.

### 4a. Identity & authorization

Today the backend has exactly one guard, `requireAuth`, and no roles of any kind. This domain needs
three layers.

**Layer 1 — `requireAuth` does not prove a human.** `src/lib/auth.ts` registers the `anonymous()`
plugin. An anonymous sign-in creates a real session row, so `auth.api.getSession` resolves,
`requireAuth` attaches `req.user` and calls `next()`. Every endpoint that moves money, mints equity,
or contributes to a distinct-count is therefore wide open to unlimited throwaway identities —
`problem_cluster.distinctReporterCount` (§6), which is the entire sybil-resistance of the Civic
Pulse opportunity score, is the clearest casualty.

```ts
// src/middleware/require-identified-user.ts — NEW
// requireAuth proves "a session exists". This proves "a real, accountable account exists":
// the user must have at least one non-anonymous `account` row (credential, google, github,
// or passkey). Fails with 403, NOT 401 — the caller HAS a session, it is just not enough.
export async function requireIdentifiedUser(req, res, next): Promise<void> {
    /* … */
}
```

Apply it to every write touching money, equity, effort, a distinct-count, or a uniqueness quota:
pledges, escrow, daily logs, effort logs, problem reports, applications, invites, papers, posts,
reactions.

**Layer 2 — per-project roles, stored as data.** There is no RBAC middleware and this domain should
not invent one, because a middleware cannot return a `Result` and so cannot participate in the
controller's exhaustive error switch (CLAUDE.md §3.2/§3.3). Authorization is a **service helper**:

```ts
// src/services/project-membership.service.ts — NEW. The single authorization entry point
// for every project-scoped route in §5–§9.
export async function requireProjectRole(
    projectId: string,
    userId: string,
    minimumRole: ProjectMemberRole,
): Promise<Result<ProjectMemberContext, ProjectError>>;
// Not a member, or below `minimumRole`, or the project does not exist → the SAME
// { type: "NOT_FOUND" } error → 404. A stranger cannot distinguish the three cases.
```

**Layer 3 — platform roles**, for the handful of staff actions (category moderation, content
moderation, escrow audit). A single nullable `user.platformRole` column, checked in-service.

```ts
// The ONLY per-project role enum. Supersedes the three colliding drafts.
export const projectMemberRoleEnum = pgEnum("project_member_role", [
    "founder", // row owner: edit project, stage, publish/archive, remove members, request escrow
    "admin", // co-signer: approve escrow releases (four-eyes, §7), triage applications
    "maintainer", // create/edit roles, triage applications, manage the workshop board
    "contributor", // post daily logs, read private project surfaces
]);

export const projectMemberStatusEnum = pgEnum("project_member_status", [
    "active", // counts toward the roster and the equity pool
    "left", // self-departed
    "removed", // removed by a founder
]);

// Platform-wide, not project-scoped. NULL for ordinary users.
export const platformRoleEnum = pgEnum("platform_role", ["moderator", "auditor", "admin"]);
```

> **Membership is never hard-deleted.** A departed member's slices, daily logs and ledger postings
> still reference the row, and PROOF_OF_EFFORT_SPEC.md §2 (the Trust Protocol) requires their
> historical equity stay auditable. `left`/`removed` are states, not deletions.

**The four-eyes rule and how not to break it.** Escrow release requires two distinct people (§7).
That is defeated if a founder can simply grant themselves the second role — so `admin` grants are
**not** self-serviceable: a founder cannot grant `admin` to themselves, and the approver of a
release must not be its requester. Both are checked in `escrow.service.ts`, not in the UI.

**Native clients (Kotlin / Swift) cannot authenticate today.** Four separate blockers in
`src/lib/auth.ts`, all of which must be fixed before any native client ships:

| Blocker           | Today                                                            | Fix                                                                                                                                                               |
| ----------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session transport | `requireAuth` resolves a session from a **cookie** only          | Register Better Auth's `bearer()` plugin; native clients send `Authorization: Bearer <token>` and store it in Keychain / EncryptedSharedPreferences               |
| Passkeys          | `passkey({ rpID, origin })` — single-valued, from `FRONTEND_URL` | `origin` must accept an array: the web origin, Android's `android:apk-key-hash:…`, and the iOS associated-domain origin                                           |
| OAuth             | `trustedOrigins: [FRONTEND_URL]` — one element                   | Must include the native deep-link schemes, or every native social sign-in callback is rejected                                                                    |
| Body size         | `express.json({ limit: "10kb" })` global                         | Several R&D payloads exceed it and would throw Express's raw `PayloadTooLargeError`, bypassing the `ApiResponse` envelope entirely. Raise per-route, not globally |

**New rate limiters** (`src/middleware/rate-limit.ts`), all per-user:

`projectCreateLimiter` · `applicationCreateLimiter` · `inviteCreateLimiter` ·
`problemReportLimiter` · `categoryCreateLimiter` · `pledgeLimiter` ·
`dailyLogSubmitLimiter` · `workshopFileUploadLimiter` · `chatMessageLimiter` ·
`paperUploadLimiter` · `postCreateLimiter` · `reactionLimiter` · `disputeLimiter`

### 4b. Units, money and the `bigint` policy

Restating §1 as a schema rule, plus the two traps:

- **Money is `bigint`, not `integer`.** Drizzle's `integer` is Postgres `int4`, which caps at
  ±2,147,483,647 — **±$21,474,836.47**. A single Series-A round or Project Immortal's
  `estimatedMarketSizeInCents` (`"$12B est. market"`=`1200000000000`, 560× the ceiling) overflows
  it. This must be right on day one, because the escrow hash chain (§4c) covers posting amounts:
  widening the column later invalidates every historical hash.
- **Equity is `integer` basis points.** `10000` = 100%. Basis points give 0.01% resolution, which
  is finer than any cap table needs and keeps the sum exact.
- **An amount is never sent or displayed without its currency.** Every response carrying cents
  carries the ISO 4217 code. Every amount input in a client renders a server-fetched,
  **non-editable** currency adornment. There is no `currency` field in any request body — it is
  derived from the round/project, exactly as `product.currency` is server-owned in STORE §4.

### 4c. Determinism

Two servers, or one server run twice, must produce **bit-identical** integers. Equity and audit
hashes are worthless otherwise — and PROOF_OF_EFFORT_SPEC.md §2 makes determinism the entire
product argument ("financial determinism vs LLM hallucination"). Four rules:

**1. One arithmetic module.** Every derived integer in this domain goes through `src/lib/money.ts`:

```ts
// src/lib/money.ts — NEW. The ONLY place division, rounding or apportionment happens.
export function divRoundHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint;

/**
 * Apportion `total` across `weights` by the largest-remainder method, so the parts sum to
 * EXACTLY `total` — never 9,999 or 10,001 basis points. Ties break on `tieBreakKeys`
 * (ascending, byte-wise) so the result never depends on row order.
 */
export function apportionLargestRemainder(
    weights: readonly bigint[],
    total: number,
    tieBreakKeys: readonly string[],
): readonly number[];

export function basisPointsOf(part: bigint, whole: bigint): number;
```

`Math.round` / `Math.floor` are **banned** on any apportioned or signed quantity (JS rounds
`-0.5` to `-0`; Postgres `round()` is half-away-from-zero; they disagree). Money and equity
arithmetic in SQL is **banned** — SQL aggregates raw integers, TypeScript does every division.

**2. No float ever touches money, equity, slices, coordinates or ratios.** The specific traps found
in drafting: `unpaidMinutes / 60` (float division — a 20-minute log yields `0.333…`), `exp(-age /
halfLife)` in score decay, haversine distances in cluster centroids, and running-mean centroid
updates. Each is replaced by integer arithmetic, or by a documented integer quantization applied
exactly once at the boundary.

**3. Every job is a pure function of `(data, asOf)`.** Jobs take an explicit quantized reference
instant, store it on every row they write, store **absolute** window bounds (`windowStartsAt` /
`windowEndsAt`) rather than day counts, and re-run to an identical result (§4e).

**4. Every `ORDER BY` that feeds pagination, ranking, or a hash ends in a unique column.** An
unstable sort makes a hash chain non-reproducible and a cursor skip rows.

**Canonical hashing.** `src/lib/canonical-hash.ts` defines the one serialization used by both hash
chains (escrow §7, audit §9):

- SHA-256 over UTF-8.
- Keys emitted in a **fixed declared order**, never `JSON.stringify` insertion order.
- Integers as decimal strings; instants as ISO-8601 UTC with fixed precision; `null` explicit.
- Child collections (e.g. postings) sorted by a documented unique key before serialization.
- A `hashVersion` column on every chained row, so the algorithm can evolve without invalidating
  history.
- Hashes are stored and compared **full-length** (64 lowercase hex chars). The 6-character form the
  mocks show (`"c7d9a1"`) is a _rendering_: at 24 bits, collisions hit 50% around 4,800 entries. It
  must never be used as a key, a cache key, or an equality test.

### 4d. Shared enums

Declared once, in `src/db/schema.ts`, above the domain tables. **All enum values are `snake_case`**,
matching the existing `product_category` precedent (`home_kitchen`). The frontend's shipped unions
use kebab-case (`"full-time"`, `"one-time"`, `"market-research"`) — renaming them is a required
frontend edit, listed in §15. One spelling, everywhere, is worth a one-line union change.

```ts
export const projectStageEnum = pgEnum("project_stage", [
    "market_research",
    "problem_validation",
    "team_building",
    "building_mvp",
    "raising_funding",
    "go_to_market",
]);

export const roleCommitmentEnum = pgEnum("role_commitment", ["full_time", "part_time", "hobby"]);

export const compensationKindEnum = pgEnum("compensation_kind", ["salary", "one_time", "equity"]);

// Replaces CompensationComponent.earnedAsLabel free prose. Shipping English sentences from the
// server forces three native clients to render un-localizable strings, and lets a founder write
// a payout promise the escrow engine will not honour. Clients map enum → localized copy.
export const compensationEarnedAsPolicyEnum = pgEnum("compensation_earned_as_policy", [
    "milestone_escrow_release",
    "on_completion_escrow_release",
    "slicing_pie_vesting",
]);

// The ONE verification status, shared by daily logs (§8), claims (§9) and effort logs (§10).
// Supersedes two colliding drafts with near-disjoint values.
export const effortVerificationStatusEnum = pgEnum("effort_verification_status", [
    "not_run", // no claim submitted yet
    "queued", // enqueued, worker has not started
    "running", // pipeline in flight
    "verified", // all four steps passed → slices awarded
    "flagged_for_review", // a step flagged → allocation withheld pending human review
    "unverified", // no digital receipts → zero slices (SPEC §4 step 2)
]);

export const trendDirectionEnum = pgEnum("trend_direction", ["up", "down", "flat"]);
```

### 4e. The job runner

Nothing in this repo runs scheduled or background work today. §6, §7 and §9 all require it —
verification alone involves transcription, LLM extraction, git API fan-out, AST parsing and image
forensics, none of which can run inside an HTTP request.

**pg-boss**, because it is Postgres-backed: the same database, enlisted in the same transaction, no
new infrastructure to operate.

| Job                             | Cadence              | Purpose                                            |
| ------------------------------- | -------------------- | -------------------------------------------------- |
| `cluster-problem-submission`    | on submit            | Attach a raw submission to a problem cluster (§6)  |
| `recompute-opportunity-scores`  | nightly              | Civic Pulse ranking (§6)                           |
| `recompute-demand-signals`      | nightly              | Knowledge-hub leaderboard (§6)                     |
| `refresh-talent-projections`    | hourly               | Talent directory denormalization (§6)              |
| `reconcile-escrow-ledger`       | hourly               | Provider ↔ ledger reconciliation (§7)              |
| `recompute-investor-confidence` | nightly              | Deal-flow signal (§7)                              |
| `analyze-daily-log`             | on submit            | One Gemini call → transcript + chips + claims (§8) |
| `recompute-daily-log-streaks`   | nightly              | Decay the streak counter on `project_stats` (§8)   |
| `verify-effort-claim`           | on submit            | The 4-step pipeline (§9)                           |
| `recompute-slicing-pie`         | nightly + on verdict | The equity ledger (§9)                             |
| `sweep-dispute-windows`         | every minute         | Lock expired 24h windows (§9)                      |
| `recompute-program-stats`       | nightly              | Project Immortal stats (§10)                       |

Every job: an **idempotency key**, bounded retries with exponential backoff, a dead-letter state,
and the `(data, asOf)` purity rule from §4c. A job that cannot be safely re-run is a bug.

### 4f. Append-only and cascade policy

Two of the drafts wired `onDelete: "cascade"` from `user` → `research_project` → `milestone` →
`escrow_release`, which means **deleting one user account silently erases a financial ledger**. One
draft correctly set a ledger's `participantId` to `restrict` and then set `programId` on the same
row to `cascade`, defeating it entirely.

The policy:

- **Financial and audit tables never cascade.** `escrow_journal_entry`, `escrow_posting`,
  `escrow_release`, `provider_transfer`, `funding_round_pledge`, `project_audit_entry`,
  `slice_ledger_entry`, `research_contribution_ledger_entry` use `restrict` on every parent FK.
  A project or user with financial history cannot be hard-deleted — it is archived.
- **Append-only means no `UPDATE` and no `DELETE`.** Enforced with a Postgres trigger plus a
  restricted role, not merely by service-layer discipline. Corrections are **reversing entries**,
  never edits.
- **Content tables cascade normally** (workshop tasks, chat messages, board columns).
- **Taxonomy uses `set null`** — deleting a user must not delete a category every other project
  points at.

---

## 5. The data — projects, team, roles, applications

### An idea IS a project

There is **no `idea` table**. An idea is a `research_project` with `status = 'draft'`.

The `/new` wizard's `NewIdeaDraft` fields are a strict subset of `research_project`'s columns, so a
separate table would duplicate nine columns and then need a copy-on-promote migration. Worse,
promotion would mint a **new id**, breaking the slug/URL identity and orphaning every watcher and
problem-report backlink accrued while it was an idea. STORE §4 already established exactly this
shape (`product.status` `draft|active`, publish gated server-side); reusing it means zero new
vocabulary.

Note that `stage` (the six-value pipeline position) is **orthogonal** to `status` (the lifecycle). A
`draft` project still has a stage. Do not conflate them by adding an "idea" seventh stage — that
would make `ProjectStage` a leaky union the shipped frontend does not have.

### Enums

```ts
export const researchProjectStatusEnum = pgEnum("research_project_status", [
    "draft", // the wizard's output; visible only to its founder. This IS the "idea".
    "active", // published; publicly readable; appears in the landing rail
    "archived", // withdrawn but preserved — members, slices and escrow history reference it
]);

export const openRoleStatusEnum = pgEnum("open_role_status", ["open", "closed", "filled"]);

export const projectApplicationKindEnum = pgEnum("project_application_kind", [
    "role_interest", // apply-role-sheet, fired from an OpenRole card
    "join_request", // project-header "Request to join", no role attached
]);

export const projectApplicationStatusEnum = pgEnum("project_application_status", [
    "pending",
    "accepted",
    "declined",
    "withdrawn",
    "expired",
]);

export const projectInviteStatusEnum = pgEnum("project_invite_status", [
    "pending",
    "accepted",
    "declined",
    "revoked",
    "expired",
]);

export const researchCategoryStatusEnum = pgEnum("research_category_status", [
    "approved",
    "pending",
    "rejected",
]);
```

`project_stage`, `role_commitment`, `compensation_kind`, `compensation_earned_as_policy`,
`project_member_role` and `project_member_status` are declared in §4d and **not** re-declared here.

### `research_category`

A **table**, not a `pgEnum`, because the wizard's step 1 explicitly lets a user create a category
(`idea-basics-step.tsx` handles the "made a new one" case). A client-writable taxonomy is a spam
surface, so user-minted rows land `pending` and are excluded from public filter facets until
approved (§4a Layer 3 moderation).

```ts
export const researchCategory = pgTable(
    "research_category",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => randomUUID()),
        // Server-generated from `label` (lowercased, hyphenated). The stable ?category= filter
        // key across all three clients.
        slug: text("slug").notNull().unique(),
        // Display label as typed, e.g. "Cold Chain". Clients render this, never the slug.
        label: text("label").notNull(),
        // Server-owned. Seeded rows insert `approved`; user-minted rows `pending`.
        status: researchCategoryStatusEnum("status").default("pending").notNull(),
        // NULL for seeded rows. `set null`, NOT cascade (§4f) — deleting a user must not delete
        // a taxonomy every other project points at.
        createdByUserId: text("created_by_user_id").references(() => user.id, {
            onDelete: "set null",
        }),
        createdAt: timestamp("created_at").defaultNow().notNull(),
    },
    (table) => [
        uniqueIndex("research_category_slug_unq").on(table.slug),
        index("research_category_status_idx").on(table.status),
    ],
);
```

> **Seed drift to reconcile.** The wizard's `IDEA_CATEGORIES` (Agriculture, Clean Energy,
> Healthcare, Housing, Logistics, Manufacturing, Water) and the categories the six mock projects
> actually use (Cold Chain, Water & Sanitation, Precision Agriculture, Housing, E-Waste &
> Recycling, Medical Logistics) **do not overlap**. The seed must reconcile them.

### `research_project`

The central entity.

```ts
export const researchProject = pgTable(
    "research_project",
    {
        // INTERNAL identity. FK target for every child table. Never a URL path segment.
        id: text("id")
            .primaryKey()
            .$defaultFn(() => randomUUID()),
        // PUBLIC identity — the [id] segment of /research-and-development/project/[id] and the
        // value generateStaticParams emits. SERVER-GENERATED from `name` (slugify + -2/-3
        // collision suffix); there is no slug field in any request body. Mutable only while
        // status='draft'; FROZEN at publish (a live slug change 404s every external link and
        // every prebuilt static page).
        slug: text("slug").notNull().unique(),
        // OWNER — the exact analogue of product.sellerId. Stamped from req.user.id, never the
        // body. Replaces the mock's founderId, which held a person-slug ("wanjiru-kamau").
        founderUserId: text("founder_user_id")
            .notNull()
            .references(() => user.id, { onDelete: "restrict" }),
        name: text("name").notNull(), // ← NewIdeaDraft.ideaName, 1–120
        tagline: text("tagline").notNull(), // ← NewIdeaDraft.oneLinePitch, 1–200
        description: text("description"), // NULL on a fresh draft — not in the publish gate
        problemStatement: text("problem_statement"), // ← problemItSolves; required to publish
        solutionSummary: text("solution_summary"), // wizard never collects it — §14 gap
        targetRegion: text("target_region"), // ← targetRegion
        // The founder's OWN claim about demand. Explicitly NOT the verified demand signal the
        // knowledge hub computes (§6) — keep the two visually distinguishable on read so an
        // assertion is never mistaken for platform-verified evidence.
        demandEvidenceNotes: text("demand_evidence_notes"),
        // `restrict`, not cascade — removing a category must not delete every project in it.
        categoryId: text("category_id")
            .notNull()
            .references(() => researchCategory.id, { onDelete: "restrict" }),
        // Founder-settable, but ONLY via PATCH /:slug/stage, which writes an audit row — never
        // as a field on the general PATCH.
        stage: projectStageEnum("stage").default("market_research").notNull(),
        // SERVER-OWNED. No request schema contains `status`; .strict() rejects it. Changed only
        // by /publish, /unpublish, /archive.
        status: researchProjectStatusEnum("status").default("draft").notNull(),
        // Written only by POST /:slug/cover after the sharp decode/re-encode pipeline. There is
        // no coverImageUrl field in any JSON body — a client-supplied URL is an SSRF and
        // hotlink vector.
        coverImageUrl: text("cover_image_url"),
        // Deterministic: qatoto/research-projects/<projectId>/cover — re-upload is idempotent.
        coverImagePublicId: text("cover_image_public_id"),
        // ← NewIdeaDraft.rolesNeeded[]. A text[] column, not a table — same altitude call as
        // product.keyFeatures. This is wizard INTENT; at publish the service materializes one
        // project_open_role per entry, after which the column is historical.
        seedRolesNeeded: text("seed_roles_needed").array().notNull().default([]),
        // REPLACES NewIdeaDraft.equityToOffer free text ("2–4% per role"). Integer BASIS POINTS.
        // Permitted in a request body: this is the founder's own declared OFFER (like a seller
        // setting priceInCents), not a server-computed grant. Bounded 0..10000, min <= max.
        offeredEquityBasisPointsMin: integer("offered_equity_basis_points_min"),
        offeredEquityBasisPointsMax: integer("offered_equity_basis_points_max"),
        expectedCommitment: roleCommitmentEnum("expected_commitment"),
        // NOTE: there is deliberately NO reserveEquityBasisPoints column. The mock's 19.5%
        // "unallocated" segment is NOT persisted as a reserve — see §9.5, which rejects the
        // reserve pool outright and replaces it with a computed open-role projection.
        // ← originProblemReportId, drives the "Born from Civic Pulse report" chip. Promote to a
        // real .references(() => problemCluster.id) in the migration that creates §6.
        originProblemClusterId: text("origin_problem_cluster_id"),
        publishedAt: timestamp("published_at"),
        archivedAt: timestamp("archived_at"),
        createdAt: timestamp("created_at").defaultNow().notNull(),
        updatedAt: timestamp("updated_at")
            .defaultNow()
            .$onUpdate(() => new Date())
            .notNull(),
    },
    (table) => [
        uniqueIndex("research_project_slug_unq").on(table.slug),
        index("research_project_founderUserId_idx").on(table.founderUserId),
        index("research_project_status_idx").on(table.status),
        // The landing rail + funding-page filter
        index("research_project_status_stage_idx").on(table.status, table.stage),
        index("research_project_categoryId_idx").on(table.categoryId),
        // Default "recent" ordering of the discovery feed
        index("research_project_status_publishedAt_idx").on(table.status, table.publishedAt),
    ],
);
```

> **`founderUserId` is `restrict`, not `cascade`** (§4f). A cascade here reaches
> `milestone → escrow_release` and lets a single account deletion erase a financial ledger.

### `project_stats` — the counter sidecar

A 1:1 sidecar, created in the same transaction as its project row.

**Why a sidecar and not columns on `research_project`:** that table's `updatedAt` uses `$onUpdate`,
so putting `watchersCount` on it would bump `updatedAt` every time a stranger taps the watch button
— poisoning the "recently updated" ordering, every cache key derived from `updatedAt`, and
generating index churn on the hottest row in the domain. Cold entity row + hot stats row is the
correct split, and the 1:1 join is on the primary key, so it is effectively free.

| Column                       | Type                   | Notes                                                                                                                                                                                                                                                             |
| ---------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projectId`                  | `text` PK + FK cascade | Exactly one stats row per project                                                                                                                                                                                                                                 |
| `watchersCount`              | `integer`              | **Counter column**, not computed-on-read. `project_watcher` stays the source of truth; this is a rebuildable cache. Incremented in the _same transaction_ as the watcher insert, reconciled nightly against `COUNT(*)`                                            |
| `teamMemberCount`            | `integer` default 1    | Active members. Defaults to 1 — the founder row is inserted at create                                                                                                                                                                                             |
| `openRoleCount`              | `integer`              | Drives the ProjectCard badge                                                                                                                                                                                                                                      |
| `pendingApplicationCount`    | `integer`              | Founder-facing only; never in the public projection                                                                                                                                                                                                               |
| `dailyLogStreakDays`         | `integer`              | **Job-computed and stored.** A streak is a temporal fold over the whole log history _and it decays with wall-clock time_ — it silently drops at midnight with no write happening. Written by the log-ingest transaction and by a nightly decay job                |
| `lastDailyLogDate`           | `date`                 | The decay job's input                                                                                                                                                                                                                                             |
| `projectTimeZone`            | `text` default `"UTC"` | IANA zone. Without it "a day" is undefined and a distributed team can double-count a streak                                                                                                                                                                       |
| `verifiedEffortMinutesTotal` | `integer`              | Integer **minutes**. Written only by the §9 verification job                                                                                                                                                                                                      |
| `allocatedEquityBasisPoints` | `integer`              | Written by the nightly slicing-pie job. Per §9.4 this **must always equal `10000`** on a non-degenerate project — the apportionment sums to exactly 10000 by construction, so any other value is an alertable invariant violation, not an "unallocated" remainder |
| `statsComputedAt`            | `timestamp`            | **Returned to clients** so all three render "as of" and never imply live numbers                                                                                                                                                                                  |

> **Why `watchersCount` is a counter but `dailyLogStreakDays` is a job.** The counter is
> transactionally exact and cheap; the streak is a time-decaying fold that would need
> `(now, timezone, full log scan)` on every card render and still change without a write. Different
> problems, different answers — and only the job-computed fields are covered by `statsComputedAt`.

### `project_member`

Membership as a **granted state** — strictly separate from `project_application` (a _request_).
Carries **no equity and no effort columns**; both are derived (§9).

Key columns beyond the obvious: `projectRole` (§4d, server-owned — accepting an application always
yields `contributor`; `founder` is written exactly once, by the create transaction), `roleTitle`
(free display text like "Refrigeration Engineer" — distinct from `projectRole`, which is a
permission), `skills` (`text[]`), `status` (§4d), `sourceApplicationId` / `sourceInviteId`
(provenance, `set null`), `joinedAt` (server-set from the accept transaction; a client-chosen join
date would back-date slice accrual).

`TeamMember.name` and `avatarImageSrc` are **not** stored — they are joined from `user.name` /
`user.image` on read. A copy drifts the moment someone changes their photo.

`isFounder` is **not a column** — it is computed as `projectRole === "founder"` in the read
projection. Storing both permits the contradictory state `isFounder: true` +
`projectRole: 'contributor'` (CLAUDE.md Pattern 1: make illegal states unrepresentable).

```ts
(table) => [
    // One membership row per person per project, ever; re-joining reactivates the existing row.
    uniqueIndex("project_member_project_user_unq").on(table.projectId, table.userId),
    index("project_member_userId_idx").on(table.userId),
    index("project_member_project_status_idx").on(table.projectId, table.status),
    // PARTIAL unique index: exactly one founder per project, enforced by Postgres, not by hope.
    uniqueIndex("project_member_one_founder_unq")
        .on(table.projectId)
        .where(sql`project_role = 'founder'`),
];
```

### `project_open_role` + `open_role_compensation`

`project_open_role`: `roleTitle`, `skills[]`, `commitment` (§4d), `status`, `slotsTotal` (1–50),
`slotsFilledCount` (server-owned counter, incremented only inside the accept transaction).
`OpenRole.projectName` is **not** stored — joined from `research_project.name` on read.

`open_role_compensation` is a **table, not a `jsonb` column**, because each strand has a
kind-specific numeric range that must be independently queryable ("roles offering ≥ 3% equity",
"roles paying ≥ $4k/mo") and independently validated. It replaces
`CompensationComponent.amountLabel`:

| Frontend label        | Columns                                                 | Unit                                          |
| --------------------- | ------------------------------------------------------- | --------------------------------------------- |
| `"$4k–6k/mo"`         | `salaryMinInCentsPerMonth` / `salaryMaxInCentsPerMonth` | integer cents per month (`400000` / `600000`) |
| `"$9k"`               | `oneTimeMinInCents` / `oneTimeMaxInCents`               | integer cents (`900000`)                      |
| `"2–4%"`              | `equityBasisPointsMin` / `equityBasisPointsMax`         | integer basis points (`200` / `400`)          |
| `earnedAsLabel` prose | `earnedAsPolicy` (§4d) + optional `earnedAsNote`        | enum; clients render localized copy           |

Two server-side validations that matter: the equity range is an **advertised offer**, never the
granted share (grants come only from §9), and `max` is bounded `≤ 10000`.
The `earnedAsPolicy` pairing is checked too — `kind='equity'` must be `slicing_pie_vesting`;
`salary`/`one_time` must be an escrow policy. **A founder cannot advertise a payout mechanism the
escrow engine will not execute.**

```ts
// Enforces the frontend type's documented "at most one strand per kind" invariant in the DB
// instead of in a comment.
uniqueIndex("open_role_compensation_role_kind_unq").on(table.openRoleId, table.kind),
```

### `project_application` and `project_invite`

**One table, two directions.** `project_application` is person → project and backs _both_ the
apply-role sheet and the "Request to join" button, discriminated by `kind`, which the server
**derives** from whether `openRoleId` is present — `.strict()` rejects a client-sent `kind`.
`project_invite` is project → person (the talent-page "Invite talent") and is a separate table
because the actor, the authorization check and the accept semantics all differ.

Applications stay separate from `project_member` because they have states membership does not
(`pending`/`declined`/`withdrawn`/`expired`), carry a payload membership never should, and must
survive rejection for anti-spam and audit. Merging them would permit "a member who was declined".

Two validations worth noting:

- `selectedSkills[]` must be a **subset of `project_open_role.skills`** for a `role_interest`. The
  sheet renders its chips from that array, so anything else is a forged payload → `422`.
- `expectedCompensationNote` is permitted in the body precisely because it is the applicant's own
  ask, not a server-owned value — but it is never read by the ledger, never influences a grant, and
  must render as "applicant's stated expectation".

### `project_equity_snapshot`, `project_watcher`, `project_stage_transition`

`project_equity_snapshot` is the read-side projection of the §9 ledger — the **only** source of a
member's `equityBasisPoints`. Written exclusively by the slicing-pie job. `project_watcher` is the
watch join table. `project_stage_transition` is the append-only stage history behind
`PATCH /:slug/stage`.

---

## 6. The data — discovery (problem clusters, insights, signals, talent)

### A submission is not a report

The single most important modelling decision in this domain: `ProblemReport.reportCount: 342` means
**342 different people reported the same problem**. So the mock's `ProblemReport` is not a
submission — it is a **cluster**. Two tables:

- `problem_submission` — one row per person per report. What `report-problem-sheet` creates.
- `problem_cluster` — the deduplicated, scored, publicly rendered entity. What the map shows.

Attaching a submission to a cluster (geo proximity + category + text similarity) is heavy work and
runs as the `cluster-problem-submission` job (§4e), never in the request. A brand-new submission
that matches nothing creates a singleton cluster.

The current sheet fabricates `countryCode: ""`, `mapPosition: {50, 50}`, `reportCount: 1`,
`opportunityScore: 40` client-side. **Every one of those becomes server-derived.**

### Geography: `mapPosition` cannot ship

`ProblemReport.mapPosition: { leftPercent, topPercent }` is a **CSS offset into one specific
`world_map.svg` at one aspect ratio**. It is not geography. It cannot be rendered by MapKit,
MapLibre, or Google Maps, so both native clients are dead on arrival, and it couples the database to
a static asset.

The fix: store real coordinates and let each client project them.

```ts
// Integer MICRODEGREES (degrees × 1e6). Integer, not float, per §4c — cluster centroids are
// recomputed by a job and must be reproducible.
centroidLatitudeMicrodegrees: integer("centroid_latitude_microdegrees").notNull(),
centroidLongitudeMicrodegrees: integer("centroid_longitude_microdegrees").notNull(),
```

`countryCode` is **derived by server-side geocoding**, never client-claimed — CLAUDE.md §0 calls
out client-supplied country as untrustworthy by name, and here it feeds the opportunity score.

Web keeps its SVG by projecting lat/lng → percent client-side. §15 lists `mapPosition`'s removal.

### Scores are server-computed, on a schedule

`opportunityScore` (0–100) and `demandScore` are **ranking signals**, and ranking signals are
attack surfaces. They are never client-supplied, never accepted in a body, and never computed
on read. Inputs: distinct reporter count, geographic spread, category demand, recency decay, and
linked-project scarcity.

Two determinism traps to avoid (§4c): exponential recency decay (`exp(-age/halfLife)`) is float —
quantize to integer buckets once, at the boundary; and haversine distance for centroids is float —
use integer microdegrees with a fixed integer approximation.

Scores are written into `problem_cluster_score_snapshot` with the job's `asOf` instant, so a score
is always renderable with its freshness bound and is reproducible from the same inputs.

> **`distinctReporterCount` is the sybil surface.** It is the entire integrity of the opportunity
> score. It counts `DISTINCT reporterUserId` over `requireIdentifiedUser` submissions only (§4a) —
> with the `anonymous()` plugin live and unguarded, one person can mint unlimited identities and
> manufacture a 342-report "crisis".

### Tables

| Table                            | Purpose                                                                    |
| -------------------------------- | -------------------------------------------------------------------------- |
| `discovery_category`             | Shared taxonomy with §5's `research_category` — **one table, not two**     |
| `discovery_region`               | Region lookup, so the demand leaderboard can join rather than string-match |
| `discovery_skill`                | Canonical skills, replacing free-text `string[]`                           |
| `problem_submission`             | One person's raw report. Never rendered directly                           |
| `problem_cluster`                | The deduplicated public entity — `ProblemReport` in the frontend           |
| `problem_cluster_score_snapshot` | Job-written scores with `asOf`; append-only                                |
| `problem_cluster_merge_proposal` | Moderator queue for suspected duplicate clusters                           |
| `market_insight`                 | Knowledge-hub insight cards                                                |
| `demand_signal_snapshot`         | Job-written leaderboard rows with `rank` + `demandScorePoints`             |
| `talent_profile`                 | Opt-in directory projection of a `user`                                    |
| `talent_profile_skill`           | Join to `discovery_skill`                                                  |
| `talent_compensation_ask`        | The applicant-side mirror of `open_role_compensation`                      |

`MarketInsight.statValue` is the sneakiest field on the surface — the mocks carry `"+34%"`,
`"68M people"`, `"3× coverage"` and `"-22%"` in one column. It decomposes into
`statKind` (enum) + `statValueMilli` (`bigint`, value × 1000) + `statUnitKey` (enum), and the client
formats both the magnitude and the locale.

`TalentProfile` is a **projection of `user`, not a parallel identity** — name and avatar join from
`user`; the table holds only the opt-in directory fields (`headlineRole`, `availability`,
`locationLabel`, and the denormalized `cachedEffortMinutesLogged`).

> **A live frontend bug this surfaces.** `talent-filter-grid.tsx` filters skills with
> `skills.some((skill) => skill.includes(chipText))` — a substring match, so a "Water" chip matches
> "Water Polo". Moving to `discovery_skill` slugs fixes it by construction.

### Server-side filtering

Every list in this domain is filtered client-side today over tiny mock arrays. Per CLAUDE.md
§"Performance", heavy work belongs on the server. Each list endpoint therefore takes explicit
query params — `?category=&region=&commitment=&skill=&availability=&sort=&page=&limit=` — with
keyset pagination whose `ORDER BY` ends in a unique column (§4c).

---

## 7. The data — funding, pledges, milestones, escrow

This is the highest-stakes surface in the product. Read §0 again before implementing it.

> **Amended for the zero-cost stack.** Everything below ships **except the card network**. The
> double-entry ledger, the zero-sum invariant, the hash chain, the four-eyes release, the
> suspense account and the reconciliation job are all built for real — they are the part that
> encodes the invariants, and they cost nothing to run. What is stubbed is the single outbound
> call: `provider_transfer` is submitted to an **internal adapter** rather than Stripe, and
> settlement flips through an auditor-gated internal endpoint instead of
> `POST /webhooks/payments/stripe`, which does not exist.
>
> Three properties survive that substitution intact, which is why it is safe: the settlement path
> is still **exactly one code path** writing `raisedAmountInCents`, `backersCount` and account
> balances; a pledge body still carries `{ amountInCents }` and nothing else; and the ledger is
> still authoritative for entitlement while the adapter is authoritative for cash. Swapping the
> adapter for Stripe later changes one module and adds one signature-verified route — not a table.
>
> **Until an adapter that actually moves money exists, no real funds are involved at all.** Do not
> ship a client that tells a backer their card was charged. The original Stripe design is
> [Appendix A](#appendix-a--deferred-paid-infrastructure).

### Double-entry, not a signed single row

The mock models the ledger as `EscrowLedgerEntry { direction: "in" | "out", amount }`. **Use
double-entry instead**: a journal header plus **≥ 2 signed postings whose amounts sum to zero.**

Four reasons:

1. `direction: in|out` cannot say _where_ money came from or went to — and the Governance tab's
   Allocated / Released / Held question is literally an account-balance question.
2. Money in flight (submitted to Stripe, not yet settled) has no honest single-row representation.
   With a `provider_clearing` account it is simply a balance.
3. Provider-vs-ledger disagreement can be absorbed into a `reconciliation_suspense` account, so the
   books still balance while the discrepancy stays _visible_.
4. The zero-sum invariant is a machine-checkable proof that no money was conjured. A signed-amount
   table cannot offer that.

The client-facing `direction: in|out` survives as a **read projection** (the sign of the posting
against `escrow_held`), so the frontend type does not change shape.

### The accounts

`escrow_account`, one set per project: `escrow_held`, `provider_clearing`, `released_to_project`,
`platform_fee`, `refunds_payable`, `reconciliation_suspense`.

### `escrow_journal_entry` — append-only, hash-chained

```ts
export const escrowJournalEntry = pgTable(
    "escrow_journal_entry",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => randomUUID()),
        // restrict, NOT cascade (§4f) — a project deletion must never erase a ledger.
        projectId: text("project_id")
            .notNull()
            .references(() => researchProject.id, { onDelete: "restrict" }),
        // Monotonic per project from 1. A gap or reorder is immediately detectable. Allocated
        // inside the append transaction with SELECT … FOR UPDATE on the project's last entry.
        sequenceNumber: integer("sequence_number").notNull(),
        kind: escrowJournalKindEnum("kind").notNull(),
        // SERVER-COMPOSED display copy ("Milestone release — 400-vendor demand survey").
        // Composed here rather than on three clients so web/Kotlin/Swift cannot drift. The one
        // deliberate display string in this domain — it is prose, not a number.
        description: text("description").notNull(),
        // The business event time (provider settlement), which may lag createdAt.
        occurredAt: timestamp("occurred_at").notNull(),
        // pending | settled | failed → projects to the frontend's "pending" | "verified" badge.
        // Written ONLY by the webhook/reconciliation service.
        settlement: escrowEntrySettlementEnum("settlement").default("pending").notNull(),
        // set null, NOT cascade — deleting a milestone must never delete financial history.
        linkedMilestoneId: text("linked_milestone_id").references(() => milestone.id, {
            onDelete: "set null",
        }),
        linkedPledgeId: text("linked_pledge_id").references(() => fundingRoundPledge.id, {
            onDelete: "set null",
        }),
        linkedReleaseId: text("linked_release_id").references(() => escrowRelease.id, {
            onDelete: "set null",
        }),
        // Self-FK. Non-null means this entry negates an earlier one. THE ONLY CORRECTION
        // MECHANISM — nothing in this table is ever UPDATEd or DELETEd.
        reversesJournalEntryId: text("reverses_journal_entry_id"),
        // Canonical hash per §4c. Full 64-char hex; the 6-char form the mocks show is display
        // only and must never be used as a key.
        entryHash: text("entry_hash").notNull(),
        // The prior entry's hash; the literal "genesis" at sequenceNumber 1.
        previousEntryHash: text("previous_entry_hash").notNull(),
        hashVersion: integer("hash_version").default(1).notNull(),
        // NULL for system/webhook-authored entries — most of them.
        createdByUserId: text("created_by_user_id").references(() => user.id, {
            onDelete: "set null",
        }),
        createdAt: timestamp("created_at").defaultNow().notNull(),
        // NO updatedAt column, deliberately. An append-only table has nothing to update.
    },
    (table) => [
        uniqueIndex("escrow_journal_entry_project_seq_unq").on(
            table.projectId,
            table.sequenceNumber,
        ),
        index("escrow_journal_entry_project_occurredAt_idx").on(table.projectId, table.occurredAt),
        index("escrow_journal_entry_settlement_idx").on(table.settlement),
    ],
);
```

`escrow_posting` carries `signedAmountInCents: bigint("signed_amount_in_cents", { mode: "bigint" })`
— **positive into the account, negative out**, and `SUM` over one entry **must equal zero**,
asserted in the service before commit and again by a nightly job.

> **`bigint`, not `integer`, per §4b.** The draft specified `int4` and flagged the ceiling in its
> own open questions. It is not merely a limit problem: the hash chain covers posting amounts, so
> widening the column later forces the entire historical chain to be re-derived. Get it right on
> day one.

### Append-only, enforced four ways

Service-layer discipline is not enforcement. All four:

1. The application DB role has `UPDATE` and `DELETE` **revoked** on `escrow_journal_entry` and
   `escrow_posting` — hand-written SQL in the migration. This is the layer that survives a bug in
   our own code.
2. `BEFORE UPDATE OR DELETE` triggers on both tables that `RAISE EXCEPTION`.
3. No `db.update(...)` / `db.delete(...)` call against those tables exists anywhere in the service.
   The only verb is `insert`.
4. `UNIQUE(projectId, sequenceNumber)` plus the hash chain makes out-of-band tampering detectable
   by any verifier that walks the chain (§11 exposes one).

### The money path

```text
POST /funding-rounds/:roundId/pledges     body: { amountInCents }  ← and nothing else
  → server re-bounds against the round's own min/max; derives platformFeeInCents from a config
    basis-point rate; resolves currency from the round
  → creates provider_transfer with OUR randomUUID idempotency key BEFORE any provider call
  → posts escrow_held → provider_clearing, settlement='pending'
  → the provider call happens in a WORKER, never in the request handler

POST /webhooks/payments/stripe            ← the only unauthenticated route in this domain
  → verify signature BEFORE persisting; persist BEFORE processing; dedupe by unique constraint;
    process in a transaction; return 200 for duplicates
  → flips settlement='settled', posts provider_clearing → released_to_project
  → ONLY NOW do raisedAmountInCents and backersCount move
```

`raisedAmountInCents`, `backersCount` and `escrow_account.cachedBalanceInCents` are written by
**exactly one code path** — the webhook settlement handler, inside the same transaction that
appends the journal entry. No controller and no user-facing service function ever touches them.
That is a grep-able invariant.

`percentageFunded` **is not a column and not a request field.** It is computed on read as
`floor(raised * 10000 / goal)` and returned as `percentageFundedBasisPoints`. It cannot be stored,
so it cannot be forged or drift. Clients must render the server's basis points and use the raw
integers only for bar width; the value may exceed `10000` when overfunded, and the client clamps
the _width_, not the number.

**Never trust the webhook payload's amount over our own `provider_transfer` row.** The payload
identifies _which_ transfer settled, not _how much_.

### Milestone release — the four-eyes rule

```text
POST /milestones/:milestoneId/escrow-releases   body: { requestNote? }   ← NO amount field
```

The amount is read from `milestone.escrowReleaseAmountInCents` and **snapshotted** into
`escrow_release.amountInCents` at request time — so a founder cannot edit the milestone between
request and approval to inflate the payout, and cannot assert an amount at all.

Approval independently re-derives **every** gate, server-side:

- requester ≠ approver (`422 SELF_APPROVAL_FORBIDDEN`, **even for a founder**)
- approver holds `platform_auditor`, or a project `admin` role they did not grant themselves (§4a)
- `milestone.status = 'done'`
- the Proof-of-Effort verdict is `verified` (§9)
- the 24-hour dispute window is closed with zero open disputes (§9)
- `escrow_held` balance ≥ the snapshotted amount

The evidence is frozen into a `verificationSnapshot` column so a later audit can prove **why**, not
merely **that**.

**The payout destination is never client-supplied.** `payoutDestinationId` resolves from the
project's registered provider account. A `destinationAccountId` in a request body is a wire-fraud
primitive; `.strict()` rejects it.

### Reconciliation

When the provider and the ledger disagree, **the ledger is not silently patched.** The nightly
`reconcile-escrow-ledger` job pulls provider balances, writes a `reconciliation_discrepancy` row,
posts the delta into `reconciliation_suspense` (preserving the zero-sum invariant), and alarms.

The provider is authoritative for **cash**; the ledger is authoritative for **entitlement**; the
suspense account is where the two are allowed to differ, in public.

### Regulatory gating

PROOF_OF_EFFORT_SPEC.md §1 sequences crowdfunding (Phase 2) well before true equity crowdfunding
(Phase 4, requiring FINRA/SEC registration or a licensed broker-dealer partner).

So `config.ENABLED_FUNDING_ROUND_TYPES` (env, default `["crowdfunding"]`) is checked **at the API**
— before creating a round, before opening one, before accepting a pledge, and in the
`/funding/deals` filter. A disabled round type is invisible and un-pledgeable at the HTTP layer,
which makes hiding the chip in `funding-deal-filter-grid.tsx` cosmetic rather than load-bearing.

### Remaining tables

`funding_round`, `funding_round_pledge`, `milestone`, `milestone_variance`, `escrow_release`,
`provider_transfer`, `provider_webhook_event`, `reconciliation_discrepancy`,
`project_member_compensation_rate`, `investor_confidence_snapshot`, `project_audit_entry`.

Two notes. `investor_confidence_snapshot` replaces the hardcoded
`INVESTOR_CONFIDENCE_PERCENT = 78` in `funding-tab.tsx` — computed nightly from log streak, verified
milestones, and dispute rate, and returned with its `asOf`. And
`project_member_compensation_rate` is the locked fair-market rate that §9's slice math depends on;
it is **effective-dated and requires the member's acceptance**, because a founder who can silently
edit a rate can silently rewrite everyone's equity.

### The rejected-keys list

`.strict()` turns each of these into a `422` instead of a silent overwrite. Enumerated so a reviewer
can grep for them on the pledge body:

```text
backerUserId · userId · projectId · currency · platformFeeInCents · netToEscrowInCents
feeInCents · status · verificationStatus · equityBasisPoints · sliceCount · slices
raisedAmountInCents · percentageFunded · percentageFundedBasisPoints · backersCount
escrowAccountId · journalEntryId · ledgerEntryId · providerTransferId · payoutDestinationId
paymentMethodId · occurredAt · createdAt · id
```

---

## 8. The data — workshop & daily logs

### The workshop is private; every route needs membership

Every `/workshop/*` route runs `requireProjectRole(projectId, req.user.id, "contributor")` (§4a),
not merely `requireAuth`. Failure → `404`.

### Video: a YouTube link, or no video at all

A daily log's video is the **input to the entire equity ledger**, so it needs the strongest path
available at zero cost — and one already exists in this codebase. Reuse
STUDIO_BACKEND_STRUCTURE.md §9 verbatim: the member pastes a YouTube URL,
`extractYoutubeVideoId` (`src/lib/youtube.ts`) parses it to an 11-character id against a hostname
allowlist, one free **oEmbed** call proves the video exists and permits embedding, and the row
stores **the id**. The backend never touches video bytes. Livepeer direct upload is
[Appendix A](#appendix-a--deferred-paid-infrastructure); there is no `POST /webhooks/livepeer`.

**Video is optional.** `daily_log.videoSource` is `none | youtube | hosted`, and a `none` log is a
first-class log carrying only `logDate` and `narrative`. Three reasons this is not a downgrade:
a member with no video on a given day must still be able to log; §9's physical-work claims have no
video by definition; and a required-video contract would make the unlisted-link failure mode
(see below) a hard block on logging rather than a degraded analysis.

**Three honest consequences of using YouTube, stated rather than hidden.** The bytes live on
youtube.com, so an "unlisted" link is protected by obscurity and nothing else — do not describe it
as private anywhere in a client. The member can delete the video out from under a claim, which is
why §9 grounds effort on artifacts and never on the video's continued existence. And YouTube is
where the recording lives, so there is no playback token to mint: `GET
…/daily-logs/:logId/playback-token` does not exist, and clients embed
`youtube-nocookie.com/embed/<id>` rebuilt server-side from the stored id.

Then `analyze-daily-log` (§4e) runs — see below — and later hands off to `verify-effort-claim` (§9).

### Analysis: one Gemini call, and a pipeline that never guesses

`analyze-daily-log` makes **one** structured-output call to Gemini (AI Studio free tier) with the
YouTube URL when there is one and the narrative text when there is not, and writes the transcript
segments, the AI summary chips, the extracted claims and the evidence links from that single
response. One call rather than a transcribe-then-extract pair, because two calls are two draws
against a free quota for the same tokens.

The job's own lifecycle is `daily_log.analysisStatus`
(`not_requested | queued | running | succeeded | failed | skipped_unconfigured`) and it is
**orthogonal to `effortVerificationStatus`** — the same split the studio domain draws between
`uploadStatus`, `publishStatus` and `reviewStatus`. One column cannot say "transcribed but
unverified", and §9 owns the verdict column exclusively:

- No `GEMINI_API_KEY` configured → `skipped_unconfigured`. Not `failed`, and above all not a chip.
- Gemini rejects the input (private video, blocked region) → `failed` with a reason, and the log
  keeps its narrative. Analysis is retried against the narrative alone, never abandoned silently.
- 429 / 5xx / timeout → retryable; pg-boss backs off per §4e.
- Output that fails its Zod schema after **one** repair attempt → `failed`, permanently. The same
  line §9.7 draws for schema-invalid LLM output.

In every failure mode `effortVerificationStatus` stays `not_run`. **A broken pipeline awards
nothing and asserts nothing** — it never writes `verified`, and it never invents a chip.

Everything Gemini produces is §9.1's left column: AI-produced, reviewable, carrying
`generatedByModel` + `promptVersion` + `confidenceBps`. `daily_log_extracted_claim.extractedMinutes`
is _what the member said_, per §9.6; `groundedMinutes` belongs to §9 and is deliberately absent
here.

### Workshop and daily-log tables

| Table                          | Notes                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `workshop_board_column`        | `position` integer, contiguous, re-packed on delete                                                  |
| `workshop_task`                | `rank` — see the ordering note below                                                                 |
| `workshop_file`                | An external link + its allowlisted host. `sizeBytes` is **NULL** — see below                         |
| `workshop_chat_message`        | `sentAt` with microsecond precision — it is also the pagination cursor                               |
| `workshop_chat_read_state`     | Per-member read cursor                                                                               |
| `daily_log`                    | `logDate` (the day **claimed**) + `submittedAt` (the instant) — two distinct fields, never collapsed |
| `daily_log_transcript_segment` | Job-written; offsets are integer **seconds**, never floats (§4c)                                     |
| `daily_log_ai_summary_chip`    | LLM output; carries `generatedByModel` + `promptVersion` provenance                                  |
| `daily_log_extracted_claim`    | The bridge into §9                                                                                   |
| `daily_log_evidence_link`      | Machine-readable evidence refs                                                                       |

### Kanban ordering

Use **lexicographic rank strings**, not integer positions. Two members dragging concurrently with
integer positions produce a re-pack storm and lost moves; a rank string lets a move be a single
row write with no neighbours touched.

The trap: `ORDER BY` on a `text` column follows the database's `LC_COLLATE` (typically ICU
`en_US.UTF-8`), which reorders punctuation and case, while a JS or Kotlin `a < b` compares code
points. They disagree, and the board silently renders in a different order than the server
paginates.

```sql
-- Drizzle cannot express this. Add it by hand in the migration.
ALTER TABLE workshop_task ALTER COLUMN rank TYPE text COLLATE "C";
```

Clients sort by code point and **never** compute a rank themselves — `POST /tasks/:taskId/move`
takes `{ beforeTaskId?, afterTaskId?, columnId }` and the server derives the new rank.

### `isEffortVerified` becomes an enum

The mock's `DailyLog.isEffortVerified: boolean` cannot express the pipeline's real states — queued,
running, flagged-for-review, and unverified-for-lack-of-receipts are all `false` today, which is
exactly the ambiguity CLAUDE.md Pattern 1 exists to prevent. It becomes
`effortVerificationStatus` (§4d, six values), with the boolean derived on read for compatibility.

`aiSummaryChips` and `effortVerificationStatus` are **pipeline output** and appear in no request
body.

### Chat transport

**REST + keyset cursor pagination.** `GET /workshop/chat/stream` (SSE) is **deferred**, for a
concrete reason rather than a preference: the managed Postgres instance allows **twenty connections
for the whole server**, shared across the API pool, the worker pool and every `db:*` script (the
comment at the bottom of `src/worker.ts` records the outage that established this). Every open SSE
stream either polls the database or holds a `LISTEN` session, so real-time chat would trade a
connection budget the request path needs for a surface the frontend does not have yet — the composer
in `workshop-chat.tsx` is a decorative `div` (§14). The cursor is `(sentAt, id)`, so the polling a
client does today and the stream it gets later read the same rows in the same order.

Messages are **soft-deleted** (`deletedAt`), because a hard delete punches a hole in a keyset cursor
and a client paging backwards silently skips a page.

### Files: an external link, measured by nobody

Workshop files are CAD models, spreadsheets and archives, and some are **forensic evidence** for §9
physical-work claims. S3-compatible presigned upload is the right long-term answer and is preserved
in [Appendix A](#appendix-a--deferred-paid-infrastructure). What ships is a **link**: the member
pastes a URL, the server allowlists its host (Drive, Docs, Dropbox, GitHub,
`raw.githubusercontent.com`, OneDrive, Figma, Notion), strips credentials and fragment, and stores
the normalized URL plus the derived host.

**`sizeBytes` stays NULL, and that is the honest answer.** The original rule was "the server
measures the bytes, the client's claim is never trusted" — with a link there are no bytes to
measure, so the column stays null rather than accepting a number the client made up. Nothing in the
UI may render a size for a linked file. `source = 'hosted'`, `storageProvider` and `objectKey` sit
in the schema nullable and unwritten, which is what makes Appendix A an insert rather than a
migration.

Two consequences to state plainly: a linked file's permissions are the linking service's problem,
not Qatoto's, so a member can share a link nobody else on the team can open; and the file can change
under a claim without the ledger noticing, which is why `contentSha256` exists (nullable, unwritten)
and why §9 grounds physical work on `physical_work_receipt` rather than on workshop files.

---

## 9. The data — Proof of Effort

The mechanism spec is [PROOF_OF_EFFORT_SPEC.md](PROOF_OF_EFFORT_SPEC.md) §3 (the Slicing Pie math)
and §4 (the fraud-defeating verification pipeline). This section is its implementation contract.

### 9.1 The determinism boundary

The single most important idea in this domain, and the product's entire commercial argument
(SPEC §2 — "financial determinism vs LLM hallucination"):

> **AI produces inputs and judgements. The formula produces numbers. AI output is reviewable and
> overridable by a human. Formula output is never hand-edited by anyone — including staff,
> including the founder, including a DBA.**

That line is drawn **in the data model**, not in prose:

|         | AI-produced (reviewable, overridable)                                                                                                                                                          | Formula-produced (never hand-edited)                                                                                                                                                                                      |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Columns | `effort_claim.extractedMinutes`, `groundedMinutes`, `claimSummary` · `verification_step.status`, `findingSummary`, `scoreBps` · `receipt_forensics_check.result` · `optimization_suggestion.*` | `slice_ledger_entry.sliceNumerator`, `slicesAwarded` · `slice_allocation_proposal.proposedSlices` · `equity_snapshot_share.equityBasisPoints` · `project_audit_entry.entryHash` · `member_fair_market_rate.*` once locked |
| Carries | `modelName`, `modelVersion`, `promptVersion`, `confidenceBps` **and** `overriddenStatus`, `reviewedByUserId`, `overrideReason`                                                                 | **no override columns at all** — their absence _is_ the contract                                                                                                                                                          |

Corrections flow one way: change an **input** (override a step status, override `groundedMinutes`)
and let the formula recompute — or append a `reversal` entry. Never an `UPDATE`.

Three enforcements, because a rule only one code path respects is not a rule:

1. Nothing in `verification.service.ts` may write `slice_ledger_entry`. Only
   `slice-ledger.service.ts` may, and it only ever writes `computeSlices` output.
2. No endpoint accepts any formula-produced column in a body. `.strict()` → `422`.
3. DB triggers raise on `UPDATE`/`DELETE` of `slice_ledger_entry` and `project_audit_entry`, and on
   `UPDATE` of `member_fair_market_rate` where `OLD.status = 'locked'`.

### 9.2 The math

SPEC §3 gives the model in dollars and hours. In wire units (integer minutes, integer cents) both
contribution kinds reduce to a **single denominator of 3000**:

- Time: `hours × dollarsPerHour × 2` = `(minutes/60) × (cents/100) × 2` = `minutes × cents / 3000`
- Cash: `dollars × 4` = `(cents/100) × 4` = `cents × 120 / 3000`

```ts
// src/lib/slice-math.ts
export const SLICE_DENOMINATOR = 3000n;
export const BASIS_POINTS_TOTAL = 10000n;

export function timeSliceNumerator(effortMinutes: number, unpaidRateCentsPerHour: number): bigint {
    return BigInt(effortMinutes) * BigInt(unpaidRateCentsPerHour); // over 3000
}

export function cashSliceNumerator(cashSpentCents: number): bigint {
    return BigInt(cashSpentCents) * 120n; // over 3000
}
```

Verified against **every** figure in `solar-cold-storage.ts`: 148 h @ $120 →
`8880 × 12000 / 3000 = 35,520` ✓ · 5 h @ $85 → `850` ✓ · 6 h @ $120 → `1,440` ✓ · 8 h @ $60 →
`960` ✓ · 3 h @ $60 → `360` ✓ · $22,120 → `2,212,000 × 120 / 3000 = 88,480` ✓ · $180 → `720` ✓.

> **`bigint`, everywhere, in both TypeScript and Postgres.** A single entry already reaches
> `8880 × 12000 = 106,560,000`; summed over years a project approaches `Number.MAX_SAFE_INTEGER`.
> `sliceNumerator` and every slice total are `bigint`. `slicesAwarded` and `equityBasisPoints` stay
> `integer` because they are bounded and small.

**The unpaid-portion column the mock is missing.** Slicing Pie credits only _unpaid_ contribution.
`member_fair_market_rate` therefore carries **both** `fairMarketRateCentsPerHour` and
`paidCashRateCentsPerHour`, and the ledger prices the difference. Without this, a salaried member
earns full sweat equity _on top of_ their salary — **this is the largest correctness gap in the
mock**, and it has no frontend representation at all.

### 9.3 Rounding

**Round-half-even (banker's rounding), applied exactly once, at ledger-entry write, over exact
`BigInt` arithmetic.**

```ts
/** Divide two BigInts, rounding halves to the nearest EVEN quotient. */
export function divideRoundHalfEven(numerator: bigint, denominator: bigint): bigint {
    const quotient = numerator / denominator; // BigInt division truncates toward zero
    const remainder = numerator % denominator;
    if (remainder === 0n) return quotient;
    const twiceRemainder = (remainder < 0n ? -remainder : remainder) * 2n;
    const sign = numerator < 0n !== denominator < 0n ? -1n : 1n;
    if (twiceRemainder > denominator) return quotient + sign;
    if (twiceRemainder < denominator) return quotient;
    return quotient % 2n === 0n ? quotient : quotient + sign; // exact tie → nearest even
}
```

Four rules that make this binding:

1. **Round once**, when `slicesAwarded` is written. Nothing downstream re-rounds; totals are
   `SUM` of already-final integers.
2. **Retain the exact rational.** `sliceNumerator` is stored alongside, so an auditor can see
   exactly where the half-slice went. Rounding you cannot inspect is indistinguishable from a bug.
3. **Half-even, not half-up.** With denominator 3000 an exact tie is reachable. Half-up biases
   every tie upward — a systematic, direction-consistent drift favouring whoever logs the most
   granular claims. Half-even has zero tie bias in expectation.
4. **Sign is explicit**, because reversals carry negative numerators and `BigInt` `/` truncates
   toward zero rather than flooring.

**Anti-dust rule:** a claim rounding to 0 still writes an entry with `slicesAwarded = 0`. Skipping
it leaves a gap in `sequenceNumber` and breaks the audit story.

### 9.4 Apportionment — slices to basis points

**Largest Remainder (Hare–Niemeyer), with a total, deterministic tie-break.** Recorded in the data
as `equity_snapshot.apportionmentAlgorithm = "largest-remainder-v1"`.

Floor alone is wrong: with N members it loses up to N−1 basis points, so shares sum to ≤ 9999. **A
cap table that does not sum to 100% is not a cap table.** Per-member half-even is also wrong — it
can overshoot to 10001 with no correction step.

```ts
export function apportionBasisPoints(inputs: readonly MemberSliceInput[]): readonly MemberShare[] {
    const total = inputs.reduce((sum, member) => sum + member.slices, 0n);
    if (total === 0n) {
        // isDegenerate: brand-new project, every share 0, sum-to-10000 suspended.
        return inputs.map((member) => ({
            memberUserId: member.memberUserId,
            basisPoints: 0,
            remainder: 0n,
        }));
    }

    // 1. CANONICAL ORDERING first, so the tie-break never depends on row order from Postgres.
    const ordered = [...inputs].sort((left, right) =>
        left.memberUserId < right.memberUserId ? -1 : 1,
    );

    // 2. Floor each share, keeping the exact remainder.
    const floored = ordered.map((member) => {
        const scaled = member.slices * BASIS_POINTS_TOTAL;
        return {
            memberUserId: member.memberUserId,
            basisPoints: Number(scaled / total),
            remainder: scaled % total,
        };
    });

    // 3. Distribute the shortfall one basis point at a time, largest remainder first.
    //    Tie-break chain: remainder DESC → slices DESC → memberUserId ASC (byte order).
    //    The third key is total, so ties ALWAYS resolve.
    // 4. Assert the invariant rather than assuming it:
    //    if (sum !== 10000) throw new Error(`Apportionment invariant violated: ${sum}`);
}
```

**Canonical ordering, stated once, applying everywhere in this domain:** ledger and audit entries
by `sequenceNumber ASC` (**never** `createdAt` — two rows share a millisecond and replica clocks
skew); apportionment input by `memberUserId ASC` in **byte order** (`COLLATE "C"` or sorted in
application code, so a Postgres locale change cannot move a basis point); verification steps by
`stepOrder ASC`.

**Reproducibility test to write:** run the recompute 1,000 times with input rows shuffled; assert
byte-identical `equity_snapshot_share` rows every time.

### 9.5 The reserve pool — drop it

The mock header in `research-and-development-proof-of-effort-mocks.ts` flags its reserve slice pool
as _"a mild deviation from orthodox Slicing Pie… so the backend phase can revisit it."_

**Revisited: drop it**, along with the fixed 200,000-slice pool it depends on. Three reasons, in
severity order:

1. **It reintroduces founder fiat — the one thing this product exists to eliminate.** The mock's
   39,000 reserved slices are a number a founder chose, and they dilute every real contributor by
   19.5% on the strength of that choice. SPEC §2's pitch ("replaces founder fiat with objective,
   verifiable math") dies the moment a founder-chosen constant sits in the denominator.
2. **Slicing Pie is already self-correcting, so the reserve solves nothing.** When the Cooling
   Systems Engineer joins, they lock a rate and earn slices at their own pace; everyone
   re-normalizes automatically, because the denominator is a live `SUM`. That is the model's
   central property. A reserve pre-pays for that dilution in advance, badly.
3. **It makes the sum-to-10000 invariant unenforceable** — the strongest correctness assertion in
   §9.4 would have to be deleted, or a phantom "reserve member" invented that needs an owner, a
   rate, and a dispute path it can never use.

**What replaces it, so the UI keeps the affordance:** a _projection_, computed on read, never
persisted as slices.

```text
GET /research-projects/:projectSlug/equity/open-role-projection
→ [{ openRoleId, roleTitle, projectedSlices, projectedDilutionBasisPoints,
     assumedRateCentsPerHour, assumedMonthlyMinutes, basis: "advertised-compensation-band" }]
```

Derived from the compensation band the project already advertises (§5). The client renders it as a
**dotted/muted ghost segment outside the bar**, explicitly labelled "projected, not allocated". It
is honest, it is derived, and it is outside the denominator.

The same reasoning kills the fixed 200,000 pool: `1% = 2,000 slices` only holds when the pool is
exactly 200,000, and the pool is `SUM(slicesAwarded)`, which changes daily by construction. Keep
"1% = 2,000 slices" as an onboarding legend if it helps, but `equity_snapshot.totalSlices` is
**emergent** and the client renders whatever it says.

If a project genuinely needs a legal reserve, that is a post-bake ESOP pool — a cap-table concept
created at bake time from frozen percentages, not a live-ledger concept.

### 9.6 Tables

| Table                                        | Purpose                                                                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `member_fair_market_rate`                    | Effective-dated, immutable once locked. **The most important table in the domain** — SPEC §2's "valuation rules locked in and transparent to everyone" |
| `slice_ledger_entry`                         | Append-only. `sequenceNumber` gapless per project; `sliceNumerator` (`bigint`) + `slicesAwarded`; `fairMarketRateId` pins the rate used                |
| `effort_claim`                               | The claim under audit. `extractedMinutes` vs `groundedMinutes` are the two halves of SPEC §4                                                           |
| `claim_verification_run`                     | One pass. `attemptNumber` 1, then 2+ for re-verification                                                                                               |
| `verification_step`                          | The four ordered steps, with provenance + override quartets                                                                                            |
| `artifact_evidence`                          | Deterministic digital receipts with identity — replaces `evidenceLabels: string[]`                                                                     |
| `integration_consent_grant`                  | Per **(project, member, provider)** — see §9.10                                                                                                        |
| `physical_work_receipt`                      | `contentSha256` + `perceptualHash`                                                                                                                     |
| `receipt_forensics_check`                    | EXIF / device fingerprint / reverse image search                                                                                                       |
| `slice_allocation_proposal`                  | The 24-hour window — the discriminated union, as CHECK-constrained columns                                                                             |
| `dispute` + `dispute_vote`                   | Consensus. **`dispute_vote` has no frontend counterpart at all**                                                                                       |
| `project_audit_entry` + `project_chain_head` | The hash chain and its serialization point                                                                                                             |
| `equity_snapshot` + `equity_snapshot_share`  | The nightly recalculation; makes bake atomic                                                                                                           |
| `pie_bake_event`                             | Exactly once, ever, per project                                                                                                                        |
| `optimization_suggestion` (+ `_evidence`)    | With LLM provenance and a lifecycle the mock lacks                                                                                                     |
| `verification_job`                           | The queue (§4e)                                                                                                                                        |

**Why effective-dating the rate rather than a column on `project_member`:** a raise must not
retroactively re-price two years of logged effort. Each ledger entry stores `fairMarketRateId`, so
history pins to the rate in force. A single mutable column makes every historical slice count a
function of _today's_ rate — precisely the founder-tweaks-the-spreadsheet failure mode SPEC §2
exists to prevent, and the bug stays invisible until someone gets a raise.

**Why `groundedMinutes` is separate from `extractedMinutes`:** `extractedMinutes` is _what the
member said_; `groundedMinutes` is _what the artifacts prove_. The ledger prices
`COALESCE(overriddenMinutes, groundedMinutes)` — never `extractedMinutes`. Collapsing them destroys
the audit story.

The union in `slice_allocation_proposal` is enforced by CHECK constraints, which is what makes it a
real state machine rather than four optional strings:

```ts
check("proposal_locked_shape",
    sql`(status <> 'locked') OR (locked_at IS NOT NULL AND settled_ledger_entry_id IS NOT NULL)`),
check("proposal_disputed_shape",
    sql`(status <> 'disputed') OR (active_dispute_id IS NOT NULL AND escrowed_slices > 0)`),
check("proposal_escrow_zero",
    sql`(status = 'disputed') OR (escrowed_slices = 0)`),
```

Two unique indexes that are easy to omit and expensive to miss:

```ts
// One commit must not fund two members' claims.
uniqueIndex("artifact_evidence_project_claim_unq")
    .on(table.projectId, table.provider, table.externalId)
    .where(sql`counts_toward_slices = true`),
// The same bytes cannot fund two receipts.
uniqueIndex("physical_work_receipt_content_unq").on(table.projectId, table.contentSha256),
```

### 9.7 The pipeline and the queue

Every step is async (§4e). None can run in a request: transcription is minutes, LLM extraction is
seconds-to-minutes with provider retries, artifact grounding is a fan-out across four providers
with rate limits, AST parsing is CPU-bound, image forensics calls external services.

```text
submit claim (sync, 202) → transcribe-log → extract-claims → ground-artifacts
                         → analyze-substance → analyze-temporal → finalize-verdict
```

Each handler enqueues its successor on success. A `failed` or `flagged` step **still** enqueues
`finalize-verdict` — the pipeline always reaches a verdict, it never just stops.

The dequeue is the only correct form:

```sql
UPDATE verification_job SET state = 'leased', leased_until = NOW() + …, attempt_count = attempt_count + 1
WHERE id IN (
  SELECT id FROM verification_job
  WHERE state = 'queued' AND run_after <= NOW() AND kind = ANY($kinds)
  ORDER BY priority ASC, run_after ASC, id ASC   -- canonical, total ordering
  LIMIT $batchSize
  FOR UPDATE SKIP LOCKED                         -- non-negotiable; without it N workers serialize
) RETURNING *;
```

Retry backoff `min(2^attempt × 30s, 30min)` with ±20% jitter, so a provider outage does not produce
a synchronized herd on recovery. Retryable: 429/5xx/network/timeout. **Permanent:** 401
(consent revoked), 404 (artifact deleted upstream), schema-invalid LLM output after two repair
attempts — which sets the step `failed` and drives the verdict to `unverified-zero-slices`.

> **The failure mode is safe by default: a broken pipeline awards zero, never a guess.**

The verdict function is pure and exhaustive — any `failed` → `unverified-zero-slices`; any `flagged`
(no `failed`) → `flagged-for-review`; all `passed`/`skipped` → `verified`. Written once in
`src/lib/verdict.ts` with a `never` default, unit-tested over all 5⁴ combinations.

### 9.8 The dispute state machine

The proposal is created by `finalize-verdict`, **not** by the ledger. **No slices exist until a
window locks** — the 24-hour window is not an annotation on an award, it is a _precondition_ for
one.

| From       | To                  | Trigger                             | Who                                                         | Slices                                                                                                                                 |
| ---------- | ------------------- | ----------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| —          | `open`              | `finalize-verdict`                  | System                                                      | **None written.** `proposedSlices` frozen on the proposal, outside `totalSlices`                                                       |
| `open`     | `disputed`          | `POST …/dispute`                    | Any **active member**, including the subject. Not observers | `escrowedSlices = proposedSlices`; reported separately so the UI shows "frozen in escrow" honestly                                     |
| `open`     | `locked`            | Expiry sweep                        | System                                                      | **Written.** One `award` entry at `proposedSlices`                                                                                     |
| `disputed` | `consensus-reached` | resolve `upheld`                    | Founder, or majority of `quorumMemberCount`                 | Released at full `proposedSlices`                                                                                                      |
| `disputed` | `consensus-reached` | resolve `voided`                    | Founder / majority                                          | Released at **0** — but a zero-slice entry _is still written_ (no sequence holes)                                                      |
| `disputed` | `consensus-reached` | resolve `re-verified`               | Founder / majority                                          | Scoped re-verification run; settles at the **re-derived** number. The only path that changes the amount, and it comes from the formula |
| `disputed` | `open`              | `withdrawn` before `windowClosesAt` | The **raiser only**                                         | Original window resumes on its **original** clock — it does not restart, or serial withdraw/re-dispute holds slices hostage forever    |
| `locked`   | —                   | **nothing**                         | —                                                           | Terminal. Corrected only by appending a `reversal`                                                                                     |

Rejected with `409`: `locked → *`; `open → consensus-reached` (must pass through `disputed`); a
second dispute (`ALREADY_DISPUTED`); disputing after the window (`WINDOW_CLOSED`); anything at all
once the pie is baked.

**Expiry with no dispute** is the default path, so it must be boring and reliable. A 60-second sweep
over a partial index, `FOR UPDATE SKIP LOCKED`, re-asserting `status='open'` inside the transaction
(a dispute may land microseconds before the lock). Three properties that are easy to get wrong:

- **Downtime loses nothing.** The sweep queries persisted state, not a timer. A worker down six
  hours locks six hours of backlog on restart, all at correct amounts.
- **24 hours is a minimum, never a maximum.** A late sweep leaves the window open longer — always
  the safe direction. **Never pre-lock.**
- **Server UTC only.** `windowClosesAt` is computed in Postgres. "Locks in 9h 14m" is client
  arithmetic against the ISO instant; the server never sends a duration.

`flagged-for-review` **still opens a window.** The solar mock's `"960 slices withheld"` entry proves
it: a flagged verdict does not award, but it does post to the transparency ledger. If flagged claims
vanished silently, members would lose contributions with no recourse.

### 9.9 The hash chain

Hash input, in **fixed declared order**: `projectId`, `sequenceNumber`, `eventKind`, `actorUserId`,
`actorNameSnapshot`, `actorRoleSnapshot`, `actionLabel`, `targetLabel`, `detailNote` (`""`, never
null — `null` vs `""` changes the bytes), `payloadJson`, `occurredAt` (ISO-8601 UTC, exactly
milliseconds), `previousEntryHash`, `hashAlgorithmVersion`.

Deliberately **excluded**: `id` (a random UUID makes the chain unreproducible from semantics),
`createdAt` (write time ≠ event time), and every FK back-reference (circular).

**Serialization: RFC 8785 (JSON Canonicalization Scheme).** Not hand-rolled concatenation with a
delimiter — a delimiter is an injection surface (a `detailNote` containing it forges a chain), and
hand-rolled ordering drifts between the Node implementation and the Kotlin/Swift verifiers. JCS also
mandates integers-only serialization, which is a second reason nothing here is a float.

**Algorithm: SHA-256, lowercase hex, 64 characters.** `entryHashLabel: "c7d9a1"` is a _client-side
truncation for display_. 24 bits is trivially collidable and must never be compared.

**Appending takes a lock.** A chain has one writer per project, always:
`SELECT … FROM project_chain_head WHERE project_id = $1 FOR UPDATE` inside the transaction. Every
ledger write, rate lock, dispute transition, consent change and bake appends its audit entry **in
the same transaction** — an audit trail that can lag the ledger is worse than none.

**Verification: `GET /research-projects/:projectSlug/audit-trail/verify`** re-walks the chain and
checks three things per entry: the hash recomputes, the link matches the predecessor, and
`sequenceNumber` has no gap (a deleted row is a break even if every surviving hash is
self-consistent). A break returns **`409 CHAIN_BROKEN`**, not `200 {valid:false}` — a broken chain
is an operational emergency and must page.

> **The anti-theatre part.** A server that grades its own homework proves nothing. Three
> affordances make the chain independently verifiable: a `/hash-input` endpoint returning the
> canonical bytes so any client can SHA-256 them locally (five lines in `crypto.subtle`,
> `MessageDigest`, or `CryptoKit`); a list endpoint that returns every hash-input column so a
> client can canonicalize _without_ trusting the server's bytes; and **daily external anchoring** of
> the head hash to append-only storage under a separate credential.
>
> Without the anchor, anyone with DB write access recomputes the whole chain from any point forward
> and every verification still passes. That is the honest limit of what a hash chain buys you:
> tamper-evident **against outsiders only**.

### 9.10 Consent and privacy

Consent is a **triple — (project, member, provider)** — never a pair. A member on three projects who
connects GitHub creates three independently revocable grants with independently narrowed
`allowedResourceIds`. A grant for the solar project must never be readable by the drone project's
pipeline. Scope narrowing is the difference between "Qatoto reads your work" and "Qatoto reads your
GitHub" — default to the narrowest scope the provider supports (a repo-scoped installation token,
not a user PAT).

Tokens are envelope-encrypted at rest with a KMS-held key. This deliberately diverges from Better
Auth's `account` table, which stores `accessToken` in plaintext — that is Better Auth's table and
its decision; these are third-party org-scoped tokens whose blast radius is a customer's entire
source repository.

**Revocation destroys the evidence, never the equity.**

- Every `slice_ledger_entry` is **untouched**. Slices awarded stay awarded, forever.
- `artifact_evidence.rawPayloadJson` → NULL, but `payloadSha256`, `externalId`, `label`,
  `artifactOccurredAt` and `signatureStatus` are **retained** — the claim stays provable ("commit
  `abc123` was signed, valid, at 14:02, hashing to `9f2e…`") without the platform holding a copy of
  anyone's code.
- Verification runs and steps survive intact. The audit story is preserved; the source data is gone.

**Why not claw back the slices** — two symmetric attacks, both fatal. _Member-side:_ revoke on the
way out to force a re-verification that must now fail, then dispute the zero; equity becomes hostage
to consent. _Founder-side:_ pressure a member into revoking to zero out their contribution — the
founder-fiat failure mode arriving through a side door. Slicing Pie agrees: a slice records **risk
already taken**, and risk taken in March is not undone by a token revoked in July.

The consequence a human must accept: a dispute against a claim with `evidenceRetained = false`
cannot re-derive a number, so it may resolve `upheld` or `voided` **only** — `re-verify` returns
`409 EVIDENCE_PURGED`. Surface this at the moment of revocation ("Revoking means these 47 claims can
no longer be re-checked if challenged").

Four further obligations, none of which exist yet:

- **Transcripts are personal data.** Retention policy + purge job (suggest: raw audio at 90 days,
  transcript while `dynamic`, purge at bake + 1 year).
- **Reverse-image search ships member photos to a third party.** Separate, explicit, per-project
  consent — never bundled into the OAuth grant. Without it the check is `not-applicable`, not
  silently uploaded.
- **`device_fingerprint` is biometric-adjacent** in some jurisdictions. Store a salted hash, never
  the raw EXIF serial.
- **Right to erasure vs. an immutable ledger.** These genuinely conflict. Resolution: `user` rows
  anonymize; `memberUserId` persists as an opaque id. But `actorNameSnapshot` is _inside the hash_
  and cannot be edited without breaking the chain — so **it must be pseudonymous at write time**.
  Get this right at the first write, or the chain and GDPR become mutually exclusive later.

### 9.11 Baking the pie

SPEC §3.4: at cash-flow breakeven or a priced round, dynamic calculation **stops** and percentages
freeze permanently.

`POST /research-projects/:projectSlug/pie-bake` requires a typed `acknowledgement: "BAKE THE PIE"`
and an `expectedSnapshotId` — if a newer snapshot exists, `409 SNAPSHOT_STALE`, because **a founder
must not bake a cap table they have not seen**. It rejects with `409 UNSETTLED_ALLOCATIONS` if any
proposal is `open` or `disputed`, forces a final synchronous recompute (pure integer math over
already-written rows), marks that snapshot `isBaked`, and appends a `pie-baked` audit entry.

`uniqueIndex("pie_bake_event_project_unq")` guarantees once, ever. **There is no unbake endpoint** —
recovery is a manual, audited, out-of-band operation.

### 9.12 An open decision for a human

§0 says the client never sends a server-owned value, explicitly including an hour count. That makes
it **impossible** for a consensus resolution to say _"we agreed it was 3 hours, not 4."_

The design above routes around it: `resolve` accepts a narrowed ISO-8601 **window**, and the server
re-derives minutes from artifact overlap inside it — preserving the rule and keeping the number
formula-produced. **That is the right default and this doc ships it.**

But it has a real cost. For **physical work with no digital artifacts**, there is nothing to overlap
a window against, so `re-verify` cannot produce a different number and the only outcomes are
all-or-nothing — on a claim the team may agree was _partially_ valid. The solar mock depicts exactly
the disallowed case: `"Re-verified at 3 hrs — adjusted to 510 slices."`

Two options, to be decided knowingly:

- **(a) Keep the rule as written.** Physical-work disputes are binary; partial credit is achieved by
  voiding and re-submitting a smaller claim, which re-runs forensics. Stricter, and no number ever
  enters through a request body.
- **(b) Add a narrow, heavily-audited exception.** `consensusAdjustedMinutes`, accepted **only** on
  dispute resolution, **only** with `resolution: "re-verified"`, **only** after a majority of
  `quorumMemberCount` has voted, written as a `consensus-adjustment` ledger entry naming every voter
  in the audit payload. It is a human-supplied _input_ to the formula — like the negotiated fair
  market rate, which §0 already tolerates at lock time — not a server-owned _output_.

This is the one place the stated rules genuinely pull against the product behaviour the mocks
depict. It needs a decision, not a default.

---

## 10. The data — Project Immortal

### It is a research program, not a research project

Firm recommendation: **model it as a distinct `research_program` entity**, not as a
`research_project` with a flag.

The two share almost nothing structurally. A `research_project` has one founder, a small closed
team, a funding round, milestones, escrow, and a Slicing Pie ledger over verified daily logs.
Project Immortal has 2,847 open contributors, a branch _tree_, a paper library, public discussion,
and contribution tracking that is not equity at all. Forcing them into one table means a dozen
nullable columns and an authorization model that has to branch on kind at every call site.

They do share the **contributor compensation vocabulary** (§4d `compensation_kind`) and the
`user` table. That is the correct amount of sharing.

### Program tables

| Table                                                        | Notes                                                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `research_program`                                           | The singleton today; `slug`, stats sidecar                                                        |
| `immortal_research_branch`                                   | The tree — see below                                                                              |
| `immortal_branch_claim`                                      | Who is working on which branch (drives `contributorCount`)                                        |
| `immortal_research_paper`                                    | Formal library; PDF, DOI, content hash                                                            |
| `immortal_post`                                              | Informal posts **and** netizen ideas **and** replies — one table, self-referential `parentPostId` |
| `immortal_post_reaction`                                     | One row per user per target; idempotent `PUT`/`DELETE`                                            |
| `immortal_product_opportunity`                               | Monetizable derivations                                                                           |
| `research_program_participant`                               | Contributors + `compensationPreference`                                                           |
| `research_effort_log` / `research_contribution_ledger_entry` | Effort and contribution tracking (`restrict` FKs — §4f)                                           |
| `immortal_content_report` + `immortal_moderation_action`     | Moderation                                                                                        |
| `research_program_stat_snapshot`                             | Job-computed program stats                                                                        |

### The branch tree

**Adjacency list (`parentBranchId`) plus a materialized `ancestorPath`.** The read pattern is
"render the whole tree at once" for 12–38 nodes, so a closure table is overkill and `ltree` adds an
extension for no gain at this size. `ancestorPath` makes subtree queries a prefix match.

Same `COLLATE "C"` requirement as `workshop_task.rank` (§8) — the path's ordering is load-bearing
and must not follow database locale.

### `canvasPosition` is layout, not data

Same problem as the problem map's `mapPosition` (§6): `{ leftPercent, topPercent }` is hand-authored
layout for one specific SVG canvas. **The client should run a tidy-tree layout** from
`parentBranchId` + `siblingOrder`, so the graph renders correctly at any viewport on any platform.

An optional curator override survives as `pinnedLeftPermille` / `pinnedTopPermille` (integer
per-mille, normally NULL) for the handful of nodes a human wants placed deliberately.

### The derived analytical signals

`status: "missing"` (a research **gap** Qatoto highlights) and `overlappingGroupCount >= 2`
(duplicated work Qatoto flags) are the intellectual core of this surface — and they are **derived
analytical signals, not user-set fields**.

They are computed by a scheduled job from branch claims, paper coverage, and semantic similarity
between branch summaries, and they are **never** accepted in a request body. A contributor who could
mark their own branch "active" or a rival's "missing" would make the entire map worthless.

### Counts become integers

`reactionCountLabel: "418"`, `replyCountLabel: "37"`, `likeCountLabel: "482"` — all strings in the
mocks, all integers on the wire. The thousands separator is a client locale decision. `postedAtLabel:
"4 hours ago"` becomes `postedAt` ISO-8601, rendered via `Intl.RelativeTimeFormat` /
`RelativeDateTimeFormatter` / `DateUtils.getRelativeTimeSpanString`.

`isUploadedByViewer` is **computed per request** from `uploaderUserId === req.user?.id`, never a
column — it is a property of the _viewer_, not of the row.

`marketPotentialLabel: "$12B est. market"` becomes `estimatedMarketSizeInCents` — which **must** be
`bigint`: `1200000000000` is 560× the int4 ceiling (§4b). `readinessLabel: "Monetizable in 2–4 yrs"`
becomes `readinessMinMonths: 24` + `readinessMaxMonths: 48`, so the rail becomes sortable.

`ImmortalContributor.effortLabel` is the trap: it holds `"312 hrs logged"` in some rows and
`"Funding tranche 2 of 4"` in others. **One mock field, two meanings** — it splits into
`totalEffortMinutes` and `fundingTrancheIndex` / `fundingTrancheTotal`.

`ImmortalIdea.authorLocation` (`"Pune, India"`) has **no backing column on `user`** today. Either add
`user.locationLabel` or drop the field.

### Moderation and abuse

This is public UGC at the scale the program stats claim, so it needs real controls: paper uploads
deduplicated by DOI **and** content hash; likes idempotent and rate-limited (`PUT`/`DELETE`, not
`POST`, so a double-tap is harmless); reply threading depth-capped; and a moderation queue behind
the platform `moderator` role from §4a — which **does not exist yet**.

The current UI is further behind here than anywhere else on the surface: paper upload sends nothing
and hardcodes the category to `"longevity-biology"` and the author to `"You"`, and the like/reply
buttons in `idea-item.tsx` have `aria-label`s but **no `onClick` handler at all**.

---

## 11. The API

Mounted in `src/app.ts`, after `express.json()`. There is **no webhook router and no raw-body
mount** — the three providers that would have signed a webhook are all deferred (Appendix A), and
adding a raw-body branch for a route that does not exist is a security surface bought for nothing.

```ts
// … parseLongFormJsonBody for /research-projects and /discovery, then express.json() …
app.use("/research-projects", researchProjectsRouter);
// Same prefix, declared AFTER: workshopRouter owns /:projectSlug/workshop/* and
// /:projectSlug/daily-logs/*. No collision — researchProjectsRouter's "/:projectSlug"
// matches that one segment exactly and never swallows a deeper path.
app.use("/research-projects", workshopRouter);
app.use("/discovery", discoveryRouter);
app.use("/", fundingRouter); // /funding-rounds, /pledges, /milestones, /escrow-releases
app.use("/research-programs", researchProgramsRouter);
```

**Path convention, applied uniformly:** project-scoped resources nest under
`/research-projects/:projectSlug/…`. The public identity in a URL is always the **slug** (§5);
internal ids appear in payloads and in child path segments. Literal segments (`/mine`, `/slugs`)
are declared **before** `/:projectSlug` so they are never swallowed as a param — the same rule as the
users router's `/me` and the products router's `/mine`.

Unless stated otherwise every route is `requireAuth`, every project-scoped route additionally runs
`requireProjectRole` (§4a), and every mutation touching money/equity/effort adds
`requireIdentifiedUser` (§4a).

### 11a. Projects, team, roles (§5)

| Method & path                                                                       | Body / input                                                                                 | Behavior & statuses                                                                                            |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `POST /research-projects`                                                           | `CreateProjectSchema` (the wizard's `NewIdeaDraft`)                                          | Creates a **draft** + founder `project_member` + `project_stats` in one txn. `201` · `422`                     |
| `GET /research-projects`                                                            | `?category=&stage=&sort=&page=&limit=`                                                       | Public feed of `active` projects. `200`                                                                        |
| `GET /research-projects/slugs`                                                      | —                                                                                            | Slug list for `generateStaticParams`. `200`                                                                    |
| `GET /research-projects/mine`                                                       | `?status=&page=&limit=`                                                                      | Caller's own, including drafts. `200`                                                                          |
| `GET /research-projects/:projectSlug`                                               | —                                                                                            | Detail. Draft → owner only, else `404`                                                                         |
| `PATCH /research-projects/:projectSlug`                                             | `UpdateProjectSchema` (no `status`, no `stage`, no equity grant)                             | Partial update. `200` · `422` · `404`                                                                          |
| `POST /research-projects/:projectSlug/cover`                                        | multipart, field `cover`                                                                     | sharp validate + normalize → Cloudinary. `200` · `413` · `422` · `502`                                         |
| `POST /research-projects/:projectSlug/publish`                                      | —                                                                                            | Server-side completeness gate; materializes seed roles; freezes the slug. `200` · `422 INCOMPLETE_FOR_PUBLISH` |
| `POST /research-projects/:projectSlug/unpublish` · `/archive`                       | —                                                                                            | `active` ↔ `draft`; archive is terminal. `200`                                                                 |
| `PATCH /research-projects/:projectSlug/stage`                                       | `{ stage }`                                                                                  | Dedicated route — writes a `project_stage_transition` audit row. `200`                                         |
| `GET /research-projects/:projectSlug/team`                                          | —                                                                                            | Roster; `name`/`avatar` joined from `user`. `200`                                                              |
| `PATCH` · `DELETE /research-projects/:projectSlug/members/:memberId`                | `{ projectRole?, roleTitle? }`                                                               | Founder only. `founder` can never be assigned. `200` · `403`                                                   |
| `DELETE /research-projects/:projectSlug/members/me`                                 | —                                                                                            | Sets `left`, never deletes. `200`                                                                              |
| `GET` · `POST` · `PATCH` · `DELETE /research-projects/:projectSlug/roles[/:roleId]` | `OpenRoleSchema` + compensation strands                                                      | Maintainer+. `200`/`201` · `422`                                                                               |
| `GET /open-roles`                                                                   | `?commitment=&skill=&minEquityBasisPoints=&page=`                                            | Cross-project rail + `/talent`. `200`                                                                          |
| `POST /research-projects/:projectSlug/applications`                                 | `{ openRoleId?, shortPitch, selectedSkills[], statedCommitment, expectedCompensationNote? }` | `kind` **server-derived**. Skills validated as a subset. `201` · `409` · `422`                                 |
| `POST …/applications/:id/accept` · `/decline` · `/withdraw`                         | `{ note? }`                                                                                  | Accept creates the member row + increments `slotsFilledCount` in one txn. `200`                                |
| `POST /research-projects/:projectSlug/invites` (+ `/accept`, `/decline`, `DELETE`)  | `{ inviteeUserId, openRoleId?, message? }`                                                   | Talent-page "Invite". `201` · `409`                                                                            |
| `POST` · `DELETE /research-projects/:projectSlug/watch`                             | —                                                                                            | Idempotent; counter in the same txn. `200`                                                                     |
| `GET /research-categories`                                                          | `?status=approved`                                                                           | Approved facets only. `200`                                                                                    |

### 11b. Discovery (§6)

| Method & path                                                     | Body / input                                                                      | Behavior & statuses                                                                                                                                                             |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /discovery/problem-clusters`                                 | `?category=&region=&minOpportunityScore=&sort=&page=`                             | The map + landing teaser. Returns lat/lng microdegrees. `200`                                                                                                                   |
| `GET /discovery/problem-clusters/:id`                             | —                                                                                 | Cluster detail + linked projects. `200`                                                                                                                                         |
| `POST /discovery/problem-reports`                                 | `{ title, categoryId, description, latitudeMicrodegrees, longitudeMicrodegrees }` | `requireIdentifiedUser` + limiter. **`countryCode`, `reportCount`, `opportunityScore`, cluster assignment are all server-derived.** `202` (clustering is async) · `422` · `429` |
| `GET /discovery/problem-reports/mine`                             | `?page=`                                                                          | `200`                                                                                                                                                                           |
| `GET` · `POST /discovery/categories`                              | `{ label }`                                                                       | User-minted lands `pending`. `201` · `409` · `429`                                                                                                                              |
| `GET /discovery/regions` · `/market-insights` · `/demand-signals` | `?region=&category=&page=`                                                        | Knowledge hub. `200`                                                                                                                                                            |
| `GET /discovery/talent`                                           | `?commitment=&skill=&availability=&region=&page=`                                 | Server-side filtering (§6). `200`                                                                                                                                               |
| `GET` · `PUT` · `DELETE /discovery/talent/me`                     | `TalentProfileSchema`                                                             | Opt-in directory record. `200`                                                                                                                                                  |
| `POST /discovery/talent/me/publish` · `/unpublish`                | —                                                                                 | Visibility toggle. `200`                                                                                                                                                        |
| `POST /discovery/admin/categories/:id/decide`                     | `{ decision, note? }`                                                             | Platform `moderator` only (§4a). `200` · `403`                                                                                                                                  |
| `POST /discovery/admin/merge-proposals/:id/decide`                | `{ decision }`                                                                    | Cluster dedup queue. `200` · `403`                                                                                                                                              |

### 11c. Funding and escrow (§7)

| Method & path                                                                                    | Body / input                               | Behavior & statuses                                                                                                                                            |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /research-projects/:projectSlug/funding-rounds`                                            | `{ type, goalAmountInCents, closesAt }`    | Gated by `ENABLED_FUNDING_ROUND_TYPES`. `201` · `403 ROUND_TYPE_DISABLED`                                                                                      |
| `POST /funding-rounds/:roundId/open` · `/close`                                                  | —                                          | Founder + `admin`. `200`                                                                                                                                       |
| `GET /funding-rounds/:roundId` · `/backers` · `/pledge-options`                                  | —                                          | `percentageFundedBasisPoints` computed on read. `200`                                                                                                          |
| **`POST /funding-rounds/:roundId/pledges`**                                                      | **`{ amountInCents }` — and nothing else** | Server re-bounds, derives fee, resolves currency, writes `provider_transfer` with our idempotency key. `201` · `422` · `429`. See the rejected-keys list in §7 |
| `GET /pledges/mine` · `POST /pledges/:id/cancel`                                                 | —                                          | No `userId` param exists; the filter is `req.user.id`. `200`                                                                                                   |
| `GET /funding/deals`                                                                             | `?roundType=&stage=&page=`                 | Investor deal flow. `200`                                                                                                                                      |
| `POST` · `PATCH` · `GET …/milestones`                                                            | `MilestoneSchema`                          | `escrowReleaseAmountInCents`. `201`/`200`                                                                                                                      |
| `POST /milestones/:id/complete` · `PUT /milestones/:id/variance`                                 | `{ …variance integers }`                   | `200`                                                                                                                                                          |
| `GET /research-projects/:projectSlug/escrow/summary` · `/ledger`                                 | `?page=`                                   | Allocated / released / held from **account balances**, not client arithmetic. `200`                                                                            |
| **`POST /milestones/:id/escrow-releases`**                                                       | **`{ requestNote? }` — no amount**         | Snapshots the amount server-side. `201`                                                                                                                        |
| `POST /escrow-releases/:id/approve` · `/reject`                                                  | `{ note }`                                 | Four-eyes: `422 SELF_APPROVAL_FORBIDDEN`. Re-derives every gate. `200`                                                                                         |
| `GET …/compensation` · `PUT …/members/:id/compensation-rate` · `POST …/compensation-rate/accept` | `{ rateInCentsPerHour, effectiveFrom }`    | Rate requires member acceptance. `200` · `409`                                                                                                                 |
| `GET …/investor-confidence` · `/audit-trail`                                                     | `?page=`                                   | Returns `asOf`. `200`                                                                                                                                          |
| `POST /webhooks/payments/stripe`                                                                 | raw body                                   | **Unauthenticated by session, authenticated by signature.** Verify → persist → dedupe → process in a txn. `200` even for duplicates                            |

### 11d. Workshop and daily logs (§8)

| Method & path                                                       | Body / input                                | Behavior & statuses                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------- |
| `GET /research-projects/:projectSlug/workshop` · `/board`           | —                                           | Member only → else `404`. `200`                                                         |
| `POST` · `PATCH` · `DELETE …/workshop/columns[/:id]` (+ `/reorder`) | `{ title }` / `{ columnIds[] }`             | `200`/`201`                                                                             |
| `POST` · `PATCH` · `DELETE …/workshop/tasks[/:id]`                  | `WorkshopTaskSchema`                        | `201`/`200`                                                                             |
| `POST …/workshop/tasks/:id/move`                                    | `{ columnId, beforeTaskId?, afterTaskId? }` | **Server derives the rank** — the client never computes one. `200`                      |
| `GET` · `POST` · `DELETE …/workshop/files[/:fileId]`                | `{ fileName, fileKind, externalUrl }`       | Host-allowlisted link. `sizeBytes` is NULL. Soft delete. `201`/`200` · `409` · `422`    |
| `GET` · `POST` · `PATCH` · `DELETE …/workshop/chat[/:id]`           | `{ messageText }` · `?cursor=&limit=`       | Keyset by `(sentAt, id)`; soft delete. `200`/`201` · `429`                              |
| `POST …/workshop/chat/read`                                         | `{ throughMessageId }`                      | `200`                                                                                   |
| `GET` · `POST` · `PATCH` · `DELETE …/daily-logs[/:logId]`           | `{ logDate, narrative?, youtubeUrl? }`      | Video optional; the URL is parsed + oEmbed-verified. `201`/`200` · `409` once submitted |
| `POST …/daily-logs/:logId/submit`                                   | `{ idempotencyKey }`                        | Enqueues `analyze-daily-log`. **`202`**, not a verdict                                  |
| `GET …/daily-logs/:logId/transcript`                                | —                                           | Segments + chips + claims + `analysisStatus`. `200`                                     |

### 11e. Proof of Effort (§9)

| Method & path                                                                | Body / input                                                                                           | Behavior & statuses                                                                                                                                   |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET …/proof-of-effort` · `/equity` · `/slice-ledger` · `/equity/snapshots`  | `?page=&limit=`                                                                                        | Stakeholder read. Response invariant asserted: shares sum to exactly `10000` unless `isDegenerate`. `200`                                             |
| `GET …/equity/open-role-projection`                                          | —                                                                                                      | The ghost segment that replaces the reserve pool (§9.5). `200`                                                                                        |
| `POST …/members/:memberUserId/fair-market-rate`                              | `{ fairMarketRateCentsPerHour, paidCashRateCentsPerHour, currencyCode, effectiveFrom, rationaleNote }` | Founder only. `409 RETROACTIVE_RATE_CHANGE`. **The one place a rate legitimately enters via a body** — a negotiated input, not a derived value. `201` |
| `POST …/fair-market-rate/lock`                                               | `{ rateId, acknowledgement }`                                                                          | Immutable after. `200` · `409 RATE_ALREADY_LOCKED`                                                                                                    |
| `GET …/members/:memberUserId/fair-market-rate`                               | —                                                                                                      | Full effective-dated history — _this is_ the transparency promise. `200`                                                                              |
| `POST …/effort-claims`                                                       | `{ sourceKind, dailyLogId?, physicalReceiptIds[], claimedForDate, narrative?, idempotencyKey }`        | **No minutes, no cash, no verdict, no slices.** `202` · `409 RATE_NOT_LOCKED` · `429`                                                                 |
| `GET …/effort-claims/:claimId`                                               | —                                                                                                      | Claim + all runs + steps in `stepOrder` + evidence. `200`                                                                                             |
| `POST …/effort-claims/:claimId/reverify`                                     | `{ reason }`                                                                                           | `409 CLAIM_SETTLED` once locked. `202`                                                                                                                |
| `PATCH …/effort-claims/:claimId/steps/:stepId/override`                      | `{ overriddenStatus, overrideReason }`                                                                 | **The only hand-edit in the domain — and it edits an AI judgement, not a number.** `200` · `409`                                                      |
| `POST …/physical-receipts`                                                   | multipart `receipt` + `{ receiptKind, idempotencyKey }`                                                | Size/hash/pHash server-measured. `202` · `409 DUPLICATE_RECEIPT` · `413`                                                                              |
| `GET …/allocation-proposals`                                                 | `?status=&page=`                                                                                       | `windowClosesAt` as ISO — **never** a countdown string. `200`                                                                                         |
| `POST …/allocation-proposals/:id/dispute`                                    | `{ disputeNote }`                                                                                      | Any active member. Freezes slices in escrow. `201` · `409 WINDOW_CLOSED`                                                                              |
| `POST …/disputes/:id/votes`                                                  | `{ position, note? }`                                                                                  | One vote per voter; majority auto-resolves. `201`                                                                                                     |
| `POST …/disputes/:id/resolve`                                                | `{ resolution, resolutionNote, scopedWindowStart?, scopedWindowEnd? }`                                 | See §9.8 + the open decision in §9.12. `200`/`202` · `409 EVIDENCE_PURGED`                                                                            |
| `GET` · `POST` · `DELETE …/integrations[/:provider]` (+ `/authorize-url`)    | `{ requestedResourceIds[] }`                                                                           | OAuth `state` **signed, single-use, 10-minute**. Revoke is self-only. `200` · `503 INTEGRATION_UNCONFIGURED`                                          |
| `GET /integrations/:provider/callback`                                       | provider redirect                                                                                      | Identity from the signed `state`, not a session. `302`                                                                                                |
| `GET …/audit-trail` · `/verify` · `/:entryId/hash-input`                     | `?fromSequence=&toSequence=`                                                                           | `409 CHAIN_BROKEN` on a break — it must page. `200`                                                                                                   |
| `GET` · `POST …/optimization-suggestions` · `…/:id/accept` · `…/:id/dismiss` | `{ note? }`                                                                                            | `200`                                                                                                                                                 |
| `POST …/pie-bake`                                                            | `{ trigger, triggerEvidenceNote, valuationCents?, acknowledgement, expectedSnapshotId }`               | Irreversible, once ever. `201` · `409 UNSETTLED_ALLOCATIONS` · `409 SNAPSHOT_STALE`                                                                   |

### 11f. Project Immortal (§10)

| Method & path                                              | Body / input                                                                                               | Behavior & statuses                                                                   |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `GET /research-programs/:programSlug` · `/stats`           | —                                                                                                          | Public. `200`                                                                         |
| `GET` · `POST` · `PATCH …/branches[/:branchId]`            | `{ title, summary, parentBranchId }`                                                                       | `status` and `overlappingGroupCount` are **job-derived, never accepted**. `200`/`201` |
| `POST` · `DELETE …/branches/:branchId/claim`               | —                                                                                                          | Drives `contributorCount`. `200`                                                      |
| `GET` · `POST …/papers` → `/:paperId/file`                 | `{ title, categoryId, doi? }` → multipart                                                                  | Dedup by DOI **and** content hash. `201` · `409 DUPLICATE_PAPER` · `429`              |
| `GET …/papers/:id/download` · `DELETE` · `POST …/moderate` | —                                                                                                          | Moderator for `/moderate`. `200` · `403`                                              |
| `GET` · `POST …/posts[/:postId/replies]`                   | `{ title?, bodyText, parentPostId? }`                                                                      | Depth-capped. `201` · `429`                                                           |
| `PUT` · `DELETE …/posts/:postId/reaction`                  | —                                                                                                          | **Idempotent by verb** — a double-tap is harmless. `200` · `429`                      |
| `POST …/posts/:postId/report` · `GET …/moderation/queue`   | `{ reason }`                                                                                               | `201` · `403`                                                                         |
| `GET` · `POST …/product-opportunities`                     | `{ productName, derivedFromBranchId, estimatedMarketSizeInCents, readinessMinMonths, readinessMaxMonths }` | `bigint` money. `201`                                                                 |
| `GET …/contributors` · `POST`/`PATCH …/contributors/me`    | `{ compensationPreference, contributionSummary? }`                                                         | `200`/`201`                                                                           |
| `POST …/effort-logs`                                       | `{ minutes, branchId, note }`                                                                              | `requireIdentifiedUser` + limiter. `201`                                              |

---

## 12. How a request flows

### Idea → published project

```text
1. Wizard finish → POST /research-projects { ideaName→name, oneLinePitch→tagline, categoryId,
                                             problemItSolves→problemStatement, targetRegion,
                                             demandEvidenceNotes, seedRolesNeeded[],
                                             offeredEquityBasisPointsMin/Max, expectedCommitment }
   → founderUserId from the session cookie/bearer, NEVER the body
   → slug server-generated from name; status='draft'
   → one txn: research_project + founder project_member + project_stats
   → 201

2. POST /research-projects/:slug/cover  (multipart) → sharp decode/re-encode → Cloudinary

3. POST /research-projects/:slug/publish
   → completeness gate: name + tagline + categoryId + problemStatement + cover
   → materializes one project_open_role per seedRolesNeeded entry
   → FREEZES the slug, sets publishedAt, status='active'
   → 200
```

### Pledge → escrow → milestone release (§7)

```text
POST /funding-rounds/:id/pledges { amountInCents }
  → re-bound against the round · derive fee · resolve currency · provider_transfer + idempotency key
  → post escrow_held → provider_clearing (settlement='pending')     [worker submits to Stripe]
POST /webhooks/payments/stripe   (signature-verified)
  → settlement='settled' · post provider_clearing → released_to_project
  → ONLY NOW raisedAmountInCents and backersCount move
POST /milestones/:id/escrow-releases { requestNote? }   ← no amount
  → snapshot milestone.escrowReleaseAmountInCents
POST /escrow-releases/:id/approve
  → requester ≠ approver · milestone done · POE verdict verified · window closed · balance sufficient
  → freeze the evidence into verificationSnapshot · append journal entry + postings summing to zero
```

### Daily log → slices (§8 → §9)

```text
POST …/daily-logs                 → { logDate, narrative?, youtubeUrl? }
  → the URL is parsed to an 11-char id and oEmbed-verified; no video is also valid
POST …/daily-logs/:id/submit      → 202
  → analyze-daily-log (ONE Gemini call) → transcript segments + chips + claims + evidence links
  → ground-artifacts → analyze-substance → analyze-temporal
  → finalize-verdict: pure verdict function; computeSlices → proposedSlices FROZEN on a proposal
  → slice_allocation_proposal opens; NOTHING is written to the ledger yet
[24 hours pass, no dispute]
  → expire-dispute-window sweep (60s) locks it: ONE slice_ledger_entry + audit append, same txn
  → recompute-equity-snapshot → largest-remainder apportionment → shares sum to exactly 10000
```

---

## 13. Zero-trust checklist

- Every actor id is **only** ever `req.user.id`. No `userId`, `founderUserId`, `backerUserId`,
  `memberUserId`, or `applicantUserId` field exists in any request schema.
- `requireAuth` is **not** treated as proof of a human — every money/equity/effort/distinct-count
  write additionally runs `requireIdentifiedUser` (§4a).
- Every project-scoped route re-checks membership in the **service** via `requireProjectRole`;
  failure → `NOT_FOUND` → `404`, never `403`, so ids cannot be probed.
- **No request body carries a price, equity share, slice count, hour count, score, verdict, or
  status.** The two deliberate exceptions are both _negotiated inputs_, not derived outputs, and both
  are documented as such: a founder's advertised equity band (§5) and a member-accepted fair market
  rate (§9).
- Pledges accept `{ amountInCents }` only, and the server still re-bounds it. Escrow releases accept
  **no amount at all**.
- `raisedAmountInCents`, `backersCount` and account balances are written by exactly **one** code
  path — the signature-verified webhook handler.
- Escrow release requires **two distinct people**, and `admin` cannot be self-granted.
- Equity is **computed, never asserted** — there is no writable equity column and no endpoint that
  sets one.
- Slice math is integer-only, rounded once, half-even, apportioned by largest remainder, and
  asserted to sum to exactly `10000`.
- Scores (`opportunityScore`, `demandScore`, investor confidence) are job-computed and returned with
  an `asOf`; they never appear in a body.
- Geography, country, file size, mimetype and image bytes are all **server-measured**, never
  client-claimed.
- Financial and audit tables are append-only, enforced by revoked grants **and** triggers **and**
  service discipline **and** the hash chain — and they never cascade.
- Every body/query is Zod `.safeParse()`d with `.strict()` → `422` before the service runs.

---

## 14. Frontend-behind-backend gaps

Backend supported, no UI yet:

- **Workshop writes.** The kanban is not draggable and the chat composer is a decorative `div`. No
  create-task, move-task, upload-file, or send-message affordance exists.
- **Dispute and consensus.** No dispute button, no vote UI, no quorum progress, no "who raised it".
- **Integration consent.** The entire connect / scope / revoke flow has **no frontend at all** —
  the single largest missing screen, and §9 cannot function without it.
- **Rate lock.** The fair market rate is the foundation of every number on the Proof-of-Effort page,
  and there is no UI to propose, review, lock, or view its history.
- **Pie bake.** No bake action, no pre-bake checklist, no frozen-cap-table view.
- **Chain verification.** No "Verify chain" action, no hash-input inspector. Without it, the
  hash-chain framing is decoration.
- **Override / review.** No surface for a founder to review a flagged step and override it.
- **Project edit.** `GET` + `PATCH` exist; there is no edit entry point.
- **Tiered / multi-currency funding, paper moderation queue, talent profile editing.**

Frontend-side work the contract forces:

- **Pagination everywhere.** `ProjectProofOfEffortLedger` is a flat object with unbounded arrays. A
  two-year-old project has thousands of entries.
- **Async states.** Claim submission returns `202`, not a verdict. The UI assumes verdicts exist
  synchronously; it needs pending states plus polling or SSE.
- **Idempotency keys** on claim submit, receipt upload and dispute raise, or a retried request on a
  flaky mobile connection duplicates.
- **Multiple verification attempts.** `ClaimVerificationRun` models one run; re-verification
  produces attempt 2+ and the UI would show stale results.

---

## 15. Frontend types that must change shape

Not just values — **shapes**. Every one is a compile error the migration must work through.

**`project.ts`** — `TeamMember` (`equityShare: "62%"` → `equityBasisPoints: 6200`;
`effortHoursLogged: 148` → `verifiedEffortMinutes: 8880`; `joinedDate` → `joinedAt` ISO; `id` slug →
`userId`; `isFounder` **removed**, derived from `projectRole`) · `CompensationComponent`
(`amountLabel` → a **discriminated union per kind** carrying typed integers; `earnedAsLabel` →
`earnedAsPolicy` enum) · `MilestoneVariance` (five labels → six typed integers + two unit nouns;
`varianceLabel: "26% behind"` → **signed** `varianceBasisPoints: -2600`) · `Milestone`
(`escrowReleaseAmount` → `…InCents`) · `FundingRound` (`goalAmount`/`raisedAmount` → cents;
**`percentageFunded` deleted**, computed on read) · `EscrowLedgerEntry` (`amount` → cents;
`direction` becomes derived from the posting sign) · `DailyLog` (`date` **splits** into `logDate` +
`submittedAt`; `isEffortVerified: boolean` → the six-value enum) · `ResearchProject`
(`founderId` slug → `founderUserId`; `coverImageSrc` → absolute URL; **`id` stays a slug,
deliberately**).

**`discovery.ts`** — `ProblemReport` (**`mapPosition` deleted entirely** → lat/lng microdegrees;
`category` string → `{ slug, displayLabel, pinIconKey }`; `reportedDate` → `firstReportedAt` +
`lastReportedAt`; `reportCount` → `distinctReporterCount`) · `MarketInsight` (`statValue` →
`statKind` + `statValueMilli` + `statUnitKey`; `sourceNote` → three fields) · `TalentProfile`
(`skills: string[]` → `{ slug, displayLabel, isVerified }[]` — which also fixes the live
substring-match bug; `effortHoursLogged` → minutes).

**`workshop.ts`** — `WorkshopFile` (`fileSizeLabel: "1.8 MB"` → `sizeBytes`) · `WorkshopTask`
(`dueDateLabel` → date-only ISO; **gains `rank`**) · `WorkshopChatMessage` (`sentAtLabel` → ISO with
microsecond precision — it is also the cursor).

**`immortal.ts`** — every `*CountLabel` → integer · every `*AtLabel` → ISO · `canvasPosition` →
topology · `marketPotentialLabel` → `bigint` cents · `readinessLabel` → two month integers ·
`effortLabel` **splits in two** (it holds two different meanings today) · `ProgramStat.statValue` →
integer + key.

**`proof-of-effort.ts`** — essentially every field; it is the file most fully composed of
pre-rendered strings and equations. Notably `timeSliceEquationLabel` → `{ verifiedMinutes,
lockedRateCentsPerHour, timeSlices }` with the **client composing the sentence** (so the `×` and the
currency localize) · `sliceSharePercent: 5.5` (a **float**) → `equityBasisPoints: 550` ·
`timeRemainingToLockLabel` → `windowClosesAt` ISO · `entryHashLabel: "a1f9c3"` → the full 64-char
`entryHash` · `slicesAwardedLabel: "960 slices withheld"` → `{ slicesAwarded: 0, proposedSlices: 960,
status }` — one prose string carrying two numbers and a state.

**Enums:** every shipped kebab-case union value becomes `snake_case` (§4d) — `"full-time"` →
`"full_time"`, `"one-time"` → `"one_time"`, `"market-research"` → `"market_research"`.

Also missing from the frontend entirely and needing new types: `VerificationStepStatus` has no
`failed` or `skipped`; `PhysicalReceiptVerdict` has no `pending`; `ImageForensicsCheckResult` has no
`not-applicable`; `evidenceLabels: string[]` needs identity; there is no `dispute_vote` concept, no
project-role concept, and no `escrowedSlices`.

---

## 16. Build order

Do **not** implement the domains in parallel — §9 defines the numbers every other section reads.

| Phase                             | Scope                                                                                                                                                                                                                           | Why here                                                                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0. Unblock**                    | `bearer()` plugin + multi-origin passkey/OAuth (§4a) · `requireIdentifiedUser` · `project_member` + `requireProjectRole` · `src/lib/money.ts` · `src/lib/canonical-hash.ts` · pg-boss + the worker process · shared enums (§4d) | Every phase below depends on all of it. Native clients are blocked entirely until the auth items land                                                       |
| **1. Projects & team** (§5)       | Idea → project → publish → team → roles → applications                                                                                                                                                                          | The spine. Everything else FKs to `research_project`                                                                                                        |
| **2. Workshop & daily logs** (§8) | Board, files (links), chat, log capture + analysis                                                                                                                                                                              | Produces the input §9 consumes                                                                                                                              |
| **3. Proof of Effort** (§9)       | Rate lock → claims → pipeline → disputes → ledger → snapshots → bake                                                                                                                                                            | The hardest and highest-value. Its patterns get copied                                                                                                      |
| **4. Funding & escrow** (§7)      | Rounds, pledges, provider, ledger, releases                                                                                                                                                                                     | Highest stakes; depends on §9 verdicts for release gating. **Crowdfunding only** — equity/venture stay flag-disabled until Phase 4 of the business sequence |
| **5. Discovery** (§6)             | Clusters, scoring jobs, insights, talent                                                                                                                                                                                        | Independent; deferrable without blocking anything                                                                                                           |
| **6. Project Immortal** (§10)     | Branches, papers, posts, moderation                                                                                                                                                                                             | Largest surface, lowest coupling. Needs the moderator role first                                                                                            |

This matches PROOF_OF_EFFORT_SPEC.md §1's business sequencing: the AI Chief of Staff (§9) is the
Phase-1 revenue product; reward crowdfunding (§7) is Year 1; equity crowdfunding is Year 3+ and
stays API-disabled until then.

---

## 17. Verification (when the backend phase begins)

1. `pnpm db:generate && pnpm db:migrate`, then hand-add what Drizzle cannot express: the `COLLATE
"C"` alterations (§8, §10), the append-only triggers and revoked grants (§4f, §7), and the
   partial unique indexes.
2. **Determinism suite, before anything else ships.** Run `recompute-equity-snapshot` 1,000 times
   with input rows shuffled and assert byte-identical `equity_snapshot_share` output. Assert
   `computeSlices` reproduces **every** figure in `solar-cold-storage.ts` (§9.2 lists them). Assert
   apportionment sums to exactly `10000` over randomized member sets, including ties.
3. **Chain suite.** Append 500 entries, verify; then tamper with one row's `detailNote` directly in
   SQL and assert `/audit-trail/verify` returns `409` naming that exact sequence. Delete a row and
   assert the gap is detected even though every surviving hash is self-consistent.
4. **The tampering test the user asked for.** Fetch a round, edit `amountInCents` in DevTools to a
   different currency's magnitude, replay the pledge — assert the server charges its own value and
   that every rejected key in §7 returns `422`. Repeat against the native clients with a proxy.
5. **Four-eyes test.** Founder requests a release and attempts to approve it → `422
SELF_APPROVAL_FORBIDDEN`. Founder grants themselves `admin` → rejected.
6. **Dispute lifecycle.** Verify a claim, confirm nothing is in the ledger; let the window expire and
   confirm exactly one entry appears; re-run the sweep and confirm it is a no-op (idempotency);
   dispute another and confirm slices show as escrowed and _outside_ `totalSlices`.
7. **Zero-trust sweep.** `grep` every Zod schema for `userId|equity|slice|Cents|score|verdict|status`
   and confirm each hit is one of the two documented negotiated-input exceptions.
8. **Cascade sweep.** For every FK into a financial or audit table, assert `onDelete` is `restrict`
   or `set null`. Then delete a test user with ledger history and confirm it fails loudly.
9. **Coverage sweep.** Every route in [R_AND_D_STRUCTURE.md](R_AND_D_STRUCTURE.md) §3 and every
   action in its §8/§9 maps to a named endpoint in §11.

```bash
# The core money-path smoke test
curl -X POST https://localhost:8000/research-projects -b cookies.txt \
  -H 'content-type: application/json' \
  -d '{"name":"SolarChill","tagline":"Solar cold rooms","categoryId":"<id>",
       "problemStatement":"Produce spoils in transit"}'
# → 201, capture the slug

curl -X POST https://localhost:8000/funding-rounds/<id>/pledges -b cookies.txt \
  -H 'content-type: application/json' -d '{"amountInCents":5000}'
# → 201; then confirm raisedAmountInCents has NOT moved until the webhook settles

curl -X POST https://localhost:8000/funding-rounds/<id>/pledges -b cookies.txt \
  -H 'content-type: application/json' -d '{"amountInCents":5000,"currency":"CNY","backerUserId":"someone-else"}'
# → 422, both unknown keys rejected by .strict()
```

---

## Appendix A — Deferred paid infrastructure

Everything in this appendix was specified in the body of this document and is **not built**. It is
preserved unabridged so switching any of it on later is a re-read rather than a redesign. Nothing
here may be implemented without an explicit decision to start paying for it.

Each entry states what was deferred, the seam that keeps it cheap to restore, and the honest cost of
the substitute that shipped instead.

### A1. Livepeer direct upload (daily-log video, §8)

**The deferred design.** A daily log's video is the input to the entire equity ledger, so it was to
reuse STUDIO_BACKEND_STRUCTURE.md §5.1 verbatim: Livepeer Studio direct upload, where the backend
never touches video bytes. The client requests a short-lived TUS upload URL, uploads directly to
Livepeer, and Livepeer calls `POST /webhooks/livepeer` on completion, which flips the log's media
state and enqueues transcription. Playback is gated by a server-minted, short-lived JWT
(`GET …/daily-logs/:logId/playback-token`), which is what makes a private project's daily log
actually private.

**The seam.** `daily_log.videoSource` already carries a `hosted` variant beside `none` and
`youtube`, and the provider columns (`videoAssetId`, `playbackId`, `playbackUrl`,
`storageProvider`) exist nullable and unwritten — the same arrangement the studio `video` table
uses. Restoring this is an insert plus one signature-verified route: no table drop, no rename, no
frontend type change beyond gaining a playback field.

**What the substitute costs.** A YouTube link is protected by obscurity, not by access control:
"unlisted" is not private, and any client that says otherwise is lying to a member about where
their work-in-progress is visible. The member can also delete the video out from under a settled
claim — which is precisely why §9 grounds effort on artifacts and receipts rather than on the
video's continued existence, and why the video is evidence rather than proof.

### A2. S3-compatible object storage (workshop files §8, papers §10)

**The deferred design.** Workshop files are CAD models, spreadsheets and archives up to 100 MB, and
some are forensic evidence for §9 physical-work claims, so they need versioning and retention an
image CDN does not provide. Presigned direct upload to S3-compatible storage:
`POST …/workshop/files` mints a presigned PUT, the client uploads directly,
`POST …/workshop/files/:fileId/complete` confirms, and the server issues a **`HEAD`** to measure
the real byte size and compute `contentSha256`. The client's claimed size is never trusted.
`GET …/workshop/files/:id/download` returns a short-lived signed URL, and
`POST /webhooks/object-storage` handles out-of-band lifecycle events. Project Immortal's paper
library (§10) uses the same path, with dedup by DOI **and** content hash.

**The seam.** `workshop_file.source` carries a `hosted` variant beside `external_link`;
`storageProvider`, `objectKey`, `sizeBytes` and `contentSha256` all exist and are nullable. The
CHECK constraint already encodes both shapes (`external_link` ⇒ a URL and a null size;
`hosted` ⇒ an object key), so the two can coexist during a migration and old rows never need
rewriting.

**What the substitute costs.** Three things, worth stating rather than discovering: a linked file's
permissions belong to the linking service, so a member can share a link the rest of the team cannot
open, and Qatoto cannot tell; the bytes can change under a claim with no hash to notice, which is
why §9 must not treat a workshop file as tamper-evident evidence; and `sizeBytes` is NULL forever,
so no client may render a file size for a linked file.

### A3. Stripe Connect + Treasury (escrow, §7)

**The deferred design.** PROOF_OF_EFFORT_SPEC.md §1 Phase 2 names Stripe Connect + Treasury
specifically, so Qatoto never custodies funds itself. `POST /funding-rounds/:roundId/pledges`
writes a `provider_transfer` carrying **our own** randomUUID idempotency key before any provider
call; a worker submits it; `POST /webhooks/payments/stripe` — the only unauthenticated route in the
domain, authenticated by signature — verifies, persists, dedupes on a unique constraint and
processes in a transaction, flipping `settlement` to `settled` and posting
`provider_clearing → released_to_project`. Only then do `raisedAmountInCents` and `backersCount`
move. The nightly `reconcile-escrow-ledger` job pulls provider balances and posts any delta into
`reconciliation_suspense` rather than silently patching the ledger.

**The seam.** Every table in §7 ships as specified, including `provider_transfer`,
`provider_webhook_event` and `reconciliation_discrepancy`. Only the module behind them changes: an
internal adapter with an auditor-gated settlement endpoint stands in for the card network. The
webhook route is the single addition when Stripe lands, and its handler is the same transaction the
internal adapter already runs.

**What the substitute costs.** No money moves. A pledge is a recorded intent and an escrow release
is a recorded entitlement, and any client copy implying a card was charged is false. The
reconciliation job has no external source of truth to reconcile against until an adapter that
actually moves cash exists, so its discrepancy count is trivially zero — do not read that as
evidence the books are right.

### A4. Real-time chat over SSE (§8)

**The deferred design.** `GET …/workshop/chat/stream` as Server-Sent Events, not WebSockets: SSE
survives proxies, reconnects natively, needs no new server infrastructure, and both native clients
handle it.

**Why it is deferred, and it is not cost.** The managed Postgres instance allows **twenty
connections for the whole server**, shared by the API pool, the worker pool and every `db:*`
script — subscribing one worker per dead-letter queue already exhausted it once (`FATAL: sorry, too
many clients already`; the incident is recorded in `src/worker.ts`). Every open stream either polls
the database or holds a `LISTEN` session, so shipping SSE today trades connections the request path
needs for a surface the frontend does not yet have: the composer in `workshop-chat.tsx` is a
decorative `div` (§14).

**The seam.** The keyset cursor is `(sentAt, id)` with microsecond precision, and messages are
soft-deleted, so the rows a client polls today and the rows a stream pushes later are the same rows
in the same order. Adding the stream changes no table and no cursor.
