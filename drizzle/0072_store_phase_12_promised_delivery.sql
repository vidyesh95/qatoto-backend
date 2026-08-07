-- Store Phase 12 — the promised-delivery chain (Appendix A13 item 1).
--
-- THIS CLOSES THE ONLY ENTRY IN APPENDIX A THAT REACHED THE WIRE AND COULD NEVER CARRY A
-- REAL VALUE. `onTimeShipmentRate` is projected on the storefront card, the provider card
-- and the pathway read, and it was hardcoded `null` in
-- commerce-trust-metrics.service.ts because no promised-delivery timestamp existed
-- anywhere in 244 tables. A field that looks wired and cannot ever be non-null is worse
-- than a missing field, which is the whole reason Appendix A is written down.
--
-- A13'S SHAPE FOR THIS UNDERSTATED THE CHAIN. It said "a promised-delivery timestamp on
-- the shipment or order line". It needs THREE tables, because `confirmCheckout` builds
-- each order line VERBATIM from the prepare row and never touches the cart or the product
-- again — the same constraint A18's customization selections had to route around. So the
-- seller's advertised lead time is snapshotted at PREPARATION, and the promise is computed
-- from that snapshot at CONFIRM.
--
-- WHY NOT SELLER-TYPED AT SHIP TIME, which would have been one nullable column: the
-- seller would be setting the bar after it already knew the outcome, and the metric would
-- grade itself. Deriving the promise at confirm from what the buyer was shown is the same
-- posture §0 takes on prices — the client may display one, it may never establish one.
--
-- WHY NOT RE-READ `product.lead_time_max_days` AT CONFIRM, which would have been zero
-- columns: that derives a commitment from mutable listing data the buyer never saw. A
-- seller could shorten its advertised lead time between prepare and confirm and be held to
-- a promise nobody made, or lengthen it and escape one.
--
-- NOTHING IS BACKFILLED. Orders placed before this migration carry no promise and are
-- absent from the on-time denominator, which `onTimeSampleSize` states on the wire.
-- Inventing a commitment for them from today's lead times would fabricate the very
-- measurement this file exists to make honest.
--
-- Additive: three nullable columns and one partial index. Rollback is DROP COLUMN plus
-- restoring the hardcoded null.

-- The seller's advertised maximum lead time AT THE MOMENT OF PREPARATION. Null means this
-- seller declared no lead time — not zero days.
ALTER TABLE "commerce_checkout_prepare_product_line" ADD COLUMN "lead_time_max_days_snapshot" integer;--> statement-breakpoint
ALTER TABLE "commerce_checkout_prepare_product_line" ADD CONSTRAINT "commerce_checkout_prepare_product_line_lead_time_ck" CHECK (
  lead_time_max_days_snapshot IS NULL
  OR (lead_time_max_days_snapshot >= 0 AND lead_time_max_days_snapshot <= 3650)
);--> statement-breakpoint

-- This line's own promise — an immutable commercial snapshot like every other column on
-- the table. Per line and not only per order because one order can span lead times, and a
-- partially-shipped order needs to know WHICH line was late.
ALTER TABLE "commerce_order_product_line" ADD COLUMN "promised_delivery_at" timestamp;--> statement-breakpoint

-- The latest promise across this order's product lines: the baseline the delivered
-- shipment event is measured against. Derived at creation from the prepare snapshot for a
-- direct checkout, and from the `commerce_quote_product_line.lead_time_days` that already
-- existed for a quote-originated order.
ALTER TABLE "commerce_order" ADD COLUMN "promised_delivery_at" timestamp;--> statement-breakpoint

-- The on-time metric's driving index. Partial, because most historical rows never will
-- carry a promise and there is no reason to index a column that is null for all of them.
CREATE INDEX "commerce_order_promised_delivery_idx" ON "commerce_order" USING btree ("counterparty_organization_id","promised_delivery_at") WHERE promised_delivery_at IS NOT NULL;
