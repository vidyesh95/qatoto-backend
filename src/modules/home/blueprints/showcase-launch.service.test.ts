import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

/**
 * UNIT tests for posting a showcase launch and staging a write-up image.
 *
 * THE SUBJECT IS THE ORDER OF THE REFUSALS, not each refusal on its own. `submitShowcaseLaunch`
 * documents a cheapest-first ladder — pure checks, then one indexed read, then the name in SQL, then
 * the image decode and upload, then one transaction — and the ladder is the thing that can silently
 * break: every step still returns the right error if it moves, it just costs a Cloudinary upload or
 * a wasted decode first. So most cases below assert what was NOT called as firmly as what was
 * returned.
 *
 * `showcase-launch-markdown.js` IS LEFT REAL. The write-up gate's whole question is which addresses
 * a renderer would show, and a stubbed extractor would answer that question with the test's own
 * assumption.
 *
 * WHAT IS OUT OF REACH HERE: the raw-SQL title pre-check compares against a generated column using
 * POSIX character classes, and the partial unique index is what actually decides a name. Both are
 * Postgres behavior — asserted against a stub they would prove only that the stub agreed.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));

const databaseState = vi.hoisted(
  (): {
    unclaimedImageCount: number;
    availableImageRows: { url: string }[];
    takenTitleRows: { launchId: string }[];
    lockedImageRows: { imageId: string }[];
    insertedRows: { table: string; values: unknown }[];
    claimedImageIds: string[];
    transactionFailure: unknown;
    selectCallCount: number;
    forUpdateCallCount: number;
    createdAt: Date;
  } => ({
    unclaimedImageCount: 0,
    availableImageRows: [],
    takenTitleRows: [],
    lockedImageRows: [],
    insertedRows: [],
    claimedImageIds: [],
    transactionFailure: null,
    selectCallCount: 0,
    forUpdateCallCount: 0,
    createdAt: new Date("2026-09-12T09:00:00.000Z"),
  }),
);

/**
 * The read side outside the transaction, dispatched by WHICH COLUMNS were selected.
 *
 * NOT BY CALL ORDER, which is the obvious approach and the wrong one: `uploadShowcaseWriteUpImage`
 * and `submitShowcaseLaunch` issue different reads in different orders through the same `db.select`,
 * so an order-based stub answers one function's first query with the other's data and the test passes
 * for the wrong reason. The selected alias is unique per query and states which read is which.
 */
const selectedColumnsByCall: string[][] = [];

function rowsForSelectedColumns(selectedColumns: readonly string[]): unknown[] {
  if (selectedColumns.includes("unclaimedImageCount")) {
    return [{ unclaimedImageCount: databaseState.unclaimedImageCount }];
  }
  if (selectedColumns.includes("url")) return databaseState.availableImageRows;
  if (selectedColumns.includes("launchId")) return databaseState.takenTitleRows;
  return [];
}

type ReadRows = Promise<unknown[]>;

const selectLimitMock = vi.fn<() => ReadRows>(async () => rowsForSelectedColumns(selectedColumnsByCall.at(-1) ?? []));
const selectOrderByMock = vi.fn<() => ReadRows>(async () => rowsForSelectedColumns(selectedColumnsByCall.at(-1) ?? []));
const selectWhereMock = vi.fn<() => ReadRows & { limit: typeof selectLimitMock; orderBy: typeof selectOrderByMock }>(
  () => {
    const selectedColumns = selectedColumnsByCall.at(-1) ?? [];
    databaseState.selectCallCount += 1;
    // A thenable carrying both terminators: `.limit()` for the title pre-check, `.orderBy()` for the
    // unpaged My Launches read, and awaited directly by the availability and staging-count reads.
    return Object.assign(Promise.resolve(rowsForSelectedColumns(selectedColumns)), {
      limit: selectLimitMock,
      orderBy: selectOrderByMock,
    });
  },
);
const selectFromMock = vi.fn<() => { where: typeof selectWhereMock }>(() => ({
  where: selectWhereMock,
}));
const selectMock = vi.fn<(columns: unknown) => { from: typeof selectFromMock }>((columns) => {
  selectedColumnsByCall.push(Object.keys(columns ?? {}));
  return { from: selectFromMock };
});

type InsertedReturning = Promise<undefined> & {
  returning: ReturnType<typeof buildReturningMock>;
};

