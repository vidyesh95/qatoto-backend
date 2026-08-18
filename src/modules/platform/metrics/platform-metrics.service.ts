import { sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  ACTIVITY_HOUR_RETENTION_DAYS,
  INACTIVITY_CHURN_DAYS,
} from "#src/lib/engagement-retention.js";
import { utcDayStringOf } from "#src/lib/utc-day.js";
import { appendPlatformAuditEntry } from "#src/modules/platform/audit/platform-audit.service.js";
import {
  requirePlatformCapability,
  type PlatformAccessError,
} from "#src/modules/platform/roles/platform-role.service.js";
import type { Result } from "#src/types/index.js";

/**
 * Platform activity and watch-time metrics — HOME_BACKEND_STRUCTURE.md §3.3a.
 *
 * ## Two sources, one boundary, no double counting
 *
 * Watch time lives in two places and they overlap:
 *
 *   * `user_activity_hour` — written as beacons arrive, so it is LIVE, exact to the hour, and
 *     kept for `ACTIVITY_HOUR_RETENTION_DAYS` (90).
 *   * `user_watch_daily` — folded from it nightly, kept 25 months.
 *
 * Every read here draws the line at the SAME place: the hour table answers for the last 90 days
 * and the daily table answers for everything older. Not "prefer the rollup" and not "prefer the
 * live table" — a fixed boundary, because a preference would double count on the days both cover,
 * and a preference for the rollup would make today's number wrong for the twenty hours before the
 * job next runs.
 *
 * ## Every capability check runs before any query
 *
 * `requirePlatformCapability` FIRST, resource SECOND, which `platform-role.service.ts` states as a
 * hard rule: reversed, a route becomes an id oracle for anyone holding a session.
 *
 * ## `percentile_disc`, never `percentile_cont`
 *
 * The continuous variant interpolates and returns a double. `recompute-video-durations` already
 * rejected it for that reason — this domain does integer arithmetic in anything that scores, so a
 * median is a real observed value rather than the average of two.
 */

export type PlatformMetricsError = PlatformAccessError;

/** The inclusive UTC date window every read here takes. Validated at the schema boundary. */
export interface MetricsDateWindow {
  readonly fromDate: string;
  readonly toDate: string;
}

/**
 * The first date the daily rollup owns, given today.
 *
 * DERIVED FROM THE RETENTION CONSTANT rather than written as a literal. If the hour table's
 * horizon ever moves, every query below moves with it in the same commit — a hard-coded 90 here
 * would silently start double counting the day someone changed the constant.
 */
function rollupBoundaryDate(today: Date): string {
  return utcDayStringOf(new Date(today.getTime() - ACTIVITY_HOUR_RETENTION_DAYS * 86_400_000));
}

/**
 * Watch seconds per user per date across BOTH sources, as one SQL expression.
 *
 * A fragment rather than a view, because every caller wants a different grouping on top of it and
 * a view would have to be re-planned for each. Callers interpolate it and group as they like.
 */
function unifiedDailyWatchSql(window: MetricsDateWindow, boundaryDate: string) {
  return sql`
    SELECT h.user_id, h.activity_date AS watch_date, SUM(h.watched_seconds)::bigint AS watched_seconds
    FROM user_activity_hour AS h
    WHERE h.activity_date >= ${window.fromDate}
      AND h.activity_date <= ${window.toDate}
      AND h.activity_date >= ${boundaryDate}
    GROUP BY h.user_id, h.activity_date
    UNION ALL
    SELECT d.user_id, d.watch_date, d.watched_seconds::bigint
    FROM user_watch_daily AS d
    WHERE d.watch_date >= ${window.fromDate}
      AND d.watch_date <= ${window.toDate}
      AND d.watch_date < ${boundaryDate}
  `;
}

// ---------------------------------------------------------------------------
// Active users
// ---------------------------------------------------------------------------

export interface ActiveUsersPoint {
  readonly date: string;
  readonly activeUserCount: number;
  readonly rollingActiveUserCount: number;
}

/**
 * Daily active users, plus the rolling distinct count over the requested window length.
 *
 * `window` IS THE ROLLING WIDTH, not a bucket size: WAU is "distinct users in the seven days
 * ENDING here", which is not the sum of seven DAU values and cannot be derived from them. One
 * person watching every day is seven DAU and one WAU.
 */
