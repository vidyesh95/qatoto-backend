/**
 * The watch-progress clamp — HOME_BACKEND_STRUCTURE.md §3.3.
 *
 * WHAT THIS MODULE DEFENDS. `POST /videos/:videoId/view-beacon` is the only
 * unauthenticated write on the platform. Its payload is not a measurement, it is a
 * **claim** about a measurement, made by code running in an attacker's browser. A
 * creator who edits the payload in DevTools must not be able to promote their own
 * video, and every clause below exists to make that specific attack cost more than it
 * returns.
 *
 * WHY IT IS A PURE MODULE. Same shape and same reasoning as `opportunity-score.ts`:
 *
 *   * **Integers only.** No floats, no `Math.exp`, no division that produces one. Two
 *     runs over the same inputs produce bit-identical output, which is what makes a
 *     ranking bug reproducible instead of folklore.
 *   * **No clock read.** `elapsedSecondsSinceLastBeacon` is a PARAMETER. A `Date.now()`
 *     in here would make every test a race and every replay a different answer.
 *   * **No I/O.** The service fetches the session row, calls this, writes the result.
 *     The clamp cannot be bypassed by a code path that forgot to call the database.
 *   * **Total.** Every input the type system permits has a defined output. The guards
 *     throw only for values that are physically impossible from a Zod-parsed body plus
 *     a CHECK-constrained row — the invariant case CLAUDE.md §3.3 licenses a throw for.
 */

/**
 * How often the client heartbeats while the YouTube player reports "playing"
 * (frontend §6). It is the CEILING on a single beacon's credit, not a description of
 * client behaviour: a client that skips heartbeats and then claims the whole gap gets
 * one interval's worth, because the alternative is a client that heartbeats once at
 * the end of a 10-minute page and claims all of it.
 */
export const BEACON_INTERVAL_SECONDS = 15;

/**
 * Slack on the wall-clock bound, for network latency, a paused event loop and clock
 * skew between the client's timer and the server's `now`.
 *
 * Deliberately small. This is the entire margin an attacker gets for free per beacon,
 * so it buys honest clients tolerance and buys a farm 5 seconds per request.
 */
export const BEACON_GRACE_SECONDS = 5;

/** Ten seconds of real playback, or... */
export const COUNTED_VIEW_MINIMUM_WATCHED_SECONDS = 10;

/**
 * ...30% of the video, whichever comes first. The second clause is what stops a
 * 12-second clip being uncountable: finishing it is unambiguously a view.
 */
export const COUNTED_VIEW_MINIMUM_COMPLETION_BASIS_POINTS = 3_000;

/** 100%, in basis points. Completion is stored as bp so it never becomes a float. */
export const MAXIMUM_COMPLETION_BASIS_POINTS = 10_000;

/** A duration of zero is a division by zero; the floor is one second. */
export const MINIMUM_REPORTED_DURATION_SECONDS = 1;

/** 12 hours. Longer than this is not a video anybody finishes. */
export const MAXIMUM_REPORTED_DURATION_SECONDS = 43_200;

/** The state of the session row before this beacon is applied. */
export interface ViewSessionClampState {
  readonly watchedSeconds: number;
  readonly maxPositionSeconds: number;
  /** Pinned on the first beacon, already inside 1..43200 by CHECK. */
  readonly pinnedDurationSeconds: number;
  readonly completionBasisPoints: number;
  readonly isCountedView: boolean;
}

/** What the client says, after Zod has floored it to an integer. */
export interface ViewBeaconClaim {
  readonly positionSeconds: number;
  /**
   * Wall-clock seconds since the session's `lastBeaconAt`, measured SERVER-SIDE.
   * The caller floors it at 0 — a negative value would mean the server's own clock
   * went backwards, and crediting negative time is not an improvement over zero.
   */
  readonly elapsedSecondsSinceLastBeacon: number;
}

export interface ViewBeaconOutcome {
  readonly watchedSeconds: number;
  readonly maxPositionSeconds: number;
  readonly completionBasisPoints: number;
  /**
   * `completionBasisPoints` minus the session's previous value. The service adds this
   * to `video_stats.completion_bp_sum` on every beacon AFTER the counted-view flip, so
   * the stored sum tracks each session's FINAL completion rather than the mean of
   * every heartbeat it ever sent.
   */
  readonly completionBasisPointsDelta: number;
  /** The clamped delta. What `video_stats.total_watched_seconds` moves by. */
  readonly creditedSeconds: number;
  readonly isCountedView: boolean;
  /**
   * True on the ONE beacon that flips the session to counted. This — and nothing else
   * — is what increments `video_stats.view_count`, which is why beacon count and view
   * count are not the same number (Rule 4).
   */
  readonly didBecomeCountedView: boolean;
}

/**
 * @throws if the value could not have come from a Zod-parsed body or a CHECK-constrained
 *         row, which means something upstream stopped validating.
 */
function assertNonNegativeSafeInteger(
  functionName: string,
  parameterName: string,
  measuredValue: number,
): void {
  if (!Number.isSafeInteger(measuredValue) || measuredValue < 0) {
    throw new Error(
      `${functionName}: ${parameterName} must be a non-negative safe integer, got ${String(measuredValue)}`,
    );
  }
}

