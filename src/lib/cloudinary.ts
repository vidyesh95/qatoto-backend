import { v2 as cloudinary } from "cloudinary";

import { config } from "#src/config/index.js";
import type { Result } from "#src/types/index.js";

/**
 * Avatar storage backed by Cloudinary. Credentials are optional (see config) so
 * the app boots without them; the photo endpoints surface NOT_CONFIGURED instead.
 *
 * Each user owns exactly one avatar asset at a DETERMINISTIC public id
 * (`qatoto/avatars/<userId>`). Uploading overwrites it in place and a delete
 * targets the same id — so we never need a separate column to track the asset,
 * and replacing a photo can't orphan the previous one.
 */
const AVATAR_FOLDER = "qatoto/avatars";

export type CloudinaryError =
  | { type: "NOT_CONFIGURED" }
  | { type: "UPLOAD_FAILED"; cause: string }
  | { type: "DELETE_FAILED"; cause: string };

let isConfigured = false;

/**
 * Configure the Cloudinary SDK once from env. Returns false when any credential
 * is missing — callers translate that into a NOT_CONFIGURED Result.
 */
function ensureConfigured(): boolean {
  if (isConfigured) {
    return true;
  }
  if (
    !config.CLOUDINARY_CLOUD_NAME ||
    !config.CLOUDINARY_API_KEY ||
    !config.CLOUDINARY_API_SECRET
  ) {
    return false;
  }
  cloudinary.config({
    cloud_name: config.CLOUDINARY_CLOUD_NAME,
    api_key: config.CLOUDINARY_API_KEY,
    api_secret: config.CLOUDINARY_API_SECRET,
    secure: true,
  });
  isConfigured = true;
  return true;
}

/** The stable public id this user's avatar always lives at. */
function avatarPublicId(userId: string): string {
  return `${AVATAR_FOLDER}/${userId}`;
}

/**
 * Upload (or overwrite) the user's avatar from an already-validated image buffer
 * and return the canonical secure URL. `invalidate` purges the old asset from the
 * CDN so the same URL serves the new bytes. The buffer MUST be re-encoded/checked
 * by the caller first (CLAUDE.md §1.1) — this layer trusts it.
 */
export async function uploadUserAvatar(
  userId: string,
  imageBuffer: Buffer,
): Promise<Result<{ secureUrl: string }, CloudinaryError>> {
  if (!ensureConfigured()) {
    return { success: false, error: { type: "NOT_CONFIGURED" } };
  }

  try {
    const secureUrl = await new Promise<string>((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          public_id: avatarPublicId(userId),
          resource_type: "image",
          overwrite: true,
          invalidate: true,
        },
        (error, uploadResult) => {
          if (error) {
            reject(new Error(error.message));
            return;
          }
          if (!uploadResult) {
            reject(new Error("Cloudinary returned no result"));
            return;
          }
          resolve(uploadResult.secure_url);
        },
      );
      uploadStream.end(imageBuffer);
    });

    return { success: true, value: { secureUrl } };
  } catch (uploadError) {
    return {
      success: false,
      error: {
        type: "UPLOAD_FAILED",
        cause: uploadError instanceof Error ? uploadError.message : String(uploadError),
      },
    };
  }
}

/**
 * Delete the user's avatar asset. Treated as success when the asset is already
 * gone ("not found") — the desired end state (no avatar) is reached either way.
 */
export async function deleteUserAvatar(
  userId: string,
): Promise<Result<{ deleted: boolean }, CloudinaryError>> {
  if (!ensureConfigured()) {
    return { success: false, error: { type: "NOT_CONFIGURED" } };
  }

  try {
    const destroyResult = await cloudinary.uploader.destroy(avatarPublicId(userId), {
      resource_type: "image",
      invalidate: true,
    });
    // Cloudinary returns { result: "ok" } on delete, "not found" if it never existed.
    return { success: true, value: { deleted: destroyResult.result === "ok" } };
  } catch (deleteError) {
    return {
      success: false,
      error: {
        type: "DELETE_FAILED",
        cause: deleteError instanceof Error ? deleteError.message : String(deleteError),
      },
    };
  }
}

