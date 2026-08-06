import { and, asc, desc, eq, gt, inArray, isNotNull, or, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceCategory,
  commerceOrganization,
  commerceProductHighlight,
  commerceProductSpecification,
  commerceProductVariant,
  product,
  productImage,
  productPricingTier,
} from "#src/db/schema.js";
import { decodeStoreCursor, encodeStoreCursor } from "#src/lib/store-cursor.js";
import {
  loadOrganizationFulfillmentMetrics,
  loadProductReviewMetrics,
} from "#src/services/commerce-trust-metrics.service.js";
import type { Result } from "#src/types/index.js";

export type StoreStockState = "in_stock" | "low_stock" | "made_to_order" | "unavailable";

export interface StoreCategoryProjection {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly parentCategoryId: string | null;
  readonly siblingOrder: number;
  readonly imageUrl: string | null;
}

export interface StoreSellerProjection {
  readonly organizationId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly countryCode: string;
  readonly logoUrl: string | null;
  readonly summary: string | null;
}

/** Server-derived review and fulfillment metrics (Phase 7 aggregates). */
export interface StoreReviewMetrics {
  readonly averageRating: number | null;
  readonly reviewCount: number;
}

export interface StoreFulfillmentMetrics {
  readonly onTimeShipmentRate: number | null;
  readonly completedOrderCount: number;
}

export interface StoreProductCardProjection {
  readonly id: string;
  readonly publicSlug: string;
  readonly title: string;
  readonly brand: string | null;
  readonly currency: string;
  readonly priceInCents: number;
  readonly compareAtPriceInCents: number | null;
  readonly minimumOrderQuantity: number | null;
  readonly stockState: StoreStockState;
  /**
   * A1. True means `priceInCents` is a "from" price and the buyer must choose a
   * variant before the line can be added to a cart — the client cannot infer that
   * from the price alone, and guessing wrong produces a 422 at add time.
   */
  readonly hasVariants: boolean;
  readonly variantCount: number;
  /** A4. Stored since Phase 0, simply never projected until now. */
  readonly condition: (typeof product.$inferSelect)["condition"];
  readonly samplePolicy: (typeof product.$inferSelect)["samplePolicy"];
  readonly leadTimeMinDays: number | null;
  readonly leadTimeMaxDays: number | null;
  readonly mainImageUrl: string | null;
  readonly seller: StoreSellerProjection;
  readonly category: { readonly id: string; readonly slug: string; readonly name: string };
  readonly reviewMetrics: StoreReviewMetrics;
  readonly fulfillmentMetrics: StoreFulfillmentMetrics;
}

/** A5. Integers in named units — never a formatted string a client cannot compare. */
export interface StorePackagingProjection {
  readonly packageLengthMm: number | null;
  readonly packageWidthMm: number | null;
  readonly packageHeightMm: number | null;
  readonly packageGrossWeightGrams: number | null;
  readonly unitsPerPackage: number | null;
}

/** A1. One buyable variation, with its own price, stock, MOQ and gallery. */
export interface StoreProductVariantProjection {
  readonly id: string;
  readonly publicSlug: string;
  readonly name: string;
  readonly priceInCents: number;
  readonly minimumOrderQuantity: number | null;
  readonly stockState: StoreStockState;
  readonly position: number;
  readonly images: readonly StoreProductMediaProjection[];
  readonly pricingTiers: readonly StoreProductPricingTierProjection[];
}

/** A2. `mediaKind` is what makes a 360 spin or a video expressible at all. */
export interface StoreProductMediaProjection {
  readonly id: string;
  readonly url: string;
  readonly mediaKind: (typeof productImage.$inferSelect)["mediaKind"];
  readonly altText: string | null;
  readonly widthPx: number | null;
  readonly heightPx: number | null;
  readonly position: number;
}

export interface StoreProductPricingTierProjection {
  readonly unitPriceInCents: number;
  readonly minimumOrderQuantity: number;
  readonly position: number;
}

/** A6. Richer than `keyFeatures`: a title, a body, and an image. */
export interface StoreProductHighlightProjection {
  readonly id: string;
  readonly title: string;
  readonly bodyText: string;
  readonly imageUrl: string | null;
  readonly position: number;
}

