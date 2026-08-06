-- Store Phase 8 — catalog depth and the product relation graph.
--
-- Appendix A1 (variants), A2 (media kinds), A3 (specification groups),
-- A5 (packaging geometry), A6 (highlights), A7/§15.3 (the relation graph)
-- and the A19 merchandising integrity fixes.
--
-- A4 (`condition` in the public projection) is a projection change only and needs
-- no migration.
--
-- HAND-WRITTEN, like every store-phase migration since 0046. `drizzle-kit generate`
-- diffs against drizzle/meta/, whose snapshots stop at 0045, so it re-emits every
-- table created since. The 0054 snapshot committed alongside this file records the
-- true current schema and repairs that drift for future generates.
--
-- Additive throughout: every new column is nullable or defaulted, so a running
-- pre-Phase-8 application keeps working against this schema.

-- ---------------------------------------------------------------------------
-- Preflight. A19 adds a CHECK to store_hero_slide that existing rows may already
-- violate; refuse the migration loudly rather than silently dropping the rule.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  offending_slide_count integer;
BEGIN
  SELECT count(*) INTO offending_slide_count
  FROM "store_hero_slide"
  WHERE NOT (
    (link_target_kind IS NULL AND link_target_id IS NULL AND link_target_slug IS NULL)
    OR (link_target_kind IS NOT NULL AND link_target_id IS NOT NULL
        AND link_target_slug IS NOT NULL)
  );

  IF offending_slide_count > 0 THEN
    RAISE EXCEPTION
      'Store Phase 8 preflight: % store_hero_slide row(s) carry a partial link target. Complete or clear link_target_kind/link_target_id/link_target_slug before migrating.',
      offending_slide_count;
  END IF;
END $$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE "public"."product_media_kind" AS ENUM('photo', 'video', 'spin_360');--> statement-breakpoint
CREATE TYPE "public"."commerce_product_variant_state" AS ENUM('active', 'retired');--> statement-breakpoint
CREATE TYPE "public"."commerce_product_relation_kind" AS ENUM('accessory_of', 'spare_part_of', 'consumable_for', 'compatible_with', 'complements', 'replaces');--> statement-breakpoint
CREATE TYPE "public"."commerce_product_relation_source_kind" AS ENUM('seller_declared', 'moderator_curated', 'derived_cooccurrence');--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A1. Product variants
-- ---------------------------------------------------------------------------
CREATE TABLE "commerce_product_variant" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"name" text NOT NULL,
	"public_slug" text NOT NULL,
	"sku" text,
	"price_in_cents" integer NOT NULL,
	"stock_quantity" integer DEFAULT 0 NOT NULL,
	"minimum_order_quantity" integer,
	"position" integer NOT NULL,
	"state" "commerce_product_variant_state" DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_product_variant_slug_ck" CHECK (public_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(public_slug) BETWEEN 1 AND 80),
	CONSTRAINT "commerce_product_variant_name_ck" CHECK (char_length(name) BETWEEN 1 AND 120),
	CONSTRAINT "commerce_product_variant_sku_ck" CHECK (sku IS NULL OR char_length(sku) BETWEEN 1 AND 80),
	CONSTRAINT "commerce_product_variant_money_ck" CHECK (price_in_cents >= 0 AND stock_quantity >= 0 AND position >= 0
          AND (minimum_order_quantity IS NULL OR minimum_order_quantity > 0))
);--> statement-breakpoint
ALTER TABLE "commerce_product_variant"
  ADD CONSTRAINT "commerce_product_variant_product_id_product_id_fk"
  FOREIGN KEY ("product_id") REFERENCES "public"."product"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_product_variant_slug_uidx" ON "commerce_product_variant" USING btree ("product_id","public_slug");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_product_variant_sku_uidx" ON "commerce_product_variant" USING btree ("product_id","sku");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_product_variant_position_uidx" ON "commerce_product_variant" USING btree ("product_id","position");--> statement-breakpoint
