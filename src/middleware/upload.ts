import type { NextFunction, Request, Response } from "express";
import multer from "multer";

import type { ApiResponse } from "#src/types/index.js";

/**
 * The one multipart parser, configured per route.
 *
 * WHY THIS EXISTS. There were fifteen `upload-*.ts` files here, 1,110 lines, and a diff
 * between any two of them was a field name, a byte cap and three error strings.
 * `upload-project-cover.ts` said so in its own header — "A copy of upload-product-image.ts
 * with the field renamed to `cover`" — and had already drifted: the comment above its
 * handler described the `image` field while the code parsed `cover`. That is what fifteen
 * copies of a control flow buy you.
 *
 * WHAT IS DELIBERATELY STILL PER-ROUTE. The messages. A caller who uploads a 30 MB
 * research paper should be told the paper is too large, not that "the file" is, and the
 * accepted-format sentence is the only place the API explains what a route will take. They
 * are parameters rather than a generated string for that reason.
 *
 * THIS REVERSES A DECISION SIX OF THOSE FILES ARGUED FOR, so the argument deserves an
 * answer rather than a silent deletion. `upload-organization-media.ts` put it best: "the
 * field name, the size cap and the error copy are part of each route's contract, and one
 * parameterised helper would make a change to the product gallery silently change the
 * company gallery."
 *
 * That is a real hazard and it is the reason this is a FACTORY rather than one shared
 * middleware with defaults. Every value the objection names is a required argument with no
 * default, and each route still owns a module that states its own contract in full. Editing
 * `upload-product-image.ts` changes the product gallery and nothing else — the diff is in
 * that file, exactly as before. What the fifteen copies actually shared was never the
 * contract; it was the error-branch ladder, and keeping fifteen copies of that did not
 * protect a single contract. It cost one: `upload-project-cover.ts` documented the `image`
 * field while parsing `cover`, and no reviewer caught it because the drift was inside
 * boilerplate nobody re-reads.
 *
 * THE MIMETYPE GATE IS NOT THE VALIDATION, on any route. `file.mimetype` is a header the
 * uploading client chose, so it is worth exactly what any request field is worth
 * (CLAUDE.md §1.1). It is a cheap first gate that rejects the obvious mistake before a
 * multi-megabyte buffer is assembled; the real check reads the decoded bytes afterwards —
 * `sharp` for images, `validatePdfBytes` for papers, `evidenceBytesMatchMediaType` for
 * commerce evidence. Both run, in that order.
 *
 * Everything buffers in memory rather than to disk: every caller needs the raw bytes
 * immediately (hashing, EXIF, magic-byte checks, or a direct hand-off to Cloudinary), and
 * a temp file would add a cleanup path for no gain.
 */
export interface SingleFileUploadOptions {
  /** The multipart field to parse. Anything else in the body is rejected by multer. */
  readonly fieldName: string;
  /** Cheap first gate, before any decoding. */
  readonly maximumBytes: number;
  /** True if the claimed mimetype is one this route will consider. */
  readonly acceptsMediaType: (mediaType: string) => boolean;
  /** 413. Name the thing, not "the file" — see above. */
  readonly tooLargeMessage: string;
  /** 422, when the claimed mimetype fails `acceptsMediaType`. */
  readonly unsupportedMediaTypeMessage: string;
  /** 422, for any other multer failure (bad boundary, too many parts, too many fields). */
  readonly invalidUploadMessage: string;
  /**
   * Cap on non-file parts. Left unset on routes that send none, because multer's default
   * is generous and a route that sends no text parts gains nothing from a limit. Set it
   * where the count is part of the contract — see `upload-commerce-verification-evidence`,
   * which pins it at 2 precisely so a different route cannot quietly widen it.
   */
  readonly textFieldLimit?: number;
}

/** Thrown by the mimetype gate and caught below; never escapes this module. */
const UNSUPPORTED_MEDIA_TYPE = "UNSUPPORTED_MEDIA_TYPE";

function respond(res: Response, statusCode: 413 | 422, message: string): void {
  res.status(statusCode).json({ status: "error", statusCode, message } satisfies ApiResponse);
}

export function createSingleFileUpload(
  options: SingleFileUploadOptions,
): (req: Request, res: Response, next: NextFunction) => void {
  const parser = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: options.maximumBytes,
      files: 1,
      ...(options.textFieldLimit === undefined ? {} : { fields: options.textFieldLimit }),
    },
    fileFilter: (_req, file, callback) => {
      if (options.acceptsMediaType(file.mimetype)) {
        callback(null, true);
        return;
      }
      callback(new Error(UNSUPPORTED_MEDIA_TYPE));
    },
  });

  return function parseSingleFileUpload(req: Request, res: Response, next: NextFunction): void {
    parser.single(options.fieldName)(req, res, (uploadError: unknown) => {
      if (!uploadError) {
        next();
        return;
      }

      if (uploadError instanceof multer.MulterError && uploadError.code === "LIMIT_FILE_SIZE") {
        respond(res, 413, options.tooLargeMessage);
        return;
      }

      // Checked before the general MulterError branch, and the order is safe either way:
      // the gate above throws a plain Error, so a MulterError can never carry this message.
      if (uploadError instanceof Error && uploadError.message === UNSUPPORTED_MEDIA_TYPE) {
        respond(res, 422, options.unsupportedMediaTypeMessage);
        return;
      }

      if (uploadError instanceof multer.MulterError) {
        respond(res, 422, options.invalidUploadMessage);
        return;
      }

      // Not multer's and not ours — a programmer or environment fault, which belongs to
      // the error handler rather than to a 422 that would misreport it as the caller's.
      next(uploadError);
    });
  };
}

/** The gate for every route whose bytes end up in an image pipeline. */
export const acceptsAnyImage = (mediaType: string): boolean => mediaType.startsWith("image/");
