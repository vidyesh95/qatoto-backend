import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for the `/blueprints` hero carousel — previously untested at any
 * tier. `manage_promotions` is checked INSIDE the service (never route middleware), so
 * every 403 case here is a mocked domain error, matching the platform-roles/compensation
 * pattern established this session.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

const listActiveBlueprintHeroSlides = vi.fn<(...args: readonly unknown[]) => unknown>();
const listBlueprintHeroSlidesForStaff = vi.fn<(...args: readonly unknown[]) => unknown>();
const createBlueprintHeroSlide = vi.fn<(...args: readonly unknown[]) => unknown>();
const updateBlueprintHeroSlide = vi.fn<(...args: readonly unknown[]) => unknown>();
const replaceBlueprintHeroSlideImage = vi.fn<(...args: readonly unknown[]) => unknown>();
const reorderBlueprintHeroSlides = vi.fn<(...args: readonly unknown[]) => unknown>();
const deleteBlueprintHeroSlide = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/home/blueprints/blueprint-hero.service.js", () => ({
  MAX_BLUEPRINT_HERO_SLIDES: 8,
  listActiveBlueprintHeroSlides: (...args: readonly unknown[]) => listActiveBlueprintHeroSlides(...args),
  listBlueprintHeroSlidesForStaff: (...args: readonly unknown[]) => listBlueprintHeroSlidesForStaff(...args),
  createBlueprintHeroSlide: (...args: readonly unknown[]) => createBlueprintHeroSlide(...args),
  updateBlueprintHeroSlide: (...args: readonly unknown[]) => updateBlueprintHeroSlide(...args),
  replaceBlueprintHeroSlideImage: (...args: readonly unknown[]) => replaceBlueprintHeroSlideImage(...args),
  reorderBlueprintHeroSlides: (...args: readonly unknown[]) => reorderBlueprintHeroSlides(...args),
  deleteBlueprintHeroSlide: (...args: readonly unknown[]) => deleteBlueprintHeroSlide(...args),
}));

const CAPABILITY_REQUIRED = { success: false, error: { type: "PLATFORM_CAPABILITY_REQUIRED" } } as const;

/** A real PNG signature, so the controller's decoded-byte check has something to pass. */
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
    "01f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082",
  "hex",
);

