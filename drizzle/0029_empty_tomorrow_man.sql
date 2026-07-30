CREATE TYPE "public"."research_contribution_kind" AS ENUM('cash_commitment', 'material', 'data', 'equipment', 'expertise');--> statement-breakpoint
CREATE TYPE "public"."research_paper_moderation_status" AS ENUM('queued', 'approved', 'rejected', 'needs_changes');--> statement-breakpoint
CREATE TYPE "public"."research_program_branch_status" AS ENUM('active', 'emerging', 'contested', 'missing');--> statement-breakpoint
CREATE TYPE "public"."research_program_content_target_kind" AS ENUM('paper', 'post');--> statement-breakpoint
CREATE TYPE "public"."research_program_moderation_kind" AS ENUM('program_published', 'program_rejected', 'paper_approved', 'paper_rejected', 'paper_needs_changes', 'post_hidden', 'post_restored', 'report_dismissed');--> statement-breakpoint
CREATE TYPE "public"."research_program_participant_role" AS ENUM('researcher', 'founder_director', 'venture_capitalist', 'supplier', 'supporter');--> statement-breakpoint
CREATE TYPE "public"."research_program_post_track" AS ENUM('informal_paper', 'idea');--> statement-breakpoint
CREATE TYPE "public"."research_program_report_reason" AS ENUM('spam', 'plagiarism', 'misinformation', 'harassment', 'off_topic', 'other');--> statement-breakpoint
CREATE TYPE "public"."research_program_report_status" AS ENUM('open', 'actioned', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."research_program_status" AS ENUM('pending', 'published', 'rejected', 'archived');--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'research_program_published';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'research_program_rejected';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'research_program_paper_moderated';--> statement-breakpoint
ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE 'research_program_published';--> statement-breakpoint
ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE 'research_program_rejected';--> statement-breakpoint
ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE 'research_program_paper_approved';--> statement-breakpoint
ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE 'research_program_paper_rejected';--> statement-breakpoint
ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE 'research_program_paper_needs_changes';--> statement-breakpoint
ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE 'research_program_post_hidden';--> statement-breakpoint
ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE 'research_program_post_restored';--> statement-breakpoint
ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE 'research_program_report_dismissed';--> statement-breakpoint
CREATE TABLE "research_contribution_ledger_entry" (
	"id" text PRIMARY KEY NOT NULL,
	"program_id" text NOT NULL,
	"participant_id" text NOT NULL,
	"kind" "research_contribution_kind" NOT NULL,
	"amount_in_cents" bigint,
	"currency_code" text,
	"description" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "research_contribution_amount_ck" CHECK ((amount_in_cents IS NOT NULL) = (kind = 'cash_commitment')
          AND (amount_in_cents IS NULL) = (currency_code IS NULL)
          AND (amount_in_cents IS NULL OR (amount_in_cents > 0 AND currency_code ~ '^[A-Z]{3}$'))),
	CONSTRAINT "research_contribution_description_ck" CHECK (char_length(description) BETWEEN 1 AND 1000),
	CONSTRAINT "research_contribution_idempotency_ck" CHECK (char_length(idempotency_key) BETWEEN 8 AND 128)
);
--> statement-breakpoint
CREATE TABLE "research_effort_log" (
	"id" text PRIMARY KEY NOT NULL,
	"program_id" text NOT NULL,
	"participant_id" text NOT NULL,
	"branch_id" text,
	"minutes" integer NOT NULL,
	"logged_for_date" date NOT NULL,
	"note" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "research_effort_log_minutes_ck" CHECK (minutes > 0 AND minutes <= 1440),
	CONSTRAINT "research_effort_log_note_ck" CHECK (char_length(note) BETWEEN 1 AND 2000),
	CONSTRAINT "research_effort_log_idempotency_ck" CHECK (char_length(idempotency_key) BETWEEN 8 AND 128)
);
--> statement-breakpoint
CREATE TABLE "research_paper_category" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"status" "research_category_status" DEFAULT 'pending' NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "research_paper_category_text_ck" CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
          AND char_length(slug) BETWEEN 2 AND 60
          AND char_length(label) BETWEEN 2 AND 80)
);
--> statement-breakpoint
CREATE TABLE "research_program" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"tagline" text NOT NULL,
	"mission_statement" text NOT NULL,
	"status" "research_program_status" DEFAULT 'pending' NOT NULL,
	"created_by_user_id" text,
	"published_at" timestamp,
	"reviewed_by_user_id" text,
	"reviewed_at" timestamp,
	"reviewer_note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "research_program_slug_ck" CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) BETWEEN 3 AND 80),
	CONSTRAINT "research_program_text_ck" CHECK (char_length(title) BETWEEN 3 AND 120
          AND char_length(tagline) BETWEEN 3 AND 200
          AND char_length(mission_statement) BETWEEN 20 AND 4000
          AND (reviewer_note IS NULL OR char_length(reviewer_note) BETWEEN 1 AND 2000)),
	CONSTRAINT "research_program_published_ck" CHECK ((status = 'published') = (published_at IS NOT NULL)),
	CONSTRAINT "research_program_review_ck" CHECK ((reviewed_by_user_id IS NULL) = (reviewed_at IS NULL)
          AND (status = 'pending') = (reviewed_at IS NULL))
);
--> statement-breakpoint
CREATE TABLE "research_program_branch" (
	"id" text PRIMARY KEY NOT NULL,
	"program_id" text NOT NULL,
	"parent_branch_id" text,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"ancestor_path" text NOT NULL,
	"sibling_order" integer DEFAULT 0 NOT NULL,
	"status" "research_program_branch_status" DEFAULT 'emerging' NOT NULL,
	"overlapping_group_count" integer DEFAULT 0 NOT NULL,
	"pinned_left_permille" integer,
	"pinned_top_permille" integer,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "research_program_branch_no_self_parent_ck" CHECK (parent_branch_id IS DISTINCT FROM id),
	CONSTRAINT "research_program_branch_text_ck" CHECK (char_length(title) BETWEEN 3 AND 120 AND char_length(summary) BETWEEN 10 AND 2000),
	CONSTRAINT "research_program_branch_path_ck" CHECK (ancestor_path ~ '^[0-9a-z/-]+$' AND char_length(ancestor_path) BETWEEN 1 AND 800),
	CONSTRAINT "research_program_branch_counts_ck" CHECK (sibling_order >= 0 AND overlapping_group_count >= 0),
	CONSTRAINT "research_program_branch_pin_ck" CHECK ((pinned_left_permille IS NULL) = (pinned_top_permille IS NULL)
          AND (pinned_left_permille IS NULL
               OR (pinned_left_permille BETWEEN 0 AND 1000
                   AND pinned_top_permille BETWEEN 0 AND 1000)))
);
--> statement-breakpoint
CREATE TABLE "research_program_branch_claim" (
	"id" text PRIMARY KEY NOT NULL,
	"branch_id" text NOT NULL,
	"user_id" text NOT NULL,
	"claimed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_program_content_report" (
	"id" text PRIMARY KEY NOT NULL,
	"program_id" text NOT NULL,
	"target_kind" "research_program_content_target_kind" NOT NULL,
	"paper_id" text,
	"post_id" text,
	"reason" "research_program_report_reason" NOT NULL,
	"detail_text" text,
	"reporter_user_id" text,
	"status" "research_program_report_status" DEFAULT 'open' NOT NULL,
	"resolved_by_user_id" text,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "research_program_content_report_target_ck" CHECK (((target_kind = 'paper') = (paper_id IS NOT NULL))
          AND ((target_kind = 'post') = (post_id IS NOT NULL))
          AND (paper_id IS NULL) <> (post_id IS NULL)),
	CONSTRAINT "research_program_content_report_detail_ck" CHECK (detail_text IS NULL OR char_length(detail_text) BETWEEN 1 AND 2000),
	CONSTRAINT "research_program_content_report_resolution_ck" CHECK ((resolved_by_user_id IS NULL) = (resolved_at IS NULL)
          AND (status = 'open') = (resolved_at IS NULL))
);
--> statement-breakpoint
CREATE TABLE "research_program_moderation_action" (
	"id" text PRIMARY KEY NOT NULL,
	"program_id" text NOT NULL,
	"action_kind" "research_program_moderation_kind" NOT NULL,
	"paper_id" text,
	"post_id" text,
	"report_id" text,
	"moderator_user_id" text NOT NULL,
	"moderator_role_snapshot" text NOT NULL,
	"reason_note" text NOT NULL,
	"audit_entry_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "research_program_moderation_action_reason_ck" CHECK (char_length(reason_note) BETWEEN 1 AND 2000
          AND char_length(moderator_role_snapshot) BETWEEN 1 AND 40)
);
--> statement-breakpoint
CREATE TABLE "research_program_paper" (
	"id" text PRIMARY KEY NOT NULL,
	"program_id" text NOT NULL,
	"branch_id" text,
	"title" text NOT NULL,
	"category_id" text NOT NULL,
	"doi" text,
	"author_affiliation" text,
	"abstract_text" text,
	"uploader_user_id" text,
	"content_sha256" text,
	"file_byte_size" bigint,
	"object_storage_key" text,
	"storage_provider" "workshop_storage_provider",
	"moderation_status" "research_paper_moderation_status" DEFAULT 'queued' NOT NULL,
	"flag_reasons" text[] DEFAULT '{}' NOT NULL,
	"reviewed_by_user_id" text,
	"reviewed_at" timestamp,
	"reviewer_note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "research_program_paper_text_ck" CHECK (char_length(title) BETWEEN 3 AND 300
          AND (doi IS NULL OR (doi ~ '^10\.[0-9]{4,9}/[^[:space:]]+$' AND char_length(doi) <= 200))
          AND (author_affiliation IS NULL OR char_length(author_affiliation) BETWEEN 1 AND 200)
          AND (abstract_text IS NULL OR char_length(abstract_text) BETWEEN 1 AND 5000)
          AND (reviewer_note IS NULL OR char_length(reviewer_note) BETWEEN 1 AND 2000)),
	CONSTRAINT "research_program_paper_file_ck" CHECK ((content_sha256 IS NULL) = (object_storage_key IS NULL)
          AND (content_sha256 IS NULL) = (file_byte_size IS NULL)
          AND (content_sha256 IS NULL) = (storage_provider IS NULL)
          AND (content_sha256 IS NULL OR (content_sha256 ~ '^[0-9a-f]{64}$' AND file_byte_size > 0))),
	CONSTRAINT "research_program_paper_review_ck" CHECK ((reviewed_by_user_id IS NULL) = (reviewed_at IS NULL)
          AND (moderation_status = 'queued') = (reviewed_at IS NULL)),
	CONSTRAINT "research_program_paper_flags_ck" CHECK (cardinality(flag_reasons) <= 10)
);
--> statement-breakpoint
CREATE TABLE "research_program_participant" (
	"id" text PRIMARY KEY NOT NULL,
	"program_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" "research_program_participant_role" NOT NULL,
	"compensation_preference" "compensation_kind" NOT NULL,
	"contribution_summary" text,
	"funding_tranche_index" integer,
	"funding_tranche_total" integer,
	"joined_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "research_program_participant_summary_ck" CHECK (contribution_summary IS NULL OR char_length(contribution_summary) BETWEEN 1 AND 500),
	CONSTRAINT "research_program_participant_tranche_ck" CHECK ((funding_tranche_index IS NULL) = (funding_tranche_total IS NULL)
          AND (funding_tranche_index IS NULL
               OR (funding_tranche_index >= 1
                   AND funding_tranche_total >= funding_tranche_index
                   AND funding_tranche_total <= 100)))
);
--> statement-breakpoint
CREATE TABLE "research_program_post" (
	"id" text PRIMARY KEY NOT NULL,
	"program_id" text NOT NULL,
	"parent_post_id" text,
	"track" "research_program_post_track" NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"title" text,
	"body_text" text NOT NULL,
	"author_user_id" text,
	"reaction_count" integer DEFAULT 0 NOT NULL,
	"reply_count" integer DEFAULT 0 NOT NULL,
	"is_hidden" boolean DEFAULT false NOT NULL,
	"hidden_by_user_id" text,
	"hidden_at" timestamp,
	"hidden_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "research_program_post_depth_ck" CHECK (depth BETWEEN 0 AND 1 AND (depth = 0) = (parent_post_id IS NULL)),
	CONSTRAINT "research_program_post_title_ck" CHECK ((title IS NOT NULL) = (track = 'informal_paper' AND depth = 0)
          AND (title IS NULL OR char_length(title) BETWEEN 3 AND 200)),
	CONSTRAINT "research_program_post_body_ck" CHECK (char_length(body_text) BETWEEN 1 AND 10000
          AND (hidden_reason IS NULL OR char_length(hidden_reason) BETWEEN 1 AND 2000)),
	CONSTRAINT "research_program_post_counts_ck" CHECK (reaction_count >= 0 AND reply_count >= 0),
	CONSTRAINT "research_program_post_leaf_ck" CHECK (depth = 0 OR reply_count = 0),
	CONSTRAINT "research_program_post_hidden_ck" CHECK (is_hidden = (hidden_at IS NOT NULL) AND (hidden_by_user_id IS NULL) = (hidden_at IS NULL))
);
--> statement-breakpoint
CREATE TABLE "research_program_post_reaction" (
	"id" text PRIMARY KEY NOT NULL,
	"post_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_program_product_opportunity" (
	"id" text PRIMARY KEY NOT NULL,
	"program_id" text NOT NULL,
	"derived_from_branch_id" text NOT NULL,
	"product_name" text NOT NULL,
	"product_description" text NOT NULL,
	"estimated_market_size_in_cents" bigint NOT NULL,
	"readiness_min_months" integer NOT NULL,
	"readiness_max_months" integer NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "research_program_product_opportunity_text_ck" CHECK (char_length(product_name) BETWEEN 3 AND 200
          AND char_length(product_description) BETWEEN 10 AND 2000),
	CONSTRAINT "research_program_product_opportunity_numbers_ck" CHECK (estimated_market_size_in_cents >= 0
          AND readiness_min_months >= 0
          AND readiness_max_months >= readiness_min_months
          AND readiness_max_months <= 600)
);
--> statement-breakpoint
CREATE TABLE "research_program_stat_snapshot" (
	"id" text PRIMARY KEY NOT NULL,
	"program_id" text NOT NULL,
	"as_of" timestamp NOT NULL,
	"participant_count" integer NOT NULL,
	"paper_count" integer NOT NULL,
	"branch_count" integer NOT NULL,
	"post_count" integer NOT NULL,
	"open_gap_count" integer NOT NULL,
	"overlap_flag_count" integer NOT NULL,
	"total_effort_minutes" bigint NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "research_program_stat_snapshot_counts_ck" CHECK (participant_count >= 0 AND paper_count >= 0 AND branch_count >= 0
          AND post_count >= 0 AND open_gap_count >= 0 AND overlap_flag_count >= 0
          AND total_effort_minutes >= 0
          AND open_gap_count <= branch_count
          AND overlap_flag_count <= branch_count)
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "location_label" text;--> statement-breakpoint
ALTER TABLE "research_contribution_ledger_entry" ADD CONSTRAINT "research_contribution_ledger_entry_program_id_research_program_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."research_program"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_contribution_ledger_entry" ADD CONSTRAINT "research_contribution_ledger_entry_participant_id_research_program_participant_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."research_program_participant"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_effort_log" ADD CONSTRAINT "research_effort_log_program_id_research_program_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."research_program"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_effort_log" ADD CONSTRAINT "research_effort_log_participant_id_research_program_participant_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."research_program_participant"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_effort_log" ADD CONSTRAINT "research_effort_log_branch_id_research_program_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."research_program_branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_paper_category" ADD CONSTRAINT "research_paper_category_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_program" ADD CONSTRAINT "research_program_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_program" ADD CONSTRAINT "research_program_reviewed_by_user_id_user_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_program_branch" ADD CONSTRAINT "research_program_branch_program_id_research_program_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."research_program"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_program_branch" ADD CONSTRAINT "research_program_branch_parent_branch_id_research_program_branch_id_fk" FOREIGN KEY ("parent_branch_id") REFERENCES "public"."research_program_branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_program_branch" ADD CONSTRAINT "research_program_branch_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_program_branch_claim" ADD CONSTRAINT "research_program_branch_claim_branch_id_research_program_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."research_program_branch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_program_branch_claim" ADD CONSTRAINT "research_program_branch_claim_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_program_content_report" ADD CONSTRAINT "research_program_content_report_program_id_research_program_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."research_program"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_program_content_report" ADD CONSTRAINT "research_program_content_report_paper_id_research_program_paper_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."research_program_paper"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_program_content_report" ADD CONSTRAINT "research_program_content_report_post_id_research_program_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."research_program_post"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_program_content_report" ADD CONSTRAINT "research_program_content_report_reporter_user_id_user_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_program_content_report" ADD CONSTRAINT "research_program_content_report_resolved_by_user_id_user_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_program_moderation_action" ADD CONSTRAINT "research_program_moderation_action_program_id_research_program_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."research_program"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_program_moderation_action" ADD CONSTRAINT "research_program_moderation_action_paper_id_research_program_paper_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."research_program_paper"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_program_moderation_action" ADD CONSTRAINT "research_program_moderation_action_post_id_research_program_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."research_program_post"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_program_moderation_action" ADD CONSTRAINT "research_program_moderation_action_report_id_research_program_content_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."research_program_content_report"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_program_moderation_action" ADD CONSTRAINT "research_program_moderation_action_moderator_user_id_user_id_fk" FOREIGN KEY ("moderator_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_program_moderation_action" ADD CONSTRAINT "research_program_moderation_action_audit_entry_id_platform_audit_entry_id_fk" FOREIGN KEY ("audit_entry_id") REFERENCES "public"."platform_audit_entry"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_program_paper" ADD CONSTRAINT "research_program_paper_program_id_research_program_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."research_program"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_program_paper" ADD CONSTRAINT "research_program_paper_branch_id_research_program_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."research_program_branch"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_program_paper" ADD CONSTRAINT "research_program_paper_category_id_research_paper_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."research_paper_category"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_program_paper" ADD CONSTRAINT "research_program_paper_uploader_user_id_user_id_fk" FOREIGN KEY ("uploader_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_program_paper" ADD CONSTRAINT "research_program_paper_reviewed_by_user_id_user_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_program_participant" ADD CONSTRAINT "research_program_participant_program_id_research_program_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."research_program"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_program_participant" ADD CONSTRAINT "research_program_participant_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_program_post" ADD CONSTRAINT "research_program_post_program_id_research_program_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."research_program"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_program_post" ADD CONSTRAINT "research_program_post_parent_post_id_research_program_post_id_fk" FOREIGN KEY ("parent_post_id") REFERENCES "public"."research_program_post"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_program_post" ADD CONSTRAINT "research_program_post_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_program_post" ADD CONSTRAINT "research_program_post_hidden_by_user_id_user_id_fk" FOREIGN KEY ("hidden_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_program_post_reaction" ADD CONSTRAINT "research_program_post_reaction_post_id_research_program_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."research_program_post"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_program_post_reaction" ADD CONSTRAINT "research_program_post_reaction_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_program_product_opportunity" ADD CONSTRAINT "research_program_product_opportunity_program_id_research_program_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."research_program"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_program_product_opportunity" ADD CONSTRAINT "research_program_product_opportunity_derived_from_branch_id_research_program_branch_id_fk" FOREIGN KEY ("derived_from_branch_id") REFERENCES "public"."research_program_branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_program_product_opportunity" ADD CONSTRAINT "research_program_product_opportunity_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_program_stat_snapshot" ADD CONSTRAINT "research_program_stat_snapshot_program_id_research_program_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."research_program"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "research_contribution_idempotency_unq" ON "research_contribution_ledger_entry" USING btree ("participant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "research_contribution_programId_idx" ON "research_contribution_ledger_entry" USING btree ("program_id","created_at","id");--> statement-breakpoint
CREATE INDEX "research_contribution_participantId_idx" ON "research_contribution_ledger_entry" USING btree ("participant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "research_effort_log_idempotency_unq" ON "research_effort_log" USING btree ("participant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "research_effort_log_programId_idx" ON "research_effort_log" USING btree ("program_id","logged_for_date","id");--> statement-breakpoint
CREATE INDEX "research_effort_log_participantId_idx" ON "research_effort_log" USING btree ("participant_id","logged_for_date");--> statement-breakpoint
CREATE INDEX "research_effort_log_branchId_idx" ON "research_effort_log" USING btree ("branch_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "research_paper_category_slug_unq" ON "research_paper_category" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "research_paper_category_status_idx" ON "research_paper_category" USING btree ("status","label","id");--> statement-breakpoint
CREATE UNIQUE INDEX "research_program_slug_unq" ON "research_program" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "research_program_status_createdAt_idx" ON "research_program" USING btree ("status","created_at","id");--> statement-breakpoint
CREATE INDEX "research_program_createdByUserId_idx" ON "research_program" USING btree ("created_by_user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "research_program_branch_path_unq" ON "research_program_branch" USING btree ("program_id","ancestor_path");--> statement-breakpoint
CREATE INDEX "research_program_branch_parent_idx" ON "research_program_branch" USING btree ("program_id","parent_branch_id","sibling_order","id");--> statement-breakpoint
CREATE INDEX "research_program_branch_status_idx" ON "research_program_branch" USING btree ("program_id","status","id");--> statement-breakpoint
CREATE UNIQUE INDEX "research_program_branch_claim_unq" ON "research_program_branch_claim" USING btree ("branch_id","user_id");--> statement-breakpoint
CREATE INDEX "research_program_branch_claim_userId_idx" ON "research_program_branch_claim" USING btree ("user_id","claimed_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "research_program_content_report_post_unq" ON "research_program_content_report" USING btree ("post_id","reporter_user_id") WHERE post_id IS NOT NULL AND reporter_user_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "research_program_content_report_paper_unq" ON "research_program_content_report" USING btree ("paper_id","reporter_user_id") WHERE paper_id IS NOT NULL AND reporter_user_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "research_program_content_report_queue_idx" ON "research_program_content_report" USING btree ("program_id","status","created_at","id");--> statement-breakpoint
CREATE INDEX "research_program_moderation_action_programId_idx" ON "research_program_moderation_action" USING btree ("program_id","created_at","id");--> statement-breakpoint
CREATE INDEX "research_program_moderation_action_moderatorUserId_idx" ON "research_program_moderation_action" USING btree ("moderator_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "research_program_moderation_action_auditEntryId_unq" ON "research_program_moderation_action" USING btree ("audit_entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "research_program_paper_doi_unq" ON "research_program_paper" USING btree ("program_id","doi") WHERE doi IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "research_program_paper_content_unq" ON "research_program_paper" USING btree ("program_id","content_sha256") WHERE content_sha256 IS NOT NULL;--> statement-breakpoint
CREATE INDEX "research_program_paper_listing_idx" ON "research_program_paper" USING btree ("program_id","moderation_status","created_at","id");--> statement-breakpoint
CREATE INDEX "research_program_paper_categoryId_idx" ON "research_program_paper" USING btree ("category_id","id");--> statement-breakpoint
CREATE INDEX "research_program_paper_branchId_idx" ON "research_program_paper" USING btree ("branch_id","id");--> statement-breakpoint
CREATE INDEX "research_program_paper_uploaderUserId_idx" ON "research_program_paper" USING btree ("uploader_user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "research_program_participant_unq" ON "research_program_participant" USING btree ("program_id","user_id");--> statement-breakpoint
CREATE INDEX "research_program_participant_role_idx" ON "research_program_participant" USING btree ("program_id","role","id");--> statement-breakpoint
CREATE INDEX "research_program_participant_userId_idx" ON "research_program_participant" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "research_program_post_feed_idx" ON "research_program_post" USING btree ("program_id","track","created_at","id");--> statement-breakpoint
CREATE INDEX "research_program_post_parent_idx" ON "research_program_post" USING btree ("parent_post_id","created_at","id");--> statement-breakpoint
CREATE INDEX "research_program_post_authorUserId_idx" ON "research_program_post" USING btree ("author_user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "research_program_post_reaction_unq" ON "research_program_post_reaction" USING btree ("post_id","user_id");--> statement-breakpoint
CREATE INDEX "research_program_post_reaction_userId_idx" ON "research_program_post_reaction" USING btree ("user_id","post_id");--> statement-breakpoint
CREATE INDEX "research_program_product_opportunity_programId_idx" ON "research_program_product_opportunity" USING btree ("program_id","estimated_market_size_in_cents","id");--> statement-breakpoint
CREATE INDEX "research_program_product_opportunity_branchId_idx" ON "research_program_product_opportunity" USING btree ("derived_from_branch_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "research_program_stat_snapshot_asOf_unq" ON "research_program_stat_snapshot" USING btree ("program_id","as_of");--> statement-breakpoint
CREATE INDEX "research_program_stat_snapshot_latest_idx" ON "research_program_stat_snapshot" USING btree ("program_id","as_of","id");
-- ---------------------------------------------------------------------------
-- HAND-WRITTEN TAIL — §10 research programs.
--
-- drizzle-kit diffs only the objects it declared, so anything added below is
-- invisible to it and survives every later `pnpm db:generate` — the same
-- arrangement migrations 0008, 0010 and 0013 use. Do not move these into
-- schema.ts.
-- ---------------------------------------------------------------------------

-- 1. Branch-tree path ordering must not follow the database's LC_COLLATE.
--
-- Identical reasoning to workshop_task.rank in migration 0013: `ORDER BY
-- ancestor_path` under ICU en_US.UTF-8 reorders case and punctuation, while a
-- JS, Kotlin or Swift `a < b` compares code points. They disagree, and a
-- subtree prefix match or a sibling ordering computed on the client would
-- silently disagree with the server's — with no error anywhere.
--
-- COLLATE "C" is byte order, which is exactly what the clients do. The
-- research_program_branch_path_ck CHECK keeps the alphabet inside [0-9a-z/-],
-- where the two orderings are provably identical even if this line were lost.
ALTER TABLE "research_program_branch" ALTER COLUMN "ancestor_path" TYPE text COLLATE "C";--> statement-breakpoint

-- 2. APPEND-ONLY ENFORCEMENT (§4f), attaching to the SAME
-- qatoto_reject_mutation() function migration 0010 introduced.
--
-- Three §10 tables are records of the past, and a record that can be edited is
-- not a record:
--
--   research_program_moderation_action     who decided what, and under which
--                                         role. It is the queryable half of a
--                                         platform_audit_entry, which is
--                                         itself append-only — an editable
--                                         mirror of a tamper-evident row is a
--                                         way to make the mirror lie.
--   research_effort_log                    logged time. Corrections are a new
--                                          log, never an edit, for the same
--                                          reason §9 reverses slices instead
--                                          of adjusting them.
--   research_contribution_ledger_entry     committed cash and materials.
--
-- Deliberately NOT append-only: research_program_branch, _paper, _post,
-- _participant and _content_report all have legitimate lifecycles (a summary
-- is edited, a paper is reviewed, a post is hidden and restored, a report is
-- resolved). Their state machines live in CHECKs above, not here.
DROP TRIGGER IF EXISTS research_program_moderation_action_append_only ON "research_program_moderation_action";--> statement-breakpoint
CREATE TRIGGER research_program_moderation_action_append_only
BEFORE UPDATE OR DELETE ON "research_program_moderation_action"
FOR EACH ROW EXECUTE FUNCTION qatoto_reject_mutation();--> statement-breakpoint
-- A BEFORE UPDATE OR DELETE *row* trigger does NOT fire on TRUNCATE.
DROP TRIGGER IF EXISTS research_program_moderation_action_no_truncate ON "research_program_moderation_action";--> statement-breakpoint
CREATE TRIGGER research_program_moderation_action_no_truncate
BEFORE TRUNCATE ON "research_program_moderation_action"
FOR EACH STATEMENT EXECUTE FUNCTION qatoto_reject_mutation();--> statement-breakpoint
DROP TRIGGER IF EXISTS research_effort_log_append_only ON "research_effort_log";--> statement-breakpoint
CREATE TRIGGER research_effort_log_append_only
BEFORE UPDATE OR DELETE ON "research_effort_log"
FOR EACH ROW EXECUTE FUNCTION qatoto_reject_mutation();--> statement-breakpoint
DROP TRIGGER IF EXISTS research_effort_log_no_truncate ON "research_effort_log";--> statement-breakpoint
CREATE TRIGGER research_effort_log_no_truncate
BEFORE TRUNCATE ON "research_effort_log"
FOR EACH STATEMENT EXECUTE FUNCTION qatoto_reject_mutation();--> statement-breakpoint
DROP TRIGGER IF EXISTS research_contribution_ledger_entry_append_only ON "research_contribution_ledger_entry";--> statement-breakpoint
CREATE TRIGGER research_contribution_ledger_entry_append_only
BEFORE UPDATE OR DELETE ON "research_contribution_ledger_entry"
FOR EACH ROW EXECUTE FUNCTION qatoto_reject_mutation();--> statement-breakpoint
DROP TRIGGER IF EXISTS research_contribution_ledger_entry_no_truncate ON "research_contribution_ledger_entry";--> statement-breakpoint
CREATE TRIGGER research_contribution_ledger_entry_no_truncate
BEFORE TRUNCATE ON "research_contribution_ledger_entry"
FOR EACH STATEMENT EXECUTE FUNCTION qatoto_reject_mutation();
