import type { Express, NextFunction, Request, Response } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for payment intents and refunds (Appendix A38) — previously untested
 * at any tier. Payment intent creation and refund requests are the closest this backend
 * gets to moving money on the platform's own side of a trade.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

const ORGANIZATION_ID = "commerce_org_payments";
const MEMBER_ID = "member_payments_caller";

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
  attachOptionalSellerCommerceOrganization: (_req: Request, _res: Response, next: NextFunction): void => {
    next();
  },
  requireActiveCommerceOrganization: (req: Request, _res: Response, next: NextFunction): void => {
    req.commerceOrganization = {
      organizationId: ORGANIZATION_ID,
      memberId: MEMBER_ID,
      memberRole: "buyer",
      tradeState: "active",
    };
    next();
  },
  requireProvisionedBuyerCommerceWorkspace: (req: Request, _res: Response, next: NextFunction): void => {
    req.buyerCommerceWorkspace = {
      organizationId: ORGANIZATION_ID,
      memberId: MEMBER_ID,
      memberRole: "buyer",
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

const createPaymentIntent = vi.fn<(...args: readonly unknown[]) => unknown>();
const getPaymentIntent = vi.fn<(...args: readonly unknown[]) => unknown>();
const listRefunds = vi.fn<(...args: readonly unknown[]) => unknown>();
const createRefund = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/store/orders/commerce-payments.service.js", () => ({
  createPaymentIntent: (...args: readonly unknown[]) => createPaymentIntent(...args),
  getPaymentIntent: (...args: readonly unknown[]) => getPaymentIntent(...args),
  listRefunds: (...args: readonly unknown[]) => listRefunds(...args),
  createRefund: (...args: readonly unknown[]) => createRefund(...args),
}));

const ACTOR = {
  organizationId: ORGANIZATION_ID,
  memberId: MEMBER_ID,
  memberRole: "buyer",
  actorUserId: "user_test_caller",
};

