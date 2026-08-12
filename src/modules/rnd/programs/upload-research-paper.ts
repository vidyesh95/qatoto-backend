import { MAX_PAPER_BYTES } from "#src/lib/pdf.js";
import { createSingleFileUpload } from "#src/middleware/upload.js";

/**
 * Multipart parser for the single `paper` field of
 * `POST /research-programs/:programSlug/papers/:paperId/file`
 * (R_AND_D_BACKEND_STRUCTURE.md §10, §11f).
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

export const uploadResearchPaperFile = createSingleFileUpload({
  fieldName: "paper",
  maximumBytes: MAX_PAPER_BYTES,
  acceptsMediaType: (mediaType) => mediaType === "application/pdf",
  tooLargeMessage: "Paper exceeds the 25 MB size limit.",
  unsupportedMediaTypeMessage: "A research paper must be a PDF.",
  invalidUploadMessage: "Invalid paper upload.",
});
