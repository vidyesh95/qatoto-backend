import { randomUUID } from "node:crypto";

import { and, asc, count, desc, eq, isNull, sql } from "drizzle-orm";

import type {
  CreateProductInput,
  UpdateProductInput,
} from "#src/controllers/products.controller.js";
import { db } from "#src/db/index.js";
import {
  commerceCategory,
  commerceProductHighlight,
  commerceProductSpecification,
  commerceProductVariant,
  product,
  productImage,
  productPricingTier,
  storeSearchDocument,
} from "#src/db/schema.js";
import {
  deleteAllProductImages,
  deleteProductImage,
  uploadProductImage,
  type CloudinaryError,
} from "#src/lib/cloudinary.js";
import { validateAndNormalizeImage, type ImageValidationError } from "#src/lib/image.js";
import { isUniqueViolation as isUniqueConstraintViolation } from "#src/lib/pg-errors.js";
import { slugifyPublicTitle } from "#src/lib/store-cursor.js";
import { enqueueProductSearchDocumentRefresh } from "#src/services/store-search.service.js";
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
  /** A1. Null is the shared gallery; non-null scopes the asset to one variant. */
  readonly variantId: string | null;
  readonly url: string;
  /** A2. What makes a 360 spin or a video expressible at all. */
  readonly mediaKind: "photo" | "video" | "spin_360";
  readonly altText: string | null;
  readonly widthPx: number | null;
  readonly heightPx: number | null;
  readonly position: number;
}

/** One B2B pricing tier, as read back to the client. */
export interface PricingTierView {
  readonly id: string;
  /** A1. Null is the product default ladder; non-null applies to one variant. */
  readonly variantId: string | null;
  readonly unitPriceInCents: number;
  readonly minimumOrderQuantity: number;
  readonly position: number;
}

/** One structured product specification, as read back to the client. */
export interface ProductSpecificationView {
  readonly key: string;
  readonly value: string;
  /** A3. Null is ungrouped, which is every pre-Phase-8 row. */
  readonly group: string | null;
  readonly position: number;
}

/** A1. One buyable variation, as read back to its owning seller. */
export interface ProductVariantView {
  readonly id: string;
  readonly name: string;
  readonly publicSlug: string;
  readonly sku: string | null;
  readonly priceInCents: number;
  readonly stockQuantity: number;
  readonly minimumOrderQuantity: number | null;
  readonly position: number;
  readonly state: "active" | "retired";
  readonly pricingTiers: readonly PricingTierView[];
}

/** A6. One marketing highlight card. */
export interface ProductHighlightView {
  readonly id: string;
  readonly title: string;
  readonly bodyText: string;
  readonly imageUrl: string | null;
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
  readonly publicSlug: string | null;
  readonly modelNumber: string | null;
  readonly countryOfOriginCode: string | null;
  readonly unitOfMeasure: string | null;
  readonly samplePolicy: "unavailable" | "paid" | "refundable";
  readonly samplePriceInCents: number | null;
  readonly leadTimeMinDays: number | null;
  readonly leadTimeMaxDays: number | null;
  readonly packageLengthMm: number | null;
  readonly packageWidthMm: number | null;
  readonly packageHeightMm: number | null;
  readonly packageGrossWeightGrams: number | null;
  readonly unitsPerPackage: number | null;
  readonly moderationState: "pending" | "approved" | "rejected" | "suspended";
  readonly images: readonly ProductImageView[];
  readonly pricingTiers: readonly PricingTierView[];
  readonly specifications: readonly ProductSpecificationView[];
  readonly variants: readonly ProductVariantView[];
  readonly highlights: readonly ProductHighlightView[];
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
  publicSlug: product.publicSlug,
  modelNumber: product.modelNumber,
  countryOfOriginCode: product.countryOfOriginCode,
  unitOfMeasure: product.unitOfMeasure,
  samplePolicy: product.samplePolicy,
  samplePriceInCents: product.samplePriceInCents,
  leadTimeMinDays: product.leadTimeMinDays,
  leadTimeMaxDays: product.leadTimeMaxDays,
  packageLengthMm: product.packageLengthMm,
  packageWidthMm: product.packageWidthMm,
  packageHeightMm: product.packageHeightMm,
  packageGrossWeightGrams: product.packageGrossWeightGrams,
  unitsPerPackage: product.unitsPerPackage,
  moderationState: product.moderationState,
} as const;

