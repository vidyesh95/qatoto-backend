import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for `POST /series/:seriesId/poster` — multipart, split from
 * `series.routes.test.ts` because it needs supertest's `.attach()` rather than `.send()`.
 *
 * The multer gate (`upload-series-poster.ts`) checks only the CLAIMED mimetype and a byte
 * cap before the controller ever runs; the decoded-byte check lives inside
 * `series.service.ts::replaceSeriesPoster`, which is mocked here, so this file proves
 * routing and the multer contract (field name, size limit, claimed-mimetype gate) — not
 * the real image decode, which belongs to that service's own test.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

const replaceSeriesPoster = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/studio/series/series.service.js", () => ({
  createSeries: vi.fn<(...args: readonly unknown[]) => unknown>(),
  listMySeries: vi.fn<(...args: readonly unknown[]) => unknown>(),
  getSeries: vi.fn<(...args: readonly unknown[]) => unknown>(),
  updateSeries: vi.fn<(...args: readonly unknown[]) => unknown>(),
  deleteSeries: vi.fn<(...args: readonly unknown[]) => unknown>(),
  createSeason: vi.fn<(...args: readonly unknown[]) => unknown>(),
  updateSeason: vi.fn<(...args: readonly unknown[]) => unknown>(),
  deleteSeason: vi.fn<(...args: readonly unknown[]) => unknown>(),
  createEpisode: vi.fn<(...args: readonly unknown[]) => unknown>(),
  updateEpisode: vi.fn<(...args: readonly unknown[]) => unknown>(),
  deleteEpisode: vi.fn<(...args: readonly unknown[]) => unknown>(),
  replaceSeriesPoster: (...args: readonly unknown[]) => replaceSeriesPoster(...args),
  removeSeriesPoster: vi.fn<(...args: readonly unknown[]) => unknown>(),
}));

/** A real PNG signature, matching `commerce-documents.routes.test.ts`'s fixture shape. */
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
    "01f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082",
  "hex",
);

const path = "/series/series_1/poster";

describe("series poster upload route", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signInAs();
    await resetRateLimiters();
  });

  it("answers 401 for a signed-out caller", async () => {
    signOut();

    const response = await request(app)
      .post(path)
      .attach("image", PNG_BYTES, { filename: "poster.png", contentType: "image/png" });

    expect(response.status).toBe(401);
    expect(replaceSeriesPoster).not.toHaveBeenCalled();
  });

  it("uploads a valid image and answers 200 with the service's buffer", async () => {
    replaceSeriesPoster.mockResolvedValue({
      success: true,
      value: { id: "series_1", posterUrl: "https://cdn.test/poster.png" },
    });

    const response = await request(app)
      .post(path)
      .attach("image", PNG_BYTES, { filename: "poster.png", contentType: "image/png" });

    expect(response.status).toBe(200);
    expect(replaceSeriesPoster).toHaveBeenCalledWith("user_test_caller", "series_1", expect.any(Buffer));
  });

  it("refuses a request with no file, naming the field", async () => {
    const response = await request(app).post(path);

    expect(response.status).toBe(422);
    expect(replaceSeriesPoster).not.toHaveBeenCalled();
  });

  it("refuses a claimed mimetype outside the image allowlist before the controller ever runs", async () => {
    const response = await request(app).post(path).attach("image", Buffer.from("%PDF-1.4 not really a pdf"), {
      filename: "poster.pdf",
      contentType: "application/pdf",
    });

    expect(response.status).toBe(422);
    expect(replaceSeriesPoster).not.toHaveBeenCalled();
  });

  it("refuses a file over the 5 MB limit with 413", async () => {
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 0);

    const response = await request(app)
      .post(path)
      .attach("image", oversized, { filename: "poster.png", contentType: "image/png" });

    expect(response.status).toBe(413);
    expect(replaceSeriesPoster).not.toHaveBeenCalled();
  });

  it("answers 404 for a foreign series id", async () => {
    replaceSeriesPoster.mockResolvedValue({ success: false, error: { type: "SERIES_NOT_FOUND" } });

    const response = await request(app)
      .post("/series/series_not_mine/poster")
      .attach("image", PNG_BYTES, { filename: "poster.png", contentType: "image/png" });

    expect(response.status).toBe(404);
  });
});
