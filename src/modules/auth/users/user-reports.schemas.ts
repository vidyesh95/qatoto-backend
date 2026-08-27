import { z } from "zod";

/**
 * Wire schemas for profile reporting.
 *
 * EVERY OBJECT IS `.strict()`, and every enum is byte-identical to its pgEnum — these are
 * `snake_case` on the wire on purpose, because they are Postgres enum labels rather than
 * identifiers. A "corrected" kebab-case value is a 422, not an ignored one.
 */

export const UserReportReasonSchema = z.enum([
  "impersonation",
  "abusive_profile_text",
  "misleading_links",
  "spam",
  "severe_harm_escalation",
  "other",
]);

export const UserIdParamsSchema = z.object({ userId: z.string().trim().min(1).max(200) }).strict();

export const ReportIdParamsSchema = z
  .object({ reportId: z.string().trim().min(1).max(200) })
  .strict();

/** Matches `user_report_detail_ck`: 1..2000, or absent. */
export const CreateUserReportSchema = z
  .object({
    reason: UserReportReasonSchema,
    detailText: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

export const ListUserReportsQuerySchema = z
  .object({
    status: z.enum(["open", "actioned", "dismissed"]).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
    cursor: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const DecideUserReportSchema = z
  .object({
    decision: z.enum(["actioned", "dismissed"]),
    note: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

/**
 * `reasonNote` is REQUIRED here where `note` is optional on a decision.
 *
 * Restoring text a colleague hid is the one action in this file that overturns another moderator's
 * decision, so it does not get to be silent.
 */
export const RestoreUserProfileTextSchema = z
  .object({
    reportedUserId: z.string().trim().min(1).max(200),
    reasonNote: z.string().trim().min(1).max(2000),
  })
  .strict();

export const EmptyUserReportQuerySchema = z.object({}).strict();
