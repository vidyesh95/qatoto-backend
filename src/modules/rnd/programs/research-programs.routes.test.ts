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

// Mock platform-role.service
const requirePlatformCapabilityMock = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/platform/roles/platform-role.service.js", () => ({
  requirePlatformCapability: (...args: readonly unknown[]) => requirePlatformCapabilityMock(...args),
}));

// Mock research-program-access.service
const requireProgramVisibleMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const requireProgramWritableMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const requireProgramOwnerMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const hasAnyPlatformRoleMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const findParticipantMock = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/rnd/programs/research-program-access.service.js", () => ({
  requireProgramVisible: (...args: readonly unknown[]) => requireProgramVisibleMock(...args),
  requireProgramWritable: (...args: readonly unknown[]) => requireProgramWritableMock(...args),
  requireProgramOwner: (...args: readonly unknown[]) => requireProgramOwnerMock(...args),
  hasAnyPlatformRole: (...args: readonly unknown[]) => hasAnyPlatformRoleMock(...args),
  findParticipant: (...args: readonly unknown[]) => findParticipantMock(...args),
}));

// Mock research-programs.service
const listPublicResearchProgramsMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const listPublishedProgramSlugsMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const listOwnResearchProgramsMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const listProgramsAwaitingReviewMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const createResearchProgramMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const findResearchProgramDetailMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const updateResearchProgramMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const findLatestProgramStatsMock = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/rnd/programs/research-programs.service.js", () => ({
  listPublicResearchPrograms: (...args: readonly unknown[]) => listPublicResearchProgramsMock(...args),
  listPublishedProgramSlugs: (...args: readonly unknown[]) => listPublishedProgramSlugsMock(...args),
  listOwnResearchPrograms: (...args: readonly unknown[]) => listOwnResearchProgramsMock(...args),
  listProgramsAwaitingReview: (...args: readonly unknown[]) => listProgramsAwaitingReviewMock(...args),
  createResearchProgram: (...args: readonly unknown[]) => createResearchProgramMock(...args),
  findResearchProgramDetail: (...args: readonly unknown[]) => findResearchProgramDetailMock(...args),
  updateResearchProgram: (...args: readonly unknown[]) => updateResearchProgramMock(...args),
  findLatestProgramStats: (...args: readonly unknown[]) => findLatestProgramStatsMock(...args),
}));

// Mock research-program-moderation.service
const decideProgramPublicationMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const decidePaperModerationMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const listOpenContentReportsMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const listProgramModerationActionsMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const decidePostVisibilityMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const dismissContentReportMock = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/rnd/programs/research-program-moderation.service.js", () => ({
  decideProgramPublication: (...args: readonly unknown[]) => decideProgramPublicationMock(...args),
  decidePaperModeration: (...args: readonly unknown[]) => decidePaperModerationMock(...args),
  listOpenContentReports: (...args: readonly unknown[]) => listOpenContentReportsMock(...args),
  listProgramModerationActions: (...args: readonly unknown[]) => listProgramModerationActionsMock(...args),
  decidePostVisibility: (...args: readonly unknown[]) => decidePostVisibilityMock(...args),
  dismissContentReport: (...args: readonly unknown[]) => dismissContentReportMock(...args),
}));

// Mock research-program-branches.service
const listProgramBranchesMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const createProgramBranchMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const updateProgramBranchMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const claimProgramBranchMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const releaseProgramBranchClaimMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const findBranchInProgramMock = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/rnd/programs/research-program-branches.service.js", () => ({
  listProgramBranches: (...args: readonly unknown[]) => listProgramBranchesMock(...args),
  createProgramBranch: (...args: readonly unknown[]) => createProgramBranchMock(...args),
  updateProgramBranch: (...args: readonly unknown[]) => updateProgramBranchMock(...args),
  claimProgramBranch: (...args: readonly unknown[]) => claimProgramBranchMock(...args),
  releaseProgramBranchClaim: (...args: readonly unknown[]) => releaseProgramBranchClaimMock(...args),
  findBranchInProgram: (...args: readonly unknown[]) => findBranchInProgramMock(...args),
}));

