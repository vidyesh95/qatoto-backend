import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for §7's READ surface — `fundingRouter` (root-mounted, id-keyed) and
 * `projectFundingRouter` (mounted at `/research-projects`, slug-scoped). Previously zero
 * route-level coverage; only `funding.schemas.test.ts`, `funding-error-response.test.ts`
 * and `escrow-math.test.ts` existed, all pure-function/unit level.
 *
 * `fundingRouter`'s id-keyed routes do NOT use `requireProjectRole` directly for every
 * read — `getFundingRound` is PUBLIC for an `open`/`closed` round (a backer who is not a
 * member has to be able to read what they are being asked to fund) and only checks
 * membership for a draft/cancelled round, resolved via `findRoundWithProject`. This
 * mirrors the source exactly rather than force-fitting the project-role pattern.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

const requireProjectRole = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/rnd/projects/project-membership.service.js", () => ({
  requireProjectRole: (...args: readonly unknown[]) => requireProjectRole(...args),
  PROJECT_ROLE_RANK: { founder: 4, admin: 3, maintainer: 2, contributor: 1 },
}));

const listFundingDeals = vi.fn<(...args: readonly unknown[]) => unknown>();
const listMyFoundedFundingRounds = vi.fn<(...args: readonly unknown[]) => unknown>();
const getFundingRound = vi.fn<(...args: readonly unknown[]) => unknown>();
const findRoundWithProject = vi.fn<(...args: readonly unknown[]) => unknown>();
const listRoundBackers = vi.fn<(...args: readonly unknown[]) => unknown>();
const getPledgeOptions = vi.fn<(...args: readonly unknown[]) => unknown>();
const listMyPledges = vi.fn<(...args: readonly unknown[]) => unknown>();
const listProjectFundingRounds = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/rnd/funding/funding-rounds.service.js", () => ({
  listFundingDeals: (...args: readonly unknown[]) => listFundingDeals(...args),
  listMyFoundedFundingRounds: (...args: readonly unknown[]) => listMyFoundedFundingRounds(...args),
  getFundingRound: (...args: readonly unknown[]) => getFundingRound(...args),
  findRoundWithProject: (...args: readonly unknown[]) => findRoundWithProject(...args),
  listRoundBackers: (...args: readonly unknown[]) => listRoundBackers(...args),
  getPledgeOptions: (...args: readonly unknown[]) => getPledgeOptions(...args),
  listMyPledges: (...args: readonly unknown[]) => listMyPledges(...args),
  listProjectFundingRounds: (...args: readonly unknown[]) => listProjectFundingRounds(...args),
}));

const listProjectMilestones = vi.fn<(...args: readonly unknown[]) => unknown>();
const getMilestone = vi.fn<(...args: readonly unknown[]) => unknown>();
const findMilestoneWithProject = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/rnd/funding/milestones.service.js", () => ({
  listProjectMilestones: (...args: readonly unknown[]) => listProjectMilestones(...args),
  getMilestone: (...args: readonly unknown[]) => getMilestone(...args),
  findMilestoneWithProject: (...args: readonly unknown[]) => findMilestoneWithProject(...args),
}));

const getProjectCompensation = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/rnd/compensation/compensation.service.js", () => ({
  getProjectCompensation: (...args: readonly unknown[]) => getProjectCompensation(...args),
}));

const getLatestInvestorConfidence = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/rnd/funding/investor-confidence.service.js", () => ({
  getLatestInvestorConfidence: (...args: readonly unknown[]) => getLatestInvestorConfidence(...args),
}));

const MEMBER_CONTEXT = {
  success: true,
  value: {
    projectId: "project_1",
    projectSlug: "solar-cold-storage",
    projectStatus: "active",
    founderUserId: "user_founder",
    currency: "INR",
    memberId: "member_1",
    memberRole: "contributor",
  },
} as const;

const NOT_FOUND = { success: false, error: { type: "NOT_FOUND", projectRef: "solar-cold-storage" } };

const SLUG = "solar-cold-storage";
const BASE = `/research-projects/${SLUG}`;

