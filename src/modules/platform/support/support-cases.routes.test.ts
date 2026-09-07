import type { Express, NextFunction, Request, Response } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for support cases — a person's own conversation with staff, and the
 * queue that answers it. Previously untested at any tier; no test file existed for this
 * router at all.
 *
 * NO CAPABILITY MIDDLEWARE on the admin routes — `handle_support_cases` is checked INSIDE
 * the service, before any id is read (the routes file's own docblock states the reasoning:
 * a route-level guard makes the capability probeable, an id-first service makes the route
 * an existence oracle). So every "403" case below on an admin route is a mocked domain
 * error, not a different middleware chain.
 *
 * `requireIdentifiedUser` guards the two member writes (open + reply) but NOT the staff
 * routes — mocked to a pass-through since it hits a real `db` query builder that has its
 * own dedicated suite (`require-identified-user.test.ts`).
 *
 * Idempotency is mocked locally (Map-backed fake, `scope: "user"`) rather than left real,
 * because every write here requires a key and the real middleware touches `db` on a
 * present key — the same reasoning `commerce-cart.routes.test.ts` documents for its own
 * local fake, just without the organization-scope half this module doesn't use.
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

const openSupportCase = vi.fn<(...args: readonly unknown[]) => unknown>();
const listOwnSupportCases = vi.fn<(...args: readonly unknown[]) => unknown>();
const getOwnSupportCase = vi.fn<(...args: readonly unknown[]) => unknown>();
const addOwnSupportCaseMessage = vi.fn<(...args: readonly unknown[]) => unknown>();
const listSupportCaseQueue = vi.fn<(...args: readonly unknown[]) => unknown>();
const getSupportCaseForStaff = vi.fn<(...args: readonly unknown[]) => unknown>();
const addStaffSupportCaseMessage = vi.fn<(...args: readonly unknown[]) => unknown>();
const decideSupportCase = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/platform/support/support-cases.service.js", () => ({
  openSupportCase: (...args: readonly unknown[]) => openSupportCase(...args),
  listOwnSupportCases: (...args: readonly unknown[]) => listOwnSupportCases(...args),
  getOwnSupportCase: (...args: readonly unknown[]) => getOwnSupportCase(...args),
  addOwnSupportCaseMessage: (...args: readonly unknown[]) => addOwnSupportCaseMessage(...args),
  listSupportCaseQueue: (...args: readonly unknown[]) => listSupportCaseQueue(...args),
  getSupportCaseForStaff: (...args: readonly unknown[]) => getSupportCaseForStaff(...args),
  addStaffSupportCaseMessage: (...args: readonly unknown[]) => addStaffSupportCaseMessage(...args),
  decideSupportCase: (...args: readonly unknown[]) => decideSupportCase(...args),
}));

const CAPABILITY_REQUIRED = {
  success: false,
  error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "handle_support_cases" },
} as const;