// Mock research-papers.service
const listProgramPapersMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const createProgramPaperMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const findProgramPaperMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const createPaperDownloadUrlMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const deleteProgramPaperMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const countProgramPapersByStatusMock = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/rnd/programs/research-papers.service.js", () => ({
  listProgramPapers: (...args: readonly unknown[]) => listProgramPapersMock(...args),
  createProgramPaper: (...args: readonly unknown[]) => createProgramPaperMock(...args),
  findProgramPaper: (...args: readonly unknown[]) => findProgramPaperMock(...args),
  createPaperDownloadUrl: (...args: readonly unknown[]) => createPaperDownloadUrlMock(...args),
  deleteProgramPaper: (...args: readonly unknown[]) => deleteProgramPaperMock(...args),
  countProgramPapersByStatus: (...args: readonly unknown[]) => countProgramPapersByStatusMock(...args),
}));

// Mock research-program-posts.service
const listProgramPostsMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const listPostRepliesMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const createProgramPostMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const createPostReplyMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const addPostReactionMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const removePostReactionMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const findPostInProgramMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const reportProgramContentMock = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/rnd/programs/research-program-posts.service.js", () => ({
  listProgramPosts: (...args: readonly unknown[]) => listProgramPostsMock(...args),
  listPostReplies: (...args: readonly unknown[]) => listPostRepliesMock(...args),
  createProgramPost: (...args: readonly unknown[]) => createProgramPostMock(...args),
  createPostReply: (...args: readonly unknown[]) => createPostReplyMock(...args),
  addPostReaction: (...args: readonly unknown[]) => addPostReactionMock(...args),
  removePostReaction: (...args: readonly unknown[]) => removePostReactionMock(...args),
  findPostInProgram: (...args: readonly unknown[]) => findPostInProgramMock(...args),
  reportProgramContent: (...args: readonly unknown[]) => reportProgramContentMock(...args),
}));

// Mock research-program-participants.service
const listProgramParticipantsMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const joinResearchProgramMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const updateOwnParticipationMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const logResearchEffortMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const recordResearchContributionMock = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/rnd/programs/research-program-participants.service.js", () => ({
  listProgramParticipants: (...args: readonly unknown[]) => listProgramParticipantsMock(...args),
  joinResearchProgram: (...args: readonly unknown[]) => joinResearchProgramMock(...args),
  updateOwnParticipation: (...args: readonly unknown[]) => updateOwnParticipationMock(...args),
  logResearchEffort: (...args: readonly unknown[]) => logResearchEffortMock(...args),
  recordResearchContribution: (...args: readonly unknown[]) => recordResearchContributionMock(...args),
}));

// Mock research-program-opportunities.service
const listProgramOpportunitiesMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const createProgramOpportunityMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const deleteProgramOpportunityMock = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/rnd/programs/research-program-opportunities.service.js", () => ({
  listProgramOpportunities: (...args: readonly unknown[]) => listProgramOpportunitiesMock(...args),
  createProgramOpportunity: (...args: readonly unknown[]) => createProgramOpportunityMock(...args),
  deleteProgramOpportunity: (...args: readonly unknown[]) => deleteProgramOpportunityMock(...args),
}));

// Mock research-paper-categories.service
const listResearchPaperCategoriesMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const createResearchPaperCategoryMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const decidePaperCategoryMock = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/rnd/programs/research-paper-categories.service.js", () => ({
  listResearchPaperCategories: (...args: readonly unknown[]) => listResearchPaperCategoriesMock(...args),
  createResearchPaperCategory: (...args: readonly unknown[]) => createResearchPaperCategoryMock(...args),
  decidePaperCategory: (...args: readonly unknown[]) => decidePaperCategoryMock(...args),
}));

