/**
 * How long engagement data lives — HOME_BACKEND_STRUCTURE.md §3.2, §6.
 *
 * WHY THESE ARE SHARED RATHER THAN LOCAL TO THE PRUNE JOB. Two jobs depend on the same
 * number for different reasons, and they must not drift:
 *
 *   * `prune-engagement-data` DELETES `video_view_session` rows past the retention window.
 *   * `recompute-video-quality-scores` recomputes `unique_viewer_count` and
 *     `counted_views_first_48_hours` FROM those rows — so past the same window it must
 *     stop trusting its own recomputation and hold the last good value instead.
 *
 * If the second job's horizon were even a day shorter than the first's, there would be a
 * window where sessions are gone and the score still believes it can count them. The
 * failure is silent: engagement inflates because its denominator shrank, velocity falls to
 * zero because the first-48-hours rows no longer exist, and every video older than the
 * retention window is quietly re-ranked. Nothing errors. One constant, two readers.
 */

/**
 * §3.2's privacy promise: per-viewer session rows are dropped at 90 days.
 *
 * The counters in `video_stats` survive — they were maintained transactionally as the
 * beacons arrived, so deleting the sessions loses per-viewer detail, not totals.
 */
export const VIEW_SESSION_RETENTION_DAYS = 90;

/**
 * §6: ranking reads yesterday's snapshot. Two weeks is enough to answer "why did this rank
 * here last Tuesday" and not so much that an append-only table becomes the largest thing
 * in the database.
 */
export const SNAPSHOT_RETENTION_DAYS = 14;

/**
 * True once `prune-engagement-data` may have removed sessions this video needs.
 *
 * The quality job uses this to decide whether its recomputation is authoritative. INSIDE
 * the window every session still exists, so a recomputed value is the truth and is allowed
 * to fall — which matters, because §8.1's outlier prune deflates a farmed video by clearing
 * `is_counted_view`, and a blanket "never decrease" rule would cancel that defence.
 * OUTSIDE it the data is gone and the stored value is the only honest answer.
 */
export function mayHavePrunedSessions(hoursSincePublished: number): boolean {
  return hoursSincePublished > VIEW_SESSION_RETENTION_DAYS * 24;
}

/**
 * §3.3a: the hour-by-hour counter dies with the sessions it was derived from.
 *
 * EQUAL TO `VIEW_SESSION_RETENTION_DAYS` ON PURPOSE, and it must stay equal. `user_activity_hour`
 * is finer-grained than `video_view_session` — it says which hour of which day a named account was
 * watching — so a longer horizon here would quietly undo the promise §3.2 makes, by keeping a
 * sharper record of the same behaviour after the blunter one was deleted.
 */
export const ACTIVITY_HOUR_RETENTION_DAYS = VIEW_SESSION_RETENTION_DAYS;

/**
 * §3.3a: how long the per-user daily watch series lives. Twenty-five months.
 *
 * TWO YEARS PLUS A MONTH, so a year-over-year comparison has a full prior year to compare against
 * and a 24-month cohort grid has its oldest cohort intact. Longer buys nothing any surface asks
 * for; "indefinitely" is a different claim that would have to be defended rather than assumed.
 */
export const WATCH_ROLLUP_RETENTION_DAYS = 762;

/**
 * §3.3a: the ONE definition of churn, stated here and nowhere else.
 *
 * A user is ACTIVE in a period if they have at least one `user_watch_daily` row inside it —
 * watching is the only activity this platform records per-user per-day, so it is the only honest
 * basis for the word. CHURNED means active in the previous period and absent from this one.
 *
 * IT LIVES BESIDE THE RETENTION WINDOWS BECAUSE IT IS BOUNDED BY THEM. A churn window longer than
 * `WATCH_ROLLUP_RETENTION_DAYS` would compare this period against rows that had been deleted, and
 * report every long-dormant account as freshly churned, every night, forever.
 */
export const INACTIVITY_CHURN_DAYS = 30;
