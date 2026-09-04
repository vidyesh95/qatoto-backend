/**
 * The Comtrade ingest job (§10A).
 *
 * ONE JOB RUN = ONE (country, year, direction). That is exactly one API call, because the
 * pinned query returns the country's whole HS6 picture in a single response — 5,052 rows
 * for India 2023. Splitting it finer would spend more of a 500/day budget for nothing;
 * splitting it coarser would make one failure lose a year of two directions.
 *
 * IT WRITES TWO TABLES. `import_commodity` is upserted first, because every flow row FKs
 * to it and the vocabulary is derived from the same response — the commodity labels are
 * the WCO's own `cmdDesc`, so nothing here is authored.
 *
 * EVERY RUN IS RECORDED, including the ones that did nothing. `comtrade_sync_run` is what
 * makes "the surface is empty" answerable: no key, no rows filed, or a provider error, and
 * the row says which. Without it an unconfigured environment and a country that genuinely
 * imports nothing look identical.
 */
import { and, eq, sql } from "drizzle-orm";

import { config } from "#src/config/index.js";
import { db } from "#src/db/index.js";
import {
  commodityTradeFlow,
  comtradeSyncRun,
  discoveryRegion,
  importCommodity,
  researchCategory,
} from "#src/db/schema.js";
import {
  JOB_NAMES,
  JOB_PAYLOAD_SCHEMAS,
  parseJobPayload,
  PermanentJobError,
} from "#src/lib/jobs.js";
import { comtradeReporterCodeFor } from "#src/modules/rnd/import-intelligence/comtrade-reporters.js";
import {
  fetchAnnualTradeFlows,
  type CommodityTradeRow,
  type TradeFlowKind,
} from "#src/modules/rnd/import-intelligence/comtrade.js";
import { classifyHsCode } from "#src/modules/rnd/import-intelligence/hs-chapter-map.js";

/** Named once so the sync run, the flow rows and the smoke script all agree. */
const COMTRADE_SOURCE_NAME = "UN Comtrade";
const COMTRADE_SOURCE_URL = "https://comtradeapi.un.org";

/**
 * Upserts the commodity vocabulary for the rows in this response, returning id-by-HS-code.
 *
 * `onConflictDoUpdate` on the label and NOT on the classification: the WCO occasionally
 * revises a description and the newest wording should win, but `research_category_id` is
 * this platform's editorial judgement (`hs-chapter-map.ts`) and re-deriving it on every
 * sync would silently overwrite a moderator's correction if one is ever added.
 */
async function upsertCommodities(rows: readonly CommodityTradeRow[]): Promise<{
  readonly commodityIdByHsCode: ReadonlyMap<string, string>;
  readonly skipped: number;
}> {
  const categoryRows = await db
    .select({ id: researchCategory.id, slug: researchCategory.slug })
    .from(researchCategory);
  const categoryIdBySlug = new Map(categoryRows.map((row) => [row.slug, row.id]));

  const values: {
    hsCode: string;
    label: string;
    commodityKind: (typeof importCommodity.$inferInsert)["commodityKind"];
    researchCategoryId: string;
    defaultQuantityUnit: (typeof importCommodity.$inferInsert)["defaultQuantityUnit"];
  }[] = [];
  const seenHsCodes = new Set<string>();
  let skipped = 0;

  for (const row of rows) {
    if (seenHsCodes.has(row.hsCode)) {
      continue;
    }
    const classification = classifyHsCode(row.hsCode);
    if (classification === null) {
      // A chapter the map has never seen. Skipped and counted rather than filed under a
      // nearest-guess category — see `hs-chapter-map.ts`.
      skipped += 1;
      continue;
    }
    const researchCategoryId = categoryIdBySlug.get(classification.researchCategorySlug);
    if (researchCategoryId === undefined) {
      // The map names a category nobody seeded. A permanent error, because retrying
      // cannot create it and a silent skip would lose a whole chapter of trade.
      throw new PermanentJobError(
        "COMTRADE_CATEGORY_MISSING",
        `hs-chapter-map names research category "${classification.researchCategorySlug}", which is not seeded`,
      );
    }
    seenHsCodes.add(row.hsCode);
    values.push({
      hsCode: row.hsCode,
      label: row.commodityLabel,
      commodityKind: classification.commodityKind,
      researchCategoryId,
      defaultQuantityUnit: row.quantityUnit,
    });
  }

  if (values.length > 0) {
    await db
      .insert(importCommodity)
      .values(values)
      .onConflictDoUpdate({
        target: importCommodity.hsCode,
        set: {
          label: sql`excluded.label`,
          updatedAt: sql`now()`,
        },
      });
  }

  const stored = await db
    .select({ id: importCommodity.id, hsCode: importCommodity.hsCode })
    .from(importCommodity);

  return {
    commodityIdByHsCode: new Map(stored.map((row) => [row.hsCode, row.id])),
    skipped,
  };
}

