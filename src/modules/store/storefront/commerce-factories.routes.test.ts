import type { Express, NextFunction, Request, Response } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

vi.mock("#src/middleware/require-identified-user.js", () => ({
  requireIdentifiedUser: (_req: Request, _res: Response, next: NextFunction): void => next(),
  isIdentifiedUser: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
}));

const ORG_ID = "org_factory_test_123";
const MEMBER_ID = "mem_factory_test_456";

function attachCommerceOrganization(req: Request, _res: Response, next: NextFunction): void {
  req.commerceOrganization = {
    organizationId: ORG_ID,
    memberId: MEMBER_ID,
    memberRole: "owner",
    tradeState: "active",
  };
  next();
}

vi.mock("#src/modules/store/organizations/require-active-commerce-organization.js", () => ({
  attachOptionalSellerCommerceOrganization: attachCommerceOrganization,
  requireActiveCommerceOrganization: attachCommerceOrganization,
  requireActiveBuyerCommerceOrganization: attachCommerceOrganization,
  requireActiveProviderCommerceOrganization: attachCommerceOrganization,
  requireActiveSellerCommerceOrganization: attachCommerceOrganization,
  requireProvisionedBuyerCommerceWorkspace: attachCommerceOrganization,
}));

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

const mockManufacturingInquiryService = vi.hoisted(() => ({
  createManufacturingInquiry: vi.fn<(...args: readonly unknown[]) => unknown>(),
  listBuyerManufacturingInquiries: vi.fn<(...args: readonly unknown[]) => unknown>(),
  listFactoryManufacturingInquiries: vi.fn<(...args: readonly unknown[]) => unknown>(),
  getManufacturingInquiry: vi.fn<(...args: readonly unknown[]) => unknown>(),
  sendManufacturingInquiry: vi.fn<(...args: readonly unknown[]) => unknown>(),
  answerManufacturingInquiry: vi.fn<(...args: readonly unknown[]) => unknown>(),
  closeManufacturingInquiry: vi.fn<(...args: readonly unknown[]) => unknown>(),
}));

vi.mock(
  "#src/modules/store/procurement/commerce-manufacturing-inquiry.service.js",
  () => mockManufacturingInquiryService,
);

const mockSellerProfileService = vi.hoisted(() => ({
  replaceProductionLines: vi.fn<(...args: readonly unknown[]) => unknown>(),
  replaceOrganizationSites: vi.fn<(...args: readonly unknown[]) => unknown>(),
  replaceFactoryTerms: vi.fn<(...args: readonly unknown[]) => unknown>(),
  listSiteAudits: vi.fn<(...args: readonly unknown[]) => unknown>(),
  recordSiteAudit: vi.fn<(...args: readonly unknown[]) => unknown>(),
  withdrawSiteAudit: vi.fn<(...args: readonly unknown[]) => unknown>(),
}));

vi.mock("#src/modules/store/organizations/commerce-seller-profile.service.js", () => mockSellerProfileService);

