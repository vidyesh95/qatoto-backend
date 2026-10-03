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

const engagementServiceStubs = vi.hoisted(() => ({
  setProductEngagement: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  clearProductEngagement: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  recordProductShare: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  listBookmarkedProductIds: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

vi.mock("#src/modules/store/catalog/commerce-product-engagement.service.js", () => ({
  setProductEngagement: engagementServiceStubs.setProductEngagement,
  clearProductEngagement: engagementServiceStubs.clearProductEngagement,
  recordProductShare: engagementServiceStubs.recordProductShare,
  listBookmarkedProductIds: engagementServiceStubs.listBookmarkedProductIds,
}));

const viewServiceStubs = vi.hoisted(() => ({
  recordProductViewBeacon: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

vi.mock("#src/modules/store/catalog/commerce-product-view.service.js", () => ({
  recordProductViewBeacon: viewServiceStubs.recordProductViewBeacon,
}));

const catalogServiceStubs = vi.hoisted(() => ({
  resolveEligibleProductRefBySlug: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  resolveEligibleProductCardsByIds: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

vi.mock("#src/modules/store/catalog/store-catalog.service.js", () => ({
  resolveEligibleProductRefBySlug: catalogServiceStubs.resolveEligibleProductRefBySlug,
  resolveEligibleProductCardsByIds: catalogServiceStubs.resolveEligibleProductCardsByIds,
}));

describe("commerce-product-engagement.routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await resetRateLimiters();
    signOut();
  });

  describe("PUT /store/products/:productSlug/like", () => {
    it("returns 401 when signed out", async () => {
      const response = await request(app).put("/store/products/switch-pro/like");
      expect(response.status).toBe(401);
    });

    it("returns 422 when unexpected query parameters are present", async () => {
      signInAs({ id: "usr_buyer_1", email: "buyer@qatoto.test" });

      const response = await request(app).put("/store/products/switch-pro/like?extra=1");
      expect(response.status).toBe(422);
    });

    it("returns 404 when product slug is unknown or not eligible", async () => {
      signInAs({ id: "usr_buyer_1", email: "buyer@qatoto.test" });
      catalogServiceStubs.resolveEligibleProductRefBySlug.mockResolvedValueOnce(null);

      const response = await request(app).put("/store/products/ghost-product/like");

      expect(response.status).toBe(404);
      expect(response.body.message).toBe("Product not found.");
    });

    it("returns 200 on successful like", async () => {
      signInAs({ id: "usr_buyer_1", email: "buyer@qatoto.test" });
      catalogServiceStubs.resolveEligibleProductRefBySlug.mockResolvedValueOnce({
        id: "prd_123",
        slug: "switch-pro",
      });

      const mockEngagement = {
        isLiked: true,
        likeCount: 42,
      };
      engagementServiceStubs.setProductEngagement.mockResolvedValueOnce(mockEngagement);

      const response = await request(app).put("/store/products/switch-pro/like");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(mockEngagement);
    });
  });

  describe("DELETE /store/products/:productSlug/like", () => {
    it("returns 401 when signed out", async () => {
      const response = await request(app).delete("/store/products/switch-pro/like");
      expect(response.status).toBe(401);
    });

    it("returns 404 when product is not found", async () => {
      signInAs({ id: "usr_buyer_1", email: "buyer@qatoto.test" });
      catalogServiceStubs.resolveEligibleProductRefBySlug.mockResolvedValueOnce(null);

      const response = await request(app).delete("/store/products/unknown/like");
      expect(response.status).toBe(404);
    });

    it("returns 200 on successful like clearance", async () => {
      signInAs({ id: "usr_buyer_1", email: "buyer@qatoto.test" });
      catalogServiceStubs.resolveEligibleProductRefBySlug.mockResolvedValueOnce({
        id: "prd_123",
        slug: "switch-pro",
      });

      const mockEngagement = {
        isLiked: false,
        likeCount: 41,
      };
      engagementServiceStubs.clearProductEngagement.mockResolvedValueOnce(mockEngagement);

      const response = await request(app).delete("/store/products/switch-pro/like");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(mockEngagement);
    });
  });

  describe("PUT /store/products/:productSlug/bookmark", () => {
    it("returns 401 when signed out", async () => {
      const response = await request(app).put("/store/products/switch-pro/bookmark");
      expect(response.status).toBe(401);
    });

    it("returns 200 on successful bookmark", async () => {
      signInAs({ id: "usr_buyer_1", email: "buyer@qatoto.test" });
      catalogServiceStubs.resolveEligibleProductRefBySlug.mockResolvedValueOnce({
        id: "prd_123",
        slug: "switch-pro",
      });

      const mockEngagement = {
        isBookmarked: true,
        bookmarkCount: 15,
      };
      engagementServiceStubs.setProductEngagement.mockResolvedValueOnce(mockEngagement);

      const response = await request(app).put("/store/products/switch-pro/bookmark");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(mockEngagement);
    });
  });

  describe("DELETE /store/products/:productSlug/bookmark", () => {
    it("returns 401 when signed out", async () => {
      const response = await request(app).delete("/store/products/switch-pro/bookmark");
      expect(response.status).toBe(401);
    });

    it("returns 200 on successful bookmark removal", async () => {
      signInAs({ id: "usr_buyer_1", email: "buyer@qatoto.test" });
      catalogServiceStubs.resolveEligibleProductRefBySlug.mockResolvedValueOnce({
        id: "prd_123",
        slug: "switch-pro",
      });

      const mockEngagement = {
        isBookmarked: false,
        bookmarkCount: 14,
      };
      engagementServiceStubs.clearProductEngagement.mockResolvedValueOnce(mockEngagement);

      const response = await request(app).delete("/store/products/switch-pro/bookmark");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(mockEngagement);
    });
  });

  describe("POST /store/products/:productSlug/share", () => {
    it("accepts anonymous visitor and records share", async () => {
      catalogServiceStubs.resolveEligibleProductRefBySlug.mockResolvedValueOnce({
        id: "prd_123",
        slug: "switch-pro",
      });

      const mockEngagement = {
        shareCount: 10,
      };
      engagementServiceStubs.recordProductShare.mockResolvedValueOnce(mockEngagement);

      const response = await request(app).post("/store/products/switch-pro/share");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(mockEngagement);
    });

    it("records share for signed-in user", async () => {
      signInAs({ id: "usr_buyer_1", email: "buyer@qatoto.test" });
      catalogServiceStubs.resolveEligibleProductRefBySlug.mockResolvedValueOnce({
        id: "prd_123",
        slug: "switch-pro",
      });

      const mockEngagement = {
        shareCount: 11,
      };
      engagementServiceStubs.recordProductShare.mockResolvedValueOnce(mockEngagement);

      const response = await request(app).post("/store/products/switch-pro/share");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(mockEngagement);
    });

    it("returns 404 when product is not found", async () => {
      catalogServiceStubs.resolveEligibleProductRefBySlug.mockResolvedValueOnce(null);

      const response = await request(app).post("/store/products/unknown/share");
      expect(response.status).toBe(404);
    });
  });

  describe("POST /store/products/:productSlug/view-beacon", () => {
    it("returns 422 on invalid dwellSeconds", async () => {
      const response = await request(app).post("/store/products/switch-pro/view-beacon").send({ dwellSeconds: -5 });

      expect(response.status).toBe(422);
    });

    it("returns 404 when product is not found", async () => {
      catalogServiceStubs.resolveEligibleProductRefBySlug.mockResolvedValueOnce(null);

      const response = await request(app).post("/store/products/unknown/view-beacon").send({ dwellSeconds: 20 });

      expect(response.status).toBe(404);
    });

    it("records view beacon successfully for anonymous user", async () => {
      catalogServiceStubs.resolveEligibleProductRefBySlug.mockResolvedValueOnce({
        id: "prd_123",
        slug: "switch-pro",
      });

      const mockBeacon = {
        recordedDwellSeconds: 20,
        viewSource: "product_detail",
      };
      viewServiceStubs.recordProductViewBeacon.mockResolvedValueOnce(mockBeacon);

      const response = await request(app)
        .post("/store/products/switch-pro/view-beacon")
        .send({ dwellSeconds: 20, viewSource: "product_detail" });

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(mockBeacon);
    });
  });

  describe("GET /commerce/bookmarked-products", () => {
    it("returns 401 when signed out", async () => {
      const response = await request(app).get("/commerce/bookmarked-products");
      expect(response.status).toBe(401);
    });

    it("returns 422 on invalid query parameter (e.g. deprecated kind)", async () => {
      signInAs({ id: "usr_buyer_1", email: "buyer@qatoto.test" });

      const response = await request(app).get("/commerce/bookmarked-products").query({ kind: "liked" });

      expect(response.status).toBe(422);
    });

    it("returns 422 when cursor is invalid", async () => {
      signInAs({ id: "usr_buyer_1", email: "buyer@qatoto.test" });

      engagementServiceStubs.listBookmarkedProductIds.mockResolvedValueOnce({
        success: false,
        error: { type: "INVALID_CURSOR" },
      });

      const response = await request(app).get("/commerce/bookmarked-products").query({ cursor: "bad_cursor" });

      expect(response.status).toBe(422);
      expect(response.body.message).toBe("Invalid cursor.");
    });

    it("returns 200 with resolved product cards on success", async () => {
      signInAs({ id: "usr_buyer_1", email: "buyer@qatoto.test" });

      engagementServiceStubs.listBookmarkedProductIds.mockResolvedValueOnce({
        success: true,
        value: {
          productIds: ["prd_1"],
          page: { nextCursor: null, hasMore: false },
        },
      });

      const mockCards = [
        {
          id: "prd_1",
          title: "Mechanical Keyboard",
          slug: "mechanical-keyboard",
          price: 15000,
        },
      ];
      catalogServiceStubs.resolveEligibleProductCardsByIds.mockResolvedValueOnce(mockCards);

      const response = await request(app).get("/commerce/bookmarked-products");

      expect(response.status).toBe(200);
      expect(response.body.data.items).toEqual(mockCards);
      expect(response.body.data.page).toEqual({ nextCursor: null, hasMore: false });
    });
  });
});
