-- Deletes the four hero slides migration 0149 seeded, which were ANIME slides.
--
-- ⚠️ THIS IS A PRODUCTION BUG FIX, NOT TIDYING. 0149 INSERTs four rows titled "God Troubles Me
-- Season 3", "Dragon's Disciple", "Word of Honor" and the Han Li one, with `is_active = true`
-- and no schedule window. Nothing has ever deleted or deactivated them. On a FRESH database
-- every migration runs, so those four rows are live in `blueprint_hero_slide` and the
-- /blueprints hub renders an anime carousel — with 404 images, because the four
-- `/dummy/*.avif` files they point at were deleted from the frontend's `public/` long ago.
--
-- ⚠️ MATCHED ON THE EXACT SEEDED `image_url` VALUES, never on position or row count. A real
-- slide an admin uploaded lives on Cloudinary under an https:// address and cannot collide with
-- these four site-relative paths, so this can only ever remove what 0149 wrote. On a database
-- where `db:seed-blueprint-hero-slides` already converted those rows to Cloudinary URLs this
-- matches nothing and is a no-op, which is the correct outcome there.
--
-- Not folded into 0196 because that one is drizzle-generated: regenerating it would silently
-- drop a hand-written DELETE. A data fix belongs in its own file.
DELETE FROM "blueprint_hero_slide"
WHERE "image_url" IN (
  '/dummy/anime_hero.avif',
  '/dummy/recent_episode_01.avif',
  '/dummy/recent_episode_02.avif',
  '/dummy/recommended_for_you_01.avif'
);
