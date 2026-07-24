/**
 * The Slicing Pie formula (R_AND_D_BACKEND_STRUCTURE.md §9.2, §9.3; PROOF_OF_EFFORT_SPEC.md §3).
 *
 * THE DETERMINISM BOUNDARY RUNS THROUGH THIS FILE. §9.1 splits the domain in two:
 * AI produces inputs and judgements, which a human may review and override; the FORMULA
 * produces numbers, which nobody hand-edits — not staff, not the founder, not a DBA.
 * Everything in this module is on the formula side. It is pure, it takes only integers,
 * and its output is written to `slice_ledger_entry` by exactly one service.
 *
 * THE MODEL, in the spec's own units: a contribution converts to standardized Slices
 * multiplied by a risk premium. Cash is scarce, usually taxed before investment, and
 * easily lost, so it earns 4×. Non-cash contribution — time, valued at what the person
 * would have earned at a normal job — earns 2×.
 *
 *     Slices(cash) = dollarsSpent × 4
 *     Slices(time) = unpaidHours × dollarsPerHour × 2
 *
 * IN WIRE UNITS BOTH REDUCE TO ONE DENOMINATOR OF 3000, which is why this module has a
 * single divisor and a single rounding step:
 *
 *     time: (minutes / 60) × (cents / 100) × 2 = minutes × cents / 3000
 *     cash: (cents / 100) × 4                  = cents × 120 / 3000
 *
 * `bigint`, without exception. A single entry already reaches 8,880 × 12,000 =
 * 106,560,000, and summed over the life of a project a slice total approaches
 * `Number.MAX_SAFE_INTEGER`. The NUMERATOR is `bigint` here and in Postgres;
 * `slicesAwarded` stays a bounded `integer` because it is one day's award, not a running
 * total.
 */

/**
 * The single denominator both contribution kinds reduce to.
 *
 * It is 3000 and not 6000 or 1500 because of the exact arithmetic above: 60 minutes per
 * hour × 100 cents per dollar ÷ the 2× time premium. Changing it silently re-prices every
 * historical entry, so it is declared once, here, and imported everywhere.
 */
export const SLICE_DENOMINATOR = 3_000n;

/** The cash premium, pre-multiplied onto the shared denominator: 4 × 3000 / 100. */
const CASH_PREMIUM_OVER_DENOMINATOR = 120n;

/**
 * `slice_ledger_entry.slicesAwarded` is a Postgres `integer` (int4).
 *
 * Asserted rather than assumed: a single claim large enough to overflow int4 would be
 * rejected by the database anyway, but it would be rejected with a driver-level numeric
 * error thrown from inside a transaction that has already appended an audit entry. Failing
 * in the pure function names the claim instead.
 */
const MAXIMUM_SLICES_AWARDED = 2_147_483_647;

function requireNonNegativeSafeInteger(
  value: number,
  functionName: string,
  parameterName: string,
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `${functionName}: ${parameterName} must be a non-negative safe integer, got ${value}`,
    );
  }
}

/**
 * The rate the ledger actually prices: fair market value MINUS what the member is already
 * being paid in cash.
 *
 * WHY THIS FUNCTION EXISTS AT ALL. Slicing Pie credits only the UNPAID portion of a
 * contribution — a slice records risk taken, and an hour someone was paid market rate for
 * carried no risk. `member_fair_market_rate` therefore stores BOTH
 * `fairMarketRateCentsPerHour` and `paidCashRateCentsPerHour`, and this is where the
 * difference is taken. Without it a salaried member earns full sweat equity ON TOP OF
 * their salary; §9.2 calls that "the largest correctness gap in the mock".
 *
 * Floored at zero, deliberately. A member paid ABOVE their fair market rate has taken
 * negative risk, and the honest answer is that they earn no slices for that hour — not
 * that they owe slices back. Negative accrual would let a raise retroactively claw equity
 * out of the pool, and §9.10's reasoning about never clawing back applies with equal
 * force here.
 */
export function unpaidRateCentsPerHour(
  fairMarketRateCentsPerHour: number,
  paidCashRateCentsPerHour: number,
): bigint {
  requireNonNegativeSafeInteger(
    fairMarketRateCentsPerHour,
    "unpaidRateCentsPerHour",
    "fairMarketRateCentsPerHour",
  );
  requireNonNegativeSafeInteger(
    paidCashRateCentsPerHour,
    "unpaidRateCentsPerHour",
    "paidCashRateCentsPerHour",
  );

  const unpaidPortion = BigInt(fairMarketRateCentsPerHour) - BigInt(paidCashRateCentsPerHour);
  return unpaidPortion > 0n ? unpaidPortion : 0n;
}

/**
 * The numerator of a TIME contribution, over {@link SLICE_DENOMINATOR}.
 *
 * Returns the exact rational's numerator rather than a slice count, because §9.3 rounds
 * EXACTLY ONCE, at ledger-entry write. `sliceNumerator` is stored alongside
 * `slicesAwarded` so an auditor can see precisely where the half-slice went — rounding
 * you cannot inspect is indistinguishable from a bug.
 *
 * Takes the UNPAID rate, never the fair market rate; see {@link unpaidRateCentsPerHour}.
 */
