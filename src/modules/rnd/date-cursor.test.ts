import { describe, expect, it } from "vitest";

import { decodeDateCursor, encodeDateCursor, type DateCursor } from "#src/modules/rnd/date-cursor.js";

describe("date cursor", () => {
  const cursor: DateCursor = { calendarDate: "2026-03-14", id: "claim_9f2e" };

  it("round-trips a calendar date without going through a Date", () => {
    const decoded = decodeDateCursor(encodeDateCursor(cursor));

    expect(decoded?.calendarDate).toBe("2026-03-14");
    expect(decoded?.id).toBe("claim_9f2e");
  });

  it("round-trips an id containing the separator", () => {
    const decoded = decodeDateCursor(encodeDateCursor({ ...cursor, id: "a_b_c" }));

    expect(decoded?.id).toBe("a_b_c");
  });

  it.each([
    { rawCursor: "", why: "empty" },
    { rawCursor: "2026-03-14", why: "no id" },
    { rawCursor: "_claim_1", why: "no date" },
    { rawCursor: "2026-03-14_", why: "an empty id" },
    { rawCursor: "14-03-2026_claim_1", why: "a non-ISO date order" },
    { rawCursor: "2026-3-4_claim_1", why: "an unpadded date" },
    { rawCursor: "2026-03-14T00:00:00Z_claim_1", why: "an instant where a date belongs" },
    { rawCursor: "notadate_claim_1", why: "a non-date" },
  ])("returns null for $why rather than a first page", ({ rawCursor }) => {
    expect(decodeDateCursor(rawCursor)).toBeNull();
  });

  it("accepts a shape-valid date that no calendar has, because it simply matches no row", () => {
    // Deliberate: rejecting it would mean reimplementing month lengths and leap years to turn
    // "returns nothing" into "returns 422", which is not a distinction a client can act on.
    expect(decodeDateCursor("2026-02-31_claim_1")?.calendarDate).toBe("2026-02-31");
  });

  it("sorts lexicographically the same way it sorts chronologically", () => {
    // This is why the date goes FIRST and stays a string: ISO dates are ordered by byte
    // comparison, so a cursor a human is reading in a log orders the way the feed does.
    expect(
      encodeDateCursor({ calendarDate: "2026-03-09", id: "b" }) <
        encodeDateCursor({ calendarDate: "2026-03-10", id: "a" }),
    ).toBe(true);
  });
});
