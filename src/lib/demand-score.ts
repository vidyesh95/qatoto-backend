/**
 * The knowledge-hub demand leaderboard score: one 0..100 integer per (region, category)
 * cell, recomputed by the nightly `recompute-demand-signals` job and written into
 * `demand_signal_snapshot` with its `rank` and the job's `asOf` instant
 * (R_AND_D_BACKEND_STRUCTURE.md §6). This is what backs the frontend's `TrendingSignal`.
 *
 * The score is a RANKING SIGNAL, and §6 is explicit that ranking signals are attack
 * surfaces: never client-supplied, never accepted in a body, never computed on read. This
 * module is the only place the number is allowed to come from.
 *
 * The ladder machinery here is a deliberate mirror of `#src/lib/opportunity-score.js` —
 * same rung shape, same two scan directions, same module-load well-formedness assertions,
 * same terminal-zero totality argument. The two modules score overlapping evidence for two
 * different surfaces (the Opportunity Map and the Knowledge Hub). If they saturated or
 * ordered rungs differently, the same reporters could rank a subject one way on the map and
 * another in the hub, and no local cleverness is worth that contradiction. Read that module
 * first; the reasoning for the step-ladder-over-curve decision is stated there in full and
 * is not repeated here.
 *
 * The one deliberate divergence: every input to this module is a `COUNT(*)`, so there is no
 * legitimately signed quantity here the way `ageInDays` is signed there. Negative inputs are
 * therefore REJECTED rather than tolerated — see `assertNonNegativeIntegerInput`.
 *
 * No division happens anywhere in this file, which is why nothing reaches for
 * `divRoundHalfAwayFromZero`. No division means no rounding rule, and no rounding rule means
 * no way for TypeScript and SQL to disagree about a half (§4c).
 */

/**
 * How the 100 points are split across the four components.
 *
 * Exported because the weighting is a product decision that belongs in one auditable place
 * rather than smeared across four functions as magic numbers, and because the snapshot table
 * and the UI both need it to render "31 of 40" instead of a bare, unfalsifiable total.
 *
 * The split is the editorial claim the module makes about what "demand" means. Distinct
 * people carry the most weight (40) because a headcount of real humans is the hardest input
 * to fake and the only one that means a market exists. Cluster volume (25) and open roles
 * (20) are corroborating evidence — a single motivated org can inflate either, so neither
 * may carry a cell alone. Scarcity (15) is deliberately smallest: it modifies real demand,
 * it is not evidence of demand.
 *
 * The sum is asserted at module load below, and each ladder's top rung is asserted to equal
 * its budget exactly — together those two checks make a 0..100 total mechanically guaranteed
 * rather than argued in a comment.
 */
export const DEMAND_SCORE_COMPONENT_BUDGETS = {
  distinctReporters: 40,
  clusterVolume: 25,
  openRoleDemand: 20,
  projectScarcity: 15,
} as const;

/** The full-marks score. A cell hitting the top rung of all four ladders lands here. */
const DEMAND_SCORE_MAXIMUM_POINTS = 100;

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
 * numbers, no exception, and no type error — the leaderboard would simply be wrong forever.
 *
 * Checking `topRung.points === componentBudget` is the other half of the 0..100 guarantee:
 * it pins each ladder's ceiling to the budget table, so the four budgets summing to 100 is
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
 * function total: every value below the lowest threshold scores nothing rather than escaping
 * the ladder's bound.
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
 * The mirror image of `pointsForAtLeastLadder`, for the component where SMALL is good (a
 * subject nobody is building against yet). Same terminal `0`, same totality guarantee.
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
 * Rejects any input that is not a NON-NEGATIVE safe integer.
 *
 * Stricter than `opportunity-score.ts`'s `assertSafeIntegerInput`, and the strictness is the
 * point. That module must tolerate a negative `ageInDays`, because clock skew and backfills
 * produce future timestamps routinely; it pays for that tolerance by having to document, in
 * `linkedProjectScarcityPoints`, that a negative count would silently read as maximal
 * scarcity and INFLATE the score. Every input to this module is a `COUNT(*)`, so a negative
 * one is not a tolerable edge case — it means the caller's SQL is broken upstream, which is
 * the physically-impossible-invariant case where CLAUDE.md §3.3 licenses a throw. Rejecting
 * it here closes the inflation hole by construction rather than by comment.
 *
 * NaN is the other specific hazard, and the reason a bare `< 0` test is not enough. Every
 * comparison against NaN is false, so a NaN input would fall through every rung of an "at
 * least" ladder to the terminal `0` and be indistinguishable from a legitimately dead cell —
 * a wrong score with no exception and no log line. `Number.isSafeInteger` rejects NaN,
 * Infinity, and fractions in one check, which also enforces the module's float ban at the
 * boundary.
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

