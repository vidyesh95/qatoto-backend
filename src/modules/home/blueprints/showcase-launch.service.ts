import { randomUUID } from "node:crypto";

import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import sharp from "sharp";

import { db } from "#src/db/index.js";
import {
  blueprintDraft,
  showcaseLaunch,
  showcaseLaunchTeamMember,
  showcaseLaunchHeadingImage,
  showcaseLaunchWriteUpImage,
} from "#src/db/schema.js";
import {
  deleteShowcaseImages,
  showcaseLaunchHeadingImagePublicId,
  showcaseStagedHeadingImagePublicId,
  showcaseWriteUpImagePublicId,
  uploadShowcaseImage,
  type CloudinaryError,
} from "#src/lib/cloudinary.js";
import { parseHttpsUrl, type ExternalUrlError } from "#src/lib/external-url.js";
import {
  validateAndNormalizeImage,
  type ImageValidationError,
  type NormalizedImage,
} from "#src/lib/image.js";
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
  | { readonly type: "SHOWCASE_WRITE_UP_IMAGE_STAGING_LIMIT_REACHED"; readonly limit: number }
  | { readonly type: "SHOWCASE_WRITE_UP_IMAGE_DRAFT_NOT_FOUND" };

/**
 * Why a cover was refused, by either route in.
 *
 * ONE UNION SHARED BY THE SUBMIT AND THE STAGED UPLOAD, so a rule added to one is a compile error
 * in the other until it is handled — which is the point of extracting the check itself.
 */
export type ShowcaseHeadingImageRefusal =
  | ImageValidationError
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

export type ShowcaseHeadingImageUploadError =
  | ShowcaseHeadingImageRefusal
  | CloudinaryError
  | { readonly type: "SHOWCASE_WRITE_UP_IMAGE_DRAFT_NOT_FOUND" }
  | { readonly type: "SHOWCASE_HEADING_IMAGE_STAGING_LIMIT_REACHED"; readonly limit: number };

