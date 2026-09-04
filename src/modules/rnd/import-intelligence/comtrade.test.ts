import { describe, expect, it, vi } from "vitest";

import {
  fetchAnnualTradeFlows,
  type ComtradeOptions,
  type FetchImplementation,
} from "#src/modules/rnd/import-intelligence/comtrade.js";

/**
 * The Comtrade client, tested against an INJECTED fetch — no env, no key, no network.
 *
 * The organising axis is the retryable/permanent split, exactly as `gemini.test.ts` is
 * organised, because that split is the only thing a job handler branches on: 429 and 5xx
 * are the provider's problem and back off, a 4xx is our query and never improves, and a
 * body that will not parse is permanent for that response.
 *
 * THE ROWS BELOW ARE REAL. They were captured from comtradeapi.un.org for India (reporter
 * 699), 2023, imports, with the pinned query the client sends. They are kept verbatim
 * because the conversions this module performs — float dollars to integer cents, float
 * kilograms to integer milli-kilograms — are only worth testing against the magnitudes and
 * the decimal places the provider actually emits.
 */
const REAL_PETROLEUM_ROW = {
  typeCode: "C",
  freqCode: "A",
  refYear: 2023,
  period: "2023",
  reporterCode: 699,
  reporterISO: "IND",
  flowCode: "M",
  partnerCode: 0,
  partner2Code: 0,
  cmdCode: "270900",
  cmdDesc: "Oils; petroleum oils and oils obtained from bituminous minerals, crude",
  aggrLevel: 6,
  isLeaf: true,
  customsCode: "C00",
  motCode: 0,
  qtyUnitCode: 8,
  qtyUnitAbbr: "kg",
  qty: 232_735_827_233,
  isQtyEstimated: false,
  netWgt: 232_735_827_233,
  isNetWgtEstimated: false,
  cifvalue: 140_386_299_645.03,
  fobvalue: null,
  primaryValue: 140_386_299_645.03,
  legacyEstimationFlag: 0,
  isReported: false,
  isAggregate: true,
} as const;

/** A real row with NO reported net weight — 679 of India's 5,052 lines look like this. */
const REAL_ROW_WITHOUT_WEIGHT = {
  ...REAL_PETROLEUM_ROW,
  cmdCode: "980000",
  cmdDesc: "Commodities not specified according to kind",
  qtyUnitCode: -1,
  qtyUnitAbbr: "N/A",
  qty: null,
  isQtyEstimated: false,
  netWgt: null,
  isNetWgtEstimated: false,
  primaryValue: 1234.567,
} as const;

/** A chapter-level roll-up. Summing these alongside HS6 leaves triple-counts every dollar. */
const REAL_CHAPTER_ROLLUP_ROW = {
  ...REAL_PETROLEUM_ROW,
  cmdCode: "27",
  cmdDesc: "Mineral fuels, mineral oils and products of their distillation",
  aggrLevel: 2,
  isLeaf: false,
} as const;

