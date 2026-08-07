-- Store Phase 13 — the scoring output: snapshots, live state, enforcement, and the series
-- the spike detector cannot exist without.
--
-- FIVE TABLES, and the split is the design rather than an accident of normalization:
--
--   commerce_product_trending_snapshot   append-only audit history. Never on a request path.
--   commerce_product_ranking_state       the one row a rail reads. Cleared and re-set hourly.
--   commerce_product_ranking_enforcement current suppression, which OUTLIVES the hourly run.
--   commerce_ranking_enforcement_event   why, and when, and by whom.
--   commerce_product_daily_signal        the per-product time series.
--
-- WHY ENFORCEMENT IS NOT A COLUMN ON THE SNAPSHOT. A moderator's decision must survive the
-- scorer truncating and rewriting its own output every hour. Putting it on a job-owned row
-- would mean a human's ruling lasted until the next tick.
--
-- WHY THE DAILY SIGNAL TABLE IS HERE AT ALL, and it is the one easiest to leave out:
-- refinement 6's MAD baseline needs a per-product HISTORY. If the only history were the
-- trending snapshot, and that snapshot were pruned on the schedule its video sibling uses,
-- the baseline could never be computed and the dynamic spike trigger would be permanently
-- dead — shipped, wired, and silently returning nothing. Five integers a day per product is
-- the cheapest thing in this phase and the one without which a whole refinement is fiction.

