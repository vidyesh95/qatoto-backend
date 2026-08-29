-- STORE §21.1 — an exact manufacturer part code now OUTRANKS a title that merely mentions it.
--
-- WHAT WAS MISSING. `model_number` was already folded into `search_text`, which made a part code
-- FINDABLE. It did not make it FIRST: `search_document` weights that whole blob at class `C`, so a
-- listing whose TITLE contains `LM358` still outranked the listing that actually CARRIES `LM358`.
-- Ranking the carrier first means comparing against the VALUE, and the comparison needs the value
-- on THIS table — joining back to `product` on every default-sort search is exactly what this
-- table's denormalization exists to avoid, and it would only work for one of the three document
-- kinds it serves.
--
-- ⚠️ THE DOC SAID "no migration" AND THE DOC WAS WRONG. `STORE_BACKEND_STRUCTURE.md` §21.1 listed
-- "three edits, no migration" while its own Phase 25 bullet said to put `model_number` INTO
-- `store_search_document`. Those contradict; a new column is a migration. The inline comment in
-- `refreshProductSearchDocument` is the one that held up, and the doc is corrected alongside this.
--
-- ADDITIVE ONLY. Two nullable columns, one index and one scoped backfill. Nothing is dropped and
-- nothing is rewritten except the rows the backfill names.
--
-- ⚠️ NULLABLE, like `selling_state` before it: this table also holds provider offerings and
-- organizations, and neither is a manufactured part.
--
-- ⚠️ NOT UNIQUE, EVER. Two sellers listing the same manufacturer part is the PREMISE of a
-- parametric marketplace, not a data error — the whole value of a part-code search is that `LM358`
-- returns many offers. Uniqueness belongs on `sku`, which already has it per seller organization.
--
-- ⚠️ AND NOT A TERM IN `is_eligible`. `is_eligible` is element [0] of the shared search WHERE with
-- no per-facet escape, so folding a part code into it would remove non-matching listings from
-- every facet count as well as from the results — the same trap `0150` documents for selling state.
--
-- NO CHECK ON THE COPY. `product_model_unit_ck` already bounds the source, and this table only ever
-- compares the value for equality — it never parses, routes or renders it. That follows `title`'s
-- precedent on this table (also unchecked) rather than `_slug_ck`'s, which exists precisely because
-- routing depends on the shape.
--
-- ⚠️ `model_number_normalized` HAS A TWIN IN TYPESCRIPT. `normalizeModelNumberQuery` in
-- `store-search.service.ts` normalizes the QUERY side and must stay byte-for-byte equivalent to the
-- expression below. A generated column cannot call application code, so one rule genuinely lives in
-- two places; drift between them silently stops exact matches from matching.
--
-- ⚠️ THE BACKFILL IS NOT OPTIONAL. Nothing sweeps this table — a document is rewritten only when
-- its own product is next edited, which may be never. Without the backfill the boost would stay
-- dark for every listing that already carries a part code. It is scoped to `model_number IS NOT
-- NULL` so it touches nothing it does not have to.
ALTER TABLE "store_search_document" ADD COLUMN "model_number" text;--> statement-breakpoint
ALTER TABLE "store_search_document" ADD COLUMN "model_number_normalized" text GENERATED ALWAYS AS (NULLIF(lower(regexp_replace(model_number, '[^a-zA-Z0-9]', '', 'g')), '')) STORED;--> statement-breakpoint
CREATE INDEX "store_search_document_model_number_idx" ON "store_search_document" USING btree ("is_eligible","model_number_normalized","id") WHERE is_eligible;--> statement-breakpoint
UPDATE "store_search_document" AS document
   SET "model_number" = source."model_number"
  FROM "product" AS source
 WHERE document."document_kind" = 'product'
   AND document."entity_id" = source."id"
   AND source."model_number" IS NOT NULL;
