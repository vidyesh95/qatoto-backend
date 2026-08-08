-- ---------------------------------------------------------------------------
-- Store Phase 15 — Appendix A25. Organizations become searchable, and the facets the
-- platform already computes become filterable.
--
-- HAND-WRITTEN, like every store-phase migration since 0046.
--
-- Three gaps, and the first two are the same mistake.
--
--   1. A SELLER ORGANIZATION IS NOT A SEARCH DOCUMENT, so there is no supplier
--      directory: a buyer reaches one storefront by slug and cannot browse or filter
--      sellers at all, while service providers have both a directory and a detail page.
--      The store's own "Factories worldwide" tile points at nothing.
--
--   2. THE QUERY SCHEMA OMITS EVERY FACET THE PLATFORM ALREADY COMPUTES.
--      `getCategoryFacets` returns `stockStates`, `samplePolicies` and
--      `priceRangesInCents`, and `/store/search` can filter on none of them. A facet the
--      backend computes and the search cannot filter on is an invitation to filter the
--      fetched page, which is precisely what §2.4 forbids. The counts were already the
--      honest denominator; only the WHERE clause was missing.
--
--   3. (No DDL — `ancestors[]` on the category read is a recursive CTE, not a column.)
--
-- WHY THE COLUMNS ARE DENORMALIZED HERE rather than joined at query time: the three
-- sort branches in `searchStoreDocuments` are keyset scans over indexes on this table.
-- A join to `product` for `sample_policy` would defeat every one of them, and the
-- discovery score is denormalized onto this same table for exactly that reason.
--
-- THE ENUM VALUE ADDED BELOW IS NOT USED BY ANY LATER STATEMENT IN THIS FILE, and must
-- not be. `drizzle-kit migrate` runs the whole pending batch in ONE transaction, and a
-- value added by `ALTER TYPE ... ADD VALUE` cannot be referenced as a literal by a
-- later statement in that same transaction. So: no partial index predicated on
-- `document_kind = 'organization'`, and no backfill INSERT. Organization rows first
-- appear at runtime, written by `refreshOrganizationSearchDocument`.
-- ---------------------------------------------------------------------------

ALTER TYPE "store_search_document_kind" ADD VALUE IF NOT EXISTS 'organization';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- `stock_state` is DERIVED — `deriveStockState` computes it from stock quantity and the
-- lead-time pair — so unlike `sample_policy` and `condition` it has no column elsewhere
-- to borrow a type from. Its own enum, with exactly the four values that function can
-- produce, so a fifth cannot be written here without the build noticing.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'store_search_stock_state') THEN
    CREATE TYPE "store_search_stock_state" AS ENUM
      ('in_stock', 'low_stock', 'made_to_order', 'unavailable');
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "store_search_document"
  ADD COLUMN IF NOT EXISTS "stock_state" "store_search_stock_state";--> statement-breakpoint

ALTER TABLE "store_search_document"
  ADD COLUMN IF NOT EXISTS "sample_policy" "product_sample_policy";--> statement-breakpoint

ALTER TABLE "store_search_document"
  ADD COLUMN IF NOT EXISTS "condition" "product_condition";--> statement-breakpoint

ALTER TABLE "store_search_document"
  ADD COLUMN IF NOT EXISTS "provider_verification_state" "commerce_provider_verification_state";
--> statement-breakpoint

ALTER TABLE "store_search_document"
  ADD COLUMN IF NOT EXISTS "lead_time_max_days" integer;--> statement-breakpoint

ALTER TABLE "store_search_document"
  DROP CONSTRAINT IF EXISTS "store_search_document_lead_time_ck";--> statement-breakpoint

ALTER TABLE "store_search_document"
  ADD CONSTRAINT "store_search_document_lead_time_ck"
  CHECK (lead_time_max_days IS NULL OR lead_time_max_days BETWEEN 0 AND 3650);--> statement-breakpoint

-- Every filter added by this phase narrows an already-eligible set, so both indexes
-- lead with `is_eligible` and carry the same partial predicate as the shipped ones.
CREATE INDEX IF NOT EXISTS "store_search_document_stock_idx"
  ON "store_search_document" ("is_eligible", "stock_state", "id")
  WHERE is_eligible;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "store_search_document_price_idx"
  ON "store_search_document" ("is_eligible", "price_in_cents", "id")
  WHERE is_eligible;
