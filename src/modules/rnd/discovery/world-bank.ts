import { z } from "zod";

import type { Result } from "#src/types/index.js";

/**
 * The World Bank Indicators API (v2) — the source of TWO feasibility pillars: purchasing power
 * (`NY.GDP.PCAP.PP.CD`) and the regulatory framework (`IC.BRE.P1.RF`, B-READY Pillar 1).
 *
 * B-READY IS ON THIS API, which the first plan for the regulatory pillar did not know: it
 * proposed an admin CSV import because "B-READY has no API". Verified live 2026-10-02: WDI
 * (source 2) serves 43 `IC.BRE.*` series, the 2024 edition only (50 economies, `lastupdated`
 * 2026-07-13). Later editions arrive here when WDI ingests them.
 *
 * KEYLESS AND PUBLIC. Nothing personal is sent: the request names countries and an indicator
 * code, nothing about any user, so this adds no processor to the privacy policy.
 *
 * PURE, on the `import-intelligence/comtrade.ts` pattern: no config, no database, no clock
 * beyond stamping `retrievedAt`. The timeout, base URL and `fetch` are arguments so a test
 * never resolves a real host. It does NOT retry — the job throws on `WORLD_BANK_UNAVAILABLE`
 * and pg-boss owns the backoff.
 *
 * Response shape, verified live 2026-09-29 against
 * `/v2/country/IN;KE;BR/indicator/NY.GDP.PCAP.PP.CD?format=json&mrv=2`:
 * `[{ page, pages, per_page, total, lastupdated }, [{ country: { id: "IN" }, date: "2025",
 * value: 11747.91… | null }, …]]`. ISO alpha-2 codes are accepted in the path and come back
 * in `country.id`.
 */

const WORLD_BANK_BASE_URL = "https://api.worldbank.org/v2";
/** Measured 86 s for an uncached 18-country query; see `WORLD_BANK_TIMEOUT_MS`. */
const DEFAULT_TIMEOUT_MS = 180_000;
/** Far above 18 countries × 5 years, so one page is always the whole answer. */
const PER_PAGE = 1000;

export type FetchImplementation = typeof globalThis.fetch;

export const GDP_PER_CAPITA_PPP_INDICATOR_CODE = "NY.GDP.PCAP.PP.CD";
/**
 * B-READY "Pillar 1: Regulatory Framework", 0–100. B-READY deliberately publishes NO overall
 * economy score, so this one published pillar is read rather than an average Qatoto would have
 * to invent.
 */
export const BUSINESS_READY_REGULATORY_FRAMEWORK_INDICATOR_CODE = "IC.BRE.P1.RF";

export type WorldBankIndicatorCode =
  | typeof GDP_PER_CAPITA_PPP_INDICATOR_CODE
  | typeof BUSINESS_READY_REGULATORY_FRAMEWORK_INDICATOR_CODE;

export interface IndicatorSeriesQuery {
  /** ISO 3166-1 alpha-2, e.g. "IN". */
  readonly countryCodes: readonly string[];
  readonly indicatorCode: WorldBankIndicatorCode;
  /** `mrv`: the most recent N years per country. */
  readonly mostRecentYears: number;
}

export interface WorldBankOptions {
  readonly timeoutMs?: number;
  readonly baseUrl?: string;
  readonly fetchImplementation?: FetchImplementation;
}

export interface IndicatorObservation {
  readonly countryCode: string;
  readonly dataYear: number;
  /**
   * The published value, UNROUNDED and in the indicator's own unit. The caller converts, because
   * the unit differs per indicator (whole dollars for PPP, tenths of a point for B-READY).
   * Observations the source left null are omitted.
   */
  readonly value: number;
}

export interface IndicatorSeriesResult {
  readonly observations: readonly IndicatorObservation[];
  /**
   * Countries asked for that came back with no published value in the window. A value the
   * caller later rejects (out of its unit's range) does not move a country into this list.
   */
  readonly countriesWithNoValue: readonly string[];
  /** The dataset's own last-revision date (`YYYY-MM-DD`), or null if the source omitted it. */
  readonly sourceLastUpdatedDate: string | null;
  readonly sourceUrl: string;
  readonly retrievedAt: Date;
}

