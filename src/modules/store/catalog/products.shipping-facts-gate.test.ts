import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * §19.9's two gates, against the mocking harness `products.publish-category.test.ts` established.
 *
 * The point of both is the same: a listing buyers can freight-rate must carry the facts the rater
 * needs, and the moment to insist is the moment it becomes buyable — not the moment somebody tries
 * to ship it.
 */
const databaseState = vi.hoisted(
  (): {
    queryResults: Record<string, unknown>[][];
    transactionCalled: boolean;
    updateCalled: boolean;
  } => ({
    queryResults: [],
    transactionCalled: false,
    updateCalled: false,
  }),
);

/**
 * `where()` must be BOTH awaitable and carry `.for()`: the publish path locks its row with
 * `.for("update")` but counts images with a bare `await`.
 *
 * One `where()` call is one query, so both paths hand back the SAME shifted fixture — which is
 * why attaching `for` to a real promise is correct here and a hand-rolled thenable is not needed.
 */
function pendingQueryResult(): Promise<readonly Record<string, unknown>[]> & {
  readonly for: () => Promise<readonly Record<string, unknown>[]>;
} {
  const rows = databaseState.queryResults.shift() ?? [];
  return Object.assign(Promise.resolve(rows), { for: () => Promise.resolve(rows) });
}

const whereMock = vi.fn<(condition: unknown) => ReturnType<typeof pendingQueryResult>>(() => pendingQueryResult());
const fromMock = vi.fn<(table: unknown) => { where: typeof whereMock }>(() => ({
  where: whereMock,
}));
const selectMock = vi.fn<(columns: unknown) => { from: typeof fromMock }>(() => ({
  from: fromMock,
}));
const setMock = vi.fn<(values: unknown) => { where: () => Promise<void> }>(() => ({
  where: () => Promise.resolve(),
}));
const updateMock = vi.fn<(table: unknown) => { set: typeof setMock }>(() => {
  databaseState.updateCalled = true;
  return { set: setMock };
});
const transactionMock = vi.fn<
  (callback: (transaction: unknown) => Promise<unknown>, options?: unknown) => Promise<unknown>
>(async (callback) => {
  databaseState.transactionCalled = true;
  return callback({ select: selectMock, update: updateMock });
});

/**
 * The TOP-LEVEL `db.select`, used by `loadOrganizationProduct` after the transaction commits. It
 * returns nothing, so a successful write reloads to `NOT_FOUND` — which is fine here: these tests
 * assert the GATE, and every success case checks that the write ran rather than what came back.
 */
const topLevelWhereMock = vi.fn<(condition: unknown) => Promise<readonly unknown[]>>(() => Promise.resolve([]));
const topLevelFromMock = vi.fn<(table: unknown) => { where: typeof topLevelWhereMock }>(() => ({
  where: topLevelWhereMock,
}));
const topLevelSelectMock = vi.fn<(columns: unknown) => { from: typeof topLevelFromMock }>(() => ({
  from: topLevelFromMock,
}));

vi.mock("#src/db/index.js", () => ({
  db: { transaction: transactionMock, select: topLevelSelectMock },
}));
vi.mock("#src/lib/cloudinary.js", () => ({
  deleteAllProductImages: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  deleteProductImage: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  uploadProductImage: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));
vi.mock("#src/lib/image.js", () => ({
  validateAndNormalizeImage: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));
vi.mock("#src/modules/store/catalog/store-search.service.js", () => ({
  enqueueProductSearchDocumentRefresh: vi.fn<(...arguments_: readonly unknown[]) => Promise<void>>(),
  refreshProductSearchDocument: vi.fn<(...arguments_: readonly unknown[]) => Promise<void>>(),
}));

const { publishProduct, updateProduct } = await import("#src/modules/store/catalog/products.service.js");

/** The refused type, or null when the call succeeded. Reads better than a boolean comparison. */
function refusalTypeOf(result: Awaited<ReturnType<typeof updateProduct>>): string | null {
  return result.success ? null : result.error.type;
}

const MEASURED = {
  packageLengthMm: 400,
  packageWidthMm: 300,
  packageHeightMm: 200,
  packageGrossWeightGrams: 12_000,
  unitsPerPackage: 5,
};

const UNMEASURED = {
  packageLengthMm: null,
  packageWidthMm: null,
  packageHeightMm: null,
  packageGrossWeightGrams: null,
  unitsPerPackage: null,
};

function publishRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "product-one",
    title: "Solar chest freezer",
    priceInCents: 120_000,
    categoryId: "category-one",
    publicSlug: null,
    samplePolicy: "unavailable",
    samplePriceInCents: null,
    ...MEASURED,
    ...overrides,
  };
}

