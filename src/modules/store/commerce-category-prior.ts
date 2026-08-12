/**
 * Hierarchical smoothing toward a category prior (STORE Phase 13, refinement 4).
 *
 * THE PROBLEM IT SOLVES. A product with four views and one order has a 25% conversion rate,
 * and a product with forty thousand views and eight thousand orders has 20%. Ranked on the
 * raw number, the first beats the second on a sample that means nothing. Smoothing pulls a
 * small sample toward what its category normally does, in proportion to how little evidence
 * it has, and leaves a large sample essentially alone.
 *
 * WHAT REPLACED WHAT. The specification's earlier shape used a hardcoded `0.50` whenever a
 * metric was missing. That is worse than it looks: 0.50 is not a neutral value, it is a
 * CLAIM — and on a conversion rate it is an absurdly generous one, so every unmeasurable
 * product would have been handed a better rate than any real product ever earns.
 *
 * THE LADDER, and why the rung is returned with the value:
 *
 *   category → parent category → global → default floor
 *
 * A bare number cannot say which rung answered, and "this category's own 400 orders say
 * 3.1%" and "we had nothing at all and used the platform mean" are different claims about
 * the world. So this module returns a DISCRIMINATED UNION, and the level is stored on the
 * snapshot beside the value. A caller cannot forget to ask.
 *
 * BASIS POINTS THROUGHOUT. Integer in, integer out. A rate that reaches a column as a float
 * is how a determinism check starts failing on a machine with a different rounding mode.
 */

import { assertNonNegativeIntegerInput } from "#src/lib/score-ladder.js";

/** The last-resort value, used only when every rung above it is empty. */
export const DEFAULT_FLOOR_RATE_BASIS_POINTS = 5_000;

/**
 * The smoothing constant `k` in `n / (n + k)`.
 *
 * FIXED, NOT ESTIMATED, and the honest reason is that estimating it properly needs
 * between-category variance across many categories with many samples each — data this
 * platform does not have yet. A fixed `k` is the shape of empirical Bayes without the
 * empirics, and the rollout doc says so rather than implying the estimate is principled.
 *
 * 30 means a product needs 30 observations before its own rate carries half the weight.
 */
export const SMOOTHING_CONSTANT = 30;

export type CategoryPriorLevel = "category" | "parent_category" | "global" | "default_floor";

export interface CategoryPriorCandidate {
  readonly level: Exclude<CategoryPriorLevel, "default_floor">;
  /** `null` when this rung has nothing to say. */
  readonly rateBasisPoints: number | null;
  readonly sampleSize: number;
}

export interface ResolvedCategoryPrior {
  readonly level: CategoryPriorLevel;
  readonly rateBasisPoints: number;
  readonly sampleSize: number;
}

/**
 * Walks the ladder and returns the first rung that has anything to say.
 *
 * A rung with a rate but a zero sample is skipped: a rate computed over nothing is not
 * evidence, and admitting it would let an empty category masquerade as a measured one.
 */
export function resolveCategoryPrior(
  candidates: readonly CategoryPriorCandidate[],
): ResolvedCategoryPrior {
  for (const candidate of candidates) {
    if (candidate.rateBasisPoints !== null && candidate.sampleSize > 0) {
      return {
        level: candidate.level,
        rateBasisPoints: candidate.rateBasisPoints,
        sampleSize: candidate.sampleSize,
      };
    }
  }

  return {
    level: "default_floor",
    rateBasisPoints: DEFAULT_FLOOR_RATE_BASIS_POINTS,
    // Zero, and `commerce_category_demand_snapshot_prior_ck` enforces the pairing: a floor
    // must never claim observations, because that is precisely the lie the level exists to
    // prevent.
    sampleSize: 0,
  };
}

export interface SmoothedRateInput {
  /** The product's own measured rate, or `null` if it has none at all. */
  readonly observedRateBasisPoints: number | null;
  /** How many observations produced it. */
  readonly observationCount: number;
  readonly prior: ResolvedCategoryPrior;
}

export interface SmoothedRate {
  readonly rateBasisPoints: number;
  /** `n / (n + k)`, in basis points — how much of the answer came from the product itself. */
  readonly confidenceBasisPoints: number;
  readonly priorLevel: CategoryPriorLevel;
}

/**
 * `adjusted = confidence * observed + (1 - confidence) * prior`, in integer basis points.
 *
 * A product with NO observations lands exactly on the prior with zero confidence, which is
 * the correct statement: we know nothing about it specifically, so we assume it behaves
 * like its neighbours until it shows otherwise.
 */
export function smoothRateTowardPrior(input: SmoothedRateInput): SmoothedRate {
  assertNonNegativeIntegerInput(
    "smoothRateTowardPrior",
    "observationCount",
    input.observationCount,
  );

  const confidenceBasisPoints = Math.round(
    (input.observationCount * 10_000) / (input.observationCount + SMOOTHING_CONSTANT),
  );

  if (input.observedRateBasisPoints === null) {
    return {
      rateBasisPoints: input.prior.rateBasisPoints,
      confidenceBasisPoints: 0,
      priorLevel: input.prior.level,
    };
  }

  assertNonNegativeIntegerInput(
    "smoothRateTowardPrior",
    "observedRateBasisPoints",
    input.observedRateBasisPoints,
  );

  // Integer arithmetic end to end: multiply first, divide once, round once.
  const blended =
    (confidenceBasisPoints * input.observedRateBasisPoints +
      (10_000 - confidenceBasisPoints) * input.prior.rateBasisPoints) /
    10_000;

  return {
    rateBasisPoints: Math.round(blended),
    confidenceBasisPoints,
    priorLevel: input.prior.level,
  };
}
