import { acceptsAnyImage, createSingleFileUpload } from "#src/middleware/upload.js";

/**
 * Multipart parser for the single `image` field of the anime hero write routes
 * (POST /anime/admin/hero-slides and PATCH /anime/admin/hero-slides/:slideId/image).
 *
 * A copy of upload-promotional-slide-image.ts. Runs INSIDE the route so the global
 * express.json() never touches multipart bodies.
 *
 * NOTE that the create route carries text parts alongside the file — multer parses those
 * into `req.body` as strings, which is why the controller's create schema enumerates
 * "true"/"false" for booleans rather than coercing them.
 */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

export const uploadAnimeHeroSlideImageFile = createSingleFileUpload({
  fieldName: "image",
  maximumBytes: MAX_UPLOAD_BYTES,
  acceptsMediaType: acceptsAnyImage,
  tooLargeMessage: "Image exceeds the 5 MB size limit.",
  unsupportedMediaTypeMessage: "File must be an image.",
  invalidUploadMessage: "Invalid image upload.",
});
