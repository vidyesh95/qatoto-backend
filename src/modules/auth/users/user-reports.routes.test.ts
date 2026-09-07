import type { Express, NextFunction, Request, Response } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for profile reporting — new from scratch, no test file existed for
 * this router at all. Mounted at `/users`, AFTER `usersRouter` (order matters — see the
 * routes file's own docblock).
 *
 * `userReportLimiter`/`contentReviewLimiter` default to the user-id key, so
 * `resetRateLimiters()` handles them fine — no loop-until-blocked pattern needed here
 * (unlike the IP/email-keyed signup limiters in `auth.routes.test.ts`).
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

/**
 * `requireIdentifiedUser` hits the real `db` query builder; stubbed to a pass-through
 * here, matching the precedent in `import-intelligence.routes.test.ts` — this suite is
 * about routing/wiring, and the guard has its own dedicated suite.
 */
vi.mock("#src/middleware/require-identified-user.js", () => ({
  requireIdentifiedUser: (_req: unknown, _res: unknown, next: (error?: unknown) => void): void => {
    next();
  },
}));

/**
 * The real `#src/middleware/idempotency.js` hits `db` whenever a caller SENDS a key —
 * which every `{required:true}` route here always needs — and the shared inert `db: {}`
 * mock can't satisfy that. Local `Map`-backed fake, the same shape proven in
 * `commerce-cart.routes.test.ts`.
 */
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

const createUserReport = vi.fn<(...args: readonly unknown[]) => unknown>();
const listUserReports = vi.fn<(...args: readonly unknown[]) => unknown>();
const decideUserReport = vi.fn<(...args: readonly unknown[]) => unknown>();
const restoreUserProfileText = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/auth/users/user-reports.service.js", () => ({
  createUserReport: (...args: readonly unknown[]) => createUserReport(...args),
  listUserReports: (...args: readonly unknown[]) => listUserReports(...args),
  decideUserReport: (...args: readonly unknown[]) => decideUserReport(...args),
  restoreUserProfileText: (...args: readonly unknown[]) => restoreUserProfileText(...args),
}));

const CAPABILITY_REQUIRED = {
  success: false,
  error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_content" },
} as const;

