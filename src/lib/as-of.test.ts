import { afterEach, describe, expect, it, vi } from "vitest";

import { truncateToUtcDayStart, truncateToUtcHourStart, wholeDaysBetweenUtcDayStarts } from "#src/lib/as-of.js";

const MILLISECONDS_PER_UTC_DAY = 86_400_000;

/** Builds a UTC day start without going through the module under test. */
function utcDayStartOf(year: number, monthIndex: number, dayOfMonth: number): Date {
  return new Date(Date.UTC(year, monthIndex, dayOfMonth));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("truncateToUtcDayStart", () => {
  const cases: ReadonlyArray<{
    readonly input: string;
    readonly expected: string;
    readonly why: string;
  }> = [
    { input: "2025-06-15T13:47:23.512Z", expected: "2025-06-15T00:00:00.000Z", why: "mid-day" },
    {
      input: "2025-06-15T00:00:00.000Z",
      expected: "2025-06-15T00:00:00.000Z",
      why: "already a day start is a fixed point",
    },
    {
      input: "2025-06-15T23:59:59.999Z",
      expected: "2025-06-15T00:00:00.000Z",
      why: "last millisecond belongs to the day that is ENDING",
    },
    {
      input: "2025-06-15T00:00:00.001Z",
      expected: "2025-06-15T00:00:00.000Z",
      why: "first millisecond after midnight",
    },
    {
      input: "1970-01-01T00:00:00.000Z",
      expected: "1970-01-01T00:00:00.000Z",
      why: "the epoch itself",
    },
    {
      input: "1969-12-31T18:30:00.000Z",
      expected: "1969-12-31T00:00:00.000Z",
      why: "negative epoch must truncate DOWN, not toward zero",
    },
    { input: "2024-02-29T11:00:00.000Z", expected: "2024-02-29T00:00:00.000Z", why: "leap day" },
    {
      input: "2025-12-31T23:00:00.000Z",
      expected: "2025-12-31T00:00:00.000Z",
      why: "year boundary",
    },
  ];

  for (const { input, expected, why } of cases) {
    it(`${input} truncates to ${expected} (${why})`, () => {
      expect(truncateToUtcDayStart(new Date(input)).toISOString()).toBe(expected);
    });
  }

  it("returns a NEW Date and never mutates the input", () => {
    const originalInstant = new Date("2025-06-15T13:47:23.512Z");
    const truncated = truncateToUtcDayStart(originalInstant);

    expect(truncated).not.toBe(originalInstant);
    expect(originalInstant.toISOString()).toBe("2025-06-15T13:47:23.512Z");
  });

  it("is idempotent — truncating a truncated instant changes nothing", () => {
    const once = truncateToUtcDayStart(new Date("2025-06-15T13:47:23.512Z"));
    expect(truncateToUtcDayStart(once).getTime()).toBe(once.getTime());
  });

  it("does not fall into the Date.UTC two-digit-year remap", () => {
    // Date.UTC(50, 0, 1) is 1950, not the year 50. getUTCFullYear returns the literal 50,
    // so a naive round-trip moves the instant by 1,900 years and still returns a valid Date.
    const yearFiftyInstant = new Date("0050-03-04T09:15:00.000Z");
    expect(truncateToUtcDayStart(yearFiftyInstant).toISOString()).toBe("0050-03-04T00:00:00.000Z");
  });

  it("survives the one two-digit year whose LEAP RULE differs from its remap target", () => {
    // Year 0 is divisible by 400 and IS a leap year, so 0000-02-29 exists. Its Date.UTC
    // remap target 1900 is divisible by 100 but not 400 and is NOT, so Date.UTC(0, 1, 29)
    // overflows to 1900-03-01. A repair that sets only the year then yields 0000-03-01 — a
    // valid Date on the wrong calendar day. This is the only such year in 0-99.
    const leapDayOfYearZero = new Date("0000-02-29T13:47:23.512Z");

    expect(leapDayOfYearZero.toISOString()).toBe("0000-02-29T13:47:23.512Z"); // input really exists
    expect(truncateToUtcDayStart(leapDayOfYearZero).toISOString()).toBe("0000-02-29T00:00:00.000Z");
    expect(truncateToUtcHourStart(leapDayOfYearZero).toISOString()).toBe("0000-02-29T13:00:00.000Z");
  });

  it("preserves the calendar day for EVERY date in the 0-99 remap window", () => {
    // Exhaustive over the whole trap window rather than spot-checked: truncation must never
    // move an instant to a different Y/M/D, whatever the remap target's calendar does.
    for (let year = 0; year <= 99; year += 1) {
      for (let monthIndex = 0; monthIndex < 12; monthIndex += 1) {
        for (let dayOfMonth = 1; dayOfMonth <= 31; dayOfMonth += 1) {
          const instant = new Date(Date.UTC(2000, 0, 1, 9, 30, 45, 123));
          instant.setUTCFullYear(year, monthIndex, dayOfMonth);

          // Skip combinations that are not real dates (e.g. Feb 30) rather than asserting
          // on whatever they rolled over to.
          const isRealCalendarDate =
            instant.getUTCFullYear() === year &&
            instant.getUTCMonth() === monthIndex &&
            instant.getUTCDate() === dayOfMonth;
          if (!isRealCalendarDate) continue;

          const dayStart = truncateToUtcDayStart(instant);
          expect([dayStart.getUTCFullYear(), dayStart.getUTCMonth(), dayStart.getUTCDate()]).toEqual([
            year,
            monthIndex,
            dayOfMonth,
          ]);
          expect([
            dayStart.getUTCHours(),
            dayStart.getUTCMinutes(),
            dayStart.getUTCSeconds(),
            dayStart.getUTCMilliseconds(),
          ]).toEqual([0, 0, 0, 0]);

          const hourStart = truncateToUtcHourStart(instant);
          expect([
            hourStart.getUTCFullYear(),
            hourStart.getUTCMonth(),
            hourStart.getUTCDate(),
            hourStart.getUTCHours(),
          ]).toEqual([year, monthIndex, dayOfMonth, 9]);
        }
      }
    }
  });

  it("throws on an Invalid Date rather than propagating NaN", () => {
    expect(() => truncateToUtcDayStart(new Date("not-a-timestamp"))).toThrow(/must be a valid Date/);
  });
});

describe("truncateToUtcHourStart", () => {
  const cases: ReadonlyArray<{
    readonly input: string;
    readonly expected: string;
    readonly why: string;
  }> = [
    { input: "2025-06-15T13:47:23.512Z", expected: "2025-06-15T13:00:00.000Z", why: "mid-hour" },
    {
      input: "2025-06-15T13:00:00.000Z",
      expected: "2025-06-15T13:00:00.000Z",
      why: "already an hour start is a fixed point",
    },
    {
      input: "2025-06-15T13:59:59.999Z",
      expected: "2025-06-15T13:00:00.000Z",
      why: "last millisecond of the hour",
    },
    {
      input: "2025-06-15T00:00:00.000Z",
      expected: "2025-06-15T00:00:00.000Z",
      why: "midnight is also an hour start",
    },
    {
      input: "2025-06-15T23:30:00.000Z",
      expected: "2025-06-15T23:00:00.000Z",
      why: "final hour of the day",
    },
    {
      input: "1969-12-31T18:30:00.000Z",
      expected: "1969-12-31T18:00:00.000Z",
      why: "negative epoch truncates DOWN",
    },
  ];

  for (const { input, expected, why } of cases) {
    it(`${input} truncates to ${expected} (${why})`, () => {
      expect(truncateToUtcHourStart(new Date(input)).toISOString()).toBe(expected);
    });
  }

  it("returns a NEW Date and never mutates the input", () => {
    const originalInstant = new Date("2025-06-15T13:47:23.512Z");
    const truncated = truncateToUtcHourStart(originalInstant);

    expect(truncated).not.toBe(originalInstant);
    expect(originalInstant.toISOString()).toBe("2025-06-15T13:47:23.512Z");
  });

  it("agrees with truncateToUtcDayStart at every hour of a day", () => {
    // Composition check: truncating to the hour and then to the day must equal truncating
    // straight to the day, or the two grains disagree about which day an instant is in.
    for (let hourOfDay = 0; hourOfDay < 24; hourOfDay += 1) {
      const instant = new Date(Date.UTC(2025, 5, 15, hourOfDay, 31, 7, 3));
      expect(truncateToUtcDayStart(truncateToUtcHourStart(instant)).toISOString()).toBe(
        truncateToUtcDayStart(instant).toISOString(),
      );
    }
  });

  it("does not fall into the Date.UTC two-digit-year remap", () => {
    const yearFiftyInstant = new Date("0050-03-04T09:15:00.000Z");
    expect(truncateToUtcHourStart(yearFiftyInstant).toISOString()).toBe("0050-03-04T09:00:00.000Z");
  });

  it("throws on an Invalid Date rather than propagating NaN", () => {
    expect(() => truncateToUtcHourStart(new Date("not-a-timestamp"))).toThrow(/must be a valid Date/);
  });
});

describe("truncation is zone-independent", () => {
  // The regression guard that matters most in this file. Date.UTC and getUTC* are
  // zone-independent by definition, so these assertions hold today for free — their job is
  // to FAIL the moment someone "simplifies" the implementation to getFullYear / getHours,
  // which would make every worker's asOf depend on its host's TZ.
  const zonesToProbe: readonly string[] = ["UTC", "America/New_York", "Asia/Kolkata", "Pacific/Kiritimati"];

  // 04:30Z on the US spring-forward date: America/New_York is on the previous CALENDAR DAY
  // at this instant, so a local-zone implementation returns a different day entirely.
  const probeInstant = new Date("2025-03-09T04:30:00.000Z");

  it("proves the TZ stub actually changes local-zone reads (otherwise the guard is vacuous)", () => {
    vi.stubEnv("TZ", "UTC");
    const utcLocalDate = probeInstant.getDate();
    const utcLocalHours = probeInstant.getHours();

    vi.stubEnv("TZ", "America/New_York");
    const newYorkLocalDate = probeInstant.getDate();
    const newYorkLocalHours = probeInstant.getHours();

    // If this ever stops holding, the stub is a no-op and the tests below prove nothing.
    expect(newYorkLocalHours).not.toBe(utcLocalHours);
    expect(newYorkLocalDate).not.toBe(utcLocalDate);
  });

  it("returns an IDENTICAL day start under every probed TZ", () => {
    const results = zonesToProbe.map((zoneName) => {
      vi.stubEnv("TZ", zoneName);
      return truncateToUtcDayStart(probeInstant).toISOString();
    });

    expect(results).toEqual(zonesToProbe.map(() => "2025-03-09T00:00:00.000Z"));
  });

  it("returns an IDENTICAL hour start under every probed TZ", () => {
    const results = zonesToProbe.map((zoneName) => {
      vi.stubEnv("TZ", zoneName);
      return truncateToUtcHourStart(probeInstant).toISOString();
    });

    expect(results).toEqual(zonesToProbe.map(() => "2025-03-09T04:00:00.000Z"));
  });

  it("returns an IDENTICAL day count under every probed TZ, across both 2025 US DST transitions", () => {
    // 2025-03-09 (spring forward) and 2025-11-02 (fall back) both fall inside this span, so
    // a local-zone day count would be off by the two shifted hours.
    const springForwardDay = utcDayStartOf(2025, 2, 9);
    const fallBackDay = utcDayStartOf(2025, 10, 2);

    const results = zonesToProbe.map((zoneName) => {
      vi.stubEnv("TZ", zoneName);
      return wholeDaysBetweenUtcDayStarts(springForwardDay, fallBackDay);
    });

    expect(results).toEqual(zonesToProbe.map(() => 238));
  });
});

describe("wholeDaysBetweenUtcDayStarts", () => {
  it("counts zero days between an instant and itself", () => {
    const dayStart = utcDayStartOf(2025, 5, 15);
    expect(wholeDaysBetweenUtcDayStarts(dayStart, dayStart)).toBe(0);
  });

  it("counts one day across a single midnight", () => {
    expect(wholeDaysBetweenUtcDayStarts(utcDayStartOf(2025, 5, 15), utcDayStartOf(2025, 5, 16))).toBe(1);
  });

  it("counts a leap-year February correctly", () => {
    // 2024 is a leap year: Feb has 29 days.
    expect(wholeDaysBetweenUtcDayStarts(utcDayStartOf(2024, 1, 1), utcDayStartOf(2024, 2, 1))).toBe(29);
    expect(wholeDaysBetweenUtcDayStarts(utcDayStartOf(2025, 1, 1), utcDayStartOf(2025, 2, 1))).toBe(28);
  });

  it("counts 366 days across a leap year and 365 across a common year", () => {
    expect(wholeDaysBetweenUtcDayStarts(utcDayStartOf(2024, 0, 1), utcDayStartOf(2025, 0, 1))).toBe(366);
    expect(wholeDaysBetweenUtcDayStarts(utcDayStartOf(2025, 0, 1), utcDayStartOf(2026, 0, 1))).toBe(365);
  });

  it("spans the epoch, where the two operands have opposite signs", () => {
    expect(wholeDaysBetweenUtcDayStarts(utcDayStartOf(1969, 11, 31), utcDayStartOf(1970, 0, 2))).toBe(2);
  });

  // --- Negative results -----------------------------------------------------------

  const negativeCases: ReadonlyArray<{
    readonly earlier: Date;
    readonly later: Date;
    readonly expected: number;
    readonly why: string;
  }> = [
    {
      earlier: utcDayStartOf(2025, 5, 16),
      later: utcDayStartOf(2025, 5, 15),
      expected: -1,
      why: "one day backwards",
    },
    {
      earlier: utcDayStartOf(2025, 0, 1),
      later: utcDayStartOf(2024, 0, 1),
      expected: -366,
      why: "backwards across a leap year",
    },
    {
      earlier: utcDayStartOf(1970, 0, 2),
      later: utcDayStartOf(1969, 11, 31),
      expected: -2,
      why: "backwards across the epoch",
    },
  ];

  for (const { earlier, later, expected, why } of negativeCases) {
    it(`returns ${expected} when later precedes earlier (${why})`, () => {
      expect(wholeDaysBetweenUtcDayStarts(earlier, later)).toBe(expected);
    });
  }

  it("never returns negative zero", () => {
    // Object.is(-0, 0) is false, so a -0 leaking out would compare unequal to a stored 0
    // in any Map key, Set member, or Object.is check — while printing as "0" everywhere a
    // human would look. The bigint path cannot produce it (Number(0n) is +0); a float path
    // using Math.round or Math.floor on a negative span can.
    const dayStart = utcDayStartOf(2025, 5, 15);

    expect(Object.is(wholeDaysBetweenUtcDayStarts(dayStart, dayStart), 0)).toBe(true);
    expect(Object.is(wholeDaysBetweenUtcDayStarts(dayStart, dayStart), -0)).toBe(false);
    // The trap this rules out, spelled out: Math.round of a negative near-zero span is -0.
    expect(Object.is(Math.round(-0.4), -0)).toBe(true);
  });

  it("is exactly antisymmetric — swapping the arguments negates the result", () => {
    const firstDay = utcDayStartOf(2025, 0, 1);
    const secondDay = utcDayStartOf(2025, 8, 30);

    expect(wholeDaysBetweenUtcDayStarts(secondDay, firstDay)).toBe(-wholeDaysBetweenUtcDayStarts(firstDay, secondDay));
  });

  // --- The boundary guard ---------------------------------------------------------

  const nonBoundaryInstants: ReadonlyArray<{ readonly instant: Date; readonly why: string }> = [
    { instant: new Date("2025-06-15T12:00:00.000Z"), why: "midday" },
    { instant: new Date("2025-06-15T00:00:00.001Z"), why: "one millisecond past midnight" },
    { instant: new Date("2025-06-14T23:59:59.999Z"), why: "one millisecond before midnight" },
    { instant: new Date("2025-06-15T00:00:01.000Z"), why: "one second past midnight" },
    {
      instant: new Date("1969-12-31T23:59:59.999Z"),
      why: "negative epoch, one millisecond before the epoch",
    },
  ];

  for (const { instant, why } of nonBoundaryInstants) {
    it(`throws when EARLIER is not on a UTC day boundary (${why})`, () => {
      expect(() => wholeDaysBetweenUtcDayStarts(instant, utcDayStartOf(2025, 5, 20))).toThrow(
        /earlier must be exactly on a UTC day boundary/,
      );
    });

    it(`throws when LATER is not on a UTC day boundary (${why})`, () => {
      expect(() => wholeDaysBetweenUtcDayStarts(utcDayStartOf(2025, 5, 1), instant)).toThrow(
        /later must be exactly on a UTC day boundary/,
      );
    });
  }

  it("throws on an Invalid Date in either position", () => {
    const invalidInstant = new Date("not-a-timestamp");
    const validDayStart = utcDayStartOf(2025, 5, 15);

    expect(() => wholeDaysBetweenUtcDayStarts(invalidInstant, validDayStart)).toThrow(/earlier must be a valid Date/);
    expect(() => wholeDaysBetweenUtcDayStarts(validDayStart, invalidInstant)).toThrow(/later must be a valid Date/);
  });

  it("accepts anything truncateToUtcDayStart produced — the two functions agree on 'boundary'", () => {
    // The guard would be a landmine if the module's own truncator could emit an instant the
    // guard rejects. Walk a full year of arbitrary times of day and prove it cannot.
    const referenceDay = utcDayStartOf(2025, 0, 1);

    for (let dayOffset = 0; dayOffset < 365; dayOffset += 1) {
      const arbitraryTimeOfDay = new Date(
        Date.UTC(2025, 0, 1, dayOffset % 24, (dayOffset * 7) % 60, (dayOffset * 13) % 60, dayOffset % 1000) +
          dayOffset * MILLISECONDS_PER_UTC_DAY,
      );

      expect(() => wholeDaysBetweenUtcDayStarts(referenceDay, truncateToUtcDayStart(arbitraryTimeOfDay))).not.toThrow();
    }
  });

  // --- Exactness across a full year -----------------------------------------------

  it("divides exactly across all 365 day pairs of 2025, including both DST transitions", () => {
    // Run the whole sweep with the process in a DST zone: 2025-03-09 and 2025-11-02 are
    // both inside the span, and each shifts local wall-clock time by an hour. UTC has no
    // such shift, so every difference stays an exact multiple of 86,400,000 ms.
    vi.stubEnv("TZ", "America/New_York");

    const yearStart = utcDayStartOf(2025, 0, 1);

    for (let dayOffset = 0; dayOffset <= 365; dayOffset += 1) {
      const dayStart = new Date(yearStart.getTime() + dayOffset * MILLISECONDS_PER_UTC_DAY);

      // Exactness: the difference is an exact multiple of a day, with no remainder.
      expect((dayStart.getTime() - yearStart.getTime()) % MILLISECONDS_PER_UTC_DAY).toBe(0);
      expect(wholeDaysBetweenUtcDayStarts(yearStart, dayStart)).toBe(dayOffset);
      // `dayOffset === 0 ? 0 : -dayOffset`, not `-dayOffset`: at offset 0 the literal
      // `-0` is a DIFFERENT value under Object.is, and the function is specified to
      // return +0. See the dedicated negative-zero test below.
      expect(wholeDaysBetweenUtcDayStarts(dayStart, yearStart)).toBe(dayOffset === 0 ? 0 : -dayOffset);

      // Each generated day start is itself a fixed point of the truncator.
      expect(truncateToUtcDayStart(dayStart).getTime()).toBe(dayStart.getTime());
    }
  });

  it("counts exactly 1 between every pair of consecutive days in 2025", () => {
    vi.stubEnv("TZ", "America/New_York");

    const yearStart = utcDayStartOf(2025, 0, 1);

    for (let dayOffset = 0; dayOffset < 365; dayOffset += 1) {
      const currentDay = new Date(yearStart.getTime() + dayOffset * MILLISECONDS_PER_UTC_DAY);
      const nextDay = new Date(yearStart.getTime() + (dayOffset + 1) * MILLISECONDS_PER_UTC_DAY);

      expect(wholeDaysBetweenUtcDayStarts(currentDay, nextDay)).toBe(1);
    }
  });

  it("is additive — a span split at any point sums back to the whole", () => {
    const yearStart = utcDayStartOf(2025, 0, 1);
    const yearEnd = utcDayStartOf(2026, 0, 1);

    for (let splitOffset = 0; splitOffset <= 365; splitOffset += 1) {
      const splitDay = new Date(yearStart.getTime() + splitOffset * MILLISECONDS_PER_UTC_DAY);

      expect(wholeDaysBetweenUtcDayStarts(yearStart, splitDay) + wholeDaysBetweenUtcDayStarts(splitDay, yearEnd)).toBe(
        wholeDaysBetweenUtcDayStarts(yearStart, yearEnd),
      );
    }
  });

  it("stays exact at the far ends of the representable Date range", () => {
    // ±8.64e15 ms is the whole Date range; the day count still lands well inside the safe
    // integer range, and bigint keeps the subtraction exact where a float would not.
    const earliestRepresentableDay = new Date(-8_640_000_000_000_000);
    const latestRepresentableDay = new Date(8_640_000_000_000_000);

    expect(wholeDaysBetweenUtcDayStarts(earliestRepresentableDay, latestRepresentableDay)).toBe(200_000_000);
    expect(wholeDaysBetweenUtcDayStarts(latestRepresentableDay, earliestRepresentableDay)).toBe(-200_000_000);
  });

  // --- Determinism ------------------------------------------------------------------

  it("is a pure function of its arguments — 500 varied spans give identical results on re-run", () => {
    // §4c rule 3: a job re-run must reproduce its result exactly. Variation is derived from
    // the loop index, never Math.random(), so any failure here is reproducible verbatim.
    const zonesToProbe: readonly string[] = ["UTC", "America/New_York", "Asia/Kolkata", "Australia/Lord_Howe"];
    const epochDay = utcDayStartOf(1970, 0, 1);

    for (let iteration = 0; iteration < 500; iteration += 1) {
      const earlierOffset = ((iteration * 137) % 20_000) - 10_000;
      const laterOffset = ((iteration * 761) % 20_000) - 10_000;

      const earlierDay = new Date(epochDay.getTime() + earlierOffset * MILLISECONDS_PER_UTC_DAY);
      const laterDay = new Date(epochDay.getTime() + laterOffset * MILLISECONDS_PER_UTC_DAY);

      const expectedDayCount = laterOffset - earlierOffset;

      for (const zoneName of zonesToProbe) {
        vi.stubEnv("TZ", zoneName);
        expect(wholeDaysBetweenUtcDayStarts(earlierDay, laterDay)).toBe(expectedDayCount);
      }
    }
  });

  it("truncation is a pure function too — 500 varied instants truncate identically in every zone", () => {
    const zonesToProbe: readonly string[] = ["UTC", "America/New_York", "Asia/Kolkata", "Australia/Lord_Howe"];
    const epochDay = utcDayStartOf(1970, 0, 1);

    for (let iteration = 0; iteration < 500; iteration += 1) {
      const instant = new Date(
        epochDay.getTime() +
          (((iteration * 977) % 20_000) - 10_000) * MILLISECONDS_PER_UTC_DAY +
          ((iteration * 3_600_017) % MILLISECONDS_PER_UTC_DAY),
      );

      const dayStarts = zonesToProbe.map((zoneName) => {
        vi.stubEnv("TZ", zoneName);
        return truncateToUtcDayStart(instant).toISOString();
      });
      const hourStarts = zonesToProbe.map((zoneName) => {
        vi.stubEnv("TZ", zoneName);
        return truncateToUtcHourStart(instant).toISOString();
      });

      expect(new Set(dayStarts).size).toBe(1);
      expect(new Set(hourStarts).size).toBe(1);

      // And the day start is always a legal input to the day-count guard.
      expect(() => wholeDaysBetweenUtcDayStarts(epochDay, truncateToUtcDayStart(instant))).not.toThrow();
    }
  });
});
