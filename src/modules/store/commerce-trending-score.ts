/**
 * The commerce trending scorer (STORE Phase 13).
 *
 * A PURE MODULE, in the shape `trending-score.ts` established for video: budgets that must
 * sum to 100, ladders asserted well-formed at load, integer inputs guarded at the boundary,
 * and no clock or database anywhere. Scoring that can only be exercised through a job is
 * scoring nobody tests.
 *
 * ## What this answers, and what it must never answer
 *
 * TRENDING ANSWERS "WHAT IS RISING". Search answers "what matches". They share no scorer,
 * no table and no job step, and this module must never take a relevance input — see
 * `store-search.service.ts` for the other half of that rule.
 *
 * The reason is not aesthetic. Relevance is query-dependent and computed per request over a
 * GIN index; this score is a query-independent batch fact. Multiply them and every
 * relevance bug looks like a ranking bug — and worse, an anti-fraud penalty leaks into a
 * query the buyer typed by name, so a seller penalised for subnet concentration becomes
 * unfindable by its own product's exact title. That is a support incident, not a ranking
 * outcome.
 *
 * ## The budgets, and why they are shaped by cost-to-forge
 *
 * A save is one authenticated click. An order moves money, and a refund reverses it. So
 * orders and their freshness carry 60 of the 100 points and engagement carries 10 — an
 * attacker who can fake the cheap signal cannot move much, and an attacker who can fake the
 * expensive one is committing fraud with a paper trail.
 *
 * ## Eligibility is not a score of zero
 *
 * Refinement 1: a product with NO qualified order in W2 is INELIGIBLE for trending, not
 * merely decayed. The distinction matters because a decay curve alone still surfaces a
 * product that sold well three weeks ago and has sold nothing since — which is exactly what
 * "trending" must not mean. `scoreCommerceTrendingCandidate` returns an ineligible verdict
 * rather than a low number, so a caller cannot accidentally rank it.
 */

import {
  applyMultipliers,
  type AppliedMultipliers,
} from "#src/lib/commerce-ranking-multipliers.js";
import {
  assertBudgetsSumTo,
  assertLadderIsWellFormed,
  assertNonNegativeIntegerInput,
  pointsForAtLeastLadder,
  pointsForAtMostLadder,
  type ScoreLadderRung,
} from "#src/lib/score-ladder.js";

export const COMMERCE_TRENDING_MAXIMUM_POINTS = 100;

/**
 * The formula's version, stored on every row it produces.
 *
 * Bump it when a ladder, a budget or a multiplier changes. Without it, a snapshot from
 * before a change and one from after are indistinguishable, and the determinism check
 * would report a scorer bug every time the formula legitimately moved.
 */
export const COMMERCE_TRENDING_ALGORITHM_VERSION = 1;

export const COMMERCE_TRENDING_COMPONENT_BUDGETS = {
  qualifiedVelocity: 40,
  demandFreshness: 20,
  conversionQuality: 15,
  sellerTrust: 15,
  buyerEngagement: 10,
} as const;

assertBudgetsSumTo(
  "COMMERCE_TRENDING_COMPONENT_BUDGETS",
  COMMERCE_TRENDING_COMPONENT_BUDGETS,
  COMMERCE_TRENDING_MAXIMUM_POINTS,
);

/**
 * Seller trust splits, and the split is the whole answer to "how do you use a null metric
 * without fabricating a value".
 *
 * `measuredPerformance` reads the Phase 12 rates, each of which is `null` below its own
 * sample threshold. A null scores 0 on its share and THE SHARE IS NOT REDISTRIBUTED —
 * zero points is not a claim that the rate is zero, it is a statement that this component
 * earned nothing.
 *
 * But 15 points of newness tax is heavy in B2B, where a seller is new for a long time. So
 * `verifiedStanding` reads facts that are NEVER null — active trade state, an approved
 * registration verification, a live certification — and a new-but-verified seller earns
 * those 5 immediately. The gap between 5 and 15 becomes something a seller can earn by
 * shipping on time, rather than a penalty for having recently arrived.
 */
export const SELLER_TRUST_SPLIT = {
  measuredPerformance: 10,
  verifiedStanding: 5,
} as const;

assertBudgetsSumTo(
  "SELLER_TRUST_SPLIT",
  SELLER_TRUST_SPLIT,
  COMMERCE_TRENDING_COMPONENT_BUDGETS.sellerTrust,
);

/**
 * Qualified orders in W1 (days 1-7). B2B volumes are far lower than consumer ones — six
 * orders of industrial equipment in a week is a strong signal, not a rounding error — so
 * the rungs sit where a B2B catalog actually lives.
 */
