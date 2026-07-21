/**
 * The Civic Pulse opportunity score: one 0..100 integer per problem cluster, recomputed by
 * the nightly `recompute-opportunity-scores` job and written into
 * `problem_cluster_score_snapshot` with the job's `asOf` instant
 * (R_AND_D_BACKEND_STRUCTURE.md §6, "Scores are server-computed, on a schedule").
 *
 * The score is a RANKING SIGNAL, and §6 is explicit that ranking signals are attack
 * surfaces: never client-supplied, never accepted in a body, never computed on read.
 * This module is the only place the number is allowed to come from.
 *
 * Why every component is a saturating integer STEP LADDER rather than a curve:
 *
 *   1. `exp(-ageInDays / halfLife)` is the obvious recency decay, and it is BANNED here.
 *      It is a float, and IEEE-754 does not require `Math.exp` to be correctly rounded —
 *      two Node builds, or Node and Postgres, may differ in the last bit. One differing
 *      bit on either side of a rounding boundary reorders two clusters, and §4c requires
 *      two runs over the same inputs to produce BIT-IDENTICAL integers. A ladder cannot
 *      drift: the only operations in this file are integer comparison and integer addition.
 *   2. The ladder's SHAPE is still exponential-ish — thresholds roughly double as you climb
 *      and the point gaps taper — so the ranking behaves the way a decay curve would. What
 *      changed is the COMPUTATION: it is a lookup, not a transcendental function.
 *   3. There is no division anywhere in this module, which is why nothing here reaches for
 *      `divRoundHalfAwayFromZero`. No division means no rounding rule, and no rounding rule
 *      means no way for TypeScript and SQL to disagree about a half.
 *
 * Every ladder SATURATES at both ends: it is capped by its component budget and it ends in
 * a terminal `0`, so each is TOTAL over its declared input domain. Totality is what turns
 * the 0..100 bound on the sum from a hope into a fact.
 *
 * That domain is the whole safe-integer line for four of the five inputs. The exception is
 * `linkedProjectCount`, whose domain is the NON-NEGATIVE safe integers: it is the only input
 * scanned by an `atMost` ladder whose top rung sits at 0, so a negative value would award
 * the component maximum instead of falling through. It is rejected rather than scored — see
 * `assertNonNegativeIntegerInput`.
 */

/**
 * How the 100 points are split across the five components.
 *
 * Exported because the weighting is a product decision that belongs in one auditable place
 * rather than smeared across five functions as magic numbers, and because the snapshot
 * table and the UI both need it to render "31 of 35" instead of a bare, unfalsifiable total.
 *
 * The sum is asserted at module load below, and each ladder's top rung is asserted to equal
 * its budget exactly — together those two checks are what make a 0..100 total mechanically
 * guaranteed rather than argued in a comment.
 */
export const OPPORTUNITY_SCORE_COMPONENT_BUDGETS = {
  distinctReporters: 35,
  geographicSpread: 20,
  categoryDemand: 15,
  recency: 20,
  linkedProjectScarcity: 10,
} as const;

/** The full-marks score. A cluster hitting the top rung of all five ladders lands here. */
const OPPORTUNITY_SCORE_MAXIMUM_POINTS = 100;

/**
 * One step of a ladder: a threshold and the points awarded to the first rung that matches.
 *
 * Deliberately not a formula. A rung is data, so a tuning change is a diff to a table that
 * the module-load checks re-validate, not an edit to arithmetic nobody re-derives.
 */
interface ScoreLadderRung {
  readonly threshold: number;
  readonly points: number;
}

/**
 * Which comparison a ladder is scanned with. The two directions are NOT interchangeable and
 * a ladder declared for one is silently wrong under the other, which is why every ladder
 * below is passed through `assertLadderIsWellFormed` with its direction at module load.
 */
type LadderDirection = "atLeastThreshold" | "atMostThreshold";

