import type { NextFunction, Request, Response } from "express";
import multer from "multer";

import {
  COMMERCE_EVIDENCE_MEDIA_TYPES,
  MAXIMUM_COMMERCE_EVIDENCE_BYTES,
} from "#src/middleware/upload-commerce-verification-evidence.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * Multipart parser for POST /commerce/organizations/:organizationId/certifications (A13).
 *
 * WHY THIS IS NOT `uploadCommerceVerificationEvidence`, which it otherwise duplicates:
 * that middleware sets `fields: 2`, because a verification submit sends exactly
 * `verificationKind` and `documentKind`. A certification sends SIX text parts — standard
 * name, issuer, certificate number, both validity dates and an optional scope summary — so
 * reusing it produced a `LIMIT_FIELD_COUNT` rejection and a flat 422 on every submission.
 *
 * Raising the shared cap to eight was the other option and is worse: the verification route's
 * cap is part of its contract, and widening it to suit a different route is how a limit stops
 * meaning anything. The size cap and the media-type allowlist ARE shared, imported from that
 * module so the two cannot drift.
 *
 * The magic-byte check stays in the controller via `evidenceBytesMatchMediaType`: the
 * multipart `mimetype` is a claim by the uploader, and the decoded bytes are the fact.
 */
const CERTIFICATE_TEXT_FIELD_LIMIT = 8;

const certificateUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAXIMUM_COMMERCE_EVIDENCE_BYTES,
    files: 1,
    fields: CERTIFICATE_TEXT_FIELD_LIMIT,
  },
  fileFilter: (_req, file, callback) => {
    if (
      COMMERCE_EVIDENCE_MEDIA_TYPES.some(
        (mediaType) => mediaType === file.mimetype,
      )
    ) {
      callback(null, true);
      return;
    }
    callback(new Error("UNSUPPORTED_COMMERCE_EVIDENCE_MEDIA_TYPE"));
  },
});

export function uploadCommerceCertificate(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  certificateUpload.single("evidence")(req, res, (uploadError: unknown) => {
    if (!uploadError) {
      next();
      return;
    }

    if (uploadError instanceof multer.MulterError) {
      if (uploadError.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({
          status: "error",
          statusCode: 413,
          message: "Certificate file exceeds the 8 MB size limit.",
        } satisfies ApiResponse);
        return;
      }
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "Invalid certificate upload.",
      } satisfies ApiResponse);
      return;
    }

    if (
      uploadError instanceof Error &&
      uploadError.message === "UNSUPPORTED_COMMERCE_EVIDENCE_MEDIA_TYPE"
    ) {
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "A certificate must be a PDF, JPEG or PNG.",
      } satisfies ApiResponse);
      return;
    }

    next(uploadError);
  });
}
