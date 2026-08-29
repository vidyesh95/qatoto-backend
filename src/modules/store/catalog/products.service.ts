import { randomUUID } from "node:crypto";

import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceCategory,
  commerceCategoryRequest,
  commerceProductCustomizationOption,
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
  deleteProductHighlightImage,
  deleteProductImage,
  uploadProductHighlightImage,
  uploadProductImage,
  type CloudinaryError,
} from "#src/lib/cloudinary.js";
import { validateAndNormalizeImage, type ImageValidationError } from "#src/lib/image.js";
import { isUniqueViolation as isUniqueConstraintViolation } from "#src/lib/pg-errors.js";
import type { ProductAttributeValueView } from "#src/modules/store/catalog/commerce-category-attributes.service.js";
import { ensureCommerceProductStatsRow } from "#src/modules/store/catalog/commerce-product-engagement.service.js";
import type {
  CreateProductInput,
  UpdateProductInput,
} from "#src/modules/store/catalog/products.schemas.js";
import { enqueueProductSearchDocumentRefresh } from "#src/modules/store/catalog/store-search.service.js";
import { slugifyPublicTitle } from "#src/modules/store/store-cursor.js";
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
  | { type: "CATEGORY_REQUEST_NOT_FOUND"; categoryRequestId: string }
  | {
      type: "CATEGORY_REQUEST_NOT_PENDING";
      categoryRequestId: string;
      state: "approved" | "rejected";
    }
  | { type: "TOO_MANY_IMAGES"; limit: number }
  | { type: "INCOMPLETE_FOR_PUBLISH"; missing: readonly string[] }
  /**
   * §19.9. A PUBLISHED listing is one a buyer can freight-rate, so an edit may not leave it
   * without the facts the rater needs. Distinct from `INCOMPLETE_FOR_PUBLISH` because that one
   * refuses a transition and this one refuses a mutation of something already live.
   */
  | { type: "ACTIVE_LISTING_MISSING_PACKAGE_DIMENSIONS"; missing: readonly string[] }
  | { type: "IMAGE_ORDER_MISMATCH" }
  | ImageValidationError
  | CloudinaryError;

type ProductUpdateOutcome =
  | { readonly status: "updated" }
  | { readonly status: "not_found" }
  | { readonly status: "category_error"; readonly error: ProductError }
  | {
      readonly status: "active_listing_unmeasured";
      readonly missing: readonly string[];
    };

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
  /** A2. What makes a 360 spin expressible at all. `video` was removed by `0090`. */
  readonly mediaKind: "photo" | "spin_360";
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
  /** A27. Null means this band declared none and the product's lead time applies. */
  readonly leadTimeDays: number | null;
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
 * A18/A23. One customization slot, as read back to its owning seller.
 *
 * Unlike the buyer's projection this carries `state`, because a retired slot is still the
 * seller's — it is referenced by every order line bought under it, and hiding it here would
 * make `PUT /products/:id/customization-options` look like it had deleted something.
 */
export interface ProductCustomizationOptionView {
  readonly id: string;
  readonly slotKey: string;
  readonly label: string;
  readonly customizationKind: "file_upload" | "choice";
  readonly acceptedMediaTypes: readonly string[];
  readonly choiceValues: readonly string[];
  readonly minimumOrderQuantity: number;
  readonly isRequired: boolean;
  readonly position: number;
  readonly state: "active" | "retired";
}

/**
 * What a listing still owes before it can be published (A5, §19.9).
 *
 * §15.6's SHAPE, REUSED RATHER THAN RE-INVENTED. Guided pathways already solved "the UI must
 * disable a CTA and say which piece is missing" with a per-item `state`, a named reason and a
 * filled/required pair; freight readiness is the same problem and gets the same answer.
 *
 * THE PUBLISH GATE AND THE SELLER'S READ CALL THIS ONE FUNCTION, which is the point: a checklist
 * that disagreed with the 422 behind it would be worse than no checklist.
 */
export type ListingRequirementKey = "title" | "price" | "images" | "samplePrice" | "shippingFacts";

export type ListingRequirementState = "satisfied" | "missing" | "not_applicable";

export interface ListingRequirementProjection {
  readonly key: ListingRequirementKey;
  readonly state: ListingRequirementState;
  /**
   * The exact field tokens the seller must fill. Empty unless `state` is `missing`.
   *
   * These are the SAME tokens `INCOMPLETE_FOR_PUBLISH.missing` has always carried, because other
   * clients already read that vocabulary and a rename would be a silent break.
   */
  readonly missingFields: readonly string[];
}

export interface ListingCompletenessProjection {
  readonly requirements: readonly ListingRequirementProjection[];
  readonly requirementCount: number;
  /** Requirements that apply to THIS listing — the denominator of `isComplete`. */
  readonly applicableRequirementCount: number;
  readonly satisfiedRequirementCount: number;
  readonly isComplete: boolean;
}

export interface ListingCompletenessFacts {
  readonly title: string;
  readonly priceInCents: number;
  readonly imageCount: number;
  readonly samplePolicy: "unavailable" | "paid" | "refundable";
  readonly samplePriceInCents: number | null;
  readonly packageLengthMm: number | null;
  readonly packageWidthMm: number | null;
  readonly packageHeightMm: number | null;
  readonly packageGrossWeightGrams: number | null;
  readonly unitsPerPackage: number | null;
}

