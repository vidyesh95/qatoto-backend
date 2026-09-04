/**
 * The Gemini HTTP transport, shared.
 *
 * WHY THIS FILE EXISTS. `gemini.ts` kept this half private, which was correct while it was
 * the only caller. §10A's localization narrative is the second, and duplicating ~130 lines
 * of vendor call — the timeout, the status classification, the response type guards, the
 * finish-reason table — would be two places a provider change has to be made and one place
 * it will be forgotten. This is a byte-for-byte lift out of `gemini.ts`, with exactly one
 * signature change: `generateOnce` now takes ALREADY-BUILT request parts and the response
 * schema, instead of a `AnalyzeDailyLogInput` it knew how to render itself.
 *
 * WHAT STAYED BEHIND, and why the split falls here: everything above is about talking to
 * the provider, and everything in `gemini.ts` is about daily logs. `GEMINI_SCHEMA_INVALID`
 * is the one error variant that did not move, because only a caller that knows its own
 * response schema can produce it.
 *
 * THE GUARD ON THIS EXTRACTION is that `gemini.test.ts` passes unedited. That suite names
 * `analyzeDailyLog` and never `generateOnce`, and it pins the request body as a string —
 * so the key order in `generationConfig` below is load-bearing, not cosmetic.
 */
import type { Result } from "#src/types/index.js";

const GENERATIVE_LANGUAGE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

export const DEFAULT_TIMEOUT_MS = 180_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;

export type FetchImplementation = typeof globalThis.fetch;

/**
 * The provider-level failure modes, split by WHAT THE CALLER SHOULD DO — the only split
 * that matters to a job handler deciding between a retry and a dead-letter.
 */
export type GeminiTransportError =
  /** No API key in this environment. Callers record `skipped_unconfigured`, not `failed`. */
  | { type: "GEMINI_NOT_CONFIGURED" }
  /** 429, 5xx, timeout, socket reset. Retryable — pg-boss backs off (§4e). */
  | { type: "GEMINI_UNAVAILABLE"; detail: string }
  /** The model refused this input: private video, blocked region, safety stop. Permanent. */
  | { type: "GEMINI_INPUT_REJECTED"; detail: string }
  /**
   * The answer hit the output ceiling and came back truncated. Permanent for this budget:
   * the same input re-sent with the same `maxOutputTokens` truncates in the same place,
   * and truncated JSON never parses. Split from GEMINI_INPUT_REJECTED because the fix is
   * an operator raising GEMINI_MAX_OUTPUT_TOKENS, not a member re-recording anything.
   */
  | { type: "GEMINI_OUTPUT_TRUNCATED"; maxOutputTokens: number };

/** One part of a request: prose, or a file the model should look at. */
export interface GeminiRequestPart {
  readonly text?: string;
  readonly fileData?: { readonly fileUri: string; readonly mimeType?: string };
}

/**
 * The slice of Gemini's response this module reads.
 *
 * A type guard rather than an `as` cast (CLAUDE.md §4). Everything is optional because a
 * safety stop, a token-limit truncation and an ordinary answer all come back as a 200
 * with different fields present — and telling those apart is the point of `finishReason`.
 */
interface GeminiResponsePayload {
  readonly candidates?: readonly {
    readonly content?: { readonly parts?: readonly { readonly text?: string }[] };
    readonly finishReason?: string;
  }[];
  readonly promptFeedback?: { readonly blockReason?: string };
  readonly modelVersion?: string;
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === "object" && candidate !== null;
}

function readResponsePayload(candidate: unknown): GeminiResponsePayload | null {
  if (!isRecord(candidate)) return null;

  const { candidates, promptFeedback, modelVersion } = candidate;
  if (candidates !== undefined && !Array.isArray(candidates)) return null;
  if (promptFeedback !== undefined && !isRecord(promptFeedback)) return null;
  if (modelVersion !== undefined && typeof modelVersion !== "string") return null;

  // The nested shapes are read defensively below rather than validated here; every access
  // is optional-chained and every miss becomes a GEMINI_UNAVAILABLE rather than a throw.
  return candidate;
}

function extractResponseText(payload: GeminiResponsePayload): string | null {
  const firstCandidate = payload.candidates?.[0];
  const textParts = firstCandidate?.content?.parts
    ?.map((part) => part.text)
    .filter((text): text is string => typeof text === "string");

  if (textParts === undefined || textParts.length === 0) {
    return null;
  }
  return textParts.join("");
}

/**
 * `finishReason` values that mean the model REFUSED rather than answered.
 *
 * These are PERMANENT for this input: retrying the same request with the same prompt
 * produces the same refusal, and burning five exponential backoff attempts on it only
 * delays the operator's signal by half an hour (§9.7).
 *
 * `MAX_TOKENS` is deliberately NOT here. It is equally permanent, but it is not a refusal
 * — it is our own output ceiling, and it is handled separately so the reason a human reads
 * points at the budget instead of at the input.
 */
