import { describe, expect, it } from "vitest";

import {
  AFFINITY_SCORE_COMPONENT_BUDGETS,
  computeAffinityScorePoints,
  type AffinityScoreInputs,
} from "#src/lib/affinity-score.js";

function engagedViewer(overrides: Partial<AffinityScoreInputs> = {}): AffinityScoreInputs {
  return {
    countedViewCount: 10,
    completionBasisPointsSum: 10 * 6_500,
    completionSampleCount: 10,
    likeCount: 3,
    saveCount: 1,
    isSubscribedToCreator: false,
    ...overrides,
  };
}

describe("computeAffinityScorePoints", () => {
  it("keeps the components summing to the total and inside 0..100", () => {
    const breakdown = computeAffinityScorePoints(engagedViewer());
    const componentSum =
      breakdown.watchCountComponentPoints +
      breakdown.meanCompletionComponentPoints +
      breakdown.explicitSignalComponentPoints;

    expect(componentSum).toBe(breakdown.totalPoints);
    expect(breakdown.totalPoints).toBeLessThanOrEqual(100);
  });

  it("distinguishes watching from clicking", () => {
    // A viewer who opened ten videos and abandoned every one at three seconds has told us
    // they are NOT interested. Counting arrivals alone would read that as strong affinity.
    const watched = computeAffinityScorePoints(
      engagedViewer({ completionBasisPointsSum: 10 * 8_000 }),
    );
    const abandoned = computeAffinityScorePoints(
      engagedViewer({ completionBasisPointsSum: 10 * 200 }),
    );

    expect(watched.watchCountComponentPoints).toBe(abandoned.watchCountComponentPoints);
    expect(watched.totalPoints).toBeGreaterThan(abandoned.totalPoints);
  });

  it("weights a subscription above a like", () => {
    const subscribed = computeAffinityScorePoints(
      engagedViewer({ likeCount: 0, saveCount: 0, isSubscribedToCreator: true }),
    );
    const liked = computeAffinityScorePoints(
      engagedViewer({ likeCount: 1, saveCount: 0, isSubscribedToCreator: false }),
    );

    expect(subscribed.explicitSignalComponentPoints).toBeGreaterThan(
      liked.explicitSignalComponentPoints,
    );
  });

  it("scores a viewer with no history at zero, which is the caller's cue to fall back", () => {
    // Rule 5 lives at the CALL SITE: this module scores what it is given, and §4.4's
    // popularity fallback is what turns "no rows" into something other than 0.
    const breakdown = computeAffinityScorePoints({
      countedViewCount: 0,
      completionBasisPointsSum: 0,
      completionSampleCount: 0,
      likeCount: 0,
      saveCount: 0,
      isSubscribedToCreator: false,
    });
    expect(breakdown.totalPoints).toBe(0);
  });

  it("tops out at exactly 100", () => {
    const breakdown = computeAffinityScorePoints({
      countedViewCount: 500,
      completionBasisPointsSum: 500 * 9_000,
      completionSampleCount: 500,
      likeCount: 50,
      saveCount: 50,
      isSubscribedToCreator: true,
    });
    expect(breakdown.totalPoints).toBe(100);
    expect(breakdown.watchCountComponentPoints).toBe(AFFINITY_SCORE_COMPONENT_BUDGETS.watchCount);
  });

  it("throws on a negative count", () => {
    expect(() => computeAffinityScorePoints(engagedViewer({ likeCount: -1 }))).toThrow(/likeCount/);
  });
});
