import { describe, expect, it, vi } from "vitest";

// The service imports the db pool and the env-parsed config at module scope. Stub both so
// the PURE parts — the chapter rules, the gating rule and the status derivation — can be
// exercised with no database and no environment.
vi.mock("#src/db/index.js", () => ({ db: {} }));
vi.mock("#src/config/index.js", () => ({ config: { YOUTUBE_OEMBED_TIMEOUT_MS: 3_000 } }));

const { assertGatingSupported, deriveStudioVideoStatus, validateChapterSet } =
  await import("#src/modules/studio/videos/videos.service.js");

const chapters = (...starts: readonly number[]) =>
  starts.map((startSeconds, index) => ({ startSeconds, title: `Chapter ${index + 1}` }));

describe("validateChapterSet", () => {
  it("accepts an empty set — that is how a creator clears their chapters", () => {
    expect(validateChapterSet([], null)).toBeNull();
  });

  it("accepts a legal set", () => {
    expect(validateChapterSet(chapters(0, 30, 90), null)).toBeNull();
  });

  it("rejects fewer than three, because no player renders them", () => {
    expect(validateChapterSet(chapters(0, 30), null)).toMatchObject({ reason: "TOO_FEW" });
    expect(validateChapterSet(chapters(0), null)).toMatchObject({ reason: "TOO_FEW" });
  });

  it("requires the first chapter to start at zero", () => {
    expect(validateChapterSet(chapters(5, 30, 90), null)).toMatchObject({
      reason: "FIRST_NOT_ZERO",
      index: 0,
    });
  });

  it("requires strictly ascending starts, and names the offending index", () => {
    expect(validateChapterSet(chapters(0, 30, 20), null)).toMatchObject({
      reason: "NOT_ASCENDING",
      index: 2,
    });
    // Equal starts are not ascending either.
    expect(validateChapterSet(chapters(0, 30, 30), null)).toMatchObject({
      reason: "NOT_ASCENDING",
      index: 2,
    });
  });

  it("requires at least ten seconds between chapters", () => {
    expect(validateChapterSet(chapters(0, 5, 60), null)).toMatchObject({
      reason: "TOO_CLOSE",
      index: 1,
    });
    // Exactly ten is allowed — the rule is "at least".
    expect(validateChapterSet(chapters(0, 10, 20), null)).toBeNull();
  });

  it("SKIPS the past-the-end rule when duration is unknown", () => {
    // This is every YouTube row: oEmbed returns no duration. Written as a null-guard
    // rather than a videoSource check, so it starts working on its own for hosted rows.
    expect(validateChapterSet(chapters(0, 30, 999_999), null)).toBeNull();
  });

  it("applies the past-the-end rule once a duration is known", () => {
    expect(validateChapterSet(chapters(0, 30, 90), 120)).toBeNull();
    expect(validateChapterSet(chapters(0, 30, 90), 60)).toMatchObject({
      reason: "PAST_END",
      index: 2,
    });
  });
});

describe("assertGatingSupported", () => {
  it("refuses investor_only and NDA on a youtube row", () => {
    expect(assertGatingSupported("youtube", "investor_only", false)).toMatchObject({
      type: "GATING_UNSUPPORTED_FOR_SOURCE",
      videoSource: "youtube",
    });
    expect(assertGatingSupported("youtube", "public", true)).toMatchObject({
      type: "GATING_UNSUPPORTED_FOR_SOURCE",
    });
    expect(assertGatingSupported("youtube", "investor_only", true)).not.toBeNull();
  });

  it("allows the ungated tiers on a youtube row", () => {
    for (const visibility of ["private", "unlisted", "public"] as const) {
      expect(assertGatingSupported("youtube", visibility, false)).toBeNull();
    }
  });

  it("allows everything on a hosted row — that source CAN be gated", () => {
    // Nothing produces hosted rows today (Appendix A is deferred), but the rule is about
    // the source rather than the era, so it must already be right.
    expect(assertGatingSupported("hosted", "investor_only", true)).toBeNull();
  });
});

describe("deriveStudioVideoStatus", () => {
  const base = {
    uploadStatus: "ready",
    publishStatus: "draft",
    reviewStatus: "not_required",
    scheduledPublishAt: null,
    episodeReleasedAt: null,
  } as const;
  const NOW = Date.UTC(2026, 6, 21);

  it("reports a failed upload above everything else", () => {
    expect(deriveStudioVideoStatus({ ...base, uploadStatus: "failed", publishStatus: "published" }, NOW)).toBe(
      "failed",
    );
  });

  it("reports processing for the hosted-path upload states", () => {
    // Unreachable for a YouTube row, which is born ready — kept because it is reachable
    // again the moment hosted rows exist.
    expect(deriveStudioVideoStatus({ ...base, uploadStatus: "uploading" }, NOW)).toBe("processing");
    expect(deriveStudioVideoStatus({ ...base, uploadStatus: "processing" }, NOW)).toBe("processing");
  });

  it("reports the review state ahead of the publish state", () => {
    expect(deriveStudioVideoStatus({ ...base, reviewStatus: "pending" }, NOW)).toBe("pending-review");
    expect(deriveStudioVideoStatus({ ...base, reviewStatus: "rejected" }, NOW)).toBe("rejected");
  });

  it("reports approved only until the episode actually airs", () => {
    expect(deriveStudioVideoStatus({ ...base, reviewStatus: "approved" }, NOW)).toBe("approved");
    expect(
      deriveStudioVideoStatus(
        {
          ...base,
          reviewStatus: "approved",
          publishStatus: "published",
          episodeReleasedAt: new Date(NOW),
        },
        NOW,
      ),
    ).toBe("published");
  });

  it("reports draft and published from the publish column", () => {
    expect(deriveStudioVideoStatus(base, NOW)).toBe("draft");
    expect(deriveStudioVideoStatus({ ...base, publishStatus: "published" }, NOW)).toBe("published");
  });

  it("treats a scheduled row whose time has passed as published", () => {
    // Nothing in this build flips scheduled -> published (that job is a separate phase),
    // so the badge is DERIVED. Without this the UI would read "scheduled for last
    // Tuesday" indefinitely.
    expect(
      deriveStudioVideoStatus({ ...base, publishStatus: "scheduled", scheduledPublishAt: new Date(NOW - 1_000) }, NOW),
    ).toBe("published");
    expect(
      deriveStudioVideoStatus({ ...base, publishStatus: "scheduled", scheduledPublishAt: new Date(NOW + 60_000) }, NOW),
    ).toBe("scheduled");
  });
});
