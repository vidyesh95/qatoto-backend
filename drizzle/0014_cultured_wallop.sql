CREATE TYPE "public"."artifact_provider" AS ENUM('github', 'gitlab', 'figma', 'jira', 'linear', 'notion', 'google_docs', 'daily_log_link', 'workshop_link', 'physical_receipt', 'other');--> statement-breakpoint
CREATE TYPE "public"."artifact_signature_status" AS ENUM('valid', 'invalid', 'unsigned', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."dispute_resolution" AS ENUM('upheld', 'voided', 're_verified');--> statement-breakpoint
CREATE TYPE "public"."dispute_status" AS ENUM('open', 'withdrawn', 'consensus_reached');--> statement-breakpoint
CREATE TYPE "public"."dispute_vote_position" AS ENUM('uphold', 'void', 're_verify');--> statement-breakpoint
CREATE TYPE "public"."effort_claim_source_kind" AS ENUM('daily_log', 'physical_receipt');--> statement-breakpoint
CREATE TYPE "public"."fair_market_rate_status" AS ENUM('proposed', 'accepted', 'locked');--> statement-breakpoint
CREATE TYPE "public"."integration_grant_status" AS ENUM('pending', 'active', 'revoked', 'expired');--> statement-breakpoint
CREATE TYPE "public"."integration_provider" AS ENUM('github', 'gitlab', 'figma', 'jira', 'linear');--> statement-breakpoint
CREATE TYPE "public"."optimization_suggestion_status" AS ENUM('open', 'accepted', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."physical_receipt_kind" AS ENUM('photo_of_work', 'cad_file', 'material_receipt', 'other');--> statement-breakpoint
CREATE TYPE "public"."pie_bake_trigger" AS ENUM('cash_flow_breakeven', 'priced_round');--> statement-breakpoint
CREATE TYPE "public"."project_audit_event_kind" AS ENUM('rate_proposed', 'rate_accepted', 'rate_locked', 'claim_submitted', 'claim_verdict_reached', 'verification_step_overridden', 'claim_reverification_requested', 'allocation_proposal_opened', 'allocation_disputed', 'dispute_withdrawn', 'dispute_vote_cast', 'dispute_resolved', 'slices_awarded', 'slices_reversed', 'integration_consent_granted', 'integration_consent_revoked', 'equity_snapshot_recomputed', 'pie_baked');--> statement-breakpoint
CREATE TYPE "public"."receipt_forensics_check_kind" AS ENUM('exif_present', 'capture_time_consistency', 'device_fingerprint', 'reverse_image_search');--> statement-breakpoint
CREATE TYPE "public"."receipt_forensics_result" AS ENUM('pass', 'flag', 'fail', 'not_applicable');--> statement-breakpoint
CREATE TYPE "public"."slice_allocation_proposal_status" AS ENUM('open', 'disputed', 'locked', 'consensus_reached');--> statement-breakpoint
CREATE TYPE "public"."slice_contribution_kind" AS ENUM('time', 'cash');--> statement-breakpoint
CREATE TYPE "public"."slice_ledger_entry_kind" AS ENUM('award', 'reversal');--> statement-breakpoint
CREATE TYPE "public"."verification_step_kind" AS ENUM('claim_extraction', 'artifact_grounding', 'substance_analysis', 'temporal_analysis');--> statement-breakpoint
CREATE TYPE "public"."verification_step_status" AS ENUM('pending', 'passed', 'flagged', 'failed', 'skipped');--> statement-breakpoint
CREATE TABLE "artifact_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"claim_id" text NOT NULL,
	"provider" "artifact_provider" NOT NULL,
	"external_id" text NOT NULL,
	"label" text NOT NULL,
	"external_url" text,
	"payload_sha256" text NOT NULL,
	"raw_payload_json" text,
	"evidence_retained" boolean DEFAULT true NOT NULL,
	"signature_status" "artifact_signature_status" DEFAULT 'unknown' NOT NULL,
	"artifact_occurred_at" timestamp NOT NULL,
	"counts_toward_slices" boolean DEFAULT true NOT NULL,
	"consent_grant_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_evidence_sha_ck" CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "artifact_evidence_label_ck" CHECK (char_length(label) BETWEEN 1 AND 500),
	CONSTRAINT "artifact_evidence_url_ck" CHECK (external_url IS NULL
          OR (char_length(external_url) <= 2048 AND external_url LIKE 'https://%')),
	CONSTRAINT "artifact_evidence_retention_ck" CHECK (evidence_retained = true OR raw_payload_json IS NULL)
);
--> statement-breakpoint
CREATE TABLE "claim_verification_run" (
	"id" text PRIMARY KEY NOT NULL,
	"claim_id" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"triggered_by_user_id" text,
	"trigger_reason" text,
	"scoped_window_starts_at" timestamp,
	"scoped_window_ends_at" timestamp,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"verdict" "effort_verification_status",
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "claim_verification_run_attempt_ck" CHECK (attempt_number >= 1),
	CONSTRAINT "claim_verification_run_verdict_ck" CHECK (verdict IS NULL OR verdict IN ('verified', 'flagged_for_review', 'unverified')),
	CONSTRAINT "claim_verification_run_completed_ck" CHECK ((completed_at IS NULL) = (verdict IS NULL)),
	CONSTRAINT "claim_verification_run_window_ck" CHECK ((scoped_window_starts_at IS NULL) = (scoped_window_ends_at IS NULL)
          AND (scoped_window_ends_at IS NULL OR scoped_window_ends_at > scoped_window_starts_at))
);
--> statement-breakpoint
CREATE TABLE "dispute" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"proposal_id" text NOT NULL,
	"raised_by_member_id" text NOT NULL,
	"dispute_note" text NOT NULL,
	"status" "dispute_status" DEFAULT 'open' NOT NULL,
	"quorum_member_count" integer NOT NULL,
	"resolution" "dispute_resolution",
	"resolution_note" text,
	"resolved_by_user_id" text,
	"resolved_at" timestamp,
	"scoped_window_starts_at" timestamp,
	"scoped_window_ends_at" timestamp,
	"reverification_run_id" text,
	"withdrawn_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "dispute_note_ck" CHECK (char_length(dispute_note) BETWEEN 1 AND 2000),
	CONSTRAINT "dispute_quorum_ck" CHECK (quorum_member_count >= 1),
	CONSTRAINT "dispute_resolution_ck" CHECK ((status = 'consensus_reached')
          = (resolution IS NOT NULL AND resolved_at IS NOT NULL AND resolved_by_user_id IS NOT NULL)),
	CONSTRAINT "dispute_withdrawn_ck" CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL)),
	CONSTRAINT "dispute_window_ck" CHECK ((scoped_window_starts_at IS NULL) = (scoped_window_ends_at IS NULL)
          AND (scoped_window_ends_at IS NULL OR scoped_window_ends_at > scoped_window_starts_at)
          AND (scoped_window_starts_at IS NULL OR resolution = 're_verified'))
);
--> statement-breakpoint
CREATE TABLE "dispute_vote" (
	"id" text PRIMARY KEY NOT NULL,
	"dispute_id" text NOT NULL,
	"voter_member_id" text NOT NULL,
	"position" "dispute_vote_position" NOT NULL,
	"note" text,
	"cast_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "dispute_vote_note_ck" CHECK (note IS NULL OR char_length(note) <= 2000)
);
--> statement-breakpoint
CREATE TABLE "effort_claim" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"member_id" text NOT NULL,
	"source_kind" "effort_claim_source_kind" NOT NULL,
	"daily_log_id" text,
	"claimed_for_date" date NOT NULL,
	"extracted_minutes" integer,
	"extracted_cash_in_cents" bigint,
	"grounded_minutes" integer,
	"grounded_cash_in_cents" bigint,
	"overridden_minutes" integer,
	"override_reason" text,
	"overridden_by_user_id" text,
	"overridden_at" timestamp,
	"claim_summary" text NOT NULL,
	"verification_status" "effort_verification_status" DEFAULT 'queued' NOT NULL,
	"verdict_reached_at" timestamp,
	"fair_market_rate_id" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "effort_claim_source_ck" CHECK ((source_kind = 'daily_log') = (daily_log_id IS NOT NULL)),
	CONSTRAINT "effort_claim_minutes_ck" CHECK ((extracted_minutes IS NULL OR extracted_minutes BETWEEN 0 AND 1440)
          AND (grounded_minutes IS NULL OR grounded_minutes BETWEEN 0 AND 1440)
          AND (overridden_minutes IS NULL OR overridden_minutes BETWEEN 0 AND 1440)),
	CONSTRAINT "effort_claim_cash_ck" CHECK ((extracted_cash_in_cents IS NULL OR extracted_cash_in_cents >= 0)
          AND (grounded_cash_in_cents IS NULL OR grounded_cash_in_cents >= 0)),
	CONSTRAINT "effort_claim_override_ck" CHECK ((overridden_minutes IS NULL) = (override_reason IS NULL)
          AND (overridden_minutes IS NULL) = (overridden_by_user_id IS NULL)
          AND (overridden_minutes IS NULL) = (overridden_at IS NULL)),
	CONSTRAINT "effort_claim_summary_ck" CHECK (char_length(claim_summary) BETWEEN 1 AND 1000),
	CONSTRAINT "effort_claim_verdict_ck" CHECK ((verdict_reached_at IS NOT NULL)
          = (verification_status IN ('verified', 'flagged_for_review', 'unverified')))
);
--> statement-breakpoint
CREATE TABLE "equity_snapshot" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"as_of" timestamp NOT NULL,
	"computed_at" timestamp DEFAULT now() NOT NULL,
	"total_slices" bigint NOT NULL,
	"member_count" integer NOT NULL,
	"apportionment_algorithm" text DEFAULT 'largest-remainder-v1' NOT NULL,
	"through_ledger_sequence_number" integer NOT NULL,
	"is_degenerate" boolean DEFAULT false NOT NULL,
	"is_baked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "equity_snapshot_totals_ck" CHECK (total_slices >= 0 AND member_count >= 0 AND through_ledger_sequence_number >= 0),
	CONSTRAINT "equity_snapshot_degenerate_ck" CHECK ((is_degenerate = true) = (total_slices = 0))
);
--> statement-breakpoint
CREATE TABLE "equity_snapshot_share" (
	"id" text PRIMARY KEY NOT NULL,
	"snapshot_id" text NOT NULL,
	"member_id" text NOT NULL,
	"member_user_id" text NOT NULL,
	"slices" bigint NOT NULL,
	"equity_basis_points" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "equity_snapshot_share_bps_ck" CHECK (equity_basis_points BETWEEN 0 AND 10000 AND slices >= 0)
);
--> statement-breakpoint
CREATE TABLE "integration_consent_grant" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"member_id" text NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"status" "integration_grant_status" DEFAULT 'pending' NOT NULL,
	"allowed_resource_ids" text[] DEFAULT '{}' NOT NULL,
	"encrypted_access_token" text,
	"encrypted_refresh_token" text,
	"token_key_version" text,
	"external_account_label" text,
	"granted_at" timestamp,
	"expires_at" timestamp,
	"revoked_at" timestamp,
	"revoked_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "integration_consent_grant_lifecycle_ck" CHECK ((status <> 'active' OR (encrypted_access_token IS NOT NULL AND granted_at IS NOT NULL))
          AND (status <> 'revoked' OR (revoked_at IS NOT NULL AND encrypted_access_token IS NULL))
          AND (status <> 'pending' OR encrypted_access_token IS NULL)
          AND (encrypted_access_token IS NULL) = (token_key_version IS NULL)
          AND (revoked_at IS NULL) = (revoked_by_user_id IS NULL)),
	CONSTRAINT "integration_consent_grant_resources_ck" CHECK (cardinality(allowed_resource_ids) <= 100)
);
--> statement-breakpoint
CREATE TABLE "member_fair_market_rate" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"member_id" text NOT NULL,
	"fair_market_rate_cents_per_hour" bigint NOT NULL,
	"paid_cash_rate_cents_per_hour" bigint DEFAULT 0 NOT NULL,
	"currency_code" text NOT NULL,
	"status" "fair_market_rate_status" DEFAULT 'proposed' NOT NULL,
	"effective_from" timestamp NOT NULL,
	"rationale_note" text NOT NULL,
	"proposed_by_user_id" text NOT NULL,
	"accepted_at" timestamp,
	"accepted_by_user_id" text,
	"locked_at" timestamp,
	"locked_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "member_fair_market_rate_rate_ck" CHECK (fair_market_rate_cents_per_hour >= 0),
	CONSTRAINT "member_fair_market_rate_paid_ck" CHECK (paid_cash_rate_cents_per_hour >= 0),
	CONSTRAINT "member_fair_market_rate_currency_ck" CHECK (currency_code ~ '^[A-Z]{3}$'),
	CONSTRAINT "member_fair_market_rate_rationale_ck" CHECK (char_length(rationale_note) BETWEEN 1 AND 1000),
	CONSTRAINT "member_fair_market_rate_lifecycle_ck" CHECK ((status <> 'proposed' OR (accepted_at IS NULL AND locked_at IS NULL))
          AND (status <> 'accepted' OR (accepted_at IS NOT NULL AND locked_at IS NULL))
          AND (status <> 'locked' OR (accepted_at IS NOT NULL AND locked_at IS NOT NULL))
          AND (accepted_at IS NULL) = (accepted_by_user_id IS NULL)
          AND (locked_at IS NULL) = (locked_by_user_id IS NULL))
);
--> statement-breakpoint
CREATE TABLE "optimization_suggestion" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"member_id" text,
	"title" text NOT NULL,
	"body_text" text NOT NULL,
	"status" "optimization_suggestion_status" DEFAULT 'open' NOT NULL,
	"model_name" text NOT NULL,
	"model_version" text,
	"prompt_version" text NOT NULL,
	"confidence_bps" integer,
	"as_of" timestamp NOT NULL,
	"decided_by_user_id" text,
	"decided_at" timestamp,
	"decision_note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "optimization_suggestion_text_ck" CHECK (char_length(title) BETWEEN 1 AND 200 AND char_length(body_text) BETWEEN 1 AND 4000),
	CONSTRAINT "optimization_suggestion_confidence_ck" CHECK (confidence_bps IS NULL OR confidence_bps BETWEEN 0 AND 10000),
	CONSTRAINT "optimization_suggestion_decision_ck" CHECK ((status = 'open') = (decided_at IS NULL)
          AND (decided_at IS NULL) = (decided_by_user_id IS NULL))
);
--> statement-breakpoint
CREATE TABLE "optimization_suggestion_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"suggestion_id" text NOT NULL,
	"sequence_number" integer NOT NULL,
	"label" text NOT NULL,
	"related_claim_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "optimization_suggestion_evidence_label_ck" CHECK (char_length(label) BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE TABLE "physical_work_receipt" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"member_id" text NOT NULL,
	"claim_id" text,
	"receipt_kind" "physical_receipt_kind" NOT NULL,
	"content_sha256" text NOT NULL,
	"perceptual_hash" text NOT NULL,
	"stored_image_url" text,
	"stored_image_public_id" text,
	"size_bytes" integer NOT NULL,
	"width_pixels" integer,
	"height_pixels" integer,
	"captured_at" timestamp,
	"device_fingerprint_hash" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "physical_work_receipt_sha_ck" CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "physical_work_receipt_size_ck" CHECK (size_bytes > 0),
	CONSTRAINT "physical_work_receipt_dimensions_ck" CHECK ((width_pixels IS NULL OR width_pixels > 0)
          AND (height_pixels IS NULL OR height_pixels > 0))
);
--> statement-breakpoint
CREATE TABLE "pie_bake_event" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"trigger" "pie_bake_trigger" NOT NULL,
	"trigger_evidence_note" text NOT NULL,
	"valuation_cents" bigint,
	"acknowledgement" text NOT NULL,
	"baked_by_user_id" text NOT NULL,
	"baked_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pie_bake_event_evidence_ck" CHECK (char_length(trigger_evidence_note) BETWEEN 1 AND 2000),
	CONSTRAINT "pie_bake_event_valuation_ck" CHECK (valuation_cents IS NULL OR valuation_cents > 0)
);
--> statement-breakpoint
CREATE TABLE "project_audit_entry" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"sequence_number" integer NOT NULL,
	"event_kind" "project_audit_event_kind" NOT NULL,
	"actor_user_id" text,
	"actor_name_snapshot" text NOT NULL,
	"actor_role_snapshot" text NOT NULL,
	"action_label" text NOT NULL,
	"target_label" text NOT NULL,
	"detail_note" text DEFAULT '' NOT NULL,
	"payload_json" text NOT NULL,
	"occurred_at" timestamp NOT NULL,
	"previous_entry_hash" text,
	"entry_hash" text NOT NULL,
	"hash_algorithm_version" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "project_audit_entry_sequence_ck" CHECK (sequence_number >= 1),
	CONSTRAINT "project_audit_entry_hash_ck" CHECK (entry_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "project_audit_entry_link_ck" CHECK ((sequence_number = 1) = (previous_entry_hash IS NULL)
          AND (previous_entry_hash IS NULL OR previous_entry_hash ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "project_audit_entry_labels_ck" CHECK (char_length(action_label) BETWEEN 1 AND 200
          AND char_length(target_label) BETWEEN 1 AND 200
          AND char_length(detail_note) <= 2000)
);
--> statement-breakpoint
CREATE TABLE "project_chain_head" (
	"project_id" text PRIMARY KEY NOT NULL,
	"last_audit_sequence_number" integer DEFAULT 0 NOT NULL,
	"last_ledger_sequence_number" integer DEFAULT 0 NOT NULL,
	"head_entry_hash" text,
	"head_entry_id" text,
	"last_anchored_at" timestamp,
	"last_anchored_hash" text,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "project_chain_head_sequence_ck" CHECK (last_audit_sequence_number >= 0 AND last_ledger_sequence_number >= 0),
	CONSTRAINT "project_chain_head_hash_ck" CHECK ((head_entry_hash IS NULL OR head_entry_hash ~ '^[0-9a-f]{64}$')
          AND (last_anchored_hash IS NULL OR last_anchored_hash ~ '^[0-9a-f]{64}$')
          AND (last_audit_sequence_number = 0) = (head_entry_hash IS NULL))
);
--> statement-breakpoint
CREATE TABLE "receipt_forensics_check" (
	"id" text PRIMARY KEY NOT NULL,
	"receipt_id" text NOT NULL,
	"check_kind" "receipt_forensics_check_kind" NOT NULL,
	"result" "receipt_forensics_result" NOT NULL,
	"finding_summary" text,
	"model_name" text,
	"prompt_version" text,
	"confidence_bps" integer,
	"checked_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_forensics_check_confidence_ck" CHECK (confidence_bps IS NULL OR confidence_bps BETWEEN 0 AND 10000),
	CONSTRAINT "receipt_forensics_check_finding_ck" CHECK (finding_summary IS NULL OR char_length(finding_summary) <= 2000)
);
--> statement-breakpoint
CREATE TABLE "slice_allocation_proposal" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"claim_id" text NOT NULL,
	"member_id" text NOT NULL,
	"run_id" text NOT NULL,
	"verdict" "effort_verification_status" NOT NULL,
	"proposed_slices" integer NOT NULL,
	"proposed_slice_numerator" bigint NOT NULL,
	"fair_market_rate_id" text,
	"status" "slice_allocation_proposal_status" DEFAULT 'open' NOT NULL,
	"window_opens_at" timestamp DEFAULT now() NOT NULL,
	"window_closes_at" timestamp NOT NULL,
	"escrowed_slices" integer DEFAULT 0 NOT NULL,
	"active_dispute_id" text,
	"locked_at" timestamp,
	"consensus_reached_at" timestamp,
	"settled_ledger_entry_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "proposal_locked_shape" CHECK ((status <> 'locked') OR (locked_at IS NOT NULL AND settled_ledger_entry_id IS NOT NULL)),
	CONSTRAINT "proposal_consensus_shape" CHECK ((status <> 'consensus_reached')
          OR (consensus_reached_at IS NOT NULL AND settled_ledger_entry_id IS NOT NULL)),
	CONSTRAINT "proposal_disputed_shape" CHECK ((status <> 'disputed')
          OR (active_dispute_id IS NOT NULL AND escrowed_slices = proposed_slices)),
	CONSTRAINT "proposal_escrow_zero" CHECK ((status = 'disputed') OR (escrowed_slices = 0)),
	CONSTRAINT "proposal_window_ck" CHECK (window_closes_at > window_opens_at),
	CONSTRAINT "proposal_slices_ck" CHECK (proposed_slices >= 0 AND escrowed_slices >= 0 AND proposed_slice_numerator >= 0),
	CONSTRAINT "proposal_verdict_ck" CHECK (verdict IN ('verified', 'flagged_for_review', 'unverified'))
);
--> statement-breakpoint
CREATE TABLE "slice_ledger_entry" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"sequence_number" integer NOT NULL,
	"member_id" text NOT NULL,
	"entry_kind" "slice_ledger_entry_kind" DEFAULT 'award' NOT NULL,
	"contribution_kind" "slice_contribution_kind" NOT NULL,
	"claim_id" text,
	"proposal_id" text,
	"slice_numerator" bigint NOT NULL,
	"slices_awarded" integer NOT NULL,
	"fair_market_rate_id" text,
	"unpaid_rate_cents_per_hour" bigint,
	"effort_minutes" integer,
	"cash_in_cents" bigint,
	"reversal_of_entry_id" text,
	"occurred_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "slice_ledger_entry_sequence_ck" CHECK (sequence_number >= 1),
	CONSTRAINT "slice_ledger_entry_reversal_ck" CHECK ((entry_kind = 'reversal') = (reversal_of_entry_id IS NOT NULL)),
	CONSTRAINT "slice_ledger_entry_sign_ck" CHECK ((entry_kind = 'award' AND slices_awarded >= 0 AND slice_numerator >= 0)
          OR (entry_kind = 'reversal' AND slices_awarded <= 0 AND slice_numerator <= 0)),
	CONSTRAINT "slice_ledger_entry_inputs_ck" CHECK ((contribution_kind = 'time')
            = (effort_minutes IS NOT NULL AND unpaid_rate_cents_per_hour IS NOT NULL)
          AND (contribution_kind = 'cash') = (cash_in_cents IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "verification_step" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"step_order" integer NOT NULL,
	"step_kind" "verification_step_kind" NOT NULL,
	"status" "verification_step_status" DEFAULT 'pending' NOT NULL,
	"finding_summary" text,
	"score_bps" integer,
	"model_name" text,
	"model_version" text,
	"prompt_version" text,
	"confidence_bps" integer,
	"overridden_status" "verification_step_status",
	"reviewed_by_user_id" text,
	"override_reason" text,
	"reviewed_at" timestamp,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "verification_step_order_ck" CHECK (step_order BETWEEN 1 AND 4),
	CONSTRAINT "verification_step_score_ck" CHECK ((score_bps IS NULL OR score_bps BETWEEN 0 AND 10000)
          AND (confidence_bps IS NULL OR confidence_bps BETWEEN 0 AND 10000)),
	CONSTRAINT "verification_step_override_ck" CHECK ((overridden_status IS NULL) = (reviewed_by_user_id IS NULL)
          AND (overridden_status IS NULL) = (override_reason IS NULL)
          AND (overridden_status IS NULL) = (reviewed_at IS NULL)
          AND (overridden_status IS NULL OR overridden_status <> 'pending')),
	CONSTRAINT "verification_step_finding_ck" CHECK (finding_summary IS NULL OR char_length(finding_summary) <= 2000)
);
--> statement-breakpoint
ALTER TABLE "artifact_evidence" ADD CONSTRAINT "artifact_evidence_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_evidence" ADD CONSTRAINT "artifact_evidence_claim_id_effort_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."effort_claim"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_evidence" ADD CONSTRAINT "artifact_evidence_consent_grant_id_integration_consent_grant_id_fk" FOREIGN KEY ("consent_grant_id") REFERENCES "public"."integration_consent_grant"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_verification_run" ADD CONSTRAINT "claim_verification_run_claim_id_effort_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."effort_claim"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_verification_run" ADD CONSTRAINT "claim_verification_run_triggered_by_user_id_user_id_fk" FOREIGN KEY ("triggered_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute" ADD CONSTRAINT "dispute_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute" ADD CONSTRAINT "dispute_proposal_id_slice_allocation_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."slice_allocation_proposal"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute" ADD CONSTRAINT "dispute_raised_by_member_id_project_member_id_fk" FOREIGN KEY ("raised_by_member_id") REFERENCES "public"."project_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute" ADD CONSTRAINT "dispute_resolved_by_user_id_user_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute" ADD CONSTRAINT "dispute_reverification_run_id_claim_verification_run_id_fk" FOREIGN KEY ("reverification_run_id") REFERENCES "public"."claim_verification_run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_vote" ADD CONSTRAINT "dispute_vote_dispute_id_dispute_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."dispute"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_vote" ADD CONSTRAINT "dispute_vote_voter_member_id_project_member_id_fk" FOREIGN KEY ("voter_member_id") REFERENCES "public"."project_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "effort_claim" ADD CONSTRAINT "effort_claim_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "effort_claim" ADD CONSTRAINT "effort_claim_member_id_project_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."project_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "effort_claim" ADD CONSTRAINT "effort_claim_daily_log_id_daily_log_id_fk" FOREIGN KEY ("daily_log_id") REFERENCES "public"."daily_log"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "effort_claim" ADD CONSTRAINT "effort_claim_overridden_by_user_id_user_id_fk" FOREIGN KEY ("overridden_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "effort_claim" ADD CONSTRAINT "effort_claim_fair_market_rate_id_member_fair_market_rate_id_fk" FOREIGN KEY ("fair_market_rate_id") REFERENCES "public"."member_fair_market_rate"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equity_snapshot" ADD CONSTRAINT "equity_snapshot_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equity_snapshot_share" ADD CONSTRAINT "equity_snapshot_share_snapshot_id_equity_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."equity_snapshot"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equity_snapshot_share" ADD CONSTRAINT "equity_snapshot_share_member_id_project_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."project_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equity_snapshot_share" ADD CONSTRAINT "equity_snapshot_share_member_user_id_user_id_fk" FOREIGN KEY ("member_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_consent_grant" ADD CONSTRAINT "integration_consent_grant_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_consent_grant" ADD CONSTRAINT "integration_consent_grant_member_id_project_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."project_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_consent_grant" ADD CONSTRAINT "integration_consent_grant_revoked_by_user_id_user_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_fair_market_rate" ADD CONSTRAINT "member_fair_market_rate_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_fair_market_rate" ADD CONSTRAINT "member_fair_market_rate_member_id_project_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."project_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_fair_market_rate" ADD CONSTRAINT "member_fair_market_rate_proposed_by_user_id_user_id_fk" FOREIGN KEY ("proposed_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_fair_market_rate" ADD CONSTRAINT "member_fair_market_rate_accepted_by_user_id_user_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_fair_market_rate" ADD CONSTRAINT "member_fair_market_rate_locked_by_user_id_user_id_fk" FOREIGN KEY ("locked_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optimization_suggestion" ADD CONSTRAINT "optimization_suggestion_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optimization_suggestion" ADD CONSTRAINT "optimization_suggestion_member_id_project_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."project_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optimization_suggestion" ADD CONSTRAINT "optimization_suggestion_decided_by_user_id_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optimization_suggestion_evidence" ADD CONSTRAINT "optimization_suggestion_evidence_suggestion_id_optimization_suggestion_id_fk" FOREIGN KEY ("suggestion_id") REFERENCES "public"."optimization_suggestion"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optimization_suggestion_evidence" ADD CONSTRAINT "optimization_suggestion_evidence_related_claim_id_effort_claim_id_fk" FOREIGN KEY ("related_claim_id") REFERENCES "public"."effort_claim"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "physical_work_receipt" ADD CONSTRAINT "physical_work_receipt_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "physical_work_receipt" ADD CONSTRAINT "physical_work_receipt_member_id_project_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."project_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "physical_work_receipt" ADD CONSTRAINT "physical_work_receipt_claim_id_effort_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."effort_claim"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pie_bake_event" ADD CONSTRAINT "pie_bake_event_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pie_bake_event" ADD CONSTRAINT "pie_bake_event_snapshot_id_equity_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."equity_snapshot"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pie_bake_event" ADD CONSTRAINT "pie_bake_event_baked_by_user_id_user_id_fk" FOREIGN KEY ("baked_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_audit_entry" ADD CONSTRAINT "project_audit_entry_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_audit_entry" ADD CONSTRAINT "project_audit_entry_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_chain_head" ADD CONSTRAINT "project_chain_head_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_forensics_check" ADD CONSTRAINT "receipt_forensics_check_receipt_id_physical_work_receipt_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."physical_work_receipt"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slice_allocation_proposal" ADD CONSTRAINT "slice_allocation_proposal_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slice_allocation_proposal" ADD CONSTRAINT "slice_allocation_proposal_claim_id_effort_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."effort_claim"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slice_allocation_proposal" ADD CONSTRAINT "slice_allocation_proposal_member_id_project_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."project_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slice_allocation_proposal" ADD CONSTRAINT "slice_allocation_proposal_run_id_claim_verification_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."claim_verification_run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slice_allocation_proposal" ADD CONSTRAINT "slice_allocation_proposal_fair_market_rate_id_member_fair_market_rate_id_fk" FOREIGN KEY ("fair_market_rate_id") REFERENCES "public"."member_fair_market_rate"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slice_allocation_proposal" ADD CONSTRAINT "slice_allocation_proposal_active_dispute_id_dispute_id_fk" FOREIGN KEY ("active_dispute_id") REFERENCES "public"."dispute"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slice_allocation_proposal" ADD CONSTRAINT "slice_allocation_proposal_settled_ledger_entry_id_slice_ledger_entry_id_fk" FOREIGN KEY ("settled_ledger_entry_id") REFERENCES "public"."slice_ledger_entry"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slice_ledger_entry" ADD CONSTRAINT "slice_ledger_entry_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slice_ledger_entry" ADD CONSTRAINT "slice_ledger_entry_member_id_project_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."project_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slice_ledger_entry" ADD CONSTRAINT "slice_ledger_entry_claim_id_effort_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."effort_claim"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slice_ledger_entry" ADD CONSTRAINT "slice_ledger_entry_proposal_id_slice_allocation_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."slice_allocation_proposal"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slice_ledger_entry" ADD CONSTRAINT "slice_ledger_entry_fair_market_rate_id_member_fair_market_rate_id_fk" FOREIGN KEY ("fair_market_rate_id") REFERENCES "public"."member_fair_market_rate"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slice_ledger_entry" ADD CONSTRAINT "slice_ledger_entry_reversal_of_entry_id_slice_ledger_entry_id_fk" FOREIGN KEY ("reversal_of_entry_id") REFERENCES "public"."slice_ledger_entry"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_step" ADD CONSTRAINT "verification_step_run_id_claim_verification_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."claim_verification_run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_step" ADD CONSTRAINT "verification_step_reviewed_by_user_id_user_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_evidence_project_claim_unq" ON "artifact_evidence" USING btree ("project_id","provider","external_id") WHERE counts_toward_slices = true;--> statement-breakpoint
CREATE INDEX "artifact_evidence_claimId_idx" ON "artifact_evidence" USING btree ("claim_id","id");--> statement-breakpoint
CREATE INDEX "artifact_evidence_occurredAt_idx" ON "artifact_evidence" USING btree ("project_id","artifact_occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "claim_verification_run_claimId_attempt_unq" ON "claim_verification_run" USING btree ("claim_id","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "dispute_proposalId_open_unq" ON "dispute" USING btree ("proposal_id") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX "dispute_projectId_status_idx" ON "dispute" USING btree ("project_id","status","id");--> statement-breakpoint
CREATE UNIQUE INDEX "dispute_vote_disputeId_voterMemberId_unq" ON "dispute_vote" USING btree ("dispute_id","voter_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "effort_claim_memberId_idempotencyKey_unq" ON "effort_claim" USING btree ("member_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "effort_claim_dailyLogId_unq" ON "effort_claim" USING btree ("daily_log_id") WHERE daily_log_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "effort_claim_projectId_claimedForDate_idx" ON "effort_claim" USING btree ("project_id","claimed_for_date","id");--> statement-breakpoint
CREATE INDEX "effort_claim_memberId_status_idx" ON "effort_claim" USING btree ("member_id","verification_status");--> statement-breakpoint
CREATE UNIQUE INDEX "equity_snapshot_projectId_asOf_unq" ON "equity_snapshot" USING btree ("project_id","as_of");--> statement-breakpoint
CREATE INDEX "equity_snapshot_projectId_computedAt_idx" ON "equity_snapshot" USING btree ("project_id","computed_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "equity_snapshot_projectId_baked_unq" ON "equity_snapshot" USING btree ("project_id") WHERE is_baked = true;--> statement-breakpoint
CREATE UNIQUE INDEX "equity_snapshot_share_snapshotId_memberId_unq" ON "equity_snapshot_share" USING btree ("snapshot_id","member_id");--> statement-breakpoint
CREATE INDEX "equity_snapshot_share_memberId_idx" ON "equity_snapshot_share" USING btree ("member_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_consent_grant_triple_unq" ON "integration_consent_grant" USING btree ("project_id","member_id","provider");--> statement-breakpoint
CREATE INDEX "integration_consent_grant_memberId_idx" ON "integration_consent_grant" USING btree ("member_id","status");--> statement-breakpoint
CREATE INDEX "member_fair_market_rate_memberId_effectiveFrom_idx" ON "member_fair_market_rate" USING btree ("member_id","effective_from","id");--> statement-breakpoint
CREATE UNIQUE INDEX "member_fair_market_rate_memberId_effectiveFrom_unq" ON "member_fair_market_rate" USING btree ("member_id","effective_from");--> statement-breakpoint
CREATE INDEX "optimization_suggestion_projectId_status_idx" ON "optimization_suggestion" USING btree ("project_id","status","id");--> statement-breakpoint
CREATE UNIQUE INDEX "optimization_suggestion_evidence_seq_unq" ON "optimization_suggestion_evidence" USING btree ("suggestion_id","sequence_number");--> statement-breakpoint
CREATE UNIQUE INDEX "physical_work_receipt_content_unq" ON "physical_work_receipt" USING btree ("project_id","content_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "physical_work_receipt_memberId_idempotencyKey_unq" ON "physical_work_receipt" USING btree ("member_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "physical_work_receipt_claimId_idx" ON "physical_work_receipt" USING btree ("claim_id","id");--> statement-breakpoint
CREATE INDEX "physical_work_receipt_phash_idx" ON "physical_work_receipt" USING btree ("project_id","perceptual_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "pie_bake_event_project_unq" ON "pie_bake_event" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_audit_entry_projectId_sequence_unq" ON "project_audit_entry" USING btree ("project_id","sequence_number");--> statement-breakpoint
CREATE INDEX "project_audit_entry_projectId_occurredAt_idx" ON "project_audit_entry" USING btree ("project_id","occurred_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "receipt_forensics_check_receiptId_kind_unq" ON "receipt_forensics_check" USING btree ("receipt_id","check_kind");--> statement-breakpoint
CREATE UNIQUE INDEX "slice_allocation_proposal_claimId_unq" ON "slice_allocation_proposal" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "slice_allocation_proposal_sweep_idx" ON "slice_allocation_proposal" USING btree ("window_closes_at","id") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX "slice_allocation_proposal_projectId_status_idx" ON "slice_allocation_proposal" USING btree ("project_id","status","id");--> statement-breakpoint
CREATE UNIQUE INDEX "slice_ledger_entry_projectId_sequence_unq" ON "slice_ledger_entry" USING btree ("project_id","sequence_number");--> statement-breakpoint
CREATE INDEX "slice_ledger_entry_memberId_idx" ON "slice_ledger_entry" USING btree ("member_id","sequence_number");--> statement-breakpoint
CREATE INDEX "slice_ledger_entry_projectId_occurredAt_idx" ON "slice_ledger_entry" USING btree ("project_id","occurred_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "slice_ledger_entry_proposalId_unq" ON "slice_ledger_entry" USING btree ("proposal_id") WHERE proposal_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "verification_step_runId_stepKind_unq" ON "verification_step" USING btree ("run_id","step_kind");--> statement-breakpoint
CREATE UNIQUE INDEX "verification_step_runId_stepOrder_unq" ON "verification_step" USING btree ("run_id","step_order");--> statement-breakpoint

-- ===========================================================================
-- HAND-ADDED, BELOW THIS LINE. drizzle-kit diffs only what it declared, so
-- everything here survives every later `db:generate` — the same arrangement
-- 0008 uses for citext and 0010 for the first append-only triggers.
-- R_AND_D_BACKEND_STRUCTURE.md §9.1 enforcement 3, §4f, §17 step 1.
-- ===========================================================================

-- 1. APPEND-ONLY ENFORCEMENT for the formula-produced tables (§9.1).
-- qatoto_reject_mutation() already exists from 0010 and is CREATE OR REPLACE
-- there; these tables simply attach to it, exactly as that migration predicted.
--
-- WHY A TRIGGER AND NOT SERVICE DISCIPLINE. §9.1 says the formula's output is
-- "never hand-edited by anyone — including staff, including the founder,
-- including a DBA". A rule only the application respects is not that rule: it
-- is a rule anyone with a psql prompt can step around. Corrections are
-- REVERSING ENTRIES, never edits.

DROP TRIGGER IF EXISTS slice_ledger_entry_append_only ON "slice_ledger_entry";
--> statement-breakpoint
CREATE TRIGGER slice_ledger_entry_append_only
BEFORE UPDATE OR DELETE ON "slice_ledger_entry"
FOR EACH ROW EXECUTE FUNCTION qatoto_reject_mutation();
--> statement-breakpoint
-- A BEFORE UPDATE OR DELETE *row* trigger does NOT fire on TRUNCATE.
DROP TRIGGER IF EXISTS slice_ledger_entry_no_truncate ON "slice_ledger_entry";
--> statement-breakpoint
CREATE TRIGGER slice_ledger_entry_no_truncate
BEFORE TRUNCATE ON "slice_ledger_entry"
FOR EACH STATEMENT EXECUTE FUNCTION qatoto_reject_mutation();
--> statement-breakpoint

-- The hash chain (§9.9). An entry that can be edited makes every hash after it
-- a statement about bytes that no longer exist.
DROP TRIGGER IF EXISTS project_audit_entry_append_only ON "project_audit_entry";
--> statement-breakpoint
CREATE TRIGGER project_audit_entry_append_only
BEFORE UPDATE OR DELETE ON "project_audit_entry"
FOR EACH ROW EXECUTE FUNCTION qatoto_reject_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS project_audit_entry_no_truncate ON "project_audit_entry";
--> statement-breakpoint
CREATE TRIGGER project_audit_entry_no_truncate
BEFORE TRUNCATE ON "project_audit_entry"
FOR EACH STATEMENT EXECUTE FUNCTION qatoto_reject_mutation();
--> statement-breakpoint

-- Apportioned shares (§9.4). A snapshot is recomputed by writing a NEW snapshot,
-- never by editing an old one — that is what makes "run it 1,000 times and get
-- byte-identical rows" a testable claim.
DROP TRIGGER IF EXISTS equity_snapshot_share_append_only ON "equity_snapshot_share";
--> statement-breakpoint
CREATE TRIGGER equity_snapshot_share_append_only
BEFORE UPDATE OR DELETE ON "equity_snapshot_share"
FOR EACH ROW EXECUTE FUNCTION qatoto_reject_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS equity_snapshot_share_no_truncate ON "equity_snapshot_share";
--> statement-breakpoint
CREATE TRIGGER equity_snapshot_share_no_truncate
BEFORE TRUNCATE ON "equity_snapshot_share"
FOR EACH STATEMENT EXECUTE FUNCTION qatoto_reject_mutation();
--> statement-breakpoint

-- A vote that can be changed after the fact is not a consensus (§9.8).
DROP TRIGGER IF EXISTS dispute_vote_append_only ON "dispute_vote";
--> statement-breakpoint
CREATE TRIGGER dispute_vote_append_only
BEFORE UPDATE OR DELETE ON "dispute_vote"
FOR EACH ROW EXECUTE FUNCTION qatoto_reject_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS dispute_vote_no_truncate ON "dispute_vote";
--> statement-breakpoint
CREATE TRIGGER dispute_vote_no_truncate
BEFORE TRUNCATE ON "dispute_vote"
FOR EACH STATEMENT EXECUTE FUNCTION qatoto_reject_mutation();
--> statement-breakpoint

-- The pie bakes ONCE, EVER, and there is no unbake endpoint (§9.11). The unique
-- index stops a second row; this stops the first one being edited or deleted to
-- make room for it.
DROP TRIGGER IF EXISTS pie_bake_event_append_only ON "pie_bake_event";
--> statement-breakpoint
CREATE TRIGGER pie_bake_event_append_only
BEFORE UPDATE OR DELETE ON "pie_bake_event"
FOR EACH ROW EXECUTE FUNCTION qatoto_reject_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS pie_bake_event_no_truncate ON "pie_bake_event";
--> statement-breakpoint
CREATE TRIGGER pie_bake_event_no_truncate
BEFORE TRUNCATE ON "pie_bake_event"
FOR EACH STATEMENT EXECUTE FUNCTION qatoto_reject_mutation();
--> statement-breakpoint

-- 2. THE RATE LOCK (§9.1 enforcement 3, §9.6).
-- member_fair_market_rate is not blanket append-only: it has a real lifecycle
-- (proposed -> accepted -> locked) and each step legitimately writes a column.
-- What must be impossible is a NUMBER changing after someone agreed to it, and
-- anything at all changing after the lock. This is the narrowest rule that still
-- lets the lifecycle run.
CREATE OR REPLACE FUNCTION qatoto_fair_market_rate_lock_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'locked' THEN
    RAISE EXCEPTION 'member_fair_market_rate %: locked rates are immutable (R_AND_D_BACKEND_STRUCTURE.md 9.6)', OLD.id
      USING ERRCODE = 'QT001';
  END IF;
  -- Once a member has ACCEPTED, the numbers they accepted are frozen. Without
  -- this a founder could accept-then-edit before locking, and the member would
  -- be bound to a rate they never saw.
  IF OLD.status <> 'proposed'
     AND (NEW.fair_market_rate_cents_per_hour IS DISTINCT FROM OLD.fair_market_rate_cents_per_hour
          OR NEW.paid_cash_rate_cents_per_hour IS DISTINCT FROM OLD.paid_cash_rate_cents_per_hour
          OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
          OR NEW.effective_from IS DISTINCT FROM OLD.effective_from) THEN
    RAISE EXCEPTION 'member_fair_market_rate %: the accepted rate, currency and effective date are frozen', OLD.id
      USING ERRCODE = 'QT001';
  END IF;
  -- Identity never moves, in any state. Re-pointing a rate at another member
  -- would re-price their whole history in one UPDATE.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.member_id IS DISTINCT FROM OLD.member_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'member_fair_market_rate %: identity columns are immutable', OLD.id
      USING ERRCODE = 'QT001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS member_fair_market_rate_lock_only ON "member_fair_market_rate";
--> statement-breakpoint
CREATE TRIGGER member_fair_market_rate_lock_only
BEFORE UPDATE ON "member_fair_market_rate"
FOR EACH ROW EXECUTE FUNCTION qatoto_fair_market_rate_lock_only();
--> statement-breakpoint
-- Ledger entries pin fairMarketRateId, so a deleted rate would orphan the proof
-- of how a slice count was derived. The FKs are `restrict` already; this closes
-- the case where no entry references it yet.
DROP TRIGGER IF EXISTS member_fair_market_rate_no_delete ON "member_fair_market_rate";
--> statement-breakpoint
CREATE TRIGGER member_fair_market_rate_no_delete
BEFORE DELETE ON "member_fair_market_rate"
FOR EACH ROW EXECUTE FUNCTION qatoto_reject_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS member_fair_market_rate_no_truncate ON "member_fair_market_rate";
--> statement-breakpoint
CREATE TRIGGER member_fair_market_rate_no_truncate
BEFORE TRUNCATE ON "member_fair_market_rate"
FOR EACH STATEMENT EXECUTE FUNCTION qatoto_reject_mutation();
--> statement-breakpoint

-- 3. REVOCATION DESTROYS THE EVIDENCE, NEVER THE PROOF (§9.10).
-- artifact_evidence must stay mutable in exactly one direction: a consent
-- revocation NULLs raw_payload_json and flips evidence_retained. Everything that
-- makes the claim provable years later — the hash, the provider's own id, when
-- the work happened, whether it was signed — is frozen at write. That is what
-- lets "commit abc123 was signed, valid, at 14:02, hashing to 9f2e..." survive a
-- member deleting their GitHub grant.
CREATE OR REPLACE FUNCTION qatoto_artifact_evidence_purge_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.claim_id IS DISTINCT FROM OLD.claim_id
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.external_id IS DISTINCT FROM OLD.external_id
     OR NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256
     OR NEW.artifact_occurred_at IS DISTINCT FROM OLD.artifact_occurred_at
     OR NEW.signature_status IS DISTINCT FROM OLD.signature_status
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'artifact_evidence %: identity and proof columns are immutable; revocation may only NULL raw_payload_json', OLD.id
      USING ERRCODE = 'QT001';
  END IF;
  -- Purging is one-way. Re-populating a payload after a revocation would restore
  -- data the member asked us to destroy.
  IF OLD.evidence_retained = false AND NEW.raw_payload_json IS NOT NULL THEN
    RAISE EXCEPTION 'artifact_evidence %: purged evidence cannot be repopulated', OLD.id
      USING ERRCODE = 'QT001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS artifact_evidence_purge_only ON "artifact_evidence";
--> statement-breakpoint
CREATE TRIGGER artifact_evidence_purge_only
BEFORE UPDATE ON "artifact_evidence"
FOR EACH ROW EXECUTE FUNCTION qatoto_artifact_evidence_purge_only();
--> statement-breakpoint
DROP TRIGGER IF EXISTS artifact_evidence_no_delete ON "artifact_evidence";
--> statement-breakpoint
CREATE TRIGGER artifact_evidence_no_delete
BEFORE DELETE ON "artifact_evidence"
FOR EACH ROW EXECUTE FUNCTION qatoto_reject_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS artifact_evidence_no_truncate ON "artifact_evidence";
--> statement-breakpoint
CREATE TRIGGER artifact_evidence_no_truncate
BEFORE TRUNCATE ON "artifact_evidence"
FOR EACH STATEMENT EXECUTE FUNCTION qatoto_reject_mutation();
