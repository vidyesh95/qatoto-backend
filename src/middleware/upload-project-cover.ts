import { createSingleFileUpload, acceptsAnyImage } from "#src/middleware/upload.js";

/**
 * Multipart parser for the single `cover` field of POST /research-projects/:projectSlug/cover.
 *
 * A copy of upload-product-image.ts with the field renamed to `cover`. Runs INSIDE the
 * route so the global express.json() never touches multipart bodies.
 */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

export const uploadProjectCover = createSingleFileUpload({
  fieldName: "cover",
  maximumBytes: MAX_UPLOAD_BYTES,
  acceptsMediaType: acceptsAnyImage,
  tooLargeMessage: "Cover image exceeds the 5 MB size limit.",
  unsupportedMediaTypeMessage: "The cover file must be an image.",
  invalidUploadMessage: "Invalid cover image upload.",
});
