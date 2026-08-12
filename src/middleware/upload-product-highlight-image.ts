import { createSingleFileUpload, acceptsAnyImage } from "#src/middleware/upload.js";

/**
 * Multipart parser for the single `image` field of
 * POST /products/:productId/highlights/:highlightId/image (Appendix A6, migration `0091`).
 *
 * Kept as its own module so this route's contract — field name, cap, error copy — is
 * stated in one place and changing it changes only this route. The shared error-branch
 * ladder lives in upload.ts, which also answers why that is not the same as sharing the
 * contract.
 */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8 MB — a highlight card runs to a full-bleed shot.

export const uploadProductHighlightImageFile = createSingleFileUpload({
  fieldName: "image",
  maximumBytes: MAX_UPLOAD_BYTES,
  acceptsMediaType: acceptsAnyImage,
  tooLargeMessage: "Image exceeds the 8 MB size limit.",
  unsupportedMediaTypeMessage: "File must be an image.",
  invalidUploadMessage: "Invalid image upload.",
});
