import { sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { ACTIVITY_HOUR_RETENTION_DAYS } from "#src/lib/engagement-retention.js";
import { utcDayStringOf } from "#src/lib/utc-day.js";

/**
 * "How long have I watched" — HOME_BACKEND_STRUCTURE.md §3.3a, the viewer's own read.
 *
 * ## Why the hour table and not the rollup
 *
 * `user_activity_hour` is written as the beacons land, so it is exact to the second the moment a
 * video is paused. `user_watch_daily` is folded from it at 04:40 UTC, which means it is up to
 * twenty-four hours behind. Reading the rollup for "today" would show a viewer a number that
 * disagrees with what they just did, and no amount of caching copy explains that away.
 *
 * So the hour table answers everything inside its 90-day retention, and the rollup is consulted
 * only for the part of "this year" that falls outside it. One boundary, derived from the retention
 * constant, so the two can never overlap and double count.
 *
 * ## Time zone
 *
 * `timeZone` is a DISPLAY PREFERENCE, in exactly the sense CLAUDE.md uses for the browse-country
 * selector: it decides where a day starts for the purpose of rendering a number, and it is trusted
 * for nothing else. It cannot widen the window, cannot reach another account, and cannot change
 * what was recorded. Postgres validates it — an unknown zone raises rather than silently falling
 * back, so a typo is a 422 and not a wrong total.
 *
 * The rollup half of "this year" is bucketed in UTC regardless, because a `date` column that was
 * written from a UTC day cannot be re-cut into local days: the hour that would let you do it is
 * exactly what the fold discarded. The error is bounded by one day at the 90-day boundary, and it
 * only ever affects the year total.
 *
 * ## Zero is a finding, absence is not
 *
 * A viewer with no rows gets `null`, never `0`. Zero means "we watched you watch nothing"; null
 * means "nothing has been recorded", and only one of those is true for somebody who has never
 * signed in on this device. The same rule `formatScorePoints` states on the frontend.
 *
 * ## What it deliberately cannot count
 *
 * Signed-out watching. The beacon writes `user_activity_hour` only when the session carries a
 * viewer id, because the alternative is keying a behavioural record on a fingerprint that is
 * shared by everyone behind one NAT. Any surface built on this has to say so.
 */

export interface ViewerWatchTimeWindow {
  /** Integer seconds, or `null` when nothing has ever been recorded for this account. */
  readonly today: number | null;
  readonly thisWeek: number | null;
  readonly thisMonth: number | null;
  readonly thisYear: number | null;
}

export interface ViewerWatchTimeDay {
  readonly date: string;
  readonly watchedSeconds: number;
}

export interface ViewerWatchTime {
  readonly totals: ViewerWatchTimeWindow;
  /** The last 30 local days, densified — a day with no watching is a real zero here. */
  readonly dailySeries: readonly ViewerWatchTimeDay[];
  /** 24 buckets in the viewer's own zone, over the last 90 days. */
  readonly hourHistogram: readonly number[];
  /** So the surface can say "signed-out watching is not counted" without hardcoding the number. */
  readonly hourDetailRetentionDays: number;
}

const DAILY_SERIES_DAYS = 30;

/**
 * The local-day expression for an hour row.
 *
 * `activity_date + activity_hour hours` reconstructs the UTC instant the counter belongs to, which
 * is the whole reason the hour is a column rather than being folded away at write time. Without
 * it, no local-day bucketing is possible at all.
 */
function localDateOfHourRow(timeZone: string) {
  return sql`((h.activity_date::timestamp + make_interval(hours => h.activity_hour)) AT TIME ZONE 'UTC' AT TIME ZONE ${timeZone})::date`;
}

export async function getViewerWatchTime(
  viewerUserId: string,
  timeZone: string,
): Promise<ViewerWatchTime> {
  const boundaryDate = utcDayStringOf(
    new Date(Date.now() - ACTIVITY_HOUR_RETENTION_DAYS * 86_400_000),
  );
  const localDate = localDateOfHourRow(timeZone);

  const [totalsRow] = (
    await db.execute<{
      today: string | null;
      this_week: string | null;
      this_month: string | null;
      this_year_recent: string | null;
      this_year_archived: string | null;
      has_any_row: boolean;
    }>(sql`
      WITH local_today AS (SELECT (now() AT TIME ZONE ${timeZone})::date AS day),
      hours AS (
        SELECT ${localDate} AS local_date, h.watched_seconds
        FROM user_activity_hour AS h
        WHERE h.user_id = ${viewerUserId}
      )
      SELECT
        SUM(hours.watched_seconds) FILTER (
          WHERE hours.local_date = (SELECT day FROM local_today)
        )::bigint AS today,
        SUM(hours.watched_seconds) FILTER (
          WHERE hours.local_date >= date_trunc('week', (SELECT day FROM local_today))::date
        )::bigint AS this_week,
        SUM(hours.watched_seconds) FILTER (
          WHERE hours.local_date >= date_trunc('month', (SELECT day FROM local_today))::date
        )::bigint AS this_month,
        SUM(hours.watched_seconds) FILTER (
          WHERE hours.local_date >= date_trunc('year', (SELECT day FROM local_today))::date
        )::bigint AS this_year_recent,
        -- The part of the year the hour table no longer holds. UTC-bucketed, because the fold
        -- discarded the hour that would let it be re-cut locally.
        (
          SELECT SUM(d.watched_seconds)::bigint
          FROM user_watch_daily AS d
          WHERE d.user_id = ${viewerUserId}
            AND d.watch_date < ${boundaryDate}
            AND d.watch_date >= date_trunc('year', (SELECT day FROM local_today))::date
        ) AS this_year_archived,
        (
          EXISTS (SELECT 1 FROM user_activity_hour AS a WHERE a.user_id = ${viewerUserId})
          OR EXISTS (SELECT 1 FROM user_watch_daily AS w WHERE w.user_id = ${viewerUserId})
        ) AS has_any_row
      FROM hours
    `)
  ).rows;

  // No row at all from an aggregate-only query is only possible if `hours` was empty AND the
  // planner elided the outer aggregate — treat it as "nothing recorded", the same as the flag.
  const hasAnyRow = totalsRow?.has_any_row ?? false;

  const dailyResult = await db.execute<{ date: string; watched_seconds: string }>(sql`
    WITH local_today AS (SELECT (now() AT TIME ZONE ${timeZone})::date AS day),
    calendar AS (
      SELECT generate_series(
        (SELECT day FROM local_today) - ${DAILY_SERIES_DAYS - 1}::int,
        (SELECT day FROM local_today),
        '1 day'
      )::date AS date
    ),
    hours AS (
      SELECT ${localDate} AS local_date, h.watched_seconds
      FROM user_activity_hour AS h
      WHERE h.user_id = ${viewerUserId}
    )
    SELECT
      c.date::text AS date,
      COALESCE((SELECT SUM(hours.watched_seconds) FROM hours WHERE hours.local_date = c.date), 0)::bigint
        AS watched_seconds
    FROM calendar AS c
    ORDER BY c.date
  `);

  const hourResult = await db.execute<{ hour: number; watched_seconds: string }>(sql`
    WITH hours AS (
      SELECT
        EXTRACT(HOUR FROM (
          (h.activity_date::timestamp + make_interval(hours => h.activity_hour))
          AT TIME ZONE 'UTC' AT TIME ZONE ${timeZone}
        ))::int AS local_hour,
        h.watched_seconds
      FROM user_activity_hour AS h
      WHERE h.user_id = ${viewerUserId}
    )
    SELECT
      bucket.hour::int AS hour,
      COALESCE((SELECT SUM(hours.watched_seconds) FROM hours WHERE hours.local_hour = bucket.hour), 0)::bigint
        AS watched_seconds
    FROM generate_series(0, 23) AS bucket(hour)
    ORDER BY bucket.hour
  `);

  /** `null` when the account has no record at all; the summed value otherwise, zero included. */
  const toTotal = (raw: string | null | undefined): number | null => {
    if (!hasAnyRow) return null;
    return Number(raw ?? 0);
  };

  return {
    totals: {
      today: toTotal(totalsRow?.today),
      thisWeek: toTotal(totalsRow?.this_week),
      thisMonth: toTotal(totalsRow?.this_month),
      thisYear: hasAnyRow
        ? Number(totalsRow?.this_year_recent ?? 0) + Number(totalsRow?.this_year_archived ?? 0)
        : null,
    },
    dailySeries: dailyResult.rows.map((row) => ({
      date: row.date,
      watchedSeconds: Number(row.watched_seconds),
    })),
    hourHistogram: hourResult.rows.map((row) => Number(row.watched_seconds)),
    hourDetailRetentionDays: ACTIVITY_HOUR_RETENTION_DAYS,
  };
}
