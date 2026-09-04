/**
 * The localization feasibility score: one 0..100 integer per (commodity, country) cell,
 * recomputed nightly by `recompute-localization-assessments` and written into
 * `localization_assessment` with its rank and the job's `asOf` (§10A).
 *
 * IT IS A RANKING SIGNAL, AND §6 IS EXPLICIT THAT RANKING SIGNALS ARE ATTACK SURFACES:
 * never client-supplied, never accepted in a body, never computed on read. This module is
 * the only place the number is allowed to come from.
 *
 * BUILT ON `#src/lib/score-ladder.js`, NOT COPIED FROM `demand-score.ts`. Those two shipped
 * scorers each carry a private copy of the ladder machinery; `score-ladder.ts` exists to
 * stop the copy count at three, and five newer scorers already import it. A sixth private
 * copy would be a sixth place a tuning rule can quietly diverge.
 *
 * THE LADDERS ARE CALIBRATED FROM MEASURED DATA, not chosen for roundness. India's 2023
 * HS6 import lines distribute p50 $7.1M, p75 $39.6M, p90 $144M, p99 $1.38B, max $140B —
 * so a ladder topping out at $10M would saturate for a quarter of the catalogue and rank
 * nothing. The rungs below are log-spaced across that measured range.
 *
 * No division happens anywhere in this file, so there is no rounding rule and no way for
 * TypeScript and SQL to disagree about a half (§4c).
 */
import {
  assertBudgetsSumTo,
  assertLadderIsWellFormed,
  assertNonNegativeIntegerInput,
  assertSafeIntegerInput,
  pointsForAtLeastLadder,
  pointsForAtMostLadder,
  type ScoreLadderRung,
} from "#src/lib/score-ladder.js";

/**
 * How the 100 points split across the five components.
 *
 * Exported because the weighting is a product decision that belongs in one auditable place
 * rather than smeared across five functions as magic numbers, and because the assessment
 * table and the UI both need it to render "27 of 35" instead of a bare, unfalsifiable
 * total.
 *
 * THE SPLIT IS THE EDITORIAL CLAIM THIS MODULE MAKES about what "feasible to localize"
 * means. Import dependency carries the most (35) because it is the size of the prize and
 * the only input measured entirely outside this platform — a national customs filing is
 * not something a Qatoto user can influence. Export capability is second (25) because it
 * is the hardest evidence available that the thing can already be made here: a supplier
 * count can be inflated by one motivated organisation, a national export figure cannot.
 * Substitutes (20) and suppliers (12) are corroborating and both are self-reported, so
 * neither may carry a cell alone. Lead time is smallest (8) deliberately: it modifies
 * feasibility, it is not evidence of it.
 *
 * The sum is asserted at module load below, and each ladder's top rung is asserted to
 * equal its budget — together those two checks make a 0..100 total mechanically
 * guaranteed rather than argued in a comment.
 */
export const LOCALIZATION_SCORE_COMPONENT_BUDGETS = {
  importDependency: 35,
  exportCapability: 25,
  substituteAvailability: 20,
  supplierCapacity: 12,
  leadTimeAdvantage: 8,
} as const;

/** The full-marks score. A cell topping out every ladder lands here. */
const LOCALIZATION_SCORE_MAXIMUM_POINTS = 100;

/**
 * How much each maturity level contributes to the substitute-availability input.
 *
 * A substitute that exists only in a paper is evidence of POSSIBILITY; one already made at
 * commercial scale is evidence of SUPPLY. Weighting them equally would let four lab-scale
 * write-ups outrank one operating plant, which is the opposite of what a founder deciding
 * where to spend a year needs.
 */
export const SUBSTITUTE_MATURITY_WEIGHTS = {
  lab_scale: 1,
  pilot_scale: 2,
  commercial: 3,
  mature: 4,
} as const;

export type SubstituteMaturityLevel = keyof typeof SUBSTITUTE_MATURITY_WEIGHTS;

// --- The ladders. Thresholds DESCEND for `atLeast`, ASCEND for `atMost`, and points
// --- strictly decrease down every one of them. `assertLadderIsWellFormed` re-checks all
// --- of that at module load, because a ladder declared the wrong way round produces
// --- plausible small numbers, no exception and no type error.

/**
 * Annual import value, IN CENTS. $10bn tops out; $100k is the bottom rung.
 *
 * The top rung is deliberately reachable — 77 of India's 5,052 lines exceed $1bn and the
 * largest is $140bn — but only just, so the ranking still separates the top of the market.
 */
