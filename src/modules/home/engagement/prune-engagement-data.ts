import { sql } from "drizzle-orm";

import { config } from "#src/config/index.js";
import { db } from "#src/db/index.js";
import {
  ACTIVITY_HOUR_RETENTION_DAYS,
  SNAPSHOT_RETENTION_DAYS,
  VIEW_SESSION_RETENTION_DAYS,
  WATCH_ROLLUP_RETENTION_DAYS,
} from "#src/lib/engagement-retention.js";
import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import { logger } from "#src/lib/logger.js";
import { utcTimestamp } from "#src/lib/sql-time.js";
import { utcDayStringOf } from "#src/lib/utc-day.js";

/**
 * Retention and the outlier prune — HOME_BACKEND_STRUCTURE.md §3.2, §6, §8.1.
 *
 * ## ⚠️ THIS IS THE FIRST SCHEDULED JOB IN THIS CODEBASE THAT DELETES DOMAIN ROWS
 *
 * It is gated behind `ENGAGEMENT_PRUNE_ENABLED`, which **defaults to false**. While it is
 * false the job runs its full selection and logs exactly what it would remove, touching
 * nothing. Turn it on after the logged counts look like what §3.2 promises.
 *
 * That gate is not timidity. Nothing here reads a session older than 30 days (§4.5's
 * exclusion window) or a snapshot older than yesterday, so the retention numbers are safe
 * by argument — but "safe by argument" and "safe by observation" are different things, and
 * the first run of a delete nobody watched is the one that teaches you the WHERE clause was
 * wrong.
 *
 * ## Three separate things happen here
 *
 * 1. **`videoViewSession` past 90 days is DELETED.** This is §3.2's privacy promise, and
 *    it is the whole reason a fingerprint is defensible: it is a per-day bucket key with a
 *    90-day life, not an identity. The counters in `video_stats` were maintained
 *    transactionally as the sessions arrived, so they survive intact — dropping the rows
 *    loses per-viewer detail, not totals.
 *
 * 2. **Snapshots past 14 days are DELETED.** Ranking reads yesterday's. Two weeks is
 *    enough to answer "why did this rank here last Tuesday" and not so much that an
 *    append-only table becomes the largest thing in the database.
 *
 * 3. **§8.1 rule 3's outlier prune ZEROES, it does not delete.** A fingerprint that
 *    touched more than N videos of a single creator in one day is farming. Its sessions
 *    are neutralised — watch time and completion set to zero, `is_counted_view` cleared —
 *    but the ROWS STAY. Deleting them would erase the evidence of the abuse along with its
 *    effect, and the next person to ask "was this creator farmed?" would find nothing.
 */

/**
 * §8.1 rule 3's threshold: more than this many of ONE creator's videos, by ONE fingerprint,
 * in ONE day, is not a viewing session — it is a script.
 */
const OUTLIER_VIDEOS_PER_CREATOR_PER_DAY = 12;

const MILLISECONDS_PER_DAY = 86_400_000;

type CountRow = {
  readonly affected_count: number;
};

/** The snapshot tables that age out. Named explicitly rather than discovered. */
const PRUNABLE_SNAPSHOT_TABLES = [
  "video_quality_score_snapshot",
  "user_topic_affinity_snapshot",
  "user_creator_affinity_snapshot",
  "trending_video_snapshot",
  "platform_category_popularity_snapshot",
] as const;

