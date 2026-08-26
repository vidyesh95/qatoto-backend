import { createSingleFileUpload, acceptsAnyImage } from "#src/middleware/upload.js";

/**
 * Multipart parser for the single `image` field of POST /series/:seriesId/poster.
 *
 * A copy of upload-video-thumbnail.ts, which is a copy of upload-product-image.ts. The house
 * convention is one upload middleware per surface (avatar, product image, project cover, video
 * thumbnail, series poster) rather than one generic factory, so each names its own field and
 * its own error copy — the copy is what a creator reads when the upload is refused. Runs
 * INSIDE the route so the global express.json() never touches multipart bodies.
 *
 * NAME TWIN, as with the product, project and thumbnail pairs: `uploadSeriesPoster` here is
 * the MULTER middleware, and `uploadSeriesPoster` in src/lib/cloudinary.ts is the STORAGE
 * call. Alias at the import site if one file ever needs both.
 *
 * FIVE MEGABYTES, matching the thumbnail rather than the 8 MB trade-document limit. A poster
 * is a catalogue image rendered at card size; the ceiling exists to stop somebody uploading a
 * print master, and the re-encode in `replaceSeriesPoster` shrinks whatever arrives anyway.
 */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

export const uploadSeriesPoster = createSingleFileUpload({
  fieldName: "image",
  maximumBytes: MAX_UPLOAD_BYTES,
  acceptsMediaType: acceptsAnyImage,
  tooLargeMessage: "Poster image exceeds the 5 MB size limit.",
  unsupportedMediaTypeMessage: "The poster file must be an image.",
  invalidUploadMessage: "Invalid poster image upload.",
});