export type ShowcaseLaunchSubmitError =
  | ShowcaseHeadingImageRefusal
  | CloudinaryError
  | { readonly type: "SHOWCASE_LAUNCH_TITLE_TAKEN" }
  | { readonly type: "SHOWCASE_LAUNCH_LINK_INVALID"; readonly reason: ExternalUrlError }
  | { readonly type: "SHOWCASE_LAUNCH_DATE_IN_FUTURE" }
  | { readonly type: "SHOWCASE_LAUNCH_WRITE_UP_TOO_MANY_IMAGES"; readonly limit: number }
  | { readonly type: "SHOWCASE_LAUNCH_WRITE_UP_IMAGE_NOT_AVAILABLE" }
  | { readonly type: "SHOWCASE_HEADING_IMAGE_NOT_AVAILABLE" };

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
  /**
   * The draft this image belongs to, when the maker is writing one.
   *
   * ⚠️ **WITHOUT IT A RESUMED DRAFT LOSES EVERY IMAGE, SILENTLY** — which is what
   * `showcase_launch_write_up_image.draft_id` was added to prevent, and what nothing set until
   * now. The sweeper deletes any row with no launch after 24 hours, and a draft has no launch, so
   * an unattached image in a week-old draft is a dead link with no error anywhere saying why.
   */
  draftId?: string,
): Promise<Result<ShowcaseWriteUpImageView, ShowcaseWriteUpImageError>> {
  if (draftId !== undefined) {
    /*
     * ⚠️ OWNERSHIP IS PROVED, NOT TAKEN FROM THE QUERY STRING. Without this check any signed-in
     * caller could attach images to a stranger's draft: the rows would survive the sweeper on
     * somebody else's account, and the association is a fact about that person's unpublished work.
     * A draft that is not the caller's is reported exactly as one that does not exist.
     */
    const [ownedDraft] = await db
      .select({ id: blueprintDraft.id })
      .from(blueprintDraft)
      .where(and(eq(blueprintDraft.id, draftId), eq(blueprintDraft.ownerUserId, uploaderUserId)))
      .limit(1);
    if (!ownedDraft) {
      return { success: false, error: { type: "SHOWCASE_WRITE_UP_IMAGE_DRAFT_NOT_FOUND" } };
    }
  }

  const [stagingRow] = await db
    .select({ unclaimedImageCount: count() })
    .from(showcaseLaunchWriteUpImage)
    .where(
      and(
        eq(showcaseLaunchWriteUpImage.uploadedByUserId, uploaderUserId),
        isNull(showcaseLaunchWriteUpImage.launchId),
        /*
         * ⚠️ A DRAFT'S IMAGES ARE NOT "UNCLAIMED", so they do not spend this budget. The ceiling
         * exists to bound images nothing references; a draft references them, and counting them
         * would stop an author uploading into the draft they are actively writing. Same conjunct
         * the sweeper and the partial index carry — one rule in three places, deliberately.
         */
        isNull(showcaseLaunchWriteUpImage.draftId),
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
    // NULL when the maker is composing without a draft, which is still the ordinary case: the
    // image is then unclaimed and the sweeper reaps it in a day if no launch takes it.
    draftId: draftId ?? null,
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
 * Decodes, re-encodes and measures a heading image, refusing one that is too small or not square.
 *
 * ⚠️ **EXTRACTED SO STAGING CANNOT BECOME THE LAX DOOR IN.** These rules used to live inline in the
 * submit path, which was the only way a cover could arrive. There are two ways now — a multipart
 * submit and a staged upload from a draft — and a second copy of a rule is a second copy that can
 * drift. Every cover, by either route, goes through this function.
 *
 * MEASURED ON THE STORED FILE, not the upload: the re-encode may shrink an oversized image, and
 * what every reader sees is the output.
 */
async function normalizeHeadingImageOrRefuse(
  rawHeadingImageBytes: Buffer,
): Promise<Result<NormalizedImage, ShowcaseHeadingImageRefusal>> {
  const normalizedHeadingImage = await validateAndNormalizeImage(rawHeadingImageBytes, {
    outputMaxDimensionPx: HEADING_IMAGE_OUTPUT_MAX_DIMENSION_PX,
    outputFormat: "avif",
  });
  if (!normalizedHeadingImage.success) {
    return { success: false, error: normalizedHeadingImage.error };
  }

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

  return { success: true, value: normalizedHeadingImage.value };
}

/** The same ceiling the write-up images carry, for the same reason and counted separately. */
const MAX_UNCLAIMED_SHOWCASE_HEADING_IMAGES_PER_MAKER = 10;

/** What the composer holds in its draft, and shows as the cover preview. */
export interface ShowcaseHeadingImageView {
  readonly headingImageId: string;
  readonly url: string;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly blurDataUrl: string;
}

/**
 * Uploads a cover image BEFORE the launch exists, so a draft can hold one.
 *
 * ⚠️ **THIS IS WHAT MAKES A SHOWCASE DRAFT POSSIBLE AT ALL.** A cover used to travel as a `File`
 * attached to the submit, and a `File` cannot be written into a JSON draft document — so a saved
 * draft came back without its cover and there was nothing the frontend could do about it. What goes
 * into the draft now is the id this returns.
 *
 * SAME CHECKS AS THE SUBMIT PATH, through the same function, so staging is not a way around the
 * square-and-minimum-size rules.
 */
export async function uploadShowcaseHeadingImage(
  uploaderUserId: string,
  rawImageBytes: Buffer,
  draftId?: string,
): Promise<Result<ShowcaseHeadingImageView, ShowcaseHeadingImageUploadError>> {
  if (draftId !== undefined) {
    // Ownership proved, never taken from the query string — see `uploadShowcaseWriteUpImage`.
    const [ownedDraft] = await db
      .select({ id: blueprintDraft.id })
      .from(blueprintDraft)
      .where(and(eq(blueprintDraft.id, draftId), eq(blueprintDraft.ownerUserId, uploaderUserId)))
      .limit(1);
    if (!ownedDraft) {
      return { success: false, error: { type: "SHOWCASE_WRITE_UP_IMAGE_DRAFT_NOT_FOUND" } };
    }
  }

  const [stagingRow] = await db
    .select({ unclaimedImageCount: count() })
    .from(showcaseLaunchHeadingImage)
    .where(
      and(
        eq(showcaseLaunchHeadingImage.uploadedByUserId, uploaderUserId),
        // A draft's cover is claimed by paperwork, so it does not spend this budget — the same
        // conjunct the sweeper and the partial index carry.
        isNull(showcaseLaunchHeadingImage.launchId),
        isNull(showcaseLaunchHeadingImage.draftId),
      ),
    );
  if ((stagingRow?.unclaimedImageCount ?? 0) >= MAX_UNCLAIMED_SHOWCASE_HEADING_IMAGES_PER_MAKER) {
    return {
      success: false,
      error: {
        type: "SHOWCASE_HEADING_IMAGE_STAGING_LIMIT_REACHED",
        limit: MAX_UNCLAIMED_SHOWCASE_HEADING_IMAGES_PER_MAKER,
      },
    };
  }

  const normalizedImage = await normalizeHeadingImageOrRefuse(rawImageBytes);
  if (!normalizedImage.success) return { success: false, error: normalizedImage.error };

  const blurDataUrl = await buildBlurPlaceholderDataUrl(rawImageBytes);
  if (!blurDataUrl.success) return { success: false, error: blurDataUrl.error };

  const imageId = randomUUID();
  const imagePublicId = showcaseStagedHeadingImagePublicId(imageId);
  const uploadResult = await uploadShowcaseImage(imagePublicId, normalizedImage.value.buffer);
  if (!uploadResult.success) return { success: false, error: uploadResult.error };

  // If this insert throws, the asset above has no row naming it — reaped by the orphan sweep, the
  // same posture the write-up upload takes.
  await db.insert(showcaseLaunchHeadingImage).values({
    id: imageId,
    uploadedByUserId: uploaderUserId,
    draftId: draftId ?? null,
    publicId: imagePublicId,
    url: uploadResult.value.secureUrl,
    widthPx: normalizedImage.value.width,
    heightPx: normalizedImage.value.height,
    blurDataUrl: blurDataUrl.value,
  });

  return {
    success: true,
    value: {
      headingImageId: imageId,
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
  | { readonly kind: "write_up_image_unavailable" }
  | { readonly kind: "heading_image_unavailable" };

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
export type ShowcaseHeadingImageSource =
  /** The original path: the file travelled as a multipart part on this very request. */
  | { readonly kind: "upload"; readonly rawBytes: Buffer }
  /** The draft path: the cover was staged earlier and the draft carries only its id. */
  | { readonly kind: "staged"; readonly headingImageId: string };

export async function submitShowcaseLaunch(input: {
  readonly authorUserId: string;
  readonly draft: ShowcaseLaunchDraft;
  readonly headingImage: ShowcaseHeadingImageSource;
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
        /*
         * ⚠️ THREE STATES, MATCHING `showcase_launch_title_live_uidx`'S PREDICATE EXACTLY. A
         * flagged launch was published, keeps its slug and still answers at its address, so its
         * title is still taken. If this list and the index ever disagree, this pre-check passes and
         * the index raises a 23505 the caller cannot read.
         */
        inArray(showcaseLaunch.moderationState, ["pending_review", "published", "flagged"]),
      ),
    )
    .limit(1);
  if (takenTitleRow) {
    return { success: false, error: { type: "SHOWCASE_LAUNCH_TITLE_TAKEN" } };
  }

  const launchId = randomUUID();

  /*
   * THE COVER ARRIVES ONE OF TWO WAYS, AND ONLY ONE OF THEM UPLOADS ANYTHING HERE.
   *
   * `upload` is the original multipart path: the bytes are on this request, so they are checked and
   * stored now, addressed under the launch id minted above.
   *
   * `staged` is the draft path: the file was checked and stored when the maker picked it, so this
   * only has to prove the row is theirs and unclaimed. Re-checking is impossible — the bytes are
   * not here — and re-uploading would orphan the asset the draft already points at.
   *
   * ⚠️ `stagedHeadingImageId` DECIDES WHAT HAPPENS ON FAILURE. An uploaded cover is deleted when
   * the launch is not written, because nothing else references it. A STAGED one is left alone: the
   * draft still points at it, and deleting it would take the maker's cover out of the draft they
   * are about to retry from.
   */
  let headingImagePublicId: string;
  let headingImageUrl: string;
  let stagedHeadingImageId: string | null = null;

  if (input.headingImage.kind === "upload") {
    const normalizedHeadingImage = await normalizeHeadingImageOrRefuse(input.headingImage.rawBytes);
    if (!normalizedHeadingImage.success) {
      return { success: false, error: normalizedHeadingImage.error };
    }
    headingImagePublicId = showcaseLaunchHeadingImagePublicId(launchId);
    const uploadResult = await uploadShowcaseImage(
      headingImagePublicId,
      normalizedHeadingImage.value.buffer,
    );
    if (!uploadResult.success) return { success: false, error: uploadResult.error };
    headingImageUrl = uploadResult.value.secureUrl;
  } else {
    const [stagedRow] = await db
      .select({
        id: showcaseLaunchHeadingImage.id,
        publicId: showcaseLaunchHeadingImage.publicId,
        url: showcaseLaunchHeadingImage.url,
      })
      .from(showcaseLaunchHeadingImage)
      .where(
        and(
          eq(showcaseLaunchHeadingImage.id, input.headingImage.headingImageId),
          // Theirs, and not already spent on another launch. A stranger's id and a claimed one are
          // the same answer, so the route cannot be used to find out which ids exist.
          eq(showcaseLaunchHeadingImage.uploadedByUserId, authorUserId),
          isNull(showcaseLaunchHeadingImage.launchId),
        ),
      )
      .limit(1);
    if (!stagedRow) {
      return { success: false, error: { type: "SHOWCASE_HEADING_IMAGE_NOT_AVAILABLE" } };
    }
    headingImagePublicId = stagedRow.publicId;
    headingImageUrl = stagedRow.url;
    stagedHeadingImageId = stagedRow.id;
  }

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

      /*
       * CLAIM THE STAGED COVER UNDER A ROW LOCK, inside the same transaction as everything else.
       *
       * The pre-check above read it without a lock, so two launches submitted at the same instant
       * could both have seen it free. The lock decides, and the `launch_id IS NULL` conjunct in the
       * UPDATE is what makes the second one lose — it matches no row, and the launch is refused
       * rather than two launches sharing one cover asset.
       */
      if (stagedHeadingImageId !== null) {
        const claimedHeadingRows = await tx
          .update(showcaseLaunchHeadingImage)
          .set({ launchId, draftId: null })
          .where(
            and(
              eq(showcaseLaunchHeadingImage.id, stagedHeadingImageId),
              eq(showcaseLaunchHeadingImage.uploadedByUserId, authorUserId),
              isNull(showcaseLaunchHeadingImage.launchId),
            ),
          )
          .returning({ id: showcaseLaunchHeadingImage.id });
        if (claimedHeadingRows.length === 0) {
          // Nothing written yet, so returning commits an empty transaction.
          return { kind: "heading_image_unavailable" };
        }
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
          headingImageUrl,
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
    if (stagedHeadingImageId === null) await discardUnusedHeadingImage(headingImagePublicId);
    return { success: false, error: { type: "SHOWCASE_LAUNCH_TITLE_TAKEN" } };
  }

  switch (transactionOutcome.kind) {
    case "write_up_image_unavailable":
      if (stagedHeadingImageId === null) await discardUnusedHeadingImage(headingImagePublicId);
      return { success: false, error: { type: "SHOWCASE_LAUNCH_WRITE_UP_IMAGE_NOT_AVAILABLE" } };
    case "heading_image_unavailable":
      // Never uploaded here, so there is nothing of ours to delete.
      return { success: false, error: { type: "SHOWCASE_HEADING_IMAGE_NOT_AVAILABLE" } };
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
 *
 * ⚠️ `publicSlug` IS PROJECTED RAW, AND THAT IS CORRECT HERE EVEN THOUGH `/teardowns/mine` COMPUTES
 * ITS OWN. It is the line in this file a reviewer is most likely to read as a bug now that
 * `flagged` is reachable, so: under `showcase_launch_decision_ck` a flagged launch KEEPS its slug
 * and its page still answers, so a "View the page" link built from this column is honest. On the
 * teardown arm the slug has to be computed because a QUARANTINED teardown is served but withheld —
 * its address resolves to a page with no payload, so a raw link would promise something the reader
 * will not get. Two arms, two correct answers, and the difference is quarantine.
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
