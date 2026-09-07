import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for §7's money-adjacent writes: pledge creation/cancellation (real
 * backer commitments, though no funds move — see `funding.controller.ts`'s own doc on
 * `createPledge`) and round lifecycle/planning writes. Previously zero coverage.
 *
 * `createPledge` is the highest-priority route in this file: it is idempotent
 * (`idempotency()`, honour-if-present — no `Idempotency-Key` sent below, matching "today's
 * behaviour" for a caller that sends none) and `requireIdentifiedUser`-gated so an
 * anonymous session cannot inflate `backersCount`.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

/**
 * `requireIdentifiedUser` hits the real `db` query builder; it has its own dedicated suite.
 * Stubbed to a pass-through here, following `import-intelligence.routes.test.ts`'s
 * precedent, so this suite stays about routing/wiring. `createPledge` and `cancelPledge`
 * still DECLARE it, so a dropped guard is caught elsewhere by a router-stack walk.
 */
vi.mock("#src/middleware/require-identified-user.js", () => ({
  requireIdentifiedUser: (_req: unknown, _res: unknown, next: (error?: unknown) => void): void => {
    next();
  },
}));

const requireProjectRole = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/rnd/projects/project-membership.service.js", () => ({
  requireProjectRole: (...args: readonly unknown[]) => requireProjectRole(...args),
  PROJECT_ROLE_RANK: { founder: 4, admin: 3, maintainer: 2, contributor: 1 },
}));

const createPledge = vi.fn<(...args: readonly unknown[]) => unknown>();
const cancelPledge = vi.fn<(...args: readonly unknown[]) => unknown>();
const findRoundWithProject = vi.fn<(...args: readonly unknown[]) => unknown>();
const openFundingRound = vi.fn<(...args: readonly unknown[]) => unknown>();
const closeFundingRound = vi.fn<(...args: readonly unknown[]) => unknown>();
const updateFundingRound = vi.fn<(...args: readonly unknown[]) => unknown>();
const deleteFundingRound = vi.fn<(...args: readonly unknown[]) => unknown>();
const createFundingRound = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/rnd/funding/funding-rounds.service.js", () => ({
  createPledge: (...args: readonly unknown[]) => createPledge(...args),
  cancelPledge: (...args: readonly unknown[]) => cancelPledge(...args),
  findRoundWithProject: (...args: readonly unknown[]) => findRoundWithProject(...args),
  openFundingRound: (...args: readonly unknown[]) => openFundingRound(...args),
  closeFundingRound: (...args: readonly unknown[]) => closeFundingRound(...args),
  updateFundingRound: (...args: readonly unknown[]) => updateFundingRound(...args),
  deleteFundingRound: (...args: readonly unknown[]) => deleteFundingRound(...args),
  createFundingRound: (...args: readonly unknown[]) => createFundingRound(...args),
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
    memberRole: "founder",
  },
} as const;

const SLUG = "solar-cold-storage";

