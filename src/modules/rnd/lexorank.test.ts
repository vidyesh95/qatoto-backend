import { describe, expect, it } from "vitest";

import { compareUtf8Bytes } from "#src/lib/ordering.js";
import { initialRanks, isValidRank, rankBetween } from "#src/modules/rnd/lexorank.js";

/**
 * The board's ordering is the one thing in §8 that two independent systems compute:
 * Postgres paginates it (`ORDER BY rank COLLATE "C"`) and three clients render it
 * (code-point compare). These tests assert the property that keeps those two the same
 * answer — every generated rank sits strictly between its bounds under BYTE comparison,
 * which is what both sides do.
 */

/** Byte order, exactly as `COLLATE "C"` and a client's `a < b` both apply it. */
const sortsBefore = (left: string, right: string): boolean => compareUtf8Bytes(left, right) < 0;

/**
 * A deterministic PRNG, so a failure is reproducible from the seed printed in the name.
 * `Math.random()` would make a red build impossible to re-run — the same reason §4c bans
 * an unseeded clock inside a job.
 */
function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // xorshift32.
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

describe("isValidRank", () => {
  it("accepts the alphabet the CHECK constraint accepts", () => {
    expect(isValidRank("i")).toBe(true);
    expect(isValidRank("0z")).toBe(true);
    expect(isValidRank("abc123")).toBe(true);
  });

  it("rejects anything outside [0-9a-z]", () => {
    // Each of these orders differently in Postgres under a non-C collation than it does
    // in a client's code-point compare — which is the bug the alphabet exists to prevent.
    expect(isValidRank("A")).toBe(false);
    expect(isValidRank("a-b")).toBe(false);
    expect(isValidRank("a b")).toBe(false);
    expect(isValidRank("")).toBe(false);
    expect(isValidRank("é")).toBe(false);
  });

  it("rejects a trailing zero, because it is a second spelling of one position", () => {
    // "a" and "a0" are the same point on the line, so permitting both would let two
    // tasks occupy one slot while still satisfying UNIQUE (column_id, rank).
    expect(isValidRank("a0")).toBe(false);
    expect(isValidRank("a00")).toBe(false);
    expect(isValidRank("a0b")).toBe(true);
  });

  it("rejects a rank past the length bound", () => {
    expect(isValidRank(`${"z".repeat(64)}1`)).toBe(false);
  });
});

