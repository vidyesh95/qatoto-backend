import type { Request, Response } from "express";
import { z } from "zod";

import {
  firstParam,
  respondStudioError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/controllers/studio-error-response.js";
import * as seriesService from "#src/services/series.service.js";
import type { ApiResponse, PaginatedResponse } from "#src/types/index.js";

/**
 * Anime catalog endpoints (docs/STUDIO_BACKEND_STRUCTURE.md §6).
 *
 * Every schema below is declared from a defaults-free shape map and made partial for the
 * PATCH variant, because `.partial()` does not strip `.default()` — the same trap
 * documented at length in videos.controller.ts.
 */

const HttpUrlSchema = z
  .url({ protocol: /^https?$/ })
  .max(2048)
  .transform((rawUrl) => new URL(rawUrl).toString());

const seriesFieldShapes = {
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000),
  posterUrl: HttpUrlSchema,
  genreTags: z.array(z.string().trim().min(1).max(40)).max(20),
  status: z.enum(["ongoing", "completed", "hiatus"]),
};

const CreateSeriesSchema = z
  .object(seriesFieldShapes)
  .partial()
  .extend({
    title: seriesFieldShapes.title,
    genreTags: seriesFieldShapes.genreTags.default([]),
    status: seriesFieldShapes.status.default("ongoing"),
  })
  .strict();

const UpdateSeriesSchema = z.object(seriesFieldShapes).partial().strict();

const seasonFieldShapes = {
  seasonLabel: z.string().trim().min(1).max(60),
  position: z.number().int().min(0).max(500),
};

const CreateSeasonSchema = z
  .object(seasonFieldShapes)
  .partial()
  .extend({ seasonLabel: seasonFieldShapes.seasonLabel })
  .strict();

const UpdateSeasonSchema = z.object(seasonFieldShapes).partial().strict();

/**
 * `videoId` is deliberately absent. Linking an episode to an upload happens in the upload
 * flow, where the caller's ownership of the VIDEO is proven; accepting it here would let
 * a series owner attach a stranger's video to their catalog.
 */
const episodeFieldShapes = {
  episodeNumber: z.number().int().min(0),
  episodeTitle: z.string().trim().min(1).max(200),
  isPremium: z.boolean(),
  releaseScheduleDay: z.string().trim().max(20),
  releaseScheduleTime: z.string().trim().max(10),
  premiereDate: z.coerce.date(),
  audioMode: z.enum(["subbed", "dubbed"]),
  audioLanguage: z.string().trim().max(60),
  ageRating: z.string().trim().max(20),
};

const CreateEpisodeSchema = z
  .object(episodeFieldShapes)
  .partial()
  .extend({
    episodeNumber: episodeFieldShapes.episodeNumber,
    episodeTitle: episodeFieldShapes.episodeTitle,
    isPremium: episodeFieldShapes.isPremium.default(false),
  })
  .strict();

const UpdateEpisodeSchema = z.object(episodeFieldShapes).partial().strict();

const ListMySeriesQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export type CreateSeriesInput = z.infer<typeof CreateSeriesSchema>;
export type UpdateSeriesInput = z.infer<typeof UpdateSeriesSchema>;
export type CreateSeasonInput = z.infer<typeof CreateSeasonSchema>;
export type UpdateSeasonInput = z.infer<typeof UpdateSeasonSchema>;
export type CreateEpisodeInput = z.infer<typeof CreateEpisodeSchema>;
export type UpdateEpisodeInput = z.infer<typeof UpdateEpisodeSchema>;

/** Reads the nested path ids that prove the ownership chain. */
function pathIds(req: Request): {
  readonly seriesId: string;
  readonly seasonId: string;
  readonly episodeId: string;
} {
  return {
    seriesId: firstParam(req.params.seriesId ?? ""),
    seasonId: firstParam(req.params.seasonId ?? ""),
    episodeId: firstParam(req.params.episodeId ?? ""),
  };
}

function respondSeries(res: Response, statusCode: number, message: string, data: unknown): void {
  const response: ApiResponse = { status: "success", statusCode, message, data };
  res.status(statusCode).json(response);
}

/** POST /series */
export async function createSeries(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }
  const parsedBody = CreateSeriesSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }
  const createResult = await seriesService.createSeries(req.user.id, parsedBody.data);
  if (!createResult.success) {
    respondStudioError(res, createResult.error);
    return;
  }
  respondSeries(res, 201, "Series created successfully", createResult.value);
}

