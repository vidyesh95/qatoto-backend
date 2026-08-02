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
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/controllers/engagement-error-response.js";
import { logger } from "#src/lib/logger.js";
import { isWellFormedRankSeed, mintRankSeed, RANK_SEED_LENGTH } from "#src/lib/rank-seed.js";
import { computeViewerFingerprint, utcDayStringOf } from "#src/lib/viewer-fingerprint.js";
import * as contentCategoriesService from "#src/services/content-categories.service.js";
import { FEED_MODES, listFeedVideos as listFeedVideosService } from "#src/services/feed.service.js";
import * as videoWatchService from "#src/services/video-watch.service.js";
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

/** The chip and tile slugs are kebab-case, server-generated, and validated at creation. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * `GET /feed/videos` — §5.1's query contract.
 *
 * `.strict()`, `z.coerce` with `.default()`, snake_case enum values that byte-match the
 * wire contract (`?mode=new_to_you`, never `new-to-you`).
 *
 * `page` is capped at 200 and `limit` at 50 because offset pagination gets more expensive
 * the deeper it goes, and nothing on the homepage asks for row 10,000.
 */
export const ListFeedVideosQuerySchema = z
  .object({
    mode: z.enum(FEED_MODES).default("all"),
    categorySlug: z.string().regex(SLUG_PATTERN).max(64).optional(),
    page: z.coerce.number().int().min(1).max(200).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(24),
    /**
     * Echoed from a previous response so page 2 ranks against the same seed as page 1.
     * Absent on a first request; minted server-side and returned.
     */
    rankSeed: z.string().length(RANK_SEED_LENGTH).optional(),
  })
  .strict();

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