/**
 * Product images live under a per-product folder, one asset per image id:
 * `qatoto/products/<productId>/<imageId>`. Unlike avatars (one asset per user,
 * overwritten in place), a product has MANY images, so each gets its own stable
 * id — uploading or deleting one never clobbers a sibling.
 */
const PRODUCT_FOLDER = "qatoto/products";

/** The stable public id for one product image. */
function productImagePublicId(productId: string, imageId: string): string {
  return `${PRODUCT_FOLDER}/${productId}/${imageId}`;
}

/** The folder prefix holding all of a product's image assets. */
function productFolderPrefix(productId: string): string {
  return `${PRODUCT_FOLDER}/${productId}/`;
}

/**
 * Upload one product image from an already-validated/re-encoded buffer and
 * return its canonical secure URL. The buffer MUST be checked+normalized by the
 * caller first (CLAUDE.md §1.1) — this layer trusts it. Each image has a unique
 * id, so there is nothing to overwrite.
 */
export async function uploadProductImage(
  productId: string,
  imageId: string,
  imageBuffer: Buffer,
): Promise<Result<{ secureUrl: string }, CloudinaryError>> {
  if (!ensureConfigured()) {
    return { success: false, error: { type: "NOT_CONFIGURED" } };
  }

  try {
    const secureUrl = await new Promise<string>((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          public_id: productImagePublicId(productId, imageId),
          resource_type: "image",
          overwrite: true,
          invalidate: true,
        },
        (error, uploadResult) => {
          if (error) {
            reject(new Error(error.message));
            return;
          }
          if (!uploadResult) {
            reject(new Error("Cloudinary returned no result"));
            return;
          }
          resolve(uploadResult.secure_url);
        },
      );
      uploadStream.end(imageBuffer);
    });

    return { success: true, value: { secureUrl } };
  } catch (uploadError) {
    return {
      success: false,
      error: {
        type: "UPLOAD_FAILED",
        cause: uploadError instanceof Error ? uploadError.message : String(uploadError),
      },
    };
  }
}

/**
 * Delete one product image asset. Treated as success when the asset is already
 * gone ("not found") — the desired end state is reached either way.
 */
export async function deleteProductImage(
  productId: string,
  imageId: string,
): Promise<Result<{ deleted: boolean }, CloudinaryError>> {
  if (!ensureConfigured()) {
    return { success: false, error: { type: "NOT_CONFIGURED" } };
  }

  try {
    const destroyResult = await cloudinary.uploader.destroy(
      productImagePublicId(productId, imageId),
      { resource_type: "image", invalidate: true },
    );
    return { success: true, value: { deleted: destroyResult.result === "ok" } };
  } catch (deleteError) {
    return {
      success: false,
      error: {
        type: "DELETE_FAILED",
        cause: deleteError instanceof Error ? deleteError.message : String(deleteError),
      },
    };
  }
}

/**
 * Destroy every asset under a product's folder in one call — used before a
 * listing delete so no orphaned images are left behind. A product with no images
 * yet ("not found" / empty prefix) still resolves as success.
 */
export async function deleteAllProductImages(
  productId: string,
): Promise<Result<{ deleted: boolean }, CloudinaryError>> {
  if (!ensureConfigured()) {
    return { success: false, error: { type: "NOT_CONFIGURED" } };
  }

  try {
    await cloudinary.api.delete_resources_by_prefix(productFolderPrefix(productId), {
      resource_type: "image",
      invalidate: true,
    });
    return { success: true, value: { deleted: true } };
  } catch (deleteError) {
    return {
      success: false,
      error: {
        type: "DELETE_FAILED",
        cause: deleteError instanceof Error ? deleteError.message : String(deleteError),
      },
    };
  }
}