function buildReturningMock() {
  return vi.fn<() => Promise<{ createdAt: Date }[]>>(async () => [{ createdAt: databaseState.createdAt }]);
}

/** Every insert records its table name, so the launch row and the team rows stay tellable apart. */
const insertMock = vi.fn<(table: unknown) => { values: (values: unknown) => InsertedReturning }>((table) => ({
  values: (values: unknown): InsertedReturning => {
    const tableDescriptor: { _?: { name?: string } } = Object(table);
    databaseState.insertedRows.push({
      table: tableDescriptor._?.name ?? "unknown",
      values,
    });
    return Object.assign(Promise.resolve(undefined), { returning: buildReturningMock() });
  },
}));

const transactionForUpdateMock = vi.fn<() => Promise<{ imageId: string }[]>>(async () => {
  databaseState.forUpdateCallCount += 1;
  return databaseState.lockedImageRows;
});
const transactionLockWhereMock = vi.fn<() => { for: typeof transactionForUpdateMock }>(() => ({
  for: transactionForUpdateMock,
}));
const transactionLockFromMock = vi.fn<() => { where: typeof transactionLockWhereMock }>(() => ({
  where: transactionLockWhereMock,
}));
const transactionSelectMock = vi.fn<() => { from: typeof transactionLockFromMock }>(() => ({
  from: transactionLockFromMock,
}));

const claimWhereMock = vi.fn<() => Promise<undefined>>(async () => {
  databaseState.claimedImageIds.push("claimed");
  return undefined;
});
const claimSetMock = vi.fn<() => { where: typeof claimWhereMock }>(() => ({
  where: claimWhereMock,
}));
const transactionUpdateMock = vi.fn<() => { set: typeof claimSetMock }>(() => ({
  set: claimSetMock,
}));
const transactionMock = vi.fn<(callback: (tx: unknown) => Promise<unknown>) => Promise<unknown>>(async (callback) => {
  if (databaseState.transactionFailure !== null) throw databaseState.transactionFailure;
  return callback({
    select: transactionSelectMock,
    insert: insertMock,
    update: transactionUpdateMock,
  });
});

vi.mock("#src/db/index.js", () => ({
  db: { select: selectMock, insert: insertMock, transaction: transactionMock },
}));

const uploadShowcaseImage = vi.fn<(...args: readonly unknown[]) => unknown>();
const deleteShowcaseImages = vi.fn<(...args: readonly unknown[]) => unknown>();

/**
 * The public-id builders are kept REAL in spirit — reimplemented here with the same shape — so the
 * address assertions below are about a real folder layout rather than about a stub returning a
 * constant.
 */
vi.mock("#src/lib/cloudinary.js", () => ({
  uploadShowcaseImage: (...args: readonly unknown[]) => uploadShowcaseImage(...args),
  deleteShowcaseImages: (...args: readonly unknown[]) => deleteShowcaseImages(...args),
  showcaseLaunchHeadingImagePublicId: (launchId: string) => `qatoto/showcase-images/${launchId}/heading`,
  showcaseWriteUpImagePublicId: (imageId: string) => `qatoto/showcase-images/write-up/${imageId}`,
}));

const validateAndNormalizeImage = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/lib/image.js", () => ({
  validateAndNormalizeImage: (...args: readonly unknown[]) => validateAndNormalizeImage(...args),
}));

/** Only the blur placeholder reaches sharp directly; the normalizer above is already stubbed. */
const sharpToBuffer = vi.fn<() => Promise<Buffer>>(async () => Buffer.from("blur-bytes"));
const sharpWebpMock = vi.fn<() => { toBuffer: typeof sharpToBuffer }>(() => ({
  toBuffer: sharpToBuffer,
}));
const sharpResizeMock = vi.fn<() => { webp: typeof sharpWebpMock }>(() => ({ webp: sharpWebpMock }));
const sharpRotateMock = vi.fn<() => { resize: typeof sharpResizeMock }>(() => ({
  resize: sharpResizeMock,
}));
vi.mock("sharp", () => ({
  default: vi.fn<() => { rotate: typeof sharpRotateMock }>(() => ({ rotate: sharpRotateMock })),
}));

