CREATE TYPE "public"."commerce_inventory_reservation_state" AS ENUM('held', 'consumed', 'released', 'expired');--> statement-breakpoint
CREATE TYPE "public"."commerce_checkout_prepare_state" AS ENUM('active', 'consumed', 'superseded', 'expired');--> statement-breakpoint
CREATE TYPE "public"."commerce_checkout_group_state" AS ENUM('confirmed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."commerce_service_engagement_state" AS ENUM('awaiting_provider', 'scheduled', 'in_progress', 'awaiting_buyer', 'completed', 'cancelled', 'disputed');--> statement-breakpoint
CREATE TYPE "public"."commerce_shipment_state" AS ENUM('planned', 'in_transit', 'delivered', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."commerce_shipment_event_kind" AS ENUM('created', 'picked_up', 'in_transit', 'delivered', 'exception', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE 'cart_line_updated';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE 'cart_line_removed';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE 'checkout_prepared';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE 'checkout_confirmed';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE 'inventory_reservation_released';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE 'order_created_from_checkout';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE 'order_cancelled';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE 'shipment_created';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE 'shipment_event_recorded';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE 'service_engagement_created';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE 'service_engagement_transitioned';--> statement-breakpoint
CREATE TABLE "commerce_cart" (
	"id" text PRIMARY KEY NOT NULL,
	"buyer_organization_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commerce_cart_product_line" (
	"id" text PRIMARY KEY NOT NULL,
	"cart_id" text NOT NULL,
	"product_id" text NOT NULL,
	"quantity" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_cart_product_line_qty_ck" CHECK (quantity > 0)
);
--> statement-breakpoint
CREATE TABLE "commerce_checkout_prepare" (
	"id" text PRIMARY KEY NOT NULL,
	"cart_id" text NOT NULL,
	"buyer_organization_id" text NOT NULL,
	"state" "commerce_checkout_prepare_state" DEFAULT 'active' NOT NULL,
	"delivery_address_id" text,
	"delivery_address_snapshot" text,
	"expires_at" timestamp NOT NULL,
	"prepare_idempotency_key" text,
	"created_by_member_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commerce_checkout_prepare_product_line" (
	"id" text PRIMARY KEY NOT NULL,
	"prepare_id" text NOT NULL,
	"product_id" text NOT NULL,
	"seller_organization_id" text NOT NULL,
	"title_snapshot" text NOT NULL,
	"specification_snapshot" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_in_cents" bigint NOT NULL,
	"line_total_in_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"is_made_to_order" boolean DEFAULT false NOT NULL,
	"sibling_order" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_checkout_prepare_product_line_qty_ck" CHECK (quantity > 0),
	CONSTRAINT "commerce_checkout_prepare_product_line_money_ck" CHECK (unit_price_in_cents >= 0
          AND line_total_in_cents = (quantity::bigint * unit_price_in_cents)
          AND currency ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "commerce_checkout_prepare_currency_total" (
	"id" text PRIMARY KEY NOT NULL,
	"prepare_id" text NOT NULL,
	"currency" text NOT NULL,
	"subtotal_in_cents" bigint NOT NULL,
	"tax_in_cents" bigint DEFAULT 0 NOT NULL,
	"service_fee_in_cents" bigint DEFAULT 0 NOT NULL,
	"shipping_in_cents" bigint DEFAULT 0 NOT NULL,
	"discount_in_cents" bigint DEFAULT 0 NOT NULL,
	"total_in_cents" bigint NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_checkout_prepare_currency_ck" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "commerce_checkout_prepare_currency_money_ck" CHECK (subtotal_in_cents >= 0 AND tax_in_cents >= 0 AND service_fee_in_cents >= 0
          AND shipping_in_cents >= 0 AND discount_in_cents >= 0 AND total_in_cents >= 0
          AND total_in_cents = (subtotal_in_cents + tax_in_cents + service_fee_in_cents
              + shipping_in_cents - discount_in_cents))
);
--> statement-breakpoint
CREATE TABLE "commerce_checkout_group" (
	"id" text PRIMARY KEY NOT NULL,
	"buyer_organization_id" text NOT NULL,
	"checkout_prepare_id" text NOT NULL,
	"state" "commerce_checkout_group_state" DEFAULT 'confirmed' NOT NULL,
	"delivery_address_snapshot" text,
	"confirm_idempotency_key" text,
	"created_by_member_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commerce_checkout_group_currency_total" (
	"id" text PRIMARY KEY NOT NULL,
	"checkout_group_id" text NOT NULL,
	"currency" text NOT NULL,
	"subtotal_in_cents" bigint NOT NULL,
	"tax_in_cents" bigint DEFAULT 0 NOT NULL,
	"service_fee_in_cents" bigint DEFAULT 0 NOT NULL,
	"shipping_in_cents" bigint DEFAULT 0 NOT NULL,
	"discount_in_cents" bigint DEFAULT 0 NOT NULL,
	"total_in_cents" bigint NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_checkout_group_currency_ck" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "commerce_checkout_group_currency_money_ck" CHECK (subtotal_in_cents >= 0 AND tax_in_cents >= 0 AND service_fee_in_cents >= 0
          AND shipping_in_cents >= 0 AND discount_in_cents >= 0 AND total_in_cents >= 0
          AND total_in_cents = (subtotal_in_cents + tax_in_cents + service_fee_in_cents
              + shipping_in_cents - discount_in_cents))
);
--> statement-breakpoint
CREATE TABLE "commerce_inventory_reservation" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"buyer_organization_id" text NOT NULL,
	"cart_id" text,
	"checkout_prepare_id" text,
	"order_id" text,
	"quantity" integer NOT NULL,
	"is_made_to_order" boolean DEFAULT false NOT NULL,
	"state" "commerce_inventory_reservation_state" DEFAULT 'held' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"consumed_at" timestamp,
	"released_at" timestamp,
	CONSTRAINT "commerce_inventory_reservation_qty_ck" CHECK ((is_made_to_order = true AND quantity = 0) OR (is_made_to_order = false AND quantity > 0)),
	CONSTRAINT "commerce_inventory_reservation_owner_ck" CHECK ((
            (checkout_prepare_id IS NOT NULL AND cart_id IS NOT NULL AND order_id IS NULL)
         OR (order_id IS NOT NULL AND checkout_prepare_id IS NULL AND cart_id IS NULL)
          ))
);
--> statement-breakpoint
CREATE TABLE "commerce_service_engagement" (
	"id" text PRIMARY KEY NOT NULL,
	"buyer_organization_id" text NOT NULL,
	"provider_organization_id" text NOT NULL,
	"order_id" text NOT NULL,
	"order_service_line_id" text NOT NULL,
	"provider_kind" "commerce_provider_kind_slug" NOT NULL,
	"state" "commerce_service_engagement_state" DEFAULT 'awaiting_provider' NOT NULL,
	"title_snapshot" text NOT NULL,
	"scope_snapshot" text NOT NULL,
	"scheduled_at" timestamp,
	"started_at" timestamp,
	"completed_at" timestamp,
	"cancelled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commerce_shipment" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"state" "commerce_shipment_state" DEFAULT 'planned' NOT NULL,
	"origin_country_code" text,
	"origin_locality" text,
	"destination_country_code" text,
	"destination_locality" text,
	"package_count" integer NOT NULL,
	"total_weight_grams" integer,
	"created_by_member_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_shipment_package_ck" CHECK (package_count > 0),
	CONSTRAINT "commerce_shipment_weight_ck" CHECK (total_weight_grams IS NULL OR total_weight_grams > 0),
	CONSTRAINT "commerce_shipment_country_ck" CHECK ((origin_country_code IS NULL OR origin_country_code ~ '^[A-Z]{2}$')
          AND (destination_country_code IS NULL OR destination_country_code ~ '^[A-Z]{2}$'))
);
--> statement-breakpoint
CREATE TABLE "commerce_order_service_link" (
	"id" text PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"order_id" text NOT NULL,
	"order_service_line_id" text,
	"order_product_line_id" text,
	"shipment_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_order_service_link_target_ck" CHECK (order_service_line_id IS NOT NULL
          OR order_product_line_id IS NOT NULL
          OR shipment_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "commerce_shipment_product_line" (
	"id" text PRIMARY KEY NOT NULL,
	"shipment_id" text NOT NULL,
	"order_product_line_id" text NOT NULL,
	"quantity" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_shipment_product_line_qty_ck" CHECK (quantity > 0)
);
--> statement-breakpoint
CREATE TABLE "commerce_shipment_event" (
	"id" text PRIMARY KEY NOT NULL,
	"shipment_id" text NOT NULL,
	"event_kind" "commerce_shipment_event_kind" NOT NULL,
	"occurred_at" timestamp NOT NULL,
	"description" text,
	"created_by_member_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_shipment_event_description_ck" CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 2000)
);
--> statement-breakpoint
ALTER TABLE "commerce_order" ADD COLUMN "checkout_group_id" text;--> statement-breakpoint
ALTER TABLE "commerce_order" DROP CONSTRAINT "commerce_order_quote_source_ck";--> statement-breakpoint
ALTER TABLE "commerce_order" ADD CONSTRAINT "commerce_order_quote_source_ck" CHECK ((source = 'accepted_quote' AND accepted_quote_id IS NOT NULL
              AND accepted_quote_revision_id IS NOT NULL AND checkout_group_id IS NULL)
          OR (source = 'direct_checkout' AND accepted_quote_id IS NULL
              AND accepted_quote_revision_id IS NULL AND checkout_group_id IS NOT NULL));--> statement-breakpoint
ALTER TABLE "commerce_cart" ADD CONSTRAINT "commerce_cart_buyer_organization_id_commerce_organization_id_fk" FOREIGN KEY ("buyer_organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_cart_product_line" ADD CONSTRAINT "commerce_cart_product_line_cart_id_commerce_cart_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."commerce_cart"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_cart_product_line" ADD CONSTRAINT "commerce_cart_product_line_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_checkout_prepare" ADD CONSTRAINT "commerce_checkout_prepare_cart_id_commerce_cart_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."commerce_cart"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_checkout_prepare" ADD CONSTRAINT "commerce_checkout_prepare_buyer_organization_id_commerce_organization_id_fk" FOREIGN KEY ("buyer_organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_checkout_prepare" ADD CONSTRAINT "commerce_checkout_prepare_delivery_address_id_commerce_organization_address_id_fk" FOREIGN KEY ("delivery_address_id") REFERENCES "public"."commerce_organization_address"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_checkout_prepare" ADD CONSTRAINT "commerce_checkout_prepare_created_by_member_id_commerce_organization_member_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."commerce_organization_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_checkout_prepare_product_line" ADD CONSTRAINT "commerce_checkout_prepare_product_line_prepare_id_commerce_checkout_prepare_id_fk" FOREIGN KEY ("prepare_id") REFERENCES "public"."commerce_checkout_prepare"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_checkout_prepare_product_line" ADD CONSTRAINT "commerce_checkout_prepare_product_line_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_checkout_prepare_product_line" ADD CONSTRAINT "commerce_checkout_prepare_product_line_seller_organization_id_commerce_organization_id_fk" FOREIGN KEY ("seller_organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_checkout_prepare_currency_total" ADD CONSTRAINT "commerce_checkout_prepare_currency_total_prepare_id_commerce_checkout_prepare_id_fk" FOREIGN KEY ("prepare_id") REFERENCES "public"."commerce_checkout_prepare"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_checkout_group" ADD CONSTRAINT "commerce_checkout_group_buyer_organization_id_commerce_organization_id_fk" FOREIGN KEY ("buyer_organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_checkout_group" ADD CONSTRAINT "commerce_checkout_group_checkout_prepare_id_commerce_checkout_prepare_id_fk" FOREIGN KEY ("checkout_prepare_id") REFERENCES "public"."commerce_checkout_prepare"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_checkout_group" ADD CONSTRAINT "commerce_checkout_group_created_by_member_id_commerce_organization_member_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."commerce_organization_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_checkout_group_currency_total" ADD CONSTRAINT "commerce_checkout_group_currency_total_checkout_group_id_commerce_checkout_group_id_fk" FOREIGN KEY ("checkout_group_id") REFERENCES "public"."commerce_checkout_group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_inventory_reservation" ADD CONSTRAINT "commerce_inventory_reservation_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_inventory_reservation" ADD CONSTRAINT "commerce_inventory_reservation_buyer_organization_id_commerce_organization_id_fk" FOREIGN KEY ("buyer_organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_inventory_reservation" ADD CONSTRAINT "commerce_inventory_reservation_cart_id_commerce_cart_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."commerce_cart"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_inventory_reservation" ADD CONSTRAINT "commerce_inventory_reservation_checkout_prepare_id_commerce_checkout_prepare_id_fk" FOREIGN KEY ("checkout_prepare_id") REFERENCES "public"."commerce_checkout_prepare"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_inventory_reservation" ADD CONSTRAINT "commerce_inventory_reservation_order_id_commerce_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."commerce_order"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_service_engagement" ADD CONSTRAINT "commerce_service_engagement_buyer_organization_id_commerce_organization_id_fk" FOREIGN KEY ("buyer_organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_service_engagement" ADD CONSTRAINT "commerce_service_engagement_provider_organization_id_commerce_organization_id_fk" FOREIGN KEY ("provider_organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_service_engagement" ADD CONSTRAINT "commerce_service_engagement_order_id_commerce_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."commerce_order"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_service_engagement" ADD CONSTRAINT "commerce_service_engagement_order_service_line_id_commerce_order_service_line_id_fk" FOREIGN KEY ("order_service_line_id") REFERENCES "public"."commerce_order_service_line"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_shipment" ADD CONSTRAINT "commerce_shipment_order_id_commerce_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."commerce_order"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_shipment" ADD CONSTRAINT "commerce_shipment_created_by_member_id_commerce_organization_member_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."commerce_organization_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_order_service_link" ADD CONSTRAINT "commerce_order_service_link_engagement_id_commerce_service_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."commerce_service_engagement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_order_service_link" ADD CONSTRAINT "commerce_order_service_link_order_id_commerce_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."commerce_order"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_order_service_link" ADD CONSTRAINT "commerce_order_service_link_order_service_line_id_commerce_order_service_line_id_fk" FOREIGN KEY ("order_service_line_id") REFERENCES "public"."commerce_order_service_line"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_order_service_link" ADD CONSTRAINT "commerce_order_service_link_order_product_line_id_commerce_order_product_line_id_fk" FOREIGN KEY ("order_product_line_id") REFERENCES "public"."commerce_order_product_line"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_order_service_link" ADD CONSTRAINT "commerce_order_service_link_shipment_id_commerce_shipment_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."commerce_shipment"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_shipment_product_line" ADD CONSTRAINT "commerce_shipment_product_line_shipment_id_commerce_shipment_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."commerce_shipment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_shipment_product_line" ADD CONSTRAINT "commerce_shipment_product_line_order_product_line_id_commerce_order_product_line_id_fk" FOREIGN KEY ("order_product_line_id") REFERENCES "public"."commerce_order_product_line"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_shipment_event" ADD CONSTRAINT "commerce_shipment_event_shipment_id_commerce_shipment_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."commerce_shipment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_shipment_event" ADD CONSTRAINT "commerce_shipment_event_created_by_member_id_commerce_organization_member_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."commerce_organization_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_order" ADD CONSTRAINT "commerce_order_checkout_group_id_commerce_checkout_group_id_fk" FOREIGN KEY ("checkout_group_id") REFERENCES "public"."commerce_checkout_group"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_cart_buyer_uidx" ON "commerce_cart" USING btree ("buyer_organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_cart_product_line_uidx" ON "commerce_cart_product_line" USING btree ("cart_id","product_id");--> statement-breakpoint
CREATE INDEX "commerce_cart_product_line_cart_idx" ON "commerce_cart_product_line" USING btree ("cart_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_checkout_prepare_idempotency_uidx" ON "commerce_checkout_prepare" USING btree ("buyer_organization_id","prepare_idempotency_key") WHERE prepare_idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "commerce_checkout_prepare_state_expires_idx" ON "commerce_checkout_prepare" USING btree ("state","expires_at");--> statement-breakpoint
CREATE INDEX "commerce_checkout_prepare_cart_idx" ON "commerce_checkout_prepare" USING btree ("cart_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_checkout_prepare_product_line_uidx" ON "commerce_checkout_prepare_product_line" USING btree ("prepare_id","product_id");--> statement-breakpoint
CREATE INDEX "commerce_checkout_prepare_product_line_prepare_idx" ON "commerce_checkout_prepare_product_line" USING btree ("prepare_id","sibling_order");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_checkout_prepare_currency_total_uidx" ON "commerce_checkout_prepare_currency_total" USING btree ("prepare_id","currency");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_checkout_group_prepare_uidx" ON "commerce_checkout_group" USING btree ("checkout_prepare_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_checkout_group_idempotency_uidx" ON "commerce_checkout_group" USING btree ("buyer_organization_id","confirm_idempotency_key") WHERE confirm_idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "commerce_checkout_group_buyer_idx" ON "commerce_checkout_group" USING btree ("buyer_organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_checkout_group_currency_total_uidx" ON "commerce_checkout_group_currency_total" USING btree ("checkout_group_id","currency");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_inventory_reservation_prepare_product_held_uidx" ON "commerce_inventory_reservation" USING btree ("checkout_prepare_id","product_id") WHERE state = 'held' AND checkout_prepare_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "commerce_inventory_reservation_product_state_idx" ON "commerce_inventory_reservation" USING btree ("product_id","state","expires_at");--> statement-breakpoint
CREATE INDEX "commerce_inventory_reservation_state_expires_idx" ON "commerce_inventory_reservation" USING btree ("state","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_service_engagement_order_line_uidx" ON "commerce_service_engagement" USING btree ("order_service_line_id");--> statement-breakpoint
CREATE INDEX "commerce_service_engagement_buyer_idx" ON "commerce_service_engagement" USING btree ("buyer_organization_id","state","id");--> statement-breakpoint
CREATE INDEX "commerce_service_engagement_provider_idx" ON "commerce_service_engagement" USING btree ("provider_organization_id","state","id");--> statement-breakpoint
CREATE INDEX "commerce_shipment_order_idx" ON "commerce_shipment" USING btree ("order_id","id");--> statement-breakpoint
CREATE INDEX "commerce_order_service_link_engagement_idx" ON "commerce_order_service_link" USING btree ("engagement_id");--> statement-breakpoint
CREATE INDEX "commerce_order_service_link_order_idx" ON "commerce_order_service_link" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_shipment_product_line_uidx" ON "commerce_shipment_product_line" USING btree ("shipment_id","order_product_line_id");--> statement-breakpoint
CREATE INDEX "commerce_shipment_event_shipment_idx" ON "commerce_shipment_event" USING btree ("shipment_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "commerce_order_checkout_group_idx" ON "commerce_order" USING btree ("checkout_group_id","id");--> statement-breakpoint

-- Backfill engagements for existing accepted-quote service lines (no inventory mutation).
INSERT INTO "commerce_service_engagement" (
  "id",
  "buyer_organization_id",
  "provider_organization_id",
  "order_id",
  "order_service_line_id",
  "provider_kind",
  "state",
  "title_snapshot",
  "scope_snapshot",
  "created_at",
  "updated_at"
)
SELECT
  gen_random_uuid()::text,
  o.buyer_organization_id,
  o.counterparty_organization_id,
  o.id,
  osl.id,
  osl.provider_kind,
  'awaiting_provider',
  osl.title_snapshot,
  osl.scope_snapshot,
  now(),
  now()
FROM "commerce_order_service_line" AS osl
INNER JOIN "commerce_order" AS o ON o.id = osl.order_id
WHERE NOT EXISTS (
  SELECT 1 FROM "commerce_service_engagement" AS se
  WHERE se.order_service_line_id = osl.id
);--> statement-breakpoint

INSERT INTO "commerce_order_service_link" (
  "id",
  "engagement_id",
  "order_id",
  "order_service_line_id",
  "created_at"
)
SELECT
  gen_random_uuid()::text,
  se.id,
  se.order_id,
  se.order_service_line_id,
  now()
FROM "commerce_service_engagement" AS se
WHERE NOT EXISTS (
  SELECT 1 FROM "commerce_order_service_link" AS link
  WHERE link.engagement_id = se.id AND link.order_service_line_id = se.order_service_line_id
);--> statement-breakpoint

CREATE OR REPLACE FUNCTION commerce_prevent_shipment_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $commerce_shipment_event_immutable$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'commerce shipment events are append-only';
END
$commerce_shipment_event_immutable$;--> statement-breakpoint

CREATE TRIGGER commerce_shipment_event_append_only
BEFORE UPDATE OR DELETE ON "commerce_shipment_event"
FOR EACH ROW EXECUTE FUNCTION commerce_prevent_shipment_event_mutation();--> statement-breakpoint

CREATE OR REPLACE FUNCTION commerce_prevent_order_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $commerce_order_snapshot_immutable$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'commerce order snapshots are immutable';
  END IF;

  IF NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.subtotal_in_cents IS DISTINCT FROM OLD.subtotal_in_cents
     OR NEW.tax_in_cents IS DISTINCT FROM OLD.tax_in_cents
     OR NEW.service_fee_in_cents IS DISTINCT FROM OLD.service_fee_in_cents
     OR NEW.shipping_in_cents IS DISTINCT FROM OLD.shipping_in_cents
     OR NEW.discount_in_cents IS DISTINCT FROM OLD.discount_in_cents
     OR NEW.total_in_cents IS DISTINCT FROM OLD.total_in_cents
     OR NEW.buyer_legal_name_snapshot IS DISTINCT FROM OLD.buyer_legal_name_snapshot
     OR NEW.counterparty_legal_name_snapshot IS DISTINCT FROM OLD.counterparty_legal_name_snapshot
     OR NEW.accepted_quote_id IS DISTINCT FROM OLD.accepted_quote_id
     OR NEW.accepted_quote_revision_id IS DISTINCT FROM OLD.accepted_quote_revision_id
     OR NEW.checkout_group_id IS DISTINCT FROM OLD.checkout_group_id
     OR NEW.source IS DISTINCT FROM OLD.source THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'commerce order commercial snapshot is immutable';
  END IF;

  RETURN NEW;
END
$commerce_order_snapshot_immutable$;