CREATE INDEX "commerce_product_variant_product_state_idx" ON "commerce_product_variant" USING btree ("product_id","state","position");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A6. Product highlights
-- ---------------------------------------------------------------------------
CREATE TABLE "commerce_product_highlight" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"title" text NOT NULL,
	"body_text" text NOT NULL,
	"image_url" text,
	"position" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_product_highlight_title_ck" CHECK (char_length(title) BETWEEN 1 AND 120),
	CONSTRAINT "commerce_product_highlight_body_ck" CHECK (char_length(body_text) BETWEEN 1 AND 2000),
	CONSTRAINT "commerce_product_highlight_position_ck" CHECK (position >= 0),
	CONSTRAINT "commerce_product_highlight_image_ck" CHECK (image_url IS NULL OR (char_length(image_url) <= 2048 AND image_url LIKE 'https://%'))
);--> statement-breakpoint
ALTER TABLE "commerce_product_highlight"
  ADD CONSTRAINT "commerce_product_highlight_product_id_product_id_fk"
  FOREIGN KEY ("product_id") REFERENCES "public"."product"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_product_highlight_position_uidx" ON "commerce_product_highlight" USING btree ("product_id","position");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A7 / §15.3. The product relation graph — the first table in this schema with
-- two foreign keys to product.
-- ---------------------------------------------------------------------------
CREATE TABLE "commerce_product_relation" (
	"id" text PRIMARY KEY NOT NULL,
	"from_product_id" text NOT NULL,
	"to_product_id" text NOT NULL,
	"relation_kind" "commerce_product_relation_kind" NOT NULL,
	"source_kind" "commerce_product_relation_source_kind" DEFAULT 'seller_declared' NOT NULL,
	"rank" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" text,
	"created_by_organization_id" text,
	"verified_by_user_id" text,
	"verified_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_product_relation_self_ck" CHECK (from_product_id <> to_product_id),
	CONSTRAINT "commerce_product_relation_rank_ck" CHECK (rank >= 0 AND rank <= 10000),
	CONSTRAINT "commerce_product_relation_verified_ck" CHECK ((source_kind = 'moderator_curated'
             AND verified_by_user_id IS NOT NULL AND verified_at IS NOT NULL)
          OR (source_kind <> 'moderator_curated'
             AND verified_by_user_id IS NULL AND verified_at IS NULL))
);--> statement-breakpoint
ALTER TABLE "commerce_product_relation"
  ADD CONSTRAINT "commerce_product_relation_from_product_id_product_id_fk"
  FOREIGN KEY ("from_product_id") REFERENCES "public"."product"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_product_relation"
  ADD CONSTRAINT "commerce_product_relation_to_product_id_product_id_fk"
  FOREIGN KEY ("to_product_id") REFERENCES "public"."product"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_product_relation"
  ADD CONSTRAINT "commerce_product_relation_created_by_user_id_user_id_fk"
  FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_product_relation"
  ADD CONSTRAINT "commerce_product_relation_created_by_organization_id_commerce_organization_id_fk"
  FOREIGN KEY ("created_by_organization_id") REFERENCES "public"."commerce_organization"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_product_relation"
  ADD CONSTRAINT "commerce_product_relation_verified_by_user_id_user_id_fk"
  FOREIGN KEY ("verified_by_user_id") REFERENCES "public"."user"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_product_relation_edge_uidx" ON "commerce_product_relation" USING btree ("from_product_id","to_product_id","relation_kind");--> statement-breakpoint
CREATE INDEX "commerce_product_relation_from_idx" ON "commerce_product_relation" USING btree ("from_product_id","relation_kind","rank","id");--> statement-breakpoint
CREATE INDEX "commerce_product_relation_to_idx" ON "commerce_product_relation" USING btree ("to_product_id","relation_kind");--> statement-breakpoint
CREATE INDEX "commerce_product_relation_org_idx" ON "commerce_product_relation" USING btree ("created_by_organization_id") WHERE created_by_organization_id IS NOT NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A5. Packaging geometry and mass on product.
-- ---------------------------------------------------------------------------
ALTER TABLE "product" ADD COLUMN "package_length_mm" integer;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "package_width_mm" integer;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "package_height_mm" integer;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "package_gross_weight_grams" integer;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "units_per_package" integer;--> statement-breakpoint
ALTER TABLE "product"
  ADD CONSTRAINT "product_package_dimensions_ck" CHECK (
    (package_length_mm IS NULL AND package_width_mm IS NULL AND package_height_mm IS NULL)
    OR (package_length_mm IS NOT NULL AND package_width_mm IS NOT NULL
        AND package_height_mm IS NOT NULL
        AND package_length_mm BETWEEN 1 AND 50000
        AND package_width_mm BETWEEN 1 AND 50000
        AND package_height_mm BETWEEN 1 AND 50000)
  );--> statement-breakpoint
