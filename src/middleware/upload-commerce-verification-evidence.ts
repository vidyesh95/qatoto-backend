import type { NextFunction, Request, Response } from "express";
import multer from "multer";

import type { ApiResponse } from "#src/types/index.js";

export const MAXIMUM_COMMERCE_EVIDENCE_BYTES = 8 * 1024 * 1024;
export const COMMERCE_EVIDENCE_MEDIA_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
] as const;

const evidenceUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAXIMUM_COMMERCE_EVIDENCE_BYTES,
    files: 1,
    fields: 2,
  },
  fileFilter: (_req, file, callback) => {
    if (COMMERCE_EVIDENCE_MEDIA_TYPES.some((mediaType) => mediaType === file.mimetype)) {
      callback(null, true);
      return;
    }
    callback(new Error("UNSUPPORTED_COMMERCE_EVIDENCE_MEDIA_TYPE"));
  },
});

export function evidenceBytesMatchMediaType(bytes: Buffer, mediaType: string): boolean {
  switch (mediaType) {
    case "application/pdf":
      return bytes.subarray(0, 5).toString("ascii") === "%PDF-";
    case "image/jpeg":
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/png":
      return (
        bytes.length >= 8 &&
        bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      );
    default:
      return false;
  }
}

export function uploadCommerceVerificationEvidence(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  evidenceUpload.single("evidence")(req, res, (uploadError: unknown) => {
    if (!uploadError) {
      next();
      return;
    }
    if (uploadError instanceof multer.MulterError && uploadError.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({
        status: "error",
        statusCode: 413,
        message: "Verification evidence exceeds the 8 MB size limit.",
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
        message: "Evidence must be a PDF, JPEG, or PNG file.",
      } satisfies ApiResponse);
      return;
    }
    if (uploadError instanceof multer.MulterError) {
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "Invalid verification evidence upload.",
      } satisfies ApiResponse);
      return;
    }
    next(uploadError);
  });
}
