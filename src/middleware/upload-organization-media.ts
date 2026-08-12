import { createSingleFileUpload, acceptsAnyImage } from "#src/middleware/upload.js";

/**
 * Multipart parser for the single `image` field of
 * POST /commerce/organizations/:organizationId/media (Appendix A13).
 *
 * Kept as its own module so this route's contract — field name, cap, error copy — is
 * stated in one place and changing it changes only this route. The shared error-branch
 * ladder lives in upload.ts, which also answers why that is not the same as sharing the
 * contract.
 *
 * A factory photo is the EXIF-bearing case that re-encode exists for — see
 * `uploadOrganizationMedia` in src/lib/cloudinary.ts.
 */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8 MB — factory photos run larger than a PDP shot.

export const uploadOrganizationMediaImage = createSingleFileUpload({
  fieldName: "image",
  maximumBytes: MAX_UPLOAD_BYTES,
  acceptsMediaType: acceptsAnyImage,
  tooLargeMessage: "Image exceeds the 8 MB size limit.",
  unsupportedMediaTypeMessage: "File must be an image.",
  invalidUploadMessage: "Invalid image upload.",
});
