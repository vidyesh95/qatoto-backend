/**
 * Lexicographic rank strings for the workshop kanban board
 * (R_AND_D_BACKEND_STRUCTURE.md §8, "Kanban ordering").
 *
 * WHY RANK STRINGS AND NOT INTEGER POSITIONS. Two members dragging cards at the same
 * moment on integer positions produce a re-pack storm — every card after the insertion
 * point is rewritten, both transactions rewrite the same rows, and one move is lost. A
 * rank string makes a move ONE row write that touches no neighbour, so concurrent drags
 * commute.
 *
 * WHY THE ALPHABET IS [0-9a-z] AND NOTHING ELSE. The board is ordered by Postgres for
 * pagination and by the client for rendering, and those two orderings must be the same
 * ordering. Postgres follows the column's collation (the migration pins `COLLATE "C"`,
 * i.e. byte order); JavaScript, Kotlin and Swift compare code points. Across `0-9a-z`
 * those agree exactly, and every character is single-byte in UTF-8, so byte order and
 * code-point order cannot diverge. Adding an uppercase letter or punctuation would break
 * that agreement under any non-C collation, which is why `workshop_task_rank_ck` refuses
 * them at the database level too.
 *
 * WHY THE SERVER OWNS RANK GENERATION (§0). `POST /tasks/:taskId/move` takes
 * `{ beforeTaskId, afterTaskId }` — ids and intent — and the server derives the string.
 * A client-supplied rank is a client-supplied sort order, and a client that sends
 * `"0"` for every card silently corrupts the board for everyone.
 *
 * Pure: no clock, no randomness, no database. Same inputs, same output, forever — which
 * is what lets the test suite replay ten thousand moves and assert the order held.
 */

import { compareUtf8Bytes } from "#src/lib/ordering.js";

/**
 * Base-36, in byte order. Index in this string IS the digit's value, so `DIGITS[n]` and
 * `DIGITS.indexOf(char)` are inverses and no lookup table can drift out of sync.
 */
const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length;

/** The midpoint digit. First rank on an empty board, and the pivot for a first insert. */
const MIDDLE_DIGIT_INDEX = Math.floor(BASE / 2);

/**
 * Bounds a single rank, so a pathological sequence of "always insert at the same spot"
 * moves fails loudly instead of growing a string without limit.
 *
 * Every insertion between two adjacent ranks adds at most one character, so reaching 64
 * requires ~64 consecutive inserts into the SAME gap with no rebalance — far beyond any
 * real board, and a signal that something is generating ranks in a loop.
 */
const MAX_RANK_LENGTH = 64;

const RANK_PATTERN = /^[0-9a-z]+$/;

/**
 * True when `candidate` is a well-formed rank.
 *
 * A trailing `"0"` is deliberately NOT allowed: `"a"` and `"a0"` are the same position,
 * so permitting both would let two rows occupy one slot while still satisfying the
 * `UNIQUE (column_id, rank)` index. Normalizing at generation time is not enough — a rank
 * read back from a row written by an older deploy gets the same check.
 */
export function isValidRank(candidate: string): boolean {
  return (
    RANK_PATTERN.test(candidate) && candidate.length <= MAX_RANK_LENGTH && !candidate.endsWith("0")
  );
}

function digitValueAt(rank: string, index: number): number {
  // Past the end of a rank, treat it as its infinite `0` tail — that is what makes
  // `"a"` and `"a0…"` compare equal digit-by-digit and is why `midpoint` can walk two
  // strings of different lengths without special-casing their lengths.
  if (index >= rank.length) {
    return 0;
  }
  const digit = rank[index];
  const value = digit === undefined ? -1 : DIGITS.indexOf(digit);
  if (value < 0) {
    throw new Error(`lexorank: rank "${rank}" contains a character outside [0-9a-z]`);
  }
  return value;
}

/**
 * Renders a digit array, ONCE, at the very end of a computation.
 *
 * THE TRAILING-ZERO TRAP THIS ENCODES. Rendering (and trimming) an intermediate prefix is
 * wrong, and wrong in a way that produces a rank OUTSIDE its own bounds: the midpoint of
 * `"a"` and `"a1"` is the digit sequence `[a, 0, i]`, and trimming `[a, 0]` to `"a"`
 * before appending `"i"` yields `"ai"` — which sorts AFTER `"a1"`. So intermediates stay
 * arrays and only the finished sequence becomes a string.
 *
 * Trimming here is a safety net rather than a live path: every terminating branch below
 * pushes a digit ≥ 1, so a finished sequence never ends in zero.
 */
function digitsToRank(digits: readonly number[]): string {
  let lastSignificantIndex = digits.length - 1;
  while (lastSignificantIndex > 0 && digits[lastSignificantIndex] === 0) {
    lastSignificantIndex -= 1;
  }

  const rank = digits
    .slice(0, lastSignificantIndex + 1)
    .map((value) => DIGITS[value] ?? "0")
    .join("");

  if (rank.length > MAX_RANK_LENGTH) {
    throw new Error(
      `lexorank: rank exceeded ${MAX_RANK_LENGTH} characters — the board needs a rebalance`,
    );
  }
  return rank;
}

