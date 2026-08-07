import { describe, expect, it } from "vitest";

import {
  apportionLargestRemainder,
  BASIS_POINTS_TOTAL,
  basisPointsOf,
  divRoundHalfAwayFromZero,
} from "#src/lib/money.js";

describe("divRoundHalfAwayFromZero", () => {
  const cases: ReadonlyArray<{
    readonly numerator: bigint;
    readonly denominator: bigint;
    readonly expected: bigint;
    readonly why: string;
  }> = [
    { numerator: 10n, denominator: 5n, expected: 2n, why: "exact" },
    { numerator: 7n, denominator: 2n, expected: 4n, why: "positive half rounds up" },
    // The trap: BigInt `/` truncates toward zero, so -7n/2n is -3n. Postgres
    // round(-3.5) is -4. Half-away-from-zero must agree with Postgres.
    { numerator: -7n, denominator: 2n, expected: -4n, why: "negative half rounds AWAY from zero" },
    { numerator: 7n, denominator: -2n, expected: -4n, why: "negative denominator, same magnitude" },
    { numerator: -7n, denominator: -2n, expected: 4n, why: "both negative, positive result" },
    { numerator: 5n, denominator: 3n, expected: 2n, why: "above half rounds up" },
    { numerator: 4n, denominator: 3n, expected: 1n, why: "below half rounds down" },
    { numerator: -4n, denominator: 3n, expected: -1n, why: "below half, negative" },
    { numerator: 0n, denominator: 7n, expected: 0n, why: "zero numerator" },
    { numerator: -1n, denominator: 2n, expected: -1n, why: "-0.5 must NOT become -0" },
  ];

  for (const { numerator, denominator, expected, why } of cases) {
    it(`${numerator} / ${denominator} = ${expected} (${why})`, () => {
      expect(divRoundHalfAwayFromZero(numerator, denominator)).toBe(expected);
    });
  }

  it("stays exact past Number.MAX_SAFE_INTEGER", () => {
    // 2^53 + 1 is not representable as a double; a float implementation loses it.
    const beyondSafeInteger = 9_007_199_254_740_993n;
    expect(divRoundHalfAwayFromZero(beyondSafeInteger * 3n, 3n)).toBe(beyondSafeInteger);
  });

  it("throws on a zero denominator", () => {
    expect(() => divRoundHalfAwayFromZero(1n, 0n)).toThrow(/denominator must not be zero/);
  });
});

