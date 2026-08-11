import { randomUUID } from "node:crypto";

import { and, desc, eq, isNotNull, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceCategoryDemandSnapshot,
  commerceProductRankingEnforcement,
  commerceProductRankingState,
  commerceProductTrendingSnapshot,
  commerceRankingEnforcementEvent,
  product,
} from "#src/db/schema.js";
import {
  resolveCategoryPrior,
  smoothRateTowardPrior,
  type CategoryPriorCandidate,
} from "#src/lib/commerce-category-prior.js";
import {
  enforcementMultiplierBasisPoints,
  evaluateFraudGuard,
  type RankingEnforcementAction,
} from "#src/lib/commerce-fraud-guard.js";
import {
  applyMultipliers,
  computeNegativeRatePenalty,
  computeOrderValueMultiplier,
  computeSubnetConcentrationPenalty,
  NEUTRAL_MULTIPLIER_BASIS_POINTS,
} from "#src/lib/commerce-ranking-multipliers.js";
import { computeSpikeThreshold } from "#src/lib/commerce-robust-statistics.js";
import {
  COMMERCE_TRENDING_ALGORITHM_VERSION,
  explorationOrderKey,
  scoreCommerceTrendingCandidate,
} from "#src/lib/commerce-trending-score.js";
import { decodeStoreCursor, encodeStoreCursor } from "#src/lib/store-cursor.js";
import { utcDayStringOf } from "#src/lib/utc-day.js";
import { requirePlatformCapability } from "#src/services/platform-role.service.js";
import type { Result } from "#src/types/index.js";

/**
 * The ranking engine's data assembly (STORE Phase 13).
 *
 * WHERE THE WORK IS SPLIT. Every arithmetic decision lives in a pure module under
 * `src/lib/` — the scorer, the multipliers, the prior ladder, the robust statistics, the
 * fraud guard. This file does three things and nothing else: it reads signals, it hands
 * them to those modules, and it writes what came back. That is what makes the formulas
 * testable without a database and the queries reviewable without a scorer in the way.
 *
 * THE ORDER THESE RUN IN IS EXPRESSED BY CRON, NOT BY CODE, matching the house convention:
 * the daily rollup at 02:50 and the category demand at 03:00 both land before the hourly
 * trending run reads them. A run that finds no demand snapshot does not fail — it scores in
 * exploration mode, which is the same answer it would give for a genuinely sparse category.
 */

/** A category needs this many qualified orders in 30 days before a percentile means anything. */
export const CATEGORY_PERCENTILE_MINIMUM_ORDERS = 30;

/** Rows kept per category in the live ranking state. */
export const MAXIMUM_RANKED_PRODUCTS_PER_CATEGORY = 100;

/**
 * Refinement 2's calendar gate, enforced rather than documented.
 *
 * W2 is days 8-14, so before there are fourteen days of `confirmed_at` history the window
 * is measuring a period that did not exist. A run before then writes
 * `score_algorithm_version = 0`, which every read path refuses — a logged refusal rather
 * than a silent bad ranking, and the reason risk 2 in the plan exists.
 */
export const MINIMUM_CONFIRMED_HISTORY_DAYS = 14;
export const PRE_GATE_ALGORITHM_VERSION = 0;

const MILLISECONDS_PER_DAY = 86_400_000;

/** The observed conversion rate of one category row, or `null` when it has no viewers. */
function conversionRateOf(row: CategoryDemandRow | undefined): number | null {
  if (row === undefined || row.conversion_denominator <= 0) return null;
  return Math.round((row.conversion_numerator * 10_000) / row.conversion_denominator);
}

interface CategoryDemandRow extends Record<string, unknown> {
  readonly category_id: string;
  readonly currency: string;
  readonly qualified_order_count_30d: number;
  readonly active_product_count: number;
  readonly median_order_value_in_cents: number | null;
  readonly p90_refund_rate_bp: number | null;
  readonly p90_cancellation_rate_bp: number | null;
  readonly conversion_numerator: number;
  readonly conversion_denominator: number;
  readonly parent_category_id: string | null;
}

/**
 * Recomputes per-category demand statistics, once per category per currency.
 *
 * `percentile_disc` and not `percentile_cont`: an interpolated median invents a value no
 * order ever had, and every threshold derived from this is compared against real money.
 * The specification's T-Digest is not available — only `citext` is installed — and an exact
 * percentile over the qualified sample is the fallback it explicitly permits, which is
 * cheap here precisely because a category below the floor is routed to exploration anyway.
 */
