/**
 * The penalties (STORE Phase 13, refinements 3, 5 and 10).
 *
 * A SEPARATE MODULE FROM THE SCORER, and the separation is the point: components ADD and
 * multipliers REDUCE. Mixing the two in one file is how a penalty accidentally becomes a
 * boost during a refactor — and `commerce_product_trending_snapshot_penalty_ck` exists
 * because the database should refuse that even if this module ever gets it wrong.
 *
 * EVERY MULTIPLIER IS BASIS POINTS, BOUNDED [0, 10000]. None of them can exceed 1.0, so no
 * penalty path can promote anything.
 *
 * WHAT IS DELIBERATELY NOT HERE: the enforcement multiplier. That one comes from a stored
 * decision — possibly a human's — rather than from an arithmetic rule, so it lives with the
 * enforcement tables where it can outlive the hourly run.
 */

import { assertNonNegativeIntegerInput } from "#src/lib/score-ladder.js";

export const NEUTRAL_MULTIPLIER_BASIS_POINTS = 10_000;

/* ------------------------------------------------------------------------- *
 * Subnet concentration (refinement 3)
 * ------------------------------------------------------------------------- */

/**
 * Concentration above which the penalty begins. The specification's figure.
 */
export const SUBNET_CONCENTRATION_THRESHOLD_BASIS_POINTS = 5_000;

/**
 * How many hashed observations before the ratio is believable.
 *
 * WITHOUT THIS, the guard is worse than useless. A product with two hashed bookmarks from
 * one network reads as 100% concentration — indistinguishable from a farm, and produced by
 * two colleagues. Twenty is where a ratio starts describing a population rather than a
 * coincidence.
 *
 * EXPECT THIS GUARD TO BE QUIET FOR A WHILE, and do not read that as products coming up
 * clean. Migration 0120 narrowed the measured population from likes to bookmarks, which is
 * a far rarer gesture, so most products now fall below twenty and return `not_measured`.
 * That is the safe direction — the guard declines to judge rather than penalising on three
 * data points. Do NOT lower this floor to make the guard fire again; the whole point of the
 * threshold is that a small sample cannot tell a procurement team from a farm.
 */
export const SUBNET_MINIMUM_SAMPLE = 20;

/**
 * THE PENALTY FLOOR, AND IT IS A DELIBERATE DEPARTURE FROM THE SPECIFICATION.
 *
 * Refinement 3 asks for `max(0, 1 - concentration)`, which ZEROES a product at 100%
 * concentration. That is a claim this platform cannot support, and the reason is concrete:
 * one procurement team behind one office NAT produces exactly the same concentration as
 * forty scripted accounts. The exemption that would separate them — a corpus of verified
 * corporate domains — does not exist and cannot be built from a denylist (see
 * `commerce_business_email_domain`).
 *
 * So until that corpus exists, the worst this signal can do is halve a score. A halved
 * score still falls out of a rail's visible head; a zeroed score erases a real seller on
 * evidence that cannot distinguish them from an attacker.
 *
 * Every application writes a `commerce_ranking_enforcement_event`, so the false-positive
 * rate is countable rather than assumed — and that count is what should justify lowering
 * this floor, not anyone's confidence.
 */
export const SUBNET_PENALTY_FLOOR_BASIS_POINTS = 5_000;

export type SubnetConcentrationPenalty =
  | { readonly status: "not_measured"; readonly sampleSize: number }
  | {
      readonly status: "measured";
      readonly multiplierBasisPoints: number;
      readonly concentrationBasisPoints: number;
      readonly sampleSize: number;
    };

export interface SubnetConcentrationInput {
  /** Observations that carry a subnet hash. Rows without one are NOT counted here. */
  readonly hashedObservationCount: number;
  /** Observations belonging to the single most common subnet. */
  readonly topSubnetObservationCount: number;
}

/**
 * The concentration penalty, or an explicit "not measured".
 *
 * A UNION RATHER THAN A NEUTRAL 1.0, because those are different facts. `subnet_hash` is
 * never backfillable — no address was recorded on any commerce row before Phase 13 — so for
 * a long time most products will have too few hashed observations to say anything. Reading
 * that silence as "concentration is low" would clear the entire catalog and then begin
 * penalising as coverage grew, which is a guard that appears to work and does not.
 */
