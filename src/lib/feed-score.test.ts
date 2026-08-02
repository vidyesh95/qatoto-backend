import { describe, expect, it } from "vitest";

import {
  applyDiversityCaps,
  COMPLETION_RAMP_FULL_WEIGHT_SAMPLES,
  computeVideoQualityPoints,
  FEED_RANK_COMPONENT_BUDGETS,
  reserveExplorationSlots,
  VIDEO_QUALITY_COMPONENT_BUDGETS,
  type RankedFeedRow,
  type VideoQualityInputs,
} from "#src/lib/feed-score.js";

/** A video with real, healthy numbers and a full complement of completion samples. */
function establishedVideo(overrides: Partial<VideoQualityInputs> = {}): VideoQualityInputs {
  return {
    completionBasisPointsSum: 60 * 7_200,
    completionSampleCount: 60,
    likeCount: 400,
    commentCount: 60,
    shareCount: 30,
    saveCount: 110,
    uniqueViewerCount: 4_000,
    countedViewsFirst48Hours: 900,
    creatorMedianQualityPoints: 70,
    hoursSincePublished: 500,
    ...overrides,
  };
}

describe("the budgets", () => {
  it("sum to 100 for both scores", () => {
    const quality = Object.values(VIDEO_QUALITY_COMPONENT_BUDGETS).reduce((a, b) => a + b, 0);
    const rank = Object.values(FEED_RANK_COMPONENT_BUDGETS).reduce((a, b) => a + b, 0);
    expect(quality).toBe(100);
    expect(rank).toBe(100);
  });
});

describe("computeVideoQualityPoints", () => {
  it("keeps the components summing to the total — the CHECK constraint's TS twin", () => {
    const breakdown = computeVideoQualityPoints(establishedVideo());
    const componentSum =
      breakdown.completionComponentPoints +
      breakdown.engagementComponentPoints +
      breakdown.velocityComponentPoints +
      breakdown.creatorTrackComponentPoints +
      breakdown.freshnessComponentPoints;

    expect(componentSum).toBe(breakdown.totalPoints);
    expect(breakdown.totalPoints).toBeGreaterThan(0);
    expect(breakdown.totalPoints).toBeLessThanOrEqual(100);
  });

  it("gives completion its full budget once the sample ramp is satisfied", () => {
    const breakdown = computeVideoQualityPoints(
      establishedVideo({
        completionSampleCount: COMPLETION_RAMP_FULL_WEIGHT_SAMPLES,
        completionBasisPointsSum: COMPLETION_RAMP_FULL_WEIGHT_SAMPLES * 7_500,
      }),
    );
    expect(breakdown.completionComponentPoints).toBe(
      VIDEO_QUALITY_COMPONENT_BUDGETS.completionRate,
    );
  });

  it("scores a video with ZERO completion samples above zero", () => {
    // THE WHOLE POINT OF §4.2. Score it 0 on a 40-point component and it can never rank,
    // so it is never watched, so it never gets samples.
    const brandNew = computeVideoQualityPoints(
      establishedVideo({
        completionBasisPointsSum: 0,
        completionSampleCount: 0,
        uniqueViewerCount: 200,
        countedViewsFirst48Hours: 120,
        hoursSincePublished: 4,
      }),
    );

    expect(brandNew.completionComponentPoints).toBe(0);
    expect(brandNew.totalPoints).toBeGreaterThan(0);
  });

  it("redistributes the unearned completion budget instead of discarding it", () => {
    const inputs = establishedVideo({ completionBasisPointsSum: 0, completionSampleCount: 0 });
    const rampedDown = computeVideoQualityPoints(inputs);
    const atFullSamples = computeVideoQualityPoints({
      ...inputs,
      completionSampleCount: COMPLETION_RAMP_FULL_WEIGHT_SAMPLES,
    });

    // With no samples the other four carry more than they do at full weight.
    const rampedOthers =
      rampedDown.engagementComponentPoints +
      rampedDown.velocityComponentPoints +
      rampedDown.creatorTrackComponentPoints +
      rampedDown.freshnessComponentPoints;
    const fullOthers =
      atFullSamples.engagementComponentPoints +
      atFullSamples.velocityComponentPoints +
      atFullSamples.creatorTrackComponentPoints +
      atFullSamples.freshnessComponentPoints;

    expect(rampedOthers).toBeGreaterThan(fullOthers);
  });

  it("ramps monotonically and never leaves the 0..100 band", () => {
    for (let sampleCount = 0; sampleCount <= 40; sampleCount += 1) {
      const breakdown = computeVideoQualityPoints(
        establishedVideo({
          completionSampleCount: sampleCount,
          completionBasisPointsSum: sampleCount * 7_200,
        }),
      );
      expect(breakdown.totalPoints).toBeGreaterThanOrEqual(0);
      expect(breakdown.totalPoints).toBeLessThanOrEqual(100);
      expect(Number.isSafeInteger(breakdown.totalPoints)).toBe(true);
    }
  });

  it("scores engagement 0 on a NULL unique-viewer count rather than dividing by a made-up number", () => {
    const breakdown = computeVideoQualityPoints(
      establishedVideo({ uniqueViewerCount: null, completionSampleCount: 60 }),
    );
    expect(breakdown.engagementPerThousandViewers).toBe(0);
    expect(breakdown.engagementComponentPoints).toBe(0);
  });

  it("divides engagement by UNIQUE VIEWERS, so inflating views does not help", () => {
    const honest = computeVideoQualityPoints(establishedVideo({ uniqueViewerCount: 1_000 }));
    const farmed = computeVideoQualityPoints(establishedVideo({ uniqueViewerCount: 20_000 }));
    expect(farmed.engagementComponentPoints).toBeLessThan(honest.engagementComponentPoints);
  });

  it("awards the freshness floor only inside the window", () => {
    expect(
      computeVideoQualityPoints(establishedVideo({ hoursSincePublished: 71 }))
        .freshnessComponentPoints,
    ).toBeGreaterThan(0);
    expect(
      computeVideoQualityPoints(establishedVideo({ hoursSincePublished: 72 }))
        .freshnessComponentPoints,
    ).toBe(0);
  });

  it("scores creator track 0 when the creator has no scored videos yet", () => {
    expect(
      computeVideoQualityPoints(establishedVideo({ creatorMedianQualityPoints: null }))
        .creatorTrackComponentPoints,
    ).toBe(0);
  });

  it("throws on an input that could not have come from a COUNT", () => {
    expect(() =>
      computeVideoQualityPoints(establishedVideo({ completionSampleCount: -1 })),
    ).toThrow(/completionSampleCount/);
  });
});

