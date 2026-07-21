import { describe, expect, it } from "vitest";

import {
  categoryDemandPoints,
  computeOpportunityScorePoints,
  distinctReporterPoints,
  geographicSpreadPoints,
  linkedProjectScarcityPoints,
  OPPORTUNITY_SCORE_COMPONENT_BUDGETS,
  recencyBucketPoints,
} from "#src/lib/opportunity-score.js";

interface LadderBoundaryCase {
  readonly input: number;
  readonly expected: number;
  readonly why: string;
}

describe("OPPORTUNITY_SCORE_COMPONENT_BUDGETS", () => {
  it("sums to exactly 100", () => {
    const componentBudgetSum = Object.values(OPPORTUNITY_SCORE_COMPONENT_BUDGETS).reduce(
      (runningSum, componentBudget) => runningSum + componentBudget,
      0,
    );
    expect(componentBudgetSum).toBe(100);
  });

  it("holds the five documented weights", () => {
    expect(OPPORTUNITY_SCORE_COMPONENT_BUDGETS).toEqual({
      distinctReporters: 35,
      geographicSpread: 20,
      categoryDemand: 15,
      recency: 20,
      linkedProjectScarcity: 10,
    });
  });
});

describe("distinctReporterPoints", () => {
  // Both sides of every rung. The rung below each threshold is the real test — an
  // off-by-one in a `>=` would pass a test that only ever probed the exact threshold.
  const boundaryCases: readonly LadderBoundaryCase[] = [
    { input: 0, expected: 0, why: "nobody reported it" },
    { input: 1, expected: 2, why: ">=1 rung" },
    { input: 2, expected: 5, why: ">=2 rung" },
    { input: 4, expected: 5, why: "just below the >=5 rung" },
    { input: 5, expected: 9, why: ">=5 rung" },
    { input: 9, expected: 9, why: "just below the >=10 rung" },
    { input: 10, expected: 14, why: ">=10 rung" },
    { input: 24, expected: 14, why: "just below the >=25 rung" },
    { input: 25, expected: 19, why: ">=25 rung" },
    { input: 49, expected: 19, why: "just below the >=50 rung" },
    { input: 50, expected: 23, why: ">=50 rung" },
    { input: 99, expected: 23, why: "just below the >=100 rung" },
    { input: 100, expected: 27, why: ">=100 rung" },
    { input: 249, expected: 27, why: "just below the >=250 rung" },
    { input: 250, expected: 31, why: ">=250 rung" },
    { input: 499, expected: 31, why: "just below the >=500 rung" },
    { input: 500, expected: 35, why: ">=500 rung, the budget ceiling" },
    { input: 1_000_000, expected: 35, why: "saturates — a brigade buys nothing past 500" },
  ];

  for (const { input, expected, why } of boundaryCases) {
    it(`${input} reporters -> ${expected} points (${why})`, () => {
      expect(distinctReporterPoints(input)).toBe(expected);
    });
  }

  it("scores a negative count as 0 rather than escaping the ladder", () => {
    expect(distinctReporterPoints(-1)).toBe(0);
  });

  it("never exceeds its 35-point budget", () => {
    for (let reporterCount = 0; reporterCount <= 100_000; reporterCount += 1) {
      expect(distinctReporterPoints(reporterCount)).toBeLessThanOrEqual(
        OPPORTUNITY_SCORE_COMPONENT_BUDGETS.distinctReporters,
      );
    }
  });
});

describe("geographicSpreadPoints", () => {
  const boundaryCases: readonly LadderBoundaryCase[] = [
    { input: 0, expected: 0, why: "no region resolved" },
    { input: 1, expected: 2, why: ">=1 rung" },
    { input: 2, expected: 5, why: ">=2 rung" },
    { input: 3, expected: 9, why: ">=3 rung" },
    { input: 4, expected: 12, why: ">=4 rung" },
    { input: 5, expected: 12, why: "just below the >=6 rung" },
    { input: 6, expected: 16, why: ">=6 rung" },
    { input: 9, expected: 16, why: "just below the >=10 rung" },
    { input: 10, expected: 20, why: ">=10 rung, the budget ceiling" },
    { input: 5_000, expected: 20, why: "saturates" },
  ];

  for (const { input, expected, why } of boundaryCases) {
    it(`${input} regions -> ${expected} points (${why})`, () => {
      expect(geographicSpreadPoints(input)).toBe(expected);
    });
  }

  it("scores a negative count as 0", () => {
    expect(geographicSpreadPoints(-3)).toBe(0);
  });
});

