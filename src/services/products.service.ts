import { randomUUID } from "node:crypto";

import { and, asc, count, desc, eq } from "drizzle-orm";

import type {
  CreateProductInput,
  UpdateProductInput,
} from "#src/controllers/products.controller.js";
import { db } from "#src/db/index.js";
import { product, productImage, productPricingTier } from "#src/db/schema.js";
import {
  deleteAllProductImages,
  deleteProductImage,
  uploadProductImage,
  type CloudinaryError,
} from "#src/lib/cloudinary.js";
import { validateAndNormalizeImage, type ImageValidationError } from "#src/lib/image.js";
import { isUniqueViolation as isUniqueConstraintViolation } from "#src/lib/pg-errors.js";
import type { Result } from "#src/types/index.js";

/** Max images per listing (the wizard's MAX_PRODUCT_IMAGES). Enforced here, not the DB. */
const MAX_PRODUCT_IMAGES = 9;

/** Product listing images are re-encoded to AVIF, downscaled into this box. */
const PRODUCT_IMAGE_OUTPUT_MAX_DIMENSION_PX = 1600;

/**
 * Domain failures for the product endpoints. String-literal `type` discriminant
 * (CLAUDE.md §3.3); the controller exhaustively switches these to HTTP statuses.
 * NOT_FOUND covers both "missing" and "not owned by the caller" — the two are
 * indistinguishable to the client on purpose, so listing ids can't be probed.
 */
export type ProductError =
  | { type: "NOT_FOUND"; productId: string }
  | { type: "SKU_TAKEN"; sku: string }
  | { type: "TOO_MANY_IMAGES"; limit: number }
  | { type: "INCOMPLETE_FOR_PUBLISH"; missing: readonly string[] }
  | { type: "IMAGE_ORDER_MISMATCH" }
  | ImageValidationError
  | CloudinaryError;

/** One image of a listing, as read back to the client. */
export interface ProductImageView {
  readonly id: string;
  readonly url: string;
  readonly position: number;
}

/** One B2B pricing tier, as read back to the client. */
export interface PricingTierView {
  readonly id: string;
  readonly unitPriceInCents: number;
  readonly minimumOrderQuantity: number;
  readonly position: number;
}

/**
 * Full listing for the create/edit/detail flows. One canonical projection so the
 * shape can't drift between mutations (mirrors PublicUser / PUBLIC_USER_COLUMNS).
 */
export interface PublicProduct {
  readonly id: string;
  readonly title: string;
  readonly brand: string | null;
  readonly category: string;
  readonly condition: "new" | "refurbished" | "used";
  readonly description: string | null;
  readonly priceInCents: number;
  readonly compareAtPriceInCents: number | null;
  readonly currency: string;
  readonly stockQuantity: number;
  readonly sku: string | null;
  readonly keyFeatures: readonly string[];
  readonly status: "draft" | "active";
  readonly publishedAt: Date | null;
  readonly images: readonly ProductImageView[];
  readonly pricingTiers: readonly PricingTierView[];
}

/** Compact row for the My Products list (maps 1:1 to products-page.tsx). */
export interface ProductListRow {
  readonly id: string;
  readonly title: string;
  readonly sku: string | null;
  readonly priceInCents: number;
  readonly stockQuantity: number;
  readonly status: "draft" | "active";
}

/** A page of the caller's listings plus the total for pagination metadata. */
export interface ProductPage {
  readonly rows: readonly ProductListRow[];
  readonly total: number;
}

/**
 * The scalar columns of a {@link PublicProduct} (everything but the nested images
 * and tiers). Shared by every product `.select()` / `.returning(...)` so the read
 * shape can't drift.
 */
const PRODUCT_SCALAR_COLUMNS = {
  id: product.id,
  title: product.title,
  brand: product.brand,
  category: product.category,
  condition: product.condition,
  description: product.description,
  priceInCents: product.priceInCents,
  compareAtPriceInCents: product.compareAtPriceInCents,
  currency: product.currency,
  stockQuantity: product.stockQuantity,
  sku: product.sku,
  keyFeatures: product.keyFeatures,
  status: product.status,
  publishedAt: product.publishedAt,
} as const;

const PRODUCT_IMAGE_VIEW_COLUMNS = {
  id: productImage.id,
  url: productImage.url,
  position: productImage.position,
} as const;

