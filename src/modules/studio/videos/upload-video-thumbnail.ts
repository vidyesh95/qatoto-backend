import { createSingleFileUpload, acceptsAnyImage } from "#src/middleware/upload.js";

/**
 * Multipart parser for the single `image` field of POST /videos/:videoId/thumbnail.
 *
 * A copy of upload-product-image.ts. The house convention is one upload middleware per
 * surface (avatar, product image, project cover, video thumbnail) rather than one generic
 * factory, so each names its own field and its own error copy. Runs INSIDE the
 * route so the global express.json() never touches multipart bodies.
 *
 * NAME TWIN, same as the product and project pairs: `uploadVideoThumbnail` here is the
 * MULTER middleware, and `uploadVideoThumbnail` in src/lib/cloudinary.ts is the STORAGE
 * call. They live in different layers and no file imports both, but if one ever needs to,
 * alias at the import site rather than renaming and breaking the convention.
 *
 * There is deliberately NO video-file equivalent of this middleware. The mimetype gate is
 * hardcoded to `image/`, and the shipped design never receives video bytes at all
 * (STUDIO_BACKEND_STRUCTURE.md §5); uploading video is Appendix A and is deferred.
 */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

export const uploadVideoThumbnail = createSingleFileUpload({
  fieldName: "image",
  maximumBytes: MAX_UPLOAD_BYTES,
  acceptsMediaType: acceptsAnyImage,
  tooLargeMessage: "Thumbnail image exceeds the 5 MB size limit.",
  unsupportedMediaTypeMessage: "The thumbnail file must be an image.",
  invalidUploadMessage: "Invalid thumbnail image upload.",
});
