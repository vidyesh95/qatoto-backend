/**
 * The home feed's public read surface (HOME_BACKEND_STRUCTURE.md §5.1, §5.2).
 *
 * Two routes today: the taxonomy, and the public watch payload. `GET /feed/videos` — the
 * ranked page that Recommended, Explore and Spotlight are all slices of — lands here in
 * phase 3.
 */

import type { Request, Response } from "express";
import { z } from "zod";

import {
  firstParam,
  respondEngagementError,
  respondValidationFailed,
} from "#src/controllers/engagement-error-response.js";
import * as contentCategoriesService from "#src/services/content-categories.service.js";
import * as videoWatchService from "#src/services/video-watch.service.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * `GET /feed/categories` — PUBLIC. Every active category, already ordered.
 *
 * NO QUERY SCHEMA AND NO `safeParse`, and that is not a gap in the boundary. There is no
 * filter to offer: the response is the whole active taxonomy, and `?includeInactive` is a
 * staff question that does not belong on the front page's data source. The house rule
 * ".strict() on every query schema" is satisfied vacuously — no schema at all is a
 * different thing from a permissive one, and the handler reads nothing off `req`.
 *
 * `ApiResponse`, not `PaginatedResponse`: a bounded couple-of-dozen-row taxonomy has no
 * pages. `listCategories`, `listRegions` and `listSkills` all make the same call.
 */
export async function listFeedCategories(_req: Request, res: Response): Promise<void> {
  const categories = await contentCategoriesService.listActiveContentCategories();

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Categories retrieved successfully",
    data: categories,
  };
  res.status(200).json(response);
}

/** `video.id` is `randomUUID()`, so this is a statement about the column, not a guess. */
export const WatchVideoIdParamSchema = z.object({ videoId: z.uuid() }).strict();

/**
 * `GET /feed/watch/:videoId` — the public watch payload (§5.2).
 *
 * WHY IT LIVES UNDER `/feed` AND NOT AT `GET /videos/:videoId`. The studio router owns
 * `/videos/:videoId` behind `requireAuth` and is mounted first, so a public route at
 * that path would be permanently shadowed: every logged-out viewer would get a 401 from
 * the studio route and this handler would never run. Nothing would fail to compile and
 * the symptom would look like an auth bug.
 *
 * NO QUERY SCHEMA — there is nothing to filter on a single row.
 *
 * `ApiResponse`, not `PaginatedResponse`: one video has no pages.
 *
 * This route does NOT record a view. Rule 4: `viewCount` moves only on the beacon's
 * counted-view transition, and a client expecting otherwise is not accommodated.
 */
export async function getWatchPayload(req: Request, res: Response): Promise<void> {
  const parsedParams = WatchVideoIdParamSchema.safeParse({
    videoId: firstParam(req.params.videoId ?? ""),
  });
  if (!parsedParams.success) {
    respondValidationFailed(res, parsedParams.error);
    return;
  }

  const watchResult = await videoWatchService.getWatchPayload(
    parsedParams.data.videoId,
    req.user?.id ?? null,
  );

  if (!watchResult.success) {
    respondEngagementError(res, watchResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Video retrieved successfully",
    data: watchResult.value,
  };
  res.status(200).json(response);
}
