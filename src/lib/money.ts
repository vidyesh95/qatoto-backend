/**
 * THE arithmetic module. Every derived integer in the R&D domain goes through here
 * (R_AND_D_BACKEND_STRUCTURE.md §4c).
 *
 * Why one module: two servers, or one server run twice, must produce BIT-IDENTICAL
 * integers. Equity shares and audit hashes are worthless otherwise, and the product's
 * entire commercial argument is "financial determinism vs LLM hallucination".
 *
 * Three rules this file exists to enforce:
 *
 *   1. `Math.round` / `Math.floor` are BANNED on any apportioned or signed quantity.
 *      JS rounds -0.5 to -0, Postgres `round()` is half-away-from-zero, and they
 *      disagree. Every division here is exact `bigint` arithmetic.
 *   2. No float ever touches money, equity, slices or ratios. `unpaidMinutes / 60` is
 *      a float division — a 20-minute log yields 0.333… and the drift compounds.
 *   3. Money and equity arithmetic in SQL is banned. SQL aggregates raw integers;
 *      TypeScript does every division.
 */

/** 10000 basis points = 100%. Basis points give 0.01% resolution and sum exactly. */
export const BASIS_POINTS_TOTAL = 10_000;

/**
 * Divides two BigInts, rounding exact halves AWAY FROM ZERO.
 *
 * Matches Postgres `round()` so a value computed in TypeScript and the same value
 * computed in SQL can never disagree. BigInt `/` truncates toward zero, so the sign
 * has to be reapplied explicitly — this is the trap that makes negative amounts
 * (reversals, refunds) silently wrong if you rely on the built-in operator.
 *
 * @throws if `denominator` is zero — an unrecoverable programmer error (CLAUDE.md §3.3).
 */
export function divRoundHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new Error("divRoundHalfAwayFromZero: denominator must not be zero");
  }

  const quotient = numerator / denominator;
  const remainder = numerator % denominator;

  if (remainder === 0n) {
    return quotient;
  }

  const absoluteRemainderDoubled = (remainder < 0n ? -remainder : remainder) * 2n;
  const absoluteDenominator = denominator < 0n ? -denominator : denominator;
  const resultSign = numerator < 0n !== denominator < 0n ? -1n : 1n;

  // >=, not >: an exact half rounds AWAY from zero, which is what Postgres does.
  return absoluteRemainderDoubled >= absoluteDenominator ? quotient + resultSign : quotient;
}

/**
 * Compares two strings by their UTF-8 BYTES, ascending.
 *
 * Deliberately not `a < b`: JavaScript compares UTF-16 code units, so an astral-plane
 * character (emoji, rare CJK) orders differently than it does under Postgres
 * `COLLATE "C"`. A tie-break that disagrees across those two places moves a basis
 * point, which changes an equity share, which changes a hash.
 */
function compareUtf8Bytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

interface ApportionmentSlot {
  readonly inputIndex: number;
  readonly flooredPart: number;
  readonly remainder: bigint;
  readonly weight: bigint;
  readonly tieBreakKey: string;
}

/**
 * Apportions `total` across `weights` by the LARGEST REMAINDER method (Hare–Niemeyer),
 * so the parts sum to EXACTLY `total` — never 9,999 or 10,001 basis points.
 *
 * Why not simply floor each share: with N members, flooring loses up to N−1 basis
 * points, so the shares sum to ≤ 9999. A cap table that does not sum to 100% is not a
 * cap table. Why not per-member half-even: it can overshoot to 10001 with no
 * correction step.
 *
 * Ties are broken on `tieBreakKeys` (ascending, byte-wise) so the result NEVER depends
 * on the order Postgres happened to return rows in. The full chain is
 * remainder DESC → weight DESC → tieBreakKey ASC; the third key is unique, so ties
 * always resolve.
 *
 * Results are returned in INPUT ORDER — the canonical ordering is applied internally
 * for the tie-break only, so callers can zip the result against their own array.
 *
 * Degenerate case: when every weight is zero (a brand-new project where nobody has
 * contributed yet) there is nothing to apportion, so every part is 0 and the
 * sum-to-total invariant is suspended. Callers must surface that as its own state
 * rather than rendering "0%" as a computed fact.
 *
 * @throws on mismatched lengths, duplicate tie-break keys, negative weights, or a
 *         non-integer / negative total — all unrecoverable programmer errors.
 */
