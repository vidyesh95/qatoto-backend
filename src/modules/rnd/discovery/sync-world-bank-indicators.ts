import { eq, sql } from "drizzle-orm";

import { config } from "#src/config/index.js";
import { db } from "#src/db/index.js";
import { countryEconomicIndicator, discoveryRegion } from "#src/db/schema.js";
import {
  JOB_NAMES,
  JOB_PAYLOAD_SCHEMAS,
  parseJobPayload,
  PermanentJobError,
} from "#src/lib/jobs.js";
import {
  fetchIndicatorSeries,
  GDP_PER_CAPITA_PPP_INDICATOR_CODE,
} from "#src/modules/rnd/discovery/world-bank.js";

/** Named once so the indicator rows, the readout and the API response all agree. */
export const WORLD_BANK_GDP_PPP_SOURCE_NAME =
  "World Bank — GDP per capita, PPP (NY.GDP.PCAP.PP.CD)";

/**
 * Five years per country: enough that a country whose latest year is unpublished still has a
 * recent value, and that a revision to any of those years is picked up.
 */
const MOST_RECENT_YEARS = 5;

export interface WorldBankSyncSummary {
  readonly countryCount: number;
  readonly observationsUpserted: number;
  readonly countriesWithNoValue: readonly string[];
}

/**
 * Pulls GDP per capita (PPP) for every seeded country in ONE request and upserts it.
 *
 * FAILURE HANDLING follows the Comtrade job: a retryable fault THROWS so pg-boss backs off, a
 * contract violation is a `PermanentJobError`. There is no "not configured" arm — the API is
 * keyless. A country the World Bank publishes nothing for is reported in the summary, not
 * written as zero.
 *
 * Upsert on `(region, indicator, year)`: the World Bank revises recent years, and a revision
 * replaces the value and advances `source_retrieved_at`, which the readout carries forward.
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
    return { countryCount: 0, observationsUpserted: 0, countriesWithNoValue: [] };
  }

  const fetched = await fetchIndicatorSeries(
    {
      countryCodes,
      indicatorCode: GDP_PER_CAPITA_PPP_INDICATOR_CODE,
      mostRecentYears: MOST_RECENT_YEARS,
    },
    { timeoutMs: config.WORLD_BANK_TIMEOUT_MS },
  );

  if (!fetched.success) {
    switch (fetched.error.type) {
      case "WORLD_BANK_UNAVAILABLE":
        throw new Error(`sync-world-bank-indicators: ${fetched.error.detail}`);
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

  const rows = fetched.value.observations.flatMap((observation) => {
    const regionId = regionIdByCountryCode.get(observation.countryCode);
    return regionId === undefined
      ? []
      : [
          {
            regionId,
            indicatorCode: GDP_PER_CAPITA_PPP_INDICATOR_CODE,
            dataYear: observation.dataYear,
            valueInWholeInternationalDollars: observation.valueInWholeInternationalDollars,
            sourceName: WORLD_BANK_GDP_PPP_SOURCE_NAME,
            sourceUrl: fetched.value.sourceUrl,
            sourceLastUpdatedDate: fetched.value.sourceLastUpdatedDate,
            sourceRetrievedAt: fetched.value.retrievedAt,
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

  return {
    countryCount: countryCodes.length,
    observationsUpserted: rows.length,
    countriesWithNoValue: fetched.value.countriesWithNoValue,
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
