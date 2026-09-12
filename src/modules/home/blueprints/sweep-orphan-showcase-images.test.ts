import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

/**
 * UNIT tests for the nightly showcase image sweep — the only thing that stops Cloudinary filling up
 * with images no launch will ever reference.
 *
 * THE DATABASE IS A HAND-BUILT CHAIN, in the `products.service.test.ts` style, because the sweep's
 * behavior lives in the ARGUMENTS it builds (the cutoff instant, the public ids it looks up) and in
 * the ORDER it does things, both of which a stub can record exactly.
 *
 * WHAT THIS FILE CANNOT PROVE, and does not pretend to: that the DELETE waits on a submit's row
 * lock and then re-reads `launch_id IS NULL`. That is Postgres behavior, and a mock would agree
 * with whatever the code did. It belongs in a verify script against a real database.
 *
 * `#src/lib/jobs.js` IS LEFT REAL so the job entry point genuinely parses its payload — the one
 * guard that stops a malformed enqueue sweeping from `new Date(undefined)`.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));

interface CloudinaryAsset {
  readonly publicId: string;
  readonly createdAt: Date;
}

interface ListingPage {
  readonly assets: readonly CloudinaryAsset[];
  readonly nextCursor: string | null;
}

/**
 * Everything the stubs read and record for one test.
 *
 * A HOISTED BOX because `vi.mock` factories are hoisted above every import and cannot close over a
 * per-test value; each test rewrites the fields it cares about in `beforeEach` or inline.
 */
const sweepState = vi.hoisted(
  (): {
    expiredUploadRows: { publicId: string }[];
    headingImageRows: { publicId: string }[];
    writeUpImageRows: { publicId: string }[];
    listingPages: ListingPage[];
    listingFailsAfter: number;
    deleteCutoff: Date | null;
    referenceLookupCount: number;
    callOrder: string[];
  } => ({
    expiredUploadRows: [],
    headingImageRows: [],
    writeUpImageRows: [],
    listingPages: [],
    listingFailsAfter: Number.POSITIVE_INFINITY,
    deleteCutoff: null,
    referenceLookupCount: 0,
    callOrder: [],
  }),
);

/**
 * The `lt(createdAt, cutoff)` the DELETE is built with, captured from drizzle's own condition.
 *
 * A DEEP WALK RATHER THAN A KNOWN PATH. `and(isNull(...), lt(...))` nests the bound value inside
 * drizzle's SQL chunk tree, and the shape of that tree is a drizzle internal — reaching into it by
 * path would make this test fail on a patch release for no behavioral reason. The cutoff is the only
 * `Date` anywhere in the condition, so finding it is unambiguous without depending on the layout.
 */
function findBoundDate(condition: unknown): Date | null {
  const pending: unknown[] = [condition];
  const visited = new Set<unknown>();

  while (pending.length > 0) {
    const node = pending.pop();
    if (node instanceof Date) return node;
    if (typeof node !== "object" || node === null || visited.has(node)) continue;
    visited.add(node);
    for (const value of Object.values(node)) pending.push(value);
  }

  return null;
}

const returningMock = vi.fn<() => Promise<{ publicId: string }[]>>(async () => {
  sweepState.callOrder.push("db.delete.returning");
  return sweepState.expiredUploadRows;
});
const deleteWhereMock = vi.fn<(condition: unknown) => { returning: typeof returningMock }>((condition) => {
  sweepState.deleteCutoff = findBoundDate(condition);
  return { returning: returningMock };
});
const deleteMock = vi.fn<() => { where: typeof deleteWhereMock }>(() => ({ where: deleteWhereMock }));

/**
 * Both reference lookups run through one `select`, and the sweep fires them together with
 * `Promise.all`. They are told apart by call order: the heading-image query is built first.
 */
const selectWhereMock = vi.fn<() => Promise<{ publicId: string }[]>>(async () => {
  sweepState.referenceLookupCount += 1;
  sweepState.callOrder.push("db.select.where");
  return sweepState.referenceLookupCount % 2 === 1 ? sweepState.headingImageRows : sweepState.writeUpImageRows;
});
const selectFromMock = vi.fn<() => { where: typeof selectWhereMock }>(() => ({ where: selectWhereMock }));
const selectMock = vi.fn<() => { from: typeof selectFromMock }>(() => ({ from: selectFromMock }));

vi.mock("#src/db/index.js", () => ({
  db: { delete: deleteMock, select: selectMock },
}));

