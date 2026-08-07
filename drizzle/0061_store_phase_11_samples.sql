-- Store Phase 11 / Appendix A17 — samples that can actually be ordered.
--
-- `product.sample_policy` and `sample_price_in_cents` have existed since Phase 0 with a
-- CHECK binding them, a search facet, and both fields on the public projection. The
-- listing advertises a sample price; nothing in the backend could sell one. The PDP
-- renders the real fields a few lines above a mock "Get sample" button, so the mock and
-- the wire currently contradict each other.
--
-- HAND-WRITTEN, like every store-phase migration since 0046. Depends on 0059 for
-- `commerce_sample_credit_state`.
--
-- Additive: `is_sample` defaults false, so every existing row keeps its meaning.

-- ---------------------------------------------------------------------------
-- The flag, carried the whole length of the snapshot chain.
--
-- It has to reach the ORDER LINE, not just the cart: "this was a sample" is a
-- commercial fact about what was bought, the same way the variant name is, and an
-- order line that cannot say so cannot support a refundable-sample credit later.
-- ---------------------------------------------------------------------------
ALTER TABLE "commerce_cart_product_line" ADD COLUMN "is_sample" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_checkout_prepare_product_line" ADD COLUMN "is_sample" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_order_product_line" ADD COLUMN "is_sample" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_inventory_reservation" ADD COLUMN "is_sample" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Uniqueness, rewritten.
--
-- A buyer ordering a sample AND a bulk quantity of the same product is not an edge
-- case — it is the entire pattern samples exist for. Without `is_sample` in these
-- indexes the second line collides with the first and one of them is silently a
-- quantity update on the other.
--
-- SAME NAMES, NEW MEANING. That is the trap 0055 documented: a check that asserts
-- these indexes exist BY NAME passes against the old definition. The Phase 11 verifier
-- asserts they mention `is_sample` in their definition text.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS "commerce_cart_product_line_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_cart_product_line_uidx" ON "commerce_cart_product_line" USING btree ("cart_id","product_id", coalesce("variant_id", ''),"is_sample");--> statement-breakpoint

DROP INDEX IF EXISTS "commerce_checkout_prepare_product_line_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_checkout_prepare_product_line_uidx" ON "commerce_checkout_prepare_product_line" USING btree ("prepare_id","product_id", coalesce("variant_id", ''),"is_sample");--> statement-breakpoint

-- The reservation holds stock per prepare line, and a sample line reserves stock of its
-- own, so its uniqueness has to split the same way or the second hold is rejected.
DROP INDEX IF EXISTS "commerce_inventory_reservation_prepare_product_held_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_inventory_reservation_prepare_product_held_uidx" ON "commerce_inventory_reservation" USING btree ("checkout_prepare_id","product_id", coalesce("variant_id", ''),"is_sample") WHERE state = 'held' AND checkout_prepare_id IS NOT NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The credit ledger.
--
-- `refundable` is the third sample policy and has meant nothing: a buyer paid for a
-- sample and there was no mechanism to return the value against a later bulk order.
--
-- WHY A LEDGER ROW RATHER THAN A REFUND. A refund would move money twice and would
-- leave a buyer who never orders in bulk with an obligation open forever. A credit is
-- minted once when the sample order completes, spent once as a discount on a later
-- order with the SAME SELLER in the SAME CURRENCY, and can be expired. It also needs no
-- new journal kind: the discount lands before a payment intent exists, so no
-- cross-order money movement is invented — and this journal is strictly per-order.
-- ---------------------------------------------------------------------------
CREATE TABLE "commerce_sample_credit" (
	"id" text PRIMARY KEY NOT NULL,
	"buyer_organization_id" text NOT NULL,
	"seller_organization_id" text NOT NULL,
	"product_id" text NOT NULL,
	"source_order_id" text NOT NULL,
	"amount_in_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"state" "commerce_sample_credit_state" DEFAULT 'available' NOT NULL,
	"consumed_by_order_id" text,
	"consumed_at" timestamp,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_sample_credit_amount_ck" CHECK (amount_in_cents > 0),
	CONSTRAINT "commerce_sample_credit_currency_ck" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "commerce_sample_credit_parties_ck" CHECK (buyer_organization_id <> seller_organization_id),
	-- Consumption attribution and state agree in both directions, the shape
	-- commerce_product_relation_verified_ck uses for the same job.
	CONSTRAINT "commerce_sample_credit_consumption_ck" CHECK (
	  (state = 'consumed' AND consumed_by_order_id IS NOT NULL AND consumed_at IS NOT NULL)
	  OR (state <> 'consumed' AND consumed_by_order_id IS NULL AND consumed_at IS NULL)
	)
);--> statement-breakpoint
ALTER TABLE "commerce_sample_credit"
  ADD CONSTRAINT "commerce_sample_credit_buyer_organization_id_commerce_organization_id_fk"
  FOREIGN KEY ("buyer_organization_id") REFERENCES "public"."commerce_organization"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_sample_credit"
  ADD CONSTRAINT "commerce_sample_credit_seller_organization_id_commerce_organization_id_fk"
  FOREIGN KEY ("seller_organization_id") REFERENCES "public"."commerce_organization"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_sample_credit"
  ADD CONSTRAINT "commerce_sample_credit_product_id_product_id_fk"
  FOREIGN KEY ("product_id") REFERENCES "public"."product"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_sample_credit"
  ADD CONSTRAINT "commerce_sample_credit_source_order_id_commerce_order_id_fk"
  FOREIGN KEY ("source_order_id") REFERENCES "public"."commerce_order"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_sample_credit"
  ADD CONSTRAINT "commerce_sample_credit_consumed_by_order_id_commerce_order_id_fk"
  FOREIGN KEY ("consumed_by_order_id") REFERENCES "public"."commerce_order"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- One credit per sample order. Completion issuance is idempotent and can run more than
-- once for one order, so this is what stops a replay minting a second credit.
CREATE UNIQUE INDEX "commerce_sample_credit_source_order_uidx"
  ON "commerce_sample_credit" USING btree ("source_order_id");--> statement-breakpoint
-- The checkout lookup: spendable credits for this buyer, from this seller.
CREATE INDEX "commerce_sample_credit_spendable_idx"
  ON "commerce_sample_credit" USING btree ("buyer_organization_id","seller_organization_id","currency")
  WHERE state = 'available';