export interface StoreProductDetailProjection extends StoreProductCardProjection {
  readonly description: string | null;
  readonly keyFeatures: readonly string[];
  readonly modelNumber: string | null;
  readonly countryOfOriginCode: string | null;
  readonly unitOfMeasure: string | null;
  readonly samplePriceInCents: number | null;
  readonly packaging: StorePackagingProjection;
  /** Shared gallery. Variant-scoped media lives on the variant, not here. */
  readonly images: readonly StoreProductMediaProjection[];
  readonly pricingTiers: readonly StoreProductPricingTierProjection[];
  readonly variants: readonly StoreProductVariantProjection[];
  readonly highlights: readonly StoreProductHighlightProjection[];
  readonly specifications: readonly {
    readonly key: string;
    readonly value: string;
    /** A3. Null is ungrouped, which is every pre-Phase-8 row. */
    readonly group: string | null;
    readonly position: number;
  }[];
  readonly categoryTrail: readonly StoreCategoryProjection[];
}

export interface StoreCategoryFacetBucket {
  readonly value: string;
  readonly count: number;
}

export interface StoreCategoryFacets {
  readonly sellerCountryCodes: readonly StoreCategoryFacetBucket[];
  readonly stockStates: readonly StoreCategoryFacetBucket[];
  readonly samplePolicies: readonly StoreCategoryFacetBucket[];
  readonly priceRangesInCents: {
    readonly minInCents: number | null;
    readonly maxInCents: number | null;
    readonly count: number;
  };
}

export interface StoreOrganizationStorefront {
  readonly organizationId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly summary: string | null;
  readonly countryCode: string;
  readonly logoUrl: string | null;
  readonly websiteUrl: string | null;
  readonly products: {
    readonly items: readonly StoreProductCardProjection[];
    readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
  };
}

export type StoreCatalogError = { type: "NOT_FOUND" } | { type: "INVALID_CURSOR" };

const EMPTY_REVIEW_METRICS: StoreReviewMetrics = {
  averageRating: null,
  reviewCount: 0,
};

const EMPTY_FULFILLMENT_METRICS: StoreFulfillmentMetrics = {
  onTimeShipmentRate: null,
  completedOrderCount: 0,
};

const publicProductEligibility = and(
  eq(product.status, "active"),
  eq(product.moderationState, "approved"),
  isNotNull(product.publicSlug),
  eq(commerceOrganization.tradeState, "active"),
  eq(commerceOrganization.visibility, "public"),
  eq(commerceCategory.state, "active"),
);

/**
 * Derives buyer-safe stock state from authoritative inventory and lead-time policy.
 * Zero stock with a declared lead-time window is made-to-order, not unavailable.
 */
export function deriveStockState(input: {
  readonly stockQuantity: number;
  readonly leadTimeMinDays: number | null;
  readonly leadTimeMaxDays: number | null;
}): StoreStockState {
  if (input.stockQuantity <= 0) {
    if (input.leadTimeMinDays !== null && input.leadTimeMaxDays !== null) {
      return "made_to_order";
    }
    return "unavailable";
  }
  if (input.stockQuantity <= 5) {
    return "low_stock";
  }
  return "in_stock";
}

function toSellerProjection(row: {
  readonly organizationId: string;
  readonly organizationSlug: string;
  readonly organizationDisplayName: string;
  readonly organizationCountryCode: string;
  readonly organizationLogoUrl: string | null;
  readonly organizationSummary: string | null;
}): StoreSellerProjection {
  return {
    organizationId: row.organizationId,
    slug: row.organizationSlug,
    displayName: row.organizationDisplayName,
    countryCode: row.organizationCountryCode,
    logoUrl: row.organizationLogoUrl,
    summary: row.organizationSummary,
  };
}

async function loadMainImageUrls(productIds: readonly string[]): Promise<Map<string, string>> {
  if (productIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      productId: productImage.productId,
      url: productImage.url,
      position: productImage.position,
    })
    .from(productImage)
    .where(inArray(productImage.productId, [...productIds]))
    /**
     * A1 + A2: shared media wins the card. Every variant gallery has its own
     * position 0, so ordering by position alone would let an arbitrary variant's
     * first image become the product's card image.
     */
    .orderBy(
      sql`${productImage.variantId} IS NOT NULL`,
      asc(productImage.position),
      asc(productImage.id),
    );

  const map = new Map<string, string>();
  for (const row of rows) {
    if (!map.has(row.productId)) {
      map.set(row.productId, row.url);
    }
  }
  return map;
}