/**
 * Bounds the duration the client reported on the FIRST beacon of a session.
 *
 * `video.duration_seconds` is NULL for every YouTube row — oEmbed returns no duration —
 * so this claim is the only denominator available, and it comes from the hostile side.
 * The service pins the result and ignores every later beacon that disagrees, which is
 * what stops a client shrinking its own denominator mid-session to inflate completion.
 *
 * Clamps rather than rejects: a beacon must never fail loudly (the client would retry
 * on the watch page), and a nonsense duration that lands at the bound is harmless —
 * it makes completion approximately zero, which is the safe direction.
 */
export function pinReportedDurationSeconds(reportedDurationSeconds: number): number {
  assertNonNegativeSafeInteger(
    "pinReportedDurationSeconds",
    "reportedDurationSeconds",
    reportedDurationSeconds,
  );

  if (reportedDurationSeconds < MINIMUM_REPORTED_DURATION_SECONDS) {
    return MINIMUM_REPORTED_DURATION_SECONDS;
  }
  if (reportedDurationSeconds > MAXIMUM_REPORTED_DURATION_SECONDS) {
    return MAXIMUM_REPORTED_DURATION_SECONDS;
  }
  return reportedDurationSeconds;
}

/**
 * Applies one beacon to a session, clamped.
 *
 * EVERY CLAUSE IS LOAD-BEARING:
 *
 *   * **Credit is bounded by wall-clock elapsed.** A client claiming it advanced 600
 *     seconds inside a 15-second window gets 20. You cannot watch a video faster than
 *     time passes.
 *   * **Credit is bounded by one beacon interval.** Otherwise a client that stays
 *     silent for an hour and then sends one beacon claims the hour.
 *   * **Credit is floored at 0.** Seeking backwards adds nothing, and seeking forwards
 *     adds nothing beyond the wall-clock bound — so scrubbing to the end does not
 *     manufacture a completion.
 *   * **Position is bounded by the pinned duration.** AN ADDITION TO §3.3. `9999` is
 *     not a position on a 400-second video, and storing it would make
 *     `max_position_seconds` a column nobody can reason about — it is the input a
 *     drop-off curve would read. Note what this does NOT do: a client that claims the
 *     end of the video still spends its own session, because every later beacon then
 *     computes a negative raw delta and credits zero. That cost lands on the client
 *     that lied, which is where it belongs.
 *   * **`isCountedView` only ever goes false -> true.** Re-flipping is a no-op, so the
 *     view counter cannot be pumped by continuing to beacon.
 */
export function applyViewBeacon(
  sessionState: ViewSessionClampState,
  beaconClaim: ViewBeaconClaim,
): ViewBeaconOutcome {
  assertNonNegativeSafeInteger("applyViewBeacon", "watchedSeconds", sessionState.watchedSeconds);
  assertNonNegativeSafeInteger(
    "applyViewBeacon",
    "maxPositionSeconds",
    sessionState.maxPositionSeconds,
  );
  assertNonNegativeSafeInteger(
    "applyViewBeacon",
    "pinnedDurationSeconds",
    sessionState.pinnedDurationSeconds,
  );
  assertNonNegativeSafeInteger(
    "applyViewBeacon",
    "completionBasisPoints",
    sessionState.completionBasisPoints,
  );
  assertNonNegativeSafeInteger("applyViewBeacon", "positionSeconds", beaconClaim.positionSeconds);
  assertNonNegativeSafeInteger(
    "applyViewBeacon",
    "elapsedSecondsSinceLastBeacon",
    beaconClaim.elapsedSecondsSinceLastBeacon,
  );

  const maximumCreditableSeconds = Math.min(
    beaconClaim.elapsedSecondsSinceLastBeacon + BEACON_GRACE_SECONDS,
    BEACON_INTERVAL_SECONDS + BEACON_GRACE_SECONDS,
  );

  const boundedPositionSeconds = Math.min(
    beaconClaim.positionSeconds,
    sessionState.pinnedDurationSeconds,
  );
  const rawDeltaSeconds = boundedPositionSeconds - sessionState.maxPositionSeconds;
  const creditedSeconds = Math.max(0, Math.min(rawDeltaSeconds, maximumCreditableSeconds));

  const watchedSeconds = sessionState.watchedSeconds + creditedSeconds;
  const maxPositionSeconds = Math.max(sessionState.maxPositionSeconds, boundedPositionSeconds);

  // Integer division, floored, so TypeScript and Postgres can never disagree about a
  // half. `Math.max(1, ...)` is belt-and-braces against a zero denominator the CHECK
  // already forbids — a division by zero here would poison the ranker with Infinity.
  const completionBasisPoints = Math.min(
    MAXIMUM_COMPLETION_BASIS_POINTS,
    Math.floor(
      (watchedSeconds * MAXIMUM_COMPLETION_BASIS_POINTS) /
        Math.max(1, sessionState.pinnedDurationSeconds),
    ),
  );

  const qualifiesAsCountedView =
    watchedSeconds >= COUNTED_VIEW_MINIMUM_WATCHED_SECONDS ||
    completionBasisPoints >= COUNTED_VIEW_MINIMUM_COMPLETION_BASIS_POINTS;

  return {
    watchedSeconds,
    maxPositionSeconds,
    completionBasisPoints,
    completionBasisPointsDelta: completionBasisPoints - sessionState.completionBasisPoints,
    creditedSeconds,
    isCountedView: sessionState.isCountedView || qualifiesAsCountedView,
    didBecomeCountedView: !sessionState.isCountedView && qualifiesAsCountedView,
  };
}