/**
 * Validates a ladder's shape once, at module load.
 *
 * The trap this exists to catch: rungs are scanned in declaration order and the FIRST match
 * wins, so an "at least" ladder declared lowest-threshold-first would match its bottom rung
 * for every input above zero. That is a total-loss scoring bug that produces plausible small
 * numbers, no exception, and no type error — the ranking would simply be wrong forever.
 *
 * Checking `topRung.points === componentBudget` is the other half of the 0..100 guarantee:
 * it pins each ladder's ceiling to the budget table, so the five budgets summing to 100 is
 * enough to prove the total can never exceed 100.
 *
 * @throws if the ladder is empty, has a non-integer or non-positive rung, is not strictly
 *         ordered in both threshold and points, or does not top out at its budget. All are
 *         unrecoverable programmer errors (CLAUDE.md §3.3) and all fire at import time,
 *         where a broken table cannot reach a single request.
 */
function assertLadderIsWellFormed(
  ladderName: string,
  ladder: readonly ScoreLadderRung[],
  direction: LadderDirection,
  componentBudget: number,
): void {
  const topRung = ladder.at(0);
  if (topRung === undefined) {
    throw new Error(`${ladderName}: ladder must have at least one rung`);
  }
  if (topRung.points !== componentBudget) {
    throw new Error(
      `${ladderName}: top rung awards ${topRung.points} but the component budget is ${componentBudget}`,
    );
  }

  for (const rung of ladder) {
    if (!Number.isSafeInteger(rung.threshold) || !Number.isSafeInteger(rung.points)) {
      throw new Error(
        `${ladderName}: rung {threshold: ${rung.threshold}, points: ${rung.points}} must be integral — no floats (§4c)`,
      );
    }
    if (rung.points <= 0) {
      throw new Error(
        `${ladderName}: rung at threshold ${rung.threshold} awards ${rung.points}; the only zero is the terminal fall-through`,
      );
    }
  }

  let previousRung = topRung;
  for (const currentRung of ladder.slice(1)) {
    const thresholdsAreOrdered =
      direction === "atLeastThreshold"
        ? currentRung.threshold < previousRung.threshold
        : currentRung.threshold > previousRung.threshold;
    if (!thresholdsAreOrdered) {
      throw new Error(
        `${ladderName}: thresholds must be strictly ordered for a ${direction} scan, but ${previousRung.threshold} is followed by ${currentRung.threshold}`,
      );
    }
    if (currentRung.points >= previousRung.points) {
      throw new Error(
        `${ladderName}: points must strictly decrease down the ladder, but ${previousRung.points} is followed by ${currentRung.points}`,
      );
    }
    previousRung = currentRung;
  }
}

/**
 * Scans a descending-threshold ladder and returns the first rung the value reaches.
 *
 * The `return 0` is not a fallback — it IS the terminal rung, and it is what makes the
 * function total: every value below the lowest threshold, including a negative one, scores
 * nothing rather than escaping the ladder's bound.
 */
function pointsForAtLeastLadder(ladder: readonly ScoreLadderRung[], measuredValue: number): number {
  for (const rung of ladder) {
    if (measuredValue >= rung.threshold) {
      return rung.points;
    }
  }
  return 0;
}

/**
 * Scans an ascending-threshold ladder and returns the first rung the value fits under.
 *
 * The mirror image of `pointsForAtLeastLadder`, for the components where SMALL is good
 * (a fresh report, an unsolved problem). Same terminal `0`, same totality guarantee.
 */
function pointsForAtMostLadder(ladder: readonly ScoreLadderRung[], measuredValue: number): number {
  for (const rung of ladder) {
    if (measuredValue <= rung.threshold) {
      return rung.points;
    }
  }
  return 0;
}

/**
 * Rejects any input that is not a safe integer.
 *
 * NaN is the specific hazard. Every comparison against NaN is false, so a NaN input would
 * fall through every rung of every ladder to the terminal `0` and be indistinguishable from
 * a legitimately dead cluster — a wrong score with no exception and no log line. A count
 * that arrived as NaN, Infinity, or `20.5` means the caller's SQL or date arithmetic is
 * broken upstream, which is exactly the physically-impossible-invariant case where
 * CLAUDE.md §3.3 permits a throw. It also enforces the module's float ban at the boundary.
 *
 * @throws if `measuredValue` is NaN, infinite, fractional, or beyond `Number.MAX_SAFE_INTEGER`.
 */