/**
 * The strictly-between digit sequence of two bounded ranks, digit by digit.
 *
 * Treats each rank as the fraction `0.<digits>` in base 36 and walks left to right, which
 * is why it never converts to a float: a 64-digit base-36 fraction carries far more
 * precision than an IEEE double, and §4c bans floats in ordering arithmetic for exactly
 * this reason — a rounded midpoint can land ON one of its bounds and produce a duplicate
 * the `UNIQUE (column_id, rank)` index then rejects.
 *
 * `upperBound` of `""` means "unbounded above", where every digit reads as its infinite
 * `0` tail; `strictlyAfter` handles that case instead.
 */
function midpointDigits(lowerBound: string, upperBound: string): readonly number[] {
  const digits: number[] = [];

  for (let index = 0; ; index += 1) {
    const lowerDigit = digitValueAt(lowerBound, index);
    const upperDigit = digitValueAt(upperBound, index);

    if (lowerDigit === upperDigit) {
      // The two agree here, so the answer must too; keep walking to the first place they
      // differ.
      digits.push(lowerDigit);
      continue;
    }

    if (upperDigit - lowerDigit > 1) {
      // A gap exists at this digit: take its middle and stop. Integer division, so the
      // result is strictly between the two.
      digits.push(lowerDigit + Math.floor((upperDigit - lowerDigit) / 2));
      return digits;
    }

    // Adjacent digits (e.g. "b" and "c"): no room here, so keep the LOWER digit and
    // descend into the space after the lower bound's remaining tail. Everything produced
    // below is still under the upper bound, because this digit is already strictly less
    // than the upper bound's. This is the branch that grows the string by a character.
    digits.push(lowerDigit);
    return [...digits, ...strictlyAfterDigits(lowerBound, index + 1)];
  }
}

/**
 * The digit sequence strictly after `lowerBound`'s tail, starting at `startIndex`.
 *
 * Walks the remaining digits until it finds one below the top of the alphabet, then takes
 * the middle of the space above it. A run of `"z"` is carried rather than incremented —
 * nothing fits after `"z"` at that digit.
 */
function strictlyAfterDigits(lowerBound: string, startIndex: number): readonly number[] {
  const digits: number[] = [];

  for (let index = startIndex; ; index += 1) {
    const lowerDigit = digitValueAt(lowerBound, index);

    if (lowerDigit >= BASE - 1) {
      digits.push(lowerDigit);
      continue;
    }

    digits.push(lowerDigit + Math.max(1, Math.floor((BASE - lowerDigit) / 2)));
    return digits;
  }
}

/**
 * THE entry point: a rank strictly between `before` and `after`.
 *
 * `null` means "no neighbour on that side", so all four combinations are meaningful:
 *
 *   (null, null)  → the first card in an empty column
 *   (null, rank)  → dropped at the top
 *   (rank, null)  → dropped at the bottom
 *   (rank, rank)  → dropped between two cards
 *
 * @throws when either bound is malformed, or when `before >= after`. Both are
 *         unrecoverable programmer errors (CLAUDE.md §3.3): a caller that passes an
 *         inverted pair has read the board in one order and is writing it in another,
 *         and inventing a rank for it would bury the bug in the data.
 */
export function rankBetween(before: string | null, after: string | null): string {
  if (before !== null && !isValidRank(before)) {
    throw new Error(`lexorank: invalid lower bound "${before}"`);
  }
  if (after !== null && !isValidRank(after)) {
    throw new Error(`lexorank: invalid upper bound "${after}"`);
  }
  if (before !== null && after !== null && compareUtf8Bytes(before, after) >= 0) {
    throw new Error(`lexorank: bounds are not ordered — "${before}" must sort before "${after}"`);
  }

  if (before === null && after === null) {
    return DIGITS[MIDDLE_DIGIT_INDEX] ?? "i";
  }
  if (after === null) {
    // Appending to the end of a column: no upper bound to stay under.
    return digitsToRank(strictlyAfterDigits(before ?? "", 0));
  }
  // Dropping at the head reads as a midpoint against the empty lower bound, whose digits
  // are all zero — no separate branch needed.
  return digitsToRank(midpointDigits(before ?? "", after));
}

/**
 * `count` evenly-spread ranks, for seeding a fresh board's cards in one insert.
 *
 * Evenly spread rather than sequential (`"1"`, `"2"`, `"3"`) so the first drop between
 * any two of them still has room and does not immediately lengthen a string.
 *
 * @throws if `count` is not a non-negative integer, or exceeds the alphabet — a caller
 *         seeding more than 36 cards at once should insert them in pages.
 */
export function initialRanks(count: number): readonly string[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`lexorank: count must be a non-negative integer, got ${count}`);
  }
  if (count > BASE - 2) {
    throw new Error(`lexorank: initialRanks supports at most ${BASE - 2} ranks, got ${count}`);
  }

  const stride = Math.floor((BASE - 1) / (count + 1));
  return Array.from({ length: count }, (_unused, index) => {
    const digit = DIGITS[(index + 1) * stride];
    if (digit === undefined) {
      throw new Error("lexorank: stride walked off the alphabet");
    }
    return digit;
  });
}
