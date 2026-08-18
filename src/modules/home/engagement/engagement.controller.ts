import type { Request, Response } from "express";

import { logger } from "#src/lib/logger.js";
import { utcHourOf } from "#src/lib/utc-day.js";
import { computeViewerFingerprint, utcDayStringOf } from "#src/lib/viewer-fingerprint.js";
import * as subscriptionsService from "#src/modules/home/engagement/creator-subscriptions.service.js";
import {
  firstParam,
  optionalBody,
  respondEngagementError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/home/engagement/engagement-error-response.js";
import {
  CommentIdParamSchema,
  CreateCommentSchema,
  CreatorIdParamSchema,
  ListVideoCommentsQuerySchema,
  RecordShareSchema,
  RecordViewBeaconSchema,
  ReportPlaybackErrorSchema,
  UpdateCommentSchema,
  VideoIdParamSchema,
  WatchTimeQuerySchema,
} from "#src/modules/home/engagement/engagement.schemas.js";
import * as commentsService from "#src/modules/home/engagement/video-comments.service.js";
import * as engagementService from "#src/modules/home/engagement/video-engagement.service.js";
import { getViewerWatchTime } from "#src/modules/home/engagement/watch-time.service.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * The client IP, for the fingerprint hash and nothing else.
 *
 * READ `req.ip`, NEVER `x-forwarded-for` BY HAND. `app.set("trust proxy", 1)` makes
 * Express take the LAST entry of that header — the one our own proxy appended — and
 * ignore everything an attacker prepended. Parsing the header here would re-open a hole
 * Express has already closed, and would make every fingerprint attacker-chosen.
 *
 * WHEN IT IS MISSING, DEGRADE — never fail. The consequence is that IP-less anonymous
 * viewers sharing a user agent collapse into one fingerprint for the day, which
 * UNDER-counts. That is the safe direction, and far better than a 4xx: a beacon that
 * errors is a beacon the client retries on the watch page.
 */
function readViewerIdentity(req: Request): {
  readonly viewerUserId: string | null;
  readonly viewerFingerprint: string;
  readonly utcDayString: string;
  readonly utcHour: number;
} {
  const clientIp = req.ip;
  if (clientIp === undefined) {
    logger.warn("engagement: no client ip on request, fingerprint degraded", {
      requestId: req.requestId,
      path: req.originalUrl,
    });
  }

  const viewerUserId = req.user?.id ?? null;
  // ONE INSTANT, TWO BUCKETS. The day keys `video_view_session` and the (day, hour) pair keys
  // `user_activity_hour`; reading the clock twice would let a beacon landing on the stroke of
  // midnight be filed under yesterday's day and today's hour.
  const requestInstant = new Date();
  const utcDayString = utcDayStringOf(requestInstant);
  const utcHour = utcHourOf(requestInstant);

  return {
    viewerUserId,
    utcDayString,
    utcHour,
    viewerFingerprint: computeViewerFingerprint({
      utcDayString,
      viewerUserId,
      clientIp: clientIp ?? "",
      // Bounded before hashing: unbounded, this is an attacker-supplied input to a hash
      // on the hottest write path on the platform.
      userAgent: (req.headers["user-agent"] ?? "").slice(0, 512),
    }),
  };
}

/** Parses `:videoId`, answering 422 itself when it is malformed. */
function parseVideoIdParam(req: Request, res: Response): string | null {
  const parsed = VideoIdParamSchema.safeParse({
    videoId: firstParam(req.params.videoId ?? ""),
  });
  if (!parsed.success) {
    respondValidationFailed(res, parsed.error);
    return null;
  }
  return parsed.data.videoId;
}

function parseCommentIdParam(req: Request, res: Response): string | null {
  const parsed = CommentIdParamSchema.safeParse({
    commentId: firstParam(req.params.commentId ?? ""),
  });
  if (!parsed.success) {
    respondValidationFailed(res, parsed.error);
    return null;
  }
  return parsed.data.commentId;
}

/**
 * `POST /videos/:videoId/view-beacon`.
 *
 * ANSWERS 202 WITH NO BODY, and that is a security property rather than laziness.
 * Echoing `watchedSeconds`, `completionBasisPoints` or `isCountedView` would hand an
 * attacker a live oracle for tuning against the clamp — the one thing Rule 1 exists to
 * defend. The client has no legitimate use for the server's copy of those numbers.
 */
export async function recordViewBeacon(req: Request, res: Response): Promise<void> {
  const videoId = parseVideoIdParam(req, res);
  if (videoId === null) return;

  const parsedBody = RecordViewBeaconSchema.safeParse(optionalBody(req));
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const identity = readViewerIdentity(req);

  const beaconResult = await engagementService.recordViewBeacon({
    videoId,
    viewerUserId: identity.viewerUserId,
    viewerFingerprint: identity.viewerFingerprint,
    viewDayBucket: identity.utcDayString,
    viewHourBucket: identity.utcHour,
    feedSource: parsedBody.data.feedSource,
    positionSeconds: parsedBody.data.positionSeconds,
    reportedDurationSeconds: parsedBody.data.reportedDurationSeconds,
  });

  if (!beaconResult.success) {
    respondEngagementError(res, beaconResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 202,
    message: "Beacon recorded.",
  };
  res.status(202).json(response);
}

/**
 * `POST /videos/:videoId/playback-error` (§8.2).
 *
 * Also 202 with no body, and specifically NEVER the current distinct-reporter count —
 * that would tell an attacker exactly how many more fingerprints they need to
 * manufacture to take a competitor's video out of the feed.
 */
export async function reportPlaybackError(req: Request, res: Response): Promise<void> {
  const videoId = parseVideoIdParam(req, res);
  if (videoId === null) return;

  const parsedBody = ReportPlaybackErrorSchema.safeParse(optionalBody(req));
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const identity = readViewerIdentity(req);

  const reportResult = await engagementService.recordPlaybackError({
    videoId,
    viewerFingerprint: identity.viewerFingerprint,
    reportDayBucket: identity.utcDayString,
    errorCode: parsedBody.data.errorCode,
  });

  if (!reportResult.success) {
    respondEngagementError(res, reportResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 202,
    message: "Playback error recorded.",
  };
  res.status(202).json(response);
}

/**
 * `PUT`/`DELETE /videos/:videoId/like` and `.../save`.
 *
 * Both verbs answer 200 with the resulting state, so a 24-card grid renders the
 * server's number instead of guessing at one. A `PUT` on an already-liked video and a
 * `DELETE` on an unliked one both succeed — that is what "idempotent by verb" means on
 * the wire, and it is why these carry no idempotency key.
 *
 * NOTE FOR ANYONE EDITING: these handlers must not read `req.body`. They carry no body
 * cap, and `json-body-budget.test.ts` fails the build if a capless route reads a body.
 */
async function respondToVideoToggle(
  req: Request,
  res: Response,
  shouldBeSet: boolean,
  kind: "like" | "save",
): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const videoId = parseVideoIdParam(req, res);
  if (videoId === null) return;

  const toggleResult =
    kind === "like"
      ? await engagementService.setVideoLike({ videoId, userId: req.user.id, shouldBeSet })
      : await engagementService.setVideoSave({ videoId, userId: req.user.id, shouldBeSet });

  if (!toggleResult.success) {
    respondEngagementError(res, toggleResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: shouldBeSet ? "Saved." : "Removed.",
    data:
      kind === "like"
        ? { hasLiked: toggleResult.value.isSet, likeCount: toggleResult.value.count }
        : { hasSaved: toggleResult.value.isSet, saveCount: toggleResult.value.count },
  };
  res.status(200).json(response);
}

export function likeVideo(req: Request, res: Response): Promise<void> {
  return respondToVideoToggle(req, res, true, "like");
}

export function unlikeVideo(req: Request, res: Response): Promise<void> {
  return respondToVideoToggle(req, res, false, "like");
}

export function saveVideo(req: Request, res: Response): Promise<void> {
  return respondToVideoToggle(req, res, true, "save");
}

export function unsaveVideo(req: Request, res: Response): Promise<void> {
  return respondToVideoToggle(req, res, false, "save");
}

/**
 * `POST /videos/:videoId/share`, optional auth.
 *
 * A logged-out "copy link" is a real share and gets a real row. The COUNTER, though,
 * moves only for a signed-in sharer — see the service. Do not "fix" that: `shareCount`
 * feeds §4.1's engagement rate, and an anonymous caller must not be able to push a
 * ranking input.
 */
export async function recordShare(req: Request, res: Response): Promise<void> {
  const videoId = parseVideoIdParam(req, res);
  if (videoId === null) return;

  const parsedBody = RecordShareSchema.safeParse(optionalBody(req));
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const identity = readViewerIdentity(req);

  const shareResult = await engagementService.recordShare({
    videoId,
    userId: identity.viewerUserId,
    sharerFingerprint: identity.viewerFingerprint,
    shareDayBucket: identity.utcDayString,
    channel: parsedBody.data.channel,
  });

  if (!shareResult.success) {
    respondEngagementError(res, shareResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Share recorded.",
    data: { shareCount: shareResult.value.shareCount },
  };
  res.status(200).json(response);
}

/**
 * `GET /videos/:videoId/comments`.
 *
 * Returns `data` plus `nextCursor`, NOT a `PaginatedResponse` — a keyset read has no
 * honest `total`, and inventing one would mean a COUNT over the whole thread on every
 * page.
 */
export async function listVideoComments(req: Request, res: Response): Promise<void> {
  const videoId = parseVideoIdParam(req, res);
  if (videoId === null) return;

  const parsedQuery = ListVideoCommentsQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const listResult = await commentsService.listVideoComments({
    videoId,
    viewerUserId: req.user?.id ?? null,
    parentCommentId: parsedQuery.data.parentCommentId ?? null,
    limit: parsedQuery.data.limit,
    cursor: parsedQuery.data.cursor ?? null,
  });

  if (!listResult.success) {
    respondEngagementError(res, listResult.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Comments retrieved successfully",
    data: listResult.value.rows,
    nextCursor: listResult.value.nextCursor,
  });
}

export async function createVideoComment(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const videoId = parseVideoIdParam(req, res);
  if (videoId === null) return;

  const parsedBody = CreateCommentSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const createResult = await commentsService.createVideoComment({
    videoId,
    authorUserId: req.user.id,
    bodyText: parsedBody.data.body,
    parentCommentId: parsedBody.data.parentCommentId ?? null,
  });

  if (!createResult.success) {
    respondEngagementError(res, createResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 201,
    message: "Comment posted.",
    data: createResult.value,
  };
  res.status(201).json(response);
}

export async function updateComment(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const commentId = parseCommentIdParam(req, res);
  if (commentId === null) return;

  const parsedBody = UpdateCommentSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const updateResult = await commentsService.updateVideoComment({
    commentId,
    authorUserId: req.user.id,
    bodyText: parsedBody.data.body,
  });

  if (!updateResult.success) {
    respondEngagementError(res, updateResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Comment updated.",
    data: updateResult.value,
  };
  res.status(200).json(response);
}

/** Tombstone, not a row delete — the replies underneath must survive. */
export async function deleteComment(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const commentId = parseCommentIdParam(req, res);
  if (commentId === null) return;

  const deleteResult = await commentsService.deleteVideoComment({
    commentId,
    actorUserId: req.user.id,
  });

  if (!deleteResult.success) {
    respondEngagementError(res, deleteResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Comment deleted.",
    data: deleteResult.value,
  };
  res.status(200).json(response);
}

async function respondToCommentLike(
  req: Request,
  res: Response,
  shouldBeSet: boolean,
): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const commentId = parseCommentIdParam(req, res);
  if (commentId === null) return;

  const likeResult = await commentsService.setCommentLike({
    commentId,
    userId: req.user.id,
    shouldBeSet,
  });

  if (!likeResult.success) {
    respondEngagementError(res, likeResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: shouldBeSet ? "Liked." : "Unliked.",
    data: { hasLiked: likeResult.value.isSet, likeCount: likeResult.value.likeCount },
  };
  res.status(200).json(response);
}

export function likeComment(req: Request, res: Response): Promise<void> {
  return respondToCommentLike(req, res, true);
}

export function unlikeComment(req: Request, res: Response): Promise<void> {
  return respondToCommentLike(req, res, false);
}

async function respondToSubscription(
  req: Request,
  res: Response,
  shouldBeSubscribed: boolean,
): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedParams = CreatorIdParamSchema.safeParse({
    creatorId: firstParam(req.params.creatorId ?? ""),
  });
  if (!parsedParams.success) {
    respondValidationFailed(res, parsedParams.error);
    return;
  }

  const subscriptionResult = await subscriptionsService.setCreatorSubscription({
    subscriberId: req.user.id,
    creatorId: parsedParams.data.creatorId,
    shouldBeSubscribed,
  });

  if (!subscriptionResult.success) {
    respondEngagementError(res, subscriptionResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: shouldBeSubscribed ? "Subscribed." : "Unsubscribed.",
    data: subscriptionResult.value,
  };
  res.status(200).json(response);
}

export function subscribeToCreator(req: Request, res: Response): Promise<void> {
  return respondToSubscription(req, res, true);
}

export function unsubscribeFromCreator(req: Request, res: Response): Promise<void> {
  return respondToSubscription(req, res, false);
}

/**
 * `GET /users/me/watch-time` — HOME_BACKEND_STRUCTURE.md §3.3a.
 *
 * IT LIVES IN THE ENGAGEMENT CONTROLLER AND IS MOUNTED ON THE USERS ROUTER, which looks like a
 * seam and is one on purpose. The read is engagement-domain — its source is the beacon counter
 * three functions above — while its path belongs beside `/users/me/handle` and
 * `/users/me/linked-accounts`, where a client already looks for facts about itself.
 *
 * The alternative was importing the watch-time service into `users.controller.ts`, and that file
 * is deliberately free of any transitive `#src/db/index.js` import: its two unit-test files mock
 * only `users.service.js`, so pulling `db` (and therefore `config`, and therefore the whole
 * environment) into that module breaks both of them at import time. `lib/utc-day.ts` exists for
 * exactly this reason and its header says so.
 *
 * THE ID COMES FROM THE SESSION AND NOTHING ELSE. There is deliberately no
 * `GET /users/:id/watch-time`: how long somebody watched is theirs. Staff who need cross-user
 * numbers go through `/admin/metrics`, which is capability-gated and, for named lists, audited.
 */
export async function getMyWatchTime(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({ status: "error", statusCode: 401, message: "Please sign in." });
    return;
  }

  const parsedQuery = WatchTimeQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const watchTime = await getViewerWatchTime(req.user.id, parsedQuery.data.timeZone);

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Watch time retrieved successfully.",
    data: watchTime,
  };
  res.status(200).json(response);
}