/**
 * Review photos (STORE Appendix A8). Same per-parent-folder shape as product images:
 * `qatoto/reviews/<reviewId>/<mediaId>`, one asset per media row.
 *
 * A SEPARATE FOLDER FROM PRODUCTS, and that is the whole point of these three
 * functions existing rather than reusing the product trio. `deleteAllProductImages`
 * runs when a seller deletes a listing, and it destroys everything under
 * `qatoto/products/<productId>/`. Filing buyer testimony there would let the party a
 * review is about erase the photographic evidence in it by deleting the listing.
 *
 * Public delivery is the default and is intended: `upload_stream` with no `type`
 * option is `type: "upload"`, the same public URL product images get. Review photos
 * render on a public PDP — the opposite posture from A18's customization artwork,
 * which is envelope-encrypted in object storage because it is one buyer's private
 * commercial material. Do not "fix" this into an authenticated delivery type.
 */
const REVIEW_FOLDER = "qatoto/reviews";

/** The stable public id for one review photo. */
function reviewMediaPublicId(reviewId: string, mediaId: string): string {
  return `${REVIEW_FOLDER}/${reviewId}/${mediaId}`;
}

/** The folder prefix holding all of a review's photo assets. */
function reviewFolderPrefix(reviewId: string): string {
  return `${REVIEW_FOLDER}/${reviewId}/`;
}

/**
 * Upload one review photo from an already-validated/re-encoded buffer. The buffer
 * MUST have been through `validateAndNormalizeImage` first (CLAUDE.md §1.1) — that is
 * what proves the bytes are a raster image from their magic bytes rather than from the
 * multipart header, and what strips EXIF. A buyer's phone photo carries GPS, so the
 * re-encode matters more here than anywhere else in this codebase.
 */
export async function uploadReviewMedia(
  reviewId: string,
  mediaId: string,
  imageBuffer: Buffer,
): Promise<Result<{ secureUrl: string }, CloudinaryError>> {
  if (!ensureConfigured()) {
    return { success: false, error: { type: "NOT_CONFIGURED" } };
  }

  try {
    const secureUrl = await new Promise<string>((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          public_id: reviewMediaPublicId(reviewId, mediaId),
          resource_type: "image",
          overwrite: true,
          invalidate: true,
        },
        (error, uploadResult) => {
          if (error) {
            reject(new Error(error.message));
            return;
          }
          if (!uploadResult) {
            reject(new Error("Cloudinary returned no result"));
            return;
          }
          resolve(uploadResult.secure_url);
        },
      );
      uploadStream.end(imageBuffer);
    });

    return { success: true, value: { secureUrl } };
  } catch (uploadError) {
    return {
      success: false,
      error: {
        type: "UPLOAD_FAILED",
        cause: uploadError instanceof Error ? uploadError.message : String(uploadError),
      },
    };
  }
}

/**
 * Delete one review photo asset. An already-absent asset is success — the desired end
 * state is reached either way.
 */
export async function deleteReviewMedia(
  reviewId: string,
  mediaId: string,
): Promise<Result<{ deleted: boolean }, CloudinaryError>> {
  if (!ensureConfigured()) {
    return { success: false, error: { type: "NOT_CONFIGURED" } };
  }

  try {
    const destroyResult = await cloudinary.uploader.destroy(
      reviewMediaPublicId(reviewId, mediaId),
      { resource_type: "image", invalidate: true },
    );
    return { success: true, value: { deleted: destroyResult.result === "ok" } };
  } catch (deleteError) {
    return {
      success: false,
      error: {
        type: "DELETE_FAILED",
        cause: deleteError instanceof Error ? deleteError.message : String(deleteError),
      },
    };
  }
}

/**
 * Destroy every asset under a review's folder. Used if a review is ever hard-deleted;
 * `commerce_review_media` cascades, so the rows go with it and these assets would
 * otherwise be orphaned.
 */
export async function deleteAllReviewMedia(
  reviewId: string,
): Promise<Result<{ deleted: boolean }, CloudinaryError>> {
  if (!ensureConfigured()) {
    return { success: false, error: { type: "NOT_CONFIGURED" } };
  }

  try {
    await cloudinary.api.delete_resources_by_prefix(reviewFolderPrefix(reviewId), {
      resource_type: "image",
      invalidate: true,
    });
    return { success: true, value: { deleted: true } };
  } catch (deleteError) {
    return {
      success: false,
      error: {
        type: "DELETE_FAILED",
        cause: deleteError instanceof Error ? deleteError.message : String(deleteError),
      },
    };
  }
}

