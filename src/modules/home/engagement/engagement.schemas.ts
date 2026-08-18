/**
 * Request schemas for engagement, extracted from engagement.controller.ts.
 *
 * WHY THESE ARE NOT IN THE CONTROLLER. They were the larger half of it — the handlers
 * did not begin until the file was already hundreds of lines deep — and they have a
 * second consumer that a controller cannot serve: `src/docs/openapi-rnd-bodies.ts`
 * generates request bodies from these schemas, and importing a controller to reach one
 * drags in its whole service and db graph.
 *
 * NOTHING ABOUT THE PARSE BOUNDARY MOVED. The controller imports these and every handler
 * still runs `safeParse` before any service call, returning 422 on failure
 * (CLAUDE.md §3.1). Types come from `z.infer` here, so a service takes its input type
 * from the schema rather than importing it back out of a controller.
 */
import { z } from "zod";

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
export const MAXIMUM_VIDEO_SECONDS = 43_200;

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
export const WatchSecondsSchema = z
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

export const UpdateCommentSchema = z.object({ body: z.string().trim().min(1).max(2000) }).strict();

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

/**
 * The viewer's own watch time — `GET /users/me/watch-time`. One optional field, and it decides
 * only where a day starts.
 *
 * IT LIVES HERE, ON THE HOME SIDE, AND THAT IS THE POINT. It began in
 * `platform/metrics/metrics.schemas.ts` beside the five `/admin/metrics/*` query schemas, which
 * put the SIGNED-IN VIEWER's own read behind an import from the platform-admin module — and,
 * through that file's `USER_SEGMENTS` import, transitively behind `platform-metrics.service.ts`
 * and its db graph. A viewer asking how long they have watched must not depend on the module that
 * answers "who watches the most" about other people. The two reads share a subject and share
 * nothing else.
 *
 * VALIDATED AGAINST THE RUNTIME'S OWN ZONE TABLE rather than a regex or a hand-kept list. An
 * unknown zone reaching Postgres raises inside the query, which would surface as a 500 for what is
 * really a bad request — and a hand-kept list goes stale every time the IANA database changes.
 *
 * TRUSTED FOR NOTHING ELSE. The zone decides display bucketing only; every stored column these
 * reads touch is UTC, and no authorization or retention decision consults it.
 */
export const WatchTimeQuerySchema = z
  .object({
    timeZone: z
      .string()
      .min(1)
      .max(64)
      .refine(isSupportedTimeZone, "Not a recognised IANA time zone.")
      .default("UTC"),
  })
  .strict();

function isSupportedTimeZone(candidate: string): boolean {
  try {
    // Constructing the formatter is the check: an unknown zone throws a RangeError here, which is
    // exactly the answer we want, one layer before it reaches SQL. The instance is discarded, and
    // it is assigned only so the construction does not read as a bare side effect.
    const zoneProbe = new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    return zoneProbe.resolvedOptions().timeZone.length > 0;
  } catch {
    return false;
  }
}
