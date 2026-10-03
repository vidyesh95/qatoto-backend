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

const SELLER_ORGANIZATION_ID = "commerce_org_catalog_test";
const MEMBER_ID = "member_catalog_test";

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

const serviceStubs = vi.hoisted(() => ({
  listRelationsForModeration: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  replaceSellerDeclaredRelations: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  verifyRelation: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  dismissRelation: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

vi.mock("#src/modules/store/catalog/commerce-product-relations.service.js", () => ({
  listRelationsForModeration: serviceStubs.listRelationsForModeration,
  replaceSellerDeclaredRelations: serviceStubs.replaceSellerDeclaredRelations,
  verifyRelation: serviceStubs.verifyRelation,
  dismissRelation: serviceStubs.dismissRelation,
}));

describe("commerce-catalog.routes", () => {
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

  describe("PUT /commerce/products/:productId/relations", () => {
    it("returns 401 when signed out", async () => {
      const response = await request(app)
        .put("/commerce/products/prd_1/relations")
        .set("Idempotency-Key", "idem-rel-1")
        .send({ relations: [] });

      expect(response.status).toBe(401);
    });

    it("returns 400 when Idempotency-Key is missing", async () => {
      signInAs({ id: "usr_seller_1", email: "seller@qatoto.test" });

      const response = await request(app).put("/commerce/products/prd_1/relations").send({ relations: [] });

      expect(response.status).toBe(400);
      expect(response.body.message).toMatch(/Idempotency-Key/);
    });

    it("returns 422 when query parameters are passed", async () => {
      signInAs({ id: "usr_seller_1", email: "seller@qatoto.test" });

      const response = await request(app)
        .put("/commerce/products/prd_1/relations?unexpected=1")
        .set("Idempotency-Key", "idem-rel-query")
        .send({ relations: [] });

      expect(response.status).toBe(422);
    });

    it("returns 422 when body contains invalid relation kind or extra fields", async () => {
      signInAs({ id: "usr_seller_1", email: "seller@qatoto.test" });

      const response = await request(app)
        .put("/commerce/products/prd_1/relations")
        .set("Idempotency-Key", "idem-rel-bad-body")
        .send({
          relations: [{ toProductId: "prd_2", relationKind: "not_a_valid_kind" }],
        });

      expect(response.status).toBe(422);
    });

    it("returns 422 when service reports SELF_RELATION", async () => {
      signInAs({ id: "usr_seller_1", email: "seller@qatoto.test" });

      serviceStubs.replaceSellerDeclaredRelations.mockResolvedValueOnce({
        success: false,
        error: { type: "SELF_RELATION" },
      });

      const response = await request(app)
        .put("/commerce/products/prd_1/relations")
        .set("Idempotency-Key", "idem-rel-self")
        .send({
          relations: [{ toProductId: "prd_1", relationKind: "accessory_of" }],
        });

      expect(response.status).toBe(422);
      expect(response.body.message).toBe("A product cannot relate to itself.");
    });

    it("returns 422 when service reports INVALID_TARGET", async () => {
      signInAs({ id: "usr_seller_1", email: "seller@qatoto.test" });

      serviceStubs.replaceSellerDeclaredRelations.mockResolvedValueOnce({
        success: false,
        error: { type: "INVALID_TARGET", productIds: ["prd_ghost"] },
      });

      const response = await request(app)
        .put("/commerce/products/prd_1/relations")
        .set("Idempotency-Key", "idem-rel-invalid-target")
        .send({
          relations: [{ toProductId: "prd_ghost", relationKind: "accessory_of" }],
        });

      expect(response.status).toBe(422);
      expect(response.body.data.productIds).toEqual(["prd_ghost"]);
    });

    it("returns 409 when service reports RELATION_ALREADY_CURATED", async () => {
      signInAs({ id: "usr_seller_1", email: "seller@qatoto.test" });

      serviceStubs.replaceSellerDeclaredRelations.mockResolvedValueOnce({
        success: false,
        error: { type: "RELATION_ALREADY_CURATED" },
      });

      const response = await request(app)
        .put("/commerce/products/prd_1/relations")
        .set("Idempotency-Key", "idem-rel-curated")
        .send({
          relations: [{ toProductId: "prd_2", relationKind: "accessory_of" }],
        });

      expect(response.status).toBe(409);
      expect(response.body.message).toMatch(/already confirmed one of these related products/);
    });

    it("returns 409 when service reports RELATION_DISMISSED", async () => {
      signInAs({ id: "usr_seller_1", email: "seller@qatoto.test" });

      serviceStubs.replaceSellerDeclaredRelations.mockResolvedValueOnce({
        success: false,
        error: { type: "RELATION_DISMISSED", productIds: ["prd_2"] },
      });

      const response = await request(app)
        .put("/commerce/products/prd_1/relations")
        .set("Idempotency-Key", "idem-rel-dismissed")
        .send({
          relations: [{ toProductId: "prd_2", relationKind: "accessory_of" }],
        });

      expect(response.status).toBe(409);
      expect(response.body.data.productIds).toEqual(["prd_2"]);
    });

    it("returns 404 when service reports NOT_FOUND", async () => {
      signInAs({ id: "usr_seller_1", email: "seller@qatoto.test" });

      serviceStubs.replaceSellerDeclaredRelations.mockResolvedValueOnce({
        success: false,
        error: { type: "NOT_FOUND" },
      });

      const response = await request(app)
        .put("/commerce/products/prd_not_mine/relations")
        .set("Idempotency-Key", "idem-rel-not-found")
        .send({ relations: [] });

      expect(response.status).toBe(404);
    });

    it("returns 200 and updates relations successfully", async () => {
      signInAs({ id: "usr_seller_1", email: "seller@qatoto.test" });

      const mockRelations = [
        {
          relationId: "rel_123",
          fromProductId: "prd_1",
          toProductId: "prd_2",
          relationKind: "accessory_of",
          sourceKind: "seller_declared",
          rank: 0,
        },
      ];

      serviceStubs.replaceSellerDeclaredRelations.mockResolvedValueOnce({
        success: true,
        value: mockRelations,
      });

      const response = await request(app)
        .put("/commerce/products/prd_1/relations")
        .set("Idempotency-Key", "idem-rel-success")
        .send({
          relations: [{ toProductId: "prd_2", relationKind: "accessory_of" }],
        });

      expect(response.status).toBe(200);
      expect(response.body.data.relations).toEqual(mockRelations);
    });
  });

  describe("GET /commerce/admin/product-relations", () => {
    it("returns 401 when signed out", async () => {
      const response = await request(app).get("/commerce/admin/product-relations");
      expect(response.status).toBe(401);
    });

    it("returns 422 when invalid query parameters are passed", async () => {
      signInAs({ id: "usr_mod_1", email: "mod@qatoto.test" });

      const response = await request(app).get("/commerce/admin/product-relations").query({ limit: 100 }); // limit max is 50

      expect(response.status).toBe(422);
    });

    it("returns 403 when user lacks moderate_commerce capability", async () => {
      signInAs({ id: "usr_regular", email: "user@qatoto.test" });

      serviceStubs.listRelationsForModeration.mockResolvedValueOnce({
        success: false,
        error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_commerce" },
      });

      const response = await request(app).get("/commerce/admin/product-relations");

      expect(response.status).toBe(403);
      expect(response.body.message).toBe("Moderator capability required.");
    });

    it("returns 422 when invalid cursor is given", async () => {
      signInAs({ id: "usr_mod_1", email: "mod@qatoto.test" });

      serviceStubs.listRelationsForModeration.mockResolvedValueOnce({
        success: false,
        error: { type: "INVALID_CURSOR" },
      });

      const response = await request(app).get("/commerce/admin/product-relations").query({ cursor: "corrupted_token" });

      expect(response.status).toBe(422);
      expect(response.body.message).toBe("Invalid cursor.");
    });

    it("returns 200 with list of relations for moderation", async () => {
      signInAs({ id: "usr_mod_1", email: "mod@qatoto.test" });

      const mockPayload = {
        items: [
          {
            relationId: "rel_mod_1",
            fromProductId: "prd_1",
            toProductId: "prd_2",
            relationKind: "accessory_of",
            sourceKind: "seller_declared",
          },
        ],
        page: { nextCursor: null, hasMore: false },
      };

      serviceStubs.listRelationsForModeration.mockResolvedValueOnce({
        success: true,
        value: mockPayload,
      });

      const response = await request(app).get("/commerce/admin/product-relations").query({ limit: 10 });

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(mockPayload);
    });
  });

  describe("POST /commerce/admin/product-relations/:relationId/dismiss", () => {
    it("returns 401 when signed out", async () => {
      const response = await request(app)
        .post("/commerce/admin/product-relations/rel_1/dismiss")
        .set("Idempotency-Key", "idem-dismiss-1");

      expect(response.status).toBe(401);
    });

    it("returns 400 when Idempotency-Key is missing", async () => {
      signInAs({ id: "usr_mod_1", email: "mod@qatoto.test" });

      const response = await request(app).post("/commerce/admin/product-relations/rel_1/dismiss");

      expect(response.status).toBe(400);
    });

    it("returns 403 when user belongs to selling organization", async () => {
      signInAs({ id: "usr_mod_seller", email: "mod@seller.test" });

      serviceStubs.dismissRelation.mockResolvedValueOnce({
        success: false,
        error: { type: "SELF_MODERATION_FORBIDDEN" },
      });

      const response = await request(app)
        .post("/commerce/admin/product-relations/rel_1/dismiss")
        .set("Idempotency-Key", "idem-dismiss-self");

      expect(response.status).toBe(403);
      expect(response.body.message).toMatch(/A member of the selling organization cannot moderate its own claim/);
    });

    it("returns 404 when relation is not found", async () => {
      signInAs({ id: "usr_mod_1", email: "mod@qatoto.test" });

      serviceStubs.dismissRelation.mockResolvedValueOnce({
        success: false,
        error: { type: "NOT_FOUND" },
      });

      const response = await request(app)
        .post("/commerce/admin/product-relations/rel_unknown/dismiss")
        .set("Idempotency-Key", "idem-dismiss-not-found");

      expect(response.status).toBe(404);
    });

    it("returns 200 when dismissed successfully", async () => {
      signInAs({ id: "usr_mod_1", email: "mod@qatoto.test" });

      const mockDismissed = {
        relationId: "rel_1",
        dismissed: true,
      };

      serviceStubs.dismissRelation.mockResolvedValueOnce({
        success: true,
        value: mockDismissed,
      });

      const response = await request(app)
        .post("/commerce/admin/product-relations/rel_1/dismiss")
        .set("Idempotency-Key", "idem-dismiss-ok");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(mockDismissed);
    });
  });

  describe("POST /commerce/admin/product-relations/:relationId/verify", () => {
    it("returns 401 when signed out", async () => {
      const response = await request(app)
        .post("/commerce/admin/product-relations/rel_1/verify")
        .set("Idempotency-Key", "idem-verify-1");

      expect(response.status).toBe(401);
    });

    it("returns 400 when Idempotency-Key is missing", async () => {
      signInAs({ id: "usr_mod_1", email: "mod@qatoto.test" });

      const response = await request(app).post("/commerce/admin/product-relations/rel_1/verify");

      expect(response.status).toBe(400);
    });

    it("returns 409 when relation is ALREADY_VERIFIED", async () => {
      signInAs({ id: "usr_mod_1", email: "mod@qatoto.test" });

      serviceStubs.verifyRelation.mockResolvedValueOnce({
        success: false,
        error: { type: "ALREADY_VERIFIED" },
      });

      const response = await request(app)
        .post("/commerce/admin/product-relations/rel_1/verify")
        .set("Idempotency-Key", "idem-verify-dup");

      expect(response.status).toBe(409);
      expect(response.body.message).toBe("This relation is already verified.");
    });

    it("returns 200 when relation is verified successfully", async () => {
      signInAs({ id: "usr_mod_1", email: "mod@qatoto.test" });

      const mockVerified = {
        relationId: "rel_1",
        fromProductId: "prd_1",
        toProductId: "prd_2",
        sourceKind: "moderator_curated",
      };

      serviceStubs.verifyRelation.mockResolvedValueOnce({
        success: true,
        value: mockVerified,
      });

      const response = await request(app)
        .post("/commerce/admin/product-relations/rel_1/verify")
        .set("Idempotency-Key", "idem-verify-ok");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(mockVerified);
    });
  });
});
