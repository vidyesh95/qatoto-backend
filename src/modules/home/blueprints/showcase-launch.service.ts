import { randomUUID } from "node:crypto";

import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import sharp from "sharp";

import { db } from "#src/db/index.js";
import {
  showcaseLaunch,
  showcaseLaunchTeamMember,
  showcaseLaunchWriteUpImage,
} from "#src/db/schema.js";
import {
  deleteShowcaseImages,
  showcaseLaunchHeadingImagePublicId,
  showcaseWriteUpImagePublicId,
  uploadShowcaseImage,
  type CloudinaryError,
} from "#src/lib/cloudinary.js";
import { parseHttpsUrl, type ExternalUrlError } from "#src/lib/external-url.js";
import { validateAndNormalizeImage, type ImageValidationError } from "#src/lib/image.js";
import { logger } from "#src/lib/logger.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import { extractWriteUpImageAddresses } from "#src/modules/home/blueprints/showcase-launch-markdown.js";
import {
  MAX_SHOWCASE_WRITE_UP_IMAGES,
  MAX_UNCLAIMED_SHOWCASE_WRITE_UP_IMAGES_PER_MAKER,
  SHOWCASE_LAUNCH_DATE_CLOCK_SKEW_MS,
  type ShowcaseLaunchDraft,
} from "#src/modules/home/blueprints/showcase-launch.schemas.js";
import type { Result } from "#src/types/index.js";

/**
 * Posting a showcase launch, uploading its write-up images, and a maker's own list.
 *
 * NOTHING HERE PUBLISHES. A posted launch lands `pending_review` and is visible to its maker and
 * to moderators only; `showcase-launch-moderation.service.ts` is where a decision happens.
 *
 * ⚠️ THE PUBLIC SHOWCASE PAGES DO NOT READ THIS TABLE YET. They still render frontend fixtures
 * (todo.md 2b decision), so even a published launch appears on no public page this round.
 */

/** The heading image is stored inside a 1024px box — it renders at 72px, and at most 2x that. */
const HEADING_IMAGE_OUTPUT_MAX_DIMENSION_PX = 1024;
/** Below this, the feed row's square is visibly upscaled. The form checks the same number. */
const HEADING_IMAGE_MINIMUM_DIMENSION_PX = 256;
/** "Square" within 1%, measured on the stored file. The form checks the same tolerance. */
const HEADING_IMAGE_SQUARE_TOLERANCE = 0.01;
/**
 * Write-up images render inside a 768px media column, at most 2x on a dense screen. The
 * normalizer never ENLARGES (`withoutEnlargement`), so a small screenshot keeps its own size —
 * the frontend shows an image at its recorded width, and an upscaled file would be a blurry
 * screenshot at a bigger size.
 */
const WRITE_UP_IMAGE_OUTPUT_MAX_DIMENSION_PX = 1600;
const BLUR_PLACEHOLDER_DIMENSION_PX = 16;

export type ShowcaseWriteUpImageError =
  | ImageValidationError
  | CloudinaryError
  | { readonly type: "SHOWCASE_WRITE_UP_IMAGE_STAGING_LIMIT_REACHED"; readonly limit: number };

export type ShowcaseLaunchSubmitError =
  | ImageValidationError
  | CloudinaryError
  | { readonly type: "SHOWCASE_LAUNCH_TITLE_TAKEN" }
  | { readonly type: "SHOWCASE_LAUNCH_LINK_INVALID"; readonly reason: ExternalUrlError }
  | { readonly type: "SHOWCASE_LAUNCH_DATE_IN_FUTURE" }
  | { readonly type: "SHOWCASE_LAUNCH_WRITE_UP_TOO_MANY_IMAGES"; readonly limit: number }
  | { readonly type: "SHOWCASE_LAUNCH_WRITE_UP_IMAGE_NOT_AVAILABLE" }
  | {
      readonly type: "SHOWCASE_HEADING_IMAGE_NOT_SQUARE";
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly type: "SHOWCASE_HEADING_IMAGE_TOO_SMALL";
      readonly width: number;
      readonly height: number;
      readonly minimum: number;
    };

