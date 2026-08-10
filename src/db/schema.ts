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
// Self-referential and mutually-referential FKs need this annotation or TypeScript
// recurses forever inferring the column type. Used by discoveryRegion.parentRegionId,
// problemCluster.mergedIntoClusterId and problemCluster.currentScoreSnapshotId.
import type { AnyPgColumn } from "drizzle-orm/pg-core";

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

// Postgres' full-text search document type, backing `video.searchDocument`.
//
// IT IS NEVER READ OR WRITTEN BY THE APPLICATION — the column is GENERATED ALWAYS, so
// Postgres computes it and an INSERT or UPDATE that mentions it is an error. The type
// exists so drizzle-kit knows the column is there and does not try to add it on every
// `generate`; `data: string` is the shape the driver would hand back if anyone ever
// selected it, which nothing does.
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
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
    // A free-text, self-set place ("Pune, India"). NULL until the user sets one.
    //
    // A CLAIM, NOT A FACT, and every surface that renders it must read as one. It is
    // not geocoded, not verified, and deliberately NOT the geo signal for anything:
    // §6's problem submissions carry their own resolved coordinates from
    // `geocode_cache`, and CLAUDE.md §1.1 forbids trusting a client-claimed country
    // for tax, pricing, fraud or geo-restriction. This column exists so a §10
    // discussion post can say where its author says they are — nothing else may read
    // it.
    locationLabel: text("location_label"),
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
    // Server-selected commerce tenant context. Nullable for users with no commerce
    // membership and during the Phase 0 expand rollout. Every request using it must
    // still re-check an active membership; possession of a session is not authorization.
    activeOrganizationId: text("active_organization_id").references(
      (): AnyPgColumn => commerceOrganization.id,
      { onDelete: "set null" },
    ),
  },
  (table) => [
    index("session_userId_idx").on(table.userId),
    index("session_activeOrganizationId_idx")
      .on(table.activeOrganizationId)
      .where(sql`active_organization_id IS NOT NULL`),
  ],
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

// One rate-limit window, shared by every API instance (§11l.2 item 7). The per-process
// MemoryStore express-rate-limit ships with is not a bound once more than one instance
// runs, and it resets on every restart — a deploy handed an attacker a fresh OTP budget.
//
// COMPOSITE PK, not a concatenated "namespace:key" string, and that is a security choice
// rather than a style one. `emailKey` in src/middleware/rate-limit.ts derives its key from
// the request BODY, so with a delimiter an email of "otpRequestIp:1.2.3.4" would land in
// the per-IP limiter's bucket. Two columns cannot be collided that way. It also makes
// resetAll a PK-prefix DELETE and lets `GROUP BY namespace` name the hot limiter.
//
// NO SURROGATE ID: nothing references a bucket, so a uuid would be dead weight and a
// randomUUID() call on a hot path. NO created_at: the row is UPDATEd in place across many
// windows, so it would record the first hit ever rather than this window's start — a
// reader would take it for the window start and be wrong. The window start is
// `expires_at` minus the limiter's windowMs. NO FK to `user`: the key is a user id OR an
// IP OR an email, so two of the three could never satisfy one.
//
// This is a CACHE, not a ledger. Truncating it resets every live window and nothing else.
export const rateLimitBucket = pgTable(
  "rate_limit_bucket",
  {
    /** The limiter's own name. One namespace per limiter; duplicates throw at boot. */
    namespace: text("namespace").notNull(),
    /** The keyGenerator's output — a user id, an IP, or a hash of an oversized key. */
    bucketKey: text("bucket_key").notNull(),
    hitCount: integer("hit_count").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.namespace, table.bucketKey] }),
    // For the retention sweep. Live keys rewrite their own row, so only ABANDONED keys
    // accumulate — but a cache still must not grow forever.
    index("rate_limit_bucket_expiresAt_idx").on(table.expiresAt),
    // An assertion that the store's key normalizer ran, not a validation of user input.
    // `emailKey` reads an unbounded body field, and a btree index row caps at ~2704 bytes,
    // so an oversized key would be an attacker-triggerable write failure on the OTP path.
    // The store hashes anything longer to `sha256:<hex>` before it reaches SQL.
    check("rate_limit_bucket_key_ck", sql`char_length(bucket_key) BETWEEN 1 AND 256`),
    check("rate_limit_bucket_hits_ck", sql`hit_count >= 0`),
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
  activeOrganization: one(commerceOrganization, {
    fields: [session.activeOrganizationId],
    references: [commerceOrganization.id],
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

// LEGACY, AND NO LONGER THE TAXONOMY. These eight values were the original root
// categories; migration 0098 retired all eight `commerce_category` rows behind them
// and made `product.category` nullable, because the root set the store actually
// browses (clothes, furniture, accessories, …) has no member here and an enum
// cannot grow a value from an admin screen.
//
// Kept only so rows written before 0098 still read back, and so an old client
// sending `category` is answered rather than 500'd. `commerce_category.id` is the
// taxonomy; see STORE_BACKEND_STRUCTURE.md §4.3 step 5 for the removal release.
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

export const commerceOrganizationTypeEnum = pgEnum("commerce_organization_type", [
  "company",
  "sole_proprietor",
  "cooperative",
  "government",
  "nonprofit",
]);

export const commerceOrganizationTradeStateEnum = pgEnum("commerce_organization_trade_state", [
  "pending",
  "active",
  "suspended",
  "closed",
]);

export const commerceOrganizationVisibilityEnum = pgEnum("commerce_organization_visibility", [
  "private",
  "public",
]);

export const commerceOrganizationMemberRoleEnum = pgEnum("commerce_organization_member_role", [
  "owner",
  "administrator",
  "buyer",
  "seller",
  "provider_operator",
  "finance",
  "support",
  "viewer",
]);

export const commerceOrganizationMemberStateEnum = pgEnum("commerce_organization_member_state", [
  "invited",
  "active",
  "suspended",
  "left",
]);

/**
 * `delivery` arrived with Phase 11 (Appendix A15). Until then there was no kind meaning
 * "send the goods here", which is why `assertOwnedDeliveryAddress` filtered on id and
 * organization only and a seller's registered office could be a buyer's delivery
 * address. Appended, not inserted: `ALTER TYPE ... ADD VALUE` puts new labels last.
 */
export const commerceOrganizationAddressKindEnum = pgEnum("commerce_organization_address_kind", [
  "billing",
  "registered",
  "warehouse",
  "pickup",
  "return",
  "delivery",
]);

export const commerceVerificationKindEnum = pgEnum("commerce_verification_kind", [
  "business_registration",
  "tax_registration",
  "identity",
  "address",
  "bank_account",
]);

export const commerceVerificationStateEnum = pgEnum("commerce_verification_state", [
  "pending",
  "approved",
  "rejected",
  "superseded",
]);

export const commerceCategoryStateEnum = pgEnum("commerce_category_state", [
  "draft",
  "active",
  "retired",
]);

/**
 * The lifecycle of a SELLER'S REQUEST for a category that does not exist yet.
 *
 * A SEPARATE ENUM ON A SEPARATE TABLE, deliberately — this is not a fourth
 * `commerce_category_state`. A proposal is not a category: it has a requester, a
 * justification and a reviewer, it carries no `siblingOrder` (which is NOT NULL and
 * unique per parent, so a proposal would need a fabricated one), and above all it must
 * never be reachable by the browse tree. Sellers can write here; nobody can write
 * `commerce_category` without `moderate_commerce`.
 *
 * Terminal on both arms. Deciding an already-decided request is a 409 naming the state
 * it holds — another moderator got there first, which is a finding and not a retry.
 */
export const commerceCategoryRequestStateEnum = pgEnum("commerce_category_request_state", [
  "pending",
  "approved",
  "rejected",
]);

export const commerceDocumentKindEnum = pgEnum("commerce_document_kind", [
  "business_registration",
  "tax_registration",
  "identity",
  "address_proof",
  "bank_evidence",
  "other",
  /**
   * A18. Buyer-supplied artwork for a customization slot. Private and encrypted like
   * verification evidence rather than a public Cloudinary image: it is the buyer's
   * commercial material, and only the fulfilling seller has any reason to open it.
   */
  "customization_artwork",
  /**
   * A13. The scan behind an ISO / CE / RoHS certification claim. Private for the same
   * reason business registration is: a certificate carries registration numbers, site
   * addresses and signatures. The PUBLIC projection of an approved certification is
   * metadata only and never references this document.
   */
  "certification_evidence",
  /**
   * A30/A27. A drawing, specification or photo a trading party attaches to an RFQ or to
   * a thread message.
   *
   * ONE kind rather than an rfq/message pair: which resource it hangs off is a fact the
   * LINK tables record (`commerce_rfq_document`, `commerce_message_attachment`), and the
   * same drawing legitimately rides both — a buyer attaches it to the sourcing request
   * and then sends it again in the negotiation thread.
   */
  "trade_attachment",
]);

export const commerceDocumentStateEnum = pgEnum("commerce_document_state", [
  "pending_scan",
  "available",
  "quarantined",
  "deleted",
]);

export const commerceOrganizationAuditEventKindEnum = pgEnum(
  "commerce_organization_audit_event_kind",
  [
    "organization_created",
    "organization_updated",
    "trade_state_changed",
    "visibility_changed",
    "member_invited",
    "member_state_changed",
    "member_role_changed",
    "address_changed",
    "document_uploaded",
    "document_state_changed",
    /**
     * A30. A30's download route decrypts and streams bytes belonging to another
     * organization, and A15 settled that every such read is an auditable event rather
     * than a silent one. The owner reading its own document is NOT audited — that is
     * the same line `revealOrderDeliveryAddress` draws.
     */
    "document_downloaded",
    "verification_decided",
    "rfq_opened",
    "rfq_closed",
    "rfq_awarded",
    "quote_submitted",
    "quote_accepted",
    "quote_declined",
    "quote_withdrawn",
    "order_created_from_quote",
    "cart_line_updated",
    "cart_line_removed",
    "checkout_prepared",
    "checkout_confirmed",
    "inventory_reservation_released",
    "order_created_from_checkout",
    "order_cancelled",
    "shipment_created",
    "shipment_event_recorded",
    "service_engagement_created",
    "service_engagement_transitioned",
    "payment_intent_created",
    "payment_intent_settled",
    "payment_intent_failed",
    "payment_refund_created",
    "payment_refund_settled",
    "payment_refund_failed",
    "shipment_leg_created",
    "shipment_leg_command_executed",
    "service_engagement_command_executed",
    "engagement_deliverable_submitted",
    "engagement_deliverable_reviewed",
    "engagement_deliverables_normalized",
    "completion_issued",
    "review_created",
    "dispute_opened",
    "dispute_decided",
    /**
     * Phase 8 (§15.3). A compatibility claim is a safety claim in the categories
     * where it matters — brake parts, electrical, load-bearing hardware — so both
     * the seller's assertion and the moderator's promotion of it are auditable.
     */
    "product_relations_declared",
    "product_relation_verified",
    /**
     * Phase 9 (§15.5, §15.8). A set is merchandising a buyer acts on, so who composed
     * it, who submitted it and who decided it are all auditable. Platform-curated sets
     * have no owning organization and therefore no entry here — their reviewer
     * attribution on the row itself is the record.
     */
    "pathway_created",
    "pathway_updated",
    "pathway_slots_replaced",
    "pathway_candidates_replaced",
    "pathway_submitted",
    "pathway_moderated",
    "cart_seeded_from_pathway",
    /**
     * Phase 11 (Appendix A15, A17).
     *
     * `delivery_address_revealed` is THE FIRST READ EVENT in this enum — every kind
     * above it records a write. That is deliberate: §14 chose an authorized decrypt
     * path over a seller-openable snapshot precisely because a decrypt can be logged,
     * and a log nobody writes is not an argument.
     */
    "delivery_address_revealed",
    "sample_credit_minted",
    "sample_credit_consumed",
    "product_customization_options_replaced",
    /**
     * Phase 10 (Appendix A8, A14).
     *
     * NOTE WHAT IS NOT HERE: a helpful vote. It carries no commercial consequence and
     * nothing a moderator or a court would read, and at the vote route's 60/min budget
     * it would become the largest table in the audit log. The omission is a decision.
     *
     * Payloads for the media kinds use mediaId / reviewId / mediaKind / position and
     * NEVER filename, objectKey or publicId — `FORBIDDEN_PAYLOAD_KEY` matches
     * `filename` and `object.*key` and throws, which is how `addressKind` took down
     * address creation in Phase 11.
     */
    "review_media_attached",
    "review_media_detached",
    "review_reply_published",
    "review_reply_withdrawn",
    "product_inquiry_opened",
    /**
     * Phase 12 (Appendix A13). Seller-declared company depth, and the certifications a
     * moderator approves before any of it is presented as checked.
     *
     * The payload convention above applies unchanged and is why
     * `organization_media_changed` carries mediaId / mediaKind / position: a Cloudinary
     * upload's natural payload key is `filename`, which `FORBIDDEN_PAYLOAD_KEY` matches,
     * and `publicId` is a storage handle an audit log has no reason to hold.
     *
     * `certification_submitted` carries certificationId / standardName and NOT the
     * evidence object key — `object.*key` is matched too. The evidence is reachable from
     * the certification row; duplicating its location into immutable history only widens
     * where a private document's address is written down.
     */
    "seller_profile_updated",
    "organization_media_changed",
    "site_access_changed",
    "stakeholders_changed",
    "capabilities_changed",
    "certification_submitted",
    "certification_decided",
    /** Phase 17. The manufacturer directory's two seller-owned collections (§16.3). */
    "production_lines_changed",
    "sites_changed",
    /**
     * Phase 17. Staff-written, and mirrored into `platform_audit_entry` — this row records
     * the fact against the ORGANIZATION, the platform chain records the accountable human.
     */
    "site_audit_recorded",
    "site_audit_withdrawn",
    /** Phase 17, §16.5. The buyer's side of a manufacturing inquiry's state machine. */
    "manufacturing_inquiry_created",
    "manufacturing_inquiry_sent",
    "manufacturing_inquiry_answered",
    "manufacturing_inquiry_closed",
  ],
);

// --- Seller profile depth (Appendix A13, Phase 12).
//
// Everything in this block describes what a SELLER ASSERTS about itself. None of it is
// checked, and the projection keeps it in its own object for exactly that reason: a
// declared stat and a measured one must not be renderable through the same code path
// (A13's closing rule). The one exception is `commerce_certification_state`, which
// tracks a moderator's decision rather than a seller's claim.

/**
 * What kind of business a seller says it is. Closed vocabulary rather than free text so
 * the directory can filter on it — `manufacturer_trading` is one entity doing both, not
 * a missing decision, and it is the single most common answer in this market.
 */
export const commerceSellerBusinessTypeEnum = pgEnum("commerce_seller_business_type", [
  "manufacturer",
  "trading_company",
  "manufacturer_trading",
  "agent",
  "distributor",
]);

/** What a company photo is OF. Drives grouping in the company sheet, nothing more. */
export const commerceOrganizationMediaKindEnum = pgEnum("commerce_organization_media_kind", [
  "factory",
  "office",
  "warehouse",
  "production_line",
  "showcase",
]);

/**
 * How freight reaches a seller's site. Deliberately the same four modes as
 * `commerce_shipment_leg_mode`, because they describe the same physical world — but a
 * SEPARATE type: a site-access row is a seller's claim about its neighbourhood, and a
 * shipment leg is a booked movement. Sharing the type would invite a join that means
 * nothing.
 */
export const commerceSiteAccessModeEnum = pgEnum("commerce_site_access_mode", [
  "road",
  "sea",
  "air",
  "rail",
]);

/**
 * Declared production capabilities. `oem`/`odm` are the terms buyers actually search.
 *
 * WIDENED IN PHASE 17 (§16.2 conflict 1), additively — migration `0099`. The shipped six
 * and the manufacturer directory's proposed six overlapped by two, and `ALTER TYPE … ADD
 * VALUE` is what let the rows Phase 12 collected stay exactly as they were.
 *
 * `customization` AND `private_label` ARE NOT ONE VALUE, and the distinction is not
 * pedantry: customization is "we will change this product for you", private label is "we
 * will put your name on ours". A factory frequently does one and refuses the other.
 *
 * `oem` and `odm` remain the two the directory tile advertises, because they are different
 * propositions — an ODM designs the product and sells you the design, an OEM builds to a
 * design you already own — and a buyer arriving with drawings needs a different row from a
 * buyer arriving with an idea.
 */
export const commerceOrganizationCapabilityKindEnum = pgEnum(
  "commerce_organization_capability_kind",
  [
    "oem",
    "odm",
    "customization",
    "in_house_inspection",
    "in_house_rnd",
    "sample_production",
    "contract_manufacturing",
    "private_label",
    "tooling_and_moulds",
    "assembly",
  ],
);

/** Whether a buyer may visit the factory. A policy, not an invitation. */
export const commerceVisitPolicyEnum = pgEnum("commerce_visit_policy", [
  "welcome",
  "by_appointment",
  "not_available",
]);

/**
 * A certification's review lifecycle.
 *
 * NOTE WHAT IS NOT HERE: `expired`. Lapsing is not a state transition — it is
 * `valid_until < current_date`, evaluated at read time. An `expired` state would need a
 * nightly job to flip it and would therefore be WRONG between ticks, publishing a lapsed
 * certificate until the next run. `withdrawn` stays because that one is an action a
 * seller takes.
 */
export const commerceCertificationStateEnum = pgEnum("commerce_certification_state", [
  "pending",
  "approved",
  "rejected",
  "withdrawn",
]);

/**
 * The eight standards a buyer can FILTER on (Phase 17, §16.2 conflict 2).
 *
 * A closed set beside the free-text `standardName`, not instead of it. The filter needs a
 * closed vocabulary or the chips are unbuildable and two spellings of one standard sit
 * side by side; the display needs an open one or a real certificate cannot be recorded.
 * Both are right, so the row carries both and `standardCode` is nullable.
 */
export const commerceCertificationStandardCodeEnum = pgEnum(
  "commerce_certification_standard_code",
  [
    "iso_9001",
    "iso_14001",
    "bsci",
    "sedex_smeta",
    "gots",
    "fsc",
    "ce_marking",
    "fda_registered",
  ],
);

/**
 * A site audit is RECORDED or WITHDRAWN.
 *
 * No `expired`, for the same reason `commerceCertificationStateEnum` has none: an audit
 * going stale is a read-time judgement about its date, and a nightly job to flip a stored
 * flag would be wrong between ticks.
 */
export const commerceSiteAuditStateEnum = pgEnum("commerce_site_audit_state", [
  "recorded",
  "withdrawn",
]);

/**
 * A manufacturing inquiry's lifecycle (§16.5).
 *
 * `POST` ANSWERS `draft`, ALWAYS. Creating a draft notifies nobody, exactly as an RFQ
 * does, which is why `sent` is a separate transition with its own route and why no success
 * copy on the create may say "sent".
 */
export const commerceManufacturingInquiryStateEnum = pgEnum(
  "commerce_manufacturing_inquiry_state",
  ["draft", "sent", "answered", "closed"],
);

// Public catalog buyer-contract fields (STORE_BACKEND_STRUCTURE.md §4.4).
export const productSamplePolicyEnum = pgEnum("product_sample_policy", [
  "unavailable",
  "paid",
  "refundable",
]);

export const productModerationStateEnum = pgEnum("product_moderation_state", [
  "pending",
  "approved",
  "rejected",
  "suspended",
]);

/**
 * Phase 8 catalog depth (STORE_BACKEND_STRUCTURE.md Appendix A2).
 *
 * `product_image` was photo-only and carried no discriminator, so a 360 spin had
 * nowhere to live. The column defaults to `photo`, which is what every pre-Phase-8
 * row is.
 *
 * `video` was here and migration `0090` removed it. Every upload is re-encoded to AVIF
 * by `validateAndNormalizeImage` before it reaches Cloudinary and there is no video URL
 * column on this table, so a `video` row was an AVIF still carrying a label it could not
 * honour — a wire value that could never describe its own bytes, which is the failure
 * Appendix A is written to catch. When product video is wanted it follows A8's shape: an
 * external YouTube id under a supply CHECK, because this codebase has no first-party
 * video ingest.
 *
 * `spin_360` is genuinely representable — a spin is an ordered run of stills within one
 * (product, variant) gallery, which the Phase 8 position index already orders.
 */
export const productMediaKindEnum = pgEnum("product_media_kind", ["photo", "spin_360"]);

/**
 * A variant is retired, never deleted: an order line snapshot references the
 * variant it was bought from, and `restrict` on that FK would block the delete
 * anyway (Appendix A1).
 */
export const commerceProductVariantStateEnum = pgEnum("commerce_product_variant_state", [
  "active",
  "retired",
]);

/**
 * The product relation graph (STORE_BACKEND_STRUCTURE.md §15.3, Appendix A7).
 *
 * Directional on purpose — "this bolt is a spare part of that bicycle" does not
 * invert. Symmetric meanings (`complements`, `compatible_with`) are stored as two
 * rows so one query direction serves every read.
 */
export const commerceProductRelationKindEnum = pgEnum("commerce_product_relation_kind", [
  "accessory_of",
  "spare_part_of",
  "consumable_for",
  "compatible_with",
  "complements",
  "replaces",
]);

/**
 * A seller saying its bolt fits a given bicycle is a CLAIM, not a fact (§15.3).
 * This rides the wire on every companion so no client can render a claim as a
 * check mark; only `moderator_curated` earns confirmatory language.
 */
/**
 * Buyer engagement with a listing (STORE Appendix A11).
 *
 * USER-scoped, not organization-scoped, and the reason is `commerce_organization`'s
 * own lifecycle: `tradeState` starts `pending` and only a staff `verification_decided`
 * action makes it `active`, so an organization-keyed bookmark would put a single tap
 * behind human verification. It would also flicker for a user who belongs to several
 * organizations, and let any `viewer`-role colleague silently empty the team's list.
 *
 * The genuine B2B need — a shared sourcing shortlist — is a NAMED, owned, permissioned
 * object with its own audit trail. Delivering it accidentally, as an unnamed org-wide
 * bag anyone can empty, would be worse than not delivering it.
 */
export const commerceProductEngagementKindEnum = pgEnum("commerce_product_engagement_kind", [
  "saved",
  "bookmarked",
]);

/**
 * Visibility of user-generated commerce content (STORE Appendix A9, A12).
 *
 * FOUR values, not a reuse of `commerce_review_visibility`'s two, because these are
 * four different facts. An author retracting is not a moderation event, and an
 * automatic threshold hide is not a human decision — flattening them would make the
 * moderation queue lie about who acted.
 */
export const commerceUgcVisibilityStateEnum = pgEnum("commerce_ugc_visibility_state", [
  "visible",
  "hidden_pending_review",
  "hidden_by_moderator",
  "removed_by_author",
]);

/**
 * Who wrote an answer (STORE Appendix A9).
 *
 * DERIVED by the service from the caller's standing, never sent in a request body:
 * a badge asserted by the frontend is the most direct §0 violation available.
 * Moderators moderate; they do not answer, so there is no `moderator` member.
 */
export const commerceProductAnswerAuthorKindEnum = pgEnum("commerce_product_answer_author_kind", [
  "seller",
  "verified_buyer",
]);

/**
 * What a commerce content report can point at (STORE Appendix A12).
 *
 * `review_reply` and `message` are deliberately absent. A reply has no public read of
 * its own, so a report target for it would be a button with nothing behind it; and a
 * message report means a moderator reads a private, attachment-bearing commercial
 * negotiation, which is a §14 disclosure decision rather than an aggregation one. The
 * existing escalation path for harm inside a thread is a dispute.
 */
export const commerceContentTargetKindEnum = pgEnum("commerce_content_target_kind", [
  "product",
  "review",
  "question",
  "answer",
  "organization",
]);

/**
 * Why something was reported (STORE Appendix A12).
 *
 * A commerce-specific set rather than a reuse of `research_program_report_reason`:
 * this is mostly about GOODS, `plagiarism` and `misinformation` are R&D words, and
 * sharing one type would mean adding `counterfeit` puts it on the R&D report form.
 */
export const commerceContentReportReasonEnum = pgEnum("commerce_content_report_reason", [
  "spam",
  "counterfeit",
  "prohibited_item",
  "misleading_claim",
  "intellectual_property",
  "harassment",
  "off_topic",
  "other",
]);

export const commerceContentReportStatusEnum = pgEnum("commerce_content_report_status", [
  "open",
  "actioned",
  "dismissed",
]);

export const commerceModerationActionKindEnum = pgEnum("commerce_moderation_action_kind", [
  "content_hidden",
  "content_restored",
  "report_dismissed",
  "product_moderation_state_changed",
]);

/**
 * Who took a moderation action (STORE Appendix A12) — and the reason this column
 * exists at all.
 *
 * `platform_audit_entry.actorUserId` is NOT NULL because the hash chain's premise is
 * that every entry names an accountable human. An AUTOMATIC hide, triggered by the
 * report threshold, names nobody and therefore cannot enter that chain. Rather than
 * weaken the chain's invariant, such an action is recorded here with no moderator and
 * no audit entry, and `commerce_moderation_action_source_ck` binds those three columns
 * to this value in both directions.
 */
export const commerceModerationActionSourceEnum = pgEnum("commerce_moderation_action_source", [
  "moderator",
  "automatic",
]);

export const commerceProductRelationSourceKindEnum = pgEnum(
  "commerce_product_relation_source_kind",
  ["seller_declared", "moderator_curated", "derived_cooccurrence"],
);

export const storePresentationAccentEnum = pgEnum("store_presentation_accent", [
  "amber",
  "slate",
  "emerald",
  "sky",
  "rose",
]);

/**
 * `pending_review` and `rejected` arrived with Phase 9 (§15.5): a seller may propose
 * a guided pathway, and a proposal its own author can publish is not moderated.
 * Hero slides and rails only ever use `draft | active | retired`.
 */
export const storeMerchandisingStateEnum = pgEnum("store_merchandising_state", [
  "draft",
  "active",
  "retired",
  // Appended, not inserted: `ALTER TYPE ... ADD VALUE` puts new labels at the end,
  // and this list must describe the type Postgres actually has.
  "pending_review",
  "rejected",
]);

/**
 * §15.2. `curated` is a merchandiser's choice; `derived` is a relation-graph
 * suggestion. Only `curated` rows are stored — derived candidates are resolved from
 * `commerce_product_relation` at read time, because a stored copy would be stale the
 * moment a seller edits the graph — but the distinction rides the wire so no client
 * can render a suggestion as a curatorial decision.
 */
export const storePathwaySlotCandidateSourceKindEnum = pgEnum(
  "store_pathway_slot_candidate_source_kind",
  ["curated", "derived"],
);

export const storeMerchandisingEntityKindEnum = pgEnum("store_merchandising_entity_kind", [
  "product",
  "category",
  "organization",
  "provider_offering",
]);

/**
 * How a rail chooses what it shows.
 *
 * `trending_placeholder` PREDATES Phase 13 and is deliberately still here. It returns an
 * empty list unconditionally and always will. Postgres cannot drop an enum value, but
 * that is not why it survives: while it exists, backing this phase out is a per-rail data
 * edit a merchandiser performs in seconds rather than a deploy. A rail only begins
 * claiming to show what is rising when a human moves it to `trending`.
 */
export const storeRailStrategyEnum = pgEnum("store_rail_strategy", [
  "curated",
  "newest",
  "trending_placeholder",
  "trending",
  "recommended",
]);

/**
 * Where a product view came from (Phase 13).
 *
 * A CLIENT-SUPPLIED LABEL, and accepting it is safe only because nothing gates on it. It
 * selects no rate, no weight and no eligibility; it exists so an operator triaging a
 * fraud review can ask whether a spike arrived through search or through one rail.
 * `unknown` is what a caller gets for sending nothing — a view with an unattributed
 * source is still a view.
 */
export const commerceProductViewSourceEnum = pgEnum("commerce_product_view_source", [
  "product_detail",
  "search",
  "rail",
  "pathway",
  "companion",
  "unknown",
]);

/**
 * Whether an order's buyer cleared the trusted-buyer bar AT THE MOMENT IT CONFIRMED.
 *
 * `unevaluated` is load-bearing and is NOT a synonym for `unqualified`. Every order
 * confirmed before Phase 13 carries it, and such a row is absent from BOTH the numerator
 * and the denominator of every velocity computation — the posture `promisedDeliveryAt`
 * established for orders predating it. Collapsing the two would state that a buyer failed
 * a test never administered, and make all history evidence against its seller.
 *
 * Stamped once at confirm and immutable. Recomputed at read time, a buyer registering a
 * tax identifier today would retroactively qualify every order it ever placed.
 */
export const commerceBuyerQualificationStateEnum = pgEnum("commerce_buyer_qualification_state", [
  "qualified",
  "unqualified",
  "unevaluated",
]);

/**
 * Why the qualification verdict went the way it did.
 *
 * An ARRAY of these rides on the order. A single reason column would force a precedence
 * between "old enough" and "has a tax id on file" that does not exist: the bar is one age
 * test AND one of three credentials, and a reviewer needs to see which credential
 * answered.
 */
export const commerceBuyerQualificationReasonEnum = pgEnum("commerce_buyer_qualification_reason", [
  "account_age_met",
  "prior_order_history",
  "verified_business_email_domain",
  "business_registration_on_file",
  "tax_identifier_on_file",
  "account_too_new",
  "no_qualifying_credential",
  "anonymous_account",
  "organization_not_active",
  "organization_ranking_excluded",
  "sample_order",
  "below_value_floor",
]);

/**
 * Which ranking regime produced a row (Phase 13).
 *
 * `sparse_exploration` is not a degraded mode to be embarrassed about — on a young B2B
 * catalog it is the COMMON case, since a category needs 30 qualified orders in 30 days
 * before a percentile means anything. Storing it on every snapshot row is what lets the
 * verifier assert that no product with zero qualified W2 orders ever claims `percentile`,
 * which is the specific regression that turns this engine back into a popularity contest.
 */
export const commerceRankingModeEnum = pgEnum("commerce_ranking_mode", [
  "percentile",
  "sparse_exploration",
]);

/**
 * WHICH RUNG OF THE PRIOR LADDER ANSWERED.
 *
 * The point of hierarchical smoothing is that a category prior and a global prior are
 * different claims, and a bare number cannot say which it is. `default_floor` appearing in
 * a row means the taxonomy above it was empty — a signal, not a normal outcome.
 */
export const commerceCategoryPriorLevelEnum = pgEnum("commerce_category_prior_level", [
  "category",
  "parent_category",
  "global",
  "default_floor",
]);

/**
 * What reduced a score, recorded per application (Phase 13).
 *
 * Enumerated rather than summed into one opaque multiplier so a seller appealing a
 * suppression can be told WHICH signal fired. "Your score was multiplied by 0.4" is not a
 * reviewable statement; "38 of your 40 saves came from one network block" is.
 */
export const commerceRankingPenaltyKindEnum = pgEnum("commerce_ranking_penalty_kind", [
  "subnet_concentration",
  "refund_rate",
  "cancellation_rate",
  "low_order_value",
  "conversion_kill_switch",
]);

/**
 * What the circuit breaker DID (Phase 13).
 *
 * `none` is written on purpose and is most of this table's early life: the breaker ships
 * observe-only, so the rate at which it WOULD have fired is countable before it is allowed
 * to. A breaker enabled on a designer's confidence rather than an observed false-positive
 * rate is how a marketplace suppresses honest sellers.
 *
 * Nothing here delists. That is a commercial action requiring a human — the same call
 * Phase 10 made when it refused to let an automatic report hide a product.
 */
export const commerceRankingEnforcementActionEnum = pgEnum("commerce_ranking_enforcement_action", [
  "none",
  "weight_reduced",
  "capped",
  "quarantined",
  "review_queued",
]);

/**
 * What we know about the email domain an order's buyer used (Phase 13).
 *
 * ABSENCE FROM `commerce_business_email_domain` MEANS `unknown`, NEVER
 * `verified_business`. A denylist of free-mail and disposable providers is obtainable; an
 * allowlist of every legitimate company domain on earth is not. So this can DENY a
 * qualification credential and can almost never GRANT one — the same asymmetry that keeps
 * the subnet guard's corporate-NAT exemption unbuildable.
 */
export const commerceEmailDomainClassificationEnum = pgEnum(
  "commerce_email_domain_classification",
  ["verified_business", "free_mail", "disposable", "unknown"],
);

export const storeSearchDocumentKindEnum = pgEnum("store_search_document_kind", [
  "product",
  "provider_offering",
  /**
   * A25. A seller organization as a first-class search result, so a buyer can browse
   * and filter suppliers the way they already can service providers. Fed by the same
   * public-eligibility rule products answer to — active trade state, public visibility.
   */
  "organization",
]);

/**
 * A25. The stock state as `deriveStockState` computes it, denormalized onto the search
 * document so it can be filtered on.
 *
 * Its own type rather than a borrowed one: this value is DERIVED from stock quantity and
 * the lead-time pair, so unlike `sample_policy` and `condition` there is no column
 * elsewhere whose type it could share. Keeping the members in step with that function is
 * the point — a fifth state would have to be added here deliberately.
 */
export const storeSearchStockStateEnum = pgEnum("store_search_stock_state", [
  "in_stock",
  "low_stock",
  "made_to_order",
  "unavailable",
]);

export const commerceProviderKindSlugEnum = pgEnum("commerce_provider_kind_slug", [
  "freight_forwarder",
  "logistics_operator",
  "customs_broker",
  "insurance_provider",
  "inspection_agency",
  "testing_certification_lab",
  "marketing_agency",
  "warehouse_provider",
  "foreign_exchange_facilitator",
]);

export const commerceProviderVerificationStateEnum = pgEnum(
  "commerce_provider_verification_state",
  ["unverified", "documents_pending", "verified", "rejected", "suspended"],
);

export const commerceServiceOfferingStateEnum = pgEnum("commerce_service_offering_state", [
  "draft",
  "pending_review",
  "active",
  "suspended",
  "retired",
]);

export const commerceServicePricingModelEnum = pgEnum("commerce_service_pricing_model", [
  "quote_only",
  "fixed_fee",
  "per_unit",
  "subscription",
]);

export const freightTransportModeEnum = pgEnum("freight_transport_mode", [
  "air",
  "sea",
  "land",
  "rail",
  "multimodal",
]);

// ---------------------------------------------------------------------------
// Store Phase 3 — RFQs, quotes, quote-originated orders, negotiation threads.
// See docs/STORE_BACKEND_STRUCTURE.md §4.6–4.8, §4.11, §6.2, §8.
// ---------------------------------------------------------------------------

export const commerceRfqStateEnum = pgEnum("commerce_rfq_state", [
  "draft",
  "open",
  "closed",
  "awarded",
  "cancelled",
  "expired",
]);

export const commerceRfqVisibilityEnum = pgEnum("commerce_rfq_visibility", [
  "invited_only",
  "matched_providers",
]);

export const commerceRfqInvitationStateEnum = pgEnum("commerce_rfq_invitation_state", [
  "pending",
  "sent",
  "read",
  "responded",
  "withdrawn",
  "expired",
]);

export const commerceQuoteStatusEnum = pgEnum("commerce_quote_status", [
  "draft",
  "submitted",
  "superseded",
  "accepted",
  "declined",
  "withdrawn",
  "expired",
]);

export const commerceOrderSourceEnum = pgEnum("commerce_order_source", [
  "direct_checkout",
  "accepted_quote",
]);

export const commerceOrderStateEnum = pgEnum("commerce_order_state", [
  "pending_payment",
  "payment_processing",
  "confirmed",
  "in_fulfillment",
  "partially_completed",
  "completed",
  "cancelled",
  "disputed",
]);

/**
 * NOTE that `product` is NOT a member, and `product_inquiry` is (Appendix A14).
 *
 * A thread keyed on the product would collide with `commerce_thread_resource_uidx`
 * and produce one thread per product across ALL buyers, so `assertThreadParticipant`
 * would admit every buyer organization that ever inquired and hand each of them every
 * other buyer's negotiation. The inquiry row is what keeps the unique index correct:
 * one thread per inquiry, one inquiry per (product, buyer organization).
 */
export const commerceThreadResourceKindEnum = pgEnum("commerce_thread_resource_kind", [
  "rfq",
  "quote",
  "order",
  "service_engagement",
  "dispute",
  "product_inquiry",
  /**
   * Phase 17. A manufacturing inquiry is ONE-TO-ONE, which is exactly why it gets its own
   * thread instead of being folded into an RFQ: an RFQ thread has every invited provider
   * in it, so reusing that shape would expose one factory's conversation to its
   * competitors.
   */
  "manufacturing_inquiry",
]);

export const commerceThreadParticipantRoleEnum = pgEnum("commerce_thread_participant_role", [
  "buyer",
  "provider",
  "moderator",
]);

export const commerceInventoryReservationStateEnum = pgEnum(
  "commerce_inventory_reservation_state",
  ["held", "consumed", "released", "expired"],
);

export const commerceCheckoutPrepareStateEnum = pgEnum("commerce_checkout_prepare_state", [
  "active",
  "consumed",
  "superseded",
  "expired",
]);

export const commerceCheckoutGroupStateEnum = pgEnum("commerce_checkout_group_state", [
  "confirmed",
  "cancelled",
]);

export const commerceServiceEngagementStateEnum = pgEnum("commerce_service_engagement_state", [
  "awaiting_provider",
  "scheduled",
  "in_progress",
  "awaiting_buyer",
  "completed",
  "cancelled",
  "disputed",
]);

export const commerceShipmentStateEnum = pgEnum("commerce_shipment_state", [
  "planned",
  "in_transit",
  "delivered",
  "cancelled",
]);

export const commerceShipmentEventKindEnum = pgEnum("commerce_shipment_event_kind", [
  "created",
  "picked_up",
  "in_transit",
  "delivered",
  "exception",
  "cancelled",
]);

/** Shipment-leg transport modes (Phase 6). Multimodal belongs to offerings, not a single leg. */
export const commerceShipmentLegModeEnum = pgEnum("commerce_shipment_leg_mode", [
  "air",
  "sea",
  "land",
  "rail",
]);

export const commerceShipmentLegStateEnum = pgEnum("commerce_shipment_leg_state", [
  "planned",
  "booked",
  "in_transit",
  "arrived",
  "completed",
  "cancelled",
]);

export const commerceShipmentLegEventKindEnum = pgEnum("commerce_shipment_leg_event_kind", [
  "created",
  "booked",
  "departed",
  "arrived",
  "completed",
  "exception",
  "cancelled",
]);

/**
 * Whether an engagement has an immutable accepted-quote execution snapshot.
 * Legacy Phase 4 engagements without typed quote details are fail-closed for Phase 6 writes.
 */
export const commerceExecutionContractStateEnum = pgEnum("commerce_execution_contract_state", [
  "ready",
  "legacy_missing_snapshot",
]);

/**
 * How an engagement's typed execution snapshot was established.
 * Null while `execution_contract_state = legacy_missing_snapshot`.
 * `accepted_quote` requires a non-null detail source line; `operator_initialized` does not.
 */
export const commerceExecutionContractProvenanceEnum = pgEnum(
  "commerce_execution_contract_provenance",
  ["accepted_quote", "operator_initialized"],
);

export const commerceEngagementDeliverableStateEnum = pgEnum(
  "commerce_engagement_deliverable_state",
  ["planned", "submitted", "accepted", "waived", "cancelled"],
);

export const commerceFulfillmentCommandTargetKindEnum = pgEnum(
  "commerce_fulfillment_command_target_kind",
  ["shipment", "shipment_leg", "service_engagement", "engagement_deliverable"],
);

export const commerceCompletionTargetKindEnum = pgEnum("commerce_completion_target_kind", [
  "product_order_line",
  "service_engagement",
]);

export const commerceReviewVisibilityEnum = pgEnum("commerce_review_visibility", [
  "visible",
  "hidden",
]);

/**
 * Review media kind (STORE Appendix A8).
 *
 * `photo` bytes are uploaded, normalized by sharp and delivered from Cloudinary.
 * `youtube_video` stores an 11-character YouTube id and never touches video bytes —
 * the same shipped design `video.youtubeVideoId` uses, reusing `src/lib/youtube.ts`
 * and the `verify-youtube-video` oEmbed job rather than inventing a second ingest.
 * The two kinds therefore populate DIFFERENT columns, which is why
 * `commerce_review_media_supply_ck` discriminates on this value rather than making
 * every column nullable and hoping.
 */
export const commerceReviewMediaKindEnum = pgEnum("commerce_review_media_kind", [
  "photo",
  "youtube_video",
]);

/**
 * Named review sub-scores (STORE Appendix A8) — the three bars the ratings section
 * renders. A closed enum, not a free-text axis key: an unbounded axis makes the
 * aggregate unbounded and forces the client to invent labels for keys it has never
 * seen. Contrast `commerce_product_specification.specificationGroup`, which IS free
 * text because the useful groupings for a chair and a transformer share nothing.
 */
export const commerceReviewScoreAxisEnum = pgEnum("commerce_review_score_axis", [
  "service",
  "shipping",
  "quality",
]);

export const commerceDisputeStateEnum = pgEnum("commerce_dispute_state", [
  "open",
  "closed",
  "dismissed",
]);

export const commerceDisputeEventKindEnum = pgEnum("commerce_dispute_event_kind", [
  "opened",
  "note_added",
  "closed",
  "dismissed",
]);

/**
 * Commerce payment provider identity (STORE Phase 5).
 *
 * Separate from the R&D `payment_provider` enum: commerce never posts into project-
 * funding rows, and the fake adapter is fail-closed outside local/test environments.
 * `stripe` is reserved so switching a real processor on is an INSERT, not a migration.
 */
export const commercePaymentProviderEnum = pgEnum("commerce_payment_provider", ["fake", "stripe"]);

/**
 * Payment intent lifecycle (STORE_BACKEND_STRUCTURE.md §4.9):
 * `created → requires_action | processing → authorized → settled`
 * Terminal alternatives: `failed | cancelled | partially_refunded | refunded | disputed`.
 */
export const commercePaymentIntentStateEnum = pgEnum("commerce_payment_intent_state", [
  "created",
  "requires_action",
  "processing",
  "authorized",
  "settled",
  "failed",
  "cancelled",
  "partially_refunded",
  "refunded",
  "disputed",
]);

export const commerceProviderTransferStateEnum = pgEnum("commerce_provider_transfer_state", [
  "created",
  "submitted",
  "settled",
  "failed",
  "cancelled",
]);

/**
 * A17. A credit is minted once by a completed refundable sample order and spent once.
 * `expired` exists so an unbounded liability can be closed out rather than lingering
 * against a buyer who never places the bulk order.
 */
/**
 * A18. An upload slot ("your logo") and a choice slot ("packaging material") differ in
 * what the buyer supplies, and therefore in what a selection must carry. Modelling them
 * as one nullable-everything row would let a selection supply neither.
 */
export const commerceProductCustomizationKindEnum = pgEnum("commerce_product_customization_kind", [
  "file_upload",
  "choice",
]);

/** Retire, never delete: an order line references the option it was bought under. */
export const commerceProductCustomizationOptionStateEnum = pgEnum(
  "commerce_product_customization_option_state",
  ["active", "retired"],
);

export const commerceSampleCreditStateEnum = pgEnum("commerce_sample_credit_state", [
  "available",
  "consumed",
  "expired",
]);

export const commerceRefundStateEnum = pgEnum("commerce_refund_state", [
  "created",
  "processing",
  "settled",
  "failed",
  "cancelled",
]);

/**
 * Commerce journal account kinds (ESCROW_LEDGER_STRUCTURE.md §3, retargeted at orders).
 *
 * Sign conventions are FIXED here, not inferred. Source accounts run NEGATIVE,
 * destination accounts POSITIVE, and the lines of one entry sum to exactly zero.
 *
 * THE FIRST SIX ARE FROZEN (Phase 14). They belong to the `internal_custody` rail,
 * which asserts that QATOTO holds the buyer's money — the custody model §14 has now
 * decided against. They are kept, never removed, so historical entries stay readable
 * and so backing Phase 14 out is a data edit rather than a deploy:
 *   - `buyer_clearing` — outside world; permanently negative when funds enter
 *   - `order_held` — positive while the hold stands
 *   - `seller_payable` — NEVER POSTED, and deliberately so. It means "Qatoto owes the
 *     seller money it is holding", which under no-custody can never be true: the escrow
 *     provider owes the seller, or nobody does. Its honest mirror is
 *     `platform_fee_receivable`
 *   - `platform_fee` — superseded by the three `platform_fee_*` kinds below
 *   - `refunds_payable` — owed back to the buyer
 *   - `reconciliation_suspense` — provider/ledger delta until a human resolves it
 *
 * THE FOUR `settlement_*_memo` KINDS ARE OFF BALANCE SHEET. They record gross order
 * value so it stays reconcilable without Qatoto ever claiming it as an asset, and they
 * satisfy one identity on every rail that moves money:
 *
 *     funding + custody + released + refunded = 0     (per order, always)
 *
 * `commerce_journal_account.isMemorandum` is bound to these four by check constraint so
 * no future balance report can sum memo value and real money into one number.
 *
 * THE THREE `platform_fee_*` KINDS ARE THE ONLY REAL MONEY IN THIS PHASE — Qatoto's own
 * commission. Receiving one's own revenue is not custody of anyone else's funds.
 */
export const commerceJournalAccountKindEnum = pgEnum("commerce_journal_account_kind", [
  "buyer_clearing",
  "order_held",
  "seller_payable",
  "platform_fee",
  "refunds_payable",
  "reconciliation_suspense",
  /** Off balance sheet. The outside world funding the rail; negative, and it never returns to zero. */
  "settlement_funding_memo",
  /** Off balance sheet. Positive only while a THIRD PARTY holds the funds. */
  "settlement_custody_memo",
  /** Off balance sheet. Cumulative released to the seller; positive. */
  "settlement_released_memo",
  /** Off balance sheet. Cumulative returned to the buyer; positive. */
  "settlement_refunded_memo",
  /** Real. Commission the seller owes Qatoto; positive. */
  "platform_fee_receivable",
  /** Real. Recognized revenue — a CREDIT account, so it runs negative like `buyer_clearing`. */
  "platform_fee_earned",
  /** Real. Commission actually collected; positive. */
  "platform_fee_cash",
]);

export const commerceJournalKindEnum = pgEnum("commerce_journal_kind", [
  "payment_authorized",
  "payment_settled",
  "payment_failed",
  "payment_refunded",
  "reconciliation_adjustment",
  "reversal",
  /**
   * Phase 14. Every escrow value below is posted ONLY from a normalized provider event —
   * a webhook, or the same event pulled by the reconciler. Qatoto's books follow the
   * provider and never lead it, so a release REQUEST posts nothing at all.
   */
  "escrow_funded",
  "escrow_released",
  "escrow_refunded",
  /** The `direct_processor` rail settling buyer → seller, with the seller as the settlement account. */
  "direct_settled",
  "fee_recognized",
  "fee_collected",
]);

export const commerceJournalEntrySettlementEnum = pgEnum("commerce_journal_entry_settlement", [
  "pending",
  "settled",
  "failed",
]);

export const commercePaymentOutboxKindEnum = pgEnum("commerce_payment_outbox_kind", [
  "submit_payment_intent",
  "submit_refund",
]);

export const commercePaymentOutboxStateEnum = pgEnum("commerce_payment_outbox_state", [
  "pending",
  "processing",
  "completed",
  "failed",
]);

// ---------------------------------------------------------------------------
// STORE Phase 14 — EXTERNAL SETTLEMENT. See docs/STORE_PHASE_14_ROLLOUT.md.
//
// THE DECISION THAT GOVERNS EVERY TABLE BELOW: Qatoto provides no escrow and never
// holds funds. Two parties who want to trade cheaply transact directly and carry the
// counterparty risk themselves — that is the DEFAULT and it stays the default. Parties
// who want the risk reduced discuss it in the thread they are already talking in, agree
// on a third-party licensed escrow provider, and opt in TOGETHER. Qatoto is the venue
// and the record-keeper, never the holder.
//
// Escrow is therefore never auto-selected by policy, never silently applied, and never
// silently dropped. Its absence is the normal case and is legible on the wire.
// ---------------------------------------------------------------------------

/**
 * How one order settles. A per-ORDER fact, not per checkout group: §2.3 already gives
 * one order per counterparty, and two sellers in one cart may settle differently.
 *
 * `internal_custody` is FROZEN — it is the shipped `buyer_clearing`/`order_held` path,
 * refuse-closed in production and retained only so historical orders stay readable.
 */
export const commerceSettlementRailEnum = pgEnum("commerce_settlement_rail", [
  "internal_custody",
  /** The default. T/T, L/C, or whatever the parties arranged. Qatoto observes nothing. */
  "direct_offline",
  /** Processor settles buyer → seller with the SELLER as settlement account; Qatoto takes a fee. */
  "direct_processor",
  /** A licensed third party holds and releases against milestones. Requires a mutual agreement. */
  "external_escrow",
]);

export const commerceConnectorKindEnum = pgEnum("commerce_connector_kind", [
  "external_escrow",
  "logistics",
  "insurance",
  "laboratory",
  "foreign_exchange",
]);

export const commerceExternalProviderStateEnum = pgEnum("commerce_external_provider_state", [
  "draft",
  "active",
  "suspended",
  "retired",
]);

/**
 * A negotiated settlement term, in the append-only shape `commerce_quote_revision`
 * already uses — because it is the same kind of object. A counter-proposal is a NEW
 * revision; the previous row goes `superseded`. Nothing is ever edited in place.
 */
export const commerceSettlementAgreementStateEnum = pgEnum("commerce_settlement_agreement_state", [
  "proposed",
  "accepted",
  "declined",
  "withdrawn",
  "superseded",
  "expired",
  "consumed",
]);

/** Who bears the escrow provider's own fee. Negotiated, never defaulted silently. */
export const commerceEscrowFeeBearerEnum = pgEnum("commerce_escrow_fee_bearer", [
  "buyer",
  "seller",
  "split",
]);

/**
 * Deliberately letter-of-credit shaped. The closest real analogue to a neutral licensed
 * party releasing against documents is documentary credit, not a marketplace feature.
 */
export const commerceEscrowMilestoneKindEnum = pgEnum("commerce_escrow_milestone_kind", [
  "deposit",
  "shipment",
  "inspection",
  "delivery",
  "final",
]);

export const commerceEscrowSessionStateEnum = pgEnum("commerce_escrow_session_state", [
  "created",
  "awaiting_funding",
  "funded",
  "partially_released",
  "released",
  "refunded",
  "cancelled",
  "disputed",
]);

export const commerceEscrowMilestoneStateEnum = pgEnum("commerce_escrow_milestone_state", [
  "planned",
  "locked",
  "verification_pending",
  "verification_failed",
  "release_requested",
  "released",
  "refunded",
  "cancelled",
]);

/**
 * What proved a milestone. Every source is a record this schema ALREADY keeps, because
 * a verification invented for escrow would be a second source of truth about fulfillment.
 */
export const commerceEscrowVerificationSourceEnum = pgEnum("commerce_escrow_verification_source", [
  "order_confirmed",
  "shipment_leg_event",
  "inspection_engagement",
  "order_completion",
]);

/**
 * The `direct_offline` rail posts NO settlement entries, because Qatoto cannot observe a
 * wire between two banks it has no relationship with. What it records instead is each
 * party's own claim, attributed to the organization that made it.
 */
export const commerceSettlementAttestationKindEnum = pgEnum(
  "commerce_settlement_attestation_kind",
  ["payment_sent", "payment_received"],
);

export const commerceConnectorOutboxKindEnum = pgEnum("commerce_connector_outbox_kind", [
  "escrow_create_session",
  "escrow_lock_milestones",
  "escrow_submit_verification",
  "escrow_request_release",
  "escrow_request_refund",
]);

export const commerceConnectorOutboxStateEnum = pgEnum("commerce_connector_outbox_state", [
  "pending",
  "processing",
  "completed",
  "failed",
]);

/**
 * Phase 14. A settlement proposal must be legible in the conversation where it was
 * discussed, and encoding that in body text would make it unparseable and forgeable.
 * Every pre-Phase-14 row is `participant`, which is what a human typed.
 */
export const commerceMessageKindEnum = pgEnum("commerce_message_kind", [
  "participant",
  "settlement_proposed",
  "settlement_accepted",
  "settlement_declined",
  "settlement_withdrawn",
]);

/**
 * A legal commerce identity. Registration and tax identifiers are ciphertext
 * envelopes, never searchable or public fields. `normalizedLegalName` exists only
 * for duplicate-review lookup and is always scoped by country.
 */
export const commerceOrganization = pgTable(
  "commerce_organization",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    slug: text("slug").notNull(),
    legalName: text("legal_name").notNull(),
    normalizedLegalName: text("normalized_legal_name").notNull(),
    displayName: text("display_name").notNull(),
    summary: text("summary"),
    organizationType: commerceOrganizationTypeEnum("organization_type").notNull(),
    tradeState: commerceOrganizationTradeStateEnum("trade_state").default("pending").notNull(),
    visibility: commerceOrganizationVisibilityEnum("visibility").default("private").notNull(),
    countryCode: text("country_code").notNull(),
    registrationNumberEncrypted: text("registration_number_encrypted"),
    taxIdentifierEncrypted: text("tax_identifier_encrypted"),
    logoUrl: text("logo_url"),
    /**
     * Platform-hosted since `0091`. NULL means a legacy hotlink. `websiteUrl` beside it
     * is deliberately NOT hosted — it is a link the buyer chooses to follow, not bytes
     * the store renders on the seller's behalf.
     */
    logoCloudinaryPublicId: text("logo_cloudinary_public_id"),
    logoWidthPx: integer("logo_width_px"),
    logoHeightPx: integer("logo_height_px"),
    websiteUrl: text("website_url"),
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
    uniqueIndex("commerce_organization_slug_uidx").on(table.slug),
    index("commerce_organization_legalName_country_idx").on(
      table.normalizedLegalName,
      table.countryCode,
    ),
    index("commerce_organization_tradeState_idx").on(table.tradeState, table.id),
    check(
      "commerce_organization_slug_ck",
      sql`slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) BETWEEN 3 AND 100`,
    ),
    check(
      "commerce_organization_name_ck",
      sql`char_length(legal_name) BETWEEN 1 AND 200
          AND char_length(normalized_legal_name) BETWEEN 1 AND 200
          AND char_length(display_name) BETWEEN 1 AND 200
          AND (summary IS NULL OR char_length(summary) <= 4000)`,
    ),
    check("commerce_organization_country_ck", sql`country_code ~ '^[A-Z]{2}$'`),
    check(
      "commerce_organization_url_ck",
      sql`(logo_url IS NULL OR (char_length(logo_url) <= 2048 AND logo_url LIKE 'https://%'))
          AND (website_url IS NULL OR (char_length(website_url) <= 2048 AND website_url LIKE 'https://%'))`,
    ),
    check(
      "commerce_organization_hosted_logo_ck",
      sql`(logo_cloudinary_public_id IS NULL AND logo_width_px IS NULL AND logo_height_px IS NULL)
          OR (logo_url IS NOT NULL AND logo_cloudinary_public_id IS NOT NULL
              AND logo_width_px > 0 AND logo_height_px > 0)`,
    ),
  ],
);

export const commerceOrganizationMember = pgTable(
  "commerce_organization_member",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    role: commerceOrganizationMemberRoleEnum("role").notNull(),
    state: commerceOrganizationMemberStateEnum("state").default("invited").notNull(),
    invitedByUserId: text("invited_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    joinedAt: timestamp("joined_at"),
    leftAt: timestamp("left_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("commerce_organization_member_organizationId_idx").on(table.organizationId, table.state),
    index("commerce_organization_member_userId_idx").on(table.userId, table.state),
    // At most one current membership. Historical `left` rows remain append-only
    // history, while invited/active/suspended are mutually exclusive per user/org.
    uniqueIndex("commerce_organization_member_current_uidx")
      .on(table.organizationId, table.userId)
      .where(sql`state <> 'left'`),
    check(
      "commerce_organization_member_dates_ck",
      sql`(state = 'invited' AND joined_at IS NULL AND left_at IS NULL)
          OR (state IN ('active', 'suspended') AND joined_at IS NOT NULL AND left_at IS NULL)
          OR (state = 'left' AND joined_at IS NOT NULL AND left_at IS NOT NULL AND left_at >= joined_at)`,
    ),
  ],
);

export const commerceOrganizationAddress = pgTable(
  "commerce_organization_address",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    addressKind: commerceOrganizationAddressKindEnum("address_kind").notNull(),
    label: text("label"),
    countryCode: text("country_code").notNull(),
    regionCode: text("region_code"),
    locality: text("locality").notNull(),
    postalCode: text("postal_code"),
    recipientNameEncrypted: text("recipient_name_encrypted"),
    addressLineOneEncrypted: text("address_line_one_encrypted").notNull(),
    addressLineTwoEncrypted: text("address_line_two_encrypted"),
    phoneEncrypted: text("phone_encrypted"),
    isDefault: boolean("is_default").default(false).notNull(),
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
    index("commerce_organization_address_organizationId_idx").on(
      table.organizationId,
      table.addressKind,
    ),
    uniqueIndex("commerce_organization_address_default_uidx")
      .on(table.organizationId, table.addressKind)
      .where(sql`is_default = true`),
    check("commerce_organization_address_country_ck", sql`country_code ~ '^[A-Z]{2}$'`),
    check(
      "commerce_organization_address_text_ck",
      sql`(label IS NULL OR char_length(label) BETWEEN 1 AND 100)
          AND char_length(locality) BETWEEN 1 AND 150
          AND (region_code IS NULL OR char_length(region_code) BETWEEN 1 AND 100)
          AND (postal_code IS NULL OR char_length(postal_code) BETWEEN 1 AND 32)`,
    ),
  ],
);

/**
 * Private object-storage metadata. The database stores the encrypted data-key
 * envelope and nonce, never plaintext document bytes or a public URL.
 */
export const commerceEncryptedDocument = pgTable(
  "commerce_encrypted_document",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    documentKind: commerceDocumentKindEnum("document_kind").notNull(),
    state: commerceDocumentStateEnum("state").default("pending_scan").notNull(),
    storageProvider: text("storage_provider").notNull(),
    objectStorageKey: text("object_storage_key").notNull(),
    mediaType: text("media_type").notNull(),
    fileByteSize: bigint("file_byte_size", { mode: "number" }).notNull(),
    contentSha256: text("content_sha256").notNull(),
    encryptionAlgorithm: text("encryption_algorithm").notNull(),
    encryptionKeyVersion: integer("encryption_key_version").notNull(),
    encryptedDataKey: text("encrypted_data_key").notNull(),
    initializationVector: text("initialization_vector").notNull(),
    originalFileNameEncrypted: text("original_file_name_encrypted"),
    uploadedByUserId: text("uploaded_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("commerce_encrypted_document_objectStorageKey_uidx").on(table.objectStorageKey),
    index("commerce_encrypted_document_organizationId_idx").on(
      table.organizationId,
      table.documentKind,
      table.createdAt,
    ),
    check("commerce_encrypted_document_size_ck", sql`file_byte_size > 0`),
    check("commerce_encrypted_document_sha_ck", sql`content_sha256 ~ '^[0-9a-f]{64}$'`),
    check(
      "commerce_encrypted_document_encryption_ck",
      sql`char_length(encryption_algorithm) BETWEEN 1 AND 50
          AND encryption_key_version >= 1
          AND char_length(encrypted_data_key) >= 16
          AND char_length(initialization_vector) >= 12`,
    ),
  ],
);

export const commerceOrganizationVerification = pgTable(
  "commerce_organization_verification",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    verificationKind: commerceVerificationKindEnum("verification_kind").notNull(),
    state: commerceVerificationStateEnum("state").default("pending").notNull(),
    evidenceDocumentId: text("evidence_document_id")
      .notNull()
      .references(() => commerceEncryptedDocument.id, { onDelete: "restrict" }),
    submittedByUserId: text("submitted_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    reviewedByUserId: text("reviewed_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    decisionReason: text("decision_reason"),
    submittedAt: timestamp("submitted_at").defaultNow().notNull(),
    decidedAt: timestamp("decided_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("commerce_organization_verification_organizationId_idx").on(
      table.organizationId,
      table.verificationKind,
      table.state,
    ),
    uniqueIndex("commerce_organization_verification_pending_uidx")
      .on(table.organizationId, table.verificationKind)
      .where(sql`state = 'pending'`),
    check(
      "commerce_organization_verification_decision_ck",
      sql`(state = 'pending' AND reviewed_by_user_id IS NULL AND decision_reason IS NULL AND decided_at IS NULL)
          OR (state = 'approved' AND reviewed_by_user_id IS NOT NULL AND decision_reason IS NULL AND decided_at IS NOT NULL)
          OR (state IN ('rejected', 'superseded') AND reviewed_by_user_id IS NOT NULL
              AND decision_reason IS NOT NULL AND char_length(decision_reason) BETWEEN 1 AND 2000
              AND decided_at IS NOT NULL)`,
    ),
    check(
      "commerce_organization_verification_reviewer_ck",
      sql`reviewed_by_user_id IS NULL OR reviewed_by_user_id <> submitted_by_user_id`,
    ),
  ],
);

/**
 * Seller-declared company depth (Appendix A13, Phase 12).
 *
 * WHY THIS TABLE EXISTS AT ALL: `commerce_provider_profile` is keyed to SERVICE
 * PROVIDERS, so a manufacturer selling products had no profile row anywhere and the whole
 * company-details surface was mock. This mirrors that table's shape deliberately — one
 * row per organization, keyed on the organization, cascade on delete — so the two read
 * paths stay recognisably the same thing for two different trade roles.
 *
 * EVERY COLUMN HERE IS A CLAIM. Nothing on this row is verified, measured, or derived,
 * which is why the projection puts it under `declaredProfile` and never merges it with
 * `measuredMetrics`. That separation IS A13's rule: "98.6% on-time, measured across 412
 * completed orders" and "founded 2009, per the seller" are different kinds of statement,
 * and a flat `stats: {label, value}[]` array teaches the UI to present the second as the
 * first.
 */
export const commerceSellerProfile = pgTable(
  "commerce_seller_profile",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => commerceOrganization.id, { onDelete: "cascade" }),
    yearFounded: integer("year_founded"),
    factoryCount: integer("factory_count"),
    totalStaffCount: integer("total_staff_count"),
    productionLineCount: integer("production_line_count"),
    factoryAreaSquareMetres: integer("factory_area_square_metres"),
    businessType: commerceSellerBusinessTypeEnum("business_type"),
    visitPolicy: commerceVisitPolicyEnum("visit_policy"),
    acceptingCustomOrders: boolean("accepting_custom_orders").default(false).notNull(),
    publicSummary: text("public_summary"),
    /**
     * SELLER-TYPED, NOT MEASURED — the same shape as
     * `commerce_provider_profile.averageResponseTimeHours`, and named to say so. The
     * measured figure lives nowhere on this table: it is computed from message
     * timestamps by `loadOrganizationMeasuredResponseTimes` and projected separately.
     * Phase 12 renamed nothing on the provider row but stopped shipping it as a sibling
     * of derived metrics, which is what it had been since Phase 2.
     */
    declaredResponseTimeHours: integer("declared_response_time_hours"),
    /**
     * Org-level sample policy (Phase 17, §16.3).
     *
     * `sampleFeeInCents = null` MEANS UNSTATED AND `0` MEANS FREE. Two different facts,
     * and the one thing this surface must not do is render an unstated fee as free — a
     * buyer who orders a sample on that basis finds out at invoice time. Product-level
     * sample policy is separate and narrower; this is what the factory says in general.
     */
    offersSamples: boolean("offers_samples").default(false).notNull(),
    sampleLeadTimeDays: integer("sample_lead_time_days"),
    sampleFeeInCents: bigint("sample_fee_in_cents", { mode: "number" }),
    /**
     * Server-owned and never null, the `talentProfile.currency` precedent. A fee needs a
     * currency to be a fee at all, and the wire carries this even when the fee is unstated.
     */
    sampleCurrency: text("sample_currency").default("USD").notNull(),
    /**
     * THE MOQ PAIR IS BOTH-OR-NEITHER. A bare `500` is unreadable — 500 pieces and 500
     * cartons are different businesses — so a renderer must have the unit before it prints
     * the number. The DB check refuses half of it.
     */
    minimumOrderQuantity: integer("minimum_order_quantity"),
    minimumOrderQuantityUnitLabel: text("minimum_order_quantity_unit_label"),
    /**
     * Ordered but not paired, unlike the MOQ: a floor with no ceiling is a readable claim
     * where half a MOQ is not.
     */
    minimumLeadTimeDays: integer("minimum_lead_time_days"),
    maximumLeadTimeDays: integer("maximum_lead_time_days"),
    /**
     * The factory's own inbox switch, read by the directory card as `acceptingInquiries`
     * and enforced by the manufacturing-inquiry create. Without it the only way to stop
     * inquiries is to leave the platform, and a card claiming a factory is accepting them
     * would be asserting something the seller never chose.
     */
    acceptingInquiries: boolean("accepting_inquiries").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("commerce_seller_profile_businessType_idx").on(table.businessType),
    /**
     * The upper bound is a FIXED YEAR, not `extract(year from now())`. `now()` is not
     * IMMUTABLE and Postgres refuses it in a CHECK. The real rule — a founding year is
     * not in the future — is enforced in Zod at the boundary, where it can read a clock.
     * This constraint exists to stop a typo like `20250`, not to be the whole rule.
     */
    check(
      "commerce_seller_profile_year_founded_ck",
      sql`year_founded IS NULL OR year_founded BETWEEN 1800 AND 2100`,
    ),
    check(
      "commerce_seller_profile_counts_ck",
      sql`(factory_count IS NULL OR factory_count >= 0)
          AND (total_staff_count IS NULL OR total_staff_count >= 0)
          AND (production_line_count IS NULL OR production_line_count >= 0)
          AND (factory_area_square_metres IS NULL OR factory_area_square_metres >= 0)`,
    ),
    check(
      "commerce_seller_profile_response_ck",
      sql`declared_response_time_hours IS NULL OR declared_response_time_hours BETWEEN 0 AND 8760`,
    ),
    check(
      "commerce_seller_profile_text_ck",
      sql`public_summary IS NULL OR char_length(public_summary) <= 4000`,
    ),
    check(
      "commerce_seller_profile_order_bounds_ck",
      sql`(minimum_order_quantity IS NULL) = (minimum_order_quantity_unit_label IS NULL)
          AND (minimum_order_quantity IS NULL OR minimum_order_quantity > 0)
          AND (minimum_order_quantity_unit_label IS NULL
               OR char_length(minimum_order_quantity_unit_label) BETWEEN 1 AND 40)
          AND (minimum_lead_time_days IS NULL OR minimum_lead_time_days >= 0)
          AND (maximum_lead_time_days IS NULL OR maximum_lead_time_days >= 0)
          AND (minimum_lead_time_days IS NULL
               OR maximum_lead_time_days IS NULL
               OR minimum_lead_time_days <= maximum_lead_time_days)`,
    ),
    /**
     * A lead time or a fee on a profile that does not offer samples is a contradiction the
     * read would have to pick a winner for, so the write refuses it instead.
     */
    check(
      "commerce_seller_profile_sample_policy_ck",
      sql`sample_currency ~ '^[A-Z]{3}$'
          AND (sample_lead_time_days IS NULL OR sample_lead_time_days >= 0)
          AND (sample_fee_in_cents IS NULL OR sample_fee_in_cents >= 0)
          AND (offers_samples OR (sample_lead_time_days IS NULL AND sample_fee_in_cents IS NULL))`,
    ),
  ],
);

/**
 * Factory / office / warehouse photography (A13 item 3).
 *
 * PLATFORM-HOSTED, not a seller-supplied URL. `commerce_product_highlight.imageUrl` and
 * `commerce_organization.logoUrl` both take an https string, and this table deliberately
 * departs from that precedent: these images are uploaded through Cloudinary like
 * `product_image`, so the platform controls the bytes. A factory photo is the one image
 * class here that routinely carries EXIF GPS, and a seller pasting a hotlink cannot have
 * it stripped.
 *
 * `widthPx`/`heightPx` are measured from the DECODED BYTES, never accepted from the
 * client — the rule A2 established for `product_image`.
 */
export const commerceOrganizationMedia = pgTable(
  "commerce_organization_media",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "cascade" }),
    mediaKind: commerceOrganizationMediaKindEnum("media_kind").notNull(),
    imageUrl: text("image_url").notNull(),
    /** Retained so deletion can destroy the remote asset, never projected publicly. */
    cloudinaryPublicId: text("cloudinary_public_id").notNull(),
    altText: text("alt_text"),
    widthPx: integer("width_px").notNull(),
    heightPx: integer("height_px").notNull(),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("commerce_organization_media_position_uidx").on(
      table.organizationId,
      table.position,
    ),
    index("commerce_organization_media_kind_idx").on(table.organizationId, table.mediaKind),
    check("commerce_organization_media_position_ck", sql`position >= 0`),
    check("commerce_organization_media_dimensions_ck", sql`width_px > 0 AND height_px > 0`),
    check(
      "commerce_organization_media_url_ck",
      sql`char_length(image_url) <= 2048 AND image_url LIKE 'https://%'
          AND (alt_text IS NULL OR char_length(alt_text) <= 500)`,
    ),
  ],
);

/**
 * Declared freight access to the seller's site (A13 item 3) — "nearest seaport: Nhava
 * Sheva, 62 km".
 *
 * `distanceKm` is an INTEGER IN A NAMED UNIT, never the formatted string the mock
 * rendered. A13's sibling entry A5 made the same call about package dimensions and for
 * the same reason: prose cannot be filtered, compared, or freight-rated.
 */
export const commerceOrganizationSiteAccess = pgTable(
  "commerce_organization_site_access",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "cascade" }),
    accessMode: commerceSiteAccessModeEnum("access_mode").notNull(),
    facilityName: text("facility_name").notNull(),
    distanceKm: integer("distance_km"),
    notes: text("notes"),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("commerce_organization_site_access_position_uidx").on(
      table.organizationId,
      table.position,
    ),
    check("commerce_organization_site_access_position_ck", sql`position >= 0`),
    check(
      "commerce_organization_site_access_distance_ck",
      sql`distance_km IS NULL OR (distance_km >= 0 AND distance_km <= 40000)`,
    ),
    check(
      "commerce_organization_site_access_text_ck",
      sql`char_length(facility_name) BETWEEN 1 AND 200
          AND (notes IS NULL OR char_length(notes) <= 1000)`,
    ),
  ],
);

/**
 * Named production lines (Phase 17, §16.3).
 *
 * `commerceSellerProfile.productionLineCount` is a bare integer, and a count is not a
 * capability: "four lines" tells a buyer nothing about whether any of them can hold the
 * order. This is the row that can.
 *
 * `unitLabel` IS REQUIRED BESIDE `monthlyCapacityUnits`, for the same reason the MOQ pair
 * is both-or-neither: a capacity with no unit cannot be compared against an order. The
 * capacity itself is nullable, because plenty of factories will name a line and decline to
 * publish its throughput.
 */
export const commerceOrganizationProductionLine = pgTable(
  "commerce_organization_production_line",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    processSummary: text("process_summary").notNull(),
    monthlyCapacityUnits: integer("monthly_capacity_units"),
    unitLabel: text("unit_label").notNull(),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    /**
     * Same ordering contract as `commerceOrganizationSiteAccess` and
     * `commerceOrganizationMedia`, and the same consequence: the collection is rewritten
     * whole inside one transaction rather than patched row by row, because a per-row
     * update against a unique position deadlocks itself on any reorder.
     */
    uniqueIndex("commerce_organization_production_line_position_uidx").on(
      table.organizationId,
      table.position,
    ),
    check(
      "commerce_organization_production_line_text_ck",
      sql`char_length(name) BETWEEN 1 AND 200
          AND char_length(process_summary) BETWEEN 1 AND 2000
          AND char_length(unit_label) BETWEEN 1 AND 40`,
    ),
    check(
      "commerce_organization_production_line_numbers_ck",
      sql`position >= 0 AND (monthly_capacity_units IS NULL OR monthly_capacity_units >= 0)`,
    ),
  ],
);

/**
 * One physical site (Phase 17, §16.3).
 *
 * DISTINCT FROM `commerceOrganizationSiteAccess`, which carries only transport modes and
 * is about REACHING a site rather than describing one. A factory may run several sites, in
 * more than one country.
 *
 * THE RELATIONSHIP TO THE ORG-WIDE FIGURE IS PUBLISHED, NOT RECONCILED.
 * `commerceSellerProfile.factoryAreaSquareMetres` is seller-declared and these per-site
 * areas are seller-declared, and when they disagree the read carries both. A platform that
 * silently prefers one, or sums these into that, is asserting something neither party
 * said.
 */
export const commerceOrganizationSite = pgTable(
  "commerce_organization_site",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    countryCode: text("country_code").notNull(),
    locality: text("locality"),
    floorAreaSquareMetres: integer("floor_area_square_metres"),
    productionStaffCount: integer("production_staff_count"),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("commerce_organization_site_position_uidx").on(
      table.organizationId,
      table.position,
    ),
    check(
      "commerce_organization_site_text_ck",
      sql`char_length(label) BETWEEN 1 AND 200
          AND country_code ~ '^[A-Z]{2}$'
          AND (locality IS NULL OR char_length(locality) BETWEEN 1 AND 200)`,
    ),
    check(
      "commerce_organization_site_numbers_ck",
      sql`position >= 0
          AND (floor_area_square_metres IS NULL OR floor_area_square_metres >= 0)
          AND (production_staff_count IS NULL OR production_staff_count >= 0)`,
    ),
  ],
);

/**
 * The record behind `site_audited` (Phase 17, §16.2 conflict 3).
 *
 * THIS TABLE EXISTS BECAUSE THE STATE COULD NOT BE DERIVED FROM ANYTHING ELSE.
 * `commerceOrganizationVerification` covers business registration, tax registration,
 * identity, address and bank account — paperwork, all of it. `site_audited` asserts that
 * somebody stood in the building. Deriving it from a document review is the precise
 * collapse the three-state wire enum exists to prevent, and no read may do it.
 *
 * A VERIFICATION STATE IS ABOUT THE ORGANIZATION, NEVER ABOUT A CAPABILITY. A recorded
 * audit does not mean this factory is approved to do injection moulding, and there is no
 * per-capability approval anywhere on the wire.
 *
 * STAFF-WRITTEN ONLY, and `auditEntryId` is NOT NULL so every row names an accountable
 * human — the shape `commerceModerationAction` already uses. `restrict` on the
 * organization rather than `cascade`: this is a statement the platform made and stands
 * behind, and deleting the subject must not quietly delete the statement.
 */
export const commerceOrganizationSiteAudit = pgTable(
  "commerce_organization_site_audit",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    /** A calendar date — `mode: "string"`, like the certification validity window. */
    auditedAt: date("audited_at", { mode: "string" }).notNull(),
    auditorName: text("auditor_name").notNull(),
    auditorOrganizationName: text("auditor_organization_name"),
    scopeSummary: text("scope_summary").notNull(),
    state: commerceSiteAuditStateEnum("state").default("recorded").notNull(),
    recordedByUserId: text("recorded_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    auditEntryId: text("audit_entry_id")
      .notNull()
      .references(() => platformAuditEntry.id, { onDelete: "restrict" }),
    withdrawnByUserId: text("withdrawn_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    withdrawnAt: timestamp("withdrawn_at"),
    withdrawalReason: text("withdrawal_reason"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("commerce_organization_site_audit_auditEntryId_uidx").on(table.auditEntryId),
    /** What the card scans to decide the state, and the detail to find `lastAuditedAt`. */
    index("commerce_organization_site_audit_recent_idx").on(
      table.organizationId,
      table.state,
      table.auditedAt,
    ),
    /**
     * The three withdrawal columns move as a set, the discipline `researchProgramPost`'s
     * hidden columns keep. A withdrawal MUST carry its reason: this is the platform
     * retracting a claim it published, and "why" is the entire content of that act.
     */
    check(
      "commerce_organization_site_audit_withdrawal_ck",
      sql`(state = 'withdrawn') = (withdrawn_at IS NOT NULL)
          AND (withdrawn_at IS NULL) = (withdrawn_by_user_id IS NULL)
          AND (withdrawn_at IS NULL) = (withdrawal_reason IS NULL)`,
    ),
    check(
      "commerce_organization_site_audit_text_ck",
      sql`char_length(auditor_name) BETWEEN 1 AND 200
          AND (auditor_organization_name IS NULL OR char_length(auditor_organization_name) BETWEEN 1 AND 200)
          AND char_length(scope_summary) BETWEEN 1 AND 2000
          AND (withdrawal_reason IS NULL OR char_length(withdrawal_reason) BETWEEN 1 AND 2000)`,
    ),
  ],
);

/**
 * Which declared sites an auditor actually walked.
 *
 * A LINK TABLE RATHER THAN A COLUMN ON THE AUDIT, because an audit covering no listed site
 * is still a real audit — a factory may simply not have declared its sites yet — and
 * because one visit can cover several.
 */
export const commerceOrganizationSiteAuditSite = pgTable(
  "commerce_organization_site_audit_site",
  {
    auditId: text("audit_id")
      .notNull()
      .references(() => commerceOrganizationSiteAudit.id, { onDelete: "cascade" }),
    siteId: text("site_id")
      .notNull()
      .references(() => commerceOrganizationSite.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      name: "commerce_organization_site_audit_site_pk",
      columns: [table.auditId, table.siteId],
    }),
  ],
);

/**
 * Named company officers (A13 item 4).
 *
 * NOTE WHAT THIS TABLE CANNOT HOLD: an email address, a phone number, or any other way
 * to reach the person named. That absence is not an oversight and is not to be filled in
 * later — it is the entire reason these rows are safe to publish. A name and a role title
 * are what a company already prints on its own website; a direct line to a named
 * individual is personal data, and adding a column for it would silently convert a public
 * projection into a disclosure.
 *
 * Stored plaintext for the same reason: there is nothing here to encrypt.
 */
export const commerceOrganizationStakeholder = pgTable(
  "commerce_organization_stakeholder",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "cascade" }),
    fullName: text("full_name").notNull(),
    roleTitle: text("role_title").notNull(),
    photoUrl: text("photo_url"),
    /**
     * Platform-hosted since `0091`. A portrait of a named individual is the strongest
     * EXIF case in this schema — stronger than the factory photo
     * `commerce_organization_media` was built for — because the coordinates belong to
     * the person, not the premises. NULL means a legacy hotlink.
     */
    photoCloudinaryPublicId: text("photo_cloudinary_public_id"),
    photoWidthPx: integer("photo_width_px"),
    photoHeightPx: integer("photo_height_px"),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("commerce_organization_stakeholder_position_uidx").on(
      table.organizationId,
      table.position,
    ),
    check("commerce_organization_stakeholder_position_ck", sql`position >= 0`),
    check(
      "commerce_organization_stakeholder_text_ck",
      sql`char_length(full_name) BETWEEN 1 AND 200
          AND char_length(role_title) BETWEEN 1 AND 200
          AND (photo_url IS NULL OR (char_length(photo_url) <= 2048 AND photo_url LIKE 'https://%'))`,
    ),
    check(
      "commerce_organization_stakeholder_hosted_photo_ck",
      sql`(photo_cloudinary_public_id IS NULL AND photo_width_px IS NULL AND photo_height_px IS NULL)
          OR (photo_url IS NOT NULL AND photo_cloudinary_public_id IS NOT NULL
              AND photo_width_px > 0 AND photo_height_px > 0)`,
    ),
  ],
);

/**
 * Declared production capabilities (A13 item 5) — OEM, ODM, in-house inspection.
 *
 * Unique on `(organizationId, capabilityKind)` rather than on position: claiming OEM
 * twice is not an ordering question, it is one row. Position still exists so the seller
 * controls display order.
 *
 * A capability here is DECLARED. `sheets/verified-capabilities-sheet.tsx` is named for
 * what it renders, not for what these rows prove — only the certifications alongside them
 * carry a moderator's decision.
 */
export const commerceOrganizationCapability = pgTable(
  "commerce_organization_capability",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "cascade" }),
    capabilityKind: commerceOrganizationCapabilityKindEnum("capability_kind").notNull(),
    detail: text("detail"),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("commerce_organization_capability_kind_uidx").on(
      table.organizationId,
      table.capabilityKind,
    ),
    check("commerce_organization_capability_position_ck", sql`position >= 0`),
    check(
      "commerce_organization_capability_detail_ck",
      sql`detail IS NULL OR char_length(detail) <= 1000`,
    ),
  ],
);

/**
 * ISO / CE / RoHS / BSCI certifications (A13 item 6).
 *
 * A13'S PLAN FOR THIS WAS WRONG, AND THIS TABLE IS THE CORRECTION. The appendix said to
 * "add a `certification` kind" to `commerceVerificationKindEnum` and reuse
 * `commerce_organization_verification`. That table carries
 * `commerce_organization_verification_pending_uidx`, unique on
 * `(organization_id, verification_kind)` WHERE state = 'pending' — so an organization
 * could hold exactly ONE pending certificate, and a supplier has ISO 9001 and CE and RoHS
 * and BSCI. It also has no name, issuer, standard or expiry column, so an approved row
 * could not say what it certifies or when it lapses, and the platform would publish
 * lapsed certificates indefinitely. Phase 10 made the same call for
 * `commerce_content_report` rather than generalizing the R&D report table.
 *
 * What it DOES borrow is the decision-integrity shape: the same three-way state/reviewer
 * CHECK, and the same rule that a reviewer cannot be the submitter (§11).
 *
 * The public projection is METADATA ONLY. `evidenceDocumentId` never rides the wire in
 * any form — no id, no URL, no short-lived token. A certificate scan carries registration
 * numbers, site addresses and signatures, and §11 keeps private objects private.
 */
export const commerceOrganizationCertification = pgTable(
  "commerce_organization_certification",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    /** "ISO 9001:2015", "CE", "RoHS 3". Free text: the vocabulary is the world's. */
    standardName: text("standard_name").notNull(),
    /**
     * THE MATCHABLE HALF OF AN OPEN VOCABULARY (Phase 17, §16.2 conflict 2).
     *
     * `standardName` above is free text and stays the display string, deliberately: the
     * vocabulary is the world's, and a factory holds standards no enum will ever
     * enumerate. But a filter chip needs a closed set, and two spellings of one standard
     * must not sit side by side in a facet.
     *
     * So this is NULLABLE FOREVER. The manufacturer directory's `certification` filter
     * reads this column; anything outside the eight carries NULL, is unfilterable, and
     * STILL RENDERS on the detail page. Nothing infers a code from the name — a fuzzy
     * match would put a factory in a compliance filter it never claimed.
     */
    standardCode: commerceCertificationStandardCodeEnum("standard_code"),
    issuerName: text("issuer_name").notNull(),
    certificateNumber: text("certificate_number").notNull(),
    scopeSummary: text("scope_summary"),
    /**
     * CALENDAR DATES, not instants — `mode: "string"` like `dueDate` and
     * `lastDailyLogDate`. A certificate is valid "until 2027-03-31" everywhere on earth;
     * mapping that to a `Date` would attach a midnight and a zone to a fact that has
     * neither, and the read-time expiry comparison is against `current_date` in Postgres.
     */
    validFrom: date("valid_from", { mode: "string" }).notNull(),
    validUntil: date("valid_until", { mode: "string" }).notNull(),
    evidenceDocumentId: text("evidence_document_id")
      .notNull()
      .references(() => commerceEncryptedDocument.id, { onDelete: "restrict" }),
    state: commerceCertificationStateEnum("state").default("pending").notNull(),
    submittedByUserId: text("submitted_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    reviewedByUserId: text("reviewed_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    decisionReason: text("decision_reason"),
    submittedAt: timestamp("submitted_at").defaultNow().notNull(),
    decidedAt: timestamp("decided_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    /**
     * The public read's exact predicate: approved, for this organization, not yet lapsed.
     * `validUntil` trails the state so the index also orders the "expiring soon" view an
     * owner sees.
     */
    index("commerce_organization_certification_public_idx").on(
      table.organizationId,
      table.state,
      table.validUntil,
    ),
    /** What the manufacturer directory's `certification` filter scans (Phase 17). */
    index("commerce_organization_certification_standardCode_idx")
      .on(table.standardCode, table.state, table.validUntil)
      .where(sql`standard_code IS NOT NULL`),
    /**
     * One live claim per (organization, standard, certificate number). Rejected rows are
     * excluded so a seller can resubmit a corrected application after a rejection —
     * without this predicate a typo in the number would be permanently unusable.
     */
    uniqueIndex("commerce_organization_certification_identity_uidx")
      .on(table.organizationId, table.standardName, table.certificateNumber)
      .where(sql`state <> 'rejected'`),
    check("commerce_organization_certification_validity_ck", sql`valid_until > valid_from`),
    check(
      "commerce_organization_certification_decision_ck",
      sql`(state = 'pending' AND reviewed_by_user_id IS NULL AND decision_reason IS NULL AND decided_at IS NULL)
          OR (state = 'approved' AND reviewed_by_user_id IS NOT NULL AND decision_reason IS NULL AND decided_at IS NOT NULL)
          OR (state = 'rejected' AND reviewed_by_user_id IS NOT NULL
              AND decision_reason IS NOT NULL AND char_length(decision_reason) BETWEEN 1 AND 2000
              AND decided_at IS NOT NULL)
          OR (state = 'withdrawn' AND reviewed_by_user_id IS NULL AND decision_reason IS NULL
              AND decided_at IS NOT NULL)`,
    ),
    /** A seller cannot approve its own certificate. Same rule as verification evidence. */
    check(
      "commerce_organization_certification_reviewer_ck",
      sql`reviewed_by_user_id IS NULL OR reviewed_by_user_id <> submitted_by_user_id`,
    ),
    check(
      "commerce_organization_certification_text_ck",
      sql`char_length(standard_name) BETWEEN 1 AND 200
          AND char_length(issuer_name) BETWEEN 1 AND 200
          AND char_length(certificate_number) BETWEEN 1 AND 120
          AND (scope_summary IS NULL OR char_length(scope_summary) <= 2000)`,
    ),
  ],
);

export const commerceCategory = pgTable(
  "commerce_category",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    parentCategoryId: text("parent_category_id").references(
      (): AnyPgColumn => commerceCategory.id,
      { onDelete: "restrict" },
    ),
    siblingOrder: integer("sibling_order").notNull(),
    state: commerceCategoryStateEnum("state").default("draft").notNull(),
    imageUrl: text("image_url"),
    searchSynonyms: text("search_synonyms").array().default([]).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("commerce_category_slug_uidx").on(table.slug),
    uniqueIndex("commerce_category_siblingOrder_uidx").on(
      sql`coalesce(parent_category_id, '__root__')`,
      table.siblingOrder,
    ),
    index("commerce_category_parentCategoryId_idx").on(
      table.parentCategoryId,
      table.state,
      table.siblingOrder,
    ),
    check(
      "commerce_category_slug_ck",
      sql`slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) BETWEEN 2 AND 100`,
    ),
    check(
      "commerce_category_shape_ck",
      sql`char_length(name) BETWEEN 1 AND 120
          AND sibling_order >= 0
          AND (image_url IS NULL OR (char_length(image_url) <= 2048 AND image_url LIKE 'https://%'))
          AND parent_category_id IS DISTINCT FROM id`,
    ),
  ],
);

/**
 * A seller's request for a category the taxonomy does not have yet.
 *
 * WHY THIS IS ITS OWN TABLE and not a `pending` state on `commerce_category`: a
 * request is a different thing from a category. It has an author, a justification and a
 * verdict; it has no place in the tree, no `siblingOrder`, no children and no products.
 * Putting proposals in `commerce_category` would mean either excluding a state from every
 * browse query forever — one forgotten `WHERE` and unapproved user text is on the
 * storefront — or minting a fake `siblingOrder` to satisfy an index that exists to order
 * things users can see.
 *
 * THE LISTING IS NOT BLOCKED. A seller with a pending request publishes immediately; the
 * product parks in `misc` and carries `product.pendingCategoryRequestId` pointing back
 * here. That column is the ONLY link, and it is what makes approval surgical: the verdict
 * moves the products belonging to THIS request and leaves genuine misc listings alone.
 * Repointing by `WHERE category_id = misc` would sweep up unrelated sellers' products,
 * which is why no code path may do that.
 *
 * `resultingCategoryId` is the answer to "what did this become". Null on a rejection and
 * null while pending — never a placeholder row.
 */
export const commerceCategoryRequest = pgTable(
  "commerce_category_request",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    /**
     * `set null` rather than `restrict`: a deleted account must not pin a decided
     * request, and the verdict remains a fact about the taxonomy after its author is
     * gone. The same choice `promotional_slide.createdByUserId` makes.
     */
    requestedByUserId: text("requested_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    /** Which seller org asked, when the requester was acting for one. */
    requestedOrganizationId: text("requested_organization_id").references(
      () => commerceOrganization.id,
      { onDelete: "set null" },
    ),
    /**
     * What the seller typed. NOT a slug — the slug is derived by the moderator on
     * approval, after any edit, so a requester cannot choose a public URL identity.
     */
    proposedName: text("proposed_name").notNull(),
    /** Where the seller thinks it belongs. Null means "a new root". */
    proposedParentCategoryId: text("proposed_parent_category_id").references(
      () => commerceCategory.id,
      { onDelete: "set null" },
    ),
    justification: text("justification"),
    state: commerceCategoryRequestStateEnum("state").default("pending").notNull(),
    reviewedByUserId: text("reviewed_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp("reviewed_at"),
    reviewNote: text("review_note"),
    /** The category this request became. Set on approval only. */
    resultingCategoryId: text("resulting_category_id").references(() => commerceCategory.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    /** The moderation queue's own lookup, same shape as `store_pathway_moderation_queue_idx`. */
    index("commerce_category_request_queue_idx").on(table.state, table.createdAt, table.id),
    index("commerce_category_request_requestedByUserId_idx").on(table.requestedByUserId),
    /**
     * Review attribution is paired, and only a decided request may carry it. Unlike
     * `store_pathway_review_ck` there is no unreviewed-publish arm: every row here is a
     * user proposal, so a decided request without a reviewer is always a bug.
     *
     * `reviewedByUserId` may still be null on a decided row once the reviewer's account is
     * deleted, hence the check pairs `reviewedAt` with the STATE rather than with the
     * user id — the timestamp is the thing that cannot go missing.
     */
    check(
      "commerce_category_request_review_ck",
      sql`(reviewed_at IS NULL) = (state = 'pending')
          AND (state = 'approved' OR resulting_category_id IS NULL)
          AND (state <> 'rejected' OR review_note IS NOT NULL)`,
    ),
    check(
      "commerce_category_request_text_ck",
      sql`char_length(proposed_name) BETWEEN 1 AND 120
          AND (justification IS NULL OR char_length(justification) BETWEEN 1 AND 2000)
          AND (review_note IS NULL OR char_length(review_note) BETWEEN 1 AND 2000)`,
    ),
    /** A request cannot be its own parent's answer, and cannot nest under nothing twice. */
    check(
      "commerce_category_request_parent_ck",
      sql`resulting_category_id IS NULL OR resulting_category_id IS DISTINCT FROM proposed_parent_category_id`,
    ),
  ],
);

/**
 * Immutable organization-scoped security history. A migration-installed trigger
 * rejects UPDATE, DELETE and TRUNCATE; payloadJson contains a redacted canonical
 * snapshot and must never contain ciphertext or object-storage keys.
 */
export const commerceOrganizationAuditEntry = pgTable(
  "commerce_organization_audit_entry",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    eventKind: commerceOrganizationAuditEventKindEnum("event_kind").notNull(),
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "restrict" }),
    actorMemberRoleSnapshot: commerceOrganizationMemberRoleEnum("actor_member_role_snapshot"),
    targetEntityType: text("target_entity_type").notNull(),
    targetEntityId: text("target_entity_id").notNull(),
    payloadJson: text("payload_json").default("{}").notNull(),
    occurredAt: timestamp("occurred_at").defaultNow().notNull(),
  },
  (table) => [
    index("commerce_organization_audit_entry_timeline_idx").on(
      table.organizationId,
      table.occurredAt,
      table.id,
    ),
    index("commerce_organization_audit_entry_actorUserId_idx")
      .on(table.actorUserId, table.occurredAt)
      .where(sql`actor_user_id IS NOT NULL`),
    check(
      "commerce_organization_audit_entry_target_ck",
      sql`char_length(target_entity_type) BETWEEN 1 AND 80
          AND char_length(target_entity_id) BETWEEN 1 AND 200`,
    ),
    check(
      "commerce_organization_audit_entry_payload_ck",
      sql`char_length(payload_json) BETWEEN 2 AND 10000 AND payload_json LIKE '{%'`,
    ),
  ],
);

// A product listing, transitioning from user ownership to organization ownership.
export const product = pgTable(
  "product",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    // Owner. Stamped from req.user.id at create — NEVER from the body
    // (CLAUDE.md §1.1). Cascade so deleting a user removes their listings.
    /**
     * NOT NULL since the Phase 0 contract migration (0063). It was nullable for the
     * expand phase only, and organization ownership is now a structural fact rather
     * than a convention the application happens to honour.
     *
     * Authorization must still re-check an active seller membership on every request —
     * a non-null column says the product HAS an owner, not that the caller is it.
     */
    sellerOrganizationId: text("seller_organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    /** Immutable creator attribution, retained after legacy `sellerId` is retired. */
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    /**
     * THE R&D → STORE HANDOFF (R_AND_D_BACKEND_STRUCTURE.md §11i, Appendix B4).
     *
     * Nullable, because most listings are not the output of an R&D project and never
     * will be. When it IS set, this column is the only place "this project shipped this
     * listing" is expressible — without it the `/go-to-market` launch-ready rail cannot
     * show what a project actually launched, and the readiness checklist cannot tell
     * whether a listing exists at all.
     *
     * `restrict`, per R1 below: a project that has shipped a product is not deletable,
     * and there is no DELETE endpoint for a project anyway — archive is terminal.
     *
     * THE COLUMN LIVES HERE; NOTHING ELSE CROSSES THE BOUNDARY. R&D contributes this FK
     * and stops. Listing creation stays in the studio's own flow — a research route that
     * proxied a product create "for convenience" would duplicate the validation, pricing
     * and ownership checks the store already owns and re-validates.
     *
     * Declared before `researchProject` appears below; `references()` takes a callback and
     * resolves lazily, the same mechanism `discovery_region.parentRegionId` relies on.
     */
    researchProjectId: text("research_project_id").references(
      (): AnyPgColumn => researchProject.id,
      { onDelete: "restrict" },
    ),
    title: text("title").notNull(),
    brand: text("brand"),
    /**
     * NULLABLE SINCE 0098, and no longer written for new listings.
     *
     * The enum's eight values name the root set that 0098 retired. A listing in
     * `clothes` or `machinery` has no value it could hold, so requiring one would mean
     * either refusing the taxonomy the store actually browses or stamping a lie. Rows
     * written before 0098 keep theirs; nothing reads it to decide anything.
     */
    category: productCategoryEnum("category"),
    /**
     * The taxonomy. NOT NULL since 0063 and the only category signal that is authoritative
     * — `category` above is legacy residue kept for old clients (see 0098).
     */
    categoryId: text("category_id")
      .notNull()
      .references(() => commerceCategory.id, { onDelete: "restrict" }),
    /**
     * Set while this listing is waiting on a category that does not exist yet. The product
     * sits in `misc` and this points at the request that will rehome it.
     *
     * THIS COLUMN IS THE WHOLE REASON APPROVAL IS SAFE. Deciding a request moves the
     * products matching `pending_category_request_id = :requestId` and nothing else —
     * never `WHERE category_id = misc`, which would drag along every seller who
     * legitimately listed something miscellaneous. Cleared when the request is decided.
     *
     * `set null` so deleting a request cannot strand a listing; the product simply stays
     * where it is, in `misc`, which is a true statement about it.
     */
    pendingCategoryRequestId: text("pending_category_request_id").references(
      () => commerceCategoryRequest.id,
      { onDelete: "set null" },
    ),
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
    // Immutable public URL identity after first assignment (STORE §4.4 / §4 intro).
    publicSlug: text("public_slug"),
    modelNumber: text("model_number"),
    countryOfOriginCode: text("country_of_origin_code"),
    unitOfMeasure: text("unit_of_measure"),
    samplePolicy: productSamplePolicyEnum("sample_policy").default("unavailable").notNull(),
    samplePriceInCents: integer("sample_price_in_cents"),
    leadTimeMinDays: integer("lead_time_min_days"),
    leadTimeMaxDays: integer("lead_time_max_days"),
    /**
     * Packaging geometry and mass (Appendix A5). Integers in NAMED UNITS —
     * millimetres and grams — never a formatted string: "52 × 46 × 12 cm" cannot be
     * filtered, compared, or freight-rated, and freight rating (A16) is the whole
     * reason these exist. All three dimensions travel together or not at all.
     */
    packageLengthMm: integer("package_length_mm"),
    packageWidthMm: integer("package_width_mm"),
    packageHeightMm: integer("package_height_mm"),
    packageGrossWeightGrams: integer("package_gross_weight_grams"),
    /** How many sellable units are inside one package. NULL means unstated, not 1. */
    unitsPerPackage: integer("units_per_package"),
    moderationState: productModerationStateEnum("moderation_state").default("pending").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("product_sellerOrganizationId_idx").on(table.sellerOrganizationId),
    index("product_createdByUserId_idx").on(table.createdByUserId),
    index("product_categoryId_idx").on(table.categoryId),
    /**
     * The approval-time lookup: "which listings does this request rehome?". Partial,
     * because all but a handful of listings are waiting on nothing.
     */
    index("product_pendingCategoryRequestId_idx")
      .on(table.pendingCategoryRequestId)
      .where(sql`pending_category_request_id IS NOT NULL`),
    index("product_status_idx").on(table.status),
    index("product_moderationState_idx").on(table.moderationState, table.id),
    uniqueIndex("product_publicSlug_uidx")
      .on(table.publicSlug)
      .where(sql`public_slug IS NOT NULL`),
    // "What did this project launch?" — the launch-ready rail's lookup. Partial, because
    // the overwhelming majority of listings have no research project behind them.
    index("product_researchProjectId_idx")
      .on(table.researchProjectId)
      .where(sql`research_project_id IS NOT NULL`),
    // An organization can't reuse one SKU across its listings. Postgres UNIQUE
    // permits many NULLs, so SKU stays optional.
    //
    // THE ONLY SKU INDEX SINCE MIGRATION 0089. The user-scoped `product_seller_sku_unq`
    // that stood beside it existed for the expand/backfill window, when an old application
    // instance could still write `seller_id` while a new one wrote `seller_organization_id`.
    // Dropping it lost nothing: Phase 0 gave every legacy seller its own private
    // organization, so the two indexes partitioned the catalogue identically — which is
    // exactly why 0088 rescoping the legacy one produced a duplicate of this rather than a
    // replacement for it, and why 0089 removes it outright.
    uniqueIndex("product_sellerOrganization_sku_unq").on(table.sellerOrganizationId, table.sku),
    check(
      "product_public_slug_ck",
      sql`public_slug IS NULL OR (public_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(public_slug) BETWEEN 3 AND 120)`,
    ),
    check(
      "product_origin_ck",
      sql`country_of_origin_code IS NULL OR country_of_origin_code ~ '^[A-Z]{2}$'`,
    ),
    check(
      "product_sample_price_ck",
      sql`(sample_price_in_cents IS NULL OR sample_price_in_cents > 0)
          AND (sample_policy <> 'unavailable' OR sample_price_in_cents IS NULL)`,
    ),
    check(
      "product_lead_time_ck",
      sql`(lead_time_min_days IS NULL AND lead_time_max_days IS NULL)
          OR (lead_time_min_days IS NOT NULL AND lead_time_max_days IS NOT NULL
              AND lead_time_min_days >= 0 AND lead_time_max_days >= lead_time_min_days
              AND lead_time_max_days <= 3650)`,
    ),
    check(
      "product_model_unit_ck",
      sql`(model_number IS NULL OR char_length(model_number) BETWEEN 1 AND 120)
          AND (unit_of_measure IS NULL OR char_length(unit_of_measure) BETWEEN 1 AND 40)`,
    ),
    // A5. Either every dimension is present or none is — two of three is not a box.
    // Upper bounds are 50 m and 50 t, generous enough for a shipping container and
    // tight enough that a unit mix-up (cm typed as mm) fails loudly.
    check(
      "product_package_dimensions_ck",
      sql`(package_length_mm IS NULL AND package_width_mm IS NULL AND package_height_mm IS NULL)
          OR (package_length_mm IS NOT NULL AND package_width_mm IS NOT NULL
              AND package_height_mm IS NOT NULL
              AND package_length_mm BETWEEN 1 AND 50000
              AND package_width_mm BETWEEN 1 AND 50000
              AND package_height_mm BETWEEN 1 AND 50000)`,
    ),
    check(
      "product_package_mass_ck",
      sql`package_gross_weight_grams IS NULL
          OR package_gross_weight_grams BETWEEN 1 AND 50000000`,
    ),
    check(
      "product_units_per_package_ck",
      sql`units_per_package IS NULL OR units_per_package BETWEEN 1 AND 1000000`,
    ),
  ],
);

/**
 * A buyable variation of a listing — "Sea blue", "480 V / 60 Hz" (Appendix A1).
 *
 * NOT A DISPLAY FEATURE. A variant changes price, stock, MOQ, gallery and what
 * physically ships, so it reaches the cart, the inventory reservation and the
 * immutable order-line snapshot. The rule that makes that safe: a product either
 * has zero active variants (pre-Phase-8 behaviour, unchanged) or one or more, and
 * in the second case a cart line WITHOUT a variant is rejected. An order that does
 * not say which variant was bought is not shippable, and §2.2 forbids inferring it
 * later from mutable listing data.
 *
 * Retired rather than deleted: `commerce_order_product_line.variant_id` is
 * `restrict`, so a sold variant cannot be removed even if a seller wants it gone.
 */
export const commerceProductVariant = pgTable(
  "commerce_product_variant",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    productId: text("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "cascade" }),
    /** Buyer-facing label. Part of the order snapshot, so it is real commercial copy. */
    name: text("name").notNull(),
    /** Immutable URL identity within the product, like `product.publicSlug` is globally. */
    publicSlug: text("public_slug").notNull(),
    sku: text("sku"),
    /** Authoritative unit price when this variant is selected. Overrides `product.priceInCents`. */
    priceInCents: integer("price_in_cents").notNull(),
    stockQuantity: integer("stock_quantity").default(0).notNull(),
    /** NULL falls back to the product-level minimum derived from its tier ladder. */
    minimumOrderQuantity: integer("minimum_order_quantity"),
    position: integer("position").notNull(),
    state: commerceProductVariantStateEnum("state").default("active").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("commerce_product_variant_slug_uidx").on(table.productId, table.publicSlug),
    // Postgres UNIQUE permits many NULLs, so SKU stays optional per variant.
    uniqueIndex("commerce_product_variant_sku_uidx").on(table.productId, table.sku),
    uniqueIndex("commerce_product_variant_position_uidx").on(table.productId, table.position),
    index("commerce_product_variant_product_state_idx").on(
      table.productId,
      table.state,
      table.position,
    ),
    check(
      "commerce_product_variant_slug_ck",
      sql`public_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(public_slug) BETWEEN 1 AND 80`,
    ),
    check("commerce_product_variant_name_ck", sql`char_length(name) BETWEEN 1 AND 120`),
    check("commerce_product_variant_sku_ck", sql`sku IS NULL OR char_length(sku) BETWEEN 1 AND 80`),
    check(
      "commerce_product_variant_money_ck",
      sql`price_in_cents >= 0 AND stock_quantity >= 0 AND position >= 0
          AND (minimum_order_quantity IS NULL OR minimum_order_quantity > 0)`,
    ),
  ],
);

/**
 * Five collapsible marketing cards on the PDP (Appendix A6).
 *
 * `product.keyFeatures` stays what it is — a `text[]` of short bullets with no
 * identity. A highlight has a body and an image, and the schema comment on
 * keyFeatures already anticipated this: "promote to a table only if features ever
 * grow attributes".
 */
export const commerceProductHighlight = pgTable(
  "commerce_product_highlight",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    productId: text("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    bodyText: text("body_text").notNull(),
    imageUrl: text("image_url"),
    /**
     * Platform-hosted since `0091`. Retained so a later delete can destroy the remote
     * asset; never projected publicly and never named in an audit payload. NULL means a
     * legacy hotlink from before `0091` — see the migration for why those were left in
     * place rather than nulled or re-fetched.
     */
    imageCloudinaryPublicId: text("image_cloudinary_public_id"),
    /** Measured from the DECODED BYTES, never accepted from the client (A2's rule). */
    imageWidthPx: integer("image_width_px"),
    imageHeightPx: integer("image_height_px"),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("commerce_product_highlight_position_uidx").on(table.productId, table.position),
    check(
      "commerce_product_highlight_hosted_image_ck",
      sql`(image_cloudinary_public_id IS NULL AND image_width_px IS NULL AND image_height_px IS NULL)
          OR (image_url IS NOT NULL AND image_cloudinary_public_id IS NOT NULL
              AND image_width_px > 0 AND image_height_px > 0)`,
    ),
    check("commerce_product_highlight_title_ck", sql`char_length(title) BETWEEN 1 AND 120`),
    check("commerce_product_highlight_body_ck", sql`char_length(body_text) BETWEEN 1 AND 2000`),
    check("commerce_product_highlight_position_ck", sql`position >= 0`),
    check(
      "commerce_product_highlight_image_ck",
      sql`image_url IS NULL OR (char_length(image_url) <= 2048 AND image_url LIKE 'https://%')`,
    ),
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
    /**
     * A1. NULL means "shared by every variant" — the gallery a variant-less product
     * has always had. Non-NULL scopes the asset to one variant, so selecting
     * "Sea blue" changes the gallery instead of only the price.
     */
    variantId: text("variant_id").references(() => commerceProductVariant.id, {
      onDelete: "cascade",
    }),
    // Cloudinary secure_url of the normalized asset.
    url: text("url").notNull(),
    /** A2. Pre-Phase-8 rows are all photos, which is what the default records. */
    mediaKind: productMediaKindEnum("media_kind").default("photo").notNull(),
    altText: text("alt_text"),
    widthPx: integer("width_px"),
    heightPx: integer("height_px"),
    // 0 = main listing photo. Contiguous per (product, variant); re-packed on delete.
    position: integer("position").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("product_image_productId_idx").on(table.productId),
    index("product_image_variantId_idx")
      .on(table.variantId)
      .where(sql`variant_id IS NOT NULL`),
    check("product_image_position_ck", sql`position >= 0`),
    check(
      "product_image_alt_text_ck",
      sql`alt_text IS NULL OR char_length(alt_text) BETWEEN 1 AND 300`,
    ),
    check(
      "product_image_dimensions_ck",
      sql`(width_px IS NULL AND height_px IS NULL)
          OR (width_px IS NOT NULL AND height_px IS NOT NULL
              AND width_px BETWEEN 1 AND 20000 AND height_px BETWEEN 1 AND 20000)`,
    ),
    // A19's "(productId, position) has no unique index" is closed in migration 0054
    // as an EXPRESSION index over coalesce(variant_id, ''), which drizzle-kit cannot
    // express here. See drizzle/0054_store_phase_8_catalog_depth.sql.
  ],
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
    /**
     * A1. NULL is the product default ladder. Non-NULL is a ladder that applies only
     * when that variant is selected, and it takes precedence over the default.
     *
     * Without this column, choosing a variant would silently discard B2B volume
     * pricing — the tier price is an absolute unit price, so a product-level ladder
     * cannot be combined with a different variant base price without lying about one
     * of them.
     */
    variantId: text("variant_id").references(() => commerceProductVariant.id, {
      onDelete: "cascade",
    }),
    unitPriceInCents: integer("unit_price_in_cents").notNull(),
    minimumOrderQuantity: integer("minimum_order_quantity").notNull(),
    /**
     * A27. The band's own maximum lead time, because a thousand units do not ship on
     * the timetable fifty units ship on.
     *
     * NULL means the seller declared none for this band and the product's
     * `leadTimeMaxDays` applies — which is what every pre-Phase-15 row means, and why
     * nothing was backfilled. A13's promise chain reads whichever one wins at
     * preparation, so a per-tier value reaches `promisedDeliveryAt` without any further
     * plumbing.
     */
    leadTimeDays: integer("lead_time_days"),
    // Display order of the tier ladder.
    position: integer("position").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("product_pricing_tier_productId_idx").on(table.productId),
    index("product_pricing_tier_variantId_idx")
      .on(table.variantId)
      .where(sql`variant_id IS NOT NULL`),
    check(
      "product_pricing_tier_lead_time_ck",
      sql`lead_time_days IS NULL OR lead_time_days BETWEEN 0 AND 3650`,
    ),
  ],
);

/** Structured key/value specs for public product detail (STORE §4.4). */
export const commerceProductSpecification = pgTable(
  "commerce_product_specification",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    productId: text("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "cascade" }),
    specificationKey: text("specification_key").notNull(),
    specificationValue: text("specification_value").notNull(),
    /**
     * A3. Free text, deliberately not an enum — the useful groupings for a chair
     * ("Dimensions", "Materials") and a transformer ("Electrical", "Thermal") share
     * nothing, exactly like `roleLabel` in §15.2. NULL is ungrouped, which is every
     * pre-Phase-8 row.
     *
     * The key stays unique per PRODUCT, not per group: two groups claiming the same
     * key would make the spec sheet ambiguous about which value is current.
     */
    specificationGroup: text("specification_group"),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("commerce_product_specification_productId_idx").on(table.productId, table.position),
    index("commerce_product_specification_group_idx").on(
      table.productId,
      table.specificationGroup,
      table.position,
    ),
    uniqueIndex("commerce_product_specification_product_key_uidx").on(
      table.productId,
      table.specificationKey,
    ),
    check(
      "commerce_product_specification_lengths_ck",
      sql`char_length(specification_key) BETWEEN 1 AND 80
          AND char_length(specification_value) BETWEEN 1 AND 500`,
    ),
    check(
      "commerce_product_specification_group_ck",
      sql`specification_group IS NULL OR char_length(specification_group) BETWEEN 1 AND 80`,
    ),
    check("commerce_product_specification_position_ck", sql`position >= 0`),
  ],
);

/**
 * The product relation graph (STORE_BACKEND_STRUCTURE.md §15.3, Appendix A7).
 *
 * Before this table, NO table in the schema had two foreign keys to `product`, so
 * "similar products", "frequently bought together", "compare", spare-part lookup
 * from an order line and Phase 9's anchored pathway slots were all blocked on the
 * same missing edge. One table serves all five.
 *
 * Both sides are `restrict`: a product someone declared a relation against is not
 * silently deletable, and the seller must retract the claim first.
 *
 * THE RULE THAT GOVERNS THIS TABLE (§15.3): a `seller_declared` relation may drive
 * discovery; it may NEVER be projected as verified compatibility. Fitment is a
 * safety claim in every category where it matters — brake parts, electrical,
 * load-bearing hardware — so `sourceKind` rides the wire on every read.
 */
export const commerceProductRelation = pgTable(
  "commerce_product_relation",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    fromProductId: text("from_product_id")
      .notNull()
      .references(() => product.id, { onDelete: "restrict" }),
    toProductId: text("to_product_id")
      .notNull()
      .references(() => product.id, { onDelete: "restrict" }),
    relationKind: commerceProductRelationKindEnum("relation_kind").notNull(),
    sourceKind: commerceProductRelationSourceKindEnum("source_kind")
      .default("seller_declared")
      .notNull(),
    /** 0 first. Ordering within a kind on the PDP companions read. */
    rank: integer("rank").default(0).notNull(),
    /** Who asserted it. A moderator promotion overwrites neither of these. */
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    createdByOrganizationId: text("created_by_organization_id").references(
      () => commerceOrganization.id,
      { onDelete: "restrict" },
    ),
    verifiedByUserId: text("verified_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    verifiedAt: timestamp("verified_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("commerce_product_relation_edge_uidx").on(
      table.fromProductId,
      table.toProductId,
      table.relationKind,
    ),
    index("commerce_product_relation_from_idx").on(
      table.fromProductId,
      table.relationKind,
      table.rank,
      table.id,
    ),
    index("commerce_product_relation_to_idx").on(table.toProductId, table.relationKind),
    index("commerce_product_relation_org_idx")
      .on(table.createdByOrganizationId)
      .where(sql`created_by_organization_id IS NOT NULL`),
    check("commerce_product_relation_self_ck", sql`from_product_id <> to_product_id`),
    check("commerce_product_relation_rank_ck", sql`rank >= 0 AND rank <= 10000`),
    // Verification attribution exists exactly when the row claims to be curated.
    check(
      "commerce_product_relation_verified_ck",
      sql`(source_kind = 'moderator_curated'
             AND verified_by_user_id IS NOT NULL AND verified_at IS NOT NULL)
          OR (source_kind <> 'moderator_curated'
             AND verified_by_user_id IS NULL AND verified_at IS NULL)`,
    ),
  ],
);

/**
 * Per-user saves and bookmarks (STORE Appendix A11).
 *
 * ONE table for both kinds, unlike the video domain's separate `video_like` and
 * `video_save`. Those are split because their index shapes genuinely differ — a like
 * set is only probed for membership, a save list is rendered newest-first. Here BOTH
 * kinds are rendered lists, so one index shape serves both and one table means one
 * toggle code path instead of two near-identical copies of the same race-safe insert.
 *
 * CASCADE on both sides: neither a deleted user nor a deleted product leaves a
 * meaningful bookmark behind, and nothing downstream references these rows.
 */
export const commerceProductEngagement = pgTable(
  "commerce_product_engagement",
  {
    productId: text("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    engagementKind: commerceProductEngagementKindEnum("engagement_kind").notNull(),
    /**
     * Salted /24 (IPv4) or /56 (IPv6) hash of the saver's network block (Phase 13).
     *
     * NULLABLE AND NEVER BACKFILLABLE — no address was recorded on any commerce row before
     * Phase 13, and the ones behind existing saves are gone. The subnet concentration
     * guard is therefore INERT until rows accumulate.
     *
     * The rule the scorer must honour: a null is not evidence of low concentration.
     * "0 of 40 saves carry a subnet" means UNMEASURED, and the guard is skipped below a
     * minimum hashed sample. Treating null as concentration 0 would clear every product
     * for months and then start penalising as coverage grew.
     */
    subnetHash: text("subnet_hash"),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.productId, table.userId, table.engagementKind] }),
    /** "My saved products", newest first — the list this table exists to render. */
    index("commerce_product_engagement_user_idx").on(
      table.userId,
      table.engagementKind,
      table.createdAt,
      table.productId,
    ),
    /** Counter reconciliation in the phase verifier. */
    index("commerce_product_engagement_product_idx").on(table.productId, table.engagementKind),
    /** "For THIS product, how are saves distributed across network blocks?" */
    index("commerce_product_engagement_subnet_idx")
      .on(table.productId, table.subnetHash)
      .where(sql`subnet_hash IS NOT NULL`),
    check(
      "commerce_product_engagement_subnet_ck",
      sql`subnet_hash IS NULL OR subnet_hash ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

/**
 * Share events (STORE Appendix A11).
 *
 * `userId` is nullable and SET NULL: a share may come from a signed-out visitor, and
 * a deleted account should not erase the fact that a product was shared.
 *
 * PHASE 13 ADDED THE DEDUPE THIS COMMENT USED TO SAY WAS MISSING. Until then every call
 * inserted a row and incremented `shareCount`, including an anonymous one — a ranking
 * input a stranger could push, braked only by a rate limiter. The video domain settled
 * this in the opposite direction long ago (`POST /videos/:videoId/share` moves its counter
 * only for a signed-in sharer, specifically so an anonymous caller cannot push a ranking
 * input); commerce never inherited the rule because nothing read the counter.
 *
 * Anonymous rows are still WRITTEN — they are real events and deleting them destroys
 * evidence — they are simply never `counted`.
 */
export const commerceProductShare = pgTable(
  "commerce_product_share",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    productId: text("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    /** The UTC day this share belongs to — the dedupe bucket. */
    shareDayBucket: date("share_day_bucket", { mode: "string" }).notNull(),
    /** Salted /24 or /56 hash. See `commerceProductEngagement.subnetHash`. */
    subnetHash: text("subnet_hash"),
    /**
     * Whether this row moved `commerce_product_stats.shareCount`.
     *
     * The `isCountedView` idiom: it is what lets the phase verifier reconcile the counter
     * against this table forever, rather than trusting that every future writer remembered
     * the signed-in rule.
     */
    counted: boolean("counted").default(false).notNull(),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    index("commerce_product_share_product_idx").on(table.productId, table.createdAt, table.id),
    /**
     * Partial: an anonymous row has no user to deduplicate on. Two anonymous shares of one
     * product on one day remain two rows; they are simply never counted.
     */
    uniqueIndex("commerce_product_share_daily_unq")
      .on(table.productId, table.userId, table.shareDayBucket)
      .where(sql`user_id IS NOT NULL`),
    index("commerce_product_share_subnet_idx")
      .on(table.subnetHash, table.productId, table.shareDayBucket)
      .where(sql`subnet_hash IS NOT NULL`),
    check(
      "commerce_product_share_subnet_ck",
      sql`subnet_hash IS NULL OR subnet_hash ~ '^[0-9a-f]{64}$'`,
    ),
    /** Enforced in the service and again here — a ranking input's guard does not depend on
     * one call site remembering it. */
    check("commerce_product_share_counted_ck", sql`NOT counted OR user_id IS NOT NULL`),
  ],
);

/**
 * One row per viewer, per product, per UTC day (Phase 13).
 *
 * THE STORE OBSERVED NO VIEW AT ALL BEFORE THIS TABLE. `commerce_product_stats` counted
 * saves, bookmarks, shares and questions; there was no view counter, no impression row and
 * no beacon. That absence is why a conversion rate had no denominator, and why the spec's
 * MAD spike triggers and conversion kill-switch had no input.
 *
 * A direct port of `video_view_session`, down to the anti-replay index and the fingerprint
 * check. Deliberately a port and not a shared table: a product and a video share no
 * foreign key, no eligibility rule and no retention policy, and one polymorphic view table
 * with two nullable entity columns is the shape §2.1 rejects for listings.
 */
export const commerceProductViewSession = pgTable(
  "commerce_product_view_session",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    productId: text("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "cascade" }),
    /**
     * NULL means anonymous, AND THIS COLUMN IS THE GATE.
     *
     * Anonymous dwell counts toward `viewCount` — it is real traffic and excluding it would
     * understate every denominator — but it never reaches the conversion NUMERATOR, because
     * an order has a buyer organization and an anonymous session has nobody to match to.
     * Farming conversion therefore requires real accounts placing real orders.
     *
     * `set null` and not cascade: deleting an account must not retroactively rewrite a
     * product's view history.
     */
    viewerId: text("viewer_id").references(() => user.id, { onDelete: "set null" }),
    /**
     * sha256 hex, per UTC day, from BETTER_AUTH_SECRET plus either the user id (signed in)
     * or ip + user agent (anonymous). THE RAW IP IS NEVER WRITTEN HERE. Its domain
     * separator is `:commerceview:`, not video's `:videoview:` — a shared separator would
     * make one person's product and video fingerprints collide, and two unique indexes
     * would key off the same value for unrelated purposes.
     */
    viewerFingerprint: text("viewer_fingerprint").notNull(),
    /**
     * The UTC day, as the SAME string that went into the hash. Stored and deliberately not
     * generated from `firstBeaconAt`: a generated column is a second derivation of the same
     * fact, and the two disagree for any beacon crossing midnight between them.
     */
    viewDayBucket: date("view_day_bucket", { mode: "string" }).notNull(),
    viewSource: commerceProductViewSourceEnum("view_source").default("unknown").notNull(),
    /** Salted /24 or /56 hash. Nullable; a stripped address has no honest value here. */
    subnetHash: text("subnet_hash"),
    /** Clamped server-side against elapsed wall time. The client proposes; it does not
     * establish. */
    dwellSeconds: integer("dwell_seconds").default(0).notNull(),
    /** Flips ONCE, and the transition is what increments `commerceProductStats.viewCount`.
     * A row that never clears the dwell threshold is a bounce, not a view. */
    isCountedView: boolean("is_counted_view").default(false).notNull(),
    firstBeaconAt: timestamp("first_beacon_at", { precision: 3 }).defaultNow().notNull(),
    lastBeaconAt: timestamp("last_beacon_at", { precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    /**
     * THE ANTI-REPLAY BOUNDARY. Without it a headless loop opens a fresh session per
     * request and every clamp becomes decorative, because a clamp bounds what ONE session
     * may claim, not how many sessions exist.
     */
    uniqueIndex("commerce_product_view_session_unq").on(
      table.productId,
      table.viewerFingerprint,
      table.viewDayBucket,
    ),
    /** Counted views for a product inside W1/W2. */
    index("commerce_product_view_session_product_idx").on(table.productId, table.firstBeaconAt),
    /** Daily rollup, and the per-fingerprint breadth check. */
    index("commerce_product_view_session_fingerprint_idx").on(
      table.viewerFingerprint,
      table.viewDayBucket,
    ),
    index("commerce_product_view_session_subnet_idx")
      .on(table.subnetHash, table.productId, table.viewDayBucket)
      .where(sql`subnet_hash IS NOT NULL`),
    /** The conversion numerator's join: did this signed-in viewer go on to order? */
    index("commerce_product_view_session_viewer_idx")
      .on(table.viewerId, table.productId, table.firstBeaconAt)
      .where(sql`viewer_id IS NOT NULL AND is_counted_view`),
    check(
      "commerce_product_view_session_bounds_ck",
      sql`dwell_seconds >= 0
          AND dwell_seconds <= 3600
          AND last_beacon_at >= first_beacon_at`,
    ),
    /** Both hashes are server-computed, so a non-hex row means something upstream stopped
     * hashing. Fail at the storage layer, loudly. */
    check(
      "commerce_product_view_session_fingerprint_ck",
      sql`viewer_fingerprint ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "commerce_product_view_session_subnet_ck",
      sql`subnet_hash IS NULL OR subnet_hash ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

/**
 * What we know about an email domain (Phase 13, refinement 2).
 *
 * ABSENCE MEANS `unknown`, NEVER `verified_business`, and the asymmetry is worth being
 * blunt about: a denylist of free-mail and disposable providers is obtainable and finite,
 * while an ALLOWLIST of every legitimate company domain on earth is not. In practice this
 * table can DENY a buyer one of its three qualification credentials and can almost never
 * GRANT one.
 *
 * The consequence reaches past qualification. The spec wants the subnet guard to exempt
 * "verified corporate domains" so one procurement team behind one office NAT is not
 * mistaken for a click farm. That exemption cannot be built on a corpus that does not
 * exist — which is why the subnet penalty ships with a floor rather than the specified
 * `max(0, 1 - concentration)` that can zero a product outright.
 *
 * `citext` because domains are case-insensitive and `user.email` is already citext.
 */
export const commerceBusinessEmailDomain = pgTable(
  "commerce_business_email_domain",
  {
    domain: citext("domain").primaryKey(),
    classification: commerceEmailDomainClassificationEnum("classification").notNull(),
    /** Where the judgement came from. Free text, not an enum: the sources are operational
     * and will change faster than a migration cadence. */
    sourceNote: text("source_note").notNull(),
    /** NULL for a bulk import; a person for a hand-classified domain. */
    decidedByUserId: text("decided_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("commerce_business_email_domain_classification_idx").on(
      table.classification,
      table.domain,
    ),
    /** A bare domain: no scheme, no path, no `@`. Rejects `@acme.com` and
     * `https://acme.com`, both of which would silently never match anything. */
    check(
      "commerce_business_email_domain_shape_ck",
      sql`domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'`,
    ),
  ],
);

/**
 * Organizations whose activity never counts toward ranking (Phase 13).
 *
 * THIS TABLE SHIPS EMPTY, and that is a scope statement rather than an oversight. The spec
 * asks for internal, test and blocked orders to be excluded from velocity. This database
 * has no `isTest`, no `isInternal` and no blocked flag on `user` or `commerceOrganization`
 * — the nearest thing is `tradeState`, which already gates trading and is checked
 * separately — and no operational process that would keep such a flag current.
 *
 * The one population that IS in it immediately is the development seed: every organization
 * `seed-store-ranking-dev.ts` writes is registered here, so that if the seed is ever
 * pointed at a real database by accident, its orders are structurally excluded from
 * ranking rather than merely embarrassing.
 */
export const commerceOrganizationRankingExclusion = pgTable(
  "commerce_organization_ranking_exclusion",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => commerceOrganization.id, { onDelete: "cascade" }),
    /** Required: an unexplained exclusion is indistinguishable from a mistake six months
     * later, and this list silently removes a seller from every discovery surface. */
    reason: text("reason").notNull(),
    addedByUserId: text("added_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  () => [
    check(
      "commerce_organization_ranking_exclusion_reason_ck",
      sql`length(btrim(reason)) BETWEEN 3 AND 500`,
    ),
  ],
);

/**
 * Who performed a ranking enforcement action (Phase 13).
 *
 * `automatic` exists because `platform_audit_entry.actorUserId` is NOT NULL and an
 * automatic suppression names nobody. Rather than weaken that hash chain, an automatic
 * action is recorded with no moderator — the call Phase 10 made for
 * `commerce_moderation_action.actionSource`.
 */
export const commerceRankingActionSourceEnum = pgEnum("commerce_ranking_action_source", [
  "moderator",
  "automatic",
]);

/**
 * Per-category demand statistics (Phase 13): the priors, the floor, and the medians.
 *
 * KEYED BY CURRENCY, and that is not a detail. `commerceOrder.currency` varies per order
 * and this backend has no FX quote anywhere — §15.7 refuses to invent one even for a
 * pathway's set total — so a single cross-currency median would be a fabricated
 * conversion. A product whose currency has no median gets NO value penalty rather than a
 * guessed one.
 *
 * `priorLevel` records WHICH RUNG of the category → parent → global → floor ladder
 * answered. A bare number cannot distinguish "this category's own 400 orders say 3.1%"
 * from "we had nothing and used the platform mean".
 */
export const commerceCategoryDemandSnapshot = pgTable(
  "commerce_category_demand_snapshot",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    categoryId: text("category_id")
      .notNull()
      .references(() => commerceCategory.id, { onDelete: "cascade" }),
    currency: text("currency").notNull(),
    /** Quantized to a UTC day by the tick that enqueued the run. */
    asOf: timestamp("as_of").notNull(),
    qualifiedOrderCount30d: integer("qualified_order_count_30d").notNull(),
    activeProductCount: integer("active_product_count").notNull(),
    /**
     * All four NULLABLE WITH NO DEFAULT. A category with no qualified orders has no median
     * and no rate, and a 0 would read as "orders here are worthless" and "nothing is ever
     * refunded" — claims this table has no basis for.
     */
    medianOrderValueInCents: bigint("median_order_value_in_cents", { mode: "number" }),
    p90RefundRateBasisPoints: integer("p90_refund_rate_bp"),
    p90CancellationRateBasisPoints: integer("p90_cancellation_rate_bp"),
    priorConversionRateBasisPoints: integer("prior_conversion_rate_bp"),
    /** How many observations stand behind the prior. A rate without one is a coincidence. */
    priorSampleSize: integer("prior_sample_size").notNull(),
    priorLevel: commerceCategoryPriorLevelEnum("prior_level").notNull(),
    rankingMode: commerceRankingModeEnum("ranking_mode").notNull(),
    scoreAlgorithmVersion: integer("score_algorithm_version").default(1).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("commerce_category_demand_snapshot_unq").on(
      table.categoryId,
      table.currency,
      table.asOf,
    ),
    index("commerce_category_demand_snapshot_lookup_idx").on(
      table.categoryId,
      table.currency,
      table.asOf.desc(),
    ),
    check("commerce_category_demand_snapshot_currency_ck", sql`currency ~ '^[A-Z]{3}$'`),
    check(
      "commerce_category_demand_snapshot_bounds_ck",
      sql`qualified_order_count_30d >= 0
          AND active_product_count >= 0
          AND prior_sample_size >= 0
          AND (median_order_value_in_cents IS NULL OR median_order_value_in_cents >= 0)
          AND (p90_refund_rate_bp IS NULL OR p90_refund_rate_bp BETWEEN 0 AND 10000)
          AND (p90_cancellation_rate_bp IS NULL OR p90_cancellation_rate_bp BETWEEN 0 AND 10000)
          AND (prior_conversion_rate_bp IS NULL OR prior_conversion_rate_bp BETWEEN 0 AND 10000)`,
    ),
    /** Stops the ladder quietly labelling a global fallback as local knowledge. */
    check(
      "commerce_category_demand_snapshot_prior_ck",
      sql`(prior_level = 'default_floor' AND prior_sample_size = 0)
          OR (prior_level <> 'default_floor')`,
    ),
  ],
);

/**
 * The append-only ranking audit history (Phase 13).
 *
 * Every raw input AND every component is stored beside the total, and a CHECK asserts the
 * components sum to it — the `trending_video_snapshot` pattern, for the same reason: a
 * ranking must be auditable from ONE ROW, not by re-running the job against data that has
 * since moved, and a scorer bug should be a write failure rather than a silently wrong
 * ranking.
 */
export const commerceProductTrendingSnapshot = pgTable(
  "commerce_product_trending_snapshot",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    asOf: timestamp("as_of").notNull(),
    productId: text("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "cascade" }),
    categoryId: text("category_id").references(() => commerceCategory.id, {
      onDelete: "set null",
    }),
    currency: text("currency").notNull(),
    /** 1-indexed WITHIN ITS CATEGORY — a global rank across unrelated categories is not a
     * fact anyone consumes. */
    rank: integer("rank").notNull(),
    qualifiedVelocityPoints: integer("qualified_velocity_points").notNull(),
    demandFreshnessPoints: integer("demand_freshness_points").notNull(),
    conversionQualityPoints: integer("conversion_quality_points").notNull(),
    sellerTrustPoints: integer("seller_trust_points").notNull(),
    buyerEngagementPoints: integer("buyer_engagement_points").notNull(),
    trendingScorePoints: integer("trending_score_points").notNull(),
    /** Basis points, applied after the components sum. Separate columns rather than one
     * product, so an appeal can be told which signal fired. */
    subnetMultiplierBasisPoints: integer("subnet_multiplier_bp").default(10_000).notNull(),
    orderValueMultiplierBasisPoints: integer("order_value_multiplier_bp").default(10_000).notNull(),
    refundPenaltyBasisPoints: integer("refund_penalty_bp").default(10_000).notNull(),
    cancellationPenaltyBasisPoints: integer("cancellation_penalty_bp").default(10_000).notNull(),
    enforcementMultiplierBasisPoints: integer("enforcement_multiplier_bp")
      .default(10_000)
      .notNull(),
    finalScorePoints: integer("final_score_points").notNull(),
    qualifiedOrdersW1: integer("qualified_orders_w1").notNull(),
    qualifiedOrdersW2: integer("qualified_orders_w2").notNull(),
    distinctQualifiedBuyersW1: integer("distinct_qualified_buyers_w1").notNull(),
    countedViewsW1: integer("counted_views_w1").notNull(),
    savesW1: integer("saves_w1").notNull(),
    lastQualifiedOrderAt: timestamp("last_qualified_order_at"),
    demandAgeDays: integer("demand_age_days"),
    /**
     * EVERY MEASURED RATE IS NULLABLE AND SHIPS ITS SAMPLE SIZE — Phase 12's rule applied
     * to a snapshot instead of a wire. "Scored 0 because unmeasurable" and "scored 0
     * because it is genuinely 0%" must stay distinguishable in the stored row forever, or
     * nobody can audit why a product ranked where it did.
     */
    conversionRateBasisPoints: integer("conversion_rate_bp"),
    conversionSampleSize: integer("conversion_sample_size"),
    sellerOnTimeRateBasisPoints: integer("seller_on_time_rate_bp"),
    sellerOnTimeSampleSize: integer("seller_on_time_sample_size"),
    subnetConcentrationBasisPoints: integer("subnet_concentration_bp"),
    subnetSampleSize: integer("subnet_sample_size"),
    rankingMode: commerceRankingModeEnum("ranking_mode").notNull(),
    scoreAlgorithmVersion: integer("score_algorithm_version").default(1).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("commerce_product_trending_snapshot_product_unq").on(table.asOf, table.productId),
    /**
     * LOAD-BEARING. It makes a tie an INSERT FAILURE rather than "whichever order the
     * planner produced", which is what forces the scorer to carry a total order all the way
     * down to a deterministic tiebreak.
     */
    uniqueIndex("commerce_product_trending_snapshot_rank_unq").on(
      table.asOf,
      table.categoryId,
      table.rank,
    ),
    index("commerce_product_trending_snapshot_product_idx").on(table.productId, table.asOf.desc()),
    check(
      "commerce_product_trending_snapshot_score_ck",
      sql`rank >= 1
          AND trending_score_points BETWEEN 0 AND 100
          AND qualified_velocity_points >= 0 AND demand_freshness_points >= 0
          AND conversion_quality_points >= 0 AND seller_trust_points >= 0
          AND buyer_engagement_points >= 0
          AND qualified_velocity_points + demand_freshness_points + conversion_quality_points
              + seller_trust_points + buyer_engagement_points = trending_score_points`,
    ),
    /** A PENALTY CAN NEVER PROMOTE, as a database fact rather than a code convention. */
    check(
      "commerce_product_trending_snapshot_penalty_ck",
      sql`subnet_multiplier_bp BETWEEN 0 AND 10000
          AND order_value_multiplier_bp BETWEEN 0 AND 10000
          AND refund_penalty_bp BETWEEN 0 AND 10000
          AND cancellation_penalty_bp BETWEEN 0 AND 10000
          AND enforcement_multiplier_bp BETWEEN 0 AND 10000
          AND final_score_points BETWEEN 0 AND trending_score_points`,
    ),
    /** Rate and sample size are bound in BOTH directions. */
    check(
      "commerce_product_trending_snapshot_sample_ck",
      sql`(conversion_rate_bp IS NULL) = (conversion_sample_size IS NULL)
          AND (seller_on_time_rate_bp IS NULL) = (seller_on_time_sample_size IS NULL)
          AND (subnet_concentration_bp IS NULL) = (subnet_sample_size IS NULL)
          AND (conversion_rate_bp IS NULL OR conversion_rate_bp BETWEEN 0 AND 10000)
          AND (seller_on_time_rate_bp IS NULL OR seller_on_time_rate_bp BETWEEN 0 AND 10000)
          AND (subnet_concentration_bp IS NULL OR subnet_concentration_bp BETWEEN 0 AND 10000)
          AND (conversion_sample_size IS NULL OR conversion_sample_size >= 0)
          AND (seller_on_time_sample_size IS NULL OR seller_on_time_sample_size >= 0)
          AND (subnet_sample_size IS NULL OR subnet_sample_size >= 0)`,
    ),
    check(
      "commerce_product_trending_snapshot_inputs_ck",
      sql`qualified_orders_w1 >= 0 AND qualified_orders_w2 >= 0
          AND distinct_qualified_buyers_w1 >= 0 AND counted_views_w1 >= 0 AND saves_w1 >= 0
          AND (demand_age_days IS NULL OR demand_age_days >= 0)
          AND currency ~ '^[A-Z]{3}$'`,
    ),
  ],
);

/**
 * The live row a rail reads (Phase 13).
 *
 * Cleared and re-set wholesale each run. WITHOUT THE CLEAR, a product that fell out of its
 * category's top N would keep last hour's rank forever — the failure
 * `recompute-trending-videos` documents for `videoStats.trendingRank`.
 */
export const commerceProductRankingState = pgTable(
  "commerce_product_ranking_state",
  {
    productId: text("product_id")
      .primaryKey()
      .references(() => product.id, { onDelete: "cascade" }),
    categoryId: text("category_id").references(() => commerceCategory.id, {
      onDelete: "set null",
    }),
    /** NULL means "not ranked right now" — a normal state, not an error. */
    trendingRankInCategory: integer("trending_rank_in_category"),
    finalScorePoints: integer("final_score_points").notNull(),
    rankingMode: commerceRankingModeEnum("ranking_mode").notNull(),
    scoreAlgorithmVersion: integer("score_algorithm_version").default(1).notNull(),
    computedAt: timestamp("computed_at").notNull(),
  },
  (table) => [
    index("commerce_product_ranking_state_category_rank_idx")
      .on(table.categoryId, table.trendingRankInCategory)
      .where(sql`trending_rank_in_category IS NOT NULL`),
    check(
      "commerce_product_ranking_state_bounds_ck",
      sql`final_score_points BETWEEN 0 AND 100
          AND (trending_rank_in_category IS NULL OR trending_rank_in_category >= 1)`,
    ),
  ],
);

/**
 * Current suppression, which OUTLIVES the hourly run (Phase 13).
 *
 * A separate table from the snapshot precisely so a moderator's decision survives the
 * scorer truncating and rewriting its own output every hour. On a job-owned row, a human's
 * ruling would last until the next tick.
 */
export const commerceProductRankingEnforcement = pgTable(
  "commerce_product_ranking_enforcement",
  {
    productId: text("product_id")
      .primaryKey()
      .references(() => product.id, { onDelete: "cascade" }),
    action: commerceRankingEnforcementActionEnum("action").notNull(),
    actionSource: commerceRankingActionSourceEnum("action_source").notNull(),
    penaltyKinds: commerceRankingPenaltyKindEnum("penalty_kinds").array().default([]).notNull(),
    /** In words a seller could be shown. An unappealable suppression is how a marketplace
     * loses honest sellers. */
    reason: text("reason").notNull(),
    decidedByUserId: text("decided_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  () => [
    check(
      "commerce_product_ranking_enforcement_source_ck",
      sql`(action_source = 'automatic' AND decided_by_user_id IS NULL)
          OR (action_source = 'moderator' AND decided_by_user_id IS NOT NULL)`,
    ),
    check(
      "commerce_product_ranking_enforcement_reason_ck",
      sql`length(btrim(reason)) BETWEEN 3 AND 1000`,
    ),
  ],
);

/**
 * Every evaluation the breaker made, including the ones that did nothing (Phase 13).
 *
 * `action = 'none'` rows are the POINT of this table for its first weeks: the breaker ships
 * observe-only, and the rate at which it WOULD have fired is what justifies letting it
 * fire.
 */
export const commerceRankingEnforcementEvent = pgTable(
  "commerce_ranking_enforcement_event",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    productId: text("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "cascade" }),
    asOf: timestamp("as_of").notNull(),
    action: commerceRankingEnforcementActionEnum("action").notNull(),
    actionSource: commerceRankingActionSourceEnum("action_source").notNull(),
    penaltyKinds: commerceRankingPenaltyKindEnum("penalty_kinds").array().default([]).notNull(),
    /**
     * Which clauses were satisfied, and which could not be evaluated at all. The second
     * list is why this ships honest: at launch `fraudRiskScore` has no definable input, so
     * it appears as unevaluated rather than silently passing.
     */
    satisfiedClauses: text("satisfied_clauses").array().default([]).notNull(),
    unevaluatedClauses: text("unevaluated_clauses").array().default([]).notNull(),
    decidedByUserId: text("decided_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    note: text("note"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("commerce_ranking_enforcement_event_product_idx").on(table.productId, table.asOf.desc()),
    /** "How often would the breaker have fired last week?" — the query that decides whether
     * enforcement may be enabled at all. */
    index("commerce_ranking_enforcement_event_action_idx").on(table.asOf.desc(), table.action),
    check(
      "commerce_ranking_enforcement_event_source_ck",
      sql`(action_source = 'automatic' AND decided_by_user_id IS NULL)
          OR (action_source = 'moderator' AND decided_by_user_id IS NOT NULL)`,
    ),
  ],
);

/**
 * The per-product daily series (Phase 13).
 *
 * EASY TO OMIT AND THE WHOLE SPIKE DETECTOR DEPENDS ON IT. Refinement 6's MAD baseline
 * needs a per-product HISTORY; if the only history were the trending snapshot, and that
 * snapshot were pruned on the schedule its video sibling uses, the baseline could never be
 * computed and the dynamic trigger would be permanently dead — shipped, wired, and silently
 * returning nothing. Five integers a day per product is the cheapest thing in this phase.
 */
export const commerceProductDailySignal = pgTable(
  "commerce_product_daily_signal",
  {
    productId: text("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "cascade" }),
    signalDate: date("signal_date", { mode: "string" }).notNull(),
    countedViews: integer("counted_views").default(0).notNull(),
    saves: integer("saves").default(0).notNull(),
    shares: integer("shares").default(0).notNull(),
    qualifiedOrders: integer("qualified_orders").default(0).notNull(),
    qualifiedOrderValueInCents: bigint("qualified_order_value_in_cents", { mode: "number" })
      .default(0)
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      name: "commerce_product_daily_signal_pk",
      columns: [table.productId, table.signalDate],
    }),
    index("commerce_product_daily_signal_recent_idx").on(table.productId, table.signalDate.desc()),
    check(
      "commerce_product_daily_signal_bounds_ck",
      sql`counted_views >= 0 AND saves >= 0 AND shares >= 0
          AND qualified_orders >= 0 AND qualified_order_value_in_cents >= 0`,
    ),
  ],
);

/**
 * Derived engagement counters for a product (STORE Appendix A11, A9).
 *
 * A SEPARATE TABLE, not columns on `product`. That row is wide, hot and seller-owned:
 * a buyer's favourite tap would take a row lock the seller's price edit needs, and it
 * would mix seller-DECLARED truth with platform-DERIVED counters in one place, which
 * is precisely the distinction A13 says must stay visible.
 *
 * Not `count(*)` at read time either: a COUNT per product-detail page is survivable,
 * but a COUNT per card across a 24-card grid is the query that gets slow silently.
 *
 * Every counter moves in the SAME TRANSACTION as the row that caused it, and only
 * when that row actually appeared or disappeared — see `setProductEngagement`.
 */
export const commerceProductStats = pgTable(
  "commerce_product_stats",
  {
    productId: text("product_id")
      .primaryKey()
      .references(() => product.id, { onDelete: "cascade" }),
    savedCount: integer("saved_count").default(0).notNull(),
    bookmarkedCount: integer("bookmarked_count").default(0).notNull(),
    shareCount: integer("share_count").default(0).notNull(),
    /** Visible questions (A9). */
    questionCount: integer("question_count").default(0).notNull(),
    /** Visible questions carrying at least one visible answer (A9). */
    answeredQuestionCount: integer("answered_question_count").default(0).notNull(),
    /** Moves once per session, on the `isCountedView` transition (Phase 13). */
    viewCount: integer("view_count").default(0).notNull(),
    /**
     * NULLABLE WITH NO DEFAULT, and that is the point. No transaction can maintain a
     * DISTINCT count incrementally, so this is written by the nightly rollup or not at
     * all — and a default of 0 would state a false denominator to every conversion
     * computation that ran before the first rollup. `videoStats.uniqueViewerCount` is
     * nullable for the identical reason.
     */
    uniqueViewerCount: integer("unique_viewer_count"),
    lastEngagementAt: timestamp("last_engagement_at", { precision: 3 }),
  },
  (table) => [
    check(
      "commerce_product_stats_counters_non_negative_ck",
      sql`saved_count >= 0 AND bookmarked_count >= 0 AND share_count >= 0
          AND question_count >= 0 AND answered_question_count >= 0
          AND answered_question_count <= question_count
          AND view_count >= 0
          AND (unique_viewer_count IS NULL OR (unique_viewer_count >= 0 AND unique_viewer_count <= view_count))`,
    ),
    index("commerce_product_stats_saved_idx").on(table.savedCount, table.productId),
  ],
);

/**
 * A public question about a listing (STORE Appendix A9).
 *
 * NO ORGANIZATION COLUMN, deliberately. A question is asked by a PERSON, and
 * snapshotting the asker's employer would publish it on a public surface — a
 * disclosure decision of the kind §14 governs, which Q&A does not need to make.
 * Organizations appear only on ANSWERS, where the badge is the substance.
 *
 * This is also the channel that keeps A14's organization gate honest: a buyer with no
 * commerce organization cannot open a pre-sales thread, but can always ask here, and
 * "do you ship to Kenya?" is better answered publicly once than privately a hundred
 * times.
 */
export const commerceProductQuestion = pgTable(
  "commerce_product_question",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    productId: text("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "restrict" }),
    /** `restrict`: deleting an account is an anonymization problem, not a cascade. */
    askedByUserId: text("asked_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    bodyText: text("body_text").notNull(),
    visibilityState: commerceUgcVisibilityStateEnum("visibility_state")
      .default("visible")
      .notNull(),
    answerCount: integer("answer_count").default(0).notNull(),
    /** Drives the "answered by the seller" badge without a join on the list read. */
    hasSellerAnswer: boolean("has_seller_answer").default(false).notNull(),
    hiddenAt: timestamp("hidden_at", { precision: 3 }),
    hiddenByUserId: text("hidden_by_user_id").references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { precision: 3 })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("commerce_product_question_public_idx").on(
      table.productId,
      table.visibilityState,
      table.createdAt,
      table.id,
    ),
    index("commerce_product_question_author_idx").on(
      table.askedByUserId,
      table.createdAt,
      table.id,
    ),
    check("commerce_product_question_body_ck", sql`char_length(body_text) BETWEEN 1 AND 1000`),
    check("commerce_product_question_answer_count_ck", sql`answer_count >= 0`),
    /**
     * A hidden row records WHEN and, for a moderator hide, BY WHOM. An author
     * retraction has no moderator, which is why `hidden_by_user_id` is not bound to
     * `hidden_at` the way the two moderation columns are bound to each other.
     */
    check(
      "commerce_product_question_hidden_ck",
      sql`(visibility_state = 'visible') = (hidden_at IS NULL)
          AND (hidden_by_user_id IS NULL OR visibility_state = 'hidden_by_moderator')`,
    ),
  ],
);

/**
 * An answer to a product question (STORE Appendix A9).
 *
 * `verifiedCompletionId` IS THE DESIGN. The verified-buyer badge is earned
 * structurally — exactly as A8 demands of reviews — because an answer cannot claim it
 * without pointing at a `commerce_completion` row. It is not a boolean a service sets,
 * and it is not derivable from the request.
 */
export const commerceProductAnswer = pgTable(
  "commerce_product_answer",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    questionId: text("question_id")
      .notNull()
      .references(() => commerceProductQuestion.id, { onDelete: "cascade" }),
    authorUserId: text("author_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    authorKind: commerceProductAnswerAuthorKindEnum("author_kind").notNull(),
    authorOrganizationId: text("author_organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    authorMemberId: text("author_member_id")
      .notNull()
      .references(() => commerceOrganizationMember.id, { onDelete: "restrict" }),
    verifiedCompletionId: text("verified_completion_id").references(() => commerceCompletion.id, {
      onDelete: "restrict",
    }),
    bodyText: text("body_text").notNull(),
    visibilityState: commerceUgcVisibilityStateEnum("visibility_state")
      .default("visible")
      .notNull(),
    /**
     * A24. Denormalized for the same reason `commerce_review.helpfulCount` is: the
     * seller-first preview breaks its tie on this, and a correlated count in an
     * ORDER BY cannot use an index. `0` is a measurement, not an absence of one.
     */
    helpfulCount: integer("helpful_count").default(0).notNull(),
    hiddenAt: timestamp("hidden_at", { precision: 3 }),
    hiddenByUserId: text("hidden_by_user_id").references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { precision: 3 })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    /**
     * One answer per organization per question. A seller that could post five answers
     * would own the whole thread; a buyer that could would be a review section with
     * no completion requirement.
     */
    uniqueIndex("commerce_product_answer_question_org_uidx").on(
      table.questionId,
      table.authorOrganizationId,
    ),
    index("commerce_product_answer_question_idx").on(table.questionId, table.createdAt, table.id),
    index("commerce_product_answer_question_helpful_idx")
      .on(table.questionId, table.helpfulCount.desc(), table.id)
      .where(sql`visibility_state = 'visible'`),
    index("commerce_product_answer_organization_idx").on(
      table.authorOrganizationId,
      table.createdAt,
    ),
    check("commerce_product_answer_body_ck", sql`char_length(body_text) BETWEEN 1 AND 4000`),
    check("commerce_product_answer_helpful_count_ck", sql`helpful_count >= 0`),
    /** The badge and its proof travel together, in both directions. */
    check(
      "commerce_product_answer_verified_ck",
      sql`(author_kind = 'verified_buyer') = (verified_completion_id IS NOT NULL)`,
    ),
    check(
      "commerce_product_answer_hidden_ck",
      sql`(visibility_state = 'visible') = (hidden_at IS NULL)
          AND (hidden_by_user_id IS NULL OR visibility_state = 'hidden_by_moderator')`,
    ),
  ],
);

export const storeHeroSlide = pgTable(
  "store_hero_slide",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    title: text("title").notNull(),
    subtitle: text("subtitle"),
    accent: storePresentationAccentEnum("accent").default("slate").notNull(),
    imageUrl: text("image_url"),
    linkTargetKind: storeMerchandisingEntityKindEnum("link_target_kind"),
    linkTargetId: text("link_target_id"),
    linkTargetSlug: text("link_target_slug"),
    siblingOrder: integer("sibling_order").notNull(),
    state: storeMerchandisingStateEnum("state").default("draft").notNull(),
    startsAt: timestamp("starts_at"),
    endsAt: timestamp("ends_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("store_hero_slide_state_order_idx").on(table.state, table.siblingOrder, table.id),
    check("store_hero_slide_title_ck", sql`char_length(title) BETWEEN 1 AND 120`),
    check(
      "store_hero_slide_subtitle_ck",
      sql`subtitle IS NULL OR char_length(subtitle) BETWEEN 1 AND 280`,
    ),
    check(
      "store_hero_slide_image_ck",
      sql`image_url IS NULL OR (char_length(image_url) <= 2048 AND image_url LIKE 'https://%')`,
    ),
    check(
      "store_hero_slide_window_ck",
      sql`starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at`,
    ),
    /**
     * A19. The three link columns were nullable and independent, so a slide could
     * carry a target kind with nothing to link to and the frontend had to guard by
     * requiring both before building an href. A link is all three or none.
     */
    check(
      "store_hero_slide_link_target_ck",
      sql`(link_target_kind IS NULL AND link_target_id IS NULL AND link_target_slug IS NULL)
          OR (link_target_kind IS NOT NULL AND link_target_id IS NOT NULL
              AND link_target_slug IS NOT NULL)`,
    ),
  ],
);

/**
 * A guided pathway — the buy-the-set surface (§15).
 *
 * A rail ranks products that happen to be good and the buyer picks one; a pathway is
 * a SET whose members relate to each other and whose buyer wants the whole thing.
 * Two shapes share this one table, distinguished by `anchorProductId`: a CURATED set
 * (null anchor) whose slots a merchandiser typed, and an ANCHORED set whose slots
 * resolve their candidates from the relation graph (§15.1).
 */
export const storePathway = pgTable(
  "store_pathway",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    accent: storePresentationAccentEnum("accent").default("slate").notNull(),
    state: storeMerchandisingStateEnum("state").default("draft").notNull(),
    /** Non-null makes this an anchored set: slots resolve against this product. */
    anchorProductId: text("anchor_product_id").references(() => product.id, {
      onDelete: "restrict",
    }),
    heroImageUrl: text("hero_image_url"),
    /**
     * Platform-hosted since `0091`, and this is the table where it mattered most. A
     * seller may PROPOSE a pathway (§15.5) and a moderator publishes it, after which
     * `EDITABLE_PATHWAY_STATES` freezes the row — so the store presents the image as
     * reviewed. Under a hotlink the moderator reviewed a URL, and the seller could swap
     * the bytes behind it afterwards. NULL means a legacy hotlink from before `0091`.
     */
    heroImageCloudinaryPublicId: text("hero_image_cloudinary_public_id"),
    heroImageWidthPx: integer("hero_image_width_px"),
    heroImageHeightPx: integer("hero_image_height_px"),
    cardImageUrl: text("card_image_url"),
    cardImageCloudinaryPublicId: text("card_image_cloudinary_public_id"),
    cardImageWidthPx: integer("card_image_width_px"),
    cardImageHeightPx: integer("card_image_height_px"),
    /**
     * Null means platform-curated. A non-null owner is a SELLER PROPOSAL (§15.5),
     * and the difference decides who may edit it and whether publication requires a
     * moderator — without which a seller composes a set entirely from its own SKUs
     * and a curated look becomes an advertisement.
     */
    ownerOrganizationId: text("owner_organization_id").references(() => commerceOrganization.id, {
      onDelete: "restrict",
    }),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    submittedAt: timestamp("submitted_at"),
    reviewedByUserId: text("reviewed_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    reviewedAt: timestamp("reviewed_at"),
    reviewNote: text("review_note"),
    startsAt: timestamp("starts_at"),
    endsAt: timestamp("ends_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("store_pathway_slug_uidx").on(table.slug),
    index("store_pathway_state_idx").on(table.state, table.id),
    index("store_pathway_owner_idx")
      .on(table.ownerOrganizationId, table.state, table.id)
      .where(sql`owner_organization_id IS NOT NULL`),
    index("store_pathway_anchor_idx")
      .on(table.anchorProductId)
      .where(sql`anchor_product_id IS NOT NULL`),
    index("store_pathway_moderation_queue_idx").on(table.state, table.submittedAt, table.id),
    check(
      "store_pathway_images_ck",
      sql`(hero_image_url IS NULL OR (char_length(hero_image_url) <= 2048 AND hero_image_url LIKE 'https://%'))
          AND (card_image_url IS NULL OR (char_length(card_image_url) <= 2048 AND card_image_url LIKE 'https://%'))`,
    ),
    /**
     * Review attribution is paired, only a decided state may carry it, and a seller
     * proposal cannot reach a decided state unreviewed. A platform-curated pathway
     * publishes without a reviewer because the merchandiser publishing it IS the
     * decision — and because rows predating this column must not be invalidated.
     */
    check(
      "store_pathway_review_ck",
      sql`((reviewed_by_user_id IS NULL) = (reviewed_at IS NULL))
          AND (reviewed_at IS NULL OR state IN ('active', 'rejected'))
          AND (
            owner_organization_id IS NULL
            OR state NOT IN ('active', 'rejected')
            OR reviewed_by_user_id IS NOT NULL
          )
          AND (state <> 'pending_review' OR submitted_at IS NOT NULL)`,
    ),
    check(
      "store_pathway_review_note_ck",
      sql`review_note IS NULL OR char_length(review_note) BETWEEN 1 AND 2000`,
    ),
    check(
      "store_pathway_slug_ck",
      sql`slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) BETWEEN 3 AND 100`,
    ),
    check("store_pathway_title_ck", sql`char_length(title) BETWEEN 1 AND 120`),
    check(
      "store_pathway_summary_ck",
      sql`summary IS NULL OR char_length(summary) BETWEEN 1 AND 500`,
    ),
    check(
      "store_pathway_window_ck",
      sql`starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at`,
    ),
    check(
      "store_pathway_hosted_hero_image_ck",
      sql`(hero_image_cloudinary_public_id IS NULL AND hero_image_width_px IS NULL
           AND hero_image_height_px IS NULL)
          OR (hero_image_url IS NOT NULL AND hero_image_cloudinary_public_id IS NOT NULL
              AND hero_image_width_px > 0 AND hero_image_height_px > 0)`,
    ),
    check(
      "store_pathway_hosted_card_image_ck",
      sql`(card_image_cloudinary_public_id IS NULL AND card_image_width_px IS NULL
           AND card_image_height_px IS NULL)
          OR (card_image_url IS NOT NULL AND card_image_cloudinary_public_id IS NOT NULL
              AND card_image_width_px > 0 AND card_image_height_px > 0)`,
    ),
  ],
);

/*
 * `store_pathway_item` was here. Phase 9 replaced that flat list with
 * {@link storePathwaySlot} and {@link storePathwaySlotCandidate} (§15.2), migration
 * `0058` backfilled its product rows into slots, and migration `0088` dropped the
 * table. The Drizzle declaration outlived the table by one phase, which is why the
 * Phase 1/2, 8 and 9 verifiers all still asserted against it and all three failed
 * against an `0089` database — the Phase 9 one by throwing `42P01` and losing every
 * other check it makes.
 *
 * Why it was wrong for a set, kept because the reasoning still governs the slot model:
 * `entityId` had no foreign key, so a member that became ineligible was dropped
 * silently and a five-piece look rendered as three pieces with nothing saying a piece
 * was missing. For a rail that is correct; for a set it is a lie.
 */

/**
 * A ROLE in a guided set — "Footwear", "Front light", "Chain bolts" (§15.2).
 *
 * `roleLabel` is free text, like `specificationGroup` in A3: the roles in a hotel
 * refit and a bicycle build share nothing, so an enum would be wrong in every
 * category it failed to anticipate.
 *
 * `derivedRelationKind` is what makes an anchored set anchored — the slot names an
 * edge kind and its candidates are read from `commerce_product_relation` against the
 * pathway's anchor, rather than being typed by a merchandiser. A database trigger
 * (`store_pathway_slot_anchor_guard`) refuses a derived slot on an unanchored pathway.
 */
export const storePathwaySlot = pgTable(
  "store_pathway_slot",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    pathwayId: text("pathway_id")
      .notNull()
      .references(() => storePathway.id, { onDelete: "cascade" }),
    roleLabel: text("role_label").notNull(),
    /** A required slot with no fillable candidate makes the whole set incomplete (§15.6). */
    isRequired: boolean("is_required").default(true).notNull(),
    /** How many units of the chosen candidate: one saddle, twelve bolts. */
    quantity: integer("quantity").default(1).notNull(),
    siblingOrder: integer("sibling_order").notNull(),
    derivedRelationKind: commerceProductRelationKindEnum("derived_relation_kind"),
    startsAt: timestamp("starts_at"),
    endsAt: timestamp("ends_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("store_pathway_slot_order_uidx").on(table.pathwayId, table.siblingOrder),
    index("store_pathway_slot_pathway_idx").on(table.pathwayId, table.siblingOrder, table.id),
    check("store_pathway_slot_role_label_ck", sql`char_length(role_label) BETWEEN 1 AND 80`),
    check("store_pathway_slot_quantity_ck", sql`quantity BETWEEN 1 AND 1000000`),
    check("store_pathway_slot_order_ck", sql`sibling_order >= 0`),
    check(
      "store_pathway_slot_window_ck",
      sql`starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at`,
    ),
  ],
);

/**
 * The products that can fill a slot, ranked (§15.2).
 *
 * Candidates rather than one product per slot are what make a swap possible ("show me
 * a cheaper saddle") and what turn a silently shrinking set into a fall-through: when
 * rank 0 is out of stock the slot offers rank 1 instead of disappearing. A set is only
 * as robust as its substitutes.
 *
 * `variantId` is not in §15.2 and A1 requires it: a product with active variants
 * refuses a cart line naming none, so a candidate without one would be a piece the set
 * advertises and cannot sell. `store_pathway_slot_candidate_variant_guard` enforces
 * both that rule and variant ownership.
 */
export const storePathwaySlotCandidate = pgTable(
  "store_pathway_slot_candidate",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    slotId: text("slot_id")
      .notNull()
      .references(() => storePathwaySlot.id, { onDelete: "cascade" }),
    /** A REAL foreign key, unlike the dropped `store_pathway_item.entity_id`. */
    productId: text("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "restrict" }),
    variantId: text("variant_id").references(() => commerceProductVariant.id, {
      onDelete: "restrict",
    }),
    /** 0 is the default the set shows first. */
    rank: integer("rank").default(0).notNull(),
    sourceKind: storePathwaySlotCandidateSourceKindEnum("source_kind").default("curated").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    /**
     * Expression index over `coalesce(variant_id, '')`, the shape 0054/0055
     * established: one product in two variants is two legitimate candidates for the
     * same slot, but the same (product, variant) twice is not.
     */
    uniqueIndex("store_pathway_slot_candidate_uidx").on(
      table.slotId,
      table.productId,
      sql`coalesce(${table.variantId}, '')`,
    ),
    index("store_pathway_slot_candidate_rank_idx").on(table.slotId, table.rank, table.id),
    index("store_pathway_slot_candidate_product_idx").on(table.productId),
    check("store_pathway_slot_candidate_rank_ck", sql`rank >= 0 AND rank <= 10000`),
    /** Derived candidates are computed at read time; only curated rows are stored. */
    check("store_pathway_slot_candidate_source_ck", sql`source_kind = 'curated'`),
  ],
);

export const storeRail = pgTable(
  "store_rail",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    strategy: storeRailStrategyEnum("strategy").notNull(),
    state: storeMerchandisingStateEnum("state").default("draft").notNull(),
    startsAt: timestamp("starts_at"),
    endsAt: timestamp("ends_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("store_rail_slug_uidx").on(table.slug),
    index("store_rail_state_idx").on(table.state, table.id),
    check(
      "store_rail_slug_ck",
      sql`slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) BETWEEN 3 AND 100`,
    ),
    check("store_rail_title_ck", sql`char_length(title) BETWEEN 1 AND 120`),
    check("store_rail_window_ck", sql`starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at`),
  ],
);

export const storeRailPlacement = pgTable(
  "store_rail_placement",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    railId: text("rail_id")
      .notNull()
      .references(() => storeRail.id, { onDelete: "cascade" }),
    entityKind: storeMerchandisingEntityKindEnum("entity_kind").notNull(),
    entityId: text("entity_id").notNull(),
    position: integer("position").notNull(),
    startsAt: timestamp("starts_at"),
    endsAt: timestamp("ends_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("store_rail_placement_rail_idx").on(table.railId, table.position),
    uniqueIndex("store_rail_placement_unique_uidx").on(
      table.railId,
      table.entityKind,
      table.entityId,
    ),
    check("store_rail_placement_position_ck", sql`position >= 0`),
    check(
      "store_rail_placement_window_ck",
      sql`starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at`,
    ),
  ],
);

/**
 * Denormalized public search rows. Refreshed after product/offering mutations.
 * Only eligible public fields belong here.
 */
export const storeSearchDocument = pgTable(
  "store_search_document",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    documentKind: storeSearchDocumentKindEnum("document_kind").notNull(),
    entityId: text("entity_id").notNull(),
    publicSlug: text("public_slug").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    organizationId: text("organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "cascade" }),
    organizationSlug: text("organization_slug").notNull(),
    organizationDisplayName: text("organization_display_name").notNull(),
    organizationCountryCode: text("organization_country_code").notNull(),
    categoryId: text("category_id").references(() => commerceCategory.id, {
      onDelete: "set null",
    }),
    categorySlug: text("category_slug"),
    providerKind: commerceProviderKindSlugEnum("provider_kind"),
    priceInCents: integer("price_in_cents"),
    currency: text("currency"),
    minimumOrderQuantity: integer("minimum_order_quantity"),
    /**
     * A25. The facets `getCategoryFacets` already computes, denormalized so
     * `/store/search` can FILTER on them and not merely count them.
     *
     * Publishing a count the caller cannot act on is an invitation to filter the fetched
     * page, which is what §2.4 forbids. Joining to `product` for these would defeat every
     * keyset index the three sort branches rely on — the same argument that put
     * `discoveryScorePoints` on this table.
     *
     * All five are NULL on the document kinds they do not describe: a provider offering
     * has no stock state, an organization has neither stock nor a sample policy.
     */
    stockState: storeSearchStockStateEnum("stock_state"),
    samplePolicy: productSamplePolicyEnum("sample_policy"),
    condition: productConditionEnum("condition"),
    providerVerificationState: commerceProviderVerificationStateEnum("provider_verification_state"),
    leadTimeMaxDays: integer("lead_time_max_days"),
    searchText: text("search_text").notNull(),
    /**
     * Weighted FTS document for `/store/search` relevance ranking.
     * GENERATED ALWAYS so title/summary edits cannot drift from the index.
     * Title A > organization display name B > summary/body C.
     */
    searchDocument: tsvector("search_document").generatedAlwaysAs(
      sql`setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
          setweight(to_tsvector('english', coalesce(organization_display_name, '')), 'B') ||
          setweight(to_tsvector('english', coalesce(summary, '') || ' ' || coalesce(search_text, '')), 'C')`,
    ),
    isEligible: boolean("is_eligible").default(true).notNull(),
    /**
     * The Phase 13 ranking score, denormalized here ONLY because search cannot afford the
     * join — a `sort=discovery` LEFT JOIN to `commerce_product_ranking_state` cannot use an
     * index for its ORDER BY.
     *
     * MACHINE-OWNED, IN A HUMAN-OWNED ROW. `refreshProductSearchDocument` upserts this table
     * on every product edit, and its `set` block survives these columns by style rather than
     * by guarantee. `store_search_document_preserve_discovery_score` makes that a guarantee:
     * a writer that has not set `qatoto.ranking_writer` has its change to these two columns
     * silently reverted.
     *
     * NULL means "not scored", which is most of the catalog most of the time. No default,
     * for the reason `uniqueViewerCount` has none: a 0 would be a claim.
     */
    discoveryScorePoints: integer("discovery_score_points"),
    discoveryScoreComputedAt: timestamp("discovery_score_computed_at"),
    publishedAt: timestamp("published_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("store_search_document_kind_entity_uidx").on(table.documentKind, table.entityId),
    index("store_search_document_eligible_title_idx")
      .on(table.isEligible, table.title, table.id)
      .where(sql`is_eligible`),
    index("store_search_document_organization_idx").on(table.organizationId, table.id),
    index("store_search_document_category_idx").on(table.categoryId, table.id),
    index("store_search_document_provider_kind_idx").on(table.providerKind, table.id),
    index("store_search_document_fts_idx").using("gin", table.searchDocument),
    index("store_search_document_stock_idx")
      .on(table.isEligible, table.stockState, table.id)
      .where(sql`is_eligible`),
    index("store_search_document_price_idx")
      .on(table.isEligible, table.priceInCents, table.id)
      .where(sql`is_eligible`),
    index("store_search_document_discovery_idx")
      .on(table.isEligible, table.discoveryScorePoints.desc().nullsLast(), table.id)
      .where(sql`is_eligible`),
    check(
      "store_search_document_discovery_score_ck",
      sql`(discovery_score_points IS NULL) = (discovery_score_computed_at IS NULL)
          AND (discovery_score_points IS NULL OR discovery_score_points BETWEEN 0 AND 100)`,
    ),
    check(
      "store_search_document_slug_ck",
      sql`public_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
          AND organization_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`,
    ),
    check("store_search_document_country_ck", sql`organization_country_code ~ '^[A-Z]{2}$'`),
    check(
      "store_search_document_lead_time_ck",
      sql`lead_time_max_days IS NULL OR lead_time_max_days BETWEEN 0 AND 3650`,
    ),
  ],
);

/** Seeded catalog of provider kinds (STORE §4.5). */
export const commerceProviderKind = pgTable(
  "commerce_provider_kind",
  {
    slug: commerceProviderKindSlugEnum("slug").primaryKey(),
    label: text("label").notNull(),
    summary: text("summary"),
    siblingOrder: integer("sibling_order").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("commerce_provider_kind_order_uidx").on(table.siblingOrder),
    check("commerce_provider_kind_label_ck", sql`char_length(label) BETWEEN 1 AND 80`),
  ],
);

export const commerceProviderProfile = pgTable(
  "commerce_provider_profile",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => commerceOrganization.id, { onDelete: "cascade" }),
    publicSummary: text("public_summary"),
    supportPolicy: text("support_policy"),
    verificationState: commerceProviderVerificationStateEnum("verification_state")
      .default("unverified")
      .notNull(),
    acceptingRequests: boolean("accepting_requests").default(true).notNull(),
    serviceRegionSummary: text("service_region_summary"),
    averageResponseTimeHours: integer("average_response_time_hours"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("commerce_provider_profile_verification_idx").on(table.verificationState),
    check(
      "commerce_provider_profile_text_ck",
      sql`(public_summary IS NULL OR char_length(public_summary) <= 4000)
          AND (support_policy IS NULL OR char_length(support_policy) <= 4000)
          AND (service_region_summary IS NULL OR char_length(service_region_summary) <= 1000)`,
    ),
    check(
      "commerce_provider_profile_response_ck",
      sql`average_response_time_hours IS NULL OR average_response_time_hours BETWEEN 0 AND 8760`,
    ),
  ],
);

export const commerceProviderKindLink = pgTable(
  "commerce_provider_kind_link",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => commerceProviderProfile.organizationId, { onDelete: "cascade" }),
    providerKind: commerceProviderKindSlugEnum("provider_kind")
      .notNull()
      .references(() => commerceProviderKind.slug, { onDelete: "restrict" }),
    verificationState: commerceProviderVerificationStateEnum("verification_state")
      .default("unverified")
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("commerce_provider_kind_link_org_kind_uidx").on(
      table.organizationId,
      table.providerKind,
    ),
    index("commerce_provider_kind_link_kind_idx").on(table.providerKind, table.verificationState),
  ],
);

export const commerceServiceOffering = pgTable(
  "commerce_service_offering",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    slug: text("slug").notNull(),
    providerOrganizationId: text("provider_organization_id")
      .notNull()
      .references(() => commerceProviderProfile.organizationId, { onDelete: "restrict" }),
    providerKind: commerceProviderKindSlugEnum("provider_kind")
      .notNull()
      .references(() => commerceProviderKind.slug, { onDelete: "restrict" }),
    title: text("title").notNull(),
    summary: text("summary"),
    state: commerceServiceOfferingStateEnum("state").default("draft").notNull(),
    pricingModel: commerceServicePricingModelEnum("pricing_model").notNull(),
    indicativePriceMinInCents: integer("indicative_price_min_in_cents"),
    indicativePriceMaxInCents: integer("indicative_price_max_in_cents"),
    currency: text("currency").default("USD").notNull(),
    minimumLeadTimeDays: integer("minimum_lead_time_days"),
    maximumLeadTimeDays: integer("maximum_lead_time_days"),
    moderatedByUserId: text("moderated_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    moderatedAt: timestamp("moderated_at"),
    moderationReason: text("moderation_reason"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("commerce_service_offering_slug_uidx").on(table.slug),
    index("commerce_service_offering_provider_idx").on(
      table.providerOrganizationId,
      table.state,
      table.id,
    ),
    index("commerce_service_offering_kind_state_idx").on(table.providerKind, table.state, table.id),
    check(
      "commerce_service_offering_slug_ck",
      sql`slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) BETWEEN 3 AND 120`,
    ),
    check("commerce_service_offering_title_ck", sql`char_length(title) BETWEEN 1 AND 200`),
    check(
      "commerce_service_offering_summary_ck",
      sql`summary IS NULL OR char_length(summary) <= 4000`,
    ),
    check(
      "commerce_service_offering_price_ck",
      sql`(indicative_price_min_in_cents IS NULL AND indicative_price_max_in_cents IS NULL)
          OR (indicative_price_min_in_cents IS NOT NULL AND indicative_price_max_in_cents IS NOT NULL
              AND indicative_price_min_in_cents >= 0
              AND indicative_price_max_in_cents >= indicative_price_min_in_cents)`,
    ),
    check(
      "commerce_service_offering_lead_ck",
      sql`(minimum_lead_time_days IS NULL AND maximum_lead_time_days IS NULL)
          OR (minimum_lead_time_days IS NOT NULL AND maximum_lead_time_days IS NOT NULL
              AND minimum_lead_time_days >= 0
              AND maximum_lead_time_days >= minimum_lead_time_days
              AND maximum_lead_time_days <= 3650)`,
    ),
    check("commerce_service_offering_currency_ck", sql`currency ~ '^[A-Z]{3}$'`),
  ],
);

export const commerceServiceCoverage = pgTable(
  "commerce_service_coverage",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    offeringId: text("offering_id")
      .notNull()
      .references(() => commerceServiceOffering.id, { onDelete: "cascade" }),
    originCountryCode: text("origin_country_code"),
    destinationCountryCode: text("destination_country_code"),
    originRegionLabel: text("origin_region_label"),
    destinationRegionLabel: text("destination_region_label"),
    locationIdentifier: text("location_identifier"),
    supportsHazardousGoods: boolean("supports_hazardous_goods").default(false).notNull(),
    supportsConsolidation: boolean("supports_consolidation").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("commerce_service_coverage_offering_idx").on(table.offeringId),
    /**
     * A16. The only existing reader loads every coverage row for one offering. The
     * delivery estimator asks the opposite question — "which offerings cover IN → DE" —
     * and nothing indexed either country column before Phase 11.
     */
    index("commerce_service_coverage_route_idx").on(
      table.originCountryCode,
      table.destinationCountryCode,
    ),
    check(
      "commerce_service_coverage_country_ck",
      sql`(origin_country_code IS NULL OR origin_country_code ~ '^[A-Z]{2}$')
          AND (destination_country_code IS NULL OR destination_country_code ~ '^[A-Z]{2}$')`,
    ),
  ],
);

export const freightOfferingDetail = pgTable("freight_offering_detail", {
  offeringId: text("offering_id")
    .primaryKey()
    .references(() => commerceServiceOffering.id, { onDelete: "cascade" }),
  transportModes: freightTransportModeEnum("transport_modes").array().notNull().default([]),
  supportsConsolidation: boolean("supports_consolidation").default(false).notNull(),
  supportsContainers: boolean("supports_containers").default(false).notNull(),
  supportsHazardousGoods: boolean("supports_hazardous_goods").default(false).notNull(),
});

export const customsBrokerageOfferingDetail = pgTable(
  "customs_brokerage_offering_detail",
  {
    offeringId: text("offering_id")
      .primaryKey()
      .references(() => commerceServiceOffering.id, { onDelete: "cascade" }),
    jurisdictions: text("jurisdictions").array().notNull().default([]),
    importSupported: boolean("import_supported").default(true).notNull(),
    exportSupported: boolean("export_supported").default(true).notNull(),
    commodityCoverageSummary: text("commodity_coverage_summary"),
  },
  (_table) => [
    check(
      "customs_brokerage_offering_detail_summary_ck",
      sql`commodity_coverage_summary IS NULL OR char_length(commodity_coverage_summary) <= 2000`,
    ),
  ],
);

export const insuranceOfferingDetail = pgTable(
  "insurance_offering_detail",
  {
    offeringId: text("offering_id")
      .primaryKey()
      .references(() => commerceServiceOffering.id, { onDelete: "cascade" }),
    cargoCoverageClasses: text("cargo_coverage_classes").array().notNull().default([]),
    coverageLimitMinInCents: integer("coverage_limit_min_in_cents"),
    coverageLimitMaxInCents: integer("coverage_limit_max_in_cents"),
    currency: text("currency").default("USD").notNull(),
    exclusionsDocumentReference: text("exclusions_document_reference"),
  },
  (_table) => [
    check("insurance_offering_detail_currency_ck", sql`currency ~ '^[A-Z]{3}$'`),
    check(
      "insurance_offering_detail_limits_ck",
      sql`(coverage_limit_min_in_cents IS NULL AND coverage_limit_max_in_cents IS NULL)
          OR (coverage_limit_min_in_cents IS NOT NULL AND coverage_limit_max_in_cents IS NOT NULL
              AND coverage_limit_min_in_cents >= 0
              AND coverage_limit_max_in_cents >= coverage_limit_min_in_cents)`,
    ),
  ],
);

export const inspectionOfferingDetail = pgTable("inspection_offering_detail", {
  offeringId: text("offering_id")
    .primaryKey()
    .references(() => commerceServiceOffering.id, { onDelete: "cascade" }),
  preProduction: boolean("pre_production").default(false).notNull(),
  duringProduction: boolean("during_production").default(false).notNull(),
  preShipment: boolean("pre_shipment").default(false).notNull(),
  loadingSupervision: boolean("loading_supervision").default(false).notNull(),
});

export const testingCertificationOfferingDetail = pgTable("testing_certification_offering_detail", {
  offeringId: text("offering_id")
    .primaryKey()
    .references(() => commerceServiceOffering.id, { onDelete: "cascade" }),
  standards: text("standards").array().notNull().default([]),
  accreditationBodies: text("accreditation_bodies").array().notNull().default([]),
  laboratoryLocations: text("laboratory_locations").array().notNull().default([]),
});

export const marketingOfferingDetail = pgTable(
  "marketing_offering_detail",
  {
    offeringId: text("offering_id")
      .primaryKey()
      .references(() => commerceServiceOffering.id, { onDelete: "cascade" }),
    channels: text("channels").array().notNull().default([]),
    targetRegions: text("target_regions").array().notNull().default([]),
    languageCapabilities: text("language_capabilities").array().notNull().default([]),
    engagementModel: text("engagement_model"),
  },
  (_table) => [
    check(
      "marketing_offering_detail_engagement_ck",
      sql`engagement_model IS NULL OR char_length(engagement_model) <= 200`,
    ),
  ],
);

export const warehouseOfferingDetail = pgTable(
  "warehouse_offering_detail",
  {
    offeringId: text("offering_id")
      .primaryKey()
      .references(() => commerceServiceOffering.id, { onDelete: "cascade" }),
    storageTypes: text("storage_types").array().notNull().default([]),
    temperatureControlled: boolean("temperature_controlled").default(false).notNull(),
    bondedStatus: boolean("bonded_status").default(false).notNull(),
    capacityUnits: text("capacity_units"),
  },
  (_table) => [
    check(
      "warehouse_offering_detail_capacity_ck",
      sql`capacity_units IS NULL OR char_length(capacity_units) <= 80`,
    ),
  ],
);

export const foreignExchangeOfferingDetail = pgTable(
  "foreign_exchange_offering_detail",
  {
    offeringId: text("offering_id")
      .primaryKey()
      .references(() => commerceServiceOffering.id, { onDelete: "cascade" }),
    currencyPairs: text("currency_pairs").array().notNull().default([]),
    settlementRails: text("settlement_rails").array().notNull().default([]),
    minimumNotionalInCents: integer("minimum_notional_in_cents"),
    maximumNotionalInCents: integer("maximum_notional_in_cents"),
    notionalCurrency: text("notional_currency").default("USD").notNull(),
  },
  (_table) => [
    check("foreign_exchange_offering_detail_currency_ck", sql`notional_currency ~ '^[A-Z]{3}$'`),
    check(
      "foreign_exchange_offering_detail_notional_ck",
      sql`(minimum_notional_in_cents IS NULL AND maximum_notional_in_cents IS NULL)
          OR (minimum_notional_in_cents IS NOT NULL AND maximum_notional_in_cents IS NOT NULL
              AND minimum_notional_in_cents >= 0
              AND maximum_notional_in_cents >= minimum_notional_in_cents)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Phase 3 RFQ / quote / order / thread tables
// ---------------------------------------------------------------------------

export const commerceRfq = pgTable(
  "commerce_rfq",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    buyerOrganizationId: text("buyer_organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    createdByMemberId: text("created_by_member_id")
      .notNull()
      .references(() => commerceOrganizationMember.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    description: text("description"),
    state: commerceRfqStateEnum("state").default("draft").notNull(),
    visibility: commerceRfqVisibilityEnum("visibility").default("invited_only").notNull(),
    responseDeadlineAt: timestamp("response_deadline_at"),
    desiredDeliveryStartsAt: timestamp("desired_delivery_starts_at"),
    desiredDeliveryEndsAt: timestamp("desired_delivery_ends_at"),
    destinationAddressId: text("destination_address_id").references(
      () => commerceOrganizationAddress.id,
      { onDelete: "restrict" },
    ),
    destinationCountryCode: text("destination_country_code"),
    destinationLocality: text("destination_locality"),
    settlementCurrency: text("settlement_currency").default("USD").notNull(),
    openedAt: timestamp("opened_at"),
    closedAt: timestamp("closed_at"),
    awardedAt: timestamp("awarded_at"),
    expiredAt: timestamp("expired_at"),
    cancelledAt: timestamp("cancelled_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("commerce_rfq_buyer_state_idx").on(table.buyerOrganizationId, table.state, table.id),
    index("commerce_rfq_deadline_idx").on(table.responseDeadlineAt, table.state),
    check("commerce_rfq_title_ck", sql`char_length(title) BETWEEN 1 AND 200`),
    check(
      "commerce_rfq_description_ck",
      sql`description IS NULL OR char_length(description) <= 10000`,
    ),
    check("commerce_rfq_currency_ck", sql`settlement_currency ~ '^[A-Z]{3}$'`),
    check(
      "commerce_rfq_destination_country_ck",
      sql`destination_country_code IS NULL OR destination_country_code ~ '^[A-Z]{2}$'`,
    ),
    check(
      "commerce_rfq_delivery_window_ck",
      sql`(desired_delivery_starts_at IS NULL AND desired_delivery_ends_at IS NULL)
          OR (desired_delivery_starts_at IS NOT NULL AND desired_delivery_ends_at IS NOT NULL
              AND desired_delivery_ends_at >= desired_delivery_starts_at)`,
    ),
    check(
      "commerce_rfq_state_timestamps_ck",
      sql`(state = 'draft' AND opened_at IS NULL AND closed_at IS NULL AND awarded_at IS NULL
              AND expired_at IS NULL AND cancelled_at IS NULL)
          OR (state = 'open' AND opened_at IS NOT NULL AND closed_at IS NULL AND awarded_at IS NULL
              AND expired_at IS NULL AND cancelled_at IS NULL)
          OR (state = 'closed' AND opened_at IS NOT NULL AND closed_at IS NOT NULL
              AND awarded_at IS NULL AND expired_at IS NULL AND cancelled_at IS NULL)
          OR (state = 'awarded' AND opened_at IS NOT NULL AND awarded_at IS NOT NULL
              AND expired_at IS NULL AND cancelled_at IS NULL)
          OR (state = 'expired' AND opened_at IS NOT NULL AND expired_at IS NOT NULL
              AND cancelled_at IS NULL)
          OR (state = 'cancelled' AND cancelled_at IS NOT NULL)`,
    ),
  ],
);

export const commerceRfqProductLine = pgTable(
  "commerce_rfq_product_line",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    rfqId: text("rfq_id")
      .notNull()
      .references(() => commerceRfq.id, { onDelete: "cascade" }),
    productId: text("product_id").references(() => product.id, { onDelete: "restrict" }),
    categoryId: text("category_id").references(() => commerceCategory.id, { onDelete: "restrict" }),
    requestedTitle: text("requested_title").notNull(),
    requestedSpecificationSnapshot: text("requested_specification_snapshot").notNull(),
    quantity: integer("quantity").notNull(),
    unitLabel: text("unit_label").notNull(),
    siblingOrder: integer("sibling_order").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("commerce_rfq_product_line_rfq_idx").on(table.rfqId, table.siblingOrder),
    uniqueIndex("commerce_rfq_product_line_order_uidx").on(table.rfqId, table.siblingOrder),
    check(
      "commerce_rfq_product_line_title_ck",
      sql`char_length(requested_title) BETWEEN 1 AND 200`,
    ),
    check(
      "commerce_rfq_product_line_spec_ck",
      sql`char_length(requested_specification_snapshot) BETWEEN 1 AND 10000`,
    ),
    check("commerce_rfq_product_line_quantity_ck", sql`quantity > 0`),
    check("commerce_rfq_product_line_unit_ck", sql`char_length(unit_label) BETWEEN 1 AND 40`),
    check("commerce_rfq_product_line_order_ck", sql`sibling_order >= 0`),
  ],
);

export const commerceRfqServiceLine = pgTable(
  "commerce_rfq_service_line",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    rfqId: text("rfq_id")
      .notNull()
      .references(() => commerceRfq.id, { onDelete: "cascade" }),
    providerKind: commerceProviderKindSlugEnum("provider_kind").notNull(),
    serviceOfferingId: text("service_offering_id").references(() => commerceServiceOffering.id, {
      onDelete: "restrict",
    }),
    linkedProductLineId: text("linked_product_line_id").references(
      () => commerceRfqProductLine.id,
      {
        onDelete: "set null",
      },
    ),
    requirementSummary: text("requirement_summary").notNull(),
    siblingOrder: integer("sibling_order").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("commerce_rfq_service_line_rfq_idx").on(table.rfqId, table.siblingOrder),
    index("commerce_rfq_service_line_kind_idx").on(table.providerKind, table.rfqId),
    uniqueIndex("commerce_rfq_service_line_order_uidx").on(table.rfqId, table.siblingOrder),
    check(
      "commerce_rfq_service_line_summary_ck",
      sql`char_length(requirement_summary) BETWEEN 1 AND 4000`,
    ),
    check("commerce_rfq_service_line_order_ck", sql`sibling_order >= 0`),
  ],
);

/** Typed RFQ requirement extension — freight / logistics. */
export const freightRfqRequirementDetail = pgTable("freight_rfq_requirement_detail", {
  serviceLineId: text("service_line_id")
    .primaryKey()
    .references(() => commerceRfqServiceLine.id, { onDelete: "cascade" }),
  transportModes: freightTransportModeEnum("transport_modes").array().notNull().default([]),
  originCountryCode: text("origin_country_code"),
  destinationCountryCode: text("destination_country_code"),
  requiresConsolidation: boolean("requires_consolidation").default(false).notNull(),
  requiresHazardousGoodsSupport: boolean("requires_hazardous_goods_support")
    .default(false)
    .notNull(),
  cargoDescription: text("cargo_description"),
});

export const customsBrokerageRfqRequirementDetail = pgTable(
  "customs_brokerage_rfq_requirement_detail",
  {
    serviceLineId: text("service_line_id")
      .primaryKey()
      .references(() => commerceRfqServiceLine.id, { onDelete: "cascade" }),
    jurisdictions: text("jurisdictions").array().notNull().default([]),
    importRequired: boolean("import_required").default(true).notNull(),
    exportRequired: boolean("export_required").default(false).notNull(),
    commoditySummary: text("commodity_summary"),
  },
);

export const insuranceRfqRequirementDetail = pgTable("insurance_rfq_requirement_detail", {
  serviceLineId: text("service_line_id")
    .primaryKey()
    .references(() => commerceRfqServiceLine.id, { onDelete: "cascade" }),
  cargoCoverageClasses: text("cargo_coverage_classes").array().notNull().default([]),
  coverageLimitInCents: integer("coverage_limit_in_cents"),
  currency: text("currency").default("USD").notNull(),
});

export const inspectionRfqRequirementDetail = pgTable("inspection_rfq_requirement_detail", {
  serviceLineId: text("service_line_id")
    .primaryKey()
    .references(() => commerceRfqServiceLine.id, { onDelete: "cascade" }),
  preProduction: boolean("pre_production").default(false).notNull(),
  duringProduction: boolean("during_production").default(false).notNull(),
  preShipment: boolean("pre_shipment").default(false).notNull(),
  loadingSupervision: boolean("loading_supervision").default(false).notNull(),
});

export const testingCertificationRfqRequirementDetail = pgTable(
  "testing_certification_rfq_requirement_detail",
  {
    serviceLineId: text("service_line_id")
      .primaryKey()
      .references(() => commerceRfqServiceLine.id, { onDelete: "cascade" }),
    standards: text("standards").array().notNull().default([]),
    laboratoryLocationPreference: text("laboratory_location_preference"),
  },
);

export const marketingRfqRequirementDetail = pgTable("marketing_rfq_requirement_detail", {
  serviceLineId: text("service_line_id")
    .primaryKey()
    .references(() => commerceRfqServiceLine.id, { onDelete: "cascade" }),
  channels: text("channels").array().notNull().default([]),
  targetRegions: text("target_regions").array().notNull().default([]),
  languageCapabilities: text("language_capabilities").array().notNull().default([]),
});

export const warehouseRfqRequirementDetail = pgTable("warehouse_rfq_requirement_detail", {
  serviceLineId: text("service_line_id")
    .primaryKey()
    .references(() => commerceRfqServiceLine.id, { onDelete: "cascade" }),
  storageTypes: text("storage_types").array().notNull().default([]),
  temperatureControlled: boolean("temperature_controlled").default(false).notNull(),
  bondedStatusRequired: boolean("bonded_status_required").default(false).notNull(),
  capacityUnits: text("capacity_units"),
});

export const foreignExchangeRfqRequirementDetail = pgTable(
  "foreign_exchange_rfq_requirement_detail",
  {
    serviceLineId: text("service_line_id")
      .primaryKey()
      .references(() => commerceRfqServiceLine.id, { onDelete: "cascade" }),
    currencyPairs: text("currency_pairs").array().notNull().default([]),
    settlementRails: text("settlement_rails").array().notNull().default([]),
    notionalAmountInCents: integer("notional_amount_in_cents"),
    notionalCurrency: text("notional_currency").default("USD").notNull(),
  },
);

export const commerceRfqInvitation = pgTable(
  "commerce_rfq_invitation",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    rfqId: text("rfq_id")
      .notNull()
      .references(() => commerceRfq.id, { onDelete: "cascade" }),
    providerOrganizationId: text("provider_organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    state: commerceRfqInvitationStateEnum("state").default("pending").notNull(),
    invitedByMemberId: text("invited_by_member_id")
      .notNull()
      .references(() => commerceOrganizationMember.id, { onDelete: "restrict" }),
    sentAt: timestamp("sent_at"),
    readAt: timestamp("read_at"),
    respondedAt: timestamp("responded_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("commerce_rfq_invitation_rfq_provider_uidx").on(
      table.rfqId,
      table.providerOrganizationId,
    ),
    index("commerce_rfq_invitation_provider_idx").on(
      table.providerOrganizationId,
      table.state,
      table.id,
    ),
  ],
);

export const commerceRfqDocument = pgTable(
  "commerce_rfq_document",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    rfqId: text("rfq_id")
      .notNull()
      .references(() => commerceRfq.id, { onDelete: "cascade" }),
    encryptedDocumentId: text("encrypted_document_id")
      .notNull()
      .references(() => commerceEncryptedDocument.id, { onDelete: "restrict" }),
    attachedByMemberId: text("attached_by_member_id")
      .notNull()
      .references(() => commerceOrganizationMember.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("commerce_rfq_document_uidx").on(table.rfqId, table.encryptedDocumentId),
    index("commerce_rfq_document_rfq_idx").on(table.rfqId),
  ],
);

export const commerceQuote = pgTable(
  "commerce_quote",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    rfqId: text("rfq_id")
      .notNull()
      .references(() => commerceRfq.id, { onDelete: "restrict" }),
    providerOrganizationId: text("provider_organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    createdByMemberId: text("created_by_member_id")
      .notNull()
      .references(() => commerceOrganizationMember.id, { onDelete: "restrict" }),
    status: commerceQuoteStatusEnum("status").default("draft").notNull(),
    latestRevisionNumber: integer("latest_revision_number").default(0).notNull(),
    acceptedRevisionNumber: integer("accepted_revision_number"),
    submittedAt: timestamp("submitted_at"),
    acceptedAt: timestamp("accepted_at"),
    declinedAt: timestamp("declined_at"),
    withdrawnAt: timestamp("withdrawn_at"),
    expiredAt: timestamp("expired_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("commerce_quote_rfq_provider_uidx").on(table.rfqId, table.providerOrganizationId),
    uniqueIndex("commerce_quote_accepted_revision_uidx")
      .on(table.id, table.acceptedRevisionNumber)
      .where(sql`status = 'accepted' AND accepted_revision_number IS NOT NULL`),
    index("commerce_quote_provider_status_idx").on(
      table.providerOrganizationId,
      table.status,
      table.id,
    ),
    index("commerce_quote_rfq_status_idx").on(table.rfqId, table.status, table.id),
    check("commerce_quote_revision_ck", sql`latest_revision_number >= 0`),
    check(
      "commerce_quote_accepted_revision_ck",
      sql`(status <> 'accepted' AND accepted_revision_number IS NULL AND accepted_at IS NULL)
          OR (status = 'accepted' AND accepted_revision_number IS NOT NULL
              AND accepted_revision_number > 0 AND accepted_at IS NOT NULL)`,
    ),
  ],
);

export const commerceQuoteRevision = pgTable(
  "commerce_quote_revision",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    quoteId: text("quote_id")
      .notNull()
      .references(() => commerceQuote.id, { onDelete: "cascade" }),
    revisionNumber: integer("revision_number").notNull(),
    currency: text("currency").notNull(),
    validityDeadlineAt: timestamp("validity_deadline_at").notNull(),
    subtotalInCents: bigint("subtotal_in_cents", { mode: "number" }).notNull(),
    taxInCents: bigint("tax_in_cents", { mode: "number" }).default(0).notNull(),
    serviceFeeInCents: bigint("service_fee_in_cents", { mode: "number" }).default(0).notNull(),
    shippingInCents: bigint("shipping_in_cents", { mode: "number" }).default(0).notNull(),
    discountInCents: bigint("discount_in_cents", { mode: "number" }).default(0).notNull(),
    totalInCents: bigint("total_in_cents", { mode: "number" }).notNull(),
    paymentTerms: text("payment_terms"),
    incoterm: text("incoterm"),
    notes: text("notes"),
    createdByMemberId: text("created_by_member_id")
      .notNull()
      .references(() => commerceOrganizationMember.id, { onDelete: "restrict" }),
    submittedAt: timestamp("submitted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("commerce_quote_revision_number_uidx").on(table.quoteId, table.revisionNumber),
    index("commerce_quote_revision_validity_idx").on(table.validityDeadlineAt, table.submittedAt),
    check("commerce_quote_revision_number_ck", sql`revision_number > 0`),
    check("commerce_quote_revision_currency_ck", sql`currency ~ '^[A-Z]{3}$'`),
    check(
      "commerce_quote_revision_money_ck",
      sql`subtotal_in_cents >= 0 AND tax_in_cents >= 0 AND service_fee_in_cents >= 0
          AND shipping_in_cents >= 0 AND discount_in_cents >= 0 AND total_in_cents >= 0
          AND total_in_cents = (subtotal_in_cents + tax_in_cents + service_fee_in_cents
              + shipping_in_cents - discount_in_cents)`,
    ),
    check(
      "commerce_quote_revision_text_ck",
      sql`(payment_terms IS NULL OR char_length(payment_terms) <= 2000)
          AND (incoterm IS NULL OR char_length(incoterm) BETWEEN 1 AND 20)
          AND (notes IS NULL OR char_length(notes) <= 10000)`,
    ),
  ],
);

export const commerceQuoteProductLine = pgTable(
  "commerce_quote_product_line",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    revisionId: text("revision_id")
      .notNull()
      .references(() => commerceQuoteRevision.id, { onDelete: "cascade" }),
    rfqProductLineId: text("rfq_product_line_id")
      .notNull()
      .references(() => commerceRfqProductLine.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    unitPriceInCents: bigint("unit_price_in_cents", { mode: "number" }).notNull(),
    lineTotalInCents: bigint("line_total_in_cents", { mode: "number" }).notNull(),
    titleSnapshot: text("title_snapshot").notNull(),
    specificationSnapshot: text("specification_snapshot").notNull(),
    leadTimeDays: integer("lead_time_days"),
    exclusionsSnapshot: text("exclusions_snapshot"),
    siblingOrder: integer("sibling_order").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("commerce_quote_product_line_revision_idx").on(table.revisionId, table.siblingOrder),
    uniqueIndex("commerce_quote_product_line_rfq_uidx").on(
      table.revisionId,
      table.rfqProductLineId,
    ),
    check("commerce_quote_product_line_quantity_ck", sql`quantity > 0`),
    check(
      "commerce_quote_product_line_money_ck",
      sql`unit_price_in_cents >= 0 AND line_total_in_cents = (quantity::bigint * unit_price_in_cents)`,
    ),
    check(
      "commerce_quote_product_line_title_ck",
      sql`char_length(title_snapshot) BETWEEN 1 AND 200
          AND char_length(specification_snapshot) BETWEEN 1 AND 10000`,
    ),
  ],
);

export const commerceQuoteServiceLine = pgTable(
  "commerce_quote_service_line",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    revisionId: text("revision_id")
      .notNull()
      .references(() => commerceQuoteRevision.id, { onDelete: "cascade" }),
    rfqServiceLineId: text("rfq_service_line_id")
      .notNull()
      .references(() => commerceRfqServiceLine.id, { onDelete: "restrict" }),
    providerKind: commerceProviderKindSlugEnum("provider_kind").notNull(),
    feeInCents: bigint("fee_in_cents", { mode: "number" }).notNull(),
    titleSnapshot: text("title_snapshot").notNull(),
    scopeSnapshot: text("scope_snapshot").notNull(),
    leadTimeDays: integer("lead_time_days"),
    exclusionsSnapshot: text("exclusions_snapshot"),
    deliverableSnapshot: text("deliverable_snapshot"),
    siblingOrder: integer("sibling_order").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("commerce_quote_service_line_revision_idx").on(table.revisionId, table.siblingOrder),
    uniqueIndex("commerce_quote_service_line_rfq_uidx").on(
      table.revisionId,
      table.rfqServiceLineId,
    ),
    check("commerce_quote_service_line_fee_ck", sql`fee_in_cents >= 0`),
    check(
      "commerce_quote_service_line_text_ck",
      sql`char_length(title_snapshot) BETWEEN 1 AND 200
          AND char_length(scope_snapshot) BETWEEN 1 AND 10000`,
    ),
  ],
);

export const commerceQuoteServiceDeliverablePlan = pgTable(
  "commerce_quote_service_deliverable_plan",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    quoteServiceLineId: text("quote_service_line_id")
      .notNull()
      .references(() => commerceQuoteServiceLine.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    title: text("title").notNull(),
    isRequired: boolean("is_required").default(true).notNull(),
    dueAt: timestamp("due_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("commerce_quote_service_deliverable_plan_sequence_uidx").on(
      table.quoteServiceLineId,
      table.sequence,
    ),
    check("commerce_quote_service_deliverable_plan_sequence_ck", sql`sequence >= 0`),
    check(
      "commerce_quote_service_deliverable_plan_title_ck",
      sql`char_length(title) BETWEEN 1 AND 200`,
    ),
  ],
);

export const freightQuoteServiceDetail = pgTable("freight_quote_service_detail", {
  quoteServiceLineId: text("quote_service_line_id")
    .primaryKey()
    .references(() => commerceQuoteServiceLine.id, { onDelete: "cascade" }),
  transportModes: freightTransportModeEnum("transport_modes").array().notNull().default([]),
  originCountryCode: text("origin_country_code"),
  destinationCountryCode: text("destination_country_code"),
  estimatedTransitDays: integer("estimated_transit_days"),
});

export const customsBrokerageQuoteServiceDetail = pgTable(
  "customs_brokerage_quote_service_detail",
  {
    quoteServiceLineId: text("quote_service_line_id")
      .primaryKey()
      .references(() => commerceQuoteServiceLine.id, { onDelete: "cascade" }),
    jurisdictions: text("jurisdictions").array().notNull().default([]),
    filingSummary: text("filing_summary"),
  },
);

export const insuranceQuoteServiceDetail = pgTable(
  "insurance_quote_service_detail",
  {
    quoteServiceLineId: text("quote_service_line_id")
      .primaryKey()
      .references(() => commerceQuoteServiceLine.id, { onDelete: "cascade" }),
    coverageClasses: text("coverage_classes").array().notNull().default([]),
    coverageLimitInCents: integer("coverage_limit_in_cents"),
    currency: text("currency"),
  },
  (_table) => [
    check(
      "insurance_quote_service_detail_amount_currency_pair_ck",
      sql`(coverage_limit_in_cents IS NULL) = (currency IS NULL)`,
    ),
    check(
      "insurance_quote_service_detail_currency_ck",
      sql`currency IS NULL OR currency ~ '^[A-Z]{3}$'`,
    ),
  ],
);

export const inspectionQuoteServiceDetail = pgTable("inspection_quote_service_detail", {
  quoteServiceLineId: text("quote_service_line_id")
    .primaryKey()
    .references(() => commerceQuoteServiceLine.id, { onDelete: "cascade" }),
  includedStages: text("included_stages").array().notNull().default([]),
});

export const testingCertificationQuoteServiceDetail = pgTable(
  "testing_certification_quote_service_detail",
  {
    quoteServiceLineId: text("quote_service_line_id")
      .primaryKey()
      .references(() => commerceQuoteServiceLine.id, { onDelete: "cascade" }),
    standards: text("standards").array().notNull().default([]),
    laboratoryLocation: text("laboratory_location"),
  },
);

export const marketingQuoteServiceDetail = pgTable("marketing_quote_service_detail", {
  quoteServiceLineId: text("quote_service_line_id")
    .primaryKey()
    .references(() => commerceQuoteServiceLine.id, { onDelete: "cascade" }),
  channels: text("channels").array().notNull().default([]),
  deliverablesSummary: text("deliverables_summary"),
});

export const warehouseQuoteServiceDetail = pgTable("warehouse_quote_service_detail", {
  quoteServiceLineId: text("quote_service_line_id")
    .primaryKey()
    .references(() => commerceQuoteServiceLine.id, { onDelete: "cascade" }),
  storageTypes: text("storage_types").array().notNull().default([]),
  capacityUnits: text("capacity_units"),
  temperatureControlled: boolean("temperature_controlled").default(false).notNull(),
});

export const foreignExchangeQuoteServiceDetail = pgTable(
  "foreign_exchange_quote_service_detail",
  {
    quoteServiceLineId: text("quote_service_line_id")
      .primaryKey()
      .references(() => commerceQuoteServiceLine.id, { onDelete: "cascade" }),
    currencyPair: text("currency_pair").notNull(),
    /** Fixed-point integer; pair with `rateScale` (e.g. rate=123456, scale=6 → 0.123456). */
    rateFixedPoint: bigint("rate_fixed_point", { mode: "number" }).notNull(),
    rateScale: integer("rate_scale").notNull(),
    settlementRail: text("settlement_rail"),
    notionalAmountInCents: integer("notional_amount_in_cents"),
    notionalCurrency: text("notional_currency"),
  },
  (_table) => [
    check(
      "foreign_exchange_quote_service_detail_rate_ck",
      sql`rate_fixed_point > 0 AND rate_scale BETWEEN 0 AND 12`,
    ),
    check(
      "foreign_exchange_quote_service_detail_pair_ck",
      sql`char_length(currency_pair) BETWEEN 7 AND 7 AND currency_pair ~ '^[A-Z]{3}/[A-Z]{3}$'`,
    ),
    check(
      "foreign_exchange_quote_service_detail_currency_ck",
      sql`notional_currency IS NULL OR notional_currency ~ '^[A-Z]{3}$'`,
    ),
    check(
      "foreign_exchange_quote_service_detail_notional_currency_pair_ck",
      sql`(notional_amount_in_cents IS NULL) = (notional_currency IS NULL)`,
    ),
  ],
);

/**
 * Minimal Phase 3 order shell. Created only from accepted quotes in this phase;
 * cart/checkout-originated orders arrive in Phase 4.
 */
export const commerceOrder = pgTable(
  "commerce_order",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    buyerOrganizationId: text("buyer_organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    counterpartyOrganizationId: text("counterparty_organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    checkoutGroupId: text("checkout_group_id"),
    source: commerceOrderSourceEnum("source").notNull(),
    state: commerceOrderStateEnum("state").default("pending_payment").notNull(),
    acceptedQuoteId: text("accepted_quote_id").references(() => commerceQuote.id, {
      onDelete: "restrict",
    }),
    acceptedQuoteRevisionId: text("accepted_quote_revision_id").references(
      () => commerceQuoteRevision.id,
      { onDelete: "restrict" },
    ),
    currency: text("currency").notNull(),
    subtotalInCents: bigint("subtotal_in_cents", { mode: "number" }).notNull(),
    taxInCents: bigint("tax_in_cents", { mode: "number" }).default(0).notNull(),
    serviceFeeInCents: bigint("service_fee_in_cents", { mode: "number" }).default(0).notNull(),
    shippingInCents: bigint("shipping_in_cents", { mode: "number" }).default(0).notNull(),
    discountInCents: bigint("discount_in_cents", { mode: "number" }).default(0).notNull(),
    totalInCents: bigint("total_in_cents", { mode: "number" }).notNull(),
    paymentTermsSnapshot: text("payment_terms_snapshot"),
    incotermSnapshot: text("incoterm_snapshot"),
    buyerLegalNameSnapshot: text("buyer_legal_name_snapshot").notNull(),
    counterpartyLegalNameSnapshot: text("counterparty_legal_name_snapshot").notNull(),
    /**
     * REDACTED BY DESIGN: country, region, locality, postal code. Street lines,
     * recipient name and phone are encrypted on the address row and deliberately do
     * not appear here — see `deliveryAddressId` below for how a seller reaches them.
     */
    buyerAddressSnapshot: text("buyer_address_snapshot"),
    counterpartyAddressSnapshot: text("counterparty_address_snapshot"),
    /**
     * A15. The durable pointer to the encrypted address row, so an authorized seller
     * can decrypt what the snapshot omits (§14's decision).
     *
     * It lives on the order rather than being walked to through the checkout group's
     * prepare, because the decrypt route authorizes against the ORDER — and because a
     * quote-originated order has no prepare at all, which is why this is nullable.
     */
    deliveryAddressId: text("delivery_address_id").references(
      () => commerceOrganizationAddress.id,
      { onDelete: "restrict" },
    ),
    /**
     * A13. WHAT THE BUYER WAS TOLD, fixed at the moment the order was created and never
     * recomputed. The latest promise across this order's product lines, which is the
     * baseline `onTimeShipmentRate` measures the delivered shipment event against.
     *
     * DERIVED AT CONFIRM, NEVER SELLER-TYPED LATER. A seller entering a target date when
     * it creates the shipment would be setting the bar after it already knew the outcome,
     * and the metric would grade itself. Direct-checkout orders compute it from
     * `commerce_checkout_prepare_product_line.leadTimeMaxDaysSnapshot`; quote-originated
     * orders from the `commerce_quote_product_line.leadTimeDays` that already existed.
     *
     * NULLABLE, and null means no seller on this order declared a lead time. Such an
     * order is absent from the on-time denominator rather than counted as met or missed.
     * Nothing backfills it: inventing a commitment for orders placed before this column
     * existed would fabricate the very measurement this fixes.
     */
    promisedDeliveryAt: timestamp("promised_delivery_at"),
    /**
     * THE VELOCITY CLOCK (Phase 13). The moment this order became a real commitment:
     * payment settled, or a quote acceptance created it already confirmed.
     *
     * `createdAt` could not serve. It is immutable and true, but it means `pending_payment`
     * — an order that may never be paid for. `updatedAt` could not either: any later write
     * moves it, so an order confirmed on the 2nd and cancelled on the 9th would count as
     * demand in the wrong week and then move again.
     *
     * NULL for every order predating Phase 13. Nothing backfills it — the only candidate
     * source was mutable `updatedAt`, and stamping it would fabricate a confirmation
     * instant and feed fiction to a fraud engine.
     */
    confirmedAt: timestamp("confirmed_at"),
    /**
     * Every line either fulfilled or cancelled. Distinct from
     * `commerceCompletion.completedAt`, which is per LINE and is the trust metrics' clock;
     * this is the order-level roll-up the refund and reorder denominators window on.
     */
    completedAt: timestamp("completed_at"),
    /** Set by `cancelOrder`. Until Phase 13 the only durable record that a cancellation
     * happened at a particular time was an audit row. */
    cancelledAt: timestamp("cancelled_at"),
    /**
     * Whether the buyer cleared the trusted-buyer bar AT CONFIRM (Phase 13).
     *
     * ON THE ORDER AND NOT IN A NIGHTLY SNAPSHOT, because qualification must be frozen as
     * of the moment it was assessed. Recomputed at read time, a buyer registering a tax
     * identifier today would retroactively qualify every order it ever placed — turning a
     * fraud filter into a one-click amplifier for the party it constrains.
     */
    buyerQualificationState: commerceBuyerQualificationStateEnum("buyer_qualification_state")
      .default("unevaluated")
      .notNull(),
    /** Which clauses answered. An array because the bar is one age test AND one of three
     * credentials, so a single column would force a precedence that does not exist. */
    buyerQualificationReasons: commerceBuyerQualificationReasonEnum("buyer_qualification_reasons")
      .array()
      .default([])
      .notNull(),
    /**
     * HOW THIS ORDER SETTLES (Phase 14). Fixed at confirm, under the same row lock that
     * makes every other commercial fact on this row immutable.
     *
     * Defaults to `internal_custody` because that is what every pre-Phase-14 row
     * actually did. Nothing backfills it to something truer: those orders really did
     * post `buyer_clearing → order_held`, and relabelling them would make the journal
     * disagree with the rail it claims to have run on.
     *
     * Which agreement bound an `external_escrow` order is reachable through
     * `commerce_settlement_agreement.consumedByOrderId`, which is uniquely indexed —
     * a column here as well would be a second, divergible answer to one question.
     */
    settlementRail: commerceSettlementRailEnum("settlement_rail")
      .default("internal_custody")
      .notNull(),
    createdByMemberId: text("created_by_member_id")
      .notNull()
      .references(() => commerceOrganizationMember.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    /**
     * Phase 13. Both pre-existing indexes lead with an organization id, so a
     * platform-wide "confirmed orders in the last 30 days" — the category floor, run once
     * per category per hour — had no usable index at all.
     */
    index("commerce_order_state_created_idx").on(table.state, table.createdAt, table.id),
    index("commerce_order_confirmed_at_idx")
      .on(table.confirmedAt, table.counterpartyOrganizationId)
      .where(sql`confirmed_at IS NOT NULL`),
    index("commerce_order_qualified_velocity_idx")
      .on(table.buyerQualificationState, table.confirmedAt, table.counterpartyOrganizationId)
      .where(sql`confirmed_at IS NOT NULL AND buyer_qualification_state = 'qualified'`),
    /**
     * The on-time metric's driving index: a counterparty's orders that carry a promise.
     * Partial, because most historical rows never will.
     */
    index("commerce_order_promised_delivery_idx")
      .on(table.counterpartyOrganizationId, table.promisedDeliveryAt)
      .where(sql`promised_delivery_at IS NOT NULL`),
    uniqueIndex("commerce_order_accepted_quote_uidx")
      .on(table.acceptedQuoteId)
      .where(sql`accepted_quote_id IS NOT NULL`),
    uniqueIndex("commerce_order_accepted_revision_uidx")
      .on(table.acceptedQuoteRevisionId)
      .where(sql`accepted_quote_revision_id IS NOT NULL`),
    index("commerce_order_buyer_idx").on(table.buyerOrganizationId, table.state, table.id),
    index("commerce_order_counterparty_idx").on(
      table.counterpartyOrganizationId,
      table.state,
      table.id,
    ),
    index("commerce_order_checkout_group_idx").on(table.checkoutGroupId, table.id),
    index("commerce_order_delivery_address_idx")
      .on(table.deliveryAddressId)
      .where(sql`delivery_address_id IS NOT NULL`),
    check("commerce_order_currency_ck", sql`currency ~ '^[A-Z]{3}$'`),
    check(
      "commerce_order_money_ck",
      sql`subtotal_in_cents >= 0 AND tax_in_cents >= 0 AND service_fee_in_cents >= 0
          AND shipping_in_cents >= 0 AND discount_in_cents >= 0 AND total_in_cents >= 0
          AND total_in_cents = (subtotal_in_cents + tax_in_cents + service_fee_in_cents
              + shipping_in_cents - discount_in_cents)`,
    ),
    check(
      "commerce_order_quote_source_ck",
      sql`(source = 'accepted_quote' AND accepted_quote_id IS NOT NULL
              AND accepted_quote_revision_id IS NOT NULL AND checkout_group_id IS NULL)
          OR (source = 'direct_checkout' AND accepted_quote_id IS NULL
              AND accepted_quote_revision_id IS NULL AND checkout_group_id IS NOT NULL)`,
    ),
    /**
     * ORDERING ONLY, deliberately. `state = 'cancelled' => cancelled_at IS NOT NULL` is
     * false for every row that predates Phase 13, so it could not be added without either
     * a fabricated backfill or a NOT VALID constraint nobody would ever validate. This one
     * is true of every row that has ever existed.
     */
    check(
      "commerce_order_lifecycle_order_ck",
      sql`(completed_at IS NULL OR confirmed_at IS NULL OR completed_at >= confirmed_at)
          AND (cancelled_at IS NULL OR confirmed_at IS NULL OR cancelled_at >= confirmed_at)`,
    ),
    check(
      "commerce_order_terminal_exclusive_ck",
      sql`completed_at IS NULL OR cancelled_at IS NULL`,
    ),
    /**
     * A verdict without a reason is unreviewable, and an `unevaluated` row must not carry
     * one — otherwise a historical order would look assessed and found wanting.
     */
    check(
      "commerce_order_qualification_reasons_ck",
      sql`(buyer_qualification_state = 'unevaluated' AND cardinality(buyer_qualification_reasons) = 0)
          OR (buyer_qualification_state <> 'unevaluated' AND cardinality(buyer_qualification_reasons) > 0)`,
    ),
  ],
);

export const commerceOrderProductLine = pgTable(
  "commerce_order_product_line",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    orderId: text("order_id")
      .notNull()
      .references(() => commerceOrder.id, { onDelete: "cascade" }),
    productId: text("product_id").references(() => product.id, { onDelete: "restrict" }),
    /**
     * A1. The variant this line was bought from, `restrict` so it survives as long as
     * the order does.
     */
    variantId: text("variant_id").references(() => commerceProductVariant.id, {
      onDelete: "restrict",
    }),
    /**
     * "Sea blue" is a commercial fact, so it is snapshotted like every other one
     * (§2.2). Reading the live variant name here would let a seller rename what a
     * buyer already bought.
     */
    variantNameSnapshot: text("variant_name_snapshot"),
    titleSnapshot: text("title_snapshot").notNull(),
    specificationSnapshot: text("specification_snapshot").notNull(),
    /**
     * A17. "This was a sample" is a commercial fact about what was bought, the same
     * way the variant name is, and a `refundable` sample cannot mint a credit unless
     * the order line can say so.
     */
    isSample: boolean("is_sample").default(false).notNull(),
    quantityOrdered: integer("quantity_ordered").notNull(),
    quantityReserved: integer("quantity_reserved").default(0).notNull(),
    quantityFulfilled: integer("quantity_fulfilled").default(0).notNull(),
    quantityCancelled: integer("quantity_cancelled").default(0).notNull(),
    quantityRefunded: integer("quantity_refunded").default(0).notNull(),
    unitPriceInCents: bigint("unit_price_in_cents", { mode: "number" }).notNull(),
    lineTotalInCents: bigint("line_total_in_cents", { mode: "number" }).notNull(),
    /**
     * A13. This line's own promise — an immutable commercial snapshot like every other
     * column here. `commerce_order.promisedDeliveryAt` is the latest of these.
     *
     * Per line and not only per order because one order can span lead times, and a
     * partially-shipped order needs to know which line was late. The aggregate metric
     * reads the order; a future per-line view has the fact it needs without a migration.
     */
    promisedDeliveryAt: timestamp("promised_delivery_at"),
    /**
     * Phase 20, §19.4. Carried verbatim from
     * `commerce_checkout_prepare_product_line.leadTimeMinDaysSnapshot` at confirm.
     *
     * THE MAXIMUM IS DELIBERATELY NOT DUPLICATED HERE. It is already recoverable losslessly
     * from `promised_delivery_at` minus the order's `created_at` — `derivePromisedDeliveryAt`
     * added whole days to the insert instant — and that reconstruction works on every order
     * ever placed, whereas a new column would work on none of them. One derivation beats one
     * column plus one derivation.
     *
     * NULL on every order confirmed before this column existed, and on every quote-originated
     * order: `commerce_quote_product_line` carries a single lead-time figure, not a range.
     */
    leadTimeMinDaysSnapshot: integer("lead_time_min_days_snapshot"),
    siblingOrder: integer("sibling_order").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("commerce_order_product_line_order_idx").on(table.orderId, table.siblingOrder),
    // Phase 20. Bounded like the prepare line's, and NOT paired against a maximum here
    // because no maximum column exists on this table — see the column comment.
    check(
      "commerce_order_product_line_lead_time_ck",
      sql`lead_time_min_days_snapshot IS NULL
          OR (lead_time_min_days_snapshot >= 0 AND lead_time_min_days_snapshot <= 3650)`,
    ),
    check(
      "commerce_order_product_line_qty_ck",
      sql`quantity_ordered > 0
          AND quantity_reserved >= 0 AND quantity_fulfilled >= 0
          AND quantity_cancelled >= 0 AND quantity_refunded >= 0
          AND (quantity_fulfilled + quantity_cancelled) <= quantity_ordered`,
    ),
    check(
      "commerce_order_product_line_money_ck",
      sql`unit_price_in_cents >= 0
          AND line_total_in_cents = (quantity_ordered::bigint * unit_price_in_cents)`,
    ),
    // A variant id without its name snapshot would be an order that knows which row
    // it pointed at but not what the buyer was shown.
    check(
      "commerce_order_product_line_variant_ck",
      sql`(variant_id IS NULL AND variant_name_snapshot IS NULL)
          OR (variant_id IS NOT NULL AND variant_name_snapshot IS NOT NULL
              AND char_length(variant_name_snapshot) BETWEEN 1 AND 120)`,
    ),
  ],
);

export const commerceOrderServiceLine = pgTable(
  "commerce_order_service_line",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    orderId: text("order_id")
      .notNull()
      .references(() => commerceOrder.id, { onDelete: "cascade" }),
    providerKind: commerceProviderKindSlugEnum("provider_kind").notNull(),
    titleSnapshot: text("title_snapshot").notNull(),
    scopeSnapshot: text("scope_snapshot").notNull(),
    feeInCents: bigint("fee_in_cents", { mode: "number" }).notNull(),
    siblingOrder: integer("sibling_order").notNull(),
    /** Accepted quote service-line identity for typed execution snapshot handoff (Phase 6). */
    sourceQuoteServiceLineId: text("source_quote_service_line_id").references(
      () => commerceQuoteServiceLine.id,
      { onDelete: "restrict" },
    ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("commerce_order_service_line_order_idx").on(table.orderId, table.siblingOrder),
    check("commerce_order_service_line_fee_ck", sql`fee_in_cents >= 0`),
  ],
);

export const commerceThread = pgTable(
  "commerce_thread",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    resourceKind: commerceThreadResourceKindEnum("resource_kind").notNull(),
    resourceId: text("resource_id").notNull(),
    createdByOrganizationId: text("created_by_organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    createdByMemberId: text("created_by_member_id")
      .notNull()
      .references(() => commerceOrganizationMember.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("commerce_thread_resource_uidx").on(table.resourceKind, table.resourceId),
    index("commerce_thread_org_idx").on(table.createdByOrganizationId, table.id),
  ],
);

export const commerceThreadParticipant = pgTable(
  "commerce_thread_participant",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    threadId: text("thread_id")
      .notNull()
      .references(() => commerceThread.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    participantRole: commerceThreadParticipantRoleEnum("participant_role").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("commerce_thread_participant_uidx").on(table.threadId, table.organizationId),
    index("commerce_thread_participant_org_idx").on(table.organizationId, table.threadId),
  ],
);

export const commerceMessage = pgTable(
  "commerce_message",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    threadId: text("thread_id")
      .notNull()
      .references(() => commerceThread.id, { onDelete: "cascade" }),
    authorOrganizationId: text("author_organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    authorMemberId: text("author_member_id")
      .notNull()
      .references(() => commerceOrganizationMember.id, { onDelete: "restrict" }),
    bodyText: text("body_text").notNull(),
    /**
     * Phase 14. A settlement proposal must be legible in the conversation where it was
     * discussed, and encoding that in `bodyText` would make it unparseable by the client
     * and forgeable by any participant who can type.
     *
     * `authorMemberId` stays NOT NULL and honest: a settlement message is authored by the
     * member who proposed or accepted, not by "the system".
     */
    messageKind: commerceMessageKindEnum("message_kind").default("participant").notNull(),
    /** Set only on the settlement kinds; the agreement the message announces. */
    settlementAgreementId: text("settlement_agreement_id").references(
      (): AnyPgColumn => commerceSettlementAgreement.id,
      { onDelete: "cascade" },
    ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("commerce_message_thread_idx").on(table.threadId, table.createdAt, table.id),
    check("commerce_message_body_ck", sql`char_length(body_text) BETWEEN 1 AND 10000`),
    check(
      "commerce_message_settlement_ck",
      sql`(message_kind = 'participant') = (settlement_agreement_id IS NULL)`,
    ),
  ],
);

export const commerceMessageAttachment = pgTable(
  "commerce_message_attachment",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    messageId: text("message_id")
      .notNull()
      .references(() => commerceMessage.id, { onDelete: "cascade" }),
    encryptedDocumentId: text("encrypted_document_id")
      .notNull()
      .references(() => commerceEncryptedDocument.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("commerce_message_attachment_uidx").on(table.messageId, table.encryptedDocumentId),
    index("commerce_message_attachment_message_idx").on(table.messageId),
  ],
);

/**
 * One active cart per buyer organization (STORE_BACKEND_STRUCTURE.md §4.8 / Phase 4).
 * Cart lines store desired quantity only — totals are server-priced at prepare.
 */
export const commerceCart = pgTable(
  "commerce_cart",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    buyerOrganizationId: text("buyer_organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [uniqueIndex("commerce_cart_buyer_uidx").on(table.buyerOrganizationId)],
);

export const commerceCartProductLine = pgTable(
  "commerce_cart_product_line",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    cartId: text("cart_id")
      .notNull()
      .references(() => commerceCart.id, { onDelete: "cascade" }),
    productId: text("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "restrict" }),
    /**
     * A1. Required when the product has any active variant, forbidden when it has
     * none. That rule spans two tables, so it cannot be a CHECK — it is enforced in
     * `commerce-pricing.ts` under the same row locks that price the line, and again
     * by a trigger in migration 0054 so a direct write cannot bypass it.
     */
    variantId: text("variant_id").references(() => commerceProductVariant.id, {
      onDelete: "restrict",
    }),
    quantity: integer("quantity").notNull(),
    /**
     * A17. A sample line prices from `product.samplePriceInCents` and bypasses the tier
     * ladder and the minimum order quantity. It is a SEPARATE line from a bulk line of
     * the same product — buying a sample and then a bulk quantity is the whole pattern
     * samples exist for — which is why migration 0061 carries this column into the
     * uniqueness index.
     */
    isSample: boolean("is_sample").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    // The (cartId, productId) uniqueness becomes (cartId, productId, variant) in
    // migration 0054 as an expression index over coalesce(variant_id, ''), because
    // Postgres UNIQUE permits many NULLs and drizzle-kit cannot emit an expression
    // index. Two colours of one product are two lines; the same colour twice is one.
    index("commerce_cart_product_line_cart_idx").on(table.cartId, table.productId),
    index("commerce_cart_product_line_variant_idx")
      .on(table.variantId)
      .where(sql`variant_id IS NOT NULL`),
    check("commerce_cart_product_line_qty_ck", sql`quantity > 0`),
  ],
);

/**
 * Persisted checkout preparation. Confirm creates the checkout group + orders;
 * prepare never creates orders (STORE_BACKEND_STRUCTURE.md §6.3).
 */
export const commerceCheckoutPrepare = pgTable(
  "commerce_checkout_prepare",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    cartId: text("cart_id")
      .notNull()
      .references(() => commerceCart.id, { onDelete: "restrict" }),
    buyerOrganizationId: text("buyer_organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    state: commerceCheckoutPrepareStateEnum("state").default("active").notNull(),
    deliveryAddressId: text("delivery_address_id").references(
      () => commerceOrganizationAddress.id,
      {
        onDelete: "restrict",
      },
    ),
    deliveryAddressSnapshot: text("delivery_address_snapshot"),
    expiresAt: timestamp("expires_at").notNull(),
    prepareIdempotencyKey: text("prepare_idempotency_key"),
    createdByMemberId: text("created_by_member_id")
      .notNull()
      .references(() => commerceOrganizationMember.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("commerce_checkout_prepare_idempotency_uidx")
      .on(table.buyerOrganizationId, table.prepareIdempotencyKey)
      .where(sql`prepare_idempotency_key IS NOT NULL`),
    index("commerce_checkout_prepare_state_expires_idx").on(table.state, table.expiresAt),
    index("commerce_checkout_prepare_cart_idx").on(table.cartId, table.state),
  ],
);

export const commerceCheckoutPrepareProductLine = pgTable(
  "commerce_checkout_prepare_product_line",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    prepareId: text("prepare_id")
      .notNull()
      .references(() => commerceCheckoutPrepare.id, { onDelete: "cascade" }),
    productId: text("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "restrict" }),
    /**
     * A1. The prepare row is the authoritative snapshot confirm builds orders from,
     * so the variant has to be recorded here rather than re-read from the cart —
     * re-deriving it at confirm time would be recomputing a commercial fact from
     * mutable data, which §0 forbids.
     */
    variantId: text("variant_id").references(() => commerceProductVariant.id, {
      onDelete: "restrict",
    }),
    variantNameSnapshot: text("variant_name_snapshot"),
    sellerOrganizationId: text("seller_organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    titleSnapshot: text("title_snapshot").notNull(),
    specificationSnapshot: text("specification_snapshot").notNull(),
    quantity: integer("quantity").notNull(),
    unitPriceInCents: bigint("unit_price_in_cents", { mode: "number" }).notNull(),
    lineTotalInCents: bigint("line_total_in_cents", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    isMadeToOrder: boolean("is_made_to_order").default(false).notNull(),
    /** A17. Snapshotted from the cart line so confirm can carry it to the order. */
    isSample: boolean("is_sample").default(false).notNull(),
    /**
     * A13. The seller's advertised maximum lead time AT THE MOMENT OF PREPARATION, which
     * is what `promised_delivery_at` on the order line is computed from at confirm.
     *
     * It rides the prepare row rather than being re-read at confirm because
     * `confirmCheckout` builds each order line VERBATIM from this table and never touches
     * the cart or the product again — the same constraint A18's customization selections
     * had to route around. Re-reading `product.leadTimeMaxDays` at confirm would derive a
     * commitment from listing data the buyer never saw, which is exactly what §0 forbids
     * for prices and forbids here for the same reason.
     *
     * NULLABLE, and null means "this seller declared no lead time", not "zero days". Such
     * a line produces no promise and is excluded from the on-time denominator entirely.
     */
    leadTimeMaxDaysSnapshot: integer("lead_time_max_days_snapshot"),
    /**
     * Phase 20, §19.4. The MINIMUM half of the same declaration, snapshotted for the same
     * reason and carried to the order line at confirm.
     *
     * §19.4's arrival window reports manufacturing as a RANGE, and until this column existed
     * only the maximum was recoverable — an order could say "ships within 25 days" but never
     * "in 15 to 25". Nothing backfills it: inventing a minimum for an order placed before
     * the column existed is exactly the fabrication `leadTimeMaxDaysSnapshot`'s own note
     * refuses, so a pre-Phase-20 order reports `daysMin: null` and says so on the wire.
     *
     * The two are independently nullable ON PURPOSE. A seller may declare a maximum and no
     * minimum; the CHECK below only refuses the incoherent pair, not the partial one.
     */
    leadTimeMinDaysSnapshot: integer("lead_time_min_days_snapshot"),
    siblingOrder: integer("sibling_order").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    // Uniqueness becomes (prepareId, productId, coalesce(variant_id, '')) in
    // migration 0055 — one prepare may carry two colours of the same product.
    index("commerce_checkout_prepare_product_line_variant_idx")
      .on(table.variantId)
      .where(sql`variant_id IS NOT NULL`),
    index("commerce_checkout_prepare_product_line_prepare_idx").on(
      table.prepareId,
      table.siblingOrder,
    ),
    check("commerce_checkout_prepare_product_line_qty_ck", sql`quantity > 0`),
    check(
      "commerce_checkout_prepare_product_line_lead_time_ck",
      sql`(lead_time_max_days_snapshot IS NULL
           OR (lead_time_max_days_snapshot >= 0 AND lead_time_max_days_snapshot <= 3650))
          AND (lead_time_min_days_snapshot IS NULL
               OR (lead_time_min_days_snapshot >= 0 AND lead_time_min_days_snapshot <= 3650))
          AND (lead_time_min_days_snapshot IS NULL
               OR lead_time_max_days_snapshot IS NULL
               OR lead_time_min_days_snapshot <= lead_time_max_days_snapshot)`,
    ),
    check(
      "commerce_checkout_prepare_product_line_money_ck",
      sql`unit_price_in_cents >= 0
          AND line_total_in_cents = (quantity::bigint * unit_price_in_cents)
          AND currency ~ '^[A-Z]{3}$'`,
    ),
    check(
      "commerce_checkout_prepare_product_line_variant_ck",
      sql`(variant_id IS NULL AND variant_name_snapshot IS NULL)
          OR (variant_id IS NOT NULL AND variant_name_snapshot IS NOT NULL
              AND char_length(variant_name_snapshot) BETWEEN 1 AND 120)`,
    ),
  ],
);

export const commerceCheckoutPrepareCurrencyTotal = pgTable(
  "commerce_checkout_prepare_currency_total",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    prepareId: text("prepare_id")
      .notNull()
      .references(() => commerceCheckoutPrepare.id, { onDelete: "cascade" }),
    currency: text("currency").notNull(),
    subtotalInCents: bigint("subtotal_in_cents", { mode: "number" }).notNull(),
    taxInCents: bigint("tax_in_cents", { mode: "number" }).default(0).notNull(),
    serviceFeeInCents: bigint("service_fee_in_cents", { mode: "number" }).default(0).notNull(),
    shippingInCents: bigint("shipping_in_cents", { mode: "number" }).default(0).notNull(),
    discountInCents: bigint("discount_in_cents", { mode: "number" }).default(0).notNull(),
    totalInCents: bigint("total_in_cents", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("commerce_checkout_prepare_currency_total_uidx").on(
      table.prepareId,
      table.currency,
    ),
    check("commerce_checkout_prepare_currency_ck", sql`currency ~ '^[A-Z]{3}$'`),
    check(
      "commerce_checkout_prepare_currency_money_ck",
      sql`subtotal_in_cents >= 0 AND tax_in_cents >= 0 AND service_fee_in_cents >= 0
          AND shipping_in_cents >= 0 AND discount_in_cents >= 0 AND total_in_cents >= 0
          AND total_in_cents = (subtotal_in_cents + tax_in_cents + service_fee_in_cents
              + shipping_in_cents - discount_in_cents)`,
    ),
  ],
);

export const commerceInventoryReservation = pgTable(
  "commerce_inventory_reservation",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    productId: text("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "restrict" }),
    /**
     * A1. Stock is held against the variant, not the listing: reserving ten "Sea
     * blue" must not consume "Signal red" stock.
     */
    variantId: text("variant_id").references(() => commerceProductVariant.id, {
      onDelete: "restrict",
    }),
    buyerOrganizationId: text("buyer_organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    cartId: text("cart_id").references(() => commerceCart.id, { onDelete: "restrict" }),
    checkoutPrepareId: text("checkout_prepare_id").references(() => commerceCheckoutPrepare.id, {
      onDelete: "restrict",
    }),
    orderId: text("order_id").references(() => commerceOrder.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    isMadeToOrder: boolean("is_made_to_order").default(false).notNull(),
    /**
     * A17. A sample line holds stock of its own, so the held-uniqueness index splits on
     * it too — otherwise a prepare carrying both a sample and a bulk line of one
     * product could only reserve for one of them.
     */
    isSample: boolean("is_sample").default(false).notNull(),
    state: commerceInventoryReservationStateEnum("state").default("held").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    consumedAt: timestamp("consumed_at"),
    releasedAt: timestamp("released_at"),
  },
  (table) => [
    // Migration 0054 replaces this with the variant-aware expression index
    // (checkout_prepare_id, product_id, coalesce(variant_id, '')), so one prepare can
    // hold two variants of the same product.
    index("commerce_inventory_reservation_product_state_idx").on(
      table.productId,
      table.state,
      table.expiresAt,
    ),
    index("commerce_inventory_reservation_variant_state_idx")
      .on(table.variantId, table.state, table.expiresAt)
      .where(sql`variant_id IS NOT NULL`),
    index("commerce_inventory_reservation_state_expires_idx").on(table.state, table.expiresAt),
    check(
      "commerce_inventory_reservation_qty_ck",
      sql`(is_made_to_order = true AND quantity = 0) OR (is_made_to_order = false AND quantity > 0)`,
    ),
    check(
      "commerce_inventory_reservation_owner_ck",
      sql`(
            (checkout_prepare_id IS NOT NULL AND cart_id IS NOT NULL AND order_id IS NULL)
         OR (order_id IS NOT NULL AND checkout_prepare_id IS NULL AND cart_id IS NULL)
          )`,
    ),
  ],
);

export const commerceCheckoutGroup = pgTable(
  "commerce_checkout_group",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    buyerOrganizationId: text("buyer_organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    checkoutPrepareId: text("checkout_prepare_id")
      .notNull()
      .references(() => commerceCheckoutPrepare.id, { onDelete: "restrict" }),
    state: commerceCheckoutGroupStateEnum("state").default("confirmed").notNull(),
    deliveryAddressSnapshot: text("delivery_address_snapshot"),
    confirmIdempotencyKey: text("confirm_idempotency_key"),
    createdByMemberId: text("created_by_member_id")
      .notNull()
      .references(() => commerceOrganizationMember.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("commerce_checkout_group_prepare_uidx").on(table.checkoutPrepareId),
    uniqueIndex("commerce_checkout_group_idempotency_uidx")
      .on(table.buyerOrganizationId, table.confirmIdempotencyKey)
      .where(sql`confirm_idempotency_key IS NOT NULL`),
    index("commerce_checkout_group_buyer_idx").on(table.buyerOrganizationId, table.id),
  ],
);

export const commerceCheckoutGroupCurrencyTotal = pgTable(
  "commerce_checkout_group_currency_total",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    checkoutGroupId: text("checkout_group_id")
      .notNull()
      .references(() => commerceCheckoutGroup.id, { onDelete: "cascade" }),
    currency: text("currency").notNull(),
    subtotalInCents: bigint("subtotal_in_cents", { mode: "number" }).notNull(),
    taxInCents: bigint("tax_in_cents", { mode: "number" }).default(0).notNull(),
    serviceFeeInCents: bigint("service_fee_in_cents", { mode: "number" }).default(0).notNull(),
    shippingInCents: bigint("shipping_in_cents", { mode: "number" }).default(0).notNull(),
    discountInCents: bigint("discount_in_cents", { mode: "number" }).default(0).notNull(),
    totalInCents: bigint("total_in_cents", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("commerce_checkout_group_currency_total_uidx").on(
      table.checkoutGroupId,
      table.currency,
    ),
    check("commerce_checkout_group_currency_ck", sql`currency ~ '^[A-Z]{3}$'`),
    check(
      "commerce_checkout_group_currency_money_ck",
      sql`subtotal_in_cents >= 0 AND tax_in_cents >= 0 AND service_fee_in_cents >= 0
          AND shipping_in_cents >= 0 AND discount_in_cents >= 0 AND total_in_cents >= 0
          AND total_in_cents = (subtotal_in_cents + tax_in_cents + service_fee_in_cents
              + shipping_in_cents - discount_in_cents)`,
    ),
  ],
);

export const commerceServiceEngagement = pgTable(
  "commerce_service_engagement",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    buyerOrganizationId: text("buyer_organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    providerOrganizationId: text("provider_organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    orderId: text("order_id")
      .notNull()
      .references(() => commerceOrder.id, { onDelete: "restrict" }),
    orderServiceLineId: text("order_service_line_id")
      .notNull()
      .references(() => commerceOrderServiceLine.id, { onDelete: "restrict" }),
    providerKind: commerceProviderKindSlugEnum("provider_kind").notNull(),
    state: commerceServiceEngagementStateEnum("state").default("awaiting_provider").notNull(),
    executionContractState: commerceExecutionContractStateEnum("execution_contract_state")
      .default("legacy_missing_snapshot")
      .notNull(),
    /**
     * Set when the typed snapshot becomes ready. Null for legacy engagements awaiting
     * `initialize`. Operator-initialized snapshots may omit quote source identity.
     */
    executionContractProvenance: commerceExecutionContractProvenanceEnum(
      "execution_contract_provenance",
    ),
    /**
     * True when a historical free-text deliverable obligation exists without structured
     * deliverable rows. Completion fails closed until `normalize_deliverables`.
     */
    requiresDeliverableNormalization: boolean("requires_deliverable_normalization")
      .default(false)
      .notNull(),
    version: integer("version").default(0).notNull(),
    titleSnapshot: text("title_snapshot").notNull(),
    scopeSnapshot: text("scope_snapshot").notNull(),
    scheduledAt: timestamp("scheduled_at"),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    cancelledAt: timestamp("cancelled_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("commerce_service_engagement_order_line_uidx").on(table.orderServiceLineId),
    check(
      "commerce_service_engagement_provenance_ck",
      sql`(execution_contract_state = 'legacy_missing_snapshot' AND execution_contract_provenance IS NULL)
          OR (execution_contract_state = 'ready' AND execution_contract_provenance IS NOT NULL)`,
    ),
    index("commerce_service_engagement_buyer_idx").on(
      table.buyerOrganizationId,
      table.state,
      table.id,
    ),
    index("commerce_service_engagement_provider_idx").on(
      table.providerOrganizationId,
      table.state,
      table.id,
    ),
    check("commerce_service_engagement_version_ck", sql`version >= 0`),
  ],
);

export const commerceShipment = pgTable(
  "commerce_shipment",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    orderId: text("order_id")
      .notNull()
      .references(() => commerceOrder.id, { onDelete: "restrict" }),
    state: commerceShipmentStateEnum("state").default("planned").notNull(),
    version: integer("version").default(0).notNull(),
    originCountryCode: text("origin_country_code"),
    originLocality: text("origin_locality"),
    destinationCountryCode: text("destination_country_code"),
    destinationLocality: text("destination_locality"),
    packageCount: integer("package_count").notNull(),
    totalWeightGrams: integer("total_weight_grams"),
    createdByMemberId: text("created_by_member_id")
      .notNull()
      .references(() => commerceOrganizationMember.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("commerce_shipment_order_idx").on(table.orderId, table.id),
    /**
     * A29. The logistics queue's keyset. Leads with `orderId` so the org-scoped join to
     * `commerce_order` can drive it, and carries the sort so a matched order's shipments
     * arrive already ordered.
     */
    index("commerce_shipment_order_created_idx").on(
      table.orderId,
      table.createdAt.desc(),
      table.id,
    ),
    check("commerce_shipment_package_ck", sql`package_count > 0`),
    check("commerce_shipment_weight_ck", sql`total_weight_grams IS NULL OR total_weight_grams > 0`),
    check("commerce_shipment_version_ck", sql`version >= 0`),
    check(
      "commerce_shipment_country_ck",
      sql`(origin_country_code IS NULL OR origin_country_code ~ '^[A-Z]{2}$')
          AND (destination_country_code IS NULL OR destination_country_code ~ '^[A-Z]{2}$')`,
    ),
  ],
);

export const commerceOrderServiceLink = pgTable(
  "commerce_order_service_link",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    engagementId: text("engagement_id")
      .notNull()
      .references(() => commerceServiceEngagement.id, { onDelete: "cascade" }),
    orderId: text("order_id")
      .notNull()
      .references(() => commerceOrder.id, { onDelete: "restrict" }),
    orderServiceLineId: text("order_service_line_id").references(
      () => commerceOrderServiceLine.id,
      {
        onDelete: "restrict",
      },
    ),
    orderProductLineId: text("order_product_line_id").references(
      () => commerceOrderProductLine.id,
      {
        onDelete: "restrict",
      },
    ),
    shipmentId: text("shipment_id").references(() => commerceShipment.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("commerce_order_service_link_engagement_idx").on(table.engagementId),
    index("commerce_order_service_link_order_idx").on(table.orderId),
    check(
      "commerce_order_service_link_target_ck",
      sql`order_service_line_id IS NOT NULL
          OR order_product_line_id IS NOT NULL
          OR shipment_id IS NOT NULL`,
    ),
  ],
);

export const commerceShipmentProductLine = pgTable(
  "commerce_shipment_product_line",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    shipmentId: text("shipment_id")
      .notNull()
      .references(() => commerceShipment.id, { onDelete: "cascade" }),
    orderProductLineId: text("order_product_line_id")
      .notNull()
      .references(() => commerceOrderProductLine.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("commerce_shipment_product_line_uidx").on(
      table.shipmentId,
      table.orderProductLineId,
    ),
    check("commerce_shipment_product_line_qty_ck", sql`quantity > 0`),
  ],
);

export const commerceShipmentEvent = pgTable(
  "commerce_shipment_event",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    shipmentId: text("shipment_id")
      .notNull()
      .references(() => commerceShipment.id, { onDelete: "cascade" }),
    eventKind: commerceShipmentEventKindEnum("event_kind").notNull(),
    occurredAt: timestamp("occurred_at").notNull(),
    description: text("description"),
    createdByMemberId: text("created_by_member_id")
      .notNull()
      .references(() => commerceOrganizationMember.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("commerce_shipment_event_shipment_idx").on(table.shipmentId, table.occurredAt, table.id),
    check(
      "commerce_shipment_event_description_ck",
      sql`description IS NULL OR char_length(description) BETWEEN 1 AND 2000`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Store Phase 6 — shipment legs, typed connector execution, deliverables.
// See docs/STORE_BACKEND_STRUCTURE.md §4.10, §6.4, §12 Phase 6.
// ---------------------------------------------------------------------------

export const commerceShipmentLeg = pgTable(
  "commerce_shipment_leg",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    shipmentId: text("shipment_id")
      .notNull()
      .references(() => commerceShipment.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    mode: commerceShipmentLegModeEnum("mode").notNull(),
    state: commerceShipmentLegStateEnum("state").default("planned").notNull(),
    version: integer("version").default(0).notNull(),
    originCountryCode: text("origin_country_code").notNull(),
    originLocality: text("origin_locality"),
    originLocationIdentifier: text("origin_location_identifier"),
    destinationCountryCode: text("destination_country_code").notNull(),
    destinationLocality: text("destination_locality"),
    destinationLocationIdentifier: text("destination_location_identifier"),
    logisticsEngagementId: text("logistics_engagement_id").references(
      () => commerceServiceEngagement.id,
      { onDelete: "restrict" },
    ),
    carrierReference: text("carrier_reference"),
    trackingReference: text("tracking_reference"),
    estimatedDepartureAt: timestamp("estimated_departure_at"),
    estimatedArrivalAt: timestamp("estimated_arrival_at"),
    actualDepartureAt: timestamp("actual_departure_at"),
    actualArrivalAt: timestamp("actual_arrival_at"),
    createdByMemberId: text("created_by_member_id")
      .notNull()
      .references(() => commerceOrganizationMember.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("commerce_shipment_leg_sequence_uidx").on(table.shipmentId, table.sequence),
    index("commerce_shipment_leg_shipment_idx").on(table.shipmentId, table.id),
    index("commerce_shipment_leg_engagement_idx").on(table.logisticsEngagementId),
    /**
     * A29. The queue's ETA-window `EXISTS` probes this per shipment. Partial, because a
     * leg with no ETA can never satisfy a window and has no business widening it.
     */
    index("commerce_shipment_leg_eta_idx")
      .on(table.shipmentId, table.estimatedArrivalAt)
      .where(sql`estimated_arrival_at IS NOT NULL`),
    check("commerce_shipment_leg_sequence_ck", sql`sequence >= 0`),
    check("commerce_shipment_leg_version_ck", sql`version >= 0`),
    check(
      "commerce_shipment_leg_country_ck",
      sql`origin_country_code ~ '^[A-Z]{2}$' AND destination_country_code ~ '^[A-Z]{2}$'`,
    ),
    check(
      "commerce_shipment_leg_location_ck",
      sql`(origin_location_identifier IS NULL OR char_length(origin_location_identifier) BETWEEN 1 AND 80)
          AND (destination_location_identifier IS NULL OR char_length(destination_location_identifier) BETWEEN 1 AND 80)
          AND (origin_locality IS NULL OR char_length(origin_locality) BETWEEN 1 AND 150)
          AND (destination_locality IS NULL OR char_length(destination_locality) BETWEEN 1 AND 150)
          AND (carrier_reference IS NULL OR char_length(carrier_reference) BETWEEN 1 AND 200)
          AND (tracking_reference IS NULL OR char_length(tracking_reference) BETWEEN 1 AND 200)`,
    ),
  ],
);

export const commerceShipmentLegEvent = pgTable(
  "commerce_shipment_leg_event",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    shipmentLegId: text("shipment_leg_id")
      .notNull()
      .references(() => commerceShipmentLeg.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    eventKind: commerceShipmentLegEventKindEnum("event_kind").notNull(),
    occurredAt: timestamp("occurred_at").notNull(),
    description: text("description"),
    carrierReference: text("carrier_reference"),
    trackingReference: text("tracking_reference"),
    locationIdentifier: text("location_identifier"),
    evidenceDocumentId: text("evidence_document_id").references(
      () => commerceEncryptedDocument.id,
      { onDelete: "restrict" },
    ),
    createdByMemberId: text("created_by_member_id")
      .notNull()
      .references(() => commerceOrganizationMember.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("commerce_shipment_leg_event_sequence_uidx").on(
      table.shipmentLegId,
      table.sequence,
    ),
    index("commerce_shipment_leg_event_leg_idx").on(
      table.shipmentLegId,
      table.occurredAt,
      table.id,
    ),
    check("commerce_shipment_leg_event_sequence_ck", sql`sequence >= 0`),
    check(
      "commerce_shipment_leg_event_text_ck",
      sql`(description IS NULL OR char_length(description) BETWEEN 1 AND 2000)
          AND (carrier_reference IS NULL OR char_length(carrier_reference) BETWEEN 1 AND 200)
          AND (tracking_reference IS NULL OR char_length(tracking_reference) BETWEEN 1 AND 200)
          AND (location_identifier IS NULL OR char_length(location_identifier) BETWEEN 1 AND 80)`,
    ),
  ],
);

export const commerceServiceEngagementEvent = pgTable(
  "commerce_service_engagement_event",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    engagementId: text("engagement_id")
      .notNull()
      .references(() => commerceServiceEngagement.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    previousState: commerceServiceEngagementStateEnum("previous_state"),
    nextState: commerceServiceEngagementStateEnum("next_state").notNull(),
    commandKind: text("command_kind").notNull(),
    note: text("note"),
    occurredAt: timestamp("occurred_at").notNull(),
    createdByMemberId: text("created_by_member_id")
      .notNull()
      .references(() => commerceOrganizationMember.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("commerce_service_engagement_event_sequence_uidx").on(
      table.engagementId,
      table.sequence,
    ),
    index("commerce_service_engagement_event_engagement_idx").on(
      table.engagementId,
      table.occurredAt,
      table.id,
    ),
    check("commerce_service_engagement_event_sequence_ck", sql`sequence >= 0`),
    check(
      "commerce_service_engagement_event_text_ck",
      sql`char_length(command_kind) BETWEEN 1 AND 80
          AND (note IS NULL OR char_length(note) BETWEEN 1 AND 2000)`,
    ),
  ],
);

export const commerceFulfillmentCommand = pgTable(
  "commerce_fulfillment_command",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    actorOrganizationId: text("actor_organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    actorMemberId: text("actor_member_id")
      .notNull()
      .references(() => commerceOrganizationMember.id, { onDelete: "restrict" }),
    targetKind: commerceFulfillmentCommandTargetKindEnum("target_kind").notNull(),
    targetId: text("target_id").notNull(),
    commandKind: text("command_kind").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    resultingVersion: integer("resulting_version"),
    responseStatus: integer("response_status").notNull(),
    responseBody: text("response_body").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("commerce_fulfillment_command_idempotency_uidx").on(
      table.actorOrganizationId,
      table.idempotencyKey,
    ),
    index("commerce_fulfillment_command_target_idx").on(table.targetKind, table.targetId, table.id),
    check(
      "commerce_fulfillment_command_text_ck",
      sql`char_length(command_kind) BETWEEN 1 AND 80
          AND char_length(idempotency_key) BETWEEN 8 AND 200
          AND char_length(request_fingerprint) = 64
          AND response_status BETWEEN 200 AND 299`,
    ),
  ],
);

export const freightEngagementDetail = pgTable(
  "freight_engagement_detail",
  {
    engagementId: text("engagement_id")
      .primaryKey()
      .references(() => commerceServiceEngagement.id, { onDelete: "cascade" }),
    sourceQuoteServiceLineId: text("source_quote_service_line_id").references(
      () => commerceQuoteServiceLine.id,
      { onDelete: "restrict" },
    ),
    transportModes: freightTransportModeEnum("transport_modes").array().notNull().default([]),
    originCountryCode: text("origin_country_code"),
    destinationCountryCode: text("destination_country_code"),
    estimatedTransitDays: integer("estimated_transit_days"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (_table) => [
    check(
      "freight_engagement_detail_country_ck",
      sql`(origin_country_code IS NULL OR origin_country_code ~ '^[A-Z]{2}$')
          AND (destination_country_code IS NULL OR destination_country_code ~ '^[A-Z]{2}$')`,
    ),
    check(
      "freight_engagement_detail_transit_ck",
      sql`estimated_transit_days IS NULL OR estimated_transit_days >= 0`,
    ),
  ],
);

export const customsBrokerageEngagementDetail = pgTable(
  "customs_brokerage_engagement_detail",
  {
    engagementId: text("engagement_id")
      .primaryKey()
      .references(() => commerceServiceEngagement.id, { onDelete: "cascade" }),
    sourceQuoteServiceLineId: text("source_quote_service_line_id").references(
      () => commerceQuoteServiceLine.id,
      { onDelete: "restrict" },
    ),
    jurisdictions: text("jurisdictions").array().notNull().default([]),
    filingSummary: text("filing_summary"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (_table) => [
    check(
      "customs_brokerage_engagement_detail_summary_ck",
      sql`filing_summary IS NULL OR char_length(filing_summary) BETWEEN 1 AND 4000`,
    ),
  ],
);

export const insuranceEngagementDetail = pgTable(
  "insurance_engagement_detail",
  {
    engagementId: text("engagement_id")
      .primaryKey()
      .references(() => commerceServiceEngagement.id, { onDelete: "cascade" }),
    sourceQuoteServiceLineId: text("source_quote_service_line_id").references(
      () => commerceQuoteServiceLine.id,
      { onDelete: "restrict" },
    ),
    coverageClasses: text("coverage_classes").array().notNull().default([]),
    /** Canonical integer string (no floats). */
    coverageLimitMinorUnits: text("coverage_limit_minor_units"),
    currency: text("currency"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (_table) => [
    check("insurance_engagement_detail_currency_ck", sql`currency ~ '^[A-Z]{3}$'`),
    check(
      "insurance_engagement_detail_amount_currency_pair_ck",
      sql`(coverage_limit_minor_units IS NULL) = (currency IS NULL)`,
    ),
    check(
      "insurance_engagement_detail_limit_ck",
      sql`coverage_limit_minor_units IS NULL
          OR coverage_limit_minor_units ~ '^(0|[1-9][0-9]{0,37})$'`,
    ),
  ],
);

export const inspectionEngagementDetail = pgTable("inspection_engagement_detail", {
  engagementId: text("engagement_id")
    .primaryKey()
    .references(() => commerceServiceEngagement.id, { onDelete: "cascade" }),
  sourceQuoteServiceLineId: text("source_quote_service_line_id").references(
    () => commerceQuoteServiceLine.id,
    { onDelete: "restrict" },
  ),
  includedStages: text("included_stages").array().notNull().default([]),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const testingCertificationEngagementDetail = pgTable(
  "testing_certification_engagement_detail",
  {
    engagementId: text("engagement_id")
      .primaryKey()
      .references(() => commerceServiceEngagement.id, { onDelete: "cascade" }),
    sourceQuoteServiceLineId: text("source_quote_service_line_id").references(
      () => commerceQuoteServiceLine.id,
      { onDelete: "restrict" },
    ),
    standards: text("standards").array().notNull().default([]),
    laboratoryLocation: text("laboratory_location"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
);

export const marketingEngagementDetail = pgTable(
  "marketing_engagement_detail",
  {
    engagementId: text("engagement_id")
      .primaryKey()
      .references(() => commerceServiceEngagement.id, { onDelete: "cascade" }),
    sourceQuoteServiceLineId: text("source_quote_service_line_id").references(
      () => commerceQuoteServiceLine.id,
      { onDelete: "restrict" },
    ),
    channels: text("channels").array().notNull().default([]),
    deliverablesSummary: text("deliverables_summary"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (_table) => [
    check(
      "marketing_engagement_detail_summary_ck",
      sql`deliverables_summary IS NULL OR char_length(deliverables_summary) BETWEEN 1 AND 4000`,
    ),
  ],
);

export const warehouseEngagementDetail = pgTable("warehouse_engagement_detail", {
  engagementId: text("engagement_id")
    .primaryKey()
    .references(() => commerceServiceEngagement.id, { onDelete: "cascade" }),
  sourceQuoteServiceLineId: text("source_quote_service_line_id").references(
    () => commerceQuoteServiceLine.id,
    { onDelete: "restrict" },
  ),
  storageTypes: text("storage_types").array().notNull().default([]),
  capacityUnits: text("capacity_units"),
  temperatureControlled: boolean("temperature_controlled").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const foreignExchangeEngagementDetail = pgTable(
  "foreign_exchange_engagement_detail",
  {
    engagementId: text("engagement_id")
      .primaryKey()
      .references(() => commerceServiceEngagement.id, { onDelete: "cascade" }),
    sourceQuoteServiceLineId: text("source_quote_service_line_id").references(
      () => commerceQuoteServiceLine.id,
      { onDelete: "restrict" },
    ),
    currencyPair: text("currency_pair").notNull(),
    /** Fixed-point mantissa as canonical digit string; pair with rateScale. */
    rateFixedPointUnits: text("rate_fixed_point_units").notNull(),
    rateScale: integer("rate_scale").notNull(),
    settlementRail: text("settlement_rail"),
    notionalAmountMinorUnits: text("notional_amount_minor_units"),
    notionalCurrency: text("notional_currency"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (_table) => [
    check(
      "foreign_exchange_engagement_detail_rate_ck",
      sql`rate_fixed_point_units ~ '^[1-9][0-9]{0,37}$' AND rate_scale BETWEEN 0 AND 12`,
    ),
    check(
      "foreign_exchange_engagement_detail_pair_ck",
      sql`char_length(currency_pair) = 7 AND currency_pair ~ '^[A-Z]{3}/[A-Z]{3}$'`,
    ),
    check("foreign_exchange_engagement_detail_currency_ck", sql`notional_currency ~ '^[A-Z]{3}$'`),
    check(
      "foreign_exchange_engagement_detail_notional_currency_pair_ck",
      sql`(notional_amount_minor_units IS NULL) = (notional_currency IS NULL)`,
    ),
    check(
      "foreign_exchange_engagement_detail_notional_ck",
      sql`notional_amount_minor_units IS NULL
          OR notional_amount_minor_units ~ '^(0|[1-9][0-9]{0,37})$'`,
    ),
  ],
);

export const commerceEngagementDeliverable = pgTable(
  "commerce_engagement_deliverable",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    engagementId: text("engagement_id")
      .notNull()
      .references(() => commerceServiceEngagement.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    title: text("title").notNull(),
    isRequired: boolean("is_required").default(true).notNull(),
    state: commerceEngagementDeliverableStateEnum("state").default("planned").notNull(),
    dueAt: timestamp("due_at"),
    submittedAt: timestamp("submitted_at"),
    reviewedAt: timestamp("reviewed_at"),
    evidenceDocumentId: text("evidence_document_id").references(
      () => commerceEncryptedDocument.id,
      { onDelete: "restrict" },
    ),
    reviewNote: text("review_note"),
    createdByMemberId: text("created_by_member_id")
      .notNull()
      .references(() => commerceOrganizationMember.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("commerce_engagement_deliverable_sequence_uidx").on(
      table.engagementId,
      table.sequence,
    ),
    index("commerce_engagement_deliverable_engagement_idx").on(
      table.engagementId,
      table.state,
      table.id,
    ),
    check("commerce_engagement_deliverable_sequence_ck", sql`sequence >= 0`),
    check(
      "commerce_engagement_deliverable_text_ck",
      sql`char_length(title) BETWEEN 1 AND 200
          AND (review_note IS NULL OR char_length(review_note) BETWEEN 1 AND 2000)`,
    ),
  ],
);

export const commerceEngagementDeliverableEvent = pgTable(
  "commerce_engagement_deliverable_event",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    deliverableId: text("deliverable_id")
      .notNull()
      .references(() => commerceEngagementDeliverable.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    previousState: commerceEngagementDeliverableStateEnum("previous_state"),
    nextState: commerceEngagementDeliverableStateEnum("next_state").notNull(),
    commandKind: text("command_kind").notNull(),
    note: text("note"),
    resultSnapshotJson: text("result_snapshot_json"),
    evidenceDocumentId: text("evidence_document_id").references(
      () => commerceEncryptedDocument.id,
      { onDelete: "restrict" },
    ),
    occurredAt: timestamp("occurred_at").notNull(),
    createdByMemberId: text("created_by_member_id")
      .notNull()
      .references(() => commerceOrganizationMember.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("commerce_engagement_deliverable_event_sequence_uidx").on(
      table.deliverableId,
      table.sequence,
    ),
    check("commerce_engagement_deliverable_event_sequence_ck", sql`sequence >= 0`),
    check(
      "commerce_engagement_deliverable_event_text_ck",
      sql`char_length(command_kind) BETWEEN 1 AND 80
          AND (note IS NULL OR char_length(note) BETWEEN 1 AND 2000)`,
    ),
    check(
      "commerce_engagement_deliverable_event_result_snapshot_ck",
      sql`result_snapshot_json IS NULL
          OR (
            char_length(result_snapshot_json) BETWEEN 2 AND 20000
            AND jsonb_typeof(result_snapshot_json::jsonb) = 'object'
          )`,
    ),
  ],
);

export const freightDeliverableDetail = pgTable(
  "freight_deliverable_detail",
  {
    deliverableId: text("deliverable_id")
      .primaryKey()
      .references(() => commerceEngagementDeliverable.id, { onDelete: "cascade" }),
    summary: text("summary").notNull(),
  },
  (_table) => [
    check("freight_deliverable_detail_summary_ck", sql`char_length(summary) BETWEEN 1 AND 2000`),
  ],
);

export const customsBrokerageDeliverableDetail = pgTable(
  "customs_brokerage_deliverable_detail",
  {
    deliverableId: text("deliverable_id")
      .primaryKey()
      .references(() => commerceEngagementDeliverable.id, { onDelete: "cascade" }),
    filingKind: text("filing_kind").notNull(),
    jurisdiction: text("jurisdiction").notNull(),
    providerFilingReference: text("provider_filing_reference"),
    declarationReference: text("declaration_reference"),
    decision: text("decision"),
  },
  (_table) => [
    check(
      "customs_brokerage_deliverable_detail_text_ck",
      sql`char_length(filing_kind) BETWEEN 1 AND 80
          AND char_length(jurisdiction) BETWEEN 1 AND 80
          AND (provider_filing_reference IS NULL OR char_length(provider_filing_reference) BETWEEN 1 AND 200)
          AND (declaration_reference IS NULL OR char_length(declaration_reference) BETWEEN 1 AND 200)
          AND (decision IS NULL OR decision IN ('cleared', 'rejected', 'pending'))`,
    ),
  ],
);

export const insuranceDeliverableDetail = pgTable(
  "insurance_deliverable_detail",
  {
    deliverableId: text("deliverable_id")
      .primaryKey()
      .references(() => commerceEngagementDeliverable.id, { onDelete: "cascade" }),
    policyReference: text("policy_reference").notNull(),
    coverageClass: text("coverage_class").notNull(),
    insuredValueMinorUnits: text("insured_value_minor_units"),
    coverageLimitMinorUnits: text("coverage_limit_minor_units"),
    currency: text("currency"),
    effectiveFrom: timestamp("effective_from"),
    effectiveTo: timestamp("effective_to"),
  },
  (_table) => [
    check("insurance_deliverable_detail_currency_ck", sql`currency ~ '^[A-Z]{3}$'`),
    check(
      "insurance_deliverable_detail_amount_currency_pair_ck",
      sql`(insured_value_minor_units IS NOT NULL OR coverage_limit_minor_units IS NOT NULL)
          = (currency IS NOT NULL)`,
    ),
    check(
      "insurance_deliverable_detail_text_ck",
      sql`char_length(policy_reference) BETWEEN 1 AND 200
          AND char_length(coverage_class) BETWEEN 1 AND 80
          AND (insured_value_minor_units IS NULL OR insured_value_minor_units ~ '^(0|[1-9][0-9]{0,37})$')
          AND (coverage_limit_minor_units IS NULL OR coverage_limit_minor_units ~ '^(0|[1-9][0-9]{0,37})$')`,
    ),
  ],
);

export const inspectionDeliverableDetail = pgTable(
  "inspection_deliverable_detail",
  {
    deliverableId: text("deliverable_id")
      .primaryKey()
      .references(() => commerceEngagementDeliverable.id, { onDelete: "cascade" }),
    stage: text("stage").notNull(),
    result: text("result").notNull(),
    findingsSummary: text("findings_summary"),
    inspectedQuantity: integer("inspected_quantity"),
    inspectedAt: timestamp("inspected_at"),
  },
  (_table) => [
    check(
      "inspection_deliverable_detail_result_ck",
      sql`result IN ('passed', 'conditional', 'failed')
          AND char_length(stage) BETWEEN 1 AND 80
          AND (findings_summary IS NULL OR char_length(findings_summary) BETWEEN 1 AND 4000)
          AND (inspected_quantity IS NULL OR inspected_quantity > 0)`,
    ),
  ],
);

export const testingCertificationDeliverableDetail = pgTable(
  "testing_certification_deliverable_detail",
  {
    deliverableId: text("deliverable_id")
      .primaryKey()
      .references(() => commerceEngagementDeliverable.id, { onDelete: "cascade" }),
    standard: text("standard").notNull(),
    specimenReference: text("specimen_reference"),
    result: text("result").notNull(),
    laboratoryLocation: text("laboratory_location"),
    reportedAt: timestamp("reported_at"),
  },
  (_table) => [
    check(
      "testing_certification_deliverable_detail_result_ck",
      sql`result IN ('passed', 'failed', 'inconclusive')
          AND char_length(standard) BETWEEN 1 AND 120
          AND (specimen_reference IS NULL OR char_length(specimen_reference) BETWEEN 1 AND 200)
          AND (laboratory_location IS NULL OR char_length(laboratory_location) BETWEEN 1 AND 200)`,
    ),
  ],
);

export const warehouseDeliverableDetail = pgTable(
  "warehouse_deliverable_detail",
  {
    deliverableId: text("deliverable_id")
      .primaryKey()
      .references(() => commerceEngagementDeliverable.id, { onDelete: "cascade" }),
    movementKind: text("movement_kind").notNull(),
    quantityUnits: text("quantity_units").notNull(),
    quantityScale: integer("quantity_scale").notNull(),
    unitLabel: text("unit_label").notNull(),
    facilityIdentifier: text("facility_identifier"),
    occurredAt: timestamp("occurred_at"),
  },
  (_table) => [
    check(
      "warehouse_deliverable_detail_movement_ck",
      sql`movement_kind IN ('receipt', 'putaway', 'pick', 'release', 'adjustment')
          AND quantity_units ~ '^(0|[1-9][0-9]{0,37})$'
          AND quantity_scale BETWEEN 0 AND 12
          AND char_length(unit_label) BETWEEN 1 AND 40
          AND (facility_identifier IS NULL OR char_length(facility_identifier) BETWEEN 1 AND 120)`,
    ),
  ],
);

export const marketingDeliverableDetail = pgTable(
  "marketing_deliverable_detail",
  {
    deliverableId: text("deliverable_id")
      .primaryKey()
      .references(() => commerceEngagementDeliverable.id, { onDelete: "cascade" }),
    deliverableKind: text("deliverable_kind").notNull(),
    channel: text("channel").notNull(),
    artifactUrl: text("artifact_url"),
    metricsSummary: text("metrics_summary"),
    publishedAt: timestamp("published_at"),
  },
  (_table) => [
    check(
      "marketing_deliverable_detail_text_ck",
      sql`char_length(deliverable_kind) BETWEEN 1 AND 80
          AND char_length(channel) BETWEEN 1 AND 80
          AND (artifact_url IS NULL OR char_length(artifact_url) BETWEEN 1 AND 2000)
          AND (metrics_summary IS NULL OR char_length(metrics_summary) BETWEEN 1 AND 4000)`,
    ),
  ],
);

export const foreignExchangeDeliverableDetail = pgTable(
  "foreign_exchange_deliverable_detail",
  {
    deliverableId: text("deliverable_id")
      .primaryKey()
      .references(() => commerceEngagementDeliverable.id, { onDelete: "cascade" }),
    currencyPair: text("currency_pair").notNull(),
    rateFixedPointUnits: text("rate_fixed_point_units").notNull(),
    rateScale: integer("rate_scale").notNull(),
    sellAmountMinorUnits: text("sell_amount_minor_units").notNull(),
    buyAmountMinorUnits: text("buy_amount_minor_units").notNull(),
    sellCurrency: text("sell_currency").notNull(),
    buyCurrency: text("buy_currency").notNull(),
    providerExecutionReference: text("provider_execution_reference"),
    confirmationState: text("confirmation_state").default("provider_confirmed").notNull(),
  },
  (_table) => [
    check(
      "foreign_exchange_deliverable_detail_rate_ck",
      sql`rate_fixed_point_units ~ '^[1-9][0-9]{0,37}$' AND rate_scale BETWEEN 0 AND 12`,
    ),
    check(
      "foreign_exchange_deliverable_detail_pair_ck",
      sql`char_length(currency_pair) = 7 AND currency_pair ~ '^[A-Z]{3}/[A-Z]{3}$'
          AND sell_currency ~ '^[A-Z]{3}$' AND buy_currency ~ '^[A-Z]{3}$'`,
    ),
    check(
      "foreign_exchange_deliverable_detail_amounts_ck",
      sql`sell_amount_minor_units ~ '^(0|[1-9][0-9]{0,37})$'
          AND buy_amount_minor_units ~ '^(0|[1-9][0-9]{0,37})$'
          AND confirmation_state IN ('provider_confirmed')
          AND (provider_execution_reference IS NULL OR char_length(provider_execution_reference) BETWEEN 1 AND 200)`,
    ),
  ],
);

/**
 * A commerce payment intent for one order (STORE_BACKEND_STRUCTURE.md §4.9).
 *
 * Amount and currency are copied from the immutable order snapshot at create — never
 * accepted from the client. The local row and idempotency key are committed BEFORE any
 * provider call; the worker submits through the adapter seam.
 */
export const commercePaymentIntent = pgTable(
  "commerce_payment_intent",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    orderId: text("order_id")
      .notNull()
      .references(() => commerceOrder.id, { onDelete: "restrict" }),
    buyerOrganizationId: text("buyer_organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    counterpartyOrganizationId: text("counterparty_organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    provider: commercePaymentProviderEnum("provider").notNull(),
    state: commercePaymentIntentStateEnum("state").default("created").notNull(),
    amountInCents: bigint("amount_in_cents", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    /** OURS, minted before any provider call. Unique across intents. */
    idempotencyKey: text("idempotency_key").notNull(),
    providerPaymentRef: text("provider_payment_ref"),
    failureReason: text("failure_reason"),
    authorizedAt: timestamp("authorized_at"),
    settledAt: timestamp("settled_at"),
    failedAt: timestamp("failed_at"),
    cancelledAt: timestamp("cancelled_at"),
    /**
     * THE `direct_processor` RAIL (Phase 14). The SELLER's account at the processor —
     * the destination funds settle to, because Qatoto is not the merchant of record and
     * does not take custody. An opaque provider-side reference, never a bank detail.
     *
     * Null on every other rail. `internal_custody` predates the whole idea, and
     * `direct_offline` and `external_escrow` never create a payment intent at all.
     */
    settlementAccountRef: text("settlement_account_ref"),
    /**
     * Qatoto's commission, deducted by the processor at settlement. Requires a
     * settlement account: a fee without a destination would be a deduction from money
     * this backend is not routing.
     */
    applicationFeeInCents: bigint("application_fee_in_cents", { mode: "number" }),
    createdByMemberId: text("created_by_member_id")
      .notNull()
      .references(() => commerceOrganizationMember.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("commerce_payment_intent_idempotency_uidx").on(table.idempotencyKey),
    uniqueIndex("commerce_payment_intent_provider_ref_uidx")
      .on(table.provider, table.providerPaymentRef)
      .where(sql`provider_payment_ref IS NOT NULL`),
    // At most one non-terminal intent per order. Terminal states may coexist with a
    // replacement intent after failure/cancellation.
    uniqueIndex("commerce_payment_intent_active_order_uidx")
      .on(table.orderId)
      .where(
        sql`state IN ('created', 'requires_action', 'processing', 'authorized', 'settled', 'partially_refunded', 'refunded', 'disputed')`,
      ),
    index("commerce_payment_intent_order_idx").on(table.orderId, table.id),
    index("commerce_payment_intent_buyer_idx").on(table.buyerOrganizationId, table.state, table.id),
    index("commerce_payment_intent_state_idx").on(table.state, table.updatedAt, table.id),
    check("commerce_payment_intent_currency_ck", sql`currency ~ '^[A-Z]{3}$'`),
    check("commerce_payment_intent_amount_ck", sql`amount_in_cents > 0`),
    check(
      "commerce_payment_intent_failure_ck",
      sql`failure_reason IS NULL OR char_length(failure_reason) BETWEEN 1 AND 1000`,
    ),
    check(
      "commerce_payment_intent_settlement_account_ck",
      sql`(settlement_account_ref IS NULL OR char_length(settlement_account_ref) BETWEEN 1 AND 200)
          AND (application_fee_in_cents IS NULL
               OR (application_fee_in_cents >= 0 AND application_fee_in_cents <= amount_in_cents))
          AND (application_fee_in_cents IS NULL OR settlement_account_ref IS NOT NULL)`,
    ),
  ],
);

/**
 * A transfer submitted to the commerce payment provider.
 *
 * Written with OUR idempotency key BEFORE the adapter call (STORE §4.9 / ESCROW §7).
 */
export const commerceProviderTransfer = pgTable(
  "commerce_provider_transfer",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    paymentIntentId: text("payment_intent_id")
      .notNull()
      .references(() => commercePaymentIntent.id, { onDelete: "restrict" }),
    refundId: text("refund_id").references((): AnyPgColumn => commerceRefund.id, {
      onDelete: "set null",
    }),
    orderId: text("order_id")
      .notNull()
      .references(() => commerceOrder.id, { onDelete: "restrict" }),
    provider: commercePaymentProviderEnum("provider").notNull(),
    direction: text("direction").notNull(),
    state: commerceProviderTransferStateEnum("state").default("created").notNull(),
    amountInCents: bigint("amount_in_cents", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    providerTransferRef: text("provider_transfer_ref"),
    failureReason: text("failure_reason"),
    submittedAt: timestamp("submitted_at"),
    settledAt: timestamp("settled_at"),
    failedAt: timestamp("failed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("commerce_provider_transfer_idempotency_uidx").on(table.idempotencyKey),
    uniqueIndex("commerce_provider_transfer_provider_ref_uidx")
      .on(table.provider, table.providerTransferRef)
      .where(sql`provider_transfer_ref IS NOT NULL`),
    index("commerce_provider_transfer_intent_idx").on(table.paymentIntentId, table.id),
    index("commerce_provider_transfer_order_idx").on(table.orderId, table.id),
    index("commerce_provider_transfer_state_idx").on(table.state, table.updatedAt, table.id),
    check("commerce_provider_transfer_direction_ck", sql`direction IN ('inbound', 'outbound')`),
    check("commerce_provider_transfer_currency_ck", sql`currency ~ '^[A-Z]{3}$'`),
    check("commerce_provider_transfer_amount_ck", sql`amount_in_cents > 0`),
  ],
);

export const commerceRefund = pgTable(
  "commerce_refund",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    paymentIntentId: text("payment_intent_id")
      .notNull()
      .references(() => commercePaymentIntent.id, { onDelete: "restrict" }),
    orderId: text("order_id")
      .notNull()
      .references(() => commerceOrder.id, { onDelete: "restrict" }),
    buyerOrganizationId: text("buyer_organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    provider: commercePaymentProviderEnum("provider").notNull(),
    state: commerceRefundStateEnum("state").default("created").notNull(),
    amountInCents: bigint("amount_in_cents", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    providerRefundRef: text("provider_refund_ref"),
    reason: text("reason"),
    failureReason: text("failure_reason"),
    settledAt: timestamp("settled_at"),
    failedAt: timestamp("failed_at"),
    createdByMemberId: text("created_by_member_id")
      .notNull()
      .references(() => commerceOrganizationMember.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("commerce_refund_idempotency_uidx").on(table.idempotencyKey),
    uniqueIndex("commerce_refund_provider_ref_uidx")
      .on(table.provider, table.providerRefundRef)
      .where(sql`provider_refund_ref IS NOT NULL`),
    index("commerce_refund_intent_idx").on(table.paymentIntentId, table.id),
    index("commerce_refund_order_idx").on(table.orderId, table.id),
    check("commerce_refund_currency_ck", sql`currency ~ '^[A-Z]{3}$'`),
    check("commerce_refund_amount_ck", sql`amount_in_cents > 0`),
    check(
      "commerce_refund_reason_ck",
      sql`reason IS NULL OR char_length(reason) BETWEEN 1 AND 1000`,
    ),
  ],
);

/**
 * One double-entry account per (order, kind). Balances are derived from journal lines;
 * cached balance columns are deliberately absent so the journal remains the sole truth.
 */
export const commerceJournalAccount = pgTable(
  "commerce_journal_account",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    orderId: text("order_id")
      .notNull()
      .references(() => commerceOrder.id, { onDelete: "restrict" }),
    kind: commerceJournalAccountKindEnum("kind").notNull(),
    currency: text("currency").notNull(),
    /**
     * Phase 14. OFF BALANCE SHEET: this account records value a third party holds, not
     * a Qatoto asset or liability.
     *
     * Derived from `kind` and bound to it by check, so it cannot drift — the point is
     * not the column but that no future balance report can sum memo value and real money
     * into one number. Flattening the two is unavailable rather than discouraged, the
     * same call Phase 12 made splitting `declaredProfile` from `measuredMetrics`.
     */
    isMemorandum: boolean("is_memorandum").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("commerce_journal_account_order_kind_uidx").on(table.orderId, table.kind),
    check("commerce_journal_account_currency_ck", sql`currency ~ '^[A-Z]{3}$'`),
    /**
     * COMPARED ON `::text`, DELIBERATELY. `db:migrate` runs every pending migration in
     * ONE transaction, and a value added by `ALTER TYPE ... ADD VALUE` cannot be used as
     * an enum literal until that transaction commits. Casting to text sidesteps the
     * coercion entirely, so this constraint can ship in the same release that adds the
     * four memo kinds instead of waiting a deploy.
     */
    check(
      "commerce_journal_account_memorandum_ck",
      sql`is_memorandum = (kind::text IN ('settlement_funding_memo', 'settlement_custody_memo',
                                          'settlement_released_memo', 'settlement_refunded_memo'))`,
    ),
  ],
);

/**
 * Append-only, hash-chained commerce journal header (ESCROW_LEDGER_STRUCTURE.md §4).
 * Corrections are reversing entries — never UPDATE or DELETE.
 */
export const commerceJournalEntry = pgTable(
  "commerce_journal_entry",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    orderId: text("order_id")
      .notNull()
      .references(() => commerceOrder.id, { onDelete: "restrict" }),
    sequenceNumber: integer("sequence_number").notNull(),
    kind: commerceJournalKindEnum("kind").notNull(),
    description: text("description").notNull(),
    currency: text("currency").notNull(),
    occurredAt: timestamp("occurred_at").notNull(),
    settlement: commerceJournalEntrySettlementEnum("settlement").default("pending").notNull(),
    linkedPaymentIntentId: text("linked_payment_intent_id").references(
      () => commercePaymentIntent.id,
      { onDelete: "set null" },
    ),
    linkedRefundId: text("linked_refund_id").references(() => commerceRefund.id, {
      onDelete: "set null",
    }),
    linkedTransferId: text("linked_transfer_id").references(() => commerceProviderTransfer.id, {
      onDelete: "set null",
    }),
    reversesJournalEntryId: text("reverses_journal_entry_id").references(
      (): AnyPgColumn => commerceJournalEntry.id,
      { onDelete: "restrict" },
    ),
    entryHash: text("entry_hash").notNull(),
    previousEntryHash: text("previous_entry_hash").notNull(),
    hashVersion: integer("hash_version").default(1).notNull(),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("commerce_journal_entry_order_seq_uidx").on(table.orderId, table.sequenceNumber),
    index("commerce_journal_entry_order_occurred_idx").on(
      table.orderId,
      table.occurredAt,
      table.id,
    ),
    index("commerce_journal_entry_payment_intent_idx").on(table.linkedPaymentIntentId),
    check("commerce_journal_entry_sequence_ck", sql`sequence_number >= 1`),
    check("commerce_journal_entry_hash_ck", sql`entry_hash ~ '^[0-9a-f]{64}$'`),
    check(
      "commerce_journal_entry_link_ck",
      sql`(sequence_number = 1) = (previous_entry_hash = 'genesis')
          AND (previous_entry_hash = 'genesis' OR previous_entry_hash ~ '^[0-9a-f]{64}$')`,
    ),
    check(
      "commerce_journal_entry_reversal_ck",
      sql`(kind <> 'reversal') OR (reverses_journal_entry_id IS NOT NULL)`,
    ),
    check("commerce_journal_entry_currency_ck", sql`currency ~ '^[A-Z]{3}$'`),
    check("commerce_journal_entry_description_ck", sql`char_length(description) BETWEEN 1 AND 500`),
  ],
);

/**
 * Signed postings for one journal entry. Positive INTO the account, negative OUT.
 * SUM over one entry MUST equal zero (service assert + deferred constraint trigger).
 */
export const commerceJournalLine = pgTable(
  "commerce_journal_line",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    journalEntryId: text("journal_entry_id")
      .notNull()
      .references(() => commerceJournalEntry.id, { onDelete: "restrict" }),
    orderId: text("order_id")
      .notNull()
      .references(() => commerceOrder.id, { onDelete: "restrict" }),
    accountId: text("account_id")
      .notNull()
      .references(() => commerceJournalAccount.id, { onDelete: "restrict" }),
    accountKind: commerceJournalAccountKindEnum("account_kind").notNull(),
    signedAmountInCents: bigint("signed_amount_in_cents", { mode: "bigint" }).notNull(),
    lineIndex: integer("line_index").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("commerce_journal_line_entry_index_uidx").on(table.journalEntryId, table.lineIndex),
    index("commerce_journal_line_account_idx").on(table.accountId, table.id),
    index("commerce_journal_line_order_kind_idx").on(table.orderId, table.accountKind),
    check("commerce_journal_line_index_ck", sql`line_index >= 0`),
    check("commerce_journal_line_amount_ck", sql`signed_amount_in_cents <> 0`),
  ],
);

/**
 * Durable outbox for commerce provider calls. Local intent rows commit first; the worker
 * drains this table and calls the adapter (STORE §9 integration pattern).
 */
export const commercePaymentOutbox = pgTable(
  "commerce_payment_outbox",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    kind: commercePaymentOutboxKindEnum("kind").notNull(),
    state: commercePaymentOutboxStateEnum("state").default("pending").notNull(),
    paymentIntentId: text("payment_intent_id").references(() => commercePaymentIntent.id, {
      onDelete: "restrict",
    }),
    refundId: text("refund_id").references(() => commerceRefund.id, { onDelete: "restrict" }),
    transferId: text("transfer_id")
      .notNull()
      .references(() => commerceProviderTransfer.id, { onDelete: "restrict" }),
    orderId: text("order_id")
      .notNull()
      .references(() => commerceOrder.id, { onDelete: "restrict" }),
    attemptCount: integer("attempt_count").default(0).notNull(),
    lastError: text("last_error"),
    availableAt: timestamp("available_at").defaultNow().notNull(),
    processedAt: timestamp("processed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("commerce_payment_outbox_transfer_uidx").on(table.transferId),
    index("commerce_payment_outbox_pending_idx").on(table.state, table.availableAt, table.id),
    check(
      "commerce_payment_outbox_target_ck",
      sql`(kind = 'submit_payment_intent' AND payment_intent_id IS NOT NULL AND refund_id IS NULL)
          OR (kind = 'submit_refund' AND refund_id IS NOT NULL AND payment_intent_id IS NOT NULL)`,
    ),
    check("commerce_payment_outbox_attempt_ck", sql`attempt_count >= 0`),
  ],
);

/**
 * Provider webhook / settlement-event inbox. Persist BEFORE applying state transitions;
 * unique (provider, provider_event_id) makes replay harmless.
 */
export const commercePaymentWebhookEvent = pgTable(
  "commerce_payment_webhook_event",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    provider: commercePaymentProviderEnum("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    eventType: text("event_type").notNull(),
    paymentIntentId: text("payment_intent_id").references(() => commercePaymentIntent.id, {
      onDelete: "set null",
    }),
    transferId: text("transfer_id").references(() => commerceProviderTransfer.id, {
      onDelete: "set null",
    }),
    refundId: text("refund_id").references(() => commerceRefund.id, { onDelete: "set null" }),
    orderId: text("order_id").references(() => commerceOrder.id, { onDelete: "set null" }),
    payloadJson: text("payload_json").notNull(),
    receivedAt: timestamp("received_at").defaultNow().notNull(),
    processedAt: timestamp("processed_at"),
    processingError: text("processing_error"),
  },
  (table) => [
    uniqueIndex("commerce_payment_webhook_event_provider_uidx").on(
      table.provider,
      table.providerEventId,
    ),
    index("commerce_payment_webhook_event_unprocessed_idx")
      .on(table.receivedAt, table.id)
      .where(sql`processed_at IS NULL`),
    check("commerce_payment_webhook_event_type_ck", sql`char_length(event_type) BETWEEN 1 AND 120`),
    check(
      "commerce_payment_webhook_event_payload_ck",
      sql`char_length(payload_json) BETWEEN 2 AND 50000 AND payload_json LIKE '{%'`,
    ),
  ],
);

/**
 * Server-issued completion records (STORE Phase 7). Created only from verified product
 * fulfillment or completed service engagements; reviews attach to these identities.
 */
export const commerceCompletion = pgTable(
  "commerce_completion",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    targetKind: commerceCompletionTargetKindEnum("target_kind").notNull(),
    orderId: text("order_id")
      .notNull()
      .references(() => commerceOrder.id, { onDelete: "restrict" }),
    buyerOrganizationId: text("buyer_organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    counterpartyOrganizationId: text("counterparty_organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    orderProductLineId: text("order_product_line_id").references(
      () => commerceOrderProductLine.id,
      {
        onDelete: "restrict",
      },
    ),
    serviceEngagementId: text("service_engagement_id").references(
      () => commerceServiceEngagement.id,
      { onDelete: "restrict" },
    ),
    productId: text("product_id").references(() => product.id, { onDelete: "restrict" }),
    completedAt: timestamp("completed_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("commerce_completion_product_line_uidx")
      .on(table.orderProductLineId)
      .where(sql`order_product_line_id IS NOT NULL`),
    uniqueIndex("commerce_completion_engagement_uidx")
      .on(table.serviceEngagementId)
      .where(sql`service_engagement_id IS NOT NULL`),
    index("commerce_completion_buyer_idx").on(table.buyerOrganizationId, table.completedAt),
    /**
     * `0092`. The buyer-facing list (`GET /commerce/completions`) pages with §7's tie-break,
     * so it orders `completed_at DESC, id` and the index above — which stops at
     * `completed_at` — cannot serve the last leg. Same shape, and same reason, as the
     * review keyset indexes below. The older index is kept: it still serves the range
     * reads `commerce-trust-metrics` does.
     */
    index("commerce_completion_buyer_keyset_idx").on(
      table.buyerOrganizationId,
      table.completedAt.desc(),
      table.id,
    ),
    index("commerce_completion_counterparty_idx").on(
      table.counterpartyOrganizationId,
      table.completedAt,
    ),
    index("commerce_completion_product_idx")
      .on(table.productId, table.completedAt)
      .where(sql`product_id IS NOT NULL`),
    check(
      "commerce_completion_target_ck",
      sql`(target_kind = 'product_order_line'
              AND order_product_line_id IS NOT NULL
              AND service_engagement_id IS NULL
              AND product_id IS NOT NULL)
          OR (target_kind = 'service_engagement'
              AND service_engagement_id IS NOT NULL
              AND order_product_line_id IS NULL
              AND product_id IS NULL)`,
    ),
    check(
      "commerce_completion_counterparty_ck",
      sql`buyer_organization_id <> counterparty_organization_id`,
    ),
  ],
);

/**
 * A17. The mechanism that makes `samplePolicy = 'refundable'` mean something.
 *
 * Until Phase 11 the third policy value was decorative: a buyer paid for a sample and
 * nothing returned that value against a later bulk order.
 *
 * WHY A CREDIT AND NOT A REFUND. A refund moves money twice and leaves a buyer who
 * never orders in bulk with an obligation open forever. A credit is minted once when
 * the sample order completes and spent once as a discount on a later order from the
 * SAME SELLER in the SAME CURRENCY. It also needs no new journal kind: the discount
 * lands before a payment intent exists, so no cross-order money movement is invented —
 * and `commerce_journal_entry` is strictly per-order.
 */
export const commerceSampleCredit = pgTable(
  "commerce_sample_credit",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    buyerOrganizationId: text("buyer_organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    sellerOrganizationId: text("seller_organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    productId: text("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "restrict" }),
    sourceOrderId: text("source_order_id")
      .notNull()
      .references(() => commerceOrder.id, { onDelete: "restrict" }),
    amountInCents: bigint("amount_in_cents", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    state: commerceSampleCreditStateEnum("state").default("available").notNull(),
    consumedByOrderId: text("consumed_by_order_id").references(() => commerceOrder.id, {
      onDelete: "restrict",
    }),
    consumedAt: timestamp("consumed_at"),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    /**
     * One credit per sample order. Completion issuance is idempotent and may run more
     * than once for an order, so this is what stops a replay minting a second credit.
     */
    uniqueIndex("commerce_sample_credit_source_order_uidx").on(table.sourceOrderId),
    index("commerce_sample_credit_spendable_idx")
      .on(table.buyerOrganizationId, table.sellerOrganizationId, table.currency)
      .where(sql`state = 'available'`),
    check("commerce_sample_credit_amount_ck", sql`amount_in_cents > 0`),
    check("commerce_sample_credit_currency_ck", sql`currency ~ '^[A-Z]{3}$'`),
    check(
      "commerce_sample_credit_parties_ck",
      sql`buyer_organization_id <> seller_organization_id`,
    ),
    // Consumption attribution and state agree in both directions.
    check(
      "commerce_sample_credit_consumption_ck",
      sql`(state = 'consumed' AND consumed_by_order_id IS NOT NULL AND consumed_at IS NOT NULL)
          OR (state <> 'consumed' AND consumed_by_order_id IS NULL AND consumed_at IS NULL)`,
    ),
  ],
);

/**
 * A18. What a seller offers to customize, and on what commercial terms.
 *
 * `minimumOrderQuantity` IS A COMMERCIAL TERM, not a hint: a logo at 50 units and
 * packaging artwork at 200 change what the buyer may order. The server enforces it at
 * cart and again at checkout; the client's copy of the number is a display value.
 */
export const commerceProductCustomizationOption = pgTable(
  "commerce_product_customization_option",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    productId: text("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "cascade" }),
    /** Stable machine key, snake_case, so a renamed label does not orphan a selection. */
    slotKey: text("slot_key").notNull(),
    label: text("label").notNull(),
    customizationKind: commerceProductCustomizationKindEnum("customization_kind").notNull(),
    /** Upload slots only. Verified against DECODED BYTES at upload, never the declared type. */
    acceptedMediaTypes: text("accepted_media_types").array().default([]).notNull(),
    /** Choice slots only. */
    choiceValues: text("choice_values").array().default([]).notNull(),
    minimumOrderQuantity: integer("minimum_order_quantity").default(1).notNull(),
    isRequired: boolean("is_required").default(false).notNull(),
    position: integer("position").notNull(),
    state: commerceProductCustomizationOptionStateEnum("state").default("active").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("commerce_product_customization_option_slot_uidx").on(
      table.productId,
      table.slotKey,
    ),
    uniqueIndex("commerce_product_customization_option_position_uidx").on(
      table.productId,
      table.position,
    ),
    index("commerce_product_customization_option_active_idx").on(
      table.productId,
      table.state,
      table.position,
    ),
    check(
      "commerce_product_customization_option_slot_key_ck",
      sql`slot_key ~ '^[a-z0-9]+(_[a-z0-9]+)*$' AND char_length(slot_key) BETWEEN 1 AND 60`,
    ),
    check(
      "commerce_product_customization_option_label_ck",
      sql`char_length(label) BETWEEN 1 AND 120`,
    ),
    check(
      "commerce_product_customization_option_moq_ck",
      sql`minimum_order_quantity BETWEEN 1 AND 1000000`,
    ),
    check("commerce_product_customization_option_position_ck", sql`position >= 0`),
    check(
      "commerce_product_customization_option_kind_ck",
      sql`(customization_kind = 'file_upload'
             AND cardinality(accepted_media_types) > 0 AND cardinality(choice_values) = 0)
          OR (customization_kind = 'choice'
             AND cardinality(choice_values) > 0 AND cardinality(accepted_media_types) = 0)`,
    ),
  ],
);

/**
 * A18. What the buyer supplied, carried the whole length of the snapshot chain.
 *
 * THREE TABLES, NOT ONE, because `confirmCheckout` builds an order line verbatim from
 * the prepare row and never re-reads the cart. A selection that does not exist on the
 * prepare cannot reach an order.
 *
 * The snapshots sit beside the option pointer because a seller may rename a slot after
 * the sale, and what the buyer agreed to is what the order must say.
 */
export const commerceCartLineCustomization = pgTable(
  "commerce_cart_line_customization",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    cartProductLineId: text("cart_product_line_id")
      .notNull()
      .references(() => commerceCartProductLine.id, { onDelete: "cascade" }),
    customizationOptionId: text("customization_option_id")
      .notNull()
      .references(() => commerceProductCustomizationOption.id, { onDelete: "restrict" }),
    encryptedDocumentId: text("encrypted_document_id").references(
      () => commerceEncryptedDocument.id,
      { onDelete: "restrict" },
    ),
    choiceValue: text("choice_value"),
    slotKeySnapshot: text("slot_key_snapshot").notNull(),
    labelSnapshot: text("label_snapshot").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("commerce_cart_line_customization_slot_uidx").on(
      table.cartProductLineId,
      table.slotKeySnapshot,
    ),
    check(
      "commerce_cart_line_customization_supply_ck",
      sql`(encrypted_document_id IS NOT NULL AND choice_value IS NULL)
          OR (encrypted_document_id IS NULL AND choice_value IS NOT NULL)`,
    ),
  ],
);

export const commerceCheckoutPrepareLineCustomization = pgTable(
  "commerce_checkout_prepare_line_customization",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    prepareProductLineId: text("prepare_product_line_id")
      .notNull()
      .references(() => commerceCheckoutPrepareProductLine.id, { onDelete: "cascade" }),
    customizationOptionId: text("customization_option_id")
      .notNull()
      .references(() => commerceProductCustomizationOption.id, { onDelete: "restrict" }),
    encryptedDocumentId: text("encrypted_document_id").references(
      () => commerceEncryptedDocument.id,
      { onDelete: "restrict" },
    ),
    choiceValue: text("choice_value"),
    slotKeySnapshot: text("slot_key_snapshot").notNull(),
    labelSnapshot: text("label_snapshot").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("commerce_checkout_prepare_line_customization_slot_uidx").on(
      table.prepareProductLineId,
      table.slotKeySnapshot,
    ),
    check(
      "commerce_checkout_prepare_line_customization_supply_ck",
      sql`(encrypted_document_id IS NOT NULL AND choice_value IS NULL)
          OR (encrypted_document_id IS NULL AND choice_value IS NOT NULL)`,
    ),
  ],
);

export const commerceOrderLineCustomization = pgTable(
  "commerce_order_line_customization",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    orderProductLineId: text("order_product_line_id")
      .notNull()
      .references(() => commerceOrderProductLine.id, { onDelete: "cascade" }),
    customizationOptionId: text("customization_option_id")
      .notNull()
      .references(() => commerceProductCustomizationOption.id, { onDelete: "restrict" }),
    encryptedDocumentId: text("encrypted_document_id").references(
      () => commerceEncryptedDocument.id,
      { onDelete: "restrict" },
    ),
    choiceValue: text("choice_value"),
    slotKeySnapshot: text("slot_key_snapshot").notNull(),
    labelSnapshot: text("label_snapshot").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("commerce_order_line_customization_slot_uidx").on(
      table.orderProductLineId,
      table.slotKeySnapshot,
    ),
    index("commerce_order_line_customization_option_idx").on(table.customizationOptionId),
    check(
      "commerce_order_line_customization_supply_ck",
      sql`(encrypted_document_id IS NOT NULL AND choice_value IS NULL)
          OR (encrypted_document_id IS NULL AND choice_value IS NOT NULL)`,
    ),
  ],
);

export const commerceReview = pgTable(
  "commerce_review",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    completionId: text("completion_id")
      .notNull()
      .references(() => commerceCompletion.id, { onDelete: "restrict" }),
    reviewerOrganizationId: text("reviewer_organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    reviewerMemberId: text("reviewer_member_id")
      .notNull()
      .references(() => commerceOrganizationMember.id, { onDelete: "restrict" }),
    subjectOrganizationId: text("subject_organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    productId: text("product_id").references(() => product.id, { onDelete: "restrict" }),
    rating: integer("rating").notNull(),
    body: text("body").notNull(),
    visibility: commerceReviewVisibilityEnum("visibility").default("visible").notNull(),
    /**
     * DENORMALIZED counters (STORE Appendix A8), moved in the same transaction as the
     * row that caused them — `commerce_review_vote` and `commerce_review_media`.
     *
     * They are columns rather than `count(*)` because BOTH are ordering/filtering
     * inputs on the public read: "most helpful" is a sort chip and a keyset cursor
     * needs its sort key stored and indexed on the ordered table, and `media_count > 0`
     * is sargable in a partial-index predicate where `EXISTS (...)` is not.
     *
     * They are NOT a `commerce_review_stats` side table the way `video_stats` is:
     * that table exists because a video has ten counters written by async jobs on a
     * wide row that is frequently read without them. A review has two integers and is
     * never read without them, so a 1:1 join would cost every page and buy nothing.
     *
     * Drift is reconstructible — `verify-store-phase-10-constraints` asserts both
     * against `count(*)` over their source tables.
     */
    helpfulCount: integer("helpful_count").default(0).notNull(),
    mediaCount: integer("media_count").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("commerce_review_completion_reviewer_uidx").on(
      table.completionId,
      table.reviewerOrganizationId,
    ),
    index("commerce_review_subject_idx").on(table.subjectOrganizationId, table.visibility),
    index("commerce_review_product_idx")
      .on(table.productId, table.visibility)
      .where(sql`product_id IS NOT NULL`),
    /**
     * KEYSET indexes for the four public sorts (A8). Every one is PARTIAL on
     * `visibility = 'visible'`, so a hidden review never enters a public scan at all
     * rather than being filtered out after the fact, and every one ends in `id` —
     * §7's rule that an order must end in a unique column so cursor pagination cannot
     * skip rows with equal sort keys.
     *
     * The pre-existing `commerce_review_subject_idx` is unordered and cannot serve a
     * keyset; it stays because the aggregate in `commerce-trust-metrics.service.ts`
     * uses it.
     */
    index("commerce_review_product_recent_idx")
      .on(table.productId, table.createdAt.desc(), table.id)
      .where(sql`visibility = 'visible' AND product_id IS NOT NULL`),
    index("commerce_review_product_helpful_idx")
      .on(table.productId, table.helpfulCount.desc(), table.id)
      .where(sql`visibility = 'visible' AND product_id IS NOT NULL`),
    index("commerce_review_product_rating_idx")
      .on(table.productId, table.rating.desc(), table.createdAt.desc(), table.id)
      .where(sql`visibility = 'visible' AND product_id IS NOT NULL`),
    index("commerce_review_product_media_idx")
      .on(table.productId, table.createdAt.desc(), table.id)
      .where(sql`visibility = 'visible' AND product_id IS NOT NULL AND media_count > 0`),
    index("commerce_review_subject_recent_idx")
      .on(table.subjectOrganizationId, table.createdAt.desc(), table.id)
      .where(sql`visibility = 'visible'`),
    check("commerce_review_rating_ck", sql`rating BETWEEN 1 AND 5`),
    check("commerce_review_body_ck", sql`char_length(body) BETWEEN 1 AND 4000`),
    check("commerce_review_self_ck", sql`reviewer_organization_id <> subject_organization_id`),
    check("commerce_review_helpful_count_ck", sql`helpful_count >= 0`),
    /**
     * The upper bound mirrors `commerce_review_media_position_ck`. Two constraints
     * stating one rule is deliberate here: the cap is enforced at the counter so a
     * seventh attach fails even if the position sequence has a gap.
     */
    check("commerce_review_media_count_ck", sql`media_count BETWEEN 0 AND 6`),
  ],
);

/**
 * Review photos and video links (STORE Appendix A8).
 *
 * CASCADE, and it is the only cascade in the commerce trust slice. Every other
 * commerce foreign key is `restrict` because an order line, a journal entry or a
 * completion references the row and a delete would erase commercial history. Review
 * media has no downstream reference at all — it is owned wholly by its review — and
 * `restrict` would make a review permanently undeletable. `product_image -> product`
 * made the same call for the same reason.
 *
 * Photos are stored under `qatoto/reviews/`, NEVER under the product folder:
 * `deleteAllProductImages` runs when a seller deletes a listing, and a buyer's
 * testimony must not be destroyed by the party it is testimony about.
 */
export const commerceReviewMedia = pgTable(
  "commerce_review_media",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    reviewId: text("review_id")
      .notNull()
      .references(() => commerceReview.id, { onDelete: "cascade" }),
    mediaKind: commerceReviewMediaKindEnum("media_kind").default("photo").notNull(),
    /** Cloudinary secure URL; NULL for a YouTube link. */
    url: text("url"),
    /** 11-character YouTube id; NULL for an uploaded photo. */
    youtubeVideoId: text("youtube_video_id"),
    /**
     * Measured by sharp from the DECODED bytes, never accepted from the client —
     * the same rule A2 applies to `product_image`. NOT NULL for photos here (unlike
     * `product_image`, where they are nullable only because pre-A2 rows exist).
     */
    widthPx: integer("width_px"),
    heightPx: integer("height_px"),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("commerce_review_media_position_uidx").on(table.reviewId, table.position),
    check("commerce_review_media_position_ck", sql`position BETWEEN 0 AND 5`),
    /**
     * Kind-discriminated supply. A photo carries a URL and measured dimensions; a
     * YouTube link carries an id and neither. Making all four columns independently
     * nullable would admit a photo with no bytes and a video with a width.
     */
    check(
      "commerce_review_media_supply_ck",
      sql`(media_kind = 'photo') = (url IS NOT NULL AND width_px IS NOT NULL AND height_px IS NOT NULL)
          AND (media_kind = 'youtube_video') = (youtube_video_id IS NOT NULL)`,
    ),
    check(
      "commerce_review_media_url_ck",
      sql`url IS NULL OR (url LIKE 'https://%' AND char_length(url) <= 2048)`,
    ),
    check(
      "commerce_review_media_youtube_ck",
      sql`youtube_video_id IS NULL OR youtube_video_id ~ '^[a-zA-Z0-9_-]{11}$'`,
    ),
    check(
      "commerce_review_media_dimensions_ck",
      sql`(width_px IS NULL OR width_px BETWEEN 1 AND 20000)
          AND (height_px IS NULL OR height_px BETWEEN 1 AND 20000)`,
    ),
  ],
);

/**
 * Named sub-scores (STORE Appendix A8) — Service, Shipping, Quality.
 *
 * Composite primary key, no surrogate id: the row IS the `(review, axis)` fact, and
 * a surrogate plus a unique index would state one rule twice. No `createdAt` either
 * — the row is written inside its review's transaction and never changes, so
 * `commerce_review.created_at` is already its timestamp.
 *
 * `shipping` is meaningless on a `service_engagement` completion. That is a
 * cross-table invariant, so it is enforced in `createReview` (which already holds the
 * completion row under a lock) as `UNSUPPORTED_SCORE_AXIS`, not as a fourth trigger.
 */
export const commerceReviewScore = pgTable(
  "commerce_review_score",
  {
    reviewId: text("review_id")
      .notNull()
      .references(() => commerceReview.id, { onDelete: "cascade" }),
    axis: commerceReviewScoreAxisEnum("axis").notNull(),
    score: integer("score").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.reviewId, table.axis] }),
    index("commerce_review_score_axis_idx").on(table.axis, table.reviewId),
    check("commerce_review_score_ck", sql`score BETWEEN 1 AND 5`),
  ],
);

/**
 * Helpful votes (STORE Appendix A8).
 *
 * There is NO `value` column. There is one kind of vote, and a `+1 / -1` integer
 * would smuggle a downvote product decision in as a nullable field. Row presence IS
 * the vote; deleting the row un-votes. This is `video_save` byte for byte.
 *
 * Keyed on the ORGANIZATION, not the user: it mirrors one-review-per-organization
 * (`commerce_review_completion_reviewer_uidx`), makes the self-vote check a column
 * comparison instead of a membership lookup, and caps farming behind the cost of
 * standing up a verified commerce organization.
 */
export const commerceReviewVote = pgTable(
  "commerce_review_vote",
  {
    reviewId: text("review_id")
      .notNull()
      .references(() => commerceReview.id, { onDelete: "cascade" }),
    voterOrganizationId: text("voter_organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    voterMemberId: text("voter_member_id")
      .notNull()
      .references(() => commerceOrganizationMember.id, { onDelete: "restrict" }),
    voterUserId: text("voter_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.reviewId, table.voterOrganizationId] }),
    index("commerce_review_vote_organization_idx").on(table.voterOrganizationId, table.createdAt),
  ],
);

/**
 * A helpful vote on a product answer (STORE Appendix A24).
 *
 * `commerceReviewVote` above, byte for byte, and for its reasons: row presence is the
 * vote, so there is no `id` and no `value`; the key is the ORGANIZATION, so one
 * procurement team does not get five votes because it has five logins.
 *
 * `commerce_product_answer_vote_relationship_guard` refuses a vote from the answer's
 * own author organization and a `voterMemberId` belonging to a different organization.
 * The service refuses the first case too — that produces a useful 403; the trigger is
 * what makes the rule true.
 */
export const commerceProductAnswerVote = pgTable(
  "commerce_product_answer_vote",
  {
    answerId: text("answer_id")
      .notNull()
      .references(() => commerceProductAnswer.id, { onDelete: "cascade" }),
    voterOrganizationId: text("voter_organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    voterMemberId: text("voter_member_id")
      .notNull()
      .references(() => commerceOrganizationMember.id, { onDelete: "restrict" }),
    voterUserId: text("voter_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.answerId, table.voterOrganizationId] }),
    index("commerce_product_answer_vote_organization_idx").on(
      table.voterOrganizationId,
      table.createdAt,
    ),
  ],
);

/**
 * The subject organization's public reply (STORE Appendix A8).
 *
 * `reviewId` is the PRIMARY KEY, not a surrogate id with a unique index — "one reply
 * per review" becomes unrepresentable rather than merely rejected.
 *
 * No `visibility` column: a reply only ever renders beside its review, so hiding the
 * review hides the reply. One visibility flag means one place to get it wrong.
 */
export const commerceReviewReply = pgTable(
  "commerce_review_reply",
  {
    reviewId: text("review_id")
      .primaryKey()
      .references(() => commerceReview.id, { onDelete: "cascade" }),
    responderOrganizationId: text("responder_organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    responderMemberId: text("responder_member_id")
      .notNull()
      .references(() => commerceOrganizationMember.id, { onDelete: "restrict" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("commerce_review_reply_organization_idx").on(
      table.responderOrganizationId,
      table.createdAt,
    ),
    check("commerce_review_reply_body_ck", sql`char_length(body) BETWEEN 1 AND 2000`),
  ],
);

/**
 * A buyer's pre-sales inquiry about one listing (STORE Appendix A14).
 *
 * THIS TABLE EXISTS TO KEEP `commerce_thread_resource_uidx` CORRECT.
 *
 * The obvious design — add `product` to `commerce_thread_resource_kind` and point the
 * thread at the product — collides with that unique index on
 * `(resource_kind, resource_id)` and yields ONE THREAD PER PRODUCT ACROSS ALL BUYERS.
 * `assertThreadParticipant` would then admit every buyer organization that ever
 * inquired and hand each of them every other buyer's negotiation. That is a
 * cross-tenant leak against §11, not a UX wart. With an inquiry row the index is right
 * without modification: one thread per inquiry, one inquiry per (product, buyer).
 *
 * It also sidesteps a migration hazard. Keying on the product would need partial-index
 * predicates naming a newly `ADD VALUE`'d enum literal, and an enum→text cast is not
 * IMMUTABLE so Postgres rejects it in an index predicate — forcing two `db:migrate`
 * runs across two releases. Here the new enum value appears only in runtime inserts.
 *
 * `convertedToRfqId` records that the inquiry produced an RFQ. The two threads stay
 * SEPARATE and are never merged: an RFQ thread has every invited provider in it, so
 * folding a one-to-one pre-sales conversation into it would expose one seller's
 * chat to its competitors.
 */
export const commerceProductInquiry = pgTable(
  "commerce_product_inquiry",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    productId: text("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "restrict" }),
    buyerOrganizationId: text("buyer_organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    buyerMemberId: text("buyer_member_id")
      .notNull()
      .references(() => commerceOrganizationMember.id, { onDelete: "restrict" }),
    /** Snapshotted at open time so the seller's inbox is one index scan, not a join. */
    sellerOrganizationId: text("seller_organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    convertedToRfqId: text("converted_to_rfq_id").references(() => commerceRfq.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { precision: 3 })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("commerce_product_inquiry_product_buyer_uidx").on(
      table.productId,
      table.buyerOrganizationId,
    ),
    /** The seller's inquiry inbox — the read a resourceKind filter could never serve. */
    index("commerce_product_inquiry_seller_idx").on(
      table.sellerOrganizationId,
      table.createdAt,
      table.id,
    ),
    index("commerce_product_inquiry_buyer_idx").on(
      table.buyerOrganizationId,
      table.createdAt,
      table.id,
    ),
    /** A seller cannot open a pre-sales inquiry on its own listing. */
    check(
      "commerce_product_inquiry_parties_ck",
      sql`buyer_organization_id <> seller_organization_id`,
    ),
  ],
);

/**
 * "Can you make this?" — the manufacturer directory's inquiry (Phase 17, §16.5).
 *
 * WHY NOT `commerceProductInquiry` ABOVE: that table requires a `productId` and is
 * uniquely indexed on `(productId, buyerOrganizationId)`. A manufacturing inquiry has no
 * product, which is the whole point of sending it — the thing does not exist yet.
 *
 * WHY NOT `commerceRfq` WITH ONE INVITATION, which was the cheaper option and would have
 * brought the quote-revision flow, expiry and trade attachments for free: an RFQ thread
 * has every invited provider in it, so folding a one-to-one conversation into that shape
 * exposes one factory's chat to its competitors. That is the same reason A14 gives for
 * keeping a pre-sales product inquiry out of the RFQ thread.
 *
 * `capabilityKind` IS NOT NULL and is the one field that decides whether this inquiry is
 * answerable at all. A buyer who needs tooling and writes to an assembly-only shop should
 * learn that from the form, not from silence three weeks later.
 *
 * THE OPTIONAL FIELDS ARE PAIRS AND THE CHECK REFUSES HALF OF ONE. A quantity with no unit
 * cannot be compared against a line; a price with no currency is not a price. A blank
 * input is OMITTED by the client rather than sent as `0`, because `0` for a target unit
 * price asks the factory to work for free.
 */
export const commerceManufacturingInquiry = pgTable(
  "commerce_manufacturing_inquiry",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    /**
     * The handle a buyer reads out on a call. SERVER-MINTED — a client-supplied reference
     * is a client-chosen primary key by another name.
     */
    reference: text("reference").notNull(),
    factoryOrganizationId: text("factory_organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    buyerOrganizationId: text("buyer_organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    buyerMemberId: text("buyer_member_id")
      .notNull()
      .references(() => commerceOrganizationMember.id, { onDelete: "restrict" }),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    state: commerceManufacturingInquiryStateEnum("state").default("draft").notNull(),
    capabilityKind: commerceOrganizationCapabilityKindEnum("capability_kind").notNull(),
    productDescription: text("product_description").notNull(),
    estimatedAnnualQuantity: integer("estimated_annual_quantity"),
    unitLabel: text("unit_label"),
    targetUnitPriceInCents: bigint("target_unit_price_in_cents", { mode: "number" }),
    currency: text("currency"),
    /** A calendar date. A buyer wants delivery "by 30 June", not at an instant. */
    desiredFirstDeliveryAt: date("desired_first_delivery_at", { mode: "string" }),
    notes: text("notes"),
    /**
     * The same escape hatch `commerceProductInquiry` has: an inquiry that grows into real
     * sourcing points at the RFQ it became, and the two conversations stay separate.
     */
    convertedToRfqId: text("converted_to_rfq_id").references(() => commerceRfq.id, {
      onDelete: "set null",
    }),
    /** Opened by the `sent` transition, never at create — a draft notifies nobody. */
    threadId: text("thread_id").references(() => commerceThread.id, { onDelete: "set null" }),
    sentAt: timestamp("sent_at"),
    answeredAt: timestamp("answered_at"),
    closedAt: timestamp("closed_at"),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { precision: 3 })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("commerce_manufacturing_inquiry_reference_uidx").on(table.reference),
    index("commerce_manufacturing_inquiry_buyer_idx").on(
      table.buyerOrganizationId,
      table.createdAt,
      table.id,
    ),
    /**
     * The factory's queue. `state` sits in the key because a factory works `sent` first
     * and never wants a buyer's abandoned drafts in the list — which it cannot see anyway.
     */
    index("commerce_manufacturing_inquiry_factory_idx").on(
      table.factoryOrganizationId,
      table.state,
      table.createdAt,
      table.id,
    ),
    check(
      "commerce_manufacturing_inquiry_pairs_ck",
      sql`(estimated_annual_quantity IS NULL) = (unit_label IS NULL)
          AND (target_unit_price_in_cents IS NULL) = (currency IS NULL)
          AND (estimated_annual_quantity IS NULL OR estimated_annual_quantity > 0)
          AND (target_unit_price_in_cents IS NULL OR target_unit_price_in_cents > 0)
          AND (currency IS NULL OR currency ~ '^[A-Z]{3}$')`,
    ),
    check(
      "commerce_manufacturing_inquiry_parties_ck",
      sql`buyer_organization_id <> factory_organization_id`,
    ),
    check(
      "commerce_manufacturing_inquiry_text_ck",
      sql`char_length(reference) BETWEEN 6 AND 40
          AND char_length(product_description) BETWEEN 1 AND 5000
          AND (unit_label IS NULL OR char_length(unit_label) BETWEEN 1 AND 40)
          AND (notes IS NULL OR char_length(notes) BETWEEN 1 AND 4000)`,
    ),
    /**
     * EVERY STATE AGREES WITH ITS TIMESTAMP, so no code path can leave a row claiming it
     * was sent with nothing recording when. `answered` implies `sent`; `closed` is
     * reachable from anywhere, including straight from a draft the buyer abandoned.
     */
    check(
      "commerce_manufacturing_inquiry_state_ck",
      sql`(state = 'draft') = (sent_at IS NULL AND answered_at IS NULL AND closed_at IS NULL)
          AND (state = 'closed') = (closed_at IS NOT NULL)
          AND (answered_at IS NULL OR sent_at IS NOT NULL)
          AND (state <> 'sent' OR (sent_at IS NOT NULL AND answered_at IS NULL))
          AND (state <> 'answered' OR answered_at IS NOT NULL)`,
    ),
  ],
);

/**
 * The certifications a buyer needs the factory to hold.
 *
 * OVER THE CLOSED CODE SET, not the free-text standard name, because this is a REQUIREMENT
 * the factory is matched against. Free text here would be unmatchable, which is the
 * opposite of what a requirement is for.
 */
export const commerceManufacturingInquiryCertification = pgTable(
  "commerce_manufacturing_inquiry_certification",
  {
    inquiryId: text("inquiry_id")
      .notNull()
      .references(() => commerceManufacturingInquiry.id, { onDelete: "cascade" }),
    standardCode: commerceCertificationStandardCodeEnum("standard_code").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      name: "commerce_manufacturing_inquiry_certification_pk",
      columns: [table.inquiryId, table.standardCode],
    }),
  ],
);

/**
 * A user-submitted report about commerce content (STORE Appendix A12).
 *
 * FIVE NULLABLE FOREIGN KEYS WITH AN XOR CHECK, not one polymorphic `targetId`. A bare
 * text id carries no referential integrity, so a report could point at a row that
 * never existed, and the moderation queue could not join to show a reviewer WHAT was
 * reported. `research_program_content_report` made the same call for the same reason.
 * The WIRE takes a single `targetId` for transport convenience; storage is XOR.
 *
 * Note the doc correction this table embodies: A12 says commerce reports feed the
 * existing `content_review_action` queue. They cannot — that table's `video_id` is NOT
 * NULL with a cascade to `video`. Hence `commerce_moderation_action` below.
 */
export const commerceContentReport = pgTable(
  "commerce_content_report",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    targetKind: commerceContentTargetKindEnum("target_kind").notNull(),
    productId: text("product_id").references(() => product.id, { onDelete: "cascade" }),
    reviewId: text("review_id").references(() => commerceReview.id, { onDelete: "cascade" }),
    questionId: text("question_id").references(() => commerceProductQuestion.id, {
      onDelete: "cascade",
    }),
    answerId: text("answer_id").references(() => commerceProductAnswer.id, {
      onDelete: "cascade",
    }),
    organizationId: text("organization_id").references(() => commerceOrganization.id, {
      onDelete: "cascade",
    }),
    reason: commerceContentReportReasonEnum("reason").notNull(),
    detailText: text("detail_text"),
    /** SET NULL: a deleted account must not erase the report it filed. */
    reporterUserId: text("reporter_user_id").references(() => user.id, { onDelete: "set null" }),
    /** Optional context. A reporter need not act for an organization. */
    reporterOrganizationId: text("reporter_organization_id").references(
      () => commerceOrganization.id,
      { onDelete: "set null" },
    ),
    status: commerceContentReportStatusEnum("status").default("open").notNull(),
    resolvedByUserId: text("resolved_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    resolvedAt: timestamp("resolved_at", { precision: 3 }),
    resolutionNote: text("resolution_note"),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    /**
     * One report per user per target, per kind. Partial because the target column is
     * null for four of the five kinds on any given row.
     */
    uniqueIndex("commerce_content_report_product_reporter_uidx")
      .on(table.productId, table.reporterUserId)
      .where(sql`product_id IS NOT NULL AND reporter_user_id IS NOT NULL`),
    uniqueIndex("commerce_content_report_review_reporter_uidx")
      .on(table.reviewId, table.reporterUserId)
      .where(sql`review_id IS NOT NULL AND reporter_user_id IS NOT NULL`),
    uniqueIndex("commerce_content_report_question_reporter_uidx")
      .on(table.questionId, table.reporterUserId)
      .where(sql`question_id IS NOT NULL AND reporter_user_id IS NOT NULL`),
    uniqueIndex("commerce_content_report_answer_reporter_uidx")
      .on(table.answerId, table.reporterUserId)
      .where(sql`answer_id IS NOT NULL AND reporter_user_id IS NOT NULL`),
    uniqueIndex("commerce_content_report_organization_reporter_uidx")
      .on(table.organizationId, table.reporterUserId)
      .where(sql`organization_id IS NOT NULL AND reporter_user_id IS NOT NULL`),
    /** The queue, oldest first. */
    index("commerce_content_report_queue_idx").on(table.status, table.createdAt, table.id),
    index("commerce_content_report_target_idx").on(
      table.targetKind,
      table.status,
      table.createdAt,
      table.id,
    ),
    check(
      "commerce_content_report_target_ck",
      sql`num_nonnulls(product_id, review_id, question_id, answer_id, organization_id) = 1
          AND (target_kind = 'product') = (product_id IS NOT NULL)
          AND (target_kind = 'review') = (review_id IS NOT NULL)
          AND (target_kind = 'question') = (question_id IS NOT NULL)
          AND (target_kind = 'answer') = (answer_id IS NOT NULL)
          AND (target_kind = 'organization') = (organization_id IS NOT NULL)`,
    ),
    check(
      "commerce_content_report_detail_ck",
      sql`detail_text IS NULL OR char_length(detail_text) BETWEEN 1 AND 2000`,
    ),
    check(
      "commerce_content_report_resolution_ck",
      sql`(resolved_by_user_id IS NULL) = (resolved_at IS NULL)
          AND (status = 'open') = (resolved_at IS NULL)`,
    ),
  ],
);

/**
 * A moderation decision about commerce content (STORE Appendix A12).
 *
 * Modelled on `research_program_moderation_action`, which exists for exactly this
 * reason: `content_review_action` is video-scoped by construction, and generalizing it
 * would merge two queues gated by DIFFERENT capabilities (`moderate_content` versus
 * `moderate_commerce`) into one table — the coupling capabilities exist to prevent.
 *
 * Target columns are SET NULL rather than cascade: a decision stays on the record
 * after the thing it was about is gone. That is the opposite choice from the report
 * table above, and deliberately so — a report about a deleted product is noise, but a
 * record that staff hid something is exactly what an audit needs to still find.
 */
export const commerceModerationAction = pgTable(
  "commerce_moderation_action",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    actionKind: commerceModerationActionKindEnum("action_kind").notNull(),
    targetKind: commerceContentTargetKindEnum("target_kind").notNull(),
    productId: text("product_id").references(() => product.id, { onDelete: "set null" }),
    reviewId: text("review_id").references(() => commerceReview.id, { onDelete: "set null" }),
    questionId: text("question_id").references(() => commerceProductQuestion.id, {
      onDelete: "set null",
    }),
    answerId: text("answer_id").references(() => commerceProductAnswer.id, {
      onDelete: "set null",
    }),
    organizationId: text("organization_id").references(() => commerceOrganization.id, {
      onDelete: "set null",
    }),
    reportId: text("report_id").references(() => commerceContentReport.id, {
      onDelete: "set null",
    }),
    actionSource: commerceModerationActionSourceEnum("action_source").notNull(),
    moderatorUserId: text("moderator_user_id").references(() => user.id, { onDelete: "restrict" }),
    moderatorRoleSnapshot: text("moderator_role_snapshot"),
    reasonNote: text("reason_note").notNull(),
    /** The hash-chain entry, for staff actions only. An automatic hide has none. */
    auditEntryId: text("audit_entry_id").references(() => platformAuditEntry.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("commerce_moderation_action_audit_uidx")
      .on(table.auditEntryId)
      .where(sql`audit_entry_id IS NOT NULL`),
    index("commerce_moderation_action_timeline_idx").on(table.createdAt, table.id),
    index("commerce_moderation_action_moderator_idx")
      .on(table.moderatorUserId, table.createdAt)
      .where(sql`moderator_user_id IS NOT NULL`),
    index("commerce_moderation_action_report_idx")
      .on(table.reportId)
      .where(sql`report_id IS NOT NULL`),
    /**
     * AT MOST one target, and whichever one is set must agree with `targetKind`.
     *
     * "At most" rather than "exactly" — unlike the report table — because these
     * columns are SET NULL. When the reviewed thing is deleted the row is left with no
     * target at all, and that is the intended end state: the decision survives its
     * subject. `targetKind` still records what KIND of thing it was.
     */
    check(
      "commerce_moderation_action_target_ck",
      sql`num_nonnulls(product_id, review_id, question_id, answer_id, organization_id) <= 1
          AND (product_id IS NULL OR target_kind = 'product')
          AND (review_id IS NULL OR target_kind = 'review')
          AND (question_id IS NULL OR target_kind = 'question')
          AND (answer_id IS NULL OR target_kind = 'answer')
          AND (organization_id IS NULL OR target_kind = 'organization')`,
    ),
    /**
     * The three staff columns travel together, in BOTH directions. An `automatic` row
     * with a moderator would be a lie; a `moderator` row without an audit entry would
     * be an unlogged staff action, which is the thing the chain exists to prevent.
     */
    check(
      "commerce_moderation_action_source_ck",
      sql`(action_source = 'moderator') = (moderator_user_id IS NOT NULL)
          AND (action_source = 'moderator') = (moderator_role_snapshot IS NOT NULL)
          AND (action_source = 'moderator') = (audit_entry_id IS NOT NULL)`,
    ),
    check("commerce_moderation_action_reason_ck", sql`char_length(reason_note) BETWEEN 1 AND 2000`),
    check(
      "commerce_moderation_action_role_ck",
      sql`moderator_role_snapshot IS NULL OR char_length(moderator_role_snapshot) BETWEEN 1 AND 40`,
    ),
  ],
);

export const commerceDispute = pgTable(
  "commerce_dispute",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    orderId: text("order_id")
      .notNull()
      .references(() => commerceOrder.id, { onDelete: "restrict" }),
    openedByOrganizationId: text("opened_by_organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    openedByMemberId: text("opened_by_member_id")
      .notNull()
      .references(() => commerceOrganizationMember.id, { onDelete: "restrict" }),
    buyerOrganizationId: text("buyer_organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    counterpartyOrganizationId: text("counterparty_organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    priorOrderState: commerceOrderStateEnum("prior_order_state").notNull(),
    state: commerceDisputeStateEnum("state").default("open").notNull(),
    reasonCode: text("reason_code").notNull(),
    summary: text("summary").notNull(),
    orderSnapshotJson: text("order_snapshot_json").notNull(),
    decidedByUserId: text("decided_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    decisionNote: text("decision_note"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    decidedAt: timestamp("decided_at"),
  },
  (table) => [
    uniqueIndex("commerce_dispute_open_order_uidx")
      .on(table.orderId)
      .where(sql`state = 'open'`),
    index("commerce_dispute_buyer_idx").on(table.buyerOrganizationId, table.state, table.id),
    index("commerce_dispute_counterparty_idx").on(
      table.counterpartyOrganizationId,
      table.state,
      table.id,
    ),
    index("commerce_dispute_state_idx").on(table.state, table.createdAt, table.id),
    /**
     * A28. The participant list's keyset. The two indexes above stop at
     * `(org, state, id)` and cannot serve `(created_at DESC, id)`; they are kept for the
     * state-scoped lookups they already do.
     */
    index("commerce_dispute_buyer_created_idx").on(
      table.buyerOrganizationId,
      table.createdAt.desc(),
      table.id,
    ),
    index("commerce_dispute_counterparty_created_idx").on(
      table.counterpartyOrganizationId,
      table.createdAt.desc(),
      table.id,
    ),
    check(
      "commerce_dispute_reason_ck",
      sql`char_length(reason_code) BETWEEN 1 AND 80
          AND char_length(summary) BETWEEN 1 AND 4000`,
    ),
    check(
      "commerce_dispute_snapshot_ck",
      sql`char_length(order_snapshot_json) BETWEEN 2 AND 20000
          AND order_snapshot_json LIKE '{%'`,
    ),
    check(
      "commerce_dispute_decision_ck",
      sql`(state = 'open' AND decided_at IS NULL AND decided_by_user_id IS NULL)
          OR (state IN ('closed', 'dismissed')
              AND decided_at IS NOT NULL
              AND decided_by_user_id IS NOT NULL)`,
    ),
    check(
      "commerce_dispute_parties_ck",
      sql`opened_by_organization_id = buyer_organization_id
          AND buyer_organization_id <> counterparty_organization_id`,
    ),
    check(
      "commerce_dispute_prior_state_ck",
      sql`prior_order_state IN ('confirmed', 'in_fulfillment', 'partially_completed', 'completed')`,
    ),
    check(
      "commerce_dispute_prior_snapshot_ck",
      sql`(order_snapshot_json::jsonb->>'state') IS NOT DISTINCT FROM prior_order_state::text`,
    ),
  ],
);

export const commerceDisputeEvent = pgTable(
  "commerce_dispute_event",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    disputeId: text("dispute_id")
      .notNull()
      .references(() => commerceDispute.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    eventKind: commerceDisputeEventKindEnum("event_kind").notNull(),
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "restrict" }),
    note: text("note"),
    occurredAt: timestamp("occurred_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("commerce_dispute_event_sequence_uidx").on(table.disputeId, table.sequence),
    index("commerce_dispute_event_timeline_idx").on(table.disputeId, table.occurredAt),
    check("commerce_dispute_event_sequence_ck", sql`sequence >= 0`),
    check(
      "commerce_dispute_event_note_ck",
      sql`note IS NULL OR char_length(note) BETWEEN 1 AND 4000`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// STORE Phase 14 — the external-connector substrate, negotiated settlement
// agreements, and external escrow sessions.
// ---------------------------------------------------------------------------

/**
 * The registry of external systems this backend may talk to — escrow holders, freight
 * forwarders, insurers, laboratories and FX facilitators.
 *
 * NO SECRET LIVES HERE. `credentialRef` and `webhookSigningSecretRef` name the
 * environment variable that holds the secret; the value stays backend-only (§11).
 *
 * Coverage is a fact about REACHABILITY, not a policy about preference. Nothing in this
 * table selects a provider for anybody — §5's agreement does that, and only when both
 * parties have said so.
 */
export const commerceExternalProvider = pgTable(
  "commerce_external_provider",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    connectorKind: commerceConnectorKindEnum("connector_kind").notNull(),
    /**
     * Stable machine identity, snake_case. Parsed through a closed Zod enum at the
     * adapter boundary rather than being an enum here, so adding a provider is an
     * INSERT plus an adapter, not a migration on every connector kind at once.
     */
    providerSlug: text("provider_slug").notNull(),
    displayName: text("display_name").notNull(),
    state: commerceExternalProviderStateEnum("state").default("draft").notNull(),
    credentialRef: text("credential_ref"),
    webhookSigningSecretRef: text("webhook_signing_secret_ref"),
    supportedCountryCodes: text("supported_country_codes").array().default([]).notNull(),
    supportedCurrencies: text("supported_currencies").array().default([]).notNull(),
    minimumOrderInCents: bigint("minimum_order_in_cents", { mode: "number" }),
    maximumOrderInCents: bigint("maximum_order_in_cents", { mode: "number" }),
    /** Deterministic tie-break when two eligible providers are otherwise equal (§7 ordering). */
    platformRank: integer("platform_rank").default(100).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("commerce_external_provider_slug_uidx").on(table.connectorKind, table.providerSlug),
    index("commerce_external_provider_active_idx")
      .on(table.connectorKind, table.platformRank, table.id)
      .where(sql`state = 'active'`),
    check("commerce_external_provider_slug_ck", sql`provider_slug ~ '^[a-z][a-z0-9_]{1,60}$'`),
    check(
      "commerce_external_provider_display_ck",
      sql`char_length(display_name) BETWEEN 1 AND 200`,
    ),
    /**
     * Element-wise format checks. A CHECK cannot contain a subquery, so `unnest` is
     * unavailable — joining and matching the whole string is the shape that works.
     */
    check(
      "commerce_external_provider_countries_ck",
      sql`cardinality(supported_country_codes) = 0
          OR array_to_string(supported_country_codes, ',') ~ '^[A-Z]{2}(,[A-Z]{2})*$'`,
    ),
    check(
      "commerce_external_provider_currencies_ck",
      sql`cardinality(supported_currencies) = 0
          OR array_to_string(supported_currencies, ',') ~ '^[A-Z]{3}(,[A-Z]{3})*$'`,
    ),
    check(
      "commerce_external_provider_bounds_ck",
      sql`(minimum_order_in_cents IS NULL OR minimum_order_in_cents >= 0)
          AND (maximum_order_in_cents IS NULL OR maximum_order_in_cents >= 0)
          AND (minimum_order_in_cents IS NULL OR maximum_order_in_cents IS NULL
               OR minimum_order_in_cents <= maximum_order_in_cents)`,
    ),
    check("commerce_external_provider_rank_ck", sql`platform_rank >= 0`),
  ],
);

/**
 * Durable outbox for outbound connector commands. Parallel to `commerce_payment_outbox`
 * rather than a widening of it: that table's `transferId` is NOT NULL and its kind enum
 * is payment-only, so generalizing it would have made both lies. The same call Phase 10
 * made for `commerce_content_report` and Phase 12 for organization certifications.
 *
 * A COMMAND POSTS NOTHING TO THE LEDGER. A release request is an intent; only the
 * provider's own event moves a memo balance (§4.4).
 */
export const commerceConnectorOutbox = pgTable(
  "commerce_connector_outbox",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    providerId: text("provider_id")
      .notNull()
      .references(() => commerceExternalProvider.id, { onDelete: "restrict" }),
    connectorKind: commerceConnectorKindEnum("connector_kind").notNull(),
    kind: commerceConnectorOutboxKindEnum("kind").notNull(),
    state: commerceConnectorOutboxStateEnum("state").default("pending").notNull(),
    orderId: text("order_id").references(() => commerceOrder.id, { onDelete: "restrict" }),
    escrowSessionId: text("escrow_session_id").references(
      (): AnyPgColumn => commerceExternalEscrowSession.id,
      { onDelete: "restrict" },
    ),
    escrowMilestoneId: text("escrow_milestone_id").references(
      (): AnyPgColumn => commerceEscrowMilestone.id,
      { onDelete: "restrict" },
    ),
    /** Ours, minted before the call, so a retried worker never looks like a second command. */
    idempotencyKey: text("idempotency_key").notNull(),
    requestPayloadJson: text("request_payload_json").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    lastError: text("last_error"),
    availableAt: timestamp("available_at").defaultNow().notNull(),
    processedAt: timestamp("processed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("commerce_connector_outbox_idempotency_uidx").on(table.idempotencyKey),
    index("commerce_connector_outbox_pending_idx").on(table.state, table.availableAt, table.id),
    index("commerce_connector_outbox_order_idx").on(table.orderId, table.id),
    check("commerce_connector_outbox_attempt_ck", sql`attempt_count >= 0`),
    check(
      "commerce_connector_outbox_payload_ck",
      sql`char_length(request_payload_json) BETWEEN 2 AND 50000
          AND request_payload_json LIKE '{%'`,
    ),
  ],
);

/**
 * Inbound connector event inbox. PERSIST BEFORE PROCESSING; unique
 * `(providerId, providerEventId)` makes replay harmless, which is the only reason a
 * public unauthenticated-by-session webhook route can be safe.
 */
export const commerceConnectorWebhookEvent = pgTable(
  "commerce_connector_webhook_event",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    providerId: text("provider_id")
      .notNull()
      .references(() => commerceExternalProvider.id, { onDelete: "restrict" }),
    connectorKind: commerceConnectorKindEnum("connector_kind").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    eventType: text("event_type").notNull(),
    orderId: text("order_id").references(() => commerceOrder.id, { onDelete: "set null" }),
    escrowSessionId: text("escrow_session_id").references(
      (): AnyPgColumn => commerceExternalEscrowSession.id,
      { onDelete: "set null" },
    ),
    payloadJson: text("payload_json").notNull(),
    receivedAt: timestamp("received_at").defaultNow().notNull(),
    processedAt: timestamp("processed_at"),
    processingError: text("processing_error"),
  },
  (table) => [
    uniqueIndex("commerce_connector_webhook_event_provider_uidx").on(
      table.providerId,
      table.providerEventId,
    ),
    index("commerce_connector_webhook_event_unprocessed_idx")
      .on(table.receivedAt, table.id)
      .where(sql`processed_at IS NULL`),
    index("commerce_connector_webhook_event_order_idx").on(table.orderId, table.id),
    check(
      "commerce_connector_webhook_event_type_ck",
      sql`char_length(event_type) BETWEEN 1 AND 120`,
    ),
    check(
      "commerce_connector_webhook_event_payload_ck",
      sql`char_length(payload_json) BETWEEN 2 AND 50000 AND payload_json LIKE '{%'`,
    ),
  ],
);

/**
 * A settlement term the two parties NEGOTIATED, in the thread they were already talking
 * in. Append-only, exactly like `commerce_quote_revision`: a counter-proposal is a new
 * revision and the previous row goes `superseded`. Nothing here is ever edited.
 *
 * `acceptedByOrganizationId` exists so the self-acceptance rule is STRUCTURAL rather
 * than merely enforced in a service — a proposer accepting its own proposal is not a
 * mutual agreement, and `commerce_settlement_agreement_acceptor_ck` makes it
 * unrepresentable.
 */
export const commerceSettlementAgreement = pgTable(
  "commerce_settlement_agreement",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    threadId: text("thread_id")
      .notNull()
      .references(() => commerceThread.id, { onDelete: "cascade" }),
    buyerOrganizationId: text("buyer_organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    sellerOrganizationId: text("seller_organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    proposedByOrganizationId: text("proposed_by_organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    proposedByMemberId: text("proposed_by_member_id")
      .notNull()
      .references(() => commerceOrganizationMember.id, { onDelete: "restrict" }),
    revisionNumber: integer("revision_number").notNull(),
    supersedesAgreementId: text("supersedes_agreement_id").references(
      (): AnyPgColumn => commerceSettlementAgreement.id,
      { onDelete: "restrict" },
    ),
    externalProviderId: text("external_provider_id")
      .notNull()
      .references(() => commerceExternalProvider.id, { onDelete: "restrict" }),
    escrowFeeBearer: commerceEscrowFeeBearerEnum("escrow_fee_bearer").notNull(),
    currency: text("currency").notNull(),
    totalInCents: bigint("total_in_cents", { mode: "number" }).notNull(),
    state: commerceSettlementAgreementStateEnum("state").default("proposed").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    acceptedAt: timestamp("accepted_at"),
    acceptedByOrganizationId: text("accepted_by_organization_id").references(
      () => commerceOrganization.id,
      { onDelete: "restrict" },
    ),
    acceptedByMemberId: text("accepted_by_member_id").references(
      () => commerceOrganizationMember.id,
      { onDelete: "restrict" },
    ),
    /** Which order consumed it. An agreement is spent once, like a sample credit. */
    consumedByOrderId: text("consumed_by_order_id").references(() => commerceOrder.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("commerce_settlement_agreement_revision_uidx").on(
      table.threadId,
      table.revisionNumber,
    ),
    /**
     * At most ONE live accepted agreement per party pair per thread. Without this, two
     * concurrent acceptances of two revisions would both bind and `confirm` would have
     * to guess which one the buyer meant.
     */
    uniqueIndex("commerce_settlement_agreement_accepted_uidx")
      .on(table.threadId, table.buyerOrganizationId, table.sellerOrganizationId)
      .where(sql`state = 'accepted'`),
    index("commerce_settlement_agreement_buyer_idx").on(
      table.buyerOrganizationId,
      table.state,
      table.id,
    ),
    index("commerce_settlement_agreement_seller_idx").on(
      table.sellerOrganizationId,
      table.state,
      table.id,
    ),
    uniqueIndex("commerce_settlement_agreement_consumed_uidx")
      .on(table.consumedByOrderId)
      .where(sql`consumed_by_order_id IS NOT NULL`),
    check("commerce_settlement_agreement_revision_ck", sql`revision_number >= 1`),
    check("commerce_settlement_agreement_currency_ck", sql`currency ~ '^[A-Z]{3}$'`),
    check("commerce_settlement_agreement_total_ck", sql`total_in_cents > 0`),
    check(
      "commerce_settlement_agreement_parties_ck",
      sql`buyer_organization_id <> seller_organization_id
          AND proposed_by_organization_id IN (buyer_organization_id, seller_organization_id)`,
    ),
    /**
     * The mutual-agreement rule, both directions. An accepted row names its acceptor,
     * a non-accepted row names none, and the acceptor is the OTHER party.
     */
    check(
      "commerce_settlement_agreement_acceptor_ck",
      sql`(state IN ('accepted', 'consumed')
             AND accepted_at IS NOT NULL
             AND accepted_by_organization_id IS NOT NULL
             AND accepted_by_member_id IS NOT NULL
             AND accepted_by_organization_id <> proposed_by_organization_id
             AND accepted_by_organization_id IN (buyer_organization_id, seller_organization_id))
          OR (state NOT IN ('accepted', 'consumed')
             AND accepted_at IS NULL
             AND accepted_by_organization_id IS NULL
             AND accepted_by_member_id IS NULL)`,
    ),
    check(
      "commerce_settlement_agreement_consumed_ck",
      sql`(state = 'consumed') = (consumed_by_order_id IS NOT NULL)`,
    ),
  ],
);

/**
 * The milestone plan a proposal carries. Amounts must sum to the agreement total —
 * enforced by `commerce_settlement_agreement_milestone_sum_trg` in migration 0084,
 * because a CHECK cannot see sibling rows and a half-funded set is not a plan.
 */
export const commerceSettlementAgreementMilestone = pgTable(
  "commerce_settlement_agreement_milestone",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    agreementId: text("agreement_id")
      .notNull()
      .references(() => commerceSettlementAgreement.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    milestoneKind: commerceEscrowMilestoneKindEnum("milestone_kind").notNull(),
    amountInCents: bigint("amount_in_cents", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    releaseConditionNote: text("release_condition_note"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("commerce_settlement_agreement_milestone_uidx").on(
      table.agreementId,
      table.sequence,
    ),
    check("commerce_settlement_agreement_milestone_sequence_ck", sql`sequence >= 1`),
    check("commerce_settlement_agreement_milestone_amount_ck", sql`amount_in_cents > 0`),
    check("commerce_settlement_agreement_milestone_currency_ck", sql`currency ~ '^[A-Z]{3}$'`),
    check(
      "commerce_settlement_agreement_milestone_note_ck",
      sql`release_condition_note IS NULL OR char_length(release_condition_note) BETWEEN 1 AND 2000`,
    ),
  ],
);

/**
 * What each party CLAIMS happened on the `direct_offline` rail. Not an observation and
 * never posted to the journal: Qatoto cannot see a bank wire, and recording a memo entry
 * for money it did not observe would assert a fact from an absence — the same error A16
 * refused when it returned an empty estimate array rather than a zero.
 */
export const commerceSettlementAttestation = pgTable(
  "commerce_settlement_attestation",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    orderId: text("order_id")
      .notNull()
      .references(() => commerceOrder.id, { onDelete: "restrict" }),
    attestedByOrganizationId: text("attested_by_organization_id")
      .notNull()
      .references(() => commerceOrganization.id, { onDelete: "restrict" }),
    attestedByMemberId: text("attested_by_member_id")
      .notNull()
      .references(() => commerceOrganizationMember.id, { onDelete: "restrict" }),
    attestationKind: commerceSettlementAttestationKindEnum("attestation_kind").notNull(),
    amountInCents: bigint("amount_in_cents", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    /** A wire reference or L/C number the parties can reconcile against. Free text, theirs. */
    referenceNote: text("reference_note"),
    occurredAt: timestamp("occurred_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("commerce_settlement_attestation_uidx").on(
      table.orderId,
      table.attestedByOrganizationId,
      table.attestationKind,
    ),
    index("commerce_settlement_attestation_order_idx").on(table.orderId, table.occurredAt),
    check("commerce_settlement_attestation_amount_ck", sql`amount_in_cents > 0`),
    check("commerce_settlement_attestation_currency_ck", sql`currency ~ '^[A-Z]{3}$'`),
    check(
      "commerce_settlement_attestation_note_ck",
      sql`reference_note IS NULL OR char_length(reference_note) BETWEEN 1 AND 500`,
    ),
  ],
);

/**
 * One external escrow session per order. The funds live at the provider; this row is
 * Qatoto's read-only shadow of what the provider says it is holding, and every state
 * here is written from a normalized provider event rather than from our own opinion.
 */
export const commerceExternalEscrowSession = pgTable(
  "commerce_external_escrow_session",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    orderId: text("order_id")
      .notNull()
      .references(() => commerceOrder.id, { onDelete: "restrict" }),
    agreementId: text("agreement_id")
      .notNull()
      .references(() => commerceSettlementAgreement.id, { onDelete: "restrict" }),
    providerId: text("provider_id")
      .notNull()
      .references(() => commerceExternalProvider.id, { onDelete: "restrict" }),
    /** Null until the provider answers `createSession`. */
    providerSessionRef: text("provider_session_ref"),
    /** Where the BUYER funds the session. The provider's page, never ours. */
    hostedActionUrl: text("hosted_action_url"),
    state: commerceEscrowSessionStateEnum("state").default("created").notNull(),
    currency: text("currency").notNull(),
    totalInCents: bigint("total_in_cents", { mode: "number" }).notNull(),
    fundedAt: timestamp("funded_at"),
    releasedAt: timestamp("released_at"),
    refundedAt: timestamp("refunded_at"),
    cancelledAt: timestamp("cancelled_at"),
    disputedAt: timestamp("disputed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("commerce_external_escrow_session_order_uidx").on(table.orderId),
    uniqueIndex("commerce_external_escrow_session_provider_ref_uidx")
      .on(table.providerId, table.providerSessionRef)
      .where(sql`provider_session_ref IS NOT NULL`),
    uniqueIndex("commerce_external_escrow_session_agreement_uidx").on(table.agreementId),
    index("commerce_external_escrow_session_state_idx").on(table.state, table.updatedAt, table.id),
    check("commerce_external_escrow_session_currency_ck", sql`currency ~ '^[A-Z]{3}$'`),
    check("commerce_external_escrow_session_total_ck", sql`total_in_cents > 0`),
    check(
      "commerce_external_escrow_session_url_ck",
      sql`hosted_action_url IS NULL
          OR (char_length(hosted_action_url) BETWEEN 8 AND 2000 AND hosted_action_url LIKE 'https://%')`,
    ),
  ],
);

/**
 * A milestone as the PROVIDER holds it, copied from the agreement plan at session
 * creation so a later agreement revision cannot rewrite money already locked.
 */
export const commerceEscrowMilestone = pgTable(
  "commerce_escrow_milestone",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    sessionId: text("session_id")
      .notNull()
      .references(() => commerceExternalEscrowSession.id, { onDelete: "cascade" }),
    agreementMilestoneId: text("agreement_milestone_id")
      .notNull()
      .references(() => commerceSettlementAgreementMilestone.id, { onDelete: "restrict" }),
    sequence: integer("sequence").notNull(),
    milestoneKind: commerceEscrowMilestoneKindEnum("milestone_kind").notNull(),
    amountInCents: bigint("amount_in_cents", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    state: commerceEscrowMilestoneStateEnum("state").default("planned").notNull(),
    providerMilestoneRef: text("provider_milestone_ref"),
    lockedAt: timestamp("locked_at"),
    verificationSubmittedAt: timestamp("verification_submitted_at"),
    releaseRequestedAt: timestamp("release_requested_at"),
    releasedAt: timestamp("released_at"),
    refundedAt: timestamp("refunded_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("commerce_escrow_milestone_sequence_uidx").on(table.sessionId, table.sequence),
    uniqueIndex("commerce_escrow_milestone_provider_ref_uidx")
      .on(table.sessionId, table.providerMilestoneRef)
      .where(sql`provider_milestone_ref IS NOT NULL`),
    uniqueIndex("commerce_escrow_milestone_agreement_uidx").on(table.agreementMilestoneId),
    index("commerce_escrow_milestone_state_idx").on(table.state, table.id),
    check("commerce_escrow_milestone_sequence_ck", sql`sequence >= 1`),
    check("commerce_escrow_milestone_amount_ck", sql`amount_in_cents > 0`),
    check("commerce_escrow_milestone_currency_ck", sql`currency ~ '^[A-Z]{3}$'`),
    /** A released or refunded milestone must carry the instant it happened. */
    check(
      "commerce_escrow_milestone_terminal_ck",
      sql`(state <> 'released' OR released_at IS NOT NULL)
          AND (state <> 'refunded' OR refunded_at IS NOT NULL)
          AND (released_at IS NULL OR refunded_at IS NULL)`,
    ),
  ],
);

/**
 * What Qatoto sent the provider as proof, and what the provider made of it.
 *
 * `sourceKind` plus `sourceId` point at a record this schema ALREADY keeps — a shipment
 * leg event, an inspection engagement, a completion. Escrow does not get its own private
 * notion of whether a thing shipped; that would be a second source of truth about
 * fulfillment, and the two would drift.
 */
export const commerceEscrowVerification = pgTable(
  "commerce_escrow_verification",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    milestoneId: text("milestone_id")
      .notNull()
      .references(() => commerceEscrowMilestone.id, { onDelete: "cascade" }),
    sourceKind: commerceEscrowVerificationSourceEnum("source_kind").notNull(),
    sourceId: text("source_id").notNull(),
    submittedAt: timestamp("submitted_at").defaultNow().notNull(),
    /** Null until the provider rules. NOT a local decision — we do not grade our own evidence. */
    providerAccepted: boolean("provider_accepted"),
    providerNote: text("provider_note"),
  },
  (table) => [
    uniqueIndex("commerce_escrow_verification_uidx").on(
      table.milestoneId,
      table.sourceKind,
      table.sourceId,
    ),
    index("commerce_escrow_verification_milestone_idx").on(table.milestoneId, table.submittedAt),
    check(
      "commerce_escrow_verification_note_ck",
      sql`provider_note IS NULL OR char_length(provider_note) BETWEEN 1 AND 2000`,
    ),
  ],
);

export const productRelations = relations(product, ({ one, many }) => ({
  // `seller: one(user, …)` is gone with the legacy `sellerId` column (migration 0088).
  // `createdByUser` below is the surviving link to a person; ownership is the organization.
  sellerOrganization: one(commerceOrganization, {
    fields: [product.sellerOrganizationId],
    references: [commerceOrganization.id],
  }),
  createdByUser: one(user, {
    fields: [product.createdByUserId],
    references: [user.id],
  }),
  commerceCategory: one(commerceCategory, {
    fields: [product.categoryId],
    references: [commerceCategory.id],
  }),
  images: many(productImage),
  pricingTiers: many(productPricingTier),
  specifications: many(commerceProductSpecification),
  variants: many(commerceProductVariant),
  highlights: many(commerceProductHighlight),
}));

export const commerceOrganizationRelations = relations(commerceOrganization, ({ one, many }) => ({
  createdByUser: one(user, {
    fields: [commerceOrganization.createdByUserId],
    references: [user.id],
  }),
  members: many(commerceOrganizationMember),
  addresses: many(commerceOrganizationAddress),
  encryptedDocuments: many(commerceEncryptedDocument),
  verifications: many(commerceOrganizationVerification),
  auditEntries: many(commerceOrganizationAuditEntry),
  products: many(product),
  providerProfile: one(commerceProviderProfile, {
    fields: [commerceOrganization.id],
    references: [commerceProviderProfile.organizationId],
  }),
  activeSessions: many(session),
}));

export const commerceOrganizationMemberRelations = relations(
  commerceOrganizationMember,
  ({ one }) => ({
    organization: one(commerceOrganization, {
      fields: [commerceOrganizationMember.organizationId],
      references: [commerceOrganization.id],
    }),
    user: one(user, {
      fields: [commerceOrganizationMember.userId],
      references: [user.id],
    }),
    invitedByUser: one(user, {
      fields: [commerceOrganizationMember.invitedByUserId],
      references: [user.id],
    }),
  }),
);

export const commerceOrganizationAddressRelations = relations(
  commerceOrganizationAddress,
  ({ one }) => ({
    organization: one(commerceOrganization, {
      fields: [commerceOrganizationAddress.organizationId],
      references: [commerceOrganization.id],
    }),
    createdByUser: one(user, {
      fields: [commerceOrganizationAddress.createdByUserId],
      references: [user.id],
    }),
  }),
);

export const commerceEncryptedDocumentRelations = relations(
  commerceEncryptedDocument,
  ({ one, many }) => ({
    organization: one(commerceOrganization, {
      fields: [commerceEncryptedDocument.organizationId],
      references: [commerceOrganization.id],
    }),
    uploadedByUser: one(user, {
      fields: [commerceEncryptedDocument.uploadedByUserId],
      references: [user.id],
    }),
    verifications: many(commerceOrganizationVerification),
  }),
);

export const commerceOrganizationVerificationRelations = relations(
  commerceOrganizationVerification,
  ({ one }) => ({
    organization: one(commerceOrganization, {
      fields: [commerceOrganizationVerification.organizationId],
      references: [commerceOrganization.id],
    }),
    evidenceDocument: one(commerceEncryptedDocument, {
      fields: [commerceOrganizationVerification.evidenceDocumentId],
      references: [commerceEncryptedDocument.id],
    }),
    submittedByUser: one(user, {
      fields: [commerceOrganizationVerification.submittedByUserId],
      references: [user.id],
    }),
    reviewedByUser: one(user, {
      fields: [commerceOrganizationVerification.reviewedByUserId],
      references: [user.id],
    }),
  }),
);

export const commerceCategoryRelations = relations(commerceCategory, ({ one, many }) => ({
  parentCategory: one(commerceCategory, {
    fields: [commerceCategory.parentCategoryId],
    references: [commerceCategory.id],
    relationName: "commerceCategoryHierarchy",
  }),
  childCategories: many(commerceCategory, { relationName: "commerceCategoryHierarchy" }),
  products: many(product),
}));

export const commerceCategoryRequestRelations = relations(commerceCategoryRequest, ({ one }) => ({
  requestedByUser: one(user, {
    fields: [commerceCategoryRequest.requestedByUserId],
    references: [user.id],
    relationName: "commerceCategoryRequestAuthor",
  }),
  reviewedByUser: one(user, {
    fields: [commerceCategoryRequest.reviewedByUserId],
    references: [user.id],
    relationName: "commerceCategoryRequestReviewer",
  }),
  requestedOrganization: one(commerceOrganization, {
    fields: [commerceCategoryRequest.requestedOrganizationId],
    references: [commerceOrganization.id],
  }),
  proposedParentCategory: one(commerceCategory, {
    fields: [commerceCategoryRequest.proposedParentCategoryId],
    references: [commerceCategory.id],
    relationName: "commerceCategoryRequestProposedParent",
  }),
  resultingCategory: one(commerceCategory, {
    fields: [commerceCategoryRequest.resultingCategoryId],
    references: [commerceCategory.id],
    relationName: "commerceCategoryRequestResult",
  }),
}));

export const commerceOrganizationAuditEntryRelations = relations(
  commerceOrganizationAuditEntry,
  ({ one }) => ({
    organization: one(commerceOrganization, {
      fields: [commerceOrganizationAuditEntry.organizationId],
      references: [commerceOrganization.id],
    }),
    actorUser: one(user, {
      fields: [commerceOrganizationAuditEntry.actorUserId],
      references: [user.id],
    }),
  }),
);

export const productImageRelations = relations(productImage, ({ one }) => ({
  product: one(product, { fields: [productImage.productId], references: [product.id] }),
  variant: one(commerceProductVariant, {
    fields: [productImage.variantId],
    references: [commerceProductVariant.id],
  }),
}));

export const productPricingTierRelations = relations(productPricingTier, ({ one }) => ({
  product: one(product, { fields: [productPricingTier.productId], references: [product.id] }),
  variant: one(commerceProductVariant, {
    fields: [productPricingTier.variantId],
    references: [commerceProductVariant.id],
  }),
}));

// --- Phase 8 catalog depth relations (Appendix A1, A6, A7). Child-side only.

export const commerceProductVariantRelations = relations(
  commerceProductVariant,
  ({ one, many }) => ({
    product: one(product, {
      fields: [commerceProductVariant.productId],
      references: [product.id],
    }),
    images: many(productImage),
    pricingTiers: many(productPricingTier),
  }),
);

export const commerceProductHighlightRelations = relations(commerceProductHighlight, ({ one }) => ({
  product: one(product, {
    fields: [commerceProductHighlight.productId],
    references: [product.id],
  }),
}));

export const commerceProductRelationRelations = relations(commerceProductRelation, ({ one }) => ({
  fromProduct: one(product, {
    fields: [commerceProductRelation.fromProductId],
    references: [product.id],
    relationName: "productRelationFrom",
  }),
  toProduct: one(product, {
    fields: [commerceProductRelation.toProductId],
    references: [product.id],
    relationName: "productRelationTo",
  }),
  createdByOrganization: one(commerceOrganization, {
    fields: [commerceProductRelation.createdByOrganizationId],
    references: [commerceOrganization.id],
  }),
}));

export const storePathwayRelations = relations(storePathway, ({ one, many }) => ({
  anchorProduct: one(product, {
    fields: [storePathway.anchorProductId],
    references: [product.id],
  }),
  ownerOrganization: one(commerceOrganization, {
    fields: [storePathway.ownerOrganizationId],
    references: [commerceOrganization.id],
  }),
  slots: many(storePathwaySlot),
}));

export const storePathwaySlotRelations = relations(storePathwaySlot, ({ one, many }) => ({
  pathway: one(storePathway, {
    fields: [storePathwaySlot.pathwayId],
    references: [storePathway.id],
  }),
  candidates: many(storePathwaySlotCandidate),
}));

export const storePathwaySlotCandidateRelations = relations(
  storePathwaySlotCandidate,
  ({ one }) => ({
    slot: one(storePathwaySlot, {
      fields: [storePathwaySlotCandidate.slotId],
      references: [storePathwaySlot.id],
    }),
    product: one(product, {
      fields: [storePathwaySlotCandidate.productId],
      references: [product.id],
    }),
    variant: one(commerceProductVariant, {
      fields: [storePathwaySlotCandidate.variantId],
      references: [commerceProductVariant.id],
    }),
  }),
);

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
    // The NORMALIZED url — credentials and fragment stripped by src/lib/external-link.ts,
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
     * CURSOR (§11h), and `src/lib/daily-log-cursor.ts` encodes it as `getTime()` —
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
// step 2 is explicit that it earns zero. See src/lib/verdict.ts.
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
 * representation at all. See src/lib/slice-math.ts `unpaidRateCentsPerHour`.
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
    // happens only in src/lib/slice-math.ts.
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
    // The pure verdict function's output (src/lib/verdict.ts), constrained to the three
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
    // (see src/lib/daily-log-cursor.ts). This column is written as `now() + interval`, so
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
 * (`fairMarketRate − paidCash`, src/lib/slice-math.ts). This table is what the member is
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

// ---------------------------------------------------------------------------
// Request idempotency (R_AND_D_BACKEND_STRUCTURE.md §11l.2 item 3).
//
// FOUR SURFACES ALREADY TAKE A BODY-CARRIED KEY — daily-log submit, effort claim,
// physical receipt, payment record — each with its own column and its own unique
// index. That shape is right where it is: the key is part of the domain row, and
// the index is the race-safe authority.
//
// It does not generalize. `POST /funding-rounds/:id/pledges` records a commitment,
// `/finalize` freezes a statement, `/dispute` freezes somebody's slices — and none
// of them has anywhere natural to put a key. Adding a column and a partial unique
// index to each is a migration per verb, and the list keeps growing.
//
// So: one table, keyed on `(user_id, idempotency_key)`, storing the RESPONSE. A
// replay returns the original status and body rather than re-running the write.
// The frontend already mints a key per attempt (`src/lib/rnd/idempotency.ts`) and
// the endpoints above ignore it.
//
// `request_fingerprint` is what stops a key from being reused for a DIFFERENT
// request. Without it a client that recycles one key across two pledges gets the
// first pledge's receipt for the second and believes both landed.
// ---------------------------------------------------------------------------

export const idempotencyRecord = pgTable(
  "idempotency_record",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    // Scoped to the CALLER, not global. Two people may legitimately pick the same
    // key, and a global unique index would let either one see the other's response.
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    requestMethod: text("request_method").notNull(),
    /** The concrete path, so one key cannot be replayed against a different route. */
    requestPath: text("request_path").notNull(),
    /** SHA-256 of the canonicalized body. Hex, 64 chars. */
    requestFingerprint: text("request_fingerprint").notNull(),
    responseStatus: integer("response_status").notNull(),
    responseBody: text("response_body").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idempotency_record_userId_key_unq").on(table.userId, table.idempotencyKey),
    // For the retention sweep. A replay cache is not a ledger and must not grow forever.
    index("idempotency_record_createdAt_idx").on(table.createdAt),
    check("idempotency_record_key_ck", sql`char_length(idempotency_key) BETWEEN 8 AND 200`),
    check("idempotency_record_fingerprint_ck", sql`request_fingerprint ~ '^[0-9a-f]{64}$'`),
    // 2xx only. Recording a failure would make a retry after a transient 500 replay the
    // 500 forever, which is the opposite of what a retry is for.
    check("idempotency_record_status_ck", sql`response_status BETWEEN 200 AND 299`),
  ],
);

// ---------------------------------------------------------------------------
// The PLATFORM audit chain (R_AND_D_BACKEND_STRUCTURE.md §11l.2 item 2).
//
// WHY A SECOND CHAIN. `project_audit_entry` hangs off `project_chain_head`, which
// is keyed by project — correctly, because a slice award, a rate lock and a
// statement all belong to one. A moderator approving a category, merging two
// clusters or rewriting the supplier directory belongs to NO project, and until
// now that meant it belonged to nothing: `requirePlatformCapability` gated 25 call
// sites and not one of them recorded that a decision had been made.
//
// The cluster merge is the sharpest case. `discovery-moderation.service.ts`
// re-points every link and downgrades `origin` to `founder_declared`, and the code
// itself calls that irreversible. It left no trace of who decided it.
//
// SAME DISCIPLINE AS §9's CHAIN, deliberately: one lock, a gapless sequence, a
// canonical-JSON hash over a fixed field set, and append-only enforced by TRIGGERS
// rather than by service discipline (§4f). The differences are two, and both
// follow from there being no project:
//
//   * `actorUserId` is NOT NULL. A platform action always has a human behind it —
//     there is no nightly job that approves a category. `project_audit_entry`
//     allows null because the verification pipeline and the sweep are system
//     actors there.
//   * The head is a SINGLETON row rather than one per project, pinned by a CHECK
//     to a single id. Serializing every moderation decision behind one lock is
//     acceptable precisely because there are few of them and they are typed by
//     hand; a project's ledger could not tolerate it.
// ---------------------------------------------------------------------------

export const platformAuditEventKindEnum = pgEnum("platform_audit_event_kind", [
  // Taxonomy and vocabulary — `discovery-moderation` and `discovery-vocabulary`.
  "taxonomy_category_approved",
  "taxonomy_category_rejected",
  "cluster_merge_approved",
  "cluster_merge_rejected",
  "discovery_skill_created",
  "discovery_skill_updated",
  "discovery_skill_deleted",
  "discovery_region_created",
  "discovery_region_updated",
  "discovery_region_deleted",
  // The knowledge hub — `market-insights`.
  "market_insight_created",
  "market_insight_updated",
  "market_insight_deleted",
  "market_insight_published",
  "market_insight_unpublished",
  // The public supplier directory — `suppliers`.
  "supplier_created",
  "supplier_updated",
  // Content moderation — `content-review`.
  "content_review_approved",
  "content_review_rejected",
  // Who made this person a moderator, and when. Granted out of band by
  // `pnpm db:grant-platform-role`, which wrote nothing at all before this.
  "platform_role_granted",
  "platform_role_revoked",
  // Research programs — `research-program-moderation` (§10). A program is public UGC
  // at scale, so every decision that publishes it, hides a post or rejects a paper
  // lands here. These are the only §10 rows in this chain: a branch edit or a paper
  // upload is an ordinary member action with no staff behind it, and recording those
  // would drown the entries that name an accountable human.
  "research_program_published",
  "research_program_rejected",
  "research_program_paper_approved",
  "research_program_paper_rejected",
  "research_program_paper_needs_changes",
  "research_program_post_hidden",
  "research_program_post_restored",
  "research_program_report_dismissed",
  // The home-page promotional carousel — `promotions`. Every one of these puts a
  // link in front of every visitor to the front page, or takes one away, so all
  // five mutations are named here rather than only the destructive ones.
  "promotional_slide_created",
  "promotional_slide_updated",
  "promotional_slide_reordered",
  "promotional_slide_image_replaced",
  "promotional_slide_deleted",
  // The home-page Spotlight rail — up to three admin-picked catalogue videos. One event
  // because the only write is a whole-set replace (never a per-slot create/update).
  "spotlight_slots_replaced",
  // Commerce content moderation — `commerce-content-reports` (Appendix A12). Staff
  // decisions only. An AUTOMATIC threshold hide never reaches this chain: this table's
  // `actorUserId` is NOT NULL because every entry must name an accountable human, and
  // a hide triggered by three reporters names nobody. Those are recorded in
  // `commerce_moderation_action` with `actionSource = 'automatic'` instead, which is
  // why that column exists.
  "commerce_content_hidden",
  "commerce_content_restored",
  "commerce_content_report_dismissed",
  "commerce_product_moderation_state_changed",
  // The browse taxonomy — `commerce-categories` (migration 0098). Every mutation is
  // named, not just the destructive ones, for the same reason the promotional carousel
  // is: a category is a front-of-store surface, and renaming or reordering one changes
  // what every visitor sees. `retired` rather than `deleted` because a category with
  // listings cannot be removed.
  "commerce_category_created",
  "commerce_category_updated",
  "commerce_category_reordered",
  "commerce_category_image_replaced",
  "commerce_category_retired",
  // A seller's request for a category that does not exist yet. The VERDICTS are here;
  // submitting one is an ordinary member action with no staff behind it, and recording
  // those would drown the entries that name an accountable human.
  "commerce_category_request_approved",
  "commerce_category_request_rejected",
  // Site audits — `commerce-seller-profile` (Phase 17, §16.2). Both verdicts are here
  // because `site_audited` is the strongest claim this platform makes about a factory,
  // and a claim of that weight must name the human who made it and the human who
  // retracted it. Nothing else in Phase 17 is staff-written.
  "commerce_organization_site_audit_recorded",
  "commerce_organization_site_audit_withdrawn",
  // The business forum — `community-forum` (Phase 18, §17.4). Staff decisions only. An
  // ordinary member posting a thread or endorsing a reply is deliberately absent: recording
  // those would drown the entries that name an accountable human, the same call §10 made.
  "community_forum_thread_published",
  "community_forum_thread_rejected",
  "community_forum_thread_locked",
  "community_forum_thread_unlocked",
  "community_forum_reply_hidden",
  "community_forum_reply_restored",
  "community_content_report_dismissed",
  // The cofounder directory (Phase 19, §18.3). Publishing a profile puts a named person in
  // front of every visitor, so the verdict names the moderator who made it.
  "community_cofounder_profile_published",
  "community_cofounder_profile_rejected",
  // Lane rate cards and customs dwell (Phase 20, §19.2–§19.3). EVERY mutation is named,
  // the `commerce_category_*` posture, because a rate card is a number a BUYER is shown —
  // §19.6 puts its provenance on the wire — and a price that moved with no named human
  // behind it is the one thing this chain exists to make impossible.
  //
  // A SUPERSESSION EMITS NO KIND OF ITS OWN. It is a consequence of a create, not a second
  // decision, and its predecessor id rides in that entry's payload. Two entries would claim
  // two decisions were made.
  "commerce_freight_rate_card_created",
  "commerce_freight_rate_card_window_shortened",
  "commerce_freight_rate_card_withdrawn",
  // Two kinds, not one: a REPLACE destroys prices and an APPEND does not. The audit list
  // filters by `eventKind`, and collapsing them would hide the destructive half.
  "commerce_freight_rate_break_added",
  "commerce_freight_rate_breaks_replaced",
  "commerce_customs_dwell_estimate_created",
  "commerce_customs_dwell_estimate_retired",
]);

/**
 * The singleton head. One row, one lock, one sequence.
 *
 * `id` is pinned to `'global'` by a CHECK rather than left free: a second row would
 * be a second chain, and two chains over one table is a chain nobody can walk.
 */
export const platformChainHead = pgTable(
  "platform_chain_head",
  {
    id: text("id").primaryKey().default("global"),
    lastAuditSequenceNumber: integer("last_audit_sequence_number").default(0).notNull(),
    headEntryHash: text("head_entry_hash"),
    headEntryId: text("head_entry_id"),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  () => [
    check("platform_chain_head_singleton_ck", sql`id = 'global'`),
    check(
      "platform_chain_head_sequence_ck",
      sql`last_audit_sequence_number >= 0
          AND (last_audit_sequence_number = 0) = (head_entry_hash IS NULL)
          AND (head_entry_hash IS NULL OR head_entry_hash ~ '^[0-9a-f]{64}$')`,
    ),
  ],
);

export const platformAuditEntry = pgTable(
  "platform_audit_entry",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    sequenceNumber: integer("sequence_number").notNull(),
    eventKind: platformAuditEventKindEnum("event_kind").notNull(),
    // NOT NULL, unlike the project chain's. See the block comment above.
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    /** The role AT THE TIME. A snapshot, never a join — roles are revocable. */
    actorRoleSnapshot: text("actor_role_snapshot").notNull(),
    actionLabel: text("action_label").notNull(),
    targetLabel: text("target_label").notNull(),
    detailNote: text("detail_note").default("").notNull(),
    /** Canonical JSON. TEXT, not jsonb — jsonb reorders keys and the hash would move. */
    payloadJson: text("payload_json").notNull(),
    occurredAt: timestamp("occurred_at").notNull(),
    previousEntryHash: text("previous_entry_hash"),
    entryHash: text("entry_hash").notNull(),
    hashAlgorithmVersion: text("hash_algorithm_version").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("platform_audit_entry_sequence_unq").on(table.sequenceNumber),
    index("platform_audit_entry_occurredAt_idx").on(table.occurredAt, table.id),
    index("platform_audit_entry_eventKind_idx").on(table.eventKind, table.sequenceNumber),
    index("platform_audit_entry_actorUserId_idx").on(table.actorUserId, table.sequenceNumber),
    check("platform_audit_entry_sequence_ck", sql`sequence_number >= 1`),
    check("platform_audit_entry_hash_ck", sql`entry_hash ~ '^[0-9a-f]{64}$'`),
    // The genesis rule: entry 1 has no predecessor and every other entry has one.
    check(
      "platform_audit_entry_link_ck",
      sql`(sequence_number = 1) = (previous_entry_hash IS NULL)`,
    ),
    check(
      "platform_audit_entry_labels_ck",
      sql`char_length(action_label) BETWEEN 1 AND 200
          AND char_length(target_label) BETWEEN 1 AND 200
          AND char_length(detail_note) <= 2000`,
    ),
  ],
);

/**
 * A PROPOSED platform role change, awaiting a second admin (§4a Layer 3).
 *
 * WHY A TABLE AND NOT A COLUMN WRITE. Granting a staff role over HTTP used to be one
 * request by one admin. `user.platform_role` still cannot be self-granted, but a single
 * admin could promote a second account they control and use that instead — so the
 * self-ban was walked around with two accounts, and one compromised admin session was a
 * platform takeover. Two-person control is the same answer §7A already gives for money:
 * `compensation_period` is finalized by one person and countersigned by another.
 *
 * NOTHING HERE CHANGES A ROLE. `user.platform_role` moves only when a countersign lands,
 * in the same transaction that stamps this row.
 *
 * STATUS IS DERIVED, NOT STORED. Pending is `countersigned_at IS NULL AND cancelled_at IS
 * NULL`. A status column for a state two timestamps already imply is a second source of
 * truth, and they disagree eventually.
 */
export const platformRoleGrantProposal = pgTable(
  "platform_role_grant_proposal",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    // Cascade: a proposal about a deleted account is not a decision anybody can take.
    subjectUserId: text("subject_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Snapshotted at propose time, so a countersign can detect that the role moved
    // underneath it rather than silently overwriting somebody else's decision.
    previousPlatformRole: platformRoleEnum("previous_platform_role"),
    // NULL means REVOKE. The column is nullable on `user` for the same reason.
    nextPlatformRole: platformRoleEnum("next_platform_role"),
    // Restrict, not set-null: the four-eyes check below compares against this id, and a
    // NULL would make the comparison vacuous.
    proposedByUserId: text("proposed_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    proposedAt: timestamp("proposed_at").defaultNow().notNull(),
    proposeNote: text("propose_note").default("").notNull(),
    countersignedAt: timestamp("countersigned_at"),
    countersignedByUserId: text("countersigned_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    countersignNote: text("countersign_note").default("").notNull(),
    cancelledAt: timestamp("cancelled_at"),
    cancelledByUserId: text("cancelled_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
  },
  (table) => [
    index("platform_role_grant_proposal_subject_idx").on(table.subjectUserId, table.id),
    /**
     * ONE LIVE PROPOSAL PER ACCOUNT. Without this, two admins can raise two proposals for
     * the same person and countersign each other's, which is two-person control on paper
     * and one-person control in practice.
     */
    uniqueIndex("platform_role_grant_proposal_one_pending_unq")
      .on(table.subjectUserId)
      .where(sql`countersigned_at IS NULL AND cancelled_at IS NULL`),
    check(
      "platform_role_grant_proposal_decision_ck",
      sql`(countersigned_at IS NULL) = (countersigned_by_user_id IS NULL)
          AND (cancelled_at IS NULL) = (cancelled_by_user_id IS NULL)
          AND NOT (countersigned_at IS NOT NULL AND cancelled_at IS NOT NULL)`,
    ),
    /**
     * FOUR EYES, AT THE COLUMN LEVEL — the whole point of this table.
     *
     * `IS DISTINCT FROM` rather than `<>`, so a NULL cannot make the comparison NULL and
     * let the row through. Three distinct people: the subject cannot propose their own
     * change, the proposer cannot ratify it, and the subject cannot ratify it either.
     * Postgres refuses the row; no service has to remember to.
     */
    check(
      "platform_role_grant_proposal_four_eyes_ck",
      sql`subject_user_id <> proposed_by_user_id
          AND (countersigned_by_user_id IS NULL
               OR countersigned_by_user_id IS DISTINCT FROM proposed_by_user_id)
          AND (countersigned_by_user_id IS NULL
               OR countersigned_by_user_id IS DISTINCT FROM subject_user_id)`,
    ),
    // A proposal that changes nothing is not a decision to ratify.
    check(
      "platform_role_grant_proposal_transition_ck",
      sql`next_platform_role IS DISTINCT FROM previous_platform_role
          AND char_length(propose_note) <= 2000
          AND char_length(countersign_note) <= 2000`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Notifications (R_AND_D_BACKEND_STRUCTURE.md §11l.2 item 1).
//
// WHY THIS TABLE EXISTS. Every state transition in this schema that concerns a
// person other than the actor was, until now, discoverable only by that person
// deciding to look: an invite by opening `/invites/mine`, a finalized statement of
// what they are owed by refreshing a page. Two comments in `rate-limit.ts` already
// assumed a notification system that did not exist.
//
// IT CARRIES KEYS AND IDS, NEVER PROSE. `kind` plus a `payloadJson` of ids and
// integers, exactly as §11h's `disclosureKeys` does and for the same reason: server
// prose ships one language and one currency format to three first-class clients
// (§1, §4d). The client renders the sentence.
//
// `payloadJson` is TEXT, not jsonb — the same choice `project_audit_entry` records:
// jsonb reorders keys, and a payload that reorders is one a client cannot diff and a
// test cannot fixture.
//
// FK ACTIONS DIFFER FROM THE AUDIT TABLES, DELIBERATELY. A notification is a
// courtesy, not evidence: deleting the recipient deletes their notifications
// (`cascade`), where an audit entry holds the actor with `restrict` because the
// ledger must stay explicable. The actor is `set null` for the same reason
// `linkedByUserId` is — the fact that something happened outlives the account that
// did it.
// ---------------------------------------------------------------------------

export const notificationKindEnum = pgEnum("notification_kind", [
  // §5 — team formation.
  "project_invite_received",
  "project_invite_revoked",
  // The inviter's half. An invite is a two-sided conversation and the person who sent it
  // is the one waiting on the answer.
  "project_invite_accepted",
  "project_invite_declined",
  "project_application_received",
  "project_application_accepted",
  "project_application_declined",
  // §7A — the compensation lifecycle. The finalized statement is the product's
  // headline output and was, before this, delivered by hoping somebody refreshed.
  "compensation_agreement_proposed",
  "compensation_agreement_accepted",
  "compensation_agreement_declined",
  "compensation_agreement_withdrawn",
  "compensation_period_finalized",
  "compensation_period_countersigned",
  "compensation_period_superseded",
  "compensation_payment_recorded",
  "compensation_payment_confirmed",
  // §9 — the things that move equity, including the two nobody was ever told about:
  // a dispute freezes another member's slices, and a verdict withholds them.
  "dispute_raised",
  "dispute_resolved",
  "effort_claim_verdict_reached",
  // §10 — a moderator's verdict on something a person submitted. A program sits
  // `pending` and invisible until reviewed, and a paper sits `queued`; in both cases
  // the submitter has no way to learn the answer except by re-checking the page.
  "research_program_published",
  "research_program_rejected",
  "research_program_paper_moderated",
  // §4a — staff roles. A grant was previously silent: nobody was told, and the only
  // record was an audit entry somebody had to think to read. The proposal goes to the
  // other admins because they are who can countersign it; the outcome goes to the
  // subject, who until now could be made a moderator without ever being told.
  "platform_role_change_proposed",
  "platform_role_changed",
]);

/**
 * Delivery state for the OPTIONAL email copy. The in-app row is the notification;
 * email is a second channel that may be absent, and `skipped_unconfigured` says so
 * out loud rather than leaving a row that looks unsent — the same distinction
 * `daily_log_analysis_status` draws for a missing Gemini key.
 */
export const notificationEmailStatusEnum = pgEnum("notification_email_status", [
  "queued",
  "sent",
  "skipped_unconfigured",
  "failed",
]);

export const notification = pgTable(
  "notification",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    recipientUserId: text("recipient_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: notificationKindEnum("kind").notNull(),
    // Nullable because not every notification is about a project, and the §10 program
    // kinds are the first to prove it: `research_program_published` and its two
    // siblings leave this NULL and carry `programId` in `payloadJson` instead. That is
    // the door this column was left open for, walked through without a migration.
    //
    // There is deliberately NO `programId` column. A second nullable FK would make
    // "exactly one of these is set" a CHECK to maintain forever, and the payload
    // already holds ids by contract.
    projectId: text("project_id").references(() => researchProject.id, { onDelete: "cascade" }),
    // NULL for a system actor: a verdict is reached by the pipeline, and a period is
    // opened by a nightly job. Same convention as `project_audit_entry.actorUserId`.
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    /** Canonical JSON of IDS AND INTEGERS. No sentences, no amounts pre-formatted. */
    payloadJson: text("payload_json").default("{}").notNull(),
    readAt: timestamp("read_at"),
    emailStatus: notificationEmailStatusEnum("email_status").default("queued").notNull(),
    emailSentAt: timestamp("email_sent_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    // The keyset index: (recipient, createdAt, id) matches the feed's ORDER BY
    // exactly, ending in a unique column so a page boundary neither duplicates nor
    // skips (§4c rule 4).
    index("notification_recipientUserId_createdAt_idx").on(
      table.recipientUserId,
      table.createdAt,
      table.id,
    ),
    // The unread badge is read on every page load in every client. A partial index
    // keeps it proportional to what is unread rather than to what has ever been sent.
    index("notification_recipientUserId_unread_idx")
      .on(table.recipientUserId, table.createdAt, table.id)
      .where(sql`read_at IS NULL`),
    index("notification_projectId_idx").on(table.projectId, table.id),
    // The delivery job's own queue view.
    index("notification_emailStatus_idx").on(table.emailStatus, table.createdAt),
    check(
      "notification_payload_ck",
      sql`char_length(payload_json) BETWEEN 2 AND 4000 AND payload_json LIKE '{%'`,
    ),
    // A sent email has an instant; anything else does not. Without this a `failed`
    // row can carry a `sent_at` and the delivery report reads as a success.
    check("notification_email_sent_ck", sql`(email_status = 'sent') = (email_sent_at IS NOT NULL)`),
  ],
);

export const notificationRelations = relations(notification, ({ one }) => ({
  recipient: one(user, {
    fields: [notification.recipientUserId],
    references: [user.id],
    relationName: "notificationRecipient",
  }),
  actor: one(user, {
    fields: [notification.actorUserId],
    references: [user.id],
    relationName: "notificationActor",
  }),
  project: one(researchProject, {
    fields: [notification.projectId],
    references: [researchProject.id],
  }),
}));

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

// ---------------------------------------------------------------------------
// Creator Studio video domain. See docs/STUDIO_BACKEND_STRUCTURE.md §0-§13.
//
// APPENDIX A (self-hosted video via Livepeer) IS DEFERRED AND NOT BUILT. Nothing
// below is written by an upload, a transcode webhook or a TUS client, because none
// of those exist. What ships is the YouTube-link path: the creator pastes a URL,
// the server parses it to an 11-character id, proves the video exists with one
// oEmbed call, and stores THE ID. No video bytes ever touch this server.
//
// THREE RULES THAT GOVERN EVERY TABLE BELOW:
//
//  1. ZERO-TRUST (§0). `creatorId`/`ownerId` is ALWAYS req.user.id, never a body
//     field. Media facts (videoSource, uploadStatus, youtubeVideoId, thumbnailUrl)
//     are server-derived; a client that sends one is rejected by `.strict()`.
//     The stored YouTube value is the ID, never the client's URL — every embed URL
//     is rebuilt server-side by src/lib/youtube.ts buildYoutubeEmbedUrl.
//
//  2. THE PROVIDER COLUMNS ARE INTENTIONALLY DEAD. storageProvider, videoAssetId,
//     playbackId and playbackUrl are nullable and written by nothing, and
//     videoSourceEnum already carries a "hosted" variant. That is what makes
//     Appendix A an INSERT rather than a migration — no table drop, no rename.
//     Do not populate them from the YouTube path, and do not delete them.
//
//  3. ONE UI STATUS IS THREE ORTHOGONAL COLUMNS (§4). uploadStatus is the media
//     lifecycle, publishStatus the creator's distribution choice, reviewStatus the
//     moderation verdict. Mixing them into one field permits "published while still
//     processing". The frontend's single badge is DERIVED from the three on read.
//
// NAMES THAT LOOK LIKE NEIGHBOURS BUT ARE NOT — do not merge these:
//   videoOpenRole   is NOT projectOpenRole (§4 R&D). No applications, no equity, no
//                   openRoleStatusEnum; it is a recruiting blurb on a watch page.
//   videoTeamMember is NOT projectMember. It is a display credit, not a membership
//                   with intervals, effort or an equity claim.
//   videoMilestone  is NOT the R&D/escrow milestone. It bears NO money: it is a
//                   roadmap label rendered under a video. The escrow cascade note at
//                   the top of the R&D section does not apply here.
// ---------------------------------------------------------------------------

// Where the bytes live. "youtube" is the only value produced today.
export const videoSourceEnum = pgEnum("video_source", ["youtube", "hosted"]);

// Qatoto-surface visibility. NOTE what this does NOT mean for a YouTube row:
// "private"/"unlisted" hide the row in Qatoto's own lists, they do NOT protect the
// video — the bytes are on youtube.com and anyone with the link can watch. That is
// why "investor_only" is REFUSED for youtube rows (see video_gating_ck below)
// rather than pretended: claiming otherwise would be a false security promise.
export const videoVisibilityEnum = pgEnum("video_visibility", [
  "private",
  "unlisted",
  "public",
  "investor_only",
]);

export const videoTypeEnum = pgEnum("video_type", [
  "pitch",
  "demo",
  "update",
  "ama",
  // The curated branch: never self-publishes, always routes through staff review.
  "anime_episode",
]);

export const videoStageEnum = pgEnum("video_stage", ["idea", "mvp", "scaling", "shipped"]);

// Media lifecycle — SERVER-SET, never the client. A YouTube row is born "ready".
// "uploading"/"processing" belong to the deferred hosted path and never occur today.
// "failed" is reserved for the §5.1 re-check job (also deferred), which flips a row
// when the creator deletes or privates the video on youtube.com after the fact.
export const videoUploadStatusEnum = pgEnum("video_upload_status", [
  "uploading",
  "processing",
  "ready",
  "failed",
]);

export const videoPublishStatusEnum = pgEnum("video_publish_status", [
  "draft",
  "scheduled",
  "published",
]);

// Moderation state. "not_required" for ordinary videos; an anime episode moves to
// "pending" on publish and only a moderator can move it on from there.
export const contentReviewStatusEnum = pgEnum("content_review_status", [
  "not_required",
  "pending",
  "approved",
  "rejected",
]);

export const videoLicenseEnum = pgEnum("video_license", ["standard", "creative_commons"]);

export const shortsRemixEnum = pgEnum("shorts_remix", ["video_and_audio", "audio_only"]);

export const playlistVisibilityEnum = pgEnum("playlist_visibility", [
  "public",
  "unlisted",
  "private",
]);

// DEVIATION FROM SPEC §4, which typed this `text(...).default("date_published_newest")`.
// A text column that only ever holds these six values is the loose modelling CLAUDE.md
// Pattern 1 forbids; an enum makes a seventh value unrepresentable in the database.
// Same reasoning applies to the three enums after it.
export const playlistVideoOrderEnum = pgEnum("playlist_video_order", [
  "date_published_newest",
  "date_published_oldest",
  "date_added_newest",
  "date_added_oldest",
  "manual",
]);

export const animeAudioModeEnum = pgEnum("anime_audio_mode", ["subbed", "dubbed"]);

export const animeSeriesStatusEnum = pgEnum("anime_series_status", [
  "ongoing",
  "completed",
  "hiatus",
]);

export const videoCollaboratorStatusEnum = pgEnum("video_collaborator_status", [
  "invited",
  "accepted",
  "declined",
]);

// The audit log is the record of record for every moderation decision, so a
// free-text verb in it is one typo away from an unqueryable log.
export const contentReviewActionKindEnum = pgEnum("content_review_action_kind", [
  "approve",
  "reject",
]);

// Which provider stored the asset. EVERY ROW IS NULL TODAY (Appendix A).
export const storageProviderEnum = pgEnum("storage_provider", [
  "livepeer",
  "cloudflare",
  "imagekit",
  "self_hosted",
]);

/**
 * The content taxonomy behind the home feed's filter chips and "What's on your mind?"
 * tiles (HOME_BACKEND_STRUCTURE.md §2).
 *
 * A TABLE, NOT A pgEnum, for the same reason as researchCategory: categories carry an
 * image and a display order, they are added and retired by product decision rather than
 * by schema change, and an enum cannot hold an imageUrl.
 *
 * IMAGE NULLABILITY IS LOAD-BEARING, and it deviates from §2's draft on purpose. The
 * seed set has two populations: 12 curated TILES, which have commissioned art, and 11
 * topical CHIPS, which render as a label and have no art in existence. Making imageUrl
 * NOT NULL would force a placeholder onto those 11 — asserting an image that is not
 * real, which is the same class of error as fabricating a zero (§0 Rule 5). Instead the
 * doc's actual invariant, "a tile with no image is a broken tile", is written as the
 * implication below. It is deliberately one-directional: a chip may gain art without
 * being promoted into the curated tile grid.
 */
export const contentCategory = pgTable(
  "content_category",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    // Kebab-case, server-generated, public, and linked the moment it exists — therefore
    // UNWRITABLE after creation. The regex is byte-identical to research_category_slug_ck;
    // §5.1's `?categorySlug=` query parameter must reuse this same literal, or a slug this
    // table accepts becomes one the feed route rejects.
    slug: text("slug").notNull(),
    label: text("label").notNull(),
    // The tile image. NULL for a chip — see the header note.
    imageUrl: text("image_url"),
    // Which of the two home-page surfaces this category was curated for. A tile is
    // rendered as art in the "What's on your mind?" grid; a chip is rendered as a label
    // in the filter row. Both appear in the chip row; only tiles appear in the grid.
    isTile: boolean("is_tile").default(false).notNull(),
    sortOrder: integer("sort_order").notNull(),
    // Retiring a category is `isActive = false`, which is reversible and which
    // video_category's RESTRICT FK is designed around. Deleting one is not.
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("content_category_slug_unq").on(table.slug),
    // The only read pattern: the chip row and the tile grid, both ordered.
    index("content_category_active_order_idx").on(table.isActive, table.sortOrder),
    check("content_category_slug_ck", sql`slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check("content_category_tile_image_ck", sql`is_tile = false OR image_url IS NOT NULL`),
  ],
);

// A video, owned by exactly one creator.
export const video = pgTable(
  "video",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    // Owner. Stamped from req.user.id at create — NEVER from the body (§0). Cascade
    // matches product.sellerId: a video bears no ledger, equity or audit weight, so
    // it is a possession that dies with the account rather than a record that must
    // outlive it. (contentReviewAction.reviewerId is the opposite case — see there.)
    creatorId: text("creator_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),

    // --- Where the video lives ---
    videoSource: videoSourceEnum("video_source").default("youtube").notNull(),
    // The 11-character id, NEVER the raw client URL (§0). NULL only when
    // videoSource = "hosted", which nothing produces today. The format CHECK below
    // is what makes this value safe to interpolate into an outbound oEmbed URL.
    youtubeVideoId: text("youtube_video_id"),
    /**
     * Has the id above been PROVEN to resolve to a public, embeddable video
     * (HOME_BACKEND_STRUCTURE.md §8.3)?
     *
     * THIS FLAG IS NOT A SECURITY BOUNDARY, and confusing it for one would be the
     * dangerous reading. `video_youtube_id_format_ck` below is what closes SSRF, and it
     * applies to every row regardless of this column. This flag answers a different
     * question: does the video exist and will it play?
     *
     * WHY IT EXISTS. Verification used to be synchronous inside createVideo, so a
     * YouTube outage threw away the creator's upload with a 502. Now the id is stored
     * regardless, the row is born a draft with this flag false, and `verify-youtube-video`
     * retries with backoff until it flips. The invariant "no unverified id in a published
     * row" is preserved WITHOUT discarding the upload.
     *
     * THREE READERS ENFORCE IT: publishVideo refuses while false, content-review approve
     * refuses while false, and §4.5's feed candidate pool requires it true. A fourth
     * reader of youtubeVideoId added later must check it too — this comment is the only
     * thing that will tell them.
     *
     * Existing rows were backfilled to true in the migration that added this column:
     * every one of them went through the old synchronous verify.
     */
    isSourceVerified: boolean("is_source_verified").default(false).notNull(),

    // --- Provider-neutral media identity. ALL NULL TODAY (Appendix A, rule 2). ---
    storageProvider: storageProviderEnum("storage_provider"),
    videoAssetId: text("video_asset_id"),
    playbackId: text("playback_id"),
    playbackUrl: text("playback_url"),

    uploadStatus: videoUploadStatusEnum("upload_status").default("ready").notNull(),
    // NULL on every YouTube row: oEmbed returns no duration. That is why the chapter
    // validator's "<= durationSeconds" bound is written as a null-guard and skipped
    // here, rather than as a videoSource check (§6).
    durationSeconds: integer("duration_seconds"),
    // Both NULL for YouTube. The upload modal builds its draft with fileName set to
    // the YouTube URL and fileSizeInBytes 0 — a frontend placeholder, not contract.
    // Those values are DISCARDED, and the create schema has no field to send them in.
    sizeBytes: integer("size_bytes"),
    originalFileName: text("original_file_name"),
    // oEmbed's thumbnail_url (host-allowlisted before it is stored), OR a Cloudinary
    // custom upload. The flag below says which, so DELETE knows whether we own an
    // asset to destroy — without it, deleting a video either orphans a Cloudinary
    // asset or 503s on a box that has no Cloudinary credentials configured.
    thumbnailUrl: text("thumbnail_url"),
    hasCustomThumbnail: boolean("has_custom_thumbnail").default(false).notNull(),

    // --- Details step ---
    title: text("title").notNull(),
    description: text("description"),
    videoType: videoTypeEnum("video_type").default("demo").notNull(),
    stageBadge: videoStageEnum("stage_badge"),
    sectorTags: text("sector_tags").array().notNull().default([]),
    websiteUrl: text("website_url"),
    ctaLabel: text("cta_label"),
    ctaUrl: text("cta_url"),
    linkedinUrl: text("linkedin_url"),
    xProfileUrl: text("x_profile_url"),
    contactEmail: text("contact_email"),
    // Nullable because a draft legitimately has not answered yet. Publishing with it
    // still NULL is refused in the service — for a COPPA-shaped attestation, silently
    // shipping "unanswered" is the failure mode that counts.
    isMadeForKids: boolean("is_made_for_kids"),
    hasAgeRestriction: boolean("has_age_restriction").default(false).notNull(),

    // --- Video elements step (scalar links; repeating groups are child tables) ---
    relatedVideoUrl: text("related_video_url"),
    // Deliberately NOT a foreign key and deliberately NOT client-writable: the pitch
    // domain does not exist yet (§12). Accepting it today would store an unvalidated
    // client string that the eventual FK migration would choke on.
    attachedPitchId: text("attached_pitch_id"),
    hasFundingCallToAction: boolean("has_funding_cta").default(false).notNull(),

    // --- Visibility step ---
    visibility: videoVisibilityEnum("visibility").default("private").notNull(),
    isNdaRequired: boolean("is_nda_required").default(false).notNull(),
    scheduledPublishAt: timestamp("scheduled_publish_at"),

    // --- The three orthogonal status columns (rule 3) ---
    publishStatus: videoPublishStatusEnum("publish_status").default("draft").notNull(),
    publishedAt: timestamp("published_at"),
    reviewStatus: contentReviewStatusEnum("review_status").default("not_required").notNull(),
    rejectionReason: text("rejection_reason"),

    // --- "Show more" advanced fields ---
    license: videoLicenseEnum("license").default("standard").notNull(),
    tags: text("tags").array().notNull().default([]),
    videoLanguage: text("video_language"),
    isEmbeddingAllowed: boolean("is_embedding_allowed").default(true).notNull(),
    areCommentsEnabled: boolean("are_comments_enabled").default(true).notNull(),
    shouldShowLikesCount: boolean("should_show_likes_count").default(true).notNull(),
    hasPaidPromotion: boolean("has_paid_promotion").default(false).notNull(),
    usesAlteredContent: boolean("uses_altered_content"),

    // The long-tail "show more" preferences. DEVIATION FROM SPEC §4, which put these
    // seven in a `jsonb("settings")` bag: this schema has no jsonb column anywhere
    // and rejects jsonb by name for exactly this shape (see the compensation-strand
    // note in the R&D section). An untyped jsonb also reads back as `unknown`, which
    // forces either a banned `as` or a parse on every read. Seven nullable scalars on
    // a table that already carries forty is not the thing that makes it unmanageable.
    captionCertification: text("caption_certification"),
    commentModeration: text("comment_moderation"),
    commentSortOrder: text("comment_sort_order"),
    shortsRemixing: shortsRemixEnum("shorts_remixing"),
    recordingDate: date("recording_date"),
    recordingLocation: text("recording_location"),
    /**
     * DEAD COLUMN. Superseded by `video_category` (HOME_BACKEND_STRUCTURE.md §2.2).
     *
     * Free text, unindexed, and validated by nobody — filtering on it would be a LIKE
     * over a column no schema ever constrained. Every write path was removed when
     * `categoryIds` landed; the read in `toPublicVideo` survives for ONE release so that
     * dropping the column and dropping its last reader are two separate deploys. Doing
     * both at once is how you find out in production that something still read it.
     *
     * `scripts/backfill-video-categories.ts` maps the confident values onto video_category
     * and prints the rest for a human. Remove this column once that list is resolved.
     */
    category: text("category"),

    /**
     * What `GET /feed/search` matches against.
     *
     * GENERATED AND STORED, NOT A TRIGGER AND NOT A JOB. Postgres recomputes it inside the
     * same UPDATE that changes a title, so the index cannot drift from the row it describes
     * and there is no backfill to run, nothing to re-enqueue after a failed job, and no
     * window where an edited title is findable under its old wording.
     *
     * THE THREE WEIGHTS ARE THE RANKING, and `ts_rank_cd` reads them: a title hit (A) must
     * outrank a description hit (C) for the same term, or searching "beni" returns whichever
     * video happens to mention it most rather than the ones named for it. Tags sit between
     * the two — a creator chose them deliberately, which is more signal than prose, and less
     * than the title.
     *
     * IT CANNOT INCLUDE THE CREATOR'S NAME. A generated column may only reference its OWN
     * row, and the handle lives on `"user"`. Creator matching is therefore a separate,
     * lower-ranked term evaluated at query time in `searchVideos` — not an omission.
     *
     * `english`, not `simple`, so "robots" finds "robot". The cost is that the stemmer is
     * language-specific and `videoLanguage` is not consulted; a per-language configuration
     * would mean a different generated expression per row, which a generated column cannot
     * express. One config, chosen for the catalogue that exists.
     *
     * ⚠️ `text_array_to_search_text`, NOT `array_to_string`. A generated expression must be
     * IMMUTABLE, and `array_to_string` is only STABLE — Postgres refuses this column outright
     * ("generation expression is not immutable") if it appears here. The wrapper, created in
     * the same migration, is `array_to_string` narrowed to `text[]`, where the underlying
     * output function genuinely is immutable. The marker is a fact about `text[]`, not a
     * promise being made on behalf of a type that cannot keep it.
     */
    searchDocument: tsvector("search_document").generatedAlwaysAs(
      sql`setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
          setweight(to_tsvector('english', text_array_to_search_text(tags)), 'B') ||
          setweight(to_tsvector('english', coalesce(description, '')), 'C')`,
    ),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("video_creatorId_idx").on(table.creatorId),
    // GIN, not b-tree: `@@` against a tsvector is a containment test over lexemes, which is
    // exactly what an inverted index answers and what a b-tree cannot answer at all.
    index("video_search_document_idx").using("gin", table.searchDocument),
    index("video_publishStatus_idx").on(table.publishStatus),
    // Composite, not two singles: the admin queue filters reviewStatus AND videoType
    // together and nothing filters videoType alone.
    index("video_reviewStatus_videoType_idx").on(table.reviewStatus, table.videoType),
    // INDEXED BUT NOT UNIQUE, on purpose. Two Qatoto rows may legitimately point at
    // one YouTube video — a creator re-listing a demo under a new pitch, or two
    // founders each linking the launch video. Abuse is bounded by the per-user rate
    // limiter on POST /videos, not by a constraint that also blocks the honest case.
    index("video_youtubeVideoId_idx").on(table.youtubeVideoId),
    // Partial on purpose. Postgres treats NULLs as distinct, so a plain unique index
    // over an all-NULL column is harmless today — but the WHERE states the intent,
    // and the intent is what has to survive the switch to self-hosting.
    uniqueIndex("video_asset_unq")
      .on(table.videoAssetId)
      .where(sql`video_asset_id is not null`),
    /**
     * The home feed's candidate pool (HOME_BACKEND_STRUCTURE.md §4.5), as a PARTIAL index.
     *
     * WHY PARTIAL AND NOT A COMPOSITE. Every term in §4.5's static filter is a
     * low-cardinality enum or boolean, so a b-tree leading on them is nearly useless —
     * the planner would scan a huge fraction of the index to find the published rows.
     * Moving the whole static filter into the PREDICATE makes the index *be* the
     * candidate pool: it holds only rows that can ever be served, and its single key
     * column is the one the feed actually ranges and sorts on.
     *
     * THE TRAP, and it fails silently. Postgres uses a partial index only when it can
     * PROVE the query's WHERE implies this predicate. Proof works against literals, not
     * against bound parameters — `review_status = ANY($1)` does not imply
     * `review_status IN ('not_required','approved')` as far as the planner is concerned.
     * The §4.5 query must therefore spell these five terms out literally and identically.
     * Get it wrong and there is no error anywhere; there is just a sequential scan.
     *
     * Built now rather than with §4.5 in phase 3 because CREATE INDEX (drizzle-kit does
     * not emit CONCURRENTLY) takes a lock that blocks every write to this table for the
     * duration. That is free today and a studio outage later.
     */
    index("video_feed_candidate_idx")
      .on(table.publishedAt.desc())
      .where(
        sql`publish_status = 'published'
            AND visibility = 'public'
            AND upload_status = 'ready'
            AND is_source_verified = true
            AND review_status IN ('not_required', 'approved')`,
      ),

    // A youtube row with no id is a dead player; a hosted row has no id by design.
    check("video_source_id_ck", sql`(video_source <> 'youtube') OR (youtube_video_id IS NOT NULL)`),
    // THIS IS A SECURITY CONSTRAINT, not tidiness. The id is interpolated into an
    // outbound oEmbed URL and into every embed URL the system emits; the charset
    // contains no ".", "/", ":", "@" or "%", which is what closes SSRF and injection
    // at the storage layer even if a future write path forgets to parse.
    check(
      "video_youtube_id_format_ck",
      sql`youtube_video_id IS NULL OR youtube_video_id ~ '^[A-Za-z0-9_-]{11}$'`,
    ),
    // Gating a YouTube video is impossible, so the database refuses to record the
    // claim. Enforced in the service on create, PATCH and publish as well; this is
    // the invariant those three checkpoints are trying to preserve, stated once.
    check(
      "video_gating_ck",
      sql`(video_source <> 'youtube') OR (visibility <> 'investor_only' AND is_nda_required = false)`,
    ),
    // A published row with no publishedAt sorts as NULL and is dropped by every feed
    // ORDER BY — published but invisible, with no error anywhere.
    check(
      "video_published_at_ck",
      sql`(publish_status <> 'published') OR (published_at IS NOT NULL)`,
    ),
    check(
      "video_scheduled_at_ck",
      sql`(publish_status <> 'scheduled') OR (scheduled_publish_at IS NOT NULL)`,
    ),
    // The frontend types the rejected badge's reason as non-optional.
    check(
      "video_rejection_reason_ck",
      sql`(review_status <> 'rejected') OR (rejection_reason IS NOT NULL)`,
    ),
    check("video_sector_tags_ck", sql`cardinality(sector_tags) <= 20`),
    check("video_tags_ck", sql`cardinality(tags) <= 30`),
  ],
);

/**
 * Which categories a video is tagged into (HOME_BACKEND_STRUCTURE.md §2). At most three,
 * enforced in the service — a cardinality bound ACROSS rows is not expressible as a table
 * CHECK, and a trigger to fake one buys nothing here.
 *
 * NO `position` COLUMN, deliberately. §4.3 scores topic affinity as the MAX over a video's
 * categories, so there is no primary and no order to preserve. talentProfileSkill and
 * supplierCapabilityLink are the shape precedent, not videoAttachedProduct — that one has a
 * position because it renders as an ordered list.
 */
export const videoCategory = pgTable(
  "video_category",
  {
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "cascade" }),
    // RESTRICT, not cascade, and the asymmetry with videoId is the point: deleting a
    // category that videos still use should fail loudly rather than silently untag them.
    // Retiring one is `isActive = false`, which is reversible.
    categoryId: text("category_id")
      .notNull()
      .references(() => contentCategory.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.videoId, table.categoryId] }),
    // The PK covers video -> categories. This is the reverse: the §5.1 category filter
    // reads category -> videos, and without it that is a sequential scan. Built now
    // because building it later locks the table.
    index("video_category_categoryId_idx").on(table.categoryId, table.videoId),
  ],
);

// Manual chapters. The ordering rules (first at 0, strictly ascending, >= 10s apart,
// >= 3 to render) are validated in the service, where the whole set is visible.
export const videoChapter = pgTable(
  "video_chapter",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "cascade" }),
    startSeconds: integer("start_seconds").notNull(),
    title: text("title").notNull(),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("video_chapter_videoId_idx").on(table.videoId),
    uniqueIndex("video_chapter_position_unq").on(table.videoId, table.position),
    check("video_chapter_start_ck", sql`start_seconds >= 0`),
  ],
);

// Shoppable products. Ownership of each product is re-verified against
// product.sellerId before a row lands here (§0) — the client only ever sends ids.
export const videoAttachedProduct = pgTable(
  "video_attached_product",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "cascade" }),
    productId: text("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    pinnedAtSeconds: integer("pinned_at_seconds"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("video_attached_product_videoId_idx").on(table.videoId),
    uniqueIndex("video_product_unq").on(table.videoId, table.productId),
  ],
);

// Pitch deck / whitepaper PDFs.
export const videoDocument = pgTable(
  "video_document",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    fileName: text("file_name").notNull(),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("video_document_videoId_idx").on(table.videoId)],
);

// Roadmap labels rendered under the video. Bears no money — see the naming note above.
export const videoMilestone = pgTable(
  "video_milestone",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("video_milestone_videoId_idx").on(table.videoId)],
);

// Recruiting blurbs attached to a video. Viewers APPLYING to one is a future feature
// (§12) and lives in the R&D application tables when it lands, not here.
export const videoOpenRole = pgTable(
  "video_open_role",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "cascade" }),
    roleTitle: text("role_title").notNull(),
    roleDescription: text("role_description"),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("video_open_role_videoId_idx").on(table.videoId)],
);

// A display credit on the watch page. `linkedUserId` ties it to a real account when
// one is known; `set null` because deleting a user must never erase the credit itself.
export const videoTeamMember = pgTable(
  "video_team_member",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "cascade" }),
    memberName: text("member_name").notNull(),
    roleLabel: text("role_label"),
    linkedUserId: text("linked_user_id").references(() => user.id, { onDelete: "set null" }),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("video_team_member_videoId_idx").on(table.videoId)],
);

export const videoCollaborator = pgTable(
  "video_collaborator",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "cascade" }),
    invitedEmail: citext("invited_email").notNull(),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    status: videoCollaboratorStatusEnum("status").default("invited").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("video_collaborator_videoId_idx").on(table.videoId),
    // ADDITION TO SPEC §4. One live invite per address per video: re-inviting must be
    // an UPDATE, because two rows leave "accept" with no single row to resolve.
    // citext so "A@x.com" and "a@x.com" are the same invite, matching user.email.
    uniqueIndex("video_collaborator_unq").on(table.videoId, table.invitedEmail),
  ],
);

// ---------------------------------------------------------------------------
// HOME FEED — ENGAGEMENT (HOME_BACKEND_STRUCTURE.md §3)
//
// Everything below is written by VIEWERS, not creators. The creator-owned half of
// the `video` table above is the studio; this half is the public surface reading it.
//
// THE FIVE RULES THIS BLOCK ENCODES, because they are invisible in the DDL otherwise:
//
//   R1. Every byte from a viewer is a CLAIM, not a measurement. The beacon is the only
//       unauthenticated write on the platform, and it is clamped in TS
//       (src/lib/view-beacon-clamp.ts) before any of these columns move.
//   R2. Integers only. `completion_bp_sum` + `completion_sample_count` are stored
//       instead of an average, because an average is a float and a float makes a
//       ranking bug irreproducible.
//   R3. A VIEW IS NOT A WATCH. `view_count` counts arrivals; `completion_bp_sum`
//       measures watching. Only the second one ranks, and only from a signed-in
//       session — see the note on `video_view_session.viewer_id`.
//   R4. Counters move in the SAME TRANSACTION as the row that caused them, exactly
//       like `project_stats`. A like that commits without its counter is a like that
//       vanishes from the UI until a job runs, and that job is the one we are trying
//       not to need.
//   R5. Absence is not zero. `unique_viewer_count` is NULL until a job computes it,
//       for the same reason `project_stats.allocated_equity_basis_points` is.
// ---------------------------------------------------------------------------

// Where the viewer was standing when the session started. Recorded for ranking
// diagnostics — "does the Spotlight actually convert?" is otherwise unanswerable.
// Pinned on the FIRST beacon of a session and never rewritten: a client that changes
// its mind mid-session is describing a second session, not amending the first.
export const videoFeedSourceEnum = pgEnum("video_feed_source", [
  "feed_recommended",
  "feed_explore",
  "feed_spotlight",
  "feed_filtered",
  "search",
  "channel",
  "direct",
]);

export const videoShareChannelEnum = pgEnum("video_share_channel", [
  "copy_link",
  "x",
  "whatsapp",
  "linkedin",
  "email",
]);

// NOTE what is NOT here: `feed_mode`. §3.1 lists it, but it backs a QUERY PARAMETER on
// `GET /feed/videos` (phase 3) and no column stores it. A pgEnum with no column is a
// Postgres type nobody can use and a migration nobody can reverse cheaply.

/**
 * One row per viewer, per video, per UTC day.
 *
 * THE UNIQUE INDEX IS THE ANTI-REPLAY BOUNDARY. Without it a headless loop opens a
 * fresh session per request and every clamp below becomes decorative, because the
 * clamp bounds what ONE session can claim, not how many sessions exist.
 *
 * Rows are aggregated into `video_stats` and DELETED at 90 days by
 * `prune-engagement-data` (§6, phase 3). The counters survive; the per-viewer rows
 * do not. That is the whole privacy story: a fingerprint is a per-day bucket key with
 * a 90-day life, not an identity.
 */
export const videoViewSession = pgTable(
  "video_view_session",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "cascade" }),
    /**
     * NULL means anonymous, and THIS COLUMN IS THE §8.1 GATE.
     *
     * Anonymous watch time counts toward `view_count` — it is real traffic — but it
     * never touches `completion_bp_sum`, the component carrying 40 of ranking's 100
     * points. Farming the ranker therefore requires real accounts, which is a far
     * more expensive attack than a browser loop.
     *
     * `set null` rather than cascade: deleting an account must not retroactively
     * rewrite a video's view history.
     */
    viewerId: text("viewer_id").references(() => user.id, { onDelete: "set null" }),
    /**
     * sha256 hex. Derived per UTC day from BETTER_AUTH_SECRET plus either the user id
     * (signed in) or ip+user-agent (anonymous) — see src/lib/viewer-fingerprint.ts.
     * THE RAW IP IS NEVER WRITTEN TO THIS DATABASE.
     */
    viewerFingerprint: text("viewer_fingerprint").notNull(),
    /**
     * The UTC day, as the same string that went INTO the fingerprint hash.
     *
     * Deliberately a stored column and NOT generated from `first_beacon_at`: a
     * generated column is a second derivation of the same fact, and the two disagree
     * for any beacon that crosses midnight between the hash and the insert.
     */
    viewDayBucket: date("view_day_bucket", { mode: "string" }).notNull(),
    feedSource: videoFeedSourceEnum("feed_source").notNull(),
    /**
     * The denominator, pinned on the first beacon and never rewritten.
     *
     * `video.duration_seconds` is NULL for every YouTube row — oEmbed returns no
     * duration — so the client's claim is the only source, and it comes from the
     * hostile side. Pinning is what stops a client shrinking its own denominator
     * mid-session to manufacture a completion.
     */
    pinnedDurationSeconds: integer("pinned_duration_seconds").notNull(),
    watchedSeconds: integer("watched_seconds").default(0).notNull(),
    maxPositionSeconds: integer("max_position_seconds").default(0).notNull(),
    completionBasisPoints: integer("completion_basis_points").default(0).notNull(),
    /** Flips ONCE. The transition is what increments `video_stats.view_count`. */
    isCountedView: boolean("is_counted_view").default(false).notNull(),
    // `precision: 3` on both: the clamp divides the gap between them by 1000 to get
    // elapsed seconds, and phase 3's 48-hour view-velocity window scans first_beacon_at.
    firstBeaconAt: timestamp("first_beacon_at", { precision: 3 }).defaultNow().notNull(),
    lastBeaconAt: timestamp("last_beacon_at", { precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("video_view_session_unq").on(
      table.videoId,
      table.viewerFingerprint,
      table.viewDayBucket,
    ),
    // §4.4 anonymous session-scoped affinity: "what has this fingerprint watched in
    // the last 7 days?", so a logged-out feed responds after two or three watches
    // instead of staying a flat popularity list forever.
    index("video_view_session_fingerprint_idx").on(table.viewerFingerprint, table.viewDayBucket),
    // §4.5's "exclude anything this viewer already watched in the last 30 days".
    // Partial, because the candidate pool only ever asks about counted views by a
    // signed-in viewer, and that is a small fraction of the table.
    index("video_view_session_viewer_idx")
      .on(table.viewerId, table.videoId, table.firstBeaconAt)
      .where(sql`viewer_id IS NOT NULL AND is_counted_view`),
    // §4.1 view velocity: counted views in the first 48 hours.
    index("video_view_session_video_idx").on(table.videoId, table.firstBeaconAt),
    check(
      "video_view_session_bounds_ck",
      sql`watched_seconds >= 0
          AND max_position_seconds >= 0
          AND completion_basis_points BETWEEN 0 AND 10000
          AND pinned_duration_seconds BETWEEN 1 AND 43200
          AND last_beacon_at >= first_beacon_at`,
    ),
    // The fingerprint is server-computed, so a row that is not 64 lowercase hex chars
    // means something upstream stopped hashing — fail at the storage layer, loudly.
    check("video_view_session_fingerprint_ck", sql`viewer_fingerprint ~ '^[0-9a-f]{64}$'`),
  ],
);

/**
 * The unique key is what makes `PUT`/`DELETE /videos/:videoId/like` idempotent by
 * verb — which is why they are PUT and DELETE rather than POST: a double-tap on a
 * slow connection must be harmless, not a second like. Same call, same mechanism, as
 * `research_program_post_reaction`.
 */
export const videoLike = pgTable(
  "video_like",
  {
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.videoId, table.userId] }),
    // THE REVERSE INDEX IS THE POINT. "Which of these 24 cards have I liked?" is one
    // join over this index; without it, it is twenty-four round trips.
    index("video_like_userId_idx").on(table.userId, table.videoId),
  ],
);

/** Watch-later. Same shape as `videoLike`, one index apart — see below. */
export const videoSave = pgTable(
  "video_save",
  {
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.videoId, table.userId] }),
    // Leads with `created_at`, unlike videoLike's reverse index, because a saved list
    // is RENDERED — newest first — where a like set is only ever probed for membership.
    index("video_save_userId_idx").on(table.userId, table.createdAt, table.videoId),
  ],
);

/**
 * One level of threading only, discriminated by `depth` — the same single-table shape
 * as `research_program_post`, for the same reason: a self-join to depth 1 is one
 * index scan, and an unbounded tree is a recursive CTE nobody paginates correctly.
 *
 * DELETE IS A TOMBSTONE, NOT A ROW DELETE. Deleting a parent outright would cascade
 * its replies away, so a moderator removing one comment would silently remove the
 * conversation under it.
 *
 * §8.4 is explicit that v1 ships with NO reporting flow and NO automated moderation,
 * so the `is_hidden`/`hidden_by`/`hidden_reason` columns `research_program_post`
 * carries are deliberately ABSENT here rather than present and unwritten.
 */
export const videoComment = pgTable(
  "video_comment",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "cascade" }),
    // Cascade is safe ONLY because deletes are tombstones: no row is ever hard-deleted
    // by the application, and the depth cap bounds the cascade to one level anyway.
    parentCommentId: text("parent_comment_id").references((): AnyPgColumn => videoComment.id, {
      onDelete: "cascade",
    }),
    depth: integer("depth").default(0).notNull(),
    // `set null`: closing an account must not erase the thread it participated in.
    // A NULL author renders as "deleted user", which is a true statement.
    authorUserId: text("author_user_id").references(() => user.id, { onDelete: "set null" }),
    bodyText: text("body_text").notNull(),
    likeCount: integer("like_count").default(0).notNull(),
    replyCount: integer("reply_count").default(0).notNull(),
    isDeleted: boolean("is_deleted").default(false).notNull(),
    deletedAt: timestamp("deleted_at"),
    // `precision: 3` — LOAD-BEARING. Both listings are keyset-paginated on
    // `(created_at, id)` with a millisecond cursor (src/lib/instant-cursor.ts), and a
    // microsecond column under a millisecond cursor makes rows unreachable at every
    // page boundary. Identical note on research_program_post.created_at.
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    // The thread: top-level rows, newest first, ending in a unique column. Partial,
    // because replies are never in this listing and they are the bulk of the rows.
    index("video_comment_thread_idx")
      .on(table.videoId, table.createdAt, table.id)
      .where(sql`parent_comment_id IS NULL`),
    // A comment's replies, oldest first.
    index("video_comment_parent_idx").on(table.parentCommentId, table.createdAt, table.id),
    index("video_comment_authorUserId_idx").on(table.authorUserId, table.id),
    // Depth and parenthood are one fact stated twice, and they must agree.
    check(
      "video_comment_depth_ck",
      sql`depth BETWEEN 0 AND 1 AND (depth = 0) = (parent_comment_id IS NULL)`,
    ),
    // A reply has no replies of its own — the cap, restated where it is cheap to check.
    check("video_comment_leaf_ck", sql`depth = 0 OR reply_count = 0`),
    check("video_comment_counts_ck", sql`like_count >= 0 AND reply_count >= 0`),
    check("video_comment_deleted_ck", sql`is_deleted = (deleted_at IS NOT NULL)`),
    // THE TOMBSTONE ERASES THE TEXT, and the constraint is what makes that true.
    // Without the second arm, "deleted" is a rendering convention the next reader can
    // forget to honour — and the body sits in the table forever.
    check(
      "video_comment_body_ck",
      sql`(is_deleted = false AND char_length(body_text) BETWEEN 1 AND 2000)
          OR (is_deleted = true AND body_text = '')`,
    ),
  ],
);

export const videoCommentLike = pgTable(
  "video_comment_like",
  {
    commentId: text("comment_id")
      .notNull()
      .references(() => videoComment.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.commentId, table.userId] }),
    index("video_comment_like_userId_idx").on(table.userId, table.commentId),
  ],
);

/**
 * A share is an append, not a toggle — but the unique index below still makes
 * `POST /videos/:videoId/share` idempotent for a day, which is why that route carries
 * no `idempotency()` middleware. It could not: that middleware no-ops without a
 * session (src/middleware/idempotency.ts), and this is one of three routes an
 * anonymous caller can reach.
 */
export const videoShare = pgTable(
  "video_share",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "cascade" }),
    /**
     * NULL for an anonymous sharer, and — exactly like `video_view_session.viewer_id`
     * — this column is a GATE: only a share with a user id moves
     * `video_stats.share_count`, because share count feeds §4.1's engagement rate and
     * an anonymous caller must not be able to push a ranking input.
     */
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    /**
     * The dedupe identity, from the SAME helper as `viewer_fingerprint`. That helper
     * already branches on identity, so one column dedupes signed-in and anonymous
     * sharers without a second code path.
     */
    sharerFingerprint: text("sharer_fingerprint").notNull(),
    channel: videoShareChannelEnum("channel").notNull(),
    shareDayBucket: date("share_day_bucket", { mode: "string" }).notNull(),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("video_share_unq").on(
      table.videoId,
      table.sharerFingerprint,
      table.channel,
      table.shareDayBucket,
    ),
    index("video_share_videoId_idx").on(table.videoId, table.createdAt),
    check("video_share_fingerprint_ck", sql`sharer_fingerprint ~ '^[0-9a-f]{64}$'`),
  ],
);

export const creatorSubscription = pgTable(
  "creator_subscription",
  {
    subscriberId: text("subscriber_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    creatorId: text("creator_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.subscriberId, table.creatorId] }),
    // "Who subscribes to this creator?" — the direction the PK cannot serve.
    index("creator_subscription_creatorId_idx").on(table.creatorId, table.subscriberId),
    // Subscribing to yourself would inflate your own public subscriber count by one
    // and put your own videos in your own feed. Refused at the storage layer.
    check("creator_subscription_self_ck", sql`subscriber_id <> creator_id`),
  ],
);

/**
 * The §8.2 fast dead-player path.
 *
 * A creator can disable embedding on youtube.com at any moment and Qatoto finds out
 * only by asking. A nightly re-check means up to 24 hours of serving a dead player.
 * The IFrame API's `onError` gives us a same-second signal instead — but ONE client's
 * error report is one client's claim (R1), so the flip requires three DISTINCT
 * fingerprints, and the unique index below is what makes "distinct" mean something.
 */
export const videoPlaybackError = pgTable(
  "video_playback_error",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "cascade" }),
    viewerFingerprint: text("viewer_fingerprint").notNull(),
    reportDayBucket: date("report_day_bucket", { mode: "string" }).notNull(),
    errorCode: integer("error_code").notNull(),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("video_playback_error_unq").on(
      table.videoId,
      table.viewerFingerprint,
      table.reportDayBucket,
    ),
    index("video_playback_error_videoId_idx").on(table.videoId, table.reportDayBucket),
    // The IFrame API's documented codes, as a CLOSED SET. An open integer column is a
    // column of client-chosen junk that the three-fingerprint rule would then count.
    check("video_playback_error_code_ck", sql`error_code IN (2, 5, 100, 101, 150)`),
    check("video_playback_error_fingerprint_ck", sql`viewer_fingerprint ~ '^[0-9a-f]{64}$'`),
  ],
);

/**
 * Counter cache. Same shape and same reasoning as `project_stats`: a sidecar table
 * rather than columns on `video`, because `video.updated_at` uses `$onUpdate` and a
 * view counter must not make a creator's video look edited.
 *
 * Every counter here moves IN THE SAME TRANSACTION as the row that caused it. The
 * source-of-truth tables above stay authoritative; this is a cache, which is the only
 * reason `onDelete: "cascade"` is acceptable on the primary key.
 */
export const videoStats = pgTable(
  "video_stats",
  {
    videoId: text("video_id")
      .primaryKey()
      .references(() => video.id, { onDelete: "cascade" }),
    /**
     * COUNTED views, not beacons and not page loads. Moves exactly once per session,
     * on the `is_counted_view` transition. Rule 4 of the domain: a view is not a watch.
     */
    viewCount: integer("view_count").default(0).notNull(),
    likeCount: integer("like_count").default(0).notNull(),
    commentCount: integer("comment_count").default(0).notNull(),
    shareCount: integer("share_count").default(0).notNull(),
    saveCount: integer("save_count").default(0).notNull(),
    totalWatchedSeconds: bigint("total_watched_seconds", { mode: "number" }).default(0).notNull(),
    /**
     * SUM AND COUNT, NEVER A STORED AVERAGE. An average is a float, floats make a
     * ranking bug irreproducible, and §4.1 divides these two at read time with integer
     * division instead.
     *
     * ONLY ACCUMULATES FROM SESSIONS WHERE `viewer_id IS NOT NULL` (§8.1). That single
     * rule is what makes farming the 40-point completion component require real
     * accounts rather than a headless browser.
     */
    completionBasisPointsSum: bigint("completion_bp_sum", { mode: "number" }).default(0).notNull(),
    completionSampleCount: integer("completion_sample_count").default(0).notNull(),
    /**
     * NULLABLE WITH NO DEFAULT, deliberately — the `project_stats` split between
     * transactional counters and job-computed ones.
     *
     * This is a count of DISTINCT fingerprints across all days, which no single
     * transaction can maintain. §4.1's engagement rate divides by it, so defaulting it
     * to 0 would state as fact a denominator that is false and make a brand-new
     * video's engagement rate undefined-but-rendered. The phase-3 job writes it; until
     * then NULL is the honest value and the ranker treats it as absent, not as zero.
     */
    uniqueViewerCount: integer("unique_viewer_count"),
    /**
     * Counted views inside the first 48 hours — §4.1's velocity input, PERSISTED.
     *
     * Job-computed, nullable with no default, for the same Rule 5 reason as
     * `unique_viewer_count` above: a video nobody has scored yet has no velocity, which
     * is not the same fact as a velocity of zero.
     *
     * IT IS STORED RATHER THAN ALWAYS RECOMPUTED because `prune-engagement-data` deletes
     * the `video_view_session` rows it is derived from at 90 days. Without a stored
     * floor, every video older than the retention window would silently drop to zero
     * velocity on the next nightly run — and its engagement rate would inflate at the
     * same time, because the unique-viewer denominator collapses too. See
     * `engagement-retention.ts` for how the two jobs agree on the horizon.
     */
    countedViewsFirst48Hours: integer("counted_views_first_48_hours"),
    lastEngagementAt: timestamp("last_engagement_at"),
    /**
     * The §4.1 quality score, denormalized off `video_quality_score_snapshot`.
     *
     * DENORMALIZED FOR THE SAME REASON `problem_cluster.current_opportunity_score_points`
     * is: the feed already joins this table for its counters, and making it also resolve
     * "which snapshot is the current one" per request would be a second query on the
     * hottest read on the platform.
     *
     * NULLABLE WITH NO DEFAULT (Rule 5). A brand-new video is UNSCORED, which is not the
     * same fact as scored zero, and the feed's COALESCE is where that distinction is
     * made. `scoreComputedAt` carries the monotonic guard that stops an operator
     * replaying an old `asOf` for an audit from clobbering today's published scores.
     */
    qualityScorePoints: integer("quality_score_points"),
    qualityScoreComputedAt: timestamp("quality_score_computed_at"),
    /**
     * Position in the hourly top 200, or NULL for everything else.
     *
     * `?mode=trending` orders by this; Spotlight is `rank <= 3`. Denormalized rather than
     * joined for the same reason as above — and it is rewritten wholesale each hour, so
     * it needs no monotonic guard: there is exactly one live trending list at a time.
     */
    trendingRank: integer("trending_rank"),
  },
  () => [
    check(
      "video_stats_score_range_ck",
      sql`(quality_score_points IS NULL OR quality_score_points BETWEEN 0 AND 100)
          AND (quality_score_points IS NULL) = (quality_score_computed_at IS NULL)
          AND (trending_rank IS NULL OR trending_rank >= 1)`,
    ),
    check(
      "video_stats_counters_non_negative_ck",
      sql`view_count >= 0 AND like_count >= 0 AND comment_count >= 0
          AND share_count >= 0 AND save_count >= 0
          AND total_watched_seconds >= 0 AND completion_bp_sum >= 0
          AND completion_sample_count >= 0
          AND (unique_viewer_count IS NULL OR unique_viewer_count >= 0)
          AND (counted_views_first_48_hours IS NULL OR counted_views_first_48_hours >= 0)`,
    ),
  ],
);

/**
 * The creator-level counter cache. Separate from `video_stats` because a subscription
 * is not about any one video, and `subscriber_count` must survive every video being
 * unpublished.
 *
 * Rows are minted lazily — `INSERT … ON CONFLICT DO NOTHING` at the first video create
 * and at the first subscribe — because `user` rows are created by Better Auth inside a
 * transaction this schema cannot hook.
 */
export const creatorStats = pgTable(
  "creator_stats",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    subscriberCount: integer("subscriber_count").default(0).notNull(),
    publishedVideoCount: integer("published_video_count").default(0).notNull(),
    totalViewCount: bigint("total_view_count", { mode: "number" }).default(0).notNull(),
  },
  () => [
    check(
      "creator_stats_counters_non_negative_ck",
      sql`subscriber_count >= 0 AND published_video_count >= 0 AND total_view_count >= 0`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// HOME FEED — RANKING SNAPSHOTS (HOME_BACKEND_STRUCTURE.md §4, §6)
//
// All five copy `problem_cluster_score_snapshot` (schema.ts:1968), and the shape is the
// point: THE COMPONENT COLUMNS ARE STORED NEXT TO THE TOTAL. Six months from now,
// "why was this video ranked third?" has an answer that does not require replaying data
// that has since moved. A snapshot holding only a total is a number nobody can defend.
//
// Every one of them is APPEND-ONLY and keyed `unique(scope…, as_of)`, so re-running a job
// for the same `asOf` is an `ON CONFLICT DO NOTHING` rather than a duplicate row or a
// destructive overwrite — the property that makes "run it again and diff" a valid way to
// check the ranking is deterministic.
//
// `scoreAlgorithmVersion` on each: the formula may evolve without invalidating history.
// ---------------------------------------------------------------------------

/**
 * §4.1 — one video's quality, nightly, 0..100.
 *
 * The five components do NOT have fixed budgets, because §4.2's sample ramp moves the
 * completion budget and redistributes the remainder. So the CHECK below asserts only that
 * the components sum to the total and the total is in band — which is the invariant that
 * actually holds, rather than one that looks tidier and is false.
 */
export const videoQualityScoreSnapshot = pgTable(
  "video_quality_score_snapshot",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    // `restrict`, not cascade — the snapshot precedent. Deleting a video that has ranking
    // history should fail loudly rather than silently erase the record of how it ranked.
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "restrict" }),
    /** From the job payload, quantized to a UTC day start. Never a clock read. */
    asOf: timestamp("as_of").notNull(),
    qualityScorePoints: integer("quality_score_points").notNull(),
    // --- Inputs, so the score is reproducible without replaying history.
    meanCompletionBasisPoints: integer("mean_completion_basis_points").notNull(),
    completionSampleCount: integer("completion_sample_count").notNull(),
    engagementPerThousandViewers: integer("engagement_per_thousand_viewers").notNull(),
    /** NULL when the job could not establish one — Rule 5, not a fabricated zero. */
    uniqueViewerCount: integer("unique_viewer_count"),
    countedViewsFirst48Hours: integer("counted_views_first_48_hours").notNull(),
    creatorMedianQualityPoints: integer("creator_median_quality_points"),
    hoursSincePublished: integer("hours_since_published").notNull(),
    // --- Components. Their sum IS the score.
    completionComponentPoints: integer("completion_component_points").notNull(),
    engagementComponentPoints: integer("engagement_component_points").notNull(),
    velocityComponentPoints: integer("velocity_component_points").notNull(),
    creatorTrackComponentPoints: integer("creator_track_component_points").notNull(),
    freshnessComponentPoints: integer("freshness_component_points").notNull(),
    scoreAlgorithmVersion: integer("score_algorithm_version").default(1).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    // No updatedAt. An append-only table has nothing to update.
  },
  (table) => [
    uniqueIndex("video_quality_score_snapshot_unq").on(table.videoId, table.asOf),
    index("video_quality_score_snapshot_asOf_idx").on(table.asOf, table.id),
    check(
      "video_quality_score_snapshot_score_ck",
      sql`quality_score_points BETWEEN 0 AND 100
          AND completion_component_points >= 0 AND engagement_component_points >= 0
          AND velocity_component_points >= 0 AND creator_track_component_points >= 0
          AND freshness_component_points >= 0
          AND completion_component_points + engagement_component_points
              + velocity_component_points + creator_track_component_points
              + freshness_component_points = quality_score_points`,
    ),
    check(
      "video_quality_score_snapshot_inputs_ck",
      sql`mean_completion_basis_points BETWEEN 0 AND 10000
          AND completion_sample_count >= 0
          AND engagement_per_thousand_viewers >= 0
          AND (unique_viewer_count IS NULL OR unique_viewer_count >= 0)
          AND counted_views_first_48_hours >= 0
          AND (creator_median_quality_points IS NULL
               OR creator_median_quality_points BETWEEN 0 AND 100)
          AND hours_since_published >= 0`,
    ),
  ],
);

/**
 * §4.3 — how much one viewer likes one category, nightly, 0..100.
 *
 * A ROW ONLY EXISTS WHERE THERE IS EVIDENCE. The absence of a (user, category) row is what
 * triggers §4.4's cold-start fallback to damped platform popularity; writing a zero row
 * instead would fabricate the very value the fallback exists to avoid, and the feed would
 * have no way to tell "watched it and hated it" from "never saw it".
 */
export const userTopicAffinitySnapshot = pgTable(
  "user_topic_affinity_snapshot",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    // Cascade here, unlike the video snapshot: this is derived personal data, and a
    // deleted account's taste profile should go with it.
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    categoryId: text("category_id")
      .notNull()
      .references(() => contentCategory.id, { onDelete: "restrict" }),
    asOf: timestamp("as_of").notNull(),
    affinityPoints: integer("affinity_points").notNull(),
    countedViewCount: integer("counted_view_count").notNull(),
    meanCompletionBasisPoints: integer("mean_completion_basis_points").notNull(),
    explicitSignalCount: integer("explicit_signal_count").notNull(),
    watchCountComponentPoints: integer("watch_count_component_points").notNull(),
    meanCompletionComponentPoints: integer("mean_completion_component_points").notNull(),
    explicitSignalComponentPoints: integer("explicit_signal_component_points").notNull(),
    scoreAlgorithmVersion: integer("score_algorithm_version").default(1).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("user_topic_affinity_snapshot_unq").on(table.userId, table.categoryId, table.asOf),
    // The feed's join: every category this viewer has an opinion about, at one asOf.
    index("user_topic_affinity_snapshot_viewer_idx").on(table.userId, table.asOf, table.categoryId),
    index("user_topic_affinity_snapshot_asOf_idx").on(table.asOf, table.id),
    check(
      "user_topic_affinity_snapshot_score_ck",
      sql`affinity_points BETWEEN 0 AND 100
          AND watch_count_component_points >= 0 AND mean_completion_component_points >= 0
          AND explicit_signal_component_points >= 0
          AND watch_count_component_points + mean_completion_component_points
              + explicit_signal_component_points = affinity_points
          AND counted_view_count >= 0
          AND mean_completion_basis_points BETWEEN 0 AND 10000
          AND explicit_signal_count >= 0`,
    ),
  ],
);

/** §4.3 — the same question about a creator rather than a category. Same shape. */
export const userCreatorAffinitySnapshot = pgTable(
  "user_creator_affinity_snapshot",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    creatorId: text("creator_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    asOf: timestamp("as_of").notNull(),
    affinityPoints: integer("affinity_points").notNull(),
    countedViewCount: integer("counted_view_count").notNull(),
    meanCompletionBasisPoints: integer("mean_completion_basis_points").notNull(),
    explicitSignalCount: integer("explicit_signal_count").notNull(),
    watchCountComponentPoints: integer("watch_count_component_points").notNull(),
    meanCompletionComponentPoints: integer("mean_completion_component_points").notNull(),
    explicitSignalComponentPoints: integer("explicit_signal_component_points").notNull(),
    scoreAlgorithmVersion: integer("score_algorithm_version").default(1).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("user_creator_affinity_snapshot_unq").on(table.userId, table.creatorId, table.asOf),
    index("user_creator_affinity_snapshot_viewer_idx").on(
      table.userId,
      table.asOf,
      table.creatorId,
    ),
    index("user_creator_affinity_snapshot_asOf_idx").on(table.asOf, table.id),
    // A viewer cannot have an affinity for themselves — their own videos are excluded
    // from the candidate pool anyway, so such a row could only ever be dead weight.
    check("user_creator_affinity_snapshot_self_ck", sql`user_id <> creator_id`),
    check(
      "user_creator_affinity_snapshot_score_ck",
      sql`affinity_points BETWEEN 0 AND 100
          AND watch_count_component_points >= 0 AND mean_completion_component_points >= 0
          AND explicit_signal_component_points >= 0
          AND watch_count_component_points + mean_completion_component_points
              + explicit_signal_component_points = affinity_points
          AND counted_view_count >= 0
          AND mean_completion_basis_points BETWEEN 0 AND 10000
          AND explicit_signal_count >= 0`,
    ),
  ],
);

/**
 * §6 — the hourly top 200. Spotlight is `rank <= 3`.
 *
 * HOURLY, not nightly, and that is the one scheduling decision in this domain that is not
 * negotiable: a "trending" chip recomputed once a day is a lie about what the word means.
 *
 * `unique(asOf, rank)` alongside `unique(asOf, videoId)` is what makes `rank` mean
 * something. Without it a bug that emits two rank-1 rows would store happily and Spotlight
 * would render whichever the planner happened to return.
 */
export const trendingVideoSnapshot = pgTable(
  "trending_video_snapshot",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "restrict" }),
    /** Quantized to a UTC HOUR start, unlike its nightly siblings. */
    asOf: timestamp("as_of").notNull(),
    rank: integer("rank").notNull(),
    trendingScorePoints: integer("trending_score_points").notNull(),
    countedViewsInWindow: integer("counted_views_in_window").notNull(),
    watchedMinutesInWindow: integer("watched_minutes_in_window").notNull(),
    engagementActionsInWindow: integer("engagement_actions_in_window").notNull(),
    qualityScorePoints: integer("quality_score_points"),
    recentViewComponentPoints: integer("recent_view_component_points").notNull(),
    recentWatchTimeComponentPoints: integer("recent_watch_time_component_points").notNull(),
    recentEngagementComponentPoints: integer("recent_engagement_component_points").notNull(),
    qualityComponentPoints: integer("quality_component_points").notNull(),
    scoreAlgorithmVersion: integer("score_algorithm_version").default(1).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("trending_video_snapshot_video_unq").on(table.asOf, table.videoId),
    uniqueIndex("trending_video_snapshot_rank_unq").on(table.asOf, table.rank),
    check(
      "trending_video_snapshot_score_ck",
      sql`rank >= 1
          AND trending_score_points BETWEEN 0 AND 100
          AND recent_view_component_points >= 0 AND recent_watch_time_component_points >= 0
          AND recent_engagement_component_points >= 0 AND quality_component_points >= 0
          AND recent_view_component_points + recent_watch_time_component_points
              + recent_engagement_component_points + quality_component_points
              = trending_score_points
          AND counted_views_in_window >= 0 AND watched_minutes_in_window >= 0
          AND engagement_actions_in_window >= 0
          AND (quality_score_points IS NULL OR quality_score_points BETWEEN 0 AND 100)`,
    ),
  ],
);

/**
 * §4.4 — what the platform as a whole watches, per category, nightly.
 *
 * The ONLY consumer is cold start: a signed-in viewer with no history sees this
 * distribution, damped to 60%, instead of a flat feed. It is deliberately not exposed on
 * any route — "which categories are popular" is a product decision surface, not a public
 * fact, and publishing it would hand a creator a targeting list.
 */
export const platformCategoryPopularitySnapshot = pgTable(
  "platform_category_popularity_snapshot",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    categoryId: text("category_id")
      .notNull()
      .references(() => contentCategory.id, { onDelete: "restrict" }),
    asOf: timestamp("as_of").notNull(),
    /** 0..100, a share of the most-watched category rather than of the whole. */
    popularityPoints: integer("popularity_points").notNull(),
    countedViewCount: integer("counted_view_count").notNull(),
    publishedVideoCount: integer("published_video_count").notNull(),
    scoreAlgorithmVersion: integer("score_algorithm_version").default(1).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("platform_category_popularity_snapshot_unq").on(table.categoryId, table.asOf),
    index("platform_category_popularity_snapshot_asOf_idx").on(table.asOf, table.categoryId),
    check(
      "platform_category_popularity_snapshot_ck",
      sql`popularity_points BETWEEN 0 AND 100
          AND counted_view_count >= 0 AND published_video_count >= 0`,
    ),
  ],
);

export const playlist = pgTable(
  "playlist",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    creatorId: text("creator_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    visibility: playlistVisibilityEnum("visibility").default("private").notNull(),
    defaultVideoOrder: playlistVideoOrderEnum("default_video_order")
      .default("date_published_newest")
      .notNull(),
    language: text("language"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("playlist_creatorId_idx").on(table.creatorId)],
);

export const playlistItem = pgTable(
  "playlist_item",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    playlistId: text("playlist_id")
      .notNull()
      .references(() => playlist.id, { onDelete: "cascade" }),
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("playlist_item_playlistId_idx").on(table.playlistId),
    // Serves PUT /videos/:id/playlists, which reads membership by video, not playlist.
    index("playlist_item_videoId_idx").on(table.videoId),
    uniqueIndex("playlist_item_unq").on(table.playlistId, table.videoId),
  ],
);

export const animeSeries = pgTable(
  "anime_series",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    posterUrl: text("poster_url"),
    genreTags: text("genre_tags").array().notNull().default([]),
    status: animeSeriesStatusEnum("status").default("ongoing").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("anime_series_ownerId_idx").on(table.ownerId),
    check("anime_series_genre_tags_ck", sql`cardinality(genre_tags) <= 20`),
  ],
);

export const animeSeason = pgTable(
  "anime_season",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    seriesId: text("series_id")
      .notNull()
      .references(() => animeSeries.id, { onDelete: "cascade" }),
    seasonLabel: text("season_label").notNull(),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("anime_season_seriesId_idx").on(table.seriesId),
    // ADDITION TO SPEC §4. Two "Season 1" rows under one series make the upload
    // modal's season picker ambiguous and render the episode-number unique index
    // below useless. It is also what lets "pick or create Season 1" be an idempotent
    // insert-on-conflict rather than a read-then-write race.
    uniqueIndex("anime_season_label_unq").on(table.seriesId, table.seasonLabel),
  ],
);

export const animeEpisode = pgTable(
  "anime_episode",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    seasonId: text("season_id")
      .notNull()
      .references(() => animeSeason.id, { onDelete: "cascade" }),
    // `set null` so deleting the video leaves the catalog entry standing.
    videoId: text("video_id").references(() => video.id, { onDelete: "set null" }),
    episodeNumber: integer("episode_number").notNull(),
    episodeTitle: text("episode_title").notNull(),
    isPremium: boolean("is_premium").default(false).notNull(),
    releaseScheduleDay: text("release_schedule_day"),
    releaseScheduleTime: text("release_schedule_time"),
    premiereDate: timestamp("premiere_date"),
    audioMode: animeAudioModeEnum("audio_mode"),
    audioLanguage: text("audio_language"),
    ageRating: text("age_rating"),
    // Set when the episode goes live in /anime, which is on APPROVAL, not on publish.
    releasedAt: timestamp("released_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("anime_episode_seasonId_idx").on(table.seasonId),
    uniqueIndex("anime_episode_unq").on(table.seasonId, table.episodeNumber),
    // ADDITION TO SPEC §4, which asserts "one video is at most one episode" in a
    // comment and then does not enforce it. Partial because videoId is nullable.
    uniqueIndex("anime_episode_videoId_unq")
      .on(table.videoId)
      .where(sql`video_id is not null`),
    check("anime_episode_number_ck", sql`episode_number >= 0`),
  ],
);

// Every approve/reject, logged. This is the record of record for moderation.
export const contentReviewAction = pgTable(
  "content_review_action",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    // Cascade, deliberately, and the asymmetry with reviewerId below is the point:
    // once the video is gone there is no longer a subject to have been reviewed, so
    // the row describes nothing. The REVIEWER, by contrast, must stay accountable.
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "cascade" }),
    // `restrict`, per the R&D cascade rule R2: this row bears AUDIT weight, so a
    // moderator cannot be hard-deleted out from under the decisions they made.
    // Account deletion is an anonymization flow, not a DELETE.
    reviewerId: text("reviewer_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    action: contentReviewActionKindEnum("action").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("content_review_action_videoId_idx").on(table.videoId),
    // The admin audit-log view is chronological across every video.
    index("content_review_action_createdAt_idx").on(table.createdAt),
    // A rejection with no reason is unactionable for the creator and unauditable for
    // the next moderator.
    check("content_review_action_reason_ck", sql`(action <> 'reject') OR (reason IS NOT NULL)`),
  ],
);

// --- Studio relations. Child-side only: each table declares its own `one(user, ...)`
// --- and `userRelations` is left untouched, matching the store and R&D precedent.

export const videoRelations = relations(video, ({ one, many }) => ({
  creator: one(user, { fields: [video.creatorId], references: [user.id] }),
  chapters: many(videoChapter),
  attachedProducts: many(videoAttachedProduct),
  documents: many(videoDocument),
  milestones: many(videoMilestone),
  openRoles: many(videoOpenRole),
  teamMembers: many(videoTeamMember),
  collaborators: many(videoCollaborator),
  playlistItems: many(playlistItem),
  reviewActions: many(contentReviewAction),
  categories: many(videoCategory),
  stats: one(videoStats, { fields: [video.id], references: [videoStats.videoId] }),
  viewSessions: many(videoViewSession),
  likes: many(videoLike),
  saves: many(videoSave),
  comments: many(videoComment),
  shares: many(videoShare),
}));

// Child-side only, as everywhere in this section: userRelations is deliberately untouched.
export const contentCategoryRelations = relations(contentCategory, ({ many }) => ({
  videoLinks: many(videoCategory),
}));

export const videoCategoryRelations = relations(videoCategory, ({ one }) => ({
  video: one(video, { fields: [videoCategory.videoId], references: [video.id] }),
  category: one(contentCategory, {
    fields: [videoCategory.categoryId],
    references: [contentCategory.id],
  }),
}));

// --- Engagement (§3). Child-side only: userRelations stays untouched, as everywhere
// --- in this section.

export const videoStatsRelations = relations(videoStats, ({ one }) => ({
  video: one(video, { fields: [videoStats.videoId], references: [video.id] }),
}));

export const creatorStatsRelations = relations(creatorStats, ({ one }) => ({
  user: one(user, { fields: [creatorStats.userId], references: [user.id] }),
}));

export const videoViewSessionRelations = relations(videoViewSession, ({ one }) => ({
  video: one(video, { fields: [videoViewSession.videoId], references: [video.id] }),
  viewer: one(user, { fields: [videoViewSession.viewerId], references: [user.id] }),
}));

export const videoLikeRelations = relations(videoLike, ({ one }) => ({
  video: one(video, { fields: [videoLike.videoId], references: [video.id] }),
  user: one(user, { fields: [videoLike.userId], references: [user.id] }),
}));

export const videoSaveRelations = relations(videoSave, ({ one }) => ({
  video: one(video, { fields: [videoSave.videoId], references: [video.id] }),
  user: one(user, { fields: [videoSave.userId], references: [user.id] }),
}));

export const videoCommentRelations = relations(videoComment, ({ one, many }) => ({
  video: one(video, { fields: [videoComment.videoId], references: [video.id] }),
  author: one(user, { fields: [videoComment.authorUserId], references: [user.id] }),
  // The self-relation carries an explicit `relationName` on BOTH sides, or drizzle
  // cannot tell which of the two references to `videoComment` pairs with which.
  parent: one(videoComment, {
    fields: [videoComment.parentCommentId],
    references: [videoComment.id],
    relationName: "videoCommentThread",
  }),
  replies: many(videoComment, { relationName: "videoCommentThread" }),
  likes: many(videoCommentLike),
}));

export const videoCommentLikeRelations = relations(videoCommentLike, ({ one }) => ({
  comment: one(videoComment, {
    fields: [videoCommentLike.commentId],
    references: [videoComment.id],
  }),
  user: one(user, { fields: [videoCommentLike.userId], references: [user.id] }),
}));

export const videoShareRelations = relations(videoShare, ({ one }) => ({
  video: one(video, { fields: [videoShare.videoId], references: [video.id] }),
  user: one(user, { fields: [videoShare.userId], references: [user.id] }),
}));

export const videoPlaybackErrorRelations = relations(videoPlaybackError, ({ one }) => ({
  video: one(video, { fields: [videoPlaybackError.videoId], references: [video.id] }),
}));

// --- Ranking snapshots (§4, §6). Child-side only, as everywhere in this section.

export const videoQualityScoreSnapshotRelations = relations(
  videoQualityScoreSnapshot,
  ({ one }) => ({
    video: one(video, { fields: [videoQualityScoreSnapshot.videoId], references: [video.id] }),
  }),
);

export const userTopicAffinitySnapshotRelations = relations(
  userTopicAffinitySnapshot,
  ({ one }) => ({
    user: one(user, { fields: [userTopicAffinitySnapshot.userId], references: [user.id] }),
    category: one(contentCategory, {
      fields: [userTopicAffinitySnapshot.categoryId],
      references: [contentCategory.id],
    }),
  }),
);

// Both FKs point at `user`, so both need a relationName — same rule as the comment thread.
export const userCreatorAffinitySnapshotRelations = relations(
  userCreatorAffinitySnapshot,
  ({ one }) => ({
    viewer: one(user, {
      fields: [userCreatorAffinitySnapshot.userId],
      references: [user.id],
      relationName: "creatorAffinityViewer",
    }),
    creator: one(user, {
      fields: [userCreatorAffinitySnapshot.creatorId],
      references: [user.id],
      relationName: "creatorAffinityCreator",
    }),
  }),
);

export const trendingVideoSnapshotRelations = relations(trendingVideoSnapshot, ({ one }) => ({
  video: one(video, { fields: [trendingVideoSnapshot.videoId], references: [video.id] }),
}));

export const platformCategoryPopularitySnapshotRelations = relations(
  platformCategoryPopularitySnapshot,
  ({ one }) => ({
    category: one(contentCategory, {
      fields: [platformCategoryPopularitySnapshot.categoryId],
      references: [contentCategory.id],
    }),
  }),
);

// Both sides point at `user`, so both need a relationName — same rule as the comment
// thread above.
export const creatorSubscriptionRelations = relations(creatorSubscription, ({ one }) => ({
  subscriber: one(user, {
    fields: [creatorSubscription.subscriberId],
    references: [user.id],
    relationName: "creatorSubscriptionSubscriber",
  }),
  creator: one(user, {
    fields: [creatorSubscription.creatorId],
    references: [user.id],
    relationName: "creatorSubscriptionCreator",
  }),
}));

export const videoChapterRelations = relations(videoChapter, ({ one }) => ({
  video: one(video, { fields: [videoChapter.videoId], references: [video.id] }),
}));

export const videoAttachedProductRelations = relations(videoAttachedProduct, ({ one }) => ({
  video: one(video, { fields: [videoAttachedProduct.videoId], references: [video.id] }),
  product: one(product, { fields: [videoAttachedProduct.productId], references: [product.id] }),
}));

export const videoDocumentRelations = relations(videoDocument, ({ one }) => ({
  video: one(video, { fields: [videoDocument.videoId], references: [video.id] }),
}));

export const videoMilestoneRelations = relations(videoMilestone, ({ one }) => ({
  video: one(video, { fields: [videoMilestone.videoId], references: [video.id] }),
}));

export const videoOpenRoleRelations = relations(videoOpenRole, ({ one }) => ({
  video: one(video, { fields: [videoOpenRole.videoId], references: [video.id] }),
}));

export const videoTeamMemberRelations = relations(videoTeamMember, ({ one }) => ({
  video: one(video, { fields: [videoTeamMember.videoId], references: [video.id] }),
  linkedUser: one(user, { fields: [videoTeamMember.linkedUserId], references: [user.id] }),
}));

export const videoCollaboratorRelations = relations(videoCollaborator, ({ one }) => ({
  video: one(video, { fields: [videoCollaborator.videoId], references: [video.id] }),
  invitedUser: one(user, { fields: [videoCollaborator.userId], references: [user.id] }),
}));

export const playlistRelations = relations(playlist, ({ one, many }) => ({
  creator: one(user, { fields: [playlist.creatorId], references: [user.id] }),
  items: many(playlistItem),
}));

export const playlistItemRelations = relations(playlistItem, ({ one }) => ({
  playlist: one(playlist, { fields: [playlistItem.playlistId], references: [playlist.id] }),
  video: one(video, { fields: [playlistItem.videoId], references: [video.id] }),
}));

export const animeSeriesRelations = relations(animeSeries, ({ one, many }) => ({
  owner: one(user, { fields: [animeSeries.ownerId], references: [user.id] }),
  seasons: many(animeSeason),
}));

export const animeSeasonRelations = relations(animeSeason, ({ one, many }) => ({
  series: one(animeSeries, { fields: [animeSeason.seriesId], references: [animeSeries.id] }),
  episodes: many(animeEpisode),
}));

export const animeEpisodeRelations = relations(animeEpisode, ({ one }) => ({
  season: one(animeSeason, { fields: [animeEpisode.seasonId], references: [animeSeason.id] }),
  video: one(video, { fields: [animeEpisode.videoId], references: [video.id] }),
}));

export const contentReviewActionRelations = relations(contentReviewAction, ({ one }) => ({
  video: one(video, { fields: [contentReviewAction.videoId], references: [video.id] }),
  reviewer: one(user, { fields: [contentReviewAction.reviewerId], references: [user.id] }),
}));

// ---------------------------------------------------------------------------
// Promotions — the home-page promotional carousel.
//
// ONE TABLE, NO OWNER. Unlike `product` or `animeSeries`, a slide has no member
// owner: it is platform-authored merchandising, written only by a holder of the
// `manage_promotions` capability. So there is no `ownerId`, and the 404-as-ownership
// rule does not apply — the capability check, decided BEFORE any id is read, is the
// whole gate (see requirePlatformCapability's ordering requirement).
//
// WHY `manage_promotions` AND NOT `moderate_content`. A slide is a front-page
// placement that may point at an arbitrary external https URL. That is a phishing
// lure wearing Qatoto's own branding, so its blast radius sits next to role
// management, not next to deciding whether a user's video is allowed. `admin` only.
// ---------------------------------------------------------------------------

/**
 * Where a slide sends the visitor. A discriminator, not two nullable columns: a slide
 * always has EXACTLY ONE destination, so one enum + one value column makes that
 * cardinality structural rather than something an XOR check has to un-represent
 * afterwards. It also maps 1:1 onto `z.discriminatedUnion` in the controller and onto
 * the frontend's `<Link>` vs `<a target="_blank">` switch.
 *
 * snake_case labels, sent VERBATIM in both directions (CLAUDE.md wire-casing). Never
 * "internal-path".
 */
export const promotionalDestinationKindEnum = pgEnum("promotional_destination_kind", [
  "internal_path",
  "external_url",
]);

export const promotionalSlide = pgTable(
  "promotional_slide",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    /**
     * Cloudinary secure_url of the normalized asset, mirroring `productImage.url`.
     *
     * STORE WHAT CLOUDINARY RETURNED — never reconstruct this from the public id. The
     * `/v<timestamp>/` segment changes on every overwrite, and that segment is exactly
     * what busts the browser cache when an admin replaces a slide's image in place.
     */
    imageUrl: text("image_url").notNull(),
    /**
     * Intrinsic dimensions of the stored asset. A DELIBERATE DEVIATION from
     * `product_image`, which stores neither: `validateAndNormalizeImage` returns them
     * for free, and a full-bleed hero rendered without an aspect ratio is a guaranteed
     * layout shift on the single most-visited page on the site. A product thumbnail
     * sits in a fixed-size grid tile and does not have that problem, which is why the
     * store table can get away without them.
     */
    imageWidthPx: integer("image_width_px").notNull(),
    imageHeightPx: integer("image_height_px").notNull(),
    /**
     * NOT NULL, on purpose. The image sits INSIDE a link, so without alt text the link
     * has no accessible name at all — a WCAG 2.4.4/1.1.1 failure rather than a missing
     * nicety. Nullable would make an unlabelled slide representable.
     */
    altText: text("alt_text").notNull(),
    destinationKind: promotionalDestinationKindEnum("destination_kind").notNull(),
    /** The path or URL itself, already normalized by `parsePromotionalDestination`. */
    destinationValue: text("destination_value").notNull(),
    /**
     * 0-based display order; slide 0 shows first. Contiguous, re-packed on delete —
     * the same contract as `productImage.position`. No unique index on it: a reorder
     * rewrites every row inside one transaction and a non-deferrable UNIQUE would fire
     * mid-loop.
     */
    position: integer("position").notNull(),
    /** The retirement switch. The row survives; the public read stops offering it. */
    isActive: boolean("is_active").default(true).notNull(),
    /** NULL on either side = unbounded in that direction. Absolute instants, UTC. */
    startsAt: timestamp("starts_at"),
    endsAt: timestamp("ends_at"),
    /**
     * Who touched this, for the admin list. `set null`, NOT `restrict`: the
     * authoritative accountability record is the platform audit chain, and `restrict`
     * would make one promo slide block a staff account deletion forever. `cascade` is
     * worse still — it would silently delete live merchandising when someone leaves.
     */
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    updatedByUserId: text("updated_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    // The public read — live slides in order. Partial, because the overwhelming
    // majority of reads want only the live set.
    index("promotional_slide_live_idx")
      .on(table.position, table.id)
      .where(sql`is_active`),
    // The admin read, which includes retired and out-of-window rows.
    index("promotional_slide_position_idx").on(table.position, table.id),

    check("promotional_slide_position_ck", sql`position >= 0`),
    check("promotional_slide_alt_text_ck", sql`char_length(alt_text) BETWEEN 1 AND 200`),
    check(
      "promotional_slide_image_url_ck",
      sql`char_length(image_url) <= 2048 AND image_url LIKE 'https://%'`,
    ),
    check(
      "promotional_slide_image_dimensions_ck",
      sql`image_width_px BETWEEN 1 AND 8192 AND image_height_px BETWEEN 1 AND 8192`,
    ),
    check(
      "promotional_slide_window_ck",
      sql`starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at`,
    ),
    /**
     * THE OPEN-REDIRECT BACKSTOP.
     *
     * `//evil.tld/x` starts with "/" and IS an open redirect, so the internal arm has to
     * refuse a doubled leading slash explicitly. The fine-grained parse lives in
     * `src/lib/promotional-destination.ts` where it can return a useful message; this
     * check exists so the bad row stays UNREPRESENTABLE even if a future code path
     * skips the service.
     *
     * Written with no apostrophe inside the character class on purpose — quote-doubling
     * inside a `sql` template is how you get a migration that generates but won't apply.
     */
    check(
      "promotional_slide_destination_ck",
      sql`(destination_kind = 'internal_path'
             AND char_length(destination_value) BETWEEN 1 AND 512
             AND destination_value LIKE '/%'
             AND destination_value NOT LIKE '//%'
             AND destination_value !~ '[[:space:][:cntrl:]]')
          OR (destination_kind = 'external_url'
             AND char_length(destination_value) BETWEEN 1 AND 2048
             AND destination_value LIKE 'https://%'
             AND destination_value !~ '[[:space:][:cntrl:]]')`,
    ),
  ],
);

export const promotionalSlideRelations = relations(promotionalSlide, ({ one }) => ({
  createdBy: one(user, { fields: [promotionalSlide.createdByUserId], references: [user.id] }),
  updatedBy: one(user, { fields: [promotionalSlide.updatedByUserId], references: [user.id] }),
}));

// ---------------------------------------------------------------------------
// Spotlight — the three-video rail on the home feed below the category tiles.
//
// PLATFORM-AUTHORED, like `promotional_slide`. No member owner; the gate is
// `manage_promotions` (same front-page placement blast radius as the carousel). The
// only write is a whole-set replace of 0..3 video ids — there is no per-slot CRUD,
// because a partial list would silently drop a slot the admin had not seen.
//
// Thumbnails and titles are NOT stored here. They are joined from `video` at read
// time, so an admin never uploads a second creative for a video that already has one.
// ---------------------------------------------------------------------------

export const feedSpotlightSlot = pgTable(
  "feed_spotlight_slot",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    /**
     * 0-based display order: 0 = left, 1 = center, 2 = right. Contiguous after every
     * replace. UNIQUE — two rows sharing a position would make the rail order undefined.
     */
    position: integer("position").notNull(),
    /**
     * The catalogue video shown in this slot. Cascade: deleting the video must not leave
     * a dangling homepage placement pointing at a 404.
     */
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "cascade" }),
    updatedByUserId: text("updated_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("feed_spotlight_slot_position_uidx").on(table.position),
    uniqueIndex("feed_spotlight_slot_video_uidx").on(table.videoId),
    check("feed_spotlight_slot_position_ck", sql`position >= 0 AND position <= 2`),
  ],
);

export const feedSpotlightSlotRelations = relations(feedSpotlightSlot, ({ one }) => ({
  video: one(video, { fields: [feedSpotlightSlot.videoId], references: [video.id] }),
  updatedBy: one(user, {
    fields: [feedSpotlightSlot.updatedByUserId],
    references: [user.id],
  }),
}));

// ---------------------------------------------------------------------------
// COMMUNITY — the business forum (STORE_BACKEND_STRUCTURE.md §17, Appendix A33)
// ---------------------------------------------------------------------------
//
// A SIBLING CONTEXT, NOT COMMERCE (§1.1). No organization is required to post, nothing is
// priced, nothing is ordered. Nothing here shares an enum or a target-kind with the
// `commerce_*` family, and that separation is the point rather than an oversight: the one
// hard rule underneath this surface is that NOTHING ON IT MAY BE READ AS A COMMERCIAL FACT
// ABOUT A PARTY, because no order, payment or verification stands behind any of it.
//
// Modelled on `researchProgramPost` and its reaction/report/moderation siblings — a
// threaded board with a moderation queue, already shipped and already load-bearing.

/**
 * SIX BOARDS, MATCHING THE WORK RATHER THAN THE ORG CHART.
 *
 * Each maps to a thing a business actually gets stuck on and to a surface this platform
 * already has — sourcing to the catalogue, logistics and customs to `/store/providers`,
 * compliance to factory certifications, payments to quotes and orders.
 *
 * A "GENERAL" BOARD IS DELIBERATELY ABSENT. It is where every thread ends up when nobody
 * can decide, and a board nobody can characterise is a board nobody subscribes to.
 */
export const communityForumBoardEnum = pgEnum("community_forum_board", [
  "sourcing",
  "logistics_and_customs",
  "compliance_and_certification",
  "payments_and_trade_finance",
  "manufacturing",
  "selling_on_qatoto",
]);

/**
 * A thread's lifecycle. `pending_review` ON CREATE IS THE DESIGN, NOT A PLACEHOLDER.
 *
 * A10 closed public product comments because a comment would be "the only public text
 * surface with no purchase proof and no standing requirement behind it". A standalone forum
 * inherits that problem exactly: public text, written by anyone, attached to a commerce
 * platform's domain. MODERATION IS WHAT LETS IT EXIST without reopening that decision, so
 * the public reads filter this state out the way the provider directory never returns a
 * `draft` offering.
 *
 * Do not "fix" this into an immediate publish because a forum usually publishes
 * immediately. This one has a documented reason not to.
 */
export const communityForumThreadStateEnum = pgEnum("community_forum_thread_state", [
  "pending_review",
  "open",
  "answered",
  "locked",
]);

export const communityForumReplyStateEnum = pgEnum("community_forum_reply_state", [
  "visible",
  "hidden",
]);

export const communityContentTargetKindEnum = pgEnum("community_content_target_kind", [
  "forum_thread",
  "forum_reply",
]);

/**
 * Narrower than `commerce_content_report_reason`, because the failures differ. There is no
 * `counterfeit` and no `prohibited_item` here: nothing on this surface is for sale.
 */
export const communityContentReportReasonEnum = pgEnum("community_content_report_reason", [
  "spam",
  "misinformation",
  "harassment",
  "off_topic",
  "intellectual_property",
  "other",
]);

export const communityContentReportStatusEnum = pgEnum("community_content_report_status", [
  "open",
  "actioned",
  "dismissed",
]);

export const communityModerationActionKindEnum = pgEnum("community_moderation_action_kind", [
  "thread_published",
  "thread_rejected",
  "thread_locked",
  "thread_unlocked",
  "reply_hidden",
  "reply_restored",
  "report_dismissed",
  /** Phase 19 (§18.3). The cofounder directory shares this queue's decision log. */
  "cofounder_profile_published",
  "cofounder_profile_rejected",
]);

export const communityForumThread = pgTable(
  "community_forum_thread",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    slug: text("slug").notNull(),
    board: communityForumBoardEnum("board").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    /**
     * `set null` on both authors: a deleted account must not take a published thread with
     * it, and the answer somebody relied on stays readable after its author leaves.
     */
    authorUserId: text("author_user_id").references(() => user.id, { onDelete: "set null" }),
    /**
     * NULLABLE, AND THAT IS A REAL DISTINCTION rather than a missing join. Somebody posting
     * as an individual has no organization behind them, and a reader weighing an answer
     * about customs clearance wants to know whether it came from a broker or from a
     * stranger. Rendering a placeholder organization erases exactly the signal this column
     * exists to carry.
     *
     * DERIVED FROM THE CALLER'S ACTIVE ORGANIZATION AT WRITE TIME, never taken from a body.
     */
    authorOrganizationId: text("author_organization_id").references(
      () => commerceOrganization.id,
      { onDelete: "set null" },
    ),
    state: communityForumThreadStateEnum("state").default("pending_review").notNull(),
    /**
     * `null` IS NOT "NOBODY HELPED". Plenty of useful threads never get an accepted answer;
     * this means only that nobody pressed the button. `state = 'answered'` is derived from
     * it and stored so a list row does not have to fetch replies to know.
     */
    acceptedReplyId: text("accepted_reply_id"),
    replyCount: integer("reply_count").default(0).notNull(),
    lastActivityAt: timestamp("last_activity_at", { precision: 3 }).defaultNow().notNull(),
    /** Set when the thread first leaves the queue, and never cleared. */
    publishedAt: timestamp("published_at"),
    moderatedByUserId: text("moderated_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    moderatedAt: timestamp("moderated_at"),
    decisionReason: text("decision_reason"),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { precision: 3 })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("community_forum_thread_slug_uidx").on(table.slug),
    index("community_forum_thread_queue_idx").on(table.state, table.createdAt, table.id),
    /**
     * The public browse. `lastActivityAt` leads the tail because the list is
     * newest-activity first, which is the one ordering a forum can have that is not a
     * ranking — and §18's rule against ranking-as-recommendation is a community rule, not
     * only a cofounder one.
     */
    index("community_forum_thread_browse_idx").on(
      table.board,
      table.state,
      table.lastActivityAt,
      table.id,
    ),
    index("community_forum_thread_author_idx").on(table.authorUserId, table.createdAt, table.id),
    check(
      "community_forum_thread_slug_ck",
      sql`slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) BETWEEN 3 AND 120`,
    ),
    check(
      "community_forum_thread_text_ck",
      sql`char_length(title) BETWEEN 8 AND 200
          AND char_length(body) BETWEEN 20 AND 20000
          AND (decision_reason IS NULL OR char_length(decision_reason) BETWEEN 1 AND 2000)`,
    ),
    check("community_forum_thread_counts_ck", sql`reply_count >= 0`),
    /**
     * A REJECTION MUST CARRY A REASON; an approval need not — the published thread is the
     * explanation, and requiring prose there would be a stricter rule than a moderator's
     * job actually has. The same call `commerce_category_request_review_ck` makes.
     */
    check(
      "community_forum_thread_moderation_ck",
      sql`(state = 'pending_review') = (published_at IS NULL)
          AND (moderated_at IS NULL) = (moderated_by_user_id IS NULL)`,
    ),
    /**
     * A `locked` thread may hold either: locking stops new text, not bookkeeping, so the
     * author can still mark the answer afterwards. Every other state is pinned.
     */
    check(
      "community_forum_thread_answered_ck",
      sql`(state <> 'answered' OR accepted_reply_id IS NOT NULL)
          AND (state NOT IN ('open', 'pending_review') OR accepted_reply_id IS NULL)`,
    ),
  ],
);

export const communityForumReply = pgTable(
  "community_forum_reply",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    threadId: text("thread_id")
      .notNull()
      .references(() => communityForumThread.id, { onDelete: "cascade" }),
    authorUserId: text("author_user_id").references(() => user.id, { onDelete: "set null" }),
    authorOrganizationId: text("author_organization_id").references(
      () => commerceOrganization.id,
      { onDelete: "set null" },
    ),
    body: text("body").notNull(),
    /**
     * A COUNT, NOT A SCORE. There is no downvote on the wire and there must never be one: a
     * negative signal against a named organization on a commerce platform is a reputational
     * act, and this surface has no appeal process to put behind it.
     */
    helpfulCount: integer("helpful_count").default(0).notNull(),
    state: communityForumReplyStateEnum("state").default("visible").notNull(),
    hiddenByUserId: text("hidden_by_user_id").references(() => user.id, { onDelete: "restrict" }),
    hiddenAt: timestamp("hidden_at"),
    hiddenReason: text("hidden_reason"),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { precision: 3 })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("community_forum_reply_thread_idx").on(table.threadId, table.createdAt, table.id),
    index("community_forum_reply_author_idx").on(table.authorUserId, table.createdAt, table.id),
    check(
      "community_forum_reply_text_ck",
      sql`char_length(body) BETWEEN 2 AND 10000
          AND (hidden_reason IS NULL OR char_length(hidden_reason) BETWEEN 1 AND 2000)`,
    ),
    check("community_forum_reply_counts_ck", sql`helpful_count >= 0`),
    /** The hidden columns move as a set, copied from `research_program_post_hidden_ck`. */
    check(
      "community_forum_reply_hidden_ck",
      sql`(state = 'hidden') = (hidden_at IS NOT NULL)
          AND (hidden_at IS NULL) = (hidden_by_user_id IS NULL)`,
    ),
  ],
);

/**
 * ROW PRESENCE IS THE VOTE. No `id`, no `value` column — `commerceProductAnswerVote`'s
 * shape, and the reason `PUT` and `DELETE` of it carry no `Idempotency-Key`: they are
 * idempotent by verb (A24).
 *
 * KEYED ON THE USER, NOT AN ORGANIZATION, and that is the one place this table departs from
 * its commerce sibling. That one keys on the organization so a procurement team does not
 * get five votes for five logins — but a FORUM HAS NO MEMBERS, ONLY AUTHORS, and requiring
 * an organization to endorse an answer would exclude exactly the individuals the nullable
 * `authorOrganizationId` exists to distinguish.
 */
export const communityForumReplyVote = pgTable(
  "community_forum_reply_vote",
  {
    replyId: text("reply_id")
      .notNull()
      .references(() => communityForumReply.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      name: "community_forum_reply_vote_pk",
      columns: [table.replyId, table.userId],
    }),
    /** "Have I endorsed this" for a whole page of replies, in one prefix scan. */
    index("community_forum_reply_vote_user_idx").on(table.userId, table.replyId),
  ],
);

/**
 * A report against community content (§17.4).
 *
 * ITS OWN TABLE rather than two new members on `commerceContentTargetKind`. The precedent
 * is Phase 10, which built `commerceContentReport` instead of generalizing the R&D one,
 * because the two queues are gated by different capabilities and merging them creates "the
 * coupling capabilities exist to prevent". A commerce moderator working a
 * counterfeit-listing queue and a community moderator working an off-topic-thread queue are
 * not the same shift.
 */
export const communityContentReport = pgTable(
  "community_content_report",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    targetKind: communityContentTargetKindEnum("target_kind").notNull(),
    threadId: text("thread_id").references(() => communityForumThread.id, {
      onDelete: "cascade",
    }),
    replyId: text("reply_id").references(() => communityForumReply.id, { onDelete: "cascade" }),
    reason: communityContentReportReasonEnum("reason").notNull(),
    detailText: text("detail_text"),
    reporterUserId: text("reporter_user_id").references(() => user.id, { onDelete: "set null" }),
    status: communityContentReportStatusEnum("status").default("open").notNull(),
    resolvedByUserId: text("resolved_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    resolvedAt: timestamp("resolved_at", { precision: 3 }),
    resolutionNote: text("resolution_note"),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("community_content_report_thread_reporter_uidx")
      .on(table.threadId, table.reporterUserId)
      .where(sql`thread_id IS NOT NULL AND reporter_user_id IS NOT NULL`),
    uniqueIndex("community_content_report_reply_reporter_uidx")
      .on(table.replyId, table.reporterUserId)
      .where(sql`reply_id IS NOT NULL AND reporter_user_id IS NOT NULL`),
    index("community_content_report_queue_idx").on(table.status, table.createdAt, table.id),
    check(
      "community_content_report_target_ck",
      sql`num_nonnulls(thread_id, reply_id) = 1
          AND (target_kind <> 'forum_thread' OR thread_id IS NOT NULL)
          AND (target_kind <> 'forum_reply' OR reply_id IS NOT NULL)`,
    ),
    check(
      "community_content_report_text_ck",
      sql`(detail_text IS NULL OR char_length(detail_text) BETWEEN 1 AND 2000)
          AND (resolution_note IS NULL OR char_length(resolution_note) BETWEEN 1 AND 2000)`,
    ),
    check(
      "community_content_report_resolution_ck",
      sql`(resolved_by_user_id IS NULL) = (resolved_at IS NULL)
          AND (status = 'open') = (resolved_at IS NULL)`,
    ),
  ],
);

/**
 * The community decision log. Mirrors `commerceModerationAction`.
 *
 * TARGETS ARE `set null`, the opposite of the report table's cascade, so the record of a
 * decision survives the thing it was about. `auditEntryId` is NOT NULL so every row names
 * an accountable human.
 */
export const communityModerationAction = pgTable(
  "community_moderation_action",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    actionKind: communityModerationActionKindEnum("action_kind").notNull(),
    threadId: text("thread_id").references(() => communityForumThread.id, {
      onDelete: "set null",
    }),
    replyId: text("reply_id").references(() => communityForumReply.id, { onDelete: "set null" }),
    reportId: text("report_id").references(() => communityContentReport.id, {
      onDelete: "set null",
    }),
    /** Phase 19. The cofounder directory shares this log rather than growing its own. */
    cofounderProfileId: text("cofounder_profile_id").references(
      () => communityCofounderProfile.id,
      { onDelete: "set null" },
    ),
    moderatorUserId: text("moderator_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    moderatorRoleSnapshot: text("moderator_role_snapshot").notNull(),
    reasonNote: text("reason_note").notNull(),
    auditEntryId: text("audit_entry_id")
      .notNull()
      .references(() => platformAuditEntry.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("community_moderation_action_auditEntryId_uidx").on(table.auditEntryId),
    index("community_moderation_action_recent_idx").on(table.createdAt, table.id),
    check(
      "community_moderation_action_reason_ck",
      sql`char_length(reason_note) BETWEEN 1 AND 2000
          AND char_length(moderator_role_snapshot) BETWEEN 1 AND 40`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// COMMUNITY — the cofounder directory (STORE_BACKEND_STRUCTURE.md §18, Appendix A34)
// ---------------------------------------------------------------------------
//
// THE COLUMNS THIS TABLE DOES NOT HAVE ARE THE POINT.
//
// There is no `capitalRangeMinInCents`, no `capitalRangeMaxInCents`, no `currency` and no
// `equityExpectationBasisPoints`. §14 defers whether Qatoto may publish a self-declared
// capital range beside an equity expectation — "close to facilitating a securities
// solicitation, and 'close to' is decided by a lawyer per market, not by a schema" — and
// its instruction is literal: UNTIL DECIDED, THE BACKEND STORES NO CAPITAL FIGURE IT WOULD
// THEN HAVE TO PUBLISH.
//
// A column that exists and is withheld by a projection is one careless edit from being
// published. A column that does not exist cannot be. The wire keeps both fields — the
// frontend contract already types them nullable — and they serve `null` until the decision
// lands, at which point adding them is one additive migration.
//
// WHY NOT EXTEND `talentProfile`, which is genuinely close: the R&D talent directory READS
// that table, and a cofounder row landing in "people open to work on your project" is a
// different claim about a different person's intent. Reuse its SHAPE, and
// `talentProfileSkill`'s tag-table pattern, not its rows.

/**
 * What this person brings.
 *
 * THE FOUR ARE DELIBERATELY NOT INTERCHANGEABLE, and the filter exists because they are the
 * thing a founder is actually short of. `capital` is money; `expertise` is a domain
 * somebody has already done; `influence` is reach — distribution, an audience, a room you
 * cannot get into; `operations` is the person who runs the thing day to day. Claiming all
 * four is itself a signal, so the projection must not collapse them.
 */
export const communityCofounderContributionKindEnum = pgEnum(
  "community_cofounder_contribution_kind",
  ["capital", "expertise", "influence", "operations"],
);

/** How much of themselves they are offering. `advisory` is hours a month, not a job. */
export const communityCofounderCommitmentLevelEnum = pgEnum(
  "community_cofounder_commitment_level",
  ["full_time", "part_time", "advisory"],
);

/**
 * Whether they want to hear from you right now.
 *
 * `not_looking` STAYS VISIBLE in the directory rather than being filtered out, because a
 * profile is also a record — hiding it would make a person who is mid-conversation look as
 * though they had left. The row says so and offers no contact affordance, which is also why
 * the list filter accepts no `state` key.
 */
export const communityCofounderEngagementStateEnum = pgEnum(
  "community_cofounder_engagement_state",
  ["open_to_intros", "in_conversation", "not_looking"],
);

/**
 * TWO VALUES AND NOT A LADDER.
 *
 * `identity_verified` means ONLY that this person is who they say they are. It says nothing
 * about their capital, their track record or their reach, none of which anybody checked — a
 * third rung would be read as verifying the claims.
 *
 * NOT STORED AS A COLUMN. It is derived at read time from `isIdentifiedUser`, the same
 * predicate `requireIdentifiedUser` enforces (§18.4), so the badge cannot go stale and
 * there is only ever one definition of "identified" on this platform. The enum exists so
 * the wire value has a name.
 */
export const communityCofounderIdentityStateEnum = pgEnum(
  "community_cofounder_identity_state",
  ["unverified", "identity_verified"],
);

/** `POST` answers `draft`. Publishing is a separate act behind moderation. */
export const communityCofounderProfileStateEnum = pgEnum("community_cofounder_profile_state", [
  "draft",
  "pending_review",
  "published",
  "withdrawn",
]);

export const communityCofounderProfile = pgTable(
  "community_cofounder_profile",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    slug: text("slug").notNull(),
    /**
     * UNIQUE — one profile per person, and the storage-layer form of the rule that THE
     * VIEWER POSTS ABOUT THEMSELVES AND NEVER ABOUT SOMEBODY ELSE. A directory of people
     * who did not consent to being in it is a different product with a different legal
     * shape, so there is deliberately no route by which one person lists another.
     *
     * `cascade`, unlike the forum's `set null`: a cofounder profile IS a person, so a
     * deleted account must take its own listing with it. A forum answer somebody relied on
     * is a different thing from a personal advertisement nobody stands behind any more.
     */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    /** One line in their own words. Never generated from the enums. */
    headline: text("headline").notNull(),
    bio: text("bio").notNull(),
    /** What they want from the other side. Their words, not a form's summary. */
    lookingFor: text("looking_for").notNull(),
    countryCode: text("country_code").notNull(),
    avatarUrl: text("avatar_url"),
    commitmentLevel: communityCofounderCommitmentLevelEnum("commitment_level").notNull(),
    engagementState: communityCofounderEngagementStateEnum("engagement_state")
      .default("open_to_intros")
      .notNull(),
    state: communityCofounderProfileStateEnum("state").default("draft").notNull(),
    /**
     * "HAS BEEN APPROVED AT LEAST ONCE", set on the first publish and never cleared. Not
     * re-derived on the way back in: a withdrawn profile that is edited and resubmitted
     * still carries it, because it was published once and that stays true.
     */
    publishedAt: timestamp("published_at"),
    moderatedByUserId: text("moderated_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    moderatedAt: timestamp("moderated_at"),
    decisionReason: text("decision_reason"),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { precision: 3 })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("community_cofounder_profile_slug_uidx").on(table.slug),
    uniqueIndex("community_cofounder_profile_user_uidx").on(table.userId),
    /**
     * The directory's keyset. DETERMINISTIC AND BORING ON PURPOSE (§18.1 rule 2): the read
     * takes no `sort` parameter and computes no ranking, because a ranking on this surface
     * could read as a platform recommendation about a person.
     */
    index("community_cofounder_profile_directory_idx").on(
      table.state,
      table.publishedAt,
      table.id,
    ),
    index("community_cofounder_profile_queue_idx").on(table.state, table.createdAt, table.id),
    check(
      "community_cofounder_profile_slug_ck",
      sql`slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) BETWEEN 3 AND 120`,
    ),
    check(
      "community_cofounder_profile_text_ck",
      sql`char_length(display_name) BETWEEN 1 AND 120
          AND char_length(headline) BETWEEN 8 AND 200
          AND char_length(bio) BETWEEN 20 AND 5000
          AND char_length(looking_for) BETWEEN 8 AND 2000
          AND country_code ~ '^[A-Z]{2}$'
          AND (avatar_url IS NULL OR (avatar_url LIKE 'https://%' AND char_length(avatar_url) <= 2048))
          AND (decision_reason IS NULL OR char_length(decision_reason) BETWEEN 1 AND 2000)`,
    ),
    check(
      "community_cofounder_profile_lifecycle_ck",
      sql`(state <> 'published' OR published_at IS NOT NULL)
          AND (state <> 'withdrawn' OR published_at IS NOT NULL)
          AND (moderated_at IS NULL) = (moderated_by_user_id IS NULL)`,
    ),
  ],
);

export const communityCofounderProfileContribution = pgTable(
  "community_cofounder_profile_contribution",
  {
    profileId: text("profile_id")
      .notNull()
      .references(() => communityCofounderProfile.id, { onDelete: "cascade" }),
    contributionKind:
      communityCofounderContributionKindEnum("contribution_kind").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      name: "community_cofounder_profile_contribution_pk",
      columns: [table.profileId, table.contributionKind],
    }),
    /** The reverse lookup the `contributionKind` filter scans. */
    index("community_cofounder_profile_contribution_kind_idx").on(
      table.contributionKind,
      table.profileId,
    ),
  ],
);

/**
 * FREE TEXT, NOT AN ENUM: the long tail here is the whole point, and a closed sector list
 * would refuse exactly the niches a cofounder search is for.
 */
export const communityCofounderProfileSector = pgTable(
  "community_cofounder_profile_sector",
  {
    profileId: text("profile_id")
      .notNull()
      .references(() => communityCofounderProfile.id, { onDelete: "cascade" }),
    sectorLabel: text("sector_label").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      name: "community_cofounder_profile_sector_pk",
      columns: [table.profileId, table.sectorLabel],
    }),
    check(
      "community_cofounder_profile_sector_text_ck",
      sql`char_length(sector_label) BETWEEN 1 AND 60`,
    ),
  ],
);

/**
 * ISO 639-1, lowercase, which the detail read renders as chips. A free-text language field
 * produces "english", "English" and "EN" side by side.
 */
export const communityCofounderProfileLanguage = pgTable(
  "community_cofounder_profile_language",
  {
    profileId: text("profile_id")
      .notNull()
      .references(() => communityCofounderProfile.id, { onDelete: "cascade" }),
    languageCode: text("language_code").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      name: "community_cofounder_profile_language_pk",
      columns: [table.profileId, table.languageCode],
    }),
    check("community_cofounder_profile_language_code_ck", sql`language_code ~ '^[a-z]{2}$'`),
  ],
);

export const communityCofounderPriorVenture = pgTable(
  "community_cofounder_prior_venture",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    profileId: text("profile_id")
      .notNull()
      .references(() => communityCofounderProfile.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    roleLabel: text("role_label").notNull(),
    yearsActiveLabel: text("years_active_label").notNull(),
    /**
     * STAYS NULLABLE. Plenty of ventures have no tidy outcome, and a renderer that requires
     * one invites people to invent one. An absent outcome renders as absent.
     */
    outcomeSummary: text("outcome_summary"),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("community_cofounder_prior_venture_position_uidx").on(
      table.profileId,
      table.position,
    ),
    check(
      "community_cofounder_prior_venture_text_ck",
      sql`char_length(name) BETWEEN 1 AND 160
          AND char_length(role_label) BETWEEN 1 AND 120
          AND char_length(years_active_label) BETWEEN 1 AND 40
          AND (outcome_summary IS NULL OR char_length(outcome_summary) BETWEEN 1 AND 1000)
          AND position >= 0`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Store Phase 20 — lane rate cards and customs dwell
// (STORE_BACKEND_STRUCTURE.md §19.2, §19.3)
// ---------------------------------------------------------------------------
//
// THE MISSING INPUT WAS NEVER AN ENDPOINT — it was data nobody had bought (§19.1). A16's
// coverage-derived estimate says a provider SERVES this lane, not what it CHARGES or how
// long it TAKES by sea versus by air. Forwarders sell lane price lists; these are where
// one lands.
//
// NO SECOND MODE ENUM. `commerceShipmentLegModeEnum` already carries air|sea|land|rail and
// a shipment leg already records one. A parallel enum is how a card becomes unmatchable to
// the shipment it priced (§19.2).
//
// NO `createdByUserId` ON ANY OF THESE. Every write goes through `recordPlatformAction`,
// whose `actorUserId` is NOT NULL — a second copy of the same fact is a second thing to
// drift.

/**
 * `proposed` is DELIBERATELY ABSENT, which is why this is not a reuse of
 * `compensationAgreementStatusEnum`. Nobody ACCEPTS a rate card: an admin keys in a list a
 * forwarder already sold. A `proposed` member would be a state the rating read must
 * remember to exclude, and the reader that forgets prices from a card nobody activated.
 */
export const commerceFreightRateCardStateEnum = pgEnum("commerce_freight_rate_card_state", [
  "active",
  "superseded",
  "withdrawn",
]);

export const commerceFreightRateCard = pgTable(
  "commerce_freight_rate_card",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    /**
     * References `commerceProviderProfile.organizationId`, NOT `commerceOrganization.id`,
     * which is what `commerceServiceOffering` does and for the same reason: the FK then
     * proves STRUCTURALLY that the org is a registered provider, so §0's
     * "providerOrganizationId is never trusted merely because it appears in a body" cannot
     * be violated by a service that forgot to check.
     */
    providerOrganizationId: text("provider_organization_id")
      .notNull()
      .references(() => commerceProviderProfile.organizationId, { onDelete: "restrict" }),
    /**
     * BOTH NOT NULL, unlike `commerceServiceCoverage`'s nullable pair. Coverage says "this
     * provider serves anywhere"; a PRICE is always for a named lane.
     *
     * `origin = destination` is legal and must stay legal — §19.4's inland leg is a
     * domestic lane with a real land rate behind it.
     */
    originCountryCode: text("origin_country_code").notNull(),
    destinationCountryCode: text("destination_country_code").notNull(),
    mode: commerceShipmentLegModeEnum("mode").notNull(),
    currency: text("currency").notNull(),
    validFrom: timestamp("valid_from", { precision: 3 }).notNull(),
    /** NULL = in force with no announced end. Exclusive upper bound. */
    validUntil: timestamp("valid_until", { precision: 3 }),
    /** Who sold us this list. Provenance rides with the number (§19.2, §19.6). */
    sourceForwarderName: text("source_forwarder_name").notNull(),
    state: commerceFreightRateCardStateEnum("state").default("active").notNull(),
    /**
     * BEYOND §19.2, and worth the column. Without it "which card replaced this one" is
     * recoverable only by matching lane plus `valid_until = successor.valid_from`, which is
     * silently wrong the moment two cards share an instant.
     * `compensationPeriod.supersededByPeriodId` is the precedent.
     */
    supersededByRateCardId: text("superseded_by_rate_card_id").references(
      (): AnyPgColumn => commerceFreightRateCard.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { precision: 3 })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    /**
     * The rating read's lane lookup. `validUntil` rides in the index because the read
     * predicate is the WINDOW, not the state — see the partial unique below. Ends in
     * `table.id` so two cards sharing an instant cannot swap places between reads.
     */
    index("commerce_freight_rate_card_lane_idx").on(
      table.originCountryCode,
      table.destinationCountryCode,
      table.mode,
      table.validUntil,
      table.id,
    ),
    index("commerce_freight_rate_card_provider_idx").on(
      table.providerOrganizationId,
      table.state,
      table.id,
    ),
    /**
     * AT MOST ONE ACTIVE CARD PER LANE, PER PROVIDER, PER CURRENCY — the
     * `member_cash_comp_agreement_active_unq` shape.
     *
     * PROVIDER AND CURRENCY ARE IN THE KEY ON PURPOSE. §19.5's `options[]` is plural, so
     * several forwarders quoting one lane at once is the normal case, and §19.1's estimate
     * is per-currency, so a USD card and a EUR card coexist. Dropping either from the key
     * would make the second forwarder's card unstorable.
     *
     * THIS IS A WRITE INVARIANT, NOT THE READ PREDICATE. A future-dated successor flips its
     * incumbent to `superseded` immediately while the incumbent's window is still open, so
     * the rating read selects on the WINDOW plus `state <> 'withdrawn'`. Reading on
     * `state = 'active'` would black out a lane the moment a successor was scheduled.
     */
    uniqueIndex("commerce_freight_rate_card_active_uidx")
      .on(
        table.providerOrganizationId,
        table.originCountryCode,
        table.destinationCountryCode,
        table.mode,
        table.currency,
      )
      .where(sql`state = 'active'`),
    check(
      "commerce_freight_rate_card_country_ck",
      sql`origin_country_code ~ '^[A-Z]{2}$' AND destination_country_code ~ '^[A-Z]{2}$'`,
    ),
    check("commerce_freight_rate_card_currency_ck", sql`currency ~ '^[A-Z]{3}$'`),
    check(
      "commerce_freight_rate_card_window_ck",
      sql`valid_until IS NULL OR valid_until > valid_from`,
    ),
    check(
      "commerce_freight_rate_card_source_ck",
      sql`char_length(source_forwarder_name) BETWEEN 1 AND 200`,
    ),
    /**
     * The lifecycle cannot be half-true. A superseded card names its successor; an active
     * or withdrawn one has none; and no card supersedes itself.
     */
    check(
      "commerce_freight_rate_card_lifecycle_ck",
      sql`(state = 'superseded') = (superseded_by_rate_card_id IS NOT NULL)
          AND (superseded_by_rate_card_id IS NULL OR superseded_by_rate_card_id <> id)`,
    ),
  ],
);

/**
 * One weight/volume band on one card.
 *
 * TRANSIT DAYS LIVE HERE, NOT ON THE CARD (§19.2). An air break and a sea break on one lane
 * have different durations by definition, and a heavier break can route differently — a
 * 40 kg consignment and a 4 t consignment on one lane are not the same journey. Putting the
 * duration on the card forces one number across every weight band, which is the flattening
 * A13 rejected.
 *
 * THE DENOMINATOR OF `unitPriceInCents` IS CENTS PER KILOGRAM OF CHARGEABLE WEIGHT, and §19
 * never states it. The two `min_*` columns are the band's FLOOR — its entry condition — and
 * NOT the denominator: a break is selected as the highest band a consignment clears, then
 * charged `max(unit_price * chargeable_kg, minimum_charge)`. Nothing here may be read as a
 * per-cbm or per-container rate without a `chargeable_unit` column that deliberately does
 * not exist yet.
 */
export const commerceFreightRateBreak = pgTable(
  "commerce_freight_rate_break",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    rateCardId: text("rate_card_id")
      .notNull()
      .references(() => commerceFreightRateCard.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    minBillableWeightGrams: bigint("min_billable_weight_grams", { mode: "number" }).notNull(),
    minVolumeCubicCm: bigint("min_volume_cubic_cm", { mode: "number" }).notNull(),
    /**
     * `integer`, not `bigint`: a per-kilogram rate is a CATALOGUE-SCALE price, the same tier
     * as `commerceServiceOffering.indicativePriceMinInCents`. The rating read widens to
     * bigint BEFORE multiplying by a weight — a 4 t consignment at a plausible rate is
     * comfortably past `integer`.
     */
    unitPriceInCents: integer("unit_price_in_cents").notNull(),
    /** `bigint`: this one is a TOTAL — the floor on the line's charge. */
    minimumChargeInCents: bigint("minimum_charge_in_cents", { mode: "number" }).notNull(),
    transitDaysMin: integer("transit_days_min").notNull(),
    transitDaysMax: integer("transit_days_max").notNull(),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { precision: 3 })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    /** §19.2's `UNIQUE (rateCardId, position)`, verbatim. */
    uniqueIndex("commerce_freight_rate_break_position_uidx").on(table.rateCardId, table.position),
    /**
     * TWO BANDS MAY NOT SHARE A FLOOR. The ladder picks "the highest band this consignment
     * clears"; two rows with the same floor make that pick arbitrary, and an arbitrary pick
     * is a price the platform cannot explain.
     */
    uniqueIndex("commerce_freight_rate_break_floor_uidx").on(
      table.rateCardId,
      table.minBillableWeightGrams,
      table.minVolumeCubicCm,
    ),
    /** The ladder scan itself, ending in a unique column. */
    index("commerce_freight_rate_break_ladder_idx").on(
      table.rateCardId,
      table.minBillableWeightGrams,
      table.id,
    ),
    check(
      "commerce_freight_rate_break_bounds_ck",
      sql`position >= 0 AND min_billable_weight_grams >= 0 AND min_volume_cubic_cm >= 0`,
    ),
    /**
     * `unit_price > 0` because a zero is §19.6's forbidden zero — "an uncovered lane returns
     * an empty options[], never a zero". A zero MINIMUM CHARGE is legitimate: plenty of
     * tariffs have no floor, and refusing one would push admins to type `1`.
     */
    check(
      "commerce_freight_rate_break_price_ck",
      sql`unit_price_in_cents > 0 AND minimum_charge_in_cents >= 0`,
    ),
    check(
      "commerce_freight_rate_break_transit_ck",
      sql`transit_days_min >= 0
          AND transit_days_max >= transit_days_min
          AND transit_days_max <= 365`,
    ),
  ],
);

/**
 * "Clearance on this lane for this commodity takes 3–10 days."
 *
 * NOTHING MODELS THIS TODAY (§19.3). `customs_broker` exists as a `commerce_provider_kind`
 * and its offerings carry lead times, but an offering's lead time is the BROKER's own
 * turnaround, not the PORT's, and the two are not interchangeable.
 *
 * NO `state` COLUMN, unlike the rate card. §19.3 defines none and it needs none: the window
 * IS the lifecycle, and retiring an estimate is closing its window.
 */
export const commerceCustomsDwellEstimate = pgTable(
  "commerce_customs_dwell_estimate",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    /** The clearing country. NOT NULL — dwell is always somebody's border. */
    destinationCountryCode: text("destination_country_code").notNull(),
    /** NULL = any origin — the `commerceServiceCoverage` precedent. */
    originCountryCode: text("origin_country_code"),
    /**
     * §19.3 calls this `commodityScope`; it is spelled `...CategoryId` because it is an FK
     * and every other FK column in this file says what it points at. NULL = any commodity.
     * `restrict` matches `product.categoryId` — §16's admin surface has no DELETE at all,
     * only retire, so this can never fire in normal operation, and if it ever does then
     * refusing is right: a dwell estimate scoped to a category nobody can name is unreadable.
     */
    commodityScopeCategoryId: text("commodity_scope_category_id").references(
      () => commerceCategory.id,
      { onDelete: "restrict" },
    ),
    clearanceDaysMin: integer("clearance_days_min").notNull(),
    clearanceDaysMax: integer("clearance_days_max").notNull(),
    /** The broker or published figure this came from. Provenance, as on the card. */
    source: text("source").notNull(),
    validFrom: timestamp("valid_from", { precision: 3 }).notNull(),
    validUntil: timestamp("valid_until", { precision: 3 }),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { precision: 3 })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    /** The resolver's lookup: destination first, then the two optional narrowings. */
    index("commerce_customs_dwell_estimate_lane_idx").on(
      table.destinationCountryCode,
      table.originCountryCode,
      table.commodityScopeCategoryId,
      table.id,
    ),
    /**
     * AT MOST ONE OPEN-ENDED ESTIMATE PER SCOPE — the rate card's partial-unique move, keyed
     * on the window instead of a state because there is no state.
     *
     * `coalesce` because NULL is a VALUE here ("any origin", "any commodity"), and two rows
     * both claiming "any origin into DE, indefinitely" is the ambiguity this refuses.
     *
     * `WHERE valid_until IS NULL` AND NOT `valid_until > now()`: `now()` is not IMMUTABLE
     * and Postgres refuses it in an index predicate. Overlap between two CLOSED windows is
     * checked in the service and answered 409 — a full exclusion would need a `tstzrange`
     * EXCLUDE constraint and `btree_gist`, an extension this repo does not install for one
     * table.
     */
    uniqueIndex("commerce_customs_dwell_estimate_live_uidx")
      .on(
        table.destinationCountryCode,
        sql`coalesce(origin_country_code, '__any__')`,
        sql`coalesce(commodity_scope_category_id, '__any__')`,
      )
      .where(sql`valid_until IS NULL`),
    /**
     * A DOMESTIC LANE HAS NO CUSTOMS LEG AT ALL (§19.3) — an ABSENT component, not a
     * zero-day one. A row asserting IN→IN dwell would make "not applicable" storable as
     * "known to be short", which is the A11 mistake in a new place.
     */
    check(
      "commerce_customs_dwell_estimate_country_ck",
      sql`destination_country_code ~ '^[A-Z]{2}$'
          AND (origin_country_code IS NULL
               OR (origin_country_code ~ '^[A-Z]{2}$'
                   AND origin_country_code <> destination_country_code))`,
    ),
    check(
      "commerce_customs_dwell_estimate_days_ck",
      sql`clearance_days_min >= 0
          AND clearance_days_max >= clearance_days_min
          AND clearance_days_max <= 365`,
    ),
    check("commerce_customs_dwell_estimate_source_ck", sql`char_length(source) BETWEEN 1 AND 200`),
    check(
      "commerce_customs_dwell_estimate_window_ck",
      sql`valid_until IS NULL OR valid_until > valid_from`,
    ),
  ],
);
