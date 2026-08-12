import { createSingleFileUpload } from "#src/middleware/upload.js";

export const MAXIMUM_COMMERCE_EVIDENCE_BYTES = 8 * 1024 * 1024;
export const COMMERCE_EVIDENCE_MEDIA_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
] as const;

export function evidenceBytesMatchMediaType(bytes: Buffer, mediaType: string): boolean {
  switch (mediaType) {
    case "application/pdf":
      return bytes.subarray(0, 5).toString("ascii") === "%PDF-";
    case "image/jpeg":
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/png":
      return (
        bytes.length >= 8 &&
        bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      );
    default:
      return false;
  }
}

export const uploadCommerceVerificationEvidence = createSingleFileUpload({
  fieldName: "evidence",
  maximumBytes: MAXIMUM_COMMERCE_EVIDENCE_BYTES,
  acceptsMediaType: (mediaType) =>
    COMMERCE_EVIDENCE_MEDIA_TYPES.some((allowed) => allowed === mediaType),
  tooLargeMessage: "Verification evidence exceeds the 8 MB size limit.",
  unsupportedMediaTypeMessage: "Evidence must be a PDF, JPEG, or PNG file.",
  invalidUploadMessage: "Invalid verification evidence upload.",
  textFieldLimit: 2,
});
