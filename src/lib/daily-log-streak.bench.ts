import { withCodSpeed } from "@codspeed/tinybench-plugin";
import { Bench } from "tinybench";

import {
  calendarDateIn,
  daysBetween,
  streakAfterLog,
  streakAsOf,
  type IsoDate,
  type StreakState,
} from "#src/lib/daily-log-streak.js";
import { BENCHMARK_OPTIONS } from "#src/test-support/bench-fixtures.js";

/**
 * The streak fold, and the one call in it that is not integer arithmetic.
 *
 * `calendarDateIn` constructs an `Intl.DateTimeFormat` PER CALL. That is correct — the zone comes
 * from the project row and a cached formatter would be a cache keyed on a value the caller owns —
 * but it is also, by a wide margin, the most expensive thing in this module, and the nightly decay
 * job calls it once per project. Measuring it next to the arithmetic makes the ratio visible: if a
 * change ever makes the fold matter more than the formatter, it will show up here first.
 *
 * `streakAsOf` is the job's own shape — state in, state out, no log — and `streakAfterLog` folded
 * over a year of logs is the write path replayed.
 */

const PROJECT_TIME_ZONES: readonly string[] = [
  "UTC",
  "Asia/Kolkata",
  "America/Lima",
  "Africa/Nairobi",
  "Europe/Berlin",
  "Australia/Sydney",
  "America/Sao_Paulo",
  "Asia/Tokyo",
];

const SUBMISSION_INSTANTS: readonly Date[] = Array.from(
  { length: 200 },
  (unusedValue, dayIndex) => new Date(Date.UTC(2026, 0, 1, 18, 30, 0) + dayIndex * 86_400_000),
);

/** A year of logs with occasional gaps, which is what makes the fold take more than one branch. */
const LOG_DATES: readonly IsoDate[] = Array.from({ length: 365 }, (unusedValue, dayIndex) =>
  new Date(Date.UTC(2026, 0, 1) + dayIndex * 86_400_000).toISOString().slice(0, 10),
).filter((unusedDate, dayIndex) => dayIndex % 17 !== 0);

const EMPTY_STREAK: StreakState = { lastDailyLogDate: null, dailyLogStreakDays: 0 };
const LIVE_STREAK: StreakState = { lastDailyLogDate: "2026-06-11", dailyLogStreakDays: 48 };

export const dailyLogStreakBenchmarks = withCodSpeed(
  new Bench({ name: "daily-log-streak", ...BENCHMARK_OPTIONS }),
);

dailyLogStreakBenchmarks.add("calendarDateIn — 200 instants across 8 project time zones", () => {
  for (const [instantIndex, instant] of SUBMISSION_INSTANTS.entries()) {
    calendarDateIn(instant, PROJECT_TIME_ZONES[instantIndex % PROJECT_TIME_ZONES.length] ?? "UTC");
  }
});

dailyLogStreakBenchmarks.add("daysBetween over a year of log dates", () => {
  for (let dayIndex = 1; dayIndex < LOG_DATES.length; dayIndex += 1) {
    daysBetween(LOG_DATES[dayIndex - 1] ?? "2026-01-01", LOG_DATES[dayIndex] ?? "2026-01-02");
  }
});

dailyLogStreakBenchmarks.add("streakAfterLog folded over a year of logs", () => {
  let state = EMPTY_STREAK;
  for (const logDate of LOG_DATES) {
    state = streakAfterLog(state, logDate);
  }
  return state;
});

dailyLogStreakBenchmarks.add("streakAsOf — the nightly decay pass over 365 projects", () => {
  for (const todayDate of LOG_DATES) {
    streakAsOf(LIVE_STREAK, todayDate);
  }
});
