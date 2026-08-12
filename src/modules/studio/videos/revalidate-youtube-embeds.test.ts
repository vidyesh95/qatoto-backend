import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

/**
 * The nightly embed re-check, and specifically its TRIAGE (§8.2, Appendix A40).
 *
 * WHY THIS FILE EXISTS AND NO OTHER JOB HAS ONE. This job decides, from a third party's answer,
 * whether to take content down. Two of its branches are one-word apart and mean opposite things:
 * `YOUTUBE_VIDEO_UNAVAILABLE` is evidence the video is gone, and `YOUTUBE_VERIFY_FAILED` is
 * evidence of nothing at all. Treating the second as the first during a YouTube outage would
 * unpublish the catalog and hide every review video on the platform in one run.
 *
 * A40 folded a second candidate set into it, which is exactly the change that breaks a working
 * half — so the `video` branch is asserted here too, unchanged.
 *
 * THE DATABASE IS HAND-STUBBED rather than mocked wholesale. `databaseModuleMock` exports
 * `db: {}`, which is enough for route suites because they stub the service layer; a job IS the
 * layer under test, so the chainable calls it actually makes are built below and nothing else.
 */

stubServerEnvironment();
vi.mock("dotenv/config", () => ({}));

const verifyYoutubeVideo = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/lib/youtube.js", () => ({ verifyYoutubeVideo }));

/** Rows `db.execute` hands back, in call order: videos first, then review media. */
const executeResults: { rows: readonly Record<string, unknown>[] }[] = [];

interface RecordedUpdate {
  readonly values: Record<string, unknown>;
  readonly inTransaction: boolean;
}
const recordedUpdates: RecordedUpdate[] = [];

/** How many rows the next `.returning()` should report as moved. */
let returningRows: { id: string }[] = [{ id: "row-1" }];

function updateChain(inTransaction: boolean): unknown {
  return () => ({
    set: (values: Record<string, unknown>) => {
      recordedUpdates.push({ values, inTransaction });
      return {
        where: () => ({
          returning: () => Promise.resolve(returningRows),
          // `commerce_review`'s counter update is awaited without `.returning()`.
          then: (resolve: (value: unknown) => unknown) => resolve(undefined),
        }),
      };
    },
  });
}

vi.mock("#src/db/index.js", () => ({
  pool: { query: vi.fn(), end: vi.fn() },
  db: {
    execute: () => Promise.resolve(executeResults.shift() ?? { rows: [] }),
    update: updateChain(false),
    transaction: (callback: (tx: unknown) => Promise<unknown>) => callback({ update: updateChain(true) }),
  },
}));

const { handleRevalidateYoutubeEmbeds } = await import("#src/modules/studio/videos/revalidate-youtube-embeds.js");

const AS_OF = { asOf: "2026-08-11T00:00:00.000Z" };

function queueCandidates(input: {
  readonly videos?: readonly Record<string, unknown>[];
  readonly reviewMedia?: readonly Record<string, unknown>[];
}): void {
  executeResults.push({ rows: input.videos ?? [] });
  executeResults.push({ rows: input.reviewMedia ?? [] });
}

const DEAD_REVIEW_VIDEO = {
  id: "media-1",
  review_id: "review-1",
  youtube_video_id: "abcdefghijk",
  state: "visible",
};

describe("revalidate-youtube-embeds triage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeResults.length = 0;
    recordedUpdates.length = 0;
    returningRows = [{ id: "row-1" }];
  });

  it("hides a review video whose host no longer serves it, and decrements the counter", async () => {
    queueCandidates({ reviewMedia: [DEAD_REVIEW_VIDEO] });
    verifyYoutubeVideo.mockResolvedValue({
      success: false,
      error: { type: "YOUTUBE_VIDEO_UNAVAILABLE", youtubeVideoId: "abcdefghijk" },
    });

    await handleRevalidateYoutubeEmbeds(AS_OF);

    // Two writes, one transaction: the state and the counter move together or not at all.
    expect(recordedUpdates).toHaveLength(2);
    expect(recordedUpdates.every((update) => update.inTransaction)).toBe(true);
    expect(recordedUpdates[0]?.values).toMatchObject({ state: "unavailable_upstream" });
    expect(recordedUpdates[0]?.values.unavailableAt).toBeInstanceOf(Date);
    // `media_count` counts VISIBLE media from A40 on, so a hide decrements it.
    expect(recordedUpdates[1]?.values).toHaveProperty("mediaCount");
  });

  it("restores a review video that became embeddable again", async () => {
    queueCandidates({
      reviewMedia: [{ ...DEAD_REVIEW_VIDEO, state: "unavailable_upstream" }],
    });
    verifyYoutubeVideo.mockResolvedValue({ success: true, value: { suggestedTitle: "Back" } });

    await handleRevalidateYoutubeEmbeds(AS_OF);

    // A hide that could never be undone would make this job a one-way ratchet against a
    // buyer's own testimony — an unlisted video flipped back to public has been fixed.
    expect(recordedUpdates).toHaveLength(2);
    expect(recordedUpdates[0]?.values).toMatchObject({ state: "visible", unavailableAt: null });
  });

  it("leaves an already-visible row alone when the video verifies", async () => {
    queueCandidates({ reviewMedia: [DEAD_REVIEW_VIDEO] });
    verifyYoutubeVideo.mockResolvedValue({ success: true, value: { suggestedTitle: "Fine" } });

    await handleRevalidateYoutubeEmbeds(AS_OF);

    expect(recordedUpdates).toHaveLength(0);
  });

  it("writes NOTHING when YouTube does not answer — an outage is not evidence", async () => {
    queueCandidates({
      videos: [{ id: "video-1", youtube_video_id: "abcdefghijk" }],
      reviewMedia: [DEAD_REVIEW_VIDEO],
    });
    verifyYoutubeVideo.mockResolvedValue({
      success: false,
      error: { type: "YOUTUBE_VERIFY_FAILED" },
    });

    /**
     * THE ASSERTION THIS FILE EXISTS FOR. `YOUTUBE_VERIFY_FAILED` one word from
     * `YOUTUBE_VIDEO_UNAVAILABLE`, and treating it as evidence would take down every video and
     * every review embed on the platform during a YouTube incident.
     */
    await expect(handleRevalidateYoutubeEmbeds(AS_OF)).rejects.toThrow(/unreachable for all/);
    expect(recordedUpdates).toHaveLength(0);
  });

  it("still flips a dead `video` row — A40 must not break the half that worked", async () => {
    queueCandidates({ videos: [{ id: "video-1", youtube_video_id: "abcdefghijk" }] });
    verifyYoutubeVideo.mockResolvedValue({
      success: false,
      error: { type: "YOUTUBE_VIDEO_UNAVAILABLE", youtubeVideoId: "abcdefghijk" },
    });

    await handleRevalidateYoutubeEmbeds(AS_OF);

    expect(recordedUpdates).toHaveLength(1);
    expect(recordedUpdates[0]?.values).toMatchObject({ uploadStatus: "failed" });
    // Outside a transaction, unchanged: one row, one column, nothing to pair it with.
    expect(recordedUpdates[0]?.inTransaction).toBe(false);
  });

  it("does not throw when nothing was checked at all", async () => {
    queueCandidates({});

    // `checkedCount > 0` guards the outage throw: an empty night is quiet, not broken.
    await expect(handleRevalidateYoutubeEmbeds(AS_OF)).resolves.toBeUndefined();
    expect(recordedUpdates).toHaveLength(0);
  });
});
