import { describe, expect, it } from "vitest";

import {
  cashSliceNumerator,
  computeSlicesAwarded,
  divideRoundHalfEven,
  SLICE_DENOMINATOR,
  timeSliceNumerator,
  unpaidRateCentsPerHour,
} from "#src/modules/rnd/slice-math.js";

/**
 * The reproduction suite R_AND_D_BACKEND_STRUCTURE.md §17 step 2 demands: "assert
 * `computeSlices` reproduces EVERY figure in `solar-cold-storage.ts`". These seven are the
 * ones §9.2 lists, and they are the only external check that the wire-unit reduction to a
 * denominator of 3000 matches the dollars-and-hours model in PROOF_OF_EFFORT_SPEC.md §3.
 */
describe("the solar-cold-storage figures", () => {
  const timeContributions: ReadonlyArray<{
    readonly who: string;
    readonly hours: number;
    readonly dollarsPerHour: number;
    readonly expectedSlices: number;
  }> = [
    { who: "founder, 148 h @ $120", hours: 148, dollarsPerHour: 120, expectedSlices: 35_520 },
    { who: "advisor, 5 h @ $85", hours: 5, dollarsPerHour: 85, expectedSlices: 850 },
    { who: "founder, 6 h @ $120", hours: 6, dollarsPerHour: 120, expectedSlices: 1_440 },
    { who: "fabricator, 8 h @ $60", hours: 8, dollarsPerHour: 60, expectedSlices: 960 },
    { who: "fabricator, 3 h @ $60", hours: 3, dollarsPerHour: 60, expectedSlices: 360 },
  ];

  for (const { who, hours, dollarsPerHour, expectedSlices } of timeContributions) {
    it(`${who} → ${expectedSlices} slices`, () => {
      const numerator = timeSliceNumerator(hours * 60, BigInt(dollarsPerHour * 100));
      expect(computeSlicesAwarded(numerator)).toBe(expectedSlices);
    });
  }

  const cashContributions: ReadonlyArray<{
    readonly who: string;
    readonly dollars: number;
    readonly expectedSlices: number;
  }> = [
    { who: "compressor purchase, $22,120", dollars: 22_120, expectedSlices: 88_480 },
    { who: "materials, $180", dollars: 180, expectedSlices: 720 },
  ];

  for (const { who, dollars, expectedSlices } of cashContributions) {
    it(`${who} → ${expectedSlices} slices`, () => {
      expect(computeSlicesAwarded(cashSliceNumerator(BigInt(dollars * 100)))).toBe(expectedSlices);
    });
  }

  it("agrees with the dollars-and-hours model the spec states", () => {
    // SPEC §3's worked example: A puts in 40 h at $100/h, B puts in 40 h at $50/h plus
    // $1,000 cash. Both reach 8,000 slices and therefore 50/50.
    const founderA = computeSlicesAwarded(timeSliceNumerator(40 * 60, 100_00n));
    const founderBTime = computeSlicesAwarded(timeSliceNumerator(40 * 60, 50_00n));
    const founderBCash = computeSlicesAwarded(cashSliceNumerator(1_000_00n));

    expect(founderA).toBe(8_000);
    expect(founderBTime + founderBCash).toBe(8_000);
  });
});

describe("unpaidRateCentsPerHour", () => {
  it("prices only the unpaid portion", () => {
    // The gap §9.2 calls the largest correctness error in the mock: a member on a
    // $60/h salary against a $120/h market rate earns sweat equity on the difference,
    // not on the whole rate.
    expect(unpaidRateCentsPerHour(120_00, 60_00)).toBe(60_00n);
  });

  it("gives an unpaid member their full market rate", () => {
    expect(unpaidRateCentsPerHour(120_00, 0)).toBe(120_00n);
  });

  it("floors at zero when someone is paid above market", () => {
    // Negative accrual would let a raise claw equity back out of the pool.
    expect(unpaidRateCentsPerHour(60_00, 120_00)).toBe(0n);
  });

  it("rejects a negative rate", () => {
    expect(() => unpaidRateCentsPerHour(-1, 0)).toThrow(/non-negative safe integer/);
  });
});

