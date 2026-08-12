import { beforeAll, describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

stubServerEnvironment();

vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());

describe("deriveStockState", () => {
  let deriveStockState: typeof import("#src/modules/store/catalog/store-catalog.service.js").deriveStockState;

  beforeAll(async () => {
    ({ deriveStockState } = await import("#src/modules/store/catalog/store-catalog.service.js"));
  });

  it("maps zero stock without lead time to unavailable", () => {
    expect(
      deriveStockState({
        stockQuantity: 0,
        leadTimeMinDays: null,
        leadTimeMaxDays: null,
      }),
    ).toBe("unavailable");
  });

  it("maps zero stock with lead time to made_to_order", () => {
    expect(
      deriveStockState({
        stockQuantity: 0,
        leadTimeMinDays: 7,
        leadTimeMaxDays: 21,
      }),
    ).toBe("made_to_order");
  });

  it("maps small positive stock to low_stock", () => {
    expect(
      deriveStockState({
        stockQuantity: 3,
        leadTimeMinDays: null,
        leadTimeMaxDays: null,
      }),
    ).toBe("low_stock");
  });

  it("maps ample stock to in_stock", () => {
    expect(
      deriveStockState({
        stockQuantity: 20,
        leadTimeMinDays: 1,
        leadTimeMaxDays: 3,
      }),
    ).toBe("in_stock");
  });
});