async function loadMinimumOrderQuantities(
  productIds: readonly string[],
): Promise<Map<string, number>> {
  if (productIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      productId: productPricingTier.productId,
      minimumOrderQuantity: sql<number>`min(${productPricingTier.minimumOrderQuantity})`.mapWith(
        Number,
      ),
    })
    .from(productPricingTier)
    .where(inArray(productPricingTier.productId, [...productIds]))
    .groupBy(productPricingTier.productId);

  return new Map(rows.map((row) => [row.productId, row.minimumOrderQuantity]));
}

/**
 * A1. Once a product has active variants, the product row's own price and stock
 * stop being what a buyer can act on: the card must show the cheapest variant
 * ("from" pricing) and the stock actually available across variants. Reading
 * `product.priceInCents` in that case would advertise a price nothing sells at.
 */
interface ProductVariantAggregate {
  readonly activeVariantCount: number;
  readonly lowestPriceInCents: number;
  readonly totalStockQuantity: number;
}

async function loadVariantAggregates(
  productIds: readonly string[],
): Promise<Map<string, ProductVariantAggregate>> {
  if (productIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      productId: commerceProductVariant.productId,
      activeVariantCount: sql<number>`count(*)`.mapWith(Number),
      lowestPriceInCents: sql<number>`min(${commerceProductVariant.priceInCents})`.mapWith(Number),
      totalStockQuantity: sql<number>`sum(${commerceProductVariant.stockQuantity})`.mapWith(Number),
    })
    .from(commerceProductVariant)
    .where(
      and(
        inArray(commerceProductVariant.productId, [...productIds]),
        eq(commerceProductVariant.state, "active"),
      ),
    )
    .groupBy(commerceProductVariant.productId);

  return new Map(
    rows.map((row) => [
      row.productId,
      {
        activeVariantCount: row.activeVariantCount,
        lowestPriceInCents: row.lowestPriceInCents,
        totalStockQuantity: row.totalStockQuantity,
      },
    ]),
  );
}

export async function listActiveCategories(input: {
  readonly parentCategoryId: string | null;
}): Promise<{ items: readonly StoreCategoryProjection[] }> {
  const rows = await db
    .select({
      id: commerceCategory.id,
      slug: commerceCategory.slug,
      name: commerceCategory.name,
      parentCategoryId: commerceCategory.parentCategoryId,
      siblingOrder: commerceCategory.siblingOrder,
      imageUrl: commerceCategory.imageUrl,
    })
    .from(commerceCategory)
    .where(
      and(
        eq(commerceCategory.state, "active"),
        input.parentCategoryId === null
          ? sql`${commerceCategory.parentCategoryId} IS NULL`
          : eq(commerceCategory.parentCategoryId, input.parentCategoryId),
      ),
    )
    .orderBy(asc(commerceCategory.siblingOrder), asc(commerceCategory.id));

  return { items: rows };
}

export async function getCategoryBySlug(categorySlug: string): Promise<
  Result<
    {
      readonly category: StoreCategoryProjection;
      readonly children: readonly StoreCategoryProjection[];
    },
    StoreCatalogError
  >
> {
  const [categoryRow] = await db
    .select({
      id: commerceCategory.id,
      slug: commerceCategory.slug,
      name: commerceCategory.name,
      parentCategoryId: commerceCategory.parentCategoryId,
      siblingOrder: commerceCategory.siblingOrder,
      imageUrl: commerceCategory.imageUrl,
    })
    .from(commerceCategory)
    .where(and(eq(commerceCategory.slug, categorySlug), eq(commerceCategory.state, "active")))
    .limit(1);

  if (!categoryRow) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }

  const childrenResult = await listActiveCategories({ parentCategoryId: categoryRow.id });
  return {
    success: true,
    value: {
      category: categoryRow,
      children: childrenResult.items,
    },
  };
}

