import { describe, expect, it } from "vitest";

import {
  decodeInstantCursor,
  encodeInstantCursor,
  type InstantCursor,
} from "#src/lib/instant-cursor.js";

describe("instant cursor", () => {
  const cursor: InstantCursor = {
    instant: new Date("2026-03-14T09:15:00.123Z"),
    id: "notification_9f2e",
  };

  it("round-trips an instant to the millisecond", () => {
    const decoded = decodeInstantCursor(encodeInstantCursor(cursor));

    expect(decoded?.instant.toISOString()).toBe("2026-03-14T09:15:00.123Z");
    expect(decoded?.id).toBe("notification_9f2e");
  });

  it("round-trips an id containing the separator", () => {
    const decoded = decodeInstantCursor(encodeInstantCursor({ ...cursor, id: "a_b_c" }));

    expect(decoded?.id).toBe("a_b_c");
  });

  it.each([
    { rawCursor: "", why: "empty" },
    { rawCursor: "1773479700123", why: "no id" },
    { rawCursor: "_notification_1", why: "no instant" },
    { rawCursor: "notanumber_notification_1", why: "a non-numeric instant" },
    { rawCursor: " 123 _notification_1", why: "a padded instant Number() would accept" },
    { rawCursor: "99999999999999999999_notification_1", why: "an unsafe integer" },
    { rawCursor: "1773479700123_", why: "an empty id" },
  ])("returns null for $why rather than a first page", ({ rawCursor }) => {
    expect(decodeInstantCursor(rawCursor)).toBeNull();
  });

  it("sorts lexicographically the same way it sorts chronologically for same-width instants", () => {
    // Not a property the code relies on, but the reason the epoch goes FIRST: a cursor a
    // human is comparing in a log should order the way the feed does.
    const earlier = encodeInstantCursor({ instant: new Date(1_000_000_000_000), id: "b" });
    const later = encodeInstantCursor({ instant: new Date(1_000_000_000_001), id: "a" });

    expect(earlier < later).toBe(true);
  });
});
