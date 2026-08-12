-- ---------------------------------------------------------------------------
-- Phase 25 — the index the seller earnings read needs.
--
-- HAND-WRITTEN, like every store-phase migration since 0046. INDEX ONLY — Phase 25 adds no
-- column, no table and no constraint. Everything the earnings route reports is derived from
-- rows that already exist; the gap was a route, never a schema.
--
-- WHAT THIS IS FOR. `GET /commerce/provider/earnings` sums settled payment intents for ONE
-- seller over a time window. `commerce_payment_intent` already carries
-- `counterparty_organization_id` — the seller — directly on the row, which is what makes the
-- aggregate a single-table scan rather than a join through `commerce_order`.
--
-- WHY IT DID NOT EXIST ALREADY. The table carries `commerce_payment_intent_buyer_idx` on
-- `(buyer_organization_id, state, id)` and nothing at all for the seller side. Every read
-- before this one approached an intent by ORDER or by ID, so the asymmetry never cost
-- anything. A seller-scoped SUM is the first query that starts from the seller.
--
-- COLUMN ORDER MIRRORS THE PREDICATE: equality on the organization, equality on the state set,
-- then the range on `settled_at`. Putting the timestamp last is what lets one index serve both
-- the windowed read and the unwindowed lifetime total.
--
-- PARTIAL ON `settled_at IS NOT NULL`. An intent that never settled contributes nothing to any
-- earnings figure by definition — `created`, `processing` and `failed` rows are exactly the
-- ones the sum must exclude — so they have no business occupying the index. This mirrors the
-- partial indexes `store_search_document` already uses for the same reason.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "commerce_payment_intent_counterparty_idx"
  ON "commerce_payment_intent" USING btree ("counterparty_organization_id", "state", "settled_at")
  WHERE settled_at IS NOT NULL;
