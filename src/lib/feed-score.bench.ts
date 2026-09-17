import { withCodSpeed } from "@codspeed/tinybench-plugin";
import { Bench } from "tinybench";

import {
  applyDiversityCaps,
  computeVideoQualityPoints,
  reserveExplorationSlots,
  type VideoQualityInputs,
} from "#src/lib/feed-score.js";
import {
  buildRankedFeedRows,
  BENCHMARK_OPTIONS,
  createSeededRandom,
  seededInteger,
} from "#src/test-support/bench-fixtures.js";

/**
 * The home feed's three pure passes, at the sizes they actually run at.
 *
 * `computeVideoQualityPoints` runs once per video in a NIGHTLY job, so its cost is multiplied by
 * the whole catalogue rather than by a request — a thousand videos per iteration is the unit that
 * makes a change legible. The other two run PER REQUEST, on the candidate window a feed page is
 * ranked from, and both are super-linear in ways worth watching: `applyDiversityCaps` walks every
 * row against two counter maps, and `reserveExplorationSlots` re-slices the first page inside its
 * own loop.
 *
 * The SQL side (`feedRankExpression`) is deliberately absent. It renders a query rather than
 * computing a score, so what it costs is a Postgres plan, not a JavaScript call.
 */

const random = createSeededRandom(11);

const VIDEO_QUALITY_INPUTS: readonly VideoQualityInputs[] = Array.from({ length: 1000 }, () => {
  // Sample counts straddle the 20-sample ramp on purpose: below it the budgets are re-apportioned
  // through `apportionLargestRemainder`, above it that work is skipped entirely.
  const completionSampleCount = seededInteger(random, 40);
  return {
    completionBasisPointsSum: completionSampleCount * seededInteger(random, 10_000),
    completionSampleCount,
    likeCount: seededInteger(random, 5000),
    commentCount: seededInteger(random, 800),
    shareCount: seededInteger(random, 400),
    saveCount: seededInteger(random, 900),
    uniqueViewerCount: seededInteger(random, 10) === 0 ? null : seededInteger(random, 50_000) + 1,
    countedViewsFirst48Hours: seededInteger(random, 200_000),
    creatorMedianQualityPoints: seededInteger(random, 5) === 0 ? null : seededInteger(random, 101),
    hoursSincePublished: seededInteger(random, 2000),
  };
});

/** A candidate window: ~50 pages of 20, which is the depth an infinite feed reaches. */
const RANKED_ROWS = buildRankedFeedRows(1000, 23);
const PAGE_SIZE = 20;

const DIVERSITY_CAP_OPTIONS = {
  pageSize: PAGE_SIZE,
  maxRowsPerCreator: 2,
  maxCategoryShareBasisPoints: 4000,
} as const;

/** Every eighth row is a fresh upload — dense enough that the quota is filled, not skipped. */
const FRESH_VIDEO_IDS: ReadonlySet<string> = new Set(
  RANKED_ROWS.map((row) => row.videoId).filter((videoId, rowIndex) => rowIndex % 8 === 0),
);

export const feedScoreBenchmarks = withCodSpeed(
  new Bench({ name: "feed-score", ...BENCHMARK_OPTIONS }),
);

feedScoreBenchmarks.add("computeVideoQualityPoints over 1000 videos", () => {
  for (const inputs of VIDEO_QUALITY_INPUTS) {
    computeVideoQualityPoints(inputs);
  }
});

feedScoreBenchmarks.add("applyDiversityCaps over 1000 ranked rows", () => {
  applyDiversityCaps(RANKED_ROWS, DIVERSITY_CAP_OPTIONS);
});

feedScoreBenchmarks.add("reserveExplorationSlots over 1000 ranked rows", () => {
  reserveExplorationSlots(RANKED_ROWS, FRESH_VIDEO_IDS, { slotsPerPage: 4 });
});

feedScoreBenchmarks.add("full post-rank pipeline for one feed page", () => {
  reserveExplorationSlots(applyDiversityCaps(RANKED_ROWS, DIVERSITY_CAP_OPTIONS), FRESH_VIDEO_IDS, {
    slotsPerPage: 4,
  });
});
