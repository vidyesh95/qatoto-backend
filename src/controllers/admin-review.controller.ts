import type { Request, Response } from "express";

import {
  firstParam,
  respondStudioError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/controllers/studio-error-response.js";
import { RejectReviewSchema, ReviewQueueQuerySchema } from "#src/schemas/admin-review.schemas.js";
import * as contentReviewService from "#src/services/content-review.service.js";
import type { ApiResponse, PaginatedResponse } from "#src/types/index.js";

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