export function computeSubnetConcentrationPenalty(
  input: SubnetConcentrationInput,
): SubnetConcentrationPenalty {
  assertNonNegativeIntegerInput(
    "computeSubnetConcentrationPenalty",
    "hashedObservationCount",
    input.hashedObservationCount,
  );
  assertNonNegativeIntegerInput(
    "computeSubnetConcentrationPenalty",
    "topSubnetObservationCount",
    input.topSubnetObservationCount,
  );

  if (input.hashedObservationCount < SUBNET_MINIMUM_SAMPLE) {
    return { status: "not_measured", sampleSize: input.hashedObservationCount };
  }

  const concentrationBasisPoints = Math.round(
    (input.topSubnetObservationCount * 10_000) / input.hashedObservationCount,
  );

  if (concentrationBasisPoints <= SUBNET_CONCENTRATION_THRESHOLD_BASIS_POINTS) {
    return {
      status: "measured",
      multiplierBasisPoints: NEUTRAL_MULTIPLIER_BASIS_POINTS,
      concentrationBasisPoints,
      sampleSize: input.hashedObservationCount,
    };
  }

  const unfloored = NEUTRAL_MULTIPLIER_BASIS_POINTS - concentrationBasisPoints;

  return {
    status: "measured",
    multiplierBasisPoints: Math.max(SUBNET_PENALTY_FLOOR_BASIS_POINTS, unfloored),
    concentrationBasisPoints,
    sampleSize: input.hashedObservationCount,
  };
}

/* ------------------------------------------------------------------------- *
 * Order value (refinement 5)
 * ------------------------------------------------------------------------- */

/** The specification's `min_value_weight`. */
export const MINIMUM_ORDER_VALUE_MULTIPLIER_BASIS_POINTS = 1_000;

/**
 * Caps a single enormous order from carrying a product on its own. Without it, one
 * six-figure order in a category of small ones would produce a multiplier far above
 * neutral — except the multiplier is already capped at neutral, so what this actually
 * bounds is the ratio before clamping, keeping the arithmetic honest at the top end.
 */
export const ORDER_VALUE_OUTLIER_CAP_BASIS_POINTS = 30_000;

export interface OrderValueMultiplierInput {
  /** Mean value of this product's qualified orders in W2, in cents. */
  readonly averageQualifiedOrderValueInCents: number;
  /**
   * The category median FOR THE SAME CURRENCY, or `null` when there is none.
   *
   * Null is common and is not an error: medians are per (category, currency) because this
   * backend has no FX quote, so a product trading in a currency its category has no history
   * for simply cannot be compared.
   */
  readonly categoryMedianOrderValueInCents: number | null;
}

/**
 * Scales velocity by how substantial the orders behind it are.
 *
 * PENNY SPAM IS THE TARGET. Counting orders alone makes a hundred one-unit orders of a
 * £1.80 carton beat six orders of a £2,680 blast chiller, and manufacturing the former is
 * cheap. Dividing by the category median says "these are small FOR THIS CATEGORY", which is
 * the only comparison that means anything — cartons are supposed to be cheap.
 *
 * NO MEDIAN MEANS NO PENALTY. A missing median is missing evidence, and penalising a
 * product for trading in a currency its category has no history in would punish exactly the
 * cross-border sellers this market exists to serve.
 */
export function computeOrderValueMultiplier(input: OrderValueMultiplierInput): number {
  assertNonNegativeIntegerInput(
    "computeOrderValueMultiplier",
    "averageQualifiedOrderValueInCents",
    input.averageQualifiedOrderValueInCents,
  );

  if (
    input.categoryMedianOrderValueInCents === null ||
    input.categoryMedianOrderValueInCents <= 0
  ) {
    return NEUTRAL_MULTIPLIER_BASIS_POINTS;
  }

  const ratioBasisPoints = Math.min(
    ORDER_VALUE_OUTLIER_CAP_BASIS_POINTS,
    Math.round(
      (input.averageQualifiedOrderValueInCents * 10_000) / input.categoryMedianOrderValueInCents,
    ),
  );

  return Math.min(
    NEUTRAL_MULTIPLIER_BASIS_POINTS,
    Math.max(MINIMUM_ORDER_VALUE_MULTIPLIER_BASIS_POINTS, ratioBasisPoints),
  );
}