const IMPORT_DEPENDENCY_LADDER: readonly ScoreLadderRung[] = [
  { threshold: 1_000_000_000_000, points: 35 }, // $10bn
  { threshold: 100_000_000_000, points: 31 }, // $1bn
  { threshold: 25_000_000_000, points: 26 }, // $250m
  { threshold: 10_000_000_000, points: 21 }, // $100m — p90
  { threshold: 2_500_000_000, points: 15 }, // $25m
  { threshold: 1_000_000_000, points: 10 }, // $10m — just above p50
  { threshold: 100_000_000, points: 5 }, // $1m — p25
  { threshold: 10_000_000, points: 2 }, // $100k — p10
];

/**
 * Annual export value, IN CENTS. The bottom rung is one dollar, on purpose: any export at
 * all proves the capability exists somewhere in the country, and that is a categorically
 * different statement from zero.
 */
const EXPORT_CAPABILITY_LADDER: readonly ScoreLadderRung[] = [
  { threshold: 500_000_000_000, points: 25 }, // $5bn
  { threshold: 100_000_000_000, points: 22 }, // $1bn
  { threshold: 25_000_000_000, points: 18 }, // $250m
  { threshold: 5_000_000_000, points: 14 }, // $50m
  { threshold: 1_000_000_000, points: 10 }, // $10m
  { threshold: 100_000_000, points: 6 }, // $1m
  { threshold: 10_000_000, points: 3 }, // $100k
  { threshold: 100, points: 1 }, // $1 — the country exports this at all
];

/** The maturity-weighted substitute total. Five mature substitutes top it out. */
const SUBSTITUTE_AVAILABILITY_LADDER: readonly ScoreLadderRung[] = [
  { threshold: 20, points: 20 },
  { threshold: 12, points: 17 },
  { threshold: 8, points: 14 },
  { threshold: 5, points: 11 },
  { threshold: 3, points: 8 },
  { threshold: 2, points: 5 },
  { threshold: 1, points: 2 },
];

/** In-country suppliers whose curated capabilities match at least one substitute. */
const SUPPLIER_CAPACITY_LADDER: readonly ScoreLadderRung[] = [
  { threshold: 20, points: 12 },
  { threshold: 10, points: 10 },
  { threshold: 5, points: 8 },
  { threshold: 3, points: 6 },
  { threshold: 2, points: 4 },
  { threshold: 1, points: 2 },
];

/**
 * THE INVERTED ONE — ascending thresholds, small is good. Median domestic supplier lead
 * time in days.
 *
 * ⚠️ A NULL LEAD TIME NEVER REACHES THIS LADDER. See `leadTimeAdvantagePoints`.
 */
const LEAD_TIME_ADVANTAGE_LADDER: readonly ScoreLadderRung[] = [
  { threshold: 14, points: 8 },
  { threshold: 30, points: 6 },
  { threshold: 60, points: 4 },
  { threshold: 90, points: 2 },
  { threshold: 180, points: 1 },
];

assertLadderIsWellFormed(
  "IMPORT_DEPENDENCY_LADDER",
  IMPORT_DEPENDENCY_LADDER,
  "atLeastThreshold",
  LOCALIZATION_SCORE_COMPONENT_BUDGETS.importDependency,
);
assertLadderIsWellFormed(
  "EXPORT_CAPABILITY_LADDER",
  EXPORT_CAPABILITY_LADDER,
  "atLeastThreshold",
  LOCALIZATION_SCORE_COMPONENT_BUDGETS.exportCapability,
);
assertLadderIsWellFormed(
  "SUBSTITUTE_AVAILABILITY_LADDER",
  SUBSTITUTE_AVAILABILITY_LADDER,
  "atLeastThreshold",
  LOCALIZATION_SCORE_COMPONENT_BUDGETS.substituteAvailability,
);
assertLadderIsWellFormed(
  "SUPPLIER_CAPACITY_LADDER",
  SUPPLIER_CAPACITY_LADDER,
  "atLeastThreshold",
  LOCALIZATION_SCORE_COMPONENT_BUDGETS.supplierCapacity,
);
assertLadderIsWellFormed(
  "LEAD_TIME_ADVANTAGE_LADDER",
  LEAD_TIME_ADVANTAGE_LADDER,
  "atMostThreshold",
  LOCALIZATION_SCORE_COMPONENT_BUDGETS.leadTimeAdvantage,
);

