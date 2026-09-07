import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for the home feed's public read surface — previously untested at any
 * tier. Every route here is public or optional-auth (`attachOptionalUser` or fully bare),
 * so NO CASE in this file asserts a 401 for a signed-out caller — that would assert
 * behavior these routes deliberately do not have (see each route's own docblock in
 * `feed.routes.ts`). Where the controller genuinely branches on identity (`listFeedVideos`,
 * `getWatchPayload`, `searchVideos` all thread `req.user?.id ?? null` into the service),
 * that branch is what's asserted instead.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

const listActiveContentCategories = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/studio/content-categories.service.js", () => ({
  listActiveContentCategories: (...args: readonly unknown[]) => listActiveContentCategories(...args),
}));

const getWatchPayload = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/home/engagement/video-watch.service.js", () => ({
  getWatchPayload: (...args: readonly unknown[]) => getWatchPayload(...args),
}));

const listFeedVideosService = vi.fn<(...args: readonly unknown[]) => unknown>();
const searchVideosService = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/home/feed/feed.service.js", async () => {
  const actual = await vi.importActual<typeof import("#src/modules/home/feed/feed.service.js")>(
    "#src/modules/home/feed/feed.service.js",
  );
  return {
    FEED_MODES: actual.FEED_MODES,
    listFeedVideos: (...args: readonly unknown[]) => listFeedVideosService(...args),
    searchVideos: (...args: readonly unknown[]) => searchVideosService(...args),
  };
});

const WELL_FORMED_RANK_SEED = "0123456789abcdef0123456789abcdef".slice(0, 32);

