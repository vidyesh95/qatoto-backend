# BLUEPRINTS_BACKEND_STRUCTURE.md — the `/blueprints` surface

> **This document owns the whole `/blueprints` surface.** It was extracted from a 74-line banner at
> the top of [HOME_BACKEND_STRUCTURE.md](HOME_BACKEND_STRUCTURE.md), which is a feed-ranking contract
> and never mentioned blueprints again after line 74. The blueprints surface has no ranking, so it
> was living in the wrong document.

**Read alongside:** [CLAUDE.md](../CLAUDE.md) (the zero-trust invariant and the naming rules),
[HOME_BACKEND_STRUCTURE.md](HOME_BACKEND_STRUCTURE.md) (the feed this module is mounted beside),
[STUDIO_BACKEND_STRUCTURE.md](STUDIO_BACKEND_STRUCTURE.md) (the creator surface that owns video).

---

## 0. What this module is, and what it used to be

⚠️ **THE ANIME VERTICAL WAS RETIRED; the `/anime` router is now `/blueprints`.** The module moved to
`src/modules/home/blueprints/` and mounts at `/blueprints`. Its two public series reads were DELETED
and only the hero carousel survived.

**Nothing in the database changed.** `anime_series`, `anime_season`, `anime_episode`,
`anime_hero_slide`, the `anime_audio_mode` / `anime_series_status` pgEnums, the `anime_episode` value
in `video_type` and the five `anime_hero_slide_*` audit labels all keep their names, because renaming
any of them costs a migration and buys a tidier grep. The studio's own `/series` routes and its admin
review queue are untouched. Read every `/anime` name in the schema as historical.

---

## 1. The four arms

| Arm | Public reads | Author writes | Staff moderation | Where the rows come from |
| --- | --- | --- | --- | --- |
| Hero carousel | 1 | — | 6 | `pnpm db:seed-blueprint-hero-slides` re-points four seeded rows |
| Showcase launches | 3 | 3 | 2 | authored |
| Case studies | 4 | 2 | 2 | authored + `pnpm db:seed-blueprint-case-studies` (10) |
| Teardowns | 5 | 2 | 2 | authored + `pnpm db:seed-blueprint-teardowns` (12) |

Every route is declared in one file, `src/modules/home/blueprints/blueprints.routes.ts`, mounted at
`/blueprints` in `src/app.ts`.

**The public reads are BARE** — no `requireAuth`, no `attachOptionalUser`, no limiter. The payload is
identical for every visitor, so there is nothing to personalise, and an IP-keyed limiter on a page's
opening element is a self-inflicted outage behind a CDN or a corporate NAT.

**Staff routes check capability INSIDE the controller, never as middleware.** Middleware cannot
return a `Result`, so it cannot join a controller's exhaustive error switch — and the check has to
run before any id is read or the route becomes an id oracle. `requirePlatformCapability` is the one
helper; `moderate_content` gates the three review queues and `manage_promotions` gates the hero.

---

## 2. Teardowns: two visibility gates, and they are not the same predicate

⚠️ **LIST** (`published`, `flagged`) decides where a teardown may APPEAR: the index, the tag facets,
the launch composer's select. **READABLE** adds `quarantined` and decides where it may be REACHED:
the detail page, the prerender slug list, and `/:teardownSlug/claim-targets`.

**A quarantine withholds a publisher's files; it does not delete the address.** Merging the two
predicates — which they invite, differing by one label — produces either a teardown advertised while
under an unresolved rights claim, or a live URL that 404s.

The withholding is SERVER-SIDE. It used to live in a React component, where the disputed files were
already on the wire; that is not a control at all (CLAUDE.md §1.1), and the component had also missed
`repairabilityIndex`. `claim-targets` exists so that moving it did not break the rights-claim flow: it
serves ids and titles with no column that could hold a URL, so a second rights holder can still name
the specific file they mean.

