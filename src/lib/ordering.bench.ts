import { withCodSpeed } from "@codspeed/tinybench-plugin";
import { Bench } from "tinybench";

import { compareUtf8Bytes, rankByTotalOrder, type OrderingKey } from "#src/lib/ordering.js";
import { BENCHMARK_OPTIONS } from "#src/test-support/bench-fixtures.js";

/**
 * The tie-break every ranking and every paginated `ORDER BY` runs through.
 *
 * `compareUtf8Bytes` is NOT a `<` — it encodes both operands to UTF-8 and compares the bytes, so
 * it allocates two Buffers per call and is paid `n log n` times inside `rankByTotalOrder`. That is
 * the price of agreeing with Postgres `COLLATE "C"`, and it is exactly the kind of cost that is
 * easy to make worse by accident (an extra normalization, a different encoding path), which is why
 * it is pinned here.
 *
 * Two corpora, because the encoder's cost is not flat: ASCII handles are one byte per character,
 * while the display names carry multi-byte characters — the case that also decides whether the
 * application and the database agree on order at all.
 */

const ROW_COUNT = 2000;

interface LeaderboardRow {
  readonly memberId: string;
  readonly displayName: string;
  readonly contributedMinutes: number;
  readonly equityBasisPoints: bigint;
}

const ASCII_HANDLES: readonly string[] = Array.from(
  { length: ROW_COUNT },
  (unusedValue, rowIndex) => `maker-handle-${String(rowIndex).padStart(5, "0")}`,
);

/** Astral-plane and CJK characters are where UTF-16 order and UTF-8 byte order disagree. */
const MULTI_BYTE_NAMES: readonly string[] = Array.from(
  { length: ROW_COUNT },
  (unusedValue, rowIndex) =>
    `${["Ωmega", "मशीन", "工作坊", "🛠️ bench", "Ångström"][rowIndex % 5] ?? "maker"}-${String(rowIndex).padStart(5, "0")}`,
);

const LEADERBOARD_ROWS: readonly LeaderboardRow[] = Array.from(
  { length: ROW_COUNT },
  (unusedValue, rowIndex) => ({
    memberId: ASCII_HANDLES[rowIndex] ?? `maker-${String(rowIndex)}`,
    displayName: MULTI_BYTE_NAMES[rowIndex] ?? "maker",
    // Heavily tied on purpose: the first two keys decide little, so the byte-wise final key —
    // the one that makes the order total — is the one doing the work.
    contributedMinutes: (rowIndex % 7) * 60,
    equityBasisPoints: BigInt(rowIndex % 11) * 100n,
  }),
);

const TOTAL_ORDER_KEYS: readonly OrderingKey<LeaderboardRow>[] = [
  { extract: (row) => row.contributedMinutes, direction: "descending" },
  { extract: (row) => row.equityBasisPoints, direction: "descending" },
  { extract: (row) => row.memberId, direction: "ascending" },
];

export const orderingBenchmarks = withCodSpeed(
  new Bench({ name: "ordering", ...BENCHMARK_OPTIONS }),
);

orderingBenchmarks.add("compareUtf8Bytes over 2000 ASCII pairs", () => {
  for (let rowIndex = 1; rowIndex < ROW_COUNT; rowIndex += 1) {
    compareUtf8Bytes(ASCII_HANDLES[rowIndex - 1] ?? "", ASCII_HANDLES[rowIndex] ?? "");
  }
});

orderingBenchmarks.add("compareUtf8Bytes over 2000 multi-byte pairs", () => {
  for (let rowIndex = 1; rowIndex < ROW_COUNT; rowIndex += 1) {
    compareUtf8Bytes(MULTI_BYTE_NAMES[rowIndex - 1] ?? "", MULTI_BYTE_NAMES[rowIndex] ?? "");
  }
});

orderingBenchmarks.add("rankByTotalOrder — 2000 rows, three-key chain", () => {
  rankByTotalOrder(LEADERBOARD_ROWS, TOTAL_ORDER_KEYS);
});