/**
 * Rejects anything that is not an integer demand score in the closed range 0..100.
 *
 * The ladder inputs are counts and are checked by `assertNonNegativeIntegerInput`; this is
 * the check for the other direction — a value claiming to BE a score already. It exists for
 * `deriveTrendDirection`, which was the one export in this module that validated nothing.
 *
 * NaN is the hazard, and it is the same one documented above, arriving from the opposite
 * side. Every comparison against NaN is false, so `current > previous` and `current <
 * previous` are BOTH false and the function fell through to its final `return "flat"`. A cell
 * whose stored previous score came back as NaN rendered as "unchanged" — no exception, no log
 * line, the trend silently gone rather than the batch failing loudly. That is reachable
 * rather than theoretical: unlike the counts, `previousScorePoints` is read back out of the
 * `demand_signal_snapshot` column rather than produced in this process, and a Postgres
 * `numeric` genuinely admits the value NaN, which is exactly the value-domain mismatch the
 * header comment warns about.
 *
 * The 0..100 bound is checked as well as integrality, which makes this a partial guard on the
 * function's untyped `number` signature: a caller who passes a raw reporter COUNT where that
 * cell's POINTS belong is caught whenever the count exceeds 100 — precisely the case where
 * the mistake would flip the arrow. It cannot catch a swap of two in-range scores; only a
 * branded score type could, and that would diverge from the specified signature.
 *
 * @throws if `scorePoints` is NaN, infinite, fractional, negative, or above 100 — all
 *         unrecoverable upstream faults (CLAUDE.md §3.3), none of them survivable by guessing.
 */
function assertDemandScorePointsInput(parameterName: string, scorePoints: number): void {
  if (
    !Number.isSafeInteger(scorePoints) ||
    scorePoints < 0 ||
    scorePoints > DEMAND_SCORE_MAXIMUM_POINTS
  ) {
    throw new Error(
      `deriveTrendDirection: ${parameterName} must be an integer demand score in 0..${DEMAND_SCORE_MAXIMUM_POINTS}, got ${scorePoints}`,
    );
  }
}

const DISTINCT_REPORTER_LADDER: readonly ScoreLadderRung[] = [
  { threshold: 250, points: 40 },
  { threshold: 100, points: 37 },
  { threshold: 50, points: 33 },
  { threshold: 25, points: 27 },
  { threshold: 10, points: 20 },
  { threshold: 5, points: 14 },
  { threshold: 2, points: 8 },
  { threshold: 1, points: 4 },
];

const CLUSTER_VOLUME_LADDER: readonly ScoreLadderRung[] = [
  { threshold: 100, points: 25 },
  { threshold: 50, points: 22 },
  { threshold: 25, points: 19 },
  { threshold: 12, points: 15 },
  { threshold: 6, points: 11 },
  { threshold: 3, points: 7 },
  { threshold: 1, points: 3 },
];

const OPEN_ROLE_DEMAND_LADDER: readonly ScoreLadderRung[] = [
  { threshold: 50, points: 20 },
  { threshold: 25, points: 17 },
  { threshold: 12, points: 14 },
  { threshold: 6, points: 10 },
  { threshold: 3, points: 6 },
  { threshold: 1, points: 3 },
];

const PROJECT_SCARCITY_LADDER: readonly ScoreLadderRung[] = [
  { threshold: 0, points: 15 },
  { threshold: 1, points: 12 },
  { threshold: 2, points: 10 },
  { threshold: 4, points: 7 },
  { threshold: 8, points: 4 },
  { threshold: 16, points: 2 },
];

