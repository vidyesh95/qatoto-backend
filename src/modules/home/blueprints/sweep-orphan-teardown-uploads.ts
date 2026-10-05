import { and, inArray, isNull, lt, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  blueprintDraft,
  teardownAssembly,
  teardownDocument,
  teardownManufacturingFile,
  teardownPart,
  teardownSubmissionFileUpload,
} from "#src/db/schema.js";
import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import { logger } from "#src/lib/logger.js";
import { deleteTeardownFile } from "#src/lib/object-storage.js";

/**
 * The daily sweep of teardown files an author staged and never submitted.
 *
 * ⚠️ IT WAS DESCRIBED BEFORE IT EXISTED. `teardown_submission_file_upload`'s schema comment and
 * the submit service both named this job from the day uploads shipped (2026-09-13), and nothing
 * implemented it, so every abandoned upload stayed in the bucket for good — up to sixteen per
 * author, at up to 50 MB each. Built 2026-10-05 against that description.
 *
 * WHAT "UNCLAIMED" MEANS, AND THE TWO THINGS THAT ARE NOT:
 *
 *   - `submission_id IS NULL` — no submit has claimed it. A submitted file is claimed for good,
 *     however long it sits in the review queue; that is why the claim happens at submit rather
 *     than at publish (the schema comment says so).
 *   - ⚠️ NOT NAMED BY ONE OF ITS AUTHOR'S SAVED TEARDOWN DRAFTS. A draft keeps `uploadId`s inside
 *     its opaque `document_json`, and without this conjunct every file in a draft resumed after a
 *     day would be a dead reference with nothing failing to say why — the exact trap
 *     `sweep-orphan-showcase-images` records for its `draft_id` column. The server never PARSES a
 *     draft, so this is a substring test for the upload's uuid within that author's own teardown
 *     drafts; a uuid does not occur by accident. When the draft itself is swept as stale, the
 *     upload becomes unclaimed and the next run takes it.
 *
 * ⚠️ BYTES GO FIRST, INSIDE THE ROW LOCK — the OPPOSITE order to `sweep-orphan-showcase-images`,
 * and deliberately. That sweep can delete rows first because it LISTS Cloudinary afterwards and
 * catches any asset a failed delete left behind. Nothing lists this bucket: account erasure finds an
 * author's teardown bytes only through rows (`collectTeardownFileObjectKeys`), so a row deleted
 * before its bytes would turn one failed storage call into a file no erasure could ever reach. So
 * each run locks a batch of eligible rows (`FOR UPDATE SKIP LOCKED`), deletes the bytes, and deletes
 * only the rows whose bytes are gone or are still in use elsewhere; a row whose delete failed stays
 * for the next run. A submit trying to claim a locked row waits for this transaction and then finds
 * the row gone.
 *
 * ⚠️ BYTES ARE DELETED ONLY WHEN NOTHING ELSE NAMES THE KEY. Keys are content-addressed per author,
 * and publishing COPIES a key onto the teardown's file and model rows rather than moving it, so the
 * same bytes can be live on a published teardown while an unrelated staging row for them expires.
 * Every published table `collectTeardownFileObjectKeys` reads is consulted here for that reason.
 *
 * A PURE FUNCTION OF ITS PAYLOAD. The cutoff is derived from `asOf`, never from the clock.
 */
const UNCLAIMED_UPLOAD_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * Bounds how long one run holds row locks across storage calls. A larger backlog is swept over
 * several nights, which nothing waits on: an unclaimed upload is invisible to every reader.
 */
const MAX_UPLOADS_PER_RUN = 200;

export interface TeardownUploadSweepSummary {
  readonly expiredUploadRowsDeleted: number;
  readonly storedFilesDeleted: number;
  readonly storedFilesKeptBecauseReferenced: number;
  readonly storedFileDeleteFailures: number;
}

