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
  getCategoryFacets: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  listEligibleProducts: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  getPublicProductBySlug: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  getPublicOrganizationStorefront: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

const searchStubs = vi.hoisted(() => ({
  searchStoreDocuments: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

const merchandisingStubs = vi.hoisted(() => ({
  getStoreHome: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  getRailBySlug: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

// Phase 9 (§15.2) moved pathways out of the merchandising service: a set of slots with
// ranked candidates shares nothing with hero slides and rails beyond a time window.
const deliveryEstimateStubs = vi.hoisted(() => ({
  estimateDeliveryForLines: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  resolveShippingOriginCountryCode: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  computePackagingTotals: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  groupOfferingsIntoEstimates: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

const pathwayStubs = vi.hoisted(() => ({
  listActivePathways: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  getPathwaySetBySlug: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

const providersStubs = vi.hoisted(() => ({
  listPublicProviders: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  getPublicProviderByOrganizationSlug: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  getPublicServiceOfferingBySlug: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

vi.mock("#src/services/store-catalog.service.js", () => catalogStubs);
vi.mock("#src/services/store-search.service.js", () => searchStubs);
vi.mock("#src/services/store-merchandising.service.js", () => merchandisingStubs);
vi.mock("#src/services/store-pathways.service.js", () => pathwayStubs);
vi.mock("#src/services/commerce-delivery-estimate.service.js", () => deliveryEstimateStubs);
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

  it("returns category facets with the first product page", async () => {
    catalogStubs.getCategoryBySlug.mockResolvedValue({
      success: true,
      value: {
        category: {
          id: "cat-1",
          slug: "electronics",
          name: "Electronics",
          parentCategoryId: null,
          siblingOrder: 0,
          imageUrl: null,
        },
        children: [],
      },
    });
    catalogStubs.getCategoryFacets.mockResolvedValue({
      sellerCountryCodes: [{ value: "IN", count: 2 }],
      stockStates: [{ value: "in_stock", count: 2 }],
      samplePolicies: [{ value: "unavailable", count: 2 }],
      priceRangesInCents: { minInCents: 1000, maxInCents: 5000, count: 2 },
    });
    catalogStubs.listEligibleProducts.mockResolvedValue({
      success: true,
      value: { items: [], page: { nextCursor: null, hasMore: false } },
    });

    const response = await request(app).get("/store/categories/electronics");

    expect(response.status).toBe(200);
    expect(response.body.data.facets.sellerCountryCodes[0].value).toBe("IN");
    expect(response.body.data.products.page.hasMore).toBe(false);
    expect(catalogStubs.getCategoryFacets).toHaveBeenCalledWith("cat-1");
  });

  it("forwards sort=relevance to search", async () => {
    searchStubs.searchStoreDocuments.mockResolvedValue({
      success: true,
      value: { items: [], page: { nextCursor: null, hasMore: false } },
    });

    const response = await request(app).get("/store/search").query({ query: "solar", sort: "relevance", limit: 12 });

    expect(response.status).toBe(200);
    expect(searchStubs.searchStoreDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "solar",
        sort: "relevance",
        limit: 12,
      }),
    );
  });
  it("paginates the pathway index", async () => {
    pathwayStubs.listActivePathways.mockResolvedValue({
      success: true,
      value: {
        items: [{ id: "pathway_1", slug: "autumn-hotel-room-refit", slotCount: 5 }],
        page: { nextCursor: "Autumn_pathway_1", hasMore: true },
      },
    });

    const response = await request(app).get("/store/pathways").query({ limit: 1 });

    expect(response.status).toBe(200);
    expect(response.body.data.page.hasMore).toBe(true);
    expect(pathwayStubs.listActivePathways).toHaveBeenCalledWith(expect.objectContaining({ limit: 1 }));
  });

  it("returns a tampered pathway cursor as 422, not a 404", async () => {
    // Before Phase 9 this handler collapsed every error to 404, which answered a
    // different question than the one the client asked.
    pathwayStubs.getPathwaySetBySlug.mockResolvedValue({
      success: false,
      error: { type: "INVALID_CURSOR" },
    });

    const response = await request(app).get("/store/pathways/autumn-hotel-room-refit").query({ cursor: "tampered" });

    expect(response.status).toBe(422);
  });

  it("keeps an unfillable required slot in the set response", async () => {
    pathwayStubs.getPathwaySetBySlug.mockResolvedValue({
      success: true,
      value: {
        pathway: { id: "pathway_1", slug: "autumn-hotel-room-refit" },
        slots: [
          { id: "slot_1", state: "available", chosenCandidateKey: "candidate_a", candidates: [] },
          {
            id: "slot_2",
            state: "unavailable",
            chosenCandidateKey: null,
            unavailableReason: { type: "NO_ELIGIBLE_CANDIDATE" },
            candidates: [],
          },
        ],
        currencyTotals: [{ currency: "USD", subtotalInCents: 2500, slotCount: 1 }],
        completeness: {
          slotCount: 2,
          requiredSlotCount: 2,
          filledRequiredSlotCount: 1,
          isComplete: false,
        },
        page: { nextCursor: null, hasMore: false },
      },
    });

    const response = await request(app).get("/store/pathways/autumn-hotel-room-refit");

    expect(response.status).toBe(200);
    expect(response.body.data.slots).toHaveLength(2);
    expect(response.body.data.completeness.isComplete).toBe(false);
    expect(response.body.data.currencyTotals).toHaveLength(1);
  });

  it("returns a missing pathway as 404", async () => {
    pathwayStubs.getPathwaySetBySlug.mockResolvedValue({
      success: false,
      error: { type: "NOT_FOUND" },
    });

    const response = await request(app).get("/store/pathways/never-published");

    expect(response.status).toBe(404);
  });

  it("estimates delivery for a product against an explicit destination", async () => {
    catalogStubs.getPublicProductBySlug.mockResolvedValue({
      success: true,
      value: { id: "prd_1", seller: { organizationId: "commerce_org_seller" } },
    });
    deliveryEstimateStubs.estimateDeliveryForLines.mockResolvedValue([
      { currency: "USD", estimatedMinInCents: 25_000, estimatedMaxInCents: 90_000 },
    ]);

    const response = await request(app)
      .get("/store/products/solar-freezer/delivery-estimate")
      .query({ destinationCountryCode: "DE", quantity: 50 });

    expect(response.status).toBe(200);
    expect(response.body.data.estimates).toHaveLength(1);
    expect(deliveryEstimateStubs.estimateDeliveryForLines).toHaveBeenCalledWith(
      expect.objectContaining({
        sellerOrganizationId: "commerce_org_seller",
        destinationCountryCode: "DE",
        lines: [{ productId: "prd_1", quantity: 50 }],
      }),
    );
  });

  it("refuses a destination that is not an ISO alpha-2 code", async () => {
    const response = await request(app)
      .get("/store/products/solar-freezer/delivery-estimate")
      .query({ destinationCountryCode: "Germany" });

    expect(response.status).toBe(422);
    expect(deliveryEstimateStubs.estimateDeliveryForLines).not.toHaveBeenCalled();
  });

  /**
   * An uncovered route returns an empty list, never a zero. "We do not know" and "it is
   * free" are different answers, and only the mock claimed the second one.
   */
  it("returns an empty estimate list when no provider covers the route", async () => {
    catalogStubs.getPublicProductBySlug.mockResolvedValue({
      success: true,
      value: { id: "prd_1", seller: { organizationId: "commerce_org_seller" } },
    });
    deliveryEstimateStubs.estimateDeliveryForLines.mockResolvedValue([]);

    const response = await request(app)
      .get("/store/products/solar-freezer/delivery-estimate")
      .query({ destinationCountryCode: "AQ" });

    expect(response.status).toBe(200);
    expect(response.body.data.estimates).toEqual([]);
  });
});