assertLadderIsWellFormed(
  "DISTINCT_REPORTER_LADDER",
  DISTINCT_REPORTER_LADDER,
  "atLeastThreshold",
  DEMAND_SCORE_COMPONENT_BUDGETS.distinctReporters,
);
assertLadderIsWellFormed(
  "CLUSTER_VOLUME_LADDER",
  CLUSTER_VOLUME_LADDER,
  "atLeastThreshold",
  DEMAND_SCORE_COMPONENT_BUDGETS.clusterVolume,
);
assertLadderIsWellFormed(
  "OPEN_ROLE_DEMAND_LADDER",
  OPEN_ROLE_DEMAND_LADDER,
  "atLeastThreshold",
  DEMAND_SCORE_COMPONENT_BUDGETS.openRoleDemand,
);
assertLadderIsWellFormed(
  "PROJECT_SCARCITY_LADDER",
  PROJECT_SCARCITY_LADDER,
  "atMostThreshold",
  DEMAND_SCORE_COMPONENT_BUDGETS.projectScarcity,
);

// Asserted at module load rather than only in a test: a test can be skipped or deleted, and
// a budget table that sums to 99 would not fail anything — it would quietly make a perfect
// score unreachable and shift every cell's rank. This can only fire if someone edits the
// table above, which is precisely when it should fire.
const componentBudgetSum = Object.values(DEMAND_SCORE_COMPONENT_BUDGETS).reduce(
  (runningSum, componentBudget) => runningSum + componentBudget,
  0,
);
if (componentBudgetSum !== DEMAND_SCORE_MAXIMUM_POINTS) {
  throw new Error(
    `DEMAND_SCORE_COMPONENT_BUDGETS must sum to ${DEMAND_SCORE_MAXIMUM_POINTS}, got ${componentBudgetSum}`,
  );
}

/**
 * Points for the number of DISTINCT people who reported into this cell — the heaviest
 * component at 40, and the same sybil surface §6 names for the opportunity score.
 *
 * The count must already have been narrowed to `DISTINCT reporterUserId` over
 * `requireIdentifiedUser` submissions before it gets here. This function cannot tell a real
 * market from one person with 342 anonymous identities; it only converts a count to points.
 * With Better Auth's `anonymous()` plugin live and unguarded, guarding the count is the
 * caller's job and it is the entire integrity of the leaderboard.
 *
 * Bottom rung: 1 reporter is worth 4 of 40, not 0. Scoring the first reporter as nothing
 * would make a genuinely new signal unrankable, so it never accumulates a second — but 4/40
 * keeps a party of one far below anything resembling a market.
 *
 * Top rung: 250 distinct people. The rungs taper (1→2 reporters is worth 4 points, 100→250
 * only 3) so early corroboration matters most and a brigading campaign saturates fast.
 *
 * @throws if `distinctReporterCount` is not a non-negative safe integer — see
 *         `assertNonNegativeIntegerInput`.
 */
export function distinctReporterPoints(distinctReporterCount: number): number {
  assertNonNegativeIntegerInput(
    "distinctReporterPoints",
    "distinctReporterCount",
    distinctReporterCount,
  );
  return pointsForAtLeastLadder(DISTINCT_REPORTER_LADDER, distinctReporterCount);
}

/**
 * Points for how many distinct problem CLUSTERS sit in this cell — the breadth check.
 *
 * Counts clusters, never `problem_submission` rows. A cluster is the deduplicated public
 * entity (§6); counting submissions here would re-count the same people already scored by
 * `distinctReporterPoints` and let one crowd earn 65 points on one body of evidence.
 *
 * Bottom rung: 1 cluster is worth 3 of 25. A single distinct problem is a real observation
 * but says nothing about the breadth of the category, which is what this component measures.
 *
 * Top rung: 100 distinct deduplicated problems in one (region, category) cell, which is a
 * systemic failure of that category in that region — exactly what the hub exists to surface.
 *
 * @throws if `clusterCount` is not a non-negative safe integer.
 */
export function clusterVolumePoints(clusterCount: number): number {
  assertNonNegativeIntegerInput("clusterVolumePoints", "clusterCount", clusterCount);
  return pointsForAtLeastLadder(CLUSTER_VOLUME_LADDER, clusterCount);
}

