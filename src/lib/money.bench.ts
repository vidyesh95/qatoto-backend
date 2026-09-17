import { withCodSpeed } from "@codspeed/tinybench-plugin";
import { Bench } from "tinybench";

import {
  apportionLargestRemainder,
  basisPointsOf,
  divRoundHalfAwayFromZero,
} from "#src/lib/money.js";
import {
  BENCHMARK_OPTIONS,
  createSeededRandom,
  MICRO_BENCHMARK_REPEATS,
  seededInteger,
} from "#src/test-support/bench-fixtures.js";

/**
 * The arithmetic module is on the hot path of every derived integer in the R&D domain, and it is
 * deliberately `bigint`-only — which is the reason it is worth measuring rather than assuming.
 * BigInt operations are heap-allocating and an order of magnitude dearer than the `number`
 * arithmetic they replace, so a change that adds one division per member is a change that shows
 * up on a cap table with two hundred rows.
 *
 * `apportionLargestRemainder` is the expensive one by construction: it allocates a slot per
 * weight, sorts them, and asserts its own sum invariant. The two sizes below bracket the range
 * the domain actually produces — four components on a video quality score, two hundred
 * contributors on a mature project.
 */

const random = createSeededRandom(7);

const SIGNED_DIVISION_PAIRS: ReadonlyArray<readonly [bigint, bigint]> = Array.from(
  { length: 1000 },
  () => {
    const magnitude = BigInt(seededInteger(random, 1_000_000_000));
    const sign = seededInteger(random, 2) === 0 ? -1n : 1n;
    const denominator = BigInt(seededInteger(random, 9999) + 1);
    return [magnitude * sign, denominator] as const;
  },
);

/**
 * The §4.2 shape: the four non-completion video-quality budgets, which are re-apportioned on
 * every scored video whose completion component has not yet ramped to full weight.
 */
const VIDEO_QUALITY_WEIGHTS: readonly bigint[] = [25n, 20n, 10n, 5n];
const VIDEO_QUALITY_TIE_BREAK_KEYS: readonly string[] = [
  "engagementRate",
  "viewVelocity",
  "creatorTrack",
  "freshnessFloor",
];

/** The cap-table shape: contributed minutes per member, apportioned across 10 000 basis points. */
const CONTRIBUTOR_COUNT = 200;
const CONTRIBUTOR_WEIGHTS: readonly bigint[] = Array.from({ length: CONTRIBUTOR_COUNT }, () =>
  BigInt(seededInteger(random, 50_000)),
);
const CONTRIBUTOR_TIE_BREAK_KEYS: readonly string[] = Array.from(
  { length: CONTRIBUTOR_COUNT },
  (unusedValue, memberIndex) => `member-${String(memberIndex).padStart(4, "0")}`,
);

export const moneyBenchmarks = withCodSpeed(new Bench({ name: "money", ...BENCHMARK_OPTIONS }));

moneyBenchmarks.add("divRoundHalfAwayFromZero over 1000 signed pairs", () => {
  for (const [numerator, denominator] of SIGNED_DIVISION_PAIRS) {
    divRoundHalfAwayFromZero(numerator, denominator);
  }
});

moneyBenchmarks.add("basisPointsOf over 1000 parts", () => {
  for (const [numerator, denominator] of SIGNED_DIVISION_PAIRS) {
    basisPointsOf(numerator, denominator);
  }
});

moneyBenchmarks.add("apportionLargestRemainder — 1000 four-component budgets", () => {
  for (let repeat = 0; repeat < MICRO_BENCHMARK_REPEATS; repeat += 1) {
    apportionLargestRemainder(VIDEO_QUALITY_WEIGHTS, 17, VIDEO_QUALITY_TIE_BREAK_KEYS);
  }
});

moneyBenchmarks.add("apportionLargestRemainder — 200 contributors over 10 000 basis points", () => {
  apportionLargestRemainder(CONTRIBUTOR_WEIGHTS, 10_000, CONTRIBUTOR_TIE_BREAK_KEYS);
});