assertBudgetsSumTo(
  "LOCALIZATION_SCORE_COMPONENT_BUDGETS",
  LOCALIZATION_SCORE_COMPONENT_BUDGETS,
  LOCALIZATION_SCORE_MAXIMUM_POINTS,
);

/**
 * Points for how much of this commodity the country buys from abroad.
 *
 * Bottom rung: $100k of annual imports. Top rung: $10bn. Below $100k the component pays
 * nothing — a commodity nobody imports is not a localization opportunity, it is a
 * commodity nobody wants.
 *
 * @throws if the value is not a non-negative safe integer. It is a `SUM(...)` of `bigint`
 *         cents, so a negative means broken SQL upstream rather than a small trade.
 */
export function importDependencyPoints(importValueInCents: number): number {
  assertNonNegativeIntegerInput("importDependencyPoints", "importValueInCents", importValueInCents);
  return pointsForAtLeastLadder(IMPORT_DEPENDENCY_LADDER, importValueInCents);
}

/**
 * Points for the country already exporting this commodity.
 *
 * Bottom rung is one dollar, so any export at all scores. That is the intended shape: the
 * question this component answers is "can anyone here already make it", and one dollar of
 * exports answers yes while zero answers nothing at all.
 *
 * @throws if the value is not a non-negative safe integer.
 */
export function exportCapabilityPoints(exportValueInCents: number): number {
  assertNonNegativeIntegerInput("exportCapabilityPoints", "exportValueInCents", exportValueInCents);
  return pointsForAtLeastLadder(EXPORT_CAPABILITY_LADDER, exportValueInCents);
}

/**
 * Weights a set of published substitutes by maturity into the ladder's input.
 *
 * Exported so the assessment job stores the same integer it scored — a weighted total
 * recomputed at render time from a different weight table would silently disagree with the
 * points beside it.
 */
export function weighSubstituteMaturities(
  maturityLevels: readonly SubstituteMaturityLevel[],
): number {
  return maturityLevels.reduce(
    (runningWeight, maturityLevel) => runningWeight + SUBSTITUTE_MATURITY_WEIGHTS[maturityLevel],
    0,
  );
}

/**
 * Points for how many domestic substitutes have been published, weighted by maturity.
 *
 * @throws if the weight is not a non-negative safe integer.
 */
export function substituteAvailabilityPoints(weightedSubstituteTotal: number): number {
  assertNonNegativeIntegerInput(
    "substituteAvailabilityPoints",
    "weightedSubstituteTotal",
    weightedSubstituteTotal,
  );
  return pointsForAtLeastLadder(SUBSTITUTE_AVAILABILITY_LADDER, weightedSubstituteTotal);
}

/**
 * Points for in-country suppliers whose capabilities match at least one substitute.
 *
 * @throws if the count is not a non-negative safe integer. It is a `COUNT(*)`.
 */
export function supplierCapacityPoints(matchedSupplierCount: number): number {
  assertNonNegativeIntegerInput(
    "supplierCapacityPoints",
    "matchedSupplierCount",
    matchedSupplierCount,
  );
  return pointsForAtLeastLadder(SUPPLIER_CAPACITY_LADDER, matchedSupplierCount);
}

/**
 * Points for domestic supply being faster than the import lane.
 *
 * ⚠️ NULL IS HANDLED HERE AND NEVER REACHES THE LADDER, and this is the one place in the
 * module where getting it wrong is silent. `demand-score.ts` records the same trap for its
 * inverted scarcity ladder: an `atMost` ladder pays its FULL budget for the smallest
 * input, so a null coerced to `0` would award all 8 points to every commodity for which
 * no supplier has published a lead time at all — turning absent evidence into perfect
 * evidence. Null means nobody published one, and it scores nothing.
 *
 * @throws if a non-null value is not a non-negative safe integer.
 */
export function leadTimeAdvantagePoints(medianSupplierLeadTimeDays: number | null): number {
  if (medianSupplierLeadTimeDays === null) {
    return 0;
  }
  assertNonNegativeIntegerInput(
    "leadTimeAdvantagePoints",
    "medianSupplierLeadTimeDays",
    medianSupplierLeadTimeDays,
  );
  return pointsForAtMostLadder(LEAD_TIME_ADVANTAGE_LADDER, medianSupplierLeadTimeDays);
}

export interface LocalizationScoreInputs {
  readonly importValueInCents: number;
  readonly exportValueInCents: number;
  readonly weightedSubstituteTotal: number;
  readonly matchedSupplierCount: number;
  /** NULL when no in-country supplier has published a lead time. Never coerced. */
  readonly medianSupplierLeadTimeDays: number | null;
}

