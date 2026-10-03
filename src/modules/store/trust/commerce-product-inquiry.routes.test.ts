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
  requireIdentifiedUser: (_req: Request, _res: Response, next: NextFunction): void => next(),
  isIdentifiedUser: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
}));

const BUYER_ORG_ID = "org_buyer_test_123";
const BUYER_MEMBER_ID = "mem_buyer_test_456";

function attachBuyerCommerceWorkspace(req: Request, _res: Response, next: NextFunction): void {
  req.buyerCommerceWorkspace = {
    organizationId: BUYER_ORG_ID,
    memberId: BUYER_MEMBER_ID,
    memberRole: "buyer",
    tradeState: "active",
  };
  next();
}

vi.mock("#src/modules/store/organizations/require-active-commerce-organization.js", () => ({
  attachOptionalSellerCommerceOrganization: attachBuyerCommerceWorkspace,
  requireActiveCommerceOrganization: attachBuyerCommerceWorkspace,
  requireActiveBuyerCommerceOrganization: attachBuyerCommerceWorkspace,
  requireActiveProviderCommerceOrganization: attachBuyerCommerceWorkspace,
  requireActiveSellerCommerceOrganization: attachBuyerCommerceWorkspace,
  requireProvisionedBuyerCommerceWorkspace: attachBuyerCommerceWorkspace,
}));

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

const mockProductCatalog = vi.hoisted(() => ({
  resolveEligibleProductRefById: vi.fn<(...args: readonly unknown[]) => unknown>(),
}));

vi.mock("#src/modules/store/catalog/store-catalog.service.js", () => mockProductCatalog);

const mockInquiryService = vi.hoisted(() => ({
  createOrGetProductInquiry: vi.fn<(...args: readonly unknown[]) => unknown>(),
  listProductInquiries: vi.fn<(...args: readonly unknown[]) => unknown>(),
}));

vi.mock("#src/modules/store/trust/commerce-product-inquiry.service.js", () => mockInquiryService);

