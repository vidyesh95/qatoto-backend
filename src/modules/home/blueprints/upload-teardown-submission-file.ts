import { createSingleFileUpload } from "#src/middleware/upload.js";
import { maximumBytesForTeardownUpload } from "#src/modules/home/blueprints/teardown-file-bytes.js";

/**
 * The multipart parser for `POST /blueprints/teardowns/uploads` — one `file`, one `format` text part.
 *
 * ⚠️ THE MIMETYPE GATE HERE IS WEAKER THAN ON ANY OTHER UPLOAD ON THIS PLATFORM, AND SAYING SO IS
 * PART OF THE DESIGN. The five image parsers gate on `image/*`, which is a real narrowing because
 * their bytes then go through sharp. Browsers send `application/octet-stream` for `.step`, `.stl`
 * and `.dxf` far more often than any registered type — so this list must admit it, and admitting it
 * means the gate refuses almost nothing. It is a cheap first pass that rejects the obvious mistake
 * before a 50 MB buffer is assembled, and it is NOT the validation.
 *
 * WHAT IS: the `format` text part, which the client must send and `teardown-file-bytes.ts` then
 * proves against the actual bytes. Same shape as `evidenceBytesMatchMediaType` on the commerce
 * verification upload — make the client name what it is sending, then check.
 *
 * ⚠️ THE CAP HERE ADMITS THE LARGEST FORMAT, and the per-format ceilings narrow it afterwards. A
 * 40 MB PDF is refused by `validatePdfBytes`'s own 25 MiB branch rather than by multer, which is
 * the right order: one number lives in the validator that owns it, and this one exists only so a
 * hostile client cannot stream an unbounded body.
 */
export const uploadTeardownSubmissionFileParser = createSingleFileUpload({
  fieldName: "file",
  maximumBytes: maximumBytesForTeardownUpload(),
  acceptsMediaType: (mediaType) =>
    mediaType === "application/pdf" ||
    mediaType === "application/octet-stream" ||
    mediaType === "model/step" ||
    mediaType === "application/step" ||
    mediaType === "model/stl" ||
    mediaType === "application/sla" ||
    mediaType === "image/vnd.dxf" ||
    mediaType === "application/dxf" ||
    mediaType === "text/plain",
  tooLargeMessage: "That file is over the 50 MB limit.",
  unsupportedMediaTypeMessage: "Upload a PDF, STEP, STL or DXF file.",
  invalidUploadMessage: "That upload could not be read. Send one file and its format.",
  // Exactly one text part: `format`. A second is a request this route does not understand.
  textFieldLimit: 1,
  fieldErrorKey: "file",
});
