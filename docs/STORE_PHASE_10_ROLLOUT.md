# Store Phase 10 Rollout — The Public Voice

Review reads and depth, product Q&A, engagement counters, content reports and
moderation, and pre-sales product inquiries. Appendix A8, A9, A11, A12, A14.

**Status:** Shipped through additive migrations `0064`–`0068`.

This phase does **not** add A10 product comments (the appendix requires a product
decision first), A13 seller-profile depth, ranking, recommendations, or anything §14
still blocks.

---

## The absurdity this phase closes

`POST /commerce/completions/:completionId/reviews` was the **only** review route in the
codebase. A buyer could write a verified review and nothing could ever display it —
only the `averageRating` and `reviewCount` aggregates surfaced anywhere.

Reviews are now readable, with media, named sub-scores, helpful votes and a seller
reply.

---

## A correction to the specification

**Appendix A12 says commerce reports feed "the existing `content_review_action`
queue". They cannot.** `content_review_action.video_id` is `NOT NULL` with a cascade to
`video`, so a commerce target has nowhere to go. Generalizing that table would also
merge two queues gated by **different** platform capabilities — `moderate_content` and
`moderate_commerce` — into one, which is precisely the coupling capabilities exist to
prevent. R&D hit this first and built `research_program_moderation_action`; this phase
follows that precedent with `commerce_moderation_action`.

Two smaller corrections found on the way in:

- **Migrations are hand-written since `0046`.** `drizzle/meta/` holds snapshots only to
  `0054`, so `drizzle-kit generate` emits garbage. Hand-write the `.sql` and hand-append
  to `_journal.json`.
- **`commerce-trust.routes.ts`, `commerce-payments.routes.ts` and
  `commerce-merchandising.routes.ts` were missing from `MOUNTED_ROUTERS`** in
  `rate-limit-coverage.test.ts`, so every mutating route they own passed the coverage
  assertion without being looked at — the whole trust surface included. Now listed.
  (They all turned out to have limiters already; the gap was in the check, not the
  code.)

---

## What ships

### A8 — reviews become readable

- `commerce_review` gains `helpful_count` and `media_count`, plus five **partial**
  keyset indexes on `visibility = 'visible'`
- `commerce_review_media` (photos to Cloudinary under `qatoto/reviews`, video as an
  11-character YouTube id), `commerce_review_score`, `commerce_review_vote`,
  `commerce_review_reply`
- `GET /store/products/:productSlug/reviews` and
  `GET /store/organizations/:organizationSlug/reviews` — four sorts, a rating filter, a
  `hasMedia` filter, cursor-paginated
- Write routes for media, votes and the reply on `/commerce/reviews/:reviewId/*`
- Sub-scores ride `CreateReviewSchema`; they get no route of their own

### A9 — product Q&A

- `commerce_product_question` (no organization column) and `commerce_product_answer`
  (`seller | verified_buyer`, derived, never sent)
- `GET /store/products/:productSlug/questions` with a seller-first single-answer
  preview, and a separate paginated answer list
- Ask / answer / retract on `/commerce`, all user-scoped idempotency

### A11 — engagement counters

- `commerce_product_engagement` (user-scoped), `commerce_product_share`,
  `commerce_product_stats`
- `PUT`/`DELETE /store/products/:productSlug/{save,bookmark}` and `POST .../share`
- `engagement` block on the product detail read

### A12 — reports and moderation

- `commerce_content_report` (XOR targets) and `commerce_moderation_action`
- `POST /commerce/reports`, plus four `/commerce/admin/*` routes

### A14 — pre-sales inquiries

- `commerce_product_inquiry`, and `product_inquiry` on
  `commerce_thread_resource_kind`
- `POST /commerce/products/:productId/inquiries`, `GET /commerce/inquiries`
- `contactAffordance` on the product detail read
- optional `sourceInquiryId` on `POST /commerce/rfqs`

---

## Decisions worth knowing before reading the code

### Saves are user-scoped, and the reason is `tradeState`

The plan said organization-scoped. `commerce_organization.trade_state` defaults to
`pending` and only a staff `verification_decided` action makes it `active`, so an
org-keyed bookmark puts a single tap behind human verification. It would also flicker
for a user in several organizations and let any `viewer`-role colleague empty the
team's list.

The real B2B need — a shared sourcing shortlist — is a **named, owned, permissioned**
object with its own audit trail. Delivering it accidentally, as an unnamed org-wide bag
anyone can empty, would be worse than not delivering it. Recorded as future work.

### A14 keys the thread on an inquiry, not a product

Adding `product` to `commerce_thread_resource_kind` and pointing the thread at the
product id collides with `commerce_thread_resource_uidx` and produces **one thread per
product across all buyers**. `assertThreadParticipant` would then admit every buyer
organization that ever inquired and hand each of them every other buyer's negotiation.
That is a cross-tenant leak against §11, not a UX wart.

The inquiry row keeps that index correct unmodified, leaves `commerce_message`
untouched, and gives the seller a real inbox. It also removes a migration hazard rather
than negotiating with one: keying on the product needed partial-index predicates naming
a newly `ADD VALUE`'d enum literal, and an enum→text cast is not `IMMUTABLE`, so
Postgres rejects it in an index predicate — which would have forced two `db:migrate`
runs across two releases.

**Conversion is a pointer, never a merge.** An RFQ thread contains every invited
provider, so folding a one-to-one pre-sales chat into it would show one seller's
conversation to its competitors.

### The organization gate on chat, and why A9 shipped first

