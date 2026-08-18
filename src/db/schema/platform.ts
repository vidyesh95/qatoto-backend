import { randomUUID } from "node:crypto";

import { relations, sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  integer,
  index,
  uniqueIndex,
  check,
  pgEnum,
} from "drizzle-orm/pg-core";

import { user } from "#src/db/schema/_core.js";
import { platformRoleEnum } from "#src/db/schema/_primitives.js";
import { researchProject } from "#src/db/schema/rnd.js";

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
  /**
   * §3.3a — THE ONE READ IN THIS CHAIN, and it is here on purpose.
   *
   * Every other kind above records a WRITE, because a chain of reads would be a chain nobody
   * could find anything in. `GET /admin/metrics/users` is the exception: it answers "who watches
   * the most" and "who has gone quiet" with named accounts, assembled from a behavioural record
   * those people cannot see being assembled. Looking at that is an exercise of authority over
   * other people's data even though it changes nothing, which is the definition this chain uses.
   *
   * The four AGGREGATE metrics endpoints are deliberately absent: DAU is nobody's personal data,
   * and stamping the chain on every dashboard refresh would bury the entries that name a person.
   */
  "platform_metrics_user_segment_viewed",
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
