import { describe, expect, it } from "vitest";

import {
  computeLocalizationScorePoints,
  deriveTrendDirection,
  exportCapabilityPoints,
  importDependencyPoints,
  leadTimeAdvantagePoints,
  LOCALIZATION_SCORE_COMPONENT_BUDGETS,
  SUBSTITUTE_MATURITY_WEIGHTS,
  substituteAvailabilityPoints,
  supplierCapacityPoints,
  weighSubstituteMaturities,
} from "#src/modules/rnd/import-intelligence/localization-feasibility-score.js";

/**
 * THE EXPECTED RUNGS ARE RESTATED HERE AS LITERALS rather than imported from the module.
 *
 * `demand-score.test.ts` explains why and it applies unchanged: a test that reads the
 * ladder out of the implementation would pass even if the ladder were edited to something
 * wrong — it would only prove the evaluator walks a table, which is not the claim worth
 * defending. These literals ARE the claim.
 */
interface LadderExpectation {
  readonly name: string;
  readonly evaluate: (measuredValue: number) => number;
  readonly budget: number;
  readonly rungs: readonly { readonly threshold: number; readonly points: number }[];
  readonly direction: "atLeastThreshold" | "atMostThreshold";
}

const LADDER_EXPECTATIONS: readonly LadderExpectation[] = [
  {
    name: "importDependency",
    evaluate: importDependencyPoints,
    budget: 35,
    direction: "atLeastThreshold",
    rungs: [
      { threshold: 1_000_000_000_000, points: 35 },
      { threshold: 100_000_000_000, points: 31 },
      { threshold: 25_000_000_000, points: 26 },
      { threshold: 10_000_000_000, points: 21 },
      { threshold: 2_500_000_000, points: 15 },
      { threshold: 1_000_000_000, points: 10 },
      { threshold: 100_000_000, points: 5 },
      { threshold: 10_000_000, points: 2 },
    ],
  },
  {
    name: "exportCapability",
    evaluate: exportCapabilityPoints,
    budget: 25,
    direction: "atLeastThreshold",
    rungs: [
      { threshold: 500_000_000_000, points: 25 },
      { threshold: 100_000_000_000, points: 22 },
      { threshold: 25_000_000_000, points: 18 },
      { threshold: 5_000_000_000, points: 14 },
      { threshold: 1_000_000_000, points: 10 },
      { threshold: 100_000_000, points: 6 },
      { threshold: 10_000_000, points: 3 },
      { threshold: 100, points: 1 },
    ],
  },
  {
    name: "substituteAvailability",
    evaluate: substituteAvailabilityPoints,
    budget: 20,
    direction: "atLeastThreshold",
    rungs: [
      { threshold: 20, points: 20 },
      { threshold: 12, points: 17 },
      { threshold: 8, points: 14 },
      { threshold: 5, points: 11 },
      { threshold: 3, points: 8 },
      { threshold: 2, points: 5 },
      { threshold: 1, points: 2 },
    ],
  },
  {
    name: "supplierCapacity",
    evaluate: supplierCapacityPoints,
    budget: 12,
    direction: "atLeastThreshold",
    rungs: [
      { threshold: 20, points: 12 },
      { threshold: 10, points: 10 },
      { threshold: 5, points: 8 },
      { threshold: 3, points: 6 },
      { threshold: 2, points: 4 },
      { threshold: 1, points: 2 },
    ],
  },
  {
    name: "leadTimeAdvantage",
    evaluate: (measuredValue) => leadTimeAdvantagePoints(measuredValue),
    budget: 8,
    direction: "atMostThreshold",
    rungs: [
      { threshold: 14, points: 8 },
      { threshold: 30, points: 6 },
      { threshold: 60, points: 4 },
      { threshold: 90, points: 2 },
      { threshold: 180, points: 1 },
    ],
  },
];

describe("component budgets", () => {
  it("sums to exactly 100", () => {
    const total = Object.values(LOCALIZATION_SCORE_COMPONENT_BUDGETS).reduce(
      (runningTotal, budget) => runningTotal + budget,
      0,
    );
    expect(total).toBe(100);
  });

  it("matches each ladder's own top-rung payout", () => {
    for (const ladder of LADDER_EXPECTATIONS) {
      expect(ladder.rungs[0]?.points).toBe(ladder.budget);
    }
  });

  it("declares the five components the assessment column CHECK also bounds", () => {
    expect(LOCALIZATION_SCORE_COMPONENT_BUDGETS).toStrictEqual({
      importDependency: 35,
      exportCapability: 25,
      substituteAvailability: 20,
      supplierCapacity: 12,
      leadTimeAdvantage: 8,
    });
  });
});

