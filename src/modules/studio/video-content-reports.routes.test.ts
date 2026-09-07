import type { Express, NextFunction, Request, Response } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for video content reporting (reporter's write + staff queue) —
 * previously untested at any tier. Moderation-governance surface: `decideVideoReport` and
 * `restoreVideo` append hash-chained audit entries, and `moderate_content` is checked
 * SERVICE-SIDE (never route middleware) per the router's own docblock, so every 403 here
 * is a mocked domain error, not a different middleware chain.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

/**
 * `requireIdentifiedUser` (on `POST /:videoId/reports` only) hits the real `db` query
 * builder; it has its own dedicated suite. Stubbed to a pass-through here, matching
 * `import-intelligence.routes.test.ts`'s precedent.
 */
vi.mock("#src/middleware/require-identified-user.js", () => ({
  requireIdentifiedUser: (_req: unknown, _res: unknown, next: (error?: unknown) => void): void => {
    next();
  },
}));

/**
 * Local idempotency fake, user-scoped only (no commerce-org concept here) — a `Map`-backed
 * replay cache keyed by header, honouring `required: true`. The real middleware short-
 * circuits BEFORE touching `db` when the key is simply missing (confirmed by reading
 * `idempotency.ts`), so that specific case works against the real middleware; but a request
 * that DOES carry a key reaches a real `db.select()` the shared mock can't satisfy, so the
 * middleware is faked wholesale here, matching `commerce-cart.routes.test.ts`'s pattern.
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

const createVideoReport = vi.fn<(...args: readonly unknown[]) => unknown>();
const listVideoReports = vi.fn<(...args: readonly unknown[]) => unknown>();
const decideVideoReport = vi.fn<(...args: readonly unknown[]) => unknown>();
const restoreVideo = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/studio/video-content-reports.service.js", () => ({
  createVideoReport: (...args: readonly unknown[]) => createVideoReport(...args),
  listVideoReports: (...args: readonly unknown[]) => listVideoReports(...args),
  decideVideoReport: (...args: readonly unknown[]) => decideVideoReport(...args),
  restoreVideo: (...args: readonly unknown[]) => restoreVideo(...args),
  // `listMyVideoReports` is used by a different route (`GET /users/me/video-reports`,
  // mounted on the auth users router) — stubbed here only because the controller module
  // exports it alongside the four above and the mock replaces the whole module.
  listMyVideoReports: vi.fn<(...args: readonly unknown[]) => unknown>(),
}));

const CAPABILITY_REQUIRED = {
  success: false,
  error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_content" },
} as const;

describe("video content reports routes", () => {
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

  describe("POST /videos/:videoId/reports", () => {
    const path = "/videos/video_1/reports";
    const validBody = { reason: "spam_or_misleading" };

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(401);
      expect(createVideoReport).not.toHaveBeenCalled();
    });

    it("does not require an Idempotency-Key header", async () => {
      createVideoReport.mockResolvedValue({ success: true, value: { id: "report_1" } });

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(201);
      expect(createVideoReport).toHaveBeenCalledWith("user_test_caller", "video_1", {
        reason: "spam_or_misleading",
      });
    });

    it("replays a cached response for a repeated Idempotency-Key", async () => {
      createVideoReport.mockResolvedValue({ success: true, value: { id: "report_1" } });

      const first = await request(app).post(path).set("Idempotency-Key", "report_key_1").send(validBody);
      const second = await request(app).post(path).set("Idempotency-Key", "report_key_1").send(validBody);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.headers["idempotency-replayed"]).toBe("true");
      expect(createVideoReport).toHaveBeenCalledTimes(1);
    });

    it("rejects a reason outside the enum with 422", async () => {
      const response = await request(app).post(path).send({ reason: "i_dont_like_it" });

      expect(response.status).toBe(422);
      expect(createVideoReport).not.toHaveBeenCalled();
    });

    it("rejects a stray query param with 422", async () => {
      const response = await request(app).post(`${path}?debug=true`).send(validBody);

      expect(response.status).toBe(422);
      expect(createVideoReport).not.toHaveBeenCalled();
    });

    it("maps ALREADY_REPORTED to 409", async () => {
      createVideoReport.mockResolvedValue({ success: false, error: { type: "ALREADY_REPORTED" } });

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(409);
    });

    /**
     * The self-dealing prevention rule for this surface: reporting your own video is a
     * route to the studio (edit/unpublish it yourself), not to moderation. 422, not 403 —
     * the caller CAN see the video; the request itself doesn't make sense.
     */
    it("maps SELF_REPORT_FORBIDDEN to 422", async () => {
      createVideoReport.mockResolvedValue({ success: false, error: { type: "SELF_REPORT_FORBIDDEN" } });

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(422);
    });

    it("maps VIDEO_REPORT_NOT_FOUND to 404 for a video that doesn't exist or isn't public", async () => {
      createVideoReport.mockResolvedValue({ success: false, error: { type: "VIDEO_REPORT_NOT_FOUND" } });

      const response = await request(app).post("/videos/video-missing/reports").send(validBody);

      expect(response.status).toBe(404);
    });
  });

  describe("GET /videos/admin/content-reports", () => {
    const path = "/videos/admin/content-reports";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).get(path);

      expect(response.status).toBe(401);
      expect(listVideoReports).not.toHaveBeenCalled();
    });

    it("requires moderate_content", async () => {
      listVideoReports.mockResolvedValue(CAPABILITY_REQUIRED);

      const response = await request(app).get(path);

      expect(response.status).toBe(403);
      expect(response.body.data).toEqual({ capability: "moderate_content" });
    });

    it("lists the queue with the parsed filter", async () => {
      listVideoReports.mockResolvedValue({
        success: true,
        value: { rows: [{ id: "report_1", status: "open" }], nextCursor: null },
      });

      const response = await request(app).get(`${path}?status=open&limit=10`);

      expect(response.status).toBe(200);
      expect(listVideoReports).toHaveBeenCalledWith("user_test_caller", {
        status: "open",
        limit: 10,
        cursor: undefined,
      });
      expect(response.body.data).toEqual([{ id: "report_1", status: "open" }]);
      expect(response.body.nextCursor).toBeNull();
    });

    it("rejects an unknown status value with 422", async () => {
      const response = await request(app).get(`${path}?status=escalated`);

      expect(response.status).toBe(422);
      expect(listVideoReports).not.toHaveBeenCalled();
    });

    it("maps INVALID_CURSOR to 422", async () => {
      listVideoReports.mockResolvedValue({ success: false, error: { type: "INVALID_CURSOR" } });

      const response = await request(app).get(`${path}?cursor=nonsense`);

      expect(response.status).toBe(422);
    });
  });

  describe("POST /videos/admin/content-reports/:reportId/decisions", () => {
    const path = "/videos/admin/content-reports/report_1/decisions";
    const validBody = { decision: "actioned" };

    it("requires an Idempotency-Key header", async () => {
      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(400);
      expect(decideVideoReport).not.toHaveBeenCalled();
    });

    it("requires moderate_content", async () => {
      decideVideoReport.mockResolvedValue(CAPABILITY_REQUIRED);

      const response = await request(app).post(path).set("Idempotency-Key", "decision_key_1").send(validBody);

      expect(response.status).toBe(403);
    });

    it("actions the report and hides the video", async () => {
      decideVideoReport.mockResolvedValue({ success: true, value: { id: "report_1", status: "actioned" } });

      const response = await request(app).post(path).set("Idempotency-Key", "decision_key_2").send(validBody);

      expect(response.status).toBe(200);
      expect(decideVideoReport).toHaveBeenCalledWith("user_test_caller", "report_1", { decision: "actioned" });
      expect(response.body.message).toBe("Video hidden.");
    });

    it("dismisses the report without hiding the video", async () => {
      decideVideoReport.mockResolvedValue({ success: true, value: { id: "report_1", status: "dismissed" } });

      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "decision_key_3")
        .send({ decision: "dismissed" });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe("Report dismissed.");
    });

    it("rejects a decision outside the enum with 422", async () => {
      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "decision_key_4")
        .send({ decision: "escalated" });

      expect(response.status).toBe(422);
      expect(decideVideoReport).not.toHaveBeenCalled();
    });

    /**
     * The self-dealing prevention rule for staff: a moderator cannot decide a report about
     * their own video. 403, unlike SELF_REPORT_FORBIDDEN — here the caller genuinely lacks
     * standing to act, since the capability exists for OTHER people's content.
     */
    it("maps MODERATOR_IS_CREATOR to 403", async () => {
      decideVideoReport.mockResolvedValue({ success: false, error: { type: "MODERATOR_IS_CREATOR" } });

      const response = await request(app).post(path).set("Idempotency-Key", "decision_key_5").send(validBody);

      expect(response.status).toBe(403);
    });

    it("maps REPORT_ALREADY_RESOLVED to 409", async () => {
      decideVideoReport.mockResolvedValue({
        success: false,
        error: { type: "REPORT_ALREADY_RESOLVED" },
      });

      const response = await request(app).post(path).set("Idempotency-Key", "decision_key_6").send(validBody);

      expect(response.status).toBe(409);
    });

    it("maps VIDEO_REPORT_NOT_FOUND to 404", async () => {
      decideVideoReport.mockResolvedValue({
        success: false,
        error: { type: "VIDEO_REPORT_NOT_FOUND" },
      });

      const response = await request(app)
        .post("/videos/admin/content-reports/report-missing/decisions")
        .set("Idempotency-Key", "decision_key_7")
        .send(validBody);

      expect(response.status).toBe(404);
    });
  });

  describe("POST /videos/admin/content/restore", () => {
    const path = "/videos/admin/content/restore";
    const validBody = { videoId: "video_1", reasonNote: "Report was mistaken; video reinstated." };

    it("requires an Idempotency-Key header", async () => {
      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(400);
      expect(restoreVideo).not.toHaveBeenCalled();
    });

    it("requires moderate_content", async () => {
      restoreVideo.mockResolvedValue(CAPABILITY_REQUIRED);

      const response = await request(app).post(path).set("Idempotency-Key", "restore_key_1").send(validBody);

      expect(response.status).toBe(403);
    });

    it("restores the video", async () => {
      restoreVideo.mockResolvedValue({ success: true, value: { id: "video_1", status: "visible" } });

      const response = await request(app).post(path).set("Idempotency-Key", "restore_key_2").send(validBody);

      expect(response.status).toBe(200);
      expect(restoreVideo).toHaveBeenCalledWith("user_test_caller", validBody);
    });

    it("requires reasonNote — an un-hide with no stated reason is not a record", async () => {
      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "restore_key_3")
        .send({ videoId: "video_1" });

      expect(response.status).toBe(422);
      expect(restoreVideo).not.toHaveBeenCalled();
    });

    it("maps VIDEO_ALREADY_VISIBLE to 409", async () => {
      restoreVideo.mockResolvedValue({ success: false, error: { type: "VIDEO_ALREADY_VISIBLE" } });

      const response = await request(app).post(path).set("Idempotency-Key", "restore_key_4").send(validBody);

      expect(response.status).toBe(409);
    });
  });
});
