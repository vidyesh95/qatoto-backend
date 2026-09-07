import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for §8's daily-log subtree — "the input to the entire equity ledger"
 * per `workshop.routes.ts`'s own docblock. A LIGHTER pass than the money-mutation suites
 * (compensation, funding, proof-of-effort writes): happy path + 401 + 422 per route, plus
 * the cheap-and-obvious domain errors (a submitted log is frozen evidence). The board/
 * chat/files routes on this same router are explicitly out of scope here.
 *
 * Same anti-enumeration property as the other §7/§7A/§9 route suites: a non-member and an
 * absent project must be indistinguishable (404, never 403).
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

/**
 * `requireIdentifiedUser` hits the real `db` query builder; it has its own dedicated suite
 * (`src/middleware/require-identified-user.test.ts`). Stubbed to a pass-through here, as in
 * `import-intelligence.routes.test.ts` and `compensation.routes.test.ts`, so this suite
 * stays about routing/wiring rather than the database mock's emptiness.
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

const listDailyLogs = vi.fn<(...args: readonly unknown[]) => unknown>();
const listDailyLogFeed = vi.fn<(...args: readonly unknown[]) => unknown>();
const listDailyLogStreakLeaderboard = vi.fn<(...args: readonly unknown[]) => unknown>();
const findDailyLogDetail = vi.fn<(...args: readonly unknown[]) => unknown>();
const createDailyLog = vi.fn<(...args: readonly unknown[]) => unknown>();
const updateDailyLog = vi.fn<(...args: readonly unknown[]) => unknown>();
const deleteDailyLog = vi.fn<(...args: readonly unknown[]) => unknown>();
const submitDailyLog = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/rnd/workshop/daily-logs.service.js", () => ({
  listDailyLogs: (...args: readonly unknown[]) => listDailyLogs(...args),
  listDailyLogFeed: (...args: readonly unknown[]) => listDailyLogFeed(...args),
  listDailyLogStreakLeaderboard: (...args: readonly unknown[]) => listDailyLogStreakLeaderboard(...args),
  findDailyLogDetail: (...args: readonly unknown[]) => findDailyLogDetail(...args),
  createDailyLog: (...args: readonly unknown[]) => createDailyLog(...args),
  updateDailyLog: (...args: readonly unknown[]) => updateDailyLog(...args),
  deleteDailyLog: (...args: readonly unknown[]) => deleteDailyLog(...args),
  submitDailyLog: (...args: readonly unknown[]) => submitDailyLog(...args),
}));

/** What `requireProjectRole` returns for a member of `solar-cold-storage`. */
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