const PRODUCT_IMAGE_VIEW_COLUMNS = {
  id: productImage.id,
  variantId: productImage.variantId,
  url: productImage.url,
  mediaKind: productImage.mediaKind,
  altText: productImage.altText,
  widthPx: productImage.widthPx,
  heightPx: productImage.heightPx,
  position: productImage.position,
} as const;

const PRICING_TIER_VIEW_COLUMNS = {
  id: productPricingTier.id,
  variantId: productPricingTier.variantId,
  unitPriceInCents: productPricingTier.unitPriceInCents,
  minimumOrderQuantity: productPricingTier.minimumOrderQuantity,
  position: productPricingTier.position,
} as const;

const PRODUCT_SPECIFICATION_VIEW_COLUMNS = {
  key: commerceProductSpecification.specificationKey,
  value: commerceProductSpecification.specificationValue,
  group: commerceProductSpecification.specificationGroup,
  position: commerceProductSpecification.position,
} as const;

const PRODUCT_VARIANT_VIEW_COLUMNS = {
  id: commerceProductVariant.id,
  name: commerceProductVariant.name,
  publicSlug: commerceProductVariant.publicSlug,
  sku: commerceProductVariant.sku,
  priceInCents: commerceProductVariant.priceInCents,
  stockQuantity: commerceProductVariant.stockQuantity,
  minimumOrderQuantity: commerceProductVariant.minimumOrderQuantity,
  position: commerceProductVariant.position,
  state: commerceProductVariant.state,
} as const;

const PRODUCT_HIGHLIGHT_VIEW_COLUMNS = {
  id: commerceProductHighlight.id,
  title: commerceProductHighlight.title,
  bodyText: commerceProductHighlight.bodyText,
  imageUrl: commerceProductHighlight.imageUrl,
  position: commerceProductHighlight.position,
} as const;

type ProductScalarRow = {
  readonly [ColumnKey in keyof typeof PRODUCT_SCALAR_COLUMNS]: (typeof product.$inferSelect)[ColumnKey];
};
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
  row: ProductScalarRow,
  images: readonly ProductImageView[],
  pricingTiers: readonly PricingTierView[],
  specifications: readonly ProductSpecificationView[],
  variants: readonly ProductVariantView[] = [],
  highlights: readonly ProductHighlightView[] = [],
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
    publicSlug: row.publicSlug,
    modelNumber: row.modelNumber,
    countryOfOriginCode: row.countryOfOriginCode,
    unitOfMeasure: row.unitOfMeasure,
    samplePolicy: row.samplePolicy,
    samplePriceInCents: row.samplePriceInCents,
    leadTimeMinDays: row.leadTimeMinDays,
    leadTimeMaxDays: row.leadTimeMaxDays,
    packageLengthMm: row.packageLengthMm,
    packageWidthMm: row.packageWidthMm,
    packageHeightMm: row.packageHeightMm,
    packageGrossWeightGrams: row.packageGrossWeightGrams,
    unitsPerPackage: row.unitsPerPackage,
    moderationState: row.moderationState,
    images,
    pricingTiers,
    specifications,
    variants,
    highlights,
  };
}

