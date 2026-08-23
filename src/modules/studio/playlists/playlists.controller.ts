import type { Request, Response } from "express";

import {
  CreatePlaylistSchema,
  ListMyPlaylistsQuerySchema,
  PlaylistVideoParamsSchema,
  ReplacePlaylistVideosSchema,
  UpdatePlaylistSchema,
} from "#src/modules/studio/playlists/playlists.schemas.js";
import * as playlistsService from "#src/modules/studio/playlists/playlists.service.js";
import {
  firstParam,
  respondStudioError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/studio/studio-error-response.js";
import type { ApiResponse, PaginatedResponse } from "#src/types/index.js";

/** POST /playlists */
export async function createPlaylist(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = CreatePlaylistSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const createResult = await playlistsService.createPlaylist(req.user.id, parsedBody.data);
  if (!createResult.success) {
    respondStudioError(res, createResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 201,
    message: "Playlist created successfully",
    data: createResult.value,
  };
  res.status(201).json(response);
}

/** GET /playlists/mine */
export async function getMyPlaylists(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedQuery = ListMyPlaylistsQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const playlistsPage = await playlistsService.listMyPlaylists(
    req.user.id,
    parsedQuery.data.page,
    parsedQuery.data.limit,
    parsedQuery.data.videoId,
  );

  const response: PaginatedResponse = {
    status: "success",
    statusCode: 200,
    message: "Playlists retrieved successfully",
    data: [...playlistsPage.rows],
    pagination: {
      page: parsedQuery.data.page,
      limit: parsedQuery.data.limit,
      total: playlistsPage.total,
      totalPages: Math.ceil(playlistsPage.total / parsedQuery.data.limit),
    },
  };
  res.status(200).json(response);
}

/** GET /playlists/:playlistId */
export async function getPlaylistById(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const getResult = await playlistsService.getPlaylist(
    req.user.id,
    firstParam(req.params.playlistId ?? ""),
  );
  if (!getResult.success) {
    respondStudioError(res, getResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Playlist retrieved successfully",
    data: getResult.value,
  };
  res.status(200).json(response);
}

/** PATCH /playlists/:playlistId */
export async function updatePlaylist(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = UpdatePlaylistSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const updateResult = await playlistsService.updatePlaylist(
    req.user.id,
    firstParam(req.params.playlistId ?? ""),
    parsedBody.data,
  );
  if (!updateResult.success) {
    respondStudioError(res, updateResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Playlist updated successfully",
    data: updateResult.value,
  };
  res.status(200).json(response);
}

/** DELETE /playlists/:playlistId */
export async function deletePlaylist(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const deleteResult = await playlistsService.deletePlaylist(
    req.user.id,
    firstParam(req.params.playlistId ?? ""),
  );
  if (!deleteResult.success) {
    respondStudioError(res, deleteResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Playlist deleted successfully",
    data: deleteResult.value,
  };
  res.status(200).json(response);
}

/** PUT /playlists/:playlistId/videos — membership AND order. */
export async function replacePlaylistVideos(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = ReplacePlaylistVideosSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const replaceResult = await playlistsService.replacePlaylistVideos(
    req.user.id,
    firstParam(req.params.playlistId ?? ""),
    parsedBody.data.videoIds,
  );
  if (!replaceResult.success) {
    respondStudioError(res, replaceResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Playlist videos updated successfully",
    data: replaceResult.value,
  };
  res.status(200).json(response);
}

/**
 * `PUT`/`DELETE /playlists/:playlistId/videos/:videoId` — one video, the card menu's verb.
 *
 * Both handlers answer the WHOLE playlist rather than an acknowledgement, so the picker can
 * settle its checked state and its count on the server's answer instead of guessing which
 * of the two it just changed.
 */
async function respondToPlaylistVideoToggle(
  req: Request,
  res: Response,
  shouldBeInPlaylist: boolean,
): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedParams = PlaylistVideoParamsSchema.safeParse({
    playlistId: firstParam(req.params.playlistId ?? ""),
    videoId: firstParam(req.params.videoId ?? ""),
  });
  if (!parsedParams.success) {
    respondValidationFailed(res, parsedParams.error);
    return;
  }

  const toggleResult = shouldBeInPlaylist
    ? await playlistsService.addVideoToPlaylist(
        req.user.id,
        parsedParams.data.playlistId,
        parsedParams.data.videoId,
      )
    : await playlistsService.removeVideoFromPlaylist(
        req.user.id,
        parsedParams.data.playlistId,
        parsedParams.data.videoId,
      );

  if (!toggleResult.success) {
    respondStudioError(res, toggleResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: shouldBeInPlaylist ? "Added to playlist." : "Removed from playlist.",
    data: toggleResult.value,
  };
  res.status(200).json(response);
}

export function addVideoToPlaylist(req: Request, res: Response): Promise<void> {
  return respondToPlaylistVideoToggle(req, res, true);
}

export function removeVideoFromPlaylist(req: Request, res: Response): Promise<void> {
  return respondToPlaylistVideoToggle(req, res, false);
}