export async function sweepOrphanTeardownUploads(asOf: Date): Promise<TeardownUploadSweepSummary> {
  const cutoff = new Date(asOf.getTime() - UNCLAIMED_UPLOAD_LIFETIME_MS);

  return db.transaction(async (transaction) => {
    const expiredUploadRows = await transaction
      .select({
        id: teardownSubmissionFileUpload.id,
        objectStorageKey: teardownSubmissionFileUpload.objectStorageKey,
      })
      .from(teardownSubmissionFileUpload)
      .where(
        and(
          isNull(teardownSubmissionFileUpload.submissionId),
          lt(teardownSubmissionFileUpload.createdAt, cutoff),
          sql`NOT EXISTS (
            SELECT 1 FROM ${blueprintDraft}
            WHERE ${blueprintDraft.ownerUserId} = ${teardownSubmissionFileUpload.uploadedByUserId}
              AND ${blueprintDraft.arm} = 'teardown'
              AND strpos(${blueprintDraft.documentJson}, ${teardownSubmissionFileUpload.id}) > 0
          )`,
        ),
      )
      .limit(MAX_UPLOADS_PER_RUN)
      .for("update", { skipLocked: true });

    if (expiredUploadRows.length === 0) {
      return {
        expiredUploadRowsDeleted: 0,
        storedFilesDeleted: 0,
        storedFilesKeptBecauseReferenced: 0,
        storedFileDeleteFailures: 0,
      };
    }

    // The staging table is not consulted: its key column is unique, so the locked rows are the
    // only staging rows that can name these keys.
    const expiredObjectKeys = expiredUploadRows.map((expiredRow) => expiredRow.objectStorageKey);
    const [documentRows, fabricationRows, assemblyRows, partRows] = await Promise.all([
      transaction
        .select({ objectStorageKey: teardownDocument.objectStorageKey })
        .from(teardownDocument)
        .where(inArray(teardownDocument.objectStorageKey, expiredObjectKeys)),
      transaction
        .select({ objectStorageKey: teardownManufacturingFile.objectStorageKey })
        .from(teardownManufacturingFile)
        .where(inArray(teardownManufacturingFile.objectStorageKey, expiredObjectKeys)),
      transaction
        .select({ objectStorageKey: teardownAssembly.modelObjectStorageKey })
        .from(teardownAssembly)
        .where(inArray(teardownAssembly.modelObjectStorageKey, expiredObjectKeys)),
      transaction
        .select({ objectStorageKey: teardownPart.modelObjectStorageKey })
        .from(teardownPart)
        .where(inArray(teardownPart.modelObjectStorageKey, expiredObjectKeys)),
    ]);
    const referencedObjectKeys = new Set(
      [...documentRows, ...fabricationRows, ...assemblyRows, ...partRows].map(
        (referenceRow) => referenceRow.objectStorageKey,
      ),
    );

    const removableUploadIds: string[] = [];
    let storedFilesDeleted = 0;
    let storedFilesKeptBecauseReferenced = 0;
    let storedFileDeleteFailures = 0;
    for (const expiredRow of expiredUploadRows) {
      if (referencedObjectKeys.has(expiredRow.objectStorageKey)) {
        storedFilesKeptBecauseReferenced += 1;
        removableUploadIds.push(expiredRow.id);
        continue;
      }
      const removed = await deleteTeardownFile(expiredRow.objectStorageKey);
      if (removed.success) {
        storedFilesDeleted += 1;
        removableUploadIds.push(expiredRow.id);
      } else {
        storedFileDeleteFailures += 1;
        logger.warn("sweep-orphan-teardown-uploads: stored file not deleted; next run retries", {
          uploadId: expiredRow.id,
          reason: removed.error.type,
        });
      }
    }

    if (removableUploadIds.length > 0) {
      await transaction
        .delete(teardownSubmissionFileUpload)
        .where(inArray(teardownSubmissionFileUpload.id, removableUploadIds));
    }

    return {
      expiredUploadRowsDeleted: removableUploadIds.length,
      storedFilesDeleted,
      storedFilesKeptBecauseReferenced,
      storedFileDeleteFailures,
    };
  });
}

export async function handleSweepOrphanTeardownUploads(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.sweepOrphanTeardownUploads,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.sweepOrphanTeardownUploads],
    rawPayload,
  );

  const summary = await sweepOrphanTeardownUploads(new Date(payload.asOf));

  logger.info("sweep-orphan-teardown-uploads complete", { ...summary });
}
