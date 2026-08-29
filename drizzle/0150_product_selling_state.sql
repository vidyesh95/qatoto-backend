-- STORE §21.2 — a listing can finally say it is no longer sold.
--
-- WHAT WAS MISSING. `product.status` is `draft | active`, an AUTHORING state. `stock_state` is
-- DERIVED from `stock_quantity` and the lead times, a MEASUREMENT of what is on hand. Neither can
-- carry a seller's declaration about the FUTURE, so a buyer ordered a discontinued item and found
-- out from a message.
--
-- ADDITIVE ONLY. A new type, two new columns and one index. Every existing row becomes 'selling'
-- by the column default; nothing is rewritten, dropped or backfilled, and the DEFAULT is what
-- makes the NOT NULL safe on a populated table.
--
-- ⚠️ TWO COLUMNS, AND THE NULLABILITY DIFFERS ON PURPOSE. On `product` it is NOT NULL: every
-- listing has a selling state. On `store_search_document` it is NULLABLE, because that table also
-- holds provider offerings and organizations, and neither has one. The search filter therefore
-- reads `selling_state IS NULL OR selling_state <> 'discontinued'`; a bare inequality would drop
-- every supplier and service from an unfiltered search, since NULL <> 'discontinued' is NULL.
--
-- ⚠️ THE COLUMN ON `store_search_document` IS NOT A TERM IN `is_eligible`, AND MUST NOT BECOME
-- ONE. `is_eligible` is element [0] of the shared search WHERE builder with no per-facet escape,
-- so folding selling state into it would remove a discontinued listing from the results AND from
-- every facet count — the opposite of making it filterable. For the same reason the column is
-- absent from `publicProductEligibility`, which is the sole 404 decision for a product page: a
-- discontinued listing must still answer 200, because its inbound links and its `replaces`
-- relations are the only place a buyer learns what to buy instead.
--
-- The partial index mirrors `store_search_document_stock_idx`: every search runs a selling-state
-- predicate, including the default one, so it sits on the hot path rather than on an opt-in filter.
CREATE TYPE "public"."product_selling_state" AS ENUM('selling', 'paused', 'discontinued');--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "selling_state" "product_selling_state" DEFAULT 'selling' NOT NULL;--> statement-breakpoint
ALTER TABLE "store_search_document" ADD COLUMN "selling_state" "product_selling_state";--> statement-breakpoint
CREATE INDEX "store_search_document_selling_idx" ON "store_search_document" USING btree ("is_eligible","selling_state","id") WHERE is_eligible;