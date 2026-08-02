import { describe, expect, it } from "vitest";

import {
  applyViewBeacon,
  BEACON_GRACE_SECONDS,
  BEACON_INTERVAL_SECONDS,
  COUNTED_VIEW_MINIMUM_WATCHED_SECONDS,
  MAXIMUM_COMPLETION_BASIS_POINTS,
  MAXIMUM_REPORTED_DURATION_SECONDS,
  MINIMUM_REPORTED_DURATION_SECONDS,
  pinReportedDurationSeconds,
  type ViewSessionClampState,
} from "#src/lib/view-beacon-clamp.js";

/**
 * The clamp is the only thing standing between an attacker-controlled payload and the
 * inputs that rank the homepage. HOME_BACKEND_STRUCTURE.md §10 names two of these
 * checks as manual `curl` probes; they are cheaper and more precise here.
 */

/** A fresh session on a 400-second video. */
function freshSession(overrides: Partial<ViewSessionClampState> = {}): ViewSessionClampState {
  return {
    watchedSeconds: 0,
    maxPositionSeconds: 0,
    pinnedDurationSeconds: 400,
    completionBasisPoints: 0,
    isCountedView: false,
    ...overrides,
  };
}

describe("the honest path", () => {
  it("credits a full interval for a heartbeat that advanced by one", () => {
    const outcome = applyViewBeacon(freshSession(), {
      positionSeconds: 15,
      elapsedSecondsSinceLastBeacon: 15,
    });

    expect(outcome.creditedSeconds).toBe(15);
    expect(outcome.watchedSeconds).toBe(15);
    expect(outcome.maxPositionSeconds).toBe(15);
  });

  it("accumulates across a sequence and lands on the right completion", () => {
    let session = freshSession({ pinnedDurationSeconds: 60 });

    for (let beaconIndex = 1; beaconIndex <= 4; beaconIndex += 1) {
      const outcome = applyViewBeacon(session, {
        positionSeconds: beaconIndex * 15,
        elapsedSecondsSinceLastBeacon: 15,
      });
      session = { ...session, ...outcome };
    }

    expect(session.watchedSeconds).toBe(60);
    expect(session.completionBasisPoints).toBe(MAXIMUM_COMPLETION_BASIS_POINTS);
  });
});

describe("the wall-clock bound", () => {
  it("gives a client claiming 9999 seconds one second later at most 1 + GRACE", () => {
    // §10's manual probe, as an assertion.
    const outcome = applyViewBeacon(freshSession(), {
      positionSeconds: 9_999,
      elapsedSecondsSinceLastBeacon: 1,
    });

    expect(outcome.creditedSeconds).toBe(1 + BEACON_GRACE_SECONDS);
    expect(outcome.watchedSeconds).toBe(1 + BEACON_GRACE_SECONDS);
  });

  it("caps a long silence at one beacon interval, not at the elapsed time", () => {
    const outcome = applyViewBeacon(freshSession({ pinnedDurationSeconds: 3_600 }), {
      positionSeconds: 600,
      elapsedSecondsSinceLastBeacon: 600,
    });

    expect(outcome.creditedSeconds).toBe(BEACON_INTERVAL_SECONDS + BEACON_GRACE_SECONDS);
  });
});

describe("seeking", () => {
  it("credits nothing for seeking backwards and never lowers watchedSeconds", () => {
    const session = freshSession({ watchedSeconds: 120, maxPositionSeconds: 120 });

    const outcome = applyViewBeacon(session, {
      positionSeconds: 30,
      elapsedSecondsSinceLastBeacon: 15,
    });

    expect(outcome.creditedSeconds).toBe(0);
    expect(outcome.watchedSeconds).toBe(120);
    expect(outcome.maxPositionSeconds).toBe(120);
  });

  it("does not manufacture a completion by scrubbing to the end", () => {
    const outcome = applyViewBeacon(freshSession(), {
      positionSeconds: 400,
      elapsedSecondsSinceLastBeacon: 1,
    });

    // Six seconds of a 400-second video is 150 bp, not 10000.
    expect(outcome.watchedSeconds).toBe(1 + BEACON_GRACE_SECONDS);
    expect(outcome.completionBasisPoints).toBe(150);
    expect(outcome.isCountedView).toBe(false);
  });

  it("never records a position outside the video, and burns the liar's own session", () => {
    const poisoned = applyViewBeacon(freshSession(), {
      positionSeconds: 9_999,
      elapsedSecondsSinceLastBeacon: 1,
    });

    // The column stays inside the video — 9999 is not a position on a 400-second row.
    expect(poisoned.maxPositionSeconds).toBe(400);
    expect(poisoned.creditedSeconds).toBe(1 + BEACON_GRACE_SECONDS);

    // And the session is now spent: every later beacon computes a negative raw delta.
    // That cost lands on the client that lied, which is the right place for it.
    const afterwards = applyViewBeacon(
      { ...freshSession(), ...poisoned },
      {
        positionSeconds: 20,
        elapsedSecondsSinceLastBeacon: 15,
      },
    );
    expect(afterwards.creditedSeconds).toBe(0);
  });
});

