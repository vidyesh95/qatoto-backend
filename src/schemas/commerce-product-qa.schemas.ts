import { z } from "zod";

/**
 * Boundary contracts for product Q&A (STORE Appendix A9).
 *
 * NOTE WHAT AN ANSWER BODY DOES NOT CARRY: `authorKind`. The seller / verified-buyer
 * badge is DERIVED by the service from the caller's standing — a badge asserted by the
 * frontend is the most direct §0 violation available, and `.strict()` turns an attempt
 * to send one into a loud 422 rather than a silently ignored field.
 */
export const AskProductQuestionSchema = z
  .object({
    bodyText: z.string().trim().min(1).max(1000),
  })
  .strict();

export type AskProductQuestionInput = z.infer<typeof AskProductQuestionSchema>;

export const AnswerProductQuestionSchema = z
  .object({
    bodyText: z.string().trim().min(1).max(4000),
  })
  .strict();

export type AnswerProductQuestionInput = z.infer<typeof AnswerProductQuestionSchema>;

export const ProductIdParamsSchema = z
  .object({
    productId: z.string().trim().min(1).max(200),
  })
  .strict();

export const ProductQuestionIdParamsSchema = z
  .object({
    questionId: z.string().trim().min(1).max(200),
  })
  .strict();

export const ProductAnswerIdParamsSchema = z
  .object({
    answerId: z.string().trim().min(1).max(200),
  })
  .strict();

export const ProductQuestionListParamsSchema = z
  .object({
    productSlug: z.string().trim().min(1).max(200),
  })
  .strict();

export const ProductAnswerListParamsSchema = z
  .object({
    productSlug: z.string().trim().min(1).max(200),
    questionId: z.string().trim().min(1).max(200),
  })
  .strict();

export const ProductQuestionListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(24).default(12),
    cursor: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export type ProductQuestionListQuery = z.infer<typeof ProductQuestionListQuerySchema>;
