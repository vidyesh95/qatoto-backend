import { describe, expect, it } from "vitest";

import {
  resolveCategoryPrior,
  smoothRateTowardPrior,
  DEFAULT_FLOOR_RATE_BASIS_POINTS,
} from "#src/modules/store/commerce-category-prior.js";
import { evaluateFraudGuard } from "#src/modules/store/commerce-fraud-guard.js";
import {
  applyMultipliers,
  computeNegativeRatePenalty,
  computeOrderValueMultiplier,
  computeSubnetConcentrationPenalty,
  NEUTRAL_MULTIPLIER_BASIS_POINTS,
  SUBNET_PENALTY_FLOOR_BASIS_POINTS,
} from "#src/modules/store/commerce-ranking-multipliers.js";
import { computeSpikeThreshold, percentileOf } from "#src/modules/store/commerce-robust-statistics.js";
import {
  COMMERCE_TRENDING_COMPONENT_BUDGETS,
  explorationOrderKey,
  scoreCommerceTrendingCandidate,
  type CommerceTrendingScoreInput,
} from "#src/modules/store/commerce-trending-score.js";

/**
 * The ranking engine's arithmetic, tested without a database.
 *
 * These are the assertions that matter most in the whole phase, because every one of them
 * protects a rule that would otherwise be a comment: a null must not become a zero, a
 * penalty must not promote, an unevaluated clause must not pass, and an ineligible product
 * must not be rankable at all.
 */

const HEALTHY: CommerceTrendingScoreInput = {
  qualifiedOrdersW1: 10,
  qualifiedOrdersW2: 8,
  demandAgeDays: 1,
  smoothedConversionRateBasisPoints: 300,
  sellerOnTimeRateBasisPoints: 9_600,
  sellerHasActiveTradeState: true,
  sellerHasApprovedRegistration: true,
  sellerHasLiveCertification: true,
  distinctBookmarkersW1: 20,
};

describe("scoreCommerceTrendingCandidate", () => {
  it("refuses to score a product with no qualified demand in W2", () => {
    // Refinement 1. Ineligible is a UNION MEMBER, not a low number, precisely so a caller
    // cannot sort it into a rail by accident.
    const result = scoreCommerceTrendingCandidate({ ...HEALTHY, qualifiedOrdersW2: 0 });
    expect(result.status).toBe("ineligible");
  });

  it("stays inside the 100-point budget for a maximal candidate", () => {
    const result = scoreCommerceTrendingCandidate({
      ...HEALTHY,
      qualifiedOrdersW1: 10_000,
      demandAgeDays: 0,
      smoothedConversionRateBasisPoints: 10_000,
      sellerOnTimeRateBasisPoints: 10_000,
      distinctBookmarkersW1: 10_000,
    });
    expect(result.status).toBe("scored");
    if (result.status !== "scored") return;
    expect(result.breakdown.totalPoints).toBeLessThanOrEqual(100);
    expect(result.breakdown.totalPoints).toBe(100);
  });

  it("scores a null on-time rate as zero WITHOUT redistributing its budget", () => {
    // The rule that keeps a new seller from being either defamed or rewarded. The measured
    // share scores nothing; the standing share is unaffected.
    const withRate = scoreCommerceTrendingCandidate(HEALTHY);
    const withoutRate = scoreCommerceTrendingCandidate({
      ...HEALTHY,
      sellerOnTimeRateBasisPoints: null,
    });
    if (withRate.status !== "scored" || withoutRate.status !== "scored") {
      throw new Error("both candidates should score");
    }

    expect(withoutRate.breakdown.sellerTrustPoints).toBeLessThan(withRate.breakdown.sellerTrustPoints);
    // Standing survives: an unproven but verified seller is not at zero.
    expect(withoutRate.breakdown.sellerTrustPoints).toBe(5);
    // And nothing else moved to compensate.
    expect(withoutRate.breakdown.qualifiedVelocityPoints).toBe(withRate.breakdown.qualifiedVelocityPoints);
  });

  it("gives an unverified seller with no measured rate no trust points at all", () => {
    const result = scoreCommerceTrendingCandidate({
      ...HEALTHY,
      sellerOnTimeRateBasisPoints: null,
      sellerHasActiveTradeState: false,
      sellerHasApprovedRegistration: false,
      sellerHasLiveCertification: false,
    });
    if (result.status !== "scored") throw new Error("should score");
    expect(result.breakdown.sellerTrustPoints).toBe(0);
  });

  it("treats a null conversion rate as unmeasured rather than as zero conversion", () => {
    const result = scoreCommerceTrendingCandidate({
      ...HEALTHY,
      smoothedConversionRateBasisPoints: null,
    });
    if (result.status !== "scored") throw new Error("should score");
    expect(result.breakdown.conversionQualityPoints).toBe(0);
  });

  it("rewards recent demand over stale demand", () => {
    const fresh = scoreCommerceTrendingCandidate({ ...HEALTHY, demandAgeDays: 1 });
    const stale = scoreCommerceTrendingCandidate({ ...HEALTHY, demandAgeDays: 13 });
    if (fresh.status !== "scored" || stale.status !== "scored") throw new Error("should score");
    expect(fresh.breakdown.demandFreshnessPoints).toBeGreaterThan(stale.breakdown.demandFreshnessPoints);
  });

  it("keeps its component budgets summing to 100", () => {
    const total = Object.values(COMMERCE_TRENDING_COMPONENT_BUDGETS).reduce((sum, budget) => sum + budget, 0);
    expect(total).toBe(100);
  });

  it("is deterministic for a given exploration key", () => {
    expect(explorationOrderKey("prod_a", "2026-08-07T00:00:00.000Z")).toBe(
      explorationOrderKey("prod_a", "2026-08-07T00:00:00.000Z"),
    );
    expect(explorationOrderKey("prod_a", "2026-08-07T00:00:00.000Z")).not.toBe(
      explorationOrderKey("prod_b", "2026-08-07T00:00:00.000Z"),
    );
  });
});