function assertSafeIntegerInput(
  functionName: string,
  parameterName: string,
  measuredValue: number,
): void {
  if (!Number.isSafeInteger(measuredValue)) {
    throw new Error(
      `${functionName}: ${parameterName} must be a safe integer, got ${measuredValue}`,
    );
  }
}

/**
 * Rejects any input that is not a NON-NEGATIVE safe integer.
 *
 * The stricter guard, for the one input where a negative value would FAIL OPEN.
 *
 * The three "at least" ladders are total over the whole integer line and the spec gives them
 * an explicit `else 0`, so a negative count there is already defined and already fails closed
 * — it scores nothing. `ageInDays` genuinely goes negative (clock skew, backfills) and is
 * deliberately clamped rather than rejected. `linkedProjectCount` is neither: the spec
 * enumerates 0 -> 10, 1 -> 6, 2 -> 3, >=3 -> 0 with NO `else` clause, so a negative count has
 * no spec'd value at all, and the `atMost` scan would read it as `<= 0` and award the full
 * 10-point scarcity budget. That is the only place in the module where nonsense INFLATES the
 * score, on a number §6 calls a ranking attack surface.
 *
 * A `COUNT(*)` cannot be negative, so reaching here means the caller's SQL is broken — the
 * physically-impossible invariant CLAUDE.md §3.3 licenses a throw for. Failing the batch
 * loudly beats silently promoting a cluster nobody is building against but that also has no
 * evidence behind it. This matches `projectScarcityPoints` in the sibling `demand-score.ts`,
 * which rejects a negative count for exactly this reason.
 *
 * @throws if `measuredValue` is negative, NaN, infinite, fractional, or beyond
 *         `Number.MAX_SAFE_INTEGER`.
 */
function assertNonNegativeIntegerInput(
  functionName: string,
  parameterName: string,
  measuredValue: number,
): void {
  if (!Number.isSafeInteger(measuredValue) || measuredValue < 0) {
    throw new Error(
      `${functionName}: ${parameterName} must be a non-negative safe integer, got ${measuredValue}`,
    );
  }
}

const DISTINCT_REPORTER_LADDER: readonly ScoreLadderRung[] = [
  { threshold: 500, points: 35 },
  { threshold: 250, points: 31 },
  { threshold: 100, points: 27 },
  { threshold: 50, points: 23 },
  { threshold: 25, points: 19 },
  { threshold: 10, points: 14 },
  { threshold: 5, points: 9 },
  { threshold: 2, points: 5 },
  { threshold: 1, points: 2 },
];

const GEOGRAPHIC_SPREAD_LADDER: readonly ScoreLadderRung[] = [
  { threshold: 10, points: 20 },
  { threshold: 6, points: 16 },
  { threshold: 4, points: 12 },
  { threshold: 3, points: 9 },
  { threshold: 2, points: 5 },
  { threshold: 1, points: 2 },
];

const CATEGORY_DEMAND_LADDER: readonly ScoreLadderRung[] = [
  { threshold: 2000, points: 15 },
  { threshold: 1000, points: 12 },
  { threshold: 500, points: 9 },
  { threshold: 200, points: 6 },
  { threshold: 50, points: 3 },
];

const RECENCY_LADDER: readonly ScoreLadderRung[] = [
  { threshold: 7, points: 20 },
  { threshold: 14, points: 17 },
  { threshold: 30, points: 14 },
  { threshold: 60, points: 11 },
  { threshold: 90, points: 8 },
  { threshold: 180, points: 5 },
  { threshold: 365, points: 2 },
];

const LINKED_PROJECT_SCARCITY_LADDER: readonly ScoreLadderRung[] = [
  { threshold: 0, points: 10 },
  { threshold: 1, points: 6 },
  { threshold: 2, points: 3 },
];

