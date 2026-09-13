import type { Response } from "express";

import type { TeardownFileValidationError } from "#src/modules/home/blueprints/teardown-file-bytes.js";
import type { TeardownUploadError } from "#src/modules/home/blueprints/teardown-upload.service.js";

/**
 * Error mapping for `POST /blueprints/teardowns/uploads` and the two download routes.
 *
 * ITS OWN FILE, for the reason `teardown-write-error-response.ts` gives about being separate from
 * the showcase one: a merged mapper carries arms unreachable from its own surface, and the `never`
 * default stops being a guarantee about this controller.
 *
 * THE STATUS POLICY:
 *   404 — the teardown, or the file on it, is not reachable. ONE answer for every reason: no such
 *         slug, no such file id, a file that belongs to a different teardown, and a teardown under
 *         quarantine all look identical from outside. Anything finer turns a public route into an
 *         enumeration oracle over withheld files.
 *   409 — the author is holding too many unclaimed uploads.
 *   422 — the bytes are not the format the client declared, or are empty or outsized.
 *   502 — object storage answered, badly. The caller may retry.
 *   503 — object storage is not configured. A deployment fault, not a caller's.
 *
 * ⚠️ 413 NEVER REACHES HERE. Multer answers an oversized body itself, before any handler runs —
 * which is the point of declaring the cap there as well as in the validator.
 */

/** The sentence an author can act on, per refusal. */
function describeValidationRefusal(reason: TeardownFileValidationError): string {
  switch (reason.type) {
    case "EMPTY":
      return "That file is empty.";
    case "TOO_SMALL":
      return "That file is too small to be the format you selected.";
    case "TOO_LARGE":
      return `That file is ${String(reason.byteSize)} bytes, which is over the limit for its format.`;
    /*
     * ⚠️ THE MESSAGE NAMES THE DECLARED FORMAT RATHER THAN GUESSING THE REAL ONE. Telling an author
     * "this looks like a PDF" would mean this layer claiming to know what the bytes are, which is
     * exactly the claim the validator refuses to make.
     */
    case "FORMAT_MISMATCH":
      return `That file does not look like a ${reason.declaredFormat.toUpperCase()} file. Check the format you selected.`;
    case "TRUNCATED":
      return "That file looks cut off in transit. Try uploading it again.";
    default: {
      const exhaustiveCheck: never = reason;
      throw new Error(`Unhandled teardown file refusal: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export function respondTeardownUploadError(res: Response, error: TeardownUploadError): void {
  switch (error.type) {
    case "TEARDOWN_UPLOAD_REJECTED":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "That file could not be accepted.",
        // Keyed to the control that caused it, the way every other upload refusal on this surface is.
        errors: { file: [describeValidationRefusal(error.reason)] },
      });
      return;
    case "TEARDOWN_UPLOAD_STAGING_LIMIT_REACHED":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: `You have ${String(error.limit)} uploaded files waiting on a submission. Submit or discard some before uploading more.`,
      });
      return;
    case "TEARDOWN_UPLOAD_STORAGE_FAILED":
      /*
       * ⚠️ THE SAME 503/502 SPLIT EVERY OTHER STORAGE CALLER USES, and reusing it is the stated
       * payoff of `object-storage.ts` sharing one error vocabulary with `cloudinary.ts`: a new
       * backend did not introduce a new set of statuses for callers to learn.
       */
      if (error.cause.type === "NOT_CONFIGURED") {
        res.status(503).json({
          status: "error",
          statusCode: 503,
          message: "File uploads are unavailable right now.",
        });
        return;
      }
      res.status(502).json({
        status: "error",
        statusCode: 502,
        message: "That file could not be stored. Try again.",
      });
      return;
    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled teardown upload error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * The one answer both download routes give for every reason they refuse.
 *
 * ⚠️ NOT A `Result` ARM, BECAUSE THERE IS NOTHING TO DISCRIMINATE. A missing slug, a missing file,
 * a file on a different teardown and a quarantined teardown are deliberately indistinguishable, so
 * modelling them as separate error types would create a distinction the responder then has to throw
 * away — and somebody would eventually surface it.
 */
export function respondTeardownFileNotFound(res: Response): void {
  res.status(404).json({
    status: "error",
    statusCode: 404,
    message: "That file is not available.",
  });
}
