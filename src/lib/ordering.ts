/**
 * Deterministic ordering primitives.
 *
 * Every `ORDER BY` that feeds pagination, a ranking, or a hash must end in a unique
 * column, and every tie-break that runs in TypeScript must agree byte-for-byte with the
 * one Postgres would apply (R_AND_D_BACKEND_STRUCTURE.md §4c rule 4).
 *
 * This module exists because that comparison is subtle enough to be worth writing once:
 * a tie-break that disagrees across two places moves a basis point, which changes an
 * equity share, which changes a hash.
 */

/**
 * Compares two strings by their UTF-8 BYTES, ascending.
 *
 * Deliberately not `left < right`: JavaScript compares UTF-16 code units, so an
 * astral-plane character (emoji, rare CJK) orders differently than it does under
 * Postgres `COLLATE "C"`. The two must agree, because a ranking computed in the
 * application and a ranking paginated by the database are the same ranking.
 *
 * Returns a negative number when `left` sorts first, positive when `right` does, and
 * zero only when the two strings are byte-identical.
 */
export function compareUtf8Bytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/**
 * One comparator in a total-order chain: a key extracted from a row plus a direction.
 *
 * Numeric and bigint keys compare naturally; string keys compare BY BYTES via
 * `compareUtf8Bytes`, never with `<`.
 */
export interface OrderingKey<TRow> {
  readonly extract: (row: TRow) => bigint | number | string;
  readonly direction: "ascending" | "descending";
}

function compareExtractedKeys(left: bigint | number | string, right: bigint | number | string): number {
  if (typeof left === "string" || typeof right === "string") {
    return compareUtf8Bytes(String(left), String(right));
  }
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * Sorts `rows` by a chain of keys, returning a NEW array (the input is never mutated).
 *
 * The final key in `keys` MUST be unique across `rows` — that is what makes the order
 * TOTAL, and a total order is what lets a rank be `index + 1` without ever needing to
 * decide between competition ranking (1,2,2,4) and dense ranking (1,2,2,3). Neither
 * question can arise if no two rows can tie.
 *
 * @throws if the resulting order is not total — two rows compared equal on every key,
 *         which means the caller's final key was not unique. That is an unrecoverable
 *         programmer error (CLAUDE.md §3.3): silently returning an arbitrary order here
 *         would make a ranking non-reproducible, and the bug would not surface until a
 *         leaderboard disagreed with itself between two runs.
 */
export function rankByTotalOrder<TRow>(
  rows: readonly TRow[],
  keys: readonly OrderingKey<TRow>[],
): readonly TRow[] {
  if (keys.length === 0) {
    throw new Error("rankByTotalOrder: at least one ordering key is required");
  }

  return rows.toSorted((leftRow, rightRow) => {
    for (const key of keys) {
      const comparison = compareExtractedKeys(key.extract(leftRow), key.extract(rightRow));
      if (comparison !== 0) {
        return key.direction === "ascending" ? comparison : -comparison;
      }
    }
    throw new Error(
      "rankByTotalOrder: ordering is not total — two rows tied on every key. The final key must be unique.",
    );
  });
}