export async function recomputeCategoryDemand(asOf: Date): Promise<{ rowsWritten: number }> {
  const windowStart = new Date(asOf.getTime() - 30 * MILLISECONDS_PER_DAY);

  const result = await db.execute<CategoryDemandRow>(sql`
    WITH qualified_lines AS (
      SELECT
        p.category_id,
        o.currency,
        o.id AS order_id,
        l.line_total_in_cents,
        l.quantity_refunded,
        l.quantity_ordered,
        o.cancelled_at
      FROM commerce_order o
      JOIN commerce_order_product_line l ON l.order_id = o.id
      JOIN product p ON p.id = l.product_id
      WHERE o.buyer_qualification_state = 'qualified'
        AND o.confirmed_at IS NOT NULL
        AND o.confirmed_at >= ${windowStart}
        AND o.confirmed_at < ${asOf}
        AND p.category_id IS NOT NULL
    )
    SELECT
      c.id AS category_id,
      cur.currency,
      count(DISTINCT q.order_id)::int AS qualified_order_count_30d,
      (SELECT count(*)::int FROM product ap
        WHERE ap.category_id = c.id AND ap.status = 'active' AND ap.moderation_state = 'approved')
        AS active_product_count,
      percentile_disc(0.5) WITHIN GROUP (ORDER BY q.line_total_in_cents)::bigint
        AS median_order_value_in_cents,
      percentile_disc(0.9) WITHIN GROUP (
        ORDER BY CASE WHEN q.quantity_ordered > 0
                      THEN (q.quantity_refunded * 10000) / q.quantity_ordered ELSE 0 END
      )::int AS p90_refund_rate_bp,
      percentile_disc(0.9) WITHIN GROUP (
        ORDER BY CASE WHEN q.cancelled_at IS NOT NULL THEN 10000 ELSE 0 END
      )::int AS p90_cancellation_rate_bp,
      count(DISTINCT q.order_id)::int AS conversion_numerator,
      (SELECT count(*)::int FROM commerce_product_view_session v
         JOIN product vp ON vp.id = v.product_id
        WHERE vp.category_id = c.id AND v.is_counted_view
          AND v.first_beacon_at >= ${windowStart} AND v.first_beacon_at < ${asOf})
        AS conversion_denominator,
      c.parent_category_id
    FROM commerce_category c
    JOIN qualified_lines q ON q.category_id = c.id
    JOIN LATERAL (SELECT DISTINCT q2.currency FROM qualified_lines q2 WHERE q2.category_id = c.id) cur
      ON cur.currency = q.currency
    WHERE c.state = 'active'
    GROUP BY c.id, cur.currency, c.parent_category_id
  `);

  const rows = result.rows;
  if (rows.length === 0) return { rowsWritten: 0 };

  // The global prior, computed once across every category, is the ladder's third rung.
  const globalNumerator = rows.reduce((total, row) => total + row.conversion_numerator, 0);
  const globalDenominator = rows.reduce((total, row) => total + row.conversion_denominator, 0);
  const globalRateBasisPoints =
    globalDenominator > 0 ? Math.round((globalNumerator * 10_000) / globalDenominator) : null;

  const byCategory = new Map<string, CategoryDemandRow[]>();
  for (const row of rows) {
    const bucket = byCategory.get(row.category_id) ?? [];
    bucket.push(row);
    byCategory.set(row.category_id, bucket);
  }

  const values = rows.map((row) => {
    const parentRows = row.parent_category_id ? byCategory.get(row.parent_category_id) : undefined;
    const parentRow = parentRows?.[0];

    const prior = resolveCategoryPrior([
      {
        level: "category",
        rateBasisPoints: conversionRateOf(row),
        sampleSize: row.conversion_denominator,
      },
      {
        level: "parent_category",
        rateBasisPoints: conversionRateOf(parentRow),
        sampleSize: parentRow?.conversion_denominator ?? 0,
      },
      { level: "global", rateBasisPoints: globalRateBasisPoints, sampleSize: globalDenominator },
    ] satisfies readonly CategoryPriorCandidate[]);

    return {
      id: randomUUID(),
      categoryId: row.category_id,
      currency: row.currency,
      asOf,
      qualifiedOrderCount30d: row.qualified_order_count_30d,
      activeProductCount: row.active_product_count,
      medianOrderValueInCents: row.median_order_value_in_cents,
      p90RefundRateBasisPoints: row.p90_refund_rate_bp,
      p90CancellationRateBasisPoints: row.p90_cancellation_rate_bp,
      priorConversionRateBasisPoints: prior.rateBasisPoints,
      priorSampleSize: prior.sampleSize,
      priorLevel: prior.level,
      rankingMode:
        row.qualified_order_count_30d >= CATEGORY_PERCENTILE_MINIMUM_ORDERS
          ? ("percentile" as const)
          : ("sparse_exploration" as const),
      scoreAlgorithmVersion: COMMERCE_TRENDING_ALGORITHM_VERSION,
    };
  });

  // Append-only: a replayed `asOf` is a no-op, never an overwrite, which is what keeps an
  // old run reproducible.
  await db.insert(commerceCategoryDemandSnapshot).values(values).onConflictDoNothing();

  return { rowsWritten: values.length };
}

/**
 * Rolls yesterday's signals into the per-product daily series.
 *
 * THE SERIES THE SPIKE DETECTOR CANNOT EXIST WITHOUT. Refinement 6's MAD baseline needs
 * per-product history; without this table it would fall back to its minimum floors forever
 * while appearing to be a dynamic trigger.
 */
export async function rollupProductDailySignal(asOf: Date): Promise<{ rowsWritten: number }> {
  const dayStart = new Date(asOf.getTime() - MILLISECONDS_PER_DAY);
  const signalDate = utcDayStringOf(dayStart);

  const result = await db.execute<{ rows_written: number }>(sql`
    WITH view_counts AS (
      SELECT product_id, count(*)::int AS counted_views
        FROM commerce_product_view_session
       WHERE is_counted_view AND view_day_bucket = ${signalDate}::date
       GROUP BY product_id
    ),
    save_counts AS (
      SELECT product_id, count(*)::int AS saves
        FROM commerce_product_engagement
       WHERE engagement_kind = 'saved'
         AND created_at >= ${dayStart} AND created_at < ${asOf}
       GROUP BY product_id
    ),
    share_counts AS (
      SELECT product_id, count(*)::int AS shares
        FROM commerce_product_share
       WHERE counted AND share_day_bucket = ${signalDate}::date
       GROUP BY product_id
    ),
    order_counts AS (
      SELECT l.product_id,
             count(DISTINCT o.id)::int AS qualified_orders,
             coalesce(sum(l.line_total_in_cents), 0)::bigint AS qualified_order_value_in_cents
        FROM commerce_order o
        JOIN commerce_order_product_line l ON l.order_id = o.id
       WHERE o.buyer_qualification_state = 'qualified'
         AND o.confirmed_at >= ${dayStart} AND o.confirmed_at < ${asOf}
         AND l.product_id IS NOT NULL
       GROUP BY l.product_id
    ),
    merged AS (
      SELECT p.id AS product_id,
             coalesce(v.counted_views, 0) AS counted_views,
             coalesce(s.saves, 0) AS saves,
             coalesce(sh.shares, 0) AS shares,
             coalesce(o.qualified_orders, 0) AS qualified_orders,
             coalesce(o.qualified_order_value_in_cents, 0) AS qualified_order_value_in_cents
        FROM product p
        LEFT JOIN view_counts v ON v.product_id = p.id
        LEFT JOIN save_counts s ON s.product_id = p.id
        LEFT JOIN share_counts sh ON sh.product_id = p.id
        LEFT JOIN order_counts o ON o.product_id = p.id
       WHERE coalesce(v.counted_views, 0) > 0 OR coalesce(s.saves, 0) > 0
          OR coalesce(sh.shares, 0) > 0 OR coalesce(o.qualified_orders, 0) > 0
    )
    INSERT INTO commerce_product_daily_signal
      (product_id, signal_date, counted_views, saves, shares, qualified_orders, qualified_order_value_in_cents)
    SELECT product_id, ${signalDate}::date, counted_views, saves, shares, qualified_orders, qualified_order_value_in_cents
      FROM merged
    ON CONFLICT (product_id, signal_date) DO NOTHING
    RETURNING 1 AS rows_written
  `);

  /*
   * A DAY WITH NO SIGNAL WRITES NO ROW, deliberately — the `recompute-user-affinities` rule.
   * The absence of a row is what tells the baseline "nothing happened", and a stored zero
   * would be indistinguishable from a day the rollup never ran. The MAD reader treats a
   * missing day as zero, which is the same answer with one fewer way to be wrong.
   */
  return { rowsWritten: result.rows.length };
}