const loggerError = vi.fn<(...args: readonly unknown[]) => void>();
vi.mock("#src/lib/logger.js", () => ({
  logger: {
    error: loggerError,
    warn: vi.fn<(...args: readonly unknown[]) => void>(),
    info: vi.fn<(...args: readonly unknown[]) => void>(),
    debug: vi.fn<(...args: readonly unknown[]) => void>(),
  },
}));

const RAW_IMAGE_BYTES = Buffer.from("raw-image-bytes");

function normalizedImage(
  width: number,
  height: number,
): {
  readonly success: true;
  readonly value: { readonly buffer: Buffer; readonly width: number; readonly height: number };
} {
  return { success: true, value: { buffer: Buffer.from("normalized"), width, height } };
}

function buildDraft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Solar cold storage unit",
    tagline: "Keeps produce cold on four hours of sun.",
    summary: "A 200-litre evaporative store that runs off a single panel.",
    writeUp: null,
    launchedAt: "2026-08-01T00:00:00.000Z",
    difficulty: "intermediate",
    billOfMaterialsCostRange: null,
    tags: ["solar"],
    team: [],
    builtFromBlueprintSlug: null,
    callToAction: null,
    acceptedLaunchStatementIds: ["built_it_ourselves", "results_are_our_own"],
    ...overrides,
  };
}

function submitInput(draftOverrides: Record<string, unknown> = {}, receivedAt = new Date("2026-09-12T09:00:00.000Z")) {
  return {
    authorUserId: "user_maker",
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    draft: buildDraft(draftOverrides) as never,
    rawHeadingImageBytes: RAW_IMAGE_BYTES,
    receivedAt,
  };
}

function resetDatabaseState(): void {
  databaseState.unclaimedImageCount = 0;
  databaseState.availableImageRows = [];
  databaseState.takenTitleRows = [];
  databaseState.lockedImageRows = [];
  databaseState.insertedRows = [];
  databaseState.claimedImageIds = [];
  databaseState.transactionFailure = null;
  databaseState.selectCallCount = 0;
  databaseState.forUpdateCallCount = 0;
  selectedColumnsByCall.length = 0;
}

