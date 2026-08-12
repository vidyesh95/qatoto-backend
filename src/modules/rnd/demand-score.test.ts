import { describe, expect, it } from "vitest";

import {
  clusterVolumePoints,
  computeDemandScorePoints,
  DEMAND_SCORE_COMPONENT_BUDGETS,
  deriveTrendDirection,
  distinctReporterPoints,
  openRoleDemandPoints,
  projectScarcityPoints,
} from "#src/modules/rnd/demand-score.js";

/**
 * The expected rungs are restated here as literals rather than imported from the module.
 * A test that reads the ladder out of the implementation would pass even if the ladder were
 * edited to something wrong — it would only prove the evaluator walks a table, which is not
 * the claim worth defending. These literals are the claim.
 */
interface LadderExpectation {
  readonly name: string;
  readonly evaluate: (count: number) => number;
  readonly budget: number;
  readonly rungs: readonly (readonly [number, number])[];
  readonly direction: "ascending" | "descending";
}

const ladderExpectations: readonly LadderExpectation[] = [
  {
    name: "distinctReporterPoints",
    evaluate: distinctReporterPoints,
    budget: DEMAND_SCORE_COMPONENT_BUDGETS.distinctReporters,
    rungs: [
      [0, 0],
      [1, 4],
      [2, 8],
      [5, 14],
      [10, 20],
      [25, 27],
      [50, 33],
      [100, 37],
      [250, 40],
    ],
    direction: "ascending",
  },
  {
    name: "clusterVolumePoints",
    evaluate: clusterVolumePoints,
    budget: DEMAND_SCORE_COMPONENT_BUDGETS.clusterVolume,
    rungs: [
      [0, 0],
      [1, 3],
      [3, 7],
      [6, 11],
      [12, 15],
      [25, 19],
      [50, 22],
      [100, 25],
    ],
    direction: "ascending",
  },
  {
    name: "openRoleDemandPoints",
    evaluate: openRoleDemandPoints,
    budget: DEMAND_SCORE_COMPONENT_BUDGETS.openRoleDemand,
    rungs: [
      [0, 0],
      [1, 3],
      [3, 6],
      [6, 10],
      [12, 14],
      [25, 17],
      [50, 20],
    ],
    direction: "ascending",
  },
  {
    name: "projectScarcityPoints",
    evaluate: projectScarcityPoints,
    budget: DEMAND_SCORE_COMPONENT_BUDGETS.projectScarcity,
    rungs: [
      [0, 15],
      [1, 12],
      [2, 10],
      [4, 7],
      [8, 4],
      [16, 2],
      // The terminal fall-through, not a declared rung: 17+ related projects earns nothing.
      [17, 0],
    ],
    direction: "descending",
  },
];

describe.each(ladderExpectations)("$name ladder", ({ name, evaluate, budget, rungs, direction }: LadderExpectation) => {
  for (const [minimumInclusive, expectedPoints] of rungs) {
    it(`awards ${expectedPoints} at exactly ${minimumInclusive}`, () => {
      expect(evaluate(minimumInclusive)).toBe(expectedPoints);
    });
  }

  // The off-by-one these tables exist to prevent — and the direction matters, which is
  // the whole reason `assertLadderIsWellFormed` takes a direction.
  //
  // On an "at least" ladder the interesting neighbour of a rung is one BELOW it: it must
  // drop to the rung beneath, never stay on the rung itself and never fall to zero.
  // On the inverted "at most" ladder the interesting neighbour is one ABOVE: everything
  // between two thresholds already scores the HIGHER threshold's rung, so `threshold - 1`
  // is not a boundary at all and probing it would prove nothing.
  for (const [rungIndex, rung] of rungs.entries()) {
    const [rungThreshold] = rung;
    const neighbourIndex = direction === "ascending" ? rungIndex - 1 : rungIndex + 1;
    const neighbourRung = rungs[neighbourIndex];
    if (neighbourRung === undefined) {
      continue;
    }
    const [, neighbourPoints] = neighbourRung;
    const probedCount = direction === "ascending" ? rungThreshold - 1 : rungThreshold + 1;

    it(`steps to ${neighbourPoints} at ${probedCount}, just past the ${rungThreshold} rung`, () => {
      expect(evaluate(probedCount)).toBe(neighbourPoints);
    });
  }

  it("saturates at the top rung and never exceeds its budget", () => {
    const topRung = rungs[rungs.length - 1];
    if (topRung === undefined) {
      throw new Error(`${name}: ladder has no rungs`);
    }
    const [topMinimum, topPoints] = topRung;

    for (const multiplier of [1, 2, 10, 1000, 1_000_000]) {
      expect(evaluate(topMinimum * multiplier)).toBe(topPoints);
    }
    expect(evaluate(Number.MAX_SAFE_INTEGER)).toBe(topPoints);
  });

  it(`is ${direction === "ascending" ? "non-decreasing" : "non-increasing"} across its whole domain`, () => {
    const topRung = rungs[rungs.length - 1];
    if (topRung === undefined) {
      throw new Error(`${name}: ladder has no rungs`);
    }
    const [topMinimum] = topRung;

    let previousPoints = evaluate(0);
    for (let candidateCount = 1; candidateCount <= topMinimum * 2 + 10; candidateCount += 1) {
      const currentPoints = evaluate(candidateCount);
      // Phrased as one unconditional assertion rather than an if/else around two
      // `expect`s: a conditional expect can silently assert nothing if the branch
      // condition is itself wrong, which is the failure mode this loop cannot afford.
      const movedTheWrongWay =
        direction === "ascending" ? currentPoints < previousPoints : currentPoints > previousPoints;
      expect(movedTheWrongWay).toBe(false);
      expect(currentPoints).toBeGreaterThanOrEqual(0);
      expect(currentPoints).toBeLessThanOrEqual(budget);
      expect(Number.isSafeInteger(currentPoints)).toBe(true);
      previousPoints = currentPoints;
    }
  });

  const invalidCounts: readonly number[] = [-1, -1000, 1.5, Number.NaN, Number.POSITIVE_INFINITY];
  for (const invalidCount of invalidCounts) {
    it(`throws on a count of ${invalidCount}`, () => {
      expect(() => evaluate(invalidCount)).toThrow(/must be a non-negative safe integer/);
    });
  }
});

