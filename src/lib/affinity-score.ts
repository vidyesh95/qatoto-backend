import {
  assertBudgetsSumTo,
  assertLadderIsWellFormed,
  assertNonNegativeIntegerInput,
  pointsForAtLeastLadder,
  type ScoreLadderRung,
} from "#src/lib/score-ladder.js";

/**
 * How much a viewer likes a topic, or a creator — HOME_BACKEND_STRUCTURE.md §4.3, §4.4.
 *
 * ONE LADDER SET SERVES BOTH. Topic affinity and creator affinity ask the same question of
 * the same rows ("how much of this did you watch, how well, and did you say so?"); only the
 * grouping key differs. Two scorers would be two places a tuning change has to land, and
 * the second one would be forgotten.
 *
 * ## Watch count is not the whole story, and that is the point
 *
 * A viewer who opens ten videos in a category and abandons every one at three seconds has
 * told us they are NOT interested. Counting arrivals alone would read that as strong
 * affinity and bury them in more of it. Mean completion is what separates "watched" from
 * "clicked" here, exactly as it does in the quality score.
 *
 * ## Rule 5 lives at the call site, not here
 *
 * A category a viewer has never watched is not affinity 0 — §4.4 says it falls back to
 * platform popularity, damped. This module scores what it is given; the job and the feed
 * query decide what "no rows" means. Passing zeroes in here to represent absence would
 * fabricate the very value the fallback exists to avoid.
 */

export const AFFINITY_SCORE_COMPONENT_BUDGETS = {
  /** Counted views by this viewer in this category / from this creator, in the window. */
  watchCount: 45,
  /** Mean completion across those views, in basis points. */
  meanCompletion: 35,
  /** Likes, saves and (for a creator) a subscription — things the viewer did on purpose. */
  explicitSignals: 20,
} as const;

const AFFINITY_SCORE_MAXIMUM_POINTS = 100;
assertBudgetsSumTo(
  "AFFINITY_SCORE_COMPONENT_BUDGETS",
  AFFINITY_SCORE_COMPONENT_BUDGETS,
  AFFINITY_SCORE_MAXIMUM_POINTS,
);

/**
 * How far back the affinity window reaches, for the nightly per-user snapshots.
 *
 * Long enough to survive a week away from the platform; short enough that a taste from two
 * years ago does not outvote what someone watched last night.
 */
export const AFFINITY_WINDOW_DAYS = 90;

/**
 * The window for an ANONYMOUS viewer's session-scoped affinity (§4.4).
 *
 * ## ONE DAY, NOT §4.4's SEVEN, AND THE DIFFERENCE IS NOT A CHOICE
 *
 * §4.4 says "join `videoViewSession` on `viewerFingerprint` over the last 7 days". That
 * lookback cannot work, and the reason is the privacy design one section earlier: the
 * fingerprint is salted with the UTC day string, so it ROTATES EVERY MIDNIGHT. Yesterday's
 * sessions carry a different fingerprint and a 7-day query matches none of them.
 *
 * Writing 7 here would not widen anything. It would produce a constant that reads like a
 * week of history and delivers a day of it — the worst kind of wrong, because nothing
 * fails and nobody checks.
 *
 * Recovering the real week would mean a stable per-visitor identifier that survives
 * midnight, which is exactly the long-lived anonymous tracking record §3.2 refused to
 * keep. One day is what the privacy design permits, and it is enough for §4.4's actual
 * claim: an anonymous feed that starts responding after two or three watches IN THE
 * SESSION the viewer is having.
 */
export const ANONYMOUS_AFFINITY_WINDOW_DAYS = 1;

/**
 * §4.4's cold-start damping: platform popularity, at 60%.
 *
 * Damped rather than used raw so a brand-new account sees a sensible feed that is not
 * *claiming* to be personalized — a viewer with no history should not outrank one with real
 * affinity on the same category.
 */
export const COLD_START_POPULARITY_DAMPING_PERCENT = 60;

const WATCH_COUNT_LADDER: readonly ScoreLadderRung[] = [
  { threshold: 25, points: 45 },
  { threshold: 15, points: 38 },
  { threshold: 9, points: 31 },
  { threshold: 5, points: 24 },
  { threshold: 3, points: 16 },
  { threshold: 2, points: 10 },
  { threshold: 1, points: 5 },
];

const MEAN_COMPLETION_LADDER: readonly ScoreLadderRung[] = [
  { threshold: 7_500, points: 35 },
  { threshold: 6_000, points: 29 },
  { threshold: 4_500, points: 23 },
  { threshold: 3_000, points: 17 },
  { threshold: 2_000, points: 11 },
  { threshold: 1_000, points: 6 },
  { threshold: 400, points: 2 },
];

