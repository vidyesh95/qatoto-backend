/**
 * The UN Comtrade client — the only place this backend talks to comtradeapi.un.org.
 *
 * WHAT IT PRODUCES: one `CommodityTradeRow` per HS6 commodity, for one reporting country,
 * one year and one direction. `commodity_trade_flow` rows are written from these and from
 * nothing else (§10A).
 *
 * SHAPED LIKE `gemini.ts`, NOT LIKE `geocoding.ts`. This module imports no config: the
 * subscription key, the timeout and the base URL all arrive as arguments, so it is a pure
 * function testable with no env stubbing and no network. `geocoding.ts` reads `config`
 * directly and is untestable for exactly that reason; `gemini.ts` records the divergence
 * and this module follows the better half of it.
 *
 * THE QUERY IS PINNED, AND THE PINS ARE THE WHOLE DESIGN. `partnerCode=0` alone does NOT
 * return one row per commodity — it returns a `partner2Code` breakdown, one row per
 * country of consignment, and summing those double-counts. Pinning all four of
 * `partnerCode=0`, `partner2Code=0`, `customsCode=C00` and `motCode=0` is what makes the
 * response exactly one aggregate row per commodity. Verified against the live API: India
 * 2023 imports returns 6,352 rows totalling $672,140,129,636, which matches the published
 * national figure.
 *
 * FLOATS STOP HERE. Comtrade sends `primaryValue: 11862990842.188` and
 * `netWgt: 6533139.808`. They become integer cents and integer milli-kilograms in this
 * module and nowhere else, so §4b's "no floats, ever" holds for every consumer downstream.
 * India's largest line is $140bn — 14,038,629,964,550 cents — which is why every value
 * column is `bigint` and why the wire carries a decimal string.
 *
 * WHAT THIS MODULE MUST NEVER DO: fabricate a magnitude. A missing `netWgt` stays null. An
 * unrecognised quantity unit skips the row and is counted, because a row labelled with the
 * wrong unit is worse than a row that is absent and reported as absent.
 */
import { z } from "zod";

import type { Result } from "#src/types/index.js";

/** The v1 data endpoint. Overridable per call so a test never resolves a real host. */
export const COMTRADE_BASE_URL = "https://comtradeapi.un.org/data/v1/get";

/**
 * Generous, because a full year of one country's HS6 lines is a ~4 MB response the API
 * assembles on demand — the observed elapsed time is 1-3 s, but a cold partition is
 * slower. Bounded, because a hung fetch holds a worker slot.
 */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Comtrade's own goods/annual/HS path segments. Services and monthly are not read here. */
const GOODS_TYPE_CODE = "C";
const ANNUAL_FREQUENCY_CODE = "A";
const HS_CLASSIFICATION_CODE = "HS";

/** HS6 is the leaf level this domain works at — chapters and headings are roll-ups. */
const HS6_AGGREGATION_LEVEL = 6;

/** Comtrade reports every value in current US dollars. */
const COMTRADE_CURRENCY = "USD";

const CENTS_PER_DOLLAR = 100;
const MILLI_PER_UNIT = 1000;

export type FetchImplementation = typeof globalThis.fetch;

/**
 * The failure modes, split by WHAT THE CALLER SHOULD DO — the only split a job handler
 * deciding between a retry and a dead-letter can act on. Same organising rule as
 * `GeminiError`.
 */
export type ComtradeError =
  /** No subscription key in this environment. The run records `skipped_unconfigured`. */
  | { type: "COMTRADE_NOT_CONFIGURED" }
  /** 429, 5xx, timeout, socket reset. Retryable — throw and let pg-boss back off. */
  | { type: "COMTRADE_UNAVAILABLE"; detail: string }
  /** 4xx. The query is wrong, or the key is not entitled to it. Retrying cannot help. */
  | { type: "COMTRADE_REQUEST_REJECTED"; detail: string }
  /** The body did not match the contract. Permanent for this response. */
  | { type: "COMTRADE_SCHEMA_INVALID"; issues: readonly string[] };

/**
 * Comtrade's numeric quantity-unit codes, mapped to the enum stored on the row.
 *
 * TWELVE, ALL OBSERVED IN THE LIVE FEED rather than copied from documentation. Ten came
 * from a single year; codes 9 and 10 appeared only once six years were ingested, and they
 * were found because the ingest SKIPPED them and said so. That is the argument for
 * skip-and-count in one sentence: the gap announced itself and no wrong number was written
 * while it was open.
 *
 * `-1` is Comtrade's "N/A": the commodity is traded by value alone. That is a real
 * statement about the commodity, NOT a missing measurement, and it is why `not_applicable`
 * is a unit rather than a null.
 */
const QUANTITY_UNIT_BY_COMTRADE_CODE: Readonly<Record<number, ImportQuantityUnit>> = {
  [-1]: "not_applicable",
  2: "square_metres",
  3: "thousand_kilowatt_hours",
  4: "metres",
  5: "units",
  6: "pairs",
  7: "litres",
  8: "kilograms",
  9: "thousand_units",
  10: "packs",
  12: "cubic_metres",
  13: "carats",
};

