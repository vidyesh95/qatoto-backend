import type { Request, Response } from "express";

import {
  firstParam,
  respondFieldRefusal,
  respondStudioError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/studio/studio-error-response.js";
import {
  CreateVideoSchema,
  ListMyVideosQuerySchema,
  ReplaceChaptersSchema,
  ReplacePlaylistsSchema,
  ReplaceProductsSchema,
  UpdateVideoSchema,
} from "#src/modules/studio/videos/videos.schemas.js";
import * as videosService from "#src/modules/studio/videos/videos.service.js";
import type { ApiResponse, PaginatedResponse } from "#src/types/index.js";

/** POST /videos */
export async function createVideo(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = CreateVideoSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const createResult = await videosService.createVideo(req.user.id, parsedBody.data);
  if (!createResult.success) {
    respondStudioError(res, createResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 201,
    message: "Video created successfully",
    data: createResult.value,
  };
  res.status(201).json(response);
}

/** GET /videos/mine */
export async function getMyVideos(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedQuery = ListMyVideosQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const videosPage = await videosService.listMyVideos(req.user.id, parsedQuery.data);

  const response: PaginatedResponse = {
    status: "success",
    statusCode: 200,
    message: "Videos retrieved successfully",
    data: [...videosPage.rows],
    pagination: {
      page: parsedQuery.data.page,
      limit: parsedQuery.data.limit,
      total: videosPage.total,
      totalPages: Math.ceil(videosPage.total / parsedQuery.data.limit),
    },
  };
  res.status(200).json(response);
}

/** GET /videos/:videoId */
export async function getVideoById(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const getResult = await videosService.getVideo(req.user.id, firstParam(req.params.videoId ?? ""));
  if (!getResult.success) {
    respondStudioError(res, getResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Video retrieved successfully",
    data: getResult.value,
  };
  res.status(200).json(response);
}

/** PATCH /videos/:videoId */
export async function updateVideo(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = UpdateVideoSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const updateResult = await videosService.updateVideo(
    req.user.id,
    firstParam(req.params.videoId ?? ""),
    parsedBody.data,
  );
  if (!updateResult.success) {
    respondStudioError(res, updateResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Video updated successfully",
    data: updateResult.value,
  };
  res.status(200).json(response);
}

/** POST /videos/:videoId/thumbnail — multipart, field `image`. */
export async function uploadThumbnail(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  if (!req.file) {
    // Wording matched to the eleven sibling missing-file handlers: naming the multipart field is
    // the difference between a fixable request and a guess.
    respondFieldRefusal(res, "image", "An image file is required (multipart field 'image').");
    return;
  }

  const replaceResult = await videosService.replaceVideoThumbnail(
    req.user.id,
    firstParam(req.params.videoId ?? ""),
    req.file.buffer,
  );
  if (!replaceResult.success) {
    respondStudioError(res, replaceResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Thumbnail updated successfully",
    data: replaceResult.value,
  };
  res.status(200).json(response);
}

/** PUT /videos/:videoId/chapters */
export async function replaceChapters(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = ReplaceChaptersSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const replaceResult = await videosService.replaceChapters(
    req.user.id,
    firstParam(req.params.videoId ?? ""),
    parsedBody.data.chapters,
  );
  if (!replaceResult.success) {
    respondStudioError(res, replaceResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Chapters updated successfully",
    data: replaceResult.value,
  };
  res.status(200).json(response);
}

/** PUT /videos/:videoId/products */
export async function replaceAttachedProducts(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = ReplaceProductsSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const replaceResult = await videosService.replaceAttachedProducts(
    req.user.id,
    firstParam(req.params.videoId ?? ""),
    parsedBody.data.productIds,
  );
  if (!replaceResult.success) {
    respondStudioError(res, replaceResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Attached products updated successfully",
    data: replaceResult.value,
  };
  res.status(200).json(response);
}

/** PUT /videos/:videoId/playlists */
export async function replaceVideoPlaylists(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = ReplacePlaylistsSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const setResult = await videosService.setVideoPlaylists(
    req.user.id,
    firstParam(req.params.videoId ?? ""),
    parsedBody.data.playlistIds,
  );
  if (!setResult.success) {
    respondStudioError(res, setResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Playlists updated successfully",
    data: setResult.value,
  };
  res.status(200).json(response);
}

/** POST /videos/:videoId/publish */
export async function publishVideo(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const publishResult = await videosService.publishVideo(
    req.user.id,
    firstParam(req.params.videoId ?? ""),
  );
  if (!publishResult.success) {
    respondStudioError(res, publishResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    // An anime episode is SUBMITTED, not published — say so, or the creator will look
    // for it in /anime and find nothing.
    message:
      publishResult.value.reviewStatus === "pending"
        ? "Episode submitted for review"
        : "Video published successfully",
    data: publishResult.value,
  };
  res.status(200).json(response);
}

/** POST /videos/:videoId/unpublish */
export async function unpublishVideo(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const unpublishResult = await videosService.unpublishVideo(
    req.user.id,
    firstParam(req.params.videoId ?? ""),
  );
  if (!unpublishResult.success) {
    respondStudioError(res, unpublishResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Video unpublished successfully",
    data: unpublishResult.value,
  };
  res.status(200).json(response);
}

/**
 * GET /videos/:videoId/playback-token — DEFERRED (Appendix A), always refuses.
 *
 * The route is mounted so the client contract does not move when self-hosting lands.
 * Ownership is checked first, so a stranger gets 404 and only the owner sees the 409.
 */
export async function getPlaybackToken(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const tokenResult = await videosService.issuePlaybackToken(
    req.user.id,
    firstParam(req.params.videoId ?? ""),
  );
  // The success branch is `never` today, but it is written out rather than assumed:
  // when Appendix A lands and this starts minting real tokens, the compiler points here
  // instead of the route silently 409-ing a caller who should have got a token.
  if (!tokenResult.success) {
    respondStudioError(res, tokenResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Playback token issued",
    data: tokenResult.value,
  };
  res.status(200).json(response);
}

/** DELETE /videos/:videoId */
export async function deleteVideo(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const deleteResult = await videosService.deleteVideo(
    req.user.id,
    firstParam(req.params.videoId ?? ""),
  );
  if (!deleteResult.success) {
    respondStudioError(res, deleteResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Video deleted successfully",
    data: deleteResult.value,
  };
  res.status(200).json(response);
}

// --------------------------------------------------------------------------------
// Attached documents (§11j)
// --------------------------------------------------------------------------------

/** `POST /videos/:videoId/documents` — multipart field `document`, PDF, 25 MB. */
export async function attachDocument(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  if (!req.file) {
    respondFieldRefusal(res, "document", "A PDF is required (multipart field 'document').");
    return;
  }

  const attachResult = await videosService.attachVideoDocument(
    req.user.id,
    firstParam(req.params.videoId ?? ""),
    {
      // `originalname` is a client-chosen string and is treated as one: the service sanitizes it
      // before it reaches either the column or a `Content-Disposition` header.
      fileName: req.file.originalname,
      bytes: req.file.buffer,
    },
  );
  if (!attachResult.success) {
    respondStudioError(res, attachResult.error);
    return;
  }

  // 201 even when a re-upload converged on the existing row. The distinction a 200 would draw —
  // "these exact bytes were already here" — is one the creator cannot act on, and answering
  // differently would leak whether a document existed before.
  const response: ApiResponse = {
    status: "success",
    statusCode: 201,
    message: "Document attached successfully",
    data: attachResult.value,
  };
  res.status(201).json(response);
}

/** `DELETE /videos/:videoId/documents/:documentId`. */
export async function detachDocument(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const detachResult = await videosService.detachVideoDocument(
    req.user.id,
    firstParam(req.params.videoId ?? ""),
    firstParam(req.params.documentId ?? ""),
  );
  if (!detachResult.success) {
    respondStudioError(res, detachResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Document removed successfully",
    data: detachResult.value,
  };
  res.status(200).json(response);
}

/**
 * `GET /videos/:videoId/documents/:documentId/file` — 302 to a short-lived presigned URL.
 *
 * ⚠️ THE ONLY PUBLIC ROUTE ON THIS ROUTER. `req.user` is optional here rather than required, and
 * the gate is the VIDEO's publicness, decided in the service. Do not add `requireAuth` to it: the
 * copy under the studio control promises "shown as a download under the video", and a video shown
 * to signed-out visitors whose document is not would not keep that promise.
 *
 * A REDIRECT RATHER THAN A PROXY. Streaming 25 MB through this process to add nothing would hold a
 * connection for the length of the transfer; the redirect hands the client straight to storage.
 * `Cache-Control: no-store` is set because the 302 carries a bearer capability in its `Location` —
 * a cached redirect is a link that outlives the gate it was issued under, which is the whole thing
 * this design exists to prevent.
 */
export async function downloadDocument(req: Request, res: Response): Promise<void> {
  const downloadResult = await videosService.resolveVideoDocumentDownload(
    firstParam(req.params.videoId ?? ""),
    firstParam(req.params.documentId ?? ""),
    req.user?.id ?? null,
  );
  if (!downloadResult.success) {
    respondStudioError(res, downloadResult.error);
    return;
  }

  res.setHeader("Cache-Control", "no-store");
  res.redirect(302, downloadResult.value.downloadUrl);
}
