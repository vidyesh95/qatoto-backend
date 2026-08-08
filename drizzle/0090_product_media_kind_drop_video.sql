-- Remove `video` from `product_media_kind`.
--
-- A2 added the discriminator in Phase 8 so "a 360 spin or a video had nowhere to live".
-- The spin landed; the video never did, and could not have. `addProductImage` runs every
-- upload through `validateAndNormalizeImage(outputFormat: "avif")` before it reaches
-- Cloudinary, and there is no video URL column on `product_image` at all — so a row
-- labelled `video` is an AVIF still wearing a label it cannot honour. The client chooses
-- that label freely (`products.controller.ts` accepted it in the multipart fields), which
-- means the wire carried a value that could never describe the bytes behind it.
--
-- That is the exact failure Appendix A exists to prevent: "No entry there now describes a
-- field that reaches the wire and can never carry a real value."
--
-- WHY NARROW RATHER THAN BUILD IT. Nothing asks for product video. A2's stated need is
-- `sections/view-in-360-banner.tsx` — the spin. A8 already settled what commerce video is
-- when it is wanted: an external YouTube id under a supply-shape CHECK, because this
-- codebase has no first-party video ingest. If product video is ever built it follows that
-- shape and adds its own column and constraint; it does not arrive by leaving a label lying
-- around in the meantime.
--
-- `spin_360` stays and is genuinely representable: a spin is an ordered run of stills in one
-- (product, variant) gallery, which the Phase 8 position index already orders.
--
-- PREFLIGHT. Compared on ::text, because the value is being removed from the type in this
-- same transaction and drizzle runs the whole migration as one.
DO $$
DECLARE
  video_row_count bigint;
BEGIN
  SELECT count(*) INTO video_row_count
    FROM "product_image"
   WHERE "media_kind"::text = 'video';

  IF video_row_count > 0 THEN
    RAISE EXCEPTION
      'Refusing to narrow product_media_kind: % product_image row(s) still carry media_kind = video. Re-label or delete them first; each one is an AVIF still, so photo is the truthful value.',
      video_row_count;
  END IF;
END $$;

-- A value cannot be dropped from a PostgreSQL enum in place, so the type is rebuilt.
-- The default is dropped first because it is a literal of the old type.
ALTER TABLE "product_image" ALTER COLUMN "media_kind" DROP DEFAULT;

ALTER TYPE "product_media_kind" RENAME TO "product_media_kind_old";

CREATE TYPE "product_media_kind" AS ENUM ('photo', 'spin_360');

ALTER TABLE "product_image"
  ALTER COLUMN "media_kind" TYPE "product_media_kind"
  USING "media_kind"::text::"product_media_kind";

ALTER TABLE "product_image" ALTER COLUMN "media_kind" SET DEFAULT 'photo';

DROP TYPE "product_media_kind_old";
