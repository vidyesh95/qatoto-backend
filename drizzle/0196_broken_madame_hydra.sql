ALTER TABLE "anime_episode" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "anime_season" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "anime_series" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "content_review_action" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "anime_episode" CASCADE;--> statement-breakpoint
DROP TABLE "anime_season" CASCADE;--> statement-breakpoint
DROP TABLE "anime_series" CASCADE;--> statement-breakpoint
DROP TABLE "content_review_action" CASCADE;--> statement-breakpoint
ALTER TABLE "anime_hero_slide" RENAME TO "blueprint_hero_slide";--> statement-breakpoint
ALTER TABLE "blueprint_hero_slide" DROP CONSTRAINT "anime_hero_slide_position_ck";--> statement-breakpoint
ALTER TABLE "blueprint_hero_slide" DROP CONSTRAINT "anime_hero_slide_title_ck";--> statement-breakpoint
ALTER TABLE "blueprint_hero_slide" DROP CONSTRAINT "anime_hero_slide_image_url_ck";--> statement-breakpoint
ALTER TABLE "blueprint_hero_slide" DROP CONSTRAINT "anime_hero_slide_destination_ck";--> statement-breakpoint
ALTER TABLE "blueprint_hero_slide" DROP CONSTRAINT "anime_hero_slide_window_ck";--> statement-breakpoint
ALTER TABLE "blueprint_hero_slide" DROP CONSTRAINT "anime_hero_slide_created_by_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "blueprint_hero_slide" DROP CONSTRAINT "anime_hero_slide_updated_by_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "platform_audit_entry" ALTER COLUMN "event_kind" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."platform_audit_event_kind";--> statement-breakpoint
CREATE TYPE "public"."platform_audit_event_kind" AS ENUM('taxonomy_category_approved', 'taxonomy_category_rejected', 'cluster_merge_approved', 'cluster_merge_rejected', 'discovery_skill_created', 'discovery_skill_updated', 'discovery_skill_deleted', 'discovery_region_created', 'discovery_region_updated', 'discovery_region_deleted', 'market_insight_created', 'market_insight_updated', 'market_insight_deleted', 'market_insight_published', 'market_insight_unpublished', 'supplier_created', 'supplier_updated', 'content_review_approved', 'content_review_rejected', 'platform_role_granted', 'platform_role_revoked', 'research_program_published', 'research_program_rejected', 'research_program_paper_approved', 'research_program_paper_rejected', 'research_program_paper_needs_changes', 'research_program_post_hidden', 'research_program_post_restored', 'research_program_report_dismissed', 'pitch_published', 'pitch_rejected', 'promotional_slide_created', 'promotional_slide_updated', 'promotional_slide_reordered', 'promotional_slide_image_replaced', 'promotional_slide_deleted', 'spotlight_slots_replaced', 'anime_hero_slide_created', 'anime_hero_slide_updated', 'anime_hero_slide_reordered', 'anime_hero_slide_image_replaced', 'anime_hero_slide_deleted', 'blueprint_hero_slide_created', 'blueprint_hero_slide_updated', 'blueprint_hero_slide_reordered', 'blueprint_hero_slide_image_replaced', 'blueprint_hero_slide_deleted', 'showcase_launch_published', 'showcase_launch_rejected', 'case_study_published', 'case_study_rejected', 'teardown_published', 'teardown_rejected', 'blueprint_content_flagged', 'blueprint_content_quarantined', 'blueprint_content_restored', 'blueprint_content_report_dismissed', 'commerce_content_hidden', 'commerce_content_restored', 'commerce_content_report_dismissed', 'commerce_product_moderation_state_changed', 'commerce_category_created', 'commerce_category_updated', 'commerce_category_reordered', 'commerce_category_image_replaced', 'commerce_category_retired', 'commerce_category_request_approved', 'commerce_category_request_rejected', 'commerce_category_attribute_created', 'commerce_category_attribute_updated', 'commerce_category_attribute_request_approved', 'commerce_category_attribute_request_rejected', 'commerce_organization_site_audit_recorded', 'commerce_organization_site_audit_withdrawn', 'community_forum_thread_published', 'community_forum_thread_rejected', 'community_forum_thread_locked', 'community_forum_thread_unlocked', 'community_forum_reply_hidden', 'community_forum_reply_restored', 'community_content_report_dismissed', 'community_cofounder_profile_published', 'community_cofounder_profile_rejected', 'commerce_freight_rate_card_created', 'commerce_freight_rate_card_window_shortened', 'commerce_freight_rate_card_withdrawn', 'commerce_freight_rate_break_added', 'commerce_freight_rate_breaks_replaced', 'commerce_customs_dwell_estimate_created', 'commerce_customs_dwell_estimate_retired', 'platform_metrics_user_segment_viewed', 'video_content_hidden', 'video_content_restored', 'video_content_report_dismissed', 'user_profile_text_hidden', 'user_profile_text_restored', 'user_report_dismissed', 'support_case_resolved', 'support_case_closed', 'chargeback_evidence_exported');--> statement-breakpoint
ALTER TABLE "platform_audit_entry" ALTER COLUMN "event_kind" SET DATA TYPE "public"."platform_audit_event_kind" USING "event_kind"::"public"."platform_audit_event_kind";--> statement-breakpoint
ALTER TABLE "video" ALTER COLUMN "video_type" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "video" ALTER COLUMN "video_type" SET DEFAULT 'demo'::text;--> statement-breakpoint
DROP TYPE "public"."video_type";--> statement-breakpoint
CREATE TYPE "public"."video_type" AS ENUM('pitch', 'demo', 'update', 'ama');--> statement-breakpoint
ALTER TABLE "video" ALTER COLUMN "video_type" SET DEFAULT 'demo'::"public"."video_type";--> statement-breakpoint
ALTER TABLE "video" ALTER COLUMN "video_type" SET DATA TYPE "public"."video_type" USING "video_type"::"public"."video_type";--> statement-breakpoint
DROP INDEX "anime_hero_slide_live_idx";--> statement-breakpoint
DROP INDEX "anime_hero_slide_position_idx";--> statement-breakpoint
DROP INDEX "video_reviewStatus_videoType_idx";--> statement-breakpoint
ALTER TABLE "blueprint_hero_slide" ADD CONSTRAINT "blueprint_hero_slide_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blueprint_hero_slide" ADD CONSTRAINT "blueprint_hero_slide_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blueprint_hero_slide_live_idx" ON "blueprint_hero_slide" USING btree ("position","id") WHERE is_active;--> statement-breakpoint
CREATE INDEX "blueprint_hero_slide_position_idx" ON "blueprint_hero_slide" USING btree ("position","id");--> statement-breakpoint
ALTER TABLE "blueprint_hero_slide" ADD CONSTRAINT "blueprint_hero_slide_position_ck" CHECK (position >= 0);--> statement-breakpoint
ALTER TABLE "blueprint_hero_slide" ADD CONSTRAINT "blueprint_hero_slide_title_ck" CHECK (char_length(title) BETWEEN 1 AND 160);--> statement-breakpoint
ALTER TABLE "blueprint_hero_slide" ADD CONSTRAINT "blueprint_hero_slide_image_url_ck" CHECK (char_length(image_url) BETWEEN 1 AND 2048
          AND image_url !~ '[[:space:][:cntrl:]]'
          AND (image_url LIKE 'https://%'
               OR (left(image_url, 1) = '/'
                   AND left(image_url, 2) <> '//'
                   AND left(image_url, 2) <> ('/' || chr(92)))));--> statement-breakpoint
ALTER TABLE "blueprint_hero_slide" ADD CONSTRAINT "blueprint_hero_slide_destination_ck" CHECK (destination_path IS NULL
          OR (char_length(destination_path) BETWEEN 1 AND 512
              AND left(destination_path, 1) = '/'
              AND left(destination_path, 2) <> '//'
              AND left(destination_path, 2) <> ('/' || chr(92))
              AND destination_path !~ '[[:space:][:cntrl:]]'));--> statement-breakpoint
ALTER TABLE "blueprint_hero_slide" ADD CONSTRAINT "blueprint_hero_slide_window_ck" CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at);--> statement-breakpoint
DROP TYPE "public"."anime_audio_mode";--> statement-breakpoint
DROP TYPE "public"."anime_series_status";--> statement-breakpoint
DROP TYPE "public"."content_review_action_kind";