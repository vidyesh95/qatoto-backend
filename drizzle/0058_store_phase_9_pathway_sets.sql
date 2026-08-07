-- Store Phase 9 — guided pathways: slots, candidates, anchors and authoring (§15).
--
-- A pathway is a SET, not a rail. `store_pathway_item` modelled a flat ordered list
-- of (entity_kind, entity_id) with an un-FK'd entity_id, which is wrong for a set in
-- three ways (§15.2): a dead member vanished silently, the read was unbounded, and a
-- member could not be swapped. This replaces it with a role (`store_pathway_slot`)
-- filled by ranked candidates (`store_pathway_slot_candidate`).
--
-- HAND-WRITTEN, like every store-phase migration since 0046.
--
-- Additive: `store_pathway_item` is KEPT and backfilled, not dropped, so a running
-- pre-Phase-9 application still serves pathways from the old table while the new one
-- fills. Dropping it belongs to a later migration once no deployment reads it.
--
-- Depends on 0057 for 'pending_review' and the new audit event kinds.

-- ---------------------------------------------------------------------------
-- Preflight. Only product items can honestly become slots: a slot candidate has a
-- real foreign key to `product`, and there is no truthful slot to convert a category
-- or an organization placement into. Refuse loudly rather than dropping rows.
-- (Nothing in the application has ever been able to write a pathway item, so this is
-- expected to find zero.)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  non_product_item_count integer;
  duplicate_position_count integer;
BEGIN
  SELECT count(*) INTO non_product_item_count
  FROM "store_pathway_item"
  WHERE "entity_kind" <> 'product';

  IF non_product_item_count > 0 THEN
    RAISE EXCEPTION
      'Store Phase 9 preflight: % store_pathway_item row(s) are not products and cannot become slots. Move them to a rail or delete them before migrating.',
      non_product_item_count;
  END IF;

  -- store_pathway_item is unique on (pathway, kind, entity) but NOT on position, and
  -- a slot's sibling_order is unique per pathway. Two items sharing a position would
  -- fail the backfill with a bare unique violation; say what is actually wrong.
  SELECT count(*) INTO duplicate_position_count
  FROM (
    SELECT "pathway_id", "position"
    FROM "store_pathway_item"
    WHERE "entity_kind" = 'product'
    GROUP BY "pathway_id", "position"
    HAVING count(*) > 1
  ) AS duplicated;

  IF duplicate_position_count > 0 THEN
    RAISE EXCEPTION
      'Store Phase 9 preflight: % (pathway, position) pair(s) are shared by more than one store_pathway_item. Renumber positions before migrating.',
      duplicate_position_count;
  END IF;
END $$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §15.2 / §15.5. store_pathway gains the anchor, its images, and authorship.
-- ---------------------------------------------------------------------------
ALTER TABLE "store_pathway" ADD COLUMN "anchor_product_id" text;--> statement-breakpoint
ALTER TABLE "store_pathway" ADD COLUMN "hero_image_url" text;--> statement-breakpoint
ALTER TABLE "store_pathway" ADD COLUMN "card_image_url" text;--> statement-breakpoint
ALTER TABLE "store_pathway" ADD COLUMN "owner_organization_id" text;--> statement-breakpoint
ALTER TABLE "store_pathway" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "store_pathway" ADD COLUMN "submitted_at" timestamp;--> statement-breakpoint
ALTER TABLE "store_pathway" ADD COLUMN "reviewed_by_user_id" text;--> statement-breakpoint
ALTER TABLE "store_pathway" ADD COLUMN "reviewed_at" timestamp;--> statement-breakpoint
ALTER TABLE "store_pathway" ADD COLUMN "review_note" text;--> statement-breakpoint

ALTER TABLE "store_pathway"
  ADD CONSTRAINT "store_pathway_anchor_product_id_product_id_fk"
  FOREIGN KEY ("anchor_product_id") REFERENCES "public"."product"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_pathway"
  ADD CONSTRAINT "store_pathway_owner_organization_id_commerce_organization_id_fk"
  FOREIGN KEY ("owner_organization_id") REFERENCES "public"."commerce_organization"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_pathway"
  ADD CONSTRAINT "store_pathway_created_by_user_id_user_id_fk"
  FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_pathway"
  ADD CONSTRAINT "store_pathway_reviewed_by_user_id_user_id_fk"
  FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."user"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- Same shape as store_hero_slide_image_ck: an image URL is https and bounded, or absent.
