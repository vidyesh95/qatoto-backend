import { describe, expect, it } from "vitest";

import {
  computeTrendingScorePoints,
  TRENDING_SCORE_COMPONENT_BUDGETS,
  type TrendingScoreInputs,
} from "#src/lib/trending-score.js";

function risingVideo(overrides: Partial<TrendingScoreInputs> = {}): TrendingScoreInputs {
  return {
    countedViewsInWindow: 700,
    watchedMinutesInWindow: 1_500,
    engagementActionsInWindow: 80,
    qualityScorePoints: 60,
    ...overrides,
  };
}

describe("computeTrendingScorePoints", () => {
  it("keeps the components summing to the total and inside 0..100", () => {
    const breakdown = computeTrendingScorePoints(risingVideo());
    const componentSum =
      breakdown.recentViewComponentPoints +
      breakdown.recentWatchTimeComponentPoints +
      breakdown.recentEngagementComponentPoints +
      breakdown.qualityComponentPoints;

    expect(componentSum).toBe(breakdown.totalPoints);
    expect(breakdown.totalPoints).toBeGreaterThan(0);
    expect(breakdown.totalPoints).toBeLessThanOrEqual(100);
  });

  it("tops out at exactly 100", () => {
    const breakdown = computeTrendingScorePoints({
      countedViewsInWindow: 1_000_000,
      watchedMinutesInWindow: 1_000_000,
      engagementActionsInWindow: 1_000_000,
      qualityScorePoints: 100,
    });
    expect(breakdown.totalPoints).toBe(100);
  });

  it("scores an empty window zero", () => {
    const breakdown = computeTrendingScorePoints({
      countedViewsInWindow: 0,
      watchedMinutesInWindow: 0,
      engagementActionsInWindow: 0,
      qualityScorePoints: null,
    });
    expect(breakdown.totalPoints).toBe(0);
  });

  it("lets quality break a tie between two videos with identical volume", () => {
    // The damper is the whole reason quality is in here: without it the fastest route to
    // the homepage's most prominent surface is manufacturing arrivals.
    const good = computeTrendingScorePoints(risingVideo({ qualityScorePoints: 85 }));
    const poor = computeTrendingScorePoints(risingVideo({ qualityScorePoints: 5 }));

    expect(good.totalPoints).toBeGreaterThan(poor.totalPoints);
    expect(good.totalPoints - poor.totalPoints).toBe(
      TRENDING_SCORE_COMPONENT_BUDGETS.quality,
    );
  });

  it("still ranks an unscored video on the other 85 points", () => {
    // Rule 5: NULL quality means the nightly job has not reached it, not that the video
    // is bad. A video uploaded this morning must be able to trend this afternoon.
    const breakdown = computeTrendingScorePoints(risingVideo({ qualityScorePoints: null }));
    expect(breakdown.qualityComponentPoints).toBe(0);
    expect(breakdown.totalPoints).toBeGreaterThan(0);
  });

  it("throws on a count that could not have come from a COUNT", () => {
    expect(() => computeTrendingScorePoints(risingVideo({ countedViewsInWindow: -1 }))).toThrow(
      /countedViewsInWindow/,
    );
    expect(() =>
      computeTrendingScorePoints(risingVideo({ watchedMinutesInWindow: Number.NaN })),
    ).toThrow(/watchedMinutesInWindow/);
  });
});
