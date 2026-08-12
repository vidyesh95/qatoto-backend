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

const ORGANIZATION_ID = "commerce_org_provider_1";

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
      memberId: "member-provider",
      memberRole: "provider_operator",
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
      memberId: "member-provider",
      memberRole: "provider_operator",
      tradeState: "active",
    };
    next();
  },
  requireActiveSellerCommerceOrganization: (req: Request, _res: Response, next: NextFunction): void => {
    req.commerceOrganization = {
      organizationId: ORGANIZATION_ID,
      memberId: "member-provider",
      memberRole: "seller",
      tradeState: "active",
    };
    next();
  },
  requireActiveBuyerCommerceOrganization: (req: Request, _res: Response, next: NextFunction): void => {
    req.commerceOrganization = {
      organizationId: ORGANIZATION_ID,
      memberId: "member-buyer",
      memberRole: "buyer",
      tradeState: "active",
    };
    next();
  },
  requireActiveProviderCommerceOrganization: (req: Request, _res: Response, next: NextFunction): void => {
    req.commerceOrganization = {
      organizationId: ORGANIZATION_ID,
      memberId: "member-provider",
      memberRole: "provider_operator",
      tradeState: "active",
    };
    next();
  },
}));

const serviceStubs = vi.hoisted(() => ({
  assertOrganizationContextMatch: vi.fn<
    (input: {
      activeOrganizationId: string;
      routeOrganizationId: string;
    }) => { success: true; value: true } | { success: false; error: { type: "ORGANIZATION_CONTEXT_MISMATCH" } }
  >((input) => {
    if (input.activeOrganizationId !== input.routeOrganizationId) {
      return { success: false, error: { type: "ORGANIZATION_CONTEXT_MISMATCH" } };
    }
    return { success: true, value: true };
  }),
  upsertProviderProfile: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  addProviderKindLink: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  createServiceOffering: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  updateServiceOffering: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  submitServiceOffering: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  setOfferingCoverage: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  listMineOfferings: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  moderateServiceOffering: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  moderateProduct: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  linkSupplierToCommerceOrganization: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

vi.mock("#src/modules/store/procurement/commerce-providers.service.js", () => serviceStubs);

describe("commerce provider routes", () => {
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

  it("requires an idempotency key on provider profile writes", async () => {
    const response = await request(app).post("/commerce/providers/profile").send({
      publicSummary: "We move freight.",
    });

    expect(response.status).toBe(400);
    expect(serviceStubs.upsertProviderProfile).not.toHaveBeenCalled();
  });

  it("rejects client-supplied providerOrganizationId on offering create", async () => {
    const response = await request(app)
      .post("/commerce/providers/offerings")
      .set("Idempotency-Key", "offer-1")
      .send({
        providerOrganizationId: "org-attacker",
        providerKind: "freight_forwarder",
        title: "Air freight",
        pricingModel: "quote_only",
        detail: {
          kind: "freight_forwarder",
          transportModes: ["air"],
          supportsConsolidation: true,
          supportsContainers: false,
          supportsHazardousGoods: false,
        },
      });

    expect(response.status).toBe(422);
    expect(serviceStubs.createServiceOffering).not.toHaveBeenCalled();
  });

  it("rejects detail.kind that does not match providerKind", async () => {
    const response = await request(app)
      .post("/commerce/providers/offerings")
      .set("Idempotency-Key", "offer-2")
      .send({
        providerKind: "freight_forwarder",
        title: "Air freight",
        pricingModel: "quote_only",
        detail: {
          kind: "customs_broker",
          jurisdictions: ["IN"],
          importSupported: true,
          exportSupported: true,
        },
      });

    expect(response.status).toBe(422);
    expect(serviceStubs.createServiceOffering).not.toHaveBeenCalled();
  });

  it("creates offerings under the active organization context", async () => {
    serviceStubs.createServiceOffering.mockResolvedValue({
      success: true,
      value: { id: "offering-1", slug: "air-freight-abcd1234", state: "draft" },
    });

    const response = await request(app)
      .post("/commerce/providers/offerings")
      .set("Idempotency-Key", "offer-3")
      .send({
        providerKind: "freight_forwarder",
        title: "Air freight",
        pricingModel: "quote_only",
        detail: {
          kind: "freight_forwarder",
          transportModes: ["air"],
          supportsConsolidation: true,
          supportsContainers: false,
          supportsHazardousGoods: false,
        },
      });

    expect(response.status).toBe(201);
    expect(serviceStubs.createServiceOffering).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORGANIZATION_ID,
        providerKind: "freight_forwarder",
      }),
    );
  });

  it("maps missing provider capability to 403", async () => {
    serviceStubs.upsertProviderProfile.mockResolvedValue({
      success: false,
      error: { type: "FORBIDDEN" },
    });

    const response = await request(app)
      .post("/commerce/providers/profile")
      .set("Idempotency-Key", "profile-1")
      .send({ publicSummary: "Hello" });

    expect(response.status).toBe(403);
  });

  it("maps cross-org offering update to 404", async () => {
    serviceStubs.updateServiceOffering.mockResolvedValue({
      success: false,
      error: { type: "NOT_FOUND" },
    });

    const response = await request(app)
      .patch("/commerce/service-offerings/offering-missing")
      .set("Idempotency-Key", "patch-1")
      .send({ title: "Renamed" });

    expect(response.status).toBe(404);
  });

  it("submits draft offerings for review", async () => {
    serviceStubs.submitServiceOffering.mockResolvedValue({
      success: true,
      value: { id: "offering-1", state: "pending_review" },
    });

    const response = await request(app)
      .post("/commerce/service-offerings/offering-1/submit")
      .set("Idempotency-Key", "submit-1")
      .send({});

    expect(response.status).toBe(200);
    expect(serviceStubs.submitServiceOffering).toHaveBeenCalledWith(
      expect.objectContaining({ offeringId: "offering-1", organizationId: ORGANIZATION_ID }),
    );
  });

  it("moderates offerings without requiring active organization context", async () => {
    serviceStubs.moderateServiceOffering.mockResolvedValue({
      success: true,
      value: { id: "offering-1", state: "active" },
    });

    const response = await request(app)
      .post("/commerce/admin/service-offerings/offering-1/moderate")
      .set("Idempotency-Key", "mod-1")
      .send({ decision: "approve" });

    expect(response.status).toBe(200);
    expect(serviceStubs.moderateServiceOffering).toHaveBeenCalledWith(
      expect.objectContaining({ offeringId: "offering-1", decision: "approve" }),
    );
  });

  it("links suppliers without copying verification onto the provider profile", async () => {
    serviceStubs.linkSupplierToCommerceOrganization.mockResolvedValue({
      success: true,
      value: {
        id: "supplier-1",
        commerceOrganizationId: ORGANIZATION_ID,
        verificationState: "unverified",
      },
    });

    const response = await request(app)
      .post("/commerce/admin/suppliers/supplier-1/link-organization")
      .set("Idempotency-Key", "link-1")
      .send({ commerceOrganizationId: ORGANIZATION_ID });

    expect(response.status).toBe(200);
    expect(response.body.data.verificationState).toBe("unverified");
    expect(serviceStubs.linkSupplierToCommerceOrganization).toHaveBeenCalledWith(
      expect.objectContaining({
        supplierId: "supplier-1",
        commerceOrganizationId: ORGANIZATION_ID,
      }),
    );
  });

  it("accepts organization-scoped profile routes matching the active org", async () => {
    serviceStubs.upsertProviderProfile.mockResolvedValue({
      success: true,
      value: { organizationId: ORGANIZATION_ID, verificationState: "unverified" },
    });

    const response = await request(app)
      .post(`/commerce/providers/${ORGANIZATION_ID}/profile`)
      .set("Idempotency-Key", "profile-scoped-1")
      .send({ publicSummary: "Scoped profile" });

    expect(response.status).toBe(200);
    expect(serviceStubs.upsertProviderProfile).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORGANIZATION_ID }),
    );
  });

  it("rejects organization-scoped routes when the active org mismatches", async () => {
    const response = await request(app)
      .post("/commerce/providers/commerce_org_other/profile")
      .set("Idempotency-Key", "profile-scoped-mismatch")
      .send({ publicSummary: "Nope" });

    expect(response.status).toBe(403);
    expect(serviceStubs.upsertProviderProfile).not.toHaveBeenCalled();
  });
});