async function replaceProductSpecifications(
  transaction: DatabaseTransaction,
  productId: string,
  specifications: readonly {
    readonly key: string;
    readonly value: string;
    readonly group?: string | undefined;
  }[],
): Promise<readonly ProductSpecificationView[]> {
  await transaction
    .delete(commerceProductSpecification)
    .where(eq(commerceProductSpecification.productId, productId));
  if (specifications.length === 0) {
    return [];
  }
  return transaction
    .insert(commerceProductSpecification)
    .values(
      specifications.map((specification, index) => ({
        productId,
        specificationKey: specification.key,
        specificationValue: specification.value,
        specificationGroup: specification.group ?? null,
        position: index,
      })),
    )
    .returning(PRODUCT_SPECIFICATION_VIEW_COLUMNS);
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

  const specifications = await db
    .select(PRODUCT_SPECIFICATION_VIEW_COLUMNS)
    .from(commerceProductSpecification)
    .where(eq(commerceProductSpecification.productId, productId))
    .orderBy(asc(commerceProductSpecification.position));

  const variantRows = await db
    .select(PRODUCT_VARIANT_VIEW_COLUMNS)
    .from(commerceProductVariant)
    .where(eq(commerceProductVariant.productId, productId))
    .orderBy(asc(commerceProductVariant.position));

  const highlights = await db
    .select(PRODUCT_HIGHLIGHT_VIEW_COLUMNS)
    .from(commerceProductHighlight)
    .where(eq(commerceProductHighlight.productId, productId))
    .orderBy(asc(commerceProductHighlight.position));

  const variants: ProductVariantView[] = variantRows.map((variantRow) => ({
    ...variantRow,
    pricingTiers: pricingTiers.filter((tier) => tier.variantId === variantRow.id),
  }));

  return toPublicProduct(
    row,
    images,
    // The seller edits the product ladder here; variant ladders ride their variant.
    pricingTiers.filter((tier) => tier.variantId === null),
    specifications,
    variants,
    highlights,
  );
}

/**
 * Replaces the whole variant set (A1).
 *
 * DELETE-THEN-INSERT IS WRONG HERE, unlike for specifications and tiers. A variant
 * id is referenced by cart lines, reservations and order-line snapshots under
 * `restrict`, so recreating one would either fail or silently orphan a buyer's cart.
 * Instead: variants named in the payload are upserted by `publicSlug` (the seller's
 * stable handle for one), and variants left out are RETIRED, not deleted.
 */
async function replaceProductVariants(
  transaction: DatabaseTransaction,
  productId: string,
  variants: readonly {
    readonly name: string;
    readonly publicSlug: string;
    readonly sku?: string | undefined;
    readonly priceInCents: number;
    readonly stockQuantity: number;
    readonly minimumOrderQuantity?: number | undefined;
    readonly pricingTiers: readonly {
      readonly unitPriceInCents: number;
      readonly minimumOrderQuantity: number;
    }[];
  }[],
): Promise<void> {
  const existingVariants = await transaction
    .select({
      id: commerceProductVariant.id,
      publicSlug: commerceProductVariant.publicSlug,
    })
    .from(commerceProductVariant)
    .where(eq(commerceProductVariant.productId, productId));
  const existingIdBySlug = new Map(
    existingVariants.map((variant) => [variant.publicSlug, variant.id]),
  );

  /**
   * `position` is uniquely indexed per product, so writing final positions directly
   * would collide with a variant still sitting at that position. Park everything
   * beyond the incoming range first, in one statement.
   */
  const positionParkingOffset = existingVariants.length + variants.length + 1000;
  await transaction
    .update(commerceProductVariant)
    .set({ position: sql`${commerceProductVariant.position} + ${positionParkingOffset}` })
    .where(eq(commerceProductVariant.productId, productId));

  const keptVariantIds: string[] = [];
  for (const [index, variant] of variants.entries()) {
    const existingId = existingIdBySlug.get(variant.publicSlug);
    const variantId = existingId ?? randomUUID();
    if (existingId === undefined) {
      await transaction.insert(commerceProductVariant).values({
        id: variantId,
        productId,
        name: variant.name,
        publicSlug: variant.publicSlug,
        sku: variant.sku ?? null,
        priceInCents: variant.priceInCents,
        stockQuantity: variant.stockQuantity,
        minimumOrderQuantity: variant.minimumOrderQuantity ?? null,
        position: index,
        state: "active",
      });
    } else {
      await transaction
        .update(commerceProductVariant)
        .set({
          name: variant.name,
          sku: variant.sku ?? null,
          priceInCents: variant.priceInCents,
          stockQuantity: variant.stockQuantity,
          minimumOrderQuantity: variant.minimumOrderQuantity ?? null,
          position: index,
          // A retired slug being sent again is a deliberate un-retirement.
          state: "active",
        })
        .where(eq(commerceProductVariant.id, variantId));
    }
    keptVariantIds.push(variantId);

    await transaction.delete(productPricingTier).where(eq(productPricingTier.variantId, variantId));
    if (variant.pricingTiers.length > 0) {
      await transaction.insert(productPricingTier).values(
        variant.pricingTiers.map((tier, tierIndex) => ({
          productId,
          variantId,
          unitPriceInCents: tier.unitPriceInCents,
          minimumOrderQuantity: tier.minimumOrderQuantity,
          position: tierIndex,
        })),
      );
    }
  }

  const retiredVariants = existingVariants.filter(
    (variant) => !keptVariantIds.includes(variant.id),
  );
  for (const [index, variant] of retiredVariants.entries()) {
    await transaction
      .update(commerceProductVariant)
      .set({ state: "retired", position: variants.length + index })
      .where(eq(commerceProductVariant.id, variant.id));
  }
}

