import { sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { userCreatorAffinitySnapshot, userTopicAffinitySnapshot } from "#src/db/schema.js";
import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import { logger } from "#src/lib/logger.js";
import { utcTimestamp } from "#src/lib/sql-time.js";
import {
  AFFINITY_WINDOW_DAYS,
  computeAffinityScorePoints,
} from "#src/modules/home/affinity-score.js";

/**
 * §4.3, §4.4 — what each signed-in viewer likes, by category and by creator.
 *
 * ## One job, two snapshots
 *
 * Topic affinity and creator affinity ask the same question of the same
 * `video_view_session` rows and differ only in the grouping key. Two jobs would mean two
 * scans of the widest table in the domain and two schedules to keep in the right order.
 *
 * ## Only signed-in viewers
 *
 * `viewer_id IS NOT NULL` throughout. An anonymous viewer's affinity is computed IN-REQUEST
 * from their fingerprint over a 7-day window (§4.4) — a fingerprint is a per-day bucket key
 * over an IP and a user agent, so a 90-day profile keyed on one would be a profile of a
 * coffee shop, not a person. Persisting that would also be exactly the kind of
 * long-lived behavioural record §3.2 went out of its way not to keep.
 *
 * ## A row only exists where there is evidence
 *
 * Nothing writes a zero row. The ABSENCE of a (viewer, category) row is what triggers the
 * cold-start fallback to damped platform popularity; a stored zero would fabricate the
 * value the fallback exists to avoid, and the feed could no longer tell "watched it and
 * bounced" from "never saw it".
 */

type TopicAffinityRow = {
  readonly user_id: string;
  readonly category_id: string;
  readonly counted_view_count: number;
  readonly completion_bp_sum: number;
  readonly completion_sample_count: number;
  readonly like_count: number;
  readonly save_count: number;
};

type CreatorAffinityRow = {
  readonly user_id: string;
  readonly creator_id: string;
  readonly counted_view_count: number;
  readonly completion_bp_sum: number;
  readonly completion_sample_count: number;
  readonly like_count: number;
  readonly save_count: number;
  readonly is_subscribed: boolean;
};

export async function handleRecomputeUserAffinities(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.recomputeUserAffinities,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.recomputeUserAffinities],
    rawPayload,
  );
  const asOf = new Date(payload.asOf);

  // ABSOLUTE bounds, derived from asOf. A window expressed as "90 days" in the row would
  // be unreadable a year later; two instants are self-describing.
  const windowStartsAt = new Date(asOf.getTime() - AFFINITY_WINDOW_DAYS * 24 * 60 * 60 * 1_000);

  const topicRows = await db.execute<TopicAffinityRow>(sql`
    SELECT
      s.viewer_id AS user_id,
      vc.category_id,
      count(*)::int                              AS counted_view_count,
      COALESCE(sum(s.completion_basis_points), 0)::int AS completion_bp_sum,
      count(*)::int                              AS completion_sample_count,
      (
        SELECT count(*)::int FROM video_like AS l
        JOIN video_category AS lc ON lc.video_id = l.video_id
        WHERE l.user_id = s.viewer_id AND lc.category_id = vc.category_id
          AND l.created_at < ${utcTimestamp(asOf)}
      ) AS like_count,
      (
        SELECT count(*)::int FROM video_save AS sv
        JOIN video_category AS sc ON sc.video_id = sv.video_id
        WHERE sv.user_id = s.viewer_id AND sc.category_id = vc.category_id
          AND sv.created_at < ${utcTimestamp(asOf)}
      ) AS save_count
    FROM video_view_session AS s
    JOIN video_category AS vc ON vc.video_id = s.video_id
    WHERE s.viewer_id IS NOT NULL
      AND s.is_counted_view
      AND s.first_beacon_at >= ${utcTimestamp(windowStartsAt)}
      AND s.first_beacon_at < ${utcTimestamp(asOf)}
    GROUP BY s.viewer_id, vc.category_id
    ORDER BY s.viewer_id, vc.category_id
  `);

  const creatorRows = await db.execute<CreatorAffinityRow>(sql`
    SELECT
      s.viewer_id AS user_id,
      v.creator_id,
      count(*)::int                              AS counted_view_count,
      COALESCE(sum(s.completion_basis_points), 0)::int AS completion_bp_sum,
      count(*)::int                              AS completion_sample_count,
      (
        SELECT count(*)::int FROM video_like AS l
        JOIN video AS lv ON lv.id = l.video_id
        WHERE l.user_id = s.viewer_id AND lv.creator_id = v.creator_id
          AND l.created_at < ${utcTimestamp(asOf)}
      ) AS like_count,
      (
        SELECT count(*)::int FROM video_save AS sv
        JOIN video AS svv ON svv.id = sv.video_id
        WHERE sv.user_id = s.viewer_id AND svv.creator_id = v.creator_id
          AND sv.created_at < ${utcTimestamp(asOf)}
      ) AS save_count,
      EXISTS (
        SELECT 1 FROM creator_subscription AS cs
        WHERE cs.subscriber_id = s.viewer_id AND cs.creator_id = v.creator_id
          AND cs.created_at < ${utcTimestamp(asOf)}
      ) AS is_subscribed
    FROM video_view_session AS s
    JOIN video AS v ON v.id = s.video_id
    WHERE s.viewer_id IS NOT NULL
      AND s.is_counted_view
      AND s.first_beacon_at >= ${utcTimestamp(windowStartsAt)}
      AND s.first_beacon_at < ${utcTimestamp(asOf)}
      -- A viewer cannot have an affinity for themselves. The CHECK on the table would
      -- refuse the row anyway; refusing it here keeps the batch insert from failing
      -- wholesale because one creator watched their own upload.
      AND v.creator_id <> s.viewer_id
    GROUP BY s.viewer_id, v.creator_id
    ORDER BY s.viewer_id, v.creator_id
  `);

  await db.transaction(async (tx) => {
    if (topicRows.rows.length > 0) {
      await tx
        .insert(userTopicAffinitySnapshot)
        .values(
          topicRows.rows.map((row) => {
            const breakdown = computeAffinityScorePoints({
              countedViewCount: row.counted_view_count,
              completionBasisPointsSum: row.completion_bp_sum,
              completionSampleCount: row.completion_sample_count,
              likeCount: row.like_count,
              saveCount: row.save_count,
              // A category cannot be subscribed to.
              isSubscribedToCreator: false,
            });
            return {
              userId: row.user_id,
              categoryId: row.category_id,
              asOf,
              affinityPoints: breakdown.totalPoints,
              countedViewCount: row.counted_view_count,
              meanCompletionBasisPoints: breakdown.meanCompletionBasisPoints,
              explicitSignalCount: breakdown.explicitSignalCount,
              watchCountComponentPoints: breakdown.watchCountComponentPoints,
              meanCompletionComponentPoints: breakdown.meanCompletionComponentPoints,
              explicitSignalComponentPoints: breakdown.explicitSignalComponentPoints,
            };
          }),
        )
        .onConflictDoNothing({
          target: [
            userTopicAffinitySnapshot.userId,
            userTopicAffinitySnapshot.categoryId,
            userTopicAffinitySnapshot.asOf,
          ],
        });
    }

    if (creatorRows.rows.length > 0) {
      await tx
        .insert(userCreatorAffinitySnapshot)
        .values(
          creatorRows.rows.map((row) => {
            const breakdown = computeAffinityScorePoints({
              countedViewCount: row.counted_view_count,
              completionBasisPointsSum: row.completion_bp_sum,
              completionSampleCount: row.completion_sample_count,
              likeCount: row.like_count,
              saveCount: row.save_count,
              isSubscribedToCreator: row.is_subscribed,
            });
            return {
              userId: row.user_id,
              creatorId: row.creator_id,
              asOf,
              affinityPoints: breakdown.totalPoints,
              countedViewCount: row.counted_view_count,
              meanCompletionBasisPoints: breakdown.meanCompletionBasisPoints,
              explicitSignalCount: breakdown.explicitSignalCount,
              watchCountComponentPoints: breakdown.watchCountComponentPoints,
              meanCompletionComponentPoints: breakdown.meanCompletionComponentPoints,
              explicitSignalComponentPoints: breakdown.explicitSignalComponentPoints,
            };
          }),
        )
        .onConflictDoNothing({
          target: [
            userCreatorAffinitySnapshot.userId,
            userCreatorAffinitySnapshot.creatorId,
            userCreatorAffinitySnapshot.asOf,
          ],
        });
    }
  });

  logger.info("recompute-user-affinities: complete", {
    asOf: payload.asOf,
    windowStartsAt: windowStartsAt.toISOString(),
    topicRowCount: topicRows.rows.length,
    creatorRowCount: creatorRows.rows.length,
  });
}
