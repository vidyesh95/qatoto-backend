import { and, asc, desc, eq, gt, inArray, isNotNull, or, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceCategory,
  commerceOrganization,
  commerceProductSpecification,
  product,
  productImage,
  productPricingTier,
} from "#src/db/schema.js";
import { decodeStoreCursor, encodeStoreCursor } from "#src/lib/store-cursor.js";
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

export interface StoreProductCardProjection {
  readonly id: string;
  readonly publicSlug: string;
  readonly title: string;
  readonly brand: string | null;
  readonly currency: string;
  readonly priceInCents: number;
  readonly compareAtPriceInCents: number | null;
  readonly stockState: StoreStockState;
  readonly samplePolicy: (typeof product.$inferSelect)["samplePolicy"];
  readonly leadTimeMinDays: number | null;
  readonly leadTimeMaxDays: number | null;
  readonly mainImageUrl: string | null;
  readonly seller: StoreSellerProjection;
  readonly category: { readonly id: string; readonly slug: string; readonly name: string };
}

export interface StoreProductDetailProjection extends StoreProductCardProjection {
  readonly description: string | null;
  readonly keyFeatures: readonly string[];
  readonly modelNumber: string | null;
  readonly countryOfOriginCode: string | null;
  readonly unitOfMeasure: string | null;
  readonly samplePriceInCents: number | null;
  readonly images: readonly { readonly id: string; readonly url: string; readonly position: number }[];
  readonly pricingTiers: readonly {
    readonly unitPriceInCents: number;
    readonly minimumOrderQuantity: number;
    readonly position: number;
  }[];
  readonly specifications: readonly {
    readonly key: string;
    readonly value: string;
    readonly position: number;
  }[];
  readonly categoryTrail: readonly StoreCategoryProjection[];
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

export type StoreCatalogError =
  | { type: "NOT_FOUND" }
  | { type: "INVALID_CURSOR" };

const publicProductEligibility = and(
  eq(product.status, "active"),
  eq(product.moderationState, "approved"),
  isNotNull(product.publicSlug),
  eq(commerceOrganization.tradeState, "active"),
  eq(commerceOrganization.visibility, "public"),
  eq(commerceCategory.state, "active"),
);

export function deriveStockState(stockQuantity: number): StoreStockState {
  if (stockQuantity <= 0) {
    return "unavailable";
  }
  if (stockQuantity <= 5) {
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

async function loadMainImageUrls(
  productIds: readonly string[],
): Promise<Map<string, string>> {
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
    .orderBy(asc(productImage.position));

  const map = new Map<string, string>();
  for (const row of rows) {
    if (!map.has(row.productId)) {
      map.set(row.productId, row.url);
    }
  }
  return map;
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

async function buildCategoryTrail(
  categoryId: string,
): Promise<readonly StoreCategoryProjection[]> {
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
    priceInCents: row.priceInCents,
    compareAtPriceInCents: row.compareAtPriceInCents,
    stockState: deriveStockState(row.stockQuantity),
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
  const decodedCursor =
    input.cursor === undefined ? null : decodeStoreCursor(input.cursor);
  if (input.cursor !== undefined && decodedCursor === null) {
    return { success: false, error: { type: "INVALID_CURSOR" } };
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
    .innerJoin(
      commerceOrganization,
      eq(commerceOrganization.id, product.sellerOrganizationId),
    )
    .innerJoin(commerceCategory, eq(commerceCategory.id, product.categoryId))
    .where(
      and(
        publicProductEligibility,
        input.categoryId === undefined
          ? undefined
          : eq(product.categoryId, input.categoryId),
        input.sellerOrganizationId === undefined
          ? undefined
          : eq(product.sellerOrganizationId, input.sellerOrganizationId),
        cursorPredicate,
      ),
    )
    .orderBy(desc(sql`coalesce(${product.publishedAt}, ${product.createdAt})`), asc(product.id))
    .limit(input.limit + 1);

  const pageRows = rows.slice(0, input.limit);
  const imageMap = await loadMainImageUrls(pageRows.map((row) => row.id));
  const items = pageRows.map((row) =>
    mapProductCard(row, imageMap.get(row.id) ?? null),
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
    })
    .from(product)
    .innerJoin(
      commerceOrganization,
      eq(commerceOrganization.id, product.sellerOrganizationId),
    )
    .innerJoin(commerceCategory, eq(commerceCategory.id, product.categoryId))
    .where(and(publicProductEligibility, eq(product.publicSlug, productSlug)))
    .limit(1);

  if (!row || row.publicSlug === null) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }

  const [images, pricingTiers, specifications, categoryTrail] = await Promise.all([
    db
      .select({
        id: productImage.id,
        url: productImage.url,
        position: productImage.position,
      })
      .from(productImage)
      .where(eq(productImage.productId, row.id))
      .orderBy(asc(productImage.position)),
    db
      .select({
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
        position: commerceProductSpecification.position,
      })
      .from(commerceProductSpecification)
      .where(eq(commerceProductSpecification.productId, row.id))
      .orderBy(asc(commerceProductSpecification.position)),
    buildCategoryTrail(row.categoryId),
  ]);

  const card = mapProductCard(row, images[0]?.url ?? null);
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
      images,
      pricingTiers,
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