/** A6. Highlights have no downstream references, so replace-all is safe. */
async function replaceProductHighlights(
  transaction: DatabaseTransaction,
  productId: string,
  highlights: readonly {
    readonly title: string;
    readonly bodyText: string;
    readonly imageUrl?: string | undefined;
  }[],
): Promise<void> {
  await transaction
    .delete(commerceProductHighlight)
    .where(eq(commerceProductHighlight.productId, productId));
  if (highlights.length === 0) {
    return;
  }
  await transaction.insert(commerceProductHighlight).values(
    highlights.map((highlight, index) => ({
      productId,
      title: highlight.title,
      bodyText: highlight.bodyText,
      imageUrl: highlight.imageUrl ?? null,
      position: index,
    })),
  );
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
            modelNumber: input.modelNumber ?? null,
            countryOfOriginCode: input.countryOfOriginCode ?? null,
            unitOfMeasure: input.unitOfMeasure ?? null,
            samplePolicy: input.samplePolicy ?? "unavailable",
            samplePriceInCents: input.samplePriceInCents ?? null,
            leadTimeMinDays: input.leadTimeMinDays ?? null,
            leadTimeMaxDays: input.leadTimeMaxDays ?? null,
            packageLengthMm: input.packageLengthMm ?? null,
            packageWidthMm: input.packageWidthMm ?? null,
            packageHeightMm: input.packageHeightMm ?? null,
            packageGrossWeightGrams: input.packageGrossWeightGrams ?? null,
            unitsPerPackage: input.unitsPerPackage ?? null,
            // status ("draft"), moderationState ("pending"), and currency ("USD") use defaults.
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

        const specifications = await replaceProductSpecifications(tx, row.id, input.specifications);

        return { success: true, value: toPublicProduct(row, [], pricingTiers, specifications) };
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
  if (patch.modelNumber !== undefined) scalarUpdates.modelNumber = patch.modelNumber;
  if (patch.countryOfOriginCode !== undefined)
    scalarUpdates.countryOfOriginCode = patch.countryOfOriginCode;
  if (patch.unitOfMeasure !== undefined) scalarUpdates.unitOfMeasure = patch.unitOfMeasure;
  if (patch.samplePolicy !== undefined) scalarUpdates.samplePolicy = patch.samplePolicy;
  if (patch.samplePriceInCents !== undefined)
    scalarUpdates.samplePriceInCents = patch.samplePriceInCents;
  if (patch.leadTimeMinDays !== undefined) scalarUpdates.leadTimeMinDays = patch.leadTimeMinDays;
  if (patch.leadTimeMaxDays !== undefined) scalarUpdates.leadTimeMaxDays = patch.leadTimeMaxDays;
  if (patch.packageLengthMm !== undefined) scalarUpdates.packageLengthMm = patch.packageLengthMm;
  if (patch.packageWidthMm !== undefined) scalarUpdates.packageWidthMm = patch.packageWidthMm;
  if (patch.packageHeightMm !== undefined) scalarUpdates.packageHeightMm = patch.packageHeightMm;
  if (patch.packageGrossWeightGrams !== undefined)
    scalarUpdates.packageGrossWeightGrams = patch.packageGrossWeightGrams;
  if (patch.unitsPerPackage !== undefined) scalarUpdates.unitsPerPackage = patch.unitsPerPackage;

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
          /**
           * A1: `isNull(variantId)` scopes this to the PRODUCT ladder. Without it, a
           * PATCH touching product tiers would delete every variant's ladder too —
           * the same class of bug the `productFieldShapes` comment above documents.
           */
          await tx
            .delete(productPricingTier)
            .where(
              and(
                eq(productPricingTier.productId, productId),
                isNull(productPricingTier.variantId),
              ),
            );
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

        if (patch.specifications !== undefined) {
          await replaceProductSpecifications(tx, productId, patch.specifications);
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
  await enqueueProductSearchDocumentRefresh(productId);
  return { success: true, value: owned };
}

/**
 * Replace the listing's variant set (A1). Ownership is enforced in the same
 * transaction, so a caller who does not own the listing gets NOT_FOUND and cannot
 * tell it from a missing id.
 */
export async function replaceVariants(
  sellerOrganizationId: string,
  productId: string,
  variants: readonly {
    readonly name: string;
    readonly publicSlug: string;
    readonly sku?: string | undefined;
    readonly priceInCents: number;
    readonly stockQuantity: number;
    readonly minimumOrderQuantity?: number | undefined;
    readonly pricingTiers: readonly {
      readonly unitPriceInCents: number;
      readonly minimumOrderQuantity: number;
    }[];
  }[],
): Promise<Result<PublicProduct, ProductError>> {
  try {
    const owned = await db.transaction(
      async (tx) => {
        const ownedId = await (async () => {
          const [row] = await tx
            .select({ id: product.id })
            .from(product)
            .where(
              and(
                eq(product.id, productId),
                eq(product.sellerOrganizationId, sellerOrganizationId),
              ),
            );
          return row?.id ?? null;
        })();
        if (ownedId === null) return false;

        await replaceProductVariants(tx, productId, variants);
        return true;
      },
      { isolationLevel: "serializable" },
    );
    if (!owned) {
      return { success: false, error: { type: "NOT_FOUND", productId } };
    }
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { success: false, error: { type: "SKU_TAKEN", sku: "" } };
    }
    throw error;
  }

  const reloaded = await loadOrganizationProduct(sellerOrganizationId, productId);
  if (!reloaded) {
    return { success: false, error: { type: "NOT_FOUND", productId } };
  }
  // Variant names and the price floor are both indexed, so search must be refreshed.
  await enqueueProductSearchDocumentRefresh(productId);
  return { success: true, value: reloaded };
}

