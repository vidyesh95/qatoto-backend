/**
 * The nightly localization assessment (§10A).
 *
 * ONE ROW PER (commodity, country, asOf), with its five component sub-scores, every raw
 * input it was computed from, and a dense rank within the country.
 *
 * WHAT IT SCORES, and the one modelling decision worth knowing: the trade inputs are the
 * MOST RECENT ANNUAL figure per cell, not a sum across the window. Comtrade revises years
 * and publishes them years apart, so summing would add a fully-revised 2019 to a partial
 * 2024 and call the result a total. `DISTINCT ON ... ORDER BY period_starts_date DESC` is
 * what picks the newest.
 *
 * IT READS FOUR TABLES AND WRITES ONE. Everything is fetched in four set-based queries and
 * reduced in TypeScript rather than joined per commodity — 5,052 commodities times a
 * per-cell query is 5,052 round trips, and the scoring itself is pure integer arithmetic
 * that has no business happening in SQL (§4c: one implementation of the formula, in one
 * language, testable without a database).
 */
import { sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { localizationAssessment } from "#src/db/schema.js";
import {
  idempotencyKeyFor,
  JOB_NAMES,
  JOB_PAYLOAD_SCHEMAS,
  parseJobPayload,
  sendJob,
} from "#src/lib/jobs.js";
import {
  computeLocalizationScorePoints,
  deriveTrendDirection,
  weighSubstituteMaturities,
  type SubstituteMaturityLevel,
} from "#src/modules/rnd/import-intelligence/localization-feasibility-score.js";

/**
 * How many of a country's commodities get an LLM narrative each run.
 *
 * BOUNDED, because each one is a metered model request and a country has ~5,000
 * commodities. The top of the ranking is also the only part anyone reads: a narrative for
 * the 3,000th most feasible commodity would spend a request to be seen by nobody. A
 * commodity that climbs into the top slice gets one on the night it does.
 */
const NARRATIVE_RANK_LIMIT = 25;

/** The currency every Comtrade figure is denominated in. Carried onto the assessment row. */
const ASSESSMENT_CURRENCY = "USD";

/** Insert batch size. 500 rows of 22 columns sits well inside the protocol's parameter cap. */
const INSERT_CHUNK_SIZE = 500;

interface LatestFlowRow {
  readonly [column: string]: unknown;
  readonly commodity_id: string;
  readonly reporter_region_id: string;
  readonly flow_kind: "import" | "export";
  readonly trade_value_in_cents: string;
}

interface SubstituteRow {
  readonly [column: string]: unknown;
  readonly commodity_id: string;
  readonly region_id: string;
  readonly maturity_level: SubstituteMaturityLevel;
  readonly supplier_capability_id: string | null;
}

interface SupplierCapabilityRow {
  readonly [column: string]: unknown;
  readonly supplier_id: string;
  readonly region_id: string;
  readonly capability_id: string;
  readonly lead_time_days: number | null;
  readonly verification_state: string;
}

interface PreviousAssessmentRow {
  readonly [column: string]: unknown;
  readonly commodity_id: string;
  readonly region_id: string;
  readonly feasibility_score_points: number;
}

/**
 * The integer median. An even-length input takes the LOWER middle.
 *
 * No averaging, deliberately: the mean of two integer day counts is a half-day, and §4c's
 * whole point is that this domain never produces a value TypeScript and Postgres could
 * round differently. The lower middle is also the conservative reading — it claims the
 * faster of the two, which is the direction a founder will check.
 */
function medianOf(sortedValues: readonly number[]): number | null {
  if (sortedValues.length === 0) {
    return null;
  }
  const middleIndex = Math.floor((sortedValues.length - 1) / 2);
  return sortedValues[middleIndex] ?? null;
}

interface CellAccumulator {
  importValueInCents: number;
  exportValueInCents: number;
  maturities: SubstituteMaturityLevel[];
  capabilityIds: Set<string>;
}

interface ScoredCell {
  readonly commodityId: string;
  readonly regionId: string;
  readonly importValueInCents: number;
  readonly exportValueInCents: number;
  readonly substituteCount: number;
  readonly matchedSupplierCount: number;
  readonly verifiedSupplierCount: number;
  readonly medianSupplierLeadTimeDays: number | null;
  readonly breakdown: ReturnType<typeof computeLocalizationScorePoints>;
}

/** Cells are keyed by a pair, and the separator must not occur in either id. */
const CELL_KEY_SEPARATOR = " ";

function cellKeyFor(commodityId: string, regionId: string): string {
  return `${commodityId}${CELL_KEY_SEPARATOR}${regionId}`;
}

export async function handleRecomputeLocalizationAssessments(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.recomputeLocalizationAssessments,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.recomputeLocalizationAssessments],
    rawPayload,
  );
  const asOf = new Date(payload.asOf);
  const windowStartsAt = new Date(payload.windowStartsAt);
  const windowEndsAt = new Date(payload.windowEndsAt);
  const regionFilter = payload.regionId;

  // --- 1. The newest annual figure per (commodity, country, direction).
  const latestFlows = await db.execute<LatestFlowRow>(sql`
    SELECT DISTINCT ON (commodity_id, reporter_region_id, flow_kind)
      commodity_id, reporter_region_id, flow_kind::text AS flow_kind, trade_value_in_cents
    FROM commodity_trade_flow
    WHERE period_kind = 'annual'
      AND partner_region_id IS NULL
      ${regionFilter === null ? sql`` : sql`AND reporter_region_id = ${regionFilter}`}
    ORDER BY commodity_id, reporter_region_id, flow_kind, period_starts_date DESC
  `);

  // --- 2. Published substitutes only. A draft is not evidence of anything.
  const substitutes = await db.execute<SubstituteRow>(sql`
    SELECT commodity_id, region_id, maturity_level::text AS maturity_level, supplier_capability_id
    FROM domestic_substitute_mapping
    WHERE published_at IS NOT NULL
      ${regionFilter === null ? sql`` : sql`AND region_id = ${regionFilter}`}
  `);

  // --- 3. Active suppliers and the capabilities they claim.
  const supplierCapabilities = await db.execute<SupplierCapabilityRow>(sql`
    SELECT s.id AS supplier_id, s.region_id, l.capability_id,
           s.lead_time_days, s.verification_state::text AS verification_state
    FROM supplier AS s
    JOIN supplier_capability_link AS l ON l.supplier_id = s.id
    WHERE s.is_active AND s.region_id IS NOT NULL
  `);

  // --- 4. The most recent prior score per cell, for the trend arrow.
  const previousAssessments = await db.execute<PreviousAssessmentRow>(sql`
    SELECT DISTINCT ON (commodity_id, region_id)
      commodity_id, region_id, feasibility_score_points
    FROM localization_assessment
    WHERE as_of < ${asOf.toISOString()}
    ORDER BY commodity_id, region_id, as_of DESC
  `);

  const cells = new Map<string, CellAccumulator>();

  for (const row of latestFlows.rows) {
    const key = cellKeyFor(row.commodity_id, row.reporter_region_id);
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = {
        importValueInCents: 0,
        exportValueInCents: 0,
        maturities: [],
        capabilityIds: new Set<string>(),
      };
      cells.set(key, cell);
    }
    // `bigint` arrives as a decimal STRING from node-postgres. `Number` is safe here and
    // only here: the largest observed line is 1.4e13 cents, far inside 2^53.
    const valueInCents = Number(row.trade_value_in_cents);
    if (row.flow_kind === "import") {
      cell.importValueInCents = valueInCents;
    } else {
      cell.exportValueInCents = valueInCents;
    }
  }

  for (const row of substitutes.rows) {
    // A substitute for a commodity with no trade row creates NO cell. The assessment
    // answers "is this import worth localizing", and with no import figure there is no
    // question — scoring it would publish a feasibility number with no market behind it.
    const cell = cells.get(cellKeyFor(row.commodity_id, row.region_id));
    if (cell === undefined) {
      continue;
    }
    cell.maturities.push(row.maturity_level);
    if (row.supplier_capability_id !== null) {
      cell.capabilityIds.add(row.supplier_capability_id);
    }
  }

  // Suppliers indexed by (region, capability), so the per-cell lookup is a set
  // intersection rather than a scan of every supplier for every commodity.
  const suppliersByRegionCapability = new Map<string, SupplierCapabilityRow[]>();
  for (const row of supplierCapabilities.rows) {
    const key = `${row.region_id}${CELL_KEY_SEPARATOR}${row.capability_id}`;
    const bucket = suppliersByRegionCapability.get(key);
    if (bucket === undefined) {
      suppliersByRegionCapability.set(key, [row]);
    } else {
      bucket.push(row);
    }
  }

  const previousScoreByCell = new Map(
    previousAssessments.rows.map((row) => [
      cellKeyFor(row.commodity_id, row.region_id),
      row.feasibility_score_points,
    ]),
  );

  const scoredCells: ScoredCell[] = [];

  for (const [key, cell] of cells) {
    const separatorIndex = key.indexOf(CELL_KEY_SEPARATOR);
    const commodityId = key.slice(0, separatorIndex);
    const regionId = key.slice(separatorIndex + 1);

    const matchedSuppliers = new Map<string, SupplierCapabilityRow>();
    for (const capabilityId of cell.capabilityIds) {
      const bucket = suppliersByRegionCapability.get(
        `${regionId}${CELL_KEY_SEPARATOR}${capabilityId}`,
      );
      for (const supplier of bucket ?? []) {
        matchedSuppliers.set(supplier.supplier_id, supplier);
      }
    }

    const matchedSupplierList = [...matchedSuppliers.values()];
    const publishedLeadTimes = matchedSupplierList
      .map((supplier) => supplier.lead_time_days)
      .filter((leadTimeDays): leadTimeDays is number => leadTimeDays !== null)
      .toSorted((left, right) => left - right);

    const matchedSupplierCount = matchedSupplierList.length;
    const medianSupplierLeadTimeDays = medianOf(publishedLeadTimes);

    scoredCells.push({
      commodityId,
      regionId,
      importValueInCents: cell.importValueInCents,
      exportValueInCents: cell.exportValueInCents,
      substituteCount: cell.maturities.length,
      matchedSupplierCount,
      verifiedSupplierCount: matchedSupplierList.filter(
        (supplier) => supplier.verification_state === "verified",
      ).length,
      medianSupplierLeadTimeDays,
      breakdown: computeLocalizationScorePoints({
        importValueInCents: cell.importValueInCents,
        exportValueInCents: cell.exportValueInCents,
        weightedSubstituteTotal: weighSubstituteMaturities(cell.maturities),
        matchedSupplierCount,
        medianSupplierLeadTimeDays,
      }),
    });
  }

  const cellsByRegion = new Map<string, ScoredCell[]>();
  for (const scored of scoredCells) {
    const bucket = cellsByRegion.get(scored.regionId);
    if (bucket === undefined) {
      cellsByRegion.set(scored.regionId, [scored]);
    } else {
      bucket.push(scored);
    }
  }

  const insertedAssessments: { readonly id: string; readonly rank: number }[] = [];

  for (const [regionId, regionCells] of cellsByRegion) {
    // Rank is dense and per-country. TIES BREAK ON COMMODITY ID so two runs over identical
    // data produce identical ranks — without a total order the `(as_of, region_id, rank)`
    // unique would still hold while the ranking itself shuffled between nights, and a
    // commodity would appear to move for no reason.
    const ranked = regionCells.toSorted((left, right) => {
      if (right.breakdown.totalPoints !== left.breakdown.totalPoints) {
        return right.breakdown.totalPoints - left.breakdown.totalPoints;
      }
      return left.commodityId.localeCompare(right.commodityId);
    });

    const values = ranked.map((scored, index) => {
      const previousScorePoints =
        previousScoreByCell.get(cellKeyFor(scored.commodityId, regionId)) ?? null;
      return {
        asOf,
        windowStartsAt,
        windowEndsAt,
        commodityId: scored.commodityId,
        regionId,
        feasibilityScorePoints: scored.breakdown.totalPoints,
        rank: index + 1,
        trendDirection: deriveTrendDirection(scored.breakdown.totalPoints, previousScorePoints),
        previousFeasibilityScorePoints: previousScorePoints,
        importDependencyPoints: scored.breakdown.importDependencyPoints,
        exportCapabilityPoints: scored.breakdown.exportCapabilityPoints,
        substituteAvailabilityPoints: scored.breakdown.substituteAvailabilityPoints,
        supplierCapacityPoints: scored.breakdown.supplierCapacityPoints,
        leadTimeAdvantagePoints: scored.breakdown.leadTimeAdvantagePoints,
        observedImportValueInCents: scored.importValueInCents,
        observedExportValueInCents: scored.exportValueInCents,
        currency: ASSESSMENT_CURRENCY,
        substituteCount: scored.substituteCount,
        matchedSupplierCount: scored.matchedSupplierCount,
        verifiedSupplierCount: scored.verifiedSupplierCount,
        medianSupplierLeadTimeDays: scored.medianSupplierLeadTimeDays,
      };
    });

    for (let offset = 0; offset < values.length; offset += INSERT_CHUNK_SIZE) {
      const written = await db
        .insert(localizationAssessment)
        .values(values.slice(offset, offset + INSERT_CHUNK_SIZE))
        // Re-running the same `asOf` is a no-op rather than a duplicate-key crash. The job
        // is idempotent by its key, but a smoke script re-running the handler inline is
        // not, and that is exactly how the idempotency assertion is written.
        .onConflictDoNothing({
          target: [
            localizationAssessment.asOf,
            localizationAssessment.commodityId,
            localizationAssessment.regionId,
          ],
        })
        .returning({ id: localizationAssessment.id, rank: localizationAssessment.rank });
      insertedAssessments.push(...written);
    }
  }

  // --- Narratives for the top slice only. ENQUEUED rather than written here: a model call
  //     inside this job would let one provider timeout roll back a whole country's ranking.
  const narrativeFailures: string[] = [];
  for (const assessment of insertedAssessments) {
    if (assessment.rank > NARRATIVE_RANK_LIMIT) {
      continue;
    }
    const enqueueResult = await sendJob(
      JOB_NAMES.generateLocalizationNarrative,
      { assessmentId: assessment.id },
      { idempotencyKey: idempotencyKeyFor.generateLocalizationNarrative(assessment.id) },
    );
    if (!enqueueResult.success) {
      narrativeFailures.push(`${assessment.id} (${enqueueResult.error.type})`);
    }
  }

  if (narrativeFailures.length > 0) {
    throw new Error(
      `recompute-localization-assessments: ${narrativeFailures.length} narrative enqueue(s) failed — ${narrativeFailures.join(", ")}`,
    );
  }
}
