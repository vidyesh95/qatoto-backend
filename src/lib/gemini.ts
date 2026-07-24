import { z } from "zod";

import type { Result } from "#src/types/index.js";

/**
 * The daily-log analysis call (R_AND_D_BACKEND_STRUCTURE.md §8, "Analysis: one Gemini
 * call, and a pipeline that never guesses").
 *
 * WHY ONE CALL AND NOT A TRANSCRIBE-THEN-EXTRACT PAIR. The AI Studio free tier is a
 * request budget, and two calls spend it twice on the same tokens. Gemini accepts a
 * YouTube URL directly and returns structured JSON, so the transcript, the summary chips,
 * the extracted claims and the evidence links all come back from one request.
 *
 * WHY PLAIN `fetch` AND NO SDK. Same reasoning as src/lib/youtube.ts, which this file
 * deliberately mirrors: the module imports no config and takes its key, model and timeout
 * as arguments, so it is a pure function of its inputs and its test suite needs neither
 * env stubs nor a network. It also keeps a vendor SDK — and its transitive dependency
 * tree — out of a backend whose only other outbound calls are `fetch` to oEmbed and
 * Nominatim.
 *
 * WHY THE OUTPUT IS PARSED WITH ZOD BEFORE IT IS TRUSTED (§0 applied to a model). A model
 * response is untrusted input in exactly the sense CLAUDE.md §2 means — more so than a
 * request body, because it is generated rather than typed. `responseSchema` makes
 * malformed output rare; it does not make it impossible, and nothing here reaches a
 * database row without passing `safeParse`.
 *
 * WHAT THIS MODULE MUST NEVER PRODUCE. A verdict. Everything it returns is §9.1's
 * left-hand column — AI-produced, reviewable, overridable — and the caller writes it with
 * `generatedByModel` + `promptVersion` attached. `effortVerificationStatus` is §9's and no
 * value in this file may reach it.
 */

/**
 * Bumped whenever the prompt or the response schema changes, and STORED ON EVERY ROW the
 * response produces.
 *
 * Without it, a chip written in July and a chip written in September are
 * indistinguishable in the data even though two different instructions produced them —
 * and §9's override flow needs to know which instruction a human is overriding.
 */
export const DAILY_LOG_ANALYSIS_PROMPT_VERSION = "daily-log-analysis-v2";

const GENERATIVE_LANGUAGE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;

/**
 * How much the model may think before it answers (Gemini 3.x's `thinkingLevel`).
 *
 * PINNED, NOT DEFAULTED, for two reasons. The shipped model — `gemini-3.5-flash-lite` — is
 * a thinking model (the API reports `thinking: true` for it), and this task is mechanical:
 * transcribe what was said, copy down what was claimed, echo the URLs verbatim. There is
 * nothing here to reason about, so unbounded thinking spends latency and free-tier quota
 * for no accuracy. Leaving it unset also leaves it free to change under us when Google
 * moves a default.
 *
 * IT IS `thinkingLevel`, NOT `thinkingBudget`. The Gemini 2.5-era `thinkingBudget: 0`
 * spelling is rejected outright by the 3.x family — HTTP 400 INVALID_ARGUMENT, which this
 * module classifies as PERMANENT, so getting it wrong would fail every analysis in the
 * environment rather than degrading quietly.
 */
const THINKING_LEVEL = "low";

/** Bounds what the model may hand back, so one verbose response cannot fill a table. */
const MAX_TRANSCRIPT_SEGMENTS = 400;
const MAX_SUMMARY_CHIPS = 8;
const MAX_EXTRACTED_CLAIMS = 20;
const MAX_EVIDENCE_LINKS = 20;

/**
 * The response contract, as Zod.
 *
 * Every bound here is ALSO a CHECK constraint on the table the value lands in (§8):
 * `label` ≤ 80, `claimSummary` ≤ 1000, `extractedMinutes` ≤ 1440, `confidenceBps` ≤ 10000.
 * Duplicating them is deliberate — the parse gives a clean `failed` with a reason, while
 * relying on the CHECK alone would surface a model's overrun as a 23514 in a job log with
 * no indication of which field was at fault.
 */
