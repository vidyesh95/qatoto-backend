/**
 * What a product-view beacon is allowed to claim (STORE Phase 13).
 *
 * A PURE MODULE, deliberately, for the reason `trending-score.ts` is one: this is the
 * boundary between a hostile number and a ranking input, and a boundary that can only be
 * tested through a database transaction does not get tested.
 *
 * THE THREAT. `dwell_seconds` reaches the conversion denominator and the MAD spike
 * baseline. A client that could assert its own dwell could mint an arbitrarily engaged
 * session from a single request — and unlike a save or an order, a view costs the
 * attacker nothing. So the client PROPOSES a total and the server bounds it by physics:
 * a session cannot have accumulated more attention than the wall-clock time that has
 * passed since its first beacon.
 *
 * WHY A TOTAL AND NOT A DELTA. A delta protocol means a lost or duplicated beacon
 * silently under- or over-counts, and there is no way to tell afterwards which happened.
 * A running total is idempotent: replaying the same beacon twice produces the same row,
 * which is the property the anti-replay unique index is already built around.
 *
 * THE GRACE. Wall time is measured between two server-observed instants, so a beacon in
 * flight, a clock skewed by a second, or a client that batched its timer all read as
 * "claimed more than elapsed". A few seconds of grace absorbs that without opening a
 * useful attack — an attacker willing to hold a connection open for the real duration is
 * not attacking, they are browsing.
 */

/** A session cannot claim more than this in total. Mirrors the database CHECK. */
export const MAXIMUM_VIEW_DWELL_SECONDS = 3600;

/**
 * Slack against clock skew and in-flight beacons. Small enough that accumulating a fake
 * hour would take an hour of real requests.
 */
export const VIEW_DWELL_GRACE_SECONDS = 5;

/**
 * How long a session must hold attention before it is a VIEW rather than a bounce.
 *
 * This is the single number that decides what `commerce_product_stats.view_count` means,
 * and therefore what every conversion rate is divided by. Five seconds is short enough
 * that a real buyer skimming a listing counts, and long enough that a crawler, a prefetch
 * and an accidental tap do not.
 */
export const COUNTED_VIEW_MINIMUM_DWELL_SECONDS = 5;

export interface ViewDwellClampInput {
  /** The client's claim for total attention on this session so far. Hostile. */
  readonly claimedTotalDwellSeconds: number;
  /** What the row already holds. A total may never move backwards. */
  readonly storedDwellSeconds: number;
  /** Server-observed instant of this session's first beacon. */
  readonly firstBeaconAt: Date;
  /** Server-observed instant of this beacon. */
  readonly observedAt: Date;
}

/**
 * The dwell total that may be written.
 *
 * Monotonic by construction — a client that reports a smaller total than the row already
 * holds (a reload, a second tab, a rounding difference) cannot walk the value down and
 * un-count a view that already counted.
 */
export function clampViewDwellSeconds(input: ViewDwellClampInput): number {
  const elapsedMilliseconds = input.observedAt.getTime() - input.firstBeaconAt.getTime();
  // A negative elapsed means the row's own timestamps disagree with this beacon, which is
  // a clock problem rather than a claim to honour. Fall back to the grace alone.
  const elapsedSeconds = elapsedMilliseconds > 0 ? Math.floor(elapsedMilliseconds / 1000) : 0;

  const physicalCeiling = Math.min(
    elapsedSeconds + VIEW_DWELL_GRACE_SECONDS,
    MAXIMUM_VIEW_DWELL_SECONDS,
  );

  // `Number.isFinite` rejects NaN and Infinity before they reach `Math.min`, where NaN
  // would propagate silently and land in an integer column as an error nobody reads.
  const claimed = Number.isFinite(input.claimedTotalDwellSeconds)
    ? Math.max(0, Math.floor(input.claimedTotalDwellSeconds))
    : 0;

  const stored = Math.max(0, Math.floor(input.storedDwellSeconds));

  return Math.max(stored, Math.min(claimed, physicalCeiling));
}

/** Whether a dwell total has earned the session a place in `view_count`. */
export function isCountedViewDwell(dwellSeconds: number): boolean {
  return dwellSeconds >= COUNTED_VIEW_MINIMUM_DWELL_SECONDS;
}