describe("commerce-product-inquiry.routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    idempotencyCache.clear();
    await resetRateLimiters();
    vi.clearAllMocks();
  });

  describe("POST /commerce/products/:productId/inquiries", () => {
    it("refuses unauthenticated callers with 401", async () => {
      signOut();
      const response = await request(app)
        .post("/commerce/products/prod_1/inquiries")
        .set("Idempotency-Key", "idemp_test_1");

      expect(response.status).toBe(401);
      expect(response.body.status).toBe("error");
    });

    it("requires Idempotency-Key header with 400", async () => {
      signInAs({ id: "user_buyer_1" });
      const response = await request(app).post("/commerce/products/prod_1/inquiries");

      expect(response.status).toBe(400);
      expect(response.body.message).toContain("Idempotency-Key");
    });

    it("rejects unknown query parameters with 422 (EmptyObjectSchema strict)", async () => {
      signInAs({ id: "user_buyer_1" });
      const response = await request(app)
        .post("/commerce/products/prod_1/inquiries?extra=unexpected")
        .set("Idempotency-Key", "idemp_test_query");

      expect(response.status).toBe(422);
      expect(response.body.status).toBe("error");
    });

    it("returns 404 when product is not found in catalog", async () => {
      signInAs({ id: "user_buyer_1" });
      mockProductCatalog.resolveEligibleProductRefById.mockResolvedValueOnce(null);

      const response = await request(app)
        .post("/commerce/products/prod_missing/inquiries")
        .set("Idempotency-Key", "idemp_test_missing");

      expect(response.status).toBe(404);
      expect(response.body.message).toBe("Product not found.");
      expect(mockProductCatalog.resolveEligibleProductRefById).toHaveBeenCalledWith("prod_missing");
    });

    it("returns 422 if caller attempts self-inquiry on own product listing", async () => {
      signInAs({ id: "user_buyer_1" });
      mockProductCatalog.resolveEligibleProductRefById.mockResolvedValueOnce({
        id: "prod_own",
        sellerOrganizationId: BUYER_ORG_ID,
      });
      mockInquiryService.createOrGetProductInquiry.mockResolvedValueOnce({
        success: false,
        error: { type: "SELF_INQUIRY_FORBIDDEN" },
      });

      const response = await request(app)
        .post("/commerce/products/prod_own/inquiries")
        .set("Idempotency-Key", "idemp_self");

      expect(response.status).toBe(422);
      expect(response.body.message).toContain("cannot open an inquiry on your own listing");
    });

    it("returns 403 if forbidden by policy", async () => {
      signInAs({ id: "user_buyer_1" });
      mockProductCatalog.resolveEligibleProductRefById.mockResolvedValueOnce({
        id: "prod_forbidden",
        sellerOrganizationId: "org_other_seller",
      });
      mockInquiryService.createOrGetProductInquiry.mockResolvedValueOnce({
        success: false,
        error: { type: "FORBIDDEN" },
      });

      const response = await request(app)
        .post("/commerce/products/prod_forbidden/inquiries")
        .set("Idempotency-Key", "idemp_forbidden");

      expect(response.status).toBe(403);
    });

    it("creates/retrieves inquiry successfully with 201", async () => {
      signInAs({ id: "user_buyer_1" });
      mockProductCatalog.resolveEligibleProductRefById.mockResolvedValueOnce({
        id: "prod_valid_1",
        sellerOrganizationId: "org_seller_999",
      });
      const expectedInquiry = {
        id: "inq_123",
        productId: "prod_valid_1",
        buyerOrganizationId: BUYER_ORG_ID,
        sellerOrganizationId: "org_seller_999",
        convertedToRfqId: null,
        createdAt: new Date().toISOString(),
        thread: { id: "thr_123", subject: "Product inquiry" },
      };
      mockInquiryService.createOrGetProductInquiry.mockResolvedValueOnce({
        success: true,
        value: expectedInquiry,
      });

      const response = await request(app)
        .post("/commerce/products/prod_valid_1/inquiries")
        .set("Idempotency-Key", "idemp_create_success");

      expect(response.status).toBe(201);
      expect(response.body.status).toBe("success");
      expect(response.body.message).toBe("Inquiry opened.");
      expect(response.body.data.id).toBe("inq_123");
      expect(mockInquiryService.createOrGetProductInquiry).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: BUYER_ORG_ID,
          memberId: BUYER_MEMBER_ID,
          memberRole: "buyer",
          actorUserId: "user_buyer_1",
        }),
        {
          productId: "prod_valid_1",
          sellerOrganizationId: "org_seller_999",
        },
      );
    });

    it("replays response when same Idempotency-Key is provided", async () => {
      signInAs({ id: "user_buyer_1" });
      mockProductCatalog.resolveEligibleProductRefById.mockResolvedValueOnce({
        id: "prod_valid_1",
        sellerOrganizationId: "org_seller_999",
      });
      mockInquiryService.createOrGetProductInquiry.mockResolvedValueOnce({
        success: true,
        value: { id: "inq_replayed", productId: "prod_valid_1" },
      });

      const firstResponse = await request(app)
        .post("/commerce/products/prod_valid_1/inquiries")
        .set("Idempotency-Key", "idemp_replay_token");

      expect(firstResponse.status).toBe(201);

      const replayResponse = await request(app)
        .post("/commerce/products/prod_valid_1/inquiries")
        .set("Idempotency-Key", "idemp_replay_token");

      expect(replayResponse.status).toBe(201);
      expect(replayResponse.headers["idempotency-replayed"]).toBe("true");
      expect(replayResponse.body.data.id).toBe("inq_replayed");
      expect(mockInquiryService.createOrGetProductInquiry).toHaveBeenCalledTimes(1);
    });
  });

  describe("GET /commerce/inquiries", () => {
    it("refuses unauthenticated callers with 401", async () => {
      signOut();
      const response = await request(app).get("/commerce/inquiries");
      expect(response.status).toBe(401);
    });

    it("rejects invalid query parameters with 422", async () => {
      signInAs({ id: "user_buyer_1" });
      const response = await request(app).get("/commerce/inquiries?limit=999");
      expect(response.status).toBe(422);
      expect(response.body.status).toBe("error");
    });

    it("rejects invalid cursor with 422 if service returns INVALID_CURSOR", async () => {
      signInAs({ id: "user_buyer_1" });
      mockInquiryService.listProductInquiries.mockResolvedValueOnce({
        success: false,
        error: { type: "INVALID_CURSOR" },
      });

      const response = await request(app).get("/commerce/inquiries?cursor=corrupt_cursor");
      expect(response.status).toBe(422);
      expect(response.body.message).toBe("Invalid cursor.");
    });

    it("returns list of inquiries with 200 on success", async () => {
      signInAs({ id: "user_buyer_1" });
      const mockResult = {
        items: [
          {
            id: "inq_item_1",
            productId: "prod_1",
            buyerOrganizationId: BUYER_ORG_ID,
            sellerOrganizationId: "org_seller_1",
            convertedToRfqId: null,
            createdAt: new Date().toISOString(),
            thread: null,
          },
        ],
        nextCursor: "cursor_next_token",
      };
      mockInquiryService.listProductInquiries.mockResolvedValueOnce({
        success: true,
        value: mockResult,
      });

      const response = await request(app).get("/commerce/inquiries?side=buyer&limit=10");

      expect(response.status).toBe(200);
      expect(response.body.status).toBe("success");
      expect(response.body.message).toBe("Product inquiries.");
      expect(response.body.data.items).toHaveLength(1);
      expect(response.body.data.nextCursor).toBe("cursor_next_token");
      expect(mockInquiryService.listProductInquiries).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: BUYER_ORG_ID,
        }),
        {
          side: "buyer",
          limit: 10,
          cursor: undefined,
        },
      );
    });
  });
});
