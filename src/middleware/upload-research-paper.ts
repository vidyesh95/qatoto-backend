import type { NextFunction, Request, Response } from "express";
import multer from "multer";

import { MAX_PAPER_BYTES } from "#src/lib/pdf.js";

/**
 * Multipart parser for the single `paper` field of
 * `POST /research-programs/:programSlug/papers/:paperId/file`
 * (R_AND_D_BACKEND_STRUCTURE.md §10, §11f).
 *
 * Buffers in memory rather than to disk, for the same reason
 * `upload-physical-receipt.ts` does: the raw bytes are needed twice before anything is
 * stored — sha256 for identity and de-duplication, and a header/trailer inspection to
 * prove they are a PDF at all — and a temp file would add a cleanup path for no gain.
 *
 * THE FIRST NON-IMAGE UPLOAD IN THIS CODEBASE. The other five upload middlewares all
 * gate on `mimetype.startsWith("image/")` because their bytes end up in Cloudinary's
 * image pipeline. A paper is a document and goes to object storage
 * (`src/lib/object-storage.ts`) instead. The comment in `upload-physical-receipt.ts`
 * saying documents can only be links was true when written; it is now true only of
 * workshop files.
 *
 * THE MIMETYPE CHECK HERE IS NOT THE VALIDATION. `file.mimetype` is a header the
 * uploading client chose, so it is worth exactly what any request field is worth (§1).
 * It is a cheap first gate that rejects the obvious mistake before a 25 MB buffer is
 * assembled; `validatePdfBytes` reads the actual bytes afterwards, and that is the
 * check that decides. Both run, in that order.
 *
 * The size cap is imported from `src/lib/pdf.ts` rather than restated, because two
 * copies of a limit are two limits that eventually disagree — and the disagreement
 * surfaces as a confusing 422 after a successful 25 MB transfer.
 */
const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PAPER_BYTES, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (file.mimetype === "application/pdf") {
      callback(null, true);
      return;
    }
    callback(new Error("UNSUPPORTED_MIME"));
  },
});

export function uploadResearchPaperFile(req: Request, res: Response, next: NextFunction): void {
  memoryUpload.single("paper")(req, res, (uploadError: unknown) => {
    if (!uploadError) {
      next();
      return;
    }

    if (uploadError instanceof multer.MulterError) {
      if (uploadError.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({
          status: "error",
          statusCode: 413,
          message: "Paper exceeds the 25 MB size limit.",
        });
        return;
      }
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "Invalid paper upload.",
      });
      return;
    }

    if (uploadError instanceof Error && uploadError.message === "UNSUPPORTED_MIME") {
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "A research paper must be a PDF.",
      });
      return;
    }

    next(uploadError);
  });
}
