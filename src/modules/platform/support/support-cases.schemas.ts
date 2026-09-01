import { z } from "zod";

/**
 * Wire schemas for support cases.
 *
 * EVERY OBJECT IS `.strict()`, and every enum is byte-identical to its pgEnum — `snake_case`
 * on the wire on purpose, because these are Postgres enum labels rather than identifiers. A
 * "corrected" kebab-case value is a 422, not an ignored one.
 *
 * Every length here mirrors a CHECK constraint on the table. The schema is the polite
 * refusal that names the field; the constraint is the one that cannot be bypassed.
 */

export const SupportCaseCategorySchema = z.enum([
  "payment_problem",
  "order_problem",
  "account_problem",
  "content_problem",
  "technical_problem",
  "other",
]);

export const SupportCaseStateSchema = z.enum(["open", "awaiting_user", "resolved", "closed"]);

export const SupportCaseIdParamsSchema = z
  .object({ caseId: z.string().trim().min(1).max(200) })
  .strict();

/**
 * Opening a case.
 *
 * `orderReference` IS FREE TEXT AND OPTIONAL. It is a string the person pasted so a human can
 * find the thing they mean; nothing joins on it and nothing validates that it exists. See the
 * header of `src/db/schema/support.ts` for why it is deliberately not an order id.
 */
export const OpenSupportCaseSchema = z
  .object({
    category: SupportCaseCategorySchema,
    subject: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(4000),
    orderReference: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export const AddSupportCaseMessageSchema = z
  .object({ body: z.string().trim().min(1).max(4000) })
  .strict();

/**
 * `note` is REQUIRED where a user-report decision's note is optional.
 *
 * A verdict on a report is a decision ABOUT somebody, and the person reported is not owed an
 * explanation of it. A support case is a conversation WITH somebody who asked a question, so
 * ending it without a sentence is ending it without answering — and this note is the sentence
 * they read in the thread, not an internal annotation.
 */
export const DecideSupportCaseSchema = z
  .object({
    decision: z.enum(["resolved", "closed"]),
    note: z.string().trim().min(1).max(2000),
  })
  .strict();

export const ListOwnSupportCasesQuerySchema = z
  .object({
    state: SupportCaseStateSchema.optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
    cursor: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const ListSupportCaseQueueQuerySchema = z
  .object({
    state: SupportCaseStateSchema.optional(),
    category: SupportCaseCategorySchema.optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
    cursor: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

/** A stray query key is a 422 rather than an ignored parameter — every write here is strict. */
export const EmptySupportCaseQuerySchema = z.object({}).strict();
