import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

/**
 * The media slot a HIDDEN row still occupies (Appendix A40).
 *
 * WHY THIS FILE EXISTS AND THE ROUTE SUITE COULD NOT COVER IT. Phase 23 redefined
 * `commerce_review.media_count` to count VISIBLE media, because a YouTube video its host deleted
 * now hides its row rather than losing it — and a hidden row KEEPS ITS SLOT so an un-hide can
 * restore it in place. The six-item cap and the next position were still read off that counter,
 * so the first attach after a hide chose an occupied slot and
 * `commerce_review_media_position_uidx` refused it as a 500 on a buyer's own review.
 *
 * THE DATABASE IS HAND-STUBBED, the way `revalidate-youtube-embeds.test.ts` stubs it. The route
 * suite stubs this service wholesale, so it can only see which arguments reach it; what is under
 * test here is which NUMBER the service reads — the counter or the rows — and that is visible
 * only in the values it hands the insert.
 *
 * A real database would catch this at the unique index. There is no database-backed harness in
 * this repo, and `scripts/smoke-store-phase-23.ts` covers it over HTTP where one exists.
 */

stubServerEnvironment();

const appendCommerceOrganizationAuditEntry = vi.fn<() => Promise<{ success: true }>>(() =>
  Promise.resolve({ success: true as const }),
);
vi.mock("#src/services/commerce-organization-audit.service.js", () => ({
  appendCommerceOrganizationAuditEntry,
}));

/**
 * The review row every attach loads under `FOR UPDATE`, and the gallery occupancy read after it.
 *
 * `mediaCount` and the occupancy DISAGREE on purpose: five visible rows and six attached, which
 * is what one hidden video looks like. Reading the counter yields position 5 — the slot the sixth
 * row already holds — and a cap that believes there is room.
 */
const reviewRow = {
  id: "review-1",
  reviewerOrganizationId: "org-buyer",
  visibility: "visible" as const,
  mediaCount: 5,
};
let occupancy = { attachedCount: 6, nextPosition: 6 };

const insertedValues: Record<string, unknown>[] = [];
const counterUpdates: Record<string, unknown>[] = [];
let deletedRow: Record<string, unknown> | null = null;

function selectChain(): unknown {
  /**
   * TWO SHAPES OFF ONE MOCK. The review load ends in `.limit(1).for("update")`; the occupancy
   * read ends at `.where()` and is awaited there. `then` on the `where` result is what makes the
   * second await resolve without the first one resolving early.
   */
  return (projection?: Record<string, unknown>) => ({
    from: () => ({
      where: () => ({
        limit: () => ({
          for: () => Promise.resolve([reviewRow]),
          then: (resolve: (value: unknown) => unknown) => resolve([reviewRow]),
        }),
        // `repackReviewMediaPositions` orders the survivors; an empty gallery ends it early.
        orderBy: () => Promise.resolve([]),
        then: (resolve: (value: unknown) => unknown) =>
          resolve(projection && "attachedCount" in projection ? [occupancy] : [reviewRow]),
      }),
    }),
  });
}

function executor(): Record<string, unknown> {
  return {
    select: selectChain(),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        insertedValues.push(values);
        return {
          returning: () =>
            Promise.resolve([
              {
                id: "media-new",
                reviewId: "review-1",
                mediaKind: "youtube_video",
                url: null,
                youtubeVideoId: "abcdefghijk",
                widthPx: null,
                heightPx: null,
                position: values["position"],
                state: "visible",
                unavailableAt: null,
              },
            ]),
        };
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        counterUpdates.push(values);
        return {
          where: () => ({
            returning: () => Promise.resolve([{ mediaCount: 4 }]),
            then: (resolve: (value: unknown) => unknown) => resolve(undefined),
          }),
        };
      },
    }),
    delete: () => ({
      where: () => ({ returning: () => Promise.resolve(deletedRow ? [deletedRow] : []) }),
    }),
    execute: () => Promise.resolve({ rows: [] }),
  };
}

vi.mock("#src/db/index.js", () => ({
  pool: { query: vi.fn<() => void>(), end: vi.fn<() => void>() },
  db: {
    ...executor(),
    transaction: (callback: (tx: unknown) => Promise<unknown>) => callback(executor()),
  },
}));

const { attachReviewVideo, detachReviewMedia } = await import("#src/services/commerce-trust.service.js");

const ACTOR = {
  organizationId: "org-buyer",
  memberId: "member-1",
  memberRole: "owner" as const,
  actorUserId: "user-1",
};

describe("A40 · review media slots are read from the rows, not from the counter", () => {
  beforeEach(() => {
    insertedValues.length = 0;
    counterUpdates.length = 0;
    deletedRow = null;
    occupancy = { attachedCount: 6, nextPosition: 6 };
  });

  it("attaches at the slot after the LAST ATTACHED row, not after the visible count", async () => {
    occupancy = { attachedCount: 3, nextPosition: 3 };

    const attached = await attachReviewVideo(ACTOR, "review-1", {
      youtubeUrl: "https://www.youtube.com/watch?v=abcdefghijk",
    });

    expect(attached.success).toBe(true);
    // `mediaCount` is 5 and would have collided with a row that is already at position 5.
    expect(insertedValues[0]?.["position"]).toBe(3);
  });

  it("refuses a seventh ATTACHED row even when only five are visible", async () => {
    const refused = await attachReviewVideo(ACTOR, "review-1", {
      youtubeUrl: "https://www.youtube.com/watch?v=abcdefghijk",
    });

    expect(refused).toEqual({
      success: false,
      error: { type: "MEDIA_LIMIT_REACHED", limit: 6 },
    });
    expect(insertedValues).toHaveLength(0);
  });

  it("decrements the counter when a VISIBLE row is detached", async () => {
    deletedRow = { id: "media-1", mediaKind: "youtube_video", state: "visible" };

    const detached = await detachReviewMedia(ACTOR, "review-1", "media-1");

    expect(detached.success).toBe(true);
    expect(counterUpdates.some((values) => "mediaCount" in values)).toBe(true);
  });

  it("does NOT decrement again when the detached row was already hidden", async () => {
    // The job decremented when it hid this row; a second decrement would take the counter below
    // the media the review still shows, and the Phase 10 verifier reports that as drift.
    deletedRow = { id: "media-1", mediaKind: "youtube_video", state: "unavailable_upstream" };

    const detached = await detachReviewMedia(ACTOR, "review-1", "media-1");

    expect(detached.success).toBe(true);
    expect(counterUpdates.some((values) => "mediaCount" in values)).toBe(false);
  });
});
