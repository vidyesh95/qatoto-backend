// ---------------------------------------------------------------------------
// What the anonymization scrub does to every column that points at `user`.
//
// ## ⚠️ THE THING THIS FILE EXISTS BECAUSE OF
//
// Rule R2 (src/db/schema/rnd.ts) classified all 163 of these foreign keys for a
// `DELETE FROM "user"` — `cascade` for a preference that dies with the account, `set null`
// for attribution that must never block one, `restrict` for anything bearing equity, effort
// or audit weight.
//
// THAT DELETE NEVER HAPPENS. It cannot: 73 of these are `restrict`, and 54 tables carry
// BEFORE UPDATE OR DELETE triggers. Account closure here is an ANONYMIZATION, which is the
// point — it is what stops one person's erasure destroying another person's financial record.
//
// So `ON DELETE cascade` and `ON DELETE set null` FIRE ZERO TIMES in this flow. All 35
// cascades and all set-nulls are decorative unless something issues the statement by
// hand, and this manifest is that hand. A column missing from here is PII that survives an
// erasure forever, silently. `idempotency_record.user_id` is the one to think about if that
// sounds theoretical: it is `cascade`, and it caches whole response bodies.
//
// ## THERE IS NO `cascade_on_delete` DISPOSITION, ON PURPOSE
//
// A verdict meaning "the foreign key handles it" would be a no-op that reads as coverage —
// exactly the failure this file is here to prevent. Three verdicts, each of which names a
// statement somebody actually runs, or a reason nobody does.
//
// ## THIS FILE IS THE JOB, NOT A DESCRIPTION OF IT
//
// `anonymize-account.ts` derives its step list by ITERATING this object. Nothing there
// re-states a table name. That is what stops the manifest being right while the job is
// wrong — the two cannot disagree, because there is only one of them.
//
// `pnpm db:verify-anonymization-coverage` walks information_schema for every FK referencing
// "user"(id) and fails if it is missing here, if a key here no longer exists, if a
// `null_out` names a NOT NULL column, or if a `retain` carries an empty basis. Run it after
// ANY migration that adds a user reference; a table added next year cannot leak past the
// scrub without turning that script red.
//
// ## THE FOUR ENTRIES THAT ARE `set null` IN THE SCHEMA AND `retain` HERE
//
// `commerce_journal_entry`, `escrow_journal_entry`, `provider_transfer` and
// `commerce_organization_member` all carry a BEFORE UPDATE trigger, so nulling their
// attribution raises P0001 and dead-letters the job. They are financial and membership
// records with an Art. 17(3) limb behind them anyway, so `retain` is both the lawful answer
// and the only executable one. Each says so at its own entry.
//
// Generated once from `drizzle-kit export --sql` — the canonical DDL source this repo uses
// for hand-written migrations — then reviewed by hand. Edit it by hand from here on; the
// verify script is what keeps it honest, not a regeneration step.
// ---------------------------------------------------------------------------

/**
 * What happens to one foreign-key column when its subject is anonymized.
 *
 * `retain` is a decision with a citation, never a default. Anything left unclassified fails
 * the coverage script rather than quietly retaining.
 */
export type AnonymizationDisposition =
  /** DELETE every row where this column is the departing user. */
  | { readonly kind: "delete_rows" }
  /** UPDATE the column to NULL, keeping the row and whatever it says. */
  | { readonly kind: "null_out" }
  /** Leave it. `lawfulBasis` cites the GDPR limb; `note` says whose interest it protects. */
  | { readonly kind: "retain"; readonly lawfulBasis: string; readonly note: string };

/** `"<table>.<column>"` — the same key shape the coverage script builds from Postgres. */
export type UserReferenceKey = `${string}.${string}`;