export type ImportQuantityUnit =
  | "not_applicable"
  | "square_metres"
  | "thousand_kilowatt_hours"
  | "metres"
  | "units"
  | "pairs"
  | "litres"
  | "kilograms"
  | "thousand_units"
  | "packs"
  | "cubic_metres"
  | "carats";

export type TradeFlowKind = "import" | "export";

/** Comtrade's single-letter flow codes. */
const FLOW_CODE_BY_KIND: Readonly<Record<TradeFlowKind, string>> = {
  import: "M",
  export: "X",
};

/**
 * One row of the response.
 *
 * `.passthrough()` is deliberate and is the opposite of this repo's `.strict()` rule for
 * REQUEST bodies — a request body is attacker-controlled and unknown keys are an attack
 * surface, while this is a third party's response and a field they add next release must
 * not break an ingest. Every field read below is named explicitly; the rest are ignored.
 */
const ComtradeRowSchema = z
  .object({
    cmdCode: z.string(),
    cmdDesc: z.string().nullable(),
    aggrLevel: z.number().nullable(),
    isLeaf: z.boolean().nullable(),
    // The float that becomes integer cents. Comtrade omits it on some historical rows.
    primaryValue: z.number().nullable(),
    netWgt: z.number().nullable(),
    qty: z.number().nullable(),
    qtyUnitCode: z.number().nullable(),
    isReported: z.boolean().nullable(),
    isAggregate: z.boolean().nullable(),
    isNetWgtEstimated: z.boolean().nullable(),
    isQtyEstimated: z.boolean().nullable(),
    legacyEstimationFlag: z.number().nullable(),
  })
  .passthrough();

const ComtradeResponseSchema = z
  .object({
    count: z.number(),
    data: z.array(ComtradeRowSchema),
  })
  .passthrough();

/** One commodity's traded magnitude, already converted to the units the schema stores. */
export interface CommodityTradeRow {
  /** Six digits. The URL identity, never slugified. */
  readonly hsCode: string;
  readonly commodityLabel: string;
  readonly tradeValueInCents: number;
  readonly currency: string;
  /** NULL where the reporter filed none. Never coerced to zero. */
  readonly netWeightMilliKilograms: number | null;
  readonly quantityMilli: number | null;
  readonly quantityUnit: ImportQuantityUnit;
  readonly quantityUnitCode: number;
  readonly isReported: boolean;
  readonly isAggregate: boolean;
  readonly isNetWeightEstimated: boolean;
  readonly isQuantityEstimated: boolean;
  readonly legacyEstimationFlag: number | null;
}

export interface ComtradeFetchResult {
  readonly rows: readonly CommodityTradeRow[];
  /** Every row the API sent, before HS6 filtering — what the sync run records. */
  readonly rowsReceived: number;
  /**
   * The `qtyUnitCode` values this client does not know, from rows it therefore dropped.
   *
   * NAMED RATHER THAN SWALLOWED. A row labelled with a guessed unit is a wrong number
   * presented as a right one; a dropped row whose unit code is written down is a gap that
   * tells you how to close it. Empty on a clean run.
   */
  readonly unknownQuantityUnitCodes: readonly number[];
  readonly retrievedAt: Date;
}

export interface ComtradeQuery {
  /** The reporter's UN M49 code. India is 699. */
  readonly reporterCode: number;
  readonly periodYear: number;
  readonly flowKind: TradeFlowKind;
}

export interface ComtradeOptions {
  readonly subscriptionKey: string | undefined;
  readonly timeoutMs?: number;
  readonly baseUrl?: string;
  readonly fetchImplementation?: FetchImplementation;
}

/**
 * Rounds a dollar amount to integer cents.
 *
 * `Math.round`, not truncation: Comtrade's three decimal places are already rounded from
 * the reporter's own filing, and truncating would bias every one of 5,052 lines downward.
 */
function toCents(dollarAmount: number): number {
  return Math.round(dollarAmount * CENTS_PER_DOLLAR);
}

function toMilli(amount: number): number {
  return Math.round(amount * MILLI_PER_UNIT);
}

/** Builds the pinned query. See the module header for why all four pins are required. */
function buildRequestUrl(baseUrl: string, query: ComtradeQuery): string {
  const searchParameters = new URLSearchParams({
    reporterCode: String(query.reporterCode),
    period: String(query.periodYear),
    flowCode: FLOW_CODE_BY_KIND[query.flowKind],
    // The four pins. Removing any one of them changes the row count, not just the columns.
    partnerCode: "0",
    partner2Code: "0",
    customsCode: "C00",
    motCode: "0",
    // Without this every description field comes back null and the commodity vocabulary
    // would have to be hand-authored.
    includeDesc: "true",
  });

  return `${baseUrl}/${GOODS_TYPE_CODE}/${ANNUAL_FREQUENCY_CODE}/${HS_CLASSIFICATION_CODE}?${searchParameters.toString()}`;
}