`withheldPayload()` in `teardown-public-read.service.ts` is the one list of what a quarantine takes,
and **`partsList` is in it**. A listing carries no file, so the "it withholds files" shorthand does
not decide it — but what a rights claim disputes is the SURVEY, and a parts list is the survey's
findings about somebody else's product in the plainest form it takes. Withholding the composition
table while publishing the parts it describes would be a distinction nobody could defend.

The case-study arm has **one** gate (`published`, `flagged`) and copying the teardown shape there
would be the more expensive mistake: a case study has no files, and a report moves a published row to
`flagged`, full stop. What that arm withholds instead is one FIELD, by a per-row flag — see §6.

---

## 3. The teardown write path

The authoring wizard at `/blueprints/teardowns/new` shipped mock-backed. Its own transport file said
so: *"there is no `blueprint` table on the Express backend and no submission route to POST to, so
nothing here persists and nothing here pretends to."* This is the backend that replaces that comment.

```
POST /blueprints/teardowns                                    → 202 { submissionId, moderationState, receivedAt }
GET  /blueprints/teardowns/mine                               → a flat array, every state
GET  /blueprints/admin/teardowns/review-queue                 → moderate_content, oldest first
POST /blueprints/admin/teardowns/:submissionId/moderate       → publish or send back
```

### 3.1 A submission is not a teardown in waiting

⚠️ **`teardown_submission` IS A DIFFERENT DOMAIN OBJECT, AND THAT IS THE WHOLE DESIGN.**

`teardown` is a table made of CHECKs — its own header says the six inlined blocks exist so an illegal
state cannot be represented. The wizard cannot fill it. It collects no `thumbnail_url` and no
`difficulty`, both NOT NULL there and both **required non-null by the frontend's read schema**, so a
relaxed `teardown` row would not be a draft; it would be a detail page that fails to parse — the same
failure the schema invokes to justify pinning the walkthrough source to `youtube`.

Admitting a half-answered row would also mean adding `moderation_state = 'draft' OR (…)` to nine
all-or-none CHECKs, in the one file that documents how a CHECK passing on NULL accepted five of six
telemetry figures (migration 0172).

So the paperwork gets its own table and `teardown` is untouched by the authoring path. All 65
pre-existing assertions in `db:verify-teardown-constraints` still pass **unedited**, including the two
that prove `draft` and `removed` are refused — which is the tell that the design agrees with the file
rather than editing it into agreement.

The frontend had already described this table in its own words: the receipt *"carries no slug and no
public URL, deliberately… its public address is a thing a moderator creates by publishing it."*

### 3.2 Hybrid storage: five promoted columns, one TEXT document

Everything the wizard sends that no query needs lives in `document_json`. Promoted out of it:
`title`, `subject_product_name` (plus a generated normalised twin), `moderation_state`,
`moderator_note`, and the `published_teardown_id` join.

The promoted set is exactly what is QUERIED, and the payoff is that **`GET /mine` parses zero
documents** — every field the frontend wants is a column or the join. The document is read twice in a
submission's life: once per queue row, once at publish.

- **TEXT, not jsonb**, for the reason `platform_audit_entry.payload_json` gives: jsonb reorders keys,
  coerces numbers to `numeric`, and reads back as `unknown` — forcing either a banned `as` or a parse,
  and we parse anyway.
- **`document_schema_version` travels beside it.** A submission written in March is read by a publish
  in June. The reader's `unparseable` arm handles the failure; the version decides WHICH schema to
  try. Free now, impossible to add later.
- **The reader has two arms, and `unparseable` is a real one.** A submission whose document no longer
  parses must still render in the queue so a moderator can see it and send it back with a reason; a
  throw would take down the page and hide every other submission on it.
- **`published_teardown_id` is `ON DELETE set null`, not cascade.** The paperwork must outlive the
  teardown it produced. Combined with the decision CHECK, hard-deleting a published teardown raises
  23514 rather than silently orphaning the record. ⚠️ **Erasure must therefore delete the submission
  BEFORE the teardown**, which `anonymize-account.service.ts` orders explicitly.

### 3.3 What the publish writes, and what it deliberately does not

