-- Store Phase 11 / Appendix A18 — seller-declared customization the server enforces.
--
-- Nothing existed for this. The frontend renders four upload slots, each with its own
-- accepted file types and minimum order quantity, plus a packaging-material choice with
-- minimums of its own — and enforces none of it, because there was nothing to enforce
-- against.
--
-- THE RULE THAT SHAPES THESE TABLES (§A18): the per-slot minimum order quantity is a
-- COMMERCIAL TERM. A logo at 50 units and packaging artwork at 200 change what the
-- buyer may order. The server enforces it at cart and at checkout; the client's copy of
-- the number is a hint.
--
-- HAND-WRITTEN, like every store-phase migration since 0046. Depends on 0059 for
-- `commerce_product_customization_kind`, `commerce_product_customization_option_state`
-- and the `customization_artwork` document kind.

-- ---------------------------------------------------------------------------
-- What a seller offers.
--
-- Two kinds, because an upload slot and a choice slot differ in what the buyer
-- supplies: one needs an encrypted document, the other a value from a list. A single
-- nullable-everything row would let a selection carry neither.
--
-- RETIRE, NEVER DELETE. An order line references the option it was bought under, so a
-- seller withdrawing a slot must not erase what a buyer ordered — the same rule
-- `commerce_product_variant` follows, and the reason this is not the delete-and-reinsert
-- shape `commerce_product_highlight` uses.
-- ---------------------------------------------------------------------------
CREATE TABLE "commerce_product_customization_option" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"slot_key" text NOT NULL,
	"label" text NOT NULL,
	"customization_kind" "commerce_product_customization_kind" NOT NULL,
	"accepted_media_types" text[] DEFAULT '{}' NOT NULL,
	"choice_values" text[] DEFAULT '{}' NOT NULL,
	"minimum_order_quantity" integer DEFAULT 1 NOT NULL,
	"is_required" boolean DEFAULT false NOT NULL,
	"position" integer NOT NULL,
	"state" "commerce_product_customization_option_state" DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_product_customization_option_slot_key_ck" CHECK (slot_key ~ '^[a-z0-9]+(_[a-z0-9]+)*$' AND char_length(slot_key) BETWEEN 1 AND 60),
	CONSTRAINT "commerce_product_customization_option_label_ck" CHECK (char_length(label) BETWEEN 1 AND 120),
	CONSTRAINT "commerce_product_customization_option_moq_ck" CHECK (minimum_order_quantity BETWEEN 1 AND 1000000),
	CONSTRAINT "commerce_product_customization_option_position_ck" CHECK (position >= 0),
	-- Each kind must carry the vocabulary it needs and only that vocabulary. An upload
	-- slot with no accepted types would accept anything; a choice slot with no values
	-- offers nothing to choose.
	CONSTRAINT "commerce_product_customization_option_kind_ck" CHECK (
	  (customization_kind = 'file_upload'
	     AND cardinality(accepted_media_types) > 0 AND cardinality(choice_values) = 0)
	  OR (customization_kind = 'choice'
	     AND cardinality(choice_values) > 0 AND cardinality(accepted_media_types) = 0)
	)
);--> statement-breakpoint
ALTER TABLE "commerce_product_customization_option"
  ADD CONSTRAINT "commerce_product_customization_option_product_id_product_id_fk"
  FOREIGN KEY ("product_id") REFERENCES "public"."product"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_product_customization_option_slot_uidx"
  ON "commerce_product_customization_option" USING btree ("product_id","slot_key");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_product_customization_option_position_uidx"
  ON "commerce_product_customization_option" USING btree ("product_id","position");--> statement-breakpoint
CREATE INDEX "commerce_product_customization_option_active_idx"
  ON "commerce_product_customization_option" USING btree ("product_id","state","position");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- What a buyer supplied, at each stage of the snapshot chain.
--
-- THREE TABLES, NOT ONE, and the reason is `confirmCheckout`: it builds an order line
-- VERBATIM from the prepare row and never re-reads the cart. A selection that does not
-- exist on the prepare cannot reach an order, so the chain has to carry it the whole
-- way — exactly as the variant name snapshot does.
--
-- `slot_key_snapshot` and `label_snapshot` are stored beside the option pointer because
-- a seller may rename a slot after the sale, and what the buyer agreed to is what the
-- order must say.
-- ---------------------------------------------------------------------------
CREATE TABLE "commerce_cart_line_customization" (
	"id" text PRIMARY KEY NOT NULL,
	"cart_product_line_id" text NOT NULL,
	"customization_option_id" text NOT NULL,
	"encrypted_document_id" text,
	"choice_value" text,
	"slot_key_snapshot" text NOT NULL,
	"label_snapshot" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_cart_line_customization_supply_ck" CHECK (
	  (encrypted_document_id IS NOT NULL AND choice_value IS NULL)
	  OR (encrypted_document_id IS NULL AND choice_value IS NOT NULL)
	)
);--> statement-breakpoint
ALTER TABLE "commerce_cart_line_customization"
  ADD CONSTRAINT "commerce_cart_line_customization_line_fk"
  FOREIGN KEY ("cart_product_line_id") REFERENCES "public"."commerce_cart_product_line"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_cart_line_customization"
  ADD CONSTRAINT "commerce_cart_line_customization_option_fk"
  FOREIGN KEY ("customization_option_id") REFERENCES "public"."commerce_product_customization_option"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_cart_line_customization"
  ADD CONSTRAINT "commerce_cart_line_customization_document_fk"
  FOREIGN KEY ("encrypted_document_id") REFERENCES "public"."commerce_encrypted_document"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_cart_line_customization_slot_uidx"
  ON "commerce_cart_line_customization" USING btree ("cart_product_line_id","slot_key_snapshot");--> statement-breakpoint

