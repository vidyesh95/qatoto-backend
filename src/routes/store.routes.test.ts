import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

const catalogStubs = vi.hoisted(() => ({
  listActiveCategories: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  getCategoryBySlug: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  listEligibleProducts: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  getPublicProductBySlug: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  getPublicOrganizationStorefront: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

const searchStubs = vi.hoisted(() => ({
  searchStoreDocuments: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

const merchandisingStubs = vi.hoisted(() => ({
  getStoreHome: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  listPathways: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  getPathwayBySlug: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  getRailBySlug: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

const providersStubs = vi.hoisted(() => ({
  listPublicProviders: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  getPublicProviderByOrganizationSlug: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  getPublicServiceOfferingBySlug: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

vi.mock("#src/services/store-catalog.service.js", () => catalogStubs);
vi.mock("#src/services/store-search.service.js", () => searchStubs);
vi.mock("#src/services/store-merchandising.service.js", () => merchandisingStubs);
vi.mock("#src/services/commerce-providers.service.js", () => providersStubs);

describe("public store routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns buyer-safe product detail on happy path", async () => {
    catalogStubs.getPublicProductBySlug.mockResolvedValue({
      success: true,
      value: {
        id: "product-1",
        publicSlug: "solar-freezer-abcd1234",
        title: "Solar Freezer",
        brand: null,
        currency: "USD",
        priceInCents: 12_000,
        compareAtPriceInCents: null,
        stockState: "in_stock",
        samplePolicy: "unavailable",
        leadTimeMinDays: 7,
        leadTimeMaxDays: 21,
        mainImageUrl: "https://cdn.example.com/a.jpg",
        seller: {
          organizationId: "org-1",
          slug: "acme-trade",
          displayName: "Acme Trade",
          countryCode: "IN",
          logoUrl: null,
          summary: null,
        },
        category: { id: "cat-1", slug: "electronics", name: "Electronics" },
        description: "Cold storage",
        keyFeatures: ["solar"],
        modelNumber: null,
        countryOfOriginCode: "IN",
        unitOfMeasure: "unit",
        samplePriceInCents: null,
        images: [{ id: "img-1", url: "https://cdn.example.com/a.jpg", position: 0 }],
        pricingTiers: [{ unitPriceInCents: 10_000, minimumOrderQuantity: 10, position: 0 }],
        specifications: [],
        categoryTrail: [],
      },
    });

    const response = await request(app).get("/store/products/solar-freezer-abcd1234");

    expect(response.status).toBe(200);
    expect(response.body.data.publicSlug).toBe("solar-freezer-abcd1234");
    expect(response.body.data.stockState).toBe("in_stock");
    expect(response.body.data.stockQuantity).toBeUndefined();
  });

  it("masks ineligible products as 404", async () => {
    catalogStubs.getPublicProductBySlug.mockResolvedValue({
      success: false,
      error: { type: "NOT_FOUND" },
    });

    const response = await request(app).get("/store/products/draft-slug");

    expect(response.status).toBe(404);
  });

  it("rejects invalid search query shapes with 422", async () => {
    const response = await request(app).get("/store/search").query({ limit: 999 });

    expect(response.status).toBe(422);
    expect(searchStubs.searchStoreDocuments).not.toHaveBeenCalled();
  });

  it("returns 404 for private organization storefronts", async () => {
    catalogStubs.getPublicOrganizationStorefront.mockResolvedValue({
      success: false,
      error: { type: "NOT_FOUND" },
    });

    const response = await request(app).get("/store/organizations/private-co");

    expect(response.status).toBe(404);
  });

  it("returns 422 for invalid search cursors", async () => {
    searchStubs.searchStoreDocuments.mockResolvedValue({
      success: false,
      error: { type: "INVALID_CURSOR" },
    });

    const response = await request(app).get("/store/search").query({ cursor: "bad" });

    expect(response.status).toBe(422);
  });

  it("lists public providers through the directory", async () => {
    providersStubs.listPublicProviders.mockResolvedValue({
      success: true,
      value: { items: [], page: { nextCursor: null, hasMore: false } },
    });

    const response = await request(app).get("/store/providers");

    expect(response.status).toBe(200);
    expect(providersStubs.listPublicProviders).toHaveBeenCalled();
  });

  it("hides draft service offerings", async () => {
    providersStubs.getPublicServiceOfferingBySlug.mockResolvedValue({
      success: false,
      error: { type: "NOT_FOUND" },
    });

    const response = await request(app).get("/store/services/draft-offering");

    expect(response.status).toBe(404);
  });
});
