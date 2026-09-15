import { and, inArray, isNull, lt } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  showcaseLaunch,
  showcaseLaunchHeadingImage,
  showcaseLaunchWriteUpImage,
} from "#src/db/schema.js";
import { deleteShowcaseImages, listShowcaseImageAssets } from "#src/lib/cloudinary.js";
import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import { logger } from "#src/lib/logger.js";

/**
 * The daily showcase image sweep.
 *
 * TWO KINDS OF LEFTOVER, each with a different cause:
 *
 *   1. AN UNCLAIMED UPLOAD — a write-up image or a staged cover a maker uploaded and never posted.
 *      Its row and its asset are both deleted once it is a day old. An upload a DRAFT references is
 *      not unclaimed and is left alone.
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
        /*
         * ⚠️ A DRAFT'S IMAGES ARE CLAIMED, AND FORGETTING THIS LOSES AN AUTHOR'S WORK SILENTLY.
         * Every image a showcase draft references has a NULL `launch_id` — a draft has no launch —
         * so the predicate above alone would delete all of them after 24 hours. An author resuming
         * a week later would find their write-up full of dead links, with nothing failing anywhere
         * to say why. This conjunct and `showcase_launch_write_up_image_unclaimed_idx`'s predicate
         * are one rule in two places.
         */
        isNull(showcaseLaunchWriteUpImage.draftId),
        lt(showcaseLaunchWriteUpImage.createdAt, cutoff),
      ),
    )
    .returning({ publicId: showcaseLaunchWriteUpImage.publicId });

  /*
   * THE SAME RULE FOR A STAGED COVER, and the same trap inside it.
   *
   * A cover staged from a draft has a NULL `launch_id` for as long as the draft goes unposted, so
   * the `draft_id` conjunct is what stops this deleting the cover out of a draft somebody is still
   * writing. One rule, now in four places: here, the write-up delete above, and each table's
   * partial index.
   */
  const expiredHeadingImageRows = await db
    .delete(showcaseLaunchHeadingImage)
    .where(
      and(
        isNull(showcaseLaunchHeadingImage.launchId),
        isNull(showcaseLaunchHeadingImage.draftId),
        lt(showcaseLaunchHeadingImage.createdAt, cutoff),
      ),
    )
    .returning({ publicId: showcaseLaunchHeadingImage.publicId });

  const expiredPublicIds = [...expiredUploadRows, ...expiredHeadingImageRows].map(
    (expiredRow) => expiredRow.publicId,
  );
  const expiredAssetDelete = await deleteShowcaseImages(expiredPublicIds);
  if (!expiredAssetDelete.success) {
    logger.warn(
      "sweep-orphan-showcase-images: expired upload assets not deleted; next run retries",
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
      /*
       * ⚠️ ALL THREE TABLES, AND THE THIRD ONE IS NOT OPTIONAL. This step deletes any stale asset
       * no row names, so a table it does not consult is a table whose assets it destroys. A cover
       * staged against a draft lives only in `showcase_launch_heading_image` and has no launch row
       * pointing at it — omit that query and every showcase draft loses its cover after a day,
       * which is the precise bug this whole feature exists to prevent.
       */
      const [headingImageRows, writeUpImageRows, stagedHeadingImageRows] = await Promise.all([
        db
          .select({ publicId: showcaseLaunch.headingImagePublicId })
          .from(showcaseLaunch)
          .where(inArray(showcaseLaunch.headingImagePublicId, staleAssetPublicIds)),
        db
          .select({ publicId: showcaseLaunchWriteUpImage.publicId })
          .from(showcaseLaunchWriteUpImage)
          .where(inArray(showcaseLaunchWriteUpImage.publicId, staleAssetPublicIds)),
        db
          .select({ publicId: showcaseLaunchHeadingImage.publicId })
          .from(showcaseLaunchHeadingImage)
          .where(inArray(showcaseLaunchHeadingImage.publicId, staleAssetPublicIds)),
      ]);
      const referencedPublicIds = new Set(
        [...headingImageRows, ...writeUpImageRows, ...stagedHeadingImageRows].map(
          (referenceRow) => referenceRow.publicId,
        ),
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
    expiredUploadRowsDeleted: expiredPublicIds.length,
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
