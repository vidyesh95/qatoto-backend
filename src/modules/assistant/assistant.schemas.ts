import { z } from "zod";

/**
 * Wire schemas for the AI assistant's cloud route, `POST /assistant/replies`.
 *
 * ## THE CLIENT SENDS WORDS, NEVER INSTRUCTIONS
 *
 * The body is the conversation so far, the page the person is on and the notes they saved in
 * their own browser. There is no `system`, `prompt` or `model` field and there must never be
 * one: the server writes every instruction around these strings (`assistant.prompt.ts`), which
 * is what stops this route being a free general-purpose model on Qatoto's key.
 *
 * ## THE CAPS ARE THE FRONTEND'S, MIRRORED
 *
 * Ten turns of at most 800 characters, a path of at most 200, twenty notes of at most 200 —
 * the same numbers `assistant-reply.schemas.ts` and `browser-preferences.ts` hold in
 * qatoto-frontend. A client that sends more is refused with a 422 rather than trimmed, because a
 * silently shortened conversation answers a question nobody asked.
 */

export const ASSISTANT_HISTORY_TURN_LIMIT = 10;
export const ASSISTANT_TURN_TEXT_MAXIMUM_LENGTH = 800;
export const ASSISTANT_MEMORY_NOTE_LIMIT = 20;
export const ASSISTANT_MEMORY_NOTE_MAXIMUM_LENGTH = 200;

const AssistantConversationTurnSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    text: z.string().trim().min(1).max(ASSISTANT_TURN_TEXT_MAXIMUM_LENGTH),
  })
  .strict();

export const CreateAssistantReplySchema = z
  .object({
    messages: z
      .array(AssistantConversationTurnSchema)
      .min(1)
      .max(ASSISTANT_HISTORY_TURN_LIMIT)
      .refine((messages) => messages.at(-1)?.role === "user", {
        message: "The last message must be the person's question.",
      }),
    /**
     * CONTEXT, never authority — the same posture `pagePath` takes on site feedback. Nothing
     * reads it to decide anything; it only lets the model say "on this page". The leading-slash
     * rule keeps it a path rather than an absolute URL pointing anywhere.
     */
    pathname: z.string().trim().min(1).max(200).startsWith("/"),
    memoryNotes: z
      .array(z.string().trim().min(1).max(ASSISTANT_MEMORY_NOTE_MAXIMUM_LENGTH))
      .max(ASSISTANT_MEMORY_NOTE_LIMIT),
  })
  .strict();

export type CreateAssistantReplyInput = z.infer<typeof CreateAssistantReplySchema>;

/** A stray query key is a 422 rather than an ignored parameter. */
export const EmptyAssistantQuerySchema = z.object({}).strict();
