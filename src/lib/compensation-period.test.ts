import { describe, expect, it } from "vitest";

import {
  calendarDateIn,
  coveredDaysInPeriod,
  daysInPeriod,
  hasPeriodClosed,
  hourlyGrossCents,
  monthBoundsAt,
  monthStartDate,
  nextMonthBounds,
  nextMonthStartDate,
  periodWindow,
  proratedRetainerCents,
  zonedDayStartInstant,
} from "#src/lib/compensation-period.js";

/**
 * R_AND_D_BACKEND_STRUCTURE.md §7A.4 and §17 step 5b.
 *
 * The assertions that matter are the boring-looking ones: 20 minutes at $120/h is EXACTLY
 * 4000 cents, and a member who joined on the 15th is owed a stated half-month rather than
 * whatever a founder's spreadsheet produced. Everything else in §7A is bookkeeping around
 * these two numbers.
 */

describe("month bounds", () => {
  it("is half-open — the end date is the NEXT month's first day", () => {
    const bounds = monthBoundsAt(new Date("2026-03-17T12:00:00Z"), "UTC");
    expect(bounds.periodStartDate).toBe("2026-03-01");
    expect(bounds.periodEndDate).toBe("2026-04-01");
    expect(daysInPeriod(bounds)).toBe(31);
  });

  it("rolls the year over in December", () => {
    expect(nextMonthStartDate("2026-12-14")).toBe("2027-01-01");
    expect(monthStartDate("2026-12-31")).toBe("2026-12-01");
  });

  it("knows February in a leap year and a common year", () => {
    expect(daysInPeriod(monthBoundsAt(new Date("2028-02-10T00:00:00Z"), "UTC"))).toBe(29);
    expect(daysInPeriod(monthBoundsAt(new Date("2026-02-10T00:00:00Z"), "UTC"))).toBe(28);
  });

  it("resolves the month from the PROJECT's zone, not the server's", () => {
    // 2026-04-01T02:00Z is still 31 March in Los Angeles and already 1 April in Nairobi.
    // Two members, one instant, two different statements — which is exactly why the zone
    // is a column and not an assumption.
    const instant = new Date("2026-04-01T02:00:00Z");
    expect(monthBoundsAt(instant, "America/Los_Angeles").periodStartDate).toBe("2026-03-01");
    expect(monthBoundsAt(instant, "Africa/Nairobi").periodStartDate).toBe("2026-04-01");
  });

  it("chains to the following month", () => {
    const march = monthBoundsAt(new Date("2026-03-17T12:00:00Z"), "Europe/Berlin");
    const april = nextMonthBounds(march);
    expect(april.periodStartDate).toBe("2026-04-01");
    expect(april.periodEndDate).toBe("2026-05-01");
    expect(april.timeZone).toBe("Europe/Berlin");
  });
});

