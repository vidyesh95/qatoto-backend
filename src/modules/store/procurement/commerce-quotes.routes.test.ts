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

vi.mock("#src/modules/store/organizations/require-active-commerce-organization.js", () => ({
  // Phase 9 authoring routes attach an organization optionally, because a platform
  // merchandiser may not belong to one. Mounted through app.ts, so every suite that
  // mocks this module must provide it.
  attachOptionalSellerCommerceOrganization: (_req: Request, _res: Response, next: NextFunction): void => {
    next();
  },
  requireActiveCommerceOrganization: (req: Request, _res: Response, next: NextFunction): void => {
    req.commerceOrganization = {
      organizationId: activeRole.value === "buyer" ? BUYER_ORGANIZATION_ID : PROVIDER_ORGANIZATION_ID,
      memberId: "member-quotes",
      memberRole: activeRole.value === "buyer" ? "buyer" : "provider_operator",
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

vi.mock("#src/modules/store/procurement/commerce-quotes.service.js", () => serviceStubs);

describe("commerce quote routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
    const quotesRouter = (await import("#src/modules/store/procurement/commerce-quotes.routes.js")).default;
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

  /**
   * A40. `incoterm` was `z.string().max(20)` and accepted anything — and
   * `commerce_prevent_submitted_quote_revision_mutation` then froze the bad value on the
   * revision permanently, so it could not even be corrected afterwards.
   */
  it("refuses an incoterm that is not one the ICC publishes", async () => {
    const response = await request(app)
      .post("/commerce/quotes/quote-1/revisions")
      .set("Idempotency-Key", "revision-bad-incoterm")
      .send({
        currency: "USD",
        validityDeadlineAt: "2026-09-01T00:00:00.000Z",
        taxInCents: 0,
        serviceFeeInCents: 0,
        shippingInCents: 0,
        discountInCents: 0,
        incoterm: "BANANA",
        productLines: [],
        serviceLines: [],
      });

    // 422 rather than a silent drop: an incoterm is a commercial term the seller meant to
    // state, and discarding it would ship an order whose delivery terms nobody agreed.
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
            deliverables: [
              {
                sequence: 0,
                title: "Accepted customs entry",
                isRequired: true,
                dueAt: "2026-08-20T00:00:00.000Z",
              },
            ],
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
            deliverables: [
              {
                sequence: 0,
                title: "Accepted customs entry",
                isRequired: true,
                dueAt: new Date("2026-08-20T00:00:00.000Z"),
              },
            ],
            serviceDetail: {
              kind: "customs_broker",
              jurisdictions: ["US-CBP"],
            },
          }),
        ],
      }),
    );
  });

  it("rejects duplicate RFQ line identities before quote persistence", async () => {
    const duplicateServiceLine = {
      rfqServiceLineId: "rfq_svc_1",
      feeInCents: 1000,
      titleSnapshot: "Customs brokerage",
      scopeSnapshot: "Import entry",
      siblingOrder: 0,
      deliverables: [],
      serviceDetail: {
        kind: "customs_broker",
        jurisdictions: ["US-CBP"],
      },
    };
    const response = await request(app)
      .post("/commerce/quotes/quote-1/revisions")
      .set("Idempotency-Key", "revision-duplicate-rfq-lines")
      .send({
        currency: "USD",
        validityDeadlineAt: "2026-09-01T00:00:00.000Z",
        taxInCents: 0,
        serviceFeeInCents: 0,
        shippingInCents: 0,
        discountInCents: 0,
        productLines: [],
        serviceLines: [duplicateServiceLine, { ...duplicateServiceLine, siblingOrder: 1 }],
      });

    expect(response.status).toBe(422);
    expect(serviceStubs.appendRevision).not.toHaveBeenCalled();
  });

  it("rejects duplicate deliverable sequences and unpaired service-detail currencies", async () => {
    const duplicateDeliverablesResponse = await request(app)
      .post("/commerce/quotes/quote-1/revisions")
      .set("Idempotency-Key", "revision-duplicate-deliverables")
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
            titleSnapshot: "Cargo insurance",
            scopeSnapshot: "Transit coverage",
            siblingOrder: 0,
            deliverables: [
              { sequence: 0, title: "Policy", isRequired: true },
              { sequence: 0, title: "Certificate", isRequired: true },
            ],
            serviceDetail: {
              kind: "insurance_provider",
              coverageClasses: ["cargo"],
              coverageLimitInCents: 100_000,
              currency: "USD",
            },
          },
        ],
      });
    expect(duplicateDeliverablesResponse.status).toBe(422);

    const missingCurrencyResponse = await request(app)
      .post("/commerce/quotes/quote-1/revisions")
      .set("Idempotency-Key", "revision-missing-detail-currency")
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
            titleSnapshot: "Cargo insurance",
            scopeSnapshot: "Transit coverage",
            siblingOrder: 0,
            serviceDetail: {
              kind: "insurance_provider",
              coverageClasses: ["cargo"],
              coverageLimitInCents: 100_000,
            },
          },
        ],
      });
    expect(missingCurrencyResponse.status).toBe(422);
    expect(serviceStubs.appendRevision).not.toHaveBeenCalled();
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
      /**
       * STORE Phase 14. An acceptance that names no settlement agreement passes `null`
       * explicitly rather than omitting the argument. Asserted rather than loosened,
       * because the default it selects is the UNPROTECTED rail — if a future change
       * started passing something else here, buyers who agreed to nothing would silently
       * acquire escrow terms, or worse, the reverse.
       */
      null,
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

  it("returns typed service details and contracted deliverable plans on quote reads", async () => {
    serviceStubs.getQuote.mockResolvedValue({
      success: true,
      value: {
        id: "quote-1",
        latestRevision: {
          serviceLines: [
            {
              id: "quote-service-line-1",
              serviceDetail: {
                kind: "customs_broker",
                jurisdictions: ["US-CBP"],
                filingSummary: "Import entry",
              },
              deliverables: [
                {
                  id: "quote-deliverable-plan-1",
                  sequence: 0,
                  title: "Accepted customs entry",
                  isRequired: true,
                },
              ],
            },
          ],
        },
      },
    });

    const response = await request(app).get("/commerce/quotes/quote-1");

    expect(response.status).toBe(200);
    expect(response.body.data.latestRevision.serviceLines[0]).toMatchObject({
      serviceDetail: {
        kind: "customs_broker",
        jurisdictions: ["US-CBP"],
      },
      deliverables: [
        {
          sequence: 0,
          title: "Accepted customs entry",
          isRequired: true,
        },
      ],
    });
  });
});
