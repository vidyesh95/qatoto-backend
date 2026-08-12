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

/**
 * A38. The seller's cross-listing question queue.
 *
 * A HIGHER `limit` CAP THAN THE PUBLIC LIST'S 24: this is a work queue somebody is clearing,
 * not a product page carousel, and the same cap would make a seller with two hundred listings
 * page through their backlog twelve at a time.
 *
 * `unansweredOnly` is `z.coerce.boolean()`-free on purpose — that coerces "false" to `true`,
 * which is the wrong answer for every caller who spells the default out. The literal enum makes
 * a typo a 422 rather than a silently inverted filter.
 */
export const SellerQuestionInboxQuerySchema = z
  .object({
    unansweredOnly: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export type SellerQuestionInboxQuery = z.infer<typeof SellerQuestionInboxQuerySchema>;

export const EmptyObjectSchema = z.object({}).strict();
