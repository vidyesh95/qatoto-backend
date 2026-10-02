import { config } from "#src/config/index.js";
import { hasActiveCloudAccess } from "#src/modules/assistant/assistant-cloud-access.service.js";
import {
  AssistantReplySchema,
  ASSISTANT_REPLY_RESPONSE_SCHEMA,
  buildAssistantPrompt,
  type AssistantReply,
} from "#src/modules/assistant/assistant.prompt.js";
import type { CreateAssistantReplyInput } from "#src/modules/assistant/assistant.schemas.js";
import { generateOnce, type FetchImplementation } from "#src/modules/rnd/gemini-transport.js";
import type { Result } from "#src/types/index.js";

/**
 * One assistant reply, from Gemini, for a signed-in PREMIUM account (an active
 * `assistant_cloud_entitlement` grant) whose browser cannot run the on-device model.
 *
 * ## STATELESS, AND THAT IS A PROMISE THE PRIVACY POLICY MAKES
 *
 * No table, no log of the conversation, no copy kept for "quality": the request is read, sent to
 * Gemini, and the answer returned. The frontend's privacy policy says Qatoto does not store these
 * messages, so adding persistence here is a privacy-policy change first and a code change second.
 *
 * ## ONE CALL, NO REPAIR
 *
 * `localization-narrative.ts` spends a second call repairing unparseable JSON because that output
 * is a stored artefact. This one is a chat turn with a person waiting: a reply that does not parse
 * is reported as such and they ask again. The response schema makes that rare.
 *
 * ## A TIMEOUT SIZED FOR A PERSON, NOT A WORKER
 *
 * `GEMINI_TIMEOUT_MS` is three minutes because the daily-log job watches whole videos. Here the
 * caller is a browser with its own 20-second timeout, so `ASSISTANT_GEMINI_TIMEOUT_MS` defaults to
 * 15 seconds — the server answers 503 before the client gives up and calls it a network failure.
 */

export type AssistantReplyError =
  /** The account holds no active Premium AI grant (`assistant_cloud_entitlement`). */
  | { type: "ASSISTANT_PREMIUM_REQUIRED" }
  /** No key, provider down, timeout, or truncated output. The person can try again later. */
  | { type: "ASSISTANT_UNAVAILABLE" }
  /** The provider refused this input (a safety stop). Asking differently may work. */
  | { type: "ASSISTANT_INPUT_REJECTED" }
  /** The model answered with something that is not a reply. */
  | { type: "ASSISTANT_REPLY_UNREADABLE" };

/** Gemini 3.x `thinkingLevel`. A chat turn about where things are has little to reason about. */
const THINKING_LEVEL = "low";

export async function createAssistantReply(
  callerUserId: string,
  input: CreateAssistantReplyInput,
  fetchImplementation?: FetchImplementation,
): Promise<Result<AssistantReply, AssistantReplyError>> {
  // PREMIUM FIRST, before a single token is spent. Everyone else answers on their own device
  // (Chrome's built-in model) or has no chat at all; this route spends Qatoto's Gemini key.
  if (!(await hasActiveCloudAccess(callerUserId))) {
    return { success: false, error: { type: "ASSISTANT_PREMIUM_REQUIRED" } };
  }

  const generated = await generateOnce(
    {
      parts: [{ text: buildAssistantPrompt(input) }],
      responseSchema: ASSISTANT_REPLY_RESPONSE_SCHEMA,
      thinkingLevel: THINKING_LEVEL,
    },
    {
      apiKey: config.GEMINI_API_KEY,
      model: config.ASSISTANT_GEMINI_MODEL ?? config.GEMINI_MODEL,
      timeoutMs: config.ASSISTANT_GEMINI_TIMEOUT_MS,
      maxOutputTokens: config.ASSISTANT_MAX_OUTPUT_TOKENS,
      ...(fetchImplementation === undefined ? {} : { fetchImplementation }),
    },
    null,
  );

  if (!generated.success) {
    switch (generated.error.type) {
      case "GEMINI_NOT_CONFIGURED":
      case "GEMINI_UNAVAILABLE":
      case "GEMINI_OUTPUT_TRUNCATED":
        return { success: false, error: { type: "ASSISTANT_UNAVAILABLE" } };
      case "GEMINI_INPUT_REJECTED":
        return { success: false, error: { type: "ASSISTANT_INPUT_REJECTED" } };
      default: {
        const exhaustiveCheck: never = generated.error;
        throw new Error(`Unhandled Gemini transport error: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(generated.value.rawText);
  } catch {
    return { success: false, error: { type: "ASSISTANT_REPLY_UNREADABLE" } };
  }
  const parsedReply = AssistantReplySchema.safeParse(parsedJson);
  if (!parsedReply.success) {
    return { success: false, error: { type: "ASSISTANT_REPLY_UNREADABLE" } };
  }
  return { success: true, value: parsedReply.data };
}