ALTER TABLE "product"
  ADD CONSTRAINT "product_package_mass_ck" CHECK (
    package_gross_weight_grams IS NULL
    OR package_gross_weight_grams BETWEEN 1 AND 50000000
  );--> statement-breakpoint
ALTER TABLE "product"
  ADD CONSTRAINT "product_units_per_package_ck" CHECK (
    units_per_package IS NULL OR units_per_package BETWEEN 1 AND 1000000
  );--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A2 + A1. Media kinds and per-variant galleries on product_image.
-- ---------------------------------------------------------------------------
ALTER TABLE "product_image" ADD COLUMN "variant_id" text;--> statement-breakpoint
ALTER TABLE "product_image" ADD COLUMN "media_kind" "product_media_kind" DEFAULT 'photo' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_image" ADD COLUMN "alt_text" text;--> statement-breakpoint
ALTER TABLE "product_image" ADD COLUMN "width_px" integer;--> statement-breakpoint
ALTER TABLE "product_image" ADD COLUMN "height_px" integer;--> statement-breakpoint
ALTER TABLE "product_image"
  ADD CONSTRAINT "product_image_variant_id_commerce_product_variant_id_fk"
  FOREIGN KEY ("variant_id") REFERENCES "public"."commerce_product_variant"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_image"
  ADD CONSTRAINT "product_image_position_ck" CHECK (position >= 0);--> statement-breakpoint
ALTER TABLE "product_image"
  ADD CONSTRAINT "product_image_alt_text_ck" CHECK (
    alt_text IS NULL OR char_length(alt_text) BETWEEN 1 AND 300
  );--> statement-breakpoint
ALTER TABLE "product_image"
  ADD CONSTRAINT "product_image_dimensions_ck" CHECK (
    (width_px IS NULL AND height_px IS NULL)
    OR (width_px IS NOT NULL AND height_px IS NOT NULL
        AND width_px BETWEEN 1 AND 20000 AND height_px BETWEEN 1 AND 20000)
  );--> statement-breakpoint
CREATE INDEX "product_image_variantId_idx" ON "product_image" USING btree ("variant_id") WHERE variant_id IS NOT NULL;--> statement-breakpoint

-- A19: position 0 is the main image by convention, and two rows could claim it.
-- Written over coalesce(variant_id, '') because Postgres UNIQUE permits many NULLs
-- and a per-variant gallery has its own position 0.
--
-- De-duplicate first: keep the oldest row at each position and re-pack the gallery,
-- in ONE statement so no intermediate state can collide with the new index.
WITH ranked AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "product_id", coalesce("variant_id", '')
      ORDER BY "position", "created_at", "id"
    ) - 1 AS packed_position
  FROM "product_image"
)
UPDATE "product_image" AS target
SET "position" = ranked.packed_position
FROM ranked
WHERE target."id" = ranked."id" AND target."position" <> ranked.packed_position;--> statement-breakpoint
CREATE UNIQUE INDEX "product_image_position_uidx" ON "product_image" USING btree ("product_id", coalesce("variant_id", ''), "position");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A1. Per-variant pricing ladders.
-- ---------------------------------------------------------------------------
ALTER TABLE "product_pricing_tier" ADD COLUMN "variant_id" text;--> statement-breakpoint
ALTER TABLE "product_pricing_tier"
  ADD CONSTRAINT "product_pricing_tier_variant_id_commerce_product_variant_id_fk"
  FOREIGN KEY ("variant_id") REFERENCES "public"."commerce_product_variant"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_pricing_tier_variantId_idx" ON "product_pricing_tier" USING btree ("variant_id") WHERE variant_id IS NOT NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A3. Specification grouping.
