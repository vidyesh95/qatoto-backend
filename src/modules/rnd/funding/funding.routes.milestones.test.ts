import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for §7's milestone writes — id-keyed (`findMilestoneWithProject`
 * resolves the owning project first, then `requireProjectRole` proves membership against
 * it) plus the project-scoped create. Previously zero coverage.
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

const findMilestoneWithProject = vi.fn<(...args: readonly unknown[]) => unknown>();
const updateMilestone = vi.fn<(...args: readonly unknown[]) => unknown>();
const completeMilestone = vi.fn<(...args: readonly unknown[]) => unknown>();
const deleteMilestone = vi.fn<(...args: readonly unknown[]) => unknown>();
const putMilestoneVariance = vi.fn<(...args: readonly unknown[]) => unknown>();
const createMilestone = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/rnd/funding/milestones.service.js", () => ({
  findMilestoneWithProject: (...args: readonly unknown[]) => findMilestoneWithProject(...args),
  updateMilestone: (...args: readonly unknown[]) => updateMilestone(...args),
  completeMilestone: (...args: readonly unknown[]) => completeMilestone(...args),
  deleteMilestone: (...args: readonly unknown[]) => deleteMilestone(...args),
  putMilestoneVariance: (...args: readonly unknown[]) => putMilestoneVariance(...args),
  createMilestone: (...args: readonly unknown[]) => createMilestone(...args),
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
    memberRole: "maintainer",
  },
} as const;

const SLUG = "solar-cold-storage";