export const ANONYMIZATION_MANIFEST: Readonly<Record<UserReferenceKey, AnonymizationDisposition>> =
  {
    "account.user_id": { kind: "delete_rows" },
    "account_deletion_request.user_id": {
      kind: "retain",
      lawfulBasis: "Art. 5(2) accountability",
      note: "This IS the record that an erasure happened. Erasing it would destroy the only proof the right was honoured.",
    },
    "anime_series.owner_id": { kind: "delete_rows" },
    "claim_verification_run.triggered_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "Hash-chained. The actor label inside the chain is already pseudonymous (pseudonymousActorLabel), so scrubbing user.name removes the identity without touching a byte the hash covers.",
    },
    "commerce_business_email_domain.decided_by_user_id": { kind: "null_out" },
    "commerce_category_request.requested_by_user_id": { kind: "null_out" },
    "commerce_category_request.reviewed_by_user_id": { kind: "null_out" },
    "commerce_content_report.reporter_user_id": { kind: "null_out" },
    "commerce_content_report.resolved_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "A moderation decision taken ABOUT someone else. An unattributable enforcement action cannot be appealed or defended.",
    },
    "commerce_dispute.decided_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(b) and (e)",
      note: "Part of a transaction record the counterparty also holds, and which a dispute may still be open against.",
    },
    "commerce_dispute_event.actor_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(b) and (e)",
      note: "Part of a transaction record the counterparty also holds, and which a dispute may still be open against.",
    },
    "commerce_encrypted_document.uploaded_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(b) and (e)",
      note: "Part of a transaction record the counterparty also holds, and which a dispute may still be open against.",
    },
    "commerce_fulfillment_command.actor_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(b) and (e)",
      note: "Part of a transaction record the counterparty also holds, and which a dispute may still be open against.",
    },
    "commerce_journal_entry.created_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(b) and (e)",
      note: "TRIGGER-PROTECTED. A financial ledger row. Removing the actor makes the entry unattributable and breaks the tax/accounting record it exists to be. A null_out here raises P0001.",
    },
    "commerce_manufacturing_inquiry.created_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(b) and (e)",
      note: "Part of a transaction record the counterparty also holds, and which a dispute may still be open against.",
    },
    "commerce_moderation_action.moderator_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "A moderation decision taken ABOUT someone else. An unattributable enforcement action cannot be appealed or defended.",
    },
    "commerce_organization.created_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "Names who owns or founded a thing other people are still working on or buying from. The row outlives the account by design (rule R1).",
    },
    "commerce_organization_address.created_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(b) and (e)",
      note: "Part of a transaction record the counterparty also holds, and which a dispute may still be open against.",
    },
    "commerce_organization_audit_entry.actor_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "Hash-chained. The actor label inside the chain is already pseudonymous (pseudonymousActorLabel), so scrubbing user.name removes the identity without touching a byte the hash covers.",
    },
    "commerce_organization_certification.reviewed_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(b) and (e)",
      note: "Part of a transaction record the counterparty also holds, and which a dispute may still be open against.",
    },
    "commerce_organization_certification.submitted_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(b) and (e)",
      note: "Part of a transaction record the counterparty also holds, and which a dispute may still be open against.",
    },
    "commerce_organization_member.invited_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(b) and (e)",
      note: "TRIGGER-PROTECTED. Part of a transaction record the counterparty also holds, and which a dispute may still be open against. A null_out here raises P0001.",
    },
    "commerce_organization_member.user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(b) and (e)",
      note: "Part of a transaction record the counterparty also holds, and which a dispute may still be open against.",
    },
    "commerce_organization_ranking_exclusion.added_by_user_id": { kind: "null_out" },
    "commerce_organization_site_audit.recorded_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(b) and (e)",
      note: "Part of a transaction record the counterparty also holds, and which a dispute may still be open against.",
    },
    "commerce_organization_site_audit.withdrawn_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(b) and (e)",
      note: "Part of a transaction record the counterparty also holds, and which a dispute may still be open against.",
    },
    "commerce_organization_verification.reviewed_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(b) and (e)",
      note: "Part of a transaction record the counterparty also holds, and which a dispute may still be open against.",
    },
    "commerce_organization_verification.submitted_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(b) and (e)",
      note: "Part of a transaction record the counterparty also holds, and which a dispute may still be open against.",
    },
    "commerce_product_answer.author_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "Authored content other people have replied to or voted on. Attribution is by id, so scrubbing user.name is what removes the identity.",
    },
    "commerce_product_answer.hidden_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "Authored content other people have replied to or voted on. Attribution is by id, so scrubbing user.name is what removes the identity.",
    },
    "commerce_product_answer_vote.voter_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "Authored content other people have replied to or voted on. Attribution is by id, so scrubbing user.name is what removes the identity.",
    },
    "commerce_product_engagement.user_id": { kind: "delete_rows" },
    "commerce_product_question.asked_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "Authored content other people have replied to or voted on. Attribution is by id, so scrubbing user.name is what removes the identity.",
    },
    "commerce_product_question.hidden_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "Authored content other people have replied to or voted on. Attribution is by id, so scrubbing user.name is what removes the identity.",
    },
    "commerce_product_ranking_enforcement.decided_by_user_id": { kind: "null_out" },
    "commerce_product_relation.created_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(b) and (e)",
      note: "Part of a transaction record the counterparty also holds, and which a dispute may still be open against.",
    },
    "commerce_product_relation.verified_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(b) and (e)",
      note: "Part of a transaction record the counterparty also holds, and which a dispute may still be open against.",
    },
    "commerce_product_share.user_id": { kind: "null_out" },
    "commerce_product_view_session.viewer_id": { kind: "null_out" },
    "commerce_ranking_enforcement_event.decided_by_user_id": { kind: "null_out" },
    "commerce_review_vote.voter_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "Authored content other people have replied to or voted on. Attribution is by id, so scrubbing user.name is what removes the identity.",
    },
    "commerce_service_offering.moderated_by_user_id": { kind: "null_out" },
    "community_cofounder_profile.moderated_by_user_id": { kind: "null_out" },
    "community_cofounder_profile.user_id": { kind: "delete_rows" },
    "community_content_report.reporter_user_id": { kind: "null_out" },
    "community_content_report.resolved_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "A moderation decision taken ABOUT someone else. An unattributable enforcement action cannot be appealed or defended.",
    },
    "community_forum_reply.author_user_id": { kind: "null_out" },
    "community_forum_reply.hidden_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "Authored content other people have replied to or voted on. Attribution is by id, so scrubbing user.name is what removes the identity.",
    },
    "community_forum_reply_vote.user_id": { kind: "delete_rows" },
    "community_forum_thread.author_user_id": { kind: "null_out" },
    "community_forum_thread.moderated_by_user_id": { kind: "null_out" },
    "community_moderation_action.moderator_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "A moderation decision taken ABOUT someone else. An unattributable enforcement action cannot be appealed or defended.",
    },
    "compensation_payment_record.confirmed_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(b) and (e)",
      note: "A financial ledger row. Removing the actor makes the entry unattributable and breaks the tax/accounting record it exists to be.",
    },
    "compensation_payment_record.recorded_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(b) and (e)",
      note: "A financial ledger row. Removing the actor makes the entry unattributable and breaks the tax/accounting record it exists to be.",
    },
    "compensation_period.countersigned_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(b) and (e)",
      note: "A financial ledger row. Removing the actor makes the entry unattributable and breaks the tax/accounting record it exists to be.",
    },
    "compensation_period.finalized_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(b) and (e)",
      note: "A financial ledger row. Removing the actor makes the entry unattributable and breaks the tax/accounting record it exists to be.",
    },
    "content_review_action.reviewer_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "A moderation decision taken ABOUT someone else. An unattributable enforcement action cannot be appealed or defended.",
    },
    // A mute is a PREFERENCE, and the FK says so on both sides: `cascade` for the muter and for
    // the creator alike. Both directions delete, and the second is the less obvious one — a mute of
    // an account that is being erased is a preference about somebody who will not be recommended
    // again, so keeping the row would preserve one person's id inside another person's settings for
    // no remaining purpose.
    "creator_mute.creator_id": { kind: "delete_rows" },
    "creator_mute.muter_id": { kind: "delete_rows" },
    "creator_stats.user_id": { kind: "delete_rows" },
    "creator_subscription.creator_id": { kind: "delete_rows" },
    "creator_subscription.subscriber_id": { kind: "delete_rows" },
    "data_export_request.user_id": {
      kind: "retain",
      lawfulBasis: "Art. 5(2) accountability",
      note: "This IS the record that an erasure happened. Erasing it would destroy the only proof the right was honoured.",
    },
    "dispute.resolved_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "A shared record: this person's slice is the denominator of everyone else's. Erasing it changes other people's equity, which is not this person's to do.",
    },
    "effort_claim.overridden_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "A shared record: this person's slice is the denominator of everyone else's. Erasing it changes other people's equity, which is not this person's to do.",
    },
    "equity_snapshot_share.member_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "A shared record: this person's slice is the denominator of everyone else's. Erasing it changes other people's equity, which is not this person's to do.",
    },
    "escrow_journal_entry.created_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(b) and (e)",
      note: "TRIGGER-PROTECTED. A financial ledger row. Removing the actor makes the entry unattributable and breaks the tax/accounting record it exists to be. A null_out here raises P0001.",
    },
    "escrow_release.decided_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(b) and (e)",
      note: "A financial ledger row. Removing the actor makes the entry unattributable and breaks the tax/accounting record it exists to be.",
    },
    "escrow_release.requested_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(b) and (e)",
      note: "A financial ledger row. Removing the actor makes the entry unattributable and breaks the tax/accounting record it exists to be.",
    },
    "feed_spotlight_slot.updated_by_user_id": { kind: "null_out" },
    "funding_round.created_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(b) and (e)",
      note: "A financial ledger row. Removing the actor makes the entry unattributable and breaks the tax/accounting record it exists to be.",
    },
    "funding_round_pledge.backer_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(b) and (e)",
      note: "A financial ledger row. Removing the actor makes the entry unattributable and breaks the tax/accounting record it exists to be.",
    },
    "handle_reservations.user_id": { kind: "delete_rows" },
    "idempotency_record.user_id": { kind: "delete_rows" },
    "integration_consent_grant.revoked_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "Hash-chained. The actor label inside the chain is already pseudonymous (pseudonymousActorLabel), so scrubbing user.name removes the identity without touching a byte the hash covers.",
    },
    "market_insight.created_by_user_id": { kind: "null_out" },
    "market_insight_project_link.linked_by_user_id": { kind: "null_out" },
    "member_cash_compensation_agreement.accepted_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(b) and (e)",
      note: "A financial ledger row. Removing the actor makes the entry unattributable and breaks the tax/accounting record it exists to be.",
    },
    "member_cash_compensation_agreement.proposed_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(b) and (e)",
      note: "A financial ledger row. Removing the actor makes the entry unattributable and breaks the tax/accounting record it exists to be.",
    },
    "member_fair_market_rate.accepted_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(b) and (e)",
      note: "A financial ledger row. Removing the actor makes the entry unattributable and breaks the tax/accounting record it exists to be.",
    },
    "member_fair_market_rate.locked_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(b) and (e)",
      note: "A financial ledger row. Removing the actor makes the entry unattributable and breaks the tax/accounting record it exists to be.",
    },
    "member_fair_market_rate.proposed_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(b) and (e)",
      note: "A financial ledger row. Removing the actor makes the entry unattributable and breaks the tax/accounting record it exists to be.",
    },
    "milestone.created_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "Names who owns or founded a thing other people are still working on or buying from. The row outlives the account by design (rule R1).",
    },
    "notification.actor_user_id": { kind: "null_out" },
    "notification.recipient_user_id": { kind: "delete_rows" },
    "optimization_suggestion.decided_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "Hash-chained. The actor label inside the chain is already pseudonymous (pseudonymousActorLabel), so scrubbing user.name removes the identity without touching a byte the hash covers.",
    },
    "passkey.user_id": { kind: "delete_rows" },
    "pie_bake_event.baked_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "A shared record: this person's slice is the denominator of everyone else's. Erasing it changes other people's equity, which is not this person's to do.",
    },
    "platform_audit_entry.actor_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "Hash-chained. The actor label inside the chain is already pseudonymous (pseudonymousActorLabel), so scrubbing user.name removes the identity without touching a byte the hash covers.",
    },
    // The note stays, the attribution goes. What somebody said about a broken page is still
    // true after they leave, and it names nobody but the product.
    "platform_feedback.user_id": { kind: "null_out" },
    "platform_role_grant_proposal.cancelled_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "Hash-chained. The actor label inside the chain is already pseudonymous (pseudonymousActorLabel), so scrubbing user.name removes the identity without touching a byte the hash covers.",
    },
    "platform_role_grant_proposal.countersigned_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "Hash-chained. The actor label inside the chain is already pseudonymous (pseudonymousActorLabel), so scrubbing user.name removes the identity without touching a byte the hash covers.",
    },
    "platform_role_grant_proposal.proposed_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "Hash-chained. The actor label inside the chain is already pseudonymous (pseudonymousActorLabel), so scrubbing user.name removes the identity without touching a byte the hash covers.",
    },
    "platform_role_grant_proposal.subject_user_id": { kind: "delete_rows" },
    "playlist.creator_id": { kind: "delete_rows" },
    "problem_cluster_merge_proposal.decided_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "A moderation decision taken ABOUT someone else. An unattributable enforcement action cannot be appealed or defended.",
    },
    "problem_cluster_merge_proposal.proposed_by_user_id": { kind: "null_out" },
    "problem_cluster_project_link.linked_by_user_id": { kind: "null_out" },
    "problem_submission.reporter_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "Authored content other people have replied to or voted on. Attribution is by id, so scrubbing user.name is what removes the identity.",
    },
    "product.created_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "Names who owns or founded a thing other people are still working on or buying from. The row outlives the account by design (rule R1).",
    },
    "project_application.applicant_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "A shared record: this person's slice is the denominator of everyone else's. Erasing it changes other people's equity, which is not this person's to do.",
    },
    "project_application.reviewed_by_user_id": { kind: "null_out" },
    "project_audit_entry.actor_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "Hash-chained. The actor label inside the chain is already pseudonymous (pseudonymousActorLabel), so scrubbing user.name removes the identity without touching a byte the hash covers.",
    },
    "project_invite.invited_by_user_id": { kind: "delete_rows" },
    "project_invite.invitee_user_id": { kind: "delete_rows" },
    "project_member.removed_by_user_id": { kind: "null_out" },
    "project_member.role_granted_by_user_id": { kind: "null_out" },
    "project_member.user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "A shared record: this person's slice is the denominator of everyone else's. Erasing it changes other people's equity, which is not this person's to do.",
    },
    "project_member_interval.ended_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "A shared record: this person's slice is the denominator of everyone else's. Erasing it changes other people's equity, which is not this person's to do.",
    },
    "project_stage_transition.changed_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "Hash-chained. The actor label inside the chain is already pseudonymous (pseudonymousActorLabel), so scrubbing user.name removes the identity without touching a byte the hash covers.",
    },
    "project_watcher.user_id": { kind: "delete_rows" },
    "promotional_slide.created_by_user_id": { kind: "null_out" },
    "promotional_slide.updated_by_user_id": { kind: "null_out" },
    "provider_transfer.settlement_decided_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(b) and (e)",
      note: "TRIGGER-PROTECTED. A financial ledger row. Removing the actor makes the entry unattributable and breaks the tax/accounting record it exists to be. A null_out here raises P0001.",
    },
    "research_category.created_by_user_id": { kind: "null_out" },
    "research_paper_category.created_by_user_id": { kind: "null_out" },
    "research_program.created_by_user_id": { kind: "null_out" },
    "research_program.reviewed_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "A moderation decision taken ABOUT someone else. An unattributable enforcement action cannot be appealed or defended.",
    },
    "research_program_branch.created_by_user_id": { kind: "null_out" },
    "research_program_branch_claim.user_id": { kind: "delete_rows" },
    "research_program_content_report.reporter_user_id": { kind: "null_out" },
    "research_program_content_report.resolved_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "A moderation decision taken ABOUT someone else. An unattributable enforcement action cannot be appealed or defended.",
    },
    "research_program_moderation_action.moderator_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "A moderation decision taken ABOUT someone else. An unattributable enforcement action cannot be appealed or defended.",
    },
    "research_program_paper.reviewed_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "A moderation decision taken ABOUT someone else. An unattributable enforcement action cannot be appealed or defended.",
    },
    "research_program_paper.uploader_user_id": { kind: "null_out" },
    "research_program_participant.user_id": { kind: "delete_rows" },
    "research_program_post.author_user_id": { kind: "null_out" },
    "research_program_post.hidden_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "Authored content other people have replied to or voted on. Attribution is by id, so scrubbing user.name is what removes the identity.",
    },
    "research_program_post_reaction.user_id": { kind: "delete_rows" },
    "research_program_product_opportunity.created_by_user_id": { kind: "null_out" },
    "research_project.founder_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "Names who owns or founded a thing other people are still working on or buying from. The row outlives the account by design (rule R1).",
    },
    "session.user_id": { kind: "delete_rows" },
    "store_pathway.created_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "Names who owns or founded a thing other people are still working on or buying from. The row outlives the account by design (rule R1).",
    },
    "store_pathway.reviewed_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "Names who owns or founded a thing other people are still working on or buying from. The row outlives the account by design (rule R1).",
    },
    "supplier.created_by_user_id": { kind: "null_out" },
    "talent_profile.user_id": { kind: "delete_rows" },
    "user_activity_hour.user_id": { kind: "delete_rows" },
    "user_creator_affinity_snapshot.creator_id": { kind: "delete_rows" },
    "user_creator_affinity_snapshot.user_id": { kind: "delete_rows" },
    // A personal advertisement, not attribution — nobody else's record depends on these links, so
    // none of the five retention bars is met. `cascade` on the FK, `delete_rows` here, exactly as
    // `talent_profile.user_id` and `community_cofounder_profile.user_id` resolve the same shape.
    // A moderator's decision about somebody else's profile, and the same asymmetry the video and
    // commerce report tables already carry.
    "user_moderation_action.moderator_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "Hash-chained and NOT NULL: the row carries an audit_entry_id and names the human behind a takedown. A null_out is not merely wrong, it is illegal — the column refuses NULL.",
    },
    "user_moderation_action.subject_user_id": { kind: "null_out" },
    "user_profile_link.user_id": { kind: "delete_rows" },
    "user_report.reported_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "The subject of a moderation record, kept deliberately. If an erasure deleted the reports filed AGAINST somebody, requesting deletion would become a ban-evasion route — and the enforcement history a future moderator needs would be the thing it destroyed.",
    },
    "user_report.reporter_user_id": { kind: "null_out" },
    "user_report.resolved_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "A moderation decision taken ABOUT someone else. An unattributable enforcement action cannot be appealed or defended.",
    },
    "user_topic_affinity_snapshot.user_id": { kind: "delete_rows" },
    "user_watch_daily.user_id": { kind: "delete_rows" },
    "verification_step.reviewed_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "Hash-chained. The actor label inside the chain is already pseudonymous (pseudonymousActorLabel), so scrubbing user.name removes the identity without touching a byte the hash covers.",
    },
    "video.creator_id": { kind: "delete_rows" },
    "video_collaborator.user_id": { kind: "null_out" },
    "video_comment.author_user_id": { kind: "null_out" },
    "video_comment_like.user_id": { kind: "delete_rows" },
    // The reporter and the resolver are treated oppositely, and the asymmetry is the same one the
    // schema states on the columns themselves. `commerce_content_report` reached the identical
    // verdicts for the identical pair; this fork was simply never added.
    "video_content_report.reporter_user_id": { kind: "null_out" },
    "video_content_report.resolved_by_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "A moderation decision taken ABOUT someone else. An unattributable enforcement action cannot be appealed or defended.",
    },
    "video_like.user_id": { kind: "delete_rows" },
    "video_moderation_action.moderator_user_id": {
      kind: "retain",
      lawfulBasis: "Art. 17(3)(e)",
      note: "Hash-chained and NOT NULL: the row carries an audit_entry_id and the moderator is the human behind a takedown. A null_out is not merely wrong here, it is illegal — the column refuses NULL and the erasure would raise 23502 mid-run.",
    },
    // A dismissal is a preference, cascade on the FK, and it dies with the account like every other
    // feed signal beside it.
    "video_not_interested.viewer_id": { kind: "delete_rows" },
    "video_save.user_id": { kind: "delete_rows" },
    "video_share.user_id": { kind: "null_out" },
    "video_team_member.linked_user_id": { kind: "null_out" },
    "video_view_session.viewer_id": { kind: "null_out" },
    "workshop_board_column.created_by_user_id": { kind: "null_out" },
    "workshop_file.removed_by_user_id": { kind: "null_out" },
    "workshop_task.created_by_user_id": { kind: "null_out" },
  };

