import type { Request, Response, NextFunction } from "express";
import multer from "multer";

/**
 * Multipart parser for the single `logo` field of
 * POST /commerce/organizations/:organizationId/logo (migration `0091`).
 *
 * Separate module per route contract — see upload-organization-media.ts.
 *
 * The smallest cap of the four hosted-image routes. A logo is a mark, and a 2 MB ceiling
 * is generous for one; anything larger is a photograph that has been mislabelled, which
 * `validateAndNormalizeImage` would re-encode anyway but which there is no reason to
 * carry into memory first.
 */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 2 MB — a company mark, not a photograph.

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

export function uploadOrganizationLogoFile(req: Request, res: Response, next: NextFunction): void {
  memoryUpload.single("logo")(req, res, (uploadError: unknown) => {
    if (!uploadError) {
      next();
      return;
    }

    if (uploadError instanceof multer.MulterError) {
      if (uploadError.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({
          status: "error",
          statusCode: 413,
          message: "Logo exceeds the 2 MB size limit.",
        });
        return;
      }
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "Invalid logo upload.",
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
