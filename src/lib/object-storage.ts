import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { config } from "#src/config/index.js";
import type { Result } from "#src/types/index.js";

/**
 * Object storage for documents, backed by Backblaze B2 over its S3-compatible API.
 * Today its only caller is the §10 research-paper library.
 *
 * WHY A SECOND STORAGE MODULE ALONGSIDE `src/lib/cloudinary.ts`. Cloudinary is an
 * IMAGE pipeline in this codebase — all five of its families pass
 * `resource_type: "image"`, and everything reaching them is first re-encoded by
 * `src/lib/image.ts`, which answers NOT_AN_IMAGE for a PDF. Papers are documents. They
 * need bytes stored and handed back unchanged, which is what object storage is.
 *
 * THE CONTRACT IS DELIBERATELY IDENTICAL TO `cloudinary.ts`'s: a lazy
 * `ensureConfigured()` latch, and a `Result` whose error is one of NOT_CONFIGURED /
 * UPLOAD_FAILED / DELETE_FAILED. That is not incidental tidiness — it means every
 * controller's existing 503/502/502 mapping applies verbatim, so a new storage backend
 * did not introduce a new error vocabulary for callers to learn.
 *
 * THE BUCKET IS PRIVATE, AND MUST STAY PRIVATE. Nothing here returns a public URL.
 * Downloads go through `presignPaperDownload`, so:
 *
 *   * the route stays authorizable — a moderator-only or member-only paper is a check
 *     in the controller, not a hope that nobody shares the link;
 *   * the route stays rate-limitable;
 *   * links expire, so one leaked URL is not permanent public access;
 *   * and no bytes traverse the Express process, which is the whole reason not to
 *     proxy the download ourselves.
 *
 * A public bucket would make all four of those untrue at once.
 *
 * KEYS ARE CONTENT-ADDRESSED — `<prefix>/<programId>/papers/<sha256>.pdf`. Same
 * reasoning `cloudinary.ts` records for physical receipts: the key is derived from the
 * bytes, so it agrees with `research_program_paper_content_unq` by construction and a
 * retried upload overwrites itself instead of leaving an orphan. It also means two
 * programs uploading the same paper each hold their own object, which is what the
 * per-program unique index says should happen.
 */

const PAPER_KEY_PREFIX = "research-programs";
const COMMERCE_DOCUMENT_KEY_PREFIX = "commerce-organizations";
const DATA_EXPORT_KEY_PREFIX = "data-exports";
const VIDEO_DOCUMENT_KEY_PREFIX = "videos";
const PRODUCT_DOCUMENT_KEY_PREFIX = "products";

export type ObjectStorageError =
  | { type: "NOT_CONFIGURED" }
  | { type: "UPLOAD_FAILED"; cause: string }
  | { type: "DELETE_FAILED"; cause: string };

/** How long a download link lives. Long enough to click, short enough not to circulate. */
export const PAPER_DOWNLOAD_URL_TTL_SECONDS = 300;
export const PRIVATE_COMMERCE_DOCUMENT_URL_TTL_SECONDS = 300;

/**
 * Five minutes, matching its two siblings above rather than being tuned longer.
 *
 * A VIDEO DOCUMENT IS REACHED BY ANONYMOUS VISITORS, which is the one way it differs from a paper
 * or a commerce document, and it argues for a SHORT life rather than a generous one. The download
 * route re-checks the video's public gate on every request; the presigned URL is the only window in
 * which that check is bypassed, because a presigned URL is a bearer capability. Five minutes is
 * long enough to start a 25 MB download on a poor connection and short enough that a link pasted
 * into a group chat is dead before it is read.
 */
export const VIDEO_DOCUMENT_URL_TTL_SECONDS = 300;

/**
 * §21.3. Five minutes, and for exactly the reason the video document above gives.
 *
 * A PRODUCT DOCUMENT IS REACHED BY ANONYMOUS VISITORS — it hangs off a public listing page with no
 * session required, which makes this and the video route the only two storage paths the open
 * internet can start. The download route re-checks the whole product eligibility chain on every
 * request; the presigned URL is the only window in which that check is bypassed, because a
 * presigned URL is a bearer capability. ⚠️ Do not tune this longer for convenience: a generous TTL
 * turns "this listing was unpublished" into "this link still works for an hour".
 */