describe("user reports routes", () => {
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

  describe("POST /users/:userId/reports", () => {
    const path = "/users/user_target/reports";
    const validBody = { reason: "impersonation" };

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(401);
      expect(createUserReport).not.toHaveBeenCalled();
    });

    it("creates the report and answers 201 with a neutral 'received' message", async () => {
      createUserReport.mockResolvedValue({ success: true, value: { id: "report_1", status: "open" } });

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(201);
      expect(createUserReport).toHaveBeenCalledWith("user_test_caller", "user_target", {
        reason: "impersonation",
      });
      expect(response.body.message).toBe("Report received. Our team will review it.");
    });

    it("rejects an unknown reason enum value with 422", async () => {
      const response = await request(app).post(path).send({ reason: "i_dont_like_them" });

      expect(response.status).toBe(422);
      expect(createUserReport).not.toHaveBeenCalled();
    });

    /**
     * 422, not 403 — the caller can plainly see their own profile, so nothing about this
     * refusal conceals anything. Same posture as `SELF_COUNTERSIGN_FORBIDDEN` elsewhere.
     */
    it("maps SELF_REPORT_FORBIDDEN to 422", async () => {
      createUserReport.mockResolvedValue({ success: false, error: { type: "SELF_REPORT_FORBIDDEN" } });

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(422);
    });

    it("maps ALREADY_REPORTED to 409", async () => {
      createUserReport.mockResolvedValue({ success: false, error: { type: "ALREADY_REPORTED" } });

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(409);
    });

    it("does not require an Idempotency-Key header — this write is honour-if-present, not required", async () => {
      createUserReport.mockResolvedValue({ success: true, value: { id: "report_1", status: "open" } });

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(201);
    });
  });

  describe("GET /users/admin/reports", () => {
    const path = "/users/admin/reports";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).get(path);

      expect(response.status).toBe(401);
      expect(listUserReports).not.toHaveBeenCalled();
    });

    it("requires moderate_content, checked service-side", async () => {
      listUserReports.mockResolvedValue(CAPABILITY_REQUIRED);

      const response = await request(app).get(path);

      expect(response.status).toBe(403);
      expect(response.body.data).toEqual({ capability: "moderate_content" });
    });

    it("lists reports with a default limit and nextCursor alongside data", async () => {
      listUserReports.mockResolvedValue({
        success: true,
        value: { items: [{ id: "report_1" }], nextCursor: "cursor_2" },
      });

      const response = await request(app).get(path);

      expect(response.status).toBe(200);
      expect(listUserReports).toHaveBeenCalledWith("user_test_caller", { limit: 20 });
      expect(response.body.data).toEqual([{ id: "report_1" }]);
      expect(response.body.nextCursor).toBe("cursor_2");
    });

    it("passes an explicit status filter and cursor through", async () => {
      listUserReports.mockResolvedValue({ success: true, value: { items: [], nextCursor: null } });

      const response = await request(app).get(`${path}?status=open&limit=5&cursor=cursor_1`);

      expect(response.status).toBe(200);
      expect(listUserReports).toHaveBeenCalledWith("user_test_caller", {
        status: "open",
        limit: 5,
        cursor: "cursor_1",
      });
    });

    it("maps INVALID_CURSOR to 422", async () => {
      listUserReports.mockResolvedValue({ success: false, error: { type: "INVALID_CURSOR" } });

      const response = await request(app).get(`${path}?cursor=garbage`);

      expect(response.status).toBe(422);
    });

    it("rejects an unknown query key with 422", async () => {
      const response = await request(app).get(`${path}?userId=other`);

      expect(response.status).toBe(422);
      expect(listUserReports).not.toHaveBeenCalled();
    });
  });

  describe("POST /users/admin/reports/:reportId/decisions", () => {
    const path = "/users/admin/reports/report_1/decisions";
    const validBody = { decision: "actioned" };

    it("requires an Idempotency-Key header", async () => {
      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(400);
      expect(decideUserReport).not.toHaveBeenCalled();
    });

    it("requires moderate_content, checked service-side", async () => {
      decideUserReport.mockResolvedValue(CAPABILITY_REQUIRED);

      const response = await request(app).post(path).set("Idempotency-Key", "decide_key_1").send(validBody);

      expect(response.status).toBe(403);
    });

    it("actions the report and answers a hidden-text message", async () => {
      decideUserReport.mockResolvedValue({ success: true, value: { id: "report_1", status: "actioned" } });

      const response = await request(app).post(path).set("Idempotency-Key", "decide_key_2").send(validBody);

      expect(response.status).toBe(200);
      expect(decideUserReport).toHaveBeenCalledWith("user_test_caller", "report_1", {
        decision: "actioned",
      });
      expect(response.body.message).toBe("Profile text hidden.");
    });

    it("dismisses the report and answers a nothing-was-hidden message", async () => {
      decideUserReport.mockResolvedValue({ success: true, value: { id: "report_1", status: "dismissed" } });

      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "decide_key_3")
        .send({ decision: "dismissed" });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe("Report dismissed. Nothing was hidden.");
    });

    /**
     * A moderator cannot decide a report about their own profile. 403 (not 422) — this is
     * a real permission boundary, distinct from the SELF_REPORT_FORBIDDEN 422 above.
     */
    it("maps MODERATOR_IS_SUBJECT to 403", async () => {
      decideUserReport.mockResolvedValue({ success: false, error: { type: "MODERATOR_IS_SUBJECT" } });

      const response = await request(app).post(path).set("Idempotency-Key", "decide_key_4").send(validBody);

      expect(response.status).toBe(403);
    });

    it("maps REPORT_ALREADY_RESOLVED to 409", async () => {
      decideUserReport.mockResolvedValue({
        success: false,
        error: { type: "REPORT_ALREADY_RESOLVED" },
      });

      const response = await request(app).post(path).set("Idempotency-Key", "decide_key_5").send(validBody);

      expect(response.status).toBe(409);
    });

    it("rejects an unknown decision enum value with 422", async () => {
      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "decide_key_6")
        .send({ decision: "banned" });

      expect(response.status).toBe(422);
      expect(decideUserReport).not.toHaveBeenCalled();
    });
  });

  describe("POST /users/admin/profile-text/restore", () => {
    const path = "/users/admin/profile-text/restore";
    const validBody = { reportedUserId: "user_target", reasonNote: "Restored after appeal." };

    it("requires an Idempotency-Key header", async () => {
      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(400);
      expect(restoreUserProfileText).not.toHaveBeenCalled();
    });

    it("requires moderate_content, checked service-side", async () => {
      restoreUserProfileText.mockResolvedValue(CAPABILITY_REQUIRED);

      const response = await request(app).post(path).set("Idempotency-Key", "restore_key_1").send(validBody);

      expect(response.status).toBe(403);
    });

    it("restores the text and answers 200", async () => {
      restoreUserProfileText.mockResolvedValue({ success: true, value: { restored: true } });

      const response = await request(app).post(path).set("Idempotency-Key", "restore_key_2").send(validBody);

      expect(response.status).toBe(200);
      expect(restoreUserProfileText).toHaveBeenCalledWith("user_test_caller", validBody);
    });

    it("requires a reasonNote — the overturning action does not get to be silent", async () => {
      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "restore_key_3")
        .send({ reportedUserId: "user_target" });

      expect(response.status).toBe(422);
      expect(restoreUserProfileText).not.toHaveBeenCalled();
    });

    it("maps PROFILE_TEXT_ALREADY_VISIBLE to 409", async () => {
      restoreUserProfileText.mockResolvedValue({
        success: false,
        error: { type: "PROFILE_TEXT_ALREADY_VISIBLE" },
      });

      const response = await request(app).post(path).set("Idempotency-Key", "restore_key_4").send(validBody);

      expect(response.status).toBe(409);
    });

    it("maps USER_REPORT_NOT_FOUND to 404", async () => {
      restoreUserProfileText.mockResolvedValue({
        success: false,
        error: { type: "USER_REPORT_NOT_FOUND" },
      });

      const response = await request(app).post(path).set("Idempotency-Key", "restore_key_5").send(validBody);

      expect(response.status).toBe(404);
    });
  });
});