export function timeSliceNumerator(
  effortMinutes: number,
  unpaidRateInCentsPerHour: bigint,
): bigint {
  requireNonNegativeSafeInteger(effortMinutes, "timeSliceNumerator", "effortMinutes");
  if (unpaidRateInCentsPerHour < 0n) {
    throw new Error(
      `timeSliceNumerator: unpaidRateInCentsPerHour must be non-negative, got ${unpaidRateInCentsPerHour}`,
    );
  }

  return BigInt(effortMinutes) * unpaidRateInCentsPerHour;
}

/**
 * The numerator of a CASH contribution, over {@link SLICE_DENOMINATOR}.
 *
 * Cash carries no rate and no paid-portion subtraction — money spent out of pocket is
 * unpaid by definition. `bigint` in, because a cash claim is money and money never
 * touches int4 (§4b).
 */
export function cashSliceNumerator(cashSpentInCents: bigint): bigint {
  if (cashSpentInCents < 0n) {
    throw new Error(
      `cashSliceNumerator: cashSpentInCents must be non-negative, got ${cashSpentInCents}`,
    );
  }

  return cashSpentInCents * CASH_PREMIUM_OVER_DENOMINATOR;
}

/**
 * Divides two BigInts, rounding exact halves to the nearest EVEN quotient (banker's
 * rounding).
 *
 * NOT THE SAME FUNCTION AS `divRoundHalfAwayFromZero` in src/lib/money.ts, and the two
 * must not be swapped:
 *
 *   - money.ts rounds halves AWAY FROM ZERO because it must agree with Postgres `round()`
 *     — a cents value computed in TypeScript and the same value computed in SQL cannot be
 *     allowed to disagree.
 *   - THIS function rounds halves to EVEN because it prices equity. With a denominator of
 *     3000 an exact tie is genuinely reachable, and half-away-from-zero biases every tie
 *     in one direction — a systematic drift favouring whoever files the most granular
 *     claims. Half-even has zero tie bias in expectation (§9.3 rule 3).
 *
 * Sign is applied explicitly because BigInt `/` truncates toward zero rather than
 * flooring, and reversal entries carry NEGATIVE numerators (§9.3 rule 4). `-3n / 2n` is
 * `-1n`, not `-2n`; without the explicit sign every reversal would round the wrong way.
 *
 * @throws if `denominator` is zero — an unrecoverable programmer error (CLAUDE.md §3.3).
 */
export function divideRoundHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new Error("divideRoundHalfEven: denominator must not be zero");
  }

  const quotient = numerator / denominator;
  const remainder = numerator % denominator;

  if (remainder === 0n) {
    return quotient;
  }

  const absoluteRemainderDoubled = (remainder < 0n ? -remainder : remainder) * 2n;
  const absoluteDenominator = denominator < 0n ? -denominator : denominator;
  const resultSign = numerator < 0n !== denominator < 0n ? -1n : 1n;

  if (absoluteRemainderDoubled > absoluteDenominator) {
    return quotient + resultSign;
  }
  if (absoluteRemainderDoubled < absoluteDenominator) {
    return quotient;
  }

  // An exact tie: land on whichever neighbour is even. `quotient` is already truncated
  // toward zero, so the other candidate is one step further AWAY from zero.
  return quotient % 2n === 0n ? quotient : quotient + resultSign;
}

/**
 * Turns an exact numerator into the integer slice count written to the ledger.
 *
 * THE ONE PLACE ROUNDING HAPPENS in the whole equity path (§9.3 rule 1). Nothing
 * downstream re-rounds: `equity_snapshot.totalSlices` is a plain `SUM` of values this
 * function already made final, and apportionment to basis points works from those sums.
 * A second rounding step anywhere would make the cap table depend on the order rows were
 * aggregated in.
 *
 * ZERO IS A LEGITIMATE RESULT and the caller must still write an entry for it (§9.3, the
 * anti-dust rule). A claim that rounds to nothing has been verified, priced, and awarded
 * zero — dropping the row would leave a hole in `sequenceNumber` and break the audit
 * story, which is a far worse outcome than a row of zeroes.
 *
 * Negative numerators are accepted: that is a `reversal` entry, and it is the ONLY
 * correction mechanism this domain has (§9.1 — never an `UPDATE`).
 *
 * @throws if the result falls outside int4, which `slice_ledger_entry.slicesAwarded` is.
 */
export function computeSlicesAwarded(sliceNumerator: bigint): number {
  const awarded = divideRoundHalfEven(sliceNumerator, SLICE_DENOMINATOR);

  if (awarded > BigInt(MAXIMUM_SLICES_AWARDED) || awarded < BigInt(-MAXIMUM_SLICES_AWARDED)) {
    throw new Error(
      `computeSlicesAwarded: ${awarded} slices exceeds the int4 range of slice_ledger_entry.slicesAwarded`,
    );
  }

  return Number(awarded);
}