describe("funding routes — pledges and round writes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signInAs();
    await resetRateLimiters();
  });

  describe("POST /funding-rounds/:roundId/pledges", () => {
    const path = "/funding-rounds/round_1/pledges";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).post(path).send({ amountInCents: "10000" });

      expect(response.status).toBe(401);
      expect(createPledge).not.toHaveBeenCalled();
    });

    it("records the pledge from the session id, never a client-supplied backerUserId, with no Idempotency-Key header sent", async () => {
      createPledge.mockResolvedValue({ success: true, value: { id: "pledge_1", status: "pending" } });

      const response = await request(app).post(path).send({ amountInCents: "10000" });

      expect(response.status).toBe(201);
      expect(createPledge).toHaveBeenCalledWith({
        roundId: "round_1",
        backerUserId: "user_test_caller",
        amountInCents: 10000n,
      });
      // The response must not claim money moved.
      expect(response.body.message).toMatch(/no funds have moved/i);
    });

    it("rejects a body carrying a backerUserId — there is no such field in the schema", async () => {
      const response = await request(app).post(path).send({ amountInCents: "10000", backerUserId: "user_other" });

      expect(response.status).toBe(422);
      expect(createPledge).not.toHaveBeenCalled();
    });

    it("maps SELF_PLEDGE_FORBIDDEN to 422 — a founder cannot pledge to their own round", async () => {
      createPledge.mockResolvedValue({ success: false, error: { type: "SELF_PLEDGE_FORBIDDEN" } });

      const response = await request(app).post(path).send({ amountInCents: "10000" });

      expect(response.status).toBe(422);
    });

    it("maps PLEDGE_BELOW_MINIMUM to 422", async () => {
      createPledge.mockResolvedValue({
        success: false,
        error: { type: "PLEDGE_BELOW_MINIMUM", minimumInCents: "5000" },
      });

      const response = await request(app).post(path).send({ amountInCents: "100" });

      expect(response.status).toBe(422);
    });

    it("maps ROUND_NOT_OPEN to 409", async () => {
      createPledge.mockResolvedValue({
        success: false,
        error: { type: "ROUND_NOT_OPEN", status: "draft" },
      });

      const response = await request(app).post(path).send({ amountInCents: "10000" });

      expect(response.status).toBe(409);
    });

    it("maps ROUND_CLOSED_FOR_PLEDGES to 409", async () => {
      createPledge.mockResolvedValue({
        success: false,
        error: { type: "ROUND_CLOSED_FOR_PLEDGES", closesAt: new Date("2026-01-01T00:00:00.000Z") },
      });

      const response = await request(app).post(path).send({ amountInCents: "10000" });

      expect(response.status).toBe(409);
    });
  });

  describe("POST /pledges/:pledgeId/cancel", () => {
    const path = "/pledges/pledge_1/cancel";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).post(path);

      expect(response.status).toBe(401);
      expect(cancelPledge).not.toHaveBeenCalled();
    });

    it("cancels on behalf of the resolved caller", async () => {
      cancelPledge.mockResolvedValue({ success: true, value: { status: "cancelled" } });

      const response = await request(app).post(path);

      expect(response.status).toBe(200);
      expect(cancelPledge).toHaveBeenCalledWith("pledge_1", "user_test_caller");
    });

    it("maps NOT_THE_BACKER to 403 — only the backer can cancel their own pledge", async () => {
      cancelPledge.mockResolvedValue({ success: false, error: { type: "NOT_THE_BACKER" } });

      const response = await request(app).post(path);

      expect(response.status).toBe(403);
    });

    it("maps PLEDGE_NOT_CANCELLABLE to 409", async () => {
      cancelPledge.mockResolvedValue({
        success: false,
        error: { type: "PLEDGE_NOT_CANCELLABLE", status: "settled" },
      });

      const response = await request(app).post(path);

      expect(response.status).toBe(409);
    });
  });

  describe("POST /funding-rounds/:roundId/open and /close", () => {
    it("resolves the owning project and requires admin+ to open", async () => {
      findRoundWithProject.mockResolvedValue({ projectSlug: SLUG });
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      openFundingRound.mockResolvedValue({ success: true, value: { status: "open" } });

      const response = await request(app).post("/funding-rounds/round_1/open");

      expect(response.status).toBe(200);
      expect(requireProjectRole).toHaveBeenCalledWith(SLUG, "user_test_caller", "admin");
      expect(openFundingRound).toHaveBeenCalledWith("round_1", "user_test_caller");
    });

    it("404s identically for an unresolvable round id on open", async () => {
      findRoundWithProject.mockResolvedValue(undefined);

      const response = await request(app).post("/funding-rounds/round_missing/open");

      expect(response.status).toBe(404);
      expect(openFundingRound).not.toHaveBeenCalled();
    });

    it("maps ROUND_ALREADY_OPEN to 409", async () => {
      findRoundWithProject.mockResolvedValue({ projectSlug: SLUG });
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      openFundingRound.mockResolvedValue({ success: false, error: { type: "ROUND_ALREADY_OPEN" } });

      const response = await request(app).post("/funding-rounds/round_1/open");

      expect(response.status).toBe(409);
    });

    it("closes a round for an authorized admin", async () => {
      findRoundWithProject.mockResolvedValue({ projectSlug: SLUG });
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      closeFundingRound.mockResolvedValue({ success: true, value: { status: "closed" } });

      const response = await request(app).post("/funding-rounds/round_1/close");

      expect(response.status).toBe(200);
      expect(closeFundingRound).toHaveBeenCalledWith("round_1", "user_test_caller");
    });
  });

  describe("PATCH /funding-rounds/:roundId", () => {
    const path = "/funding-rounds/round_1";

    it("requires FOUNDER (not merely admin) to edit round terms", async () => {
      findRoundWithProject.mockResolvedValue({ projectSlug: SLUG });
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      updateFundingRound.mockResolvedValue({ success: true, value: { title: "New title" } });

      const response = await request(app).patch(path).send({ title: "New title" });

      expect(response.status).toBe(200);
      expect(requireProjectRole).toHaveBeenCalledWith(SLUG, "user_test_caller", "founder");
      expect(updateFundingRound).toHaveBeenCalledWith("round_1", { title: "New title" });
    });

    it("rejects an unknown field such as a client-supplied status", async () => {
      findRoundWithProject.mockResolvedValue({ projectSlug: SLUG });
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);

      const response = await request(app).patch(path).send({ status: "open" });

      expect(response.status).toBe(422);
      expect(updateFundingRound).not.toHaveBeenCalled();
    });

    it("maps ROUND_NOT_EDITABLE to 409 — only a draft round can be changed", async () => {
      findRoundWithProject.mockResolvedValue({ projectSlug: SLUG });
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      updateFundingRound.mockResolvedValue({
        success: false,
        error: { type: "ROUND_NOT_EDITABLE", status: "open" },
      });

      const response = await request(app).patch(path).send({ title: "New title" });

      expect(response.status).toBe(409);
    });
  });

  describe("DELETE /funding-rounds/:roundId", () => {
    it("deletes a founder's own draft round", async () => {
      findRoundWithProject.mockResolvedValue({ projectSlug: SLUG });
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      deleteFundingRound.mockResolvedValue({ success: true, value: { id: "round_1" } });

      const response = await request(app).delete("/funding-rounds/round_1");

      expect(response.status).toBe(200);
      expect(deleteFundingRound).toHaveBeenCalledWith("round_1");
    });

    it("maps ROUND_HAS_REFERENCES to 409 — a round with a pledge cannot be deleted", async () => {
      findRoundWithProject.mockResolvedValue({ projectSlug: SLUG });
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      deleteFundingRound.mockResolvedValue({
        success: false,
        error: { type: "ROUND_HAS_REFERENCES" },
      });

      const response = await request(app).delete("/funding-rounds/round_1");

      expect(response.status).toBe(409);
    });
  });

  describe("POST /research-projects/:projectSlug/funding-rounds", () => {
    const path = `/research-projects/${SLUG}/funding-rounds`;
    const validBody = {
      type: "equity",
      title: "Series A",
      goalAmountInCents: "100000000",
    };

    it("requires the founder role", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      createFundingRound.mockResolvedValue({ success: true, value: { id: "round_new" } });

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(201);
      expect(requireProjectRole).toHaveBeenCalledWith(SLUG, "user_test_caller", "founder");
      expect(createFundingRound).toHaveBeenCalledWith(
        MEMBER_CONTEXT.value,
        "user_test_caller",
        expect.objectContaining({ type: "equity", title: "Series A", goalAmountInCents: 100000000n }),
      );
    });

    it("maps ROUND_TYPE_DISABLED to 403 — a regulatory gate, not a caller problem", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      createFundingRound.mockResolvedValue({
        success: false,
        error: { type: "ROUND_TYPE_DISABLED", roundType: "venture" },
      });

      const response = await request(app)
        .post(path)
        .send({ ...validBody, type: "venture" });

      expect(response.status).toBe(403);
    });

    it("maps ROUND_GOAL_INVALID to 422", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      createFundingRound.mockResolvedValue({
        success: false,
        error: { type: "ROUND_GOAL_INVALID" },
      });

      const response = await request(app)
        .post(path)
        .send({ ...validBody, goalAmountInCents: "0" });

      expect(response.status).toBe(422);
    });
  });
});