describe("categoryDemandPoints", () => {
  const boundaryCases: readonly LadderBoundaryCase[] = [
    { input: 0, expected: 0, why: "no demand in this category" },
    { input: 49, expected: 0, why: "just below the >=50bp rung" },
    { input: 50, expected: 3, why: ">=50bp (0.5%) rung" },
    { input: 199, expected: 3, why: "just below the >=200bp rung" },
    { input: 200, expected: 6, why: ">=200bp (2%) rung" },
    { input: 499, expected: 6, why: "just below the >=500bp rung" },
    { input: 500, expected: 9, why: ">=500bp (5%) rung" },
    { input: 999, expected: 9, why: "just below the >=1000bp rung" },
    { input: 1_000, expected: 12, why: ">=1000bp (10%) rung" },
    { input: 1_999, expected: 12, why: "just below the >=2000bp rung" },
    { input: 2_000, expected: 15, why: ">=2000bp (20%) rung, the budget ceiling" },
    { input: 10_000, expected: 15, why: "100% of demand still caps at the budget" },
  ];

  for (const { input, expected, why } of boundaryCases) {
    it(`${input}bp share -> ${expected} points (${why})`, () => {
      expect(categoryDemandPoints(input)).toBe(expected);
    });
  }

  it("scores a negative share as 0", () => {
    expect(categoryDemandPoints(-100)).toBe(0);
  });
});

describe("recencyBucketPoints", () => {
  // The DESCENDING ladder: it reads the opposite way to the three above, so the
  // "just below" case here is the day AFTER each threshold, not the day before.
  const boundaryCases: readonly LadderBoundaryCase[] = [
    { input: 0, expected: 20, why: "reported today, the budget ceiling" },
    { input: 7, expected: 20, why: "<=7 rung, last day of it" },
    { input: 8, expected: 17, why: "first day past the <=7 rung" },
    { input: 14, expected: 17, why: "<=14 rung, last day of it" },
    { input: 15, expected: 14, why: "first day past the <=14 rung" },
    { input: 30, expected: 14, why: "<=30 rung, last day of it" },
    { input: 31, expected: 11, why: "first day past the <=30 rung" },
    { input: 60, expected: 11, why: "<=60 rung, last day of it" },
    { input: 61, expected: 8, why: "first day past the <=60 rung" },
    { input: 90, expected: 8, why: "<=90 rung, last day of it" },
    { input: 91, expected: 5, why: "first day past the <=90 rung" },
    { input: 180, expected: 5, why: "<=180 rung, last day of it" },
    { input: 181, expected: 2, why: "first day past the <=180 rung" },
    { input: 365, expected: 2, why: "<=365 rung, last day of it" },
    { input: 366, expected: 0, why: "over a year stale — terminal rung" },
    { input: 100_000, expected: 0, why: "stays at the terminal rung" },
  ];

  for (const { input, expected, why } of boundaryCases) {
    it(`${input} days old -> ${expected} points (${why})`, () => {
      expect(recencyBucketPoints(input)).toBe(expected);
    });
  }

  // A lastReportedAt in the future: clock skew or a backfill, not a corrupt row. It must
  // clamp to the freshest rung, never throw and never fall through to the terminal 0.
  const futureAgeCases: readonly number[] = [-1, -7, -365, -100_000];
  for (const negativeAge of futureAgeCases) {
    it(`clamps a future report (${negativeAge} days) to the top rung`, () => {
      expect(recencyBucketPoints(negativeAge)).toBe(20);
    });
  }

  it("clamps rather than throwing, so one skewed row cannot abort the nightly batch", () => {
    expect(() => recencyBucketPoints(-1)).not.toThrow();
  });
});