describe("uploadShowcaseWriteUpImage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDatabaseState();
    validateAndNormalizeImage.mockResolvedValue(normalizedImage(1200, 800));
    uploadShowcaseImage.mockResolvedValue({
      success: true,
      value: { secureUrl: "https://cdn.test/write-up/one.avif" },
    });
    deleteShowcaseImages.mockResolvedValue({ success: true, value: { requestedCount: 0 } });
    sharpToBuffer.mockResolvedValue(Buffer.from("blur-bytes"));
  });

  /**
   * THE CAP IS CHECKED BEFORE ANYTHING IS DECODED. The staging area exists so a maker can write
   * before posting; without this ordering it is also free image hosting that costs a decode and an
   * upload per abuse.
   */
  it("refuses at the staging cap without decoding or uploading", async () => {
    databaseState.unclaimedImageCount = 30;
    const { uploadShowcaseWriteUpImage } = await import("#src/modules/home/blueprints/showcase-launch.service.js");

    const result = await uploadShowcaseWriteUpImage("user_maker", RAW_IMAGE_BYTES);

    expect(result).toEqual({
      success: false,
      error: { type: "SHOWCASE_WRITE_UP_IMAGE_STAGING_LIMIT_REACHED", limit: 30 },
    });
    expect(validateAndNormalizeImage).not.toHaveBeenCalled();
    expect(uploadShowcaseImage).not.toHaveBeenCalled();
  });

  it("accepts the upload one below the cap", async () => {
    databaseState.unclaimedImageCount = 29;
    const { uploadShowcaseWriteUpImage } = await import("#src/modules/home/blueprints/showcase-launch.service.js");

    const result = await uploadShowcaseWriteUpImage("user_maker", RAW_IMAGE_BYTES);

    expect(result.success).toBe(true);
  });

  /** A client-sent width is a claim about a file; the stored file's own size is the fact. */
  it("records the re-encoded dimensions and a webp blur placeholder", async () => {
    validateAndNormalizeImage.mockResolvedValue(normalizedImage(1600, 900));
    const { uploadShowcaseWriteUpImage } = await import("#src/modules/home/blueprints/showcase-launch.service.js");

    const result = await uploadShowcaseWriteUpImage("user_maker", RAW_IMAGE_BYTES);

    expect(result.success && result.value).toEqual({
      url: "https://cdn.test/write-up/one.avif",
      widthPx: 1600,
      heightPx: 900,
      blurDataUrl: `data:image/webp;base64,${Buffer.from("blur-bytes").toString("base64")}`,
    });
    expect(databaseState.insertedRows[0]?.values).toMatchObject({ widthPx: 1600, heightPx: 900 });
  });

  it("addresses the asset under the write-up folder and stores the id it uploaded under", async () => {
    const { uploadShowcaseWriteUpImage } = await import("#src/modules/home/blueprints/showcase-launch.service.js");

    await uploadShowcaseWriteUpImage("user_maker", RAW_IMAGE_BYTES);

    const [uploadedPublicId] = uploadShowcaseImage.mock.calls[0] ?? [];
    expect(String(uploadedPublicId)).toMatch(/^qatoto\/showcase-images\/write-up\//);
    expect(databaseState.insertedRows[0]?.values).toMatchObject({ publicId: uploadedPublicId });
  });

  it("answers the image error unchanged and never uploads when the bytes do not decode", async () => {
    validateAndNormalizeImage.mockResolvedValue({
      success: false,
      error: { type: "UNSUPPORTED_FORMAT", detected: { kind: "heic" } },
    });
    const { uploadShowcaseWriteUpImage } = await import("#src/modules/home/blueprints/showcase-launch.service.js");

    const result = await uploadShowcaseWriteUpImage("user_maker", RAW_IMAGE_BYTES);

    expect(result).toEqual({
      success: false,
      error: { type: "UNSUPPORTED_FORMAT", detected: { kind: "heic" } },
    });
    expect(uploadShowcaseImage).not.toHaveBeenCalled();
  });

  /** A failed blur render is answered as a bad upload, not a 500 — there is nothing else to do. */
  it("answers NOT_AN_IMAGE when the blur render throws, and never uploads", async () => {
    sharpToBuffer.mockRejectedValue(new Error("vips: unable to read"));
    const { uploadShowcaseWriteUpImage } = await import("#src/modules/home/blueprints/showcase-launch.service.js");

    const result = await uploadShowcaseWriteUpImage("user_maker", RAW_IMAGE_BYTES);

    expect(result).toEqual({ success: false, error: { type: "NOT_AN_IMAGE" } });
    expect(uploadShowcaseImage).not.toHaveBeenCalled();
  });

  it("writes no row when the upload fails", async () => {
    uploadShowcaseImage.mockResolvedValue({
      success: false,
      error: { type: "UPLOAD_FAILED", cause: "socket hang up" },
    });
    const { uploadShowcaseWriteUpImage } = await import("#src/modules/home/blueprints/showcase-launch.service.js");

    const result = await uploadShowcaseWriteUpImage("user_maker", RAW_IMAGE_BYTES);

    expect(result.success).toBe(false);
    expect(databaseState.insertedRows).toHaveLength(0);
  });
});