describe("commerce payments routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    idempotencyCache.clear();
    signInAs();
    await resetRateLimiters();
  });

  describe("POST /commerce/orders/:orderId/payment-intents", () => {
    const path = "/commerce/orders/order_1/payment-intents";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).post(path).set("Idempotency-Key", "pi_key_1").send();

      expect(response.status).toBe(401);
      expect(createPaymentIntent).not.toHaveBeenCalled();
    });

    it("requires an Idempotency-Key header — the middleware refuses before the controller's own check runs", async () => {
      const response = await request(app).post(path).send();

      expect(response.status).toBe(400);
      expect(createPaymentIntent).not.toHaveBeenCalled();
    });

    it("accepts the intent for async processing and answers 202", async () => {
      createPaymentIntent.mockResolvedValue({
        success: true,
        value: { paymentIntent: { id: "pi_1", state: "pending" } },
      });

      const response = await request(app).post(path).set("Idempotency-Key", "pi_key_2").send();

      expect(response.status).toBe(202);
      expect(createPaymentIntent).toHaveBeenCalledWith(ACTOR, "order_1", "pi_key_2");
      expect(response.body.data).toEqual({ id: "pi_1", state: "pending" });
    });

    it("replays the cached response for a repeated Idempotency-Key", async () => {
      createPaymentIntent.mockResolvedValue({
        success: true,
        value: { paymentIntent: { id: "pi_1", state: "pending" } },
      });

      const first = await request(app).post(path).set("Idempotency-Key", "pi_key_3").send();
      const second = await request(app).post(path).set("Idempotency-Key", "pi_key_3").send();

      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      expect(second.headers["idempotency-replayed"]).toBe("true");
      expect(createPaymentIntent).toHaveBeenCalledTimes(1);
    });

    it("maps INVALID_STATE to 409", async () => {
      createPaymentIntent.mockResolvedValue({
        success: false,
        error: { type: "INVALID_STATE", message: "Order is not awaiting payment." },
      });

      const response = await request(app).post(path).set("Idempotency-Key", "pi_key_4").send();

      expect(response.status).toBe(409);
    });

    it("maps PROVIDER_UNAVAILABLE to 503", async () => {
      createPaymentIntent.mockResolvedValue({
        success: false,
        error: { type: "PROVIDER_UNAVAILABLE", reason: "no active gateway" },
      });

      const response = await request(app).post(path).set("Idempotency-Key", "pi_key_5").send();

      expect(response.status).toBe(503);
    });

    it("rejects a non-empty body with 422", async () => {
      const response = await request(app).post(path).set("Idempotency-Key", "pi_key_6").send({ amountInCents: 500 });

      expect(response.status).toBe(422);
      expect(createPaymentIntent).not.toHaveBeenCalled();
    });
  });

  describe("GET /commerce/payments/:paymentIntentId", () => {
    const path = "/commerce/payments/pi_1";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).get(path);

      expect(response.status).toBe(401);
      expect(getPaymentIntent).not.toHaveBeenCalled();
    });

    it("loads the intent and passes the resolved actor through", async () => {
      getPaymentIntent.mockResolvedValue({ success: true, value: { id: "pi_1", state: "pending" } });

      const response = await request(app).get(path);

      expect(response.status).toBe(200);
      expect(getPaymentIntent).toHaveBeenCalledWith(ACTOR, "pi_1");
      expect(response.body.data).toEqual({ id: "pi_1", state: "pending" });
    });

    it("maps NOT_FOUND to 404 for a payment intent belonging to another organization", async () => {
      getPaymentIntent.mockResolvedValue({ success: false, error: { type: "NOT_FOUND" } });

      const response = await request(app).get(path);

      expect(response.status).toBe(404);
    });
  });

  describe("GET /commerce/refunds", () => {
    const path = "/commerce/refunds";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).get(path);

      expect(response.status).toBe(401);
      expect(listRefunds).not.toHaveBeenCalled();
    });

    it("lists refunds scoped to the caller's organization", async () => {
      listRefunds.mockResolvedValue({ success: true, value: { rows: [{ id: "refund_1" }], nextCursor: null } });

      const response = await request(app).get(`${path}?orderId=order_1&limit=10`);

      expect(response.status).toBe(200);
      expect(listRefunds).toHaveBeenCalledWith(ACTOR, { orderId: "order_1", cursor: undefined, limit: 10 });
      expect(response.body.data.rows).toEqual([{ id: "refund_1" }]);
    });

    it("rejects an unknown query key with 422", async () => {
      const response = await request(app).get(`${path}?userId=other`);

      expect(response.status).toBe(422);
      expect(listRefunds).not.toHaveBeenCalled();
    });

    it("maps INVALID_CURSOR to 422", async () => {
      listRefunds.mockResolvedValue({ success: false, error: { type: "INVALID_CURSOR" } });

      const response = await request(app).get(`${path}?cursor=nonsense`);

      expect(response.status).toBe(422);
    });
  });

  describe("POST /commerce/orders/:orderId/refunds", () => {
    const path = "/commerce/orders/order_1/refunds";

    it("requires an Idempotency-Key header", async () => {
      const response = await request(app).post(path).send({ reason: "Item not shipped." });

      expect(response.status).toBe(400);
      expect(createRefund).not.toHaveBeenCalled();
    });

    it("creates the refund and answers 202", async () => {
      createRefund.mockResolvedValue({ success: true, value: { id: "refund_1", state: "requested" } });

      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "refund_key_1")
        .send({ amountInCents: 5_000, reason: "Item not shipped." });

      expect(response.status).toBe(202);
      expect(createRefund).toHaveBeenCalledWith(ACTOR, "order_1", "refund_key_1", {
        amountInCents: 5_000,
        reason: "Item not shipped.",
      });
    });

    it("accepts a bodyless refund request (no partial-amount reason required)", async () => {
      createRefund.mockResolvedValue({ success: true, value: { id: "refund_1", state: "requested" } });

      const response = await request(app).post(path).set("Idempotency-Key", "refund_key_2").send();

      expect(response.status).toBe(202);
      expect(createRefund).toHaveBeenCalledWith(ACTOR, "order_1", "refund_key_2", {});
    });

    /**
     * The refund's own domain invariant: requesting more than remains refundable. 409, not
     * 422 — the body is well-formed, the amount just conflicts with the order's own state.
     */
    it("maps OVER_REFUND to 409 with the refundable balance in the response", async () => {
      createRefund.mockResolvedValue({
        success: false,
        error: { type: "OVER_REFUND", refundableInCents: 2_000 },
      });

      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "refund_key_3")
        .send({ amountInCents: 10_000 });

      expect(response.status).toBe(409);
      expect(response.body.data).toEqual({ refundableInCents: 2_000 });
    });

    it("maps PROVIDER_REJECTED to 502", async () => {
      createRefund.mockResolvedValue({
        success: false,
        error: { type: "PROVIDER_REJECTED", reason: "gateway declined the reversal" },
      });

      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "refund_key_4")
        .send({ reason: "Damaged in transit." });

      expect(response.status).toBe(502);
    });

    it("rejects an unknown body field with 422", async () => {
      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "refund_key_5")
        .send({ refundToCardEnding: "4242" });

      expect(response.status).toBe(422);
      expect(createRefund).not.toHaveBeenCalled();
    });
  });
});
