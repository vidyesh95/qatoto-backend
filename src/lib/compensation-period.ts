/**
 * The compensation period's calendar and its arithmetic
 * (R_AND_D_BACKEND_STRUCTURE.md §7A.3, §7A.4).
 *
 * A PERIOD IS ONE CALENDAR MONTH IN THE PROJECT'S OWN TIME ZONE. Without one, "a month"
 * is undefined for a distributed team and a period boundary lands in two different places
 * for two members — the same reason `project_stats.projectTimeZone` exists for the daily
 * log streak (§8), and this file reads the same column.
 *
 * EVERYTHING HERE IS PURE. No clock, no database, no `Result`. It takes a zone, some
 * dates and some integers, and returns integers. That is what makes §17 step 5b's
 * assertion possible: run the draft 100 times with rows shuffled and the lines are
 * byte-identical.
 *
 * NO FLOAT TOUCHES ANY OF IT (§4c rule 2). Every division goes through
 * `divRoundHalfAwayFromZero`, and the two divisions in this domain each apply their
 * denominator EXACTLY ONCE, at the end. `minutes / 60 × rate` is the trap §4c names by
 * name: a 20-minute log yields 0.333… and two servers disagree in the last cent.
 *
 * THE ONE HONEST CAVEAT ABOUT DETERMINISM. Resolving a calendar day in a named zone to a
 * UTC instant goes through `Intl`, which reads the host's ICU tzdata. A tzdata update that
 * changed a historical offset would move an open period's window by an hour. It cannot
 * touch a FINALIZED one: those lines are frozen by trigger and covered by the statement
 * hash, so a later data change breaks the chain loudly rather than restating a signed
 * number quietly. Open periods are redrawn nightly in any case.
 */

import { calendarDateIn, daysBetween, type IsoDate } from "#src/lib/daily-log-streak.js";
import { divRoundHalfAwayFromZero } from "#src/lib/money.js";

/** Re-exported so §7A callers do not have to import a §8 module to name a date. */
export type { IsoDate };
export { calendarDateIn };

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MINUTES_PER_HOUR = 60n;

function readIsoDateParts(isoDate: IsoDate): {
  readonly year: number;
  readonly month: number;
  readonly day: number;
} {
  if (!ISO_DATE_PATTERN.test(isoDate)) {
    // Unrecoverable programmer error (CLAUDE.md §3.3): every caller reads this out of a
    // `date` column or an already-parsed Zod field, so a malformed value means the
    // boundary parse was skipped rather than that a user typed something odd.
    throw new Error(`compensation-period: expected an ISO date (YYYY-MM-DD), got "${isoDate}"`);
  }
  const [year, month, day] = isoDate.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`compensation-period: could not read "${isoDate}" as a date`);
  }
  return { year, month, day };
}

function toIsoDate(year: number, month: number, day: number): IsoDate {
  const paddedMonth = String(month).padStart(2, "0");
  const paddedDay = String(day).padStart(2, "0");
  return `${String(year).padStart(4, "0")}-${paddedMonth}-${paddedDay}`;
}

/**
 * The zone's offset from UTC, in milliseconds, at a given instant.
 *
 * Reads the instant back through `Intl` in the target zone and reassembles the parts as
 * if they were UTC; the difference between that and the real instant IS the offset. This
 * is the standard technique and it needs no dependency — the alternative is a 400 kB
 * tzdata package to answer a question the platform already answers.
 */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);

  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    if (found === undefined) {
      throw new Error(`compensation-period: time zone "${timeZone}" produced no ${type} part`);
    }
    return Number(found.value);
  };

  // `hour: "2-digit"` with hour12:false emits 24 for midnight in some ICU versions.
  const hour = read("hour") % 24;
  const asIfUtc = Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    hour,
    read("minute"),
    read("second"),
  );

  // Seconds are the finest part `Intl` emits, so quantize the real instant the same way
  // before subtracting — otherwise the offset carries the instant's own milliseconds.
  const instantToSecond = Math.floor(instant.getTime() / 1000) * 1000;
  return asIfUtc - instantToSecond;
}

/**
 * The UTC instant at which a calendar day BEGINS in a named zone.
 *
 * TWO CANDIDATES, THEN A CHOICE — and the choice is the part that matters, because
 * naively iterating to a fixed point does not converge on a DST day. The first candidate
 * uses the offset in force at naive UTC midnight; the second re-reads the offset at that
 * guess. On an ordinary day they are equal. On a transition day they straddle it, and
 * picking either one blindly is wrong roughly twice a year.
 *
 * So each candidate is checked against the calendar date it actually lands on:
 *
 *   - Both land on the target day → take the EARLIER. This is the autumn fall-back, where
 *     midnight happens twice; the day starts at its first occurrence.
 *   - Exactly one lands on it → take that one.
 *   - NEITHER lands on it → take the LATER. This is a spring-forward that skips midnight
 *     outright, as Chile and Brazil have done: the day has no 00:00, so it begins at the
 *     transition instant. That is the correct reading of "the day starts here" and, more
 *     importantly, it is deterministic — the alternative is a hole in the accrual window.
 */