/** Replace the listing's highlight cards (A6). */
export async function replaceHighlights(
  sellerOrganizationId: string,
  productId: string,
  highlights: readonly {
    readonly title: string;
    readonly bodyText: string;
    readonly imageUrl?: string | undefined;
  }[],
): Promise<Result<PublicProduct, ProductError>> {
  const owned = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: product.id })
      .from(product)
      .where(
        and(eq(product.id, productId), eq(product.sellerOrganizationId, sellerOrganizationId)),
      );
    if (!row) return false;
    await replaceProductHighlights(tx, productId, highlights);
    return true;
  });
  if (!owned) {
    return { success: false, error: { type: "NOT_FOUND", productId } };
  }

  const reloaded = await loadOrganizationProduct(sellerOrganizationId, productId);
  if (!reloaded) {
    return { success: false, error: { type: "NOT_FOUND", productId } };
  }
  await enqueueProductSearchDocumentRefresh(productId);
  return { success: true, value: reloaded };
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
  options: {
    readonly variantId?: string | undefined;
    readonly mediaKind?: "photo" | "video" | "spin_360" | undefined;
    readonly altText?: string | undefined;
  } = {},
): Promise<Result<ProductImageView, ProductError>> {
  const ownedId = await findOrganizationProductId(sellerOrganizationId, productId);
  if (!ownedId) {
    return { success: false, error: { type: "NOT_FOUND", productId } };
  }

  /**
   * A1: a variant gallery is scoped to the variant, so both the cap and the next
   * position are counted within that gallery. `NOT_FOUND` when the variant is not
   * this product's — the same non-probeable answer ownership failures give.
   */
  const targetVariantId = options.variantId ?? null;
  if (targetVariantId !== null) {
    const [ownedVariant] = await db
      .select({ id: commerceProductVariant.id })
      .from(commerceProductVariant)
      .where(
        and(
          eq(commerceProductVariant.id, targetVariantId),
          eq(commerceProductVariant.productId, productId),
        ),
      );
    if (!ownedVariant) {
      return { success: false, error: { type: "NOT_FOUND", productId } };
    }
  }

  const galleryScope = and(
    eq(productImage.productId, productId),
    targetVariantId === null
      ? isNull(productImage.variantId)
      : eq(productImage.variantId, targetVariantId),
  );

  const [imageCount] = await db.select({ value: count() }).from(productImage).where(galleryScope);
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
      variantId: targetVariantId,
      url: upload.value.secureUrl,
      // A2. Measured from the normalized bytes, never taken from the client.
      mediaKind: options.mediaKind ?? "photo",
      altText: options.altText ?? null,
      widthPx: normalized.value.width,
      heightPx: normalized.value.height,
      position: currentCount,
    })
    .returning(PRODUCT_IMAGE_VIEW_COLUMNS);

  return { success: true, value: imageRow };
}

