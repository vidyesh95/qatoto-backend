-- ---------------------------------------------------------------------------
-- Feed preferences — "Not interested" and "Don't recommend channel".
--
-- HAND-WRITTEN, like every migration since 0046. The DDL below was composed by
-- `drizzle-kit export --sql`, which reads src/db/schema.ts with no database connection
-- and without consulting drizzle/meta/ — the only way to get canonical DDL in this repo,
-- since the snapshots stop at 0054 and `db:generate` therefore tries to recreate four
-- phases of tables.
--
-- THE FIRST TWO NEGATIVE VIEWER SIGNALS IN THE SCHEMA. Every viewer→content and
-- viewer→creator relation before this one records what someone wants MORE of:
-- `video_like`, `video_save`, `creator_subscription`. These record what they want less
-- of, and three design calls follow from that asymmetry.
--
-- 1. NO COUNTER COLUMN, ANYWHERE.
--
-- `creator_subscription` moves `creator_stats.subscriber_count` because a subscriber
-- count is public social proof a creator benefits from. The mirror image is not a mirror:
-- a visible "muted by N people" is a stick handed to anyone who wants to demoralise a
-- creator, and it would be trivially farmable with throwaway accounts besides. No route
-- reads either table in the creator direction, and `creator_mute_creatorId_idx` exists
-- for the foreign-key cascade ALONE — a future query that uses it to answer "who muted
-- me" is the thing this note exists to refuse.
--
-- 2. THESE EXCLUSIONS ARE NEVER RELAXED.
--
-- `feed.service.ts` runs a four-stage relaxation ladder: when the candidate pool is too
-- thin to fill a page it drops the already-watched exclusion, then the 180-day recency
-- window, then the creator self-exclusion. Those are all HEURISTICS — guesses about what
-- a viewer would enjoy, which are worth abandoning to avoid an empty page.
--
-- These two are not guesses. They are stated preferences, and the predicates are pushed
-- outside every stage gate. A dismiss button that silently stops working once the catalog
-- runs thin is worse than a short feed, because the viewer cannot tell the difference
-- between "the button did nothing" and "the button is broken".
--
-- 3. `mode=watched` IS EXEMPT, AND THAT EXEMPTION IS LOAD-BEARING.
--
-- `candidatePoolPredicate` is shared by every feed mode, including the one that renders
-- /history. Watch history is a RECORD, not a recommendation — a video the viewer
-- dismissed is still a video they watched. Without the exemption, "not interested" would
-- quietly rewrite their history, which no copy on that button claims and no viewer would
-- expect. The predicate therefore carries `input.mode !== "watched"`.
--
-- NO ENUMS AND NO NEW TYPES. Both tables are the `creator_subscription` shape: composite
-- primary key, one index for the cascade, a self-check where one applies. The PK is what
-- makes `PUT` and `DELETE` idempotent, so neither route needs an idempotency key.
--
-- NOTHING TO BACKFILL. An absent row means "no preference stated", which is every viewer
-- and every video until someone says otherwise.
--
-- RUN ORDER: tables -> foreign keys -> indexes. (No enums in this one.)
-- ---------------------------------------------------------------------------

CREATE TABLE "video_not_interested" (
	"viewer_id" text NOT NULL,
	"video_id" text NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "video_not_interested_viewer_id_video_id_pk" PRIMARY KEY("viewer_id","video_id")
);--> statement-breakpoint

CREATE TABLE "creator_mute" (
	"muter_id" text NOT NULL,
	"creator_id" text NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "creator_mute_muter_id_creator_id_pk" PRIMARY KEY("muter_id","creator_id"),
	CONSTRAINT "creator_mute_self_ck" CHECK (muter_id <> creator_id)
);--> statement-breakpoint

ALTER TABLE "video_not_interested" ADD CONSTRAINT "video_not_interested_viewer_id_user_id_fk" FOREIGN KEY ("viewer_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "video_not_interested" ADD CONSTRAINT "video_not_interested_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "creator_mute" ADD CONSTRAINT "creator_mute_muter_id_user_id_fk" FOREIGN KEY ("muter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "creator_mute" ADD CONSTRAINT "creator_mute_creator_id_user_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Both are for the FK cascade, not for a read. The primary keys already serve the only
-- query either table has: the feed's per-viewer `NOT EXISTS` probe, keyed viewer-first.
CREATE INDEX "video_not_interested_videoId_idx" ON "video_not_interested" USING btree ("video_id");--> statement-breakpoint

CREATE INDEX "creator_mute_creatorId_idx" ON "creator_mute" USING btree ("creator_id");
