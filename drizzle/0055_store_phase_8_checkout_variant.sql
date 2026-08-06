-- Store Phase 8 — carry the chosen variant through the checkout snapshot.
--
-- Completes the A1 thread: migration 0054 put `variant_id` on the cart line, the
-- inventory reservation and the order line, but the row confirm actually builds an
-- order FROM is `commerce_checkout_prepare_product_line`. Without the variant here,
-- confirm would have to re-read it from the cart — recomputing a commercial fact
-- from mutable data, which §0 forbids and §2.2 forbids again once it reaches an
-- order snapshot.

ALTER TABLE "commerce_checkout_prepare_product_line" ADD COLUMN "variant_id" text;--> statement-breakpoint
ALTER TABLE "commerce_checkout_prepare_product_line" ADD COLUMN "variant_name_snapshot" text;--> statement-breakpoint
ALTER TABLE "commerce_checkout_prepare_product_line"
  ADD CONSTRAINT "commerce_checkout_prepare_product_line_variant_id_commerce_product_variant_id_fk"
  FOREIGN KEY ("variant_id") REFERENCES "public"."commerce_product_variant"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_checkout_prepare_product_line"
  ADD CONSTRAINT "commerce_checkout_prepare_product_line_variant_ck" CHECK (
    (variant_id IS NULL AND variant_name_snapshot IS NULL)
    OR (variant_id IS NOT NULL AND variant_name_snapshot IS NOT NULL
        AND char_length(variant_name_snapshot) BETWEEN 1 AND 120)
  );--> statement-breakpoint

-- One prepare may carry two colours of the same product, so the Phase 4 pair
-- uniqueness becomes variant-aware for the same reason the cart line's did.
DROP INDEX IF EXISTS "commerce_checkout_prepare_product_line_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_checkout_prepare_product_line_uidx" ON "commerce_checkout_prepare_product_line" USING btree ("prepare_id","product_id", coalesce("variant_id", ''));--> statement-breakpoint
CREATE INDEX "commerce_checkout_prepare_product_line_variant_idx" ON "commerce_checkout_prepare_product_line" USING btree ("variant_id") WHERE variant_id IS NOT NULL;--> statement-breakpoint

CREATE TRIGGER "commerce_checkout_prepare_product_line_variant_guard"
  BEFORE INSERT OR UPDATE ON "commerce_checkout_prepare_product_line"
  FOR EACH ROW EXECUTE FUNCTION "commerce_variant_ownership_guard_fn"();
