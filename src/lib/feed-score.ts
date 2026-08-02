import { sql, type SQL } from "drizzle-orm";

import { apportionLargestRemainder } from "#src/lib/money.js";
import {
  assertBudgetsSumTo,
  assertLadderIsWellFormed,
  assertNonNegativeIntegerInput,
  assertSafeIntegerInput,
  pointsForAtLeastLadder,
  type ScoreLadderRung,
} from "#src/lib/score-ladder.js";

/**
 * The home feed's two scores — HOME_BACKEND_STRUCTURE.md §4.1, §4.2, §4.3, §4.6.
 *
 * TWO DIFFERENT THINGS LIVE HERE, on purpose:
 *
 *   1. **Video quality** (§4.1) — nightly, per video, 0..100, pure TypeScript over integer
 *      ladders. Computed once by `recompute-video-quality-scores` and stored.
 *   2. **Feed rank** (§4.3) — query time, per viewer × video, 0..100. This one is RENDERED
 *      AS SQL rather than computed in TS, and §3 below says why.
 *
 * Plus the two pure post-rank passes of §4.6.
 *
 * ## Why the rank is SQL and the quality is not
 *
 * Rank is per viewer × video and the feed is offset-paginated. Computing it in TypeScript
 * would mean fetching and ranking every candidate above the requested offset — page 200 at
 * limit 50 pulls 30,000 rows to return 50. Pushing it into an `ORDER BY` expression lets
 * Postgres do what it is for.
 *
 * The cost of that choice is that the arithmetic leaves TypeScript, so THIS MODULE OWNS THE
 * CONSTANTS AND RENDERS THE EXPRESSION. There is exactly one place the budgets live and one
 * place the recency ladder lives; the service composes a query, it does not restate a
 * formula. Every term is integer division — Rule 2 applied where the ranking actually
 * happens, so two runs over the same data produce bit-identical order.
 *
 * Quality has no such pressure: it is computed for one video at a time by a nightly job, so
 * it stays where it can be unit-tested against a table of cases.
 */

// ---------------------------------------------------------------------------
// §4.1 — video quality, nightly, 0..100
// ---------------------------------------------------------------------------

export const VIDEO_QUALITY_COMPONENT_BUDGETS = {
  /**
   * The Douyin lean, and it is the right lean: completion is the ONLY component that
   * measures whether the video was *good*, as opposed to whether it was *clicked*.
   */
  completionRate: 40,
  engagementRate: 25,
  viewVelocity: 20,
  creatorTrack: 10,
  freshnessFloor: 5,
} as const;

const VIDEO_QUALITY_MAXIMUM_POINTS = 100;
assertBudgetsSumTo(
  "VIDEO_QUALITY_COMPONENT_BUDGETS",
  VIDEO_QUALITY_COMPONENT_BUDGETS,
  VIDEO_QUALITY_MAXIMUM_POINTS,
);

/** §4.2: at this many completion samples, completion carries its full 40. */
export const COMPLETION_RAMP_FULL_WEIGHT_SAMPLES = 20;

/** A video is "fresh" for its first three days. */
export const FRESHNESS_WINDOW_HOURS = 72;

/** Mean completion, in basis points. */
const COMPLETION_LADDER: readonly ScoreLadderRung[] = [
  { threshold: 7_000, points: 40 },
  { threshold: 5_500, points: 34 },
  { threshold: 4_500, points: 28 },
  { threshold: 3_500, points: 22 },
  { threshold: 2_500, points: 16 },
  { threshold: 1_500, points: 10 },
  { threshold: 800, points: 5 },
  { threshold: 300, points: 2 },
];

/**
 * Engagement actions per 1000 UNIQUE VIEWERS — not per 1000 views.
 *
 * This is the cheapest structural defence against a creator inflating their own
 * denominator: farming views inflates the divisor too, so the ratio does not move. It
 * costs one extra column and it is the difference between a ratio and a raw count.
 */
const ENGAGEMENT_LADDER: readonly ScoreLadderRung[] = [
  { threshold: 300, points: 25 },
  { threshold: 200, points: 21 },
  { threshold: 120, points: 17 },
  { threshold: 70, points: 13 },
  { threshold: 40, points: 9 },
  { threshold: 20, points: 6 },
  { threshold: 8, points: 3 },
  { threshold: 3, points: 1 },
];