export async function getCategoryFacets(categoryId: string): Promise<StoreCategoryFacets> {
  const subtreeIds = await listActiveCategorySubtreeIds(categoryId);
  if (subtreeIds.length === 0) {
    return {
      sellerCountryCodes: [],
      stockStates: [],
      samplePolicies: [],
      priceRangesInCents: { minInCents: null, maxInCents: null, count: 0 },
    };
  }

  const categoryPredicate = inArray(product.categoryId, [...subtreeIds]);
  const [countryRows, stockRows, sampleRows, priceRow] = await Promise.all([
    db
      .select({
        value: commerceOrganization.countryCode,
        count: sql<number>`count(*)::int`.mapWith(Number),
      })
      .from(product)
      .innerJoin(commerceOrganization, eq(commerceOrganization.id, product.sellerOrganizationId))
      .innerJoin(commerceCategory, eq(commerceCategory.id, product.categoryId))
      .where(and(publicProductEligibility, categoryPredicate))
      .groupBy(commerceOrganization.countryCode)
      .orderBy(desc(sql`count(*)`), asc(commerceOrganization.countryCode)),
    db.execute<{ value: string; count: number }>(sql`
      SELECT derived.stock_state AS value, count(*)::int AS count
      FROM (
        SELECT CASE
          WHEN p.stock_quantity <= 0
               AND p.lead_time_min_days IS NOT NULL
               AND p.lead_time_max_days IS NOT NULL
            THEN 'made_to_order'
          WHEN p.stock_quantity <= 0 THEN 'unavailable'
          WHEN p.stock_quantity <= 5 THEN 'low_stock'
          ELSE 'in_stock'
        END AS stock_state
        FROM product AS p
        INNER JOIN commerce_organization AS o ON o.id = p.seller_organization_id
        INNER JOIN commerce_category AS c ON c.id = p.category_id
        WHERE p.status = 'active'
          AND p.moderation_state = 'approved'
          AND p.public_slug IS NOT NULL
          AND o.trade_state = 'active'
          AND o.visibility = 'public'
          AND c.state = 'active'
          AND p.category_id IN (${sql.join(
            subtreeIds.map((id) => sql`${id}`),
            sql`, `,
          )})
      ) AS derived
      GROUP BY derived.stock_state
      ORDER BY count DESC, derived.stock_state ASC
    `),
    db
      .select({
        value: product.samplePolicy,
        count: sql<number>`count(*)::int`.mapWith(Number),
      })
      .from(product)
      .innerJoin(commerceOrganization, eq(commerceOrganization.id, product.sellerOrganizationId))
      .innerJoin(commerceCategory, eq(commerceCategory.id, product.categoryId))
      .where(and(publicProductEligibility, categoryPredicate))
      .groupBy(product.samplePolicy)
      .orderBy(desc(sql`count(*)`), asc(product.samplePolicy)),
    db
      .select({
        minInCents: sql<number | null>`min(${product.priceInCents})`.mapWith(Number),
        maxInCents: sql<number | null>`max(${product.priceInCents})`.mapWith(Number),
        count: sql<number>`count(*)::int`.mapWith(Number),
      })
      .from(product)
      .innerJoin(commerceOrganization, eq(commerceOrganization.id, product.sellerOrganizationId))
      .innerJoin(commerceCategory, eq(commerceCategory.id, product.categoryId))
      .where(and(publicProductEligibility, categoryPredicate)),
  ]);

  const priceSummary = priceRow[0];
  return {
    sellerCountryCodes: countryRows.map((row) => ({
      value: row.value,
      count: row.count,
    })),
    stockStates: stockRows.rows.map((row) => ({
      value: row.value,
      count: row.count,
    })),
    samplePolicies: sampleRows.map((row) => ({
      value: row.value,
      count: row.count,
    })),
    priceRangesInCents: {
      minInCents: priceSummary?.count ? (priceSummary.minInCents ?? null) : null,
      maxInCents: priceSummary?.count ? (priceSummary.maxInCents ?? null) : null,
      count: priceSummary?.count ?? 0,
    },
  };
}

async function buildCategoryTrail(categoryId: string): Promise<readonly StoreCategoryProjection[]> {
  const trail: StoreCategoryProjection[] = [];
  let currentId: string | null = categoryId;
  for (let depth = 0; depth < 16 && currentId !== null; depth += 1) {
    const [row]: Array<{
      id: string;
      slug: string;
      name: string;
      parentCategoryId: string | null;
      siblingOrder: number;
      imageUrl: string | null;
    }> = await db
      .select({
        id: commerceCategory.id,
        slug: commerceCategory.slug,
        name: commerceCategory.name,
        parentCategoryId: commerceCategory.parentCategoryId,
        siblingOrder: commerceCategory.siblingOrder,
        imageUrl: commerceCategory.imageUrl,
      })
      .from(commerceCategory)
      .where(eq(commerceCategory.id, currentId))
      .limit(1);
    if (!row) {
      break;
    }
    trail.unshift(row);
    currentId = row.parentCategoryId;
  }
  return trail;
}

/**
 * Active category id plus every active descendant. Used so parent browse pages and
 * facets include products assigned to leaf categories under the requested node.
 */