export const PRODUCT_DOCUMENT_URL_TTL_SECONDS = 300;
/**
 * A subject-access archive's DOWNLOAD LINK. Same five minutes as its neighbours, and for a
 * sharper reason: this object is every piece of personal data we hold about one person, so
 * a URL that outlived the click is the single worst thing to leave lying in a chat log.
 *
 * NOT THE SAME CLOCK AS `DATA_EXPORT_RETENTION_DAYS` in `data-export.service.ts`. That one
 * says how long the archive EXISTS; this says how long one link to it works. Conflating
 * them would either leave a PII dump in the bucket for a week's worth of link, or expire
 * the export itself every five minutes.
 */
export const DATA_EXPORT_URL_TTL_SECONDS = 300;

interface ConfiguredStorage {
  readonly client: S3Client;
  readonly bucketName: string;
}

let cachedStorage: ConfiguredStorage | null = null;

/**
 * B2 puts its region in the endpoint host: `s3.us-west-004.backblazeb2.com`. The SDK
 * requires *a* region because SigV4 signs with it, so derive it rather than making
 * every deployment set a variable that is already implied.
 *
 * Falls back to `"us-east-1"` — not because the bucket is there, but because B2 accepts
 * any region for a correctly-signed request against an explicit endpoint, and a
 * placeholder that works beats a boot failure over a string nobody reads.
 */
function resolveRegion(endpoint: string): string {
  if (config.BLACKBLAZE_REGION) return config.BLACKBLAZE_REGION;

  const hostMatch = /^s3\.([a-z0-9-]+)\.backblazeb2\.com$/.exec(new URL(endpoint).hostname);
  return hostMatch?.[1] ?? "us-east-1";
}

/**
 * Builds the client once. Returns null when any credential is missing — callers
 * translate that into a NOT_CONFIGURED `Result`, exactly as the Cloudinary latch does.
 */
function ensureConfigured(): ConfiguredStorage | null {
  if (cachedStorage) return cachedStorage;

  const endpoint = config.BLACKBLAZE_ENDPOINT;
  const bucketName = config.BLACKBLAZE_BUCKET_NAME;
  const accessKeyId = config.BLACKBLAZE_S3_KEY_ID;
  const secretAccessKey = config.BLACKBLAZE_S3_APPLICATION_KEY;

  if (!endpoint || !bucketName || !accessKeyId || !secretAccessKey) return null;

  cachedStorage = {
    client: new S3Client({
      endpoint,
      region: resolveRegion(endpoint),
      credentials: { accessKeyId, secretAccessKey },
      // B2 serves `<endpoint>/<bucket>/<key>`, not `<bucket>.<endpoint>/<key>`.
      // Without this the SDK builds a virtual-hosted URL that does not resolve.
      forcePathStyle: true,
    }),
    bucketName,
  };
  return cachedStorage;
}

/** The stable key this program's copy of these exact bytes always lives at. */
export function paperObjectKey(programId: string, contentSha256: string): string {
  return `${PAPER_KEY_PREFIX}/${programId}/papers/${contentSha256}.pdf`;
}

export function commerceDocumentObjectKey(input: {
  readonly organizationId: string;
  readonly documentId: string;
  readonly contentSha256: string;
}): string {
  return [
    COMMERCE_DOCUMENT_KEY_PREFIX,
    encodeURIComponent(input.organizationId),
    "documents",
    encodeURIComponent(input.documentId),
    input.contentSha256,
  ].join("/");
}

/**
 * The stable key this video's copy of these exact bytes always lives at.
 *
 * `encodeURIComponent` on the id, like `commerceDocumentObjectKey` and unlike `paperObjectKey`:
 * both ids are generated UUIDs today, so neither can carry a separator, and encoding costs nothing
 * to be right if that ever stops being true. `contentSha256` is NOT encoded because the column's
 * CHECK constrains it to 64 hex characters — encoding a value that cannot contain a separator would
 * imply the CHECK were not there.
 */
export function videoDocumentObjectKey(videoId: string, contentSha256: string): string {
  return [
    VIDEO_DOCUMENT_KEY_PREFIX,
    encodeURIComponent(videoId),
    "documents",
    `${contentSha256}.pdf`,
  ].join("/");
}

