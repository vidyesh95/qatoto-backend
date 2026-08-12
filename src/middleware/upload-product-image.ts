import { createSingleFileUpload, acceptsAnyImage } from "#src/middleware/upload.js";

/**
 * Multipart parser for the single `image` field of POST /products/:id/images.
 *
 * A copy of upload-avatar.ts with the field renamed to `image`. Runs INSIDE the
 * route so the global express.json() never touches multipart bodies.
 */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

export const uploadProductImage = createSingleFileUpload({
  fieldName: "image",
  maximumBytes: MAX_UPLOAD_BYTES,
  acceptsMediaType: acceptsAnyImage,
  tooLargeMessage: "Image exceeds the 5 MB size limit.",
  unsupportedMediaTypeMessage: "File must be an image.",
  invalidUploadMessage: "Invalid image upload.",
});