export interface LocalizationScoreBreakdown {
  readonly totalPoints: number;
  readonly importDependencyPoints: number;
  readonly exportCapabilityPoints: number;
  readonly substituteAvailabilityPoints: number;
  readonly supplierCapacityPoints: number;
  readonly leadTimeAdvantagePoints: number;
}

/**
 * The whole score, with every component beside it.
 *
 * ⚠️ KNOWN PROPERTY, and the leaderboard query must account for it: a commodity with NO
 * trade flow at all scores 0 rather than being excluded, and 0 sorts last only because
 * every other cell scores more. Evidence-free rows are excluded in SQL BEFORE ranking
 * rather than trusted to sort themselves down — the same instruction `demand-score.ts`
 * gives for its own empty-cell case.
 */
export function computeLocalizationScorePoints(
  inputs: LocalizationScoreInputs,
): LocalizationScoreBreakdown {
  const importDependencyComponentPoints = importDependencyPoints(inputs.importValueInCents);
  const exportCapabilityComponentPoints = exportCapabilityPoints(inputs.exportValueInCents);
  const substituteAvailabilityComponentPoints = substituteAvailabilityPoints(
    inputs.weightedSubstituteTotal,
  );
  const supplierCapacityComponentPoints = supplierCapacityPoints(inputs.matchedSupplierCount);
  const leadTimeAdvantageComponentPoints = leadTimeAdvantagePoints(
    inputs.medianSupplierLeadTimeDays,
  );

  const totalPoints =
    importDependencyComponentPoints +
    exportCapabilityComponentPoints +
    substituteAvailabilityComponentPoints +
    supplierCapacityComponentPoints +
    leadTimeAdvantageComponentPoints;

  // Cannot fire while the module-load checks hold. Kept because it is the assertion that
  // makes the `localization_assessment` CHECK constraint and this function agree by
  // construction rather than by review.
  if (totalPoints < 0 || totalPoints > LOCALIZATION_SCORE_MAXIMUM_POINTS) {
    throw new Error(
      `computeLocalizationScorePoints: invariant violated — total ${totalPoints} is outside 0..${LOCALIZATION_SCORE_MAXIMUM_POINTS}`,
    );
  }

  return {
    totalPoints,
    importDependencyPoints: importDependencyComponentPoints,
    exportCapabilityPoints: exportCapabilityComponentPoints,
    substituteAvailabilityPoints: substituteAvailabilityComponentPoints,
    supplierCapacityPoints: supplierCapacityComponentPoints,
    leadTimeAdvantagePoints: leadTimeAdvantageComponentPoints,
  };
}

/**
 * The arrow, derived from the previous snapshot's score.
 *
 * NULL IS NOT ZERO. `previousScorePoints === null` is a cell's first assessment and is
 * `flat` — `if (!previousScorePoints)` would call a 0 → 21 climb flat, because 0 is falsy.
 * The current score is validated BEFORE the null branch, so the no-history case cannot
 * become a validation bypass.
 */
export function deriveTrendDirection(
  currentScorePoints: number,
  previousScorePoints: number | null,
): "up" | "down" | "flat" {
  assertLocalizationScorePointsInput("currentScorePoints", currentScorePoints);
  if (previousScorePoints === null) {
    return "flat";
  }
  assertLocalizationScorePointsInput("previousScorePoints", previousScorePoints);

  if (currentScorePoints > previousScorePoints) {
    return "up";
  }
  if (currentScorePoints < previousScorePoints) {
    return "down";
  }
  return "flat";
}

/**
 * Guards a value claiming to already BE a score.
 *
 * `previousScorePoints` is read back from Postgres, so it can be anything the column
 * admits. Without this guard a NaN makes both `>` and `<` false and the trend silently
 * renders "flat" forever. The 0..100 bound doubles as a partial type guard: a raw cents
 * figure passed where points belong is caught the moment it exceeds 100.
 */
function assertLocalizationScorePointsInput(parameterName: string, scorePoints: number): void {
  assertSafeIntegerInput("deriveTrendDirection", parameterName, scorePoints);
  if (scorePoints < 0 || scorePoints > LOCALIZATION_SCORE_MAXIMUM_POINTS) {
    throw new Error(
      `deriveTrendDirection: ${parameterName} must be an integer score in 0..${LOCALIZATION_SCORE_MAXIMUM_POINTS}, got ${scorePoints}`,
    );
  }
}
