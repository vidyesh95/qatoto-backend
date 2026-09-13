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
| Showcase launches | 3 | 3 | 3 | authored |
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
`repairabilityIndex`.

⚠️ **AND FOR AN UPLOADED FILE IT IS NOW A REAL WITHHOLDING RATHER THAN A REFUSAL TO ADVERTISE.** A
pasted link points at somebody else's host: omitting it from the payload stops Qatoto showing the
file, and does nothing at all to anyone who saved the URL. An uploaded file's only address is a
route on this server that consults the **LIST** gate on every request and refuses to mint a presign
for a quarantined teardown — so a link saved yesterday is dead the moment the quarantine lands. That
is the first time this control has actually taken a file away, and it is the strongest argument for
preferring uploads over pasted links. See §11. `claim-targets` exists so that moving it did not break the rights-claim flow: it
serves ids and titles with no column that could hold a URL, so a second rights holder can still name
the specific file they mean.

`withheldPayload()` in `teardown-public-read.service.ts` is the one list of what a quarantine takes,
and **`partsList` is in it**. A listing carries no file, so the "it withholds files" shorthand does
not decide it — but what a rights claim disputes is the SURVEY, and a parts list is the survey's
findings about somebody else's product in the plainest form it takes. Withholding the composition
table while publishing the parts it describes would be a distinction nobody could defend.

The case-study and showcase arms each have **one** gate (`published`, `flagged`) and copying the
teardown shape to either would be the more expensive mistake: neither has a quarantine, so a report
moves a published row to `flagged`, full stop. What the case-study arm withholds instead is one
FIELD, by a per-row flag — see §6. The showcase arm withholds nothing: a flag there marks the row for
the queue and stops it accruing engagement, and the page goes on answering. §9.3 has the reasoning
for why quarantine does not reach that arm despite it genuinely hosting files.

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
moderator who never held it would be fabricating them.

⚠️ **THAT IS A RULE ABOUT WHO SUPPLIES A FIELD, AND IT IS WHY THE GEOMETRY LANDED ON THE SUBMIT
PATH.** Read quickly it sounds like a prohibition on the fields; it is a prohibition on the
MODERATOR supplying them. Its verdict is that geometry must come from whoever held the unit — the
author — and the submit route is the only one they have. See §12. This surface, the moderator's
decision body, still asks for the first two and will never ask for the others.

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

- ~~**No drafts.**~~ **THE DRAFT STORE LANDED — see §13.** The wizard kept its state in React, so a
  closed tab lost it. There is now a draft id, and resume-later works across devices.
- ~~**No uploads.**~~ **UPLOADS LANDED — see §11.** Documents and manufacturing files could only be
  pasted `https://` links. Both tables now carry a `pasted_link | uploaded` union, and the pasted
  arm is unchanged: the bullet's reasoning still describes it exactly, which is why it is struck
  through rather than deleted.