/** Counted views in the first 48 hours after publication. */
const VIEW_VELOCITY_LADDER: readonly ScoreLadderRung[] = [
  { threshold: 5_000, points: 20 },
  { threshold: 2_000, points: 17 },
  { threshold: 800, points: 14 },
  { threshold: 300, points: 11 },
  { threshold: 100, points: 8 },
  { threshold: 40, points: 5 },
  { threshold: 10, points: 2 },
];

/** The creator's median quality across their published videos, 0..100. */
const CREATOR_TRACK_LADDER: readonly ScoreLadderRung[] = [
  { threshold: 80, points: 10 },
  { threshold: 65, points: 8 },
  { threshold: 50, points: 6 },
  { threshold: 35, points: 4 },
  { threshold: 20, points: 2 },
];

assertLadderIsWellFormed(
  "COMPLETION_LADDER",
  COMPLETION_LADDER,
  "atLeastThreshold",
  VIDEO_QUALITY_COMPONENT_BUDGETS.completionRate,
);
assertLadderIsWellFormed(
  "ENGAGEMENT_LADDER",
  ENGAGEMENT_LADDER,
  "atLeastThreshold",
  VIDEO_QUALITY_COMPONENT_BUDGETS.engagementRate,
);
assertLadderIsWellFormed(
  "VIEW_VELOCITY_LADDER",
  VIEW_VELOCITY_LADDER,
  "atLeastThreshold",
  VIDEO_QUALITY_COMPONENT_BUDGETS.viewVelocity,
);
assertLadderIsWellFormed(
  "CREATOR_TRACK_LADDER",
  CREATOR_TRACK_LADDER,
  "atLeastThreshold",
  VIDEO_QUALITY_COMPONENT_BUDGETS.creatorTrack,
);

export interface VideoQualityInputs {
  readonly completionBasisPointsSum: number;
  readonly completionSampleCount: number;
  readonly likeCount: number;
  readonly commentCount: number;
  readonly shareCount: number;
  readonly saveCount: number;
  /**
   * NULL until `recompute-video-quality-scores` has computed it.
   *
   * Rule 5: absence is not zero. A NULL denominator scores engagement 0 rather than
   * dividing by a number the caller invented — and unlike a fabricated 1, a 0 here is
   * recovered by the ramp redistributing into the other components.
   */
  readonly uniqueViewerCount: number | null;
  readonly countedViewsFirst48Hours: number;
  /** NULL for a creator whose other videos are all still unscored. */
  readonly creatorMedianQualityPoints: number | null;
  readonly hoursSincePublished: number;
}

export interface VideoQualityBreakdown {
  readonly totalPoints: number;
  readonly completionComponentPoints: number;
  readonly engagementComponentPoints: number;
  readonly velocityComponentPoints: number;
  readonly creatorTrackComponentPoints: number;
  readonly freshnessComponentPoints: number;
  /** Stored on the snapshot so the score is explicable without replaying history. */
  readonly meanCompletionBasisPoints: number;
  readonly engagementPerThousandViewers: number;
}

/**
 * §4.2's sample ramp, and it is the difference between a working feed and a closed loop.
 *
 * A new video has no completion samples. Scoring it 0 on a 40-point component means it can
 * never rank, which means it is never watched, which means it never gets samples. The
 * obvious fix — a cliff at 5 samples — just moves the discontinuity somewhere visible.
 *
 * Instead the completion budget RAMPS with sample count and whatever it has not yet earned
 * is redistributed across the other four in proportion to their own weights. At 0 samples a
 * video is scored purely on engagement, velocity, creator track and freshness; at 20 it
 * carries the full 40; in between it ramps. No cliff, no video pinned at zero.
 *
 * `apportionLargestRemainder` (src/lib/money.ts) does the redistribution because it already
 * guarantees the parts sum EXACTLY to the whole — which is the only property that matters,
 * and the one a naive `Math.floor(remainder * w / 60)` silently breaks.
 */