| Table | Written | Why |
| --- | --- | --- |
| `teardown` | ✅ | The public row, under the first free slug |
| `teardown_stats` | ✅ zeros | Unlike the showcase, which mints none — an authored row must be shape-identical to a seeded one |
| `teardown_part_listing` | ✅ | The author's parts, as a contents page |
| `teardown_document` | ✅ | Files whose `kind` is a reader's label |
| `teardown_manufacturing_file` | ✅ | Files whose `kind` is a fab's label |
| `teardown_material` (+ elements) | ✅ | `assembly_id` and `part_id` both NULL, which the pairing CHECK reads as legal |
| `teardown_assembly`, `teardown_part`, `teardown_assembly_step`, `teardown_fastener` | ❌ | The wizard collects no geometry |

⚠️ **`teardown_part_listing` IS NOT `teardown_part`, and the frontend draws the same line** — its
parts step is headed "THE PARTS LIST — AND DELIBERATELY NOT AN ASSEMBLY" while `teardown_assembly` is
"The 3D view of one teardown". One is a contents page, the other is a viewer.

Forcing a `{label, material}` part through `teardown_part` would have cost **eight** sites: an
`ALTER TYPE` whose CHECK rewrites cannot ship in the same migration, third arms on two CHECKs,
`manufacturing_method` losing NOT NULL (a regression on the modelled surface rather than an addition),
a third arm on `AssemblySchema` that breaks the seed's `"model" in part` test, the `never` in
`buildAssembly`, a third arm in the frontend's viewer, and `?media=assembly` quietly answering with
teardowns that have no 3D view — that filter is a bare `EXISTS` over `teardown_assembly`.

Three values the publish refuses to invent:

- **`part_count` stays NULL.** It is the author's own tally, and the schema is explicit that it is
  unrelated to how many parts a listing carries — *"148 is not nine and must not become nine."*
- **`byte_size` stays NULL** on both file tables. The wire carries a pasted link and no size; the
  alternatives were a network HEAD inside the publish transaction or a moderator typing a number about
  a file they never opened. NULL says "unmeasured"; either of those would have said something false.
- **The walkthrough poster is REBUILT from the video id**, never stored as the client sent it. The
  client derives it, so storing that string would let an author point an `<img>` rendered under this
  site's chrome at any host.

**`created_at` on the published teardown is the DECISION time, not the submit time.**
`teardown_public_newest_idx` orders by `created_at DESC`, so a submission that waited three weeks in
the queue would otherwise publish already buried. "Newest" means newest READABLE, which is the honest
reading for a surface where nothing is readable until somebody decides it is.

### 3.4 The two fields a moderator supplies, and the line they are on

Publishing carries `thumbnailUrl` and `difficulty`, which the author never sent.

The line: those two are **editorial judgements about the write-up**, formed by reading it — the same
kind of decision as the public slug every other blueprint arm already asks a moderator to mint. A
part's `manufacturingMethod`, a node name or a `.glb` are **facts about the physical unit**, and a
moderator who never held it would be fabricating them. This surface asks for the first two and will
never ask for the others.

### 3.5 `documents[].kind` — a frontend bug the backend absorbed, and why the tolerance stays

The wizard **used to** serve `documents[]` and `manufacturingFiles[]` from ONE schema whose `kind` was
the manufacturing-file enum, defaulting both lists to `"step"`. `teardown_document.kind` is
`schematic | bill_of_materials | assembly_guide | datasheet` — **zero shared labels** — so every
`documents[]` row arrived carrying a label that column cannot store.

Three ways out, and why the third won:

1. **422 the whole array** until the frontend split its schema — which breaks a wizard step that was
   shipping at the time.
2. **Translate `step` → `datasheet`** — the platform deciding what somebody's file is, unrecoverably,
   at write time.
3. **Accept both vocabularies and route each file by its OWN label at publish.** The author's word
   survives intact, it worked with no frontend release, and it kept working when that release landed.

