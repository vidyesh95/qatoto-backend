import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for the engagement DEFAULT router (mounted at `/videos`, immediately
 * after the studio router) — previously untested at any behavior tier. A structural test
 * (`engagement.routes.order.test.ts`) already walks the router stacks for declaration
 * order and studio-router non-collision; it makes no HTTP requests and asserts nothing
 * about behavior, so this file does not duplicate it.
 *
 * `videoId` is a `z.uuid()` param (engagement.schemas.ts), unlike `videos.controller.ts`'s
 * raw-param pass-through — a malformed id 422s before any service call here.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

/**
 * `requireIdentifiedUser` guards `like`/`save` here; it hits a real `db` query builder the
 * shared `databaseModuleMock()` can't satisfy, so it is stubbed to a pass-through,
 * following the precedent in `import-intelligence.routes.test.ts`. `not-interested`
 * deliberately does NOT carry this guard (see the route file's own docblock: it moves no
 * counter, so there is nothing to farm) — that absence is asserted below by exercising it
 * signed-in with no further guard mocked.
 */
vi.mock("#src/middleware/require-identified-user.js", () => ({
  requireIdentifiedUser: (_req: unknown, _res: unknown, next: (error?: unknown) => void): void => {
    next();
  },
}));

const recordViewBeacon = vi.fn<(...args: readonly unknown[]) => unknown>();
const recordPlaybackError = vi.fn<(...args: readonly unknown[]) => unknown>();
const setVideoLike = vi.fn<(...args: readonly unknown[]) => unknown>();
const setVideoSave = vi.fn<(...args: readonly unknown[]) => unknown>();
const recordShare = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/home/engagement/video-engagement.service.js", () => ({
  recordViewBeacon: (...args: readonly unknown[]) => recordViewBeacon(...args),
  recordPlaybackError: (...args: readonly unknown[]) => recordPlaybackError(...args),
  setVideoLike: (...args: readonly unknown[]) => setVideoLike(...args),
  setVideoSave: (...args: readonly unknown[]) => setVideoSave(...args),
  recordShare: (...args: readonly unknown[]) => recordShare(...args),
}));

const listVideoComments = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/home/engagement/video-comments.service.js", () => ({
  listVideoComments: (...args: readonly unknown[]) => listVideoComments(...args),
}));

const setVideoNotInterested = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/home/engagement/feed-preferences.service.js", () => ({
  setVideoNotInterested: (...args: readonly unknown[]) => setVideoNotInterested(...args),
}));

const VIDEO_ID = "11111111-1111-4111-8111-111111111111";
const BASE = `/videos/${VIDEO_ID}`;

