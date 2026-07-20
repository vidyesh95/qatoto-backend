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
  customType,
} from "drizzle-orm/pg-core";

// Case-insensitive text (Postgres `citext`). Used for the email columns so that
// equality AND the UNIQUE constraint compare case-insensitively: two providers
// reporting the same address in different case (Google "User@x.com", GitHub
// "user@x.com") resolve to ONE user via Better Auth's email lookup instead of
// minting a duplicate row. Requires the `citext` extension, created in the
// migration that introduces this type. See src/lib/auth.ts accountLinking.
const citext = customType<{ data: string }>({
  dataType() {
    return "citext";
  },
});

// Provenance of `user.image`. "oauth" = seeded from a Google/GitHub profile;
// "user" = the user uploaded their own photo (PATCH /users/me/photo). NULL = no
// image. "user" is a lock: OAuth must never overwrite a user-owned photo, exactly
// like nameSetByUser guards the display name. See src/lib/auth.ts databaseHooks.
export const imageSourceEnum = pgEnum("image_source", ["oauth", "user"]);

// Platform-wide staff role, NOT project-scoped (R_AND_D_BACKEND_STRUCTURE.md §4a
// Layer 3). NULL for ordinary users, which is almost everyone.
export const platformRoleEnum = pgEnum("platform_role", ["moderator", "auditor", "admin"]);

export const user = pgTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    // True once the user explicitly set their own name (PATCH /users/me). OAuth
    // seeds `name` at first sign-in; this flag marks it as user-owned so account
    // linking never overwrites it. See src/lib/auth.ts accountLinking.
    nameSetByUser: boolean("name_set_by_user").default(false).notNull(),
    // citext (case-insensitive) + UNIQUE: one email = one user, regardless of the
    // case a provider reports it in. See the `citext` type note above.
    email: citext("email").notNull().unique(),
    emailVerified: boolean("email_verified").default(false).notNull(),
    image: text("image"),
    // Who owns `image` — see imageSourceEnum. NULL until an image is set.
    imageSource: imageSourceEnum("image_source"),
    // The user's current active handle (stored normalized: lowercased, no leading
    // "@"). UNIQUE so two users can never hold the same handle; NULL until claimed
    // (Postgres UNIQUE permits many NULLs). The leading "@" is a display concern the
    // client adds — never stored here. Exposed on the session via Better Auth
    // additionalFields (src/lib/auth.ts) so session.user.handle drives menu/avatar.
    handle: text("handle").unique(),
    // Timestamp of the last successful handle change. NULL until first change.
    handleUpdatedAt: timestamp("handle_updated_at"),
    // Rate-limit bookkeeping: how many changes the user has made inside the CURRENT
    // 14-day window, and when that window opened. A change consumes one; at
    // MAX_HANDLE_CHANGES_PER_WINDOW the user is locked until windowStartedAt + 14d.
    // See src/services/handle.service.ts (computeRateLimitWindow). The server is the
    // sole authority for this (CLAUDE.md §1.1) — the client only previews the lock.
    handleChangeCount: integer("handle_change_count").default(0).notNull(),
    handleWindowStartedAt: timestamp("handle_window_started_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    isAnonymous: boolean("is_anonymous").default(false),
    // §4a Layer 3. NULL for ordinary users. There is deliberately NO endpoint, no Zod
    // schema and no Better Auth additionalField that writes this: a self-grantable
    // staff role would defeat category moderation and the §7 four-eyes escrow rule at
    // once. Grants are a DBA action. Keep it OUT of every public user projection and
    // out of src/lib/auth.ts additionalFields, which would put it on the
    // client-visible session.
    platformRole: platformRoleEnum("platform_role"),
  },
  (table) => [
    // Partial: staff are a handful of rows out of the whole user table, so the index
    // only carries them.
    index("user_platformRole_idx")
      .on(table.platformRole)
      .where(sql`platform_role IS NOT NULL`),
  ],
);

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    // The email this provider knows the user by — the address shown next to each
    // "Connected" provider in the settings panel. NULL on purpose: credential rows
    // resolve their email from user.email (never stored here, so it can't drift),
    // and pre-existing OAuth rows stay NULL until the backfill (or a fresh sign-in)
    // populates them. Write-once at account creation from the provider profile
    // (Google id_token email claim / GitHub primary verified email) — see the
    // account.create hook in src/lib/auth.ts. NOT a login identifier and
    // deliberately NOT unique: two providers can legitimately report the same
    // address. Never expose alongside tokens. See GET /users/me/linked-accounts.
    // citext to match user.email's case-insensitive semantics.
    email: citext("email"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const passkey = pgTable(
  "passkey",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    publicKey: text("public_key").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    credentialID: text("credential_id").notNull(),
    counter: integer("counter").notNull(),
    deviceType: text("device_type").notNull(),
    backedUp: boolean("backed_up").notNull(),
    transports: text("transports"),
    aaguid: text("aaguid"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("passkey_userId_idx").on(table.userId)],
);

// A handle a user PREVIOUSLY held, parked for 14 days after they changed away
// from it. While the row exists with expires_at > NOW() it is (a) blocked from
// anyone else claiming it and (b) revertable by its owner (Case 2). Once
// expires_at < NOW() the hold is dead: it reads as available to everyone and is
// lazy-deleted on the next touch (plus a daily cron sweep). reserved_handle is
// the PK — it is the normalized handle string, so the table can hold at most one
// reservation per handle, mirroring user.handle's UNIQUE.
export const handleReservation = pgTable(
  "handle_reservations",
  {
    reservedHandle: text("reserved_handle").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("handle_reservations_userId_idx").on(table.userId),
    index("handle_reservations_expiresAt_idx").on(table.expiresAt),
  ],
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  passkeys: many(passkey),
  handleReservations: many(handleReservation),
}));

