import type { NextFunction, Request, Response } from "express";
import multer from "multer";

/**
 * Multipart parser for the single `receipt` field of
 * `POST …/proof-of-effort/physical-receipts` (R_AND_D_BACKEND_STRUCTURE.md §9, §11e).
 *
 * Buffers in memory rather than to disk, because the RAW bytes are needed three times
 * before anything is stored — sha256 for identity, a perceptual hash for similarity, and
 * an EXIF read for capture time — and `validateAndNormalizeImage` strips metadata on
 * re-encode by design. Writing a temp file would add a cleanup path for no gain.
 *
 * The byte cap here is a CHEAP FIRST GATE that stops an oversized upload before any
 * decoding; sharp re-checks the real image afterwards, because the multipart headers are
 * untrusted (CLAUDE.md §1.1). A receipt is a phone photograph, so 10 MB is generous
 * without inviting someone to stream a video into a memory buffer.
 *
 * IMAGES ONLY, IN THIS PHASE. `receiptKind` carries `cad_file`, but a CAD model is not an
 * image and there is nowhere to put its bytes: object storage is deferred (Appendix A) and
 * workshop files are links (§8). A CAD upload therefore fails the format check with a
 * message that says so, rather than being silently accepted and never analyzed.
 */
const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_RECEIPT_BYTES, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (file.mimetype.startsWith("image/")) {
      callback(null, true);
      return;
    }
    callback(new Error("UNSUPPORTED_MIME"));
  },
});

export function uploadPhysicalReceipt(req: Request, res: Response, next: NextFunction): void {
  memoryUpload.single("receipt")(req, res, (uploadError: unknown) => {
    if (!uploadError) {
      next();
      return;
    }

    if (uploadError instanceof multer.MulterError) {
      if (uploadError.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({
          status: "error",
          statusCode: 413,
          message: "Receipt exceeds the 10 MB size limit.",
        });
        return;
      }
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "Invalid receipt upload.",
      });
      return;
    }

    if (uploadError instanceof Error && uploadError.message === "UNSUPPORTED_MIME") {
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message:
          "A receipt must be a photograph. CAD files and documents are linked through the workshop instead.",
      });
      return;
    }

    next(uploadError);
  });
}
