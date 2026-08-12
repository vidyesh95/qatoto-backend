import express from "express";

import {
  commerceDocumentDownloadLimiter,
  commerceOrganizationEvidenceLimiter,
} from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import * as commerceDocumentsController from "#src/modules/store/fulfillment/commerce-documents.controller.js";
import { requireProvisionedBuyerCommerceWorkspace } from "#src/modules/store/organizations/require-active-commerce-organization.js";
import { uploadCommerceVerificationEvidence } from "#src/modules/store/organizations/upload-commerce-verification-evidence.js";

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

/**
 * A38. DECLARED BEFORE `/documents/:documentId`, and here that ordering IS load bearing —
 * both are `/documents` + at most one segment, so a later `/documents` would be fine but a
 * `:documentId` route declared first would capture nothing of the bare path. Express matches
 * the exact path first either way; the order is kept explicit so a future insert cannot break
 * it silently.
 *
 * The download limiter does NOT apply: this returns metadata, never bytes, so it is not the
 * expensive read that limiter exists to bound.
 */
commerceDocumentsRouter.get(
  "/documents",
  requireAuth,
  requireProvisionedBuyerCommerceWorkspace,
  commerceDocumentsController.listTradeDocuments,
);

commerceDocumentsRouter.get(
  "/documents/:documentId",
  requireAuth,
  requireProvisionedBuyerCommerceWorkspace,
  commerceDocumentDownloadLimiter,
  commerceDocumentsController.downloadTradeDocument,
);

export default commerceDocumentsRouter;