function effectiveComponentBudgets(completionSampleCount: number): {
  readonly completionRate: number;
  readonly engagementRate: number;
  readonly viewVelocity: number;
  readonly creatorTrack: number;
  readonly freshnessFloor: number;
} {
  const rampedSamples = Math.min(completionSampleCount, COMPLETION_RAMP_FULL_WEIGHT_SAMPLES);
  const completionRate = Math.floor(
    (VIDEO_QUALITY_COMPONENT_BUDGETS.completionRate * rampedSamples) /
      COMPLETION_RAMP_FULL_WEIGHT_SAMPLES,
  );
  const remainder = VIDEO_QUALITY_COMPONENT_BUDGETS.completionRate - completionRate;

  const [engagementShare, velocityShare, creatorTrackShare, freshnessShare] =
    apportionLargestRemainder(
      [
        BigInt(VIDEO_QUALITY_COMPONENT_BUDGETS.engagementRate),
        BigInt(VIDEO_QUALITY_COMPONENT_BUDGETS.viewVelocity),
        BigInt(VIDEO_QUALITY_COMPONENT_BUDGETS.creatorTrack),
        BigInt(VIDEO_QUALITY_COMPONENT_BUDGETS.freshnessFloor),
      ],
      remainder,
      // Fixed, unique, and in a stated order, so the apportionment is deterministic.
      ["engagementRate", "viewVelocity", "creatorTrack", "freshnessFloor"],
    );

  return {
    completionRate,
    engagementRate: VIDEO_QUALITY_COMPONENT_BUDGETS.engagementRate + (engagementShare ?? 0),
    viewVelocity: VIDEO_QUALITY_COMPONENT_BUDGETS.viewVelocity + (velocityShare ?? 0),
    creatorTrack: VIDEO_QUALITY_COMPONENT_BUDGETS.creatorTrack + (creatorTrackShare ?? 0),
    freshnessFloor: VIDEO_QUALITY_COMPONENT_BUDGETS.freshnessFloor + (freshnessShare ?? 0),
  };
}

/**
 * Rescales a ladder's award from its full budget onto the ramped one.
 *
 * Integer division, floored, so the result can only ever be at or under the effective
 * budget — which is what keeps the total inside 0..100 without a second clamp.
 */
function scaleToEffectiveBudget(
  ladderPoints: number,
  fullBudget: number,
  effectiveBudget: number,
): number {
  return Math.floor((ladderPoints * effectiveBudget) / fullBudget);
}

export function computeVideoQualityPoints(inputs: VideoQualityInputs): VideoQualityBreakdown {
  assertNonNegativeIntegerInput(
    "computeVideoQualityPoints",
    "completionBasisPointsSum",
    inputs.completionBasisPointsSum,
  );
  assertNonNegativeIntegerInput(
    "computeVideoQualityPoints",
    "completionSampleCount",
    inputs.completionSampleCount,
  );
  assertNonNegativeIntegerInput(
    "computeVideoQualityPoints",
    "countedViewsFirst48Hours",
    inputs.countedViewsFirst48Hours,
  );
  assertSafeIntegerInput(
    "computeVideoQualityPoints",
    "hoursSincePublished",
    inputs.hoursSincePublished,
  );

  const meanCompletionBasisPoints =
    inputs.completionSampleCount === 0
      ? 0
      : Math.floor(inputs.completionBasisPointsSum / inputs.completionSampleCount);

  const engagementActionCount =
    inputs.likeCount + inputs.commentCount + inputs.shareCount + inputs.saveCount;
  // A NULL or zero unique-viewer count yields 0, not a division by a fabricated 1. The
  // ramp is what stops that costing a new video the whole component.
  const engagementPerThousandViewers =
    inputs.uniqueViewerCount === null || inputs.uniqueViewerCount === 0
      ? 0
      : Math.floor((engagementActionCount * 1_000) / inputs.uniqueViewerCount);

  const budgets = effectiveComponentBudgets(inputs.completionSampleCount);

  const completionComponentPoints = scaleToEffectiveBudget(
    pointsForAtLeastLadder(COMPLETION_LADDER, meanCompletionBasisPoints),
    VIDEO_QUALITY_COMPONENT_BUDGETS.completionRate,
    budgets.completionRate,
  );
  const engagementComponentPoints = scaleToEffectiveBudget(
    pointsForAtLeastLadder(ENGAGEMENT_LADDER, engagementPerThousandViewers),
    VIDEO_QUALITY_COMPONENT_BUDGETS.engagementRate,
    budgets.engagementRate,
  );
  const velocityComponentPoints = scaleToEffectiveBudget(
    pointsForAtLeastLadder(VIEW_VELOCITY_LADDER, inputs.countedViewsFirst48Hours),
    VIDEO_QUALITY_COMPONENT_BUDGETS.viewVelocity,
    budgets.viewVelocity,
  );
  const creatorTrackComponentPoints =
    inputs.creatorMedianQualityPoints === null
      ? 0
      : scaleToEffectiveBudget(
          pointsForAtLeastLadder(CREATOR_TRACK_LADDER, inputs.creatorMedianQualityPoints),
          VIDEO_QUALITY_COMPONENT_BUDGETS.creatorTrack,
          budgets.creatorTrack,
        );
  // NOT A LADDER, deliberately. §4.1 gives freshness one rung — published inside the
  // window earns the whole budget. Expressing a single threshold as a ladder would be
  // decoration, and `assertLadderIsWellFormed` would have nothing to check.
  const freshnessComponentPoints =
    inputs.hoursSincePublished >= 0 && inputs.hoursSincePublished < FRESHNESS_WINDOW_HOURS
      ? budgets.freshnessFloor
      : 0;

  const totalPoints =
    completionComponentPoints +
    engagementComponentPoints +
    velocityComponentPoints +
    creatorTrackComponentPoints +
    freshnessComponentPoints;

  if (totalPoints < 0 || totalPoints > VIDEO_QUALITY_MAXIMUM_POINTS) {
    throw new Error(
      `computeVideoQualityPoints: invariant violated — total ${String(totalPoints)} is outside 0..${String(VIDEO_QUALITY_MAXIMUM_POINTS)}`,
    );
  }

  return {
    totalPoints,
    completionComponentPoints,
    engagementComponentPoints,
    velocityComponentPoints,
    creatorTrackComponentPoints,
    freshnessComponentPoints,
    meanCompletionBasisPoints,
    engagementPerThousandViewers,
  };
}