describe("research-programs routes", () => {
  let app: Express;

  const defaultProgramContext = {
    programId: "prog_immortal_1",
    programSlug: "project-immortal",
    programStatus: "published",
    createdByUserId: "usr_creator_1",
    isCreator: true,
  };

  const defaultPaper = {
    id: "paper_1",
    programId: "prog_immortal_1",
    title: "Targeted Senolysis",
    moderationStatus: "approved",
    storageKey: "papers/paper_1.pdf",
  };

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signInAs();
    await resetRateLimiters();

    requireProgramVisibleMock.mockResolvedValue({ success: true, value: defaultProgramContext });
    requireProgramWritableMock.mockResolvedValue({ success: true, value: defaultProgramContext });
    requireProgramOwnerMock.mockResolvedValue({ success: true, value: defaultProgramContext });
    hasAnyPlatformRoleMock.mockResolvedValue(true);
    findParticipantMock.mockResolvedValue({ participantId: "part_1", role: "researcher" });
    requirePlatformCapabilityMock.mockResolvedValue({
      success: true,
      value: { staffUserId: "usr_mod_1", role: "moderator" },
    });
  });

  describe("GET /research-programs (collection reads)", () => {
    it("answers 200 with public programs list", async () => {
      listPublicResearchProgramsMock.mockResolvedValue({
        rows: [{ id: "prog_1", title: "Project Immortal" }],
        total: 1,
      });

      const response = await request(app).get("/research-programs?page=1&limit=20");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([{ id: "prog_1", title: "Project Immortal" }]);
      expect(response.body.pagination).toEqual({
        page: 1,
        limit: 20,
        total: 1,
        totalPages: 1,
      });
    });

    it("GET /slugs answers 200 without auth", async () => {
      signOut();
      listPublishedProgramSlugsMock.mockResolvedValue(["project-immortal", "neural-interfaces"]);

      const response = await request(app).get("/research-programs/slugs");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(["project-immortal", "neural-interfaces"]);
    });

    it("GET /mine answers 401 when signed out", async () => {
      signOut();

      const response = await request(app).get("/research-programs/mine");

      expect(response.status).toBe(401);
    });

    it("GET /mine answers 200 with user's programs", async () => {
      listOwnResearchProgramsMock.mockResolvedValue([{ id: "prog_mine_1", title: "My Proposed Program" }]);

      const response = await request(app).get("/research-programs/mine");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([{ id: "prog_mine_1", title: "My Proposed Program" }]);
    });
  });

  describe("POST /research-programs (propose)", () => {
    const validProposal = {
      title: "Cellular Senescence Foundry",
      tagline: "High-throughput drug discovery for rejuvenation biology.",
      missionStatement: "Creating an open-source biological repository and screening platform for cellular repair.",
    };

    it("answers 401 when signed out", async () => {
      signOut();

      const response = await request(app).post("/research-programs").send(validProposal);

      expect(response.status).toBe(401);
    });

    it("rejects invalid proposal body with 422", async () => {
      const response = await request(app)
        .post("/research-programs")
        .send({ ...validProposal, missionStatement: "Too short." });

      expect(response.status).toBe(422);
    });

    it("proposes program and answers 201 on success", async () => {
      createResearchProgramMock.mockResolvedValue({
        success: true,
        value: { id: "prog_new_1", title: validProposal.title, status: "pending" },
      });

      const response = await request(app).post("/research-programs").send(validProposal);

      expect(response.status).toBe(201);
      expect(response.body.data).toEqual({ id: "prog_new_1", title: validProposal.title, status: "pending" });
    });
  });

  describe("GET, PATCH /research-programs/:programSlug", () => {
    it("GET answers 404 if program is not visible", async () => {
      requireProgramVisibleMock.mockResolvedValue({
        success: false,
        error: { type: "NOT_FOUND", programRef: "non-existent" },
      });

      const response = await request(app).get("/research-programs/non-existent");

      expect(response.status).toBe(404);
      expect(response.body.message).toBe("Research program not found.");
    });

    it("GET answers 200 with program details", async () => {
      const programDetails = { id: "prog_1", slug: "project-immortal", title: "Project Immortal" };
      findResearchProgramDetailMock.mockResolvedValue(programDetails);

      const response = await request(app).get("/research-programs/project-immortal");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ ...programDetails, isViewerParticipant: true });
    });

    it("GET /stats answers 200 with program stats", async () => {
      const stats = { branchCount: 12, paperCount: 45, participantCount: 150 };
      findLatestProgramStatsMock.mockResolvedValue(stats);

      const response = await request(app).get("/research-programs/project-immortal/stats");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(stats);
    });

    it("PATCH answers 200 on valid update by creator", async () => {
      const updated = { id: "prog_1", tagline: "Updated mission and tagline." };
      updateResearchProgramMock.mockResolvedValue({ success: true, value: updated });
      findResearchProgramDetailMock.mockResolvedValue(updated);

      const response = await request(app)
        .patch("/research-programs/project-immortal")
        .send({ tagline: "Updated mission and tagline." });

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(updated);
    });
  });

  describe("POST /research-programs/:programSlug/moderate", () => {
    it("rejects non-staff with 403", async () => {
      requirePlatformCapabilityMock.mockResolvedValue({
        success: false,
        error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_content" },
      });

      const response = await request(app)
        .post("/research-programs/project-immortal/moderate")
        .send({ decision: "published", reviewerNote: "Verified." });

      expect(response.status).toBe(403);
    });

    it("moderates program and answers 200 for staff", async () => {
      decideProgramPublicationMock.mockResolvedValue({
        success: true,
        value: { id: "prog_1", status: "published" },
      });

      const response = await request(app)
        .post("/research-programs/project-immortal/moderate")
        .send({ decision: "published", reviewerNote: "Verified by research team." });

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ id: "prog_1", status: "published" });
    });
  });

  describe("Branches API (/research-programs/:programSlug/branches)", () => {
    it("GET answers 200 with branch tree", async () => {
      const tree = [{ id: "branch_1", title: "Target Discovery", children: [] }];
      listProgramBranchesMock.mockResolvedValue(tree);

      const response = await request(app).get("/research-programs/project-immortal/branches");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(tree);
    });

    it("POST creates a new branch and answers 201", async () => {
      const createdBranch = { id: "branch_new_1", title: "CRISPR Screen" };
      createProgramBranchMock.mockResolvedValue({ success: true, value: createdBranch });

      const response = await request(app)
        .post("/research-programs/project-immortal/branches")
        .send({ title: "CRISPR Screen", summary: "High-throughput genetic screen." });

      expect(response.status).toBe(201);
      expect(response.body.data).toEqual(createdBranch);
    });

    it("POST .../claim and DELETE .../claim claim and release branch leadership", async () => {
      claimProgramBranchMock.mockResolvedValue({ success: true, value: { claimed: true } });
      releaseProgramBranchClaimMock.mockResolvedValue({ success: true, value: { released: true } });

      const claimRes = await request(app).post("/research-programs/project-immortal/branches/branch_1/claim");
      expect(claimRes.status).toBe(200);
      expect(claimRes.body.data).toEqual({ claimed: true });

      const releaseRes = await request(app).delete("/research-programs/project-immortal/branches/branch_1/claim");
      expect(releaseRes.status).toBe(200);
      expect(releaseRes.body.data).toEqual({ released: true });
    });
  });

  describe("Papers API (/research-programs/:programSlug/papers)", () => {
    it("POST /papers creates paper metadata and answers 201", async () => {
      const paperData = {
        title: "Targeted Senolysis in Primary Murine Models",
        categoryId: "cat_longevity_01",
        abstractText: "We report discovery of a senolytic agent.",
      };
      createProgramPaperMock.mockResolvedValue({
        success: true,
        value: { id: "paper_1", title: paperData.title },
      });

      const response = await request(app).post("/research-programs/project-immortal/papers").send(paperData);

      expect(response.status).toBe(201);
      expect(response.body.data).toEqual({ id: "paper_1", title: paperData.title });
    });

    it("GET /papers/:paperId/download answers 200 with presigned download URL", async () => {
      findProgramPaperMock.mockResolvedValue(defaultPaper);
      createPaperDownloadUrlMock.mockResolvedValue({
        success: true,
        value: { downloadUrl: "https://storage.example.com/papers/paper_1.pdf" },
      });

      const response = await request(app).get("/research-programs/project-immortal/papers/paper_1/download");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({
        downloadUrl: "https://storage.example.com/papers/paper_1.pdf",
      });
    });

    it("POST /papers/:paperId/report reports paper and answers 201", async () => {
      findProgramPaperMock.mockResolvedValue(defaultPaper);
      reportProgramContentMock.mockResolvedValue({
        success: true,
        value: { reportId: "rep_1" },
      });

      const response = await request(app)
        .post("/research-programs/project-immortal/papers/paper_1/report")
        .send({ reason: "spam" });

      expect(response.status).toBe(201);
      expect(response.body.data).toEqual({ reportId: "rep_1" });
    });
  });

  describe("Posts API (/research-programs/:programSlug/posts)", () => {
    it("POST /posts creates post thread and answers 201", async () => {
      const postPayload = {
        track: "idea" as const,
        bodyText: "Could microfluidics accelerate high-content screening?",
      };
      createProgramPostMock.mockResolvedValue({
        success: true,
        value: { id: "post_1", bodyText: postPayload.bodyText },
      });

      const response = await request(app).post("/research-programs/project-immortal/posts").send(postPayload);

      expect(response.status).toBe(201);
      expect(response.body.data).toEqual({ id: "post_1", bodyText: postPayload.bodyText });
    });

    it("POST /posts/:postId/replies creates reply and answers 201", async () => {
      createPostReplyMock.mockResolvedValue({
        success: true,
        value: { id: "rep_1", bodyText: "Yes, chip-based sorting scales nicely." },
      });

      const response = await request(app)
        .post("/research-programs/project-immortal/posts/post_1/replies")
        .send({ bodyText: "Yes, chip-based sorting scales nicely." });

      expect(response.status).toBe(201);
      expect(response.body.data).toEqual({ id: "rep_1", bodyText: "Yes, chip-based sorting scales nicely." });
    });

    it("PUT & DELETE /posts/:postId/reaction toggle reaction", async () => {
      addPostReactionMock.mockResolvedValue({ success: true, value: { reacted: true } });
      removePostReactionMock.mockResolvedValue({ success: true, value: { reacted: false } });

      const putRes = await request(app).put("/research-programs/project-immortal/posts/post_1/reaction");
      expect(putRes.status).toBe(200);

      const delRes = await request(app).delete("/research-programs/project-immortal/posts/post_1/reaction");
      expect(delRes.status).toBe(200);
    });
  });

  describe("Participants & Opportunities", () => {
    it("POST .../contributors/me joins program roster and answers 201", async () => {
      joinResearchProgramMock.mockResolvedValue({
        success: true,
        value: { participantId: "part_1", role: "researcher" },
      });

      const response = await request(app)
        .post("/research-programs/project-immortal/contributors/me")
        .send({ role: "researcher", compensationPreference: "equity" });

      expect(response.status).toBe(201);
      expect(response.body.data).toEqual({ participantId: "part_1", role: "researcher" });
    });

    it("POST .../effort-logs logs time and answers 201", async () => {
      logResearchEffortMock.mockResolvedValue({
        success: true,
        value: { logId: "log_1", minutes: 120 },
      });

      const response = await request(app).post("/research-programs/project-immortal/effort-logs").send({
        minutes: 120,
        loggedForDate: "2026-06-15",
        note: "Assay preparation.",
        idempotencyKey: "effort_key_998877",
      });

      expect(response.status).toBe(201);
      expect(response.body.data).toEqual({ logId: "log_1", minutes: 120 });
    });

    it("POST .../product-opportunities creates opportunity and answers 201", async () => {
      createProgramOpportunityMock.mockResolvedValue({
        success: true,
        value: { id: "opp_1", productName: "Reagent Kit" },
      });

      const response = await request(app).post("/research-programs/project-immortal/product-opportunities").send({
        productName: "Reagent Kit",
        productDescription: "Cellular profiling kit.",
        derivedFromBranchId: "branch_1",
        estimatedMarketSizeInCents: "100000000",
        readinessMinMonths: 6,
        readinessMaxMonths: 18,
      });

      expect(response.status).toBe(201);
      expect(response.body.data).toEqual({ id: "opp_1", productName: "Reagent Kit" });
    });
  });

  describe("Paper Categories (/research-paper-categories)", () => {
    it("GET /research-paper-categories answers 200 with approved categories", async () => {
      listResearchPaperCategoriesMock.mockResolvedValue([{ id: "cat_1", label: "Cellular Biology" }]);

      const response = await request(app).get("/research-paper-categories");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([{ id: "cat_1", label: "Cellular Biology" }]);
    });

    it("POST /research-paper-categories proposes category and answers 201", async () => {
      createResearchPaperCategoryMock.mockResolvedValue({
        success: true,
        value: { id: "cat_new_1", label: "Synthetic Biology", status: "pending" },
      });

      const response = await request(app).post("/research-paper-categories").send({ label: "Synthetic Biology" });

      expect(response.status).toBe(201);
      expect(response.body.data).toEqual({
        id: "cat_new_1",
        label: "Synthetic Biology",
        status: "pending",
      });
    });

    it("POST /research-paper-categories/:categoryId/decide moderates category and answers 200", async () => {
      decidePaperCategoryMock.mockResolvedValue({
        success: true,
        value: { id: "cat_1", status: "approved" },
      });

      const response = await request(app).post("/research-paper-categories/cat_1/decide").send({ decision: "approve" });

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ id: "cat_1", status: "approved" });
    });
  });
});
