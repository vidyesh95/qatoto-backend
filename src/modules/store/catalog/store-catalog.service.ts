import { and, asc, desc, eq, gt, inArray, isNotNull, or, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceCategory,
  commerceOrganization,
  commerceProductCustomizationOption,
  commerceProductHighlight,
  commerceProductSpecification,
  commerceProductVariant,
  product,
  productImage,
  productPricingTier,
} from "#src/db/schema.js";
import {
  EMPTY_PRODUCT_ENGAGEMENT,
  loadProductEngagements,
  type ProductEngagementProjection,
} from "#src/modules/store/catalog/commerce-product-engagement.service.js";
import {
  tradingOrganizationCountryCode,
  withTradingOrganizationCountryCode,
} from "#src/modules/store/commerce-organization-country.js";
import type { CommerceOrganizationMemberRole } from "#src/modules/store/organizations/commerce-organization-access.service.js";
import {
  loadSellerDeclaredProfiles,
  type SellerDeclaredProfileProjection,
} from "#src/modules/store/organizations/commerce-seller-profile.service.js";
import { decodeStoreCursor, encodeStoreCursor } from "#src/modules/store/store-cursor.js";
import {
  deriveContactAffordance,
  type ProductContactAffordance,
} from "#src/modules/store/trust/commerce-product-inquiry.service.js";
import {
  EMPTY_FULFILLMENT_METRICS as EMPTY_CARD_FULFILLMENT_METRICS,
  EMPTY_MEASURED_METRICS,
  loadOrganizationFulfillmentMetrics,
  loadOrganizationMeasuredMetrics,
  loadProductReviewMetrics,
  type OrganizationFulfillmentMetrics,
  type OrganizationMeasuredMetrics,
} from "#src/modules/store/trust/commerce-trust-metrics.service.js";
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

/**
 * A13. Aliases of the trust-metrics shapes rather than re-declared copies. This interface
 * used to be a hand-written duplicate, which is how `onTimeShipmentRate` could stay
 * hardcoded `null` in one file while the other claimed to measure it.
 */
export type StoreFulfillmentMetrics = OrganizationFulfillmentMetrics;
export type StoreMeasuredMetrics = OrganizationMeasuredMetrics;

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
  /**
   * A27. This band's own maximum lead time, or `null` when it declared none and the
   * product's `leadTimeMaxDays` applies. It is the same band the buyer's quantity will
   * be priced from at preparation, so the delivery panel and the promise agree.
   */
  readonly leadTimeDays: number | null;
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

/**
 * A18/A23. A commercial term the buyer is held to, so the buyer must be able to read it.
 *
 * `checkout/prepare` refuses an order that omits a required slot
 * (`REQUIRED_OPTION_MISSING`), and until this projection existed the buyer was never told
 * the slot was there — enforcement without disclosure, which is a trap rather than a term.
 *
 * `state` is deliberately absent from the wire: the read carries active options only, and a
 * retired option is not a thing a buyer can choose. It keeps being referenced by the order
 * lines bought under it.
 */
