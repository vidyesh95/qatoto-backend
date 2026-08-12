import { z } from "zod";

/**
 * Boundary contracts for the business forum (STORE_BACKEND_STRUCTURE.md §17).
 *
 * `pending_review` IS NOT AN ACCEPTABLE `threadState` FILTER, and the refusal is the point:
 * a `.strict()` enum answers 422 for it rather than returning an empty page, so a client
 * asking for the queue on a public route learns it asked the wrong question instead of
 * concluding the queue is empty.
 */

export const FORUM_BOARDS = [
  "sourcing",
  "logistics_and_customs",
  "compliance_and_certification",
  "payments_and_trade_finance",
  "manufacturing",
  "selling_on_qatoto",
] as const;

/** The three a public read may return. `pending_review` is deliberately absent. */
export const PUBLIC_FORUM_THREAD_STATES = ["open", "answered", "locked"] as const;

export const ForumBoardSchema = z.enum(FORUM_BOARDS);

export const ListForumThreadsQuerySchema = z
  .object({
    board: ForumBoardSchema.optional(),
    threadState: z.enum(PUBLIC_FORUM_THREAD_STATES).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const ForumThreadSlugParamsSchema = z
  .object({
    threadSlug: z
      .string()
      .trim()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Slug must be kebab-case."),
  })
  .strict();

/** The detail read pages its REPLIES, so the cursor keys are named for them. */
export const GetForumThreadQuerySchema = z
  .object({
    replyLimit: z.coerce.number().int().min(1).max(50).default(20),
    replyCursor: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

/**
 * A new thread. THREE FIELDS AND ALL THREE ARE REQUIRED — a thread with no body is not a
 * thread, and a board is how anyone finds it.
 *
 * The minimums are not decoration: an 8-character title and a 20-character body are the
 * floor below which a moderator has nothing to judge, and this queue exists to be judged.
 */
export const CreateForumThreadSchema = z
  .object({
    board: ForumBoardSchema,
    title: z.string().trim().min(8).max(200),
    body: z.string().trim().min(20).max(20_000),
  })
  .strict();

export const ForumThreadIdParamsSchema = z
  .object({
    threadId: z.string().trim().min(1).max(200),
  })
  .strict();

export const ForumReplyIdParamsSchema = z
  .object({
    replyId: z.string().trim().min(1).max(200),
  })
  .strict();

export const CreateForumReplySchema = z
  .object({
    body: z.string().trim().min(2).max(10_000),
  })
  .strict();

export const SetAcceptedReplySchema = z
  .object({
    replyId: z.string().trim().min(1).max(200),
  })
  .strict();

export const ListMyForumThreadsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Reporting and moderation (§17.4)
// ---------------------------------------------------------------------------

export const CommunityContentTargetKindSchema = z.enum(["forum_thread", "forum_reply"]);

export const CreateCommunityReportSchema = z
  .object({
    targetKind: CommunityContentTargetKindSchema,
    targetId: z.string().trim().min(1).max(200),
    reason: z.enum([
      "spam",
      "misinformation",
      "harassment",
      "off_topic",
      "intellectual_property",
      "other",
    ]),
    detailText: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

export const ListForumModerationQueueQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

/**
 * Every decision carries a reason, including a publish.
 *
 * That is stricter than the DB CHECK, which only requires one for a rejection — and it is
 * deliberate at this boundary: the queue's own decision log is the thing a second moderator
 * reads before reversing a colleague, and "approved" with no note tells them nothing.
 */
export const ModerateForumThreadSchema = z
  .object({
    decision: z.enum(["publish", "reject", "lock", "unlock"]),
    reasonNote: z.string().trim().min(1).max(2000),
  })
  .strict();

export const ModerateForumReplySchema = z
  .object({
    decision: z.enum(["hidden", "restored"]),
    reasonNote: z.string().trim().min(1).max(2000),
  })
  .strict();

export const ListCommunityReportsQuerySchema = z
  .object({
    status: z.enum(["open", "actioned", "dismissed"]).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const DismissCommunityReportSchema = z
  .object({
    reasonNote: z.string().trim().min(1).max(2000),
  })
  .strict();

export const CommunityReportIdParamsSchema = z
  .object({
    reportId: z.string().trim().min(1).max(200),
  })
  .strict();

export type CreateForumThreadInput = z.infer<typeof CreateForumThreadSchema>;
export type ListForumThreadsQuery = z.infer<typeof ListForumThreadsQuerySchema>;
