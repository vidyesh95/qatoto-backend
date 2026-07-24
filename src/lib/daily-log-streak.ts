/**
 * The daily-log streak fold (R_AND_D_BACKEND_STRUCTURE.md §5 `project_stats`, §8).
 *
 * WHY A STREAK IS A JOB-COMPUTED COLUMN AND NOT A COUNT ON READ. It is a temporal fold
 * over the whole log history AND it decays with wall-clock time: a project that logged
 * yesterday and not today drops to zero at midnight with no write happening anywhere.
 * Computing it on read would need `(now, timezone, full log scan)` on every project card;
 * storing it makes the read free and the decay a nightly job.
 *
 * WHY THE PROJECT CARRIES A TIME ZONE. "A day" is undefined without one. A team spread
 * across Nairobi and Lima has two midnights, so without a single declared zone the same
 * log either extends a streak or breaks it depending on who asks — and
 * `project_stats.projectTimeZone` is server-owned precisely because a client-settable day
 * boundary is a client-settable input into an equity-adjacent number (§13).
 *
 * Everything here is pure integer arithmetic over date-only strings. No `Date` object
 * survives a function boundary, so nothing can be silently reinterpreted in the host's
 * local zone — the trap src/db/index.ts pins the timestamp parser to UTC to avoid.
 */

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MILLISECONDS_PER_DAY = 86_400_000;

/** A calendar day as `YYYY-MM-DD`, the §1 wire format for a date. */
export type IsoDate = string;

function assertIsoDate(candidate: string, label: string): void {
  if (!ISO_DATE_PATTERN.test(candidate)) {
    // Unrecoverable programmer error (CLAUDE.md §3.3): every caller reads this out of a
    // `date` column or an already-parsed Zod field, so a malformed value means the
    // boundary parse was skipped rather than that a user typed something odd.
    throw new Error(
      `daily-log-streak: ${label} must be an ISO date (YYYY-MM-DD), got "${candidate}"`,
    );
  }
}

/**
 * Epoch milliseconds at UTC midnight of a date-only string.
 *
 * `Date.UTC` rather than `new Date(string)`: the latter parses `"2026-07-24"` as UTC but
 * `"2026-7-24"` as LOCAL time, and the difference is invisible until a server in a
 * non-UTC zone computes a streak one day off for everyone.
 */
function utcMidnightMs(isoDate: IsoDate): number {
  const [year, month, day] = isoDate.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`daily-log-streak: could not read "${isoDate}" as a date`);
  }
  return Date.UTC(year, month - 1, day);
}

/**
 * Whole days from `earlier` to `later`; negative when `later` precedes `earlier`.
 *
 * Both operands are UTC midnights, so the difference is an exact multiple of 86 400 000
 * and the division is integer division in every case — DST never enters, because a
 * date-only value has no time of day to shift.
 */
export function daysBetween(earlier: IsoDate, later: IsoDate): number {
  assertIsoDate(earlier, "earlier");
  assertIsoDate(later, "later");
  return (utcMidnightMs(later) - utcMidnightMs(earlier)) / MILLISECONDS_PER_DAY;
}

/**
 * The calendar date at `instant` in `timeZone`.
 *
 * `en-CA` is not decoration: it is the locale whose short date format IS `YYYY-MM-DD`,
 * so this needs no reassembly of parts and no zero-padding of its own. An invalid zone
 * throws from `Intl`, which is correct — a project row carrying a zone nothing can
 * resolve is a bug to surface, not to paper over with UTC.
 */
export function calendarDateIn(instant: Date, timeZone: string): IsoDate {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

export interface StreakState {
  /** NULL on a project that has never had a submitted log. */
  readonly lastDailyLogDate: IsoDate | null;
  readonly dailyLogStreakDays: number;
}

/**
 * The streak after a log is submitted for `newLogDate`.
 *
 * Four cases, and the two boring ones are the ones worth stating:
 *
 *   - No history            → 1. The first log is a one-day streak, not a zero.
 *   - Same day again        → unchanged. `daily_log` already refuses a second log for a
 *                             day, but a resubmit after a failed analysis must not
 *                             double-count, and defending it here costs one comparison.
 *   - Exactly one day later → +1.
 *   - A gap                 → 1. The streak restarts AT the new log, never at zero: the
 *                             member did log today.
 *
 * BACK-DATED LOGS DO NOT EXTEND A STREAK. Filing Monday's work on Wednesday leaves the
 * count alone and leaves `lastDailyLogDate` at the later date. Recomputing the fold from
 * the full history would be the "correct" answer, but it would also let a member
 * manufacture a 30-day streak on their last day by back-filling a month — and a streak is
 * a trust signal on a public project card. The nightly job is the only thing that ever
 * lowers this number.
 */
export function streakAfterLog(currentState: StreakState, newLogDate: IsoDate): StreakState {
  assertIsoDate(newLogDate, "newLogDate");

  if (currentState.lastDailyLogDate === null) {
    return { lastDailyLogDate: newLogDate, dailyLogStreakDays: 1 };
  }

  const gapDays = daysBetween(currentState.lastDailyLogDate, newLogDate);

  if (gapDays < 0) {
    // Back-dated: the record of "most recent log" must not move backwards.
    return currentState;
  }
  if (gapDays === 0) {
    return currentState;
  }
  if (gapDays === 1) {
    return {
      lastDailyLogDate: newLogDate,
      dailyLogStreakDays: currentState.dailyLogStreakDays + 1,
    };
  }
  return { lastDailyLogDate: newLogDate, dailyLogStreakDays: 1 };
}

/**
 * The streak as of `todayDate`, with no new log — the nightly decay job's whole job.
 *
 * A streak survives while the last log is today or yesterday. Yesterday counts because
 * the job runs after midnight and a member who logs every evening must not lose a streak
 * to the job's own schedule; the day after that, the streak is genuinely broken.
 *
 * Idempotent and replayable: it reads only `(state, todayDate)`, so re-running it for the
 * same day is a no-op and running it for a historical `asOf` reproduces that day's answer
 * exactly (§4c rule 3).
 */
export function streakAsOf(currentState: StreakState, todayDate: IsoDate): StreakState {
  assertIsoDate(todayDate, "todayDate");

  if (currentState.lastDailyLogDate === null) {
    return { lastDailyLogDate: null, dailyLogStreakDays: 0 };
  }

  const daysSinceLastLog = daysBetween(currentState.lastDailyLogDate, todayDate);

  if (daysSinceLastLog <= 1) {
    return currentState;
  }
  // Broken. `lastDailyLogDate` is HISTORY and is never cleared — it is the input this
  // function needs tomorrow, and clearing it would make the decay unreplayable.
  return { lastDailyLogDate: currentState.lastDailyLogDate, dailyLogStreakDays: 0 };
}
