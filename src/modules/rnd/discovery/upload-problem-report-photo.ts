import { ACCEPTED_IMAGE_FORMATS_SENTENCE } from "#src/lib/image.js";
import { acceptsAnyImage, createSingleFileUpload } from "#src/middleware/upload.js";

/**
 * POST /discovery/problem-reports/photos — one `photo` file and nothing else.
 *
 * The mimetype gate is a header the client chose. The real check is sharp decoding the bytes in
 * `uploadProblemReportPhoto`, which is also where the EXIF/GPS is dropped.
 */
const MAX_PROBLEM_REPORT_PHOTO_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

export const uploadProblemReportPhotoFile = createSingleFileUpload({
  fieldName: "photo",
  maximumBytes: MAX_PROBLEM_REPORT_PHOTO_UPLOAD_BYTES,
  acceptsMediaType: acceptsAnyImage,
  tooLargeMessage: "That photo is over the 5 MB limit.",
  unsupportedMediaTypeMessage: `That file is not a photo. ${ACCEPTED_IMAGE_FORMATS_SENTENCE}`,
  invalidUploadMessage: "That photo could not be read. Send one image file.",
  textFieldLimit: 0,
  fieldErrorKey: "photo",
});
