import type { Express, NextFunction, Request, Response } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());
vi.mock("#src/middleware/require-identified-user.js", () => ({
  requireIdentifiedUser: (_req: Request, _res: Response, next: NextFunction): void => {
    next();
  },
  isIdentifiedUser: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
}));

const categoriesServiceStubs = vi.hoisted(() => ({
  listCommerceCategoriesForStaff: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  createCommerceCategory: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  updateCommerceCategory: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  replaceCommerceCategoryImage: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  reorderCommerceCategories: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  retireCommerceCategory: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  submitCommerceCategoryRequest: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  listOwnCommerceCategoryRequests: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  listCommerceCategoryRequestsForStaff: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  decideCommerceCategoryRequest: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

vi.mock("#src/modules/store/catalog/commerce-categories.service.js", () => ({
  HOME_RAIL_CATEGORY_LIMIT: 8,
  listCommerceCategoriesForStaff: categoriesServiceStubs.listCommerceCategoriesForStaff,
  createCommerceCategory: categoriesServiceStubs.createCommerceCategory,
  updateCommerceCategory: categoriesServiceStubs.updateCommerceCategory,
  replaceCommerceCategoryImage: categoriesServiceStubs.replaceCommerceCategoryImage,
  reorderCommerceCategories: categoriesServiceStubs.reorderCommerceCategories,
  retireCommerceCategory: categoriesServiceStubs.retireCommerceCategory,
  submitCommerceCategoryRequest: categoriesServiceStubs.submitCommerceCategoryRequest,
  listOwnCommerceCategoryRequests: categoriesServiceStubs.listOwnCommerceCategoryRequests,
  listCommerceCategoryRequestsForStaff: categoriesServiceStubs.listCommerceCategoryRequestsForStaff,
  decideCommerceCategoryRequest: categoriesServiceStubs.decideCommerceCategoryRequest,
}));

const attributesServiceStubs = vi.hoisted(() => ({
  listCategoryAttributesForStaff: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  createCategoryAttribute: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  updateCategoryAttribute: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

vi.mock("#src/modules/store/catalog/commerce-category-attributes.service.js", () => ({
  listCategoryAttributesForStaff: attributesServiceStubs.listCategoryAttributesForStaff,
  createCategoryAttribute: attributesServiceStubs.createCategoryAttribute,
  updateCategoryAttribute: attributesServiceStubs.updateCategoryAttribute,
}));

describe("commerce-categories.routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await resetRateLimiters();
    signOut();
  });

  describe("POST /commerce/category-requests", () => {
    it("returns 401 when signed out", async () => {
      const response = await request(app).post("/commerce/category-requests").send({ proposedName: "Keyboards" });

      expect(response.status).toBe(401);
    });

    it("returns 422 when proposedName is empty whitespace", async () => {
      signInAs({ id: "usr_seller_1", email: "seller@qatoto.test" });

      const response = await request(app).post("/commerce/category-requests").send({ proposedName: "   " });

      expect(response.status).toBe(422);
    });

    it("returns 422 when proposedName is missing", async () => {
      signInAs({ id: "usr_seller_1", email: "seller@qatoto.test" });

      const response = await request(app).post("/commerce/category-requests").send({});

      expect(response.status).toBe(422);
    });

    it("returns 201 on successful category request submission", async () => {
      signInAs({ id: "usr_seller_1", email: "seller@qatoto.test" });

      const mockRequest = {
        id: "req_123",
        proposedName: "Custom Keycaps",
        state: "pending",
      };

      categoriesServiceStubs.submitCommerceCategoryRequest.mockResolvedValueOnce({
        success: true,
        value: mockRequest,
      });

      const response = await request(app).post("/commerce/category-requests").send({ proposedName: "Custom Keycaps" });

      expect(response.status).toBe(201);
      expect(response.body.data.request).toEqual(mockRequest);
    });
  });

  describe("GET /commerce/category-requests/mine", () => {
    it("returns 401 when signed out", async () => {
      const response = await request(app).get("/commerce/category-requests/mine");
      expect(response.status).toBe(401);
    });

    it("returns 200 with seller's category requests", async () => {
      signInAs({ id: "usr_seller_1", email: "seller@qatoto.test" });

      const mockRequests = [{ id: "req_1", proposedName: "Keycaps", state: "pending" }];
      categoriesServiceStubs.listOwnCommerceCategoryRequests.mockResolvedValueOnce(mockRequests);

      const response = await request(app).get("/commerce/category-requests/mine");

      expect(response.status).toBe(200);
      expect(response.body.data.requests).toEqual(mockRequests);
    });
  });

  describe("GET /commerce/admin/categories", () => {
    it("returns 401 when signed out", async () => {
      const response = await request(app).get("/commerce/admin/categories");
      expect(response.status).toBe(401);
    });

    it("returns 403 when user lacks moderate_commerce capability", async () => {
      signInAs({ id: "usr_buyer_1", email: "buyer@qatoto.test" });

      categoriesServiceStubs.listCommerceCategoriesForStaff.mockResolvedValueOnce({
        success: false,
        error: { type: "PLATFORM_CAPABILITY_REQUIRED" },
      });

      const response = await request(app).get("/commerce/admin/categories");

      expect(response.status).toBe(403);
      expect(response.body.message).toMatch(/requires the moderator or admin role/);
    });

    it("returns 200 with category tree for staff", async () => {
      signInAs({ id: "usr_staff_1", email: "staff@qatoto.test" });

      const mockCategories = [{ id: "cat_1", name: "Electronics", slug: "electronics" }];
      categoriesServiceStubs.listCommerceCategoriesForStaff.mockResolvedValueOnce({
        success: true,
        value: mockCategories,
      });

      const response = await request(app).get("/commerce/admin/categories");

      expect(response.status).toBe(200);
      expect(response.body.data.items).toEqual(mockCategories);
    });
  });

  describe("POST /commerce/admin/categories", () => {
    it("returns 401 when signed out", async () => {
      const response = await request(app)
        .post("/commerce/admin/categories")
        .field("name", "Switches")
        .field("slug", "switches");

      expect(response.status).toBe(401);
    });

    it("returns 422 on invalid slug format", async () => {
      signInAs({ id: "usr_staff_1", email: "staff@qatoto.test" });

      const response = await request(app)
        .post("/commerce/admin/categories")
        .field("name", "Switches")
        .field("slug", "Switches_Invalid!");

      expect(response.status).toBe(422);
    });

    it("returns 409 when slug is already taken", async () => {
      signInAs({ id: "usr_staff_1", email: "staff@qatoto.test" });

      categoriesServiceStubs.createCommerceCategory.mockResolvedValueOnce({
        success: false,
        error: { type: "COMMERCE_CATEGORY_SLUG_TAKEN", slug: "switches" },
      });

      const response = await request(app)
        .post("/commerce/admin/categories")
        .field("name", "Switches")
        .field("slug", "switches");

      expect(response.status).toBe(409);
      expect(response.body.message).toMatch(/already used by another category/);
    });

    it("returns 201 on successful category creation", async () => {
      signInAs({ id: "usr_staff_1", email: "staff@qatoto.test" });

      const mockCreated = { id: "cat_switches", name: "Switches", slug: "switches" };
      categoriesServiceStubs.createCommerceCategory.mockResolvedValueOnce({
        success: true,
        value: mockCreated,
      });

      const response = await request(app)
        .post("/commerce/admin/categories")
        .field("name", "Switches")
        .field("slug", "switches");

      expect(response.status).toBe(201);
      expect(response.body.data.category).toEqual(mockCreated);
    });
  });

  describe("PATCH /commerce/admin/categories/reorder", () => {
    it("returns 401 when signed out", async () => {
      const response = await request(app)
        .patch("/commerce/admin/categories/reorder")
        .send({ parentCategoryId: null, categoryIds: ["cat_1"] });

      expect(response.status).toBe(401);
    });

    it("returns 422 when categoryIds is empty", async () => {
      signInAs({ id: "usr_staff_1", email: "staff@qatoto.test" });

      const response = await request(app)
        .patch("/commerce/admin/categories/reorder")
        .send({ parentCategoryId: null, categoryIds: [] });

      expect(response.status).toBe(422);
    });

    it("returns 422 when reorder mismatch is reported by service", async () => {
      signInAs({ id: "usr_staff_1", email: "staff@qatoto.test" });

      categoriesServiceStubs.reorderCommerceCategories.mockResolvedValueOnce({
        success: false,
        error: { type: "COMMERCE_CATEGORY_ORDER_MISMATCH" },
      });

      const response = await request(app)
        .patch("/commerce/admin/categories/reorder")
        .send({ parentCategoryId: null, categoryIds: ["cat_1", "cat_2"] });

      expect(response.status).toBe(422);
      expect(response.body.message).toMatch(/does not match the categories that exist/);
    });

    it("returns 200 on successful reorder", async () => {
      signInAs({ id: "usr_staff_1", email: "staff@qatoto.test" });

      categoriesServiceStubs.reorderCommerceCategories.mockResolvedValueOnce({
        success: true,
        value: [{ id: "cat_2" }, { id: "cat_1" }],
      });

      const response = await request(app)
        .patch("/commerce/admin/categories/reorder")
        .send({ parentCategoryId: null, categoryIds: ["cat_2", "cat_1"] });

      expect(response.status).toBe(200);
      expect(response.body.data.items).toEqual([{ id: "cat_2" }, { id: "cat_1" }]);
    });
  });

  describe("PATCH /commerce/admin/categories/:categoryId", () => {
    it("returns 401 when signed out", async () => {
      const response = await request(app).patch("/commerce/admin/categories/cat_1").send({ name: "New Name" });

      expect(response.status).toBe(401);
    });

    it("returns 404 when category is not found", async () => {
      signInAs({ id: "usr_staff_1", email: "staff@qatoto.test" });

      categoriesServiceStubs.updateCommerceCategory.mockResolvedValueOnce({
        success: false,
        error: { type: "COMMERCE_CATEGORY_NOT_FOUND" },
      });

      const response = await request(app).patch("/commerce/admin/categories/cat_ghost").send({ name: "Ghost" });

      expect(response.status).toBe(404);
    });

    it("returns 422 when cycle is detected", async () => {
      signInAs({ id: "usr_staff_1", email: "staff@qatoto.test" });

      categoriesServiceStubs.updateCommerceCategory.mockResolvedValueOnce({
        success: false,
        error: { type: "COMMERCE_CATEGORY_PARENT_CYCLE" },
      });

      const response = await request(app)
        .patch("/commerce/admin/categories/cat_1")
        .send({ parentCategoryId: "cat_1_sub" });

      expect(response.status).toBe(422);
      expect(response.body.message).toBe("A category cannot be moved inside itself.");
    });

    it("returns 200 on successful update", async () => {
      signInAs({ id: "usr_staff_1", email: "staff@qatoto.test" });

      const mockUpdated = { id: "cat_1", name: "Renamed", state: "active" };
      categoriesServiceStubs.updateCommerceCategory.mockResolvedValueOnce({
        success: true,
        value: mockUpdated,
      });

      const response = await request(app).patch("/commerce/admin/categories/cat_1").send({ name: "Renamed" });

      expect(response.status).toBe(200);
      expect(response.body.data.category).toEqual(mockUpdated);
    });
  });

  describe("PATCH /commerce/admin/categories/:categoryId/image", () => {
    it("returns 401 when signed out", async () => {
      const response = await request(app).patch("/commerce/admin/categories/cat_1/image");
      expect(response.status).toBe(401);
    });

    it("returns 422 when image file is missing", async () => {
      signInAs({ id: "usr_staff_1", email: "staff@qatoto.test" });

      const response = await request(app).patch("/commerce/admin/categories/cat_1/image");

      expect(response.status).toBe(422);
      expect(response.body.message).toMatch(/image file is required/);
    });

    it("returns 200 when image is uploaded successfully", async () => {
      signInAs({ id: "usr_staff_1", email: "staff@qatoto.test" });

      const mockWithImage = { id: "cat_1", imageUrl: "https://cdn.example.com/cat.png" };
      categoriesServiceStubs.replaceCommerceCategoryImage.mockResolvedValueOnce({
        success: true,
        value: mockWithImage,
      });

      const response = await request(app)
        .patch("/commerce/admin/categories/cat_1/image")
        .attach("image", Buffer.from("fake-png-content"), "cat.png");

      expect(response.status).toBe(200);
      expect(response.body.data.category).toEqual(mockWithImage);
    });
  });

  describe("POST /commerce/admin/categories/:categoryId/retire", () => {
    it("returns 401 when signed out", async () => {
      const response = await request(app).post("/commerce/admin/categories/cat_1/retire");
      expect(response.status).toBe(401);
    });

    it("returns 409 when category has sub-categories", async () => {
      signInAs({ id: "usr_staff_1", email: "staff@qatoto.test" });

      categoriesServiceStubs.retireCommerceCategory.mockResolvedValueOnce({
        success: false,
        error: { type: "COMMERCE_CATEGORY_HAS_CHILDREN", childCount: 3 },
      });

      const response = await request(app).post("/commerce/admin/categories/cat_parent/retire");

      expect(response.status).toBe(409);
      expect(response.body.message).toMatch(/Retire or move the 3 sub-categories/);
    });

    it("returns 409 when category is still in use by products", async () => {
      signInAs({ id: "usr_staff_1", email: "staff@qatoto.test" });

      categoriesServiceStubs.retireCommerceCategory.mockResolvedValueOnce({
        success: false,
        error: { type: "COMMERCE_CATEGORY_IN_USE", productCount: 5 },
      });

      const response = await request(app).post("/commerce/admin/categories/cat_busy/retire");

      expect(response.status).toBe(409);
      expect(response.body.message).toMatch(/5 listings are still in this category/);
    });

    it("returns 409 when attempting to retire protected misc category", async () => {
      signInAs({ id: "usr_staff_1", email: "staff@qatoto.test" });

      categoriesServiceStubs.retireCommerceCategory.mockResolvedValueOnce({
        success: false,
        error: { type: "COMMERCE_CATEGORY_PROTECTED" },
      });

      const response = await request(app).post("/commerce/admin/categories/cat_misc/retire");

      expect(response.status).toBe(409);
      expect(response.body.message).toMatch(/Misc cannot be retired/);
    });

    it("returns 200 on successful category retirement", async () => {
      signInAs({ id: "usr_staff_1", email: "staff@qatoto.test" });

      const mockRetired = { id: "cat_1", state: "retired" };
      categoriesServiceStubs.retireCommerceCategory.mockResolvedValueOnce({
        success: true,
        value: mockRetired,
      });

      const response = await request(app).post("/commerce/admin/categories/cat_1/retire");

      expect(response.status).toBe(200);
      expect(response.body.data.category).toEqual(mockRetired);
    });
  });

  describe("Category Attributes routes", () => {
    it("returns 401 on GET /commerce/admin/categories/:categoryId/attributes when signed out", async () => {
      const response = await request(app).get("/commerce/admin/categories/cat_1/attributes");
      expect(response.status).toBe(401);
    });

    it("returns 200 on GET /commerce/admin/categories/:categoryId/attributes when authenticated", async () => {
      signInAs({ id: "usr_staff_1", email: "staff@qatoto.test" });

      const mockAttrs = [
        {
          attributeKey: "switch_type",
          label: "Switch Type",
          valueKind: "enum",
        },
      ];

      attributesServiceStubs.listCategoryAttributesForStaff.mockResolvedValueOnce({
        success: true,
        value: mockAttrs,
      });

      const response = await request(app).get("/commerce/admin/categories/cat_1/attributes");

      expect(response.status).toBe(200);
      expect(response.body.data.attributes).toEqual(mockAttrs);
    });

    it("returns 409 on POST /commerce/admin/categories/:categoryId/attributes when key is taken", async () => {
      signInAs({ id: "usr_staff_1", email: "staff@qatoto.test" });

      attributesServiceStubs.createCategoryAttribute.mockResolvedValueOnce({
        success: false,
        error: { type: "ATTRIBUTE_KEY_TAKEN", attributeKey: "switch_type" },
      });

      const response = await request(app).post("/commerce/admin/categories/cat_1/attributes").send({
        attributeKey: "switch_type",
        label: "Switch Type",
        valueKind: "enum",
      });

      expect(response.status).toBe(409);
      expect(response.body.message).toMatch(/is already defined on this category/);
    });

    it("returns 201 on POST /commerce/admin/categories/:categoryId/attributes on success", async () => {
      signInAs({ id: "usr_staff_1", email: "staff@qatoto.test" });

      const mockCreated = {
        attributeKey: "switch_type",
        label: "Switch Type",
        valueKind: "enum",
      };

      attributesServiceStubs.createCategoryAttribute.mockResolvedValueOnce({
        success: true,
        value: mockCreated,
      });

      const response = await request(app).post("/commerce/admin/categories/cat_1/attributes").send({
        attributeKey: "switch_type",
        label: "Switch Type",
        valueKind: "enum",
      });

      expect(response.status).toBe(201);
      expect(response.body.data.attribute).toEqual(mockCreated);
    });

    it("returns 200 on PATCH /commerce/admin/category-attributes/:attributeId on success", async () => {
      signInAs({ id: "usr_staff_1", email: "staff@qatoto.test" });

      const mockUpdated = {
        attributeKey: "switch_type",
        label: "New Switch Label",
        isFilterable: true,
      };

      attributesServiceStubs.updateCategoryAttribute.mockResolvedValueOnce({
        success: true,
        value: mockUpdated,
      });

      const response = await request(app)
        .patch("/commerce/admin/category-attributes/attr_1")
        .send({ label: "New Switch Label", isFilterable: true });

      expect(response.status).toBe(200);
      expect(response.body.data.attribute).toEqual(mockUpdated);
    });
  });

  describe("Category Requests Moderation routes", () => {
    it("returns 401 on GET /commerce/admin/category-requests when signed out", async () => {
      const response = await request(app).get("/commerce/admin/category-requests");
      expect(response.status).toBe(401);
    });

    it("returns 422 on GET /commerce/admin/category-requests with invalid state filter", async () => {
      signInAs({ id: "usr_staff_1", email: "staff@qatoto.test" });

      const response = await request(app).get("/commerce/admin/category-requests").query({ state: "unknown_state" });

      expect(response.status).toBe(422);
    });

    it("returns 200 on GET /commerce/admin/category-requests on success", async () => {
      signInAs({ id: "usr_staff_1", email: "staff@qatoto.test" });

      const mockRequests = [{ id: "req_1", proposedName: "Keycaps", state: "pending" }];
      categoriesServiceStubs.listCommerceCategoryRequestsForStaff.mockResolvedValueOnce({
        success: true,
        value: mockRequests,
      });

      const response = await request(app).get("/commerce/admin/category-requests");

      expect(response.status).toBe(200);
      expect(response.body.data.requests).toEqual(mockRequests);
    });

    it("returns 409 on POST /commerce/admin/category-requests/:requestId/decide when already decided", async () => {
      signInAs({ id: "usr_staff_1", email: "staff@qatoto.test" });

      categoriesServiceStubs.decideCommerceCategoryRequest.mockResolvedValueOnce({
        success: false,
        error: { type: "COMMERCE_CATEGORY_REQUEST_ALREADY_DECIDED", state: "approved" },
      });

      const response = await request(app).post("/commerce/admin/category-requests/req_1/decide").send({
        decision: "reject",
        note: "Too late",
      });

      expect(response.status).toBe(409);
      expect(response.body.message).toMatch(/Another moderator already approved this request/);
    });

    it("returns 200 on POST /commerce/admin/category-requests/:requestId/decide on approval", async () => {
      signInAs({ id: "usr_staff_1", email: "staff@qatoto.test" });

      const mockResult = {
        request: { id: "req_1", state: "approved" },
        category: { id: "cat_keycaps", slug: "custom-keycaps" },
      };

      categoriesServiceStubs.decideCommerceCategoryRequest.mockResolvedValueOnce({
        success: true,
        value: mockResult,
      });

      const response = await request(app).post("/commerce/admin/category-requests/req_1/decide").send({
        decision: "approve",
        slug: "custom-keycaps",
      });

      expect(response.status).toBe(200);
      expect(response.body.data.request).toEqual(mockResult.request);
      expect(response.body.data.category).toEqual(mockResult.category);
    });
  });
});
