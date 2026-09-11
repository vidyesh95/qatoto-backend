import { and, inArray, isNull, lt } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { showcaseLaunch, showcaseLaunchWriteUpImage } from "#src/db/schema.js";
import { deleteShowcaseImages, listShowcaseImageAssets } from "#src/lib/cloudinary.js";
import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import { logger } from "#src/lib/logger.js";

/**
 * The daily showcase image sweep.
 *
 * TWO KINDS OF LEFTOVER, each with a different cause:
 *
 *   1. AN UNCLAIMED WRITE-UP IMAGE — a maker uploaded it and never posted the launch. Its row
 *      and its asset are both deleted once it is a day old.
 *   2. AN ASSET WITH NO ROW — a heading image whose launch lost a race and whose best-effort
 *      delete failed, an upload whose row insert threw, or an image whose row an erasure deleted
 *      while Cloudinary was down. Listed from Cloudinary and matched against both tables.
 *
 * ROWS GO FIRST. If the asset delete in step 1 fails, those assets have become kind 2, and the
 * next run's listing catches them. The reverse order would leave rows pointing at deleted files.
 *
 * NEVER A CONCURRENT CLAIM. An image being claimed by a submit is row-locked; this DELETE waits,
 * then re-checks `launch_id IS NULL` against the committed row and leaves it alone.
 *
 * A PURE FUNCTION OF ITS PAYLOAD. The cutoff is derived from `asOf`, never from the clock.
 */
const UNCLAIMED_UPLOAD_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** Bounds one run's Admin API spend. A folder larger than this is swept over several nights. */
const MAX_LISTING_PAGES_PER_RUN = 20;

export interface ShowcaseImageSweepSummary {
  readonly expiredUploadRowsDeleted: number;
  readonly orphanAssetsDeleted: number;
  readonly listingPagesRead: number;
}

export async function sweepOrphanShowcaseImages(asOf: Date): Promise<ShowcaseImageSweepSummary> {
  const cutoff = new Date(asOf.getTime() - UNCLAIMED_UPLOAD_LIFETIME_MS);

  const expiredUploadRows = await db
    .delete(showcaseLaunchWriteUpImage)
    .where(
      and(
        isNull(showcaseLaunchWriteUpImage.launchId),
        lt(showcaseLaunchWriteUpImage.createdAt, cutoff),
      ),
    )
    .returning({ publicId: showcaseLaunchWriteUpImage.publicId });

  const expiredAssetDelete = await deleteShowcaseImages(
    expiredUploadRows.map((expiredRow) => expiredRow.publicId),
  );
  if (!expiredAssetDelete.success) {
    logger.warn(
      "sweep-orphan-showcase-images: expired upload assets not deleted; next run retries",
      {
        assetCount: expiredUploadRows.length,
        errorType: expiredAssetDelete.error.type,
      },
    );
  }

  let orphanAssetsDeleted = 0;
  let listingPagesRead = 0;
  let nextCursor: string | null = null;

  do {
    const listingPage = await listShowcaseImageAssets(nextCursor);
    if (!listingPage.success) {
      logger.warn("sweep-orphan-showcase-images: could not list assets", {
        errorType: listingPage.error.type,
      });
      break;
    }
    listingPagesRead += 1;

    // Only assets older than the cutoff: a heading image uploaded seconds ago may belong to a
    // launch whose transaction has not committed yet.
    const staleAssetPublicIds = listingPage.value.assets
      .filter((asset) => asset.createdAt.getTime() < cutoff.getTime())
      .map((asset) => asset.publicId);

    if (staleAssetPublicIds.length > 0) {
      const [headingImageRows, writeUpImageRows] = await Promise.all([
        db
          .select({ publicId: showcaseLaunch.headingImagePublicId })
          .from(showcaseLaunch)
          .where(inArray(showcaseLaunch.headingImagePublicId, staleAssetPublicIds)),
        db
          .select({ publicId: showcaseLaunchWriteUpImage.publicId })
          .from(showcaseLaunchWriteUpImage)
          .where(inArray(showcaseLaunchWriteUpImage.publicId, staleAssetPublicIds)),
      ]);
      const referencedPublicIds = new Set(
        [...headingImageRows, ...writeUpImageRows].map((referenceRow) => referenceRow.publicId),
      );
      const orphanAssetPublicIds = staleAssetPublicIds.filter(
        (publicId) => !referencedPublicIds.has(publicId),
      );

      const orphanDelete = await deleteShowcaseImages(orphanAssetPublicIds);
      if (orphanDelete.success) {
        orphanAssetsDeleted += orphanAssetPublicIds.length;
      } else {
        logger.warn("sweep-orphan-showcase-images: orphan assets not deleted; next run retries", {
          assetCount: orphanAssetPublicIds.length,
          errorType: orphanDelete.error.type,
        });
      }
    }

    nextCursor = listingPage.value.nextCursor;
  } while (nextCursor !== null && listingPagesRead < MAX_LISTING_PAGES_PER_RUN);

  return {
    expiredUploadRowsDeleted: expiredUploadRows.length,
    orphanAssetsDeleted,
    listingPagesRead,
  };
}

export async function handleSweepOrphanShowcaseImages(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.sweepOrphanShowcaseImages,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.sweepOrphanShowcaseImages],
    rawPayload,
  );

  const summary = await sweepOrphanShowcaseImages(new Date(payload.asOf));

  logger.info("sweep-orphan-showcase-images complete", {
    expiredUploadRowsDeleted: summary.expiredUploadRowsDeleted,
    orphanAssetsDeleted: summary.orphanAssetsDeleted,
    listingPagesRead: summary.listingPagesRead,
  });
}