/**
 * R&D project covers. ONE asset per project, overwritten in place — the same shape as
 * avatars rather than product images, because a project has exactly one cover and a
 * re-upload should replace it rather than accumulate orphans.
 */
const RESEARCH_PROJECT_FOLDER = "qatoto/research-projects";

/** The stable, deterministic public id for a project's cover. */
export function projectCoverPublicId(projectId: string): string {
  return `${RESEARCH_PROJECT_FOLDER}/${projectId}/cover`;
}

/**
 * Upload a project cover from an already-validated/re-encoded buffer and return its
 * canonical secure URL. The buffer MUST be checked and normalized by the caller first
 * (CLAUDE.md §1.1) — this layer trusts it.
 *
 * `overwrite: true` + `invalidate: true` make re-upload idempotent and flush the CDN,
 * so the new cover is visible immediately rather than after a cache TTL.
 */
export async function uploadProjectCover(
  projectId: string,
  imageBuffer: Buffer,
): Promise<Result<{ secureUrl: string }, CloudinaryError>> {
  if (!ensureConfigured()) {
    return { success: false, error: { type: "NOT_CONFIGURED" } };
  }

  try {
    const secureUrl = await new Promise<string>((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          public_id: projectCoverPublicId(projectId),
          resource_type: "image",
          overwrite: true,
          invalidate: true,
        },
        (error, uploadResult) => {
          if (error) {
            reject(new Error(error.message));
            return;
          }
          if (!uploadResult) {
            reject(new Error("Cloudinary returned no result"));
            return;
          }
          resolve(uploadResult.secure_url);
        },
      );
      uploadStream.end(imageBuffer);
    });

    return { success: true, value: { secureUrl } };
  } catch (uploadError) {
    return {
      success: false,
      error: {
        type: "UPLOAD_FAILED",
        cause: uploadError instanceof Error ? uploadError.message : String(uploadError),
      },
    };
  }
}

/**
 * Delete a project's cover asset. Treated as success when the asset is already gone —
 * the desired end state is reached either way.
 */
export async function deleteProjectCover(
  projectId: string,
): Promise<Result<{ deleted: boolean }, CloudinaryError>> {
  if (!ensureConfigured()) {
    return { success: false, error: { type: "NOT_CONFIGURED" } };
  }

  try {
    const destroyResult: { result?: string } = await cloudinary.uploader.destroy(
      projectCoverPublicId(projectId),
      { invalidate: true },
    );
    const outcome = destroyResult.result;
    return { success: true, value: { deleted: outcome === "ok" } };
  } catch (deleteError) {
    return {
      success: false,
      error: {
        type: "DELETE_FAILED",
        cause: deleteError instanceof Error ? deleteError.message : String(deleteError),
      },
    };
  }
}

/**
 * Custom video thumbnails. ONE asset per video, overwritten in place — the project-cover
 * shape rather than the product-image shape, because a video has exactly one thumbnail
 * and a re-upload should replace it rather than accumulate orphans.
 *
 * NOTE WHAT THIS IS NOT. There is no video upload path here and there must not be: the
 * shipped design stores an 11-character YouTube id and never touches video bytes
 * (STUDIO_BACKEND_STRUCTURE.md §5). Only `resource_type: "image"` is ever used.
 *
 * The DEFAULT thumbnail is YouTube's own oEmbed `thumbnail_url` and costs nothing —
 * these helpers run only when a creator uploads their own, which is why `video`
 * carries `hasCustomThumbnail`: without it, DELETE cannot tell whether we own an asset
 * to destroy and would either orphan it or 503 on a box with no Cloudinary credentials.
 */
const VIDEO_THUMBNAIL_FOLDER = "qatoto/video-thumbnails";

/** The stable, deterministic public id for a video's custom thumbnail. */
export function videoThumbnailPublicId(videoId: string): string {
  return `${VIDEO_THUMBNAIL_FOLDER}/${videoId}/thumbnail`;
}

