import type { Request, Response, NextFunction } from "express";
import multer from "multer";

/**
 * Multipart parser for the single `image` field of POST /products/:id/images.
 *
 * Buffers the file in memory (no disk temp) so we can hand the bytes straight to
 * sharp for validation and then Cloudinary. The byte cap here is a CHEAP first
 * gate that stops oversized uploads before any decoding; sharp re-checks the real
 * image afterwards (CLAUDE.md §1.1 — the multipart headers are untrusted).
 *
 * A copy of upload-avatar.ts with the field renamed to `image`. Runs INSIDE the
 * route so the global express.json() never touches multipart bodies.
 */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, callback) => {
    // First-pass mimetype gate. NOT authoritative — sharp proves the real format
    // later — but rejects the obvious non-image before buffering it.
    if (file.mimetype.startsWith("image/")) {
      callback(null, true);
      return;
    }
    callback(new Error("UNSUPPORTED_MIME"));
  },
});

/**
 * Run multer for the `image` field and translate its failures into our standard
 * error envelope (422), with the size cap surfaced as 413. On success `req.file`
 * holds the buffered upload and control passes to the controller.
 */
export function uploadProductImage(req: Request, res: Response, next: NextFunction): void {
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
          message: "Image exceeds the 5 MB size limit.",
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