const EXPLICIT_SIGNAL_LADDER: readonly ScoreLadderRung[] = [
  { threshold: 8, points: 20 },
  { threshold: 5, points: 16 },
  { threshold: 3, points: 12 },
  { threshold: 2, points: 8 },
  { threshold: 1, points: 4 },
];

assertLadderIsWellFormed(
  "WATCH_COUNT_LADDER",
  WATCH_COUNT_LADDER,
  "atLeastThreshold",
  AFFINITY_SCORE_COMPONENT_BUDGETS.watchCount,
);
assertLadderIsWellFormed(
  "MEAN_COMPLETION_LADDER",
  MEAN_COMPLETION_LADDER,
  "atLeastThreshold",
  AFFINITY_SCORE_COMPONENT_BUDGETS.meanCompletion,
);
assertLadderIsWellFormed(
  "EXPLICIT_SIGNAL_LADDER",
  EXPLICIT_SIGNAL_LADDER,
  "atLeastThreshold",
  AFFINITY_SCORE_COMPONENT_BUDGETS.explicitSignals,
);

/**
 * A subscription is worth more than a like because it is a standing statement rather than
 * a reaction to one video. Only ever set on a CREATOR affinity — a category cannot be
 * subscribed to.
 */
export const SUBSCRIPTION_SIGNAL_WEIGHT = 4;

export interface AffinityScoreInputs {
  readonly countedViewCount: number;
  readonly completionBasisPointsSum: number;
  readonly completionSampleCount: number;
  readonly likeCount: number;
  readonly saveCount: number;
  readonly isSubscribedToCreator: boolean;
}

export interface AffinityScoreBreakdown {
  readonly totalPoints: number;
  readonly watchCountComponentPoints: number;
  readonly meanCompletionComponentPoints: number;
  readonly explicitSignalComponentPoints: number;
  readonly meanCompletionBasisPoints: number;
  readonly explicitSignalCount: number;
}

export function computeAffinityScorePoints(inputs: AffinityScoreInputs): AffinityScoreBreakdown {
  assertNonNegativeIntegerInput(
    "computeAffinityScorePoints",
    "countedViewCount",
    inputs.countedViewCount,
  );
  assertNonNegativeIntegerInput(
    "computeAffinityScorePoints",
    "completionBasisPointsSum",
    inputs.completionBasisPointsSum,
  );
  assertNonNegativeIntegerInput(
    "computeAffinityScorePoints",
    "completionSampleCount",
    inputs.completionSampleCount,
  );
  assertNonNegativeIntegerInput("computeAffinityScorePoints", "likeCount", inputs.likeCount);
  assertNonNegativeIntegerInput("computeAffinityScorePoints", "saveCount", inputs.saveCount);

  const meanCompletionBasisPoints =
    inputs.completionSampleCount === 0
      ? 0
      : Math.floor(inputs.completionBasisPointsSum / inputs.completionSampleCount);

  const explicitSignalCount =
    inputs.likeCount +
    inputs.saveCount +
    (inputs.isSubscribedToCreator ? SUBSCRIPTION_SIGNAL_WEIGHT : 0);

  const watchCountComponentPoints = pointsForAtLeastLadder(
    WATCH_COUNT_LADDER,
    inputs.countedViewCount,
  );
  const meanCompletionComponentPoints = pointsForAtLeastLadder(
    MEAN_COMPLETION_LADDER,
    meanCompletionBasisPoints,
  );
  const explicitSignalComponentPoints = pointsForAtLeastLadder(
    EXPLICIT_SIGNAL_LADDER,
    explicitSignalCount,
  );

  const totalPoints =
    watchCountComponentPoints + meanCompletionComponentPoints + explicitSignalComponentPoints;

  if (totalPoints < 0 || totalPoints > AFFINITY_SCORE_MAXIMUM_POINTS) {
    throw new Error(
      `computeAffinityScorePoints: invariant violated — total ${String(totalPoints)} is outside 0..${String(AFFINITY_SCORE_MAXIMUM_POINTS)}`,
    );
  }

  return {
    totalPoints,
    watchCountComponentPoints,
    meanCompletionComponentPoints,
    explicitSignalComponentPoints,
    meanCompletionBasisPoints,
    explicitSignalCount,
  };
}

/**
 * §4.4's signed-in cold start: platform popularity, damped, used where affinity is absent.
 *
 * Deliberately a separate function rather than a `COALESCE` buried in the feed query, so
 * that "this viewer has no history and we are showing them the platform's own
 * distribution" is a named, testable idea rather than an incidental default.
 */
export function coldStartAffinityPoints(platformPopularityPoints: number): number {
  assertNonNegativeIntegerInput(
    "coldStartAffinityPoints",
    "platformPopularityPoints",
    platformPopularityPoints,
  );
  return Math.floor(
    (platformPopularityPoints * COLD_START_POPULARITY_DAMPING_PERCENT) / 100,
  );
}
