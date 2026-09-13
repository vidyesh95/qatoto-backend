import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for the teardown file upload and the two downloads.
 *
 * ⚠️ THE DOWNLOAD ROUTES ARE THE INTERESTING HALF. They are anonymous-reachable and they mint a
 * bearer capability, so the three things asserted here are the three that matter: that the gate is
 * consulted at all, that every refusal produces ONE indistinguishable 404, and that the redirect is
 * never cacheable. The gate's own predicate is a database fact and belongs to the smoke script —
 * vitest mocks `#src/db/index.js` wholesale, so nothing here can prove what a quarantine does.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

vi.mock("#src/middleware/require-identified-user.js", () => ({
  requireIdentifiedUser: (_req: unknown, _res: unknown, next: (error?: unknown) => void): void => {
    next();
  },
}));

const uploadTeardownSubmissionFile = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/home/blueprints/teardown-upload.service.js", () => ({
  uploadTeardownSubmissionFile: (...args: readonly unknown[]) => uploadTeardownSubmissionFile(...args),
  MAX_UNCLAIMED_TEARDOWN_UPLOADS_PER_AUTHOR: 16,
}));

const resolveDownloadableTeardownFile = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/home/blueprints/teardown-public-read.service.js", () => ({
  resolveDownloadableTeardownFile: (...args: readonly unknown[]) => resolveDownloadableTeardownFile(...args),
  listPublicTeardowns: vi.fn<(...args: readonly unknown[]) => unknown>(),
  getPublicTeardownBySlug: vi.fn<(...args: readonly unknown[]) => unknown>(),
  listPublicTeardownSlugs: vi.fn<(...args: readonly unknown[]) => unknown>(),
  listTeardownOptions: vi.fn<(...args: readonly unknown[]) => unknown>(),
  getTeardownClaimTargets: vi.fn<(...args: readonly unknown[]) => unknown>(),
}));

const presignTeardownFileDownload = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/lib/object-storage.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    presignTeardownFileDownload: (...args: readonly unknown[]) => presignTeardownFileDownload(...args),
  };
});

const UPLOAD_PATH = "/blueprints/teardowns/uploads";
const DOWNLOAD_PATH = "/blueprints/teardowns/solar-controller/documents/doc_1";

/** Padded past `validatePdfBytes`' own 512-byte floor so the route, not the size, decides. */
function buildPdfBytes(): Buffer {
  const lines = [
    "%PDF-1.7",
    "1 0 obj",
    "<< /Type /Catalog >>",
    "endobj",
    ...Array.from({ length: 80 }, () => "% padding"),
    "trailer",
    "<< /Root 1 0 R >>",
    "%%EOF",
  ];
  return Buffer.from(lines.join("\n") + "\n", "latin1");
}