describe("funding routes — milestone writes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signInAs();
    await resetRateLimiters();
  });

  describe("PATCH /milestones/:milestoneId", () => {
    const path = "/milestones/milestone_1";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).patch(path).send({ title: "New title" });

      expect(response.status).toBe(401);
      expect(updateMilestone).not.toHaveBeenCalled();
    });

    it("resolves the owning project, requires maintainer+, and passes the typed body", async () => {
      findMilestoneWithProject.mockResolvedValue({ projectSlug: SLUG });
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      updateMilestone.mockResolvedValue({ success: true, value: { title: "New title" } });

      const response = await request(app).patch(path).send({ title: "New title", plannedPayoutInCents: "50000" });

      expect(response.status).toBe(200);
      expect(requireProjectRole).toHaveBeenCalledWith(SLUG, "user_test_caller", "maintainer");
      expect(updateMilestone).toHaveBeenCalledWith("project_1", "milestone_1", {
        title: "New title",
        plannedPayoutInCents: 50000n,
      });
    });

    it("404s identically for an unresolvable milestone id and a foreign one", async () => {
      findMilestoneWithProject.mockResolvedValue(undefined);
      const unresolved = await request(app).patch(path).send({ title: "x" });

      findMilestoneWithProject.mockResolvedValue({ projectSlug: "other-project" });
      requireProjectRole.mockResolvedValue({
        success: false,
        error: { type: "NOT_FOUND", projectRef: "other-project" },
      });
      const foreign = await request(app).patch("/milestones/milestone_elsewhere").send({ title: "x" });

      expect(unresolved.status).toBe(foreign.status);
      expect(unresolved.body).toEqual(foreign.body);
    });

    it("rejects an unknown field such as a client-supplied status", async () => {
      findMilestoneWithProject.mockResolvedValue({ projectSlug: SLUG });
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);

      const response = await request(app).patch(path).send({ status: "done" });

      expect(response.status).toBe(422);
      expect(updateMilestone).not.toHaveBeenCalled();
    });

    it("maps MILESTONE_TERMINAL to 409", async () => {
      findMilestoneWithProject.mockResolvedValue({ projectSlug: SLUG });
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      updateMilestone.mockResolvedValue({
        success: false,
        error: { type: "MILESTONE_TERMINAL", status: "done" },
      });

      const response = await request(app).patch(path).send({ title: "New title" });

      expect(response.status).toBe(409);
    });
  });

  describe("POST /milestones/:milestoneId/complete", () => {
    const path = "/milestones/milestone_1/complete";

    it("completes the milestone for an authorized caller", async () => {
      findMilestoneWithProject.mockResolvedValue({ projectSlug: SLUG });
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      completeMilestone.mockResolvedValue({ success: true, value: { status: "done" } });

      const response = await request(app).post(path);

      expect(response.status).toBe(200);
      expect(completeMilestone).toHaveBeenCalledWith("project_1", "milestone_1");
    });

    it("maps MILESTONE_ALREADY_COMPLETE to 409", async () => {
      findMilestoneWithProject.mockResolvedValue({ projectSlug: SLUG });
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      completeMilestone.mockResolvedValue({
        success: false,
        error: { type: "MILESTONE_ALREADY_COMPLETE" },
      });

      const response = await request(app).post(path);

      expect(response.status).toBe(409);
    });
  });

  describe("DELETE /milestones/:milestoneId", () => {
    const path = "/milestones/milestone_1";

    it("deletes an uncited milestone", async () => {
      findMilestoneWithProject.mockResolvedValue({ projectSlug: SLUG });
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      deleteMilestone.mockResolvedValue({ success: true, value: { id: "milestone_1" } });

      const response = await request(app).delete(path);

      expect(response.status).toBe(200);
      expect(deleteMilestone).toHaveBeenCalledWith("project_1", "milestone_1");
    });

    it("maps MILESTONE_HAS_REFERENCES to 409 — cited by an escrow release", async () => {
      findMilestoneWithProject.mockResolvedValue({ projectSlug: SLUG });
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      deleteMilestone.mockResolvedValue({
        success: false,
        error: { type: "MILESTONE_HAS_REFERENCES" },
      });

      const response = await request(app).delete(path);

      expect(response.status).toBe(409);
    });
  });

  describe("PUT /milestones/:milestoneId/variance", () => {
    const path = "/milestones/milestone_1/variance";
    const validBody = {
      plannedDurationDays: 10,
      actualDurationDays: 14,
      plannedCostInCents: "100000",
      actualCostInCents: "120000",
      plannedEffortMinutes: 4800,
      actualEffortMinutes: 5600,
    };

    it("records the six typed integers, deriving the currency from membership", async () => {
      findMilestoneWithProject.mockResolvedValue({ projectSlug: SLUG });
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      putMilestoneVariance.mockResolvedValue({ success: true, value: { varianceBasisPoints: 2000 } });

      const response = await request(app).put(path).send(validBody);

      expect(response.status).toBe(200);
      expect(putMilestoneVariance).toHaveBeenCalledWith("project_1", "milestone_1", "INR", {
        plannedDurationDays: 10,
        actualDurationDays: 14,
        plannedCostInCents: 100000n,
        actualCostInCents: 120000n,
        plannedEffortMinutes: 4800,
        actualEffortMinutes: 5600,
      });
    });

    it("rejects a body carrying a client-supplied varianceBasisPoints — the server computes it", async () => {
      findMilestoneWithProject.mockResolvedValue({ projectSlug: SLUG });
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);

      const response = await request(app)
        .put(path)
        .send({ ...validBody, varianceBasisPoints: 999 });

      expect(response.status).toBe(422);
      expect(putMilestoneVariance).not.toHaveBeenCalled();
    });
  });

  describe("POST /research-projects/:projectSlug/milestones", () => {
    const path = `/research-projects/${SLUG}/milestones`;
    const validBody = { title: "Prototype shipped", plannedPayoutInCents: "50000" };

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(401);
      expect(createMilestone).not.toHaveBeenCalled();
    });

    it("requires maintainer+ and creates the milestone", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      createMilestone.mockResolvedValue({ success: true, value: { id: "milestone_new" } });

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(201);
      expect(requireProjectRole).toHaveBeenCalledWith(SLUG, "user_test_caller", "maintainer");
      expect(createMilestone).toHaveBeenCalledWith(
        MEMBER_CONTEXT.value,
        "user_test_caller",
        expect.objectContaining({ title: "Prototype shipped", plannedPayoutInCents: 50000n }),
      );
    });

    it("404s for a non-member", async () => {
      requireProjectRole.mockResolvedValue({
        success: false,
        error: { type: "NOT_FOUND", projectRef: SLUG },
      });

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(404);
    });
  });
});