/**
 * ALL FIVE SHIPPING FACTS, NOT JUST THE THREE DIMENSIONS.
 *
 * Freight rates on chargeable weight, and the rater needs every one of these: volume comes from
 * L x W x H MULTIPLIED BY the package count, and the package count comes from `unitsPerPackage`.
 * `computeConsignmentMeasurement` skips a line entirely when `unitsPerPackage` is null, and
 * `computePackagingTotals` skips it when either that or `packageGrossWeightGrams` is null. A gate
 * that demanded only the three dimensions would pass listings that still contribute ZERO volume
 * and ZERO weight — a gate that looks done and is not.
 *
 * UNCONDITIONAL, because every `product` row is physical goods: the browse taxonomy has had no
 * services or digital root since migration 0098 retired `digital_goods`. IF A SERVICES CATEGORY IS
 * EVER SEEDED, THIS IS THE REQUIREMENT THAT HAS TO BECOME CONDITIONAL.
 */
export interface ShippingFacts {
  readonly packageLengthMm: number | null;
  readonly packageWidthMm: number | null;
  readonly packageHeightMm: number | null;
  readonly packageGrossWeightGrams: number | null;
  readonly unitsPerPackage: number | null;
}

/** The five tokens, in the order a seller's form presents them. Empty when all are declared. */
export function missingShippingFacts(facts: ShippingFacts): readonly string[] {
  return [
    facts.packageLengthMm === null ? "packageLengthMm" : null,
    facts.packageWidthMm === null ? "packageWidthMm" : null,
    facts.packageHeightMm === null ? "packageHeightMm" : null,
    facts.packageGrossWeightGrams === null ? "packageGrossWeightGrams" : null,
    facts.unitsPerPackage === null ? "unitsPerPackage" : null,
  ].filter((fieldName): fieldName is string => fieldName !== null);
}

function projectShippingFactsRequirement(
  facts: ListingCompletenessFacts,
): ListingRequirementProjection {
  const missingFields = missingShippingFacts(facts);
  return missingFields.length === 0
    ? { key: "shippingFacts", state: "satisfied", missingFields: [] }
    : { key: "shippingFacts", state: "missing", missingFields };
}

export function projectListingCompleteness(
  facts: ListingCompletenessFacts,
): ListingCompletenessProjection {
  const hasTitle = facts.title.trim().length > 0;
  const hasPrice = facts.priceInCents > 0;
  const hasImage = facts.imageCount >= 1;
  const samplePolicyChargesForSamples =
    facts.samplePolicy === "paid" || facts.samplePolicy === "refundable";
  const hasSamplePrice = facts.samplePriceInCents !== null && facts.samplePriceInCents > 0;

  // Declared in the order the legacy `missing` array used, because that order is the wire
  // contract other clients already render.
  const requirements: readonly ListingRequirementProjection[] = [
    {
      key: "title",
      state: hasTitle ? "satisfied" : "missing",
      missingFields: hasTitle ? [] : ["title"],
    },
    {
      key: "price",
      state: hasPrice ? "satisfied" : "missing",
      missingFields: hasPrice ? [] : ["price"],
    },
    {
      key: "images",
      state: hasImage ? "satisfied" : "missing",
      missingFields: hasImage ? [] : ["images"],
    },
    samplePolicyChargesForSamples
      ? {
          key: "samplePrice",
          state: hasSamplePrice ? "satisfied" : "missing",
          missingFields: hasSamplePrice ? [] : ["samplePriceInCents"],
        }
      : { key: "samplePrice", state: "not_applicable", missingFields: [] },
    projectShippingFactsRequirement(facts),
  ];

  const applicable = requirements.filter((requirement) => requirement.state !== "not_applicable");
  const satisfied = applicable.filter((requirement) => requirement.state === "satisfied");

  return {
    requirements,
    requirementCount: requirements.length,
    applicableRequirementCount: applicable.length,
    satisfiedRequirementCount: satisfied.length,
    isComplete: satisfied.length === applicable.length,
  };
}

function missingFieldsForRequirement(requirement: ListingRequirementProjection): readonly string[] {
  switch (requirement.state) {
    case "missing":
      return requirement.missingFields;
    case "satisfied":
    case "not_applicable":
      return [];
    default: {
      const exhaustiveState: never = requirement.state;
      throw new Error(`Unhandled listing requirement state: ${JSON.stringify(exhaustiveState)}`);
    }
  }
}

/**
 * Which listing statuses owe the freight rater a measured box?
 *
 * A SWITCH RATHER THAN `status === "active"`, so a future `scheduled` or `archived` status breaks
 * the build here instead of silently letting an unrateable listing stay live (CLAUDE.md §3.2).
 */
function listingStatusRequiresShippingFacts(status: "draft" | "active"): boolean {
  switch (status) {
    case "active":
      return true;
    case "draft":
      return false;
    default: {
      const exhaustiveStatus: never = status;
      throw new Error(`Unhandled product status: ${JSON.stringify(exhaustiveStatus)}`);
    }
  }
}

/** The `INCOMPLETE_FOR_PUBLISH.missing` payload, derived from the same projection. */
export function collectMissingListingFields(
  completeness: ListingCompletenessProjection,
): readonly string[] {
  return completeness.requirements.flatMap(missingFieldsForRequirement);
}