describe("completion", () => {
  it("caps at 10000 basis points", () => {
    const outcome = applyViewBeacon(
      freshSession({ pinnedDurationSeconds: 10, watchedSeconds: 100, maxPositionSeconds: 10 }),
      { positionSeconds: 10, elapsedSecondsSinceLastBeacon: 15 },
    );

    expect(outcome.completionBasisPoints).toBe(MAXIMUM_COMPLETION_BASIS_POINTS);
  });

  it("reports the delta against the session's previous value", () => {
    const outcome = applyViewBeacon(
      freshSession({
        pinnedDurationSeconds: 100,
        watchedSeconds: 10,
        maxPositionSeconds: 10,
        completionBasisPoints: 1_000,
      }),
      { positionSeconds: 20, elapsedSecondsSinceLastBeacon: 15 },
    );

    expect(outcome.completionBasisPoints).toBe(2_000);
    expect(outcome.completionBasisPointsDelta).toBe(1_000);
  });
});

describe("the counted-view flip", () => {
  it("is false below the threshold and true once crossed", () => {
    const belowThreshold = applyViewBeacon(freshSession(), {
      positionSeconds: 3,
      elapsedSecondsSinceLastBeacon: 3,
    });
    expect(belowThreshold.isCountedView).toBe(false);
    expect(belowThreshold.didBecomeCountedView).toBe(false);

    const crossing = applyViewBeacon(
      { ...freshSession(), ...belowThreshold },
      {
        positionSeconds: 3 + COUNTED_VIEW_MINIMUM_WATCHED_SECONDS,
        elapsedSecondsSinceLastBeacon: 15,
      },
    );
    expect(crossing.isCountedView).toBe(true);
    expect(crossing.didBecomeCountedView).toBe(true);
  });

  it("flips exactly once across a long sequence", () => {
    let session = freshSession();
    let flipCount = 0;

    for (let beaconIndex = 1; beaconIndex <= 20; beaconIndex += 1) {
      const outcome = applyViewBeacon(session, {
        positionSeconds: beaconIndex * 15,
        elapsedSecondsSinceLastBeacon: 15,
      });
      if (outcome.didBecomeCountedView) flipCount += 1;
      session = { ...session, ...outcome };
    }

    expect(flipCount).toBe(1);
    expect(session.isCountedView).toBe(true);
  });

  it("counts a short video via the 30% clause before ten watched seconds", () => {
    // 6 watched seconds of a 12-second clip is 5000 bp — past 3000, short of 10s.
    const outcome = applyViewBeacon(freshSession({ pinnedDurationSeconds: 12 }), {
      positionSeconds: 12,
      elapsedSecondsSinceLastBeacon: 1,
    });

    expect(outcome.watchedSeconds).toBeLessThan(COUNTED_VIEW_MINIMUM_WATCHED_SECONDS);
    expect(outcome.didBecomeCountedView).toBe(true);
  });
});

describe("pinReportedDurationSeconds", () => {
  it("clamps to the bounds rather than rejecting", () => {
    expect(pinReportedDurationSeconds(0)).toBe(MINIMUM_REPORTED_DURATION_SECONDS);
    expect(pinReportedDurationSeconds(999_999)).toBe(MAXIMUM_REPORTED_DURATION_SECONDS);
    expect(pinReportedDurationSeconds(412)).toBe(412);
  });
});

describe("the integer guarantee", () => {
  it("returns safe integers throughout a long randomised-but-honest sequence", () => {
    let session = freshSession({ pinnedDurationSeconds: 617 });

    // Deterministic pseudo-jitter: Math.random() is banned in this domain, and a
    // fixed sequence is what makes a failure reproducible.
    for (let beaconIndex = 1; beaconIndex <= 60; beaconIndex += 1) {
      const jitterSeconds = (beaconIndex * 7) % 14;
      const outcome = applyViewBeacon(session, {
        positionSeconds: beaconIndex * 12 + jitterSeconds,
        elapsedSecondsSinceLastBeacon: 12 + (jitterSeconds % 5),
      });

      for (const measuredValue of [
        outcome.watchedSeconds,
        outcome.maxPositionSeconds,
        outcome.completionBasisPoints,
        outcome.completionBasisPointsDelta,
        outcome.creditedSeconds,
      ]) {
        expect(Number.isSafeInteger(measuredValue)).toBe(true);
      }
      expect(outcome.completionBasisPoints).toBeLessThanOrEqual(MAXIMUM_COMPLETION_BASIS_POINTS);

      session = { ...session, ...outcome };
    }
  });

  it("throws on an input that could not have come from a parsed body", () => {
    expect(() =>
      applyViewBeacon(freshSession(), {
        positionSeconds: 12.5,
        elapsedSecondsSinceLastBeacon: 15,
      }),
    ).toThrow(/positionSeconds/);

    expect(() =>
      applyViewBeacon(freshSession(), {
        positionSeconds: Number.NaN,
        elapsedSecondsSinceLastBeacon: 15,
      }),
    ).toThrow(/positionSeconds/);
  });
});
