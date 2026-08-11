import express from "express";

import * as commerceDocumentsController from "#src/controllers/commerce-documents.controller.js";
import {
  commerceDocumentDownloadLimiter,
  commerceOrganizationEvidenceLimiter,
} from "#src/middleware/rate-limit.js";
import { requireProvisionedBuyerCommerceWorkspace } from "#src/middleware/require-active-commerce-organization.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import { uploadCommerceVerificationEvidence } from "#src/middleware/upload-commerce-verification-evidence.js";

/**
 * Trade attachments (STORE Appendix A30, and A27's second half).
 *
 * These two routes exist together or not at all. An upload with no download would leave
 * a composer able to attach a file nobody, including its uploader, can open — the RFQ
 * read projects `encryptedDocumentId` and mints no URL of its own.
 *
 * `requireProvisionedBuyerCommerceWorkspace` rather than a role-specific guard: a seller
 * returning a marked-up drawing in a negotiation thread is the same act as the buyer sending
 * the original, and A27's message attachments are written by both sides. Since Phase 21 it
 * also admits a `pending` workspace (§14) — an attachment is worth nothing without the
 * thread it rides in, and messaging is open to a pending shell. Ownership is unchanged:
 * `downloadTradeDocument` still authorizes the caller against the specific document.
 *
 * NO IDEMPOTENCY on the upload, unlike verification evidence. Evidence is keyed to a
 * verification of a KIND, so a replay is a duplicate of something; a trade attachment is
 * just a file, and two uploads of the same drawing are two documents the caller may
 * legitimately want. `uploadCommerceVerificationEvidence` is reused verbatim — 8 MB, one
 * file, pdf/jpeg/png, with the magic-byte check re-run in the controller against the
 * DECODED bytes.
 */
const commerceDocumentsRouter = express.Router();

commerceDocumentsRouter.post(
  "/documents",
  requireAuth,
  requireProvisionedBuyerCommerceWorkspace,
  commerceOrganizationEvidenceLimiter,
  uploadCommerceVerificationEvidence,
  commerceDocumentsController.uploadTradeDocument,
);

commerceDocumentsRouter.get(
  "/documents/:documentId",
  requireAuth,
  requireProvisionedBuyerCommerceWorkspace,
  commerceDocumentDownloadLimiter,
  commerceDocumentsController.downloadTradeDocument,
);

export default commerceDocumentsRouter;