/**
 * Re-pack gallery positions to be contiguous from 0 WITHIN EACH (product, variant)
 * gallery, in the order the caller gives.
 *
 * TWO STATEMENTS, NOT A PER-ROW LOOP. Migration 0054 made
 * `(product_id, coalesce(variant_id, ''), position)` unique, and an expression index
 * cannot be DEFERRABLE — so writing final positions one row at a time transiently
 * collides with a row still sitting on that position. Parking every row far beyond
 * the range first makes the second pass collision-free.
 */
async function repackGalleryPositions(
  transaction: DatabaseTransaction,
  productId: string,
  orderedImages: readonly { readonly id: string; readonly variantId: string | null }[],
): Promise<void> {
  if (orderedImages.length === 0) {
    return;
  }
  const parkingOffset = orderedImages.length + 1000;
  await transaction
    .update(productImage)
    .set({ position: sql`${productImage.position} + ${parkingOffset}` })
    .where(eq(productImage.productId, productId));

  const nextPositionByGallery = new Map<string, number>();
  for (const image of orderedImages) {
    const galleryKey = image.variantId ?? "";
    const position = nextPositionByGallery.get(galleryKey) ?? 0;
    nextPositionByGallery.set(galleryKey, position + 1);
    await transaction.update(productImage).set({ position }).where(eq(productImage.id, image.id));
  }
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
      .select({ id: productImage.id, variantId: productImage.variantId })
      .from(productImage)
      .where(eq(productImage.productId, productId))
      .orderBy(asc(productImage.position), asc(productImage.id));

    await repackGalleryPositions(tx, productId, remaining);
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
    .select({ id: productImage.id, variantId: productImage.variantId })
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

  /**
   * A1: positions are contiguous per gallery, so the requested order is applied
   * WITHIN each variant's gallery rather than as one flat sequence. A seller
   * reordering the whole list still gets the relative order they asked for.
   */
  const variantIdByImageId = new Map(existing.map((row) => [row.id, row.variantId]));
  const orderedImages = imageIds.map((imageId) => ({
    id: imageId,
    variantId: variantIdByImageId.get(imageId) ?? null,
  }));

  await db.transaction(async (tx) => {
    await repackGalleryPositions(tx, productId, orderedImages);
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
          publicSlug: product.publicSlug,
          samplePolicy: product.samplePolicy,
          samplePriceInCents: product.samplePriceInCents,
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
      if (
        (row.samplePolicy === "paid" || row.samplePolicy === "refundable") &&
        (row.samplePriceInCents === null || row.samplePriceInCents <= 0)
      ) {
        missing.push("samplePriceInCents");
      }
      if (missing.length > 0) return { status: "incomplete", missing };

      const publicSlug = row.publicSlug ?? slugifyPublicTitle(row.title, row.id);
      await transaction
        .update(product)
        .set({ status: "active", publishedAt: new Date(), publicSlug })
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
  await enqueueProductSearchDocumentRefresh(productId);
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
  await enqueueProductSearchDocumentRefresh(productId);
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

  await db.transaction(async (transaction) => {
    await transaction
      .delete(product)
      .where(
        and(eq(product.id, productId), eq(product.sellerOrganizationId, sellerOrganizationId)),
      );
    await transaction
      .delete(storeSearchDocument)
      .where(
        and(
          eq(storeSearchDocument.documentKind, "product"),
          eq(storeSearchDocument.entityId, productId),
        ),
      );
  });

  return { success: true, value: { id: productId } };
}
