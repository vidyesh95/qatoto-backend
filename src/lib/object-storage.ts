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

export type ObjectStorageError =
  | { type: "NOT_CONFIGURED" }
  | { type: "UPLOAD_FAILED"; cause: string }
  | { type: "DELETE_FAILED"; cause: string };

/** How long a download link lives. Long enough to click, short enough not to circulate. */
export const PAPER_DOWNLOAD_URL_TTL_SECONDS = 300;
export const PRIVATE_COMMERCE_DOCUMENT_URL_TTL_SECONDS = 300;

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

function describeCause(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/**
 * Stores a paper's bytes and returns the key they live at.
 *
 * The buffer MUST already have been validated by `src/lib/pdf.ts` and hashed by the
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
