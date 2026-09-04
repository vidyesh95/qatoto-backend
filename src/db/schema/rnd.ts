import { randomUUID } from "node:crypto";

import { relations, sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  bigint,
  date,
  index,
  uniqueIndex,
  check,
  primaryKey,
  pgEnum,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { user } from "#src/db/schema/_core.js";
import { platformAuditEntry } from "#src/db/schema/platform.js";
import { commerceOrganization } from "#src/db/schema/store.js";
// FIRST EDGE FROM R&D TO STUDIO, and it closes a cycle: `studio.ts` already imports
// `researchProject` from here. That is fine and `_primitives.ts` says why — every
// cross-file foreign key in this schema is a THUNK, `.references(() => other.id)`, so
// it resolves long after both modules finish evaluating. The rule that would be broken
// is about eagerly-CALLED symbols (an enum, a customType), and a table is not one.
import { video } from "#src/db/schema/studio.js";

// ---------------------------------------------------------------------------
// Research & Development domain. See docs/R_AND_D_BACKEND_STRUCTURE.md.
//
// THREE RULES THAT GOVERN EVERY TABLE BELOW:
//
//  1. ZERO-TRUST (§0). No request body ever carries a value the server owns — no
//     status, no slug, no counter, no score, no verdict, and above all no equity.
//     Equity is COMPUTED, never asserted: there is deliberately no writable equity
//     column anywhere in this schema and no endpoint that sets one.
//
//  2. CASCADE POLICY (§4f), two rules so the audit sweep is mechanical:
//       R1 — every FK into `research_project` is `restrict`. Exactly two exceptions:
//            `project_stats` (a rebuildable counter cache) and `project_watcher` (a
//            bookmark). There is no DELETE endpoint; archive is terminal.
//       R2 — FKs into `user` are `restrict` when the row bears equity, effort or
//            audit weight; `cascade` when it is a preference that dies with the
//            account; `set null` when it is attribution that must never block one.
//     Net effect: anyone who has founded, joined or applied to a project cannot be
//     hard-deleted, so account deletion is an ANONYMIZATION flow. That is the point —
//     it is what stops one account deletion erasing a financial ledger.
//
//  3. UNITS (§4b). Money is `bigint` integer cents (int4 caps at $21.5M — a single
//     round overflows it). Equity is `integer` basis points, 10000 = 100%. Effort is
//     integer minutes. No `numeric`, no floats, ever.
// ---------------------------------------------------------------------------

// --- Shared enums (§4d). Declared ONCE, here, and never re-declared per domain.
// All values are snake_case, matching the product_category (`home_kitchen`)
// precedent. The frontend's shipped kebab-case unions ("full-time") become
// snake_case as part of this change — §15 lists every one.

// The ONLY per-project role enum. Declaration order does NOT imply rank: authorization
// compares against an explicit rank map in project-membership.service.ts, never `>` on
// the enum, so reordering this list can never silently change who can do what.
export const projectMemberRoleEnum = pgEnum("project_member_role", [
  "founder", // row owner: edit, stage, publish/archive, remove members, request escrow
  "admin", // co-signer: approves escrow releases (four-eyes, §7), triages applications
  "maintainer", // create/edit roles, triage applications, manage the workshop board
  "contributor", // post daily logs, read private project surfaces
]);

// Membership is never hard-deleted: a departed member's slices, logs and ledger
// postings still reference the row, and the Trust Protocol requires their historical
// equity stay auditable. `left`/`removed` are STATES, not deletions.
export const projectMemberStatusEnum = pgEnum("project_member_status", [
  "active", // counts toward the roster and the equity pool
  "left", // self-departed
  "removed", // removed by a founder
]);

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

// Replaces the frontend's free-prose `earnedAsLabel`. Shipping English sentences from
// the server forces three native clients to render un-localizable strings, and lets a
// founder write a payout promise the platform will not honour. Clients map the enum to
// localized copy.
//
// THE TWO ESCROW VALUES ARE RETIRED (§4d). They forced every cash strand through a
// milestone escrow release, which meant a founder who never ran a funding round here had
// no way to say "I pay this person from my own bank account" — money-in gated data-out —
// and worse, it made a wage conditional on a Proof-of-Effort verdict, which §0 now forbids
// outright. They stay in the type so migration 0010's existing rows remain readable;
// `open_role_compensation_policy_pairing_ck` (migration 0018) makes them UNWRITABLE, and
// the two new values are the only ones a cash strand accepts.
export const compensationEarnedAsPolicyEnum = pgEnum("compensation_earned_as_policy", [
  "milestone_escrow_release", // RETIRED — readable, never writable
  "on_completion_escrow_release", // RETIRED — readable, never writable
  "slicing_pie_vesting", // equity, and equity only
  "off_platform_payroll", // DEFAULT for cash: paid by the company, reported here (§7A)
  "direct_transfer", // one-off, paid directly, reported here (§7A)
]);

// How a member is engaged (§4d). FOUNDER-DECLARED, never inferred: the tax, wage-law and
// social-contribution treatment differ per branch, and misclassification liability belongs
// to the company, not to Qatoto (§7A.6 item 3). No endpoint derives this from behaviour,
// hours, or anything else — a platform that guesses employment status is making a legal
// determination it is not qualified to make.
export const engagementKindEnum = pgEnum("engagement_kind", [
  "employee",
  "independent_contractor",
  "unpaid_founder",
]);

// A cash agreement's lifecycle (§7A.2). Mirrors `fair_market_rate_status` deliberately:
// the founder proposes, the SUBJECT accepts, and only an `active` row prices anything.
// `superseded` is what a later effective-dated agreement does to the one before it;
// `withdrawn` is a proposal nobody accepted. Neither is a deletion — a finalized statement
// line pins `sourceAgreementId` forever.
export const compensationAgreementStatusEnum = pgEnum("compensation_agreement_status", [
  "proposed",
  "active",
  "superseded",
  "withdrawn",
]);

// A compensation period's lifecycle (§4d, §7A.3). `finalized` is terminal and hash-frozen;
// a correction supersedes the period with a new one rather than editing it, the same way
// the audit chain corrects by reversal rather than by UPDATE (§4f).
export const compensationPeriodStatusEnum = pgEnum("compensation_period_status", [
  "open",
  "finalized",
  "superseded",
]);

// One line per member per kind per period (§7A.3). A cash line carries money and no basis
// points; an equity line carries basis points and no money. Equity is NOT money and the
// two must never be summed — `compensation_period_line_kind_ck` encodes that rather than
// leaving it to a comment.
export const compensationPeriodLineKindEnum = pgEnum("compensation_period_line_kind", [
  "cash_retainer",
  "cash_hourly",
  "equity_delta",
]);

// How the founder says they paid, on a payment ATTESTATION (§7A's
// `compensation_payment_record`). A key, never an instrument: this domain stores no account
// number, no IBAN, no UPI handle and no card detail, so the enum names the rail and the
// free-text `reference_note` carries a human note like a UTR or a payroll run id.
export const compensationPaymentMethodKeyEnum = pgEnum("compensation_payment_method_key", [
  "bank_transfer",
  "sepa_transfer",
  "upi",
  "payroll_provider",
  "cash",
  "other",
]);

// The ONE verification status, shared by daily logs (§8), effort claims (§9) and
// research effort logs (§10).
//
// NO COLUMN USES THIS YET — it is declared to RESERVE the name. This is the
// highest-collision-risk identifier in the spec: three deferred sections each defined
// a near-disjoint variant of it during drafting, and Postgres puts types and tables in
// one namespace. Reserving costs one CREATE TYPE, and an unused type is free to
// redefine; discovering the collision at §9 is not.
export const effortVerificationStatusEnum = pgEnum("effort_verification_status", [
  "not_run", // no claim submitted yet
  "queued", // enqueued, worker has not started
  "running", // pipeline in flight
  "verified", // all four steps passed → slices awarded
  "flagged_for_review", // a step flagged → allocation withheld pending human review
  "unverified", // no digital receipts → zero slices
]);

// Shared by market insights and demand signals (§6), and by §7's investor-confidence
// signal later. Declared in the §4d shared block rather than the §6 domain block because
// more than one section reads it.
export const trendDirectionEnum = pgEnum("trend_direction", ["up", "down", "flat"]);

// --- Domain enums (§5)

export const researchProjectStatusEnum = pgEnum("research_project_status", [
  "draft", // the wizard's output; visible only to its founder. This IS the "idea".
  "active", // published; publicly readable; appears in the landing rail
  "archived", // withdrawn but preserved — members, slices and escrow history reference it
]);

export const openRoleStatusEnum = pgEnum("open_role_status", ["open", "closed", "filled"]);

export const projectApplicationKindEnum = pgEnum("project_application_kind", [
  "role_interest", // fired from an OpenRole card
  "join_request", // "Request to join", no role attached
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

// Why a member's stint ended. Kept alongside the interval so §9 can distinguish a
// voluntary departure from a removal without joining back to the member row's
// current state, which by then describes a LATER stint.
export const memberIntervalEndReasonEnum = pgEnum("member_interval_end_reason", [
  "left", // self-departed
  "removed", // removed by a founder
]);

// --- Domain enums (§6 discovery)

// The pin asset a client renders for a category on the problem map.
//
// Server-owned, and moderator-assigned at approval time. It lives here rather than on
// the client because the frontend currently keys its PIN_ICON_SRC_BY_CATEGORY map on the
// DISPLAY LABEL — so a moderator renaming "Water & Sanitation" to "Water, Sanitation &
// Hygiene" silently drops every pin on the map to the default icon, with no error
// anywhere. A stable key cannot be renamed by an editorial decision.
export const categoryPinIconKeyEnum = pgEnum("category_pin_icon_key", [
  "water",
  "energy",
  "health",
  "agriculture",
  "housing",
  "transport",
  "waste",
  "connectivity",
  "manufacturing",
  "education",
  "other",
]);

// The lifecycle of ONE person's raw report, from submission to cluster attachment.
//
// Geocoding and clustering both run in the async job (§4e), never in the request, so a
// submission is observable in an un-geocoded state and the states must be distinct: a
// submission that could not be geocoded is a DIFFERENT problem from one still queued,
// and only the former needs a human.
export const problemSubmissionStatusEnum = pgEnum("problem_submission_status", [
  "queued", // accepted, awaiting the geocode-and-cluster job
  "clustered", // geocoded and attached to a problem_cluster
  "geocode_failed", // the location string resolved to nothing — needs a human, not a retry
  "rejected", // moderator judged it spam; excluded from every count, never deleted
  "failed", // the job dead-lettered after bounded retries
]);

export const problemClusterStatusEnum = pgEnum("problem_cluster_status", [
  "active",
  "merged", // absorbed by an approved merge proposal; mergedIntoClusterId names the survivor
  "hidden", // moderator-hidden; excluded from public reads, NOT deleted
]);

export const clusterMergeProposalStatusEnum = pgEnum("cluster_merge_proposal_status", [
  "pending",
  "approved",
  "rejected",
  "superseded", // one side was itself merged elsewhere first
]);

export const clusterMergeProposalSourceEnum = pgEnum("cluster_merge_proposal_source", [
  "job_similarity",
  "moderator",
]);

export const problemClusterLinkSourceEnum = pgEnum("problem_cluster_link_source", [
  "origin", // the project was BORN from this cluster — at most one per project
  "founder_declared", // an additional cluster the founder says the project addresses
  "moderator",
]);

export const discoveryRegionKindEnum = pgEnum("discovery_region_kind", [
  "global",
  "macro_region",
  "country",
]);

// Whether a cached geocode resolved. A miss is cached TOO — see geocodeCache: re-asking a
// provider that already said "no such place" is a rate-limit burn that always fails.
export const geocodeStatusEnum = pgEnum("geocode_status", ["resolved", "not_found"]);

// `MarketInsight.statValue` is the sneakiest field on the surface: the mocks carry
// "+34%", "68M people", "3× coverage" and "-22%" in ONE string column. It decomposes into
// a KIND (what sort of magnitude this is) and a UNIT (what it counts), paired by a CHECK
// so a `multiplier` can never render as "3 people".
export const marketInsightStatKindEnum = pgEnum("market_insight_stat_kind", [
  "percent_change", // "+34%", "-22%" — SIGNED delta, the only kind that may be negative
  "percent_level", // "31%" — an absolute rate, never negative, never above 100%
  "absolute_count", // "68M people", "250K tonnes"
  "multiplier", // "3× coverage" — strictly positive
]);

export const marketInsightStatUnitKeyEnum = pgEnum("market_insight_stat_unit_key", [
  "percent",
  "multiple",
  "people",
  "households",
  "tonnes",
  "litres",
  "hectares",
  // DOLLARS, not cents, and this is deliberate — see marketInsight.statValueMilli.
  "usd_dollars",
  "count", // dimensionless fallback
]);

export const talentAvailabilityEnum = pgEnum("talent_availability", [
  "open_to_work",
  "open_to_offers",
  "unavailable",
]);

// An opt-in directory defaults to NOT listed. Visibility is never a side effect of an
// edit — publishing is its own explicit action, so a listing can never appear by accident.
export const talentProfileVisibilityEnum = pgEnum("talent_profile_visibility", [
  "private",
  "published",
]);

// --- Go-to-market (§11i, Appendix B4). Declared here with the rest of the §6 family
//     because they belong to one domain, the same placement discoveryRegionKind gets.

/**
 * How far a supplier listing has been checked, and by whom it may be trusted.
 *
 * DEFAULTS TO `unverified` AND IS NEVER CLIENT-SETTABLE. A directory whose rows can
 * assert their own trust level is worse than no directory: the whole value of the field is
 * that only a platform moderator moves it.
 */
export const supplierVerificationStateEnum = pgEnum("supplier_verification_state", [
  "unverified", // listed, nothing checked
  "documents_pending", // a moderator has asked for paperwork
  "verified", // a moderator confirmed the entity exists and does what it claims
  "suspended", // listed but withdrawn from results pending a decision
]);

/** What a supplier can actually do. A curated vocabulary, never free text (§6). */
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

/**
 * How a supplier has agreed to be approached.
 *
 * `no_contact` exists because a curated directory will list entities that never asked to
 * be listed. A row a moderator added from public information must be able to say "reference
 * only" rather than becoming an inbox nobody consented to.
 */
export const supplierContactPolicyEnum = pgEnum("supplier_contact_policy", [
  "via_platform",
  "direct_email",
  "no_contact",
]);

/** A project's own record of who it has approached. Never a claim about the supplier. */
export const projectSupplierEngagementStatusEnum = pgEnum("project_supplier_engagement_status", [
  "considering",
  "contacted",
  "contracted",
  "ended",
]);

/**
 * The project taxonomy. A TABLE, not a pgEnum, because the wizard's step 1 explicitly
 * lets a user create a category. A client-writable taxonomy is a spam surface, so
 * user-minted rows land `pending` and are excluded from public filter facets until a
 * platform moderator approves them.
 */
export const researchCategory = pgTable(
  "research_category",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    // Server-generated from `label` (lowercased, hyphenated). The stable ?category=
    // filter key across all three clients.
    //
    // UNIQUE here IS the de-duplication mechanism: "Cold Chain", "cold chain" and
    // "Cold-Chain" all slugify to `cold-chain`, so the second minter gets a 23505 the
    // service turns into 409. Deliberately the OPPOSITE of research_project.slug,
    // which auto-suffixes -2/-3 instead, because two projects may legitimately share
    // a name and two categories may not.
    slug: text("slug").notNull(),
    // Display label as typed, e.g. "Cold Chain". Clients render this, never the slug.
    label: text("label").notNull(),
    // Server-owned. Seed rows insert `approved`; user-minted rows `pending`.
    status: researchCategoryStatusEnum("status").default("pending").notNull(),
    // Which pin asset the problem map renders for this category (§6).
    //
    // NOT NULL DEFAULT 'other' so a user-minted category gets a working pin immediately,
    // without waiting on a moderator. Absent from every create schema — a minter must not
    // be able to choose their own map iconography — and assigned on approval instead.
    pinIconKey: categoryPinIconKeyEnum("pin_icon_key").default("other").notNull(),
    // NULL for seeded rows. `set null`, NOT cascade (§4f) — deleting a user must not
    // delete a taxonomy every other project points at.
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("research_category_slug_unq").on(table.slug),
    index("research_category_status_idx").on(table.status),
    index("research_category_createdByUserId_idx").on(table.createdByUserId),
  ],
);

/**
 * The central entity. An IDEA IS A PROJECT — there is no separate `idea` table.
 *
 * The wizard's fields are a strict subset of this table's columns, so a separate table
 * would duplicate nine columns and then need a copy-on-promote migration. Worse,
 * promotion would mint a NEW id, breaking the slug/URL identity and orphaning every
 * watcher and backlink accrued while it was an idea. `product.status` (draft|active,
 * publish gated server-side) already established exactly this shape.
 *
 * `stage` (the six-value pipeline position) is ORTHOGONAL to `status` (the lifecycle).
 * A draft project still has a stage. Do not conflate them by adding an "idea" seventh
 * stage — that would make ProjectStage a leaky union the frontend does not have.
 */
export const researchProject = pgTable(
  "research_project",
  {
    // INTERNAL identity. FK target for every child table. Never a URL path segment.
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    // PUBLIC identity — the [id] segment of /research-and-development/project/[id] and
    // the value generateStaticParams emits. SERVER-GENERATED from `name` (slugify plus
    // a -2/-3 collision suffix); there is no slug field in any request body. Mutable
    // only while unpublished; FROZEN at publish, because a live slug change 404s every
    // external link and every prebuilt static page.
    slug: text("slug").notNull(),
    // OWNER — the exact analogue of product.sellerId. Stamped from req.user.id, never
    // the body. `restrict`, NOT cascade: a cascade here reaches milestone →
    // escrow_release and lets one account deletion erase a financial ledger. This is
    // the single most load-bearing onDelete in the migration.
    founderUserId: text("founder_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    tagline: text("tagline").notNull(),
    description: text("description"),
    // Required to publish.
    problemStatement: text("problem_statement"),
    // The wizard never collects this — PATCH-only until the frontend gains a field.
    solutionSummary: text("solution_summary"),
    targetRegion: text("target_region"),
    // The founder's OWN claim about demand. Explicitly NOT the verified demand signal
    // the knowledge hub computes (§6) — keep the two visually distinguishable on read
    // so an assertion is never mistaken for platform-verified evidence.
    demandEvidenceNotes: text("demand_evidence_notes"),
    // `restrict` — removing a category must not delete every project in it.
    categoryId: text("category_id")
      .notNull()
      .references(() => researchCategory.id, { onDelete: "restrict" }),
    // Founder-settable, but ONLY via PATCH /:slug/stage, which also writes a
    // project_stage_transition row — never as a field on the general PATCH.
    stage: projectStageEnum("stage").default("market_research").notNull(),
    // SERVER-OWNED. No request schema contains `status`; .strict() rejects it. Changed
    // only by /publish, /unpublish and /archive.
    status: researchProjectStatusEnum("status").default("draft").notNull(),
    // Server-owned, like product.currency. Not in §5's column list, added because §4b
    // forbids an amount travelling without its currency and the compensation strands
    // carry cents. One code per project; reads join it onto every money field.
    currency: text("currency").default("USD").notNull(),
    // Written ONLY by POST /:slug/cover, after the sharp decode/re-encode pipeline.
    // There is no coverImageUrl field in any JSON body — a client-supplied URL is an
    // SSRF and hotlink vector.
    coverImageUrl: text("cover_image_url"),
    // Deterministic: qatoto/research-projects/<projectId>/cover — re-upload overwrites.
    coverImagePublicId: text("cover_image_public_id"),
    // Wizard INTENT. A text[] column, not a table — the same altitude call as
    // product.keyFeatures. At publish the service materializes one project_open_role
    // per entry and CLEARS this to {}, after which the column is historical.
    seedRolesNeeded: text("seed_roles_needed").array().notNull().default([]),
    // The founder's own advertised OFFER, in integer basis points. One of only TWO
    // places in this domain where a number legitimately enters through a request body
    // (§13) — it is a negotiated INPUT, like a seller setting priceInCents, not a
    // server-computed grant. An actual equity GRANT comes only from §9's ledger.
    offeredEquityBasisPointsMin: integer("offered_equity_basis_points_min"),
    offeredEquityBasisPointsMax: integer("offered_equity_basis_points_max"),
    expectedCommitment: roleCommitmentEnum("expected_commitment"),
    // NOTE: there is deliberately NO reserveEquityBasisPoints column. §9.5 rejects the
    // reserve slice pool outright — it reintroduces founder fiat, the one thing this
    // product exists to eliminate — and replaces it with a computed open-role
    // projection that lives outside the denominator.
    publishedAt: timestamp("published_at"),
    archivedAt: timestamp("archived_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("research_project_slug_unq").on(table.slug),
    index("research_project_founderUserId_idx").on(table.founderUserId),
    index("research_project_status_idx").on(table.status),
    index("research_project_status_stage_idx").on(table.status, table.stage),
    index("research_project_categoryId_idx").on(table.categoryId),
    // §4c rule 4: every ORDER BY that feeds pagination ends in a UNIQUE column, or a
    // cursor silently skips rows. Matches ORDER BY published_at DESC, id DESC.
    index("research_project_status_publishedAt_idx").on(table.status, table.publishedAt, table.id),
    // The equity band is bounded in the DB as well as in Zod. The Zod refine catches a
    // single hostile payload; this catches an inverted band assembled across TWO
    // PATCHes, which no single-request check can see.
    check(
      "research_project_offered_equity_ck",
      sql`(offered_equity_basis_points_min IS NULL OR (offered_equity_basis_points_min BETWEEN 0 AND 10000))
          AND (offered_equity_basis_points_max IS NULL OR (offered_equity_basis_points_max BETWEEN 0 AND 10000))
          AND (offered_equity_basis_points_min IS NULL OR offered_equity_basis_points_max IS NULL
               OR offered_equity_basis_points_min <= offered_equity_basis_points_max)`,
    ),
    // An `active` row with no publishedAt sorts as NULL and is silently dropped by the
    // feed's ORDER BY — a published project that is invisible, with no error anywhere.
    check(
      "research_project_published_at_ck",
      sql`(status <> 'active') OR (published_at IS NOT NULL)`,
    ),
    check(
      "research_project_archived_at_ck",
      sql`(status = 'archived') = (archived_at IS NOT NULL)`,
    ),
    check("research_project_seed_roles_ck", sql`cardinality(seed_roles_needed) <= 20`),
  ],
);

/**
 * The counter sidecar — 1:1 with a project, created in the same transaction.
 *
 * WHY A SIDECAR rather than columns on research_project: that table's `updatedAt` uses
 * $onUpdate, so putting watchersCount on it would bump updatedAt every time a stranger
 * taps the watch button — poisoning "recently updated" ordering, every cache key
 * derived from updatedAt, and generating index churn on the hottest row in the domain.
 * Cold entity row + hot stats row is the correct split, and the 1:1 join is on the
 * primary key, so it is effectively free.
 *
 * NULLABILITY IS LOAD-BEARING. The four transactional counters are NOT NULL DEFAULT 0
 * because zero genuinely is the count. The job-computed fields are NULLABLE WITH NO
 * DEFAULT because no job exists in this phase: defaulting allocatedEquityBasisPoints
 * to 0 would render a number that directly contradicts §9.4's invariant (it must equal
 * 10000 on any non-degenerate project) as fact, on a surface whose entire product
 * argument is objective verifiable math. NULL is the honest value.
 */
export const projectStats = pgTable(
  "project_stats",
  {
    // PK and FK at once — exactly one stats row per project. Cascade is one of only
    // two R1 exceptions: this is a rebuildable cache with no independent value.
    projectId: text("project_id")
      .primaryKey()
      .references(() => researchProject.id, { onDelete: "cascade" }),
    // Counter column, not computed-on-read. project_watcher stays the source of truth;
    // this is a cache incremented in the SAME transaction as the watcher insert and
    // reconciled by scripts/reconcile-project-stats.ts.
    watchersCount: integer("watchers_count").default(0).notNull(),
    // Active members. Defaults to 1 — the founder row is inserted at create.
    teamMemberCount: integer("team_member_count").default(1).notNull(),
    openRoleCount: integer("open_role_count").default(0).notNull(),
    // Founder-facing only; never in the public projection.
    pendingApplicationCount: integer("pending_application_count").default(0).notNull(),
    // IANA zone. Without it "a day" is undefined and a distributed team double-counts
    // a streak. Set to UTC at create and NOT WRITABLE by any endpoint in this phase: a
    // client-settable day boundary is a client-settable input into an equity
    // computation (§13), and this table must stay 100% server-computed.
    projectTimeZone: text("project_time_zone").default("UTC").notNull(),
    // --- Below here: written only by §8/§9 jobs that do not exist yet. See the
    // --- nullability note above; these stay NULL until their phase lands.
    dailyLogStreakDays: integer("daily_log_streak_days"),
    // Date-only ISO string, the §1 wire format, with no Date object to reinterpret in
    // a local zone on the way out.
    lastDailyLogDate: date("last_daily_log_date", { mode: "string" }),
    verifiedEffortMinutesTotal: integer("verified_effort_minutes_total"),
    allocatedEquityBasisPoints: integer("allocated_equity_basis_points"),
    // Returned to clients so all three render an "as of" and never imply live numbers.
    statsComputedAt: timestamp("stats_computed_at"),
  },
  // No `table` parameter: this table declares only CHECK constraints, whose raw SQL
  // references column names directly. The PK/FK is on projectId, so it needs no
  // separate index.
  () => [
    check(
      "project_stats_counters_non_negative_ck",
      sql`watchers_count >= 0 AND team_member_count >= 0
          AND open_role_count >= 0 AND pending_application_count >= 0`,
    ),
    check(
      "project_stats_allocated_equity_ck",
      sql`allocated_equity_basis_points IS NULL
          OR (allocated_equity_basis_points BETWEEN 0 AND 10000)`,
    ),
    check(
      "project_stats_effort_minutes_ck",
      sql`verified_effort_minutes_total IS NULL OR verified_effort_minutes_total >= 0`,
    ),
  ],
);

/** A role the project is hiring for. `OpenRole.projectName` is NOT stored — it joins. */
export const projectOpenRole = pgTable(
  "project_open_role",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    roleTitle: text("role_title").notNull(),
    skills: text("skills").array().notNull().default([]),
    commitment: roleCommitmentEnum("commitment").notNull(),
    status: openRoleStatusEnum("status").default("open").notNull(),
    slotsTotal: integer("slots_total").default(1).notNull(),
    // Server-owned counter, incremented ONLY inside the accept transaction.
    slotsFilledCount: integer("slots_filled_count").default(0).notNull(),
    description: text("description"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("project_open_role_projectId_idx").on(table.projectId),
    index("project_open_role_status_commitment_idx").on(table.status, table.commitment),
    index("project_open_role_status_createdAt_idx").on(table.status, table.createdAt, table.id),
    // GET /open-roles?skill= is otherwise a sequential scan over every open role on the
    // platform.
    index("project_open_role_skills_gin").using("gin", table.skills),
    check(
      "project_open_role_slots_ck",
      sql`slots_total BETWEEN 1 AND 50 AND slots_filled_count BETWEEN 0 AND slots_total`,
    ),
    // `filled` is SERVER-DERIVED and recomputed inside every transaction that changes
    // slotsFilledCount or slotsTotal. This constraint makes a MISSED recompute fail
    // loudly inside the transaction that caused it, rather than silently stranding an
    // open seat nobody can apply for.
    check(
      "project_open_role_open_not_full_ck",
      sql`NOT (status = 'open' AND slots_filled_count >= slots_total)`,
    ),
    check("project_open_role_skills_ck", sql`cardinality(skills) <= 30`),
  ],
);

/**
 * One compensation strand of an open role.
 *
 * A TABLE, not a jsonb column, because each strand has a kind-specific numeric range
 * that must be independently QUERYABLE ("roles offering ≥ 3% equity", "roles paying
 * ≥ $4k/mo") and independently validated. It replaces the frontend's
 * `CompensationComponent.amountLabel` display string.
 *
 * Money is bigint per §4b, with mode:"number" rather than "bigint" because
 * JSON.stringify throws on a BigInt and these values go straight onto the wire; 2^53
 * cents is ~$90 trillion, far beyond any salary band. (product.priceInCents is
 * `integer` — the store domain predates §4b and is slated for widening. bigint is
 * canonical for new money columns.)
 */
export const openRoleCompensation = pgTable(
  "open_role_compensation",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    // Cascade: a strand is meaningless without its role, carries no history, and roles
    // are deletable while unengaged.
    openRoleId: text("open_role_id")
      .notNull()
      .references(() => projectOpenRole.id, { onDelete: "cascade" }),
    kind: compensationKindEnum("kind").notNull(),
    salaryMinInCentsPerMonth: bigint("salary_min_in_cents_per_month", { mode: "number" }),
    salaryMaxInCentsPerMonth: bigint("salary_max_in_cents_per_month", { mode: "number" }),
    oneTimeMinInCents: bigint("one_time_min_in_cents", { mode: "number" }),
    oneTimeMaxInCents: bigint("one_time_max_in_cents", { mode: "number" }),
    // Advertised offer only. NEVER a granted share — grants come solely from §9.
    equityBasisPointsMin: integer("equity_basis_points_min"),
    equityBasisPointsMax: integer("equity_basis_points_max"),
    earnedAsPolicy: compensationEarnedAsPolicyEnum("earned_as_policy").notNull(),
    // Optional prose ALONGSIDE the policy, never instead of it.
    earnedAsNote: text("earned_as_note"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    // Enforces the frontend type's documented "at most one strand per kind" invariant
    // in the database instead of in a comment.
    uniqueIndex("open_role_compensation_openRoleId_kind_unq").on(table.openRoleId, table.kind),
    index("open_role_compensation_kind_equityMin_idx").on(table.kind, table.equityBasisPointsMin),
    index("open_role_compensation_kind_salaryMin_idx").on(
      table.kind,
      table.salaryMinInCentsPerMonth,
    ),
    // These columns are a discriminated union flattened into one row; this CHECK is
    // what keeps the illegal states unrepresentable after flattening. Without it a
    // `salary` strand can carry an equity band that no read projection displays but
    // the ?minEquityBasisPoints= filter silently matches.
    check(
      "open_role_compensation_kind_columns_ck",
      sql`
      (kind = 'salary' AND salary_min_in_cents_per_month IS NOT NULL
                       AND one_time_min_in_cents IS NULL AND one_time_max_in_cents IS NULL
                       AND equity_basis_points_min IS NULL AND equity_basis_points_max IS NULL)
      OR (kind = 'one_time' AND one_time_min_in_cents IS NOT NULL
                       AND salary_min_in_cents_per_month IS NULL AND salary_max_in_cents_per_month IS NULL
                       AND equity_basis_points_min IS NULL AND equity_basis_points_max IS NULL)
      OR (kind = 'equity' AND equity_basis_points_min IS NOT NULL
                       AND salary_min_in_cents_per_month IS NULL AND salary_max_in_cents_per_month IS NULL
                       AND one_time_min_in_cents IS NULL AND one_time_max_in_cents IS NULL)`,
    ),
    // A founder cannot advertise a mechanism that does not exist. Equity vests through
    // Slicing Pie; cash is paid by the company and reported here (§7A).
    //
    // THE TWO ESCROW VALUES ARE ABSENT FROM BOTH BRANCHES, which is what makes them
    // readable-but-unwritable: migration 0010's rows still parse, and no new row can
    // carry one. This is the database half of the rule — the Zod schema refuses them
    // first, with a typed 422 — because a rule with no database behind it is a
    // convention, and this one has a statute behind it (§0, §7A.6 item 2).
    check(
      "open_role_compensation_policy_pairing_ck",
      sql`
      (kind = 'equity' AND earned_as_policy = 'slicing_pie_vesting')
      OR (kind IN ('salary','one_time')
          AND earned_as_policy IN ('off_platform_payroll','direct_transfer'))`,
    ),
    check(
      "open_role_compensation_ranges_ck",
      sql`
      (salary_min_in_cents_per_month IS NULL OR salary_min_in_cents_per_month >= 0)
      AND (salary_max_in_cents_per_month IS NULL OR salary_max_in_cents_per_month >= salary_min_in_cents_per_month)
      AND (one_time_min_in_cents IS NULL OR one_time_min_in_cents >= 0)
      AND (one_time_max_in_cents IS NULL OR one_time_max_in_cents >= one_time_min_in_cents)
      AND (equity_basis_points_min IS NULL OR equity_basis_points_min BETWEEN 0 AND 10000)
      AND (equity_basis_points_max IS NULL OR (equity_basis_points_max >= equity_basis_points_min
                                               AND equity_basis_points_max <= 10000))`,
    ),
  ],
);

/**
 * A person asking to join a project — ONE table, TWO directions of intent,
 * discriminated by `kind`, which the SERVER derives from whether openRoleId is
 * present. `.strict()` rejects a client-sent `kind`.
 *
 * Kept separate from project_member because applications have states membership does
 * not (pending/declined/withdrawn/expired), carry a payload membership never should,
 * and must survive rejection for anti-spam and audit. Merging them would permit the
 * contradictory state "a member who was declined".
 */
export const projectApplication = pgTable(
  "project_application",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    // `restrict`, not `set null`: nulling it would leave kind='role_interest' with no
    // role, contradicting the CHECK below. Deleting an engaged role returns 409
    // instead; closing it is the intended path.
    openRoleId: text("open_role_id").references(() => projectOpenRole.id, {
      onDelete: "restrict",
    }),
    // `restrict` (§5: applications "must survive rejection for anti-spam and audit").
    // Note a cascade here would fire ONLY for users with no membership — i.e. for
    // pending/declined/withdrawn rows, which is exactly the spam corpus, and exactly
    // the population a spammer belongs to.
    applicantUserId: text("applicant_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    kind: projectApplicationKindEnum("kind").notNull(),
    status: projectApplicationStatusEnum("status").default("pending").notNull(),
    shortPitch: text("short_pitch").notNull(),
    // Validated server-side as a SUBSET of the role's own skills — the sheet renders
    // its chips from that array, so anything else is a forged payload.
    selectedSkills: text("selected_skills").array().notNull().default([]),
    statedCommitment: roleCommitmentEnum("stated_commitment").notNull(),
    // Copied from the role at apply time so an accepted member's display title
    // survives a later role rename.
    roleTitleSnapshot: text("role_title_snapshot"),
    // The applicant's own ask. Permitted in the body precisely because it is theirs —
    // but it is never read by the ledger, never influences a grant, and must render as
    // "applicant's stated expectation".
    expectedCompensationNote: text("expected_compensation_note"),
    reviewNote: text("review_note"),
    reviewedByUserId: text("reviewed_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    decidedAt: timestamp("decided_at"),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("project_application_projectId_status_idx").on(table.projectId, table.status),
    index("project_application_applicantUserId_idx").on(table.applicantUserId),
    index("project_application_openRoleId_idx").on(table.openRoleId),
    index("project_application_expiresAt_idx")
      .on(table.expiresAt)
      .where(sql`status = 'pending'`),
    // ONE LIVE application per person per role. Partial, so a withdrawn or declined row
    // does not block a genuine re-apply.
    //
    // TWO indexes, not one: Postgres UNIQUE treats NULLs as DISTINCT, so a single index
    // over (project, applicant, open_role_id) would let one user file unlimited
    // join_requests against the same project.
    uniqueIndex("project_application_live_role_unq")
      .on(table.projectId, table.applicantUserId, table.openRoleId)
      .where(sql`status = 'pending' AND kind = 'role_interest'`),
    uniqueIndex("project_application_live_join_unq")
      .on(table.projectId, table.applicantUserId)
      .where(sql`status = 'pending' AND kind = 'join_request'`),
    // `kind` is server-derived from openRoleId's presence; this makes the derivation an
    // invariant of STORAGE, so a controller that forgets cannot persist a lie.
    check(
      "project_application_kind_role_ck",
      sql`
      (kind = 'role_interest' AND open_role_id IS NOT NULL)
      OR (kind = 'join_request' AND open_role_id IS NULL)`,
    ),
    // `decided_at` means "a HUMAN decided". `expired` is machine-set by the sweep and
    // carries no decider — without that second disjunct the sweep's own UPDATE raises
    // 23514 on its first row and nothing ever expires.
    check(
      "project_application_decided_at_ck",
      sql`(status IN ('pending','expired')) = (decided_at IS NULL)`,
    ),
    check("project_application_selected_skills_ck", sql`cardinality(selected_skills) <= 30`),
  ],
);

/**
 * A project inviting a person — the other direction from project_application, and a
 * separate table because the actor, the authorization check and the accept semantics
 * all differ.
 */
export const projectInvite = pgTable(
  "project_invite",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    openRoleId: text("open_role_id").references(() => projectOpenRole.id, {
      onDelete: "restrict",
    }),
    // Cascade: a pending offer to a deleted account is dead weight, and an invite bears
    // no equity, effort or audit weight of its own (§4f R2).
    inviteeUserId: text("invitee_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    invitedByUserId: text("invited_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    status: projectInviteStatusEnum("status").default("pending").notNull(),
    roleTitle: text("role_title"),
    message: text("message"),
    respondedAt: timestamp("responded_at"),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("project_invite_inviteeUserId_status_idx").on(table.inviteeUserId, table.status),
    index("project_invite_projectId_status_idx").on(table.projectId, table.status),
    index("project_invite_openRoleId_idx").on(table.openRoleId),
    index("project_invite_expiresAt_idx")
      .on(table.expiresAt)
      .where(sql`status = 'pending'`),
    uniqueIndex("project_invite_live_role_unq")
      .on(table.projectId, table.inviteeUserId, table.openRoleId)
      .where(sql`status = 'pending' AND open_role_id IS NOT NULL`),
    uniqueIndex("project_invite_live_project_unq")
      .on(table.projectId, table.inviteeUserId)
      .where(sql`status = 'pending' AND open_role_id IS NULL`),
    // Self-invite is the cheapest way to fabricate a membership provenance record.
    check("project_invite_no_self_ck", sql`invitee_user_id <> invited_by_user_id`),
    check(
      "project_invite_responded_at_ck",
      sql`(status IN ('pending','expired')) = (responded_at IS NULL)`,
    ),
  ],
);

/**
 * Membership as a GRANTED STATE — strictly separate from project_application, which is
 * a REQUEST. Carries no equity and no effort columns; both are derived (§9).
 *
 * NOT COLUMNS, deliberately:
 *   - `equityBasisPoints` / `verifiedEffortMinutes` — derived by §9's ledger. There is
 *     no writable equity column anywhere in this schema.
 *   - `isFounder` — computed on read as `projectRole === "founder"`. Storing both
 *     permits the contradictory state isFounder:true + projectRole:'contributor'.
 *   - `name` / `avatarImageSrc` — joined from `user` on read. A copy drifts the moment
 *     someone changes their photo.
 *
 * This row holds CURRENT STATE only; project_member_interval holds the history.
 */
export const projectMember = pgTable(
  "project_member",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    // `restrict` (§4a: "membership is never hard-deleted"). Also structural: a cascade
    // would drop a founder row and let project_member_projectId_founder_unq admit a
    // NEW founder to a project whose founderUserId still names the deleted user.
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    // Server-owned. Accepting an application always yields `contributor`; `founder` is
    // written exactly once, by the create transaction, and is never assignable.
    projectRole: projectMemberRoleEnum("project_role").default("contributor").notNull(),
    // Free DISPLAY text ("Refrigeration Engineer"). Distinct from projectRole, which is
    // a permission — and never consulted by an authorization check.
    roleTitle: text("role_title"),
    skills: text("skills").array().notNull().default([]),
    status: projectMemberStatusEnum("status").default("active").notNull(),
    // Server-set from the accept transaction. A client-chosen join date would back-date
    // slice accrual. Denormalized copy of the FIRST interval's joinedAt, kept for cheap
    // roster reads — §9 must accrue from project_member_interval, never from this.
    joinedAt: timestamp("joined_at").defaultNow().notNull(),
    leftAt: timestamp("left_at"),
    // Provenance. `set null` — the membership outlives the request that created it.
    sourceApplicationId: text("source_application_id").references(() => projectApplication.id, {
      onDelete: "set null",
    }),
    sourceInviteId: text("source_invite_id").references(() => projectInvite.id, {
      onDelete: "set null",
    }),
    // Who ended this person's accrual — exactly the record a §9 dispute needs.
    removedByUserId: text("removed_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    // WHO GRANTED THIS ROLE. §4a: `admin` exists to co-sign an escrow release (§7's
    // four-eyes rule), and that rule is defeated the moment a founder can grant `admin`
    // to themselves. Today no endpoint assigns `admin` at all — updateProjectMember's
    // enum is `maintainer | contributor` — so the rule holds by ACCIDENT of a missing
    // feature. This column plus the CHECK below makes it STRUCTURAL, so the day an
    // admin-grant endpoint lands it cannot reintroduce the hole.
    //
    // NULL for the founder row (nobody granted it — the create transaction wrote it) and
    // for every row predating this column. `escrow-releases.service.ts` treats NULL on an
    // `admin` row as un-provenanced and refuses it as an approver.
    roleGrantedByUserId: text("role_granted_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    // One membership row per person per project, EVER. Re-joining reactivates this row
    // and opens a new interval rather than inserting a second one.
    uniqueIndex("project_member_projectId_userId_unq").on(table.projectId, table.userId),
    index("project_member_userId_idx").on(table.userId),
    index("project_member_projectId_status_idx").on(table.projectId, table.status),
    // Exactly one founder per project, enforced by Postgres rather than by hope.
    // Deliberately NOT filtered on status: a `left` founder still occupies the slot, so
    // founder transfer must DEMOTE then PROMOTE inside ONE transaction.
    uniqueIndex("project_member_projectId_founder_unq")
      .on(table.projectId)
      .where(sql`project_role = 'founder'`),
    check("project_member_left_at_ck", sql`(status = 'active') = (left_at IS NULL)`),
    // Reactivation must CLEAR removedByUserId, or this raises 23514 on re-join.
    check(
      "project_member_removed_by_ck",
      sql`(removed_by_user_id IS NULL) OR (status = 'removed')`,
    ),
    check("project_member_left_after_joined_ck", sql`left_at IS NULL OR left_at >= joined_at`),
    check("project_member_skills_ck", sql`cardinality(skills) <= 30`),
    // THE FOUR-EYES RULE, AT THE COLUMN LEVEL (§4a, §7). An `admin` cannot have granted
    // themselves the role that lets them co-sign a payout. Postgres refuses the row; no
    // service needs to remember to.
    check(
      "project_member_role_granted_by_ck",
      sql`(project_role <> 'admin')
          OR (role_granted_by_user_id IS NULL)
          OR (role_granted_by_user_id <> user_id)`,
    ),
  ],
);

/**
 * Membership HISTORY — one row per stint. APPEND-ONLY (§4f): a BEFORE UPDATE OR DELETE
 * trigger rejects mutation, added by hand in the migration.
 *
 * Why this table exists: a single (joinedAt, leftAt) pair on project_member cannot
 * represent join → leave → rejoin. Keeping the original joinedAt fabricates equity for
 * the gap; overwriting it destroys the first stint. There is no third option with one
 * row and two columns. §9 accrues slices over [joinedAt, leftAt) PER STINT, so this is
 * the accrual source — project_member.joinedAt is a convenience copy, not the truth.
 *
 * Every parent FK is `restrict`, without exception, so the §4f audit sweep is
 * mechanical.
 */
export const projectMemberInterval = pgTable(
  "project_member_interval",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    memberId: text("member_id")
      .notNull()
      .references(() => projectMember.id, { onDelete: "restrict" }),
    joinedAt: timestamp("joined_at").defaultNow().notNull(),
    // NULL while the stint is open.
    leftAt: timestamp("left_at"),
    endedReason: memberIntervalEndReasonEnum("ended_reason"),
    endedByUserId: text("ended_by_user_id").references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("project_member_interval_memberId_joinedAt_idx").on(
      table.memberId,
      table.joinedAt,
      table.id,
    ),
    // At most ONE open stint per member. Without this a double-accept opens two
    // overlapping intervals and §9 pays the overlap twice.
    uniqueIndex("project_member_interval_open_unq")
      .on(table.memberId)
      .where(sql`left_at IS NULL`),
    check("project_member_interval_order_ck", sql`left_at IS NULL OR left_at > joined_at`),
    // A closed stint names why and (for a removal) by whom; an open one names neither.
    check(
      "project_member_interval_ended_ck",
      sql`(left_at IS NULL) = (ended_reason IS NULL)
          AND (ended_by_user_id IS NULL OR ended_reason = 'removed')`,
    ),
  ],
);

/**
 * The watch join table. Composite natural PK, which makes POST /watch a plain
 * ON CONFLICT DO NOTHING and saves a pointless id column.
 */
export const projectWatcher = pgTable(
  "project_watcher",
  {
    // Cascade — the second and last R1 exception. A bookmark is rebuildable by the
    // user in one tap.
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.userId] }),
    index("project_watcher_userId_idx").on(table.userId),
  ],
);

/**
 * Append-only stage history behind PATCH /:slug/stage. The FIRST audit table in the
 * codebase — §7's escrow_journal_entry and §9's slice_ledger_entry attach to the SAME
 * trigger function in their own migrations.
 *
 * `fromStage` is nullable ON PURPOSE: the create transaction writes a genesis row
 * (NULL → market_research) so the history is replayable without knowing what the
 * column default happened to be on the day the row was inserted.
 */
export const projectStageTransition = pgTable(
  "project_stage_transition",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    fromStage: projectStageEnum("from_stage"),
    toStage: projectStageEnum("to_stage").notNull(),
    // `restrict` — §4f: audit tables restrict on EVERY parent FK, no exceptions, so
    // the cascade sweep needs no per-column reasoning.
    changedByUserId: text("changed_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    note: text("note"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    // NO updatedAt column, deliberately. An append-only table has nothing to update.
  },
  (table) => [
    index("project_stage_transition_projectId_createdAt_idx").on(
      table.projectId,
      table.createdAt,
      table.id,
    ),
    check("project_stage_transition_distinct_ck", sql`from_stage IS DISTINCT FROM to_stage`),
  ],
);

// ============================================================================
// §6 DISCOVERY — problem clusters, knowledge hub, talent directory
// ============================================================================

/**
 * Region lookup, so the demand leaderboard can JOIN rather than string-match (§6).
 *
 * A tree: `global` → `macro_region` ("East Africa") → `country` ("Kenya"). Only country
 * rows carry an ISO 3166-1 alpha-2 code, which is the landing target for reverse
 * geocoding — resolve a coordinate to alpha-2, find that row, walk parents for the
 * macro-region rollup the knowledge hub groups by.
 *
 * Seeded, with no write endpoint: a client-writable region table would let anyone mint
 * "Atlantis" and split the leaderboard.
 */
export const discoveryRegion = pgTable(
  "discovery_region",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    // The stable ?region= filter key across all three clients.
    slug: text("slug").notNull(),
    label: text("label").notNull(),
    kind: discoveryRegionKindEnum("kind").notNull(),
    parentRegionId: text("parent_region_id").references((): AnyPgColumn => discoveryRegion.id, {
      onDelete: "restrict",
    }),
    // `text` + a regex CHECK rather than char(2): bpchar blank-pads on comparison, which
    // makes 'KE' and 'KE ' equal in some contexts and not others.
    countryCode: text("country_code"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("discovery_region_slug_unq").on(table.slug),
    uniqueIndex("discovery_region_countryCode_unq")
      .on(table.countryCode)
      .where(sql`country_code IS NOT NULL`),
    index("discovery_region_parentRegionId_idx").on(table.parentRegionId),
    index("discovery_region_kind_idx").on(table.kind),
    check(
      "discovery_region_country_ck",
      sql`(kind = 'country') = (country_code IS NOT NULL)
          AND (country_code IS NULL OR country_code ~ '^[A-Z]{2}$')`,
    ),
    // Exactly one root, and it is the global row.
    check("discovery_region_root_ck", sql`(kind = 'global') = (parent_region_id IS NULL)`),
  ],
);

/**
 * The canonical skill vocabulary, replacing the frontend's free-text `string[]`.
 *
 * THIS TABLE IS A BUG FIX. `talent-filter-grid.tsx` filters with
 * `skills.some((skill) => skill.includes(chipText))` — a SUBSTRING match, so a "Water"
 * chip matches "Water Polo". Moving to slug equality makes that class of bug
 * unrepresentable rather than merely fixed.
 *
 * Seeded. There is no POST /discovery/skills in §11b, so there is no spam surface here
 * and therefore no moderation status — the difference from research_category is
 * deliberate, not an oversight.
 */
export const discoverySkill = pgTable(
  "discovery_skill",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    slug: text("slug").notNull(),
    label: text("label").notNull(),
    // `set null` — taxonomy rule (§4f). Deleting a category must not delete a skill.
    categoryId: text("category_id").references(() => researchCategory.id, {
      onDelete: "set null",
    }),
    // Retirement WITHOUT a DELETE: talent_profile_skill references this with `restrict`,
    // so a curated skill can never vanish out from under a published profile.
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("discovery_skill_slug_unq").on(table.slug),
    index("discovery_skill_categoryId_idx").on(table.categoryId),
    index("discovery_skill_active_label_idx")
      .on(table.label, table.id)
      .where(sql`is_active`),
  ],
);

/**
 * Geocode results, cached forever, keyed on the normalized query string.
 *
 * THIS TABLE IS THE DETERMINISM ANCHOR OF THE WHOLE SECTION, and it is not an
 * optimization. §4c requires every job to be a pure function of `(data, asOf)` — but an
 * external geocoder is NOT a pure function: providers re-tile, re-rank and re-license
 * their data, so the same query returns different coordinates months apart. Re-running
 * `geocode-and-cluster-submission` would then silently move a submission into a different
 * cluster and change a published opportunity score, with no code change and no audit
 * trail.
 *
 * So: geocode ONCE, store the result, and replay from this row forever. The provider is
 * consulted only on a cache miss. A re-run reads the same row and produces the same
 * cluster assignment, which is what makes the job replayable at all.
 *
 * MISSES ARE CACHED TOO (`not_found`). Re-asking a provider that already said "no such
 * place" burns the rate limit on a call that always fails, and for Nominatim's 1 req/s
 * budget that is the difference between a working queue and a stalled one.
 */
export const geocodeCache = pgTable(
  "geocode_cache",
  {
    // The PK IS the lookup key: the caller's location text, normalized (NFKC, lowercased,
    // collapsed whitespace) so "Nakuru County, Kenya" and "  nakuru  county,kenya " share
    // one row and one provider call.
    normalizedQuery: text("normalized_query").primaryKey(),
    // The raw text as the reporter typed it, kept for support and for re-geocoding under
    // a future provider without losing what was actually asked.
    originalQuery: text("original_query").notNull(),
    status: geocodeStatusEnum("status").notNull(),
    // NULL when status='not_found'. Integer microdegrees (§6) — never float.
    latitudeMicrodegrees: integer("latitude_microdegrees"),
    longitudeMicrodegrees: integer("longitude_microdegrees"),
    countryCode: text("country_code"),
    // Resolved from countryCode at cache-write time. `restrict`: a region row that
    // submissions point at through this cache must not disappear.
    regionId: text("region_id").references(() => discoveryRegion.id, { onDelete: "restrict" }),
    // A human-readable place name FROM THE PROVIDER, e.g. "Nakuru County, Kenya". This is
    // what the map renders — never the reporter's own typing, which is unverified.
    resolvedLabel: text("resolved_label"),
    // Which provider produced this, so a provider swap is auditable and a targeted
    // re-geocode can select exactly the rows one provider wrote.
    provider: text("provider").notNull(),
    fetchedAt: timestamp("fetched_at").defaultNow().notNull(),
  },
  (table) => [
    index("geocode_cache_countryCode_idx").on(table.countryCode),
    index("geocode_cache_status_idx").on(table.status),
    check(
      "geocode_cache_resolved_shape_ck",
      sql`(status = 'resolved') = (latitude_microdegrees IS NOT NULL)
          AND (latitude_microdegrees IS NULL) = (longitude_microdegrees IS NULL)
          AND (status = 'not_found' OR country_code IS NOT NULL)`,
    ),
    check(
      "geocode_cache_coordinate_range_ck",
      sql`(latitude_microdegrees IS NULL
           OR latitude_microdegrees BETWEEN -90000000 AND 90000000)
          AND (longitude_microdegrees IS NULL
               OR longitude_microdegrees BETWEEN -180000000 AND 180000000)`,
    ),
    check("geocode_cache_country_ck", sql`country_code IS NULL OR country_code ~ '^[A-Z]{2}$'`),
  ],
);

/**
 * ONE person's raw report. Never rendered directly — the map shows clusters (§6).
 *
 * The single most important modelling decision in this domain: `ProblemReport.reportCount
 * = 342` means 342 DIFFERENT PEOPLE reported the same problem, so the mock's
 * `ProblemReport` is not a submission, it is a CLUSTER. Two tables, not one.
 *
 * Coordinates are NULLABLE and JOB-WRITTEN, which departs from §11b's request body. The
 * report sheet collects a free-text location and has no coordinate capture at all, and
 * §6 forbids client-claimed geography — so the server forward-geocodes `locationText`
 * inside the job. There is no coordinate field for a client to forge because there is no
 * coordinate field at all.
 */
export const problemSubmission = pgTable(
  "problem_submission",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    // Stamped from req.user.id, NEVER a body field (§13).
    //
    // `restrict`, not cascade: this row is the evidence behind distinctReporterCount,
    // which is the entire sybil-resistance of the opportunity score. Account deletion is
    // anonymization, not erasure.
    reporterUserId: text("reporter_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    description: text("description").notNull(),
    categoryId: text("category_id")
      .notNull()
      .references(() => researchCategory.id, { onDelete: "restrict" }),
    // What the reporter TYPED. Never authoritative geography — it is the geocoder's
    // input, and the resolved label on the cluster is what clients render.
    locationText: text("location_text").notNull(),
    // --- Everything below is JOB-WRITTEN. None of it appears in any request schema.
    latitudeMicrodegrees: integer("latitude_microdegrees"),
    longitudeMicrodegrees: integer("longitude_microdegrees"),
    countryCode: text("country_code"),
    regionId: text("region_id").references(() => discoveryRegion.id, { onDelete: "restrict" }),
    status: problemSubmissionStatusEnum("status").default("queued").notNull(),
    clusterId: text("cluster_id").references((): AnyPgColumn => problemCluster.id, {
      onDelete: "restrict",
    }),
    clusteredAt: timestamp("clustered_at"),
    // 0..10000 basis points. The text similarity that justified the attach — auditable,
    // and the input a merge proposal is later re-derived from.
    clusterMatchBasisPoints: integer("cluster_match_basis_points"),
    // Why geocoding failed, for the human who has to look at it. NULL otherwise.
    geocodeFailureReason: text("geocode_failure_reason"),
    // MODERATOR-owned. The single predicate the score job filters on, so a sybil ring can
    // be struck from the count without deleting the evidence of it.
    countsTowardDistinctReporters: boolean("counts_toward_distinct_reporters")
      .default(true)
      .notNull(),
    moderationNote: text("moderation_note"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("problem_submission_clusterId_createdAt_idx").on(
      table.clusterId,
      table.createdAt,
      table.id,
    ),
    index("problem_submission_reporterUserId_createdAt_idx").on(
      table.reporterUserId,
      table.createdAt,
      table.id,
    ),
    // The job's work queue. Partial, so it stays tiny forever regardless of table size.
    index("problem_submission_queued_idx")
      .on(table.createdAt, table.id)
      .where(sql`status = 'queued'`),
    // THE clustering probe: a category-scoped bounding-box scan. This index is what
    // replaces PostGIS — leading categoryId, then latitude, then longitude.
    index("problem_submission_category_bbox_idx").on(
      table.categoryId,
      table.latitudeMicrodegrees,
      table.longitudeMicrodegrees,
    ),
    index("problem_submission_regionId_idx").on(table.regionId),
    check(
      "problem_submission_coordinate_range_ck",
      sql`(latitude_microdegrees IS NULL
           OR latitude_microdegrees BETWEEN -90000000 AND 90000000)
          AND (longitude_microdegrees IS NULL
               OR longitude_microdegrees BETWEEN -180000000 AND 180000000)
          AND (latitude_microdegrees IS NULL) = (longitude_microdegrees IS NULL)`,
    ),
    check(
      "problem_submission_country_ck",
      sql`country_code IS NULL OR country_code ~ '^[A-Z]{2}$'`,
    ),
    // Illegal states unrepresentable: 'clustered' IFF a cluster and a timestamp, and a
    // clustered row must have coordinates (it cannot have been placed without them).
    check(
      "problem_submission_cluster_shape_ck",
      sql`(status = 'clustered') = (cluster_id IS NOT NULL)
          AND (cluster_id IS NULL) = (clustered_at IS NULL)
          AND (cluster_id IS NULL OR latitude_microdegrees IS NOT NULL)`,
    ),
    check(
      "problem_submission_match_ck",
      sql`cluster_match_basis_points IS NULL
          OR cluster_match_basis_points BETWEEN 0 AND 10000`,
    ),
    check(
      "problem_submission_text_ck",
      sql`char_length(title) BETWEEN 1 AND 160
          AND char_length(description) BETWEEN 1 AND 5000
          AND char_length(location_text) BETWEEN 1 AND 200`,
    ),
  ],
);

/**
 * The deduplicated, scored, publicly rendered entity — `ProblemReport` in the frontend.
 *
 * THE CENTROID IS STORED AS A SUM PLUS A COUNT, not as a mean. §4c bans running-mean
 * updates because they are float and order-dependent: averaging in a new point drifts,
 * and two servers replaying the same attaches in different orders diverge. Storing the
 * sum makes the centroid a PURE FUNCTION of the multiset of member coordinates —
 * `divRoundHalfAwayFromZero(sum, count)` — so attach order cannot change it, and an
 * approved merge is exact integer addition of two sums.
 */
export const problemCluster = pgTable(
  "problem_cluster",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    // No slug: §11b addresses clusters by id, which saves an entire collision-suffix
    // mechanism for an entity nobody links to by name.
    title: text("title").notNull(),
    description: text("description").notNull(),
    categoryId: text("category_id")
      .notNull()
      .references(() => researchCategory.id, { onDelete: "restrict" }),
    // --- Geography. Job-written, recomputed from the full member set on every attach.
    centroidLatitudeMicrodegrees: integer("centroid_latitude_microdegrees").notNull(),
    centroidLongitudeMicrodegrees: integer("centroid_longitude_microdegrees").notNull(),
    // The exact rational behind the centroid. bigint: 1e6 members × 180e6 = 1.8e14, far
    // past int4 and comfortably inside 2^53.
    centroidLatitudeSumMicrodegrees: bigint("centroid_latitude_sum_microdegrees", {
      mode: "number",
    }).notNull(),
    centroidLongitudeSumMicrodegrees: bigint("centroid_longitude_sum_microdegrees", {
      mode: "number",
    }).notNull(),
    centroidSampleCount: integer("centroid_sample_count").notNull(),
    countryCode: text("country_code"),
    regionId: text("region_id").references(() => discoveryRegion.id, { onDelete: "restrict" }),
    // Reverse-geocoded from the centroid. "Nakuru County, Kenya".
    locationLabel: text("location_label"),
    status: problemClusterStatusEnum("status").default("active").notNull(),
    mergedIntoClusterId: text("merged_into_cluster_id").references(
      (): AnyPgColumn => problemCluster.id,
      { onDelete: "restrict" },
    ),
    // --- THE SYBIL SURFACE (§6). A cache of
    //     COUNT(DISTINCT reporter_user_id) FILTER (WHERE counts_toward_distinct_reporters),
    //     over IDENTIFIED submissions only. Reconciled nightly by the score job.
    distinctReporterCount: integer("distinct_reporter_count").default(0).notNull(),
    submissionCount: integer("submission_count").default(0).notNull(),
    firstReportedAt: timestamp("first_reported_at").notNull(),
    lastReportedAt: timestamp("last_reported_at").notNull(),
    // --- Read-side score denormalization, so ?minOpportunityScorePoints= hits an index
    //     instead of joining to the latest snapshot.
    //
    // NULLABLE WITH NO DEFAULT, matching project_stats' precedent. Defaulting to 0 would
    // render a fabricated ranking signal as fact before any job has run: an unscored
    // cluster is UNSCORED, not worthless, and a client must be able to tell them apart.
    currentOpportunityScorePoints: integer("current_opportunity_score_points"),
    scoreComputedAt: timestamp("score_computed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    // The map + landing teaser. Partial on the only set the public endpoint reads, and
    // the unique tail satisfies §4c rule 4.
    index("problem_cluster_active_score_idx")
      .on(table.currentOpportunityScorePoints, table.id)
      .where(sql`status = 'active'`),
    // Viewport bounding-box query, so the map fetches what is on screen, not the planet.
    index("problem_cluster_active_bbox_idx")
      .on(table.centroidLatitudeMicrodegrees, table.centroidLongitudeMicrodegrees)
      .where(sql`status = 'active'`),
    index("problem_cluster_category_score_idx")
      .on(table.categoryId, table.currentOpportunityScorePoints, table.id)
      .where(sql`status = 'active'`),
    index("problem_cluster_region_score_idx")
      .on(table.regionId, table.currentOpportunityScorePoints, table.id)
      .where(sql`status = 'active'`),
    index("problem_cluster_mergedIntoClusterId_idx").on(table.mergedIntoClusterId),
    check(
      "problem_cluster_centroid_range_ck",
      sql`centroid_latitude_microdegrees BETWEEN -90000000 AND 90000000
          AND centroid_longitude_microdegrees BETWEEN -180000000 AND 180000000`,
    ),
    check("problem_cluster_sample_count_ck", sql`centroid_sample_count >= 1`),
    check(
      "problem_cluster_counts_ck",
      sql`distinct_reporter_count >= 0
          AND submission_count >= distinct_reporter_count
          AND submission_count >= centroid_sample_count`,
    ),
    check(
      "problem_cluster_merged_ck",
      sql`(status = 'merged') = (merged_into_cluster_id IS NOT NULL)
          AND (merged_into_cluster_id IS DISTINCT FROM id)`,
    ),
    check("problem_cluster_reported_order_ck", sql`last_reported_at >= first_reported_at`),
    check(
      "problem_cluster_score_ck",
      sql`(current_opportunity_score_points IS NULL
           OR current_opportunity_score_points BETWEEN 0 AND 100)
          AND (current_opportunity_score_points IS NULL) = (score_computed_at IS NULL)`,
    ),
    check("problem_cluster_country_ck", sql`country_code IS NULL OR country_code ~ '^[A-Z]{2}$'`),
  ],
);

/**
 * Job-written opportunity scores, APPEND-ONLY, each carrying the `asOf` it was computed
 * against (§4c rule 3) and ABSOLUTE window bounds rather than a day count.
 *
 * Every INPUT is stored alongside the score, not just the result. A score you cannot
 * explain is indistinguishable from a bug — and the components CHECK below makes the
 * subscores genuinely load-bearing rather than decorative: if a formula change breaks the
 * sum, the transaction that caused it fails, in the job that caused it.
 *
 * Rows are protected by an append-only trigger added by hand in the migration, reusing
 * the qatoto_reject_mutation() function migration 0010 already installed.
 */
export const problemClusterScoreSnapshot = pgTable(
  "problem_cluster_score_snapshot",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    // `restrict` on every parent FK — §4f, the project_stage_transition precedent, so the
    // cascade sweep needs no per-column reasoning.
    clusterId: text("cluster_id")
      .notNull()
      .references(() => problemCluster.id, { onDelete: "restrict" }),
    asOf: timestamp("as_of").notNull(),
    windowStartsAt: timestamp("window_starts_at").notNull(),
    windowEndsAt: timestamp("window_ends_at").notNull(),
    opportunityScorePoints: integer("opportunity_score_points").notNull(),
    // --- Inputs, so the score is reproducible without replaying history.
    distinctReporterCount: integer("distinct_reporter_count").notNull(),
    submissionCount: integer("submission_count").notNull(),
    distinctRegionCount: integer("distinct_region_count").notNull(),
    categoryShareBasisPoints: integer("category_share_basis_points").notNull(),
    // Whole days between the cluster's last report and `asOf`, both truncated to UTC
    // midnight. An INTEGER, because exp(-age/halfLife) is float and §4c bans it.
    ageInDays: integer("age_in_days").notNull(),
    linkedProjectCount: integer("linked_project_count").notNull(),
    // --- Components. Their sum IS the score, asserted by a CHECK.
    reporterComponentPoints: integer("reporter_component_points").notNull(),
    spreadComponentPoints: integer("spread_component_points").notNull(),
    demandComponentPoints: integer("demand_component_points").notNull(),
    recencyComponentPoints: integer("recency_component_points").notNull(),
    scarcityComponentPoints: integer("scarcity_component_points").notNull(),
    // The §4c hashVersion analogue: the formula may evolve without invalidating history.
    scoreAlgorithmVersion: integer("score_algorithm_version").default(1).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    // NO updatedAt, deliberately. An append-only table has nothing to update.
  },
  (table) => [
    // IDEMPOTENCY (§4e: "a job that cannot be safely re-run is a bug"). A re-run at the
    // same asOf is an ON CONFLICT DO NOTHING, not a duplicate row.
    uniqueIndex("problem_cluster_score_snapshot_clusterId_asOf_unq").on(
      table.clusterId,
      table.asOf,
    ),
    index("problem_cluster_score_snapshot_clusterId_asOf_idx").on(
      table.clusterId,
      table.asOf,
      table.id,
    ),
    index("problem_cluster_score_snapshot_asOf_idx").on(table.asOf, table.id),
    check(
      "problem_cluster_score_snapshot_score_ck",
      sql`opportunity_score_points BETWEEN 0 AND 100`,
    ),
    check(
      "problem_cluster_score_snapshot_window_ck",
      sql`window_ends_at > window_starts_at AND as_of >= window_ends_at`,
    ),
    check(
      "problem_cluster_score_snapshot_inputs_ck",
      sql`distinct_reporter_count >= 0
          AND submission_count >= distinct_reporter_count
          AND distinct_region_count >= 0
          AND category_share_basis_points BETWEEN 0 AND 10000
          AND linked_project_count >= 0`,
    ),
    // The invariant worth having: the components ARE the score.
    check(
      "problem_cluster_score_snapshot_components_ck",
      sql`reporter_component_points >= 0 AND spread_component_points >= 0
          AND demand_component_points >= 0 AND recency_component_points >= 0
          AND scarcity_component_points >= 0
          AND reporter_component_points + spread_component_points + demand_component_points
              + recency_component_points + scarcity_component_points
              = opportunity_score_points`,
    ),
  ],
);

/**
 * The moderator queue for suspected duplicate clusters. Directional: `source` is absorbed
 * INTO `target`.
 *
 * The one-open-proposal-per-UNORDERED-pair guarantee cannot be expressed as a Drizzle
 * index because it indexes LEAST/GREATEST expressions — it is added by hand in the
 * migration. Without it, A→B and B→A both sit in the queue and can both be approved.
 */
export const problemClusterMergeProposal = pgTable(
  "problem_cluster_merge_proposal",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    sourceClusterId: text("source_cluster_id")
      .notNull()
      .references(() => problemCluster.id, { onDelete: "restrict" }),
    targetClusterId: text("target_cluster_id")
      .notNull()
      .references(() => problemCluster.id, { onDelete: "restrict" }),
    status: clusterMergeProposalStatusEnum("status").default("pending").notNull(),
    source: clusterMergeProposalSourceEnum("source").default("job_similarity").notNull(),
    // The evidence, in integers: 0..10000 basis points of text similarity, and an integer
    // metre distance from the fixed integer approximation — never float haversine (§6).
    similarityBasisPoints: integer("similarity_basis_points").notNull(),
    centroidDistanceMetres: integer("centroid_distance_metres").notNull(),
    asOf: timestamp("as_of").notNull(),
    // NULL for job-raised proposals, which is most of them.
    proposedByUserId: text("proposed_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    // `restrict`: who approved a destructive, irreversible merge is audit weight.
    decidedByUserId: text("decided_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    decidedAt: timestamp("decided_at"),
    decisionNote: text("decision_note"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("problem_cluster_merge_proposal_pending_idx")
      .on(table.createdAt, table.id)
      .where(sql`status = 'pending'`),
    index("problem_cluster_merge_proposal_sourceClusterId_idx").on(table.sourceClusterId),
    index("problem_cluster_merge_proposal_targetClusterId_idx").on(table.targetClusterId),
    check(
      "problem_cluster_merge_proposal_distinct_ck",
      sql`source_cluster_id <> target_cluster_id`,
    ),
    check(
      "problem_cluster_merge_proposal_decided_ck",
      sql`(status = 'pending') = (decided_at IS NULL)
          AND (decided_by_user_id IS NULL) = (decided_at IS NULL)`,
    ),
    check(
      "problem_cluster_merge_proposal_evidence_ck",
      sql`similarity_basis_points BETWEEN 0 AND 10000 AND centroid_distance_metres >= 0`,
    ),
  ],
);

/**
 * The cluster ↔ project backlink, behind the "Born from Civic Pulse report" chip and the
 * linked-project-scarcity input to the opportunity score.
 *
 * Many-to-many: a cluster can spawn several projects and a project can address several
 * clusters. §5's prose describes a scalar `research_project.originProblemClusterId`
 * column — that column does not exist, so this table replaces it rather than duplicating
 * it. Storing both would put one fact in two writable places, the exact failure mode the
 * schema rejects by name for `isFounder` and `TeamMember.name`.
 */
export const problemClusterProjectLink = pgTable(
  "problem_cluster_project_link",
  {
    clusterId: text("cluster_id")
      .notNull()
      .references(() => problemCluster.id, { onDelete: "restrict" }),
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    source: problemClusterLinkSourceEnum("source").notNull(),
    linkedByUserId: text("linked_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.clusterId, table.projectId] }),
    index("problem_cluster_project_link_projectId_idx").on(table.projectId),
    // "Born from" is 1:1 — at most one ORIGIN cluster per project, enforced by Postgres
    // rather than by hope. This is what replaces the scalar column.
    uniqueIndex("problem_cluster_project_link_origin_unq")
      .on(table.projectId)
      .where(sql`source = 'origin'`),
  ],
);

/**
 * Knowledge-hub insight cards.
 *
 * `MarketInsight.statValue` in the mocks is one string column holding "+34%",
 * "68M people", "3× coverage" and "-22%" — a magnitude, a unit and a direction fused into
 * text that no native client can localize and no query can sort. It decomposes here into
 * statKind + statValueMilli + statUnitKey, and the client formats both the magnitude and
 * the locale.
 *
 * WHY `usd_dollars` AND NOT CENTS, which departs from §4b's integer-cents rule. This
 * column is value × 1000, so a "$12B est. market" insight in cents-milli is 1.2e15 —
 * already 13% of Number.MAX_SAFE_INTEGER, and a $100B market at 1e16 would silently lose
 * precision the moment JSON.stringify touched it. Milli-DOLLARS keep tenth-of-a-cent
 * resolution with four orders of magnitude of headroom, and the CHECK below makes an
 * out-of-range write fail in Postgres rather than corrupt in serialization. §7's escrow
 * amounts, which are genuinely money rather than a headline statistic, stay in cents.
 */
export const marketInsight = pgTable(
  "market_insight",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    headline: text("headline").notNull(),
    summary: text("summary"),
    statKind: marketInsightStatKindEnum("stat_kind").notNull(),
    statValueMilli: bigint("stat_value_milli", { mode: "number" }).notNull(),
    statUnitKey: marketInsightStatUnitKeyEnum("stat_unit_key").notNull(),
    trendDirection: trendDirectionEnum("trend_direction").notNull(),
    regionId: text("region_id")
      .notNull()
      .references(() => discoveryRegion.id, { onDelete: "restrict" }),
    categoryId: text("category_id")
      .notNull()
      .references(() => researchCategory.id, { onDelete: "restrict" }),
    // The mocks' `sourceNote: "WHO regional water survey, 2025"` split into three (§15) —
    // one string carrying an attribution, a citation and a date the client cannot format.
    sourceName: text("source_name").notNull(),
    sourceUrl: text("source_url"),
    sourcePublishedDate: date("source_published_date", { mode: "string" }).notNull(),
    // NULL until an editor publishes. Public reads filter on this being non-null.
    publishedAt: timestamp("published_at"),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("market_insight_published_idx")
      .on(table.publishedAt, table.id)
      .where(sql`published_at IS NOT NULL`),
    index("market_insight_region_published_idx")
      .on(table.regionId, table.publishedAt, table.id)
      .where(sql`published_at IS NOT NULL`),
    index("market_insight_category_published_idx")
      .on(table.categoryId, table.publishedAt, table.id)
      .where(sql`published_at IS NOT NULL`),
    // The flattened-discriminated-union CHECK, exactly the open_role_compensation shape.
    // Without it a `multiplier` insight can carry unit='people' and render "3 people"
    // where "3× coverage" was meant.
    check(
      "market_insight_stat_unit_pairing_ck",
      sql`(stat_kind IN ('percent_change','percent_level') AND stat_unit_key = 'percent')
          OR (stat_kind = 'multiplier' AND stat_unit_key = 'multiple')
          OR (stat_kind = 'absolute_count' AND stat_unit_key NOT IN ('percent','multiple'))`,
    ),
    check(
      "market_insight_stat_range_ck",
      sql`(stat_kind = 'percent_change' OR stat_value_milli >= 0)
          AND (stat_kind <> 'multiplier' OR stat_value_milli > 0)
          AND (stat_kind <> 'percent_level' OR stat_value_milli BETWEEN 0 AND 100000)
          AND abs(stat_value_milli) <= 9000000000000000`,
    ),
    // The arrow cannot contradict the sign: "+34%" can never render with a down chevron.
    check(
      "market_insight_trend_agreement_ck",
      sql`stat_kind <> 'percent_change'
          OR (trend_direction = 'up' AND stat_value_milli > 0)
          OR (trend_direction = 'down' AND stat_value_milli < 0)
          OR (trend_direction = 'flat' AND stat_value_milli = 0)`,
    ),
    check("market_insight_headline_ck", sql`char_length(headline) BETWEEN 1 AND 240`),
  ],
);

/**
 * The project ↔ insight citation, behind the Overview tab's demand-evidence chips (§11k.2).
 *
 * WHY IT EXISTS AT ALL. `marketInsightRelations` joined an insight to its region, its
 * category and its author, and NO table anywhere joined one to a project — so the chips had
 * nothing to read. `researchProject.demandEvidenceNotes` is not a substitute: it is
 * founder-authored free text, and a chip cites a moderated insight the reader can open.
 *
 * IT TAKES NO `source` ENUM, deliberately, and that is the one place it departs from
 * `problemClusterProjectLink` above. That table needs one because `origin` is semantically
 * distinct from `founder_declared` and only Postgres can enforce its 1:1. A citation has
 * neither property — every row means the same thing, and there is no cardinality to bound.
 * Add the column only when some surface must tell a founder's citation from a moderator's,
 * which no chip does.
 *
 * BOTH FKs ARE `restrict`, matching the cluster link. A cited insight is evidence, and
 * deleting it out from under a project that cites it would silently rewrite that project's
 * stated basis — so `deleteMarketInsight` translates the 23503 into a 409 and points the
 * moderator at `/unpublish` instead.
 */
export const marketInsightProjectLink = pgTable(
  "market_insight_project_link",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    insightId: text("insight_id")
      .notNull()
      .references(() => marketInsight.id, { onDelete: "restrict" }),
    linkedByUserId: text("linked_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.insightId] }),
    // The PK's leading column already serves the project-side read (the chips). This one is
    // for the reverse: which projects cite this insight.
    index("market_insight_project_link_insightId_idx").on(table.insightId),
  ],
);

/**
 * The knowledge-hub demand leaderboard, one row per (region, category) cell per run.
 * Append-only, job-written, and backing the frontend's `TrendingSignal`.
 *
 * RANK IS UNIQUE WITHIN A RUN, enforced by a unique index. Without it two rows tie for #3
 * and the leaderboard's ORDER BY is unstable (§4c rule 4). The job breaks ties before
 * insert using a total order that ends in the cell's own unique key, so `rank = index + 1`
 * is a total function and the competition-vs-dense-ranking question (1,2,2,4 vs 1,2,2,3)
 * can never arise. This index makes forgetting that fail loudly.
 *
 * There is deliberately NO run-header table: the job inserts an entire run in ONE
 * transaction, so a reader never observes a half-written leaderboard — uncommitted rows
 * are invisible. That requirement lives in the job, not in a table.
 */
export const demandSignalSnapshot = pgTable(
  "demand_signal_snapshot",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    asOf: timestamp("as_of").notNull(),
    windowStartsAt: timestamp("window_starts_at").notNull(),
    windowEndsAt: timestamp("window_ends_at").notNull(),
    categoryId: text("category_id")
      .notNull()
      .references(() => researchCategory.id, { onDelete: "restrict" }),
    regionId: text("region_id")
      .notNull()
      .references(() => discoveryRegion.id, { onDelete: "restrict" }),
    rank: integer("rank").notNull(),
    demandScorePoints: integer("demand_score_points").notNull(),
    trendDirection: trendDirectionEnum("trend_direction").notNull(),
    // How the arrow was derived. Without it trendDirection is a magic value nobody can
    // audit; with it, the CHECK below makes a contradictory arrow unrepresentable.
    // NULL on a cell's first-ever snapshot, where there is no evidence of a direction.
    previousDemandScorePoints: integer("previous_demand_score_points"),
    // --- Inputs, same reproducibility argument as the cluster score snapshot.
    clusterCount: integer("cluster_count").notNull(),
    distinctReporterCount: integer("distinct_reporter_count").notNull(),
    relatedProjectCount: integer("related_project_count").notNull(),
    openRoleCount: integer("open_role_count").notNull(),
    /**
     * THE STORE'S CONTRIBUTION — units sold in the window through listings this cell's
     * ventures actually shipped (Appendix B4). The one input here that is not R&D
     * talking to itself, and the only evidence on the row that somebody paid.
     *
     * Attributed through the cluster, not the store taxonomy:
     * `commerce_order_product_line -> product -> research_project ->
     * problem_cluster_project_link -> problem_cluster`, which carries both the region and the
     * category. There is no `commerce_category` to `research_category` mapping and the store
     * has no region at all, so no other route exists that does not invent one.
     *
     * DEFAULT 0, so the column is additive and every pre-version-2 row reads as a real zero —
     * which it is: no sale was attributed to those cells because nothing looked.
     */
    soldUnitCount: integer("sold_unit_count").default(0).notNull(),
    /**
     * Visible reviews on those same listings. RECORDED AND DISPLAYED, NOT SCORED.
     *
     * A review needs a completion, which needs an order — so every review counted here
     * corroborates a sale `soldUnitCount` has already counted, and weighting both would let
     * one transaction earn points twice. Stored because it is the qualitative half of the same
     * evidence and because a later version can weight it without a migration.
     */
    productReviewCount: integer("product_review_count").default(0).notNull(),
    scoreAlgorithmVersion: integer("score_algorithm_version").default(1).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("demand_signal_snapshot_asOf_cell_unq").on(
      table.asOf,
      table.categoryId,
      table.regionId,
    ),
    uniqueIndex("demand_signal_snapshot_asOf_rank_unq").on(table.asOf, table.rank),
    index("demand_signal_snapshot_cell_asOf_idx").on(
      table.categoryId,
      table.regionId,
      table.asOf,
      table.id,
    ),
    check("demand_signal_snapshot_rank_ck", sql`rank >= 1`),
    check("demand_signal_snapshot_score_ck", sql`demand_score_points BETWEEN 0 AND 100`),
    check(
      "demand_signal_snapshot_window_ck",
      sql`window_ends_at > window_starts_at AND as_of >= window_ends_at`,
    ),
    check(
      "demand_signal_snapshot_counts_ck",
      sql`cluster_count >= 0 AND distinct_reporter_count >= 0
          AND related_project_count >= 0 AND open_role_count >= 0
          AND sold_unit_count >= 0 AND product_review_count >= 0
          AND (previous_demand_score_points IS NULL
               OR previous_demand_score_points BETWEEN 0 AND 100)`,
    ),
    check(
      "demand_signal_snapshot_trend_agreement_ck",
      sql`previous_demand_score_points IS NULL
          OR (trend_direction = 'up' AND demand_score_points > previous_demand_score_points)
          OR (trend_direction = 'down' AND demand_score_points < previous_demand_score_points)
          OR (trend_direction = 'flat' AND demand_score_points = previous_demand_score_points)`,
    ),
  ],
);

/**
 * The opt-in talent directory — A PROJECTION OF `user`, not a parallel identity (§6).
 *
 * NOTE WHAT IS NOT HERE: `name` and `avatarImageUrl`. They join from user.name and
 * user.image on read, because a copy drifts the moment someone changes their photo — the
 * same rule project_member follows for TeamMember.name.
 *
 * The PK IS the FK, the project_stats pattern: exactly one directory row per person, and
 * DELETE /discovery/talent/me is a plain delete. `cascade` is correct here and is not an
 * §4f violation: a directory listing is a PREFERENCE that dies with the account, bearing
 * no equity, effort or audit weight. The effort minutes below are a rebuildable CACHE of
 * §9 data that lives in §9's own tables.
 */
export const talentProfile = pgTable(
  "talent_profile",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    headlineRole: text("headline_role").notNull(),
    bio: text("bio"),
    // Self-description, for display only. Free text is safe HERE because it feeds no
    // score — which is precisely why it is NOT safe on problem_submission.
    locationLabel: text("location_label"),
    // The ?region= filter joins THIS, never the label (§6: "join rather than
    // string-match"). The client picks a region id; it does not type a string.
    regionId: text("region_id").references(() => discoveryRegion.id, { onDelete: "set null" }),
    availability: talentAvailabilityEnum("availability").default("unavailable").notNull(),
    commitment: roleCommitmentEnum("commitment"),
    visibility: talentProfileVisibilityEnum("visibility").default("private").notNull(),
    publishedAt: timestamp("published_at"),
    // Server-owned, the product.currency / research_project.currency precedent. §4b: no
    // currency field in any request body, and a talent ask has no project to inherit one
    // from, so it is set from config and absent from the schema `.strict()` accepts.
    currency: text("currency").default("USD").notNull(),
    // --- refresh-talent-projections (hourly). NULLABLE WITH NO DEFAULT: a 0 would assert
    //     unverified effort as fact. NULL until §9's ledger exists to compute from.
    cachedEffortMinutesLogged: integer("cached_effort_minutes_logged"),
    cachedProjectsCompletedCount: integer("cached_projects_completed_count"),
    // Returned to clients so all three render "as of" and never imply a live number.
    projectionComputedAt: timestamp("projection_computed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    // The ONLY set GET /discovery/talent reads. Partial, so it stays small even if every
    // account creates a private draft.
    index("talent_profile_published_idx")
      .on(table.availability, table.commitment, table.updatedAt, table.userId)
      .where(sql`visibility = 'published'`),
    index("talent_profile_published_region_idx")
      .on(table.regionId, table.updatedAt, table.userId)
      .where(sql`visibility = 'published'`),
    index("talent_profile_regionId_idx").on(table.regionId),
    check(
      "talent_profile_published_at_ck",
      sql`(visibility = 'published') = (published_at IS NOT NULL)`,
    ),
    check(
      "talent_profile_cached_ck",
      sql`(cached_effort_minutes_logged IS NULL OR cached_effort_minutes_logged >= 0)
          AND (cached_projects_completed_count IS NULL OR cached_projects_completed_count >= 0)
          AND (cached_effort_minutes_logged IS NULL) = (projection_computed_at IS NULL)`,
    ),
    check("talent_profile_headline_ck", sql`char_length(headline_role) BETWEEN 1 AND 120`),
    check("talent_profile_currency_ck", sql`currency ~ '^[A-Z]{3}$'`),
  ],
);

/**
 * A person's skills, as canonical slugs rather than free text.
 *
 * `isVerified` is JOB-WRITTEN ONLY (§15's `{ slug, displayLabel, isVerified }`). It means
 * §9 recorded verified effort on a project tagged with this skill. If a request could set
 * it the badge would mean nothing — that IS the column's entire purpose.
 */
export const talentProfileSkill = pgTable(
  "talent_profile_skill",
  {
    talentProfileUserId: text("talent_profile_user_id")
      .notNull()
      .references(() => talentProfile.userId, { onDelete: "cascade" }),
    // `restrict` — a curated skill must not vanish out from under a published profile.
    skillId: text("skill_id")
      .notNull()
      .references(() => discoverySkill.id, { onDelete: "restrict" }),
    isVerified: boolean("is_verified").default(false).notNull(),
    verifiedAt: timestamp("verified_at"),
    // The evidence behind the badge, so it is auditable rather than asserted.
    verifiedEffortMinutes: integer("verified_effort_minutes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.talentProfileUserId, table.skillId] }),
    // The ?skill= reverse lookup.
    index("talent_profile_skill_skillId_idx").on(table.skillId),
    check(
      "talent_profile_skill_verified_ck",
      sql`(is_verified = false) = (verified_at IS NULL)
          AND (verified_effort_minutes IS NULL OR verified_effort_minutes >= 0)`,
    ),
  ],
);

/**
 * The applicant-side mirror of open_role_compensation: what a person wants in return.
 *
 * DELIBERATELY NO `earnedAsPolicy`. Per the frontend type's own comment, that mechanism
 * "belongs to the role offering the work" — a person ASKS for an amount; only a ROLE may
 * promise a payout mechanism, because only a role's promise is something the escrow
 * engine will execute.
 *
 * The equity band is an ASK, never a grant. Grants come solely from §9's ledger, and
 * there is no writable equity column anywhere in this schema.
 */
export const talentCompensationAsk = pgTable(
  "talent_compensation_ask",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    talentProfileUserId: text("talent_profile_user_id")
      .notNull()
      .references(() => talentProfile.userId, { onDelete: "cascade" }),
    kind: compensationKindEnum("kind").notNull(),
    salaryMinInCentsPerMonth: bigint("salary_min_in_cents_per_month", { mode: "number" }),
    salaryMaxInCentsPerMonth: bigint("salary_max_in_cents_per_month", { mode: "number" }),
    oneTimeMinInCents: bigint("one_time_min_in_cents", { mode: "number" }),
    oneTimeMaxInCents: bigint("one_time_max_in_cents", { mode: "number" }),
    equityBasisPointsMin: integer("equity_basis_points_min"),
    equityBasisPointsMax: integer("equity_basis_points_max"),
    note: text("note"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    // At most one strand per kind, the open_role_compensation invariant.
    uniqueIndex("talent_compensation_ask_userId_kind_unq").on(
      table.talentProfileUserId,
      table.kind,
    ),
    index("talent_compensation_ask_kind_equityMin_idx").on(table.kind, table.equityBasisPointsMin),
    index("talent_compensation_ask_kind_salaryMin_idx").on(
      table.kind,
      table.salaryMinInCentsPerMonth,
    ),
    // Byte-for-byte the open_role_compensation_kind_columns_ck shape — the same
    // discriminated union flattened into one row needs the same guard.
    check(
      "talent_compensation_ask_kind_columns_ck",
      sql`
      (kind = 'salary' AND salary_min_in_cents_per_month IS NOT NULL
                       AND one_time_min_in_cents IS NULL AND one_time_max_in_cents IS NULL
                       AND equity_basis_points_min IS NULL AND equity_basis_points_max IS NULL)
      OR (kind = 'one_time' AND one_time_min_in_cents IS NOT NULL
                       AND salary_min_in_cents_per_month IS NULL AND salary_max_in_cents_per_month IS NULL
                       AND equity_basis_points_min IS NULL AND equity_basis_points_max IS NULL)
      OR (kind = 'equity' AND equity_basis_points_min IS NOT NULL
                       AND salary_min_in_cents_per_month IS NULL AND salary_max_in_cents_per_month IS NULL
                       AND one_time_min_in_cents IS NULL AND one_time_max_in_cents IS NULL)`,
    ),
    check(
      "talent_compensation_ask_ranges_ck",
      sql`
      (salary_min_in_cents_per_month IS NULL OR salary_min_in_cents_per_month >= 0)
      AND (salary_max_in_cents_per_month IS NULL OR salary_max_in_cents_per_month >= salary_min_in_cents_per_month)
      AND (one_time_min_in_cents IS NULL OR one_time_min_in_cents >= 0)
      AND (one_time_max_in_cents IS NULL OR one_time_max_in_cents >= one_time_min_in_cents)
      AND (equity_basis_points_min IS NULL OR equity_basis_points_min BETWEEN 0 AND 10000)
      AND (equity_basis_points_max IS NULL OR (equity_basis_points_max >= equity_basis_points_min
                                               AND equity_basis_points_max <= 10000))`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Go-to-market — the supplier / ODM directory (§11i, Appendix B4).
//
// A §6-FAMILY DOMAIN, not a new kind of thing: a curated, filterable catalogue with a
// controlled vocabulary, exactly like the talent directory and the problem-cluster map.
// It is modelled on those two rather than invented, which is why `supplier_capability`
// wears `discovery_skill`'s shape and `supplier_capability_link` wears
// `talent_profile_skill`'s.
//
// A PUBLIC DIRECTORY IS A SPAM SURFACE, so the write side is decided before the route
// exists: platform `moderator` only, checked in-service via `requirePlatformCapability`
// BEFORE any id is read. There is deliberately NO user-submission path and therefore no
// moderation status column — a self-serve, immediately-public supplier listing needs a
// moderation queue, a rate limiter and an abuse story, and none of that is worth building
// before the first real supplier exists. `is_active` is the retirement mechanism, the same
// answer `discovery_skill` gives, and it is not a moderation state.
//
// AUTHORED IN §4b WIRE FORMAT FROM THE START. This domain has no legacy importers, so §15
// never has to touch it: `leadTimeDays` and `minimumOrderQuantity` are integers with
// explicit units in their names, and every enum value is snake_case (§4d).
//
// AND THERE IS NO PRICE COLUMN ON `supplier`. §4b requires a currency beside every money
// column and derives that currency from the PROJECT, never from a request body — and a
// supplier belongs to no project, so an indicative price here would have to invent one.
// A quote belongs to an engagement between a specific project and a supplier, priced in
// that project's currency. Appendix B's `…InCents` note is answered by omitting the column
// rather than by inventing a directory-level currency.
// ---------------------------------------------------------------------------

/**
 * The capability vocabulary. SEEDED, with no write endpoint.
 *
 * Same reasoning as `discovery_skill` verbatim: no POST means no spam surface means no
 * moderation status, and the difference from `research_category` is deliberate rather than
 * an oversight. Slug equality is what `?capability=` matches on — never a substring, which
 * is the class of bug §6 exists to make unrepresentable.
 */
export const supplierCapability = pgTable(
  "supplier_capability",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    slug: text("slug").notNull(),
    label: text("label").notNull(),
    kind: supplierCapabilityKindEnum("kind").notNull(),
    // Retirement WITHOUT a DELETE: supplier_capability_link references this with
    // `restrict`, so a curated capability can never vanish out from under a listing.
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("supplier_capability_slug_unq").on(table.slug),
    index("supplier_capability_active_label_idx")
      .on(table.label, table.id)
      .where(sql`is_active`),
    check("supplier_capability_slug_ck", sql`slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check("supplier_capability_label_ck", sql`char_length(label) BETWEEN 1 AND 80`),
  ],
);

/** A manufacturing partner. Moderator-authored; every field below is server-owned. */
export const supplier = pgTable(
  "supplier",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    // UNIQUE, and the uniqueness IS the de-duplication mechanism: a collision is a 409,
    // never a silent `-2` suffix. `research_project.slug` auto-suffixes because two
    // founders may legitimately pick one name; two rows for one supplier is a data bug.
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    summary: text("summary"),
    // `restrict` — the seeded region taxonomy must not vanish under a listing that filters
    // on it. Nullable: a supplier with no confirmed region is honest, "global" is not.
    regionId: text("region_id").references(() => discoveryRegion.id, { onDelete: "restrict" }),
    verificationState: supplierVerificationStateEnum("verification_state")
      .default("unverified")
      .notNull(),
    contactPolicy: supplierContactPolicyEnum("contact_policy").default("no_contact").notNull(),
    // Host-allowlisted before storage, like every third-party URL in this schema — it is a
    // string a client will put in an href.
    websiteUrl: text("website_url"),
    // Integer days and integer units (§4b). No floats, and no currency to derive.
    leadTimeDays: integer("lead_time_days"),
    minimumOrderQuantity: integer("minimum_order_quantity"),
    isActive: boolean("is_active").default(true).notNull(),
    // Optional link to a commerce organization after moderator review (STORE §1.3).
    // Imports no trust state, quotes, prices, or project engagements.
    commerceOrganizationId: text("commerce_organization_id").references(
      () => commerceOrganization.id,
      { onDelete: "set null" },
    ),
    // R2: attribution that must never block an account deletion.
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("supplier_slug_unq").on(table.slug),
    // The directory read: listed suppliers, ordered by name, ending in a unique column
    // (§4c rule 4).
    index("supplier_active_name_idx")
      .on(table.name, table.id)
      .where(sql`is_active`),
    index("supplier_regionId_idx").on(table.regionId),
    index("supplier_verificationState_idx").on(table.verificationState),
    index("supplier_commerceOrganizationId_idx")
      .on(table.commerceOrganizationId)
      .where(sql`commerce_organization_id IS NOT NULL`),
    check("supplier_slug_ck", sql`slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check("supplier_name_ck", sql`char_length(name) BETWEEN 1 AND 120`),
    check("supplier_summary_ck", sql`summary IS NULL OR char_length(summary) <= 2000`),
    check(
      "supplier_quantities_ck",
      sql`(lead_time_days IS NULL OR lead_time_days BETWEEN 0 AND 3650)
          AND (minimum_order_quantity IS NULL OR minimum_order_quantity >= 0)`,
    ),
    // "Email them directly" is not actionable without somewhere to find the address.
    // Written as an explicit implication rather than the boolean-ordering trick
    // (`a <= b`), which is valid Postgres and unreadable at review time.
    check("supplier_contact_ck", sql`contact_policy <> 'direct_email' OR website_url IS NOT NULL`),
  ],
);

/** Which capabilities a supplier claims. `talent_profile_skill`'s shape exactly. */
export const supplierCapabilityLink = pgTable(
  "supplier_capability_link",
  {
    // Cascade: the link is part of the listing and has no life without it.
    supplierId: text("supplier_id")
      .notNull()
      .references(() => supplier.id, { onDelete: "cascade" }),
    // `restrict` — a curated capability must not vanish out from under a listing.
    capabilityId: text("capability_id")
      .notNull()
      .references(() => supplierCapability.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.supplierId, table.capabilityId] }),
    // The `?capability=` reverse lookup.
    index("supplier_capability_link_capabilityId_idx").on(table.capabilityId),
  ],
);

/**
 * Which project engaged which supplier — the launch-ready rail's provenance.
 *
 * A PROJECT'S OWN RECORD, never a claim about the supplier. `contracted` here means "this
 * team says they signed something", and no field on this row feeds a supplier's
 * `verificationState`: letting one project's self-report raise another party's trust level
 * would make the directory forgeable one row at a time.
 */
export const projectSupplierEngagement = pgTable(
  "project_supplier_engagement",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    // R1 — every FK into research_project is `restrict`.
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    supplierId: text("supplier_id")
      .notNull()
      .references(() => supplier.id, { onDelete: "restrict" }),
    status: projectSupplierEngagementStatusEnum("status").default("considering").notNull(),
    note: text("note"),
    // `restrict`: membership is never hard-deleted anyway (§4a), and this row records who
    // on the team made the call.
    createdByMemberId: text("created_by_member_id")
      .notNull()
      .references(() => projectMember.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    // One engagement row per pair. Re-approaching the same supplier moves the status; it
    // does not file a second row.
    uniqueIndex("project_supplier_engagement_project_supplier_unq").on(
      table.projectId,
      table.supplierId,
    ),
    index("project_supplier_engagement_supplierId_idx").on(table.supplierId),
    check("project_supplier_engagement_note_ck", sql`note IS NULL OR char_length(note) <= 2000`),
  ],
);

/**
 * Dead-lettered background jobs, captured for a human.
 *
 * NOT OPTIONAL, and not merely observability: pg-boss deletes completed and failed jobs
 * after `deleteAfterSeconds` (7 days by default), so a dead-lettered job that nobody
 * drains becomes INDISTINGUISHABLE FROM A JOB THAT NEVER EXISTED. A submission whose
 * clustering failed would simply vanish, with the reporter seeing a queued state forever
 * and no operator surface showing why.
 *
 * Deliberately a plain content table, not append-only: `resolvedAt` is how an operator
 * marks a failure handled after requeuing it.
 */
export const jobFailure = pgTable(
  "job_failure",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    queueName: text("queue_name").notNull(),
    // pg-boss's own job id. Not an FK: pg-boss owns its schema exclusively and deletes
    // its rows on its own schedule, so a real reference would break on its retention pass.
    sourceJobId: text("source_job_id").notNull(),
    // The payload as enqueued, so an operator can requeue without reconstructing it.
    payloadJson: text("payload_json").notNull(),
    errorMessage: text("error_message").notNull(),
    attemptCount: integer("attempt_count").notNull(),
    failedAt: timestamp("failed_at").defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at"),
    resolutionNote: text("resolution_note"),
  },
  (table) => [
    // The operator's queue: unresolved failures, oldest first.
    index("job_failure_unresolved_idx")
      .on(table.failedAt, table.id)
      .where(sql`resolved_at IS NULL`),
    index("job_failure_queueName_failedAt_idx").on(table.queueName, table.failedAt, table.id),
    uniqueIndex("job_failure_sourceJobId_unq").on(table.sourceJobId),
    check("job_failure_attempt_ck", sql`attempt_count >= 0`),
  ],
);

// --- Relations. Declared CHILD-SIDE ONLY, matching the store domain's precedent:
// product declares `createdByUser: one(user, …)` and userRelations was deliberately left
// untouched. Amending userRelations here is what would force six relationName pairs,
// a construct that appears nowhere in the existing blocks, for something db.query.*
// never reads. relationName is used only where one child has TWO relations to `user`.

export const researchCategoryRelations = relations(researchCategory, ({ one, many }) => ({
  createdBy: one(user, { fields: [researchCategory.createdByUserId], references: [user.id] }),
  projects: many(researchProject),
}));

export const researchProjectRelations = relations(researchProject, ({ one, many }) => ({
  founder: one(user, { fields: [researchProject.founderUserId], references: [user.id] }),
  category: one(researchCategory, {
    fields: [researchProject.categoryId],
    references: [researchCategory.id],
  }),
  stats: one(projectStats),
  members: many(projectMember),
  openRoles: many(projectOpenRole),
  applications: many(projectApplication),
  invites: many(projectInvite),
  watchers: many(projectWatcher),
  stageTransitions: many(projectStageTransition),
}));

export const projectStatsRelations = relations(projectStats, ({ one }) => ({
  project: one(researchProject, {
    fields: [projectStats.projectId],
    references: [researchProject.id],
  }),
}));

export const projectOpenRoleRelations = relations(projectOpenRole, ({ one, many }) => ({
  project: one(researchProject, {
    fields: [projectOpenRole.projectId],
    references: [researchProject.id],
  }),
  compensation: many(openRoleCompensation),
  applications: many(projectApplication),
}));

export const openRoleCompensationRelations = relations(openRoleCompensation, ({ one }) => ({
  openRole: one(projectOpenRole, {
    fields: [openRoleCompensation.openRoleId],
    references: [projectOpenRole.id],
  }),
}));

export const projectApplicationRelations = relations(projectApplication, ({ one }) => ({
  project: one(researchProject, {
    fields: [projectApplication.projectId],
    references: [researchProject.id],
  }),
  openRole: one(projectOpenRole, {
    fields: [projectApplication.openRoleId],
    references: [projectOpenRole.id],
  }),
  applicant: one(user, {
    fields: [projectApplication.applicantUserId],
    references: [user.id],
    relationName: "projectApplicationApplicant",
  }),
  reviewedBy: one(user, {
    fields: [projectApplication.reviewedByUserId],
    references: [user.id],
    relationName: "projectApplicationReviewer",
  }),
}));

export const projectInviteRelations = relations(projectInvite, ({ one }) => ({
  project: one(researchProject, {
    fields: [projectInvite.projectId],
    references: [researchProject.id],
  }),
  openRole: one(projectOpenRole, {
    fields: [projectInvite.openRoleId],
    references: [projectOpenRole.id],
  }),
  invitee: one(user, {
    fields: [projectInvite.inviteeUserId],
    references: [user.id],
    relationName: "projectInviteInvitee",
  }),
  invitedBy: one(user, {
    fields: [projectInvite.invitedByUserId],
    references: [user.id],
    relationName: "projectInviteInviter",
  }),
}));

export const projectMemberRelations = relations(projectMember, ({ one, many }) => ({
  project: one(researchProject, {
    fields: [projectMember.projectId],
    references: [researchProject.id],
  }),
  member: one(user, {
    fields: [projectMember.userId],
    references: [user.id],
    relationName: "projectMemberUser",
  }),
  removedBy: one(user, {
    fields: [projectMember.removedByUserId],
    references: [user.id],
    relationName: "projectMemberRemovedBy",
  }),
  sourceApplication: one(projectApplication, {
    fields: [projectMember.sourceApplicationId],
    references: [projectApplication.id],
  }),
  sourceInvite: one(projectInvite, {
    fields: [projectMember.sourceInviteId],
    references: [projectInvite.id],
  }),
  intervals: many(projectMemberInterval),
}));

export const projectMemberIntervalRelations = relations(projectMemberInterval, ({ one }) => ({
  member: one(projectMember, {
    fields: [projectMemberInterval.memberId],
    references: [projectMember.id],
  }),
  endedBy: one(user, { fields: [projectMemberInterval.endedByUserId], references: [user.id] }),
}));

export const projectWatcherRelations = relations(projectWatcher, ({ one }) => ({
  project: one(researchProject, {
    fields: [projectWatcher.projectId],
    references: [researchProject.id],
  }),
  watcher: one(user, { fields: [projectWatcher.userId], references: [user.id] }),
}));

export const projectStageTransitionRelations = relations(projectStageTransition, ({ one }) => ({
  project: one(researchProject, {
    fields: [projectStageTransition.projectId],
    references: [researchProject.id],
  }),
  changedBy: one(user, {
    fields: [projectStageTransition.changedByUserId],
    references: [user.id],
  }),
}));

// --- §6 discovery relations. Child-side only, same convention as above. `relationName`
// appears only where one child holds TWO relations to the same parent, which the linter
// cannot disambiguate on its own.

export const discoveryRegionRelations = relations(discoveryRegion, ({ one, many }) => ({
  parentRegion: one(discoveryRegion, {
    fields: [discoveryRegion.parentRegionId],
    references: [discoveryRegion.id],
    relationName: "region_parent",
  }),
  childRegions: many(discoveryRegion, { relationName: "region_parent" }),
}));

export const discoverySkillRelations = relations(discoverySkill, ({ one, many }) => ({
  category: one(researchCategory, {
    fields: [discoverySkill.categoryId],
    references: [researchCategory.id],
  }),
  talentProfileSkills: many(talentProfileSkill),
}));

export const geocodeCacheRelations = relations(geocodeCache, ({ one }) => ({
  region: one(discoveryRegion, {
    fields: [geocodeCache.regionId],
    references: [discoveryRegion.id],
  }),
}));

export const problemSubmissionRelations = relations(problemSubmission, ({ one }) => ({
  reporter: one(user, { fields: [problemSubmission.reporterUserId], references: [user.id] }),
  category: one(researchCategory, {
    fields: [problemSubmission.categoryId],
    references: [researchCategory.id],
  }),
  region: one(discoveryRegion, {
    fields: [problemSubmission.regionId],
    references: [discoveryRegion.id],
  }),
  cluster: one(problemCluster, {
    fields: [problemSubmission.clusterId],
    references: [problemCluster.id],
  }),
}));

export const problemClusterRelations = relations(problemCluster, ({ one, many }) => ({
  category: one(researchCategory, {
    fields: [problemCluster.categoryId],
    references: [researchCategory.id],
  }),
  region: one(discoveryRegion, {
    fields: [problemCluster.regionId],
    references: [discoveryRegion.id],
  }),
  mergedInto: one(problemCluster, {
    fields: [problemCluster.mergedIntoClusterId],
    references: [problemCluster.id],
    relationName: "cluster_merged_into",
  }),
  absorbedClusters: many(problemCluster, { relationName: "cluster_merged_into" }),
  submissions: many(problemSubmission),
  scoreSnapshots: many(problemClusterScoreSnapshot),
  projectLinks: many(problemClusterProjectLink),
}));

export const problemClusterScoreSnapshotRelations = relations(
  problemClusterScoreSnapshot,
  ({ one }) => ({
    cluster: one(problemCluster, {
      fields: [problemClusterScoreSnapshot.clusterId],
      references: [problemCluster.id],
    }),
  }),
);

export const problemClusterMergeProposalRelations = relations(
  problemClusterMergeProposal,
  ({ one }) => ({
    sourceCluster: one(problemCluster, {
      fields: [problemClusterMergeProposal.sourceClusterId],
      references: [problemCluster.id],
      relationName: "merge_proposal_source",
    }),
    targetCluster: one(problemCluster, {
      fields: [problemClusterMergeProposal.targetClusterId],
      references: [problemCluster.id],
      relationName: "merge_proposal_target",
    }),
    proposedBy: one(user, {
      fields: [problemClusterMergeProposal.proposedByUserId],
      references: [user.id],
      relationName: "merge_proposal_proposer",
    }),
    decidedBy: one(user, {
      fields: [problemClusterMergeProposal.decidedByUserId],
      references: [user.id],
      relationName: "merge_proposal_decider",
    }),
  }),
);

export const problemClusterProjectLinkRelations = relations(
  problemClusterProjectLink,
  ({ one }) => ({
    cluster: one(problemCluster, {
      fields: [problemClusterProjectLink.clusterId],
      references: [problemCluster.id],
    }),
    project: one(researchProject, {
      fields: [problemClusterProjectLink.projectId],
      references: [researchProject.id],
    }),
    linkedBy: one(user, {
      fields: [problemClusterProjectLink.linkedByUserId],
      references: [user.id],
    }),
  }),
);

export const marketInsightRelations = relations(marketInsight, ({ one, many }) => ({
  region: one(discoveryRegion, {
    fields: [marketInsight.regionId],
    references: [discoveryRegion.id],
  }),
  category: one(researchCategory, {
    fields: [marketInsight.categoryId],
    references: [researchCategory.id],
  }),
  createdBy: one(user, { fields: [marketInsight.createdByUserId], references: [user.id] }),
  projectLinks: many(marketInsightProjectLink),
}));

export const marketInsightProjectLinkRelations = relations(marketInsightProjectLink, ({ one }) => ({
  project: one(researchProject, {
    fields: [marketInsightProjectLink.projectId],
    references: [researchProject.id],
  }),
  insight: one(marketInsight, {
    fields: [marketInsightProjectLink.insightId],
    references: [marketInsight.id],
  }),
  linkedBy: one(user, { fields: [marketInsightProjectLink.linkedByUserId], references: [user.id] }),
}));

export const demandSignalSnapshotRelations = relations(demandSignalSnapshot, ({ one }) => ({
  category: one(researchCategory, {
    fields: [demandSignalSnapshot.categoryId],
    references: [researchCategory.id],
  }),
  region: one(discoveryRegion, {
    fields: [demandSignalSnapshot.regionId],
    references: [discoveryRegion.id],
  }),
}));

export const talentProfileRelations = relations(talentProfile, ({ one, many }) => ({
  user: one(user, { fields: [talentProfile.userId], references: [user.id] }),
  region: one(discoveryRegion, {
    fields: [talentProfile.regionId],
    references: [discoveryRegion.id],
  }),
  skills: many(talentProfileSkill),
  compensationAsks: many(talentCompensationAsk),
}));

export const talentProfileSkillRelations = relations(talentProfileSkill, ({ one }) => ({
  talentProfile: one(talentProfile, {
    fields: [talentProfileSkill.talentProfileUserId],
    references: [talentProfile.userId],
  }),
  skill: one(discoverySkill, {
    fields: [talentProfileSkill.skillId],
    references: [discoverySkill.id],
  }),
}));

export const talentCompensationAskRelations = relations(talentCompensationAsk, ({ one }) => ({
  talentProfile: one(talentProfile, {
    fields: [talentCompensationAsk.talentProfileUserId],
    references: [talentProfile.userId],
  }),
}));

// --- Go-to-market (§11i). Child-side only, matching the convention above.

export const supplierRelations = relations(supplier, ({ one, many }) => ({
  region: one(discoveryRegion, {
    fields: [supplier.regionId],
    references: [discoveryRegion.id],
  }),
  capabilityLinks: many(supplierCapabilityLink),
  engagements: many(projectSupplierEngagement),
}));

export const supplierCapabilityLinkRelations = relations(supplierCapabilityLink, ({ one }) => ({
  supplier: one(supplier, {
    fields: [supplierCapabilityLink.supplierId],
    references: [supplier.id],
  }),
  capability: one(supplierCapability, {
    fields: [supplierCapabilityLink.capabilityId],
    references: [supplierCapability.id],
  }),
}));

export const projectSupplierEngagementRelations = relations(
  projectSupplierEngagement,
  ({ one }) => ({
    project: one(researchProject, {
      fields: [projectSupplierEngagement.projectId],
      references: [researchProject.id],
    }),
    supplier: one(supplier, {
      fields: [projectSupplierEngagement.supplierId],
      references: [supplier.id],
    }),
    createdByMember: one(projectMember, {
      fields: [projectSupplierEngagement.createdByMemberId],
      references: [projectMember.id],
    }),
  }),
);

// ---------------------------------------------------------------------------
// R&D §8 — the Virtual Workshop and daily logs.
// See docs/R_AND_D_BACKEND_STRUCTURE.md §8 and its "Read this first" header.
//
// The three §5/§6 rules at the top of this domain still apply verbatim. Four more
// govern everything below:
//
//  1. THE WORKSHOP IS PRIVATE. Every row here is reachable only through
//     requireProjectRole(slug, userId, "contributor"), and failure is 404 — never
//     403 — so a stranger cannot probe which projects exist. No table below has a
//     public read projection.
//
//  2. TWO STATUSES, NEVER ONE. `daily_log.analysisStatus` is the Gemini job's
//     lifecycle; `daily_log.effortVerificationStatus` is §9's VERDICT and is written
//     by nothing in this phase. Collapsing them would permit "transcribed" to read
//     as "verified" — the same trap the studio block splits uploadStatus /
//     publishStatus / reviewStatus to avoid. A failed analysis leaves the verdict at
//     `not_run`; the pipeline never guesses.
//
//  3. THE ZERO-COST SUBSTITUTIONS ARE SEAMS, NOT SENTINELS. `workshop_file.source`
//     carries `hosted` beside `external_link` and `daily_log.videoSource` carries
//     `hosted` beside `youtube`/`none`, with `storageProvider`, `objectKey`,
//     `sizeBytes` and `contentSha256` nullable and written by NOTHING. That is what
//     makes Appendix A an insert rather than a migration. Do not populate them from
//     the link path, and do not delete them.
//
//  4. AI OUTPUT CARRIES ITS PROVENANCE, ALWAYS (§9.1). Every chip, claim and
//     transcript segment names the model and prompt version that produced it, and
//     every one of them is REVIEWABLE input — not a number anyone is paid on.
//     `extractedMinutes` is what the member SAID; `groundedMinutes` is §9's and is
//     deliberately absent here.
//
// TWO THINGS DRIZZLE CANNOT EXPRESS, added by hand in the migration (§17 step 1):
//   ALTER TABLE workshop_task ALTER COLUMN rank TYPE text COLLATE "C";
//   ALTER TABLE workshop_board_column ADD CONSTRAINT
//     workshop_board_column_projectId_position_unq UNIQUE (project_id, position)
//     DEFERRABLE INITIALLY DEFERRED;
// Neither is declared below, on purpose: drizzle-kit diffs only what it declared, so
// hand-added objects survive every later `db:generate` — the same arrangement
// migration 0008 uses for the citext extension.
// ---------------------------------------------------------------------------

export const workshopTaskPriorityEnum = pgEnum("workshop_task_priority", ["high", "medium", "low"]);

// Where a workshop file's bytes live. `external_link` is the only value produced today;
// `hosted` exists so restoring presigned S3 upload (Appendix A) is an insert.
export const workshopFileSourceEnum = pgEnum("workshop_file_source", ["external_link", "hosted"]);

// Dead column support for the deferred `hosted` path. Deliberately NOT the studio's
// `storage_provider` enum: that one is video-shaped (it carries "livepeer") and is
// declared further down this file, so referencing it here would also be a temporal
// dead zone at module evaluation.
export const workshopStorageProviderEnum = pgEnum("workshop_storage_provider", [
  "s3_compatible",
  "cloudinary",
]);

// The frontend's WorkshopFileKind, snake_cased per §4d ("cad-model" → "cad_model", a
// §15 rename). `archive` and `other` are added because a link can point at anything and
// a kind the client cannot render is better than a lie about a zip file being a document.
export const workshopFileKindEnum = pgEnum("workshop_file_kind", [
  "document",
  "spreadsheet",
  "cad_model",
  "image",
  "video",
  "archive",
  "other",
]);

// A log is editable while `draft` and FROZEN once `submitted` — at that point it is
// effort evidence feeding §9, and an editable evidence record is not evidence.
export const dailyLogStatusEnum = pgEnum("daily_log_status", ["draft", "submitted"]);

// `none` is a first-class value, not a missing one: a member with no video that day must
// still be able to log, and §9's physical-work claims have no video by definition.
export const dailyLogVideoSourceEnum = pgEnum("daily_log_video_source", [
  "none",
  "youtube",
  "hosted",
]);

// The ANALYSIS job's lifecycle — NOT a verdict. See rule 2 above.
//
// `skipped_unconfigured` is distinct from `failed` on purpose: "no LLM key is configured
// in this environment" is an operator fact, and rendering it as a failure would send a
// member chasing a problem with their log.
export const dailyLogAnalysisStatusEnum = pgEnum("daily_log_analysis_status", [
  "not_requested", // still a draft; nothing has been asked of the model
  "queued",
  "running",
  "succeeded",
  "failed", // rejected input, or output that would not parse after one repair
  "skipped_unconfigured", // no GEMINI_API_KEY in this environment
]);

export const aiSummaryChipKindEnum = pgEnum("ai_summary_chip_kind", [
  "blocker",
  "progress",
  "velocity",
  "suggestion",
]);

export const extractedClaimKindEnum = pgEnum("extracted_claim_kind", [
  "time_spent",
  "cash_spent",
  "artifact_reference",
  "blocker",
  "milestone_progress",
]);

export const evidenceLinkProviderEnum = pgEnum("evidence_link_provider", [
  "github",
  "gitlab",
  "figma",
  "google_docs",
  "notion",
  "other",
]);

// Who put the link on the log. §9 will weigh these differently — a member-supplied
// artifact reference is a claim, an AI-extracted one is a reading of the transcript —
// so the distinction has to exist at write time, not be inferred later.
export const evidenceLinkSourceKindEnum = pgEnum("evidence_link_source_kind", [
  "member_supplied",
  "ai_extracted",
]);

/**
 * A kanban column. `position` is contiguous from 0 and re-packed on delete.
 *
 * Why columns use an integer position while TASKS use a rank string: a board has a
 * handful of columns, reordered rarely and by one person at a time, so a re-pack is two
 * rows and a transaction. Tasks are dragged concurrently by several members, where a
 * re-pack is a write storm and a lost move (§8).
 */
export const workshopBoardColumn = pgTable(
  "workshop_board_column",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    // R1: every FK into research_project is `restrict`. A workshop is not a rebuildable
    // cache — it is the team's working record, and §9 reads it.
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    position: integer("position").notNull(),
    // Attribution that must never block an account deletion.
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    // Ends in a unique column (§4c rule 4) so two columns sharing a position — which the
    // deferred UNIQUE forbids at COMMIT but permits mid-transaction — can never swap
    // places between two reads.
    index("workshop_board_column_projectId_position_idx").on(
      table.projectId,
      table.position,
      table.id,
    ),
    check("workshop_board_column_title_ck", sql`char_length(title) BETWEEN 1 AND 60`),
    check("workshop_board_column_position_ck", sql`position >= 0`),
  ],
);

/**
 * A task card. Ordered by a LEXICOGRAPHIC RANK STRING, not an integer position.
 *
 * THE COLLATION TRAP, restated because it is invisible until it bites: `ORDER BY` on a
 * text column follows the database's LC_COLLATE (typically ICU en_US.UTF-8), which
 * reorders case and punctuation, while a JS/Kotlin/Swift `a < b` compares code points.
 * They disagree, and the board renders in a different order than the server paginates.
 * The migration forces `COLLATE "C"` on this column, and the CHECK below keeps the
 * alphabet inside [0-9a-z] where the two orderings are provably identical.
 */
export const workshopTask = pgTable(
  "workshop_task",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    // Cascade: §4f puts content tables (board columns, tasks, chat) on cascade, and a
    // task cannot outlive the column it sits in.
    columnId: text("column_id")
      .notNull()
      .references(() => workshopBoardColumn.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    // `set null`, not restrict: a departing member must not pin every task they were
    // assigned, and an unassigned task is a real state the board already renders.
    assigneeMemberId: text("assignee_member_id").references(() => projectMember.id, {
      onDelete: "set null",
    }),
    priority: workshopTaskPriorityEnum("priority").default("medium").notNull(),
    labels: text("labels").array().notNull().default([]),
    // Date-only, the §1 wire format. No Date object to reinterpret in a local zone, and
    // no "due at 00:00 in whose timezone?" question.
    dueDate: date("due_date", { mode: "string" }),
    // SERVER-DERIVED, always. POST /tasks/:id/move takes { beforeTaskId, afterTaskId }
    // and the server computes this; there is no `rank` field in any request body.
    rank: text("rank").notNull(),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    // The board read, in render order.
    uniqueIndex("workshop_task_columnId_rank_unq").on(table.columnId, table.rank),
    index("workshop_task_projectId_idx").on(table.projectId),
    index("workshop_task_assigneeMemberId_idx").on(table.assigneeMemberId),
    check("workshop_task_title_ck", sql`char_length(title) BETWEEN 1 AND 200`),
    check(
      "workshop_task_description_ck",
      sql`description IS NULL OR char_length(description) <= 5000`,
    ),
    check("workshop_task_labels_ck", sql`cardinality(labels) <= 8`),
    // The alphabet guard. Without it a rank containing an uppercase letter or a hyphen
    // orders one way in Postgres under a non-C collation and another way in the client.
    check("workshop_task_rank_ck", sql`rank ~ '^[0-9a-z]+$'`),
  ],
);

/**
 * A shared file — TODAY, A LINK.
 *
 * `sizeBytes` is NULL and stays NULL. The rule was never "store a size"; it was "the
 * server measures the bytes, the client's claim is never trusted" (§0). With a link there
 * are no bytes to measure, so the honest value is null rather than a number the client
 * made up. No client may render a size for a linked file.
 *
 * `contentSha256`, `storageProvider` and `objectKey` are the Appendix A seam: nullable,
 * written by nothing, and the reason restoring presigned upload does not rewrite a row.
 */
export const workshopFile = pgTable(
  "workshop_file",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    fileName: text("file_name").notNull(),
    fileKind: workshopFileKindEnum("file_kind").default("other").notNull(),
    source: workshopFileSourceEnum("source").default("external_link").notNull(),
    // The NORMALIZED url — credentials and fragment stripped by src/modules/rnd/external-link.ts,
    // host allowlisted. The client's raw string is never stored and never echoed.
    externalUrl: text("external_url"),
    // Derived from externalUrl by the server, stored so a client can badge the source
    // without re-parsing a URL (and so a host allowlist change is auditable).
    externalHost: text("external_host"),
    // --- The Appendix A seam. Nullable, and written by NOTHING.
    sizeBytes: integer("size_bytes"),
    contentSha256: text("content_sha256"),
    storageProvider: workshopStorageProviderEnum("storage_provider"),
    objectKey: text("object_key"),
    // `restrict`: a file can be §9 evidence, so its uploader must stay resolvable.
    uploadedByMemberId: text("uploaded_by_member_id")
      .notNull()
      .references(() => projectMember.id, { onDelete: "restrict" }),
    // SOFT delete. A hard delete would erase a row a §9 claim may reference, and the
    // uniqueness rule below has to be able to tell "removed" from "never existed".
    removedAt: timestamp("removed_at"),
    removedByUserId: text("removed_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("workshop_file_projectId_createdAt_idx").on(table.projectId, table.createdAt, table.id),
    // The same link twice on one project is a mistake, not an intent. Partial, so a
    // removed link can be re-added.
    uniqueIndex("workshop_file_projectId_externalUrl_unq")
      .on(table.projectId, table.externalUrl)
      .where(sql`removed_at IS NULL`),
    check("workshop_file_fileName_ck", sql`char_length(file_name) BETWEEN 1 AND 200`),
    // Makes the two shapes unrepresentable in each other's terms (CLAUDE.md Pattern 1):
    // a link has a URL and no size; a hosted object has a key. Neither can be half-set.
    check(
      "workshop_file_source_shape_ck",
      sql`(source = 'external_link'
             AND external_url IS NOT NULL AND external_host IS NOT NULL
             AND size_bytes IS NULL AND object_key IS NULL)
          OR (source = 'hosted' AND object_key IS NOT NULL)`,
    ),
    check(
      "workshop_file_externalUrl_ck",
      sql`external_url IS NULL
          OR (char_length(external_url) <= 2048 AND external_url LIKE 'https://%')`,
    ),
    check("workshop_file_sizeBytes_ck", sql`size_bytes IS NULL OR size_bytes >= 0`),
    check(
      "workshop_file_removed_ck",
      sql`(removed_by_user_id IS NULL) OR (removed_at IS NOT NULL)`,
    ),
  ],
);

/**
 * One team-chat message.
 *
 * `sentAt` is the PAGINATION CURSOR as well as a display field, which is why every index
 * ends in `id` (§4c rule 4): two messages sharing an instant must still have a total order,
 * or a keyset page either repeats a row or skips one.
 *
 * AND WHY IT IS `precision: 3`, WHICH IS NOT A DETAIL. This column was declared with
 * microsecond precision, and `workshop-chat.service.ts` encodes the cursor as
 * `sentAt.getTime()` — MILLISECONDS. A cursor coarser than its column cannot express the
 * boundary: the next page asks for `sent_at < <ms>` OR `sent_at = <ms>`, and a row whose
 * true value carries microseconds matches neither. The row is not duplicated or
 * misordered, it is UNREACHABLE ON EVERY PAGE.
 *
 * It was reproducible, not theoretical. `now()` is fixed for the duration of a statement,
 * so a multi-row insert gives every row a byte-identical microsecond `sent_at`, and
 * `db:smoke-workshop` lost exactly one message per page boundary. Rounding at the column
 * makes the stored value always exactly representable in the milliseconds the cursor
 * carries, so `defaultNow()` keeps working and the guarantee lives in the type rather than
 * in a comment someone has to remember. `editedAt` and `deletedAt` are display-only and
 * feed no cursor, so they keep microsecond precision.
 *
 * Deletes are SOFT for the same reason — a hard delete punches a hole in a cursor, and a
 * client paging backwards silently loses a page.
 */
export const workshopChatMessage = pgTable(
  "workshop_chat_message",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    authorMemberId: text("author_member_id")
      .notNull()
      .references(() => projectMember.id, { onDelete: "restrict" }),
    messageText: text("message_text").notNull(),
    sentAt: timestamp("sent_at", { precision: 3 }).defaultNow().notNull(),
    editedAt: timestamp("edited_at", { precision: 6 }),
    deletedAt: timestamp("deleted_at", { precision: 6 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("workshop_chat_message_projectId_sentAt_idx").on(table.projectId, table.sentAt, table.id),
    check("workshop_chat_message_text_ck", sql`char_length(message_text) BETWEEN 1 AND 4000`),
    check("workshop_chat_message_edited_ck", sql`edited_at IS NULL OR edited_at >= sent_at`),
  ],
);

/** Per-member read cursor. Composite natural PK, so marking read is one upsert. */
export const workshopChatReadState = pgTable(
  "workshop_chat_read_state",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    memberId: text("member_id")
      .notNull()
      .references(() => projectMember.id, { onDelete: "restrict" }),
    // `set null`: a read cursor pointing at a message is a preference, and it must never
    // stop a message row from being cleaned up in some future retention pass.
    throughMessageId: text("through_message_id").references(() => workshopChatMessage.id, {
      onDelete: "set null",
    }),
    readAt: timestamp("read_at", { precision: 6 }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.memberId] })],
);

/**
 * A daily log — the input to the entire equity ledger (§9).
 *
 * `logDate` (the day CLAIMED) and `submittedAt` (the instant it was filed) are two
 * distinct fields and are never collapsed: filing Monday's work on Tuesday morning is
 * ordinary, and a single timestamp cannot say which day the effort belongs to.
 *
 * The video is OPTIONAL and, when present, is an 11-character YouTube id — never the
 * client's URL (§0). Every embed URL is rebuilt server-side by
 * src/lib/youtube.ts buildYoutubeEmbedUrl. There is no playback token, because the bytes
 * are on youtube.com and minting one would be a false security promise.
 */
export const dailyLog = pgTable(
  "daily_log",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    // `restrict`: this row is effort evidence and its author must stay resolvable
    // forever. Membership is never hard-deleted anyway (§4a), so this costs nothing.
    authorMemberId: text("author_member_id")
      .notNull()
      .references(() => projectMember.id, { onDelete: "restrict" }),
    logDate: date("log_date", { mode: "string" }).notNull(),
    narrative: text("narrative"),
    status: dailyLogStatusEnum("status").default("draft").notNull(),
    /**
     * `precision: 3`, and it is load-bearing for the same reason `workshop_chat_message`'s
     * `sent_at` is: this column is the SECOND TERM OF THE CROSS-PROJECT FEED'S KEYSET
     * CURSOR (§11h), and `src/modules/rnd/daily-log-cursor.ts` encodes it as `getTime()` —
     * milliseconds. A microsecond column under a millisecond cursor makes rows between the
     * truncated boundary and the true value unreachable on every page.
     *
     * `submitDailyLog` writes `new Date()`, so nothing in the application has ever produced
     * a sub-millisecond value here. That made it correct by accident of one write path,
     * which a backfill, an import or a `defaultNow()` would have quietly broken. The type
     * is now the guarantee.
     */
    submittedAt: timestamp("submitted_at", { precision: 3 }),
    // --- Video. Server-derived in every field; a client that sends one gets a 422.
    videoSource: dailyLogVideoSourceEnum("video_source").default("none").notNull(),
    youtubeVideoId: text("youtube_video_id"),
    // YouTube's own oEmbed thumbnail, host-allowlisted by sanitizeYoutubeThumbnailUrl
    // before it is stored — it is a third-party string a client will put in an <img src>.
    youtubeThumbnailUrl: text("youtube_thumbnail_url"),
    videoVerifiedAt: timestamp("video_verified_at"),
    // --- Analysis. The JOB's lifecycle, never a verdict (rule 2 at the top of §8).
    analysisStatus: dailyLogAnalysisStatusEnum("analysis_status")
      .default("not_requested")
      .notNull(),
    analysisModelName: text("analysis_model_name"),
    analysisModelVersion: text("analysis_model_version"),
    analysisPromptVersion: text("analysis_prompt_version"),
    analysisCompletedAt: timestamp("analysis_completed_at"),
    // Operator- and member-readable reason, never a stack trace.
    analysisFailureReason: text("analysis_failure_reason"),
    // --- §9's verdict column. WRITTEN BY NOTHING IN THIS PHASE. The frontend's
    // `isEffortVerified: boolean` is derived from it on read as `=== 'verified'`.
    effortVerificationStatus: effortVerificationStatusEnum("effort_verification_status")
      .default("not_run")
      .notNull(),
    // Client-supplied, and one of the few client strings this domain accepts — it is an
    // opaque dedup token, not a value the server owns. A retried submit on a flaky mobile
    // connection must not file twice.
    submitIdempotencyKey: text("submit_idempotency_key"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    // ONE log per member per claimed day. This is what makes the streak countable and
    // stops the same day funding two §9 claims.
    uniqueIndex("daily_log_projectId_authorMemberId_logDate_unq").on(
      table.projectId,
      table.authorMemberId,
      table.logDate,
    ),
    uniqueIndex("daily_log_authorMemberId_idempotencyKey_unq")
      .on(table.authorMemberId, table.submitIdempotencyKey)
      .where(sql`submit_idempotency_key IS NOT NULL`),
    index("daily_log_projectId_logDate_idx").on(table.projectId, table.logDate, table.id),
    // THE CROSS-PROJECT FEED INDEX (Appendix B2). `GET /daily-logs` filters on the
    // caller's memberships and orders `(logDate DESC, submittedAt DESC, id DESC)` across
    // every one of them at once, so the project-leading index above cannot serve it —
    // that one can order WITHIN a project, and merging six projects in the service is
    // exactly what §13 forbids. Partial on `submitted` because drafts never enter the
    // feed, which also keeps `submitted_at` NOT NULL for every row the cursor addresses
    // (daily_log_submitted_ck).
    index("daily_log_feed_idx")
      .on(table.projectId, table.logDate, table.submittedAt, table.id)
      .where(sql`status = 'submitted'`),
    // The operator's queue: logs whose analysis is stuck or was never run.
    index("daily_log_analysisStatus_idx")
      .on(table.analysisStatus, table.id)
      .where(sql`status = 'submitted'`),
    check("daily_log_narrative_ck", sql`narrative IS NULL OR char_length(narrative) <= 10000`),
    // A YouTube log has an id; a log without one is `none` or the deferred `hosted`.
    check("daily_log_video_ck", sql`(video_source = 'youtube') = (youtube_video_id IS NOT NULL)`),
    // THIS IS A SECURITY CONSTRAINT, not tidiness — the same one `video` has carried since
    // 0012, and for the same reason. The id is interpolated into the outbound oEmbed URL and
    // into every embed URL emitted from it; the charset contains no ".", "/", ":", "@" or "%",
    // which is what closes SSRF at the storage layer even if a write path forgets to parse.
    // The check above pairs source and id; it says nothing about the id's CONTENT.
    check(
      "daily_log_youtube_id_format_ck",
      sql`youtube_video_id IS NULL OR youtube_video_id ~ '^[A-Za-z0-9_-]{11}$'`,
    ),
    check("daily_log_submitted_ck", sql`(status = 'submitted') = (submitted_at IS NOT NULL)`),
    // A draft has asked nothing of the model; a completed analysis reached a terminal
    // state. Neither half can be half-true.
    check(
      "daily_log_analysis_ck",
      sql`(analysis_status = 'not_requested' OR status = 'submitted')
          AND (analysis_completed_at IS NULL
               OR analysis_status IN ('succeeded', 'failed', 'skipped_unconfigured'))`,
    ),
  ],
);

/**
 * A transcript segment. JOB-WRITTEN, and regenerated wholesale on re-analysis — which is
 * what makes `analyze-daily-log` safe to retry.
 *
 * Offsets are integer SECONDS (§4c rule 2). A float offset from an LLM would be a float
 * in an evidence record, and §9 has to be able to overlap these windows against artifact
 * timestamps deterministically.
 */
export const dailyLogTranscriptSegment = pgTable(
  "daily_log_transcript_segment",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    // Cascade: a derivative that can be recomputed from the log at any time.
    dailyLogId: text("daily_log_id")
      .notNull()
      .references(() => dailyLog.id, { onDelete: "cascade" }),
    sequenceNumber: integer("sequence_number").notNull(),
    startOffsetSeconds: integer("start_offset_seconds").notNull(),
    endOffsetSeconds: integer("end_offset_seconds"),
    speakerLabel: text("speaker_label"),
    segmentText: text("segment_text").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("daily_log_transcript_segment_logId_seq_unq").on(
      table.dailyLogId,
      table.sequenceNumber,
    ),
    check("daily_log_transcript_segment_seq_ck", sql`sequence_number >= 0`),
    check(
      "daily_log_transcript_segment_offsets_ck",
      sql`start_offset_seconds >= 0
          AND (end_offset_seconds IS NULL OR end_offset_seconds >= start_offset_seconds)`,
    ),
    check(
      "daily_log_transcript_segment_text_ck",
      sql`char_length(segment_text) BETWEEN 1 AND 5000`,
    ),
  ],
);

/** An AI summary chip. Model output, with its provenance attached (rule 4). */
export const dailyLogAiSummaryChip = pgTable(
  "daily_log_ai_summary_chip",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    dailyLogId: text("daily_log_id")
      .notNull()
      .references(() => dailyLog.id, { onDelete: "cascade" }),
    sequenceNumber: integer("sequence_number").notNull(),
    kind: aiSummaryChipKindEnum("kind").notNull(),
    label: text("label").notNull(),
    // Integer basis points, like every other ratio in this domain (§4b). NULL when the
    // model offered no confidence — never 0, which would read as "certainly wrong".
    confidenceBps: integer("confidence_bps"),
    generatedByModel: text("generated_by_model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("daily_log_ai_summary_chip_logId_seq_unq").on(
      table.dailyLogId,
      table.sequenceNumber,
    ),
    // The `?chipKind=` filter on the cross-project feed (Appendix B2) is a correlated
    // EXISTS, so it probes THIS table by kind and joins back on the log id. The unique
    // above is log-leading and cannot serve that direction. Filtering after the fetch
    // instead would page a feed against a predicate applied to only one page of it.
    index("daily_log_ai_summary_chip_kind_logId_idx").on(table.kind, table.dailyLogId),
    check("daily_log_ai_summary_chip_label_ck", sql`char_length(label) BETWEEN 1 AND 80`),
    check(
      "daily_log_ai_summary_chip_confidence_ck",
      sql`confidence_bps IS NULL OR confidence_bps BETWEEN 0 AND 10000`,
    ),
  ],
);

/**
 * An extracted claim — THE BRIDGE INTO §9, and nothing more.
 *
 * `extractedMinutes` is what the member SAID, read out of their own words by a model. It
 * is not effort, it is not grounded, and it pays nobody: §9's ledger prices
 * COALESCE(overriddenMinutes, groundedMinutes) and never touches this column. Collapsing
 * the two destroys the audit story (§9.6), so `groundedMinutes` is deliberately absent
 * from this table.
 */
export const dailyLogExtractedClaim = pgTable(
  "daily_log_extracted_claim",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    dailyLogId: text("daily_log_id")
      .notNull()
      .references(() => dailyLog.id, { onDelete: "cascade" }),
    sequenceNumber: integer("sequence_number").notNull(),
    claimKind: extractedClaimKindEnum("claim_kind").notNull(),
    extractedMinutes: integer("extracted_minutes"),
    // Integer cents, `bigint` per §4b — a cash claim is money and money is never int4.
    extractedCashInCents: bigint("extracted_cash_in_cents", { mode: "bigint" }),
    claimSummary: text("claim_summary").notNull(),
    confidenceBps: integer("confidence_bps"),
    generatedByModel: text("generated_by_model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("daily_log_extracted_claim_logId_seq_unq").on(
      table.dailyLogId,
      table.sequenceNumber,
    ),
    check(
      "daily_log_extracted_claim_summary_ck",
      sql`char_length(claim_summary) BETWEEN 1 AND 1000`,
    ),
    // A day holds 1440 minutes. A larger extraction is a model error, not a work record,
    // and it must fail at the write rather than surface as a plausible number in §9.
    check(
      "daily_log_extracted_claim_minutes_ck",
      sql`extracted_minutes IS NULL OR extracted_minutes BETWEEN 0 AND 1440`,
    ),
    check(
      "daily_log_extracted_claim_cash_ck",
      sql`extracted_cash_in_cents IS NULL OR extracted_cash_in_cents >= 0`,
    ),
    check(
      "daily_log_extracted_claim_confidence_ck",
      sql`confidence_bps IS NULL OR confidence_bps BETWEEN 0 AND 10000`,
    ),
  ],
);

/**
 * A machine-readable evidence reference — a commit, a design file, a document.
 *
 * §9 grounds effort on these, so the source matters: a member-supplied link is a claim
 * about their own work, while an AI-extracted one is a reading of the transcript. Storing
 * which is which at write time is the only moment that distinction is knowable.
 */
export const dailyLogEvidenceLink = pgTable(
  "daily_log_evidence_link",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    dailyLogId: text("daily_log_id")
      .notNull()
      .references(() => dailyLog.id, { onDelete: "cascade" }),
    provider: evidenceLinkProviderEnum("provider").default("other").notNull(),
    sourceKind: evidenceLinkSourceKindEnum("source_kind").notNull(),
    // Normalized and host-checked before storage, exactly like workshop_file.externalUrl.
    externalUrl: text("external_url").notNull(),
    externalHost: text("external_host").notNull(),
    // The provider's own id when one can be parsed out (a commit sha, a file key). §9
    // dedupes artifacts on this, which is why it is stored rather than re-derived.
    externalId: text("external_id"),
    generatedByModel: text("generated_by_model"),
    promptVersion: text("prompt_version"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("daily_log_evidence_link_logId_url_unq").on(table.dailyLogId, table.externalUrl),
    check(
      "daily_log_evidence_link_url_ck",
      sql`char_length(external_url) <= 2048 AND external_url LIKE 'https://%'`,
    ),
    // Model provenance is required exactly when a model produced the row (rule 4).
    check(
      "daily_log_evidence_link_provenance_ck",
      sql`(source_kind = 'ai_extracted')
          = (generated_by_model IS NOT NULL AND prompt_version IS NOT NULL)`,
    ),
  ],
);

// --- §8 relations. Child-side only, same convention as §5, §6 and the studio domain.

export const workshopBoardColumnRelations = relations(workshopBoardColumn, ({ one, many }) => ({
  project: one(researchProject, {
    fields: [workshopBoardColumn.projectId],
    references: [researchProject.id],
  }),
  createdBy: one(user, {
    fields: [workshopBoardColumn.createdByUserId],
    references: [user.id],
  }),
  tasks: many(workshopTask),
}));

export const workshopTaskRelations = relations(workshopTask, ({ one }) => ({
  project: one(researchProject, {
    fields: [workshopTask.projectId],
    references: [researchProject.id],
  }),
  boardColumn: one(workshopBoardColumn, {
    fields: [workshopTask.columnId],
    references: [workshopBoardColumn.id],
  }),
  assignee: one(projectMember, {
    fields: [workshopTask.assigneeMemberId],
    references: [projectMember.id],
  }),
}));

export const workshopFileRelations = relations(workshopFile, ({ one }) => ({
  project: one(researchProject, {
    fields: [workshopFile.projectId],
    references: [researchProject.id],
  }),
  uploadedBy: one(projectMember, {
    fields: [workshopFile.uploadedByMemberId],
    references: [projectMember.id],
  }),
}));

export const workshopChatMessageRelations = relations(workshopChatMessage, ({ one }) => ({
  project: one(researchProject, {
    fields: [workshopChatMessage.projectId],
    references: [researchProject.id],
  }),
  author: one(projectMember, {
    fields: [workshopChatMessage.authorMemberId],
    references: [projectMember.id],
  }),
}));

export const workshopChatReadStateRelations = relations(workshopChatReadState, ({ one }) => ({
  project: one(researchProject, {
    fields: [workshopChatReadState.projectId],
    references: [researchProject.id],
  }),
  member: one(projectMember, {
    fields: [workshopChatReadState.memberId],
    references: [projectMember.id],
  }),
  throughMessage: one(workshopChatMessage, {
    fields: [workshopChatReadState.throughMessageId],
    references: [workshopChatMessage.id],
  }),
}));

export const dailyLogRelations = relations(dailyLog, ({ one, many }) => ({
  project: one(researchProject, {
    fields: [dailyLog.projectId],
    references: [researchProject.id],
  }),
  author: one(projectMember, {
    fields: [dailyLog.authorMemberId],
    references: [projectMember.id],
  }),
  transcriptSegments: many(dailyLogTranscriptSegment),
  aiSummaryChips: many(dailyLogAiSummaryChip),
  extractedClaims: many(dailyLogExtractedClaim),
  evidenceLinks: many(dailyLogEvidenceLink),
}));

export const dailyLogTranscriptSegmentRelations = relations(
  dailyLogTranscriptSegment,
  ({ one }) => ({
    dailyLog: one(dailyLog, {
      fields: [dailyLogTranscriptSegment.dailyLogId],
      references: [dailyLog.id],
    }),
  }),
);

export const dailyLogAiSummaryChipRelations = relations(dailyLogAiSummaryChip, ({ one }) => ({
  dailyLog: one(dailyLog, {
    fields: [dailyLogAiSummaryChip.dailyLogId],
    references: [dailyLog.id],
  }),
}));

export const dailyLogExtractedClaimRelations = relations(dailyLogExtractedClaim, ({ one }) => ({
  dailyLog: one(dailyLog, {
    fields: [dailyLogExtractedClaim.dailyLogId],
    references: [dailyLog.id],
  }),
}));

export const dailyLogEvidenceLinkRelations = relations(dailyLogEvidenceLink, ({ one }) => ({
  dailyLog: one(dailyLog, {
    fields: [dailyLogEvidenceLink.dailyLogId],
    references: [dailyLog.id],
  }),
}));

// ---------------------------------------------------------------------------
// R&D §9 — Proof of Effort: the Slicing Pie ledger and its verification pipeline.
// See docs/R_AND_D_BACKEND_STRUCTURE.md §9 and docs/PROOF_OF_EFFORT_SPEC.md §3-§4.
//
// THE DETERMINISM BOUNDARY IS DRAWN IN THIS SCHEMA, NOT IN PROSE (§9.1). Read the
// column list of any table below and you can tell which side of it you are on:
//
//   AI-PRODUCED — reviewable, overridable. `effort_claim.extractedMinutes` /
//     `groundedMinutes`, `verification_step.status` / `findingSummary` / `scoreBps`,
//     `receipt_forensics_check.result`, `optimization_suggestion.*`. Every one of
//     them carries `modelName` + `promptVersion` + `confidenceBps` AND an override
//     quartet (`overriddenStatus`, `reviewedByUserId`, `overrideReason`, `reviewedAt`).
//
//   FORMULA-PRODUCED — never hand-edited by anyone, including staff, including the
//     founder, including a DBA. `slice_ledger_entry.sliceNumerator` / `slicesAwarded`,
//     `slice_allocation_proposal.proposedSlices`, `equity_snapshot_share.equityBasisPoints`,
//     `project_audit_entry.entryHash`, `member_fair_market_rate.*` once locked. These
//     tables have NO OVERRIDE COLUMNS AT ALL — their absence IS the contract.
//
// Corrections flow one way: change an INPUT and let the formula recompute, or append a
// `reversal` entry. Never an UPDATE.
//
// SEVEN RULES THAT GOVERN EVERY TABLE BELOW:
//
//  1. THERE IS NO WRITABLE EQUITY COLUMN, ANYWHERE. A member's share is the output of
//     apportioning `slice_ledger_entry` sums; a founder cannot type a number into
//     someone's stake because there is no field to type it into.
//
//  2. EQUITY IS `integer` BASIS POINTS; SLICE NUMERATORS ARE `bigint`. A single entry
//     already reaches 8,880 × 12,000 = 106,560,000 and summed over years a project
//     approaches Number.MAX_SAFE_INTEGER (§9.2). `slicesAwarded` and
//     `equityBasisPoints` stay `integer` because both are bounded and small.
//
//  3. THE LEDGER AND THE AUDIT TRAIL ARE APPEND-ONLY AND NEVER CASCADE (§4f). Every
//     parent FK on `slice_ledger_entry`, `project_audit_entry`, `effort_claim`,
//     `artifact_evidence` and `member_fair_market_rate` is `restrict`, and BEFORE
//     UPDATE OR DELETE triggers reject mutation outright — added by hand in the
//     migration, exactly as 0010 did for `project_member_interval`.
//
//  4. NO SLICES EXIST UNTIL A WINDOW LOCKS (§9.8). `finalize-verdict` opens a
//     `slice_allocation_proposal` and freezes `proposedSlices` ON THE PROPOSAL,
//     outside `totalSlices`. The 24-hour window is a PRECONDITION for an award, not
//     an annotation on one.
//
//  5. RATES ARE EFFECTIVE-DATED, NOT A COLUMN ON project_member. A raise must not
//     retroactively re-price two years of logged effort, so every ledger entry pins
//     `fairMarketRateId` and history stays anchored to the rate in force (§9.6).
//
//  6. REVOCATION DESTROYS THE EVIDENCE, NEVER THE EQUITY (§9.10).
//     `artifact_evidence.rawPayloadJson` goes NULL while `payloadSha256`,
//     `externalId`, `label`, `artifactOccurredAt` and `signatureStatus` are RETAINED —
//     the claim stays provable without the platform holding a copy of anyone's code.
//     No `slice_ledger_entry` is ever touched.
//
//  7. `actorNameSnapshot` IS INSIDE THE HASH AND MUST BE PSEUDONYMOUS AT WRITE TIME.
//     A user row can be anonymized later; a value already hashed into a chain cannot
//     be edited without breaking it. Get this right at the first write or GDPR and the
//     chain become mutually exclusive (§9.10).
//
// WHAT IS DELIBERATELY ABSENT:
//   - `verification_job`. §9.6 lists a queue table and §9.7 shows its dequeue SQL, but
//     that is precisely what pg-boss already does (`FOR UPDATE SKIP LOCKED`, priority
//     ordering, leases, exponential backoff, dead-letter). §4e picked pg-boss as THE
//     job runner; a second hand-rolled queue beside it would be two schedulers with
//     two retry policies that drift.
//   - A reserve slice pool and the fixed 200,000-slice constant (§9.5). Both are
//     founder fiat in the denominator, which is the one thing this product exists to
//     eliminate. `equity_snapshot.totalSlices` is EMERGENT — a live SUM — and the
//     UI's reserve affordance is replaced by a projection computed on read from the
//     advertised compensation band, never persisted as slices.
//   - `consensusAdjustedMinutes`. §9.12's open decision is settled as option (a): a
//     dispute resolution narrows a WINDOW and the server re-derives minutes from
//     artifact overlap inside it. No number ever enters through a request body.
//
// WHAT DRIZZLE CANNOT EXPRESS, added by hand in migration 0014 (§17 step 1): the
// append-only triggers, the narrow UPDATE guards on member_fair_market_rate and
// artifact_evidence, and the TRUNCATE guards a row trigger never fires for. The partial
// unique indexes below ARE emitted by drizzle-kit and are declared normally.
// ---------------------------------------------------------------------------

// A negotiated rate's lifecycle. `locked` is terminal and immutable — the trigger in
// the migration rejects any UPDATE of a locked row, because §9.6 calls this "the most
// important table in the domain": SPEC §2's "valuation rules locked in and transparent
// to everyone".
export const fairMarketRateStatusEnum = pgEnum("fair_market_rate_status", [
  "proposed", // the founder has offered it; it prices nothing yet
  "accepted", // the member agreed
  "locked", // immutable forever; only now can claims be filed against it
]);

// Where a claim's evidence comes from. Git is deterministic; sanding a 3D-printed
// chassis is not (SPEC §4), so physical work grounds on uploaded receipts instead of
// on API artifacts.
export const effortClaimSourceKindEnum = pgEnum("effort_claim_source_kind", [
  "daily_log",
  "physical_receipt",
]);

// SPEC §4's four-step audit, in order. `stepOrder` is this list's position, 1-based.
export const verificationStepKindEnum = pgEnum("verification_step_kind", [
  "claim_extraction", // what did the member actually claim?
  "artifact_grounding", // do deterministic digital receipts back it?
  "substance_analysis", // substantive work, or 5,000 lines of padding?
  "temporal_analysis", // do the timestamps match the hours claimed?
]);

// One step's outcome. `skipped` and `failed` are NOT interchangeable and the difference
// decides whether someone is paid: `skipped` means the step does not apply (AST analysis
// of a photograph), while a claim with NO digital receipts FAILS grounding — SPEC §4
// step 2 is explicit that it earns zero. See src/modules/rnd/verdict.ts.
export const verificationStepStatusEnum = pgEnum("verification_step_status", [
  "pending",
  "passed",
  "flagged",
  "failed",
  "skipped",
]);

// The kind of contribution a ledger entry prices. Both reduce to one denominator of
// 3000 (§9.2), which is why there is one numerator column rather than two.
export const sliceContributionKindEnum = pgEnum("slice_contribution_kind", ["time", "cash"]);

// Append-only correction mechanism. A `reversal` names the entry it reverses and carries
// a negative numerator; there is no UPDATE and no DELETE (§9.1).
export const sliceLedgerEntryKindEnum = pgEnum("slice_ledger_entry_kind", ["award", "reversal"]);

// The 24-hour transparency window's state machine (§9.8). `locked` and
// `consensus_reached` are both terminal and both have written exactly one ledger entry;
// they differ only in whether a human was involved.
export const sliceAllocationProposalStatusEnum = pgEnum("slice_allocation_proposal_status", [
  "open", // window running; NOTHING is in the ledger
  "disputed", // slices frozen in escrow, reported separately from totalSlices
  "locked", // expiry sweep settled it; terminal
  "consensus_reached", // a dispute resolved it; terminal
]);

export const disputeStatusEnum = pgEnum("dispute_status", [
  "open",
  "withdrawn", // by the raiser only, before windowClosesAt
  "consensus_reached",
]);

// How a dispute ended. `re_verified` is the ONLY path that changes the amount, and the
// amount still comes from the formula — the resolver narrows a window, the server
// re-derives minutes from artifact overlap inside it (§9.12 option (a)).
export const disputeResolutionEnum = pgEnum("dispute_resolution", [
  "upheld", // released at full proposedSlices
  "voided", // released at 0 — but a zero-slice entry IS still written
  "re_verified", // scoped re-verification run; settles at the re-derived number
]);

export const disputeVotePositionEnum = pgEnum("dispute_vote_position", [
  "uphold",
  "void",
  "re_verify",
]);

// Where an artifact came from. `workshop_link` and `daily_log_link` are the zero-cost
// providers that need no OAuth at all: rows already stored by §8.
export const artifactProviderEnum = pgEnum("artifact_provider", [
  "github",
  "gitlab",
  "figma",
  "jira",
  "linear",
  "notion",
  "google_docs",
  "daily_log_link",
  "workshop_link",
  "physical_receipt",
  "other",
]);

// Cryptographic standing of an artifact. `unknown` is honest and common — a provider
// that does not expose signatures cannot be made to.
export const artifactSignatureStatusEnum = pgEnum("artifact_signature_status", [
  "valid",
  "invalid",
  "unsigned",
  "unknown",
]);

// Providers a member can actually connect. Narrower than artifactProviderEnum on
// purpose: the link providers need no grant, and a grant for something we cannot call
// is a token with no purpose.
export const integrationProviderEnum = pgEnum("integration_provider", [
  "github",
  "gitlab",
  "figma",
  "jira",
  "linear",
]);

export const integrationGrantStatusEnum = pgEnum("integration_grant_status", [
  "pending", // authorize-url issued, callback not yet returned
  "active",
  "revoked",
  "expired",
]);

export const physicalReceiptKindEnum = pgEnum("physical_receipt_kind", [
  "photo_of_work",
  "cad_file",
  "material_receipt",
  "other",
]);

// SPEC §4's hardware edge case: EXIF check, device fingerprint, reverse image search.
export const receiptForensicsCheckKindEnum = pgEnum("receipt_forensics_check_kind", [
  "exif_present",
  "capture_time_consistency",
  "device_fingerprint",
  "reverse_image_search",
]);

// `not_applicable` is a first-class result, not a silent pass. Reverse image search
// ships a member's photo to a third party and therefore needs its own explicit consent
// (§9.10); without it the check records `not_applicable` rather than being skipped
// invisibly or, worse, run anyway.
export const receiptForensicsResultEnum = pgEnum("receipt_forensics_result", [
  "pass",
  "flag",
  "fail",
  "not_applicable",
]);

// Every event that appends to the hash chain (§9.9). Adding a value here changes what
// the chain covers, never how it is hashed.
export const projectAuditEventKindEnum = pgEnum("project_audit_event_kind", [
  "rate_proposed",
  "rate_accepted",
  "rate_locked",
  "claim_submitted",
  "claim_verdict_reached",
  "verification_step_overridden",
  "claim_reverification_requested",
  "allocation_proposal_opened",
  "allocation_disputed",
  "dispute_withdrawn",
  "dispute_vote_cast",
  "dispute_resolved",
  "slices_awarded",
  "slices_reversed",
  "integration_consent_granted",
  "integration_consent_revoked",
  "equity_snapshot_recomputed",
  "pie_baked",
  // --- §7. Every money event appends to THIS chain, in the same transaction as the
  // --- escrow journal entry it records (§9.9). The escrow journal has its own hash
  // --- chain over the postings; this is the human-readable trail beside it, and the two
  // --- advance under ONE lock (project_chain_head).
  "funding_round_opened",
  "funding_round_closed",
  "pledge_recorded",
  "pledge_settled",
  "pledge_failed",
  "pledge_cancelled",
  "escrow_release_requested",
  "escrow_release_approved",
  "escrow_release_rejected",
  "reconciliation_discrepancy_opened",
  // --- §7A. The compensation statement's own events. They append to THIS chain, in the
  // --- same transaction as the thing they record, under the SAME project_chain_head lock
  // --- that already serializes the audit, ledger and escrow counters (§7A.5).
  "compensation_agreement_proposed",
  "compensation_agreement_accepted",
  // The two ways a proposal dies, and they are ONE status with TWO events. The status
  // column has four values and `declined` is not among them, so both land on `withdrawn`
  // — "a proposal nobody accepted", which is what the enum above already says it means.
  // The audit kind is therefore the only thing that records WHO ended it, and that
  // distinction is the whole point: a member refusing terms and a founder retracting an
  // offer are different events with different consequences, and §7A.6 needs to tell them
  // apart. It is also the only place the decline note and the withdrawal reason survive —
  // neither has a column on `member_cash_compensation_agreement`.
  "compensation_agreement_declined",
  "compensation_agreement_withdrawn",
  "compensation_period_opened",
  "compensation_period_finalized",
  "compensation_period_countersigned",
  "compensation_period_superseded",
  "compensation_payment_recorded",
  "compensation_payment_confirmed",
]);

export const optimizationSuggestionStatusEnum = pgEnum("optimization_suggestion_status", [
  "open",
  "accepted",
  "dismissed",
]);

// SPEC §3.4: dynamic calculation stops at cash-flow breakeven or a priced round.
export const pieBakeTriggerEnum = pgEnum("pie_bake_trigger", [
  "cash_flow_breakeven",
  "priced_round",
]);

/**
 * THE MOST IMPORTANT TABLE IN THE DOMAIN (§9.6) — the negotiated fair market rate,
 * effective-dated and immutable once locked.
 *
 * WHY EFFECTIVE-DATING RATHER THAN A COLUMN ON project_member: a raise must not
 * retroactively re-price two years of logged effort. Each ledger entry stores
 * `fairMarketRateId`, so history pins to the rate in force. A single mutable column
 * makes every historical slice count a function of TODAY's rate — precisely the
 * founder-tweaks-the-spreadsheet failure mode SPEC §2 exists to prevent, and the bug
 * stays invisible until someone gets a raise.
 *
 * WHY TWO RATE COLUMNS. Slicing Pie credits only the UNPAID portion of a contribution,
 * so the ledger prices `fairMarketRateCentsPerHour − paidCashRateCentsPerHour`. Without
 * the second column a salaried member earns full sweat equity ON TOP OF their salary;
 * §9.2 calls that the largest correctness gap in the mock, and it has no frontend
 * representation at all. See src/modules/rnd/slice-math.ts `unpaidRateCentsPerHour`.
 *
 * THE ONE PLACE A RATE LEGITIMATELY ENTERS VIA A REQUEST BODY (§0, §13). It is a
 * NEGOTIATED INPUT, not a derived output — the same category as a founder's advertised
 * equity band, and the only other exception in the whole domain.
 */
export const memberFairMarketRate = pgTable(
  "member_fair_market_rate",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    memberId: text("member_id")
      .notNull()
      .references(() => projectMember.id, { onDelete: "restrict" }),
    // `bigint` because it is money (§4b). A rate is per HOUR while effort is recorded in
    // MINUTES; the conversion is exact integer arithmetic over a denominator of 3000 and
    // happens only in src/modules/rnd/slice-math.ts.
    fairMarketRateCentsPerHour: bigint("fair_market_rate_cents_per_hour", {
      mode: "bigint",
    }).notNull(),
    // What the member is ALREADY paid in cash for the same hour. Zero for the unpaid
    // founder case, which is most of them.
    // `sql\`0\`` rather than `0n`: drizzle-kit serializes its snapshot with JSON.stringify,
    // which throws outright on a BigInt default. This is the only bigint default in the
    // schema, and the SQL literal produces an identical `DEFAULT 0` column.
    paidCashRateCentsPerHour: bigint("paid_cash_rate_cents_per_hour", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    // An amount is never stored or sent without its currency (§4b). Derived from the
    // project, never from a request body.
    currencyCode: text("currency_code").notNull(),
    status: fairMarketRateStatusEnum("status").default("proposed").notNull(),
    // The instant from which this rate prices effort. Absolute, never a day count (§4c).
    effectiveFrom: timestamp("effective_from").notNull(),
    // Why this number. Required: a rate with no stated basis is founder fiat with extra
    // steps, and this column is what makes the history in §11e's GET readable.
    rationaleNote: text("rationale_note").notNull(),
    proposedByUserId: text("proposed_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    acceptedAt: timestamp("accepted_at"),
    acceptedByUserId: text("accepted_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    lockedAt: timestamp("locked_at"),
    lockedByUserId: text("locked_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    // The effective-dating lookup: "which rate was in force for this member at this
    // instant?" Ends in a unique column so two rates sharing an instant cannot swap
    // places between two reads (§4c rule 4).
    index("member_fair_market_rate_memberId_effectiveFrom_idx").on(
      table.memberId,
      table.effectiveFrom,
      table.id,
    ),
    // One rate per member per effective instant. Two rows claiming the same instant make
    // "the rate in force" ambiguous, and an ambiguous rate silently re-prices a claim.
    uniqueIndex("member_fair_market_rate_memberId_effectiveFrom_unq").on(
      table.memberId,
      table.effectiveFrom,
    ),
    check("member_fair_market_rate_rate_ck", sql`fair_market_rate_cents_per_hour >= 0`),
    check("member_fair_market_rate_paid_ck", sql`paid_cash_rate_cents_per_hour >= 0`),
    check("member_fair_market_rate_currency_ck", sql`currency_code ~ '^[A-Z]{3}$'`),
    check(
      "member_fair_market_rate_rationale_ck",
      sql`char_length(rationale_note) BETWEEN 1 AND 1000`,
    ),
    // The lifecycle cannot be half-true: accepted names when and by whom, and locked
    // additionally requires acceptance to have happened first. A rate nobody accepted
    // cannot be locked into the ledger.
    check(
      "member_fair_market_rate_lifecycle_ck",
      sql`(status <> 'proposed' OR (accepted_at IS NULL AND locked_at IS NULL))
          AND (status <> 'accepted' OR (accepted_at IS NOT NULL AND locked_at IS NULL))
          AND (status <> 'locked' OR (accepted_at IS NOT NULL AND locked_at IS NOT NULL))
          AND (accepted_at IS NULL) = (accepted_by_user_id IS NULL)
          AND (locked_at IS NULL) = (locked_by_user_id IS NULL)`,
    ),
  ],
);

/**
 * The claim under audit — one member, one day, one body of work.
 *
 * `extractedMinutes` vs `groundedMinutes` are the two halves of SPEC §4 and collapsing
 * them destroys the audit story (§9.6): `extractedMinutes` is WHAT THE MEMBER SAID, read
 * out of their own words by a model in §8; `groundedMinutes` is WHAT THE ARTIFACTS PROVE.
 *
 * THE LEDGER PRICES `COALESCE(overriddenMinutes, groundedMinutes)` AND NEVER
 * `extractedMinutes`. All three are AI-produced or human-reviewed INPUTS — §9.1's left
 * column — which is why the override quartet lives here and not on the ledger.
 *
 * `verificationStatus` uses the ONE shared enum (§4d) rather than a §9-local copy, and
 * it is the same value that will be mirrored onto `daily_log.effortVerificationStatus`
 * — the column §8 shipped defaulted to `not_run` and written by nothing until now.
 */
export const effortClaim = pgTable(
  "effort_claim",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    memberId: text("member_id")
      .notNull()
      .references(() => projectMember.id, { onDelete: "restrict" }),
    sourceKind: effortClaimSourceKindEnum("source_kind").notNull(),
    dailyLogId: text("daily_log_id").references(() => dailyLog.id, { onDelete: "restrict" }),
    // The day CLAIMED, date-only — distinct from when the claim was filed, exactly as
    // daily_log splits logDate from submittedAt.
    claimedForDate: date("claimed_for_date", { mode: "string" }).notNull(),
    // --- AI-produced inputs (§9.1 left column).
    extractedMinutes: integer("extracted_minutes"),
    extractedCashInCents: bigint("extracted_cash_in_cents", { mode: "bigint" }),
    // Written by `ground-artifacts`, never by a request body. THIS is what pays.
    groundedMinutes: integer("grounded_minutes"),
    groundedCashInCents: bigint("grounded_cash_in_cents", { mode: "bigint" }),
    // A human's correction of an AI-produced INPUT. Not a formula output, so an override
    // column is legitimate here in a way it never is on slice_ledger_entry.
    overriddenMinutes: integer("overridden_minutes"),
    overrideReason: text("override_reason"),
    overriddenByUserId: text("overridden_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    overriddenAt: timestamp("overridden_at"),
    claimSummary: text("claim_summary").notNull(),
    // --- Pipeline state. The shared §4d enum, never a §9-local re-declaration.
    verificationStatus: effortVerificationStatusEnum("verification_status")
      .default("queued")
      .notNull(),
    verdictReachedAt: timestamp("verdict_reached_at"),
    // The rate in force when the verdict landed, pinned so a later raise cannot re-price
    // this claim (§9.6). NULL for a cash-only claim, which needs no rate at all.
    fairMarketRateId: text("fair_market_rate_id").references(() => memberFairMarketRate.id, {
      onDelete: "restrict",
    }),
    // Client-supplied opaque dedup token — the same category as daily_log's, and one of
    // the few client strings this domain accepts. A retried submit on a flaky mobile
    // connection must not file two claims (§14).
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("effort_claim_memberId_idempotencyKey_unq").on(
      table.memberId,
      table.idempotencyKey,
    ),
    // ONE claim per daily log, ever. Re-verification adds a RUN, never a second claim —
    // two claims over one log would pay the same day twice.
    uniqueIndex("effort_claim_dailyLogId_unq")
      .on(table.dailyLogId)
      .where(sql`daily_log_id IS NOT NULL`),
    index("effort_claim_projectId_claimedForDate_idx").on(
      table.projectId,
      table.claimedForDate,
      table.id,
    ),
    index("effort_claim_memberId_status_idx").on(table.memberId, table.verificationStatus),
    check("effort_claim_source_ck", sql`(source_kind = 'daily_log') = (daily_log_id IS NOT NULL)`),
    // A day holds 1440 minutes. A larger number is a model error or a forged payload, and
    // it must fail at the write rather than surface as a plausible slice count.
    check(
      "effort_claim_minutes_ck",
      sql`(extracted_minutes IS NULL OR extracted_minutes BETWEEN 0 AND 1440)
          AND (grounded_minutes IS NULL OR grounded_minutes BETWEEN 0 AND 1440)
          AND (overridden_minutes IS NULL OR overridden_minutes BETWEEN 0 AND 1440)`,
    ),
    check(
      "effort_claim_cash_ck",
      sql`(extracted_cash_in_cents IS NULL OR extracted_cash_in_cents >= 0)
          AND (grounded_cash_in_cents IS NULL OR grounded_cash_in_cents >= 0)`,
    ),
    // An override names its reason, its author and its instant, or it is not an override
    // — it is an unattributed edit to a number someone is paid on.
    check(
      "effort_claim_override_ck",
      sql`(overridden_minutes IS NULL) = (override_reason IS NULL)
          AND (overridden_minutes IS NULL) = (overridden_by_user_id IS NULL)
          AND (overridden_minutes IS NULL) = (overridden_at IS NULL)`,
    ),
    check("effort_claim_summary_ck", sql`char_length(claim_summary) BETWEEN 1 AND 1000`),
    // A verdict instant exists exactly when the status is terminal. `not_run` is absent
    // deliberately: a row in this table has, by definition, been submitted.
    check(
      "effort_claim_verdict_ck",
      sql`(verdict_reached_at IS NOT NULL)
          = (verification_status IN ('verified', 'flagged_for_review', 'unverified'))`,
    ),
  ],
);

/**
 * One pass of the pipeline over a claim. `attemptNumber` is 1, then 2+ for
 * re-verification (§9.6).
 *
 * A run is never edited into a different outcome — a re-check is a NEW run, so the
 * original verdict and every step that produced it stay readable forever. That is what
 * makes `GET …/effort-claims/:claimId` (claim + all runs + steps in stepOrder) an audit
 * record rather than a status page.
 */
export const claimVerificationRun = pgTable(
  "claim_verification_run",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    claimId: text("claim_id")
      .notNull()
      .references(() => effortClaim.id, { onDelete: "restrict" }),
    attemptNumber: integer("attempt_number").notNull(),
    // NULL for the system-triggered first pass; set for `POST …/reverify` and for a
    // dispute resolved as `re_verified`.
    triggeredByUserId: text("triggered_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    triggerReason: text("trigger_reason"),
    // §9.12 option (a): a dispute resolution narrows a WINDOW and the server re-derives
    // minutes from artifact overlap inside it. These two columns are that window — and
    // they are the reason no `consensusAdjustedMinutes` column exists anywhere.
    scopedWindowStartsAt: timestamp("scoped_window_starts_at"),
    scopedWindowEndsAt: timestamp("scoped_window_ends_at"),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
    // The pure verdict function's output (src/modules/rnd/verdict.ts), constrained to the three
    // TERMINAL values — `incomplete` describes a run in flight and is never persisted.
    verdict: effortVerificationStatusEnum("verdict"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("claim_verification_run_claimId_attempt_unq").on(
      table.claimId,
      table.attemptNumber,
    ),
    check("claim_verification_run_attempt_ck", sql`attempt_number >= 1`),
    check(
      "claim_verification_run_verdict_ck",
      sql`verdict IS NULL OR verdict IN ('verified', 'flagged_for_review', 'unverified')`,
    ),
    check("claim_verification_run_completed_ck", sql`(completed_at IS NULL) = (verdict IS NULL)`),
    check(
      "claim_verification_run_window_ck",
      sql`(scoped_window_starts_at IS NULL) = (scoped_window_ends_at IS NULL)
          AND (scoped_window_ends_at IS NULL OR scoped_window_ends_at > scoped_window_starts_at)`,
    ),
  ],
);

/**
 * One of the four ordered steps of a run, with its provenance and its override quartet.
 *
 * EVERYTHING HERE IS §9.1's LEFT COLUMN: an AI judgement, reviewable and overridable by a
 * human. `PATCH …/steps/:stepId/override` is the ONLY hand-edit in the entire domain, and
 * it edits a JUDGEMENT, never a number — the number is recomputed by the formula
 * afterwards.
 */
export const verificationStep = pgTable(
  "verification_step",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    runId: text("run_id")
      .notNull()
      .references(() => claimVerificationRun.id, { onDelete: "restrict" }),
    stepOrder: integer("step_order").notNull(),
    stepKind: verificationStepKindEnum("step_kind").notNull(),
    status: verificationStepStatusEnum("status").default("pending").notNull(),
    findingSummary: text("finding_summary"),
    // Integer basis points like every other ratio in this domain (§4b). NULL when the
    // step produced no score — never 0, which reads as "certainly worthless".
    scoreBps: integer("score_bps"),
    // --- Provenance. Required exactly when a model produced the finding (§9.1).
    modelName: text("model_name"),
    modelVersion: text("model_version"),
    promptVersion: text("prompt_version"),
    confidenceBps: integer("confidence_bps"),
    // --- The override quartet.
    overriddenStatus: verificationStepStatusEnum("overridden_status"),
    reviewedByUserId: text("reviewed_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    overrideReason: text("override_reason"),
    reviewedAt: timestamp("reviewed_at"),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("verification_step_runId_stepKind_unq").on(table.runId, table.stepKind),
    uniqueIndex("verification_step_runId_stepOrder_unq").on(table.runId, table.stepOrder),
    check("verification_step_order_ck", sql`step_order BETWEEN 1 AND 4`),
    check(
      "verification_step_score_ck",
      sql`(score_bps IS NULL OR score_bps BETWEEN 0 AND 10000)
          AND (confidence_bps IS NULL OR confidence_bps BETWEEN 0 AND 10000)`,
    ),
    // An override with no author or no reason is an anonymous edit to the thing that
    // decides whether equity is minted. All four columns move together or none do.
    check(
      "verification_step_override_ck",
      sql`(overridden_status IS NULL) = (reviewed_by_user_id IS NULL)
          AND (overridden_status IS NULL) = (override_reason IS NULL)
          AND (overridden_status IS NULL) = (reviewed_at IS NULL)
          AND (overridden_status IS NULL OR overridden_status <> 'pending')`,
    ),
    check(
      "verification_step_finding_ck",
      sql`finding_summary IS NULL OR char_length(finding_summary) <= 2000`,
    ),
  ],
);

/**
 * A deterministic digital receipt with identity — the thing SPEC §4 step 2 grounds a
 * claim against. Replaces the mock's `evidenceLabels: string[]`, which could not be
 * deduplicated, dated, or proven.
 *
 * REVOCATION NULLS `rawPayloadJson` AND NOTHING ELSE (§9.10). `payloadSha256`,
 * `externalId`, `label`, `artifactOccurredAt` and `signatureStatus` are RETAINED, so the
 * claim stays provable — "commit abc123 was signed, valid, at 14:02, hashing to 9f2e…" —
 * without the platform holding a copy of anyone's source code. `evidenceRetained` records
 * which state a row is in, because a dispute against a purged claim can resolve `upheld`
 * or `voided` only; `re_verify` returns 409 EVIDENCE_PURGED.
 */
export const artifactEvidence = pgTable(
  "artifact_evidence",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    claimId: text("claim_id")
      .notNull()
      .references(() => effortClaim.id, { onDelete: "restrict" }),
    provider: artifactProviderEnum("provider").notNull(),
    // The provider's own id — a commit sha, a file key, an issue key. The dedup axis.
    externalId: text("external_id").notNull(),
    label: text("label").notNull(),
    externalUrl: text("external_url"),
    // 64 lowercase hex characters, always compared full length (§4c).
    payloadSha256: text("payload_sha256").notNull(),
    // NULLED on consent revocation. Everything else on this row survives.
    rawPayloadJson: text("raw_payload_json"),
    evidenceRetained: boolean("evidence_retained").default(true).notNull(),
    signatureStatus: artifactSignatureStatusEnum("signature_status").default("unknown").notNull(),
    // When the WORK happened, per the provider — not when we fetched it. Temporal
    // analysis overlaps these against the claimed window.
    artifactOccurredAt: timestamp("artifact_occurred_at").notNull(),
    // False for an artifact that was found but must not fund slices — already counted
    // against another claim, or authored by someone else.
    countsTowardSlices: boolean("counts_toward_slices").default(true).notNull(),
    consentGrantId: text("consent_grant_id").references(() => integrationConsentGrant.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    // ONE COMMIT MUST NOT FUND TWO MEMBERS' CLAIMS (§9.6). Partial on
    // counts_toward_slices so an artifact deliberately marked as non-funding can still be
    // recorded against a second claim for context.
    uniqueIndex("artifact_evidence_project_claim_unq")
      .on(table.projectId, table.provider, table.externalId)
      .where(sql`counts_toward_slices = true`),
    index("artifact_evidence_claimId_idx").on(table.claimId, table.id),
    index("artifact_evidence_occurredAt_idx").on(table.projectId, table.artifactOccurredAt),
    check("artifact_evidence_sha_ck", sql`payload_sha256 ~ '^[0-9a-f]{64}$'`),
    check("artifact_evidence_label_ck", sql`char_length(label) BETWEEN 1 AND 500`),
    check(
      "artifact_evidence_url_ck",
      sql`external_url IS NULL
          OR (char_length(external_url) <= 2048 AND external_url LIKE 'https://%')`,
    ),
    // Purged evidence has no payload; retained evidence may still legitimately have none
    // (a provider that returns nothing worth storing), so this is one-directional.
    check(
      "artifact_evidence_retention_ck",
      sql`evidence_retained = true OR raw_payload_json IS NULL`,
    ),
  ],
);

/**
 * Consent is a TRIPLE — (project, member, provider) — never a pair (§9.10).
 *
 * A member on three projects who connects GitHub creates three independently revocable
 * grants with independently narrowed `allowedResourceIds`. A grant for the solar project
 * must never be readable by the drone project's pipeline, and the unique index below is
 * what makes that structural rather than a service-layer promise.
 *
 * TOKENS ARE ENVELOPE-ENCRYPTED AT REST. This deliberately diverges from Better Auth's
 * `account` table, which stores `accessToken` in plaintext — that is Better Auth's table
 * and its decision; these are third-party org-scoped tokens whose blast radius is a
 * customer's entire source repository. Default to the narrowest scope the provider
 * supports: a repo-scoped installation token, never a user PAT.
 */
export const integrationConsentGrant = pgTable(
  "integration_consent_grant",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    memberId: text("member_id")
      .notNull()
      .references(() => projectMember.id, { onDelete: "restrict" }),
    provider: integrationProviderEnum("provider").notNull(),
    status: integrationGrantStatusEnum("status").default("pending").notNull(),
    // Scope narrowing is the difference between "Qatoto reads your work" and "Qatoto
    // reads your GitHub". Empty means the member consented to nothing yet.
    allowedResourceIds: text("allowed_resource_ids").array().notNull().default([]),
    // Ciphertext only. The plaintext never touches a column, a log, or a response.
    encryptedAccessToken: text("encrypted_access_token"),
    encryptedRefreshToken: text("encrypted_refresh_token"),
    // Which key encrypted it, so rotation is a re-encrypt rather than a data loss.
    tokenKeyVersion: text("token_key_version"),
    externalAccountLabel: text("external_account_label"),
    grantedAt: timestamp("granted_at"),
    expiresAt: timestamp("expires_at"),
    revokedAt: timestamp("revoked_at"),
    revokedByUserId: text("revoked_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    // THE TRIPLE. One grant per (project, member, provider), enforced by Postgres.
    uniqueIndex("integration_consent_grant_triple_unq").on(
      table.projectId,
      table.memberId,
      table.provider,
    ),
    index("integration_consent_grant_memberId_idx").on(table.memberId, table.status),
    // An active grant has a token and an instant; a revoked one has NEITHER a token nor
    // a missing revocation record. Revocation that leaves ciphertext behind is not
    // revocation.
    check(
      "integration_consent_grant_lifecycle_ck",
      sql`(status <> 'active' OR (encrypted_access_token IS NOT NULL AND granted_at IS NOT NULL))
          AND (status <> 'revoked' OR (revoked_at IS NOT NULL AND encrypted_access_token IS NULL))
          AND (status <> 'pending' OR encrypted_access_token IS NULL)
          AND (encrypted_access_token IS NULL) = (token_key_version IS NULL)
          AND (revoked_at IS NULL) = (revoked_by_user_id IS NULL)`,
    ),
    check("integration_consent_grant_resources_ck", sql`cardinality(allowed_resource_ids) <= 100`),
  ],
);

/**
 * SPEC §4's hardware edge case: git is deterministic, sanding a 3D-printed chassis is
 * not. For non-digital work the member uploads a receipt — a photo, a CAD file, a
 * material receipt — and the server MEASURES it.
 *
 * `contentSha256` and `perceptualHash` do two different jobs. The first stops the exact
 * same bytes funding two claims; the second catches a re-crop, a re-compress or a
 * screenshot of the same photograph, which changes every byte and none of the pixels.
 *
 * `deviceFingerprintHash` IS A SALTED HASH, NEVER THE RAW EXIF SERIAL (§9.10) — a camera
 * body serial is biometric-adjacent in some jurisdictions, and it identifies a person
 * across every photo they have ever taken.
 */
export const physicalWorkReceipt = pgTable(
  "physical_work_receipt",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    memberId: text("member_id")
      .notNull()
      .references(() => projectMember.id, { onDelete: "restrict" }),
    // NULL until a claim cites it: a member uploads receipts first, then files one claim
    // naming several.
    claimId: text("claim_id").references(() => effortClaim.id, { onDelete: "restrict" }),
    receiptKind: physicalReceiptKindEnum("receipt_kind").notNull(),
    contentSha256: text("content_sha256").notNull(),
    perceptualHash: text("perceptual_hash").notNull(),
    storedImageUrl: text("stored_image_url"),
    storedImagePublicId: text("stored_image_public_id"),
    // Server-MEASURED, every one of them. A client-claimed size or dimension is a number
    // the client made up (§13).
    sizeBytes: integer("size_bytes").notNull(),
    widthPixels: integer("width_pixels"),
    heightPixels: integer("height_pixels"),
    // From EXIF when present. NULL is common and honest — most uploads are stripped.
    capturedAt: timestamp("captured_at"),
    deviceFingerprintHash: text("device_fingerprint_hash"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    // THE SAME BYTES CANNOT FUND TWO RECEIPTS (§9.6).
    uniqueIndex("physical_work_receipt_content_unq").on(table.projectId, table.contentSha256),
    uniqueIndex("physical_work_receipt_memberId_idempotencyKey_unq").on(
      table.memberId,
      table.idempotencyKey,
    ),
    index("physical_work_receipt_claimId_idx").on(table.claimId, table.id),
    // Near-duplicate detection scans this; it is not unique, because a legitimate second
    // photo of the same workbench SHOULD be flagged for a human rather than rejected.
    index("physical_work_receipt_phash_idx").on(table.projectId, table.perceptualHash),
    check("physical_work_receipt_sha_ck", sql`content_sha256 ~ '^[0-9a-f]{64}$'`),
    check("physical_work_receipt_size_ck", sql`size_bytes > 0`),
    check(
      "physical_work_receipt_dimensions_ck",
      sql`(width_pixels IS NULL OR width_pixels > 0)
          AND (height_pixels IS NULL OR height_pixels > 0)`,
    ),
  ],
);

/** One forensic check against one receipt: EXIF, device fingerprint, reverse image search. */
export const receiptForensicsCheck = pgTable(
  "receipt_forensics_check",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    receiptId: text("receipt_id")
      .notNull()
      .references(() => physicalWorkReceipt.id, { onDelete: "restrict" }),
    checkKind: receiptForensicsCheckKindEnum("check_kind").notNull(),
    result: receiptForensicsResultEnum("result").notNull(),
    findingSummary: text("finding_summary"),
    modelName: text("model_name"),
    promptVersion: text("prompt_version"),
    confidenceBps: integer("confidence_bps"),
    checkedAt: timestamp("checked_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("receipt_forensics_check_receiptId_kind_unq").on(table.receiptId, table.checkKind),
    check(
      "receipt_forensics_check_confidence_ck",
      sql`confidence_bps IS NULL OR confidence_bps BETWEEN 0 AND 10000`,
    ),
    check(
      "receipt_forensics_check_finding_ck",
      sql`finding_summary IS NULL OR char_length(finding_summary) <= 2000`,
    ),
  ],
);

/**
 * The 24-hour transparency window (§9.8) — and the reason NO SLICES EXIST UNTIL IT LOCKS.
 *
 * `finalize-verdict` creates this row, NOT the ledger. `proposedSlices` is frozen here,
 * OUTSIDE `totalSlices`, so a proposal under dispute can be reported honestly as "frozen
 * in escrow" rather than silently counted or silently dropped.
 *
 * A `flagged_for_review` verdict STILL OPENS A WINDOW, at zero slices. The solar mock's
 * "960 slices withheld" entry is exactly this case: if flagged claims vanished silently,
 * members would lose contributions with no recourse.
 *
 * `windowClosesAt` is an absolute instant computed in Postgres, in UTC. The server never
 * sends a duration — "Locks in 9h 14m" is client arithmetic against this ISO value.
 */
export const sliceAllocationProposal = pgTable(
  "slice_allocation_proposal",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    claimId: text("claim_id")
      .notNull()
      .references(() => effortClaim.id, { onDelete: "restrict" }),
    memberId: text("member_id")
      .notNull()
      .references(() => projectMember.id, { onDelete: "restrict" }),
    runId: text("run_id")
      .notNull()
      .references(() => claimVerificationRun.id, { onDelete: "restrict" }),
    // The terminal verdict that produced this proposal. Constrained to the three
    // persisted values, like claim_verification_run.verdict.
    verdict: effortVerificationStatusEnum("verdict").notNull(),
    // FORMULA-PRODUCED. Frozen at open, never recomputed in place — a re-derivation
    // creates a new run and settles at the new number.
    //
    // TWO NUMERATORS, NOT ONE, because a single day genuinely produces both kinds: §8's
    // extraction emits `time_spent` and `cash_spent` as separate claims, and §9.2 prices
    // them with different premiums (2× and 4×). They are summed for display but rounded
    // SEPARATELY at settlement — §9.3 rounds once PER LEDGER ENTRY, and the sum of two
    // rounded values is not the rounding of their sum.
    proposedTimeSliceNumerator: bigint("proposed_time_slice_numerator", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    proposedCashSliceNumerator: bigint("proposed_cash_slice_numerator", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    proposedSlices: integer("proposed_slices").notNull(),
    /** The sum of the two above, retained for the audit payload and the transparency read. */
    proposedSliceNumerator: bigint("proposed_slice_numerator", { mode: "bigint" }).notNull(),
    fairMarketRateId: text("fair_market_rate_id").references(() => memberFairMarketRate.id, {
      onDelete: "restrict",
    }),
    status: sliceAllocationProposalStatusEnum("status").default("open").notNull(),
    windowOpensAt: timestamp("window_opens_at").defaultNow().notNull(),
    // PRECISION 3 IS LOAD-BEARING, for the same reason daily_log.submitted_at carries it
    // (see src/modules/rnd/daily-log-cursor.ts). This column is written as `now() + interval`, so
    // Postgres would otherwise store MICROSECONDS while a JS Date — and therefore the
    // keyset cursor over this column — carries only milliseconds. Two proposals 0.5 ms
    // apart would read as the same instant, and the cursor predicate would step over both.
    // Truncating to milliseconds moves a 24-hour dispute window by under a millisecond.
    windowClosesAt: timestamp("window_closes_at", { precision: 3 }).notNull(),
    // Reported SEPARATELY from totalSlices so the UI can show "frozen in escrow"
    // honestly instead of implying the slices are either awarded or gone.
    escrowedSlices: integer("escrowed_slices").default(0).notNull(),
    activeDisputeId: text("active_dispute_id").references((): AnyPgColumn => dispute.id, {
      onDelete: "set null",
    }),
    lockedAt: timestamp("locked_at"),
    consensusReachedAt: timestamp("consensus_reached_at"),
    settledLedgerEntryId: text("settled_ledger_entry_id").references(
      (): AnyPgColumn => sliceLedgerEntry.id,
      { onDelete: "restrict" },
    ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("slice_allocation_proposal_claimId_unq").on(table.claimId),
    // The sweep's index: expired open windows, oldest first. Partial, because the sweep
    // runs every 60 seconds forever and must never scan settled history.
    index("slice_allocation_proposal_sweep_idx")
      .on(table.windowClosesAt, table.id)
      .where(sql`status = 'open'`),
    index("slice_allocation_proposal_projectId_status_idx").on(
      table.projectId,
      table.status,
      table.id,
    ),
    // The transparency ledger's index — `listAllocationProposals` orders
    // (windowClosesAt DESC, id DESC) within a project. Declared ASC because Postgres
    // scans a btree backwards to satisfy an all-DESC ORDER BY, exactly as
    // effort_claim_projectId_claimedForDate_idx does for listClaims.
    //
    // Neither index above can serve that read: the sweep index is partial on
    // `status = 'open'` and does not lead with project_id, and _projectId_status_idx
    // leads with status rather than the ordering column. Without this the read sorted
    // every proposal in the project on EVERY page, first page included.
    index("slice_allocation_proposal_projectId_windowClosesAt_idx").on(
      table.projectId,
      table.windowClosesAt,
      table.id,
    ),
    // --- The discriminated union, as CHECK constraints (§9.6). This is what makes the
    // --- status a real state machine rather than four optional columns.
    check(
      "proposal_locked_shape",
      sql`(status <> 'locked') OR (locked_at IS NOT NULL AND settled_ledger_entry_id IS NOT NULL)`,
    ),
    check(
      "proposal_consensus_shape",
      sql`(status <> 'consensus_reached')
          OR (consensus_reached_at IS NOT NULL AND settled_ledger_entry_id IS NOT NULL)`,
    ),
    // DELIBERATE DEVIATION FROM §9.6's LITERAL TEXT, which reads `escrowed_slices > 0`.
    // That would make a flagged-at-zero proposal impossible to dispute — and §9.8 says
    // any active member may dispute, precisely so a member whose claim was flagged to
    // zero has recourse. Escrow must therefore equal what was proposed, including when
    // that is zero. Strictly stronger than the drafted rule in every other case.
    check(
      "proposal_disputed_shape",
      sql`(status <> 'disputed')
          OR (active_dispute_id IS NOT NULL AND escrowed_slices = proposed_slices)`,
    ),
    check("proposal_escrow_zero", sql`(status = 'disputed') OR (escrowed_slices = 0)`),
    check("proposal_window_ck", sql`window_closes_at > window_opens_at`),
    check(
      "proposal_slices_ck",
      sql`proposed_slices >= 0 AND escrowed_slices >= 0 AND proposed_slice_numerator >= 0
          AND proposed_time_slice_numerator >= 0 AND proposed_cash_slice_numerator >= 0
          AND proposed_slice_numerator
              = proposed_time_slice_numerator + proposed_cash_slice_numerator`,
    ),
    check("proposal_verdict_ck", sql`verdict IN ('verified', 'flagged_for_review', 'unverified')`),
  ],
);

/**
 * A dispute against a proposal — the failsafe that is social, not algorithmic (SPEC §4).
 *
 * `quorumMemberCount` is FROZEN at raise time. Computing it live would let the roster
 * changing mid-dispute move the majority threshold under a vote already in progress.
 *
 * WITHDRAWAL RESUMES THE ORIGINAL CLOCK (§9.8) — the proposal's `windowClosesAt` is never
 * rewritten. Without that rule, serial withdraw-and-re-dispute holds slices hostage
 * forever.
 */
export const dispute = pgTable(
  "dispute",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    proposalId: text("proposal_id")
      .notNull()
      .references((): AnyPgColumn => sliceAllocationProposal.id, { onDelete: "restrict" }),
    // Any ACTIVE member, including the claim's own subject. Not observers.
    raisedByMemberId: text("raised_by_member_id")
      .notNull()
      .references(() => projectMember.id, { onDelete: "restrict" }),
    disputeNote: text("dispute_note").notNull(),
    status: disputeStatusEnum("status").default("open").notNull(),
    // Frozen at raise time; the majority threshold is derived from THIS number.
    quorumMemberCount: integer("quorum_member_count").notNull(),
    resolution: disputeResolutionEnum("resolution"),
    resolutionNote: text("resolution_note"),
    resolvedByUserId: text("resolved_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    resolvedAt: timestamp("resolved_at"),
    // §9.12 option (a): the narrowed window a `re_verified` resolution supplies. The
    // server re-derives minutes from artifact overlap inside it; the resolver never
    // states a number.
    scopedWindowStartsAt: timestamp("scoped_window_starts_at"),
    scopedWindowEndsAt: timestamp("scoped_window_ends_at"),
    reverificationRunId: text("reverification_run_id").references(() => claimVerificationRun.id, {
      onDelete: "restrict",
    }),
    withdrawnAt: timestamp("withdrawn_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    // ONE live dispute per proposal. A second concurrent dispute is 409 ALREADY_DISPUTED,
    // and this index is what makes that true under a race rather than under a check.
    uniqueIndex("dispute_proposalId_open_unq")
      .on(table.proposalId)
      .where(sql`status = 'open'`),
    index("dispute_projectId_status_idx").on(table.projectId, table.status, table.id),
    check("dispute_note_ck", sql`char_length(dispute_note) BETWEEN 1 AND 2000`),
    check("dispute_quorum_ck", sql`quorum_member_count >= 1`),
    check(
      "dispute_resolution_ck",
      sql`(status = 'consensus_reached')
          = (resolution IS NOT NULL AND resolved_at IS NOT NULL AND resolved_by_user_id IS NOT NULL)`,
    ),
    check("dispute_withdrawn_ck", sql`(status = 'withdrawn') = (withdrawn_at IS NOT NULL)`),
    check(
      "dispute_window_ck",
      sql`(scoped_window_starts_at IS NULL) = (scoped_window_ends_at IS NULL)
          AND (scoped_window_ends_at IS NULL OR scoped_window_ends_at > scoped_window_starts_at)
          AND (scoped_window_starts_at IS NULL OR resolution = 're_verified')`,
    ),
  ],
);

/**
 * One member's vote on a dispute. **This table has no frontend counterpart at all**
 * (§9.6) — the consensus mechanism SPEC §4 describes exists only here.
 */
export const disputeVote = pgTable(
  "dispute_vote",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    disputeId: text("dispute_id")
      .notNull()
      .references(() => dispute.id, { onDelete: "restrict" }),
    voterMemberId: text("voter_member_id")
      .notNull()
      .references(() => projectMember.id, { onDelete: "restrict" }),
    position: disputeVotePositionEnum("position").notNull(),
    note: text("note"),
    castAt: timestamp("cast_at").defaultNow().notNull(),
  },
  (table) => [
    // ONE vote per voter per dispute. Changing a vote is not supported: a majority that
    // can be un-reached after it resolves is not a consensus.
    uniqueIndex("dispute_vote_disputeId_voterMemberId_unq").on(
      table.disputeId,
      table.voterMemberId,
    ),
    check("dispute_vote_note_ck", sql`note IS NULL OR char_length(note) <= 2000`),
  ],
);

/**
 * THE LEDGER. Append-only, gapless per project, and written by exactly one service
 * (`slice-ledger.service.ts`) which only ever writes `computeSlices` output.
 *
 * THERE ARE NO OVERRIDE COLUMNS ON THIS TABLE AND THERE NEVER WILL BE (§9.1). A
 * correction is a `reversal` entry naming the entry it reverses; there is no UPDATE path,
 * and the migration's BEFORE UPDATE OR DELETE trigger enforces that against a DBA too.
 *
 * `sliceNumerator` is stored ALONGSIDE the rounded `slicesAwarded` so an auditor can see
 * exactly where the half-slice went (§9.3 rule 2) — rounding you cannot inspect is
 * indistinguishable from a bug.
 *
 * ORDER BY sequenceNumber, NEVER createdAt: two rows share a millisecond and replica
 * clocks skew (§9.4).
 */
export const sliceLedgerEntry = pgTable(
  "slice_ledger_entry",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    // Gapless per project, allocated under the project_chain_head lock.
    sequenceNumber: integer("sequence_number").notNull(),
    memberId: text("member_id")
      .notNull()
      .references(() => projectMember.id, { onDelete: "restrict" }),
    entryKind: sliceLedgerEntryKindEnum("entry_kind").default("award").notNull(),
    contributionKind: sliceContributionKindEnum("contribution_kind").notNull(),
    claimId: text("claim_id").references(() => effortClaim.id, { onDelete: "restrict" }),
    proposalId: text("proposal_id").references((): AnyPgColumn => sliceAllocationProposal.id, {
      onDelete: "restrict",
    }),
    // --- The numbers. Formula-produced, both of them.
    sliceNumerator: bigint("slice_numerator", { mode: "bigint" }).notNull(),
    slicesAwarded: integer("slices_awarded").notNull(),
    // --- The inputs that produced them, denormalized so an auditor need not re-resolve
    // --- effective dating years later.
    fairMarketRateId: text("fair_market_rate_id").references(() => memberFairMarketRate.id, {
      onDelete: "restrict",
    }),
    unpaidRateCentsPerHour: bigint("unpaid_rate_cents_per_hour", { mode: "bigint" }),
    effortMinutes: integer("effort_minutes"),
    cashInCents: bigint("cash_in_cents", { mode: "bigint" }),
    reversalOfEntryId: text("reversal_of_entry_id").references(
      (): AnyPgColumn => sliceLedgerEntry.id,
      { onDelete: "restrict" },
    ),
    // The instant the CONTRIBUTION is credited to, not the instant the row was written.
    occurredAt: timestamp("occurred_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("slice_ledger_entry_projectId_sequence_unq").on(
      table.projectId,
      table.sequenceNumber,
    ),
    index("slice_ledger_entry_memberId_idx").on(table.memberId, table.sequenceNumber),
    index("slice_ledger_entry_projectId_occurredAt_idx").on(
      table.projectId,
      table.occurredAt,
      table.id,
    ),
    // One entry per settled proposal PER CONTRIBUTION KIND. Re-running the sweep must be
    // a no-op (§17 step 6), and a day that was both worked and paid for out of pocket
    // settles as two entries priced at two different premiums (§9.2).
    uniqueIndex("slice_ledger_entry_proposalId_kind_unq")
      .on(table.proposalId, table.contributionKind)
      .where(sql`proposal_id IS NOT NULL`),
    check("slice_ledger_entry_sequence_ck", sql`sequence_number >= 1`),
    check(
      "slice_ledger_entry_reversal_ck",
      sql`(entry_kind = 'reversal') = (reversal_of_entry_id IS NOT NULL)`,
    ),
    // An award never goes negative and a reversal never goes positive. Without this a
    // sign error in the formula reads as a legitimate correction.
    check(
      "slice_ledger_entry_sign_ck",
      sql`(entry_kind = 'award' AND slices_awarded >= 0 AND slice_numerator >= 0)
          OR (entry_kind = 'reversal' AND slices_awarded <= 0 AND slice_numerator <= 0)`,
    ),
    // The contribution kind and its inputs move together: a time entry has minutes and a
    // rate, a cash entry has cents and neither.
    check(
      "slice_ledger_entry_inputs_ck",
      sql`(contribution_kind = 'time')
            = (effort_minutes IS NOT NULL AND unpaid_rate_cents_per_hour IS NOT NULL)
          AND (contribution_kind = 'cash') = (cash_in_cents IS NOT NULL)`,
    ),
  ],
);

/**
 * The hash chain's serialization point — one row per project, and the lock every writer
 * takes (§9.9).
 *
 * `SELECT … FROM project_chain_head WHERE project_id = $1 FOR UPDATE` inside the
 * transaction is what guarantees ONE WRITER PER PROJECT, always. Every ledger write, rate
 * lock, dispute transition, consent change and bake appends its audit entry IN THE SAME
 * TRANSACTION — an audit trail that can lag the ledger is worse than none.
 *
 * The ledger's sequence lives here too, so one lock serializes both counters rather than
 * two locks taken in an order someone will eventually get backwards.
 *
 * THE ANCHOR COLUMNS ARE THE HONEST PART. Without daily external anchoring of the head
 * hash to append-only storage under a separate credential, anyone with database write
 * access can recompute the whole chain from any point forward and every verification
 * still passes. A hash chain is tamper-evident AGAINST OUTSIDERS ONLY.
 */
export const projectChainHead = pgTable(
  "project_chain_head",
  {
    projectId: text("project_id")
      .primaryKey()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    lastAuditSequenceNumber: integer("last_audit_sequence_number").default(0).notNull(),
    lastLedgerSequenceNumber: integer("last_ledger_sequence_number").default(0).notNull(),
    // --- §7's escrow journal shares THIS row, and therefore THIS lock.
    //
    // §7 specifies "SELECT … FOR UPDATE on the project's last entry" for allocating an
    // escrow sequence number. That would be a SECOND serialization point, and the note
    // above says why that is wrong: a writer appending an escrow entry AND an audit entry
    // in one transaction — which every §7 money event does — would take two locks, and
    // two locks taken in an order someone eventually gets backwards is a deadlock waiting
    // for load. Three counters, one row, one lock.
    lastEscrowSequenceNumber: integer("last_escrow_sequence_number").default(0).notNull(),
    escrowHeadEntryHash: text("escrow_head_entry_hash"),
    escrowHeadEntryId: text("escrow_head_entry_id"),
    // --- §7A's compensation statements share THIS row, and therefore THIS lock, for the
    // --- same reason the escrow journal does: one writer per project, always.
    //
    // TWO COUNTERS, BECAUSE THERE ARE TWO MOMENTS. `sequenceNumber` is allocated when a
    // period OPENS, so it runs in calendar order and is gapless. The statement HASH does
    // not exist until the period is FINALIZED, and a period may be finalized late while
    // the next one is already accruing — so the hash chain links finalized periods in
    // finalize order and never has a hole for a month nobody has signed yet. Folding the
    // two into one counter would mean either a gap in the calendar sequence or a chain
    // that cannot be walked.
    lastCompensationSequenceNumber: integer("last_compensation_sequence_number")
      .default(0)
      .notNull(),
    compensationHeadStatementHash: text("compensation_head_statement_hash"),
    compensationHeadPeriodId: text("compensation_head_period_id"),
    headEntryHash: text("head_entry_hash"),
    headEntryId: text("head_entry_id"),
    lastAnchoredAt: timestamp("last_anchored_at"),
    lastAnchoredHash: text("last_anchored_hash"),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  // No `table` parameter: every constraint below is expressed in raw SQL against column
  // names, so binding one would be an unused parameter.
  () => [
    check(
      "project_chain_head_sequence_ck",
      sql`last_audit_sequence_number >= 0 AND last_ledger_sequence_number >= 0
          AND last_escrow_sequence_number >= 0
          AND last_compensation_sequence_number >= 0`,
    ),
    check(
      "project_chain_head_hash_ck",
      sql`(head_entry_hash IS NULL OR head_entry_hash ~ '^[0-9a-f]{64}$')
          AND (last_anchored_hash IS NULL OR last_anchored_hash ~ '^[0-9a-f]{64}$')
          AND (escrow_head_entry_hash IS NULL OR escrow_head_entry_hash ~ '^[0-9a-f]{64}$')
          AND (last_audit_sequence_number = 0) = (head_entry_hash IS NULL)
          AND (last_escrow_sequence_number = 0) = (escrow_head_entry_hash IS NULL)`,
    ),
    // Deliberately NOT paired with last_compensation_sequence_number, unlike the two
    // checks above. A project can have opened five periods and finalized none: the
    // sequence counter is at 5 while the statement head is still NULL, which is the
    // normal state of a young project and not a broken chain.
    check(
      "project_chain_head_compensation_hash_ck",
      sql`(compensation_head_statement_hash IS NULL
           OR compensation_head_statement_hash ~ '^[0-9a-f]{64}$')
          AND (compensation_head_statement_hash IS NULL) = (compensation_head_period_id IS NULL)`,
    ),
  ],
);

/**
 * The tamper-evident audit chain (§9.9). Append-only, hashed in a FIXED DECLARED ORDER
 * with RFC 8785 canonicalization (src/lib/canonical-hash.ts).
 *
 * WHAT IS HASHED, in order: projectId, sequenceNumber, eventKind, actorUserId,
 * actorNameSnapshot, actorRoleSnapshot, actionLabel, targetLabel, detailNote, payloadJson,
 * occurredAt, previousEntryHash, hashAlgorithmVersion.
 *
 * WHAT IS DELIBERATELY EXCLUDED: `id` (a random UUID makes the chain unreproducible from
 * semantics), `createdAt` (write time is not event time), and every FK back-reference
 * (circular).
 *
 * `detailNote` IS `''`, NEVER NULL. `null` and `""` are different documents and hash to
 * different bytes; permitting both makes the same event hash two ways.
 *
 * `payloadJson` is `text`, not `jsonb`, and that is load-bearing: jsonb reorders keys and
 * normalizes numbers on write, so the bytes read back would not be the bytes hashed.
 */
export const projectAuditEntry = pgTable(
  "project_audit_entry",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    sequenceNumber: integer("sequence_number").notNull(),
    eventKind: projectAuditEventKindEnum("event_kind").notNull(),
    // NULL for a system actor (the expiry sweep, a nightly recompute).
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "restrict" }),
    // PSEUDONYMOUS AT WRITE TIME (§9.10). This value is inside the hash and can never be
    // edited afterwards, so it must not be a legal name — a user row anonymizes later,
    // and a chain covering their real name would have to break for that to happen.
    actorNameSnapshot: text("actor_name_snapshot").notNull(),
    actorRoleSnapshot: text("actor_role_snapshot").notNull(),
    actionLabel: text("action_label").notNull(),
    targetLabel: text("target_label").notNull(),
    detailNote: text("detail_note").default("").notNull(),
    payloadJson: text("payload_json").notNull(),
    occurredAt: timestamp("occurred_at").notNull(),
    // NULL only for sequence 1 — the genesis entry has no predecessor.
    previousEntryHash: text("previous_entry_hash"),
    entryHash: text("entry_hash").notNull(),
    hashAlgorithmVersion: text("hash_algorithm_version").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("project_audit_entry_projectId_sequence_unq").on(
      table.projectId,
      table.sequenceNumber,
    ),
    index("project_audit_entry_projectId_occurredAt_idx").on(
      table.projectId,
      table.occurredAt,
      table.id,
    ),
    check("project_audit_entry_sequence_ck", sql`sequence_number >= 1`),
    // Full length, lowercase hex, always. The 6-character form the UI shows is a
    // RENDERING: at 24 bits collisions hit 50% around 4,800 entries, so it must never be
    // used as a key, a cache key, or an equality test (§4c).
    check("project_audit_entry_hash_ck", sql`entry_hash ~ '^[0-9a-f]{64}$'`),
    check(
      "project_audit_entry_link_ck",
      sql`(sequence_number = 1) = (previous_entry_hash IS NULL)
          AND (previous_entry_hash IS NULL OR previous_entry_hash ~ '^[0-9a-f]{64}$')`,
    ),
    check(
      "project_audit_entry_labels_ck",
      sql`char_length(action_label) BETWEEN 1 AND 200
          AND char_length(target_label) BETWEEN 1 AND 200
          AND char_length(detail_note) <= 2000`,
    ),
  ],
);

/**
 * The nightly recalculation, frozen as a row (§9.6). Makes `bake` atomic: baking marks
 * one already-computed snapshot rather than racing a recompute.
 *
 * `totalSlices` is EMERGENT — a live SUM over the ledger, not a fixed pool. The mock's
 * "1% = 2,000 slices" only holds when the pool is exactly 200,000, and the pool changes
 * daily by construction (§9.5).
 *
 * `isDegenerate` is its own state, not a zero. A brand-new project where nobody has
 * contributed has NO cap table, and rendering "0%" for every member would present a
 * fabricated number as a computed fact.
 */
export const equitySnapshot = pgTable(
  "equity_snapshot",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    // The QUANTIZED reference instant this run was a pure function of (§4c rule 3).
    asOf: timestamp("as_of").notNull(),
    computedAt: timestamp("computed_at").defaultNow().notNull(),
    totalSlices: bigint("total_slices", { mode: "bigint" }).notNull(),
    memberCount: integer("member_count").notNull(),
    // Recorded in the data, per §9.4, so a future algorithm change is visible in history
    // rather than silently re-apportioning it.
    apportionmentAlgorithm: text("apportionment_algorithm")
      .default("largest-remainder-v1")
      .notNull(),
    // Exactly which ledger prefix this snapshot covers — the reason it is reproducible.
    throughLedgerSequenceNumber: integer("through_ledger_sequence_number").notNull(),
    isDegenerate: boolean("is_degenerate").default(false).notNull(),
    isBaked: boolean("is_baked").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("equity_snapshot_projectId_asOf_unq").on(table.projectId, table.asOf),
    index("equity_snapshot_projectId_computedAt_idx").on(
      table.projectId,
      table.computedAt,
      table.id,
    ),
    // The pie bakes ONCE, ever (§9.11). One baked snapshot per project, enforced here as
    // well as by pie_bake_event's own unique index.
    uniqueIndex("equity_snapshot_projectId_baked_unq")
      .on(table.projectId)
      .where(sql`is_baked = true`),
    check(
      "equity_snapshot_totals_ck",
      sql`total_slices >= 0 AND member_count >= 0 AND through_ledger_sequence_number >= 0`,
    ),
    // Degeneracy is exactly "no slices anywhere", and it is the ONLY case in which the
    // shares below are permitted not to sum to 10000.
    check("equity_snapshot_degenerate_ck", sql`(is_degenerate = true) = (total_slices = 0)`),
  ],
);

/**
 * One member's share in one snapshot. FORMULA-PRODUCED, apportioned by largest remainder
 * so the parts sum to EXACTLY 10000 basis points (§9.4).
 *
 * `memberUserId` is denormalized DELIBERATELY: it is the canonical tie-break key, compared
 * in BYTE ORDER, and apportionment must not depend on a join whose collation could change.
 */
export const equitySnapshotShare = pgTable(
  "equity_snapshot_share",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => equitySnapshot.id, { onDelete: "restrict" }),
    memberId: text("member_id")
      .notNull()
      .references(() => projectMember.id, { onDelete: "restrict" }),
    memberUserId: text("member_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    slices: bigint("slices", { mode: "bigint" }).notNull(),
    equityBasisPoints: integer("equity_basis_points").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("equity_snapshot_share_snapshotId_memberId_unq").on(
      table.snapshotId,
      table.memberId,
    ),
    index("equity_snapshot_share_memberId_idx").on(table.memberId, table.id),
    check(
      "equity_snapshot_share_bps_ck",
      sql`equity_basis_points BETWEEN 0 AND 10000 AND slices >= 0`,
    ),
  ],
);

/**
 * Baking the pie (§9.11, SPEC §3.4) — dynamic calculation STOPS and percentages freeze
 * permanently.
 *
 * `uniqueIndex(project_id)` guarantees once, ever. THERE IS NO UNBAKE ENDPOINT; recovery
 * is a manual, audited, out-of-band operation.
 */
export const pieBakeEvent = pgTable(
  "pie_bake_event",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => equitySnapshot.id, { onDelete: "restrict" }),
    trigger: pieBakeTriggerEnum("trigger").notNull(),
    triggerEvidenceNote: text("trigger_evidence_note").notNull(),
    // Money, so `bigint` (§4b). NULL for a breakeven bake, which has no valuation.
    valuationCents: bigint("valuation_cents", { mode: "bigint" }),
    // The typed phrase. Stored so the audit entry can prove a human typed it.
    acknowledgement: text("acknowledgement").notNull(),
    bakedByUserId: text("baked_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    bakedAt: timestamp("baked_at").defaultNow().notNull(),
  },
  (table) => [
    // ONCE, EVER, PER PROJECT.
    uniqueIndex("pie_bake_event_project_unq").on(table.projectId),
    check("pie_bake_event_evidence_ck", sql`char_length(trigger_evidence_note) BETWEEN 1 AND 2000`),
    check("pie_bake_event_valuation_ck", sql`valuation_cents IS NULL OR valuation_cents > 0`),
  ],
);

/**
 * An AI-produced suggestion with a lifecycle the mock lacks — §9.1's left column, so it
 * carries full provenance and can be accepted or dismissed by a human.
 *
 * It suggests; it never allocates. Nothing here writes a slice.
 */
export const optimizationSuggestion = pgTable(
  "optimization_suggestion",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    // NULL when the suggestion is about the project rather than one person.
    memberId: text("member_id").references(() => projectMember.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    bodyText: text("body_text").notNull(),
    status: optimizationSuggestionStatusEnum("status").default("open").notNull(),
    modelName: text("model_name").notNull(),
    modelVersion: text("model_version"),
    promptVersion: text("prompt_version").notNull(),
    confidenceBps: integer("confidence_bps"),
    asOf: timestamp("as_of").notNull(),
    decidedByUserId: text("decided_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    decidedAt: timestamp("decided_at"),
    decisionNote: text("decision_note"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("optimization_suggestion_projectId_status_idx").on(
      table.projectId,
      table.status,
      table.id,
    ),
    check(
      "optimization_suggestion_text_ck",
      sql`char_length(title) BETWEEN 1 AND 200 AND char_length(body_text) BETWEEN 1 AND 4000`,
    ),
    check(
      "optimization_suggestion_confidence_ck",
      sql`confidence_bps IS NULL OR confidence_bps BETWEEN 0 AND 10000`,
    ),
    check(
      "optimization_suggestion_decision_ck",
      sql`(status = 'open') = (decided_at IS NULL)
          AND (decided_at IS NULL) = (decided_by_user_id IS NULL)`,
    ),
  ],
);

/** What a suggestion is based on. Cascades: a derivative, recomputable at any time. */
export const optimizationSuggestionEvidence = pgTable(
  "optimization_suggestion_evidence",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    suggestionId: text("suggestion_id")
      .notNull()
      .references(() => optimizationSuggestion.id, { onDelete: "cascade" }),
    sequenceNumber: integer("sequence_number").notNull(),
    label: text("label").notNull(),
    // `set null`, not `restrict`: the evidence pointer is a convenience, and a suggestion
    // must never be the reason a claim cannot be archived.
    relatedClaimId: text("related_claim_id").references(() => effortClaim.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("optimization_suggestion_evidence_seq_unq").on(
      table.suggestionId,
      table.sequenceNumber,
    ),
    check("optimization_suggestion_evidence_label_ck", sql`char_length(label) BETWEEN 1 AND 500`),
  ],
);

// --- §9 relations. Child-side only, same convention as §5, §6 and §8.

export const memberFairMarketRateRelations = relations(memberFairMarketRate, ({ one }) => ({
  project: one(researchProject, {
    fields: [memberFairMarketRate.projectId],
    references: [researchProject.id],
  }),
  member: one(projectMember, {
    fields: [memberFairMarketRate.memberId],
    references: [projectMember.id],
  }),
  // relationName because this table has THREE relations to `user`; without it Drizzle
  // cannot tell them apart.
  proposedBy: one(user, {
    fields: [memberFairMarketRate.proposedByUserId],
    references: [user.id],
    relationName: "fairMarketRateProposedBy",
  }),
  acceptedBy: one(user, {
    fields: [memberFairMarketRate.acceptedByUserId],
    references: [user.id],
    relationName: "fairMarketRateAcceptedBy",
  }),
  lockedBy: one(user, {
    fields: [memberFairMarketRate.lockedByUserId],
    references: [user.id],
    relationName: "fairMarketRateLockedBy",
  }),
}));

export const effortClaimRelations = relations(effortClaim, ({ one, many }) => ({
  project: one(researchProject, {
    fields: [effortClaim.projectId],
    references: [researchProject.id],
  }),
  member: one(projectMember, {
    fields: [effortClaim.memberId],
    references: [projectMember.id],
  }),
  dailyLog: one(dailyLog, {
    fields: [effortClaim.dailyLogId],
    references: [dailyLog.id],
  }),
  fairMarketRate: one(memberFairMarketRate, {
    fields: [effortClaim.fairMarketRateId],
    references: [memberFairMarketRate.id],
  }),
  overriddenBy: one(user, {
    fields: [effortClaim.overriddenByUserId],
    references: [user.id],
  }),
  runs: many(claimVerificationRun),
  evidence: many(artifactEvidence),
}));

export const claimVerificationRunRelations = relations(claimVerificationRun, ({ one, many }) => ({
  claim: one(effortClaim, {
    fields: [claimVerificationRun.claimId],
    references: [effortClaim.id],
  }),
  triggeredBy: one(user, {
    fields: [claimVerificationRun.triggeredByUserId],
    references: [user.id],
  }),
  steps: many(verificationStep),
}));

export const verificationStepRelations = relations(verificationStep, ({ one }) => ({
  run: one(claimVerificationRun, {
    fields: [verificationStep.runId],
    references: [claimVerificationRun.id],
  }),
  reviewedBy: one(user, {
    fields: [verificationStep.reviewedByUserId],
    references: [user.id],
  }),
}));

export const artifactEvidenceRelations = relations(artifactEvidence, ({ one }) => ({
  project: one(researchProject, {
    fields: [artifactEvidence.projectId],
    references: [researchProject.id],
  }),
  claim: one(effortClaim, {
    fields: [artifactEvidence.claimId],
    references: [effortClaim.id],
  }),
  consentGrant: one(integrationConsentGrant, {
    fields: [artifactEvidence.consentGrantId],
    references: [integrationConsentGrant.id],
  }),
}));

export const integrationConsentGrantRelations = relations(
  integrationConsentGrant,
  ({ one, many }) => ({
    project: one(researchProject, {
      fields: [integrationConsentGrant.projectId],
      references: [researchProject.id],
    }),
    member: one(projectMember, {
      fields: [integrationConsentGrant.memberId],
      references: [projectMember.id],
    }),
    revokedBy: one(user, {
      fields: [integrationConsentGrant.revokedByUserId],
      references: [user.id],
    }),
    evidence: many(artifactEvidence),
  }),
);

export const physicalWorkReceiptRelations = relations(physicalWorkReceipt, ({ one, many }) => ({
  project: one(researchProject, {
    fields: [physicalWorkReceipt.projectId],
    references: [researchProject.id],
  }),
  member: one(projectMember, {
    fields: [physicalWorkReceipt.memberId],
    references: [projectMember.id],
  }),
  claim: one(effortClaim, {
    fields: [physicalWorkReceipt.claimId],
    references: [effortClaim.id],
  }),
  forensicsChecks: many(receiptForensicsCheck),
}));

export const receiptForensicsCheckRelations = relations(receiptForensicsCheck, ({ one }) => ({
  receipt: one(physicalWorkReceipt, {
    fields: [receiptForensicsCheck.receiptId],
    references: [physicalWorkReceipt.id],
  }),
}));

export const sliceAllocationProposalRelations = relations(
  sliceAllocationProposal,
  ({ one, many }) => ({
    project: one(researchProject, {
      fields: [sliceAllocationProposal.projectId],
      references: [researchProject.id],
    }),
    claim: one(effortClaim, {
      fields: [sliceAllocationProposal.claimId],
      references: [effortClaim.id],
    }),
    member: one(projectMember, {
      fields: [sliceAllocationProposal.memberId],
      references: [projectMember.id],
    }),
    run: one(claimVerificationRun, {
      fields: [sliceAllocationProposal.runId],
      references: [claimVerificationRun.id],
    }),
    disputes: many(dispute),
  }),
);

export const disputeRelations = relations(dispute, ({ one, many }) => ({
  project: one(researchProject, {
    fields: [dispute.projectId],
    references: [researchProject.id],
  }),
  proposal: one(sliceAllocationProposal, {
    fields: [dispute.proposalId],
    references: [sliceAllocationProposal.id],
  }),
  raisedBy: one(projectMember, {
    fields: [dispute.raisedByMemberId],
    references: [projectMember.id],
  }),
  resolvedBy: one(user, {
    fields: [dispute.resolvedByUserId],
    references: [user.id],
  }),
  votes: many(disputeVote),
}));

export const disputeVoteRelations = relations(disputeVote, ({ one }) => ({
  dispute: one(dispute, {
    fields: [disputeVote.disputeId],
    references: [dispute.id],
  }),
  voter: one(projectMember, {
    fields: [disputeVote.voterMemberId],
    references: [projectMember.id],
  }),
}));

export const sliceLedgerEntryRelations = relations(sliceLedgerEntry, ({ one }) => ({
  project: one(researchProject, {
    fields: [sliceLedgerEntry.projectId],
    references: [researchProject.id],
  }),
  member: one(projectMember, {
    fields: [sliceLedgerEntry.memberId],
    references: [projectMember.id],
  }),
  claim: one(effortClaim, {
    fields: [sliceLedgerEntry.claimId],
    references: [effortClaim.id],
  }),
  fairMarketRate: one(memberFairMarketRate, {
    fields: [sliceLedgerEntry.fairMarketRateId],
    references: [memberFairMarketRate.id],
  }),
}));

export const projectChainHeadRelations = relations(projectChainHead, ({ one }) => ({
  project: one(researchProject, {
    fields: [projectChainHead.projectId],
    references: [researchProject.id],
  }),
}));

export const projectAuditEntryRelations = relations(projectAuditEntry, ({ one }) => ({
  project: one(researchProject, {
    fields: [projectAuditEntry.projectId],
    references: [researchProject.id],
  }),
  actor: one(user, {
    fields: [projectAuditEntry.actorUserId],
    references: [user.id],
  }),
}));

export const equitySnapshotRelations = relations(equitySnapshot, ({ one, many }) => ({
  project: one(researchProject, {
    fields: [equitySnapshot.projectId],
    references: [researchProject.id],
  }),
  shares: many(equitySnapshotShare),
}));

export const equitySnapshotShareRelations = relations(equitySnapshotShare, ({ one }) => ({
  snapshot: one(equitySnapshot, {
    fields: [equitySnapshotShare.snapshotId],
    references: [equitySnapshot.id],
  }),
  member: one(projectMember, {
    fields: [equitySnapshotShare.memberId],
    references: [projectMember.id],
  }),
}));

export const pieBakeEventRelations = relations(pieBakeEvent, ({ one }) => ({
  project: one(researchProject, {
    fields: [pieBakeEvent.projectId],
    references: [researchProject.id],
  }),
  snapshot: one(equitySnapshot, {
    fields: [pieBakeEvent.snapshotId],
    references: [equitySnapshot.id],
  }),
  bakedBy: one(user, {
    fields: [pieBakeEvent.bakedByUserId],
    references: [user.id],
  }),
}));

export const optimizationSuggestionRelations = relations(
  optimizationSuggestion,
  ({ one, many }) => ({
    project: one(researchProject, {
      fields: [optimizationSuggestion.projectId],
      references: [researchProject.id],
    }),
    member: one(projectMember, {
      fields: [optimizationSuggestion.memberId],
      references: [projectMember.id],
    }),
    evidence: many(optimizationSuggestionEvidence),
  }),
);

export const optimizationSuggestionEvidenceRelations = relations(
  optimizationSuggestionEvidence,
  ({ one }) => ({
    suggestion: one(optimizationSuggestion, {
      fields: [optimizationSuggestionEvidence.suggestionId],
      references: [optimizationSuggestion.id],
    }),
  }),
);

// ---------------------------------------------------------------------------
// §7 — FUNDING & ESCROW. docs/R_AND_D_BACKEND_STRUCTURE.md §7, §11c, §12.
//
// The highest-stakes surface in the product. Read §0 before editing anything below.
//
// THE CARD NETWORK IS DEFERRED, THE LEDGER IS NOT (§7's amendment note, Appendix A3).
// Every table here ships for real: the double-entry ledger, the zero-sum invariant, the
// hash chain, the four-eyes release, the suspense account and the reconciliation job.
// What is stubbed is one outbound call — `provider_transfer` goes to an INTERNAL adapter
// instead of Stripe, and settlement flips through an auditor-gated endpoint instead of
// `POST /webhooks/payments/stripe`, which does not exist and has no route, no raw-body
// mount and no signature verification. NO REAL FUNDS MOVE. A pledge is a recorded intent
// and a release is a recorded entitlement; no client may say a card was charged.
//
// ---------------------------------------------------------------------------
// THE SIGN CONVENTION, stated once, because §7's prose does not fix it and every
// posting below depends on it.
//
// `escrow_posting.signedAmountInCents` is POSITIVE INTO an account and NEGATIVE OUT, and
// the postings of one journal entry SUM TO EXACTLY ZERO. Read the six accounts as one
// pool plus the places money enters and leaves it:
//
//   provider_clearing      the OUTSIDE WORLD — the card network. A source of funds, so
//                          its balance is NEGATIVE and grows more negative with volume.
//                          It does not return to zero, and it should not.
//   escrow_held            THE POOL. Cash held for the project. Positive.
//   released_to_project    cumulative payout out of the pool. Positive (a destination).
//   platform_fee           cumulative fee taken out of the pool. Positive.
//   refunds_payable        cumulative refunded out of the pool. Positive.
//   reconciliation_suspense where provider-vs-ledger disagreement lives, in public.
//
// So a pledge of gross A with fee F and net N = A − F posts
// `provider_clearing −A, escrow_held +N, platform_fee +F`, and a milestone release posts
// `escrow_held −X, released_to_project +X`. Both sum to zero, and
// `escrow_held + released_to_project + platform_fee + refunds_payable + suspense
//  + provider_clearing = 0` over the whole project, always. That identity is the
// machine-checkable proof §7 asks for, and the nightly job asserts it.
//
// ---------------------------------------------------------------------------
// A PENDING ENTRY IS IN THE JOURNAL AND OUT OF THE BALANCE.
//
// §7 requires that `raisedAmountInCents`, `backersCount` and account balances move ONLY
// at settlement. That is why `escrow_account` carries TWO balances: `cachedBalanceInCents`
// sums postings whose ENTRY is `settled`, and `pendingBalanceInCents` sums postings whose
// entry is `pending`. Money in flight is then literally "simply a balance" (§7's own
// words) without a pending pledge ever touching the settled figure.
//
// THE PART THAT LOOKS LIKE AN UPDATE AND IS NOT. §7 describes settlement as flipping
// `escrow_journal_entry.settlement` from `pending` to `settled` — and, four paragraphs
// later, revokes UPDATE on that table. Both cannot be true. The append-only rule wins,
// because it is the one with a trigger behind it, so a pledge that settles produces
// THREE entries and never an edit:
//
//   1. `pledge_authorized`  settlement=pending   provider_clearing −A, escrow_held +N,
//                                                platform_fee +F
//   2. `reversal`           settlement=pending   the exact mirror of 1, so the PENDING
//                                                sum returns to zero
//   3. `pledge_settled`     settlement=settled   the same postings as 1, now real
//
// Each sums to zero on its own; both balances stay pure `SUM`s with no join and no
// special case; and the journal reads as a true story an auditor can follow — authorized,
// released from in-flight, settled — rather than a row whose history was overwritten. A
// pledge that FAILS gets entries 1 and 2 and no third, so nothing ever entered the pool.
//
// TWO FURTHER DEVIATIONS FROM §7'S LITERAL TEXT, both recorded in the doc:
//
//  1. §7's money path reads "settlement … posts provider_clearing → released_to_project".
//     Taken literally that hands the founder the cash the instant a card clears, which
//     contradicts the four-eyes milestone gate three paragraphs later and the entire
//     purpose of an escrow. Settlement moves money INTO `escrow_held`; only an approved
//     `escrow_release` moves it to `released_to_project`.
//  2. §7 allocates the escrow sequence with "SELECT … FOR UPDATE on the project's last
//     entry". That is a second serialization point beside §9's `project_chain_head`, and a
//     writer appending an escrow entry AND an audit entry in one transaction — which every
//     money event does — would take two locks. Three counters live on the ONE head row.
// ---------------------------------------------------------------------------

/**
 * Round types. `ENABLED_FUNDING_ROUND_TYPES` (env, default `["crowdfunding"]`) gates
 * these AT THE API — before creating a round, before opening one, before accepting a
 * pledge, and in the `/funding/deals` filter (§7 regulatory gating).
 *
 * PROOF_OF_EFFORT_SPEC.md §1 sequences reward crowdfunding in Year 1 and true equity
 * crowdfunding in Year 3+, behind FINRA/SEC registration or a licensed broker-dealer
 * partner. A disabled type must be invisible and un-pledgeable at the HTTP layer, which
 * is what makes hiding the chip in the frontend cosmetic rather than load-bearing.
 */
export const fundingRoundTypeEnum = pgEnum("funding_round_type", [
  "crowdfunding",
  "equity",
  "venture",
]);

export const fundingRoundStatusEnum = pgEnum("funding_round_status", [
  "draft", // created, not accepting pledges
  "open", // accepting pledges
  "closed", // terminal for pledging; existing pledges keep settling
  "cancelled", // terminal
]);

export const pledgeStatusEnum = pgEnum("pledge_status", [
  "pending", // authorized, provider has not settled
  "settled", // the ONLY status that has moved a balance
  "failed", // the provider declined; a reversing entry was appended
  "cancelled", // withdrawn by the backer before settlement
  "refunded", // settled, then returned
]);

/** The six accounts, one set per project. See the sign convention above. */
export const escrowAccountKindEnum = pgEnum("escrow_account_kind", [
  "escrow_held",
  "provider_clearing",
  "released_to_project",
  "platform_fee",
  "refunds_payable",
  "reconciliation_suspense",
]);

export const escrowJournalKindEnum = pgEnum("escrow_journal_kind", [
  "pledge_authorized",
  "pledge_settled",
  "pledge_failed",
  "pledge_cancelled",
  "pledge_refunded",
  "platform_fee_charged",
  "milestone_release",
  "reconciliation_adjustment",
  "reversal",
]);

/** Projects to the frontend's "pending" | "verified" badge. */
export const escrowEntrySettlementEnum = pgEnum("escrow_entry_settlement", [
  "pending",
  "settled",
  "failed",
]);

/**
 * `internal_adapter` is the only value written today. `stripe` exists so that switching
 * Appendix A3 on is an INSERT rather than a migration — the seam §7 promises.
 */
export const paymentProviderEnum = pgEnum("payment_provider", ["internal_adapter", "stripe"]);

export const providerTransferDirectionEnum = pgEnum("provider_transfer_direction", [
  "inbound", // a backer's pledge
  "outbound", // a milestone payout
]);

export const providerTransferStatusEnum = pgEnum("provider_transfer_status", [
  "created", // row written with OUR idempotency key, BEFORE any provider call
  "submitted", // handed to the adapter by the worker
  "settled",
  "failed",
  "cancelled",
]);

export const escrowReleaseStatusEnum = pgEnum("escrow_release_status", [
  "requested",
  "approved",
  "rejected",
  "cancelled",
]);

export const milestoneStatusEnum = pgEnum("milestone_status", [
  "planned",
  "in_progress",
  "done", // the only status an escrow release may be approved against
  "cancelled",
]);

/**
 * The unit each variance integer IS IN — not a display hint and not a scale factor.
 *
 * §15 replaces five pre-rendered labels with six typed integers and TWO UNIT NOUNS. The
 * noun travels with the number so no client hardcodes an English word and no reader has
 * to guess: comparing two variance rows means reading the key, which is exactly why it
 * exists. The server writes the canonical unit today; the wider enum is what lets a
 * project choose a coarser granularity later without any stored number changing meaning.
 */
export const varianceScheduleUnitKeyEnum = pgEnum("variance_schedule_unit_key", ["days", "weeks"]);

export const varianceEffortUnitKeyEnum = pgEnum("variance_effort_unit_key", ["minutes", "hours"]);

export const reconciliationDiscrepancyStatusEnum = pgEnum("reconciliation_discrepancy_status", [
  "open",
  "resolved",
  "written_off",
]);

/**
 * A funding round. `percentageFunded` IS NOT A COLUMN and not a request field (§7) — it
 * is computed on read as `floor(raised * 10000 / goal)` and returned as
 * `percentageFundedBasisPoints`. It cannot be stored, so it cannot be forged or drift.
 * The value may exceed 10000 when overfunded; the client clamps the BAR WIDTH, not the
 * number.
 */
export const fundingRound = pgTable(
  "funding_round",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    // `restrict` on every parent FK in this domain, without exception (§4f).
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    type: fundingRoundTypeEnum("type").notNull(),
    status: fundingRoundStatusEnum("status").default("draft").notNull(),
    // `bigint`, not `integer` (§4b): int4 caps at ±$21,474,836.47, which one Series-A
    // round overflows. Getting this wrong is not merely a limit problem — the hash chain
    // covers posting amounts, so widening the column later re-derives every historical
    // hash.
    goalAmountInCents: bigint("goal_amount_in_cents", { mode: "bigint" }).notNull(),
    // WRITTEN BY EXACTLY ONE CODE PATH: escrow-settlement.service.ts, inside the same
    // transaction that flips the journal entry to `settled`. No controller and no
    // user-facing service function touches these two. That is a grep-able invariant (§7).
    raisedAmountInCents: bigint("raised_amount_in_cents", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    backersCount: integer("backers_count").default(0).notNull(),
    // The round's OWN bounds, which the server re-checks every pledge against. A client
    // that edits its copy changes nothing.
    minimumPledgeInCents: bigint("minimum_pledge_in_cents", { mode: "bigint" })
      .notNull()
      .default(sql`100`),
    maximumPledgeInCents: bigint("maximum_pledge_in_cents", { mode: "bigint" }),
    // Server-owned, copied from the project at create. There is no `currency` field in
    // any request body (§4b) — an amount never travels without its ISO 4217 code.
    currency: text("currency").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    opensAt: timestamp("opens_at"),
    closesAt: timestamp("closes_at"),
    closedAt: timestamp("closed_at"),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("funding_round_projectId_status_idx").on(table.projectId, table.status),
    // §4c rule 4: every ORDER BY feeding pagination ends in a UNIQUE column, or a cursor
    // silently skips rows. Matches the /funding/deals feed.
    index("funding_round_deals_idx").on(table.status, table.type, table.closesAt, table.id),
    check("funding_round_goal_ck", sql`goal_amount_in_cents > 0`),
    check("funding_round_raised_ck", sql`raised_amount_in_cents >= 0 AND backers_count >= 0`),
    check(
      "funding_round_bounds_ck",
      sql`minimum_pledge_in_cents >= 1
          AND (maximum_pledge_in_cents IS NULL
               OR maximum_pledge_in_cents >= minimum_pledge_in_cents)`,
    ),
    check(
      "funding_round_window_ck",
      sql`opens_at IS NULL OR closes_at IS NULL OR closes_at > opens_at`,
    ),
    // A round cannot be open without a start instant, or "when did pledging begin" has no
    // answer on a surface whose whole argument is auditability.
    check("funding_round_open_ck", sql`(status <> 'open') OR (opens_at IS NOT NULL)`),
    check("funding_round_closed_at_ck", sql`(status = 'closed') = (closed_at IS NOT NULL)`),
    check("funding_round_currency_ck", sql`currency ~ '^[A-Z]{3}$'`),
    check("funding_round_title_ck", sql`char_length(title) BETWEEN 1 AND 200`),
  ],
);

/**
 * A pledge. The request body is `{ amountInCents }` AND NOTHING ELSE — §7 enumerates 27
 * keys `.strict()` turns into a 422 rather than a silent overwrite, and every column
 * below that a client might wish to name is server-derived from this row's round.
 *
 * `providerTransferId` points AT the transfer and the transfer does not point back: one
 * direction only, so there is no circular insert and no nullable-then-updated FK pair.
 */
export const fundingRoundPledge = pgTable(
  "funding_round_pledge",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    roundId: text("round_id")
      .notNull()
      .references(() => fundingRound.id, { onDelete: "restrict" }),
    // Denormalized so the escrow reads scope by project without joining the round on
    // every balance query. Written from the round, never from a body.
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    // ALWAYS req.user.id. There is no `backerUserId` field in any request schema (§13).
    backerUserId: text("backer_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    amountInCents: bigint("amount_in_cents", { mode: "bigint" }).notNull(),
    // Derived from `PLATFORM_FEE_BASIS_POINTS` through src/lib/money.ts, never sent.
    platformFeeInCents: bigint("platform_fee_in_cents", { mode: "bigint" }).notNull(),
    netToEscrowInCents: bigint("net_to_escrow_in_cents", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    status: pledgeStatusEnum("status").default("pending").notNull(),
    providerTransferId: text("provider_transfer_id").references(
      (): AnyPgColumn => providerTransfer.id,
      { onDelete: "restrict" },
    ),
    settledAt: timestamp("settled_at"),
    cancelledAt: timestamp("cancelled_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("funding_round_pledge_roundId_idx").on(table.roundId, table.createdAt, table.id),
    index("funding_round_pledge_backerUserId_idx").on(
      table.backerUserId,
      table.createdAt,
      table.id,
    ),
    index("funding_round_pledge_projectId_status_idx").on(table.projectId, table.status),
    // One pledge per transfer. A second pledge sharing a transfer would settle twice.
    uniqueIndex("funding_round_pledge_providerTransferId_unq")
      .on(table.providerTransferId)
      .where(sql`provider_transfer_id IS NOT NULL`),
    check(
      "funding_round_pledge_amounts_ck",
      sql`amount_in_cents > 0
          AND platform_fee_in_cents >= 0
          AND platform_fee_in_cents <= amount_in_cents
          AND net_to_escrow_in_cents = amount_in_cents - platform_fee_in_cents`,
    ),
    check(
      "funding_round_pledge_settled_at_ck",
      sql`(status IN ('settled','refunded')) = (settled_at IS NOT NULL)`,
    ),
    check(
      "funding_round_pledge_cancelled_at_ck",
      sql`(status = 'cancelled') = (cancelled_at IS NOT NULL)`,
    ),
    check("funding_round_pledge_currency_ck", sql`currency ~ '^[A-Z]{3}$'`),
  ],
);

/**
 * One account per (project, kind) — the six of §7, created together on first use.
 *
 * BOTH BALANCES ARE CACHES; the postings are the truth. `escrow.service.ts` re-derives
 * from `SUM` on every read that GATES a release, because a stale cache that is wrong in
 * the permissive direction pays out money the project does not have.
 * `balanceThroughSequenceNumber` says how stale, so a reader can tell rather than assume.
 */
export const escrowAccount = pgTable(
  "escrow_account",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    kind: escrowAccountKindEnum("kind").notNull(),
    currency: text("currency").notNull(),
    /** Sums postings whose ENTRY is `settled`. Written only by the settlement path. */
    cachedBalanceInCents: bigint("cached_balance_in_cents", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    /** Sums postings whose entry is still `pending` — §7's "money in flight". */
    pendingBalanceInCents: bigint("pending_balance_in_cents", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    balanceThroughSequenceNumber: integer("balance_through_sequence_number").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("escrow_account_projectId_kind_unq").on(table.projectId, table.kind),
    check("escrow_account_currency_ck", sql`currency ~ '^[A-Z]{3}$'`),
    check("escrow_account_sequence_ck", sql`balance_through_sequence_number >= 0`),
    // No non-negativity check on either balance, deliberately: `provider_clearing` is the
    // outside world and is NEGATIVE by construction, and `reconciliation_suspense` takes
    // whichever sign the discrepancy has. A blanket `>= 0` here would forbid a correct
    // ledger. Non-negativity of the POOL is a service gate on release, not a column rule.
  ],
);

/**
 * The escrow journal — APPEND-ONLY and HASH-CHAINED (§7).
 *
 * ENFORCED FOUR WAYS, because service-layer discipline is not enforcement:
 *   1. `UPDATE`/`DELETE` REVOKED from the application role (hand-written in the
 *      migration). This is the layer that survives a bug in our own code.
 *   2. `BEFORE UPDATE OR DELETE` and `BEFORE TRUNCATE` triggers that RAISE.
 *   3. No `db.update(...)`/`db.delete(...)` against this table exists anywhere in the
 *      service. The only verb is `insert`.
 *   4. `UNIQUE(projectId, sequenceNumber)` plus the chain makes out-of-band tampering
 *      detectable by any verifier that walks it — `GET …/escrow/verify` is one.
 *
 * `settlement` is the one apparent exception and is NOT one: it is written at INSERT and
 * never moves. A pledge that settles appends a reversal plus a `pledge_settled` entry —
 * see "THE PART THAT LOOKS LIKE AN UPDATE AND IS NOT" in the section header above.
 */
export const escrowJournalEntry = pgTable(
  "escrow_journal_entry",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    // `restrict`, NOT cascade (§4f) — a project deletion must never erase a ledger.
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    // Monotonic per project from 1. A gap or reorder is immediately detectable.
    // Allocated under the `project_chain_head` lock, alongside the audit and slice
    // counters, so one writer holds one lock (see the deviation note above).
    sequenceNumber: integer("sequence_number").notNull(),
    kind: escrowJournalKindEnum("kind").notNull(),
    // SERVER-COMPOSED display copy ("Milestone release — 400-vendor demand survey").
    // Composed here rather than on three clients so web/Kotlin/Swift cannot drift. The
    // one deliberate display string in this domain — it is prose, not a number.
    description: text("description").notNull(),
    currency: text("currency").notNull(),
    // The BUSINESS EVENT time (provider settlement), which may lag createdAt.
    occurredAt: timestamp("occurred_at").notNull(),
    settlement: escrowEntrySettlementEnum("settlement").default("pending").notNull(),
    // `set null`, NOT cascade — deleting a milestone must never delete financial history.
    linkedMilestoneId: text("linked_milestone_id").references((): AnyPgColumn => milestone.id, {
      onDelete: "set null",
    }),
    linkedPledgeId: text("linked_pledge_id").references(() => fundingRoundPledge.id, {
      onDelete: "set null",
    }),
    linkedReleaseId: text("linked_release_id").references((): AnyPgColumn => escrowRelease.id, {
      onDelete: "set null",
    }),
    // Self-FK. Non-null means this entry NEGATES an earlier one. THE ONLY CORRECTION
    // MECHANISM — nothing in this table is ever UPDATEd or DELETEd.
    //
    // §7's own snippet leaves this column unreferenced; it is wired here, because a
    // dangling reversal pointer is a hole in exactly the mechanism that replaces editing.
    reversesJournalEntryId: text("reverses_journal_entry_id").references(
      (): AnyPgColumn => escrowJournalEntry.id,
      { onDelete: "restrict" },
    ),
    // Canonical hash per §4c, FULL 64-char hex. The 6-character form the mocks show is
    // display only: at 24 bits collisions hit 50% around 4,800 entries, so it must never
    // be a key, a cache key, or an equality test.
    entryHash: text("entry_hash").notNull(),
    // The prior entry's hash; the literal "genesis" at sequenceNumber 1. (§9's audit
    // chain spells its genesis NULL instead — the two are independent chains and each
    // follows the text that specifies it.)
    previousEntryHash: text("previous_entry_hash").notNull(),
    hashVersion: integer("hash_version").default(1).notNull(),
    // NULL for system/adapter-authored entries — most of them.
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    // NO updatedAt column, deliberately. An append-only table has nothing to update.
  },
  (table) => [
    uniqueIndex("escrow_journal_entry_project_seq_unq").on(table.projectId, table.sequenceNumber),
    index("escrow_journal_entry_project_occurredAt_idx").on(
      table.projectId,
      table.occurredAt,
      table.id,
    ),
    index("escrow_journal_entry_settlement_idx").on(table.settlement),
    index("escrow_journal_entry_linkedPledgeId_idx").on(table.linkedPledgeId),
    check("escrow_journal_entry_sequence_ck", sql`sequence_number >= 1`),
    check("escrow_journal_entry_hash_ck", sql`entry_hash ~ '^[0-9a-f]{64}$'`),
    check(
      "escrow_journal_entry_link_ck",
      sql`(sequence_number = 1) = (previous_entry_hash = 'genesis')
          AND (previous_entry_hash = 'genesis' OR previous_entry_hash ~ '^[0-9a-f]{64}$')`,
    ),
    check(
      "escrow_journal_entry_reversal_ck",
      sql`(kind <> 'reversal') OR (reverses_journal_entry_id IS NOT NULL)`,
    ),
    check("escrow_journal_entry_currency_ck", sql`currency ~ '^[A-Z]{3}$'`),
    check("escrow_journal_entry_description_ck", sql`char_length(description) BETWEEN 1 AND 500`),
  ],
);

/**
 * The postings. Positive INTO the account, negative OUT, and `SUM` over one entry MUST
 * EQUAL ZERO — asserted in the service before commit, by a DEFERRED CONSTRAINT TRIGGER at
 * commit (hand-written in the migration), and again by the nightly reconciliation job.
 *
 * §7 calls the zero-sum invariant "a machine-checkable proof that no money was conjured",
 * and a proof only the application performs is not that. Three layers, on purpose.
 *
 * `accountKind` is denormalized from `escrow_account` so a balance query groups without a
 * join and so the hash document does not have to resolve an id to a name years later.
 */
export const escrowPosting = pgTable(
  "escrow_posting",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    // `restrict`, not cascade, even though this is a child row: cascading from a table
    // nothing may delete is dead code that reads as permission.
    journalEntryId: text("journal_entry_id")
      .notNull()
      .references(() => escrowJournalEntry.id, { onDelete: "restrict" }),
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    accountId: text("account_id")
      .notNull()
      .references(() => escrowAccount.id, { onDelete: "restrict" }),
    accountKind: escrowAccountKindEnum("account_kind").notNull(),
    // `bigint` per §4b. The hash chain covers this column, so widening it later would
    // force the entire historical chain to be re-derived. Right on day one.
    signedAmountInCents: bigint("signed_amount_in_cents", { mode: "bigint" }).notNull(),
    // Stable position inside the entry. The hash sorts child postings by
    // (accountKind, postingIndex) before serializing (§4c), so this is what makes the
    // ordering documented and unique rather than whatever Postgres returned.
    postingIndex: integer("posting_index").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("escrow_posting_entry_index_unq").on(table.journalEntryId, table.postingIndex),
    index("escrow_posting_account_idx").on(table.accountId, table.id),
    index("escrow_posting_projectId_kind_idx").on(table.projectId, table.accountKind),
    check("escrow_posting_index_ck", sql`posting_index >= 0`),
    // A zero-amount posting carries no information and would let an entry "balance" with
    // padding rows. Every posting moves something.
    check("escrow_posting_amount_ck", sql`signed_amount_in_cents <> 0`),
  ],
);

/**
 * A transfer submitted to the payment provider.
 *
 * THE ROW IS WRITTEN WITH **OUR OWN** `randomUUID` IDEMPOTENCY KEY BEFORE ANY PROVIDER
 * CALL (§7). A key minted after the call cannot deduplicate the call that just happened,
 * which is the entire failure mode idempotency keys exist for.
 *
 * `payoutDestinationId` is resolved SERVER-SIDE from the project's registered provider
 * account. A `destinationAccountId` in a request body is a wire-fraud primitive; every
 * §7 schema is `.strict()` and rejects it.
 */
export const providerTransfer = pgTable(
  "provider_transfer",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    provider: paymentProviderEnum("provider").default("internal_adapter").notNull(),
    direction: providerTransferDirectionEnum("direction").notNull(),
    status: providerTransferStatusEnum("status").default("created").notNull(),
    amountInCents: bigint("amount_in_cents", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    /** OURS, not the provider's. Unique, and minted before the call. */
    idempotencyKey: text("idempotency_key").notNull(),
    /** The provider's own identifier, learned only after it answers. */
    providerTransferRef: text("provider_transfer_ref"),
    /** Outbound only, and never client-supplied. */
    payoutDestinationId: text("payout_destination_id"),
    failureReason: text("failure_reason"),
    submittedAt: timestamp("submitted_at"),
    settledAt: timestamp("settled_at"),
    failedAt: timestamp("failed_at"),
    /** The auditor who flipped settlement, since no card network does it here (§7). */
    settlementDecidedByUserId: text("settlement_decided_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("provider_transfer_idempotencyKey_unq").on(table.idempotencyKey),
    index("provider_transfer_projectId_status_idx").on(table.projectId, table.status),
    index("provider_transfer_status_createdAt_idx").on(table.status, table.createdAt, table.id),
    check("provider_transfer_amount_ck", sql`amount_in_cents > 0`),
    check("provider_transfer_currency_ck", sql`currency ~ '^[A-Z]{3}$'`),
    // An inbound transfer has no payout destination; there is nowhere for a backer's
    // money to be "sent to" on the way in, and a populated column would read as one.
    check(
      "provider_transfer_destination_ck",
      sql`(direction = 'outbound') OR (payout_destination_id IS NULL)`,
    ),
    check("provider_transfer_submitted_at_ck", sql`(status = 'created') = (submitted_at IS NULL)`),
    check("provider_transfer_settled_at_ck", sql`(status = 'settled') = (settled_at IS NOT NULL)`),
    check(
      "provider_transfer_failed_at_ck",
      sql`(status = 'failed') = (failed_at IS NOT NULL)
          AND (status = 'failed') = (failure_reason IS NOT NULL)`,
    ),
  ],
);

/**
 * The provider's own event, persisted BEFORE it is processed and deduped by a unique
 * constraint (§7's webhook discipline: verify → persist → dedupe → process in one
 * transaction → return 200 for duplicates).
 *
 * THIS TABLE IS WRITTEN TODAY, not reserved for Stripe. The auditor-gated settlement
 * endpoint records `provider = 'internal_adapter'` with a synthetic event id, so the
 * dedupe machinery is EXERCISED now rather than shipped untested — which is the whole
 * point of the seam. When Appendix A3 lands, the Stripe route writes the same rows and
 * runs the same transaction.
 */
export const providerWebhookEvent = pgTable(
  "provider_webhook_event",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    provider: paymentProviderEnum("provider").default("internal_adapter").notNull(),
    /** The provider's event id — the dedup key, never ours. */
    providerEventId: text("provider_event_id").notNull(),
    eventType: text("event_type").notNull(),
    projectId: text("project_id").references(() => researchProject.id, { onDelete: "restrict" }),
    providerTransferId: text("provider_transfer_id").references(() => providerTransfer.id, {
      onDelete: "restrict",
    }),
    /** Stored verbatim, as text. Evidence of what arrived, not a parsed opinion of it. */
    payloadJson: text("payload_json").notNull(),
    receivedAt: timestamp("received_at").defaultNow().notNull(),
    processedAt: timestamp("processed_at"),
    processingError: text("processing_error"),
  },
  (table) => [
    // The dedupe. A replayed event collides here and the handler answers 200 without
    // processing twice.
    uniqueIndex("provider_webhook_event_provider_eventId_unq").on(
      table.provider,
      table.providerEventId,
    ),
    index("provider_webhook_event_transferId_idx").on(table.providerTransferId),
    index("provider_webhook_event_processedAt_idx").on(table.processedAt, table.receivedAt),
  ],
);

/**
 * A milestone. `plannedPayoutInCents` is the founder's DECLARED PLAN for what hitting it
 * is worth — a plan, not an instruction to a payment rail (§7, "What survives here").
 *
 * RENAMED FROM `plannedPayoutInCents`, and the rename is the point rather than
 * tidying. The old name said this column instructed an escrow release; escrow has left
 * this domain (§7A.6), and nothing reads it to move money any more. It feeds §7A's
 * statement as a `direct_transfer` line — the founder pays it from their own bank and
 * records that they did.
 */
export const milestone = pgTable(
  "milestone",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    description: text("description"),
    status: milestoneStatusEnum("status").default("planned").notNull(),
    plannedPayoutInCents: bigint("planned_payout_in_cents", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    currency: text("currency").notNull(),
    // Date-only ISO string — the §1 wire format, with no Date object to reinterpret in a
    // local zone on the way out.
    dueDate: date("due_date", { mode: "string" }),
    completedAt: timestamp("completed_at"),
    orderIndex: integer("order_index").notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("milestone_projectId_orderIndex_unq").on(table.projectId, table.orderIndex),
    index("milestone_projectId_status_idx").on(table.projectId, table.status),
    check("milestone_planned_payout_ck", sql`planned_payout_in_cents >= 0`),
    check("milestone_order_ck", sql`order_index >= 0`),
    check("milestone_title_ck", sql`char_length(title) BETWEEN 1 AND 200`),
    check("milestone_completed_at_ck", sql`(status = 'done') = (completed_at IS NOT NULL)`),
    check("milestone_currency_ck", sql`currency ~ '^[A-Z]{3}$'`),
  ],
);

/**
 * Planned-versus-actual, as SIX TYPED INTEGERS and TWO UNIT NOUNS (§15) — replacing five
 * pre-rendered labels, of which `varianceLabel: "26% behind"` was the worst: a string
 * that cannot be sorted, compared, localized, or checked for sign.
 *
 * `varianceBasisPoints` is SIGNED and SERVER-COMPUTED through src/lib/money.ts. Negative
 * is behind, positive is ahead. There is no field for it in any request body.
 */
export const milestoneVariance = pgTable(
  "milestone_variance",
  {
    // PK and FK at once — exactly one variance row per milestone.
    milestoneId: text("milestone_id")
      .primaryKey()
      .references(() => milestone.id, { onDelete: "restrict" }),
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    plannedDurationDays: integer("planned_duration_days").notNull(),
    actualDurationDays: integer("actual_duration_days").notNull(),
    plannedCostInCents: bigint("planned_cost_in_cents", { mode: "bigint" }).notNull(),
    actualCostInCents: bigint("actual_cost_in_cents", { mode: "bigint" }).notNull(),
    plannedEffortMinutes: integer("planned_effort_minutes").notNull(),
    actualEffortMinutes: integer("actual_effort_minutes").notNull(),
    scheduleUnitKey: varianceScheduleUnitKeyEnum("schedule_unit_key").default("days").notNull(),
    effortUnitKey: varianceEffortUnitKeyEnum("effort_unit_key").default("minutes").notNull(),
    /** Signed. Computed from the schedule pair, never asserted by a client. */
    varianceBasisPoints: integer("variance_basis_points").notNull(),
    currency: text("currency").notNull(),
    computedAt: timestamp("computed_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("milestone_variance_projectId_idx").on(table.projectId),
    check(
      "milestone_variance_non_negative_ck",
      sql`planned_duration_days >= 0 AND actual_duration_days >= 0
          AND planned_cost_in_cents >= 0 AND actual_cost_in_cents >= 0
          AND planned_effort_minutes >= 0 AND actual_effort_minutes >= 0`,
    ),
    // Bounded rather than unbounded: a milestone 10,000× over plan is a data-entry
    // accident, and letting it through renders as a chart nobody can read.
    check(
      "milestone_variance_basis_points_ck",
      sql`variance_basis_points BETWEEN -1000000 AND 1000000`,
    ),
    check("milestone_variance_currency_ck", sql`currency ~ '^[A-Z]{3}$'`),
  ],
);

/**
 * A milestone payout request and its decision — THE FOUR-EYES RULE (§7).
 *
 * The request body is `{ requestNote? }` and carries NO AMOUNT AT ALL. `amountInCents` is
 * read from `milestone.plannedPayoutInCents` and SNAPSHOTTED here at request time,
 * so a founder can neither assert an amount nor edit the milestone between request and
 * approval to inflate the payout.
 *
 * Approval independently re-derives EVERY gate server-side (requester ≠ approver even for
 * a founder; the approver holds `audit_escrow` or a non-self-granted project `admin`;
 * `milestone.status = 'done'`; zero open or disputed §9 allocation windows; `escrow_held`
 * ≥ the snapshot) and freezes the evidence into `verificationSnapshot`, so a later audit
 * can prove WHY, not merely THAT.
 *
 * `verificationSnapshot` is `text`, not `jsonb`, and that is load-bearing: jsonb reorders
 * keys and normalizes numbers on write, so the bytes read back would not be the bytes
 * recorded — the same reason `project_audit_entry.payloadJson` is text.
 */
export const escrowRelease = pgTable(
  "escrow_release",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    milestoneId: text("milestone_id")
      .notNull()
      .references(() => milestone.id, { onDelete: "restrict" }),
    /** THE SNAPSHOT. Frozen at request time by a hand-written trigger, not by hope. */
    amountInCents: bigint("amount_in_cents", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    status: escrowReleaseStatusEnum("status").default("requested").notNull(),
    requestedByUserId: text("requested_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    requestNote: text("request_note"),
    requestedAt: timestamp("requested_at").defaultNow().notNull(),
    decidedByUserId: text("decided_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    decisionNote: text("decision_note"),
    decidedAt: timestamp("decided_at"),
    /** Canonical JSON of every gate and its evidence, recorded at the decision. */
    verificationSnapshot: text("verification_snapshot"),
    journalEntryId: text("journal_entry_id").references(() => escrowJournalEntry.id, {
      onDelete: "restrict",
    }),
    providerTransferId: text("provider_transfer_id").references(() => providerTransfer.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("escrow_release_projectId_status_idx").on(table.projectId, table.status),
    index("escrow_release_milestoneId_idx").on(table.milestoneId),
    // At most one release in flight per milestone, and at most one that ever paid. Two
    // approved releases on one milestone is the double-payout bug, expressed as a row.
    uniqueIndex("escrow_release_milestone_requested_unq")
      .on(table.milestoneId)
      .where(sql`status = 'requested'`),
    uniqueIndex("escrow_release_milestone_approved_unq")
      .on(table.milestoneId)
      .where(sql`status = 'approved'`),
    check("escrow_release_amount_ck", sql`amount_in_cents > 0`),
    check("escrow_release_currency_ck", sql`currency ~ '^[A-Z]{3}$'`),
    // FOUR EYES, AT THE COLUMN LEVEL. The service returns 422 SELF_APPROVAL_FORBIDDEN
    // first; this is what holds if anyone ever writes the row another way.
    check(
      "escrow_release_four_eyes_ck",
      sql`decided_by_user_id IS NULL OR decided_by_user_id <> requested_by_user_id`,
    ),
    check(
      "escrow_release_decision_ck",
      sql`(status IN ('approved','rejected'))
          = (decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL
             AND verification_snapshot IS NOT NULL)`,
    ),
    // An approval that posted no journal entry moved no money while claiming to.
    check("escrow_release_journal_ck", sql`(status = 'approved') = (journal_entry_id IS NOT NULL)`),
  ],
);

/**
 * The nightly provider-versus-ledger comparison (§7 reconciliation).
 *
 * WHEN THE TWO DISAGREE, THE LEDGER IS NOT SILENTLY PATCHED. The job writes a row here,
 * posts the delta into `reconciliation_suspense` (preserving the zero-sum invariant), and
 * alarms. The provider is authoritative for CASH; the ledger is authoritative for
 * ENTITLEMENT; this account is where the two are allowed to differ, in public.
 *
 * HONEST CAVEAT (Appendix A3): until an adapter that actually moves cash exists there is
 * no external source of truth to reconcile against, so the discrepancy count is trivially
 * zero. Do not read that as evidence the books are right.
 */
export const reconciliationDiscrepancy = pgTable(
  "reconciliation_discrepancy",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    accountKind: escrowAccountKindEnum("account_kind").notNull(),
    /** The job's quantized reference instant (§4c rule 3). Stored, never re-read. */
    asOf: timestamp("as_of").notNull(),
    ledgerBalanceInCents: bigint("ledger_balance_in_cents", { mode: "bigint" }).notNull(),
    providerBalanceInCents: bigint("provider_balance_in_cents", { mode: "bigint" }).notNull(),
    deltaInCents: bigint("delta_in_cents", { mode: "bigint" }).notNull(),
    status: reconciliationDiscrepancyStatusEnum("status").default("open").notNull(),
    journalEntryId: text("journal_entry_id").references(() => escrowJournalEntry.id, {
      onDelete: "restrict",
    }),
    resolutionNote: text("resolution_note"),
    resolvedAt: timestamp("resolved_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    // Idempotent by construction: re-running the job for the same asOf writes nothing
    // new, which is §4e's "a job that cannot be safely re-run is a bug".
    uniqueIndex("reconciliation_discrepancy_project_account_asOf_unq").on(
      table.projectId,
      table.accountKind,
      table.asOf,
    ),
    index("reconciliation_discrepancy_status_idx").on(table.status, table.asOf),
    check(
      "reconciliation_discrepancy_delta_ck",
      sql`delta_in_cents = provider_balance_in_cents - ledger_balance_in_cents`,
    ),
    check("reconciliation_discrepancy_resolved_ck", sql`(status = 'open') = (resolved_at IS NULL)`),
  ],
);

/**
 * The deal-flow signal, computed nightly and returned WITH ITS `asOf` (§7).
 *
 * Replaces the frontend's hardcoded `INVESTOR_CONFIDENCE_PERCENT = 78`. Every input is
 * stored beside the output so a reader can see what produced the number rather than
 * trusting it, and the window is stored as ABSOLUTE BOUNDS rather than a day count
 * (§4c rule 3) — a row that records "30 days" is unreadable a year later.
 */
export const investorConfidenceSnapshot = pgTable(
  "investor_confidence_snapshot",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    asOf: timestamp("as_of").notNull(),
    windowStartsAt: timestamp("window_starts_at").notNull(),
    windowEndsAt: timestamp("window_ends_at").notNull(),
    /** 0–10000. Basis points, never a float percent (§4b). */
    confidenceBasisPoints: integer("confidence_basis_points").notNull(),
    trend: trendDirectionEnum("trend").default("flat").notNull(),
    // --- The inputs, stored so the output is inspectable rather than asserted.
    dailyLogStreakDays: integer("daily_log_streak_days").default(0).notNull(),
    verifiedMilestoneCount: integer("verified_milestone_count").default(0).notNull(),
    totalMilestoneCount: integer("total_milestone_count").default(0).notNull(),
    openDisputeCount: integer("open_dispute_count").default(0).notNull(),
    resolvedDisputeCount: integer("resolved_dispute_count").default(0).notNull(),
    computedAt: timestamp("computed_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("investor_confidence_snapshot_project_asOf_unq").on(table.projectId, table.asOf),
    index("investor_confidence_snapshot_projectId_asOf_idx").on(
      table.projectId,
      table.asOf,
      table.id,
    ),
    check(
      "investor_confidence_snapshot_basis_points_ck",
      sql`confidence_basis_points BETWEEN 0 AND 10000`,
    ),
    check(
      "investor_confidence_snapshot_counts_ck",
      sql`daily_log_streak_days >= 0 AND verified_milestone_count >= 0
          AND total_milestone_count >= verified_milestone_count
          AND open_dispute_count >= 0 AND resolved_dispute_count >= 0`,
    ),
    check("investor_confidence_snapshot_window_ck", sql`window_ends_at > window_starts_at`),
  ],
);

// --- §7 relations. Child-side only, same convention as §5, §6, §8 and §9.

export const fundingRoundRelations = relations(fundingRound, ({ one, many }) => ({
  project: one(researchProject, {
    fields: [fundingRound.projectId],
    references: [researchProject.id],
  }),
  createdBy: one(user, { fields: [fundingRound.createdByUserId], references: [user.id] }),
  pledges: many(fundingRoundPledge),
}));

export const fundingRoundPledgeRelations = relations(fundingRoundPledge, ({ one }) => ({
  round: one(fundingRound, {
    fields: [fundingRoundPledge.roundId],
    references: [fundingRound.id],
  }),
  project: one(researchProject, {
    fields: [fundingRoundPledge.projectId],
    references: [researchProject.id],
  }),
  backer: one(user, { fields: [fundingRoundPledge.backerUserId], references: [user.id] }),
  transfer: one(providerTransfer, {
    fields: [fundingRoundPledge.providerTransferId],
    references: [providerTransfer.id],
  }),
}));

export const escrowAccountRelations = relations(escrowAccount, ({ one, many }) => ({
  project: one(researchProject, {
    fields: [escrowAccount.projectId],
    references: [researchProject.id],
  }),
  postings: many(escrowPosting),
}));

export const escrowJournalEntryRelations = relations(escrowJournalEntry, ({ one, many }) => ({
  project: one(researchProject, {
    fields: [escrowJournalEntry.projectId],
    references: [researchProject.id],
  }),
  createdBy: one(user, { fields: [escrowJournalEntry.createdByUserId], references: [user.id] }),
  postings: many(escrowPosting),
}));

export const escrowPostingRelations = relations(escrowPosting, ({ one }) => ({
  entry: one(escrowJournalEntry, {
    fields: [escrowPosting.journalEntryId],
    references: [escrowJournalEntry.id],
  }),
  account: one(escrowAccount, {
    fields: [escrowPosting.accountId],
    references: [escrowAccount.id],
  }),
}));

export const providerTransferRelations = relations(providerTransfer, ({ one, many }) => ({
  project: one(researchProject, {
    fields: [providerTransfer.projectId],
    references: [researchProject.id],
  }),
  settlementDecidedBy: one(user, {
    fields: [providerTransfer.settlementDecidedByUserId],
    references: [user.id],
  }),
  webhookEvents: many(providerWebhookEvent),
}));

export const providerWebhookEventRelations = relations(providerWebhookEvent, ({ one }) => ({
  transfer: one(providerTransfer, {
    fields: [providerWebhookEvent.providerTransferId],
    references: [providerTransfer.id],
  }),
  project: one(researchProject, {
    fields: [providerWebhookEvent.projectId],
    references: [researchProject.id],
  }),
}));

export const milestoneRelations = relations(milestone, ({ one, many }) => ({
  project: one(researchProject, {
    fields: [milestone.projectId],
    references: [researchProject.id],
  }),
  createdBy: one(user, { fields: [milestone.createdByUserId], references: [user.id] }),
  variance: one(milestoneVariance, {
    fields: [milestone.id],
    references: [milestoneVariance.milestoneId],
  }),
  releases: many(escrowRelease),
}));

export const milestoneVarianceRelations = relations(milestoneVariance, ({ one }) => ({
  milestone: one(milestone, {
    fields: [milestoneVariance.milestoneId],
    references: [milestone.id],
  }),
}));

export const escrowReleaseRelations = relations(escrowRelease, ({ one }) => ({
  project: one(researchProject, {
    fields: [escrowRelease.projectId],
    references: [researchProject.id],
  }),
  milestone: one(milestone, {
    fields: [escrowRelease.milestoneId],
    references: [milestone.id],
  }),
  // relationName because this table has TWO relations to `user`; without it Drizzle
  // cannot tell them apart.
  requestedBy: one(user, {
    fields: [escrowRelease.requestedByUserId],
    references: [user.id],
    relationName: "escrowReleaseRequestedBy",
  }),
  decidedBy: one(user, {
    fields: [escrowRelease.decidedByUserId],
    references: [user.id],
    relationName: "escrowReleaseDecidedBy",
  }),
  journalEntry: one(escrowJournalEntry, {
    fields: [escrowRelease.journalEntryId],
    references: [escrowJournalEntry.id],
  }),
}));

export const reconciliationDiscrepancyRelations = relations(
  reconciliationDiscrepancy,
  ({ one }) => ({
    project: one(researchProject, {
      fields: [reconciliationDiscrepancy.projectId],
      references: [researchProject.id],
    }),
    journalEntry: one(escrowJournalEntry, {
      fields: [reconciliationDiscrepancy.journalEntryId],
      references: [escrowJournalEntry.id],
    }),
  }),
);

export const investorConfidenceSnapshotRelations = relations(
  investorConfidenceSnapshot,
  ({ one }) => ({
    project: one(researchProject, {
      fields: [investorConfidenceSnapshot.projectId],
      references: [researchProject.id],
    }),
  }),
);

// ---------------------------------------------------------------------------
// §7A — COMPENSATION PERIODS AND PAYOUT STATEMENTS.
// See docs/R_AND_D_BACKEND_STRUCTURE.md §7A.
//
// THE PRODUCT FOUNDERS ACTUALLY ASKED FOR: "tell me what I owe each person this
// month." Not a payment rail — a number, with its working shown, that a founder
// can act on and an employee can trust.
//
// QATOTO HOLDS NO FUNDS AND CHARGES NOBODY. Nothing below is a balance, a pool,
// a payout rail or a card number. The tables compute an obligation and record an
// attestation that it was settled between the parties' own accounts. That is
// bookkeeping software, and it is the reason none of PSD2, US state
// money-transmitter law or RBI payment-aggregator authorisation attaches (§7A.6
// item 1).
//
// THREE RULES GOVERN EVERY TABLE HERE, and each has a statute behind it:
//
//  1. CASH IS NEVER GATED ON A VERDICT (§0). `verification_note` is the ONLY
//     place a Proof-of-Effort verdict may touch a cash line, and it changes no
//     number. Conditioning earned wages on an algorithm passing is unlawful
//     withholding under the FLSA and state timely-payment law in the US, under
//     national wage statutes across the EU, and under §18 of India's Code on
//     Wages 2019, whose list of permitted deductions is exhaustive. §9 withholds
//     SLICES; it does not withhold wages.
//  2. NO AMOUNT IS EVER IN A REQUEST BODY. A line is computed from an accepted
//     agreement and the member's own recorded minutes. The only number a client
//     may send is `paid_amount_in_cents` on a payment record — and that is an
//     attestation about the outside world, not an assertion about what is owed.
//  3. GROSS ONLY. No withholding, no tax, no social contribution. Qatoto is not
//     a payroll processor and every statement surface must say so (§7A.6 item 3).
// ---------------------------------------------------------------------------

/**
 * What a member is paid in CASH, and on what basis (§7A.2).
 *
 * MIRRORS `member_fair_market_rate` (§9) EXACTLY — effective-dated, member-accepted,
 * trigger-frozen — because it is the same kind of object and a second shape would be a
 * second source of truth for "what is this person paid".
 *
 * THE ACCEPTANCE STEP IS NOT CEREMONY. A founder proposes; the member accepts; only then
 * does the row become `active` and only then does it price anything. `qatoto_cash_agreement_accept_only`
 * (migration 0017) freezes the amounts, the currency and the effective date at acceptance,
 * copying 0014's `qatoto_fair_market_rate_lock_only`. A founder who can silently edit an
 * accepted rate can silently rewrite what someone is owed, which is the founder-fiat
 * failure mode PROOF_OF_EFFORT_SPEC.md §2 exists to eliminate.
 *
 * THIS IS NOT `member_fair_market_rate.paidCashRateCentsPerHour`, AND THE DIFFERENCE
 * MATTERS. That column exists so the slice math can price the UNPAID portion of an hour
 * (`fairMarketRate − paidCash`, src/modules/rnd/slice-math.ts). This table is what the member is
 * actually OWED. They are usually the same number and must still be two columns: one is an
 * input to an equity formula, the other is an obligation. When an hourly agreement is
 * accepted the two are validated equal and a mismatch is a `422`, so the pie and the
 * payslip cannot disagree.
 */
export const memberCashCompensationAgreement = pgTable(
  "member_cash_compensation_agreement",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    // `restrict` on both, per §4f. This row is the basis for what someone was paid, and a
    // deleted user must not be able to erase the evidence a wage was owed.
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    memberId: text("member_id")
      .notNull()
      .references(() => projectMember.id, { onDelete: "restrict" }),
    // FOUNDER-DECLARED, never inferred (§4d). Qatoto does not classify employment.
    engagementKind: engagementKindEnum("engagement_kind").notNull(),
    // Exactly one of these two is non-null — `..._basis_ck` enforces it. A retainer is a
    // flat monthly amount; an hourly agreement prices verified minutes. `bigint` because
    // it is money (§4b).
    monthlyAmountInCents: bigint("monthly_amount_in_cents", { mode: "bigint" }),
    hourlyRateCentsPerHour: bigint("hourly_rate_cents_per_hour", { mode: "bigint" }),
    // Derived from the project, never from a request body (§4b). A client-chosen currency
    // would let a $6,000 retainer be re-read as ¥6,000.
    currencyCode: text("currency_code").notNull(),
    status: compensationAgreementStatusEnum("status").default("proposed").notNull(),
    // Absolute instants, never day counts (§4c rule 3). `effectiveUntil` NULL = in force.
    effectiveFrom: timestamp("effective_from").notNull(),
    effectiveUntil: timestamp("effective_until"),
    // Why this number. Required, for the same reason §9's rate requires one: an amount
    // with no stated basis is founder fiat with extra steps.
    rationaleNote: text("rationale_note").notNull(),
    proposedByUserId: text("proposed_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    acceptedAt: timestamp("accepted_at"),
    acceptedByUserId: text("accepted_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    // "Which agreement was in force for this member at this instant?" Ends in a unique
    // column so two rows sharing an instant cannot swap places between reads (§4c rule 4).
    index("member_cash_comp_agreement_memberId_effectiveFrom_idx").on(
      table.memberId,
      table.effectiveFrom,
      table.id,
    ),
    index("member_cash_comp_agreement_projectId_idx").on(table.projectId, table.id),
    // One agreement per member per effective instant. Two rows claiming the same instant
    // make "what is this person paid" ambiguous in the one place ambiguity is
    // unacceptable.
    uniqueIndex("member_cash_comp_agreement_memberId_effectiveFrom_unq").on(
      table.memberId,
      table.effectiveFrom,
    ),
    // At most one ACTIVE agreement per member, ever.
    uniqueIndex("member_cash_comp_agreement_active_unq")
      .on(table.memberId)
      .where(sql`status = 'active'`),
    check(
      "member_cash_comp_agreement_basis_ck",
      sql`(monthly_amount_in_cents IS NOT NULL) <> (hourly_rate_cents_per_hour IS NOT NULL)`,
    ),
    check(
      "member_cash_comp_agreement_amount_ck",
      sql`(monthly_amount_in_cents IS NULL OR monthly_amount_in_cents >= 0)
          AND (hourly_rate_cents_per_hour IS NULL OR hourly_rate_cents_per_hour >= 0)`,
    ),
    check("member_cash_comp_agreement_currency_ck", sql`currency_code ~ '^[A-Z]{3}$'`),
    check(
      "member_cash_comp_agreement_rationale_ck",
      sql`char_length(rationale_note) BETWEEN 1 AND 1000`,
    ),
    check(
      "member_cash_comp_agreement_window_ck",
      sql`effective_until IS NULL OR effective_until > effective_from`,
    ),
    // The lifecycle cannot be half-true: an agreement that prices anything names who
    // accepted it and when. `withdrawn` is a proposal nobody accepted, so it stays
    // unaccepted; `superseded` was accepted once and keeps that record.
    check(
      "member_cash_comp_agreement_lifecycle_ck",
      sql`(status <> 'proposed' OR accepted_at IS NULL)
          AND (status <> 'withdrawn' OR accepted_at IS NULL)
          AND (status NOT IN ('active','superseded') OR accepted_at IS NOT NULL)
          AND (accepted_at IS NULL) = (accepted_by_user_id IS NULL)`,
    ),
  ],
);

/**
 * One calendar month of compensation, IN THE PROJECT'S OWN TIME ZONE (§7A.3).
 *
 * WHY THE ZONE IS ON THE ROW rather than read live from `project_stats.projectTimeZone`:
 * a later zone change must not silently re-slice a month that has already been finalized
 * and signed. It is snapshotted at open, exactly as `equity_snapshot` snapshots the ledger
 * prefix it covers.
 *
 * AN OPEN PERIOD ACCRUES — redrawn nightly, nothing frozen, numbers may move.
 * A FINALIZED PERIOD IS FROZEN — hash-chained, two people signed it, it never changes.
 *
 * CORRECTIONS SUPERSEDE; THEY NEVER EDIT. A finalized period whose numbers turn out wrong
 * is not reopened — a new period is created with `supersededByPeriodId` pointing back, the
 * audit chain records both, and the member can see exactly what changed and when. A record
 * that can be quietly rewritten is not evidence of anything (§4f).
 */
export const compensationPeriod = pgTable(
  "compensation_period",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    // Gapless per project from 1, allocated under the EXISTING project_chain_head lock —
    // never a second lock (§9.9's note applies verbatim).
    sequenceNumber: integer("sequence_number").notNull(),
    // Calendar days, half-open `[start, end)`. Day-only because a month boundary is a
    // calendar fact in a named zone, not an instant.
    periodStartDate: date("period_start_date").notNull(),
    periodEndDate: date("period_end_date").notNull(),
    // Snapshotted from project_stats at open. See the note above.
    timeZone: text("time_zone").notNull(),
    status: compensationPeriodStatusEnum("status").default("open").notNull(),
    // The QUANTIZED reference instant of the last draft redraw (§4c rule 3). Returned on
    // an open period so no client can imply a frozen number.
    lastDraftedAt: timestamp("last_drafted_at"),
    finalizedAt: timestamp("finalized_at"),
    finalizedByUserId: text("finalized_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    // THE SECOND PAIR OF EYES (§4a). Must differ from `finalizedByUserId`, and the check
    // below makes that structural rather than conventional — a founder cannot ratify their
    // own statement.
    countersignedAt: timestamp("countersigned_at"),
    countersignedByUserId: text("countersigned_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    countersignNote: text("countersign_note"),
    // Full 64 lowercase hex, always. The 6-character form a UI shows is a RENDERING: at
    // 24 bits collisions hit 50% around 4,800 entries (§4c).
    statementHash: text("statement_hash"),
    // The predecessor's hash, or the literal "genesis" for a project's first finalized
    // period — so it is never NULL on a finalized row and the chain has one shape.
    previousStatementHash: text("previous_statement_hash"),
    // So the algorithm can evolve without invalidating history (§4c).
    hashVersion: text("hash_version"),
    // A correction creates a NEW period that supersedes this one. Nothing is ever edited.
    supersededByPeriodId: text("superseded_by_period_id").references(
      (): AnyPgColumn => compensationPeriod.id,
      { onDelete: "restrict" },
    ),
    supersedeReasonNote: text("supersede_reason_note"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("compensation_period_projectId_sequence_unq").on(
      table.projectId,
      table.sequenceNumber,
    ),
    // ONE open period per project PER MONTH. Deliberately not one per project: §7A.5's
    // close job stops a period accruing WITHOUT freezing it, so a founder who has not
    // finalized March yet must still be able to accrue April. Both are `open` at once,
    // and that is the lifecycle working rather than a leak.
    //
    // Scoped to `open` so a supersede can create a second period over the SAME window —
    // the predecessor is `superseded` by then, so only the replacement is open.
    uniqueIndex("compensation_period_projectId_start_open_unq")
      .on(table.projectId, table.periodStartDate)
      .where(sql`status = 'open'`),
    // The list read, ordered newest first and ending in a unique column (§4c rule 4).
    index("compensation_period_projectId_start_idx").on(
      table.projectId,
      table.periodStartDate,
      table.id,
    ),
    check("compensation_period_sequence_ck", sql`sequence_number >= 1`),
    check("compensation_period_window_ck", sql`period_end_date > period_start_date`),
    // A finalized period carries a complete, well-formed chain link; a period that is not
    // finalized carries none of it. Half a hash is worse than no hash.
    check(
      "compensation_period_finalize_ck",
      sql`(status = 'finalized' OR status = 'superseded')
            = (statement_hash IS NOT NULL)
          AND (statement_hash IS NULL)
            = (finalized_at IS NULL AND finalized_by_user_id IS NULL
               AND previous_statement_hash IS NULL AND hash_version IS NULL)
          AND (finalized_at IS NULL) = (finalized_by_user_id IS NULL)
          AND (statement_hash IS NULL OR statement_hash ~ '^[0-9a-f]{64}$')
          AND (previous_statement_hash IS NULL
               OR previous_statement_hash = 'genesis'
               OR previous_statement_hash ~ '^[0-9a-f]{64}$')`,
    ),
    // FOUR EYES, AT THE COLUMN LEVEL. `IS DISTINCT FROM` rather than `<>` so a NULL
    // finalizer cannot make the comparison NULL and let the row through.
    check(
      "compensation_period_countersign_ck",
      sql`(countersigned_at IS NULL) = (countersigned_by_user_id IS NULL)
          AND (countersigned_at IS NULL OR finalized_at IS NOT NULL)
          AND (countersigned_by_user_id IS NULL
               OR countersigned_by_user_id IS DISTINCT FROM finalized_by_user_id)`,
    ),
    // A superseded period names its successor and says why; nothing else may.
    check(
      "compensation_period_supersede_ck",
      sql`(status = 'superseded') = (superseded_by_period_id IS NOT NULL)
          AND (superseded_by_period_id IS NULL OR superseded_by_period_id <> id)
          AND (superseded_by_period_id IS NULL) = (supersede_reason_note IS NULL)`,
    ),
  ],
);

/**
 * One line per member per kind per period (§7A.3).
 *
 * RE-RUNNING THE NIGHTLY DRAFT MUST BE A NO-OP, NOT A DUPLICATE — hence the
 * `(periodId, memberId, kind)` unique, the same shape as `slice_ledger_entry`'s
 * per-proposal-per-kind uniqueness (§9.6). §17 step 5b runs the draft 100 times with rows
 * shuffled and asserts byte-identical output; that is the test, not an aspiration.
 *
 * EQUITY IS NOT MONEY AND MUST NEVER BE SUMMED WITH IT. A cash line carries
 * `grossAmountInCents` and no basis points; an `equity_delta` line carries basis points
 * and no money. `..._kind_ck` encodes that rather than leaving it to a comment.
 *
 * `equityBasisPointsDelta` IS SIGNED, and a negative value is the model working rather
 * than a bug: a member's share falls when others out-contribute them over the period.
 *
 * `verificationNote` IS THE ONLY PLACE A VERDICT MAY TOUCH A CASH LINE, AND IT CHANGES NO
 * NUMBER (§0). There is no verification status column here, and no query that produces
 * `grossAmountInCents` filters on one.
 */
export const compensationPeriodLine = pgTable(
  "compensation_period_line",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    periodId: text("period_id")
      .notNull()
      .references(() => compensationPeriod.id, { onDelete: "restrict" }),
    // Denormalized so a line can be authorized and listed without joining the period.
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    memberId: text("member_id")
      .notNull()
      .references(() => projectMember.id, { onDelete: "restrict" }),
    kind: compensationPeriodLineKindEnum("kind").notNull(),
    // `bigint` because it is money (§4b). NULL on an `equity_delta` line.
    grossAmountInCents: bigint("gross_amount_in_cents", { mode: "bigint" }),
    // Always beside the amount (§4b). NULL on an equity line, which has no currency.
    currency: text("currency"),
    // Integer minutes, on `cash_hourly` only (§4b).
    effortMinutes: integer("effort_minutes"),
    // The EXACT rows the number came from, denormalized so an auditor need not re-resolve
    // effective dating years later. `restrict`, and the agreement's no-DELETE trigger
    // backs it up for the case where no line references it yet.
    sourceAgreementId: text("source_agreement_id").references(
      () => memberCashCompensationAgreement.id,
      { onDelete: "restrict" },
    ),
    sourceRateId: text("source_rate_id").references(() => memberFairMarketRate.id, {
      onDelete: "restrict",
    }),
    // On `equity_delta` only. `Delta` is SIGNED — see the note above.
    equityBasisPointsAtStart: integer("equity_basis_points_at_start"),
    equityBasisPointsAtEnd: integer("equity_basis_points_at_end"),
    equityBasisPointsDelta: integer("equity_basis_points_delta"),
    // The snapshots the two endpoints were read from, so the subtraction is reproducible.
    startSnapshotId: text("start_snapshot_id").references(() => equitySnapshot.id, {
      onDelete: "restrict",
    }),
    endSnapshotId: text("end_snapshot_id").references(() => equitySnapshot.id, {
      onDelete: "restrict",
    }),
    // Free text, nullable. THE ONLY PLACE A VERDICT MAY TOUCH A CASH LINE (§0).
    verificationNote: text("verification_note"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("compensation_period_line_period_member_kind_unq").on(
      table.periodId,
      table.memberId,
      table.kind,
    ),
    // "What have I been owed across every period?" Ends in a unique column (§4c rule 4).
    index("compensation_period_line_memberId_idx").on(table.memberId, table.id),
    index("compensation_period_line_projectId_idx").on(table.projectId, table.id),
    // An equity line carries basis points and no money; a cash line carries money and no
    // basis points. Encoded here rather than in a comment.
    check(
      "compensation_period_line_kind_ck",
      sql`(kind = 'equity_delta')
          = (gross_amount_in_cents IS NULL AND equity_basis_points_delta IS NOT NULL)`,
    ),
    // A period cannot owe NEGATIVE wages. An over-payment is corrected by superseding the
    // period, never by a negative line (§7A.4).
    check(
      "compensation_period_line_amount_ck",
      sql`(gross_amount_in_cents IS NULL OR gross_amount_in_cents >= 0)
          AND (gross_amount_in_cents IS NULL) = (currency IS NULL)
          AND (currency IS NULL OR currency ~ '^[A-Z]{3}$')`,
    ),
    // Minutes belong to an hourly line and nowhere else, and they are never negative:
    // the reversal-inclusive sum is clamped at zero in TypeScript before it lands here.
    check(
      "compensation_period_line_minutes_ck",
      sql`(effort_minutes IS NOT NULL) = (kind = 'cash_hourly')
          AND (effort_minutes IS NULL OR effort_minutes >= 0)`,
    ),
    // The three equity columns move together, each within range, and the delta IS the
    // subtraction — so a transcription error in either endpoint fails loudly here rather
    // than reading as a legitimate swing.
    check(
      "compensation_period_line_equity_ck",
      sql`(equity_basis_points_delta IS NULL)
            = (equity_basis_points_at_start IS NULL AND equity_basis_points_at_end IS NULL)
          AND (equity_basis_points_at_start IS NULL
               OR equity_basis_points_at_start BETWEEN 0 AND 10000)
          AND (equity_basis_points_at_end IS NULL
               OR equity_basis_points_at_end BETWEEN 0 AND 10000)
          AND (equity_basis_points_delta IS NULL
               OR equity_basis_points_delta
                  = equity_basis_points_at_end - equity_basis_points_at_start)`,
    ),
  ],
);

/**
 * A payment the parties made BETWEEN THEMSELVES, recorded here (§7A's
 * `compensation_payment_record`).
 *
 * RECORDING A PAYMENT DOES NOT MOVE MONEY AND DOES NOT CHANGE THE LINE. The founder pays
 * from their own bank or payroll provider; this is the receipt. Append-only, with exactly
 * one permitted later write: the member's confirmation.
 *
 * TWO-SIDED CONFIRMATION IS WHAT MAKES THIS EVIDENCE RATHER THAN BOOKKEEPING. A founder
 * recording "paid" is an assertion. A member confirming receipt is corroboration. The
 * pair, hash-chained against a frozen statement line, is the artifact that answers "was
 * this person paid what they were owed, and when" — which is the question a labour
 * inspector, an acquirer's diligence team, or an aggrieved ex-employee actually asks. THE
 * UI MUST SHOW UNCONFIRMED PAYMENTS AS UNCONFIRMED AND NEVER AS PAID.
 *
 * IT STORES NO ACCOUNT NUMBER, NO IBAN, NO UPI HANDLE, NO CARD DETAIL AND NO PAYMENT
 * INSTRUMENT OF ANY KIND. `referenceNote` is a human note — a UTR, a payroll run id — and
 * the API rejects anything that pattern-matches a PAN. Storing payment instruments would
 * drag PCI-DSS scope into a product that has no business being in it, create a PII breach
 * surface with no upside, and hand an attacker a wire-fraud primitive.
 *
 * There is deliberately NO `updatedAt`: there is nothing to update.
 */
export const compensationPaymentRecord = pgTable(
  "compensation_payment_record",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    lineId: text("line_id")
      .notNull()
      .references(() => compensationPeriodLine.id, { onDelete: "restrict" }),
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    // `bigint` because it is money (§4b). THE ONE NUMBER A CLIENT MAY SEND in this whole
    // domain — and it is an attestation about the outside world, not an assertion about
    // what is owed. It may differ from the line: a partial payment is a fact, not an error.
    paidAmountInCents: bigint("paid_amount_in_cents", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    // The calendar day the payer says the money left. Day-only: a bank does not publish an
    // instant, and inventing one would be precision the record does not have.
    paidOnDate: date("paid_on_date").notNull(),
    methodKey: compensationPaymentMethodKeyEnum("method_key").notNull(),
    // A human note. NEVER an instrument — see the header.
    referenceNote: text("reference_note"),
    recordedByUserId: text("recorded_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    // THE MEMBER'S half of the evidence. Set once, never cleared (trigger, migration 0017).
    confirmedByMemberAt: timestamp("confirmed_by_member_at"),
    confirmedByUserId: text("confirmed_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    // Client-supplied, per-line. A retried POST must not record the same payment twice —
    // "did I already tell it I paid this?" is exactly the question a flaky network makes
    // unanswerable.
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("compensation_payment_record_line_idempotency_unq").on(
      table.lineId,
      table.idempotencyKey,
    ),
    index("compensation_payment_record_lineId_idx").on(table.lineId, table.id),
    index("compensation_payment_record_projectId_idx").on(table.projectId, table.id),
    check("compensation_payment_record_amount_ck", sql`paid_amount_in_cents > 0`),
    check("compensation_payment_record_currency_ck", sql`currency ~ '^[A-Z]{3}$'`),
    check(
      "compensation_payment_record_confirm_ck",
      sql`(confirmed_by_member_at IS NULL) = (confirmed_by_user_id IS NULL)`,
    ),
    check(
      "compensation_payment_record_note_ck",
      sql`reference_note IS NULL OR char_length(reference_note) BETWEEN 1 AND 500`,
    ),
    check(
      "compensation_payment_record_idempotency_ck",
      sql`char_length(idempotency_key) BETWEEN 8 AND 200`,
    ),
  ],
);

// --- §7A relations. Child-side only, same convention as §5, §6, §7, §8 and §9.

export const memberCashCompensationAgreementRelations = relations(
  memberCashCompensationAgreement,
  ({ one }) => ({
    project: one(researchProject, {
      fields: [memberCashCompensationAgreement.projectId],
      references: [researchProject.id],
    }),
    member: one(projectMember, {
      fields: [memberCashCompensationAgreement.memberId],
      references: [projectMember.id],
    }),
    // relationName because this table has TWO relations to `user`; without it Drizzle
    // cannot tell them apart.
    proposedBy: one(user, {
      fields: [memberCashCompensationAgreement.proposedByUserId],
      references: [user.id],
      relationName: "cashCompensationAgreementProposedBy",
    }),
    acceptedBy: one(user, {
      fields: [memberCashCompensationAgreement.acceptedByUserId],
      references: [user.id],
      relationName: "cashCompensationAgreementAcceptedBy",
    }),
  }),
);

export const compensationPeriodRelations = relations(compensationPeriod, ({ one, many }) => ({
  project: one(researchProject, {
    fields: [compensationPeriod.projectId],
    references: [researchProject.id],
  }),
  finalizedBy: one(user, {
    fields: [compensationPeriod.finalizedByUserId],
    references: [user.id],
    relationName: "compensationPeriodFinalizedBy",
  }),
  countersignedBy: one(user, {
    fields: [compensationPeriod.countersignedByUserId],
    references: [user.id],
    relationName: "compensationPeriodCountersignedBy",
  }),
  lines: many(compensationPeriodLine),
}));

export const compensationPeriodLineRelations = relations(
  compensationPeriodLine,
  ({ one, many }) => ({
    period: one(compensationPeriod, {
      fields: [compensationPeriodLine.periodId],
      references: [compensationPeriod.id],
    }),
    member: one(projectMember, {
      fields: [compensationPeriodLine.memberId],
      references: [projectMember.id],
    }),
    sourceAgreement: one(memberCashCompensationAgreement, {
      fields: [compensationPeriodLine.sourceAgreementId],
      references: [memberCashCompensationAgreement.id],
    }),
    sourceRate: one(memberFairMarketRate, {
      fields: [compensationPeriodLine.sourceRateId],
      references: [memberFairMarketRate.id],
    }),
    payments: many(compensationPaymentRecord),
  }),
);

export const compensationPaymentRecordRelations = relations(
  compensationPaymentRecord,
  ({ one }) => ({
    line: one(compensationPeriodLine, {
      fields: [compensationPaymentRecord.lineId],
      references: [compensationPeriodLine.id],
    }),
    recordedBy: one(user, {
      fields: [compensationPaymentRecord.recordedByUserId],
      references: [user.id],
      relationName: "compensationPaymentRecordedBy",
    }),
    confirmedBy: one(user, {
      fields: [compensationPaymentRecord.confirmedByUserId],
      references: [user.id],
      relationName: "compensationPaymentConfirmedBy",
    }),
  }),
);

// ===========================================================================
// §10 — RESEARCH PROGRAMS. See R_AND_D_BACKEND_STRUCTURE.md §10 and §11f.
//
// A PROGRAM IS NOT A PROJECT, and this is the whole reason for a separate set of
// tables rather than a `kind` flag on `research_project` (§10 states the
// recommendation; these tables are it). They share almost nothing structurally:
//
//   research_project   one founder, a closed team, a funding round, milestones,
//                      monthly compensation statements, and a Slicing Pie ledger
//                      over verified daily logs. Equity is the point.
//   research_program   thousands of open contributors, a branch TREE, a public
//                      paper library, public threaded discussion, and contribution
//                      tracking that is NOT equity at all.
//
// Folding them together would mean a dozen nullable columns and an authorization
// model that branches on kind at every call site. What they DO share is the
// contributor compensation vocabulary (`compensation_kind`, §4d) and the `user`
// table, and that is the correct amount of sharing.
//
// FIVE RULES THAT GOVERN EVERY TABLE BELOW:
//
//  1. THE TWO ANALYTICAL SIGNALS ARE DERIVED, NEVER SUBMITTED.
//     `research_program_branch.status` and `.overlapping_group_count` are computed
//     by `recompute-branch-signals` and appear in NO request body. `status =
//     'missing'` means "the crowd wants this answered and nobody is working on it";
//     `overlapping_group_count >= 2` means "several groups are duplicating work".
//     Those two claims are the intellectual core of this surface, and a contributor
//     who could mark their own branch `active`, or a rival's `missing`, would make
//     the entire map worthless. They are the §10 analogue of §9's rule that a
//     verdict is never a field.
//
//  2. A PROGRAM IS PUBLIC UGC, SO IT IS MODERATED, AND MODERATION LEAVES A TRACE.
//     Programs land `pending` and are invisible until a `moderate_content` holder
//     publishes them; papers land `queued`; posts can be hidden. Every one of those
//     decisions appends to the PLATFORM chain via `appendPlatformAuditEntry` in the
//     same transaction — the chain and its append helper already exist and three
//     other moderation services already call it, so §10 joins that convention
//     rather than inventing a private log.
//
//  3. CONTRIBUTION IS A RECORD, NOT A SETTLEMENT. `research_effort_log` and
//     `research_contribution_ledger_entry` record what someone says they put in.
//     No money moves, nothing is escrowed, and nothing here mints equity — escrow
//     left this codebase (§7) and Slicing Pie is project-scoped by construction.
//     Same posture as a funding pledge: a commitment, and the response must not
//     imply otherwise.
//
//  4. COUNTS ARE INTEGERS AND INSTANTS ARE TIMESTAMPS. There is no
//     `reaction_count_label` and no `posted_at_label`. "418" gains its thousands
//     separator and "4 hours ago" its relative phrasing in the client, per locale
//     (§1). The one place a count is denormalized — `reaction_count`, `reply_count`
//     — is maintained inside the transaction that inserts the child, never
//     recomputed on read, because a list page would otherwise be one COUNT(*) per
//     row.
//
//  5. LAYOUT IS NOT DATA. There is no `left_percent` / `top_percent`. The branch
//     tree stores `parent_branch_id` + `sibling_order` and the client runs a tidy
//     layout, so the graph renders at any viewport on any platform — the same
//     ruling §6 makes for `map_position`. `pinned_left_permille` /
//     `pinned_top_permille` survive as a curator override for the handful of nodes
//     a human wants placed deliberately, in integer per-mille, normally NULL.
// ===========================================================================

// --- Domain enums (§10). Same rule as everywhere else: these are Postgres labels,
// --- sent verbatim in both directions, so they are snake_case and a client that
// --- sends kebab-case gets a 422 rather than a silently ignored value.

/**
 * A program's lifecycle. `pending` is the DEFAULT and is absent from the create
 * schema — a user-minted program is a spam surface, so it is invisible on the public
 * index until reviewed. Exactly the posture `research_category` takes.
 */
export const researchProgramStatusEnum = pgEnum("research_program_status", [
  "pending",
  "published",
  "rejected",
  "archived",
]);

/**
 * A branch's derived state. WRITTEN ONLY BY `recompute-branch-signals` — see rule 1
 * above. `emerging` is the default because a freshly created branch has no claims and
 * no papers yet, and the job will move it on its next run.
 */
export const researchProgramBranchStatusEnum = pgEnum("research_program_branch_status", [
  "active",
  "emerging",
  "contested",
  "missing",
]);

/** The five ways to contribute to a program, mirroring the §4.2b lifecycle roles. */
export const researchProgramParticipantRoleEnum = pgEnum("research_program_participant_role", [
  "researcher",
  "founder_director",
  "venture_capitalist",
  "supplier",
  "supporter",
]);

/** The formal track's review verdict. `needs_changes` is a request, not a refusal. */
export const researchPaperModerationStatusEnum = pgEnum("research_paper_moderation_status", [
  "queued",
  "approved",
  "rejected",
  "needs_changes",
]);

/**
 * The two discussion tracks. `informal_paper` is the blog-style track (titled, no
 * citations expected); `idea` is the open netizen thread. Replies inherit their
 * parent's track — see `research_program_post`.
 */
export const researchProgramPostTrackEnum = pgEnum("research_program_post_track", [
  "informal_paper",
  "idea",
]);

/** Why a reader flagged something. A fixed list, so reports are countable. */
export const researchProgramReportReasonEnum = pgEnum("research_program_report_reason", [
  "spam",
  "plagiarism",
  "misinformation",
  "harassment",
  "off_topic",
  "other",
]);

export const researchProgramReportStatusEnum = pgEnum("research_program_report_status", [
  "open",
  "actioned",
  "dismissed",
]);

export const researchProgramContentTargetKindEnum = pgEnum("research_program_content_target_kind", [
  "paper",
  "post",
]);

/** What a moderator did. Mirrors the eight §10 members of `platform_audit_event_kind`. */
export const researchProgramModerationKindEnum = pgEnum("research_program_moderation_kind", [
  "program_published",
  "program_rejected",
  "paper_approved",
  "paper_rejected",
  "paper_needs_changes",
  "post_hidden",
  "post_restored",
  "report_dismissed",
]);

/**
 * What a participant contributed, beyond logged time. `cash_commitment` is the only
 * member that carries an amount, and it is a COMMITMENT — see rule 3.
 */
export const researchContributionKindEnum = pgEnum("research_contribution_kind", [
  "cash_commitment",
  "material",
  "data",
  "equipment",
  "expertise",
]);

/**
 * The program itself. Project Immortal is one row, seeded `published`; every other
 * row arrives from `POST /research-programs` at `pending`.
 *
 * `slug` AUTO-SUFFIXES (`-2`, `-3`) rather than colliding, matching
 * `research_project.slug` and deliberately UNLIKE `research_category.slug`: two
 * programs may legitimately be named similarly, whereas two taxonomy nodes may not.
 */
export const researchProgram = pgTable(
  "research_program",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    tagline: text("tagline").notNull(),
    missionStatement: text("mission_statement").notNull(),
    // SERVER-OWNED. Absent from every create and update schema; `.strict()` turns an
    // attempt to self-publish into a 422 rather than letting one key bypass review.
    status: researchProgramStatusEnum("status").default("pending").notNull(),
    // `set null`, never cascade (§4f): deleting the person who proposed a program must
    // not delete a program thousands of people now contribute to.
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    /** NULL until a moderator publishes. Set in the same statement as `status`. */
    publishedAt: timestamp("published_at"),
    // The review decision. `restrict` on the reviewer — who decided is accountability,
    // and it must not vanish with an account.
    reviewedByUserId: text("reviewed_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    reviewedAt: timestamp("reviewed_at"),
    reviewerNote: text("reviewer_note"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("research_program_slug_unq").on(table.slug),
    // The public index: published rows newest first, ending in a unique column (§4c
    // rule 4) so a page boundary neither duplicates nor skips.
    index("research_program_status_createdAt_idx").on(table.status, table.createdAt, table.id),
    index("research_program_createdByUserId_idx").on(table.createdByUserId, table.id),
    check(
      "research_program_slug_ck",
      sql`slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) BETWEEN 3 AND 80`,
    ),
    check(
      "research_program_text_ck",
      sql`char_length(title) BETWEEN 3 AND 120
          AND char_length(tagline) BETWEEN 3 AND 200
          AND char_length(mission_statement) BETWEEN 20 AND 4000
          AND (reviewer_note IS NULL OR char_length(reviewer_note) BETWEEN 1 AND 2000)`,
    ),
    // A published row has a publish time; an unpublished one does not. The two cannot
    // drift apart, so no reader has to decide which one to trust.
    check(
      "research_program_published_ck",
      sql`(status = 'published') = (published_at IS NOT NULL)`,
    ),
    // A decision has a decider and a time, or none of the three exists. `pending` is
    // the only state with no review, and `archived` follows a publish.
    check(
      "research_program_review_ck",
      sql`(reviewed_by_user_id IS NULL) = (reviewed_at IS NULL)
          AND (status = 'pending') = (reviewed_at IS NULL)`,
    ),
  ],
);

/**
 * Job-computed program stats — the four hero tiles.
 *
 * WHY A SNAPSHOT TABLE AND NOT COUNTERS ON `research_program`. Same reason §7's
 * investor confidence is a snapshot: the tiles are a claim about a moment, and a
 * counter that drifts has no `asOf` to explain itself with. `GET …/stats` is a **404
 * when no row exists** — never a fabricated set of zeroes, which would read as "this
 * program has no contributors" when the truth is "nobody has counted yet".
 *
 * THERE IS NO MONEY COLUMN, and its absence is deliberate. The mock this replaces
 * showed "$4.2M compensation pool escrowed"; escrow left this codebase (§7), no
 * program-scoped money rail exists, and `research_contribution_ledger_entry` holds
 * commitments rather than balances. `total_effort_minutes` is the honest fourth tile.
 */
export const researchProgramStatSnapshot = pgTable(
  "research_program_stat_snapshot",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    programId: text("program_id")
      .notNull()
      .references(() => researchProgram.id, { onDelete: "cascade" }),
    /** From the job payload, quantized to a UTC day start. Never a clock read. */
    asOf: timestamp("as_of").notNull(),
    participantCount: integer("participant_count").notNull(),
    paperCount: integer("paper_count").notNull(),
    branchCount: integer("branch_count").notNull(),
    postCount: integer("post_count").notNull(),
    /** Branches at `status = 'missing'` — the research gaps this surface exists to name. */
    openGapCount: integer("open_gap_count").notNull(),
    /** Branches at `overlapping_group_count >= 2` — duplicated work. */
    overlapFlagCount: integer("overlap_flag_count").notNull(),
    // bigint: a program with thousands of contributors logging hours for years passes
    // the int4 ceiling in minutes long before it passes it in anything else (§4b).
    totalEffortMinutes: bigint("total_effort_minutes", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    // Re-running the job for the same `asOf` must be a no-op, not a second row.
    uniqueIndex("research_program_stat_snapshot_asOf_unq").on(table.programId, table.asOf),
    // The "latest snapshot" read.
    index("research_program_stat_snapshot_latest_idx").on(table.programId, table.asOf, table.id),
    check(
      "research_program_stat_snapshot_counts_ck",
      sql`participant_count >= 0 AND paper_count >= 0 AND branch_count >= 0
          AND post_count >= 0 AND open_gap_count >= 0 AND overlap_flag_count >= 0
          AND total_effort_minutes >= 0
          AND open_gap_count <= branch_count
          AND overlap_flag_count <= branch_count`,
    ),
  ],
);

/**
 * The research branch tree.
 *
 * ADJACENCY LIST PLUS A MATERIALIZED `ancestorPath` (§10). The read pattern is
 * "render the whole tree at once" for 12–38 nodes, so a closure table is overkill and
 * `ltree` buys an extension for no gain at this size. The path makes a subtree query a
 * prefix match.
 *
 * THE SAME COLLATION TRAP AS `workshop_task.rank`, and it is invisible until it
 * bites: `ORDER BY` on a text column follows the database's LC_COLLATE (typically ICU
 * en_US.UTF-8), which reorders case and punctuation, while a JS/Kotlin/Swift `a < b`
 * compares code points. The migration forces `COLLATE "C"` on `ancestor_path`, and the
 * CHECK below keeps its alphabet inside [0-9a-z/-] where the two orderings are
 * provably identical.
 */
export const researchProgramBranch = pgTable(
  "research_program_branch",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    programId: text("program_id")
      .notNull()
      .references(() => researchProgram.id, { onDelete: "cascade" }),
    // `restrict`, NOT cascade: deleting a mid-tree branch must not silently take its
    // whole subtree — and every paper, claim and product opportunity hanging off it —
    // with it. A caller that wants a branch gone must re-parent its children first.
    // NULL is the root, and a program may have several.
    parentBranchId: text("parent_branch_id").references(
      (): AnyPgColumn => researchProgramBranch.id,
      {
        onDelete: "restrict",
      },
    ),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    /** SERVER-DERIVED from the ancestor chain. In no request body. See the note above. */
    ancestorPath: text("ancestor_path").notNull(),
    /** Sibling ordering for the client's tidy layout. Not a global position. */
    siblingOrder: integer("sibling_order").default(0).notNull(),
    // DERIVED — rule 1. `recompute-branch-signals` owns both of these columns and no
    // request body may carry either.
    status: researchProgramBranchStatusEnum("status").default("emerging").notNull(),
    overlappingGroupCount: integer("overlapping_group_count").default(0).notNull(),
    // The curator override (§10). Integer per-mille rather than a float percent, and
    // normally NULL — the client lays the tree out itself unless a human insisted.
    // Both or neither: half a coordinate places nothing.
    pinnedLeftPermille: integer("pinned_left_permille"),
    pinnedTopPermille: integer("pinned_top_permille"),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    // The path identifies a node within its program, so it is also the guard against
    // two siblings materializing the same path after a re-parent.
    uniqueIndex("research_program_branch_path_unq").on(table.programId, table.ancestorPath),
    index("research_program_branch_parent_idx").on(
      table.programId,
      table.parentBranchId,
      table.siblingOrder,
      table.id,
    ),
    // The gap/overlap reads the job feeds and the map filters on.
    index("research_program_branch_status_idx").on(table.programId, table.status, table.id),
    check("research_program_branch_no_self_parent_ck", sql`parent_branch_id IS DISTINCT FROM id`),
    check(
      "research_program_branch_text_ck",
      sql`char_length(title) BETWEEN 3 AND 120 AND char_length(summary) BETWEEN 10 AND 2000`,
    ),
    // The alphabet that makes COLLATE "C" and a client-side string compare agree.
    check(
      "research_program_branch_path_ck",
      sql`ancestor_path ~ '^[0-9a-z/-]+$' AND char_length(ancestor_path) BETWEEN 1 AND 800`,
    ),
    check(
      "research_program_branch_counts_ck",
      sql`sibling_order >= 0 AND overlapping_group_count >= 0`,
    ),
    check(
      "research_program_branch_pin_ck",
      sql`(pinned_left_permille IS NULL) = (pinned_top_permille IS NULL)
          AND (pinned_left_permille IS NULL
               OR (pinned_left_permille BETWEEN 0 AND 1000
                   AND pinned_top_permille BETWEEN 0 AND 1000))`,
    ),
  ],
);

/**
 * Who is working on which branch. This table IS `contributorCount` — the branch has
 * no counter column, because a count that can disagree with its rows eventually does.
 *
 * The unique index is the whole mechanism: `POST …/claim` inserts and swallows 23505,
 * `DELETE …/claim` deletes and does not care whether a row was there. Both are
 * therefore idempotent, and a double-tap is harmless.
 */
export const researchProgramBranchClaim = pgTable(
  "research_program_branch_claim",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    branchId: text("branch_id")
      .notNull()
      .references(() => researchProgramBranch.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    claimedAt: timestamp("claimed_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("research_program_branch_claim_unq").on(table.branchId, table.userId),
    index("research_program_branch_claim_userId_idx").on(table.userId, table.claimedAt, table.id),
  ],
);

/**
 * The paper taxonomy. A TABLE, not a pgEnum, for the same reason `research_category`
 * is one: the upload form lets a user propose a category. User-minted rows land
 * `pending` and are excluded from public facets until a moderator approves them.
 *
 * `slug`'s UNIQUE **is** the de-duplication mechanism — "Longevity Biology",
 * "longevity biology" and "Longevity-Biology" all slugify to `longevity-biology`, so
 * the second minter takes a 23505 the service turns into a 409. Never
 * check-then-insert, which is a TOCTOU race.
 */
export const researchPaperCategory = pgTable(
  "research_paper_category",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    slug: text("slug").notNull(),
    /** Display label as typed, e.g. "Longevity Biology". Clients render this, never the slug. */
    label: text("label").notNull(),
    // Reuses `research_category_status` rather than declaring a fourth
    // approved/pending/rejected enum — it is the same three-state moderation verdict.
    status: researchCategoryStatusEnum("status").default("pending").notNull(),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("research_paper_category_slug_unq").on(table.slug),
    index("research_paper_category_status_idx").on(table.status, table.label, table.id),
    check(
      "research_paper_category_text_ck",
      sql`slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
          AND char_length(slug) BETWEEN 2 AND 60
          AND char_length(label) BETWEEN 2 AND 80`,
    ),
  ],
);

/**
 * The formal paper library.
 *
 * A ROW EXISTS BEFORE ITS BYTES DO. `POST …/papers` creates the metadata row and
 * `POST …/papers/:id/file` attaches the PDF, so the four storage columns are nullable
 * and move together. Splitting it lets the multipart route stay small and lets a
 * failed upload be retried without re-minting a row and re-checking the DOI.
 *
 * DEDUPLICATED TWICE, by DOI **and** by content hash (§10), through two PARTIAL
 * unique indexes. Both are needed and neither subsumes the other: the same paper
 * re-uploaded under a new title is caught by its bytes, and the same paper uploaded
 * as a differently-encoded PDF is caught by its DOI.
 *
 * `authorAffiliation` is a CLAIM by the uploader — there is no institutional
 * verification anywhere in this codebase, and every surface that renders it must read
 * as attribution rather than endorsement.
 */
export const researchProgramPaper = pgTable(
  "research_program_paper",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    programId: text("program_id")
      .notNull()
      .references(() => researchProgram.id, { onDelete: "cascade" }),
    // `set null`: a paper survives the re-organisation of the branch it was filed
    // under. An unfiled paper is a real state the library already renders.
    branchId: text("branch_id").references(() => researchProgramBranch.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    // `restrict`: a taxonomy row every paper points at must not be deletable from
    // under them.
    categoryId: text("category_id")
      .notNull()
      .references(() => researchPaperCategory.id, { onDelete: "restrict" }),
    /** Normalized lowercase, no `https://doi.org/` prefix. NULL for unpublished work. */
    doi: text("doi"),
    /** A claim, not a verified fact — see the note above. */
    authorAffiliation: text("author_affiliation"),
    abstractText: text("abstract_text"),
    uploaderUserId: text("uploader_user_id").references(() => user.id, { onDelete: "set null" }),
    // --- The file. All four NULL until `POST …/papers/:id/file` succeeds, all four
    // --- set together, and every one of them SERVER-MEASURED: a client that sends a
    // --- size or a hash is rejected by `.strict()`.
    contentSha256: text("content_sha256"),
    fileByteSize: bigint("file_byte_size", { mode: "number" }),
    /** The object-storage key. Content-addressed, so a retry overwrites rather than duplicates. */
    objectStorageKey: text("object_storage_key"),
    // Reuses the §8 enum, whose `s3_compatible` label was declared for exactly this
    // and had no writer until now.
    storageProvider: workshopStorageProviderEnum("storage_provider"),
    moderationStatus: researchPaperModerationStatusEnum("moderation_status")
      .default("queued")
      .notNull(),
    // A text[] with a cardinality bound, NOT jsonb. This schema has no jsonb column
    // anywhere and rejects it by name: it reorders keys, and it reads back as
    // `unknown`. Written by moderators and by the upload path, never by a submitter.
    flagReasons: text("flag_reasons").array().notNull().default([]),
    reviewedByUserId: text("reviewed_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    reviewedAt: timestamp("reviewed_at"),
    reviewerNote: text("reviewer_note"),
    // `precision: 3`, and it is load-bearing — the same trap `workshop_chat_message.sent_at`
    // and `daily_log.submitted_at` both carry a note about. The library is keyset-paginated
    // on `(created_at, id)` and `src/lib/instant-cursor.ts` encodes an instant with
    // `Date.getTime()`, i.e. MILLISECONDS. Postgres timestamps default to microsecond
    // precision, and a cursor coarser than its column cannot express the boundary: a row
    // whose true value falls between the truncated cursor and the next millisecond matches
    // neither `created_at < cursor` nor `created_at = cursor`, so it is returned on NO page.
    // The dependency runs both ways and is stated at both ends.
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    // Dedup by DOI, within a program. Partial, because NULL means "no DOI" and many
    // papers legitimately have none.
    uniqueIndex("research_program_paper_doi_unq")
      .on(table.programId, table.doi)
      .where(sql`doi IS NOT NULL`),
    // Dedup by bytes. Partial for the same reason: a metadata row with no file yet.
    uniqueIndex("research_program_paper_content_unq")
      .on(table.programId, table.contentSha256)
      .where(sql`content_sha256 IS NOT NULL`),
    // The library's keyset read, and the moderation queue's.
    index("research_program_paper_listing_idx").on(
      table.programId,
      table.moderationStatus,
      table.createdAt,
      table.id,
    ),
    index("research_program_paper_categoryId_idx").on(table.categoryId, table.id),
    index("research_program_paper_branchId_idx").on(table.branchId, table.id),
    index("research_program_paper_uploaderUserId_idx").on(table.uploaderUserId, table.id),
    check(
      "research_program_paper_text_ck",
      sql`char_length(title) BETWEEN 3 AND 300
          AND (doi IS NULL OR (doi ~ '^10\\.[0-9]{4,9}/[^[:space:]]+$' AND char_length(doi) <= 200))
          AND (author_affiliation IS NULL OR char_length(author_affiliation) BETWEEN 1 AND 200)
          AND (abstract_text IS NULL OR char_length(abstract_text) BETWEEN 1 AND 5000)
          AND (reviewer_note IS NULL OR char_length(reviewer_note) BETWEEN 1 AND 2000)`,
    ),
    // The four file columns are one fact and move as one.
    check(
      "research_program_paper_file_ck",
      sql`(content_sha256 IS NULL) = (object_storage_key IS NULL)
          AND (content_sha256 IS NULL) = (file_byte_size IS NULL)
          AND (content_sha256 IS NULL) = (storage_provider IS NULL)
          AND (content_sha256 IS NULL OR (content_sha256 ~ '^[0-9a-f]{64}$' AND file_byte_size > 0))`,
    ),
    // A verdict has a reviewer and a time; `queued` has neither.
    check(
      "research_program_paper_review_ck",
      sql`(reviewed_by_user_id IS NULL) = (reviewed_at IS NULL)
          AND (moderation_status = 'queued') = (reviewed_at IS NULL)`,
    ),
    check("research_program_paper_flags_ck", sql`cardinality(flag_reasons) <= 10`),
  ],
);

/**
 * ONE TABLE FOR INFORMAL POSTS, NETIZEN IDEAS **AND** REPLIES (§10), distinguished by
 * `track` and by whether `parent_post_id` is set. They are the same thing — a piece of
 * prose by a person, reactable and reportable — and three tables would mean three of
 * every read, every moderation path and every reaction join.
 *
 * DEPTH IS CAPPED AT ONE REPLY LEVEL, and `depth` is stored rather than walked so the
 * cap is a CHECK instead of a recursive query per insert. Unbounded threading is how a
 * public discussion becomes unrenderable and unmoderatable at once.
 *
 * `reaction_count` and `reply_count` are DENORMALIZED — see rule 4. They are
 * maintained in the transaction that inserts or deletes the child, never recomputed on
 * read.
 */
export const researchProgramPost = pgTable(
  "research_program_post",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    programId: text("program_id")
      .notNull()
      .references(() => researchProgram.id, { onDelete: "cascade" }),
    // Cascade, unlike the branch tree's `restrict`: a reply genuinely has no meaning
    // once the thing it replies to is gone, and the depth cap bounds the cascade to
    // one level.
    parentPostId: text("parent_post_id").references((): AnyPgColumn => researchProgramPost.id, {
      onDelete: "cascade",
    }),
    /**
     * Which branch this discussion is about. NULL for a program-wide thread.
     *
     * WHY IT EXISTS. The branch map shows a discussion count and the most recent thread titles
     * per node — "154 contributors · 61 threads" — and without this column those two would have
     * no backing and the panel would have to drop them. A thread about senolytic dosing belongs
     * to that branch, not to the program at large.
     *
     * `set null`, not cascade: re-organising the tree must not delete the conversation. An
     * unfiled thread is a real state the program-wide feed already renders.
     *
     * A REPLY INHERITS ITS PARENT'S, the same way `track` does — a thread cannot span two
     * branches, and letting a reply re-file itself would move half a conversation.
     */
    branchId: text("branch_id").references(() => researchProgramBranch.id, {
      onDelete: "set null",
    }),
    /** Inherited from the parent on a reply, so a thread cannot span both tracks. */
    track: researchProgramPostTrackEnum("track").notNull(),
    depth: integer("depth").default(0).notNull(),
    /** Informal papers are titled; ideas and replies are not. Enforced below. */
    title: text("title"),
    bodyText: text("body_text").notNull(),
    authorUserId: text("author_user_id").references(() => user.id, { onDelete: "set null" }),
    reactionCount: integer("reaction_count").default(0).notNull(),
    replyCount: integer("reply_count").default(0).notNull(),
    // Moderation. Hidden rather than deleted, so a report stays explicable and a
    // wrong call is reversible — `post_restored` is a real audit event.
    isHidden: boolean("is_hidden").default(false).notNull(),
    hiddenByUserId: text("hidden_by_user_id").references(() => user.id, { onDelete: "restrict" }),
    hiddenAt: timestamp("hidden_at"),
    hiddenReason: text("hidden_reason"),
    // `precision: 3` — both the track feed and a thread's replies are keyset-paginated on
    // `(created_at, id)`. See the identical note on `research_program_paper.created_at`;
    // a millisecond cursor over a microsecond column drops rows off every page boundary.
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    // The track feed: top-level rows, newest first, ending in a unique column.
    index("research_program_post_feed_idx").on(
      table.programId,
      table.track,
      table.createdAt,
      table.id,
    ),
    // A thread's replies, oldest first.
    index("research_program_post_parent_idx").on(table.parentPostId, table.createdAt, table.id),
    index("research_program_post_authorUserId_idx").on(table.authorUserId, table.id),
    // Drives the branch map's per-node discussion count and recent-thread list. Leads with
    // `branch_id` and ends in a unique column so the "most recent N" read is an index scan.
    index("research_program_post_branchId_idx").on(table.branchId, table.createdAt, table.id),
    // Depth and parenthood are one fact stated twice, and they must agree.
    check(
      "research_program_post_depth_ck",
      sql`depth BETWEEN 0 AND 1 AND (depth = 0) = (parent_post_id IS NULL)`,
    ),
    // Only a top-level informal paper carries a title; nothing else may.
    check(
      "research_program_post_title_ck",
      sql`(title IS NOT NULL) = (track = 'informal_paper' AND depth = 0)
          AND (title IS NULL OR char_length(title) BETWEEN 3 AND 200)`,
    ),
    check(
      "research_program_post_body_ck",
      sql`char_length(body_text) BETWEEN 1 AND 10000
          AND (hidden_reason IS NULL OR char_length(hidden_reason) BETWEEN 1 AND 2000)`,
    ),
    check("research_program_post_counts_ck", sql`reaction_count >= 0 AND reply_count >= 0`),
    // A reply has no replies of its own — the cap, restated where it is cheap to check.
    check("research_program_post_leaf_ck", sql`depth = 0 OR reply_count = 0`),
    check(
      "research_program_post_hidden_ck",
      sql`is_hidden = (hidden_at IS NOT NULL) AND (hidden_by_user_id IS NULL) = (hidden_at IS NULL)`,
    ),
  ],
);

/**
 * One row per user per post. The unique index is what makes `PUT`/`DELETE …/reaction`
 * idempotent by verb (§10) — which is why they are `PUT` and `DELETE` rather than
 * `POST`: a double-tap on a slow connection must be harmless, not a second like.
 */
export const researchProgramPostReaction = pgTable(
  "research_program_post_reaction",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    postId: text("post_id")
      .notNull()
      .references(() => researchProgramPost.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("research_program_post_reaction_unq").on(table.postId, table.userId),
    // "Did I react to this?" across a fetched page, in one query.
    index("research_program_post_reaction_userId_idx").on(table.userId, table.postId),
  ],
);

/**
 * Monetizable products derivable from a branch — the bridge from open research back to
 * the pipeline the rest of R&D serves.
 *
 * `estimatedMarketSizeInCents` MUST be bigint: the mock's "$12B est. market" is
 * `1200000000000`, which is 560× the int4 ceiling (§4b). The readiness pair replaces
 * the mock's "Monetizable in 2–4 yrs" string, so the rail becomes sortable instead of
 * merely readable.
 */
export const researchProgramProductOpportunity = pgTable(
  "research_program_product_opportunity",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    programId: text("program_id")
      .notNull()
      .references(() => researchProgram.id, { onDelete: "cascade" }),
    // `restrict`: the whole claim is "this product comes from that research". A
    // dangling opportunity is an unsourced market projection.
    derivedFromBranchId: text("derived_from_branch_id")
      .notNull()
      .references(() => researchProgramBranch.id, { onDelete: "restrict" }),
    productName: text("product_name").notNull(),
    productDescription: text("product_description").notNull(),
    estimatedMarketSizeInCents: bigint("estimated_market_size_in_cents", {
      mode: "number",
    }).notNull(),
    readinessMinMonths: integer("readiness_min_months").notNull(),
    readinessMaxMonths: integer("readiness_max_months").notNull(),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("research_program_product_opportunity_programId_idx").on(
      table.programId,
      table.estimatedMarketSizeInCents,
      table.id,
    ),
    index("research_program_product_opportunity_branchId_idx").on(
      table.derivedFromBranchId,
      table.id,
    ),
    check(
      "research_program_product_opportunity_text_ck",
      sql`char_length(product_name) BETWEEN 3 AND 200
          AND char_length(product_description) BETWEEN 10 AND 2000`,
    ),
    check(
      "research_program_product_opportunity_numbers_ck",
      sql`estimated_market_size_in_cents >= 0
          AND readiness_min_months >= 0
          AND readiness_max_months >= readiness_min_months
          AND readiness_max_months <= 600`,
    ),
  ],
);

/**
 * A person's participation in a program, and how they want to be compensated for it.
 *
 * `compensationPreference` reuses `compensation_kind` (§4d) — the one vocabulary a
 * program shares with a project, and the correct amount of sharing.
 *
 * THERE IS NO `total_effort_minutes` COLUMN. It is `SUM(research_effort_log.minutes)`,
 * computed on read and carried in the stat snapshot. A denormalized total that can
 * disagree with the logs it summarizes is a number nobody can defend, and this surface
 * exists to be defensible.
 *
 * The two tranche columns are the other half of the mock's `effortLabel`, which held
 * "312 hrs logged" on some rows and "Funding tranche 2 of 4" on others — one field,
 * two meanings (§10 calls this the trap). They are now separate facts.
 */
export const researchProgramParticipant = pgTable(
  "research_program_participant",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    programId: text("program_id")
      .notNull()
      .references(() => researchProgram.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: researchProgramParticipantRoleEnum("role").notNull(),
    compensationPreference: compensationKindEnum("compensation_preference").notNull(),
    contributionSummary: text("contribution_summary"),
    /** Funding progress, for `venture_capitalist` rows. Both or neither. */
    fundingTrancheIndex: integer("funding_tranche_index"),
    fundingTrancheTotal: integer("funding_tranche_total"),
    joinedAt: timestamp("joined_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("research_program_participant_unq").on(table.programId, table.userId),
    // The contributors roster, filterable by role.
    index("research_program_participant_role_idx").on(table.programId, table.role, table.id),
    index("research_program_participant_userId_idx").on(table.userId, table.id),
    check(
      "research_program_participant_summary_ck",
      sql`contribution_summary IS NULL OR char_length(contribution_summary) BETWEEN 1 AND 500`,
    ),
    check(
      "research_program_participant_tranche_ck",
      sql`(funding_tranche_index IS NULL) = (funding_tranche_total IS NULL)
          AND (funding_tranche_index IS NULL
               OR (funding_tranche_index >= 1
                   AND funding_tranche_total >= funding_tranche_index
                   AND funding_tranche_total <= 100))`,
    ),
  ],
);

/**
 * Logged time on a program. NOT an effort claim (§9): nothing verifies it, nothing
 * grounds it against an artifact, and it mints no equity. It is a self-reported record
 * — rule 3 — and the roster labels it as one.
 *
 * ALL THREE FKs ARE `restrict` (§4f). Effort logged is a fact about the past; deleting
 * a participant or a branch must not erase it. Removing someone from a program is a
 * participant-row deletion the FK will refuse until their logs are dealt with
 * deliberately, which is the intended friction.
 */
export const researchEffortLog = pgTable(
  "research_effort_log",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    programId: text("program_id")
      .notNull()
      .references(() => researchProgram.id, { onDelete: "restrict" }),
    participantId: text("participant_id")
      .notNull()
      .references(() => researchProgramParticipant.id, { onDelete: "restrict" }),
    branchId: text("branch_id").references(() => researchProgramBranch.id, {
      onDelete: "restrict",
    }),
    minutes: integer("minutes").notNull(),
    /** Date-only, the §1 wire format — no "which timezone is 00:00 in?" question. */
    loggedForDate: date("logged_for_date", { mode: "string" }).notNull(),
    note: text("note").notNull(),
    /**
     * Client-minted, once per attempt. The unique index below is what makes a retried
     * submit return the first row instead of double-counting time — two identical
     * honest logs are two logs, so this is NOT derived from the contents.
     */
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("research_effort_log_idempotency_unq").on(
      table.participantId,
      table.idempotencyKey,
    ),
    index("research_effort_log_programId_idx").on(table.programId, table.loggedForDate, table.id),
    index("research_effort_log_participantId_idx").on(table.participantId, table.loggedForDate),
    index("research_effort_log_branchId_idx").on(table.branchId, table.id),
    // A day has 1440 minutes. A log claiming more is not a typo worth storing.
    check("research_effort_log_minutes_ck", sql`minutes > 0 AND minutes <= 1440`),
    check("research_effort_log_note_ck", sql`char_length(note) BETWEEN 1 AND 2000`),
    check(
      "research_effort_log_idempotency_ck",
      sql`char_length(idempotency_key) BETWEEN 8 AND 128`,
    ),
  ],
);

/**
 * Non-time contributions: cash committed, materials, data, equipment, expertise.
 *
 * A RECORD OF INTENT, NOT A SETTLEMENT — rule 3, and the reason this is not called a
 * ledger of balances. `cash_commitment` carries an amount and a currency; no money
 * moves, nothing is held, and no response built on this table may imply that it was.
 * The mock's "$250K escrowed" becomes "$250K committed", because escrow left this
 * codebase (§7) and re-implying it would be the one lie this surface cannot afford.
 */
export const researchContributionLedgerEntry = pgTable(
  "research_contribution_ledger_entry",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    programId: text("program_id")
      .notNull()
      .references(() => researchProgram.id, { onDelete: "restrict" }),
    participantId: text("participant_id")
      .notNull()
      .references(() => researchProgramParticipant.id, { onDelete: "restrict" }),
    kind: researchContributionKindEnum("kind").notNull(),
    /** bigint, and only for `cash_commitment`. See §4b on the int4 ceiling. */
    amountInCents: bigint("amount_in_cents", { mode: "number" }),
    /** ISO-4217. Set with an amount, absent without one. */
    currencyCode: text("currency_code"),
    description: text("description").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("research_contribution_idempotency_unq").on(
      table.participantId,
      table.idempotencyKey,
    ),
    index("research_contribution_programId_idx").on(table.programId, table.createdAt, table.id),
    index("research_contribution_participantId_idx").on(table.participantId, table.id),
    // An amount belongs to a cash commitment and to nothing else, and it never
    // travels without its currency.
    check(
      "research_contribution_amount_ck",
      sql`(amount_in_cents IS NOT NULL) = (kind = 'cash_commitment')
          AND (amount_in_cents IS NULL) = (currency_code IS NULL)
          AND (amount_in_cents IS NULL OR (amount_in_cents > 0 AND currency_code ~ '^[A-Z]{3}$'))`,
    ),
    check("research_contribution_description_ck", sql`char_length(description) BETWEEN 1 AND 1000`),
    check(
      "research_contribution_idempotency_ck",
      sql`char_length(idempotency_key) BETWEEN 8 AND 128`,
    ),
  ],
);

/**
 * A reader flagging a paper or a post.
 *
 * ONE REPORT PER USER PER TARGET, through two partial unique indexes — so a
 * brigading loop cannot inflate a queue, and `409 ALREADY_REPORTED` is an honest
 * answer rather than a silent second row.
 */
export const researchProgramContentReport = pgTable(
  "research_program_content_report",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    programId: text("program_id")
      .notNull()
      .references(() => researchProgram.id, { onDelete: "cascade" }),
    targetKind: researchProgramContentTargetKindEnum("target_kind").notNull(),
    paperId: text("paper_id").references(() => researchProgramPaper.id, { onDelete: "cascade" }),
    postId: text("post_id").references(() => researchProgramPost.id, { onDelete: "cascade" }),
    reason: researchProgramReportReasonEnum("reason").notNull(),
    detailText: text("detail_text"),
    reporterUserId: text("reporter_user_id").references(() => user.id, { onDelete: "set null" }),
    status: researchProgramReportStatusEnum("status").default("open").notNull(),
    resolvedByUserId: text("resolved_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    resolvedAt: timestamp("resolved_at"),
    // `precision: 3` — the moderation queue is keyset-paginated on `(created_at, id)`.
    // See the note on `research_program_paper.created_at`.
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("research_program_content_report_post_unq")
      .on(table.postId, table.reporterUserId)
      .where(sql`post_id IS NOT NULL AND reporter_user_id IS NOT NULL`),
    uniqueIndex("research_program_content_report_paper_unq")
      .on(table.paperId, table.reporterUserId)
      .where(sql`paper_id IS NOT NULL AND reporter_user_id IS NOT NULL`),
    // The moderation queue: open reports, oldest first.
    index("research_program_content_report_queue_idx").on(
      table.programId,
      table.status,
      table.createdAt,
      table.id,
    ),
    // Exactly one target, and it agrees with `target_kind`. Two nullable FKs are the
    // cost of one table serving both; this CHECK is what keeps it honest.
    check(
      "research_program_content_report_target_ck",
      sql`((target_kind = 'paper') = (paper_id IS NOT NULL))
          AND ((target_kind = 'post') = (post_id IS NOT NULL))
          AND (paper_id IS NULL) <> (post_id IS NULL)`,
    ),
    check(
      "research_program_content_report_detail_ck",
      sql`detail_text IS NULL OR char_length(detail_text) BETWEEN 1 AND 2000`,
    ),
    check(
      "research_program_content_report_resolution_ck",
      sql`(resolved_by_user_id IS NULL) = (resolved_at IS NULL)
          AND (status = 'open') = (resolved_at IS NULL)`,
    ),
  ],
);

/**
 * What a moderator did, in this domain's own words.
 *
 * WHY THIS EXISTS ALONGSIDE `platform_audit_entry`. The platform chain is the
 * tamper-evident record and is the authority; this table is the domain's queryable
 * view of it — "show me every decision on this program" is one index scan here and a
 * payload search there. Every row is written in the SAME transaction as its chain
 * entry, so neither can exist without the other.
 *
 * `moderatorUserId` is `restrict`: who decided is the entire point, and it must not
 * become NULL when an account goes.
 */
export const researchProgramModerationAction = pgTable(
  "research_program_moderation_action",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    // `restrict`, not cascade: the accountability record outlives the program.
    programId: text("program_id")
      .notNull()
      .references(() => researchProgram.id, { onDelete: "restrict" }),
    actionKind: researchProgramModerationKindEnum("action_kind").notNull(),
    // `set null`: a decision stays on the record after the thing it was about is gone.
    paperId: text("paper_id").references(() => researchProgramPaper.id, { onDelete: "set null" }),
    postId: text("post_id").references(() => researchProgramPost.id, { onDelete: "set null" }),
    reportId: text("report_id").references(() => researchProgramContentReport.id, {
      onDelete: "set null",
    }),
    moderatorUserId: text("moderator_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    /** The role AT THE TIME, snapshotted — roles are revocable and a join would lie later. */
    moderatorRoleSnapshot: text("moderator_role_snapshot").notNull(),
    reasonNote: text("reason_note").notNull(),
    /** The `platform_audit_entry` written in the same transaction. */
    auditEntryId: text("audit_entry_id")
      .notNull()
      .references(() => platformAuditEntry.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("research_program_moderation_action_programId_idx").on(
      table.programId,
      table.createdAt,
      table.id,
    ),
    index("research_program_moderation_action_moderatorUserId_idx").on(
      table.moderatorUserId,
      table.createdAt,
    ),
    uniqueIndex("research_program_moderation_action_auditEntryId_unq").on(table.auditEntryId),
    check(
      "research_program_moderation_action_reason_ck",
      sql`char_length(reason_note) BETWEEN 1 AND 2000
          AND char_length(moderator_role_snapshot) BETWEEN 1 AND 40`,
    ),
  ],
);

// --- §10 relations. Child-side only, same convention as §5, §6, §7, §7A, §8 and §9:
// --- each table declares its own `one(...)` and neither `userRelations` nor
// --- `researchProgramRelations` is edited to add a matching `many(...)`.

export const researchProgramRelations = relations(researchProgram, ({ one }) => ({
  createdBy: one(user, {
    fields: [researchProgram.createdByUserId],
    references: [user.id],
    relationName: "researchProgramCreatedBy",
  }),
  reviewedBy: one(user, {
    fields: [researchProgram.reviewedByUserId],
    references: [user.id],
    relationName: "researchProgramReviewedBy",
  }),
}));

export const researchProgramStatSnapshotRelations = relations(
  researchProgramStatSnapshot,
  ({ one }) => ({
    program: one(researchProgram, {
      fields: [researchProgramStatSnapshot.programId],
      references: [researchProgram.id],
    }),
  }),
);

export const researchProgramBranchRelations = relations(researchProgramBranch, ({ one }) => ({
  program: one(researchProgram, {
    fields: [researchProgramBranch.programId],
    references: [researchProgram.id],
  }),
  parentBranch: one(researchProgramBranch, {
    fields: [researchProgramBranch.parentBranchId],
    references: [researchProgramBranch.id],
    relationName: "researchProgramBranchParent",
  }),
  createdBy: one(user, {
    fields: [researchProgramBranch.createdByUserId],
    references: [user.id],
    relationName: "researchProgramBranchCreatedBy",
  }),
}));

export const researchProgramBranchClaimRelations = relations(
  researchProgramBranchClaim,
  ({ one }) => ({
    branch: one(researchProgramBranch, {
      fields: [researchProgramBranchClaim.branchId],
      references: [researchProgramBranch.id],
    }),
    claimant: one(user, {
      fields: [researchProgramBranchClaim.userId],
      references: [user.id],
      relationName: "researchProgramBranchClaimant",
    }),
  }),
);

export const researchPaperCategoryRelations = relations(researchPaperCategory, ({ one }) => ({
  createdBy: one(user, {
    fields: [researchPaperCategory.createdByUserId],
    references: [user.id],
    relationName: "researchPaperCategoryCreatedBy",
  }),
}));

export const researchProgramPaperRelations = relations(researchProgramPaper, ({ one }) => ({
  program: one(researchProgram, {
    fields: [researchProgramPaper.programId],
    references: [researchProgram.id],
  }),
  branch: one(researchProgramBranch, {
    fields: [researchProgramPaper.branchId],
    references: [researchProgramBranch.id],
  }),
  category: one(researchPaperCategory, {
    fields: [researchProgramPaper.categoryId],
    references: [researchPaperCategory.id],
  }),
  uploader: one(user, {
    fields: [researchProgramPaper.uploaderUserId],
    references: [user.id],
    relationName: "researchProgramPaperUploader",
  }),
  reviewedBy: one(user, {
    fields: [researchProgramPaper.reviewedByUserId],
    references: [user.id],
    relationName: "researchProgramPaperReviewedBy",
  }),
}));

export const researchProgramPostRelations = relations(researchProgramPost, ({ one }) => ({
  program: one(researchProgram, {
    fields: [researchProgramPost.programId],
    references: [researchProgram.id],
  }),
  parentPost: one(researchProgramPost, {
    fields: [researchProgramPost.parentPostId],
    references: [researchProgramPost.id],
    relationName: "researchProgramPostParent",
  }),
  branch: one(researchProgramBranch, {
    fields: [researchProgramPost.branchId],
    references: [researchProgramBranch.id],
  }),
  author: one(user, {
    fields: [researchProgramPost.authorUserId],
    references: [user.id],
    relationName: "researchProgramPostAuthor",
  }),
  hiddenBy: one(user, {
    fields: [researchProgramPost.hiddenByUserId],
    references: [user.id],
    relationName: "researchProgramPostHiddenBy",
  }),
}));

export const researchProgramPostReactionRelations = relations(
  researchProgramPostReaction,
  ({ one }) => ({
    post: one(researchProgramPost, {
      fields: [researchProgramPostReaction.postId],
      references: [researchProgramPost.id],
    }),
    reactor: one(user, {
      fields: [researchProgramPostReaction.userId],
      references: [user.id],
      relationName: "researchProgramPostReactor",
    }),
  }),
);

export const researchProgramProductOpportunityRelations = relations(
  researchProgramProductOpportunity,
  ({ one }) => ({
    program: one(researchProgram, {
      fields: [researchProgramProductOpportunity.programId],
      references: [researchProgram.id],
    }),
    derivedFromBranch: one(researchProgramBranch, {
      fields: [researchProgramProductOpportunity.derivedFromBranchId],
      references: [researchProgramBranch.id],
    }),
    createdBy: one(user, {
      fields: [researchProgramProductOpportunity.createdByUserId],
      references: [user.id],
      relationName: "researchProgramProductOpportunityCreatedBy",
    }),
  }),
);

export const researchProgramParticipantRelations = relations(
  researchProgramParticipant,
  ({ one }) => ({
    program: one(researchProgram, {
      fields: [researchProgramParticipant.programId],
      references: [researchProgram.id],
    }),
    participant: one(user, {
      fields: [researchProgramParticipant.userId],
      references: [user.id],
      relationName: "researchProgramParticipantUser",
    }),
  }),
);

export const researchEffortLogRelations = relations(researchEffortLog, ({ one }) => ({
  program: one(researchProgram, {
    fields: [researchEffortLog.programId],
    references: [researchProgram.id],
  }),
  participant: one(researchProgramParticipant, {
    fields: [researchEffortLog.participantId],
    references: [researchProgramParticipant.id],
  }),
  branch: one(researchProgramBranch, {
    fields: [researchEffortLog.branchId],
    references: [researchProgramBranch.id],
  }),
}));

export const researchContributionLedgerEntryRelations = relations(
  researchContributionLedgerEntry,
  ({ one }) => ({
    program: one(researchProgram, {
      fields: [researchContributionLedgerEntry.programId],
      references: [researchProgram.id],
    }),
    participant: one(researchProgramParticipant, {
      fields: [researchContributionLedgerEntry.participantId],
      references: [researchProgramParticipant.id],
    }),
  }),
);

export const researchProgramContentReportRelations = relations(
  researchProgramContentReport,
  ({ one }) => ({
    program: one(researchProgram, {
      fields: [researchProgramContentReport.programId],
      references: [researchProgram.id],
    }),
    paper: one(researchProgramPaper, {
      fields: [researchProgramContentReport.paperId],
      references: [researchProgramPaper.id],
    }),
    post: one(researchProgramPost, {
      fields: [researchProgramContentReport.postId],
      references: [researchProgramPost.id],
    }),
    reporter: one(user, {
      fields: [researchProgramContentReport.reporterUserId],
      references: [user.id],
      relationName: "researchProgramContentReporter",
    }),
    resolvedBy: one(user, {
      fields: [researchProgramContentReport.resolvedByUserId],
      references: [user.id],
      relationName: "researchProgramContentReportResolvedBy",
    }),
  }),
);

export const researchProgramModerationActionRelations = relations(
  researchProgramModerationAction,
  ({ one }) => ({
    program: one(researchProgram, {
      fields: [researchProgramModerationAction.programId],
      references: [researchProgram.id],
    }),
    moderator: one(user, {
      fields: [researchProgramModerationAction.moderatorUserId],
      references: [user.id],
      relationName: "researchProgramModerator",
    }),
    auditEntry: one(platformAuditEntry, {
      fields: [researchProgramModerationAction.auditEntryId],
      references: [platformAuditEntry.id],
    }),
  }),
);

// ===========================================================================
// §12 — PITCHES. See docs/PITCHES_STRUCTURE.md in the frontend repo.
//
// A PITCH IS A PUBLISHED SOLICITATION, and it is deliberately the thinnest
// table that can be one. A founder points at an idea they already own, adds a
// video and a deck they already uploaded, and links OUT to wherever the money
// actually happens. Qatoto lists it. That is the entire product.
//
// WHAT THIS TABLE MUST NEVER GROW, and each omission is load-bearing:
//
//  1. NO AMOUNT AND NO EQUITY PERCENTAGE. A page carrying "raising $X for Y%"
//     is a general solicitation in the US sense, and `commerce_cofounder_*`
//     already refused exactly this column pair on exactly this ground ("UNTIL
//     DECIDED, THE BACKEND STORES NO CAPITAL FIGURE"). The ask lives on the
//     third party's page, behind `external_funding_url`. Two places cannot
//     answer this question differently.
//  2. NO PLEDGE, NO CHARGE, NO CUSTODY. Qatoto operates no money rail — escrow
//     left this domain (§7) and `PLATFORM_FEE_BASIS_POINTS` is 0. A pitch that
//     accepted money here would make this codebase an intermediary.
//  3. NO RECIPIENT AND NO THREAD. "Send a pitch to an investor" needs an
//     investor entity, which does not exist and would drag KYC and
//     accreditation in with it. Contact is a URL the founder owns.
//
// THE TWO URLS ARE HOSTILE INPUT RENDERED AS LINKS FOR OTHER PEOPLE. They are
// parsed, normalized and refused by `src/lib/external-url.ts` before they are
// stored — https only, no credentials, no protocol-relative authority. The
// column stores the NORMALIZED form, never what was typed.
// ===========================================================================

/**
 * A pitch's lifecycle.
 *
 * `pending` is where a submitted pitch waits, and it is absent from every write
 * schema — `.strict()` turns an attempt to send `status` into a 422 rather than
 * a moderation bypass, exactly as `research_program.status` does.
 *
 * THE GATE IS LIGHT AND IS NEVER ABOUT MERIT: spam, scams and illegal content
 * only. Vetting a pitch on quality would read as an endorsement, which is the
 * liability this whole surface is shaped to avoid. Kickstarter reviews every
 * project and says in as many words that review is not endorsement; so does the
 * disclaimer on the page this feeds.
 */
export const pitchStatusEnum = pgEnum("pitch_status", [
  "draft",
  "pending",
  "published",
  "rejected",
  "closed",
]);

export const pitch = pgTable(
  "pitch",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    // PUBLIC identity. Server-derived from `title` with a -2/-3 collision suffix,
    // never accepted in a request body, and immutable once minted: a published
    // pitch has been linked to from somewhere Qatoto does not control.
    slug: text("slug").notNull(),
    // `restrict`, per rule R1 at the head of this file — and with an extra reason
    // here. A pitch is the public record of a solicitation someone may later have
    // a question about, so it must stay resolvable to the thing it solicited for.
    projectId: text("project_id")
      .notNull()
      .references(() => researchProject.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    // `set null`, NOT restrict, and the asymmetry with `project_id` above is the
    // point: `studio.ts` states that a video "bears no ledger, equity or audit
    // weight, so it is a possession that dies with the account". A pitch outlives
    // the video it embedded; it does not die with it.
    pitchVideoId: text("pitch_video_id").references((): AnyPgColumn => video.id, {
      onDelete: "set null",
    }),
    // Where the money actually happens — someone else's licensed platform.
    // NORMALIZED by src/lib/external-url.ts before it lands here.
    externalFundingUrl: text("external_funding_url"),
    // How to reach the founder, on a surface the founder owns. Qatoto brokers no
    // personal data and hosts no inbox, which is why this is a URL and not an
    // email address.
    externalContactUrl: text("external_contact_url"),
    status: pitchStatusEnum("status").notNull().default("draft"),
    // Staff-typed, and shown to the submitter — this is the one moderation note on
    // the surface that is not staff-facing, because a rejected pitch with no reason
    // is a wall rather than a decision.
    rejectionReason: text("rejection_reason"),
    publishedAt: timestamp("published_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("pitch_slug_unq").on(table.slug),
    index("pitch_projectId_idx").on(table.projectId),
    index("pitch_status_idx").on(table.status),
    // §4c rule 4: the ORDER BY behind the public discovery list ends in a unique
    // column, or a keyset cursor silently skips rows.
    index("pitch_status_publishedAt_idx").on(table.status, table.publishedAt, table.id),
    index("pitch_pitchVideoId_idx").on(table.pitchVideoId),
    check("pitch_title_ck", sql`char_length(title) BETWEEN 3 AND 120`),
    check("pitch_summary_ck", sql`char_length(summary) BETWEEN 20 AND 2000`),
    // A rejection without a reason is the failure mode this refuses structurally,
    // the same way `video_rejection_reason_ck` does one file over.
    check(
      "pitch_rejection_reason_ck",
      sql`(status <> 'rejected') OR (rejection_reason IS NOT NULL)`,
    ),
    // A published row with no publishedAt sorts as NULL and drops out of every
    // ORDER BY that lists it — published but invisible, with no error anywhere.
    check("pitch_published_at_ck", sql`(status <> 'published') OR (published_at IS NOT NULL)`),
    // Belt and braces over the parser in src/lib/external-url.ts. The service is
    // the real check; this is what holds if a future write path forgets to call it.
    check(
      "pitch_external_urls_ck",
      sql`(external_funding_url IS NULL OR (external_funding_url ~ '^https://' AND char_length(external_funding_url) <= 2048))
          AND (external_contact_url IS NULL OR (external_contact_url ~ '^https://' AND char_length(external_contact_url) <= 2048))`,
    ),
  ],
);

/**
 * One reported outcome of a pitch: money that changed hands SOMEWHERE ELSE.
 *
 * A RECORD OF WHAT TWO PEOPLE SAY HAPPENED, NOT A SETTLEMENT — the same contract
 * `research_contribution_ledger_entry` and `compensation_payment_record` carry,
 * and for the same reason: the parties transact off-platform and Qatoto records
 * an attestation. Nothing here moved money, and no response built on this table
 * may imply that Qatoto collected, held, released or escrowed anything.
 *
 * IT TAKES TWO. `recorded_by_user_id` is whoever typed it; `confirmed_by_user_id`
 * is the counterparty agreeing. Until both exist the row is a claim by one side,
 * and every read must render it as one — a single-signed outcome shown as a fact
 * is a founder publishing their own funding announcement through Qatoto's voice.
 *
 * NO STATUS COLUMN AND NO STATE MACHINE, deliberately. Append-only: a correction
 * is a new row, because an attestation somebody signed must not change under them.
 *
 * `funder_user_id` is NULLABLE because the whole design assumes the funder may be
 * a stranger to this platform — an angel, a fund, a family member. `set null` on
 * their account deletion, since the record of the funding outlives the account and
 * `funder_name_text` still names who it was.
 */
export const pitchFundingOutcome = pgTable(
  "pitch_funding_outcome",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    pitchId: text("pitch_id")
      .notNull()
      .references(() => pitch.id, { onDelete: "restrict" }),
    /** bigint, never int4 — see §4b on the $21.5M ceiling. */
    amountInCents: bigint("amount_in_cents", { mode: "number" }).notNull(),
    /** ISO-4217, and it never travels without an amount. */
    currencyCode: text("currency_code").notNull(),
    fundedOnDate: date("funded_on_date").notNull(),
    funderUserId: text("funder_user_id").references(() => user.id, { onDelete: "set null" }),
    funderNameText: text("funder_name_text").notNull(),
    note: text("note"),
    recordedByUserId: text("recorded_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    confirmedByUserId: text("confirmed_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    confirmedAt: timestamp("confirmed_at"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("pitch_funding_outcome_idempotency_unq").on(
      table.recordedByUserId,
      table.idempotencyKey,
    ),
    index("pitch_funding_outcome_pitchId_idx").on(table.pitchId, table.createdAt, table.id),
    index("pitch_funding_outcome_funderUserId_idx").on(table.funderUserId),
    check(
      "pitch_funding_outcome_amount_ck",
      sql`amount_in_cents > 0 AND currency_code ~ '^[A-Z]{3}$'`,
    ),
    // The two halves of a confirmation are set together or not at all. Without
    // this a row could carry a confirmer and no timestamp, and "confirmed when?"
    // would have no answer on a record whose whole value is being dated.
    check(
      "pitch_funding_outcome_confirmed_ck",
      sql`(confirmed_by_user_id IS NULL) = (confirmed_at IS NULL)`,
    ),
    // Nobody countersigns their own attestation. Two signatures from one person
    // is one signature wearing a hat.
    check(
      "pitch_funding_outcome_two_parties_ck",
      sql`confirmed_by_user_id IS NULL OR confirmed_by_user_id <> recorded_by_user_id`,
    ),
    check(
      "pitch_funding_outcome_funder_name_ck",
      sql`char_length(funder_name_text) BETWEEN 1 AND 200`,
    ),
    check(
      "pitch_funding_outcome_note_ck",
      sql`note IS NULL OR char_length(note) BETWEEN 1 AND 1000`,
    ),
    check(
      "pitch_funding_outcome_idempotency_ck",
      sql`char_length(idempotency_key) BETWEEN 8 AND 128`,
    ),
  ],
);

// --- §12 relations. Child-side only, same convention as §5, §6, §7, §7A, §8,
// --- §9 and §10: each table declares its own `one(...)` and no parent is edited
// --- to add a matching `many(...)`.

export const pitchRelations = relations(pitch, ({ one }) => ({
  project: one(researchProject, {
    fields: [pitch.projectId],
    references: [researchProject.id],
  }),
}));

export const pitchFundingOutcomeRelations = relations(pitchFundingOutcome, ({ one }) => ({
  pitch: one(pitch, {
    fields: [pitchFundingOutcome.pitchId],
    references: [pitch.id],
  }),
  funder: one(user, {
    fields: [pitchFundingOutcome.funderUserId],
    references: [user.id],
    relationName: "pitchOutcomeFunder",
  }),
  recordedBy: one(user, {
    fields: [pitchFundingOutcome.recordedByUserId],
    references: [user.id],
    relationName: "pitchOutcomeRecorder",
  }),
  confirmedBy: one(user, {
    fields: [pitchFundingOutcome.confirmedByUserId],
    references: [user.id],
    relationName: "pitchOutcomeConfirmer",
  }),
}));

// ---------------------------------------------------------------------------
// §10A — IMPORT INTELLIGENCE & LOCALIZATION.
//
// The question the pipeline never asked: what does this country already buy from
// abroad, and could it be made here instead? Three layers, and they are three tables
// rather than one because they have three different authors — UN Comtrade writes the
// flows, a moderator writes the substitutes, and a nightly job writes the assessment.
//
// FED BY A REAL FEED, NOT A FIXTURE. `commodity_trade_flow` rows come from
// comtradeapi.un.org, one call per (reporter, year, flow), pinned to
// `partnerCode=0&partner2Code=0&customsCode=C00&motCode=0` so the API returns exactly
// one aggregate row per commodity. `data_origin` distinguishes that feed from a later
// admin upload or a test fixture, so a second source lands as rows rather than as a
// migration.
//
// THE UNITS RULE BITES HARDEST HERE (§4b). Comtrade sends FLOATS — `primaryValue`
// 11862990842.188, `netWgt` 6533139.808. They are converted to integers exactly once,
// in `comtrade.ts`, and nothing downstream ever sees a float. India's largest single
// commodity line is $140bn, which is 14_038_629_964_550 cents: int4 caps at 2.1bn, so
// every value column here is `bigint`.
//
// AND NULL IS NOT ZERO, WHICH IS LOAD-BEARING ON DAY ONE. 679 of India's 5,052 HS6
// import lines carry no net weight at all. A weight of zero would say "this weighs
// nothing"; NULL says "nobody recorded it", and only one of those is true.
// ---------------------------------------------------------------------------

/**
 * What kind of thing a commodity is, derived from its HS chapter by
 * `import-intelligence/hs-chapter-map.ts` — never free text and never client-supplied.
 *
 * Sixteen values because the 97 HS chapters do not collapse into fewer without lying:
 * a pharmaceutical and an industrial chemical share a chapter range and nothing else
 * that matters to whether a country can make one.
 */
export const importCommodityKindEnum = pgEnum("import_commodity_kind", [
  "agricultural_product", // HS 01-15 — live animals, crops, fats
  "food_product", // HS 16-24 — prepared food, beverages, tobacco
  "mineral_ceramic", // HS 25-26, 68-70 — stone, cement, glass, ceramics
  "energy_fuel", // HS 27 — the single largest line in most importing countries
  "chemical", // HS 28-29, 31-38
  "pharmaceutical", // HS 30 — split out because localizing it is a regulatory problem
  "plastic_rubber", // HS 39-40
  "wood_paper", // HS 44-49
  "textile_leather", // HS 41-43, 50-67
  "precious_material", // HS 71 — gold and diamonds, which distort any ranking they enter
  "metal", // HS 72-83
  "machinery", // HS 84
  "electronic_subassembly", // HS 85
  "transport_equipment", // HS 86-89
  "precision_instrument", // HS 90-92
  "other_manufactured", // HS 93-97
]);

/**
 * The unit a traded quantity is measured in.
 *
 * EXACTLY THE TEN COMTRADE EMITS, verified against a full year of India's HS6 lines
 * rather than guessed from documentation. `not_applicable` is Comtrade's own `-1`: the
 * commodity is traded by value alone and there is no quantity to state. It is NOT a
 * missing unit and must not render as one.
 */
export const importQuantityUnitEnum = pgEnum("import_quantity_unit", [
  "not_applicable", // -1 "N/A"
  "square_metres", // 2  "m²"
  "thousand_kilowatt_hours", // 3  "1000 kWh"
  "metres", // 4  "m"
  "units", // 5  "u"
  "pairs", // 6  "2u"
  "litres", // 7  "l"
  "kilograms", // 8  "kg"
  // 9 and 10 were NOT in the first year sampled and were found by the ingest SKIPPING them
  // and saying so — which is the whole reason an unknown unit is counted rather than guessed.
  "thousand_units", // 9  "1000u"    — ceramic bricks and similar
  "packs", // 10 "U (jeu/pack)" — playing cards, sets
  "cubic_metres", // 12 "m³"
  "carats", // 13 "carat"
]);

/**
 * Which way the goods moved.
 *
 * BOTH DIRECTIONS LIVE IN ONE TABLE, and the table is named `commodity_trade_flow`
 * rather than `import_trade_flow` for that reason. An export figure is not decoration
 * here: it is the single hardest-to-fake evidence that a country can already make a
 * thing, and it carries 25 of the feasibility score's 100 points.
 */
export const tradeFlowKindEnum = pgEnum("trade_flow_kind", ["import", "export"]);

export const tradePeriodKindEnum = pgEnum("trade_period_kind", ["annual", "monthly"]);

/**
 * Where a trade row came from. Present from the first migration precisely so a second
 * source never needs one — a purchased dataset (DGCI&S, Volza) arrives as rows with a
 * different `data_origin`, not as an ALTER TABLE against a populated table.
 */
export const tradeDataOriginEnum = pgEnum("trade_data_origin", [
  "comtrade_api",
  "admin_upload",
  "seeded_fixture", // smoke scripts only — never a figure shown to a founder as published
]);

/** How a domestic substitute relates to the import it would replace. */
export const domesticSubstituteKindEnum = pgEnum("domestic_substitute_kind", [
  "direct_material_substitute", // the same material, made domestically
  "alternative_material", // a different material that serves the same function
  "domestic_component", // a sub-assembly available in-country
  "process_change", // no substitute input — a different way of making the thing
]);

/**
 * How proven a substitute is. ORDERED, and the order is scored: `mature` pays the full
 * component and `lab_scale` pays the least, because a substitute that exists only in a
 * paper is evidence of possibility rather than of supply.
 */
export const domesticSubstituteMaturityEnum = pgEnum("domestic_substitute_maturity", [
  "lab_scale",
  "pilot_scale",
  "commercial",
  "mature",
]);

/**
 * Whether the LLM pathway narrative was written for an assessment.
 *
 * `skipped_unconfigured` is a DISTINCT STATE FROM `failed`, the same line
 * `daily_log_analysis_status` draws: "no model key in this environment" is an operator
 * fact, not a failure a founder can act on. A local checkout with no key produces
 * assessments with real scores and no prose, which is the correct outcome.
 */
export const localizationNarrativeStatusEnum = pgEnum("localization_narrative_status", [
  "pending",
  "generated",
  "skipped_unconfigured",
  "failed",
]);

export const localizationPathwayStatusEnum = pgEnum("localization_pathway_status", [
  "open",
  "accepted",
  "dismissed",
]);

/** The outcome of one Comtrade fetch. `skipped_unconfigured` mirrors the narrative rule. */
export const comtradeSyncStatusEnum = pgEnum("comtrade_sync_status", [
  "succeeded",
  "failed",
  "skipped_unconfigured",
]);

/**
 * The HS6 commodity vocabulary — DERIVED FROM THE FEED, not hand-authored.
 *
 * `cmdDesc` arrives with every Comtrade row when `includeDesc=true`, so the labels are
 * the World Customs Organization's own rather than something this codebase invented and
 * would have to maintain. There is no write endpoint: the sync job is the only author,
 * which is what keeps the table free of a moderation status — no submission path, no
 * spam surface, nothing to moderate. Same argument `supplier_capability` makes.
 */
export const importCommodity = pgTable(
  "import_commodity",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    // SIX DIGITS, AND IT IS THE URL IDENTITY. Deliberately NOT slugified: an HS code is
    // issued by the WCO and is already a stable public identifier, so kebab-casing it
    // would mint a second spelling of a thing that has exactly one. §11's casing rule
    // governs identifiers this platform creates, and this is not one.
    hsCode: text("hs_code").notNull(),
    label: text("label").notNull(),
    descriptionText: text("description_text"),
    commodityKind: importCommodityKindEnum("commodity_kind").notNull(),
    // `restrict`, and NOT NULL. An unclassified commodity sits behind no category chip
    // and is unreachable from every surface that filters — invisible rather than
    // neutral. The HS chapter map covers all 97 chapters so this can be total.
    researchCategoryId: text("research_category_id")
      .notNull()
      .references(() => researchCategory.id, { onDelete: "restrict" }),
    // What the feed usually reports this commodity in. The AUTHORITATIVE unit is on the
    // flow row, not here — see the comment there.
    defaultQuantityUnit: importQuantityUnitEnum("default_quantity_unit").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("import_commodity_hsCode_unq").on(table.hsCode),
    // The directory read: listed commodities, ordered by label, ending in a unique
    // column (§4c rule 4).
    index("import_commodity_active_label_idx")
      .on(table.label, table.id)
      .where(sql`is_active`),
    index("import_commodity_kind_idx").on(table.commodityKind),
    index("import_commodity_researchCategoryId_idx").on(table.researchCategoryId),
    check("import_commodity_hsCode_ck", sql`hs_code ~ '^[0-9]{6}$'`),
    check("import_commodity_label_ck", sql`char_length(label) BETWEEN 1 AND 400`),
    check(
      "import_commodity_description_ck",
      sql`description_text IS NULL OR char_length(description_text) <= 4000`,
    ),
  ],
);

/**
 * One country's traded value for one commodity in one period, in one direction.
 *
 * THE PARTNER COLUMN IS NULLABLE AND NULL MEANS "ALL PARTNERS". That is the row the
 * ingest actually writes: Comtrade's `partnerCode=0` aggregate, which is the only figure
 * a localization question needs — how much of this does the country buy from anywhere.
 * Per-partner rows are representable so a later "who do we buy it from" surface needs no
 * migration, and the two partial uniques below are what keep the aggregate unique
 * against itself.
 *
 * EVERY ESTIMATION FLAG COMTRADE SENDS IS STORED. A mirrored estimate and a reported
 * figure are both legitimate data and they are not the same claim, so the surface must be
 * able to say which one it is showing. 2,881 of India's 5,052 import lines carry an
 * estimated net weight; a table that dropped the flag would present all 5,052 as measured.
 */
export const commodityTradeFlow = pgTable(
  "commodity_trade_flow",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    commodityId: text("commodity_id")
      .notNull()
      .references(() => importCommodity.id, { onDelete: "restrict" }),
    // The REPORTING country. Must be a `kind = 'country'` region — a CHECK cannot see
    // another table, so the service enforces it and
    // `db:verify-import-intelligence-constraints` proves the service does.
    reporterRegionId: text("reporter_region_id")
      .notNull()
      .references(() => discoveryRegion.id, { onDelete: "restrict" }),
    // NULL = the all-partners aggregate. See the table comment.
    partnerRegionId: text("partner_region_id").references(() => discoveryRegion.id, {
      onDelete: "restrict",
    }),
    flowKind: tradeFlowKindEnum("flow_kind").notNull(),
    periodKind: tradePeriodKindEnum("period_kind").notNull(),
    periodStartsDate: date("period_starts_date", { mode: "string" }).notNull(),
    periodEndsDate: date("period_ends_date", { mode: "string" }).notNull(),
    // §4b: an amount is never stored without its currency. Comtrade reports in USD and
    // the column records that rather than assuming it, because a later source may not.
    tradeValueInCents: bigint("trade_value_in_cents", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    // NULLABLE, and null is not zero — 679 of India's 5,052 lines have no reported
    // weight. Milli-kilograms because Comtrade sends three decimal places.
    netWeightMilliKilograms: bigint("net_weight_milli_kilograms", { mode: "number" }),
    quantityMilli: bigint("quantity_milli", { mode: "number" }),
    // THE UNIT LIVES ON THE FLOW, NOT ON THE COMMODITY. Re-classifying a commodity is an
    // editorial act and must not silently reinterpret every historical figure filed
    // against it. `import_commodity.default_quantity_unit` is what the seed reaches for;
    // this is what the number actually means.
    quantityUnit: importQuantityUnitEnum("quantity_unit").notNull(),
    // Comtrade's own numeric code, kept beside the enum so a future unit this codebase
    // has not seen can be diagnosed from the row rather than from a log.
    quantityUnitCode: integer("quantity_unit_code").notNull(),
    // --- Estimation provenance, all four as the feed reports them.
    isReported: boolean("is_reported").notNull(),
    isAggregate: boolean("is_aggregate").notNull(),
    isNetWeightEstimated: boolean("is_net_weight_estimated").notNull(),
    isQuantityEstimated: boolean("is_quantity_estimated").notNull(),
    legacyEstimationFlag: integer("legacy_estimation_flag"),
    // --- Where the figure came from. Provenance rides with the number, the same rule
    //     `commerce_freight_rate_card.source_forwarder_name` follows.
    sourceName: text("source_name").notNull(),
    sourceUrl: text("source_url"),
    sourceRetrievedAt: timestamp("source_retrieved_at").notNull(),
    dataOrigin: tradeDataOriginEnum("data_origin").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    // TWO PARTIAL UNIQUES, NOT ONE. A NULL does not collide with a NULL in a Postgres
    // unique index, so a single index over the five columns would happily admit the same
    // all-partners aggregate twice — and the aggregate is the row the ingest writes every
    // time it runs.
    uniqueIndex("commodity_trade_flow_partnered_unq")
      .on(
        table.commodityId,
        table.reporterRegionId,
        table.partnerRegionId,
        table.flowKind,
        table.periodKind,
        table.periodStartsDate,
      )
      .where(sql`partner_region_id IS NOT NULL`),
    uniqueIndex("commodity_trade_flow_aggregate_unq")
      .on(
        table.commodityId,
        table.reporterRegionId,
        table.flowKind,
        table.periodKind,
        table.periodStartsDate,
      )
      .where(sql`partner_region_id IS NULL`),
    // The commodity detail read: one commodity's flows, newest period first.
    index("commodity_trade_flow_commodity_period_idx").on(
      table.commodityId,
      table.flowKind,
      table.periodStartsDate,
      table.id,
    ),
    // The scoring read: every flow for one country and period.
    index("commodity_trade_flow_reporter_period_idx").on(
      table.reporterRegionId,
      table.periodKind,
      table.periodStartsDate,
      table.flowKind,
    ),
    check("commodity_trade_flow_currency_ck", sql`currency ~ '^[A-Z]{3}$'`),
    check("commodity_trade_flow_period_ck", sql`period_ends_date > period_starts_date`),
    // Non-negative, and the NULLs are explicitly permitted rather than coerced.
    check(
      "commodity_trade_flow_magnitudes_ck",
      sql`trade_value_in_cents >= 0
          AND (net_weight_milli_kilograms IS NULL OR net_weight_milli_kilograms >= 0)
          AND (quantity_milli IS NULL OR quantity_milli >= 0)`,
    ),
    // An estimation flag about a value that is not there is not a claim about anything.
    check(
      "commodity_trade_flow_estimation_ck",
      sql`(net_weight_milli_kilograms IS NOT NULL OR is_net_weight_estimated = false)
          AND (quantity_milli IS NOT NULL OR is_quantity_estimated = false)`,
    ),
    check("commodity_trade_flow_source_ck", sql`char_length(source_name) BETWEEN 1 AND 200`),
  ],
);

/**
 * What could be made domestically instead of importing it — the editorial layer.
 *
 * `supplier_capability_id` IS THE WHOLE POINT: it is the join from "this could be made
 * here" to "THESE suppliers can make it", over the vocabulary §11i already seeded. A NULL
 * there is a real finding rather than a gap — no capability in the curated vocabulary
 * covers this substitute yet — and the surface says so instead of hiding the row.
 */
export const domesticSubstituteMapping = pgTable(
  "domestic_substitute_mapping",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    commodityId: text("commodity_id")
      .notNull()
      .references(() => importCommodity.id, { onDelete: "restrict" }),
    // The country doing the substituting.
    regionId: text("region_id")
      .notNull()
      .references(() => discoveryRegion.id, { onDelete: "restrict" }),
    substituteKind: domesticSubstituteKindEnum("substitute_kind").notNull(),
    substituteLabel: text("substitute_label").notNull(),
    substituteNotes: text("substitute_notes"),
    // `restrict` — a curated capability must not vanish out from under a mapping that
    // cites it, the same rule `supplier_capability_link` follows.
    supplierCapabilityId: text("supplier_capability_id").references(() => supplierCapability.id, {
      onDelete: "restrict",
    }),
    maturityLevel: domesticSubstituteMaturityEnum("maturity_level").notNull(),
    evidenceSourceName: text("evidence_source_name"),
    evidenceSourceUrl: text("evidence_source_url"),
    // NULL = draft, the `market_insight` convention. Retirement is unpublishing; there is
    // no DELETE, because a deleted mapping orphans the assessment that counted it.
    publishedAt: timestamp("published_at"),
    // R2: attribution that must never block an account deletion.
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("domestic_substitute_mapping_cell_label_unq").on(
      table.commodityId,
      table.regionId,
      table.substituteLabel,
    ),
    index("domestic_substitute_mapping_published_idx")
      .on(table.commodityId, table.regionId, table.id)
      .where(sql`published_at IS NOT NULL`),
    index("domestic_substitute_mapping_supplierCapabilityId_idx")
      .on(table.supplierCapabilityId)
      .where(sql`supplier_capability_id IS NOT NULL`),
    check(
      "domestic_substitute_mapping_label_ck",
      sql`char_length(substitute_label) BETWEEN 1 AND 200`,
    ),
    check(
      "domestic_substitute_mapping_notes_ck",
      sql`substitute_notes IS NULL OR char_length(substitute_notes) <= 4000`,
    ),
    check(
      "domestic_substitute_mapping_evidence_ck",
      sql`(evidence_source_name IS NULL OR char_length(evidence_source_name) BETWEEN 1 AND 200)
          AND (evidence_source_url IS NULL OR evidence_source_name IS NOT NULL)`,
    ),
  ],
);

/**
 * The nightly feasibility snapshot — one row per (commodity, country, asOf).
 *
 * DELIBERATELY SHAPED LIKE `demand_signal_snapshot`, down to the trend-agreement CHECK.
 * Two derived scores over overlapping evidence that ordered it differently would let the
 * same commodity rank one way here and another in the knowledge hub, and no local
 * cleverness is worth that contradiction.
 *
 * EVERY RAW INPUT AND EVERY COMPONENT SUB-SCORE IS STORED. The sub-scores are what let
 * the UI render "27 of 35" instead of an unfalsifiable total, and the raw inputs are what
 * make last night's number reproducible after the ladder is retuned —
 * `score_algorithm_version` says which ladder produced it.
 */
export const localizationAssessment = pgTable(
  "localization_assessment",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    asOf: timestamp("as_of").notNull(),
    windowStartsAt: timestamp("window_starts_at").notNull(),
    windowEndsAt: timestamp("window_ends_at").notNull(),
    commodityId: text("commodity_id")
      .notNull()
      .references(() => importCommodity.id, { onDelete: "restrict" }),
    regionId: text("region_id")
      .notNull()
      .references(() => discoveryRegion.id, { onDelete: "restrict" }),
    feasibilityScorePoints: integer("feasibility_score_points").notNull(),
    rank: integer("rank").notNull(),
    trendDirection: trendDirectionEnum("trend_direction").notNull(),
    // NULL on a cell's first-ever assessment, where there is no evidence of a direction.
    // NOT interchangeable with 0 — see the trend-agreement CHECK below.
    previousFeasibilityScorePoints: integer("previous_feasibility_score_points"),
    // --- The five components, stored so the total is falsifiable.
    importDependencyPoints: integer("import_dependency_points").notNull(),
    exportCapabilityPoints: integer("export_capability_points").notNull(),
    substituteAvailabilityPoints: integer("substitute_availability_points").notNull(),
    supplierCapacityPoints: integer("supplier_capacity_points").notNull(),
    leadTimeAdvantagePoints: integer("lead_time_advantage_points").notNull(),
    // --- The raw inputs, same reproducibility argument as `demand_signal_snapshot`.
    observedImportValueInCents: bigint("observed_import_value_in_cents", {
      mode: "number",
    }).notNull(),
    observedExportValueInCents: bigint("observed_export_value_in_cents", {
      mode: "number",
    }).notNull(),
    currency: text("currency").notNull(),
    substituteCount: integer("substitute_count").notNull(),
    matchedSupplierCount: integer("matched_supplier_count").notNull(),
    verifiedSupplierCount: integer("verified_supplier_count").notNull(),
    // NULLABLE — null is "no supplier published a lead time", never "zero days".
    medianSupplierLeadTimeDays: integer("median_supplier_lead_time_days"),
    narrativeStatus: localizationNarrativeStatusEnum("narrative_status")
      .default("pending")
      .notNull(),
    scoreAlgorithmVersion: integer("score_algorithm_version").default(1).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("localization_assessment_asOf_cell_unq").on(
      table.asOf,
      table.commodityId,
      table.regionId,
    ),
    uniqueIndex("localization_assessment_asOf_region_rank_unq").on(
      table.asOf,
      table.regionId,
      table.rank,
    ),
    index("localization_assessment_cell_asOf_idx").on(
      table.commodityId,
      table.regionId,
      table.asOf,
      table.id,
    ),
    check("localization_assessment_rank_ck", sql`rank >= 1`),
    check(
      "localization_assessment_score_ck",
      sql`feasibility_score_points BETWEEN 0 AND 100
          AND (previous_feasibility_score_points IS NULL
               OR previous_feasibility_score_points BETWEEN 0 AND 100)`,
    ),
    check(
      "localization_assessment_window_ck",
      sql`window_ends_at > window_starts_at AND as_of >= window_ends_at`,
    ),
    // THE COMPONENTS MUST SUM TO THE TOTAL. Without this the sub-scores are decoration
    // and a UI rendering "27 of 35" could contradict the number beside it.
    check(
      "localization_assessment_components_ck",
      sql`import_dependency_points BETWEEN 0 AND 35
          AND export_capability_points BETWEEN 0 AND 25
          AND substitute_availability_points BETWEEN 0 AND 20
          AND supplier_capacity_points BETWEEN 0 AND 12
          AND lead_time_advantage_points BETWEEN 0 AND 8
          AND import_dependency_points + export_capability_points
              + substitute_availability_points + supplier_capacity_points
              + lead_time_advantage_points = feasibility_score_points`,
    ),
    check(
      "localization_assessment_inputs_ck",
      sql`observed_import_value_in_cents >= 0 AND observed_export_value_in_cents >= 0
          AND substitute_count >= 0 AND matched_supplier_count >= 0
          AND verified_supplier_count >= 0
          AND verified_supplier_count <= matched_supplier_count
          AND (median_supplier_lead_time_days IS NULL
               OR median_supplier_lead_time_days BETWEEN 0 AND 3650)
          AND currency ~ '^[A-Z]{3}$'`,
    ),
    // The arrow and the evidence for it cannot disagree.
    check(
      "localization_assessment_trend_agreement_ck",
      sql`previous_feasibility_score_points IS NULL
          OR (trend_direction = 'up'
              AND feasibility_score_points > previous_feasibility_score_points)
          OR (trend_direction = 'down'
              AND feasibility_score_points < previous_feasibility_score_points)
          OR (trend_direction = 'flat'
              AND feasibility_score_points = previous_feasibility_score_points)`,
    ),
  ],
);

/**
 * The LLM's localization pathway, written OVER a score it did not compute.
 *
 * `optimization_suggestion`'s shape exactly, for the same reason: it suggests, it never
 * decides. Nothing here writes a score, a rank or a trade figure, and the model is handed
 * the arithmetic in its prompt precisely so it cannot contradict it.
 *
 * PROVENANCE IS NOT OPTIONAL. `model_name` and `prompt_version` are NOT NULL because a
 * machine opinion whose origin is hidden reads as a platform ruling. `confidence_bps`
 * being NULL means NO CONFIDENCE WAS RECORDED — it is not zero confidence.
 */
export const localizationPathwaySuggestion = pgTable(
  "localization_pathway_suggestion",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    // `restrict` — the assessment is the evidence this row is about, and a suggestion
    // whose evidence vanished is an unfalsifiable claim.
    assessmentId: text("assessment_id")
      .notNull()
      .references(() => localizationAssessment.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    bodyText: text("body_text").notNull(),
    status: localizationPathwayStatusEnum("status").default("open").notNull(),
    modelName: text("model_name").notNull(),
    modelVersion: text("model_version"),
    promptVersion: text("prompt_version").notNull(),
    confidenceBps: integer("confidence_bps"),
    asOf: timestamp("as_of").notNull(),
    decidedByUserId: text("decided_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    decidedAt: timestamp("decided_at"),
    decisionNote: text("decision_note"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("localization_pathway_suggestion_assessment_status_idx").on(
      table.assessmentId,
      table.status,
      table.id,
    ),
    check(
      "localization_pathway_suggestion_text_ck",
      sql`char_length(title) BETWEEN 1 AND 200 AND char_length(body_text) BETWEEN 1 AND 6000`,
    ),
    check(
      "localization_pathway_suggestion_confidence_ck",
      sql`confidence_bps IS NULL OR confidence_bps BETWEEN 0 AND 10000`,
    ),
    check(
      "localization_pathway_suggestion_decision_ck",
      sql`(status = 'open') = (decided_at IS NULL)
          AND (decided_at IS NULL) = (decided_by_user_id IS NULL)`,
    ),
  ],
);

/**
 * One Comtrade fetch, recorded.
 *
 * A FEED WITH NO RECORD OF WHAT IT PULLED CANNOT BE DEBUGGED. This is also where "there
 * was no API key" is written down: without it, an unconfigured environment produces an
 * empty surface and no evidence of why, which is indistinguishable from a country that
 * imports nothing.
 */
export const comtradeSyncRun = pgTable(
  "comtrade_sync_run",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    reporterRegionId: text("reporter_region_id")
      .notNull()
      .references(() => discoveryRegion.id, { onDelete: "restrict" }),
    // The calendar year requested, as a plain integer — a sync is scoped to a period, not
    // to an instant, and `2023` is the whole of the request.
    periodYear: integer("period_year").notNull(),
    flowKind: tradeFlowKindEnum("flow_kind").notNull(),
    status: comtradeSyncStatusEnum("status").notNull(),
    requestedAt: timestamp("requested_at").notNull(),
    completedAt: timestamp("completed_at"),
    rowsFetched: integer("rows_fetched").default(0).notNull(),
    rowsUpserted: integer("rows_upserted").default(0).notNull(),
    // The provider's own message, never a paraphrase — a rewritten error is a lost error.
    errorDetail: text("error_detail"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("comtrade_sync_run_cell_requestedAt_idx").on(
      table.reporterRegionId,
      table.periodYear,
      table.flowKind,
      table.requestedAt,
    ),
    check("comtrade_sync_run_period_ck", sql`period_year BETWEEN 1962 AND 2100`),
    check("comtrade_sync_run_counts_ck", sql`rows_fetched >= 0 AND rows_upserted >= 0`),
    check(
      "comtrade_sync_run_completion_ck",
      sql`(status <> 'succeeded' OR completed_at IS NOT NULL)
          AND (error_detail IS NULL OR char_length(error_detail) BETWEEN 1 AND 2000)`,
    ),
  ],
);

// --- §10A relations. Child-side only, the convention every section above follows.

export const importCommodityRelations = relations(importCommodity, ({ one }) => ({
  researchCategory: one(researchCategory, {
    fields: [importCommodity.researchCategoryId],
    references: [researchCategory.id],
  }),
}));

export const commodityTradeFlowRelations = relations(commodityTradeFlow, ({ one }) => ({
  commodity: one(importCommodity, {
    fields: [commodityTradeFlow.commodityId],
    references: [importCommodity.id],
  }),
  reporterRegion: one(discoveryRegion, {
    fields: [commodityTradeFlow.reporterRegionId],
    references: [discoveryRegion.id],
    relationName: "tradeFlowReporterRegion",
  }),
  partnerRegion: one(discoveryRegion, {
    fields: [commodityTradeFlow.partnerRegionId],
    references: [discoveryRegion.id],
    relationName: "tradeFlowPartnerRegion",
  }),
}));

export const domesticSubstituteMappingRelations = relations(
  domesticSubstituteMapping,
  ({ one }) => ({
    commodity: one(importCommodity, {
      fields: [domesticSubstituteMapping.commodityId],
      references: [importCommodity.id],
    }),
    region: one(discoveryRegion, {
      fields: [domesticSubstituteMapping.regionId],
      references: [discoveryRegion.id],
    }),
    supplierCapability: one(supplierCapability, {
      fields: [domesticSubstituteMapping.supplierCapabilityId],
      references: [supplierCapability.id],
    }),
  }),
);

export const localizationAssessmentRelations = relations(localizationAssessment, ({ one }) => ({
  commodity: one(importCommodity, {
    fields: [localizationAssessment.commodityId],
    references: [importCommodity.id],
  }),
  region: one(discoveryRegion, {
    fields: [localizationAssessment.regionId],
    references: [discoveryRegion.id],
  }),
}));

export const localizationPathwaySuggestionRelations = relations(
  localizationPathwaySuggestion,
  ({ one }) => ({
    assessment: one(localizationAssessment, {
      fields: [localizationPathwaySuggestion.assessmentId],
      references: [localizationAssessment.id],
    }),
    decidedBy: one(user, {
      fields: [localizationPathwaySuggestion.decidedByUserId],
      references: [user.id],
    }),
  }),
);

export const comtradeSyncRunRelations = relations(comtradeSyncRun, ({ one }) => ({
  reporterRegion: one(discoveryRegion, {
    fields: [comtradeSyncRun.reporterRegionId],
    references: [discoveryRegion.id],
  }),
}));