// ---------------------------------------------------------------------------
// §4.3 — feed rank, query time, rendered as SQL
// ---------------------------------------------------------------------------

export const FEED_RANK_COMPONENT_BUDGETS = {
  videoQuality: 35,
  topicAffinity: 25,
  creatorAffinity: 15,
  recency: 15,
  exploration: 10,
} as const;

const FEED_RANK_MAXIMUM_POINTS = 100;
assertBudgetsSumTo(
  "FEED_RANK_COMPONENT_BUDGETS",
  FEED_RANK_COMPONENT_BUDGETS,
  FEED_RANK_MAXIMUM_POINTS,
);

/**
 * `?mode=new_to_you`'s budgets (§4.8).
 *
 * §4.8 says only "the exploration budget raised to 40" and does not say what gives. Adding
 * 30 while leaving the other four alone would let the rank reach 130 — in a module whose
 * entire discipline is that budgets sum to 100 — so the 30 has to come from somewhere.
 *
 * IT COMES FROM THE TWO AFFINITY COMPONENTS, and that is not an accounting trick. "New to
 * you" means *stop showing me what I already like*: a mode built to escape the filter
 * bubble should not be ranking on the two components that measure how deep in it you are.
 * Creator affinity goes to zero outright, because this mode already excludes creators the
 * viewer has watched — the component would score nothing anyway.
 *
 * Quality and recency are untouched. Escaping your bubble should not mean being served
 * worse or staler videos.
 */
export const NEW_TO_YOU_RANK_COMPONENT_BUDGETS = {
  videoQuality: 35,
  topicAffinity: 10,
  creatorAffinity: 0,
  recency: 15,
  exploration: 40,
} as const;

// Asserted at module load exactly like the default table. Two budget tables is two chances
// for one of them to stop summing to 100, and the one nobody looks at is the one that will.
assertBudgetsSumTo(
  "NEW_TO_YOU_RANK_COMPONENT_BUDGETS",
  NEW_TO_YOU_RANK_COMPONENT_BUDGETS,
  FEED_RANK_MAXIMUM_POINTS,
);

/**
 * Hours since publication → points. §4.3's table, as data.
 *
 * Read as "strictly less than": `<6 → 15`, `<24 → 13`, …, else 0. Not run through
 * `assertLadderIsWellFormed` because it is never scanned in TypeScript — it is rendered
 * into a `CASE`, and its shape is checked below instead.
 */
const FEED_RECENCY_LADDER: readonly { readonly maxHours: number; readonly points: number }[] = [
  { maxHours: 6, points: 15 },
  { maxHours: 24, points: 13 },
  { maxHours: 72, points: 10 },
  { maxHours: 168, points: 7 },
  { maxHours: 336, points: 4 },
  { maxHours: 720, points: 2 },
];