describe("linkedProjectScarcityPoints", () => {
  // INVERTED: fewer linked projects is worth MORE, because the map exists to surface
  // problems nobody is solving yet.
  const boundaryCases: readonly LadderBoundaryCase[] = [
    { input: 0, expected: 10, why: "nobody is building this — maximal scarcity" },
    { input: 1, expected: 6, why: "one team on it" },
    { input: 2, expected: 3, why: "two teams on it" },
    { input: 3, expected: 0, why: "three or more — taken, terminal rung" },
    { input: 4, expected: 0, why: "past saturation" },
    { input: 100_000, expected: 0, why: "stays at the terminal rung" },
  ];

  for (const { input, expected, why } of boundaryCases) {
    it(`${input} linked projects -> ${expected} points (${why})`, () => {
      expect(linkedProjectScarcityPoints(input)).toBe(expected);
    });
  }

  // A negative count is not merely undefined by the spec — it is the one input in the
  // module where nonsense would INFLATE the score to its component maximum. The spec
  // enumerates 0/1/2/>=3 and, unlike the three "at least" ladders, has no `else` clause
  // covering negatives, so there is no spec'd value to fall back on. `COUNT(*)` cannot be
  // negative, which makes it the physically-impossible invariant CLAUDE.md §3.3 licenses a
  // throw for, and matches `projectScarcityPoints` in the sibling `demand-score.ts`.
  const negativeCounts: readonly number[] = [-1, -2, -3, -100, -100_000, Number.MIN_SAFE_INTEGER];
  for (const negativeCount of negativeCounts) {
    it(`rejects a negative count (${negativeCount}) rather than reading it as maximal scarcity`, () => {
      expect(() => linkedProjectScarcityPoints(negativeCount)).toThrow(
        /linkedProjectCount must be a non-negative safe integer/,
      );
    });
  }

  it("does not let a negative count fabricate the full 10-point scarcity budget", () => {
    // The pre-fix behaviour: -1 fell through `<= 0` and returned the component maximum,
    // so a broken COUNT(*) inflated every affected cluster's total by 10 points silently.
    expect(() => linkedProjectScarcityPoints(-1)).toThrow(/must be a non-negative safe integer, got -1/);
  });
});

describe("input validation", () => {
  const ladderFunctions: ReadonlyArray<{
    readonly name: string;
    readonly compute: (measuredValue: number) => number;
  }> = [
    { name: "distinctReporterPoints", compute: distinctReporterPoints },
    { name: "geographicSpreadPoints", compute: geographicSpreadPoints },
    { name: "categoryDemandPoints", compute: categoryDemandPoints },
    { name: "recencyBucketPoints", compute: recencyBucketPoints },
    { name: "linkedProjectScarcityPoints", compute: linkedProjectScarcityPoints },
  ];

  // NaN is the dangerous one: every comparison against it is false, so without the guard
  // it would fall through every rung to 0 and be indistinguishable from a dead cluster.
  const rejectedInputs: readonly number[] = [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    7.5,
    -0.5,
    Number.MAX_SAFE_INTEGER + 2,
  ];

  for (const { name, compute } of ladderFunctions) {
    for (const rejectedInput of rejectedInputs) {
      it(`${name} throws on ${rejectedInput}`, () => {
        // `linkedProjectCount` carries the stricter "non-negative safe integer" wording,
        // so match the shared tail rather than the full phrase.
        expect(() => compute(rejectedInput)).toThrow(/must be a (?:non-negative )?safe integer/);
      });
    }
  }

  it("computeOpportunityScorePoints rejects a negative linkedProjectCount", () => {
    // Regression: this used to score 10 scarcity points and total 40 instead of throwing,
    // so a broken COUNT(*) silently promoted a no-evidence cluster up the map.
    expect(() =>
      computeOpportunityScorePoints({
        distinctReporterCount: 0,
        distinctRegionCount: 0,
        categoryShareBasisPoints: 0,
        ageInDays: 0,
        linkedProjectCount: -1,
      }),
    ).toThrow(/linkedProjectCount must be a non-negative safe integer/);
  });

  it("computeOpportunityScorePoints rejects a fractional ageInDays", () => {
    // The realistic upstream bug: (Date.now() - lastReportedAt) / 86_400_000.
    expect(() =>
      computeOpportunityScorePoints({
        distinctReporterCount: 10,
        distinctRegionCount: 2,
        categoryShareBasisPoints: 500,
        ageInDays: 3.7,
        linkedProjectCount: 0,
      }),
    ).toThrow(/ageInDays must be a safe integer/);
  });
});

