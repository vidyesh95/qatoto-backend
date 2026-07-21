import type { Request, Response } from "express";
import { z } from "zod";

import {
  firstParam,
  respondStudioError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/controllers/studio-error-response.js";
import * as contentReviewService from "#src/services/content-review.service.js";
import type { ApiResponse, PaginatedResponse } from "#src/types/index.js";

/**
 * Staff moderation of anime episodes (docs/STUDIO_BACKEND_STRUCTURE.md §6, §10).
 *
 * THERE IS NO ROLE MIDDLEWARE IN THE ROUTE CHAIN, and that is deliberate. The capability
 * check lives in the service so it can return a `Result` and take part in the exhaustive
 * error switch below; middleware would have to write a response or throw, putting an
 * authorization decision outside the one place that maps domain errors to statuses.
 *
 * The service also proves the capability BEFORE reading the id from the path, which is
 * what stops these routes from becoming an oracle for which video ids exist.
 *
 * Mirrors discovery-moderation.controller.ts, including this reasoning.
 */

const ReviewQueueQuerySchema = z
  .object({
    status: z.enum(["not_required", "pending", "approved", "rejected"]).default("pending"),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

/**
 * `reason` is REQUIRED and non-empty. A rejection with no reason is unactionable for the
 * creator and unauditable for the next moderator; the `content_review_action_reason_ck`
 * CHECK enforces the same rule one layer down.
 */
const RejectReviewSchema = z.object({ reason: z.string().trim().min(1).max(2_000) }).strict();

/** GET /videos/admin/review?status&page&limit */
export async function listReviewQueue(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedQuery = ReviewQueueQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const queueResult = await contentReviewService.listReviewQueue(req.user.id, parsedQuery.data);
  if (!queueResult.success) {
    respondStudioError(res, queueResult.error);
    return;
  }

  const response: PaginatedResponse = {
    status: "success",
    statusCode: 200,
    message: "Review queue retrieved successfully",
    data: [...queueResult.value.rows],
    pagination: {
      page: parsedQuery.data.page,
      limit: parsedQuery.data.limit,
      total: queueResult.value.total,
      totalPages: Math.ceil(queueResult.value.total / parsedQuery.data.limit),
    },
  };
  res.status(200).json(response);
}

/** POST /videos/admin/review/:videoId/approve */
export async function approveReview(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const approveResult = await contentReviewService.approveAnimeEpisode(
    req.user.id,
    firstParam(req.params.videoId ?? ""),
  );
  if (!approveResult.success) {
    respondStudioError(res, approveResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    // An embargoed episode is approved but NOT on air yet — say which happened, or a
    // moderator will go looking for it in /anime.
    message:
      approveResult.value.publishStatus === "scheduled"
        ? "Episode approved and scheduled for its premiere date"
        : "Episode approved and published",
    data: approveResult.value,
  };
  res.status(200).json(response);
}

/** POST /videos/admin/review/:videoId/reject */
export async function rejectReview(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = RejectReviewSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const rejectResult = await contentReviewService.rejectAnimeEpisode(
    req.user.id,
    firstParam(req.params.videoId ?? ""),
    parsedBody.data.reason,
  );
  if (!rejectResult.success) {
    respondStudioError(res, rejectResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Episode rejected",
    data: rejectResult.value,
  };
  res.status(200).json(response);
}