const PRICING_TIER_VIEW_COLUMNS = {
  id: productPricingTier.id,
  unitPriceInCents: productPricingTier.unitPriceInCents,
  minimumOrderQuantity: productPricingTier.minimumOrderQuantity,
  position: productPricingTier.position,
} as const;

type ProductScalarRow = typeof product.$inferSelect;

/**
 * A Postgres unique-constraint violation (SQLSTATE 23505). The UNIQUE(sellerId,
 * sku) index is the race-safe authority for SKU uniqueness — we let the insert
 * try and translate this one code into a domain SKU_TAKEN Result (an expected
 * operational failure, not a banned catch-all: any other error re-throws).
 *
 * BUG FIX: this previously read `error.code` at the top level, which is always
 * undefined under drizzle-orm 0.45 — it wraps driver failures in a
 * DrizzleQueryError and puts the pg error on `.cause`. The check therefore never
 * matched, and a duplicate SKU produced an unhandled re-throw (500) instead of
 * 409 SKU_TAKEN. See src/lib/pg-errors.ts, which walks the cause chain.
 */
const isUniqueViolation = isUniqueConstraintViolation;

/** Assemble the read-back shape from an already-loaded scalar row + its children. */
function toPublicProduct(
  row: Pick<
    ProductScalarRow,
    | "id"
    | "title"
    | "brand"
    | "category"
    | "condition"
    | "description"
    | "priceInCents"
    | "compareAtPriceInCents"
    | "currency"
    | "stockQuantity"
    | "sku"
    | "keyFeatures"
    | "status"
    | "publishedAt"
  >,
  images: readonly ProductImageView[],
  pricingTiers: readonly PricingTierView[],
): PublicProduct {
  return {
    id: row.id,
    title: row.title,
    brand: row.brand,
    category: row.category,
    condition: row.condition,
    description: row.description,
    priceInCents: row.priceInCents,
    compareAtPriceInCents: row.compareAtPriceInCents,
    currency: row.currency,
    stockQuantity: row.stockQuantity,
    sku: row.sku,
    keyFeatures: row.keyFeatures,
    status: row.status,
    publishedAt: row.publishedAt,
    images,
    pricingTiers,
  };
}

/**
 * Load a full {@link PublicProduct} the caller owns, or null. Ownership is
 * enforced IN the query (`sellerId = caller`) — an empty result means either the
 * row is missing or belongs to someone else; the caller can't tell which.
 */
async function loadOwnedProduct(
  sellerId: string,
  productId: string,
): Promise<PublicProduct | null> {
  const [row] = await db
    .select(PRODUCT_SCALAR_COLUMNS)
    .from(product)
    .where(and(eq(product.id, productId), eq(product.sellerId, sellerId)));

  if (!row) {
    return null;
  }

  const images = await db
    .select(PRODUCT_IMAGE_VIEW_COLUMNS)
    .from(productImage)
    .where(eq(productImage.productId, productId))
    .orderBy(asc(productImage.position));

  const pricingTiers = await db
    .select(PRICING_TIER_VIEW_COLUMNS)
    .from(productPricingTier)
    .where(eq(productPricingTier.productId, productId))
    .orderBy(asc(productPricingTier.position));

  return toPublicProduct(row, images, pricingTiers);
}

/** Confirm the caller owns this listing; returns the id or null. */
async function findOwnedProductId(sellerId: string, productId: string): Promise<string | null> {
  const [owned] = await db
    .select({ id: product.id })
    .from(product)
    .where(and(eq(product.id, productId), eq(product.sellerId, sellerId)));
  return owned?.id ?? null;
}

/**
 * Create a draft listing (identity + description + pricing + optional tiers).
 * `sellerId` MUST come from the server-derived session (CLAUDE.md §1.1), never
 * the body. The product row and its tiers are inserted in one transaction.
 */
