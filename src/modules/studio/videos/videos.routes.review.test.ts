import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for the anime-episode moderation queue
 * (`GET/POST /videos/admin/review*`) — previously untested at any tier. `moderate_content`
 * is checked SERVICE-SIDE (`content-review.service.ts`'s `requirePlatformCapability` call),
 * never by route middleware, so every 403 case here is a mocked domain error.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

const listReviewQueue = vi.fn<(...args: readonly unknown[]) => unknown>();
const approveAnimeEpisode = vi.fn<(...args: readonly unknown[]) => unknown>();
const rejectAnimeEpisode = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/studio/content-review.service.js", () => ({
  listReviewQueue: (...args: readonly unknown[]) => listReviewQueue(...args),
  approveAnimeEpisode: (...args: readonly unknown[]) => approveAnimeEpisode(...args),
  rejectAnimeEpisode: (...args: readonly unknown[]) => rejectAnimeEpisode(...args),
}));

const CAPABILITY_REQUIRED = { success: false, error: { type: "PLATFORM_CAPABILITY_REQUIRED" } } as const;

describe("videos admin review routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signInAs();
    await resetRateLimiters();
  });

  describe("GET /videos/admin/review", () => {
    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).get("/videos/admin/review");

      expect(response.status).toBe(401);
      expect(listReviewQueue).not.toHaveBeenCalled();
    });

    it("requires moderate_content, decided before any id is read", async () => {
      listReviewQueue.mockResolvedValue(CAPABILITY_REQUIRED);

      const response = await request(app).get("/videos/admin/review");

      expect(response.status).toBe(403);
    });

    it("lists the pending queue by default, with the parsed pagination echoed back", async () => {
      listReviewQueue.mockResolvedValue({ success: true, value: { rows: [{ id: "video_1" }], total: 1 } });

      const response = await request(app).get("/videos/admin/review");

      expect(response.status).toBe(200);
      expect(listReviewQueue).toHaveBeenCalledWith("user_test_caller", {
        status: "pending",
        page: 1,
        limit: 20,
      });
      expect(response.body.data).toEqual([{ id: "video_1" }]);
      expect(response.body.pagination).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
    });

    it("passes a requested status and page through", async () => {
      listReviewQueue.mockResolvedValue({ success: true, value: { rows: [], total: 0 } });

      const response = await request(app).get("/videos/admin/review?status=rejected&page=2&limit=10");

      expect(response.status).toBe(200);
      expect(listReviewQueue).toHaveBeenCalledWith("user_test_caller", {
        status: "rejected",
        page: 2,
        limit: 10,
      });
    });

    it("rejects a status outside the enum with 422", async () => {
      const response = await request(app).get("/videos/admin/review?status=live");

      expect(response.status).toBe(422);
      expect(listReviewQueue).not.toHaveBeenCalled();
    });

    it("rejects an unknown query key with 422", async () => {
      const response = await request(app).get("/videos/admin/review?videoId=other");

      expect(response.status).toBe(422);
      expect(listReviewQueue).not.toHaveBeenCalled();
    });
  });

  describe("POST /videos/admin/review/:videoId/approve", () => {
    const path = "/videos/admin/review/video_1/approve";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).post(path);

      expect(response.status).toBe(401);
      expect(approveAnimeEpisode).not.toHaveBeenCalled();
    });

    it("requires moderate_content", async () => {
      approveAnimeEpisode.mockResolvedValue(CAPABILITY_REQUIRED);

      const response = await request(app).post(path);

      expect(response.status).toBe(403);
    });

    it("approves and publishes, and passes the resolved caller and video id through", async () => {
      approveAnimeEpisode.mockResolvedValue({
        success: true,
        value: { videoId: "video_1", publishStatus: "published" },
      });

      const response = await request(app).post(path);

      expect(response.status).toBe(200);
      expect(approveAnimeEpisode).toHaveBeenCalledWith("user_test_caller", "video_1");
      expect(response.body.message).toBe("Episode approved and published");
    });

    it("says 'scheduled' rather than 'published' for an embargoed episode", async () => {
      approveAnimeEpisode.mockResolvedValue({
        success: true,
        value: { videoId: "video_1", publishStatus: "scheduled" },
      });

      const response = await request(app).post(path);

      expect(response.status).toBe(200);
      expect(response.body.message).toBe("Episode approved and scheduled for its premiere date");
    });

    it("maps VIDEO_NOT_FOUND to 404", async () => {
      approveAnimeEpisode.mockResolvedValue({ success: false, error: { type: "VIDEO_NOT_FOUND" } });

      const response = await request(app).post(path);

      expect(response.status).toBe(404);
    });

    it("maps REVIEW_NOT_PENDING to 409 for an already-decided episode", async () => {
      approveAnimeEpisode.mockResolvedValue({
        success: false,
        error: { type: "REVIEW_NOT_PENDING", reviewStatus: "approved" },
      });

      const response = await request(app).post(path);

      expect(response.status).toBe(409);
    });

    it("maps NOT_AN_ANIME_EPISODE to 422", async () => {
      approveAnimeEpisode.mockResolvedValue({ success: false, error: { type: "NOT_AN_ANIME_EPISODE" } });

      const response = await request(app).post(path);

      expect(response.status).toBe(422);
    });
  });

  describe("POST /videos/admin/review/:videoId/reject", () => {
    const path = "/videos/admin/review/video_1/reject";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).post(path).send({ reason: "Copyright concerns." });

      expect(response.status).toBe(401);
      expect(rejectAnimeEpisode).not.toHaveBeenCalled();
    });

    it("requires moderate_content", async () => {
      rejectAnimeEpisode.mockResolvedValue(CAPABILITY_REQUIRED);

      const response = await request(app).post(path).send({ reason: "Copyright concerns." });

      expect(response.status).toBe(403);
    });

    /** `reason` is required and non-empty per the schema — a rejection with none is unactionable. */
    it("rejects a missing reason with 422", async () => {
      const response = await request(app).post(path).send({});

      expect(response.status).toBe(422);
      expect(rejectAnimeEpisode).not.toHaveBeenCalled();
    });

    it("rejects an empty-string reason with 422", async () => {
      const response = await request(app).post(path).send({ reason: "   " });

      expect(response.status).toBe(422);
      expect(rejectAnimeEpisode).not.toHaveBeenCalled();
    });

    it("rejects the episode and passes the reason through", async () => {
      rejectAnimeEpisode.mockResolvedValue({
        success: true,
        value: { videoId: "video_1", reviewStatus: "rejected" },
      });

      const response = await request(app).post(path).send({ reason: "Copyright concerns." });

      expect(response.status).toBe(200);
      expect(rejectAnimeEpisode).toHaveBeenCalledWith("user_test_caller", "video_1", "Copyright concerns.");
      expect(response.body.message).toBe("Episode rejected");
    });

    it("maps REVIEW_NOT_PENDING to 409", async () => {
      rejectAnimeEpisode.mockResolvedValue({
        success: false,
        error: { type: "REVIEW_NOT_PENDING", reviewStatus: "rejected" },
      });

      const response = await request(app).post(path).send({ reason: "Copyright concerns." });

      expect(response.status).toBe(409);
    });

    it("rejects an unknown body field with 422", async () => {
      const response = await request(app).post(path).send({ reason: "Copyright concerns.", silent: true });

      expect(response.status).toBe(422);
      expect(rejectAnimeEpisode).not.toHaveBeenCalled();
    });
  });
});
