import { eq, sql } from "drizzle-orm";

import { config } from "#src/config/index.js";
import { db } from "#src/db/index.js";
import {
  countryBusinessReadyScore,
  countryEconomicIndicator,
  discoveryRegion,
} from "#src/db/schema.js";
import {
  JOB_NAMES,
  JOB_PAYLOAD_SCHEMAS,
  parseJobPayload,
  PermanentJobError,
} from "#src/lib/jobs.js";
import {
  BUSINESS_READY_REGULATORY_FRAMEWORK_INDICATOR_CODE,
  fetchIndicatorSeries,
  GDP_PER_CAPITA_PPP_INDICATOR_CODE,
  type IndicatorSeriesQuery,
  type IndicatorSeriesResult,
} from "#src/modules/rnd/discovery/world-bank.js";

/** Named once so the indicator rows, the readout and the API response all agree. */
export const WORLD_BANK_GDP_PPP_SOURCE_NAME =
  "World Bank — GDP per capita, PPP (NY.GDP.PCAP.PP.CD)";

export const WORLD_BANK_BUSINESS_READY_SOURCE_NAME =
  "World Bank — B-READY, Pillar 1: Regulatory Framework (IC.BRE.P1.RF)";

/** B-READY scores are 0–100, stored in tenths; see `country_business_ready_score`. */
const MAXIMUM_BUSINESS_READY_SCORE_IN_TENTHS = 1000;

/**
 * Five years per country: enough that a country whose latest year is unpublished still has a
 * recent value, and that a revision to any of those years is picked up.
 */
const MOST_RECENT_YEARS = 5;

export interface WorldBankSyncSummary {
  readonly countryCount: number;
  readonly observationsUpserted: number;
  readonly countriesWithNoValue: readonly string[];
  readonly businessReadyScoresUpserted: number;
  /** Not covered by any B-READY edition the API carries yet — India and Kenya until 2026. */
  readonly countriesWithNoBusinessReadyScore: readonly string[];
}

/**
 * Fetches one series and turns every failure into the job's error contract: a retryable fault
 * THROWS so pg-boss backs off, a contract violation is a `PermanentJobError`.
 */
async function fetchIndicatorSeriesOrThrow(
  query: IndicatorSeriesQuery,
): Promise<IndicatorSeriesResult> {
  const fetched = await fetchIndicatorSeries(query, { timeoutMs: config.WORLD_BANK_TIMEOUT_MS });
  if (fetched.success) return fetched.value;
  switch (fetched.error.type) {
    case "WORLD_BANK_UNAVAILABLE":
      throw new Error(
        `sync-world-bank-indicators (${query.indicatorCode}): ${fetched.error.detail}`,
      );
    case "WORLD_BANK_REQUEST_REJECTED":
      throw new PermanentJobError("WORLD_BANK_REQUEST_REJECTED", fetched.error.detail);
    case "WORLD_BANK_SCHEMA_INVALID":
      throw new PermanentJobError(
        "WORLD_BANK_SCHEMA_INVALID",
        fetched.error.issues.slice(0, 5).join("; "),
      );
    default: {
      const exhaustiveCheck: never = fetched.error;
      return exhaustiveCheck;
    }
  }
}

/**
 * Pulls GDP per capita (PPP) and the B-READY regulatory framework score for every seeded
 * country — ONE request per series — and upserts both.
 *
 * FAILURE HANDLING follows the Comtrade job: a retryable fault THROWS so pg-boss backs off, a
 * contract violation is a `PermanentJobError`. There is no "not configured" arm — the API is
 * keyless. A country the World Bank publishes nothing for is reported in the summary, not
 * written as zero.
 *
 * Upsert on `(region, indicator, year)`: the World Bank revises recent years, and a revision
 * replaces the value and advances `source_retrieved_at`, which the readout carries forward.
 *
 * Both series are fetched BEFORE either is written, so a run that fails on the second request
 * writes nothing and the pg-boss retry starts clean. Both upserts are idempotent either way.
 */