"Chat now" requires an active buyer organization, because §4.11 derives thread
participants from organization memberships and every looser alternative meant nullable
authorship on `commerce_message` — a shipped table with a shipped wire contract.

The buyer who cannot clear that bar is not dead-ended: A9's question route accepts any
identified user, and the product detail read now states which control to render via
`contactAffordance: "chat" | "ask_question" | "sign_in"`. That is a fact about the
caller, which the caller already knows, so stating it leaks nothing.

### Post-moderation needed a griefing answer

Only **user-authored** content auto-hides — review, question, answer — and only at
**three distinct open reporters**, counted in the same transaction as the report insert.
A product or an organization never auto-hides: delisting a seller's listing is a
commercial action against their livelihood and takes a human.

**Dismissing restores an auto-hide.** Forgetting that would mean three griefers
permanently silence content a moderator just declared fine.

### `action_source` exists because the hash chain has a NOT NULL

`platform_audit_entry.actor_user_id` is `NOT NULL` because every entry must name an
accountable human. An automatic threshold hide names nobody. Rather than weaken that
invariant, such an action is recorded in `commerce_moderation_action` with
`action_source = 'automatic'`, no moderator and no audit entry, bound by a check in
both directions.

### Counters are columns, and two different kinds of them

`helpful_count` and `media_count` are **deltas** moved in the same transaction as the
row that caused them, only when a row actually appeared — `onConflictDoNothing()
.returning()`, the `setVideoSave` shape. They are columns rather than `count(*)`
because both are ordering/filtering inputs: a keyset cursor needs its sort key stored
and indexed, and `media_count > 0` is sargable in a partial-index predicate where
`EXISTS` is not.

`question_count` and `answered_question_count` are **recomputed**, not incremented,
because `answered_question_count` counts questions with at least one visible answer —
a second answer to an already-answered question must not move it.

### The trigger narrowing

`commerce_review_relationship_guard` was `BEFORE INSERT OR UPDATE` with no column list,
so every update re-ran two point lookups re-validating structurally immutable linkage.
Narrowed to `UPDATE OF` its five identity columns. The function body is unchanged.

The verifier asserts `pg_trigger.tgattr` has five entries — a name-only check would
pass whether the trigger is narrowed, whole-row, or dropped and recreated wrongly.

---

## Preconditions

- `0063` applied (Phase 0 contract).
- Cloudinary configured. Review photo upload returns `503 NOT_CONFIGURED` without it;
  every other route in this phase works regardless.
- No new environment variables.

---

## Deploy order

1. `pnpm db:migrate` — applies `0064`–`0068` in one transaction.
   `0064` is enum-only. **No `ADD VALUE` in it is referenced by DDL in `0065`–`0068`**,
   which is what makes the single transaction safe; the new values appear only in
   runtime inserts.
2. `pnpm db:verify-store-phase-10-constraints` — 22 checks, all must pass.
3. Deploy the API.
4. No worker changes. This phase adds no jobs and no queues.

---

## Rollback

Dropping the twelve tables, the two `commerce_review` columns and the three new
triggers is clean — nothing outside this phase references them — and
`commerce_review_relationship_guard` can be restored to whole-row.

`ALTER TYPE ... ADD VALUE` is **not reversible**. Rollback means disabling routes, not
dropping enum values. Same posture as `0059`.

---

## Invariants to re-check after deploy

The verifier covers all of these; this is what it is checking and why.

- Review, engagement and question counters agree with their rows.
- Every product has a `commerce_product_stats` row — a missing one makes the counter
  `UPDATE` affect zero rows and lose the count with no error.
- `commerce_review_relationship_guard` is column-scoped to five columns.
- No review party has voted on its own review; no reply comes from anyone but the
  reviewed organization.
- Review media positions are contiguous from zero.
- Every seller answer comes from the organization that owns the product; every
  verified-buyer answer cites a completion for that product and that organization.
  Neither is expressible as a foreign key.
- Every report points at exactly one target; every moderation action's `action_source`
  agrees with its three attribution columns.
- Every inquiry has its thread, and no inquiry thread points at a missing inquiry —
  `commerce_thread.resource_id` has no foreign key, so this is the only thing standing
  between it and a dangling pointer.
- **`commerce_thread_resource_uidx` still exists unmodified.** Not a Phase 10 index;
  the regression guard against someone reopening the A14 leak.

---

## Explicit non-claims

- **Review video is a YouTube link, not an upload.** There is no first-party video
  ingest in this codebase and this phase did not add one. The `youtube_video` media kind
  stores an 11-character id verified by the existing oEmbed job.
- **`onTimeShipmentRate` is still hardcoded `null`.** It needs a promised-delivery
  timestamp, which is A13, which is not in this phase.
- **`commentCount` is absent from the engagement projection**, deliberately. A10 has no
  table, and a hardcoded zero is exactly the A13 failure mode: a field the frontend
  renders that can never be non-null, which looks wired.
- **Organization visibility is recorded by moderation but not written by it.** That
  column belongs to `commerce-organizations.service`; two services owning one column is
  how its transition rules stop being true.
- No ranking, no recommendation selection, no trending. §12 still defers those.

---

## Known debt this phase did not take on

`CreateDraftRfqInput` in `commerce-rfqs.service.ts` is a **hand-written interface
duplicating `CreateDraftRfqSchema`**, which CLAUDE.md §3.1 forbids ("Input types come
from `z.infer`, not hand-written duplicates"). It predates this phase. `sourceInquiryId`
had to be added in both places as a result. Worth a focused change; not one to fold into
a feature phase.
