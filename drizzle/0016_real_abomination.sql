CREATE TYPE "public"."escrow_account_kind" AS ENUM('escrow_held', 'provider_clearing', 'released_to_project', 'platform_fee', 'refunds_payable', 'reconciliation_suspense');--> statement-breakpoint
CREATE TYPE "public"."escrow_entry_settlement" AS ENUM('pending', 'settled', 'failed');--> statement-breakpoint
CREATE TYPE "public"."escrow_journal_kind" AS ENUM('pledge_authorized', 'pledge_settled', 'pledge_failed', 'pledge_cancelled', 'pledge_refunded', 'platform_fee_charged', 'milestone_release', 'reconciliation_adjustment', 'reversal');--> statement-breakpoint
CREATE TYPE "public"."escrow_release_status" AS ENUM('requested', 'approved', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."funding_round_status" AS ENUM('draft', 'open', 'closed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."funding_round_type" AS ENUM('crowdfunding', 'equity', 'venture');--> statement-breakpoint
CREATE TYPE "public"."milestone_status" AS ENUM('planned', 'in_progress', 'done', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."payment_provider" AS ENUM('internal_adapter', 'stripe');--> statement-breakpoint
CREATE TYPE "public"."pledge_status" AS ENUM('pending', 'settled', 'failed', 'cancelled', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."provider_transfer_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."provider_transfer_status" AS ENUM('created', 'submitted', 'settled', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."reconciliation_discrepancy_status" AS ENUM('open', 'resolved', 'written_off');--> statement-breakpoint
CREATE TYPE "public"."variance_effort_unit_key" AS ENUM('minutes', 'hours');--> statement-breakpoint
CREATE TYPE "public"."variance_schedule_unit_key" AS ENUM('days', 'weeks');--> statement-breakpoint
ALTER TYPE "public"."project_audit_event_kind" ADD VALUE 'funding_round_opened';--> statement-breakpoint
ALTER TYPE "public"."project_audit_event_kind" ADD VALUE 'funding_round_closed';--> statement-breakpoint
ALTER TYPE "public"."project_audit_event_kind" ADD VALUE 'pledge_recorded';--> statement-breakpoint
ALTER TYPE "public"."project_audit_event_kind" ADD VALUE 'pledge_settled';--> statement-breakpoint
ALTER TYPE "public"."project_audit_event_kind" ADD VALUE 'pledge_failed';--> statement-breakpoint
ALTER TYPE "public"."project_audit_event_kind" ADD VALUE 'pledge_cancelled';--> statement-breakpoint
ALTER TYPE "public"."project_audit_event_kind" ADD VALUE 'escrow_release_requested';--> statement-breakpoint
ALTER TYPE "public"."project_audit_event_kind" ADD VALUE 'escrow_release_approved';--> statement-breakpoint
ALTER TYPE "public"."project_audit_event_kind" ADD VALUE 'escrow_release_rejected';--> statement-breakpoint
ALTER TYPE "public"."project_audit_event_kind" ADD VALUE 'reconciliation_discrepancy_opened';--> statement-breakpoint
CREATE TABLE "escrow_account" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"kind" "escrow_account_kind" NOT NULL,
	"currency" text NOT NULL,
	"cached_balance_in_cents" bigint DEFAULT 0 NOT NULL,
	"pending_balance_in_cents" bigint DEFAULT 0 NOT NULL,
	"balance_through_sequence_number" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "escrow_account_currency_ck" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "escrow_account_sequence_ck" CHECK (balance_through_sequence_number >= 0)
);
--> statement-breakpoint
CREATE TABLE "escrow_journal_entry" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"sequence_number" integer NOT NULL,
	"kind" "escrow_journal_kind" NOT NULL,
	"description" text NOT NULL,
	"currency" text NOT NULL,
	"occurred_at" timestamp NOT NULL,
	"settlement" "escrow_entry_settlement" DEFAULT 'pending' NOT NULL,
	"linked_milestone_id" text,
	"linked_pledge_id" text,
	"linked_release_id" text,
	"reverses_journal_entry_id" text,
	"entry_hash" text NOT NULL,
	"previous_entry_hash" text NOT NULL,
	"hash_version" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "escrow_journal_entry_sequence_ck" CHECK (sequence_number >= 1),
	CONSTRAINT "escrow_journal_entry_hash_ck" CHECK (entry_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "escrow_journal_entry_link_ck" CHECK ((sequence_number = 1) = (previous_entry_hash = 'genesis')
          AND (previous_entry_hash = 'genesis' OR previous_entry_hash ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "escrow_journal_entry_reversal_ck" CHECK ((kind <> 'reversal') OR (reverses_journal_entry_id IS NOT NULL)),
	CONSTRAINT "escrow_journal_entry_currency_ck" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "escrow_journal_entry_description_ck" CHECK (char_length(description) BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE TABLE "escrow_posting" (
	"id" text PRIMARY KEY NOT NULL,
	"journal_entry_id" text NOT NULL,
	"project_id" text NOT NULL,
	"account_id" text NOT NULL,
	"account_kind" "escrow_account_kind" NOT NULL,
	"signed_amount_in_cents" bigint NOT NULL,
	"posting_index" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "escrow_posting_index_ck" CHECK (posting_index >= 0),
	CONSTRAINT "escrow_posting_amount_ck" CHECK (signed_amount_in_cents <> 0)
);
--> statement-breakpoint
CREATE TABLE "escrow_release" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"milestone_id" text NOT NULL,
	"amount_in_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"status" "escrow_release_status" DEFAULT 'requested' NOT NULL,
	"requested_by_user_id" text NOT NULL,
	"request_note" text,
	"requested_at" timestamp DEFAULT now() NOT NULL,
	"decided_by_user_id" text,
	"decision_note" text,
	"decided_at" timestamp,
	"verification_snapshot" text,
	"journal_entry_id" text,
	"provider_transfer_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "escrow_release_amount_ck" CHECK (amount_in_cents > 0),
	CONSTRAINT "escrow_release_currency_ck" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "escrow_release_four_eyes_ck" CHECK (decided_by_user_id IS NULL OR decided_by_user_id <> requested_by_user_id),
	CONSTRAINT "escrow_release_decision_ck" CHECK ((status IN ('approved','rejected'))
          = (decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL
             AND verification_snapshot IS NOT NULL)),
	CONSTRAINT "escrow_release_journal_ck" CHECK ((status = 'approved') = (journal_entry_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "funding_round" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"type" "funding_round_type" NOT NULL,
	"status" "funding_round_status" DEFAULT 'draft' NOT NULL,
	"goal_amount_in_cents" bigint NOT NULL,
	"raised_amount_in_cents" bigint DEFAULT 0 NOT NULL,
	"backers_count" integer DEFAULT 0 NOT NULL,
	"minimum_pledge_in_cents" bigint DEFAULT 100 NOT NULL,
	"maximum_pledge_in_cents" bigint,
	"currency" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"opens_at" timestamp,
	"closes_at" timestamp,
	"closed_at" timestamp,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "funding_round_goal_ck" CHECK (goal_amount_in_cents > 0),
	CONSTRAINT "funding_round_raised_ck" CHECK (raised_amount_in_cents >= 0 AND backers_count >= 0),
	CONSTRAINT "funding_round_bounds_ck" CHECK (minimum_pledge_in_cents >= 1
          AND (maximum_pledge_in_cents IS NULL
               OR maximum_pledge_in_cents >= minimum_pledge_in_cents)),
	CONSTRAINT "funding_round_window_ck" CHECK (opens_at IS NULL OR closes_at IS NULL OR closes_at > opens_at),
	CONSTRAINT "funding_round_open_ck" CHECK ((status <> 'open') OR (opens_at IS NOT NULL)),
	CONSTRAINT "funding_round_closed_at_ck" CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
	CONSTRAINT "funding_round_currency_ck" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "funding_round_title_ck" CHECK (char_length(title) BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE TABLE "funding_round_pledge" (
	"id" text PRIMARY KEY NOT NULL,
	"round_id" text NOT NULL,
	"project_id" text NOT NULL,
	"backer_user_id" text NOT NULL,
	"amount_in_cents" bigint NOT NULL,
	"platform_fee_in_cents" bigint NOT NULL,
	"net_to_escrow_in_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"status" "pledge_status" DEFAULT 'pending' NOT NULL,
	"provider_transfer_id" text,
	"settled_at" timestamp,
	"cancelled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "funding_round_pledge_amounts_ck" CHECK (amount_in_cents > 0
          AND platform_fee_in_cents >= 0
          AND platform_fee_in_cents <= amount_in_cents
          AND net_to_escrow_in_cents = amount_in_cents - platform_fee_in_cents),
	CONSTRAINT "funding_round_pledge_settled_at_ck" CHECK ((status IN ('settled','refunded')) = (settled_at IS NOT NULL)),
	CONSTRAINT "funding_round_pledge_cancelled_at_ck" CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
	CONSTRAINT "funding_round_pledge_currency_ck" CHECK (currency ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "investor_confidence_snapshot" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"as_of" timestamp NOT NULL,
	"window_starts_at" timestamp NOT NULL,
	"window_ends_at" timestamp NOT NULL,
	"confidence_basis_points" integer NOT NULL,
	"trend" "trend_direction" DEFAULT 'flat' NOT NULL,
	"daily_log_streak_days" integer DEFAULT 0 NOT NULL,
	"verified_milestone_count" integer DEFAULT 0 NOT NULL,
	"total_milestone_count" integer DEFAULT 0 NOT NULL,
	"open_dispute_count" integer DEFAULT 0 NOT NULL,
	"resolved_dispute_count" integer DEFAULT 0 NOT NULL,
	"computed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "investor_confidence_snapshot_basis_points_ck" CHECK (confidence_basis_points BETWEEN 0 AND 10000),
	CONSTRAINT "investor_confidence_snapshot_counts_ck" CHECK (daily_log_streak_days >= 0 AND verified_milestone_count >= 0
          AND total_milestone_count >= verified_milestone_count
          AND open_dispute_count >= 0 AND resolved_dispute_count >= 0),
	CONSTRAINT "investor_confidence_snapshot_window_ck" CHECK (window_ends_at > window_starts_at)
);
--> statement-breakpoint
CREATE TABLE "milestone" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" "milestone_status" DEFAULT 'planned' NOT NULL,
	"escrow_release_amount_in_cents" bigint DEFAULT 0 NOT NULL,
	"currency" text NOT NULL,
	"due_date" date,
	"completed_at" timestamp,
	"order_index" integer NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "milestone_amount_ck" CHECK (escrow_release_amount_in_cents >= 0),
	CONSTRAINT "milestone_order_ck" CHECK (order_index >= 0),
	CONSTRAINT "milestone_title_ck" CHECK (char_length(title) BETWEEN 1 AND 200),
	CONSTRAINT "milestone_completed_at_ck" CHECK ((status = 'done') = (completed_at IS NOT NULL)),
	CONSTRAINT "milestone_currency_ck" CHECK (currency ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "milestone_variance" (
	"milestone_id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"planned_duration_days" integer NOT NULL,
	"actual_duration_days" integer NOT NULL,
	"planned_cost_in_cents" bigint NOT NULL,
	"actual_cost_in_cents" bigint NOT NULL,
	"planned_effort_minutes" integer NOT NULL,
	"actual_effort_minutes" integer NOT NULL,
	"schedule_unit_key" "variance_schedule_unit_key" DEFAULT 'days' NOT NULL,
	"effort_unit_key" "variance_effort_unit_key" DEFAULT 'minutes' NOT NULL,
	"variance_basis_points" integer NOT NULL,
	"currency" text NOT NULL,
	"computed_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "milestone_variance_non_negative_ck" CHECK (planned_duration_days >= 0 AND actual_duration_days >= 0
          AND planned_cost_in_cents >= 0 AND actual_cost_in_cents >= 0
          AND planned_effort_minutes >= 0 AND actual_effort_minutes >= 0),
	CONSTRAINT "milestone_variance_basis_points_ck" CHECK (variance_basis_points BETWEEN -1000000 AND 1000000),
	CONSTRAINT "milestone_variance_currency_ck" CHECK (currency ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "provider_transfer" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"provider" "payment_provider" DEFAULT 'internal_adapter' NOT NULL,
	"direction" "provider_transfer_direction" NOT NULL,
	"status" "provider_transfer_status" DEFAULT 'created' NOT NULL,
	"amount_in_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"provider_transfer_ref" text,
	"payout_destination_id" text,
	"failure_reason" text,
	"submitted_at" timestamp,
	"settled_at" timestamp,
	"failed_at" timestamp,
	"settlement_decided_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "provider_transfer_amount_ck" CHECK (amount_in_cents > 0),
	CONSTRAINT "provider_transfer_currency_ck" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "provider_transfer_destination_ck" CHECK ((direction = 'outbound') OR (payout_destination_id IS NULL)),
	CONSTRAINT "provider_transfer_submitted_at_ck" CHECK ((status = 'created') = (submitted_at IS NULL)),
	CONSTRAINT "provider_transfer_settled_at_ck" CHECK ((status = 'settled') = (settled_at IS NOT NULL)),
	CONSTRAINT "provider_transfer_failed_at_ck" CHECK ((status = 'failed') = (failed_at IS NOT NULL)
          AND (status = 'failed') = (failure_reason IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "provider_webhook_event" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" "payment_provider" DEFAULT 'internal_adapter' NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"project_id" text,
	"provider_transfer_id" text,
	"payload_json" text NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp,
	"processing_error" text
);
--> statement-breakpoint
CREATE TABLE "reconciliation_discrepancy" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"account_kind" "escrow_account_kind" NOT NULL,
	"as_of" timestamp NOT NULL,
	"ledger_balance_in_cents" bigint NOT NULL,
	"provider_balance_in_cents" bigint NOT NULL,
	"delta_in_cents" bigint NOT NULL,
	"status" "reconciliation_discrepancy_status" DEFAULT 'open' NOT NULL,
	"journal_entry_id" text,
	"resolution_note" text,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "reconciliation_discrepancy_delta_ck" CHECK (delta_in_cents = provider_balance_in_cents - ledger_balance_in_cents),
	CONSTRAINT "reconciliation_discrepancy_resolved_ck" CHECK ((status = 'open') = (resolved_at IS NULL))
);
--> statement-breakpoint
ALTER TABLE "project_chain_head" DROP CONSTRAINT "project_chain_head_sequence_ck";--> statement-breakpoint
ALTER TABLE "project_chain_head" DROP CONSTRAINT "project_chain_head_hash_ck";--> statement-breakpoint
ALTER TABLE "project_chain_head" ADD COLUMN "last_escrow_sequence_number" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_chain_head" ADD COLUMN "escrow_head_entry_hash" text;--> statement-breakpoint
ALTER TABLE "project_chain_head" ADD COLUMN "escrow_head_entry_id" text;--> statement-breakpoint
ALTER TABLE "project_member" ADD COLUMN "role_granted_by_user_id" text;--> statement-breakpoint
ALTER TABLE "escrow_account" ADD CONSTRAINT "escrow_account_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escrow_journal_entry" ADD CONSTRAINT "escrow_journal_entry_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escrow_journal_entry" ADD CONSTRAINT "escrow_journal_entry_linked_milestone_id_milestone_id_fk" FOREIGN KEY ("linked_milestone_id") REFERENCES "public"."milestone"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escrow_journal_entry" ADD CONSTRAINT "escrow_journal_entry_linked_pledge_id_funding_round_pledge_id_fk" FOREIGN KEY ("linked_pledge_id") REFERENCES "public"."funding_round_pledge"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escrow_journal_entry" ADD CONSTRAINT "escrow_journal_entry_linked_release_id_escrow_release_id_fk" FOREIGN KEY ("linked_release_id") REFERENCES "public"."escrow_release"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escrow_journal_entry" ADD CONSTRAINT "escrow_journal_entry_reverses_journal_entry_id_escrow_journal_entry_id_fk" FOREIGN KEY ("reverses_journal_entry_id") REFERENCES "public"."escrow_journal_entry"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escrow_journal_entry" ADD CONSTRAINT "escrow_journal_entry_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escrow_posting" ADD CONSTRAINT "escrow_posting_journal_entry_id_escrow_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."escrow_journal_entry"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escrow_posting" ADD CONSTRAINT "escrow_posting_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escrow_posting" ADD CONSTRAINT "escrow_posting_account_id_escrow_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."escrow_account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escrow_release" ADD CONSTRAINT "escrow_release_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escrow_release" ADD CONSTRAINT "escrow_release_milestone_id_milestone_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestone"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escrow_release" ADD CONSTRAINT "escrow_release_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escrow_release" ADD CONSTRAINT "escrow_release_decided_by_user_id_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escrow_release" ADD CONSTRAINT "escrow_release_journal_entry_id_escrow_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."escrow_journal_entry"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escrow_release" ADD CONSTRAINT "escrow_release_provider_transfer_id_provider_transfer_id_fk" FOREIGN KEY ("provider_transfer_id") REFERENCES "public"."provider_transfer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_round" ADD CONSTRAINT "funding_round_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_round" ADD CONSTRAINT "funding_round_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_round_pledge" ADD CONSTRAINT "funding_round_pledge_round_id_funding_round_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."funding_round"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_round_pledge" ADD CONSTRAINT "funding_round_pledge_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_round_pledge" ADD CONSTRAINT "funding_round_pledge_backer_user_id_user_id_fk" FOREIGN KEY ("backer_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_round_pledge" ADD CONSTRAINT "funding_round_pledge_provider_transfer_id_provider_transfer_id_fk" FOREIGN KEY ("provider_transfer_id") REFERENCES "public"."provider_transfer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investor_confidence_snapshot" ADD CONSTRAINT "investor_confidence_snapshot_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestone" ADD CONSTRAINT "milestone_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestone" ADD CONSTRAINT "milestone_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestone_variance" ADD CONSTRAINT "milestone_variance_milestone_id_milestone_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestone"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestone_variance" ADD CONSTRAINT "milestone_variance_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_transfer" ADD CONSTRAINT "provider_transfer_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_transfer" ADD CONSTRAINT "provider_transfer_settlement_decided_by_user_id_user_id_fk" FOREIGN KEY ("settlement_decided_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_webhook_event" ADD CONSTRAINT "provider_webhook_event_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_webhook_event" ADD CONSTRAINT "provider_webhook_event_provider_transfer_id_provider_transfer_id_fk" FOREIGN KEY ("provider_transfer_id") REFERENCES "public"."provider_transfer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_discrepancy" ADD CONSTRAINT "reconciliation_discrepancy_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_discrepancy" ADD CONSTRAINT "reconciliation_discrepancy_journal_entry_id_escrow_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."escrow_journal_entry"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "escrow_account_projectId_kind_unq" ON "escrow_account" USING btree ("project_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "escrow_journal_entry_project_seq_unq" ON "escrow_journal_entry" USING btree ("project_id","sequence_number");--> statement-breakpoint
CREATE INDEX "escrow_journal_entry_project_occurredAt_idx" ON "escrow_journal_entry" USING btree ("project_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "escrow_journal_entry_settlement_idx" ON "escrow_journal_entry" USING btree ("settlement");--> statement-breakpoint
CREATE INDEX "escrow_journal_entry_linkedPledgeId_idx" ON "escrow_journal_entry" USING btree ("linked_pledge_id");--> statement-breakpoint
CREATE UNIQUE INDEX "escrow_posting_entry_index_unq" ON "escrow_posting" USING btree ("journal_entry_id","posting_index");--> statement-breakpoint
CREATE INDEX "escrow_posting_account_idx" ON "escrow_posting" USING btree ("account_id","id");--> statement-breakpoint
CREATE INDEX "escrow_posting_projectId_kind_idx" ON "escrow_posting" USING btree ("project_id","account_kind");--> statement-breakpoint
CREATE INDEX "escrow_release_projectId_status_idx" ON "escrow_release" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "escrow_release_milestoneId_idx" ON "escrow_release" USING btree ("milestone_id");--> statement-breakpoint
CREATE UNIQUE INDEX "escrow_release_milestone_requested_unq" ON "escrow_release" USING btree ("milestone_id") WHERE status = 'requested';--> statement-breakpoint
CREATE UNIQUE INDEX "escrow_release_milestone_approved_unq" ON "escrow_release" USING btree ("milestone_id") WHERE status = 'approved';--> statement-breakpoint
CREATE INDEX "funding_round_projectId_status_idx" ON "funding_round" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "funding_round_deals_idx" ON "funding_round" USING btree ("status","type","closes_at","id");--> statement-breakpoint
CREATE INDEX "funding_round_pledge_roundId_idx" ON "funding_round_pledge" USING btree ("round_id","created_at","id");--> statement-breakpoint
CREATE INDEX "funding_round_pledge_backerUserId_idx" ON "funding_round_pledge" USING btree ("backer_user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "funding_round_pledge_projectId_status_idx" ON "funding_round_pledge" USING btree ("project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "funding_round_pledge_providerTransferId_unq" ON "funding_round_pledge" USING btree ("provider_transfer_id") WHERE provider_transfer_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "investor_confidence_snapshot_project_asOf_unq" ON "investor_confidence_snapshot" USING btree ("project_id","as_of");--> statement-breakpoint
CREATE INDEX "investor_confidence_snapshot_projectId_asOf_idx" ON "investor_confidence_snapshot" USING btree ("project_id","as_of","id");--> statement-breakpoint
CREATE UNIQUE INDEX "milestone_projectId_orderIndex_unq" ON "milestone" USING btree ("project_id","order_index");--> statement-breakpoint
CREATE INDEX "milestone_projectId_status_idx" ON "milestone" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "milestone_variance_projectId_idx" ON "milestone_variance" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_transfer_idempotencyKey_unq" ON "provider_transfer" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "provider_transfer_projectId_status_idx" ON "provider_transfer" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "provider_transfer_status_createdAt_idx" ON "provider_transfer" USING btree ("status","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_webhook_event_provider_eventId_unq" ON "provider_webhook_event" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "provider_webhook_event_transferId_idx" ON "provider_webhook_event" USING btree ("provider_transfer_id");--> statement-breakpoint
CREATE INDEX "provider_webhook_event_processedAt_idx" ON "provider_webhook_event" USING btree ("processed_at","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_discrepancy_project_account_asOf_unq" ON "reconciliation_discrepancy" USING btree ("project_id","account_kind","as_of");--> statement-breakpoint
CREATE INDEX "reconciliation_discrepancy_status_idx" ON "reconciliation_discrepancy" USING btree ("status","as_of");--> statement-breakpoint
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_role_granted_by_user_id_user_id_fk" FOREIGN KEY ("role_granted_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_chain_head" ADD CONSTRAINT "project_chain_head_sequence_ck" CHECK (last_audit_sequence_number >= 0 AND last_ledger_sequence_number >= 0
          AND last_escrow_sequence_number >= 0);--> statement-breakpoint
ALTER TABLE "project_chain_head" ADD CONSTRAINT "project_chain_head_hash_ck" CHECK ((head_entry_hash IS NULL OR head_entry_hash ~ '^[0-9a-f]{64}$')
          AND (last_anchored_hash IS NULL OR last_anchored_hash ~ '^[0-9a-f]{64}$')
          AND (escrow_head_entry_hash IS NULL OR escrow_head_entry_hash ~ '^[0-9a-f]{64}$')
          AND (last_audit_sequence_number = 0) = (head_entry_hash IS NULL)
          AND (last_escrow_sequence_number = 0) = (escrow_head_entry_hash IS NULL));--> statement-breakpoint
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_role_granted_by_ck" CHECK ((project_role <> 'admin')
          OR (role_granted_by_user_id IS NULL)
          OR (role_granted_by_user_id <> user_id));--> statement-breakpoint

-- ===========================================================================
-- HAND-ADDED, BELOW THIS LINE. drizzle-kit diffs only what it declared, so
-- everything here survives every later `db:generate` — the same arrangement
-- 0008 uses for citext, 0010 for the first append-only triggers and 0014 for
-- §9's. R_AND_D_BACKEND_STRUCTURE.md §7, §4f, §17 step 1.
--
-- §7 IS THE HIGHEST-STAKES SURFACE IN THE PRODUCT and it says so in its own
-- first line. Everything below is the part that is true even when the
-- application is wrong.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. APPEND-ONLY ENFORCEMENT for the ledger (§7 "enforced four ways").
--
-- qatoto_reject_mutation() already exists from 0010 and is CREATE OR REPLACE
-- there; these tables simply attach to it, exactly as that migration predicted.
--
-- WHY A TRIGGER AND NOT SERVICE DISCIPLINE. §7 is explicit: "Service-layer
-- discipline is not enforcement." A rule only the application respects is a
-- rule anyone with a psql prompt steps around, and the thing being stepped
-- around here is a financial ledger. Corrections are REVERSING ENTRIES
-- (escrow_journal_entry.reverses_journal_entry_id), never edits.
DROP TRIGGER IF EXISTS escrow_journal_entry_append_only ON "escrow_journal_entry";
--> statement-breakpoint
CREATE TRIGGER escrow_journal_entry_append_only
BEFORE UPDATE OR DELETE ON "escrow_journal_entry"
FOR EACH ROW EXECUTE FUNCTION qatoto_reject_mutation();
--> statement-breakpoint
-- A BEFORE UPDATE OR DELETE *row* trigger does NOT fire on TRUNCATE.
DROP TRIGGER IF EXISTS escrow_journal_entry_no_truncate ON "escrow_journal_entry";
--> statement-breakpoint
CREATE TRIGGER escrow_journal_entry_no_truncate
BEFORE TRUNCATE ON "escrow_journal_entry"
FOR EACH STATEMENT EXECUTE FUNCTION qatoto_reject_mutation();
--> statement-breakpoint

-- The postings are the money. An editable posting makes the zero-sum invariant
-- a statement about bytes that no longer exist, and makes every entry hash
-- after it a signature over a document nobody can reproduce.
DROP TRIGGER IF EXISTS escrow_posting_append_only ON "escrow_posting";
--> statement-breakpoint
CREATE TRIGGER escrow_posting_append_only
BEFORE UPDATE OR DELETE ON "escrow_posting"
FOR EACH ROW EXECUTE FUNCTION qatoto_reject_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS escrow_posting_no_truncate ON "escrow_posting";
--> statement-breakpoint
CREATE TRIGGER escrow_posting_no_truncate
BEFORE TRUNCATE ON "escrow_posting"
FOR EACH STATEMENT EXECUTE FUNCTION qatoto_reject_mutation();
--> statement-breakpoint

-- The provider's own events are evidence of what arrived. `processed_at` and
-- `processing_error` legitimately move once, so this is NOT blanket
-- append-only — but the event's identity and its payload never change, or the
-- dedupe key stops describing the thing it deduped.
CREATE OR REPLACE FUNCTION qatoto_provider_webhook_event_process_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.provider_event_id IS DISTINCT FROM OLD.provider_event_id
     OR NEW.event_type IS DISTINCT FROM OLD.event_type
     OR NEW.payload_json IS DISTINCT FROM OLD.payload_json
     OR NEW.provider_transfer_id IS DISTINCT FROM OLD.provider_transfer_id
     OR NEW.received_at IS DISTINCT FROM OLD.received_at THEN
    RAISE EXCEPTION 'provider_webhook_event %: identity and payload are immutable; only processing state may move', OLD.id
      USING ERRCODE = 'QT001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS provider_webhook_event_process_only ON "provider_webhook_event";
--> statement-breakpoint
CREATE TRIGGER provider_webhook_event_process_only
BEFORE UPDATE ON "provider_webhook_event"
FOR EACH ROW EXECUTE FUNCTION qatoto_provider_webhook_event_process_only();
--> statement-breakpoint
DROP TRIGGER IF EXISTS provider_webhook_event_no_delete ON "provider_webhook_event";
--> statement-breakpoint
CREATE TRIGGER provider_webhook_event_no_delete
BEFORE DELETE ON "provider_webhook_event"
FOR EACH ROW EXECUTE FUNCTION qatoto_reject_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS provider_webhook_event_no_truncate ON "provider_webhook_event";
--> statement-breakpoint
CREATE TRIGGER provider_webhook_event_no_truncate
BEFORE TRUNCATE ON "provider_webhook_event"
FOR EACH STATEMENT EXECUTE FUNCTION qatoto_reject_mutation();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. THE ZERO-SUM INVARIANT (§7, "a machine-checkable proof that no money was
--    conjured").
--
-- The postings of one journal entry MUST sum to exactly zero. The service
-- asserts it before commit and the nightly job asserts it again, but a proof
-- only the application performs is not the proof §7 is claiming — so Postgres
-- performs it too.
--
-- DEFERRABLE INITIALLY DEFERRED IS LOAD-BEARING, not a nicety. Postings are
-- inserted one row at a time; a non-deferred trigger would fire after the FIRST
-- insert, see a non-zero sum, and reject every correct entry ever written. The
-- check has to run at COMMIT, when the entry is complete.
--
-- FOR EACH ROW rather than a statement trigger: a statement trigger has no
-- OLD/NEW row and would have to scan every entry touched, and multi-entry
-- transactions (a settlement that also charges a fee) are normal here.
-- Re-checking the same entry once per posting is a handful of indexed rows.
CREATE OR REPLACE FUNCTION qatoto_escrow_entry_balances() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  posting_total bigint;
  posting_count integer;
BEGIN
  SELECT COALESCE(SUM(signed_amount_in_cents), 0), COUNT(*)
    INTO posting_total, posting_count
    FROM "escrow_posting"
   WHERE journal_entry_id = NEW.journal_entry_id;

  -- Double entry means TWO postings minimum. One posting summing to zero is
  -- impossible (a zero amount is already rejected by escrow_posting_amount_ck),
  -- but an entry with a single row could still arrive if that check were ever
  -- relaxed, and "money moved from nowhere to nowhere" must not be spellable.
  IF posting_count < 2 THEN
    RAISE EXCEPTION 'escrow journal entry %: double entry needs at least 2 postings, found %',
      NEW.journal_entry_id, posting_count
      USING ERRCODE = 'QT002';
  END IF;

  IF posting_total <> 0 THEN
    RAISE EXCEPTION 'escrow journal entry %: postings sum to % cents, not zero (R_AND_D_BACKEND_STRUCTURE.md 7)',
      NEW.journal_entry_id, posting_total
      USING ERRCODE = 'QT002';
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS escrow_posting_zero_sum ON "escrow_posting";
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER escrow_posting_zero_sum
AFTER INSERT ON "escrow_posting"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qatoto_escrow_entry_balances();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. THE RELEASE SNAPSHOT AND THE FOUR-EYES DECISION (§7).
--
-- escrow_release is NOT blanket append-only: it has a real lifecycle
-- (requested -> approved | rejected | cancelled) and the decision legitimately
-- writes four columns. What must be impossible is the AMOUNT moving after the
-- request — §7's entire reason for snapshotting it is that a founder must not
-- be able to edit the milestone between request and approval to inflate a
-- payout, and an UPDATE on this column is the same attack through a shorter
-- path. Everything about the decision is frozen once it is made.
--
-- Modelled on 0014's qatoto_fair_market_rate_lock_only(): the narrowest rule
-- that still lets the lifecycle run.
CREATE OR REPLACE FUNCTION qatoto_escrow_release_decide_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- A decided release is finished. Nothing about it moves again, ever.
  IF OLD.status IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'escrow_release %: a % release is immutable (R_AND_D_BACKEND_STRUCTURE.md 7)', OLD.id, OLD.status
      USING ERRCODE = 'QT001';
  END IF;

  -- THE SNAPSHOT. Frozen from the instant of the request, in every state.
  IF NEW.amount_in_cents IS DISTINCT FROM OLD.amount_in_cents
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.milestone_id IS DISTINCT FROM OLD.milestone_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION 'escrow_release %: the snapshotted amount, milestone and requester are immutable', OLD.id
      USING ERRCODE = 'QT001';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS escrow_release_decide_only ON "escrow_release";
--> statement-breakpoint
CREATE TRIGGER escrow_release_decide_only
BEFORE UPDATE ON "escrow_release"
FOR EACH ROW EXECUTE FUNCTION qatoto_escrow_release_decide_only();
--> statement-breakpoint
-- A deleted release is a payout with no request behind it. The FKs from
-- escrow_journal_entry are `set null` (§4f: financial history outlives the
-- thing it records), so this closes the case where nothing points at it yet.
DROP TRIGGER IF EXISTS escrow_release_no_delete ON "escrow_release";
--> statement-breakpoint
CREATE TRIGGER escrow_release_no_delete
BEFORE DELETE ON "escrow_release"
FOR EACH ROW EXECUTE FUNCTION qatoto_reject_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS escrow_release_no_truncate ON "escrow_release";
--> statement-breakpoint
CREATE TRIGGER escrow_release_no_truncate
BEFORE TRUNCATE ON "escrow_release"
FOR EACH STATEMENT EXECUTE FUNCTION qatoto_reject_mutation();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. THE PROVIDER TRANSFER'S IDENTITY (§7).
--
-- The idempotency key is OURS and is minted BEFORE any provider call. A key
-- that can be edited afterwards deduplicates nothing, and an amount that can be
-- edited after submission means the row no longer describes the money that
-- moved. The status machine still has to run, so this is again the narrow rule.
CREATE OR REPLACE FUNCTION qatoto_provider_transfer_identity_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.amount_in_cents IS DISTINCT FROM OLD.amount_in_cents
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.direction IS DISTINCT FROM OLD.direction
     OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION 'provider_transfer %: idempotency key, amount, currency, direction and project are immutable', OLD.id
      USING ERRCODE = 'QT001';
  END IF;

  -- Settlement and failure are TERMINAL. §7: "Never trust the webhook payload's
  -- amount over our own provider_transfer row" — and never let a settled
  -- transfer be re-settled into a second balance movement either.
  IF OLD.status IN ('settled', 'failed', 'cancelled')
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'provider_transfer %: % is terminal', OLD.id, OLD.status
      USING ERRCODE = 'QT001';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS provider_transfer_identity_frozen ON "provider_transfer";
--> statement-breakpoint
CREATE TRIGGER provider_transfer_identity_frozen
BEFORE UPDATE ON "provider_transfer"
FOR EACH ROW EXECUTE FUNCTION qatoto_provider_transfer_identity_frozen();
--> statement-breakpoint
DROP TRIGGER IF EXISTS provider_transfer_no_delete ON "provider_transfer";
--> statement-breakpoint
CREATE TRIGGER provider_transfer_no_delete
BEFORE DELETE ON "provider_transfer"
FOR EACH ROW EXECUTE FUNCTION qatoto_reject_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS provider_transfer_no_truncate ON "provider_transfer";
--> statement-breakpoint
CREATE TRIGGER provider_transfer_no_truncate
BEFORE TRUNCATE ON "provider_transfer"
FOR EACH STATEMENT EXECUTE FUNCTION qatoto_reject_mutation();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. GRANT REVOCATION (§7 enforcement 1, §4f).
-- Same honest caveat as 0010, 0011 and 0014: REVOKE has NO effect on a table's
-- OWNER, and DATABASE_URL connects as the owner today. The TRIGGERS above are
-- the real enforcement in this phase; this block is a guarded placeholder that
-- documents the infra task — provision a non-owner `qatoto_app` role and
-- repoint DATABASE_URL at it, at which point this becomes load-bearing with no
-- migration change.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qatoto_app') THEN
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "escrow_journal_entry" FROM qatoto_app';
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "escrow_posting" FROM qatoto_app';
    EXECUTE 'REVOKE DELETE, TRUNCATE ON TABLE "provider_webhook_event" FROM qatoto_app';
    EXECUTE 'REVOKE DELETE, TRUNCATE ON TABLE "provider_transfer" FROM qatoto_app';
    EXECUTE 'REVOKE DELETE, TRUNCATE ON TABLE "escrow_release" FROM qatoto_app';
  END IF;
END $$;