export async function createProduct(
  sellerId: string,
  input: CreateProductInput,
): Promise<Result<PublicProduct, ProductError>> {
  try {
    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(product)
        .values({
          sellerId,
          title: input.title,
          brand: input.brand ?? null,
          category: input.category,
          condition: input.condition,
          description: input.description ?? null,
          priceInCents: input.priceInCents,
          compareAtPriceInCents: input.compareAtPriceInCents ?? null,
          stockQuantity: input.stockQuantity,
          sku: input.sku ?? null,
          keyFeatures: input.keyFeatures,
          // status ("draft") and currency ("USD") fall to their column defaults.
        })
        .returning(PRODUCT_SCALAR_COLUMNS);

      const pricingTiers =
        input.pricingTiers.length > 0
          ? await tx
              .insert(productPricingTier)
              .values(
                input.pricingTiers.map((tier, index) => ({
                  productId: row.id,
                  unitPriceInCents: tier.unitPriceInCents,
                  minimumOrderQuantity: tier.minimumOrderQuantity,
                  position: index,
                })),
              )
              .returning(PRICING_TIER_VIEW_COLUMNS)
          : [];

      return toPublicProduct(row, [], pricingTiers);
    });

    return { success: true, value: created };
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { success: false, error: { type: "SKU_TAKEN", sku: input.sku ?? "" } };
    }
    throw error;
  }
}

/**
 * The caller's own listings, newest-touched first, paginated. Pure read — always
 * succeeds. `sellerId` from the session, so a caller only ever lists their own.
 */
export async function listMyProducts(
  sellerId: string,
  page: number,
  limit: number,
): Promise<ProductPage> {
  const offset = (page - 1) * limit;

  const rows = await db
    .select({
      id: product.id,
      title: product.title,
      sku: product.sku,
      priceInCents: product.priceInCents,
      stockQuantity: product.stockQuantity,
      status: product.status,
    })
    .from(product)
    .where(eq(product.sellerId, sellerId))
    .orderBy(desc(product.updatedAt))
    .limit(limit)
    .offset(offset);

  const [totals] = await db
    .select({ value: count() })
    .from(product)
    .where(eq(product.sellerId, sellerId));

  return { rows, total: totals?.value ?? 0 };
}

/** Full listing for the edit/detail flow. Owner only → NOT_FOUND otherwise. */
export async function getProduct(
  sellerId: string,
  productId: string,
): Promise<Result<PublicProduct, ProductError>> {
  const owned = await loadOwnedProduct(sellerId, productId);
  if (!owned) {
    return { success: false, error: { type: "NOT_FOUND", productId } };
  }
  return { success: true, value: owned };
}

/**
 * Partial update of a listing's mutable fields. Any subset of columns may be
 * touched; when `pricingTiers` is present it REPLACES the whole tier set. All in
 * one transaction so the row and its tiers stay consistent.
 */
export async function updateProduct(
  sellerId: string,
  productId: string,
  patch: UpdateProductInput,
): Promise<Result<PublicProduct, ProductError>> {
  const scalarUpdates: Partial<typeof product.$inferInsert> = {};
  if (patch.title !== undefined) scalarUpdates.title = patch.title;
  if (patch.brand !== undefined) scalarUpdates.brand = patch.brand;
  if (patch.category !== undefined) scalarUpdates.category = patch.category;
  if (patch.condition !== undefined) scalarUpdates.condition = patch.condition;
  if (patch.description !== undefined) scalarUpdates.description = patch.description;
  if (patch.priceInCents !== undefined) scalarUpdates.priceInCents = patch.priceInCents;
  if (patch.compareAtPriceInCents !== undefined)
    scalarUpdates.compareAtPriceInCents = patch.compareAtPriceInCents;
  if (patch.stockQuantity !== undefined) scalarUpdates.stockQuantity = patch.stockQuantity;
  if (patch.sku !== undefined) scalarUpdates.sku = patch.sku;
  if (patch.keyFeatures !== undefined) scalarUpdates.keyFeatures = patch.keyFeatures;

  const hasScalarUpdates = Object.keys(scalarUpdates).length > 0;

  try {
    const notFound = await db.transaction(async (tx) => {
      const [owned] = await tx
        .select({ id: product.id })
        .from(product)
        .where(and(eq(product.id, productId), eq(product.sellerId, sellerId)));

      if (!owned) {
        return true;
      }

      if (hasScalarUpdates) {
        await tx
          .update(product)
          .set(scalarUpdates)
          .where(and(eq(product.id, productId), eq(product.sellerId, sellerId)));
      }

      if (patch.pricingTiers !== undefined) {
        await tx.delete(productPricingTier).where(eq(productPricingTier.productId, productId));
        if (patch.pricingTiers.length > 0) {
          await tx.insert(productPricingTier).values(
            patch.pricingTiers.map((tier, index) => ({
              productId,
              unitPriceInCents: tier.unitPriceInCents,
              minimumOrderQuantity: tier.minimumOrderQuantity,
              position: index,
            })),
          );
        }
      }

      return false;
    });

    if (notFound) {
      return { success: false, error: { type: "NOT_FOUND", productId } };
    }
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { success: false, error: { type: "SKU_TAKEN", sku: patch.sku ?? "" } };
    }
    throw error;
  }

  const owned = await loadOwnedProduct(sellerId, productId);
  if (!owned) {
    return { success: false, error: { type: "NOT_FOUND", productId } };
  }
  return { success: true, value: owned };
}