export interface StoreProductCustomizationOptionProjection {
  readonly id: string;
  readonly slotKey: string;
  readonly label: string;
  readonly customizationKind: (typeof commerceProductCustomizationOption.$inferSelect)["customizationKind"];
  readonly acceptedMediaTypes: readonly string[];
  readonly choiceValues: readonly string[];
  readonly minimumOrderQuantity: number;
  readonly isRequired: boolean;
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
  readonly customizationOptions: readonly StoreProductCustomizationOptionProjection[];
  readonly specifications: readonly {
    readonly key: string;
    readonly value: string;
    /** A3. Null is ungrouped, which is every pre-Phase-8 row. */
    readonly group: string | null;
    readonly position: number;
  }[];
  readonly categoryTrail: readonly StoreCategoryProjection[];
  /**
   * A11. Integer counts plus per-viewer state.
   *
   * `commentCount` is deliberately NOT here. The mock engagement bar renders one, but
   * A10 (product comments) is out of scope and has no table, and projecting a zero
   * would be exactly the A13 failure — a field the frontend renders that can never be
   * non-null, which looks wired. `questionCount` is the real number next to it.
   */
  readonly engagement: ProductEngagementProjection;
  /**
   * A14. Which contact control the client should render, decided by the SERVER.
   *
   * `chat` requires an active buyer organization, because §4.11 derives thread
   * participants from organization memberships. `ask_question` is the honest middle
   * rung for a signed-in visitor without one — A9's public channel accepts them, which
   * is why it shipped first. `sign_in` is the anonymous case.
   *
   * This is a fact about the CALLER, which the caller already knows, so stating it
   * leaks nothing. The alternative is a frontend inferring eligibility from an
   * incomplete picture and putting a button in front of a wall.
   */
  readonly contactAffordance: ProductContactAffordance;
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
  /**
   * A13. WHAT THE SELLER SAYS ABOUT ITSELF — founding year, factory count, business type,
   * factory photos, freight access, officers, capabilities, approved certifications.
   *
   * `null` when this organization has never described itself, NOT an empty object. "We have
   * no profile for this seller" and "this seller filled in the form and left it blank" are
   * different facts, and only one of them is worth rendering as an empty state. Same call
   * A11 made with `engagement.viewer`.
   */
  readonly declaredProfile: SellerDeclaredProfileProjection | null;
  /**
   * A13. WHAT THE PLATFORM MEASURED — on-time rate, completed orders, reorder rate, median
   * response time, each with its sample size.
   *
   * A SEPARATE OBJECT FROM `declaredProfile`, and that separation is the point of the whole
   * appendix entry. The mock rendered one flat `stats: {label, value}[]` array mixing
   * "98.6% on-time" with "founded 2009", which teaches a client to present a seller's
   * assertion as a platform measurement. Two objects make that mistake unavailable rather
   * than merely discouraged.
   *
   * Never `null`: an organization with no orders has measured metrics, and they are zeros
   * and nulls with honest sample sizes.
   */
  readonly measuredMetrics: StoreMeasuredMetrics;
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

/**
 * A13. Re-exported from the metrics module rather than re-declared. The local copy that used
 * to sit here is the reason `onTimeShipmentRate` could be documented as measured in one file
 * and hardcoded `null` in another: two literals, one of which nobody updated.
 */
const EMPTY_FULFILLMENT_METRICS: StoreFulfillmentMetrics = EMPTY_CARD_FULFILLMENT_METRICS;

const publicProductEligibility = and(
  eq(product.status, "active"),
  eq(product.moderationState, "approved"),
  isNotNull(product.publicSlug),
  eq(commerceOrganization.tradeState, "active"),
  eq(commerceOrganization.visibility, "public"),
  eq(commerceCategory.state, "active"),
);

/**
 * Resolves a public slug to a product id, or nothing when the listing is not publicly
 * eligible (Appendix A8, A9, A11).
 *
 * Exists so the reviews, Q&A and engagement reads share ONE eligibility rule with the
 * catalog instead of restating `publicProductEligibility` in four services — the way a
 * draft listing's reviews start leaking is one of those copies drifting. Returns only
 * the ids those callers need; use `getPublicProductBySlug` when you want a projection.
 */
export async function resolveEligibleProductRefBySlug(
  productSlug: string,
): Promise<{ readonly id: string; readonly sellerOrganizationId: string } | null> {
  const [row] = await db
    .select({
      id: product.id,
      sellerOrganizationId: product.sellerOrganizationId,
    })
    .from(product)
    .innerJoin(commerceOrganization, eq(commerceOrganization.id, product.sellerOrganizationId))
    .innerJoin(commerceCategory, eq(commerceCategory.id, product.categoryId))
    .where(and(publicProductEligibility, eq(product.publicSlug, productSlug)))
    .limit(1);
  return row ?? null;
}

/**
 * The by-id counterpart of {@link resolveEligibleProductRefBySlug}, for authenticated
 * writes that already hold an id (Appendix A9's ask route, A14's inquiry route).
 *
 * Both run the SAME `publicProductEligibility` predicate. Without this, an authoring
 * route would confirm that a draft or suspended product id exists — a quieter version
 * of the enumeration §11 forbids.
 */
export async function resolveEligibleProductRefById(
  productId: string,
): Promise<{ readonly id: string; readonly sellerOrganizationId: string } | null> {
  const [row] = await db
    .select({
      id: product.id,
      sellerOrganizationId: product.sellerOrganizationId,
    })
    .from(product)
    .innerJoin(commerceOrganization, eq(commerceOrganization.id, product.sellerOrganizationId))
    .innerJoin(commerceCategory, eq(commerceCategory.id, product.categoryId))
    .where(and(publicProductEligibility, eq(product.id, productId)))
    .limit(1);
  return row ?? null;
}

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
  /**
   * How many to return, in `siblingOrder`. The store home rail asks for eight; the
   * category index asks for all of them. Bounding it SERVER-SIDE is what keeps the rail
   * from fetching the whole taxonomy and slicing it in the browser, which would make the
   * admin's arrangement a suggestion rather than the order.
   */
  readonly limit?: number;
}): Promise<{ items: readonly StoreCategoryProjection[] }> {
  const query = db
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

  const rows = input.limit === undefined ? await query : await query.limit(input.limit);

  return { items: rows };
}

