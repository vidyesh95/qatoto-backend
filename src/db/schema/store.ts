import { randomUUID } from "node:crypto";

import { relations, sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  smallint,
  bigint,
  date,
  index,
  uniqueIndex,
  check,
  primaryKey,
  pgEnum,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { session, user } from "#src/db/schema/_core.js";
import { citext, tsvector } from "#src/db/schema/_primitives.js";
import { platformAuditEntry } from "#src/db/schema/platform.js";
import { researchProject } from "#src/db/schema/rnd.js";

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

/**
 * Whose assertion this organization row is (§14, Appendix A37).
 *
 * Every organization starts `pending`, so from Phase 21 a pending row is either a buyer
 * shell the server minted on a first tap or a real applicant asking to be reviewed. Those
 * are two different things wearing one state, and a moderation queue that cannot separate
 * them drowns in shells.
 *
 * NOT an `isAutoProvisioned` boolean: a boolean answers "was it minted?", and the question
 * the queue asks is "is there a person behind this claim yet?". Supplying real legal details
 * flips `auto_provisioned` to `self_declared`, because that write IS the act of asking to be
 * reviewed. Nothing flips it back, and that is convention rather than a CHECK — a constraint
 * forbidding the reverse would also forbid a moderator undoing a mistake.
 */
export const commerceOrganizationProvisioningOriginEnum = pgEnum(
  "commerce_organization_provisioning_origin",
  ["self_declared", "auto_provisioned"],
);

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

/**
 * §20.2. What KIND of answer an attribute takes, and therefore what the buyer can do with it.
 *
 * ⚠️ ONLY `enum` AND `number` ARE FILTERABLE, and `commerce_category_attribute_filterable_ck`
 * enforces it. A filterable free-text attribute produces "Oak", "oak" and "Solid oak" as three
 * separate chips over what sellers meant as one answer — worse than no filter, because it looks
 * authoritative. This is the same split the shipped certification model makes: `standardCode` is a
 * closed enum and filterable, `standardName` is open text and is not.
 */
export const commerceCategoryAttributeValueKindEnum = pgEnum(
  "commerce_category_attribute_value_kind",
  ["enum", "number", "text"],
);

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
    /**
     * A38. An edit changes a published rating, which a seller's storefront is scored on. A
     * moderator reading a content report needs to know whether the text is the text the buyer
     * originally posted, and `edited_at` says only that it changed — not from what.
     */
    "review_edited",
    /** A38's seller half. Its own kind so the audit list can filter by who acted. */
    "review_reply_edited",
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
    /**
     * A seller retracting its OWN claim, which is a different act from a moderator's
     * verdict and therefore not `certification_decided`. It is the only route that reaches
     * `commerce_certification_state.withdrawn`, which sat in the enum unreachable until it
     * shipped.
     */
    "certification_withdrawn",
    /**
     * Phase 13, added to the TYPE by `0073_store_phase_13_enums.sql` and missing from this
     * list until the 0146 snapshot re-baseline compared the enum against the live database.
     * A moderator resolving a ranking appeal or overriding an automatic enforcement lands on
     * the organization chain, beside `certification_decided`, because the suppressed product
     * always has an owning organization. Nothing writes it yet.
     *
     * Payloads for this kind must dodge `FORBIDDEN_PAYLOAD_KEY` in
     * `commerce-organization-audit.service.ts`, which matches `filename` and `object.*key`
     * and THROWS: carry productId / action / penaltyKinds, never a fingerprint, a subnet
     * hash or a raw address.
     */
    "ranking_enforcement_decided",
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
  ["iso_9001", "iso_14001", "bsci", "sedex_smeta", "gots", "fsc", "ce_marking", "fda_registered"],
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

/**
 * §21.2. Whether the SELLER still intends to sell this listing — a declaration about the future.
 *
 * ⚠️ THIS IS NOT `product_status` AND NOT `stock_state`, and collapsing it into either loses the
 * only thing it says. `status` is `draft | active`, an AUTHORING state: whether the listing has
 * been published. `stockState` is DERIVED from `stock_quantity` and the lead times by
 * `deriveStockState`, a MEASUREMENT of what is on hand right now. Neither can express "this is
 * finished and is not coming back", so before this column a buyer ordered a discontinued item and
 * found out from a message.
 *
 * `paused` and `discontinued` are both unpurchasable; the difference is what the buyer is told.
 * Paused is coming back. Discontinued is not, and its page exists to point somewhere else.
 *
 * ⚠️ IT DELIBERATELY DOES NOT GATE VISIBILITY. It is absent from `publicProductEligibility` and
 * from the search document's `isEligible`, so a discontinued listing still answers 200 and still
 * appears in search when asked for. That is the point of the field rather than an oversight: the
 * inbound links keep working and the `replaces` relations stay reachable, which is the only place
 * a buyer learns what to buy instead. Adding it to either predicate deletes the page.
 */
export const productSellingStateEnum = pgEnum("product_selling_state", [
  "selling",
  "paused",
  "discontinued",
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
 * THE TWO KINDS ARE NOT TWO NAMES FOR ONE THING, and the labels are the only place
 * that is written down. A `liked` row is a PUBLIC COUNTER and nothing else — it is
 * never listed back to the person who made it, it says only "this many buyers reacted
 * to this listing". A `bookmarked` row IS the buyer's wishlist and the only thing
 * `GET /commerce/bookmarked-products` returns.
 *
 * `liked` was called `saved` until migration 0120, and that spelling is what made the
 * two collapse into each other: "saved" reads as "kept for later" to every reader, so
 * the list route returned both kinds and a heart tap silently filed a product in the
 * wishlist. Do not reintroduce the word for either kind.
 *
 * The asymmetry has teeth in the ranking: `bookmarked` rows feed the trending score's
 * buyer-engagement component and the subnet-concentration guard (see
 * `commerce-ranking.service.ts`), and `liked` rows feed neither. A like is one tap
 * with no purchase intent behind it and is trivially farmable; a bookmark is a buyer
 * saying they intend to come back.
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
  "liked",
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
 * reviewable statement; "38 of your 40 bookmarks came from one network block" is.
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

/**
 * Incoterms 2020 (A40) — the delivery term a quote states, in the ICC's own two groups.
 *
 * NOT A TRANSPORT MODE, and deliberately not folded into one. `freight_transport_mode` and
 * `commerce_shipment_leg_mode` say HOW goods move; an Incoterm says where risk and cost pass
 * between seller and buyer. §19.2's rule against minting a parallel mode enum is the same
 * instinct pointing the other way here: these are two concepts and one enum cannot hold both.
 *
 * VOCABULARY ONLY. Nothing branches on the value. §19.9's Incoterm CONCEPT — the modelling that
 * would let a priced international leg survive an uncovered inland one — remains open, and this
 * enum neither delivers nor blocks it.
 */
export const commerceIncotermEnum = pgEnum("commerce_incoterm", [
  // Any mode or modes of transport.
  "EXW",
  "FCA",
  "CPT",
  "CIP",
  "DAP",
  "DPU",
  "DDP",
  // Sea and inland waterway transport only.
  "FAS",
  "FOB",
  "CFR",
  "CIF",
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
 * Whether a review's media is still being served by whoever hosts it (A40).
 *
 * TWO VALUES, AND NOT `commerce_ugc_visibility_state`. That enum's four values are all about
 * WHO MODERATED, and its own comment forbids this reuse: "an automatic threshold hide is not a
 * human decision — flattening them would make the moderation queue lie about who acted." Nothing
 * in that list says "YouTube stopped serving this", and picking the closest would attribute a
 * third party's deletion to a moderator.
 *
 * Only a `youtube_video` row can reach the second value — a photo's bytes are on Cloudinary,
 * which this platform controls. `commerce_review_media_upstream_kind_ck` enforces that.
 */
export const commerceReviewMediaStateEnum = pgEnum("commerce_review_media_state", [
  "visible",
  "unavailable_upstream",
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
    /**
     * A37. Defaults to `self_declared` so every row that predates Phase 21 keeps the
     * meaning it was created with — each came through the explicit `POST`, which is a
     * person asserting a company.
     */
    provisioningOrigin: commerceOrganizationProvisioningOriginEnum("provisioning_origin")
      .default("self_declared")
      .notNull(),
    /**
     * NULLABLE since Phase 21, and only while `tradeState = 'pending'` — see
     * `commerce_organization_country_pending_ck`.
     *
     * A country is a FACT, and the server does not have one when it auto-provisions a
     * buyer shell (§14): there is no geo middleware, and `user.locationLabel` is a
     * free-text self-set place whose own comment forbids exactly this use. Alibaba
     * collects a self-declared country at registration; this backend does not, because
     * §0's rule is that a missing component is NAMED rather than defaulted — the same
     * rule §19.4 applies to an uncovered freight lane. Activation is where the country
     * gets established, and it is already a moderator review.
     *
     * Nothing public can observe the NULL: every public read filters
     * `tradeState = 'active'`, which the CHECK makes impossible to reach without one.
     */
    countryCode: text("country_code"),
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
    check(
      "commerce_organization_country_ck",
      sql`country_code IS NULL OR country_code ~ '^[A-Z]{2}$'`,
    ),
    /**
     * The `NOT NULL` Phase 21 dropped, restated where it is actually true. An
     * organization that trades has a country; one that has never traded need not have
     * declared one yet. It lives here rather than only in `transitionTradeState` because
     * §0's posture is that a rule which must survive request replay belongs in the
     * backend, and the cheapest backend is the one a second writer cannot bypass.
     */
    check(
      "commerce_organization_country_pending_ck",
      sql`trade_state = 'pending' OR country_code IS NOT NULL`,
    ),
    /**
     * One auto-provisioned shell per user — the concurrency guard for two simultaneous
     * first taps, not a rule about how many organizations a person may own. The partial
     * predicate is what keeps it narrow: explicitly created organizations are
     * `self_declared` and fall outside the index entirely. A unique violation here is
     * expected traffic, not an error; the loser re-reads and returns the winner's row.
     */
    uniqueIndex("commerce_organization_auto_provisioned_owner_uidx")
      .on(table.createdByUserId)
      .where(sql`provisioning_origin = 'auto_provisioned'`),
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
    // `precision: 3` — LOAD-BEARING: keyset-paginated with a millisecond cursor; a
    // microsecond column makes rows unreachable at every page boundary (store-cursor.ts).
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
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
    /**
     * The ceiling on ONE sample cart/order line. A sample bypasses the tier ladder and the
     * minimum order quantity because both express bulk economics and a sample is the negation
     * of bulk (A17) — which only holds while a sample line stays small. Without this, a buyer
     * orders 1,000 "samples" of a `refundable` product, takes delivery, and
     * `mintSampleCreditsForOrder` mints a credit worth the whole line, spendable against the
     * next order with the same seller. Defaults to 1, so a seller who never thinks about it
     * gets Alibaba's ordinary case rather than an open door.
     */
    maximumSampleQuantity: integer("maximum_sample_quantity").default(1).notNull(),
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
    /** §21.2. The seller's own statement about whether this is still sold. See the enum. */
    sellingState: productSellingStateEnum("selling_state").default("selling").notNull(),
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
    // 20 keeps a legitimate "sample pack" expressible while keeping the cap itself from being
    // set to a number that reopens the hole it exists to close.
    check("product_maximum_sample_quantity_ck", sql`maximum_sample_quantity BETWEEN 1 AND 20`),
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
/**
 * §21.3. What KIND of file a seller attached to a listing.
 *
 * ⚠️ A SEPARATE ENUM FROM `commerce_document_kind`, DELIBERATELY. That one belongs to
 * `commerce_encrypted_document` — business registration, tax registration, identity, bank
 * evidence — which is envelope-encrypted, organization-private and moderator-read. These are
 * public marketing and support files a buyer downloads. Sharing one vocabulary between them
 * would put a datasheet and a passport scan in the same list of words.
 *
 * ⚠️ THERE IS NO `certificate` VALUE, AND THE SPEC ASKED FOR ONE. §21.3 lists it, two
 * paragraphs after §21.3 itself says `commerce_encrypted_document` "is the right home for a
 * business registration certificate and the wrong home for a datasheet" — the spec contradicts
 * itself, the same way its §21.1 "no migration" claim did. `commerce_organization_certification`
 * already carries reviewed compliance claims: a three-way state, a reviewer who may not be the
 * submitter, validity dates, and evidence that never rides the wire. A file a seller drops here
 * labelled "certificate" would look identical to a buyer and have none of that behind it.
 *
 * The asymmetry settles it rather than taste: Postgres cannot DROP an enum value, but adding one
 * is a one-line migration. Four kinds is reversible; five is not.
 */
export const commerceProductDocumentKindEnum = pgEnum("commerce_product_document_kind", [
  "datasheet",
  "manual",
  "care_guide",
  "other",
]);

/**
 * §21.3. A public PDF a buyer can download from a listing — the assembly guide, the care card,
 * the dimensional drawing, the datasheet.
 *
 * MODELLED ON `video_document` (`studio.ts`), NOT on `commerce_encrypted_document`. The latter is
 * private, encrypted and scanned; this is published material a buyer reads BEFORE deciding to
 * talk to anybody, which is a different thing with a different threat model.
 *
 * ⚠️ THERE IS NO `url` COLUMN, AND ADDING ONE WOULD BE A REGRESSION. A URL outlives the gate: a
 * link handed out while the listing was public keeps working after it is unpublished, suspended
 * by a moderator, or its organization's trade state changes, because the bytes do not know the
 * row's visibility changed. Downloads go through
 * `GET /store/products/:productSlug/documents/:documentId/file`, which re-checks the whole §4.4
 * eligibility chain on that request and then 302s to a URL that lives five minutes. The bucket
 * stays private.
 *
 * ⚠️ AND THERE IS NO `state` COLUMN, WHICH IS A DECISION AND NOT AN OMISSION. §21.3 left the scan
 * model open. `video_document` — the precedent this copies — is not scanned at all, and the only
 * working scanner is an EICAR-only fake whose `clamav` sibling returns `SCANNER_UNAVAILABLE`.
 * Unlike the payment factory, that fake IS permitted in production, so a `pending_scan` gate here
 * would stamp every upload `clean` and promote it while implying a review nobody performed. The
 * route therefore answers 201, not 202, and NO COPY ANYWHERE MAY SAY THE FILE IS CHECKED.
 *
 * CONTENT-ADDRESSED: `object_storage_key` is derived from `content_sha256`, never client-supplied,
 * so a retried upload converges on the same object instead of duplicating it. That is why the
 * route carries no `idempotency()` middleware, the same argument the research-paper and
 * video-document routes make.
 *
 * `position` is assigned at insert and NOT re-packed on delete — a gap orders identically, and
 * re-packing would rewrite rows a seller did not touch. ⚠️ This deliberately diverges from
 * `product_image`, which does re-pack and does have a reorder route: a nine-image gallery is
 * curated presentation, five attached files are not.
 */
export const commerceProductDocument = pgTable(
  "commerce_product_document",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    productId: text("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "cascade" }),
    documentKind: commerceProductDocumentKindEnum("document_kind").notNull(),
    /** Derived from `content_sha256`. Never client-supplied — see the table comment. */
    objectStorageKey: text("object_storage_key").notNull(),
    contentSha256: text("content_sha256").notNull(),
    byteSize: integer("byte_size").notNull(),
    /** The uploader's own name, sanitized. Display and download filename only. */
    fileName: text("file_name").notNull(),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("commerce_product_document_product_idx").on(table.productId),
    /**
     * The identity of a document is its bytes. A same-file re-upload converges on this row
     * rather than adding a second copy, which is what makes the route safe without an
     * idempotency key.
     */
    uniqueIndex("commerce_product_document_content_uidx").on(table.productId, table.contentSha256),
    check("commerce_product_document_byte_size_ck", sql`byte_size > 0`),
    check("commerce_product_document_sha_ck", sql`content_sha256 ~ '^[0-9a-f]{64}$'`),
    check("commerce_product_document_position_ck", sql`position >= 0`),
    check("commerce_product_document_file_name_ck", sql`char_length(file_name) BETWEEN 1 AND 120`),
  ],
);

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

/**
 * §20.2. One question a category asks of every listing under it — "Voltage", "Wood type", "Size".
 *
 * ⚠️ INHERITED DOWN THE TREE, AND THAT IS WHAT MAKES THE FEATURE WORK. An attribute on
 * `electronics` applies to every leaf beneath it; the resolved set for a product is the union
 * along its category trail, nearer definitions shadowing farther ones on the same `attributeKey`.
 * Without inheritance an admin authors "voltage" once per leaf, the copies drift, and two leaves
 * end up with `voltage` and `voltage_volts` — the free-text problem re-created one level up, in
 * the one place that was supposed to be canonical.
 *
 * ⚠️ `attributeKey` IS A WIRE IDENTITY, not a label. A stored value points at this row through
 * `attributeId` and a buyer's saved filter link names the KEY, so it is absent from the PATCH body
 * for the same reason `commerce_category.slug` is: an attribute that needs a different key is a
 * new attribute.
 *
 * NO UNIQUE INDEX ON `(categoryId, position)`, deliberately, and it is a departure from the
 * sibling-order rule `commerce_category` follows. That table can enforce it because its reorder
 * route rewrites a whole sibling set in two passes; an attribute set CANNOT be rewritten that way,
 * because `commerce_product_attribute_value.attributeId` is `ON DELETE RESTRICT` and a replace-set
 * would fail the moment one listing used one. Position is therefore an ordering hint and ties
 * break on `attributeKey`, which is stable — so the order is deterministic without a constraint
 * that would block inserting at 3.
 */
export const commerceCategoryAttribute = pgTable(
  "commerce_category_attribute",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    /**
     * `restrict`, matching `product.categoryId`: a category with attributes cannot be deleted out
     * from under the values that point at them. `retire` is the taxonomy's only exit anyway.
     */
    categoryId: text("category_id")
      .notNull()
      .references(() => commerceCategory.id, { onDelete: "restrict" }),
    attributeKey: text("attribute_key").notNull(),
    label: text("label").notNull(),
    /** Becomes the tab on the buyer's spec sheet. NULL is ungrouped. */
    groupLabel: text("group_label"),
    valueKind: commerceCategoryAttributeValueKindEnum("value_kind").notNull(),
    /** `number` only — "V", "mm", "kg". Rendered as a suffix, never parsed back out of a string. */
    unitLabel: text("unit_label"),
    /**
     * `number` only. FIXED POINT, and the scale lives HERE rather than on the value row so two
     * values for one attribute cannot disagree about what `4700` means. Same shape as the FX rate
     * on a quote revision (`rateFixedPoint` / `rateScale`).
     */
    numericScale: smallint("numeric_scale"),
    isFilterable: boolean("is_filterable").default(false).notNull(),
    isRequiredForPublish: boolean("is_required_for_publish").default(false).notNull(),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("commerce_category_attribute_key_uidx").on(table.categoryId, table.attributeKey),
    index("commerce_category_attribute_category_idx").on(
      table.categoryId,
      table.position,
      table.attributeKey,
    ),
    /** snake_case on the wire, like every pgEnum label and every `choiceValue` below. */
    check("commerce_category_attribute_key_ck", sql`attribute_key ~ '^[a-z0-9]+(_[a-z0-9]+)*$'`),
    check(
      "commerce_category_attribute_text_ck",
      sql`char_length(attribute_key) BETWEEN 1 AND 64
          AND char_length(label) BETWEEN 1 AND 120
          AND (group_label IS NULL OR char_length(group_label) BETWEEN 1 AND 80)
          AND (unit_label IS NULL OR char_length(unit_label) BETWEEN 1 AND 24)`,
    ),
    /**
     * The unit and the scale belong to `number` and to nothing else, and a `number` MUST carry a
     * scale — otherwise a stored `4700` is an integer nobody can render.
     */
    check(
      "commerce_category_attribute_numeric_ck",
      sql`(value_kind = 'number') = (numeric_scale IS NOT NULL)
          AND (unit_label IS NULL OR value_kind = 'number')
          AND (numeric_scale IS NULL OR numeric_scale BETWEEN 0 AND 6)`,
    ),
    /** See the enum: a filterable free-text attribute is worse than no filter. */
    check(
      "commerce_category_attribute_filterable_ck",
      sql`NOT (is_filterable AND value_kind = 'text')`,
    ),
    check("commerce_category_attribute_position_ck", sql`position >= 0`),
  ],
);

/**
 * §20.2. One allowed answer for an `enum` attribute — "3v3", "5v", "12v".
 *
 * `choiceValue` is snake_case and is what a filter names in the query string; `label` is what the
 * chip says. The two are separate for the same reason `standardCode` and `standardName` are.
 *
 * CASCADE from the attribute, unlike everything else here: a choice has no meaning without its
 * question, and the RESTRICT on `commerce_product_attribute_value.choiceId` is what actually stops
 * a choice in use from disappearing.
 */
export const commerceCategoryAttributeChoice = pgTable(
  "commerce_category_attribute_choice",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    attributeId: text("attribute_id")
      .notNull()
      .references(() => commerceCategoryAttribute.id, { onDelete: "cascade" }),
    choiceValue: text("choice_value").notNull(),
    label: text("label").notNull(),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("commerce_category_attribute_choice_uidx").on(table.attributeId, table.choiceValue),
    index("commerce_category_attribute_choice_attribute_idx").on(
      table.attributeId,
      table.position,
      table.choiceValue,
    ),
    check(
      "commerce_category_attribute_choice_value_ck",
      sql`choice_value ~ '^[a-z0-9]+(_[a-z0-9]+)*$' AND char_length(choice_value) BETWEEN 1 AND 64`,
    ),
    check("commerce_category_attribute_choice_label_ck", sql`char_length(label) BETWEEN 1 AND 120`),
    check("commerce_category_attribute_choice_position_ck", sql`position >= 0`),
  ],
);

/**
 * §20.2. One listing's answer to one attribute.
 *
 * ⚠️ EXACTLY ONE VALUE COLUMN IS POPULATED, and `..._one_value_ck` enforces it rather than leaving
 * three nullable columns and hope. Which one is decided by the attribute's `valueKind`, which SQL
 * cannot reach from here — the service checks that pairing, and this CHECK stops the shape that
 * would be meaningless either way.
 *
 * `attributeId` is `restrict`: a definition in use cannot be deleted, which is why the admin exit
 * is `isFilterable → false` rather than DELETE. `productId` cascades, because a value is part of
 * the listing and means nothing without it.
 */
export const commerceProductAttributeValue = pgTable(
  "commerce_product_attribute_value",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    productId: text("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "cascade" }),
    attributeId: text("attribute_id")
      .notNull()
      .references(() => commerceCategoryAttribute.id, { onDelete: "restrict" }),
    choiceId: text("choice_id").references(() => commerceCategoryAttributeChoice.id, {
      onDelete: "restrict",
    }),
    /** Already multiplied by the DEFINITION's `numericScale`. No decimal crosses the wire. */
    numericValueScaled: bigint("numeric_value_scaled", { mode: "number" }),
    textValue: text("text_value"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("commerce_product_attribute_value_uidx").on(table.productId, table.attributeId),
    /** The enum facet and its filter: "which products answer `5v`". */
    index("commerce_product_attribute_value_choice_idx").on(table.attributeId, table.choiceId),
    /** The range filter and the min/max facet. */
    index("commerce_product_attribute_value_numeric_idx").on(
      table.attributeId,
      table.numericValueScaled,
    ),
    check(
      "commerce_product_attribute_value_one_value_ck",
      sql`num_nonnulls(choice_id, numeric_value_scaled, text_value) = 1`,
    ),
    check(
      "commerce_product_attribute_value_text_ck",
      sql`text_value IS NULL OR char_length(text_value) BETWEEN 1 AND 500`,
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
 * Per-user likes and bookmarks (STORE Appendix A11).
 *
 * ONE table for both kinds, still — but NOT for the reason first written here. The
 * original argument was that "BOTH kinds are rendered lists, so one index shape serves
 * both", which stopped being true at migration 0120: a like is now a public counter
 * and is never listed back to anyone. The video domain splits `video_like` from
 * `video_save` on exactly that distinction, and its own service comment concedes the
 * price — the save toggle there is "byte-for-byte the like toggle, against a different
 * table and counter."
 *
 * The table stays whole because the split would buy that duplication and nothing else.
 * The composite primary key already makes a double-tap harmless for either gesture, and
 * `commerce_product_engagement_user_idx` leads with `(userId, engagementKind)`, so the
 * bookmark list is a kind-filtered range scan that a dedicated table could not serve
 * faster. A like needs only a membership probe, which the same primary key answers.
 *
 * CASCADE on both sides: neither a deleted user nor a deleted product leaves a
 * meaningful bookmark behind. Note these rows ARE referenced downstream — the
 * `bookmarked` half feeds the trending score and the subnet guard in
 * `commerce-ranking.service.ts` — so a cascade here silently moves a ranking input.
 * That is correct: a deleted user's intent should stop counting.
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
     * Salted /24 (IPv4) or /56 (IPv6) hash of the marking user's network block (Phase 13).
     *
     * WRITTEN FOR BOTH KINDS, READ FOR ONE. Every set-direction toggle records a subnet,
     * but since 0120 only the `bookmarked` rows are measured — the concentration guard
     * scores purchase intent, and a like is too cheap to be worth faking against.
     *
     * NULLABLE AND NEVER BACKFILLABLE — no address was recorded on any commerce row before
     * Phase 13, and the ones behind existing rows are gone. The subnet concentration
     * guard is therefore INERT until rows accumulate, and 0120 reset that clock by
     * narrowing the population it reads.
     *
     * The rule the scorer must honour: a null is not evidence of low concentration.
     * "0 of 40 bookmarks carry a subnet" means UNMEASURED, and the guard is skipped below
     * a minimum hashed sample. Treating null as concentration 0 would clear every product
     * for months and then start penalising as coverage grew.
     */
    subnetHash: text("subnet_hash"),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.productId, table.userId, table.engagementKind] }),
    /**
     * "My bookmarked products", newest first — the one list this table renders.
     *
     * Leading with `engagementKind` is what lets the same index answer a like-membership
     * probe without a second index for it.
     */
    index("commerce_product_engagement_user_idx").on(
      table.userId,
      table.engagementKind,
      table.createdAt,
      table.productId,
    ),
    /** Counter reconciliation in the phase verifier. */
    index("commerce_product_engagement_product_idx").on(table.productId, table.engagementKind),
    /** "For THIS product, how are bookmarks distributed across network blocks?" */
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
    /** Bookmarks in W1. Counted hearts before migration 0120 — see that file's tail. */
    bookmarksW1: integer("bookmarks_w1").notNull(),
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
          AND distinct_qualified_buyers_w1 >= 0 AND counted_views_w1 >= 0 AND bookmarks_w1 >= 0
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
    /** Bookmarks that day. Counted hearts before migration 0120 — see that file's tail. */
    bookmarks: integer("bookmarks").default(0).notNull(),
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
    /** The PUBLIC like counter — what the heart shows every visitor. */
    likeCount: integer("like_count").default(0).notNull(),
    /** How many buyers put this in their wishlist. Also a ranking input. */
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
      sql`like_count >= 0 AND bookmarked_count >= 0 AND share_count >= 0
          AND question_count >= 0 AND answered_question_count >= 0
          AND answered_question_count <= question_count
          AND view_count >= 0
          AND (unique_viewer_count IS NULL OR (unique_viewer_count >= 0 AND unique_viewer_count <= view_count))`,
    ),
    index("commerce_product_stats_like_idx").on(table.likeCount, table.productId),
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
    /**
     * NULLABLE since Phase 21, mirroring `commerce_organization.countryCode`.
     *
     * A document is written for EVERY organization, not only eligible ones — that is what
     * `isEligible` is for, and it is why a suspended catalog stops steering supplier search
     * without its documents being deleted. An auto-provisioned buyer shell therefore gets a
     * document with no country to copy, and an ineligible document with a NULL country
     * simply fails to match the country filter, which is the right answer.
     *
     * Every ELIGIBLE document still has one — see
     * `store_search_document_eligible_country_ck`.
     */
    organizationCountryCode: text("organization_country_code"),
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
    /**
     * §21.2. NULLABLE, unlike the column on `product`, because this table holds provider
     * offerings and organizations too and neither has a selling state. The filter therefore has
     * to read `IS NULL OR <> 'discontinued'` rather than a bare inequality — a bare one would
     * drop every offering and supplier from an unfiltered search.
     *
     * ⚠️ IT IS A COLUMN HERE RATHER THAN A TERM IN `isEligible` ON PURPOSE. `isEligible` is
     * element [0] of `buildStoreSearchFilters` with no `omit` escape, so folding selling state
     * into it would remove a discontinued listing from the results AND from every facet count,
     * which is the opposite of making it filterable.
     */
    sellingState: productSellingStateEnum("selling_state"),
    providerVerificationState: commerceProviderVerificationStateEnum("provider_verification_state"),
    leadTimeMaxDays: integer("lead_time_max_days"),
    /**
     * §21.1. The manufacturer part code, denormalized so an EXACT match can be RANKED rather
     * than merely found.
     *
     * `model_number` is already folded into `search_text`, which made it FINDABLE — but
     * `search_document` weights that whole blob at class `C`, so a listing whose TITLE happens
     * to contain `LM358` still outranks the listing that actually carries it. Ranking the
     * carrier first means comparing against the VALUE, and a comparison needs the value here:
     * joining back to `product` would defeat every keyset index the three sort branches rely on,
     * the same argument that put `discoveryScorePoints` and the A25 facet columns on this table.
     *
     * NULLABLE, like `categorySlug` and `sellingState` above and for the same reason: this table
     * also holds provider offerings and organizations, and neither is a manufactured part.
     *
     * ⚠️ NEVER UNIQUE. Two sellers listing the same manufacturer part is the PREMISE of a
     * parametric marketplace, not a data error — Octopart's whole value is that `LM358` returns
     * many offers. Uniqueness belongs on `sku`, which already has it per seller organization.
     *
     * ⚠️ AND NOT A TERM IN `isEligible`, for the reason `sellingState` spells out above.
     */
    modelNumber: text("model_number"),
    /**
     * The comparison key for the boost: lowercased with every non-alphanumeric stripped, so
     * `LM358`, `lm-358` and `LM 358` compare equal. Buyers type a part code with and without
     * its separators, and those are the same part.
     *
     * ⚠️ GENERATED AND STORED, NOT COMPUTED PER ROW. `regexp_replace(model_number, ...)` in a
     * predicate is a function-on-column: no plain btree can serve it, so every search would
     * scan. Generating it pays the normalization once at write time, exactly as
     * `search_document` already pays `to_tsvector` once.
     *
     * ⚠️ THIS EXPRESSION HAS A TWIN IN TYPESCRIPT — `normalizeModelNumberQuery` in
     * `store-search.service.ts` normalizes the QUERY side and MUST stay byte-for-byte
     * equivalent to it. A generated column cannot call application code, so one rule genuinely
     * lives in two places here; drift between the two silently stops exact matches from
     * matching. ASCII-only, deliberately: a non-ASCII part code normalizes to whatever survives
     * `[^a-zA-Z0-9]`, which is a stated limit rather than a hidden one.
     *
     * `NULLIF(..., '')` so a code made entirely of punctuation collapses to NULL rather than to
     * an empty string that would equal every other such code.
     */
    modelNumberNormalized: text("model_number_normalized").generatedAlwaysAs(
      sql`NULLIF(lower(regexp_replace(model_number, '[^a-zA-Z0-9]', '', 'g')), '')`,
    ),
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
    /**
     * Indexes `category_id`, which NO QUERY PATH READS — the filters and the Phase 22 facets
     * both scope on `categorySlug`, because `listActiveCategorySubtreeSlugs` returns slugs.
     * Kept for the FK and its `ON DELETE SET NULL`; see the partial sibling below for the one
     * the reads actually use.
     */
    index("store_search_document_category_idx").on(table.categoryId, table.id),
    /**
     * A39. The facet scan. Every facet query scopes by category slug and by eligibility, and
     * grouping one category's rows is the hottest read on this table since Phase 22 moved the
     * counts here. Partial on `is_eligible` like its three siblings below.
     */
    index("store_search_document_eligible_category_idx")
      .on(table.isEligible, table.categorySlug, table.id)
      .where(sql`is_eligible`),
    index("store_search_document_provider_kind_idx").on(table.providerKind, table.id),
    index("store_search_document_fts_idx").using("gin", table.searchDocument),
    index("store_search_document_stock_idx")
      .on(table.isEligible, table.stockState, table.id)
      .where(sql`is_eligible`),
    /**
     * §21.2. Mirrors the stock index above. Every search runs a selling-state predicate — the
     * default one excludes `discontinued` even when the caller asked for nothing — so this is on
     * the hot path rather than only on an explicit filter.
     */
    index("store_search_document_selling_idx")
      .on(table.isEligible, table.sellingState, table.id)
      .where(sql`is_eligible`),
    index("store_search_document_price_idx")
      .on(table.isEligible, table.priceInCents, table.id)
      .where(sql`is_eligible`),
    /**
     * §21.1. Mirrors the stock and selling indexes: `isEligible` leads because every search and
     * every facet count runs that gate first. The part-code arm of the membership predicate is
     * an EQUALITY on the normalized column, which is what this serves.
     */
    index("store_search_document_model_number_idx")
      .on(table.isEligible, table.modelNumberNormalized, table.id)
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
    check(
      "store_search_document_country_ck",
      sql`organization_country_code IS NULL OR organization_country_code ~ '^[A-Z]{2}$'`,
    ),
    /**
     * An eligible document is a public one, and a public row with no country would be a
     * hole in the facet counts rather than a missing filter match. The organization-side
     * `commerce_organization_country_pending_ck` already makes this unreachable; this
     * restates it on the search table so a future writer bypassing the refresh path cannot
     * open the hole quietly.
     */
    check(
      "store_search_document_eligible_country_ck",
      sql`is_eligible = false OR organization_country_code IS NOT NULL`,
    ),
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
    // `precision: 3` — LOAD-BEARING: keyset-paginated with a millisecond cursor; a
    // microsecond column makes rows unreachable at every page boundary (store-cursor.ts).
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
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

/**
 * Documents attached to ONE submitted quote revision (A30's provider half).
 *
 * ⚠️ KEYED ON THE REVISION, NOT THE QUOTE, AND THAT IS THE WHOLE DESIGN. A revision is the
 * immutable submitted offer — `commerce_prevent_submitted_quote_revision_mutation` freezes its
 * commercial terms the moment it is submitted — and its supporting documents are part of that
 * offer. Keying on `commerce_quote` would give one document set to every revision, so a provider
 * could swap the spec sheet behind an offer a buyer had already read and judged. A revised offer
 * gets revised documents; the old revision keeps the ones it was accepted or rejected with.
 *
 * The same argument `commerce_order_product_line` makes for snapshotting its title and price.
 *
 * MIRRORS `commerce_rfq_document` EXACTLY — the buyer's half of the same feature — including both
 * `restrict` foreign keys: a document that is cited by an offer must stay resolvable, and so must
 * the member who attached it.
 */
export const commerceQuoteRevisionDocument = pgTable(
  "commerce_quote_revision_document",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    revisionId: text("revision_id")
      .notNull()
      .references(() => commerceQuoteRevision.id, { onDelete: "cascade" }),
    encryptedDocumentId: text("encrypted_document_id")
      .notNull()
      .references(() => commerceEncryptedDocument.id, { onDelete: "restrict" }),
    attachedByMemberId: text("attached_by_member_id")
      .notNull()
      .references(() => commerceOrganizationMember.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("commerce_quote_revision_document_uidx").on(
      table.revisionId,
      table.encryptedDocumentId,
    ),
    index("commerce_quote_revision_document_revision_idx").on(table.revisionId),
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
    // `precision: 3` — LOAD-BEARING: keyset-paginated with a millisecond cursor; a
    // microsecond column makes rows unreachable at every page boundary (store-cursor.ts).
    updatedAt: timestamp("updated_at", { precision: 3 })
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
    /**
     * A40. An enum since Phase 23; `text` with a 1..20 length check before that, which accepted
     * `BANANA` and let `commerce_prevent_submitted_quote_revision_mutation` freeze it forever.
     *
     * VOCABULARY ONLY. Nothing branches on the value — §19.9's Incoterm CONCEPT, the one that
     * would let an uncovered inland leg stop making a whole journey unpriceable, is a different
     * and larger piece of work and stays open.
     */
    incoterm: commerceIncotermEnum("incoterm"),
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
      // A40. The `incoterm` length clause was dropped in `0116`: an enum cannot be 21
      // characters long, and a constraint that cannot fail reads as a rule still to satisfy.
      sql`(payment_terms IS NULL OR char_length(payment_terms) <= 2000)
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
    /**
     * A40. The same enum as the revision it is copied from. It was `text` with NO check at all
     * — less constrained than its own source — until Phase 23.
     */
    incotermSnapshot: commerceIncotermEnum("incoterm_snapshot"),
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
    // `precision: 3` — LOAD-BEARING: keyset-paginated with a millisecond cursor; a
    // microsecond column makes rows unreachable at every page boundary (store-cursor.ts).
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
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
    // `precision: 3` — LOAD-BEARING: keyset-paginated with a millisecond cursor; a
    // microsecond column makes rows unreachable at every page boundary (store-cursor.ts).
    updatedAt: timestamp("updated_at", { precision: 3 })
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
    // `precision: 3` — LOAD-BEARING: keyset-paginated with a millisecond cursor; a
    // microsecond column makes rows unreachable at every page boundary (store-cursor.ts).
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
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
    // `precision: 3` — LOAD-BEARING: keyset-paginated with a millisecond cursor; a
    // microsecond column makes rows unreachable at every page boundary (store-cursor.ts).
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
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
    // `precision: 3` — LOAD-BEARING: keyset-paginated with a millisecond cursor; a
    // microsecond column makes rows unreachable at every page boundary (store-cursor.ts).
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
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
    /**
     * Phase 25. The seller side of the same question, for `GET /commerce/provider/earnings`.
     *
     * PARTIAL ON `settled_at IS NOT NULL`: an intent that never settled contributes nothing to
     * any earnings figure by definition, so the rows the sum must exclude stay out of the index.
     */
    index("commerce_payment_intent_counterparty_idx")
      .on(table.counterpartyOrganizationId, table.state, table.settledAt)
      .where(sql`settled_at IS NOT NULL`),
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
    // `precision: 3` — LOAD-BEARING: keyset-paginated with a millisecond cursor; a
    // microsecond column makes rows unreachable at every page boundary (store-cursor.ts).
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
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
    /**
     * A38. When the author last edited, and — because there is exactly ONE edit — also whether
     * the edit has been spent. NULL means never edited.
     *
     * NOT `updatedAt`, which carries `$onUpdate` and therefore moves on every helpful vote and
     * every photo attach above. It cannot say "the text changed" and it cannot say "the one
     * edit is used", which are the only two questions the edit window asks.
     *
     * One edit within 30 days is Alibaba's rule. Amazon allows unlimited edits and deletion at
     * any time, and funds an anti-manipulation team to absorb the consequences; on five-figure
     * B2B orders an unbounded delete is an extortion lever, so the bound lives here.
     */
    editedAt: timestamp("edited_at", { precision: 3 }),
    // `precision: 3` — LOAD-BEARING: keyset-paginated with a millisecond cursor; a
    // microsecond column makes rows unreachable at every page boundary (store-cursor.ts).
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
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
    /**
     * A40. Whether whoever hosts this still serves it.
     *
     * `attachReviewVideo` stores a well-formed YouTube id WITHOUT checking the video resolves,
     * so a review rendered a dead player indefinitely — on the surface a buyer reads to decide
     * whether to trust a seller. `revalidate-youtube-embeds` flips this nightly.
     *
     * HIDDEN, NOT DELETED: a buyer's testimony must not be erased because a third party removed
     * a file, and a video that returns (unlisted → public) comes back with it. The row keeps its
     * `position` for exactly that reason — see `commerce_review_media_position_uidx` below.
     */
    state: commerceReviewMediaStateEnum("state").default("visible").notNull(),
    unavailableAt: timestamp("unavailable_at", { precision: 3 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    /**
     * A40. A hidden row KEEPS ITS SLOT, so this index still spans every row rather than the
     * visible ones. `repackReviewMediaPositions` is deliberately not run on a hide: repacking
     * would free a sixth slot and quietly turn the six-item cap into "six visible" rather than
     * "six attached", which is a rule nobody agreed to and one a caller could then exploit by
     * attaching seven and letting one die.
     */
    uniqueIndex("commerce_review_media_position_uidx").on(table.reviewId, table.position),
    /** A40. The gallery reads only visible rows; an unavailable one has no business in it. */
    index("commerce_review_media_visible_idx")
      .on(table.reviewId, table.position)
      .where(sql`state = 'visible'`),
    /** A40. The two facts are one fact — neither is readable without the other. */
    check(
      "commerce_review_media_state_ck",
      sql`(state = 'unavailable_upstream') = (unavailable_at IS NOT NULL)`,
    ),
    /**
     * A40. A PHOTO CANNOT VANISH UPSTREAM — its bytes are on Cloudinary, which this platform
     * controls. Only a third-party embed has a host that can stop serving it.
     */
    check(
      "commerce_review_media_upstream_kind_ck",
      sql`state = 'visible' OR media_kind = 'youtube_video'`,
    ),
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
    /**
     * A38. The mirror of `commerce_review.editedAt`, and the seller's half of the same bound.
     *
     * This reply was unlimited-edit and unlimited-delete until Phase 21 — the inverse abuse of
     * the buyer side: post something conciliatory in public, then swap or remove it once the
     * buyer relents. Alibaba caps a supplier's reply at one modification within 30 days and
     * this matches it.
     *
     * An explicit column even though `updatedAt` would currently serve, because nothing else
     * writes this row TODAY. That is an accident of the present schema rather than a guarantee,
     * and the first counter added here would silently break the flag.
     */
    editedAt: timestamp("edited_at", { precision: 3 }),
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
    // `precision: 3` — LOAD-BEARING: keyset-paginated with a millisecond cursor; a
    // microsecond column makes rows unreachable at every page boundary (store-cursor.ts).
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
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
    authorOrganizationId: text("author_organization_id").references(() => commerceOrganization.id, {
      onDelete: "set null",
    }),
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
    authorOrganizationId: text("author_organization_id").references(() => commerceOrganization.id, {
      onDelete: "set null",
    }),
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
export const communityCofounderIdentityStateEnum = pgEnum("community_cofounder_identity_state", [
  "unverified",
  "identity_verified",
]);

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
    index("community_cofounder_profile_directory_idx").on(table.state, table.publishedAt, table.id),
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
    contributionKind: communityCofounderContributionKindEnum("contribution_kind").notNull(),
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
    /**
     * §19.9. The forwarder's own volumetric divisor, in cm³ per kilogram.
     *
     * FREIGHT BILLS ON `max(actual weight, volumetric weight)`, and without this column Phase 20
     * rated on actual weight alone — which UNDERPRICES a light bulky consignment. That was the one
     * defect in the phase that produced a WRONG number rather than a missing one.
     *
     * NOT NULL AND NO DEFAULT, deliberately. The divisor is a tariff convention and it varies by
     * forwarder as well as by mode — air is 5000 or 6000 depending on who is quoting, ocean LCL is
     * 1000 (the W/M "revenue ton": one cubic metre billed as 1000 kg), road is around 3000. A
     * DEFAULT would be the platform choosing a convention on the forwarder's behalf, which is the
     * error §19.4 refuses everywhere else. Requiring it costs nothing because it landed while the
     * table was still empty.
     */
    volumetricDivisorCm3PerKg: integer("volumetric_divisor_cm3_per_kg").notNull(),
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
    /**
     * The bound catches a transposed figure, not a policy. Every real convention sits inside it:
     * ocean LCL 1000, road ~3000, air 5000–6000.
     */
    check(
      "commerce_freight_rate_card_volumetric_divisor_ck",
      sql`volumetric_divisor_cm3_per_kg BETWEEN 100 AND 20000`,
    ),
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
