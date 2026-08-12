import { eq, isNotNull, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { trendingVideoSnapshot, videoStats } from "#src/db/schema.js";
import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import { logger } from "#src/lib/logger.js";
import { compareUtf8Bytes } from "#src/lib/ordering.js";
import { utcTimestamp } from "#src/lib/sql-time.js";
import {
  computeTrendingScorePoints,
  TRENDING_SNAPSHOT_SIZE,
  TRENDING_WINDOW_HOURS,
} from "#src/modules/studio/trending-score.js";

/**
 * §6 — the hourly trending list. `?mode=trending&limit=3` is Spotlight.
 *
 * ## Why the ranking is done in TypeScript here, unlike the feed
 *
 * The feed ranks in SQL because it is offset-paginated per viewer and cannot afford to
 * fetch what it does not return. This job ranks 200 rows out of the whole catalog, once an
 * hour, with no viewer involved — so the scoring can stay in a pure module where it is
 * unit-tested, and the ordering can use `compareUtf8Bytes` for a TOTAL order.
 *
 * That totality matters more than it looks: `trending_video_snapshot` has a
 * `unique(as_of, rank)` index, so two rows tied on every key would not merely rank
 * arbitrarily — they would collide and fail the insert. The final tiebreak on `videoId` is
 * what makes `rank = index + 1` a well-defined function.
 *
 * ## `videoStats.trendingRank` is rewritten wholesale
 *
 * Clear every rank, then set the new ones. There is exactly one live trending list at a
 * time, so unlike the quality score this needs no monotonic guard — but it does need the
 * clear, or a video that dropped out of the top 200 would keep last hour's rank forever
 * and stay in `?mode=trending` indefinitely.
 */

type TrendingInputRow = {
  readonly video_id: string;
  readonly counted_views_in_window: number;
  readonly watched_minutes_in_window: number;
  readonly engagement_actions_in_window: number;
  readonly quality_score_points: number | null;
};

export async function handleRecomputeTrendingVideos(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.recomputeTrendingVideos,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.recomputeTrendingVideos],
    rawPayload,
  );
  const asOf = new Date(payload.asOf);
  const windowStartsAt = new Date(asOf.getTime() - TRENDING_WINDOW_HOURS * 60 * 60 * 1_000);

  // The candidate set is the §4.5 pool minus the per-viewer terms — a video that cannot be
  // served must not be able to trend. The five status literals are spelled out to match
  // `video_feed_candidate_idx`'s predicate exactly, so the planner can prove the partial
  // index applies.
  const inputRows = await db.execute<TrendingInputRow>(sql`
    SELECT
      v.id AS video_id,
      COALESCE(w.counted_views, 0)::int      AS counted_views_in_window,
      COALESCE(w.watched_minutes, 0)::int    AS watched_minutes_in_window,
      (
        (SELECT count(*)::int FROM video_like AS l
          WHERE l.video_id = v.id AND l.created_at >= ${utcTimestamp(windowStartsAt)} AND l.created_at < ${utcTimestamp(asOf)})
        + (SELECT count(*)::int FROM video_save AS sv
          WHERE sv.video_id = v.id AND sv.created_at >= ${utcTimestamp(windowStartsAt)} AND sv.created_at < ${utcTimestamp(asOf)})
        + (SELECT count(*)::int FROM video_share AS sh
          WHERE sh.video_id = v.id AND sh.created_at >= ${utcTimestamp(windowStartsAt)} AND sh.created_at < ${utcTimestamp(asOf)})
        + (SELECT count(*)::int FROM video_comment AS c
          WHERE c.video_id = v.id AND c.is_deleted = false
            AND c.created_at >= ${utcTimestamp(windowStartsAt)} AND c.created_at < ${utcTimestamp(asOf)})
      ) AS engagement_actions_in_window,
      vs.quality_score_points
    FROM video AS v
    LEFT JOIN video_stats AS vs ON vs.video_id = v.id
    LEFT JOIN (
      SELECT
        s.video_id,
        count(*) FILTER (WHERE s.is_counted_view) AS counted_views,
        -- Integer division, once, here: the ladder is denominated in minutes and a float
        -- must never reach a scoring module.
        FLOOR(SUM(s.watched_seconds) / 60.0)      AS watched_minutes
      FROM video_view_session AS s
      WHERE s.last_beacon_at >= ${utcTimestamp(windowStartsAt)} AND s.last_beacon_at < ${utcTimestamp(asOf)}
      GROUP BY s.video_id
    ) AS w ON w.video_id = v.id
    WHERE v.publish_status = 'published'
      AND v.visibility = 'public'
      AND v.upload_status = 'ready'
      AND v.is_source_verified = true
      AND v.review_status IN ('not_required', 'approved')
      AND v.published_at IS NOT NULL
      AND v.published_at < ${utcTimestamp(asOf)}
    ORDER BY v.id
  `);

  const scored = inputRows.rows
    .map((row) => ({
      videoId: row.video_id,
      inputs: row,
      breakdown: computeTrendingScorePoints({
        countedViewsInWindow: row.counted_views_in_window,
        watchedMinutesInWindow: row.watched_minutes_in_window,
        engagementActionsInWindow: row.engagement_actions_in_window,
        qualityScorePoints: row.quality_score_points,
      }),
    }))
    // A video with no activity at all in the window is not trending. Excluding it keeps
    // the top 200 meaningful on a small catalog instead of padding it with silence.
    .filter((entry) => entry.breakdown.totalPoints > 0);

  // TOTAL order, ending in a unique column. Without the final tiebreak two tied videos
  // would collide on `unique(as_of, rank)` and fail the insert.
  const ranked = scored
    .toSorted((left, right) => {
      if (left.breakdown.totalPoints !== right.breakdown.totalPoints) {
        return right.breakdown.totalPoints - left.breakdown.totalPoints;
      }
      if (left.inputs.counted_views_in_window !== right.inputs.counted_views_in_window) {
        return right.inputs.counted_views_in_window - left.inputs.counted_views_in_window;
      }
      return compareUtf8Bytes(left.videoId, right.videoId);
    })
    .slice(0, TRENDING_SNAPSHOT_SIZE);

  await db.transaction(async (tx) => {
    if (ranked.length > 0) {
      await tx
        .insert(trendingVideoSnapshot)
        .values(
          ranked.map((entry, rankIndex) => ({
            videoId: entry.videoId,
            asOf,
            rank: rankIndex + 1,
            trendingScorePoints: entry.breakdown.totalPoints,
            countedViewsInWindow: entry.inputs.counted_views_in_window,
            watchedMinutesInWindow: entry.inputs.watched_minutes_in_window,
            engagementActionsInWindow: entry.inputs.engagement_actions_in_window,
            qualityScorePoints: entry.inputs.quality_score_points,
            recentViewComponentPoints: entry.breakdown.recentViewComponentPoints,
            recentWatchTimeComponentPoints: entry.breakdown.recentWatchTimeComponentPoints,
            recentEngagementComponentPoints: entry.breakdown.recentEngagementComponentPoints,
            qualityComponentPoints: entry.breakdown.qualityComponentPoints,
          })),
        )
        .onConflictDoNothing({
          target: [trendingVideoSnapshot.asOf, trendingVideoSnapshot.videoId],
        });
    }

    // Clear first, then set. A video that fell out of the list must lose its rank, or
    // `?mode=trending` serves last hour's answer forever.
    await tx
      .update(videoStats)
      .set({ trendingRank: null })
      .where(isNotNull(videoStats.trendingRank));

    for (const [rankIndex, entry] of ranked.entries()) {
      await tx
        .update(videoStats)
        .set({ trendingRank: rankIndex + 1 })
        .where(eq(videoStats.videoId, entry.videoId));
    }
  });

  logger.info("recompute-trending-videos: complete", {
    asOf: payload.asOf,
    windowStartsAt: windowStartsAt.toISOString(),
    candidateCount: inputRows.rows.length,
    rankedCount: ranked.length,
  });
}

// NOTHING ELSE IS EXPORTED. The feed reads `video_stats.trending_rank` directly — a
// helper here would be a second place the "what is trending" question is answered, and
// the two would drift the first time one of them learned about a filter.