/**
 * A25. The active ancestor chain of a category, root first, excluding the category
 * itself.
 *
 * An upward recursive CTE, sibling to `listActiveCategorySubtreeIds`. Without it a
 * breadcrumb over a nested category costs one request per level — the client walking
 * `parentCategoryId` by hand, which is a server join re-implemented in untrusted code.
 *
 * The walk STOPS at the first inactive ancestor rather than skipping it. A trail with a
 * hole in it would render as a path a buyer could click through, and the retired link in
 * the middle of it goes nowhere.
 */
async function listCategoryAncestors(
  categoryId: string,
): Promise<readonly StoreCategoryProjection[]> {
  const result = await db.execute<{
    id: string;
    slug: string;
    name: string;
    parent_category_id: string | null;
    sibling_order: number;
    image_url: string | null;
  }>(sql`
    WITH RECURSIVE category_ancestors AS (
      SELECT id, slug, name, parent_category_id, sibling_order, image_url, 0 AS depth
      FROM commerce_category
      WHERE id = (SELECT parent_category_id FROM commerce_category WHERE id = ${categoryId})
        AND state = 'active'
      UNION ALL
      SELECT parent.id, parent.slug, parent.name, parent.parent_category_id,
             parent.sibling_order, parent.image_url, child.depth + 1
      FROM commerce_category AS parent
      INNER JOIN category_ancestors AS child ON child.parent_category_id = parent.id
      WHERE parent.state = 'active'
    )
    SELECT id, slug, name, parent_category_id, sibling_order, image_url
    FROM category_ancestors
    ORDER BY depth DESC
  `);

  return result.rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    parentCategoryId: row.parent_category_id,
    // `sibling_order` is int4, which the driver hands back as a number. It would need a
    // `Number()` if it were int8 — those arrive as strings.
    siblingOrder: row.sibling_order,
    imageUrl: row.image_url,
  }));
}

export async function getCategoryBySlug(categorySlug: string): Promise<
  Result<
    {
      readonly category: StoreCategoryProjection;
      readonly children: readonly StoreCategoryProjection[];
      /** A25. Root first, excluding this category. Empty for a root. */
      readonly ancestors: readonly StoreCategoryProjection[];
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

  const [childrenResult, ancestors] = await Promise.all([
    listActiveCategories({ parentCategoryId: categoryRow.id }),
    listCategoryAncestors(categoryRow.id),
  ]);
  return {
    success: true,
    value: {
      category: categoryRow,
      children: childrenResult.items,
      ancestors,
    },
  };
}

/**
 * The counts beside a category's filters (A25, A39).
 *
 * A THIN CALLER SINCE PHASE 22, and the body it replaced is the point. This used to aggregate
 * over `product` with `publicProductEligibility` — a THIRD copy of the eligibility rule, hand
 * written in raw SQL — and a fourth copy of `deriveStockState` as a CASE ladder over
 * `p.stock_quantity`. That ladder was not variant-aware, while `mapProductCard` and the search
 * document both are, so this function could report "In stock (12)" above twelve cards reading
 * *Unavailable*. Same request, same products, two answers.
 *
 * `computeStoreSearchFacets` reads `store_search_document` — the table every filter already
 * reads — so the counts and the results now come from one place by construction.
 *
 * TAKES A SLUG, not an id, because the search document is scoped by `category_slug`. Passing
 * the id would have meant a second subtree walk keyed differently from the filter's, which is
 * the shape of the bug this change removes.
 */
