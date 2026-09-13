import { z } from "zod";

/**
 * ⚠️ snake_case, SENT VERBATIM. These are the pgEnum labels, and `content-reports.schemas.ts`
 * states the rule: a kebab or camel spelling on the wire is a DIFFERENT, ABSENT label, and the
 * mismatch shows up as a 422 nobody can act on rather than as a compile error.
 */
export const BLUEPRINT_REPORT_REASONS = [
  "rights_claim",
  "fabricated_measurements",
  "dangerous_procedure",
  "not_the_stated_product",
  "spam",
  "other",
] as const;

export const BLUEPRINT_REPORT_DETAIL_MAXIMUM_CHARACTERS = 2000;

/**
 * The body of `POST /blueprints/{teardowns,case-studies}/:slug/reports`.
 *
 * ⚠️ NO TARGET ID AND NO REPORTER ID. The blueprint comes from the path and the reporter from the
 * session — §1.1 — and `.strict()` is what turns "we ignore a body-carried one" into "we refuse it".
 */
export const CreateBlueprintReportSchema = z
  .object({
    reason: z.enum(BLUEPRINT_REPORT_REASONS),
    detailText: z
      .string()
      .trim()
      .min(1)
      .max(
        BLUEPRINT_REPORT_DETAIL_MAXIMUM_CHARACTERS,
        `Keep the detail under ${String(BLUEPRINT_REPORT_DETAIL_MAXIMUM_CHARACTERS)} characters.`,
      )
      .nullable(),
  })
  .strict();
export type CreateBlueprintReportInput = z.infer<typeof CreateBlueprintReportSchema>;

/**
 * The moderator queue's paging controls.
 *
 * `.strip()` rather than `.strict()`, matching every other query schema on this surface: an
 * unknown key on a READ is a stray `utm_source`, not a client trying to set something.
 */
export const BlueprintReportQueueQuerySchema = z
  .object({
    status: z.enum(["open", "actioned", "dismissed"]).default("open"),
    targetKind: z.enum(["teardown", "case_study"]).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).optional(),
  })
  .strip();
export type BlueprintReportQueueQuery = z.infer<typeof BlueprintReportQueueQuerySchema>;

/**
 * ⚠️ THE RESOLUTION NOTE IS REQUIRED, for the reason every moderation note on this surface is: a
 * dismissal is an answer to a person who took the trouble to report something, and a decision with
 * no recorded reason cannot be reviewed by the next moderator who sees the same row.
 */
export const DismissBlueprintReportSchema = z
  .object({
    resolutionNote: z
      .string()
      .trim()
      .min(1, "Say why this report is being dismissed.")
      .max(2000, "Keep the note under 2,000 characters."),
  })
  .strict();
export type DismissBlueprintReportInput = z.infer<typeof DismissBlueprintReportSchema>;