export async function listActiveCategorySubtreeIds(
  rootCategoryId: string,
): Promise<readonly string[]> {
  const result = await db.execute<{ id: string }>(sql`
    WITH RECURSIVE category_subtree AS (
      SELECT id
      FROM commerce_category
      WHERE id = ${rootCategoryId}
        AND state = 'active'
      UNION ALL
      SELECT child.id
      FROM commerce_category AS child
      INNER JOIN category_subtree AS parent ON parent.id = child.parent_category_id
      WHERE child.state = 'active'
    )
    SELECT id FROM category_subtree
  `);
  return result.rows.map((row) => row.id);
}

/**
 * Active category slug plus every active descendant slug. Search filters expand a
 * parent slug into its subtree so leaf-assigned products remain findable.
 */
export async function listActiveCategorySubtreeSlugs(
  rootCategorySlug: string,
): Promise<readonly string[]> {
  const result = await db.execute<{ slug: string }>(sql`
    WITH RECURSIVE category_subtree AS (
      SELECT id, slug
      FROM commerce_category
      WHERE slug = ${rootCategorySlug}
        AND state = 'active'
      UNION ALL
      SELECT child.id, child.slug
      FROM commerce_category AS child
      INNER JOIN category_subtree AS parent ON parent.id = child.parent_category_id
      WHERE child.state = 'active'
    )
    SELECT slug FROM category_subtree
  `);
  return result.rows.map((row) => row.slug);
}

function mapProductCard(
  row: {
    readonly id: string;
    readonly publicSlug: string | null;
    readonly title: string;
    readonly brand: string | null;
    readonly currency: string;
    readonly priceInCents: number;
    readonly compareAtPriceInCents: number | null;
    readonly stockQuantity: number;
    readonly condition: (typeof product.$inferSelect)["condition"];
    readonly samplePolicy: (typeof product.$inferSelect)["samplePolicy"];
    readonly leadTimeMinDays: number | null;
    readonly leadTimeMaxDays: number | null;
    readonly organizationId: string;
    readonly organizationSlug: string;
    readonly organizationDisplayName: string;
    readonly organizationCountryCode: string;
    readonly organizationLogoUrl: string | null;
    readonly organizationSummary: string | null;
    readonly categoryId: string;
    readonly categorySlug: string;
    readonly categoryName: string;
  },
  mainImageUrl: string | null,
  minimumOrderQuantity: number | null,
  reviewMetrics: StoreReviewMetrics = EMPTY_REVIEW_METRICS,
  fulfillmentMetrics: StoreFulfillmentMetrics = EMPTY_FULFILLMENT_METRICS,
  variantAggregate: ProductVariantAggregate | null = null,
): StoreProductCardProjection {
  if (row.publicSlug === null) {
    throw new Error("Eligible product missing publicSlug.");
  }
  return {
    id: row.id,
    publicSlug: row.publicSlug,
    title: row.title,
    brand: row.brand,
    currency: row.currency,
    priceInCents: variantAggregate?.lowestPriceInCents ?? row.priceInCents,
    compareAtPriceInCents: row.compareAtPriceInCents,
    minimumOrderQuantity,
    /**
     * A1: a card whose variants are all out of stock is unavailable even when the
     * product row still carries stock, and vice versa.
     */
    stockState: deriveStockState({
      stockQuantity: variantAggregate?.totalStockQuantity ?? row.stockQuantity,
      leadTimeMinDays: row.leadTimeMinDays,
      leadTimeMaxDays: row.leadTimeMaxDays,
    }),
    hasVariants: variantAggregate !== null,
    variantCount: variantAggregate?.activeVariantCount ?? 0,
    condition: row.condition,
    samplePolicy: row.samplePolicy,
    leadTimeMinDays: row.leadTimeMinDays,
    leadTimeMaxDays: row.leadTimeMaxDays,
    mainImageUrl,
    seller: toSellerProjection(row),
    category: {
      id: row.categoryId,
      slug: row.categorySlug,
      name: row.categoryName,
    },
    reviewMetrics,
    fulfillmentMetrics,
  };
}

