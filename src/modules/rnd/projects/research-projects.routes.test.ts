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

// Mock projectsService
const createResearchProjectMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const listPublicProjectsMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const listPublicProjectSlugsMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const listMyProjectsMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const listAttachableProjectsMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const findResearchProjectBySlugMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const updateResearchProjectMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const setProjectCoverMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const removeProjectCoverMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const publishResearchProjectMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const unpublishResearchProjectMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const archiveResearchProjectMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const changeProjectStageMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const listProjectStageTransitionsMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const watchProjectMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const unwatchProjectMock = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/rnd/projects/research-projects.service.js", () => ({
  createResearchProject: (...args: readonly unknown[]) => createResearchProjectMock(...args),
  listPublicProjects: (...args: readonly unknown[]) => listPublicProjectsMock(...args),
  listPublicProjectSlugs: (...args: readonly unknown[]) => listPublicProjectSlugsMock(...args),
  listMyProjects: (...args: readonly unknown[]) => listMyProjectsMock(...args),
  listAttachableProjects: (...args: readonly unknown[]) => listAttachableProjectsMock(...args),
  findResearchProjectBySlug: (...args: readonly unknown[]) => findResearchProjectBySlugMock(...args),
  updateResearchProject: (...args: readonly unknown[]) => updateResearchProjectMock(...args),
  setProjectCover: (...args: readonly unknown[]) => setProjectCoverMock(...args),
  removeProjectCover: (...args: readonly unknown[]) => removeProjectCoverMock(...args),
  publishResearchProject: (...args: readonly unknown[]) => publishResearchProjectMock(...args),
  unpublishResearchProject: (...args: readonly unknown[]) => unpublishResearchProjectMock(...args),
  archiveResearchProject: (...args: readonly unknown[]) => archiveResearchProjectMock(...args),
  changeProjectStage: (...args: readonly unknown[]) => changeProjectStageMock(...args),
  listProjectStageTransitions: (...args: readonly unknown[]) => listProjectStageTransitionsMock(...args),
  watchProject: (...args: readonly unknown[]) => watchProjectMock(...args),
  unwatchProject: (...args: readonly unknown[]) => unwatchProjectMock(...args),
}));

// Mock membershipService
const requireProjectRoleMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const findMembershipProjectBySlugMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const leaveProjectMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const updateProjectMemberMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const removeProjectMemberMock = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/rnd/projects/project-membership.service.js", () => ({
  requireProjectRole: (...args: readonly unknown[]) => requireProjectRoleMock(...args),
  findProjectBySlug: (...args: readonly unknown[]) => findMembershipProjectBySlugMock(...args),
  leaveProject: (...args: readonly unknown[]) => leaveProjectMock(...args),
  updateProjectMember: (...args: readonly unknown[]) => updateProjectMemberMock(...args),
  removeProjectMember: (...args: readonly unknown[]) => removeProjectMemberMock(...args),
}));

// Mock insightLinksService
const linkMarketInsightToProjectMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const unlinkMarketInsightFromProjectMock = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/rnd/projects/project-insight-links.service.js", () => ({
  linkMarketInsightToProject: (...args: readonly unknown[]) => linkMarketInsightToProjectMock(...args),
  unlinkMarketInsightFromProject: (...args: readonly unknown[]) => unlinkMarketInsightFromProjectMock(...args),
}));

