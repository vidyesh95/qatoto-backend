import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for `/watch-history` — its own router, its own mount, previously
 * untested at any behavior tier. Unlike the rest of the engagement surface, this
 * controller has no error union: every write is scoped to `req.user.id` and idempotent
 * against a nullable column, so the only failure modes are a malformed uuid (422) and no
 * session (401) — see `watch-history.controller.ts`'s own header for why.
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

const hideVideoFromWatchHistory = vi.fn<(...args: readonly unknown[]) => unknown>();
const restoreVideoToWatchHistory = vi.fn<(...args: readonly unknown[]) => unknown>();
const clearWatchHistory = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/home/engagement/watch-history.service.js", () => ({
  hideVideoFromWatchHistory: (...args: readonly unknown[]) => hideVideoFromWatchHistory(...args),
  restoreVideoToWatchHistory: (...args: readonly unknown[]) => restoreVideoToWatchHistory(...args),
  clearWatchHistory: (...args: readonly unknown[]) => clearWatchHistory(...args),
}));

const VIDEO_ID = "11111111-1111-4111-8111-111111111111";

describe("watch history routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signInAs();
    await resetRateLimiters();
  });

  describe("DELETE /watch-history/videos/:videoId", () => {
    const path = `/watch-history/videos/${VIDEO_ID}`;

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).delete(path);

      expect(response.status).toBe(401);
      expect(hideVideoFromWatchHistory).not.toHaveBeenCalled();
    });

    /**
     * 200 even when it matched nothing — an unknown or never-watched videoId leaves the
     * caller exactly where they asked to be, and a 404 would let anyone probe which
     * uuids are real videos.
     */
    it("answers 200 even when the video was never in this viewer's history", async () => {
      hideVideoFromWatchHistory.mockResolvedValue({ affectedSessionCount: 0 });

      const response = await request(app).delete(path);

      expect(response.status).toBe(200);
      expect(hideVideoFromWatchHistory).toHaveBeenCalledWith("user_test_caller", VIDEO_ID);
      expect(response.body.data).toEqual({ hiddenSessionCount: 0 });
    });

    it("removes real sessions and reports the count", async () => {
      hideVideoFromWatchHistory.mockResolvedValue({ affectedSessionCount: 3 });

      const response = await request(app).delete(path);

      expect(response.body.data).toEqual({ hiddenSessionCount: 3 });
    });

    it("rejects a malformed :videoId with 422", async () => {
      const response = await request(app).delete("/watch-history/videos/not-a-uuid");

      expect(response.status).toBe(422);
      expect(hideVideoFromWatchHistory).not.toHaveBeenCalled();
    });
  });

  describe("PUT /watch-history/videos/:videoId — undo", () => {
    const path = `/watch-history/videos/${VIDEO_ID}`;

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).put(path);

      expect(response.status).toBe(401);
      expect(restoreVideoToWatchHistory).not.toHaveBeenCalled();
    });

    it("restores and reports the count", async () => {
      restoreVideoToWatchHistory.mockResolvedValue({ affectedSessionCount: 1 });

      const response = await request(app).put(path);

      expect(response.status).toBe(200);
      expect(restoreVideoToWatchHistory).toHaveBeenCalledWith("user_test_caller", VIDEO_ID);
      expect(response.body.data).toEqual({ restoredSessionCount: 1 });
    });

    /** The rows may have aged past the prune window between hide and undo — a real 0. */
    it("answers 200 with a zero count when the rows have already been pruned", async () => {
      restoreVideoToWatchHistory.mockResolvedValue({ affectedSessionCount: 0 });

      const response = await request(app).put(path);

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ restoredSessionCount: 0 });
    });
  });

  describe("DELETE /watch-history — clear everything", () => {
    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).delete("/watch-history");

      expect(response.status).toBe(401);
      expect(clearWatchHistory).not.toHaveBeenCalled();
    });

    it("clears and reports the cleared session count, not a video count", async () => {
      clearWatchHistory.mockResolvedValue({ affectedSessionCount: 41 });

      const response = await request(app).delete("/watch-history");

      expect(response.status).toBe(200);
      expect(clearWatchHistory).toHaveBeenCalledWith("user_test_caller");
      expect(response.body.data).toEqual({ clearedSessionCount: 41 });
    });
  });
});