ALTER TABLE "store_pathway" ADD CONSTRAINT "store_pathway_images_ck" CHECK (
  (hero_image_url IS NULL OR (char_length(hero_image_url) <= 2048 AND hero_image_url LIKE 'https://%'))
  AND (card_image_url IS NULL OR (char_length(card_image_url) <= 2048 AND card_image_url LIKE 'https://%'))
);--> statement-breakpoint

-- Review attribution is paired, only a decided state may carry it, and a SELLER
-- proposal cannot reach a decided state without a reviewer. A platform-curated
-- pathway (owner_organization_id IS NULL) may publish without one, because the
-- merchandiser publishing it IS the decision — and because legacy rows predate this
-- column entirely and must not be invalidated by it.
--
-- `state::text` RATHER THAN THE BARE ENUM, and this is not a style choice. Postgres
-- refuses "unsafe use of new value" when a statement names an enum label added by an
-- ALTER TYPE in the SAME TRANSACTION, and `pending_review`/`rejected` arrive in 0057.
-- Separate FILES are not separate transactions: drizzle-kit applies every pending
-- migration in one transaction, so on a database where 0057 and 0058 are both pending
-- — which is every fresh environment — the bare form fails and takes the whole run with
-- it. Casting to text compares strings rather than enum labels, is immutable, and so is
-- legal in a CHECK while meaning exactly the same thing.
ALTER TABLE "store_pathway" ADD CONSTRAINT "store_pathway_review_ck" CHECK (
  ((reviewed_by_user_id IS NULL) = (reviewed_at IS NULL))
  AND (reviewed_at IS NULL OR state::text IN ('active', 'rejected'))
  AND (
    owner_organization_id IS NULL
    OR state::text NOT IN ('active', 'rejected')
    OR reviewed_by_user_id IS NOT NULL
  )
  AND (state::text <> 'pending_review' OR submitted_at IS NOT NULL)
);--> statement-breakpoint

ALTER TABLE "store_pathway" ADD CONSTRAINT "store_pathway_review_note_ck" CHECK (
  review_note IS NULL OR char_length(review_note) BETWEEN 1 AND 2000
);--> statement-breakpoint