describe("research-projects routes", () => {
  let app: Express;

  const defaultMemberContext = {
    projectId: "proj_solar_1",
    projectSlug: "solar-kit",
    projectStatus: "draft",
    founderUserId: "usr_mock_user_1",
    currency: "USD",
    memberId: "mem_1",
    memberRole: "founder",
    isFounder: true,
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

  describe("POST /research-projects", () => {
    const validPayload = {
      name: "Autonomous Agri Drone",
      tagline: "Autonomous drone for precision farming in drylands.",
      categoryId: "cat_agritech_01",
    };

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).post("/research-projects").send(validPayload);

      expect(response.status).toBe(401);
      expect(createResearchProjectMock).not.toHaveBeenCalled();
    });

    it("rejects an invalid payload with 422", async () => {
      const response = await request(app)
        .post("/research-projects")
        .send({ ...validPayload, offeredEquityBasisPointsMin: 2000, offeredEquityBasisPointsMax: 1000 });

      expect(response.status).toBe(422);
      expect(createResearchProjectMock).not.toHaveBeenCalled();
    });

    it("creates a draft project and answers 201 on success", async () => {
      const createdProject = {
        id: "proj_drone_1",
        slug: "autonomous-agri-drone",
        name: "Autonomous Agri Drone",
        status: "draft",
      };
      createResearchProjectMock.mockResolvedValue({
        success: true,
        value: createdProject,
      });

      const response = await request(app).post("/research-projects").send(validPayload);

      expect(response.status).toBe(201);
      expect(response.body.data).toEqual(createdProject);
    });

    it("handles domain error from service with appropriate status code", async () => {
      createResearchProjectMock.mockResolvedValue({
        success: false,
        error: { type: "CATEGORY_NOT_FOUND", categoryId: "cat_invalid" },
      });

      const response = await request(app).post("/research-projects").send(validPayload);

      expect(response.status).toBe(422);
      expect(response.body.message).toBe("That category does not exist.");
    });
  });

  describe("GET /research-projects", () => {
    it("answers 200 with paginated projects list", async () => {
      listPublicProjectsMock.mockResolvedValue({
        rows: [{ id: "proj_1", name: "Drone" }],
        total: 1,
      });

      const response = await request(app).get("/research-projects?page=1&limit=20");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([{ id: "proj_1", name: "Drone" }]);
      expect(response.body.pagination).toEqual({
        page: 1,
        limit: 20,
        total: 1,
        totalPages: 1,
      });
    });

    it("answers 422 when limit exceeds 100", async () => {
      const response = await request(app).get("/research-projects?limit=150");

      expect(response.status).toBe(422);
    });
  });

  describe("GET /research-projects/slugs", () => {
    it("answers 200 with list of published slugs without session", async () => {
      signOut();
      listPublicProjectSlugsMock.mockResolvedValue(["drone-project", "solar-kit"]);

      const response = await request(app).get("/research-projects/slugs");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(["drone-project", "solar-kit"]);
    });
  });

  describe("GET /research-projects/mine", () => {
    it("answers 401 for signed-out caller", async () => {
      signOut();

      const response = await request(app).get("/research-projects/mine");

      expect(response.status).toBe(401);
    });

    it("answers 200 with user's own projects", async () => {
      listMyProjectsMock.mockResolvedValue({
        rows: [{ id: "proj_my_1", name: "My Project" }],
        total: 1,
      });

      const response = await request(app).get("/research-projects/mine");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([{ id: "proj_my_1", name: "My Project" }]);
    });
  });

  describe("GET /research-projects/attachable", () => {
    it("answers 401 for signed-out caller", async () => {
      signOut();

      const response = await request(app).get("/research-projects/attachable");

      expect(response.status).toBe(401);
    });

    it("answers 200 with user's attachable projects", async () => {
      listAttachableProjectsMock.mockResolvedValue({
        rows: [{ id: "proj_attach_1", name: "Attachable Project" }],
        total: 1,
      });

      const response = await request(app).get("/research-projects/attachable");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([{ id: "proj_attach_1", name: "Attachable Project" }]);
    });
  });

  describe("GET /research-projects/:projectSlug", () => {
    it("answers 404 when project is not found", async () => {
      findResearchProjectBySlugMock.mockResolvedValue({
        success: false,
        error: { type: "NOT_FOUND", projectRef: "non-existent-slug" },
      });

      const response = await request(app).get("/research-projects/non-existent-slug");

      expect(response.status).toBe(404);
      expect(response.body.message).toBe("Project not found.");
    });

    it("answers 200 with project details when found", async () => {
      const projectDetails = {
        project: { id: "proj_1", slug: "solar-kit", name: "Solar Kit" },
        team: [],
        stats: null,
      };
      findResearchProjectBySlugMock.mockResolvedValue({
        success: true,
        value: projectDetails,
      });

      const response = await request(app).get("/research-projects/solar-kit");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(projectDetails);
    });
  });

  describe("GET /research-projects/:projectSlug/team", () => {
    it("answers 200 with team members", async () => {
      const teamList = [{ memberId: "mem_1", user: { id: "usr_1", name: "Alice" } }];
      findResearchProjectBySlugMock.mockResolvedValue({
        success: true,
        value: { team: teamList },
      });

      const response = await request(app).get("/research-projects/solar-kit/team");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(teamList);
    });
  });

  describe("PATCH /research-projects/:projectSlug", () => {
    it("answers 401 when signed out", async () => {
      signOut();

      const response = await request(app).patch("/research-projects/solar-kit").send({ tagline: "New tagline" });

      expect(response.status).toBe(401);
    });

    it("maps authorization failure to 404", async () => {
      requireProjectRoleMock.mockResolvedValue({
        success: false,
        error: { type: "NOT_FOUND", projectRef: "solar-kit" },
      });

      const response = await request(app).patch("/research-projects/solar-kit").send({ tagline: "New tagline" });

      expect(response.status).toBe(404);
    });

    it("answers 200 on successful update", async () => {
      updateResearchProjectMock.mockResolvedValue({
        success: true,
        value: { id: "proj_1", tagline: "New tagline" },
      });

      const response = await request(app).patch("/research-projects/solar-kit").send({ tagline: "New tagline" });

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ id: "proj_1", tagline: "New tagline" });
    });
  });

  describe("POST /research-projects/:projectSlug/publish", () => {
    it("maps ALREADY_PUBLISHED to 409", async () => {
      publishResearchProjectMock.mockResolvedValue({
        success: false,
        error: { type: "ALREADY_PUBLISHED" },
      });

      const response = await request(app).post("/research-projects/solar-kit/publish");

      expect(response.status).toBe(409);
      expect(response.body.message).toBe("This project is already published.");
    });

    it("maps INCOMPLETE_FOR_PUBLISH to 422 naming missing fields", async () => {
      publishResearchProjectMock.mockResolvedValue({
        success: false,
        error: { type: "INCOMPLETE_FOR_PUBLISH", missing: ["coverImage", "problemStatement"] },
      });

      const response = await request(app).post("/research-projects/solar-kit/publish");

      expect(response.status).toBe(422);
      expect(response.body.errors?.missing).toEqual(["coverImage", "problemStatement"]);
    });

    it("answers 200 on successful publish", async () => {
      publishResearchProjectMock.mockResolvedValue({
        success: true,
        value: { id: "proj_1", status: "active" },
      });

      const response = await request(app).post("/research-projects/solar-kit/publish");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ id: "proj_1", status: "active" });
    });
  });

  describe("POST /research-projects/:projectSlug/unpublish", () => {
    it("maps NOT_PUBLISHED to 409", async () => {
      unpublishResearchProjectMock.mockResolvedValue({
        success: false,
        error: { type: "NOT_PUBLISHED" },
      });

      const response = await request(app).post("/research-projects/solar-kit/unpublish");

      expect(response.status).toBe(409);
      expect(response.body.message).toBe("This project is not published.");
    });

    it("answers 200 on successful unpublish", async () => {
      unpublishResearchProjectMock.mockResolvedValue({
        success: true,
        value: { id: "proj_1", status: "draft" },
      });

      const response = await request(app).post("/research-projects/solar-kit/unpublish");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ id: "proj_1", status: "draft" });
    });
  });

  describe("POST /research-projects/:projectSlug/archive", () => {
    it("maps PROJECT_ARCHIVED to 409", async () => {
      archiveResearchProjectMock.mockResolvedValue({
        success: false,
        error: { type: "PROJECT_ARCHIVED" },
      });

      const response = await request(app).post("/research-projects/solar-kit/archive");

      expect(response.status).toBe(409);
      expect(response.body.message).toBe("This project is archived.");
    });

    it("answers 200 on successful archive", async () => {
      archiveResearchProjectMock.mockResolvedValue({
        success: true,
        value: { id: "proj_1", status: "archived" },
      });

      const response = await request(app).post("/research-projects/solar-kit/archive");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ id: "proj_1", status: "archived" });
    });
  });

  describe("PATCH /research-projects/:projectSlug/stage", () => {
    it("maps STAGE_UNCHANGED to 409", async () => {
      changeProjectStageMock.mockResolvedValue({
        success: false,
        error: { type: "STAGE_UNCHANGED" },
      });

      const response = await request(app).patch("/research-projects/solar-kit/stage").send({ stage: "building_mvp" });

      expect(response.status).toBe(409);
      expect(response.body.message).toBe("The project is already at that stage.");
    });

    it("answers 200 on stage transition", async () => {
      changeProjectStageMock.mockResolvedValue({
        success: true,
        value: { stage: "building_mvp" },
      });

      const response = await request(app).patch("/research-projects/solar-kit/stage").send({ stage: "building_mvp" });

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ stage: "building_mvp" });
    });
  });

  describe("GET /research-projects/:projectSlug/stage-history", () => {
    it("answers 200 with stage history", async () => {
      const history = [{ id: "trans_1", fromStage: "concept", toStage: "building_mvp" }];
      listProjectStageTransitionsMock.mockResolvedValue(history);

      const response = await request(app).get("/research-projects/solar-kit/stage-history");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(history);
    });
  });

  describe("DELETE /research-projects/:projectSlug/members/me", () => {
    it("maps FOUNDER_CANNOT_LEAVE to 409", async () => {
      leaveProjectMock.mockResolvedValue({
        success: false,
        error: { type: "FOUNDER_CANNOT_LEAVE" },
      });

      const response = await request(app).delete("/research-projects/solar-kit/members/me");

      expect(response.status).toBe(409);
      expect(response.body.message).toContain("A founder cannot leave");
    });

    it("answers 200 on leaving project", async () => {
      leaveProjectMock.mockResolvedValue({
        success: true,
        value: { left: true },
      });

      const response = await request(app).delete("/research-projects/solar-kit/members/me");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ left: true });
    });
  });

  describe("DELETE /research-projects/:projectSlug/members/:memberId", () => {
    it("maps FOUNDER_ROLE_IMMUTABLE to 403", async () => {
      removeProjectMemberMock.mockResolvedValue({
        success: false,
        error: { type: "FOUNDER_ROLE_IMMUTABLE" },
      });

      const response = await request(app).delete("/research-projects/solar-kit/members/mem_founder");

      expect(response.status).toBe(403);
      expect(response.body.message).toBe("The founder's role cannot be changed or removed.");
    });

    it("maps MEMBER_NOT_FOUND to 404", async () => {
      removeProjectMemberMock.mockResolvedValue({
        success: false,
        error: { type: "MEMBER_NOT_FOUND" },
      });

      const response = await request(app).delete("/research-projects/solar-kit/members/mem_missing");

      expect(response.status).toBe(404);
      expect(response.body.message).toBe("Member not found.");
    });

    it("answers 200 on successful removal", async () => {
      removeProjectMemberMock.mockResolvedValue({
        success: true,
        value: { removed: true },
      });

      const response = await request(app).delete("/research-projects/solar-kit/members/mem_contrib");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ removed: true });
    });
  });

  describe("POST & DELETE /research-projects/:projectSlug/watch", () => {
    it("watch answers 404 if project is not active", async () => {
      findMembershipProjectBySlugMock.mockResolvedValue({
        projectId: "proj_1",
        projectSlug: "solar-kit",
        projectStatus: "draft",
      });

      const response = await request(app).post("/research-projects/solar-kit/watch");

      expect(response.status).toBe(404);
    });

    it("watch answers 200 if project is active", async () => {
      findMembershipProjectBySlugMock.mockResolvedValue({
        projectId: "proj_1",
        projectSlug: "solar-kit",
        projectStatus: "active",
      });
      watchProjectMock.mockResolvedValue(undefined);

      const response = await request(app).post("/research-projects/solar-kit/watch");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ isWatchedByViewer: true });
    });

    it("unwatch answers 200 when project exists", async () => {
      findMembershipProjectBySlugMock.mockResolvedValue({
        projectId: "proj_1",
        projectSlug: "solar-kit",
        projectStatus: "active",
      });
      unwatchProjectMock.mockResolvedValue(undefined);

      const response = await request(app).delete("/research-projects/solar-kit/watch");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ isWatchedByViewer: false });
    });
  });

  describe("POST & DELETE /research-projects/:projectSlug/market-insight-links", () => {
    const validInsightId = "11111111-1111-4111-8111-111111111111";

    it("POST links insight and answers 201", async () => {
      linkMarketInsightToProjectMock.mockResolvedValue({
        success: true,
        value: { insightId: validInsightId, headline: "Market insight headline" },
      });

      const response = await request(app)
        .post("/research-projects/solar-kit/market-insight-links")
        .send({ insightId: validInsightId });

      expect(response.status).toBe(201);
      expect(response.body.data).toEqual({ insightId: validInsightId, headline: "Market insight headline" });
    });

    it("DELETE unlinks insight and answers 200", async () => {
      unlinkMarketInsightFromProjectMock.mockResolvedValue({
        success: true,
        value: { unlinked: true },
      });

      const response = await request(app).delete(`/research-projects/solar-kit/market-insight-links/${validInsightId}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ unlinked: true });
    });
  });
});
