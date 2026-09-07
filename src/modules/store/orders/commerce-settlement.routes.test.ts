import type { Express, NextFunction, Request, Response } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for negotiated settlement agreements (STORE Phase 14) — previously
 * untested at any tier. Escrow here is opt-in and negotiated in chat (Qatoto never holds
 * funds), so these routes are the one place a buyer or seller commits to a real escrow
 * provider and fee split.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

const ORGANIZATION_ID = "commerce_org_settlement";
const MEMBER_ID = "member_settlement_caller";

/**
 * Local idempotency fake, copied from `commerce-cart.routes.test.ts`'s proven shape: a
 * `Map`-backed replay cache keyed by header, honouring `required: true`.
 */
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

const listEligibleProviders = vi.fn<(...args: readonly unknown[]) => unknown>();
const proposeSettlementAgreement = vi.fn<(...args: readonly unknown[]) => unknown>();
const respondToSettlementAgreement = vi.fn<(...args: readonly unknown[]) => unknown>();
const listThreadSettlementAgreements = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/store/orders/commerce-settlement.service.js", () => ({
  listEligibleProviders: (...args: readonly unknown[]) => listEligibleProviders(...args),
  proposeSettlementAgreement: (...args: readonly unknown[]) => proposeSettlementAgreement(...args),
  respondToSettlementAgreement: (...args: readonly unknown[]) => respondToSettlementAgreement(...args),
  listThreadSettlementAgreements: (...args: readonly unknown[]) => listThreadSettlementAgreements(...args),
}));

const VALID_AGREEMENT_BODY = {
  buyerOrganizationId: "commerce_org_buyer",
  sellerOrganizationId: "commerce_org_seller",
  externalProviderId: "provider_1",
  escrowFeeBearer: "split",
  currency: "USD",
  totalInCents: 100_000,
  expiresAt: "2026-06-01T00:00:00.000Z",
  milestones: [
    { sequence: 1, milestoneKind: "deposit", amountInCents: 30_000, releaseConditionNote: null },
    { sequence: 2, milestoneKind: "final", amountInCents: 70_000, releaseConditionNote: null },
  ],
};

