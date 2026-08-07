-- Store Phase 13 — durable order lifecycle timestamps and the trusted-buyer stamp.
--
-- THIS IS THE MIGRATION THE RANKING ENGINE STANDS ON, and it exists because
-- `commerce_order` cannot currently answer "which orders confirmed last week".
--
-- What it has today: `created_at`, which is immutable and true but means `pending_payment`
-- — an order that may never be paid for — and `updated_at`, which any later write moves.
-- An order confirmed on the 2nd and cancelled on the 9th has `updated_at` = the 9th, so a
-- window built on it would count that order as demand in the wrong week and then move it
-- again the next time anything touched the row.
--
-- TWO ALTERNATIVES WERE AVAILABLE AND BOTH FAIL.
--
--   `commerce_organization_audit_entry`. It records `checkout_confirmed`,
--   `order_created_from_checkout` and `order_cancelled`, but the payment-settled ->
--   `confirmed` transition writes `payment_intent_settled` (a payment event, not an order
--   one) and the reconciliation-driven transitions to `in_fulfillment`,
--   `partially_completed` and `completed` write NO audit entry at all. Entries also land
--   on one PARTICULAR organization's stream, so a platform-wide window would union two
--   streams and then read `payload_json` — deriving a ranking window from untyped JSON is
--   what §0 forbids in as many words.
--
--   `commerce_completion.completed_at`. Real, indexed, and the wrong event: it marks the
--   END OF FULFILLMENT. With the 30–90 day lead times this market actually has, anchoring
--   demand freshness to completion makes a product look stale for a quarter after a burst
--   of orders. It also only exists for `product_order_line` targets, so a paid, confirmed,
--   unshipped order — demand by any reading — contributes nothing.
--
-- NOTHING IS BACKFILLED, and this is not laziness. The only candidate source is
-- `updated_at`, which is mutable and means "when anything last changed"; stamping it into
-- `confirmed_at` would fabricate a confirmation instant for every historical order and
-- feed fiction to a fraud engine. Pre-existing orders carry NULL, are `unevaluated`, and
-- are absent from both sides of every ratio — the posture 0072 took for `promised_delivery_at`.
--
-- THERE IS DELIBERATELY NO STATE-COUPLED CHECK. `state = 'cancelled' => cancelled_at IS
-- NOT NULL` is false for every row already in the table, so the constraint could not be
-- added without either a fabricated backfill or NOT VALID, and a NOT VALID constraint that
-- is never validated is a comment with a performance cost. The checks below are
-- ordering-only, which is true of every row that has ever existed.
--
-- Additive: five nullable-or-defaulted columns, two checks, two indexes. Rollback is DROP
-- COLUMN.

-- ---------------------------------------------------------------------------
-- The three lifecycle instants.
-- ---------------------------------------------------------------------------

-- The moment this order became a real commitment: payment settled, or a quote acceptance
-- created it already confirmed. THIS IS THE VELOCITY CLOCK — W1 (days 1-7) and W2 (days
-- 8-14) are both windows over this column and nothing else.
ALTER TABLE "commerce_order" ADD COLUMN "confirmed_at" timestamp;--> statement-breakpoint

-- Every line either fulfilled or cancelled. Distinct from `commerce_completion.completed_at`,
-- which is per LINE and is the trust metrics' clock; this is the order-level roll-up and
-- is what the reorder-rate and refund-rate denominators window on.
ALTER TABLE "commerce_order" ADD COLUMN "completed_at" timestamp;--> statement-breakpoint

-- Set by `cancelOrder`. Until now the only durable record that a cancellation happened at
-- a particular time was an audit row, and the reason was not captured anywhere at all.
ALTER TABLE "commerce_order" ADD COLUMN "cancelled_at" timestamp;--> statement-breakpoint

-- Ordering only — see the header. An order cannot complete or cancel before it confirmed,
-- and a row where either is null makes no claim.
ALTER TABLE "commerce_order" ADD CONSTRAINT "commerce_order_lifecycle_order_ck" CHECK (
  (completed_at IS NULL OR confirmed_at IS NULL OR completed_at >= confirmed_at)
  AND (cancelled_at IS NULL OR confirmed_at IS NULL OR cancelled_at >= confirmed_at)
);--> statement-breakpoint

-- An order is not both completed and cancelled. This one IS safe against history: no
-- existing row has either column set.
ALTER TABLE "commerce_order" ADD CONSTRAINT "commerce_order_terminal_exclusive_ck" CHECK (
  completed_at IS NULL OR cancelled_at IS NULL
);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The trusted-buyer stamp (refinement 2).
--
-- WHY THIS LIVES ON THE ORDER AND NOT IN A NIGHTLY SNAPSHOT. Qualification must be
-- evaluated as of the moment the order confirmed and then frozen. Recomputed at read
-- time, a buyer that registers a tax identifier today would retroactively qualify every
-- order it ever placed — turning a fraud filter into a one-click amplifier for exactly
-- the party it is meant to constrain.
--
-- `unevaluated` for every historical row. See the header: that is not a failing grade.
-- ---------------------------------------------------------------------------
ALTER TABLE "commerce_order" ADD COLUMN "buyer_qualification_state" "public"."commerce_buyer_qualification_state" DEFAULT 'unevaluated' NOT NULL;--> statement-breakpoint

-- Which clauses answered. An array because the bar is one age test AND one of three
-- credentials, so a single reason column would force a precedence that does not exist.
ALTER TABLE "commerce_order" ADD COLUMN "buyer_qualification_reasons" "public"."commerce_buyer_qualification_reason"[] DEFAULT '{}' NOT NULL;--> statement-breakpoint

-- A verdict without a reason is unreviewable, and an `unevaluated` row must not carry one
-- — otherwise a historical order would look like it was assessed and found wanting.
ALTER TABLE "commerce_order" ADD CONSTRAINT "commerce_order_qualification_reasons_ck" CHECK (
  (buyer_qualification_state = 'unevaluated' AND cardinality(buyer_qualification_reasons) = 0)
  OR (buyer_qualification_state <> 'unevaluated' AND cardinality(buyer_qualification_reasons) > 0)
);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Indexes.
--
-- Both existing indexes on this table lead with an organization id
-- (`commerce_order_buyer_idx`, `commerce_order_counterparty_idx`), so a platform-wide
-- "confirmed orders in the last 30 days" — refinement 8's category floor, run once per
-- category per hour — has no usable index at all today.
--
-- Plain CREATE INDEX, not CONCURRENTLY: drizzle runs each file in one transaction and
-- CONCURRENTLY cannot participate. At current row counts this is a sub-second lock. If
-- `commerce_order` ever passes ~1M rows, build these out of band and record an empty
-- journal entry instead.
-- ---------------------------------------------------------------------------
CREATE INDEX "commerce_order_state_created_idx" ON "commerce_order" USING btree ("state","created_at","id");--> statement-breakpoint

-- Partial, for the reason 0072's promised-delivery index is partial: every row that
-- predates this migration is null forever and there is no reason to index it.
CREATE INDEX "commerce_order_confirmed_at_idx" ON "commerce_order" USING btree ("confirmed_at","counterparty_organization_id") WHERE confirmed_at IS NOT NULL;--> statement-breakpoint

-- The qualified-velocity scan reads (confirmed_at, qualification, counterparty) together
-- and never wants the unevaluated tail.
CREATE INDEX "commerce_order_qualified_velocity_idx" ON "commerce_order" USING btree ("buyer_qualification_state","confirmed_at","counterparty_organization_id") WHERE confirmed_at IS NOT NULL AND buyer_qualification_state = 'qualified';