describe("commerce-factories.routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    idempotencyCache.clear();
    await resetRateLimiters();
    vi.clearAllMocks();
  });

  describe("Inquiries Endpoints", () => {
    it("refuses unauthenticated callers with 401 on GET /factories/inquiries/mine", async () => {
      signOut();
      const response = await request(app).get("/commerce/factories/inquiries/mine");
      expect(response.status).toBe(401);
    });

    it("returns 200 with list of inquiries for caller on GET /factories/inquiries/mine", async () => {
      signInAs({ id: "user_factory_1" });
      mockManufacturingInquiryService.listBuyerManufacturingInquiries.mockResolvedValueOnce({
        success: true,
        value: {
          items: [{ id: "inq_mine_1", state: "draft" }],
          nextCursor: null,
        },
      });

      const response = await request(app).get("/commerce/factories/inquiries/mine?state=draft");
      expect(response.status).toBe(200);
      expect(response.body.message).toBe("Manufacturing inquiries loaded.");
      expect(response.body.data.items).toHaveLength(1);
    });

    it("returns 200 on GET /factories/inquiries/received", async () => {
      signInAs({ id: "user_factory_1" });
      mockManufacturingInquiryService.listFactoryManufacturingInquiries.mockResolvedValueOnce({
        success: true,
        value: {
          items: [{ id: "inq_rcv_1", state: "sent" }],
          nextCursor: null,
        },
      });

      const response = await request(app).get("/commerce/factories/inquiries/received");
      expect(response.status).toBe(200);
      expect(response.body.message).toBe("Received manufacturing inquiries loaded.");
    });

    it("returns 404 when inquiry is not found on GET /factories/inquiries/:inquiryId", async () => {
      signInAs({ id: "user_factory_1" });
      mockManufacturingInquiryService.getManufacturingInquiry.mockResolvedValueOnce({
        success: false,
        error: { type: "NOT_FOUND" },
      });

      const response = await request(app).get("/commerce/factories/inquiries/inq_missing");
      expect(response.status).toBe(404);
      expect(response.body.message).toBe("Manufacturing inquiry not found.");
    });

    it("returns 200 when sending an inquiry successfully on POST /factories/inquiries/:inquiryId/send", async () => {
      signInAs({ id: "user_factory_1" });
      mockManufacturingInquiryService.sendManufacturingInquiry.mockResolvedValueOnce({
        success: true,
        value: { id: "inq_sent_1", state: "sent" },
      });

      const response = await request(app).post("/commerce/factories/inquiries/inq_sent_1/send");
      expect(response.status).toBe(200);
      expect(response.body.message).toBe("Manufacturing inquiry sent to the factory.");
    });

    it("returns 409 if trying to send an inquiry in invalid state", async () => {
      signInAs({ id: "user_factory_1" });
      mockManufacturingInquiryService.sendManufacturingInquiry.mockResolvedValueOnce({
        success: false,
        error: { type: "INVALID_STATE", message: "Only draft inquiries can be sent." },
      });

      const response = await request(app).post("/commerce/factories/inquiries/inq_already_sent/send");
      expect(response.status).toBe(409);
      expect(response.body.message).toBe("Only draft inquiries can be sent.");
    });

    it("returns 200 on POST /factories/inquiries/:inquiryId/answer", async () => {
      signInAs({ id: "user_factory_1" });
      mockManufacturingInquiryService.answerManufacturingInquiry.mockResolvedValueOnce({
        success: true,
        value: { id: "inq_ans_1", state: "answered" },
      });

      const response = await request(app).post("/commerce/factories/inquiries/inq_ans_1/answer");
      expect(response.status).toBe(200);
      expect(response.body.message).toBe("Manufacturing inquiry marked answered.");
    });

    it("returns 200 on POST /factories/inquiries/:inquiryId/close", async () => {
      signInAs({ id: "user_factory_1" });
      mockManufacturingInquiryService.closeManufacturingInquiry.mockResolvedValueOnce({
        success: true,
        value: { id: "inq_cls_1", state: "closed" },
      });

      const response = await request(app).post("/commerce/factories/inquiries/inq_cls_1/close");
      expect(response.status).toBe(200);
      expect(response.body.message).toBe("Manufacturing inquiry closed.");
    });

    it("requires Idempotency-Key on POST /factories/:factorySlug/inquiries", async () => {
      signInAs({ id: "user_factory_1" });
      const response = await request(app).post("/commerce/factories/test-factory/inquiries").send({
        capabilityKind: "oem",
        productDescription: "Testing precision enclosures.",
      });

      expect(response.status).toBe(400);
      expect(response.body.message).toContain("Idempotency-Key");
    });

    it("returns 422 if body validation fails on inquiry creation", async () => {
      signInAs({ id: "user_factory_1" });
      const response = await request(app)
        .post("/commerce/factories/test-factory/inquiries")
        .set("Idempotency-Key", "idemp_inq_1")
        .send({
          // missing capabilityKind
          productDescription: "Testing precision enclosures.",
        });

      expect(response.status).toBe(422);
    });

    it("returns 409 if factory is not accepting inquiries", async () => {
      signInAs({ id: "user_factory_1" });
      mockManufacturingInquiryService.createManufacturingInquiry.mockResolvedValueOnce({
        success: false,
        error: { type: "NOT_ACCEPTING_INQUIRIES" },
      });

      const response = await request(app)
        .post("/commerce/factories/busy-factory/inquiries")
        .set("Idempotency-Key", "idemp_inq_busy")
        .send({
          capabilityKind: "oem",
          productDescription: "Testing precision enclosures.",
        });

      expect(response.status).toBe(409);
      expect(response.body.message).toContain("not accepting inquiries");
    });

    it("returns 201 when inquiry is drafted successfully", async () => {
      signInAs({ id: "user_factory_1" });
      mockManufacturingInquiryService.createManufacturingInquiry.mockResolvedValueOnce({
        success: true,
        value: { id: "inq_drafted_1", state: "draft" },
      });

      const response = await request(app)
        .post("/commerce/factories/test-factory/inquiries")
        .set("Idempotency-Key", "idemp_inq_success")
        .send({
          capabilityKind: "oem",
          productDescription: "Testing precision enclosures.",
        });

      expect(response.status).toBe(201);
      expect(response.body.message).toBe("Manufacturing inquiry drafted. Send it when you are ready.");
      expect(response.body.data.id).toBe("inq_drafted_1");
    });
  });

  describe("Seller-Owned Factory Depth", () => {
    it("returns 200 on PUT /organizations/:organizationId/production-lines", async () => {
      signInAs({ id: "user_factory_1" });
      mockSellerProfileService.replaceProductionLines.mockResolvedValueOnce({
        success: true,
        value: [
          {
            id: "line_1",
            name: "SMT 1",
            processSummary: "High-speed assembly",
            monthlyCapacityUnits: 1000,
            unitLabel: "boards",
          },
        ],
      });

      const response = await request(app)
        .put(`/commerce/organizations/${ORG_ID}/production-lines`)
        .send({
          productionLines: [
            {
              name: "SMT 1",
              processSummary: "High-speed assembly",
              monthlyCapacityUnits: 1000,
              unitLabel: "boards",
            },
          ],
        });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe("Production lines replaced.");
      expect(response.body.data.productionLines).toHaveLength(1);
    });

    it("returns 200 on PUT /organizations/:organizationId/sites", async () => {
      signInAs({ id: "user_factory_1" });
      mockSellerProfileService.replaceOrganizationSites.mockResolvedValueOnce({
        success: true,
        value: [{ id: "site_1", label: "Headquarters", countryCode: "DE" }],
      });

      const response = await request(app)
        .put(`/commerce/organizations/${ORG_ID}/sites`)
        .send({
          sites: [{ label: "Headquarters", countryCode: "DE" }],
        });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe("Sites replaced.");
    });

    it("returns 200 on PUT /organizations/:organizationId/factory-terms", async () => {
      signInAs({ id: "user_factory_1" });
      mockSellerProfileService.replaceFactoryTerms.mockResolvedValueOnce({
        success: true,
        value: { offersSamples: false, acceptingInquiries: true },
      });

      const response = await request(app).put(`/commerce/organizations/${ORG_ID}/factory-terms`).send({
        offersSamples: false,
        sampleLeadTimeDays: null,
        sampleFeeInCents: null,
        sampleCurrency: "USD",
        minimumOrderQuantity: null,
        minimumOrderQuantityUnitLabel: null,
        minimumLeadTimeDays: null,
        maximumLeadTimeDays: null,
        acceptingInquiries: true,
      });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe("Factory terms replaced.");
    });
  });

  describe("Staff Site Audits", () => {
    it("returns 403 on GET site-audits if caller lacks platform capability", async () => {
      signInAs({ id: "user_non_staff" });
      mockSellerProfileService.listSiteAudits.mockResolvedValueOnce({
        success: false,
        error: { type: "PLATFORM_CAPABILITY_REQUIRED" },
      });

      const response = await request(app).get(`/commerce/admin/organizations/${ORG_ID}/site-audits`);
      expect(response.status).toBe(403);
      expect(response.body.message).toContain("requires the moderator or admin role");
    });

    it("returns 200 on GET site-audits when authorized", async () => {
      signInAs({ id: "user_staff_1" });
      mockSellerProfileService.listSiteAudits.mockResolvedValueOnce({
        success: true,
        value: [{ id: "aud_1", auditorName: "Auditor Smith" }],
      });

      const response = await request(app).get(`/commerce/admin/organizations/${ORG_ID}/site-audits`);
      expect(response.status).toBe(200);
      expect(response.body.message).toBe("Site audits loaded.");
      expect(response.body.data.siteAudits).toHaveLength(1);
    });

    it("returns 201 on POST site-audits with valid Idempotency-Key and payload", async () => {
      signInAs({ id: "user_staff_1" });
      mockSellerProfileService.recordSiteAudit.mockResolvedValueOnce({
        success: true,
        value: { id: "aud_new_1", auditorName: "Auditor Smith" },
      });

      const response = await request(app)
        .post(`/commerce/admin/organizations/${ORG_ID}/site-audits`)
        .set("Idempotency-Key", "idemp_audit_1")
        .send({
          auditedAt: "2026-06-01",
          auditorName: "Auditor Smith",
          scopeSummary: "Comprehensive facility audit.",
        });

      expect(response.status).toBe(201);
      expect(response.body.message).toBe("Site audit recorded.");
    });

    it("returns 200 on POST withdraw site audit", async () => {
      signInAs({ id: "user_staff_1" });
      mockSellerProfileService.withdrawSiteAudit.mockResolvedValueOnce({
        success: true,
        value: { id: "aud_withdrawn", withdrawnAt: new Date().toISOString() },
      });

      const response = await request(app)
        .post("/commerce/admin/site-audits/aud_withdrawn/withdraw")
        .set("Idempotency-Key", "idemp_withdraw_1")
        .send({
          reason: "Found non-compliance in records.",
        });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe("Site audit withdrawn.");
    });
  });
});
