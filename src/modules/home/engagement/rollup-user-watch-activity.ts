import { sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import { logger } from "#src/lib/logger.js";
import { utcDayStringOf } from "#src/lib/utc-day.js";

/**
 * §3.3a — folds `user_activity_hour` into the two things that outlive it.
 *
 * ## One job, two outputs, one scan
 *
 * `user_watch_daily` (per user, per day) and `platform_activity_hour_daily` (24 rows a day, no
 * user id) ask the same question of the same rows and differ only in the grouping key. Two jobs
 * would mean two scans of the same table and two schedules to keep in the right order — the
 * argument `recompute-user-affinities` already makes for not splitting topic and creator affinity.
 *
 * ## It aggregates in SQL and never pulls rows into TypeScript
 *
 * Unlike the affinity job, nothing here needs a scoring function: these are sums and counts, and
 * `INSERT … SELECT … ON CONFLICT DO UPDATE` does the whole thing server-side. Pulling a day of
 * per-user-per-hour rows into memory to add them up would be the same arithmetic, one network
 * round trip per batch, and a heap large enough to matter on a busy day.
 *
 * ## Why it re-rolls four days and not one
 *
 * A beacon can land after the job has run for its day — a tab open across 04:40 UTC, a retry, a
 * worker that was down. `ON CONFLICT DO UPDATE` with a four-day window means the numbers converge
 * on their own instead of needing a backfill script. Re-running the same `asOf` twice produces
 * identical rows, which is the property that makes the whole thing safe to trigger by hand.
 *
 * ## What it is NOT responsible for
 *
 * Freshness of the user-facing "today"/"this week" totals. Those read `user_activity_hour`
 * directly, which is live — see `platform-metrics.service.ts` for the 90-day boundary that keeps
 * the two sources from double-counting. This job's outputs matter for windows LONGER than the hour
 * table's retention, and for every admin aggregate.
 */

/**
 * How many days back to re-aggregate, counting `asOf`'s own day as day zero.
 *
 * Three is a judgement, not a derivation: it is long enough to absorb a worker outage over a
 * weekend night and short enough that the nightly write stays four days wide rather than growing
 * with the table. A day older than this is settled — its hour rows stopped changing when the last
 * beacon of that day landed.
 */
const ROLLUP_LOOKBACK_DAYS = 3;

export async function handleRollupUserWatchActivity(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.rollupUserWatchActivity,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.rollupUserWatchActivity],
    rawPayload,
  );
  const asOf = new Date(payload.asOf);

  // Both bounds are DATE STRINGS, because both target columns are `date` and the source column is
  // too. Comparing a date to a timestamp would make Postgres widen the date to midnight and
  // silently drop everything after it on the last day of the window.
  const windowEndsOnDate = utcDayStringOf(asOf);
  const windowStartsOnDate = utcDayStringOf(
    new Date(asOf.getTime() - ROLLUP_LOOKBACK_DAYS * 24 * 60 * 60 * 1_000),
  );

  /**
   * WATCH SECONDS COME FROM `user_activity_hour`, THE COUNTS COME FROM `video_view_session`, and
   * the split is not arbitrary. The hour table holds clamped seconds and knows nothing about which
   * video they belonged to; the session table knows the subjects but has no hour and dies at 90
   * days. Each column is taken from the only table that can answer it honestly.
   *
   * The LEFT JOIN is on the session side because a user can have credited seconds without a
   * COUNTED view — ten seconds and thirty percent is the bar, and a browsing session that never
   * clears it is still real watch time. Those days get zero counts and non-zero seconds, which is
   * the truth about them.
   */
  const watchDailyResult = await db.execute(sql`
    INSERT INTO user_watch_daily
      (user_id, watch_date, watched_seconds, counted_view_count, distinct_video_count)
    SELECT
      h.user_id,
      h.activity_date,
      SUM(h.watched_seconds)::int AS watched_seconds,
      COALESCE(s.counted_view_count, 0) AS counted_view_count,
      COALESCE(s.distinct_video_count, 0) AS distinct_video_count
    FROM user_activity_hour AS h
    LEFT JOIN LATERAL (
      SELECT
        count(*) FILTER (WHERE vvs.is_counted_view)::int AS counted_view_count,
        count(DISTINCT vvs.video_id)::int                AS distinct_video_count
      FROM video_view_session AS vvs
      WHERE vvs.viewer_id = h.user_id
        AND vvs.view_day_bucket = h.activity_date
    ) AS s ON true
    WHERE h.activity_date >= ${windowStartsOnDate}
      AND h.activity_date <= ${windowEndsOnDate}
    GROUP BY h.user_id, h.activity_date, s.counted_view_count, s.distinct_video_count
    ON CONFLICT ON CONSTRAINT user_watch_daily_pk DO UPDATE SET
      watched_seconds      = EXCLUDED.watched_seconds,
      counted_view_count   = EXCLUDED.counted_view_count,
      distinct_video_count = EXCLUDED.distinct_video_count
  `);

  /**
   * `count(DISTINCT user_id)` RATHER THAN `count(*)`, and the distinction is the whole column.
   * One user watching for the whole hour produces one row; `active_user_count` must say one, not
   * "one row". `watched_seconds` is a bigint here because it sums across the entire platform
   * rather than one person — 24 hours of a busy day overflows an int far sooner than a single
   * viewer's day ever could.
   */
  const platformHourResult = await db.execute(sql`
    INSERT INTO platform_activity_hour_daily
      (activity_date, activity_hour, active_user_count, watched_seconds)
    SELECT
      h.activity_date,
      h.activity_hour,
      count(DISTINCT h.user_id)::int AS active_user_count,
      COALESCE(SUM(h.watched_seconds), 0)::bigint AS watched_seconds
    FROM user_activity_hour AS h
    WHERE h.activity_date >= ${windowStartsOnDate}
      AND h.activity_date <= ${windowEndsOnDate}
    GROUP BY h.activity_date, h.activity_hour
    ON CONFLICT ON CONSTRAINT platform_activity_hour_daily_pk DO UPDATE SET
      active_user_count = EXCLUDED.active_user_count,
      watched_seconds   = EXCLUDED.watched_seconds
  `);

  logger.info("rollup-user-watch-activity: complete", {
    asOf: payload.asOf,
    windowStartsOnDate,
    windowEndsOnDate,
    userWatchDailyRowsWritten: watchDailyResult.rowCount ?? 0,
    platformActivityHourRowsWritten: platformHourResult.rowCount ?? 0,
  });
}