export async function handlePruneEngagementData(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.pruneEngagementData,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.pruneEngagementData],
    rawPayload,
  );
  const asOf = new Date(payload.asOf);

  const sessionCutoff = new Date(
    asOf.getTime() - VIEW_SESSION_RETENTION_DAYS * MILLISECONDS_PER_DAY,
  );
  const snapshotCutoff = new Date(asOf.getTime() - SNAPSHOT_RETENTION_DAYS * MILLISECONDS_PER_DAY);

  const isEnabled = config.ENGAGEMENT_PRUNE_ENABLED;

  // --- 1. Expired view sessions.
  const [expiredSessions] = (
    await db.execute<CountRow>(sql`
      SELECT count(*)::int AS affected_count
      FROM video_view_session
      WHERE first_beacon_at < ${utcTimestamp(sessionCutoff)}
    `)
  ).rows;
  const expiredSessionCount = expiredSessions?.affected_count ?? 0;

  if (isEnabled && expiredSessionCount > 0) {
    await db.execute(sql`
      DELETE FROM video_view_session WHERE first_beacon_at < ${utcTimestamp(sessionCutoff)}
    `);
  }

  // --- 2. Expired snapshots, one table at a time so a partial failure is legible.
  const snapshotCounts: Record<string, number> = {};
  for (const tableName of PRUNABLE_SNAPSHOT_TABLES) {
    const [expired] = (
      await db.execute<CountRow>(sql`
        SELECT count(*)::int AS affected_count
        FROM ${sql.identifier(tableName)}
        WHERE as_of < ${utcTimestamp(snapshotCutoff)}
      `)
    ).rows;
    const expiredCount = expired?.affected_count ?? 0;
    snapshotCounts[tableName] = expiredCount;

    if (isEnabled && expiredCount > 0) {
      await db.execute(sql`
        DELETE FROM ${sql.identifier(tableName)} WHERE as_of < ${utcTimestamp(snapshotCutoff)}
      `);
    }
  }

  // --- 3. The §8.1 outlier prune. ZEROES, never deletes.
  //
  // `is_counted_view` is cleared alongside the numbers because `video_stats.view_count`
  // was already incremented when the flip happened and cannot be walked back from here —
  // clearing the flag is what stops the row being counted AGAIN by any recompute that
  // scans sessions (quality's velocity term, trending's window, every affinity).
  // Read inside-out: the inner GROUP BY names every (fingerprint, day, creator) triple
  // that crossed the threshold; the outer SELECT is every counted session belonging to
  // one of those triples.
  const outlierPredicate = sql`
    id IN (
      SELECT s.id
      FROM video_view_session AS s
      JOIN video AS v ON v.id = s.video_id
      WHERE s.is_counted_view
        AND s.first_beacon_at < ${utcTimestamp(asOf)}
        AND (s.viewer_fingerprint, s.view_day_bucket, v.creator_id) IN (
          SELECT o.viewer_fingerprint, o.view_day_bucket, ov.creator_id
          FROM video_view_session AS o
          JOIN video AS ov ON ov.id = o.video_id
          WHERE o.first_beacon_at < ${utcTimestamp(asOf)}
          GROUP BY o.viewer_fingerprint, o.view_day_bucket, ov.creator_id
          HAVING count(DISTINCT o.video_id) > ${OUTLIER_VIDEOS_PER_CREATOR_PER_DAY}
        )
    )
  `;

  const [outliers] = (
    await db.execute<CountRow>(sql`
      SELECT count(*)::int AS affected_count FROM video_view_session WHERE ${outlierPredicate}
    `)
  ).rows;
  const outlierSessionCount = outliers?.affected_count ?? 0;

  if (isEnabled && outlierSessionCount > 0) {
    await db.execute(sql`
      UPDATE video_view_session
      SET watched_seconds = 0,
          completion_basis_points = 0,
          is_counted_view = false
      WHERE ${outlierPredicate}
    `);
  }

  // --- 4. §3.3a's two horizons. Both are DATE columns, so both cutoffs are date strings — a
  // timestamp comparison would widen the date to midnight and take a day more than it should.
  //
  // THE ROLLUP IS PRUNED, AND THAT IS THE POINT OF IT BEING BOUNDED. `user_watch_daily` is the one
  // long-lived per-person behavioural record on this platform; 25 months is what year-over-year
  // and a 24-month cohort grid need, and "indefinitely" is a claim nobody here wants to defend.
  // `platform_activity_hour_daily` shares the horizon and carries no user id, so it is the only
  // one of the three whose expiry is housekeeping rather than a privacy promise.
  const activityHourCutoffDate = utcDayStringOf(
    new Date(asOf.getTime() - ACTIVITY_HOUR_RETENTION_DAYS * MILLISECONDS_PER_DAY),
  );
  const watchRollupCutoffDate = utcDayStringOf(
    new Date(asOf.getTime() - WATCH_ROLLUP_RETENTION_DAYS * MILLISECONDS_PER_DAY),
  );

  const watchRetentionTargets = [
    {
      tableName: "user_activity_hour",
      dateColumn: "activity_date",
      cutoff: activityHourCutoffDate,
    },
    { tableName: "user_watch_daily", dateColumn: "watch_date", cutoff: watchRollupCutoffDate },
    {
      tableName: "platform_activity_hour_daily",
      dateColumn: "activity_date",
      cutoff: watchRollupCutoffDate,
    },
  ] as const;

  const watchRetentionCounts: Record<string, number> = {};
  for (const target of watchRetentionTargets) {
    const [expired] = (
      await db.execute<CountRow>(sql`
        SELECT count(*)::int AS affected_count
        FROM ${sql.identifier(target.tableName)}
        WHERE ${sql.identifier(target.dateColumn)} < ${target.cutoff}
      `)
    ).rows;
    const expiredCount = expired?.affected_count ?? 0;
    watchRetentionCounts[target.tableName] = expiredCount;

    if (isEnabled && expiredCount > 0) {
      await db.execute(sql`
        DELETE FROM ${sql.identifier(target.tableName)}
        WHERE ${sql.identifier(target.dateColumn)} < ${target.cutoff}
      `);
    }
  }

  logger.info(
    isEnabled
      ? "prune-engagement-data: complete"
      : "prune-engagement-data: DRY RUN — set ENGAGEMENT_PRUNE_ENABLED=true to apply",
    {
      asOf: payload.asOf,
      enabled: isEnabled,
      sessionCutoff: sessionCutoff.toISOString(),
      snapshotCutoff: snapshotCutoff.toISOString(),
      activityHourCutoffDate,
      watchRollupCutoffDate,
      expiredSessionCount,
      expiredSnapshotCounts: snapshotCounts,
      outlierSessionCount,
      expiredWatchRetentionCounts: watchRetentionCounts,
    },
  );
}