/** What the form inserts into the write-up and hands to its preview. */
export interface ShowcaseWriteUpImageView {
  readonly url: string;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly blurDataUrl: string;
}

/** The receipt a maker sees after posting — not a row, and it carries no public address. */
export interface ShowcaseLaunchReceipt {
  readonly submissionId: string;
  readonly moderationState: "pending_review";
  readonly receivedAt: Date;
}

/** One row of My Launches. Shaped as the frontend's `ShowcaseSubmissionSchema`. */
export interface ShowcaseSubmissionView {
  readonly submissionId: string;
  readonly title: string;
  readonly tagline: string;
  readonly headingImageUrl: string;
  readonly moderationState: (typeof showcaseLaunch.$inferSelect)["moderationState"];
  readonly submittedAt: Date;
  readonly publicSlug: string | null;
  readonly moderatorNote: string | null;
}

/**
 * A 16px WebP, base64, for the reserved box to paint until the real file loads.
 *
 * Made from the RAW upload with the same auto-orientation the normalizer applies, rather than by
 * re-decoding the stored AVIF: that would depend on this deployment's libvips carrying an AV1
 * decoder as well as an encoder. The raw bytes already decoded once inside
 * `validateAndNormalizeImage`, so a failure here is not a bad upload — it is still answered as
 * one rather than as a 500, because the caller can do nothing else with it.
 */
async function buildBlurPlaceholderDataUrl(
  rawImageBytes: Buffer,
): Promise<Result<string, ImageValidationError>> {
  try {
    const placeholderBuffer = await sharp(rawImageBytes)
      .rotate()
      .resize(BLUR_PLACEHOLDER_DIMENSION_PX, BLUR_PLACEHOLDER_DIMENSION_PX, { fit: "inside" })
      .webp({ quality: 50 })
      .toBuffer();
    return {
      success: true,
      value: `data:image/webp;base64,${placeholderBuffer.toString("base64")}`,
    };
  } catch {
    return { success: false, error: { type: "NOT_AN_IMAGE" } };
  }
}

/**
 * Stores one write-up image, UNCLAIMED, and returns what the form needs to embed it.
 *
 * THE ROW EXISTS BEFORE ANY LAUNCH DOES. A maker adds images while writing; the launch is created
 * later, and its submit transaction claims every image the write-up references. See
 * `showcase_launch_write_up_image` for why, and `sweep-orphan-showcase-images` for what happens to
 * an image nobody claims.
 *
 * THE STAGING CAP IS A READ, NOT A LOCK. Two uploads racing at 29 unclaimed images can both pass
 * and leave 31. That overshoot is bounded by the upload limiter and harmless — the cap exists to
 * stop the staging area being used as free image hosting, not to count exactly.
 */
export async function uploadShowcaseWriteUpImage(
  uploaderUserId: string,
  rawImageBytes: Buffer,
): Promise<Result<ShowcaseWriteUpImageView, ShowcaseWriteUpImageError>> {
  const [stagingRow] = await db
    .select({ unclaimedImageCount: count() })
    .from(showcaseLaunchWriteUpImage)
    .where(
      and(
        eq(showcaseLaunchWriteUpImage.uploadedByUserId, uploaderUserId),
        isNull(showcaseLaunchWriteUpImage.launchId),
      ),
    );
  if ((stagingRow?.unclaimedImageCount ?? 0) >= MAX_UNCLAIMED_SHOWCASE_WRITE_UP_IMAGES_PER_MAKER) {
    return {
      success: false,
      error: {
        type: "SHOWCASE_WRITE_UP_IMAGE_STAGING_LIMIT_REACHED",
        limit: MAX_UNCLAIMED_SHOWCASE_WRITE_UP_IMAGES_PER_MAKER,
      },
    };
  }

  const normalizedImage = await validateAndNormalizeImage(rawImageBytes, {
    outputMaxDimensionPx: WRITE_UP_IMAGE_OUTPUT_MAX_DIMENSION_PX,
    outputFormat: "avif",
  });
  if (!normalizedImage.success) return { success: false, error: normalizedImage.error };

  const blurDataUrl = await buildBlurPlaceholderDataUrl(rawImageBytes);
  if (!blurDataUrl.success) return { success: false, error: blurDataUrl.error };

  const imageId = randomUUID();
  const imagePublicId = showcaseWriteUpImagePublicId(imageId);
  const uploadResult = await uploadShowcaseImage(imagePublicId, normalizedImage.value.buffer);
  if (!uploadResult.success) return { success: false, error: uploadResult.error };

  // If this insert throws, the asset above has no row naming it. That is not handled here on
  // purpose: the orphan sweep deletes any asset under the folder older than a day with no row.
  await db.insert(showcaseLaunchWriteUpImage).values({
    id: imageId,
    uploadedByUserId: uploaderUserId,
    publicId: imagePublicId,
    url: uploadResult.value.secureUrl,
    // The re-encoded file's size, never a number the client sent.
    widthPx: normalizedImage.value.width,
    heightPx: normalizedImage.value.height,
    blurDataUrl: blurDataUrl.value,
  });

  return {
    success: true,
    value: {
      url: uploadResult.value.secureUrl,
      widthPx: normalizedImage.value.width,
      heightPx: normalizedImage.value.height,
      blurDataUrl: blurDataUrl.value,
    },
  };
}

