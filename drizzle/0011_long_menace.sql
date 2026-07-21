CREATE TYPE "public"."category_pin_icon_key" AS ENUM('water', 'energy', 'health', 'agriculture', 'housing', 'transport', 'waste', 'connectivity', 'manufacturing', 'education', 'other');--> statement-breakpoint
CREATE TYPE "public"."cluster_merge_proposal_source" AS ENUM('job_similarity', 'moderator');--> statement-breakpoint
CREATE TYPE "public"."cluster_merge_proposal_status" AS ENUM('pending', 'approved', 'rejected', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."discovery_region_kind" AS ENUM('global', 'macro_region', 'country');--> statement-breakpoint
CREATE TYPE "public"."geocode_status" AS ENUM('resolved', 'not_found');--> statement-breakpoint
CREATE TYPE "public"."market_insight_stat_kind" AS ENUM('percent_change', 'percent_level', 'absolute_count', 'multiplier');--> statement-breakpoint
CREATE TYPE "public"."market_insight_stat_unit_key" AS ENUM('percent', 'multiple', 'people', 'households', 'tonnes', 'litres', 'hectares', 'usd_dollars', 'count');--> statement-breakpoint
CREATE TYPE "public"."problem_cluster_link_source" AS ENUM('origin', 'founder_declared', 'moderator');--> statement-breakpoint
CREATE TYPE "public"."problem_cluster_status" AS ENUM('active', 'merged', 'hidden');--> statement-breakpoint
CREATE TYPE "public"."problem_submission_status" AS ENUM('queued', 'clustered', 'geocode_failed', 'rejected', 'failed');--> statement-breakpoint
CREATE TYPE "public"."talent_availability" AS ENUM('open_to_work', 'open_to_offers', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."talent_profile_visibility" AS ENUM('private', 'published');--> statement-breakpoint
CREATE TYPE "public"."trend_direction" AS ENUM('up', 'down', 'flat');--> statement-breakpoint
CREATE TABLE "demand_signal_snapshot" (
	"id" text PRIMARY KEY NOT NULL,
	"as_of" timestamp NOT NULL,
	"window_starts_at" timestamp NOT NULL,
	"window_ends_at" timestamp NOT NULL,
	"category_id" text NOT NULL,
	"region_id" text NOT NULL,
	"rank" integer NOT NULL,
	"demand_score_points" integer NOT NULL,
	"trend_direction" "trend_direction" NOT NULL,
	"previous_demand_score_points" integer,
	"cluster_count" integer NOT NULL,
	"distinct_reporter_count" integer NOT NULL,
	"related_project_count" integer NOT NULL,
	"open_role_count" integer NOT NULL,
	"score_algorithm_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "demand_signal_snapshot_rank_ck" CHECK (rank >= 1),
	CONSTRAINT "demand_signal_snapshot_score_ck" CHECK (demand_score_points BETWEEN 0 AND 100),
	CONSTRAINT "demand_signal_snapshot_window_ck" CHECK (window_ends_at > window_starts_at AND as_of >= window_ends_at),
	CONSTRAINT "demand_signal_snapshot_counts_ck" CHECK (cluster_count >= 0 AND distinct_reporter_count >= 0
          AND related_project_count >= 0 AND open_role_count >= 0
          AND (previous_demand_score_points IS NULL
               OR previous_demand_score_points BETWEEN 0 AND 100)),
	CONSTRAINT "demand_signal_snapshot_trend_agreement_ck" CHECK (previous_demand_score_points IS NULL
          OR (trend_direction = 'up' AND demand_score_points > previous_demand_score_points)
          OR (trend_direction = 'down' AND demand_score_points < previous_demand_score_points)
          OR (trend_direction = 'flat' AND demand_score_points = previous_demand_score_points))
);
--> statement-breakpoint
CREATE TABLE "discovery_region" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"kind" "discovery_region_kind" NOT NULL,
	"parent_region_id" text,
	"country_code" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "discovery_region_country_ck" CHECK ((kind = 'country') = (country_code IS NOT NULL)
          AND (country_code IS NULL OR country_code ~ '^[A-Z]{2}$')),
	CONSTRAINT "discovery_region_root_ck" CHECK ((kind = 'global') = (parent_region_id IS NULL))
);
--> statement-breakpoint
CREATE TABLE "discovery_skill" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"category_id" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "geocode_cache" (
	"normalized_query" text PRIMARY KEY NOT NULL,
	"original_query" text NOT NULL,
	"status" "geocode_status" NOT NULL,
	"latitude_microdegrees" integer,
	"longitude_microdegrees" integer,
	"country_code" text,
	"region_id" text,
	"resolved_label" text,
	"provider" text NOT NULL,
	"fetched_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "geocode_cache_resolved_shape_ck" CHECK ((status = 'resolved') = (latitude_microdegrees IS NOT NULL)
          AND (latitude_microdegrees IS NULL) = (longitude_microdegrees IS NULL)
          AND (status = 'not_found' OR country_code IS NOT NULL)),
	CONSTRAINT "geocode_cache_coordinate_range_ck" CHECK ((latitude_microdegrees IS NULL
           OR latitude_microdegrees BETWEEN -90000000 AND 90000000)
          AND (longitude_microdegrees IS NULL
               OR longitude_microdegrees BETWEEN -180000000 AND 180000000)),
	CONSTRAINT "geocode_cache_country_ck" CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
CREATE TABLE "job_failure" (
	"id" text PRIMARY KEY NOT NULL,
	"queue_name" text NOT NULL,
	"source_job_id" text NOT NULL,
	"payload_json" text NOT NULL,
	"error_message" text NOT NULL,
	"attempt_count" integer NOT NULL,
	"failed_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp,
	"resolution_note" text,
	CONSTRAINT "job_failure_attempt_ck" CHECK (attempt_count >= 0)
);
--> statement-breakpoint
CREATE TABLE "market_insight" (
	"id" text PRIMARY KEY NOT NULL,
	"headline" text NOT NULL,
	"summary" text,
	"stat_kind" "market_insight_stat_kind" NOT NULL,
	"stat_value_milli" bigint NOT NULL,
	"stat_unit_key" "market_insight_stat_unit_key" NOT NULL,
	"trend_direction" "trend_direction" NOT NULL,
	"region_id" text NOT NULL,
	"category_id" text NOT NULL,
	"source_name" text NOT NULL,
	"source_url" text,
	"source_published_date" date NOT NULL,
	"published_at" timestamp,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "market_insight_stat_unit_pairing_ck" CHECK ((stat_kind IN ('percent_change','percent_level') AND stat_unit_key = 'percent')
          OR (stat_kind = 'multiplier' AND stat_unit_key = 'multiple')
          OR (stat_kind = 'absolute_count' AND stat_unit_key NOT IN ('percent','multiple'))),
	CONSTRAINT "market_insight_stat_range_ck" CHECK ((stat_kind = 'percent_change' OR stat_value_milli >= 0)
          AND (stat_kind <> 'multiplier' OR stat_value_milli > 0)
          AND (stat_kind <> 'percent_level' OR stat_value_milli BETWEEN 0 AND 100000)
          AND abs(stat_value_milli) <= 9000000000000000),
	CONSTRAINT "market_insight_trend_agreement_ck" CHECK (stat_kind <> 'percent_change'
          OR (trend_direction = 'up' AND stat_value_milli > 0)
          OR (trend_direction = 'down' AND stat_value_milli < 0)
          OR (trend_direction = 'flat' AND stat_value_milli = 0)),
	CONSTRAINT "market_insight_headline_ck" CHECK (char_length(headline) BETWEEN 1 AND 240)
);
--> statement-breakpoint
CREATE TABLE "problem_cluster" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"category_id" text NOT NULL,
	"centroid_latitude_microdegrees" integer NOT NULL,
	"centroid_longitude_microdegrees" integer NOT NULL,
	"centroid_latitude_sum_microdegrees" bigint NOT NULL,
	"centroid_longitude_sum_microdegrees" bigint NOT NULL,
	"centroid_sample_count" integer NOT NULL,
	"country_code" text,
	"region_id" text,
	"location_label" text,
	"status" "problem_cluster_status" DEFAULT 'active' NOT NULL,
	"merged_into_cluster_id" text,
	"distinct_reporter_count" integer DEFAULT 0 NOT NULL,
	"submission_count" integer DEFAULT 0 NOT NULL,
	"first_reported_at" timestamp NOT NULL,
	"last_reported_at" timestamp NOT NULL,
	"current_opportunity_score_points" integer,
	"score_computed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "problem_cluster_centroid_range_ck" CHECK (centroid_latitude_microdegrees BETWEEN -90000000 AND 90000000
          AND centroid_longitude_microdegrees BETWEEN -180000000 AND 180000000),
	CONSTRAINT "problem_cluster_sample_count_ck" CHECK (centroid_sample_count >= 1),
	CONSTRAINT "problem_cluster_counts_ck" CHECK (distinct_reporter_count >= 0
          AND submission_count >= distinct_reporter_count
          AND submission_count >= centroid_sample_count),
	CONSTRAINT "problem_cluster_merged_ck" CHECK ((status = 'merged') = (merged_into_cluster_id IS NOT NULL)
          AND (merged_into_cluster_id IS DISTINCT FROM id)),
	CONSTRAINT "problem_cluster_reported_order_ck" CHECK (last_reported_at >= first_reported_at),
	CONSTRAINT "problem_cluster_score_ck" CHECK ((current_opportunity_score_points IS NULL
           OR current_opportunity_score_points BETWEEN 0 AND 100)
          AND (current_opportunity_score_points IS NULL) = (score_computed_at IS NULL)),
	CONSTRAINT "problem_cluster_country_ck" CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
