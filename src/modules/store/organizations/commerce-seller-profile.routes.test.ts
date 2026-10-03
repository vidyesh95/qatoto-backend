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

const sellerServiceStubs = vi.hoisted(() => ({
  getOwnSellerProfile: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  upsertSellerProfile: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  replaceSiteAccess: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  replaceStakeholders: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  replaceStakeholderPhoto: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  replaceCapabilities: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  reorderOrganizationMedia: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  addOrganizationMedia: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  deleteOrganizationMediaRow: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  listCertifications: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  submitCertification: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  downloadCertificationEvidence: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  withdrawCertification: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  listCertificationsForModeration: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  decideCertification: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

vi.mock("#src/modules/store/organizations/commerce-seller-profile.service.js", () => ({
  getOwnSellerProfile: sellerServiceStubs.getOwnSellerProfile,
  upsertSellerProfile: sellerServiceStubs.upsertSellerProfile,
  replaceSiteAccess: sellerServiceStubs.replaceSiteAccess,
  replaceStakeholders: sellerServiceStubs.replaceStakeholders,
  replaceStakeholderPhoto: sellerServiceStubs.replaceStakeholderPhoto,
  replaceCapabilities: sellerServiceStubs.replaceCapabilities,
  reorderOrganizationMedia: sellerServiceStubs.reorderOrganizationMedia,
  addOrganizationMedia: sellerServiceStubs.addOrganizationMedia,
  deleteOrganizationMediaRow: sellerServiceStubs.deleteOrganizationMediaRow,
  listCertifications: sellerServiceStubs.listCertifications,
  submitCertification: sellerServiceStubs.submitCertification,
  downloadCertificationEvidence: sellerServiceStubs.downloadCertificationEvidence,
  withdrawCertification: sellerServiceStubs.withdrawCertification,
  listCertificationsForModeration: sellerServiceStubs.listCertificationsForModeration,
  decideCertification: sellerServiceStubs.decideCertification,
}));

describe("commerce-seller-profile.routes", () => {
  let app: Express;
  const orgId = "org_test_seller";
  const validUuid = "123e4567-e89b-12d3-a456-426614174000";

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    idempotencyCache.clear();
    await resetRateLimiters();
    signOut();
  });

  describe("GET & PATCH /commerce/organizations/:organizationId/seller-profile", () => {
    it("returns 401 on GET when signed out", async () => {
      const response = await request(app).get(`/commerce/organizations/${orgId}/seller-profile`);
      expect(response.status).toBe(401);
    });

    it("returns 404 on GET when profile not found", async () => {
      signInAs({ id: "usr_1", email: "usr@qatoto.test" });
      sellerServiceStubs.getOwnSellerProfile.mockResolvedValueOnce({
        success: false,
        error: { type: "NOT_FOUND" },
      });

      const response = await request(app).get(`/commerce/organizations/${orgId}/seller-profile`);
      expect(response.status).toBe(404);
    });

    it("returns 200 on GET when profile found", async () => {
      signInAs({ id: "usr_1", email: "usr@qatoto.test" });
      const mockProfile = { organizationId: orgId, yearFounded: 2015 };
      sellerServiceStubs.getOwnSellerProfile.mockResolvedValueOnce({
        success: true,
        value: mockProfile,
      });

      const response = await request(app).get(`/commerce/organizations/${orgId}/seller-profile`);
      expect(response.status).toBe(200);
      expect(response.body.data.declaredProfile).toEqual(mockProfile);
    });

    it("returns 400 on PATCH when Idempotency-Key is missing", async () => {
      signInAs({ id: "usr_1", email: "usr@qatoto.test" });

      const response = await request(app)
        .patch(`/commerce/organizations/${orgId}/seller-profile`)
        .send({ yearFounded: 2018 });

      expect(response.status).toBe(400);
    });

    it("returns 422 on PATCH when empty body is sent", async () => {
      signInAs({ id: "usr_1", email: "usr@qatoto.test" });

      const response = await request(app)
        .patch(`/commerce/organizations/${orgId}/seller-profile`)
        .set("Idempotency-Key", "idem-prof-empty")
        .send({});

      expect(response.status).toBe(422);
    });

    it("returns 200 on PATCH on successful update", async () => {
      signInAs({ id: "usr_1", email: "usr@qatoto.test" });
      const mockUpdated = { organizationId: orgId, yearFounded: 2018 };
      sellerServiceStubs.upsertSellerProfile.mockResolvedValueOnce({
        success: true,
        value: mockUpdated,
      });

      const response = await request(app)
        .patch(`/commerce/organizations/${orgId}/seller-profile`)
        .set("Idempotency-Key", "idem-prof-ok")
        .send({ yearFounded: 2018 });

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(mockUpdated);
    });
  });

  describe("PUT site-access, stakeholders, capabilities", () => {
    it("returns 400 on site-access when Idempotency-Key is missing", async () => {
      signInAs({ id: "usr_1", email: "usr@qatoto.test" });

      const response = await request(app).put(`/commerce/organizations/${orgId}/site-access`).send({ rows: [] });

      expect(response.status).toBe(400);
    });

    it("returns 200 on site-access on success", async () => {
      signInAs({ id: "usr_1", email: "usr@qatoto.test" });
      sellerServiceStubs.replaceSiteAccess.mockResolvedValueOnce({
        success: true,
        value: [{ accessMode: "road", facilityName: "Highway 1" }],
      });

      const response = await request(app)
        .put(`/commerce/organizations/${orgId}/site-access`)
        .set("Idempotency-Key", "idem-site-ok")
        .send({ rows: [{ accessMode: "road", facilityName: "Highway 1" }] });

      expect(response.status).toBe(200);
    });

    it("returns 200 on stakeholders on success", async () => {
      signInAs({ id: "usr_1", email: "usr@qatoto.test" });
      sellerServiceStubs.replaceStakeholders.mockResolvedValueOnce({
        success: true,
        value: [{ fullName: "Bob", roleTitle: "CEO" }],
      });

      const response = await request(app)
        .put(`/commerce/organizations/${orgId}/stakeholders`)
        .set("Idempotency-Key", "idem-stake-ok")
        .send({ rows: [{ fullName: "Bob", roleTitle: "CEO" }] });

      expect(response.status).toBe(200);
    });

    it("returns 200 on capabilities on success", async () => {
      signInAs({ id: "usr_1", email: "usr@qatoto.test" });
      sellerServiceStubs.replaceCapabilities.mockResolvedValueOnce({
        success: true,
        value: [{ capabilityKind: "oem" }],
      });

      const response = await request(app)
        .put(`/commerce/organizations/${orgId}/capabilities`)
        .set("Idempotency-Key", "idem-cap-ok")
        .send({ rows: [{ capabilityKind: "oem" }] });

      expect(response.status).toBe(200);
    });
  });

  describe("Media routes", () => {
    it("returns 422 on media reorder when mediaIdsInOrder is empty", async () => {
      signInAs({ id: "usr_1", email: "usr@qatoto.test" });

      const response = await request(app)
        .patch(`/commerce/organizations/${orgId}/media/reorder`)
        .set("Idempotency-Key", "idem-reorder-media")
        .send({ mediaIdsInOrder: [] });

      expect(response.status).toBe(422);
    });

    it("returns 200 on media reorder on success", async () => {
      signInAs({ id: "usr_1", email: "usr@qatoto.test" });
      sellerServiceStubs.reorderOrganizationMedia.mockResolvedValueOnce({
        success: true,
        value: [{ id: validUuid, displayOrder: 0 }],
      });

      const response = await request(app)
        .patch(`/commerce/organizations/${orgId}/media/reorder`)
        .set("Idempotency-Key", "idem-reorder-ok")
        .send({ mediaIdsInOrder: [validUuid] });

      expect(response.status).toBe(200);
    });

    it("returns 422 on POST media when file is missing", async () => {
      signInAs({ id: "usr_1", email: "usr@qatoto.test" });

      const response = await request(app)
        .post(`/commerce/organizations/${orgId}/media`)
        .set("Idempotency-Key", "idem-media-nofile")
        .field("mediaKind", "factory");

      expect(response.status).toBe(422);
    });

    it("returns 409 on POST media when MEDIA_LIMIT_REACHED", async () => {
      signInAs({ id: "usr_1", email: "usr@qatoto.test" });
      sellerServiceStubs.addOrganizationMedia.mockResolvedValueOnce({
        success: false,
        error: { type: "MEDIA_LIMIT_REACHED", limit: 12 },
      });

      const response = await request(app)
        .post(`/commerce/organizations/${orgId}/media`)
        .set("Idempotency-Key", "idem-media-limit")
        .field("mediaKind", "factory")
        .attach("image", Buffer.from("fake-png"), "factory.png");

      expect(response.status).toBe(409);
      expect(response.body.message).toMatch(/at most 12 company photos/);
    });

    it("returns 201 on POST media on success", async () => {
      signInAs({ id: "usr_1", email: "usr@qatoto.test" });
      const mockMedia = { id: validUuid, mediaKind: "factory" };
      sellerServiceStubs.addOrganizationMedia.mockResolvedValueOnce({
        success: true,
        value: mockMedia,
      });

      const response = await request(app)
        .post(`/commerce/organizations/${orgId}/media`)
        .set("Idempotency-Key", "idem-media-ok")
        .field("mediaKind", "factory")
        .attach("image", Buffer.from("fake-png"), "factory.png");

      expect(response.status).toBe(201);
      expect(response.body.data).toEqual(mockMedia);
    });

    it("returns 200 on DELETE media on success", async () => {
      signInAs({ id: "usr_1", email: "usr@qatoto.test" });
      sellerServiceStubs.deleteOrganizationMediaRow.mockResolvedValueOnce({
        success: true,
        value: undefined,
      });

      const response = await request(app)
        .delete(`/commerce/organizations/${orgId}/media/${validUuid}`)
        .set("Idempotency-Key", "idem-del-media");

      expect(response.status).toBe(200);
      expect(response.body.message).toBe("Company photo removed.");
    });
  });

  describe("Certifications routes", () => {
    it("returns 200 on GET certifications", async () => {
      signInAs({ id: "usr_1", email: "usr@qatoto.test" });
      const mockCerts = [{ id: validUuid, standardName: "ISO 9001" }];
      sellerServiceStubs.listCertifications.mockResolvedValueOnce({
        success: true,
        value: mockCerts,
      });

      const response = await request(app).get(`/commerce/organizations/${orgId}/certifications`);
      expect(response.status).toBe(200);
      expect(response.body.data.items).toEqual(mockCerts);
    });

    it("returns 409 on evidence download when EVIDENCE_NOT_READY", async () => {
      signInAs({ id: "usr_1", email: "usr@qatoto.test" });
      sellerServiceStubs.downloadCertificationEvidence.mockResolvedValueOnce({
        success: false,
        error: { type: "EVIDENCE_NOT_READY" },
      });

      const response = await request(app).get(`/commerce/organizations/${orgId}/certifications/${validUuid}/evidence`);
      expect(response.status).toBe(409);
      expect(response.body.message).toMatch(/still being checked for malware/);
    });

    it("returns 409 on evidence download when EVIDENCE_QUARANTINED", async () => {
      signInAs({ id: "usr_1", email: "usr@qatoto.test" });
      sellerServiceStubs.downloadCertificationEvidence.mockResolvedValueOnce({
        success: false,
        error: { type: "EVIDENCE_QUARANTINED" },
      });

      const response = await request(app).get(`/commerce/organizations/${orgId}/certifications/${validUuid}/evidence`);
      expect(response.status).toBe(409);
      expect(response.body.message).toMatch(/quarantined by the scanner/);
    });

    it("returns 200 and streams bytes on evidence download on success", async () => {
      signInAs({ id: "usr_1", email: "usr@qatoto.test" });
      sellerServiceStubs.downloadCertificationEvidence.mockResolvedValueOnce({
        success: true,
        value: {
          bytes: Buffer.from("pdf-data"),
          mediaType: "application/pdf",
          fileName: "iso9001.pdf",
        },
      });

      const response = await request(app).get(`/commerce/organizations/${orgId}/certifications/${validUuid}/evidence`);
      expect(response.status).toBe(200);
      expect(response.header["content-type"]).toBe("application/pdf");
      expect(response.body).toEqual(Buffer.from("pdf-data"));
    });

    it("returns 200 on withdraw certification on success", async () => {
      signInAs({ id: "usr_1", email: "usr@qatoto.test" });
      sellerServiceStubs.withdrawCertification.mockResolvedValueOnce({
        success: true,
        value: { id: validUuid, state: "withdrawn" },
      });

      const response = await request(app)
        .post(`/commerce/organizations/${orgId}/certifications/${validUuid}/withdraw`)
        .set("Idempotency-Key", "idem-withdraw");

      expect(response.status).toBe(200);
      expect(response.body.data.state).toBe("withdrawn");
    });
  });

  describe("Admin Certifications Moderation routes", () => {
    it("returns 401 on GET /commerce/admin/certifications when signed out", async () => {
      const response = await request(app).get("/commerce/admin/certifications");
      expect(response.status).toBe(401);
    });

    it("returns 403 on GET /commerce/admin/certifications when lacking platform role", async () => {
      signInAs({ id: "usr_regular", email: "reg@qatoto.test" });
      sellerServiceStubs.listCertificationsForModeration.mockResolvedValueOnce({
        success: false,
        error: { type: "PLATFORM_CAPABILITY_REQUIRED" },
      });

      const response = await request(app).get("/commerce/admin/certifications");
      expect(response.status).toBe(403);
    });

    it("returns 200 on GET /commerce/admin/certifications on success", async () => {
      signInAs({ id: "usr_staff", email: "staff@qatoto.test" });
      const mockQueue = {
        items: [{ id: validUuid, standardName: "ISO 9001" }],
        page: { nextCursor: null, hasMore: false },
      };
      sellerServiceStubs.listCertificationsForModeration.mockResolvedValueOnce({
        success: true,
        value: mockQueue,
      });

      const response = await request(app).get("/commerce/admin/certifications");
      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(mockQueue);
    });

    it("returns 403 on POST /commerce/admin/certifications/:certificationId/decision when SELF_REVIEW_FORBIDDEN", async () => {
      signInAs({ id: "usr_mod_seller", email: "mod@seller.test" });
      sellerServiceStubs.decideCertification.mockResolvedValueOnce({
        success: false,
        error: { type: "SELF_REVIEW_FORBIDDEN" },
      });

      const response = await request(app)
        .post(`/commerce/admin/certifications/${validUuid}/decision`)
        .set("Idempotency-Key", "idem-decide-self")
        .send({ kind: "approve" });

      expect(response.status).toBe(403);
    });

    it("returns 200 on POST /commerce/admin/certifications/:certificationId/decision on approval", async () => {
      signInAs({ id: "usr_staff", email: "staff@qatoto.test" });
      const mockDecided = { id: validUuid, state: "approved" };
      sellerServiceStubs.decideCertification.mockResolvedValueOnce({
        success: true,
        value: mockDecided,
      });

      const response = await request(app)
        .post(`/commerce/admin/certifications/${validUuid}/decision`)
        .set("Idempotency-Key", "idem-decide-ok")
        .send({ kind: "approve" });

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(mockDecided);
    });
  });
});
