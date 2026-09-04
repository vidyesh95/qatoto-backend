/**
 * The localization pathway narrative — prose written OVER a score the model did not
 * compute (§10A).
 *
 * WHAT THIS MODULE MUST NEVER PRODUCE: a score, a rank, or a verdict. `gemini.ts` states
 * the same rule for its own module and it applies here unchanged. The feasibility number,
 * its five components and the trade figures are all computed by
 * `localization-feasibility-score.ts` and handed to the model INSIDE the prompt — so the
 * model is describing arithmetic it cannot contradict, and there is no field in the
 * response schema it could contradict it with.
 *
 * Everything it returns is advisory: `localization_pathway_suggestion` rows carry the
 * model name, the prompt version and a nullable confidence, and a human accepts or
 * dismisses them. A machine opinion whose origin is hidden reads as a platform ruling.
 *
 * Shaped like `analyzeDailyLog`: one call, a repair attempt if the JSON does not match,
 * then permanent. The transport is shared (`gemini-transport.ts`), so the timeout, the
 * status classification and the finish-reason table are the same ones the daily-log path
 * has been running against the live provider.
 */
import { z } from "zod";

import {
  generateOnce,
  type FetchImplementation,
  type GeminiGenerateRequest,
  type GeminiTransportError,
} from "#src/modules/rnd/gemini-transport.js";
import type { Result } from "#src/types/index.js";

/**
 * Bumped on ANY change to the prompt or the response schema, and stored on every row this
 * module produces.
 *
 * Without it a pathway written in September and one written in November are
 * indistinguishable in the data even though two different instructions produced them —
 * and a moderator dismissing a suggestion needs to know which instruction produced it.
 */
export const LOCALIZATION_NARRATIVE_PROMPT_VERSION = "localization-narrative-v1";

/**
 * Low, like the daily-log path. The model is not being asked to reason its way to a
 * number — the numbers are given. It is being asked to explain a pathway, and a long
 * thinking budget on a summarisation task spends a metered request for no gain.
 */
const THINKING_LEVEL = "low";

const MAX_PATHWAY_STEPS = 6;
const MAX_RISKS = 5;

export type { FetchImplementation };

/** The failure modes. Four are the provider's; the fifth is this module's own contract. */
export type LocalizationNarrativeError =
  | GeminiTransportError
  /** Output that would not parse, after one repair attempt. Permanent. */
  | { type: "GEMINI_SCHEMA_INVALID"; issues: readonly string[] };

const PathwayStepSchema = z
  .object({
    headline: z.string().min(1).max(120),
    detail: z.string().min(1).max(600),
  })
  .strict();

/**
 * What the model may return.
 *
 * NOTE WHAT IS ABSENT: there is no score field, no rank field and no trade figure. The
 * model cannot restate the arithmetic because the schema gives it nowhere to put it — a
 * stronger guarantee than instructing it not to.
 *
 * `confidenceBps` is nullable and the prompt says so: a model that must always produce a
 * confidence produces a fabricated one, and a fabricated confidence is worse than none.
 */
const LocalizationNarrativeSchema = z
  .object({
    title: z.string().min(1).max(200),
    summary: z.string().min(1).max(2000),
    pathwaySteps: z.array(PathwayStepSchema).max(MAX_PATHWAY_STEPS),
    keyRisks: z.array(z.string().min(1).max(400)).max(MAX_RISKS),
    confidenceBps: z.number().int().min(0).max(10_000).nullable(),
  })
  .strict();

export type LocalizationNarrative = z.infer<typeof LocalizationNarrativeSchema>;

/** The already-computed facts the model describes. It receives these; it never derives them. */
export interface LocalizationNarrativeInput {
  readonly hsCode: string;
  readonly commodityLabel: string;
  readonly countryName: string;
  readonly feasibilityScorePoints: number;
  readonly importDependencyPoints: number;
  readonly exportCapabilityPoints: number;
  readonly substituteAvailabilityPoints: number;
  readonly supplierCapacityPoints: number;
  readonly leadTimeAdvantagePoints: number;
  /** Formatted by the caller, so this module composes no currency and rounds nothing. */
  readonly importValueLabel: string;
  readonly exportValueLabel: string;
  readonly substituteLabels: readonly string[];
  readonly matchedSupplierCount: number;
  /** NULL when no supplier published one. Rendered as an absence, never as zero days. */
  readonly medianSupplierLeadTimeDays: number | null;
}

export interface LocalizationNarrativeOptions {
  readonly apiKey: string | undefined;
  readonly model: string;
  readonly timeoutMs?: number;
  readonly maxOutputTokens?: number;
  readonly fetchImplementation?: FetchImplementation;
}

export interface LocalizationNarrativeResult {
  readonly narrative: LocalizationNarrative;
  readonly modelName: string;
  readonly modelVersion: string | null;
  readonly promptVersion: string;
}

/**
 * The instruction, versioned by LOCALIZATION_NARRATIVE_PROMPT_VERSION and deliberately
 * constrained in four ways:
 *
 *  1. Every number it may mention is given to it. It is told not to compute or revise one.
 *  2. It must say "not recorded" for an absent figure rather than infer a plausible value
 *     — a fabricated lead time here becomes a founder's production schedule.
 *  3. It is told the score is not its judgement to make. A model that believes it is
 *     grading feasibility writes differently about it.
 *  4. A confidence is optional and it is told to omit rather than invent one.
 */