describe("engagement default router (/videos)", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signInAs();
    await resetRateLimiters();
  });

  describe("POST …/view-beacon — the one unauthenticated write, optional auth", () => {
    const validBody = { positionSeconds: 12.7, reportedDurationSeconds: 600, feedSource: "feed_recommended" };

    it("accepts a beacon from a signed-out viewer, answering 202 with no body", async () => {
      signOut();
      recordViewBeacon.mockResolvedValue({ success: true, value: undefined });

      const response = await request(app).post(`${BASE}/view-beacon`).send(validBody);

      expect(response.status).toBe(202);
      expect(response.body.data).toBeUndefined();
      expect(recordViewBeacon).toHaveBeenCalledWith(
        expect.objectContaining({
          videoId: VIDEO_ID,
          viewerUserId: null,
          feedSource: "feed_recommended",
          positionSeconds: 12,
          reportedDurationSeconds: 600,
        }),
      );
    });

    it("threads the signed-in caller's id through", async () => {
      recordViewBeacon.mockResolvedValue({ success: true, value: undefined });

      await request(app).post(`${BASE}/view-beacon`).send(validBody);

      expect(recordViewBeacon).toHaveBeenCalledWith(expect.objectContaining({ viewerUserId: "user_test_caller" }));
    });

    it("rejects an unknown errorCode-shaped body with 422", async () => {
      const response = await request(app).post(`${BASE}/view-beacon`).send({ positionSeconds: 1 });

      expect(response.status).toBe(422);
      expect(recordViewBeacon).not.toHaveBeenCalled();
    });

    it("maps VIDEO_NOT_FOUND to 404", async () => {
      recordViewBeacon.mockResolvedValue({ success: false, error: { type: "VIDEO_NOT_FOUND" } });

      const response = await request(app).post(`${BASE}/view-beacon`).send(validBody);

      expect(response.status).toBe(404);
    });

    it("rejects a malformed :videoId with 422 before any service call", async () => {
      const response = await request(app).post("/videos/not-a-uuid/view-beacon").send(validBody);

      expect(response.status).toBe(422);
      expect(recordViewBeacon).not.toHaveBeenCalled();
    });
  });

  describe("POST …/playback-error — optional auth", () => {
    it("accepts a report from a signed-out viewer", async () => {
      signOut();
      recordPlaybackError.mockResolvedValue({ success: true, value: undefined });

      const response = await request(app).post(`${BASE}/playback-error`).send({ errorCode: 150 });

      expect(response.status).toBe(202);
      expect(recordPlaybackError).toHaveBeenCalledWith(expect.objectContaining({ videoId: VIDEO_ID, errorCode: 150 }));
    });

    it("rejects an errorCode outside the closed set with 422", async () => {
      const response = await request(app).post(`${BASE}/playback-error`).send({ errorCode: 999 });

      expect(response.status).toBe(422);
      expect(recordPlaybackError).not.toHaveBeenCalled();
    });
  });

  describe("PUT/DELETE …/like — requireAuth + requireIdentifiedUser", () => {
    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).put(`${BASE}/like`);

      expect(response.status).toBe(401);
      expect(setVideoLike).not.toHaveBeenCalled();
    });

    it("likes and returns the resulting count", async () => {
      setVideoLike.mockResolvedValue({ success: true, value: { isSet: true, count: 5 } });

      const response = await request(app).put(`${BASE}/like`);

      expect(response.status).toBe(200);
      expect(setVideoLike).toHaveBeenCalledWith({
        videoId: VIDEO_ID,
        userId: "user_test_caller",
        shouldBeSet: true,
      });
      expect(response.body.data).toEqual({ hasLiked: true, likeCount: 5 });
    });

    it("unlikes with DELETE", async () => {
      setVideoLike.mockResolvedValue({ success: true, value: { isSet: false, count: 4 } });

      const response = await request(app).delete(`${BASE}/like`);

      expect(response.status).toBe(200);
      expect(setVideoLike).toHaveBeenCalledWith({
        videoId: VIDEO_ID,
        userId: "user_test_caller",
        shouldBeSet: false,
      });
    });

    it("maps VIDEO_NOT_FOUND to 404", async () => {
      setVideoLike.mockResolvedValue({ success: false, error: { type: "VIDEO_NOT_FOUND" } });

      const response = await request(app).put(`${BASE}/like`);

      expect(response.status).toBe(404);
    });
  });

  describe("PUT/DELETE …/save", () => {
    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).put(`${BASE}/save`);

      expect(response.status).toBe(401);
      expect(setVideoSave).not.toHaveBeenCalled();
    });

    it("saves and returns the resulting count", async () => {
      setVideoSave.mockResolvedValue({ success: true, value: { isSet: true, count: 2 } });

      const response = await request(app).put(`${BASE}/save`);

      expect(response.status).toBe(200);
      expect(setVideoSave).toHaveBeenCalledWith({
        videoId: VIDEO_ID,
        userId: "user_test_caller",
        shouldBeSet: true,
      });
      expect(response.body.data).toEqual({ hasSaved: true, saveCount: 2 });
    });
  });

  describe("PUT/DELETE …/not-interested — requireAuth only, deliberately no requireIdentifiedUser", () => {
    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).put(`${BASE}/not-interested`);

      expect(response.status).toBe(401);
      expect(setVideoNotInterested).not.toHaveBeenCalled();
    });

    it("marks not-interested for any signed-in caller — the route's own docblock says this write moves no counter, so no identity guard is needed", async () => {
      setVideoNotInterested.mockResolvedValue({ success: true, value: { isSet: true } });

      const response = await request(app).put(`${BASE}/not-interested`);

      expect(response.status).toBe(200);
      expect(setVideoNotInterested).toHaveBeenCalledWith({
        viewerId: "user_test_caller",
        videoId: VIDEO_ID,
        shouldBeSet: true,
      });
    });

    it("unmarks with DELETE", async () => {
      setVideoNotInterested.mockResolvedValue({ success: true, value: { isSet: false } });

      const response = await request(app).delete(`${BASE}/not-interested`);

      expect(response.status).toBe(200);
      expect(setVideoNotInterested).toHaveBeenCalledWith({
        viewerId: "user_test_caller",
        videoId: VIDEO_ID,
        shouldBeSet: false,
      });
    });
  });

  describe("POST …/share — optional auth", () => {
    it("records a share from a signed-out viewer", async () => {
      signOut();
      recordShare.mockResolvedValue({ success: true, value: { shareCount: 10 } });

      const response = await request(app).post(`${BASE}/share`).send({ channel: "copy_link" });

      expect(response.status).toBe(200);
      expect(recordShare).toHaveBeenCalledWith(
        expect.objectContaining({ videoId: VIDEO_ID, userId: null, channel: "copy_link" }),
      );
      expect(response.body.data).toEqual({ shareCount: 10 });
    });

    it("rejects an unknown channel with 422", async () => {
      const response = await request(app).post(`${BASE}/share`).send({ channel: "carrier_pigeon" });

      expect(response.status).toBe(422);
      expect(recordShare).not.toHaveBeenCalled();
    });
  });

  describe("GET …/comments — optional auth, keyset read", () => {
    it("lists comments for a signed-out viewer", async () => {
      signOut();
      listVideoComments.mockResolvedValue({ success: true, value: { rows: [{ id: "comment_1" }], nextCursor: null } });

      const response = await request(app).get(`${BASE}/comments`);

      expect(response.status).toBe(200);
      expect(listVideoComments).toHaveBeenCalledWith(
        expect.objectContaining({ videoId: VIDEO_ID, viewerUserId: null, parentCommentId: null }),
      );
      expect(response.body.data).toEqual([{ id: "comment_1" }]);
      expect(response.body.nextCursor).toBeNull();
    });

    it("rejects an unknown query key with 422", async () => {
      const response = await request(app).get(`${BASE}/comments?sort=top`);

      expect(response.status).toBe(422);
      expect(listVideoComments).not.toHaveBeenCalled();
    });

    it("maps VIDEO_NOT_FOUND to 404", async () => {
      listVideoComments.mockResolvedValue({ success: false, error: { type: "VIDEO_NOT_FOUND" } });

      const response = await request(app).get(`${BASE}/comments`);

      expect(response.status).toBe(404);
    });
  });
});
