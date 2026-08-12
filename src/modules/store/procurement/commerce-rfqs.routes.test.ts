import type { Express, NextFunction, Request, Response } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut, TEST_SESSION_USER } from "#src/test-support/auth-mock.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

const BUYER_ORGANIZATION_ID = "00000000-0000-4000-8000-0000000000b1";
const MEMBER_ID = "00000000-0000-4000-8000-0000000000m1";
const RFQ_ID = "00000000-0000-4000-8000-0000000000f1";

const idempotencyResponses = vi.hoisted(
  () => new Map<string, { fingerprint: string; statusCode: number; body: unknown }>(),
);

vi.mock("#src/middleware/idempotency.js", () => ({
  idempotency:
    (options: { readonly required?: boolean } = {}) =>
    (req: Request, res: Response, next: NextFunction): void => {
      const header = req.header("Idempotency-Key");
      if (!header && options.required === true) {
        res.status(400).json({
          status: "error",
          statusCode: 400,
          message: "This request requires an Idempotency-Key header.",
        });
        return;
      }
      if (!header) {
        next();
        return;
      }
      const fingerprint = JSON.stringify(req.body);
      const cached = idempotencyResponses.get(header);
      if (cached) {
        if (cached.fingerprint !== fingerprint) {
          res.status(409).json({
            status: "error",
            statusCode: 409,
            message: "This Idempotency-Key was already used for a different request.",
          });
          return;
        }
        res.setHeader("Idempotency-Replayed", "true");
        res.status(cached.statusCode).json(cached.body);
        return;
      }

      const originalJson = res.json.bind(res);
      res.json = (body: unknown): Response => {
        if (res.statusCode >= 200 && res.statusCode <= 299) {
          idempotencyResponses.set(header, {
            fingerprint,
            statusCode: res.statusCode,
            body,
          });
        }
        return originalJson(body);
      };
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
  createDraftRfq: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  listMyRfqs: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  getRfq: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  updateDraftRfq: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  openRfq: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  inviteProviders: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  closeRfq: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  listProviderRfqs: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

vi.mock("#src/modules/store/procurement/commerce-rfqs.service.js", () => serviceStubs);

const CREATE_BODY = {
  title: "Need pallet freight",
  visibility: "invited_only",
  responseDeadlineAt: "2030-01-01T00:00:00.000Z",
  settlementCurrency: "USD",
  productLines: [
    {
      requestedTitle: "Widget",
      requestedSpecificationSnapshot: "Steel widget, grade A",
      quantity: 100,
      unitLabel: "pcs",
      siblingOrder: 0,
    },
  ],
  serviceLines: [
    {
      providerKind: "freight_forwarder",
      requirementSummary: "Sea freight to IN",
      siblingOrder: 0,
      requirementDetail: {
        providerKind: "freight_forwarder",
        transportModes: ["sea"],
      },
    },
  ],
};

describe("commerce RFQ routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    idempotencyResponses.clear();
    signInAs();
  });

  it("returns 422 on bad create body", async () => {
    const response = await request(app)
      .post("/commerce/rfqs")
      .set("Idempotency-Key", "rfq-create-bad")
      .send({ title: "", visibility: "invited_only" });

    expect(response.status).toBe(422);
    expect(serviceStubs.createDraftRfq).not.toHaveBeenCalled();
  });

  it("returns 401 without auth", async () => {
    signOut();

    const response = await request(app)
      .post("/commerce/rfqs")
      .set("Idempotency-Key", "rfq-create-unauth")
      .send(CREATE_BODY);

    expect(response.status).toBe(401);
    expect(serviceStubs.createDraftRfq).not.toHaveBeenCalled();
  });

  it("requires Idempotency-Key for create", async () => {
    const response = await request(app).post("/commerce/rfqs").send(CREATE_BODY);

    expect(response.status).toBe(400);
    expect(serviceStubs.createDraftRfq).not.toHaveBeenCalled();
  });

  it("lists mine with mocked success", async () => {
    serviceStubs.listMyRfqs.mockResolvedValue({
      success: true,
      value: {
        items: [
          {
            id: RFQ_ID,
            buyerOrganizationId: BUYER_ORGANIZATION_ID,
            title: "Need pallet freight",
            state: "draft",
            visibility: "invited_only",
            responseDeadlineAt: "2030-01-01T00:00:00.000Z",
            settlementCurrency: "USD",
            openedAt: null,
            closedAt: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        page: { nextCursor: null, hasMore: false },
      },
    });

    const response = await request(app).get("/commerce/rfqs/mine");

    expect(response.status).toBe(200);
    expect(response.body.data.items).toHaveLength(1);
    expect(serviceStubs.listMyRfqs).toHaveBeenCalledWith({
      buyerOrganizationId: BUYER_ORGANIZATION_ID,
      limit: undefined,
      cursor: undefined,
    });
  });

  it("maps open INVALID_STATE to 409", async () => {
    serviceStubs.openRfq.mockResolvedValue({
      success: false,
      error: { type: "INVALID_STATE", message: "Only draft RFQs can be opened." },
    });

    const response = await request(app)
      .post(`/commerce/rfqs/${RFQ_ID}/open`)
      .set("Idempotency-Key", "rfq-open-1")
      .send({});

    expect(response.status).toBe(409);
    expect(serviceStubs.openRfq).toHaveBeenCalledWith(
      expect.objectContaining({
        rfqId: RFQ_ID,
        buyerOrganizationId: BUYER_ORGANIZATION_ID,
        actorUserId: TEST_SESSION_USER.id,
      }),
    );
  });
});