interface TrendingCandidateRow extends Record<string, unknown> {
  readonly product_id: string;
  readonly category_id: string | null;
  readonly currency: string;
  readonly seller_organization_id: string;
  readonly qualified_orders_w1: number;
  readonly qualified_orders_w2: number;
  readonly distinct_qualified_buyers_w1: number;
  /**
   * A STRING from the driver, not a number: node-postgres returns `bigint` as text to
   * avoid silent precision loss, and `avg(...)::bigint` is a bigint. Typing this honestly
   * is what keeps the conversion below from looking redundant to a linter — it is not.
   */
  readonly average_order_value_w2: string | null;
  /** A STRING from the driver, despite the column being a timestamp. See the insert. */
  readonly last_qualified_order_at: string | null;
  readonly counted_views_w1: number;
  readonly saves_w1: number;
  readonly distinct_savers_w1: number;
  readonly converting_viewers_w1: number;
  readonly hashed_save_count: number;
  readonly top_subnet_save_count: number;
  readonly refund_rate_bp: number | null;
  readonly refunded_sample: number;
  readonly cancellation_rate_bp: number | null;
  readonly cancellation_sample: number;
  readonly seller_trade_active: boolean;
  readonly seller_has_registration: boolean;
  readonly seller_has_certification: boolean;
  readonly seller_on_time_rate_bp: number | null;
  readonly seller_on_time_sample: number;
}

/**
 * The hourly run: score every eligible product, rank within its category, and record what
 * the circuit breaker would have done.
 */
