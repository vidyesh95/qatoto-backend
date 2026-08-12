import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CreateProductInput } from "#src/modules/store/catalog/products.schemas.js";

interface CategoryRow {
  readonly id: string;
  readonly parentCategoryId?: string | null;
  readonly state?: "active" | "draft" | "retired";
}

const databaseState = vi.hoisted(
  (): {
    categoryResults: CategoryRow[][];
    insertedProduct: Record<string, unknown> | null;
    transactionCalled: boolean;
  } => ({
    categoryResults: [],
    insertedProduct: null,
    transactionCalled: false,
  }),
);

const forMock = vi.fn<() => Promise<CategoryRow[]>>(() => Promise.resolve(databaseState.categoryResults.shift() ?? []));
const whereMock = vi.fn<(condition: unknown) => { for: typeof forMock }>(() => ({
  for: forMock,
}));
const fromMock = vi.fn<(table: unknown) => { where: typeof whereMock }>(() => ({
  where: whereMock,
}));
const selectMock = vi.fn<(columns: unknown) => { from: typeof fromMock }>(() => ({
  from: fromMock,
}));

const productRow = {
  id: "product-one",
  title: "Mapped listing",
  brand: null,
  category: "electronics",
  categoryId: "commerce_category_electronics",
  condition: "new",
  description: null,
  priceInCents: 1_000,
  compareAtPriceInCents: null,
  currency: "USD",
  stockQuantity: 0,
  sku: null,
  keyFeatures: [],
  status: "draft",
  publishedAt: null,
};

const returningMock = vi.fn<(columns: unknown) => Promise<(typeof productRow)[]>>(() => Promise.resolve([productRow]));
/**
 * `createProduct` inserts into several tables in one transaction — the product, its
 * pricing tiers, its specifications, and (A11) its `commerce_product_stats` row. Only
 * the FIRST of those is the product, so the payload is captured once; recording every
 * call would leave `insertedProduct` holding whichever table happened to be written
 * last and make the assertion below silently test the wrong row.
 */
const onConflictDoNothingMock = vi.fn<() => Promise<void>>(async () => undefined);
const valuesMock = vi.fn<
  (insertedProduct: Record<string, unknown>) => {
    returning: typeof returningMock;
    onConflictDoNothing: typeof onConflictDoNothingMock;
  }
>((insertedProduct) => {
  databaseState.insertedProduct ??= insertedProduct;
  return { returning: returningMock, onConflictDoNothing: onConflictDoNothingMock };
});
const insertMock = vi.fn<(table: unknown) => { values: typeof valuesMock }>(() => ({
  values: valuesMock,
}));
const deleteWhereMock = vi.fn<() => Promise<void>>(async () => undefined);
const deleteMock = vi.fn<() => { where: typeof deleteWhereMock }>(() => ({
  where: deleteWhereMock,
}));
const transactionMock = vi.fn<(callback: (transaction: unknown) => Promise<unknown>) => Promise<unknown>>(
  async (callback) => {
    databaseState.transactionCalled = true;
    return callback({ insert: insertMock, select: selectMock, delete: deleteMock });
  },
);

vi.mock("#src/db/index.js", () => ({
  db: { select: selectMock, transaction: transactionMock },
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
  enqueueProductSearchDocumentRefresh: vi.fn<(...arguments_: readonly unknown[]) => Promise<void>>(
    async () => undefined,
  ),
}));

const { createProduct } = await import("#src/modules/store/catalog/products.service.js");

const baseInput: Omit<CreateProductInput, "category" | "categoryId"> = {
  title: "Mapped listing",
  condition: "new",
  keyFeatures: [],
  priceInCents: 1_000,
  stockQuantity: 0,
  pricingTiers: [],
  specifications: [],
};

describe("product category resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseState.categoryResults = [];
    databaseState.insertedProduct = null;
    databaseState.transactionCalled = false;
  });

  it("maps a legacy category and dual-writes the canonical category id", async () => {
    databaseState.categoryResults = [
      [
        {
          id: "commerce_category_electronics",
          parentCategoryId: null,
          state: "active",
        },
      ],
      [],
    ];

    const result = await createProduct(
      { userId: "user-one", organizationId: "organization-one" },
      { ...baseInput, category: "electronics" },
    );

    expect(result.success).toBe(true);
    expect(databaseState.insertedProduct).toEqual(
      expect.objectContaining({
        // `sellerId` is gone with migration 0088. Ownership is the organization and
        // `createdByUserId` is the attribution that survives it.
        sellerOrganizationId: "organization-one",
        createdByUserId: "user-one",
        category: "electronics",
        categoryId: "commerce_category_electronics",
      }),
    );
    expect(databaseState.insertedProduct).not.toHaveProperty("sellerId");
  });

  it("rejects inactive categories before creating a listing", async () => {
    databaseState.categoryResults = [
      [
        {
          id: "commerce_category_electronics",
          parentCategoryId: null,
          state: "retired",
        },
      ],
      [],
    ];

    const result = await createProduct(
      { userId: "user-one", organizationId: "organization-one" },
      { ...baseInput, categoryId: "commerce_category_electronics" },
    );

    expect(result).toEqual({
      success: false,
      error: {
        type: "CATEGORY_NOT_ACTIVE_LEAF",
        categoryId: "commerce_category_electronics",
      },
    });
    expect(databaseState.transactionCalled).toBe(true);
  });

  it("rejects active categories that have children", async () => {
    databaseState.categoryResults = [
      [
        {
          id: "commerce_category_electronics",
          parentCategoryId: null,
          state: "active",
        },
      ],
      [{ id: "commerce_category_phones" }],
    ];

    const result = await createProduct(
      { userId: "user-one", organizationId: "organization-one" },
      { ...baseInput, categoryId: "commerce_category_electronics" },
    );

    expect(result.success).toBe(false);
    expect(!result.success && result.error.type).toBe("CATEGORY_NOT_ACTIVE_LEAF");
  });

  it("rejects inconsistent canonical and legacy category values", async () => {
    databaseState.categoryResults = [
      [
        {
          id: "commerce_category_fashion",
          parentCategoryId: null,
          state: "active",
        },
      ],
      [],
    ];

    const result = await createProduct(
      { userId: "user-one", organizationId: "organization-one" },
      {
        ...baseInput,
        category: "electronics",
        categoryId: "commerce_category_fashion",
      },
    );

    expect(result.success).toBe(false);
    expect(!result.success && result.error.type).toBe("CATEGORY_MISMATCH");
  });
});