const QUALIFIED_VELOCITY_LADDER: readonly ScoreLadderRung[] = [
  { threshold: 40, points: 40 },
  { threshold: 25, points: 35 },
  { threshold: 15, points: 30 },
  { threshold: 9, points: 24 },
  { threshold: 6, points: 18 },
  { threshold: 4, points: 13 },
  { threshold: 2, points: 8 },
  { threshold: 1, points: 4 },
];
assertLadderIsWellFormed(
  "QUALIFIED_VELOCITY_LADDER",
  QUALIFIED_VELOCITY_LADDER,
  "atLeastThreshold",
  COMMERCE_TRENDING_COMPONENT_BUDGETS.qualifiedVelocity,
);

/**
 * Days since the last qualified order — an `atMost` ladder, because RECENT is good.
 *
 * ANCHORED TO DEMAND, NOT TO LISTING AGE, which is refinement 1's central correction. A
 * two-year-old product with orders yesterday is trending; a product listed yesterday with
 * no orders is not. Age-of-listing decay gets both backwards.
 */
const DEMAND_FRESHNESS_LADDER: readonly ScoreLadderRung[] = [
  { threshold: 1, points: 20 },
  { threshold: 2, points: 18 },
  { threshold: 4, points: 15 },
  { threshold: 7, points: 11 },
  { threshold: 10, points: 7 },
  { threshold: 14, points: 3 },
];
assertLadderIsWellFormed(
  "DEMAND_FRESHNESS_LADDER",
  DEMAND_FRESHNESS_LADDER,
  "atMostThreshold",
  COMMERCE_TRENDING_COMPONENT_BUDGETS.demandFreshness,
);

/** Smoothed conversion, in basis points. 1% of viewers ordering is strong in B2B. */
const CONVERSION_LADDER: readonly ScoreLadderRung[] = [
  { threshold: 400, points: 15 },
  { threshold: 250, points: 12 },
  { threshold: 150, points: 9 },
  { threshold: 80, points: 6 },
  { threshold: 30, points: 3 },
];
assertLadderIsWellFormed(
  "CONVERSION_LADDER",
  CONVERSION_LADDER,
  "atLeastThreshold",
  COMMERCE_TRENDING_COMPONENT_BUDGETS.conversionQuality,
);

/** On-time delivery, in basis points, over the Phase 12 measured rate. */
const ON_TIME_LADDER: readonly ScoreLadderRung[] = [
  { threshold: 9_800, points: 10 },
  { threshold: 9_500, points: 8 },
  { threshold: 9_000, points: 6 },
  { threshold: 8_000, points: 4 },
  { threshold: 7_000, points: 2 },
];
assertLadderIsWellFormed(
  "ON_TIME_LADDER",
  ON_TIME_LADDER,
  "atLeastThreshold",
  SELLER_TRUST_SPLIT.measuredPerformance,
);

/** Distinct savers in W1. Deduped by primary key, so this is people, not taps. */
const ENGAGEMENT_LADDER: readonly ScoreLadderRung[] = [
  { threshold: 60, points: 10 },
  { threshold: 30, points: 8 },
  { threshold: 15, points: 6 },
  { threshold: 7, points: 4 },
  { threshold: 3, points: 2 },
];
assertLadderIsWellFormed(
  "ENGAGEMENT_LADDER",
  ENGAGEMENT_LADDER,
  "atLeastThreshold",
  COMMERCE_TRENDING_COMPONENT_BUDGETS.buyerEngagement,
);

export interface CommerceTrendingScoreInput {
  readonly qualifiedOrdersW1: number;
  /** Refinement 1's eligibility gate: zero here means ineligible, not zero-scored. */
  readonly qualifiedOrdersW2: number;
  /** Days since the last qualified order in W2. `null` when there was none. */
  readonly demandAgeDays: number | null;
  /** Smoothed toward the category prior before it arrives. `null` when unmeasurable. */
  readonly smoothedConversionRateBasisPoints: number | null;
  /** The Phase 12 measured rate. `null` below its own sample threshold — never coalesced. */
  readonly sellerOnTimeRateBasisPoints: number | null;
  readonly sellerHasActiveTradeState: boolean;
  readonly sellerHasApprovedRegistration: boolean;
  readonly sellerHasLiveCertification: boolean;
  readonly distinctSaversW1: number;
}

export interface CommerceTrendingComponentBreakdown {
  readonly qualifiedVelocityPoints: number;
  readonly demandFreshnessPoints: number;
  readonly conversionQualityPoints: number;
  readonly sellerTrustPoints: number;
  readonly buyerEngagementPoints: number;
  readonly totalPoints: number;
}

export type CommerceTrendingScore =
  | {
      /** No qualified order in W2 — refinement 1. Not a low score: not a candidate. */
      readonly status: "ineligible";
      readonly reason: "no_qualified_demand_in_w2";
    }
  | {
      readonly status: "scored";
      readonly breakdown: CommerceTrendingComponentBreakdown;
    };