export function zonedDayStartInstant(isoDate: IsoDate, timeZone: string): Date {
  const { year, month, day } = readIsoDateParts(isoDate);
  const naiveUtcMs = Date.UTC(year, month - 1, day, 0, 0, 0);

  const firstGuessMs = naiveUtcMs - zoneOffsetMs(new Date(naiveUtcMs), timeZone);
  const refinedMs = naiveUtcMs - zoneOffsetMs(new Date(firstGuessMs), timeZone);

  const earlierMs = Math.min(firstGuessMs, refinedMs);
  const laterMs = Math.max(firstGuessMs, refinedMs);

  if (calendarDateIn(new Date(earlierMs), timeZone) === isoDate) {
    return new Date(earlierMs);
  }
  if (calendarDateIn(new Date(laterMs), timeZone) === isoDate) {
    return new Date(laterMs);
  }
  return new Date(laterMs);
}

/** The first day of the month containing `anchorDate`. */
export function monthStartDate(anchorDate: IsoDate): IsoDate {
  const { year, month } = readIsoDateParts(anchorDate);
  return toIsoDate(year, month, 1);
}

/** The first day of the month AFTER the one containing `anchorDate`. */
export function nextMonthStartDate(anchorDate: IsoDate): IsoDate {
  const { year, month } = readIsoDateParts(anchorDate);
  return month === 12 ? toIsoDate(year + 1, 1, 1) : toIsoDate(year, month + 1, 1);
}

export interface PeriodBounds {
  /** Inclusive. The first calendar day of the month, in `timeZone`. */
  readonly periodStartDate: IsoDate;
  /** EXCLUSIVE. The first day of the following month — the window is `[start, end)`. */
  readonly periodEndDate: IsoDate;
  readonly timeZone: string;
}

/**
 * The calendar month containing `anchorInstant`, as seen from `timeZone` (§7A.3).
 *
 * Half-open by construction: `periodEndDate` is the NEXT month's first day, never the
 * current month's last. A closed range would make a 31-day month and a 30-day month
 * behave differently at the boundary and put one day's effort in two statements.
 */
export function monthBoundsAt(anchorInstant: Date, timeZone: string): PeriodBounds {
  const anchorDate = calendarDateIn(anchorInstant, timeZone);
  return {
    periodStartDate: monthStartDate(anchorDate),
    periodEndDate: nextMonthStartDate(anchorDate),
    timeZone,
  };
}

/** The month AFTER `bounds`, for the job that opens the next period. */
export function nextMonthBounds(bounds: PeriodBounds): PeriodBounds {
  return {
    periodStartDate: bounds.periodEndDate,
    periodEndDate: nextMonthStartDate(bounds.periodEndDate),
    timeZone: bounds.timeZone,
  };
}

export interface PeriodWindow {
  /** Inclusive. The instant the period begins, in its own zone. */
  readonly startsAt: Date;
  /** EXCLUSIVE. Ledger entries are summed over `[startsAt, endsAt)`. */
  readonly endsAt: Date;
}

/**
 * The absolute instants a period covers — what the ledger sum actually filters on.
 *
 * ABSOLUTE BOUNDS, never a day count (§4c rule 3). A window stored as "the last 30 days"
 * is a different window every time it is read; a window stored as two instants is the
 * same window a year later, which is the whole point of a re-runnable draft.
 */
export function periodWindow(bounds: PeriodBounds): PeriodWindow {
  return {
    startsAt: zonedDayStartInstant(bounds.periodStartDate, bounds.timeZone),
    endsAt: zonedDayStartInstant(bounds.periodEndDate, bounds.timeZone),
  };
}

/** Whole calendar days in the period. 28, 29, 30 or 31 — never a DST-shortened 30.96. */
export function daysInPeriod(bounds: PeriodBounds): number {
  return daysBetween(bounds.periodStartDate, bounds.periodEndDate);
}

/** True once the period's last day has passed in its own zone — the close-job's gate. */
export function hasPeriodClosed(bounds: PeriodBounds, asOf: Date): boolean {
  return calendarDateIn(asOf, bounds.timeZone) >= bounds.periodEndDate;
}

