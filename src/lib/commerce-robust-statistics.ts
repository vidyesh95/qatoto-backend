/**
 * Robust statistics for the ranking engine's spike detector (STORE Phase 13, refinement 6).
 *
 * WHY ROBUST AND NOT ORDINARY. A spike threshold built on a mean and a standard deviation
 * is defeated by the very thing it is looking for: one enormous day inflates both, so the
 * next enormous day looks ordinary. The median and the median absolute deviation do not
 * move when a minority of observations are extreme, which is exactly the property a fraud
 * trigger needs.
 *
 * EVERYTHING RETURNS `null` BELOW ITS MINIMUM SAMPLE. A median of two observations is not a
 * baseline, and a threshold derived from one would fire on ordinary variation. The caller
 * must fall back to the specification's minimum floors rather than treating `null` as zero
 * — the same null-below-threshold rule Phase 12 applied to on-time delivery.
 *
 * PURE, and integer in / integer out. No clock, no database, no floats reaching a column.
 */

/**
 * Days of history before a baseline is believable.
 *
 * Two weeks: short enough that a new product becomes measurable inside a month, long enough
 * that a weekly buying rhythm — which B2B procurement absolutely has — is inside the window
 * rather than being mistaken for a trend.
 */
export const MINIMUM_BASELINE_SAMPLE = 14;

/** The multiplier on the robust spread. Two is the specification's figure. */
export const SPIKE_DEVIATION_MULTIPLIER = 2;

/**
 * Scales the median absolute deviation so it estimates the same quantity a standard
 * deviation would on normally distributed data. Without it, a MAD-based threshold is
 * roughly two-thirds as wide as the equivalent sigma threshold and fires far too often.
 */
const MAD_TO_STANDARD_DEVIATION_SCALE = 1.4826;

/** The median of a sample, or `null` when the sample is empty. */
export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;

  const sorted = [...values].toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) return sorted[middle] ?? null;

  const lower = sorted[middle - 1];
  const upper = sorted[middle];
  if (lower === undefined || upper === undefined) return null;
  return (lower + upper) / 2;
}

/**
 * The median absolute deviation — the median of each observation's distance from the
 * median. `null` on an empty sample.
 */
export function medianAbsoluteDeviationOf(values: readonly number[]): number | null {
  const median = medianOf(values);
  if (median === null) return null;

  return medianOf(values.map((value) => Math.abs(value - median)));
}

export interface SpikeThresholdInput {
  /** The trailing daily observations, excluding today. Order does not matter. */
  readonly baselineValues: readonly number[];
  /**
   * The specification's floor for this signal — `100` for views, `20` for saves, `5` for
   * orders. A threshold never falls below it, so a product with a tiny baseline cannot be
   * flagged for going from 1 to 4.
   */
  readonly minimumFloor: number;
}

export type SpikeThreshold =
  | {
      /** Not enough history to compute a baseline. The floor alone governs. */
      readonly status: "floor_only";
      readonly threshold: number;
      readonly sampleSize: number;
    }
  | {
      readonly status: "measured";
      readonly threshold: number;
      readonly sampleSize: number;
      readonly median: number;
      readonly robustDeviation: number;
    };

/**
 * The value today must exceed to count as a spike.
 *
 * A DISCRIMINATED UNION rather than a bare number, because "we floored this because we have
 * no history" and "we measured a baseline and this is where it landed" are different facts,
 * and an operator reading a fraud review needs to know which one produced the threshold.
 *
 * The zero-variance case is deliberate: a product with a perfectly flat baseline has a MAD
 * of 0, and `median + 2 * 0` would flag the very first day it moved at all. The floor is
 * what stops that, which is why the specification asks for the floor to be a `max` rather
 * than a fallback.
 */
export function computeSpikeThreshold(input: SpikeThresholdInput): SpikeThreshold {
  const sampleSize = input.baselineValues.length;

  if (sampleSize < MINIMUM_BASELINE_SAMPLE) {
    return { status: "floor_only", threshold: input.minimumFloor, sampleSize };
  }

  const median = medianOf(input.baselineValues);
  const deviation = medianAbsoluteDeviationOf(input.baselineValues);
  if (median === null || deviation === null) {
    return { status: "floor_only", threshold: input.minimumFloor, sampleSize };
  }

  const robustDeviation = deviation * MAD_TO_STANDARD_DEVIATION_SCALE;
  const measured = Math.ceil(median + SPIKE_DEVIATION_MULTIPLIER * robustDeviation);

  return {
    status: "measured",
    threshold: Math.max(input.minimumFloor, measured),
    sampleSize,
    median,
    robustDeviation,
  };
}

/**
 * A percentile of a sample, using the NEAREST-RANK method — an actual observation, never an
 * interpolation between two.
 *
 * `percentile_disc` semantics on purpose, matching the SQL side. An interpolated percentile
 * invents a value no order ever had, and every threshold here is compared against real
 * money and real counts.
 */
export function percentileOf(values: readonly number[], percentile: number): number | null {
  if (values.length === 0) return null;
  if (percentile < 0 || percentile > 1) {
    throw new Error(`percentileOf: percentile must be within [0, 1], got ${String(percentile)}`);
  }

  const sorted = [...values].toSorted((left, right) => left - right);
  const rank = Math.max(0, Math.ceil(percentile * sorted.length) - 1);
  return sorted[rank] ?? null;
}