⚠️ **THE FRONTEND HAS SINCE BEEN SPLIT, AND NO BACKFILL WAS EVER NEEDED.** An audit found
`teardown_submission` empty — no submission carrying the mixed shape was ever stored — and every
seeded row in `teardown_document` and `teardown_manufacturing_file` correctly labelled. The prose
here used to end "reversible by one backfill"; there was nothing to reverse.

**The tolerance stays anyway, and not out of inertia.** A browser holding a cached pre-fix bundle
still posts the old shape, and this is a zero-trust boundary: filing an honest label correctly is a
better answer than a 422 its author cannot act on. What the decision costs is one branch in
`copySubmissionIntoTeardown` and one rule — **the two enums must stay disjoint**, because routing by
label is unambiguous only while no value appears in both. `teardown-submission.schemas.test.ts`
asserts it over both lists, so a new value in either is covered the day it is added.

### 3.6 Two oracle rules

⚠️ **The duplicate-unit 409 names the clashing survey's title ONLY when that row is already public,
or is the caller's own.** The frontend's contract asks for the title, and it is useful precisely
because the author can go and read it — but a title taken from somebody else's `pending_review`
submission would let a stranger enumerate unpublished work by guessing product names. When the clash
is a stranger's pending row, the refusal still happens, still says why, and names nothing.

⚠️ **`moderate_content` is resolved BEFORE `req.params` is read and before the body is parsed.**
Reversed, a 403 that only arrives for submissions that exist is an existence oracle over other
people's unpublished surveys. `blueprints.routes.teardown-moderation.test.ts` proves the ordering by
sending a non-moderator a request that is ALSO malformed and requiring **403, not 422**.

### 3.7 What does not exist yet, deliberately

- **No drafts.** The wizard parses its whole draft once at submit and keeps its state in React; there
  is no draft id, no autosave and no resume-later on either side.
- **No uploads.** Documents and manufacturing files are pasted `https://` links. The wizard has no
  file input anywhere, and says so to the author.
- **No edit-and-resubmit.** A rejection is terminal, which is why the note is mandatory on one: it is
  the author's entire remedy. The partial unique index deliberately excludes `rejected`, so a
  sent-back author may survey the same unit again as a fresh submission.
- ~~**No `flag` / `quarantine` / `restore` verb.**~~ **THESE LANDED — see §9.** They brought exactly
  the three audit labels this bullet predicted, in their own enum-only migration. The bullet is kept
  struck through rather than deleted because its reasoning is what kept a label from being added
  before its lever existed, and the same rule still governs the next one.
- **No rights-claim intake.** `claim-targets` serves a picker for a flow that prepares a `mailto:`
  notice on the frontend; nothing posts to Qatoto, by that flow's own explicit decision.

---

## 4. The author's own list

`GET /blueprints/teardowns/mine` is a **flat array**, hard-capped server-side at 200 rows, newest
first. `/showcases/mine` is the same shape; `/case-studies/mine` moved to a cursor page because a
writer accumulates case studies cheaply, and a teardown is a multi-hour instrumented survey with a
five-per-fifteen-minutes limiter in front of it. The frontend's query key carries no cursor.

⚠️ **The state comes from the TEARDOWN once one exists**, by a `COALESCE` over the join. A moderator
who flags or quarantines a published teardown changes the state of the teardown, not of the paperwork
that produced it — and this list must show that. One source of truth per lifecycle phase; the
alternative is a second state machine writing back into `teardown_submission`.

⚠️ **`publicSlug` is COMPUTED from the state, never projected raw.** The frontend renders a "View the
page" link whenever it is non-null, and its own schema only checks the `published ⇒ non-null`
direction — so handing back a slug for a flagged or quarantined row would render a live link to a page
that refuses the reader, with nothing failing anywhere to say so.

---

## 5. Privacy, audit, and the logger

- **`teardown.author_user_id` landed with its `anonymization-manifest.ts` entry in the same commit**,
  as the schema comment demanded. The FK is not redundant with the denormalised byline:
  `verify-anonymization-coverage` finds its candidates by walking foreign keys into `user(id)`, so a
  teardown reachable only through the submission would be invisible to it.