// The same two properties assertLadderIsWellFormed checks, for the one ladder that is
// rendered rather than scanned: ascending thresholds, strictly decreasing points, and a
// top rung equal to the budget.
{
  const topRung = FEED_RECENCY_LADDER[0];
  if (topRung === undefined || topRung.points !== FEED_RANK_COMPONENT_BUDGETS.recency) {
    throw new Error("FEED_RECENCY_LADDER: top rung must equal the recency budget");
  }
  let previous = topRung;
  for (const rung of FEED_RECENCY_LADDER.slice(1)) {
    if (rung.maxHours <= previous.maxHours || rung.points >= previous.points) {
      throw new Error("FEED_RECENCY_LADDER: thresholds must ascend and points must descend");
    }
    previous = rung;
  }
}

/**
 * §4.3's exploration term is TWO things, not one: "`hash(rankSeed, videoId) % 11`, plus a
 * boost for categories the viewer has no affinity in."
 *
 * The budget is 10, so the two parts have to share it. The hash takes 0..7 and the boost
 * takes a flat 3 — together exactly the budget, at any scaling.
 *
 * THE BOOST IS THE HALF THAT MATTERS. The hash is a deterministic shuffle: it stops the
 * same videos pinning the top of every page, but it is blind to what the viewer has and
 * has not seen. The boost is the part that actively pushes UNFAMILIAR SUBJECTS forward,
 * and it is what §8.4's table means when it lists "exploration budget with a no-affinity
 * boost" against the filter-bubble row.
 */
const EXPLORATION_HASH_BUCKETS = 8;
const NO_AFFINITY_BOOST_SHARE = 3;
const EXPLORATION_TOTAL_SHARE = EXPLORATION_HASH_BUCKETS - 1 + NO_AFFINITY_BOOST_SHARE;

if (EXPLORATION_TOTAL_SHARE !== FEED_RANK_COMPONENT_BUDGETS.exploration) {
  throw new Error(
    `exploration split must sum to the budget ${String(FEED_RANK_COMPONENT_BUDGETS.exploration)}, got ${String(EXPLORATION_TOTAL_SHARE)}`,
  );
}

export interface FeedRankColumns {
  /** `videoStats.quality_score_points`. NULL until the nightly job has run. */
  readonly qualityPoints: SQL;
  /** `user_topic_affinity_snapshot.affinity_points`, already COALESCEd for cold start. */
  readonly topicAffinityPoints: SQL;
  readonly creatorAffinityPoints: SQL;
  readonly publishedAt: SQL;
  readonly videoId: SQL;
  /**
   * TRUE when the viewer has no measured affinity for ANY of this video's categories.
   *
   * Deliberately not derived from `topicAffinityPoints` being zero: that value has already
   * been COALESCEd through the cold-start popularity fallback, so a zero there means "we
   * substituted something", not "this subject is unfamiliar to them". The boost has to ask
   * the sharper question directly.
   */
  readonly hasNoTopicAffinity: SQL;
}

/**
 * Renders the §4.3 blended rank as one integer SQL expression.
 *
 * ## Why md5 and not `hashtext`
 *
 * `hashtextextended` is an undocumented Postgres internal whose output is not contracted
 * across versions. A ranking that silently reshuffles on a minor server upgrade is exactly
 * the irreproducibility Rule 2 forbids. `md5` is documented, stable, and available
 * everywhere.
 *
 * SEVEN hex characters, not eight: `bit(28)::int` is always non-negative, so there is no
 * `abs()` and no `INT_MIN` trap. `abs(-2147483648)` overflows in Postgres and raises.
 *
 * ## Why a seed at all
 *
 * `rankSeed` is minted per viewer per day (`rank-seed.ts`), echoed in the response, and
 * accepted back on the next page. That is what makes exploration DETERMINISTIC. Rule 2
 * forbids `Math.random()`, and it would be wrong here anyway: a random exploration term
 * reshuffles the feed between page 1 and page 2 and shows the same video twice.
 */
