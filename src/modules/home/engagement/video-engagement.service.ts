import { and, countDistinct, eq, inArray, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { db } from "#src/db/index.js";
import {
  creatorStats,
  userActivityHour,
  video,
  videoLike,
  videoPlaybackError,
  videoSave,
  videoShare,
  videoStats,
  videoViewSession,
} from "#src/db/schema.js";
import {
  applyViewBeacon,
  pinReportedDurationSeconds,
} from "#src/modules/home/view-beacon-clamp.js";
import { findPublicVideo } from "#src/modules/studio/public-video-gate.js";
import type { Result } from "#src/types/index.js";

/**
 * The viewer-side writes on a video — HOME_BACKEND_STRUCTURE.md §3.
 *
 * EVERY COUNTER IN HERE MOVES IN THE SAME TRANSACTION AS THE ROW THAT CAUSED IT, the
 * discipline `projectStats` established. A like that commits without its counter is a
 * like that disappears from the UI until a reconciler runs, and that reconciler is the
 * job we are trying not to need.
 */

export type VideoEngagementError = { readonly type: "VIDEO_NOT_FOUND"; readonly videoId: string };

/** `+ n`, as SQL, so two concurrent writers cannot read-modify-write over each other. */
function increment(column: AnyPgColumn, amount = 1): ReturnType<typeof sql> {
  return sql`${column} + ${amount}`;
}

/** Floors at zero, so a repeated delete cannot drive a counter negative. */
function decrement(column: AnyPgColumn): ReturnType<typeof sql> {
  return sql`GREATEST(${column} - 1, 0)`;
}

// ---------------------------------------------------------------------------
// The beacon
// ---------------------------------------------------------------------------

export interface ViewBeaconInput {
  readonly videoId: string;
  /** NULL for an anonymous viewer. THE §8.1 GATE — see where it is read below. */
  readonly viewerUserId: string | null;
  readonly viewerFingerprint: string;
  readonly viewDayBucket: string;
  /**
   * The UTC hour, 0..23, taken from the SAME instant as `viewDayBucket` — see
   * `readViewerIdentity`. Only reaches `user_activity_hour`, and only for a signed-in viewer.
   */
  readonly viewHourBucket: number;
  readonly feedSource: (typeof videoViewSession.$inferInsert)["feedSource"];
  readonly positionSeconds: number;
  readonly reportedDurationSeconds: number;
}

/**
 * `POST /videos/:videoId/view-beacon`.
 *
 * ## Why this is a locked read-modify-write and not one clever UPDATE
 *
 * The clamp is a TypeScript function (`view-beacon-clamp.ts`) and it must stay one:
 * inlining it into SQL would duplicate the platform's most security-sensitive
 * arithmetic into a second language with different integer-division and overflow rules,
 * and the two copies would drift. So the transaction has to fetch, compute in TS, then
 * write — and that sequence is only safe under a row lock. Two beacons from the same
 * session arriving together without `FOR UPDATE` both read the same `watchedSeconds`
 * and the second overwrites the first, silently losing watch time.
 *
 * ## Returns nothing the client can use as an oracle
 *
 * The controller answers 202 with no body. Echoing `watchedSeconds` or
 * `completionBasisPoints` back would hand an attacker a live readout for tuning
 * against the clamp, which is the single thing this whole path defends.
 */
export async function recordViewBeacon(
  input: ViewBeaconInput,
): Promise<Result<{ readonly accepted: true }, VideoEngagementError>> {
  const outcome = await db.transaction(async (tx) => {
    const publicVideo = await findPublicVideo(tx, input.videoId);
    if (publicVideo === null) return { kind: "missing" } as const;

    // Create-if-absent, then lock. `ON CONFLICT DO NOTHING` rather than a SELECT-then-
    // INSERT because two first beacons racing would both find nothing and both insert.
    await tx
      .insert(videoViewSession)
      .values({
        videoId: input.videoId,
        viewerId: input.viewerUserId,
        viewerFingerprint: input.viewerFingerprint,
        viewDayBucket: input.viewDayBucket,
        feedSource: input.feedSource,
        // Pinned here and NEVER rewritten. A later beacon disagreeing about the
        // duration is ignored, not rejected — that is what stops a client shrinking
        // its own denominator mid-session to manufacture a completion.
        pinnedDurationSeconds: pinReportedDurationSeconds(input.reportedDurationSeconds),
      })
      .onConflictDoNothing();

    const [session] = await tx
      .select({
        id: videoViewSession.id,
        viewerId: videoViewSession.viewerId,
        watchedSeconds: videoViewSession.watchedSeconds,
        maxPositionSeconds: videoViewSession.maxPositionSeconds,
        pinnedDurationSeconds: videoViewSession.pinnedDurationSeconds,
        completionBasisPoints: videoViewSession.completionBasisPoints,
        isCountedView: videoViewSession.isCountedView,
        lastBeaconAt: videoViewSession.lastBeaconAt,
      })
      .from(videoViewSession)
      .where(
        and(
          eq(videoViewSession.videoId, input.videoId),
          eq(videoViewSession.viewerFingerprint, input.viewerFingerprint),
          eq(videoViewSession.viewDayBucket, input.viewDayBucket),
        ),
      )
      .for("update");

    // Only reachable if the row was deleted between the insert and the select, which
    // means the video was deleted under us. Nothing to credit.
    if (!session) return { kind: "missing" } as const;

    // Floored at zero: a negative elapsed would mean the server's own clock went
    // backwards, and crediting negative time is not an improvement over crediting none.
    const elapsedSecondsSinceLastBeacon = Math.max(
      0,
      Math.floor((Date.now() - session.lastBeaconAt.getTime()) / 1000),
    );

    const clamped = applyViewBeacon(session, {
      positionSeconds: input.positionSeconds,
      elapsedSecondsSinceLastBeacon,
    });

    await tx
      .update(videoViewSession)
      .set({
        watchedSeconds: clamped.watchedSeconds,
        maxPositionSeconds: clamped.maxPositionSeconds,
        completionBasisPoints: clamped.completionBasisPoints,
        isCountedView: clamped.isCountedView,
        lastBeaconAt: sql`now()`,
      })
      .where(eq(videoViewSession.id, session.id));

    /**
     * §8.1 RULE 2, AND THIS LINE IS THE WHOLE OF IT.
     *
     * A session with no `viewerId` never contributes to `completion_bp_sum`. Anonymous
     * watch time still counts toward `view_count` — it is real traffic — but it cannot
     * move the component carrying 40 of ranking's 100 points. Farming the ranker
     * therefore costs real accounts rather than a headless browser loop.
     */
    const contributesToCompletion = session.viewerId !== null;

    // On the flip, the session contributes its first sample: one count, and its
    // completion so far. On every beacon after that, only the DELTA is added — so the
    // stored sum tracks each session's FINAL completion rather than the mean of every
    // heartbeat it happened to send.
    const completionSumDelta = !contributesToCompletion
      ? 0
      : clamped.didBecomeCountedView
        ? clamped.completionBasisPoints
        : clamped.isCountedView
          ? clamped.completionBasisPointsDelta
          : 0;
    const completionSampleDelta = contributesToCompletion && clamped.didBecomeCountedView ? 1 : 0;

    await tx
      .update(videoStats)
      .set({
        totalWatchedSeconds: increment(videoStats.totalWatchedSeconds, clamped.creditedSeconds),
        // Rule 4: a view is not a watch. This moves ONCE per session, on the flip.
        viewCount: clamped.didBecomeCountedView
          ? increment(videoStats.viewCount)
          : videoStats.viewCount,
        completionBasisPointsSum: increment(
          videoStats.completionBasisPointsSum,
          completionSumDelta,
        ),
        completionSampleCount: increment(videoStats.completionSampleCount, completionSampleDelta),
        lastEngagementAt: sql`now()`,
      })
      .where(eq(videoStats.videoId, input.videoId));

    if (clamped.didBecomeCountedView) {
      await tx
        .update(creatorStats)
        .set({ totalViewCount: increment(creatorStats.totalViewCount) })
        .where(eq(creatorStats.userId, publicVideo.creatorId));
    }

    /**
     * §3.3a — THE HOUR COUNTER, and the only durable per-user record of watching this platform
     * keeps. Everything above it is per-VIDEO; `video_view_session` is per-viewer but dies at 90
     * days and carries no hour.
     *
     * `contributesToCompletion` IS THE GATE, reused deliberately rather than re-derived. It is
     * `viewerId !== null`, so an anonymous beacon writes nothing here — a fingerprint is a per-day
     * bucket key over an IP and a user agent, and an hour-by-hour profile keyed on one describes a
     * coffee shop rather than a person. Reusing the same expression means the two questions "does
     * this move the ranker" and "does this become a behavioural record" can never drift apart.
     *
     * `creditedSeconds`, NOT `positionSeconds`. The clamp caps each beacon at
     * `min(elapsed + 5, 20)`; writing the raw position would let a client claim a year.
     *
     * Zero-credit beacons still land, and that is the point of `beacon_count` — a tab left open on
     * a paused video sends heartbeats that credit nothing, and the pair of columns is what
     * separates that from attention.
     */
    if (contributesToCompletion && session.viewerId !== null) {
      await tx
        .insert(userActivityHour)
        .values({
          userId: session.viewerId,
          activityDate: input.viewDayBucket,
          activityHour: input.viewHourBucket,
          watchedSeconds: clamped.creditedSeconds,
          beaconCount: 1,
        })
        .onConflictDoUpdate({
          target: [
            userActivityHour.userId,
            userActivityHour.activityDate,
            userActivityHour.activityHour,
          ],
          set: {
            watchedSeconds: increment(userActivityHour.watchedSeconds, clamped.creditedSeconds),
            beaconCount: increment(userActivityHour.beaconCount),
          },
        });
    }

    return { kind: "accepted" } as const;
  });

  if (outcome.kind === "missing") {
    return { success: false, error: { type: "VIDEO_NOT_FOUND", videoId: input.videoId } };
  }
  return { success: true, value: { accepted: true } };
}

// ---------------------------------------------------------------------------
// Playback errors — the §8.2 fast dead-player path
// ---------------------------------------------------------------------------

/**
 * The IFrame API codes that mean the video cannot be played HERE, ever: 101 and 150 are
 * "embedding disallowed", 100 is "not found or private". 2 and 5 are accepted by the
 * schema for diagnostics but must never flip a row — 2 is a malformed parameter (our
 * bug) and 5 is an HTML5 player fault (the viewer's browser).
 */
const EMBED_FATAL_ERROR_CODES = [100, 101, 150] as const;

/** Three reporters, because one client's error report is one client's claim. */
const DEAD_PLAYER_REPORTER_THRESHOLD = 3;

export async function recordPlaybackError(input: {
  readonly videoId: string;
  readonly viewerFingerprint: string;
  readonly reportDayBucket: string;
  readonly errorCode: number;
}): Promise<Result<{ readonly accepted: true }, VideoEngagementError>> {
  const outcome = await db.transaction(async (tx) => {
    const publicVideo = await findPublicVideo(tx, input.videoId);
    if (publicVideo === null) return { kind: "missing" } as const;

    const inserted = await tx
      .insert(videoPlaybackError)
      .values({
        videoId: input.videoId,
        viewerFingerprint: input.viewerFingerprint,
        reportDayBucket: input.reportDayBucket,
        errorCode: input.errorCode,
      })
      .onConflictDoNothing()
      .returning({ id: videoPlaybackError.id });

    const isNewReport = inserted.length > 0;
    const isEmbedFatal = (EMBED_FATAL_ERROR_CODES as readonly number[]).includes(input.errorCode);

    if (isNewReport && isEmbedFatal) {
      const [reporters] = await tx
        .select({ distinctReporterCount: countDistinct(videoPlaybackError.viewerFingerprint) })
        .from(videoPlaybackError)
        .where(
          and(
            eq(videoPlaybackError.videoId, input.videoId),
            inArray(videoPlaybackError.errorCode, [...EMBED_FATAL_ERROR_CODES]),
          ),
        );

      if ((reporters?.distinctReporterCount ?? 0) >= DEAD_PLAYER_REPORTER_THRESHOLD) {
        // The `upload_status = 'ready'` guard makes the flip idempotent AND stops it
        // resurrecting a row an operator has since fixed by hand.
        await tx
          .update(video)
          .set({ uploadStatus: "failed" })
          .where(and(eq(video.id, input.videoId), eq(video.uploadStatus, "ready")));
      }
    }

    return { kind: "accepted" } as const;
  });

  if (outcome.kind === "missing") {
    return { success: false, error: { type: "VIDEO_NOT_FOUND", videoId: input.videoId } };
  }
  return { success: true, value: { accepted: true } };
}

// ---------------------------------------------------------------------------
// Likes and saves
// ---------------------------------------------------------------------------

export interface ToggleOutcome {
  readonly isSet: boolean;
  readonly count: number;
}

/**
 * `PUT`/`DELETE /videos/:videoId/like` and `.../save`.
 *
 * IDEMPOTENT BY VERB. The unique key on `(videoId, userId)` is the mechanism, which is
 * why these are PUT and DELETE rather than POST and carry no idempotency key: a
 * double-tap on a slow connection must be harmless, not a second like.
 *
 * The counter moves ONLY when a row was actually inserted or deleted. Incrementing on a
 * swallowed duplicate is exactly how a double-tap inflates a like count.
 *
 * Both verbs return the resulting count so a 24-card grid renders the server's number
 * instead of guessing at one — the same reason `viewerState` is embedded in the feed.
 */
export async function setVideoLike(input: {
  readonly videoId: string;
  readonly userId: string;
  readonly shouldBeSet: boolean;
}): Promise<Result<ToggleOutcome, VideoEngagementError>> {
  const outcome = await db.transaction(async (tx) => {
    const publicVideo = await findPublicVideo(tx, input.videoId);
    if (publicVideo === null) return { kind: "missing" } as const;

    const affectedRows = input.shouldBeSet
      ? await tx
          .insert(videoLike)
          .values({ videoId: input.videoId, userId: input.userId })
          .onConflictDoNothing()
          .returning({ videoId: videoLike.videoId })
      : await tx
          .delete(videoLike)
          .where(and(eq(videoLike.videoId, input.videoId), eq(videoLike.userId, input.userId)))
          .returning({ videoId: videoLike.videoId });

    if (affectedRows.length === 0) {
      // The end state the caller asked for was already true. The count must stay put.
      const [stats] = await tx
        .select({ likeCount: videoStats.likeCount })
        .from(videoStats)
        .where(eq(videoStats.videoId, input.videoId));
      return { kind: "toggled", count: stats?.likeCount ?? 0 } as const;
    }

    const [stats] = await tx
      .update(videoStats)
      .set({
        likeCount: input.shouldBeSet
          ? increment(videoStats.likeCount)
          : decrement(videoStats.likeCount),
        lastEngagementAt: sql`now()`,
      })
      .where(eq(videoStats.videoId, input.videoId))
      .returning({ likeCount: videoStats.likeCount });

    return { kind: "toggled", count: stats?.likeCount ?? 0 } as const;
  });

  if (outcome.kind === "missing") {
    return { success: false, error: { type: "VIDEO_NOT_FOUND", videoId: input.videoId } };
  }
  return { success: true, value: { isSet: input.shouldBeSet, count: outcome.count } };
}

/** Watch-later. Byte-for-byte the like toggle, against a different table and counter. */
export async function setVideoSave(input: {
  readonly videoId: string;
  readonly userId: string;
  readonly shouldBeSet: boolean;
}): Promise<Result<ToggleOutcome, VideoEngagementError>> {
  const outcome = await db.transaction(async (tx) => {
    const publicVideo = await findPublicVideo(tx, input.videoId);
    if (publicVideo === null) return { kind: "missing" } as const;

    const affectedRows = input.shouldBeSet
      ? await tx
          .insert(videoSave)
          .values({ videoId: input.videoId, userId: input.userId })
          .onConflictDoNothing()
          .returning({ videoId: videoSave.videoId })
      : await tx
          .delete(videoSave)
          .where(and(eq(videoSave.videoId, input.videoId), eq(videoSave.userId, input.userId)))
          .returning({ videoId: videoSave.videoId });

    if (affectedRows.length === 0) {
      const [stats] = await tx
        .select({ saveCount: videoStats.saveCount })
        .from(videoStats)
        .where(eq(videoStats.videoId, input.videoId));
      return { kind: "toggled", count: stats?.saveCount ?? 0 } as const;
    }

    const [stats] = await tx
      .update(videoStats)
      .set({
        saveCount: input.shouldBeSet
          ? increment(videoStats.saveCount)
          : decrement(videoStats.saveCount),
        lastEngagementAt: sql`now()`,
      })
      .where(eq(videoStats.videoId, input.videoId))
      .returning({ saveCount: videoStats.saveCount });

    return { kind: "toggled", count: stats?.saveCount ?? 0 } as const;
  });

  if (outcome.kind === "missing") {
    return { success: false, error: { type: "VIDEO_NOT_FOUND", videoId: input.videoId } };
  }
  return { success: true, value: { isSet: input.shouldBeSet, count: outcome.count } };
}

// ---------------------------------------------------------------------------
// Shares
// ---------------------------------------------------------------------------

/**
 * `POST /videos/:videoId/share`.
 *
 * ## The counter is gated on a signed-in sharer, and that is not an oversight
 *
 * §5.2 makes this route optional-auth, because a logged-out "copy link" is a real
 * share and worth recording. But `share_count` feeds §4.1's engagement rate, so an
 * anonymous caller who could move it could push a ranking input with no accountability
 * whatsoever — the exact hole §8.1 rule 2 closes for completion.
 *
 * So: the row is always written (it is real traffic, and it is analytics), and the
 * counter moves only when there is a real account behind it. DO NOT "FIX" THIS.
 *
 * ## No idempotency key, again by design
 *
 * The unique key on `(videoId, sharerFingerprint, channel, shareDayBucket)` makes a
 * repeat call a no-op for the day. The `idempotency()` middleware could not have done
 * this job: it no-ops without a session, and this is one of the routes an anonymous
 * caller can reach.
 */
export async function recordShare(input: {
  readonly videoId: string;
  readonly userId: string | null;
  readonly sharerFingerprint: string;
  readonly shareDayBucket: string;
  readonly channel: (typeof videoShare.$inferInsert)["channel"];
}): Promise<Result<{ readonly shareCount: number }, VideoEngagementError>> {
  const outcome = await db.transaction(async (tx) => {
    const publicVideo = await findPublicVideo(tx, input.videoId);
    if (publicVideo === null) return { kind: "missing" } as const;

    const inserted = await tx
      .insert(videoShare)
      .values({
        videoId: input.videoId,
        userId: input.userId,
        sharerFingerprint: input.sharerFingerprint,
        shareDayBucket: input.shareDayBucket,
        channel: input.channel,
      })
      .onConflictDoNothing()
      .returning({ id: videoShare.id });

    const shouldMoveCounter = inserted.length > 0 && input.userId !== null;

    const [stats] = shouldMoveCounter
      ? await tx
          .update(videoStats)
          .set({
            shareCount: increment(videoStats.shareCount),
            lastEngagementAt: sql`now()`,
          })
          .where(eq(videoStats.videoId, input.videoId))
          .returning({ shareCount: videoStats.shareCount })
      : await tx
          .select({ shareCount: videoStats.shareCount })
          .from(videoStats)
          .where(eq(videoStats.videoId, input.videoId));

    return { kind: "recorded", shareCount: stats?.shareCount ?? 0 } as const;
  });

  if (outcome.kind === "missing") {
    return { success: false, error: { type: "VIDEO_NOT_FOUND", videoId: input.videoId } };
  }
  return { success: true, value: { shareCount: outcome.shareCount } };
}

// ---------------------------------------------------------------------------
// Stats row provenance
// ---------------------------------------------------------------------------

/**
 * Mints the two sidecar rows a video needs before anything can be counted against it.
 *
 * Called from inside `createVideo`'s transaction. `video_stats` has exactly one row per
 * video and could not exist earlier; `creator_stats` is `ON CONFLICT DO NOTHING`
 * because `user` rows are minted by Better Auth inside a transaction this code cannot
 * hook, so there is no single place that owns creating it.
 *
 * Every engagement counter update is an UPDATE. A missing row here does not error — it
 * affects zero rows, and the count is silently lost. That is why this is not lazy.
 */
export async function ensureVideoStatsRows(
  executor: Pick<typeof db, "insert">,
  input: { readonly videoId: string; readonly creatorId: string },
): Promise<void> {
  await executor.insert(videoStats).values({ videoId: input.videoId }).onConflictDoNothing();
  await executor.insert(creatorStats).values({ userId: input.creatorId }).onConflictDoNothing();
}