/**
 * Upload a custom thumbnail from an already-validated/re-encoded buffer and return its
 * canonical secure URL. The buffer MUST be checked and normalized by the caller first
 * (CLAUDE.md §1.1) — this layer trusts it.
 */
export async function uploadVideoThumbnail(
  videoId: string,
  imageBuffer: Buffer,
): Promise<Result<{ secureUrl: string }, CloudinaryError>> {
  if (!ensureConfigured()) {
    return { success: false, error: { type: "NOT_CONFIGURED" } };
  }

  try {
    const secureUrl = await new Promise<string>((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          public_id: videoThumbnailPublicId(videoId),
          resource_type: "image",
          overwrite: true,
          invalidate: true,
        },
        (error, uploadResult) => {
          if (error) {
            reject(new Error(error.message));
            return;
          }
          if (!uploadResult) {
            reject(new Error("Cloudinary returned no result"));
            return;
          }
          resolve(uploadResult.secure_url);
        },
      );
      uploadStream.end(imageBuffer);
    });

    return { success: true, value: { secureUrl } };
  } catch (uploadError) {
    return {
      success: false,
      error: {
        type: "UPLOAD_FAILED",
        cause: uploadError instanceof Error ? uploadError.message : String(uploadError),
      },
    };
  }
}

/**
 * Delete a video's custom thumbnail. Treated as success when the asset is already gone —
 * the desired end state is reached either way.
 */
export async function deleteVideoThumbnail(
  videoId: string,
): Promise<Result<{ deleted: boolean }, CloudinaryError>> {
  if (!ensureConfigured()) {
    return { success: false, error: { type: "NOT_CONFIGURED" } };
  }

  try {
    const destroyResult: { result?: string } = await cloudinary.uploader.destroy(
      videoThumbnailPublicId(videoId),
      { invalidate: true },
    );
    return { success: true, value: { deleted: destroyResult.result === "ok" } };
  } catch (deleteError) {
    return {
      success: false,
      error: {
        type: "DELETE_FAILED",
        cause: deleteError instanceof Error ? deleteError.message : String(deleteError),
      },
    };
  }
}

/**
 * §9 physical-work receipts. UNLIKE every other asset in this file, a receipt is
 * CONTENT-ADDRESSED rather than entity-addressed: its public id is derived from the
 * sha256 of the uploaded bytes.
 *
 * That is deliberate and it follows the domain rule. `physical_work_receipt_content_unq`
 * already guarantees the same bytes cannot fund two receipts inside one project, so a
 * content-addressed id makes the storage layer agree with the database rather than
 * quietly holding two copies under two ids. It also makes the upload idempotent: a
 * retried request overwrites itself.
 */
const PHYSICAL_RECEIPT_FOLDER = "qatoto/proof-of-effort/receipts";

/** The stable public id a receipt's bytes always live at, within its project. */
export function physicalReceiptPublicId(projectId: string, contentSha256: string): string {
  return `${PHYSICAL_RECEIPT_FOLDER}/${projectId}/${contentSha256}`;
}

/**
 * Removes a receipt's stored bytes (§11j.3).
 *
 * CALLED AFTER THE DATABASE TRANSACTION COMMITS, never inside it. A remote call cannot
 * participate in a Postgres transaction: if Cloudinary is slow the transaction holds locks
 * on evidence rows, and if it fails after the rows are gone there is nothing to roll back
 * to. The row is the record; the bytes are a copy. An orphaned asset is a cleanup job's
 * problem, whereas a rolled-back delete that already destroyed the image is data loss.
 */
export async function deletePhysicalReceipt(
  publicId: string,
): Promise<Result<{ deleted: boolean }, CloudinaryError>> {
  if (!ensureConfigured()) {
    return { success: false, error: { type: "NOT_CONFIGURED" } };
  }

  try {
    const destroyResult: { result?: string } = await cloudinary.uploader.destroy(publicId, {
      invalidate: true,
    });
    return { success: true, value: { deleted: destroyResult.result === "ok" } };
  } catch (deleteError) {
    return {
      success: false,
      error: {
        type: "DELETE_FAILED",
        cause: deleteError instanceof Error ? deleteError.message : String(deleteError),
      },
    };
  }
}

