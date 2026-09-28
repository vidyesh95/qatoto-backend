/**
 * The UTC day, as the string that keys every day-bucketed row in this codebase.
 *
 * A MODULE OF ITS OWN, and the reason is an import edge rather than taste. This function
 * used to live in `viewer-fingerprint.ts`, which reads `config` at module scope — so any
 * file importing the day helper transitively required a fully populated environment. That
 * is harmless in a running process and fatal in a unit test, where importing a service to
 * check one pure branch would fail on a missing `DATABASE_URL`.
 *
 * Keeping it here means a caller that only needs to name a day pays for nothing else.
 * `viewer-fingerprint.ts` re-exports it, so existing imports are unaffected.
 *
 * `toISOString()` is always UTC regardless of the process time zone, so this cannot drift
 * the way a `toLocaleDateString` would. The caller passes the instant in; this module
 * reads no clock of its own.
 */
export function utcDayStringOf(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/**
 * The UTC hour of the same instant, 0..23.
 *
 * IT LIVES BESIDE `utcDayStringOf` SO THE PAIR IS TAKEN FROM ONE INSTANT. `user_activity_hour` is
 * keyed on (date, hour), and deriving the two from two different `new Date()` calls would put a
 * beacon that arrives at 23:59:59.9 into yesterday's date and today's hour. Same class of bug as
 * the one `video_view_session.view_day_bucket` avoids by being stored rather than generated.
 *
 * `getUTCHours()` rather than slicing the ISO string: it returns a number, and the caller wants an
 * integer column, not a two-character substring to parse back.
 */
export function utcHourOf(instant: Date): number {
  return instant.getUTCHours();
}

/**
 * The ISO-8601 week of an instant, UTC — `"2026-W40"`. Weeks start on Monday, and week 1 is the
 * week holding the year's first Thursday, so the late-December and early-January days that belong
 * to a neighbouring year's week are labelled with THAT year.
 *
 * It exists for the search-query fingerprint (`computeSearchQueryFingerprint`), whose salt rotates
 * WEEKLY rather than daily: counting "distinct searchers in 7 days" with a daily salt would count
 * one person who searched on five days as five people.
 */
export function utcIsoWeekStringOf(instant: Date): string {
  const utcDate = new Date(
    Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()),
  );
  // Monday = 1 … Sunday = 7, then move to the Thursday of this ISO week.
  const isoWeekday = utcDate.getUTCDay() === 0 ? 7 : utcDate.getUTCDay();
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - isoWeekday);
  const isoYear = utcDate.getUTCFullYear();
  const firstDayOfIsoYear = Date.UTC(isoYear, 0, 1);
  const isoWeekNumber = Math.ceil(((utcDate.getTime() - firstDayOfIsoYear) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${String(isoWeekNumber).padStart(2, "0")}`;
}