- **The byline is a SNAPSHOT taken at publish.** Renaming an account does not rename it.
- **Two populations share those columns.** The twelve seeded rows carry invented bylines and a NULL
  author; they survive every erasure. An authored row names an account and dies whole with it.
- **`teardown_submission.reviewed_by_user_id` is `retain`, and that is the only lawful disposition**:
  a `null_out` would clear the reviewer while `reviewed_at` stayed, tripping the decision CHECK and
  dead-lettering the scrub.
- **The audit payload is ids and flags only** — `{submissionId, teardownId, decision,
  hasModeratorNote}`. The chain is hash-linked and kept forever, and a submission's document carries
  one party's account of a private permission with a named manufacturer. The note the author reads
  lives on the submission row, where erasure can reach it.
- **Submitting records nothing.** It names no accountable staff human; the inclusion rule for that
  chain is staff action.
- ⚠️ **No database error from either write may reach the logger.** `DrizzleQueryError`'s message
  carries every bound parameter and `errorFields` copies it into `errorMessage`.
  `blueprint-write-errors.ts` re-throws with the SQLSTATE alone and **deliberately no `cause`**,
  because a logger that walks `cause` undoes it.

---

## 6. Case studies — the withheld company name

A first-hand writer may keep a company's name from READERS — an NDA is the ordinary reason — and a
moderator still sees it, because a company nobody at Qatoto can see is a claim nobody can check. A
query cannot express that, so ONE serializer does (`toPublicCompany`), and exactly one route in the
whole router serves the real name: `GET /blueprints/admin/case-studies/review-queue`.
`/case-studies/mine` carries no companies at all, so the name reaches one route rather than two.

**The guarantee is narrow, and saying so is part of it.** It nulls one column. The writer could still
have named the company in the summary, a step, a tag or a source's publisher label — the fixtures
contain exactly that shape — so the submit gate sweeps every reader-visible field for a withheld name,
and `case-study-withheld-name.test.ts` proves the other half by driving the real routes over a
sentinel and sweeping raw response bytes.

---

## 7. Verification

```bash
pnpm db:verify-teardown-constraints        # 94 assertions in one rolled-back transaction
pnpm db:verify-case-study-constraints      # 46
pnpm db:verify-showcase-launch-constraints # 91
pnpm db:verify-blueprint-hero-constraints  # 27
pnpm db:verify-blueprint-engagement-constraints # 33
pnpm db:reconcile-blueprint-stats          # counter drift; -- --fix repairs
pnpm db:smoke-teardown-authoring           # submit → duplicate refusal → publish → public read
pnpm db:smoke-case-study-authoring         # 16, and a byte sweep for the withheld company name
pnpm db:smoke-showcase-authoring           # 20, upload-before-submit and the stats tripwire
pnpm db:smoke-blueprint-hero               # 19, AVIF and the seeded site-relative arm
pnpm db:seed-blueprint-teardowns           # the import schema is unchanged by the write path
pnpm gate                                  # specifiers, typecheck ×3, fmt:check, lint, test
```

The constraint scripts exist because vitest mocks `#src/db/index.js` wholesale, so no test here can
prove anything about Postgres. The smoke script exists for the same reason one layer up: no test can
prove the publish TRANSACTION runs, only that the controller calls it.

**ALL FOUR ARMS ARE NOW PROVEN AGAINST A REAL DATABASE.** This section used to carry a standing
warning that `showcase_launch` and the hero table had no script. Writing the two that were missing
found a defect in each, which is the argument for the warning having been worth acting on rather
than restating:

- ⚠️ **`showcase_launch_call_to_action_ck` accepted a half-filled pair** — a label with no URL, or a
  URL with no label. It is migration 0172's bug in the shape nobody had looked for: with a label and
  no URL the "neither" arm is FALSE, `char_length(NULL)` is NULL, the "both" arm is therefore NULL,
  and `false OR NULL` is NULL — which a CHECK treats as passing. The fix is the two `IS NOT NULL`
  clauses that read as redundant beside the length tests and are the whole constraint.
  `showcase_launch_cost_range_ck` never had it, because it was written that way round.