/**
 * Attach one image to a listing: ownership guard → count guard → sharp
 * validate/normalize (untrusted bytes) → Cloudinary upload → row at next
 * position. The DB row id IS the Cloudinary public-id segment, so a later delete
 * targets the exact asset.
 */
export async function addProductImage(
  sellerId: string,
  productId: string,
  rawImageBytes: Buffer,
): Promise<Result<ProductImageView, ProductError>> {
  const ownedId = await findOwnedProductId(sellerId, productId);
  if (!ownedId) {
    return { success: false, error: { type: "NOT_FOUND", productId } };
  }

  const [imageCount] = await db
    .select({ value: count() })
    .from(productImage)
    .where(eq(productImage.productId, productId));
  const currentCount = imageCount?.value ?? 0;

  if (currentCount >= MAX_PRODUCT_IMAGES) {
    return { success: false, error: { type: "TOO_MANY_IMAGES", limit: MAX_PRODUCT_IMAGES } };
  }

  const normalized = await validateAndNormalizeImage(rawImageBytes, {
    outputMaxDimensionPx: PRODUCT_IMAGE_OUTPUT_MAX_DIMENSION_PX,
    outputFormat: "avif",
  });
  if (!normalized.success) {
    return { success: false, error: normalized.error };
  }

  const imageId = randomUUID();
  const upload = await uploadProductImage(productId, imageId, normalized.value.buffer);
  if (!upload.success) {
    return { success: false, error: upload.error };
  }

  const [imageRow] = await db
    .insert(productImage)
    .values({
      id: imageId,
      productId,
      url: upload.value.secureUrl,
      position: currentCount,
    })
    .returning(PRODUCT_IMAGE_VIEW_COLUMNS);

  return { success: true, value: imageRow };
}

/**
 * Delete one image: destroy the Cloudinary asset, remove the row, and re-pack the
 * remaining positions so they stay contiguous (0-based). Returns the refreshed
 * listing so the client can re-render the gallery order.
 */
export async function deleteProductImageById(
  sellerId: string,
  productId: string,
  imageId: string,
): Promise<Result<PublicProduct, ProductError>> {
  const ownedId = await findOwnedProductId(sellerId, productId);
  if (!ownedId) {
    return { success: false, error: { type: "NOT_FOUND", productId } };
  }

  const [image] = await db
    .select({ id: productImage.id })
    .from(productImage)
    .where(and(eq(productImage.id, imageId), eq(productImage.productId, productId)));
  if (!image) {
    return { success: false, error: { type: "NOT_FOUND", productId } };
  }

  const removal = await deleteProductImage(productId, imageId);
  if (!removal.success) {
    return { success: false, error: removal.error };
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(productImage)
      .where(and(eq(productImage.id, imageId), eq(productImage.productId, productId)));

    const remaining = await tx
      .select({ id: productImage.id })
      .from(productImage)
      .where(eq(productImage.productId, productId))
      .orderBy(asc(productImage.position));

    for (let position = 0; position < remaining.length; position += 1) {
      await tx
        .update(productImage)
        .set({ position })
        .where(eq(productImage.id, remaining[position].id));
    }
  });

  const owned = await loadOwnedProduct(sellerId, productId);
  if (!owned) {
    return { success: false, error: { type: "NOT_FOUND", productId } };
  }
  return { success: true, value: owned };
}

/**
 * Set the gallery order (index 0 = main image). `imageIds` must be an exact
 * permutation of the product's current image ids — anything else is
 * IMAGE_ORDER_MISMATCH (the client is out of sync).
 */