export async function recomputeProductTrending(
  asOf: Date,
  options: { readonly enforcementEnabled?: boolean } = {},
): Promise<{ scored: number; ranked: number; gated: boolean }> {
  const enforcementEnabled = options.enforcementEnabled ?? false;

  /*
   * THE CALENDAR GATE. Before fourteen days of confirmation history exist, W2 measures a
   * period that did not happen. Rather than publish a ranking built on half a window, the
   * run still executes and still writes — but at `score_algorithm_version = 0`, which the
   * read paths refuse. An operator sees rows and a log line instead of silence.
   */
  const [historyRow] = (
    await db.execute<{ earliest: Date | null }>(
      sql`SELECT min(confirmed_at) AS earliest FROM commerce_order WHERE confirmed_at IS NOT NULL`,
    )
  ).rows;
  const earliest = historyRow?.earliest ?? null;
  const gated =
    earliest === null ||
    asOf.getTime() - new Date(earliest).getTime() <
      MINIMUM_CONFIRMED_HISTORY_DAYS * MILLISECONDS_PER_DAY;

  const w1Start = new Date(asOf.getTime() - 7 * MILLISECONDS_PER_DAY);
  const w2Start = new Date(asOf.getTime() - 14 * MILLISECONDS_PER_DAY);

  const candidates = (
    await db.execute<TrendingCandidateRow>(sql`
      WITH qualified AS (
        SELECT l.product_id, o.id AS order_id, o.buyer_organization_id, o.confirmed_at,
               o.cancelled_at, l.line_total_in_cents, l.quantity_ordered, l.quantity_refunded
          FROM commerce_order o
          JOIN commerce_order_product_line l ON l.order_id = o.id
         WHERE o.buyer_qualification_state = 'qualified'
           AND o.confirmed_at IS NOT NULL
           AND o.confirmed_at >= ${w2Start} AND o.confirmed_at < ${asOf}
           AND l.product_id IS NOT NULL
      ),
      subnet_saves AS (
        SELECT product_id, count(*)::int AS hashed_save_count,
               max(per_subnet)::int AS top_subnet_save_count
          FROM (
            SELECT e.product_id, e.subnet_hash,
                   count(*) OVER (PARTITION BY e.product_id, e.subnet_hash) AS per_subnet
              FROM commerce_product_engagement e
             WHERE e.subnet_hash IS NOT NULL AND e.engagement_kind = 'saved'
          ) s
         GROUP BY product_id
      )
      SELECT
        p.id AS product_id,
        p.category_id,
        p.currency,
        p.seller_organization_id,
        count(DISTINCT q.order_id) FILTER (WHERE q.confirmed_at >= ${w1Start})::int AS qualified_orders_w1,
        count(DISTINCT q.order_id)::int AS qualified_orders_w2,
        count(DISTINCT q.buyer_organization_id) FILTER (WHERE q.confirmed_at >= ${w1Start})::int
          AS distinct_qualified_buyers_w1,
        avg(q.line_total_in_cents)::bigint AS average_order_value_w2,
        max(q.confirmed_at) AS last_qualified_order_at,
        (SELECT count(*)::int FROM commerce_product_view_session v
          WHERE v.product_id = p.id AND v.is_counted_view
            AND v.first_beacon_at >= ${w1Start} AND v.first_beacon_at < ${asOf}) AS counted_views_w1,
        (SELECT count(*)::int FROM commerce_product_engagement e
          WHERE e.product_id = p.id AND e.engagement_kind = 'saved'
            AND e.created_at >= ${w1Start}) AS saves_w1,
        (SELECT count(DISTINCT e.user_id)::int FROM commerce_product_engagement e
          WHERE e.product_id = p.id AND e.engagement_kind = 'saved'
            AND e.created_at >= ${w1Start}) AS distinct_savers_w1,
        (SELECT count(DISTINCT v.viewer_id)::int FROM commerce_product_view_session v
          WHERE v.product_id = p.id AND v.is_counted_view AND v.viewer_id IS NOT NULL
            AND v.first_beacon_at >= ${w1Start}) AS converting_viewers_w1,
        coalesce(ss.hashed_save_count, 0) AS hashed_save_count,
        coalesce(ss.top_subnet_save_count, 0) AS top_subnet_save_count,
        (CASE WHEN sum(q.quantity_ordered) > 0
              THEN (sum(q.quantity_refunded) * 10000 / sum(q.quantity_ordered))::int END)
          AS refund_rate_bp,
        count(DISTINCT q.order_id)::int AS refunded_sample,
        (CASE WHEN count(DISTINCT q.order_id) > 0
              THEN (count(DISTINCT q.order_id) FILTER (WHERE q.cancelled_at IS NOT NULL) * 10000
                    / count(DISTINCT q.order_id))::int END) AS cancellation_rate_bp,
        count(DISTINCT q.order_id)::int AS cancellation_sample,
        (org.trade_state = 'active') AS seller_trade_active,
        EXISTS (SELECT 1 FROM commerce_organization_verification ov
                 WHERE ov.organization_id = org.id AND ov.state = 'approved'
                   AND ov.verification_kind IN ('business_registration', 'tax_registration'))
          AS seller_has_registration,
        EXISTS (SELECT 1 FROM commerce_organization_certification oc
                 WHERE oc.organization_id = org.id AND oc.state = 'approved'
                   AND (oc.valid_until IS NULL OR oc.valid_until >= current_date))
          AS seller_has_certification,
        NULL::int AS seller_on_time_rate_bp,
        0 AS seller_on_time_sample
      FROM product p
      JOIN commerce_organization org ON org.id = p.seller_organization_id
      JOIN qualified q ON q.product_id = p.id
      LEFT JOIN subnet_saves ss ON ss.product_id = p.id
      WHERE p.status = 'active' AND p.moderation_state = 'approved'
        AND org.trade_state = 'active'
        AND NOT EXISTS (SELECT 1 FROM commerce_organization_ranking_exclusion x
                         WHERE x.organization_id = org.id)
      GROUP BY p.id, p.category_id, p.currency, p.seller_organization_id, org.id, org.trade_state,
               ss.hashed_save_count, ss.top_subnet_save_count
    `)
  ).rows;

  if (candidates.length === 0) {
    await clearRankingState(asOf);
    return { scored: 0, ranked: 0, gated };
  }

  const demandByCategoryCurrency = await loadLatestCategoryDemand(asOf);
  const algorithmVersion = gated ? PRE_GATE_ALGORITHM_VERSION : COMMERCE_TRENDING_ALGORITHM_VERSION;

  interface ScoredCandidate {
    readonly row: TrendingCandidateRow;
    readonly breakdown: ReturnType<typeof scoreCommerceTrendingCandidate>;
    readonly finalScorePoints: number;
    readonly multipliers: ReturnType<typeof buildMultipliers>;
    readonly conversionRateBasisPoints: number | null;
    readonly rankingMode: "percentile" | "sparse_exploration";
    readonly enforcementAction: RankingEnforcementAction;
    readonly satisfiedClauses: readonly string[];
    readonly unevaluatedClauses: readonly string[];
  }

  const scored: ScoredCandidate[] = [];

  for (const row of candidates) {
    const demand = demandByCategoryCurrency.get(`${row.category_id ?? ""}:${row.currency}`);

    // Conversion over SIGNED-IN viewers only: an anonymous session has nobody to match an
    // order to, so admitting it would inflate the denominator with traffic that could never
    // appear in the numerator.
    const conversionRateBasisPoints =
      row.converting_viewers_w1 > 0
        ? Math.round((row.distinct_qualified_buyers_w1 * 10_000) / row.converting_viewers_w1)
        : null;

    const smoothed =
      demand === undefined
        ? { rateBasisPoints: conversionRateBasisPoints ?? 0 }
        : smoothRateTowardPrior({
            observedRateBasisPoints: conversionRateBasisPoints,
            observationCount: row.converting_viewers_w1,
            prior: {
              level: demand.priorLevel,
              rateBasisPoints: demand.priorConversionRateBasisPoints ?? 5_000,
              sampleSize: demand.priorSampleSize,
            },
          });

    const demandAgeDays =
      row.last_qualified_order_at === null
        ? null
        : Math.max(
            0,
            Math.floor(
              (asOf.getTime() - new Date(row.last_qualified_order_at).getTime()) /
                MILLISECONDS_PER_DAY,
            ),
          );

    const score = scoreCommerceTrendingCandidate({
      qualifiedOrdersW1: row.qualified_orders_w1,
      qualifiedOrdersW2: row.qualified_orders_w2,
      demandAgeDays,
      smoothedConversionRateBasisPoints:
        conversionRateBasisPoints === null ? null : smoothed.rateBasisPoints,
      sellerOnTimeRateBasisPoints: row.seller_on_time_rate_bp,
      sellerHasActiveTradeState: row.seller_trade_active,
      sellerHasApprovedRegistration: row.seller_has_registration,
      sellerHasLiveCertification: row.seller_has_certification,
      distinctSaversW1: row.distinct_savers_w1,
    });

    // Refinement 1: no qualified demand in W2 is not a low score, it is not a candidate.
    if (score.status === "ineligible") continue;

    const spike = computeSpikeThreshold({
      baselineValues: await loadDailyBaseline(row.product_id, asOf),
      minimumFloor: 100,
    });
    const spikeFlagged = row.counted_views_w1 > spike.threshold * 7;

    const guard = evaluateFraudGuard({
      spikeFlagged,
      productConversionRateBasisPoints: conversionRateBasisPoints,
      categoryAverageConversionRateBasisPoints: demand?.priorConversionRateBasisPoints ?? null,
      qualifiedOrdersLast7Days: row.qualified_orders_w1,
      distinctQualifiedBuyersLast7Days: row.distinct_qualified_buyers_w1,
      // NOT COMPUTABLE at launch. See `commerce-fraud-guard.ts`: every component that would
      // produce it is itself inert, and a score assembled from unavailable inputs is a
      // number with no meaning rather than a conservative estimate.
      fraudRiskScore: null,
      fraudRiskThreshold: 50,
      enforcementEnabled,
    });

    const enforcementAction: RankingEnforcementAction =
      guard.status === "fire" ? guard.action : "none";

    const multipliers = buildMultipliers({
      row,
      demand,
      enforcementAction,
    });

    const finalScorePoints = applyMultipliers(score.breakdown.totalPoints, multipliers);

    scored.push({
      row,
      breakdown: score,
      finalScorePoints,
      multipliers,
      conversionRateBasisPoints,
      rankingMode: demand?.rankingMode ?? "sparse_exploration",
      enforcementAction,
      satisfiedClauses: guard.status === "clear" ? guard.satisfiedClauses : guard.satisfiedClauses,
      unevaluatedClauses: guard.status === "not_evaluated" ? guard.unevaluatedClauses : [],
    });
  }

  const asOfIso = asOf.toISOString();

  /*
   * A TOTAL ORDER, all the way down. `commerce_product_trending_snapshot_rank_unq` makes a
   * tie an INSERT FAILURE rather than an arbitrary order, so the tiebreak chain has to end
   * in something that cannot repeat — the product id.
   *
   * Sparse-exploration candidates draw on a stable hash of (productId, asOf) rather than
   * `random()`, so two runs of one `asOf` agree. Randomness here would break the
   * determinism assertion that is the only thing separating "the scorer is correct" from
   * "the scorer looks correct".
   */
  const byCategory = new Map<string, ScoredCandidate[]>();
  for (const candidate of scored) {
    const key = candidate.row.category_id ?? "";
    const bucket = byCategory.get(key) ?? [];
    bucket.push(candidate);
    byCategory.set(key, bucket);
  }

  /**
   * The PRE-ENFORCEMENT base score per product, for the search-document copy.
   *
   * Search sorts on the base and not the final score, because an enforcement penalty must
   * never make a product unfindable by its own exact title — see the update at the end of
   * the transaction below.
   */
  const scoredBaseByProduct = new Map<string, number>();

  const snapshotRows: (typeof commerceProductTrendingSnapshot.$inferInsert)[] = [];
  const stateRows: (typeof commerceProductRankingState.$inferInsert)[] = [];
  const enforcementEvents: (typeof commerceRankingEnforcementEvent.$inferInsert)[] = [];

  for (const [, bucket] of byCategory) {
    const ordered = bucket.toSorted((left, right) => {
      if (left.rankingMode === "sparse_exploration" && right.rankingMode === "sparse_exploration") {
        /*
         * EXPLORATION ROTATES WITHIN A BAND, IT DOES NOT IGNORE THE SCORE.
         *
         * The first version of this sorted purely on the exploration hash, and the result
         * was that a category's genuinely strongest product could sit third behind two
         * weaker ones. That is not exploration, it is randomisation — and it would have
         * taught every seller that ranking in a sparse category is arbitrary, which is
         * precisely the impression a ranking engine must not create.
         *
         * Banding by ten points keeps "clearly better ranks higher" while still rotating
         * among products that are, on the evidence available, indistinguishable. The
         * evidence really is thin here — that is what `sparse_exploration` means — so
         * rotating between near-equals is honest, and demoting a leader is not.
         */
        const leftBand = Math.floor(left.finalScorePoints / 10);
        const rightBand = Math.floor(right.finalScorePoints / 10);
        return (
          rightBand - leftBand ||
          explorationOrderKey(left.row.product_id, asOfIso) -
            explorationOrderKey(right.row.product_id, asOfIso) ||
          left.row.product_id.localeCompare(right.row.product_id)
        );
      }
      return (
        right.finalScorePoints - left.finalScorePoints ||
        right.row.qualified_orders_w1 - left.row.qualified_orders_w1 ||
        left.row.product_id.localeCompare(right.row.product_id)
      );
    });

    for (const [index, candidate] of ordered.entries()) {
      if (candidate.breakdown.status !== "scored") continue;
      const rank = index + 1;
      const breakdown = candidate.breakdown.breakdown;

      snapshotRows.push({
        asOf,
        productId: candidate.row.product_id,
        categoryId: candidate.row.category_id,
        currency: candidate.row.currency,
        rank,
        qualifiedVelocityPoints: breakdown.qualifiedVelocityPoints,
        demandFreshnessPoints: breakdown.demandFreshnessPoints,
        conversionQualityPoints: breakdown.conversionQualityPoints,
        sellerTrustPoints: breakdown.sellerTrustPoints,
        buyerEngagementPoints: breakdown.buyerEngagementPoints,
        trendingScorePoints: breakdown.totalPoints,
        subnetMultiplierBasisPoints: candidate.multipliers.subnetMultiplierBasisPoints,
        orderValueMultiplierBasisPoints: candidate.multipliers.orderValueMultiplierBasisPoints,
        refundPenaltyBasisPoints: candidate.multipliers.refundPenaltyBasisPoints,
        cancellationPenaltyBasisPoints: candidate.multipliers.cancellationPenaltyBasisPoints,
        enforcementMultiplierBasisPoints: candidate.multipliers.enforcementMultiplierBasisPoints,
        finalScorePoints: candidate.finalScorePoints,
        qualifiedOrdersW1: candidate.row.qualified_orders_w1,
        qualifiedOrdersW2: candidate.row.qualified_orders_w2,
        distinctQualifiedBuyersW1: candidate.row.distinct_qualified_buyers_w1,
        countedViewsW1: candidate.row.counted_views_w1,
        savesW1: candidate.row.saves_w1,
        // `db.execute` returns raw driver values, so a timestamp arrives as a STRING here
        // even though the column is a `Date`. Normalizing at this boundary rather than
        // typing the row as `Date` keeps the lie out of the interface.
        lastQualifiedOrderAt:
          candidate.row.last_qualified_order_at === null
            ? null
            : new Date(candidate.row.last_qualified_order_at),
        demandAgeDays:
          candidate.row.last_qualified_order_at === null
            ? null
            : Math.max(
                0,
                Math.floor(
                  (asOf.getTime() - new Date(candidate.row.last_qualified_order_at).getTime()) /
                    MILLISECONDS_PER_DAY,
                ),
              ),
        // Rate and sample size travel together, always — the CHECK enforces the pairing.
        conversionRateBasisPoints: candidate.conversionRateBasisPoints,
        conversionSampleSize:
          candidate.conversionRateBasisPoints === null ? null : candidate.row.converting_viewers_w1,
        sellerOnTimeRateBasisPoints: candidate.row.seller_on_time_rate_bp,
        sellerOnTimeSampleSize:
          candidate.row.seller_on_time_rate_bp === null
            ? null
            : candidate.row.seller_on_time_sample,
        subnetConcentrationBasisPoints: candidate.multipliers.subnetConcentrationBasisPoints,
        subnetSampleSize:
          candidate.multipliers.subnetConcentrationBasisPoints === null
            ? null
            : candidate.row.hashed_save_count,
        rankingMode: candidate.rankingMode,
        scoreAlgorithmVersion: algorithmVersion,
      });

      scoredBaseByProduct.set(candidate.row.product_id, breakdown.totalPoints);

      if (rank <= MAXIMUM_RANKED_PRODUCTS_PER_CATEGORY) {
        stateRows.push({
          productId: candidate.row.product_id,
          categoryId: candidate.row.category_id,
          trendingRankInCategory: rank,
          finalScorePoints: candidate.finalScorePoints,
          rankingMode: candidate.rankingMode,
          scoreAlgorithmVersion: algorithmVersion,
          computedAt: asOf,
        });
      }

      // EVERY evaluation is recorded, including the ones that did nothing. The `none` rows
      // are what make the would-fire rate countable before enforcement is switched on.
      enforcementEvents.push({
        productId: candidate.row.product_id,
        asOf,
        action: candidate.enforcementAction,
        actionSource: "automatic",
        penaltyKinds: candidate.multipliers.penaltyKinds,
        satisfiedClauses: [...candidate.satisfiedClauses],
        unevaluatedClauses: [...candidate.unevaluatedClauses],
      });
    }
  }

  await db.transaction(async (transaction) => {
    if (snapshotRows.length > 0) {
      for (const chunk of chunked(snapshotRows, 500)) {
        await transaction
          .insert(commerceProductTrendingSnapshot)
          .values(chunk)
          .onConflictDoNothing();
      }
    }

    /*
     * CLEARED THEN SET. Without the clear, a product that fell out of its category's top N
     * would keep last hour's rank forever — the failure `recompute-trending-videos`
     * documents for `video_stats.trending_rank`.
     */
    await transaction.execute(sql`DELETE FROM commerce_product_ranking_state`);
    if (stateRows.length > 0) {
      for (const chunk of chunked(stateRows, 500)) {
        await transaction.insert(commerceProductRankingState).values(chunk);
      }
    }

    if (enforcementEvents.length > 0) {
      for (const chunk of chunked(enforcementEvents, 500)) {
        await transaction.insert(commerceRankingEnforcementEvent).values(chunk);
      }
    }

    /*
     * The denormalized copy search sorts on.
     *
     * `SET LOCAL qatoto.ranking_writer` is what gets past
     * `store_search_document_preserve_discovery_score`. Every other writer of this table —
     * `refreshProductSearchDocument`, and anything a future contributor adds — has its
     * change to these two columns silently reverted, which is what stops an ordinary
     * product edit from erasing an hour of scoring.
     *
     * UPDATE ONLY. Never insert, never delete: eligibility is not this job's business, and
     * when `refreshProductSearchDocument` deletes a de-listed product's document the score
     * goes with it, which is correct.
     *
     * The score written is the PRE-ENFORCEMENT base. An enforcement penalty may lower a
     * product's position in a discovery rail; it may never lower its position in a query
     * the buyer typed by name. Exact-match findability is a floor.
     */
    await transaction.execute(sql`SET LOCAL qatoto.ranking_writer = 'on'`);

    await transaction.execute(sql`
      UPDATE store_search_document AS d
         SET discovery_score_points = NULL, discovery_score_computed_at = NULL
       WHERE d.document_kind = 'product' AND d.discovery_score_points IS NOT NULL
    `);

    if (stateRows.length > 0) {
      const scoreTuples = sql.join(
        stateRows.map(
          (row) => sql`(${row.productId}, ${scoredBaseByProduct.get(row.productId) ?? 0}::int)`,
        ),
        sql`, `,
      );
      await transaction.execute(sql`
        UPDATE store_search_document AS d
           SET discovery_score_points = incoming.points,
               discovery_score_computed_at = ${asOf}
          FROM (VALUES ${scoreTuples}) AS incoming(entity_id, points)
         WHERE d.document_kind = 'product' AND d.entity_id = incoming.entity_id
      `);
    }
  });

  return { scored: scored.length, ranked: stateRows.length, gated };
}

