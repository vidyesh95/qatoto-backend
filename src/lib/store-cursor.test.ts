import { describe, expect, it } from "vitest";

import {
  decodeStoreCursor,
  decodeTimestampStoreCursor,
  encodeStoreCursor,
  slugifyPublicTitle,
} from "#src/lib/store-cursor.js";

describe("store cursor helpers", () => {
  it("round-trips sort key and id", () => {
    const encoded = encodeStoreCursor({
      sortKey: "2026-08-05T12:00:00.000Z",
      id: "product-1",
    });
    expect(decodeStoreCursor(encoded)).toEqual({
      sortKey: "2026-08-05T12:00:00.000Z",
      id: "product-1",
    });
  });

  it("rejects malformed cursors", () => {
    expect(decodeStoreCursor("no-separator")).toBeNull();
    expect(decodeStoreCursor("_missing-sort")).toBeNull();
    expect(decodeStoreCursor("%E0%A4%A_product-1")).toBeNull();
  });

  it("parses only canonical bounded timestamp cursors", () => {
    const validCursor = encodeStoreCursor({
      sortKey: "2026-08-05T12:00:00.000Z",
      id: "dispute-1",
    });
    expect(decodeTimestampStoreCursor(validCursor)).toEqual({
      sortKey: new Date("2026-08-05T12:00:00.000Z"),
      id: "dispute-1",
    });

    expect(
      decodeTimestampStoreCursor(
        encodeStoreCursor({ sortKey: "+275760-09-13T00:00:00.000Z", id: "dispute-1" }),
      ),
    ).toBeNull();
    expect(
      decodeTimestampStoreCursor(
        encodeStoreCursor({ sortKey: "2026-08-05 12:00:00", id: "dispute-1" }),
      ),
    ).toBeNull();
  });

  it("builds immutable public slugs with an id suffix", () => {
    const slug = slugifyPublicTitle("Solar Freezer!!", "abcd-efgh-ijkl");
    expect(slug).toMatch(/^solar-freezer-[a-z0-9]+$/);
    expect(slug.length).toBeGreaterThanOrEqual(3);
  });
});
