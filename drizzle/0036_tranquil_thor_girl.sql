CREATE TABLE "platform_category_popularity_snapshot" (
	"id" text PRIMARY KEY NOT NULL,
	"category_id" text NOT NULL,
	"as_of" timestamp NOT NULL,
	"popularity_points" integer NOT NULL,
	"counted_view_count" integer NOT NULL,
	"published_video_count" integer NOT NULL,
	"score_algorithm_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "platform_category_popularity_snapshot_ck" CHECK (popularity_points BETWEEN 0 AND 100
          AND counted_view_count >= 0 AND published_video_count >= 0)
);
--> statement-breakpoint
CREATE TABLE "trending_video_snapshot" (
	"id" text PRIMARY KEY NOT NULL,
	"video_id" text NOT NULL,
	"as_of" timestamp NOT NULL,
	"rank" integer NOT NULL,
	"trending_score_points" integer NOT NULL,
	"counted_views_in_window" integer NOT NULL,
	"watched_minutes_in_window" integer NOT NULL,
	"engagement_actions_in_window" integer NOT NULL,
	"quality_score_points" integer,
	"recent_view_component_points" integer NOT NULL,
	"recent_watch_time_component_points" integer NOT NULL,
	"recent_engagement_component_points" integer NOT NULL,
	"quality_component_points" integer NOT NULL,
	"score_algorithm_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "trending_video_snapshot_score_ck" CHECK (rank >= 1
          AND trending_score_points BETWEEN 0 AND 100
          AND recent_view_component_points >= 0 AND recent_watch_time_component_points >= 0
          AND recent_engagement_component_points >= 0 AND quality_component_points >= 0
          AND recent_view_component_points + recent_watch_time_component_points
              + recent_engagement_component_points + quality_component_points
              = trending_score_points
          AND counted_views_in_window >= 0 AND watched_minutes_in_window >= 0
          AND engagement_actions_in_window >= 0
          AND (quality_score_points IS NULL OR quality_score_points BETWEEN 0 AND 100))
);
--> statement-breakpoint
CREATE TABLE "user_creator_affinity_snapshot" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"creator_id" text NOT NULL,
	"as_of" timestamp NOT NULL,
	"affinity_points" integer NOT NULL,
	"counted_view_count" integer NOT NULL,
	"mean_completion_basis_points" integer NOT NULL,
	"explicit_signal_count" integer NOT NULL,
	"watch_count_component_points" integer NOT NULL,
	"mean_completion_component_points" integer NOT NULL,
	"explicit_signal_component_points" integer NOT NULL,
	"score_algorithm_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_creator_affinity_snapshot_self_ck" CHECK (user_id <> creator_id),
	CONSTRAINT "user_creator_affinity_snapshot_score_ck" CHECK (affinity_points BETWEEN 0 AND 100
          AND watch_count_component_points >= 0 AND mean_completion_component_points >= 0
          AND explicit_signal_component_points >= 0
          AND watch_count_component_points + mean_completion_component_points
              + explicit_signal_component_points = affinity_points
          AND counted_view_count >= 0
          AND mean_completion_basis_points BETWEEN 0 AND 10000
          AND explicit_signal_count >= 0)
);
--> statement-breakpoint
CREATE TABLE "user_topic_affinity_snapshot" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"category_id" text NOT NULL,
	"as_of" timestamp NOT NULL,
	"affinity_points" integer NOT NULL,
	"counted_view_count" integer NOT NULL,
	"mean_completion_basis_points" integer NOT NULL,
	"explicit_signal_count" integer NOT NULL,
	"watch_count_component_points" integer NOT NULL,
	"mean_completion_component_points" integer NOT NULL,
	"explicit_signal_component_points" integer NOT NULL,
	"score_algorithm_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_topic_affinity_snapshot_score_ck" CHECK (affinity_points BETWEEN 0 AND 100
          AND watch_count_component_points >= 0 AND mean_completion_component_points >= 0
          AND explicit_signal_component_points >= 0
          AND watch_count_component_points + mean_completion_component_points
              + explicit_signal_component_points = affinity_points
          AND counted_view_count >= 0
          AND mean_completion_basis_points BETWEEN 0 AND 10000
          AND explicit_signal_count >= 0)
);
--> statement-breakpoint
CREATE TABLE "video_quality_score_snapshot" (
	"id" text PRIMARY KEY NOT NULL,
	"video_id" text NOT NULL,
	"as_of" timestamp NOT NULL,
	"quality_score_points" integer NOT NULL,
	"mean_completion_basis_points" integer NOT NULL,
	"completion_sample_count" integer NOT NULL,
	"engagement_per_thousand_viewers" integer NOT NULL,
	"unique_viewer_count" integer,
	"counted_views_first_48_hours" integer NOT NULL,
	"creator_median_quality_points" integer,
	"hours_since_published" integer NOT NULL,
	"completion_component_points" integer NOT NULL,
	"engagement_component_points" integer NOT NULL,
	"velocity_component_points" integer NOT NULL,
	"creator_track_component_points" integer NOT NULL,
	"freshness_component_points" integer NOT NULL,
	"score_algorithm_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "video_quality_score_snapshot_score_ck" CHECK (quality_score_points BETWEEN 0 AND 100
          AND completion_component_points >= 0 AND engagement_component_points >= 0
          AND velocity_component_points >= 0 AND creator_track_component_points >= 0
          AND freshness_component_points >= 0
          AND completion_component_points + engagement_component_points
              + velocity_component_points + creator_track_component_points
              + freshness_component_points = quality_score_points),
	CONSTRAINT "video_quality_score_snapshot_inputs_ck" CHECK (mean_completion_basis_points BETWEEN 0 AND 10000
          AND completion_sample_count >= 0
          AND engagement_per_thousand_viewers >= 0
          AND (unique_viewer_count IS NULL OR unique_viewer_count >= 0)
          AND counted_views_first_48_hours >= 0
          AND (creator_median_quality_points IS NULL
               OR creator_median_quality_points BETWEEN 0 AND 100)
          AND hours_since_published >= 0)
);
--> statement-breakpoint
ALTER TABLE "video_stats" ADD COLUMN "quality_score_points" integer;--> statement-breakpoint
ALTER TABLE "video_stats" ADD COLUMN "quality_score_computed_at" timestamp;--> statement-breakpoint
ALTER TABLE "video_stats" ADD COLUMN "trending_rank" integer;--> statement-breakpoint
ALTER TABLE "platform_category_popularity_snapshot" ADD CONSTRAINT "platform_category_popularity_snapshot_category_id_content_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."content_category"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trending_video_snapshot" ADD CONSTRAINT "trending_video_snapshot_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_creator_affinity_snapshot" ADD CONSTRAINT "user_creator_affinity_snapshot_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_creator_affinity_snapshot" ADD CONSTRAINT "user_creator_affinity_snapshot_creator_id_user_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_topic_affinity_snapshot" ADD CONSTRAINT "user_topic_affinity_snapshot_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_topic_affinity_snapshot" ADD CONSTRAINT "user_topic_affinity_snapshot_category_id_content_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."content_category"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_quality_score_snapshot" ADD CONSTRAINT "video_quality_score_snapshot_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_category_popularity_snapshot_unq" ON "platform_category_popularity_snapshot" USING btree ("category_id","as_of");--> statement-breakpoint
CREATE INDEX "platform_category_popularity_snapshot_asOf_idx" ON "platform_category_popularity_snapshot" USING btree ("as_of","category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trending_video_snapshot_video_unq" ON "trending_video_snapshot" USING btree ("as_of","video_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trending_video_snapshot_rank_unq" ON "trending_video_snapshot" USING btree ("as_of","rank");--> statement-breakpoint
CREATE UNIQUE INDEX "user_creator_affinity_snapshot_unq" ON "user_creator_affinity_snapshot" USING btree ("user_id","creator_id","as_of");--> statement-breakpoint
CREATE INDEX "user_creator_affinity_snapshot_viewer_idx" ON "user_creator_affinity_snapshot" USING btree ("user_id","as_of","creator_id");--> statement-breakpoint
CREATE INDEX "user_creator_affinity_snapshot_asOf_idx" ON "user_creator_affinity_snapshot" USING btree ("as_of","id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_topic_affinity_snapshot_unq" ON "user_topic_affinity_snapshot" USING btree ("user_id","category_id","as_of");--> statement-breakpoint
CREATE INDEX "user_topic_affinity_snapshot_viewer_idx" ON "user_topic_affinity_snapshot" USING btree ("user_id","as_of","category_id");--> statement-breakpoint
CREATE INDEX "user_topic_affinity_snapshot_asOf_idx" ON "user_topic_affinity_snapshot" USING btree ("as_of","id");--> statement-breakpoint
CREATE UNIQUE INDEX "video_quality_score_snapshot_unq" ON "video_quality_score_snapshot" USING btree ("video_id","as_of");--> statement-breakpoint
CREATE INDEX "video_quality_score_snapshot_asOf_idx" ON "video_quality_score_snapshot" USING btree ("as_of","id");--> statement-breakpoint
ALTER TABLE "video_stats" ADD CONSTRAINT "video_stats_score_range_ck" CHECK ((quality_score_points IS NULL OR quality_score_points BETWEEN 0 AND 100)
          AND (quality_score_points IS NULL) = (quality_score_computed_at IS NULL)
          AND (trending_rank IS NULL OR trending_rank >= 1));