import type { Express, NextFunction, Request, Response } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
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
  createReview: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  openDispute: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  listDisputesForModerator: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  decideDispute: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  getDisputeForParticipant: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  listDisputesForParticipant: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

vi.mock("#src/services/commerce-trust.service.js", () => serviceStubs);

/**
 * `GET /commerce/completions` is served by the completion service, not the trust one.
 * Only the two reads are stubbed; the rest of the module stays real so the routers that
 * `buildTestApp` mounts keep working.
 */
const completionStubs = vi.hoisted(() => ({
  listBuyerCompletions: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  loadOrderCompletionIndex: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

vi.mock("#src/services/commerce-completion.service.js", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("#src/services/commerce-completion.service.js")),
  ...completionStubs,
}));

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

  /**
   * The read that makes every review route below it reachable. Before it existed,
   * `completionId` was projected nowhere and a buyer could only reach
   * `POST /completions/:completionId/reviews` by guessing a UUID.
   */
  describe("GET /commerce/completions", () => {
    it("returns the buyer's completions with the caller's review state", async () => {
      completionStubs.listBuyerCompletions.mockResolvedValue({
        success: true,
        value: {
          items: [
            {
              completionId: "cmpl_1",
              targetKind: "product_order_line",
              orderId: "order_1",
              productId: "prd_1",
              counterpartyOrganization: {
                organizationId: "org_seller",
                slug: "acme-cooling",
                displayName: "Acme Cooling",
              },
              completedAt: new Date("2026-01-01T00:00:00.000Z"),
              hasReview: false,
            },
          ],
          page: { nextCursor: null, hasMore: false },
        },
      });

      const response = await request(app).get("/commerce/completions");

      expect(response.status).toBe(200);
      expect(response.body.data.items[0].completionId).toBe("cmpl_1");
      expect(response.body.data.items[0].hasReview).toBe(false);
      expect(response.body.data.page).toEqual({ nextCursor: null, hasMore: false });
    });

    /**
     * The organization must come from the session-derived middleware, never the query
     * string — §0. `.strict()` is what enforces it, so an attempt to name one is a 422
     * rather than a silently ignored parameter.
     */
    it("rejects an unknown query key with 422", async () => {
      const response = await request(app).get("/commerce/completions?buyerOrganizationId=someone-else");

      expect(response.status).toBe(422);
      expect(completionStubs.listBuyerCompletions).not.toHaveBeenCalled();
    });

    it("passes the session organization, never a client-supplied one", async () => {
      completionStubs.listBuyerCompletions.mockResolvedValue({
        success: true,
        value: { items: [], page: { nextCursor: null, hasMore: false } },
      });

      await request(app).get("/commerce/completions?reviewable=true&limit=5");

      expect(completionStubs.listBuyerCompletions).toHaveBeenCalledWith({
        buyerOrganizationId: BUYER_ORGANIZATION_ID,
        reviewable: true,
        limit: 5,
        cursor: undefined,
      });
    });

    it("rejects a limit above the page cap with 422", async () => {
      const response = await request(app).get("/commerce/completions?limit=500");

      expect(response.status).toBe(422);
      expect(completionStubs.listBuyerCompletions).not.toHaveBeenCalled();
    });

    it("maps INVALID_CURSOR to 422", async () => {
      completionStubs.listBuyerCompletions.mockResolvedValue({
        success: false,
        error: { type: "INVALID_CURSOR" },
      });

      const response = await request(app).get("/commerce/completions?cursor=not-a-cursor");

      expect(response.status).toBe(422);
    });

    it("requires a signed-in caller", async () => {
      signOut();

      const response = await request(app).get("/commerce/completions");

      expect(response.status).toBe(401);
      expect(completionStubs.listBuyerCompletions).not.toHaveBeenCalled();
    });
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

  it("replays review creation without invoking the trust module twice", async () => {
    serviceStubs.createReview.mockResolvedValue({
      success: true,
      value: {
        id: "review_replay",
        completionId: "cmpl_1",
        subjectOrganizationId: "commerce_org_seller",
        productId: "prd_1",
        rating: 5,
        body: "Excellent quality",
        visibility: "visible",
        createdAt: "2026-08-06T00:00:00.000Z",
      },
    });

    const firstResponse = await request(app)
      .post("/commerce/completions/cmpl_1/reviews")
      .set("Idempotency-Key", "review-replay-key")
      .send({ rating: 5, body: "Excellent quality" });
    const replayResponse = await request(app)
      .post("/commerce/completions/cmpl_1/reviews")
      .set("Idempotency-Key", "review-replay-key")
      .send({ rating: 5, body: "Excellent quality" });

    expect(firstResponse.status).toBe(201);
    expect(replayResponse.status).toBe(201);
    expect(replayResponse.headers["idempotency-replayed"]).toBe("true");
    expect(serviceStubs.createReview).toHaveBeenCalledTimes(1);
  });

  it("maps duplicate review conflicts to 409", async () => {
    serviceStubs.createReview.mockResolvedValue({
      success: false,
      error: { type: "CONFLICT", message: "Already reviewed." },
    });

    const response = await request(app)
      .post("/commerce/completions/cmpl_1/reviews")
      .set("Idempotency-Key", "review-conflict-key")
      .send({ rating: 4, body: "Already submitted" });

    expect(response.status).toBe(409);
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

  it("maps a second open dispute to 409", async () => {
    serviceStubs.openDispute.mockResolvedValue({
      success: false,
      error: { type: "CONFLICT", message: "An open dispute already exists." },
    });

    const response = await request(app)
      .post("/commerce/orders/order_1/disputes")
      .set("Idempotency-Key", "dispute-conflict-key")
      .send({ reasonCode: "quality_issue", summary: "Duplicate dispute" });

    expect(response.status).toBe(409);
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

  it("rejects unknown moderator list query keys with 422", async () => {
    const response = await request(app).get("/commerce/admin/disputes?unexpected=true");

    expect(response.status).toBe(422);
    expect(serviceStubs.listDisputesForModerator).not.toHaveBeenCalled();
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

  it("rejects dispute decisions by members of either dispute party", async () => {
    serviceStubs.decideDispute.mockResolvedValue({
      success: false,
      error: { type: "DISPUTE_PARTY_MODERATION_FORBIDDEN" },
    });

    const response = await request(app)
      .post("/commerce/admin/disputes/dispute_1/decisions")
      .set("Idempotency-Key", "decide-party-key")
      .send({ decision: "dismissed" });

    expect(response.status).toBe(403);
    expect(response.body.message).toContain("dispute party");
  });

  /**
   * A28. Before these routes a buyer could file a dispute and had nothing that answered
   * "what is happening with it" — the only readers were platform staff.
   */
  describe("participant dispute reads", () => {
    it("returns a dispute the caller's organization is a party to, with its timeline", async () => {
      serviceStubs.getDisputeForParticipant.mockResolvedValue({
        success: true,
        value: {
          id: "dispute_1",
          orderId: "order_1",
          state: "closed",
          reasonCode: "goods_not_as_described",
          summary: "Freezer arrived with a damaged compressor.",
          priorOrderState: "completed",
          buyerOrganizationId: BUYER_ORGANIZATION_ID,
          counterpartyOrganizationId: "org_seller",
          openedByOrganizationId: BUYER_ORGANIZATION_ID,
          createdAt: new Date("2026-02-01T00:00:00.000Z"),
          decidedAt: new Date("2026-02-09T00:00:00.000Z"),
          decisionNote: "Replacement shipped.",
          timeline: [
            {
              sequence: 0,
              eventKind: "opened",
              note: null,
              occurredAt: new Date("2026-02-01T00:00:00.000Z"),
            },
            {
              sequence: 1,
              eventKind: "closed",
              note: "Replacement shipped.",
              occurredAt: new Date("2026-02-09T00:00:00.000Z"),
            },
          ],
        },
      });

      const response = await request(app).get("/commerce/disputes/dispute_1");

      expect(response.status).toBe(200);
      expect(response.body.data.id).toBe("dispute_1");
      expect(response.body.data.decisionNote).toBe("Replacement shipped.");
      expect(response.body.data.timeline).toHaveLength(2);
      expect(serviceStubs.getDisputeForParticipant).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: BUYER_ORGANIZATION_ID }),
        "dispute_1",
      );
    });

    /**
     * 404, never 403. Both refusals must be indistinguishable or the route becomes an
     * oracle for which dispute ids exist, and a dispute id names two organizations and a
     * commercial disagreement between them.
     */
    it("answers 404 to a caller who is not a party, exactly as it does for a missing row", async () => {
      serviceStubs.getDisputeForParticipant.mockResolvedValue({
        success: false,
        error: { type: "NOT_FOUND" },
      });

      const response = await request(app).get("/commerce/disputes/someone-elses-dispute");

      expect(response.status).toBe(404);
    });

    it("lists the caller's disputes and passes the state filter through", async () => {
      serviceStubs.listDisputesForParticipant.mockResolvedValue({
        success: true,
        value: { items: [], page: { nextCursor: null, hasMore: false } },
      });

      const response = await request(app).get("/commerce/disputes?state=open&limit=5");

      expect(response.status).toBe(200);
      expect(serviceStubs.listDisputesForParticipant).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: BUYER_ORGANIZATION_ID }),
        expect.objectContaining({ state: "open", limit: 5 }),
      );
    });

    it("rejects an unknown query key rather than ignoring it", async () => {
      const response = await request(app).get("/commerce/disputes?stat=open");

      expect(response.status).toBe(422);
      expect(serviceStubs.listDisputesForParticipant).not.toHaveBeenCalled();
    });

    it("maps an unusable cursor to 422", async () => {
      serviceStubs.listDisputesForParticipant.mockResolvedValue({
        success: false,
        error: { type: "INVALID_CURSOR" },
      });

      const response = await request(app).get("/commerce/disputes?cursor=nonsense");

      expect(response.status).toBe(422);
    });

    it("requires a session", async () => {
      signOut();

      const response = await request(app).get("/commerce/disputes/dispute_1");

      expect(response.status).toBe(401);
      expect(serviceStubs.getDisputeForParticipant).not.toHaveBeenCalled();
    });
  });
});