/**
 * Full listing for the create/edit/detail flows. One canonical projection so the
 * shape can't drift between mutations (mirrors PublicUser / PUBLIC_USER_COLUMNS).
 */
export interface PublicProduct {
  readonly id: string;
  readonly title: string;
  readonly brand: string | null;
  /**
   * The legacy enum value, NULL for every listing created after 0098. Kept on the wire so
   * clients written against it still parse; `categoryId` is the authoritative field.
   */
  readonly category: string | null;
  readonly categoryId: string;
  /**
   * Set while this listing sits in `misc` awaiting a verdict on a requested category.
   * A client should say so plainly rather than presenting `misc` as a chosen category.
   */
  readonly pendingCategoryRequestId: string | null;
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
  /** A17. The seller's ceiling on one sample line. Never null — the column defaults to 1. */
  readonly maximumSampleQuantity: number;
  readonly leadTimeMinDays: number | null;
  readonly leadTimeMaxDays: number | null;
  readonly packageLengthMm: number | null;
  readonly packageWidthMm: number | null;
  readonly packageHeightMm: number | null;
  readonly packageGrossWeightGrams: number | null;
  readonly unitsPerPackage: number | null;
  readonly moderationState: "pending" | "approved" | "rejected" | "suspended";
  /**
   * §21.2. The seller's own statement about whether this is still sold. Distinct from
   * `status` (draft/active, an authoring state) and from the derived stock state.
   */
  readonly sellingState: "selling" | "paused" | "discontinued";
  /**
   * A5/§19.9. Why the Publish control is disabled, named field by field, so the seller learns it
   * from the form rather than from a 422 after they press the button.
   *
   * Computed from the row and its images with NO extra query, by the same function the publish
   * gate uses.
   *
   * THE CATEGORY ACTIVE-LEAF CHECK IS DELIBERATELY ABSENT. It needs a `commerce_category` read
   * that `createProduct` does not make, and it is a RACE rather than a blank field — the seller
   * picked from a list of active leaves. It stays a publish-time re-check; do not "fix" the
   * asymmetry by adding a query here.
   */
  readonly listingCompleteness: ListingCompletenessProjection;
  readonly images: readonly ProductImageView[];
  readonly pricingTiers: readonly PricingTierView[];
  readonly specifications: readonly ProductSpecificationView[];
  /** STORE §20. The structured answers, so the wizard can hydrate its typed controls. */
  readonly attributeValues: readonly ProductAttributeValueView[];
  readonly variants: readonly ProductVariantView[];
  readonly highlights: readonly ProductHighlightView[];
  readonly customizationOptions: readonly ProductCustomizationOptionView[];
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
  pendingCategoryRequestId: product.pendingCategoryRequestId,
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
  maximumSampleQuantity: product.maximumSampleQuantity,
  leadTimeMinDays: product.leadTimeMinDays,
  leadTimeMaxDays: product.leadTimeMaxDays,
  packageLengthMm: product.packageLengthMm,
  packageWidthMm: product.packageWidthMm,
  packageHeightMm: product.packageHeightMm,
  packageGrossWeightGrams: product.packageGrossWeightGrams,
  unitsPerPackage: product.unitsPerPackage,
  moderationState: product.moderationState,
  sellingState: product.sellingState,
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
  leadTimeDays: productPricingTier.leadTimeDays,
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

const PRODUCT_CUSTOMIZATION_OPTION_VIEW_COLUMNS = {
  id: commerceProductCustomizationOption.id,
  slotKey: commerceProductCustomizationOption.slotKey,
  label: commerceProductCustomizationOption.label,
  customizationKind: commerceProductCustomizationOption.customizationKind,
  acceptedMediaTypes: commerceProductCustomizationOption.acceptedMediaTypes,
  choiceValues: commerceProductCustomizationOption.choiceValues,
  minimumOrderQuantity: commerceProductCustomizationOption.minimumOrderQuantity,
  isRequired: commerceProductCustomizationOption.isRequired,
  position: commerceProductCustomizationOption.position,
  state: commerceProductCustomizationOption.state,
} as const;

type ProductScalarRow = {
  readonly [
    ColumnKey in keyof typeof PRODUCT_SCALAR_COLUMNS
  ]: (typeof product.$inferSelect)[ColumnKey];
};
type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * A Postgres unique-constraint violation (SQLSTATE 23505). The UNIQUE(sellerOrganizationId,
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
  attributeValues: readonly ProductAttributeValueView[] = [],
  variants: readonly ProductVariantView[] = [],
  highlights: readonly ProductHighlightView[] = [],
  customizationOptions: readonly ProductCustomizationOptionView[] = [],
): PublicProduct {
  // The defensive `categoryId === null` throw that stood here is gone: migration 0063
  // made the column NOT NULL, so the case it guarded can no longer be represented.
  return {
    id: row.id,
    title: row.title,
    brand: row.brand,
    category: row.category,
    categoryId: row.categoryId,
    pendingCategoryRequestId: row.pendingCategoryRequestId,
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
    maximumSampleQuantity: row.maximumSampleQuantity,
    leadTimeMinDays: row.leadTimeMinDays,
    leadTimeMaxDays: row.leadTimeMaxDays,
    packageLengthMm: row.packageLengthMm,
    packageWidthMm: row.packageWidthMm,
    packageHeightMm: row.packageHeightMm,
    packageGrossWeightGrams: row.packageGrossWeightGrams,
    unitsPerPackage: row.unitsPerPackage,
    moderationState: row.moderationState,
    sellingState: row.sellingState,
    listingCompleteness: projectListingCompleteness({
      title: row.title,
      priceInCents: row.priceInCents,
      imageCount: images.length,
      samplePolicy: row.samplePolicy,
      samplePriceInCents: row.samplePriceInCents,
      packageLengthMm: row.packageLengthMm,
      packageWidthMm: row.packageWidthMm,
      packageHeightMm: row.packageHeightMm,
      packageGrossWeightGrams: row.packageGrossWeightGrams,
      unitsPerPackage: row.unitsPerPackage,
    }),
    images,
    pricingTiers,
    specifications,
    attributeValues,
    variants,
    highlights,
    customizationOptions,
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
 * Load a full {@link PublicProduct} the caller owns, or null. Ownership is enforced IN the
 * query (`sellerOrganizationId = caller's organization`) — an empty result means either the
 * row is missing or belongs to someone else, and the caller cannot tell which.
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

  // Retired slots are included: the seller wrote them, and the order lines bought under
  // them still name them. The buyer's projection filters to active.
  const customizationOptions = await db
    .select(PRODUCT_CUSTOMIZATION_OPTION_VIEW_COLUMNS)
    .from(commerceProductCustomizationOption)
    .where(eq(commerceProductCustomizationOption.productId, productId))
    .orderBy(asc(commerceProductCustomizationOption.position));

  const variants: ProductVariantView[] = variantRows.map((variantRow) => ({
    ...variantRow,
    pricingTiers: pricingTiers.filter((tier) => tier.variantId === variantRow.id),
  }));

  // STORE §20. The structured answers, so an edit hydrates its typed controls.
  const { listProductAttributeValues } =
    await import("#src/modules/store/catalog/commerce-category-attributes.service.js");
  const attributeValues = await listProductAttributeValues(productId);

  return toPublicProduct(
    row,
    images,
    // The seller edits the product ladder here; variant ladders ride their variant.
    pricingTiers.filter((tier) => tier.variantId === null),
    specifications,
    attributeValues,
    variants,
    highlights,
    customizationOptions,
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
      readonly leadTimeDays?: number | undefined;
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
          leadTimeDays: tier.leadTimeDays ?? null,
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
/**
 * A6. Replace the highlight plan, PRESERVING THE IDENTITY of rows the caller kept.
 *
 * It used to delete every row and re-insert, which was harmless while a highlight was
 * three columns of text — and became wrong in `0091`, when a highlight gained a
 * platform-hosted image. A delete-and-reinsert throws away the id the image is attached
 * to, so editing a title would orphan the picture. Identity is matched the way
 * `replaceProductVariants` matches `publicSlug` and `replaceProductCustomizationOptions`
 * matches `slotKey`.
 *
 * A CLIENT-SUPPLIED ID IS A HINT, NEVER A GRANT. Only ids that already belong to THIS
 * product are honoured; anything else is treated as a new row and gets a server-generated
 * id, so naming another product's highlight cannot move or read it (CLAUDE.md §1.1).
 *
 * Position parking mirrors the variant path: `(productId, position)` is unique, so every
 * surviving row is moved out of range before final positions are written.
 *
 * Returns the Cloudinary public ids of dropped rows so the CALLER can destroy them after
 * the transaction commits — a remote delete inside a transaction that later rolls back
 * would leave a live row pointing at an asset that no longer exists.
 */
async function replaceProductHighlights(
  transaction: DatabaseTransaction,
  productId: string,
  highlights: readonly {
    readonly id?: string | undefined;
    readonly title: string;
    readonly bodyText: string;
  }[],
): Promise<readonly string[]> {
  const existingHighlights = await transaction
    .select({
      id: commerceProductHighlight.id,
      imageCloudinaryPublicId: commerceProductHighlight.imageCloudinaryPublicId,
    })
    .from(commerceProductHighlight)
    .where(eq(commerceProductHighlight.productId, productId));
  const existingIds = new Set(existingHighlights.map((highlight) => highlight.id));

  const positionParkingOffset = existingHighlights.length + highlights.length + 1000;
  await transaction
    .update(commerceProductHighlight)
    .set({ position: sql`${commerceProductHighlight.position} + ${positionParkingOffset}` })
    .where(eq(commerceProductHighlight.productId, productId));

  const keptHighlightIds = new Set<string>();
  for (const [index, highlight] of highlights.entries()) {
    const existingId =
      highlight.id !== undefined && existingIds.has(highlight.id) ? highlight.id : undefined;
    if (existingId === undefined) {
      const [inserted] = await transaction
        .insert(commerceProductHighlight)
        .values({
          productId,
          title: highlight.title,
          bodyText: highlight.bodyText,
          position: index,
        })
        .returning({ id: commerceProductHighlight.id });
      if (!inserted) throw new Error("Product highlight insert returned no row.");
      keptHighlightIds.add(inserted.id);
      continue;
    }

    // The image columns are deliberately untouched: they are owned by the upload route.
    await transaction
      .update(commerceProductHighlight)
      .set({ title: highlight.title, bodyText: highlight.bodyText, position: index })
      .where(eq(commerceProductHighlight.id, existingId));
    keptHighlightIds.add(existingId);
  }

  const droppedHighlights = existingHighlights.filter(
    (highlight) => !keptHighlightIds.has(highlight.id),
  );
  if (droppedHighlights.length > 0) {
    await transaction.delete(commerceProductHighlight).where(
      inArray(
        commerceProductHighlight.id,
        droppedHighlights.map((highlight) => highlight.id),
      ),
    );
  }

  return droppedHighlights
    .map((highlight) => highlight.imageCloudinaryPublicId)
    .filter((publicId): publicId is string => publicId !== null);
}

/**
 * A18. Replace the customization plan, RETIRING what disappears rather than deleting it.
 *
 * The variant precedent, not the highlight one: an order line references the option it
 * was bought under, so a seller withdrawing a slot must not erase what a buyer ordered.
 * Matching is by `slotKey`, the stable machine key — a renamed label is still the same
 * slot, which is exactly why the label is not the identity.
 *
 * Position parking mirrors `replaceProductVariants`: `(productId, position)` is unique,
 * so every surviving row is moved out of range before final positions are written.
 */
async function replaceProductCustomizationOptions(
  transaction: DatabaseTransaction,
  productId: string,
  options: readonly {
    readonly slotKey: string;
    readonly label: string;
    readonly customizationKind: "file_upload" | "choice";
    readonly acceptedMediaTypes?: readonly string[] | undefined;
    readonly choiceValues?: readonly string[] | undefined;
    readonly minimumOrderQuantity?: number | undefined;
    readonly isRequired?: boolean | undefined;
  }[],
): Promise<void> {
  const existing = await transaction
    .select({
      id: commerceProductCustomizationOption.id,
      slotKey: commerceProductCustomizationOption.slotKey,
    })
    .from(commerceProductCustomizationOption)
    .where(eq(commerceProductCustomizationOption.productId, productId));
  const existingBySlotKey = new Map(existing.map((row) => [row.slotKey, row.id]));

  const parkingOffset = existing.length + options.length + 1000;
  if (existing.length > 0) {
    await transaction
      .update(commerceProductCustomizationOption)
      .set({ position: sql`${commerceProductCustomizationOption.position} + ${parkingOffset}` })
      .where(eq(commerceProductCustomizationOption.productId, productId));
  }

  const incomingSlotKeys = new Set(options.map((option) => option.slotKey));
  for (const [slotKey, optionId] of existingBySlotKey) {
    if (incomingSlotKeys.has(slotKey)) continue;
    await transaction
      .update(commerceProductCustomizationOption)
      .set({ state: "retired" })
      .where(eq(commerceProductCustomizationOption.id, optionId));
  }

  for (const [index, option] of options.entries()) {
    const shared = {
      label: option.label,
      customizationKind: option.customizationKind,
      acceptedMediaTypes: [...(option.acceptedMediaTypes ?? [])],
      choiceValues: [...(option.choiceValues ?? [])],
      minimumOrderQuantity: option.minimumOrderQuantity ?? 1,
      isRequired: option.isRequired ?? false,
      position: index,
      state: "active" as const,
    };
    const existingId = existingBySlotKey.get(option.slotKey);
    if (existingId === undefined) {
      await transaction
        .insert(commerceProductCustomizationOption)
        .values({ productId, slotKey: option.slotKey, ...shared });
    } else {
      await transaction
        .update(commerceProductCustomizationOption)
        .set(shared)
        .where(eq(commerceProductCustomizationOption.id, existingId));
    }
  }
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

/**
 * Where a listing waits while the category it asked for is being reviewed.
 *
 * Seeded by migration 0098 with a fixed id, so this is a constant rather than a lookup.
 */
const MISC_CATEGORY_ID = "commerce_category_misc";

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

interface ResolvedProductCategory {
  readonly categoryId: string;
  /**
   * The legacy enum value, or NULL when the resolved root has none — which is every
   * root seeded after 0098. Null is written to the column, not substituted.
   */
  readonly category: LegacyProductCategory | null;
  /** Non-null only while the listing is parked in `misc` awaiting a verdict. */
  readonly pendingCategoryRequestId: string | null;
}

/**
 * Turn whatever category signal the caller sent into the pair of columns the row needs.
 *
 * THREE ACCEPTED INPUTS, in precedence order:
 *
 *   `categoryRequestId` — the seller asked for a category that does not exist yet. The
 *   listing parks in `misc` and carries the request id, so approving that request rehomes
 *   exactly this listing and no other. Checked for ownership: a caller cannot attach its
 *   product to a stranger's request and ride their approval.
 *
 *   `categoryId` — the normal path. Must name an ACTIVE LEAF.
 *
 *   `category` — the legacy enum. Its eight values name roots that 0098 RETIRED, so this
 *   now resolves to a retired row and answers `CATEGORY_NOT_ACTIVE_LEAF`. That is the
 *   honest reply: the category really is gone. Silently filing such a listing under
 *   `misc` would tell the client it succeeded at something it did not.
 */
async function resolveProductCategory(
  transaction: DatabaseTransaction,
  // `userId` is optional because the update and publish paths only ever resolve a
  // concrete `categoryId` and have no user in scope. The request branch below is
  // unreachable without one, and refuses rather than matching a null author.
  actor: { readonly userId?: string; readonly organizationId: string },
  input: {
    readonly category?: LegacyProductCategory;
    readonly categoryId?: string;
    readonly categoryRequestId?: string;
  },
): Promise<Result<ResolvedProductCategory, ProductError>> {
  if (input.categoryRequestId !== undefined) {
    const [categoryRequest] = await transaction
      .select({
        id: commerceCategoryRequest.id,
        state: commerceCategoryRequest.state,
        requestedByUserId: commerceCategoryRequest.requestedByUserId,
        requestedOrganizationId: commerceCategoryRequest.requestedOrganizationId,
      })
      .from(commerceCategoryRequest)
      .where(eq(commerceCategoryRequest.id, input.categoryRequestId))
      .for("share");

    // A request belonging to someone else is reported as NOT FOUND, not as a permission
    // failure: whether a given request id exists is not a stranger's business.
    const isOwnRequest =
      categoryRequest !== undefined &&
      ((actor.userId !== undefined && categoryRequest.requestedByUserId === actor.userId) ||
        (categoryRequest.requestedOrganizationId !== null &&
          categoryRequest.requestedOrganizationId === actor.organizationId));
    if (!isOwnRequest) {
      return {
        success: false,
        error: { type: "CATEGORY_REQUEST_NOT_FOUND", categoryRequestId: input.categoryRequestId },
      };
    }
    if (categoryRequest.state !== "pending") {
      return {
        success: false,
        error: {
          type: "CATEGORY_REQUEST_NOT_PENDING",
          categoryRequestId: input.categoryRequestId,
          state: categoryRequest.state,
        },
      };
    }

    return {
      success: true,
      value: {
        categoryId: MISC_CATEGORY_ID,
        category: null,
        pendingCategoryRequestId: categoryRequest.id,
      },
    };
  }

  const requestedCategoryId =
    input.categoryId ?? (input.category === undefined ? null : legacyCategoryId(input.category));
  if (requestedCategoryId === null) {
    throw new Error(
      "Create/update category resolution requires category, categoryId or categoryRequestId.",
    );
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

  // NULL IS NOW A LEGITIMATE ANSWER. Before 0098 every root mapped to a legacy enum
  // value, so a null here meant the tree was inconsistent and `CATEGORY_MISMATCH` was
  // right. Since 0098 the entire live root set is post-enum, so null just means "this
  // category predates nothing" — the mismatch check only has something to compare when
  // the caller actually sent a legacy value AND the root still has one.
  const resolvedLegacyCategory = legacyCategoryForRootId(rootCategoryId);
  if (
    input.category !== undefined &&
    resolvedLegacyCategory !== null &&
    input.category !== resolvedLegacyCategory
  ) {
    return {
      success: false,
      error: { type: "CATEGORY_MISMATCH", categoryId: requestedCategoryId },
    };
  }

  return {
    success: true,
    value: {
      categoryId: requestedCategoryId,
      category: resolvedLegacyCategory,
      pendingCategoryRequestId: null,
    },
  };
}

/**
 * Create a draft listing (identity + description + pricing + optional tiers).
 *
 * OWNERSHIP MUST COME FROM THE SERVER-DERIVED SESSION (CLAUDE.md §1.1), never the body.
 * `sellerOrganizationId` is the owner and `createdByUserId` the attribution; the legacy
 * `sellerId` column that used to carry both was dropped in migration 0088.
 */
export async function createProduct(
  commerceContext: { readonly userId: string; readonly organizationId: string },
  input: CreateProductInput,
): Promise<Result<PublicProduct, ProductError>> {
  try {
    return await db.transaction(
      async (tx) => {
        const categoryResult = await resolveProductCategory(tx, commerceContext, input);
        if (!categoryResult.success) return categoryResult;
        const [row] = await tx
          .insert(product)
          .values({
            sellerOrganizationId: commerceContext.organizationId,
            createdByUserId: commerceContext.userId,
            title: input.title,
            brand: input.brand ?? null,
            category: categoryResult.value.category,
            categoryId: categoryResult.value.categoryId,
            pendingCategoryRequestId: categoryResult.value.pendingCategoryRequestId,
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
            // Omitted means 1, not "no ceiling" — the whole point of the column's default.
            maximumSampleQuantity: input.maximumSampleQuantity ?? 1,
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
                    leadTimeDays: tier.leadTimeDays ?? null,
                    position: index,
                  })),
                )
                .returning(PRICING_TIER_VIEW_COLUMNS)
            : [];

        const specifications = await replaceProductSpecifications(tx, row.id, input.specifications);

        /**
         * A11. Mint the engagement counter row in the same transaction as the product.
         *
         * Without it, the first save on this listing would UPDATE zero rows and lose
         * the count silently — no error, no row, just a counter stuck at nothing. The
         * toggle path inserts defensively too, but a stats row that exists from birth
         * is the version the phase verifier can assert.
         */
        await ensureCommerceProductStatsRow(tx, row.id);

        return { success: true, value: toPublicProduct(row, [], pricingTiers, specifications, []) };
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
 * succeeds. The organization comes from the session, so a caller only ever lists its own.
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
  if (patch.sellingState !== undefined) scalarUpdates.sellingState = patch.sellingState;
  if (patch.samplePriceInCents !== undefined)
    scalarUpdates.samplePriceInCents = patch.samplePriceInCents;
  if (patch.maximumSampleQuantity !== undefined)
    scalarUpdates.maximumSampleQuantity = patch.maximumSampleQuantity;
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
          .select({
            id: product.id,
            status: product.status,
            packageLengthMm: product.packageLengthMm,
            packageWidthMm: product.packageWidthMm,
            packageHeightMm: product.packageHeightMm,
            packageGrossWeightGrams: product.packageGrossWeightGrams,
            unitsPerPackage: product.unitsPerPackage,
          })
          .from(product)
          .where(
            and(eq(product.id, productId), eq(product.sellerOrganizationId, sellerOrganizationId)),
          )
          .for("update");

        if (!owned) {
          return { status: "not_found" };
        }

        /**
         * §19.9. A live listing is never re-published, so the publish gate would never catch it
         * again — the check has to be here, BEFORE any write.
         *
         * CHECKED ON THE POST-PATCH VALUES, so the patch is allowed to be the fix: a PATCH that
         * SUPPLIES the missing facts passes. A seller fixing a typo on a legacy listing must send
         * the geometry in the same request, and `POST /products/:id/unpublish` stays ungated as
         * the escape hatch the 422 message names.
         */
        if (listingStatusRequiresShippingFacts(owned.status)) {
          // Only the SHIPPING half is re-checked. Title, price and images are publish-time
          // requirements an active listing already satisfied, and re-asserting them here would
          // refuse an edit for a reason the seller cannot see in this request.
          const missing = missingShippingFacts({
            packageLengthMm: patch.packageLengthMm ?? owned.packageLengthMm,
            packageWidthMm: patch.packageWidthMm ?? owned.packageWidthMm,
            packageHeightMm: patch.packageHeightMm ?? owned.packageHeightMm,
            packageGrossWeightGrams: patch.packageGrossWeightGrams ?? owned.packageGrossWeightGrams,
            unitsPerPackage: patch.unitsPerPackage ?? owned.unitsPerPackage,
          });
          if (missing.length > 0) {
            return { status: "active_listing_unmeasured", missing };
          }
        }

        if (patch.category !== undefined || patch.categoryId !== undefined) {
          const categoryResult = await resolveProductCategory(
            tx,
            { organizationId: sellerOrganizationId },
            patch,
          );
          if (!categoryResult.success) {
            return { status: "category_error", error: categoryResult.error };
          }
          scalarUpdates.category = categoryResult.value.category;
          scalarUpdates.categoryId = categoryResult.value.categoryId;
          // Picking a real category ends the wait, whatever the request goes on to
          // decide. Leaving the link would let a later approval yank the listing back
          // out of the category its owner deliberately chose.
          scalarUpdates.pendingCategoryRequestId = null;
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
                leadTimeDays: tier.leadTimeDays ?? null,
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
      case "active_listing_unmeasured":
        return {
          success: false,
          error: {
            type: "ACTIVE_LISTING_MISSING_PACKAGE_DIMENSIONS",
            missing: outcome.missing,
          },
        };
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
      readonly leadTimeDays?: number | undefined;
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
    readonly id?: string | undefined;
    readonly title: string;
    readonly bodyText: string;
  }[],
): Promise<Result<PublicProduct, ProductError>> {
  const owned = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: product.id })
      .from(product)
      .where(
        and(eq(product.id, productId), eq(product.sellerOrganizationId, sellerOrganizationId)),
      );
    if (!row) return { kept: false as const, droppedPublicIds: [] as readonly string[] };
    const droppedPublicIds = await replaceProductHighlights(tx, productId, highlights);
    return { kept: true as const, droppedPublicIds };
  });
  if (!owned.kept) {
    return { success: false, error: { type: "NOT_FOUND", productId } };
  }

  /**
   * AFTER commit, never inside it. A remote delete inside a transaction that later rolls
   * back would leave a surviving row pointing at an asset that no longer exists.
   * Best-effort: a failure here leaks an orphan rather than breaking the listing.
   */
  for (const publicId of owned.droppedPublicIds) {
    await deleteProductHighlightImage(publicId);
  }

  const reloaded = await loadOrganizationProduct(sellerOrganizationId, productId);
  if (!reloaded) {
    return { success: false, error: { type: "NOT_FOUND", productId } };
  }
  await enqueueProductSearchDocumentRefresh(productId);
  return { success: true, value: reloaded };
}

/**
 * Attach platform-hosted bytes to one highlight card (A6, migration `0091`).
 *
 * `imageUrl` used to be a client-supplied https string on the highlight plan, which meant
 * the PDP rendered bytes the seller held: EXIF unstripped, the seller's origin watching
 * every product-page visitor, and the picture changeable after the listing was approved.
 *
 * The highlight must already exist — the plan is authored first at
 * `PUT /products/:id/highlights`, and that call now preserves ids (see
 * `replaceProductHighlights`) precisely so an image survives an edit to its own title.
 */
export async function replaceHighlightImage(
  sellerOrganizationId: string,
  productId: string,
  highlightId: string,
  rawImageBytes: Buffer,
): Promise<Result<PublicProduct, ProductError>> {
  const [existing] = await db
    .select({
      id: commerceProductHighlight.id,
      previousPublicId: commerceProductHighlight.imageCloudinaryPublicId,
    })
    .from(commerceProductHighlight)
    .innerJoin(product, eq(product.id, commerceProductHighlight.productId))
    .where(
      and(
        eq(commerceProductHighlight.id, highlightId),
        eq(commerceProductHighlight.productId, productId),
        eq(product.sellerOrganizationId, sellerOrganizationId),
      ),
    )
    .limit(1);
  if (!existing) {
    return { success: false, error: { type: "NOT_FOUND", productId } };
  }

  /**
   * Re-encode BEFORE Cloudinary: proves the bytes are a raster image from their magic
   * bytes rather than the untrusted multipart header, and strips EXIF. Dimensions come
   * from the normalized buffer, never the client (A2).
   */
  const normalized = await validateAndNormalizeImage(rawImageBytes, {
    outputMaxDimensionPx: PRODUCT_IMAGE_OUTPUT_MAX_DIMENSION_PX,
    outputFormat: "avif",
  });
  if (!normalized.success) {
    return { success: false, error: normalized.error };
  }

  const uploaded = await uploadProductHighlightImage(
    productId,
    highlightId,
    normalized.value.buffer,
  );
  if (!uploaded.success) {
    return { success: false, error: uploaded.error };
  }

  const [updated] = await db
    .update(commerceProductHighlight)
    .set({
      imageUrl: uploaded.value.secureUrl,
      imageCloudinaryPublicId: uploaded.value.publicId,
      imageWidthPx: normalized.value.width,
      imageHeightPx: normalized.value.height,
    })
    .where(eq(commerceProductHighlight.id, highlightId))
    .returning({ id: commerceProductHighlight.id });
  if (!updated) {
    await deleteProductHighlightImage(uploaded.value.publicId);
    return { success: false, error: { type: "NOT_FOUND", productId } };
  }

  if (existing.previousPublicId !== null && existing.previousPublicId !== uploaded.value.publicId) {
    // Best-effort: the row already names the new asset, so a failure leaks an orphan
    // rather than breaking the listing.
    await deleteProductHighlightImage(existing.previousPublicId);
  }

  const reloaded = await loadOrganizationProduct(sellerOrganizationId, productId);
  if (!reloaded) {
    return { success: false, error: { type: "NOT_FOUND", productId } };
  }
  await enqueueProductSearchDocumentRefresh(productId);
  return { success: true, value: reloaded };
}

export async function replaceCustomizationOptions(
  sellerOrganizationId: string,
  productId: string,
  options: readonly {
    readonly slotKey: string;
    readonly label: string;
    readonly customizationKind: "file_upload" | "choice";
    readonly acceptedMediaTypes?: readonly string[] | undefined;
    readonly choiceValues?: readonly string[] | undefined;
    readonly minimumOrderQuantity?: number | undefined;
    readonly isRequired?: boolean | undefined;
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
    await replaceProductCustomizationOptions(tx, productId, options);
    return true;
  });
  if (!owned) {
    return { success: false, error: { type: "NOT_FOUND", productId } };
  }

  const reloaded = await loadOrganizationProduct(sellerOrganizationId, productId);
  if (!reloaded) {
    return { success: false, error: { type: "NOT_FOUND", productId } };
  }
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
    readonly mediaKind?: "photo" | "spin_360" | undefined;
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
 * Publish a draft. Re-checks completeness SERVER-SIDE; the client's "Publish" click is a request,
 * not an authorization. Sets status active + publishedAt.
 *
 * SINCE PHASE 20 THAT INCLUDES THE FIVE SHIPPING FACTS (§19.9). A published listing is one a buyer
 * can freight-rate, and a listing with no box is one the rater must refuse — so the requirement
 * belongs at the moment the listing becomes buyable rather than at the moment somebody tries to
 * ship it.
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
          packageLengthMm: product.packageLengthMm,
          packageWidthMm: product.packageWidthMm,
          packageHeightMm: product.packageHeightMm,
          packageGrossWeightGrams: product.packageGrossWeightGrams,
          unitsPerPackage: product.unitsPerPackage,
        })
        .from(product)
        .where(
          and(eq(product.id, productId), eq(product.sellerOrganizationId, sellerOrganizationId)),
        )
        .for("update");
      if (!row) return { status: "not_found" };
      // No `categoryId === null` branch since 0063 made the column NOT NULL. It carried
      // a `categoryId: ""` sentinel that existed only to satisfy the error shape.

