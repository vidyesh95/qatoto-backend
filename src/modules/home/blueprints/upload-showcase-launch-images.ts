import { ACCEPTED_IMAGE_FORMATS_SENTENCE } from "#src/lib/image.js";
import { acceptsAnyImage, createSingleFileUpload } from "#src/middleware/upload.js";
import { SHOWCASE_DRAFT_PART_MAXIMUM_BYTES } from "#src/modules/home/blueprints/showcase-launch.schemas.js";

/**
 * The two multipart parsers for showcase launches.
 *
 * ONE MODULE FOR BOTH, because `json-body-budget.test.ts` recognizes a multipart route by importing
 * its parser module — and the submit route carries a TEXT part (`draft`) beside its file, so
 * without that import the sweep would read it as a JSON route missing a declared cap.
 *
 * `fieldErrorKey` IS SET ON BOTH, so a refused file arrives as `errors.headingImage` or
 * `errors.image` and the form can show the reason under the control that caused it.
 *
 * The mimetype gate is a header the client chose. The real check is sharp decoding the bytes in the
 * service, which also enforces the square and minimum-size rules the heading image carries.
 */
const MAX_SHOWCASE_IMAGE_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

/** POST /blueprints/showcases — the `draft` JSON text part, then the `headingImage` file. */
export const uploadShowcaseLaunchSubmissionFiles = createSingleFileUpload({
  fieldName: "headingImage",
  maximumBytes: MAX_SHOWCASE_IMAGE_UPLOAD_BYTES,
  acceptsMediaType: acceptsAnyImage,
  tooLargeMessage: "The heading image is over the 5 MB limit.",
  unsupportedMediaTypeMessage: `The heading image must be an image. ${ACCEPTED_IMAGE_FORMATS_SENTENCE}`,
  invalidUploadMessage: "That launch could not be read. Send the draft and one heading image.",
  // Exactly one text part: the draft. A second is a request this route does not understand.
  textFieldLimit: 1,
  textFieldMaximumBytes: SHOWCASE_DRAFT_PART_MAXIMUM_BYTES,
  fieldErrorKey: "headingImage",
});

/** POST /blueprints/showcases/write-up-images — one `image` file and nothing else. */
export const uploadShowcaseWriteUpImageFile = createSingleFileUpload({
  fieldName: "image",
  maximumBytes: MAX_SHOWCASE_IMAGE_UPLOAD_BYTES,
  acceptsMediaType: acceptsAnyImage,
  tooLargeMessage: "That image is over the 5 MB limit.",
  unsupportedMediaTypeMessage: `That file is not an image. ${ACCEPTED_IMAGE_FORMATS_SENTENCE}`,
  invalidUploadMessage: "That image could not be read. Send one image file.",
  textFieldLimit: 0,
  fieldErrorKey: "image",
});