describe("support cases routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    idempotencyCache.clear();
    signInAs();
    await resetRateLimiters();
  });

  describe("POST /support/cases", () => {
    const path = "/support/cases";
    const validBody = {
      category: "technical_problem",
      subject: "Can't upload a document",
      description: "The upload button does nothing when I click it.",
    };

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).post(path).set("Idempotency-Key", "open_key_1").send(validBody);

      expect(response.status).toBe(401);
      expect(openSupportCase).not.toHaveBeenCalled();
    });

    it("requires an Idempotency-Key header", async () => {
      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(400);
      expect(openSupportCase).not.toHaveBeenCalled();
    });

    it("opens the case and answers 201, never claiming it is solved", async () => {
      openSupportCase.mockResolvedValue({ success: true, value: { id: "case_1", state: "open" } });

      const response = await request(app).post(path).set("Idempotency-Key", "open_key_2").send(validBody);

      expect(response.status).toBe(201);
      expect(openSupportCase).toHaveBeenCalledWith("user_test_caller", validBody);
      expect(response.body.message).toBe("Case opened. Support will reply here.");
    });

    it("rejects a category outside the enum with 422", async () => {
      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "open_key_3")
        .send({ ...validBody, category: "refund_problem" });

      expect(response.status).toBe(422);
      expect(openSupportCase).not.toHaveBeenCalled();
    });

    it("maps LIVE_CASE_LIMIT_REACHED to 409 with the limit in the response", async () => {
      openSupportCase.mockResolvedValue({
        success: false,
        error: { type: "LIVE_CASE_LIMIT_REACHED", limit: 5 },
      });

      const response = await request(app).post(path).set("Idempotency-Key", "open_key_4").send(validBody);

      expect(response.status).toBe(409);
      expect(response.body.data).toEqual({ limit: 5 });
    });
  });

  describe("GET /support/cases", () => {
    const path = "/support/cases";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).get(path);

      expect(response.status).toBe(401);
      expect(listOwnSupportCases).not.toHaveBeenCalled();
    });

    it("lists the caller's own cases", async () => {
      listOwnSupportCases.mockResolvedValue({
        success: true,
        value: { cases: [{ id: "case_1", state: "open" }], nextCursor: null },
      });

      const response = await request(app).get(`${path}?state=open&limit=10`);

      expect(response.status).toBe(200);
      expect(listOwnSupportCases).toHaveBeenCalledWith("user_test_caller", { state: "open", limit: 10 });
      expect(response.body.data).toEqual([{ id: "case_1", state: "open" }]);
      expect(response.body.nextCursor).toBeNull();
    });

    it("rejects an unknown query key with 422", async () => {
      const response = await request(app).get(`${path}?userId=other`);

      expect(response.status).toBe(422);
      expect(listOwnSupportCases).not.toHaveBeenCalled();
    });
  });

  describe("GET /support/cases/:caseId", () => {
    const path = "/support/cases/case_1";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).get(path);

      expect(response.status).toBe(401);
      expect(getOwnSupportCase).not.toHaveBeenCalled();
    });

    it("loads the caller's own case", async () => {
      getOwnSupportCase.mockResolvedValue({ success: true, value: { id: "case_1", state: "open" } });

      const response = await request(app).get(path);

      expect(response.status).toBe(200);
      expect(getOwnSupportCase).toHaveBeenCalledWith("user_test_caller", "case_1");
    });

    it("answers 404 for a case belonging to someone else, same as a case that doesn't exist", async () => {
      getOwnSupportCase.mockResolvedValue({ success: false, error: { type: "SUPPORT_CASE_NOT_FOUND" } });

      const response = await request(app).get(path);

      expect(response.status).toBe(404);
    });
  });

  describe("POST /support/cases/:caseId/messages", () => {
    const path = "/support/cases/case_1/messages";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).post(path).set("Idempotency-Key", "msg_key_1").send({ body: "Any update?" });

      expect(response.status).toBe(401);
      expect(addOwnSupportCaseMessage).not.toHaveBeenCalled();
    });

    it("requires an Idempotency-Key header", async () => {
      const response = await request(app).post(path).send({ body: "Any update?" });

      expect(response.status).toBe(400);
      expect(addOwnSupportCaseMessage).not.toHaveBeenCalled();
    });

    it("adds the reply and answers 201", async () => {
      addOwnSupportCaseMessage.mockResolvedValue({ success: true, value: { id: "message_1" } });

      const response = await request(app).post(path).set("Idempotency-Key", "msg_key_2").send({ body: "Any update?" });

      expect(response.status).toBe(201);
      expect(addOwnSupportCaseMessage).toHaveBeenCalledWith("user_test_caller", "case_1", {
        body: "Any update?",
      });
    });

    it("maps REOPEN_WINDOW_CLOSED to 409", async () => {
      addOwnSupportCaseMessage.mockResolvedValue({
        success: false,
        error: { type: "REOPEN_WINDOW_CLOSED" },
      });

      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "msg_key_3")
        .send({ body: "Reopening after a while." });

      expect(response.status).toBe(409);
    });

    it("rejects an empty message body with 422", async () => {
      const response = await request(app).post(path).set("Idempotency-Key", "msg_key_4").send({ body: "" });

      expect(response.status).toBe(422);
      expect(addOwnSupportCaseMessage).not.toHaveBeenCalled();
    });
  });

  describe("GET /support/admin/cases", () => {
    const path = "/support/admin/cases";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).get(path);

      expect(response.status).toBe(401);
      expect(listSupportCaseQueue).not.toHaveBeenCalled();
    });

    it("requires handle_support_cases", async () => {
      listSupportCaseQueue.mockResolvedValue(CAPABILITY_REQUIRED);

      const response = await request(app).get(path);

      expect(response.status).toBe(403);
      expect(response.body.data).toEqual({ capability: "handle_support_cases" });
    });

    it("lists the queue for staff", async () => {
      listSupportCaseQueue.mockResolvedValue({
        success: true,
        value: { cases: [{ id: "case_1", state: "open" }], nextCursor: null },
      });

      const response = await request(app).get(`${path}?state=open&category=technical_problem`);

      expect(response.status).toBe(200);
      expect(listSupportCaseQueue).toHaveBeenCalledWith("user_test_caller", {
        state: "open",
        category: "technical_problem",
      });
    });
  });

  describe("GET /support/admin/cases/:caseId", () => {
    const path = "/support/admin/cases/case_1";

    it("requires handle_support_cases", async () => {
      getSupportCaseForStaff.mockResolvedValue(CAPABILITY_REQUIRED);

      const response = await request(app).get(path);

      expect(response.status).toBe(403);
    });

    it("loads the case for staff", async () => {
      getSupportCaseForStaff.mockResolvedValue({ success: true, value: { id: "case_1", state: "open" } });

      const response = await request(app).get(path);

      expect(response.status).toBe(200);
      expect(getSupportCaseForStaff).toHaveBeenCalledWith("user_test_caller", "case_1");
    });

    it("maps SUPPORT_CASE_NOT_FOUND to 404", async () => {
      getSupportCaseForStaff.mockResolvedValue({
        success: false,
        error: { type: "SUPPORT_CASE_NOT_FOUND" },
      });

      const response = await request(app).get(path);

      expect(response.status).toBe(404);
    });
  });

  describe("POST /support/admin/cases/:caseId/messages", () => {
    const path = "/support/admin/cases/case_1/messages";

    it("requires an Idempotency-Key header", async () => {
      const response = await request(app).post(path).send({ body: "We're looking into it." });

      expect(response.status).toBe(400);
      expect(addStaffSupportCaseMessage).not.toHaveBeenCalled();
    });

    it("requires handle_support_cases", async () => {
      addStaffSupportCaseMessage.mockResolvedValue(CAPABILITY_REQUIRED);

      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "staff_msg_key_1")
        .send({ body: "We're looking into it." });

      expect(response.status).toBe(403);
    });

    it("sends the staff reply and answers 201", async () => {
      addStaffSupportCaseMessage.mockResolvedValue({ success: true, value: { id: "message_1" } });

      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "staff_msg_key_2")
        .send({ body: "We're looking into it." });

      expect(response.status).toBe(201);
      expect(addStaffSupportCaseMessage).toHaveBeenCalledWith("user_test_caller", "case_1", {
        body: "We're looking into it.",
      });
    });

    /**
     * The staff-cannot-answer-their-own-case rule: a staff member who opened a case (e.g.
     * reporting their own bug through the same surface) cannot then answer it as staff.
     */
    it("maps STAFF_IS_CASE_OPENER to 403", async () => {
      addStaffSupportCaseMessage.mockResolvedValue({
        success: false,
        error: { type: "STAFF_IS_CASE_OPENER" },
      });

      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "staff_msg_key_3")
        .send({ body: "Replying to my own case." });

      expect(response.status).toBe(403);
    });
  });

  describe("POST /support/admin/cases/:caseId/decisions", () => {
    const path = "/support/admin/cases/case_1/decisions";
    const validBody = { decision: "resolved", note: "Fixed in the latest release." };

    it("requires an Idempotency-Key header", async () => {
      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(400);
      expect(decideSupportCase).not.toHaveBeenCalled();
    });

    it("requires handle_support_cases", async () => {
      decideSupportCase.mockResolvedValue(CAPABILITY_REQUIRED);

      const response = await request(app).post(path).set("Idempotency-Key", "decision_key_1").send(validBody);

      expect(response.status).toBe(403);
    });

    it("resolves the case and answers 200 with the reopenable framing", async () => {
      decideSupportCase.mockResolvedValue({ success: true, value: { id: "case_1", state: "resolved" } });

      const response = await request(app).post(path).set("Idempotency-Key", "decision_key_2").send(validBody);

      expect(response.status).toBe(200);
      expect(decideSupportCase).toHaveBeenCalledWith("user_test_caller", "case_1", validBody);
      expect(response.body.message).toBe("Case resolved. The person can still reply to reopen it.");
    });

    it("closes the case with the terminal framing", async () => {
      decideSupportCase.mockResolvedValue({ success: true, value: { id: "case_1", state: "closed" } });

      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "decision_key_3")
        .send({ decision: "closed", note: "Duplicate of case_0." });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe("Case closed. Nobody can add to it.");
    });

    it("requires a note — decisions are conversational, not a silent verdict", async () => {
      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "decision_key_4")
        .send({ decision: "resolved", note: "" });

      expect(response.status).toBe(422);
      expect(decideSupportCase).not.toHaveBeenCalled();
    });

    it("maps STAFF_IS_CASE_OPENER to 403 on a decision too", async () => {
      decideSupportCase.mockResolvedValue({ success: false, error: { type: "STAFF_IS_CASE_OPENER" } });

      const response = await request(app).post(path).set("Idempotency-Key", "decision_key_5").send(validBody);

      expect(response.status).toBe(403);
    });
  });
});