export async function getCategoryFacets(categorySlug: string): Promise<StoreCategoryFacets> {
  /**
   * DYNAMIC, because `store-search.service` imports `deriveStockState` from this module and a
   * static import back would close the cycle. The same shape `transitionTradeState` and
   * `updateOrganization` already use to reach the search service.
   */
  const { computeStoreSearchFacets } =
    await import("#src/modules/store/catalog/store-search.service.js");

  const facets = await computeStoreSearchFacets({
    categorySlug,
    // A category page lists PRODUCTS. Without this the counts would also describe the provider
    // offerings and organizations that share the taxonomy, which the page never shows.
    documentKind: "product",
  });

  /**
   * The category read keeps its four-facet wire shape. The five new dimensions
   * `computeStoreSearchFacets` returns are served on `/store/search`, which is the read whose
   * filters can act on them — publishing a count the caller cannot use is what A25 forbade.
   */
  return {
    sellerCountryCodes: facets.sellerCountryCodes,
    stockStates: facets.stockStates,
    samplePolicies: facets.samplePolicies,
    priceRangesInCents: facets.priceRangesInCents,
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
  const [
    imageMap,
    moqMap,
    productReviewMetrics,
    organizationFulfillmentMetrics,
    variantAggregates,
  ] = await Promise.all([
    loadMainImageUrls(productIds),
    loadMinimumOrderQuantities(productIds),
    loadProductReviewMetrics(productIds),
    loadOrganizationFulfillmentMetrics(organizationIds),
    loadVariantAggregates(productIds),
  ]);
  const items = pageRows.map((row) =>
    mapProductCard(
      {
        ...row,
        organizationCountryCode: tradingOrganizationCountryCode(
          row.organizationCountryCode,
          row.organizationId,
        ),
      },
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

/**
 * A19. Resolve active categories for an ordered id list.
 *
 * `store_merchandising_entity_kind` has admitted `category` since Phase 1, but the
 * projection had no case for it, so a merchandiser could place a category in a rail
 * and watch it vanish with no error. Placing something and seeing nothing is worse
 * than being told the kind is unsupported.
 */
export async function resolveEligibleCategoriesByIds(
  categoryIds: readonly string[],
): Promise<readonly StoreCategoryProjection[]> {
  if (categoryIds.length === 0) {
    return [];
  }
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
      and(inArray(commerceCategory.id, [...categoryIds]), eq(commerceCategory.state, "active")),
    );

  const byId = new Map(rows.map((row) => [row.id, row]));
  return categoryIds.flatMap((categoryId) => {
    const row = byId.get(categoryId);
    return row === undefined ? [] : [row];
  });
}

/** A19. The organization counterpart, using the same public-visibility rules. */
export async function resolveEligibleOrganizationCardsByIds(
  organizationIds: readonly string[],
): Promise<readonly StoreSellerProjection[]> {
  if (organizationIds.length === 0) {
    return [];
  }
  const rows = await db
    .select({
      organizationId: commerceOrganization.id,
      organizationSlug: commerceOrganization.slug,
      organizationDisplayName: commerceOrganization.displayName,
      organizationCountryCode: commerceOrganization.countryCode,
      organizationLogoUrl: commerceOrganization.logoUrl,
      organizationSummary: commerceOrganization.summary,
    })
    .from(commerceOrganization)
    .where(
      and(
        inArray(commerceOrganization.id, [...organizationIds]),
        eq(commerceOrganization.tradeState, "active"),
        eq(commerceOrganization.visibility, "public"),
      ),
    );

  const byId = new Map(
    rows.map((row) => [
      row.organizationId,
      toSellerProjection({
        ...row,
        organizationCountryCode: tradingOrganizationCountryCode(
          row.organizationCountryCode,
          row.organizationId,
        ),
      }),
    ]),
  );
  return organizationIds.flatMap((organizationId) => {
    const card = byId.get(organizationId);
    return card === undefined ? [] : [card];
  });
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

/** A2. Strips the internal `variantId` used only to split shared vs variant galleries. */
function toMediaProjection(media: {
  readonly id: string;
  readonly url: string;
  readonly mediaKind: (typeof productImage.$inferSelect)["mediaKind"];
  readonly altText: string | null;
  readonly widthPx: number | null;
  readonly heightPx: number | null;
  readonly position: number;
}): StoreProductMediaProjection {
  return {
    id: media.id,
    url: media.url,
    mediaKind: media.mediaKind,
    altText: media.altText,
    widthPx: media.widthPx,
    heightPx: media.heightPx,
    position: media.position,
  };
}

/**
 * Who is looking (A11, A14).
 *
 * Every field is nullable because a public product page must render for an anonymous
 * visitor. `engagement.viewer` is then `null` rather than a fabricated `false`, and
 * `contactAffordance` is `sign_in` rather than a button that leads to a wall.
 */
export interface StoreProductViewerContext {
  readonly userId: string | null;
  readonly organizationId: string | null;
  readonly memberRole: CommerceOrganizationMemberRole | null;
}

const ANONYMOUS_VIEWER: StoreProductViewerContext = {
  userId: null,
  organizationId: null,
  memberRole: null,
};

export async function getPublicProductBySlug(
  productSlug: string,
  viewer: StoreProductViewerContext = ANONYMOUS_VIEWER,
): Promise<Result<StoreProductDetailProjection, StoreCatalogError>> {
  const viewerUserId = viewer.userId;
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
    customizationOptions,
    variantRows,
    categoryTrail,
    moqMap,
    productReviewMetrics,
    organizationFulfillmentMetrics,
    variantAggregates,
    productEngagements,
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
        leadTimeDays: productPricingTier.leadTimeDays,
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
        id: commerceProductCustomizationOption.id,
        slotKey: commerceProductCustomizationOption.slotKey,
        label: commerceProductCustomizationOption.label,
        customizationKind: commerceProductCustomizationOption.customizationKind,
        acceptedMediaTypes: commerceProductCustomizationOption.acceptedMediaTypes,
        choiceValues: commerceProductCustomizationOption.choiceValues,
        minimumOrderQuantity: commerceProductCustomizationOption.minimumOrderQuantity,
        isRequired: commerceProductCustomizationOption.isRequired,
        position: commerceProductCustomizationOption.position,
      })
      .from(commerceProductCustomizationOption)
      .where(
        and(
          eq(commerceProductCustomizationOption.productId, row.id),
          // Retired options stay on the order lines bought under them but leave the storefront.
          eq(commerceProductCustomizationOption.state, "active"),
        ),
      )
      .orderBy(asc(commerceProductCustomizationOption.position)),
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
    loadProductEngagements([row.id], viewerUserId),
  ]);

  const sharedImages = allImages.filter((media) => media.variantId === null).map(toMediaProjection);
  const sharedPricingTiers = allPricingTiers
    .filter((tier) => tier.variantId === null)
    .map(({ unitPriceInCents, minimumOrderQuantity, leadTimeDays, position }) => ({
      unitPriceInCents,
      minimumOrderQuantity,
      leadTimeDays,
      position,
    }));

  const variants: StoreProductVariantProjection[] = variantRows.map((variantRow) => {
    const variantTiers = allPricingTiers
      .filter((tier) => tier.variantId === variantRow.id)
      .map(({ unitPriceInCents, minimumOrderQuantity, leadTimeDays, position }) => ({
        unitPriceInCents,
        minimumOrderQuantity,
        leadTimeDays,
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
      images: allImages.filter((media) => media.variantId === variantRow.id).map(toMediaProjection),
      // A variant with no ladder of its own inherits the product's, matching how
      // `loadPurchasableProductForCheckout` prices it.
      pricingTiers: variantTiers.length > 0 ? variantTiers : sharedPricingTiers,
    };
  });

  const card = mapProductCard(
    {
      ...row,
      organizationCountryCode: tradingOrganizationCountryCode(
        row.organizationCountryCode,
        row.organizationId,
      ),
    },
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
      customizationOptions,
      specifications,
      categoryTrail,
      engagement: productEngagements.get(row.id) ?? EMPTY_PRODUCT_ENGAGEMENT,
      contactAffordance: deriveContactAffordance({
        viewerUserId: viewer.userId,
        viewerOrganizationId: viewer.organizationId,
        viewerMemberRole: viewer.memberRole,
        sellerOrganizationId: row.organizationId,
      }),
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

  const [productsResult, declaredProfiles, measuredMetrics] = await Promise.all([
    listEligibleProducts({
      sellerOrganizationId: organizationRow.organizationId,
      limit: input.limit,
      cursor: input.cursor,
    }),
    loadSellerDeclaredProfiles([organizationRow.organizationId]),
    loadOrganizationMeasuredMetrics([organizationRow.organizationId]),
  ]);
  if (!productsResult.success) {
    return productsResult;
  }

  return {
    success: true,
    value: {
      ...withTradingOrganizationCountryCode(organizationRow, organizationRow.organizationId),
      declaredProfile: declaredProfiles.get(organizationRow.organizationId) ?? null,
      measuredMetrics:
        measuredMetrics.get(organizationRow.organizationId) ?? EMPTY_MEASURED_METRICS,
      products: productsResult.value,
    },
  };
}
