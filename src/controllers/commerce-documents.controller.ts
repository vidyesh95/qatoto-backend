import type { Request, Response } from "express";
import { z } from "zod";

import { respondValidationFailed } from "#src/controllers/project-error-response.js";
import { evidenceBytesMatchMediaType } from "#src/middleware/upload-commerce-verification-evidence.js";
import * as commerceTradeDocumentService from "#src/services/commerce-trade-document.service.js";
import type { CommerceTradeDocumentError } from "#src/services/commerce-trade-document.service.js";
import type { ApiResponse } from "#src/types/index.js";

const EmptyObjectSchema = z.object({}).strict();

const DocumentIdParamsSchema = z.object({ documentId: z.string().trim().min(1).max(200) }).strict();

const ListTradeDocumentsQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

function sendZodError(res: Response, error: z.ZodError): void {
  /**
   * Delegates to the ONE shared responder (§0).
   *
   * This used to build its own body, and got two things wrong that only showed up in the browser:
   * it forwarded `fieldErrors` alone, so `.strict()`'s `unrecognized_keys` — the way EVERY rejected
   * server-owned field arrives — vanished into an empty object; and it put the payload under `data`,
   * which the client's envelope reader never looks at. The result was a 422 that said "Validation
   * failed." and named nothing.
   */
  respondValidationFailed(res, error);
}

function parseNoQuery(req: Request, res: Response): boolean {
  const parsed = EmptyObjectSchema.safeParse(req.query);
  if (!parsed.success) {
    sendZodError(res, parsed.error);
    return false;
  }
  return true;
}

function requireDocumentActor(
  req: Request,
  res: Response,
): commerceTradeDocumentService.CommerceTradeDocumentActorContext | null {
  if (!req.user) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return null;
  }
  // §14. Possibly-`pending` since Phase 21 — an attachment is worthless without the thread
  // it rides in, and messaging is open to a pending workspace. Per-document ownership is
  // still proven in the service.
  const documentActor = req.buyerCommerceWorkspace ?? req.commerceOrganization;
  if (!documentActor) {
    res.status(403).json({
      status: "error",
      statusCode: 403,
      message: "An active commerce organization membership is required.",
    } satisfies ApiResponse);
    return null;
  }
  return {
    organizationId: documentActor.organizationId,
    memberId: documentActor.memberId,
    memberRole: documentActor.memberRole,
    actorUserId: req.user.id,
  };
}

function mapTradeDocumentError(res: Response, error: CommerceTradeDocumentError): void {
  switch (error.type) {
    case "NOT_FOUND":
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "Document not found.",
      } satisfies ApiResponse);
      return;
    case "MEDIA_TYPE_MISMATCH":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "The file's contents do not match its declared type.",
      } satisfies ApiResponse);
      return;
    case "PII_ENCRYPTION_UNAVAILABLE":
    case "STORAGE_NOT_CONFIGURED":
    case "STORAGE_FAILED":
      res.status(503).json({
        status: "error",
        statusCode: 503,
        message: "Document storage is unavailable.",
      } satisfies ApiResponse);
      return;
    case "INVALID_CURSOR":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "Invalid cursor.",
      } satisfies ApiResponse);
      return;
    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled trade document error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * A30. Create an authorized document a trading party may attach to an RFQ or a message.
 *
 * `requireActiveCommerceOrganization`, NOT the buyer variant: A27's message attachments
 * are written by sellers too, and a seller returning a marked-up drawing in a negotiation
 * thread is the same act as the buyer sending the original.
 */
export async function uploadTradeDocument(req: Request, res: Response): Promise<void> {
  const actor = requireDocumentActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const uploadedFile = req.file;
  if (!uploadedFile) {
    res.status(422).json({
      status: "error",
      statusCode: 422,
      message: "Attach a file in the `evidence` field.",
    } satisfies ApiResponse);
    return;
  }
  // Re-checked here because matching declared type against DECODED BYTES is not multer's
  // job — `fileFilter` only ever sees the client's own claim about the file.
  if (!evidenceBytesMatchMediaType(uploadedFile.buffer, uploadedFile.mimetype)) {
    res.status(422).json({
      status: "error",
      statusCode: 422,
      message: "The file's contents do not match its declared type.",
    } satisfies ApiResponse);
    return;
  }

  const result = await commerceTradeDocumentService.uploadTradeDocument({
    userId: actor.actorUserId,
    organizationId: actor.organizationId,
    documentBytes: uploadedFile.buffer,
    mediaType: uploadedFile.mimetype,
    originalFileName: uploadedFile.originalname,
  });
  if (!result.success) {
    mapTradeDocumentError(res, result.error);
    return;
  }

  /**
   * 202, not 201: the bytes are stored but the document is `pending_scan`, and both
   * `assertOwnedDocuments` and the message path refuse anything that is not `available`.
   * Saying 201 would invite a client to attach it immediately and get a confusing
   * rejection.
   */
  res.status(202).json({
    status: "success",
    statusCode: 202,
    message: "Document uploaded and awaiting scanning.",
    data: result.value,
  } satisfies ApiResponse);
}

/**
 * A38. The caller's own trade attachments — the list behind an attachment picker.
 *
 * A30 shipped the upload and the download and nothing that enumerated them, so `documentIds`
 * on an RFQ and `encryptedDocumentIds` on a message could only be filled with an id the client
 * had just minted in the same session. METADATA ONLY: no bytes, no storage key, no ciphertext.
 */
export async function listTradeDocuments(req: Request, res: Response): Promise<void> {
  const actor = requireDocumentActor(req, res);
  if (!actor) return;

  const query = ListTradeDocumentsQuerySchema.safeParse(req.query);
  if (!query.success) {
    sendZodError(res, query.error);
    return;
  }

  const result = await commerceTradeDocumentService.listTradeDocuments(actor, {
    cursor: query.data.cursor,
    limit: query.data.limit,
  });
  if (!result.success) {
    mapTradeDocumentError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Trade documents listed.",
    data: result.value,
  } satisfies ApiResponse);
}

/**
 * A30. Stream one trade attachment back, decrypted.
 *
 * Without this the RFQ read projects an `encryptedDocumentId` that nobody — including
 * the buyer who uploaded it — can open, which is what `rfq-detail.tsx` renders as "an
 * attachment exists" with no link.
 */
export async function downloadTradeDocument(req: Request, res: Response): Promise<void> {
  const actor = requireDocumentActor(req, res);
  if (!actor) return;

  const params = DocumentIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  if (!parseNoQuery(req, res)) return;

  const result = await commerceTradeDocumentService.downloadTradeDocument(
    actor,
    params.data.documentId,
  );
  if (!result.success) {
    mapTradeDocumentError(res, result.error);
    return;
  }

  // Sanitized the way `downloadVerificationEvidence` sanitizes: a file name is
  // uploader-supplied text going into a response header.
  const safeFileName = result.value.fileName.replaceAll(/[^A-Za-z0-9 ._-]/g, "_").slice(0, 120);
  res.setHeader("Content-Type", result.value.mediaType);
  res.setHeader("Content-Disposition", `attachment; filename="${safeFileName}"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.status(200).send(result.value.bytes);
}