/**
 * A REAL RUNTIME CHECK, not a cast.
 *
 * `Object.keys` hands back `string[]`, and CLAUDE.md forbids asserting that back into the
 * narrower type — which would be a lie the compiler happily tells if a key ever lost its dot.
 * Narrowing through a predicate means a malformed key is dropped from the step list AND fails
 * the coverage script's both-directions comparison, instead of reaching the scrub as SQL.
 */
function isUserReferenceKey(key: string): key is UserReferenceKey {
  const separatorIndex = key.indexOf(".");
  return separatorIndex > 0 && separatorIndex < key.length - 1;
}

function keysWithDisposition(kind: AnonymizationDisposition["kind"]): readonly UserReferenceKey[] {
  return Object.keys(ANONYMIZATION_MANIFEST)
    .filter(isUserReferenceKey)
    .filter((key) => ANONYMIZATION_MANIFEST[key].kind === kind);
}

/** Every column the scrub DELETEs rows by. Derived — never hand-listed. */
export const DELETE_ROW_KEYS: readonly UserReferenceKey[] = keysWithDisposition("delete_rows");

/** Every column the scrub NULLs. Derived — never hand-listed. */
export const NULL_OUT_KEYS: readonly UserReferenceKey[] = keysWithDisposition("null_out");

/**
 * Splits `"table.column"` back into its parts.
 *
 * Both halves are Postgres identifiers from this file, never from a request — but the scrub
 * interpolates them into SQL, so a malformed key must fail here rather than downstream.
 */
export function parseUserReferenceKey(key: UserReferenceKey): {
  readonly tableName: string;
  readonly columnName: string;
} {
  const separatorIndex = key.indexOf(".");
  if (separatorIndex <= 0 || separatorIndex === key.length - 1) {
    throw new Error(`anonymization manifest: malformed key ${key}`);
  }
  return {
    tableName: key.slice(0, separatorIndex),
    columnName: key.slice(separatorIndex + 1),
  };
}
