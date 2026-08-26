import type { Request, Response } from "express";

import {
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/studio/studio-error-response.js";
import * as creatorAnalyticsService from "#src/modules/studio/videos/creator-analytics.service.js";
import { ListVideoAnalyticsQuerySchema } from "#src/modules/studio/videos/videos.schemas.js";
import type { ApiResponse, PaginatedResponse } from "#src/types/index.js";

/**
 * The two creator-analytics reads.
 *
 * BOTH SCOPE ON `req.user.id` AND NEITHER ACCEPTS AN OWNER. Same rule as the rest of the studio
 * (`videos.routes.ts` header): a creator id in a query string is a creator id an attacker can
 * change, so it is taken from the session and from nowhere else.
 *
 * NEITHER CAN FAIL. Both are pure reads over the caller's own rows with no lookup that can miss —
 * a creator with no videos gets zeros and an empty page, which is an answer rather than an error.
 * So they return bare values and never touch the studio error union.
 */

/** GET /users/me/creator-summary */
export async function getCreatorSummary(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const summary = await creatorAnalyticsService.getCreatorSummary(req.user.id);

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Creator summary retrieved successfully",
    data: summary,
  };
  res.status(200).json(response);
}

/** GET /users/me/video-analytics */
export async function listVideoAnalytics(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedQuery = ListVideoAnalyticsQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const { page, limit } = parsedQuery.data;
  const analyticsPage = await creatorAnalyticsService.listVideoAnalytics(req.user.id, {
    page,
    limit,
  });

  const response: PaginatedResponse = {
    status: "success",
    statusCode: 200,
    message: "Video analytics retrieved successfully",
    data: [...analyticsPage.rows],
    pagination: {
      page,
      limit,
      total: analyticsPage.total,
      totalPages: Math.ceil(analyticsPage.total / limit),
    },
  };
  res.status(200).json(response);
}