/**
 * Fetches one country-year-direction of HS6 trade flows.
 *
 * Returns only HS6 leaves: the response interleaves chapter (aggrLevel 2), heading (4) and
 * commodity (6) roll-ups, and summing across levels triple-counts every dollar.
 */
export async function fetchAnnualTradeFlows(
  query: ComtradeQuery,
  options: ComtradeOptions,
): Promise<Result<ComtradeFetchResult, ComtradeError>> {
  const { subscriptionKey } = options;

  // BEFORE THE REQUEST, deliberately: an unconfigured environment must make zero calls,
  // and a test asserts exactly that.
  if (subscriptionKey === undefined || subscriptionKey === "") {
    return { success: false, error: { type: "COMTRADE_NOT_CONFIGURED" } };
  }

  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
  const requestUrl = buildRequestUrl(options.baseUrl ?? COMTRADE_BASE_URL, query);
  const retrievedAt = new Date();

  let response: Response;
  try {
    response = await fetchImplementation(requestUrl, {
      headers: {
        // THE KEY TRAVELS IN A HEADER. Comtrade also accepts `?subscription-key=`, and
        // that form puts a credential into every access log, proxy trace and error report
        // the URL touches. A test asserts the URL does not contain it.
        "Ocp-Apim-Subscription-Key": subscriptionKey,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    return {
      success: false,
      error: {
        type: "COMTRADE_UNAVAILABLE",
        detail: error instanceof Error ? error.message : "network failure",
      },
    };
  }

  if (!response.ok) {
    // 429 is the daily/burst quota and 5xx is theirs, not ours — both are worth retrying.
    // A 4xx is a query this key may not make, and five backoff attempts cannot fix it.
    if (response.status === 429 || response.status >= 500) {
      return {
        success: false,
        error: { type: "COMTRADE_UNAVAILABLE", detail: `HTTP ${response.status}` },
      };
    }
    return {
      success: false,
      error: { type: "COMTRADE_REQUEST_REJECTED", detail: `HTTP ${response.status}` },
    };
  }

  let rawBody: unknown;
  try {
    rawBody = await response.json();
  } catch {
    return {
      success: false,
      error: { type: "COMTRADE_UNAVAILABLE", detail: "response was not JSON" },
    };
  }

  const parsed = ComtradeResponseSchema.safeParse(rawBody);
  if (!parsed.success) {
    return {
      success: false,
      error: {
        type: "COMTRADE_SCHEMA_INVALID",
        issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      },
    };
  }

  const rows: CommodityTradeRow[] = [];
  const unknownUnitCodes = new Set<number>();

  for (const row of parsed.data.data) {
    if (row.aggrLevel !== HS6_AGGREGATION_LEVEL || row.isLeaf !== true) {
      continue;
    }
    // A line with no value is not a trade of zero — it is a line the reporter did not
    // file. There is nothing to record and nothing to score.
    if (row.primaryValue === null) {
      continue;
    }

    const quantityUnitCode = row.qtyUnitCode;
    const quantityUnit =
      quantityUnitCode === null ? undefined : QUANTITY_UNIT_BY_COMTRADE_CODE[quantityUnitCode];
    if (quantityUnit === undefined || quantityUnitCode === null) {
      // The CODE is recorded, not just a count: a bare tally means the next unknown unit
      // costs an API call to identify, which is how codes 9 and 10 were found the slow way.
      if (quantityUnitCode !== null) unknownUnitCodes.add(quantityUnitCode);
      continue;
    }

    rows.push({
      hsCode: row.cmdCode,
      // The WCO's own wording. A row that somehow arrives without one falls back to its
      // code rather than to an invented English label.
      commodityLabel: row.cmdDesc ?? row.cmdCode,
      tradeValueInCents: toCents(row.primaryValue),
      currency: COMTRADE_CURRENCY,
      netWeightMilliKilograms: row.netWgt === null ? null : toMilli(row.netWgt),
      quantityMilli: row.qty === null ? null : toMilli(row.qty),
      quantityUnit,
      quantityUnitCode,
      // A flag the provider omitted is not a claim that the value was measured, so the
      // conservative reading is `false` for "reported" and `false` for "estimated".
      isReported: row.isReported ?? false,
      isAggregate: row.isAggregate ?? false,
      isNetWeightEstimated: row.netWgt === null ? false : (row.isNetWgtEstimated ?? false),
      isQuantityEstimated: row.qty === null ? false : (row.isQtyEstimated ?? false),
      legacyEstimationFlag: row.legacyEstimationFlag,
    });
  }

  return {
    success: true,
    value: {
      rows,
      rowsReceived: parsed.data.data.length,
      unknownQuantityUnitCodes: [...unknownUnitCodes].toSorted((left, right) => left - right),
      retrievedAt,
    },
  };
}
