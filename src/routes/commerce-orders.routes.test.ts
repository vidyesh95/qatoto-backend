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

const BUYER_ORGANIZATION_ID = "commerce_org_buyer_orders";
const MEMBER_ID = "member-buyer-orders";

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
  // Phase 9 authoring routes attach an organization optionally, because a platform
  // merchandiser may not belong to one. Mounted through app.ts, so every suite that
  // mocks this module must provide it.
  attachOptionalSellerCommerceOrganization: (_req: Request, _res: Response, next: NextFunction): void => {
    next();
  },
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
  listBuyerOrders: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  listCounterpartyOrders: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  getOrder: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  cancelOrder: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

vi.mock("#src/services/commerce-orders.service.js", () => serviceStubs);

const ORDER_SUMMARY = {
  id: "order-1",
  buyerOrganizationId: BUYER_ORGANIZATION_ID,
  counterpartyOrganizationId: "commerce_org_seller_orders",
  checkoutGroupId: "checkout-group-1",
  source: "direct_checkout",
  state: "pending_payment",
  currency: "USD",
  totalInCents: 5000,
  buyerLegalNameSnapshot: "Buyer Co",
  counterpartyLegalNameSnapshot: "Seller Co",
  createdAt: "2026-08-05T00:00:00.000Z",
};

describe("commerce order routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
    const ordersRouter = (await import("#src/routes/commerce-orders.routes.js")).default;
    app.use("/commerce", ordersRouter);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    idempotencyCache.clear();
    signInAs();
  });

  it("returns the buyer order list page shape", async () => {
    serviceStubs.listBuyerOrders.mockResolvedValue({
      success: true,
      value: {
        items: [ORDER_SUMMARY],
        page: { nextCursor: null, hasMore: false },
      },
    });

    const response = await request(app).get("/commerce/orders");

    expect(response.status).toBe(200);
    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0]).toMatchObject({ id: "order-1" });
    expect(response.body.data.page).toEqual({ nextCursor: null, hasMore: false });
    expect(serviceStubs.listBuyerOrders).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: BUYER_ORGANIZATION_ID }),
      { limit: undefined, cursor: undefined },
    );
  });

  it("maps NOT_FOUND from getOrder to 404", async () => {
    serviceStubs.getOrder.mockResolvedValue({
      success: false,
      error: { type: "NOT_FOUND" },
    });

    const response = await request(app).get("/commerce/orders/order-missing");

    expect(response.status).toBe(404);
    expect(serviceStubs.getOrder).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: BUYER_ORGANIZATION_ID }),
      "order-missing",
    );
  });

  it("requires Idempotency-Key on order cancellation", async () => {
    const response = await request(app).post("/commerce/orders/order-1/cancel").send({});

    expect(response.status).toBe(400);
    expect(serviceStubs.cancelOrder).not.toHaveBeenCalled();
  });

  it("cross-tenant cancel: NOT_FOUND from the service maps to 404", async () => {
    serviceStubs.cancelOrder.mockResolvedValue({
      success: false,
      error: { type: "NOT_FOUND" },
    });

    const response = await request(app)
      .post("/commerce/orders/order-owned-by-another-tenant/cancel")
      .set("Idempotency-Key", "order-cancel-cross-tenant")
      .send({});

    expect(response.status).toBe(404);
    expect(serviceStubs.cancelOrder).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: BUYER_ORGANIZATION_ID }),
      "order-owned-by-another-tenant",
    );
  });
});