export async function syncWorldBankIndicators(): Promise<WorldBankSyncSummary> {
  const countryRegions = await db
    .select({ id: discoveryRegion.id, countryCode: discoveryRegion.countryCode })
    .from(discoveryRegion)
    .where(eq(discoveryRegion.kind, "country"));

  const regionIdByCountryCode = new Map<string, string>();
  for (const region of countryRegions) {
    if (region.countryCode !== null) regionIdByCountryCode.set(region.countryCode, region.id);
  }
  const countryCodes = [...regionIdByCountryCode.keys()].toSorted();
  if (countryCodes.length === 0) {
    return {
      countryCount: 0,
      observationsUpserted: 0,
      countriesWithNoValue: [],
      businessReadyScoresUpserted: 0,
      countriesWithNoBusinessReadyScore: [],
    };
  }

  const purchasingPowerSeries = await fetchIndicatorSeriesOrThrow({
    countryCodes,
    indicatorCode: GDP_PER_CAPITA_PPP_INDICATOR_CODE,
    mostRecentYears: MOST_RECENT_YEARS,
  });
  const businessReadySeries = await fetchIndicatorSeriesOrThrow({
    countryCodes,
    indicatorCode: BUSINESS_READY_REGULATORY_FRAMEWORK_INDICATOR_CODE,
    mostRecentYears: MOST_RECENT_YEARS,
  });

  const rows = purchasingPowerSeries.observations.flatMap((observation) => {
    const regionId = regionIdByCountryCode.get(observation.countryCode);
    // Whole dollars: the source publishes a modelled estimate, and cents would claim a
    // precision it does not have. A non-positive value is not a published income; no row.
    const valueInWholeInternationalDollars = Math.round(observation.value);
    return regionId === undefined || valueInWholeInternationalDollars <= 0
      ? []
      : [
          {
            regionId,
            indicatorCode: GDP_PER_CAPITA_PPP_INDICATOR_CODE,
            dataYear: observation.dataYear,
            valueInWholeInternationalDollars,
            sourceName: WORLD_BANK_GDP_PPP_SOURCE_NAME,
            sourceUrl: purchasingPowerSeries.sourceUrl,
            sourceLastUpdatedDate: purchasingPowerSeries.sourceLastUpdatedDate,
            sourceRetrievedAt: purchasingPowerSeries.retrievedAt,
          },
        ];
  });

  const businessReadyRows = businessReadySeries.observations.flatMap((observation) => {
    const regionId = regionIdByCountryCode.get(observation.countryCode);
    // Tenths of a point: the API publishes one decimal. A score outside 0–100 is a broken
    // value, skipped rather than clamped into a plausible one.
    const scoreInTenths = Math.round(observation.value * 10);
    return regionId === undefined ||
      scoreInTenths < 0 ||
      scoreInTenths > MAXIMUM_BUSINESS_READY_SCORE_IN_TENTHS
      ? []
      : [
          {
            regionId,
            indicatorCode: BUSINESS_READY_REGULATORY_FRAMEWORK_INDICATOR_CODE,
            editionYear: observation.dataYear,
            scoreInTenths,
            sourceName: WORLD_BANK_BUSINESS_READY_SOURCE_NAME,
            sourceUrl: businessReadySeries.sourceUrl,
            sourceLastUpdatedDate: businessReadySeries.sourceLastUpdatedDate,
            sourceRetrievedAt: businessReadySeries.retrievedAt,
          },
        ];
  });

  if (rows.length > 0) {
    await db
      .insert(countryEconomicIndicator)
      .values(rows)
      .onConflictDoUpdate({
        target: [
          countryEconomicIndicator.regionId,
          countryEconomicIndicator.indicatorCode,
          countryEconomicIndicator.dataYear,
        ],
        set: {
          valueInWholeInternationalDollars: sql`excluded.value_in_whole_international_dollars`,
          sourceUrl: sql`excluded.source_url`,
          sourceLastUpdatedDate: sql`excluded.source_last_updated_date`,
          sourceRetrievedAt: sql`excluded.source_retrieved_at`,
          updatedAt: sql`now()`,
        },
      });
  }

  if (businessReadyRows.length > 0) {
    await db
      .insert(countryBusinessReadyScore)
      .values(businessReadyRows)
      .onConflictDoUpdate({
        target: [
          countryBusinessReadyScore.regionId,
          countryBusinessReadyScore.indicatorCode,
          countryBusinessReadyScore.editionYear,
        ],
        set: {
          scoreInTenths: sql`excluded.score_in_tenths`,
          sourceUrl: sql`excluded.source_url`,
          sourceLastUpdatedDate: sql`excluded.source_last_updated_date`,
          sourceRetrievedAt: sql`excluded.source_retrieved_at`,
          updatedAt: sql`now()`,
        },
      });
  }

  return {
    countryCount: countryCodes.length,
    observationsUpserted: rows.length,
    countriesWithNoValue: purchasingPowerSeries.countriesWithNoValue,
    businessReadyScoresUpserted: businessReadyRows.length,
    countriesWithNoBusinessReadyScore: businessReadySeries.countriesWithNoValue,
  };
}

export async function handleSyncWorldBankIndicators(rawPayload: unknown): Promise<void> {
  // The payload carries only `asOf`, which exists to make the weekly idempotency key; the pull
  // itself always asks for the most recent years.
  parseJobPayload(
    JOB_NAMES.syncWorldBankIndicators,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.syncWorldBankIndicators],
    rawPayload,
  );
  await syncWorldBankIndicators();
}