function buildPrompt(input: LocalizationNarrativeInput): string {
  const leadTimeLine =
    input.medianSupplierLeadTimeDays === null
      ? "Median domestic supplier lead time: NOT RECORDED (no supplier has published one)"
      : `Median domestic supplier lead time: ${input.medianSupplierLeadTimeDays} days`;

  const substituteLine =
    input.substituteLabels.length === 0
      ? "Known domestic substitutes: NONE RECORDED"
      : `Known domestic substitutes: ${input.substituteLabels.join("; ")}`;

  return [
    "You are advising a founder deciding whether to manufacture a currently-imported good domestically.",
    "",
    "FACTS. Every figure below has already been computed. Do not recompute, revise, round or",
    "contradict any of them, and do not state any number that does not appear here.",
    "",
    `Commodity: ${input.commodityLabel} (HS code ${input.hsCode})`,
    `Country: ${input.countryName}`,
    `Annual imports: ${input.importValueLabel}`,
    `Annual exports: ${input.exportValueLabel}`,
    substituteLine,
    `Domestic suppliers with a matching capability: ${input.matchedSupplierCount}`,
    leadTimeLine,
    "",
    `Feasibility score: ${input.feasibilityScorePoints} out of 100, made up of:`,
    `  import dependence ${input.importDependencyPoints}/35`,
    `  existing export capability ${input.exportCapabilityPoints}/25`,
    `  substitute availability ${input.substituteAvailabilityPoints}/20`,
    `  supplier capacity ${input.supplierCapacityPoints}/12`,
    `  lead-time advantage ${input.leadTimeAdvantagePoints}/8`,
    "",
    "YOUR TASK. Write a practical pathway to local production for this commodity.",
    "",
    "RULES.",
    "- The score is given, not yours to assign. Do not argue with it, re-score it, or",
    "  describe the commodity as more or less feasible than the score states.",
    "- Where a fact above says NOT RECORDED or NONE RECORDED, say so plainly. Never",
    "  estimate, infer or illustrate a value that was not given to you.",
    "- Be concrete about sequencing: what a team does first, what that unblocks.",
    "- Name real risks, including regulatory and capital ones. Do not reassure.",
    "- Set confidenceBps only if you genuinely have a basis for it, on a 0-10000 scale.",
    "  Otherwise set it to null. A guessed confidence is worse than no confidence.",
    "- Do not state a verdict on whether the founder should proceed. That is their call.",
  ].join("\n");
}

/** The provider's JSON-schema dialect. Mirrors LocalizationNarrativeSchema exactly. */
const RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    pathwaySteps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          headline: { type: "string" },
          detail: { type: "string" },
        },
        required: ["headline", "detail"],
      },
    },
    keyRisks: { type: "array", items: { type: "string" } },
    confidenceBps: { type: "integer", nullable: true },
  },
  required: ["title", "summary", "pathwaySteps", "keyRisks"],
} as const;

function buildGenerateRequest(input: LocalizationNarrativeInput): GeminiGenerateRequest {
  return {
    parts: [{ text: buildPrompt(input) }],
    responseSchema: RESPONSE_JSON_SCHEMA,
    thinkingLevel: THINKING_LEVEL,
  };
}

function parseNarrative(rawText: string): Result<LocalizationNarrative, readonly string[]> {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawText);
  } catch {
    return { success: false, error: ["response was not valid JSON"] };
  }

  // safeParse against `unknown`, never an `as` cast: the model's output is untrusted input
  // in exactly the sense a request body is, and `responseSchema` makes malformed output
  // rare rather than impossible.
  const parsed = LocalizationNarrativeSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    };
  }
  return { success: true, value: parsed.data };
}

/**
 * Writes one pathway narrative.
 *
 * ONE REPAIR ATTEMPT on a schema failure, then permanent — §9.7 draws the same line for
 * the verification pipeline. The repair re-sends with the parse errors appended, which
 * fixes the common case (a stray field, a string where an integer belongs) without turning
 * a broken prompt into an unbounded spend against a metered budget.
 */
export async function writeLocalizationNarrative(
  input: LocalizationNarrativeInput,
  options: LocalizationNarrativeOptions,
): Promise<Result<LocalizationNarrativeResult, LocalizationNarrativeError>> {
  const request = buildGenerateRequest(input);

  const firstAttempt = await generateOnce(request, options, null);
  if (!firstAttempt.success) {
    return { success: false, error: firstAttempt.error };
  }

  const firstParse = parseNarrative(firstAttempt.value.rawText);
  if (firstParse.success) {
    return {
      success: true,
      value: {
        narrative: firstParse.value,
        modelName: options.model,
        modelVersion: firstAttempt.value.modelVersion,
        promptVersion: LOCALIZATION_NARRATIVE_PROMPT_VERSION,
      },
    };
  }

  const repairAttempt = await generateOnce(
    request,
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

  const repairParse = parseNarrative(repairAttempt.value.rawText);
  if (!repairParse.success) {
    return {
      success: false,
      error: { type: "GEMINI_SCHEMA_INVALID", issues: repairParse.error },
    };
  }

  return {
    success: true,
    value: {
      narrative: repairParse.value,
      modelName: options.model,
      modelVersion: repairAttempt.value.modelVersion,
      promptVersion: LOCALIZATION_NARRATIVE_PROMPT_VERSION,
    },
  };
}