const productSelectFields = {
  id: product.id,
  publicSlug: product.publicSlug,
  title: product.title,
  brand: product.brand,
  currency: product.currency,
  priceInCents: product.priceInCents,
  compareAtPriceInCents: product.compareAtPriceInCents,
  stockQuantity: product.stockQuantity,
  condition: product.condition,
  samplePolicy: product.samplePolicy,
  leadTimeMinDays: product.leadTimeMinDays,
  leadTimeMaxDays: product.leadTimeMaxDays,
  publishedAt: product.publishedAt,
  createdAt: product.createdAt,
  organizationId: commerceOrganization.id,
  organizationSlug: commerceOrganization.slug,
  organizationDisplayName: commerceOrganization.displayName,
  organizationCountryCode: commerceOrganization.countryCode,
  organizationLogoUrl: commerceOrganization.logoUrl,
  organizationSummary: commerceOrganization.summary,
  categoryId: commerceCategory.id,
  categorySlug: commerceCategory.slug,
  categoryName: commerceCategory.name,
};

export async function listEligibleProducts(input: {
  readonly categoryId?: string | undefined;
  readonly sellerOrganizationId?: string | undefined;
  readonly productIds?: readonly string[] | undefined;
  readonly limit: number;
  readonly cursor?: string | undefined;
}): Promise<
  Result<
    {
      readonly items: readonly StoreProductCardProjection[];
      readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
    },
    StoreCatalogError
  >
> {
  const decodedCursor = input.cursor === undefined ? null : decodeStoreCursor(input.cursor);
  if (input.cursor !== undefined && decodedCursor === null) {
    return { success: false, error: { type: "INVALID_CURSOR" } };
  }

  const categoryIds =
    input.categoryId === undefined
      ? undefined
      : await listActiveCategorySubtreeIds(input.categoryId);
  if (input.categoryId !== undefined && (categoryIds === undefined || categoryIds.length === 0)) {
    return {
      success: true,
      value: { items: [], page: { nextCursor: null, hasMore: false } },
    };
  }

  const cursorPredicate =
    decodedCursor === null
      ? undefined
      : or(
          sql`coalesce(${product.publishedAt}, ${product.createdAt}) < ${decodedCursor.sortKey}::timestamp`,
          and(
            sql`coalesce(${product.publishedAt}, ${product.createdAt}) = ${decodedCursor.sortKey}::timestamp`,
            gt(product.id, decodedCursor.id),
          ),
        );

  const rows = await db
    .select(productSelectFields)
    .from(product)
    .innerJoin(commerceOrganization, eq(commerceOrganization.id, product.sellerOrganizationId))
    .innerJoin(commerceCategory, eq(commerceCategory.id, product.categoryId))
    .where(
      and(
        publicProductEligibility,
        categoryIds === undefined ? undefined : inArray(product.categoryId, [...categoryIds]),
        input.sellerOrganizationId === undefined
          ? undefined
          : eq(product.sellerOrganizationId, input.sellerOrganizationId),
        input.productIds === undefined ? undefined : inArray(product.id, [...input.productIds]),
        cursorPredicate,
      ),
    )
    .orderBy(desc(sql`coalesce(${product.publishedAt}, ${product.createdAt})`), asc(product.id))
    .limit(input.limit + 1);

  const pageRows = rows.slice(0, input.limit);
  const productIds = pageRows.map((row) => row.id);
  const organizationIds = [...new Set(pageRows.map((row) => row.organizationId))];
  const [imageMap, moqMap, productReviewMetrics, organizationFulfillmentMetrics, variantAggregates] =
    await Promise.all([
      loadMainImageUrls(productIds),
      loadMinimumOrderQuantities(productIds),
      loadProductReviewMetrics(productIds),
      loadOrganizationFulfillmentMetrics(organizationIds),
      loadVariantAggregates(productIds),
    ]);
  const items = pageRows.map((row) =>
    mapProductCard(
      row,
      imageMap.get(row.id) ?? null,
      moqMap.get(row.id) ?? null,
      productReviewMetrics.get(row.id) ?? EMPTY_REVIEW_METRICS,
      organizationFulfillmentMetrics.get(row.organizationId) ?? EMPTY_FULFILLMENT_METRICS,
      variantAggregates.get(row.id) ?? null,
    ),
  );

  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor =
    rows.length > input.limit && lastRow
      ? encodeStoreCursor({
          sortKey: (lastRow.publishedAt ?? lastRow.createdAt).toISOString(),
          id: lastRow.id,
        })
      : null;

  return {
    success: true,
    value: {
      items,
      page: { nextCursor, hasMore: nextCursor !== null },
    },
  };
}