- **No edit-and-resubmit.** ⚠️ **STILL TRUE OF THE ROW, AND NOW SURVIVABLE FOR THE AUTHOR.** A
  rejection is terminal, the note is mandatory on one because it is the author's entire remedy, and
  nothing reopens a decided submission. What §13.4 adds is the read this bullet always implied: the
  partial unique index excludes `rejected` precisely so "a sent-back author may survey the same unit
  again as a fresh submission", and an author can now pre-fill that fresh submission from their own
  stored document rather than retyping it.
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
pnpm db:verify-teardown-constraints        # 111 assertions in one rolled-back transaction
pnpm db:verify-case-study-constraints      # 46
pnpm db:verify-showcase-launch-constraints # 103
pnpm db:verify-blueprint-hero-constraints  # 27
pnpm db:verify-blueprint-engagement-constraints # 33
pnpm db:verify-blueprint-draft-constraints # 14
pnpm db:reconcile-blueprint-stats          # counter drift; -- --fix repairs
pnpm db:smoke-teardown-authoring           # 41: upload, assembly, publish, read, quarantine withholds
pnpm db:smoke-case-study-authoring         # 16, and a byte sweep for the withheld company name
pnpm db:smoke-showcase-authoring           # 36, upload-before-submit, the stats tripwire, the flag walk and `actioned`
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
POST /blueprints/admin/showcases/:launchId/moderation-state
```

### 9.1 A different object from `/:submissionId/moderate`

That route decides a SUBMISSION — publish it or send it back. These move a row that is **already
public**, and on the teardown arm that is literally a different table with a different id. The path
parameter is named `:teardownId`, never `:submissionId`, so the two cannot be confused in code.

⚠️ **ON THE SHOWCASE ARM THE TWO IDS ARE THE SAME ID, and the param is still named `:launchId`.**
`showcase_launch` is both the paperwork and the published row, so `/:submissionId/moderate` and
`/:launchId/moderation-state` really do select the same record — the qualifier this paragraph needs.
The name still earns its place, because what it records is which ACT is being performed rather than
which table is being hit: one decides a launch awaiting review, the other moves one that is already
public, and their verb vocabularies are disjoint. Naming it `:submissionId` here would make two
routes that share nothing but a row look interchangeable.

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

Case studies **and showcase launches**: the same, minus every quarantine cell. The two arms reach
that shape for different reasons — see §9.3 — which is why `resolveBlueprintTransition` spells the
guard `arm !== "teardown"` rather than naming the arms that are excluded.

⚠️ **`quarantined → flagged` is refused, not quietly allowed.** A quarantine withholds a publisher's
files under an unresolved rights claim; downgrading to a flag **republishes them**. That is a
`restore` then a `flag` — two decisions, two audit entries, two reason notes, because somebody has
to own the republication. The 409's message names the two-step path rather than just refusing.

⚠️ **`rejected` is never a source.** A rejection is terminal (§3.7) and a rejected case study was
never public.

⚠️ **Quarantine is teardown-only**, and it is refused in three independent places:
`case_study_moderation_state_ck` has no such label, the matrix returns `not_available_on_arm`, and
`blueprint_moderation_action_quarantine_arm_ck` refuses a LOG entry claiming one happened.

### 9.3 The showcase arm, and what it still does not get

~~**No showcase arm at all.**~~ **THE FLAG AND RESTORE VERBS LANDED — and the bullet is kept struck
through rather than deleted, because it priced the work correctly and that pricing is the reason it
waited.** It read: *"Adding the verbs there is a CHECK widening, a gate rewrite, `flagged` added to
two partial index predicates, and a fix to `showcase_launch_decision_ck` so flagging does not strip
the public slug — a feature, not an enum value."* All of that was true, and all of it was done.

⚠️ **IT WAS THREE PARTIAL INDEX PREDICATES, NOT TWO.** The bullet counted the two the public feed
reads — `showcase_launch_public_newest_idx` and `showcase_launch_built_from_idx` — and missed
`showcase_launch_title_live_uidx`, which is the one nobody looks for. A flagged launch was published,
keeps its `public_slug` and still answers at its address, so its **title is still live**; leaving it
out of that predicate would free the name for a second row while a reader could still reach the
first. `case_study_title_live_uidx` had already reached that conclusion on its own arm.

⚠️ **`showcase_launch_built_from_idx` HAS EXACTLY ONE CALLER, IN ANOTHER MODULE.**
`teardown-market-signal.service.ts` is it, and the index predicate and that query must be widened
together. The failure when they disagree is silent: nothing errors, Postgres just stops using the
index.

⚠️ **`quarantine` IS STILL REFUSED ON THIS ARM, AND NOT BY COPYING THE CASE-STUDY RULE.** That arm's
reason is that a case study has no files. A showcase *has* files — a heading image, write-up images
— so the rule does not transfer, and the refusal rests on two other grounds:

1. **There is no representable withheld state.** `heading_image_url` is NOT NULL, and by the exact
   analogy `withheldPayload()` draws for a teardown's `thumbnailUrl` — kept, because the header
   renders an unconditional image — it would survive a quarantine. Withholding only the write-up
   images leaves a Markdown body full of dead `![]()` references, which is a broken page rather than
   a redaction. A showcase quarantine would have to withhold the whole row, and that is `rejected`.
2. **The third-party failure mode is structurally absent.** A teardown surveys *somebody else's*
   shipped product, which is why a stranger's rights claim is its expected failure.
   `showcase_launch_statements_ck` pins a launch to `built_it_ourselves` and `results_are_our_own`,
   so a rights claim against one alleges the maker **lied on that attestation** — a fraud finding,
   answered by `flag` then `reject`, not a withholding pending somebody else's dispute.

`blueprint_content_target_kind` therefore has **three** values, and
`verify-showcase-launch-constraints` now asserts `flagged` is *accepted* and `quarantined` is still
*refused*, each with its reasoning in place.

⚠️ **`blueprint_moderation_action_quarantine_arm_ck` IS UNCHANGED AND NOW SAYS MORE THAN IT DID.**
Written when `target_kind` had two values it read as a statement about case studies; with three it is
the general rule — quarantine is teardown-only, full stop — and it refuses a fourth arm by default.
Naming the arm that MAY, rather than the arms that may not, is the shape to preserve.

⚠️ **THE COMPILER DOES NOT CATCH A NEW ARM, AND THIS IS THE LESSON WORTH KEEPING.** Widening
`BlueprintModerationArm` from two values to three produced **zero** type errors, because every
arm-shaped branch was a binary ternary: `arm === "teardown" ? a : b` keeps compiling and silently
routes the new arm down the `b` branch — which, in `applyVerb`, means locking, narrowing and
UPDATING the wrong row in the wrong table. Seven such sites were found by grep rather than by `tsc`.
Every one is now a `switch` with a `never` default, so a fourth arm is a build failure. Anywhere on
this surface that an arm decides between two things, the ternary is the bug waiting to happen.

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
POST /blueprints/showcases/:launchSlug/reports
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

### 10.7 `actioned`, and the two releases it spent unreachable

`blueprint_content_report_status` has carried `actioned` since the intake landed, the queue schema
has accepted it as a filter, and `MyBlueprintReportView` has declared it — and **nothing in the
codebase could produce it.** `blueprint_moderation_action.report_id` shipped in the same migration
and was never written. So a moderator who flagged a row *because of* a report left that report
`open` forever, and §10.5's whole reason for `/reports/mine` — *"a report that vanishes is
indistinguishable from one nobody read"* — was defeated by the one path most likely to answer a
reader.

The three verbs now take an **optional** `reportId`:

⚠️ **NULL IS THE ORDINARY CASE, NOT A DEGRADED ONE.** The primary quarantine path is an emailed
rights claim that never touches the queue (§3.7), so requiring an id would make the case the lever
exists for unrecordable. A decision with no report id is a complete decision.

⚠️ **THIS IS NOT A REPORT MOVING A STATE, AND §10.1 IS UNTOUCHED.** The moderator still chose the
verb and owns it; the id records *which* open complaint that decision answers. Nothing counts
reports, and no threshold exists to trip. The change looks like it contradicts §10.1, which is why
the service says so in place.

⚠️ **THE MODERATION NOTE IS REUSED AS THE RESOLUTION NOTE.** §10.5 says the reporter never sees it,
and the reason the row was flagged *is* the reason the report was actioned. Asking for two required
notes about one decision produces a second note reading "see above".

⚠️ **A REPORT ABOUT A DIFFERENT ROW ANSWERS 404, the same bytes as one that does not exist.** The
caller holds `moderate_content`, so this is not a privilege boundary — but distinguishing the two
would let anyone with the capability map reports to targets by guessing ids, and the queue already
serves everything they are meant to know. An already-resolved report answers **409**, because its
existence is not a disclosure to someone who can see the queue, and the refusal is the answer to why
nothing happened.

⚠️ **THE REPORT IS CHECKED BEFORE ANYTHING MOVES.** A bad id costs no state change, no audit entry
and no action row — the same ordering rule the capability check follows one layer up, and proven in
`db:smoke-showcase-authoring`: a second verb naming a resolved report is refused and the launch is
still in the state the first one left it.

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

---

## 11. Uploaded documents and fabrication files

```
POST /blueprints/teardowns/uploads                                      one file + its format
GET  /blueprints/teardowns/:teardownSlug/documents/:fileId              302 → 300s presign
GET  /blueprints/teardowns/:teardownSlug/fabrication-files/:fileId      302 → 300s presign
```

### 11.1 The private bucket, and why not Cloudinary

`object-storage.ts`'s own header decides it: Cloudinary is the IMAGE pipeline here, and everything
reaching it is first re-encoded by `image.ts`, which answers `NOT_AN_IMAGE` for a PDF.
`uploadProductModel` is the one `raw` exception, and its stated condition is *"a PUBLIC asset
rendered in place on a public page"* — a `.step` is not rendered in place, it is downloaded and
opened in somebody's CAD tool. The error vocabulary comes free: `NOT_CONFIGURED | UPLOAD_FAILED |
DELETE_FAILED` → 503/502/502, which is the stated payoff of that module sharing one vocabulary with
`cloudinary.ts`.

### 11.2 A discriminated union on the row

⚠️ **A PRESIGNED URL CANNOT BE STORED AND A RAW KEY CANNOT GO IN `url`.** The first expires in 300
seconds; the second is refused by `assetUrlCheck`, which admits `https://` or a leading slash and
nothing else. So the uploaded arm gets `object_storage_key` and `content_sha256` with their own
CHECK, `url` becomes nullable under an `IS NULL OR` (the shape
`teardown_fastener_supplier_url_ck` already uses), and `source` pins which combination is legal.