function row(videoId: string, creatorId: string, categorySlugs: string[]): RankedFeedRow {
  return { videoId, creatorId, categorySlugs };
}

/** A row whose creator and categories are irrelevant to the case under test. */
function plainRow(videoId: string): RankedFeedRow {
  return row(videoId, "c", []);
}

describe("applyDiversityCaps", () => {
  it("returns a PERMUTATION — every input row exactly once", () => {
    // THE PROPERTY THAT MAKES OFFSET PAGINATION CORRECT. A filter would let page 2's
    // offset land on rows page 1 already served.
    const ranked = Array.from({ length: 12 }, (_unused, index) =>
      row(`v${String(index)}`, "hoggingCreator", ["robotics"]),
    );

    const permuted = applyDiversityCaps(ranked, {
      pageSize: 4,
      maxRowsPerCreator: 2,
      maxCategoryShareBasisPoints: 10_000,
    });

    expect(permuted).toHaveLength(ranked.length);
    expect(new Set(permuted.map((r) => r.videoId)).size).toBe(ranked.length);
  });

  it("keeps a single creator to two rows on the first page", () => {
    const ranked = [
      ...Array.from({ length: 6 }, (_unused, index) =>
        row(`h${String(index)}`, "hoggingCreator", []),
      ),
      ...Array.from({ length: 6 }, (_unused, index) =>
        row(`o${String(index)}`, `other${String(index)}`, []),
      ),
    ];

    const firstPage = applyDiversityCaps(ranked, {
      pageSize: 4,
      maxRowsPerCreator: 2,
      maxCategoryShareBasisPoints: 10_000,
    }).slice(0, 4);

    expect(firstPage.filter((r) => r.creatorId === "hoggingCreator")).toHaveLength(2);
  });

  it("caps a single category at 40% of the page when the catalog can fill it", () => {
    const ranked = ["robotics", "magic", "toys"].flatMap((slug, slugIndex) =>
      Array.from({ length: 10 }, (_unused, index) =>
        row(`${slug}${String(index)}`, `creator${String(slugIndex)}${String(index)}`, [slug]),
      ),
    );

    const firstPage = applyDiversityCaps(ranked, {
      pageSize: 10,
      maxRowsPerCreator: 2,
      maxCategoryShareBasisPoints: 4_000,
    }).slice(0, 10);

    expect(firstPage.filter((r) => r.categorySlugs.includes("robotics"))).toHaveLength(4);
  });

  it("lets demoted rows backfill rather than under-filling a page on a thin catalog", () => {
    // With only two categories, a 10-row page cannot be built from 4 + 4. The demoted
    // tail fills the rest — which is the right trade: a full page of slightly less
    // diverse videos beats an 8-row homepage. The cap is a preference, and on a catalog
    // too thin to honour it, it yields.
    const ranked = ["robotics", "magic"].flatMap((slug, slugIndex) =>
      Array.from({ length: 10 }, (_unused, index) =>
        row(`${slug}${String(index)}`, `creator${String(slugIndex)}${String(index)}`, [slug]),
      ),
    );

    const firstPage = applyDiversityCaps(ranked, {
      pageSize: 10,
      maxRowsPerCreator: 2,
      maxCategoryShareBasisPoints: 4_000,
    }).slice(0, 10);

    expect(firstPage).toHaveLength(10);
    expect(firstPage.filter((r) => r.categorySlugs.includes("robotics")).length).toBeGreaterThan(4);
  });

  it("preserves rank order among promoted rows and among demoted rows", () => {
    const ranked = [
      row("a", "c1", []),
      row("b", "c1", []),
      row("c", "c1", []),
      row("d", "c2", []),
      row("e", "c1", []),
    ];
    const permuted = applyDiversityCaps(ranked, {
      pageSize: 5,
      maxRowsPerCreator: 2,
      maxCategoryShareBasisPoints: 10_000,
    });
    // a, b promoted (c1 x2), d promoted (c2); c and e demoted, still in rank order.
    expect(permuted.map((r) => r.videoId)).toEqual(["a", "b", "d", "c", "e"]);
  });

  it("resets the caps every page, so a creator is not limited to two in the whole feed", () => {
    const ranked = Array.from({ length: 8 }, (_unused, index) =>
      row(`v${String(index)}`, "soleCreator", []),
    );
    const permuted = applyDiversityCaps(ranked, {
      pageSize: 2,
      maxRowsPerCreator: 2,
      maxCategoryShareBasisPoints: 10_000,
    });
    // With one creator and a cap of 2 per 2-row page, nothing is ever demoted.
    expect(permuted.map((r) => r.videoId)).toEqual(ranked.map((r) => r.videoId));
  });

  it("never lets the category cap floor to zero and demote everything", () => {
    // floor(2 * 4000 / 10000) is 0. Without the Math.max(1, …) every categorized video is
    // demoted on every small-page request.
    const ranked = [row("a", "c1", ["x"]), row("b", "c2", ["y"])];
    const permuted = applyDiversityCaps(ranked, {
      pageSize: 2,
      maxRowsPerCreator: 2,
      maxCategoryShareBasisPoints: 4_000,
    });
    expect(permuted.map((r) => r.videoId)).toEqual(["a", "b"]);
  });

  it("never demotes an untagged video on category grounds", () => {
    const ranked = Array.from({ length: 5 }, (_unused, index) =>
      row(`u${String(index)}`, `creator${String(index)}`, []),
    );
    const permuted = applyDiversityCaps(ranked, {
      pageSize: 5,
      maxRowsPerCreator: 2,
      maxCategoryShareBasisPoints: 4_000,
    });
    expect(permuted.map((r) => r.videoId)).toEqual(ranked.map((r) => r.videoId));
  });
});

