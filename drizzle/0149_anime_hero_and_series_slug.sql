-- ---------------------------------------------------------------------------------------
-- 0149 — the /anime hero carousel, and a public URL identity for an anime series.
--
-- ## What this adds
--
-- `anime_hero_slide` — the rotating card at the top of /anime. Platform-authored, gated by
-- `manage_promotions`, and shaped after `promotional_slide` rather than after
-- `feed_spotlight_slot`: an admin uploads an image and writes a caption, they do not pick a
-- catalogue video.
--
-- `anime_series.slug` — the public URL identity, `/anime/series/<slug>`. Server-minted from
-- the title on create and never rewritten, because a slug is linked the moment it exists.
--
-- Five `platform_audit_event_kind` labels, one per mutation. All five rather than only the
-- destructive ones, for the same reason the promotional carousel names all five: each puts
-- an image in front of every visitor to /anime, or takes one away.
--
-- ## Why a new table and not a `placement` column on `promotional_slide`
--
-- Two structural differences. A promotional slide carries
-- `destination_kind ∈ {internal_path, external_url}` because an advertiser link is supposed
-- to leave the site; an anime hero slide links to a page in this app or to nothing at all,
-- and folding them together would put an external-URL arm one boolean away from a content
-- surface. And the promo carousel is `object-contain` in a fixed-height band, so it needs
-- `image_width_px`/`image_height_px`; this one renders `fill` inside a fixed `aspect-video`
-- box, so those columns would be dead weight every write has to populate.
--
-- ## Why `image_url` accepts a site-relative path
--
-- The four seed rows at the bottom point at files already in the frontend's `public/dummy/`.
-- A migration cannot upload to Cloudinary, and the alternative — a hardcoded fallback slide
-- inside the component when the list comes back empty — is a mock fallback on a wired
-- surface, which this repo forbids. They are real rows an admin can edit, reorder, delete,
-- or replace the image of; replacing the image is what turns one into a Cloudinary asset.
--
-- The doubled-slash refusal in that CHECK is not decoration. `//evil.tld/x` starts with "/"
-- and is a protocol-relative URL that leaves the site, and this value becomes a `next/image`
-- src on a public page.
--
-- ## Why `anime_series.slug` can be NOT NULL with no default and no backfill
--
-- `anime_series` is EMPTY — verified immediately before applying:
--   SELECT count(*) FROM anime_series;  -- 0
-- A non-empty table would need a two-step (add nullable, backfill, set not null); this one
-- does not, and doing it in one step keeps the column's contract visible in one place.
--
-- ## ALTER TYPE and CREATE TABLE in ONE file
--
-- Legal here, and 0148 is the precedent. `ALTER TYPE ... ADD VALUE` cannot have its new
-- value USED in the same transaction — 0128 was split for exactly that — but none of the
-- five labels below is used as a column default or in any expression here. They are read
-- only by runtime service code.
--
-- ## Applied by hand
--
-- `pnpm db:migrate` could not run this, for the reason 0148 records: five earlier migrations
-- (0042, 0047, 0049, 0052, 0147) have file hashes that no longer match the rows in
-- `drizzle.__drizzle_migrations`, because this repo's workflow is to hand-write a header like
-- this one AFTER `db:generate`. drizzle-kit therefore reads those five as pending and dies
-- re-running 0042, with the error swallowed by its spinner. Every statement below was
-- verified against the live database inside a transaction that was rolled back, then applied
-- in one transaction, and the ledger row was inserted with the hash of THIS file as it now
-- stands.
-- ---------------------------------------------------------------------------------------
ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE 'anime_hero_slide_created' BEFORE 'commerce_content_hidden';--> statement-breakpoint
ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE 'anime_hero_slide_updated' BEFORE 'commerce_content_hidden';--> statement-breakpoint
ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE 'anime_hero_slide_reordered' BEFORE 'commerce_content_hidden';--> statement-breakpoint
ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE 'anime_hero_slide_image_replaced' BEFORE 'commerce_content_hidden';--> statement-breakpoint
ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE 'anime_hero_slide_deleted' BEFORE 'commerce_content_hidden';--> statement-breakpoint
CREATE TABLE "anime_hero_slide" (
	"id" text PRIMARY KEY NOT NULL,
	"image_url" text NOT NULL,
	"title" text NOT NULL,
	"destination_path" text,
	"position" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"starts_at" timestamp,
	"ends_at" timestamp,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "anime_hero_slide_position_ck" CHECK (position >= 0),
	CONSTRAINT "anime_hero_slide_title_ck" CHECK (char_length(title) BETWEEN 1 AND 160),
	CONSTRAINT "anime_hero_slide_image_url_ck" CHECK (char_length(image_url) BETWEEN 1 AND 2048
          AND image_url !~ '[[:space:][:cntrl:]]'
          AND (image_url LIKE 'https://%'
               OR (image_url LIKE '/%' AND image_url NOT LIKE '//%'))),
	CONSTRAINT "anime_hero_slide_destination_ck" CHECK (destination_path IS NULL
          OR (char_length(destination_path) BETWEEN 1 AND 512
              AND destination_path LIKE '/%'
              AND destination_path NOT LIKE '//%'
              AND destination_path !~ '[[:space:][:cntrl:]]')),
	CONSTRAINT "anime_hero_slide_window_ck" CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
);
--> statement-breakpoint
ALTER TABLE "anime_series" ADD COLUMN "slug" text NOT NULL;--> statement-breakpoint
ALTER TABLE "anime_hero_slide" ADD CONSTRAINT "anime_hero_slide_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anime_hero_slide" ADD CONSTRAINT "anime_hero_slide_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "anime_hero_slide_live_idx" ON "anime_hero_slide" USING btree ("position","id") WHERE is_active;--> statement-breakpoint
CREATE INDEX "anime_hero_slide_position_idx" ON "anime_hero_slide" USING btree ("position","id");--> statement-breakpoint
CREATE UNIQUE INDEX "anime_series_slug_uidx" ON "anime_series" USING btree ("slug");--> statement-breakpoint
ALTER TABLE "anime_series" ADD CONSTRAINT "anime_series_slug_ck" CHECK (char_length(slug) BETWEEN 1 AND 120 AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');--> statement-breakpoint
-- The four seeded slides. They replace `MOCK_ANIME_HERO` and three of `MOCK_RECENT_EPISODES`
-- / `MOCK_RECOMMENDED_ANIME` in the frontend, so /anime looks the same the moment this lands
-- rather than losing its hero until an admin uploads one.
--
-- `destination_path` is NULL on all four: there is no anime series to link to yet (the
-- catalogue is empty), and a link to a page that 404s is worse than no link. An admin points
-- them at /anime/series/<slug> once a series exists.
--
-- `created_by_user_id` and `updated_by_user_id` are NULL because no human created these.
-- That is what those columns being nullable is for; inventing an author would put a name on
-- an act nobody performed.
INSERT INTO "anime_hero_slide" ("id", "image_url", "title", "destination_path", "position", "is_active")
VALUES
  (gen_random_uuid()::text, '/dummy/anime_hero.avif', 'A Record Of Mortal''s Journey To Immortality: Immortal Han Li''s Adventure with cyan bottle', NULL, 0, true),
  (gen_random_uuid()::text, '/dummy/recent_episode_01.avif', 'God Troubles Me Season 3', NULL, 1, true),
  (gen_random_uuid()::text, '/dummy/recent_episode_02.avif', 'Dragon''s Disciple', NULL, 2, true),
  (gen_random_uuid()::text, '/dummy/recommended_for_you_01.avif', 'Word of Honor', NULL, 3, true);
