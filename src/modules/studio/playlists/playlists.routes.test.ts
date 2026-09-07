import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for owner-scoped playlist CRUD — previously untested at any tier.
 * Not money/RBAC-related: the property worth pinning here is ownership-probing
 * prevention, per the router's own header comment — a playlist the caller does not own
 * answers 404, never 403, so a foreign playlist id cannot be distinguished from a
 * nonexistent one.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

const createPlaylist = vi.fn<(...args: readonly unknown[]) => unknown>();
const listMyPlaylists = vi.fn<(...args: readonly unknown[]) => unknown>();
const getPlaylist = vi.fn<(...args: readonly unknown[]) => unknown>();
const updatePlaylist = vi.fn<(...args: readonly unknown[]) => unknown>();
const deletePlaylist = vi.fn<(...args: readonly unknown[]) => unknown>();
const replacePlaylistVideos = vi.fn<(...args: readonly unknown[]) => unknown>();
const addVideoToPlaylist = vi.fn<(...args: readonly unknown[]) => unknown>();
const removeVideoFromPlaylist = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/studio/playlists/playlists.service.js", () => ({
  createPlaylist: (...args: readonly unknown[]) => createPlaylist(...args),
  listMyPlaylists: (...args: readonly unknown[]) => listMyPlaylists(...args),
  getPlaylist: (...args: readonly unknown[]) => getPlaylist(...args),
  updatePlaylist: (...args: readonly unknown[]) => updatePlaylist(...args),
  deletePlaylist: (...args: readonly unknown[]) => deletePlaylist(...args),
  replacePlaylistVideos: (...args: readonly unknown[]) => replacePlaylistVideos(...args),
  addVideoToPlaylist: (...args: readonly unknown[]) => addVideoToPlaylist(...args),
  removeVideoFromPlaylist: (...args: readonly unknown[]) => removeVideoFromPlaylist(...args),
}));

/** The real domain-error type name for "playlist not found or not yours" — confirmed
 * from `playlists.service.ts`'s `PlaylistError` union and `studio-error-response.ts`. */
const PLAYLIST_NOT_FOUND = { success: false, error: { type: "PLAYLIST_NOT_FOUND", playlistId: "elsewhere" } };

const PLAYLIST_ROW = { id: "playlist_1", title: "Founder picks", visibility: "private" };