describe("commerce settlement routes", () => {
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

  describe("GET /commerce/settlement/escrow-providers", () => {
    const path =
      "/commerce/settlement/escrow-providers?buyerCountryCode=US&sellerCountryCode=IN&currency=USD&totalInCents=100000";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).get(path);

      expect(response.status).toBe(401);
      expect(listEligibleProviders).not.toHaveBeenCalled();
    });

    it("lists providers with the Qatoto-does-not-hold-funds notice", async () => {
      listEligibleProviders.mockResolvedValue([
        { id: "provider_1", providerSlug: "fake", displayName: "Fake Escrow Co" },
      ]);

      const response = await request(app).get(path);

      expect(response.status).toBe(200);
      expect(listEligibleProviders).toHaveBeenCalledWith({
        buyerCountryCode: "US",
        sellerCountryCode: "IN",
        currency: "USD",
        totalInCents: 100_000,
      });
      expect(response.body.data.settlementNotice).toBe("qatoto_does_not_hold_funds");
      expect(response.body.data.items).toEqual([{ id: "provider_1", slug: "fake", displayName: "Fake Escrow Co" }]);
    });

    it("rejects a malformed country code with 422", async () => {
      const response = await request(app).get(
        "/commerce/settlement/escrow-providers?buyerCountryCode=usa&sellerCountryCode=IN&currency=USD&totalInCents=100000",
      );

      expect(response.status).toBe(422);
      expect(listEligibleProviders).not.toHaveBeenCalled();
    });
  });

  describe("GET /commerce/threads/:threadId/settlement-agreements", () => {
    const path = "/commerce/threads/thread_1/settlement-agreements";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).get(path);

      expect(response.status).toBe(401);
      expect(listThreadSettlementAgreements).not.toHaveBeenCalled();
    });

    it("lists agreements for the thread", async () => {
      listThreadSettlementAgreements.mockResolvedValue({ success: true, value: [{ id: "agreement_1" }] });

      const response = await request(app).get(path);

      expect(response.status).toBe(200);
      expect(listThreadSettlementAgreements).toHaveBeenCalledWith(
        { organizationId: ORGANIZATION_ID, memberId: MEMBER_ID, actorUserId: "user_test_caller" },
        "thread_1",
      );
      expect(response.body.data.items).toEqual([{ id: "agreement_1" }]);
    });

    /**
     * NOT_FOUND covers both "no such agreement" and "not your organization's thread" —
     * the controller's own docs say a distinguishable 403 would confirm a thread exists
     * between two specific organizations, which is a participant-enumeration leak.
     */
    it("maps NOT_FOUND to 404 for a thread this organization cannot see", async () => {
      listThreadSettlementAgreements.mockResolvedValue({ success: false, error: { type: "NOT_FOUND" } });

      const response = await request(app).get(path);

      expect(response.status).toBe(404);
    });
  });

  describe("POST /commerce/threads/:threadId/settlement-agreements", () => {
    const path = "/commerce/threads/thread_1/settlement-agreements";

    it("requires an Idempotency-Key header", async () => {
      const response = await request(app).post(path).send(VALID_AGREEMENT_BODY);

      expect(response.status).toBe(400);
      expect(proposeSettlementAgreement).not.toHaveBeenCalled();
    });

    it("proposes the agreement and answers 201", async () => {
      proposeSettlementAgreement.mockResolvedValue({ success: true, value: { id: "agreement_1", state: "proposed" } });

      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "settlement_propose_key_1")
        .send(VALID_AGREEMENT_BODY);

      expect(response.status).toBe(201);
      expect(proposeSettlementAgreement).toHaveBeenCalledWith(
        { organizationId: ORGANIZATION_ID, memberId: MEMBER_ID, actorUserId: "user_test_caller" },
        expect.objectContaining({
          threadId: "thread_1",
          buyerOrganizationId: "commerce_org_buyer",
          sellerOrganizationId: "commerce_org_seller",
          escrowFeeBearer: "split",
          totalInCents: 100_000,
        }),
      );
    });

    it("replays the cached response for a repeated Idempotency-Key", async () => {
      proposeSettlementAgreement.mockResolvedValue({ success: true, value: { id: "agreement_1", state: "proposed" } });

      const first = await request(app)
        .post(path)
        .set("Idempotency-Key", "settlement_propose_key_2")
        .send(VALID_AGREEMENT_BODY);
      const second = await request(app)
        .post(path)
        .set("Idempotency-Key", "settlement_propose_key_2")
        .send(VALID_AGREEMENT_BODY);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.headers["idempotency-replayed"]).toBe("true");
      expect(proposeSettlementAgreement).toHaveBeenCalledTimes(1);
    });

    it("rejects a milestone plan over the 20-entry cap with 422", async () => {
      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "settlement_propose_key_3")
        .send({
          ...VALID_AGREEMENT_BODY,
          milestones: Array.from({ length: 21 }, (_unused, index) => ({
            sequence: index + 1,
            milestoneKind: "deposit",
            amountInCents: 1_000,
            releaseConditionNote: null,
          })),
        });

      expect(response.status).toBe(422);
      expect(proposeSettlementAgreement).not.toHaveBeenCalled();
    });

    it("rejects an unknown escrowFeeBearer value with 422", async () => {
      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "settlement_propose_key_4")
        .send({ ...VALID_AGREEMENT_BODY, escrowFeeBearer: "platform" });

      expect(response.status).toBe(422);
      expect(proposeSettlementAgreement).not.toHaveBeenCalled();
    });

    it("maps PROVIDER_INELIGIBLE to 422", async () => {
      proposeSettlementAgreement.mockResolvedValue({
        success: false,
        error: { type: "PROVIDER_INELIGIBLE", reason: "currency_unsupported" },
      });

      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "settlement_propose_key_5")
        .send(VALID_AGREEMENT_BODY);

      expect(response.status).toBe(422);
    });
  });

  describe("POST /commerce/settlement-agreements/:agreementId/responses", () => {
    const path = "/commerce/settlement-agreements/agreement_1/responses";

    it("requires an Idempotency-Key header", async () => {
      const response = await request(app).post(path).send({ response: "accept" });

      expect(response.status).toBe(400);
      expect(respondToSettlementAgreement).not.toHaveBeenCalled();
    });

    it("accepts and passes the resolved actor through", async () => {
      respondToSettlementAgreement.mockResolvedValue({
        success: true,
        value: { id: "agreement_1", state: "accepted" },
      });

      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "settlement_respond_key_1")
        .send({ response: "accept" });

      expect(response.status).toBe(200);
      expect(respondToSettlementAgreement).toHaveBeenCalledWith(
        { organizationId: ORGANIZATION_ID, memberId: MEMBER_ID, actorUserId: "user_test_caller" },
        "agreement_1",
        "accept",
      );
    });

    it("rejects an unknown response value with 422", async () => {
      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "settlement_respond_key_2")
        .send({ response: "maybe" });

      expect(response.status).toBe(422);
      expect(respondToSettlementAgreement).not.toHaveBeenCalled();
    });

    /**
     * The self-dealing rule: a proposer cannot also be the one who accepts their own
     * proposal. 409, not 403 — the caller is authorized to respond, the request itself is
     * the conflict, mirroring the compensation module's SELF_COUNTERSIGN_FORBIDDEN posture.
     */
    it("maps SELF_ACCEPTANCE_FORBIDDEN to 409", async () => {
      respondToSettlementAgreement.mockResolvedValue({
        success: false,
        error: { type: "SELF_ACCEPTANCE_FORBIDDEN" },
      });

      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "settlement_respond_key_3")
        .send({ response: "accept" });

      expect(response.status).toBe(409);
    });

    it("maps AGREEMENT_EXPIRED to 409", async () => {
      respondToSettlementAgreement.mockResolvedValue({
        success: false,
        error: { type: "AGREEMENT_EXPIRED", expiredAt: new Date("2026-01-01T00:00:00.000Z") },
      });

      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "settlement_respond_key_4")
        .send({ response: "accept" });

      expect(response.status).toBe(409);
    });

    it("maps AGREEMENT_NOT_OPEN to 409 for an already-decided proposal", async () => {
      respondToSettlementAgreement.mockResolvedValue({
        success: false,
        error: { type: "AGREEMENT_NOT_OPEN", state: "declined" },
      });

      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "settlement_respond_key_5")
        .send({ response: "accept" });

      expect(response.status).toBe(409);
    });
  });
});