const PERMANENT_FINISH_REASONS = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
]);

export interface GenerateOutcome {
  readonly rawText: string;
  readonly modelVersion: string | null;
}

/** What to ask for. The caller owns its own prompt, schema and thinking budget. */
export interface GeminiGenerateRequest {
  readonly parts: readonly GeminiRequestPart[];
  /** The provider's JSON-schema dialect. Opaque here; the caller's contract, not ours. */
  readonly responseSchema: unknown;
  /** Gemini 3.x's `thinkingLevel`. Pinned by the caller, never defaulted here. */
  readonly thinkingLevel: string;
}

export interface GeminiTransportOptions {
  readonly apiKey: string | undefined;
  readonly model: string;
  readonly timeoutMs?: number;
  readonly maxOutputTokens?: number;
  readonly fetchImplementation?: FetchImplementation;
}

/**
 * One request, one classification. No retries live here — a caller that wants a repair
 * attempt sends a second request with `repairInstruction` set, which is what makes the
 * "exactly two calls, never three" budget visible at the call site instead of hidden.
 */
export async function generateOnce(
  request: GeminiGenerateRequest,
  options: GeminiTransportOptions,
  repairInstruction: string | null,
): Promise<Result<GenerateOutcome, GeminiTransportError>> {
  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const apiKey = options.apiKey;

  if (apiKey === undefined || apiKey === "") {
    return { success: false, error: { type: "GEMINI_NOT_CONFIGURED" } };
  }

  const { parts } = request;
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const requestBody = {
    contents: [
      {
        role: "user",
        parts: repairInstruction === null ? parts : [...parts, { text: repairInstruction }],
      },
    ],
    generationConfig: {
      // Zero, deliberately, and kept at zero on a Gemini 3.x model whose own default is 1.
      // The output is not formula-produced and is not required to be bit-identical (§4c
      // governs the FORMULA, not the model), but a stable temperature makes a re-run after
      // a fix comparable to the run it replaced, and makes a prompt regression visible
      // instead of noise.
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: request.responseSchema,
      maxOutputTokens,
      thinkingConfig: { thinkingLevel: request.thinkingLevel },
    },
  };

  let response: Response;
  try {
    response = await fetchImplementation(
      `${GENERATIVE_LANGUAGE_BASE_URL}/${encodeURIComponent(options.model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Header, not a query parameter: a key in a URL lands in access logs and in
          // any proxy in between.
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
  } catch (error: unknown) {
    // A timeout, a DNS failure or a socket reset. Explicitly caught because Express 5
    // forwards a rejected promise to the error handler, and an unhandled AbortError in a
    // job would surface as an unclassified crash rather than a retry.
    return {
      success: false,
      error: {
        type: "GEMINI_UNAVAILABLE",
        detail: error instanceof Error ? error.message : "network failure",
      },
    };
  }

  if (!response.ok) {
    if (response.status === 429 || response.status >= 500) {
      return {
        success: false,
        error: { type: "GEMINI_UNAVAILABLE", detail: `HTTP ${response.status}` },
      };
    }
    // 400/403/404: a bad key, a model this project cannot reach, or an input the API
    // refuses. None of them improve on retry.
    return {
      success: false,
      error: { type: "GEMINI_INPUT_REJECTED", detail: `HTTP ${response.status}` },
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      success: false,
      error: { type: "GEMINI_UNAVAILABLE", detail: "response was not JSON" },
    };
  }

  const readPayload = readResponsePayload(payload);
  if (readPayload === null) {
    return {
      success: false,
      error: { type: "GEMINI_UNAVAILABLE", detail: "response had an unexpected shape" },
    };
  }

  const blockReason = readPayload.promptFeedback?.blockReason;
  if (blockReason !== undefined) {
    return {
      success: false,
      error: { type: "GEMINI_INPUT_REJECTED", detail: `blocked: ${blockReason}` },
    };
  }

  const finishReason = readPayload.candidates?.[0]?.finishReason;
  if (finishReason !== undefined && PERMANENT_FINISH_REASONS.has(finishReason)) {
    return {
      success: false,
      error: { type: "GEMINI_INPUT_REJECTED", detail: `finishReason: ${finishReason}` },
    };
  }
  // Checked BEFORE the text is read: a truncated response usually still carries text, and
  // it is exactly the half a JSON document that would otherwise fail the parse with a
  // syntax error that says nothing about why.
  if (finishReason === "MAX_TOKENS") {
    return { success: false, error: { type: "GEMINI_OUTPUT_TRUNCATED", maxOutputTokens } };
  }

  const rawText = extractResponseText(readPayload);
  if (rawText === null) {
    return {
      success: false,
      error: { type: "GEMINI_UNAVAILABLE", detail: "response carried no text part" },
    };
  }

  return {
    success: true,
    value: { rawText, modelVersion: readPayload.modelVersion ?? null },
  };
}