- ⚠️ **Both hero URL CHECKs refused `//evil.tld` and accepted `/\evil.tld`** — the same attack in the
  spelling nobody tested. `promotional_slide_destination_ck` carried it too. The hero image check
  now shares `assetUrlCheck` with the teardown tables, which already refused both spellings.

**All four arms now have a smoke script too.** Each exists for the reason `db:smoke-teardown-authoring`
does: no test can prove a TRANSACTION runs, only that a controller calls it. Three of them carry an
assertion that is a **tripwire rather than a description**, and each says so in place:

- `smoke-showcase-authoring` asserts publishing mints **no** `showcase_launch_stats` row. When the
  engagement write path lands it must mint that row on FIRST ENGAGEMENT and still not on publish.
- The same file asserts `sort=top` and `sort=newest` return the same order. That is true only while
  nothing writes an upvote; the day one lands, the assertion is to be deleted, not repaired.
- `smoke-blueprint-hero` reorders **every** slide, seeded rows included, because the service refuses
  anything that is not a permutation of the whole table — then puts the carousel back in the order
  it found it in. A harness that silently rearranged the data it found would be worse than none.

A sweep of all 338 CHECK constraints for the multi-column NULL-pair shape found three candidates:
the call-to-action one (fixed), `commerce_seller_profile_sample_policy_ck` (safe — its second arm
compares columns rather than measuring them), and `compensation_period_line_equity_ck`, which is
**not** fixed here. That one is equity, so it is CLAUDE.md §0 high-stakes and wants its own change.

⚠️ **The two pre-existing scripts still pass UNEDITED** — 94 and 46 — which is the tell that this
work agrees with those files rather than editing them into agreement.

---

## 8. What the frontend was asked for, and what landed

This section was a handover list. Every item on it has since shipped, and it is kept as a record
rather than deleted, because the reasoning is what stops each one being re-introduced.

| # | Asked for | Landed as |
| --- | --- | --- |
| 1 | Split `TeardownSubmissionFileSchema` into a document schema (4-value) and a manufacturing-file schema (7-value) | Two schemas and two draft row types; a new document row now defaults to `schematic`. See §3.5 for why the backend still accepts both. |
| 2 | Stop sending `materials[].id` — the server mints it, and the column is a global primary key with no default | Dropped at the conversion point; the derived material schema ends `.strict()`, so a leftover is a loud refusal rather than a silent strip. |
| 3 | `byteSize: number \| null` on the read side | Nullable on documents and fabrication files; a model's stays positive and non-null, because that is an upload rather than a pasted link. |
| 4 | `partsList` on `TeardownBlueprintSchema` | Added **and rendered** — the frontend ships a checked sweep asserting every teardown field has a renderer. |
| 5 | The admin teardown queue, with a publish form carrying thumbnail, difficulty and an optional slug | `/admin/teardowns`, mirroring the case-study queue, with a live thumbnail preview. |
| 6 | Retire the `/mine` fixture's `draft` row — the endpoint can never return one | Went with the mock file when the transport was wired. |

**Nothing on this surface is waiting on the frontend.**

---

## 9. The three verbs that act on a published blueprint

`flag`, `quarantine` and `restore`. §3.7 said they did not exist; this section is what replaced that.

```
POST /blueprints/admin/teardowns/:teardownId/moderation-state
POST /blueprints/admin/case-studies/:caseStudyId/moderation-state
```

### 9.1 A different object from `/:submissionId/moderate`

That route decides a SUBMISSION — publish it or send it back. These move a row that is **already
public**, and on the teardown arm that is literally a different table with a different id. The path
parameter is named `:teardownId`, never `:submissionId`, so the two cannot be confused in code.

⚠️ **Id-addressed, which is the opposite of the engagement routes, and the split is principled.** A
reader is standing on a public page and the slug is the only handle they have; a moderator is
working a queue that hands them an id, and §5's audit payload is ids only. Slug-addressing would
also be *unspellable* on the case-study arm, whose `public_slug` is NULL until a moderator mints one.