/**
 * Points for unfilled open roles pointing at this cell — the supply-side tell that teams are
 * already trying to build here and cannot staff it.
 *
 * Weighted below reporters and clusters because it is the easiest of the three to inflate:
 * one org posting twenty roles is one org, not twenty signals.
 *
 * Bottom rung: 1 open role is worth 3 of 20 — one unfilled seat is ordinary hiring, not a
 * talent gap.
 *
 * Top rung: 50 concurrently unfilled roles, which in this domain means the category is
 * bottlenecked on people rather than on ideas or money.
 *
 * @throws if `openRoleCount` is not a non-negative safe integer.
 */
export function openRoleDemandPoints(openRoleCount: number): number {
  assertNonNegativeIntegerInput("openRoleDemandPoints", "openRoleCount", openRoleCount);
  return pointsForAtLeastLadder(OPEN_ROLE_DEMAND_LADDER, openRoleCount);
}

/**
 * Points for how FEW projects are already building against this cell. The one INVERTED
 * ladder in the module: more related projects means FEWER points.
 *
 * It reads backwards on purpose, exactly as `linkedProjectScarcityPoints` does in
 * `opportunity-score.ts`. Demand nobody is serving is the demand worth surfacing. A category
 * with a hundred reporters and forty teams already shipping is a solved problem wearing the
 * costume of an opportunity, and ranking it highly would point the platform's founders at
 * the most crowded market on the board.
 *
 * Top rung (best): 0 related projects earns the full 15 — nobody is building this.
 *
 * Bottom rung (worst): 17 or more projects earns 0 via the terminal fall-through. Zero, not
 * a negative number: this component withholds a bonus, it does not levy a penalty. Letting
 * it go negative would let a crowded category claw points back from genuine reporter
 * evidence, which would make the 40-point budget above a lie.
 *
 * @throws if `relatedProjectCount` is not a non-negative safe integer. Unlike its counterpart
 *         in `opportunity-score.ts`, a negative count is REJECTED here rather than read as
 *         maximal scarcity — that is the one input in a scarcity ladder where nonsense
 *         inflates rather than deflates the score.
 */
export function projectScarcityPoints(relatedProjectCount: number): number {
  assertNonNegativeIntegerInput(
    "projectScarcityPoints",
    "relatedProjectCount",
    relatedProjectCount,
  );
  return pointsForAtMostLadder(PROJECT_SCARCITY_LADDER, relatedProjectCount);
}

/**
 * Everything the nightly job must gather before a (region, category) cell can be scored.
 *
 * All four are server-derived `COUNT(*)` aggregates. None may be read from a request body —
 * §6 is unambiguous that a score's inputs are as sensitive as the score itself. SQL does the
 * counting and TypeScript does the scoring (§4c rule 3): a `numeric` in Postgres and a
 * `number` in Node are not the same value domain, so no scoring arithmetic happens in SQL.
 */
export interface DemandScoreInputs {
  readonly distinctReporterCount: number;
  readonly clusterCount: number;
  readonly openRoleCount: number;
  readonly relatedProjectCount: number;
}

/**
 * The total plus every subscore that produced it.
 *
 * The breakdown is returned rather than just the total because a score you cannot explain is
 * indistinguishable from a bug. `demand_signal_snapshot` stores all five columns, so a cell
 * that ranked oddly last Tuesday can be reconstructed from the row instead of re-litigated
 * against a number nobody can decompose.
 */
export interface DemandScoreBreakdown {
  readonly totalPoints: number;
  readonly distinctReporterPoints: number;
  readonly clusterVolumePoints: number;
  readonly openRoleDemandPoints: number;
  readonly projectScarcityPoints: number;
}

/**
 * Computes the 0..100 demand score and every subscore behind it.
 *
 * Pure and total: the same inputs produce the same five integers on any machine, on any run,
 * forever. That is the whole point of §4c and the reason nothing in this file divides.
 *
 * A KNOWN PROPERTY the caller must handle: a completely empty cell — no reporters, no
 * clusters, no roles, no projects — scores 15, because the inverted scarcity component pays
 * out in full when nothing is being built. That is correct per-component and meaningless
 * per-cell: it is the score of a category nobody has ever mentioned. The leaderboard query
 * must therefore exclude evidence-free cells (a `distinctReporterCount` floor) BEFORE
 * ranking, rather than trusting the score to sort them to the bottom — 15 points is enough
 * to outrank a real but early cell whose reporters are still in single digits. This module
 * does not silently zero such cells, because "no evidence" and "evidence weighing 15" are
 * different facts and collapsing them here would hide the first from the caller.
 *
 * The 0..100 assertion below cannot fire. Every ladder is total (each ends in a terminal 0)
 * and capped at its budget (asserted at module load), and the budgets sum to 100 (also
 * asserted at module load) — so the sum is structurally bounded. It is asserted anyway, in
 * the same spirit as `apportionLargestRemainder` checking that its parts sum to the total:
 * this is the module's strongest correctness claim, the check costs two comparisons, and an
 * out-of-range score silently written into a snapshot row would be discovered by a confused
 * user rather than by the code.
 *
 * @throws if any input is not a non-negative safe integer (see
 *         `assertNonNegativeIntegerInput`), or if the total somehow lands outside 0..100 — an
 *         unrecoverable invariant violation (CLAUDE.md §3.3).
 */
