import { createSingleFileUpload, acceptsAnyImage } from "#src/middleware/upload.js";

/**
 * Multipart parser for the single `receipt` field of
 * `POST …/proof-of-effort/physical-receipts` (R_AND_D_BACKEND_STRUCTURE.md §9, §11e).
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

export const uploadPhysicalReceipt = createSingleFileUpload({
  fieldName: "receipt",
  maximumBytes: MAX_RECEIPT_BYTES,
  acceptsMediaType: acceptsAnyImage,
  tooLargeMessage: "Receipt exceeds the 10 MB size limit.",
  unsupportedMediaTypeMessage:
    "A receipt must be a photograph. CAD files and documents are linked through the workshop instead.",
  invalidUploadMessage: "Invalid receipt upload.",
});