### 9.2 The matrix, and the two refusals worth defending

One file — `blueprint-moderation-transitions.ts` — holds every pair; the service reads it and never
re-states one.

| teardown, from ↓ | `flag` | `quarantine` | `restore` |
| --- | --- | --- | --- |
| `published` | → `flagged` | → `quarantined` | refuse |
| `flagged` | refuse (already) | → `quarantined` | → `published` |
| `quarantined` | **refuse** | refuse (already) | → `published` |
| `pending_review` | refuse | refuse | refuse |

Case studies: the same, minus every quarantine cell.

⚠️ **`quarantined → flagged` is refused, not quietly allowed.** A quarantine withholds a publisher's
files under an unresolved rights claim; downgrading to a flag **republishes them**. That is a
`restore` then a `flag` — two decisions, two audit entries, two reason notes, because somebody has
to own the republication. The 409's message names the two-step path rather than just refusing.

⚠️ **`rejected` is never a source.** A rejection is terminal (§3.7) and a rejected case study was
never public.

⚠️ **Quarantine is teardown-only**, and it is refused in three independent places:
`case_study_moderation_state_ck` has no such label, the matrix returns `not_available_on_arm`, and
`blueprint_moderation_action_quarantine_arm_ck` refuses a LOG entry claiming one happened.

### 9.3 What is not built, and why

⚠️ **No showcase arm at all.** `showcase_launch_moderation_state_ck` admits
`pending_review | published | rejected` and the public feed gate is a bare `eq(published)`. Adding
the verbs there is a CHECK widening, a gate rewrite, `flagged` added to two partial index
predicates, and a fix to `showcase_launch_decision_ck` so flagging does not strip the public slug —
a feature, not an enum value. `blueprint_content_target_kind` therefore has two values, and
`verify-showcase-launch-constraints` asserts `flagged` and `quarantined` are still *refused* there,
with a comment saying the refusal is a decision.

### 9.4 Where the note lives, and where it must not

`blueprint_moderation_action.reason_note` is **NOT NULL on all three verbs, `restore` included** — a
restore overturns another moderator's quarantine, and the record of why is the only thing that stops
the pair being re-litigated silently.

⚠️ **The note never reaches the audit chain.** `buildHashDocument` hashes `detailNote` into a chain
that is hash-linked and kept forever, and a rights-claim note names a manufacturer and one party's
account of a private permission. The payload carries `hasReasonNote: true` and nothing else.
`user-reports.service.ts` passes `detailNote`; this path does not, and that divergence is a
decision. Proven against a real database: after driving all three verbs with notes, zero rows in
`platform_audit_entry` contain the note text.

⚠️ **A refusal writes nothing** — no action row, no audit entry, no state change. Six verbs
attempted, three refused, three action rows. A log that recorded attempts would make "three
moderators looked at this" indistinguishable from "three moderators acted".

### 9.5 What the verbs deliberately do not touch

⚠️ **`teardown_submission.moderation_state` is never written.** §4: the state comes from the
teardown by a `COALESCE` over the join, and `publicSlug` is COMPUTED from it — so `/teardowns/mine`
picks a flag up for free and stops rendering a "View the page" link with nothing extra written
anywhere. The alternative is a second state machine writing back into the paperwork.

---

## 10. Reader reports

```
POST /blueprints/teardowns/:teardownSlug/reports
POST /blueprints/case-studies/:caseStudySlug/reports
GET  /blueprints/reports/mine
GET  /blueprints/admin/content-reports              moderate_content, oldest first
POST /blueprints/admin/content-reports/:reportId/dismiss
```

### 10.1 A report never moves a state, and never will

⚠️ **Filing one writes no state change and no audit entry.** Three independent rules, any one of
which would be enough:

1. `flagged` is in **every** gate on both arms, so an auto-flag would change **nothing a visitor
   sees**. It would only stamp an unreviewed accusation on somebody's work.
