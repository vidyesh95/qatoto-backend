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

const PROVIDER_ORGANIZATION_ID = "commerce_org_provider_quotes";
const BUYER_ORGANIZATION_ID = "commerce_org_buyer_quotes";

const idempotencyCache = vi.hoisted(() => new Map<string, { statusCode: number; body: unknown }>());

vi.mock("#src/middleware/idempotency.js", () => ({
  idempotency:
    () =>
    (req: Request, res: Response, next: NextFunction): void => {
      const key = req.header("Idempotency-Key");
      if (!key) {
        res.status(400).json({
          status: "error",
          statusCode: 400,
          message: "Idempotency-Key header is required.",
        });
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

const activeRole = vi.hoisted(() => ({
  value: "provider" as "provider" | "buyer" | "generic",
}));

vi.mock("#src/middleware/require-active-commerce-organization.js", () => ({
  requireActiveCommerceOrganization: (req: Request, _res: Response, next: NextFunction): void => {
    req.commerceOrganization = {
      organizationId: activeRole.value === "buyer" ? BUYER_ORGANIZATION_ID : PROVIDER_ORGANIZATION_ID,
      memberId: "member-quotes",
      memberRole: activeRole.value === "buyer" ? "buyer" : "provider_operator",
      tradeState: "active",
    };
    next();
  },
  requireActiveBuyerCommerceOrganization: (req: Request, _res: Response, next: NextFunction): void => {
    req.commerceOrganization = {
      organizationId: BUYER_ORGANIZATION_ID,
      memberId: "member-buyer-quotes",
      memberRole: "buyer",
      tradeState: "active",
    };
    next();
  },
  requireActiveProviderCommerceOrganization: (req: Request, _res: Response, next: NextFunction): void => {
    req.commerceOrganization = {
      organizationId: PROVIDER_ORGANIZATION_ID,
      memberId: "member-provider-quotes",
      memberRole: "provider_operator",
      tradeState: "active",
    };
    next();
  },
  requireActiveSellerCommerceOrganization: (req: Request, _res: Response, next: NextFunction): void => {
    req.commerceOrganization = {
      organizationId: PROVIDER_ORGANIZATION_ID,
      memberId: "member-seller-quotes",
      memberRole: "seller",
      tradeState: "active",
    };
    next();
  },
}));

const serviceStubs = vi.hoisted(() => ({
  createQuoteShell: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  appendRevision: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  submitRevision: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  listQuotesForRfq: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  getQuote: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  acceptQuote: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  declineQuote: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  withdrawQuote: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

vi.mock("#src/services/commerce-quotes.service.js", () => serviceStubs);

describe("commerce quote routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
    const quotesRouter = (await import("#src/routes/commerce-quotes.routes.js")).default;
    app.use("/commerce", quotesRouter);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    idempotencyCache.clear();
    activeRole.value = "provider";
    signInAs();
  });

  it("requires Idempotency-Key and expectedRevision on accept", async () => {
    activeRole.value = "buyer";

    const missingKey = await request(app).post("/commerce/quotes/quote-1/accept").send({
      expectedRevision: 1,
    });
    expect(missingKey.status).toBe(400);
    expect(serviceStubs.acceptQuote).not.toHaveBeenCalled();

    const missingRevision = await request(app)
      .post("/commerce/quotes/quote-1/accept")
      .set("Idempotency-Key", "accept-missing-revision")
      .send({});
    expect(missingRevision.status).toBe(422);
    expect(serviceStubs.acceptQuote).not.toHaveBeenCalled();
  });

  it("returns 422 on a bad revision body", async () => {
    const response = await request(app)
      .post("/commerce/quotes/quote-1/revisions")
      .set("Idempotency-Key", "revision-bad-body")
      .send({
        currency: "usd",
        validityDeadlineAt: "not-a-date",
        taxInCents: -1,
        serviceFeeInCents: 0,
        shippingInCents: 0,
        discountInCents: 0,
        productLines: [],
        serviceLines: [],
      });

    expect(response.status).toBe(422);
    expect(serviceStubs.appendRevision).not.toHaveBeenCalled();
  });

  it("requires typed serviceDetail on every quote service line", async () => {
    const response = await request(app)
      .post("/commerce/quotes/quote-1/revisions")
      .set("Idempotency-Key", "revision-missing-service-detail")
      .send({
        currency: "USD",
        validityDeadlineAt: "2026-09-01T00:00:00.000Z",
        taxInCents: 0,
        serviceFeeInCents: 0,
        shippingInCents: 0,
        discountInCents: 0,
        productLines: [],
        serviceLines: [
          {
            rfqServiceLineId: "rfq_svc_1",
            feeInCents: 1000,
            titleSnapshot: "Customs brokerage",
            scopeSnapshot: "Import entry",
            siblingOrder: 0,
          },
        ],
      });

    expect(response.status).toBe(422);
    expect(serviceStubs.appendRevision).not.toHaveBeenCalled();
  });

  it("accepts a revision when serviceDetail matches provider kind shape", async () => {
    serviceStubs.appendRevision.mockResolvedValue({
      success: true,
      value: {
        id: "quote-1",
        latestRevisionNumber: 1,
        status: "draft",
      },
    });

    const response = await request(app)
      .post("/commerce/quotes/quote-1/revisions")
      .set("Idempotency-Key", "revision-with-service-detail")
      .send({
        currency: "USD",
        validityDeadlineAt: "2026-09-01T00:00:00.000Z",
        taxInCents: 0,
        serviceFeeInCents: 0,
        shippingInCents: 0,
        discountInCents: 0,
        productLines: [],
        serviceLines: [
          {
            rfqServiceLineId: "rfq_svc_1",
            feeInCents: 1000,
            titleSnapshot: "Customs brokerage",
            scopeSnapshot: "Import entry",
            siblingOrder: 0,
            serviceDetail: {
              kind: "customs_broker",
              jurisdictions: ["US-CBP"],
            },
          },
        ],
      });

    expect(response.status).toBe(201);
    expect(serviceStubs.appendRevision).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: PROVIDER_ORGANIZATION_ID }),
      "quote-1",
      expect.objectContaining({
        serviceLines: [
          expect.objectContaining({
            serviceDetail: {
              kind: "customs_broker",
              jurisdictions: ["US-CBP"],
            },
          }),
        ],
      }),
    );
  });

  it("maps REVISION_CHANGED from accept to 409", async () => {
    activeRole.value = "buyer";
    serviceStubs.acceptQuote.mockResolvedValue({
      success: false,
      error: { type: "REVISION_CHANGED", currentRevision: 3 },
    });

    const response = await request(app)
      .post("/commerce/quotes/quote-1/accept")
      .set("Idempotency-Key", "accept-stale-revision")
      .send({ expectedRevision: 2 });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      status: "error",
      statusCode: 409,
      data: { currentRevision: 3 },
    });
    expect(serviceStubs.acceptQuote).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: BUYER_ORGANIZATION_ID }),
      "quote-1",
      2,
    );
  });

  it("creates a quote shell on the happy path", async () => {
    serviceStubs.createQuoteShell.mockResolvedValue({
      success: true,
      value: {
        id: "quote-shell-1",
        rfqId: "rfq-1",
        providerOrganizationId: PROVIDER_ORGANIZATION_ID,
        status: "draft",
        latestRevisionNumber: 0,
        createdAt: new Date("2026-08-05T00:00:00.000Z"),
      },
    });

    const response = await request(app)
      .post("/commerce/rfqs/rfq-1/quotes")
      .set("Idempotency-Key", "quote-shell-1")
      .send({});

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      id: "quote-shell-1",
      rfqId: "rfq-1",
      status: "draft",
    });
    expect(serviceStubs.createQuoteShell).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: PROVIDER_ORGANIZATION_ID }),
      "rfq-1",
    );
  });
});
