import type { Request, Response, NextFunction } from "express";
import multer from "multer";

/**
 * Multipart parser for the single `image` field of
 * POST /products/:productId/highlights/:highlightId/image (Appendix A6, migration `0091`).
 *
 * The same shape as upload-organization-media.ts, and deliberately a separate module for
 * the reason that file gives: the field name, the size cap and the error copy are part of
 * THIS route's contract, and one parameterised helper would make a change to the company
 * gallery silently change the PDP marketing cards.
 *
 * Buffers in memory so the bytes go straight to sharp and then Cloudinary. The byte cap is
 * a CHEAP first gate before any decoding; `validateAndNormalizeImage` re-checks the real
 * image afterwards, because the multipart headers are untrusted (CLAUDE.md §1.1).
 */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8 MB — a highlight card runs to a full-bleed shot.

const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, callback) => {
    // First-pass mimetype gate. NOT authoritative — sharp proves the real format later.
    if (file.mimetype.startsWith("image/")) {
      callback(null, true);
      return;
    }
    callback(new Error("UNSUPPORTED_MIME"));
  },
});

export function uploadProductHighlightImageFile(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  memoryUpload.single("image")(req, res, (uploadError: unknown) => {
    if (!uploadError) {
      next();
      return;
    }

    if (uploadError instanceof multer.MulterError) {
      if (uploadError.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({
          status: "error",
          statusCode: 413,
          message: "Image exceeds the 8 MB size limit.",
        });
        return;
      }
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "Invalid image upload.",
      });
      return;
    }

    if (uploadError instanceof Error && uploadError.message === "UNSUPPORTED_MIME") {
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "File must be an image.",
      });
      return;
    }

    next(uploadError);
  });
}