/**
 * Upload a receipt from an already-validated, re-encoded buffer.
 *
 * The buffer MUST be normalized by the caller first (CLAUDE.md §1.1) — this layer trusts
 * it. Note that the STORED image therefore carries no EXIF: the forensics read happens
 * against the raw upload before normalization, and the stripped copy is what a human
 * later looks at.
 */
export async function uploadPhysicalReceipt(
  projectId: string,
  contentSha256: string,
  imageBuffer: Buffer,
): Promise<Result<{ secureUrl: string; publicId: string }, CloudinaryError>> {
  if (!ensureConfigured()) {
    return { success: false, error: { type: "NOT_CONFIGURED" } };
  }

  const publicId = physicalReceiptPublicId(projectId, contentSha256);

  try {
    const secureUrl = await new Promise<string>((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        { public_id: publicId, resource_type: "image", overwrite: true, invalidate: true },
        (error, uploadResult) => {
          if (error) {
            reject(new Error(error.message));
            return;
          }
          if (!uploadResult) {
            reject(new Error("Cloudinary returned no result"));
            return;
          }
          resolve(uploadResult.secure_url);
        },
      );
      uploadStream.end(imageBuffer);
    });

    return { success: true, value: { secureUrl, publicId } };
  } catch (uploadError) {
    return {
      success: false,
      error: {
        type: "UPLOAD_FAILED",
        cause: uploadError instanceof Error ? uploadError.message : String(uploadError),
      },
    };
  }
}

/**
 * Home-page promotional slides. ONE asset per slide, overwritten in place — the
 * project-cover shape rather than the product-image shape, because a slide has exactly one
 * image and replacing it should replace the asset rather than accumulate orphans.
 *
 * The public id is DERIVED FROM THE SLIDE ID, which is why `promotional_slide` carries no
 * `cloudinaryPublicId` column: a column tracking a derivable value could only ever drift.
 * That is the same argument the avatar block at the top of this file makes.
 *
 * ONE CONSEQUENCE WORTH STATING. Because the id is stable, `overwrite: true` replaces the
 * bytes at the same id, and the secure_url Cloudinary returns carries a FRESH
 * `/v<timestamp>/` segment. Callers must write that returned URL back to `image_url` —
 * that version segment is what busts the browser cache. Reusing the stored URL after a
 * replace serves the old image indefinitely.
 */
const PROMOTIONAL_SLIDE_FOLDER = "qatoto/promotional-slides";

/** The stable, deterministic public id a slide's image always lives at. */
export function promotionalSlideImagePublicId(slideId: string): string {
  return `${PROMOTIONAL_SLIDE_FOLDER}/${slideId}`;
}

/**
 * Upload (or overwrite) a slide's image from an already-validated/re-encoded buffer and
 * return its canonical secure URL. The buffer MUST be checked and normalized by the caller
 * first (CLAUDE.md §1.1) — this layer trusts it.
 */
export async function uploadPromotionalSlideImage(
  slideId: string,
  imageBuffer: Buffer,
): Promise<Result<{ secureUrl: string }, CloudinaryError>> {
  if (!ensureConfigured()) {
    return { success: false, error: { type: "NOT_CONFIGURED" } };
  }

  try {
    const secureUrl = await new Promise<string>((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          public_id: promotionalSlideImagePublicId(slideId),
          resource_type: "image",
          overwrite: true,
          invalidate: true,
        },
        (error, uploadResult) => {
          if (error) {
            reject(new Error(error.message));
            return;
          }
          if (!uploadResult) {
            reject(new Error("Cloudinary returned no result"));
            return;
          }
          resolve(uploadResult.secure_url);
        },
      );
      uploadStream.end(imageBuffer);
    });

    return { success: true, value: { secureUrl } };
  } catch (uploadError) {
    return {
      success: false,
      error: {
        type: "UPLOAD_FAILED",
        cause: uploadError instanceof Error ? uploadError.message : String(uploadError),
      },
    };
  }
}

