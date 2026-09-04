import { describe, expect, it, vi } from "vitest";

import {
  LOCALIZATION_NARRATIVE_PROMPT_VERSION,
  writeLocalizationNarrative,
  type FetchImplementation,
  type LocalizationNarrativeInput,
  type LocalizationNarrativeOptions,
} from "#src/modules/rnd/import-intelligence/localization-narrative.js";

/**
 * The narrative call, over an injected fetch — no env, no key, no network.
 *
 * TWO CLAIMS MATTER MOST HERE and both are about spend and about honesty:
 *  1. The request budget is exactly one call, or two when a repair is needed, and never
 *     three. Each one is metered.
 *  2. The model is handed the arithmetic and has nowhere to put a competing number. The
 *     response schema carries no score, no rank and no trade figure, so a model that
 *     tried to restate one would fail its own parse.
 */
const INPUT: LocalizationNarrativeInput = {
  hsCode: "854231",
  commodityLabel: "Electronic integrated circuits; processors and controllers",
  countryName: "India",
  feasibilityScorePoints: 73,
  importDependencyPoints: 35,
  exportCapabilityPoints: 18,
  substituteAvailabilityPoints: 8,
  supplierCapacityPoints: 6,
  leadTimeAdvantagePoints: 6,
  importValueLabel: "USD 11,862,990,842",
  exportValueLabel: "USD 500,000,000",
  substituteLabels: ["Domestic OSAT packaging"],
  matchedSupplierCount: 3,
  medianSupplierLeadTimeDays: 21,
};

const VALID_NARRATIVE = {
  title: "Localizing processor packaging",
  summary: "India imports these at scale and already packages some domestically.",
  pathwaySteps: [{ headline: "Qualify an OSAT partner", detail: "Start with existing lines." }],
  keyRisks: ["Capital intensity of a fab is an order of magnitude above packaging."],
  confidenceBps: 6500,
};

function modelResponse(payload: unknown, modelVersion = "gemini-3.5-flash-lite-001"): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] }, finishReason: "STOP" }],
      modelVersion,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

interface RecordedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
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
    requests.push({
      url: input instanceof Request ? input.url : String(input),
      headers,
      body: typeof init?.body === "string" ? init.body : "",
    });
    return respond(requests.length - 1);
  });
  return { fetchImplementation, requests };
}

function optionsWith(fetchImplementation: FetchImplementation): LocalizationNarrativeOptions {
  return {
    apiKey: "test-api-key",
    model: "gemini-3.5-flash-lite",
    fetchImplementation,
  };
}

describe("writeLocalizationNarrative — the request", () => {
  it("makes ZERO requests when no key is configured", async () => {
    const { fetchImplementation, requests } = stubFetch(() => modelResponse(VALID_NARRATIVE));
    const result = await writeLocalizationNarrative(INPUT, {
      ...optionsWith(fetchImplementation),
      apiKey: undefined,
    });

    if (result.success) throw new Error("expected failure");
    expect(result.error).toStrictEqual({ type: "GEMINI_NOT_CONFIGURED" });
    expect(requests).toHaveLength(0);
  });

  it("puts the key in a header, not the URL", async () => {
    const { fetchImplementation, requests } = stubFetch(() => modelResponse(VALID_NARRATIVE));
    await writeLocalizationNarrative(INPUT, optionsWith(fetchImplementation));

    expect(requests[0]?.headers["x-goog-api-key"]).toBe("test-api-key");
    expect(requests[0]?.url).not.toContain("test-api-key");
  });

  it("hands the model every computed figure, so it never derives one", async () => {
    const { fetchImplementation, requests } = stubFetch(() => modelResponse(VALID_NARRATIVE));
    await writeLocalizationNarrative(INPUT, optionsWith(fetchImplementation));

    const body = requests[0]?.body ?? "";
    expect(body).toContain("73 out of 100");
    expect(body).toContain("import dependence 35/35");
    expect(body).toContain("existing export capability 18/25");
    expect(body).toContain("USD 11,862,990,842");
  });

  it("says NOT RECORDED for an absent lead time rather than omitting the line", async () => {
    // An omitted line invites the model to invent a plausible number; an explicit
    // "NOT RECORDED" is a fact it can repeat.
    const { fetchImplementation, requests } = stubFetch(() => modelResponse(VALID_NARRATIVE));
    await writeLocalizationNarrative(
      { ...INPUT, medianSupplierLeadTimeDays: null, substituteLabels: [] },
      optionsWith(fetchImplementation),
    );

    const body = requests[0]?.body ?? "";
    expect(body).toContain("NOT RECORDED");
    expect(body).toContain("NONE RECORDED");
  });

  it("instructs the model not to re-score", async () => {
    const { fetchImplementation, requests } = stubFetch(() => modelResponse(VALID_NARRATIVE));
    await writeLocalizationNarrative(INPUT, optionsWith(fetchImplementation));

    const body = requests[0]?.body ?? "";
    expect(body).toContain("not yours to assign");
    expect(body).toContain("Do not recompute");
  });
});

