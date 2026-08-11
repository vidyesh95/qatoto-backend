import { z } from "zod";

/**
 * Named sub-scores (Appendix A8) ride the review body rather than getting their own
 * route: they are part of the same testimony as the rating, and a review is immutable
 * once posted. Every axis is optional — a buyer may rate quality and skip shipping —
 * but an EMPTY object is refused, because "I sent scores" and "I sent no scores" must
 * not be the same request.
 *
 * `shipping` on a service-engagement completion is a cross-table fact this schema
 * cannot see; `createReview` refuses it as UNSUPPORTED_SCORE_AXIS under the lock it
 * already holds on the completion row.
 */
export const ReviewScoresSchema = z
  .object({
    service: z.number().int().min(1).max(5),
    shipping: z.number().int().min(1).max(5),
    quality: z.number().int().min(1).max(5),
  })
  .partial()
  .strict()
  .refine((scores) => Object.keys(scores).length > 0, {
    message: "Provide at least one score axis, or omit scores entirely.",
  });

export const CreateReviewSchema = z
  .object({
    rating: z.number().int().min(1).max(5),
    body: z.string().trim().min(1).max(4000),
    scores: ReviewScoresSchema.optional(),
  })
  .strict();

export type CreateReviewInput = z.infer<typeof CreateReviewSchema>;

/**
 * A38. The one edit an author gets, within 30 days.
 *
 * `rating` AND `body` ARE BOTH REQUIRED, not a partial patch. There is exactly one edit, so a
 * caller sending only `body` would spend it and silently keep a rating they may have meant to
 * change — a partial shape here would be a trap rather than a convenience.
 *
 * NO `scores`. The per-axis scores are their own rows, they were optional at creation, and
 * accepting them here would make an omitted `scores` ambiguous between "leave them" and "clear
 * them" on the one write that cannot be repeated.
 */
export const EditOwnReviewSchema = z
  .object({
    rating: z.number().int().min(1).max(5),
    body: z.string().trim().min(1).max(4000),
  })
  .strict();

export type EditOwnReviewInput = z.infer<typeof EditOwnReviewSchema>;

export const ReviewIdParamsSchema = z
  .object({
    reviewId: z.string().trim().min(1).max(200),
  })
  .strict();

export const ReviewMediaParamsSchema = z
  .object({
    reviewId: z.string().trim().min(1).max(200),
    mediaId: z.string().trim().min(1).max(200),
  })
  .strict();

/**
 * Multipart text fields accompanying a review photo upload — there are none.
 *
 * NOTE THE ABSENCE OF `position`. Media is always APPENDED at the current count, and
 * the gallery is re-packed to 0..n-1 on removal. A client-chosen position would
 * collide with `commerce_review_media_position_uidx` on any concurrent attach, and an
 * accepted-then-ignored field is worse than a rejected one: `.strict()` exists so a
 * caller learns its request was misunderstood instead of assuming it worked.
 */
export const AttachReviewPhotoFieldsSchema = z.object({}).strict();

export type AttachReviewPhotoFieldsInput = z.infer<typeof AttachReviewPhotoFieldsSchema>;

/**
 * A review video is a YouTube LINK, not an upload. This codebase has no first-party
 * video ingest — `video.youtubeVideoId` plus the `verify-youtube-video` oEmbed job is
 * the shipped design — and the id is extracted server-side by
 * `extractYoutubeVideoId`, never accepted as a bare id from the client.
 */
export const AttachReviewVideoSchema = z
  .object({
    youtubeUrl: z.string().trim().min(1).max(2048),
  })
  .strict();

export type AttachReviewVideoInput = z.infer<typeof AttachReviewVideoSchema>;

export const UpsertReviewReplySchema = z
  .object({
    body: z.string().trim().min(1).max(2000),
  })
  .strict();

export type UpsertReviewReplyInput = z.infer<typeof UpsertReviewReplySchema>;

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

/**
 * `GET /commerce/completions` — the read that makes reviewing reachable.
 *
 * `reviewable` is a filter, not a mode: absent returns the buyer's whole completion
 * history, `true` narrows to what they can still review. Bounds match
 * `ListDisputesQuerySchema` so every commerce list page behaves the same.
 */
export const ListBuyerCompletionsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).optional(),
    cursor: z.string().trim().min(1).max(500).optional(),
    reviewable: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
  })
  .strict();
