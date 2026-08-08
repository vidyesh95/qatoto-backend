-- ---------------------------------------------------------------------------
-- Store Phase 15 — Appendices A28 and A29. Indexes for the two new participant queues.
--
-- HAND-WRITTEN, like every store-phase migration since 0046.
--
-- Both new list routes order by `(created_at DESC, id)`, which is §7's rule so cursor
-- pagination cannot skip rows sharing a timestamp. None of the shipped indexes serves
-- that ordering for these tables:
--
--   * `commerce_dispute_buyer_idx` / `_counterparty_idx` stop at `(org, state, id)`.
--     They were built for a moderator's state filter and have had no reader at all,
--     because until now there was no participant-facing dispute route.
--   * `commerce_shipment` has exactly ONE index, `(order_id, id)`, and the queue scans
--     it in `created_at` order after an org-scoped join to `commerce_order`.
--   * `commerce_shipment_leg` has no index on `estimated_arrival_at`, which the queue's
--     ETA-window `EXISTS` probes per shipment.
--
-- This is `0092` again: correctness never depended on an index — it lives in the keyset
-- predicate — so these are performance only. The older indexes stay for their existing
-- readers rather than being replaced.
-- ---------------------------------------------------------------------------

-- A28. One per party, because a dispute names two organizations and either may list it.
CREATE INDEX IF NOT EXISTS "commerce_dispute_buyer_created_idx"
  ON "commerce_dispute" ("buyer_organization_id", "created_at" DESC, "id");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "commerce_dispute_counterparty_created_idx"
  ON "commerce_dispute" ("counterparty_organization_id", "created_at" DESC, "id");
--> statement-breakpoint

-- A29. Leads with `order_id` so the org-scoped join to `commerce_order` can drive, and
-- carries the queue's sort so the shipments of a matched order arrive already ordered.
CREATE INDEX IF NOT EXISTS "commerce_shipment_order_created_idx"
  ON "commerce_shipment" ("order_id", "created_at" DESC, "id");--> statement-breakpoint

-- A29. Partial, because a leg with no ETA can never satisfy an ETA window and has no
-- business widening the index the window probes.
CREATE INDEX IF NOT EXISTS "commerce_shipment_leg_eta_idx"
  ON "commerce_shipment_leg" ("shipment_id", "estimated_arrival_at")
  WHERE estimated_arrival_at IS NOT NULL;