/** Row, active leaf category, no child, then the image count. */
function publishQueryResults(row: Record<string, unknown>, imageCount: number): Record<string, unknown>[][] {
  return [[row], [{ id: "category-one", parentCategoryId: null, state: "active" }], [], [{ value: imageCount }]];
}

describe("publish gate — the five shipping facts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseState.queryResults = [];
    databaseState.transactionCalled = false;
    databaseState.updateCalled = false;
  });

  it("refuses a listing with a title, a price and an image but no shipping facts", async () => {
    databaseState.queryResults = publishQueryResults(publishRow(UNMEASURED), 1);

    const result = await publishProduct("organization-one", "product-one");

    expect(result).toEqual({
      success: false,
      error: {
        type: "INCOMPLETE_FOR_PUBLISH",
        missing: ["packageLengthMm", "packageWidthMm", "packageHeightMm", "packageGrossWeightGrams", "unitsPerPackage"],
      },
    });
    // The listing must NOT have flipped to active.
    expect(databaseState.updateCalled).toBe(false);
  });

  it("refuses a listing measured in every way except its units per package", async () => {
    databaseState.queryResults = publishQueryResults(publishRow({ unitsPerPackage: null }), 1);

    const result = await publishProduct("organization-one", "product-one");

    expect(result).toEqual({
      success: false,
      error: { type: "INCOMPLETE_FOR_PUBLISH", missing: ["unitsPerPackage"] },
    });
    expect(databaseState.updateCalled).toBe(false);
  });

  it("still refuses for a missing image, so the refactor dropped no earlier requirement", async () => {
    databaseState.queryResults = publishQueryResults(publishRow(), 0);

    const result = await publishProduct("organization-one", "product-one");

    expect(result).toEqual({
      success: false,
      error: { type: "INCOMPLETE_FOR_PUBLISH", missing: ["images"] },
    });
    expect(databaseState.updateCalled).toBe(false);
  });
});

describe("edit gate — a published listing may not lose its shipping facts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseState.queryResults = [];
    databaseState.transactionCalled = false;
    databaseState.updateCalled = false;
  });

  it("lets a DRAFT be edited while still unmeasured", async () => {
    databaseState.queryResults = [[{ id: "product-one", status: "draft", ...UNMEASURED }]];

    const result = await updateProduct("organization-one", "product-one", { title: "New title" });

    // Drafting stays free — the requirement bites at publish, not while the seller is still typing.
    expect(refusalTypeOf(result)).not.toBe("ACTIVE_LISTING_MISSING_PACKAGE_DIMENSIONS");
    expect(databaseState.updateCalled).toBe(true);
  });

  it("refuses an unrelated edit to an ACTIVE listing that has no shipping facts", async () => {
    databaseState.queryResults = [[{ id: "product-one", status: "active", ...UNMEASURED }]];

    const result = await updateProduct("organization-one", "product-one", { title: "New title" });

    expect(result).toEqual({
      success: false,
      error: {
        type: "ACTIVE_LISTING_MISSING_PACKAGE_DIMENSIONS",
        missing: ["packageLengthMm", "packageWidthMm", "packageHeightMm", "packageGrossWeightGrams", "unitsPerPackage"],
      },
    });
    // Refused BEFORE any write.
    expect(databaseState.updateCalled).toBe(false);
  });

  it("accepts the patch that SUPPLIES the missing facts — the fix is allowed to be the edit", async () => {
    databaseState.queryResults = [[{ id: "product-one", status: "active", ...UNMEASURED }]];

    const result = await updateProduct("organization-one", "product-one", {
      ...MEASURED,
    });

    expect(refusalTypeOf(result)).not.toBe("ACTIVE_LISTING_MISSING_PACKAGE_DIMENSIONS");
    expect(databaseState.updateCalled).toBe(true);
  });

  it("leaves a well-formed active listing alone", async () => {
    databaseState.queryResults = [[{ id: "product-one", status: "active", ...MEASURED }]];

    const result = await updateProduct("organization-one", "product-one", { title: "New title" });

    expect(refusalTypeOf(result)).not.toBe("ACTIVE_LISTING_MISSING_PACKAGE_DIMENSIONS");
    expect(databaseState.updateCalled).toBe(true);
  });
});
