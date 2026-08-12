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

vi.mock("#src/modules/store/organizations/require-active-commerce-organization.js", () => ({
  // Phase 9 authoring routes attach an organization optionally, because a platform
  // merchandiser may not belong to one. Mounted through app.ts, so every suite that
  // mocks this module must provide it.
  attachOptionalSellerCommerceOrganization: (_req: Request, _res: Response, next: NextFunction): void => {
    next();
  },
  requireActiveCommerceOrganization: (req: Request, _res: Response, next: NextFunction): void => {
    req.commerceOrganization = {
      organizationId: ORGANIZATION_ID,
      memberId: MEMBER_ID,
      memberRole: "seller",
      tradeState: "active",
    };
    next();
  },
  // Phase 21 (§14). Attaches `buyerCommerceWorkspace`, never `commerceOrganization` — the
  // two are separate properties so a handler cannot read an unactivated workspace as a
  // trading one. Mounted through app.ts, so every suite that mocks this module must
  // provide it.
  requireProvisionedBuyerCommerceWorkspace: (req: Request, _res: Response, next: NextFunction): void => {
    req.buyerCommerceWorkspace = {
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
  listCounterpartyShipments: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

const phase6ServiceStubs = vi.hoisted(() => ({
  getOrderFulfillment: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  getShipmentDetail: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  getServiceEngagementDetail: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  executeShipmentLegCommand: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  executeServiceEngagementCommand: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  listShipmentLegEvents: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  listServiceEngagementEvents: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  buildFulfillmentRequestFingerprint: vi.fn<(payload: unknown) => string>((payload: unknown) =>
    JSON.stringify(payload),
  ),
}));

vi.mock("#src/modules/store/fulfillment/commerce-fulfillment.service.js", () => serviceStubs);
vi.mock("#src/modules/store/fulfillment/commerce-fulfillment-phase6.service.js", () => phase6ServiceStubs);

describe("commerce fulfillment routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
    const fulfillmentRouter = (await import("#src/modules/store/fulfillment/commerce-fulfillment.routes.js")).default;
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

  it("rejects shipment creation with unknown body keys", async () => {
    const response = await request(app)
      .post("/commerce/orders/order-1/shipments")
      .set("Idempotency-Key", "shipment-create-unknown-key")
      .send({
        lines: [{ orderProductLineId: "opl_1", quantity: 1 }],
        packageCount: 1,
        unexpected: true,
      });

    expect(response.status).toBe(422);
    expect(serviceStubs.createShipment).not.toHaveBeenCalled();
  });

  it("passes optional legs through create shipment", async () => {
    serviceStubs.createShipment.mockResolvedValue({
      success: true,
      value: {
        id: "shipment-2",
        orderId: "order-1",
        state: "planned",
        packageCount: 1,
        productLines: [],
        events: [],
      },
    });

    const response = await request(app)
      .post("/commerce/orders/order-1/shipments")
      .set("Idempotency-Key", "shipment-create-with-legs")
      .send({
        lines: [{ orderProductLineId: "opl_1", quantity: 1 }],
        packageCount: 1,
        legs: [
          {
            sequence: 0,
            mode: "sea",
            originCountryCode: "CN",
            destinationCountryCode: "US",
          },
        ],
      });

    expect(response.status).toBe(201);
    expect(serviceStubs.createShipment).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORGANIZATION_ID }),
      "order-1",
      expect.objectContaining({
        legs: [
          expect.objectContaining({
            sequence: 0,
            mode: "sea",
            originCountryCode: "CN",
            destinationCountryCode: "US",
          }),
        ],
      }),
    );
  });

  it("loads derived order fulfillment progress", async () => {
    phase6ServiceStubs.getOrderFulfillment.mockResolvedValue({
      success: true,
      value: {
        orderId: "order-1",
        overallState: "in_progress",
        progress: { completedUnits: 1, totalUnits: 2, basisPoints: 5000 },
      },
    });

    const response = await request(app).get("/commerce/orders/order-1/fulfillment");

    expect(response.status).toBe(200);
    expect(response.body.data.progress.basisPoints).toBe(5000);
    expect(phase6ServiceStubs.getOrderFulfillment).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORGANIZATION_ID }),
      "order-1",
    );
  });

  it("requires Idempotency-Key for shipment-leg commands", async () => {
    const response = await request(app)
      .post("/commerce/shipment-legs/leg-1/commands")
      .send({ command: "book", expectedVersion: 0 });

    expect(response.status).toBe(400);
    expect(phase6ServiceStubs.executeShipmentLegCommand).not.toHaveBeenCalled();
  });

  it("maps VERSION_CONFLICT from leg commands to 409", async () => {
    phase6ServiceStubs.executeShipmentLegCommand.mockResolvedValue({
      success: false,
      error: { type: "VERSION_CONFLICT", currentVersion: 4 },
    });

    const response = await request(app)
      .post("/commerce/shipment-legs/leg-1/commands")
      .set("Idempotency-Key", "leg-book-stale-version")
      .send({ command: "book", expectedVersion: 3 });

    expect(response.status).toBe(409);
    expect(response.body.data).toMatchObject({ currentVersion: 4 });
    expect(phase6ServiceStubs.executeShipmentLegCommand).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORGANIZATION_ID }),
      "leg-1",
      expect.objectContaining({ idempotencyKey: "leg-book-stale-version" }),
      { command: "book", expectedVersion: 3 },
    );
  });

  it("maps CONTRACT_SNAPSHOT_MISSING from engagement commands to 409", async () => {
    phase6ServiceStubs.executeServiceEngagementCommand.mockResolvedValue({
      success: false,
      error: { type: "CONTRACT_SNAPSHOT_MISSING" },
    });

    const response = await request(app)
      .post("/commerce/service-engagements/engagement-1/commands")
      .set("Idempotency-Key", "engagement-start-missing-snapshot")
      .send({ command: "start", expectedVersion: 0 });

    expect(response.status).toBe(409);
    expect(phase6ServiceStubs.executeServiceEngagementCommand).toHaveBeenCalled();
  });

  it("maps REQUIRED_DELIVERABLES_INCOMPLETE to 409 with deliverable ids", async () => {
    phase6ServiceStubs.executeServiceEngagementCommand.mockResolvedValue({
      success: false,
      error: {
        type: "REQUIRED_DELIVERABLES_INCOMPLETE",
        deliverableIds: ["del_1", "del_2"],
      },
    });

    const response = await request(app)
      .post("/commerce/service-engagements/engagement-1/commands")
      .set("Idempotency-Key", "engagement-complete-incomplete")
      .send({ command: "complete", expectedVersion: 2 });

    expect(response.status).toBe(409);
    expect(response.body.data).toMatchObject({ deliverableIds: ["del_1", "del_2"] });
  });

  it("maps IDEMPOTENCY_CONFLICT to 409", async () => {
    phase6ServiceStubs.executeShipmentLegCommand.mockResolvedValue({
      success: false,
      error: { type: "IDEMPOTENCY_CONFLICT" },
    });

    const response = await request(app)
      .post("/commerce/shipment-legs/leg-1/commands")
      .set("Idempotency-Key", "leg-fingerprint-conflict")
      .send({ command: "depart", expectedVersion: 1 });

    expect(response.status).toBe(409);
  });

  it("loads shipment and engagement details for authorized actors", async () => {
    phase6ServiceStubs.getShipmentDetail.mockResolvedValue({
      success: true,
      value: { id: "shipment-1", state: "planned", legs: [] },
    });
    phase6ServiceStubs.getServiceEngagementDetail.mockResolvedValue({
      success: true,
      value: {
        id: "engagement-1",
        state: "awaiting_provider",
        executionSnapshot: {
          kind: "customs_broker",
          jurisdictions: ["US-CBP"],
        },
        deliverables: [
          {
            id: "deliverable-1",
            state: "submitted",
            result: {
              kind: "customs_broker",
              filingKind: "import_entry",
              jurisdiction: "US-CBP",
            },
          },
        ],
      },
    });

    const shipmentResponse = await request(app).get("/commerce/shipments/shipment-1");
    const engagementResponse = await request(app).get("/commerce/service-engagements/engagement-1");

    expect(shipmentResponse.status).toBe(200);
    expect(engagementResponse.status).toBe(200);
    expect(engagementResponse.body.data).toMatchObject({
      executionSnapshot: { kind: "customs_broker", jurisdictions: ["US-CBP"] },
      deliverables: [
        {
          result: {
            kind: "customs_broker",
            filingKind: "import_entry",
          },
        },
      ],
    });
  });

  it("lists authorized leg and engagement events", async () => {
    phase6ServiceStubs.listShipmentLegEvents.mockResolvedValue({
      success: true,
      value: [{ eventKind: "created", sequence: 0 }],
    });
    phase6ServiceStubs.listServiceEngagementEvents.mockResolvedValue({
      success: true,
      value: [{ nextState: "scheduled", sequence: 0 }],
    });

    const legEvents = await request(app).get("/commerce/shipment-legs/leg-1/events");
    const engagementEvents = await request(app).get("/commerce/service-engagements/engagement-1/events");

    expect(legEvents.status).toBe(200);
    expect(engagementEvents.status).toBe(200);
  });

  /**
   * A29. The cross-order logistics queue. Every other shipment route is scoped to an id
   * the caller already holds, so a forwarder carrying forty shipments across thirty-one
   * orders had no route that listed them.
   */
  describe("GET /commerce/provider/shipments", () => {
    it("returns the queue with the leg-derived arrival estimate", async () => {
      serviceStubs.listCounterpartyShipments.mockResolvedValue({
        success: true,
        value: {
          items: [
            {
              id: "shp_1",
              orderId: "order_1",
              buyerOrganizationId: "org_buyer",
              state: "in_transit",
              originCountryCode: "IN",
              originLocality: "Pune",
              destinationCountryCode: "DE",
              destinationLocality: "Hamburg",
              packageCount: 12,
              totalWeightGrams: 480_000,
              estimatedArrivalAt: new Date("2026-03-14T00:00:00.000Z"),
              createdAt: new Date("2026-02-01T00:00:00.000Z"),
            },
          ],
          page: { nextCursor: null, hasMore: false },
        },
      });

      const response = await request(app).get("/commerce/provider/shipments");

      expect(response.status).toBe(200);
      expect(response.body.data.items[0].id).toBe("shp_1");
      expect(response.body.data.items[0].estimatedArrivalAt).toBe("2026-03-14T00:00:00.000Z");
      expect(response.body.data.page).toEqual({ nextCursor: null, hasMore: false });
    });

    /** `null`, never a fabricated date, when no leg carries an estimate. */
    it("carries a null arrival estimate rather than inventing one", async () => {
      serviceStubs.listCounterpartyShipments.mockResolvedValue({
        success: true,
        value: {
          items: [
            {
              id: "shp_2",
              orderId: "order_2",
              buyerOrganizationId: "org_buyer",
              state: "planned",
              originCountryCode: null,
              originLocality: null,
              destinationCountryCode: null,
              destinationLocality: null,
              packageCount: 1,
              totalWeightGrams: null,
              estimatedArrivalAt: null,
              createdAt: new Date("2026-02-02T00:00:00.000Z"),
            },
          ],
          page: { nextCursor: null, hasMore: false },
        },
      });

      const response = await request(app).get("/commerce/provider/shipments");

      expect(response.status).toBe(200);
      expect(response.body.data.items[0].estimatedArrivalAt).toBeNull();
    });

    it("passes the state and arrival-window filters through as parsed values", async () => {
      serviceStubs.listCounterpartyShipments.mockResolvedValue({
        success: true,
        value: { items: [], page: { nextCursor: null, hasMore: false } },
      });

      const response = await request(app).get(
        "/commerce/provider/shipments?state=in_transit" +
          "&estimatedArrivalFrom=2026-03-01T00:00:00.000Z" +
          "&estimatedArrivalTo=2026-03-31T00:00:00.000Z&limit=10",
      );

      expect(response.status).toBe(200);
      expect(serviceStubs.listCounterpartyShipments).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          state: "in_transit",
          estimatedArrivalFrom: new Date("2026-03-01T00:00:00.000Z"),
          estimatedArrivalTo: new Date("2026-03-31T00:00:00.000Z"),
          limit: 10,
        }),
      );
    });

    it("refuses a shipment state that is not one of the four", async () => {
      const response = await request(app).get("/commerce/provider/shipments?state=lost");

      expect(response.status).toBe(422);
      expect(serviceStubs.listCounterpartyShipments).not.toHaveBeenCalled();
    });

    it("rejects an unknown query key rather than ignoring it", async () => {
      const response = await request(app).get("/commerce/provider/shipments?carrier=dhl");

      expect(response.status).toBe(422);
      expect(serviceStubs.listCounterpartyShipments).not.toHaveBeenCalled();
    });

    it("maps an unusable cursor to 422", async () => {
      serviceStubs.listCounterpartyShipments.mockResolvedValue({
        success: false,
        error: { type: "INVALID_CURSOR" },
      });

      const response = await request(app).get("/commerce/provider/shipments?cursor=nonsense");

      expect(response.status).toBe(422);
    });

    /**
     * The literal segment must win over `/shipments/:shipmentId`. If the parameter route
     * were matched first, the queue would silently become a detail lookup for a shipment
     * whose id is the string "provider".
     */
    it("is not swallowed by the shipment-detail parameter route", async () => {
      serviceStubs.listCounterpartyShipments.mockResolvedValue({
        success: true,
        value: { items: [], page: { nextCursor: null, hasMore: false } },
      });

      const response = await request(app).get("/commerce/provider/shipments");

      expect(response.status).toBe(200);
      expect(phase6ServiceStubs.getShipmentDetail).not.toHaveBeenCalled();
      expect(serviceStubs.listCounterpartyShipments).toHaveBeenCalled();
    });
  });
});
