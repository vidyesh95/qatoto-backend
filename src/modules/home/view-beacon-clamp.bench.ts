import { withCodSpeed } from "@codspeed/tinybench-plugin";
import { Bench } from "tinybench";

import {
  applyViewBeacon,
  pinReportedDurationSeconds,
  type ViewBeaconClaim,
  type ViewSessionClampState,
} from "#src/modules/home/view-beacon-clamp.js";
import {
  BENCHMARK_OPTIONS,
  createSeededRandom,
  MICRO_BENCHMARK_REPEATS,
  seededInteger,
} from "#src/test-support/bench-fixtures.js";

/**
 * The single hottest pure function on the read side: a watch beacon lands every 15 seconds for
 * every viewer watching anything, so this runs more often than any other clamp in the codebase.
 *
 * It is small, and that is the point — it is small enough that a change in it would never be
 * noticed by a route test, while being called often enough that a change in it is felt. Measuring
 * a whole session (240 beacons, an hour of watching) rather than a single call keeps the number
 * above the noise floor and keeps the state transition — the one beacon that flips a session to
 * counted — inside the measured work.
 */

const random = createSeededRandom(31);

/** One hour of beacons, with the seeks and stalls a real session contains. */
const SESSION_BEACONS: readonly ViewBeaconClaim[] = Array.from(
  { length: 240 },
  (unusedValue, beaconIndex) => {
    const drift = seededInteger(random, 5) - 2;
    // Every twentieth beacon is a backwards seek, which credits nothing and must not underflow.
    const isBackwardsSeek = beaconIndex > 0 && beaconIndex % 20 === 0;
    return {
      positionSeconds: isBackwardsSeek
        ? Math.max(0, beaconIndex * 15 - 90)
        : beaconIndex * 15 + drift,
      elapsedSecondsSinceLastBeacon: 15 + drift,
    };
  },
);

const INITIAL_SESSION_STATE: ViewSessionClampState = {
  watchedSeconds: 0,
  maxPositionSeconds: 0,
  pinnedDurationSeconds: 3600,
  completionBasisPoints: 0,
  isCountedView: false,
};

const REPORTED_DURATIONS: readonly number[] = Array.from({ length: 200 }, () =>
  seededInteger(random, 60_000),
);

export const viewBeaconClampBenchmarks = withCodSpeed(
  new Bench({ name: "view-beacon-clamp", ...BENCHMARK_OPTIONS }),
);

viewBeaconClampBenchmarks.add("applyViewBeacon folded over an hour-long session", () => {
  let sessionState = INITIAL_SESSION_STATE;
  for (const beaconClaim of SESSION_BEACONS) {
    const outcome = applyViewBeacon(sessionState, beaconClaim);
    sessionState = {
      watchedSeconds: outcome.watchedSeconds,
      maxPositionSeconds: outcome.maxPositionSeconds,
      pinnedDurationSeconds: sessionState.pinnedDurationSeconds,
      completionBasisPoints: outcome.completionBasisPoints,
      isCountedView: outcome.isCountedView,
    };
  }
  return sessionState;
});

viewBeaconClampBenchmarks.add("applyViewBeacon — 1000 first beacons", () => {
  for (let repeat = 0; repeat < MICRO_BENCHMARK_REPEATS; repeat += 1) {
    applyViewBeacon(INITIAL_SESSION_STATE, {
      positionSeconds: 15,
      elapsedSecondsSinceLastBeacon: 15,
    });
  }
});

viewBeaconClampBenchmarks.add("pinReportedDurationSeconds over 200 client claims", () => {
  for (const reportedDurationSeconds of REPORTED_DURATIONS) {
    pinReportedDurationSeconds(reportedDurationSeconds);
  }
});