export function feedRankExpression(
  columns: FeedRankColumns,
  options: {
    readonly rankSeed: string;
    /** `FEED_RANK_COMPONENT_BUDGETS` or `NEW_TO_YOU_RANK_COMPONENT_BUDGETS`. */
    readonly budgets: typeof FEED_RANK_COMPONENT_BUDGETS | typeof NEW_TO_YOU_RANK_COMPONENT_BUDGETS;
  },
): SQL {
  const explorationBudget = options.budgets.exploration;
  assertNonNegativeIntegerInput("feedRankExpression", "explorationBudget", explorationBudget);

  // Integer division throughout: each stored score is 0..100 and is rescaled onto its
  // budget the same way the quality ramp rescales its ladders.
  const qualityTerm = sql`(COALESCE(${columns.qualityPoints}, 0) * ${options.budgets.videoQuality} / 100)`;
  const topicTerm = sql`(COALESCE(${columns.topicAffinityPoints}, 0) * ${options.budgets.topicAffinity} / 100)`;
  const creatorTerm = sql`(COALESCE(${columns.creatorAffinityPoints}, 0) * ${options.budgets.creatorAffinity} / 100)`;

  const hoursSincePublished = sql`(EXTRACT(EPOCH FROM (now() - ${columns.publishedAt})) / 3600)`;
  const recencyBranches = FEED_RECENCY_LADDER.map(
    (rung) => sql` WHEN ${hoursSincePublished} < ${rung.maxHours} THEN ${rung.points}`,
  );
  const recencyTerm = sql`(CASE${sql.join(recencyBranches, sql``)} ELSE 0 END)`;

  // Both halves scale with the budget, so raising exploration to 40 for `new_to_you`
  // widens the shuffle AND the boost together rather than only one of them.
  const explorationHashTerm = sql`(
    (('x' || substr(md5(${options.rankSeed} || ${columns.videoId}), 1, 7))::bit(28)::int
      % ${EXPLORATION_HASH_BUCKETS})
    * ${explorationBudget} / ${EXPLORATION_TOTAL_SHARE}
  )`;
  // Scaled HERE rather than in SQL. `THEN $a * $b / $c` is three untyped bind parameters
  // with no typed operand to infer from, and Postgres refuses to plan it — the arithmetic
  // is constant per request anyway, so it belongs in the module that owns the constants.
  // The remaining parameter is cast for the same reason: a bare `THEN $n` in a CASE has
  // nothing to take its type from either.
  const noAffinityBoostPoints = Math.floor(
    (NO_AFFINITY_BOOST_SHARE * explorationBudget) / EXPLORATION_TOTAL_SHARE,
  );
  const noAffinityBoostTerm = sql`(CASE WHEN ${columns.hasNoTopicAffinity}
    THEN ${noAffinityBoostPoints}::int ELSE 0 END)`;

  return sql`(${qualityTerm} + ${topicTerm} + ${creatorTerm} + ${recencyTerm}
    + ${explorationHashTerm} + ${noAffinityBoostTerm})`;
}

// ---------------------------------------------------------------------------
// §4.6 — the two pure post-rank passes
// ---------------------------------------------------------------------------

export interface RankedFeedRow {
  readonly videoId: string;
  readonly creatorId: string;
  readonly categorySlugs: readonly string[];
}

export interface DiversityCapOptions {
  /** The page size the caps are expressed against. */
  readonly pageSize: number;
  readonly maxRowsPerCreator: number;
  /** 4000 = 40%. Basis points, because a percentage of a page is not an integer. */
  readonly maxCategoryShareBasisPoints: number;
}

/**
 * §4.6's caps: at most 2 videos per creator and 40% per category on a page.
 *
 * ## ⚠️ THIS RETURNS A PERMUTATION, NOT A FILTER, AND THAT IS THE WHOLE DESIGN
 *
 * The obvious implementation drops the rows that breach a cap. It is wrong under offset
 * pagination, and wrong in a way that looks fine in a single-page test:
 *
 *   Ranked rows 0..11 are fetched for a 4-row page. The cap keeps ranks 0, 1, 4, 7 and
 *   drops the rest. Page 2 asks for offset 4 and gets ranks 4..7 — so rank 4 and rank 7
 *   are served TWICE and ranks 2, 3, 5, 6 are never served at all.
 *
 * Returning a permutation removes the failure entirely: every input row comes out exactly
 * once, so any window of the result is disjoint from any other window. Rows that breach a
 * cap are DEMOTED to the end in rank order rather than discarded — they are still the best
 * remaining videos, they just should not crowd the top of the first screen.
 *
 * PURE, INTEGER, NO I/O — the same discipline as `slice-math.ts`. It is a post-rank pass
 * rather than a `WHERE` clause because "at most two of these" is a property of the PAGE,
 * and SQL cannot see the page while it is building it.
 */