describe("divideRoundHalfEven", () => {
  const cases: ReadonlyArray<{
    readonly numerator: bigint;
    readonly denominator: bigint;
    readonly expected: bigint;
    readonly why: string;
  }> = [
    { numerator: 9_000n, denominator: 3_000n, expected: 3n, why: "exact" },
    { numerator: 1_500n, denominator: 3_000n, expected: 0n, why: "0.5 ties DOWN to even 0" },
    { numerator: 4_500n, denominator: 3_000n, expected: 2n, why: "1.5 ties UP to even 2" },
    { numerator: 7_500n, denominator: 3_000n, expected: 2n, why: "2.5 ties DOWN to even 2" },
    { numerator: 10_500n, denominator: 3_000n, expected: 4n, why: "3.5 ties UP to even 4" },
    { numerator: 1_501n, denominator: 3_000n, expected: 1n, why: "just above half rounds up" },
    { numerator: 1_499n, denominator: 3_000n, expected: 0n, why: "just below half rounds down" },
    // Reversals carry negative numerators, and BigInt `/` truncates toward zero — so the
    // sign has to be reapplied or every reversal rounds the wrong way (§9.3 rule 4).
    { numerator: -1_500n, denominator: 3_000n, expected: 0n, why: "-0.5 ties to even 0" },
    { numerator: -4_500n, denominator: 3_000n, expected: -2n, why: "-1.5 ties AWAY to even -2" },
    { numerator: -7_500n, denominator: 3_000n, expected: -2n, why: "-2.5 ties TOWARD even -2" },
    { numerator: -1_501n, denominator: 3_000n, expected: -1n, why: "just past -half rounds away" },
    { numerator: 0n, denominator: 3_000n, expected: 0n, why: "zero numerator" },
  ];

  for (const { numerator, denominator, expected, why } of cases) {
    it(`${numerator} / ${denominator} = ${expected} (${why})`, () => {
      expect(divideRoundHalfEven(numerator, denominator)).toBe(expected);
    });
  }

  it("has zero tie bias across a symmetric run of ties, unlike half-away-from-zero", () => {
    // The property §9.3 rule 3 buys: over consecutive .5 cases the roundings cancel.
    // Half-away-from-zero would push all four up and drift the pool by +2 slices.
    const tieNumerators = [1_500n, 4_500n, 7_500n, 10_500n];
    const roundedTotal = tieNumerators
      .map((numerator) => divideRoundHalfEven(numerator, SLICE_DENOMINATOR))
      .reduce((runningSum, part) => runningSum + part, 0n);
    const exactTotal = tieNumerators.reduce((runningSum, numerator) => runningSum + numerator, 0n);

    // 0 + 2 + 2 + 4 = 8, and 0.5 + 1.5 + 2.5 + 3.5 = 8 exactly. Nothing was created.
    expect(roundedTotal * SLICE_DENOMINATOR).toBe(exactTotal);
  });

  it("stays exact past Number.MAX_SAFE_INTEGER", () => {
    const beyondSafeInteger = 9_007_199_254_740_993n;
    expect(divideRoundHalfEven(beyondSafeInteger * 3_000n, 3_000n)).toBe(beyondSafeInteger);
  });

  it("throws on a zero denominator", () => {
    expect(() => divideRoundHalfEven(1n, 0n)).toThrow(/denominator must not be zero/);
  });
});

describe("computeSlicesAwarded", () => {
  it("writes a zero rather than skipping a dust claim", () => {
    // §9.3's anti-dust rule: a claim that rounds to nothing still produces an entry, or
    // sequenceNumber gets a hole and the audit story breaks.
    expect(computeSlicesAwarded(timeSliceNumerator(1, 100n))).toBe(0);
  });

  it("accepts a negative numerator, which is a reversal", () => {
    expect(computeSlicesAwarded(-35_520n * SLICE_DENOMINATOR)).toBe(-35_520);
  });

  it("throws rather than overflowing slice_ledger_entry.slicesAwarded", () => {
    expect(() => computeSlicesAwarded(3_000n * 3_000_000_000n)).toThrow(/int4 range/);
  });
});

describe("input guards", () => {
  it("rejects fractional minutes", () => {
    expect(() => timeSliceNumerator(90.5, 100n)).toThrow(/non-negative safe integer/);
  });

  it("rejects negative minutes", () => {
    expect(() => timeSliceNumerator(-1, 100n)).toThrow(/non-negative safe integer/);
  });

  it("rejects a negative unpaid rate", () => {
    expect(() => timeSliceNumerator(60, -1n)).toThrow(/must be non-negative/);
  });

  it("rejects negative cash", () => {
    expect(() => cashSliceNumerator(-1n)).toThrow(/must be non-negative/);
  });
});
