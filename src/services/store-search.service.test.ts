import { beforeAll, describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

stubServerEnvironment();

vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/jobs.js", () => ({
  JOB_NAMES: { refreshStoreSearchDocument: "refresh-store-search-document" },
  idempotencyKeyFor: {
    refreshStoreSearchDocumentProduct: (productId: string, generation: string) => `product:${productId}:${generation}`,
    refreshStoreSearchDocumentOffering: (offeringId: string, generation: string) =>
      `offering:${offeringId}:${generation}`,
    refreshStoreSearchDocumentOrganization: (organizationId: string, generation: string) =>
      `organization:${organizationId}:${generation}`,
  },
  sendJob: vi.fn<() => Promise<{ success: true; value: { jobId: string } }>>(async () => ({
    success: true,
    value: { jobId: "job-1" },
  })),
}));

describe("store search enqueue helpers", () => {
  let enqueueProductSearchDocumentRefresh: typeof import("#src/services/store-search.service.js").enqueueProductSearchDocumentRefresh;
  let sendJob: typeof import("#src/lib/jobs.js").sendJob;

  beforeAll(async () => {
    ({ enqueueProductSearchDocumentRefresh } = await import("#src/services/store-search.service.js"));
    ({ sendJob } = await import("#src/lib/jobs.js"));
  });

  it("enqueues product search refresh jobs", async () => {
    await enqueueProductSearchDocumentRefresh("product-1");
    expect(sendJob).toHaveBeenCalledWith(
      "refresh-store-search-document",
      { targetKind: "product", productId: "product-1" },
      expect.objectContaining({ idempotencyKey: expect.stringContaining("product:product-1:") }),
    );
  });
});
