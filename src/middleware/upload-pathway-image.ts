import type { Request, Response, NextFunction } from "express";
import multer from "multer";

/**
 * Multipart parser for the single `image` field of
 * POST /commerce/pathways/:pathwayId/images/:imageSlot (§15.2, migration `0091`).
 *
 * Separate module per route contract — see upload-organization-media.ts.
 *
 * This is the route the hosting decision was made for. A pathway may be PROPOSED by a
 * seller (§15.5) and published by a moderator, after which the row freezes — so the store
 * presents the art as reviewed. Holding the bytes is what makes that true; under the
 * previous client-supplied URL the moderator reviewed a pointer the seller could
 * repoint at will.
 */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8 MB — hero art is full-bleed.

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

export function uploadPathwayImageFile(req: Request, res: Response, next: NextFunction): void {
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
