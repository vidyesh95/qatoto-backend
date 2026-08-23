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

/**
 * The NEGATIVE budget — "not interested" and "don't recommend channel", as a ranking input.
 *
 * ## It is NOT part of `AFFINITY_SCORE_COMPONENT_BUDGETS`, and must not become one
 *
 * That table declares the three POSITIVE components and `assertBudgetsSumTo` holds it to
 * exactly 100. A fourth entry would break that assertion, and adding a negative number to a
 * sum-to-100 table would make "budget" mean two different things in one object. This is a
 * SUBTRAHEND, not a component: the positives still define the ceiling and this claws back
 * from it.
 *
 * ## Why 40
 *
 * Enough to erase the entire `watchCount` budget (45) on its own, and not enough to bury a
 * category the viewer demonstrably likes — someone who watches a topic constantly AND
 * occasionally dismisses one still scores well above a topic they have never opened. A
 * negative signal that can zero out a strong positive one is not a preference any more, it
 * is a second hard filter, and there is already a hard filter (§4.5's `NOT EXISTS`) doing
 * that job properly.
 */
export const NEGATIVE_SIGNAL_BUDGET_POINTS = 40;

/**
 * Which formula produced a snapshot row — written explicitly by the job rather than left to
 * the column's `DEFAULT 1`.
 *
 * VERSION 1 was the three positive components alone. VERSION 2 subtracts the negative
 * signal. The distinction matters because rows from both versions coexist in the same table
 * forever: the nightly job writes a new `as_of` rather than rewriting history, so a v1 row
 * scored 60 and a v2 row scored 60 do not mean the same thing, and anything comparing across
 * a date range has to know which formula it is looking at.
 *
 * The DEFAULT stays at 1 deliberately. It describes what the existing rows were computed
 * with, and moving it would retroactively relabel them as something they are not.
 */
export const AFFINITY_SCORE_ALGORITHM_VERSION = 2;

/**
 * DELIBERATELY SHALLOW AT THE BOTTOM. One dismissal is worth 2 points out of 100 — close to
 * nothing — and it takes about a dozen in one category to spend the whole budget.
 *
 * That shape is copied from the only public measurement of these controls anywhere.
 * Mozilla's RegretsReporter study (Sept 2022) found YouTube's "Don't recommend channel" cut
 * unwanted recommendations by roughly 43%, while "Not interested" managed only about 11% —
 * a single dismissal is near-noise there BY DESIGN, and repetition is what carries the
 * signal. One idle tap must not visibly reshape a feed, because the person who made it
 * cannot tell which of their taps did what, and a control whose effect they cannot predict
 * is one they stop trusting.
 *
 * The same rule holds on the commerce side of this platform for the same reason: hiding one
 * supplier is not an instruction to stop showing that product category.
 */
