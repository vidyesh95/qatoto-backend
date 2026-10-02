import { sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { feasibilityReadoutSnapshot, type researchCategoryDomainEnum } from "#src/db/schema.js";
import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import {
  FEASIBILITY_READOUT_MODEL_VERSION,
  manufacturingPoints,
  needDensityPoints,
  purchasingPowerPoints,
  regulatoryFrameworkPoints,
} from "#src/modules/rnd/discovery/feasibility-readout-score.js";

type ResearchCategoryDomain = (typeof researchCategoryDomainEnum.enumValues)[number];

/**
 * The nightly feasibility readout: one snapshot row per (country, domain) that has at least one
 * pillar, all written in ONE transaction under one `asOf`.
 *
 * FOUR INDEPENDENT PILLARS, EACH FROM ITS OWN READS. Nothing below combines a figure from one
 * read with a figure from another — the only thing they share is the (country, domain) key the
 * row is filed under. That is the whole of the §7 rule in code form: no total, no weights.
 *
 * ⚠️ `db.execute` SKIPS DRIZZLE'S TYPE PARSERS — timestamps and bigints come back as strings.
 * Every value is therefore cast in SQL (`::int`, `::text`) and converted explicitly here.
 *
 * WHICH CELLS EXIST, per pillar, and why none of them is a zero-by-default:
 *   - need density: a (country, domain) with at least one ACTIVE cluster whose category has a
 *     moderator-assigned domain. A category with no domain is not in the country matrix yet;
 *   - purchasing power: every country with a published World Bank value — repeated on each of
 *     that country's domain rows, and ALSO on all eight domains when nothing else exists, so a
 *     country with no reports still shows its one country-level fact;
 *   - manufacturing: a (country, domain) with at least one annual Comtrade line in that domain,
 *     in either direction. Imports without exports scores the export half at 0 — that IS a
 *     finding. A country Comtrade was never synced for has no cell at all;
 *   - regulatory framework: every country with a B-READY score, in its newest edition, applied
 *     exactly like purchasing power. An economy no edition covers yet has none.
 */

interface NeedDensityRow extends Record<string, unknown> {
  readonly region_id: string;
  readonly domain: string;
  readonly active_cluster_count: number;
  readonly distinct_reporter_count: number;
}

interface PurchasingPowerRow extends Record<string, unknown> {
  readonly region_id: string;
  readonly data_year: number;
  readonly value_in_whole_international_dollars: string;
  readonly source_retrieved_at: string;
}

interface RegulatoryFrameworkRow extends Record<string, unknown> {
  readonly region_id: string;
  readonly edition_year: number;
  readonly score_in_tenths: number;
  readonly source_retrieved_at: string;
}

interface TradeCellRow extends Record<string, unknown> {
  readonly region_id: string;
  readonly domain: string;
  readonly export_value_in_cents: string;
  readonly trade_data_year: number;
  readonly source_retrieved_at: string;
}

interface ProducerCellRow extends Record<string, unknown> {
  readonly region_id: string;
  readonly domain: string;
  readonly producer_count: number;
}

const DOMAINS: readonly ResearchCategoryDomain[] = [
  "infrastructure",
  "water_sanitation",
  "energy_utilities",
  "agriculture_rural",
  "transportation_mobility",
  "health_care",
  "housing_shelter",
  "industry_manufacturing",
];

/** The key separator must occur in neither a region id nor a domain label. */
function cellKeyFor(regionId: string, domain: string): string {
  return `${regionId} ${domain}`;
}

/**
 * `timestamp::text` is `YYYY-MM-DD HH:MM:SS[.ffffff]` with no zone; the columns hold UTC. The
 * `Z` is load-bearing — without it the worker's local zone would shift every date.
 */
function parseDatabaseTimestamp(rawTimestamp: string): Date {
  const parsedTimestamp = new Date(`${rawTimestamp.replace(" ", "T")}Z`);
  if (Number.isNaN(parsedTimestamp.getTime())) {
    throw new Error(`recompute-feasibility-readouts: unreadable timestamp "${rawTimestamp}"`);
  }
  return parsedTimestamp;
}

function parseSafeInteger(rawValue: string, columnName: string): number {
  const parsedValue = Number(rawValue);
  if (!Number.isSafeInteger(parsedValue)) {
    throw new Error(`recompute-feasibility-readouts: ${columnName} is not a safe integer`);
  }
  return parsedValue;
}

function isDomain(value: string): value is ResearchCategoryDomain {
  return (DOMAINS as readonly string[]).includes(value);
}

export interface FeasibilityRecomputeSummary {
  readonly cellCount: number;
  readonly cellsWithNeedDensity: number;
  readonly countriesWithPurchasingPower: number;
  readonly cellsWithManufacturing: number;
  readonly countriesWithRegulatoryFramework: number;
}

export async function recomputeFeasibilityReadouts(
  asOf: Date,
): Promise<FeasibilityRecomputeSummary> {
  // --- 1. Need density. Distinct REPORTERS across the cell's clusters, counted over
  //        submissions rather than summed from each cluster's own count, because one person
  //        reporting in two clusters is one person.
  const needDensityRows = await db.execute<NeedDensityRow>(sql`
    SELECT region.id AS region_id,
           category.domain::text AS domain,
           count(DISTINCT cluster.id)::int AS active_cluster_count,
           count(DISTINCT submission.reporter_user_id)
             FILTER (WHERE submission.counts_toward_distinct_reporters)::int
             AS distinct_reporter_count
    FROM problem_cluster AS cluster
    JOIN research_category AS category ON category.id = cluster.category_id
    JOIN discovery_region AS region
      ON region.country_code = cluster.country_code AND region.kind = 'country'
    LEFT JOIN problem_submission AS submission ON submission.cluster_id = cluster.id
    WHERE cluster.status = 'active' AND category.domain IS NOT NULL
    GROUP BY region.id, category.domain
  `);

  // --- 2. Purchasing power: the most recent published year per country.
  const purchasingPowerRows = await db.execute<PurchasingPowerRow>(sql`
    SELECT DISTINCT ON (region_id)
           region_id,
           data_year::int AS data_year,
           value_in_whole_international_dollars::text AS value_in_whole_international_dollars,
           source_retrieved_at::text AS source_retrieved_at
    FROM country_economic_indicator
    WHERE indicator_code = 'NY.GDP.PCAP.PP.CD'
    ORDER BY region_id, data_year DESC
  `);

  // --- 2b. Regulatory framework: the newest B-READY edition per country.
  const regulatoryFrameworkRows = await db.execute<RegulatoryFrameworkRow>(sql`
    SELECT DISTINCT ON (region_id)
           region_id,
           edition_year::int AS edition_year,
           score_in_tenths::int AS score_in_tenths,
           source_retrieved_at::text AS source_retrieved_at
    FROM country_business_ready_score
    WHERE indicator_code = 'IC.BRE.P1.RF'
    ORDER BY region_id, edition_year DESC
  `);

  // --- 3. Trade: the newest annual all-partner line per (commodity, country, direction) — the
  //        localization job's selection — rolled up to the commodity's category's domain.
  const tradeCellRows = await db.execute<TradeCellRow>(sql`
    WITH latest_flow AS (
      SELECT DISTINCT ON (commodity_id, reporter_region_id, flow_kind)
             commodity_id, reporter_region_id, flow_kind, trade_value_in_cents,
             period_starts_date, source_retrieved_at
      FROM commodity_trade_flow
      WHERE period_kind = 'annual' AND partner_region_id IS NULL
      ORDER BY commodity_id, reporter_region_id, flow_kind, period_starts_date DESC
    )
    SELECT latest_flow.reporter_region_id AS region_id,
           category.domain::text AS domain,
           coalesce(sum(latest_flow.trade_value_in_cents)
             FILTER (WHERE latest_flow.flow_kind = 'export'), 0)::text AS export_value_in_cents,
           max(extract(year FROM latest_flow.period_starts_date))::int AS trade_data_year,
           max(latest_flow.source_retrieved_at)::text AS source_retrieved_at
    FROM latest_flow
    JOIN import_commodity AS commodity ON commodity.id = latest_flow.commodity_id
    JOIN research_category AS category ON category.id = commodity.research_category_id
    WHERE category.domain IS NOT NULL
    GROUP BY latest_flow.reporter_region_id, category.domain
  `);

  // --- 4. Domestic producers: active suppliers whose capability backs a PUBLISHED substitute
  //        for a commodity in the domain, in the supplier's own country — the localization
  //        job's supplier path, rolled up to domain.
  const producerCellRows = await db.execute<ProducerCellRow>(sql`
    SELECT supplier.region_id,
           category.domain::text AS domain,
           count(DISTINCT supplier.id)::int AS producer_count
    FROM supplier
    JOIN supplier_capability_link AS link ON link.supplier_id = supplier.id
    JOIN domestic_substitute_mapping AS mapping
      ON mapping.supplier_capability_id = link.capability_id
     AND mapping.region_id = supplier.region_id
     AND mapping.published_at IS NOT NULL
    JOIN import_commodity AS commodity ON commodity.id = mapping.commodity_id
    JOIN research_category AS category ON category.id = commodity.research_category_id
    WHERE supplier.is_active AND supplier.region_id IS NOT NULL AND category.domain IS NOT NULL
    GROUP BY supplier.region_id, category.domain
  `);

  const producerCountByCell = new Map<string, number>();
  for (const row of producerCellRows.rows) {
    producerCountByCell.set(cellKeyFor(row.region_id, row.domain), row.producer_count);
  }

  type SnapshotInsert = typeof feasibilityReadoutSnapshot.$inferInsert;
  const rowsByCell = new Map<string, SnapshotInsert>();
  const rowFor = (regionId: string, domain: ResearchCategoryDomain): SnapshotInsert => {
    const key = cellKeyFor(regionId, domain);
    const existing = rowsByCell.get(key);
    if (existing !== undefined) return existing;
    const created: SnapshotInsert = {
      asOf,
      regionId,
      domain,
      modelVersion: FEASIBILITY_READOUT_MODEL_VERSION,
    };
    rowsByCell.set(key, created);
    return created;
  };

  let cellsWithNeedDensity = 0;
  for (const row of needDensityRows.rows) {
    if (!isDomain(row.domain)) continue;
    const points = needDensityPoints({
      distinctReporterCount: row.distinct_reporter_count,
      activeClusterCount: row.active_cluster_count,
    });
    if (points === null) continue;
    Object.assign(rowFor(row.region_id, row.domain), {
      needDensityPoints: points,
      needDistinctReporterCount: row.distinct_reporter_count,
      needActiveClusterCount: row.active_cluster_count,
    });
    cellsWithNeedDensity += 1;
  }

  let cellsWithManufacturing = 0;
  for (const row of tradeCellRows.rows) {
    if (!isDomain(row.domain)) continue;
    const exportValueInCents = parseSafeInteger(row.export_value_in_cents, "export_value_in_cents");
    const domesticProducerCount =
      producerCountByCell.get(cellKeyFor(row.region_id, row.domain)) ?? 0;
    Object.assign(rowFor(row.region_id, row.domain), {
      manufacturingPoints: manufacturingPoints({ exportValueInCents, domesticProducerCount }),
      manufacturingExportValueInCents: exportValueInCents,
      manufacturingTradeDataYear: row.trade_data_year,
      manufacturingDomesticProducerCount: domesticProducerCount,
      manufacturingSourceRetrievedAt: parseDatabaseTimestamp(row.source_retrieved_at),
    });
    cellsWithManufacturing += 1;
  }

  // Purchasing power LAST, onto every domain of the country: it is a country-level fact, and a
  // country with no reports and no trade data still gets its one row per domain carrying it.
  for (const row of purchasingPowerRows.rows) {
    const valueInWholeInternationalDollars = parseSafeInteger(
      row.value_in_whole_international_dollars,
      "value_in_whole_international_dollars",
    );
    const purchasingPower = {
      purchasingPowerPoints: purchasingPowerPoints(valueInWholeInternationalDollars),
      purchasingPowerValueInWholeInternationalDollars: valueInWholeInternationalDollars,
      purchasingPowerDataYear: row.data_year,
      purchasingPowerSourceRetrievedAt: parseDatabaseTimestamp(row.source_retrieved_at),
    };
    for (const domain of DOMAINS) {
      Object.assign(rowFor(row.region_id, domain), purchasingPower);
    }
  }

  // Regulatory framework the same way, for the same reason: a country-level fact.
  for (const row of regulatoryFrameworkRows.rows) {
    const regulatoryFramework = {
      regulatoryFrameworkPoints: regulatoryFrameworkPoints(row.score_in_tenths),
      regulatoryFrameworkScoreInTenths: row.score_in_tenths,
      regulatoryFrameworkEditionYear: row.edition_year,
      regulatoryFrameworkSourceRetrievedAt: parseDatabaseTimestamp(row.source_retrieved_at),
    };
    for (const domain of DOMAINS) {
      Object.assign(rowFor(row.region_id, domain), regulatoryFramework);
    }
  }

  const rows = [...rowsByCell.values()];
  const INSERT_CHUNK_SIZE = 500;
  await db.transaction(async (transaction) => {
    for (let chunkStart = 0; chunkStart < rows.length; chunkStart += INSERT_CHUNK_SIZE) {
      await transaction
        .insert(feasibilityReadoutSnapshot)
        .values(rows.slice(chunkStart, chunkStart + INSERT_CHUNK_SIZE))
        // A retried run for the same asOf writes nothing new — the snapshot is immutable.
        .onConflictDoNothing({
          target: [
            feasibilityReadoutSnapshot.asOf,
            feasibilityReadoutSnapshot.regionId,
            feasibilityReadoutSnapshot.domain,
          ],
        });
    }
  });

  return {
    cellCount: rows.length,
    cellsWithNeedDensity,
    countriesWithPurchasingPower: purchasingPowerRows.rows.length,
    cellsWithManufacturing,
    countriesWithRegulatoryFramework: regulatoryFrameworkRows.rows.length,
  };
}

export async function handleRecomputeFeasibilityReadouts(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.recomputeFeasibilityReadouts,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.recomputeFeasibilityReadouts],
    rawPayload,
  );
  await recomputeFeasibilityReadouts(new Date(payload.asOf));
}
