import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for site feedback — no test file existed for this module at all.
 * `moderate_content` on the admin read is checked INSIDE the service (the route carries no
 * capability middleware, by the router's own docs), so the 403 case here is a mocked
 * domain error, matching the shape used across `platform-roles.routes.test.ts`.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

/**
 * `requireIdentifiedUser` hits the real `db` query builder; stubbed to a pass-through here
 * so this suite stays about routing, following the precedent in
 * `import-intelligence.routes.test.ts`.
 */
vi.mock("#src/middleware/require-identified-user.js", () => ({
  requireIdentifiedUser: (_req: unknown, _res: unknown, next: (error?: unknown) => void): void => {
    next();
  },
}));

const createPlatformFeedback = vi.fn<(...args: readonly unknown[]) => unknown>();
const listPlatformFeedback = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/platform/feedback/feedback.service.js", () => ({
  createPlatformFeedback: (...args: readonly unknown[]) => createPlatformFeedback(...args),
  listPlatformFeedback: (...args: readonly unknown[]) => listPlatformFeedback(...args),
}));

describe("platform feedback routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signInAs();
    await resetRateLimiters();
  });

  describe("POST /feedback", () => {
    const validBody = { category: "bug", message: "Checkout button is unresponsive.", pagePath: "/checkout" };

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).post("/feedback").send(validBody);

      expect(response.status).toBe(401);
      expect(createPlatformFeedback).not.toHaveBeenCalled();
    });

    it("records feedback and answers 201, reading the user agent off the header", async () => {
      createPlatformFeedback.mockResolvedValue({ id: "feedback_1", status: "new" });

      const response = await request(app).post("/feedback").set("User-Agent", "TestAgent/1.0").send(validBody);

      expect(response.status).toBe(201);
      expect(createPlatformFeedback).toHaveBeenCalledWith("user_test_caller", {
        category: "bug",
        message: "Checkout button is unresponsive.",
        pagePath: "/checkout",
        userAgent: "TestAgent/1.0",
      });
    });

    it("rejects a category outside the enum with 422", async () => {
      const response = await request(app)
        .post("/feedback")
        .send({ ...validBody, category: "complaint" });

      expect(response.status).toBe(422);
      expect(createPlatformFeedback).not.toHaveBeenCalled();
    });

    it("rejects a pagePath with no leading slash", async () => {
      const response = await request(app)
        .post("/feedback")
        .send({ ...validBody, pagePath: "checkout" });

      expect(response.status).toBe(422);
      expect(createPlatformFeedback).not.toHaveBeenCalled();
    });

    it("rejects a client-supplied userAgent field with 422 — it must come from the header", async () => {
      const response = await request(app)
        .post("/feedback")
        .send({ ...validBody, userAgent: "spoofed" });

      expect(response.status).toBe(422);
      expect(createPlatformFeedback).not.toHaveBeenCalled();
    });
  });

  describe("GET /admin/feedback", () => {
    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).get("/admin/feedback");

      expect(response.status).toBe(401);
      expect(listPlatformFeedback).not.toHaveBeenCalled();
    });

    it("requires moderate_content, checked service-side", async () => {
      listPlatformFeedback.mockResolvedValue({
        success: false,
        error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_content" },
      });

      const response = await request(app).get("/admin/feedback");

      expect(response.status).toBe(403);
    });

    it("lists feedback with the default page size and a bare nextCursor", async () => {
      listPlatformFeedback.mockResolvedValue({
        success: true,
        value: { items: [{ id: "feedback_1" }], nextCursor: "cursor_1" },
      });

      const response = await request(app).get("/admin/feedback");

      expect(response.status).toBe(200);
      expect(listPlatformFeedback).toHaveBeenCalledWith("user_test_caller", { limit: 20 });
      expect(response.body.data).toEqual([{ id: "feedback_1" }]);
      expect(response.body.nextCursor).toBe("cursor_1");
    });

    it("passes status/limit/cursor through when given", async () => {
      listPlatformFeedback.mockResolvedValue({ success: true, value: { items: [], nextCursor: null } });

      const response = await request(app).get("/admin/feedback?status=reviewed&limit=5&cursor=abc");

      expect(response.status).toBe(200);
      expect(listPlatformFeedback).toHaveBeenCalledWith("user_test_caller", {
        status: "reviewed",
        limit: 5,
        cursor: "abc",
      });
    });

    it("maps INVALID_CURSOR to 422", async () => {
      listPlatformFeedback.mockResolvedValue({ success: false, error: { type: "INVALID_CURSOR" } });

      const response = await request(app).get("/admin/feedback?cursor=nonsense");

      expect(response.status).toBe(422);
    });

    it("rejects an unknown query key with 422", async () => {
      const response = await request(app).get("/admin/feedback?authorUserId=other");

      expect(response.status).toBe(422);
      expect(listPlatformFeedback).not.toHaveBeenCalled();
    });
  });
});
