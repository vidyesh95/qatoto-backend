/**
 * The step-ladder scoring machinery, shared.
 *
 * WHY THIS FILE EXISTS. `opportunity-score.ts` and `demand-score.ts` each carry a private
 * copy of everything below — the same ~150 lines, twice. HOME_BACKEND_STRUCTURE.md phase 3
 * adds three more scorers (`feed-score.ts`, `trending-score.ts`, `affinity-score.ts`), and
 * five copies of a validator is five places a tuning rule can quietly diverge.
 *
 * THE TWO SHIPPED SCORERS ARE DELIBERATELY NOT MIGRATED ONTO THIS MODULE. They rank live
 * data today; refactoring them is a separate, revertible change that should not ride along
 * with a feature. This module stops the copy count at three rather than pretending to fix
 * the two that already exist — and it is a byte-for-byte lift, so migrating them later is
 * mechanical.
 *
 * WHY LADDERS AND NOT CURVES, restated because it governs every scorer that imports this:
 * a step ladder is DATA. A tuning change is a diff to a table that the module-load checks
 * re-validate, not an edit to arithmetic nobody re-derives. There is no `Math.exp`, no
 * float, and no division inside the machinery — so there is no rounding rule, and therefore
 * no way for TypeScript and Postgres to disagree about a half.
 */

/** One step of a ladder: a threshold and the points awarded to the first rung that matches. */
export interface ScoreLadderRung {
  readonly threshold: number;
  readonly points: number;
}

/**
 * Which comparison a ladder is scanned with. The two directions are NOT interchangeable and
 * a ladder declared for one is silently wrong under the other — which is why every ladder
 * must be passed through `assertLadderIsWellFormed` with its direction at module load.
 */
export type LadderDirection = "atLeastThreshold" | "atMostThreshold";

/**
 * Validates a ladder's shape once, at module load.
 *
 * THE TRAP THIS EXISTS TO CATCH: rungs are scanned in declaration order and the FIRST match
 * wins, so an "at least" ladder declared lowest-threshold-first would match its bottom rung
 * for every input above zero. That is a total-loss scoring bug that produces plausible small
 * numbers, no exception, and no type error — the ranking would simply be wrong forever.
 *
 * Checking `topRung.points === componentBudget` is the other half of the 0..100 guarantee:
 * it pins each ladder's ceiling to the budget table, so the budgets summing to 100 is enough
 * to prove the total can never exceed 100.
 *
 * @throws if the ladder is empty, has a non-integer or non-positive rung, is not strictly
 *         ordered in both threshold and points, or does not top out at its budget. All are
 *         unrecoverable programmer errors (CLAUDE.md §3.3) and all fire at import time,
 *         where a broken table cannot reach a single request.
 */
export function assertLadderIsWellFormed(
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
      `${ladderName}: top rung awards ${String(topRung.points)} but the component budget is ${String(componentBudget)}`,
    );
  }

  for (const rung of ladder) {
    if (!Number.isSafeInteger(rung.threshold) || !Number.isSafeInteger(rung.points)) {
      throw new Error(
        `${ladderName}: rung {threshold: ${String(rung.threshold)}, points: ${String(rung.points)}} must be integral — no floats`,
      );
    }
    if (rung.points <= 0) {
      throw new Error(
        `${ladderName}: rung at threshold ${String(rung.threshold)} awards ${String(rung.points)}; the only zero is the terminal fall-through`,
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
        `${ladderName}: thresholds must be strictly ordered for a ${direction} scan, but ${String(previousRung.threshold)} is followed by ${String(currentRung.threshold)}`,
      );
    }
    if (currentRung.points >= previousRung.points) {
      throw new Error(
        `${ladderName}: points must strictly decrease down the ladder, but ${String(previousRung.points)} is followed by ${String(currentRung.points)}`,
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
export function pointsForAtLeastLadder(
  ladder: readonly ScoreLadderRung[],
  measuredValue: number,
): number {
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
 * The mirror image, for the components where SMALL is good (a fresh upload, an unwatched
 * category). Same terminal `0`, same totality guarantee.
 */
export function pointsForAtMostLadder(
  ladder: readonly ScoreLadderRung[],
  measuredValue: number,
): number {
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
 * NaN IS THE SPECIFIC HAZARD. Every comparison against NaN is false, so a NaN input would
 * fall through every rung of every ladder to the terminal `0` and be indistinguishable from
 * an honest low score. A count that arrived as NaN, Infinity or `20.5` means the caller's
 * SQL or date arithmetic is broken upstream — the physically-impossible-invariant case
 * CLAUDE.md §3.3 permits a throw for. It also enforces the float ban at the boundary.
 */
export function assertSafeIntegerInput(
  functionName: string,
  parameterName: string,
  measuredValue: number,
): void {
  if (!Number.isSafeInteger(measuredValue)) {
    throw new Error(
      `${functionName}: ${parameterName} must be a safe integer, got ${String(measuredValue)}`,
    );
  }
}

/**
 * The stricter guard, for inputs where a negative value would FAIL OPEN.
 *
 * An "at least" ladder is already total over the whole integer line and a negative there
 * scores nothing — it fails closed. An "at most" ladder is the opposite: a negative matches
 * its LOWEST threshold and is awarded the FULL component budget. That is the only shape in
 * which nonsense inflates a score, so every `atMost` input goes through this one instead.
 */
export function assertNonNegativeIntegerInput(
  functionName: string,
  parameterName: string,
  measuredValue: number,
): void {
  if (!Number.isSafeInteger(measuredValue) || measuredValue < 0) {
    throw new Error(
      `${functionName}: ${parameterName} must be a non-negative safe integer, got ${String(measuredValue)}`,
    );
  }
}

/**
 * Asserts a scorer's component budgets sum to its maximum, at module load.
 *
 * ASSERTED AT LOAD RATHER THAN ONLY IN A TEST, because a test can be skipped or deleted and
 * a budget table that sums to 99 would not fail anything — it would quietly make a perfect
 * score unreachable and shift every row's rank.
 */
export function assertBudgetsSumTo(
  budgetTableName: string,
  budgets: Readonly<Record<string, number>>,
  expectedTotal: number,
): void {
  const budgetSum = Object.values(budgets).reduce(
    (runningSum, componentBudget) => runningSum + componentBudget,
    0,
  );
  if (budgetSum !== expectedTotal) {
    throw new Error(
      `${budgetTableName} must sum to ${String(expectedTotal)}, got ${String(budgetSum)}`,
    );
  }
}