describe("workshop daily-log routes", () => {
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
    const getRoutes = [
      `${BASE}/daily-logs`,
      `${BASE}/daily-logs/log_1`,
      `${BASE}/daily-logs/log_1/transcript`,
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
      const nonMember = await request(app).get(`${BASE}/daily-logs`);

      requireProjectRole.mockResolvedValue({
        success: false,
        error: { type: "NOT_FOUND", projectRef: "no-such-project" },
      });
      const absent = await request(app).get("/research-projects/no-such-project/daily-logs");

      expect(nonMember.status).toBe(absent.status);
      expect(nonMember.body).toEqual(absent.body);
    });

    it("answers 401 for a signed-out caller creating a log", async () => {
      signOut();

      const response = await request(app).post(`${BASE}/daily-logs`).send({ logDate: "2026-03-01" });

      expect(response.status).toBe(401);
      expect(createDailyLog).not.toHaveBeenCalled();
    });
  });

  describe("GET …/daily-logs", () => {
    it("lists logs for the resolved project", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      listDailyLogs.mockResolvedValue([{ id: "log_1" }]);

      const response = await request(app).get(`${BASE}/daily-logs`);

      expect(response.status).toBe(200);
      expect(listDailyLogs).toHaveBeenCalledWith("project_1", {});
      expect(response.body.data).toEqual([{ id: "log_1" }]);
    });
  });

  describe("GET …/daily-logs/:logId and …/transcript", () => {
    it("loads one log's detail", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      findDailyLogDetail.mockResolvedValue({ id: "log_1", analysisStatus: "queued" });

      const response = await request(app).get(`${BASE}/daily-logs/log_1`);

      expect(response.status).toBe(200);
      expect(findDailyLogDetail).toHaveBeenCalledWith("project_1", "log_1");
    });

    it("answers 404 for a log that does not exist", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      findDailyLogDetail.mockResolvedValue(null);

      const response = await request(app).get(`${BASE}/daily-logs/log_missing`);

      expect(response.status).toBe(404);
    });

    it("loads the transcript projection", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      findDailyLogDetail.mockResolvedValue({ id: "log_1", analysisStatus: "completed" });

      const response = await request(app).get(`${BASE}/daily-logs/log_1/transcript`);

      expect(response.status).toBe(200);
      expect(response.body.data.analysisStatus).toBe("completed");
    });
  });

  describe("POST …/daily-logs — create", () => {
    const path = `${BASE}/daily-logs`;

    it("creates a draft log and passes the caller's own member id, never a client-sent one", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      createDailyLog.mockResolvedValue({ success: true, value: { id: "log_1", status: "draft" } });

      const response = await request(app)
        .post(path)
        .send({ logDate: "2026-03-01", narrative: "Shipped the onboarding flow." });

      expect(response.status).toBe(201);
      expect(createDailyLog).toHaveBeenCalledWith("project_1", "member_1", {
        logDate: "2026-03-01",
        narrative: "Shipped the onboarding flow.",
      });
    });

    it("rejects an unknown body field with 422", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);

      const response = await request(app).post(path).send({ logDate: "2026-03-01", authorMemberId: "member_2" });

      expect(response.status).toBe(422);
      expect(createDailyLog).not.toHaveBeenCalled();
    });

    it("rejects a malformed logDate", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);

      const response = await request(app).post(path).send({ logDate: "03-01-2026" });

      expect(response.status).toBe(422);
      expect(createDailyLog).not.toHaveBeenCalled();
    });

    it("maps DAILY_LOG_ALREADY_EXISTS to 409", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      createDailyLog.mockResolvedValue({
        success: false,
        error: { type: "DAILY_LOG_ALREADY_EXISTS", logDate: "2026-03-01" },
      });

      const response = await request(app).post(path).send({ logDate: "2026-03-01" });

      expect(response.status).toBe(409);
    });
  });

  describe("PATCH …/daily-logs/:logId — update", () => {
    const path = `${BASE}/daily-logs/log_1`;

    it("updates a draft log", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      updateDailyLog.mockResolvedValue({ success: true, value: { id: "log_1", narrative: "Edited." } });

      const response = await request(app).patch(path).send({ narrative: "Edited." });

      expect(response.status).toBe(200);
      expect(updateDailyLog).toHaveBeenCalledWith("project_1", "log_1", "member_1", { narrative: "Edited." });
    });

    /**
     * §8's immutability rule: a submitted log is frozen evidence. This is the one property
     * that matters most about this route.
     */
    it("refuses to edit a log that has already been submitted", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      updateDailyLog.mockResolvedValue({
        success: false,
        error: { type: "DAILY_LOG_ALREADY_SUBMITTED" },
      });

      const response = await request(app).patch(path).send({ narrative: "Trying to edit after submit." });

      expect(response.status).toBe(409);
    });

    it("rejects an unknown body field", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);

      const response = await request(app).patch(path).send({ authorMemberId: "member_2" });

      expect(response.status).toBe(422);
      expect(updateDailyLog).not.toHaveBeenCalled();
    });
  });

  describe("DELETE …/daily-logs/:logId — delete", () => {
    const path = `${BASE}/daily-logs/log_1`;

    it("deletes a draft log", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      deleteDailyLog.mockResolvedValue({ success: true, value: { id: "log_1" } });

      const response = await request(app).delete(path);

      expect(response.status).toBe(200);
      expect(deleteDailyLog).toHaveBeenCalledWith("project_1", "log_1", "member_1");
    });

    it("refuses to delete a log that has already been submitted", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      deleteDailyLog.mockResolvedValue({
        success: false,
        error: { type: "DAILY_LOG_ALREADY_SUBMITTED" },
      });

      const response = await request(app).delete(path);

      expect(response.status).toBe(409);
    });
  });

  describe("POST …/daily-logs/:logId/submit", () => {
    const path = `${BASE}/daily-logs/log_1/submit`;

    it("submits with an idempotency key and answers 202, never 200", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      submitDailyLog.mockResolvedValue({
        success: true,
        value: { id: "log_1", analysisStatus: "queued", effortVerificationStatus: "not_run" },
      });

      const response = await request(app).post(path).send({ idempotencyKey: "submit_key_12345" });

      expect(response.status).toBe(202);
      expect(submitDailyLog).toHaveBeenCalledWith("project_1", "log_1", "member_1", "submit_key_12345");
    });

    it("rejects a body with no idempotencyKey", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);

      const response = await request(app).post(path).send({});

      expect(response.status).toBe(422);
      expect(submitDailyLog).not.toHaveBeenCalled();
    });

    it("refuses a log that was already submitted", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      submitDailyLog.mockResolvedValue({
        success: false,
        error: { type: "DAILY_LOG_ALREADY_SUBMITTED" },
      });

      const response = await request(app).post(path).send({ idempotencyKey: "submit_key_12345" });

      expect(response.status).toBe(409);
    });

    it("refuses an empty log", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      submitDailyLog.mockResolvedValue({
        success: false,
        error: { type: "DAILY_LOG_EMPTY" },
      });

      const response = await request(app).post(path).send({ idempotencyKey: "submit_key_12345" });

      expect(response.status).toBe(422);
    });
  });
});

describe("workshop daily-log feed routes (root-mounted)", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signInAs();
    await resetRateLimiters();
  });

  describe("GET /daily-logs/streak-leaderboard — public", () => {
    it("renders for a signed-out visitor", async () => {
      signOut();
      listDailyLogStreakLeaderboard.mockResolvedValue([{ memberId: "member_1", currentStreak: 5 }]);

      const response = await request(app).get("/daily-logs/streak-leaderboard");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([{ memberId: "member_1", currentStreak: 5 }]);
    });
  });

  describe("GET /daily-logs — cross-project feed", () => {
    const path = "/daily-logs";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).get(path);

      expect(response.status).toBe(401);
      expect(listDailyLogFeed).not.toHaveBeenCalled();
    });

    it("derives the caller's membership set server-side, with no project/user id accepted from the client", async () => {
      listDailyLogFeed.mockResolvedValue({ success: true, value: { rows: [], nextCursor: null } });

      const response = await request(app).get(path);

      expect(response.status).toBe(200);
      expect(listDailyLogFeed).toHaveBeenCalledWith("user_test_caller", {});
    });

    it("rejects a client-supplied userId with 422 rather than widening the membership set", async () => {
      const response = await request(app).get(`${path}?userId=someone_else`);

      expect(response.status).toBe(422);
      expect(listDailyLogFeed).not.toHaveBeenCalled();
    });
  });
});
