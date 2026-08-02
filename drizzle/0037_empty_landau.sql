ALTER TABLE "video_stats" DROP CONSTRAINT "video_stats_counters_non_negative_ck";--> statement-breakpoint
ALTER TABLE "video_stats" ADD COLUMN "counted_views_first_48_hours" integer;--> statement-breakpoint
ALTER TABLE "video_stats" ADD CONSTRAINT "video_stats_counters_non_negative_ck" CHECK (view_count >= 0 AND like_count >= 0 AND comment_count >= 0
          AND share_count >= 0 AND save_count >= 0
          AND total_watched_seconds >= 0 AND completion_bp_sum >= 0
          AND completion_sample_count >= 0
          AND (unique_viewer_count IS NULL OR unique_viewer_count >= 0)
          AND (counted_views_first_48_hours IS NULL OR counted_views_first_48_hours >= 0));