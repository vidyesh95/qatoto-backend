-- Platform-host the seller-writable image columns.
--
-- WHAT WAS WRONG. Five columns took a bare client-supplied https string, validated only
-- by `startsWith('https://')` and a length cap:
--
--   commerce_product_highlight.image_url        (public PDP)
--   commerce_organization_stakeholder.photo_url (public profile)
--   commerce_organization.logo_url              (public storefront)
--   store_pathway.hero_image_url / card_image_url (public store, seller-proposable)
--
-- §11 of docs/STORE_BACKEND_STRUCTURE.md already required otherwise — "Normalize and
-- allowlist external URLs before storage" — and nothing did either. Three consequences,
-- and the third is the one that matters:
--
--  1. EXIF is never stripped. A stakeholder portrait and a factory-floor highlight are
--     both phone photographs; their EXIF carries GPS. `commerce_organization_media`
--     already departed from this precedent for exactly that reason, and its schema
--     comment names `commerce_product_highlight.image_url` and
--     `commerce_organization.logo_url` as the precedent it was departing FROM.
--  2. The seller's origin sees every store visitor's IP and user agent — a tracking
--     channel the platform grants without knowing it.
--  3. THE BYTES STAY MUTABLE AFTER MODERATION. A seller proposes a pathway (§15.5), a
--     moderator publishes it, and `EDITABLE_PATHWAY_STATES = ['draft','rejected']` then
--     freezes the row — so the platform believes that image was reviewed. It reviewed a
--     URL. The seller can replace the file at its own origin at any time, on a surface
--     the store presents as moderated. Approving a pointer is not approving a picture.
--
-- WHAT THIS DOES. Each image gains the triple `commerce_organization_media` established:
-- a Cloudinary public id (retained so a later delete can destroy the remote asset, never
-- projected publicly) and width/height MEASURED FROM THE DECODED BYTES, never accepted
-- from the client — the rule A2 set for `product_image`.
--
-- LEGACY ROWS ARE LEFT ALONE. An existing hotlink keeps its URL with a NULL public id and
-- NULL dimensions, and goes on rendering. Nulling them would blank live storefronts, and
-- re-hosting them here would mean this migration fetching seller-controlled URLs from
-- inside the database — an SSRF surface in a DDL transaction. They are replaced when the
-- owner next uploads through the new routes; the CHECKs below make the two shapes
-- distinguishable rather than merged.

ALTER TABLE "commerce_product_highlight"
  ADD COLUMN IF NOT EXISTS "image_cloudinary_public_id" text,
  ADD COLUMN IF NOT EXISTS "image_width_px" integer,
  ADD COLUMN IF NOT EXISTS "image_height_px" integer;

ALTER TABLE "commerce_organization_stakeholder"
  ADD COLUMN IF NOT EXISTS "photo_cloudinary_public_id" text,
  ADD COLUMN IF NOT EXISTS "photo_width_px" integer,
  ADD COLUMN IF NOT EXISTS "photo_height_px" integer;

ALTER TABLE "commerce_organization"
  ADD COLUMN IF NOT EXISTS "logo_cloudinary_public_id" text,
  ADD COLUMN IF NOT EXISTS "logo_width_px" integer,
  ADD COLUMN IF NOT EXISTS "logo_height_px" integer;

ALTER TABLE "store_pathway"
  ADD COLUMN IF NOT EXISTS "hero_image_cloudinary_public_id" text,
  ADD COLUMN IF NOT EXISTS "hero_image_width_px" integer,
  ADD COLUMN IF NOT EXISTS "hero_image_height_px" integer,
  ADD COLUMN IF NOT EXISTS "card_image_cloudinary_public_id" text,
  ADD COLUMN IF NOT EXISTS "card_image_width_px" integer,
  ADD COLUMN IF NOT EXISTS "card_image_height_px" integer;

-- Each image is one of exactly two shapes: a legacy hotlink (URL alone) or a
-- platform-hosted asset (URL + public id + both measured dimensions). A public id
-- without dimensions, or dimensions without a public id, is neither.
ALTER TABLE "commerce_product_highlight"
  DROP CONSTRAINT IF EXISTS "commerce_product_highlight_hosted_image_ck";
ALTER TABLE "commerce_product_highlight"
  ADD CONSTRAINT "commerce_product_highlight_hosted_image_ck" CHECK (
    (
      "image_cloudinary_public_id" IS NULL
      AND "image_width_px" IS NULL
      AND "image_height_px" IS NULL
    )
    OR (
      "image_url" IS NOT NULL
      AND "image_cloudinary_public_id" IS NOT NULL
      AND "image_width_px" > 0
      AND "image_height_px" > 0
    )
  );

ALTER TABLE "commerce_organization_stakeholder"
  DROP CONSTRAINT IF EXISTS "commerce_organization_stakeholder_hosted_photo_ck";
ALTER TABLE "commerce_organization_stakeholder"
  ADD CONSTRAINT "commerce_organization_stakeholder_hosted_photo_ck" CHECK (
    (
      "photo_cloudinary_public_id" IS NULL
      AND "photo_width_px" IS NULL
      AND "photo_height_px" IS NULL
    )
    OR (
      "photo_url" IS NOT NULL
      AND "photo_cloudinary_public_id" IS NOT NULL
      AND "photo_width_px" > 0
      AND "photo_height_px" > 0
    )
  );

ALTER TABLE "commerce_organization"
  DROP CONSTRAINT IF EXISTS "commerce_organization_hosted_logo_ck";
ALTER TABLE "commerce_organization"
  ADD CONSTRAINT "commerce_organization_hosted_logo_ck" CHECK (
    (
      "logo_cloudinary_public_id" IS NULL
      AND "logo_width_px" IS NULL
      AND "logo_height_px" IS NULL
    )
    OR (
      "logo_url" IS NOT NULL
      AND "logo_cloudinary_public_id" IS NOT NULL
      AND "logo_width_px" > 0
      AND "logo_height_px" > 0
    )
  );

ALTER TABLE "store_pathway"
  DROP CONSTRAINT IF EXISTS "store_pathway_hosted_hero_image_ck";
ALTER TABLE "store_pathway"
  ADD CONSTRAINT "store_pathway_hosted_hero_image_ck" CHECK (
    (
      "hero_image_cloudinary_public_id" IS NULL
      AND "hero_image_width_px" IS NULL
      AND "hero_image_height_px" IS NULL
    )
    OR (
      "hero_image_url" IS NOT NULL
      AND "hero_image_cloudinary_public_id" IS NOT NULL
      AND "hero_image_width_px" > 0
      AND "hero_image_height_px" > 0
    )
  );

ALTER TABLE "store_pathway"
  DROP CONSTRAINT IF EXISTS "store_pathway_hosted_card_image_ck";
ALTER TABLE "store_pathway"
  ADD CONSTRAINT "store_pathway_hosted_card_image_ck" CHECK (
    (
      "card_image_cloudinary_public_id" IS NULL
      AND "card_image_width_px" IS NULL
      AND "card_image_height_px" IS NULL
    )
    OR (
      "card_image_url" IS NOT NULL
      AND "card_image_cloudinary_public_id" IS NOT NULL
      AND "card_image_width_px" > 0
      AND "card_image_height_px" > 0
    )
  );
