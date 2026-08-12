import { createSingleFileUpload, acceptsAnyImage } from "#src/middleware/upload.js";

/**
 * Multipart parser for the single `logo` field of
 * POST /commerce/organizations/:organizationId/logo (migration `0091`).
 *
 * Kept as its own module so this route's contract — field name, cap, error copy — is
 * stated in one place and changing it changes only this route. The shared error-branch
 * ladder lives in upload.ts, which also answers why that is not the same as sharing the
 * contract.
 *
 * The smallest cap of the four hosted-image routes. A logo is a mark, and a 2 MB ceiling
 * is generous for one; anything larger is a photograph that has been mislabelled, which
 * `validateAndNormalizeImage` would re-encode anyway but which there is no reason to
 * carry into memory first.
 */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 2 MB — a company mark, not a photograph.

export const uploadOrganizationLogoFile = createSingleFileUpload({
  fieldName: "logo",
  maximumBytes: MAX_UPLOAD_BYTES,
  acceptsMediaType: acceptsAnyImage,
  tooLargeMessage: "Logo exceeds the 2 MB size limit.",
  unsupportedMediaTypeMessage: "File must be an image.",
  invalidUploadMessage: "Invalid logo upload.",
});
