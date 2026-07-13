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