describe("submitShowcaseLaunch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDatabaseState();
    validateAndNormalizeImage.mockResolvedValue(normalizedImage(1024, 1024));
    uploadShowcaseImage.mockResolvedValue({
      success: true,
      value: { secureUrl: "https://cdn.test/launch/heading.avif" },
    });
    deleteShowcaseImages.mockResolvedValue({ success: true, value: { requestedCount: 1 } });
  });

  describe("the refusals that cost nothing", () => {
    it("refuses a non-https call to action before reading the database", async () => {
      const { submitShowcaseLaunch } = await import("#src/modules/home/blueprints/showcase-launch.service.js");

      const result = await submitShowcaseLaunch(
        submitInput({ callToAction: { label: "Order", url: "http://maker.test/order" } }),
      );

      expect(result.success).toBe(false);
      expect(!result.success && result.error.type).toBe("SHOWCASE_LAUNCH_LINK_INVALID");
      expect(selectMock).not.toHaveBeenCalled();
      expect(validateAndNormalizeImage).not.toHaveBeenCalled();
    });

    /** What is stored is the parser's normalized form, never the string the maker typed. */
    it("stores the normalized call-to-action url", async () => {
      const { submitShowcaseLaunch } = await import("#src/modules/home/blueprints/showcase-launch.service.js");

      await submitShowcaseLaunch(
        submitInput({ callToAction: { label: "Order", url: "https://Maker.TEST/order#section" } }),
      );

      expect(databaseState.insertedRows[0]?.values).toMatchObject({
        callToActionUrl: "https://maker.test/order",
      });
    });

    /** A browser clock is never exact, so a small lead is allowed and a large one is not. */
    it.each([
      ["five minutes ahead, inside the clock skew allowance", 5 * 60 * 1000, null],
      ["six minutes ahead, beyond it", 6 * 60 * 1000, "SHOWCASE_LAUNCH_DATE_IN_FUTURE"],
    ] as const)("handles a launch date %s", async (_label, millisecondsAhead, expectedErrorType) => {
      const receivedAt = new Date("2026-09-12T09:00:00.000Z");
      const { submitShowcaseLaunch } = await import("#src/modules/home/blueprints/showcase-launch.service.js");

      const result = await submitShowcaseLaunch(
        submitInput({ launchedAt: new Date(receivedAt.getTime() + millisecondsAhead).toISOString() }, receivedAt),
      );

      expect(result.success ? null : result.error.type).toBe(expectedErrorType);
    });

    /** Counted through the real parser, so twenty distinct addresses means twenty a reader sees. */
    it("refuses a write-up embedding more than twenty images before any query", async () => {
      const writeUp = Array.from(
        { length: 21 },
        (_unused, index) => `![Step](https://cdn.test/step-${String(index)}.avif)`,
      ).join("\n\n");
      const { submitShowcaseLaunch } = await import("#src/modules/home/blueprints/showcase-launch.service.js");

      const result = await submitShowcaseLaunch(submitInput({ writeUp }));

      expect(!result.success && result.error).toEqual({
        type: "SHOWCASE_LAUNCH_WRITE_UP_TOO_MANY_IMAGES",
        limit: 20,
      });
      expect(selectMock).not.toHaveBeenCalled();
    });

    it("accepts a write-up embedding the same image twenty-one times, because that is one image", async () => {
      const writeUp = Array.from({ length: 21 }, () => "![Step](https://cdn.test/step.avif)").join("\n\n");
      databaseState.availableImageRows = [{ url: "https://cdn.test/step.avif" }];
      databaseState.lockedImageRows = [{ imageId: "image_1" }];
      const { submitShowcaseLaunch } = await import("#src/modules/home/blueprints/showcase-launch.service.js");

      const result = await submitShowcaseLaunch(submitInput({ writeUp }));

      expect(result.success).toBe(true);
    });

    it("skips the availability query for a write-up with no images", async () => {
      const { submitShowcaseLaunch } = await import("#src/modules/home/blueprints/showcase-launch.service.js");

      await submitShowcaseLaunch(submitInput({ writeUp: "Plain prose, no images." }));

      // Only the title pre-check runs, so exactly one read.
      expect(databaseState.selectCallCount).toBe(1);
    });

    it("treats a whitespace-only write-up as absent", async () => {
      const { submitShowcaseLaunch } = await import("#src/modules/home/blueprints/showcase-launch.service.js");

      await submitShowcaseLaunch(submitInput({ writeUp: "   \n\t  " }));

      expect(databaseState.insertedRows[0]?.values).toMatchObject({ writeUp: null });
    });

    it("refuses a write-up image that is not one of the maker's own unclaimed uploads", async () => {
      databaseState.availableImageRows = [];
      const { submitShowcaseLaunch } = await import("#src/modules/home/blueprints/showcase-launch.service.js");

      const result = await submitShowcaseLaunch(submitInput({ writeUp: "![Step](https://elsewhere.test/step.png)" }));

      expect(!result.success && result.error.type).toBe("SHOWCASE_LAUNCH_WRITE_UP_IMAGE_NOT_AVAILABLE");
      expect(uploadShowcaseImage).not.toHaveBeenCalled();
    });
  });

  describe("the heading image, checked after the name", () => {
    /**
     * THE WHOLE REASON THE NAME IS PRE-CHECKED IN SQL. "Already taken" is the common refusal, and
     * paying for a decode, a re-encode and an upload before discovering it would make the cheapest
     * answer the most expensive one.
     */
    it("refuses a taken title without decoding or uploading the image", async () => {
      databaseState.takenTitleRows = [{ launchId: "launch_existing" }];
      const { submitShowcaseLaunch } = await import("#src/modules/home/blueprints/showcase-launch.service.js");

      const result = await submitShowcaseLaunch(submitInput());

      expect(!result.success && result.error.type).toBe("SHOWCASE_LAUNCH_TITLE_TAKEN");
      expect(validateAndNormalizeImage).not.toHaveBeenCalled();
      expect(uploadShowcaseImage).not.toHaveBeenCalled();
    });

    it("refuses a heading image below the minimum dimension, measured on the stored file", async () => {
      validateAndNormalizeImage.mockResolvedValue(normalizedImage(200, 200));
      const { submitShowcaseLaunch } = await import("#src/modules/home/blueprints/showcase-launch.service.js");

      const result = await submitShowcaseLaunch(submitInput());

      expect(!result.success && result.error).toEqual({
        type: "SHOWCASE_HEADING_IMAGE_TOO_SMALL",
        width: 200,
        height: 200,
        minimum: 256,
      });
      expect(uploadShowcaseImage).not.toHaveBeenCalled();
    });

    /** "Square" is within one percent, measured on the stored file the readers will see. */
    it.each([
      ["1000x995, inside the one percent tolerance", 1000, 995, null],
      ["1000x980, outside it", 1000, 980, "SHOWCASE_HEADING_IMAGE_NOT_SQUARE"],
    ] as const)("handles a heading image of %s", async (_label, width, height, expectedErrorType) => {
      validateAndNormalizeImage.mockResolvedValue(normalizedImage(width, height));
      const { submitShowcaseLaunch } = await import("#src/modules/home/blueprints/showcase-launch.service.js");

      const result = await submitShowcaseLaunch(submitInput());

      expect(result.success ? null : result.error.type).toBe(expectedErrorType);
    });

    it("writes no launch when the heading image upload fails", async () => {
      uploadShowcaseImage.mockResolvedValue({
        success: false,
        error: { type: "UPLOAD_FAILED", cause: "socket hang up" },
      });
      const { submitShowcaseLaunch } = await import("#src/modules/home/blueprints/showcase-launch.service.js");

      const result = await submitShowcaseLaunch(submitInput());

      expect(!result.success && result.error.type).toBe("UPLOAD_FAILED");
      expect(transactionMock).not.toHaveBeenCalled();
    });
  });

  describe("the transaction", () => {
    it("inserts the launch as pending_review with the uploaded image's address", async () => {
      const { submitShowcaseLaunch } = await import("#src/modules/home/blueprints/showcase-launch.service.js");

      const result = await submitShowcaseLaunch(submitInput());

      expect(databaseState.insertedRows[0]?.values).toMatchObject({
        authorUserId: "user_maker",
        moderationState: "pending_review",
        headingImageUrl: "https://cdn.test/launch/heading.avif",
      });
      expect(result.success && result.value.moderationState).toBe("pending_review");
    });

    it("inserts the team in listed order with zero-based positions", async () => {
      const { submitShowcaseLaunch } = await import("#src/modules/home/blueprints/showcase-launch.service.js");

      await submitShowcaseLaunch(
        submitInput({
          team: [
            { displayName: "Amara", handle: "amara-builds", role: "Thermal" },
            { displayName: "Bo", handle: "bo-makes", role: "Welding" },
          ],
        }),
      );

      expect(databaseState.insertedRows[1]?.values).toEqual([
        expect.objectContaining({ handle: "amara-builds", position: 0 }),
        expect.objectContaining({ handle: "bo-makes", position: 1 }),
      ]);
    });

    it("inserts no team rows for a solo launch", async () => {
      const { submitShowcaseLaunch } = await import("#src/modules/home/blueprints/showcase-launch.service.js");

      await submitShowcaseLaunch(submitInput({ team: [] }));

      expect(databaseState.insertedRows).toHaveLength(1);
    });

    /** The receipt's instant is the row's own `createdAt`, not the clock the request arrived on. */
    it("reports the database's createdAt rather than the received time", async () => {
      databaseState.createdAt = new Date("2026-09-12T09:00:03.250Z");
      const { submitShowcaseLaunch } = await import("#src/modules/home/blueprints/showcase-launch.service.js");

      const result = await submitShowcaseLaunch(submitInput({}, new Date("2026-09-12T09:00:00.000Z")));

      expect(result.success && result.value.receivedAt).toEqual(new Date("2026-09-12T09:00:03.250Z"));
    });

    /** Row locks, not the earlier read, decide the images: two submits cannot claim the same one. */
    it("locks the write-up images for update inside the transaction", async () => {
      databaseState.availableImageRows = [{ url: "https://cdn.test/step.avif" }];
      databaseState.lockedImageRows = [{ imageId: "image_1" }];
      const { submitShowcaseLaunch } = await import("#src/modules/home/blueprints/showcase-launch.service.js");

      await submitShowcaseLaunch(submitInput({ writeUp: "![Step](https://cdn.test/step.avif)" }));

      expect(databaseState.forUpdateCallCount).toBe(1);
    });

    it("refuses and discards the heading image when the lock finds fewer images than expected", async () => {
      databaseState.availableImageRows = [{ url: "https://cdn.test/step.avif" }];
      databaseState.lockedImageRows = [];
      const { submitShowcaseLaunch } = await import("#src/modules/home/blueprints/showcase-launch.service.js");

      const result = await submitShowcaseLaunch(submitInput({ writeUp: "![Step](https://cdn.test/step.avif)" }));

      expect(!result.success && result.error.type).toBe("SHOWCASE_LAUNCH_WRITE_UP_IMAGE_NOT_AVAILABLE");
      expect(deleteShowcaseImages).toHaveBeenCalledWith([expect.stringContaining("/heading")]);
      expect(databaseState.insertedRows).toHaveLength(0);
    });

    /**
     * THE PRE-CHECK IS NOT THE AUTHORITY — the partial unique index is. A name taken between the
     * pre-check and the commit has to produce the SAME refusal, not a 500, and the image that was
     * uploaded for a launch that no longer exists has to go.
     */
    it.each([
      ["a bare driver error", Object.assign(new Error("duplicate key"), { code: "23505" })],
      [
        "a drizzle-wrapped error",
        Object.assign(new Error("failed query"), {
          cause: Object.assign(new Error("duplicate key"), { code: "23505" }),
        }),
      ],
    ])("translates %s at commit into a taken title and discards the image", async (_label, failure) => {
      databaseState.transactionFailure = failure;
      const { submitShowcaseLaunch } = await import("#src/modules/home/blueprints/showcase-launch.service.js");

      const result = await submitShowcaseLaunch(submitInput());

      expect(!result.success && result.error.type).toBe("SHOWCASE_LAUNCH_TITLE_TAKEN");
      expect(deleteShowcaseImages).toHaveBeenCalledWith([expect.stringContaining("/heading")]);
    });

    /** A fault is not a place to make more network calls — the sweep collects the image instead. */
    it("rethrows any other transaction failure and leaves the image for the sweep", async () => {
      databaseState.transactionFailure = Object.assign(new Error("deadlock detected"), { code: "40P01" });
      const { submitShowcaseLaunch } = await import("#src/modules/home/blueprints/showcase-launch.service.js");

      await expect(submitShowcaseLaunch(submitInput())).rejects.toThrow(/deadlock detected/);
      expect(deleteShowcaseImages).not.toHaveBeenCalled();
    });

    /** The maker is already getting a more important refusal; a failed cleanup is not their problem. */
    it("still answers a taken title when the cleanup delete fails", async () => {
      databaseState.transactionFailure = Object.assign(new Error("duplicate key"), { code: "23505" });
      deleteShowcaseImages.mockResolvedValue({
        success: false,
        error: { type: "DELETE_FAILED", cause: "rate limited" },
      });
      const { submitShowcaseLaunch } = await import("#src/modules/home/blueprints/showcase-launch.service.js");

      const result = await submitShowcaseLaunch(submitInput());

      expect(!result.success && result.error.type).toBe("SHOWCASE_LAUNCH_TITLE_TAKEN");
      expect(loggerError).toHaveBeenCalled();
    });
  });
});

describe("listMyShowcaseLaunches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDatabaseState();
  });

  it("filters to the caller and orders the list rather than returning it unsorted", async () => {
    const { listMyShowcaseLaunches } = await import("#src/modules/home/blueprints/showcase-launch.service.js");

    await listMyShowcaseLaunches("user_maker");

    expect(selectedColumnsByCall.at(-1)).toContain("moderationState");
    expect(selectWhereMock).toHaveBeenCalled();
    expect(selectOrderByMock, "an unpaged list must still be ordered").toHaveBeenCalled();
  });
});