**The address a reader follows is COMPUTED, never stored** — a route on this server, the same move
`/teardowns/mine` makes for `publicSlug`. That is what lets the download re-check the gate per
request, and it is why the object key never reaches the wire (it names the bucket layout and embeds
the uploader's account id; the smoke asserts both are absent from the payload).

⚠️ **`byte_size` IS NOT NULL ON THE UPLOADED ARM ONLY.** §3.3 argued NULL because the two honest
ways to fill it were a HEAD inside the publish transaction or a moderator typing a number about a
file they never opened. An upload measures the bytes at intake — the condition that reasoning always
lacked — so the pasted arm keeps its NULL and §3.3 stays true *of it*.

### 11.3 The download gate is LIST, not READABLE

⚠️ **A THIRD PREDICATE, ON A SURFACE THAT ALREADY KEEPS TWO APART.** A quarantined teardown's page
answers — that is what READABLE is for — but a quarantine *is* a withholding of the publisher's
files, and `withheldPayload()` already blanks both lists. Serving bytes from a separate route while
the page hid them would put the control back where it was before it moved server-side.

⚠️ **ONE 404 FOR EVERY REASON**: no such slug, no such file, a file belonging to a *different*
teardown, and a quarantine are deliberately indistinguishable. Anything finer is an enumeration
oracle over withheld files.

⚠️ **NOT BARE READS, AND NOT AN EXCEPTION TO THE RULE.** §1's bare-read rule is about reads whose
payload is identical for every visitor and which a cache belongs in front of. These answer a 302 to
a per-request bearer capability under `Cache-Control: no-store`, failing both clauses on their face.
`GET /videos/:videoId/documents/:documentId/file` is the shipped precedent — anonymous-reachable,
private bucket, same shape.

### 11.4 Validation, and what it does not prove

The multipart mimetype gate is **weaker here than on any other upload**, and the parser says so:
browsers send `application/octet-stream` for `.step`, `.stl` and `.dxf` far more often than any
registered type, so it must admit that and therefore refuses almost nothing. The control is a
required `format` text part that `teardown-file-bytes.ts` proves against the actual bytes — checked
in both directions, so a STEP declared as a PDF is refused as loudly as the reverse.

| Format | What is proven |
| --- | --- |
| `pdf` | Delegated to `validatePdfBytes` verbatim, reusing `MAX_PAPER_BYTES` because that validator hardcodes the cap in its own `TOO_LARGE` branch |
| `step` | The two markers ISO 10303-21 mandates: `ISO-10303-21;` … `END-ISO-10303-21;` |
| `stl` | ASCII framing, or binary's **arithmetic invariant** `84 + 50 × triangleCount` — the strongest check here, and one a truncated file cannot satisfy |
| `dxf` | ASCII group-code opening plus `EOF`. Binary DXF is refused: one fewer parser surface |

`gerber`, `drill`, `pick_and_place` and `bill_of_materials_csv` stay **pasted-link-only**. The first
two are sniffable and can be added; the last two are plain text with no framing at all, so a
validator for them would assert nothing while reading as though it did — §3.7's rule about not
adding a label before its lever exists.

⚠️ **WHAT NONE OF IT PROVES, and no copy may claim:** that a file is what its title says, that it
opens, or that it is safe to hand to a CAD program. A hostile STEP is fully representable inside a
well-framed one, and a PDF that passes may carry JavaScript, embedded files and external references.
**Nothing on this path claims the file was scanned, because it was not.** What actually moves the
needle is delivery: the bytes never render on a Qatoto origin, `Content-Type` is pinned to the
format *we* detected, and `Content-Disposition: attachment` is set at **PUT** time so the object
cannot be coaxed into rendering inline even if a URL escapes — which takes PDF active content out of
the same-origin threat model entirely.

### 11.5 Staged, then claimed at SUBMIT

The staging table is `teardown_submission_file_upload`, in the **submission** family — §3.1's rule
that the paperwork is a different domain object. The published `teardown_*` family gains only
`source`, `object_storage_key` and `content_sha256`; no uploader, so the sentence
`text-pii-register.ts` keeps about that family survives (amended to say so precisely).

⚠️ **CLAIMED AT SUBMIT, NOT AT PUBLISH** — the one departure from the showcase image pattern this
otherwise copies. The sweeper reaps anything unclaimed after a day, and a submission can wait weeks
in the review queue, so claiming at publish would let it delete an author's files out from under
their own pending survey. The claim is a single `UPDATE` proving three things at once — this author,
still unclaimed, among the ids named — so a stranger's id, an already-claimed one and a nonexistent
one all fail identically, and the refusal names none of them.

⚠️ **NO IDEMPOTENCY KEY.** The object key is content-addressed on `(uploader, sha256)` and the column
is unique, so a retry converges on the same object and the same row and is answered as SUCCESS with
the existing receipt rather than a 409 — `attachVideoDocument`'s argument that the storage layer
being idempotent by construction is stronger than a replayed response.

⚠️ **THE BUCKET OBJECT IS DELETED ON ERASURE, BY ITS OWN NAMED STEP — and an earlier version of this
paragraph said the opposite, which is worth recording because it was wrong in a way that discouraged
the fix.** It claimed nothing in `src/modules/auth/privacy/` deletes object storage and that the gap
was "platform-wide". Both halves were false, and the mistake was grepping for the `deleteX` function
names rather than for the purge STEPS, which call through service wrappers.

What is actually true:

| Family | Disposition on erasure | Orphan? |
| --- | --- | --- |
| Research papers | `research_program_paper.uploader_user_id` is **`null_out`** | No — the paper belongs to the program and outlives the uploader |
| Commerce / product documents | no `user` foreign key at all | No — owned by an organization, so nothing is orphaned |
| Video documents | `purge_video_document_objects` | No — purged explicitly |
| Data exports | `purge_data_exports` | No — purged explicitly |
| Showcase images | `purge_showcase_launch_images` | No — purged explicitly (Cloudinary) |
| **Teardown files** | `teardown.author_user_id` and `teardown_submission_file_upload.uploaded_by_user_id` are **both `delete_rows`** | **Yes, and `purge_teardown_file_objects` is why this step exists** |

⚠️ **THIS FAMILY IS THE EXCEPTION, AND UPLOADS CREATED IT.** Most families need no purge because
their rows SURVIVE the erasure, so their bytes stay referenced and deleting them would be data loss
rather than hygiene. Teardown files differ only because both owning columns are `delete_rows` — the
rows go, and without the step the keys on them become unreachable bytes nothing can find.

⚠️ **AND IT IS AN ERASURE OBLIGATION RATHER THAN HOUSEKEEPING.** A datasheet or a `.step` file is
content the author uploaded; deleting the row while keeping the bytes has not erased it. The step
runs BEFORE the row deletes, because the keys live on the rows being deleted, and it logs rather than
throws on a storage failure — an erasure stuck behind a bucket is the worse outcome for the person
who asked for it.

---

## 12. Authored assemblies

The wizard could collect a parts LISTING (§3.3) and no geometry: `teardown_assembly`,
`teardown_part`, `teardown_assembly_step` and `teardown_fastener` were seed-only. They are now
written by the publish, from the submission document.

### 12.1 The submit path, not a post-publish surface

⚠️ **§3.4 REQUIRES THIS RATHER THAN FORBIDDING IT** — see the sharpened sentence there. Geometry is
a fact about the physical unit, so it must come from whoever held it. The two alternatives were
asking a moderator to invent it, which §3.4 refuses outright, or opening a second unmoderated author
write onto a row that is already public.

⚠️ **THE FOUR TABLES NEEDED NO DDL TO ACCEPT AUTHORED ROWS**, which is the strongest evidence the
design is right: they were built for exactly this shape. §3.1's argument against relaxing `teardown`
— nine all-or-none CHECKs, a `thumbnail_url` the wizard cannot fill — transfers to none of them. The
only schema change was the model union, and UPLOADS forced that, not authoring.

`document_schema_version` moves 2 → 3, and as with 2 no second parser is needed: `assembly`,
`assemblySteps` and `fasteners` all carry Zod defaults, so an older document reads as a teardown with
no assembly, which is what it is.

### 12.2 One field differs; everything else is reused

`model: { url, byteSize }` becomes `modelUploadId`. An author has neither — the URL does not exist
until a moderator publishes, and the size is a fact the server measured at intake — so sending
either would be a client asserting something it cannot know. The same reasoning omits `id` from
`SubmittedMaterialSchema`.

`AssemblyStepSchema` and `FastenerSchema` are imported **whole**: neither carries a file, so neither
needs an authoring variant.

`refineTeardownCrossSectionRules` is applied rather than restated — its own comment said it was
exported "so the authoring gate can apply the same rules to a different field set", and this is that
caller. Its parameter narrowed to a derived `Pick` interface: every field TYPE still comes from the
import shape, and only the SELECTION narrows.

⚠️ **A SIXTH CROSS-ROW RULE LANDED: part ids are unique within an assembly.** The composite primary
key always refused a duplicate, but as a 23505 inside the publish transaction, hours after the author
left, naming a constraint rather than a field. The seed was the only writer, so that was a
developer's problem; a public route makes it a stranger's.

### 12.3 The `.glb` shares the file upload route

⚠️ **AND IT GOES TO THE PRIVATE BUCKET, NOT CLOUDINARY RAW.** `uploadProductModel` is the documented
exception for "a public asset rendered in place on a public page", and a `.glb` fits that sentence —
but `assembly` is in `withheldPayload()`, so a quarantine is supposed to take the geometry away. A
permanent public URL keeps serving it to anyone who saved the link, which is the hole §11 closed for
documents; reopening it for the model would have made one quarantine mean two different things on
one page. The model downloads therefore use the **LIST** gate, exactly as the file downloads do.

One route for five formats means one staging table, one ceiling, one sweep and one download gate.
`validateGlbBytes` is delegated to rather than re-implemented, for the reason `validatePdfBytes` is:
it hardcodes its own cap, so a second would be two limits that eventually disagree.

⚠️ **AND THAT DELEGATION HAS AN ORDERING RULE.** `validateTeardownFileBytes` carries a 64-byte floor
for the three CAD text formats; `pdf` and `glb` must be dispatched ABOVE it, because both delegate to
validators with their own floors and a conforming minimal `.glb` is 49 bytes. The first version
applied the generic floor first and refused a valid model — caught by the smoke, whose fixture is the
smallest legal model, and which no hand-written unit fixture would have reproduced.

### 12.4 The body budget, which the build gate cannot check here

⚠️ **`json-body-budget.test.ts` PASSES THIS ROUTE VACUOUSLY, AND ALWAYS HAS.** That suite is the
reason a cap is "a derived fact rather than a guess", but `estimateBodyBytes` does not traverse
`ZodEffects` — and `TeardownSubmissionSchema` ends in `.superRefine`, so it reports **eight bytes**
for the largest body on this surface. Verified by measuring before and after the assembly arm
existed. The arm is what makes it matter.

So `teardown-submission.schemas.test.ts` CONSTRUCTS the worst case and measures it against both
ceilings: `longFormBody` at 128 KB and `teardown_submission_document_ck` at 262,144 characters.

⚠️ **IT CAUGHT THE PROBLEM ON ITS FIRST RUN.** 64 parts, 64 steps and 64 fasteners put a maximal
document at 133,256 bytes against a 131,072-byte cap. The caps are **48**, measured rather than
chosen, and the test imports the constants so the two cannot drift. `MAX_JSON_BODY_BYTES` is
untouched — it is the ceiling every route behind it inherits.

---

## 13. The draft store

```
POST   /blueprints/drafts               201 { draftId, revision, updatedAt }
GET    /blueprints/drafts               labels only, never documents
GET    /blueprints/drafts/:draftId      one document
PUT    /blueprints/drafts/:draftId      requires the revision it loaded
DELETE /blueprints/drafts/:draftId
```

### 13.1 One table for three arms

⚠️ **THIS IS THE OPPOSITE OF THE RULE `_core.ts` STATES, AND THE RULE DOES NOT REACH HERE.** That
rule — quoted in §10.2 — is that each **moderation queue** gets its own table "because a queue's
columns, its REASONS and its VERDICT are its own". Every clause of the justification is about a
queue. A draft has no verdict, no reasons, and, decisively, **no columns of its own**: the promoted
set is `owner_user_id`, `arm`, `label`, `updated_at`, identical for all three wizards, because the
only two queries are "list mine" and "load one".

`blueprint_draft_arm` is its **own** type rather than a widened `blueprint_content_target_kind`.
Widening that would need an isolated `ALTER TYPE` migration *and* would contradict what §9.3 records
about it: its members are the arms a moderation VERB can reach. A draft is never moderated.

⚠️ **AND IT IS NOT `teardown_submission` WITH `moderation_state = 'draft'`.** Four refusals, any one
sufficient: that CHECK admits three labels and `draft` is not among them; `subject_product_name` is
NOT NULL and a draft has no subject yet; the live-survey index would need a fourth predicate
decision; and it would put an **unparsed** document in the column `decideTeardown` parses. The unused
`draft` label on `blueprint_moderation_state` stays unused.

### 13.2 The document is opaque, and the submit gate is still the only gate

⚠️ **A DRAFT IS UNVALIDATED BY DEFINITION** — half-answered is the state it exists to hold — so a
schema admitting only submittable documents would refuse exactly the drafts worth saving. The
envelope is parsed `.strict()`; the document is checked for being a JSON **object** and nothing more.

What makes that safe: the document never reaches a public serializer, a publish, or another account;
the submit gate is unchanged, so a draft that cannot be submitted is simply a draft; and the bytes
are bounded twice, by `longFormBody` and by `blueprint_draft_document_ck`.

The rejected alternative was three hand-built "everything optional" mirrors of the submit schemas.
Zod 4 has no `.deepPartial()`, so each would be maintained by hand forever and every new wizard field
would touch two files — a drift machine, buying feedback the wizard already gives locally.

⚠️ **`document_schema_version` MEANS SOMETHING DIFFERENT HERE than on `teardown_submission`.** There
it selects a server-side parser. Here **the reader is the client**: a resumed draft goes back to the
wizard, which parses it with its own draft schema. The two columns look like copies and are not.

### 13.3 Two traps this feature had to disarm

⚠️ **THE SWEEPER WOULD HAVE EATEN A RESUMED DRAFT'S IMAGES, SILENTLY.** Every image a showcase draft
references carries a NULL `launch_id` — a draft has no launch — and
`sweep-orphan-showcase-images` deletes exactly that after 24 hours. An author resuming a week later
would find a write-up full of dead links with nothing failing anywhere. `draft_id` is now a conjunct
in **three** places that must agree: the partial index, the sweeper, and the staging cap (a draft's
images are claimed, so they do not spend that budget).

⚠️ **OPTIMISTIC CONCURRENCY IS NOT OPTIONAL.** Two tabs autosaving one draft with no `revision` means
the last writer silently destroys the other's work — the exact failure "resume later across devices"
is sold as preventing, and the cheapest thing here to add now. The UPDATE guards on the revision AND
the owner, so a stranger's draft, a missing one and a stale write all produce zero rows; a second
owner-scoped read separates the last case, because "somebody else saved this" is actionable while the
other two must stay indistinguishable.

⚠️ **THE DOCUMENT BOUND WAS DECORATION TWICE BEFORE IT WAS RIGHT.** First 262,144 — the column's own
number — which `estimateBodyBytes` (four bytes per character) makes 1,049,569B against a 131,072B
cap, so no request could reach the CHECK. Then 32,768, which is exactly the cap and leaves nothing
for `label`, `documentSchemaVersion` and `revision`. It is **32,000** on both, and the verifier
asserts one character past it is refused.

### 13.4 There is no staff route, and that is the point

⚠️ **§6's GUARANTEE IS THAT EXACTLY ONE ROUTE SERVES A WITHHELD COMPANY'S REAL NAME.** A draft
document is opaque, so it can hold that name and nothing can detect it — a moderator-visible draft
would make it two, which is the widening §10.4 already refuses. `case-study-withheld-name.test.ts`
asserts both halves: the list carries labels only, and two plausible staff paths 404.

For the same reason the manifest entry is `delete_rows`. `text-pii-register.ts` works per column on
structured text and cannot reach inside a blob, so deleting the row is the only operation that
provably reaches the name.

### 13.5 Edit-and-resubmit, without reopening a decision

```
GET /blueprints/teardowns/mine/:submissionId    owner-scoped; a stranger's id answers 404
```

⚠️ **A REJECTION STAYS TERMINAL, AND IN-PLACE EDITING IS REFUSED BY POSTGRES ANYWAY.**
`teardown_submission_decision_ck` reads `(moderation_state = 'pending_review') = (reviewed_at IS
NULL)`, `(reviewed_at IS NULL) = (reviewed_by_user_id IS NULL)` and `(moderation_state <> 'rejected'
OR moderator_note IS NOT NULL)` — so moving a rejected row back to `pending_review` forces the
reviewer, the decision time **and** the mandatory note all to NULL. The constraint deletes the
evidence as the price of the edit. A revision chain would be the shape if lineage is ever wanted.

So this route changes nothing: the author reads their own document, seeds a **draft** from it, edits
and submits afresh — which `teardown_submission_subject_live_uidx` already permits by excluding
`rejected`. The moderator note travels with it, because that note is the instructions.

⚠️ **NESTED UNDER `/mine/` TO AVOID A SHADOW.** The obvious `/teardowns/submissions/:submissionId` is
three segments, the same shape as `/teardowns/:teardownSlug/claim-targets` — so a teardown slugged
`submissions` would have its claim-targets shadowed by it. `mine` is already in `teardown_slug_ck`'s
reserved list, so nesting costs no migration and cannot collide with any slug that could exist.

⚠️ **THIS IS TEARDOWN-ONLY, STRUCTURALLY.** The showcase and case-study arms have no submission
document table — they write straight into `showcase_launch` and `case_study`, so "the pending row IS
the public row". There is nothing to hand back that is not already the published object.
