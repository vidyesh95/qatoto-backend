import { createSingleFileUpload } from "#src/middleware/upload.js";
import { MAX_PAPER_BYTES } from "#src/modules/rnd/pdf.js";

/**
 * Multipart parser for the single `document` field of `POST /videos/:videoId/documents`.
 *
 * THE SECOND NON-IMAGE UPLOAD IN THIS CODEBASE, after the research paper it copies. The other five
 * upload middlewares gate on `mimetype.startsWith("image/")` because their bytes end up in
 * Cloudinary's image pipeline, which hardcodes `resource_type: "image"` and runs everything through
 * sharp — and sharp answers NOT_AN_IMAGE for a PDF. A deck is a document and goes to object storage.
 *
 * THE MIMETYPE CHECK HERE IS NOT THE VALIDATION. `file.mimetype` is a header the uploading client
 * chose, so it is worth exactly what any request field is worth (§1). It is a cheap first gate that
 * rejects the obvious mistake before a 25 MB buffer is assembled; `validatePdfBytes` reads the
 * actual bytes afterwards, and that is the check that decides. Both run, in that order.
 *
 * ⚠️ `MAX_PAPER_BYTES` IS REUSED RATHER THAN A SECOND CAP INVENTED, and the paper-shaped name is
 * not a mistake to "fix" by defining `MAX_VIDEO_DOCUMENT_BYTES` beside it. `validatePdfBytes`
 * hardcodes this constant in its own `TOO_LARGE` branch, so a different limit here would mean
 * either parameterising a validator that has its own test suite, or two limits that eventually
 * disagree — and that disagreement surfaces as a confusing 422 AFTER a successful 25 MB transfer.
 * A deck and a paper are the same class of object; one cap is correct.
 */
export const uploadVideoDocumentFile = createSingleFileUpload({
  fieldName: "document",
  maximumBytes: MAX_PAPER_BYTES,
  acceptsMediaType: (mediaType) => mediaType === "application/pdf",
  tooLargeMessage: "Document exceeds the 25 MB size limit.",
  unsupportedMediaTypeMessage: "A video document must be a PDF.",
  invalidUploadMessage: "Invalid document upload.",
});
