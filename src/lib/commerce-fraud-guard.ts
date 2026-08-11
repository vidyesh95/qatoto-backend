/**
 * The conversion kill-switch (STORE Phase 13, refinement 9).
 *
 * WHAT IT IS FOR. A product that suddenly attracts enormous attention and converts almost
 * none of it, from very few distinct buyers, is the signature of an inflated listing. The
 * switch exists to stop that pattern riding a spike into a rail.
 *
 * ## It cannot fire at launch, and that is the correct failure direction
 *
 * The specification requires ALL FOUR clauses to hold:
 *
 *   a. a dynamic spike flag        — computable (min-floor at launch, MAD once history exists)
 *   b. conversion far below the category average — computable
 *   c. very few qualified orders or distinct buyers — computable
 *   d. `fraud_risk_score > threshold`            — NOT COMPUTABLE
 *
 * Clause (d) has no definable input on this platform today. Every candidate component of a
 * fraud risk score is itself inert: subnet concentration cannot be backfilled and needs
 * months of accumulation, device fingerprinting does not exist, and account-linkage is a
 * graph nobody has built. A score assembled from three unavailable inputs is not a
 * conservative estimate, it is a number with no meaning.
 *
 * So the guard returns `not_evaluated` and NAMES THE MISSING INPUT rather than defaulting
 * clause (d) to true. The consequence is that the breaker suppresses nobody at launch —
 * it fails closed against ITSELF rather than against sellers, which is the direction a
 * marketplace should fail in.
 *
 * ## Observe-only first, always
 *
 * Even once (d) exists, the switch ships writing `action: "none"` events so the rate at
 * which it WOULD have fired is countable before it is allowed to fire. A breaker enabled on
 * a designer's confidence rather than an observed false-positive rate is how honest sellers
 * get suppressed.
 *
 * ## Nothing here deletes
 *
 * The actions are score capping, weight reduction, quarantine and review-queueing. Delisting
 * a product is a commercial decision that requires a human — the same call Phase 10 made
 * when it refused to let an automatic report hide a product.
 */

export type FraudGuardClause =
  | "spike_flagged"
  | "conversion_far_below_category"
  | "thin_qualified_demand"
  | "fraud_risk_above_threshold";

export type RankingEnforcementAction =
  | "none"
  | "weight_reduced"
  | "capped"
  | "quarantined"
  | "review_queued";

export interface FraudGuardInput {
  /** Today's counted views/saves/orders exceeded their dynamic-or-floor threshold. */
  readonly spikeFlagged: boolean;
  /** This product's smoothed conversion, in basis points. `null` when unmeasurable. */
  readonly productConversionRateBasisPoints: number | null;
  /** The category's average conversion, in basis points. `null` when the category is empty. */
  readonly categoryAverageConversionRateBasisPoints: number | null;
  readonly qualifiedOrdersLast7Days: number;
  readonly distinctQualifiedBuyersLast7Days: number;
  /**
   * `null` means NOT COMPUTABLE, which is the launch state and is not a synonym for zero.
   * See the header: the components that would produce it are all inert.
   */
  readonly fraudRiskScore: number | null;
  readonly fraudRiskThreshold: number;
  /**
   * Whether enforcement is switched on. `false` ships first, so the would-fire rate is
   * measurable before anything is suppressed.
   */
  readonly enforcementEnabled: boolean;
}

export type FraudGuardVerdict =
  | {
      /** One or more clauses could not be evaluated. Named, never assumed. */
      readonly status: "not_evaluated";
      readonly satisfiedClauses: readonly FraudGuardClause[];
      readonly unevaluatedClauses: readonly FraudGuardClause[];
    }
  | { readonly status: "clear"; readonly satisfiedClauses: readonly FraudGuardClause[] }
  | {
      /** Every clause holds, but enforcement is off. This is the observe-only outcome. */
      readonly status: "would_fire";
      readonly satisfiedClauses: readonly FraudGuardClause[];
      readonly proposedAction: RankingEnforcementAction;
    }
  | {
      readonly status: "fire";
      readonly satisfiedClauses: readonly FraudGuardClause[];
      readonly action: RankingEnforcementAction;
    };

