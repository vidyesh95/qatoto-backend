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