describe("DEMAND_SCORE_COMPONENT_BUDGETS", () => {
  it("sums to exactly 100", () => {
    const budgetTotal =
      DEMAND_SCORE_COMPONENT_BUDGETS.distinctReporters +
      DEMAND_SCORE_COMPONENT_BUDGETS.clusterVolume +
      DEMAND_SCORE_COMPONENT_BUDGETS.openRoleDemand +
      DEMAND_SCORE_COMPONENT_BUDGETS.projectScarcity;
    expect(budgetTotal).toBe(100);
  });

  it("matches each ladder's own top-rung payout", () => {
    expect(distinctReporterPoints(250)).toBe(DEMAND_SCORE_COMPONENT_BUDGETS.distinctReporters);
    expect(clusterVolumePoints(100)).toBe(DEMAND_SCORE_COMPONENT_BUDGETS.clusterVolume);
    expect(openRoleDemandPoints(50)).toBe(DEMAND_SCORE_COMPONENT_BUDGETS.openRoleDemand);
    // Inverted: scarcity pays its budget at ZERO related projects, not at its top rung.
    expect(projectScarcityPoints(0)).toBe(DEMAND_SCORE_COMPONENT_BUDGETS.projectScarcity);
  });
});

describe("computeDemandScorePoints", () => {
  it("reaches exactly 100 only when every ladder is saturated and nobody is building", () => {
    expect(
      computeDemandScorePoints({
        distinctReporterCount: 250,
        clusterCount: 100,
        openRoleCount: 50,
        relatedProjectCount: 0,
      }),
    ).toEqual({
      totalPoints: 100,
      distinctReporterPoints: 40,
      clusterVolumePoints: 25,
      openRoleDemandPoints: 20,
      projectScarcityPoints: 15,
    });
  });

  it("floors at 15, not 0, for a completely empty cell — the documented known property", () => {
    // An empty cell is paid the full inverted scarcity component because nothing is being
    // built. This is why the leaderboard query must exclude evidence-free cells BEFORE
    // ranking rather than trusting the score to sort them last.
    const emptyCell = computeDemandScorePoints({
      distinctReporterCount: 0,
      clusterCount: 0,
      openRoleCount: 0,
      relatedProjectCount: 0,
    });
    expect(emptyCell.totalPoints).toBe(15);
    expect(emptyCell.projectScarcityPoints).toBe(15);
  });

  it("scores 0 when a fully crowded cell has no demand evidence at all", () => {
    expect(
      computeDemandScorePoints({
        distinctReporterCount: 0,
        clusterCount: 0,
        openRoleCount: 0,
        relatedProjectCount: 32,
      }).totalPoints,
    ).toBe(0);
  });

  it("ranks unserved demand above identical demand that is already being built", () => {
    const unserved = computeDemandScorePoints({
      distinctReporterCount: 60,
      clusterCount: 30,
      openRoleCount: 14,
      relatedProjectCount: 0,
    });
    const crowded = computeDemandScorePoints({
      distinctReporterCount: 60,
      clusterCount: 30,
      openRoleCount: 14,
      relatedProjectCount: 40,
    });

    expect(unserved.totalPoints).toBeGreaterThan(crowded.totalPoints);
    expect(unserved.totalPoints - crowded.totalPoints).toBe(DEMAND_SCORE_COMPONENT_BUDGETS.projectScarcity);
    // Only the scarcity component may differ — the evidence components are identical inputs.
    expect(unserved.distinctReporterPoints).toBe(crowded.distinctReporterPoints);
    expect(unserved.clusterVolumePoints).toBe(crowded.clusterVolumePoints);
    expect(unserved.openRoleDemandPoints).toBe(crowded.openRoleDemandPoints);
  });

  it("returns a total that always equals the sum of its four components", () => {
    const breakdown = computeDemandScorePoints({
      distinctReporterCount: 27,
      clusterCount: 7,
      openRoleCount: 13,
      relatedProjectCount: 3,
    });
    expect(breakdown.totalPoints).toBe(
      breakdown.distinctReporterPoints +
        breakdown.clusterVolumePoints +
        breakdown.openRoleDemandPoints +
        breakdown.projectScarcityPoints,
    );
  });

  const invalidInputCases: ReadonlyArray<{
    readonly name: string;
    readonly run: () => unknown;
  }> = [
    {
      name: "a negative reporter count",
      run: () =>
        computeDemandScorePoints({
          distinctReporterCount: -1,
          clusterCount: 0,
          openRoleCount: 0,
          relatedProjectCount: 0,
        }),
    },
    {
      name: "a fractional cluster count",
      run: () =>
        computeDemandScorePoints({
          distinctReporterCount: 0,
          clusterCount: 2.5,
          openRoleCount: 0,
          relatedProjectCount: 0,
        }),
    },
    {
      name: "a NaN open-role count",
      run: () =>
        computeDemandScorePoints({
          distinctReporterCount: 0,
          clusterCount: 0,
          openRoleCount: Number.NaN,
          relatedProjectCount: 0,
        }),
    },
    {
      name: "an infinite related-project count",
      run: () =>
        computeDemandScorePoints({
          distinctReporterCount: 0,
          clusterCount: 0,
          openRoleCount: 0,
          relatedProjectCount: Number.POSITIVE_INFINITY,
        }),
    },
  ];

  for (const { name, run } of invalidInputCases) {
    it(`throws on ${name}`, () => {
      expect(run).toThrow(/must be a non-negative safe integer/);
    });
  }

  // ---------------------------------------------------------------------------
  // §4c — the determinism suite. Variation is derived from the loop index alone, with
  // no PRNG state, so any failing tuple can be reconstructed from its index by hand.
  // ---------------------------------------------------------------------------

  it("stays within 0..100 and is an integer over 12,000 deterministic tuples", () => {
    for (let tupleIndex = 0; tupleIndex < 12_000; tupleIndex += 1) {
      const inputs = {
        distinctReporterCount: tupleIndex % 311,
        clusterCount: (tupleIndex * 7) % 131,
        openRoleCount: (tupleIndex * 13) % 71,
        relatedProjectCount: (tupleIndex * 3) % 41,
      } as const;

      const breakdown = computeDemandScorePoints(inputs);

      expect(breakdown.totalPoints).toBeGreaterThanOrEqual(0);
      expect(breakdown.totalPoints).toBeLessThanOrEqual(100);
      expect(Number.isSafeInteger(breakdown.totalPoints)).toBe(true);
      expect(breakdown.totalPoints).toBe(
        breakdown.distinctReporterPoints +
          breakdown.clusterVolumePoints +
          breakdown.openRoleDemandPoints +
          breakdown.projectScarcityPoints,
      );
    }
  });

  it("returns a bit-identical breakdown when the same tuple is scored twice", () => {
    // The claim §4c actually makes: one server run twice produces identical integers.
    for (let tupleIndex = 0; tupleIndex < 10_000; tupleIndex += 1) {
      const inputs = {
        distinctReporterCount: (tupleIndex * 17) % 401,
        clusterCount: (tupleIndex * 11) % 151,
        openRoleCount: (tupleIndex * 5) % 61,
        relatedProjectCount: tupleIndex % 37,
      } as const;

      expect(computeDemandScorePoints(inputs)).toEqual(computeDemandScorePoints(inputs));
    }
  });

  it("is monotonically non-decreasing in each evidence input, holding the others fixed", () => {
    // A ranking signal that can DROP when a new reporter arrives would be indefensible to
    // the person who reported. Only scarcity is allowed to move the other way.
    let previousTotal = computeDemandScorePoints({
      distinctReporterCount: 0,
      clusterCount: 4,
      openRoleCount: 4,
      relatedProjectCount: 4,
    }).totalPoints;

    for (let reporterCount = 1; reporterCount <= 300; reporterCount += 1) {
      const currentTotal = computeDemandScorePoints({
        distinctReporterCount: reporterCount,
        clusterCount: 4,
        openRoleCount: 4,
        relatedProjectCount: 4,
      }).totalPoints;
      expect(currentTotal).toBeGreaterThanOrEqual(previousTotal);
      previousTotal = currentTotal;
    }
  });
});