function buildMultipliers(input: {
  readonly row: TrendingCandidateRow;
  readonly demand: LatestCategoryDemand | undefined;
  readonly enforcementAction: RankingEnforcementAction;
}): {
  readonly subnetMultiplierBasisPoints: number;
  readonly orderValueMultiplierBasisPoints: number;
  readonly refundPenaltyBasisPoints: number;
  readonly cancellationPenaltyBasisPoints: number;
  readonly enforcementMultiplierBasisPoints: number;
  readonly subnetConcentrationBasisPoints: number | null;
  readonly penaltyKinds: (
    | "subnet_concentration"
    | "refund_rate"
    | "cancellation_rate"
    | "low_order_value"
  )[];
} {
  const subnet = computeSubnetConcentrationPenalty({
    hashedObservationCount: input.row.hashed_save_count,
    topSubnetObservationCount: input.row.top_subnet_save_count,
  });

  const orderValueMultiplierBasisPoints = computeOrderValueMultiplier({
    averageQualifiedOrderValueInCents: Number(input.row.average_order_value_w2 ?? 0),
    categoryMedianOrderValueInCents: input.demand?.medianOrderValueInCents ?? null,
  });

  const refundPenaltyBasisPoints = computeNegativeRatePenalty({
    observedRateBasisPoints: input.row.refund_rate_bp,
    categoryP90BasisPoints: input.demand?.p90RefundRateBasisPoints ?? null,
    sampleSize: input.row.refunded_sample,
  });

  const cancellationPenaltyBasisPoints = computeNegativeRatePenalty({
    observedRateBasisPoints: input.row.cancellation_rate_bp,
    categoryP90BasisPoints: input.demand?.p90CancellationRateBasisPoints ?? null,
    sampleSize: input.row.cancellation_sample,
  });

  const subnetMultiplierBasisPoints =
    subnet.status === "measured" ? subnet.multiplierBasisPoints : NEUTRAL_MULTIPLIER_BASIS_POINTS;

  const penaltyKinds: (
    | "subnet_concentration"
    | "refund_rate"
    | "cancellation_rate"
    | "low_order_value"
  )[] = [];
  if (subnetMultiplierBasisPoints < NEUTRAL_MULTIPLIER_BASIS_POINTS) {
    penaltyKinds.push("subnet_concentration");
  }
  if (refundPenaltyBasisPoints < NEUTRAL_MULTIPLIER_BASIS_POINTS) penaltyKinds.push("refund_rate");
  if (cancellationPenaltyBasisPoints < NEUTRAL_MULTIPLIER_BASIS_POINTS) {
    penaltyKinds.push("cancellation_rate");
  }
  if (orderValueMultiplierBasisPoints < NEUTRAL_MULTIPLIER_BASIS_POINTS) {
    penaltyKinds.push("low_order_value");
  }

  return {
    subnetMultiplierBasisPoints,
    orderValueMultiplierBasisPoints,
    refundPenaltyBasisPoints,
    cancellationPenaltyBasisPoints,
    enforcementMultiplierBasisPoints: enforcementMultiplierBasisPoints(input.enforcementAction),
    subnetConcentrationBasisPoints:
      subnet.status === "measured" ? subnet.concentrationBasisPoints : null,
    penaltyKinds,
  };
}