-- ---------------------------------------------------------------------------
ALTER TABLE "commerce_product_specification" ADD COLUMN "specification_group" text;--> statement-breakpoint
ALTER TABLE "commerce_product_specification"
  ADD CONSTRAINT "commerce_product_specification_group_ck" CHECK (
    specification_group IS NULL OR char_length(specification_group) BETWEEN 1 AND 80
  );--> statement-breakpoint
CREATE INDEX "commerce_product_specification_group_idx" ON "commerce_product_specification" USING btree ("product_id","specification_group","position");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A19. Hero-slide link targets are all-or-nothing; pathway items get the time
-- window that rail placements have carried since Phase 1.
-- ---------------------------------------------------------------------------
ALTER TABLE "store_hero_slide"
  ADD CONSTRAINT "store_hero_slide_link_target_ck" CHECK (
    (link_target_kind IS NULL AND link_target_id IS NULL AND link_target_slug IS NULL)
    OR (link_target_kind IS NOT NULL AND link_target_id IS NOT NULL
        AND link_target_slug IS NOT NULL)
  );--> statement-breakpoint
ALTER TABLE "store_pathway_item" ADD COLUMN "starts_at" timestamp;--> statement-breakpoint
ALTER TABLE "store_pathway_item" ADD COLUMN "ends_at" timestamp;--> statement-breakpoint
ALTER TABLE "store_pathway_item"
  ADD CONSTRAINT "store_pathway_item_window_ck" CHECK (
    starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at
  );--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A1. Variants reach the cart, the reservation and the immutable order line.
-- ---------------------------------------------------------------------------
ALTER TABLE "commerce_cart_product_line" ADD COLUMN "variant_id" text;--> statement-breakpoint
ALTER TABLE "commerce_cart_product_line"
  ADD CONSTRAINT "commerce_cart_product_line_variant_id_commerce_product_variant_id_fk"
  FOREIGN KEY ("variant_id") REFERENCES "public"."commerce_product_variant"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Two colours of one product are two lines; the same colour twice is one line.
DROP INDEX IF EXISTS "commerce_cart_product_line_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_cart_product_line_uidx" ON "commerce_cart_product_line" USING btree ("cart_id","product_id", coalesce("variant_id", ''));--> statement-breakpoint
CREATE INDEX "commerce_cart_product_line_variant_idx" ON "commerce_cart_product_line" USING btree ("variant_id") WHERE variant_id IS NOT NULL;--> statement-breakpoint

ALTER TABLE "commerce_inventory_reservation" ADD COLUMN "variant_id" text;--> statement-breakpoint
ALTER TABLE "commerce_inventory_reservation"
  ADD CONSTRAINT "commerce_inventory_reservation_variant_id_commerce_product_variant_id_fk"
  FOREIGN KEY ("variant_id") REFERENCES "public"."commerce_product_variant"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Reserving ten "Sea blue" must not consume "Signal red" stock, so one prepare may
-- hold two variants of the same product.
DROP INDEX IF EXISTS "commerce_inventory_reservation_prepare_product_held_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_inventory_reservation_prepare_product_held_uidx" ON "commerce_inventory_reservation" USING btree ("checkout_prepare_id","product_id", coalesce("variant_id", '')) WHERE state = 'held' AND checkout_prepare_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "commerce_inventory_reservation_variant_state_idx" ON "commerce_inventory_reservation" USING btree ("variant_id","state","expires_at") WHERE variant_id IS NOT NULL;--> statement-breakpoint