CREATE TABLE "commerce_checkout_prepare_line_customization" (
	"id" text PRIMARY KEY NOT NULL,
	"prepare_product_line_id" text NOT NULL,
	"customization_option_id" text NOT NULL,
	"encrypted_document_id" text,
	"choice_value" text,
	"slot_key_snapshot" text NOT NULL,
	"label_snapshot" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_checkout_prepare_line_customization_supply_ck" CHECK (
	  (encrypted_document_id IS NOT NULL AND choice_value IS NULL)
	  OR (encrypted_document_id IS NULL AND choice_value IS NOT NULL)
	)
);--> statement-breakpoint
ALTER TABLE "commerce_checkout_prepare_line_customization"
  ADD CONSTRAINT "commerce_checkout_prepare_line_customization_line_fk"
  FOREIGN KEY ("prepare_product_line_id") REFERENCES "public"."commerce_checkout_prepare_product_line"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_checkout_prepare_line_customization"
  ADD CONSTRAINT "commerce_checkout_prepare_line_customization_option_fk"
  FOREIGN KEY ("customization_option_id") REFERENCES "public"."commerce_product_customization_option"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_checkout_prepare_line_customization"
  ADD CONSTRAINT "commerce_checkout_prepare_line_customization_document_fk"
  FOREIGN KEY ("encrypted_document_id") REFERENCES "public"."commerce_encrypted_document"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_checkout_prepare_line_customization_slot_uidx"
  ON "commerce_checkout_prepare_line_customization" USING btree ("prepare_product_line_id","slot_key_snapshot");--> statement-breakpoint

CREATE TABLE "commerce_order_line_customization" (
	"id" text PRIMARY KEY NOT NULL,
	"order_product_line_id" text NOT NULL,
	"customization_option_id" text NOT NULL,
	"encrypted_document_id" text,
	"choice_value" text,
	"slot_key_snapshot" text NOT NULL,
	"label_snapshot" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_order_line_customization_supply_ck" CHECK (
	  (encrypted_document_id IS NOT NULL AND choice_value IS NULL)
	  OR (encrypted_document_id IS NULL AND choice_value IS NOT NULL)
	)
);--> statement-breakpoint
ALTER TABLE "commerce_order_line_customization"
  ADD CONSTRAINT "commerce_order_line_customization_line_fk"
  FOREIGN KEY ("order_product_line_id") REFERENCES "public"."commerce_order_product_line"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_order_line_customization"
  ADD CONSTRAINT "commerce_order_line_customization_option_fk"
  FOREIGN KEY ("customization_option_id") REFERENCES "public"."commerce_product_customization_option"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_order_line_customization"
  ADD CONSTRAINT "commerce_order_line_customization_document_fk"
  FOREIGN KEY ("encrypted_document_id") REFERENCES "public"."commerce_encrypted_document"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_order_line_customization_slot_uidx"
  ON "commerce_order_line_customization" USING btree ("order_product_line_id","slot_key_snapshot");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The guard a CHECK cannot express: a selection must name an option belonging to the
-- product on its own line. Without this, a buyer could attach another seller's slot —
-- and with it another seller's minimum order quantity — to a line.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "commerce_cart_line_customization_option_guard_fn"()
RETURNS trigger AS $$
DECLARE
  line_product_id text;
  option_product_id text;
BEGIN
  SELECT "product_id" INTO line_product_id
  FROM "commerce_cart_product_line" WHERE "id" = NEW."cart_product_line_id";

  SELECT "product_id" INTO option_product_id
  FROM "commerce_product_customization_option" WHERE "id" = NEW."customization_option_id";

  IF option_product_id IS DISTINCT FROM line_product_id THEN
    RAISE EXCEPTION
      'commerce_cart_line_customization % references option % which belongs to product %, not %',
      NEW."id", NEW."customization_option_id", option_product_id, line_product_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "commerce_cart_line_customization_option_guard"
  BEFORE INSERT OR UPDATE ON "commerce_cart_line_customization"
  FOR EACH ROW EXECUTE FUNCTION "commerce_cart_line_customization_option_guard_fn"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "commerce_prepare_line_customization_option_guard_fn"()
RETURNS trigger AS $$
DECLARE
  line_product_id text;
  option_product_id text;
BEGIN
  SELECT "product_id" INTO line_product_id
  FROM "commerce_checkout_prepare_product_line" WHERE "id" = NEW."prepare_product_line_id";

  SELECT "product_id" INTO option_product_id
  FROM "commerce_product_customization_option" WHERE "id" = NEW."customization_option_id";

  IF option_product_id IS DISTINCT FROM line_product_id THEN
    RAISE EXCEPTION
      'commerce_checkout_prepare_line_customization % references option % which belongs to product %, not %',
      NEW."id", NEW."customization_option_id", option_product_id, line_product_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "commerce_prepare_line_customization_option_guard"
  BEFORE INSERT OR UPDATE ON "commerce_checkout_prepare_line_customization"
  FOR EACH ROW EXECUTE FUNCTION "commerce_prepare_line_customization_option_guard_fn"();--> statement-breakpoint

/*
 * The ORDER line guard is deliberately weaker: it checks nothing about the product,
 * because `commerce_order_product_line.product_id` is nullable — a delisted product
 * leaves the snapshot standing and the pointer gone — and an order line must survive
 * that. What it was bought under is recorded in the snapshots beside the pointer.
 */
CREATE INDEX "commerce_order_line_customization_option_idx"
  ON "commerce_order_line_customization" USING btree ("customization_option_id");
