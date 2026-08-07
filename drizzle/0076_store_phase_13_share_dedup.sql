-- Store Phase 13 — make the share counter mean something before anything ranks on it.
--
-- THIS CLOSES A LIVE DEFECT, found while auditing what the ranker could safely read.
--
-- `POST /store/products/:productSlug/share` has no dedup constraint of any kind. Every
-- call inserts a row and does `share_count + 1`, and the route sits behind
-- `attachOptionalUser` alone — so an ANONYMOUS caller moves a counter, repeatedly, braked
-- only by a 60-per-15-minutes limiter. `commerce_product_share`'s own schema comment
-- already named the fix: "Unlike `video_share` this carries no fingerprint dedupe ... If
-- share spam becomes real, that is the shape to copy."
--
-- The video domain settled this long ago and in the opposite direction:
-- `POST /videos/:videoId/share` moves its counter ONLY for a signed-in sharer,
-- specifically so an anonymous caller cannot push a ranking input. Commerce never
-- inherited the rule because nothing downstream read the counter — which is exactly what
-- this phase changes.
--
-- SO THE FIX LANDS BEFORE THE SIGNAL IS WIRED, not after. A counter that is about to
-- become a ranking input must be honest first, or the first thing the new engine learns is
-- noise a stranger can generate.
--
-- ANONYMOUS ROWS ARE KEPT. They are real events and deleting them would destroy evidence;
-- they simply stop moving the counter. Only DUPLICATE signed-in rows within one day are
-- collapsed, because those are the rows the new unique index cannot coexist with.
--
-- Rollback: drop the index and the columns. The reconciled counter is not restorable to
-- its inflated value, and that is fine — the inflated value was wrong.

ALTER TABLE "commerce_product_share" ADD COLUMN "share_day_bucket" date;--> statement-breakpoint

-- Salted /24 or /56 hash, as on the view session. Nullable and never backfillable.
ALTER TABLE "commerce_product_share" ADD COLUMN "subnet_hash" text;--> statement-breakpoint

-- Whether this row moved the counter. The `is_counted_view` idiom: it is what lets the
-- phase verifier reconcile `share_count` against the table forever, instead of trusting
-- that every future writer remembered the rule.
ALTER TABLE "commerce_product_share" ADD COLUMN "counted" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- Backfill the bucket from each row's OWN creation date. Not `current_date`, which would
-- collapse a year of history into a single day and then let the dedupe below delete all
-- but one share per user per product across all time.
UPDATE "commerce_product_share" SET "share_day_bucket" = "created_at"::date WHERE "share_day_bucket" IS NULL;--> statement-breakpoint

-- Say out loud what is about to be collapsed. An operator watching a migration silently
-- delete rows has no way to tell a 3-row cleanup from a 300,000-row one.
DO $$
DECLARE
  duplicate_count bigint;
  anonymous_count bigint;
BEGIN
  SELECT count(*) - count(DISTINCT (product_id, user_id, share_day_bucket))
    INTO duplicate_count
    FROM commerce_product_share
   WHERE user_id IS NOT NULL;

  SELECT count(*) INTO anonymous_count
    FROM commerce_product_share
   WHERE user_id IS NULL;

  RAISE NOTICE 'store phase 13: collapsing % duplicate signed-in share row(s); keeping % anonymous row(s) as uncounted evidence', duplicate_count, anonymous_count;
END
$$;--> statement-breakpoint

-- Keep the earliest row per (product, user, day). `ctid` breaks ties on identical
-- timestamps so this is deterministic rather than whichever row the planner met first.
DELETE FROM "commerce_product_share" AS victim
 WHERE victim."user_id" IS NOT NULL
   AND EXISTS (
     SELECT 1
       FROM "commerce_product_share" AS survivor
      WHERE survivor."product_id" = victim."product_id"
        AND survivor."user_id" = victim."user_id"
        AND survivor."share_day_bucket" = victim."share_day_bucket"
        AND (survivor."created_at", survivor."ctid") < (victim."created_at", victim."ctid")
   );--> statement-breakpoint

UPDATE "commerce_product_share" SET "counted" = ("user_id" IS NOT NULL);--> statement-breakpoint

ALTER TABLE "commerce_product_share" ALTER COLUMN "share_day_bucket" SET NOT NULL;--> statement-breakpoint

-- Partial, because an anonymous row has no user to deduplicate on. Two anonymous shares of
-- one product on one day remain two rows — they are simply never counted.
CREATE UNIQUE INDEX "commerce_product_share_daily_unq" ON "commerce_product_share" USING btree ("product_id","user_id","share_day_bucket") WHERE user_id IS NOT NULL;--> statement-breakpoint

-- The subnet-concentration scan over shares.
CREATE INDEX "commerce_product_share_subnet_idx" ON "commerce_product_share" USING btree ("subnet_hash","product_id","share_day_bucket") WHERE subnet_hash IS NOT NULL;--> statement-breakpoint

ALTER TABLE "commerce_product_share" ADD CONSTRAINT "commerce_product_share_subnet_ck" CHECK (subnet_hash IS NULL OR subnet_hash ~ '^[0-9a-f]{64}$');--> statement-breakpoint

-- An anonymous row must never be counted. Enforced in the service and again here, the
-- Phase 8 posture: the rule that protects a ranking input does not depend on one call site
-- remembering it.
ALTER TABLE "commerce_product_share" ADD CONSTRAINT "commerce_product_share_counted_ck" CHECK (NOT counted OR user_id IS NOT NULL);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Reconcile the counter.
--
-- THE ONE HONEST BACKFILL IN THIS PHASE. `share_count` is a derived cache, not a
-- historical fact — it is currently inflated by anonymous inserts and by duplicates that
-- no longer exist. Recomputing it from the surviving counted rows is restoring a
-- derivation, not inventing a measurement, which is why it is permitted here and why
-- `confirmed_at` in 0074 is not.
--
-- Products with no share rows at all are set to 0 rather than left alone: a stats row
-- whose counter disagrees with an empty table is the same inconsistency, just quieter.
-- ---------------------------------------------------------------------------
UPDATE "commerce_product_stats" AS stats
   SET "share_count" = COALESCE(counted_shares.total, 0)
  FROM (
    SELECT s."product_id", count(*)::int AS total
      FROM "commerce_product_share" AS s
     WHERE s."counted"
     GROUP BY s."product_id"
  ) AS counted_shares
 WHERE counted_shares."product_id" = stats."product_id"
   AND stats."share_count" <> counted_shares.total;--> statement-breakpoint

UPDATE "commerce_product_stats" AS stats
   SET "share_count" = 0
 WHERE stats."share_count" <> 0
   AND NOT EXISTS (
     SELECT 1 FROM "commerce_product_share" AS s
      WHERE s."product_id" = stats."product_id" AND s."counted"
   );
