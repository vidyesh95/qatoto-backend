import { types as pgTypes } from "pg";
import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Pins the `timestamp without time zone` parser to UTC.
 *
 * WHY THIS TEST EXISTS. node-postgres parses OID 1114 using the process's LOCAL zone by
 * default, and every one of the 84 timestamp columns in schema.ts is `without time zone`.
 * On a non-UTC host (this repository is developed on UTC+5:30) a value written as UTC
 * midnight read back as 18:30 the previous day — silently, with no error anywhere.
 *
 * §6's jobs turn that from untidy into breaking: an `asOf` is persisted and later compared
 * for byte-identity (§4c rule 3), and `wholeDaysBetweenUtcDayStarts` throws on an instant
 * that is not exactly a UTC day boundary.
 *
 * The test deliberately runs with `TZ` set to a NON-UTC zone, because a test that only
 * passes on a UTC machine cannot detect the bug it exists to prevent.
 */
describe("timestamp (OID 1114) parsing", () => {
  beforeAll(async () => {
    // A zone with a non-zero, non-integer-hour offset, so an off-by-local-zone bug cannot
    // coincidentally produce the right answer.
    vi.stubEnv("TZ", "Asia/Kolkata");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DATABASE_URL", "postgres://user:password@localhost:5432/testdb");
    vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-key-minimum-16-chars");
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:8000");
    vi.stubEnv("FRONTEND_URL", "http://localhost:3000");
    vi.stubEnv("GOOGLE_CLIENT_ID", "x");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "x");
    vi.stubEnv("GITHUB_CLIENT_ID", "x");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "x");

    // Importing the module is what installs the parser — that side effect is the
    // behaviour under test.
    await import("#src/db/index.js");
  });

  it("interprets a bare Postgres timestamp as UTC, not as local time", () => {
    const parseTimestamp = pgTypes.getTypeParser(pgTypes.builtins.TIMESTAMP);

    // Exactly what Postgres sends for a `timestamp without time zone`: no offset, no "T".
    const parsed: unknown = parseTimestamp("2026-07-21 00:00:00");

    expect(parsed).toBeInstanceOf(Date);
    expect(parsed instanceof Date ? parsed.toISOString() : null).toBe("2026-07-21T00:00:00.000Z");
  });

  it("preserves microsecond-precision fractional seconds", () => {
    const parseTimestamp = pgTypes.getTypeParser(pgTypes.builtins.TIMESTAMP);
    const parsed: unknown = parseTimestamp("2026-07-21 13:47:23.512");

    expect(parsed instanceof Date ? parsed.toISOString() : null).toBe("2026-07-21T13:47:23.512Z");
  });

  it("round-trips a UTC day start unchanged, which is what job asOf values depend on", () => {
    const parseTimestamp = pgTypes.getTypeParser(pgTypes.builtins.TIMESTAMP);
    const utcDayStart = new Date("2026-07-21T00:00:00.000Z");

    // Postgres stores the wall-clock text and returns it without an offset.
    const storedText = utcDayStart.toISOString().replace("T", " ").replace("Z", "");
    const parsed: unknown = parseTimestamp(storedText);

    expect(parsed instanceof Date ? parsed.getTime() : null).toBe(utcDayStart.getTime());
    // The property §4c actually relies on: still exactly on a UTC day boundary.
    expect(
      parsed instanceof Date ? parsed.getTime() % 86_400_000 : null,
    ).toBe(0);
  });

  it("is not accidentally passing because the host is already UTC", () => {
    // If this fails, the stub did not take effect and the other assertions prove nothing.
    expect(new Date("2026-07-21T00:00:00.000Z").getTimezoneOffset()).not.toBe(0);
  });
});
