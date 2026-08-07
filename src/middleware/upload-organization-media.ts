import type { Request, Response, NextFunction } from "express";
import multer from "multer";

/**
 * Multipart parser for the single `image` field of
 * POST /commerce/organizations/:organizationId/media (Appendix A13).
 *
 * The same shape as upload-product-image.ts, and deliberately a separate module rather
 * than a shared one: the field name, the size cap and the error copy are part of each
 * route's contract, and one parameterised helper would make a change to the product
 * gallery silently change the company gallery.
 *
 * Buffers in memory so the bytes go straight to sharp and then Cloudinary. The byte cap
 * here is a CHEAP first gate before any decoding; `validateAndNormalizeImage` re-checks the
 * real image afterwards, because the multipart headers are untrusted (CLAUDE.md §1.1).
 *
 * A factory photo is the EXIF-bearing case that re-encode exists for — see
 * `uploadOrganizationMedia` in src/lib/cloudinary.ts.
 */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8 MB — factory photos run larger than a PDP shot.

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

export function uploadOrganizationMediaImage(
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
