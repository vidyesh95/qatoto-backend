import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for the `/promotions` home-page carousel — previously untested at any
 * tier. Same shape as `blueprints.routes.test.ts`: `manage_promotions` is checked INSIDE
 * the service (never route middleware), so every 403 case here is a mocked domain error.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

const listActivePromotionalSlides = vi.fn<(...args: readonly unknown[]) => unknown>();
const listPromotionalSlidesForStaff = vi.fn<(...args: readonly unknown[]) => unknown>();
const createPromotionalSlide = vi.fn<(...args: readonly unknown[]) => unknown>();
const updatePromotionalSlide = vi.fn<(...args: readonly unknown[]) => unknown>();
const replacePromotionalSlideImage = vi.fn<(...args: readonly unknown[]) => unknown>();
const reorderPromotionalSlides = vi.fn<(...args: readonly unknown[]) => unknown>();
const deletePromotionalSlide = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/home/promotions/promotions.service.js", () => ({
  MAX_PROMOTIONAL_SLIDES: 8,
  listActivePromotionalSlides: (...args: readonly unknown[]) => listActivePromotionalSlides(...args),
  listPromotionalSlidesForStaff: (...args: readonly unknown[]) => listPromotionalSlidesForStaff(...args),
  createPromotionalSlide: (...args: readonly unknown[]) => createPromotionalSlide(...args),
  updatePromotionalSlide: (...args: readonly unknown[]) => updatePromotionalSlide(...args),
  replacePromotionalSlideImage: (...args: readonly unknown[]) => replacePromotionalSlideImage(...args),
  reorderPromotionalSlides: (...args: readonly unknown[]) => reorderPromotionalSlides(...args),
  deletePromotionalSlide: (...args: readonly unknown[]) => deletePromotionalSlide(...args),
}));

const CAPABILITY_REQUIRED = { success: false, error: { type: "PLATFORM_CAPABILITY_REQUIRED" } } as const;

/** A real PNG signature, so the controller's decoded-byte check has something to pass. */
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
    "01f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082",
  "hex",
);

