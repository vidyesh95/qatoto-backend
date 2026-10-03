import type { Express } from "express";
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
  requireIdentifiedUser: (_req: unknown, _res: unknown, next: (error?: unknown) => void): void => {
    next();
  },
}));

// Mock suppliersService
const listSupplierCapabilitiesMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const listSuppliersMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const findSupplierBySlugMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const createSupplierMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const updateSupplierMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const listLaunchReadyProjectsMock = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/rnd/suppliers/suppliers.service.js", () => ({
  listSupplierCapabilities: (...args: readonly unknown[]) => listSupplierCapabilitiesMock(...args),
  listSuppliers: (...args: readonly unknown[]) => listSuppliersMock(...args),
  findSupplierBySlug: (...args: readonly unknown[]) => findSupplierBySlugMock(...args),
  createSupplier: (...args: readonly unknown[]) => createSupplierMock(...args),
  updateSupplier: (...args: readonly unknown[]) => updateSupplierMock(...args),
  listLaunchReadyProjects: (...args: readonly unknown[]) => listLaunchReadyProjectsMock(...args),
}));

// Mock readinessService
const computeLaunchReadinessMock = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/rnd/discovery/launch-readiness.service.js", () => ({
  computeLaunchReadiness: (...args: readonly unknown[]) => computeLaunchReadinessMock(...args),
}));

// Mock membershipService
const requireProjectRoleMock = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/rnd/projects/project-membership.service.js", () => ({
  requireProjectRole: (...args: readonly unknown[]) => requireProjectRoleMock(...args),
}));

// Mock engagementsService
const listSupplierEngagementsMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const createSupplierEngagementMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const updateSupplierEngagementMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const deleteSupplierEngagementMock = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/rnd/suppliers/supplier-engagements.service.js", () => ({
  listSupplierEngagements: (...args: readonly unknown[]) => listSupplierEngagementsMock(...args),
  createSupplierEngagement: (...args: readonly unknown[]) => createSupplierEngagementMock(...args),
  updateSupplierEngagement: (...args: readonly unknown[]) => updateSupplierEngagementMock(...args),
  deleteSupplierEngagement: (...args: readonly unknown[]) => deleteSupplierEngagementMock(...args),
}));