const deleteShowcaseImages = vi.fn<(...args: readonly unknown[]) => unknown>();
const listShowcaseImageAssets = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/lib/cloudinary.js", () => ({
  deleteShowcaseImages: (...args: readonly unknown[]) => deleteShowcaseImages(...args),
  listShowcaseImageAssets: (...args: readonly unknown[]) => listShowcaseImageAssets(...args),
}));

const loggerWarn = vi.fn<(...args: readonly unknown[]) => void>();
const loggerInfo = vi.fn<(...args: readonly unknown[]) => void>();

vi.mock("#src/lib/logger.js", () => ({
  logger: {
    warn: loggerWarn,
    info: loggerInfo,
    error: vi.fn<(...args: readonly unknown[]) => void>(),
    debug: vi.fn<(...args: readonly unknown[]) => void>(),
  },
}));

const SWEEP_AS_OF = new Date("2026-09-12T00:00:00.000Z");
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
/** Anything stamped before this is fair game; anything after is possibly mid-transaction. */
const BEFORE_CUTOFF = new Date(SWEEP_AS_OF.getTime() - TWENTY_FOUR_HOURS_MS - 60_000);
const AFTER_CUTOFF = new Date(SWEEP_AS_OF.getTime() - 60_000);

/** Serves `sweepState.listingPages` in order, failing once the configured page count is reached. */
function serveListingPages(): void {
  let servedPageCount = 0;
  listShowcaseImageAssets.mockImplementation(async () => {
    sweepState.callOrder.push("cloudinary.list");
    if (servedPageCount >= sweepState.listingFailsAfter) {
      return { success: false, error: { type: "LIST_FAILED", cause: "rate limited" } };
    }
    const page = sweepState.listingPages[servedPageCount] ?? { assets: [], nextCursor: null };
    servedPageCount += 1;
    return { success: true, value: page };
  });
}

