-- ---------------------------------------------------------------------------
-- Phase 22 — the index the facet scan needs (STORE_BACKEND_STRUCTURE.md A25, A39).
--
-- HAND-WRITTEN, like every store-phase migration since 0046. INDEX ONLY — Phase 22 adds no
-- column and changes no constraint.
--
-- WHAT THIS IS FOR. Phase 22 moves the category facets off `product` and onto
-- `store_search_document`, so the counts and the filters finally read one table. Every one of
-- those facet queries scopes by CATEGORY and by eligibility, and grouping a category's rows is
-- now the hottest read on this table.
--
-- WHY `category_slug` AND NOT `category_id`. `store_search_document_category_idx` already
-- indexes `(category_id, id)` — and NOTHING READS `category_id` on the query path.
-- `searchStoreDocuments` filters `category_slug IN (subtree slugs)` because
-- `listActiveCategorySubtreeSlugs` returns slugs, and the facets now do the same so both scope
-- identically. The existing index has therefore never served the filter it looks like it was
-- built for; it stays because the FK and the `ON DELETE SET NULL` still use it.
--
-- PARTIAL ON `is_eligible`, matching the three siblings this table already carries
-- (`_stock_idx`, `_price_idx`, `_discovery_idx`). Every public read and every facet starts with
-- `is_eligible = true`, so an ineligible row has no business occupying the index.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "store_search_document_eligible_category_idx"
  ON "store_search_document" USING btree ("is_eligible", "category_slug", "id")
  WHERE is_eligible;