assertLadderIsWellFormed(
  "DISTINCT_REPORTER_LADDER",
  DISTINCT_REPORTER_LADDER,
  "atLeastThreshold",
  OPPORTUNITY_SCORE_COMPONENT_BUDGETS.distinctReporters,
);
assertLadderIsWellFormed(
  "GEOGRAPHIC_SPREAD_LADDER",
  GEOGRAPHIC_SPREAD_LADDER,
  "atLeastThreshold",
  OPPORTUNITY_SCORE_COMPONENT_BUDGETS.geographicSpread,
);
assertLadderIsWellFormed(
  "CATEGORY_DEMAND_LADDER",
  CATEGORY_DEMAND_LADDER,
  "atLeastThreshold",
  OPPORTUNITY_SCORE_COMPONENT_BUDGETS.categoryDemand,
);
assertLadderIsWellFormed(
  "RECENCY_LADDER",
  RECENCY_LADDER,
  "atMostThreshold",
  OPPORTUNITY_SCORE_COMPONENT_BUDGETS.recency,
);
assertLadderIsWellFormed(
  "LINKED_PROJECT_SCARCITY_LADDER",
  LINKED_PROJECT_SCARCITY_LADDER,
  "atMostThreshold",
  OPPORTUNITY_SCORE_COMPONENT_BUDGETS.linkedProjectScarcity,
);

// Asserted at module load rather than only in a test: a test can be skipped or deleted, and
// a budget table that sums to 99 would not fail anything — it would quietly make a perfect
// score unreachable and shift every cluster's rank. This can only fire if someone edits the
// table above, which is precisely when it should fire.
const componentBudgetSum = Object.values(OPPORTUNITY_SCORE_COMPONENT_BUDGETS).reduce(
  (runningSum, componentBudget) => runningSum + componentBudget,
  0,
);
if (componentBudgetSum !== OPPORTUNITY_SCORE_MAXIMUM_POINTS) {
  throw new Error(
    `OPPORTUNITY_SCORE_COMPONENT_BUDGETS must sum to ${OPPORTUNITY_SCORE_MAXIMUM_POINTS}, got ${componentBudgetSum}`,
  );
}

/**
 * Points for the number of DISTINCT people who reported this problem — the heaviest
 * component at 35, and the one §6 names as the sybil surface.
 *
 * The count must already have been narrowed to `DISTINCT reporterUserId` over
 * `requireIdentifiedUser` submissions before it gets here. This function cannot tell a real
 * crisis from one person with 342 anonymous identities; it only converts a count to points.
 * Guarding the count is the caller's job and it is the entire integrity of the score.
 *
 * The rungs taper (a jump from 1 to 2 reporters is worth 3 points, from 250 to 500 only 4)
 * so that early corroboration matters most and a brigading campaign hits saturation fast.
 *
 * @throws if `distinctReporterCount` is not a safe integer — see `assertSafeIntegerInput`.
 */
export function distinctReporterPoints(distinctReporterCount: number): number {
  assertSafeIntegerInput("distinctReporterPoints", "distinctReporterCount", distinctReporterCount);
  return pointsForAtLeastLadder(DISTINCT_REPORTER_LADDER, distinctReporterCount);
}

/**
 * Points for how many distinct regions the reports came from — the check on a problem that
 * is loud in one neighbourhood versus one that is structural across a country.
 *
 * The region is derived from server-side geocoding, never from a client-claimed country
 * (§6). A user-supplied country code here would let one reporter buy 20 points outright.
 *
 * @throws if `distinctRegionCount` is not a safe integer — see `assertSafeIntegerInput`.
 */
export function geographicSpreadPoints(distinctRegionCount: number): number {
  assertSafeIntegerInput("geographicSpreadPoints", "distinctRegionCount", distinctRegionCount);
  return pointsForAtLeastLadder(GEOGRAPHIC_SPREAD_LADDER, distinctRegionCount);
}