export type WorldBankError =
  /** 429, 5xx, timeout, socket reset, non-JSON. Retryable — throw and let pg-boss back off. */
  | { type: "WORLD_BANK_UNAVAILABLE"; detail: string }
  /** Other 4xx. The query is wrong; retrying cannot help. */
  | { type: "WORLD_BANK_REQUEST_REJECTED"; detail: string }
  /**
   * The body did not match the contract. The API answers an unknown indicator with HTTP 200
   * and a `[{ message: [...] }]` body, which lands here rather than as a 4xx.
   */
  | { type: "WORLD_BANK_SCHEMA_INVALID"; issues: readonly string[] };

const WorldBankMetaSchema = z.object({
  page: z.number(),
  pages: z.number(),
  lastupdated: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

const WorldBankObservationSchema = z.object({
  country: z.object({ id: z.string().regex(/^[A-Z0-9]{2}$/) }),
  date: z.string().regex(/^\d{4}$/),
  value: z.number().nullable(),
});

const WorldBankResponseSchema = z.tuple([
  WorldBankMetaSchema,
  z.array(WorldBankObservationSchema).nullable(),
]);

function buildRequestUrl(baseUrl: string, query: IndicatorSeriesQuery): string {
  const searchParameters = new URLSearchParams({
    format: "json",
    mrv: String(query.mostRecentYears),
    per_page: String(PER_PAGE),
  });
  // `;` separates countries in the PATH, which is why the codes are not form-encoded as one
  // query value. Each code is already validated as two uppercase letters by the caller's
  // region CHECK, so nothing here needs escaping.
  return `${baseUrl}/country/${query.countryCodes.join(";")}/indicator/${query.indicatorCode}?${searchParameters.toString()}`;
}

/** Fetches the most recent years of one indicator for a set of countries, in one request. */
export async function fetchIndicatorSeries(
  query: IndicatorSeriesQuery,
  options: WorldBankOptions = {},
): Promise<Result<IndicatorSeriesResult, WorldBankError>> {
  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
  const requestUrl = buildRequestUrl(options.baseUrl ?? WORLD_BANK_BASE_URL, query);
  const retrievedAt = new Date();

  let response: Response;
  try {
    response = await fetchImplementation(requestUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    return {
      success: false,
      error: {
        type: "WORLD_BANK_UNAVAILABLE",
        detail: error instanceof Error ? error.message : "network failure",
      },
    };
  }

  if (!response.ok) {
    if (response.status === 429 || response.status >= 500) {
      return {
        success: false,
        error: { type: "WORLD_BANK_UNAVAILABLE", detail: `HTTP ${response.status}` },
      };
    }
    return {
      success: false,
      error: { type: "WORLD_BANK_REQUEST_REJECTED", detail: `HTTP ${response.status}` },
    };
  }

  let rawBody: unknown;
  try {
    rawBody = await response.json();
  } catch {
    return {
      success: false,
      error: { type: "WORLD_BANK_UNAVAILABLE", detail: "response was not JSON" },
    };
  }

  const parsed = WorldBankResponseSchema.safeParse(rawBody);
  if (!parsed.success) {
    return {
      success: false,
      error: {
        type: "WORLD_BANK_SCHEMA_INVALID",
        issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      },
    };
  }

  const [meta, rawObservations] = parsed.data;
  if (meta.pages > 1) {
    // Never expected at PER_PAGE — but a silently truncated series would score some countries
    // off a partial answer, so it is refused rather than read.
    return {
      success: false,
      error: {
        type: "WORLD_BANK_SCHEMA_INVALID",
        issues: [`response spans ${String(meta.pages)} pages; only one is read`],
      },
    };
  }

  const requestedCountryCodes = new Set(query.countryCodes);
  const observations: IndicatorObservation[] = [];
  for (const observation of rawObservations ?? []) {
    // A null is "not published for that year" — not a zero-income country. No row.
    if (observation.value === null) continue;
    if (!requestedCountryCodes.has(observation.country.id)) continue;
    if (!Number.isFinite(observation.value)) continue;
    observations.push({
      countryCode: observation.country.id,
      dataYear: Number(observation.date),
      value: observation.value,
    });
  }

  const countriesWithValue = new Set(observations.map((observation) => observation.countryCode));
  return {
    success: true,
    value: {
      observations,
      countriesWithNoValue: query.countryCodes.filter(
        (countryCode) => !countriesWithValue.has(countryCode),
      ),
      sourceLastUpdatedDate: meta.lastupdated ?? null,
      // The URL recorded as provenance is the one actually fetched, minus nothing — it carries
      // no credential because the API takes none.
      sourceUrl: requestUrl,
      retrievedAt,
    },
  };
}
