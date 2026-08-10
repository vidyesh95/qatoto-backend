-- ---------------------------------------------------------------------------
-- Phase 20 — the minimum half of the manufacturing declaration
-- (STORE_BACKEND_STRUCTURE.md §19.4).
--
-- HAND-WRITTEN, like every store-phase migration since 0046.
--
-- WHY THIS EXISTS. §19.4 reports manufacturing as a RANGE — `{ daysMin, daysMax }` — but
-- the only lead-time fact an order has ever snapshotted is A13's MAXIMUM. An order could
-- say "ships within 25 days" and never "in 15 to 25", so the arrival window's first
-- component was unserveable as specified.
--
-- NOTHING IS BACKFILLED, and that is the point. Inventing a minimum for an order placed
-- before this column existed is exactly the fabrication `lead_time_max_days_snapshot`'s own
-- comment refuses. A pre-Phase-20 order reports `daysMin: null` and SAYS SO on the wire,
-- which is §19.6's rule — report the components you have, name the ones you do not.
--
-- THE MAXIMUM IS DELIBERATELY NOT ADDED TO THE ORDER LINE. It is already recoverable
-- losslessly from `promised_delivery_at` minus the order's `created_at` —
-- `derivePromisedDeliveryAt` added whole days to the insert instant — and that reconstruction
-- works on every order ever placed, whereas a new column would work on none of them.
--
-- ADDITIVE AND NULLABLE THROUGHOUT, so it is safe against
-- `commerce_order_snapshot_append_only`: that trigger guards UPDATEs to `commerce_order`'s
-- snapshot columns, not DDL, and not this table.
-- ---------------------------------------------------------------------------

ALTER TABLE "commerce_checkout_prepare_product_line"
  ADD COLUMN IF NOT EXISTS "lead_time_min_days_snapshot" integer;
--> statement-breakpoint

ALTER TABLE "commerce_order_product_line"
  ADD COLUMN IF NOT EXISTS "lead_time_min_days_snapshot" integer;
--> statement-breakpoint

-- The prepare line's existing bound is widened rather than duplicated: the minimum carries
-- the same 0..3650 range as the maximum, AND the pair may not be incoherent when both are
-- present. The two remain INDEPENDENTLY nullable — a seller may declare a maximum and no
-- minimum, and that partial declaration is honest rather than broken.
ALTER TABLE "commerce_checkout_prepare_product_line"
  DROP CONSTRAINT IF EXISTS "commerce_checkout_prepare_product_line_lead_time_ck";
--> statement-breakpoint

ALTER TABLE "commerce_checkout_prepare_product_line"
  ADD CONSTRAINT "commerce_checkout_prepare_product_line_lead_time_ck"
  CHECK (("lead_time_max_days_snapshot" IS NULL
          OR ("lead_time_max_days_snapshot" >= 0 AND "lead_time_max_days_snapshot" <= 3650))
         AND ("lead_time_min_days_snapshot" IS NULL
              OR ("lead_time_min_days_snapshot" >= 0 AND "lead_time_min_days_snapshot" <= 3650))
         AND ("lead_time_min_days_snapshot" IS NULL
              OR "lead_time_max_days_snapshot" IS NULL
              OR "lead_time_min_days_snapshot" <= "lead_time_max_days_snapshot"));
--> statement-breakpoint

-- The order line carries no maximum column, so its bound has no pair to check against.
ALTER TABLE "commerce_order_product_line"
  ADD CONSTRAINT "commerce_order_product_line_lead_time_ck"
  CHECK ("lead_time_min_days_snapshot" IS NULL
         OR ("lead_time_min_days_snapshot" >= 0 AND "lead_time_min_days_snapshot" <= 3650));
