import {
  assertBudgetsSumTo,
  assertLadderIsWellFormed,
  assertNonNegativeIntegerInput,
  pointsForAtLeastLadder,
  type ScoreLadderRung,
} from "#src/lib/score-ladder.js";

/**
 * What is rising right now — HOME_BACKEND_STRUCTURE.md §6, §4.8.
 *
 * Recomputed HOURLY. A "trending" chip refreshed nightly is a lie about what the word
 * means, which is why this is the only job in the domain on an hourly cron.
 *
 * ## §6 names this score but does not specify it
 *
 * The doc asks for `trendingVideoSnapshot` (top 200, with a rank column) and says
 * `?mode=trending&limit=3` is Spotlight. It does not say what trending IS. The components
 * below are a decision, stated here so the ranking is explicable rather than folklore —
 * the same reason `problem_cluster_score_snapshot` stores its components next to its total.
 *
 * ## The window, and why quality is in here at all
 *
 * Everything is measured over the trailing 48 hours relative to `asOf`. That is short
 * enough that "trending" means rising rather than popular, and long enough that a video
 * published at an unlucky hour is not judged on an empty overnight.
 *
 * Quality carries 15 as a DAMPER. Without it, trending is a pure volume contest and the
 * fastest way onto the homepage's most prominent surface is to manufacture arrivals — the
 * exact conflation Rule 4 exists to prevent. A video with real velocity and terrible
 * completion loses 15 points to one that earned its watch time.
 */

export const TRENDING_SCORE_COMPONENT_BUDGETS = {
  recentViews: 40,
  recentWatchTime: 25,
  recentEngagement: 20,
  quality: 15,
} as const;

const TRENDING_SCORE_MAXIMUM_POINTS = 100;
assertBudgetsSumTo(
  "TRENDING_SCORE_COMPONENT_BUDGETS",
  TRENDING_SCORE_COMPONENT_BUDGETS,
  TRENDING_SCORE_MAXIMUM_POINTS,
);

/** The trailing window, in hours, relative to the job's `asOf`. */
export const TRENDING_WINDOW_HOURS = 48;

/** How many rows the snapshot keeps. Spotlight is `rank <= 3`. */
export const TRENDING_SNAPSHOT_SIZE = 200;

/** Counted views inside the window. */
const RECENT_VIEW_LADDER: readonly ScoreLadderRung[] = [
  { threshold: 10_000, points: 40 },
  { threshold: 4_000, points: 35 },
  { threshold: 1_500, points: 30 },
  { threshold: 600, points: 24 },
  { threshold: 250, points: 18 },
  { threshold: 100, points: 12 },
  { threshold: 30, points: 7 },
  { threshold: 5, points: 3 },
];

/**
 * Watched MINUTES inside the window, not seconds.
 *
 * Seconds would need a ladder spanning six orders of magnitude to be useful at both ends.
 * Minutes is the grain a human would use to describe the same quantity, and the integer
 * division that produces it happens once, in the job.
 */
const RECENT_WATCH_MINUTE_LADDER: readonly ScoreLadderRung[] = [
  { threshold: 20_000, points: 25 },
  { threshold: 8_000, points: 21 },
  { threshold: 3_000, points: 17 },
  { threshold: 1_200, points: 13 },
  { threshold: 400, points: 9 },
  { threshold: 120, points: 5 },
  { threshold: 20, points: 2 },
];

/** Likes + comments + shares + saves inside the window. */
const RECENT_ENGAGEMENT_LADDER: readonly ScoreLadderRung[] = [
  { threshold: 1_000, points: 20 },
  { threshold: 400, points: 17 },
  { threshold: 150, points: 14 },
  { threshold: 60, points: 11 },
  { threshold: 25, points: 8 },
  { threshold: 10, points: 5 },
  { threshold: 3, points: 2 },
];

/** The video's stored quality score, 0..100. */
const QUALITY_DAMPER_LADDER: readonly ScoreLadderRung[] = [
  { threshold: 70, points: 15 },
  { threshold: 55, points: 12 },
  { threshold: 40, points: 9 },
  { threshold: 25, points: 6 },
  { threshold: 12, points: 3 },
];

