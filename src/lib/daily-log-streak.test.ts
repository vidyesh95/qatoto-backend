import { describe, expect, it } from "vitest";

import {
  calendarDateIn,
  daysBetween,
  streakAfterLog,
  streakAsOf,
} from "#src/lib/daily-log-streak.js";

describe("daysBetween", () => {
  it("counts whole days in both directions", () => {
    expect(daysBetween("2026-07-24", "2026-07-25")).toBe(1);
    expect(daysBetween("2026-07-25", "2026-07-24")).toBe(-1);
    expect(daysBetween("2026-07-24", "2026-07-24")).toBe(0);
  });

  it("crosses month, year and leap-day boundaries exactly", () => {
    expect(daysBetween("2026-01-31", "2026-02-01")).toBe(1);
    expect(daysBetween("2026-12-31", "2027-01-01")).toBe(1);
    // 2028 is a leap year: Feb 28 → Mar 1 is two days, not one.
    expect(daysBetween("2028-02-28", "2028-03-01")).toBe(2);
    expect(daysBetween("2027-02-28", "2027-03-01")).toBe(1);
  });

  it("is unaffected by daylight saving, because a date-only value has no time of day", () => {
    // Spans the 2026 US DST transition. A local-time implementation would return 0.958…
    // here and round to the wrong day.
    expect(daysBetween("2026-03-07", "2026-03-09")).toBe(2);
  });

  it("refuses a malformed date rather than computing on it", () => {
    expect(() => daysBetween("2026-7-24", "2026-07-25")).toThrow(/ISO date/);
    expect(() => daysBetween("not-a-date", "2026-07-25")).toThrow(/ISO date/);
  });
});

describe("calendarDateIn", () => {
  it("resolves the same instant to different days in different zones", () => {
    // 23:30 UTC is already the next day in Nairobi and still the previous one in Lima —
    // the exact ambiguity project_stats.projectTimeZone exists to settle.
    const instant = new Date("2026-07-24T23:30:00Z");
    expect(calendarDateIn(instant, "UTC")).toBe("2026-07-24");
    expect(calendarDateIn(instant, "Africa/Nairobi")).toBe("2026-07-25");
    expect(calendarDateIn(instant, "America/Lima")).toBe("2026-07-24");
  });

  it("zero-pads without any reassembly of its own", () => {
    expect(calendarDateIn(new Date("2026-01-05T12:00:00Z"), "UTC")).toBe("2026-01-05");
  });
});

describe("streakAfterLog", () => {
  it("starts a streak at one, not zero", () => {
    expect(
      streakAfterLog({ lastDailyLogDate: null, dailyLogStreakDays: 0 }, "2026-07-24"),
    ).toStrictEqual({
      lastDailyLogDate: "2026-07-24",
      dailyLogStreakDays: 1,
    });
  });

  it("extends a streak on the next calendar day", () => {
    expect(
      streakAfterLog({ lastDailyLogDate: "2026-07-24", dailyLogStreakDays: 4 }, "2026-07-25"),
    ).toStrictEqual({
      lastDailyLogDate: "2026-07-25",
      dailyLogStreakDays: 5,
    });
  });

  it("restarts at one after a gap, never at zero", () => {
    // The member DID log today; a zero would say they did not.
    expect(
      streakAfterLog({ lastDailyLogDate: "2026-07-20", dailyLogStreakDays: 9 }, "2026-07-25"),
    ).toStrictEqual({
      lastDailyLogDate: "2026-07-25",
      dailyLogStreakDays: 1,
    });
  });

  it("does not double-count a second submit for the same day", () => {
    // The unique index already refuses a second log per member per day; this defends the
    // resubmit-after-failed-analysis path, which is a real retry.
    const state = { lastDailyLogDate: "2026-07-24", dailyLogStreakDays: 3 };
    expect(streakAfterLog(state, "2026-07-24")).toStrictEqual(state);
  });

  it("ignores a back-dated log entirely", () => {
    // Otherwise a member manufactures a 30-day streak on their last day by back-filling
    // a month — and a streak is a trust signal on a public project card.
    const state = { lastDailyLogDate: "2026-07-24", dailyLogStreakDays: 3 };
    expect(streakAfterLog(state, "2026-07-20")).toStrictEqual(state);
  });

  it("survives a month boundary", () => {
    expect(
      streakAfterLog({ lastDailyLogDate: "2026-07-31", dailyLogStreakDays: 12 }, "2026-08-01"),
    ).toStrictEqual({
      lastDailyLogDate: "2026-08-01",
      dailyLogStreakDays: 13,
    });
  });
});

describe("streakAsOf", () => {
  it("keeps a streak logged today", () => {
    const state = { lastDailyLogDate: "2026-07-24", dailyLogStreakDays: 6 };
    expect(streakAsOf(state, "2026-07-24")).toStrictEqual(state);
  });

  it("keeps a streak logged yesterday, because the job runs after midnight", () => {
    // A member who logs every evening must not lose a streak to the job's own schedule.
    const state = { lastDailyLogDate: "2026-07-24", dailyLogStreakDays: 6 };
    expect(streakAsOf(state, "2026-07-25")).toStrictEqual(state);
  });

  it("breaks a streak after two clear days", () => {
    expect(
      streakAsOf({ lastDailyLogDate: "2026-07-24", dailyLogStreakDays: 6 }, "2026-07-26"),
    ).toStrictEqual({
      lastDailyLogDate: "2026-07-24",
      dailyLogStreakDays: 0,
    });
  });

  it("keeps lastDailyLogDate when it breaks a streak", () => {
    // Clearing it would make tomorrow's run unable to reproduce today's answer, which is
    // exactly the replayability §4c rule 3 requires of a job.
    const broken = streakAsOf(
      { lastDailyLogDate: "2026-07-24", dailyLogStreakDays: 6 },
      "2026-07-30",
    );
    expect(broken.lastDailyLogDate).toBe("2026-07-24");
  });

  it("is idempotent — re-running the same day changes nothing", () => {
    const state = { lastDailyLogDate: "2026-07-24", dailyLogStreakDays: 6 };
    const once = streakAsOf(state, "2026-07-27");
    const twice = streakAsOf(once, "2026-07-27");
    expect(twice).toStrictEqual(once);
  });

  it("reports zero for a project that has never logged", () => {
    expect(
      streakAsOf({ lastDailyLogDate: null, dailyLogStreakDays: 0 }, "2026-07-24"),
    ).toStrictEqual({
      lastDailyLogDate: null,
      dailyLogStreakDays: 0,
    });
  });
});