/** Conversion below this fraction of the category average satisfies clause (b). */
export const CONVERSION_COLLAPSE_RATIO = 0.2;

/** Either bound below this satisfies clause (c). */
export const THIN_DEMAND_THRESHOLD = 10;

/**
 * What a fired switch does.
 *
 * `review_queued` and not `quarantined`: the first action on an automatic signal should put
 * a human in the loop, not remove a seller from the market. Quarantine remains available
 * for a moderator acting deliberately.
 */
export const DEFAULT_AUTOMATIC_ACTION: RankingEnforcementAction = "review_queued";

/**
 * Evaluates all four clauses and reports which held, which did not, and which could not be
 * evaluated at all.
 *
 * EVERY CLAUSE IS EVALUATED, not short-circuited, because the observe-only period needs to
 * know how often each one fires independently. A short-circuit would make three of the four
 * counts meaningless.
 */
export function evaluateFraudGuard(input: FraudGuardInput): FraudGuardVerdict {
  const satisfied: FraudGuardClause[] = [];
  const unevaluated: FraudGuardClause[] = [];

  // (a) spike
  if (input.spikeFlagged) satisfied.push("spike_flagged");

  // (b) conversion collapse, relative to the category
  if (
    input.productConversionRateBasisPoints === null ||
    input.categoryAverageConversionRateBasisPoints === null ||
    input.categoryAverageConversionRateBasisPoints <= 0
  ) {
    unevaluated.push("conversion_far_below_category");
  } else {
    const ratio =
      input.productConversionRateBasisPoints / input.categoryAverageConversionRateBasisPoints;
    if (ratio < CONVERSION_COLLAPSE_RATIO) satisfied.push("conversion_far_below_category");
  }

  // (c) thin demand behind the attention
  if (
    input.qualifiedOrdersLast7Days < THIN_DEMAND_THRESHOLD ||
    input.distinctQualifiedBuyersLast7Days < THIN_DEMAND_THRESHOLD
  ) {
    satisfied.push("thin_qualified_demand");
  }

  // (d) the clause with no input. See the header.
  if (input.fraudRiskScore === null) {
    unevaluated.push("fraud_risk_above_threshold");
  } else if (input.fraudRiskScore > input.fraudRiskThreshold) {
    satisfied.push("fraud_risk_above_threshold");
  }

  // A clause nobody could evaluate must never be counted as passing. This single branch is
  // what makes the difference between a guard that is honest about its coverage and one
  // that quietly suppresses sellers on three clauses while claiming four.
  if (unevaluated.length > 0) {
    return {
      status: "not_evaluated",
      satisfiedClauses: satisfied,
      unevaluatedClauses: unevaluated,
    };
  }

  const allClausesHold =
    satisfied.includes("spike_flagged") &&
    satisfied.includes("conversion_far_below_category") &&
    satisfied.includes("thin_qualified_demand") &&
    satisfied.includes("fraud_risk_above_threshold");

  if (!allClausesHold) return { status: "clear", satisfiedClauses: satisfied };

  return input.enforcementEnabled
    ? { status: "fire", satisfiedClauses: satisfied, action: DEFAULT_AUTOMATIC_ACTION }
    : {
        status: "would_fire",
        satisfiedClauses: satisfied,
        proposedAction: DEFAULT_AUTOMATIC_ACTION,
      };
}

/**
 * The score multiplier an enforcement action implies.
 *
 * `review_queued` is 1.0 — queueing a human review is not itself a punishment, and treating
 * it as one would mean every observe-only signal silently demoted a product while a
 * reviewer had not yet looked.
 */
export function enforcementMultiplierBasisPoints(action: RankingEnforcementAction): number {
  switch (action) {
    case "none":
    case "review_queued":
      return 10_000;
    case "weight_reduced":
      return 5_000;
    case "capped":
      return 2_500;
    case "quarantined":
      return 0;
    default: {
      const exhaustiveAction: never = action;
      throw new Error(`Unhandled enforcement action: ${JSON.stringify(exhaustiveAction)}`);
    }
  }
}
