# R_AND_D_BACKEND_STRUCTURE.md — Qatoto Research & Development: Pipeline API

> This document describes the **research & development** contract the Next.js frontend depends
> on, and how it is wired on the Express backend (`/Users/vinitchuri/code/backend/qatoto-backend`).
> It is the sibling of [BACKEND_STRUCTURE.md](BACKEND_STRUCTURE.md) (auth & identity),
> [STORE_BACKEND_STRUCTURE.md](STORE_BACKEND_STRUCTURE.md) (commerce) and
> [STUDIO_BACKEND_STRUCTURE.md](STUDIO_BACKEND_STRUCTURE.md) (video) — same voice, same layering,
> same envelope — scoped to the whole `/research-and-development` surface.
>
> ---
>
> ⚠️ **THIS FILE EXISTS IN TWO REPOS AND THEY MUST BE KEPT BYTE-IDENTICAL.**
> `qatoto-backend/docs/` and `qatoto-frontend/docs/`. **The backend copy is canonical** — it sits
> beside the `src/routes/` this document describes, so an endpoint table edited there is edited next
> to the code that proves it.
>
> They have drifted once already, in both directions at the same time: the backend copy gained six
> §11a rows and one §11b row that the frontend copy never saw, while the frontend copy gained a §14
> rewrite the backend copy never saw. Neither side noticed, because each looked internally
> consistent. **After editing either copy, run `diff` between them and reconcile before committing.**
>
> ---
>
> **Goal:** run Qatoto's concept-to-consumer pipeline server-side — post an idea, form a team for
> equity, log daily work, have that work _verified_ into a dynamic equity ledger, and **produce a
> month-end statement of exactly what each member is owed in cash and in equity** — with the backend
> as the only source of truth for every number involved, and **without the platform ever holding a
> rupee, a euro or a cent.**
>
> **Qatoto holds no funds and charges nobody.** This domain is a calculation engine and a system of
> record. It computes what is owed; the founder pays it from their own bank or payroll provider and
> records the payment here. There is no take-rate, no subscription and no per-seat fee, for a
> founder, an employee, an employer or an investor. Escrow custody used to live in §7 and has been
> removed — the ledger design is preserved in
> [ESCROW_LEDGER_STRUCTURE.md](ESCROW_LEDGER_STRUCTURE.md) for the commerce domain, where a
> buyer↔seller hold is a genuine requirement. The reasoning, and the EU/US/India compliance analysis
> behind it, is §7A.6.
>
> **Stack (mostly reused):** **Express 5** + **Drizzle ORM** + **PostgreSQL** + **zod** +
> **Cloudinary** (images) + **sharp** + **multer** + **express-rate-limit** + **pg-boss** (the job
> runner, shipped with §6), all already installed. The only genuinely new dependency this domain
> still adds is an **LLM provider** for §8/§9 analysis — **Gemini on the AI Studio free tier**,
> called with plain `fetch`, no SDK. Better Auth already owns identity; this feature owns the
> `/research-projects/*`, `/discovery/*`, `/funding/*` and `/research-programs/*` routes and ~60 new
> tables.
>
> **Status:** six domains are **✅ shipped and reachable today** — §5 (projects, team, roles,
> applications), §6 (discovery), §7 (funding, as a record of intent), §7A (compensation
> statements), §8 (workshop, daily logs) and §9 (Proof of Effort). §10 (Project Immortal) is
> **⏳ pending** — no route, controller, service or migration exists for it yet. **The escrow
> subtree is 🗑️ retired:** its nine routes now 404, its three jobs are unbound, and its tables
> survive unreachable and uncalled so migration 0016's rows stay explicable. §11's "Implementation
> status, per subsection" table is the authoritative, per-endpoint breakdown; treat it over this
> paragraph if the two ever disagree, since this one is prose and that one is checked against the
> actual route files.
>
> **Where the §7A build diverged from this document**, all three recorded here rather than left in a
> commit message:
>
> 1. **`project_chain_head` gained TWO compensation columns, not one.** §7A.3 implies a single
>    gapless sequence, but a sequence is allocated when a period OPENS and a statement hash only
>    exists when it is FINALIZED — and a period may be finalized late while the next accrues. One
>    counter would leave either a gap in the calendar sequence or a chain that cannot be walked, so
>    `lastCompensationSequenceNumber` and `compensationHeadStatementHash` are separate, on the same
>    row and under the same lock.
> 2. **More than one period may be `open` at once**, and the unique index is per project PER MONTH.
>    §7A.5's close job stops a period accruing _without_ freezing it, so an unfinalized March and an
>    accruing April are both open. A one-per-project index — which migration 0017 shipped and 0018
>    corrected — makes that lifecycle impossible.
> 3. **Enabling the two new `earnedAsPolicy` values took two migrations.** Postgres refuses to _use_
>    an enum value in the transaction that `ALTER TYPE … ADD VALUE` created it, so the pairing CHECK
>    that references `off_platform_payroll` had to wait for 0019. That CHECK is `NOT VALID` on
>    purpose: existing rows legitimately carry a retired escrow policy, they are the offers people
>    already applied to, and validating would mean rewriting history or dropping the rule.
>
> **A pledge now moves `raisedAmountInCents` itself.** `escrow_settlement.service.ts` was the only
> writer of that counter and of `backersCount`, gated on an auditor settling a provider transfer.
> With no custody there is no settlement step, so leaving it there would freeze every funding page
> at zero raised forever. §7's "What survives here" already defines both as sums of **committed**
> pledges; `createPledge` now moves them in its own transaction and `cancelPledge` moves them back.
>
> The frontend, meanwhile, is still **pure UI over static mocks** for the whole surface —
> [R_AND_D_STRUCTURE.md](R_AND_D_STRUCTURE.md) §10 and every file under
> `src/mocks/research-and-development/` say so explicitly, and nothing in the shipped §5/§6/§8
> backend is wired to it yet. Every funding figure, equity share, compensation row, opportunity score
> and verification verdict rendered on the surface today is still fabricated, even where the backend
> behind it is live. This doc is the spec the backend-integration phase implements.
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
> | Concern                                  | Drafted (deferred)             | **Ships now**                                                                                                                                                                                         |
> | ---------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | Daily-log video (§8)                     | Livepeer direct upload         | **An optional pasted YouTube link**, parsed to an 11-char id and proven with one free oEmbed call. A log may also be text-only.                                                                       |
> | Workshop files (§8), papers (§10)        | S3-compatible presigned upload | **An external link** to a host allowlist (Drive, Dropbox, GitHub, OneDrive, Figma, Notion). The backend stores a URL.                                                                                 |
> | Transcription + claim extraction (§8/§9) | Whisper-class ASR + a paid LLM | **Gemini, AI Studio free tier**, one structured call per log. No key configured → the analysis records `skipped_unconfigured`.                                                                        |
> | Member payout (§7 → §7A)                 | Milestone escrow release       | **A month-end statement of what is owed, settled off-platform.** The founder pays from their own bank or payroll provider and records the payment; both sides confirm it. Qatoto holds nothing (§7A). |
>
> **The backend never touches video bytes, file bytes or customer funds.** That was already
> true of the drafted design for video; it is now true of all three — and for funds it is no longer
> a cost decision but a **licensing** one (§7A.6).
>
> **What must NOT be built:** the Livepeer upload/transcode/playback-token path, the S3 presigned
> upload + `/complete` + `HEAD`-sizing path, and the two signature-verified webhook routes
> (`/webhooks/livepeer`, `/webhooks/object-storage`). Both are preserved in
> **[Appendix A](#appendix-a--deferred-paid-infrastructure)** so switching back is a re-read, not a
> redesign.
>
> **What must NEVER be built in this domain:** anything that makes Qatoto hold, pool, or pay out
> money — a Stripe Connect/Treasury integration, `/webhooks/payments/stripe`, a payout rail, a
> balance the platform controls. That is not a cost decision that could be reversed by a budget; it
> is regulated money movement under PSD2 in the EU, state money-transmitter law plus FinCEN in the
> US, and RBI payment-aggregator authorisation in India (§7A.6). The escrow ledger design itself is
> good and is preserved in [ESCROW_LEDGER_STRUCTURE.md](ESCROW_LEDGER_STRUCTURE.md) for the commerce
> domain, where it belongs — and even there Qatoto mirrors a licensed provider rather than
> custodying.
>
> **Forward compatibility is in the schema, not in a promise.** `workshop_file.source` carries a
> `hosted` variant beside `external_link`, `daily_log.videoSource` carries `hosted` beside `youtube`
> and `none`, and `storageProvider` / `objectKey` sit nullable and unwritten — the same shape the
> studio domain uses for `videoSourceEnum` + the dead provider columns. No table drop, no rename.
>
> **Where a section below still says Livepeer or S3 as if it ships,** the amended text in §2, §4e,
> §8, §10 and §11 wins, and the original wording is in Appendix A. **Where anything says escrow,
> Stripe, or a platform fee as if this domain moves money,** §7's superseded stub and §7A win.

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
  against the round's own min/max; a compensation statement line accepts **no amount at all** and is
  computed from the member's accepted rate and their verified minutes (§7A).
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

Three further rules, added when escrow left this domain. They are not implementation preferences —
each one has a statute behind it, set out in §7A.6.

- **Verification gates equity; it must never gate a wage.** A `flagged_for_review` or `unverified`
  verdict withholds **slices** — that is the whole point of §9. It must never reduce, delay or
  zero a cash line on a compensation statement. Conditioning earned wages on an algorithm passing is
  unlawful withholding under the FLSA and state timely-payment law in the US, under national wage
  statutes across the EU, and under §18 of India's Code on Wages 2019, whose list of permitted
  deductions is exhaustive and does not include "the AI found no commit". A verdict may **annotate**
  a cash line. It may not change its number.
- **Qatoto holds no funds, in any domain.** No balance the platform controls, no pooling, no payout
  rail, no card number. The compensation engine computes and reports; money moves between the
  parties' own accounts. Any change that would make Qatoto the party holding someone else's money is
  a licensing decision taken deliberately with counsel (§7A.6), not a code review.
- **Qatoto charges nobody.** No take-rate, no subscription, no per-seat fee — not to a founder, an
  employee, an employer or an investor. `PLATFORM_FEE_BASIS_POINTS` is `0` and stays `0`; a nonzero
  value is an explicit business decision that also changes the legal analysis, because in several US
  states the money-transmitter definition turns partly on being compensated for the service.

If you remember nothing else from this file, remember §0.

---

## 1. What the frontend expects

Ten routes, all under `(home)`, all rendering mocks today. The contract each one needs:

| Route                                                    | Surface                    | Needs from the backend                                                       |
| -------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------- |
| `/research-and-development`                              | Pipeline landing           | Project rail, top problem clusters, market insights, open roles              |
| `/research-and-development/new`                          | 4-step idea wizard         | Create a `draft` project from `NewIdeaDraft`                                 |
| `/research-and-development/project/[id]`                 | Detail, 5 tabs             | Project + team + milestones + daily logs + funding + compensation statements |
| `/research-and-development/project/[id]/workshop`        | Boards / Files / Chat      | Kanban, file store, team chat                                                |
| `/research-and-development/project/[id]/proof-of-effort` | Slicing Pie ledger, 5 tabs | Slice breakdown, verification runs, disputes, optimization, audit trail      |
| `/research-and-development/problem-map`                  | Civic Pulse                | Problem clusters with geo + opportunity scores                               |
| `/research-and-development/knowledge-hub`                | Market intel               | Insights + demand-signal leaderboard                                         |
| `/research-and-development/talent`                       | Talent directory           | Filterable talent profiles + open roles                                      |
| `/research-and-development/funding`                      | Investor deal flow         | Open rounds + investor-confidence signal                                     |
| `/research-and-development/projects/project-immortal`    | Moonshot program           | Branch tree, papers, posts, ideas, contributors, stats                       |

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
LLM provider. Object storage is **deferred to
[Appendix A](#appendix-a--deferred-paid-infrastructure)** and replaced by a link. Payments are not
deferred, they are **gone**: this domain moves no money at all, so there is no payment dependency to
add, defer, or budget for (§7A.6).

| Concern            | Pick                                      | Why / reuse                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server framework   | **Express 5**                             | Same app, four more routers.                                                                                                                                                                                                                                                                                                                                      |
| Language           | **TypeScript** (strict, ESM `#src/*`)     | Shared shapes with the frontend.                                                                                                                                                                                                                                                                                                                                  |
| Database ORM       | **Drizzle ORM**                           | New tables in `src/db/schema.ts`; `pnpm db:generate && db:migrate`.                                                                                                                                                                                                                                                                                               |
| Database           | **PostgreSQL** via `pg`                   | FKs, enums, partial + unique indexes, `bigint` money.                                                                                                                                                                                                                                                                                                             |
| Validation         | **zod**                                   | Inline `.safeParse()` in the controller → `422` (prevailing style).                                                                                                                                                                                                                                                                                               |
| Image storage      | **Cloudinary** (`src/lib/cloudinary.ts`)  | Project covers, avatars — reuse the product-image helpers.                                                                                                                                                                                                                                                                                                        |
| Image processing   | **sharp** (`src/lib/image.ts`)            | Reuse `validateAndNormalizeImage`; also the EXIF reader for §9 receipt forensics.                                                                                                                                                                                                                                                                                 |
| Daily-log video    | **A YouTube link** (`src/lib/youtube.ts`) | Reuse the STUDIO §9 path verbatim: parse the URL to an 11-char id, prove it with one free oEmbed call, store the id. The backend never touches video bytes, and neither does any provider we pay. Video is **optional** — a log may be text-only.                                                                                                                 |
| Rate limiting      | **express-rate-limit**                    | New named limiters per §4a.                                                                                                                                                                                                                                                                                                                                       |
| **Job runner**     | **pg-boss**                               | Postgres-backed queue, installed with §6. Same database, same transaction, no new infrastructure. §8 and §9 cannot exist without it.                                                                                                                                                                                                                              |
| **LLM analysis**   | **`gemini-3.5-flash-lite`, AI Studio**    | One structured-output call per daily log returns the transcript, the summary chips and the extracted claims together — two jobs would be two calls against a free quota. Plain `fetch`, no SDK, injectable for tests, `temperature: 0`, `thinkingLevel: low`. Absent key → `skipped_unconfigured`, never a fabricated verdict.                                    |
| Workshop files     | **An external link**                      | Deferred from S3 on cost. The member pastes a Drive/Dropbox/GitHub/OneDrive/Figma/Notion URL; the server allowlists the host and stores the URL. `sizeBytes` is **NULL**, never a client claim. `source = 'hosted'` + `objectKey` stay in the schema, unwritten, for [Appendix A](#appendix-a--deferred-paid-infrastructure).                                     |
| Payments           | **None. Deliberately.**                   | No payment SDK, no provider account, no webhook route, no balance. §7A computes what is owed and the parties settle it themselves. Custody is a licensing decision, not a dependency choice (§7A.6); the ledger design lives in [ESCROW_LEDGER_STRUCTURE.md](ESCROW_LEDGER_STRUCTURE.md) for commerce.                                                            |
| Compensation (§7A) | **Nothing new**                           | ✅ Shipped with zero added dependencies. Statements reuse pg-boss for the two daily jobs, `src/lib/money.ts` for every integer, `src/lib/canonical-hash.ts` plus the existing `project_chain_head` lock to freeze a period, and `Intl` for month boundaries in a named zone — a tzdata package would be 400 kB to answer a question the platform already answers. |

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
│   │   ├── funding.routes.ts                  # NEW — rounds, pledges, milestones (no custody, §7)
│   │   ├── compensation.routes.ts             # NEW — agreements, periods, statements,
│   │   │                                      #       payment records (§7A)
│   │   ├── workshop.routes.ts                 # NEW — board, files, chat, daily logs
│   │   ├── proof-of-effort.routes.ts          # NEW — slice ledger, claims, disputes, audit
│   │   ├── research-programs.routes.ts        # NEW — Project Immortal
│   │                                          # NO webhooks.routes.ts — nothing signature-
│   │                                          # verified ships; see Appendix A
│   │                                          # NO escrow routes — this domain moves no money
│   │                                          # (§7A.6); the ledger design lives in
│   │                                          # ESCROW_LEDGER_STRUCTURE.md, for commerce
│   ├── controllers/                           # NEW — one per router above
│   ├── services/
│   │   ├── research-projects.service.ts       # NEW
│   │   ├── project-membership.service.ts      # NEW — requireProjectRole lives here (§4a)
│   │   ├── discovery.service.ts               # NEW
│   │   ├── funding.service.ts                 # NEW
│   │   ├── compensation-periods.service.ts    # NEW — draft, finalize, freeze, supersede (§7A)
│   │   ├── compensation-agreements.service.ts # NEW — effective-dated, member-accepted (§7A)
│   │   ├── compensation-payments.service.ts   # NEW — attestations, two-sided confirm (§7A)
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
│   │   ├── compensation-period.ts             # NEW — month bounds in a named zone,
│   │   │                                      #       proration, hourly pricing (§7A.4)
│   │   ├── payment-instrument.ts              # NEW — keeps PANs and IBANs out of a
│   │   │                                      #       free-text note (§7A, §17 5c)
│   │   ├── jobs.ts                            # NEW — pg-boss bootstrap + job registry (§4e)
│   │   ├── youtube.ts                         # REUSED from the studio domain (§8)
│   │   ├── gemini.ts                          # NEW — the one LLM call, structured output (§8)
│   │   ├── lexorank.ts                        # NEW — kanban rank strings, COLLATE "C"-safe (§8)
│   │   ├── external-link.ts                   # NEW — file-link host allowlist (§8)
│   │   └── daily-log-streak.ts                # NEW — the pure streak fold (§8)
│   ├── jobs/                                  # NEW — one file per scheduled/async worker (§4e)
│   └── app.ts                                 # + 7 routers. No raw-body mount: no webhooks
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
pledges, compensation agreements and payment records, daily logs, effort logs, problem reports,
applications, invites, papers, posts, reactions.

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
moderation). A single nullable `user.platformRole` column, checked in-service.

```ts
// The ONLY per-project role enum. Supersedes the three colliding drafts.
export const projectMemberRoleEnum = pgEnum("project_member_role", [
    "founder", // row owner: edit project, stage, publish/archive, remove members, finalize a period
    "admin", // co-signer: countersign a finalized compensation period (§7A), triage applications
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

**The four-eyes rule and how not to break it.** Nothing in this domain moves money any more, so
four-eyes no longer guards a payout — but it still guards the two acts that decide what someone is
owed: **locking a fair market rate** (§9) and **finalizing a compensation period** (§7A). Both are
defeated if a founder can simply grant themselves the second role, so `admin` grants are **not**
self-serviceable: a founder cannot grant `admin` to themselves, and the countersigner of a finalized
period must not be the one who requested it. `project_member.roleGrantedByUserId` makes this
structural rather than conventional, and a role row that cannot prove who granted it is refused as a
countersigner — a row that cannot prove it was not self-granted has no business ratifying a number
someone will be paid on.

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
`paperUploadLimiter` · `postCreateLimiter` · `reactionLimiter` · `disputeLimiter` ·
`paymentRecordLimiter` (§7A)

### 4b. Units, money and the `bigint` policy

Restating §1 as a schema rule, plus the two traps:

- **Money is `bigint`, not `integer`.** Drizzle's `integer` is Postgres `int4`, which caps at
  ±2,147,483,647 — **±$21,474,836.47**. A single Series-A round or Project Immortal's
  `estimatedMarketSizeInCents` (`"$12B est. market"`=`1200000000000`, 560× the ceiling) overflows
  it. This must be right on day one, because the audit and statement hash chains (§4c) cover
  amounts: widening the column later invalidates every historical hash.
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

**Canonical hashing.** `src/lib/canonical-hash.ts` defines the one serialization used by every hash
chain in this domain (audit §9, compensation statements §7A):

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
// a payout promise the platform will not honour. Clients map enum → localized copy.
//
// THE TWO ESCROW VALUES ARE RETIRED. They forced every cash strand through a milestone escrow
// release (§7), which meant a founder who never ran a funding round here had no way to say "I
// pay this person from my own bank account" — money-in gated data-out — and worse, it made a
// wage conditional on a Proof-of-Effort verdict, which §0 now forbids outright. They stay in
// the enum so migration 0016's existing rows remain readable; nothing new may be written with
// them, and the two new values are the only ones a cash strand accepts.
export const compensationEarnedAsPolicyEnum = pgEnum("compensation_earned_as_policy", [
    "off_platform_payroll", // DEFAULT for cash: paid by the company, reported here (§7A)
    "direct_transfer", // one-off, paid directly, reported here (§7A)
    "slicing_pie_vesting", // equity, and equity only
    "milestone_escrow_release", // RETIRED — readable, never writable
    "on_completion_escrow_release", // RETIRED — readable, never writable
]);

// How a member is engaged. FOUNDER-DECLARED, never inferred: the tax, wage-law and
// social-contribution treatment differ per branch, and misclassification liability belongs to
// the company, not to Qatoto (§7A.6). No endpoint derives this from behaviour, hours, or
// anything else — a platform that guesses employment status is making a legal determination it
// is not qualified to make.
export const engagementKindEnum = pgEnum("engagement_kind", [
    "employee",
    "independent_contractor",
    "unpaid_founder",
]);

// A compensation period's lifecycle (§7A). `finalized` is terminal and hash-frozen; a
// correction supersedes the period with a new one rather than editing it, the same way the
// audit chain corrects by reversal rather than by UPDATE (§4f).
export const compensationPeriodStatusEnum = pgEnum("compensation_period_status", [
    "open",
    "finalized",
    "superseded",
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

// --- Go-to-market (§11i). DECLARED WITH THE §6 FAMILY IN CODE, not in the shared block: they
// are read by one domain, which is where discoveryRegionKind and talentAvailability also sit.
// Appendix B asked for them "in §4d with everything else"; they are documented here and
// declared beside their tables, which is the convention every other single-domain enum follows.

// How far a supplier listing has been checked. NEVER CLIENT-SETTABLE, and absent from the
// create schema entirely — a directory whose rows assert their own trust level is worse than
// no directory. Only a platform moderator moves it.
export const supplierVerificationStateEnum = pgEnum("supplier_verification_state", [
    "unverified",
    "documents_pending",
    "verified",
    "suspended",
]);

export const supplierCapabilityKindEnum = pgEnum("supplier_capability_kind", [
    "manufacturing",
    "assembly",
    "tooling",
    "packaging",
    "logistics",
    "certification",
    "design",
    "sourcing",
]);

// `no_contact` exists because a curated directory lists entities that never asked to be
// listed. A row a moderator added from public information must be able to say "reference only"
// rather than becoming an inbox nobody consented to.
export const supplierContactPolicyEnum = pgEnum("supplier_contact_policy", [
    "via_platform",
    "direct_email",
    "no_contact",
]);

// A project's OWN record of who it approached. `contracted` means "this team says they signed
// something"; nothing here feeds a supplier's verificationState, or the directory would be
// forgeable one self-report at a time.
export const projectSupplierEngagementStatusEnum = pgEnum("project_supplier_engagement_status", [
    "considering",
    "contacted",
    "contracted",
    "ended",
]);
```

### 4e. The job runner

Nothing in this repo runs scheduled or background work today. §6, §7A and §9 all require it —
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
| `recompute-investor-confidence` | nightly              | Deal-flow signal (§7)                              |
| `analyze-daily-log`             | on submit            | One Gemini call → transcript + chips + claims (§8) |
| `recompute-daily-log-streaks`   | nightly              | Decay the streak counter on `project_stats` (§8)   |
| `verify-effort-claim`           | on submit            | The 4-step pipeline (§9)                           |
| `recompute-slicing-pie`         | nightly + on verdict | The equity ledger (§9)                             |
| `sweep-dispute-windows`         | every minute         | Lock expired 24h windows (§9)                      |
| `recompute-program-stats`       | nightly              | Project Immortal stats (§10)                       |

`reconcile-escrow-ledger`, its tick and `submit-provider-transfer` are **unbound**, along with the
surface they served. Nothing in this domain has a provider balance to disagree with any more, and
nothing enqueues a transfer because a pledge is a commitment. The queue names survive so migration
0016's rows stay explicable and an operator can drain anything left in flight; no worker subscribes
and no cron fires.

| Job                            | Cadence    | Purpose                                                   |
| ------------------------------ | ---------- | --------------------------------------------------------- |
| `close-compensation-period`    | daily tick | Open a period covering today, in the PROJECT'S zone (§7A) |
| `recompute-compensation-draft` | nightly    | Redraw every open period's lines, idempotently (§7A)      |

**Both are DAILY ticks, including the close, and that is the design rather than an accident.** §7A.3
makes a period one calendar month in the project's OWN zone, so the roll-over lands on a different
UTC instant for every project — 1 April begins in Kiritimati fourteen hours before Honolulu. A
monthly cron would have to pick one instant and be wrong for everyone else, and the error would be a
whole day of somebody's wages in the wrong statement. The close runs at 00:10 and the draft at 04:15,
in that order: a draft that ran first would spend a day writing an elapsed month's minutes into a
period that should already have stopped accruing.

Every job: an **idempotency key**, bounded retries with exponential backoff, a dead-letter state,
and the `(data, asOf)` purity rule from §4c. A job that cannot be safely re-run is a bug.

### 4f. Append-only and cascade policy

Two of the drafts wired `onDelete: "cascade"` from `user` → `research_project` → `milestone` → a
payout row, which means **deleting one user account silently erases a financial ledger**. One draft
correctly set a ledger's `participantId` to `restrict` and then set `programId` on the same row to
`cascade`, defeating it entirely.

The policy:

- **Financial and audit tables never cascade.** `funding_round_pledge`, `project_audit_entry`,
  `slice_ledger_entry`, `research_contribution_ledger_entry`, `compensation_period`,
  `compensation_period_line` and `compensation_payment_record` use `restrict` on every parent FK.
  A project or user with financial history cannot be hard-deleted — it is archived. This holds even
  though no money moves: a finalized statement is the evidence a wage was owed and paid, and a
  deleted user must not be able to erase it.
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
    "archived", // withdrawn but preserved — members, slices and statement history reference it
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
> `milestone → compensation_period → compensation_period_line` and lets a single account deletion
> erase the record of what a team was owed and paid.

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
`salary`/`one_time` must be `off_platform_payroll` or `direct_transfer` (§4d). **A founder cannot
advertise a payout mechanism the platform will not honour**, and the two retired escrow policies are
rejected on write: they promised a payout through a rail that no longer exists, and made a cash
promise conditional on a verification verdict, which §0 forbids.

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
| `supplier`                       | A manufacturing partner. Moderator-authored — §11i                         |
| `supplier_capability`            | Seeded capability vocabulary, `discovery_skill`'s shape exactly            |
| `supplier_capability_link`       | Join to the vocabulary, `talent_profile_skill`'s shape exactly             |
| `project_supplier_engagement`    | Which project engaged which supplier — the launch-ready rail's provenance  |

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

### The go-to-market four (§11i)

The supplier directory is **the same kind of thing** as the talent directory and the cluster map —
a curated, filterable catalogue over a controlled vocabulary — so it is modelled on them rather
than invented. `supplier_capability` copies `discovery_skill` (seeded, `isActive` retirement, **no
moderation status**, because with no `POST` there is no spam surface to moderate);
`supplier_capability_link` copies `talent_profile_skill` (composite PK, `cascade` from the owner,
`restrict` on the taxonomy). `project_supplier_engagement` takes `restrict` into
`research_project`, per R1.

Three decisions worth naming, because each closed a question the appendix left open:

- **Writes are platform `moderator` only**, checked in-service by `requirePlatformCapability` before
  any id is read. There is **no user-submission path**: a self-serve, immediately-public supplier
  listing needs a moderation queue, a rate limiter and an abuse story, and none of that is worth
  building before the first real supplier exists.
- **`verificationState` is absent from the create schema.** A new listing is always `unverified`,
  and only a moderator moves it. A directory whose rows assert their own trust level is worse than
  no directory.
- **There is no price column on `supplier`.** §4b requires a currency beside every money column and
  derives it from the **project**, never a request body — and a supplier belongs to no project, so
  a directory-level price would have to invent one. `leadTimeDays` and `minimumOrderQuantity` are
  unit-free integers and stay; a quote belongs to an engagement, priced in that project's currency.

**The structural gap this closed.** `product` (`schema.ts`, STORE §4) carried exactly one FK,
`sellerId → user`, so "this project shipped this listing" was not expressible at all. It now carries
a nullable `researchProjectId` with `onDelete: "restrict"` (R1). That column is R&D's **only**
contribution to the store domain: listing creation stays in the studio's own flow, and a research
route that proxied a product create "for convenience" would duplicate validation, pricing and
ownership checks the store already re-validates. The column is documented in
[STORE_BACKEND_STRUCTURE.md](STORE_BACKEND_STRUCTURE.md) §4, where `product` actually lives —
Appendix B originally assigned it to the studio doc, which owns `video`, not `product`.

### Server-side filtering

Every list in this domain is filtered client-side today over tiny mock arrays. Per CLAUDE.md
§"Performance", heavy work belongs on the server. Each list endpoint therefore takes explicit
query params — `?category=&region=&commitment=&skill=&availability=&sort=&page=&limit=` — with
keyset pagination whose `ORDER BY` ends in a unique column (§4c).

---

## 7. The data — funding rounds, pledges, milestones ⚠️ superseded in part

> **What changed, and why.** This section shipped in full: funding rounds, pledges, milestones, a
> double-entry escrow ledger, a hash chain, a four-eyes release and a reconciliation job. **The
> escrow half is now removed from this contract.** Two reasons, and the second is the serious one.
>
> **1. Custody was never needed here, and it is the most expensive thing in the product.** Holding
> money for later payout is regulated in all three target jurisdictions — PSD2 authorisation in the
> EU, state money-transmitter licensing plus FinCEN registration and a BSA/AML program in the US,
> RBI payment-aggregator authorisation with a ₹15 crore net-worth floor in India — whether or not a
> fee is charged (§7A.6). Qatoto does not need to touch the money to do the job it is actually good
> at, which is knowing exactly what is owed and proving it.
>
> **2. Escrow release had become the gate on cash compensation, and that is unlawful.**
> `open_role_compensation.earnedAsPolicy` forced every salary and one-time strand through
> `milestone_escrow_release` or `on_completion_escrow_release`, and a release was gated on a
> Proof-of-Effort verdict of `verified` plus a closed dispute window. Applied to an employee that is
> conditioning earned wages on an algorithm passing — unlawful withholding under the FLSA and state
> timely-payment statutes in the US, under national wage law across the EU, and under §18 of India's
> Code on Wages 2019. It also meant a founder who never ran a funding round through Qatoto had **no
> way to record that they pay someone from their own bank account**: money-in gated data-out, which
> is exactly backwards for a product whose value is the data.
>
> **What replaces it: [§7A](#7a-the-data--compensation-periods-and-payout-statements).** Qatoto
> computes what each member is owed each month in cash and in equity, freezes it, and records the
> payment the parties make between themselves.
>
> **Where the escrow design went:
> [ESCROW_LEDGER_STRUCTURE.md](ESCROW_LEDGER_STRUCTURE.md).** The double-entry ledger, the zero-sum
> invariant, the hash chain, the four-way append-only enforcement, the four-eyes release and the
> reconciliation job are good, domain-neutral engineering. They are preserved unabridged and
> retargeted at the **commerce** domain, where a buyer↔seller hold is a real product requirement —
> and even there Qatoto mirrors a licensed provider rather than custodying.

### What survives here: funding as a record of intent

Funding rounds, pledges and milestones **remain**, with the custody removed from underneath them.

- A **pledge is a commitment, not a charge.** `POST /funding-rounds/:roundId/pledges` still accepts
  exactly `{ amountInCents }` and still re-bounds it against the round's own min/max. No card is
  charged, no funds are held, and **no client copy may imply otherwise** — the response says a
  commitment was recorded, never that a payment succeeded.
- `raisedAmountInCents` and `backersCount` are sums of **committed** pledges, and the read
  projection must label them as such. `percentageFundedBasisPoints` is still computed on read as
  `floor(raised * 10000 / goal)`, never stored, and may exceed `10000` when overcommitted.
- `SELF_PLEDGE_FORBIDDEN` stays. A founder pledging to their own round inflates the three numbers an
  outsider uses to judge whether **strangers** believe in a project, and the frontend has no way to
  tell the difference.
- **Milestones stay**, and `escrowReleaseAmountInCents` is renamed **`plannedPayoutInCents`** — the
  founder's declared payout for hitting the milestone. It is a plan, not an instruction to a payment
  rail, and it feeds §7A's statement as a `direct_transfer` line rather than triggering anything.
- `investor_confidence_snapshot` stays, computed nightly from log streak, verified milestones and
  dispute rate, and returned with its `asOf`. It replaces the hardcoded
  `INVESTOR_CONFIDENCE_PERCENT = 78` in `funding-tab.tsx`.
- **The platform fee is `0`** (§0). `PLATFORM_FEE_BASIS_POINTS` stays in config because removing an
  env var that migration 0016's historical rows were priced with would make those rows
  unexplainable, but it is `0`, the fee posting is omitted entirely rather than written as a row of
  zeros, and no new pledge carries one.

**Regulatory gating survives and tightens.** `config.ENABLED_FUNDING_ROUND_TYPES` (env, default
`["crowdfunding"]`) is checked **at the API** — before creating a round, before opening one, before
accepting a pledge, and in the `/funding/deals` filter — so hiding a chip in
`funding-deal-filter-grid.tsx` stays cosmetic rather than load-bearing. Equity and venture round
types remain disabled: they are securities offerings requiring, at minimum, SEC/FINRA registration
or a licensed broker-dealer partner in the US and a prospectus or an applicable exemption under
Regulation (EU) 2017/1129 in the EU.

### What is gone from this domain, and must not come back

`escrow_account`, `escrow_journal_entry`, `escrow_posting`, `escrow_release`, `provider_transfer`,
`provider_webhook_event`, `reconciliation_discrepancy`, the `reconcile-escrow-ledger` job, and every
route under `/escrow/*`, `/escrow-releases/*` and `/provider-transfers/*`. Also gone:
`POST /webhooks/payments/stripe`, which was never built and now never will be, and the raw-body
mount it would have needed.

The tables and services still exist in the running backend (migration 0016, `escrow.service.ts` and
six siblings), but **nothing routes to them and no worker binds their jobs** — see §11g. This
contract does not describe them, and no new code may call them.

---

## 7A. The data — compensation periods and payout statements

The product founders actually asked for: **"tell me what I owe each person this month."** Not a
payment rail — a number, with its working shown, that a founder can act on and an employee can
trust.

This is the section that makes §9's verification worth building. Slicing Pie already computes an
equity position; the fair market rate already carries what a member is paid in cash for the same
hour (`member_fair_market_rate.paidCashRateCentsPerHour`, §9); the slice ledger already records
verified minutes with the instant they were credited to. **Every input exists.** What was missing was
anything that summed a calendar month and said, in one row per person: this is what you are owed,
this is why, and here is proof nobody edited it afterwards.

### 7A.1 The shape of the thing

```text
An OPEN period accrues.        Redrawn nightly. Nothing is frozen; numbers may move.
A FINALIZED period is frozen.  Hash-chained. Two people signed it. It never changes.
A payment is RECORDED, not made.  The founder pays from their own bank. Both sides confirm.
```

Three rules govern every line of it:

1. **Cash is never gated on a verdict** (§0). A `flagged_for_review` claim annotates a line and
   never reduces it. §9 withholds slices; it does not withhold wages.
2. **No amount is ever in a request body.** A line is computed from an accepted agreement and the
   member's own recorded minutes. The only number a client may send is `paidAmountInCents` on a
   payment record — and that is an attestation about the outside world, not an assertion about what
   is owed.
3. **Gross only.** Qatoto computes no withholding, no tax, no social contribution. It is not a
   payroll processor (§7A.6).

### 7A.2 `member_cash_compensation_agreement`

What a member is paid in cash, and on what basis. Mirrors `member_fair_market_rate` (§9) exactly —
effective-dated, member-accepted, trigger-frozen — because it is the same kind of object and a
second shape would be a second source of truth.

```ts
export const memberCashCompensationAgreement = pgTable(
    "member_cash_compensation_agreement",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => randomUUID()),
        // restrict on both, per §4f. This row is the basis for what someone was paid.
        projectId: text("project_id")
            .notNull()
            .references(() => researchProject.id, { onDelete: "restrict" }),
        memberId: text("member_id")
            .notNull()
            .references(() => projectMember.id, { onDelete: "restrict" }),
        // FOUNDER-DECLARED, never inferred (§4d). Qatoto does not classify employment.
        engagementKind: engagementKindEnum("engagement_kind").notNull(),
        // Exactly one of these two is non-null — a CHECK enforces it. A retainer is a flat
        // monthly amount; an hourly agreement prices verified minutes. `bigint` because it is
        // money (§4b).
        monthlyAmountInCents: bigint("monthly_amount_in_cents", { mode: "bigint" }),
        hourlyRateCentsPerHour: bigint("hourly_rate_cents_per_hour", { mode: "bigint" }),
        // Derived from the project, never from a request body (§4b).
        currencyCode: text("currency_code").notNull(),
        status: compensationAgreementStatusEnum("status").default("proposed").notNull(),
        // Absolute instants, never day counts (§4c rule 3). `effectiveUntil` NULL = in force.
        effectiveFrom: timestamp("effective_from").notNull(),
        effectiveUntil: timestamp("effective_until"),
        // Why this number. Required, for the same reason §9's rate requires one: an amount with
        // no stated basis is founder fiat with extra steps.
        rationaleNote: text("rationale_note").notNull(),
        proposedByUserId: text("proposed_by_user_id")
            .notNull()
            .references(() => user.id, { onDelete: "restrict" }),
        acceptedAt: timestamp("accepted_at"),
        acceptedByUserId: text("accepted_by_user_id").references(() => user.id, {
            onDelete: "restrict",
        }),
        createdAt: timestamp("created_at").defaultNow().notNull(),
    },
    (table) => [
        // "Which agreement was in force for this member at this instant?" Ends in a unique
        // column so two rows sharing an instant cannot swap places between reads (§4c rule 4).
        index("member_cash_comp_agreement_member_effectiveFrom_idx").on(
            table.memberId,
            table.effectiveFrom,
            table.id,
        ),
        // At most one ACTIVE agreement per member. Two would make "what is this person paid"
        // ambiguous in the one place ambiguity is unacceptable.
        uniqueIndex("member_cash_comp_agreement_active_unq")
            .on(table.memberId)
            .where(sql`status = 'active'`),
        check(
            "member_cash_comp_agreement_basis_ck",
            sql`(monthly_amount_in_cents IS NOT NULL) <> (hourly_rate_cents_per_hour IS NOT NULL)`,
        ),
    ],
);
```

**The acceptance step is not ceremony.** A founder proposes; the member accepts; only then does the
row become `active` and only then does it price anything. A hand-written trigger freezes
`monthlyAmountInCents`, `hourlyRateCentsPerHour`, `currencyCode` and `effectiveFrom` at acceptance —
migration 0014 already does exactly this for `member_fair_market_rate` and is the pattern to copy. A
founder who can silently edit an accepted rate can silently rewrite what someone is owed, which is
the founder-fiat failure mode PROOF_OF_EFFORT_SPEC.md §2 exists to eliminate.

> **`paidCashRateCentsPerHour` on §9's rate row is not this table.** That column exists so the slice
> math can price the **unpaid** portion of an hour (`fairMarketRate − paidCash`, `slice-math.ts`).
> This table is what the member is actually paid. They are usually the same number and must still be
> two columns: one is an input to an equity formula, the other is an obligation. When an hourly
> agreement is `active`, the two are validated equal at acceptance and a mismatch is a `422`, so the
> pie and the payslip cannot disagree.

### 7A.3 `compensation_period` and `compensation_period_line`

A period is one calendar month **in the project's own time zone** — `project_stats.projectTimeZone`,
the same IANA zone the daily-log streak already uses. Without it "a month" is undefined for a
distributed team, and a period boundary would land in two different places for two members.

| Column                                      | Notes                                                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `projectId`                                 | `restrict` (§4f)                                                                                                                            |
| `sequenceNumber`                            | Gapless per project from 1, allocated under the **existing** `project_chain_head` lock — never a second lock (§9.9's note applies verbatim) |
| `periodStartDate` / `periodEndDate`         | Calendar days, half-open `[start, end)`                                                                                                     |
| `timeZone`                                  | Snapshotted from the project at open, so a later zone change cannot silently re-slice a finalized month                                     |
| `status`                                    | §4d — `open` \| `finalized` \| `superseded`                                                                                                 |
| `finalizedAt` / `finalizedByUserId`         | Set together, once                                                                                                                          |
| `countersignedAt` / `countersignedByUserId` | The second pair of eyes (§4a). Must differ from `finalizedByUserId`                                                                         |
| `statementHash` / `previousStatementHash`   | Canonical hash per §4c, full 64 hex chars. Genesis is the literal `"genesis"`                                                               |
| `hashVersion`                               | So the algorithm can evolve without invalidating history                                                                                    |
| `supersededByPeriodId`                      | A correction creates a **new** period that supersedes this one. Nothing is ever edited (§4f)                                                |

`compensation_period_line` — one row per member per kind:

| Column                                           | Notes                                                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`                                           | `cash_retainer` \| `cash_hourly` \| `equity_delta`                                                                                    |
| `memberId`                                       | `restrict`                                                                                                                            |
| `grossAmountInCents`                             | `bigint`. NULL on an `equity_delta` line — equity is not money and must never be summed with it                                       |
| `currency`                                       | Always beside the amount (§4b)                                                                                                        |
| `effortMinutes`                                  | Integer minutes, on `cash_hourly` only                                                                                                |
| `sourceAgreementId` / `sourceRateId`             | The exact rows the number came from, denormalized so an auditor need not re-resolve effective dating years later                      |
| `equityBasisPointsAtStart` / `…AtEnd` / `…Delta` | On `equity_delta` only. `Delta` is **signed** — a member's share falls when others out-contribute them, and that is the model working |
| `verificationNote`                               | Free text, nullable. **The only place a verdict may touch a cash line, and it changes no number** (§0)                                |

```ts
// One line per member per kind per period. Re-running the nightly draft must be a no-op, not
// a duplicate — the same shape as slice_ledger_entry's per-proposal-per-kind uniqueness (§9.6).
uniqueIndex("compensation_period_line_period_member_kind_unq").on(
    table.periodId,
    table.memberId,
    table.kind,
),
// An equity line carries basis points and no money; a cash line carries money and no basis
// points. Encoded here rather than in a comment.
check(
    "compensation_period_line_kind_ck",
    sql`(kind = 'equity_delta') = (gross_amount_in_cents IS NULL AND equity_basis_points_delta IS NOT NULL)`,
),
```

### 7A.4 The math

Every integer goes through `src/lib/money.ts` (§4c). No float touches any of it, and no division
happens in SQL — SQL aggregates raw integers, TypeScript divides.

**`cash_hourly`** — verified minutes in the window, priced at the accepted hourly rate:

```text
minutes = Σ slice_ledger_entry.effortMinutes
          WHERE memberId = ? AND occurredAt ∈ [periodStart, periodEnd)
            AND entryKind = 'award' AND contributionKind = 'time'
gross   = divRoundHalfAwayFromZero(minutes × hourlyRateCentsPerHour, 60)
```

The denominator is `60`, applied **once**, at the end. `minutes / 60 × rate` is the trap §4c names
explicitly: a 20-minute log yields `0.333…` and two servers disagree in the last cent.

Reversal entries (`entryKind = 'reversal'`, negative minutes) are included, because a reversed
contribution was reversed for a reason and the arithmetic must reflect it. The sum is clamped at
zero — a period cannot owe negative wages; an over-payment is corrected by superseding the period,
not by a negative line.

**`cash_retainer`** — the flat monthly amount, prorated by day count when the agreement did not
cover the whole period:

```text
gross = divRoundHalfAwayFromZero(monthlyAmountInCents × coveredDays, daysInPeriod)
```

`coveredDays` is computed from the agreement's `effectiveFrom`/`effectiveUntil` intersected with the
period, in the period's own time zone. A member who joined on the 15th is owed half a month, and the
proration is stated rather than left to a founder's arithmetic.

**`equity_delta`** — the change in the member's entitlement across the period:

```text
atStart = equity_snapshot_share.basisPoints  in the last snapshot at or before periodStart
atEnd   = equity_snapshot_share.basisPoints  in the last snapshot at or before periodEnd
delta   = atEnd − atStart          // SIGNED
```

No apportionment happens here — §9.4 already guarantees each snapshot's shares sum to exactly
`10000`, so a delta is a subtraction and nothing more. A member with no snapshot at `periodStart`
(they joined mid-period) has `atStart = 0`, which is correct rather than a special case.

> **The equity line is a statement of entitlement, not an issuance.** Nothing here grants a share,
> and no client may say it does — see §7A.6 item 4 and §9.11.

### 7A.5 The lifecycle, and the two jobs

```text
[project's month rolls over, in ITS time zone]
close-compensation-period                DAILY tick, acting per project's own zone
  → the open period's status stays `open` but it stops accruing; a new period opens
  → NOTHING is frozen yet. A founder has not seen it.
  → MORE THAN ONE PERIOD MAY BE `open`: an unfinalized March beside an accruing April.
    The unique index is per project PER MONTH for exactly this reason.
  → it WALKS month by month rather than jumping to today, so a worker down for a
    quarter produces three periods rather than one three-month period.

recompute-compensation-draft            nightly, (data, asOf)-pure per §4c
  → redraws every line of every open period from scratch, idempotently
  → a re-run produces byte-identical rows. That is the test, not an aspiration.

POST …/compensation-periods/:id/finalize        founder
  → 409 PERIOD_NOT_READY if the period has not closed
  → 409 RATE_NOT_LOCKED   if any member with a cash_hourly line has no locked §9 rate
  → recomputes synchronously one last time, freezes every line, computes statementHash over
    the canonical serialization of (period, lines sorted by (memberId, kind)), appends ONE
    project_audit_entry in the same transaction, under the same project_chain_head lock
  → status = 'finalized', and the NEXT month opens in that same transaction — a project
    with no open period is a project silently losing effort out of every statement

POST …/compensation-periods/:id/countersign     a DIFFERENT admin or the platform auditor
  → 422 SELF_COUNTERSIGN_FORBIDDEN if it is the finalizer, even for a founder
  → 403 if the admin role has no recorded grantor (§4a)

POST …/compensation-period-lines/:lineId/payments   founder/admin
  → { paidAmountInCents, paidOnDate, methodKey, referenceNote? }  ← an ATTESTATION
  → append-only. Recording a payment does not move money and does not change the line.

POST …/compensation-period-lines/:lineId/payments/:paymentId/confirm    THE MEMBER
  → the other half of the evidence. A payment nobody received is a claim, not a record.
```

**Corrections supersede; they never edit.** A finalized period whose numbers turn out wrong is not
reopened — a new period is created with `supersededByPeriodId` pointing back, the audit chain
records both, and the member can see exactly what changed and when. This is the same discipline
§4f applies to the audit ledger, for the same reason: a record that can be quietly rewritten is not
evidence of anything.

### `compensation_payment_record`

Append-only. `lineId` (`restrict`), `paidAmountInCents` (`bigint`), `paidOnDate` (calendar day —
the day the payer says the money left), `methodKey`
(`bank_transfer | sepa_transfer | upi | payroll_provider | cash | other`), `referenceNote`
(free text, e.g. a UTR or the payroll run id), `recordedByUserId`, `confirmedByMemberAt`,
`confirmedByUserId`, `createdAt`. No `updatedAt` — there is nothing to update.

> **It stores no account number, no IBAN, no UPI handle, no card detail, and no payment
> instrument of any kind.** `referenceNote` is a human note, and the API rejects anything that
> pattern-matches a PAN. Storing payment instruments would drag PCI-DSS scope into a product that
> has no business being in it, create a PII breach surface with no upside, and hand an attacker a
> wire-fraud primitive — the same reason §7's `payoutDestinationId` was never client-supplied.

**Two-sided confirmation is what makes this evidence rather than bookkeeping.** A founder recording
"paid" is an assertion. A member confirming receipt is corroboration. The pair, hash-chained against
a frozen statement line, is the artifact that answers "was this person paid what they were owed, and
when" — which is the question a labour inspector, an acquirer's diligence team, or an aggrieved
ex-employee actually asks. The UI must show unconfirmed payments as unconfirmed and never as paid.

### 7A.6 Is this legal, and is it feasible?

This subsection exists because the question was asked directly, and because every rule in §0 that
was added with this section has a statute behind it. It is a **statement of the design constraints
that follow from the law, not legal advice** — the operative dates and thresholds below must be
confirmed with counsel in each jurisdiction before launch.

**The threshold point.** Money-transmission and payment-aggregation rules turn on **whether you
receive and control funds**, not on whether you charge for it. An unpaid escrow is still an escrow.
The exemption comes from **non-custody**, which is what this section delivers. Being free is
additive — it removes the fee-based "compensation for the service" hook that several US state
money-transmitter definitions turn on, and removes any argument that Qatoto profits from float — but
it does **not** reduce the securities, wage-law, AI or data-protection exposure below. Those attach
to what the product _does_.

**1. Custody: avoided, and that is the single largest compliance saving in the product.**

| Jurisdiction | What holding funds would have triggered                                                                                                                                                                                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **US**       | State money-transmitter licensing across ~49 states + DC + PR (surety bonds, multi-year), FinCEN MSB registration (31 CFR 1010.100(ff)), a BSA/AML program — KYC, SAR/CTR, OFAC screening — plus escrow-agent licensing in states like California (Financial Code Div. 6, DFPI) and Washington |
| **EU**       | A payment service under **PSD2** (Directive (EU) 2015/2366): payment-institution authorisation, own-funds and safeguarding of client money, AMLD obligations. The commercial-agent exclusion in Art. 3(b) is read narrowly by the EBA                                                          |
| **India**    | RBI **Payment Aggregator** authorisation — pooling and settling funds requires an escrow account with a scheduled commercial bank, net worth ₹15 crore at application rising to ₹25 crore by the end of the third financial year                                                               |

None of it applies to a system that computes an obligation and records an attestation that it was
settled elsewhere. That is bookkeeping software.

**2. Wage law: the defect this section fixes.** Conditioning earned wages on an algorithmic
verification is unlawful. In the **US**, the FLSA (29 U.S.C. §§206–207) plus state timely-payment
statutes (NY Labor Law §191, CA Labor Code §204) require earned wages on schedule. Across the **EU**
wage payment and permitted deductions are national law, but the direction is uniform — a deduction
needs a statutory or contractual basis, and the Adequate Minimum Wages Directive (EU) 2022/2041
reinforces the floor. In **India**, Code on Wages 2019 §17 sets a wage period of at most one month
with monthly wages due by the 7th of the following month, and §18's list of permitted deductions is
exhaustive. "The verification pipeline found no commit" is on none of these lists. Hence §0's rule:
**a verdict may annotate a cash line; it may never change its number.**

**3. Employment classification and tax stay with the company.** `engagementKind` is
founder-declared and never inferred (§4d), because misclassification liability — IRS common-law and
state ABC tests in the US, national presumption-of-employment rules and the Platform Work Directive
in the EU, contract-labour and EPF/ESI thresholds in India — belongs to the employer, and a platform
that guesses employment status from behaviour is making a legal determination it is not qualified to
make. Statements report **gross only** and compute no withholding: US federal/state income tax,
FICA, W-2 vs 1099-NEC; EU national PAYE-equivalents and social contributions; India TDS under IT Act
§192/§194J/§194C, PF and ESI. The export feeds the founder's existing payroll provider. **Qatoto is
not a payroll processor and every statement surface must say so.**

**4. Equity is securities — the largest residual exposure, and escrow was never its cause.** Nothing
in §9 or §7A issues a share. What it produces is an **entitlement record**: a contractual
calculation of what a member has earned, which becomes stock only through corporate action.

- **US:** compensatory equity is a securities offering. Rule 701 (17 CFR 230.701) exempts grants by
  non-reporting issuers only under a written compensatory benefit plan, with volume caps and
  enhanced disclosure above the $10M threshold; options require board approval and a 409A valuation.
- **EU:** grants are national company law (works-council consultation in DE/NL, notarial acts for
  share transfers in several member states), plus the Prospectus Regulation (EU) 2017/1129, whose
  Art. 1(4)(i) employee-scheme exemption is conditional on supplying an information document.
- **India:** ESOPs require Companies Act 2013 §62(1)(b) with Rule 12 of the Companies (Share Capital
  and Debentures) Rules 2014 — resolution plus PAS-3 on allotment. Sweat equity requires §54 with
  Rule 8: a registered-valuer report and statutory caps (15% of paid-up capital per year or ₹5
  crore, whichever is higher; 25% outstanding at any time, relaxed to 50% for DPIIT-recognised
  startups for ten years).

Continuous auto-issuance is impossible under all three. So §9.11's bake produces **draft instruments
for the board and counsel**, gated on a recorded board-approval reference — never a grant. And no
surface may tell a founder they do not need a lawyer: generating instruments while giving that
assurance is unauthorized-practice-of-law exposure in most US states.

**5. The EU AI Act applies to this product, and it was missing from the doc set.** Regulation (EU)
2024/1689 binds providers placing an AI system on the EU market **and** non-EU providers whose
system's output is used in the EU. §8's daily-log analysis feeding §9's verdict is squarely
**Annex III(4)(b)** — AI used to make decisions affecting terms of work-related relationships, to
allocate tasks, or to **monitor and evaluate the performance and behaviour of persons in
work-related relationships**. That is high-risk, which brings the Chapter III duties: risk
management, data governance, technical documentation, automatic logging, transparency toward
deployers, **human oversight (Art. 14)**, accuracy and robustness, quality management, conformity
assessment and registration before placing on market.

Two consequences are structural rather than paperwork:

- **§9's dispute window and founder override are the Art. 14 human-oversight control** — and, for a
  member in the EU, the Art. 22 GDPR right to human intervention. They stop being a product nicety
  and become non-bypassable. No configuration may disable them for a pay-affecting decision.
- **Art. 5(1)(f) prohibits emotion inference in the workplace outright.** Not high-risk —
  prohibited. §8's boundary follows from this, and it is a hard one.

Timing as adopted: in force 1 Aug 2024; prohibitions and AI-literacy duties from 2 Feb 2025; GPAI
from 2 Aug 2025; Annex III high-risk from 2 Aug 2026. Amendments to that timeline have been under
discussion — **confirm the operative dates before relying on them.** Separately, the **Platform Work
Directive** (EU) 2024/2831 (member-state transposition by 2 Dec 2026) sets algorithmic-management
rules — limits on processing certain worker data, human review of significant decisions, and
transparency toward workers. Qatoto is a tool for employers rather than a platform employer, but its
customers inherit those duties and the product must let them comply.

**6. Data protection and worker monitoring.** Daily-log video, GitHub tokens and temporal anomaly
detection on commit metadata add up to employee monitoring, and that is the framing to design
against rather than discover.

- **EU:** consent is generally an **invalid** lawful basis in an employment relationship because of
  the power imbalance (EDPB Opinion 2/2017) — the basis must be contract or legitimate interest with
  a documented assessment. **Art. 22** covers decisions with legal or similarly significant effects,
  which compensation is. **Art. 88** plus national employment-data law applies, and in Germany a
  monitoring tool needs works-council co-determination (BetrVG §87(1)(6)) — a practical gate on
  selling there, not a footnote. A DPIA under Art. 35 is mandatory for systematic monitoring.
  Transfers to US processing need SCCs or the EU–US Data Privacy Framework.
- **US:** Illinois BIPA if any biometric is derived from daily-log video; the Illinois AI Video
  Interview Act if video analysis ever touches hiring (the talent directory is one step away); NYC
  Local Law 144's bias-audit duty for automated employment decision tools used in hiring or
  promotion; CPRA employee-data rights; Colorado SB24-205 on consequential decisions including
  compensation.
- **India:** DPDP Act 2023 — notice, consent, purpose limitation, erasure, and significant-data-
  fiduciary duties above the thresholds.

§9.10 already carries per-project, per-provider revocable consent and the retention obligations;
what this section adds is that the **statement** is itself personal data with the same retention and
access rights, and that §9.10's "four further obligations, none of which exist yet" are now
compliance items with dates attached, not backlog.

**7. Feasibility: high, and it was net less code.** ✅ **Shipped.** The addition was four tables,
six enums, two jobs and twelve endpoints; the removal deleted nine routes, three job bindings, 268
lines of controller and a 605-line smoke script. Every input already existed —
`slice_ledger_entry.effortMinutes` with `occurredAt` and `memberId`,
`member_fair_market_rate.paidCashRateCentsPerHour`, `equity_snapshot_share`, `project_chain_head`
for the lock and the chain, `project_audit_entry` for the freeze. The addition is four tables, two
enums, two jobs and eight endpoints, every one of them reusing a pattern that already shipped: the
effective-dated / accept / lock trigger from `member_fair_market_rate` (migration 0014), the hash
chain from §9.9, the idempotent nightly recompute from `recompute-equity-snapshot`.

The removal side **deleted** work: no payment SDK, no webhook route, no raw-body mount, no provider
reconciliation, no AML program, no licensing project. That is the rare change where the compliant
option was also the smaller one.

### The rejected-keys list

`.strict()` turns each of these into a `422` instead of a silent overwrite. Enumerated so a reviewer
can grep for them across every §7 and §7A body:

```text
backerUserId · userId · memberUserId · projectId · currency · currencyCode
platformFeeInCents · feeInCents · status · verificationStatus · verdict
equityBasisPoints · equityBasisPointsDelta · sliceCount · slices · grossAmountInCents
effortMinutes · minutes · hours · raisedAmountInCents · percentageFunded
percentageFundedBasisPoints · backersCount · statementHash · previousStatementHash
sequenceNumber · finalizedAt · finalizedByUserId · countersignedByUserId
payoutDestinationId · destinationAccountId · accountNumber · iban · upiId
paymentMethodId · occurredAt · createdAt · id
```

The three groups are worth naming. `grossAmountInCents`, `effortMinutes` and every equity field are
**computed outputs** — there is no field to tamper with, which is the answer to "what if the client
edits the number and posts it back". `statementHash` and `sequenceNumber` are **chain integrity** —
a client-supplied hash is a forged chain. And `accountNumber` / `iban` / `upiId` /
`destinationAccountId` are **wire-fraud primitives**: this domain never stores a payment instrument,
so a body carrying one is either a bug or an attack, and both deserve a `422`.

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

`analyze-daily-log` makes **one** structured-output call to Gemini (AI Studio) with the
YouTube URL when there is one and the narrative text when there is not, and writes the transcript
segments, the AI summary chips, the extracted claims and the evidence links from that single
response. One call rather than a transcribe-then-extract pair, because two calls are two draws
against a free quota for the same tokens.

**The model is `gemini-3.5-flash-lite`** (`GEMINI_MODEL`), and three request-shape decisions are
specific to the Gemini 3.x family rather than incidental:

- **`thinkingLevel: "low"`, pinned rather than defaulted.** These are thinking models, and this
  task is mechanical — transcribe what was said, copy down what was claimed, echo the URLs. Note
  the 2.5-era spelling `thinkingBudget: 0` is answered with a **400 INVALID_ARGUMENT** by the 3.x
  family, so a downgrade to a 2.5 model is not a drop-in swap of `GEMINI_MODEL` alone.
- **`temperature: 0`, kept**, though the family's own default is 1. §4c governs the formula, not
  the model, but a stable temperature makes a re-analysis after a fix comparable to the run it
  replaced. Verified against both a text-only log and a YouTube video: schema-conforming output,
  `finishReason: STOP`, no looping.
- **A generous `GEMINI_MAX_OUTPUT_TOKENS` (32,768 of the model's 65,536).** It is a cap, not a
  reservation, so an unused ceiling costs nothing — while an undersized one truncates a long
  transcript into a **permanent** failure. The prompt additionally asks for segments no shorter
  than ~10 seconds, which is what keeps a long log inside the ceiling at all.

The job's own lifecycle is `daily_log.analysisStatus`
(`not_requested | queued | running | succeeded | failed | skipped_unconfigured`) and it is
**orthogonal to `effortVerificationStatus`** — the same split the studio domain draws between
`uploadStatus`, `publishStatus` and `reviewStatus`. One column cannot say "transcribed but
unverified", and §9 owns the verdict column exclusively:

- No `GEMINI_API_KEY` configured → `skipped_unconfigured`. Not `failed`, and above all not a chip.
- Gemini rejects the input (private video, blocked region) → `failed` with a reason, and the log
  keeps its narrative. Analysis is retried against the narrative alone, never abandoned silently.
- 429 / 5xx / timeout → retryable; pg-boss backs off per §4e.
- The answer hits the output ceiling (`finishReason: MAX_TOKENS`) → `failed`, permanently, **with
  its own reason string**. Truncation is equally permanent but it is not a refusal: the fix is an
  operator raising the ceiling, so folding it in with "could not read this log" would send them to
  inspect a video that was never the problem.
- Output that fails its Zod schema after **one** repair attempt → `failed`, permanently. The same
  line §9.7 draws for schema-invalid LLM output.

In every failure mode `effortVerificationStatus` stays `not_run`. **A broken pipeline awards
nothing and asserts nothing** — it never writes `verified`, and it never invents a chip.

Everything Gemini produces is §9.1's left column: AI-produced, reviewable, carrying
`generatedByModel` + `promptVersion` + `confidenceBps`. `daily_log_extracted_claim.extractedMinutes`
is _what the member said_, per §9.6; `groundedMinutes` belongs to §9 and is deliberately absent
here.

**The hard boundary on what this call may extract.** Claims and artifacts — what was said, what was
claimed, which URLs were cited. **Never affect.** No engagement score, no sentiment, no mood, no
stress, no "did this person seem motivated", no inference about the speaker's emotional state from
their voice, face or word choice, and no prompt that asks for one.

This is not a taste judgment about creepy features. Article 5(1)(f) of the EU AI Act (Regulation
(EU) 2024/1689) **prohibits** AI systems that infer emotions of a natural person in the workplace —
prohibited outright, not merely high-risk, with the prohibitions in force since 2 Feb 2025. The
analysis this domain performs is already high-risk under Annex III(4)(b) because it evaluates
work performance (§7A.6 item 5); adding affect inference would move it from a regulated capability
to a banned one. If a future prompt revision is tempted by "and rate the member's confidence in
their own update", the answer is no, and this paragraph is why.

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

**`sent_at` is `timestamp(3)`, and that is a correctness requirement rather than a storage choice.**
The cursor is encoded with `Date.getTime()` — milliseconds — and the column was originally declared
with microsecond precision. A cursor coarser than its column cannot express its own boundary: the
next page asks for `sent_at < <ms>` OR `sent_at = <ms>`, and a message whose true instant carries
microseconds matches neither, so it is **unreachable on every page**. `postMessage` never sets
`sentAt`, so the default `now()` supplied exactly that precision and the defect was live rather than
theoretical — `db:smoke-workshop` lost one message per page boundary until migration 0021 (§17 items
11a and 11b). Any column that feeds a keyset cursor in this domain carries the same requirement;
`daily_log.submitted_at` was narrowed with it.

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

> **This window is a legal control, not only a product feature.** For a member in the EU it is the
> GDPR Art. 22 right to obtain **human intervention**, to express a point of view, and to contest a
> decision with legal or similarly significant effects — which a decision about someone's equity is.
> It is simultaneously the **Art. 14 human-oversight** measure the EU AI Act requires of a
> high-risk system under Annex III(4)(b), since this pipeline evaluates work performance (§7A.6
> item 5). Three consequences follow, and none of them is configurable:
>
> - **No setting may disable, shorten to zero, or auto-resolve a window.** A tenant flag that skipped
>   it would remove the safeguard, not tune it.
> - **A human must be able to reach a real outcome.** The founder override and the member vote are
>   that path; a dispute that can only be rejected by the same automation that raised the verdict is
>   not oversight.
> - **The member must be told the decision was automated, and on what basis.** `evidenceLabels`, the
>   per-step verdicts and the frozen inputs on the proposal are that explanation — they are the
>   contestability surface, which is why §14 lists the missing dispute UI as blocking rather than
>   cosmetic.
>
> None of this reaches cash. §0's first added rule stands: a verdict withholds **slices**, never a
> wage.

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

**Consent is the wrong lawful basis for an employee, and that matters.** Under the GDPR, consent
given by a worker to their employer is generally **invalid** — the power imbalance makes it not
freely given (EDPB Opinion 2/2017). The per-provider grant in this section is still exactly right as
a _technical_ control and as the OAuth scope boundary, but the **lawful basis** for processing a
member's work data must be contract or legitimate interest with a documented assessment, and a DPIA
under Art. 35 is mandatory because this is systematic monitoring of workers. In India the DPDP Act
2023 does run on notice-and-consent, so the same grant carries both models; the difference is which
one the record has to prove.

Four further obligations, none of which exist yet — and each is now a compliance item with a
jurisdiction behind it (§7A.6 item 6), not a backlog note:

- **Transcripts are personal data.** Retention policy + purge job (suggest: raw audio at 90 days,
  transcript while `dynamic`, purge at bake + 1 year). Storage limitation is GDPR Art. 5(1)(e) and
  DPDP §8(7), not a housekeeping preference.
- **A compensation statement is personal data too** (§7A). It carries a named person's pay, and it
  is subject to the same access, rectification and retention rights — with the caveat that a
  finalized statement is corrected by superseding it, never by editing, so a rectification request
  produces a new period and an audit trail rather than a silent overwrite.
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

**A bake freezes an entitlement. It does not issue a security, and it must never claim to.** What
this domain computes, start to finish, is an **equity entitlement record**: a deterministic,
auditable calculation of what each member has earned under an agreement they accepted. Shares exist
only after corporate action nobody here can perform — a board resolution and a 409A valuation under
a Rule 701 plan in the US; a resolution plus PAS-3 under Companies Act 2013 §62(1)(b), or a
registered-valuer report under §54 and Rule 8 for sweat equity, in India; national company law plus
the Prospectus Regulation's employee-scheme conditions in the EU (§7A.6 item 4).

Two requirements follow, and they are contract, not styling:

- **The bake body carries a `boardApprovalReference`** — a required, non-empty string identifying
  the resolution or minute that authorised it, stored on `pie_bake_event` and inside the hash. A
  bake with no recorded corporate authority is a spreadsheet with a ceremony attached, and the
  column is what stops it being mistaken for more.
- **The output is a draft instrument set for the board and counsel**, labelled as such. No response
  field, no export filename and no client string may describe it as a grant, an issuance, an
  allotment or an option award, and every equity surface carries a standing "not legal or tax
  advice" notice. PROOF_OF_EFFORT_SPEC.md §2 used to promise founders they would not need a lawyer;
  that promise is withdrawn, because making it is unauthorized-practice-of-law exposure in most US
  states and untrue in all three jurisdictions.

### 9.12 The all-or-nothing tradeoff — settled as option (a)

§0 says the client never sends a server-owned value, explicitly including an hour count. That makes
it **impossible** for a consensus resolution to say _"we agreed it was 3 hours, not 4."_

The design routes around it: `resolve` accepts a narrowed ISO-8601 **window**, and the server
re-derives minutes from artifact overlap inside it — preserving the rule and keeping the number
formula-produced. **This is what shipped**, enforced in four places, not merely documented in one:
`dispute.service.ts`'s `resolveDispute` has no field that could carry a human-asserted number;
`effort_claim` and `slice_ledger_entry` (`schema.ts`) both carry a comment naming
`consensusAdjustedMinutes` only to record that no such column exists; and
`proof-of-effort.controller.ts`'s rejected-keys list names it explicitly, alongside every other
server-owned value a body must never carry.

The cost, accepted knowingly rather than discovered later: for **physical work with no digital
artifacts**, there is nothing to overlap a window against, so `re-verify` cannot produce a different
number and the only outcomes are all-or-nothing — on a claim the team may agree was _partially_
valid. The solar mock depicts exactly the disallowed case: `"Re-verified at 3 hrs — adjusted to 510
slices."` That mock string has no backend behavior behind it and will not get one; §15 should list it
as a UI string to drop or reword, not a contract to implement.

The rejected alternative, recorded so a future session does not re-litigate it from scratch: a narrow,
heavily-audited `consensusAdjustedMinutes` exception, accepted only on dispute resolution, only with
`resolution: "re-verified"`, only after a majority of `quorumMemberCount` has voted, written as a
`consensus-adjustment` ledger entry naming every voter. It draws the same shape as the negotiated fair
market rate §0 already tolerates at lock time — a human-supplied _input_, not a server-owned _output_
— but unlike the rate (agreed once, before any work is logged, then immutable) this would be
decided **after the fact**, specifically to overrule what the formula already computed, and repeatably
so across every future dispute. That is majority-fiat wearing a quorum instead of a founder, and it is
exactly what §9.1 — the single most important idea in this domain — exists to rule out. Rejected on
that basis, not merely deferred.

The residual gap for physical work with zero artifacts is real: the escape valve is voiding the claim
and re-submitting a smaller one, which re-runs forensics from scratch and costs another 24-hour
window. Worth a UX affordance (§14) for "re-submit at a reduced claim"; not worth reopening this
decision.

---

## 10. The data — Project Immortal

### It is a research program, not a research project

Firm recommendation: **model it as a distinct `research_program` entity**, not as a
`research_project` with a flag.

The two share almost nothing structurally. A `research_project` has one founder, a small closed
team, a funding round, milestones, monthly compensation statements, and a Slicing Pie ledger over
verified daily logs.
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
app.use("/research-projects", researchProjectsRouter); // ✅ shipped — §5
// Same prefix, declared AFTER: workshopRouter owns /:projectSlug/workshop/* and
// /:projectSlug/daily-logs/*. No collision — researchProjectsRouter's "/:projectSlug"
// matches that one segment exactly and never swallows a deeper path.
app.use("/research-projects", workshopRouter); // ✅ shipped — §8
app.use("/discovery", discoveryRouter); // ✅ shipped — §6
// Same prefix again, declared AFTER both: proofOfEffortRouter owns /:projectSlug's
// /effort-claims/*, /equity/*, /allocation-proposals/*, /disputes/*, /audit-trail/*,
// /physical-receipts, /integrations/*, /pie-bake, /slice-ledger and /proof-of-effort.
app.use("/research-projects", proofOfEffortRouter); // ✅ shipped — §9
app.use("/", researchCatalogRouter); // ✅ shipped — /open-roles, /research-categories (§5)
// Root-mounted because a provider's redirect URI is fixed at app-registration time and
// cannot carry a project slug; the project and member come out of the signed state (§9.10).
app.use("/", integrationCallbackRouter); // ✅ shipped — GET /integrations/:provider/callback

// Same prefix a fourth time, declared AFTER all three: projectFundingRouter owns
// /:projectSlug's /funding-rounds, /milestones, /compensation and /investor-confidence.
// Its /escrow/* subtree is RETIRED — those four paths 404 now (§11g).
app.use("/research-projects", projectFundingRouter); // ✅ shipped — §7
// Same prefix a FIFTH time, declared after all four: compensationRouter owns
// /:projectSlug's /compensation-agreements/*, /compensation-periods/*,
// /compensation-period-lines/* and /members/:memberUserId/compensation-agreement.
app.use("/research-projects", compensationRouter); // ✅ shipped — §7A
// Same prefix a SIXTH time, declared after all five: projectGoToMarketRouter owns
// /:projectSlug/launch-readiness (§11i). Still no collision, same reason.
app.use("/research-projects", projectGoToMarketRouter); // ✅ shipped — §11i
// Root-mounted for the same reason researchCatalogRouter is: a backer arriving from a
// deal-flow list holds a round id and has no reason to know which project owns it.
// Owns /funding-rounds, /pledges, /milestones and /funding/deals. Its /escrow-releases
// and /provider-transfers subtrees are RETIRED (§11g).
app.use("/", fundingRouter); // ✅ shipped — §7

// --- The four §4c STAGE ROUTES' cross-project halves (§11h, §11i, Appendix B). All
// root-mounted for one reason: a visitor arriving from a landing-page stage card has not
// picked a project and holds no slug. That is the whole point of the pages — team
// building, daily logs and governance lived only as tabs INSIDE a project, so someone who
// had not chosen one could not reach them at all.
//
// /daily-logs is MEMBER-SCOPED, derived from project_member in SQL;
// /daily-logs/streak-leaderboard is public.
app.use("/", dailyLogFeedRouter); // ✅ shipped — §8, §11h
// /governance/summary. Aggregates and mechanics, never people.
app.use("/", governanceRouter); // ✅ shipped — §7A, §11h
// /suppliers, /supplier-capabilities, /launch-ready-projects.
app.use("/", supplierRouter); // ✅ shipped — §11i

// NOT YET IN src/app.ts — no router to mount:
// app.use("/research-programs", researchProgramsRouter); // ⏳ pending — §10
```

**Path convention, applied uniformly:** project-scoped resources nest under
`/research-projects/:projectSlug/…`. The public identity in a URL is always the **slug** (§5);
internal ids appear in payloads and in child path segments. Literal segments (`/mine`, `/slugs`)
are declared **before** `/:projectSlug` so they are never swallowed as a param — the same rule as the
users router's `/me` and the products router's `/mine`.

Unless stated otherwise every route is `requireAuth`, every project-scoped route additionally runs
`requireProjectRole` (§4a), and every mutation touching money/equity/effort adds
`requireIdentifiedUser` (§4a).

### Implementation status, per subsection

Four states, checked against the actual route files in `src/routes/`, not against intent:

| State           | Meaning                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------- |
| ✅ **Shipped**  | Routed, controlled, serviced, migrated. Reachable on `pnpm dev` today.                   |
| ⏳ **Pending**  | Spec'd below, in scope for this project, **not built yet** — §16 orders when.            |
| 🚫 **Deferred** | Spec'd below but **will not be built** against a paid provider — see Appendix A instead. |
| 🗑️ **Retired**  | Unmounted. The routes 404; the tables and services survive uncalled. Do not re-bind.     |

| Subsection                                        | Domain                              | Status     | Backing files                                                                                                                                                                                                       |
| ------------------------------------------------- | ----------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [11a](#11a-projects-team-roles-5)                 | Projects, team, roles (§5)          | ✅ Shipped | `research-projects.routes.ts`, `research-catalog.routes.ts`                                                                                                                                                         |
| [11b](#11b-discovery-6)                           | Discovery (§6)                      | ✅ Shipped | `discovery.routes.ts`                                                                                                                                                                                               |
| [11d](#11d-workshop-and-daily-logs-8)             | Workshop & daily logs (§8)          | ✅ Shipped | `workshop.routes.ts`. The deferred rows a first draft had here now live only in Appendix A                                                                                                                          |
| [11e](#11e-proof-of-effort-9)                     | Proof of Effort (§9)                | ✅ Shipped | `proof-of-effort.routes.ts`, `proof-of-effort.controller.ts`, ten services, six jobs, migrations 0014–0015                                                                                                          |
| [11f](#11f-project-immortal-10)                   | Project Immortal (§10)              | ⏳ Pending | none — no `research-programs.routes.ts` exists                                                                                                                                                                      |
| [11g](#11g-funding-and-compensation-7-7a)         | Funding & compensation (§7, §7A)    | ✅ Shipped | `funding.routes.ts`, `compensation.routes.ts`, `compensation.controller.ts`, three services, two jobs, migrations 0017–0019                                                                                         |
| [11h](#11h-cross-project-reads-8-7a)              | Cross-project reads (§8, §7A)       | ✅ Shipped | `workshop.routes.ts`'s `dailyLogFeedRouter`, `compensation.routes.ts`'s `governanceRouter`, `governance-summary.service.ts`, `src/lib/daily-log-cursor.ts`, `scripts/smoke-daily-log-feed.ts`, migrations 0020–0021 |
| [11i](#11i-go-to-market-6-family)                 | Go-to-market (§6-family)            | ✅ Shipped | `suppliers.routes.ts`, `suppliers.controller.ts`, `suppliers.service.ts`, `launch-readiness.service.ts`, migration 0020                                                                                             |
| [11j](#11j-gaps--what-the-rd-surface-still-needs) | **Gaps** — everything above's holes | ⏳ Pending | none — this subsection IS the gap list. Read it before concluding an endpoint is missing by accident                                                                                                                |

Each subsection below opens with one line stating its state. **§11c is gone** — it described funding
and escrow together, and escrow has left this contract. Its funding rows and the §7A rows that
replace its escrow rows are both in [§11g](#11g-funding-and-compensation-7-7a), which is the only
subsection that mixes states, and says so per row.

**§11j is the inverse of every subsection above it** — it enumerates what is NOT built, so that
"R&D is complete apart from Project Immortal" has a checkable definition. It also records, in
§11j.6, every verb that is missing **on purpose**; check there before treating an absence as a bug.

### 11a. Projects, team, roles (§5)

**✅ Shipped in full.** Every row below is routed and reachable today.

| Method & path                                                                       | Body / input                                                                                 | Behavior & statuses                                                                                                                                                                              |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /research-projects`                                                           | `CreateProjectSchema` (the wizard's `NewIdeaDraft`)                                          | Creates a **draft** + founder `project_member` + `project_stats` in one txn. `201` · `422`                                                                                                       |
| `GET /research-projects`                                                            | `?category=&stage=&sort=&page=&limit=`                                                       | Public feed of `active` projects. `200`                                                                                                                                                          |
| `GET /research-projects/slugs`                                                      | —                                                                                            | Slug list for `generateStaticParams`. `200`                                                                                                                                                      |
| `GET /research-projects/mine`                                                       | `?status=&page=&limit=`                                                                      | Caller's own, including drafts. `200`                                                                                                                                                            |
| `GET /research-projects/:projectSlug`                                               | —                                                                                            | Detail. Draft → owner only, else `404`                                                                                                                                                           |
| `PATCH /research-projects/:projectSlug`                                             | `UpdateProjectSchema` (no `status`, no `stage`, no equity grant)                             | Partial update. `200` · `422` · `404`                                                                                                                                                            |
| `POST /research-projects/:projectSlug/cover`                                        | multipart, field `cover`                                                                     | sharp validate + normalize → Cloudinary. `200` · `413` · `422` · `502`                                                                                                                           |
| `DELETE /research-projects/:projectSlug/cover`                                      | —                                                                                            | Maintainer+ → else `404`. **Refused while the project is published** — `409 COVER_REQUIRED_WHILE_PUBLISHED`. No cover set is `200 { deleted: false }`, never a `404`                             |
| `POST /research-projects/:projectSlug/publish`                                      | —                                                                                            | Server-side completeness gate; materializes seed roles; freezes the slug. `200` · `422 INCOMPLETE_FOR_PUBLISH`                                                                                   |
| `POST /research-projects/:projectSlug/unpublish` · `/archive`                       | —                                                                                            | `active` ↔ `draft`; archive is terminal. `200`                                                                                                                                                   |
| `PATCH /research-projects/:projectSlug/stage`                                       | `{ stage }`                                                                                  | Dedicated route — writes a `project_stage_transition` audit row. `200`                                                                                                                           |
| `GET /research-projects/:projectSlug/stage-history`                                 | —                                                                                            | The read half of the row above — the append-only `project_stage_transition` log. Member only → else `404`. Not paginated; a transition list is not a feed. `200`                                 |
| `GET /research-projects/:projectSlug/team`                                          | —                                                                                            | Roster; `name`/`avatar` joined from `user`. `200`                                                                                                                                                |
| `PATCH` · `DELETE /research-projects/:projectSlug/members/:memberId`                | `{ projectRole?, roleTitle? }`                                                               | Founder only. `founder` can never be assigned. `200` · `403`                                                                                                                                     |
| `DELETE /research-projects/:projectSlug/members/me`                                 | —                                                                                            | Sets `left`, never deletes. `200`                                                                                                                                                                |
| `GET` · `POST` · `PATCH` · `DELETE /research-projects/:projectSlug/roles[/:roleId]` | `OpenRoleSchema` + compensation strands                                                      | Maintainer+. `200`/`201` · `422`                                                                                                                                                                 |
| `POST /research-projects/:projectSlug/roles/:roleId/close` · `/reopen`              | —                                                                                            | Maintainer+. **Editorial, and independent of capacity** — `slotsFilledCount` is untouched. What `409 ROLE_HAS_REFERENCES` points a caller to instead of `DELETE`. `200`                          |
| `GET /open-roles`                                                                   | `?commitment=&skill=&minEquityBasisPoints=&page=`                                            | Cross-project rail + `/talent` + `/team-building`. Carries `projectSlug`, `projectName`, `projectStage`, `projectCoverImageUrl`, `currency` and the strands, so a role card needs no second call |
| `GET /research-projects/:projectSlug/applications`                                  | `?status=&page=&limit=`                                                                      | Maintainer+ → else `404`. The founder-facing inbox behind the row below. Paginated. `200`                                                                                                        |
| `POST /research-projects/:projectSlug/applications`                                 | `{ openRoleId?, shortPitch, selectedSkills[], statedCommitment, expectedCompensationNote? }` | `kind` **server-derived**. Skills validated as a subset. `201` · `409` · `422`                                                                                                                   |
| `POST …/applications/:id/accept` · `/decline` · `/withdraw`                         | `{ note? }`                                                                                  | Accept creates the member row + increments `slotsFilledCount` in one txn. `200`                                                                                                                  |
| `GET /research-projects/:projectSlug/invites`                                       | `?status=&page=&limit=`                                                                      | Maintainer+ → else `404`. Same page shape as applications. `200`                                                                                                                                 |
| `POST /research-projects/:projectSlug/invites` (+ `/accept`, `/decline`, `DELETE`)  | `{ inviteeUserId, openRoleId?, message? }`                                                   | Talent-page "Invite". `201` · `409`                                                                                                                                                              |
| `POST` · `DELETE /research-projects/:projectSlug/watch`                             | —                                                                                            | Idempotent; counter in the same txn. `200`                                                                                                                                                       |
| `GET` · `POST /research-categories`                                                 | `?status=approved` · `{ label }`                                                             | Approved facets only. **`POST` is a route-level alias of `/discovery/categories`** — same controller, service, table and limiter _instance_, so it is no rate-limit bypass. `200`/`201` · `429`  |

### 11b. Discovery (§6)

**✅ Shipped in full**, including the `/admin/*` moderation rows. Every row below is routed and
reachable today.

| Method & path                                                     | Body / input                                                                      | Behavior & statuses                                                                                                                                                                                                                                |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /discovery/problem-clusters`                                 | `?category=&region=&minOpportunityScore=&sort=&page=`                             | The map + landing teaser. Returns lat/lng microdegrees. `200`                                                                                                                                                                                      |
| `GET /discovery/problem-clusters/:id`                             | —                                                                                 | Cluster detail + linked projects. `200`                                                                                                                                                                                                            |
| `POST /discovery/problem-reports`                                 | `{ title, categoryId, description, latitudeMicrodegrees, longitudeMicrodegrees }` | `requireIdentifiedUser` + limiter. **`countryCode`, `reportCount`, `opportunityScore`, cluster assignment are all server-derived.** `202` (clustering is async) · `422` · `429`                                                                    |
| `GET /discovery/problem-reports/mine`                             | `?page=`                                                                          | `200`                                                                                                                                                                                                                                              |
| `GET` · `POST /discovery/categories`                              | `{ label }`                                                                       | User-minted lands `pending`. `201` · `409` · `429`                                                                                                                                                                                                 |
| `GET /discovery/regions` · `/market-insights` · `/demand-signals` | `?region=&category=&page=`                                                        | Knowledge hub. `200`                                                                                                                                                                                                                               |
| `GET /discovery/skills`                                           | —                                                                                 | **The canonical skill vocabulary** behind every skill chip on `/talent` and `/team-building`. Slug **equality**, which is what retires the `skills.some(s => s.includes(…))` substring bug (§6). Not paginated — a facet list is not a feed. `200` |
| `GET /discovery/talent`                                           | `?commitment=&skill=&availability=&region=&page=`                                 | Server-side filtering (§6). `200`                                                                                                                                                                                                                  |
| `GET` · `PUT` · `DELETE /discovery/talent/me`                     | `TalentProfileSchema`                                                             | Opt-in directory record. `200`                                                                                                                                                                                                                     |
| `POST /discovery/talent/me/publish` · `/unpublish`                | —                                                                                 | Visibility toggle. `200`                                                                                                                                                                                                                           |
| `POST /discovery/admin/categories/:id/decide`                     | `{ decision, note? }`                                                             | Platform `moderator` only (§4a). `200` · `403`                                                                                                                                                                                                     |
| `GET /discovery/admin/merge-proposals`                            | `?page=&limit=`                                                                   | The moderator queue behind the row below. The capability is checked **in-service, before any id is read**, so the `403` names no id (§4a Layer 3). `200` · `403`                                                                                   |
| `POST /discovery/admin/merge-proposals/:id/decide`                | `{ decision }`                                                                    | Cluster dedup queue. `200` · `403`                                                                                                                                                                                                                 |

### 11d. Workshop and daily logs (§8)

**✅ Shipped in full.** Every row below is routed and reachable today, backed by
`workshop.routes.ts`, `workshop.controller.ts` / `daily-logs.controller.ts`, four services
(`workshop-board`, `workshop-files`, `workshop-chat`, `daily-logs`), the `analyze-daily-log` job and
migration 0013. This table already reflects the zero-cost amendment — the three rows the original
draft had here (`/playback-token`, `/webhooks/livepeer`, `/workshop/chat/stream`) are gone from this
table entirely and live only in [Appendix A](#appendix-a--deferred-paid-infrastructure); there is
nothing 🚫 deferred left inside this subsection to flag.

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

**✅ Shipped in full.** Every row below is routed and reachable today, backed by
`proof-of-effort.routes.ts`, `proof-of-effort.controller.ts` /
`proof-of-effort-error-response.ts`, ten services (`fair-market-rate`, `effort-claims`,
`verification`, `slice-allocation`, `slice-ledger`, `dispute`, `equity-snapshot`,
`project-audit`, `physical-receipts`, `integration-consent`, `pie-bake`,
`optimization-suggestions`), four libraries (`slice-math`, `verdict`, `receipt-forensics`,
`token-encryption`, `github-integration`), six jobs (the four pipeline stages plus
`sweep-dispute-windows` and `recompute-equity-snapshot`) and migrations 0014–0015.
`daily_log.effortVerificationStatus` — which §8 shipped defaulted to `not_run` and written by
nothing — is now written here, and by nothing else.

**Six rows differ from the table as originally drafted.** Each is a deliberate decision, not
drift:

| Change                                                                   | Why                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Added** `POST …/members/:memberUserId/fair-market-rate/:rateId/accept` | The lifecycle cannot complete without it: a rate must be `accepted` before it can be `locked`, and §13 describes §0's exception as "a member-**accepted** fair market rate". Without this step the founder both sets and ratifies the number — founder fiat. |
| **Added** `POST …/disputes/:disputeId/withdraw`                          | §9.8's state machine has a `disputed → open` transition and §11e had no endpoint for it. The original window resumes on its **original** clock.                                                                                                              |
| **Added** `GET …/physical-receipts`, `GET …/pie-bake`                    | A member cannot cite a receipt id they were never shown, and a frozen cap table with no read is a write-only record.                                                                                                                                         |
| **Removed** `currencyCode` from the rate body                            | §4b: "there is no `currency` field in any request body — it is derived from the round/project". `research_project.currency` already holds it, and a client-chosen currency would let a $120/h rate be re-read as ¥120/h.                                     |
| **Money crosses the wire as a decimal STRING**, not a number             | `fairMarketRateCentsPerHour`, `valuationCents`, `sliceNumerator`, `totalSlices`. `bigint` past 2^53 loses precision the moment `JSON.stringify` touches it (§4b), and `z.number()` would additionally accept `120.5` for a whole-cent field.                 |
| **`re_verified` resolutions return `202`**, not `200`                    | The number does not exist yet: a scoped re-verification has to run. §9.12 option (a) is settled, so there is no `consensusAdjustedMinutes` field anywhere.                                                                                                   |

**What ships DEGRADED, honestly, and why the numbers are still right.** Without a connected
provider an evidence link is a reference with no independently verifiable timestamp, so
`artifact_grounding` resolves **`flagged`** rather than `passed` — real evidence, withheld
pending a human — and the claim reaches `flagged_for_review` at zero slices. A maintainer
overrides the step, which edits an **AI judgement**, and the formula recomputes the number.
Substance and temporal analysis `skip` in that case rather than flagging, so review has ONE gate
rather than three. A claim with **no** evidence at all FAILS grounding and earns zero (SPEC §4
step 2). A physical claim derives its minutes from receipt EXIF capture spans, because §0 forbids
a body carrying an hour count and a photograph has no transcript.

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
| `POST …/disputes/:id/resolve`                                                | `{ resolution, resolutionNote, scopedWindowStart?, scopedWindowEnd? }`                                 | See §9.8 + §9.12 (settled as option (a)). `200`/`202` · `409 EVIDENCE_PURGED`                                                                         |
| `GET` · `POST` · `DELETE …/integrations[/:provider]` (+ `/authorize-url`)    | `{ requestedResourceIds[] }`                                                                           | OAuth `state` **signed, single-use, 10-minute**. Revoke is self-only. `200` · `503 INTEGRATION_UNCONFIGURED`                                          |
| `GET /integrations/:provider/callback`                                       | provider redirect                                                                                      | Identity from the signed `state`, not a session. `302`                                                                                                |
| `GET …/audit-trail` · `/verify` · `/:entryId/hash-input`                     | `?fromSequence=&toSequence=`                                                                           | `409 CHAIN_BROKEN` on a break — it must page. `200`                                                                                                   |
| `GET` · `POST …/optimization-suggestions` · `…/:id/accept` · `…/:id/dismiss` | `{ note? }`                                                                                            | `200`                                                                                                                                                 |
| `POST …/pie-bake`                                                            | `{ trigger, triggerEvidenceNote, valuationCents?, acknowledgement, expectedSnapshotId }`               | Irreversible, once ever. `201` · `409 UNSETTLED_ALLOCATIONS` · `409 SNAPSHOT_STALE`                                                                   |

### 11f. Project Immortal (§10)

**⏳ Pending — none of this is built.** No `research-programs.routes.ts`, no controller, no
service, no migration for any table in §10. Lowest coupling of the pending phases (§16 Phase 6) —
it shares only the `user` table and the `compensation_kind` enum with everything else — but it
needs the platform `moderator` role from §4a Layer 3, which also does not exist yet.

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

### 11g. Funding and compensation (§7, §7A)

**✅ Shipped in full, and the split is still the point.** Funding rounds, pledges and milestones
ship as records of intent. Compensation statements ship as §7A. The escrow subtree is **🗑️
retired** — its nine routes 404, its three jobs are unbound, and its tables and services survive
unreachable so migration 0016's rows stay explicable.

This subsection replaces the old §11c, which described funding and escrow as one thing. They were
never one thing: one is a record of who committed to back a project, the other was a money rail.

#### Shipped and staying — funding as a record of intent (§7)

Backed by `funding.routes.ts`, `funding.controller.ts` / `funding-error-response.ts`,
`funding-rounds.service.ts`, `milestones.service.ts`, `investor-confidence.service.ts`,
`compensation.service.ts` and migration 0016.

| Method & path                                                    | Body / input                            | Behavior & statuses                                                                                                                                                       |
| ---------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /research-projects/:projectSlug/funding-rounds`            | `{ type, title, goalAmountInCents, … }` | Founder only. Gated by `ENABLED_FUNDING_ROUND_TYPES`. `201` · `403 ROUND_TYPE_DISABLED`                                                                                   |
| `GET /research-projects/:projectSlug/funding-rounds`             | —                                       | Member only → else `404`. `200`                                                                                                                                           |
| `POST /funding-rounds/:roundId/open` · `/close`                  | —                                       | Founder + `admin`. Re-checks the type gate at open. `200` · `422 ROUND_INCOMPLETE_FOR_OPEN`                                                                               |
| `GET /funding-rounds/:roundId` · `/backers` · `/pledge-options`  | —                                       | `percentageFundedBasisPoints` computed on read, may exceed `10000`. A draft round is `404` to non-members. `200`                                                          |
| **`POST /funding-rounds/:roundId/pledges`**                      | **`{ amountInCents }` — nothing else**  | Records a **commitment**. Server re-bounds it and resolves currency. `422 SELF_PLEDGE_FORBIDDEN`. **No charge, no hold** — the response must not imply one. `201` · `429` |
| `GET /pledges/mine` · `POST /pledges/:id/cancel`                 | —                                       | No `userId` param exists; the filter is `req.user.id`. `200`                                                                                                              |
| `GET /funding/deals`                                             | `?roundType=&stage=&page=`              | Investor deal flow, filtered by the enabled types **in SQL**. `200`                                                                                                       |
| `GET` · `POST …/milestones` · `PATCH /milestones/:id`            | `MilestoneSchema`                       | `orderIndex` server-derived; no `status` field on the PATCH. `escrowReleaseAmountInCents` → **`plannedPayoutInCents`** (§7). `201`/`200`                                  |
| `POST /milestones/:id/complete` · `PUT /milestones/:id/variance` | `{ …six variance integers }`            | Signed `varianceBasisPoints` computed server-side and clamped to the column bound. `200`                                                                                  |
| `GET …/compensation`                                             | —                                       | Locked §9 rate, advertised offers, and — once §7A lands — payments read from `compensation_payment_record` instead of approved escrow releases. `200`                     |
| `GET …/investor-confidence`                                      | —                                       | Returns `asOf`. **`404` when never computed** — never a fabricated `0`. `200` · `404`                                                                                     |

#### Retired — the escrow subtree (§7)

**These nine paths return `404`.** The handlers are deleted, the routes are unmounted, and the
three jobs behind them (`submit-provider-transfer`, `reconcile-escrow-ledger` and its tick) are
unbound with no cron. The design behind them is preserved in
[ESCROW_LEDGER_STRUCTURE.md](ESCROW_LEDGER_STRUCTURE.md) for the commerce domain.

```text
GET  …/escrow/summary · …/escrow/ledger · …/escrow/verify · …/escrow/ledger/:entryId/hash-input
POST /milestones/:id/escrow-releases
POST /escrow-releases/:id/approve · /reject
GET  /provider-transfers/pending
POST /provider-transfers/:transferId/settle · /fail
```

`POST /webhooks/payments/stripe` was never built and now never will be. There is still no webhook
router and no raw-body mount anywhere in `src/app.ts`, and there must not be one.

**The tables and services are still on disk and in the database**, uncalled: `escrow_account`,
`escrow_journal_entry`, `escrow_posting`, `escrow_release`, `provider_transfer`,
`provider_webhook_event`, `reconciliation_discrepancy`, migration 0016 and seven services. Dropping
them would discard rows the append-only triggers exist to protect, and the queue names survive so
an operator can drain anything left in flight. **Do not re-bind them.** Putting Qatoto back in the
position of holding someone else's money is a licensing decision taken with counsel (§7A.6), not a
code change.

#### Shipped — compensation statements (§7A)

**Every row below is routed and reachable today**, backed by `compensation.routes.ts`,
`compensation.controller.ts` / `compensation-error-response.ts`, three services
(`compensation-agreements`, `compensation-periods`, `compensation-payments`), two jobs
(`close-compensation-period` and `recompute-compensation-draft`, each with a daily tick),
`src/lib/compensation-period.ts` and migrations 0017–0019.

`requireIdentifiedUser` on every write (§4a); every project-scoped route re-checks membership in
the service and fails `404` (§4a).

**Two rows differ from the table as originally drafted**, both deliberate:

| Change                                                                                         | Why                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`GET …/compensation-agreements` takes `?memberId=` as a USER id**, not a `project_member.id` | Every other route in this domain addresses a person by their public user id (`…/members/:memberUserId/…`). A filter keyed on the internal membership id would be the only place a client had to know one. |
| **`…/export` requires `admin`**, not `contributor`                                             | A CSV of every member's gross pay is the whole team's compensation in one file. Reading your own statement needs `contributor`; exporting everyone's does not follow from it.                             |

| Method & path                                                          | Body / input                                                                                         | Behavior & statuses                                                                                                                                                  |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET …/compensation-agreements`                                        | `?memberId=`                                                                                         | Full effective-dated history, newest first. Read-only. `200`                                                                                                         |
| `POST …/members/:memberUserId/compensation-agreement`                  | `{ engagementKind, monthlyAmountInCents? \| hourlyRateCentsPerHour?, effectiveFrom, rationaleNote }` | Founder proposes. **No `currencyCode`** — derived from the project (§4b). Exactly one basis, or `422`. `201`                                                         |
| `POST …/compensation-agreements/:agreementId/accept`                   | —                                                                                                    | **The member only**, and never the proposer. Trigger-freezes the numbers. An hourly rate that disagrees with §9's `paidCashRateCentsPerHour` is `422`. `200` · `403` |
| `GET …/compensation-periods`                                           | `?status=&page=`                                                                                     | Keyset-paginated. `200`                                                                                                                                              |
| `GET …/compensation-periods/:periodId`                                 | —                                                                                                    | Lines, payments, `statementHash`, and `asOf` for an open period so no client implies a frozen number. `200`                                                          |
| **`POST …/compensation-periods/:periodId/finalize`**                   | `{ acknowledgement: "FINALIZE" }` — **no amounts**                                                   | Founder. Recomputes, freezes, hashes, appends one audit entry in the same txn. `200` · `409 PERIOD_NOT_READY` · `409 RATE_NOT_LOCKED`                                |
| `POST …/compensation-periods/:periodId/countersign`                    | `{ note? }`                                                                                          | A **different** admin or platform auditor. `422 SELF_COUNTERSIGN_FORBIDDEN` even for a founder; `403` if the admin role has no recorded grantor (§4a). `200`         |
| `POST …/compensation-periods/:periodId/supersede`                      | `{ reasonNote }`                                                                                     | Corrections create a new period; nothing is ever edited (§4f). `201`                                                                                                 |
| `POST …/compensation-period-lines/:lineId/payments`                    | `{ paidAmountInCents, paidOnDate, methodKey, referenceNote?, idempotencyKey }`                       | Founder/admin **attests** a payment made elsewhere. Append-only; changes no line. Rejects anything resembling a payment instrument. `201` · `429`                    |
| `POST …/compensation-period-lines/:lineId/payments/:paymentId/confirm` | —                                                                                                    | **The member only.** Until this lands the UI shows the payment as unconfirmed, never as paid. `200` · `403`                                                          |
| `GET …/compensation-periods/:periodId/export`                          | `?format=csv\|json`                                                                                  | Gross amounts for the founder's payroll provider. Carries the "no withholding computed, not payroll or tax advice" notice in-band (§7A.6). `200`                     |
| `GET …/compensation-periods/:periodId/verify`                          | —                                                                                                    | Re-walks the statement chain. A break is **`409 STATEMENT_CHAIN_BROKEN`**, never `200 {valid:false}` — the same rule §9's audit verifier follows. `200` · `409`      |

**Two endpoints that deliberately do not exist.** There is no `PATCH` on a period or a line — a
finalized statement is corrected by superseding it. And there is no endpoint that marks a line
`paid` directly: payment is an attestation plus a confirmation, or it is not evidence (§7A.5).

**The backend has caught up to this doc**, in the order it prescribed: §7A landed first, then
`escrowReleaseAmountInCents` → `plannedPayoutInCents` (migration 0019), then
`compensation.service.ts`'s `paidOut` repointed at `compensation_payment_record`, then
`PLATFORM_FEE_BASIS_POINTS` to `0`, then the two retired `earnedAsPolicy` values refused by both
Zod and a CHECK — and only then the escrow subtree. Retiring it first would have left shipped cash
strands pointing at a policy with no mechanism behind it.

### 11h. Cross-project reads (§8, §7A)

**✅ Shipped in full.** Three root-mounted reads, backed by `workshop.routes.ts`'s
`dailyLogFeedRouter`, `compensation.routes.ts`'s `governanceRouter`,
`governance-summary.service.ts`, `src/lib/daily-log-cursor.ts` and migrations 0020–0021, and
exercised end to end by `scripts/smoke-daily-log-feed.ts`.

These exist because §4c's `/build-log` and `/governance` stage pages are **cross-project by
definition** and every §8 and §7A read before them was project-scoped. Root-mounted for the same
reason `/open-roles` is: someone arriving from a stage card has not picked a project and holds no
slug.

| Method & path                        | Body / input                             | Behavior & statuses                                                                                                                                                                                           |
| ------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /daily-logs`                    | `?projectSlug=&chipKind=&cursor=&limit=` | **Member-scoped.** `WHERE projectId IN (caller's active memberships)`, derived from `project_member` in SQL. Keyset `(logDate, submittedAt, id)`; submitted logs only. `200` · `401` · `422 CURSOR_MALFORMED` |
| `GET /daily-logs/streak-leaderboard` | —                                        | **Public.** Top 20 active projects by `dailyLogStreakDays`, each with `statsComputedAt` and `lastDailyLogDate`. `200`                                                                                         |
| `GET /governance/summary`            | `?page=&limit=`                          | **Public aggregates**, plus the caller's own open lines when signed in. Never another member's figures. `200`                                                                                                 |

**The visibility decision on `/daily-logs`, and it is the whole design.** A daily log is private to
its project's members, and every project-scoped read enforces that with
`requireProjectRole(…, "contributor")` failing `404`. Making the surface cross-project could not be
allowed to quietly relax it, so the feed is **Appendix B2 option (a)**: the caller's own
memberships, and nothing else. A logged-out visitor gets `401`, and the page renders its explainer,
its legend and the public leaderboard with an **empty** feed — not a fabricated one.

**There is no `?projectIds=` and there must never be one.** A client-supplied project list on a
private feed is a client-supplied authorization input (§0). `projectSlug` narrows the caller's own
set and can only ever shrink it; a slug they are not a member of yields an **empty page, not a
404**, because a facet that 404s tells a stranger which slugs exist (§6).

**The cursor is three columns wide** — `(logDate DESC, submittedAt DESC, id DESC)` — and each is
load-bearing. `logDate` is the day CLAIMED and `submittedAt` is when it was filed; they differ on
any backfilled log, so neither substitutes for the other. `id` ends it because two members can
submit for the same day inside one millisecond, and a cursor on a non-unique key skips rows (§4c
rule 4). Backed by `daily_log_feed_idx` on `(projectId, logDate, submittedAt, id)`, partial on
`status = 'submitted'` — which is also what guarantees `submittedAt` is NOT NULL on every row the
cursor addresses.

**`chipKind` filters in SQL**, as a correlated `EXISTS` against `daily_log_ai_summary_chip` with
`daily_log_ai_summary_chip_kind_logId_idx` behind it. **No denormalized `chipKinds` column was
added** — that would have meant a migration, a change to `analyze-daily-log` and a backfill of every
log already analyzed, to serve a filter an index serves today. Filtering after the fetch was never
an option: a predicate applied to one fetched page silently short-pages the cursor.

**The streak leaderboard is public and the feed is not**, and the asymmetry is the point: a streak
count over an already-public project is project metadata, while a log is a member's work record. No
person is named and no log content appears. `statsComputedAt` ships on every row because a streak
decays at midnight in the project's own zone **with no write** — the nightly job notices hours
later, so a leaderboard implying live numbers is lying.

**`effortVerificationStatus` is the six-value enum** on every feed row (§8), with `isEffortVerified`
derived beside it. This page's legend is the most visible place the frontend's boolean (§15)
contradicts the wire.

#### The privacy decision on `/governance/summary`

A month-end statement line names a person and what they are owed. Pay data is personal data under
the GDPR and specially sensitive in several member states; §7A already keeps account numbers out of
the system entirely. So the cross-project surface renders **aggregates and mechanics, never people**:

- **Per-member statement lines stay on the per-project tab** (§5.5), behind membership, with the
  finalize / countersign / record-payment / confirm / export actions. Nothing moved.
- **The rollup carries counts, not names.** Per-project period counts by status, countersigned
  count, and aggregate committed funding. No member id, no user id, no name, no per-member amount.
- **The caller's own lines are the one exception.** A member may always see their own, on any
  surface — reached only through their own `project_member` rows.
- **The worked example the frontend spec wants is authored sample data.** The backend is not asked
  to supply a real member's row for it and does not.

**`attachOptionalUser`, not `requireAuth`,** because this page publishes the three §7A.6 copy rules
and must render signed out. Those rules ship **with the payload** as
`disclosureKeys: ["platform_holds_no_funds", "verification_never_reduces_cash",
"statement_is_gross_only"]` — **keys, not English sentences**, for the reason §4d gives about
`earnedAsLabel`: prose from the server forces three native clients to render un-localizable
strings. `GROSS_ONLY_NOTICE` travels beside them, as it already does on the export.

**No field on this page may imply a rail, a hold, a charge or a fee.** `committedFundingInCents` is
the sum of `funding_round.raisedAmountInCents`, which is a counter moved inside the pledge
transaction and means **committed** — no card, no custody. **`investor-confidence` is `null` when
never computed** (§11g), never coerced to `0`, which would publish "no confidence" as a finding
about the project rather than about the job.

**Read-only, and the absences are deliberate.** There is no `/finalize`, `/countersign`,
`/payments`, `/confirm` or `/export` on this router. Every one is actor-scoped and stays where the
actor's role is already resolved from the slug; re-exposing them here would mean re-deriving the
actor from a body.

### 11i. Go-to-market (§6-family)

**✅ Shipped in full**, backed by `suppliers.routes.ts` (two routers), `suppliers.controller.ts`,
`suppliers.service.ts`, `launch-readiness.service.ts`, `scripts/seed-supplier-capabilities.ts`,
`scripts/verify-go-to-market-constraints.ts` and migration 0020.

| Method & path                                          | Body / input                                                                                                                  | Behavior & statuses                                                                                                                             |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /suppliers`                                       | `?capability=&region=&verificationState=&page=&limit=`                                                                        | Public. Repeated `capability` means **AND** — `GROUP BY … HAVING count(distinct …) = n`, matched by slug equality. `200`                        |
| `GET /suppliers/:supplierSlug`                         | —                                                                                                                             | Public detail + capabilities. An inactive listing is `404`, identical to one that never existed. `200` · `404`                                  |
| `GET /supplier-capabilities`                           | —                                                                                                                             | The seeded vocabulary behind the filter chips. Not paginated. `200`                                                                             |
| `POST /suppliers`                                      | `{ slug, name, summary?, regionSlug?, contactPolicy?, websiteUrl?, leadTimeDays?, minimumOrderQuantity?, capabilitySlugs[] }` | Platform `moderator` only. **No `verificationState`** — a new row is always `unverified`. `201` · `403` · `409 SUPPLIER_SLUG_TAKEN` · `422`     |
| `PATCH /suppliers/:supplierId`                         | Same minus `slug`, plus `verificationState` and `isActive`                                                                    | Platform `moderator` only. **The slug is unwritable** — it is the public identity a client has already linked to. `200` · `403` · `404` · `422` |
| `GET /launch-ready-projects`                           | `?page=&limit=`                                                                                                               | Active projects at `stage = go_to_market` + what each **actually listed**, via `product.researchProjectId`. `200`                               |
| `GET /research-projects/:projectSlug/launch-readiness` | —                                                                                                                             | Member only → else `404`. Six derived items, `met` / `not_met` / `waived`, plus `asOf`. `200`                                                   |

**A public directory is a spam surface**, so the write side was decided before the routes existed:
platform `moderator` only, with `requirePlatformCapability(…, "moderate_taxonomy")` running
**before any id or slug is read**, which is what keeps its `403` from becoming an id oracle (§4a
Layer 3). There is **no user-submission path and no `pending` state** — Appendix B floated
mirroring `discovery/categories`, and that shape needs a moderation queue, a rate limiter and an
abuse story that are not worth building before the first real supplier exists. `isActive` is
retirement, not moderation. The capability vocabulary is **seeded**, exactly as `discovery_skill`
is, so there is no `POST /supplier-capabilities` either.

**Launch readiness is derived, not stored — there is no readiness table and no body that sets a
state.** Six items, computed from `research_project.stage`, `project_stats`
(`verifiedEffortMinutesTotal`, `allocatedEquityBasisPoints`), the §9.11 `pie_bake_event`, the
project's supplier engagements, and whether an active listing exists:

`stage_is_go_to_market` · `verified_effort_recorded` · `equity_allocated` · `cap_table_baked` ·
`supplier_engaged` · `store_listing_exists`

Each carries an `observedCount` — **an integer, never prose**, so three clients localize their own
copy. **`NULL` reads as `not_met`, never as `0`**: `project_stats`'s job-computed columns are
nullable with no default precisely so "no job has run" stays distinguishable from "the job ran and
found nothing" (§5), and a checklist that coerced them would report a pipeline gap as a finding
about the project.

> **A correction to Appendix B, recorded rather than papered over.** B4 says the checklist "reuses
> the `met` / `not_met` / `waived` shape §9.11's pre-bake checklist already established". **§9.11
> established no such thing** — it specifies a typed acknowledgement, an `expectedSnapshotId` and a
> `409 UNSETTLED_ALLOCATIONS` refusal, which `pie-bake.service.ts` implements as three sequential
> gates returning an error union. `met`/`not_met`/`waived` appeared nowhere in the codebase. The
> tri-state is therefore **authored in `launch-readiness.service.ts`**, and the instruction that
> mattered is honoured: three states, not four. **`waived` is currently unreachable** — there is no
> waiver table and no endpoint that grants one. It stays in the union because a waiver, when it
> lands, is a recorded decision by a named person rather than a fourth flavour of `met`.

**Listing creation is not an R&D endpoint.** The CTA from `/launch-ready-projects` points at
`/studio/products` and the studio's existing create flow does the work. R&D contributes
`product.researchProjectId` and nothing else.

### 11j. Gaps — what the R&D surface still needs

**⏳ Pending — nothing in this subsection is built.** Every other §11 subsection describes what
ships; this one describes what does not, so that "complete for R&D, except Project Immortal" has a
definition rather than a feeling.

Compiled by reading `src/routes/`, `src/services/` and `src/db/schema.ts` — **not** by reading the
tables above. Ground truth at the time of writing: **213 HTTP verb routes**, 111 of them under
`/research-projects` and 19 under `/discovery`.

**Project Immortal (§10 / [§11f](#11f-project-immortal-10)) is deliberately out of scope here.** It
is a whole unbuilt domain rather than a gap in a built one, it needs the platform `moderator` role
first, and §16 already orders it last. Nothing below refers to `/research-programs/*`.

Read §11j.6 before adding anything. A missing verb in this domain is as often a decision as an
omission, and several of them are load-bearing.

#### 11j.1 Write-path dead ends — read the three of these first

These are a different kind of defect from a missing endpoint, and they are the reason this
subsection leads with a table that specifies nothing. In each case the table ships, a reader ships,
and **no code path anywhere in the repo can put a row in it**. The surface is not "empty until
someone uses it" — it is empty permanently, and it looks built from the outside.

| Table                          | Who reads it                                                                                                            | Who can write it                                                                                                        | What is therefore always true                                                                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `market_insight`               | `GET /discovery/market-insights` (§11b) — the knowledge hub **and** the landing rail                                    | **Nobody.** No route, no job, no seed. `db:seed-discovery-lookups` writes only `discovery_region` and `discovery_skill` | `/knowledge-hub` and the landing insights rail render empty, on every environment, forever                                                      |
| `problem_cluster_project_link` | `problem-clusters.service.ts` (a cluster's linked projects), `recompute-opportunity-scores`, `recompute-demand-signals` | Only `discovery-moderation.service.ts`, which **re-points links that already exist** when a merge proposal is decided   | A cluster's linked-project list is empty and `relatedProjectCount` is `0`, so that input to the opportunity score is dead weight in the formula |
| `project_supplier_engagement`  | `launch-readiness.service.ts`, `suppliers.service.ts`'s `countProjectSupplierEngagements`                               | **Nobody.** No route, no create or update service                                                                       | The `supplier_engaged` launch-readiness gate (§11i) reports `not_met` for every project that will ever exist                                    |

Their write halves are specified in §11j.4 and §11j.5. This table is the index, not a second spec.

**Two of the three have a visible frontend consequence today**, and both were mis-attributed to the
frontend before this subsection existed. `/knowledge-hub` renders an empty state that reads as "no
insights yet" rather than "no insight can be created". And the project Overview tab's Civic Pulse
origin link and demand-evidence chips are dark because `ResearchProjectDetailView` exposes no link —
which is downstream of there being no way to create one (R_AND_D_STRUCTURE.md §18).

#### 11j.2 Missing reads — the data exists and nothing can fetch it

| Method & path                                                                | Body / input                   | Behavior & statuses                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET …/:projectSlug/disputes` · `GET …/disputes/:disputeId`                  | `?status=&page=`               | **The compliance one.** Raise, vote, withdraw and resolve all ship; there is **no read at all**, and no `listDisputes` / `getDispute` service function to build one on. §14 and §7A.6 item 5 call the dispute UI the GDPR Art. 22 contestability path and the EU AI Act Art. 14 human-oversight control — neither can be built against write-only endpoints. Today a dispute is reachable only as an `activeDisputeId` on an allocation proposal, which yields an id and nothing else. Member only → else `404`. `200` |
| `GET …/:projectSlug/effort-claims`                                           | `?status=&memberUserId=&page=` | List. Only `GET …/effort-claims/:claimId` ships, so a member cannot enumerate their own claims and the Proof-of-Effort verification tab has no index to render. `200`                                                                                                                                                                                                                                                                                                                                                  |
| `GET /discovery/talent/:talentUserIdOrHandle`                                | —                              | Directory detail. `listTalentProfiles` and `findMyTalentProfile` ship; **there is no read for anyone else's profile**, so a talent card on `/talent` has nowhere to link. Unpublished → `404`. `200`                                                                                                                                                                                                                                                                                                                   |
| `GET /applications/mine`                                                     | `?status=&page=`               | Root-mounted, `requireAuth`. An applicant cannot see what they applied to — `…/:projectSlug/applications` is the founder's inbox and is maintainer-gated. `200`                                                                                                                                                                                                                                                                                                                                                        |
| `GET /invites/mine`                                                          | `?status=&page=`               | Root-mounted, `requireAuth`. **An invitee cannot find an invite addressed to them**, and `/accept` and `/decline` both need an `inviteId` they have no way to obtain. The talent-page invite flow terminates nowhere without this. `200`                                                                                                                                                                                                                                                                               |
| `GET …/:projectSlug/applications/:applicationId` · `GET …/invites/:inviteId` | —                              | Detail reads behind the two lists. Applicant/invitee or maintainer+ → else `404`. `200`                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `GET …/:projectSlug/roles/:roleId`                                           | —                              | Single role. `attachOptionalUser`, matching the list. `200`                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `GET …/:projectSlug/physical-receipts/:receiptId`                            | —                              | Single receipt, caller-scoped exactly as the list is. `200`                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `GET …/:projectSlug/workshop/files/:fileId`                                  | —                              | Single file. Member only → else `404`. `200`                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `GET /milestones/:milestoneId`                                               | —                              | Single milestone; the project-scoped list ships. Member only. `200`                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `GET /discovery/problem-reports/:submissionId`                               | —                              | The caller's own submission; `/mine` returns the list. Own row only → else `404`. `200`                                                                                                                                                                                                                                                                                                                                                                                                                                |

#### 11j.3 Lifecycle holes — an enum value or state nothing can reach

| Method & path                                          | Body / input                                                                                                  | Behavior & statuses                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PATCH /funding-rounds/:roundId`                       | `{ title?, summary?, goalAmountInCents?, minimumPledgeInCents?, maximumPledgeInCents?, opensAt?, closesAt? }` | **A draft round can never be edited.** Create, open and close ship; there is no `updateFundingRound` anywhere in `src/`. A typo in a goal amount is currently permanent. Founder only. Refused once the round has ever opened — `409 ROUND_NOT_EDITABLE`. Re-checks `ENABLED_FUNDING_ROUND_TYPES` if `type` were ever editable, which it is not. `200` · `409` · `422` |
| `DELETE /funding-rounds/:roundId`                      | —                                                                                                             | A draft round can never be withdrawn. Must refuse once it carries a pledge or has ever opened — `409 ROUND_HAS_REFERENCES`, the same shape as `ROLE_HAS_REFERENCES`. `200` · `409`                                                                                                                                                                                     |
| `DELETE /milestones/:milestoneId`                      | —                                                                                                             | No delete path exists. Refuse once the milestone is `done` or is cited by a statement line. `200` · `409`                                                                                                                                                                                                                                                              |
| `POST …/compensation-agreements/:agreementId/decline`  | `{ note? }`                                                                                                   | **The member declines a proposal.** Propose and accept ship; there is no way to say no, so a proposal sits `proposed` forever. The member only → else `403`. `200`                                                                                                                                                                                                     |
| `POST …/compensation-agreements/:agreementId/withdraw` | `{ reasonNote }`                                                                                              | The proposer retracts. `compensationAgreementStatusEnum` (`schema.ts:511`) declares **`withdrawn`** and **no endpoint reaches it** — a value in a shipped enum that no state machine can produce. Founder only. Refused once `active`; a live agreement is superseded, never withdrawn. `200` · `409`                                                                  |
| `DELETE …/:projectSlug/physical-receipts/:receiptId`   | —                                                                                                             | A mis-uploaded receipt is permanent today. Must refuse once cited by an effort claim — the bytes are evidence at that point. Uploader only. `200` · `409 RECEIPT_CITED`                                                                                                                                                                                                |
| `PATCH …/:projectSlug/workshop/files/:fileId`          | `{ fileName?, fileKind? }`                                                                                    | Rename or re-kind a linked file. The URL stays immutable — a changed target is a new file, not an edit. Minor. `200`                                                                                                                                                                                                                                                   |

#### 11j.4 Discovery authoring — the moderator surface §11b never got

| Method & path                                                                           | Body / input                                                                                                                   | Behavior & statuses                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` · `PATCH` · `DELETE /discovery/admin/market-insights[/:insightId]`               | `{ title, categoryId?, regionId?, statKind, statValueMilli, statUnitKey, trendDirection, sourceName, sourceUrl?, observedAt }` | Platform `moderator`, with `requirePlatformCapability` running **before any id is read** so the `403` is not an id oracle (§4a Layer 3) — the same shape the shipped `/discovery/admin/*` rows use. **This is what makes `market_insight` writable at all** (§11j.1). The wire shape is already settled by §6 and §15: `statKind` + `statValueMilli` + `statUnitKey`, never a `"+34%"` string. `201`/`200` · `403` · `422` |
| `POST` · `DELETE /discovery/problem-clusters/:clusterId/project-links[/:projectId]`     | `{ projectId, source }`                                                                                                        | Links a project to a cluster, writing `problem_cluster_project_link` with its `source`. The project's founder, or a moderator. **The missing half of the second dead end** (§11j.1), and the only thing that would let a cluster show what it produced or a project show where it came from. `201` · `403` · `409 ALREADY_LINKED`                                                                                          |
| `POST` · `PATCH` · `DELETE /discovery/admin/skills[/:skillId]` · `/regions[/:regionId]` | `{ slug, displayLabel, … }`                                                                                                    | **Lower priority, and arguably not a defect.** Both vocabularies are seeded by `db:seed-discovery-lookups` and have no runtime write path — which is a legitimate answer for a controlled vocabulary, and exactly why `supplier_capability` deliberately has no `POST` either (§11i). Listed for completeness. Retirement is `isActive`, not `DELETE`. `201`/`200` · `403`                                                 |

#### 11j.5 Go-to-market — the engagement CRUD §11i left out

| Method & path                                                                                            | Body / input                    | Behavior & statuses                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET` · `POST` · `PATCH` · `DELETE /research-projects/:projectSlug/supplier-engagements[/:engagementId]` | `{ supplierId, status, note? }` | Maintainer+ → else `404`. `status` is the shipped `project_supplier_engagement_status` enum — `considering` / `contacted` / `contracted` / `ended`. **The missing half of the third dead end** (§11j.1): without it `supplier_engaged` can never be `met`, so the launch-readiness checklist has a gate no project can pass. §6 already fixes the semantics and they are not negotiable — `contracted` means _this team says it signed something_, and **nothing here may feed a supplier's `verificationState`**, or the public directory becomes forgeable one self-report at a time. One engagement per (project, supplier) pair, already enforced by a unique index. `201`/`200` · `409` |

#### 11j.6 Deliberately absent — do not "fix" these

Every row is a decision with a reason and a section behind it. A verb missing from this domain is as
often a settled argument as an oversight, and this table exists so the argument is not had twice.

| Absent verb                                                              | Why, and where it is settled                                                                                                                        |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PATCH` / `DELETE` on `slice_ledger_entry`, `project_audit_entry`        | Append-only, enforced four ways — revoked grants, triggers, service discipline and the hash chain. A correction is a reversing entry (§4f, §9.1)    |
| `PATCH` on a finalized `compensation_period` or any of its lines         | A finalized statement is corrected by **superseding** it. Editing would invalidate the statement hash and every hash chained after it (§7A.5, §11g) |
| Any endpoint that marks a statement line `paid`                          | Payment is an attestation plus a member confirmation, or it is not evidence (§7A.5)                                                                 |
| `UPDATE` on a locked `member_fair_market_rate`                           | Trigger-frozen at lock. A rate that can move retroactively re-prices every hour already logged against it (§9.1, §9.6)                              |
| `DELETE /suppliers/:supplierId`                                          | `isActive: false` is retirement. Moderation is not deletion, and a deleted supplier orphans the engagements that cite it (§11i)                     |
| `POST /supplier-capabilities`                                            | Seeded vocabulary, exactly like `discovery_skill`. No submission path means no spam surface to moderate (§11i)                                      |
| An unbake endpoint                                                       | Recovery from a bake is a manual, audited, out-of-band operation. `pie_bake_event` is unique per project, once ever (§9.11)                         |
| `consensusAdjustedMinutes` on dispute resolve                            | Settled as §9.12 option (a). A human-supplied number overruling the formula is majority-fiat wearing a quorum, and §9.1 exists to rule it out       |
| Every `/escrow/*`, `/escrow-releases/*` and `/provider-transfers/*` path | 🗑️ Retired on **legal** grounds, not cost — a budget does not bring them back. Do not re-bind (§7, §11g, Appendix A3)                               |
| `POST /webhooks/payments/stripe`, and any raw-body mount                 | Never built and never will be. There is no webhook router in `src/app.ts` and there must not be one (§7A.6 item 1)                                  |
| `GET …/workshop/chat/stream` (SSE)                                       | Deferred on the 20-connection Postgres budget, not on cost. The keyset cursor is the seam that makes it a later insert (Appendix A4)                |
| `GET …/daily-logs/:logId/playback-token`                                 | No playback token exists — the bytes live on youtube.com, so there is nothing to mint (§8, Appendix A1)                                             |
| `POST …/workshop/files` with bytes                                       | Files are external links. `sizeBytes` stays NULL because nobody measured them (§8, Appendix A2)                                                     |
| Everything under `/research-programs/*`                                  | Project Immortal, §10 / §11f. Out of scope for this subsection and last in §16                                                                      |

---

## 12. How a request flows

### Idea → published project

**✅ Shipped in full** — §5.

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

### Pledge → commitment (§7)

**✅ Shipped.** `pnpm db:smoke-funding` drives the sequence including the two attacks. It replaced
`db:smoke-funding-escrow` when the escrow subtree retired: six of that script's nine steps described
authorization, provider submission, settlement and release, none of which exist any more.

```text
POST /funding-rounds/:id/pledges { amountInCents }                          ✅
  → re-bound against the round · resolve currency from the round · SELF_PLEDGE_FORBIDDEN
  → 201: a COMMITMENT is recorded. No card is charged. No funds are held. No fee is taken.
  → the response says "commitment recorded", never "payment succeeded" — a client that
    says otherwise is lying to a backer about where their money is
  → raisedAmountInCents and backersCount move HERE, in the pledge's own transaction.
    escrow_settlement.service.ts used to be their only writer, gated on an auditor
    settling a transfer; with no custody there is no settlement step, and leaving them
    there would freeze every funding page at zero raised forever.

POST /pledges/:id/cancel                                                    ✅
  → both counters come back down, in the cancellation's own transaction
```

`raisedAmountInCents` and `backersCount` are sums of committed pledges and every read projection
labels them so. The settlement path, the provider transfer, the escrow postings and the milestone
release that used to follow this trace are gone from this contract — see §7 and
[ESCROW_LEDGER_STRUCTURE.md](ESCROW_LEDGER_STRUCTURE.md).

### Verified work → month-end statement → payment (§9 → §7A)

**✅ Shipped in full**, and `pnpm db:smoke-compensation` drives exactly this sequence against a real
database — including the asymmetry at the bottom, which is the assertion the whole section exists
to make true.

```text
[once, at the start]
POST …/members/:userId/compensation-agreement { engagementKind, monthlyAmountInCents, … }
  → founder proposes; NOTHING is priced yet
POST …/compensation-agreements/:id/accept          ← the MEMBER, never the proposer
  → trigger freezes the numbers. Now it prices.

[every day, all month]
   §8 daily logs → §9 claims → verdicts → 24h window → slice_ledger_entry
   Cash accrues from the SAME minutes, at the accepted cash rate, with NO verdict gate (§0).

[nightly]
recompute-compensation-draft
  → redraws every line of the open period from scratch. Re-running is byte-identical.

[month rolls over, in the PROJECT'S time zone]
close-compensation-period
  → the period stops accruing; the next one opens. Nothing is frozen — nobody has looked yet.

POST …/compensation-periods/:id/finalize { acknowledgement: "FINALIZE" }     ← founder
  → 409 RATE_NOT_LOCKED if any cash_hourly line has no locked §9 rate
  → recompute once more, freeze every line, hash the canonical statement, append ONE
    project_audit_entry — same transaction, same project_chain_head lock
POST …/compensation-periods/:id/countersign                ← a DIFFERENT admin
  → 422 SELF_COUNTERSIGN_FORBIDDEN, even for a founder

[the founder pays, from their own bank or payroll provider — NOT through Qatoto]
POST …/compensation-period-lines/:lineId/payments { paidAmountInCents, paidOnDate, methodKey }
  → an attestation. Append-only. Changes no line. Stores no account number.
POST …/compensation-period-lines/:lineId/payments/:paymentId/confirm         ← the MEMBER
  → the other half of the evidence. Until it lands, the UI says "unconfirmed", never "paid".

[the number was wrong]
POST …/compensation-periods/:id/supersede { reasonNote }
  → a NEW period, chained to the old one. Nothing is ever edited (§4f).
```

**Read the two halves against each other.** A flagged or unverified verdict on the left changes the
`equity_delta` line and leaves every cash line untouched. That asymmetry is §0's first added rule,
and it is the whole legal difference between a compensation engine and a wage-withholding machine.

### Daily log → slices (§8 → §9)

**✅ Shipped in full.** Every line below runs today, and
`pnpm db:smoke-proof-of-effort` drives exactly this sequence against a real database.

```text
POST …/daily-logs                 → { logDate, narrative?, youtubeUrl? }     ✅
  → the URL is parsed to an 11-char id and oEmbed-verified; no video is also valid
POST …/daily-logs/:id/submit      → 202                                     ✅
  → analyze-daily-log (ONE Gemini call) → transcript segments + chips + claims + evidence links  ✅
POST …/members/:userId/fair-market-rate → /accept → /fair-market-rate/lock   ✅
  → NOTHING can be claimed until a rate is LOCKED: 409 RATE_NOT_LOCKED
POST …/effort-claims              → { sourceKind, dailyLogId?, claimedForDate, idempotencyKey }
  → 202 and a receipt. No minutes, no cash, no verdict, no slices in the body.
  → ground-artifacts → analyze-substance → analyze-temporal                 ✅
  → finalize-verdict: pure verdict function; computeSlicesAwarded → proposedSlices FROZEN
  → slice_allocation_proposal opens; NOTHING is written to the ledger yet
  → daily_log.effortVerificationStatus finally moves off `not_run`
[24 hours pass, no dispute]
  → sweep-dispute-windows (every 60s) locks it: ONE slice_ledger_entry per contribution kind
    + an audit append, in the same txn. Re-running the sweep is a no-op.
  → recompute-equity-snapshot → largest-remainder apportionment → shares sum to exactly 10000
[or, inside the window]
POST …/allocation-proposals/:id/dispute  → slices freeze in escrow, OUTSIDE totalSlices
  → votes reach a majority, or the founder resolves: upheld / voided / re-verified
  → `voided` still writes a ZERO entry — no gap in the sequence, and the member sees it
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
  status.** There are exactly **four** deliberate exceptions, none of them a derived output, and each
  documented where it lives: a founder's advertised equity band (§5) and a member-accepted fair
  market rate (§9), both _negotiated inputs_; a member-accepted cash compensation amount (§7A.2), the
  same kind of thing; and `paidAmountInCents` on a payment record (§7A.5), which is an _attestation
  about the outside world_ — what someone says they transferred from their own bank — and never an
  assertion about what is owed. The owed number stays computed, and the attestation is worthless
  until the member confirms it.
- Pledges accept `{ amountInCents }` only, and the server still re-bounds it. A compensation
  statement line accepts **no amount at all** — it is computed from an accepted agreement and the
  member's own recorded minutes.
- **Qatoto holds no funds and charges nothing.** No payment SDK, no balance, no payout rail, no
  webhook router, no raw-body mount, and `PLATFORM_FEE_BASIS_POINTS` is `0` (§0, §7A.6).
- **A verification verdict never changes a cash number.** It may write `verificationNote` on a
  statement line and nothing else (§0). Grep for any code path where an `effortVerificationStatus`
  reaches a `grossAmountInCents`.
- Finalizing a compensation period requires **two distinct people**, and `admin` cannot be
  self-granted — `roleGrantedByUserId` makes it structural, and a role row with no recorded grantor
  cannot countersign.
- **No payment instrument is ever stored.** No account number, IBAN, UPI handle, card detail or
  payout destination — in any table, any request body, or any log line.
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

> **The mirror of this section is [Appendix B](#appendix-b--the-four-rd-stage-routes-4c-shipped)** —
> the four cross-project stage routes the frontend specs (R_AND_D_STRUCTURE.md §4c). **All four are
> now built** (§11h, §11i), including the two that were blocked on a visibility/privacy decision
> rather than on code; the appendix records what each decision was and what shipped on it. Every one
> of the four is therefore now a row in this section rather than in that one — the backend is ahead
> of the frontend on all of them.
>
> **Frontend phases 2 and 3 are now wired** (R_AND_D_STRUCTURE.md §18), which closes several rows
> below and sharpens the rest. `/project/[id]` reads the detail, team, roles, milestones,
> funding-rounds and investor-confidence endpoints; `/project/[id]/workshop` reads `…/workshop`;
> `/build-log` reads `GET /daily-logs` and the streak leaderboard. All of it is **reads only** — every
> row about a WRITE below still stands.
>
> Two things the wiring proved that this document did not say:
> **`GET /:projectSlug/disputes` and a list form of `GET /:projectSlug/effort-claims` do not exist**
> (§11e lists no such routes and `src/routes/proof-of-effort.routes.ts` has neither), and **signed-out
> is `401`, not `404`**, on `…/workshop` and `/daily-logs` — the 404-not-403 rule governs signed-in
> non-members, and a client has to render both.

Backend supported, no UI yet:

- **Workshop writes.** Still owed, and the gap is now cleaner rather than smaller: phase 3 **deleted**
  the decorative add-task, move-task, upload-file and send-message affordances instead of wiring them,
  because each wrote to `useState` and posted nowhere. The board, files and chat now render real data
  and offer no controls at all, which is honest but not finished.
- **Dispute and consensus.** No dispute button, no vote UI, no quorum progress, no "who raised it".
  **And the backend half is incomplete too**, which this section previously did not say: raise, vote,
  withdraw and resolve all ship, but there is **no read** — no `GET …/disputes`, no
  `GET …/disputes/:id`, and no service function behind either ([§11j.2](#11j2-missing-reads--the-data-exists-and-nothing-can-fetch-it)).
  The UI cannot be built until that lands, so this row is blocked on both sides rather than one.
- **Integration consent.** The entire connect / scope / revoke flow has **no frontend at all** —
  the single largest missing screen, and §9 cannot function without it.
- **Rate lock.** The fair market rate is the foundation of every number on the Proof-of-Effort page,
  and there is no UI to propose, review, lock, or view its history.
- **Pie bake.** No bake action, no pre-bake checklist, no frozen-cap-table view.
- **Chain verification.** No "Verify chain" action, no hash-input inspector. Without it, the
  hash-chain framing is decoration.
- **Override / review.** No surface for a founder to review a flagged step and override it.
- **Project edit.** `GET` + `PATCH` exist; there is no edit entry point.
- **The four §4c stage routes — three of four now call their backend.** `/team-building` and
  `/go-to-market` wired in phase 1; `/build-log` wired in phase 3 and reads `GET /daily-logs` plus the
  streak leaderboard. **`/governance` is the one still on mock data**, and it is phase 5's job.
  The three notes the UI had to honour held up: the build-log feed is **member-scoped**, so a
  signed-out visitor gets the explainer, the legend and the leaderboard with an **empty** feed and a
  sign-in prompt — never a fabricated one; the governance page's per-member walkthrough must stay
  **authored sample data**, because the backend deliberately returns nobody else's line; and the
  readiness checklist's `waived` state is representable but never produced today, so the UI must not
  imply a waiver path exists.
- **Per-project compensation has no host screen at all right now.** The frontend's Governance TAB was
  removed in phase 2: it was bound to a mock project shape the detail page stopped reading, and its
  funding half still rendered `escrowReleaseAmount`, a field this contract retired. The panels it hosted
  (`compensation-agreements-panel`, `compensation-statement-panel`) survive unmounted, and phase 5
  remounts them against `…/compensation-agreements` and `…/compensation-periods`.
- **Tiered / multi-currency funding, paper moderation queue, talent profile editing.**

Two of these have stopped being UX debt and become **compliance gaps**, and they should be read that
way in planning:

- **Dispute and consensus** plus **override / review** are the GDPR Art. 22 contestability path and
  the EU AI Act Art. 14 human-oversight control (§9.8, §7A.6 item 5). A backend that offers human
  intervention through an endpoint no screen calls does not, in practice, offer it.
- **Integration consent** is the lawful-basis and transparency surface for worker monitoring (§9.10).
  It is already listed as the largest missing screen; it is also the one with a regulator behind it.

The entire §7A surface is missing too, and it is the product's headline output: no agreement
proposal or acceptance, no statement view, no finalize or countersign action, no payment
acknowledgment, no export. The `governance-tab.tsx` that rendered an escrow ledger this contract no
longer describes has been **deleted** rather than corrected — see the bullet above.

Frontend-side work the contract forces:

- **Pagination everywhere.** `ProjectProofOfEffortLedger` is a flat object with unbounded arrays. A
  two-year-old project has thousands of entries. Phases 2–3 took the first bite: `GET /daily-logs`
  is keyset-paged behind `getCursorPaginated`, and the per-project log read is capped at a `limit`.
  **No page renders a "load more" control yet**, so a `nextCursor` is currently parsed and dropped.
- **Async states.** Claim submission returns `202`, not a verdict. The UI assumes verdicts exist
  synchronously; it needs pending states plus polling or SSE. Phase 3 wired the read half of this
  correctly — `effortVerificationStatus` renders all six states, so `queued` and `running` no longer
  look like a refusal.
- **Idempotency keys** on claim submit, receipt upload and dispute raise, or a retried request on a
  flaky mobile connection duplicates. Untouched — nothing writes yet.
- **Multiple verification attempts.** `ClaimVerificationRun` models one run; re-verification
  produces attempt 2+ and the UI would show stale results.
- **A member-scoped read needs a fourth render state**, which phases 2–3 had to add: not just
  loading / error / empty / ready, but **restricted**. `MemberScopedListViewState` collapses `401`
  and `404` into one `restricted` variant while keeping `isSignInRequired`, so a stranger gets a
  sign-in prompt and a signed-in non-member gets "this is the team's" — and neither answer reveals
  whether the child resource exists. It is only safe because the PUBLIC parent read resolves first.

---

## 15. Frontend types that must change shape

Not just values — **shapes**. Every one is a compile error the migration must work through.

**`project.ts`** — `TeamMember` (`equityShare: "62%"` → `equityBasisPoints: 6200`;
`effortHoursLogged: 148` → `verifiedEffortMinutes: 8880`; `joinedDate` → `joinedAt` ISO; `id` slug →
`userId`; `isFounder` **removed**, derived from `projectRole`) · `CompensationComponent`
(`amountLabel` → a **discriminated union per kind** carrying typed integers; `earnedAsLabel` →
`earnedAsPolicy` enum) · `MilestoneVariance` (five labels → six typed integers + two unit nouns;
`varianceLabel: "26% behind"` → **signed** `varianceBasisPoints: -2600`) · `Milestone`
(`escrowReleaseAmount` → **`plannedPayoutInCents`** — renamed as well as retyped, because it no
longer instructs a payment rail) · `FundingRound` (`goalAmount`/`raisedAmount` → cents;
**`percentageFunded` deleted**, computed on read) · **`EscrowLedgerEntry` deleted outright** —
replaced by `CompensationPeriod`, `CompensationPeriodLine` and `CompensationPaymentRecord` (§7A) ·
`DailyLog` (`date` **splits** into `logDate` + `submittedAt`; `isEffortVerified: boolean` → the
six-value enum) · `ResearchProject` (`founderId` slug → `founderUserId`; `coverImageSrc` → absolute
URL; **`id` stays a slug, deliberately**).

**New in `project.ts`, with no mock ancestor** — the §7A shapes. `CompensationPeriod`
(`periodStartDate`/`periodEndDate` date-only, `timeZone`, `status`, `statementHash` full 64 chars,
`finalizedAt`/`countersignedAt` ISO or null) · `CompensationPeriodLine` (a **discriminated union on
`kind`**: `cash_retainer` and `cash_hourly` carry `grossAmountInCents` + `currency`, `cash_hourly`
adds `effortMinutes`, `equity_delta` carries three basis-point integers and **no money field** — the
union is what stops a client summing equity into a cash total) · `CompensationPaymentRecord`
(`paidAmountInCents`, `paidOnDate`, `methodKey`, `confirmedByMemberAt` nullable — and a client must
render an unconfirmed payment as unconfirmed).

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
project-role concept, no `engagementKind`, and no `escrowedSlices`.

> **`escrowedSlices` keeps its name even though escrow is gone.** It means _slices frozen outside
> `totalSlices` while a dispute runs_ (§9.8) — a pool, never money. The two senses of the word
> collided constantly while this contract was being written, and the fix is a comment on the type,
> not a rename that would break §9's shipped column.

---

## 16. Build order

Do **not** implement the domains in parallel — §9 defines the numbers every other section reads.

| Phase                             | Scope                                                                                                                                                                                                                           | Why here                                                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **0. Unblock**                    | `bearer()` plugin + multi-origin passkey/OAuth (§4a) · `requireIdentifiedUser` · `project_member` + `requireProjectRole` · `src/lib/money.ts` · `src/lib/canonical-hash.ts` · pg-boss + the worker process · shared enums (§4d) | Every phase below depends on all of it. Native clients are blocked entirely until the auth items land                                            |
| **1. Projects & team** (§5)       | Idea → project → publish → team → roles → applications                                                                                                                                                                          | The spine. Everything else FKs to `research_project`                                                                                             |
| **2. Workshop & daily logs** (§8) | Board, files (links), chat, log capture + analysis                                                                                                                                                                              | Produces the input §9 consumes                                                                                                                   |
| **3. Proof of Effort** (§9) ✅    | Rate lock → claims → pipeline → disputes → ledger → snapshots → bake                                                                                                                                                            | **Shipped.** The hardest and highest-value. Its patterns are the ones §7A copies                                                                 |
| **4. Funding** (§7) ✅            | Rounds, pledges, milestones — as records of intent                                                                                                                                                                              | **Shipped**, escrow half now superseded. **Crowdfunding only** — equity/venture stay flag-disabled; they are securities offerings (§7A.6 item 4) |
| **4a. Compensation** (§7A) ⏳     | Agreements → accept → nightly draft → close → finalize → countersign → payment records → export                                                                                                                                 | **The product.** Depends only on §9, which shipped. Nothing else blocks it, and it is what makes every daily log worth logging                   |
| **5a. Go-to-market** (§11i) ✅    | Supplier directory, seeded capability vocabulary, engagements, derived launch readiness, `product.researchProjectId`                                                                                                            | **Shipped.** A new domain beside §5 and just as independent — deferrable, blocking nothing. Migration 0020                                       |
| **5. Discovery** (§6)             | Clusters, scoring jobs, insights, talent                                                                                                                                                                                        | Independent; deferrable without blocking anything                                                                                                |
| **6. Project Immortal** (§10)     | Branches, papers, posts, moderation                                                                                                                                                                                             | Largest surface, lowest coupling. Needs the moderator role first                                                                                 |

**§7A shipped, and it did delete more surface than it added** — nine escrow routes, three jobs, one
smoke script and 268 lines of controller went with it.

**Appendix B's four stage routes shipped too**, in the placement it prescribed: B1 was a projection
widening on `/open-roles` plus a §11b row; B2 and B3 folded into the already-shipped §8 and §7A
surfaces as one root-mounted read each (§11h); B4 landed as **phase 5a**, a new domain beside §5,
independent and blocking nothing. All of it is behind the two compliance items below, which remain
the only things between the shipped backend and a lawful EU deployment.

**Do the two compliance items next**, ahead of §5 and §6, because both are compliance rather than
polish (§7A.6) and both are now the only things standing between the shipped backend and a lawful
deployment in the EU: the **dispute / override UI** (§14), which is the human-intervention path Art.
22 and AI Act Art. 14 require to be REACHABLE — a backend endpoint nobody can find is not human
oversight — and the **integration-consent screen**, which is the lawful-basis and transparency
surface for worker monitoring.

**Then [§11j](#11j-gaps--what-the-rd-surface-still-needs), the gap list**, which is what closes out
"R&D is complete apart from Project Immortal". Inside it the order is not flat:

1. **§11j.1's three write-path dead ends first** — `market_insight`, `problem_cluster_project_link`
   and `project_supplier_engagement`. A permanently empty read outranks an absent one, because a
   surface that renders an empty state looks built and reports nothing. Two of the three are already
   visible as "dark" rows in the frontend's own §18, mis-attributed there to frontend work.
2. **Then §11j.2's dispute reads**, which are the backend half of the Art. 22 / Art. 14 compliance
   item above — that item cannot be closed without them.
3. **Then the remaining reads and lifecycle holes** (§11j.2, §11j.3), which are ordinary product
   gaps: `GET /invites/mine` is the sharpest, since an invite nobody can find is an invite nobody
   can accept.
4. **§11j.4's skills/regions rows last, if at all** — a seeded vocabulary with no runtime write path
   is a legitimate design, not a defect.

**Then §10 (Project Immortal)**, which is the only backend section still entirely unbuilt.

This matches PROOF_OF_EFFORT_SPEC.md §1's sequencing: the AI Chief of Staff (§9 + §7A) comes first;
reward crowdfunding (§7) is optional and later; equity crowdfunding stays API-disabled until the
securities work behind it is real.

---

## 17. Verification (when the backend phase begins)

1. `pnpm db:generate && pnpm db:migrate && pnpm jobs:install`, then hand-add what Drizzle cannot
   express: the `COLLATE "C"` alterations (§8, §10) and the append-only triggers and narrow UPDATE
   guards (§4f, §7, §9.1). **Drizzle DOES emit partial unique indexes** — the first draft of this
   step was wrong about that, and §9's are declared normally. `pnpm
db:verify-proof-of-effort-constraints` then EXERCISES all 38 database-level guarantees against
   real rows: an untested hand-written migration is indistinguishable from an absent one.
2. **Determinism suite, before anything else ships.** Run `recompute-equity-snapshot` 1,000 times
   with input rows shuffled and assert byte-identical `equity_snapshot_share` output. Assert
   `computeSlices` reproduces **every** figure in `solar-cold-storage.ts` (§9.2 lists them). Assert
   apportionment sums to exactly `10000` over randomized member sets, including ties.
3. **Chain suite.** Append 500 entries, verify; then tamper with one row's `detailNote` directly in
   SQL and assert `/audit-trail/verify` returns `409` naming that exact sequence. Delete a row and
   assert the gap is detected even though every surviving hash is self-consistent.
4. **The tampering test the user asked for.** ✅ Fetch a round, edit `amountInCents` in DevTools to
   a different currency's magnitude, replay the pledge — assert the server records its own value and
   that every rejected key in §7A returns `422`. `funding.controller.schemas.test.ts` asserts the
   rejected keys against every funding body plus that exact payload, and `db:smoke-funding`
   proves the server re-bounds the amount against the round's own min/max. ✅ Repeated against a
   §7A statement line, where there is **no amount field at all** to tamper with:
   `compensation.controller.schemas.test.ts` asserts all 38 rejected keys against every §7A body
   plus a positive control, and the finalize body carries an acknowledgement string and nothing
   else. Still to repeat against the native clients with a proxy.
5. **Four-eyes test.** ✅ Ported to `finalize` → `countersign`, which is where two-person control
   now lives; the escrow version went with the subtree. `pnpm db:smoke-compensation` runs all three
   assertions: the finalizer attempts to countersign → `422 SELF_COUNTERSIGN_FORBIDDEN`, **even for
   a founder**; a plain contributor → `403 COUNTERSIGNER_NOT_AUTHORIZED`; a second, non-self-granted
   `admin` → signed. A founder granting themselves `admin` is rejected by
   `project_member_role_granted_by_ck` at the column level, and `resolveSecondSignatoryStanding`
   refuses an `admin` row with no recorded grantor. `db:verify-compensation-constraints` additionally
   proves `compensation_period_countersign_ck` rejects a self-countersignature at the COLUMN level,
   so a psql prompt cannot step around the service.
   5a. **The wage rule, which is the one with a statute behind it (§0, §7A.6 item 2).** ✅
   `db:smoke-compensation` gives two members identical work in one month, one `verified` and one
   `flagged_for_review`, and asserts their `cash_hourly` lines are byte-identical — same minutes,
   same gross, same currency — with only `verificationNote` differing. The grep half is clean too:
   every mention of `verificationStatus` in the compensation services is inside
   `buildVerificationNotes`, which takes no amount and returns strings.
   5b. **Statement determinism and freeze.** ✅ `db:smoke-compensation` runs the draft 20 times and
   asserts byte-identical lines, then tampers with a finalized line (with the freeze trigger
   disabled, the honest shape of the threat) and asserts the chain breaks naming that period.
   `db:verify-compensation-constraints` proves the trigger itself rejects the `UPDATE`, and that an
   OPEN period's line stays writable — the positive control, without which "everything is rejected"
   would pass.
   5c. **Payment records store nothing sensitive.** ✅ `db:smoke-compensation` posts a
   `referenceNote` containing a card-shaped number and asserts `422`;
   `compensation.controller.schemas.test.ts` asserts the `accountNumber`, `iban`, `upiId` and
   `paymentMethodId` KEYS are refused, and `payment-instrument.test.ts` asserts the VALUES are — a
   rejected-key list is defeated by putting the number in a field that is allowed.
   `db:verify-compensation-constraints` sweeps the whole schema and finds exactly one such column,
   `provider_transfer.payout_destination_id`, on a retired escrow table: never client-supplied,
   nullable, and unwritten now that nothing pays anyone. The sweep excludes the retired tables and
   then asserts the exclusion is exactly that column, so the carve-out is bounded rather than silent.
6. **The analysis path, against the real provider.** ✅ `pnpm db:smoke-daily-log-analysis` is the
   only proof in the repo that reaches Gemini: `gemini.test.ts` injects `fetch`, `db:smoke-workshop`
   asserts only that a submit receipt is not a verdict, and `db:smoke-proof-of-effort` writes its
   `daily_log_extracted_claim` rows by hand (`generatedByModel = 'smoke'`) so §9 stays deterministic
   and offline. Until it existed, `daily_log_transcript_segment` and `daily_log_ai_summary_chip` had
   never held a row in any environment and every verdict in the database had been priced from
   hand-typed minutes — a correct formula over a fabricated input. The script submits a real
   video log and a real text log, runs the job handler, asserts the provenance is the live model
   and not a fixture, asserts `effortVerificationStatus` is still `not_run` afterwards, then files
   an effort claim and drives the four stages to a verdict whose minutes equal the model's own
   `extractedMinutes`. It needs a key and refuses to run without one. Costs two requests per run.
7. **Dispute lifecycle.** ✅ `pnpm db:smoke-proof-of-effort` runs exactly this, in order, against a
   real database: verify a claim and confirm nothing is in the ledger; expire the window and confirm
   the settlement appears; re-run the sweep and confirm it is a no-op; dispute another and confirm
   slices show as escrowed and _outside_ `totalSlices`. It also tampers with a `detailNote` in SQL
   (with the append-only trigger disabled, which is the honest shape of the threat) and asserts the
   chain breaks at that exact sequence. **The script leaves its rows behind and that is the
   guarantee, not a limitation** — a smoke test that could clean up after itself would be one
   proving the triggers do not work. Because it leaves rows behind and so does every other smoke
   script, **each sweep assertion counts this run's project and no other.** `sweepExpiredWindows` is
   the production job and is deliberately project-agnostic (§9.8), so a global `settled` count would
   make this gate pass or fail on what an unrelated run left in the database yesterday — which is
   exactly how it first broke, on one expired-unlocked window belonging to a `smoke-gemini-*` project
   from `db:smoke-daily-log-analysis`. The sweep still runs unscoped and still settles those foreign
   windows; only the assertion is narrowed. It also runs with a batch of 500 rather than the
   production 50, because the sweep takes the oldest window first and accumulated leftovers always
   sort ahead of this run's own two.
8. **Zero-trust sweep.** `grep` every Zod schema for `userId|equity|slice|Cents|score|verdict|status`
   and confirm each hit is one of the two documented negotiated-input exceptions.
9. **Cascade sweep.** ✅ For every FK into a financial or audit table, assert `onDelete` is
   `restrict` or `set null`. `db:verify-escrow-constraints` checks 33 of them and
   `db:verify-compensation-constraints` checks §7A's 19, each against a hand-maintained expectation
   AND a catalog sweep for any cascade at all, so a table added later without updating the list
   still fails. Both then delete a test user with statement history and confirm it fails loudly.
10. **Coverage sweep.** Every route in [R_AND_D_STRUCTURE.md](R_AND_D_STRUCTURE.md) §3 and every
    action in its §8/§9 maps to a named endpoint in §11.
11. **The four stage routes (Appendix B).** ✅ `pnpm db:verify-go-to-market-constraints` exercises
    migration 0020's guarantees against real rows inside a rolled-back transaction: the `supplier`
    slug UNIQUE that makes a duplicate listing a `409`, the slug and lead-time CHECKs, the
    `direct_email`-needs-a-website implication, the `restrict` that stops a curated capability
    vanishing under a listing that claims it, the one-engagement-per-pair unique, and **R1 on
    `product.research_project_id`** — a project with a linked listing must refuse to delete.
    `daily-log-cursor.test.ts` proves the three-column cursor round-trips and rejects twelve
    malformed forms, because a codec that loses a field either skips a member's log or repeats it.
    `daily-logs.controller.schemas.test.ts` asserts the feed's query refuses `projectIds`, `userId`,
    `memberId`, `includeAllProjects` and `status` — every key that would turn a private feed's
    membership filter into a client-supplied input — and `suppliers.controller.schemas.test.ts`
    asserts `verificationState` is refused on create and `slug` on update.
    **The planner check was run, and it corrected this document.** Against a caller in seven
    projects with 2,800 submitted logs, `daily_log_feed_idx` **is** chosen — but an earlier draft of
    this step also predicted "no sort node above the index scan", and that was wrong.
    `project_id IN (subquery)` plans as a semi-join, so Postgres will not merge per-project index
    scans into an ordered path: **the index serves the filter, not the ordering, and the `ORDER BY`
    always sorts the caller's matching set.** That bound is stated rather than papered over; the
    honest fix if it ever hurts is a denormalized feed ordering, not another index.
    What the measurement did expose was avoidable and is fixed: the joined form hash-joined **2,815
    rows** through `project_member` and `user` before the top-N sort discarded all but 21, so join
    cost scaled with the caller's whole history instead of with the page. `listDailyLogFeed` now
    orders and limits over `daily_log` **alone** and attaches authors and project chips in two
    bounded follow-up queries — the `attachCompensation` shape. Same fixture: **12.5 ms → 3.4 ms**,
    and the sort is over narrow unjoined rows.
    **The paging claim is now discharged, and finding it a fixture uncovered a real bug.** ✅
    `pnpm db:smoke-daily-log-feed` seeds one caller, four projects, membership in three, and logs
    whose `logDate`s interleave across them — **the first multi-project fixture in this repo, and
    the first execution of the feed's cursor anywhere.** Fourteen assertions: completeness and
    strict ordering at five page sizes including `limit=1`, membership scoping, draft exclusion,
    `?projectSlug=` and `?chipKind=` paging _completely_ rather than merely correctly, an
    unreachable slug returning an empty page rather than a `404`, and a malformed cursor refused
    rather than silently restarting.
    Two logs deliberately share a day **and** a byte-identical `submittedAt`, leaving `id` as the
    only discriminator. That case cannot be built through the service at all — `submitDailyLog`
    stamps `new Date()` per call, so N submits always land on N distinct milliseconds — which is why
    the fixture rows are hand-written, the same reason `db:smoke-proof-of-effort` hand-writes its
    claim rows.
    11a. **A millisecond cursor over a microsecond column drops rows** (migration 0021). Both
    cross-project cursors encode their instant with `getTime()` — milliseconds — while their columns
    stored microseconds. A cursor coarser than its column cannot express the boundary: the next page
    asks for `instant < <ms>` OR `instant = <ms>`, and a row whose true value carries microseconds
    matches neither, so it is **unreachable on every page** rather than merely misordered.
    On `daily_log` this was latent — `submitDailyLog` writes `new Date()`, so all 32 rows were
    millisecond-exact and the cursor was correct by accident of one write path. **On
    `workshop_chat_message` it was live**: `postMessage` never sets `sentAt`, so the column default
    `now()` supplied full microsecond precision. Both columns are now `timestamp(3)`, which is
    stronger than the CHECK this started as — a CHECK would have rejected every chat insert, because
    the value comes from the column's own `defaultNow()`. `editedAt` and `deletedAt` feed no cursor
    and keep microseconds.
    11b. **The assertion that should have caught it could not**, and that is the more useful lesson.
    `smoke-workshop-pipeline.ts`'s header has always claimed the chat cursor "neither repeats nor
    skips a row", but the body compared two pages for overlap and stopped there — a cursor dropping
    one row per page passes that. Its fixture also posted each message in its own round trip, so no
    two ever shared a millisecond. It now batch-inserts (`now()` is fixed per statement, so the rows
    tie exactly) and walks the whole history asserting set-equality. Before the migration it reads
    `expected=11 walked=10 distinct=10 missing=1`; after it, `missing=0`. **A regression test that
    has never been red proves nothing**, and this one was red first.

```bash
# The core zero-trust smoke test. `pnpm db:smoke-funding` drives all of this and 13 more
# assertions against a real database; these three are the hand-runnable form.
curl -X POST https://localhost:8000/research-projects -b cookies.txt \
  -H 'content-type: application/json' \
  -d '{"name":"SolarChill","tagline":"Solar cold rooms","categoryId":"<id>",
       "problemStatement":"Produce spoils in transit"}'
# → 201, capture the slug

curl -X POST https://localhost:8000/funding-rounds/<id>/pledges -b cookies.txt \
  -H 'content-type: application/json' -d '{"amountInCents":5000}'
# → 201; a COMMITMENT is recorded. No card is charged and no funds are held (§7).

curl -X POST https://localhost:8000/funding-rounds/<id>/pledges -b cookies.txt \
  -H 'content-type: application/json' -d '{"amountInCents":5000,"currency":"CNY","backerUserId":"someone-else"}'
# → 422, both unknown keys rejected by .strict()
```

**The §7A gates, all runnable today:**

```bash
pnpm db:verify-compensation-constraints   # 71 database-level guarantees, positive controls included
pnpm db:smoke-compensation                # §12's trace end to end, including the §17 5a wage rule
pnpm db:smoke-funding                     # the commitment path and the two attacks
```

**The Appendix B gates, all runnable today:**

```bash
pnpm db:seed-supplier-capabilities        # the 20-row vocabulary; migration 0020 creates the table only
pnpm db:verify-go-to-market-constraints   # migration 0020's guarantees, R1 on product included
pnpm db:smoke-daily-log-feed              # the cross-project cursor: 14 assertions, 5 page sizes
pnpm db:smoke-workshop                    # includes the chat cursor's no-SKIP assertion
pnpm test                                 # the cursor codec and both zero-trust schema suites
```

The member-scoping attack, hand-runnable:

```bash
# Signed in as a member of exactly one project, ask for another project's logs.
curl 'https://localhost:8000/daily-logs?projectSlug=someone-elses-project' -b cookies.txt
# → 200 with an EMPTY page. Not 403 (which would confirm the slug exists) and not 404.

curl 'https://localhost:8000/daily-logs?projectIds=prj_a&projectIds=prj_b' -b cookies.txt
# → 422. The key exists in no schema; membership is a subquery over project_member.

curl 'https://localhost:8000/daily-logs?cursor=garbage' -b cookies.txt
# → 422 CURSOR_MALFORMED, never a silent first page.
```

---

## Appendix A — Deferred paid infrastructure

Everything in this appendix was specified in the body of this document and is **not built**. It is
preserved unabridged so switching any of it on later is a re-read rather than a redesign. Nothing
here may be implemented without an explicit decision to start paying for it.

Each entry states what was deferred, the seam that keeps it cheap to restore, and the honest cost of
the substitute that shipped instead.

> **A3 is the exception, and it is not a cost decision.** A1, A2 and A4 are waiting on a budget.
> Escrow was **removed on legal grounds** and cannot be restored by spending money — read A3 before
> assuming otherwise.

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

### A3. Escrow and payments (§7) — not deferred, _removed_

**This entry is different from the others, and the difference matters.** A1, A2 and A4 are deferred
on **cost**: switch on a budget and they ship. Escrow is not deferred. It has been **removed from
this domain on legal grounds**, and a budget does not change the analysis.

**Why it cannot simply come back.** Holding funds for later payout requires payment-institution
authorisation under PSD2 in the EU, state money-transmitter licensing plus FinCEN registration and a
BSA/AML program in the US, and RBI payment-aggregator authorisation with a ₹15 crore net-worth floor
in India — and none of that turns on whether a fee is charged (§7A.6 item 1). Worse, escrow release
had become the gate on **cash compensation**, which made a wage conditional on an algorithmic
verdict: unlawful withholding under the FLSA, national EU wage law, and §18 of India's Code on Wages 2019. §0's first added rule exists because of that, and reinstating the escrow path would break it.

**Where the design went, unabridged:
[ESCROW_LEDGER_STRUCTURE.md](ESCROW_LEDGER_STRUCTURE.md).** The double-entry ledger, the six-account
model, the zero-sum invariant, the canonical hash chain, the four-way append-only enforcement
(revoked grants + triggers + service discipline + chain), the four-eyes release with a frozen
evidence snapshot, the provider-adapter seam, the webhook-event dedupe and the reconciliation job
are all good engineering and none of it is wasted. It is retargeted at **commerce**, where a
buyer↔seller hold is a real requirement — and even there Qatoto mirrors a licensed provider (Razorpay
Route, Cashfree Easy Split, Stripe Connect, Mangopay) rather than custodying anything itself.

**What is still in the backend, and what is not.** The routes are **gone** — all nine 404, the
handlers are deleted, and `submit-provider-transfer`, `reconcile-escrow-ledger` and its tick are
unbound with no cron. Migration 0016, its seven tables and the services
(`escrow.service.ts`, `escrow-settlement.service.ts`, `escrow-releases.service.ts`,
`escrow-provider-adapter.service.ts` and the two jobs) are still on disk and in the database,
**uncalled**.

They stay because dropping the tables would discard rows the append-only triggers exist to protect,
and because `db:verify-escrow-constraints` still proves those triggers work. **Do not re-bind
them.** §11g's retirement order was followed exactly — §7A first, then the four catch-up items, then
the subtree — because retiring it first would have left shipped cash strands pointing at a payout
mechanism with nothing behind it.

**What was never built and now never will be.** `POST /webhooks/payments/stripe`, the Stripe SDK,
and the raw-body mount in `src/app.ts` that a signed webhook would have needed. The internal
settlement endpoint that stood in for the webhook is superseded along with the rest.

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

---

## Appendix B — The four R&D stage routes (§4c), shipped

§14 lists the surfaces where the **backend is ahead of the frontend**. This appendix was its mirror:
[R_AND_D_STRUCTURE.md §4c](R_AND_D_STRUCTURE.md) specs four **stage routes** the frontend did not
have, and this recorded what the backend owed them. **All four are now built.** This is a changelog,
not a build list.

The four, and why they exist: the landing page's stages strip had six cards and three of them
pointed at in-page anchors, two at the _same_ anchor. Team building, daily logs and governance lived
only as tabs **inside** a project, so a visitor who had not picked one could not reach them at all.
Each stage now has a cross-project page and a backend to serve it.

| Stage route (frontend) | What it renders                                       | Backend state                                                         |
| ---------------------- | ----------------------------------------------------- | --------------------------------------------------------------------- |
| `/team-building` (03)  | Every open role + teams forming + talent spotlight    | ✅ **Shipped** — four existing endpoints + one widened projection, B1 |
| `/build-log` (04)      | Cross-project daily-log feed + streak leaderboard     | ✅ **Shipped** — two root-mounted reads, §11h, B2                     |
| `/governance` (05)     | Commitments + a month-end statement + accountability  | ✅ **Shipped** — one read-only aggregate, §11h, B3                    |
| `/go-to-market` (06)   | Suppliers/ODM + launch readiness → `/studio/products` | ✅ **Shipped** — a new domain, §11i, migration 0020, B4               |

**Two of the four were blocked on a decision, not on code.** Both were about who may see someone
else's data, both were introduced by making a per-project surface cross-project, and neither could
be resolved by writing the endpoint and seeing what happened. Both decisions are recorded below with
what was built on them.

### What this appendix got wrong, corrected in the build

Recorded rather than quietly fixed, because each was a claim the implementation had to disprove:

| The appendix said                                                                | What is actually true                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/open-roles` needs `coverImageSrc`                                              | The column is **`coverImageUrl`**. `coverImageSrc` exists nowhere in `src/`, on either side                                                                                                                           |
| B1 is "write no new code"                                                        | `OPEN_ROLE_VIEW_COLUMNS` carried neither `stage` nor the cover, so the widening the appendix itself asks for two paragraphs later **was** required. The doc row was not the only gap                                  |
| §9.11 established a `met`/`not_met`/`waived` checklist                           | It established no checklist at all. §9.11 specifies an acknowledgement, an `expectedSnapshotId` and a `409 UNSETTLED_ALLOCATIONS`; `pie-bake.service.ts` implements three sequential gates. The tri-state is new here |
| `product` belongs to `STUDIO_BACKEND_STRUCTURE.md`                               | It is documented in **`STORE_BACKEND_STRUCTURE.md` §4**. The studio doc owns `video`. The FK note went to the store doc                                                                                               |
| Supplier submissions should land `pending` "exactly like `discovery/categories`" | Built **moderator-only, with no submission path and no moderation state** — the appendix's own next sentence argues for exactly that, and a queue nobody needs yet is a surface to defend                             |
| `supplier` should carry `…InCents` fields                                        | **No price column exists.** §4b derives currency from the project, and a supplier has none. A quote belongs to an engagement                                                                                          |

### B1. `/team-building` — one widened projection, one doc row

Everything this page needs was already routed:

| Need                      | Endpoint                                                         | §   |
| ------------------------- | ---------------------------------------------------------------- | --- |
| Every open role, filtered | `GET /open-roles?commitment=&skill=&minEquityBasisPoints=&page=` | 11a |
| Teams forming             | `GET /research-projects?stage=team_building&page=`               | 11a |
| Talent spotlight          | `GET /discovery/talent?…&page=`                                  | 11b |
| Skill filter chips        | `GET /discovery/skills`                                          | 11b |
| Apply to a role           | `POST /research-projects/:projectSlug/applications`              | 11a |

**The documentation bug is fixed.** `GET /discovery/skills` was shipped —
`discovery.routes.ts:76`, `attachOptionalUser`, `catalogController.listSkills` — and missing from
§11b's table. It now has a row. It is the canonical source for the skill chips on this page and on
`/talent`, and the endpoint that retires the `skills.some((skill) => skill.includes(chipText))`
substring bug (§6).

**And the projection was widened, which was a code gap the appendix half-noticed.** The check it
demanded — does `/open-roles` carry enough for a card without a second call? — came back **no**:
`OPEN_ROLE_VIEW_COLUMNS` had `projectSlug`, `projectName` and `currency`, but neither `stage` nor
the cover. Both now join off the `researchProject` join that was already there, so the grid neither
N+1s nor renders a card with a missing project. **No second endpoint was added**, per the appendix's
own instruction.

`stage=team_building` is `snake_case` on the wire (§4d). The frontend mocks still say
`"team-building"`; that is on the §15 migration list, and this filter is one of the places it bites.

### B2. `/build-log` — decided (a), then built two root-mounted reads

**The blocker, and how it was resolved.** Daily logs are private to the project's members and the
enforcement is real: `listDailyLogs` opens with `requireMemberOrRespond`
(`daily-logs.controller.ts`) and every `/workshop/*` route runs
`requireProjectRole(…, "contributor")` with failure → `404` (§8). A cross-project feed rendered to a
logged-out visitor contradicts that outright.

**Option (a) shipped** — the "my projects" feed. One root route, no new column, no policy change,
and honestly scoped. (b), a per-log `logVisibility` opt-in, would have defaulted **every log ever
written** to private — an opt-in nobody has opted into — and remains available later if a genuine
build-in-public feed is wanted. (c), a public feed of analysis chips only, stays **rejected**: the
metadata is the sensitive part for worker monitoring (§9.10).

Under (a) the page is member-scoped and the stage card must say so. A stranger sees the explainer,
the legend and the leaderboard, and an **empty** feed with a sign-in prompt — never a fabricated
one.

**What was built** (full table in [§11h](#11h-cross-project-reads-8-7a)):

- **`GET /daily-logs`, root-mounted** on the `researchCatalogRouter` pattern — as a second named
  export from `workshop.routes.ts`, mirroring §7's `fundingRouter` / `projectFundingRouter` split:
  one domain, one route file, two mounts. `?projectSlug=&chipKind=&cursor=&limit=`, `requireAuth`,
  and the WHERE clause is `projectId IN (caller's active memberships)` — **a subquery over
  `project_member`, never a client-supplied project list.** There is no `?projectIds=`, and
  `.strict()` turns one into a 422 rather than an ignored parameter.
- **Keyset across projects**, `(logDate DESC, submittedAt DESC, id DESC)`, ending in a unique column
  (§4c rule 4). Backed by a new composite `daily_log_feed_idx` on
  `(projectId, logDate, submittedAt, id)`, partial on `status = 'submitted'`. Merging six projects
  client-side is the thing CLAUDE.md §Performance forbids, and the codec lives in
  `src/lib/daily-log-cursor.ts` with its own test. **The index serves the filter, not the
  ordering** — `project_id IN (subquery)` plans as a semi-join, so the `ORDER BY` sorts; §17 item 11
  records the measurement and why that bound is accepted rather than indexed around.
  **`submitted_at` is `timestamp(3)` because the cursor carries milliseconds** (§17 item 11a). A
  microsecond column under a millisecond cursor makes rows unreachable rather than merely
  misordered, and `db:smoke-daily-log-feed` asserts the rounding along with the paging.
- **The page is ordered and limited over `daily_log` alone**, with authors and project chips
  attached in two bounded follow-up queries. The obvious joined form made join cost scale with the
  caller's whole history rather than with the page — 2,815 rows joined to return 21, on a
  seven-project fixture.
- **The chip-kind filter is a correlated `EXISTS`**, with `daily_log_ai_summary_chip_kind_logId_idx`
  behind it. The denormalized `chipKinds` column the appendix floated was **not** added: it would
  have cost a migration, a change to `analyze-daily-log` and a backfill of every analyzed log, to
  serve what an index serves. Filtering in the service after fetching was never an option — it
  short-pages the cursor.
- **Each row carries its project** — `projectSlug`, `projectName`, `projectCoverImageUrl`,
  `projectStage`. The frontend fabricates no project chip.
- **The streak leaderboard was free**, and is its own **public** endpoint:
  `GET /daily-logs/streak-leaderboard`. `project_stats.dailyLogStreakDays` is already job-computed
  and stored, with `lastDailyLogDate`, `projectTimeZone` and `statsComputedAt` beside it (§5). All
  four ship, and the client renders "as of" — a streak decays at midnight with no write, so a
  leaderboard implying live numbers is lying.
- **`effortVerificationStatus` ships as the six-value enum** (§8), not a boolean. The legend on this
  page is the most visible place the frontend's `isEffortVerified: boolean` (§15) contradicts the
  wire.

### B3. `/governance` — decided aggregates-only, then one aggregate read

**The blocker, and it was the more serious of the two.** A month-end statement line names a person
and what they are owed. Pay data is personal data under the GDPR and treated as specially sensitive
in several member states; §7A already keeps account numbers out of the system entirely. Making the
per-project governance tab cross-project and public would have published per-member cash figures to
anyone with the URL.

**The resolution the frontend spec assumed is what shipped:**

- **Per-member statement lines stayed on the per-project tab** (§5.5), behind membership, with the
  finalize / countersign / record-payment / confirm / export actions. Nothing moved.
- **The cross-project page renders aggregates and mechanics, not people.** Per-project period counts
  by status, countersigned counts, aggregate committed funding. No member id, no user id, no name,
  no per-member amount is in the projection. The worked example the frontend spec calls a
  walkthrough is **authored sample data** — the backend was not asked to supply a real member's row
  and does not.
- **The caller's own lines are the one exception.** A member may always see their own, on any
  surface, reached only through their own `project_member` rows.

**What was built:**

- **`GET /governance/summary`**, root-mounted as a second named export from
  `compensation.routes.ts`: per-project period counts by status, aggregate committed funding, and
  the caller's own open lines. Read-only. **No `/finalize`, `/countersign`, `/payments` or
  `/export`** — those are actor-scoped and stay where the actor's role is already resolved.
- **`attachOptionalUser`, not `requireAuth`**, because the page states the copy rules publicly and
  must render signed out. A visitor gets aggregates and disclosures with an empty `callerOpenLines`.
- **Funding was already served.** `GET /funding/deals` is root-mounted and shipped (§11g) and covers
  the commitments overview. Raised totals are sums of **committed** pledges and the field names say
  so.
- **The three copy rules ship with the payload**, as `disclosureKeys` — **keys, not English
  sentences**, for the reason §4d gives about `earnedAsLabel`: server prose forces three native
  clients to render un-localizable strings. `GROSS_ONLY_NOTICE` travels beside them. No field on
  this page implies a rail, a hold, a charge or a fee.
- **`investor-confidence` is `null` when never computed** (§11g). The aggregate skips those projects
  rather than coercing a missing signal to `0`.

### B4. `/go-to-market` — the new domain, built end to end

Nothing existed: no table, no route, no migration, no §11 subsection. All four pieces shipped, in
dependency order, under **[§11i](#11i-go-to-market-6-family)** and migration 0020.

**1. The supplier / ODM directory.** Four tables under §6's discovery family, because it is the same
kind of thing — a curated, filterable catalogue over a controlled vocabulary:

| Table                         | Purpose                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| `supplier`                    | Name, slug, region FK to `discovery_region`, verification state, contact policy        |
| `supplier_capability`         | The capability taxonomy — `discovery_skill`'s shape exactly, seeded, never free-texted |
| `supplier_capability_link`    | The join — `talent_profile_skill`'s shape exactly                                      |
| `project_supplier_engagement` | Which project engaged which supplier, for the launch-ready rail's provenance           |

Every field is §4b wire format from the start — `leadTimeDays`, `minimumOrderQuantity` — so §15 never
has to touch this domain. **There is deliberately no `…InCents` column**: §4b derives currency from
the project and a supplier belongs to none, so a directory-level price would have to invent one. A
quote belongs to an engagement, priced in that project's currency. The four new enums
(`supplier_verification_state`, `supplier_capability_kind`, `supplier_contact_policy`,
`project_supplier_engagement_status`) are `snake_case` and documented in §4d; they are **declared
beside their tables** in `schema.ts`, which is where every other single-domain enum sits.

**A public directory is a spam surface, so the write side was decided before the route existed.**
Platform `moderator` only — the §4a role §11b's `/discovery/admin/*` rows use — with
`requirePlatformCapability(…, "moderate_taxonomy")` running **before any id is read**, so the `403`
is not an id oracle. **No user-submission path and no `pending` state were built.** The appendix
suggested mirroring `discovery/categories`; its own next sentence gives the reason not to, and that
argument won: a self-serve, immediately-public listing needs a moderation queue, a rate limiter and
an abuse story, and none of that is worth building before the first real supplier exists. `isActive`
is retirement, not moderation, exactly as on `discovery_skill`.

**2. Launch readiness is derived, not stored — no table, no fourth state.** Six items over
`met` / `not_met` / `waived`, computed from `research_project.stage`, `project_stats`
(`verifiedEffortMinutesTotal`, `allocatedEquityBasisPoints`), the §9.11 bake event, the project's
engagements, and whether an active listing exists. `NULL` reads as `not_met`, never as `0`.

> **The shape was authored here, not inherited.** This appendix said §9.11 "already established" it.
> §9.11 does not mention a checklist, `met`, `not_met` or `waived`, and neither does any file in
> `src/` — `pie-bake.service.ts` implements three sequential gates returning a typed error union
> instead. So `launch-readiness.service.ts` introduces the tri-state, honouring the instruction that
> actually mattered: **three states, not four.** `waived` is representable and **currently
> unreachable** — no waiver table, no endpoint that grants one. It stays in the union because a
> waiver is a recorded decision by a named person, not a fourth flavour of `met`.

**3. The missing relation is closed.** `product` (`schema.ts`) carried exactly one FK,
`sellerId → user`, so "this project shipped this listing" was not expressible at all — the
launch-ready rail could not show what a project launched and the readiness checklist could not tell
whether a listing existed. `product.researchProjectId` is now a nullable FK with
`onDelete: "restrict"`, per the R1 rule.

**It crosses a document boundary, so it has an owner**: the column is documented in
[STORE_BACKEND_STRUCTURE.md](STORE_BACKEND_STRUCTURE.md) §4, where `product` actually lives. This
appendix originally assigned it to the studio doc, which owns `video`. No second product concept was
forked inside R&D.

**4. Listing creation is not an R&D endpoint**, and was not built as one. The CTA links to
`/studio/products` and the studio's existing create flow does the work. R&D contributes the FK and
nothing else — the "proxy a product create through a research route for convenience" version was
resisted, because it duplicates validation, pricing and ownership checks the studio already owns and
re-validates.

### Cross-cutting, all four

- **§11 gained rows and two subsections.** B1's `/discovery/skills` row is in §11b. B2 and B3 are in
  the new **§11h** (cross-project reads). B4 has **§11i, Go-to-market (§6-family)**, plus rows in
  §11's status table and four new mounts in the `src/app.ts` block — three root-mounted like
  `researchCatalogRouter`, and `projectGoToMarketRouter` as the sixth router on `/research-projects`.
- **§16 build order.** These sit **after** the two compliance items (dispute/override UI and the
  integration-consent screen), which remain the only things between the shipped backend and a lawful
  EU deployment. As placed: B1 was a projection widening, B2 and B3 folded into the existing §8 and
  §7A phases, and B4 became **phase 5a**, beside §5 (Discovery) — independent and blocking nothing.
- **Zero-trust held unchanged (§0, §13).** Not one of these routes takes a number from a client.
  Membership on `/build-log` is a subquery over `project_member`; readiness on `/go-to-market` is
  computed from stored signals; the governance aggregate is computed from finalized periods; a
  supplier's `verificationState` is absent from the create schema entirely. A filter chip is a query
  param, never a control — and `404`, not `403`, remains the not-authorized answer everywhere
  (§11), so a stranger cannot probe which projects exist by watching a feed shrink. The one `403` is
  the platform-capability refusal, which names a capability and no resource and is decided before
  any id is read.
- **Keyset pagination and server-side filtering** apply to all four lists (§6, §13). `/daily-logs`
  is keyset; the three catalogue reads are offset with an `ORDER BY` ending in a unique column. The
  frontend's client-side filtering over mock arrays survives in none of them.