assertLadderIsWellFormed(
  "RECENT_VIEW_LADDER",
  RECENT_VIEW_LADDER,
  "atLeastThreshold",
  TRENDING_SCORE_COMPONENT_BUDGETS.recentViews,
);
assertLadderIsWellFormed(
  "RECENT_WATCH_MINUTE_LADDER",
  RECENT_WATCH_MINUTE_LADDER,
  "atLeastThreshold",
  TRENDING_SCORE_COMPONENT_BUDGETS.recentWatchTime,
);
assertLadderIsWellFormed(
  "RECENT_ENGAGEMENT_LADDER",
  RECENT_ENGAGEMENT_LADDER,
  "atLeastThreshold",
  TRENDING_SCORE_COMPONENT_BUDGETS.recentEngagement,
);
assertLadderIsWellFormed(
  "QUALITY_DAMPER_LADDER",
  QUALITY_DAMPER_LADDER,
  "atLeastThreshold",
  TRENDING_SCORE_COMPONENT_BUDGETS.quality,
);

export interface TrendingScoreInputs {
  readonly countedViewsInWindow: number;
  readonly watchedMinutesInWindow: number;
  readonly engagementActionsInWindow: number;
  /** NULL until the nightly quality job has scored this video. */
  readonly qualityScorePoints: number | null;
}

export interface TrendingScoreBreakdown {
  readonly totalPoints: number;
  readonly recentViewComponentPoints: number;
  readonly recentWatchTimeComponentPoints: number;
  readonly recentEngagementComponentPoints: number;
  readonly qualityComponentPoints: number;
}

export function computeTrendingScorePoints(inputs: TrendingScoreInputs): TrendingScoreBreakdown {
  assertNonNegativeIntegerInput(
    "computeTrendingScorePoints",
    "countedViewsInWindow",
    inputs.countedViewsInWindow,
  );
  assertNonNegativeIntegerInput(
    "computeTrendingScorePoints",
    "watchedMinutesInWindow",
    inputs.watchedMinutesInWindow,
  );
  assertNonNegativeIntegerInput(
    "computeTrendingScorePoints",
    "engagementActionsInWindow",
    inputs.engagementActionsInWindow,
  );

  const recentViewComponentPoints = pointsForAtLeastLadder(
    RECENT_VIEW_LADDER,
    inputs.countedViewsInWindow,
  );
  const recentWatchTimeComponentPoints = pointsForAtLeastLadder(
    RECENT_WATCH_MINUTE_LADDER,
    inputs.watchedMinutesInWindow,
  );
  const recentEngagementComponentPoints = pointsForAtLeastLadder(
    RECENT_ENGAGEMENT_LADDER,
    inputs.engagementActionsInWindow,
  );
  // Rule 5: an unscored video scores 0 on the damper, which is NOT the same as claiming
  // its quality is zero — it means the nightly job has not reached it yet. It still ranks
  // on the other 85 points, so a video uploaded this morning can trend this afternoon.
  const qualityComponentPoints =
    inputs.qualityScorePoints === null
      ? 0
      : pointsForAtLeastLadder(QUALITY_DAMPER_LADDER, inputs.qualityScorePoints);

  const totalPoints =
    recentViewComponentPoints +
    recentWatchTimeComponentPoints +
    recentEngagementComponentPoints +
    qualityComponentPoints;

  if (totalPoints < 0 || totalPoints > TRENDING_SCORE_MAXIMUM_POINTS) {
    throw new Error(
      `computeTrendingScorePoints: invariant violated — total ${String(totalPoints)} is outside 0..${String(TRENDING_SCORE_MAXIMUM_POINTS)}`,
    );
  }

  return {
    totalPoints,
    recentViewComponentPoints,
    recentWatchTimeComponentPoints,
    recentEngagementComponentPoints,
    qualityComponentPoints,
  };
}
