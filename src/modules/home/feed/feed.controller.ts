/**
 * The home feed's public read surface (HOME_BACKEND_STRUCTURE.md §5.1, §5.2).
 *
 * Two routes today: the taxonomy, and the public watch payload. `GET /feed/videos` — the
 * ranked page that Recommended, Explore and Spotlight are all slices of — lands here in
 * phase 3.
 */
import type { Request, Response } from "express";

import { logger } from "#src/lib/logger.js";
import { isWellFormedRankSeed, mintRankSeed } from "#src/lib/rank-seed.js";
import { computeViewerFingerprint, utcDayStringOf } from "#src/lib/viewer-fingerprint.js";
import {
  firstParam,
  respondEngagementError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/home/engagement/engagement-error-response.js";
import * as videoWatchService from "#src/modules/home/engagement/video-watch.service.js";
import {
  ListFeedVideosQuerySchema,
  SearchVideosQuerySchema,
  WatchVideoIdParamSchema,
} from "#src/modules/home/feed/feed.schemas.js";
import {
  listFeedVideos as listFeedVideosService,
  searchVideos as searchVideosService,
} from "#src/modules/home/feed/feed.service.js";
import * as contentCategoriesService from "#src/modules/studio/content-categories.service.js";
import type { ApiResponse, PaginatedResponse } from "#src/types/index.js";

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

/**
 * `GET /feed/videos` — the one ranked page the whole homepage reads (Rule 3).
 *
 * Recommended and Explore are a frontend SLICE of this response, not two fields.
 * Spotlight is this route with `?mode=trending&limit=3`.
 *
 * ## The rank seed round trip
 *
 * A client that sends no seed gets one minted for it and returned. A client that echoes it
 * back gets the same exploration ordering, which is what stops page 2 reshuffling against
 * page 1 and showing the same video twice. A seed carries NO authority — it selects an
 * exploration bucket and nothing else — so a client choosing its own is harmless, and it
 * is re-validated here only because it reaches an `md5()` inside an `ORDER BY`.
 *
 * ## The relaxation stage is logged, never returned
 *
 * §4.7's ladder is an operational fact about the catalog, not something a client should
 * branch on. It is deliberately absent from the response body.
 */
export async function listFeedVideos(req: Request, res: Response): Promise<void> {
  const parsedQuery = ListFeedVideosQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const clientIp = req.ip;
  if (clientIp === undefined) {
    logger.warn("feed: no client ip on request, anonymous ranking degraded", {
      requestId: req.requestId,
    });
  }

  const viewerUserId = req.user?.id ?? null;
  const utcDayString = utcDayStringOf(new Date());
  const viewerFingerprint = computeViewerFingerprint({
    utcDayString,
    viewerUserId,
    clientIp: clientIp ?? "",
    userAgent: (req.headers["user-agent"] ?? "").slice(0, 512),
  });

  // A client-supplied seed is honoured only if it is well formed; anything else is
  // replaced rather than rejected, because a malformed seed is not worth a 422 on a read.
  const suppliedSeed = parsedQuery.data.rankSeed;
  const rankSeed =
    suppliedSeed !== undefined && isWellFormedRankSeed(suppliedSeed)
      ? suppliedSeed
      : mintRankSeed({ viewerKey: viewerUserId ?? viewerFingerprint, asOfDayString: utcDayString });

  const feedResult = await listFeedVideosService({
    mode: parsedQuery.data.mode,
    categorySlug: parsedQuery.data.categorySlug ?? null,
    page: parsedQuery.data.page,
    limit: parsedQuery.data.limit,
    viewerUserId,
    viewerFingerprint,
    rankSeed,
  });

  if (!feedResult.success) {
    switch (feedResult.error.type) {
      case "WATCH_HISTORY_REQUIRES_SESSION":
        // 401, not 404: the caller CAN see this route, they just cannot see this mode
        // without an account. Serving it off a fingerprint would hand one person's watch
        // history to everyone behind the same NAT.
        respondUnauthenticated(res);
        return;
      default: {
        const exhaustiveCheck: never = feedResult.error.type;
        throw new Error(`Unhandled feed error: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  }

  const response: PaginatedResponse & { readonly rankSeed: string } = {
    status: "success",
    statusCode: 200,
    message: "Feed retrieved successfully",
    data: [...feedResult.value.rows],
    pagination: {
      page: parsedQuery.data.page,
      limit: parsedQuery.data.limit,
      total: feedResult.value.total,
      totalPages: Math.ceil(feedResult.value.total / parsedQuery.data.limit),
    },
    rankSeed: feedResult.value.rankSeed,
  };
  res.status(200).json(response);
}

/**
 * `GET /feed/search` — videos matching a typed query, most relevant first.
 *
 * NO `rankSeed` IN THE RESPONSE, unlike `/feed/videos`. The feed's seed exists to pin an
 * exploration term so page 2 does not reshuffle page 1; search has no exploration term to
 * pin, because its order is relevance and relevance is deterministic. Returning a seed the
 * route ignores would invite a client to thread one through.
 *
 * `PaginatedResponse` exactly — `data` plus `pagination`, no third sibling — which is what
 * lets the frontend read it with the ordinary paginated helper.
 *
 * The service answers no error union: a query that matches nothing is an empty page, not a
 * failure, and every other outcome here is an exception the error middleware owns.
 */
export async function searchVideos(req: Request, res: Response): Promise<void> {
  const parsedQuery = SearchVideosQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const searchPage = await searchVideosService({
    query: parsedQuery.data.query,
    page: parsedQuery.data.page,
    limit: parsedQuery.data.limit,
    // Optional auth: an anonymous searcher gets the same rows with every viewerState flag
    // false, which is definitionally true of them rather than a lookup we failed to do.
    viewerUserId: req.user?.id ?? null,
  });

  const response: PaginatedResponse = {
    status: "success",
    statusCode: 200,
    message: "Search results retrieved successfully",
    data: [...searchPage.rows],
    pagination: {
      page: parsedQuery.data.page,
      limit: parsedQuery.data.limit,
      total: searchPage.total,
      totalPages: Math.ceil(searchPage.total / parsedQuery.data.limit),
    },
  };
  res.status(200).json(response);
}
