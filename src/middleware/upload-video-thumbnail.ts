import type { Request, Response, NextFunction } from "express";
import multer from "multer";

/**
 * Multipart parser for the single `image` field of POST /videos/:videoId/thumbnail.
 *
 * Buffers the file in memory (no disk temp) so we can hand the bytes straight to
 * sharp for validation and then Cloudinary. The byte cap here is a CHEAP first
 * gate that stops oversized uploads before any decoding; sharp re-checks the real
 * image afterwards (CLAUDE.md §1.1 — the multipart headers are untrusted).
 *
 * A copy of upload-product-image.ts. The house convention is one upload middleware per
 * surface (avatar, product image, project cover, video thumbnail) rather than one generic
 * factory, so each names its own field and its own error copy. Runs INSIDE the
 * route so the global express.json() never touches multipart bodies.
 *
 * NAME TWIN, same as the product and project pairs: `uploadVideoThumbnail` here is the
 * MULTER middleware, and `uploadVideoThumbnail` in src/lib/cloudinary.ts is the STORAGE
 * call. They live in different layers and no file imports both, but if one ever needs to,
 * alias at the import site rather than renaming and breaking the convention.
 *
 * There is deliberately NO video-file equivalent of this middleware. The mimetype gate is
 * hardcoded to `image/`, and the shipped design never receives video bytes at all
 * (STUDIO_BACKEND_STRUCTURE.md §5); uploading video is Appendix A and is deferred.
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
export function uploadVideoThumbnail(req: Request, res: Response, next: NextFunction): void {
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
          message: "Thumbnail image exceeds the 5 MB size limit.",
        });
        return;
      }
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "Invalid thumbnail image upload.",
      });
      return;
    }

    if (uploadError instanceof Error && uploadError.message === "UNSUPPORTED_MIME") {
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "The thumbnail file must be an image.",
      });
      return;
    }

    next(uploadError);
  });
}