function comtradeResponse(rows: readonly unknown[]): Response {
  return new Response(JSON.stringify({ elapsedTime: "1.2 secs", count: rows.length, data: rows }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

interface RecordedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
}

function stubFetch(respond: (callIndex: number) => Response): {
  readonly fetchImplementation: FetchImplementation;
  readonly requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchImplementation: FetchImplementation = vi.fn<FetchImplementation>(async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    requests.push({ url: input instanceof Request ? input.url : String(input), headers });
    return respond(requests.length - 1);
  });
  return { fetchImplementation, requests };
}

const QUERY = { reporterCode: 699, periodYear: 2023, flowKind: "import" } as const;

function optionsWith(fetchImplementation: FetchImplementation): ComtradeOptions {
  return {
    subscriptionKey: "test-subscription-key",
    baseUrl: "https://comtrade.test/data/v1/get",
    fetchImplementation,
  };
}

describe("fetchAnnualTradeFlows — the request", () => {
  it("sends the key in a header and NEVER in the URL", async () => {
    const { fetchImplementation, requests } = stubFetch(() => comtradeResponse([]));
    await fetchAnnualTradeFlows(QUERY, optionsWith(fetchImplementation));

    const request = requests[0];
    expect(request?.headers["ocp-apim-subscription-key"]).toBe("test-subscription-key");
    // A key in a URL lands in every access log and proxy trace in between.
    expect(request?.url).not.toContain("test-subscription-key");
    expect(request?.url).not.toContain("subscription-key=");
  });

  it("pins all four aggregation parameters", async () => {
    // Without ALL of these the API returns a partner2 breakdown, not one row per
    // commodity, and summing it double-counts.
    const { fetchImplementation, requests } = stubFetch(() => comtradeResponse([]));
    await fetchAnnualTradeFlows(QUERY, optionsWith(fetchImplementation));

    const url = requests[0]?.url ?? "";
    expect(url).toContain("partnerCode=0");
    expect(url).toContain("partner2Code=0");
    expect(url).toContain("customsCode=C00");
    expect(url).toContain("motCode=0");
  });

  it("asks for descriptions, which is where the commodity vocabulary comes from", async () => {
    const { fetchImplementation, requests } = stubFetch(() => comtradeResponse([]));
    await fetchAnnualTradeFlows(QUERY, optionsWith(fetchImplementation));
    expect(requests[0]?.url).toContain("includeDesc=true");
  });

  it("maps the flow kind onto Comtrade's single-letter code", async () => {
    const { fetchImplementation, requests } = stubFetch(() => comtradeResponse([]));
    await fetchAnnualTradeFlows({ ...QUERY, flowKind: "export" }, optionsWith(fetchImplementation));
    expect(requests[0]?.url).toContain("flowCode=X");
  });

  it("makes ZERO requests when no key is configured", async () => {
    const { fetchImplementation, requests } = stubFetch(() => comtradeResponse([]));
    const result = await fetchAnnualTradeFlows(QUERY, {
      ...optionsWith(fetchImplementation),
      subscriptionKey: undefined,
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");
    expect(result.error).toStrictEqual({ type: "COMTRADE_NOT_CONFIGURED" });
    expect(requests).toHaveLength(0);
  });
});

describe("fetchAnnualTradeFlows — conversion", () => {
  it("converts float dollars to integer cents exactly, at India's largest line", async () => {
    const { fetchImplementation } = stubFetch(() => comtradeResponse([REAL_PETROLEUM_ROW]));
    const result = await fetchAnnualTradeFlows(QUERY, optionsWith(fetchImplementation));

    if (!result.success) throw new Error("expected success");
    const row = result.value.rows[0];
    // $140,386,299,645.03 -> 14,038,629,964,503 cents. Far beyond int4, hence bigint.
    expect(row?.tradeValueInCents).toBe(14_038_629_964_503);
    expect(Number.isSafeInteger(row?.tradeValueInCents)).toBe(true);
    expect(row?.currency).toBe("USD");
  });

  it("converts weight and quantity to integer milli units", async () => {
    const { fetchImplementation } = stubFetch(() => comtradeResponse([REAL_PETROLEUM_ROW]));
    const result = await fetchAnnualTradeFlows(QUERY, optionsWith(fetchImplementation));

    if (!result.success) throw new Error("expected success");
    const row = result.value.rows[0];
    expect(row?.netWeightMilliKilograms).toBe(232_735_827_233_000);
    expect(row?.quantityMilli).toBe(232_735_827_233_000);
    expect(row?.quantityUnit).toBe("kilograms");
    expect(row?.quantityUnitCode).toBe(8);
  });

  it("keeps a missing net weight NULL rather than zero", async () => {
    const { fetchImplementation } = stubFetch(() => comtradeResponse([REAL_ROW_WITHOUT_WEIGHT]));
    const result = await fetchAnnualTradeFlows(QUERY, optionsWith(fetchImplementation));

    if (!result.success) throw new Error("expected success");
    const row = result.value.rows[0];
    // A weight of zero says "this weighs nothing". NULL says "nobody recorded it".
    expect(row?.netWeightMilliKilograms).toBeNull();
    expect(row?.quantityMilli).toBeNull();
    expect(row?.quantityUnit).toBe("not_applicable");
    // An estimation flag about a value that is not there is not a claim about anything —
    // and the column CHECK refuses the combination.
    expect(row?.isNetWeightEstimated).toBe(false);
    expect(row?.isQuantityEstimated).toBe(false);
  });

  it("carries the estimation provenance through unchanged", async () => {
    const { fetchImplementation } = stubFetch(() =>
      comtradeResponse([{ ...REAL_PETROLEUM_ROW, isNetWgtEstimated: true, legacyEstimationFlag: 4 }]),
    );
    const result = await fetchAnnualTradeFlows(QUERY, optionsWith(fetchImplementation));

    if (!result.success) throw new Error("expected success");
    const row = result.value.rows[0];
    expect(row?.isNetWeightEstimated).toBe(true);
    expect(row?.isAggregate).toBe(true);
    expect(row?.isReported).toBe(false);
    expect(row?.legacyEstimationFlag).toBe(4);
  });

  it("takes the WCO description as the commodity label", async () => {
    const { fetchImplementation } = stubFetch(() => comtradeResponse([REAL_PETROLEUM_ROW]));
    const result = await fetchAnnualTradeFlows(QUERY, optionsWith(fetchImplementation));

    if (!result.success) throw new Error("expected success");
    expect(result.value.rows[0]?.commodityLabel).toBe(REAL_PETROLEUM_ROW.cmdDesc);
    expect(result.value.rows[0]?.hsCode).toBe("270900");
  });
});

describe("fetchAnnualTradeFlows — filtering", () => {
  it("drops roll-up levels, which would otherwise multiply every total", async () => {
    const { fetchImplementation } = stubFetch(() => comtradeResponse([REAL_CHAPTER_ROLLUP_ROW, REAL_PETROLEUM_ROW]));
    const result = await fetchAnnualTradeFlows(QUERY, optionsWith(fetchImplementation));

    if (!result.success) throw new Error("expected success");
    expect(result.value.rows).toHaveLength(1);
    expect(result.value.rows[0]?.hsCode).toBe("270900");
    // The count is of what the API SENT, so a sync run records the real response size.
    expect(result.value.rowsReceived).toBe(2);
  });

  it("drops a line with no value — an unfiled line is not a trade of zero", async () => {
    const { fetchImplementation } = stubFetch(() => comtradeResponse([{ ...REAL_PETROLEUM_ROW, primaryValue: null }]));
    const result = await fetchAnnualTradeFlows(QUERY, optionsWith(fetchImplementation));

    if (!result.success) throw new Error("expected success");
    expect(result.value.rows).toHaveLength(0);
  });

  it("SKIPS AND COUNTS an unrecognised quantity unit rather than guessing one", async () => {
    // A row labelled with a guessed unit is a wrong number presented as a right one.
    const { fetchImplementation } = stubFetch(() => comtradeResponse([{ ...REAL_PETROLEUM_ROW, qtyUnitCode: 9_999 }]));
    const result = await fetchAnnualTradeFlows(QUERY, optionsWith(fetchImplementation));

    if (!result.success) throw new Error("expected success");
    expect(result.value.rows).toHaveLength(0);
    // The CODE is recorded, not merely a count — that is what makes the next gap
    // diagnosable without an API call.
    expect(result.value.unknownQuantityUnitCodes).toStrictEqual([9_999]);
  });
});

describe("fetchAnnualTradeFlows — failure classification", () => {
  it.each([429, 500, 502, 503])("treats HTTP %i as retryable", async (status) => {
    const { fetchImplementation } = stubFetch(() => new Response("", { status }));
    const result = await fetchAnnualTradeFlows(QUERY, optionsWith(fetchImplementation));

    if (result.success) throw new Error("expected failure");
    expect(result.error.type).toBe("COMTRADE_UNAVAILABLE");
  });

  it.each([400, 401, 403, 404, 422])("treats HTTP %i as permanent", async (status) => {
    const { fetchImplementation } = stubFetch(() => new Response("", { status }));
    const result = await fetchAnnualTradeFlows(QUERY, optionsWith(fetchImplementation));

    if (result.success) throw new Error("expected failure");
    expect(result.error.type).toBe("COMTRADE_REQUEST_REJECTED");
  });

  it("treats a thrown fetch — a timeout or a reset — as retryable", async () => {
    const fetchImplementation: FetchImplementation = vi.fn<FetchImplementation>(async () => {
      throw new Error("The operation was aborted due to timeout");
    });
    const result = await fetchAnnualTradeFlows(QUERY, optionsWith(fetchImplementation));

    if (result.success) throw new Error("expected failure");
    expect(result.error.type).toBe("COMTRADE_UNAVAILABLE");
  });

  it("treats a non-JSON 200 as retryable — an edge served us a page, not data", async () => {
    const { fetchImplementation } = stubFetch(() => new Response("<html>gateway</html>", { status: 200 }));
    const result = await fetchAnnualTradeFlows(QUERY, optionsWith(fetchImplementation));

    if (result.success) throw new Error("expected failure");
    expect(result.error.type).toBe("COMTRADE_UNAVAILABLE");
  });

  it("treats a body that does not match the contract as permanent", async () => {
    const { fetchImplementation } = stubFetch(
      () =>
        new Response(JSON.stringify({ count: "many", data: "not-an-array" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const result = await fetchAnnualTradeFlows(QUERY, optionsWith(fetchImplementation));

    if (result.success) throw new Error("expected failure");
    expect(result.error.type).toBe("COMTRADE_SCHEMA_INVALID");
    if (result.error.type !== "COMTRADE_SCHEMA_INVALID") throw new Error("narrowing");
    expect(result.error.issues.length).toBeGreaterThan(0);
  });

  it("tolerates unknown fields the provider adds later", async () => {
    // `.passthrough()`, deliberately — the opposite of the `.strict()` rule for REQUEST
    // bodies. A field they add next release must not break an ingest.
    const { fetchImplementation } = stubFetch(() =>
      comtradeResponse([{ ...REAL_PETROLEUM_ROW, someFieldAddedIn2027: "hello" }]),
    );
    const result = await fetchAnnualTradeFlows(QUERY, optionsWith(fetchImplementation));

    if (!result.success) throw new Error("expected success");
    expect(result.value.rows).toHaveLength(1);
  });
});