/**
 * Best-effort delete of a heading image whose launch was never written.
 *
 * NEVER A RESULT: the caller is already returning a more important refusal, and a failed cleanup
 * is not the maker's problem. The public id is logged so the asset can be found, and the orphan
 * sweep removes it within a day regardless.
 */
async function discardUnusedHeadingImage(headingImagePublicId: string): Promise<void> {
  const deleteResult = await deleteShowcaseImages([headingImagePublicId]);
  if (!deleteResult.success) {
    logger.error("showcase launch: could not delete an unused heading image", {
      headingImagePublicId,
      errorType: deleteResult.error.type,
    });
  }
}

type SubmitTransactionOutcome =
  | { readonly kind: "inserted"; readonly createdAt: Date }
  | { readonly kind: "write_up_image_unavailable" };

/**
 * Posts a launch. Lands `pending_review`.
 *
 * THE ORDER IS CHEAPEST-REFUSAL FIRST, and every refusal before the upload costs no storage:
 *   1. the link, the date and the write-up's images — pure checks and one indexed read;
 *   2. the name, pre-checked in SQL so the common "already taken" answer never uploads a file;
 *   3. the heading image — decode, re-encode, square and size, then upload;
 *   4. one transaction: lock the write-up's images, insert the launch and its team, claim them.
 *
 * THE PRE-CHECKS ARE NOT THE AUTHORITY. The partial unique index decides the name, and the row
 * locks decide the images; a race lost at step 4 is translated into the same refusal the
 * pre-check would have given, and the uploaded heading image is deleted.
 */
