import type { Express, NextFunction, Request, Response } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

const ORGANIZATION_ID = "commerce_org_documents";
const MEMBER_ID = "member-documents";

vi.mock("#src/modules/store/organizations/require-active-commerce-organization.js", () => {
  const attach = (req: Request, _res: Response, next: NextFunction): void => {
    req.commerceOrganization = {
      organizationId: ORGANIZATION_ID,
      memberId: MEMBER_ID,
      memberRole: "buyer",
      tradeState: "active",
    };
    next();
  };
  // Phase 21 (§14). A SEPARATE property from `commerceOrganization`, deliberately, so a
  // handler cannot read an unactivated workspace as a trading one.
  const attachWorkspace = (req: Request, _res: Response, next: NextFunction): void => {
    req.buyerCommerceWorkspace = {
      organizationId: ORGANIZATION_ID,
      memberId: MEMBER_ID,
      memberRole: "buyer",
      tradeState: "active",
    };
    next();
  };
  return {
    attachOptionalSellerCommerceOrganization: attach,
    requireActiveCommerceOrganization: attach,
    requireActiveBuyerCommerceOrganization: attach,
    requireActiveProviderCommerceOrganization: attach,
    requireActiveSellerCommerceOrganization: attach,
    requireProvisionedBuyerCommerceWorkspace: attachWorkspace,
  };
});

const serviceStubs = vi.hoisted(() => ({
  uploadTradeDocument: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  downloadTradeDocument: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

vi.mock("#src/modules/store/fulfillment/commerce-trade-document.service.js", () => serviceStubs);

/** A real PNG signature, so the controller's decoded-byte check has something to pass. */
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
    "01f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082",
  "hex",
);

describe("commerce trade document routes (A30)", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    signInAs();
  });

  describe("POST /commerce/documents", () => {
    /**
     * 202, not 201. The row lands `pending_scan`, and both `assertOwnedDocuments` and
     * the message path refuse anything that is not `available` — saying 201 would invite
     * a client to attach it immediately and collect a confusing rejection.
     */
    it("accepts a scanned-pending upload with 202", async () => {
      serviceStubs.uploadTradeDocument.mockResolvedValue({
        success: true,
        value: {
          encryptedDocumentId: "doc_1",
          state: "pending_scan",
          mediaType: "image/png",
          fileByteSize: PNG_BYTES.length,
        },
      });

      const response = await request(app)
        .post("/commerce/documents")
        .attach("evidence", PNG_BYTES, { filename: "drawing.png", contentType: "image/png" });

      expect(response.status).toBe(202);
      expect(response.body.data.encryptedDocumentId).toBe("doc_1");
      expect(response.body.data.state).toBe("pending_scan");
      expect(serviceStubs.uploadTradeDocument).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: ORGANIZATION_ID, mediaType: "image/png" }),
      );
    });

    /**
     * The magic-byte check is not multer's job — `fileFilter` only ever sees the client's
     * own claim about the file, so a PDF renamed to .png passes it.
     */
    it("refuses bytes that do not match the declared media type", async () => {
      const response = await request(app)
        .post("/commerce/documents")
        .attach("evidence", Buffer.from("this is not a png"), {
          filename: "drawing.png",
          contentType: "image/png",
        });

      expect(response.status).toBe(422);
      expect(serviceStubs.uploadTradeDocument).not.toHaveBeenCalled();
    });

    it("refuses a request with no file", async () => {
      const response = await request(app).post("/commerce/documents");

      expect(response.status).toBe(422);
      expect(serviceStubs.uploadTradeDocument).not.toHaveBeenCalled();
    });

    it("reports storage failure as 503 rather than a client error", async () => {
      serviceStubs.uploadTradeDocument.mockResolvedValue({
        success: false,
        error: { type: "STORAGE_NOT_CONFIGURED" },
      });

      const response = await request(app)
        .post("/commerce/documents")
        .attach("evidence", PNG_BYTES, { filename: "drawing.png", contentType: "image/png" });

      expect(response.status).toBe(503);
    });

    it("requires a session", async () => {
      signOut();

      const response = await request(app)
        .post("/commerce/documents")
        .attach("evidence", PNG_BYTES, { filename: "drawing.png", contentType: "image/png" });

      expect(response.status).toBe(401);
      expect(serviceStubs.uploadTradeDocument).not.toHaveBeenCalled();
    });
  });

  describe("GET /commerce/documents/:documentId", () => {
    it("streams the decrypted bytes as an attachment that is never cached", async () => {
      serviceStubs.downloadTradeDocument.mockResolvedValue({
        success: true,
        value: {
          documentId: "doc_1",
          mediaType: "image/png",
          fileName: "drawing rev-B.png",
          bytes: PNG_BYTES,
        },
      });

      const response = await request(app).get("/commerce/documents/doc_1");

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain("image/png");
      expect(response.headers["content-disposition"]).toContain("attachment");
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(Buffer.from(response.body).equals(PNG_BYTES)).toBe(true);
    });

    /**
     * A file name is uploader-supplied text going into a response header, so quotes and
     * newlines are stripped rather than escaped.
     */
    it("sanitizes a hostile file name before it reaches the header", async () => {
      serviceStubs.downloadTradeDocument.mockResolvedValue({
        success: true,
        value: {
          documentId: "doc_1",
          mediaType: "application/pdf",
          fileName: 'evil"\r\nX-Injected: yes.pdf',
          bytes: Buffer.from("%PDF-1.4"),
        },
      });

      const response = await request(app).get("/commerce/documents/doc_1");

      expect(response.status).toBe(200);
      // The property that matters is that the header cannot be BROKEN OUT OF: no quote,
      // no CR, no LF. The letters "X-Injected" surviving inside the quoted filename are
      // harmless text, and stripping them would be theatre rather than a defence.
      const disposition = response.headers["content-disposition"] ?? "";
      expect(disposition).toBe('attachment; filename="evil___X-Injected_ yes.pdf"');
      expect(disposition.slice("attachment; filename=".length)).not.toMatch(/[\r\n]/);
      expect(response.headers["x-injected"]).toBeUndefined();
    });

    /**
     * 404 for EVERY refusal — missing, quarantined, still scanning, or not the caller's
     * to read. Distinguishing them would make the route an oracle for which documents
     * exist between which organizations.
     */
    it("answers 404 when the caller may not read it", async () => {
      serviceStubs.downloadTradeDocument.mockResolvedValue({
        success: false,
        error: { type: "NOT_FOUND" },
      });

      const response = await request(app).get("/commerce/documents/someone-elses-doc");

      expect(response.status).toBe(404);
    });

    it("rejects an unknown query key rather than ignoring it", async () => {
      const response = await request(app).get("/commerce/documents/doc_1?download=true");

      expect(response.status).toBe(422);
      expect(serviceStubs.downloadTradeDocument).not.toHaveBeenCalled();
    });

    it("requires a session", async () => {
      signOut();

      const response = await request(app).get("/commerce/documents/doc_1");

      expect(response.status).toBe(401);
      expect(serviceStubs.downloadTradeDocument).not.toHaveBeenCalled();
    });
  });
});
