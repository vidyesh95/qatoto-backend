import { createSingleFileUpload, acceptsAnyImage } from "#src/middleware/upload.js";

/**
 * Multipart parser for the single `image` field of the commerce-category write routes
 * (POST /commerce/admin/categories and PATCH /commerce/admin/categories/:categoryId/image).
 *
 * Kept as its own module so this route's contract — field name, cap, error copy — is
 * stated in one place and changing it changes only this route. The shared error-branch
 * ladder lives in upload.ts, which also answers why that is not the same as sharing the
 * contract.
 *
 * Runs INSIDE the route so the global express.json() never touches multipart bodies. The
 * create route carries text parts alongside the file — multer parses those into `req.body`
 * as strings, which is why the controller's create schema coerces rather than expecting
 * typed JSON.
 */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

export const uploadCommerceCategoryImage = createSingleFileUpload({
  fieldName: "image",
  maximumBytes: MAX_UPLOAD_BYTES,
  acceptsMediaType: acceptsAnyImage,
  tooLargeMessage: "Image exceeds the 5 MB size limit.",
  unsupportedMediaTypeMessage: "File must be an image.",
  invalidUploadMessage: "Invalid image upload.",
});
