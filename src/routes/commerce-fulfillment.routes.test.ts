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

const ORGANIZATION_ID = "commerce_org_counterparty_fulfillment";
const MEMBER_ID = "member-provider-fulfillment";

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
      organizationId: ORGANIZATION_ID,
      memberId: MEMBER_ID,
      memberRole: "seller",
      tradeState: "active",
    };
    next();
  },
  requireActiveBuyerCommerceOrganization: (req: Request, _res: Response, next: NextFunction): void => {
    req.commerceOrganization = {
      organizationId: ORGANIZATION_ID,
      memberId: MEMBER_ID,
      memberRole: "buyer",
      tradeState: "active",
    };
    next();
  },
  requireActiveProviderCommerceOrganization: (req: Request, _res: Response, next: NextFunction): void => {
    req.commerceOrganization = {
      organizationId: ORGANIZATION_ID,
      memberId: MEMBER_ID,
      memberRole: "provider_operator",
      tradeState: "active",
    };
    next();
  },
  requireActiveSellerCommerceOrganization: (req: Request, _res: Response, next: NextFunction): void => {
    req.commerceOrganization = {
      organizationId: ORGANIZATION_ID,
      memberId: MEMBER_ID,
      memberRole: "seller",
      tradeState: "active",
    };
    next();
  },
}));

const serviceStubs = vi.hoisted(() => ({
  createShipment: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  appendShipmentEvent: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  listServiceEngagements: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  transitionServiceEngagement: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

vi.mock("#src/services/commerce-fulfillment.service.js", () => serviceStubs);

describe("commerce fulfillment routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
    const fulfillmentRouter = (await import("#src/routes/commerce-fulfillment.routes.js")).default;
    app.use("/commerce", fulfillmentRouter);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    idempotencyCache.clear();
    signInAs();
  });

  it("returns 422 on a bad create-shipment body", async () => {
    const response = await request(app)
      .post("/commerce/orders/order-1/shipments")
      .set("Idempotency-Key", "shipment-create-bad-body")
      .send({ lines: [], packageCount: 1 });

    expect(response.status).toBe(422);
    expect(serviceStubs.createShipment).not.toHaveBeenCalled();
  });

  it("records a delivered shipment event on the happy path", async () => {
    serviceStubs.appendShipmentEvent.mockResolvedValue({
      success: true,
      value: {
        id: "shipment-1",
        orderId: "order-1",
        state: "delivered",
        originCountryCode: null,
        originLocality: null,
        destinationCountryCode: null,
        destinationLocality: null,
        packageCount: 1,
        totalWeightGrams: null,
        createdAt: new Date("2026-08-05T00:00:00.000Z"),
        productLines: [],
        events: [
          {
            id: "event-1",
            eventKind: "delivered",
            occurredAt: new Date("2026-08-05T01:00:00.000Z"),
            description: null,
          },
        ],
      },
    });

    const response = await request(app)
      .post("/commerce/shipments/shipment-1/events")
      .set("Idempotency-Key", "shipment-event-delivered")
      .send({ eventKind: "delivered" });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({ id: "shipment-1", state: "delivered" });
    expect(serviceStubs.appendShipmentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORGANIZATION_ID }),
      "shipment-1",
      { eventKind: "delivered", occurredAt: undefined, description: undefined },
    );
  });

  it("maps engagement transition INVALID_STATE to 409", async () => {
    serviceStubs.transitionServiceEngagement.mockResolvedValue({
      success: false,
      error: { type: "INVALID_STATE" },
    });

    const response = await request(app)
      .post("/commerce/service-engagements/engagement-1/transitions")
      .set("Idempotency-Key", "engagement-transition-invalid-state")
      .send({ targetState: "completed" });

    expect(response.status).toBe(409);
    expect(serviceStubs.transitionServiceEngagement).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORGANIZATION_ID }),
      "engagement-1",
      { targetState: "completed" },
    );
  });
});
