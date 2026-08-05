import type { Express, NextFunction, Request, Response } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, TEST_SESSION_USER } from "#src/test-support/auth-mock.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

const ORGANIZATION_ID = "commerce_org_legacy_0123456789abcdef";
const PRODUCT_ID = "product-one";

vi.mock("#src/middleware/require-active-commerce-organization.js", () => ({
  requireActiveCommerceOrganization: (req: Request, _res: Response, next: NextFunction): void => {
    req.commerceOrganization = {
      organizationId: ORGANIZATION_ID,
      memberId: "member-one",
      memberRole: "seller",
      tradeState: "active",
    };
    next();
  },
  requireActiveSellerCommerceOrganization: (req: Request, _res: Response, next: NextFunction): void => {
    req.commerceOrganization = {
      organizationId: ORGANIZATION_ID,
      memberId: "member-one",
      memberRole: "seller",
      tradeState: "active",
    };
    next();
  },
  requireActiveBuyerCommerceOrganization: (req: Request, _res: Response, next: NextFunction): void => {
    req.commerceOrganization = {
      organizationId: ORGANIZATION_ID,
      memberId: "member-one",
      memberRole: "buyer",
      tradeState: "active",
    };
    next();
  },
  requireActiveProviderCommerceOrganization: (req: Request, _res: Response, next: NextFunction): void => {
    req.commerceOrganization = {
      organizationId: ORGANIZATION_ID,
      memberId: "member-one",
      memberRole: "provider_operator",
      tradeState: "active",
    };
    next();
  },
}));

const productView = {
  id: PRODUCT_ID,
  title: "Organization listing",
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
  publicSlug: null,
  modelNumber: null,
  countryOfOriginCode: null,
  unitOfMeasure: null,
  samplePolicy: "unavailable" as const,
  samplePriceInCents: null,
  leadTimeMinDays: null,
  leadTimeMaxDays: null,
  moderationState: "pending" as const,
  images: [],
  pricingTiers: [],
};

const serviceStubs = vi.hoisted(() => ({
  createProduct: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  listMyProducts: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  getProduct: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  updateProduct: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  addProductImage: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  deleteProductImageById: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  reorderImages: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  publishProduct: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  unpublishProduct: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  deleteProduct: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

vi.mock("#src/services/products.service.js", () => serviceStubs);

describe("organization-scoped product routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    signInAs();
  });

  it("derives product ownership from seller organization context", async () => {
    serviceStubs.createProduct.mockResolvedValue({ success: true, value: productView });

    const response = await request(app).post("/products").send({
      title: "Organization listing",
      categoryId: "commerce_category_electronics",
      priceInCents: 1_000,
    });

    expect(response.status).toBe(201);
    expect(serviceStubs.createProduct).toHaveBeenCalledWith(
      { userId: TEST_SESSION_USER.id, organizationId: ORGANIZATION_ID },
      expect.objectContaining({ categoryId: "commerce_category_electronics" }),
    );
  });

  it("rejects body-supplied ownership instead of forwarding it", async () => {
    const response = await request(app).post("/products").send({
      title: "Hostile listing",
      category: "electronics",
      priceInCents: 1_000,
      sellerOrganizationId: "commerce_org_attacker",
    });

    expect(response.status).toBe(422);
    expect(serviceStubs.createProduct).not.toHaveBeenCalled();
  });

  it("preserves cross-tenant not-found masking", async () => {
    serviceStubs.getProduct.mockResolvedValue({
      success: false,
      error: { type: "NOT_FOUND", productId: PRODUCT_ID },
    });

    const response = await request(app).get(`/products/${PRODUCT_ID}`);

    expect(response.status).toBe(404);
    expect(serviceStubs.getProduct).toHaveBeenCalledWith(ORGANIZATION_ID, PRODUCT_ID);
  });

  it("continues accepting the legacy category enum", async () => {
    serviceStubs.createProduct.mockResolvedValue({ success: true, value: productView });

    const response = await request(app).post("/products").send({
      title: "Legacy client listing",
      category: "electronics",
      priceInCents: 1_000,
    });

    expect(response.status).toBe(201);
    expect(serviceStubs.createProduct).toHaveBeenCalledWith(
      { userId: TEST_SESSION_USER.id, organizationId: ORGANIZATION_ID },
      expect.objectContaining({ category: "electronics" }),
    );
  });
});
