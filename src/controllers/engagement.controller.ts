import type { Request, Response } from "express";
import { z } from "zod";

import {
  firstParam,
  optionalBody,
  respondEngagementError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/controllers/engagement-error-response.js";
import { logger } from "#src/lib/logger.js";
import { computeViewerFingerprint, utcDayStringOf } from "#src/lib/viewer-fingerprint.js";
import * as subscriptionsService from "#src/services/creator-subscriptions.service.js";
import * as commentsService from "#src/services/video-comments.service.js";
import * as engagementService from "#src/services/video-engagement.service.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * The viewer-side write surface — HOME_BACKEND_STRUCTURE.md §5.2.
 *
 * Schemas live in this file and are exported for tests, the convention
 * videos.controller.ts sets. Every one is `.strict()`, so a client sending a key the
 * server owns gets a 422 rather than having it silently dropped.
 */

// ---------------------------------------------------------------------------
// Param schemas
// ---------------------------------------------------------------------------

/**
 * `video.id` and `video_comment.id` are both `randomUUID()`, so `z.uuid()` is a true
 * statement about the column rather than a guess.
 *
 * A DEPARTURE from videos.controller.ts, which passes the raw param to the service and
 * lets a garbage id come back as VIDEO_NOT_FOUND. Here a malformed id 422s before any
 * query runs, and that leaks nothing: uuid-ness is client-checkable, so the 422 says
 * only "that is not a uuid", never "that uuid does not exist".
 */
export const VideoIdParamSchema = z.object({ videoId: z.uuid() }).strict();
export const CommentIdParamSchema = z.object({ commentId: z.uuid() }).strict();

/**
 * NOT `z.uuid()`. `user.id` carries no `$defaultFn` (schema.ts:48) — Better Auth mints
 * it and its ids are not uuids. Asserting the format here would 422 every real creator.
 */
export const CreatorIdParamSchema = z
  .object({ creatorId: z.string().trim().min(1).max(64) })
  .strict();

// ---------------------------------------------------------------------------
// Body and query schemas
// ---------------------------------------------------------------------------

/** Byte-identical to `videoFeedSourceEnum`'s labels. snake_case on the wire (§5.4). */
export const FEED_SOURCES = [
  "feed_recommended",
  "feed_explore",
  "feed_spotlight",
  "feed_filtered",
  "search",
  "channel",
  "direct",
] as const;

/** 12 hours — §3.3's bound, restated at the boundary so the service never sees worse. */
const MAXIMUM_VIDEO_SECONDS = 43_200;

/**
 * SECONDS ARRIVE AS FLOATS AND LEAVE AS INTEGERS.
 *
 * The YouTube IFrame API's `getCurrentTime()` returns a float, so `z.number().int()`
 * would 422 every honest beacon on the platform. Rule 2 bans floats in SCORING, not on
 * the wire — so the boundary PARSES rather than validates (CLAUDE.md §2.1): floor it
 * here, and every downstream clamp only ever sees integers.
 *
 * The bounds double as the NaN/Infinity guard — every one of those fails a comparison.
 */
const WatchSecondsSchema = z
  .number()
  .min(0)
  .max(MAXIMUM_VIDEO_SECONDS)
  .transform((seconds) => Math.floor(seconds));

export const RecordViewBeaconSchema = z
  .object({
    positionSeconds: WatchSecondsSchema,
    // Floored at 1 so it can never be a zero denominator. Pinned on the FIRST beacon
    // in the service; later disagreeing values are ignored, not rejected.
    reportedDurationSeconds: z
      .number()
      .min(1)
      .max(MAXIMUM_VIDEO_SECONDS)
      .transform((seconds) => Math.floor(seconds)),
    feedSource: z.enum(FEED_SOURCES),
  })
  .strict();

/**
 * The IFrame API's `onError` codes, as a CLOSED SET.
 *
 * Not `z.number().int()`: §8.2 acts only on 100/101/150, and an open integer column is
 * a column of client-chosen junk that the three-fingerprint rule would then be counting.
 */
export const ReportPlaybackErrorSchema = z
  .object({
    errorCode: z.union([
      z.literal(2),
      z.literal(5),
      z.literal(100),
      z.literal(101),
      z.literal(150),
    ]),
  })
  .strict();

/** Byte-identical to `videoShareChannelEnum`'s labels. */
export const RecordShareSchema = z
  .object({ channel: z.enum(["copy_link", "x", "whatsapp", "linkedin", "email"]) })
  .strict();

/**
 * `videoId` is ABSENT and that absence is the point: it comes from the path, never the
 * body. `.strict()` turns an attempt to send one into a 422.
 */
export const CreateCommentSchema = z
  .object({
    // 1..2000 mirrors the `video_comment_body_ck` CHECK.
    body: z.string().trim().min(1).max(2000),
    // ONE LEVEL OF THREADING. A reply-to-a-reply is a 409 from the service, not a
    // schema error — the schema cannot see the parent's own parent.
    parentCommentId: z.uuid().optional(),
  })
  .strict();

export const UpdateCommentSchema = z
  .object({ body: z.string().trim().min(1).max(2000) })
  .strict();

/**
 * NO `sort` PARAMETER. §8.4 states that `video.commentSortOrder` remains an unbacked
 * preference column — offering `?sort=top` would be implying it works, and a
 * like-count sort breaks the keyset cursor's stable key anyway.
 */
export const ListVideoCommentsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().trim().min(1).max(200).optional(),
    // Absent → the top-level thread, newest first. Present → that comment's replies,
    // oldest first.
    parentCommentId: z.uuid().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Viewer identity
// ---------------------------------------------------------------------------

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
} {
  const clientIp = req.ip;
  if (clientIp === undefined) {
    logger.warn("engagement: no client ip on request, fingerprint degraded", {
      requestId: req.requestId,
      path: req.originalUrl,
    });
  }

  const viewerUserId = req.user?.id ?? null;
  const utcDayString = utcDayStringOf(new Date());

  return {
    viewerUserId,
    utcDayString,
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

// ---------------------------------------------------------------------------
// Beacon and playback errors
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Likes, saves, shares
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

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
