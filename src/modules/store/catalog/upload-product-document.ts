import { createSingleFileUpload } from "#src/middleware/upload.js";
import { MAX_PAPER_BYTES } from "#src/modules/rnd/pdf.js";

/**
 * Multipart parser for the single `document` field of POST /products/:id/documents (§21.3).
 *
 * Kept as its own module so this route's contract — field name, cap, error copy — is stated in one
 * place and changing it changes only this file. The shared error-branch ladder lives in
 * `upload.ts`, which also explains why that is not the same as sharing the contract.
 *
 * ⚠️ THE MIMETYPE GATE IS NOT THE VALIDATION. `file.mimetype` is a header the uploading client
 * chose, so it is worth exactly what any request field is worth. This is a cheap first gate that
 * rejects the obvious mistake before a 25 MB buffer is assembled; the real check is
 * `validatePdfBytes` reading the decoded bytes in the service. Both run, in that order — and a
 * PUBLIC download path is the worst possible place to learn that lesson twice.
 *
 * `MAX_PAPER_BYTES` is imported rather than re-declared, the same way the video document upload
 * imports it: a second constant is a second thing to keep in sync, and the R&D paper cap is
 * already the number this codebase means by "a PDF a person uploads".
 */
export const uploadProductDocumentFile = createSingleFileUpload({
  fieldName: "document",
  maximumBytes: MAX_PAPER_BYTES,
  acceptsMediaType: (mediaType) => mediaType === "application/pdf",
  tooLargeMessage: "Document exceeds the 25 MB size limit.",
  unsupportedMediaTypeMessage: "A product document must be a PDF.",
  invalidUploadMessage: "Invalid document upload.",
});