describe("apportionLargestRemainder", () => {
  it("returns parts in INPUT order, not ranked order", () => {
    // The largest remainder belongs to the LAST entry; if the implementation
    // returned ranked order this would come back reversed.
    const parts = apportionLargestRemainder([1n, 1n, 4n], 10, ["c", "b", "a"]);
    expect(parts.reduce((sum, part) => sum + part, 0)).toBe(10);
    expect(parts.length).toBe(3);
    expect(parts[2]).toBeGreaterThan(parts[0] ?? 0);
  });

  it("sums to exactly the total where flooring alone would lose basis points", () => {
    // Three equal weights over 10000: each floors to 3333, losing 1 bp.
    const parts = apportionLargestRemainder([1n, 1n, 1n], BASIS_POINTS_TOTAL, ["a", "b", "c"]);
    expect(parts.reduce((sum, part) => sum + part, 0)).toBe(BASIS_POINTS_TOTAL);
    expect(parts.toSorted((left, right) => left - right)).toEqual([3333, 3333, 3334]);
  });

  it("breaks exact ties on the tie-break key, ascending", () => {
    // Identical weights and identical remainders: only the key can decide, and the
    // extra basis point must go to "aaa".
    const parts = apportionLargestRemainder([1n, 1n, 1n], BASIS_POINTS_TOTAL, [
      "ccc",
      "aaa",
      "bbb",
    ]);
    expect(parts[1]).toBe(3334);
    expect(parts[0]).toBe(3333);
    expect(parts[2]).toBe(3333);
  });

  it("is degenerate (all zero) when every weight is zero", () => {
    const parts = apportionLargestRemainder([0n, 0n], BASIS_POINTS_TOTAL, ["a", "b"]);
    expect(parts).toEqual([0, 0]);
  });

  it("handles the single-member project", () => {
    expect(apportionLargestRemainder([42n], BASIS_POINTS_TOTAL, ["solo"])).toEqual([
      BASIS_POINTS_TOTAL,
    ]);
  });

  it("returns [] for no members", () => {
    expect(apportionLargestRemainder([], BASIS_POINTS_TOTAL, [])).toEqual([]);
  });

  const invalidCases: ReadonlyArray<{
    readonly name: string;
    readonly run: () => unknown;
    readonly pattern: RegExp;
  }> = [
    {
      name: "mismatched lengths",
      run: () => apportionLargestRemainder([1n, 2n], 10, ["a"]),
      pattern: /same length/,
    },
    {
      name: "duplicate tie-break keys",
      run: () => apportionLargestRemainder([1n, 1n], 10, ["a", "a"]),
      pattern: /must be unique/,
    },
    {
      name: "negative weight",
      run: () => apportionLargestRemainder([-1n], 10, ["a"]),
      pattern: /non-negative/,
    },
    {
      name: "non-integer total",
      run: () => apportionLargestRemainder([1n], 1.5, ["a"]),
      pattern: /non-negative integer/,
    },
  ];

  for (const { name, run, pattern } of invalidCases) {
    it(`throws on ${name}`, () => {
      expect(run).toThrow(pattern);
    });
  }

  // ---------------------------------------------------------------------------
  // §17 step 2 — the determinism suite. These two are the reason this module exists.
  // ---------------------------------------------------------------------------

  it("sums to exactly 10000 over 1,000 randomized member sets, including frequent ties", () => {
    // A deliberately TINY value domain so exact ties are common — ties are where a
    // naive implementation drifts to 9999 or 10001.
    let randomState = 123_456_789;
    const nextPseudoRandom = (bound: number): number => {
      randomState = (randomState * 1_103_515_245 + 12_345) % 2_147_483_648;
      return randomState % bound;
    };

    for (let iteration = 0; iteration < 1000; iteration += 1) {
      const memberCount = 1 + nextPseudoRandom(12);
      const weights = Array.from({ length: memberCount }, () => BigInt(nextPseudoRandom(4)));
      const keys = Array.from({ length: memberCount }, (_unused, index) => `member-${index}`);

      const parts = apportionLargestRemainder(weights, BASIS_POINTS_TOTAL, keys);
      const sum = parts.reduce((runningSum, part) => runningSum + part, 0);
      const isDegenerate = weights.every((weight) => weight === 0n);

      expect(sum).toBe(isDegenerate ? 0 : BASIS_POINTS_TOTAL);
    }
  });

  it("is invariant under 1,000 input shuffles — identical key→part map every time", () => {
    const weights = [5n, 5n, 5n, 3n, 3n, 1n, 12n];
    const keys = ["ada", "grace", "alan", "edsger", "barbara", "donald", "ken"];

    const baseline = apportionLargestRemainder(weights, BASIS_POINTS_TOTAL, keys);
    const expectedByKey = new Map(keys.map((key, index) => [key, baseline[index]]));

    let shuffleState = 987_654_321;
    for (let iteration = 0; iteration < 1000; iteration += 1) {
      const order = keys.map((_unused, index) => index);
      // Fisher-Yates with a deterministic PRNG, so a failure is reproducible.
      for (let index = order.length - 1; index > 0; index -= 1) {
        shuffleState = (shuffleState * 1_103_515_245 + 12_345) % 2_147_483_648;
        const swapWith = shuffleState % (index + 1);
        const held = order[index] ?? 0;
        order[index] = order[swapWith] ?? 0;
        order[swapWith] = held;
      }

      const shuffledWeights = order.map((index) => weights[index] ?? 0n);
      const shuffledKeys = order.map((index) => keys[index] ?? "");
      const shuffledParts = apportionLargestRemainder(
        shuffledWeights,
        BASIS_POINTS_TOTAL,
        shuffledKeys,
      );

      for (const [position, key] of shuffledKeys.entries()) {
        expect(shuffledParts[position]).toBe(expectedByKey.get(key));
      }
    }
  });
});

describe("basisPointsOf", () => {
  it("converts a part of a whole", () => {
    expect(basisPointsOf(1n, 4n)).toBe(2500);
    expect(basisPointsOf(1n, 3n)).toBe(3333);
    expect(basisPointsOf(2n, 3n)).toBe(6667);
  });

  it("throws when the whole is zero rather than returning a misleading 0", () => {
    expect(() => basisPointsOf(1n, 0n)).toThrow(/whole must not be zero/);
  });

  it("shows why it must NOT be used for a set that has to sum to 10000", () => {
    // Three equal parts, each rounded independently: 3333 × 3 = 9999. This is the
    // exact bug apportionLargestRemainder exists to prevent.
    const naiveSum = [1n, 1n, 1n].reduce((sum, part) => sum + basisPointsOf(part, 3n), 0);
    expect(naiveSum).toBe(9999);
    expect(naiveSum).not.toBe(BASIS_POINTS_TOTAL);
  });
});
