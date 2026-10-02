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

/** `GET /assistant/admin/cloud-access` — keyset-paged active grants. */
export const ListCloudAccessGrantsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).optional(),
    cursor: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

/**
 * `POST /assistant/admin/cloud-access` — grant Premium AI by exact email.
 *
 * Email, not a user id, because that is what an admin has in hand. Matches the lookup the staff
 * roles console already does (`platform-roles.schemas.ts`). The note is optional context for the
 * next admin ("beta tester", "support escalation"), never shown to the account holder.
 */
export const GrantCloudAccessSchema = z
  .object({
    email: z.string().trim().email().max(320),
    note: z.string().trim().min(1).max(200).nullable().default(null),
  })
  .strict();

export const CloudAccessUserIdParamsSchema = z
  .object({ userId: z.string().trim().min(1).max(200) })
  .strict();