interface LatestCategoryDemand {
  readonly medianOrderValueInCents: number | null;
  readonly p90RefundRateBasisPoints: number | null;
  readonly p90CancellationRateBasisPoints: number | null;
  readonly priorConversionRateBasisPoints: number | null;
  readonly priorSampleSize: number;
  readonly priorLevel: "category" | "parent_category" | "global" | "default_floor";
  readonly rankingMode: "percentile" | "sparse_exploration";
}

/** The newest demand snapshot per (category, currency), strictly before `asOf`. */
async function loadLatestCategoryDemand(
  asOf: Date,
): Promise<ReadonlyMap<string, LatestCategoryDemand>> {
  const rows = (
    await db.execute<{
      category_id: string;
      currency: string;
      median_order_value_in_cents: number | null;
      p90_refund_rate_bp: number | null;
      p90_cancellation_rate_bp: number | null;
      prior_conversion_rate_bp: number | null;
      prior_sample_size: number;
      prior_level: LatestCategoryDemand["priorLevel"];
      ranking_mode: LatestCategoryDemand["rankingMode"];
    }>(sql`
      SELECT DISTINCT ON (category_id, currency)
             category_id, currency, median_order_value_in_cents, p90_refund_rate_bp,
             p90_cancellation_rate_bp, prior_conversion_rate_bp, prior_sample_size,
             prior_level, ranking_mode
        FROM commerce_category_demand_snapshot
       WHERE as_of <= ${asOf}
       ORDER BY category_id, currency, as_of DESC
    `)
  ).rows;

  return new Map(
    rows.map((row) => [
      `${row.category_id}:${row.currency}`,
      {
        medianOrderValueInCents: row.median_order_value_in_cents,
        p90RefundRateBasisPoints: row.p90_refund_rate_bp,
        p90CancellationRateBasisPoints: row.p90_cancellation_rate_bp,
        priorConversionRateBasisPoints: row.prior_conversion_rate_bp,
        priorSampleSize: row.prior_sample_size,
        priorLevel: row.prior_level,
        rankingMode: row.ranking_mode,
      },
    ]),
  );
}

