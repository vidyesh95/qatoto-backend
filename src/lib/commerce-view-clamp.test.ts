import { describe, expect, it } from "vitest";

// From `network-block.js` and not `client-subnet.js`: the latter reads `config` at module
// scope for its hashing secret, and this parser needs no environment at all.
import { deriveClientNetworkBlock } from "#src/lib/network-block.js";
import {
  clampViewDwellSeconds,
  isCountedViewDwell,
  MAXIMUM_VIEW_DWELL_SECONDS,
  VIEW_DWELL_GRACE_SECONDS,
} from "#src/lib/commerce-view-clamp.js";

/**
 * The two modules that stand between a hostile request and a ranking input.
 *
 * `deriveClientNetworkBlock` is tested rather than `computeClientSubnetHash` because the
 * hash needs a deployment secret; the block is the part that decides whether two callers
 * are treated as one network, which is the property the fraud guard depends on.
 */

const FIRST_BEACON = new Date("2026-08-07T12:00:00.000Z");

describe("clampViewDwellSeconds", () => {
  it("bounds a claim by wall time, not by what the client asserts", () => {
    // The whole point: a single request cannot mint an hour of attention.
    const clamped = clampViewDwellSeconds({
      claimedTotalDwellSeconds: 3_600,
      storedDwellSeconds: 0,
      firstBeaconAt: FIRST_BEACON,
      observedAt: new Date(FIRST_BEACON.getTime() + 10_000),
    });
    expect(clamped).toBe(10 + VIEW_DWELL_GRACE_SECONDS);
  });

  it("accepts an honest claim below the physical ceiling", () => {
    const clamped = clampViewDwellSeconds({
      claimedTotalDwellSeconds: 30,
      storedDwellSeconds: 0,
      firstBeaconAt: FIRST_BEACON,
      observedAt: new Date(FIRST_BEACON.getTime() + 120_000),
    });
    expect(clamped).toBe(30);
  });

  it("never moves a total backwards", () => {
    // A reload or a second tab reporting a smaller total must not un-count a counted view.
    const clamped = clampViewDwellSeconds({
      claimedTotalDwellSeconds: 1,
      storedDwellSeconds: 45,
      firstBeaconAt: FIRST_BEACON,
      observedAt: new Date(FIRST_BEACON.getTime() + 120_000),
    });
    expect(clamped).toBe(45);
  });

  it("treats NaN and Infinity as a claim of nothing", () => {
    for (const hostile of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(
        clampViewDwellSeconds({
          claimedTotalDwellSeconds: hostile,
          storedDwellSeconds: 0,
          firstBeaconAt: FIRST_BEACON,
          observedAt: new Date(FIRST_BEACON.getTime() + 60_000),
        }),
      ).toBe(0);
    }
  });

  it("survives a row whose timestamps disagree with the beacon", () => {
    // Clock skew, not a claim to honour: the grace alone governs.
    const clamped = clampViewDwellSeconds({
      claimedTotalDwellSeconds: 900,
      storedDwellSeconds: 0,
      firstBeaconAt: new Date(FIRST_BEACON.getTime() + 60_000),
      observedAt: FIRST_BEACON,
    });
    expect(clamped).toBe(VIEW_DWELL_GRACE_SECONDS);
  });

  it("never exceeds the database's own bound", () => {
    const clamped = clampViewDwellSeconds({
      claimedTotalDwellSeconds: 100_000,
      storedDwellSeconds: 0,
      firstBeaconAt: FIRST_BEACON,
      observedAt: new Date(FIRST_BEACON.getTime() + 100_000_000),
    });
    expect(clamped).toBeLessThanOrEqual(MAXIMUM_VIEW_DWELL_SECONDS);
  });

  it("counts a view only once the dwell threshold is cleared", () => {
    expect(isCountedViewDwell(4)).toBe(false);
    expect(isCountedViewDwell(5)).toBe(true);
  });
});

describe("deriveClientNetworkBlock", () => {
  it("puts two hosts in one IPv4 /24 into the same block", () => {
    expect(deriveClientNetworkBlock("203.0.113.5")).toBe(deriveClientNetworkBlock("203.0.113.200"));
  });

  it("separates two different /24s", () => {
    expect(deriveClientNetworkBlock("203.0.113.5")).not.toBe(
      deriveClientNetworkBlock("203.0.114.5"),
    );
  });

  it("unwraps an IPv4-mapped IPv6 address to the same block as the bare form", () => {
    // Otherwise one host would be two networks depending on which listener accepted it.
    expect(deriveClientNetworkBlock("::ffff:203.0.113.5")).toBe(
      deriveClientNetworkBlock("203.0.113.5"),
    );
  });

  it("puts two hosts in one IPv6 /56 into the same block", () => {
    expect(deriveClientNetworkBlock("2001:db8:abcd:0012::1")).toBe(
      deriveClientNetworkBlock("2001:db8:abcd:0012:ffff:ffff:ffff:ffff"),
    );
  });

  it("separates IPv6 addresses that differ above the /56 boundary", () => {
    expect(deriveClientNetworkBlock("2001:db8:abcd:0012::1")).not.toBe(
      deriveClientNetworkBlock("2001:db8:abcd:9912::1"),
    );
  });

  it("returns null rather than a placeholder for an unusable address", () => {
    // A shared placeholder would make every address-less request look like one enormous
    // colluding network — the opposite of what the guard is for.
    for (const unusable of [undefined, "", "   ", "not-an-ip", "999.1.1.1"]) {
      expect(deriveClientNetworkBlock(unusable)).toBeNull();
    }
  });
});
