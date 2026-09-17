import { withCodSpeed } from "@codspeed/tinybench-plugin";
import { Bench } from "tinybench";

import {
  type AffinityScoreInputs,
  computeAffinityScorePoints,
} from "#src/modules/home/affinity-score.js";
import {
  BENCHMARK_OPTIONS,
  createSeededRandom,
  MICRO_BENCHMARK_REPEATS,
  seededInteger,
} from "#src/test-support/bench-fixtures.js";

/**
 * Personalization, at the multiplicity it is actually computed at.
 *
 * An affinity score is per viewer × topic AND per viewer × creator, so the recompute job pays this
 * function once for every pair a viewer has a signal on — a few hundred rows for an engaged
 * viewer, against a catalogue that grows. It is pure integer arithmetic over ladders, which makes
 * it cheap per call and expensive in aggregate: the thing worth watching is the per-call cost, and
 * a benchmark is the only place that number is visible.
 *
 * The fixture deliberately mixes cold-start rows (no completion samples, no explicit signals) with
 * saturated ones and with rows carrying a negative signal, because the negative branch is the one
 * that clamps against the positive total rather than returning from a ladder directly.
 */

const random = createSeededRandom(29);

const AFFINITY_ROWS: readonly AffinityScoreInputs[] = Array.from({ length: 500 }, () => {
  const completionSampleCount = seededInteger(random, 30);
  return {
    countedViewCount: seededInteger(random, 60),
    completionBasisPointsSum: completionSampleCount * seededInteger(random, 10_000),
    completionSampleCount,
    likeCount: seededInteger(random, 12),
    saveCount: seededInteger(random, 6),
    isSubscribedToCreator: seededInteger(random, 4) === 0,
    dismissalCount: seededInteger(random, 5),
    isCreatorMuted: seededInteger(random, 20) === 0,
  };
});

/** The cold-start row: every signal absent, which is the state most pairs are in. */
const COLD_START_ROW: AffinityScoreInputs = {
  countedViewCount: 0,
  completionBasisPointsSum: 0,
  completionSampleCount: 0,
  likeCount: 0,
  saveCount: 0,
  isSubscribedToCreator: false,
  dismissalCount: 0,
  isCreatorMuted: false,
};

/** The saturated row: every component at or above its top rung, plus a mute to clamp against. */
const SATURATED_MUTED_ROW: AffinityScoreInputs = {
  countedViewCount: 400,
  completionBasisPointsSum: 200 * 9_500,
  completionSampleCount: 200,
  likeCount: 40,
  saveCount: 25,
  isSubscribedToCreator: true,
  dismissalCount: 14,
  isCreatorMuted: true,
};

export const affinityScoreBenchmarks = withCodSpeed(
  new Bench({ name: "affinity-score", ...BENCHMARK_OPTIONS }),
);

affinityScoreBenchmarks.add("computeAffinityScorePoints over 500 viewer-topic pairs", () => {
  for (const inputs of AFFINITY_ROWS) {
    computeAffinityScorePoints(inputs);
  }
});

affinityScoreBenchmarks.add("computeAffinityScorePoints — 1000 cold-start pairs", () => {
  for (let repeat = 0; repeat < MICRO_BENCHMARK_REPEATS; repeat += 1) {
    computeAffinityScorePoints(COLD_START_ROW);
  }
});

affinityScoreBenchmarks.add(
  "computeAffinityScorePoints — 1000 saturated pairs with a muted creator",
  () => {
    for (let repeat = 0; repeat < MICRO_BENCHMARK_REPEATS; repeat += 1) {
      computeAffinityScorePoints(SATURATED_MUTED_ROW);
    }
  },
);