describe("zonedDayStartInstant", () => {
  it("returns the UTC instant a day begins in a fixed-offset zone", () => {
    // Nairobi is UTC+3 year round, so 1 April begins at 21:00Z on 31 March.
    expect(zonedDayStartInstant("2026-04-01", "Africa/Nairobi").toISOString()).toBe("2026-03-31T21:00:00.000Z");
  });

  it("uses the offset in force ON THAT DAY, not the one at naive UTC midnight", () => {
    // New York is UTC-5 in January and UTC-4 in July. A single-pass implementation gets
    // one of these wrong, and the error is a whole hour of accrual at a month boundary.
    expect(zonedDayStartInstant("2026-01-01", "America/New_York").toISOString()).toBe("2026-01-01T05:00:00.000Z");
    expect(zonedDayStartInstant("2026-07-01", "America/New_York").toISOString()).toBe("2026-07-01T04:00:00.000Z");
  });

  it("survives a period that spans a DST transition", () => {
    // US DST starts 8 March 2026 and ends 1 November 2026. March begins on standard time
    // and ends on daylight time; the window must still be exactly one month long.
    const march = monthBoundsAt(new Date("2026-03-15T12:00:00Z"), "America/New_York");
    const window = periodWindow(march);
    expect(window.startsAt.toISOString()).toBe("2026-03-01T05:00:00.000Z");
    expect(window.endsAt.toISOString()).toBe("2026-04-01T04:00:00.000Z");
    // 31 calendar days, one hour short in absolute time — which is the correct answer and
    // the reason the retainer prorates on DAYS rather than on elapsed milliseconds.
    expect(daysInPeriod(march)).toBe(31);

    const october = monthBoundsAt(new Date("2026-10-15T12:00:00Z"), "Europe/Berlin");
    const berlinWindow = periodWindow(october);
    expect(berlinWindow.startsAt.toISOString()).toBe("2026-09-30T22:00:00.000Z");
    expect(berlinWindow.endsAt.toISOString()).toBe("2026-10-31T23:00:00.000Z");
  });

  it("lands on the first instant a skipped-midnight day actually has", () => {
    // Chile jumps 2026-09-06 straight from 00:00 to 01:00, so that day has no midnight.
    // The two candidates straddle the transition and NEITHER is 00:00 local: the earlier
    // one is still 23:00 on the 5th. Taking the later one starts the day at 01:00 local,
    // which is the first instant the day actually has — and, crucially, it is on the
    // right DATE, so the accrual window has no hole and no overlap.
    const start = zonedDayStartInstant("2026-09-06", "America/Santiago");
    expect(start.toISOString()).toBe("2026-09-06T04:00:00.000Z");
    expect(calendarDateIn(start, "America/Santiago")).toBe("2026-09-06");
    // One millisecond earlier is still the previous day. That is the boundary being
    // asserted, not the offset arithmetic.
    expect(calendarDateIn(new Date(start.getTime() - 1), "America/Santiago")).toBe("2026-09-05");
  });

  it("rejects a malformed date rather than guessing", () => {
    expect(() => zonedDayStartInstant("2026-4-1", "UTC")).toThrow(/ISO date/);
  });
});

describe("hasPeriodClosed", () => {
  const march = monthBoundsAt(new Date("2026-03-15T12:00:00Z"), "Africa/Nairobi");

  it("is false on the period's own last day", () => {
    expect(hasPeriodClosed(march, new Date("2026-03-31T20:00:00Z"))).toBe(false);
  });

  it("is true once the next month has begun IN THE PROJECT'S ZONE", () => {
    // 21:00Z on 31 March is already 1 April in Nairobi. A server closing on UTC would
    // leave this period accruing for three more hours of somebody else's April.
    expect(hasPeriodClosed(march, new Date("2026-03-31T21:00:00Z"))).toBe(true);
  });
});

describe("coveredDaysInPeriod", () => {
  const march = monthBoundsAt(new Date("2026-03-15T12:00:00Z"), "UTC");

  it("covers the whole period for an agreement that predates it and never ended", () => {
    expect(
      coveredDaysInPeriod(march, {
        effectiveFrom: new Date("2025-11-01T00:00:00Z"),
        effectiveUntil: null,
      }),
    ).toBe(31);
  });

  it("counts the joining day itself", () => {
    // Effective from the 15th at 09:00 → the member is covered FOR the 15th, so 17 of
    // March's 31 days. Not 16: an agreement in force during a day covers that day.
    expect(
      coveredDaysInPeriod(march, {
        effectiveFrom: new Date("2026-03-15T09:00:00Z"),
        effectiveUntil: null,
      }),
    ).toBe(17);
  });

  it("excludes the ending day, matching the half-open convention", () => {
    expect(
      coveredDaysInPeriod(march, {
        effectiveFrom: new Date("2026-03-01T00:00:00Z"),
        effectiveUntil: new Date("2026-03-20T09:00:00Z"),
      }),
    ).toBe(19);
  });

  it("returns zero — never a negative — for an agreement outside the period", () => {
    expect(
      coveredDaysInPeriod(march, {
        effectiveFrom: new Date("2026-05-01T00:00:00Z"),
        effectiveUntil: null,
      }),
    ).toBe(0);
    expect(
      coveredDaysInPeriod(march, {
        effectiveFrom: new Date("2025-01-01T00:00:00Z"),
        effectiveUntil: new Date("2025-06-01T00:00:00Z"),
      }),
    ).toBe(0);
  });

  it("reads both bounds in the PERIOD's zone", () => {
    const nairobiMarch = monthBoundsAt(new Date("2026-03-15T12:00:00Z"), "Africa/Nairobi");
    // 2026-03-14T22:00Z is already the 15th in Nairobi, so coverage starts on the 15th.
    expect(
      coveredDaysInPeriod(nairobiMarch, {
        effectiveFrom: new Date("2026-03-14T22:00:00Z"),
        effectiveUntil: null,
      }),
    ).toBe(17);
  });
});

