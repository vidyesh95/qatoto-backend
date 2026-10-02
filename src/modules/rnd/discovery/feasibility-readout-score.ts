import {
  assertBudgetsSumTo,
  assertLadderIsWellFormed,
  assertNonNegativeIntegerInput,
  pointsForAtLeastLadder,
  type ScoreLadderRung,
} from "#src/lib/score-ladder.js";

/**
 * The feasibility readout's four pillars (FE docs/FEASIBILITY_MODEL.md, correction header).
 *
 * ⚠️ FOUR SCORERS, AND NO FUNCTION THAT ADDS THEM. The spec's weighted 0–100 composite and its
 * `feasibilityRating` verdict were rejected: need density is Qatoto's own cluster data, purchasing
 * power is the World Bank, manufacturing is UN Comtrade plus the supplier directory, the
 * regulatory framework is World Bank B-READY, and summing
 * them is the cross-evidence join `R_AND_D_STRUCTURE.md` §7 forbids, "done with weights". Each
 * pillar is bounded by its own budget and read on its own. A sum INSIDE one pillar is fine —
 * both halves of it come from the same source.
 *
 * ⚠️ `null` IS "NO SOURCE DATA FOR THIS CELL", NEVER ZERO. A country with no Qatoto reports in a
 * domain has not been measured to have no need; it has not been measured. Each scorer returns
 * `null` for that case and the snapshot stores NULL across the whole pillar.
 *
 * PURE: no database, no config, no clock. Integer ladders only, each checked at import time by
 * `assertLadderIsWellFormed` — a ladder declared the wrong way round produces plausible small
 * numbers and no error, which is the failure this module is built not to have.
 *
 * THE MODEL DEPARTS FROM THE SPEC IN FOUR STATED WAYS:
 *   - need density is two ladders, not `log10(N+1)/3 × (0.4 + 0.6·C_active/C_total)` — floats and
 *     a denominator ("all historical clusters in the category") that shrinks a country's score
 *     when another country reports more;
 *   - purchasing power drops the `× log10(affected population)` term, because no affected
 *     population figure exists anywhere in this system;
 *   - manufacturing drops the tariff and logistics terms — tariffs are ruled out in §7 and
 *     neither dataset is ingested;
 *   - the regulatory pillar (added in version 2) drops `F_sector_liberalization`, which has no
 *     source, and reads B-READY Pillar 1 rather than an overall score B-READY does not publish.
 * A change to any ladder, or a new pillar, bumps this constant; old snapshots keep the version
 * they were scored under. Version 2 added the regulatory pillar and changed no ladder.
 */
export const FEASIBILITY_READOUT_MODEL_VERSION = 2;

export const FEASIBILITY_PILLAR_BUDGETS = {
  needDensity: 30,
  purchasingPower: 25,
  manufacturing: 25,
  regulatoryFramework: 20,
} as const;

const NEED_DENSITY_SUB_BUDGETS = { distinctReporters: 20, activeClusters: 10 } as const;
const MANUFACTURING_SUB_BUDGETS = { exportValue: 15, domesticProducers: 10 } as const;

/** Distinct people who reported the problem. One viral report cannot reach the top rungs. */
const DISTINCT_REPORTER_LADDER: readonly ScoreLadderRung[] = [
  { threshold: 100, points: 20 },
  { threshold: 25, points: 15 },
  { threshold: 5, points: 10 },
  { threshold: 1, points: 5 },
];

/** Separate places the problem clusters in — spread across a country, not one street. */
const ACTIVE_CLUSTER_LADDER: readonly ScoreLadderRung[] = [
  { threshold: 10, points: 10 },
  { threshold: 3, points: 6 },
  { threshold: 1, points: 3 },
];

/** GDP per capita, PPP, current international dollars (whole dollars). */
const PURCHASING_POWER_LADDER: readonly ScoreLadderRung[] = [
  { threshold: 45_000, points: 25 },
  { threshold: 20_000, points: 20 },
  { threshold: 10_000, points: 15 },
  { threshold: 5_000, points: 10 },
  { threshold: 2_000, points: 5 },
];

/**
 * Annual exports of the domain's HS chapters, IN CENTS. The bottom rung is one dollar: any
 * export proves the capability exists somewhere in the country, which is categorically
 * different from none (the localization scorer's own reasoning).
 */
const DOMAIN_EXPORT_VALUE_LADDER: readonly ScoreLadderRung[] = [
  { threshold: 10_000_000_000_000, points: 15 }, // $100bn
  { threshold: 1_000_000_000_000, points: 12 }, // $10bn
  { threshold: 100_000_000_000, points: 9 }, // $1bn
  { threshold: 10_000_000_000, points: 6 }, // $100m
  { threshold: 1_000_000_000, points: 3 }, // $10m
  { threshold: 100, points: 1 }, // $1
];

/** Active suppliers in the country offering a published substitute in this domain. */
const DOMESTIC_PRODUCER_LADDER: readonly ScoreLadderRung[] = [
  { threshold: 20, points: 10 },
  { threshold: 5, points: 7 },
  { threshold: 1, points: 4 },
];