/** GET /series/mine */
export async function getMySeries(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }
  const parsedQuery = ListMySeriesQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }
  const seriesPage = await seriesService.listMySeries(
    req.user.id,
    parsedQuery.data.page,
    parsedQuery.data.limit,
  );
  const response: PaginatedResponse = {
    status: "success",
    statusCode: 200,
    message: "Series retrieved successfully",
    data: [...seriesPage.rows],
    pagination: {
      page: parsedQuery.data.page,
      limit: parsedQuery.data.limit,
      total: seriesPage.total,
      totalPages: Math.ceil(seriesPage.total / parsedQuery.data.limit),
    },
  };
  res.status(200).json(response);
}

/** GET /series/:seriesId */
export async function getSeriesById(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }
  const getResult = await seriesService.getSeries(req.user.id, pathIds(req).seriesId);
  if (!getResult.success) {
    respondStudioError(res, getResult.error);
    return;
  }
  respondSeries(res, 200, "Series retrieved successfully", getResult.value);
}

/** PATCH /series/:seriesId */
export async function updateSeries(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }
  const parsedBody = UpdateSeriesSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }
  const updateResult = await seriesService.updateSeries(
    req.user.id,
    pathIds(req).seriesId,
    parsedBody.data,
  );
  if (!updateResult.success) {
    respondStudioError(res, updateResult.error);
    return;
  }
  respondSeries(res, 200, "Series updated successfully", updateResult.value);
}

/** DELETE /series/:seriesId — the catalog entry only; uploaded videos survive. */
export async function deleteSeries(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }
  const deleteResult = await seriesService.deleteSeries(req.user.id, pathIds(req).seriesId);
  if (!deleteResult.success) {
    respondStudioError(res, deleteResult.error);
    return;
  }
  respondSeries(res, 200, "Series deleted successfully", deleteResult.value);
}

/** POST /series/:seriesId/seasons */
export async function createSeason(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }
  const parsedBody = CreateSeasonSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }
  const createResult = await seriesService.createSeason(
    req.user.id,
    pathIds(req).seriesId,
    parsedBody.data,
  );
  if (!createResult.success) {
    respondStudioError(res, createResult.error);
    return;
  }
  respondSeries(res, 201, "Season created successfully", createResult.value);
}

/** PATCH /series/:seriesId/seasons/:seasonId */
export async function updateSeason(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }
  const parsedBody = UpdateSeasonSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }
  const { seriesId, seasonId } = pathIds(req);
  const updateResult = await seriesService.updateSeason(
    req.user.id,
    seriesId,
    seasonId,
    parsedBody.data,
  );
  if (!updateResult.success) {
    respondStudioError(res, updateResult.error);
    return;
  }
  respondSeries(res, 200, "Season updated successfully", updateResult.value);
}

/** DELETE /series/:seriesId/seasons/:seasonId */
export async function deleteSeason(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }
  const { seriesId, seasonId } = pathIds(req);
  const deleteResult = await seriesService.deleteSeason(req.user.id, seriesId, seasonId);
  if (!deleteResult.success) {
    respondStudioError(res, deleteResult.error);
    return;
  }
  respondSeries(res, 200, "Season deleted successfully", deleteResult.value);
}

/** POST /series/:seriesId/seasons/:seasonId/episodes */
export async function createEpisode(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }
  const parsedBody = CreateEpisodeSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }
  const { seriesId, seasonId } = pathIds(req);
  const createResult = await seriesService.createEpisode(
    req.user.id,
    seriesId,
    seasonId,
    parsedBody.data,
  );
  if (!createResult.success) {
    respondStudioError(res, createResult.error);
    return;
  }
  respondSeries(res, 201, "Episode created successfully", createResult.value);
}

/** PATCH /series/:seriesId/seasons/:seasonId/episodes/:episodeId */
export async function updateEpisode(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }
  const parsedBody = UpdateEpisodeSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }
  const { seriesId, seasonId, episodeId } = pathIds(req);
  const updateResult = await seriesService.updateEpisode(
    req.user.id,
    seriesId,
    seasonId,
    episodeId,
    parsedBody.data,
  );
  if (!updateResult.success) {
    respondStudioError(res, updateResult.error);
    return;
  }
  respondSeries(res, 200, "Episode updated successfully", updateResult.value);
}

/** DELETE /series/:seriesId/seasons/:seasonId/episodes/:episodeId */
export async function deleteEpisode(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }
  const { seriesId, seasonId, episodeId } = pathIds(req);
  const deleteResult = await seriesService.deleteEpisode(
    req.user.id,
    seriesId,
    seasonId,
    episodeId,
  );
  if (!deleteResult.success) {
    respondStudioError(res, deleteResult.error);
    return;
  }
  respondSeries(res, 200, "Episode deleted successfully", deleteResult.value);
}
