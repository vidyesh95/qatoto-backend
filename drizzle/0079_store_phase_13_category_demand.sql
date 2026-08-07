-- Store Phase 13 — per-category demand statistics: the priors, the floor, and the medians.
--
-- WHAT THIS TABLE ANSWERS, once per category per currency per night:
--
--   * Does this category have enough qualified demand for a percentile to mean anything?
--     (refinement 8: under 30 qualified orders in 30 days, percentile momentum is disabled
--     and the category is scored in exploration mode instead.)
--   * What is a normal order value here? (refinement 5's `Order_Value_Multiplier` divides
--     by this median, so a penny-spam listing cannot out-rank a real one on count alone.)
--   * What refund and cancellation rates are abnormal here? (refinement 10's p90 gates.)
--   * What conversion rate should a product with too little data be smoothed toward?
--     (refinement 4's hierarchical prior.)
--
-- KEYED BY CURRENCY, AND THAT IS NOT A DETAIL. `commerce_order.currency` varies per order
-- and this backend has no FX quote anywhere — §15.7 refuses to invent one even for a
-- pathway's set total. A single cross-currency median would therefore be a fabricated
-- conversion, so medians are computed per (category, currency) and a product whose currency
-- has no median gets NO value penalty rather than a guessed one.
--
-- `prior_level` RECORDS WHICH RUNG ANSWERED. That is the whole point of a hierarchical
-- prior: "this category's own 400 orders say 3.1%" and "we had nothing and used the
-- platform mean" are different claims, and a bare number cannot tell them apart.

CREATE TABLE "commerce_category_demand_snapshot" (
  "id" text PRIMARY KEY NOT NULL,
  "category_id" text NOT NULL,

  -- ISO 4217. See the header: a median that spanned currencies would be an FX opinion.
  "currency" text NOT NULL,

  -- Quantized to a UTC day by the tick that enqueued the run.
  "as_of" timestamp NOT NULL,

  -- Refinement 8's floor inputs.
  "qualified_order_count_30d" integer NOT NULL,
  "active_product_count" integer NOT NULL,

  -- NULLABLE WITH NO DEFAULT, all four. A category with no qualified orders has no median
  -- and no rate — and a 0 would be read as "orders here are worthless" and "nothing is ever
  -- refunded", which are claims this table has no basis for.
  "median_order_value_in_cents" bigint,
  "p90_refund_rate_bp" integer,
  "p90_cancellation_rate_bp" integer,
  "prior_conversion_rate_bp" integer,

  -- How many observations stand behind `prior_conversion_rate_bp`. Ships alongside the
  -- value for the reason every Phase 12 rate ships its sample size: a rate without one
  -- cannot be distinguished from a coincidence.
  "prior_sample_size" integer NOT NULL,

  "prior_level" "public"."commerce_category_prior_level" NOT NULL,
  "ranking_mode" "public"."commerce_ranking_mode" NOT NULL,

  "score_algorithm_version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "commerce_category_demand_snapshot" ADD CONSTRAINT "commerce_category_demand_snapshot_category_id_commerce_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."commerce_category"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Append-only history: one row per category, per currency, per run. A replayed `as_of` is
-- a no-op rather than an overwrite, which is what makes an old run reproducible.
CREATE UNIQUE INDEX "commerce_category_demand_snapshot_unq" ON "commerce_category_demand_snapshot" USING btree ("category_id","currency","as_of");--> statement-breakpoint

-- "Give me the newest snapshot for this category" — the read every scoring run performs.
CREATE INDEX "commerce_category_demand_snapshot_lookup_idx" ON "commerce_category_demand_snapshot" USING btree ("category_id","currency","as_of" DESC);--> statement-breakpoint

ALTER TABLE "commerce_category_demand_snapshot" ADD CONSTRAINT "commerce_category_demand_snapshot_currency_ck" CHECK (currency ~ '^[A-Z]{3}$');--> statement-breakpoint

ALTER TABLE "commerce_category_demand_snapshot" ADD CONSTRAINT "commerce_category_demand_snapshot_bounds_ck" CHECK (
  qualified_order_count_30d >= 0
  AND active_product_count >= 0
  AND prior_sample_size >= 0
  AND (median_order_value_in_cents IS NULL OR median_order_value_in_cents >= 0)
  AND (p90_refund_rate_bp IS NULL OR p90_refund_rate_bp BETWEEN 0 AND 10000)
  AND (p90_cancellation_rate_bp IS NULL OR p90_cancellation_rate_bp BETWEEN 0 AND 10000)
  AND (prior_conversion_rate_bp IS NULL OR prior_conversion_rate_bp BETWEEN 0 AND 10000)
);--> statement-breakpoint

-- A prior with no observations behind it cannot claim to be a CATEGORY prior. This is the
-- constraint that stops the ladder quietly labelling a global fallback as local knowledge.
ALTER TABLE "commerce_category_demand_snapshot" ADD CONSTRAINT "commerce_category_demand_snapshot_prior_ck" CHECK (
  (prior_level = 'default_floor' AND prior_sample_size = 0)
  OR (prior_level <> 'default_floor')
);
