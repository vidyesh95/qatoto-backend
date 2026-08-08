-- Keyset index for `GET /commerce/completions`.
--
-- `commerce_completion_buyer_idx` is `(buyer_organization_id, completed_at)` and stops there.
-- The new buyer-facing list pages with the tie-break §7 requires — ordering must end in a
-- unique column so cursor pagination cannot skip rows sharing a timestamp — which means
-- `ORDER BY completed_at DESC, id ASC` and a predicate on `(completed_at, id)`. The old
-- index cannot serve that last leg, so the scan re-sorts every page.
--
-- Correctness never depended on this: the keyset predicate is what makes the page
-- deterministic, and it holds with or without an index. This is the index catching up to
-- the query, and it matches the shape the review keyset indexes already use deliberately —
-- see the schema comment above `commerce_review_product_recent_idx`, which spells out why
-- they end in `id`.
--
-- The old index is KEPT. It still serves the `(buyer_organization_id, completed_at)` range
-- reads that `commerce-trust-metrics` does, and dropping it to save one index on a table
-- this small would be trading a real regression for nothing.
CREATE INDEX IF NOT EXISTS "commerce_completion_buyer_keyset_idx"
  ON "commerce_completion" ("buyer_organization_id", "completed_at" DESC, "id");