export async function submitShowcaseLaunch(input: {
  readonly authorUserId: string;
  readonly draft: ShowcaseLaunchDraft;
  readonly rawHeadingImageBytes: Buffer;
  readonly receivedAt: Date;
}): Promise<Result<ShowcaseLaunchReceipt, ShowcaseLaunchSubmitError>> {
  const { authorUserId, draft } = input;

  let callToActionUrl: string | null = null;
  if (draft.callToAction !== null) {
    const parsedUrl = parseHttpsUrl(draft.callToAction.url);
    if (!parsedUrl.success) {
      return {
        success: false,
        error: { type: "SHOWCASE_LAUNCH_LINK_INVALID", reason: parsedUrl.error },
      };
    }
    callToActionUrl = parsedUrl.value;
  }

  const launchedAt = new Date(draft.launchedAt);
  if (launchedAt.getTime() > input.receivedAt.getTime() + SHOWCASE_LAUNCH_DATE_CLOCK_SKEW_MS) {
    return { success: false, error: { type: "SHOWCASE_LAUNCH_DATE_IN_FUTURE" } };
  }

  const writeUp = draft.writeUp === null || draft.writeUp.trim() === "" ? null : draft.writeUp;
  const writeUpImageAddresses = writeUp === null ? [] : extractWriteUpImageAddresses(writeUp);
  if (writeUpImageAddresses.length > MAX_SHOWCASE_WRITE_UP_IMAGES) {
    return {
      success: false,
      error: {
        type: "SHOWCASE_LAUNCH_WRITE_UP_TOO_MANY_IMAGES",
        limit: MAX_SHOWCASE_WRITE_UP_IMAGES,
      },
    };
  }

  /** The maker's own unclaimed uploads, among the addresses the write-up embeds. */
  const unclaimedOwnImagesCondition = and(
    inArray(showcaseLaunchWriteUpImage.url, [...writeUpImageAddresses]),
    eq(showcaseLaunchWriteUpImage.uploadedByUserId, authorUserId),
    isNull(showcaseLaunchWriteUpImage.launchId),
  );

  if (writeUpImageAddresses.length > 0) {
    const availableImageRows = await db
      .select({ url: showcaseLaunchWriteUpImage.url })
      .from(showcaseLaunchWriteUpImage)
      .where(unclaimedOwnImagesCondition);
    if (availableImageRows.length !== writeUpImageAddresses.length) {
      return { success: false, error: { type: "SHOWCASE_LAUNCH_WRITE_UP_IMAGE_NOT_AVAILABLE" } };
    }
  }

  // The SAME expression as `showcase_launch.title_normalized`, evaluated by Postgres — a
  // JavaScript copy would disagree with POSIX `[[:space:]]` on some whitespace code point.
  const [takenTitleRow] = await db
    .select({ launchId: showcaseLaunch.id })
    .from(showcaseLaunch)
    .where(
      and(
        sql`${showcaseLaunch.titleNormalized} = lower(regexp_replace(btrim(${draft.title}::text), '[[:space:]]+', ' ', 'g'))`,
        inArray(showcaseLaunch.moderationState, ["pending_review", "published"]),
      ),
    )
    .limit(1);
  if (takenTitleRow) {
    return { success: false, error: { type: "SHOWCASE_LAUNCH_TITLE_TAKEN" } };
  }

  const normalizedHeadingImage = await validateAndNormalizeImage(input.rawHeadingImageBytes, {
    outputMaxDimensionPx: HEADING_IMAGE_OUTPUT_MAX_DIMENSION_PX,
    outputFormat: "avif",
  });
  if (!normalizedHeadingImage.success) {
    return { success: false, error: normalizedHeadingImage.error };
  }

  // Measured on the STORED file, which is what every reader sees.
  const { width, height } = normalizedHeadingImage.value;
  if (Math.min(width, height) < HEADING_IMAGE_MINIMUM_DIMENSION_PX) {
    return {
      success: false,
      error: {
        type: "SHOWCASE_HEADING_IMAGE_TOO_SMALL",
        width,
        height,
        minimum: HEADING_IMAGE_MINIMUM_DIMENSION_PX,
      },
    };
  }
  if (Math.abs(width - height) / Math.max(width, height) > HEADING_IMAGE_SQUARE_TOLERANCE) {
    return { success: false, error: { type: "SHOWCASE_HEADING_IMAGE_NOT_SQUARE", width, height } };
  }

  const launchId = randomUUID();
  const headingImagePublicId = showcaseLaunchHeadingImagePublicId(launchId);
  const uploadResult = await uploadShowcaseImage(
    headingImagePublicId,
    normalizedHeadingImage.value.buffer,
  );
  if (!uploadResult.success) return { success: false, error: uploadResult.error };

  let transactionOutcome: SubmitTransactionOutcome;
  try {
    transactionOutcome = await db.transaction(async (tx): Promise<SubmitTransactionOutcome> => {
      let claimedImageIds: readonly string[] = [];
      if (writeUpImageAddresses.length > 0) {
        // Locked, so a second launch submitted at the same moment cannot claim the same image.
        const lockedImageRows = await tx
          .select({ imageId: showcaseLaunchWriteUpImage.id })
          .from(showcaseLaunchWriteUpImage)
          .where(unclaimedOwnImagesCondition)
          .for("update");
        if (lockedImageRows.length !== writeUpImageAddresses.length) {
          // Nothing has been written yet, so returning commits an empty transaction.
          return { kind: "write_up_image_unavailable" };
        }
        claimedImageIds = lockedImageRows.map((imageRow) => imageRow.imageId);
      }

      const [insertedLaunch] = await tx
        .insert(showcaseLaunch)
        .values({
          id: launchId,
          authorUserId,
          title: draft.title,
          tagline: draft.tagline,
          summary: draft.summary,
          writeUp,
          launchedAt,
          difficulty: draft.difficulty,
          billOfMaterialsMinimumCents: draft.billOfMaterialsCostRange?.minimumInCents ?? null,
          billOfMaterialsMaximumCents: draft.billOfMaterialsCostRange?.maximumInCents ?? null,
          billOfMaterialsCurrency: draft.billOfMaterialsCostRange?.currency ?? null,
          tags: [...draft.tags],
          builtFromBlueprintSlug: draft.builtFromBlueprintSlug,
          callToActionLabel: draft.callToAction?.label ?? null,
          callToActionUrl,
          acceptedLaunchStatementIds: [...draft.acceptedLaunchStatementIds],
          headingImageUrl: uploadResult.value.secureUrl,
          headingImagePublicId,
          // Explicit rather than the column default, so this call answers "what state does a
          // new launch start in" without opening the schema.
          moderationState: "pending_review",
        })
        .returning({ createdAt: showcaseLaunch.createdAt });
      if (!insertedLaunch) throw new Error("submitShowcaseLaunch: insert returned no row");

      if (draft.team.length > 0) {
        await tx.insert(showcaseLaunchTeamMember).values(
          draft.team.map((teamMember, position) => ({
            launchId,
            position,
            displayName: teamMember.displayName,
            handle: teamMember.handle,
            role: teamMember.role,
          })),
        );
      }

      if (claimedImageIds.length > 0) {
        await tx
          .update(showcaseLaunchWriteUpImage)
          .set({ launchId })
          .where(inArray(showcaseLaunchWriteUpImage.id, [...claimedImageIds]));
      }

      return { kind: "inserted", createdAt: insertedLaunch.createdAt };
    });
  } catch (transactionError: unknown) {
    // The name race: the pre-check passed, and another launch took the name before this commit.
    // Anything else is a fault. Its uploaded image is left for the orphan sweep rather than
    // cleaned up here, because a fault is not a place to make more network calls.
    if (!isUniqueViolation(transactionError)) throw transactionError;
    await discardUnusedHeadingImage(headingImagePublicId);
    return { success: false, error: { type: "SHOWCASE_LAUNCH_TITLE_TAKEN" } };
  }

  switch (transactionOutcome.kind) {
    case "write_up_image_unavailable":
      await discardUnusedHeadingImage(headingImagePublicId);
      return { success: false, error: { type: "SHOWCASE_LAUNCH_WRITE_UP_IMAGE_NOT_AVAILABLE" } };
    case "inserted":
      return {
        success: true,
        value: {
          submissionId: launchId,
          moderationState: "pending_review",
          receivedAt: transactionOutcome.createdAt,
        },
      };
    default: {
      const exhaustiveCheck: never = transactionOutcome;
      throw new Error(`Unhandled submit outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * Every launch this maker has posted, newest first.
 *
 * UNPAGED, deliberately and for now. The submit limiter holds a maker to five launches in fifteen
 * minutes, and My Launches renders the whole list; a page control nobody's list can reach would
 * be a control no fixture could exercise.
 */
export async function listMyShowcaseLaunches(
  authorUserId: string,
): Promise<readonly ShowcaseSubmissionView[]> {
  return db
    .select({
      submissionId: showcaseLaunch.id,
      title: showcaseLaunch.title,
      tagline: showcaseLaunch.tagline,
      headingImageUrl: showcaseLaunch.headingImageUrl,
      moderationState: showcaseLaunch.moderationState,
      submittedAt: showcaseLaunch.createdAt,
      publicSlug: showcaseLaunch.publicSlug,
      moderatorNote: showcaseLaunch.moderatorNote,
    })
    .from(showcaseLaunch)
    .where(eq(showcaseLaunch.authorUserId, authorUserId))
    .orderBy(desc(showcaseLaunch.createdAt), desc(showcaseLaunch.id));
}