assertLadderIsWellFormed(
  "DISTINCT_REPORTER_LADDER",
  DISTINCT_REPORTER_LADDER,
  "atLeastThreshold",
  NEED_DENSITY_SUB_BUDGETS.distinctReporters,
);
assertLadderIsWellFormed(
  "ACTIVE_CLUSTER_LADDER",
  ACTIVE_CLUSTER_LADDER,
  "atLeastThreshold",
  NEED_DENSITY_SUB_BUDGETS.activeClusters,
);
assertLadderIsWellFormed(
  "PURCHASING_POWER_LADDER",
  PURCHASING_POWER_LADDER,
  "atLeastThreshold",
  FEASIBILITY_PILLAR_BUDGETS.purchasingPower,
);
assertLadderIsWellFormed(
  "DOMAIN_EXPORT_VALUE_LADDER",
  DOMAIN_EXPORT_VALUE_LADDER,
  "atLeastThreshold",
  MANUFACTURING_SUB_BUDGETS.exportValue,
);
assertLadderIsWellFormed(
  "DOMESTIC_PRODUCER_LADDER",
  DOMESTIC_PRODUCER_LADDER,
  "atLeastThreshold",
  MANUFACTURING_SUB_BUDGETS.domesticProducers,
);
assertBudgetsSumTo(
  "NEED_DENSITY_SUB_BUDGETS",
  NEED_DENSITY_SUB_BUDGETS,
  FEASIBILITY_PILLAR_BUDGETS.needDensity,
);
assertBudgetsSumTo(
  "MANUFACTURING_SUB_BUDGETS",
  MANUFACTURING_SUB_BUDGETS,
  FEASIBILITY_PILLAR_BUDGETS.manufacturing,
);

/**
 * Need density for one (country, domain) cell, or `null` when no active cluster exists there.
 *
 * @throws on a negative or non-integer count — both come from `COUNT(...)` and cannot be either
 *         unless the query is wrong.
 */
export function needDensityPoints(input: {
  readonly distinctReporterCount: number;
  readonly activeClusterCount: number;
}): number | null {
  assertNonNegativeIntegerInput(
    "needDensityPoints",
    "distinctReporterCount",
    input.distinctReporterCount,
  );
  assertNonNegativeIntegerInput(
    "needDensityPoints",
    "activeClusterCount",
    input.activeClusterCount,
  );
  if (input.activeClusterCount === 0) return null;
  return (
    pointsForAtLeastLadder(DISTINCT_REPORTER_LADDER, input.distinctReporterCount) +
    pointsForAtLeastLadder(ACTIVE_CLUSTER_LADDER, input.activeClusterCount)
  );
}

/** Purchasing power for a country. Only called with a published value; absence is the caller's null. */
export function purchasingPowerPoints(valueInWholeInternationalDollars: number): number {
  assertNonNegativeIntegerInput(
    "purchasingPowerPoints",
    "valueInWholeInternationalDollars",
    valueInWholeInternationalDollars,
  );
  return pointsForAtLeastLadder(PURCHASING_POWER_LADDER, valueInWholeInternationalDollars);
}

/**
 * Manufacturing for one (country, domain) cell. Only called when the country HAS ingested export
 * data; a country Comtrade has never been synced for is the caller's null, not a zero.
 */
export function manufacturingPoints(input: {
  readonly exportValueInCents: number;
  readonly domesticProducerCount: number;
}): number {
  assertNonNegativeIntegerInput(
    "manufacturingPoints",
    "exportValueInCents",
    input.exportValueInCents,
  );
  assertNonNegativeIntegerInput(
    "manufacturingPoints",
    "domesticProducerCount",
    input.domesticProducerCount,
  );
  return (
    pointsForAtLeastLadder(DOMAIN_EXPORT_VALUE_LADDER, input.exportValueInCents) +
    pointsForAtLeastLadder(DOMESTIC_PRODUCER_LADDER, input.domesticProducerCount)
  );
}

/** B-READY scores are stored in tenths of a point; 1000 is a score of 100. */
const MAXIMUM_BUSINESS_READY_SCORE_IN_TENTHS = 1000;

/**
 * The regulatory framework for a country: the spec's `20 × score / 100` in integer arithmetic,
 * `floor(tenths / 50)`, so 0–20. No ladder, because the spec's formula is already linear and a
 * ladder would add thresholds nobody chose. Only called with a published score; an economy
 * B-READY does not cover is the caller's null.
 *
 * @throws on a negative, non-integer or above-100 score — the table's CHECK rules all three out.
 */
export function regulatoryFrameworkPoints(scoreInTenths: number): number {
  assertNonNegativeIntegerInput("regulatoryFrameworkPoints", "scoreInTenths", scoreInTenths);
  if (scoreInTenths > MAXIMUM_BUSINESS_READY_SCORE_IN_TENTHS) {
    throw new Error(
      `regulatoryFrameworkPoints: scoreInTenths ${String(scoreInTenths)} exceeds ${String(MAXIMUM_BUSINESS_READY_SCORE_IN_TENTHS)}`,
    );
  }
  return Math.floor(
    (scoreInTenths * FEASIBILITY_PILLAR_BUDGETS.regulatoryFramework) /
      MAXIMUM_BUSINESS_READY_SCORE_IN_TENTHS,
  );
}
