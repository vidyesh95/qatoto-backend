import { and, eq, isNull, lt, or, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { videoQualityScoreSnapshot, videoStats } from "#src/db/schema.js";
import { computeVideoQualityPoints } from "#src/lib/feed-score.js";
import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import { logger } from "#src/lib/logger.js";

/**
 * §4.1 — one quality score per published video, nightly.
 *
 * Runs AFTER `recompute-video-durations` (01:05 vs 01:25), because completion has no
 * denominator until that job has written one.
 *
 * ## Determinism, and the one trap in this job
 *
 * `creatorTrack` is "the creator's median quality across their published videos". The
 * obvious implementation reads `video_stats.quality_score_points` — the column THIS JOB IS
 * WRITING. That makes every score depend on how far through the catalog the loop had got,
 * so two runs over identical data disagree and §10's "run it twice and diff" check fails
 * for a reason that has nothing to do with the data.
 *
 * So the creator median is read from the most recent snapshot STRICTLY BEFORE `asOf`, in
 * one query, up front. A creator's track record is what it was yesterday — which is also
 * the more honest reading of the phrase.
 *
 * ## It also writes `unique_viewer_count`
 *
 * Phase 2 left that column nullable-with-no-default precisely because no transaction can
 * maintain a distinct count. It is the denominator of the engagement component, so it has
 * to be established before the score that divides by it — same query, same pass.
 */

/** §4.1's velocity window. */
const VIEW_VELOCITY_WINDOW_HOURS = 48;

type QualityInputRow = {
  readonly video_id: string;
  readonly creator_id: string;
  readonly completion_bp_sum: number;
  readonly completion_sample_count: number;
  readonly like_count: number;
  readonly comment_count: number;
  readonly share_count: number;
  readonly save_count: number;
  readonly unique_viewer_count: number;
  readonly counted_views_first_48_hours: number;
  readonly hours_since_published: number;
};

type CreatorMedianRow = {
  readonly creator_id: string;
  readonly median_quality_points: number;
};

export async function handleRecomputeVideoQualityScores(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.recomputeVideoQualityScores,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.recomputeVideoQualityScores],
    rawPayload,
  );
  const asOf = new Date(payload.asOf);

  // Yesterday's medians, per creator. Read BEFORE anything is written, so the loop below
  // cannot influence its own inputs.
  const creatorMedians = await db.execute<CreatorMedianRow>(sql`
    SELECT
      v.creator_id,
      percentile_disc(0.5) WITHIN GROUP (ORDER BY latest.quality_score_points)::int
        AS median_quality_points
    FROM (
      SELECT DISTINCT ON (s.video_id) s.video_id, s.quality_score_points
      FROM video_quality_score_snapshot AS s
      WHERE s.as_of < ${asOf}
      ORDER BY s.video_id, s.as_of DESC
    ) AS latest
    JOIN video AS v ON v.id = latest.video_id
    WHERE v.publish_status = 'published'
    GROUP BY v.creator_id
  `);

  const medianQualityByCreator = new Map(
    creatorMedians.rows.map((row) => [row.creator_id, row.median_quality_points]),
  );

  // Every input, in one pass, bounded by asOf and ordered by a unique column so a partial
  // failure re-runs in the same order.
  const inputRows = await db.execute<QualityInputRow>(sql`
    SELECT
      v.id AS video_id,
      v.creator_id,
      COALESCE(vs.completion_bp_sum, 0)::int      AS completion_bp_sum,
      COALESCE(vs.completion_sample_count, 0)::int AS completion_sample_count,
      COALESCE(vs.like_count, 0)::int             AS like_count,
      COALESCE(vs.comment_count, 0)::int          AS comment_count,
      COALESCE(vs.share_count, 0)::int            AS share_count,
      COALESCE(vs.save_count, 0)::int             AS save_count,
      (
        SELECT count(DISTINCT s.viewer_fingerprint)::int
        FROM video_view_session AS s
        WHERE s.video_id = v.id AND s.first_beacon_at < ${asOf}
      ) AS unique_viewer_count,
      (
        SELECT count(*)::int
        FROM video_view_session AS s
        WHERE s.video_id = v.id
          AND s.is_counted_view
          AND s.first_beacon_at < ${asOf}
          AND s.first_beacon_at < v.published_at + make_interval(hours => ${VIEW_VELOCITY_WINDOW_HOURS})
      ) AS counted_views_first_48_hours,
      GREATEST(
        FLOOR(EXTRACT(EPOCH FROM (${asOf}::timestamp - v.published_at)) / 3600)::int,
        0
      ) AS hours_since_published
    FROM video AS v
    LEFT JOIN video_stats AS vs ON vs.video_id = v.id
    WHERE v.publish_status = 'published'
      AND v.published_at IS NOT NULL
      AND v.published_at < ${asOf}
    ORDER BY v.id
  `);

  const failures: string[] = [];
  let scoredCount = 0;

  for (const row of inputRows.rows) {
    try {
      const breakdown = computeVideoQualityPoints({
        completionBasisPointsSum: row.completion_bp_sum,
        completionSampleCount: row.completion_sample_count,
        likeCount: row.like_count,
        commentCount: row.comment_count,
        shareCount: row.share_count,
        saveCount: row.save_count,
        // Rule 5: a video nobody has watched has no unique viewers, and 0 here means the
        // engagement component scores 0 rather than dividing by a number we invented.
        uniqueViewerCount: row.unique_viewer_count === 0 ? null : row.unique_viewer_count,
        countedViewsFirst48Hours: row.counted_views_first_48_hours,
        creatorMedianQualityPoints: medianQualityByCreator.get(row.creator_id) ?? null,
        hoursSincePublished: row.hours_since_published,
      });

      await db.transaction(async (tx) => {
        await tx
          .insert(videoQualityScoreSnapshot)
          .values({
            videoId: row.video_id,
            asOf,
            qualityScorePoints: breakdown.totalPoints,
            meanCompletionBasisPoints: breakdown.meanCompletionBasisPoints,
            completionSampleCount: row.completion_sample_count,
            engagementPerThousandViewers: breakdown.engagementPerThousandViewers,
            uniqueViewerCount: row.unique_viewer_count === 0 ? null : row.unique_viewer_count,
            countedViewsFirst48Hours: row.counted_views_first_48_hours,
            creatorMedianQualityPoints: medianQualityByCreator.get(row.creator_id) ?? null,
            hoursSincePublished: row.hours_since_published,
            completionComponentPoints: breakdown.completionComponentPoints,
            engagementComponentPoints: breakdown.engagementComponentPoints,
            velocityComponentPoints: breakdown.velocityComponentPoints,
            creatorTrackComponentPoints: breakdown.creatorTrackComponentPoints,
            freshnessComponentPoints: breakdown.freshnessComponentPoints,
          })
          // Re-running the same asOf is a NO-OP, not a duplicate row and not an
          // overwrite. The snapshot is a record of what was true when it was taken.
          .onConflictDoNothing({
            target: [videoQualityScoreSnapshot.videoId, videoQualityScoreSnapshot.asOf],
          });

        await tx
          .update(videoStats)
          .set({
            qualityScorePoints: breakdown.totalPoints,
            qualityScoreComputedAt: asOf,
            uniqueViewerCount: row.unique_viewer_count,
          })
          .where(
            and(
              eq(videoStats.videoId, row.video_id),
              // THE MONOTONIC GUARD. Without it, an operator replaying last month's asOf
              // for an audit silently clobbers today's published scores — a destructive
              // side effect of a read-only-looking investigation.
              or(
                isNull(videoStats.qualityScoreComputedAt),
                lt(videoStats.qualityScoreComputedAt, asOf),
              ),
            ),
          );
      });

      scoredCount += 1;
    } catch (error: unknown) {
      // Per-video try/catch with an aggregate throw at the end, so one bad row cannot
      // leave every later video stale — the shape recompute-equity-snapshot established.
      failures.push(`${row.video_id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  logger.info("recompute-video-quality-scores: complete", {
    asOf: payload.asOf,
    scoredVideoCount: scoredCount,
    failedVideoCount: failures.length,
  });

  if (failures.length > 0) {
    throw new Error(
      `recompute-video-quality-scores: ${String(failures.length)} video(s) failed — ${failures.join("; ")}`,
    );
  }
}
