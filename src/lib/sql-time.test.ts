import { describe, expect, it } from "vitest";

import { utcDateFromRow, utcTimestamp } from "#src/lib/sql-time.js";

describe("sql-time", () => {
  describe("utcTimestamp", () => {
    it("builds a Drizzle SQL template binding the ISO UTC string with timestamptz cast", () => {
      const instant = new Date("2026-08-03T14:30:00.000Z");
      const sqlQuery = utcTimestamp(instant);

      expect(sqlQuery).toBeDefined();
      // Inspect generated query chunks
      const queryText = JSON.stringify(sqlQuery);
      expect(queryText).toContain("2026-08-03T14:30:00.000Z");
      expect(queryText).toContain("::timestamptz AT TIME ZONE 'UTC'");
    });
  });

  describe("utcDateFromRow", () => {
    it("returns null when the row value is null", () => {
      expect(utcDateFromRow(null)).toBeNull();
    });

    it("returns the Date instance unchanged when already mapped to a Date", () => {
      const date = new Date("2026-08-03T10:00:00.000Z");
      expect(utcDateFromRow(date)).toBe(date);
    });

    it("converts a Postgres space-separated timestamp string into an exact UTC Date", () => {
      // Postgres format: `YYYY-MM-DD HH:MM:SS.mmm`
      const postgresString = "2026-08-03 14:30:00.123";
      const result = utcDateFromRow(postgresString);

      expect(result).toBeInstanceOf(Date);
      expect(result?.toISOString()).toBe("2026-08-03T14:30:00.123Z");
      expect(result?.getUTCHours()).toBe(14);
      expect(result?.getUTCMinutes()).toBe(30);
      expect(result?.getUTCSeconds()).toBe(0);
      expect(result?.getUTCMilliseconds()).toBe(123);
    });

    it("converts a Postgres timestamp string without milliseconds into an exact UTC Date", () => {
      const postgresString = "2026-08-03 00:00:00";
      const result = utcDateFromRow(postgresString);

      expect(result).toBeInstanceOf(Date);
      expect(result?.toISOString()).toBe("2026-08-03T00:00:00.000Z");
    });
  });
});