      const categoryResult = await resolveProductCategory(
        transaction,
        { organizationId: sellerOrganizationId },
        { categoryId: row.categoryId },
      );
      if (!categoryResult.success) {
        return { status: "category_error", error: categoryResult.error };
      }

      const [imageCount] = await transaction
        .select({ value: count() })
        .from(productImage)
        .where(eq(productImage.productId, productId));
      /**
       * ONE PROJECTION, SHARED WITH THE SELLER'S READ. The checklist the seller sees on the form
       * and the refusal they get here are computed by the same function, so they cannot disagree.
       *
       * The row is `SELECT ... FOR UPDATE` inside a serializable transaction, so a concurrent
       * PATCH clearing the geometry cannot slip between this check and the write below.
       */
      const completeness = projectListingCompleteness({
        title: row.title,
        priceInCents: row.priceInCents,
        imageCount: imageCount?.value ?? 0,
        samplePolicy: row.samplePolicy,
        samplePriceInCents: row.samplePriceInCents,
        packageLengthMm: row.packageLengthMm,
        packageWidthMm: row.packageWidthMm,
        packageHeightMm: row.packageHeightMm,
        packageGrossWeightGrams: row.packageGrossWeightGrams,
        unitsPerPackage: row.unitsPerPackage,
      });
      if (!completeness.isComplete) {
        return { status: "incomplete", missing: collectMissingListingFields(completeness) };
      }

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