describe("ladder monotonicity", () => {
  // Monotonicity is what makes the score a usable RANKING. A single non-monotone rung
  // would mean one more corroborating reporter could lower a cluster's rank.
  const nonDecreasingLadders: ReadonlyArray<{
    readonly name: string;
    readonly compute: (measuredValue: number) => number;
  }> = [
    { name: "distinctReporterPoints", compute: distinctReporterPoints },
    { name: "geographicSpreadPoints", compute: geographicSpreadPoints },
    { name: "categoryDemandPoints", compute: categoryDemandPoints },
  ];

  for (const { name, compute } of nonDecreasingLadders) {
    it(`${name} is non-decreasing across 0..100000`, () => {
      let previousPoints = compute(0);
      for (let measuredValue = 1; measuredValue <= 100_000; measuredValue += 1) {
        const currentPoints = compute(measuredValue);
        expect(currentPoints).toBeGreaterThanOrEqual(previousPoints);
        previousPoints = currentPoints;
      }
    });
  }

  const nonIncreasingLadders: ReadonlyArray<{
    readonly name: string;
    readonly compute: (measuredValue: number) => number;
  }> = [
    { name: "recencyBucketPoints", compute: recencyBucketPoints },
    { name: "linkedProjectScarcityPoints", compute: linkedProjectScarcityPoints },
  ];

  for (const { name, compute } of nonIncreasingLadders) {
    it(`${name} is non-increasing across 0..100000`, () => {
      let previousPoints = compute(0);
      for (let measuredValue = 1; measuredValue <= 100_000; measuredValue += 1) {
        const currentPoints = compute(measuredValue);
        expect(currentPoints).toBeLessThanOrEqual(previousPoints);
        previousPoints = currentPoints;
      }
    });
  }

  it("recencyBucketPoints stays non-increasing across the clamp seam at 0", () => {
    // The clamp is where a naive implementation breaks monotonicity: if -1 fell through
    // to the terminal 0 instead of clamping, the ladder would spike at day 0.
    for (let ageInDays = -1_000; ageInDays < 0; ageInDays += 1) {
      expect(recencyBucketPoints(ageInDays)).toBe(recencyBucketPoints(0));
    }
  });
});

