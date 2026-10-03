import { describe, expect, it } from "vitest";

import { utcDayStringOf, utcHourOf, utcIsoWeekStringOf } from "#src/lib/utc-day.js";

describe("utc-day", () => {
  describe("utcDayStringOf", () => {
    it("formats an instant as YYYY-MM-DD in UTC", () => {
      const instant = new Date("2026-10-03T18:45:00.000Z");
      expect(utcDayStringOf(instant)).toBe("2026-10-03");
    });

    it("respects UTC date even across local midnight boundaries", () => {
      // 23:30 UTC on Oct 3
      const lateInstant = new Date("2026-10-03T23:30:00.000Z");
      expect(utcDayStringOf(lateInstant)).toBe("2026-10-03");

      // 00:15 UTC on Oct 4
      const earlyInstant = new Date("2026-10-04T00:15:00.000Z");
      expect(utcDayStringOf(earlyInstant)).toBe("2026-10-04");
    });
  });

  describe("utcHourOf", () => {
    it("extracts the UTC hour as an integer 0..23", () => {
      expect(utcHourOf(new Date("2026-10-03T00:15:30.000Z"))).toBe(0);
      expect(utcHourOf(new Date("2026-10-03T12:00:00.000Z"))).toBe(12);
      expect(utcHourOf(new Date("2026-10-03T23:59:59.999Z"))).toBe(23);
    });
  });

  describe("utcIsoWeekStringOf", () => {
    it("computes the correct ISO-8601 week string for standard dates", () => {
      // 2026-10-03 is Saturday of week 40
      const instant = new Date("2026-10-03T12:00:00.000Z");
      expect(utcIsoWeekStringOf(instant)).toBe("2026-W40");
    });

    it("handles the beginning of the year where Thursday determines the week year", () => {
      // 2026-01-01 is a Thursday -> 2026-W01
      const jan1 = new Date("2026-01-01T10:00:00.000Z");
      expect(utcIsoWeekStringOf(jan1)).toBe("2026-W01");

      // 2026-01-04 is Sunday of week 1
      const jan4 = new Date("2026-01-04T10:00:00.000Z");
      expect(utcIsoWeekStringOf(jan4)).toBe("2026-W01");

      // 2026-01-05 is Monday of week 2
      const jan5 = new Date("2026-01-05T10:00:00.000Z");
      expect(utcIsoWeekStringOf(jan5)).toBe("2026-W02");
    });

    it("handles year transition days that belong to the previous year week", () => {
      // 2023-01-01 was a Sunday. Week 1 of 2023 started Jan 2. Jan 1 belonged to 2022-W52.
      const sun2023 = new Date("2023-01-01T12:00:00.000Z");
      expect(utcIsoWeekStringOf(sun2023)).toBe("2022-W52");
    });
  });
});