const TranscriptSegmentSchema = z
  .object({
    // Integer SECONDS (§4c rule 2). A float offset from a model would be a float in an
    // evidence record, and §9 overlaps these windows against artifact timestamps.
    startOffsetSeconds: z.number().int().min(0).max(86_400),
    endOffsetSeconds: z.number().int().min(0).max(86_400).nullable(),
    speakerLabel: z.string().max(80).nullable(),
    segmentText: z.string().min(1).max(5_000),
  })
  .strict();

const SummaryChipSchema = z
  .object({
    kind: z.enum(["blocker", "progress", "velocity", "suggestion"]),
    label: z.string().min(1).max(80),
    confidenceBps: z.number().int().min(0).max(10_000).nullable(),
  })
  .strict();

const ExtractedClaimSchema = z
  .object({
    claimKind: z.enum([
      "time_spent",
      "cash_spent",
      "artifact_reference",
      "blocker",
      "milestone_progress",
    ]),
    // What the member SAID, per §9.6 — never grounded, never paid on. Bounded at one
    // day's minutes: a larger number is an extraction error, not a work record.
    extractedMinutes: z.number().int().min(0).max(1_440).nullable(),
    extractedCashInCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    claimSummary: z.string().min(1).max(1_000),
    confidenceBps: z.number().int().min(0).max(10_000).nullable(),
  })
  .strict();

const EvidenceLinkSchema = z
  .object({
    // Host-allowlisted downstream by src/lib/external-link.ts. A model can hallucinate a
    // URL as easily as a member can mistype one, so this string gets no more trust than
    // a request body's would.
    externalUrl: z.string().min(1).max(2_048),
  })
  .strict();

const DailyLogAnalysisSchema = z
  .object({
    transcriptSegments: z.array(TranscriptSegmentSchema).max(MAX_TRANSCRIPT_SEGMENTS),
    summaryChips: z.array(SummaryChipSchema).max(MAX_SUMMARY_CHIPS),
    extractedClaims: z.array(ExtractedClaimSchema).max(MAX_EXTRACTED_CLAIMS),
    evidenceLinks: z.array(EvidenceLinkSchema).max(MAX_EVIDENCE_LINKS),
  })
  .strict();

export type DailyLogAnalysis = z.infer<typeof DailyLogAnalysisSchema>;

/**
 * The failure modes, split by WHAT THE CALLER SHOULD DO — which is the only split that
 * matters to a job handler deciding between a retry and a dead-letter.
 */
export type GeminiError =
  /** No API key in this environment. The log records `skipped_unconfigured`, not `failed`. */
  | { type: "GEMINI_NOT_CONFIGURED" }
  /** 429, 5xx, timeout, socket reset. Retryable — pg-boss backs off (§4e). */
  | { type: "GEMINI_UNAVAILABLE"; detail: string }
  /** The model refused this input: private video, blocked region, safety stop. Permanent. */
  | { type: "GEMINI_INPUT_REJECTED"; detail: string }
  /**
   * The answer hit the output ceiling and came back truncated. Permanent for this budget:
   * the same log re-analysed with the same `maxOutputTokens` truncates in the same place,
   * and truncated JSON never parses. Split from GEMINI_INPUT_REJECTED because the fix is
   * an operator raising GEMINI_MAX_OUTPUT_TOKENS, not a member re-recording their video.
   */
  | { type: "GEMINI_OUTPUT_TRUNCATED"; maxOutputTokens: number }
  /** Output that would not parse, after one repair attempt. Permanent (§9.7's rule). */
  | { type: "GEMINI_SCHEMA_INVALID"; issues: readonly string[] };

export type FetchImplementation = typeof globalThis.fetch;

export interface AnalyzeDailyLogInput {
  /** The verified 11-character id, or null for a text-only log. Never a client URL. */
  readonly youtubeVideoId: string | null;
  /** The member's own written log. May be null when there is a video. */
  readonly narrative: string | null;
  /** The claimed day, so the model can anchor "yesterday" in the member's own words. */
  readonly logDate: string;
}

export interface AnalyzeDailyLogOptions {
  readonly apiKey: string | undefined;
  readonly model: string;
  readonly timeoutMs?: number;
  readonly maxOutputTokens?: number;
  readonly fetchImplementation?: FetchImplementation;
}

export interface DailyLogAnalysisResult {
  readonly analysis: DailyLogAnalysis;
  /** Stored on every row produced, with the prompt version (§9.1 provenance). */
  readonly modelName: string;
  /** Gemini's `modelVersion`, when it reports one — the exact build that answered. */
  readonly modelVersion: string | null;
  readonly promptVersion: string;
}