export function apportionLargestRemainder(
  weights: readonly bigint[],
  total: number,
  tieBreakKeys: readonly string[],
): readonly number[] {
  if (weights.length !== tieBreakKeys.length) {
    throw new Error(
      `apportionLargestRemainder: weights (${weights.length}) and tieBreakKeys (${tieBreakKeys.length}) must be the same length`,
    );
  }
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error(
      `apportionLargestRemainder: total must be a non-negative integer, got ${total}`,
    );
  }
  if (new Set(tieBreakKeys).size !== tieBreakKeys.length) {
    throw new Error(
      "apportionLargestRemainder: tieBreakKeys must be unique — ties could not resolve",
    );
  }
  for (const weight of weights) {
    if (weight < 0n) {
      throw new Error(`apportionLargestRemainder: weights must be non-negative, got ${weight}`);
    }
  }

  if (weights.length === 0) {
    return [];
  }

  const totalWeight = weights.reduce((runningSum, weight) => runningSum + weight, 0n);

  if (totalWeight === 0n) {
    return weights.map(() => 0);
  }

  const totalAsBigInt = BigInt(total);
  const slots: ApportionmentSlot[] = weights.map((weight, inputIndex) => {
    const scaled = weight * totalAsBigInt;
    return {
      inputIndex,
      flooredPart: Number(scaled / totalWeight),
      remainder: scaled % totalWeight,
      weight,
      // Non-null: length equality is asserted above.
      tieBreakKey: tieBreakKeys[inputIndex] ?? "",
    };
  });

  const distributedSoFar = slots.reduce((runningSum, slot) => runningSum + slot.flooredPart, 0);
  const shortfall = total - distributedSoFar;

  // toSorted, not sort: the returned array must stay in INPUT order, so ranking must
  // not mutate `slots`.
  const ranked = slots.toSorted((left, right) => {
    if (left.remainder !== right.remainder) {
      return left.remainder > right.remainder ? -1 : 1;
    }
    if (left.weight !== right.weight) {
      return left.weight > right.weight ? -1 : 1;
    }
    return compareUtf8Bytes(left.tieBreakKey, right.tieBreakKey);
  });

  const parts = slots.map((slot) => slot.flooredPart);
  for (let awarded = 0; awarded < shortfall; awarded += 1) {
    const slot = ranked[awarded];
    if (slot === undefined) {
      throw new Error(
        `apportionLargestRemainder: shortfall ${shortfall} exceeds ${ranked.length} slots`,
      );
    }
    parts[slot.inputIndex] = (parts[slot.inputIndex] ?? 0) + 1;
  }

  // Assert the invariant rather than assuming it — this is the strongest correctness
  // claim in the domain and it costs one addition.
  const apportionedTotal = parts.reduce((runningSum, part) => runningSum + part, 0);
  if (apportionedTotal !== total) {
    throw new Error(
      `apportionLargestRemainder: invariant violated — parts sum to ${apportionedTotal}, expected ${total}`,
    );
  }

  return parts;
}

/**
 * Expresses `part` as basis points of `whole`, rounded half away from zero.
 *
 * For a SET of parts that must sum to exactly 10000, use `apportionLargestRemainder`
 * instead — calling this per member and summing is precisely the bug that produces a
 * 9,999-basis-point cap table.
 *
 * @throws if `whole` is zero; "what percentage of nothing" has no answer, and
 *         returning 0 would render as a computed fact.
 */
export function basisPointsOf(part: bigint, whole: bigint): number {
  if (whole === 0n) {
    throw new Error("basisPointsOf: whole must not be zero");
  }
  return Number(divRoundHalfAwayFromZero(part * BigInt(BASIS_POINTS_TOTAL), whole));
}