describe("suppliers and go-to-market routes", () => {
  let app: Express;

  const defaultMemberContext = {
    projectId: "proj_solar_1",
    projectSlug: "solar-kit",
    projectStatus: "active",
    founderUserId: "usr_mock_user_1",
    currency: "USD",
    memberId: "mem_1",
    memberRole: "maintainer",
    isFounder: false,
  };

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signInAs();
    await resetRateLimiters();

    requireProjectRoleMock.mockResolvedValue({
      success: true,
      value: defaultMemberContext,
    });
  });

  describe("GET /supplier-capabilities", () => {
    it("answers 200 with list of capabilities", async () => {
      listSupplierCapabilitiesMock.mockResolvedValue([{ slug: "cnc-machining", label: "CNC Machining" }]);

      const response = await request(app).get("/supplier-capabilities");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([{ slug: "cnc-machining", label: "CNC Machining" }]);
    });
  });

  describe("GET /suppliers & /suppliers/:supplierSlug", () => {
    it("answers 200 with paginated suppliers", async () => {
      listSuppliersMock.mockResolvedValue({
        rows: [{ id: "supp_1", name: "Apex Manufacturing" }],
        total: 1,
      });

      const response = await request(app).get("/suppliers?page=1&limit=20");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([{ id: "supp_1", name: "Apex Manufacturing" }]);
      expect(response.body.pagination).toEqual({
        page: 1,
        limit: 20,
        total: 1,
        totalPages: 1,
      });
    });

    it("answers 404 when supplier slug is not found", async () => {
      findSupplierBySlugMock.mockResolvedValue({
        success: false,
        error: { type: "SUPPLIER_NOT_FOUND", supplierRef: "non-existent-supplier" },
      });

      const response = await request(app).get("/suppliers/non-existent-supplier");

      expect(response.status).toBe(404);
    });

    it("answers 200 with supplier details when found", async () => {
      const supplierData = { id: "supp_1", slug: "apex-mfg", name: "Apex Manufacturing" };
      findSupplierBySlugMock.mockResolvedValue({
        success: true,
        value: supplierData,
      });

      const response = await request(app).get("/suppliers/apex-mfg");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(supplierData);
    });
  });

  describe("POST /suppliers & PATCH /suppliers/:supplierId", () => {
    const validSupplier = {
      slug: "apex-mfg",
      name: "Apex Manufacturing",
      summary: "Precision CNC and injection molding provider.",
      capabilitySlugs: ["cnc-machining"],
    };

    it("POST answers 401 when signed out", async () => {
      signOut();

      const response = await request(app).post("/suppliers").send(validSupplier);

      expect(response.status).toBe(401);
    });

    it("POST maps PLATFORM_CAPABILITY_REQUIRED to 403", async () => {
      createSupplierMock.mockResolvedValue({
        success: false,
        error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_suppliers" },
      });

      const response = await request(app).post("/suppliers").send(validSupplier);

      expect(response.status).toBe(403);
    });

    it("POST answers 201 on successful listing", async () => {
      const created = { id: "supp_1", ...validSupplier };
      createSupplierMock.mockResolvedValue({
        success: true,
        value: created,
      });

      const response = await request(app).post("/suppliers").send(validSupplier);

      expect(response.status).toBe(201);
      expect(response.body.data).toEqual(created);
    });

    it("PATCH answers 200 on update", async () => {
      const updated = { id: "supp_1", name: "Apex Advanced Manufacturing" };
      updateSupplierMock.mockResolvedValue({
        success: true,
        value: updated,
      });

      const response = await request(app).patch("/suppliers/supp_1").send({ name: "Apex Advanced Manufacturing" });

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(updated);
    });
  });

  describe("GET /launch-ready-projects", () => {
    it("answers 200 with launch ready projects rail", async () => {
      listLaunchReadyProjectsMock.mockResolvedValue({
        rows: [{ id: "proj_1", name: "Solar Desalination Kit" }],
        total: 1,
      });

      const response = await request(app).get("/launch-ready-projects?page=1&limit=20");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([{ id: "proj_1", name: "Solar Desalination Kit" }]);
    });
  });

  describe("GET /research-projects/:projectSlug/launch-readiness", () => {
    it("maps authorization failure to 404", async () => {
      requireProjectRoleMock.mockResolvedValue({
        success: false,
        error: { type: "NOT_FOUND", projectRef: "solar-kit" },
      });

      const response = await request(app).get("/research-projects/solar-kit/launch-readiness");

      expect(response.status).toBe(404);
    });

    it("answers 200 with computed launch readiness checklist", async () => {
      const readinessData = {
        projectId: "proj_solar_1",
        projectSlug: "solar-kit",
        overallReadinessMet: true,
        gates: [],
      };
      computeLaunchReadinessMock.mockResolvedValue(readinessData);

      const response = await request(app).get("/research-projects/solar-kit/launch-readiness");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(readinessData);
    });
  });

  describe("Project Supplier Engagements API", () => {
    it("GET answers 200 with engagements list", async () => {
      listSupplierEngagementsMock.mockResolvedValue({
        rows: [{ id: "eng_1", supplierId: "supp_1", status: "considering" }],
        total: 1,
      });

      const response = await request(app).get("/research-projects/solar-kit/supplier-engagements?page=1&limit=20");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([{ id: "eng_1", supplierId: "supp_1", status: "considering" }]);
    });

    it("POST maps ENGAGEMENT_ALREADY_EXISTS to 409", async () => {
      createSupplierEngagementMock.mockResolvedValue({
        success: false,
        error: { type: "ENGAGEMENT_ALREADY_EXISTS" },
      });

      const response = await request(app)
        .post("/research-projects/solar-kit/supplier-engagements")
        .send({ supplierId: "supp_1", status: "considering" });

      expect(response.status).toBe(409);
      expect(response.body.message).toContain("already has an engagement with that supplier");
    });

    it("POST creates engagement and answers 201", async () => {
      const created = { id: "eng_1", supplierId: "supp_1", status: "considering" };
      createSupplierEngagementMock.mockResolvedValue({
        success: true,
        value: created,
      });

      const response = await request(app)
        .post("/research-projects/solar-kit/supplier-engagements")
        .send({ supplierId: "supp_1", status: "considering" });

      expect(response.status).toBe(201);
      expect(response.body.data).toEqual(created);
    });

    it("PATCH updates engagement and answers 200", async () => {
      const updated = { id: "eng_1", status: "contracted" };
      updateSupplierEngagementMock.mockResolvedValue({
        success: true,
        value: updated,
      });

      const response = await request(app)
        .patch("/research-projects/solar-kit/supplier-engagements/eng_1")
        .send({ status: "contracted" });

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(updated);
    });

    it("DELETE removes engagement and answers 200", async () => {
      deleteSupplierEngagementMock.mockResolvedValue({
        success: true,
        value: { deletedEngagementId: "eng_1" },
      });

      const response = await request(app).delete("/research-projects/solar-kit/supplier-engagements/eng_1");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ deletedEngagementId: "eng_1" });
    });
  });
});