describe("proratedRetainerCents", () => {
  it("pays a full month without touching the divisor", () => {
    expect(proratedRetainerCents(600_000n, 31, 31)).toBe(600_000n);
  });

  it("owes a member who joined on the 15th their stated part-month", () => {
    // $6,000 monthly, 17 of 31 days: 600000 × 17 / 31 = 329032.25… → 329032.
    expect(proratedRetainerCents(600_000n, 17, 31)).toBe(329_032n);
  });

  it("rounds exact halves AWAY from zero, matching Postgres", () => {
    // 100 × 1 / 8 = 12.5 → 13, never 12.
    expect(proratedRetainerCents(100n, 1, 8)).toBe(13n);
  });

  it("is zero for no coverage and never negative", () => {
    expect(proratedRetainerCents(600_000n, 0, 31)).toBe(0n);
    expect(proratedRetainerCents(600_000n, -4, 31)).toBe(0n);
  });

  it("multiplies before dividing, so the error never compounds across days", () => {
    // A per-day rounding of 100/31 = 3.2258 → 3 would pay 3 × 30 = 90 for 30 days. The
    // correct answer is 97: the whole point of applying the denominator once, at the end.
    expect(proratedRetainerCents(100n, 30, 31)).toBe(97n);
  });

  it("holds past 2^53, where a JS number would already be lying", () => {
    expect(proratedRetainerCents(9_007_199_254_740_993n, 30, 30)).toBe(9_007_199_254_740_993n);
  });

  it("throws on a period with no days rather than pricing it at zero", () => {
    expect(() => proratedRetainerCents(600_000n, 1, 0)).toThrow(/at least one day/);
  });
});

describe("hourlyGrossCents", () => {
  it("prices 20 minutes at $120/h as exactly 4000 cents", () => {
    // THE §4c TRAP, asserted. minutes/60 is 0.333…; minutes × rate / 60 is exact.
    expect(hourlyGrossCents(20, 12_000n)).toBe(4_000n);
  });

  it("prices a whole hour and a whole day exactly", () => {
    expect(hourlyGrossCents(60, 12_000n)).toBe(12_000n);
    expect(hourlyGrossCents(480, 12_000n)).toBe(96_000n);
  });

  it("rounds an exact half cent away from zero", () => {
    // 1 minute at 90 cents/hour = 1.5 cents → 2.
    expect(hourlyGrossCents(1, 90n)).toBe(2n);
  });

  it("returns zero for a clamped-negative or empty minute sum", () => {
    expect(hourlyGrossCents(0, 12_000n)).toBe(0n);
    expect(hourlyGrossCents(-45, 12_000n)).toBe(0n);
  });

  it("throws on fractional minutes rather than silently truncating", () => {
    expect(() => hourlyGrossCents(20.5, 12_000n)).toThrow(/integer/);
  });

  it("is deterministic across 1,000 shuffled evaluations", () => {
    // §17 step 5b in miniature: the same inputs in any order produce the same integer.
    const inputs = Array.from({ length: 1_000 }, (_unused, index) => index + 1);
    const forward = inputs.map((minutes) => hourlyGrossCents(minutes, 12_345n));
    const backward = inputs.toReversed().map((minutes) => hourlyGrossCents(minutes, 12_345n));
    expect(forward).toStrictEqual(backward.toReversed());
  });
});