describe("funding routes — reads", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signInAs();
    await resetRateLimiters();
  });

  describe("authentication and membership, project-scoped reads", () => {
    const getRoutes = [
      `${BASE}/funding-rounds`,
      `${BASE}/milestones`,
      `${BASE}/compensation`,
      `${BASE}/investor-confidence`,
    ] as const;

    it.each(getRoutes)("answers 401 for a signed-out caller on %s", async (path) => {
      signOut();

      const response = await request(app).get(path);

      expect(response.status).toBe(401);
      expect(requireProjectRole).not.toHaveBeenCalled();
    });

    it.each(getRoutes)("answers 404 for a signed-in non-member on %s", async (path) => {
      requireProjectRole.mockResolvedValue(NOT_FOUND);

      const response = await request(app).get(path);

      expect(response.status).toBe(404);
    });

    it("gives a non-member and an absent project byte-identical refusals", async () => {
      requireProjectRole.mockResolvedValue(NOT_FOUND);
      const nonMember = await request(app).get(`${BASE}/funding-rounds`);

      requireProjectRole.mockResolvedValue({
        success: false,
        error: { type: "NOT_FOUND", projectRef: "no-such-project" },
      });
      const absent = await request(app).get("/research-projects/no-such-project/funding-rounds");

      expect(nonMember.status).toBe(absent.status);
      expect(nonMember.body).toEqual(absent.body);
    });
  });

  describe("GET /funding/deals", () => {
    it("requires auth", async () => {
      signOut();

      const response = await request(app).get("/funding/deals");

      expect(response.status).toBe(401);
    });

    it("passes the parsed filter to the service", async () => {
      listFundingDeals.mockResolvedValue([]);

      const response = await request(app).get("/funding/deals?roundType=equity&stage=raising_funding");

      expect(response.status).toBe(200);
      expect(listFundingDeals).toHaveBeenCalledWith({ roundType: "equity", stage: "raising_funding" });
    });

    it("rejects an unknown query key with 422", async () => {
      const response = await request(app).get("/funding/deals?type=equity");

      expect(response.status).toBe(422);
      expect(listFundingDeals).not.toHaveBeenCalled();
    });
  });

  describe("GET /funding-rounds/mine", () => {
    it("requires auth and filters by the session id, not a client-supplied one", async () => {
      listMyFoundedFundingRounds.mockResolvedValue([]);

      const response = await request(app).get("/funding-rounds/mine");

      expect(response.status).toBe(200);
      expect(listMyFoundedFundingRounds).toHaveBeenCalledWith("user_test_caller", {});
    });

    it("is not shadowed by /funding-rounds/:roundId — declaring 'mine' as an id would 404", async () => {
      listMyFoundedFundingRounds.mockResolvedValue([{ id: "round_1" }]);
      getFundingRound.mockResolvedValue({ success: true, value: { status: "open" } });

      const response = await request(app).get("/funding-rounds/mine");

      expect(getFundingRound).not.toHaveBeenCalled();
      expect(response.body.data).toEqual([{ id: "round_1" }]);
    });
  });

  describe("GET /funding-rounds/:roundId", () => {
    it("requires a session (route carries requireAuth) even for an open round", async () => {
      signOut();
      getFundingRound.mockResolvedValue({ success: true, value: { status: "open", projectSlug: SLUG } });

      const response = await request(app).get("/funding-rounds/round_1");

      expect(response.status).toBe(401);
    });

    it("is readable by ANY signed-in caller for an open round — not membership-gated", async () => {
      getFundingRound.mockResolvedValue({ success: true, value: { status: "open", projectSlug: SLUG } });

      const response = await request(app).get("/funding-rounds/round_1");

      expect(response.status).toBe(200);
      expect(requireProjectRole).not.toHaveBeenCalled();
    });

    it("is readable by any signed-in caller for a closed round too", async () => {
      getFundingRound.mockResolvedValue({ success: true, value: { status: "closed", projectSlug: SLUG } });

      const response = await request(app).get("/funding-rounds/round_1");

      expect(response.status).toBe(200);
    });

    it("requires PROJECT membership (not just a session) for a draft round", async () => {
      getFundingRound.mockResolvedValue({ success: true, value: { status: "draft", projectSlug: SLUG } });
      requireProjectRole.mockResolvedValue(NOT_FOUND);

      const response = await request(app).get("/funding-rounds/round_1");

      expect(response.status).toBe(404);
      expect(requireProjectRole).toHaveBeenCalledWith(SLUG, "user_test_caller", "contributor");
    });

    it("404s a non-member reading a draft round, same as a stranger reading a nonexistent round", async () => {
      getFundingRound.mockResolvedValue({ success: true, value: { status: "draft", projectSlug: SLUG } });
      requireProjectRole.mockResolvedValue(NOT_FOUND);

      const response = await request(app).get("/funding-rounds/round_1");

      expect(response.status).toBe(404);
    });

    it("404s for a nonexistent round id", async () => {
      getFundingRound.mockResolvedValue({ success: false, error: { type: "ROUND_NOT_FOUND" } });

      const response = await request(app).get("/funding-rounds/round_missing");

      expect(response.status).toBe(404);
    });
  });

  describe("GET /funding-rounds/:roundId/backers", () => {
    it("requires auth", async () => {
      signOut();

      const response = await request(app).get("/funding-rounds/round_1/backers");

      expect(response.status).toBe(401);
    });

    it("loads settled backers for an existing round", async () => {
      getFundingRound.mockResolvedValue({ success: true, value: { status: "open" } });
      listRoundBackers.mockResolvedValue([]);

      const response = await request(app).get("/funding-rounds/round_1/backers?limit=10");

      expect(response.status).toBe(200);
      expect(listRoundBackers).toHaveBeenCalledWith("round_1", { limit: 10 });
    });

    it("404s for a nonexistent round", async () => {
      getFundingRound.mockResolvedValue({ success: false, error: { type: "ROUND_NOT_FOUND" } });

      const response = await request(app).get("/funding-rounds/round_missing/backers");

      expect(response.status).toBe(404);
      expect(listRoundBackers).not.toHaveBeenCalled();
    });
  });

  describe("GET /funding-rounds/:roundId/pledge-options", () => {
    it("requires auth", async () => {
      signOut();

      const response = await request(app).get("/funding-rounds/round_1/pledge-options");

      expect(response.status).toBe(401);
    });

    it("returns the server-enforced bounds", async () => {
      getPledgeOptions.mockResolvedValue({
        success: true,
        value: { minimumInCents: "1000", maximumInCents: null },
      });

      const response = await request(app).get("/funding-rounds/round_1/pledge-options");

      expect(response.status).toBe(200);
      expect(getPledgeOptions).toHaveBeenCalledWith("round_1");
    });
  });

  describe("GET /pledges/mine", () => {
    it("requires auth and filters by the session id", async () => {
      listMyPledges.mockResolvedValue([]);

      const response = await request(app).get("/pledges/mine");

      expect(response.status).toBe(200);
      expect(listMyPledges).toHaveBeenCalledWith("user_test_caller", {});
    });
  });

  describe("GET /milestones/:milestoneId", () => {
    it("requires auth", async () => {
      signOut();

      const response = await request(app).get("/milestones/milestone_1");

      expect(response.status).toBe(401);
    });

    it("resolves the owning project then proves membership before reading", async () => {
      findMilestoneWithProject.mockResolvedValue({ projectSlug: SLUG });
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      getMilestone.mockResolvedValue({ success: true, value: { id: "milestone_1" } });

      const response = await request(app).get("/milestones/milestone_1");

      expect(response.status).toBe(200);
      expect(requireProjectRole).toHaveBeenCalledWith(SLUG, "user_test_caller", "contributor");
      expect(getMilestone).toHaveBeenCalledWith("project_1", "milestone_1");
    });

    it("404s identically for an id that resolves to no project and a real but foreign one", async () => {
      findMilestoneWithProject.mockResolvedValue(undefined);

      const unresolved = await request(app).get("/milestones/milestone_missing");

      findMilestoneWithProject.mockResolvedValue({ projectSlug: "other-project" });
      requireProjectRole.mockResolvedValue({
        success: false,
        error: { type: "NOT_FOUND", projectRef: "other-project" },
      });

      const foreign = await request(app).get("/milestones/milestone_elsewhere");

      expect(unresolved.status).toBe(foreign.status);
      expect(unresolved.body).toEqual(foreign.body);
    });
  });

  describe("GET …/funding-rounds and …/milestones (project-scoped lists)", () => {
    it("lists a project's funding rounds", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      listProjectFundingRounds.mockResolvedValue([]);

      const response = await request(app).get(`${BASE}/funding-rounds`);

      expect(response.status).toBe(200);
      expect(listProjectFundingRounds).toHaveBeenCalledWith("project_1", SLUG);
    });

    it("lists a project's milestones", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      listProjectMilestones.mockResolvedValue([]);

      const response = await request(app).get(`${BASE}/milestones`);

      expect(response.status).toBe(200);
      expect(listProjectMilestones).toHaveBeenCalledWith("project_1");
    });
  });

  describe("GET …/compensation", () => {
    it("loads §9's rate table for the project", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      getProjectCompensation.mockResolvedValue({ rows: [] });

      const response = await request(app).get(`${BASE}/compensation`);

      expect(response.status).toBe(200);
      expect(getProjectCompensation).toHaveBeenCalledWith("project_1", "INR");
    });
  });

  describe("GET …/investor-confidence", () => {
    it("returns the latest snapshot", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      getLatestInvestorConfidence.mockResolvedValue({ success: true, value: { score: 71 } });

      const response = await request(app).get(`${BASE}/investor-confidence`);

      expect(response.status).toBe(200);
      expect(getLatestInvestorConfidence).toHaveBeenCalledWith("project_1");
    });

    it("404s CONFIDENCE_NOT_COMPUTED rather than fabricating a score", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      getLatestInvestorConfidence.mockResolvedValue({
        success: false,
        error: { type: "CONFIDENCE_NOT_COMPUTED" },
      });

      const response = await request(app).get(`${BASE}/investor-confidence`);

      expect(response.status).toBe(404);
    });
  });
});
