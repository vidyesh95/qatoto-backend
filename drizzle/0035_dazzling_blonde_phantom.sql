CREATE TYPE "public"."video_feed_source" AS ENUM('feed_recommended', 'feed_explore', 'feed_spotlight', 'feed_filtered', 'search', 'channel', 'direct');--> statement-breakpoint
CREATE TYPE "public"."video_share_channel" AS ENUM('copy_link', 'x', 'whatsapp', 'linkedin', 'email');--> statement-breakpoint
CREATE TABLE "creator_stats" (
	"user_id" text PRIMARY KEY NOT NULL,
	"subscriber_count" integer DEFAULT 0 NOT NULL,
	"published_video_count" integer DEFAULT 0 NOT NULL,
	"total_view_count" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "creator_stats_counters_non_negative_ck" CHECK (subscriber_count >= 0 AND published_video_count >= 0 AND total_view_count >= 0)
);
--> statement-breakpoint
CREATE TABLE "creator_subscription" (
	"subscriber_id" text NOT NULL,
	"creator_id" text NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "creator_subscription_subscriber_id_creator_id_pk" PRIMARY KEY("subscriber_id","creator_id"),
	CONSTRAINT "creator_subscription_self_ck" CHECK (subscriber_id <> creator_id)
);
--> statement-breakpoint
CREATE TABLE "video_comment" (
	"id" text PRIMARY KEY NOT NULL,
	"video_id" text NOT NULL,
	"parent_comment_id" text,
	"depth" integer DEFAULT 0 NOT NULL,
	"author_user_id" text,
	"body_text" text NOT NULL,
	"like_count" integer DEFAULT 0 NOT NULL,
	"reply_count" integer DEFAULT 0 NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "video_comment_depth_ck" CHECK (depth BETWEEN 0 AND 1 AND (depth = 0) = (parent_comment_id IS NULL)),
	CONSTRAINT "video_comment_leaf_ck" CHECK (depth = 0 OR reply_count = 0),
	CONSTRAINT "video_comment_counts_ck" CHECK (like_count >= 0 AND reply_count >= 0),
	CONSTRAINT "video_comment_deleted_ck" CHECK (is_deleted = (deleted_at IS NOT NULL)),
	CONSTRAINT "video_comment_body_ck" CHECK ((is_deleted = false AND char_length(body_text) BETWEEN 1 AND 2000)
          OR (is_deleted = true AND body_text = ''))
);
--> statement-breakpoint
CREATE TABLE "video_comment_like" (
	"comment_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "video_comment_like_comment_id_user_id_pk" PRIMARY KEY("comment_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "video_like" (
	"video_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "video_like_video_id_user_id_pk" PRIMARY KEY("video_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "video_playback_error" (
	"id" text PRIMARY KEY NOT NULL,
	"video_id" text NOT NULL,
	"viewer_fingerprint" text NOT NULL,
	"report_day_bucket" date NOT NULL,
	"error_code" integer NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "video_playback_error_code_ck" CHECK (error_code IN (2, 5, 100, 101, 150)),
	CONSTRAINT "video_playback_error_fingerprint_ck" CHECK (viewer_fingerprint ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "video_save" (
	"video_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "video_save_video_id_user_id_pk" PRIMARY KEY("video_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "video_share" (
	"id" text PRIMARY KEY NOT NULL,
	"video_id" text NOT NULL,
	"user_id" text,
	"sharer_fingerprint" text NOT NULL,
	"channel" "video_share_channel" NOT NULL,
	"share_day_bucket" date NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "video_share_fingerprint_ck" CHECK (sharer_fingerprint ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "video_stats" (
	"video_id" text PRIMARY KEY NOT NULL,
	"view_count" integer DEFAULT 0 NOT NULL,
	"like_count" integer DEFAULT 0 NOT NULL,
	"comment_count" integer DEFAULT 0 NOT NULL,
	"share_count" integer DEFAULT 0 NOT NULL,
	"save_count" integer DEFAULT 0 NOT NULL,
	"total_watched_seconds" bigint DEFAULT 0 NOT NULL,
	"completion_bp_sum" bigint DEFAULT 0 NOT NULL,
	"completion_sample_count" integer DEFAULT 0 NOT NULL,
	"unique_viewer_count" integer,
	"last_engagement_at" timestamp,
	CONSTRAINT "video_stats_counters_non_negative_ck" CHECK (view_count >= 0 AND like_count >= 0 AND comment_count >= 0
          AND share_count >= 0 AND save_count >= 0
          AND total_watched_seconds >= 0 AND completion_bp_sum >= 0
          AND completion_sample_count >= 0
          AND (unique_viewer_count IS NULL OR unique_viewer_count >= 0))
);
--> statement-breakpoint
CREATE TABLE "video_view_session" (
	"id" text PRIMARY KEY NOT NULL,
	"video_id" text NOT NULL,
	"viewer_id" text,
	"viewer_fingerprint" text NOT NULL,
	"view_day_bucket" date NOT NULL,
	"feed_source" "video_feed_source" NOT NULL,
	"pinned_duration_seconds" integer NOT NULL,
	"watched_seconds" integer DEFAULT 0 NOT NULL,
	"max_position_seconds" integer DEFAULT 0 NOT NULL,
	"completion_basis_points" integer DEFAULT 0 NOT NULL,
	"is_counted_view" boolean DEFAULT false NOT NULL,
	"first_beacon_at" timestamp (3) DEFAULT now() NOT NULL,
	"last_beacon_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "video_view_session_bounds_ck" CHECK (watched_seconds >= 0
          AND max_position_seconds >= 0
          AND completion_basis_points BETWEEN 0 AND 10000
          AND pinned_duration_seconds BETWEEN 1 AND 43200
          AND last_beacon_at >= first_beacon_at),
	CONSTRAINT "video_view_session_fingerprint_ck" CHECK (viewer_fingerprint ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "creator_stats" ADD CONSTRAINT "creator_stats_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_subscription" ADD CONSTRAINT "creator_subscription_subscriber_id_user_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_subscription" ADD CONSTRAINT "creator_subscription_creator_id_user_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_comment" ADD CONSTRAINT "video_comment_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_comment" ADD CONSTRAINT "video_comment_parent_comment_id_video_comment_id_fk" FOREIGN KEY ("parent_comment_id") REFERENCES "public"."video_comment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_comment" ADD CONSTRAINT "video_comment_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_comment_like" ADD CONSTRAINT "video_comment_like_comment_id_video_comment_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."video_comment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_comment_like" ADD CONSTRAINT "video_comment_like_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_like" ADD CONSTRAINT "video_like_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_like" ADD CONSTRAINT "video_like_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_playback_error" ADD CONSTRAINT "video_playback_error_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_save" ADD CONSTRAINT "video_save_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_save" ADD CONSTRAINT "video_save_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_share" ADD CONSTRAINT "video_share_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_share" ADD CONSTRAINT "video_share_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_stats" ADD CONSTRAINT "video_stats_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_view_session" ADD CONSTRAINT "video_view_session_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_view_session" ADD CONSTRAINT "video_view_session_viewer_id_user_id_fk" FOREIGN KEY ("viewer_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "creator_subscription_creatorId_idx" ON "creator_subscription" USING btree ("creator_id","subscriber_id");--> statement-breakpoint
CREATE INDEX "video_comment_thread_idx" ON "video_comment" USING btree ("video_id","created_at","id") WHERE parent_comment_id IS NULL;--> statement-breakpoint
CREATE INDEX "video_comment_parent_idx" ON "video_comment" USING btree ("parent_comment_id","created_at","id");--> statement-breakpoint
CREATE INDEX "video_comment_authorUserId_idx" ON "video_comment" USING btree ("author_user_id","id");--> statement-breakpoint
CREATE INDEX "video_comment_like_userId_idx" ON "video_comment_like" USING btree ("user_id","comment_id");--> statement-breakpoint
CREATE INDEX "video_like_userId_idx" ON "video_like" USING btree ("user_id","video_id");--> statement-breakpoint
CREATE UNIQUE INDEX "video_playback_error_unq" ON "video_playback_error" USING btree ("video_id","viewer_fingerprint","report_day_bucket");--> statement-breakpoint
CREATE INDEX "video_playback_error_videoId_idx" ON "video_playback_error" USING btree ("video_id","report_day_bucket");--> statement-breakpoint
CREATE INDEX "video_save_userId_idx" ON "video_save" USING btree ("user_id","created_at","video_id");--> statement-breakpoint
CREATE UNIQUE INDEX "video_share_unq" ON "video_share" USING btree ("video_id","sharer_fingerprint","channel","share_day_bucket");--> statement-breakpoint
CREATE INDEX "video_share_videoId_idx" ON "video_share" USING btree ("video_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "video_view_session_unq" ON "video_view_session" USING btree ("video_id","viewer_fingerprint","view_day_bucket");--> statement-breakpoint
CREATE INDEX "video_view_session_fingerprint_idx" ON "video_view_session" USING btree ("viewer_fingerprint","view_day_bucket");--> statement-breakpoint
CREATE INDEX "video_view_session_viewer_idx" ON "video_view_session" USING btree ("viewer_id","video_id","first_beacon_at") WHERE viewer_id IS NOT NULL AND is_counted_view;--> statement-breakpoint
CREATE INDEX "video_view_session_video_idx" ON "video_view_session" USING btree ("video_id","first_beacon_at");--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- HAND-WRITTEN BACKFILL — not emitted by drizzle-kit.
--
-- `video_stats` and `creator_stats` are sidecar counter caches whose rows are minted
-- by the application from here on: `video_stats` inside the createVideo transaction,
-- `creator_stats` on first video create and first subscribe. Every video and creator
-- that existed BEFORE this migration has no such row, and every engagement counter
-- update is an UPDATE — which would silently affect zero rows and lose the counter.
--
-- Same call as migration 0034's `is_source_verified` backfill: the schema change and
-- the data it implies land together, because a deploy that separates them has a window
-- where the invariant is false.
-- ---------------------------------------------------------------------------
INSERT INTO "video_stats" ("video_id") SELECT "id" FROM "video" ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "creator_stats" ("user_id") SELECT DISTINCT "creator_id" FROM "video" ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Seed the one counter that is derivable from existing rows. The other two
-- (subscriber_count, total_view_count) are correctly 0: no subscription and no view
-- session has ever been recorded.
UPDATE "creator_stats" SET "published_video_count" = "counts"."published_count"
  FROM (
    SELECT "creator_id", count(*) AS "published_count"
    FROM "video" WHERE "publish_status" = 'published'
    GROUP BY "creator_id"
  ) AS "counts"
  WHERE "creator_stats"."user_id" = "counts"."creator_id";