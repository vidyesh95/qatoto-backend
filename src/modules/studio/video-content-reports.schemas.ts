/**
 * Request schemas for video content reporting.
 *
 * Split out of the controller for the reason every `*.schemas.ts` here is: they have a
 * second consumer a controller cannot serve — `src/docs/openapi-rnd-bodies.ts` builds
 * request bodies from these, and importing a controller to reach one drags in its whole
 * service and db graph.
 *
 * EVERY OBJECT IS `.strict()`. A stray key is a 422 rather than a silently ignored field,
 * which on a moderation surface is the difference between "your note was saved" and "your
 * note went nowhere and nobody told you".
 */
import { z } from "zod";

/**
 * Byte-identical to `video_content_report_reason` in the database.
 *
 * SNAKE_CASE, and not to be "corrected". These are Postgres enum labels sent verbatim in
 * both directions; `z.enum([...]).safeParse("child-safety")` fails, and the wire-casing rule
 * in CLAUDE.md exists because someone will try.
 */
export const VideoReportReasonSchema = z.enum([
  "sexual_content",
  "violence",
  "hateful_or_abusive",
  "harassment",
  "child_safety",
  "spam_or_misleading",
  "copyright",
  "other",
]);

export const ReportVideoSchema = z
  .object({
    reason: VideoReportReasonSchema,
    /**
     * Optional, and capped to match `video_content_report_detail_ck`.
     *
     * A reporter with nothing to add should not be made to write something — an empty box
     * that must be filled produces "asdf", which is worse than a null for the moderator
     * reading it.
     */
    detailText: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

export const DecideVideoReportSchema = z
  .object({
    /**
     * `actioned` hides the video. `dismissed` and `redirected_to_source` both close the reports
     * and leave it alone — they differ in what the reporter is TOLD.
     *
     * `redirected_to_source` is the honest answer on a platform that hosts no bytes: the claim may
     * be perfectly good and Qatoto is not who can act on it. Hiding the row withdraws Qatoto's copy
     * while the video keeps playing on youtube.com, so a rights-holder's real remedy is a claim
     * with the host. Filing that as a dismissal tells them they were wrong.
     *
     * DISMISSING DOES NOT RESTORE — see the service. That is the deliberate difference from
     * commerce, where dismissal must un-hide because a threshold could have hidden the
     * content with nobody deciding.
     */
    decision: z.enum(["actioned", "dismissed", "redirected_to_source"]),
    /**
     * ⚠️ STAFF-ONLY. Goes to `video_moderation_action.reasonNote` and the hash-chained audit entry,
     * and reaches NO user. This is where "reported by three people, one is the seller in #4821"
     * legitimately belongs.
     */
    note: z.string().trim().min(1).max(2000).optional(),
    /**
     * ⚠️ PUBLISHED TO THE REPORTER. Goes to `video_content_report.resolutionNote`, which the
     * reporter's own list renders.
     *
     * **IT IS A SEPARATE FIELD BECAUSE `note` USED TO BE BOTH**, and that was a latent leak: one
     * value was written to the staff audit note AND to the reporter-visible column, so the first
     * read that surfaced `resolutionNote` would have published every internal note ever written.
     * Nothing read it yet, which is the only reason it never fired.
     *
     * Optional, and never auto-filled from `note`. A bare outcome is the honest default; a
     * template pretending to be a considered reply is worse than silence.
     */
    reporterNote: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

export const RestoreVideoSchema = z
  .object({
    videoId: z.string().min(1).max(64),
    /** REQUIRED, unlike a decision note: an un-hide with no stated reason is not a record. */
    reasonNote: z.string().trim().min(1).max(2000),
  })
  .strict();

export const ListVideoReportsQuerySchema = z
  .object({
    status: z.enum(["open", "actioned", "dismissed"]).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).max(500).optional(),
  })
  .strict();

export const VideoIdParamsSchema = z.object({ videoId: z.string().min(1).max(64) }).strict();
export const ReportIdParamsSchema = z.object({ reportId: z.string().min(1).max(64) }).strict();

/** A stray query param on a write is a 422, not a silent ignore. */
export const EmptyQuerySchema = z.object({}).strict();

export type ReportVideoInput = z.infer<typeof ReportVideoSchema>;
export type DecideVideoReportInput = z.infer<typeof DecideVideoReportSchema>;
export type RestoreVideoInput = z.infer<typeof RestoreVideoSchema>;
export type ListVideoReportsQuery = z.infer<typeof ListVideoReportsQuerySchema>;
