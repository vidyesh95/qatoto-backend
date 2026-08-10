-- ---------------------------------------------------------------------------
-- Phase 20 — chargeable weight (STORE_BACKEND_STRUCTURE.md §19.9).
--
-- HAND-WRITTEN, like every store-phase migration since 0046.
--
-- WHAT THIS CLOSES. Freight bills on `max(actual gross weight, volumetric weight)`; every
-- forwarder quotes that way. Phase 20 shipped rating on actual weight alone, using volume
-- only as a band FLOOR, which UNDERPRICES a light bulky consignment — a container of
-- cushions weighs nothing and costs the same as a container of bolts. It was the one defect
-- in the phase that produced a WRONG number rather than a missing one, which is the single
-- failure mode §19.6 does not otherwise cover.
--
-- WHY THE COLUMN AND NOT A CONSTANT. The divisor is a tariff convention that varies by
-- FORWARDER as well as by mode: air is 5000 or 6000 depending on who is quoting, ocean LCL
-- is 1000 (the W/M "revenue ton" — one cubic metre billed as 1000 kg), road is around 3000.
-- Hardcoding one per mode would price a 5000-divisor air tariff wrong, and would be the
-- platform choosing a convention on the forwarder's behalf.
--
-- NOT NULL WITH NO DEFAULT, AND THAT IS ONLY SAFE BECAUSE THE TABLE IS EMPTY. No forwarder
-- lane list has been purchased yet, so there is nothing to backfill and no default to
-- invent. THIS WILL NOT BE TRUE FOR THE NEXT PERSON: once cards exist, adding a NOT NULL
-- column to this table needs a backfill with a real per-card figure, and a blanket default
-- would silently reprice every lane.
-- ---------------------------------------------------------------------------

ALTER TABLE "commerce_freight_rate_card"
  ADD COLUMN "volumetric_divisor_cm3_per_kg" integer NOT NULL;
--> statement-breakpoint

-- The bound catches a transposed figure, not a policy. Every real convention sits inside it.
ALTER TABLE "commerce_freight_rate_card"
  ADD CONSTRAINT "commerce_freight_rate_card_volumetric_divisor_ck"
  CHECK ("volumetric_divisor_cm3_per_kg" BETWEEN 100 AND 20000);
