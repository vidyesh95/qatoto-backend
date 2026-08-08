-- ---------------------------------------------------------------------------
-- Store Phase 15 — Appendix A27. Lead time per price tier.
--
-- HAND-WRITTEN, like every store-phase migration since 0046.
--
-- `product.lead_time_min_days` / `lead_time_max_days` are per PRODUCT, but
-- `sections/packaging-and-delivery.tsx` renders three lead-time bands keyed to the same
-- quantity bounds as the price tiers — "15 days", "30 days", "to be negotiated". A
-- thousand units genuinely does not ship on the timetable fifty units ship on, and the
-- tier is already the row that says what changes with quantity.
--
-- NULL is the pre-Phase-15 behaviour and stays the common case: a tier with no lead time
-- of its own falls back to the product's, which is what every existing row means today.
-- No backfill, deliberately — copying `lead_time_max_days` down onto every tier would
-- manufacture a per-tier declaration the seller never made, and A16's rule against
-- asserting a fact from an absence applies to lead time exactly as it does to freight.
--
-- Bounds match `supplier.lead_time_days` (0..3650) and the three `leadTimeDays` columns
-- on the quote lines, so a wire value valid on one surface is valid on all of them.
-- ---------------------------------------------------------------------------

ALTER TABLE "product_pricing_tier"
  ADD COLUMN IF NOT EXISTS "lead_time_days" integer;--> statement-breakpoint

ALTER TABLE "product_pricing_tier"
  DROP CONSTRAINT IF EXISTS "product_pricing_tier_lead_time_ck";--> statement-breakpoint

ALTER TABLE "product_pricing_tier"
  ADD CONSTRAINT "product_pricing_tier_lead_time_ck"
  CHECK (lead_time_days IS NULL OR lead_time_days BETWEEN 0 AND 3650);