describe("deriveTrendDirection", () => {
  it("is flat on a first-ever snapshot rather than fabricating a rising trend", () => {
    // Defaulting to "up" here would render every brand-new cell as rising — false, and the
    // most persuasive possible false thing to show an investor scanning a leaderboard.
    expect(deriveTrendDirection(0, null)).toBe("flat");
    expect(deriveTrendDirection(57, null)).toBe("flat");
    expect(deriveTrendDirection(100, null)).toBe("flat");
  });

  it("is up only when the current score strictly exceeds the previous", () => {
    expect(deriveTrendDirection(58, 57)).toBe("up");
    expect(deriveTrendDirection(100, 0)).toBe("up");
  });

  it("is down when the current score is strictly below the previous", () => {
    expect(deriveTrendDirection(57, 58)).toBe("down");
    expect(deriveTrendDirection(0, 100)).toBe("down");
  });

  it("is flat on an exactly equal previous score, including zero", () => {
    // Strict comparison: unchanged is NOT "up". Both operands are integers out of this
    // module, so equality is exact and there is no epsilon to get wrong.
    expect(deriveTrendDirection(57, 57)).toBe("flat");
    expect(deriveTrendDirection(0, 0)).toBe("flat");
    expect(deriveTrendDirection(100, 100)).toBe("flat");
  });

  it("distinguishes a previous score of 0 from a previous score of null", () => {
    // The trap this test exists for: `if (!previousScorePoints)` would treat 0 as absent and
    // report a cell that genuinely climbed from 0 as "flat".
    expect(deriveTrendDirection(15, 0)).toBe("up");
    expect(deriveTrendDirection(15, null)).toBe("flat");
  });

  // ---------------------------------------------------------------------------
  // Regression: this function used to be the one export in the module that
  // validated nothing. NaN was the specific hazard, for exactly the reason
  // `assertNonNegativeIntegerInput` documents on the scoring side — every
  // comparison against NaN is false, so `NaN > previous` and `NaN < previous`
  // are BOTH false and the function fell through to "flat". A cell whose stored
  // previous score came back as NaN rendered as "unchanged" with no exception
  // and no log line: the trend silently disappeared instead of the batch failing
  // loudly. That is reachable, not theoretical — `previousScorePoints` is read
  // back from the `demand_signal_snapshot` column rather than produced in
  // process, and a Postgres `numeric` genuinely admits the value NaN.
  // ---------------------------------------------------------------------------

  const nonScoreValues: readonly number[] = [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    57.5,
    -1,
    101,
    250,
  ];

  for (const nonScoreValue of nonScoreValues) {
    it(`throws rather than guessing a direction from a current score of ${nonScoreValue}`, () => {
      expect(() => deriveTrendDirection(nonScoreValue, 50)).toThrow(/must be an integer demand score in 0\.\.100/);
    });

    it(`throws rather than guessing a direction from a previous score of ${nonScoreValue}`, () => {
      expect(() => deriveTrendDirection(50, nonScoreValue)).toThrow(/must be an integer demand score in 0\.\.100/);
    });
  }

  it("rejects a NaN current score even when there is no history to compare against", () => {
    // The null branch returns early, so it must not become a way to smuggle a
    // nonsense current score past validation.
    expect(() => deriveTrendDirection(Number.NaN, null)).toThrow(/must be an integer demand score in 0\.\.100/);
  });

  it("rejects a raw un-scored count passed where a score belongs", () => {
    // Partial mitigation for the untyped-`number` signature: a caller who passes
    // a reporter COUNT instead of that cell's points is caught whenever the count
    // exceeds 100, which is precisely when the mistake would flip the arrow.
    expect(() => deriveTrendDirection(312, 40)).toThrow(/must be an integer demand score in 0\.\.100/);
  });

  it("still accepts every legitimate score in the closed 0..100 range", () => {
    for (let scorePoints = 0; scorePoints <= 100; scorePoints += 1) {
      expect(deriveTrendDirection(scorePoints, null)).toBe("flat");
      expect(deriveTrendDirection(scorePoints, scorePoints)).toBe("flat");
    }
    expect(deriveTrendDirection(0, 100)).toBe("down");
    expect(deriveTrendDirection(100, 0)).toBe("up");
  });
});