/**
 * Points for this cluster's category as a share of all demand, in BASIS POINTS.
 *
 * Basis points, not a percentage float: a share is a ratio, and §4c bans ratios reaching
 * the domain as floats. Compute it with `basisPointsOf` from `#src/lib/money.js` so the
 * rounding matches Postgres. 2000bp (20% of all demand) is the saturation point — beyond
 * that a category is already obviously hot and extra weight only crowds the map.
 *
 * @throws if `categoryShareBasisPoints` is not a safe integer — see `assertSafeIntegerInput`.
 */
export function categoryDemandPoints(categoryShareBasisPoints: number): number {
  assertSafeIntegerInput(
    "categoryDemandPoints",
    "categoryShareBasisPoints",
    categoryShareBasisPoints,
  );
  return pointsForAtLeastLadder(CATEGORY_DEMAND_LADDER, categoryShareBasisPoints);
}

/**
 * Points for how stale the cluster's most recent report is. This ladder READS BACKWARDS
 * relative to the three above: it is scanned lowest-threshold-first and each rung is an
 * "at most" bound, because here a SMALL number is the good one.
 *
 * This is the component §6 singles out. `exp(-ageInDays / halfLife)` is the textbook decay
 * and it is a float; these seven buckets are the quantization §6 demands, applied once at
 * the boundary. The rung widths double (7, 14, 30, 60, 90, 180, 365) so the curve still
 * feels exponential while the arithmetic stays exact.
 *
 * NEGATIVE `ageInDays` — a `lastReportedAt` in the future — is CLAMPED to the top rung
 * rather than thrown. Clamping beats throwing here for three reasons. It is not
 * physically impossible, so §3.3 does not license a throw: modest clock skew between the
 * app server and Postgres, or a backfill that stamped rows from an upstream feed, produces
 * it routinely. A throw would abort the nightly batch and leave EVERY cluster unscored to
 * punish one bad row, which is a far worse outcome than scoring that row as maximally
 * fresh. And "reported at or after now" genuinely is the freshest a report can be, so the
 * top rung is the honest answer, not a fudge. Clamping also keeps the ladder non-increasing
 * across the whole integer line, which the ranking depends on.
 *
 * @throws if `ageInDays` is not a safe integer — see `assertSafeIntegerInput`. Note that a
 *         negative integer is clamped, not thrown; a fractional age is thrown, because it
 *         means the caller divided milliseconds by 86_400_000 and produced a float.
 */
export function recencyBucketPoints(ageInDays: number): number {
  assertSafeIntegerInput("recencyBucketPoints", "ageInDays", ageInDays);
  const clampedAgeInDays = ageInDays < 0 ? 0 : ageInDays;
  return pointsForAtMostLadder(RECENCY_LADDER, clampedAgeInDays);
}

/**
 * Points for how FEW projects are already tackling this problem. The one INVERTED ladder in
 * the module: more linked projects means FEWER points.
 *
 * It reads backwards on purpose. The Opportunity Map exists to surface unsolved problems,
 * so a problem three teams are already building against is, to a fourth founder, worth less
 * attention than an identical problem nobody has touched. Scarcity is the signal; solved
 * problems should sink down the map on their own rather than needing a moderator.
 *
 * Zero-based rather than thresholded upward, so read the rungs as: 0 projects → 10, 1 → 6,
 * 2 → 3, 3 or more → 0. It saturates immediately at 3 because the difference between three
 * teams and thirty is not interesting; both mean "taken".
 *
 * A negative count is REJECTED rather than scored. It comes from a `COUNT(*)` and cannot be
 * negative, and the `atMost` scan would otherwise read it as `<= 0` and award the full
 * 10-point budget — the one input in this module where nonsense would inflate rather than
 * deflate the score. See `assertNonNegativeIntegerInput` for why this input alone gets the
 * stricter guard while `ageInDays` is clamped and the three "at least" ladders fall to 0.
 *
 * @throws if `linkedProjectCount` is not a non-negative safe integer — see
 *         `assertNonNegativeIntegerInput`.
 */