/**
 * Writes the flow rows.
 *
 * ⚠️ `onConflictDoUpdate` TARGETS THE PARTIAL UNIQUE, and the `where` clause is not
 * optional — Postgres matches an ON CONFLICT arbiter to a partial index only when the
 * predicate is restated. Without it the statement raises "no unique or exclusion
 * constraint matching the ON CONFLICT specification" at runtime, which is the sort of
 * thing that only shows up against a real database.
 */
async function upsertTradeFlows(
  rows: readonly CommodityTradeRow[],
  context: {
    readonly commodityIdByHsCode: ReadonlyMap<string, string>;
    readonly reporterRegionId: string;
    readonly flowKind: TradeFlowKind;
    readonly periodYear: number;
    readonly retrievedAt: Date;
  },
): Promise<number> {
  const periodStartsDate = `${context.periodYear}-01-01`;
  const periodEndsDate = `${context.periodYear}-12-31`;

  const values = rows.flatMap((row) => {
    const commodityId = context.commodityIdByHsCode.get(row.hsCode);
    if (commodityId === undefined) {
      return [];
    }
    return [
      {
        commodityId,
        reporterRegionId: context.reporterRegionId,
        partnerRegionId: null,
        flowKind: context.flowKind,
        periodKind: "annual" as const,
        periodStartsDate,
        periodEndsDate,
        tradeValueInCents: row.tradeValueInCents,
        currency: row.currency,
        netWeightMilliKilograms: row.netWeightMilliKilograms,
        quantityMilli: row.quantityMilli,
        quantityUnit: row.quantityUnit,
        quantityUnitCode: row.quantityUnitCode,
        isReported: row.isReported,
        isAggregate: row.isAggregate,
        isNetWeightEstimated: row.isNetWeightEstimated,
        isQuantityEstimated: row.isQuantityEstimated,
        legacyEstimationFlag: row.legacyEstimationFlag,
        sourceName: COMTRADE_SOURCE_NAME,
        sourceUrl: COMTRADE_SOURCE_URL,
        sourceRetrievedAt: context.retrievedAt,
        dataOrigin: "comtrade_api" as const,
      },
    ];
  });

  if (values.length === 0) {
    return 0;
  }

  // Chunked because a single INSERT of 5,000 rows with 22 columns each exceeds the
  // parameter ceiling a Postgres protocol message can carry.
  const CHUNK_SIZE = 500;
  let written = 0;
  for (let offset = 0; offset < values.length; offset += CHUNK_SIZE) {
    const chunk = values.slice(offset, offset + CHUNK_SIZE);
    await db
      .insert(commodityTradeFlow)
      .values(chunk)
      .onConflictDoUpdate({
        target: [
          commodityTradeFlow.commodityId,
          commodityTradeFlow.reporterRegionId,
          commodityTradeFlow.flowKind,
          commodityTradeFlow.periodKind,
          commodityTradeFlow.periodStartsDate,
        ],
        targetWhere: sql`partner_region_id IS NULL`,
        set: {
          tradeValueInCents: sql`excluded.trade_value_in_cents`,
          netWeightMilliKilograms: sql`excluded.net_weight_milli_kilograms`,
          quantityMilli: sql`excluded.quantity_milli`,
          quantityUnit: sql`excluded.quantity_unit`,
          quantityUnitCode: sql`excluded.quantity_unit_code`,
          isReported: sql`excluded.is_reported`,
          isAggregate: sql`excluded.is_aggregate`,
          isNetWeightEstimated: sql`excluded.is_net_weight_estimated`,
          isQuantityEstimated: sql`excluded.is_quantity_estimated`,
          legacyEstimationFlag: sql`excluded.legacy_estimation_flag`,
          sourceRetrievedAt: sql`excluded.source_retrieved_at`,
          updatedAt: sql`now()`,
        },
      });
    written += chunk.length;
  }
  return written;
}