/**
 * Scores one candidate. Deterministic, total, and free of any clock.
 */
export function scoreCommerceTrendingCandidate(
  input: CommerceTrendingScoreInput,
): CommerceTrendingScore {
  assertNonNegativeIntegerInput(
    "scoreCommerceTrendingCandidate",
    "qualifiedOrdersW1",
    input.qualifiedOrdersW1,
  );
  assertNonNegativeIntegerInput(
    "scoreCommerceTrendingCandidate",
    "qualifiedOrdersW2",
    input.qualifiedOrdersW2,
  );
  assertNonNegativeIntegerInput(
    "scoreCommerceTrendingCandidate",
    "distinctSaversW1",
    input.distinctSaversW1,
  );

  // THE GATE. A product with no qualified demand in W2 is not trending, whatever else is
  // true of it — and returning a union member rather than 0 means a caller cannot rank it
  // by accident.
  if (input.qualifiedOrdersW2 === 0) {
    return { status: "ineligible", reason: "no_qualified_demand_in_w2" };
  }

  const qualifiedVelocityPoints = pointsForAtLeastLadder(
    QUALIFIED_VELOCITY_LADDER,
    input.qualifiedOrdersW1,
  );

  // A null age cannot happen alongside a non-zero W2 count, but the type admits it, so it
  // scores nothing rather than being asserted away — an `atMost` ladder would award a null
  // the FULL budget if it ever coerced to 0.
  const demandFreshnessPoints =
    input.demandAgeDays === null
      ? 0
      : (assertNonNegativeIntegerInput(
          "scoreCommerceTrendingCandidate",
          "demandAgeDays",
          input.demandAgeDays,
        ),
        pointsForAtMostLadder(DEMAND_FRESHNESS_LADDER, input.demandAgeDays));

  const conversionQualityPoints =
    input.smoothedConversionRateBasisPoints === null
      ? 0
      : pointsForAtLeastLadder(CONVERSION_LADDER, input.smoothedConversionRateBasisPoints);

  // See SELLER_TRUST_SPLIT: a null measured rate scores 0 on its share and the share is NOT
  // redistributed to standing. Coalescing it to 0 would defame a new seller, to 1 would
  // reward an unproven one, and to a category average would make this product's score move
  // when a DIFFERENT seller's data changed.
  const measuredPerformancePoints =
    input.sellerOnTimeRateBasisPoints === null
      ? 0
      : pointsForAtLeastLadder(ON_TIME_LADDER, input.sellerOnTimeRateBasisPoints);

  const verifiedStandingPoints =
    (input.sellerHasActiveTradeState ? 2 : 0) +
    (input.sellerHasApprovedRegistration ? 2 : 0) +
    (input.sellerHasLiveCertification ? 1 : 0);

  const sellerTrustPoints = measuredPerformancePoints + verifiedStandingPoints;

  const buyerEngagementPoints = pointsForAtLeastLadder(ENGAGEMENT_LADDER, input.distinctSaversW1);

  const totalPoints =
    qualifiedVelocityPoints +
    demandFreshnessPoints +
    conversionQualityPoints +
    sellerTrustPoints +
    buyerEngagementPoints;

  // The database asserts this too. Failing here first means a scorer bug names itself
  // instead of arriving as a constraint violation three layers away.
  if (totalPoints < 0 || totalPoints > COMMERCE_TRENDING_MAXIMUM_POINTS) {
    throw new Error(
      `scoreCommerceTrendingCandidate produced ${String(totalPoints)} points, outside [0, ${String(COMMERCE_TRENDING_MAXIMUM_POINTS)}]`,
    );
  }

  return {
    status: "scored",
    breakdown: {
      qualifiedVelocityPoints,
      demandFreshnessPoints,
      conversionQualityPoints,
      sellerTrustPoints,
      buyerEngagementPoints,
      totalPoints,
    },
  };
}

/** Convenience: base score through the multipliers, for callers holding both. */
export function finalCommerceTrendingScore(
  breakdown: CommerceTrendingComponentBreakdown,
  multipliers: AppliedMultipliers,
): number {
  return applyMultipliers(breakdown.totalPoints, multipliers);
}

/**
 * The deterministic exploration draw for sparse categories (refinement 8).
 *
 * A STABLE HASH OF (productId, asOf) AND NEVER `Math.random()`. Exploration exists so a
 * category with too little demand still shows something, but a random draw would make two
 * runs of the same `asOf` disagree — which breaks the determinism assertion that is the
 * only thing standing between "the scorer is correct" and "the scorer looks correct".
 */
export function explorationOrderKey(productId: string, asOfIso: string): number {
  let hash = 2_166_136_261;
  const combined = `${asOfIso}:${productId}`;
  for (let index = 0; index < combined.length; index += 1) {
    hash ^= combined.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash;
}
