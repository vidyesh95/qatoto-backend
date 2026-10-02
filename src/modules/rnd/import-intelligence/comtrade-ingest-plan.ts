/**
 * The §10A Comtrade ingest plan: which countries and years the weekly tick
 * (`handleSyncComtradeTradeFlowsTick`) enqueues and `pnpm db:sync-comtrade` backfills.
 *
 * ONE MODULE FOR BOTH, so the tick and the backfill script cannot drift: until 2026-10-02 the
 * script carried its own copy of both arrays.
 *
 * The plan is a constant because the set of countries and years this platform ingests is a
 * product decision, not data. Widening it is a diff here, reviewed like any other, plus a
 * `discovery_region` row and an M49 code in `comtrade-reporters.ts` for each new country.
 *
 * BUDGET: one Comtrade call per (country, year, direction), so 1 × 6 × 2 = 12 calls a week
 * against a 500/day free tier.
 *
 * ⚠️ THE CEILING IS DISK, NOT THE API QUOTA. On 2026-10-02 US, CN, DE, JP and KR were added and
 * backfilled: each country is ~60k rows and ~50 MB of `commodity_trade_flow` before WAL, and
 * the shared Aiven free-tier database (1 GB) went READ-ONLY partway through the fifth. They were
 * removed again the same day. Widening this list needs a bigger disk first, not just a diff.
 */
export const COMTRADE_INGEST_COUNTRY_CODES: readonly string[] = ["IN"];

/**
 * Six years, because a trend needs at least two and a founder reading a six-year import
 * curve can see a substitution that has already started. Comtrade revises recent years, so
 * the most recent one is deliberately not the current year — it would be mostly empty.
 */
export const COMTRADE_INGEST_PERIOD_YEARS: readonly number[] = [2019, 2020, 2021, 2022, 2023, 2024];

export const COMTRADE_INGEST_FLOW_KINDS = ["import", "export"] as const;

/**
 * The countries the import-substitution ranking (`localization_assessment`) and its LLM
 * narratives are computed for. A STRICT SUBSET of the ingest plan, and deliberately so.
 *
 * WHY ONLY INDIA (decided 2026-10-02):
 *   - the score's ladders are calibrated on India's 2023 HS6 import distribution
 *     (`localization-feasibility-score.ts`), so for the US or China most lines land in the top
 *     rungs and the ranking stops ranking;
 *   - for net exporters, "imports a lot AND exports a lot" is two-way trade — German cars,
 *     Korean chips — not a gap a founder could close, and the narrative prompt would describe it
 *     as one;
 *   - each ranked country costs ~25 metered Gemini calls a night (`NARRATIVE_RANK_LIMIT`).
 *
 * A country ingested but not listed here still feeds the feasibility readout's manufacturing
 * pillar, where export strength is exactly what is measured. Adding a country here is a
 * modelling decision, not a config change.
 */
export const LOCALIZATION_ASSESSMENT_COUNTRY_CODES: readonly string[] = ["IN"];