describe.each(LADDER_EXPECTATIONS)("$name ladder", (ladder) => {
  it.each(ladder.rungs)("awards $points at its own threshold $threshold", ({ threshold, points }) => {
    expect(ladder.evaluate(threshold)).toBe(points);
  });

  it("saturates at the top rung", () => {
    const topRung = ladder.rungs[0];
    if (topRung === undefined) throw new Error("ladder has no rungs");
    const beyond = ladder.direction === "atLeastThreshold" ? topRung.threshold * 10 : 0;
    expect(ladder.evaluate(beyond)).toBe(ladder.budget);
  });

  it("is monotonic in the direction it is scanned", () => {
    const sampled = ladder.rungs.map((rung) => ladder.evaluate(rung.threshold));
    for (let index = 1; index < sampled.length; index += 1) {
      const previous = sampled[index - 1] ?? 0;
      const current = sampled[index] ?? 0;
      expect(current).toBeLessThan(previous);
    }
  });

  it("rejects a negative input rather than paying out for it", () => {
    // An `atMost` ladder would award its FULL budget for a negative, so nonsense would
    // INFLATE the score rather than zero it.
    expect(() => ladder.evaluate(-1)).toThrow(/must be a non-negative safe integer/);
  });

  it("rejects NaN, which would otherwise fall through every rung to zero", () => {
    // Every comparison against NaN is false, so it would be indistinguishable from a
    // dead cell rather than from a broken input.
    expect(() => ladder.evaluate(Number.NaN)).toThrow(/safe integer/);
  });
});

describe("the at-least ladders below their bottom rung", () => {
  it("pays nothing for a commodity with no imports", () => {
    expect(importDependencyPoints(0)).toBe(0);
  });

  it("pays nothing for a country that exports none of it", () => {
    expect(exportCapabilityPoints(0)).toBe(0);
  });

  it("pays the bottom rung for a single dollar of exports", () => {
    // Deliberate: any export at all proves the capability exists, which is a categorically
    // different statement from zero.
    expect(exportCapabilityPoints(100)).toBe(1);
    expect(exportCapabilityPoints(99)).toBe(0);
  });
});

describe("leadTimeAdvantagePoints", () => {
  /**
   * THE TRAP THIS GUARDS. `leadTimeAdvantage` is the inverted ladder, and an `atMost`
   * ladder pays its FULL budget for the smallest input. A null coerced to 0 would award
   * all 8 points to every commodity for which nobody has published a lead time at all —
   * turning absent evidence into perfect evidence.
   */
  it("pays ZERO for a null lead time, not the full budget", () => {
    expect(leadTimeAdvantagePoints(null)).toBe(0);
    expect(leadTimeAdvantagePoints(0)).toBe(8);
  });

  it("pays nothing beyond the slowest rung", () => {
    expect(leadTimeAdvantagePoints(181)).toBe(0);
  });
});

describe("weighSubstituteMaturities", () => {
  it("weights a mature substitute above a lab-scale one", () => {
    expect(SUBSTITUTE_MATURITY_WEIGHTS.mature).toBeGreaterThan(SUBSTITUTE_MATURITY_WEIGHTS.lab_scale);
  });

  it("sums the weights", () => {
    expect(weighSubstituteMaturities(["mature", "commercial", "lab_scale"])).toBe(8);
  });

  it("is zero for no substitutes", () => {
    expect(weighSubstituteMaturities([])).toBe(0);
  });
});

