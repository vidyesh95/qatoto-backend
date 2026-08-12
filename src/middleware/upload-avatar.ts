import { createSingleFileUpload, acceptsAnyImage } from "#src/middleware/upload.js";

/**
 * Multipart parser for the single `photo` field of PATCH /users/me/photo.
 */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

export const uploadAvatarPhoto = createSingleFileUpload({
  fieldName: "photo",
  maximumBytes: MAX_UPLOAD_BYTES,
  acceptsMediaType: acceptsAnyImage,
  tooLargeMessage: "Photo exceeds the 5 MB size limit.",
  unsupportedMediaTypeMessage: "File must be an image.",
  invalidUploadMessage: "Invalid photo upload.",
});