describe("subnet concentration", () => {
  it("reports NOT MEASURED below the minimum sample instead of low concentration", () => {
    // The single most important assertion about this signal: a null must never be read as
    // evidence that concentration is low, or the guard clears the whole catalog for months.
    const result = computeSubnetConcentrationPenalty({
      hashedObservationCount: 2,
      topSubnetObservationCount: 2,
    });
    expect(result.status).toBe("not_measured");
  });

  it("does not penalise a product below the concentration threshold", () => {
    const result = computeSubnetConcentrationPenalty({
      hashedObservationCount: 40,
      topSubnetObservationCount: 10,
    });
    expect(result.status).toBe("measured");
    if (result.status !== "measured") return;
    expect(result.multiplierBasisPoints).toBe(NEUTRAL_MULTIPLIER_BASIS_POINTS);
  });

  it("floors the penalty rather than zeroing a fully concentrated product", () => {
    // The deliberate departure from refinement 3. A corporate NAT reads the same as a farm,
    // so the worst this may do is halve a score until the exemption corpus exists.
    const result = computeSubnetConcentrationPenalty({
      hashedObservationCount: 41,
      topSubnetObservationCount: 41,
    });
    if (result.status !== "measured") throw new Error("should measure");
    expect(result.concentrationBasisPoints).toBe(10_000);
    expect(result.multiplierBasisPoints).toBe(SUBNET_PENALTY_FLOOR_BASIS_POINTS);
    expect(result.multiplierBasisPoints).toBeGreaterThan(0);
  });
});

describe("order value multiplier", () => {
  it("does not penalise a product whose category has no median in its currency", () => {
    expect(
      computeOrderValueMultiplier({
        averageQualifiedOrderValueInCents: 100,
        categoryMedianOrderValueInCents: null,
      }),
    ).toBe(NEUTRAL_MULTIPLIER_BASIS_POINTS);
  });

  it("drives penny spam toward the floor", () => {
    const multiplier = computeOrderValueMultiplier({
      averageQualifiedOrderValueInCents: 100,
      categoryMedianOrderValueInCents: 500_000,
    });
    expect(multiplier).toBe(1_000);
  });

  it("never exceeds neutral, however large the order", () => {
    expect(
      computeOrderValueMultiplier({
        averageQualifiedOrderValueInCents: 100_000_000,
        categoryMedianOrderValueInCents: 100,
      }),
    ).toBe(NEUTRAL_MULTIPLIER_BASIS_POINTS);
  });
});