describe("blueprints teardown file routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signOut();
    await resetRateLimiters();
  });

  describe("POST /blueprints/teardowns/uploads", () => {
    it("refuses a signed-out uploader with 401, before multer buffers anything", async () => {
      const response = await request(app)
        .post(UPLOAD_PATH)
        .field("format", "pdf")
        .attach("file", buildPdfBytes(), "datasheet.pdf");

      expect(response.status).toBe(401);
      expect(uploadTeardownSubmissionFile).not.toHaveBeenCalled();
    });

    it("refuses a request carrying no file", async () => {
      signInAs();

      const response = await request(app).post(UPLOAD_PATH).field("format", "pdf");

      expect(response.status).toBe(422);
      expect(uploadTeardownSubmissionFile).not.toHaveBeenCalled();
    });

    /** ⚠️ THE `format` PART IS REQUIRED — it is the control the mimetype gate cannot be. */
    it("refuses a request carrying no declared format", async () => {
      signInAs();

      const response = await request(app).post(UPLOAD_PATH).attach("file", buildPdfBytes(), "datasheet.pdf");

      expect(response.status).toBe(422);
      expect(uploadTeardownSubmissionFile).not.toHaveBeenCalled();
    });

    it("refuses a format outside the four the uploaded arm accepts", async () => {
      signInAs();

      const response = await request(app)
        .post(UPLOAD_PATH)
        .field("format", "gerber")
        .attach("file", buildPdfBytes(), "board.gbr");

      expect(response.status).toBe(422);
      expect(uploadTeardownSubmissionFile).not.toHaveBeenCalled();
    });

    it("passes the declared format and the client's filename through to the service", async () => {
      signInAs();
      uploadTeardownSubmissionFile.mockResolvedValue({
        success: true,
        value: {
          uploadId: "upl_1",
          format: "pdf",
          byteSize: 900,
          originalFileName: "datasheet.pdf",
        },
      });

      const response = await request(app)
        .post(UPLOAD_PATH)
        .field("format", "pdf")
        .attach("file", buildPdfBytes(), "datasheet.pdf");

      expect(response.status).toBe(201);
      expect(uploadTeardownSubmissionFile.mock.calls[0]?.[0]).toMatchObject({
        declaredFormat: "pdf",
        originalFileName: "datasheet.pdf",
      });
    });

    /** ⚠️ THE RECEIPT CARRIES NO ADDRESS. One exists only once a moderator publishes the survey. */
    it("answers a receipt with no url of any kind", async () => {
      signInAs();
      uploadTeardownSubmissionFile.mockResolvedValue({
        success: true,
        value: {
          uploadId: "upl_1",
          format: "pdf",
          byteSize: 900,
          originalFileName: "datasheet.pdf",
        },
      });

      const response = await request(app)
        .post(UPLOAD_PATH)
        .field("format", "pdf")
        .attach("file", buildPdfBytes(), "datasheet.pdf");

      expect(response.body.data).toEqual({
        uploadId: "upl_1",
        format: "pdf",
        byteSize: 900,
        originalFileName: "datasheet.pdf",
      });
      expect(JSON.stringify(response.body)).not.toContain("http");
    });

    it("answers 422 when the bytes do not match the declared format", async () => {
      signInAs();
      uploadTeardownSubmissionFile.mockResolvedValue({
        success: false,
        error: {
          type: "TEARDOWN_UPLOAD_REJECTED",
          reason: { type: "FORMAT_MISMATCH", declaredFormat: "step" },
        },
      });

      const response = await request(app)
        .post(UPLOAD_PATH)
        .field("format", "step")
        .attach("file", buildPdfBytes(), "housing.step");

      expect(response.status).toBe(422);
      expect(response.body.errors.file[0]).toContain("STEP");
    });

    it("answers 409 when the author is holding too many unclaimed uploads", async () => {
      signInAs();
      uploadTeardownSubmissionFile.mockResolvedValue({
        success: false,
        error: { type: "TEARDOWN_UPLOAD_STAGING_LIMIT_REACHED", limit: 16 },
      });

      const response = await request(app)
        .post(UPLOAD_PATH)
        .field("format", "pdf")
        .attach("file", buildPdfBytes(), "datasheet.pdf");

      expect(response.status).toBe(409);
    });

    it("answers 503 when object storage is not configured, and 502 when it fails", async () => {
      signInAs();
      uploadTeardownSubmissionFile.mockResolvedValue({
        success: false,
        error: { type: "TEARDOWN_UPLOAD_STORAGE_FAILED", cause: { type: "NOT_CONFIGURED" } },
      });
      const unconfigured = await request(app)
        .post(UPLOAD_PATH)
        .field("format", "pdf")
        .attach("file", buildPdfBytes(), "datasheet.pdf");
      expect(unconfigured.status).toBe(503);

      await resetRateLimiters();
      uploadTeardownSubmissionFile.mockResolvedValue({
        success: false,
        error: {
          type: "TEARDOWN_UPLOAD_STORAGE_FAILED",
          cause: { type: "UPLOAD_FAILED", cause: "bucket unreachable" },
        },
      });
      const failed = await request(app)
        .post(UPLOAD_PATH)
        .field("format", "pdf")
        .attach("file", buildPdfBytes(), "datasheet.pdf");
      expect(failed.status).toBe(502);
    });
  });

  describe("the download routes", () => {
    it("redirects to a freshly minted presign, and forbids caching the redirect", async () => {
      resolveDownloadableTeardownFile.mockResolvedValue({
        objectStorageKey: "teardowns/user_1/uploads/abc.pdf",
      });
      presignTeardownFileDownload.mockResolvedValue({
        success: true,
        value: { downloadUrl: "https://files.example.com/signed", expiresInSeconds: 300 },
      });

      const response = await request(app).get(DOWNLOAD_PATH).redirects(0);

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("https://files.example.com/signed");
      /*
       * ⚠️ `no-store` IS THE ASSERTION THAT MATTERS. The redirect target is a credential with a
       * 300-second life; a cache or a CDN holding this response would hand that credential to
       * somebody the gate never saw.
       */
      expect(response.headers["cache-control"]).toBe("no-store");
    });

    /**
     * ⚠️ ONE 404 FOR EVERY REASON. A missing slug, a missing file, a file on another teardown and a
     * QUARANTINED teardown are deliberately indistinguishable from outside — anything finer turns
     * this route into an enumeration oracle over withheld files, which is precisely what a rights
     * claimant's opponent would want.
     */
    it("answers 404 without minting a presign when the gate refuses", async () => {
      resolveDownloadableTeardownFile.mockResolvedValue(null);

      const response = await request(app).get(DOWNLOAD_PATH).redirects(0);

      expect(response.status).toBe(404);
      expect(presignTeardownFileDownload).not.toHaveBeenCalled();
    });

    it("asks the gate for the right teardown, file and segment", async () => {
      resolveDownloadableTeardownFile.mockResolvedValue(null);

      await request(app).get("/blueprints/teardowns/solar-controller/fabrication-files/mfg_9").redirects(0);

      expect(resolveDownloadableTeardownFile).toHaveBeenCalledWith({
        teardownSlug: "solar-controller",
        fileId: "mfg_9",
        segment: "fabrication-files",
      });
    });

    it("does not require a session — these are public files on a public page", async () => {
      resolveDownloadableTeardownFile.mockResolvedValue({
        objectStorageKey: "teardowns/user_1/uploads/abc.pdf",
      });
      presignTeardownFileDownload.mockResolvedValue({
        success: true,
        value: { downloadUrl: "https://files.example.com/signed", expiresInSeconds: 300 },
      });

      const response = await request(app).get(DOWNLOAD_PATH).redirects(0);

      expect(response.status).toBe(302);
    });
  });
});
