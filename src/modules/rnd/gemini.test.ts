import { describe, expect, it, vi } from "vitest";

import {
  analyzeDailyLog,
  DAILY_LOG_ANALYSIS_PROMPT_VERSION,
  type AnalyzeDailyLogInput,
  type FetchImplementation,
} from "#src/modules/rnd/gemini.js";

/**
 * Every outcome is exercised with an injected `fetch`, so the suite needs no key, no
 * network and no env — the same arrangement src/lib/youtube.test.ts uses.
 *
 * The split that matters here is RETRYABLE vs PERMANENT: the job handler turns the first
 * into a pg-boss backoff and the second into a dead-letter plus `analysis_status =
 * 'failed'`. Getting it backwards either burns a free-tier budget retrying a refusal, or
 * gives up on a transient 503.
 */

const INPUT: AnalyzeDailyLogInput = {
  youtubeVideoId: "dQw4w9WgXcQ",
  narrative: "Spent the morning on the compressor housing.",
  logDate: "2026-07-24",
};

const VALID_ANALYSIS = {
  transcriptSegments: [
    {
      startOffsetSeconds: 0,
      endOffsetSeconds: 12,
      speakerLabel: null,
      segmentText: "Today I finished the compressor housing.",
    },
  ],
  summaryChips: [{ kind: "progress", label: "Compressor housing done", confidenceBps: 8000 }],
  extractedClaims: [
    {
      claimKind: "time_spent",
      extractedMinutes: 180,
      extractedCashInCents: null,
      claimSummary: "Three hours on the compressor housing.",
      confidenceBps: 7000,
    },
  ],
  evidenceLinks: [{ externalUrl: "https://github.com/qatoto/backend/commit/abc1234" }],
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function candidateResponse(analysisJson: unknown, modelVersion = "gemini-3.5-flash-lite-07-2026"): Response {
  return jsonResponse({
    candidates: [{ content: { parts: [{ text: JSON.stringify(analysisJson) }] }, finishReason: "STOP" }],
    modelVersion,
  });
}

/**
 * A fetch stub that records what was actually sent. Typed as `FetchImplementation` at the
 * declaration rather than cast at the call site — the same shape src/lib/youtube.test.ts
 * uses, and the reason this file needs no `as unknown as` anywhere.
 */
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

const baseOptions = { apiKey: "test-key", model: "gemini-3.5-flash-lite" };

describe("analyzeDailyLog", () => {
  it("returns the parsed analysis with its provenance", async () => {
    const { fetchImplementation } = stubFetch(() => candidateResponse(VALID_ANALYSIS));

    const result = await analyzeDailyLog(INPUT, { ...baseOptions, fetchImplementation });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.analysis.extractedClaims[0]?.extractedMinutes).toBe(180);
    // Provenance is not optional: §9's override flow needs to know which model and which
    // instruction produced the row a human is overriding.
    expect(result.value.modelName).toBe("gemini-3.5-flash-lite");
    expect(result.value.modelVersion).toBe("gemini-3.5-flash-lite-07-2026");
    expect(result.value.promptVersion).toBe(DAILY_LOG_ANALYSIS_PROMPT_VERSION);
  });

  it("sends the key as a header and the video as a fileData part built from the id", async () => {
    const { fetchImplementation, requests } = stubFetch(() => candidateResponse(VALID_ANALYSIS));

    await analyzeDailyLog(INPUT, { ...baseOptions, fetchImplementation });

    const request = requests[0];
    expect(request?.url).toContain("gemini-3.5-flash-lite:generateContent");
    // A key in the query string lands in access logs and in every proxy in between.
    expect(request?.url).not.toContain("test-key");
    expect(request?.headers["x-goog-api-key"]).toBe("test-key");

    // Built from the PARSED id, never a client string.
    expect(request?.body).toContain("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    // Deterministic decoding, so a re-analysis after a fix is comparable to the run it
    // replaced rather than noise.
    expect(request?.body).toContain('"temperature":0');
  });

  it("pins thinkingLevel rather than inheriting a provider default", async () => {
    const { fetchImplementation, requests } = stubFetch(() => candidateResponse(VALID_ANALYSIS));

    await analyzeDailyLog(INPUT, { ...baseOptions, fetchImplementation });

    // `thinkingLevel`, NOT the Gemini 2.5-era `thinkingBudget` — the 3.x family answers the
    // old spelling with a 400, which this module classifies permanent, so the wrong key
    // here fails every analysis in the environment instead of degrading.
    expect(requests[0]?.body).toContain('"thinkingConfig":{"thinkingLevel":"low"}');
    expect(requests[0]?.body).not.toContain("thinkingBudget");
  });

  it("sends the configured output ceiling, so an operator can actually raise it", async () => {
    const { fetchImplementation, requests } = stubFetch(() => candidateResponse(VALID_ANALYSIS));

    await analyzeDailyLog(INPUT, {
      ...baseOptions,
      maxOutputTokens: 65_536,
      fetchImplementation,
    });

    expect(requests[0]?.body).toContain('"maxOutputTokens":65536');
  });

  it("sends no fileData part for a text-only log", async () => {
    const { fetchImplementation, requests } = stubFetch(() => candidateResponse(VALID_ANALYSIS));

    await analyzeDailyLog(
      { youtubeVideoId: null, narrative: "Bench-tested the pump.", logDate: "2026-07-24" },
      { ...baseOptions, fetchImplementation },
    );

    expect(requests[0]?.body).not.toContain("fileData");
  });

  it("reports NOT_CONFIGURED without making a request", async () => {
    const { fetchImplementation, requests } = stubFetch(() => candidateResponse(VALID_ANALYSIS));

    const result = await analyzeDailyLog(INPUT, {
      apiKey: undefined,
      model: "gemini-3.5-flash-lite",
      fetchImplementation,
    });

    expect(result).toStrictEqual({ success: false, error: { type: "GEMINI_NOT_CONFIGURED" } });
    expect(requests).toHaveLength(0);
  });

  it("treats 429 and 5xx as retryable", async () => {
    for (const status of [429, 500, 503]) {
      const { fetchImplementation } = stubFetch(() => jsonResponse({}, status));
      const result = await analyzeDailyLog(INPUT, { ...baseOptions, fetchImplementation });
      expect(result.success).toBe(false);
      if (result.success) continue;
      expect(result.error.type).toBe("GEMINI_UNAVAILABLE");
    }
  });

  it("treats a 4xx as permanent, because retrying a bad key never succeeds", async () => {
    for (const status of [400, 403, 404]) {
      const { fetchImplementation } = stubFetch(() => jsonResponse({}, status));
      const result = await analyzeDailyLog(INPUT, { ...baseOptions, fetchImplementation });
      expect(result.success).toBe(false);
      if (result.success) continue;
      expect(result.error.type).toBe("GEMINI_INPUT_REJECTED");
    }
  });

  it("treats a network failure or timeout as retryable", async () => {
    const fetchImplementation: FetchImplementation = vi.fn<FetchImplementation>(async () => {
      throw new Error("The operation was aborted due to timeout");
    });

    const result = await analyzeDailyLog(INPUT, { ...baseOptions, fetchImplementation });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.type).toBe("GEMINI_UNAVAILABLE");
  });

  it("treats a safety block as permanent", async () => {
    const { fetchImplementation } = stubFetch(() => jsonResponse({ promptFeedback: { blockReason: "SAFETY" } }));

    const result = await analyzeDailyLog(INPUT, { ...baseOptions, fetchImplementation });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toStrictEqual({
      type: "GEMINI_INPUT_REJECTED",
      detail: "blocked: SAFETY",
    });
  });

  it("treats a truncated response as permanent rather than retrying into the same wall", async () => {
    const { fetchImplementation, requests } = stubFetch(() =>
      jsonResponse({
        candidates: [{ content: { parts: [{ text: "{" }] }, finishReason: "MAX_TOKENS" }],
      }),
    );

    const result = await analyzeDailyLog(INPUT, {
      ...baseOptions,
      maxOutputTokens: 4_096,
      fetchImplementation,
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    // Its OWN type, carrying the ceiling that stopped it. Truncation is not a refusal: an
    // operator raises a limit, they do not go looking at the member's video. And it must
    // not be retried into the same wall — one attempt, no repair.
    expect(result.error).toStrictEqual({
      type: "GEMINI_OUTPUT_TRUNCATED",
      maxOutputTokens: 4_096,
    });
    expect(requests).toHaveLength(1);
  });

  it("repairs a schema-invalid response ONCE and succeeds", async () => {
    const { fetchImplementation, requests } = stubFetch((callIndex) =>
      callIndex === 0
        ? // First: an extra key the strict schema refuses.
          candidateResponse({ ...VALID_ANALYSIS, unexpectedKey: 1 })
        : candidateResponse(VALID_ANALYSIS),
    );

    const result = await analyzeDailyLog(INPUT, { ...baseOptions, fetchImplementation });

    expect(result.success).toBe(true);
    expect(requests).toHaveLength(2);
    // The repair names the actual parse failures, which is what fixes the common case.
    expect(requests[1]?.body).toContain("did not match the required schema");
  });

  it("gives up after ONE repair, permanently", async () => {
    const { fetchImplementation, requests } = stubFetch(() => candidateResponse({ transcriptSegments: "no" }));

    const result = await analyzeDailyLog(INPUT, { ...baseOptions, fetchImplementation });

    // Exactly two: the attempt and its one repair. Never a third.
    expect(requests).toHaveLength(2);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.type).toBe("GEMINI_SCHEMA_INVALID");
  });

  it("rejects a hallucinated duration above one day", async () => {
    // The model is the untrusted input here. 4000 minutes is not a work record, and it
    // must fail at the parse rather than surface as a plausible number in §9.
    const { fetchImplementation } = stubFetch(() =>
      candidateResponse({
        ...VALID_ANALYSIS,
        extractedClaims: [{ ...VALID_ANALYSIS.extractedClaims[0], extractedMinutes: 4000 }],
      }),
    );

    const result = await analyzeDailyLog(INPUT, { ...baseOptions, fetchImplementation });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.type).toBe("GEMINI_SCHEMA_INVALID");
  });

  it("rejects a fractional duration, because minutes are integers", async () => {
    const { fetchImplementation } = stubFetch(() =>
      candidateResponse({
        ...VALID_ANALYSIS,
        extractedClaims: [{ ...VALID_ANALYSIS.extractedClaims[0], extractedMinutes: 12.5 }],
      }),
    );

    const result = await analyzeDailyLog(INPUT, { ...baseOptions, fetchImplementation });

    expect(result.success).toBe(false);
  });

  it("treats a response with no text part as retryable", async () => {
    const { fetchImplementation } = stubFetch(() => jsonResponse({ candidates: [{ content: { parts: [] } }] }));

    const result = await analyzeDailyLog(INPUT, { ...baseOptions, fetchImplementation });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.type).toBe("GEMINI_UNAVAILABLE");
  });
});