export function applyDiversityCaps<TRow extends RankedFeedRow>(
  rankedRows: readonly TRow[],
  options: DiversityCapOptions,
): readonly TRow[] {
  assertNonNegativeIntegerInput("applyDiversityCaps", "pageSize", options.pageSize);

  // FLOORED AT 1, and that floor is load-bearing. `floor(2 * 4000 / 10000)` is 0, and a
  // cap of zero per category is not a cap — it is a ban that demotes every categorized
  // video. On a small page the share cap simply cannot be expressed in whole rows, and one
  // row is the closest honest approximation of "at most 40% of two".
  const maximumRowsPerCategory = Math.max(
    1,
    Math.floor((options.pageSize * options.maxCategoryShareBasisPoints) / 10_000),
  );

  const promoted: TRow[] = [];
  const demoted: TRow[] = [];
  const rowsByCreator = new Map<string, number>();
  const rowsByCategory = new Map<string, number>();

  for (const row of rankedRows) {
    // The counters reset every `pageSize` promoted rows, so the caps are enforced PER
    // PAGE rather than across the whole ranking — otherwise a creator would be limited to
    // two videos in the entire feed, forever.
    if (promoted.length > 0 && promoted.length % options.pageSize === 0) {
      rowsByCreator.clear();
      rowsByCategory.clear();
    }

    const breachesCreatorCap =
      (rowsByCreator.get(row.creatorId) ?? 0) >= options.maxRowsPerCreator;
    // An untagged video is capped by nothing — it belongs to no category, so it cannot
    // crowd one out. That is a true statement, not a loophole.
    const breachesCategoryCap = row.categorySlugs.some(
      (slug) => (rowsByCategory.get(slug) ?? 0) >= maximumRowsPerCategory,
    );

    if (breachesCreatorCap || breachesCategoryCap) {
      demoted.push(row);
      continue;
    }

    promoted.push(row);
    rowsByCreator.set(row.creatorId, (rowsByCreator.get(row.creatorId) ?? 0) + 1);
    for (const slug of row.categorySlugs) {
      rowsByCategory.set(slug, (rowsByCategory.get(slug) ?? 0) + 1);
    }
  }

  return [...promoted, ...demoted];
}

/**
 * §4.4's exploration quota: the first page reserves slots for genuinely new videos.
 *
 * This is the Douyin traffic-pool idea in its simplest honest form. Without it, ranking is
 * a closed loop — the already-popular stay popular because popularity is an input to their
 * own score, and a first upload is invisible forever.
 *
 * ## ALSO A PERMUTATION, for the same reason `applyDiversityCaps` is
 *
 * It PROMOTES fresh rows already present in the sequence rather than injecting rows from
 * outside it. Injecting would put a video on page 1 that the raw ranking also places on
 * page 3, and the viewer would meet it twice.
 *
 * A fresh video ranked below the whole diversified prefix therefore does not get promoted.
 * In practice that does not happen: `freshnessFloor` and `recency` between them are worth
 * 20 of the feed's 100 points, so a video published in the last 72 hours is already near
 * the top. If it is not, it is being out-competed on every other axis at once, and hoisting
 * it over the prefix would be overriding the ranker rather than seeding it.
 */
export function reserveExplorationSlots<TRow extends RankedFeedRow>(
  rankedRows: readonly TRow[],
  freshVideoIds: ReadonlySet<string>,
  options: { readonly slotsPerPage: number },
): readonly TRow[] {
  assertNonNegativeIntegerInput("reserveExplorationSlots", "slotsPerPage", options.slotsPerPage);
  if (options.slotsPerPage === 0 || freshVideoIds.size === 0) return rankedRows;

  // Anything already inside the first page counts against the quota — the ranking may
  // well have surfaced a new video on its own, and this should not then hoist four more.
  const alreadyOnFirstPage = rankedRows
    .slice(0, options.slotsPerPage)
    .filter((row) => freshVideoIds.has(row.videoId)).length;
  const slotsToFill = options.slotsPerPage - alreadyOnFirstPage;
  if (slotsToFill <= 0) return rankedRows;

  const promoted: TRow[] = [];
  const remainder: TRow[] = [];
  for (const row of rankedRows) {
    if (
      promoted.length < slotsToFill &&
      freshVideoIds.has(row.videoId) &&
      !rankedRows.slice(0, options.slotsPerPage).includes(row)
    ) {
      promoted.push(row);
    } else {
      remainder.push(row);
    }
  }

  return [...promoted, ...remainder];
}