/**
 * The instruction. Kept in one place, versioned by
 * DAILY_LOG_ANALYSIS_PROMPT_VERSION, and deliberately conservative in three ways:
 *
 *  1. It asks the model to report ONLY what the member actually said. A model that infers
 *     "they probably worked about four hours" writes a number into an equity pipeline.
 *  2. It requires `null` rather than a guess for any figure the member did not state.
 *  3. It forbids a verdict outright. Nothing downstream would read one, but a model that
 *     believes it is judging effort writes differently about it.
 */
function buildPrompt(input: AnalyzeDailyLogInput): string {
  return [
    "You are analyzing one daily work log submitted by a member of a product-development team.",
    `The member is logging work for the calendar day ${input.logDate}.`,
    "",
    "Produce JSON with exactly four fields: transcriptSegments, summaryChips, extractedClaims, evidenceLinks.",
    "",
    "transcriptSegments: a faithful transcript of the video, split into segments with integer",
    "second offsets from the start. Merge anything shorter than about ten seconds into its",
    "neighbour — one segment per sentence fragment inflates the response past its token",
    "ceiling on a long log, and a truncated response is discarded whole. If there is no",
    "video, return an empty array — do not transcribe the written narrative into segments.",
    "",
    "summaryChips: at most 8 short labels (<= 80 characters) categorising what happened, each",
    "one of: blocker, progress, velocity, suggestion.",
    "",
    "extractedClaims: what the member CLAIMED about their own work. Report only what they",
    "actually stated. If they did not state a duration, extractedMinutes MUST be null — never",
    "estimate, infer, or round up a duration they did not give. The same rule applies to",
    "extractedCashInCents. Durations are whole minutes and cannot exceed 1440.",
    "",
    "evidenceLinks: every URL the member referenced, verbatim. Do not invent URLs and do not",
    "complete partial ones.",
    "",
    "Do not judge, score, verify, or approve the work. You are producing inputs for a human",
    "and a formula to review, not a verdict.",
    "",
    input.narrative === null ? "" : `The member's written log:\n${input.narrative}`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * The JSON Schema handed to Gemini's `responseSchema`.
 *
 * Hand-written rather than derived from the Zod schema: the API accepts a restricted
 * OpenAPI-3 subset (no `additionalProperties`, no `$ref`, no unions), so a generic
 * converter's output is rejected at the API boundary. The Zod schema above stays the
 * authority — this is a hint that makes malformed output rare, not the thing that makes
 * it safe.
 */
const RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    transcriptSegments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          startOffsetSeconds: { type: "integer" },
          endOffsetSeconds: { type: "integer", nullable: true },
          speakerLabel: { type: "string", nullable: true },
          segmentText: { type: "string" },
        },
        required: ["startOffsetSeconds", "endOffsetSeconds", "speakerLabel", "segmentText"],
      },
    },
    summaryChips: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["blocker", "progress", "velocity", "suggestion"] },
          label: { type: "string" },
          confidenceBps: { type: "integer", nullable: true },
        },
        required: ["kind", "label", "confidenceBps"],
      },
    },
    extractedClaims: {
      type: "array",
      items: {
        type: "object",
        properties: {
          claimKind: {
            type: "string",
            enum: [
              "time_spent",
              "cash_spent",
              "artifact_reference",
              "blocker",
              "milestone_progress",
            ],
          },
          extractedMinutes: { type: "integer", nullable: true },
          extractedCashInCents: { type: "integer", nullable: true },
          claimSummary: { type: "string" },
          confidenceBps: { type: "integer", nullable: true },
        },
        required: [
          "claimKind",
          "extractedMinutes",
          "extractedCashInCents",
          "claimSummary",
          "confidenceBps",
        ],
      },
    },
    evidenceLinks: {
      type: "array",
      items: {
        type: "object",
        properties: { externalUrl: { type: "string" } },
        required: ["externalUrl"],
      },
    },
  },
  required: ["transcriptSegments", "summaryChips", "extractedClaims", "evidenceLinks"],
} as const;

interface GeminiRequestPart {
  readonly text?: string;
  readonly fileData?: { readonly fileUri: string; readonly mimeType?: string };
}