ALTER TABLE "commerce_order_product_line" ADD COLUMN "variant_id" text;--> statement-breakpoint
ALTER TABLE "commerce_order_product_line" ADD COLUMN "variant_name_snapshot" text;--> statement-breakpoint
ALTER TABLE "commerce_order_product_line"
  ADD CONSTRAINT "commerce_order_product_line_variant_id_commerce_product_variant_id_fk"
  FOREIGN KEY ("variant_id") REFERENCES "public"."commerce_product_variant"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_order_product_line"
  ADD CONSTRAINT "commerce_order_product_line_variant_ck" CHECK (
    (variant_id IS NULL AND variant_name_snapshot IS NULL)
    OR (variant_id IS NOT NULL AND variant_name_snapshot IS NOT NULL
        AND char_length(variant_name_snapshot) BETWEEN 1 AND 120)
  );--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Relationship guards. "A product with any active variant requires a variant on
-- the line" spans two tables, so it cannot be a CHECK. The services enforce it
-- under row locks; these triggers make a direct write fail the same way, which is
-- the Phase 6/7 posture — if a rule must survive DevTools and request replay (§0),
-- the database is the last place it can be true.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "commerce_cart_product_line_variant_guard_fn"()
RETURNS trigger AS $$
DECLARE
  active_variant_count integer;
  owning_product_id text;
  owning_variant_state text;
BEGIN
  SELECT count(*) INTO active_variant_count
  FROM "commerce_product_variant"
  WHERE "product_id" = NEW."product_id" AND "state" = 'active';

  IF NEW."variant_id" IS NULL THEN
    IF active_variant_count > 0 THEN
      RAISE EXCEPTION
        'commerce_cart_product_line % omits a variant for product %, which has % active variant(s)',
        NEW."id", NEW."product_id", active_variant_count
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  SELECT "product_id", "state"::text INTO owning_product_id, owning_variant_state
  FROM "commerce_product_variant"
  WHERE "id" = NEW."variant_id";

  IF owning_product_id IS DISTINCT FROM NEW."product_id" THEN
    RAISE EXCEPTION
      'commerce_cart_product_line % references variant % which does not belong to product %',
      NEW."id", NEW."variant_id", NEW."product_id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF owning_variant_state <> 'active' THEN
    RAISE EXCEPTION
      'commerce_cart_product_line % references retired variant %',
      NEW."id", NEW."variant_id"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "commerce_cart_product_line_variant_guard"
  BEFORE INSERT OR UPDATE ON "commerce_cart_product_line"
  FOR EACH ROW EXECUTE FUNCTION "commerce_cart_product_line_variant_guard_fn"();--> statement-breakpoint

-- Ownership-only guard, reused by the historical and reservation tables. An order
-- line must survive its variant being retired after the sale (§2.2), so active
-- state is deliberately NOT checked here.
CREATE OR REPLACE FUNCTION "commerce_variant_ownership_guard_fn"()
RETURNS trigger AS $$
DECLARE
  owning_product_id text;
BEGIN
  IF NEW."variant_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "product_id" INTO owning_product_id
  FROM "commerce_product_variant"
  WHERE "id" = NEW."variant_id";

  IF owning_product_id IS DISTINCT FROM NEW."product_id" THEN
    RAISE EXCEPTION
      '%.% references variant % which does not belong to product %',
      TG_TABLE_NAME, NEW."id", NEW."variant_id", NEW."product_id"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "commerce_order_product_line_variant_guard"
  BEFORE INSERT OR UPDATE ON "commerce_order_product_line"
  FOR EACH ROW EXECUTE FUNCTION "commerce_variant_ownership_guard_fn"();--> statement-breakpoint
CREATE TRIGGER "commerce_inventory_reservation_variant_guard"
  BEFORE INSERT OR UPDATE ON "commerce_inventory_reservation"
  FOR EACH ROW EXECUTE FUNCTION "commerce_variant_ownership_guard_fn"();--> statement-breakpoint
CREATE TRIGGER "product_image_variant_guard"
  BEFORE INSERT OR UPDATE ON "product_image"
  FOR EACH ROW EXECUTE FUNCTION "commerce_variant_ownership_guard_fn"();--> statement-breakpoint
CREATE TRIGGER "product_pricing_tier_variant_guard"
  BEFORE INSERT OR UPDATE ON "product_pricing_tier"
  FOR EACH ROW EXECUTE FUNCTION "commerce_variant_ownership_guard_fn"();
