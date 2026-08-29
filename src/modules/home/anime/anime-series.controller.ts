import type { Request, Response } from "express";

import {
  firstParam,
  respondValidationFailed,
} from "#src/modules/home/anime/anime-error-response.js";
import * as animeSeriesService from "#src/modules/home/anime/anime-series.service.js";
import { ListPublicAnimeSeriesQuerySchema } from "#src/modules/home/anime/anime.schemas.js";
import type { ApiResponse, PaginatedResponse } from "#src/types/index.js";

/**
 * `GET /anime/series` — PUBLIC. Every series with something watchable in it.
 *
 * Offset pagination rather than a cursor: the frontend's `generateStaticParams` walks this
 * to exhaustion at build time and the sitemap does the same, and both want a total to know
 * when they are done.
 */
export async function listPublicSeries(req: Request, res: Response): Promise<void> {
  const parsed = ListPublicAnimeSeriesQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    respondValidationFailed(res, parsed.error);
    return;
  }

  const page = await animeSeriesService.listPublicAnimeSeries({
    page: parsed.data.page,
    limit: parsed.data.limit,
  });

  const response: PaginatedResponse<animeSeriesService.PublicAnimeSeriesCard> = {
    status: "success",
    statusCode: 200,
    message: "Anime series retrieved successfully",
    data: [...page.rows],
    pagination: {
      page: parsed.data.page,
      limit: parsed.data.limit,
      total: page.total,
      totalPages: Math.ceil(page.total / parsed.data.limit),
    },
  };
  res.status(200).json(response);
}

/**
 * `GET /anime/series/:seriesSlug` — PUBLIC. The detail tree.
 *
 * ONE 404 COVERS EVERYTHING. A series that does not exist, a series whose every episode is
 * still in review, and a series nobody has attached a video to all answer the same bytes.
 * Distinguishing them would confirm that an unreleased show exists, which is exactly the
 * oracle the projection's episode filter exists to prevent.
 */
export async function getPublicSeries(req: Request, res: Response): Promise<void> {
  const series = await animeSeriesService.loadPublicAnimeSeries(firstParam(req.params.seriesSlug));

  if (series === null) {
    res.status(404).json({ status: "error", statusCode: 404, message: "Anime series not found." });
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Anime series retrieved successfully",
    data: series,
  };
  res.status(200).json(response);
}
