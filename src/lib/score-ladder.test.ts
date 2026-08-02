import { describe, expect, it } from "vitest";

import {
  assertBudgetsSumTo,
  assertLadderIsWellFormed,
  assertNonNegativeIntegerInput,
  assertSafeIntegerInput,
  pointsForAtLeastLadder,
  pointsForAtMostLadder,
  type ScoreLadderRung,
} from "#src/lib/score-ladder.js";

/**
 * These assertions are the only thing standing between a mistyped ladder table and a
 * ranking that is wrong forever with no exception and no type error. Every case below
 * is a shape that would otherwise ship silently.
 */

const DESCENDING: readonly ScoreLadderRung[] = [
  { threshold: 100, points: 20 },
  { threshold: 50, points: 12 },
  { threshold: 10, points: 5 },
];

const ASCENDING: readonly ScoreLadderRung[] = [
  { threshold: 6, points: 15 },
  { threshold: 24, points: 10 },
  { threshold: 72, points: 4 },
];

describe("pointsForAtLeastLadder", () => {
  it("returns the first rung the value reaches", () => {
    expect(pointsForAtLeastLadder(DESCENDING, 500)).toBe(20);
    expect(pointsForAtLeastLadder(DESCENDING, 100)).toBe(20);
    expect(pointsForAtLeastLadder(DESCENDING, 99)).toBe(12);
    expect(pointsForAtLeastLadder(DESCENDING, 10)).toBe(5);
  });

  it("is total — below the lowest rung and below zero both score nothing", () => {
    expect(pointsForAtLeastLadder(DESCENDING, 9)).toBe(0);
    expect(pointsForAtLeastLadder(DESCENDING, 0)).toBe(0);
    expect(pointsForAtLeastLadder(DESCENDING, -1_000)).toBe(0);
  });
});

describe("pointsForAtMostLadder", () => {
  it("returns the first rung the value fits under", () => {
    expect(pointsForAtMostLadder(ASCENDING, 0)).toBe(15);
    expect(pointsForAtMostLadder(ASCENDING, 6)).toBe(15);
    expect(pointsForAtMostLadder(ASCENDING, 7)).toBe(10);
    expect(pointsForAtMostLadder(ASCENDING, 72)).toBe(4);
    expect(pointsForAtMostLadder(ASCENDING, 73)).toBe(0);
  });

  it("awards the FULL budget to a negative — which is why atMost inputs need the strict guard", () => {
    // Not a bug in the scanner: it is the exact reason `assertNonNegativeIntegerInput`
    // exists and must be applied to every atMost input.
    expect(pointsForAtMostLadder(ASCENDING, -1)).toBe(15);
  });
});

describe("assertLadderIsWellFormed", () => {
  it("accepts a correct ladder in each direction", () => {
    expect(() => {
      assertLadderIsWellFormed("DESCENDING", DESCENDING, "atLeastThreshold", 20);
    }).not.toThrow();
    expect(() => {
      assertLadderIsWellFormed("ASCENDING", ASCENDING, "atMostThreshold", 15);
    }).not.toThrow();
  });

  it("rejects a ladder declared in the wrong order for its direction", () => {
    // THE BUG THIS EXISTS TO CATCH. Scanned as "at least", this matches its bottom rung
    // for every input above 10 and scores every row 5 forever.
    const reversed = DESCENDING.toReversed();
    expect(() => {
      assertLadderIsWellFormed("reversed", reversed, "atLeastThreshold", 5);
    }).toThrow(/strictly ordered/);
  });

  it("rejects a top rung that does not equal the component budget", () => {
    // This is the other half of the 0..100 guarantee — without it, budgets summing to
    // 100 proves nothing about the achievable maximum.
    expect(() => {
      assertLadderIsWellFormed("DESCENDING", DESCENDING, "atLeastThreshold", 25);
    }).toThrow(/top rung awards 20 but the component budget is 25/);
  });

  it("rejects an empty ladder", () => {
    expect(() => {
      assertLadderIsWellFormed("empty", [], "atLeastThreshold", 10);
    }).toThrow(/at least one rung/);
  });

  it("rejects a fractional rung", () => {
    expect(() => {
      assertLadderIsWellFormed(
        "fractional",
        [
          { threshold: 100, points: 20 },
          { threshold: 50.5, points: 12 },
        ],
        "atLeastThreshold",
        20,
      );
    }).toThrow(/must be integral/);
  });

  it("rejects a zero-point rung — the only zero is the terminal fall-through", () => {
    expect(() => {
      assertLadderIsWellFormed(
        "zeroRung",
        [
          { threshold: 100, points: 20 },
          { threshold: 50, points: 0 },
        ],
        "atLeastThreshold",
        20,
      );
    }).toThrow(/the only zero is the terminal fall-through/);
  });

  it("rejects points that do not strictly decrease", () => {
    expect(() => {
      assertLadderIsWellFormed(
        "flatPoints",
        [
          { threshold: 100, points: 20 },
          { threshold: 50, points: 20 },
        ],
        "atLeastThreshold",
        20,
      );
    }).toThrow(/strictly decrease/);
  });
});

describe("the input guards", () => {
  it("assertSafeIntegerInput rejects NaN, Infinity and fractions", () => {
    // NaN loses every comparison, so without this it would fall through every rung and
    // be indistinguishable from an honest zero.
    expect(() => {
      assertSafeIntegerInput("fn", "value", Number.NaN);
    }).toThrow(/must be a safe integer/);
    expect(() => {
      assertSafeIntegerInput("fn", "value", Number.POSITIVE_INFINITY);
    }).toThrow(/must be a safe integer/);
    expect(() => {
      assertSafeIntegerInput("fn", "value", 1.5);
    }).toThrow(/must be a safe integer/);
    expect(() => {
      assertSafeIntegerInput("fn", "value", -3);
    }).not.toThrow();
  });

  it("assertNonNegativeIntegerInput additionally rejects negatives", () => {
    expect(() => {
      assertNonNegativeIntegerInput("fn", "value", -1);
    }).toThrow(/non-negative safe integer/);
    expect(() => {
      assertNonNegativeIntegerInput("fn", "value", 0);
    }).not.toThrow();
  });
});

describe("assertBudgetsSumTo", () => {
  it("accepts an exact sum and rejects anything else", () => {
    expect(() => {
      assertBudgetsSumTo("BUDGETS", { a: 40, b: 25, c: 20, d: 10, e: 5 }, 100);
    }).not.toThrow();
    // A table summing to 99 makes a perfect score unreachable and shifts every rank —
    // silently, which is why this runs at module load and not only here.
    expect(() => {
      assertBudgetsSumTo("BUDGETS", { a: 40, b: 25, c: 20, d: 10, e: 4 }, 100);
    }).toThrow(/must sum to 100, got 99/);
  });
});