/**
 * §21.3. Where one product document's bytes live.
 *
 * CONTENT-ADDRESSED, so a retried upload converges on the same object instead of duplicating it —
 * the same shape `videoDocumentObjectKey` uses, and the reason neither route needs an idempotency
 * key. The product id is encoded because it is a path segment built from a value this function
 * does not own.
 */
export function productDocumentObjectKey(productId: string, contentSha256: string): string {
  return [
    PRODUCT_DOCUMENT_KEY_PREFIX,
    encodeURIComponent(productId),
    "documents",
    `${contentSha256}.pdf`,
  ].join("/");
}

function describeCause(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/**
 * Stores a paper's bytes and returns the key they live at.
 *
 * The buffer MUST already have been validated by `src/modules/rnd/pdf.ts` and hashed by the
 * caller (§1) — this layer trusts it, in the same way `uploadUserAvatar` trusts an
 * already re-encoded image.
 *
 * `ContentDisposition: attachment` is set at PUT time rather than left to the download
 * link, so the object cannot be coaxed into rendering inline in a browser tab on our
 * storage domain even if a URL escapes. `ContentType` is pinned to `application/pdf`
 * for the same reason: never echo a client's claim about its own bytes.
 */
export async function uploadResearchPaper(input: {
  readonly programId: string;
  readonly contentSha256: string;
  readonly pdfBytes: Buffer;
  /** Used only for the download filename. Sanitized here, never trusted. */
  readonly downloadFileName: string;
}): Promise<Result<{ objectKey: string }, ObjectStorageError>> {
  const storage = ensureConfigured();
  if (!storage) return { success: false, error: { type: "NOT_CONFIGURED" } };

  const objectKey = paperObjectKey(input.programId, input.contentSha256);

  try {
    await storage.client.send(
      new PutObjectCommand({
        Bucket: storage.bucketName,
        Key: objectKey,
        Body: input.pdfBytes,
        ContentType: "application/pdf",
        ContentDisposition: `attachment; filename="${sanitizeDownloadFileName(input.downloadFileName)}"`,
        // Cheap end-to-end integrity: B2 rejects the PUT if what arrived does not hash
        // to this, so a corrupted transfer fails loudly instead of storing bad bytes
        // under a key that claims to describe them.
        ChecksumSHA256: Buffer.from(input.contentSha256, "hex").toString("base64"),
      }),
    );
    return { success: true, value: { objectKey } };
  } catch (uploadError: unknown) {
    return { success: false, error: { type: "UPLOAD_FAILED", cause: describeCause(uploadError) } };
  }
}

/**
 * Stores a video document's bytes and returns the key they live at.
 *
 * IDENTICAL INVARIANTS TO `uploadResearchPaper`, and they are restated rather than shared because
 * each one is a decision about THESE bytes: the buffer must already have been validated by
 * `src/modules/rnd/pdf.ts` and hashed by the caller; `ContentType` is pinned to `application/pdf`
 * rather than echoing what the client claimed; `ContentDisposition: attachment` is set at PUT time
 * so the object cannot be coaxed into rendering inline on our storage domain even if a presigned
 * URL escapes; and `ChecksumSHA256` makes B2 reject a corrupted transfer rather than storing bad
 * bytes under a key that claims to describe them.
 *
 * That last one matters more here than for a paper. The key is content-addressed AND the row is
 * unique on the hash, so bytes stored under a key that does not describe them would make a retry
 * converge on the WRONG object — silently serving one creator's deck from another's row.
 */
export async function uploadVideoDocument(input: {
  readonly videoId: string;
  readonly contentSha256: string;
  readonly pdfBytes: Buffer;
  /** Used only for the download filename. Sanitized here, never trusted. */
  readonly downloadFileName: string;
}): Promise<Result<{ objectKey: string }, ObjectStorageError>> {
  const storage = ensureConfigured();
  if (!storage) return { success: false, error: { type: "NOT_CONFIGURED" } };

  const objectKey = videoDocumentObjectKey(input.videoId, input.contentSha256);

  try {
    await storage.client.send(
      new PutObjectCommand({
        Bucket: storage.bucketName,
        Key: objectKey,
        Body: input.pdfBytes,
        ContentType: "application/pdf",
        // ⚠️ `sanitizePrivateFileName`, NOT `sanitizeDownloadFileName`. The latter is built for a
        // paper TITLE and appends `.pdf`, so an uploaded `deck.pdf` would download as
        // `deck.pdf.pdf`. This one receives a real file name and preserves its extension.
        ContentDisposition: `attachment; filename="${sanitizePrivateFileName(input.downloadFileName)}"`,
        ChecksumSHA256: Buffer.from(input.contentSha256, "hex").toString("base64"),
      }),
    );
    return { success: true, value: { objectKey } };
  } catch (uploadError: unknown) {
    return { success: false, error: { type: "UPLOAD_FAILED", cause: describeCause(uploadError) } };
  }
}

/**
 * Deletes a video document's bytes.
 *
 * Idempotent, like `deleteResearchPaper` and for the same reason: S3 `DeleteObject` succeeds on an
 * absent key, and the desired end state is reached either way. That property is what lets the two
 * cascade-cleanup callers (`deleteVideo`, `anonymizeAccount`) run best-effort without a
 * reconciliation pass — a key already gone is not an error to report to a creator deleting a video.
 */
export async function deleteVideoDocument(
  objectKey: string,
): Promise<Result<{ deleted: boolean }, ObjectStorageError>> {
  const storage = ensureConfigured();
  if (!storage) return { success: false, error: { type: "NOT_CONFIGURED" } };

  try {
    await storage.client.send(
      new DeleteObjectCommand({ Bucket: storage.bucketName, Key: objectKey }),
    );
    return { success: true, value: { deleted: true } };
  } catch (deleteError: unknown) {
    return { success: false, error: { type: "DELETE_FAILED", cause: describeCause(deleteError) } };
  }
}

/**
 * §21.3. Stores one product document's bytes.
 *
 * The `video_document` upload with a different key prefix. `ChecksumSHA256` makes the store verify
 * the hash the key was built from, so a truncated upload fails at the bucket rather than becoming a
 * row pointing at half a PDF.
 */
export async function uploadProductDocument(input: {
  readonly productId: string;
  readonly contentSha256: string;
  readonly pdfBytes: Buffer;
  /** Used only for the download filename. Sanitized here, never trusted. */
  readonly downloadFileName: string;
}): Promise<Result<{ objectKey: string }, ObjectStorageError>> {
  const storage = ensureConfigured();
  if (!storage) return { success: false, error: { type: "NOT_CONFIGURED" } };

  const objectKey = productDocumentObjectKey(input.productId, input.contentSha256);

  try {
    await storage.client.send(
      new PutObjectCommand({
        Bucket: storage.bucketName,
        Key: objectKey,
        Body: input.pdfBytes,
        ContentType: "application/pdf",
        // ⚠️ `sanitizePrivateFileName`, NOT `sanitizeDownloadFileName` — the same trap the video
        // upload documents above. The latter is built for a paper TITLE and appends `.pdf`, so an
        // uploaded `manual.pdf` would download as `manual.pdf.pdf`.
        ContentDisposition: `attachment; filename="${sanitizePrivateFileName(input.downloadFileName)}"`,
        ChecksumSHA256: Buffer.from(input.contentSha256, "hex").toString("base64"),
      }),
    );
    return { success: true, value: { objectKey } };
  } catch (uploadError: unknown) {
    return { success: false, error: { type: "UPLOAD_FAILED", cause: describeCause(uploadError) } };
  }
}

/**
 * §21.3. Deletes a product document's bytes.
 *
 * Idempotent, like its siblings: S3 `DeleteObject` succeeds on an absent key. ⚠️ Unlike the video
 * cascade, the `deleteProduct` caller REFUSES on failure rather than logging and continuing — see
 * the comment there. This function's contract is the same either way; the caller decides.
 */
export async function deleteProductDocument(
  objectKey: string,
): Promise<Result<{ deleted: boolean }, ObjectStorageError>> {
  const storage = ensureConfigured();
  if (!storage) return { success: false, error: { type: "NOT_CONFIGURED" } };

  try {
    await storage.client.send(
      new DeleteObjectCommand({ Bucket: storage.bucketName, Key: objectKey }),
    );
    return { success: true, value: { deleted: true } };
  } catch (deleteError: unknown) {
    return { success: false, error: { type: "DELETE_FAILED", cause: describeCause(deleteError) } };
  }
}

/**
 * §21.3. Mints a short-lived download URL for a product document.
 *
 * ⚠️ THE CALLER MUST HAVE RE-CHECKED ELIGIBILITY FIRST. This function asks no questions — it is the
 * bearer capability the gate protects, not the gate.
 */
export async function presignProductDocumentDownload(
  objectKey: string,
): Promise<Result<{ downloadUrl: string; expiresInSeconds: number }, ObjectStorageError>> {
  return presignPrivateObjectDownload(objectKey, PRODUCT_DOCUMENT_URL_TTL_SECONDS);
}

/**
 * Mints a short-lived download URL for a video document.
 *
 * ⚠️ AUTHORIZATION HAPPENS BEFORE THIS IS CALLED. That warning is on `presignPaperDownload` too,
 * and it carries more weight here: the paper route is `requireAuth`, this one is deliberately open
 * to anonymous visitors, so the ONLY thing standing between the public and these bytes is the
 * controller's re-check of the video's public gate. A presigned URL is a bearer capability and does
 * not know what a video's visibility is.
 */
export async function presignVideoDocumentDownload(
  objectKey: string,
): Promise<Result<{ downloadUrl: string; expiresInSeconds: number }, ObjectStorageError>> {
  return presignPrivateObjectDownload(objectKey, VIDEO_DOCUMENT_URL_TTL_SECONDS);
}

/**
 * Stores private commerce document bytes. Callers authorize and scan the document
 * before making it available; this function never returns a public URL.
 */
export async function uploadPrivateCommerceDocument(input: {
  readonly organizationId: string;
  readonly documentId: string;
  readonly contentSha256: string;
  readonly documentBytes: Buffer;
  readonly mediaType: string;
  readonly downloadFileName: string;
}): Promise<Result<{ objectKey: string }, ObjectStorageError>> {
  const storage = ensureConfigured();
  if (!storage) return { success: false, error: { type: "NOT_CONFIGURED" } };

  const objectKey = commerceDocumentObjectKey(input);
  try {
    await storage.client.send(
      new PutObjectCommand({
        Bucket: storage.bucketName,
        Key: objectKey,
        Body: input.documentBytes,
        ContentType: normalizePrivateMediaType(input.mediaType),
        ContentDisposition: `attachment; filename="${sanitizePrivateFileName(input.downloadFileName)}"`,
        ChecksumSHA256: Buffer.from(input.contentSha256, "hex").toString("base64"),
      }),
    );
    return { success: true, value: { objectKey } };
  } catch (uploadError: unknown) {
    return { success: false, error: { type: "UPLOAD_FAILED", cause: describeCause(uploadError) } };
  }
}

/** Deletes private commerce ciphertext during upload compensation. */
export async function deletePrivateCommerceDocument(
  objectKey: string,
): Promise<Result<{ deleted: boolean }, ObjectStorageError>> {
  const storage = ensureConfigured();
  if (!storage) return { success: false, error: { type: "NOT_CONFIGURED" } };

  try {
    await storage.client.send(
      new DeleteObjectCommand({ Bucket: storage.bucketName, Key: objectKey }),
    );
    return { success: true, value: { deleted: true } };
  } catch (deleteError: unknown) {
    return { success: false, error: { type: "DELETE_FAILED", cause: describeCause(deleteError) } };
  }
}

/**
 * Deletes a paper's bytes.
 *
 * S3 `DeleteObject` is idempotent — deleting an absent key succeeds — which is the
 * behaviour we want and matches `deleteUserAvatar`'s treatment of "already gone" as
 * success: the desired end state is reached either way.
 */
export async function deleteResearchPaper(
  objectKey: string,
): Promise<Result<{ deleted: boolean }, ObjectStorageError>> {
  const storage = ensureConfigured();
  if (!storage) return { success: false, error: { type: "NOT_CONFIGURED" } };

  try {
    await storage.client.send(
      new DeleteObjectCommand({ Bucket: storage.bucketName, Key: objectKey }),
    );
    return { success: true, value: { deleted: true } };
  } catch (deleteError: unknown) {
    return { success: false, error: { type: "DELETE_FAILED", cause: describeCause(deleteError) } };
  }
}

/**
 * Mints a short-lived download URL.
 *
 * AUTHORIZATION HAPPENS BEFORE THIS IS CALLED, never inside it. A presigned URL is a
 * bearer capability: whoever holds it can fetch the bytes until it expires, so the
 * controller must have already proven the caller may read this paper. This function's
 * only job is to hand back a link for a decision someone else made.
 *
 * Reported as UPLOAD_FAILED on error rather than growing a fourth error member: signing
 * is local computation that fails only on a malformed client, the caller's mapping
 * turns it into a 502, and a `SIGN_FAILED` variant would be a case every existing
 * exhaustive switch had to grow for a branch it can barely reach.
 */
export async function presignPaperDownload(
  objectKey: string,
): Promise<Result<{ downloadUrl: string; expiresInSeconds: number }, ObjectStorageError>> {
  return presignPrivateObjectDownload(objectKey, PAPER_DOWNLOAD_URL_TTL_SECONDS);
}

export async function presignPrivateCommerceDocumentDownload(
  objectKey: string,
): Promise<Result<{ downloadUrl: string; expiresInSeconds: number }, ObjectStorageError>> {
  return presignPrivateObjectDownload(objectKey, PRIVATE_COMMERCE_DOCUMENT_URL_TTL_SECONDS);
}

/** Fetches ciphertext for an authorized server-side decrypt-and-stream response. */
export async function downloadPrivateCommerceDocument(
  objectKey: string,
): Promise<Result<{ readonly ciphertext: Buffer }, ObjectStorageError>> {
  const storage = ensureConfigured();
  if (!storage) return { success: false, error: { type: "NOT_CONFIGURED" } };

  try {
    const storedObject = await storage.client.send(
      new GetObjectCommand({ Bucket: storage.bucketName, Key: objectKey }),
    );
    if (!storedObject.Body) {
      return { success: false, error: { type: "UPLOAD_FAILED", cause: "Object body is empty." } };
    }
    const ciphertext = Buffer.from(await storedObject.Body.transformToByteArray());
    return { success: true, value: { ciphertext } };
  } catch (downloadError: unknown) {
    return {
      success: false,
      error: { type: "UPLOAD_FAILED", cause: describeCause(downloadError) },
    };
  }
}

async function presignPrivateObjectDownload(
  objectKey: string,
  expiresInSeconds: number,
): Promise<Result<{ downloadUrl: string; expiresInSeconds: number }, ObjectStorageError>> {
  const storage = ensureConfigured();
  if (!storage) return { success: false, error: { type: "NOT_CONFIGURED" } };

  try {
    const downloadUrl = await getSignedUrl(
      storage.client,
      new GetObjectCommand({ Bucket: storage.bucketName, Key: objectKey }),
      { expiresIn: expiresInSeconds },
    );
    return {
      success: true,
      value: { downloadUrl, expiresInSeconds },
    };
  } catch (signError: unknown) {
    return { success: false, error: { type: "UPLOAD_FAILED", cause: describeCause(signError) } };
  }
}

/**
 * Reduces a paper title to something safe inside a `Content-Disposition` header.
 *
 * Quotes and newlines are the reason this exists: an unescaped `"` closes the filename
 * parameter early and a CR/LF splits the header, so a title is a header-injection
 * vector until it is stripped. Everything outside a conservative allowlist becomes an
 * underscore, and the result is bounded — a header is not the place to discover that a
 * title was 300 characters.
 */
function sanitizeDownloadFileName(rawTitle: string): string {
  const cleaned = rawTitle
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9 ._-]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);

  return cleaned.length > 0 ? `${cleaned}.pdf` : "paper.pdf";
}

