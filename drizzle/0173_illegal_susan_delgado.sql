CREATE TYPE "public"."blueprint_discipline" AS ENUM('tooling', 'supply_chain', 'quality', 'distribution', 'unit_economics');--> statement-breakpoint
CREATE TYPE "public"."case_study_author_relationship" AS ENUM('first_hand', 'public_sources');--> statement-breakpoint
CREATE TYPE "public"."case_study_metric_kind" AS ENUM('count', 'money', 'percentage');--> statement-breakpoint
CREATE TABLE "case_study" (
	"id" text PRIMARY KEY NOT NULL,
	"public_slug" text,
	"title" text NOT NULL,
	"title_normalized" text GENERATED ALWAYS AS (lower(regexp_replace(btrim(title), '[[:space:]]+', ' ', 'g'))) STORED,
	"one_line_action" text NOT NULL,
	"summary" text NOT NULL,
	"problem" text NOT NULL,
	"context" text NOT NULL,
	"discipline" "blueprint_discipline" NOT NULL,
	"sector" text NOT NULL,
	"outcome_summary" text,
	"timeline_label" text,
	"author_relationship" "case_study_author_relationship" NOT NULL,
	"accepted_statement_ids" text[] NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"capital_raised_amount_cents" bigint,
	"capital_raised_currency" text,
	"author_user_id" text,
	"author_display_name" text,
	"author_handle" text,
	"moderation_state" "blueprint_moderation_state" DEFAULT 'pending_review' NOT NULL,
	"moderator_note" text,
	"reviewed_by_user_id" text,
	"reviewed_at" timestamp (3),
	"created_at" timestamp (3) NOT NULL,
	"updated_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "case_study_public_slug_unique" UNIQUE("public_slug"),
	CONSTRAINT "case_study_author_relationship_uidx" UNIQUE("id","author_relationship"),
	CONSTRAINT "case_study_moderation_state_ck" CHECK (moderation_state IN ('pending_review', 'published', 'rejected', 'flagged')),
	CONSTRAINT "case_study_statements_ck" CHECK (cardinality(accepted_statement_ids) = 2
          AND array_position(accepted_statement_ids, NULL) IS NULL
          AND ((author_relationship = 'first_hand'
                AND accepted_statement_ids @> ARRAY['was_part_of_it', 'figures_from_records']::text[])
            OR (author_relationship = 'public_sources'
                AND accepted_statement_ids @> ARRAY['figures_in_linked_sources', 'says_only_what_sources_say']::text[]))),
	CONSTRAINT "case_study_tags_ck" CHECK (cardinality(tags) <= 10 AND array_position(tags, NULL) IS NULL),
	CONSTRAINT "case_study_author_arm_ck" CHECK ((author_user_id IS NOT NULL
           AND author_display_name IS NULL
           AND author_handle IS NULL)
          OR (author_user_id IS NULL AND author_display_name IS NOT NULL)),
	CONSTRAINT "case_study_decision_ck" CHECK ((reviewed_at IS NULL) = (reviewed_by_user_id IS NULL)
          AND (moderation_state <> 'pending_review' OR moderator_note IS NULL)
          AND (moderation_state <> 'rejected' OR moderator_note IS NOT NULL)
          AND (public_slug IS NOT NULL) = (moderation_state IN ('published', 'flagged'))),
	CONSTRAINT "case_study_slug_ck" CHECK (public_slug IS NULL
          OR (char_length(public_slug) BETWEEN 3 AND 120
              AND public_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
              AND public_slug NOT IN ('new', 'mine', 'slugs', 'options'))),
	CONSTRAINT "case_study_text_lengths_ck" CHECK (char_length(title) BETWEEN 12 AND 140
          AND char_length(one_line_action) BETWEEN 10 AND 140
          AND char_length(summary) BETWEEN 40 AND 600
          AND char_length(problem) BETWEEN 20 AND 2000
          AND char_length(context) BETWEEN 20 AND 2000
          AND char_length(sector) BETWEEN 1 AND 60
          AND (outcome_summary IS NULL OR char_length(outcome_summary) BETWEEN 1 AND 120)
          AND (timeline_label IS NULL OR char_length(timeline_label) BETWEEN 1 AND 60)
          AND (moderator_note IS NULL OR char_length(moderator_note) BETWEEN 1 AND 2000)
          AND (author_display_name IS NULL OR char_length(author_display_name) BETWEEN 1 AND 80)
          AND (author_handle IS NULL
               OR (char_length(author_handle) BETWEEN 1 AND 64
                   AND author_handle ~ '^[A-Za-z0-9_.-]+$'))),
	CONSTRAINT "case_study_capital_raised_ck" CHECK ((capital_raised_amount_cents IS NULL AND capital_raised_currency IS NULL)
          OR (capital_raised_amount_cents IS NOT NULL
              AND capital_raised_amount_cents >= 0
              AND capital_raised_currency IS NOT NULL
              AND capital_raised_currency IN ('USD', 'INR')))
);
--> statement-breakpoint
CREATE TABLE "case_study_action_step" (
	"id" text PRIMARY KEY NOT NULL,
	"case_study_id" text NOT NULL,
	"position" integer NOT NULL,
	"body" text NOT NULL,
	CONSTRAINT "case_study_action_step_ck" CHECK (position >= 0 AND char_length(body) BETWEEN 1 AND 300)
);
--> statement-breakpoint
CREATE TABLE "case_study_evidence_company" (
	"id" text PRIMARY KEY NOT NULL,
	"case_study_id" text NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"is_name_withheld" boolean DEFAULT false NOT NULL,
	"author_relationship" "case_study_author_relationship" NOT NULL,
	"location_label" text NOT NULL,
	"year_label" text NOT NULL,
	CONSTRAINT "case_study_evidence_company_withheld_ck" CHECK (NOT (is_name_withheld AND author_relationship <> 'first_hand')),
	CONSTRAINT "case_study_evidence_company_text_ck" CHECK (position >= 0
          AND char_length(name) BETWEEN 1 AND 80
          AND char_length(location_label) BETWEEN 1 AND 60
          AND char_length(year_label) BETWEEN 1 AND 20)
);
--> statement-breakpoint
CREATE TABLE "case_study_outcome_metric" (
	"id" text PRIMARY KEY NOT NULL,
	"case_study_id" text NOT NULL,
	"position" integer NOT NULL,
	"label" text NOT NULL,
	"kind" "case_study_metric_kind" NOT NULL,
	"count_amount" integer,
	"money_amount_cents" bigint,
	"money_currency" text,
	"basis_points" integer,
	CONSTRAINT "case_study_outcome_metric_kind_ck" CHECK ((kind = 'count'
           AND count_amount IS NOT NULL
           AND count_amount >= 0
           AND money_amount_cents IS NULL
           AND money_currency IS NULL
           AND basis_points IS NULL)
          OR (kind = 'money'
              AND money_amount_cents IS NOT NULL
              AND money_amount_cents >= 0
              AND money_currency IS NOT NULL
              AND money_currency IN ('USD', 'INR')
              AND count_amount IS NULL
              AND basis_points IS NULL)
          OR (kind = 'percentage'
              AND basis_points IS NOT NULL
              AND count_amount IS NULL
              AND money_amount_cents IS NULL
              AND money_currency IS NULL)),
	CONSTRAINT "case_study_outcome_metric_label_ck" CHECK (position >= 0
          AND char_length(label) BETWEEN 1 AND 60
          AND lower(btrim(label)) NOT LIKE 'name withheld%')
);
--> statement-breakpoint
CREATE TABLE "case_study_pitfall" (
	"id" text PRIMARY KEY NOT NULL,
	"case_study_id" text NOT NULL,
	"position" integer NOT NULL,
	"body" text NOT NULL,
	CONSTRAINT "case_study_pitfall_ck" CHECK (position >= 0 AND char_length(body) BETWEEN 1 AND 300)
);
--> statement-breakpoint
CREATE TABLE "case_study_related_lesson" (
	"id" text PRIMARY KEY NOT NULL,
	"case_study_id" text NOT NULL,
	"position" integer NOT NULL,
	"related_public_slug" text NOT NULL,
	CONSTRAINT "case_study_related_lesson_ck" CHECK (position >= 0 AND related_public_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
CREATE TABLE "case_study_source" (
	"id" text PRIMARY KEY NOT NULL,
	"case_study_id" text NOT NULL,
	"position" integer NOT NULL,
	"label" text NOT NULL,
	"publisher_label" text NOT NULL,
	"url" text NOT NULL,
	CONSTRAINT "case_study_source_url_ck" CHECK (char_length(url) BETWEEN 1 AND 2048
          AND url !~ '[[:space:][:cntrl:]]'
          AND url LIKE 'https://%'),
	CONSTRAINT "case_study_source_text_ck" CHECK (position >= 0
          AND char_length(label) BETWEEN 1 AND 120
          AND char_length(publisher_label) BETWEEN 1 AND 80)
);
--> statement-breakpoint
CREATE TABLE "case_study_stats" (
	"case_study_id" text PRIMARY KEY NOT NULL,
	"view_count" integer DEFAULT 0 NOT NULL,
	"like_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "case_study_stats_nonnegative_ck" CHECK (view_count >= 0 AND like_count >= 0)
);
--> statement-breakpoint
ALTER TABLE "case_study" ADD CONSTRAINT "case_study_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_study" ADD CONSTRAINT "case_study_reviewed_by_user_id_user_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_study_action_step" ADD CONSTRAINT "case_study_action_step_case_study_id_case_study_id_fk" FOREIGN KEY ("case_study_id") REFERENCES "public"."case_study"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_study_evidence_company" ADD CONSTRAINT "case_study_evidence_company_case_study_id_case_study_id_fk" FOREIGN KEY ("case_study_id") REFERENCES "public"."case_study"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_study_evidence_company" ADD CONSTRAINT "case_study_evidence_company_relationship_fk" FOREIGN KEY ("case_study_id","author_relationship") REFERENCES "public"."case_study"("id","author_relationship") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "case_study_outcome_metric" ADD CONSTRAINT "case_study_outcome_metric_case_study_id_case_study_id_fk" FOREIGN KEY ("case_study_id") REFERENCES "public"."case_study"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_study_pitfall" ADD CONSTRAINT "case_study_pitfall_case_study_id_case_study_id_fk" FOREIGN KEY ("case_study_id") REFERENCES "public"."case_study"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_study_related_lesson" ADD CONSTRAINT "case_study_related_lesson_case_study_id_case_study_id_fk" FOREIGN KEY ("case_study_id") REFERENCES "public"."case_study"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_study_related_lesson" ADD CONSTRAINT "case_study_related_lesson_related_public_slug_case_study_public_slug_fk" FOREIGN KEY ("related_public_slug") REFERENCES "public"."case_study"("public_slug") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "case_study_source" ADD CONSTRAINT "case_study_source_case_study_id_case_study_id_fk" FOREIGN KEY ("case_study_id") REFERENCES "public"."case_study"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_study_stats" ADD CONSTRAINT "case_study_stats_case_study_id_case_study_id_fk" FOREIGN KEY ("case_study_id") REFERENCES "public"."case_study"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "case_study_title_live_uidx" ON "case_study" USING btree ("title_normalized") WHERE moderation_state IN ('pending_review', 'published', 'flagged');--> statement-breakpoint
CREATE INDEX "case_study_author_idx" ON "case_study" USING btree ("author_user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "case_study_review_queue_idx" ON "case_study" USING btree ("created_at","id") WHERE moderation_state = 'pending_review';--> statement-breakpoint
CREATE INDEX "case_study_public_newest_idx" ON "case_study" USING btree ("created_at" desc,"id") WHERE moderation_state IN ('published', 'flagged');--> statement-breakpoint
CREATE UNIQUE INDEX "case_study_action_step_position_uidx" ON "case_study_action_step" USING btree ("case_study_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "case_study_action_step_body_uidx" ON "case_study_action_step" USING btree ("case_study_id",lower(btrim(body)));--> statement-breakpoint
CREATE UNIQUE INDEX "case_study_evidence_company_position_uidx" ON "case_study_evidence_company" USING btree ("case_study_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "case_study_evidence_company_name_uidx" ON "case_study_evidence_company" USING btree ("case_study_id",lower(btrim(name)));--> statement-breakpoint
CREATE UNIQUE INDEX "case_study_outcome_metric_position_uidx" ON "case_study_outcome_metric" USING btree ("case_study_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "case_study_outcome_metric_label_uidx" ON "case_study_outcome_metric" USING btree ("case_study_id",lower(btrim(label)));--> statement-breakpoint
CREATE UNIQUE INDEX "case_study_pitfall_position_uidx" ON "case_study_pitfall" USING btree ("case_study_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "case_study_pitfall_body_uidx" ON "case_study_pitfall" USING btree ("case_study_id",lower(btrim(body)));--> statement-breakpoint
CREATE UNIQUE INDEX "case_study_related_lesson_position_uidx" ON "case_study_related_lesson" USING btree ("case_study_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "case_study_related_lesson_slug_uidx" ON "case_study_related_lesson" USING btree ("case_study_id","related_public_slug");--> statement-breakpoint
CREATE UNIQUE INDEX "case_study_source_position_uidx" ON "case_study_source" USING btree ("case_study_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "case_study_source_url_uidx" ON "case_study_source" USING btree ("case_study_id",btrim(url));