function buildRequestParts(input: AnalyzeDailyLogInput): readonly GeminiRequestPart[] {
  const parts: GeminiRequestPart[] = [{ text: buildPrompt(input) }];

  if (input.youtubeVideoId !== null) {
    // Built from the PARSED id, never a client string — the same rule that governs every
    // outbound YouTube URL in this codebase (src/lib/youtube.ts).
    parts.push({
      fileData: { fileUri: `https://www.youtube.com/watch?v=${input.youtubeVideoId}` },
    });
  }

  return parts;
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
 * These are PERMANENT for this input: retrying the same video with the same prompt
 * produces the same refusal, and burning five exponential backoff attempts on it only
 * delays the operator's signal by half an hour (§9.7).
 *
 * `MAX_TOKENS` is deliberately NOT here. It is equally permanent, but it is not a refusal
 * — it is our own output ceiling, and it is handled separately so the reason a human reads
 * points at the budget instead of at the member's video.
 */
const PERMANENT_FINISH_REASONS = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
]);

interface GenerateOutcome {
  readonly rawText: string;
  readonly modelVersion: string | null;
}

async function generateOnce(
  input: AnalyzeDailyLogInput,
  options: AnalyzeDailyLogOptions,
  repairInstruction: string | null,
): Promise<Result<GenerateOutcome, GeminiError>> {
  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const apiKey = options.apiKey;

  if (apiKey === undefined || apiKey === "") {
    return { success: false, error: { type: "GEMINI_NOT_CONFIGURED" } };
  }

  const parts = buildRequestParts(input);
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
      // governs the FORMULA, not the model), but a stable temperature makes a re-analysis
      // after a fix comparable to the run it replaced, and makes a prompt regression
      // visible instead of noise. Verified against `gemini-3.5-flash-lite` on both a
      // text-only log and a YouTube video: schema-conforming output, `finishReason: STOP`,
      // no degeneration into a loop.
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_JSON_SCHEMA,
      maxOutputTokens,
      thinkingConfig: { thinkingLevel: THINKING_LEVEL },
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
    // 400/403/404: a bad key, a model this project cannot reach, or a video the API
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

function parseAnalysis(rawText: string): Result<DailyLogAnalysis, readonly string[]> {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawText);
  } catch {
    return { success: false, error: ["response was not valid JSON"] };
  }

  const parsed = DailyLogAnalysisSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      ),
    };
  }

  return { success: true, value: parsed.data };
}

/**
 * Analyzes one daily log. The single entry point, and the only outbound LLM call in this
 * codebase.
 *
 * ONE repair attempt on a schema failure, then permanent — §9.7 draws the same line for
 * the verification pipeline's LLM steps. The repair re-sends the original request with
 * the parse errors appended, which fixes the common case (a stray field, a string where
 * an integer belongs) without turning a broken prompt into an infinite budget drain.
 */
export async function analyzeDailyLog(
  input: AnalyzeDailyLogInput,
  options: AnalyzeDailyLogOptions,
): Promise<Result<DailyLogAnalysisResult, GeminiError>> {
  const firstAttempt = await generateOnce(input, options, null);
  if (!firstAttempt.success) {
    return { success: false, error: firstAttempt.error };
  }

  const firstParse = parseAnalysis(firstAttempt.value.rawText);
  if (firstParse.success) {
    return {
      success: true,
      value: {
        analysis: firstParse.value,
        modelName: options.model,
        modelVersion: firstAttempt.value.modelVersion,
        promptVersion: DAILY_LOG_ANALYSIS_PROMPT_VERSION,
      },
    };
  }

  const repairAttempt = await generateOnce(
    input,
    options,
    [
      "Your previous response did not match the required schema. The problems were:",
      ...firstParse.error,
      "Return ONLY corrected JSON matching the schema exactly. Do not explain.",
    ].join("\n"),
  );
  if (!repairAttempt.success) {
    return { success: false, error: repairAttempt.error };
  }

  const repairParse = parseAnalysis(repairAttempt.value.rawText);
  if (!repairParse.success) {
    return {
      success: false,
      error: { type: "GEMINI_SCHEMA_INVALID", issues: repairParse.error },
    };
  }

  return {
    success: true,
    value: {
      analysis: repairParse.value,
      modelName: options.model,
      modelVersion: repairAttempt.value.modelVersion,
      promptVersion: DAILY_LOG_ANALYSIS_PROMPT_VERSION,
    },
  };
}
