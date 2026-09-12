import { describe, expect, it } from "vitest";

import {
  decodeShowcaseFeedCursor,
  encodeShowcaseFeedCursor,
  type ShowcaseFeedCursor,
} from "#src/modules/home/blueprints/showcase-feed-cursor.js";

/**
 * UNIT tests for the public showcase feed's keyset cursor.
 *
 * THE CASES THAT MATTER MOST ARE THE REFUSALS. A cursor codec that accepts something it should not
 * does not fail loudly — it resumes a page from the wrong position, and the reader sees a feed that
 * skips or repeats rows. So the cross-sort case and the malformed-number cases carry more weight
 * here than the round trips.
 */

const LAUNCHED_AT = new Date("2026-09-01T12:00:00.000Z");

describe("encodeShowcaseFeedCursor / decodeShowcaseFeedCursor", () => {
  describe("round trips", () => {
    it("round-trips a newest cursor", () => {
      const cursor: ShowcaseFeedCursor = { sort: "newest", launchedAt: LAUNCHED_AT, id: "launch_1" };

      expect(decodeShowcaseFeedCursor(encodeShowcaseFeedCursor(cursor), "newest")).toEqual(cursor);
    });

    it("round-trips a top cursor", () => {
      const cursor: ShowcaseFeedCursor = {
        sort: "top",
        upvoteCount: 96,
        launchedAt: LAUNCHED_AT,
        id: "launch_1",
      };

      expect(decodeShowcaseFeedCursor(encodeShowcaseFeedCursor(cursor), "top")).toEqual(cursor);
    });

    it("round-trips a zero vote count, which is what every launch has today", () => {
      const cursor: ShowcaseFeedCursor = {
        sort: "top",
        upvoteCount: 0,
        launchedAt: LAUNCHED_AT,
        id: "launch_1",
      };

      expect(decodeShowcaseFeedCursor(encodeShowcaseFeedCursor(cursor), "top")).toEqual(cursor);
    });

    /** The id is last and never split on, so an underscore in it survives. */
    it.each([
      ["newest", { sort: "newest", launchedAt: LAUNCHED_AT, id: "launch_with_underscores" }],
      ["top", { sort: "top", upvoteCount: 7, launchedAt: LAUNCHED_AT, id: "launch_with_underscores" }],
    ] as const)("keeps an id containing underscores intact under %s", (sort, cursor) => {
      expect(decodeShowcaseFeedCursor(encodeShowcaseFeedCursor(cursor), sort)).toEqual(cursor);
    });
  });

  describe("the cross-sort refusal", () => {
    /**
     * THE REASON THE SORT IS IN THE CURSOR. Resuming a vote-ranked page from a date-ranked position
     * skips and repeats rows. Refusing costs one character comparison and no database round trip.
     */
    it("refuses a newest cursor replayed under top", () => {
      const newestCursor = encodeShowcaseFeedCursor({
        sort: "newest",
        launchedAt: LAUNCHED_AT,
        id: "launch_1",
      });

      expect(decodeShowcaseFeedCursor(newestCursor, "top")).toBeNull();
    });

    it("refuses a top cursor replayed under newest", () => {
      const topCursor = encodeShowcaseFeedCursor({
        sort: "top",
        upvoteCount: 96,
        launchedAt: LAUNCHED_AT,
        id: "launch_1",
      });

      expect(decodeShowcaseFeedCursor(topCursor, "newest")).toBeNull();
    });
  });

  describe("malformed input", () => {
    it.each([
      ["an empty string", ""],
      ["no prefix at all", "1788264000000_launch_1"],
      ["an unknown prefix", "x_1788264000000_launch_1"],
      ["the prefix alone", "n_"],
      ["no id", "n_1788264000000_"],
      ["no separator after the instant", "n_1788264000000"],
      ["a non-numeric instant", "n_yesterday_launch_1"],
      ["an empty instant", "n__launch_1"],
      ["a negative instant", "n_-1788264000000_launch_1"],
      ["a padded instant", "n_ 1788264000000_launch_1"],
      ["an instant past the safe integer range", "n_99999999999999999999_launch_1"],
    ])("refuses %s under newest", (_label, rawCursor) => {
      expect(decodeShowcaseFeedCursor(rawCursor, "newest")).toBeNull();
    });

    it.each([
      ["only one number", "t_96_launch_1"],
      ["a non-numeric vote count", "t_many_1756728000000_launch_1"],
      ["an empty vote count", "t__1788264000000_launch_1"],
      ["a non-numeric instant", "t_96_yesterday_launch_1"],
      ["no id", "t_96_1788264000000_"],
      ["a vote count past the safe integer range", "t_99999999999999999999_1788264000000_launch_1"],
    ])("refuses %s under top", (_label, rawCursor) => {
      expect(decodeShowcaseFeedCursor(rawCursor, "top")).toBeNull();
    });
  });

  describe("the encoded shape", () => {
    /**
     * Pinned because it is a wire format: a client holding a cursor across a deploy must still be
     * able to resume, so the shape cannot change silently.
     */
    it("writes plain text rather than base64, so a cursor is debuggable in a URL", () => {
      expect(encodeShowcaseFeedCursor({ sort: "newest", launchedAt: LAUNCHED_AT, id: "launch_1" })).toBe(
        "n_1788264000000_launch_1",
      );
      expect(
        encodeShowcaseFeedCursor({
          sort: "top",
          upvoteCount: 96,
          launchedAt: LAUNCHED_AT,
          id: "launch_1",
        }),
      ).toBe("t_96_1788264000000_launch_1");
    });
  });
});