export async function reorderImages(
  sellerId: string,
  productId: string,
  imageIds: readonly string[],
): Promise<Result<PublicProduct, ProductError>> {
  const ownedId = await findOwnedProductId(sellerId, productId);
  if (!ownedId) {
    return { success: false, error: { type: "NOT_FOUND", productId } };
  }

  const existing = await db
    .select({ id: productImage.id })
    .from(productImage)
    .where(eq(productImage.productId, productId));
  const existingIds = existing.map((row) => row.id);

  const requestedSet = new Set(imageIds);
  const isPermutation =
    requestedSet.size === imageIds.length &&
    requestedSet.size === existingIds.length &&
    existingIds.every((id) => requestedSet.has(id));

  if (!isPermutation) {
    return { success: false, error: { type: "IMAGE_ORDER_MISMATCH" } };
  }

  await db.transaction(async (tx) => {
    for (let position = 0; position < imageIds.length; position += 1) {
      await tx
        .update(productImage)
        .set({ position })
        .where(and(eq(productImage.id, imageIds[position]), eq(productImage.productId, productId)));
    }
  });

  const owned = await loadOwnedProduct(sellerId, productId);
  if (!owned) {
    return { success: false, error: { type: "NOT_FOUND", productId } };
  }
  return { success: true, value: owned };
}

/**
 * Publish a draft. Re-checks completeness SERVER-SIDE (title, price > 0, ≥ 1
 * image — category is a NOT NULL enum, always present); the client's "Publish"
 * click is a request, not an authorization. Sets status active + publishedAt.
 */
export async function publishProduct(
  sellerId: string,
  productId: string,
): Promise<Result<PublicProduct, ProductError>> {
  const [row] = await db
    .select({
      id: product.id,
      title: product.title,
      priceInCents: product.priceInCents,
    })
    .from(product)
    .where(and(eq(product.id, productId), eq(product.sellerId, sellerId)));

  if (!row) {
    return { success: false, error: { type: "NOT_FOUND", productId } };
  }

  const [imageCount] = await db
    .select({ value: count() })
    .from(productImage)
    .where(eq(productImage.productId, productId));

  const missing: string[] = [];
  if (row.title.trim().length === 0) missing.push("title");
  if (row.priceInCents <= 0) missing.push("price");
  if ((imageCount?.value ?? 0) < 1) missing.push("images");

  if (missing.length > 0) {
    return { success: false, error: { type: "INCOMPLETE_FOR_PUBLISH", missing } };
  }

  await db
    .update(product)
    .set({ status: "active", publishedAt: new Date() })
    .where(and(eq(product.id, productId), eq(product.sellerId, sellerId)));

  const owned = await loadOwnedProduct(sellerId, productId);
  if (!owned) {
    return { success: false, error: { type: "NOT_FOUND", productId } };
  }
  return { success: true, value: owned };
}

/** Take an active listing back to draft. Leaves publishedAt as-is. */
export async function unpublishProduct(
  sellerId: string,
  productId: string,
): Promise<Result<PublicProduct, ProductError>> {
  const [updated] = await db
    .update(product)
    .set({ status: "draft" })
    .where(and(eq(product.id, productId), eq(product.sellerId, sellerId)))
    .returning({ id: product.id });

  if (!updated) {
    return { success: false, error: { type: "NOT_FOUND", productId } };
  }

  const owned = await loadOwnedProduct(sellerId, productId);
  if (!owned) {
    return { success: false, error: { type: "NOT_FOUND", productId } };
  }
  return { success: true, value: owned };
}

/**
 * Delete a listing. Destroys ALL of its Cloudinary assets first (so nothing is
 * orphaned), then deletes the row — the FK cascade clears image and tier rows.
 */
export async function deleteProduct(
  sellerId: string,
  productId: string,
): Promise<Result<{ id: string }, ProductError>> {
  const ownedId = await findOwnedProductId(sellerId, productId);
  if (!ownedId) {
    return { success: false, error: { type: "NOT_FOUND", productId } };
  }

  const assetRemoval = await deleteAllProductImages(productId);
  if (!assetRemoval.success) {
    return { success: false, error: assetRemoval.error };
  }

  await db.delete(product).where(and(eq(product.id, productId), eq(product.sellerId, sellerId)));

  return { success: true, value: { id: productId } };
}
