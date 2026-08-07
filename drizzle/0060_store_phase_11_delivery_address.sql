-- Store Phase 11 / Appendix A15 — an order that records a deliverable address.
--
-- The problem, in one sentence: a confirmed order records "IN, MH, Pune 411001".
-- `formatDeliveryAddressSnapshot` builds the snapshot from plaintext columns only, so
-- street lines, recipient name and phone — all encrypted — never reach it. A seller
-- fulfilling that order has a city and a postcode, not an address anything can ship to.
--
-- §14 decided the fix is an AUTHORIZED DECRYPT PATH rather than a seller-openable
-- encrypted snapshot. That needs a durable pointer from the order to the encrypted row,
-- which is what this migration adds.
--
-- HAND-WRITTEN, like every store-phase migration since 0046. Depends on 0059 for the
-- `delivery` address kind.
--
-- Additive: the column is nullable, so a pre-Phase-11 application runs unchanged.

-- ---------------------------------------------------------------------------
-- Preflight. A NOTICE, not an EXCEPTION.
--
-- 0060 does not itself break anything, but the application change that lands with it
-- makes checkout require an address of kind `delivery`, and no such address can exist
-- yet — the kind was only added in 0059. Report the blast radius rather than guessing
-- which of an organization's existing addresses was meant to receive goods; promoting
-- a billing address to a delivery address is a business decision, not a migration's.
-- The rollout doc carries the promotion SQL.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  organizations_without_delivery_address integer;
BEGIN
  SELECT count(*) INTO organizations_without_delivery_address
  FROM (
    SELECT "organization_id"
    FROM "commerce_organization_address"
    GROUP BY "organization_id"
    -- `::text` for the same reason 0058 casts: `delivery` is added by 0059, and
    -- drizzle-kit runs every pending migration in ONE transaction, so naming the enum
    -- label here fails with "unsafe use of new value" on any fresh database.
    HAVING count(*) FILTER (WHERE "address_kind"::text = 'delivery') = 0
  ) AS lacking;

  IF organizations_without_delivery_address > 0 THEN
    RAISE NOTICE
      'Store Phase 11: % organization(s) have addresses but none of kind delivery. Their next checkout will be refused with ADDRESS_KIND_INVALID until one exists. See docs/STORE_PHASE_11_ROLLOUT.md.',
      organizations_without_delivery_address;
  END IF;
END $$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The pointer.
--
-- WHY A NEW COLUMN rather than walking to it. The only durable pointer to the
-- encrypted row today is `commerce_checkout_prepare.delivery_address_id`, reachable
-- from an order only as order → checkout group → prepare — and a quote-originated
-- order has no prepare at all. The decrypt route authorizes against the ORDER, so the
-- pointer belongs on the row that carries the authorization.
--
-- `restrict`, like every other address reference: an address a confirmed order was
-- shipped to is not silently deletable.
-- ---------------------------------------------------------------------------
ALTER TABLE "commerce_order" ADD COLUMN "delivery_address_id" text;--> statement-breakpoint
ALTER TABLE "commerce_order"
  ADD CONSTRAINT "commerce_order_delivery_address_id_commerce_organization_address_id_fk"
  FOREIGN KEY ("delivery_address_id") REFERENCES "public"."commerce_organization_address"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- Partial: most lookups are "which orders point at this address", and quote-originated
-- orders carry NULL forever.
CREATE INDEX "commerce_order_delivery_address_idx"
  ON "commerce_order" USING btree ("delivery_address_id")
  WHERE "delivery_address_id" IS NOT NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Backfill from the prepare, through the checkout group.
--
-- `commerce_checkout_group.checkout_prepare_id` is unique, so this join cannot fan
-- out. Quote-originated orders have no checkout group and stay NULL, which is correct:
-- there is no buyer-chosen delivery address behind an accepted quote.
-- ---------------------------------------------------------------------------
UPDATE "commerce_order" AS target_order
   SET "delivery_address_id" = source_prepare."delivery_address_id"
  FROM "commerce_checkout_group" AS source_group
  JOIN "commerce_checkout_prepare" AS source_prepare
    ON source_prepare."id" = source_group."checkout_prepare_id"
 WHERE target_order."checkout_group_id" = source_group."id"
   AND source_prepare."delivery_address_id" IS NOT NULL
   AND target_order."delivery_address_id" IS NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A16 support. `commerce_service_coverage` carries origin and destination countries
-- and has never been indexed on either, because nothing ever queried it by route —
-- the only reader loads every row for one offering. The delivery estimator queries it
-- the other way round: "which offerings cover IN → DE".
-- ---------------------------------------------------------------------------
CREATE INDEX "commerce_service_coverage_route_idx"
  ON "commerce_service_coverage" USING btree ("origin_country_code", "destination_country_code");