export async function getActiveUsers(
  staffUserId: string,
  window: MetricsDateWindow,
  rollingDays: number,
): Promise<Result<readonly ActiveUsersPoint[], PlatformMetricsError>> {
  const accessResult = await requirePlatformCapability(staffUserId, "view_platform_metrics");
  if (!accessResult.success) return accessResult;

  const boundaryDate = rollupBoundaryDate(new Date());

  const result = await db.execute<{
    date: string;
    active_user_count: number;
    rolling_active_user_count: number;
  }>(sql`
    WITH daily AS (${unifiedDailyWatchSql(window, boundaryDate)}),
    calendar AS (
      SELECT generate_series(${window.fromDate}::date, ${window.toDate}::date, '1 day')::date AS date
    )
    SELECT
      c.date::text AS date,
      (SELECT count(DISTINCT d.user_id)::int FROM daily AS d WHERE d.watch_date = c.date)
        AS active_user_count,
      (
        SELECT count(DISTINCT d.user_id)::int FROM daily AS d
        WHERE d.watch_date <= c.date
          AND d.watch_date > c.date - ${rollingDays}::int
      ) AS rolling_active_user_count
    FROM calendar AS c
    ORDER BY c.date
  `);

  return {
    success: true,
    value: result.rows.map((row) => ({
      date: row.date,
      activeUserCount: row.active_user_count,
      rollingActiveUserCount: row.rolling_active_user_count,
    })),
  };
}

// ---------------------------------------------------------------------------
// Watch-time distribution
// ---------------------------------------------------------------------------

export interface WatchTimePoint {
  readonly date: string;
  readonly totalWatchedSeconds: number;
  readonly watchingUserCount: number;
  /** `null`, never 0, on a day nobody watched — there is no median of an empty set. */
  readonly medianWatchedSecondsPerUser: number | null;
  readonly p90WatchedSecondsPerUser: number | null;
}

export async function getWatchTimeDistribution(
  staffUserId: string,
  window: MetricsDateWindow,
): Promise<Result<readonly WatchTimePoint[], PlatformMetricsError>> {
  const accessResult = await requirePlatformCapability(staffUserId, "view_platform_metrics");
  if (!accessResult.success) return accessResult;

  const boundaryDate = rollupBoundaryDate(new Date());

  const result = await db.execute<{
    date: string;
    total_watched_seconds: string;
    watching_user_count: number;
    median_watched_seconds: number | null;
    p90_watched_seconds: number | null;
  }>(sql`
    WITH daily AS (${unifiedDailyWatchSql(window, boundaryDate)})
    SELECT
      d.watch_date::text                       AS date,
      SUM(d.watched_seconds)::bigint           AS total_watched_seconds,
      count(DISTINCT d.user_id)::int           AS watching_user_count,
      percentile_disc(0.5) WITHIN GROUP (ORDER BY d.watched_seconds)::int AS median_watched_seconds,
      percentile_disc(0.9) WITHIN GROUP (ORDER BY d.watched_seconds)::int AS p90_watched_seconds
    FROM daily AS d
    GROUP BY d.watch_date
    ORDER BY d.watch_date
  `);

  return {
    success: true,
    value: result.rows.map((row) => ({
      date: row.date,
      // `bigint` crosses the wire as a string in node-postgres. Number() rather than a parse
      // helper because a platform-wide second count cannot reach 2^53 before the sun does.
      totalWatchedSeconds: Number(row.total_watched_seconds),
      watchingUserCount: row.watching_user_count,
      medianWatchedSecondsPerUser: row.median_watched_seconds,
      p90WatchedSecondsPerUser: row.p90_watched_seconds,
    })),
  };
}

// ---------------------------------------------------------------------------
// Activity by hour of day
// ---------------------------------------------------------------------------

export interface ActivityHourBucket {
  readonly hour: number;
  readonly activeUserDayCount: number;
  readonly watchedSeconds: number;
}

/**
 * The 24-bucket histogram, summed across the window.
 *
 * READS `platform_activity_hour_daily` ALONE — the pre-aggregated, user-id-free table. It could be
 * computed from `user_activity_hour` for recent windows, but that would make the answer change
 * shape at the 90-day boundary, and an admin comparing this month to last year would be comparing
 * two different computations. One source, one meaning.
 *
 * `activeUserDayCount` is a SUM OF PER-DAY DISTINCTS, and the name says so. One person watching at
 * 21:00 every night for a month contributes thirty, not one — which is the number that answers
 * "how busy is 21:00", where a distinct-across-the-window count would answer something else.
 *
 * UTC, ALWAYS. There is no per-user timezone on this platform, so a "local hour" histogram would
 * have to guess one. The reader has to know the axis is UTC; the surface must say so.
 */
