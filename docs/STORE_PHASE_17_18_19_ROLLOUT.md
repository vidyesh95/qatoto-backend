# STORE_PHASE_17_18_19_ROLLOUT.md — the manufacturer directory, the business forum, the cofounder directory

> Migrations `0099`–`0105`. Closes Appendix A32, A33 and A34 — **the last three buildable entries in
> the register**. What remains open there is deliberate: A10 pending a product decision, A20 and the
> capital half of A34 blocked on §14, A26 deferred.
>
> Read alongside [STORE_BACKEND_STRUCTURE.md](STORE_BACKEND_STRUCTURE.md) §16, §17 and §18, which are
> the specification these were built against.

---

## 0. The four decisions taken before any code

Each of these was open in the spec, and each changes what got built rather than how.

| # | Question | Decision |
| - | -------- | -------- |
| 1 | §14 blocks the cofounder directory on publishing capital ranges | **Build everything else; store no capital figure at all.** The columns do not exist. Both wire fields serve `null`. |
| 2 | §16.2: `site_audited` has no record behind it | **Build `commerce_organization_site_audit`** rather than drop the state from the wire. |
| 3 | §16.3: is `exportMarkets` declared or derived? | **Derived** — distinct delivery-address countries over completed orders. No column, nothing seller-editable. |
| 4 | §1.1 mounts community writes at `/community`; the frontend calls `/commerce` | **`/community`**, per the doc. The frontend edits two path strings. |

---

## 1. Migrations

| File | What it does |
| ---- | ------------ |
| `0099_store_phase_17_enums.sql` | Widens `commerce_organization_capability_kind` by four; adds `manufacturing_inquiry` to the thread resource kind; adds the certification standard-code, site-audit-state and inquiry-state types; adds ten audit event kinds across two chains. |
| `0100_store_phase_17_factory_directory.sql` | `standard_code` on the certification; `commerce_organization_production_line`; `commerce_organization_site`; `commerce_organization_site_audit` + its site link table; nine columns on `commerce_seller_profile`. |
| `0101_store_phase_17_manufacturing_inquiry.sql` | `commerce_manufacturing_inquiry` + its required-certification link table. |
| `0102_community_forum_enums.sql` | Seven community types; seven platform audit event kinds. |
| `0103_community_forum.sql` | `community_forum_thread`, `_reply`, `_reply_vote`, `community_content_report`, `community_moderation_action`. |
| `0104_community_cofounder_enums.sql` | Five cofounder types; two platform audit kinds; two more community moderation action kinds. |
| `0105_community_cofounder.sql` | `community_cofounder_profile` + three tag tables + prior ventures; `cofounder_profile_id` on the moderation log. |

**Enum-only files exist for the usual reason.** `drizzle-kit migrate` runs the whole pending set in
one transaction, and a value added by `ALTER TYPE … ADD VALUE` cannot be used as a literal inside it.
`0099`, `0102` and `0104` therefore carry the additions that later files name.

**Rollback.** Every migration is additive: new tables, new nullable columns, new enum members, two
`NOT NULL DEFAULT` columns on an existing table. Nothing is dropped and nothing is backfilled, so a
rollback is `DROP TABLE` on the eleven new tables plus `ALTER TABLE … DROP COLUMN` on the eleven new
columns. **Enum members cannot be removed without the rename-and-recreate dance** (see `0090` for the
shape); leaving them in place is harmless — an unused label costs nothing and nothing reads it.

---

## 2. Verification

```
pnpm run db:verify-store-phase-17-constraints   # 21 checks
pnpm run db:verify-store-phase-18-constraints   # 16 checks
pnpm run db:verify-store-phase-19-constraints   # 14 checks
pnpm run db:smoke-store-phases-17-19            # 71 checks, over HTTP
pnpm typecheck && pnpm lint && pnpm test        # 1833 tests
```

