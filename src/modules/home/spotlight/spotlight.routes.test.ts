import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for the home-page Spotlight rail — previously untested at any tier.
 * `GET /spotlight/videos` is deliberately BARE (no auth, no limiter — see the routes
 * file's own docblock), so it gets no 401 case; the two `/admin/slots` routes are staff
 * writes gated by a service-level `manage_promotions` capability check, not middleware.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

const listActiveSpotlightVideos = vi.fn<(...args: readonly unknown[]) => unknown>();
const listSpotlightSlotsForStaff = vi.fn<(...args: readonly unknown[]) => unknown>();
const replaceSpotlightSlots = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/home/spotlight/spotlight.service.js", () => ({
  listActiveSpotlightVideos: (...args: readonly unknown[]) => listActiveSpotlightVideos(...args),
  listSpotlightSlotsForStaff: (...args: readonly unknown[]) => listSpotlightSlotsForStaff(...args),
  replaceSpotlightSlots: (...args: readonly unknown[]) => replaceSpotlightSlots(...args),
  MAX_SPOTLIGHT_SLOTS: 3,
}));

const CAPABILITY_REQUIRED = { success: false, error: { type: "PLATFORM_CAPABILITY_REQUIRED" } } as const;

describe("spotlight routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signInAs();
    await resetRateLimiters();
  });

  describe("GET /spotlight/videos", () => {
    /**
     * No 401 case here — the route carries no `requireAuth`/`attachOptionalUser` at all
     * (confirmed in `spotlight.routes.ts`'s own docblock: the payload is identical for
     * every visitor, so there is no session to check).
     */
    it("returns the eligible, ordered slots for a signed-out visitor", async () => {
      signOut();
      listActiveSpotlightVideos.mockResolvedValue([{ videoId: "video_1", position: 1 }]);

      const response = await request(app).get("/spotlight/videos");

      expect(response.status).toBe(200);
      expect(listActiveSpotlightVideos).toHaveBeenCalledWith();
      expect(response.body.data.videos).toEqual([{ videoId: "video_1", position: 1 }]);
    });
  });

  describe("GET /spotlight/admin/slots", () => {
    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).get("/spotlight/admin/slots");

      expect(response.status).toBe(401);
      expect(listSpotlightSlotsForStaff).not.toHaveBeenCalled();
    });

    it("requires manage_promotions", async () => {
      listSpotlightSlotsForStaff.mockResolvedValue(CAPABILITY_REQUIRED);

      const response = await request(app).get("/spotlight/admin/slots");

      expect(response.status).toBe(403);
    });

    it("lists every stored slot", async () => {
      listSpotlightSlotsForStaff.mockResolvedValue({
        success: true,
        value: [{ videoId: "video_1", position: 1 }],
      });

      const response = await request(app).get("/spotlight/admin/slots");

      expect(response.status).toBe(200);
      expect(listSpotlightSlotsForStaff).toHaveBeenCalledWith("user_test_caller");
      expect(response.body.data.slots).toEqual([{ videoId: "video_1", position: 1 }]);
    });
  });

  describe("PUT /spotlight/admin/slots", () => {
    const path = "/spotlight/admin/slots";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app)
        .put(path)
        .send({ videoIds: ["video_1"] });

      expect(response.status).toBe(401);
      expect(replaceSpotlightSlots).not.toHaveBeenCalled();
    });

    it("requires manage_promotions", async () => {
      replaceSpotlightSlots.mockResolvedValue(CAPABILITY_REQUIRED);

      const response = await request(app)
        .put(path)
        .send({ videoIds: ["video_1"] });

      expect(response.status).toBe(403);
    });

    it("replaces the whole ordered set", async () => {
      replaceSpotlightSlots.mockResolvedValue({
        success: true,
        value: [{ videoId: "video_1", position: 1 }],
      });

      const response = await request(app)
        .put(path)
        .send({ videoIds: ["video_1"] });

      expect(response.status).toBe(200);
      expect(replaceSpotlightSlots).toHaveBeenCalledWith("user_test_caller", ["video_1"]);
    });

    it("clears the rail with an empty array", async () => {
      replaceSpotlightSlots.mockResolvedValue({ success: true, value: [] });

      const response = await request(app).put(path).send({ videoIds: [] });

      expect(response.status).toBe(200);
      expect(replaceSpotlightSlots).toHaveBeenCalledWith("user_test_caller", []);
    });

    it("rejects more than MAX_SPOTLIGHT_SLOTS ids with 422", async () => {
      const response = await request(app)
        .put(path)
        .send({ videoIds: ["video_1", "video_2", "video_3", "video_4"] });

      expect(response.status).toBe(422);
      expect(replaceSpotlightSlots).not.toHaveBeenCalled();
    });

    it("rejects an unknown body field with 422", async () => {
      const response = await request(app)
        .put(path)
        .send({ videoIds: ["video_1"], reorder: true });

      expect(response.status).toBe(422);
      expect(replaceSpotlightSlots).not.toHaveBeenCalled();
    });

    it("maps SPOTLIGHT_DUPLICATE_VIDEO to 422", async () => {
      replaceSpotlightSlots.mockResolvedValue({
        success: false,
        error: { type: "SPOTLIGHT_DUPLICATE_VIDEO", videoId: "video_1" },
      });

      const response = await request(app)
        .put(path)
        .send({ videoIds: ["video_1", "video_1"] });

      expect(response.status).toBe(422);
    });

    it("maps SPOTLIGHT_VIDEO_NOT_ELIGIBLE to 422", async () => {
      replaceSpotlightSlots.mockResolvedValue({
        success: false,
        error: { type: "SPOTLIGHT_VIDEO_NOT_ELIGIBLE", videoId: "video_unpublished" },
      });

      const response = await request(app)
        .put(path)
        .send({ videoIds: ["video_unpublished"] });

      expect(response.status).toBe(422);
    });
  });
});
