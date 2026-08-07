import { describe, expect, it } from "vitest";

import { compareUtf8Bytes, rankByTotalOrder } from "#src/lib/ordering.js";

/**
 * `+ 0` normalizes -0 to +0. Without it the equal-strings case compares Math.sign(0)
 * (+0) against -Math.sign(0) (-0), which Object.is reports as different — the exact
 * negative-zero trap src/lib/money.ts exists to keep out of arithmetic.
 */
const signOf = (value: number): number => Math.sign(value) + 0;

describe("compareUtf8Bytes", () => {
  it("orders plain ASCII ascending", () => {
    expect(compareUtf8Bytes("alpha", "beta")).toBeLessThan(0);
    expect(compareUtf8Bytes("beta", "alpha")).toBeGreaterThan(0);
    expect(compareUtf8Bytes("alpha", "alpha")).toBe(0);
  });

  it("is antisymmetric across a sample of mixed-script strings", () => {
    const samples = ["a", "z", "A", "Z", "0", "é", "日本", "🌍", "水", "ß"];
    for (const left of samples) {
      for (const right of samples) {
        expect(signOf(compareUtf8Bytes(left, right))).toBe(
          -signOf(compareUtf8Bytes(right, left)) + 0,
        );
      }
    }
  });

  it("disagrees with JavaScript's < on astral-plane characters, which is the whole point", () => {
    // U+FFFD (BMP) vs U+10000 (astral). In UTF-16 the astral char is a surrogate pair
    // starting at 0xD800, which sorts BELOW 0xFFFD — so JS `<` says astral first.
    // In UTF-8 bytes the astral char starts 0xF0 and 0xFFFD starts 0xEF, so bytes say
    // the BMP char first. Postgres COLLATE "C" agrees with the bytes, and so must we.
    const bmpCharacter = "�";
    const astralCharacter = "\u{10000}";

    expect(astralCharacter < bmpCharacter).toBe(true);
    expect(compareUtf8Bytes(bmpCharacter, astralCharacter)).toBeLessThan(0);
  });

  it('sorts a list the same way Postgres COLLATE "C" would', () => {
    const sorted = ["Zebra", "apple", "Apple", "banana"].toSorted(compareUtf8Bytes);
    // Uppercase sorts before lowercase under byte ordering (A=0x41 < a=0x61).
    expect(sorted).toEqual(["Apple", "Zebra", "apple", "banana"]);
  });
});

describe("rankByTotalOrder", () => {
  interface ScoredRow {
    readonly id: string;
    readonly score: number;
    readonly reporters: number;
  }

  const keys = [
    { extract: (row: ScoredRow) => row.score, direction: "descending" as const },
    { extract: (row: ScoredRow) => row.reporters, direction: "descending" as const },
    { extract: (row: ScoredRow) => row.id, direction: "ascending" as const },
  ];

  it("orders by each key in turn", () => {
    const rows: ScoredRow[] = [
      { id: "c", score: 10, reporters: 5 },
      { id: "a", score: 20, reporters: 1 },
      { id: "b", score: 10, reporters: 9 },
    ];

    expect(rankByTotalOrder(rows, keys).map((row) => row.id)).toEqual(["a", "b", "c"]);
  });

  it("breaks a full tie on the unique final key", () => {
    const rows: ScoredRow[] = [
      { id: "zulu", score: 50, reporters: 3 },
      { id: "alpha", score: 50, reporters: 3 },
    ];

    expect(rankByTotalOrder(rows, keys).map((row) => row.id)).toEqual(["alpha", "zulu"]);
  });

  it("does not mutate the input", () => {
    const rows: ScoredRow[] = [
      { id: "b", score: 1, reporters: 1 },
      { id: "a", score: 2, reporters: 1 },
    ];
    const originalOrder = rows.map((row) => row.id);

    rankByTotalOrder(rows, keys);

    expect(rows.map((row) => row.id)).toEqual(originalOrder);
  });

  it("produces byte-identical output across 1,000 input shuffles", () => {
    // The §17 determinism requirement, at the ordering layer: a ranking must not depend
    // on the order Postgres happened to return rows in.
    const rows: ScoredRow[] = Array.from({ length: 40 }, (_unused, index) => ({
      id: `cluster-${String(index).padStart(3, "0")}`,
      // Deliberately coarse, so ties are frequent and the tie-break actually runs.
      score: index % 5,
      reporters: index % 3,
    }));

    const expected = JSON.stringify(rankByTotalOrder(rows, keys));

    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      // A deterministic shuffle: rotate by a varying amount, then reverse odd passes.
      // Math.random() is avoided so a failure is reproducible.
      const rotated = [
        ...rows.slice(attempt % rows.length),
        ...rows.slice(0, attempt % rows.length),
      ];
      const shuffled = attempt % 2 === 0 ? rotated : rotated.toReversed();

      expect(JSON.stringify(rankByTotalOrder(shuffled, keys))).toBe(expected);
    }
  });

  it("throws when the ordering is not total, rather than returning an arbitrary order", () => {
    const rows: ScoredRow[] = [
      { id: "a", score: 1, reporters: 1 },
      { id: "b", score: 1, reporters: 1 },
    ];
    const nonUniqueKeys = [
      { extract: (row: ScoredRow) => row.score, direction: "descending" as const },
    ];

    expect(() => rankByTotalOrder(rows, nonUniqueKeys)).toThrow(/not total/);
  });

  it("requires at least one key", () => {
    expect(() => rankByTotalOrder([], [])).toThrow(/at least one ordering key/);
  });
});