const NEGATIVE_SIGNAL_LADDER: readonly ScoreLadderRung[] = [
  { threshold: 12, points: 40 },
  { threshold: 8, points: 30 },
  { threshold: 5, points: 20 },
  { threshold: 3, points: 12 },
  { threshold: 2, points: 6 },
  { threshold: 1, points: 2 },
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
assertLadderIsWellFormed(
  "NEGATIVE_SIGNAL_LADDER",
  NEGATIVE_SIGNAL_LADDER,
  "atLeastThreshold",
  NEGATIVE_SIGNAL_BUDGET_POINTS,
);

/**
 * A subscription is worth more than a like because it is a standing statement rather than
 * a reaction to one video. Only ever set on a CREATOR affinity — a category cannot be
 * subscribed to.
 */
export const SUBSCRIPTION_SIGNAL_WEIGHT = 4;

/**
 * The mirror image of `SUBSCRIPTION_SIGNAL_WEIGHT`, and set to the ladder's top rung so ONE
 * mute spends the entire negative budget by itself.
 *
 * A mute is the same KIND of thing a subscription is — a standing statement about a channel
 * rather than a reaction to a single video — so it gets the same treatment with the sign
 * flipped. The magnitude is where the asymmetry lives: RegretsReporter's ~43% for "don't
 * recommend channel" against ~11% for "not interested" is one deliberate act versus one idle
 * tap, and this constant against `NEGATIVE_SIGNAL_LADDER`'s bottom rung of 2 encodes exactly
 * that gap.
 *
 * ONLY EVER SET ON A CREATOR AFFINITY, and this is the load-bearing half of the rule. A mute
 * must never reach the TOPIC penalty: muting one anime channel is not a statement about
 * anime, and a viewer who found their whole subject matter quietly demoted because they
 * silenced one loud channel has been handed a control that lied about what it does. On
 * YouTube the 43% is channel-scoped for the same reason, and blocking a supplier here does
 * not hide their product category either. The topic call passes `isCreatorMuted: false`
 * exactly as it already passes `isSubscribedToCreator: false`.
 */
export const MUTE_SIGNAL_WEIGHT = 12;

export interface AffinityScoreInputs {
  readonly countedViewCount: number;
  readonly completionBasisPointsSum: number;
  readonly completionSampleCount: number;
  readonly likeCount: number;
  readonly saveCount: number;
  readonly isSubscribedToCreator: boolean;
  /**
   * "Not interested" rows — in this category, or on this creator's videos.
   *
   * A COUNT, not a flag, because that is the whole design: the ladder is shallow at the
   * bottom so that repetition, rather than any single tap, is what moves the score.
   */
  readonly dismissalCount: number;
  /** "Don't recommend channel". NEVER true on a topic call — see `MUTE_SIGNAL_WEIGHT`. */
  readonly isCreatorMuted: boolean;
}

export interface AffinityScoreBreakdown {
  readonly totalPoints: number;
  readonly watchCountComponentPoints: number;
  readonly meanCompletionComponentPoints: number;
  readonly explicitSignalComponentPoints: number;
  /**
   * The penalty ACTUALLY APPLIED, already clamped to what the positives could pay.
   *
   * Stored rather than recomputed because the snapshot tables carry a CHECK asserting
   * `watch + completion + explicit - negative = affinity_points`. Storing the raw ladder
   * output instead would break that identity for anyone whose penalty exceeded their
   * positive total, and Postgres would refuse the row.
   */
  readonly negativeSignalComponentPoints: number;
  readonly meanCompletionBasisPoints: number;
  readonly explicitSignalCount: number;
  readonly negativeSignalCount: number;
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
  assertNonNegativeIntegerInput(
    "computeAffinityScorePoints",
    "dismissalCount",
    inputs.dismissalCount,
  );

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

  const positiveTotalPoints =
    watchCountComponentPoints + meanCompletionComponentPoints + explicitSignalComponentPoints;

  // A mute counts as `MUTE_SIGNAL_WEIGHT` dismissals rather than as its own component, so the
  // two negative signals share ONE ladder and one budget. Two parallel penalties would need
  // two budgets, and their sum could exceed what the positives can pay in ways neither one
  // predicts on its own.
  const negativeSignalCount =
    inputs.dismissalCount + (inputs.isCreatorMuted ? MUTE_SIGNAL_WEIGHT : 0);

  // CLAMPED TO WHAT THE POSITIVES CAN PAY. The stored value is the penalty actually applied,
  // which is what keeps the snapshot CHECK's sum identity exact — see the field's doc. It also
  // means the floor is a genuine zero rather than a negative score: the ranker reads
  // `affinity_points` through a `max(COALESCE(...))`, where a stored 0 already suppresses
  // harder than no row at all, because COALESCE takes the non-null zero and never reaches the
  // cold-start popularity fallback.
  const negativeSignalComponentPoints = Math.min(
    pointsForAtLeastLadder(NEGATIVE_SIGNAL_LADDER, negativeSignalCount),
    positiveTotalPoints,
  );

  const totalPoints = positiveTotalPoints - negativeSignalComponentPoints;

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
    negativeSignalComponentPoints,
    meanCompletionBasisPoints,
    explicitSignalCount,
    negativeSignalCount,
  };
}

// NO `coldStartAffinityPoints()` HELPER. The damping is rendered directly into the feed's
// ranking SQL (`feed.service.ts`, using COLD_START_POPULARITY_DAMPING_PERCENT above),
// because the fallback has to be part of the ORDER BY expression rather than something
// applied to rows already fetched. A TypeScript twin would be a second definition of the
// same arithmetic that nothing calls — which is what it was until this audit removed it.