describe("sweepOrphanShowcaseImages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sweepState.expiredUploadRows = [];
    sweepState.headingImageRows = [];
    sweepState.writeUpImageRows = [];
    sweepState.listingPages = [{ assets: [], nextCursor: null }];
    sweepState.listingFailsAfter = Number.POSITIVE_INFINITY;
    sweepState.deleteCutoff = null;
    sweepState.referenceLookupCount = 0;
    sweepState.callOrder = [];
    deleteShowcaseImages.mockResolvedValue({ success: true, value: { requestedCount: 0 } });
    serveListingPages();
  });

  /** A pure function of its payload: the cutoff comes from `asOf`, never from the wall clock. */
  it("deletes unclaimed rows older than asOf minus twenty-four hours", async () => {
    const { sweepOrphanShowcaseImages } = await import("#src/modules/home/blueprints/sweep-orphan-showcase-images.js");

    await sweepOrphanShowcaseImages(SWEEP_AS_OF);

    expect(sweepState.deleteCutoff, "the DELETE must bind a cutoff instant").not.toBeNull();
    expect(sweepState.deleteCutoff?.getTime()).toBe(SWEEP_AS_OF.getTime() - TWENTY_FOUR_HOURS_MS);
  });

  /**
   * ROWS BEFORE ASSETS. Reversed, a failed asset delete leaves rows pointing at files that no
   * longer exist; this way a failed asset delete just turns them into the other kind of leftover,
   * which the next run's listing catches.
   */
  it("deletes the rows before deleting their assets", async () => {
    sweepState.expiredUploadRows = [{ publicId: "qatoto/showcase-images/write-up/one" }];
    const { sweepOrphanShowcaseImages } = await import("#src/modules/home/blueprints/sweep-orphan-showcase-images.js");

    await sweepOrphanShowcaseImages(SWEEP_AS_OF);

    const deleteRowsIndex = sweepState.callOrder.indexOf("db.delete.returning");
    const firstCloudinaryCallIndex = sweepState.callOrder.findIndex((call) => call.startsWith("cloudinary"));
    expect(deleteRowsIndex).toBeGreaterThanOrEqual(0);
    expect(deleteRowsIndex).toBeLessThan(firstCloudinaryCallIndex);
  });

  it("asks Cloudinary to delete every expired row's asset and counts them", async () => {
    sweepState.expiredUploadRows = [
      { publicId: "qatoto/showcase-images/write-up/one" },
      { publicId: "qatoto/showcase-images/write-up/two" },
    ];
    const { sweepOrphanShowcaseImages } = await import("#src/modules/home/blueprints/sweep-orphan-showcase-images.js");

    const summary = await sweepOrphanShowcaseImages(SWEEP_AS_OF);

    expect(deleteShowcaseImages).toHaveBeenCalledWith([
      "qatoto/showcase-images/write-up/one",
      "qatoto/showcase-images/write-up/two",
    ]);
    expect(summary.expiredUploadRowsDeleted).toBe(2);
  });

  /** The rows are already gone, so the run reports them and lets the next listing find the files. */
  it("still reports the deleted rows when their asset delete fails", async () => {
    sweepState.expiredUploadRows = [{ publicId: "qatoto/showcase-images/write-up/one" }];
    deleteShowcaseImages.mockResolvedValue({
      success: false,
      error: { type: "DELETE_FAILED", cause: "rate limited" },
    });
    const { sweepOrphanShowcaseImages } = await import("#src/modules/home/blueprints/sweep-orphan-showcase-images.js");

    const summary = await sweepOrphanShowcaseImages(SWEEP_AS_OF);

    expect(summary.expiredUploadRowsDeleted).toBe(1);
    expect(loggerWarn).toHaveBeenCalled();
  });

  it("deletes a stale asset that no row in either table names", async () => {
    sweepState.listingPages = [
      { assets: [{ publicId: "qatoto/showcase-images/orphan", createdAt: BEFORE_CUTOFF }], nextCursor: null },
    ];
    const { sweepOrphanShowcaseImages } = await import("#src/modules/home/blueprints/sweep-orphan-showcase-images.js");

    const summary = await sweepOrphanShowcaseImages(SWEEP_AS_OF);

    expect(deleteShowcaseImages).toHaveBeenCalledWith(["qatoto/showcase-images/orphan"]);
    expect(summary.orphanAssetsDeleted).toBe(1);
  });

  it.each([
    ["a launch heading image", "headingImageRows"],
    ["a write-up image row", "writeUpImageRows"],
  ] as const)("keeps a stale asset referenced by %s", async (_label, referencingTable) => {
    sweepState.listingPages = [
      { assets: [{ publicId: "qatoto/showcase-images/kept", createdAt: BEFORE_CUTOFF }], nextCursor: null },
    ];
    sweepState[referencingTable] = [{ publicId: "qatoto/showcase-images/kept" }];
    const { sweepOrphanShowcaseImages } = await import("#src/modules/home/blueprints/sweep-orphan-showcase-images.js");

    const summary = await sweepOrphanShowcaseImages(SWEEP_AS_OF);

    expect(deleteShowcaseImages).toHaveBeenCalledWith([]);
    expect(summary.orphanAssetsDeleted).toBe(0);
  });

  /**
   * THE UNCOMMITTED-LAUNCH GUARANTEE. A heading image uploaded seconds ago may belong to a submit
   * transaction that has not committed, so its row does not exist YET — deleting on that evidence
   * would destroy the image of a launch that is about to appear.
   */
  it("ignores an asset newer than the cutoff even though no row names it", async () => {
    sweepState.listingPages = [
      { assets: [{ publicId: "qatoto/showcase-images/fresh", createdAt: AFTER_CUTOFF }], nextCursor: null },
    ];
    const { sweepOrphanShowcaseImages } = await import("#src/modules/home/blueprints/sweep-orphan-showcase-images.js");

    const summary = await sweepOrphanShowcaseImages(SWEEP_AS_OF);

    expect(summary.orphanAssetsDeleted).toBe(0);
    expect(sweepState.referenceLookupCount, "a fresh asset must not even be looked up").toBe(0);
  });

  it("makes no reference lookups for a page with no stale assets", async () => {
    sweepState.listingPages = [{ assets: [], nextCursor: null }];
    const { sweepOrphanShowcaseImages } = await import("#src/modules/home/blueprints/sweep-orphan-showcase-images.js");

    await sweepOrphanShowcaseImages(SWEEP_AS_OF);

    expect(sweepState.referenceLookupCount).toBe(0);
  });

  it("follows the listing cursor across pages and reports how many it read", async () => {
    sweepState.listingPages = [
      { assets: [], nextCursor: "cursor_2" },
      { assets: [], nextCursor: "cursor_3" },
      { assets: [], nextCursor: null },
    ];
    const { sweepOrphanShowcaseImages } = await import("#src/modules/home/blueprints/sweep-orphan-showcase-images.js");

    const summary = await sweepOrphanShowcaseImages(SWEEP_AS_OF);

    expect(summary.listingPagesRead).toBe(3);
    expect(listShowcaseImageAssets).toHaveBeenNthCalledWith(1, null);
    expect(listShowcaseImageAssets).toHaveBeenNthCalledWith(2, "cursor_2");
    expect(listShowcaseImageAssets).toHaveBeenNthCalledWith(3, "cursor_3");
  });

  /** Bounds one night's Admin API spend — a bigger folder is swept over several nights. */
  it("stops after twenty listing pages even when Cloudinary offers more", async () => {
    sweepState.listingPages = Array.from({ length: 50 }, (_unused, pageIndex) => ({
      assets: [],
      nextCursor: `cursor_${String(pageIndex + 2)}`,
    }));
    const { sweepOrphanShowcaseImages } = await import("#src/modules/home/blueprints/sweep-orphan-showcase-images.js");

    const summary = await sweepOrphanShowcaseImages(SWEEP_AS_OF);

    expect(summary.listingPagesRead).toBe(20);
    expect(listShowcaseImageAssets).toHaveBeenCalledTimes(20);
  });

  it("stops and warns when a listing page fails, keeping the deletions already made", async () => {
    sweepState.expiredUploadRows = [{ publicId: "qatoto/showcase-images/write-up/one" }];
    sweepState.listingPages = [
      { assets: [{ publicId: "qatoto/showcase-images/orphan", createdAt: BEFORE_CUTOFF }], nextCursor: "cursor_2" },
    ];
    sweepState.listingFailsAfter = 1;
    const { sweepOrphanShowcaseImages } = await import("#src/modules/home/blueprints/sweep-orphan-showcase-images.js");

    const summary = await sweepOrphanShowcaseImages(SWEEP_AS_OF);

    expect(summary.listingPagesRead).toBe(1);
    expect(summary.expiredUploadRowsDeleted).toBe(1);
    expect(summary.orphanAssetsDeleted).toBe(1);
    expect(loggerWarn).toHaveBeenCalled();
  });

  it("counts no orphans deleted when the orphan delete fails", async () => {
    sweepState.listingPages = [
      { assets: [{ publicId: "qatoto/showcase-images/orphan", createdAt: BEFORE_CUTOFF }], nextCursor: null },
    ];
    deleteShowcaseImages.mockResolvedValue({
      success: false,
      error: { type: "DELETE_FAILED", cause: "rate limited" },
    });
    const { sweepOrphanShowcaseImages } = await import("#src/modules/home/blueprints/sweep-orphan-showcase-images.js");

    const summary = await sweepOrphanShowcaseImages(SWEEP_AS_OF);

    expect(summary.orphanAssetsDeleted).toBe(0);
    expect(loggerWarn).toHaveBeenCalled();
  });

  it("returns zeroes for an empty folder with nothing expired", async () => {
    const { sweepOrphanShowcaseImages } = await import("#src/modules/home/blueprints/sweep-orphan-showcase-images.js");

    const summary = await sweepOrphanShowcaseImages(SWEEP_AS_OF);

    expect(summary).toEqual({
      expiredUploadRowsDeleted: 0,
      orphanAssetsDeleted: 0,
      listingPagesRead: 1,
    });
  });
});