export interface AgreementCoverage {
  /** When the agreement takes effect. Absolute instant, per §7A.2. */
  readonly effectiveFrom: Date;
  /** NULL = still in force. */
  readonly effectiveUntil: Date | null;
}

/**
 * How many days of the period an agreement actually covered (§7A.4).
 *
 * BOTH BOUNDS ARE READ AS CALENDAR DAYS IN THE PERIOD'S ZONE, and that choice is the
 * whole rule: an agreement effective from the 15th at 09:00 covers the 15th, and one that
 * ended on the 20th at 09:00 does not cover the 20th. `effectiveFrom` is inclusive and
 * `effectiveUntil` exclusive, matching the half-open convention of the period itself.
 *
 * Anything finer would be a lie about a monthly retainer: a flat monthly amount has no
 * hourly resolution, so prorating it to the minute would present precision the agreement
 * does not have. A member who joined on the 15th is owed half a month, and the proration
 * is STATED rather than left to a founder's arithmetic.
 *
 * Returns 0 for an agreement that does not overlap the period at all, never a negative.
 */
export function coveredDaysInPeriod(bounds: PeriodBounds, coverage: AgreementCoverage): number {
  const coverageStartDate = calendarDateIn(coverage.effectiveFrom, bounds.timeZone);
  const coverageEndDate =
    coverage.effectiveUntil === null
      ? null
      : calendarDateIn(coverage.effectiveUntil, bounds.timeZone);

  // String comparison IS date comparison for `YYYY-MM-DD`, which is exactly why §1 picked
  // that format: it sorts lexicographically and chronologically at once.
  const overlapStartDate =
    coverageStartDate > bounds.periodStartDate ? coverageStartDate : bounds.periodStartDate;
  const overlapEndDate =
    coverageEndDate !== null && coverageEndDate < bounds.periodEndDate
      ? coverageEndDate
      : bounds.periodEndDate;

  if (overlapEndDate <= overlapStartDate) {
    return 0;
  }
  return daysBetween(overlapStartDate, overlapEndDate);
}

/**
 * A monthly retainer, prorated by day count (§7A.4).
 *
 * ```text
 * gross = divRoundHalfAwayFromZero(monthlyAmountInCents × coveredDays, daysInPeriod)
 * ```
 *
 * The denominator is applied ONCE, at the end. Multiplying first and dividing last keeps
 * the whole calculation in exact integers; dividing first would round a per-day amount and
 * then multiply the rounding error by thirty.
 *
 * @throws if `daysInPeriod` is not positive — a period with no days is a bug in the
 *         caller's bounds, not an input a statement should silently price at zero.
 */
export function proratedRetainerCents(
  monthlyAmountInCents: bigint,
  coveredDays: number,
  totalDaysInPeriod: number,
): bigint {
  if (totalDaysInPeriod <= 0) {
    throw new Error(
      `proratedRetainerCents: a period must have at least one day, got ${totalDaysInPeriod}`,
    );
  }
  if (coveredDays <= 0) {
    return 0n;
  }
  if (coveredDays >= totalDaysInPeriod) {
    // The full month. Stated explicitly rather than left to `x × 31 / 31`, so a full
    // retainer can never pick up a rounding artifact from a denominator it did not need.
    return monthlyAmountInCents;
  }
  return divRoundHalfAwayFromZero(
    monthlyAmountInCents * BigInt(coveredDays),
    BigInt(totalDaysInPeriod),
  );
}

/**
 * Verified minutes priced at an accepted hourly rate (§7A.4).
 *
 * ```text
 * gross = divRoundHalfAwayFromZero(minutes × hourlyRateCentsPerHour, 60)
 * ```
 *
 * 60 IS APPLIED ONCE, AT THE END, and that is the entire point of this function existing
 * rather than being inlined. `minutes / 60 × rate` is float division: a 20-minute log
 * yields 0.333… and two servers disagree in the last cent (§4c rule 2).
 *
 * `minutes` is clamped at zero by the caller before it arrives — a reversal-inclusive sum
 * can go negative, and a period cannot owe negative wages. An over-payment is corrected by
 * superseding the period, never by a negative line (§7A.4).
 */
export function hourlyGrossCents(minutes: number, hourlyRateCentsPerHour: bigint): bigint {
  if (!Number.isInteger(minutes)) {
    throw new Error(`hourlyGrossCents: minutes must be an integer, got ${minutes}`);
  }
  if (minutes <= 0) {
    return 0n;
  }
  return divRoundHalfAwayFromZero(BigInt(minutes) * hourlyRateCentsPerHour, MINUTES_PER_HOUR);
}