-- ---------------------------------------------------------------------------
-- Who acted.
--
-- A NEW TYPE, so it is safe to create here rather than in 0073: the restriction Postgres
-- enforces is on values ADDED to a pre-existing type, not on types created in the same
-- transaction that uses them.
--
-- `automatic` exists because `platform_audit_entry.actor_user_id` is NOT NULL and an
-- automatic suppression names nobody. Rather than weaken that hash chain, an automatic
-- action is recorded here with no moderator — the same call Phase 10 made for
-- `commerce_moderation_action.action_source`.
-- ---------------------------------------------------------------------------
CREATE TYPE "public"."commerce_ranking_action_source" AS ENUM('moderator', 'automatic');--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The audit history.
-- ---------------------------------------------------------------------------
CREATE TABLE "commerce_product_trending_snapshot" (
  "id" text PRIMARY KEY NOT NULL,
  "as_of" timestamp NOT NULL,
  "product_id" text NOT NULL,
  "category_id" text,
  "currency" text NOT NULL,

  -- 1-indexed WITHIN ITS CATEGORY. Partitioned because refinement 7 partitions the batch by
  -- category, and because a global rank across unrelated categories is not a fact anyone
  -- consumes.
  "rank" integer NOT NULL,

  -- The five components. Budgets sum to 100 and the CHECK below asserts it in the database,
  -- so a scorer bug is a write failure rather than a silently wrong ranking.
  "qualified_velocity_points" integer NOT NULL,
  "demand_freshness_points" integer NOT NULL,
  "conversion_quality_points" integer NOT NULL,
  "seller_trust_points" integer NOT NULL,
  "buyer_engagement_points" integer NOT NULL,
  "trending_score_points" integer NOT NULL,

  -- Multipliers, in basis points, applied AFTER the components are summed. Separate columns
  -- rather than one product so an appeal can be told which signal fired.
  "subnet_multiplier_bp" integer DEFAULT 10000 NOT NULL,
  "order_value_multiplier_bp" integer DEFAULT 10000 NOT NULL,
  "refund_penalty_bp" integer DEFAULT 10000 NOT NULL,
  "cancellation_penalty_bp" integer DEFAULT 10000 NOT NULL,
  "enforcement_multiplier_bp" integer DEFAULT 10000 NOT NULL,

  "final_score_points" integer NOT NULL,

  -- The raw inputs, stored beside the score. This is what makes a ranking auditable from a
  -- single row instead of by re-running the job against data that has since moved.
  "qualified_orders_w1" integer NOT NULL,
  "qualified_orders_w2" integer NOT NULL,
  "distinct_qualified_buyers_w1" integer NOT NULL,
  "counted_views_w1" integer NOT NULL,
  "saves_w1" integer NOT NULL,
  "last_qualified_order_at" timestamp,
  "demand_age_days" integer,

  -- EVERY MEASURED RATE IS NULLABLE AND SHIPS ITS SAMPLE SIZE. This is Phase 12's rule
  -- applied to a snapshot instead of a wire: "scored 0 because we cannot measure it" and
  -- "scored 0 because it is genuinely 0%" must stay distinguishable in the stored row,
  -- forever, or nobody can ever audit why a product ranked where it did.
  "conversion_rate_bp" integer,
  "conversion_sample_size" integer,
  "seller_on_time_rate_bp" integer,
  "seller_on_time_sample_size" integer,
  "subnet_concentration_bp" integer,
  "subnet_sample_size" integer,

  "ranking_mode" "public"."commerce_ranking_mode" NOT NULL,
  "score_algorithm_version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "commerce_product_trending_snapshot" ADD CONSTRAINT "commerce_product_trending_snapshot_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_product_trending_snapshot" ADD CONSTRAINT "commerce_product_trending_snapshot_category_id_commerce_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."commerce_category"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "commerce_product_trending_snapshot_product_unq" ON "commerce_product_trending_snapshot" USING btree ("as_of","product_id");--> statement-breakpoint

-- THE SECOND UNIQUE INDEX IS LOAD-BEARING. It makes a tie an INSERT FAILURE rather than
-- "whichever order the planner happened to produce" — which is what forces the scorer to
-- carry a total order all the way down to a deterministic tiebreak.
CREATE UNIQUE INDEX "commerce_product_trending_snapshot_rank_unq" ON "commerce_product_trending_snapshot" USING btree ("as_of","category_id","rank");--> statement-breakpoint

CREATE INDEX "commerce_product_trending_snapshot_product_idx" ON "commerce_product_trending_snapshot" USING btree ("product_id","as_of" DESC);--> statement-breakpoint

ALTER TABLE "commerce_product_trending_snapshot" ADD CONSTRAINT "commerce_product_trending_snapshot_score_ck" CHECK (
  rank >= 1
  AND trending_score_points BETWEEN 0 AND 100
  AND qualified_velocity_points >= 0
  AND demand_freshness_points >= 0
  AND conversion_quality_points >= 0
  AND seller_trust_points >= 0
  AND buyer_engagement_points >= 0
  AND qualified_velocity_points + demand_freshness_points + conversion_quality_points
      + seller_trust_points + buyer_engagement_points = trending_score_points
);--> statement-breakpoint

-- A PENALTY CAN NEVER PROMOTE, as a database fact rather than a code convention. Every
-- multiplier is bounded at or below 1.0 and the final score cannot exceed the base.
ALTER TABLE "commerce_product_trending_snapshot" ADD CONSTRAINT "commerce_product_trending_snapshot_penalty_ck" CHECK (
  subnet_multiplier_bp BETWEEN 0 AND 10000
  AND order_value_multiplier_bp BETWEEN 0 AND 10000
  AND refund_penalty_bp BETWEEN 0 AND 10000
  AND cancellation_penalty_bp BETWEEN 0 AND 10000
  AND enforcement_multiplier_bp BETWEEN 0 AND 10000
  AND final_score_points BETWEEN 0 AND trending_score_points
);--> statement-breakpoint

-- A rate present without its sample size is exactly the ambiguity this phase exists to
-- prevent, so the pairing is enforced in BOTH directions.
ALTER TABLE "commerce_product_trending_snapshot" ADD CONSTRAINT "commerce_product_trending_snapshot_sample_ck" CHECK (
  (conversion_rate_bp IS NULL) = (conversion_sample_size IS NULL)
  AND (seller_on_time_rate_bp IS NULL) = (seller_on_time_sample_size IS NULL)
  AND (subnet_concentration_bp IS NULL) = (subnet_sample_size IS NULL)
  AND (conversion_rate_bp IS NULL OR conversion_rate_bp BETWEEN 0 AND 10000)
  AND (seller_on_time_rate_bp IS NULL OR seller_on_time_rate_bp BETWEEN 0 AND 10000)
  AND (subnet_concentration_bp IS NULL OR subnet_concentration_bp BETWEEN 0 AND 10000)
  AND (conversion_sample_size IS NULL OR conversion_sample_size >= 0)
  AND (seller_on_time_sample_size IS NULL OR seller_on_time_sample_size >= 0)
  AND (subnet_sample_size IS NULL OR subnet_sample_size >= 0)
);--> statement-breakpoint

ALTER TABLE "commerce_product_trending_snapshot" ADD CONSTRAINT "commerce_product_trending_snapshot_inputs_ck" CHECK (
  qualified_orders_w1 >= 0 AND qualified_orders_w2 >= 0
  AND distinct_qualified_buyers_w1 >= 0 AND counted_views_w1 >= 0 AND saves_w1 >= 0
  AND (demand_age_days IS NULL OR demand_age_days >= 0)
  AND currency ~ '^[A-Z]{3}$'
);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The live row a rail reads.
--
-- Cleared and re-set wholesale each run. Without the CLEAR, a product that fell out of its
-- category's top N would keep last hour's rank forever — the failure `recompute-trending-videos`
-- documents for `video_stats.trending_rank`.
-- ---------------------------------------------------------------------------
CREATE TABLE "commerce_product_ranking_state" (
  "product_id" text PRIMARY KEY NOT NULL,
  "category_id" text,
  -- NULL means "not ranked right now", which is a normal state and not an error.
  "trending_rank_in_category" integer,
  "final_score_points" integer NOT NULL,
  "ranking_mode" "public"."commerce_ranking_mode" NOT NULL,
  "score_algorithm_version" integer DEFAULT 1 NOT NULL,
  "computed_at" timestamp NOT NULL
);--> statement-breakpoint

ALTER TABLE "commerce_product_ranking_state" ADD CONSTRAINT "commerce_product_ranking_state_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_product_ranking_state" ADD CONSTRAINT "commerce_product_ranking_state_category_id_commerce_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."commerce_category"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- The rail's driving index: "this category, in rank order". Partial, because most of the
-- catalog is unranked at any moment and there is no reason to index nulls.
CREATE INDEX "commerce_product_ranking_state_category_rank_idx" ON "commerce_product_ranking_state" USING btree ("category_id","trending_rank_in_category") WHERE trending_rank_in_category IS NOT NULL;--> statement-breakpoint

ALTER TABLE "commerce_product_ranking_state" ADD CONSTRAINT "commerce_product_ranking_state_bounds_ck" CHECK (
  final_score_points BETWEEN 0 AND 100
  AND (trending_rank_in_category IS NULL OR trending_rank_in_category >= 1)
);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Enforcement, which outlives the hourly run.
-- ---------------------------------------------------------------------------
CREATE TABLE "commerce_product_ranking_enforcement" (
  "product_id" text PRIMARY KEY NOT NULL,
  "action" "public"."commerce_ranking_enforcement_action" NOT NULL,
  "action_source" "public"."commerce_ranking_action_source" NOT NULL,
  "penalty_kinds" "public"."commerce_ranking_penalty_kind"[] DEFAULT '{}' NOT NULL,

  -- Why, in words a seller could be shown. An enforcement with no explanation is not
  -- appealable, and an unappealable suppression is how a marketplace loses honest sellers.
  "reason" text NOT NULL,

  -- NULL for an automatic action. See the header on `commerce_ranking_action_source`.
  "decided_by_user_id" text,

  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "commerce_product_ranking_enforcement" ADD CONSTRAINT "commerce_product_ranking_enforcement_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_product_ranking_enforcement" ADD CONSTRAINT "commerce_product_ranking_enforcement_decided_by_user_id_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- Bound in BOTH directions, the shape `commerce_moderation_action` established: an
-- automatic action names nobody, and a moderator action must name someone.
ALTER TABLE "commerce_product_ranking_enforcement" ADD CONSTRAINT "commerce_product_ranking_enforcement_source_ck" CHECK (
  (action_source = 'automatic' AND decided_by_user_id IS NULL)
  OR (action_source = 'moderator' AND decided_by_user_id IS NOT NULL)
);--> statement-breakpoint

ALTER TABLE "commerce_product_ranking_enforcement" ADD CONSTRAINT "commerce_product_ranking_enforcement_reason_ck" CHECK (length(btrim(reason)) BETWEEN 3 AND 1000);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Every evaluation the breaker made, including the ones that did nothing.
--
-- `action = 'none'` rows are the POINT of this table for the first weeks of life: the
-- breaker ships observe-only, and the rate at which it WOULD have fired is what justifies
-- letting it fire. A breaker enabled on a designer's confidence rather than an observed
-- false-positive rate is how a marketplace suppresses honest sellers.
-- ---------------------------------------------------------------------------
CREATE TABLE "commerce_ranking_enforcement_event" (
  "id" text PRIMARY KEY NOT NULL,
  "product_id" text NOT NULL,
  "as_of" timestamp NOT NULL,
  "action" "public"."commerce_ranking_enforcement_action" NOT NULL,
  "action_source" "public"."commerce_ranking_action_source" NOT NULL,
  "penalty_kinds" "public"."commerce_ranking_penalty_kind"[] DEFAULT '{}' NOT NULL,

  -- Which clauses of the kill-switch were satisfied, and which could not be evaluated at
  -- all. The second list is why this ships honest: at launch `fraud_risk_score` has no
  -- definable input, so it appears here as unevaluated rather than silently passing.
  "satisfied_clauses" text[] DEFAULT '{}' NOT NULL,
  "unevaluated_clauses" text[] DEFAULT '{}' NOT NULL,

  "decided_by_user_id" text,
  "note" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "commerce_ranking_enforcement_event" ADD CONSTRAINT "commerce_ranking_enforcement_event_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_ranking_enforcement_event" ADD CONSTRAINT "commerce_ranking_enforcement_event_decided_by_user_id_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "commerce_ranking_enforcement_event_product_idx" ON "commerce_ranking_enforcement_event" USING btree ("product_id","as_of" DESC);--> statement-breakpoint

-- "How often would the breaker have fired last week?" — the query that decides whether
-- enforcement may be enabled.
CREATE INDEX "commerce_ranking_enforcement_event_action_idx" ON "commerce_ranking_enforcement_event" USING btree ("as_of" DESC,"action");--> statement-breakpoint

ALTER TABLE "commerce_ranking_enforcement_event" ADD CONSTRAINT "commerce_ranking_enforcement_event_source_ck" CHECK (
  (action_source = 'automatic' AND decided_by_user_id IS NULL)
  OR (action_source = 'moderator' AND decided_by_user_id IS NOT NULL)
);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The per-product daily series.
--
-- Without this, refinement 6's MAD baseline has no history to be a baseline OF, and the
-- dynamic spike trigger degrades permanently to its minimum floors. Five integers per
-- product per day.
-- ---------------------------------------------------------------------------
CREATE TABLE "commerce_product_daily_signal" (
  "product_id" text NOT NULL,
  "signal_date" date NOT NULL,
  "counted_views" integer DEFAULT 0 NOT NULL,
  "saves" integer DEFAULT 0 NOT NULL,
  "shares" integer DEFAULT 0 NOT NULL,
  "qualified_orders" integer DEFAULT 0 NOT NULL,
  "qualified_order_value_in_cents" bigint DEFAULT 0 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "commerce_product_daily_signal_pk" PRIMARY KEY("product_id","signal_date")
);--> statement-breakpoint

ALTER TABLE "commerce_product_daily_signal" ADD CONSTRAINT "commerce_product_daily_signal_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- The baseline read: "the last N days for this product, newest first."
CREATE INDEX "commerce_product_daily_signal_recent_idx" ON "commerce_product_daily_signal" USING btree ("product_id","signal_date" DESC);--> statement-breakpoint

ALTER TABLE "commerce_product_daily_signal" ADD CONSTRAINT "commerce_product_daily_signal_bounds_ck" CHECK (
  counted_views >= 0 AND saves >= 0 AND shares >= 0
  AND qualified_orders >= 0 AND qualified_order_value_in_cents >= 0
);