describe("writeLocalizationNarrative — the response", () => {
  it("returns the narrative with full provenance", async () => {
    const { fetchImplementation } = stubFetch(() => modelResponse(VALID_NARRATIVE));
    const result = await writeLocalizationNarrative(INPUT, optionsWith(fetchImplementation));

    if (!result.success) throw new Error("expected success");
    expect(result.value.modelName).toBe("gemini-3.5-flash-lite");
    expect(result.value.modelVersion).toBe("gemini-3.5-flash-lite-001");
    expect(result.value.promptVersion).toBe(LOCALIZATION_NARRATIVE_PROMPT_VERSION);
    expect(result.value.narrative.title).toBe(VALID_NARRATIVE.title);
  });

  it("accepts a null confidence — a guessed one would be worse than none", async () => {
    const { fetchImplementation } = stubFetch(() => modelResponse({ ...VALID_NARRATIVE, confidenceBps: null }));
    const result = await writeLocalizationNarrative(INPUT, optionsWith(fetchImplementation));

    if (!result.success) throw new Error("expected success");
    expect(result.value.narrative.confidenceBps).toBeNull();
  });

  it("REJECTS a response carrying a score, because the schema has nowhere to put one", async () => {
    // `.strict()` on the response schema is what makes "the model cannot contradict the
    // arithmetic" a mechanical guarantee rather than a prompt instruction.
    const { fetchImplementation } = stubFetch(() => modelResponse({ ...VALID_NARRATIVE, feasibilityScorePoints: 91 }));
    const result = await writeLocalizationNarrative(INPUT, optionsWith(fetchImplementation));

    if (result.success) throw new Error("expected failure");
    expect(result.error.type).toBe("GEMINI_SCHEMA_INVALID");
  });

  it("rejects a confidence outside 0..10000", async () => {
    const { fetchImplementation } = stubFetch(() => modelResponse({ ...VALID_NARRATIVE, confidenceBps: 20_000 }));
    const result = await writeLocalizationNarrative(INPUT, optionsWith(fetchImplementation));

    if (result.success) throw new Error("expected failure");
    expect(result.error.type).toBe("GEMINI_SCHEMA_INVALID");
  });
});

describe("writeLocalizationNarrative — the request budget", () => {
  it("repairs a schema-invalid response ONCE and succeeds", async () => {
    const { fetchImplementation, requests } = stubFetch((callIndex) =>
      callIndex === 0 ? modelResponse({ title: "missing everything else" }) : modelResponse(VALID_NARRATIVE),
    );
    const result = await writeLocalizationNarrative(INPUT, optionsWith(fetchImplementation));

    expect(result.success).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.body).toContain("did not match the required schema");
  });

  it("gives up after ONE repair — never a third call", async () => {
    const { fetchImplementation, requests } = stubFetch(() => modelResponse({ nope: true }));
    const result = await writeLocalizationNarrative(INPUT, optionsWith(fetchImplementation));

    if (result.success) throw new Error("expected failure");
    expect(result.error.type).toBe("GEMINI_SCHEMA_INVALID");
    expect(requests).toHaveLength(2);
  });

  it("does NOT repair a transport failure", async () => {
    const { fetchImplementation, requests } = stubFetch(() => new Response("", { status: 503 }));
    const result = await writeLocalizationNarrative(INPUT, optionsWith(fetchImplementation));

    if (result.success) throw new Error("expected failure");
    expect(result.error.type).toBe("GEMINI_UNAVAILABLE");
    expect(requests).toHaveLength(1);
  });
});

describe("writeLocalizationNarrative — failure classification", () => {
  it.each([429, 500, 503])("treats HTTP %i as retryable", async (status) => {
    const { fetchImplementation } = stubFetch(() => new Response("", { status }));
    const result = await writeLocalizationNarrative(INPUT, optionsWith(fetchImplementation));

    if (result.success) throw new Error("expected failure");
    expect(result.error.type).toBe("GEMINI_UNAVAILABLE");
  });

  it.each([400, 403, 404])("treats HTTP %i as permanent", async (status) => {
    const { fetchImplementation } = stubFetch(() => new Response("", { status }));
    const result = await writeLocalizationNarrative(INPUT, optionsWith(fetchImplementation));

    if (result.success) throw new Error("expected failure");
    expect(result.error.type).toBe("GEMINI_INPUT_REJECTED");
  });

  it("reports a truncation as its own error naming the ceiling, and does not retry", async () => {
    const { fetchImplementation, requests } = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: '{"title":"cut o' }] }, finishReason: "MAX_TOKENS" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const result = await writeLocalizationNarrative(INPUT, {
      ...optionsWith(fetchImplementation),
      maxOutputTokens: 4_096,
    });

    if (result.success) throw new Error("expected failure");
    expect(result.error).toStrictEqual({
      type: "GEMINI_OUTPUT_TRUNCATED",
      maxOutputTokens: 4_096,
    });
    expect(requests).toHaveLength(1);
  });

  it("treats a safety block as permanent", async () => {
    const { fetchImplementation } = stubFetch(
      () =>
        new Response(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const result = await writeLocalizationNarrative(INPUT, optionsWith(fetchImplementation));

    if (result.success) throw new Error("expected failure");
    expect(result.error.type).toBe("GEMINI_INPUT_REJECTED");
  });
});
