CREATE TYPE "public"."ai_summary_chip_kind" AS ENUM('blocker', 'progress', 'velocity', 'suggestion');--> statement-breakpoint
CREATE TYPE "public"."daily_log_analysis_status" AS ENUM('not_requested', 'queued', 'running', 'succeeded', 'failed', 'skipped_unconfigured');--> statement-breakpoint
CREATE TYPE "public"."daily_log_status" AS ENUM('draft', 'submitted');--> statement-breakpoint
CREATE TYPE "public"."daily_log_video_source" AS ENUM('none', 'youtube', 'hosted');--> statement-breakpoint
CREATE TYPE "public"."evidence_link_provider" AS ENUM('github', 'gitlab', 'figma', 'google_docs', 'notion', 'other');--> statement-breakpoint
CREATE TYPE "public"."evidence_link_source_kind" AS ENUM('member_supplied', 'ai_extracted');--> statement-breakpoint
CREATE TYPE "public"."extracted_claim_kind" AS ENUM('time_spent', 'cash_spent', 'artifact_reference', 'blocker', 'milestone_progress');--> statement-breakpoint
CREATE TYPE "public"."workshop_file_kind" AS ENUM('document', 'spreadsheet', 'cad_model', 'image', 'video', 'archive', 'other');--> statement-breakpoint
CREATE TYPE "public"."workshop_file_source" AS ENUM('external_link', 'hosted');--> statement-breakpoint
CREATE TYPE "public"."workshop_storage_provider" AS ENUM('s3_compatible', 'cloudinary');--> statement-breakpoint
CREATE TYPE "public"."workshop_task_priority" AS ENUM('high', 'medium', 'low');--> statement-breakpoint
CREATE TABLE "daily_log" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"author_member_id" text NOT NULL,
	"log_date" date NOT NULL,
	"narrative" text,
	"status" "daily_log_status" DEFAULT 'draft' NOT NULL,
	"submitted_at" timestamp,
	"video_source" "daily_log_video_source" DEFAULT 'none' NOT NULL,
	"youtube_video_id" text,
	"youtube_thumbnail_url" text,
	"video_verified_at" timestamp,
	"analysis_status" "daily_log_analysis_status" DEFAULT 'not_requested' NOT NULL,
	"analysis_model_name" text,
	"analysis_model_version" text,
	"analysis_prompt_version" text,
	"analysis_completed_at" timestamp,
	"analysis_failure_reason" text,
	"effort_verification_status" "effort_verification_status" DEFAULT 'not_run' NOT NULL,
	"submit_idempotency_key" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "daily_log_narrative_ck" CHECK (narrative IS NULL OR char_length(narrative) <= 10000),
	CONSTRAINT "daily_log_video_ck" CHECK ((video_source = 'youtube') = (youtube_video_id IS NOT NULL)),
	CONSTRAINT "daily_log_submitted_ck" CHECK ((status = 'submitted') = (submitted_at IS NOT NULL)),
	CONSTRAINT "daily_log_analysis_ck" CHECK ((analysis_status = 'not_requested' OR status = 'submitted')
          AND (analysis_completed_at IS NULL
               OR analysis_status IN ('succeeded', 'failed', 'skipped_unconfigured')))
);
--> statement-breakpoint
CREATE TABLE "daily_log_ai_summary_chip" (
	"id" text PRIMARY KEY NOT NULL,
	"daily_log_id" text NOT NULL,
	"sequence_number" integer NOT NULL,
	"kind" "ai_summary_chip_kind" NOT NULL,
	"label" text NOT NULL,
	"confidence_bps" integer,
	"generated_by_model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "daily_log_ai_summary_chip_label_ck" CHECK (char_length(label) BETWEEN 1 AND 80),
	CONSTRAINT "daily_log_ai_summary_chip_confidence_ck" CHECK (confidence_bps IS NULL OR confidence_bps BETWEEN 0 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "daily_log_evidence_link" (
	"id" text PRIMARY KEY NOT NULL,
	"daily_log_id" text NOT NULL,
	"provider" "evidence_link_provider" DEFAULT 'other' NOT NULL,
	"source_kind" "evidence_link_source_kind" NOT NULL,
	"external_url" text NOT NULL,
	"external_host" text NOT NULL,
	"external_id" text,
	"generated_by_model" text,
	"prompt_version" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "daily_log_evidence_link_url_ck" CHECK (char_length(external_url) <= 2048 AND external_url LIKE 'https://%'),
	CONSTRAINT "daily_log_evidence_link_provenance_ck" CHECK ((source_kind = 'ai_extracted')
          = (generated_by_model IS NOT NULL AND prompt_version IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "daily_log_extracted_claim" (
	"id" text PRIMARY KEY NOT NULL,
	"daily_log_id" text NOT NULL,
	"sequence_number" integer NOT NULL,
	"claim_kind" "extracted_claim_kind" NOT NULL,
	"extracted_minutes" integer,
	"extracted_cash_in_cents" bigint,
	"claim_summary" text NOT NULL,
	"confidence_bps" integer,
	"generated_by_model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "daily_log_extracted_claim_summary_ck" CHECK (char_length(claim_summary) BETWEEN 1 AND 1000),
	CONSTRAINT "daily_log_extracted_claim_minutes_ck" CHECK (extracted_minutes IS NULL OR extracted_minutes BETWEEN 0 AND 1440),
	CONSTRAINT "daily_log_extracted_claim_cash_ck" CHECK (extracted_cash_in_cents IS NULL OR extracted_cash_in_cents >= 0),
	CONSTRAINT "daily_log_extracted_claim_confidence_ck" CHECK (confidence_bps IS NULL OR confidence_bps BETWEEN 0 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "daily_log_transcript_segment" (
	"id" text PRIMARY KEY NOT NULL,
	"daily_log_id" text NOT NULL,
	"sequence_number" integer NOT NULL,
	"start_offset_seconds" integer NOT NULL,
	"end_offset_seconds" integer,
	"speaker_label" text,
	"segment_text" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "daily_log_transcript_segment_seq_ck" CHECK (sequence_number >= 0),
	CONSTRAINT "daily_log_transcript_segment_offsets_ck" CHECK (start_offset_seconds >= 0
          AND (end_offset_seconds IS NULL OR end_offset_seconds >= start_offset_seconds)),
	CONSTRAINT "daily_log_transcript_segment_text_ck" CHECK (char_length(segment_text) BETWEEN 1 AND 5000)
);
--> statement-breakpoint
CREATE TABLE "workshop_board_column" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"title" text NOT NULL,
	"position" integer NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "workshop_board_column_title_ck" CHECK (char_length(title) BETWEEN 1 AND 60),
	CONSTRAINT "workshop_board_column_position_ck" CHECK (position >= 0)
);
--> statement-breakpoint
CREATE TABLE "workshop_chat_message" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"author_member_id" text NOT NULL,
	"message_text" text NOT NULL,
	"sent_at" timestamp (6) DEFAULT now() NOT NULL,
	"edited_at" timestamp (6),
	"deleted_at" timestamp (6),
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "workshop_chat_message_text_ck" CHECK (char_length(message_text) BETWEEN 1 AND 4000),
	CONSTRAINT "workshop_chat_message_edited_ck" CHECK (edited_at IS NULL OR edited_at >= sent_at)
);
--> statement-breakpoint
CREATE TABLE "workshop_chat_read_state" (
	"project_id" text NOT NULL,
	"member_id" text NOT NULL,
	"through_message_id" text,
	"read_at" timestamp (6) DEFAULT now() NOT NULL,
	CONSTRAINT "workshop_chat_read_state_project_id_member_id_pk" PRIMARY KEY("project_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "workshop_file" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"file_name" text NOT NULL,
	"file_kind" "workshop_file_kind" DEFAULT 'other' NOT NULL,
	"source" "workshop_file_source" DEFAULT 'external_link' NOT NULL,
	"external_url" text,
	"external_host" text,
	"size_bytes" integer,
	"content_sha256" text,
	"storage_provider" "workshop_storage_provider",
	"object_key" text,
	"uploaded_by_member_id" text NOT NULL,
	"removed_at" timestamp,
	"removed_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "workshop_file_fileName_ck" CHECK (char_length(file_name) BETWEEN 1 AND 200),
	CONSTRAINT "workshop_file_source_shape_ck" CHECK ((source = 'external_link'
             AND external_url IS NOT NULL AND external_host IS NOT NULL
             AND size_bytes IS NULL AND object_key IS NULL)
          OR (source = 'hosted' AND object_key IS NOT NULL)),
	CONSTRAINT "workshop_file_externalUrl_ck" CHECK (external_url IS NULL
          OR (char_length(external_url) <= 2048 AND external_url LIKE 'https://%')),
	CONSTRAINT "workshop_file_sizeBytes_ck" CHECK (size_bytes IS NULL OR size_bytes >= 0),
	CONSTRAINT "workshop_file_removed_ck" CHECK ((removed_by_user_id IS NULL) OR (removed_at IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "workshop_task" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"column_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"assignee_member_id" text,
	"priority" "workshop_task_priority" DEFAULT 'medium' NOT NULL,
	"labels" text[] DEFAULT '{}' NOT NULL,
	"due_date" date,
	"rank" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "workshop_task_title_ck" CHECK (char_length(title) BETWEEN 1 AND 200),
	CONSTRAINT "workshop_task_description_ck" CHECK (description IS NULL OR char_length(description) <= 5000),
	CONSTRAINT "workshop_task_labels_ck" CHECK (cardinality(labels) <= 8),
	CONSTRAINT "workshop_task_rank_ck" CHECK (rank ~ '^[0-9a-z]+$')
);
--> statement-breakpoint
ALTER TABLE "daily_log" ADD CONSTRAINT "daily_log_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_log" ADD CONSTRAINT "daily_log_author_member_id_project_member_id_fk" FOREIGN KEY ("author_member_id") REFERENCES "public"."project_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_log_ai_summary_chip" ADD CONSTRAINT "daily_log_ai_summary_chip_daily_log_id_daily_log_id_fk" FOREIGN KEY ("daily_log_id") REFERENCES "public"."daily_log"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_log_evidence_link" ADD CONSTRAINT "daily_log_evidence_link_daily_log_id_daily_log_id_fk" FOREIGN KEY ("daily_log_id") REFERENCES "public"."daily_log"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_log_extracted_claim" ADD CONSTRAINT "daily_log_extracted_claim_daily_log_id_daily_log_id_fk" FOREIGN KEY ("daily_log_id") REFERENCES "public"."daily_log"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_log_transcript_segment" ADD CONSTRAINT "daily_log_transcript_segment_daily_log_id_daily_log_id_fk" FOREIGN KEY ("daily_log_id") REFERENCES "public"."daily_log"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_board_column" ADD CONSTRAINT "workshop_board_column_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_board_column" ADD CONSTRAINT "workshop_board_column_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_chat_message" ADD CONSTRAINT "workshop_chat_message_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_chat_message" ADD CONSTRAINT "workshop_chat_message_author_member_id_project_member_id_fk" FOREIGN KEY ("author_member_id") REFERENCES "public"."project_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_chat_read_state" ADD CONSTRAINT "workshop_chat_read_state_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_chat_read_state" ADD CONSTRAINT "workshop_chat_read_state_member_id_project_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."project_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_chat_read_state" ADD CONSTRAINT "workshop_chat_read_state_through_message_id_workshop_chat_message_id_fk" FOREIGN KEY ("through_message_id") REFERENCES "public"."workshop_chat_message"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_file" ADD CONSTRAINT "workshop_file_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_file" ADD CONSTRAINT "workshop_file_uploaded_by_member_id_project_member_id_fk" FOREIGN KEY ("uploaded_by_member_id") REFERENCES "public"."project_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_file" ADD CONSTRAINT "workshop_file_removed_by_user_id_user_id_fk" FOREIGN KEY ("removed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_task" ADD CONSTRAINT "workshop_task_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_task" ADD CONSTRAINT "workshop_task_column_id_workshop_board_column_id_fk" FOREIGN KEY ("column_id") REFERENCES "public"."workshop_board_column"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_task" ADD CONSTRAINT "workshop_task_assignee_member_id_project_member_id_fk" FOREIGN KEY ("assignee_member_id") REFERENCES "public"."project_member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_task" ADD CONSTRAINT "workshop_task_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "daily_log_projectId_authorMemberId_logDate_unq" ON "daily_log" USING btree ("project_id","author_member_id","log_date");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_log_authorMemberId_idempotencyKey_unq" ON "daily_log" USING btree ("author_member_id","submit_idempotency_key") WHERE submit_idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "daily_log_projectId_logDate_idx" ON "daily_log" USING btree ("project_id","log_date","id");--> statement-breakpoint
CREATE INDEX "daily_log_analysisStatus_idx" ON "daily_log" USING btree ("analysis_status","id") WHERE status = 'submitted';--> statement-breakpoint
CREATE UNIQUE INDEX "daily_log_ai_summary_chip_logId_seq_unq" ON "daily_log_ai_summary_chip" USING btree ("daily_log_id","sequence_number");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_log_evidence_link_logId_url_unq" ON "daily_log_evidence_link" USING btree ("daily_log_id","external_url");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_log_extracted_claim_logId_seq_unq" ON "daily_log_extracted_claim" USING btree ("daily_log_id","sequence_number");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_log_transcript_segment_logId_seq_unq" ON "daily_log_transcript_segment" USING btree ("daily_log_id","sequence_number");--> statement-breakpoint
CREATE INDEX "workshop_board_column_projectId_position_idx" ON "workshop_board_column" USING btree ("project_id","position","id");--> statement-breakpoint
CREATE INDEX "workshop_chat_message_projectId_sentAt_idx" ON "workshop_chat_message" USING btree ("project_id","sent_at","id");--> statement-breakpoint
CREATE INDEX "workshop_file_projectId_createdAt_idx" ON "workshop_file" USING btree ("project_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "workshop_file_projectId_externalUrl_unq" ON "workshop_file" USING btree ("project_id","external_url") WHERE removed_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "workshop_task_columnId_rank_unq" ON "workshop_task" USING btree ("column_id","rank");--> statement-breakpoint
CREATE INDEX "workshop_task_projectId_idx" ON "workshop_task" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "workshop_task_assigneeMemberId_idx" ON "workshop_task" USING btree ("assignee_member_id");--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- HAND-WRITTEN. Drizzle cannot express either of these, and both are load-bearing.
-- See docs/R_AND_D_BACKEND_STRUCTURE.md §8 and the §8 header in src/db/schema.ts.
--
-- drizzle-kit diffs only the objects it declared, so anything added here is invisible
-- to it and survives every later `pnpm db:generate` — the same arrangement migration
-- 0008 uses for the citext extension. Do not move these into schema.ts.
-- ---------------------------------------------------------------------------

-- 1. Kanban rank ordering must not follow the database's LC_COLLATE.
--
-- `ORDER BY rank` under ICU en_US.UTF-8 reorders case and punctuation, while a JS,
-- Kotlin or Swift `a < b` compares code points. They disagree, and the board renders
-- in a different order than the server paginates — silently, with no error anywhere.
-- COLLATE "C" is byte order, which is exactly what the clients do.
--
-- The workshop_task_rank_ck CHECK keeps the alphabet inside [0-9a-z], where the two
-- orderings are provably identical even if this line were ever lost.
ALTER TABLE "workshop_task" ALTER COLUMN "rank" TYPE text COLLATE "C";--> statement-breakpoint

-- 2. One column per position per project — checked at COMMIT, not per statement.
--
-- Reordering a board rewrites several rows, and any order of those UPDATEs passes
-- through a state where two columns share a position. An IMMEDIATE unique constraint
-- rejects that mid-transaction, so the only ways to satisfy it would be a temporary
-- negative-position shuffle (two extra writes and a window where a concurrent read sees
-- nonsense) or dropping the guarantee entirely. DEFERRABLE keeps the invariant and
-- makes the reorder one UPDATE ... FROM (VALUES ...).
--
-- Deliberately a CONSTRAINT rather than a unique INDEX: only constraints can be
-- deferred.
ALTER TABLE "workshop_board_column"
  ADD CONSTRAINT "workshop_board_column_projectId_position_unq"
  UNIQUE ("project_id", "position") DEFERRABLE INITIALLY DEFERRED;
