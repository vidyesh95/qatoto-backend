import { randomUUID } from "node:crypto";

import { and, asc, count, desc, eq } from "drizzle-orm";

import type {
  CreateProductInput,
  UpdateProductInput,
} from "#src/controllers/products.controller.js";
import { db } from "#src/db/index.js";
import { commerceCategory, product, productImage, productPricingTier } from "#src/db/schema.js";
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
  | { type: "CATEGORY_NOT_FOUND"; categoryId: string }
  | { type: "CATEGORY_NOT_ACTIVE_LEAF"; categoryId: string }
  | { type: "CATEGORY_MISMATCH"; categoryId: string }
  | { type: "TOO_MANY_IMAGES"; limit: number }
  | { type: "INCOMPLETE_FOR_PUBLISH"; missing: readonly string[] }
  | { type: "IMAGE_ORDER_MISMATCH" }
  | ImageValidationError
  | CloudinaryError;

type ProductUpdateOutcome =
  | { readonly status: "updated" }
  | { readonly status: "not_found" }
  | { readonly status: "category_error"; readonly error: ProductError };

type ProductPublishOutcome =
  | { readonly status: "published" }
  | { readonly status: "not_found" }
  | { readonly status: "category_error"; readonly error: ProductError }
  | { readonly status: "incomplete"; readonly missing: readonly string[] };

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
  readonly categoryId: string;
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
  categoryId: product.categoryId,
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
type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

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
    | "categoryId"
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
  if (row.categoryId === null) {
    throw new Error(`Product ${row.id} is missing its canonical commerce category.`);
  }
  return {
    id: row.id,
    title: row.title,
    brand: row.brand,
    category: row.category,
    categoryId: row.categoryId,
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
async function loadOrganizationProduct(
  sellerOrganizationId: string,
  productId: string,
): Promise<PublicProduct | null> {
  const [row] = await db
    .select(PRODUCT_SCALAR_COLUMNS)
    .from(product)
    .where(and(eq(product.id, productId), eq(product.sellerOrganizationId, sellerOrganizationId)));

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
async function findOrganizationProductId(
  sellerOrganizationId: string,
  productId: string,
): Promise<string | null> {
  const [owned] = await db
    .select({ id: product.id })
    .from(product)
    .where(and(eq(product.id, productId), eq(product.sellerOrganizationId, sellerOrganizationId)));
  return owned?.id ?? null;
}

type LegacyProductCategory = NonNullable<CreateProductInput["category"]>;

function legacyCategoryId(category: LegacyProductCategory): string {
  switch (category) {
    case "electronics":
      return "commerce_category_electronics";
    case "fashion":
      return "commerce_category_fashion";
    case "home_kitchen":
      return "commerce_category_home_kitchen";
    case "anime_collectibles":
      return "commerce_category_anime_collectibles";
    case "digital_goods":
      return "commerce_category_digital_goods";
    case "books_media":
      return "commerce_category_books_media";
    case "sports_outdoors":
      return "commerce_category_sports_outdoors";
    case "beauty_personal_care":
      return "commerce_category_beauty_personal_care";
    default: {
      const exhaustiveCategory: never = category;
      void exhaustiveCategory;
      throw new Error("Unhandled legacy product category.");
    }
  }
}

function legacyCategoryForRootId(rootCategoryId: string): LegacyProductCategory | null {
  switch (rootCategoryId) {
    case "commerce_category_electronics":
      return "electronics";
    case "commerce_category_fashion":
      return "fashion";
    case "commerce_category_home_kitchen":
      return "home_kitchen";
    case "commerce_category_anime_collectibles":
      return "anime_collectibles";
    case "commerce_category_digital_goods":
      return "digital_goods";
    case "commerce_category_books_media":
      return "books_media";
    case "commerce_category_sports_outdoors":
      return "sports_outdoors";
    case "commerce_category_beauty_personal_care":
      return "beauty_personal_care";
    default:
      return null;
  }
}

async function resolveProductCategory(
  transaction: DatabaseTransaction,
  input: {
    readonly category?: LegacyProductCategory;
    readonly categoryId?: string;
  },
): Promise<
  Result<{ readonly categoryId: string; readonly category: LegacyProductCategory }, ProductError>
> {
  const requestedCategoryId =
    input.categoryId ?? (input.category === undefined ? null : legacyCategoryId(input.category));
  if (requestedCategoryId === null) {
    throw new Error("Create/update category resolution requires category or categoryId.");
  }

  const [selectedCategory] = await transaction
    .select({
      id: commerceCategory.id,
      parentCategoryId: commerceCategory.parentCategoryId,
      state: commerceCategory.state,
    })
    .from(commerceCategory)
    .where(eq(commerceCategory.id, requestedCategoryId))
    .for("share");
  if (!selectedCategory) {
    return {
      success: false,
      error: { type: "CATEGORY_NOT_FOUND", categoryId: requestedCategoryId },
    };
  }

  const [childCategory] = await transaction
    .select({ id: commerceCategory.id })
    .from(commerceCategory)
    .where(eq(commerceCategory.parentCategoryId, requestedCategoryId))
    .for("share");
  if (selectedCategory.state !== "active" || childCategory) {
    return {
      success: false,
      error: { type: "CATEGORY_NOT_ACTIVE_LEAF", categoryId: requestedCategoryId },
    };
  }

  let rootCategoryId = selectedCategory.id;
  let parentCategoryId = selectedCategory.parentCategoryId;
  while (parentCategoryId !== null) {
    const [parentCategory] = await transaction
      .select({ id: commerceCategory.id, parentCategoryId: commerceCategory.parentCategoryId })
      .from(commerceCategory)
      .where(eq(commerceCategory.id, parentCategoryId))
      .for("share");
    if (!parentCategory) {
      return {
        success: false,
        error: { type: "CATEGORY_NOT_FOUND", categoryId: parentCategoryId },
      };
    }
    rootCategoryId = parentCategory.id;
    parentCategoryId = parentCategory.parentCategoryId;
  }

  const resolvedLegacyCategory = legacyCategoryForRootId(rootCategoryId);
  if (
    resolvedLegacyCategory === null ||
    (input.category !== undefined && input.category !== resolvedLegacyCategory)
  ) {
    return {
      success: false,
      error: { type: "CATEGORY_MISMATCH", categoryId: requestedCategoryId },
    };
  }

  return {
    success: true,
    value: { categoryId: requestedCategoryId, category: resolvedLegacyCategory },
  };
}

/**
 * Create a draft listing (identity + description + pricing + optional tiers).
 * `sellerId` MUST come from the server-derived session (CLAUDE.md §1.1), never
 * the body. The product row and its tiers are inserted in one transaction.
 */
export async function createProduct(
  commerceContext: { readonly userId: string; readonly organizationId: string },
  input: CreateProductInput,
): Promise<Result<PublicProduct, ProductError>> {
  try {
    return await db.transaction(
      async (tx) => {
        const categoryResult = await resolveProductCategory(tx, input);
        if (!categoryResult.success) return categoryResult;
        const [row] = await tx
          .insert(product)
          .values({
            sellerId: commerceContext.userId,
            sellerOrganizationId: commerceContext.organizationId,
            createdByUserId: commerceContext.userId,
            title: input.title,
            brand: input.brand ?? null,
            category: categoryResult.value.category,
            categoryId: categoryResult.value.categoryId,
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

        return { success: true, value: toPublicProduct(row, [], pricingTiers) };
      },
      { isolationLevel: "serializable" },
    );
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
  sellerOrganizationId: string,
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
    .where(eq(product.sellerOrganizationId, sellerOrganizationId))
    .orderBy(desc(product.updatedAt))
    .limit(limit)
    .offset(offset);

  const [totals] = await db
    .select({ value: count() })
    .from(product)
    .where(eq(product.sellerOrganizationId, sellerOrganizationId));

  return { rows, total: totals?.value ?? 0 };
}

/** Full listing for the edit/detail flow. Owner only → NOT_FOUND otherwise. */
export async function getProduct(
  sellerOrganizationId: string,
  productId: string,
): Promise<Result<PublicProduct, ProductError>> {
  const owned = await loadOrganizationProduct(sellerOrganizationId, productId);
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
  sellerOrganizationId: string,
  productId: string,
  patch: UpdateProductInput,
): Promise<Result<PublicProduct, ProductError>> {
  const scalarUpdates: Partial<typeof product.$inferInsert> = {};
  if (patch.title !== undefined) scalarUpdates.title = patch.title;
  if (patch.brand !== undefined) scalarUpdates.brand = patch.brand;
  if (patch.condition !== undefined) scalarUpdates.condition = patch.condition;
  if (patch.description !== undefined) scalarUpdates.description = patch.description;
  if (patch.priceInCents !== undefined) scalarUpdates.priceInCents = patch.priceInCents;
  if (patch.compareAtPriceInCents !== undefined)
    scalarUpdates.compareAtPriceInCents = patch.compareAtPriceInCents;
  if (patch.stockQuantity !== undefined) scalarUpdates.stockQuantity = patch.stockQuantity;
  if (patch.sku !== undefined) scalarUpdates.sku = patch.sku;
  if (patch.keyFeatures !== undefined) scalarUpdates.keyFeatures = patch.keyFeatures;

  try {
    const outcome = await db.transaction(
      async (tx): Promise<ProductUpdateOutcome> => {
        const [owned] = await tx
          .select({ id: product.id })
          .from(product)
          .where(
            and(eq(product.id, productId), eq(product.sellerOrganizationId, sellerOrganizationId)),
          );

        if (!owned) {
          return { status: "not_found" };
        }

        if (patch.category !== undefined || patch.categoryId !== undefined) {
          const categoryResult = await resolveProductCategory(tx, patch);
          if (!categoryResult.success) {
            return { status: "category_error", error: categoryResult.error };
          }
          scalarUpdates.category = categoryResult.value.category;
          scalarUpdates.categoryId = categoryResult.value.categoryId;
        }

        if (Object.keys(scalarUpdates).length > 0) {
          await tx
            .update(product)
            .set(scalarUpdates)
            .where(
              and(
                eq(product.id, productId),
                eq(product.sellerOrganizationId, sellerOrganizationId),
              ),
            );
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

        return { status: "updated" };
      },
      { isolationLevel: "serializable" },
    );

    switch (outcome.status) {
      case "updated":
        break;
      case "not_found":
        return { success: false, error: { type: "NOT_FOUND", productId } };
      case "category_error":
        return { success: false, error: outcome.error };
      default: {
        const exhaustiveOutcome: never = outcome;
        throw new Error(`Unhandled product update outcome: ${JSON.stringify(exhaustiveOutcome)}`);
      }
    }
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { success: false, error: { type: "SKU_TAKEN", sku: patch.sku ?? "" } };
    }
    throw error;
  }

  const owned = await loadOrganizationProduct(sellerOrganizationId, productId);
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
  sellerOrganizationId: string,
  productId: string,
  rawImageBytes: Buffer,
): Promise<Result<ProductImageView, ProductError>> {
  const ownedId = await findOrganizationProductId(sellerOrganizationId, productId);
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
  sellerOrganizationId: string,
  productId: string,
  imageId: string,
): Promise<Result<PublicProduct, ProductError>> {
  const ownedId = await findOrganizationProductId(sellerOrganizationId, productId);
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

  const owned = await loadOrganizationProduct(sellerOrganizationId, productId);
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
  sellerOrganizationId: string,
  productId: string,
  imageIds: readonly string[],
): Promise<Result<PublicProduct, ProductError>> {
  const ownedId = await findOrganizationProductId(sellerOrganizationId, productId);
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

  const owned = await loadOrganizationProduct(sellerOrganizationId, productId);
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
  sellerOrganizationId: string,
  productId: string,
): Promise<Result<PublicProduct, ProductError>> {
  const outcome = await db.transaction(
    async (transaction): Promise<ProductPublishOutcome> => {
      const [row] = await transaction
        .select({
          id: product.id,
          title: product.title,
          priceInCents: product.priceInCents,
          categoryId: product.categoryId,
        })
        .from(product)
        .where(
          and(eq(product.id, productId), eq(product.sellerOrganizationId, sellerOrganizationId)),
        )
        .for("update");
      if (!row) return { status: "not_found" };
      if (row.categoryId === null) {
        return {
          status: "category_error",
          error: { type: "CATEGORY_NOT_FOUND", categoryId: "" },
        };
      }

      const categoryResult = await resolveProductCategory(transaction, {
        categoryId: row.categoryId,
      });
      if (!categoryResult.success) {
        return { status: "category_error", error: categoryResult.error };
      }

      const [imageCount] = await transaction
        .select({ value: count() })
        .from(productImage)
        .where(eq(productImage.productId, productId));
      const missing: string[] = [];
      if (row.title.trim().length === 0) missing.push("title");
      if (row.priceInCents <= 0) missing.push("price");
      if ((imageCount?.value ?? 0) < 1) missing.push("images");
      if (missing.length > 0) return { status: "incomplete", missing };

      await transaction
        .update(product)
        .set({ status: "active", publishedAt: new Date() })
        .where(
          and(eq(product.id, productId), eq(product.sellerOrganizationId, sellerOrganizationId)),
        );
      return { status: "published" };
    },
    { isolationLevel: "serializable" },
  );

  switch (outcome.status) {
    case "published":
      break;
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND", productId } };
    case "category_error":
      return { success: false, error: outcome.error };
    case "incomplete":
      return {
        success: false,
        error: { type: "INCOMPLETE_FOR_PUBLISH", missing: outcome.missing },
      };
    default: {
      const exhaustiveOutcome: never = outcome;
      throw new Error(`Unhandled product publish outcome: ${JSON.stringify(exhaustiveOutcome)}`);
    }
  }

  const owned = await loadOrganizationProduct(sellerOrganizationId, productId);
  if (!owned) {
    return { success: false, error: { type: "NOT_FOUND", productId } };
  }
  return { success: true, value: owned };
}

/** Take an active listing back to draft. Leaves publishedAt as-is. */
export async function unpublishProduct(
  sellerOrganizationId: string,
  productId: string,
): Promise<Result<PublicProduct, ProductError>> {
  const [updated] = await db
    .update(product)
    .set({ status: "draft" })
    .where(and(eq(product.id, productId), eq(product.sellerOrganizationId, sellerOrganizationId)))
    .returning({ id: product.id });

  if (!updated) {
    return { success: false, error: { type: "NOT_FOUND", productId } };
  }

  const owned = await loadOrganizationProduct(sellerOrganizationId, productId);
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
  sellerOrganizationId: string,
  productId: string,
): Promise<Result<{ id: string }, ProductError>> {
  const ownedId = await findOrganizationProductId(sellerOrganizationId, productId);
  if (!ownedId) {
    return { success: false, error: { type: "NOT_FOUND", productId } };
  }

  const assetRemoval = await deleteAllProductImages(productId);
  if (!assetRemoval.success) {
    return { success: false, error: assetRemoval.error };
  }

  await db
    .delete(product)
    .where(and(eq(product.id, productId), eq(product.sellerOrganizationId, sellerOrganizationId)));

  return { success: true, value: { id: productId } };
}
