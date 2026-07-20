CREATE TYPE "public"."compensation_earned_as_policy" AS ENUM('milestone_escrow_release', 'on_completion_escrow_release', 'slicing_pie_vesting');--> statement-breakpoint
CREATE TYPE "public"."compensation_kind" AS ENUM('salary', 'one_time', 'equity');--> statement-breakpoint
CREATE TYPE "public"."effort_verification_status" AS ENUM('not_run', 'queued', 'running', 'verified', 'flagged_for_review', 'unverified');--> statement-breakpoint
CREATE TYPE "public"."member_interval_end_reason" AS ENUM('left', 'removed');--> statement-breakpoint
CREATE TYPE "public"."open_role_status" AS ENUM('open', 'closed', 'filled');--> statement-breakpoint
CREATE TYPE "public"."platform_role" AS ENUM('moderator', 'auditor', 'admin');--> statement-breakpoint
CREATE TYPE "public"."project_application_kind" AS ENUM('role_interest', 'join_request');--> statement-breakpoint
CREATE TYPE "public"."project_application_status" AS ENUM('pending', 'accepted', 'declined', 'withdrawn', 'expired');--> statement-breakpoint
CREATE TYPE "public"."project_invite_status" AS ENUM('pending', 'accepted', 'declined', 'revoked', 'expired');--> statement-breakpoint
CREATE TYPE "public"."project_member_role" AS ENUM('founder', 'admin', 'maintainer', 'contributor');--> statement-breakpoint
CREATE TYPE "public"."project_member_status" AS ENUM('active', 'left', 'removed');--> statement-breakpoint
CREATE TYPE "public"."project_stage" AS ENUM('market_research', 'problem_validation', 'team_building', 'building_mvp', 'raising_funding', 'go_to_market');--> statement-breakpoint
CREATE TYPE "public"."research_category_status" AS ENUM('approved', 'pending', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."research_project_status" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."role_commitment" AS ENUM('full_time', 'part_time', 'hobby');--> statement-breakpoint
CREATE TABLE "open_role_compensation" (
	"id" text PRIMARY KEY NOT NULL,
	"open_role_id" text NOT NULL,
	"kind" "compensation_kind" NOT NULL,
	"salary_min_in_cents_per_month" bigint,
	"salary_max_in_cents_per_month" bigint,
	"one_time_min_in_cents" bigint,
	"one_time_max_in_cents" bigint,
	"equity_basis_points_min" integer,
	"equity_basis_points_max" integer,
	"earned_as_policy" "compensation_earned_as_policy" NOT NULL,
	"earned_as_note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "open_role_compensation_kind_columns_ck" CHECK (
      (kind = 'salary' AND salary_min_in_cents_per_month IS NOT NULL
                       AND one_time_min_in_cents IS NULL AND one_time_max_in_cents IS NULL
                       AND equity_basis_points_min IS NULL AND equity_basis_points_max IS NULL)
      OR (kind = 'one_time' AND one_time_min_in_cents IS NOT NULL
                       AND salary_min_in_cents_per_month IS NULL AND salary_max_in_cents_per_month IS NULL
                       AND equity_basis_points_min IS NULL AND equity_basis_points_max IS NULL)
      OR (kind = 'equity' AND equity_basis_points_min IS NOT NULL
                       AND salary_min_in_cents_per_month IS NULL AND salary_max_in_cents_per_month IS NULL
                       AND one_time_min_in_cents IS NULL AND one_time_max_in_cents IS NULL)),
	CONSTRAINT "open_role_compensation_policy_pairing_ck" CHECK (
      (kind = 'equity' AND earned_as_policy = 'slicing_pie_vesting')
      OR (kind IN ('salary','one_time')
          AND earned_as_policy IN ('milestone_escrow_release','on_completion_escrow_release'))),
	CONSTRAINT "open_role_compensation_ranges_ck" CHECK (
      (salary_min_in_cents_per_month IS NULL OR salary_min_in_cents_per_month >= 0)
      AND (salary_max_in_cents_per_month IS NULL OR salary_max_in_cents_per_month >= salary_min_in_cents_per_month)
      AND (one_time_min_in_cents IS NULL OR one_time_min_in_cents >= 0)
      AND (one_time_max_in_cents IS NULL OR one_time_max_in_cents >= one_time_min_in_cents)
      AND (equity_basis_points_min IS NULL OR equity_basis_points_min BETWEEN 0 AND 10000)
      AND (equity_basis_points_max IS NULL OR (equity_basis_points_max >= equity_basis_points_min
                                               AND equity_basis_points_max <= 10000)))
);
--> statement-breakpoint
CREATE TABLE "project_application" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"open_role_id" text,
	"applicant_user_id" text NOT NULL,
	"kind" "project_application_kind" NOT NULL,
	"status" "project_application_status" DEFAULT 'pending' NOT NULL,
	"short_pitch" text NOT NULL,
	"selected_skills" text[] DEFAULT '{}' NOT NULL,
	"stated_commitment" "role_commitment" NOT NULL,
	"role_title_snapshot" text,
	"expected_compensation_note" text,
	"review_note" text,
	"reviewed_by_user_id" text,
	"decided_at" timestamp,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "project_application_kind_role_ck" CHECK (
      (kind = 'role_interest' AND open_role_id IS NOT NULL)
      OR (kind = 'join_request' AND open_role_id IS NULL)),
	CONSTRAINT "project_application_decided_at_ck" CHECK ((status IN ('pending','expired')) = (decided_at IS NULL)),
	CONSTRAINT "project_application_selected_skills_ck" CHECK (cardinality(selected_skills) <= 30)
);
--> statement-breakpoint
CREATE TABLE "project_invite" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"open_role_id" text,
	"invitee_user_id" text NOT NULL,
	"invited_by_user_id" text NOT NULL,
	"status" "project_invite_status" DEFAULT 'pending' NOT NULL,
	"role_title" text,
	"message" text,
	"responded_at" timestamp,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "project_invite_no_self_ck" CHECK (invitee_user_id <> invited_by_user_id),
	CONSTRAINT "project_invite_responded_at_ck" CHECK ((status IN ('pending','expired')) = (responded_at IS NULL))
);
--> statement-breakpoint
CREATE TABLE "project_member" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"project_role" "project_member_role" DEFAULT 'contributor' NOT NULL,
	"role_title" text,
	"skills" text[] DEFAULT '{}' NOT NULL,
	"status" "project_member_status" DEFAULT 'active' NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL,
	"left_at" timestamp,
	"source_application_id" text,
	"source_invite_id" text,
	"removed_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "project_member_left_at_ck" CHECK ((status = 'active') = (left_at IS NULL)),
	CONSTRAINT "project_member_removed_by_ck" CHECK ((removed_by_user_id IS NULL) OR (status = 'removed')),
	CONSTRAINT "project_member_left_after_joined_ck" CHECK (left_at IS NULL OR left_at >= joined_at),
	CONSTRAINT "project_member_skills_ck" CHECK (cardinality(skills) <= 30)
);
--> statement-breakpoint
CREATE TABLE "project_member_interval" (
	"id" text PRIMARY KEY NOT NULL,
	"member_id" text NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL,
	"left_at" timestamp,
	"ended_reason" "member_interval_end_reason",
	"ended_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "project_member_interval_order_ck" CHECK (left_at IS NULL OR left_at > joined_at),
	CONSTRAINT "project_member_interval_ended_ck" CHECK ((left_at IS NULL) = (ended_reason IS NULL)
          AND (ended_by_user_id IS NULL OR ended_reason = 'removed'))
);
--> statement-breakpoint
CREATE TABLE "project_open_role" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"role_title" text NOT NULL,
	"skills" text[] DEFAULT '{}' NOT NULL,
	"commitment" "role_commitment" NOT NULL,
	"status" "open_role_status" DEFAULT 'open' NOT NULL,
	"slots_total" integer DEFAULT 1 NOT NULL,
	"slots_filled_count" integer DEFAULT 0 NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "project_open_role_slots_ck" CHECK (slots_total BETWEEN 1 AND 50 AND slots_filled_count BETWEEN 0 AND slots_total),
	CONSTRAINT "project_open_role_open_not_full_ck" CHECK (NOT (status = 'open' AND slots_filled_count >= slots_total)),
	CONSTRAINT "project_open_role_skills_ck" CHECK (cardinality(skills) <= 30)
);
--> statement-breakpoint
CREATE TABLE "project_stage_transition" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"from_stage" "project_stage",
	"to_stage" "project_stage" NOT NULL,
	"changed_by_user_id" text NOT NULL,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "project_stage_transition_distinct_ck" CHECK (from_stage IS DISTINCT FROM to_stage)
);
--> statement-breakpoint
CREATE TABLE "project_stats" (
	"project_id" text PRIMARY KEY NOT NULL,
	"watchers_count" integer DEFAULT 0 NOT NULL,
	"team_member_count" integer DEFAULT 1 NOT NULL,
	"open_role_count" integer DEFAULT 0 NOT NULL,
	"pending_application_count" integer DEFAULT 0 NOT NULL,
	"project_time_zone" text DEFAULT 'UTC' NOT NULL,
	"daily_log_streak_days" integer,
	"last_daily_log_date" date,
	"verified_effort_minutes_total" integer,
	"allocated_equity_basis_points" integer,
	"stats_computed_at" timestamp,
	CONSTRAINT "project_stats_counters_non_negative_ck" CHECK (watchers_count >= 0 AND team_member_count >= 0
          AND open_role_count >= 0 AND pending_application_count >= 0),
	CONSTRAINT "project_stats_allocated_equity_ck" CHECK (allocated_equity_basis_points IS NULL
          OR (allocated_equity_basis_points BETWEEN 0 AND 10000)),
	CONSTRAINT "project_stats_effort_minutes_ck" CHECK (verified_effort_minutes_total IS NULL OR verified_effort_minutes_total >= 0)
);
--> statement-breakpoint
CREATE TABLE "project_watcher" (
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "project_watcher_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "research_category" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"status" "research_category_status" DEFAULT 'pending' NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_project" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"founder_user_id" text NOT NULL,
	"name" text NOT NULL,
	"tagline" text NOT NULL,
	"description" text,
	"problem_statement" text,
	"solution_summary" text,
	"target_region" text,
	"demand_evidence_notes" text,
	"category_id" text NOT NULL,
	"stage" "project_stage" DEFAULT 'market_research' NOT NULL,
	"status" "research_project_status" DEFAULT 'draft' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"cover_image_url" text,
	"cover_image_public_id" text,
	"seed_roles_needed" text[] DEFAULT '{}' NOT NULL,
	"offered_equity_basis_points_min" integer,
	"offered_equity_basis_points_max" integer,
	"expected_commitment" "role_commitment",
	"published_at" timestamp,
	"archived_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "research_project_offered_equity_ck" CHECK ((offered_equity_basis_points_min IS NULL OR (offered_equity_basis_points_min BETWEEN 0 AND 10000))
          AND (offered_equity_basis_points_max IS NULL OR (offered_equity_basis_points_max BETWEEN 0 AND 10000))
          AND (offered_equity_basis_points_min IS NULL OR offered_equity_basis_points_max IS NULL
               OR offered_equity_basis_points_min <= offered_equity_basis_points_max)),
	CONSTRAINT "research_project_published_at_ck" CHECK ((status <> 'active') OR (published_at IS NOT NULL)),
	CONSTRAINT "research_project_archived_at_ck" CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
	CONSTRAINT "research_project_seed_roles_ck" CHECK (cardinality(seed_roles_needed) <= 20)
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "platform_role" "platform_role";--> statement-breakpoint
ALTER TABLE "open_role_compensation" ADD CONSTRAINT "open_role_compensation_open_role_id_project_open_role_id_fk" FOREIGN KEY ("open_role_id") REFERENCES "public"."project_open_role"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_application" ADD CONSTRAINT "project_application_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_application" ADD CONSTRAINT "project_application_open_role_id_project_open_role_id_fk" FOREIGN KEY ("open_role_id") REFERENCES "public"."project_open_role"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_application" ADD CONSTRAINT "project_application_applicant_user_id_user_id_fk" FOREIGN KEY ("applicant_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_application" ADD CONSTRAINT "project_application_reviewed_by_user_id_user_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_invite" ADD CONSTRAINT "project_invite_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_invite" ADD CONSTRAINT "project_invite_open_role_id_project_open_role_id_fk" FOREIGN KEY ("open_role_id") REFERENCES "public"."project_open_role"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_invite" ADD CONSTRAINT "project_invite_invitee_user_id_user_id_fk" FOREIGN KEY ("invitee_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_invite" ADD CONSTRAINT "project_invite_invited_by_user_id_user_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_source_application_id_project_application_id_fk" FOREIGN KEY ("source_application_id") REFERENCES "public"."project_application"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_source_invite_id_project_invite_id_fk" FOREIGN KEY ("source_invite_id") REFERENCES "public"."project_invite"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_removed_by_user_id_user_id_fk" FOREIGN KEY ("removed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_member_interval" ADD CONSTRAINT "project_member_interval_member_id_project_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."project_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_member_interval" ADD CONSTRAINT "project_member_interval_ended_by_user_id_user_id_fk" FOREIGN KEY ("ended_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_open_role" ADD CONSTRAINT "project_open_role_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_stage_transition" ADD CONSTRAINT "project_stage_transition_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_stage_transition" ADD CONSTRAINT "project_stage_transition_changed_by_user_id_user_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_stats" ADD CONSTRAINT "project_stats_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_watcher" ADD CONSTRAINT "project_watcher_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_watcher" ADD CONSTRAINT "project_watcher_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_category" ADD CONSTRAINT "research_category_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_project" ADD CONSTRAINT "research_project_founder_user_id_user_id_fk" FOREIGN KEY ("founder_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_project" ADD CONSTRAINT "research_project_category_id_research_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."research_category"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "open_role_compensation_openRoleId_kind_unq" ON "open_role_compensation" USING btree ("open_role_id","kind");--> statement-breakpoint
CREATE INDEX "open_role_compensation_kind_equityMin_idx" ON "open_role_compensation" USING btree ("kind","equity_basis_points_min");--> statement-breakpoint
CREATE INDEX "open_role_compensation_kind_salaryMin_idx" ON "open_role_compensation" USING btree ("kind","salary_min_in_cents_per_month");--> statement-breakpoint
CREATE INDEX "project_application_projectId_status_idx" ON "project_application" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "project_application_applicantUserId_idx" ON "project_application" USING btree ("applicant_user_id");--> statement-breakpoint
CREATE INDEX "project_application_openRoleId_idx" ON "project_application" USING btree ("open_role_id");--> statement-breakpoint
CREATE INDEX "project_application_expiresAt_idx" ON "project_application" USING btree ("expires_at") WHERE status = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "project_application_live_role_unq" ON "project_application" USING btree ("project_id","applicant_user_id","open_role_id") WHERE status = 'pending' AND kind = 'role_interest';--> statement-breakpoint
CREATE UNIQUE INDEX "project_application_live_join_unq" ON "project_application" USING btree ("project_id","applicant_user_id") WHERE status = 'pending' AND kind = 'join_request';--> statement-breakpoint
CREATE INDEX "project_invite_inviteeUserId_status_idx" ON "project_invite" USING btree ("invitee_user_id","status");--> statement-breakpoint
CREATE INDEX "project_invite_projectId_status_idx" ON "project_invite" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "project_invite_openRoleId_idx" ON "project_invite" USING btree ("open_role_id");--> statement-breakpoint
CREATE INDEX "project_invite_expiresAt_idx" ON "project_invite" USING btree ("expires_at") WHERE status = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "project_invite_live_role_unq" ON "project_invite" USING btree ("project_id","invitee_user_id","open_role_id") WHERE status = 'pending' AND open_role_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "project_invite_live_project_unq" ON "project_invite" USING btree ("project_id","invitee_user_id") WHERE status = 'pending' AND open_role_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "project_member_projectId_userId_unq" ON "project_member" USING btree ("project_id","user_id");--> statement-breakpoint
CREATE INDEX "project_member_userId_idx" ON "project_member" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "project_member_projectId_status_idx" ON "project_member" USING btree ("project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "project_member_projectId_founder_unq" ON "project_member" USING btree ("project_id") WHERE project_role = 'founder';--> statement-breakpoint
CREATE INDEX "project_member_interval_memberId_joinedAt_idx" ON "project_member_interval" USING btree ("member_id","joined_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_member_interval_open_unq" ON "project_member_interval" USING btree ("member_id") WHERE left_at IS NULL;--> statement-breakpoint
CREATE INDEX "project_open_role_projectId_idx" ON "project_open_role" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_open_role_status_commitment_idx" ON "project_open_role" USING btree ("status","commitment");--> statement-breakpoint
CREATE INDEX "project_open_role_status_createdAt_idx" ON "project_open_role" USING btree ("status","created_at","id");--> statement-breakpoint
CREATE INDEX "project_open_role_skills_gin" ON "project_open_role" USING gin ("skills");--> statement-breakpoint
CREATE INDEX "project_stage_transition_projectId_createdAt_idx" ON "project_stage_transition" USING btree ("project_id","created_at","id");--> statement-breakpoint
CREATE INDEX "project_watcher_userId_idx" ON "project_watcher" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "research_category_slug_unq" ON "research_category" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "research_category_status_idx" ON "research_category" USING btree ("status");--> statement-breakpoint
CREATE INDEX "research_category_createdByUserId_idx" ON "research_category" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "research_project_slug_unq" ON "research_project" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "research_project_founderUserId_idx" ON "research_project" USING btree ("founder_user_id");--> statement-breakpoint
CREATE INDEX "research_project_status_idx" ON "research_project" USING btree ("status");--> statement-breakpoint
CREATE INDEX "research_project_status_stage_idx" ON "research_project" USING btree ("status","stage");--> statement-breakpoint
CREATE INDEX "research_project_categoryId_idx" ON "research_project" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "research_project_status_publishedAt_idx" ON "research_project" USING btree ("status","published_at","id");--> statement-breakpoint
CREATE INDEX "user_platformRole_idx" ON "user" USING btree ("platform_role") WHERE platform_role IS NOT NULL;--> statement-breakpoint
-- ===========================================================================
-- HAND-APPENDED (R&D Phase 0 + Phase 1). Everything below is what Drizzle
-- cannot express. Partial unique indexes and CHECK constraints are NOT here:
-- drizzle-kit 0.31.10 emits both (verified in the generated statements above),
-- so re-adding them would fail on duplicate names.
-- ===========================================================================

-- 1. APPEND-ONLY ENFORCEMENT (R_AND_D_BACKEND_STRUCTURE.md §4f).
-- project_stage_transition and project_member_interval are the first audit
-- tables in this codebase; §7's escrow_journal_entry and §9's
-- slice_ledger_entry attach to this SAME function in their own migrations.
--
-- Custom SQLSTATE 'QT001' so an append-only violation is distinguishable from
-- a genuine CHECK violation in the logs. Both are programmer errors and both
-- re-throw to a 500 — the distinct code exists for diagnosis, not for a
-- Result branch. Corrections are REVERSING ENTRIES, never edits.
CREATE OR REPLACE FUNCTION qatoto_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'append-only table %.% rejects % (R_AND_D_BACKEND_STRUCTURE.md 4f)',
    TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'QT001';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS project_stage_transition_append_only ON "project_stage_transition";
--> statement-breakpoint
CREATE TRIGGER project_stage_transition_append_only
BEFORE UPDATE OR DELETE ON "project_stage_transition"
FOR EACH ROW EXECUTE FUNCTION qatoto_reject_mutation();
--> statement-breakpoint
-- A BEFORE UPDATE OR DELETE *row* trigger does NOT fire on TRUNCATE.
DROP TRIGGER IF EXISTS project_stage_transition_no_truncate ON "project_stage_transition";
--> statement-breakpoint
CREATE TRIGGER project_stage_transition_no_truncate
BEFORE TRUNCATE ON "project_stage_transition"
FOR EACH STATEMENT EXECUTE FUNCTION qatoto_reject_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS project_member_interval_append_only ON "project_member_interval";
--> statement-breakpoint
-- DELETE and TRUNCATE are rejected outright. UPDATE is NOT blanket-rejected
-- here, because closing a stint legitimately writes left_at on the open row —
-- it is constrained instead by the seal-only trigger below, which permits that
-- one transition and nothing else.
CREATE TRIGGER project_member_interval_append_only
BEFORE DELETE ON "project_member_interval"
FOR EACH ROW EXECUTE FUNCTION qatoto_reject_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS project_member_interval_no_truncate ON "project_member_interval";
--> statement-breakpoint
CREATE TRIGGER project_member_interval_no_truncate
BEFORE TRUNCATE ON "project_member_interval"
FOR EACH STATEMENT EXECUTE FUNCTION qatoto_reject_mutation();
--> statement-breakpoint
-- project_member_interval permits exactly ONE mutation: sealing an open stint
-- by writing left_at / ended_reason / ended_by_user_id. Every other column is
-- frozen, and a sealed row can never be re-opened or re-sealed. This is the
-- narrowest rule that still lets a stint END without inventing a second table.
CREATE OR REPLACE FUNCTION qatoto_member_interval_seal_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.left_at IS NOT NULL THEN
    RAISE EXCEPTION 'project_member_interval %: already sealed, intervals are immutable once closed', OLD.id
      USING ERRCODE = 'QT001';
  END IF;
  IF NEW.left_at IS NULL THEN
    RAISE EXCEPTION 'project_member_interval %: the only permitted UPDATE is sealing (left_at must be set)', OLD.id
      USING ERRCODE = 'QT001';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.member_id IS DISTINCT FROM OLD.member_id
     OR NEW.joined_at IS DISTINCT FROM OLD.joined_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'project_member_interval %: only left_at, ended_reason and ended_by_user_id may be written', OLD.id
      USING ERRCODE = 'QT001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS project_member_interval_seal_only ON "project_member_interval";
--> statement-breakpoint
CREATE TRIGGER project_member_interval_seal_only
BEFORE UPDATE ON "project_member_interval"
FOR EACH ROW EXECUTE FUNCTION qatoto_member_interval_seal_only();
--> statement-breakpoint

-- 2. GRANT REVOCATION (§4f, second half).
-- HONEST CAVEAT: REVOKE has NO effect on a table's OWNER, and DATABASE_URL
-- connects as the owner today. In this phase the TRIGGERS above are the real
-- enforcement, and this block is a guarded placeholder that documents the infra
-- task: provision a non-owner `qatoto_app` role and repoint DATABASE_URL at it,
-- at which point this becomes load-bearing with no migration change.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qatoto_app') THEN
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "project_stage_transition" FROM qatoto_app';
    EXECUTE 'REVOKE DELETE, TRUNCATE ON TABLE "project_member_interval" FROM qatoto_app';
  END IF;
END $$;
--> statement-breakpoint

-- 3. SEED THE TAXONOMY. NOT sample data: research_project.category_id is
-- NOT NULL ON DELETE RESTRICT, so a freshly migrated database cannot accept a
-- single project — the taxonomy is a schema precondition, the same class as
-- 0008's CREATE EXTENSION citext. Literal UUIDs so every environment agrees.
-- MUST stay byte-identical to BASELINE_RESEARCH_CATEGORIES in
-- src/db/seed-data.ts, which is the source of truth for growth; this block is
-- the one-time bootstrap.
INSERT INTO "research_category" ("id", "slug", "label", "status", "created_by_user_id")
VALUES
  ('a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a01', 'agriculture',      'Agriculture',        'approved', NULL),
  ('a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a02', 'clean-energy',     'Clean Energy',       'approved', NULL),
  ('a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a03', 'healthcare',       'Healthcare',         'approved', NULL),
  ('a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a04', 'housing',          'Housing',            'approved', NULL),
  ('a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a05', 'logistics',        'Logistics',          'approved', NULL),
  ('a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a06', 'manufacturing',    'Manufacturing',      'approved', NULL),
  ('a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a07', 'water-sanitation', 'Water & Sanitation', 'approved', NULL),
  ('a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a08', 'waste-recycling',  'Waste & Recycling',  'approved', NULL)
ON CONFLICT ("slug") DO NOTHING;