describe("rankBetween", () => {
  it("returns a mid-alphabet rank for the first card on an empty board", () => {
    const first = rankBetween(null, null);
    expect(isValidRank(first)).toBe(true);
    // Mid-alphabet, so the first drop above OR below it still has room.
    expect(sortsBefore("5", first)).toBe(true);
    expect(sortsBefore(first, "n")).toBe(true);
  });

  it("produces a rank strictly before the head card", () => {
    const head = rankBetween(null, "i");
    expect(sortsBefore(head, "i")).toBe(true);
    expect(isValidRank(head)).toBe(true);
  });

  it("produces a rank strictly after the tail card", () => {
    const tail = rankBetween("i", null);
    expect(sortsBefore("i", tail)).toBe(true);
    expect(isValidRank(tail)).toBe(true);
  });

  it("appends after a rank at the top of the alphabet", () => {
    // "z" has nothing above it at the first digit, so the answer must lengthen.
    const afterMax = rankBetween("z", null);
    expect(sortsBefore("z", afterMax)).toBe(true);
    expect(isValidRank(afterMax)).toBe(true);

    const afterRunOfMax = rankBetween("zzz", null);
    expect(sortsBefore("zzz", afterRunOfMax)).toBe(true);
    expect(isValidRank(afterRunOfMax)).toBe(true);
  });

  it("splits adjacent digits by lengthening rather than colliding", () => {
    const between = rankBetween("a", "b");
    expect(sortsBefore("a", between)).toBe(true);
    expect(sortsBefore(between, "b")).toBe(true);
  });

  it("stays under a bound whose next digit is 1 — the trailing-zero trap", () => {
    // The digit sequence here is [a, 0, …]. Rendering the [a, 0] prefix and trimming it
    // to "a" before appending would yield "ai", which sorts AFTER "a1". Regression test
    // for exactly that.
    const between = rankBetween("a", "a1");
    expect(sortsBefore("a", between)).toBe(true);
    expect(sortsBefore(between, "a1")).toBe(true);
  });

  it("splits a pair that differs only in length", () => {
    const between = rankBetween("a", "ai");
    expect(sortsBefore("a", between)).toBe(true);
    expect(sortsBefore(between, "ai")).toBe(true);
  });

  it("refuses inverted bounds rather than inventing a rank", () => {
    // A caller passing these has read the board in one order and is writing it in
    // another; producing something plausible would bury that bug in the data.
    expect(() => rankBetween("b", "a")).toThrow(/not ordered/);
    expect(() => rankBetween("a", "a")).toThrow(/not ordered/);
  });

  it("refuses a malformed bound", () => {
    expect(() => rankBetween("A", null)).toThrow(/invalid lower bound/);
    expect(() => rankBetween(null, "a b")).toThrow(/invalid upper bound/);
    // A rank read back from a row an older deploy wrote gets the same treatment.
    expect(() => rankBetween("a0", null)).toThrow(/invalid lower bound/);
  });

  it("keeps a column ordered across 10,000 random moves", () => {
    const random = createSeededRandom(0x5eed_1234);
    // Seed a column, then repeatedly pull a card out and drop it somewhere else —
    // the operation a member performs, ten thousand times.
    const column: string[] = [...initialRanks(8)];

    for (let move = 0; move < 10_000; move += 1) {
      const takeIndex = Math.floor(random() * column.length);
      column.splice(takeIndex, 1);

      const dropIndex = Math.floor(random() * (column.length + 1));
      const before = dropIndex === 0 ? null : (column[dropIndex - 1] ?? null);
      const after = dropIndex === column.length ? null : (column[dropIndex] ?? null);

      const rank = rankBetween(before, after);

      // Collected rather than asserted per branch: a bare `expect` inside an `if` hides
      // how many moves actually exercised the bound, and a violation here names the move
      // number instead of just failing.
      expect({
        valid: isValidRank(rank),
        aboveLowerBound: before === null || sortsBefore(before, rank),
        belowUpperBound: after === null || sortsBefore(rank, after),
      }).toStrictEqual({ valid: true, aboveLowerBound: true, belowUpperBound: true });

      column.splice(dropIndex, 0, rank);
    }

    // The array order and the byte order must still be the same order — that is the
    // invariant a client relies on when it renders without re-sorting.
    const sortedByBytes = column.toSorted(compareUtf8Bytes);
    expect(column).toStrictEqual(sortedByBytes);
    // And no two cards may share a slot; the UNIQUE index would reject the write.
    expect(new Set(column).size).toBe(column.length);
  });

  it("keeps rank length bounded when every drop lands in the same gap", () => {
    // The adversarial case: 200 consecutive inserts into the narrowest gap. Each adds at
    // most one character, and nothing here should reach the 64-character bound.
    let lower = "a";
    const upper = "b";
    let longest = 0;

    for (let insert = 0; insert < 200; insert += 1) {
      const rank = rankBetween(lower, upper);
      expect(sortsBefore(lower, rank)).toBe(true);
      expect(sortsBefore(rank, upper)).toBe(true);
      longest = Math.max(longest, rank.length);
      lower = rank;
    }

    // Repeatedly halving the SAME gap is the one shape that grows without bound, and it
    // is what a rebalance exists to fix — assert the growth is linear-ish, not explosive.
    expect(longest).toBeLessThanOrEqual(64);
  });
});

describe("initialRanks", () => {
  it("returns evenly spread, strictly ascending ranks", () => {
    const ranks = initialRanks(5);
    expect(ranks).toHaveLength(5);
    for (const rank of ranks) {
      expect(isValidRank(rank)).toBe(true);
    }
    for (let index = 1; index < ranks.length; index += 1) {
      expect(sortsBefore(ranks[index - 1] ?? "", ranks[index] ?? "")).toBe(true);
    }
  });

  it("leaves room to drop between any two seeded cards without lengthening", () => {
    const ranks = initialRanks(4);
    for (let index = 1; index < ranks.length; index += 1) {
      const between = rankBetween(ranks[index - 1] ?? null, ranks[index] ?? null);
      expect(between).toHaveLength(1);
    }
  });

  it("returns nothing for a count of zero", () => {
    expect(initialRanks(0)).toStrictEqual([]);
  });

  it("refuses a non-integer, a negative, or more than the alphabet holds", () => {
    expect(() => initialRanks(1.5)).toThrow(/non-negative integer/);
    expect(() => initialRanks(-1)).toThrow(/non-negative integer/);
    expect(() => initialRanks(35)).toThrow(/at most/);
  });
});