describe("negative rate penalties", () => {
  it("stays neutral below the minimum sample", () => {
    expect(
      computeNegativeRatePenalty({
        observedRateBasisPoints: 9_000,
        categoryP90BasisPoints: 1_000,
        sampleSize: 3,
      }),
    ).toBe(NEUTRAL_MULTIPLIER_BASIS_POINTS);
  });

  it("stays neutral when the category has no p90 to compare against", () => {
    expect(
      computeNegativeRatePenalty({
        observedRateBasisPoints: 9_000,
        categoryP90BasisPoints: null,
        sampleSize: 100,
      }),
    ).toBe(NEUTRAL_MULTIPLIER_BASIS_POINTS);
  });

  it("penalises a rate far above the category p90", () => {
    expect(
      computeNegativeRatePenalty({
        observedRateBasisPoints: 9_000,
        categoryP90BasisPoints: 1_000,
        sampleSize: 100,
      }),
    ).toBeLessThan(NEUTRAL_MULTIPLIER_BASIS_POINTS);
  });
});

describe("applyMultipliers", () => {
  it("can never promote a score", () => {
    const base = 60;
    const result = applyMultipliers(base, {
      subnetMultiplierBasisPoints: 10_000,
      orderValueMultiplierBasisPoints: 10_000,
      refundPenaltyBasisPoints: 10_000,
      cancellationPenaltyBasisPoints: 10_000,
      enforcementMultiplierBasisPoints: 10_000,
    });
    expect(result).toBeLessThanOrEqual(base);
    expect(result).toBe(base);
  });

  it("compounds penalties and floors the result at zero", () => {
    expect(
      applyMultipliers(80, {
        subnetMultiplierBasisPoints: 5_000,
        orderValueMultiplierBasisPoints: 5_000,
        refundPenaltyBasisPoints: 10_000,
        cancellationPenaltyBasisPoints: 10_000,
        enforcementMultiplierBasisPoints: 10_000,
      }),
    ).toBe(20);

    expect(
      applyMultipliers(80, {
        subnetMultiplierBasisPoints: 10_000,
        orderValueMultiplierBasisPoints: 10_000,
        refundPenaltyBasisPoints: 10_000,
        cancellationPenaltyBasisPoints: 10_000,
        enforcementMultiplierBasisPoints: 0,
      }),
    ).toBe(0);
  });
});

describe("category priors", () => {
  it("walks the ladder to the first rung with observations", () => {
    const prior = resolveCategoryPrior([
      { level: "category", rateBasisPoints: null, sampleSize: 0 },
      { level: "parent_category", rateBasisPoints: 250, sampleSize: 900 },
      { level: "global", rateBasisPoints: 400, sampleSize: 90_000 },
    ]);
    expect(prior.level).toBe("parent_category");
    expect(prior.rateBasisPoints).toBe(250);
  });

  it("skips a rung that has a rate but no observations behind it", () => {
    const prior = resolveCategoryPrior([
      { level: "category", rateBasisPoints: 9_000, sampleSize: 0 },
      { level: "parent_category", rateBasisPoints: 250, sampleSize: 900 },
      { level: "global", rateBasisPoints: 400, sampleSize: 90_000 },
    ]);
    expect(prior.level).toBe("parent_category");
  });

  it("falls to the floor with a zero sample, never claiming observations", () => {
    const prior = resolveCategoryPrior([
      { level: "category", rateBasisPoints: null, sampleSize: 0 },
      { level: "parent_category", rateBasisPoints: null, sampleSize: 0 },
      { level: "global", rateBasisPoints: null, sampleSize: 0 },
    ]);
    expect(prior.level).toBe("default_floor");
    expect(prior.rateBasisPoints).toBe(DEFAULT_FLOOR_RATE_BASIS_POINTS);
    expect(prior.sampleSize).toBe(0);
  });

  it("lands a product with no observations exactly on the prior", () => {
    const smoothed = smoothRateTowardPrior({
      observedRateBasisPoints: null,
      observationCount: 0,
      prior: { level: "category", rateBasisPoints: 300, sampleSize: 500 },
    });
    expect(smoothed.rateBasisPoints).toBe(300);
    expect(smoothed.confidenceBasisPoints).toBe(0);
  });

  it("pulls a tiny sample toward the prior and leaves a large one alone", () => {
    const prior = { level: "category" as const, rateBasisPoints: 300, sampleSize: 5_000 };

    const tiny = smoothRateTowardPrior({
      observedRateBasisPoints: 5_000,
      observationCount: 2,
      prior,
    });
    const large = smoothRateTowardPrior({
      observedRateBasisPoints: 5_000,
      observationCount: 100_000,
      prior,
    });

    expect(tiny.rateBasisPoints).toBeLessThan(1_000);
    expect(large.rateBasisPoints).toBeGreaterThan(4_900);
  });
});