/** The trailing daily view counts a spike threshold is measured against. */
async function loadDailyBaseline(productId: string, asOf: Date): Promise<number[]> {
  const rows = (
    await db.execute<{ counted_views: number }>(sql`
      SELECT counted_views FROM commerce_product_daily_signal
       WHERE product_id = ${productId} AND signal_date < ${utcDayStringOf(asOf)}::date
       ORDER BY signal_date DESC LIMIT 30
    `)
  ).rows;
  return rows.map((row) => row.counted_views);
}

async function clearRankingState(asOf: Date): Promise<void> {
  void asOf;
  await db.execute(sql`DELETE FROM commerce_product_ranking_state`);
}

function chunked<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

/* ------------------------------------------------------------------------- *
 * Reads
 * ------------------------------------------------------------------------- */

export interface RankedProductRow {
  readonly productId: string;
  readonly rank: number;
  readonly categoryId: string | null;
}

export interface RankedProductPage {
  readonly items: readonly RankedProductRow[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

/**
 * The ranked head of every category, for a trending or recommended rail.
 *
 * ORDERED BY (score DESC, productId) AND NOT BY RANK. `trending_rank_in_category` is
 * per-category, so ordering by it would interleave every category's rank 1, then every rank
 * 2 — a rail that reads as a round-robin rather than a ranking. The score is comparable
 * across categories; the rank is not.
 *
 * Rows written at `scoreAlgorithmVersion = 0` are refused: those are pre-gate runs, where
 * W2 measured a period that did not exist.
 */
export async function listRankedProductIds(input: {
  readonly limit: number;
  readonly cursor?: string | undefined;
}): Promise<Result<RankedProductPage, { type: "INVALID_CURSOR" }>> {
  const decodedCursor = input.cursor === undefined ? null : decodeStoreCursor(input.cursor);
  if (input.cursor !== undefined && decodedCursor === null) {
    return { success: false, error: { type: "INVALID_CURSOR" } };
  }

  const cursorPredicate =
    decodedCursor === null
      ? sql`TRUE`
      : sql`(${commerceProductRankingState.finalScorePoints}, ${commerceProductRankingState.productId})
            < (${Number(decodedCursor.sortKey)}, ${decodedCursor.id})`;

  const rows = await db
    .select({
      productId: commerceProductRankingState.productId,
      rank: commerceProductRankingState.trendingRankInCategory,
      categoryId: commerceProductRankingState.categoryId,
      finalScorePoints: commerceProductRankingState.finalScorePoints,
    })
    .from(commerceProductRankingState)
    .where(
      and(
        isNotNull(commerceProductRankingState.trendingRankInCategory),
        eq(commerceProductRankingState.scoreAlgorithmVersion, COMMERCE_TRENDING_ALGORITHM_VERSION),
        cursorPredicate,
      ),
    )
    .orderBy(
      desc(commerceProductRankingState.finalScorePoints),
      desc(commerceProductRankingState.productId),
    )
    .limit(input.limit + 1);

  const hasMore = rows.length > input.limit;
  const pageRows = rows.slice(0, input.limit);
  const lastRow = pageRows[pageRows.length - 1];

  return {
    success: true,
    value: {
      items: pageRows.map((row) => ({
        productId: row.productId,
        rank: row.rank ?? 0,
        categoryId: row.categoryId,
      })),
      page: {
        nextCursor:
          hasMore && lastRow
            ? encodeStoreCursor({
                sortKey: String(lastRow.finalScorePoints),
                id: lastRow.productId,
              })
            : null,
        hasMore,
      },
    },
  };
}

/* ------------------------------------------------------------------------- *
 * Enforcement and appeals (stage 5)
 * ------------------------------------------------------------------------- */

export type RankingStatusError = { type: "NOT_FOUND" } | { type: "NOT_AUTHORIZED" };

export interface ProductRankingStatus {
  readonly productId: string;
  /** `null` when the product is not currently ranked — a normal state, not an error. */
  readonly trendingRankInCategory: number | null;
  readonly finalScorePoints: number | null;
  readonly rankingMode: "percentile" | "sparse_exploration" | null;
  readonly computedAt: Date | null;
  /**
   * Present only when this product is under an enforcement action. A seller under
   * suppression is entitled to know WHICH signal fired — "your score was multiplied by 0.4"
   * is not a reviewable statement, and an unappealable suppression is how a marketplace
   * loses honest sellers.
   */
  readonly enforcement: {
    readonly action: RankingEnforcementAction;
    readonly actionSource: "moderator" | "automatic";
    readonly penaltyKinds: readonly string[];
    readonly reason: string;
    readonly since: Date;
  } | null;
}

/**
 * What the seller of a product may be told about its ranking.
 *
 * DELIBERATELY NOT THE WHOLE SNAPSHOT. The component breakdown, the raw inputs and the
 * category's own statistics stay internal: publishing them would hand anyone willing to
 * register a seller account a precise specification of what to forge. What a seller gets is
 * their position, whether they are suppressed, and why — which is what an appeal needs and
 * nothing more.
 */
export async function getProductRankingStatus(input: {
  readonly productId: string;
  readonly callerOrganizationId: string;
}): Promise<Result<ProductRankingStatus, RankingStatusError>> {
  const [owned] = await db
    .select({ sellerOrganizationId: product.sellerOrganizationId })
    .from(product)
    .where(eq(product.id, input.productId))
    .limit(1);

  // 404 rather than 403 for a product that exists but belongs to someone else: §11's
  // anti-enumeration rule, unchanged here.
  if (!owned || owned.sellerOrganizationId !== input.callerOrganizationId) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }

  const [state] = await db
    .select()
    .from(commerceProductRankingState)
    .where(eq(commerceProductRankingState.productId, input.productId))
    .limit(1);

  const [enforcement] = await db
    .select()
    .from(commerceProductRankingEnforcement)
    .where(eq(commerceProductRankingEnforcement.productId, input.productId))
    .limit(1);

  return {
    success: true,
    value: {
      productId: input.productId,
      trendingRankInCategory: state?.trendingRankInCategory ?? null,
      finalScorePoints: state?.finalScorePoints ?? null,
      rankingMode: state?.rankingMode ?? null,
      computedAt: state?.computedAt ?? null,
      enforcement:
        enforcement === undefined || enforcement.action === "none"
          ? null
          : {
              action: enforcement.action,
              actionSource: enforcement.actionSource,
              penaltyKinds: enforcement.penaltyKinds,
              reason: enforcement.reason,
              since: enforcement.updatedAt,
            },
    },
  };
}

export type ModerateRankingError =
  | { type: "NOT_FOUND" }
  | { type: "PLATFORM_CAPABILITY_REQUIRED"; capability: "moderate_commerce" };

/**
 * A moderator's decision on a product's ranking enforcement (stage 5).
 *
 * THIS IS THE APPEAL PATH. It is a moderator action and therefore names a person — the
 * `commerce_product_ranking_enforcement_source_ck` constraint binds `moderator` to a
 * non-null `decidedByUserId` in both directions, so a decision cannot be recorded
 * anonymously and an automatic one cannot borrow a name.
 *
 * A moderator's row OUTLIVES the hourly run: the scorer truncates and rewrites
 * `commerce_product_ranking_state` every hour, and if enforcement lived there a human's
 * ruling would last until the next tick.
 */
export async function moderateProductRanking(input: {
  readonly productId: string;
  readonly moderatorUserId: string;
  readonly action: RankingEnforcementAction;
  readonly reason: string;
}): Promise<Result<{ readonly productId: string }, ModerateRankingError>> {
  /*
   * The capability is checked HERE and not in the route chain, matching
   * `commerce-catalog.routes.ts` and `commerce-trust.routes.ts`: a capability visible in the
   * route table is a capability an attacker can probe for.
   */
  const capability = await requirePlatformCapability(input.moderatorUserId, "moderate_commerce");
  if (!capability.success) {
    return {
      success: false,
      error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_commerce" },
    };
  }

  const [target] = await db
    .select({ id: product.id })
    .from(product)
    .where(eq(product.id, input.productId))
    .limit(1);
  if (!target) return { success: false, error: { type: "NOT_FOUND" } };

  const decidedAt = new Date();

  await db.transaction(async (transaction) => {
    await transaction
      .insert(commerceProductRankingEnforcement)
      .values({
        productId: input.productId,
        action: input.action,
        actionSource: "moderator",
        penaltyKinds: [],
        reason: input.reason,
        decidedByUserId: input.moderatorUserId,
      })
      .onConflictDoUpdate({
        target: commerceProductRankingEnforcement.productId,
        set: {
          action: input.action,
          actionSource: "moderator",
          reason: input.reason,
          decidedByUserId: input.moderatorUserId,
          updatedAt: decidedAt,
        },
      });

    // The event log keeps the history a single mutable row cannot: an appeal that was
    // granted and later re-imposed is two facts, not one.
    await transaction.insert(commerceRankingEnforcementEvent).values({
      productId: input.productId,
      asOf: decidedAt,
      action: input.action,
      actionSource: "moderator",
      penaltyKinds: [],
      satisfiedClauses: [],
      unevaluatedClauses: [],
      decidedByUserId: input.moderatorUserId,
      note: input.reason,
    });
  });

  return { success: true, value: { productId: input.productId } };
}