describe("computeLocalizationScorePoints", () => {
  it("returns 0 for a cell with no evidence at all", () => {
    // ⚠️ It does NOT throw and does not exclude itself. The leaderboard query filters
    // evidence-free rows BEFORE ranking; the score module's job is to be total.
    const breakdown = computeLocalizationScorePoints({
      importValueInCents: 0,
      exportValueInCents: 0,
      weightedSubstituteTotal: 0,
      matchedSupplierCount: 0,
      medianSupplierLeadTimeDays: null,
    });
    expect(breakdown.totalPoints).toBe(0);
  });

  it("scores India's largest real import line", () => {
    // HS 270900, petroleum oils: $140,386,299,645 in 2023, no published substitutes.
    const breakdown = computeLocalizationScorePoints({
      importValueInCents: 14_038_629_964_550,
      exportValueInCents: 0,
      weightedSubstituteTotal: 0,
      matchedSupplierCount: 0,
      medianSupplierLeadTimeDays: null,
    });
    expect(breakdown).toStrictEqual({
      totalPoints: 35,
      importDependencyPoints: 35,
      exportCapabilityPoints: 0,
      substituteAvailabilityPoints: 0,
      supplierCapacityPoints: 0,
      leadTimeAdvantagePoints: 0,
    });
  });

  it("keeps the components summing to the total over many tuples", () => {
    const importValues = [0, 10_000_000, 1_000_000_000, 100_000_000_000, 5_000_000_000_000];
    const exportValues = [0, 100, 1_000_000_000, 600_000_000_000];
    const substituteTotals = [0, 1, 4, 13, 40];
    const supplierCounts = [0, 1, 4, 25];
    const leadTimes: (number | null)[] = [null, 0, 20, 75, 400];

    let checked = 0;
    for (const importValueInCents of importValues) {
      for (const exportValueInCents of exportValues) {
        for (const weightedSubstituteTotal of substituteTotals) {
          for (const matchedSupplierCount of supplierCounts) {
            for (const medianSupplierLeadTimeDays of leadTimes) {
              const breakdown = computeLocalizationScorePoints({
                importValueInCents,
                exportValueInCents,
                weightedSubstituteTotal,
                matchedSupplierCount,
                medianSupplierLeadTimeDays,
              });
              const componentSum =
                breakdown.importDependencyPoints +
                breakdown.exportCapabilityPoints +
                breakdown.substituteAvailabilityPoints +
                breakdown.supplierCapacityPoints +
                breakdown.leadTimeAdvantagePoints;

              expect(componentSum).toBe(breakdown.totalPoints);
              expect(Number.isSafeInteger(breakdown.totalPoints)).toBe(true);
              expect(breakdown.totalPoints).toBeGreaterThanOrEqual(0);
              expect(breakdown.totalPoints).toBeLessThanOrEqual(100);
              checked += 1;
            }
          }
        }
      }
    }
    // A floor, so a loop that stops iterating cannot pass by checking nothing.
    expect(checked).toBeGreaterThanOrEqual(1_500);
  });

  it("returns a bit-identical breakdown when the same tuple is scored twice", () => {
    const inputs = {
      importValueInCents: 1_186_299_084_219,
      exportValueInCents: 50_000_000_000,
      weightedSubstituteTotal: 4,
      matchedSupplierCount: 3,
      medianSupplierLeadTimeDays: 21,
    } as const;
    expect(computeLocalizationScorePoints(inputs)).toStrictEqual(computeLocalizationScorePoints(inputs));
  });

  it("is non-decreasing in the import value", () => {
    const base = {
      exportValueInCents: 0,
      weightedSubstituteTotal: 0,
      matchedSupplierCount: 0,
      medianSupplierLeadTimeDays: null,
    } as const;
    let previous = -1;
    for (const importValueInCents of [0, 10_000_000, 100_000_000, 1_000_000_000, 1e12]) {
      const current = computeLocalizationScorePoints({ ...base, importValueInCents }).totalPoints;
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });
});

describe("deriveTrendDirection", () => {
  it("is flat on a cell's first assessment", () => {
    expect(deriveTrendDirection(21, null)).toBe("flat");
  });

  it("does NOT treat a previous score of 0 as absent", () => {
    // `if (!previousScorePoints)` would call this flat, because 0 is falsy.
    expect(deriveTrendDirection(21, 0)).toBe("up");
  });

  it("reads the two directions and equality", () => {
    expect(deriveTrendDirection(10, 20)).toBe("down");
    expect(deriveTrendDirection(20, 20)).toBe("flat");
  });

  it("rejects a score outside 0..100, which catches raw cents passed as points", () => {
    expect(() => deriveTrendDirection(1_000_000, null)).toThrow(/integer score in 0\.\.100/);
    expect(() => deriveTrendDirection(20, Number.NaN)).toThrow(/safe integer/);
  });

  it("validates the current score BEFORE the null branch", () => {
    // Otherwise "no history" would be a validation bypass.
    expect(() => deriveTrendDirection(101, null)).toThrow(/integer score in 0\.\.100/);
  });
});
