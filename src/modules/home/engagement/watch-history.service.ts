import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { videoViewSession } from "#src/db/schema.js";

/**
 * A viewer editing their own watch history — the read half is `GET /feed/videos?mode=watched`.
 *
 * ## Every write here is a STAMP, never a DELETE, and that is a view-count exploit
 *
 * `video_view_session_unq (video_id, viewer_fingerprint, view_day_bucket)` IS the
 * anti-replay mechanism for view counting: the beacon inserts with
 * `onConflictDoNothing`, so one viewer gets at most one countable session per video per
 * UTC day. `video_stats.view_count` is an incremental counter bumped once when
 * `is_counted_view` flips, and `prune-engagement-data.ts` states outright that the
 * increment cannot be walked back.
 *
 * Delete a row on user request and that loop reopens:
 *
 *   remove from history → re-watch the same video the same day → the unique key no
 *   longer collides → a fresh row inserts → `is_counted_view` flips again →
 *   `view_count` increments again → remove again.
 *
 * The beacon limiters bound how fast that runs; they do not stop it. Stamping
 * `hidden_from_history_at` instead leaves the unique key, the counters and the 90-day
 * prune untouched, and a re-watch simply makes the row visible again — which is the
 * behaviour a viewer expects from "remove from history" anyway.
 *
 * ## No error union
 *
 * None of these can fail in a way the caller can act on. An unknown or unwatched
 * `videoId` matches zero rows, which is the state the caller asked for — answering 404
 * would also confirm to any signed-in caller whether a given uuid is a real video, which
 * §5.4's status policy exists to prevent. So they return a count and nothing else.
 *
 * ## Ownership is not checked, it is SCOPED
 *
 * `viewer_id = ${viewerUserId}` is in the WHERE clause of every statement, and
 * `viewerUserId` comes from `req.user.id`. There is no path by which a caller names
 * whose history to edit, so there is no ownership check to forget.
 */

/** The rows this write touched. `0` is a success, not a miss — see the header. */
export interface WatchHistoryWriteResult {
  readonly affectedSessionCount: number;
}

/**
 * Hide every session this viewer has for one video.
 *
 * ALL DAY BUCKETS, not one. A video watched across three UTC days is three rows and one
 * card in the history list; hiding one row would leave the card in place with an older
 * timestamp, which reads as "remove did nothing, and also moved it".
 *
 * `now()` rather than a JS timestamp: the column's only consumer is an `IS NULL` test,
 * and letting the database stamp it keeps this consistent with `lastBeaconAt`.
 */
export async function hideVideoFromWatchHistory(
  viewerUserId: string,
  videoId: string,
): Promise<WatchHistoryWriteResult> {
  const hidden = await db
    .update(videoViewSession)
    .set({ hiddenFromHistoryAt: sql`now()` })
    .where(
      and(
        eq(videoViewSession.viewerId, viewerUserId),
        eq(videoViewSession.videoId, videoId),
        // Already-hidden rows are skipped so a repeated DELETE does not keep moving the
        // timestamp forward, and so the returned count means "rows this call changed".
        isNull(videoViewSession.hiddenFromHistoryAt),
      ),
    )
    .returning({ id: videoViewSession.id });

  return { affectedSessionCount: hidden.length };
}

/**
 * Undo — put one video's sessions back into the viewer's history.
 *
 * Restores ONLY rows this viewer hid, and cannot resurrect anything the 90-day prune has
 * already deleted. A hide followed by a restore is therefore not always a round trip,
 * and the client must re-read rather than assume the card returns.
 */
export async function restoreVideoToWatchHistory(
  viewerUserId: string,
  videoId: string,
): Promise<WatchHistoryWriteResult> {
  const restored = await db
    .update(videoViewSession)
    .set({ hiddenFromHistoryAt: null })
    .where(
      and(
        eq(videoViewSession.viewerId, viewerUserId),
        eq(videoViewSession.videoId, videoId),
        isNotNull(videoViewSession.hiddenFromHistoryAt),
      ),
    )
    .returning({ id: videoViewSession.id });

  return { affectedSessionCount: restored.length };
}

/**
 * Clear the whole history for one viewer.
 *
 * One statement, no batching. The row set is bounded by the 90-day prune and by one
 * person's watching, so this is thousands of rows at the very worst — not a table scan
 * that needs a job.
 *
 * NOT REVERSIBLE, deliberately: there is no per-call marker to undo by, and a "restore
 * everything hidden" would also resurrect every individual card the viewer had removed
 * on purpose over the previous three months. The confirmation step in the UI is what
 * stands in for undo here, which is the same trade YouTube makes.
 */
export async function clearWatchHistory(viewerUserId: string): Promise<WatchHistoryWriteResult> {
  const cleared = await db
    .update(videoViewSession)
    .set({ hiddenFromHistoryAt: sql`now()` })
    .where(
      and(
        eq(videoViewSession.viewerId, viewerUserId),
        isNull(videoViewSession.hiddenFromHistoryAt),
      ),
    )
    .returning({ id: videoViewSession.id });

  return { affectedSessionCount: cleared.length };
}
