import { beforeEach, describe, expect, it, vi } from "vitest";

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

const forMock = vi.fn<() => Promise<readonly Record<string, unknown>[]>>(() =>
  Promise.resolve(databaseState.queryResults.shift() ?? []),
);
const whereMock = vi.fn<(condition: unknown) => { for: typeof forMock }>(() => ({
  for: forMock,
}));
const fromMock = vi.fn<(table: unknown) => { where: typeof whereMock }>(() => ({
  where: whereMock,
}));
const selectMock = vi.fn<(columns: unknown) => { from: typeof fromMock }>(() => ({
  from: fromMock,
}));
const updateMock = vi.fn<(table: unknown) => unknown>(() => {
  databaseState.updateCalled = true;
  return {};
});
const transactionMock = vi.fn<(callback: (transaction: unknown) => Promise<unknown>) => Promise<unknown>>(
  async (callback) => {
    databaseState.transactionCalled = true;
    return callback({ select: selectMock, update: updateMock });
  },
);

vi.mock("#src/db/index.js", () => ({
  db: { transaction: transactionMock },
}));
vi.mock("#src/lib/cloudinary.js", () => ({
  deleteAllProductImages: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  deleteProductImage: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  uploadProductImage: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));
vi.mock("#src/lib/image.js", () => ({
  validateAndNormalizeImage: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));
vi.mock("#src/services/store-search.service.js", () => ({
  refreshProductSearchDocument: vi.fn<(...arguments_: readonly unknown[]) => Promise<void>>(),
}));

const { publishProduct } = await import("#src/services/products.service.js");

describe("product publish category eligibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseState.queryResults = [];
    databaseState.transactionCalled = false;
    databaseState.updateCalled = false;
  });

  it("rejects a category retired before publish inside the publish transaction", async () => {
    databaseState.queryResults = [
      [
        {
          id: "product-one",
          title: "Listing",
          priceInCents: 100,
          categoryId: "category-one",
          publicSlug: null,
          samplePolicy: "unavailable",
          samplePriceInCents: null,
        },
      ],
      [{ id: "category-one", parentCategoryId: null, state: "retired" }],
      [],
    ];

    const result = await publishProduct("organization-one", "product-one");

    expect(result).toEqual({
      success: false,
      error: { type: "CATEGORY_NOT_ACTIVE_LEAF", categoryId: "category-one" },
    });
    expect(databaseState.transactionCalled).toBe(true);
    expect(databaseState.updateCalled).toBe(false);
  });

  it("rejects a category that gained a child before publish", async () => {
    databaseState.queryResults = [
      [
        {
          id: "product-one",
          title: "Listing",
          priceInCents: 100,
          categoryId: "category-one",
          publicSlug: null,
          samplePolicy: "unavailable",
          samplePriceInCents: null,
        },
      ],
      [{ id: "category-one", parentCategoryId: null, state: "active" }],
      [{ id: "new-child" }],
    ];

    const result = await publishProduct("organization-one", "product-one");

    expect(result).toEqual({
      success: false,
      error: { type: "CATEGORY_NOT_ACTIVE_LEAF", categoryId: "category-one" },
    });
    expect(databaseState.updateCalled).toBe(false);
  });
});
