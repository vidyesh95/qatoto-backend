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
  // A39. `/store/search` now answers counts beside its results, so every suite that mocks
  // this module must provide it or the route resolves `undefined` as a function.
  computeStoreSearchFacets: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
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

const freightJourneyStubs = vi.hoisted(() => ({
  planFreightJourney: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  measureConsignmentForLines: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  computeConsignmentMeasurement: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  composeJourneys: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  planLegs: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
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

vi.mock("#src/modules/store/catalog/store-catalog.service.js", () => catalogStubs);
vi.mock("#src/modules/store/catalog/store-search.service.js", () => searchStubs);
vi.mock("#src/modules/store/catalog/store-merchandising.service.js", () => merchandisingStubs);
vi.mock("#src/services/store-pathways.service.js", () => pathwayStubs);
vi.mock("#src/services/commerce-delivery-estimate.service.js", () => deliveryEstimateStubs);
vi.mock("#src/services/commerce-freight-journey.service.js", () => freightJourneyStubs);
vi.mock("#src/modules/store/procurement/commerce-providers.service.js", () => providersStubs);

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
    // A39. The SLUG, not the id — the facets read `store_search_document`, which is scoped by
    // `category_slug` exactly as the search filters are.
    expect(catalogStubs.getCategoryFacets).toHaveBeenCalledWith("electronics");
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

  /**
   * A25. Every facet `getCategoryFacets` publishes is now something the search can
   * filter on. A count the caller cannot act on is an invitation to filter the fetched
   * page, which §2.4 forbids.
   */
  it("forwards every A25 facet filter to search, coerced", async () => {
    searchStubs.searchStoreDocuments.mockResolvedValue({
      success: true,
      value: { items: [], page: { nextCursor: null, hasMore: false } },
    });

    const response = await request(app).get("/store/search").query({
      priceMinInCents: "1000",
      priceMaxInCents: "50000",
      stockState: "in_stock",
      samplePolicy: "refundable",
      condition: "new",
      verificationState: "verified",
      leadTimeMaxDays: "30",
    });

    expect(response.status).toBe(200);
    expect(searchStubs.searchStoreDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        priceMinInCents: 1000,
        priceMaxInCents: 50_000,
        stockState: "in_stock",
        samplePolicy: "refundable",
        condition: "new",
        verificationState: "verified",
        leadTimeMaxDays: 30,
      }),
    );
  });

  /** A25. The supplier directory — a buyer could reach one storefront and browse none. */
  it("accepts documentKind=organization", async () => {
    searchStubs.searchStoreDocuments.mockResolvedValue({
      success: true,
      value: { items: [], page: { nextCursor: null, hasMore: false } },
    });

    const response = await request(app).get("/store/search").query({ documentKind: "organization" });

    expect(response.status).toBe(200);
    expect(searchStubs.searchStoreDocuments).toHaveBeenCalledWith(
      expect.objectContaining({ documentKind: "organization" }),
    );
  });

  it("refuses a stock state that is not one deriveStockState produces", async () => {
    const response = await request(app).get("/store/search").query({ stockState: "backordered" });

    expect(response.status).toBe(422);
    expect(searchStubs.searchStoreDocuments).not.toHaveBeenCalled();
  });

  /**
   * A39. Search carried thirteen filters and published no counts at all, so a buyer could
   * narrow but never see how many narrowing would leave.
   */
  it("answers facets beside the results, from the SAME filter object", async () => {
    searchStubs.searchStoreDocuments.mockResolvedValue({
      success: true,
      value: { items: [], page: { nextCursor: null, hasMore: false } },
    });
    searchStubs.computeStoreSearchFacets.mockResolvedValue({
      sellerCountryCodes: [{ value: "IN", count: 4 }],
      stockStates: [{ value: "in_stock", count: 3 }],
      samplePolicies: [],
      conditions: [{ value: "new", count: 4 }],
      verificationStates: [],
      documentKinds: [{ value: "product", count: 4 }],
      providerKinds: [],
      leadTimeMaxDays: [{ value: "30", count: 2 }],
      priceRangesInCents: { minInCents: 1000, maxInCents: 50_000, count: 4 },
    });

    const response = await request(app).get("/store/search").query({ query: "chair", stockState: "in_stock" });

    expect(response.status).toBe(200);
    expect(response.body.data.facets.conditions).toEqual([{ value: "new", count: 4 }]);

    /**
     * THE ASSERTION THIS TEST EXISTS FOR. Both calls receive the same filters — the counts
     * describe the set the results were drawn from, not a different one. Paging is the only
     * difference, and paging does not change what matched.
     */
    const searchArguments = searchStubs.searchStoreDocuments.mock.calls[0]?.[0];
    const facetArguments = searchStubs.computeStoreSearchFacets.mock.calls[0]?.[0];
    expect(facetArguments).toEqual(expect.objectContaining({ query: "chair", stockState: "in_stock" }));
    expect(searchArguments).toEqual(expect.objectContaining(facetArguments as object));
  });

  /** A25. Without this a breadcrumb over a nested category costs one request per level. */
  it("carries the category ancestor trail on the category read", async () => {
    catalogStubs.getCategoryBySlug.mockResolvedValue({
      success: true,
      value: {
        category: { id: "cat-3", slug: "chest-freezers", name: "Chest freezers" },
        children: [],
        ancestors: [
          { id: "cat-1", slug: "industrial", name: "Industrial" },
          { id: "cat-2", slug: "industrial-cooling", name: "Industrial cooling" },
        ],
      },
    });
    catalogStubs.getCategoryFacets.mockResolvedValue({
      sellerCountryCodes: [],
      stockStates: [],
      samplePolicies: [],
      priceRangesInCents: { minInCents: null, maxInCents: null, count: 0 },
    });
    catalogStubs.listEligibleProducts.mockResolvedValue({
      success: true,
      value: { items: [], page: { nextCursor: null, hasMore: false } },
    });

    const response = await request(app).get("/store/categories/chest-freezers");

    expect(response.status).toBe(200);
    // Root first, and the category itself is not in its own trail.
    expect(response.body.data.ancestors.map((entry: { slug: string }) => entry.slug)).toEqual([
      "industrial",
      "industrial-cooling",
    ]);
  });

  /**
   * A23. The read that makes a required customization slot checkoutable at all: it was
   * enforced at `checkout/prepare` and projected on no buyer read, so a product carrying
   * one could not be bought by anybody.
   */
  it("projects customization options on the public product detail", async () => {
    catalogStubs.getPublicProductBySlug.mockResolvedValue({
      success: true,
      value: {
        id: "prd_1",
        publicSlug: "solar-freezer",
        seller: { organizationId: "commerce_org_seller" },
        customizationOptions: [
          {
            id: "opt_1",
            slotKey: "logo",
            label: "Logo",
            customizationKind: "file_upload",
            acceptedMediaTypes: ["image/png"],
            choiceValues: [],
            minimumOrderQuantity: 50,
            isRequired: true,
            position: 0,
          },
        ],
      },
    });

    const response = await request(app).get("/store/products/solar-freezer");

    expect(response.status).toBe(200);
    expect(response.body.data.customizationOptions[0].slotKey).toBe("logo");
    expect(response.body.data.customizationOptions[0].isRequired).toBe(true);
    expect(response.body.data.customizationOptions[0].minimumOrderQuantity).toBe(50);
    // `state` stays off the public wire; the read carries active options only.
    expect(response.body.data.customizationOptions[0].state).toBeUndefined();
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

  /**
   * Phase 20, §19.5: EXTENDED, not replaced. A client reading only `data.estimates` must see
   * exactly what it saw before `lanePlan` existed.
   */
  it("leaves the A16 estimate untouched when a lane plan is added beside it", async () => {
    catalogStubs.getPublicProductBySlug.mockResolvedValue({
      success: true,
      value: { id: "prd_1", seller: { organizationId: "commerce_org_seller" } },
    });
    deliveryEstimateStubs.estimateDeliveryForLines.mockResolvedValue([
      { currency: "USD", estimatedMinInCents: 25_000, estimatedMaxInCents: 90_000 },
    ]);
    deliveryEstimateStubs.resolveShippingOriginCountryCode.mockResolvedValue("IN");
    freightJourneyStubs.planFreightJourney.mockResolvedValue({
      contracting: { party: "provider" },
      origin: { countryCode: "IN", locality: null },
      destination: { countryCode: "DE", locality: null },
      consignment: {
        billableWeightGrams: 24_000,
        volumeCubicCm: 48_000,
        packageCount: 2,
        hasIncompletePackageData: false,
      },
      legs: [],
      journeys: [],
      unpriceableReasons: [{ kind: "leg_uncovered", legSequence: 1, reasons: ["no_active_rate_card"] }],
      quotableProviders: [
        { providerOrganizationId: "org_forwarder", sourceForwarderName: "Blue Anchor Logistics", mode: "sea" },
      ],
    });

    const response = await request(app)
      .get("/store/products/solar-freezer/delivery-estimate")
      .query({ destinationCountryCode: "DE", quantity: 50 });

    expect(response.status).toBe(200);
    expect(response.body.data.estimates).toEqual([
      { currency: "USD", estimatedMinInCents: 25_000, estimatedMaxInCents: 90_000 },
    ]);
    expect(response.body.data.lanePlan.journeys).toEqual([]);
    // Qatoto is a marketplace, not a carrier: the buyer contracts with the provider, and an
    // unpriceable lane still names who could quote it.
    expect(response.body.data.lanePlan.contracting).toEqual({ party: "provider" });
    expect(response.body.data.lanePlan.quotableProviders).toHaveLength(1);
  });

  it("carries no date anywhere in a lane plan — a product page has no clock to start", async () => {
    catalogStubs.getPublicProductBySlug.mockResolvedValue({
      success: true,
      value: { id: "prd_1", seller: { organizationId: "commerce_org_seller" } },
    });
    deliveryEstimateStubs.estimateDeliveryForLines.mockResolvedValue([]);
    deliveryEstimateStubs.resolveShippingOriginCountryCode.mockResolvedValue("IN");
    freightJourneyStubs.planFreightJourney.mockResolvedValue({
      origin: { countryCode: "IN", locality: null },
      destination: { countryCode: "DE", locality: null },
      consignment: {
        billableWeightGrams: 24_000,
        volumeCubicCm: 48_000,
        packageCount: 2,
        hasIncompletePackageData: false,
      },
      legs: [
        {
          sequence: 0,
          kind: "international",
          originCountryCode: "IN",
          originLocality: null,
          destinationCountryCode: "DE",
          destinationLocality: null,
          options: [
            {
              mode: "sea",
              transitDaysMin: 24,
              transitDaysMax: 34,
              rateCardId: "rc_1",
              rateBreakId: "rb_1",
              chargeableWeightGrams: 48_000,
              chargeableWeightBasis: "volumetric",
              providerQuote: {
                providerOrganizationId: "org_forwarder",
                sourceForwarderName: "Blue Anchor Logistics",
                priceInCents: 186_000,
                currency: "USD",
                validUntil: null,
                subjectToRemeasurement: true,
              },
            },
          ],
          unavailableReasons: [],
          quotableProviders: [],
        },
      ],
      journeys: [],
      unpriceableReasons: [],
      contracting: { party: "provider" },
      quotableProviders: [],
    });

    const response = await request(app)
      .get("/store/products/solar-freezer/delivery-estimate")
      .query({ destinationCountryCode: "DE" });

    expect(response.status).toBe(200);
    // Durations only. `validUntil` is a card's expiry, not a delivery date, and it is null here.
    const serialized = JSON.stringify(response.body.data.lanePlan);
    expect(serialized).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(response.body.data.lanePlan.legs[0].options[0].transitDaysMin).toBe(24);
    // The price is reachable only through the provider that quoted it.
    expect(response.body.data.lanePlan.legs[0].options[0].providerQuote.priceInCents).toBe(186_000);
    expect(response.body.data.lanePlan.legs[0].options[0].priceInCents).toBeUndefined();
  });

  it("returns a null lane plan when the seller's origin cannot be resolved", async () => {
    catalogStubs.getPublicProductBySlug.mockResolvedValue({
      success: true,
      value: { id: "prd_1", seller: { organizationId: "commerce_org_seller" } },
    });
    deliveryEstimateStubs.estimateDeliveryForLines.mockResolvedValue([]);
    deliveryEstimateStubs.resolveShippingOriginCountryCode.mockResolvedValue(null);
    freightJourneyStubs.planFreightJourney.mockResolvedValue(null);

    const response = await request(app)
      .get("/store/products/solar-freezer/delivery-estimate")
      .query({ destinationCountryCode: "DE" });

    expect(response.status).toBe(200);
    expect(response.body.data.lanePlan).toBeNull();
  });
});