describe("handleSweepOrphanShowcaseImages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sweepState.expiredUploadRows = [];
    sweepState.listingPages = [{ assets: [], nextCursor: null }];
    sweepState.listingFailsAfter = Number.POSITIVE_INFINITY;
    sweepState.deleteCutoff = null;
    sweepState.referenceLookupCount = 0;
    sweepState.callOrder = [];
    deleteShowcaseImages.mockResolvedValue({ success: true, value: { requestedCount: 0 } });
    serveListingPages();
  });

  /** The payload is the only clock the job has — the real parser is what proves that. */
  it("sweeps at the instant its payload names", async () => {
    const { handleSweepOrphanShowcaseImages } =
      await import("#src/modules/home/blueprints/sweep-orphan-showcase-images.js");

    await handleSweepOrphanShowcaseImages({ asOf: "2026-09-12T00:00:00.000Z" });

    expect(sweepState.deleteCutoff?.toISOString()).toBe("2026-09-11T00:00:00.000Z");
    expect(loggerInfo).toHaveBeenCalled();
  });

  it.each([
    ["an empty payload", {}],
    ["a non-datetime asOf", { asOf: "yesterday" }],
    ["a payload that is not an object", "2026-09-12"],
  ])("throws for %s rather than sweeping from an invalid instant", async (_label, rawPayload) => {
    const { handleSweepOrphanShowcaseImages } =
      await import("#src/modules/home/blueprints/sweep-orphan-showcase-images.js");

    await expect(handleSweepOrphanShowcaseImages(rawPayload)).rejects.toThrow(/payload failed its schema/);
    expect(deleteMock).not.toHaveBeenCalled();
  });
});