describe("feed routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signInAs();
    await resetRateLimiters();
  });

  describe("GET /feed/categories", () => {
    it("returns the active taxonomy for a signed-out visitor, with no session lookup", async () => {
      signOut();
      listActiveContentCategories.mockResolvedValue([{ slug: "anime", label: "Anime" }]);

      const response = await request(app).get("/feed/categories");

      expect(response.status).toBe(200);
      expect(listActiveContentCategories).toHaveBeenCalledWith();
      expect(response.body.data).toEqual([{ slug: "anime", label: "Anime" }]);
    });
  });

  describe("GET /feed/watch/:videoId", () => {
    const videoId = "123e4567-e89b-42d3-a456-426614174000";

    it("passes null as the viewer id for a signed-out caller", async () => {
      signOut();
      getWatchPayload.mockResolvedValue({ success: true, value: { id: videoId } });

      const response = await request(app).get(`/feed/watch/${videoId}`);

      expect(response.status).toBe(200);
      expect(getWatchPayload).toHaveBeenCalledWith(videoId, null);
    });

    it("passes the signed-in caller's id as the viewer id", async () => {
      getWatchPayload.mockResolvedValue({ success: true, value: { id: videoId } });

      const response = await request(app).get(`/feed/watch/${videoId}`);

      expect(response.status).toBe(200);
      expect(getWatchPayload).toHaveBeenCalledWith(videoId, "user_test_caller");
    });

    it("rejects a non-UUID videoId with 422", async () => {
      const response = await request(app).get("/feed/watch/not-a-uuid");

      expect(response.status).toBe(422);
      expect(getWatchPayload).not.toHaveBeenCalled();
    });

    it("maps VIDEO_NOT_FOUND to 404", async () => {
      getWatchPayload.mockResolvedValue({ success: false, error: { type: "VIDEO_NOT_FOUND" } });

      const response = await request(app).get(`/feed/watch/${videoId}`);

      expect(response.status).toBe(404);
    });
  });

  describe("GET /feed/videos", () => {
    it("passes null as the viewer id for a signed-out caller", async () => {
      signOut();
      listFeedVideosService.mockResolvedValue({
        success: true,
        value: { rows: [], total: 0, rankSeed: WELL_FORMED_RANK_SEED },
      });

      const response = await request(app).get(`/feed/videos?rankSeed=${WELL_FORMED_RANK_SEED}`);

      expect(response.status).toBe(200);
      expect(listFeedVideosService).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "all", viewerUserId: null, rankSeed: WELL_FORMED_RANK_SEED }),
      );
    });

    it("passes the signed-in caller's id as the viewer id", async () => {
      listFeedVideosService.mockResolvedValue({
        success: true,
        value: { rows: [], total: 0, rankSeed: WELL_FORMED_RANK_SEED },
      });

      const response = await request(app).get(`/feed/videos?rankSeed=${WELL_FORMED_RANK_SEED}`);

      expect(response.status).toBe(200);
      expect(listFeedVideosService).toHaveBeenCalledWith(expect.objectContaining({ viewerUserId: "user_test_caller" }));
    });

    it("mints a well-formed rank seed when the caller supplies none", async () => {
      listFeedVideosService.mockResolvedValue({
        success: true,
        value: { rows: [], total: 0, rankSeed: WELL_FORMED_RANK_SEED },
      });

      await request(app).get("/feed/videos");

      const [callArgs] = listFeedVideosService.mock.calls[0] as [{ rankSeed: string }];
      expect(callArgs.rankSeed).toMatch(/^[0-9a-f]{32}$/);
    });

    /**
     * The Zod schema only checks LENGTH (`z.string().length(RANK_SEED_LENGTH)`); a
     * same-length string that isn't hex passes the parse boundary and reaches the
     * controller's own `isWellFormedRankSeed` check, which replaces rather than rejects it.
     */
    it("replaces a same-length but non-hex rank seed rather than rejecting the request", async () => {
      listFeedVideosService.mockResolvedValue({
        success: true,
        value: { rows: [], total: 0, rankSeed: WELL_FORMED_RANK_SEED },
      });
      const sameLengthNonHexSeed = "Z".repeat(32);

      const response = await request(app).get(`/feed/videos?rankSeed=${sameLengthNonHexSeed}`);

      expect(response.status).toBe(200);
      const [callArgs] = listFeedVideosService.mock.calls[0] as [{ rankSeed: string }];
      expect(callArgs.rankSeed).toMatch(/^[0-9a-f]{32}$/);
      expect(callArgs.rankSeed).not.toBe(sameLengthNonHexSeed);
    });

    it("rejects a rank seed of the wrong length with 422 at the parse boundary", async () => {
      const response = await request(app).get("/feed/videos?rankSeed=too-short");

      expect(response.status).toBe(422);
      expect(listFeedVideosService).not.toHaveBeenCalled();
    });

    it("rejects an unknown mode with 422", async () => {
      const response = await request(app).get("/feed/videos?mode=nonsense");

      expect(response.status).toBe(422);
      expect(listFeedVideosService).not.toHaveBeenCalled();
    });

    it("rejects an unknown query key with 422", async () => {
      const response = await request(app).get("/feed/videos?userId=someone-else");

      expect(response.status).toBe(422);
      expect(listFeedVideosService).not.toHaveBeenCalled();
    });

    it("carries the pagination envelope and rankSeed alongside data", async () => {
      listFeedVideosService.mockResolvedValue({
        success: true,
        value: { rows: [{ id: "video_1" }], total: 1, rankSeed: WELL_FORMED_RANK_SEED },
      });

      const response = await request(app).get(`/feed/videos?rankSeed=${WELL_FORMED_RANK_SEED}`);

      expect(response.body.data).toEqual([{ id: "video_1" }]);
      expect(response.body.pagination).toEqual({ page: 1, limit: 24, total: 1, totalPages: 1 });
      expect(response.body.rankSeed).toBe(WELL_FORMED_RANK_SEED);
    });

    /**
     * `?mode=watched` is the one case on this route that DOES answer 401 — the controller
     * decides it, not the route's middleware chain, because every other mode is genuinely
     * public. Serving watch history off an IP fingerprint would hand one visitor's history
     * to everyone behind the same NAT.
     */
    it("answers 401 for mode=watched when the caller is anonymous", async () => {
      signOut();
      listFeedVideosService.mockResolvedValue({
        success: false,
        error: { type: "WATCH_HISTORY_REQUIRES_SESSION" },
      });

      const response = await request(app).get("/feed/videos?mode=watched");

      expect(response.status).toBe(401);
    });
  });

  describe("GET /feed/search", () => {
    it("passes the signed-in caller's id as the viewer id", async () => {
      searchVideosService.mockResolvedValue({ rows: [{ id: "video_1" }], total: 1 });

      const response = await request(app).get("/feed/search?query=mecha");

      expect(response.status).toBe(200);
      expect(searchVideosService).toHaveBeenCalledWith({
        query: "mecha",
        page: 1,
        limit: 24,
        viewerUserId: "user_test_caller",
      });
    });

    it("passes null as the viewer id for a signed-out caller", async () => {
      signOut();
      searchVideosService.mockResolvedValue({ rows: [], total: 0 });

      await request(app).get("/feed/search?query=mecha");

      expect(searchVideosService).toHaveBeenCalledWith(expect.objectContaining({ viewerUserId: null }));
    });

    it("rejects a missing query with 422", async () => {
      const response = await request(app).get("/feed/search");

      expect(response.status).toBe(422);
      expect(searchVideosService).not.toHaveBeenCalled();
    });

    it("rejects a blank (whitespace-only) query with 422", async () => {
      const response = await request(app).get("/feed/search?query=%20");

      expect(response.status).toBe(422);
      expect(searchVideosService).not.toHaveBeenCalled();
    });

    it("does not echo a rankSeed — search has no exploration term to pin", async () => {
      searchVideosService.mockResolvedValue({ rows: [], total: 0 });

      const response = await request(app).get("/feed/search?query=mecha");

      expect(response.body.rankSeed).toBeUndefined();
    });
  });
});
