import { z } from "zod";

/**
 * Boundary contracts for content reports and commerce moderation (Appendix A12).
 *
 * THE WIRE CARRIES ONE `targetId`; storage is five nullable foreign keys with an XOR
 * check. A single id is the honest transport shape — the client has exactly one thing
 * in hand — while five typed columns are the honest storage shape, because a bare text
 * id has no referential integrity and the queue could not join to show a reviewer what
 * was reported.
 */
export const CommerceContentTargetKindSchema = z.enum([
  "product",
  "review",
  "question",
  "answer",
  "organization",
]);

export const CreateContentReportSchema = z
  .object({
    targetKind: CommerceContentTargetKindSchema,
    targetId: z.string().trim().min(1).max(200),
    reason: z.enum([
      "spam",
      "counterfeit",
      "prohibited_item",
      "misleading_claim",
      "intellectual_property",
      "harassment",
      "off_topic",
      "other",
    ]),
    detailText: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

export type CreateContentReportInput = z.infer<typeof CreateContentReportSchema>;

export const DecideContentReportSchema = z
  .object({
    /** `actioned` hides the content; `dismissed` restores it if it was auto-hidden. */
    decision: z.enum(["actioned", "dismissed"]),
    note: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

export type DecideContentReportInput = z.infer<typeof DecideContentReportSchema>;

export const RestoreContentSchema = z
  .object({
    targetKind: CommerceContentTargetKindSchema,
    targetId: z.string().trim().min(1).max(200),
    /** Required, unlike a decision note: an un-hide with no stated reason is not a record. */
    reasonNote: z.string().trim().min(1).max(2000),
  })
  .strict();

export type RestoreContentInput = z.infer<typeof RestoreContentSchema>;

export const ReportIdParamsSchema = z
  .object({
    reportId: z.string().trim().min(1).max(200),
  })
  .strict();

export const ListContentReportsQuerySchema = z
  .object({
    status: z.enum(["open", "actioned", "dismissed"]).optional(),
    targetKind: CommerceContentTargetKindSchema.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export type ListContentReportsQuery = z.infer<typeof ListContentReportsQuerySchema>;

export const EmptyObjectSchema = z.object({}).strict();
