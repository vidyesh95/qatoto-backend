import { describe, expect, it } from "vitest";

import {
  decodeDailyLogFeedCursor,
  encodeDailyLogFeedCursor,
} from "#src/lib/daily-log-cursor.js";

/**
 * The cursor is the whole correctness argument for the cross-project feed: a codec that
 * loses a field, or accepts a malformed one, either skips a member's log or repeats it.
 * Every case below is a way that has gone wrong in a keyset implementation before.
 */
describe("daily-log feed cursor", () => {
  const sampleCursor = {
    logDate: "2026-07-26",
    submittedAt: new Date("2026-07-27T09:15:30.123Z"),
    id: "0f4c8863-e736-40da-bfe2-835b041a8077",
  };

  it("round-trips every field", () => {
    const decoded = decodeDailyLogFeedCursor(encodeDailyLogFeedCursor(sampleCursor));

    expect(decoded).not.toBeNull();
    expect(decoded?.logDate).toBe("2026-07-26");
    expect(decoded?.submittedAt.getTime()).toBe(sampleCursor.submittedAt.getTime());
    expect(decoded?.id).toBe(sampleCursor.id);
  });

  it("keeps logDate and submittedAt distinct when they fall on different days", () => {
    // A backfilled log: claimed for the 20th, filed on the 27th. Collapsing the two would
    // sort it against the wrong day.
    const encoded = encodeDailyLogFeedCursor({
      logDate: "2026-07-20",
      submittedAt: new Date("2026-07-27T00:00:00.000Z"),
      id: "log-1",
    });

    expect(decodeDailyLogFeedCursor(encoded)?.logDate).toBe("2026-07-20");
  });

  it("preserves an id containing the separator", () => {
    const encoded = encodeDailyLogFeedCursor({ ...sampleCursor, id: "log_with_underscores" });

    expect(decodeDailyLogFeedCursor(encoded)?.id).toBe("log_with_underscores");
  });

  it("preserves millisecond precision", () => {
    const encoded = encodeDailyLogFeedCursor({
      ...sampleCursor,
      submittedAt: new Date(1_780_000_000_001),
    });

    expect(decodeDailyLogFeedCursor(encoded)?.submittedAt.getTime()).toBe(1_780_000_000_001);
  });

  it.each([
    ["empty", ""],
    ["no separator", "2026-07-26"],
    ["one separator only", "2026-07-26_1780000000000"],
    ["empty id", "2026-07-26_1780000000000_"],
    ["empty logDate", "_1780000000000_log-1"],
    ["logDate not ISO", "26-07-2026_1780000000000_log-1"],
    ["logDate with time", "2026-07-26T00:00:00Z_1780000000000_log-1"],
    ["empty instant", "2026-07-26__log-1"],
    ["non-numeric instant", "2026-07-26_yesterday_log-1"],
    ["negative instant", "2026-07-26_-1_log-1"],
    ["whitespace-padded instant", "2026-07-26_ 1780000000000 _log-1"],
    ["instant past Number.MAX_SAFE_INTEGER", "2026-07-26_90071992547409910_log-1"],
  ])("rejects a %s cursor", (_label, rawCursor) => {
    expect(decodeDailyLogFeedCursor(rawCursor)).toBeNull();
  });
});
