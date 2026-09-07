import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for the rest of the `/users/me/*` family mounted on `users.routes.ts`:
 * the engagement-domain self-reads (watch-time, muted-creators, not-interested-videos,
 * liked/saved-videos, subscriptions, video-comments), the caller's own profile-report
 * history, and the Privacy Part 3 deletion/export routes. Previously zero coverage above
 * pure schema/service unit tests.
 *
 * `DATA_EXPORT_ENABLED` is turned on for this whole file so `POST /me/export`'s real
 * success/error paths are exercisable — otherwise every attempt would hit the door-gated
 * 503 before ever reaching the service, per `privacy.controller.ts`'s own comment.
 */

stubServerEnvironment({ DATA_EXPORT_ENABLED: "true" });

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

/**
 * `POST /me/export` carries `requireIdentifiedUser`, which hits a real `db` query builder
 * the shared `databaseModuleMock()` can't satisfy — stubbed to a pass-through, following
 * the precedent in `src/modules/rnd/import-intelligence/import-intelligence.routes.test.ts`.
 */
vi.mock("#src/middleware/require-identified-user.js", () => ({
  requireIdentifiedUser: (_req: unknown, _res: unknown, next: (error?: unknown) => void): void => {
    next();
  },
}));

const getViewerWatchTime = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/home/engagement/watch-time.service.js", () => ({
  getViewerWatchTime: (...args: readonly unknown[]) => getViewerWatchTime(...args),
}));

const listMutedCreators = vi.fn<(...args: readonly unknown[]) => unknown>();
const listNotInterestedVideos = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/home/engagement/feed-preferences.service.js", () => ({
  listMutedCreators: (...args: readonly unknown[]) => listMutedCreators(...args),
  listNotInterestedVideos: (...args: readonly unknown[]) => listNotInterestedVideos(...args),
}));

const listCreatorInboxComments = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/home/engagement/video-comments.service.js", () => ({
  listCreatorInboxComments: (...args: readonly unknown[]) => listCreatorInboxComments(...args),
}));

const listLikedVideos = vi.fn<(...args: readonly unknown[]) => unknown>();
const listSavedVideos = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/home/engagement/video-engagement.service.js", () => ({
  listLikedVideos: (...args: readonly unknown[]) => listLikedVideos(...args),
  listSavedVideos: (...args: readonly unknown[]) => listSavedVideos(...args),
}));

const listMySubscriptions = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/home/engagement/creator-subscriptions.service.js", () => ({
  listMySubscriptions: (...args: readonly unknown[]) => listMySubscriptions(...args),
}));

const listMyProfileReports = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/auth/users/user-reports.service.js", () => ({
  listMyProfileReports: (...args: readonly unknown[]) => listMyProfileReports(...args),
}));

const requestAccountDeletion = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/auth/privacy/account-deletion.service.js", () => ({
  requestAccountDeletion: (...args: readonly unknown[]) => requestAccountDeletion(...args),
}));

const requestDataExport = vi.fn<(...args: readonly unknown[]) => unknown>();
const readLatestDataExport = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/auth/privacy/data-export.service.js", () => ({
  requestDataExport: (...args: readonly unknown[]) => requestDataExport(...args),
  readLatestDataExport: (...args: readonly unknown[]) => readLatestDataExport(...args),
}));

const EMPTY_PAGE = { rows: [], nextCursor: null };