/**
 * Fetches and stores one country-year-direction.
 *
 * FAILURE HANDLING FOLLOWS §4e's split exactly: a retryable provider fault THROWS so
 * pg-boss backs off, and a permanent one writes a terminal `comtrade_sync_run` row and
 * returns. "No key configured" is neither — it is `skipped_unconfigured`, recorded and
 * returned, because there is nothing to retry and nothing has gone wrong.
 */
export async function handleSyncComtradeTradeFlows(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.syncComtradeTradeFlows,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.syncComtradeTradeFlows],
    rawPayload,
  );
  const requestedAt = new Date();

  // The region is resolved here rather than in the tick, so the tick needs no database
  // connection. `kind = 'country'` is asserted rather than assumed: a macro-region row
  // could carry a stray country code and would then be ingested as if it were a country.
  const [region] = await db
    .select({ id: discoveryRegion.id, countryCode: discoveryRegion.countryCode })
    .from(discoveryRegion)
    .where(
      and(
        eq(discoveryRegion.countryCode, payload.reporterCountryCode),
        eq(discoveryRegion.kind, "country"),
      ),
    )
    .limit(1);

  if (region === undefined) {
    throw new PermanentJobError(
      "COMTRADE_REGION_MISSING",
      `no discovery_region with kind='country' and country_code=${payload.reporterCountryCode}`,
    );
  }

  const reporterCode = comtradeReporterCodeFor(payload.reporterCountryCode);
  if (reporterCode === null) {
    throw new PermanentJobError(
      "COMTRADE_REPORTER_UNMAPPED",
      `country code ${payload.reporterCountryCode} is not mapped in comtrade-reporters.ts`,
    );
  }

  const fetched = await fetchAnnualTradeFlows(
    {
      reporterCode,
      periodYear: payload.periodYear,
      flowKind: payload.flowKind,
    },
    {
      subscriptionKey: config.COMTRADE_DEVELOPER_UN_ORG_PRIMARY_KEY,
      timeoutMs: config.COMTRADE_TIMEOUT_MS,
    },
  );

  if (!fetched.success) {
    if (fetched.error.type === "COMTRADE_NOT_CONFIGURED") {
      await db.insert(comtradeSyncRun).values({
        reporterRegionId: region.id,
        periodYear: payload.periodYear,
        flowKind: payload.flowKind,
        status: "skipped_unconfigured",
        requestedAt,
        completedAt: new Date(),
      });
      return;
    }

    if (fetched.error.type === "COMTRADE_UNAVAILABLE") {
      // Retryable. No terminal row: the run has not finished, and writing `failed` here
      // would make a transient 503 indistinguishable from a rejected query.
      throw new Error(`sync-comtrade-trade-flows: ${fetched.error.detail}`);
    }

    const detail =
      fetched.error.type === "COMTRADE_REQUEST_REJECTED"
        ? fetched.error.detail
        : fetched.error.issues.join("; ");
    await db.insert(comtradeSyncRun).values({
      reporterRegionId: region.id,
      periodYear: payload.periodYear,
      flowKind: payload.flowKind,
      status: "failed",
      requestedAt,
      completedAt: new Date(),
      errorDetail: `${fetched.error.type}: ${detail}`.slice(0, 2000),
    });
    return;
  }

  const { commodityIdByHsCode, skipped } = await upsertCommodities(fetched.value.rows);
  const rowsUpserted = await upsertTradeFlows(fetched.value.rows, {
    commodityIdByHsCode,
    reporterRegionId: region.id,
    flowKind: payload.flowKind,
    periodYear: payload.periodYear,
    retrievedAt: fetched.value.retrievedAt,
  });

  const unknownUnitCodes = fetched.value.unknownQuantityUnitCodes;
  await db.insert(comtradeSyncRun).values({
    reporterRegionId: region.id,
    periodYear: payload.periodYear,
    flowKind: payload.flowKind,
    status: "succeeded",
    requestedAt,
    completedAt: new Date(),
    rowsFetched: fetched.value.rowsReceived,
    rowsUpserted,
    // A successful run that dropped rows still says so, AND names why. A silent skip is
    // how a chapter goes missing for a year without anyone noticing; a skip counted but
    // not named costs an API call to diagnose.
    errorDetail:
      skipped === 0 && unknownUnitCodes.length === 0
        ? null
        : [
            skipped === 0 ? null : `${skipped} row(s) skipped: unmapped HS chapter`,
            unknownUnitCodes.length === 0
              ? null
              : `rows skipped for unknown quantity unit code(s): ${unknownUnitCodes.join(", ")}`,
          ]
            .filter((part): part is string => part !== null)
            .join("; "),
  });
}
