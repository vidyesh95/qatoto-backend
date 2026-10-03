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

const SELLER_ORGANIZATION_ID = "org_ranking_test";
const MEMBER_ID = "member_ranking_test";

const idempotencyCache = vi.hoisted(() => new Map<string, { statusCode: number; body: unknown }>());

vi.mock("#src/middleware/idempotency.js", () => ({
  idempotency:
    (options: { readonly required?: boolean } = {}) =>
    (req: Request, res: Response, next: NextFunction): void => {
      const key = req.header("Idempotency-Key");
      if (!key) {
        if (options.required === true) {
          res.status(400).json({
            status: "error",
            statusCode: 400,
            message: "This request requires an Idempotency-Key header.",
          });
          return;
        }
        next();
        return;
      }
      const cached = idempotencyCache.get(key);
      if (cached) {
        res.setHeader("Idempotency-Replayed", "true");
        res.status(cached.statusCode).json(cached.body);
        return;
      }
      const originalJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          idempotencyCache.set(key, { statusCode: res.statusCode, body });
        }
        return originalJson(body);
      }) as typeof res.json;
      next();
    },
}));

function attachSellerOrganization(req: Request, _res: Response, next: NextFunction): void {
  req.commerceOrganization = {
    organizationId: SELLER_ORGANIZATION_ID,
    memberId: MEMBER_ID,
    memberRole: "seller",
    tradeState: "active",
  };
  next();
}

vi.mock("#src/modules/store/organizations/require-active-commerce-organization.js", () => ({
  attachOptionalSellerCommerceOrganization: (req: Request, res: Response, next: NextFunction): void => {
    attachSellerOrganization(req, res, next);
  },
  requireActiveCommerceOrganization: attachSellerOrganization,
  requireActiveBuyerCommerceOrganization: attachSellerOrganization,
  requireActiveProviderCommerceOrganization: attachSellerOrganization,
  requireActiveSellerCommerceOrganization: attachSellerOrganization,
  requireProvisionedBuyerCommerceWorkspace: (req: Request, _res: Response, next: NextFunction): void => {
    req.buyerCommerceWorkspace = {
      organizationId: SELLER_ORGANIZATION_ID,
      memberId: MEMBER_ID,
      memberRole: "seller",
      tradeState: "active",
    };
    next();
  },
}));

const rankingServiceStubs = vi.hoisted(() => ({
  getProductRankingStatus: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  moderateProductRanking: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

vi.mock("#src/modules/store/catalog/commerce-ranking.service.js", () => ({
  getProductRankingStatus: rankingServiceStubs.getProductRankingStatus,
  moderateProductRanking: rankingServiceStubs.moderateProductRanking,
}));

describe("commerce-ranking.routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    idempotencyCache.clear();
    await resetRateLimiters();
    signOut();
  });

  describe("GET /commerce/products/:productId/ranking-status", () => {
    it("returns 401 when signed out", async () => {
      const response = await request(app).get("/commerce/products/prd_1/ranking-status");
      expect(response.status).toBe(401);
    });

    it("returns 422 when unexpected query is provided", async () => {
      signInAs({ id: "usr_seller_1", email: "seller@qatoto.test" });

      const response = await request(app).get("/commerce/products/prd_1/ranking-status").query({ extra: "bad" });

      expect(response.status).toBe(422);
    });

    it("returns 404 when product is NOT_FOUND or NOT_AUTHORIZED", async () => {
      signInAs({ id: "usr_seller_1", email: "seller@qatoto.test" });

      rankingServiceStubs.getProductRankingStatus.mockResolvedValueOnce({
        success: false,
        error: { type: "NOT_FOUND" },
      });

      const response = await request(app).get("/commerce/products/prd_unknown/ranking-status");
      expect(response.status).toBe(404);
      expect(response.body.message).toBe("Product not found.");
    });

    it("returns 200 with ranking status on success", async () => {
      signInAs({ id: "usr_seller_1", email: "seller@qatoto.test" });

      const mockStatus = {
        productId: "prd_1",
        isSuppressed: false,
        suppressionReason: null,
      };

      rankingServiceStubs.getProductRankingStatus.mockResolvedValueOnce({
        success: true,
        value: mockStatus,
      });

      const response = await request(app).get("/commerce/products/prd_1/ranking-status");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(mockStatus);
    });
  });

  describe("POST /commerce/admin/products/:productId/ranking-enforcement", () => {
    it("returns 401 when signed out", async () => {
      const response = await request(app)
        .post("/commerce/admin/products/prd_1/ranking-enforcement")
        .set("Idempotency-Key", "idem-rank-1")
        .send({ action: "capped", reason: "Excessive returns" });

      expect(response.status).toBe(401);
    });

    it("returns 400 when Idempotency-Key is missing", async () => {
      signInAs({ id: "usr_mod_1", email: "mod@qatoto.test" });

      const response = await request(app)
        .post("/commerce/admin/products/prd_1/ranking-enforcement")
        .send({ action: "capped", reason: "Excessive returns" });

      expect(response.status).toBe(400);
    });

    it("returns 422 on invalid body", async () => {
      signInAs({ id: "usr_mod_1", email: "mod@qatoto.test" });

      const response = await request(app)
        .post("/commerce/admin/products/prd_1/ranking-enforcement")
        .set("Idempotency-Key", "idem-rank-bad")
        .send({ action: "invalid_action", reason: "no" });

      expect(response.status).toBe(422);
    });

    it("returns 403 when user lacks moderate_commerce capability", async () => {
      signInAs({ id: "usr_regular", email: "reg@qatoto.test" });

      rankingServiceStubs.moderateProductRanking.mockResolvedValueOnce({
        success: false,
        error: { type: "PLATFORM_CAPABILITY_REQUIRED" },
      });

      const response = await request(app)
        .post("/commerce/admin/products/prd_1/ranking-enforcement")
        .set("Idempotency-Key", "idem-rank-nocap")
        .send({ action: "capped", reason: "Excessive returns" });

      expect(response.status).toBe(403);
      expect(response.body.message).toBe("Moderator capability required.");
    });

    it("returns 404 when product is not found", async () => {
      signInAs({ id: "usr_mod_1", email: "mod@qatoto.test" });

      rankingServiceStubs.moderateProductRanking.mockResolvedValueOnce({
        success: false,
        error: { type: "NOT_FOUND" },
      });

      const response = await request(app)
        .post("/commerce/admin/products/prd_ghost/ranking-enforcement")
        .set("Idempotency-Key", "idem-rank-notfound")
        .send({ action: "capped", reason: "Excessive returns" });

      expect(response.status).toBe(404);
    });

    it("returns 200 and records enforcement on success", async () => {
      signInAs({ id: "usr_mod_1", email: "mod@qatoto.test" });

      const mockEnforcement = {
        productId: "prd_1",
        action: "capped",
        reason: "Excessive returns",
      };

      rankingServiceStubs.moderateProductRanking.mockResolvedValueOnce({
        success: true,
        value: mockEnforcement,
      });

      const response = await request(app)
        .post("/commerce/admin/products/prd_1/ranking-enforcement")
        .set("Idempotency-Key", "idem-rank-ok")
        .send({ action: "capped", reason: "Excessive returns" });

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(mockEnforcement);
    });
  });
});
