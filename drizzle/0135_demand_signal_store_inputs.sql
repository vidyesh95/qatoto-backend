-- ---------------------------------------------------------------------------
-- THE LOOP CLOSES: STORE SALES BECOME AN INPUT TO R&D'S DEMAND RADAR.
--
-- Until now every input to `demand_signal_snapshot` came from R&D talking to itself — people
-- REPORTING a problem, teams SAYING they would build it, roles nobody had filled. None of it
-- is evidence that anyone would pay. A completed order against a listing a venture actually
-- shipped is that evidence, and it was sitting in the store tables unread by this side.
--
-- WHY THIS IS TWO COLUMNS AND NOT A SECOND WRITER, which is what the obvious reading of the
-- proposal asks for. Three things make a parallel writer impossible, not merely awkward:
--
--   1. `demand_signal_snapshot_asOf_rank_unq` is unique on (as_of, rank) GLOBALLY. Two writers
--      emitting rows for the same as_of collide on rank, and the existing insert's
--      ON CONFLICT DO NOTHING targets the CELL index, not this one — so the collision is a
--      hard error, not a skip.
--   2. The store has no region. `region_id` is NOT NULL against `discovery_region`, and
--      nothing in the store schema references it.
--   3. There is no store-to-R&D category mapping. `product.category_id` points at
--      `commerce_category`, a different tree from `research_category`, with no join table, no
--      FK and no shared slug.
--
-- So the sale becomes an INPUT to the one existing writer instead, and the attribution path is
-- the one the job already walks for `related_project_count`:
--
--   commerce_order_product_line -> product -> research_project
--     -> problem_cluster_project_link -> problem_cluster (region_id, category_id)
--
-- `problem_cluster` carries BOTH the region and the category, so a sale lands in a real cell
-- without anyone inventing a correspondence between two taxonomies.
--
-- ONE OF THE TWO IS SCORED. `sold_unit_count` feeds a new 15-point MARKET_PROOF ladder;
-- `product_review_count` is recorded and displayed but deliberately NOT scored, because a
-- review requires a completion which requires an order — so every review here corroborates a
-- sale the unit count has already counted, and scoring both would let one transaction earn
-- points twice.
--
-- DEFAULT 0 AND NOT NULL, so every row already in the table satisfies the rewritten CHECK
-- unchanged and there is no backfill. Existing rows keep `score_algorithm_version = 1` and are
-- not comparable to version-2 scores — which is exactly what that column is for.
--
-- RUN ORDER: columns -> drop the old CHECK -> add the rewritten one.
-- ---------------------------------------------------------------------------

ALTER TABLE "demand_signal_snapshot" ADD COLUMN "sold_unit_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

ALTER TABLE "demand_signal_snapshot" ADD COLUMN "product_review_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

ALTER TABLE "demand_signal_snapshot" DROP CONSTRAINT "demand_signal_snapshot_counts_ck";--> statement-breakpoint

ALTER TABLE "demand_signal_snapshot" ADD CONSTRAINT "demand_signal_snapshot_counts_ck" CHECK (cluster_count >= 0 AND distinct_reporter_count >= 0
          AND related_project_count >= 0 AND open_role_count >= 0
          AND sold_unit_count >= 0 AND product_review_count >= 0
          AND (previous_demand_score_points IS NULL
               OR previous_demand_score_points BETWEEN 0 AND 100));
