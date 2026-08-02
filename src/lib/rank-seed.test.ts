import { describe, expect, it } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

stubServerEnvironment();

const { mintRankSeed, isWellFormedRankSeed, RANK_SEED_LENGTH } = await import("#src/lib/rank-seed.js");

describe("mintRankSeed", () => {
  const viewer = { viewerKey: "user_alice", asOfDayString: "2026-08-02" } as const;

  it("produces exactly the length the query schema declares", () => {
    expect(mintRankSeed(viewer)).toHaveLength(RANK_SEED_LENGTH);
    expect(isWellFormedRankSeed(mintRankSeed(viewer))).toBe(true);
  });

  it("is stable within a day, so page 2 ranks against the same seed as page 1", () => {
    expect(mintRankSeed(viewer)).toBe(mintRankSeed(viewer));
  });

  it("differs across days, so the feed reshuffles overnight", () => {
    expect(mintRankSeed({ ...viewer, asOfDayString: "2026-08-03" })).not.toBe(mintRankSeed(viewer));
  });

  it("differs across viewers, so two people do not get an identical exploration slice", () => {
    expect(mintRankSeed({ ...viewer, viewerKey: "user_bob" })).not.toBe(mintRankSeed(viewer));
  });
});

describe("isWellFormedRankSeed", () => {
  it("accepts only 32 lowercase hex characters", () => {
    expect(isWellFormedRankSeed("0123456789abcdef0123456789abcdef")).toBe(true);
    expect(isWellFormedRankSeed("0123456789ABCDEF0123456789ABCDEF")).toBe(false);
    expect(isWellFormedRankSeed("0123456789abcdef")).toBe(false);
    expect(isWellFormedRankSeed("")).toBe(false);
    // The value reaches an md5() call inside an ORDER BY. It carries no authority — it
    // only selects an exploration bucket — but it is still checked at the point of use.
    expect(isWellFormedRankSeed("'; DROP TABLE video; --")).toBe(false);
  });
});
