import { z } from "zod";

import {
  generateOnce,
  type FetchImplementation,
  type GeminiGenerateRequest,
  type GeminiRequestPart,
  type GeminiTransportError,
} from "#src/modules/rnd/gemini-transport.js";
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
    // Host-allowlisted downstream by src/modules/rnd/external-link.ts. A model can hallucinate a
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
 *
 * Four of the five are the provider's and live in `gemini-transport.ts`, shared with every
 * other caller. `GEMINI_SCHEMA_INVALID` stays here because only a caller that owns a
 * response schema can decide that a response failed to match it.
 */
export type GeminiError =
  | GeminiTransportError
  /** Output that would not parse, after one repair attempt. Permanent (§9.7's rule). */
  | { type: "GEMINI_SCHEMA_INVALID"; issues: readonly string[] };

export type { FetchImplementation };

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
 * Everything the transport needs, assembled from this module's own prompt, schema and
 * thinking budget.
 *
 * The three fields are what USED to be hard-coded inside `generateOnce` when it served one
 * caller. They are passed rather than defaulted so a second caller cannot silently inherit
 * the daily-log response schema — which would fail its own parse in a way that reads as a
 * model fault rather than a wiring one.
 */
function buildGenerateRequest(input: AnalyzeDailyLogInput): GeminiGenerateRequest {
  return {
    parts: buildRequestParts(input),
    responseSchema: RESPONSE_JSON_SCHEMA,
    thinkingLevel: THINKING_LEVEL,
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
  const firstAttempt = await generateOnce(buildGenerateRequest(input), options, null);
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
    buildGenerateRequest(input),
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