/**
 * Delete a slide's image asset. Treated as success when the asset is already gone — the
 * desired end state is reached either way.
 */
export async function deletePromotionalSlideImage(
  slideId: string,
): Promise<Result<{ deleted: boolean }, CloudinaryError>> {
  if (!ensureConfigured()) {
    return { success: false, error: { type: "NOT_CONFIGURED" } };
  }

  try {
    const destroyResult: { result?: string } = await cloudinary.uploader.destroy(
      promotionalSlideImagePublicId(slideId),
      { invalidate: true },
    );
    return { success: true, value: { deleted: destroyResult.result === "ok" } };
  } catch (deleteError) {
    return {
      success: false,
      error: {
        type: "DELETE_FAILED",
        cause: deleteError instanceof Error ? deleteError.message : String(deleteError),
      },
    };
  }
}

/**
 * ---------------------------------------------------------------------------------------
 * Content category tiles (HOME_BACKEND_STRUCTURE.md §2).
 *
 * Same deterministic-public-id shape as promotional slides, and for the same reason: the id
 * is derived from the category id, so replacing a tile's art overwrites in place and cannot
 * orphan the previous asset. The returned secure_url carries a fresh `/v<timestamp>/`
 * segment and MUST be written back to `content_category.image_url` — that segment is the
 * cache bust, and reusing the stored URL after a replace serves the old tile forever.
 *
 * Only TILES ever reach this function. A chip category has `image_url NULL` by design and
 * never has bytes to upload.
 * ---------------------------------------------------------------------------------------
 */
const CONTENT_CATEGORY_FOLDER = "qatoto/content-categories";

/** The stable, deterministic public id a category's tile image always lives at. */
export function contentCategoryImagePublicId(categoryId: string): string {
  return `${CONTENT_CATEGORY_FOLDER}/${categoryId}`;
}

/**
 * Upload (or overwrite) a category tile image from an already-validated/re-encoded buffer.
 * The buffer MUST be checked and normalized by the caller first (CLAUDE.md §1.1) — this
 * layer trusts it.
 */
export async function uploadContentCategoryImage(
  categoryId: string,
  imageBuffer: Buffer,
): Promise<Result<{ secureUrl: string }, CloudinaryError>> {
  if (!ensureConfigured()) {
    return { success: false, error: { type: "NOT_CONFIGURED" } };
  }

  try {
    const secureUrl = await new Promise<string>((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          public_id: contentCategoryImagePublicId(categoryId),
          resource_type: "image",
          overwrite: true,
          invalidate: true,
        },
        (error, uploadResult) => {
          if (error) {
            reject(new Error(error.message));
            return;
          }
          if (!uploadResult) {
            reject(new Error("Cloudinary returned no result"));
            return;
          }
          resolve(uploadResult.secure_url);
        },
      );
      uploadStream.end(imageBuffer);
    });

    return { success: true, value: { secureUrl } };
  } catch (uploadError) {
    return {
      success: false,
      error: {
        type: "UPLOAD_FAILED",
        cause: uploadError instanceof Error ? uploadError.message : String(uploadError),
      },
    };
  }
}

/**
 * Delete a category's tile image. Treated as success when the asset is already gone — the
 * desired end state is reached either way.
 */
export async function deleteContentCategoryImage(
  categoryId: string,
): Promise<Result<{ deleted: boolean }, CloudinaryError>> {
  if (!ensureConfigured()) {
    return { success: false, error: { type: "NOT_CONFIGURED" } };
  }

  try {
    const destroyResult: { result?: string } = await cloudinary.uploader.destroy(
      contentCategoryImagePublicId(categoryId),
      { invalidate: true },
    );
    return { success: true, value: { deleted: destroyResult.result === "ok" } };
  } catch (deleteError) {
    return {
      success: false,
      error: {
        type: "DELETE_FAILED",
        cause: deleteError instanceof Error ? deleteError.message : String(deleteError),
      },
    };
  }
}