function sanitizePrivateFileName(rawFileName: string): string {
  const cleaned = rawFileName
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9 ._-]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : "document.bin";
}

function normalizePrivateMediaType(mediaType: string): string {
  switch (mediaType) {
    case "application/pdf":
    case "image/jpeg":
    case "image/png":
    // Privacy Part 3. WITHOUT THIS CASE a subject-access archive uploads as
    // `application/octet-stream` — the default below is a deliberate refusal to echo a
    // client's claim about bytes, but this type is ours and is not a claim.
    case "application/gzip":
      return mediaType;
    default:
      return "application/octet-stream";
  }
}

/**
 * Whether storage is usable. Exported for the smoke script and for `/ready`, so an
 * operator can tell "no bucket configured" from "bucket configured and refusing" —
 * which are the same 503 to a client and completely different to whoever is on call.
 */
export function isObjectStorageConfigured(): boolean {
  return ensureConfigured() !== null;
}

// ---------------------------------------------------------------------------
// SUBJECT-ACCESS ARCHIVES (Privacy Part 3 — GDPR Art. 15/20).
//
// The most sensitive object this bucket ever holds: one file containing everything the
// platform knows about one named person. Every invariant in the module header applies with
// more force here, and one in particular — THE BUCKET MUST STAY PRIVATE. A public bucket
// would make an enumerable key a standing data breach, and these keys contain a user id.
//
// KEYS ARE NOT CONTENT-ADDRESSED, unlike papers and commerce documents. Those hash their
// bytes so a retried upload overwrites itself; an export is a snapshot of a moment and two
// exports a week apart SHOULD be different objects, so the request id is the identity.
// ---------------------------------------------------------------------------

