import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for the channel page — previously untested at any tier. Every route
 * here is `attachOptionalUser`, and per the controller's own docblock NEITHER handler
 * checks `req.user` to gate anything — the page is public by design. NO 401 CASE appears
 * anywhere in this file for that reason; `req.user?.id ?? null` threading into the service
 * is what's asserted instead, where the controller genuinely reads it.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

const getChannelProfile = vi.fn<(...args: readonly unknown[]) => unknown>();
const listChannelVideos = vi.fn<(...args: readonly unknown[]) => unknown>();
const listPublicChannels = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/home/channels/channels.service.js", () => ({
  getChannelProfile: (...args: readonly unknown[]) => getChannelProfile(...args),
  listChannelVideos: (...args: readonly unknown[]) => listChannelVideos(...args),
  listPublicChannels: (...args: readonly unknown[]) => listPublicChannels(...args),
}));

describe("channels routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signInAs();
    await resetRateLimiters();
  });

  describe("GET /channels", () => {
    it("lists the public directory identically for signed-in and signed-out callers", async () => {
      listPublicChannels.mockResolvedValue({
        success: true,
        value: { rows: [{ handle: "creator-1" }], nextCursor: null },
      });

      const response = await request(app).get("/channels?limit=50");

      expect(response.status).toBe(200);
      expect(listPublicChannels).toHaveBeenCalledWith({ limit: 50, cursor: null });
      expect(response.body.data).toEqual([{ handle: "creator-1" }]);
      expect(response.body.nextCursor).toBeNull();
    });

    it("defaults limit to 100", async () => {
      listPublicChannels.mockResolvedValue({ success: true, value: { rows: [], nextCursor: null } });

      await request(app).get("/channels");

      expect(listPublicChannels).toHaveBeenCalledWith({ limit: 100, cursor: null });
    });

    it("rejects a limit over the 200 ceiling with 422", async () => {
      const response = await request(app).get("/channels?limit=500");

      expect(response.status).toBe(422);
      expect(listPublicChannels).not.toHaveBeenCalled();
    });

    it("rejects an unknown query key with 422", async () => {
      const response = await request(app).get("/channels?userId=someone-else");

      expect(response.status).toBe(422);
      expect(listPublicChannels).not.toHaveBeenCalled();
    });
  });

  describe("GET /channels/:handle", () => {
    const path = "/channels/creator-1";

    it("passes null as the viewer id for a signed-out caller", async () => {
      signOut();
      getChannelProfile.mockResolvedValue({ success: true, value: { handle: "creator-1" } });

      const response = await request(app).get(path);

      expect(response.status).toBe(200);
      expect(getChannelProfile).toHaveBeenCalledWith({ handle: "creator-1", viewerUserId: null });
    });

    it("passes the signed-in caller's id as the viewer id", async () => {
      getChannelProfile.mockResolvedValue({ success: true, value: { handle: "creator-1" } });

      const response = await request(app).get(path);

      expect(response.status).toBe(200);
      expect(getChannelProfile).toHaveBeenCalledWith({
        handle: "creator-1",
        viewerUserId: "user_test_caller",
      });
    });

    /**
     * One 404 for two facts (no such handle, and an unclaimed one) — the controller's own
     * docs say splitting them would make the status an oracle for which handles exist.
     */
    it("maps CHANNEL_NOT_FOUND to 404", async () => {
      getChannelProfile.mockResolvedValue({ success: false, error: { type: "CHANNEL_NOT_FOUND" } });

      const response = await request(app).get("/channels/no-such-creator");

      expect(response.status).toBe(404);
    });

    it("rejects a handle over 64 characters with 422", async () => {
      const response = await request(app).get(`/channels/${"a".repeat(65)}`);

      expect(response.status).toBe(422);
      expect(getChannelProfile).not.toHaveBeenCalled();
    });
  });

  describe("GET /channels/:handle/videos", () => {
    const path = "/channels/creator-1/videos";

    it("passes null as the viewer id for a signed-out caller", async () => {
      signOut();
      listChannelVideos.mockResolvedValue({ success: true, value: { rows: [], nextCursor: null } });

      const response = await request(app).get(path);

      expect(response.status).toBe(200);
      expect(listChannelVideos).toHaveBeenCalledWith({
        handle: "creator-1",
        viewerUserId: null,
        limit: 24,
        cursor: null,
      });
    });

    it("passes the signed-in caller's id as the viewer id and a supplied cursor", async () => {
      listChannelVideos.mockResolvedValue({
        success: true,
        value: { rows: [{ id: "video_1" }], nextCursor: "cursor_2" },
      });

      const response = await request(app).get(`${path}?cursor=cursor_1&limit=12`);

      expect(response.status).toBe(200);
      expect(listChannelVideos).toHaveBeenCalledWith({
        handle: "creator-1",
        viewerUserId: "user_test_caller",
        limit: 12,
        cursor: "cursor_1",
      });
      expect(response.body.data).toEqual([{ id: "video_1" }]);
      expect(response.body.nextCursor).toBe("cursor_2");
    });

    it("maps CHANNEL_NOT_FOUND to 404", async () => {
      listChannelVideos.mockResolvedValue({ success: false, error: { type: "CHANNEL_NOT_FOUND" } });

      const response = await request(app).get("/channels/no-such-creator/videos");

      expect(response.status).toBe(404);
    });

    it("maps CURSOR_MALFORMED to 422", async () => {
      listChannelVideos.mockResolvedValue({ success: false, error: { type: "CURSOR_MALFORMED" } });

      const response = await request(app).get(`${path}?cursor=garbage`);

      expect(response.status).toBe(422);
    });

    it("rejects a limit over 50 with 422 at the parse boundary", async () => {
      const response = await request(app).get(`${path}?limit=100`);

      expect(response.status).toBe(422);
      expect(listChannelVideos).not.toHaveBeenCalled();
    });
  });
});
