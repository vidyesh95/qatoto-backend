import type { Request, Response, NextFunction } from "express";
import multer from "multer";

/**
 * Multipart parser for the single `photo` field of
 * POST /commerce/organizations/:organizationId/stakeholders/:stakeholderId/photo
 * (Appendix A13 item 4, migration `0091`).
 *
 * The field is `photo`, not `image`, because that is what the row is called and the field
 * name is part of this route's contract — see upload-organization-media.ts on why these
 * modules stay separate rather than becoming one parameterised helper.
 *
 * The cap is lower than the company-gallery one. A stakeholder portrait is a headshot; a
 * factory photo is a wide shot of a production line, which is why that route allows 8 MB
 * and this one does not need to.
 */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB — a headshot, not a factory floor.

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

export function uploadStakeholderPhotoFile(req: Request, res: Response, next: NextFunction): void {
  memoryUpload.single("photo")(req, res, (uploadError: unknown) => {
    if (!uploadError) {
      next();
      return;
    }

    if (uploadError instanceof multer.MulterError) {
      if (uploadError.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({
          status: "error",
          statusCode: 413,
          message: "Photo exceeds the 5 MB size limit.",
        });
        return;
      }
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "Invalid photo upload.",
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
