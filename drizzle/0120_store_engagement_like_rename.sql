-- ---------------------------------------------------------------------------
-- The heart stops being a wishlist member and becomes a public LIKE.
--
-- HAND-WRITTEN, like every store-phase migration since 0046. This is a RENAME
-- throughout — no column is added, none is dropped, and no row is rewritten.
--
-- WHAT WAS WRONG. `commerce_product_engagement_kind` shipped as ('saved','bookmarked'),
-- one table serving two toggles, and `GET /commerce/saved-products` listed BOTH when
-- `kind` was absent. So a heart tap put a product in the buyer's wishlist exactly as a
-- bookmark did, and the two gestures were the same fact wearing two icons. The intended
-- model is that the heart is a public counter other buyers can see — never listed — and
-- the bookmark is the wishlist. The word `saved` is what made that drift inevitable:
-- "saved" reads as "kept for later" to every reader, which is the bookmark's job.
--
-- WHY `RENAME VALUE` AND NOT 0090'S TYPE-REBUILD DANCE. 0090 rebuilt
-- `product_media_kind` because it DROPPED a label, which Postgres cannot do in place.
-- Nothing is dropped here. `ALTER TYPE … RENAME VALUE` is a single catalog-level
-- statement: no table rewrite, no index rebuild, and no default to drop and re-add
-- (`engagement_kind` is NOT NULL with no default). It also carries none of
-- `ADD VALUE`'s restriction about using a label in the transaction that created it,
-- because the label already exists and only its spelling changes. No migration in this
-- repo has used `RENAME VALUE` before; it is the correct instrument for a rename, and
-- the rebuild would be strictly more dangerous for no gain.
--
-- WHY THE RANKING COLUMNS MOVE TOO. `commerce_product_engagement` rows with
-- `engagement_kind = 'saved'` were not inert. They fed four things in
-- `commerce-ranking.service.ts`: the nightly `commerce_product_daily_signal.saves`
-- rollup, `saves_w1`, `distinct_savers_w1` — which is the ENTIRE buyer-engagement
-- component of the trending score — and the subnet-concentration fraud guard, whose
-- only population they were. A like is a one-tap gesture with no purchase intent behind
-- it and is trivially farmable, so those four now read `bookmarked` instead. The two
-- columns that persist the result are renamed with them, because a column called
-- `saves` holding a count of bookmarks is the same naming lie this migration exists to
-- end.
--
-- HISTORICAL ROWS KEEP THEIR OLD MEANING, DELIBERATELY. Rows already in
-- `commerce_product_daily_signal.bookmarks` and
-- `commerce_product_trending_snapshot.bookmarks_w1` counted hearts. The series changes
-- meaning at this migration and is NOT backfilled: both columns are read only over
-- recent windows (`w1Start`, `dayStart`), so the old tail ages out of every query that
-- consumes them. Rewriting history to match the new name would be a worse lie than a
-- stale tail — it would state that bookmarks existed on days when nobody could make one.
--
-- No snapshot is patched: `drizzle/meta` stops at 0054 and every store-phase migration
-- since has been hand-written without one.
-- ---------------------------------------------------------------------------

ALTER TYPE "public"."commerce_product_engagement_kind" RENAME VALUE 'saved' TO 'liked';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The public like counter.
-- ---------------------------------------------------------------------------
ALTER TABLE "commerce_product_stats" RENAME COLUMN "saved_count" TO "like_count";--> statement-breakpoint

-- A CHECK cannot be rewritten in place; drop and re-add with the new column name. The
-- predicate is otherwise byte-for-byte what 0075 left behind.
ALTER TABLE "commerce_product_stats" DROP CONSTRAINT "commerce_product_stats_counters_non_negative_ck";--> statement-breakpoint
ALTER TABLE "commerce_product_stats" ADD CONSTRAINT "commerce_product_stats_counters_non_negative_ck" CHECK (
  like_count >= 0 AND bookmarked_count >= 0 AND share_count >= 0
  AND question_count >= 0 AND answered_question_count >= 0
  AND answered_question_count <= question_count
  AND view_count >= 0
  AND (unique_viewer_count IS NULL OR (unique_viewer_count >= 0 AND unique_viewer_count <= view_count))
);--> statement-breakpoint

ALTER INDEX "commerce_product_stats_saved_idx" RENAME TO "commerce_product_stats_like_idx";--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The nightly rollup column. Now counts bookmarks; see the header on the tail.
-- ---------------------------------------------------------------------------
ALTER TABLE "commerce_product_daily_signal" RENAME COLUMN "saves" TO "bookmarks";--> statement-breakpoint

ALTER TABLE "commerce_product_daily_signal" DROP CONSTRAINT "commerce_product_daily_signal_bounds_ck";--> statement-breakpoint
ALTER TABLE "commerce_product_daily_signal" ADD CONSTRAINT "commerce_product_daily_signal_bounds_ck" CHECK (
  counted_views >= 0 AND bookmarks >= 0 AND shares >= 0
  AND qualified_orders >= 0 AND qualified_order_value_in_cents >= 0
);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The trending snapshot's W1 input.
-- ---------------------------------------------------------------------------
ALTER TABLE "commerce_product_trending_snapshot" RENAME COLUMN "saves_w1" TO "bookmarks_w1";--> statement-breakpoint

ALTER TABLE "commerce_product_trending_snapshot" DROP CONSTRAINT "commerce_product_trending_snapshot_inputs_ck";--> statement-breakpoint
ALTER TABLE "commerce_product_trending_snapshot" ADD CONSTRAINT "commerce_product_trending_snapshot_inputs_ck" CHECK (
  qualified_orders_w1 >= 0 AND qualified_orders_w2 >= 0
  AND distinct_qualified_buyers_w1 >= 0 AND counted_views_w1 >= 0 AND bookmarks_w1 >= 0
  AND (demand_age_days IS NULL OR demand_age_days >= 0)
  AND currency ~ '^[A-Z]{3}$'
);