export async function getActivityByHour(
  staffUserId: string,
  window: MetricsDateWindow,
): Promise<Result<readonly ActivityHourBucket[], PlatformMetricsError>> {
  const accessResult = await requirePlatformCapability(staffUserId, "view_platform_metrics");
  if (!accessResult.success) return accessResult;

  const result = await db.execute<{
    hour: number;
    active_user_day_count: number;
    watched_seconds: string;
  }>(sql`
    SELECT
      hours.hour::int                                  AS hour,
      COALESCE(SUM(p.active_user_count), 0)::int       AS active_user_day_count,
      COALESCE(SUM(p.watched_seconds), 0)::bigint      AS watched_seconds
    FROM generate_series(0, 23) AS hours(hour)
    LEFT JOIN platform_activity_hour_daily AS p
      ON p.activity_hour = hours.hour
     AND p.activity_date >= ${window.fromDate}
     AND p.activity_date <= ${window.toDate}
    GROUP BY hours.hour
    ORDER BY hours.hour
  `);

  return {
    success: true,
    value: result.rows.map((row) => ({
      hour: row.hour,
      activeUserDayCount: row.active_user_day_count,
      watchedSeconds: Number(row.watched_seconds),
    })),
  };
}

// ---------------------------------------------------------------------------
// Retention cohorts
// ---------------------------------------------------------------------------

export interface RetentionCohortRow {
  readonly cohortMonth: string;
  readonly cohortUserCount: number;
  /** Index 0 is the signup month itself, which is why it is rarely 100%. */
  readonly retainedByMonthOffset: readonly number[];
}

/**
 * Signup-month cohorts against watch activity, `monthCount` months wide.
 *
 * RETAINED MEANS "WATCHED SOMETHING THAT MONTH", because watching is the only per-user per-day
 * activity this platform records. It is not "logged in" — nothing writes a last-seen — and
 * pretending otherwise would put a number on a page that no column supports.
 *
 * Offset 0 is the signup month and is usually below 100%: an account created on the 30th has one
 * day to watch anything, and plenty of accounts never watch at all.
 */
export async function getRetentionCohorts(
  staffUserId: string,
  monthCount: number,
): Promise<Result<readonly RetentionCohortRow[], PlatformMetricsError>> {
  const accessResult = await requirePlatformCapability(staffUserId, "view_platform_metrics");
  if (!accessResult.success) return accessResult;

  const result = await db.execute<{
    cohort_month: string;
    cohort_user_count: number;
    month_offset: number;
    retained_user_count: number;
  }>(sql`
    WITH cohorts AS (
      SELECT u.id AS user_id, date_trunc('month', u.created_at)::date AS cohort_month
      FROM "user" AS u
      WHERE u.created_at >= date_trunc('month', now()) - (${monthCount}::int - 1) * INTERVAL '1 month'
        AND u.is_anonymous = false
    ),
    -- Both sources again. A cohort grid spans more than 90 days by construction, so reading only
    -- the live hour table would show every older cohort as having churned immediately.
    activity AS (
      SELECT DISTINCT user_id, date_trunc('month', activity_date)::date AS active_month
      FROM user_activity_hour
      UNION
      SELECT DISTINCT user_id, date_trunc('month', watch_date)::date AS active_month
      FROM user_watch_daily
    ),
    cohort_sizes AS (
      SELECT cohort_month, count(*)::int AS cohort_user_count
      FROM cohorts GROUP BY cohort_month
    )
    SELECT
      to_char(c.cohort_month, 'YYYY-MM')  AS cohort_month,
      s.cohort_user_count,
      (
        EXTRACT(YEAR FROM age(a.active_month, c.cohort_month)) * 12
        + EXTRACT(MONTH FROM age(a.active_month, c.cohort_month))
      )::int                              AS month_offset,
      count(DISTINCT c.user_id)::int      AS retained_user_count
    FROM cohorts AS c
    JOIN cohort_sizes AS s ON s.cohort_month = c.cohort_month
    JOIN activity AS a ON a.user_id = c.user_id AND a.active_month >= c.cohort_month
    GROUP BY c.cohort_month, s.cohort_user_count, month_offset
    ORDER BY c.cohort_month, month_offset
  `);

  // Pivot in TypeScript rather than with `crosstab`: the extension may not be installed, and a
  // dense array of counts is what the caller wants anyway.
  const byCohort = new Map<string, { cohortUserCount: number; retained: number[] }>();
  for (const row of result.rows) {
    const existing = byCohort.get(row.cohort_month) ?? {
      cohortUserCount: row.cohort_user_count,
      retained: [],
    };
    existing.retained[row.month_offset] = row.retained_user_count;
    byCohort.set(row.cohort_month, existing);
  }

  return {
    success: true,
    value: [...byCohort.entries()]
      .toSorted(([leftMonth], [rightMonth]) => leftMonth.localeCompare(rightMonth))
      .map(([cohortMonth, entry]) => ({
        cohortMonth,
        cohortUserCount: entry.cohortUserCount,
        // Holes become 0 — a month with no retained user really is zero, unlike an absent
        // cohort, which is why only this array is densified and never the cohort list.
        retainedByMonthOffset: Array.from(
          { length: entry.retained.length },
          (_unused, offset) => entry.retained[offset] ?? 0,
        ),
      })),
  };
}