CREATE INDEX "store_pathway_owner_idx" ON "store_pathway" USING btree ("owner_organization_id","state","id") WHERE "owner_organization_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "store_pathway_anchor_idx" ON "store_pathway" USING btree ("anchor_product_id") WHERE "anchor_product_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "store_pathway_moderation_queue_idx" ON "store_pathway" USING btree ("state","submitted_at","id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §15.2. A slot is a ROLE in the set, not a product.
--
-- `role_label` is free text on purpose, like specification_group in A3: the roles in
-- a hotel refit and a bicycle build share nothing, so an enum would be wrong in every
-- category it did not anticipate.
--
-- `derived_relation_kind` is what makes an anchored set an anchored set (§15.1): the
-- slot names an edge kind and its candidates are resolved from the relation graph at
-- read time rather than typed by a merchandiser.
-- ---------------------------------------------------------------------------
CREATE TABLE "store_pathway_slot" (
	"id" text PRIMARY KEY NOT NULL,
	"pathway_id" text NOT NULL,
	"role_label" text NOT NULL,
	"is_required" boolean DEFAULT true NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"sibling_order" integer NOT NULL,
	"derived_relation_kind" "commerce_product_relation_kind",
	"starts_at" timestamp,
	"ends_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "store_pathway_slot_role_label_ck" CHECK (char_length(role_label) BETWEEN 1 AND 80),
	CONSTRAINT "store_pathway_slot_quantity_ck" CHECK (quantity BETWEEN 1 AND 1000000),
	CONSTRAINT "store_pathway_slot_order_ck" CHECK (sibling_order >= 0),
	CONSTRAINT "store_pathway_slot_window_ck" CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
);--> statement-breakpoint
ALTER TABLE "store_pathway_slot"
  ADD CONSTRAINT "store_pathway_slot_pathway_id_store_pathway_id_fk"
  FOREIGN KEY ("pathway_id") REFERENCES "public"."store_pathway"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "store_pathway_slot_order_uidx" ON "store_pathway_slot" USING btree ("pathway_id","sibling_order");--> statement-breakpoint
CREATE INDEX "store_pathway_slot_pathway_idx" ON "store_pathway_slot" USING btree ("pathway_id","sibling_order","id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §15.2. Candidates are what make a swap possible, and what turn a silently
-- shrinking set into a fall-through: when rank 0 is out of stock the slot offers
-- rank 1 instead of disappearing.
--
-- `variant_id` is not in §15.2 and is required by A1: a product with active variants
-- refuses a cart line naming none, so a candidate without a variant would be a piece
-- the set advertises and cannot sell.
-- ---------------------------------------------------------------------------
CREATE TABLE "store_pathway_slot_candidate" (
	"id" text PRIMARY KEY NOT NULL,
	"slot_id" text NOT NULL,
	"product_id" text NOT NULL,
	"variant_id" text,
	"rank" integer DEFAULT 0 NOT NULL,
	"source_kind" "store_pathway_slot_candidate_source_kind" DEFAULT 'curated' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "store_pathway_slot_candidate_rank_ck" CHECK (rank >= 0 AND rank <= 10000),
	-- Only curated rows are ever stored. Derived candidates are resolved from the
	-- relation graph at read time, because a stored copy would be stale the moment a
	-- seller edits the graph.
	CONSTRAINT "store_pathway_slot_candidate_source_ck" CHECK (source_kind = 'curated')
);--> statement-breakpoint
ALTER TABLE "store_pathway_slot_candidate"
  ADD CONSTRAINT "store_pathway_slot_candidate_slot_id_store_pathway_slot_id_fk"
  FOREIGN KEY ("slot_id") REFERENCES "public"."store_pathway_slot"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_pathway_slot_candidate"
  ADD CONSTRAINT "store_pathway_slot_candidate_product_id_product_id_fk"
  FOREIGN KEY ("product_id") REFERENCES "public"."product"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_pathway_slot_candidate"
  ADD CONSTRAINT "store_pathway_slot_candidate_variant_id_commerce_product_variant_id_fk"
  FOREIGN KEY ("variant_id") REFERENCES "public"."commerce_product_variant"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- Expression index over coalesce(variant_id, ''), the shape 0054/0055 established:
-- one product in two variants is two legitimate candidates for the same slot, but the
-- same (product, variant) twice is not.
CREATE UNIQUE INDEX "store_pathway_slot_candidate_uidx"
  ON "store_pathway_slot_candidate" USING btree ("slot_id","product_id",(coalesce("variant_id", '')));--> statement-breakpoint
CREATE INDEX "store_pathway_slot_candidate_rank_idx" ON "store_pathway_slot_candidate" USING btree ("slot_id","rank","id");--> statement-breakpoint
CREATE INDEX "store_pathway_slot_candidate_product_idx" ON "store_pathway_slot_candidate" USING btree ("product_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Guards. Both express cross-table rules a CHECK cannot see.
-- ---------------------------------------------------------------------------

-- A1's rule, at the candidate: name the variant when the product has them, and let it
-- be one of that product's own ACTIVE variants. Unlike an order line (which must
-- survive a variant being retired after the sale), a candidate is a forward-looking
-- offer — a retired variant is not sellable and must not be advertised in a set.
CREATE OR REPLACE FUNCTION "store_pathway_slot_candidate_variant_guard_fn"()
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
        'store_pathway_slot_candidate % omits a variant for product %, which has % active variant(s)',
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
      'store_pathway_slot_candidate % references variant % which does not belong to product %',
      NEW."id", NEW."variant_id", NEW."product_id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF owning_variant_state IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION
      'store_pathway_slot_candidate % references variant %, which is not active',
      NEW."id", NEW."variant_id"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "store_pathway_slot_candidate_variant_guard"
  BEFORE INSERT OR UPDATE ON "store_pathway_slot_candidate"
  FOR EACH ROW EXECUTE FUNCTION "store_pathway_slot_candidate_variant_guard_fn"();--> statement-breakpoint

-- A slot cannot resolve candidates from the relation graph unless its pathway names
-- the product to resolve them from.
CREATE OR REPLACE FUNCTION "store_pathway_slot_anchor_guard_fn"()
RETURNS trigger AS $$
DECLARE
  owning_anchor_product_id text;
BEGIN
  IF NEW."derived_relation_kind" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "anchor_product_id" INTO owning_anchor_product_id
  FROM "store_pathway"
  WHERE "id" = NEW."pathway_id";

  IF owning_anchor_product_id IS NULL THEN
    RAISE EXCEPTION
      'store_pathway_slot % derives candidates from % but pathway % has no anchor product',
      NEW."id", NEW."derived_relation_kind", NEW."pathway_id"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "store_pathway_slot_anchor_guard"
  BEFORE INSERT OR UPDATE ON "store_pathway_slot"
  FOR EACH ROW EXECUTE FUNCTION "store_pathway_slot_anchor_guard_fn"();--> statement-breakpoint

-- Clearing an anchor would strand every derived slot under it, so the pathway side is
-- guarded too.
CREATE OR REPLACE FUNCTION "store_pathway_anchor_removal_guard_fn"()
RETURNS trigger AS $$
DECLARE
  derived_slot_count integer;
BEGIN
  IF NEW."anchor_product_id" IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO derived_slot_count
  FROM "store_pathway_slot"
  WHERE "pathway_id" = NEW."id" AND "derived_relation_kind" IS NOT NULL;

  IF derived_slot_count > 0 THEN
    RAISE EXCEPTION
      'store_pathway % cannot drop its anchor while % slot(s) derive candidates from it',
      NEW."id", derived_slot_count
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "store_pathway_anchor_removal_guard"
  BEFORE UPDATE ON "store_pathway"
  FOR EACH ROW EXECUTE FUNCTION "store_pathway_anchor_removal_guard_fn"();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Backfill. Every product item becomes a one-candidate slot, preserving order and
-- the A19 scheduling window.
--
-- `is_required` is false deliberately: nothing about a flat list ever asserted a
-- member was mandatory, and defaulting to true would manufacture incompleteness
-- (§15.6) on sets that were never described that way.
--
-- Items whose product has active variants are skipped rather than guessed at — the
-- guard above would reject them, and picking a variant on the seller's behalf would
-- put a colour nobody chose into a buyer's cart. They are reported, not silently
-- dropped.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  skipped_variant_item_count integer;
BEGIN
  WITH inserted_slot AS (
    INSERT INTO "store_pathway_slot" (
      "id", "pathway_id", "role_label", "is_required", "quantity",
      "sibling_order", "starts_at", "ends_at", "created_at"
    )
    SELECT
      gen_random_uuid()::text,
      item."pathway_id",
      left(owning_product."title", 80),
      false,
      1,
      item."position",
      item."starts_at",
      item."ends_at",
      item."created_at"
    FROM "store_pathway_item" AS item
    JOIN "product" AS owning_product ON owning_product."id" = item."entity_id"
    WHERE item."entity_kind" = 'product'
      AND NOT EXISTS (
        SELECT 1 FROM "commerce_product_variant" AS variant
        WHERE variant."product_id" = owning_product."id" AND variant."state" = 'active'
      )
    RETURNING "id", "pathway_id", "sibling_order"
  )
  INSERT INTO "store_pathway_slot_candidate" ("id", "slot_id", "product_id", "rank", "source_kind")
  SELECT
    gen_random_uuid()::text,
    inserted_slot."id",
    item."entity_id",
    0,
    'curated'
  FROM inserted_slot
  JOIN "store_pathway_item" AS item
    ON item."pathway_id" = inserted_slot."pathway_id"
   AND item."position" = inserted_slot."sibling_order"
   AND item."entity_kind" = 'product';

  SELECT count(*) INTO skipped_variant_item_count
  FROM "store_pathway_item" AS item
  WHERE item."entity_kind" = 'product'
    AND EXISTS (
      SELECT 1 FROM "commerce_product_variant" AS variant
      WHERE variant."product_id" = item."entity_id" AND variant."state" = 'active'
    );

  IF skipped_variant_item_count > 0 THEN
    RAISE NOTICE
      'Store Phase 9 backfill: % pathway item(s) reference variant-bearing products and were not converted. Author their slots with an explicit variant.',
      skipped_variant_item_count;
  END IF;
END $$;
