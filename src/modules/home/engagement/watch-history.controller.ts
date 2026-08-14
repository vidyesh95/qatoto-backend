import type { Request, Response } from "express";

import {
  firstParam,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/home/engagement/engagement-error-response.js";
import { WatchHistoryVideoIdParamSchema } from "#src/modules/home/engagement/watch-history.schemas.js";
import * as watchHistoryService from "#src/modules/home/engagement/watch-history.service.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * `/watch-history` — the viewer editing their own history.
 *
 * NO `respondEngagementError` IMPORT, because the service has no error union: every one
 * of these writes is scoped to `req.user.id` and idempotent, so the only failure modes
 * left are a malformed uuid (422, here) and no session (401, from `requireAuth`).
 *
 * `affectedSessionCount` is the number of underlying session rows, NOT the number of
 * cards. One video watched across three UTC days is three rows and one card. The clear
 * response therefore says `clearedSessionCount` rather than a video count, so nobody
 * renders "Cleared 41 videos" from a number that does not mean that.
 */

/** The signed-in viewer, or `null` after answering 401. `requireAuth` runs first. */
function readViewerUserId(req: Request, res: Response): string | null {
  const viewerUserId = req.user?.id;
  if (viewerUserId === undefined) {
    respondUnauthenticated(res);
    return null;
  }
  return viewerUserId;
}

/** Parses `:videoId`, answering 422 itself when it is malformed. */
function parseVideoIdParam(req: Request, res: Response): string | null {
  const parsed = WatchHistoryVideoIdParamSchema.safeParse({
    videoId: firstParam(req.params.videoId ?? ""),
  });
  if (!parsed.success) {
    respondValidationFailed(res, parsed.error);
    return null;
  }
  return parsed.data.videoId;
}

/**
 * `DELETE /watch-history/videos/:videoId` — remove one video from my history.
 *
 * 200 even when it matched nothing. A videoId that is unknown, or known but never
 * watched by this viewer, leaves the caller in exactly the state they asked for — and a
 * 404 here would let any signed-in caller probe which uuids are real videos, which is
 * the enumeration §5.4's status policy exists to close.
 */
export async function hideVideoFromWatchHistory(req: Request, res: Response): Promise<void> {
  const viewerUserId = readViewerUserId(req, res);
  if (viewerUserId === null) return;
  const videoId = parseVideoIdParam(req, res);
  if (videoId === null) return;

  const result = await watchHistoryService.hideVideoFromWatchHistory(viewerUserId, videoId);

  const response: ApiResponse<{ readonly hiddenSessionCount: number }> = {
    status: "success",
    statusCode: 200,
    message: "Removed from watch history.",
    data: { hiddenSessionCount: result.affectedSessionCount },
  };
  res.status(200).json(response);
}

/**
 * `PUT /watch-history/videos/:videoId` — undo the removal.
 *
 * The verb pair on one path is the same idiom as `PUT`/`DELETE /videos/:videoId/save`:
 * a nullable column makes both directions idempotent, so a double-tapped Undo is
 * harmless rather than a second write.
 *
 * A `restoredSessionCount` of 0 is a real answer the client must respect — the rows may
 * have aged past the 90-day prune between the hide and the undo, in which case the card
 * is gone for good and the UI must not pretend otherwise.
 */
export async function restoreVideoToWatchHistory(req: Request, res: Response): Promise<void> {
  const viewerUserId = readViewerUserId(req, res);
  if (viewerUserId === null) return;
  const videoId = parseVideoIdParam(req, res);
  if (videoId === null) return;

  const result = await watchHistoryService.restoreVideoToWatchHistory(viewerUserId, videoId);

  const response: ApiResponse<{ readonly restoredSessionCount: number }> = {
    status: "success",
    statusCode: 200,
    message: "Restored to watch history.",
    data: { restoredSessionCount: result.affectedSessionCount },
  };
  res.status(200).json(response);
}

/** `DELETE /watch-history` — clear everything. Not reversible; see the service header. */
export async function clearWatchHistory(req: Request, res: Response): Promise<void> {
  const viewerUserId = readViewerUserId(req, res);
  if (viewerUserId === null) return;

  const result = await watchHistoryService.clearWatchHistory(viewerUserId);

  const response: ApiResponse<{ readonly clearedSessionCount: number }> = {
    status: "success",
    statusCode: 200,
    message: "Watch history cleared.",
    data: { clearedSessionCount: result.affectedSessionCount },
  };
  res.status(200).json(response);
}