/** Where one export's archive lives. Segment-encoded like `commerceDocumentObjectKey`. */
export function dataExportObjectKey(input: {
  readonly userId: string;
  readonly requestId: string;
}): string {
  return [
    DATA_EXPORT_KEY_PREFIX,
    encodeURIComponent(input.userId),
    encodeURIComponent(input.requestId),
    "export.json.gz",
  ].join("/");
}

/**
 * Stores one gzipped subject-access archive.
 *
 * The caller has already gzipped and hashed the bytes — this layer trusts them, exactly as
 * `uploadResearchPaper` trusts an already-validated PDF. `ContentDisposition: attachment`
 * is set at PUT time rather than left to the download link, so the object cannot be coaxed
 * into rendering inline on our storage domain even if a URL escapes.
 */
export async function uploadDataExportArchive(input: {
  readonly userId: string;
  readonly requestId: string;
  readonly archiveBytes: Buffer;
  readonly contentSha256: string;
}): Promise<Result<{ objectKey: string }, ObjectStorageError>> {
  const storage = ensureConfigured();
  if (!storage) return { success: false, error: { type: "NOT_CONFIGURED" } };

  const objectKey = dataExportObjectKey(input);
  try {
    await storage.client.send(
      new PutObjectCommand({
        Bucket: storage.bucketName,
        Key: objectKey,
        Body: input.archiveBytes,
        ContentType: normalizePrivateMediaType("application/gzip"),
        ContentDisposition: `attachment; filename="qatoto-data-export.json.gz"`,
        ChecksumSHA256: Buffer.from(input.contentSha256, "hex").toString("base64"),
      }),
    );
    return { success: true, value: { objectKey } };
  } catch (uploadError: unknown) {
    return { success: false, error: { type: "UPLOAD_FAILED", cause: describeCause(uploadError) } };
  }
}

/** A five-minute link to one archive. Minted per request and never stored. */
export async function presignDataExportDownload(
  objectKey: string,
): Promise<Result<{ downloadUrl: string; expiresInSeconds: number }, ObjectStorageError>> {
  return presignPrivateObjectDownload(objectKey, DATA_EXPORT_URL_TTL_SECONDS);
}

/**
 * Removes an archive, at retention expiry or when its subject is anonymized.
 *
 * THE SECOND CALLER IS THE IMPORTANT ONE. An export sitting in the bucket is a complete
 * copy of everything the scrub just erased; leaving it behind would defeat the whole
 * erasure while every row in the database looked correct.
 */
export async function deleteDataExportArchive(
  objectKey: string,
): Promise<Result<{ deleted: boolean }, ObjectStorageError>> {
  const storage = ensureConfigured();
  if (!storage) return { success: false, error: { type: "NOT_CONFIGURED" } };

  try {
    await storage.client.send(
      new DeleteObjectCommand({ Bucket: storage.bucketName, Key: objectKey }),
    );
    return { success: true, value: { deleted: true } };
  } catch (deleteError: unknown) {
    return { success: false, error: { type: "DELETE_FAILED", cause: describeCause(deleteError) } };
  }
}