2. `platform_audit_entry.actorUserId` is NOT NULL, and an automatic transition names nobody — which
   is exactly why commerce had to build a second apparatus (`action_source = 'automatic'`) to record
   authorless actions. This surface has none and needs none.
3. `user-reports.service.ts`: *"a number that could trip an automatic action would make brigading
   measurable and then effective."*

**Reconciling §2's "a report moves a published row to `flagged`, full stop":** read in place, that
sentence answers *which state* a report can reach on a one-gate arm, not *who moves it*. Its job is
to justify one gate rather than two — a case study has no files, so `flagged` is the only
destination a report has there. "Full stop" terminates the list of reachable outcomes. Implemented
as automaticity it would contradict §5's audit-actor invariant and produce a state change with zero
reader-visible effect.

The queue shows an `openReportCount` as **context**. Nothing reads it as a threshold, and no
threshold is published — the commerce rule applies verbatim: publishing "three people can hide this"
is a griefing recipe.

### 10.2 Its own table, and the reasons

⚠️ **Not a widened `user_report`.** This codebase has made that call five times and written it down
once (`_core.ts`): *"each moderation queue gets its own table rather than a widened `target_kind`,
because a queue's columns, its reasons and its verdict are its own."* It is not reusable anyway —
`user_report.reported_user_id` is NOT NULL onto `user(id)`, and a teardown is not a user.

`target_kind` plus **one nullable real FK per arm**, pinned by `num_nonnulls(...) = 1` — the
`commerce_content_report` shape. ⚠️ `= 1` here and `<= 1` on `blueprint_moderation_action`, and both
are correct: a report's targets CASCADE so a targetless report cannot exist, while a decision's are
`set null` because a decision has to outlive its subject.

### 10.3 Authenticated, and why that is not negotiable

⚠️ The intake takes `requireAuth` + `requireIdentifiedUser`. The bare-read rule is about **reads**
whose payload is identical for every visitor. Beyond that: the two partial unique indexes — **one
report per person per target** — are the anti-brigading control, and **an anonymous report cannot be
deduplicated**. An anonymous intake would make the queue's depth something anybody could manufacture.

No idempotency key, because the index already makes a double-submit a 409 rather than a second row.

⚠️ **Resolved under the READABLE gate, so a quarantined teardown still accepts a report** —
`claim-targets`' reasoning exactly: *"a second rights holder may have an entirely different objection
from the first… withhold the payload and that claimant can only say 'the whole teardown', which uses
one quarantine to blunt the control that produced it."*

### 10.4 The queue is a new route, not an arm of the three review queues

1. Those three are keyed on `moderation_state = 'pending_review'` and backed by partial indexes on
   exactly that predicate. A report is about a row that already **passed** that decision.
2. The verdict vocabularies are disjoint — publish/send-back versus flag/quarantine/restore/dismiss
   — so one route means two verdict enums and a `never` switch that can no longer be exhaustive.
3. ⚠️ `GET /blueprints/admin/case-studies/review-queue` is the **one** route in this router that
   serves a withheld company's real name (§6). Widening it would widen that exposure and break the
   sentence `case-study-withheld-name.test.ts` keeps true.

⚠️ **Dismissing restores nothing.** Nothing flags a row except a moderator deciding to, so a
dismissal has nothing to undo — and quietly un-flagging something a *different* moderator flagged
would overturn their decision as a side effect of answering a reader. A moderator who wants the row
back uses `restore`, which costs its own audit entry and its own note.

### 10.5 What the reporter is told

`GET /blueprints/reports/mine` exists because *"a report that vanishes is indistinguishable from one
nobody read."* It is deliberately narrow: **no moderator identity** (naming them makes a takedown
personal), **no resolution note**, and **no count of who else reported the same target** (that makes
brigading measurable). What it carries is the status.

The repeat-report refusal says **"You have already reported this"** and stops there, for the same
reason.

### 10.6 Proven against Postgres

Twelve assertions, including the four that matter: filing did not move the state; filing wrote no
audit entry; the **dismissal** did write one, because that is a staff action; and the resolution
note stayed **off** the hash-linked chain.