// ---------------------------------------------------------------------------
// Named user segments — the audited one
// ---------------------------------------------------------------------------

export const USER_SEGMENTS = ["top_watchers", "at_risk"] as const;
export type UserSegment = (typeof USER_SEGMENTS)[number];

export interface SegmentUserRow {
  readonly userId: string;
  readonly handle: string | null;
  readonly displayName: string;
  readonly watchedSecondsInWindow: number;
  readonly lastActiveDate: string | null;
}

/**
 * The two named lists, and the ONLY read on this surface that writes to the audit chain.
 *
 * WHY IT IS AUDITED WHEN THE AGGREGATES ARE NOT. This answers "who watches the most" and "who has
 * gone quiet" with accounts a human can go and act on, assembled from a behavioural record the
 * subject cannot see being assembled. Looking at that is an exercise of authority over other
 * people's data even though it changes nothing. DAU is not, so stamping the chain on every
 * dashboard refresh would bury the entries that name a person under entries that name nobody.
 *
 * `at_risk` MEANS THE CHURN DEFINITION AND NOTHING ELSE — active before the last
 * `INACTIVITY_CHURN_DAYS`, silent since. One definition, in `engagement-retention.ts`, so this
 * list and the cohort grid can never disagree about what "gone quiet" means.
 */
export async function listUserSegment(
  staffUserId: string,
  staffRoleSnapshot: string,
  segment: UserSegment,
  limit: number,
): Promise<Result<readonly SegmentUserRow[], PlatformMetricsError>> {
  const accessResult = await requirePlatformCapability(staffUserId, "view_platform_metrics");
  if (!accessResult.success) return accessResult;

  const today = new Date();
  const boundaryDate = rollupBoundaryDate(today);
  const churnCutoffDate = utcDayStringOf(
    new Date(today.getTime() - INACTIVITY_CHURN_DAYS * 86_400_000),
  );
  const windowStartDate = utcDayStringOf(new Date(today.getTime() - 365 * 86_400_000));
  const window: MetricsDateWindow = {
    fromDate: windowStartDate,
    toDate: utcDayStringOf(today),
  };

  const rows = await db.execute<{
    user_id: string;
    handle: string | null;
    display_name: string;
    watched_seconds: string;
    last_active_date: string | null;
  }>(sql`
    WITH daily AS (${unifiedDailyWatchSql(window, boundaryDate)}),
    per_user AS (
      SELECT
        d.user_id,
        SUM(d.watched_seconds)::bigint AS watched_seconds,
        MAX(d.watch_date)              AS last_active_date
      FROM daily AS d
      GROUP BY d.user_id
    )
    SELECT
      p.user_id,
      u.handle,
      u.name                    AS display_name,
      p.watched_seconds,
      p.last_active_date::text  AS last_active_date
    FROM per_user AS p
    JOIN "user" AS u ON u.id = p.user_id
    WHERE ${
      segment === "at_risk"
        ? sql`p.last_active_date < ${churnCutoffDate}`
        : sql`p.last_active_date >= ${churnCutoffDate}`
    }
    ORDER BY ${
      segment === "at_risk"
        ? sql`p.last_active_date ASC, p.watched_seconds DESC`
        : sql`p.watched_seconds DESC`
    }
    LIMIT ${limit}
  `);

  // The audit entry records the QUESTION, never the answer. Writing the returned account ids into
  // an append-only, permanently retained chain would make every look-up a second, undeletable copy
  // of the behavioural record — the opposite of what auditing it is meant to achieve.
  await db.transaction(async (tx) => {
    await appendPlatformAuditEntry(tx, {
      eventKind: "platform_metrics_user_segment_viewed",
      actorUserId: staffUserId,
      actorRoleSnapshot: staffRoleSnapshot,
      actionLabel: "Viewed a named user segment",
      targetLabel: segment,
      payload: {
        segment,
        limit: BigInt(limit),
        returnedRowCount: BigInt(rows.rows.length),
        windowFromDate: window.fromDate,
        windowToDate: window.toDate,
      },
      occurredAt: today,
    });
  });

  return {
    success: true,
    value: rows.rows.map((row) => ({
      userId: row.user_id,
      handle: row.handle,
      displayName: row.display_name,
      watchedSecondsInWindow: Number(row.watched_seconds),
      lastActiveDate: row.last_active_date,
    })),
  };
}
