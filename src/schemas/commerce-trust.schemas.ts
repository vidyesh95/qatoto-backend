import { z } from "zod";

export const CreateReviewSchema = z
  .object({
    rating: z.number().int().min(1).max(5),
    body: z.string().trim().min(1).max(4000),
  })
  .strict();

export type CreateReviewInput = z.infer<typeof CreateReviewSchema>;

export const CreateDisputeSchema = z
  .object({
    reasonCode: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[a-z][a-z0-9_]{0,79}$/),
    summary: z.string().trim().min(1).max(4000),
  })
  .strict();

export type CreateDisputeInput = z.infer<typeof CreateDisputeSchema>;

export const DecideDisputeSchema = z
  .object({
    decision: z.enum(["closed", "dismissed"]),
    note: z.string().trim().min(1).max(4000).optional(),
  })
  .strict();

export type DecideDisputeInput = z.infer<typeof DecideDisputeSchema>;

export const CompletionIdParamsSchema = z
  .object({
    completionId: z.string().trim().min(1).max(200),
  })
  .strict();

export const OrderIdParamsSchema = z
  .object({
    orderId: z.string().trim().min(1).max(200),
  })
  .strict();

export const DisputeIdParamsSchema = z
  .object({
    disputeId: z.string().trim().min(1).max(200),
  })
  .strict();

export const ListDisputesQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).optional(),
    cursor: z.string().trim().min(1).max(500).optional(),
    state: z.enum(["open", "closed", "dismissed"]).optional(),
  })
  .strict();
