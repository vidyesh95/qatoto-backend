import { createSingleFileUpload, acceptsAnyImage } from "#src/middleware/upload.js";

/**
 * Multipart parser for the single `image` field of
 * POST /commerce/pathways/:pathwayId/images/:imageSlot (§15.2, migration `0091`).
 *
 * Kept as its own module so this route's contract — field name, cap, error copy — is
 * stated in one place and changing it changes only this route. The shared error-branch
 * ladder lives in upload.ts, which also answers why that is not the same as sharing the
 * contract.
 *
 * This is the route the hosting decision was made for. A pathway may be PROPOSED by a
 * seller (§15.5) and published by a moderator, after which the row freezes — so the store
 * presents the art as reviewed. Holding the bytes is what makes that true; under the
 * previous client-supplied URL the moderator reviewed a pointer the seller could
 * repoint at will.
 */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8 MB — hero art is full-bleed.

export const uploadPathwayImageFile = createSingleFileUpload({
  fieldName: "image",
  maximumBytes: MAX_UPLOAD_BYTES,
  acceptsMediaType: acceptsAnyImage,
  tooLargeMessage: "Image exceeds the 8 MB size limit.",
  unsupportedMediaTypeMessage: "File must be an image.",
  invalidUploadMessage: "Invalid image upload.",
});
