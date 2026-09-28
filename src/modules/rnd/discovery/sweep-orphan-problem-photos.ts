import { and, inArray, isNull, lt } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { problemSubmissionPhoto } from "#src/db/schema.js";
import { deleteProblemPhotos, listProblemPhotoAssets } from "#src/lib/cloudinary.js";
import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import { logger } from "#src/lib/logger.js";

/**
 * The daily problem-photo sweep (Civic Pulse). The `sweep-orphan-showcase-images` shape, one table.
 *
 * TWO KINDS OF LEFTOVER, each with a different cause:
 *
 *   1. AN UNCLAIMED UPLOAD — a photo a reporter picked and never submitted a report with. Its row
 *      and its asset are both deleted once it is a day old.
 *   2. AN ASSET WITH NO ROW — an upload whose row insert threw, a kind-1 asset whose delete failed
 *      last run, or a photo whose row an ACCOUNT ERASURE deleted while Cloudinary was down.
 *      Listed from Cloudinary and matched against `problem_submission_photo`.
 *
 * ROWS GO FIRST. If the asset delete in step 1 fails, those assets have become kind 2, and the
 * next run's listing catches them. The reverse order would leave rows pointing at deleted files.
 * Either way a retry converges, because `deleteProblemPhotos` counts an already-gone asset as
 * deleted rather than failed.
 *
 * NEVER A CONCURRENT CLAIM. A photo being claimed by a submit is row-locked by its UPDATE; this
 * DELETE waits, then re-checks `submission_id IS NULL` against the committed row and leaves it.
 *
 * A PURE FUNCTION OF ITS PAYLOAD. The cutoff is derived from `asOf`, never from the clock.
 */
const UNCLAIMED_UPLOAD_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** Bounds one run's Admin API spend. A folder larger than this is swept over several nights. */
const MAX_LISTING_PAGES_PER_RUN = 20;

export interface ProblemPhotoSweepSummary {
  readonly expiredUploadRowsDeleted: number;
  readonly orphanAssetsDeleted: number;
  readonly listingPagesRead: number;
}

export async function sweepOrphanProblemPhotos(asOf: Date): Promise<ProblemPhotoSweepSummary> {
  const cutoff = new Date(asOf.getTime() - UNCLAIMED_UPLOAD_LIFETIME_MS);

  const expiredUploadRows = await db
    .delete(problemSubmissionPhoto)
    .where(
      and(
        isNull(problemSubmissionPhoto.submissionId),
        lt(problemSubmissionPhoto.createdAt, cutoff),
      ),
    )
    .returning({ publicId: problemSubmissionPhoto.publicId });

  const expiredPublicIds = expiredUploadRows.map((expiredRow) => expiredRow.publicId);
  const expiredAssetDelete = await deleteProblemPhotos(expiredPublicIds);
  if (!expiredAssetDelete.success) {
    logger.warn(
      "sweep-orphan-problem-photos: expired upload assets not deleted; next run retries",
      {
        assetCount: expiredPublicIds.length,
        errorType: expiredAssetDelete.error.type,
      },
    );
  }

  let orphanAssetsDeleted = 0;
  let listingPagesRead = 0;
  let nextCursor: string | null = null;

  do {
    const listingPage = await listProblemPhotoAssets(nextCursor);
    if (!listingPage.success) {
      logger.warn("sweep-orphan-problem-photos: could not list assets", {
        errorType: listingPage.error.type,
      });
      break;
    }
    listingPagesRead += 1;

    // Only assets older than the cutoff: a photo uploaded seconds ago may belong to an insert
    // that has not committed yet.
    const staleAssetPublicIds = listingPage.value.assets
      .filter((asset) => asset.createdAt.getTime() < cutoff.getTime())
      .map((asset) => asset.publicId);

    if (staleAssetPublicIds.length > 0) {
      const referencedRows = await db
        .select({ publicId: problemSubmissionPhoto.publicId })
        .from(problemSubmissionPhoto)
        .where(inArray(problemSubmissionPhoto.publicId, staleAssetPublicIds));
      const referencedPublicIds = new Set(
        referencedRows.map((referenceRow) => referenceRow.publicId),
      );
      const orphanAssetPublicIds = staleAssetPublicIds.filter(
        (publicId) => !referencedPublicIds.has(publicId),
      );

      const orphanDelete = await deleteProblemPhotos(orphanAssetPublicIds);
      if (orphanDelete.success) {
        orphanAssetsDeleted += orphanAssetPublicIds.length;
      } else {
        logger.warn("sweep-orphan-problem-photos: orphan assets not deleted; next run retries", {
          assetCount: orphanAssetPublicIds.length,
          errorType: orphanDelete.error.type,
        });
      }
    }

    nextCursor = listingPage.value.nextCursor;
  } while (nextCursor !== null && listingPagesRead < MAX_LISTING_PAGES_PER_RUN);

  return {
    expiredUploadRowsDeleted: expiredPublicIds.length,
    orphanAssetsDeleted,
    listingPagesRead,
  };
}

export async function handleSweepOrphanProblemPhotos(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.sweepOrphanProblemPhotos,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.sweepOrphanProblemPhotos],
    rawPayload,
  );

  const summary = await sweepOrphanProblemPhotos(new Date(payload.asOf));

  logger.info("sweep-orphan-problem-photos complete", {
    expiredUploadRowsDeleted: summary.expiredUploadRowsDeleted,
    orphanAssetsDeleted: summary.orphanAssetsDeleted,
    listingPagesRead: summary.listingPagesRead,
  });
}
