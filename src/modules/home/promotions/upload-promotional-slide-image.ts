import { createSingleFileUpload, acceptsAnyImage } from "#src/middleware/upload.js";

/**
 * Multipart parser for the single `image` field of the promotional-slide write routes
 * (POST /promotions/admin/slides and PUT /promotions/admin/slides/:slideId/image).
 *
 * A copy of upload-product-image.ts. Runs INSIDE the route so the global express.json()
 * never touches multipart bodies.
 *
 * NOTE that the create route carries text parts alongside the file — multer parses those
 * into `req.body` as strings, which is why the controller's create schema coerces its
 * numbers and dates rather than expecting typed JSON.
 */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

export const uploadPromotionalSlideImage = createSingleFileUpload({
  fieldName: "image",
  maximumBytes: MAX_UPLOAD_BYTES,
  acceptsMediaType: acceptsAnyImage,
  tooLargeMessage: "Image exceeds the 5 MB size limit.",
  unsupportedMediaTypeMessage: "File must be an image.",
  invalidUploadMessage: "Invalid image upload.",
});
