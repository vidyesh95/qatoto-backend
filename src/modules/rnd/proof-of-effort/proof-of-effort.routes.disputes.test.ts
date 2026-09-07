import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for the dispute subtree of `proof-of-effort.routes.ts` (§9.8, §9.12,
 * §11j.2) — the allocation-proposal appeals process. §14/§7A.6 name this the GDPR Art. 22
 * contestability path and the EU AI Act Art. 14 human-oversight control, and before this
 * file every route here (raise, vote, withdraw, resolve, and both reads) had zero coverage.
 *
 * `resolveDispute` is founder-only in the controller (`requireRoleOrRespond(..., "founder")`);
 * every other write here uses the "contributor" floor with the service proving the real rule
 * (raiser-only for withdraw, one-vote-per-member for votes).
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

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

const listDisputes = vi.fn<(...args: readonly unknown[]) => unknown>();
const getDispute = vi.fn<(...args: readonly unknown[]) => unknown>();
const raiseDispute = vi.fn<(...args: readonly unknown[]) => unknown>();
const withdrawDispute = vi.fn<(...args: readonly unknown[]) => unknown>();
const castDisputeVote = vi.fn<(...args: readonly unknown[]) => unknown>();
const resolveDispute = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/rnd/proof-of-effort/dispute.service.js", () => ({
  listDisputes: (...args: readonly unknown[]) => listDisputes(...args),
  getDispute: (...args: readonly unknown[]) => getDispute(...args),
  raiseDispute: (...args: readonly unknown[]) => raiseDispute(...args),
  withdrawDispute: (...args: readonly unknown[]) => withdrawDispute(...args),
  castDisputeVote: (...args: readonly unknown[]) => castDisputeVote(...args),
  resolveDispute: (...args: readonly unknown[]) => resolveDispute(...args),
}));

const FOUNDER_CONTEXT = {
  success: true,
  value: {
    projectId: "project_1",
    projectSlug: "solar-cold-storage",
    projectStatus: "active",
    founderUserId: "user_test_caller",
    currency: "INR",
    memberId: "member_1",
    memberRole: "founder",
  },
} as const;

const CONTRIBUTOR_CONTEXT = {
  success: true,
  value: { ...FOUNDER_CONTEXT.value, memberId: "member_2", memberRole: "contributor" },
} as const;

const NOT_FOUND = { success: false, error: { type: "NOT_FOUND", projectRef: "solar-cold-storage" } };

const SLUG = "solar-cold-storage";
const BASE = `/research-projects/${SLUG}`;

