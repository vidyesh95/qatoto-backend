import { createSingleFileUpload, acceptsAnyImage } from "#src/middleware/upload.js";

/**
 * Multipart parser for the single `photo` field of
 * POST /commerce/organizations/:organizationId/stakeholders/:stakeholderId/photo
 * (Appendix A13 item 4, migration `0091`).
 *
 * The field is `photo`, not `image`, because that is what the row is called and the field
 * name is part of this route's contract — see upload-organization-media.ts on why these
 * modules stay separate rather than becoming one parameterised helper.
 *
 * The cap is lower than the company-gallery one. A stakeholder portrait is a headshot; a
 * factory photo is a wide shot of a production line, which is why that route allows 8 MB
 * and this one does not need to.
 */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB — a headshot, not a factory floor.

export const uploadStakeholderPhotoFile = createSingleFileUpload({
  fieldName: "photo",
  maximumBytes: MAX_UPLOAD_BYTES,
  acceptsMediaType: acceptsAnyImage,
  tooLargeMessage: "Photo exceeds the 5 MB size limit.",
  unsupportedMediaTypeMessage: "File must be an image.",
  invalidUploadMessage: "Invalid photo upload.",
});