CREATE TABLE "problem_cluster_merge_proposal" (
	"id" text PRIMARY KEY NOT NULL,
	"source_cluster_id" text NOT NULL,
	"target_cluster_id" text NOT NULL,
	"status" "cluster_merge_proposal_status" DEFAULT 'pending' NOT NULL,
	"source" "cluster_merge_proposal_source" DEFAULT 'job_similarity' NOT NULL,
	"similarity_basis_points" integer NOT NULL,
	"centroid_distance_metres" integer NOT NULL,
	"as_of" timestamp NOT NULL,
	"proposed_by_user_id" text,
	"decided_by_user_id" text,
	"decided_at" timestamp,
	"decision_note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "problem_cluster_merge_proposal_distinct_ck" CHECK (source_cluster_id <> target_cluster_id),
	CONSTRAINT "problem_cluster_merge_proposal_decided_ck" CHECK ((status = 'pending') = (decided_at IS NULL)
          AND (decided_by_user_id IS NULL) = (decided_at IS NULL)),
	CONSTRAINT "problem_cluster_merge_proposal_evidence_ck" CHECK (similarity_basis_points BETWEEN 0 AND 10000 AND centroid_distance_metres >= 0)
);
--> statement-breakpoint
CREATE TABLE "problem_cluster_project_link" (
	"cluster_id" text NOT NULL,
	"project_id" text NOT NULL,
	"source" "problem_cluster_link_source" NOT NULL,
	"linked_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "problem_cluster_project_link_cluster_id_project_id_pk" PRIMARY KEY("cluster_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "problem_cluster_score_snapshot" (
	"id" text PRIMARY KEY NOT NULL,
	"cluster_id" text NOT NULL,
	"as_of" timestamp NOT NULL,
	"window_starts_at" timestamp NOT NULL,
	"window_ends_at" timestamp NOT NULL,
	"opportunity_score_points" integer NOT NULL,
	"distinct_reporter_count" integer NOT NULL,
	"submission_count" integer NOT NULL,
	"distinct_region_count" integer NOT NULL,
	"category_share_basis_points" integer NOT NULL,
	"age_in_days" integer NOT NULL,
	"linked_project_count" integer NOT NULL,
	"reporter_component_points" integer NOT NULL,
	"spread_component_points" integer NOT NULL,
	"demand_component_points" integer NOT NULL,
	"recency_component_points" integer NOT NULL,
	"scarcity_component_points" integer NOT NULL,
	"score_algorithm_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "problem_cluster_score_snapshot_score_ck" CHECK (opportunity_score_points BETWEEN 0 AND 100),
	CONSTRAINT "problem_cluster_score_snapshot_window_ck" CHECK (window_ends_at > window_starts_at AND as_of >= window_ends_at),
	CONSTRAINT "problem_cluster_score_snapshot_inputs_ck" CHECK (distinct_reporter_count >= 0
          AND submission_count >= distinct_reporter_count
          AND distinct_region_count >= 0
          AND category_share_basis_points BETWEEN 0 AND 10000
          AND linked_project_count >= 0),
	CONSTRAINT "problem_cluster_score_snapshot_components_ck" CHECK (reporter_component_points >= 0 AND spread_component_points >= 0
          AND demand_component_points >= 0 AND recency_component_points >= 0
          AND scarcity_component_points >= 0
          AND reporter_component_points + spread_component_points + demand_component_points
              + recency_component_points + scarcity_component_points
              = opportunity_score_points)
);
--> statement-breakpoint
CREATE TABLE "problem_submission" (
	"id" text PRIMARY KEY NOT NULL,
	"reporter_user_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"category_id" text NOT NULL,
	"location_text" text NOT NULL,
	"latitude_microdegrees" integer,
	"longitude_microdegrees" integer,
	"country_code" text,
	"region_id" text,
	"status" "problem_submission_status" DEFAULT 'queued' NOT NULL,
	"cluster_id" text,
	"clustered_at" timestamp,
	"cluster_match_basis_points" integer,
	"geocode_failure_reason" text,
	"counts_toward_distinct_reporters" boolean DEFAULT true NOT NULL,
	"moderation_note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "problem_submission_coordinate_range_ck" CHECK ((latitude_microdegrees IS NULL
           OR latitude_microdegrees BETWEEN -90000000 AND 90000000)
          AND (longitude_microdegrees IS NULL
               OR longitude_microdegrees BETWEEN -180000000 AND 180000000)
          AND (latitude_microdegrees IS NULL) = (longitude_microdegrees IS NULL)),
	CONSTRAINT "problem_submission_country_ck" CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$'),
	CONSTRAINT "problem_submission_cluster_shape_ck" CHECK ((status = 'clustered') = (cluster_id IS NOT NULL)
          AND (cluster_id IS NULL) = (clustered_at IS NULL)
          AND (cluster_id IS NULL OR latitude_microdegrees IS NOT NULL)),
	CONSTRAINT "problem_submission_match_ck" CHECK (cluster_match_basis_points IS NULL
          OR cluster_match_basis_points BETWEEN 0 AND 10000),
	CONSTRAINT "problem_submission_text_ck" CHECK (char_length(title) BETWEEN 1 AND 160
          AND char_length(description) BETWEEN 1 AND 5000
          AND char_length(location_text) BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE TABLE "talent_compensation_ask" (
	"id" text PRIMARY KEY NOT NULL,
	"talent_profile_user_id" text NOT NULL,
	"kind" "compensation_kind" NOT NULL,
	"salary_min_in_cents_per_month" bigint,
	"salary_max_in_cents_per_month" bigint,
	"one_time_min_in_cents" bigint,
	"one_time_max_in_cents" bigint,
	"equity_basis_points_min" integer,
	"equity_basis_points_max" integer,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "talent_compensation_ask_kind_columns_ck" CHECK (
      (kind = 'salary' AND salary_min_in_cents_per_month IS NOT NULL
                       AND one_time_min_in_cents IS NULL AND one_time_max_in_cents IS NULL
                       AND equity_basis_points_min IS NULL AND equity_basis_points_max IS NULL)
      OR (kind = 'one_time' AND one_time_min_in_cents IS NOT NULL
                       AND salary_min_in_cents_per_month IS NULL AND salary_max_in_cents_per_month IS NULL
                       AND equity_basis_points_min IS NULL AND equity_basis_points_max IS NULL)
      OR (kind = 'equity' AND equity_basis_points_min IS NOT NULL
                       AND salary_min_in_cents_per_month IS NULL AND salary_max_in_cents_per_month IS NULL
                       AND one_time_min_in_cents IS NULL AND one_time_max_in_cents IS NULL)),
	CONSTRAINT "talent_compensation_ask_ranges_ck" CHECK (
      (salary_min_in_cents_per_month IS NULL OR salary_min_in_cents_per_month >= 0)
      AND (salary_max_in_cents_per_month IS NULL OR salary_max_in_cents_per_month >= salary_min_in_cents_per_month)
      AND (one_time_min_in_cents IS NULL OR one_time_min_in_cents >= 0)
      AND (one_time_max_in_cents IS NULL OR one_time_max_in_cents >= one_time_min_in_cents)
      AND (equity_basis_points_min IS NULL OR equity_basis_points_min BETWEEN 0 AND 10000)
      AND (equity_basis_points_max IS NULL OR (equity_basis_points_max >= equity_basis_points_min
                                               AND equity_basis_points_max <= 10000)))
);
--> statement-breakpoint
CREATE TABLE "talent_profile" (
	"user_id" text PRIMARY KEY NOT NULL,
	"headline_role" text NOT NULL,
	"bio" text,
	"location_label" text,
	"region_id" text,
	"availability" "talent_availability" DEFAULT 'unavailable' NOT NULL,
	"commitment" "role_commitment",
	"visibility" "talent_profile_visibility" DEFAULT 'private' NOT NULL,
	"published_at" timestamp,
	"currency" text DEFAULT 'USD' NOT NULL,
	"cached_effort_minutes_logged" integer,
	"cached_projects_completed_count" integer,
	"projection_computed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "talent_profile_published_at_ck" CHECK ((visibility = 'published') = (published_at IS NOT NULL)),
	CONSTRAINT "talent_profile_cached_ck" CHECK ((cached_effort_minutes_logged IS NULL OR cached_effort_minutes_logged >= 0)
          AND (cached_projects_completed_count IS NULL OR cached_projects_completed_count >= 0)
          AND (cached_effort_minutes_logged IS NULL) = (projection_computed_at IS NULL)),
	CONSTRAINT "talent_profile_headline_ck" CHECK (char_length(headline_role) BETWEEN 1 AND 120),
	CONSTRAINT "talent_profile_currency_ck" CHECK (currency ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "talent_profile_skill" (
	"talent_profile_user_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"is_verified" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp,
	"verified_effort_minutes" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "talent_profile_skill_talent_profile_user_id_skill_id_pk" PRIMARY KEY("talent_profile_user_id","skill_id"),
	CONSTRAINT "talent_profile_skill_verified_ck" CHECK ((is_verified = false) = (verified_at IS NULL)
          AND (verified_effort_minutes IS NULL OR verified_effort_minutes >= 0))
);
--> statement-breakpoint
ALTER TABLE "research_category" ADD COLUMN "pin_icon_key" "category_pin_icon_key" DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "demand_signal_snapshot" ADD CONSTRAINT "demand_signal_snapshot_category_id_research_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."research_category"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_signal_snapshot" ADD CONSTRAINT "demand_signal_snapshot_region_id_discovery_region_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."discovery_region"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_region" ADD CONSTRAINT "discovery_region_parent_region_id_discovery_region_id_fk" FOREIGN KEY ("parent_region_id") REFERENCES "public"."discovery_region"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_skill" ADD CONSTRAINT "discovery_skill_category_id_research_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."research_category"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geocode_cache" ADD CONSTRAINT "geocode_cache_region_id_discovery_region_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."discovery_region"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_insight" ADD CONSTRAINT "market_insight_region_id_discovery_region_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."discovery_region"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_insight" ADD CONSTRAINT "market_insight_category_id_research_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."research_category"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_insight" ADD CONSTRAINT "market_insight_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_cluster" ADD CONSTRAINT "problem_cluster_category_id_research_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."research_category"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_cluster" ADD CONSTRAINT "problem_cluster_region_id_discovery_region_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."discovery_region"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_cluster" ADD CONSTRAINT "problem_cluster_merged_into_cluster_id_problem_cluster_id_fk" FOREIGN KEY ("merged_into_cluster_id") REFERENCES "public"."problem_cluster"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_cluster_merge_proposal" ADD CONSTRAINT "problem_cluster_merge_proposal_source_cluster_id_problem_cluster_id_fk" FOREIGN KEY ("source_cluster_id") REFERENCES "public"."problem_cluster"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_cluster_merge_proposal" ADD CONSTRAINT "problem_cluster_merge_proposal_target_cluster_id_problem_cluster_id_fk" FOREIGN KEY ("target_cluster_id") REFERENCES "public"."problem_cluster"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_cluster_merge_proposal" ADD CONSTRAINT "problem_cluster_merge_proposal_proposed_by_user_id_user_id_fk" FOREIGN KEY ("proposed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_cluster_merge_proposal" ADD CONSTRAINT "problem_cluster_merge_proposal_decided_by_user_id_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_cluster_project_link" ADD CONSTRAINT "problem_cluster_project_link_cluster_id_problem_cluster_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."problem_cluster"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_cluster_project_link" ADD CONSTRAINT "problem_cluster_project_link_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_cluster_project_link" ADD CONSTRAINT "problem_cluster_project_link_linked_by_user_id_user_id_fk" FOREIGN KEY ("linked_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_cluster_score_snapshot" ADD CONSTRAINT "problem_cluster_score_snapshot_cluster_id_problem_cluster_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."problem_cluster"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_submission" ADD CONSTRAINT "problem_submission_reporter_user_id_user_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_submission" ADD CONSTRAINT "problem_submission_category_id_research_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."research_category"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_submission" ADD CONSTRAINT "problem_submission_region_id_discovery_region_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."discovery_region"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_submission" ADD CONSTRAINT "problem_submission_cluster_id_problem_cluster_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."problem_cluster"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_compensation_ask" ADD CONSTRAINT "talent_compensation_ask_talent_profile_user_id_talent_profile_user_id_fk" FOREIGN KEY ("talent_profile_user_id") REFERENCES "public"."talent_profile"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_profile" ADD CONSTRAINT "talent_profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_profile" ADD CONSTRAINT "talent_profile_region_id_discovery_region_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."discovery_region"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_profile_skill" ADD CONSTRAINT "talent_profile_skill_talent_profile_user_id_talent_profile_user_id_fk" FOREIGN KEY ("talent_profile_user_id") REFERENCES "public"."talent_profile"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_profile_skill" ADD CONSTRAINT "talent_profile_skill_skill_id_discovery_skill_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."discovery_skill"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "demand_signal_snapshot_asOf_cell_unq" ON "demand_signal_snapshot" USING btree ("as_of","category_id","region_id");--> statement-breakpoint
CREATE UNIQUE INDEX "demand_signal_snapshot_asOf_rank_unq" ON "demand_signal_snapshot" USING btree ("as_of","rank");--> statement-breakpoint
CREATE INDEX "demand_signal_snapshot_cell_asOf_idx" ON "demand_signal_snapshot" USING btree ("category_id","region_id","as_of","id");--> statement-breakpoint
CREATE UNIQUE INDEX "discovery_region_slug_unq" ON "discovery_region" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "discovery_region_countryCode_unq" ON "discovery_region" USING btree ("country_code") WHERE country_code IS NOT NULL;--> statement-breakpoint
CREATE INDEX "discovery_region_parentRegionId_idx" ON "discovery_region" USING btree ("parent_region_id");--> statement-breakpoint
CREATE INDEX "discovery_region_kind_idx" ON "discovery_region" USING btree ("kind");--> statement-breakpoint
CREATE UNIQUE INDEX "discovery_skill_slug_unq" ON "discovery_skill" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "discovery_skill_categoryId_idx" ON "discovery_skill" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "discovery_skill_active_label_idx" ON "discovery_skill" USING btree ("label","id") WHERE is_active;--> statement-breakpoint
CREATE INDEX "geocode_cache_countryCode_idx" ON "geocode_cache" USING btree ("country_code");--> statement-breakpoint
CREATE INDEX "geocode_cache_status_idx" ON "geocode_cache" USING btree ("status");--> statement-breakpoint
CREATE INDEX "job_failure_unresolved_idx" ON "job_failure" USING btree ("failed_at","id") WHERE resolved_at IS NULL;--> statement-breakpoint
CREATE INDEX "job_failure_queueName_failedAt_idx" ON "job_failure" USING btree ("queue_name","failed_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_failure_sourceJobId_unq" ON "job_failure" USING btree ("source_job_id");--> statement-breakpoint
CREATE INDEX "market_insight_published_idx" ON "market_insight" USING btree ("published_at","id") WHERE published_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX "market_insight_region_published_idx" ON "market_insight" USING btree ("region_id","published_at","id") WHERE published_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX "market_insight_category_published_idx" ON "market_insight" USING btree ("category_id","published_at","id") WHERE published_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX "problem_cluster_active_score_idx" ON "problem_cluster" USING btree ("current_opportunity_score_points","id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "problem_cluster_active_bbox_idx" ON "problem_cluster" USING btree ("centroid_latitude_microdegrees","centroid_longitude_microdegrees") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "problem_cluster_category_score_idx" ON "problem_cluster" USING btree ("category_id","current_opportunity_score_points","id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "problem_cluster_region_score_idx" ON "problem_cluster" USING btree ("region_id","current_opportunity_score_points","id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "problem_cluster_mergedIntoClusterId_idx" ON "problem_cluster" USING btree ("merged_into_cluster_id");--> statement-breakpoint
CREATE INDEX "problem_cluster_merge_proposal_pending_idx" ON "problem_cluster_merge_proposal" USING btree ("created_at","id") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "problem_cluster_merge_proposal_sourceClusterId_idx" ON "problem_cluster_merge_proposal" USING btree ("source_cluster_id");--> statement-breakpoint
CREATE INDEX "problem_cluster_merge_proposal_targetClusterId_idx" ON "problem_cluster_merge_proposal" USING btree ("target_cluster_id");--> statement-breakpoint
CREATE INDEX "problem_cluster_project_link_projectId_idx" ON "problem_cluster_project_link" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "problem_cluster_project_link_origin_unq" ON "problem_cluster_project_link" USING btree ("project_id") WHERE source = 'origin';--> statement-breakpoint
CREATE UNIQUE INDEX "problem_cluster_score_snapshot_clusterId_asOf_unq" ON "problem_cluster_score_snapshot" USING btree ("cluster_id","as_of");--> statement-breakpoint
CREATE INDEX "problem_cluster_score_snapshot_clusterId_asOf_idx" ON "problem_cluster_score_snapshot" USING btree ("cluster_id","as_of","id");--> statement-breakpoint
CREATE INDEX "problem_cluster_score_snapshot_asOf_idx" ON "problem_cluster_score_snapshot" USING btree ("as_of","id");--> statement-breakpoint
CREATE INDEX "problem_submission_clusterId_createdAt_idx" ON "problem_submission" USING btree ("cluster_id","created_at","id");--> statement-breakpoint
CREATE INDEX "problem_submission_reporterUserId_createdAt_idx" ON "problem_submission" USING btree ("reporter_user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "problem_submission_queued_idx" ON "problem_submission" USING btree ("created_at","id") WHERE status = 'queued';--> statement-breakpoint
CREATE INDEX "problem_submission_category_bbox_idx" ON "problem_submission" USING btree ("category_id","latitude_microdegrees","longitude_microdegrees");--> statement-breakpoint
CREATE INDEX "problem_submission_regionId_idx" ON "problem_submission" USING btree ("region_id");--> statement-breakpoint
CREATE UNIQUE INDEX "talent_compensation_ask_userId_kind_unq" ON "talent_compensation_ask" USING btree ("talent_profile_user_id","kind");--> statement-breakpoint
CREATE INDEX "talent_compensation_ask_kind_equityMin_idx" ON "talent_compensation_ask" USING btree ("kind","equity_basis_points_min");--> statement-breakpoint
CREATE INDEX "talent_compensation_ask_kind_salaryMin_idx" ON "talent_compensation_ask" USING btree ("kind","salary_min_in_cents_per_month");--> statement-breakpoint
CREATE INDEX "talent_profile_published_idx" ON "talent_profile" USING btree ("availability","commitment","updated_at","user_id") WHERE visibility = 'published';--> statement-breakpoint
CREATE INDEX "talent_profile_published_region_idx" ON "talent_profile" USING btree ("region_id","updated_at","user_id") WHERE visibility = 'published';--> statement-breakpoint
CREATE INDEX "talent_profile_regionId_idx" ON "talent_profile" USING btree ("region_id");--> statement-breakpoint
CREATE INDEX "talent_profile_skill_skillId_idx" ON "talent_profile_skill" USING btree ("skill_id");-- ===========================================================================
-- HAND-APPENDED (R&D Phase 5 — §6 Discovery). Everything below is what Drizzle
-- cannot express. Partial unique indexes and CHECK constraints are NOT here:
-- drizzle-kit 0.31.10 emits both (verified in the generated statements above),
-- so re-adding them would fail on duplicate names.
-- ===========================================================================

-- 1. APPEND-ONLY ENFORCEMENT (R_AND_D_BACKEND_STRUCTURE.md §4f).
-- Both score-snapshot tables are job-written history: a score is evidence of
-- what the formula produced at an `as_of`, and editing one retroactively
-- rewrites a published ranking with no trace. Corrections are a NEW snapshot at
-- a later as_of, never an UPDATE.
--
-- qatoto_reject_mutation() already exists from 0010 and is CREATE OR REPLACE
-- there, so this migration only attaches triggers to it — exactly as 0010's own
-- comment anticipated for the sections that came later.
DROP TRIGGER IF EXISTS problem_cluster_score_snapshot_append_only ON "problem_cluster_score_snapshot";
--> statement-breakpoint
CREATE TRIGGER problem_cluster_score_snapshot_append_only
BEFORE UPDATE OR DELETE ON "problem_cluster_score_snapshot"
FOR EACH ROW EXECUTE FUNCTION qatoto_reject_mutation();
--> statement-breakpoint
-- A BEFORE UPDATE OR DELETE *row* trigger does NOT fire on TRUNCATE.
DROP TRIGGER IF EXISTS problem_cluster_score_snapshot_no_truncate ON "problem_cluster_score_snapshot";
--> statement-breakpoint
CREATE TRIGGER problem_cluster_score_snapshot_no_truncate
BEFORE TRUNCATE ON "problem_cluster_score_snapshot"
FOR EACH STATEMENT EXECUTE FUNCTION qatoto_reject_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS demand_signal_snapshot_append_only ON "demand_signal_snapshot";
--> statement-breakpoint
CREATE TRIGGER demand_signal_snapshot_append_only
BEFORE UPDATE OR DELETE ON "demand_signal_snapshot"
FOR EACH ROW EXECUTE FUNCTION qatoto_reject_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS demand_signal_snapshot_no_truncate ON "demand_signal_snapshot";
--> statement-breakpoint
CREATE TRIGGER demand_signal_snapshot_no_truncate
BEFORE TRUNCATE ON "demand_signal_snapshot"
FOR EACH STATEMENT EXECUTE FUNCTION qatoto_reject_mutation();
--> statement-breakpoint

-- 2. THE UNORDERED-PAIR MERGE GUARD.
-- Drizzle cannot express this: it indexes LEAST/GREATEST EXPRESSIONS, not
-- columns. Without it, a proposal to merge A into B and a second proposal to
-- merge B into A both sit in the moderator queue as distinct rows, and both can
-- be approved — the second one against a cluster the first already dissolved.
CREATE UNIQUE INDEX "problem_cluster_merge_proposal_open_pair_unq"
  ON "problem_cluster_merge_proposal"
  (LEAST("source_cluster_id", "target_cluster_id"), GREATEST("source_cluster_id", "target_cluster_id"))
  WHERE status = 'pending';
--> statement-breakpoint

-- 3. REVOKE on the new append-only tables, inside 0010's existing role guard.
-- Same honest caveat as 0010: REVOKE has NO effect on a table's OWNER, and
-- DATABASE_URL connects as the owner today, so the TRIGGERS above are the real
-- enforcement. This block becomes load-bearing the day a non-owner `qatoto_app`
-- role exists, with no migration change.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qatoto_app') THEN
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "problem_cluster_score_snapshot" FROM qatoto_app';
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "demand_signal_snapshot" FROM qatoto_app';
  END IF;
END $$;
--> statement-breakpoint

-- 4. BACKFILL pin_icon_key ON THE SEEDED TAXONOMY.
-- drizzle-kit never emits data DML, and the column landed NOT NULL DEFAULT
-- 'other', so without this every seeded category renders the fallback pin.
-- MUST stay byte-identical to BASELINE_RESEARCH_CATEGORIES in
-- src/db/seed-data.ts.
UPDATE "research_category" SET "pin_icon_key" = 'agriculture'   WHERE "slug" = 'agriculture';
--> statement-breakpoint
UPDATE "research_category" SET "pin_icon_key" = 'energy'        WHERE "slug" = 'clean-energy';
--> statement-breakpoint
UPDATE "research_category" SET "pin_icon_key" = 'health'        WHERE "slug" = 'healthcare';
--> statement-breakpoint
UPDATE "research_category" SET "pin_icon_key" = 'housing'       WHERE "slug" = 'housing';
--> statement-breakpoint
UPDATE "research_category" SET "pin_icon_key" = 'transport'     WHERE "slug" = 'logistics';
--> statement-breakpoint
UPDATE "research_category" SET "pin_icon_key" = 'manufacturing' WHERE "slug" = 'manufacturing';
--> statement-breakpoint
UPDATE "research_category" SET "pin_icon_key" = 'water'         WHERE "slug" = 'water-sanitation';
--> statement-breakpoint
UPDATE "research_category" SET "pin_icon_key" = 'waste'         WHERE "slug" = 'waste-recycling';
--> statement-breakpoint

-- 5. SEED THE REGION TREE. NOT sample data, the same class as 0010's taxonomy:
-- market_insight.region_id and demand_signal_snapshot.region_id are both
-- NOT NULL ON DELETE RESTRICT, so a freshly migrated database cannot accept a
-- single insight or leaderboard row without these. Literal UUIDs so every
-- environment agrees, and MUST stay byte-identical to
-- BASELINE_DISCOVERY_REGIONS in src/db/seed-data.ts.
--
-- Three levels: one global root, macro regions the knowledge hub groups by, and
-- the countries reverse geocoding lands on. Countries carry ISO 3166-1 alpha-2;
-- nothing else does, enforced by discovery_region_country_ck.
INSERT INTO "discovery_region" ("id", "slug", "label", "kind", "parent_region_id", "country_code")
VALUES
  ('b3d2f8a1-0000-4000-8000-000000000001', 'global',         'Global',          'global',       NULL,                                   NULL),
  ('b3d2f8a1-0000-4000-8000-000000000010', 'east-africa',    'East Africa',     'macro_region', 'b3d2f8a1-0000-4000-8000-000000000001', NULL),
  ('b3d2f8a1-0000-4000-8000-000000000011', 'west-africa',    'West Africa',     'macro_region', 'b3d2f8a1-0000-4000-8000-000000000001', NULL),
  ('b3d2f8a1-0000-4000-8000-000000000012', 'south-asia',     'South Asia',      'macro_region', 'b3d2f8a1-0000-4000-8000-000000000001', NULL),
  ('b3d2f8a1-0000-4000-8000-000000000013', 'southeast-asia', 'Southeast Asia',  'macro_region', 'b3d2f8a1-0000-4000-8000-000000000001', NULL),
  ('b3d2f8a1-0000-4000-8000-000000000014', 'latin-america',  'Latin America',   'macro_region', 'b3d2f8a1-0000-4000-8000-000000000001', NULL),
  ('b3d2f8a1-0000-4000-8000-000000000015', 'middle-east',    'Middle East',     'macro_region', 'b3d2f8a1-0000-4000-8000-000000000001', NULL),
  ('b3d2f8a1-0000-4000-8000-000000000016', 'europe',         'Europe',          'macro_region', 'b3d2f8a1-0000-4000-8000-000000000001', NULL),
  ('b3d2f8a1-0000-4000-8000-000000000017', 'north-america',  'North America',   'macro_region', 'b3d2f8a1-0000-4000-8000-000000000001', NULL),
  ('b3d2f8a1-0000-4000-8000-000000000018', 'oceania',        'Oceania',         'macro_region', 'b3d2f8a1-0000-4000-8000-000000000001', NULL),
  ('b3d2f8a1-0000-4000-8000-000000000020', 'kenya',          'Kenya',           'country',      'b3d2f8a1-0000-4000-8000-000000000010', 'KE'),
  ('b3d2f8a1-0000-4000-8000-000000000021', 'tanzania',       'Tanzania',        'country',      'b3d2f8a1-0000-4000-8000-000000000010', 'TZ'),
  ('b3d2f8a1-0000-4000-8000-000000000022', 'uganda',         'Uganda',          'country',      'b3d2f8a1-0000-4000-8000-000000000010', 'UG'),
  ('b3d2f8a1-0000-4000-8000-000000000023', 'ethiopia',       'Ethiopia',        'country',      'b3d2f8a1-0000-4000-8000-000000000010', 'ET'),
  ('b3d2f8a1-0000-4000-8000-000000000024', 'nigeria',        'Nigeria',         'country',      'b3d2f8a1-0000-4000-8000-000000000011', 'NG'),
  ('b3d2f8a1-0000-4000-8000-000000000025', 'ghana',          'Ghana',           'country',      'b3d2f8a1-0000-4000-8000-000000000011', 'GH'),
  ('b3d2f8a1-0000-4000-8000-000000000026', 'senegal',        'Senegal',         'country',      'b3d2f8a1-0000-4000-8000-000000000011', 'SN'),
  ('b3d2f8a1-0000-4000-8000-000000000027', 'india',          'India',           'country',      'b3d2f8a1-0000-4000-8000-000000000012', 'IN'),
  ('b3d2f8a1-0000-4000-8000-000000000028', 'bangladesh',     'Bangladesh',      'country',      'b3d2f8a1-0000-4000-8000-000000000012', 'BD'),
  ('b3d2f8a1-0000-4000-8000-000000000029', 'pakistan',       'Pakistan',        'country',      'b3d2f8a1-0000-4000-8000-000000000012', 'PK'),
  ('b3d2f8a1-0000-4000-8000-000000000030', 'nepal',          'Nepal',           'country',      'b3d2f8a1-0000-4000-8000-000000000012', 'NP'),
  ('b3d2f8a1-0000-4000-8000-000000000031', 'indonesia',      'Indonesia',       'country',      'b3d2f8a1-0000-4000-8000-000000000013', 'ID'),
  ('b3d2f8a1-0000-4000-8000-000000000032', 'philippines',    'Philippines',     'country',      'b3d2f8a1-0000-4000-8000-000000000013', 'PH'),
  ('b3d2f8a1-0000-4000-8000-000000000033', 'vietnam',        'Vietnam',         'country',      'b3d2f8a1-0000-4000-8000-000000000013', 'VN'),
  ('b3d2f8a1-0000-4000-8000-000000000034', 'peru',           'Peru',            'country',      'b3d2f8a1-0000-4000-8000-000000000014', 'PE'),
  ('b3d2f8a1-0000-4000-8000-000000000035', 'brazil',         'Brazil',          'country',      'b3d2f8a1-0000-4000-8000-000000000014', 'BR'),
  ('b3d2f8a1-0000-4000-8000-000000000036', 'colombia',       'Colombia',        'country',      'b3d2f8a1-0000-4000-8000-000000000014', 'CO'),
  ('b3d2f8a1-0000-4000-8000-000000000037', 'mexico',         'Mexico',          'country',      'b3d2f8a1-0000-4000-8000-000000000014', 'MX')
ON CONFLICT ("slug") DO NOTHING;
--> statement-breakpoint

-- 6. SEED THE SKILL VOCABULARY. Same precondition argument:
-- talent_profile_skill.skill_id is NOT NULL ON DELETE RESTRICT, so a talent
-- profile cannot list a skill that does not exist here. This is also THE fix for
-- the substring-match bug in talent-filter-grid.tsx — a "Water" chip can only
-- match the `water-quality` slug, never "Water Polo".
-- MUST stay byte-identical to BASELINE_DISCOVERY_SKILLS in src/db/seed-data.ts.
INSERT INTO "discovery_skill" ("id", "slug", "label", "category_id", "is_active")
VALUES
  ('c4e3a9b2-0000-4000-8000-000000000001', 'firmware',            'Firmware',              NULL,                                   true),
  ('c4e3a9b2-0000-4000-8000-000000000002', 'sensor-networks',     'Sensor Networks',       NULL,                                   true),
  ('c4e3a9b2-0000-4000-8000-000000000003', 'power-electronics',   'Power Electronics',     'a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a02', true),
  ('c4e3a9b2-0000-4000-8000-000000000004', 'membrane-filtration', 'Membrane Filtration',   'a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a07', true),
  ('c4e3a9b2-0000-4000-8000-000000000005', 'water-quality',       'Water Quality',         'a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a07', true),
  ('c4e3a9b2-0000-4000-8000-000000000006', 'lab-validation',      'Lab Validation',        NULL,                                   true),
  ('c4e3a9b2-0000-4000-8000-000000000007', 'flight-control',      'Flight Control',        NULL,                                   true),
  ('c4e3a9b2-0000-4000-8000-000000000008', 'computer-vision',     'Computer Vision',       NULL,                                   true),
  ('c4e3a9b2-0000-4000-8000-000000000009', 'precision-farming',   'Precision Farming',     'a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a01', true),
  ('c4e3a9b2-0000-4000-8000-000000000010', 'refrigeration',       'Refrigeration',         'a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a05', true),
  ('c4e3a9b2-0000-4000-8000-000000000011', 'cold-chain-logistics','Cold Chain Logistics',  'a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a05', true),
  ('c4e3a9b2-0000-4000-8000-000000000012', 'solar-pv',            'Solar PV',              'a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a02', true),
  ('c4e3a9b2-0000-4000-8000-000000000013', 'battery-systems',     'Battery Systems',       'a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a02', true),
  ('c4e3a9b2-0000-4000-8000-000000000014', 'structural-design',   'Structural Design',     'a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a04', true),
  ('c4e3a9b2-0000-4000-8000-000000000015', 'prefab-construction', 'Prefab Construction',   'a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a04', true),
  ('c4e3a9b2-0000-4000-8000-000000000016', 'medical-devices',     'Medical Devices',       'a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a03', true),
  ('c4e3a9b2-0000-4000-8000-000000000017', 'diagnostics',         'Diagnostics',           'a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a03', true),
  ('c4e3a9b2-0000-4000-8000-000000000018', 'supply-chain',        'Supply Chain',          'a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a05', true),
  ('c4e3a9b2-0000-4000-8000-000000000019', 'materials-recovery',  'Materials Recovery',    'a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a08', true),
  ('c4e3a9b2-0000-4000-8000-000000000020', 'industrial-design',   'Industrial Design',     'a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a06', true),
  ('c4e3a9b2-0000-4000-8000-000000000021', 'embedded-linux',      'Embedded Linux',        NULL,                                   true),
  ('c4e3a9b2-0000-4000-8000-000000000022', 'mechanical-design',   'Mechanical Design',     'a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a06', true),
  ('c4e3a9b2-0000-4000-8000-000000000023', 'field-operations',    'Field Operations',      NULL,                                   true),
  ('c4e3a9b2-0000-4000-8000-000000000024', 'data-analysis',       'Data Analysis',         NULL,                                   true)
ON CONFLICT ("slug") DO NOTHING;
