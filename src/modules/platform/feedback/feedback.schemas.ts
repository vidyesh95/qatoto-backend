import { z } from "zod";

/**
 * Wire schemas for site feedback.
 *
 * EVERY OBJECT IS `.strict()`, and both enums are byte-identical to their pgEnum labels —
 * `snake_case` on the wire on purpose, because they are Postgres enum labels rather than
 * identifiers. A "corrected" kebab-case value is a 422, not an ignored one.
 *
 * THERE IS NO `userAgent` FIELD, AND THERE MUST NOT BE ONE. It is read from the request
 * header in the controller. A body-carried user agent is a string the client chooses, which
 * makes the column a place to put anything rather than a record of what browser was used.
 */

export const PlatformFeedbackCategorySchema = z.enum(["bug", "idea", "other"]);

export const PlatformFeedbackStatusSchema = z.enum(["new", "reviewed", "closed"]);

/** Matches `platform_feedback_message_ck` and `platform_feedback_page_path_ck`. */
export const CreatePlatformFeedbackSchema = z
  .object({
    category: PlatformFeedbackCategorySchema,
    message: z.string().trim().min(1).max(2000),
    /**
     * The route the person was on, sent by the client because only the client knows it.
     *
     * It is CONTEXT, never authority: nothing reads it to decide anything, so a client that
     * lies about it only misfiles its own feedback. The leading-slash rule keeps it a path
     * rather than a way to store an absolute URL pointing anywhere.
     */
    pagePath: z.string().trim().min(1).max(300).startsWith("/"),
  })
  .strict();

export const ListPlatformFeedbackQuerySchema = z
  .object({
    status: PlatformFeedbackStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
    cursor: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

/**
 * The submitter's own list.
 *
 * THE SAME THREE FIELDS AS THE STAFF QUERY, and deliberately not that schema reused: the two
 * lists answer different questions and only one of them is allowed to grow a filter naming
 * somebody else. There is no `userId` here and there must never be one — the session decides
 * who "mine" is, exactly as `listOwnSupportCases` records.
 */
export const ListOwnPlatformFeedbackQuerySchema = z
  .object({
    status: PlatformFeedbackStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
    cursor: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const PlatformFeedbackIdParamsSchema = z
  .object({ feedbackId: z.string().trim().min(1).max(200) })
  .strict();

/**
 * The triage decision.
 *
 * ⚠️ **`new` IS ABSENT FROM THE ENUM ON PURPOSE.** It is the state every row is born in, so
 * nothing needs to set it, and allowing it would let triage run backwards under a submitter
 * who has already been shown "Read by the team". A row can move forward and stop; it cannot
 * un-happen.
 *
 * ⚠️ **AND THERE IS NO `note`.** `platform_feedback` has no note column and no thread to
 * append one to, unlike a support case where the note IS the sentence the person reads. A
 * free-text field here would be written into nothing.
 */
export const DecidePlatformFeedbackSchema = z
  .object({ decision: z.enum(["reviewed", "closed"]) })
  .strict();

/** A stray query key on the write is a 422 rather than an ignored parameter. */
export const EmptyPlatformFeedbackQuerySchema = z.object({}).strict();

export type CreatePlatformFeedbackInput = z.infer<typeof CreatePlatformFeedbackSchema>;
export type PlatformFeedbackStatus = z.infer<typeof PlatformFeedbackStatusSchema>;
export type DecidePlatformFeedbackInput = z.infer<typeof DecidePlatformFeedbackSchema>;
