import type { Express, NextFunction, Request, Response } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs } from "#src/test-support/auth-mock.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

const BUYER_ORGANIZATION_ID = "commerce_org_buyer_trust";
const MEMBER_ID = "member-buyer-trust";

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

vi.mock("#src/middleware/require-active-commerce-organization.js", () => ({
  requireActiveCommerceOrganization: (req: Request, _res: Response, next: NextFunction): void => {
    req.commerceOrganization = {
      organizationId: BUYER_ORGANIZATION_ID,
      memberId: MEMBER_ID,
      memberRole: "buyer",
      tradeState: "active",
    };
    next();
  },
  requireActiveBuyerCommerceOrganization: (req: Request, _res: Response, next: NextFunction): void => {
    req.commerceOrganization = {
      organizationId: BUYER_ORGANIZATION_ID,
      memberId: MEMBER_ID,
      memberRole: "buyer",
      tradeState: "active",
    };
    next();
  },
  requireActiveProviderCommerceOrganization: (req: Request, _res: Response, next: NextFunction): void => {
    req.commerceOrganization = {
      organizationId: BUYER_ORGANIZATION_ID,
      memberId: MEMBER_ID,
      memberRole: "provider_operator",
      tradeState: "active",
    };
    next();
  },
  requireActiveSellerCommerceOrganization: (req: Request, _res: Response, next: NextFunction): void => {
    req.commerceOrganization = {
      organizationId: BUYER_ORGANIZATION_ID,
      memberId: MEMBER_ID,
      memberRole: "seller",
      tradeState: "active",
    };
    next();
  },
}));

const serviceStubs = vi.hoisted(() => ({
  createReview: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  openDispute: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  listDisputesForModerator: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  decideDispute: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

vi.mock("#src/services/commerce-trust.service.js", () => serviceStubs);

describe("commerce trust routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
    const trustRouter = (await import("#src/routes/commerce-trust.routes.js")).default;
    app.use("/commerce", trustRouter);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    idempotencyCache.clear();
    signInAs();
  });

  it("requires Idempotency-Key on review creation", async () => {
    const response = await request(app)
      .post("/commerce/completions/cmpl_1/reviews")
      .send({ rating: 5, body: "Great work" });

    expect(response.status).toBe(400);
    expect(serviceStubs.createReview).not.toHaveBeenCalled();
  });

  it("rejects unknown review body keys with 422", async () => {
    const response = await request(app)
      .post("/commerce/completions/cmpl_1/reviews")
      .set("Idempotency-Key", "review-key-1")
      .send({ rating: 5, body: "Great work", unexpected: true });

    expect(response.status).toBe(422);
    expect(serviceStubs.createReview).not.toHaveBeenCalled();
  });

  it("maps NOT_FOUND from createReview to 404", async () => {
    serviceStubs.createReview.mockResolvedValue({
      success: false,
      error: { type: "NOT_FOUND" },
    });

    const response = await request(app)
      .post("/commerce/completions/cmpl_missing/reviews")
      .set("Idempotency-Key", "review-key-2")
      .send({ rating: 4, body: "Solid delivery" });

    expect(response.status).toBe(404);
  });

  it("maps SELF_REVIEW_FORBIDDEN to 403", async () => {
    serviceStubs.createReview.mockResolvedValue({
      success: false,
      error: { type: "SELF_REVIEW_FORBIDDEN" },
    });

    const response = await request(app)
      .post("/commerce/completions/cmpl_1/reviews")
      .set("Idempotency-Key", "review-key-3")
      .send({ rating: 5, body: "Self review attempt" });

    expect(response.status).toBe(403);
  });

  it("creates a review with the buyer organization actor", async () => {
    serviceStubs.createReview.mockResolvedValue({
      success: true,
      value: {
        id: "review_1",
        completionId: "cmpl_1",
        subjectOrganizationId: "commerce_org_seller",
        productId: "prd_1",
        rating: 5,
        body: "Excellent quality",
        visibility: "visible",
        createdAt: "2026-08-06T00:00:00.000Z",
      },
    });

    const response = await request(app)
      .post("/commerce/completions/cmpl_1/reviews")
      .set("Idempotency-Key", "review-key-4")
      .send({ rating: 5, body: "Excellent quality" });

    expect(response.status).toBe(201);
    expect(serviceStubs.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: BUYER_ORGANIZATION_ID }),
      "cmpl_1",
      { rating: 5, body: "Excellent quality" },
    );
  });

  it("opens a dispute for an order", async () => {
    serviceStubs.openDispute.mockResolvedValue({
      success: true,
      value: {
        id: "dispute_1",
        orderId: "order_1",
        state: "open",
        reasonCode: "quality_issue",
        summary: "Damaged goods",
        priorOrderState: "in_fulfillment",
        buyerOrganizationId: BUYER_ORGANIZATION_ID,
        counterpartyOrganizationId: "commerce_org_seller",
        openedByOrganizationId: BUYER_ORGANIZATION_ID,
        createdAt: "2026-08-06T00:00:00.000Z",
        decidedAt: null,
      },
    });

    const response = await request(app)
      .post("/commerce/orders/order_1/disputes")
      .set("Idempotency-Key", "dispute-key-1")
      .send({ reasonCode: "quality_issue", summary: "Damaged goods" });

    expect(response.status).toBe(201);
    expect(response.body.data.state).toBe("open");
  });

  it("lists moderator disputes", async () => {
    serviceStubs.listDisputesForModerator.mockResolvedValue({
      success: true,
      value: { items: [], page: { nextCursor: null, hasMore: false } },
    });

    const response = await request(app).get("/commerce/admin/disputes");

    expect(response.status).toBe(200);
    expect(serviceStubs.listDisputesForModerator).toHaveBeenCalled();
  });

  it("decides a dispute", async () => {
    serviceStubs.decideDispute.mockResolvedValue({
      success: true,
      value: {
        id: "dispute_1",
        orderId: "order_1",
        state: "closed",
        reasonCode: "quality_issue",
        summary: "Damaged goods",
        priorOrderState: "in_fulfillment",
        buyerOrganizationId: BUYER_ORGANIZATION_ID,
        counterpartyOrganizationId: "commerce_org_seller",
        openedByOrganizationId: BUYER_ORGANIZATION_ID,
        createdAt: "2026-08-06T00:00:00.000Z",
        decidedAt: "2026-08-06T01:00:00.000Z",
      },
    });

    const response = await request(app)
      .post("/commerce/admin/disputes/dispute_1/decisions")
      .set("Idempotency-Key", "decide-key-1")
      .send({ decision: "closed", note: "Resolved with replacement shipment" });

    expect(response.status).toBe(200);
    expect(response.body.data.state).toBe("closed");
  });
});