/** Resolve eligible product cards for an ordered id list, dropping ineligible ids. */
export async function resolveEligibleProductCardsByIds(
  productIds: readonly string[],
): Promise<readonly StoreProductCardProjection[]> {
  if (productIds.length === 0) {
    return [];
  }
  const result = await listEligibleProducts({
    productIds,
    limit: productIds.length,
  });
  if (!result.success) {
    return [];
  }
  const byId = new Map(result.value.items.map((item) => [item.id, item]));
  return productIds.flatMap((productId) => {
    const card = byId.get(productId);
    return card === undefined ? [] : [card];
  });
}

export async function getPublicProductBySlug(
  productSlug: string,
): Promise<Result<StoreProductDetailProjection, StoreCatalogError>> {
  const [row] = await db
    .select({
      ...productSelectFields,
      description: product.description,
      keyFeatures: product.keyFeatures,
      modelNumber: product.modelNumber,
      countryOfOriginCode: product.countryOfOriginCode,
      unitOfMeasure: product.unitOfMeasure,
      samplePriceInCents: product.samplePriceInCents,
      packageLengthMm: product.packageLengthMm,
      packageWidthMm: product.packageWidthMm,
      packageHeightMm: product.packageHeightMm,
      packageGrossWeightGrams: product.packageGrossWeightGrams,
      unitsPerPackage: product.unitsPerPackage,
    })
    .from(product)
    .innerJoin(commerceOrganization, eq(commerceOrganization.id, product.sellerOrganizationId))
    .innerJoin(commerceCategory, eq(commerceCategory.id, product.categoryId))
    .where(and(publicProductEligibility, eq(product.publicSlug, productSlug)))
    .limit(1);

  if (!row || row.publicSlug === null) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }

  const [
    allImages,
    allPricingTiers,
    specifications,
    highlights,
    variantRows,
    categoryTrail,
    moqMap,
    productReviewMetrics,
    organizationFulfillmentMetrics,
    variantAggregates,
  ] = await Promise.all([
    db
      .select({
        id: productImage.id,
        variantId: productImage.variantId,
        url: productImage.url,
        mediaKind: productImage.mediaKind,
        altText: productImage.altText,
        widthPx: productImage.widthPx,
        heightPx: productImage.heightPx,
        position: productImage.position,
      })
      .from(productImage)
      .where(eq(productImage.productId, row.id))
      .orderBy(asc(productImage.position), asc(productImage.id)),
    db
      .select({
        variantId: productPricingTier.variantId,
        unitPriceInCents: productPricingTier.unitPriceInCents,
        minimumOrderQuantity: productPricingTier.minimumOrderQuantity,
        position: productPricingTier.position,
      })
      .from(productPricingTier)
      .where(eq(productPricingTier.productId, row.id))
      .orderBy(asc(productPricingTier.position)),
    db
      .select({
        key: commerceProductSpecification.specificationKey,
        value: commerceProductSpecification.specificationValue,
        group: commerceProductSpecification.specificationGroup,
        position: commerceProductSpecification.position,
      })
      .from(commerceProductSpecification)
      .where(eq(commerceProductSpecification.productId, row.id))
      .orderBy(asc(commerceProductSpecification.position)),
    db
      .select({
        id: commerceProductHighlight.id,
        title: commerceProductHighlight.title,
        bodyText: commerceProductHighlight.bodyText,
        imageUrl: commerceProductHighlight.imageUrl,
        position: commerceProductHighlight.position,
      })
      .from(commerceProductHighlight)
      .where(eq(commerceProductHighlight.productId, row.id))
      .orderBy(asc(commerceProductHighlight.position)),
    db
      .select({
        id: commerceProductVariant.id,
        publicSlug: commerceProductVariant.publicSlug,
        name: commerceProductVariant.name,
        priceInCents: commerceProductVariant.priceInCents,
        stockQuantity: commerceProductVariant.stockQuantity,
        minimumOrderQuantity: commerceProductVariant.minimumOrderQuantity,
        position: commerceProductVariant.position,
      })
      .from(commerceProductVariant)
      .where(
        and(
          eq(commerceProductVariant.productId, row.id),
          // Retired variants stay in order snapshots but leave the storefront.
          eq(commerceProductVariant.state, "active"),
        ),
      )
      .orderBy(asc(commerceProductVariant.position)),
    buildCategoryTrail(row.categoryId),
    loadMinimumOrderQuantities([row.id]),
    loadProductReviewMetrics([row.id]),
    loadOrganizationFulfillmentMetrics([row.organizationId]),
    loadVariantAggregates([row.id]),
  ]);

  const toMediaProjection = (media: (typeof allImages)[number]): StoreProductMediaProjection => ({
    id: media.id,
    url: media.url,
    mediaKind: media.mediaKind,
    altText: media.altText,
    widthPx: media.widthPx,
    heightPx: media.heightPx,
    position: media.position,
  });

  const sharedImages = allImages
    .filter((media) => media.variantId === null)
    .map(toMediaProjection);
  const sharedPricingTiers = allPricingTiers
    .filter((tier) => tier.variantId === null)
    .map(({ unitPriceInCents, minimumOrderQuantity, position }) => ({
      unitPriceInCents,
      minimumOrderQuantity,
      position,
    }));

  const variants: StoreProductVariantProjection[] = variantRows.map((variantRow) => {
    const variantTiers = allPricingTiers
      .filter((tier) => tier.variantId === variantRow.id)
      .map(({ unitPriceInCents, minimumOrderQuantity, position }) => ({
        unitPriceInCents,
        minimumOrderQuantity,
        position,
      }));
    return {
      id: variantRow.id,
      publicSlug: variantRow.publicSlug,
      name: variantRow.name,
      priceInCents: variantRow.priceInCents,
      minimumOrderQuantity: variantRow.minimumOrderQuantity,
      stockState: deriveStockState({
        stockQuantity: variantRow.stockQuantity,
        leadTimeMinDays: row.leadTimeMinDays,
        leadTimeMaxDays: row.leadTimeMaxDays,
      }),
      position: variantRow.position,
      images: allImages
        .filter((media) => media.variantId === variantRow.id)
        .map(toMediaProjection),
      // A variant with no ladder of its own inherits the product's, matching how
      // `loadPurchasableProductForCheckout` prices it.
      pricingTiers: variantTiers.length > 0 ? variantTiers : sharedPricingTiers,
    };
  });

  const card = mapProductCard(
    row,
    sharedImages[0]?.url ?? variants[0]?.images[0]?.url ?? null,
    moqMap.get(row.id) ??
      (sharedPricingTiers.length > 0
        ? Math.min(...sharedPricingTiers.map((tier) => tier.minimumOrderQuantity))
        : null),
    productReviewMetrics.get(row.id) ?? EMPTY_REVIEW_METRICS,
    organizationFulfillmentMetrics.get(row.organizationId) ?? EMPTY_FULFILLMENT_METRICS,
    variantAggregates.get(row.id) ?? null,
  );
  return {
    success: true,
    value: {
      ...card,
      description: row.description,
      keyFeatures: row.keyFeatures,
      modelNumber: row.modelNumber,
      countryOfOriginCode: row.countryOfOriginCode,
      unitOfMeasure: row.unitOfMeasure,
      samplePriceInCents: row.samplePriceInCents,
      packaging: {
        packageLengthMm: row.packageLengthMm,
        packageWidthMm: row.packageWidthMm,
        packageHeightMm: row.packageHeightMm,
        packageGrossWeightGrams: row.packageGrossWeightGrams,
        unitsPerPackage: row.unitsPerPackage,
      },
      images: sharedImages,
      pricingTiers: sharedPricingTiers,
      variants,
      highlights,
      specifications,
      categoryTrail,
    },
  };
}

export async function getPublicOrganizationStorefront(input: {
  readonly organizationSlug: string;
  readonly limit: number;
  readonly cursor?: string | undefined;
}): Promise<Result<StoreOrganizationStorefront, StoreCatalogError>> {
  const [organizationRow] = await db
    .select({
      organizationId: commerceOrganization.id,
      slug: commerceOrganization.slug,
      displayName: commerceOrganization.displayName,
      summary: commerceOrganization.summary,
      countryCode: commerceOrganization.countryCode,
      logoUrl: commerceOrganization.logoUrl,
      websiteUrl: commerceOrganization.websiteUrl,
    })
    .from(commerceOrganization)
    .where(
      and(
        eq(commerceOrganization.slug, input.organizationSlug),
        eq(commerceOrganization.tradeState, "active"),
        eq(commerceOrganization.visibility, "public"),
      ),
    )
    .limit(1);

  if (!organizationRow) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }

  const productsResult = await listEligibleProducts({
    sellerOrganizationId: organizationRow.organizationId,
    limit: input.limit,
    cursor: input.cursor,
  });
  if (!productsResult.success) {
    return productsResult;
  }

  return {
    success: true,
    value: {
      ...organizationRow,
      products: productsResult.value,
    },
  };
}
