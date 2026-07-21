CREATE TYPE "public"."anime_audio_mode" AS ENUM('subbed', 'dubbed');--> statement-breakpoint
CREATE TYPE "public"."anime_series_status" AS ENUM('ongoing', 'completed', 'hiatus');--> statement-breakpoint
CREATE TYPE "public"."content_review_action_kind" AS ENUM('approve', 'reject');--> statement-breakpoint
CREATE TYPE "public"."content_review_status" AS ENUM('not_required', 'pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."playlist_video_order" AS ENUM('date_published_newest', 'date_published_oldest', 'date_added_newest', 'date_added_oldest', 'manual');--> statement-breakpoint
CREATE TYPE "public"."playlist_visibility" AS ENUM('public', 'unlisted', 'private');--> statement-breakpoint
CREATE TYPE "public"."shorts_remix" AS ENUM('video_and_audio', 'audio_only');--> statement-breakpoint
CREATE TYPE "public"."storage_provider" AS ENUM('livepeer', 'cloudflare', 'imagekit', 'self_hosted');--> statement-breakpoint
CREATE TYPE "public"."video_collaborator_status" AS ENUM('invited', 'accepted', 'declined');--> statement-breakpoint
CREATE TYPE "public"."video_license" AS ENUM('standard', 'creative_commons');--> statement-breakpoint
CREATE TYPE "public"."video_publish_status" AS ENUM('draft', 'scheduled', 'published');--> statement-breakpoint
CREATE TYPE "public"."video_source" AS ENUM('youtube', 'hosted');--> statement-breakpoint
CREATE TYPE "public"."video_stage" AS ENUM('idea', 'mvp', 'scaling', 'shipped');--> statement-breakpoint
CREATE TYPE "public"."video_type" AS ENUM('pitch', 'demo', 'update', 'ama', 'anime_episode');--> statement-breakpoint
CREATE TYPE "public"."video_upload_status" AS ENUM('uploading', 'processing', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."video_visibility" AS ENUM('private', 'unlisted', 'public', 'investor_only');--> statement-breakpoint
CREATE TABLE "anime_episode" (
	"id" text PRIMARY KEY NOT NULL,
	"season_id" text NOT NULL,
	"video_id" text,
	"episode_number" integer NOT NULL,
	"episode_title" text NOT NULL,
	"is_premium" boolean DEFAULT false NOT NULL,
	"release_schedule_day" text,
	"release_schedule_time" text,
	"premiere_date" timestamp,
	"audio_mode" "anime_audio_mode",
	"audio_language" text,
	"age_rating" text,
	"released_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "anime_episode_number_ck" CHECK (episode_number >= 0)
);
--> statement-breakpoint
CREATE TABLE "anime_season" (
	"id" text PRIMARY KEY NOT NULL,
	"series_id" text NOT NULL,
	"season_label" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "anime_series" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"poster_url" text,
	"genre_tags" text[] DEFAULT '{}' NOT NULL,
	"status" "anime_series_status" DEFAULT 'ongoing' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "anime_series_genre_tags_ck" CHECK (cardinality(genre_tags) <= 20)
);
--> statement-breakpoint
CREATE TABLE "content_review_action" (
	"id" text PRIMARY KEY NOT NULL,
	"video_id" text NOT NULL,
	"reviewer_id" text NOT NULL,
	"action" "content_review_action_kind" NOT NULL,
	"reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "content_review_action_reason_ck" CHECK ((action <> 'reject') OR (reason IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "playlist" (
	"id" text PRIMARY KEY NOT NULL,
	"creator_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"visibility" "playlist_visibility" DEFAULT 'private' NOT NULL,
	"default_video_order" "playlist_video_order" DEFAULT 'date_published_newest' NOT NULL,
	"language" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playlist_item" (
	"id" text PRIMARY KEY NOT NULL,
	"playlist_id" text NOT NULL,
	"video_id" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "video" (
	"id" text PRIMARY KEY NOT NULL,
	"creator_id" text NOT NULL,
	"video_source" "video_source" DEFAULT 'youtube' NOT NULL,
	"youtube_video_id" text,
	"storage_provider" "storage_provider",
	"video_asset_id" text,
	"playback_id" text,
	"playback_url" text,
	"upload_status" "video_upload_status" DEFAULT 'ready' NOT NULL,
	"duration_seconds" integer,
	"size_bytes" integer,
	"original_file_name" text,
	"thumbnail_url" text,
	"has_custom_thumbnail" boolean DEFAULT false NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"video_type" "video_type" DEFAULT 'demo' NOT NULL,
	"stage_badge" "video_stage",
	"sector_tags" text[] DEFAULT '{}' NOT NULL,
	"website_url" text,
	"cta_label" text,
	"cta_url" text,
	"linkedin_url" text,
	"x_profile_url" text,
	"contact_email" text,
	"is_made_for_kids" boolean,
	"has_age_restriction" boolean DEFAULT false NOT NULL,
	"related_video_url" text,
	"attached_pitch_id" text,
	"has_funding_cta" boolean DEFAULT false NOT NULL,
	"visibility" "video_visibility" DEFAULT 'private' NOT NULL,
	"is_nda_required" boolean DEFAULT false NOT NULL,
	"scheduled_publish_at" timestamp,
	"publish_status" "video_publish_status" DEFAULT 'draft' NOT NULL,
	"published_at" timestamp,
	"review_status" "content_review_status" DEFAULT 'not_required' NOT NULL,
	"rejection_reason" text,
	"license" "video_license" DEFAULT 'standard' NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"video_language" text,
	"is_embedding_allowed" boolean DEFAULT true NOT NULL,
	"are_comments_enabled" boolean DEFAULT true NOT NULL,
	"should_show_likes_count" boolean DEFAULT true NOT NULL,
	"has_paid_promotion" boolean DEFAULT false NOT NULL,
	"uses_altered_content" boolean,
	"caption_certification" text,
	"comment_moderation" text,
	"comment_sort_order" text,
	"shorts_remixing" "shorts_remix",
	"recording_date" date,
	"recording_location" text,
	"category" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "video_source_id_ck" CHECK ((video_source <> 'youtube') OR (youtube_video_id IS NOT NULL)),
	CONSTRAINT "video_youtube_id_format_ck" CHECK (youtube_video_id IS NULL OR youtube_video_id ~ '^[A-Za-z0-9_-]{11}$'),
	CONSTRAINT "video_gating_ck" CHECK ((video_source <> 'youtube') OR (visibility <> 'investor_only' AND is_nda_required = false)),
	CONSTRAINT "video_published_at_ck" CHECK ((publish_status <> 'published') OR (published_at IS NOT NULL)),
	CONSTRAINT "video_scheduled_at_ck" CHECK ((publish_status <> 'scheduled') OR (scheduled_publish_at IS NOT NULL)),
	CONSTRAINT "video_rejection_reason_ck" CHECK ((review_status <> 'rejected') OR (rejection_reason IS NOT NULL)),
	CONSTRAINT "video_sector_tags_ck" CHECK (cardinality(sector_tags) <= 20),
	CONSTRAINT "video_tags_ck" CHECK (cardinality(tags) <= 30)
);
--> statement-breakpoint
CREATE TABLE "video_attached_product" (
	"id" text PRIMARY KEY NOT NULL,
	"video_id" text NOT NULL,
	"product_id" text NOT NULL,
	"position" integer NOT NULL,
	"pinned_at_seconds" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "video_chapter" (
	"id" text PRIMARY KEY NOT NULL,
	"video_id" text NOT NULL,
	"start_seconds" integer NOT NULL,
	"title" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "video_chapter_start_ck" CHECK (start_seconds >= 0)
);
--> statement-breakpoint
CREATE TABLE "video_collaborator" (
	"id" text PRIMARY KEY NOT NULL,
	"video_id" text NOT NULL,
	"invited_email" "citext" NOT NULL,
	"user_id" text,
	"status" "video_collaborator_status" DEFAULT 'invited' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "video_document" (
	"id" text PRIMARY KEY NOT NULL,
	"video_id" text NOT NULL,
	"url" text NOT NULL,
	"file_name" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "video_milestone" (
	"id" text PRIMARY KEY NOT NULL,
	"video_id" text NOT NULL,
	"label" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "video_open_role" (
	"id" text PRIMARY KEY NOT NULL,
	"video_id" text NOT NULL,
	"role_title" text NOT NULL,
	"role_description" text,
	"position" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "video_team_member" (
	"id" text PRIMARY KEY NOT NULL,
	"video_id" text NOT NULL,
	"member_name" text NOT NULL,
	"role_label" text,
	"linked_user_id" text,
	"position" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "anime_episode" ADD CONSTRAINT "anime_episode_season_id_anime_season_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."anime_season"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anime_episode" ADD CONSTRAINT "anime_episode_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anime_season" ADD CONSTRAINT "anime_season_series_id_anime_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."anime_series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anime_series" ADD CONSTRAINT "anime_series_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_review_action" ADD CONSTRAINT "content_review_action_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_review_action" ADD CONSTRAINT "content_review_action_reviewer_id_user_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist" ADD CONSTRAINT "playlist_creator_id_user_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_item" ADD CONSTRAINT "playlist_item_playlist_id_playlist_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlist"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_item" ADD CONSTRAINT "playlist_item_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video" ADD CONSTRAINT "video_creator_id_user_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_attached_product" ADD CONSTRAINT "video_attached_product_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_attached_product" ADD CONSTRAINT "video_attached_product_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_chapter" ADD CONSTRAINT "video_chapter_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_collaborator" ADD CONSTRAINT "video_collaborator_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_collaborator" ADD CONSTRAINT "video_collaborator_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_document" ADD CONSTRAINT "video_document_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_milestone" ADD CONSTRAINT "video_milestone_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_open_role" ADD CONSTRAINT "video_open_role_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_team_member" ADD CONSTRAINT "video_team_member_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_team_member" ADD CONSTRAINT "video_team_member_linked_user_id_user_id_fk" FOREIGN KEY ("linked_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "anime_episode_seasonId_idx" ON "anime_episode" USING btree ("season_id");--> statement-breakpoint
CREATE UNIQUE INDEX "anime_episode_unq" ON "anime_episode" USING btree ("season_id","episode_number");--> statement-breakpoint
CREATE UNIQUE INDEX "anime_episode_videoId_unq" ON "anime_episode" USING btree ("video_id") WHERE video_id is not null;--> statement-breakpoint
CREATE INDEX "anime_season_seriesId_idx" ON "anime_season" USING btree ("series_id");--> statement-breakpoint
CREATE UNIQUE INDEX "anime_season_label_unq" ON "anime_season" USING btree ("series_id","season_label");--> statement-breakpoint
CREATE INDEX "anime_series_ownerId_idx" ON "anime_series" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "content_review_action_videoId_idx" ON "content_review_action" USING btree ("video_id");--> statement-breakpoint
CREATE INDEX "content_review_action_createdAt_idx" ON "content_review_action" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "playlist_creatorId_idx" ON "playlist" USING btree ("creator_id");--> statement-breakpoint
CREATE INDEX "playlist_item_playlistId_idx" ON "playlist_item" USING btree ("playlist_id");--> statement-breakpoint
CREATE INDEX "playlist_item_videoId_idx" ON "playlist_item" USING btree ("video_id");--> statement-breakpoint
CREATE UNIQUE INDEX "playlist_item_unq" ON "playlist_item" USING btree ("playlist_id","video_id");--> statement-breakpoint
CREATE INDEX "video_creatorId_idx" ON "video" USING btree ("creator_id");--> statement-breakpoint
CREATE INDEX "video_publishStatus_idx" ON "video" USING btree ("publish_status");--> statement-breakpoint
CREATE INDEX "video_reviewStatus_videoType_idx" ON "video" USING btree ("review_status","video_type");--> statement-breakpoint
CREATE INDEX "video_youtubeVideoId_idx" ON "video" USING btree ("youtube_video_id");--> statement-breakpoint
CREATE UNIQUE INDEX "video_asset_unq" ON "video" USING btree ("video_asset_id") WHERE video_asset_id is not null;--> statement-breakpoint
CREATE INDEX "video_attached_product_videoId_idx" ON "video_attached_product" USING btree ("video_id");--> statement-breakpoint
CREATE UNIQUE INDEX "video_product_unq" ON "video_attached_product" USING btree ("video_id","product_id");--> statement-breakpoint
CREATE INDEX "video_chapter_videoId_idx" ON "video_chapter" USING btree ("video_id");--> statement-breakpoint
CREATE UNIQUE INDEX "video_chapter_position_unq" ON "video_chapter" USING btree ("video_id","position");--> statement-breakpoint
CREATE INDEX "video_collaborator_videoId_idx" ON "video_collaborator" USING btree ("video_id");--> statement-breakpoint
CREATE UNIQUE INDEX "video_collaborator_unq" ON "video_collaborator" USING btree ("video_id","invited_email");--> statement-breakpoint
CREATE INDEX "video_document_videoId_idx" ON "video_document" USING btree ("video_id");--> statement-breakpoint
CREATE INDEX "video_milestone_videoId_idx" ON "video_milestone" USING btree ("video_id");--> statement-breakpoint
CREATE INDEX "video_open_role_videoId_idx" ON "video_open_role" USING btree ("video_id");--> statement-breakpoint
CREATE INDEX "video_team_member_videoId_idx" ON "video_team_member" USING btree ("video_id");