describe("promotions routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signInAs();
    await resetRateLimiters();
  });

  describe("GET /promotions/slides — public", () => {
    it("renders for a signed-out visitor, no 401", async () => {
      signOut();
      listActivePromotionalSlides.mockResolvedValue([{ id: "slide_1", altText: "Sourcing sale" }]);

      const response = await request(app).get("/promotions/slides");

      expect(response.status).toBe(200);
      expect(response.body.data.slides).toEqual([{ id: "slide_1", altText: "Sourcing sale" }]);
    });
  });

  describe("GET /promotions/admin/slides", () => {
    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).get("/promotions/admin/slides");

      expect(response.status).toBe(401);
      expect(listPromotionalSlidesForStaff).not.toHaveBeenCalled();
    });

    it("requires manage_promotions", async () => {
      listPromotionalSlidesForStaff.mockResolvedValue(CAPABILITY_REQUIRED);

      const response = await request(app).get("/promotions/admin/slides");

      expect(response.status).toBe(403);
    });

    it("lists every stored slide", async () => {
      listPromotionalSlidesForStaff.mockResolvedValue({
        success: true,
        value: [{ id: "slide_1", altText: "Sourcing sale", isActive: true }],
      });

      const response = await request(app).get("/promotions/admin/slides");

      expect(response.status).toBe(200);
      expect(listPromotionalSlidesForStaff).toHaveBeenCalledWith("user_test_caller");
      expect(response.body.data.slides).toEqual([{ id: "slide_1", altText: "Sourcing sale", isActive: true }]);
    });
  });

  describe("POST /promotions/admin/slides — multipart create", () => {
    const path = "/promotions/admin/slides";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app)
        .post(path)
        .field("altText", "Sourcing sale")
        .field("destinationKind", "internal_path")
        .field("destinationValue", "/store")
        .attach("image", PNG_BYTES, { filename: "slide.png", contentType: "image/png" });

      expect(response.status).toBe(401);
      expect(createPromotionalSlide).not.toHaveBeenCalled();
    });

    it("requires an image file", async () => {
      const response = await request(app)
        .post(path)
        .field("altText", "Sourcing sale")
        .field("destinationKind", "internal_path")
        .field("destinationValue", "/store");

      expect(response.status).toBe(422);
      expect(createPromotionalSlide).not.toHaveBeenCalled();
    });

    it("creates the slide with the uploaded image buffer", async () => {
      createPromotionalSlide.mockResolvedValue({
        success: true,
        value: { id: "slide_1", altText: "Sourcing sale" },
      });

      const response = await request(app)
        .post(path)
        .field("altText", "Sourcing sale")
        .field("destinationKind", "internal_path")
        .field("destinationValue", "/store")
        .field("isActive", "true")
        .attach("image", PNG_BYTES, { filename: "slide.png", contentType: "image/png" });

      expect(response.status).toBe(201);
      expect(createPromotionalSlide).toHaveBeenCalledWith(
        "user_test_caller",
        expect.objectContaining({
          altText: "Sourcing sale",
          destinationKind: "internal_path",
          destinationValue: "/store",
          isActive: true,
        }),
        expect.any(Buffer),
      );
    });

    it("rejects destinationKind without destinationValue with 422", async () => {
      const response = await request(app)
        .post(path)
        .field("altText", "Sourcing sale")
        .field("destinationKind", "internal_path")
        .attach("image", PNG_BYTES, { filename: "slide.png", contentType: "image/png" });

      expect(response.status).toBe(422);
      expect(createPromotionalSlide).not.toHaveBeenCalled();
    });

    it("rejects a file over the 5 MB cap with 413", async () => {
      const oversized = Buffer.concat([PNG_BYTES, Buffer.alloc(5 * 1024 * 1024)]);

      const response = await request(app)
        .post(path)
        .field("altText", "Sourcing sale")
        .field("destinationKind", "internal_path")
        .field("destinationValue", "/store")
        .attach("image", oversized, { filename: "slide.png", contentType: "image/png" });

      expect(response.status).toBe(413);
      expect(createPromotionalSlide).not.toHaveBeenCalled();
    });

    it("rejects a non-image content type with 422", async () => {
      const response = await request(app)
        .post(path)
        .field("altText", "Sourcing sale")
        .field("destinationKind", "internal_path")
        .field("destinationValue", "/store")
        .attach("image", Buffer.from("not an image"), { filename: "slide.txt", contentType: "text/plain" });

      expect(response.status).toBe(422);
      expect(createPromotionalSlide).not.toHaveBeenCalled();
    });

    it("maps PROMOTIONAL_DESTINATION_INVALID to 422", async () => {
      createPromotionalSlide.mockResolvedValue({
        success: false,
        error: { type: "PROMOTIONAL_DESTINATION_INVALID", reason: { type: "EXTERNAL_URL_NOT_HTTPS" } },
      });

      const response = await request(app)
        .post(path)
        .field("altText", "Sourcing sale")
        .field("destinationKind", "external_url")
        .field("destinationValue", "http://insecure.example.test")
        .attach("image", PNG_BYTES, { filename: "slide.png", contentType: "image/png" });

      expect(response.status).toBe(422);
    });

    it("maps PROMOTIONAL_SLIDE_LIMIT_REACHED to 409", async () => {
      createPromotionalSlide.mockResolvedValue({
        success: false,
        error: { type: "PROMOTIONAL_SLIDE_LIMIT_REACHED", limit: 8 },
      });

      const response = await request(app)
        .post(path)
        .field("altText", "Sourcing sale")
        .field("destinationKind", "internal_path")
        .field("destinationValue", "/store")
        .attach("image", PNG_BYTES, { filename: "slide.png", contentType: "image/png" });

      expect(response.status).toBe(409);
    });
  });

  describe("PATCH /promotions/admin/slides/reorder", () => {
    const path = "/promotions/admin/slides/reorder";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app)
        .patch(path)
        .send({ slideIds: ["slide_1", "slide_2"] });

      expect(response.status).toBe(401);
      expect(reorderPromotionalSlides).not.toHaveBeenCalled();
    });

    it("reorders with the full permutation", async () => {
      reorderPromotionalSlides.mockResolvedValue({
        success: true,
        value: [{ id: "slide_2" }, { id: "slide_1" }],
      });

      const response = await request(app)
        .patch(path)
        .send({ slideIds: ["slide_2", "slide_1"] });

      expect(response.status).toBe(200);
      expect(reorderPromotionalSlides).toHaveBeenCalledWith("user_test_caller", ["slide_2", "slide_1"]);
    });

    it("rejects an empty slideIds array with 422", async () => {
      const response = await request(app).patch(path).send({ slideIds: [] });

      expect(response.status).toBe(422);
      expect(reorderPromotionalSlides).not.toHaveBeenCalled();
    });

    it("maps PROMOTIONAL_SLIDE_ORDER_MISMATCH to 422", async () => {
      reorderPromotionalSlides.mockResolvedValue({
        success: false,
        error: { type: "PROMOTIONAL_SLIDE_ORDER_MISMATCH" },
      });

      const response = await request(app)
        .patch(path)
        .send({ slideIds: ["slide_stale"] });

      expect(response.status).toBe(422);
    });

    /**
     * The route-order hazard the router's own docblock names: if `/reorder` were ever
     * declared below `/:slideId`, this request would be captured as an update to a slide
     * literally named "reorder". Proven by asserting the update service was NOT called.
     */
    it("is not captured by the /:slideId route", async () => {
      reorderPromotionalSlides.mockResolvedValue({ success: true, value: [] });

      await request(app)
        .patch(path)
        .send({ slideIds: ["slide_1"] });

      expect(updatePromotionalSlide).not.toHaveBeenCalled();
    });
  });

  describe("PATCH /promotions/admin/slides/:slideId", () => {
    const path = "/promotions/admin/slides/slide_1";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).patch(path).send({ altText: "Updated" });

      expect(response.status).toBe(401);
      expect(updatePromotionalSlide).not.toHaveBeenCalled();
    });

    it("updates the metadata", async () => {
      updatePromotionalSlide.mockResolvedValue({ success: true, value: { id: "slide_1", altText: "Updated" } });

      const response = await request(app).patch(path).send({ altText: "Updated" });

      expect(response.status).toBe(200);
      expect(updatePromotionalSlide).toHaveBeenCalledWith(
        "user_test_caller",
        "slide_1",
        expect.objectContaining({ altText: "Updated" }),
      );
    });

    it("rejects an empty patch with 422", async () => {
      const response = await request(app).patch(path).send({});

      expect(response.status).toBe(422);
      expect(updatePromotionalSlide).not.toHaveBeenCalled();
    });

    it("rejects destinationKind sent without destinationValue with 422", async () => {
      const response = await request(app).patch(path).send({ destinationKind: "internal_path" });

      expect(response.status).toBe(422);
      expect(updatePromotionalSlide).not.toHaveBeenCalled();
    });

    it("maps PROMOTIONAL_SLIDE_NOT_FOUND to 404", async () => {
      updatePromotionalSlide.mockResolvedValue({
        success: false,
        error: { type: "PROMOTIONAL_SLIDE_NOT_FOUND" },
      });

      const response = await request(app).patch(path).send({ altText: "Updated" });

      expect(response.status).toBe(404);
    });

    it("maps PROMOTIONAL_SLIDE_WINDOW_INVALID to 422", async () => {
      updatePromotionalSlide.mockResolvedValue({
        success: false,
        error: { type: "PROMOTIONAL_SLIDE_WINDOW_INVALID" },
      });

      const response = await request(app)
        .patch(path)
        .send({ startsAt: "2026-06-01T00:00:00.000Z", endsAt: "2026-01-01T00:00:00.000Z" });

      expect(response.status).toBe(422);
    });
  });

  describe("PATCH /promotions/admin/slides/:slideId/image — multipart replace", () => {
    const path = "/promotions/admin/slides/slide_1/image";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app)
        .patch(path)
        .attach("image", PNG_BYTES, { filename: "slide.png", contentType: "image/png" });

      expect(response.status).toBe(401);
      expect(replacePromotionalSlideImage).not.toHaveBeenCalled();
    });

    it("requires an image file", async () => {
      const response = await request(app).patch(path);

      expect(response.status).toBe(422);
      expect(replacePromotionalSlideImage).not.toHaveBeenCalled();
    });

    it("replaces the image and answers 200", async () => {
      replacePromotionalSlideImage.mockResolvedValue({
        success: true,
        value: { id: "slide_1", imageUrl: "https://cdn.example.test/slide.png" },
      });

      const response = await request(app)
        .patch(path)
        .attach("image", PNG_BYTES, { filename: "slide.png", contentType: "image/png" });

      expect(response.status).toBe(200);
      expect(replacePromotionalSlideImage).toHaveBeenCalledWith("user_test_caller", "slide_1", expect.any(Buffer));
    });

    it("maps UNSUPPORTED_FORMAT to 422", async () => {
      const response = await request(app)
        .patch(path)
        .attach("image", Buffer.from("not an image"), { filename: "slide.txt", contentType: "text/plain" });

      expect(response.status).toBe(422);
      expect(replacePromotionalSlideImage).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /promotions/admin/slides/:slideId", () => {
    const path = "/promotions/admin/slides/slide_1";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).delete(path);

      expect(response.status).toBe(401);
      expect(deletePromotionalSlide).not.toHaveBeenCalled();
    });

    it("deletes the slide", async () => {
      deletePromotionalSlide.mockResolvedValue({ success: true, value: { id: "slide_1" } });

      const response = await request(app).delete(path);

      expect(response.status).toBe(200);
      expect(deletePromotionalSlide).toHaveBeenCalledWith("user_test_caller", "slide_1");
    });

    it("maps PROMOTIONAL_SLIDE_NOT_FOUND to 404", async () => {
      deletePromotionalSlide.mockResolvedValue({
        success: false,
        error: { type: "PROMOTIONAL_SLIDE_NOT_FOUND" },
      });

      const response = await request(app).delete(path);

      expect(response.status).toBe(404);
    });
  });
});
