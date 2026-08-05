import { beforeAll, describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

stubServerEnvironment();

vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());

describe("deriveStockState", () => {
  let deriveStockState: typeof import("#src/services/store-catalog.service.js").deriveStockState;

  beforeAll(async () => {
    ({ deriveStockState } = await import("#src/services/store-catalog.service.js"));
  });

  it("maps zero stock to unavailable", () => {
    expect(deriveStockState(0)).toBe("unavailable");
  });

  it("maps small positive stock to low_stock", () => {
    expect(deriveStockState(3)).toBe("low_stock");
  });

  it("maps ample stock to in_stock", () => {
    expect(deriveStockState(20)).toBe("in_stock");
  });
});