export function linkedProjectScarcityPoints(linkedProjectCount: number): number {
  assertNonNegativeIntegerInput(
    "linkedProjectScarcityPoints",
    "linkedProjectCount",
    linkedProjectCount,
  );
  return pointsForAtMostLadder(LINKED_PROJECT_SCARCITY_LADDER, linkedProjectCount);
}

/**
 * Everything the nightly job must gather before a cluster can be scored.
 *
 * All five are server-derived aggregates. None of them may be read from a request body —
 * §6 is unambiguous that the score's inputs are as sensitive as the score itself.
 */
export interface OpportunityScoreInputs {
  readonly distinctReporterCount: number;
  readonly distinctRegionCount: number;
  readonly categoryShareBasisPoints: number;
  readonly ageInDays: number;
  readonly linkedProjectCount: number;
}

/**
 * The total plus every subscore that produced it.
 *
 * The breakdown is returned rather than just the total because a score you cannot explain is
 * indistinguishable from a bug. `problem_cluster_score_snapshot` stores all six columns, so
 * a cluster that ranked oddly last Tuesday can be reconstructed from the row instead of
 * re-litigated against a number nobody can decompose — and a founder who asks "why is my
 * problem ranked 40th" gets an answer instead of a shrug.
 */
export interface OpportunityScoreBreakdown {
  readonly totalPoints: number;
  readonly distinctReporterPoints: number;
  readonly geographicSpreadPoints: number;
  readonly categoryDemandPoints: number;
  readonly recencyPoints: number;
  readonly linkedProjectScarcityPoints: number;
}

/**
 * Computes the 0..100 opportunity score and every subscore behind it.
 *
 * Pure and total: the same inputs produce the same six integers on any machine, on any run,
 * forever. That is the whole point of §4c and the reason nothing in this file divides.
 *
 * The 0..100 assertion below cannot fire. Every ladder is total (each ends in a terminal 0)
 * and capped at its budget (asserted at module load), and the budgets sum to 100 (also
 * asserted at module load) — so the sum is structurally bounded. It is asserted anyway, in
 * the same spirit as `apportionLargestRemainder` checking that its parts sum to the total:
 * this is the module's strongest correctness claim, the check costs two comparisons, and an
 * out-of-range score silently written into a snapshot row would be discovered by a confused
 * user rather than by the code.
 *
 * @throws if any input is not a safe integer (see `assertSafeIntegerInput`), if
 *         `linkedProjectCount` is negative (see `assertNonNegativeIntegerInput`), or if the
 *         total somehow lands outside 0..100 — an unrecoverable invariant violation
 *         (CLAUDE.md §3.3).
 */
export function computeOpportunityScorePoints(
  inputs: OpportunityScoreInputs,
): OpportunityScoreBreakdown {
  const distinctReporterComponentPoints = distinctReporterPoints(inputs.distinctReporterCount);
  const geographicSpreadComponentPoints = geographicSpreadPoints(inputs.distinctRegionCount);
  const categoryDemandComponentPoints = categoryDemandPoints(inputs.categoryShareBasisPoints);
  const recencyComponentPoints = recencyBucketPoints(inputs.ageInDays);
  const linkedProjectScarcityComponentPoints = linkedProjectScarcityPoints(
    inputs.linkedProjectCount,
  );

  const totalPoints =
    distinctReporterComponentPoints +
    geographicSpreadComponentPoints +
    categoryDemandComponentPoints +
    recencyComponentPoints +
    linkedProjectScarcityComponentPoints;

  if (totalPoints < 0 || totalPoints > OPPORTUNITY_SCORE_MAXIMUM_POINTS) {
    throw new Error(
      `computeOpportunityScorePoints: invariant violated — total ${totalPoints} is outside 0..${OPPORTUNITY_SCORE_MAXIMUM_POINTS}`,
    );
  }

  return {
    totalPoints,
    distinctReporterPoints: distinctReporterComponentPoints,
    geographicSpreadPoints: geographicSpreadComponentPoints,
    categoryDemandPoints: categoryDemandComponentPoints,
    recencyPoints: recencyComponentPoints,
    linkedProjectScarcityPoints: linkedProjectScarcityComponentPoints,
  };
}