describe("proof-of-effort dispute routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signInAs();
    await resetRateLimiters();
  });

  describe("authentication and membership", () => {
    const getRoutes = [`${BASE}/disputes`, `${BASE}/disputes/dispute_1`] as const;

    it.each(getRoutes)("answers 401 for a signed-out caller on %s", async (path) => {
      signOut();

      const response = await request(app).get(path);

      expect(response.status).toBe(401);
      expect(listDisputes).not.toHaveBeenCalled();
      expect(getDispute).not.toHaveBeenCalled();
    });

    it.each(getRoutes)("answers 404 for a signed-in non-member on %s", async (path) => {
      requireProjectRole.mockResolvedValue(NOT_FOUND);

      const response = await request(app).get(path);

      expect(response.status).toBe(404);
    });

    it("gives a non-member and an absent project byte-identical refusals", async () => {
      requireProjectRole.mockResolvedValue(NOT_FOUND);
      const nonMember = await request(app).get(`${BASE}/disputes`);

      requireProjectRole.mockResolvedValue({
        success: false,
        error: { type: "NOT_FOUND", projectRef: "no-such-project" },
      });
      const absent = await request(app).get("/research-projects/no-such-project/disputes");

      expect(nonMember.status).toBe(absent.status);
      expect(nonMember.body).toEqual(absent.body);
    });

    it("answers 401 for a signed-out caller raising a dispute", async () => {
      signOut();

      const response = await request(app)
        .post(`${BASE}/allocation-proposals/proposal_1/dispute`)
        .send({ disputeNote: "The verified minutes look wrong for this window." });

      expect(response.status).toBe(401);
      expect(raiseDispute).not.toHaveBeenCalled();
    });
  });

  describe("GET …/disputes — the paginated list", () => {
    it("passes the parsed filter and pagination to the service", async () => {
      requireProjectRole.mockResolvedValue(CONTRIBUTOR_CONTEXT);
      listDisputes.mockResolvedValue({ rows: [], total: 0 });

      const response = await request(app).get(`${BASE}/disputes?status=open&page=2&limit=10`);

      expect(response.status).toBe(200);
      expect(listDisputes).toHaveBeenCalledWith("project_1", { status: "open", page: 2, limit: 10 });
    });

    it("rejects an unknown status value", async () => {
      requireProjectRole.mockResolvedValue(CONTRIBUTOR_CONTEXT);

      const response = await request(app).get(`${BASE}/disputes?status=closed`);

      expect(response.status).toBe(422);
      expect(listDisputes).not.toHaveBeenCalled();
    });

    it("returns the pagination envelope alongside the rows", async () => {
      requireProjectRole.mockResolvedValue(CONTRIBUTOR_CONTEXT);
      listDisputes.mockResolvedValue({ rows: [{ id: "dispute_1" }], total: 1 });

      const response = await request(app).get(`${BASE}/disputes`);

      expect(response.body.data).toEqual([{ id: "dispute_1" }]);
      expect(response.body.pagination).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
    });
  });

  describe("GET …/disputes/:disputeId", () => {
    it("scopes the lookup by project id", async () => {
      requireProjectRole.mockResolvedValue(CONTRIBUTOR_CONTEXT);
      getDispute.mockResolvedValue({ success: true, value: { id: "dispute_1" } });

      const response = await request(app).get(`${BASE}/disputes/dispute_1`);

      expect(response.status).toBe(200);
      expect(getDispute).toHaveBeenCalledWith("project_1", "dispute_1");
    });

    it("answers 404 for a dispute belonging to another project", async () => {
      requireProjectRole.mockResolvedValue(CONTRIBUTOR_CONTEXT);
      getDispute.mockResolvedValue({ success: false, error: { type: "DISPUTE_NOT_FOUND" } });

      const response = await request(app).get(`${BASE}/disputes/dispute_elsewhere`);

      expect(response.status).toBe(404);
    });
  });

  describe("POST …/allocation-proposals/:proposalId/dispute — raises, freezing the slices", () => {
    const path = `${BASE}/allocation-proposals/proposal_1/dispute`;

    it("requires a disputeNote", async () => {
      requireProjectRole.mockResolvedValue(CONTRIBUTOR_CONTEXT);

      const response = await request(app).post(path).send({});

      expect(response.status).toBe(422);
      expect(raiseDispute).not.toHaveBeenCalled();
    });

    it("raises the dispute on behalf of the caller's own membership", async () => {
      requireProjectRole.mockResolvedValue(CONTRIBUTOR_CONTEXT);
      raiseDispute.mockResolvedValue({ success: true, value: { id: "dispute_1", status: "open" } });

      const response = await request(app)
        .post(path)
        .send({ disputeNote: "The verified minutes look wrong for this window." });

      expect(response.status).toBe(201);
      expect(raiseDispute).toHaveBeenCalledWith(
        CONTRIBUTOR_CONTEXT.value,
        "proposal_1",
        "member_2",
        "The verified minutes look wrong for this window.",
        "user_test_caller",
        "contributor",
      );
    });

    it("maps ALREADY_DISPUTED to 409", async () => {
      requireProjectRole.mockResolvedValue(CONTRIBUTOR_CONTEXT);
      raiseDispute.mockResolvedValue({ success: false, error: { type: "ALREADY_DISPUTED" } });

      const response = await request(app).post(path).send({ disputeNote: "Second attempt." });

      expect(response.status).toBe(409);
    });

    it("maps WINDOW_CLOSED to 409 — the dispute window has a hard deadline", async () => {
      requireProjectRole.mockResolvedValue(CONTRIBUTOR_CONTEXT);
      raiseDispute.mockResolvedValue({
        success: false,
        error: { type: "WINDOW_CLOSED", status: "settled" },
      });

      const response = await request(app).post(path).send({ disputeNote: "Too late." });

      expect(response.status).toBe(409);
    });
  });

  describe("POST …/disputes/:disputeId/withdraw — the raiser only", () => {
    const path = `${BASE}/disputes/dispute_1/withdraw`;

    it("withdraws on behalf of the caller's own membership", async () => {
      requireProjectRole.mockResolvedValue(CONTRIBUTOR_CONTEXT);
      withdrawDispute.mockResolvedValue({ success: true, value: { status: "withdrawn" } });

      const response = await request(app).post(path);

      expect(response.status).toBe(200);
      expect(withdrawDispute).toHaveBeenCalledWith(
        CONTRIBUTOR_CONTEXT.value,
        "dispute_1",
        "member_2",
        "user_test_caller",
        "contributor",
      );
    });

    it("maps NOT_THE_RAISER to 403 — only the person who raised it may withdraw it", async () => {
      requireProjectRole.mockResolvedValue(CONTRIBUTOR_CONTEXT);
      withdrawDispute.mockResolvedValue({ success: false, error: { type: "NOT_THE_RAISER" } });

      const response = await request(app).post(path);

      expect(response.status).toBe(403);
    });

    it("maps DISPUTE_NOT_OPEN to 409", async () => {
      requireProjectRole.mockResolvedValue(CONTRIBUTOR_CONTEXT);
      withdrawDispute.mockResolvedValue({ success: false, error: { type: "DISPUTE_NOT_OPEN" } });

      const response = await request(app).post(path);

      expect(response.status).toBe(409);
    });
  });

  describe("POST …/disputes/:disputeId/votes — one per voter", () => {
    const path = `${BASE}/disputes/dispute_1/votes`;

    it("casts the vote and reports an auto-resolution when the majority lands", async () => {
      requireProjectRole.mockResolvedValue(CONTRIBUTOR_CONTEXT);
      castDisputeVote.mockResolvedValue({
        success: true,
        value: { id: "vote_1", autoResolvedAs: "upheld" },
      });

      const response = await request(app).post(path).send({ position: "uphold" });

      expect(response.status).toBe(201);
      expect(response.body.message).toContain("upheld");
      expect(castDisputeVote).toHaveBeenCalledWith(
        CONTRIBUTOR_CONTEXT.value,
        "dispute_1",
        "member_2",
        { position: "uphold" },
        "user_test_caller",
        "contributor",
      );
    });

    it("maps ALREADY_VOTED to 409 — a vote cannot be changed after the fact", async () => {
      requireProjectRole.mockResolvedValue(CONTRIBUTOR_CONTEXT);
      castDisputeVote.mockResolvedValue({ success: false, error: { type: "ALREADY_VOTED" } });

      const response = await request(app).post(path).send({ position: "void" });

      expect(response.status).toBe(409);
    });

    it("rejects an unrecognized vote position", async () => {
      requireProjectRole.mockResolvedValue(CONTRIBUTOR_CONTEXT);

      const response = await request(app).post(path).send({ position: "abstain" });

      expect(response.status).toBe(422);
      expect(castDisputeVote).not.toHaveBeenCalled();
    });
  });

  describe("POST …/disputes/:disputeId/resolve — founder only", () => {
    const path = `${BASE}/disputes/dispute_1/resolve`;

    it("is gated at founder role — a non-founder context resolving to NOT_FOUND proves the floor was requested", async () => {
      requireProjectRole.mockResolvedValue({
        success: false,
        error: { type: "NOT_FOUND", projectRef: SLUG },
      });

      const response = await request(app)
        .post(path)
        .send({ resolution: "upheld", resolutionNote: "The evidence supports the claim." });

      expect(response.status).toBe(404);
      expect(requireProjectRole).toHaveBeenCalledWith(SLUG, "user_test_caller", "founder");
      expect(resolveDispute).not.toHaveBeenCalled();
    });

    it("resolves as upheld with a plain 200", async () => {
      requireProjectRole.mockResolvedValue(FOUNDER_CONTEXT);
      resolveDispute.mockResolvedValue({ success: true, value: { status: "upheld" } });

      const response = await request(app)
        .post(path)
        .send({ resolution: "upheld", resolutionNote: "The evidence supports the claim." });

      expect(response.status).toBe(200);
      expect(resolveDispute).toHaveBeenCalledWith(
        FOUNDER_CONTEXT.value,
        "dispute_1",
        {
          resolution: "upheld",
          resolutionNote: "The evidence supports the claim.",
        },
        "user_test_caller",
        "founder",
      );
    });

    /**
     * `re_verified` is 202, never 200 — the number does not exist yet until a scoped
     * re-verification runs (§9.12 option (a)).
     */
    it("answers 202, not 200, when the resolution queues a re-verification", async () => {
      requireProjectRole.mockResolvedValue(FOUNDER_CONTEXT);
      resolveDispute.mockResolvedValue({ success: true, value: { status: "re_verification_pending" } });

      const response = await request(app).post(path).send({
        resolution: "re_verified",
        resolutionNote: "Rechecking the window against the calendar artifacts.",
        scopedWindowStartsAt: "2026-02-01T00:00:00.000Z",
        scopedWindowEndsAt: "2026-02-02T00:00:00.000Z",
      });

      expect(response.status).toBe(202);
    });

    it("maps SCOPED_WINDOW_REQUIRED to 422 when re_verified has no window", async () => {
      requireProjectRole.mockResolvedValue(FOUNDER_CONTEXT);
      resolveDispute.mockResolvedValue({
        success: false,
        error: { type: "SCOPED_WINDOW_REQUIRED" },
      });

      const response = await request(app)
        .post(path)
        .send({ resolution: "re_verified", resolutionNote: "Missing window on purpose." });

      expect(response.status).toBe(422);
    });

    it("maps DISPUTE_NOT_OPEN to 409", async () => {
      requireProjectRole.mockResolvedValue(FOUNDER_CONTEXT);
      resolveDispute.mockResolvedValue({ success: false, error: { type: "DISPUTE_NOT_OPEN" } });

      const response = await request(app).post(path).send({ resolution: "voided", resolutionNote: "Already settled." });

      expect(response.status).toBe(409);
    });
  });
});
