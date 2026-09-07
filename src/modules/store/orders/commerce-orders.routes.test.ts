import type { Express, NextFunction, Request, Response } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
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

vi.mock("#src/modules/store/organizations/require-active-commerce-organization.js", () => ({
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
  // Phase 21 (§14). Attaches `buyerCommerceWorkspace`, never `commerceOrganization` — the
  // two are separate properties so a handler cannot read an unactivated workspace as a
  // trading one. Mounted through app.ts, so every suite that mocks this module must
  // provide it.
  requireProvisionedBuyerCommerceWorkspace: (req: Request, _res: Response, next: NextFunction): void => {
    req.buyerCommerceWorkspace = {
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

vi.mock("#src/modules/store/orders/commerce-orders.service.js", () => serviceStubs);

const arrivalWindowStubs = vi.hoisted(() => ({
  getOrderArrivalWindow: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  projectPrepareArrivalWindow: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  composeArrivalWindow: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  projectManufacturing: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  projectFreight: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

vi.mock("#src/modules/store/fulfillment/commerce-arrival-window.service.js", () => arrivalWindowStubs);

const earningsStubs = vi.hoisted(() => ({
  getSellerEarnings: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

vi.mock("#src/modules/store/orders/commerce-earnings.service.js", () => earningsStubs);

const settlementAttestationStubs = vi.hoisted(() => ({
  listSettlementAttestations: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  recordSettlementAttestation: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

vi.mock("#src/modules/store/orders/commerce-settlement-attestation.service.js", () => settlementAttestationStubs);

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
    const ordersRouter = (await import("#src/modules/store/orders/commerce-orders.routes.js")).default;
    app.use("/commerce", ordersRouter);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    idempotencyCache.clear();
    signInAs();
    await resetRateLimiters();
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

  it("returns the arrival window with no mode selected, listing the covered modes", async () => {
    arrivalWindowStubs.getOrderArrivalWindow.mockResolvedValue({
      success: true,
      value: {
        clockStartAt: null,
        clockStartBasis: "not_confirmed",
        components: {
          freight: { status: "unknown", reason: "mode_not_selected", availableModes: ["air", "sea"] },
        },
        arrivalWindow: null,
        missingComponents: ["freight"],
      },
    });

    const response = await request(app).get("/commerce/orders/order-1/arrival-window");

    expect(response.status).toBe(200);
    expect(response.body.data.arrivalWindow.missingComponents).toEqual(["freight"]);
    expect(arrivalWindowStubs.getOrderArrivalWindow).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: BUYER_ORGANIZATION_ID }),
      "order-1",
      expect.objectContaining({ mode: undefined }),
    );
  });

  it("passes a requested mode through to the service", async () => {
    arrivalWindowStubs.getOrderArrivalWindow.mockResolvedValue({
      success: true,
      value: { clockStartAt: null, arrivalWindow: null, missingComponents: [] },
    });

    const response = await request(app).get("/commerce/orders/order-1/arrival-window").query({ mode: "sea" });

    expect(response.status).toBe(200);
    expect(arrivalWindowStubs.getOrderArrivalWindow).toHaveBeenCalledWith(
      expect.anything(),
      "order-1",
      expect.objectContaining({ mode: "sea" }),
    );
  });

  it("refuses a mode outside the shipment leg enum with 422", async () => {
    const response = await request(app).get("/commerce/orders/order-1/arrival-window").query({ mode: "truck" });

    expect(response.status).toBe(422);
    expect(arrivalWindowStubs.getOrderArrivalWindow).not.toHaveBeenCalled();
  });

  it("refuses an unknown query key with 422", async () => {
    const response = await request(app)
      .get("/commerce/orders/order-1/arrival-window")
      .query({ mode: "sea", pretendToBeConfirmed: "true" });

    expect(response.status).toBe(422);
    expect(arrivalWindowStubs.getOrderArrivalWindow).not.toHaveBeenCalled();
  });

  it("answers a non-party with 404, never 403 — an order id must not be probeable", async () => {
    arrivalWindowStubs.getOrderArrivalWindow.mockResolvedValue({
      success: false,
      error: { type: "NOT_FOUND" },
    });

    const response = await request(app).get("/commerce/orders/order-owned-by-another-tenant/arrival-window");

    expect(response.status).toBe(404);
  });

  describe("GET /commerce/provider/earnings", () => {
    it("loads lifetime earnings when no window is given", async () => {
      earningsStubs.getSellerEarnings.mockResolvedValue({
        success: true,
        value: { rows: [{ currency: "USD", totalInCents: 500_000 }] },
      });

      const response = await request(app).get("/commerce/provider/earnings");

      expect(response.status).toBe(200);
      expect(earningsStubs.getSellerEarnings).toHaveBeenCalledWith(
        { organizationId: BUYER_ORGANIZATION_ID },
        { from: undefined, to: undefined },
      );
      expect(response.headers["cache-control"]).toBe("no-store");
    });

    it("passes a from/to window through as dates", async () => {
      earningsStubs.getSellerEarnings.mockResolvedValue({ success: true, value: { rows: [] } });

      const response = await request(app)
        .get("/commerce/provider/earnings")
        .query({ from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z" });

      expect(response.status).toBe(200);
      expect(earningsStubs.getSellerEarnings).toHaveBeenCalledWith(
        { organizationId: BUYER_ORGANIZATION_ID },
        { from: new Date("2026-01-01T00:00:00.000Z"), to: new Date("2026-02-01T00:00:00.000Z") },
      );
    });

    it("rejects a currency filter — the schema declares none", async () => {
      const response = await request(app).get("/commerce/provider/earnings").query({ currency: "USD" });

      expect(response.status).toBe(422);
      expect(earningsStubs.getSellerEarnings).not.toHaveBeenCalled();
    });

    it("maps INVALID_WINDOW to 422", async () => {
      earningsStubs.getSellerEarnings.mockResolvedValue({
        success: false,
        error: { type: "INVALID_WINDOW", message: "`from` must be before `to`." },
      });

      const response = await request(app)
        .get("/commerce/provider/earnings")
        .query({ from: "2026-02-01T00:00:00.000Z", to: "2026-01-01T00:00:00.000Z" });

      expect(response.status).toBe(422);
    });
  });

  describe("GET /commerce/orders/:orderId/settlement-attestations", () => {
    it("lists both parties' attestations for an order", async () => {
      settlementAttestationStubs.listSettlementAttestations.mockResolvedValue({
        success: true,
        value: [{ id: "attestation_1", attestationKind: "payment_sent" }],
      });

      const response = await request(app).get("/commerce/orders/order-1/settlement-attestations");

      expect(response.status).toBe(200);
      expect(settlementAttestationStubs.listSettlementAttestations).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: BUYER_ORGANIZATION_ID }),
        "order-1",
      );
      expect(response.body.data).toEqual([{ id: "attestation_1", attestationKind: "payment_sent" }]);
    });

    it("answers 404, not 403, for an order this organization is not a party to", async () => {
      settlementAttestationStubs.listSettlementAttestations.mockResolvedValue({
        success: false,
        error: { type: "NOT_FOUND" },
      });

      const response = await request(app).get("/commerce/orders/order-owned-by-another-tenant/settlement-attestations");

      expect(response.status).toBe(404);
    });
  });

  describe("POST /commerce/orders/:orderId/settlement-attestations", () => {
    const path = "/commerce/orders/order-1/settlement-attestations";
    const validBody = { amountInCents: 100_000, occurredAt: "2026-03-01T00:00:00.000Z" };

    it("requires an Idempotency-Key header", async () => {
      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(400);
      expect(settlementAttestationStubs.recordSettlementAttestation).not.toHaveBeenCalled();
    });

    it("records the attestation and answers 201 with the whole list", async () => {
      settlementAttestationStubs.recordSettlementAttestation.mockResolvedValue({
        success: true,
        value: [{ id: "attestation_1", attestationKind: "payment_sent" }],
      });

      const response = await request(app).post(path).set("Idempotency-Key", "attestation_key_1").send(validBody);

      expect(response.status).toBe(201);
      expect(settlementAttestationStubs.recordSettlementAttestation).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: BUYER_ORGANIZATION_ID }),
        "order-1",
        {
          amountInCents: 100_000,
          occurredAt: new Date("2026-03-01T00:00:00.000Z"),
          referenceNote: null,
        },
      );
    });

    /**
     * The kind (payment_sent vs payment_received) is derived server-side from which party
     * the caller is, per the schema's own docs — a client cannot claim the other side's role.
     */
    it("rejects a client-supplied attestationKind with 422", async () => {
      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "attestation_key_2")
        .send({ ...validBody, attestationKind: "payment_received" });

      expect(response.status).toBe(422);
      expect(settlementAttestationStubs.recordSettlementAttestation).not.toHaveBeenCalled();
    });

    it("maps RAIL_NOT_ATTESTABLE to 409 with the settlement rail in the response", async () => {
      settlementAttestationStubs.recordSettlementAttestation.mockResolvedValue({
        success: false,
        error: { type: "RAIL_NOT_ATTESTABLE", settlementRail: "external_escrow" },
      });

      const response = await request(app).post(path).set("Idempotency-Key", "attestation_key_3").send(validBody);

      expect(response.status).toBe(409);
      expect(response.body.data).toEqual({ settlementRail: "external_escrow" });
    });

    it("maps ALREADY_ATTESTED to 409, since recorded payments are never edited", async () => {
      settlementAttestationStubs.recordSettlementAttestation.mockResolvedValue({
        success: false,
        error: { type: "ALREADY_ATTESTED", attestationKind: "payment_sent" },
      });

      const response = await request(app).post(path).set("Idempotency-Key", "attestation_key_4").send(validBody);

      expect(response.status).toBe(409);
    });
  });
});
