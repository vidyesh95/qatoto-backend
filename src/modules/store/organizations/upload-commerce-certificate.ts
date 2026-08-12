import { createSingleFileUpload } from "#src/middleware/upload.js";
import {
  COMMERCE_EVIDENCE_MEDIA_TYPES,
  MAXIMUM_COMMERCE_EVIDENCE_BYTES,
} from "#src/modules/store/organizations/upload-commerce-verification-evidence.js";

/**
 * Multipart parser for POST /commerce/organizations/:organizationId/certifications (A13).
 *
 * WHY THIS IS NOT `uploadCommerceVerificationEvidence`, which it otherwise duplicates:
 * that middleware sets `fields: 2`, because a verification submit sends exactly
 * `verificationKind` and `documentKind`. A certification sends SIX text parts — standard
 * name, issuer, certificate number, both validity dates and an optional scope summary — so
 * reusing it produced a `LIMIT_FIELD_COUNT` rejection and a flat 422 on every submission.
 *
 * Raising the shared cap to eight was the other option and is worse: the verification route's
 * cap is part of its contract, and widening it to suit a different route is how a limit stops
 * meaning anything. The size cap and the media-type allowlist ARE shared, imported from that
 * module so the two cannot drift.
 *
 * The magic-byte check stays in the controller via `evidenceBytesMatchMediaType`: the
 * multipart `mimetype` is a claim by the uploader, and the decoded bytes are the fact.
 */
const CERTIFICATE_TEXT_FIELD_LIMIT = 8;

export const uploadCommerceCertificate = createSingleFileUpload({
  fieldName: "evidence",
  maximumBytes: MAXIMUM_COMMERCE_EVIDENCE_BYTES,
  acceptsMediaType: (mediaType) =>
    COMMERCE_EVIDENCE_MEDIA_TYPES.some((allowed) => allowed === mediaType),
  tooLargeMessage: "Certificate file exceeds the 8 MB size limit.",
  unsupportedMediaTypeMessage: "A certificate must be a PDF, JPEG or PNG.",
  invalidUploadMessage: "Invalid certificate upload.",
  textFieldLimit: CERTIFICATE_TEXT_FIELD_LIMIT,
});