describe("users privacy and self-read routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signInAs();
    await resetRateLimiters();
  });

  describe("GET /users/me/watch-time", () => {
    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).get("/users/me/watch-time");

      expect(response.status).toBe(401);
      expect(getViewerWatchTime).not.toHaveBeenCalled();
    });

    it("returns the caller's own watch time, derived from the session", async () => {
      getViewerWatchTime.mockResolvedValue({ today: 0, thisWeek: 0, thisMonth: 0, thisYear: 0, series: [], hours: [] });

      const response = await request(app).get("/users/me/watch-time?timeZone=America/New_York");

      expect(response.status).toBe(200);
      expect(getViewerWatchTime).toHaveBeenCalledWith("user_test_caller", "America/New_York");
    });

    it("rejects an unrecognized time zone with 422", async () => {
      const response = await request(app).get("/users/me/watch-time?timeZone=Not/AZone");

      expect(response.status).toBe(422);
      expect(getViewerWatchTime).not.toHaveBeenCalled();
    });
  });

  describe("GET /users/me/muted-creators", () => {
    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).get("/users/me/muted-creators");

      expect(response.status).toBe(401);
    });

    it("lists the caller's muted creators, unpaginated", async () => {
      listMutedCreators.mockResolvedValue([{ creatorId: "creator_1" }]);

      const response = await request(app).get("/users/me/muted-creators");

      expect(response.status).toBe(200);
      expect(listMutedCreators).toHaveBeenCalledWith("user_test_caller");
      expect(response.body.data).toEqual([{ creatorId: "creator_1" }]);
    });
  });

  describe("GET /users/me/not-interested-videos", () => {
    it("paginates with limit/cursor and rejects a malformed cursor", async () => {
      listNotInterestedVideos.mockResolvedValue({ success: true, value: EMPTY_PAGE });

      const ok = await request(app).get("/users/me/not-interested-videos?limit=10");
      expect(ok.status).toBe(200);
      expect(listNotInterestedVideos).toHaveBeenCalledWith({
        viewerId: "user_test_caller",
        limit: 10,
        cursor: null,
      });

      const bad = await request(app).get("/users/me/not-interested-videos?limit=0");
      expect(bad.status).toBe(422);
    });
  });

  describe("GET /users/me/profile-reports", () => {
    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).get("/users/me/profile-reports");

      expect(response.status).toBe(401);
    });

    it("returns the caller's own profile-report history and nothing about who decided it", async () => {
      listMyProfileReports.mockResolvedValue([{ id: "report_1", status: "resolved" }]);

      const response = await request(app).get("/users/me/profile-reports");

      expect(response.status).toBe(200);
      expect(listMyProfileReports).toHaveBeenCalledWith("user_test_caller");
      expect(response.body.data).toEqual([{ id: "report_1", status: "resolved" }]);
    });
  });

  describe("GET /users/me/liked-videos, /saved-videos, /subscriptions", () => {
    it("liked-videos: keyset-paginated, service-scoped by session id", async () => {
      listLikedVideos.mockResolvedValue({ success: true, value: EMPTY_PAGE });

      const response = await request(app).get("/users/me/liked-videos");

      expect(response.status).toBe(200);
      expect(listLikedVideos).toHaveBeenCalledWith({ userId: "user_test_caller", limit: 20, cursor: null });
    });

    it("saved-videos: keyset-paginated, service-scoped by session id", async () => {
      listSavedVideos.mockResolvedValue({ success: true, value: EMPTY_PAGE });

      const response = await request(app).get("/users/me/saved-videos");

      expect(response.status).toBe(200);
      expect(listSavedVideos).toHaveBeenCalledWith({ userId: "user_test_caller", limit: 20, cursor: null });
    });

    it("subscriptions: the session id becomes subscriberId, not userId", async () => {
      listMySubscriptions.mockResolvedValue({ success: true, value: EMPTY_PAGE });

      const response = await request(app).get("/users/me/subscriptions");

      expect(response.status).toBe(200);
      expect(listMySubscriptions).toHaveBeenCalledWith({
        subscriberId: "user_test_caller",
        limit: 20,
        cursor: null,
      });
    });

    it("rejects an unknown query key on any of the three with 422", async () => {
      const response = await request(app).get("/users/me/liked-videos?userId=someone-else");

      expect(response.status).toBe(422);
      expect(listLikedVideos).not.toHaveBeenCalled();
    });
  });

  describe("GET /users/me/video-comments", () => {
    it("lists comments across every video the caller owns", async () => {
      listCreatorInboxComments.mockResolvedValue({ success: true, value: EMPTY_PAGE });

      const response = await request(app).get("/users/me/video-comments");

      expect(response.status).toBe(200);
      expect(listCreatorInboxComments).toHaveBeenCalledWith({
        creatorUserId: "user_test_caller",
        limit: 20,
        cursor: null,
      });
    });
  });

  describe("POST /users/me/deletion-request", () => {
    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).post("/users/me/deletion-request");

      expect(response.status).toBe(401);
      expect(requestAccountDeletion).not.toHaveBeenCalled();
    });

    it("deactivates the account now and answers 200 (synchronous, not a receipt)", async () => {
      requestAccountDeletion.mockResolvedValue({
        success: true,
        value: { scheduledPurgeAt: "2026-07-01T00:00:00.000Z" },
      });

      const response = await request(app).post("/users/me/deletion-request");

      expect(response.status).toBe(200);
      expect(requestAccountDeletion).toHaveBeenCalledWith("user_test_caller");
    });

    it("maps STAFF_ACCOUNT to 403 — staff close their account by operator, not from Settings", async () => {
      requestAccountDeletion.mockResolvedValue({ success: false, error: { type: "STAFF_ACCOUNT" } });

      const response = await request(app).post("/users/me/deletion-request");

      expect(response.status).toBe(403);
    });

    it("maps REQUEST_ALREADY_ACTIVE to 409, never a 200 with the existing row", async () => {
      requestAccountDeletion.mockResolvedValue({ success: false, error: { type: "REQUEST_ALREADY_ACTIVE" } });

      const response = await request(app).post("/users/me/deletion-request");

      expect(response.status).toBe(409);
    });
  });

  describe("POST /users/me/export", () => {
    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).post("/users/me/export");

      expect(response.status).toBe(401);
      expect(requestDataExport).not.toHaveBeenCalled();
    });

    it("accepts the request and answers 202 — a receipt, never a file", async () => {
      requestDataExport.mockResolvedValue({ success: true, value: { id: "export_1", state: "pending" } });

      const response = await request(app).post("/users/me/export");

      expect(response.status).toBe(202);
      expect(requestDataExport).toHaveBeenCalledWith("user_test_caller");
      expect(response.body.data.state).toBe("pending");
    });

    it("maps EXPORT_ALREADY_IN_FLIGHT to 409", async () => {
      requestDataExport.mockResolvedValue({ success: false, error: { type: "EXPORT_ALREADY_IN_FLIGHT" } });

      const response = await request(app).post("/users/me/export");

      expect(response.status).toBe(409);
    });
  });

  describe("GET /users/me/export", () => {
    it("answers 200 with data: null when nothing has ever been requested, never a 404", async () => {
      readLatestDataExport.mockResolvedValue(null);

      const response = await request(app).get("/users/me/export");

      expect(response.status).toBe(200);
      expect(response.body.data).toBeNull();
      expect(response.body.message).toBe("No export has been requested.");
    });

    it("returns the latest export status", async () => {
      readLatestDataExport.mockResolvedValue({
        id: "export_1",
        state: "ready",
        downloadUrl: "https://cdn.example.test/x",
      });

      const response = await request(app).get("/users/me/export");

      expect(response.status).toBe(200);
      expect(readLatestDataExport).toHaveBeenCalledWith("user_test_caller");
      expect(response.body.data.state).toBe("ready");
    });
  });
});
