import { createHash } from "node:crypto";

import { and, count, eq, isNull } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { teardownSubmissionFileUpload } from "#src/db/schema.js";
import {
  teardownFileObjectKey,
  uploadTeardownFile,
  type ObjectStorageError,
} from "#src/lib/object-storage.js";
import {
  isTeardownFileValidationError,
  validateTeardownFileBytes,
  type TeardownFileValidationError,
  type TeardownUploadFormat,
} from "#src/modules/home/blueprints/teardown-file-bytes.js";
import type { Result } from "#src/types/index.js";

/**
 * `POST /blueprints/teardowns/uploads` — one CAD file or PDF, staged until a submission claims it.
 *
 * ⚠️ UPLOAD-BEFORE-SUBMIT, COPYING THE SHOWCASE WRITE-UP IMAGE PATTERN, WITH ONE DELIBERATE
 * DIFFERENCE. There, the claim happens at SUBMIT and the sweeper reaps anything still unclaimed
 * after a day. Here the claim also happens at submit — NOT at publish — and that is the whole
 * reason to say so: a teardown submission can sit in the review queue for weeks, so claiming at
 * publish would let the sweeper delete an author's files out from under a pending submission. The
 * sweeper only ever touches rows whose `submission_id` is still NULL.
 *
 * ⚠️ NO IDEMPOTENCY KEY, AND THE STORAGE LAYER IS WHY. The object key is content-addressed on
 * `(uploader, sha256)`, so the same author re-uploading the same bytes converges on the same object
 * and — via the unique index on that key — the same row. `attachVideoDocument` states the rule this
 * follows: the storage layer is idempotent by construction, which is stronger than a replayed
 * response, so a retry is answered as SUCCESS with the existing row rather than as a 409. A creator
 * who double-clicked has the outcome they asked for.
 */

/** Eight documents plus eight fabrication files is the submission's own ceiling; this matches it. */
export const MAX_UNCLAIMED_TEARDOWN_UPLOADS_PER_AUTHOR = 16;

export type TeardownUploadError =
  | { readonly type: "TEARDOWN_UPLOAD_REJECTED"; readonly reason: TeardownFileValidationError }
  | { readonly type: "TEARDOWN_UPLOAD_STAGING_LIMIT_REACHED"; readonly limit: number }
  | { readonly type: "TEARDOWN_UPLOAD_STORAGE_FAILED"; readonly cause: ObjectStorageError };

export interface TeardownUploadReceipt {
  readonly uploadId: string;
  readonly format: TeardownUploadFormat;
  readonly byteSize: number;
  readonly originalFileName: string;
}

export async function uploadTeardownSubmissionFile(input: {
  readonly uploaderUserId: string;
  readonly declaredFormat: TeardownUploadFormat;
  readonly fileBytes: Buffer;
  readonly originalFileName: string;
}): Promise<Result<TeardownUploadReceipt, TeardownUploadError>> {
  /*
   * 1. THE CEILING FIRST, BEFORE THE BYTES ARE READ OR STORED. A flood is refused before 50 MB of
   *    hashing and a round trip to the bucket. It is A READ, NOT A LOCK — two uploads racing on an
   *    author's last slot can both see the same count and both insert, which is the same overshoot
   *    `uploadShowcaseWriteUpImage` accepts for the same reason: the limiter bounds the race, and
   *    the cost of exceeding the ceiling by one is a row the sweeper takes within a day.
   */
  const [stagingRow] = await db
    .select({ unclaimedUploadCount: count() })
    .from(teardownSubmissionFileUpload)
    .where(
      and(
        eq(teardownSubmissionFileUpload.uploadedByUserId, input.uploaderUserId),
        isNull(teardownSubmissionFileUpload.submissionId),
      ),
    );
  if ((stagingRow?.unclaimedUploadCount ?? 0) >= MAX_UNCLAIMED_TEARDOWN_UPLOADS_PER_AUTHOR) {
    return {
      success: false,
      error: {
        type: "TEARDOWN_UPLOAD_STAGING_LIMIT_REACHED",
        limit: MAX_UNCLAIMED_TEARDOWN_UPLOADS_PER_AUTHOR,
      },
    };
  }

  /*
   * 2. THE BYTES DECIDE, NOT THE MIMETYPE THE MULTIPART LAYER SAW. That header is a claim the
   *    client made about its own upload; this proves the framing matches the format it declared.
   */
  const validated = validateTeardownFileBytes(input.declaredFormat, input.fileBytes);
  if (isTeardownFileValidationError(validated)) {
    return { success: false, error: { type: "TEARDOWN_UPLOAD_REJECTED", reason: validated } };
  }

  const contentSha256 = createHash("sha256").update(input.fileBytes).digest("hex");
  const objectKey = teardownFileObjectKey(input.uploaderUserId, contentSha256, validated.format);

  /*
   * 3. STORE, THEN INSERT. An object with no row is a leak the sweeper finds; a row with no object
   *    is a download link that 502s. `attachVideoDocument` orders it this way and says why.
   */
  const storedResult = await uploadTeardownFile({
    uploadedByUserId: input.uploaderUserId,
    contentSha256,
    format: validated.format,
    fileBytes: input.fileBytes,
    downloadFileName: input.originalFileName,
  });
  if (!storedResult.success) {
    return {
      success: false,
      error: { type: "TEARDOWN_UPLOAD_STORAGE_FAILED", cause: storedResult.error },
    };
  }

  /*
   * 4. CONVERGE RATHER THAN DUPLICATE. `object_storage_key` is unique and derived from the bytes,
   *    so a retry finds the row it already wrote. `onConflictDoNothing().returning()` gives an
   *    empty array in that case, and the re-select below turns it into the SAME receipt — a repeat
   *    upload is a success, not a 409.
   */
  const inserted = await db
    .insert(teardownSubmissionFileUpload)
    .values({
      uploadedByUserId: input.uploaderUserId,
      objectStorageKey: objectKey,
      contentSha256,
      byteSize: validated.byteSize,
      format: validated.format,
      originalFileName: input.originalFileName,
    })
    .onConflictDoNothing()
    .returning({ id: teardownSubmissionFileUpload.id });

  const uploadId = inserted[0]?.id ?? (await findExistingUploadId(objectKey));
  if (uploadId === null) {
    /*
     * The key is unique and we just wrote or matched it, so this is unreachable — and it is a
     * REFUSAL rather than a throw because the bytes are already stored: an author who sees a 5xx
     * retries, and a retry converges. A throw here would be an unrecoverable error about a
     * recoverable situation.
     */
    return {
      success: false,
      error: {
        type: "TEARDOWN_UPLOAD_STORAGE_FAILED",
        cause: { type: "UPLOAD_FAILED", cause: "The upload was stored but no row could be read." },
      },
    };
  }

  return {
    success: true,
    value: {
      uploadId,
      format: validated.format,
      // ⚠️ THE MEASURED SIZE, never a number the client sent — the write-up image rule verbatim.
      byteSize: validated.byteSize,
      originalFileName: input.originalFileName,
    },
  };
}

async function findExistingUploadId(objectKey: string): Promise<string | null> {
  const [existing] = await db
    .select({ id: teardownSubmissionFileUpload.id })
    .from(teardownSubmissionFileUpload)
    .where(eq(teardownSubmissionFileUpload.objectStorageKey, objectKey))
    .limit(1);
  return existing?.id ?? null;
}