**The smoke drives the whole lifecycle over HTTP against a running server**, including the
moderation path as a real `moderator`: a thread queued → published → replied to → endorsed →
answer accepted → locked, and a cofounder profile drafted → submitted → published → withdrawn.
It is re-runnable — `resetPreviousRun` clears what the last run left, because a cofounder profile
is unique per person and the second create is otherwise a legitimate 409 that cascades.

All three verifiers pass against a live database, and each one **probes the CHECK constraints by
attempting the illegal write and rolling back**, because presence in `pg_constraint` says nothing
about the body. Between them they assert:

- the widened capability enum did not lose Phase 12's four original values;
- a production line cannot be stored without a unit label, and a site audit cannot be stored without
  an audit entry;
- the seller profile refuses half a MOQ pair, an inverted lead-time range, and a sample fee on a
  profile that offers no samples;
- `sample_fee_in_cents` is **nullable**, because unstated is not free;
- the forum vote is keyed on the user, there is no downvote column anywhere, and there is no stored
  `excerpt`;
- a thread cannot be `open` while carrying an accepted reply, nor `pending_review` while claiming a
  publish date;
- **the cofounder profile has no capital or equity column** — this is the first check in the Phase 19
  file, and it is the one that matters most.

---

## 3. What the frontend still has to do

None of it is blocking; all four are small.

1. `forum.api.ts` and `cofounders.api.ts`: `/commerce/*` → `/community/*` on the write paths.
2. All three `*.api.ts`: drop the mock transport. The response shapes parse through the shipped
   schemas unchanged.
3. `cofounder-profile-composer.tsx`: **remove the capital range and equity expectation fields.** The
   create schema is `.strict()` and answers 422 for them — deliberately, because silently discarding
   a figure somebody typed about themselves would let them believe it was recorded.
4. Optional: adopt `otherCertifications[]` on the factory detail read. `.strip()` discards it until
   then, so nothing breaks either way.

---

## 4. Three things a later reader will want to undo, and should not

**`pending_review` on a new forum thread.** A10 closed public product comments because a comment
would be the only public text surface with no purchase proof and no standing requirement behind it.
A forum inherits that exactly; moderation is what lets it exist without reopening the decision. A
forum usually publishes immediately — this one has a documented reason not to (§17.1).

**The missing capital columns.** They are not an oversight and not a TODO. §14's wording is the
instruction: until the decision lands, the backend stores no capital figure it would then have to
publish. A stored figure withheld by a projection is one careless edit from being published.

**`deriveVerificationState`'s ordering.** `site_audited` comes only from a recorded site audit, and
`documents_reviewed` only from an approved verification. Deriving the first from the second would let
a paper review carry the weight of somebody standing in the building — the precise collapse the
three-state enum exists to prevent (§16.2).

---

## 5. Three defects found and fixed on the way through

None was part of the scope; all three are the kind of thing this work surfaces.

**Four routers were mounted in `app.ts` and missing from `rate-limit-coverage.test.ts`'s
`MOUNTED_ROUTERS` table** — the trade attachments, the taxonomy admin, the ranking routes and the
seller-profile depth. Every mutating route they own was passing the coverage assertion without ever
being looked at, which is the exact failure mode that file's own header predicts and which its Phase
10 note already records happening once. All four are now listed; all four turned out to be covered.

**The forum's reject path would have cycled forever.** A rejected thread stays `pending_review` so it
stays out of every public read while remaining readable on `/mine` with its reason — but the queue's
first draft filtered on state alone, which would have returned every rejection to the queue on the
next tick. The predicate is now `state = 'pending_review' AND moderated_at IS NULL`.

**A draft inquiry leaked its existence to the factory through a 409.** `answerManufacturingInquiry`
refused a `draft` with `INVALID_STATE` where its sibling reads refuse it with `NOT_FOUND`, so a
factory could learn that a buyer was drafting an inquiry to it — precisely the fact the draft state
exists to withhold. Found by the smoke, which asserted 404 and got 409. Fixed to match
`loadInquiryForParty` and `closeManufacturingInquiry`, both of which already drew the line correctly.