export function computeDemandScorePoints(inputs: DemandScoreInputs): DemandScoreBreakdown {
  const distinctReporterComponentPoints = distinctReporterPoints(inputs.distinctReporterCount);
  const clusterVolumeComponentPoints = clusterVolumePoints(inputs.clusterCount);
  const openRoleDemandComponentPoints = openRoleDemandPoints(inputs.openRoleCount);
  const projectScarcityComponentPoints = projectScarcityPoints(inputs.relatedProjectCount);

  const totalPoints =
    distinctReporterComponentPoints +
    clusterVolumeComponentPoints +
    openRoleDemandComponentPoints +
    projectScarcityComponentPoints;

  if (totalPoints < 0 || totalPoints > DEMAND_SCORE_MAXIMUM_POINTS) {
    throw new Error(
      `computeDemandScorePoints: invariant violated — total ${totalPoints} is outside 0..${DEMAND_SCORE_MAXIMUM_POINTS}`,
    );
  }

  return {
    totalPoints,
    distinctReporterPoints: distinctReporterComponentPoints,
    clusterVolumePoints: clusterVolumeComponentPoints,
    openRoleDemandPoints: openRoleDemandComponentPoints,
    projectScarcityPoints: projectScarcityComponentPoints,
  };
}

/**
 * The arrow the leaderboard renders next to a cell, derived from two consecutive snapshots.
 *
 * `previousScorePoints` is `null` on a cell's first-ever snapshot, and that case returns
 * "flat". There is no evidence of a direction from one data point, and defaulting to "up"
 * would fabricate a trend out of the absence of history — every brand-new cell would render
 * as rising, which is both false and the most persuasive possible false thing to show an
 * investor scanning a leaderboard for momentum. "flat" is the only honest answer to a
 * question asked of a single observation.
 *
 * `null` and `0` are therefore NOT interchangeable, and the check is `=== null` rather than
 * a falsy test for exactly that reason: a cell that genuinely climbed from 0 to 15 is "up",
 * while `if (!previousScorePoints)` would call it "flat" and hide the one movement the
 * leaderboard most wants to show.
 *
 * The comparison is STRICT: an unchanged score is "flat", not "up". Both operands are
 * integers out of `computeDemandScorePoints`, so equality is exact and there is no epsilon
 * to choose — another reason the ladders are integer tables rather than a float formula.
 *
 * Both operands are VALIDATED as 0..100 integers before any comparison happens, because a
 * comparison is not a safe operation on an unchecked `number`: NaN compares false both ways
 * and would silently yield "flat", erasing a real trend without raising anything. See
 * `assertDemandScorePointsInput` for why that input is reachable and what the bound does and
 * does not catch.
 *
 * `currentScorePoints` is checked BEFORE the `null` branch on purpose — the no-history case
 * must not become the way a nonsense current score gets past validation.
 *
 * @throws if either score is not an integer in 0..100 — see `assertDemandScorePointsInput`.
 *         `previousScorePoints` being `null` is the documented no-history case, not a fault.
 */
export function deriveTrendDirection(
  currentScorePoints: number,
  previousScorePoints: number | null,
): "up" | "down" | "flat" {
  assertDemandScorePointsInput("currentScorePoints", currentScorePoints);

  if (previousScorePoints === null) {
    return "flat";
  }

  assertDemandScorePointsInput("previousScorePoints", previousScorePoints);
  if (currentScorePoints > previousScorePoints) {
    return "up";
  }
  if (currentScorePoints < previousScorePoints) {
    return "down";
  }
  return "flat";
}