describe("reserveExplorationSlots", () => {
  it("promotes fresh rows already in the sequence, and stays a permutation", () => {
    const ranked = ["a", "b", "c", "d", "e", "f", "g", "h"].map(plainRow);
    const fresh = new Set(["f", "g"]);

    const withQuota = reserveExplorationSlots(ranked, fresh, { slotsPerPage: 4 });

    expect(withQuota).toHaveLength(ranked.length);
    expect(new Set(withQuota.map((r) => r.videoId)).size).toBe(ranked.length);
    expect(withQuota.slice(0, 4).map((r) => r.videoId)).toEqual(["f", "g", "a", "b"]);
  });

  it("counts fresh rows the ranking already surfaced against the quota", () => {
    const ranked = ["n1", "b", "c", "d", "n2", "n3"].map(plainRow);
    // n1 is already inside the first 2 rows, so only one more slot is filled.
    const withQuota = reserveExplorationSlots(ranked, new Set(["n1", "n2", "n3"]), {
      slotsPerPage: 2,
    });
    expect(withQuota.slice(0, 2).map((r) => r.videoId)).toEqual(["n2", "n1"]);
  });

  it("never injects a row that was not already in the sequence", () => {
    // Injecting would put a video on page 1 that the raw ranking also places on page 3,
    // and the viewer would meet it twice.
    const ranked = ["a", "b"].map(plainRow);
    const withQuota = reserveExplorationSlots(ranked, new Set(["not-in-the-list"]), {
      slotsPerPage: 4,
    });
    expect(withQuota.map((r) => r.videoId)).toEqual(["a", "b"]);
  });

  it("is a no-op with no quota or nothing fresh", () => {
    const ranked = [plainRow("a"), plainRow("b")];
    expect(reserveExplorationSlots(ranked, new Set(), { slotsPerPage: 4 })).toEqual(ranked);
    expect(reserveExplorationSlots(ranked, new Set(["a"]), { slotsPerPage: 0 })).toEqual(ranked);
  });
});
