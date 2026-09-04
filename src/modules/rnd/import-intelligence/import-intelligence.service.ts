/**
 * §11m reads and writes.
 *
 * THE CAPABILITY CHECK IS THE FIRST STATEMENT OF EVERY WRITE, before any id is read.
 * That ordering is the whole guarantee: a 403 decided after a lookup tells the caller
 * whether the id exists, so the refusal itself becomes an oracle. It is `moderate_taxonomy`
 * rather than `moderate_content` because this is curated reference data — the same
 * capability that governs `market_insight`, `discovery_skill` and `discovery_region`.
 *
 * MONEY LEAVES AS A DECIMAL STRING. `trade_value_in_cents` is `bigint` and India's largest
 * commodity line is 14,038,629,964,550 cents; the column already exceeds anything an int4
 * could hold, and a JSON number would hand the client a float to round. node-postgres
 * gives them to us as strings and they stay strings all the way out (§4b).
 */
import { and, asc, count, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { deterministicJobId, idempotencyKeyFor, JOB_NAMES, sendJob } from "#src/lib/jobs.js";
import {
  commodityTradeFlow,
  discoveryRegion,
  domesticSubstituteMapping,
  importCommodity,
  localizationAssessment,
  localizationPathwaySuggestion,
  researchCategory,
  supplierCapability,
} from "#src/db/schema.js";
import {
  requirePlatformCapability,
  type PlatformAccessError,
} from "#src/modules/platform/roles/platform-role.service.js";
import {
  MANUFACTURED_COMMODITY_KINDS,
  type CreateDomesticSubstituteInput,
  type DecidePathwaySuggestionInput,
  type ListImportCommoditiesQuery,
  type ListLocalizationAssessmentGridQuery,
  type ListLocalizationAssessmentsQuery,
  type ListSubstitutesQuery,
  type ListTradeFlowsQuery,
  type UpdateDomesticSubstituteInput,
} from "#src/modules/rnd/import-intelligence/import-intelligence.schemas.js";
import type { Result } from "#src/types/index.js";

export type ImportIntelligenceError =
  | PlatformAccessError
  | { type: "COMMODITY_NOT_FOUND"; hsCode: string }
  | { type: "REGION_NOT_FOUND"; regionSlug: string }
  | { type: "SUPPLIER_CAPABILITY_NOT_FOUND"; capabilitySlug: string }
  | { type: "SUBSTITUTE_NOT_FOUND"; substituteId: string }
  | { type: "SUBSTITUTE_ALREADY_MAPPED"; substituteLabel: string }
  | { type: "SUGGESTION_NOT_FOUND"; suggestionId: string }
  | { type: "SUGGESTION_ALREADY_DECIDED"; suggestionId: string }
  | { type: "ASSESSMENT_NOT_FOUND"; assessmentId: string }
  /** The queue refused the job. NOT a model failure — nothing has been asked of it yet. */
  | { type: "PATHWAY_ENQUEUE_FAILED"; assessmentId: string; detail: string };

export interface ImportCommodityView {
  readonly hsCode: string;
  readonly displayLabel: string;
  readonly descriptionText: string | null;
  readonly commodityKind: string;
  readonly researchCategoryId: string;
  readonly researchCategorySlug: string;
  readonly defaultQuantityUnit: string;
}

export interface CommodityTradeFlowView {
  readonly id: string;
  readonly flowKind: string;
  readonly periodKind: string;
  readonly periodStartsDate: string;
  readonly periodEndsDate: string;
  /** Integer cents as a decimal STRING. Parse with BigInt, never Number. */
  readonly tradeValueInCents: string;
  readonly currency: string;
  /** NULL where the reporter filed none. Never zero-filled. */
  readonly netWeightMilliKilograms: string | null;
  readonly quantityMilli: string | null;
  readonly quantityUnit: string;
  readonly reporterCountryCode: string | null;
  readonly reporterRegionSlug: string;
  /** Estimation provenance — a mirrored estimate is not a reported figure. */
  readonly isReported: boolean;
  readonly isAggregate: boolean;
  readonly isNetWeightEstimated: boolean;
  readonly isQuantityEstimated: boolean;
  readonly sourceName: string;
  readonly sourceUrl: string | null;
  readonly sourceRetrievedAt: Date;
}

export interface DomesticSubstituteView {
  readonly id: string;
  readonly hsCode: string;
  readonly regionSlug: string;
  readonly substituteKind: string;
  readonly substituteLabel: string;
  readonly substituteNotes: string | null;
  readonly supplierCapabilitySlug: string | null;
  readonly maturityLevel: string;
  readonly evidenceSourceName: string | null;
  readonly evidenceSourceUrl: string | null;
  readonly publishedAt: Date | null;
}

export interface LocalizationPathwaySuggestionView {
  readonly id: string;
  readonly title: string;
  readonly bodyText: string;
  readonly status: string;
  /** Provenance is never optional — a machine opinion with a hidden origin reads as a ruling. */
  readonly modelName: string;
  readonly modelVersion: string | null;
  readonly promptVersion: string;
  /** NULL means NO CONFIDENCE WAS RECORDED. It is not zero confidence. */
  readonly confidenceBps: number | null;
  /**
   * The model's capital band, in cents, as a DECIMAL STRING — or NULL throughout.
   *
   * ⚠️ AN ESTIMATE, NOT A QUOTE, and the only model-supplied number this surface returns.
   * NULL means the model declined to estimate, which is a legal and expected answer; it does
   * not mean the product is free to start. Any renderer must show `modelName`,
   * `promptVersion` and `asOf` beside it, and must never present it as a price.
   */
  readonly estimatedCapitalMinInCents: string | null;
  readonly estimatedCapitalMaxInCents: string | null;
  /** What scale was costed and what was excluded. Present exactly when the band is. */
  readonly capitalBasisText: string | null;
  readonly asOf: Date;
  readonly decidedAt: Date | null;
  readonly decisionNote: string | null;
}

export interface LocalizationAssessmentView {
  readonly id: string;
  readonly hsCode: string;
  readonly commodityLabel: string;
  readonly commodityKind: string;
  readonly regionSlug: string;
  readonly regionCountryCode: string | null;
  readonly feasibilityScorePoints: number;
  readonly rank: number;
  readonly trendDirection: string;
  readonly previousFeasibilityScorePoints: number | null;
  readonly importDependencyPoints: number;
  readonly exportCapabilityPoints: number;
  readonly substituteAvailabilityPoints: number;
  readonly supplierCapacityPoints: number;
  readonly leadTimeAdvantagePoints: number;
  readonly observedImportValueInCents: string;
  readonly observedExportValueInCents: string;
  readonly currency: string;
  readonly substituteCount: number;
  readonly matchedSupplierCount: number;
  readonly verifiedSupplierCount: number;
  /** NULL is "no supplier published one", never zero days. */
  readonly medianSupplierLeadTimeDays: number | null;
  readonly narrativeStatus: string;
  readonly scoreAlgorithmVersion: number;
  /** Rendered by every surface that shows a derived number (§10A). */
  readonly asOf: Date;
}

export interface PagedResult<TRow> {
  readonly rows: readonly TRow[];
  readonly total: number;
}

/** Selected once so every commodity read returns the same shape. */
const COMMODITY_VIEW_COLUMNS = {
  hsCode: importCommodity.hsCode,
  displayLabel: importCommodity.label,
  descriptionText: importCommodity.descriptionText,
  commodityKind: importCommodity.commodityKind,
  researchCategoryId: importCommodity.researchCategoryId,
  researchCategorySlug: researchCategory.slug,
  defaultQuantityUnit: importCommodity.defaultQuantityUnit,
} as const;

function offsetFor(page: number, limit: number): number {
  return (page - 1) * limit;
}

/**
 * One country that actually has trade data, and how much of it.
 *
 * WHY IT EXISTS: eighteen countries are seeded in `discovery_region` and exactly one has been
 * ingested. A picker built off the region taxonomy would offer seventeen dead ends, so this
 * read answers "which countries can I actually ask about" rather than "which countries exist".
 * The counts ride along so a chip can say how much is behind it before it is clicked.
 */
export interface ImportReporterView {
  readonly countryCode: string;
  readonly regionSlug: string;
  readonly displayLabel: string;
  readonly commodityCount: number;
  readonly flowCount: number;
  readonly earliestPeriodYear: number;
  readonly latestPeriodYear: number;
}

interface ImportReporterRow {
  readonly [column: string]: unknown;
  readonly country_code: string;
  readonly region_slug: string;
  readonly display_label: string;
  readonly commodity_count: number;
  readonly flow_count: number;
  readonly earliest_period_year: number;
  readonly latest_period_year: number;
}

/**
 * Unpaginated, deliberately: the ceiling is the number of countries ingested, which is a
 * product decision measured in ones. A page cursor over eighteen rows would be ceremony.
 *
 * `::int` on every count, because `count(*)` is `bigint` and would otherwise arrive as a
 * decimal string that a caller has to remember to parse.
 */
export async function listImportReporters(): Promise<readonly ImportReporterView[]> {
  const result = await db.execute<ImportReporterRow>(sql`
    SELECT g.country_code,
           g.slug  AS region_slug,
           g.label AS display_label,
           count(DISTINCT f.commodity_id)::int                        AS commodity_count,
           count(*)::int                                              AS flow_count,
           min(extract(year FROM f.period_starts_date))::int          AS earliest_period_year,
           max(extract(year FROM f.period_starts_date))::int          AS latest_period_year
    FROM commodity_trade_flow AS f
    JOIN discovery_region AS g ON g.id = f.reporter_region_id
    WHERE g.country_code IS NOT NULL
    GROUP BY g.country_code, g.slug, g.label
    ORDER BY commodity_count DESC, g.label ASC
  `);

  return result.rows.map((row) => ({
    countryCode: row.country_code,
    regionSlug: row.region_slug,
    displayLabel: row.display_label,
    commodityCount: row.commodity_count,
    flowCount: row.flow_count,
    earliestPeriodYear: row.earliest_period_year,
    latestPeriodYear: row.latest_period_year,
  }));
}

export async function listImportCommodities(
  filter: ListImportCommoditiesQuery,
): Promise<PagedResult<ImportCommodityView>> {
  const conditions: SQL[] = [eq(importCommodity.isActive, true)];

  if (filter.commodityKind !== undefined) {
    conditions.push(eq(importCommodity.commodityKind, filter.commodityKind));
  }
  if (filter.categoryId !== undefined) {
    conditions.push(eq(importCommodity.researchCategoryId, filter.categoryId));
  }
  if (filter.search !== undefined) {
    // Label OR code: a founder types "lithium" and an analyst types "850760", and both
    // are the same intention.
    const searchCondition = or(
      ilike(importCommodity.label, `%${filter.search}%`),
      ilike(importCommodity.hsCode, `${filter.search}%`),
    );
    if (searchCondition !== undefined) {
      conditions.push(searchCondition);
    }
  }
  if (filter.reporterCountryCode !== undefined) {
    // Only commodities this country actually trades. Applied as an EXISTS rather than a
    // join so the page count is a count of commodities, not of flow rows.
    conditions.push(
      sql`EXISTS (
        SELECT 1 FROM commodity_trade_flow AS f
        JOIN discovery_region AS fr ON fr.id = f.reporter_region_id
        WHERE f.commodity_id = ${importCommodity.id}
          AND fr.country_code = ${filter.reporterCountryCode}
      )`,
    );
  }

  const whereClause = and(...conditions);

  const [rows, [totalRow]] = await Promise.all([
    db
      .select(COMMODITY_VIEW_COLUMNS)
      .from(importCommodity)
      .innerJoin(researchCategory, eq(researchCategory.id, importCommodity.researchCategoryId))
      .where(whereClause)
      // Ends in a unique column, so the page boundary is stable (§4c rule 4).
      .orderBy(asc(importCommodity.label), asc(importCommodity.id))
      .limit(filter.limit)
      .offset(offsetFor(filter.page, filter.limit)),
    db.select({ value: count() }).from(importCommodity).where(whereClause),
  ]);

  return { rows, total: totalRow?.value ?? 0 };
}

export async function getImportCommodityByHsCode(
  hsCode: string,
): Promise<Result<ImportCommodityView, ImportIntelligenceError>> {
  const [row] = await db
    .select(COMMODITY_VIEW_COLUMNS)
    .from(importCommodity)
    .innerJoin(researchCategory, eq(researchCategory.id, importCommodity.researchCategoryId))
    .where(and(eq(importCommodity.hsCode, hsCode), eq(importCommodity.isActive, true)))
    .limit(1);

  if (row === undefined) {
    return { success: false, error: { type: "COMMODITY_NOT_FOUND", hsCode } };
  }
  return { success: true, value: row };
}

export async function listTradeFlowsForCommodity(
  hsCode: string,
  filter: ListTradeFlowsQuery,
): Promise<Result<PagedResult<CommodityTradeFlowView>, ImportIntelligenceError>> {
  const commodity = await getImportCommodityByHsCode(hsCode);
  if (!commodity.success) {
    return commodity;
  }

  const conditions: SQL[] = [
    eq(importCommodity.hsCode, hsCode),
    // The all-partners aggregate. Per-partner rows are representable but are not what a
    // localization question asks.
    sql`${commodityTradeFlow.partnerRegionId} IS NULL`,
  ];
  if (filter.flowKind !== undefined) {
    conditions.push(eq(commodityTradeFlow.flowKind, filter.flowKind));
  }
  if (filter.reporterCountryCode !== undefined) {
    conditions.push(eq(discoveryRegion.countryCode, filter.reporterCountryCode));
  }

  const whereClause = and(...conditions);
  const baseQuery = db
    .select({
      id: commodityTradeFlow.id,
      flowKind: commodityTradeFlow.flowKind,
      periodKind: commodityTradeFlow.periodKind,
      periodStartsDate: commodityTradeFlow.periodStartsDate,
      periodEndsDate: commodityTradeFlow.periodEndsDate,
      // ::text so a bigint never becomes a JSON number the client has to round.
      tradeValueInCents: sql<string>`${commodityTradeFlow.tradeValueInCents}::text`,
      currency: commodityTradeFlow.currency,
      netWeightMilliKilograms: sql<
        string | null
      >`${commodityTradeFlow.netWeightMilliKilograms}::text`,
      quantityMilli: sql<string | null>`${commodityTradeFlow.quantityMilli}::text`,
      quantityUnit: commodityTradeFlow.quantityUnit,
      reporterCountryCode: discoveryRegion.countryCode,
      reporterRegionSlug: discoveryRegion.slug,
      isReported: commodityTradeFlow.isReported,
      isAggregate: commodityTradeFlow.isAggregate,
      isNetWeightEstimated: commodityTradeFlow.isNetWeightEstimated,
      isQuantityEstimated: commodityTradeFlow.isQuantityEstimated,
      sourceName: commodityTradeFlow.sourceName,
      sourceUrl: commodityTradeFlow.sourceUrl,
      sourceRetrievedAt: commodityTradeFlow.sourceRetrievedAt,
    })
    .from(commodityTradeFlow)
    .innerJoin(importCommodity, eq(importCommodity.id, commodityTradeFlow.commodityId))
    .innerJoin(discoveryRegion, eq(discoveryRegion.id, commodityTradeFlow.reporterRegionId));

  const [rows, [totalRow]] = await Promise.all([
    baseQuery
      .where(whereClause)
      .orderBy(desc(commodityTradeFlow.periodStartsDate), asc(commodityTradeFlow.id))
      .limit(filter.limit)
      .offset(offsetFor(filter.page, filter.limit)),
    db
      .select({ value: count() })
      .from(commodityTradeFlow)
      .innerJoin(importCommodity, eq(importCommodity.id, commodityTradeFlow.commodityId))
      .innerJoin(discoveryRegion, eq(discoveryRegion.id, commodityTradeFlow.reporterRegionId))
      .where(whereClause),
  ]);

  return { success: true, value: { rows, total: totalRow?.value ?? 0 } };
}

export async function listSubstitutesForCommodity(
  hsCode: string,
  filter: ListSubstitutesQuery,
  options: { readonly includeDrafts: boolean },
): Promise<Result<PagedResult<DomesticSubstituteView>, ImportIntelligenceError>> {
  const commodity = await getImportCommodityByHsCode(hsCode);
  if (!commodity.success) {
    return commodity;
  }

  const conditions: SQL[] = [eq(importCommodity.hsCode, hsCode)];
  if (!options.includeDrafts) {
    // A draft is not evidence, and it is not visible to anyone but a moderator.
    conditions.push(sql`${domesticSubstituteMapping.publishedAt} IS NOT NULL`);
  }
  if (filter.regionCountryCode !== undefined) {
    conditions.push(eq(discoveryRegion.countryCode, filter.regionCountryCode));
  }

  const whereClause = and(...conditions);
  const joined = db
    .select({
      id: domesticSubstituteMapping.id,
      hsCode: importCommodity.hsCode,
      regionSlug: discoveryRegion.slug,
      substituteKind: domesticSubstituteMapping.substituteKind,
      substituteLabel: domesticSubstituteMapping.substituteLabel,
      substituteNotes: domesticSubstituteMapping.substituteNotes,
      supplierCapabilitySlug: supplierCapability.slug,
      maturityLevel: domesticSubstituteMapping.maturityLevel,
      evidenceSourceName: domesticSubstituteMapping.evidenceSourceName,
      evidenceSourceUrl: domesticSubstituteMapping.evidenceSourceUrl,
      publishedAt: domesticSubstituteMapping.publishedAt,
    })
    .from(domesticSubstituteMapping)
    .innerJoin(importCommodity, eq(importCommodity.id, domesticSubstituteMapping.commodityId))
    .innerJoin(discoveryRegion, eq(discoveryRegion.id, domesticSubstituteMapping.regionId))
    // LEFT: a substitute no curated capability covers yet is a real finding, not a gap.
    .leftJoin(
      supplierCapability,
      eq(supplierCapability.id, domesticSubstituteMapping.supplierCapabilityId),
    );

  const [rows, [totalRow]] = await Promise.all([
    joined
      .where(whereClause)
      .orderBy(asc(domesticSubstituteMapping.substituteLabel), asc(domesticSubstituteMapping.id))
      .limit(filter.limit)
      .offset(offsetFor(filter.page, filter.limit)),
    db
      .select({ value: count() })
      .from(domesticSubstituteMapping)
      .innerJoin(importCommodity, eq(importCommodity.id, domesticSubstituteMapping.commodityId))
      .innerJoin(discoveryRegion, eq(discoveryRegion.id, domesticSubstituteMapping.regionId))
      .where(whereClause),
  ]);

  return { success: true, value: { rows, total: totalRow?.value ?? 0 } };
}

/**
 * The leaderboard: the newest `asOf` only.
 *
 * ⚠️ EVIDENCE-FREE ROWS ARE EXCLUDED HERE, NOT SORTED DOWN. The score's inverted lead-time
 * component and its zero floor mean a cell with no trade at all still produces a number,
 * and `localization-feasibility-score.ts` records that a leaderboard must filter before it
 * ranks rather than trusting the arithmetic to bury them.
 */
/**
 * The population BOTH the ranked leaderboard and the score grid describe.
 *
 * ⚠️ SHARED ON PURPOSE. `listLocalizationAssessmentGrid` renders as a density plot whose
 * cell counts a reader will compare against the leaderboard's `pagination.total`. If the
 * two built their own `where` clauses, a later edit to one — a new exclusion, a different
 * `asOf` rule — would silently make a chart that claims to hold 5,469 commodities disagree
 * with the list that holds 5,469 commodities, and nothing would fail.
 */
function localizationAssessmentPopulation(
  // The grid query is the assessments query minus `page`/`limit`, so this covers both
  // without widening `commodityKind` to `string` — the column is a `pgEnum` and a widened
  // literal is a compile error at the `eq()`, which is the check doing its job.
  filter: ListLocalizationAssessmentGridQuery,
): SQL | undefined {
  const conditions: SQL[] = [
    sql`${localizationAssessment.asOf} = (SELECT max(as_of) FROM localization_assessment)`,
    sql`${localizationAssessment.observedImportValueInCents} > 0`,
  ];
  if (filter.reporterCountryCode !== undefined) {
    conditions.push(eq(discoveryRegion.countryCode, filter.reporterCountryCode));
  }
  if (filter.commodityKind !== undefined) {
    conditions.push(eq(importCommodity.commodityKind, filter.commodityKind));
  }
  if (filter.manufacturedOnly === true) {
    // Applied in SQL, so a page of 50 is 50 manufactured rows rather than 50 rows of which
    // some are petroleum.
    conditions.push(inArray(importCommodity.commodityKind, MANUFACTURED_COMMODITY_KINDS));
  }
  return and(...conditions);
}

export async function listLocalizationAssessments(
  filter: ListLocalizationAssessmentsQuery,
): Promise<PagedResult<LocalizationAssessmentView>> {
  const whereClause = localizationAssessmentPopulation(filter);
  const joined = db
    .select({
      id: localizationAssessment.id,
      hsCode: importCommodity.hsCode,
      commodityLabel: importCommodity.label,
      commodityKind: importCommodity.commodityKind,
      regionSlug: discoveryRegion.slug,
      regionCountryCode: discoveryRegion.countryCode,
      feasibilityScorePoints: localizationAssessment.feasibilityScorePoints,
      rank: localizationAssessment.rank,
      trendDirection: localizationAssessment.trendDirection,
      previousFeasibilityScorePoints: localizationAssessment.previousFeasibilityScorePoints,
      importDependencyPoints: localizationAssessment.importDependencyPoints,
      exportCapabilityPoints: localizationAssessment.exportCapabilityPoints,
      substituteAvailabilityPoints: localizationAssessment.substituteAvailabilityPoints,
      supplierCapacityPoints: localizationAssessment.supplierCapacityPoints,
      leadTimeAdvantagePoints: localizationAssessment.leadTimeAdvantagePoints,
      observedImportValueInCents: sql<string>`${localizationAssessment.observedImportValueInCents}::text`,
      observedExportValueInCents: sql<string>`${localizationAssessment.observedExportValueInCents}::text`,
      currency: localizationAssessment.currency,
      substituteCount: localizationAssessment.substituteCount,
      matchedSupplierCount: localizationAssessment.matchedSupplierCount,
      verifiedSupplierCount: localizationAssessment.verifiedSupplierCount,
      medianSupplierLeadTimeDays: localizationAssessment.medianSupplierLeadTimeDays,
      narrativeStatus: localizationAssessment.narrativeStatus,
      scoreAlgorithmVersion: localizationAssessment.scoreAlgorithmVersion,
      asOf: localizationAssessment.asOf,
    })
    .from(localizationAssessment)
    .innerJoin(importCommodity, eq(importCommodity.id, localizationAssessment.commodityId))
    .innerJoin(discoveryRegion, eq(discoveryRegion.id, localizationAssessment.regionId));

  const [rows, [totalRow]] = await Promise.all([
    joined
      .where(whereClause)
      .orderBy(asc(localizationAssessment.rank), asc(localizationAssessment.id))
      .limit(filter.limit)
      .offset(offsetFor(filter.page, filter.limit)),
    db
      .select({ value: count() })
      .from(localizationAssessment)
      .innerJoin(importCommodity, eq(importCommodity.id, localizationAssessment.commodityId))
      .innerJoin(discoveryRegion, eq(discoveryRegion.id, localizationAssessment.regionId))
      .where(whereClause),
  ]);

  return { rows, total: totalRow?.value ?? 0 };
}

/**
 * One cell of the score grid: how many commodities scored this exact pair of components.
 *
 * `asOf` repeats on every cell and is the same instant throughout — the population is
 * pinned to a single `max(as_of)`. It rides along so a caller can date the chart without a
 * second read, which is what `listLocalizationAssessments` already does per row.
 */
export interface LocalizationAssessmentGridCellView {
  readonly importDependencyPoints: number;
  readonly exportCapabilityPoints: number;
  readonly commodityCount: number;
  readonly asOf: Date;
}

/**
 * The whole distribution, counted per score cell.
 *
 * ⚠️ WHY THIS EXISTS RATHER THAN A BIGGER `limit`. The leaderboard is rank-ordered, so its
 * first page is by construction the top-right corner of the score space — plotting it and
 * calling it a scatter draws the answer and hides the question. The real distribution of
 * India's 5,469 scored commodities is 75% "neither", 12% "already made here", 6% "bought
 * heavily, nobody makes it" and 6% in the corner worth starting in, and none of that is
 * visible from any single page of a ranking.
 *
 * It is complete rather than sampled because both grouping keys are nine-rung ladders: at
 * most 81 rows describe every commodity there will ever be. That is why the query schema
 * carries no `page` and no `limit`.
 *
 * ⚠️ QUERY BUILDER, NOT `db.execute`. Raw SQL bypasses the global `pg` type parser and
 * would hand back `as_of` as a naive timestamp STRING — the trap that already cost a
 * five-and-a-half-hour offset elsewhere in this module. `count()` is mapped to a number by
 * Drizzle for the same reason.
 */
export async function listLocalizationAssessmentGrid(
  filter: ListLocalizationAssessmentGridQuery,
): Promise<readonly LocalizationAssessmentGridCellView[]> {
  const rows = await db
    .select({
      importDependencyPoints: localizationAssessment.importDependencyPoints,
      exportCapabilityPoints: localizationAssessment.exportCapabilityPoints,
      commodityCount: count(),
      asOf: localizationAssessment.asOf,
    })
    .from(localizationAssessment)
    .innerJoin(importCommodity, eq(importCommodity.id, localizationAssessment.commodityId))
    .innerJoin(discoveryRegion, eq(discoveryRegion.id, localizationAssessment.regionId))
    .where(localizationAssessmentPopulation(filter))
    .groupBy(
      localizationAssessment.importDependencyPoints,
      localizationAssessment.exportCapabilityPoints,
      // Grouped, not aggregated: the population is already pinned to one `max(as_of)`, so
      // this adds no rows and keeps the column legal without a `max()` that would imply
      // the cells could span instants.
      localizationAssessment.asOf,
    )
    .orderBy(
      asc(localizationAssessment.importDependencyPoints),
      asc(localizationAssessment.exportCapabilityPoints),
    );

  return rows;
}

/**
 * What a pathway request answered.
 *
 * `already_generated` is a 200 carrying the existing row; `queued` is a 202 carrying nothing
 * — the verdict does not exist yet and pretending otherwise on this surface would be an
 * optimistic capital estimate.
 */
export type RequestPathwayOutcome =
  | { readonly kind: "already_generated" }
  | { readonly kind: "queued" };

/**
 * Ask for one assessment's pathway narrative and capital band.
 *
 * ⚠️ THIS SPENDS A METERED MODEL CALL, WHICH IS WHY ITS ROUTE IS THE ONLY NON-PUBLIC ONE IN
 * §11m. Every read here is mounted behind `attachOptionalUser` and answers a signed-out
 * caller; this one sits behind `requireAuth` plus the write limiter, because an anonymous
 * endpoint that bills the platform per request is a denial-of-wallet rather than a feature.
 *
 * ⚠️ IT ENQUEUES; IT DOES NOT GENERATE. A provider call inside a request handler would hold
 * an HTTP connection open for the model's latency and lose the work on any timeout. The job
 * carries the SAME idempotency key `recompute-localization-assessments` uses, so a
 * double-click, a retry and the nightly recompute all collapse into one job for one
 * assessment.
 *
 * A row already `generated` short-circuits before the enqueue: regenerating prose somebody is
 * reading, to say the same thing at the same `asOf`, spends a metered call to change nothing.
 */
/**
 * How many times one assessment may be re-queued after a dead-letter.
 *
 * Five, matching the queue's own retry count: past that the provider is not having a bad
 * minute, and clicking again is a way to spend money on the same failure.
 */
const PATHWAY_ATTEMPT_LIMIT = 5;

/**
 * The idempotency key for the NEXT attempt at one assessment's narrative.
 *
 * ⚠️ THIS EXISTS BECAUSE A DEAD-LETTERED JOB PERMANENTLY BLOCKS ITS OWN KEY, which is a trap
 * worth writing down. `sendJob` turns an idempotency key into the pg-boss job's PRIMARY KEY
 * (`deterministicJobId`), so a second send with the same key is deduplicated — and pg-boss
 * deduplicates against the row in ANY state, `failed` included, until it is archived. The
 * first version of this function passed the bare assessment id. The provider returned 503,
 * the job exhausted its retries, and every later request for that product was silently
 * swallowed: the button stayed, the panel waited, and no job would ever run again.
 *
 * So the key carries the ATTEMPT as well as the assessment. It is still deterministic — two
 * simultaneous clicks compute the same count and collapse into one job, which is what the key
 * is for — and it advances only when the previous attempt is genuinely dead.
 *
 * Reading `pgboss.job` directly is the coupling this accepts. The alternative is an attempt
 * counter on `localization_assessment`, which would be a schema change to mirror state the
 * queue already holds, and would drift from it the first time a job was purged by hand.
 */
async function nextPathwayIdempotencyKey(assessmentId: string): Promise<string> {
  for (let attempt = 1; attempt <= PATHWAY_ATTEMPT_LIMIT; attempt += 1) {
    const candidateKey =
      attempt === 1
        ? idempotencyKeyFor.generateLocalizationNarrative(assessmentId)
        : `${idempotencyKeyFor.generateLocalizationNarrative(assessmentId)}:retry-${String(attempt)}`;
    const candidateJobId = await deterministicJobId(candidateKey);

    const existing = await db.execute<{ state: string }>(
      sql`SELECT state::text AS state FROM pgboss.job WHERE id = ${candidateJobId} LIMIT 1`,
    );
    const existingState = existing.rows[0]?.state;

    // Free, or still alive. A live job is exactly what the key should collapse onto.
    if (existingState === undefined || existingState !== "failed") return candidateKey;
  }

  // Every attempt is used up. The last key is returned rather than throwing: the send will
  // deduplicate into the dead job and answer 202, which is the truthful "queued, and it is
  // not moving" — the panel's give-up copy already says to come back later without blaming
  // a cause it cannot see.
  return `${idempotencyKeyFor.generateLocalizationNarrative(assessmentId)}:retry-${String(PATHWAY_ATTEMPT_LIMIT)}`;
}

export async function requestPathwayNarrative(
  assessmentId: string,
): Promise<Result<RequestPathwayOutcome, ImportIntelligenceError>> {
  const [assessment] = await db
    .select({
      id: localizationAssessment.id,
      narrativeStatus: localizationAssessment.narrativeStatus,
    })
    .from(localizationAssessment)
    .where(eq(localizationAssessment.id, assessmentId))
    .limit(1);

  if (assessment === undefined) {
    return { success: false, error: { type: "ASSESSMENT_NOT_FOUND", assessmentId } };
  }

  if (assessment.narrativeStatus === "generated") {
    return { success: true, value: { kind: "already_generated" } };
  }

  // `failed` and `skipped_unconfigured` fall through to a re-enqueue on purpose: the first
  // is a provider problem worth retrying by hand, and the second means the key was missing
  // when it last ran and may not be now.
  const enqueueResult = await sendJob(
    JOB_NAMES.generateLocalizationNarrative,
    { assessmentId },
    { idempotencyKey: await nextPathwayIdempotencyKey(assessmentId) },
  );
  if (!enqueueResult.success) {
    return {
      success: false,
      error: { type: "PATHWAY_ENQUEUE_FAILED", assessmentId, detail: enqueueResult.error.type },
    };
  }

  return { success: true, value: { kind: "queued" } };
}

/** One commodity's newest assessment for one country, with its pathway suggestions. */
export async function getCommodityAssessment(
  hsCode: string,
  reporterCountryCode: string | undefined,
): Promise<{
  readonly assessment: LocalizationAssessmentView | null;
  readonly suggestions: readonly LocalizationPathwaySuggestionView[];
}> {
  const conditions: SQL[] = [eq(importCommodity.hsCode, hsCode)];
  if (reporterCountryCode !== undefined) {
    conditions.push(eq(discoveryRegion.countryCode, reporterCountryCode));
  }

  const [assessment] = await db
    .select({
      id: localizationAssessment.id,
      hsCode: importCommodity.hsCode,
      commodityLabel: importCommodity.label,
      commodityKind: importCommodity.commodityKind,
      regionSlug: discoveryRegion.slug,
      regionCountryCode: discoveryRegion.countryCode,
      feasibilityScorePoints: localizationAssessment.feasibilityScorePoints,
      rank: localizationAssessment.rank,
      trendDirection: localizationAssessment.trendDirection,
      previousFeasibilityScorePoints: localizationAssessment.previousFeasibilityScorePoints,
      importDependencyPoints: localizationAssessment.importDependencyPoints,
      exportCapabilityPoints: localizationAssessment.exportCapabilityPoints,
      substituteAvailabilityPoints: localizationAssessment.substituteAvailabilityPoints,
      supplierCapacityPoints: localizationAssessment.supplierCapacityPoints,
      leadTimeAdvantagePoints: localizationAssessment.leadTimeAdvantagePoints,
      observedImportValueInCents: sql<string>`${localizationAssessment.observedImportValueInCents}::text`,
      observedExportValueInCents: sql<string>`${localizationAssessment.observedExportValueInCents}::text`,
      currency: localizationAssessment.currency,
      substituteCount: localizationAssessment.substituteCount,
      matchedSupplierCount: localizationAssessment.matchedSupplierCount,
      verifiedSupplierCount: localizationAssessment.verifiedSupplierCount,
      medianSupplierLeadTimeDays: localizationAssessment.medianSupplierLeadTimeDays,
      narrativeStatus: localizationAssessment.narrativeStatus,
      scoreAlgorithmVersion: localizationAssessment.scoreAlgorithmVersion,
      asOf: localizationAssessment.asOf,
    })
    .from(localizationAssessment)
    .innerJoin(importCommodity, eq(importCommodity.id, localizationAssessment.commodityId))
    .innerJoin(discoveryRegion, eq(discoveryRegion.id, localizationAssessment.regionId))
    .where(and(...conditions))
    .orderBy(desc(localizationAssessment.asOf))
    .limit(1);

  if (assessment === undefined) {
    // 404 = "not computed yet", never four zeroes. The commodity read answers separately.
    return { assessment: null, suggestions: [] };
  }

  const suggestions = await db
    .select({
      id: localizationPathwaySuggestion.id,
      title: localizationPathwaySuggestion.title,
      bodyText: localizationPathwaySuggestion.bodyText,
      status: localizationPathwaySuggestion.status,
      modelName: localizationPathwaySuggestion.modelName,
      modelVersion: localizationPathwaySuggestion.modelVersion,
      promptVersion: localizationPathwaySuggestion.promptVersion,
      confidenceBps: localizationPathwaySuggestion.confidenceBps,
      // `::text`, like every other money column here — a bigint through JSON becomes a float.
      estimatedCapitalMinInCents: sql<
        string | null
      >`${localizationPathwaySuggestion.estimatedCapitalMinInCents}::text`,
      estimatedCapitalMaxInCents: sql<
        string | null
      >`${localizationPathwaySuggestion.estimatedCapitalMaxInCents}::text`,
      capitalBasisText: localizationPathwaySuggestion.capitalBasisText,
      asOf: localizationPathwaySuggestion.asOf,
      decidedAt: localizationPathwaySuggestion.decidedAt,
      decisionNote: localizationPathwaySuggestion.decisionNote,
    })
    .from(localizationPathwaySuggestion)
    .where(eq(localizationPathwaySuggestion.assessmentId, assessment.id))
    .orderBy(asc(localizationPathwaySuggestion.id));

  return { assessment, suggestions };
}

export async function createDomesticSubstitute(
  actorUserId: string,
  input: CreateDomesticSubstituteInput,
): Promise<Result<DomesticSubstituteView, ImportIntelligenceError>> {
  // FIRST. Before any id is read — see the module header.
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_taxonomy");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  const [commodity] = await db
    .select({ id: importCommodity.id })
    .from(importCommodity)
    .where(eq(importCommodity.hsCode, input.hsCode))
    .limit(1);
  if (commodity === undefined) {
    return { success: false, error: { type: "COMMODITY_NOT_FOUND", hsCode: input.hsCode } };
  }

  const [region] = await db
    .select({ id: discoveryRegion.id })
    .from(discoveryRegion)
    .where(eq(discoveryRegion.slug, input.regionSlug))
    .limit(1);
  if (region === undefined) {
    return { success: false, error: { type: "REGION_NOT_FOUND", regionSlug: input.regionSlug } };
  }

  let supplierCapabilityId: string | null = null;
  if (input.supplierCapabilitySlug !== undefined) {
    const [capability] = await db
      .select({ id: supplierCapability.id })
      .from(supplierCapability)
      .where(eq(supplierCapability.slug, input.supplierCapabilitySlug))
      .limit(1);
    if (capability === undefined) {
      return {
        success: false,
        error: {
          type: "SUPPLIER_CAPABILITY_NOT_FOUND",
          capabilitySlug: input.supplierCapabilitySlug,
        },
      };
    }
    supplierCapabilityId = capability.id;
  }

  const [inserted] = await db
    .insert(domesticSubstituteMapping)
    .values({
      commodityId: commodity.id,
      regionId: region.id,
      substituteKind: input.substituteKind,
      substituteLabel: input.substituteLabel,
      substituteNotes: input.substituteNotes ?? null,
      supplierCapabilityId,
      maturityLevel: input.maturityLevel,
      evidenceSourceName: input.evidenceSourceName ?? null,
      evidenceSourceUrl: input.evidenceSourceUrl ?? null,
      // The SERVER stamps when. The client says whether.
      publishedAt: input.isPublished ? new Date() : null,
      createdByUserId: actorUserId,
    })
    // A duplicate is a FINDING, not a retry: somebody already wrote this mapping and the
    // answer is to edit theirs, not to create a second one saying the same thing.
    .onConflictDoNothing({
      target: [
        domesticSubstituteMapping.commodityId,
        domesticSubstituteMapping.regionId,
        domesticSubstituteMapping.substituteLabel,
      ],
    })
    .returning({ id: domesticSubstituteMapping.id });

  if (inserted === undefined) {
    return {
      success: false,
      error: { type: "SUBSTITUTE_ALREADY_MAPPED", substituteLabel: input.substituteLabel },
    };
  }

  return readSubstituteById(inserted.id);
}

export async function updateDomesticSubstitute(
  actorUserId: string,
  substituteId: string,
  input: UpdateDomesticSubstituteInput,
): Promise<Result<DomesticSubstituteView, ImportIntelligenceError>> {
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_taxonomy");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  let supplierCapabilityId: string | null | undefined;
  if (input.supplierCapabilitySlug === null) {
    supplierCapabilityId = null;
  } else if (input.supplierCapabilitySlug !== undefined) {
    const [capability] = await db
      .select({ id: supplierCapability.id })
      .from(supplierCapability)
      .where(eq(supplierCapability.slug, input.supplierCapabilitySlug))
      .limit(1);
    if (capability === undefined) {
      return {
        success: false,
        error: {
          type: "SUPPLIER_CAPABILITY_NOT_FOUND",
          capabilitySlug: input.supplierCapabilitySlug,
        },
      };
    }
    supplierCapabilityId = capability.id;
  }

  const [updated] = await db
    .update(domesticSubstituteMapping)
    .set({
      ...(input.substituteKind === undefined ? {} : { substituteKind: input.substituteKind }),
      ...(input.substituteLabel === undefined ? {} : { substituteLabel: input.substituteLabel }),
      ...(input.substituteNotes === undefined ? {} : { substituteNotes: input.substituteNotes }),
      ...(supplierCapabilityId === undefined ? {} : { supplierCapabilityId }),
      ...(input.maturityLevel === undefined ? {} : { maturityLevel: input.maturityLevel }),
      ...(input.evidenceSourceName === undefined
        ? {}
        : { evidenceSourceName: input.evidenceSourceName }),
      ...(input.evidenceSourceUrl === undefined
        ? {}
        : { evidenceSourceUrl: input.evidenceSourceUrl }),
      // Unpublishing is how a mapping retires. There is no DELETE: a removed mapping
      // orphans every assessment that counted it.
      ...(input.isPublished === undefined
        ? {}
        : { publishedAt: input.isPublished ? new Date() : null }),
    })
    .where(eq(domesticSubstituteMapping.id, substituteId))
    .returning({ id: domesticSubstituteMapping.id });

  if (updated === undefined) {
    return { success: false, error: { type: "SUBSTITUTE_NOT_FOUND", substituteId } };
  }
  return readSubstituteById(updated.id);
}

async function readSubstituteById(
  substituteId: string,
): Promise<Result<DomesticSubstituteView, ImportIntelligenceError>> {
  const [row] = await db
    .select({
      id: domesticSubstituteMapping.id,
      hsCode: importCommodity.hsCode,
      regionSlug: discoveryRegion.slug,
      substituteKind: domesticSubstituteMapping.substituteKind,
      substituteLabel: domesticSubstituteMapping.substituteLabel,
      substituteNotes: domesticSubstituteMapping.substituteNotes,
      supplierCapabilitySlug: supplierCapability.slug,
      maturityLevel: domesticSubstituteMapping.maturityLevel,
      evidenceSourceName: domesticSubstituteMapping.evidenceSourceName,
      evidenceSourceUrl: domesticSubstituteMapping.evidenceSourceUrl,
      publishedAt: domesticSubstituteMapping.publishedAt,
    })
    .from(domesticSubstituteMapping)
    .innerJoin(importCommodity, eq(importCommodity.id, domesticSubstituteMapping.commodityId))
    .innerJoin(discoveryRegion, eq(discoveryRegion.id, domesticSubstituteMapping.regionId))
    .leftJoin(
      supplierCapability,
      eq(supplierCapability.id, domesticSubstituteMapping.supplierCapabilityId),
    )
    .where(eq(domesticSubstituteMapping.id, substituteId))
    .limit(1);

  if (row === undefined) {
    return { success: false, error: { type: "SUBSTITUTE_NOT_FOUND", substituteId } };
  }
  return { success: true, value: row };
}

/**
 * Records a human decision on a machine opinion.
 *
 * ADVISORY: nothing here writes a score, a rank or a trade figure. The row's whole purpose
 * is that a reader can see a suggestion was read and judged, and by whom.
 */
export async function decidePathwaySuggestion(
  actorUserId: string,
  suggestionId: string,
  input: DecidePathwaySuggestionInput,
): Promise<Result<LocalizationPathwaySuggestionView, ImportIntelligenceError>> {
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_taxonomy");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  const [existing] = await db
    .select({ id: localizationPathwaySuggestion.id, status: localizationPathwaySuggestion.status })
    .from(localizationPathwaySuggestion)
    .where(eq(localizationPathwaySuggestion.id, suggestionId))
    .limit(1);

  if (existing === undefined) {
    return { success: false, error: { type: "SUGGESTION_NOT_FOUND", suggestionId } };
  }
  // A second decision would erase the first reviewer's judgement silently. The 409 names
  // what happened so the caller can go and read it.
  if (existing.status !== "open") {
    return { success: false, error: { type: "SUGGESTION_ALREADY_DECIDED", suggestionId } };
  }

  const [decided] = await db
    .update(localizationPathwaySuggestion)
    .set({
      status: input.decision,
      decidedByUserId: actorUserId,
      decidedAt: new Date(),
      decisionNote: input.decisionNote ?? null,
    })
    // Re-checked in the UPDATE itself, so two concurrent decisions cannot both win.
    .where(
      and(
        eq(localizationPathwaySuggestion.id, suggestionId),
        eq(localizationPathwaySuggestion.status, "open"),
      ),
    )
    .returning({
      id: localizationPathwaySuggestion.id,
      title: localizationPathwaySuggestion.title,
      bodyText: localizationPathwaySuggestion.bodyText,
      status: localizationPathwaySuggestion.status,
      modelName: localizationPathwaySuggestion.modelName,
      modelVersion: localizationPathwaySuggestion.modelVersion,
      promptVersion: localizationPathwaySuggestion.promptVersion,
      confidenceBps: localizationPathwaySuggestion.confidenceBps,
      // `::text`, like every other money column here — a bigint through JSON becomes a float.
      estimatedCapitalMinInCents: sql<
        string | null
      >`${localizationPathwaySuggestion.estimatedCapitalMinInCents}::text`,
      estimatedCapitalMaxInCents: sql<
        string | null
      >`${localizationPathwaySuggestion.estimatedCapitalMaxInCents}::text`,
      capitalBasisText: localizationPathwaySuggestion.capitalBasisText,
      asOf: localizationPathwaySuggestion.asOf,
      decidedAt: localizationPathwaySuggestion.decidedAt,
      decisionNote: localizationPathwaySuggestion.decisionNote,
    });

  if (decided === undefined) {
    return { success: false, error: { type: "SUGGESTION_ALREADY_DECIDED", suggestionId } };
  }
  return { success: true, value: decided };
}