/* ------------------------------------------------------------------------- *
 * Refunds and cancellations (refinement 10)
 * ------------------------------------------------------------------------- */

/**
 * Tiered rather than proportional, because the question is not "how much worse than average
 * is this" but "is this abnormal for this category". A category where 8% of orders are
 * cancelled is not evidence against any individual seller in it.
 */
const NEGATIVE_SIGNAL_TIERS: readonly { readonly overThreshold: number; readonly bp: number }[] = [
  { overThreshold: 3, bp: 5_000 },
  { overThreshold: 2, bp: 7_000 },
  { overThreshold: 1, bp: 8_500 },
];

export interface NegativeRatePenaltyInput {
  /** This product's rate over the qualified sample, in basis points. */
  readonly observedRateBasisPoints: number | null;
  /** The category's p90, in basis points, or `null` when the category has no history. */
  readonly categoryP90BasisPoints: number | null;
  /** How many orders produced the observed rate. */
  readonly sampleSize: number;
}

/**
 * Below this, a rate is an anecdote. Three cancellations out of four orders is a bad week,
 * not a pattern, and the whole catalog would be penalised in its first month without it.
 */
export const NEGATIVE_SIGNAL_MINIMUM_SAMPLE = 10;

/**
 * A penalty only for rates ABOVE the category's own p90, tiered by how far above.
 *
 * Returns neutral whenever anything is missing — no observed rate, no category p90, or too
 * small a sample. Missing evidence is not evidence of wrongdoing, and this is the signal
 * most likely to be applied to an honest seller having a bad month.
 */
export function computeNegativeRatePenalty(input: NegativeRatePenaltyInput): number {
  if (
    input.observedRateBasisPoints === null ||
    input.categoryP90BasisPoints === null ||
    input.categoryP90BasisPoints <= 0 ||
    input.sampleSize < NEGATIVE_SIGNAL_MINIMUM_SAMPLE
  ) {
    return NEUTRAL_MULTIPLIER_BASIS_POINTS;
  }

  const excessRatio = input.observedRateBasisPoints / input.categoryP90BasisPoints;

  for (const tier of NEGATIVE_SIGNAL_TIERS) {
    if (excessRatio >= tier.overThreshold) return tier.bp;
  }

  return NEUTRAL_MULTIPLIER_BASIS_POINTS;
}

/* ------------------------------------------------------------------------- *
 * Composition
 * ------------------------------------------------------------------------- */

export interface AppliedMultipliers {
  readonly subnetMultiplierBasisPoints: number;
  readonly orderValueMultiplierBasisPoints: number;
  readonly refundPenaltyBasisPoints: number;
  readonly cancellationPenaltyBasisPoints: number;
  readonly enforcementMultiplierBasisPoints: number;
}

/**
 * Applies every multiplier to a base score and floors the result.
 *
 * `Math.floor` and not `Math.round`: a penalty that rounds UP has, for that product,
 * partially undone itself. Rounding toward zero keeps every one of these strictly
 * non-promoting, which is the invariant the database CHECK also asserts.
 */
export function applyMultipliers(baseScorePoints: number, multipliers: AppliedMultipliers): number {
  assertNonNegativeIntegerInput("applyMultipliers", "baseScorePoints", baseScorePoints);

  const product =
    (multipliers.subnetMultiplierBasisPoints / 10_000) *
    (multipliers.orderValueMultiplierBasisPoints / 10_000) *
    (multipliers.refundPenaltyBasisPoints / 10_000) *
    (multipliers.cancellationPenaltyBasisPoints / 10_000) *
    (multipliers.enforcementMultiplierBasisPoints / 10_000);

  return Math.max(0, Math.min(baseScorePoints, Math.floor(baseScorePoints * product)));
}