describe("computeOpportunityScorePoints", () => {
  it("returns every subscore, not just the total", () => {
    const breakdown = computeOpportunityScorePoints({
      distinctReporterCount: 100,
      distinctRegionCount: 4,
      categoryShareBasisPoints: 500,
      ageInDays: 20,
      linkedProjectCount: 1,
    });

    expect(breakdown).toEqual({
      totalPoints: 27 + 12 + 9 + 14 + 6,
      distinctReporterPoints: 27,
      geographicSpreadPoints: 12,
      categoryDemandPoints: 9,
      recencyPoints: 14,
      linkedProjectScarcityPoints: 6,
    });
  });

  it("awards exactly 100 when every ladder tops out", () => {
    const breakdown = computeOpportunityScorePoints({
      distinctReporterCount: 500,
      distinctRegionCount: 10,
      categoryShareBasisPoints: 2_000,
      ageInDays: 0,
      linkedProjectCount: 0,
    });

    expect(breakdown.totalPoints).toBe(100);
  });

  it("awards 0 only when the cluster is dead on every axis", () => {
    const breakdown = computeOpportunityScorePoints({
      distinctReporterCount: 0,
      distinctRegionCount: 0,
      categoryShareBasisPoints: 0,
      ageInDays: 100_000,
      linkedProjectCount: 3,
    });

    expect(breakdown.totalPoints).toBe(0);
  });

  it("scores an all-zeros input at 30, NOT 0", () => {
    // Worth pinning explicitly because it is surprising: ageInDays 0 reads as maximally
    // fresh (20) and linkedProjectCount 0 reads as maximally scarce (10), so an empty
    // brand-new cluster with no reporters at all still scores 30/100.
    const breakdown = computeOpportunityScorePoints({
      distinctReporterCount: 0,
      distinctRegionCount: 0,
      categoryShareBasisPoints: 0,
      ageInDays: 0,
      linkedProjectCount: 0,
    });

    expect(breakdown).toEqual({
      totalPoints: 30,
      distinctReporterPoints: 0,
      geographicSpreadPoints: 0,
      categoryDemandPoints: 0,
      recencyPoints: 20,
      linkedProjectScarcityPoints: 10,
    });
  });

  it("clamps a future lastReportedAt instead of throwing", () => {
    const breakdown = computeOpportunityScorePoints({
      distinctReporterCount: 5,
      distinctRegionCount: 1,
      categoryShareBasisPoints: 50,
      ageInDays: -14,
      linkedProjectCount: 2,
    });

    expect(breakdown.recencyPoints).toBe(20);
    expect(breakdown.totalPoints).toBe(9 + 2 + 3 + 20 + 3);
  });

  // ---------------------------------------------------------------------------
  // The property suite. Variation is derived from the loop index alone — no
  // Math.random(), so any failure reproduces exactly from the reported index.
  // ---------------------------------------------------------------------------

  // PROPERTY TESTS ACCUMULATE, THEN ASSERT ONCE. `expect()` carries real per-call
  // overhead (matcher dispatch plus error-message construction), so ten of them inside a
  // 10,000-iteration loop is 100,000 calls and turns a microsecond-scale pure function
  // into a multi-second test — this suite took over six minutes before the rewrite. The
  // failure list keeps the diagnostic value: a violation still names its exact iteration
  // and inputs, and the single assertion reports every case rather than aborting on the
  // first.
  it("always lands in 0..100 across 10,000 deterministically-varied inputs", () => {
    const violations: string[] = [];

    for (let iterationIndex = 0; iterationIndex < 10_000; iterationIndex += 1) {
      // Coprime-ish multipliers against each modulus so each axis sweeps its full range
      // independently rather than the five moving in lockstep.
      const inputs = {
        distinctReporterCount: (iterationIndex * 7) % 613,
        distinctRegionCount: (iterationIndex * 3) % 13,
        categoryShareBasisPoints: (iterationIndex * 11) % 2_503,
        // Sweeps negatives too, so the recency clamp is inside the property.
        ageInDays: ((iterationIndex * 13) % 500) - 40,
        linkedProjectCount: (iterationIndex * 5) % 7,
      };

      const breakdown = computeOpportunityScorePoints(inputs);
      const describeCase = (problem: string): string =>
        `#${iterationIndex} ${JSON.stringify(inputs)}: ${problem}`;

      if (
        breakdown.totalPoints < 0 ||
        breakdown.totalPoints > 100 ||
        !Number.isSafeInteger(breakdown.totalPoints)
      ) {
        violations.push(describeCase(`totalPoints out of range (${breakdown.totalPoints})`));
      }

      // The total must be the sum of the parts, or the breakdown cannot explain the score.
      const summedSubscores =
        breakdown.distinctReporterPoints +
        breakdown.geographicSpreadPoints +
        breakdown.categoryDemandPoints +
        breakdown.recencyPoints +
        breakdown.linkedProjectScarcityPoints;
      if (summedSubscores !== breakdown.totalPoints) {
        violations.push(
          describeCase(`components sum to ${summedSubscores}, total is ${breakdown.totalPoints}`),
        );
      }

      // Every component stays inside its own budget.
      const budgetChecks: readonly (readonly [string, number, number])[] = [
        [
          "distinctReporters",
          breakdown.distinctReporterPoints,
          OPPORTUNITY_SCORE_COMPONENT_BUDGETS.distinctReporters,
        ],
        [
          "geographicSpread",
          breakdown.geographicSpreadPoints,
          OPPORTUNITY_SCORE_COMPONENT_BUDGETS.geographicSpread,
        ],
        [
          "categoryDemand",
          breakdown.categoryDemandPoints,
          OPPORTUNITY_SCORE_COMPONENT_BUDGETS.categoryDemand,
        ],
        ["recency", breakdown.recencyPoints, OPPORTUNITY_SCORE_COMPONENT_BUDGETS.recency],
        [
          "linkedProjectScarcity",
          breakdown.linkedProjectScarcityPoints,
          OPPORTUNITY_SCORE_COMPONENT_BUDGETS.linkedProjectScarcity,
        ],
      ];
      for (const [componentName, awarded, budget] of budgetChecks) {
        if (awarded > budget) {
          violations.push(describeCase(`${componentName} awarded ${awarded} over budget ${budget}`));
        }
      }
    }

    expect(violations.slice(0, 10)).toEqual([]);
  });

  it("is bit-identical across repeated runs over the same inputs (§4c)", () => {
    // Two servers, or one server run twice, must agree. Purity is the claim; this pins it.
    const divergences: string[] = [];

    for (let iterationIndex = 0; iterationIndex < 2_000; iterationIndex += 1) {
      const inputs = {
        distinctReporterCount: (iterationIndex * 17) % 997,
        distinctRegionCount: (iterationIndex * 2) % 11,
        categoryShareBasisPoints: (iterationIndex * 23) % 10_007,
        ageInDays: ((iterationIndex * 29) % 800) - 100,
        linkedProjectCount: iterationIndex % 5,
      };

      const firstRun = JSON.stringify(computeOpportunityScorePoints(inputs));
      const secondRun = JSON.stringify(computeOpportunityScorePoints(inputs));
      if (firstRun !== secondRun) {
        divergences.push(`#${iterationIndex}: ${firstRun} vs ${secondRun}`);
      }
    }

    expect(divergences).toEqual([]);
  });
});