describe("blueprints routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signInAs();
    await resetRateLimiters();
  });

  describe("GET /blueprints/hero-slides — public", () => {
    it("renders for a signed-out visitor, no 401", async () => {
      signOut();
      listActiveBlueprintHeroSlides.mockResolvedValue([{ id: "slide_1", title: "Solar cold storage" }]);

      const response = await request(app).get("/blueprints/hero-slides");

      expect(response.status).toBe(200);
      expect(response.body.data.slides).toEqual([{ id: "slide_1", title: "Solar cold storage" }]);
    });
  });

  describe("GET /blueprints/admin/hero-slides", () => {
    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).get("/blueprints/admin/hero-slides");

      expect(response.status).toBe(401);
      expect(listBlueprintHeroSlidesForStaff).not.toHaveBeenCalled();
    });

    it("requires manage_promotions", async () => {
      listBlueprintHeroSlidesForStaff.mockResolvedValue(CAPABILITY_REQUIRED);

      const response = await request(app).get("/blueprints/admin/hero-slides");

      expect(response.status).toBe(403);
    });

    it("lists every stored slide", async () => {
      listBlueprintHeroSlidesForStaff.mockResolvedValue({
        success: true,
        value: [{ id: "slide_1", title: "Solar cold storage", isActive: true }],
      });

      const response = await request(app).get("/blueprints/admin/hero-slides");

      expect(response.status).toBe(200);
      expect(listBlueprintHeroSlidesForStaff).toHaveBeenCalledWith("user_test_caller");
      expect(response.body.data.slides).toEqual([{ id: "slide_1", title: "Solar cold storage", isActive: true }]);
    });
  });

  describe("POST /blueprints/admin/hero-slides — multipart create", () => {
    const path = "/blueprints/admin/hero-slides";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app)
        .post(path)
        .field("title", "Solar cold storage")
        .attach("image", PNG_BYTES, { filename: "hero.png", contentType: "image/png" });

      expect(response.status).toBe(401);
      expect(createBlueprintHeroSlide).not.toHaveBeenCalled();
    });

    it("requires an image file", async () => {
      const response = await request(app).post(path).field("title", "Solar cold storage");

      expect(response.status).toBe(422);
      expect(createBlueprintHeroSlide).not.toHaveBeenCalled();
    });

    it("creates the slide with the uploaded image buffer", async () => {
      createBlueprintHeroSlide.mockResolvedValue({
        success: true,
        value: { id: "slide_1", title: "Solar cold storage" },
      });

      const response = await request(app)
        .post(path)
        .field("title", "Solar cold storage")
        .field("isActive", "true")
        .attach("image", PNG_BYTES, { filename: "hero.png", contentType: "image/png" });

      expect(response.status).toBe(201);
      expect(createBlueprintHeroSlide).toHaveBeenCalledWith(
        "user_test_caller",
        expect.objectContaining({ title: "Solar cold storage", isActive: true }),
        expect.any(Buffer),
      );
    });

    it("rejects a file over the 5 MB cap with 413", async () => {
      const oversized = Buffer.concat([PNG_BYTES, Buffer.alloc(5 * 1024 * 1024)]);

      const response = await request(app)
        .post(path)
        .field("title", "Solar cold storage")
        .attach("image", oversized, { filename: "hero.png", contentType: "image/png" });

      expect(response.status).toBe(413);
      expect(createBlueprintHeroSlide).not.toHaveBeenCalled();
    });

    it("rejects a non-image content type with 422", async () => {
      const response = await request(app)
        .post(path)
        .field("title", "Solar cold storage")
        .attach("image", Buffer.from("not an image"), { filename: "hero.txt", contentType: "text/plain" });

      expect(response.status).toBe(422);
      expect(createBlueprintHeroSlide).not.toHaveBeenCalled();
    });

    it("maps ANIME_HERO_SLIDE_LIMIT_REACHED to 409", async () => {
      createBlueprintHeroSlide.mockResolvedValue({
        success: false,
        error: { type: "ANIME_HERO_SLIDE_LIMIT_REACHED", limit: 8 },
      });

      const response = await request(app)
        .post(path)
        .field("title", "Solar cold storage")
        .attach("image", PNG_BYTES, { filename: "hero.png", contentType: "image/png" });

      expect(response.status).toBe(409);
    });
  });

  describe("PATCH /blueprints/admin/hero-slides/reorder", () => {
    const path = "/blueprints/admin/hero-slides/reorder";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app)
        .patch(path)
        .send({ slideIds: ["slide_1", "slide_2"] });

      expect(response.status).toBe(401);
      expect(reorderBlueprintHeroSlides).not.toHaveBeenCalled();
    });

    it("reorders with the full permutation", async () => {
      reorderBlueprintHeroSlides.mockResolvedValue({
        success: true,
        value: [{ id: "slide_2" }, { id: "slide_1" }],
      });

      const response = await request(app)
        .patch(path)
        .send({ slideIds: ["slide_2", "slide_1"] });

      expect(response.status).toBe(200);
      expect(reorderBlueprintHeroSlides).toHaveBeenCalledWith("user_test_caller", ["slide_2", "slide_1"]);
    });

    it("rejects an empty slideIds array with 422", async () => {
      const response = await request(app).patch(path).send({ slideIds: [] });

      expect(response.status).toBe(422);
      expect(reorderBlueprintHeroSlides).not.toHaveBeenCalled();
    });

    it("maps ANIME_HERO_SLIDE_ORDER_MISMATCH to 422", async () => {
      reorderBlueprintHeroSlides.mockResolvedValue({
        success: false,
        error: { type: "ANIME_HERO_SLIDE_ORDER_MISMATCH" },
      });

      const response = await request(app)
        .patch(path)
        .send({ slideIds: ["slide_stale"] });

      expect(response.status).toBe(422);
    });

    /**
     * This is the route-order hazard the earlier audit flagged: if `/reorder` were ever
     * declared below `/:slideId`, this request would be captured as an update to a slide
     * literally named "reorder" instead. Proven here by asserting the reorder service, not
     * the update service, was called.
     */
    it("is not captured by the /:slideId route", async () => {
      reorderBlueprintHeroSlides.mockResolvedValue({ success: true, value: [] });

      await request(app)
        .patch(path)
        .send({ slideIds: ["slide_1"] });

      expect(updateBlueprintHeroSlide).not.toHaveBeenCalled();
    });
  });

  describe("PATCH /blueprints/admin/hero-slides/:slideId", () => {
    const path = "/blueprints/admin/hero-slides/slide_1";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).patch(path).send({ title: "Updated title" });

      expect(response.status).toBe(401);
      expect(updateBlueprintHeroSlide).not.toHaveBeenCalled();
    });

    it("updates the metadata", async () => {
      updateBlueprintHeroSlide.mockResolvedValue({ success: true, value: { id: "slide_1", title: "Updated title" } });

      const response = await request(app).patch(path).send({ title: "Updated title" });

      expect(response.status).toBe(200);
      expect(updateBlueprintHeroSlide).toHaveBeenCalledWith(
        "user_test_caller",
        "slide_1",
        expect.objectContaining({ title: "Updated title" }),
      );
    });

    it("rejects an empty patch with 422", async () => {
      const response = await request(app).patch(path).send({});

      expect(response.status).toBe(422);
      expect(updateBlueprintHeroSlide).not.toHaveBeenCalled();
    });

    it("rejects a server-owned field like position with 422", async () => {
      const response = await request(app).patch(path).send({ position: 1 });

      expect(response.status).toBe(422);
      expect(updateBlueprintHeroSlide).not.toHaveBeenCalled();
    });

    it("maps ANIME_HERO_SLIDE_NOT_FOUND to 404", async () => {
      updateBlueprintHeroSlide.mockResolvedValue({
        success: false,
        error: { type: "ANIME_HERO_SLIDE_NOT_FOUND" },
      });

      const response = await request(app).patch(path).send({ title: "Updated title" });

      expect(response.status).toBe(404);
    });

    it("maps ANIME_HERO_SLIDE_WINDOW_INVALID to 422", async () => {
      updateBlueprintHeroSlide.mockResolvedValue({
        success: false,
        error: { type: "ANIME_HERO_SLIDE_WINDOW_INVALID" },
      });

      const response = await request(app)
        .patch(path)
        .send({ startsAt: "2026-06-01T00:00:00.000Z", endsAt: "2026-01-01T00:00:00.000Z" });

      expect(response.status).toBe(422);
    });
  });

  describe("PATCH /blueprints/admin/hero-slides/:slideId/image — multipart replace", () => {
    const path = "/blueprints/admin/hero-slides/slide_1/image";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app)
        .patch(path)
        .attach("image", PNG_BYTES, { filename: "hero.png", contentType: "image/png" });

      expect(response.status).toBe(401);
      expect(replaceBlueprintHeroSlideImage).not.toHaveBeenCalled();
    });

    it("requires an image file", async () => {
      const response = await request(app).patch(path);

      expect(response.status).toBe(422);
      expect(replaceBlueprintHeroSlideImage).not.toHaveBeenCalled();
    });

    it("replaces the image and answers 200", async () => {
      replaceBlueprintHeroSlideImage.mockResolvedValue({
        success: true,
        value: { id: "slide_1", imageUrl: "https://cdn.example.test/hero.png" },
      });

      const response = await request(app)
        .patch(path)
        .attach("image", PNG_BYTES, { filename: "hero.png", contentType: "image/png" });

      expect(response.status).toBe(200);
      expect(replaceBlueprintHeroSlideImage).toHaveBeenCalledWith("user_test_caller", "slide_1", expect.any(Buffer));
    });

    it("maps UNSUPPORTED_FORMAT to 422", async () => {
      const response = await request(app)
        .patch(path)
        .attach("image", Buffer.from("not an image"), { filename: "hero.txt", contentType: "text/plain" });

      expect(response.status).toBe(422);
      expect(replaceBlueprintHeroSlideImage).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /blueprints/admin/hero-slides/:slideId", () => {
    const path = "/blueprints/admin/hero-slides/slide_1";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).delete(path);

      expect(response.status).toBe(401);
      expect(deleteBlueprintHeroSlide).not.toHaveBeenCalled();
    });

    it("deletes the slide", async () => {
      deleteBlueprintHeroSlide.mockResolvedValue({ success: true, value: { id: "slide_1" } });

      const response = await request(app).delete(path);

      expect(response.status).toBe(200);
      expect(deleteBlueprintHeroSlide).toHaveBeenCalledWith("user_test_caller", "slide_1");
    });

    it("maps ANIME_HERO_SLIDE_NOT_FOUND to 404", async () => {
      deleteBlueprintHeroSlide.mockResolvedValue({
        success: false,
        error: { type: "ANIME_HERO_SLIDE_NOT_FOUND" },
      });

      const response = await request(app).delete(path);

      expect(response.status).toBe(404);
    });
  });
});