export const handleReservationRelations = relations(handleReservation, ({ one }) => ({
  user: one(user, {
    fields: [handleReservation.userId],
    references: [user.id],
  }),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));

export const passkeyRelations = relations(passkey, ({ one }) => ({
  user: one(user, {
    fields: [passkey.userId],
    references: [user.id],
  }),
}));

// ---------------------------------------------------------------------------
// Store / commerce domain (product listings). See STORE_BACKEND_STRUCTURE.md.
//
// ID STRATEGY — deliberate deviation from the auth tables. Auth rows carry ids
// minted by Better Auth (`text("id").primaryKey()`, no DB default). These
// commerce tables are ours and Better Auth never touches them, so they
// self-generate opaque `text` ids via randomUUID at insert time — still string
// ids to stay consistent with the rest of the schema.
// ---------------------------------------------------------------------------

// The listing's product category. Stored as slugs; the wizard maps its display
// labels ("Home & Kitchen") to these (home_kitchen). Enum so Postgres rejects
// any value the app doesn't know about.
export const productCategoryEnum = pgEnum("product_category", [
  "electronics",
  "fashion",
  "home_kitchen",
  "anime_collectibles",
  "digital_goods",
  "books_media",
  "sports_outdoors",
  "beauty_personal_care",
]);

// Physical condition of the item. Wizard's New/Refurbished/Used, lowercased.
export const productConditionEnum = pgEnum("product_condition", ["new", "refurbished", "used"]);

// Listing lifecycle. `draft` = seller is still building it / abandoned the
// wizard (visible only to them); `active` = published, buyer-visible. The
// draft→active transition is gated server-side (POST /products/:id/publish).
export const productStatusEnum = pgEnum("product_status", ["draft", "active"]);

// A product listing, owned by exactly one seller.
export const product = pgTable(
  "product",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    // Owner. Stamped from req.user.id at create — NEVER from the body
    // (CLAUDE.md §1.1). Cascade so deleting a user removes their listings.
    sellerId: text("seller_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    brand: text("brand"),
    category: productCategoryEnum("category").notNull(),
    condition: productConditionEnum("condition").default("new").notNull(),
    description: text("description"),
    // Money in integer cents. Server-authoritative; the client sends cents,
    // never dollars — no floating-point money in the DB or on the wire.
    priceInCents: integer("price_in_cents").notNull(),
    compareAtPriceInCents: integer("compare_at_price_in_cents"),
    // Server-owned; the wizard hardcodes "$". Not client-writable.
    currency: text("currency").default("USD").notNull(),
    stockQuantity: integer("stock_quantity").default(0).notNull(),
    sku: text("sku"),
    // Short ordered display bullets ("30-hour battery life"). A text[] column,
    // NOT a table: no identity/relationships/queries of their own. Promote to a
    // table only if features ever grow attributes.
    keyFeatures: text("key_features").array().notNull().default([]),
    status: productStatusEnum("status").default("draft").notNull(),
    // NULL until first published; set on the draft→active transition.
    publishedAt: timestamp("published_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("product_sellerId_idx").on(table.sellerId),
    index("product_status_idx").on(table.status),
    // A seller can't reuse one SKU across their own listings. Postgres UNIQUE
    // permits many NULLs, so SKU stays optional.
    uniqueIndex("product_seller_sku_unq").on(table.sellerId, table.sku),
  ],
);

// A product's images. Two-phase upload: the listing is created first, then
// images are attached one at a time. `position` orders them; position 0 is the
// main image (the wizard's "Main image" badge on the first tile).
export const productImage = pgTable(
  "product_image",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    productId: text("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "cascade" }),
    // Cloudinary secure_url of the normalized asset.
    url: text("url").notNull(),
    // 0 = main listing photo. Contiguous per product; re-packed on delete.
    position: integer("position").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("product_image_productId_idx").on(table.productId)],
);

// B2B volume pricing — buy at least `minimumOrderQuantity` to get
// `unitPriceInCents`. Supported now even though the create wizard doesn't
// collect it yet (STORE_BACKEND_STRUCTURE.md §11).
export const productPricingTier = pgTable(
  "product_pricing_tier",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    productId: text("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "cascade" }),
    unitPriceInCents: integer("unit_price_in_cents").notNull(),
    minimumOrderQuantity: integer("minimum_order_quantity").notNull(),
    // Display order of the tier ladder.
    position: integer("position").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("product_pricing_tier_productId_idx").on(table.productId)],
);

export const productRelations = relations(product, ({ one, many }) => ({
  seller: one(user, { fields: [product.sellerId], references: [user.id] }),
  images: many(productImage),
  pricingTiers: many(productPricingTier),
}));

export const productImageRelations = relations(productImage, ({ one }) => ({
  product: one(product, { fields: [productImage.productId], references: [product.id] }),
}));

export const productPricingTierRelations = relations(productPricingTier, ({ one }) => ({
  product: one(product, { fields: [productPricingTier.productId], references: [product.id] }),
}));

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
// founder write a payout promise the escrow engine will not honour. Clients map the
// enum to localized copy.
export const compensationEarnedAsPolicyEnum = pgEnum("compensation_earned_as_policy", [
  "milestone_escrow_release",
  "on_completion_escrow_release",
  "slicing_pie_vesting",
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
    // §5: "A founder cannot advertise a payout mechanism the escrow engine will not
    // execute." Equity vests through Slicing Pie; cash pays out of escrow.
    check(
      "open_role_compensation_policy_pairing_ck",
      sql`
      (kind = 'equity' AND earned_as_policy = 'slicing_pie_vesting')
      OR (kind IN ('salary','one_time')
          AND earned_as_policy IN ('milestone_escrow_release','on_completion_escrow_release'))`,
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

// --- Relations. Declared CHILD-SIDE ONLY, matching the store domain's precedent:
// product declares `seller: one(user, …)` and userRelations was deliberately left
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