describe("robust statistics", () => {
  it("uses the minimum floor until the baseline is long enough", () => {
    const threshold = computeSpikeThreshold({ baselineValues: [1, 2, 3], minimumFloor: 100 });
    expect(threshold.status).toBe("floor_only");
    expect(threshold.threshold).toBe(100);
  });

  it("never falls below the floor even on a flat baseline", () => {
    // MAD is 0 here, so median + 2*0 would flag the first day the value moved at all.
    const threshold = computeSpikeThreshold({
      baselineValues: Array.from({ length: 20 }, () => 5),
      minimumFloor: 100,
    });
    expect(threshold.threshold).toBe(100);
  });

  it("raises the threshold above the floor for a genuinely busy product", () => {
    const baseline = [400, 420, 380, 410, 430, 390, 405, 415, 425, 395, 408, 412, 418, 402, 399, 421];
    const threshold = computeSpikeThreshold({ baselineValues: baseline, minimumFloor: 100 });
    expect(threshold.status).toBe("measured");
    expect(threshold.threshold).toBeGreaterThan(400);
  });

  it("returns an actual observation for a percentile, never an interpolation", () => {
    const values = [10, 20, 30, 40];
    const result = percentileOf(values, 0.5);
    expect(values).toContain(result);
  });
});

describe("the circuit breaker", () => {
  const CLEAR_INPUT = {
    spikeFlagged: true,
    productConversionRateBasisPoints: 10,
    categoryAverageConversionRateBasisPoints: 1_000,
    qualifiedOrdersLast7Days: 1,
    distinctQualifiedBuyersLast7Days: 1,
    fraudRiskScore: null,
    fraudRiskThreshold: 50,
    enforcementEnabled: true,
  };

  it("refuses to fire when a clause cannot be evaluated, and names it", () => {
    // THE ASSERTION THIS WHOLE MODULE EXISTS FOR. Three clauses hold and the fourth has no
    // input; defaulting it true would suppress a seller on evidence nobody has.
    const verdict = evaluateFraudGuard(CLEAR_INPUT);
    expect(verdict.status).toBe("not_evaluated");
    if (verdict.status !== "not_evaluated") return;
    expect(verdict.unevaluatedClauses).toContain("fraud_risk_above_threshold");
  });

  it("reports would_fire rather than fire while enforcement is off", () => {
    const verdict = evaluateFraudGuard({
      ...CLEAR_INPUT,
      fraudRiskScore: 90,
      enforcementEnabled: false,
    });
    expect(verdict.status).toBe("would_fire");
  });

  it("fires only when every clause holds and enforcement is on", () => {
    const verdict = evaluateFraudGuard({ ...CLEAR_INPUT, fraudRiskScore: 90 });
    expect(verdict.status).toBe("fire");
    if (verdict.status !== "fire") return;
    // Never a delisting: the first automatic action puts a human in the loop.
    expect(verdict.action).toBe("review_queued");
  });

  it("clears a product whose conversion is healthy", () => {
    const verdict = evaluateFraudGuard({
      ...CLEAR_INPUT,
      productConversionRateBasisPoints: 900,
      fraudRiskScore: 90,
    });
    expect(verdict.status).toBe("clear");
  });
});