describe("playlists routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signInAs();
    await resetRateLimiters();
  });

  describe("authentication", () => {
    it.each([
      ["get", "/playlists/mine"] as const,
      ["get", "/playlists/playlist_1"] as const,
      ["delete", "/playlists/playlist_1"] as const,
    ])("answers 401 for a signed-out caller on %s %s", async (method, path) => {
      signOut();

      const response = await request(app)[method](path);

      expect(response.status).toBe(401);
      expect(getPlaylist).not.toHaveBeenCalled();
      expect(deletePlaylist).not.toHaveBeenCalled();
      expect(listMyPlaylists).not.toHaveBeenCalled();
    });
  });

  describe("POST /playlists", () => {
    it("creates a playlist and answers 201", async () => {
      createPlaylist.mockResolvedValue({ success: true, value: PLAYLIST_ROW });

      const response = await request(app).post("/playlists").send({ title: "Founder picks" });

      expect(response.status).toBe(201);
      expect(createPlaylist).toHaveBeenCalledWith(
        "user_test_caller",
        expect.objectContaining({ title: "Founder picks", visibility: "private" }),
      );
    });

    it("rejects a missing title with 422", async () => {
      const response = await request(app).post("/playlists").send({ visibility: "public" });

      expect(response.status).toBe(422);
      expect(createPlaylist).not.toHaveBeenCalled();
    });

    it("rejects an unknown field with 422", async () => {
      const response = await request(app).post("/playlists").send({ title: "X", ownerId: "someone-else" });

      expect(response.status).toBe(422);
      expect(createPlaylist).not.toHaveBeenCalled();
    });
  });

  describe("GET /playlists/mine", () => {
    it("lists the caller's playlists with pagination", async () => {
      listMyPlaylists.mockResolvedValue({ rows: [PLAYLIST_ROW], total: 1 });

      const response = await request(app).get("/playlists/mine?page=1&limit=20");

      expect(response.status).toBe(200);
      expect(listMyPlaylists).toHaveBeenCalledWith("user_test_caller", 1, 20, undefined);
      expect(response.body.data).toEqual([PLAYLIST_ROW]);
    });

    it("passes a videoId filter through when present", async () => {
      listMyPlaylists.mockResolvedValue({ rows: [], total: 0 });

      await request(app).get("/playlists/mine?videoId=video_1");

      expect(listMyPlaylists).toHaveBeenCalledWith("user_test_caller", 1, 20, "video_1");
    });

    it("rejects an unknown query key with 422", async () => {
      const response = await request(app).get("/playlists/mine?ownerId=someone-else");

      expect(response.status).toBe(422);
      expect(listMyPlaylists).not.toHaveBeenCalled();
    });
  });

  describe("GET /playlists/:playlistId", () => {
    it("loads a playlist the caller owns", async () => {
      getPlaylist.mockResolvedValue({ success: true, value: PLAYLIST_ROW });

      const response = await request(app).get("/playlists/playlist_1");

      expect(response.status).toBe(200);
      expect(getPlaylist).toHaveBeenCalledWith("user_test_caller", "playlist_1");
      expect(response.body.data).toEqual(PLAYLIST_ROW);
    });

    it("answers 404, not 403, for a foreign or nonexistent playlist id", async () => {
      getPlaylist.mockResolvedValue(PLAYLIST_NOT_FOUND);

      const response = await request(app).get("/playlists/someone-elses-playlist");

      expect(response.status).toBe(404);
    });
  });

  describe("PATCH /playlists/:playlistId", () => {
    it("updates a playlist the caller owns", async () => {
      updatePlaylist.mockResolvedValue({ success: true, value: { ...PLAYLIST_ROW, title: "Renamed" } });

      const response = await request(app).patch("/playlists/playlist_1").send({ title: "Renamed" });

      expect(response.status).toBe(200);
      expect(updatePlaylist).toHaveBeenCalledWith("user_test_caller", "playlist_1", { title: "Renamed" });
    });

    it("does not silently re-assert a default on a partial update", async () => {
      updatePlaylist.mockResolvedValue({ success: true, value: PLAYLIST_ROW });

      await request(app).patch("/playlists/playlist_1").send({ description: "New description" });

      expect(updatePlaylist).toHaveBeenCalledWith("user_test_caller", "playlist_1", {
        description: "New description",
      });
    });

    it("answers 404 for a foreign playlist id", async () => {
      updatePlaylist.mockResolvedValue(PLAYLIST_NOT_FOUND);

      const response = await request(app).patch("/playlists/someone-elses-playlist").send({ title: "X" });

      expect(response.status).toBe(404);
    });

    it("rejects an unknown field with 422", async () => {
      const response = await request(app).patch("/playlists/playlist_1").send({ ownerId: "someone-else" });

      expect(response.status).toBe(422);
      expect(updatePlaylist).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /playlists/:playlistId", () => {
    it("deletes a playlist the caller owns, never the videos in it", async () => {
      deletePlaylist.mockResolvedValue({ success: true, value: { deleted: true } });

      const response = await request(app).delete("/playlists/playlist_1");

      expect(response.status).toBe(200);
      expect(deletePlaylist).toHaveBeenCalledWith("user_test_caller", "playlist_1");
    });

    it("answers 404 for a foreign playlist id", async () => {
      deletePlaylist.mockResolvedValue(PLAYLIST_NOT_FOUND);

      const response = await request(app).delete("/playlists/someone-elses-playlist");

      expect(response.status).toBe(404);
    });
  });

  describe("PUT /playlists/:playlistId/videos", () => {
    const path = "/playlists/playlist_1/videos";

    it("replaces membership and order", async () => {
      replacePlaylistVideos.mockResolvedValue({ success: true, value: { ...PLAYLIST_ROW } });

      const response = await request(app)
        .put(path)
        .send({ videoIds: ["video_1", "video_2"] });

      expect(response.status).toBe(200);
      expect(replacePlaylistVideos).toHaveBeenCalledWith("user_test_caller", "playlist_1", ["video_1", "video_2"]);
    });

    it("answers 404 for a foreign playlist id", async () => {
      replacePlaylistVideos.mockResolvedValue(PLAYLIST_NOT_FOUND);

      const response = await request(app).put("/playlists/someone-elses-playlist/videos").send({ videoIds: [] });

      expect(response.status).toBe(404);
    });

    it("maps VIDEO_NOT_FOUND_FOR_PLAYLIST to 422 with every offending id", async () => {
      replacePlaylistVideos.mockResolvedValue({
        success: false,
        error: { type: "VIDEO_NOT_FOUND_FOR_PLAYLIST", videoIds: ["video_missing"] },
      });

      const response = await request(app)
        .put(path)
        .send({ videoIds: ["video_missing"] });

      expect(response.status).toBe(422);
      expect(response.body.errors).toEqual({ videoIds: ["video_missing"] });
    });

    it("rejects more than 500 video ids with 422", async () => {
      const response = await request(app)
        .put(path)
        .send({ videoIds: Array.from({ length: 501 }, (_unused, index) => `video_${index}`) });

      expect(response.status).toBe(422);
      expect(replacePlaylistVideos).not.toHaveBeenCalled();
    });
  });

  describe("PUT /playlists/:playlistId/videos/:videoId", () => {
    const path = "/playlists/playlist_1/videos/video_1";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).put(path);

      expect(response.status).toBe(401);
      expect(addVideoToPlaylist).not.toHaveBeenCalled();
    });

    it("adds the video and returns the whole playlist", async () => {
      addVideoToPlaylist.mockResolvedValue({ success: true, value: PLAYLIST_ROW });

      const response = await request(app).put(path);

      expect(response.status).toBe(200);
      expect(addVideoToPlaylist).toHaveBeenCalledWith("user_test_caller", "playlist_1", "video_1");
      expect(response.body.data).toEqual(PLAYLIST_ROW);
    });

    it("answers 404 for a foreign playlist id", async () => {
      addVideoToPlaylist.mockResolvedValue(PLAYLIST_NOT_FOUND);

      const response = await request(app).put("/playlists/someone-elses-playlist/videos/video_1");

      expect(response.status).toBe(404);
    });
  });

  describe("DELETE /playlists/:playlistId/videos/:videoId", () => {
    const path = "/playlists/playlist_1/videos/video_1";

    it("removes the video and returns the whole playlist", async () => {
      removeVideoFromPlaylist.mockResolvedValue({ success: true, value: PLAYLIST_ROW });

      const response = await request(app).delete(path);

      expect(response.status).toBe(200);
      expect(removeVideoFromPlaylist).toHaveBeenCalledWith("user_test_caller", "playlist_1", "video_1");
    });

    it("answers 404 for a foreign playlist id", async () => {
      removeVideoFromPlaylist.mockResolvedValue(PLAYLIST_NOT_FOUND);

      const response = await request(app).delete("/playlists/someone-elses-playlist/videos/video_1");

      expect(response.status).toBe(404);
    });
  });
});
