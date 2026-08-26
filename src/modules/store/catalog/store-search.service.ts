import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

import { db } from "#src/db/index.js";
import {
  commerceCategory,
  commerceOrganization,
  commerceProductHighlight,
  commerceProductSpecification,
  commerceProductVariant,
  commerceProviderKindLink,
  commerceProviderProfile,
  commerceServiceOffering,
  product,
  productPricingTier,
  storeSearchDocument,
} from "#src/db/schema.js";
import { idempotencyKeyFor, JOB_NAMES, sendJob } from "#src/lib/jobs.js";
import { escapeLikePattern } from "#src/lib/sql-pattern.js";
/**
 * A39. `listActiveCategorySubtreeSlugs` is IMPORTED, not redeclared. This file carried a
 * byte-identical private copy and called that one, so the facets and the filters could have
 * been given different subtree rules by editing either. `deriveStockState` was already coming
 * from here, so the edge costs nothing new.
 */
import {
  deriveStockState,
  listActiveCategorySubtreeSlugs,
} from "#src/modules/store/catalog/store-catalog.service.js";
import { tradingOrganizationCountryCode } from "#src/modules/store/commerce-organization-country.js";
import { decodeStoreCursor, encodeStoreCursor } from "#src/modules/store/store-cursor.js";
import type { Result } from "#src/types/index.js";

async function enqueueRefresh(
  payload:
    | {
        readonly targetKind: "product";
        readonly productId: string;
      }
    | {
        readonly targetKind: "provider_offering";
        readonly offeringId: string;
      }
    | {
        readonly targetKind: "organization";
        readonly organizationId: string;
      },
): Promise<void> {
  const generation = new Date().toISOString();
  const idempotencyKey =
    payload.targetKind === "product"
      ? idempotencyKeyFor.refreshStoreSearchDocumentProduct(payload.productId, generation)
      : payload.targetKind === "provider_offering"
        ? idempotencyKeyFor.refreshStoreSearchDocumentOffering(payload.offeringId, generation)
        : idempotencyKeyFor.refreshStoreSearchDocumentOrganization(
            payload.organizationId,
            generation,
          );

  const enqueued = await sendJob(JOB_NAMES.refreshStoreSearchDocument, payload, {
    idempotencyKey,
  });
  if (!enqueued.success) {
    // Fall back to synchronous refresh so a queue outage cannot leave public search stale.
    switch (payload.targetKind) {
      case "product":
        await refreshProductSearchDocument(payload.productId);
        return;
      case "provider_offering":
        await refreshOfferingSearchDocument(payload.offeringId);
        return;
      case "organization":
        await refreshOrganizationSearchEligibility(payload.organizationId);
        return;
      default: {
        const exhaustiveTarget: never = payload;
        throw new Error(`Unhandled enqueue target: ${JSON.stringify(exhaustiveTarget)}`);
      }
    }
  }
}

export async function enqueueProductSearchDocumentRefresh(productId: string): Promise<void> {
  await enqueueRefresh({ targetKind: "product", productId });
}

export async function enqueueOfferingSearchDocumentRefresh(offeringId: string): Promise<void> {
  await enqueueRefresh({ targetKind: "provider_offering", offeringId });
}

export async function enqueueOrganizationSearchDocumentRefresh(
  organizationId: string,
): Promise<void> {
  await enqueueRefresh({ targetKind: "organization", organizationId });
}

export type StoreSearchDocumentKind = (typeof storeSearchDocument.$inferSelect)["documentKind"];
export type StoreSearchStockState = NonNullable<
  (typeof storeSearchDocument.$inferSelect)["stockState"]
>;
export type StoreSearchSamplePolicy = NonNullable<
  (typeof storeSearchDocument.$inferSelect)["samplePolicy"]
>;
export type StoreSearchCondition = NonNullable<
  (typeof storeSearchDocument.$inferSelect)["condition"]
>;
export type StoreSearchVerificationState = NonNullable<
  (typeof storeSearchDocument.$inferSelect)["providerVerificationState"]
>;

export interface StoreSearchHit {
  readonly documentKind: StoreSearchDocumentKind;
  readonly entityId: string;
  readonly publicSlug: string;
  readonly title: string;
  readonly summary: string | null;
  readonly organizationSlug: string;
  readonly organizationDisplayName: string;
  readonly organizationCountryCode: string;
  readonly categorySlug: string | null;
  readonly providerKind: string | null;
  readonly priceInCents: number | null;
  readonly currency: string | null;
  readonly minimumOrderQuantity: number | null;
  /**
   * A25. The filterable facets, projected alongside the filter so a result card can
   * render what it was matched on. All null on a kind that has no such fact.
   */
  readonly stockState: StoreSearchStockState | null;
  readonly samplePolicy: StoreSearchSamplePolicy | null;
  readonly condition: StoreSearchCondition | null;
  readonly providerVerificationState: StoreSearchVerificationState | null;
  readonly leadTimeMaxDays: number | null;
  readonly relevanceScore: number | null;
  /**
   * WHEN THIS DOCUMENT LAST CHANGED, and it is a real content clock rather than a refresh
   * timestamp. `refresh-store-search-document` is enqueued after a product, offering or
   * organization MUTATION and re-reads the authoritative row; there is no nightly sweep that
   * would move every document's stamp daily. Both upsert branches set it explicitly.
   *
   * IT EXISTS FOR THE FRONTEND'S `sitemap.ts`, which states in its own header that nothing
   * there may call `new Date()` — a manufactured `lastModified` is a lie a crawler believes.
   * Before this field NO store list projection carried a timestamp at all, so a sitemap of 128
   * entries could date 6 of them and every product page looked equally stale to a crawler.
   */
  readonly updatedAt: Date;
}

export type StoreSearchError = { type: "INVALID_CURSOR" };

type StoreProviderKind = NonNullable<(typeof storeSearchDocument.$inferSelect)["providerKind"]>;

function encodeRelevanceSortKey(rank: number): string {
  // Fixed-width so lexicographic compare matches numeric order for DESC pagination.
  return rank.toFixed(12).padStart(24, "0");
}

function decodeRelevanceSortKey(sortKey: string): number | null {
  if (!/^\d+\.\d+$/.test(sortKey.trim()) && !/^\d{1,24}\.\d{12}$/.test(sortKey.trim())) {
    const parsed = Number(sortKey);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = Number(sortKey);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Everything that decides WHICH documents match — and nothing that decides their order or
 * their page.
 *
 * A39. Extracted so `searchStoreDocuments` and `computeStoreSearchFacets` take one shape and
 * share one predicate builder. A count computed from a different WHERE than the results is the
 * exact defect Phase 22 exists to close, and the cheapest way to keep them honest is to make it
 * impossible to write two.
 */
export interface StoreSearchFilterInput {
  readonly query?: string | undefined;
  readonly categorySlug?: string | undefined;
  readonly sellerCountryCode?: string | undefined;
  readonly providerKind?: StoreProviderKind | undefined;
  readonly documentKind?: StoreSearchDocumentKind | undefined;
  readonly minOrderQuantityMax?: number | undefined;
  /**
   * A25. The filters that match the facets the platform already publishes. Every one is
   * optional and every one narrows; none of them is a sort.
   */
  readonly priceMinInCents?: number | undefined;
  readonly priceMaxInCents?: number | undefined;
  readonly stockState?: StoreSearchStockState | undefined;
  readonly samplePolicy?: StoreSearchSamplePolicy | undefined;
  readonly condition?: StoreSearchCondition | undefined;
  readonly verificationState?: StoreSearchVerificationState | undefined;
  readonly leadTimeMaxDays?: number | undefined;
  /**
   * `discovery` is STORE Phase 13's ranked sort. IT NEVER TOUCHES `ts_rank_cd`, and
   * `relevance` never touches the discovery score — see `commerce-trending-score.ts` for
   * why the two must not blend. A combined sort would be a THIRD, explicitly named option
   * or it is not offered.
   */
  readonly sort?: "relevance" | "discovery" | undefined;
}

/**
 * The filter a facet must NOT apply to itself (A39).
 *
 * Drill-down, blind to self: `stockStates` counts under every other applied filter but not
 * under `stockState`, so a buyer who picked "In stock" still sees `low_stock (12)` beside it
 * and can switch without clearing first. Amazon and Alibaba both behave this way. Counting a
 * facet under its own filter collapses it to the one value already chosen, and the only route
 * back is to remove the filter and lose the rest of the narrowing with it.
 */
type StoreSearchFacetDimension =
  | "documentKind"
  | "sellerCountryCode"
  | "providerKind"
  | "price"
  | "stockState"
  | "samplePolicy"
  | "condition"
  | "verificationState"
  | "leadTimeMaxDays";

/**
 * THE one WHERE. Both the result query and every facet query are built from this.
 *
 * `categorySlug` is never omittable: it is the SCOPE of the read rather than a filter inside
 * it, and a category facet counted across every other category would be describing a page the
 * buyer is not on.
 */
function buildStoreSearchFilters(
  input: StoreSearchFilterInput,
  categorySlugs: readonly string[] | undefined,
  omit?: StoreSearchFacetDimension,
): readonly (SQL | undefined)[] {
  return [
    eq(storeSearchDocument.isEligible, true),
    input.documentKind === undefined || omit === "documentKind"
      ? undefined
      : eq(storeSearchDocument.documentKind, input.documentKind),
    categorySlugs === undefined
      ? undefined
      : inArray(storeSearchDocument.categorySlug, [...categorySlugs]),
    input.sellerCountryCode === undefined || omit === "sellerCountryCode"
      ? undefined
      : eq(storeSearchDocument.organizationCountryCode, input.sellerCountryCode),
    input.providerKind === undefined || omit === "providerKind"
      ? undefined
      : eq(storeSearchDocument.providerKind, input.providerKind),
    input.minOrderQuantityMax === undefined
      ? undefined
      : sql`(${storeSearchDocument.minimumOrderQuantity} IS NULL
            OR ${storeSearchDocument.minimumOrderQuantity} <= ${input.minOrderQuantityMax})`,
    /**
     * A25. The facet filters, all of them here rather than in the three sort branches,
     * which share this array.
     *
     * A NULL FACET IS EXCLUDED, not admitted. `minOrderQuantityMax` above admits NULL
     * because "no MOQ declared" genuinely satisfies "MOQ at most 50" — the buyer may
     * order any quantity. These are different: a document with no `stock_state` is not
     * a document that is in stock, and admitting it would put provider offerings and
     * organizations into a stock filter that cannot describe them.
     */
    input.priceMinInCents === undefined || omit === "price"
      ? undefined
      : gte(storeSearchDocument.priceInCents, input.priceMinInCents),
    input.priceMaxInCents === undefined || omit === "price"
      ? undefined
      : lte(storeSearchDocument.priceInCents, input.priceMaxInCents),
    input.stockState === undefined || omit === "stockState"
      ? undefined
      : eq(storeSearchDocument.stockState, input.stockState),
    input.samplePolicy === undefined || omit === "samplePolicy"
      ? undefined
      : eq(storeSearchDocument.samplePolicy, input.samplePolicy),
    input.condition === undefined || omit === "condition"
      ? undefined
      : eq(storeSearchDocument.condition, input.condition),
    input.verificationState === undefined || omit === "verificationState"
      ? undefined
      : eq(storeSearchDocument.providerVerificationState, input.verificationState),
    input.leadTimeMaxDays === undefined || omit === "leadTimeMaxDays"
      ? undefined
      : lte(storeSearchDocument.leadTimeMaxDays, input.leadTimeMaxDays),
  ];
}

/**
 * Whether a document MATCHES THE WORDS TYPED — membership, never ranking.
 *
 * A39. THIS USED TO BE THREE DIFFERENT EXPRESSIONS, one per sort branch, and they did not
 * agree: the discovery branch built its `ILIKE` pattern from the RAW query while the other two
 * escaped it, so a query containing `%` or `_` matched a different set of documents depending
 * on how the caller asked them to be ordered. A sort must not change what matches. One
 * expression now, used by all three branches and by every facet count.
 *
 * The relevance branch additionally RANKS with `ts_rank_cd` over the same `tsQuery`; that stays
 * in the branch, because ranking genuinely is the sort's business.
 */
function buildStoreSearchTextPredicate(input: {
  readonly trimmedQuery: string;
  readonly useRelevance: boolean;
}): SQL | undefined {
  if (input.trimmedQuery.length === 0) return undefined;

  const likePattern = `%${escapeLikePattern(input.trimmedQuery)}%`;
  if (!input.useRelevance) {
    return sql`${storeSearchDocument.searchText} ILIKE ${likePattern}`;
  }

  /**
   * Full-text where the query parses into something, `ILIKE` where it does not —
   * `websearch_to_tsquery` yields an empty tsquery for input that is all stopwords or all
   * punctuation, and an empty tsquery matches nothing at all.
   */
  const tsQuery = sql`websearch_to_tsquery('english', ${input.trimmedQuery})`;
  return sql`(
    (numnode(${tsQuery}) > 0 AND ${storeSearchDocument.searchDocument} @@ ${tsQuery})
    OR (NOT (numnode(${tsQuery}) > 0) AND ${storeSearchDocument.searchText} ILIKE ${likePattern})
  )`;
}

/**
 * What all three sort strategies need, built once by `searchStoreDocuments`.
 *
 * `baseFilters` and `textPredicate` are shared with `computeStoreSearchFacets` (A39):
 * MEMBERSHIP in the result set is one decision made in one place, so a facet count can
 * never disagree with the page it labels. Only ORDERING is an individual sort's business,
 * which is why the three functions below differ in their keyset and in nothing else.
 */
interface StoreSearchPageContext {
  readonly input: StoreSearchFilterInput & {
    readonly limit: number;
    readonly cursor?: string | undefined;
  };
  readonly decodedCursor: ReturnType<typeof decodeStoreCursor>;
  readonly baseFilters: ReturnType<typeof buildStoreSearchFilters>;
  readonly textPredicate: ReturnType<typeof buildStoreSearchTextPredicate>;
  readonly trimmedQuery: string;
}

/**
 * The ranked sort. Keyset over `(discovery_score_points DESC NULLS LAST, id)`, which is
 * exactly the index migration 0081 created — the one non-relevance sort in this file that
 * does not fall back to a sequential scan.
 */
async function searchByDiscoveryRank(context: StoreSearchPageContext): Promise<
  Result<
    {
      readonly items: readonly StoreSearchHit[];
      readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
    },
    StoreSearchError
  >
> {
  const { input, decodedCursor, baseFilters, textPredicate } = context;

  /*
   * The ranked sort. Keyset over `(discovery_score_points DESC NULLS LAST, id)`, which is
   * exactly the index `0081` created, so this is the one non-relevance sort in this file
   * that does not fall back to a sequential scan.
   *
   * A TEXT FILTER STILL APPLIES when the caller sent one: "sorted by discovery" does not
   * mean "ignore what I typed". What it does not do is let the score influence the
   * MATCHING — a product either matches the words or it does not, and the score only
   * decides the order among those that do.
   */
  const decodedScore = decodedCursor === null ? null : Number.parseInt(decodedCursor.sortKey, 10);
  if (decodedCursor !== null && !Number.isSafeInteger(decodedScore)) {
    return { success: false, error: { type: "INVALID_CURSOR" } };
  }

  const cursorPredicate =
    decodedCursor === null || decodedScore === null
      ? undefined
      : sql`(coalesce(${storeSearchDocument.discoveryScorePoints}, -1), ${storeSearchDocument.id})
            < (${decodedScore}, ${decodedCursor.id})`;

  const rows = await db
    .select({
      id: storeSearchDocument.id,
      documentKind: storeSearchDocument.documentKind,
      entityId: storeSearchDocument.entityId,
      publicSlug: storeSearchDocument.publicSlug,
      title: storeSearchDocument.title,
      summary: storeSearchDocument.summary,
      organizationSlug: storeSearchDocument.organizationSlug,
      organizationDisplayName: storeSearchDocument.organizationDisplayName,
      organizationCountryCode: storeSearchDocument.organizationCountryCode,
      categorySlug: storeSearchDocument.categorySlug,
      providerKind: storeSearchDocument.providerKind,
      priceInCents: storeSearchDocument.priceInCents,
      currency: storeSearchDocument.currency,
      minimumOrderQuantity: storeSearchDocument.minimumOrderQuantity,
      stockState: storeSearchDocument.stockState,
      samplePolicy: storeSearchDocument.samplePolicy,
      condition: storeSearchDocument.condition,
      providerVerificationState: storeSearchDocument.providerVerificationState,
      leadTimeMaxDays: storeSearchDocument.leadTimeMaxDays,
      updatedAt: storeSearchDocument.updatedAt,
      discoveryScorePoints: storeSearchDocument.discoveryScorePoints,
    })
    .from(storeSearchDocument)
    // A39. `textPredicate`, not a local `ILIKE` built from the RAW query — this branch used
    // to skip `escapeLikePattern`, so a `%` or `_` in the query matched a different set of
    // documents here than under either other sort.
    .where(and(...baseFilters, textPredicate, cursorPredicate))
    .orderBy(
      sql`coalesce(${storeSearchDocument.discoveryScorePoints}, -1) DESC`,
      desc(storeSearchDocument.id),
    )
    .limit(input.limit + 1);

  const hasMore = rows.length > input.limit;
  const pageRows = rows.slice(0, input.limit);
  const lastRow = pageRows[pageRows.length - 1];

  return {
    success: true,
    value: {
      items: pageRows.map((row) => ({
        documentKind: row.documentKind,
        entityId: row.entityId,
        publicSlug: row.publicSlug,
        title: row.title,
        summary: row.summary,
        organizationSlug: row.organizationSlug,
        organizationDisplayName: row.organizationDisplayName,
        organizationCountryCode: tradingOrganizationCountryCode(
          row.organizationCountryCode,
          row.entityId,
        ),
        categorySlug: row.categorySlug,
        providerKind: row.providerKind,
        priceInCents: row.priceInCents,
        currency: row.currency,
        minimumOrderQuantity: row.minimumOrderQuantity,
        stockState: row.stockState,
        samplePolicy: row.samplePolicy,
        condition: row.condition,
        providerVerificationState: row.providerVerificationState,
        leadTimeMaxDays: row.leadTimeMaxDays,
        updatedAt: row.updatedAt,
        // NULL, not the discovery score. `relevanceScore` means "how well did this match
        // the words you typed", and this sort did not ask that question.
        relevanceScore: null,
      })),
      page: {
        nextCursor:
          hasMore && lastRow
            ? encodeStoreCursor({
                sortKey: String(lastRow.discoveryScorePoints ?? -1),
                id: lastRow.id,
              })
            : null,
        hasMore,
      },
    },
  };
}

/**
 * The unranked sort: alphabetical, keyset over `(title, id)`. Taken whenever the caller
 * asked for an explicit order, or asked for relevance without sending a query — with
 * nothing to rank against, ordering by a rank that is zero for every row would hand back
 * whatever order the scan happened to produce.
 */
async function searchByTitle(context: StoreSearchPageContext): Promise<
  Result<
    {
      readonly items: readonly StoreSearchHit[];
      readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
    },
    StoreSearchError
  >
> {
  const { input, decodedCursor, baseFilters, textPredicate } = context;

  const cursorPredicate =
    decodedCursor === null
      ? undefined
      : or(
          sql`${storeSearchDocument.title} > ${decodedCursor.sortKey}`,
          and(
            eq(storeSearchDocument.title, decodedCursor.sortKey),
            gt(storeSearchDocument.id, decodedCursor.id),
          ),
        );

  const rows = await db
    .select({
      documentKind: storeSearchDocument.documentKind,
      entityId: storeSearchDocument.entityId,
      publicSlug: storeSearchDocument.publicSlug,
      title: storeSearchDocument.title,
      summary: storeSearchDocument.summary,
      organizationSlug: storeSearchDocument.organizationSlug,
      organizationDisplayName: storeSearchDocument.organizationDisplayName,
      organizationCountryCode: storeSearchDocument.organizationCountryCode,
      categorySlug: storeSearchDocument.categorySlug,
      providerKind: storeSearchDocument.providerKind,
      priceInCents: storeSearchDocument.priceInCents,
      currency: storeSearchDocument.currency,
      minimumOrderQuantity: storeSearchDocument.minimumOrderQuantity,
      stockState: storeSearchDocument.stockState,
      samplePolicy: storeSearchDocument.samplePolicy,
      condition: storeSearchDocument.condition,
      providerVerificationState: storeSearchDocument.providerVerificationState,
      leadTimeMaxDays: storeSearchDocument.leadTimeMaxDays,
      updatedAt: storeSearchDocument.updatedAt,
      id: storeSearchDocument.id,
    })
    .from(storeSearchDocument)
    .where(and(...baseFilters, textPredicate, cursorPredicate))
    .orderBy(asc(storeSearchDocument.title), asc(storeSearchDocument.id))
    .limit(input.limit + 1);

  const pageRows = rows.slice(0, input.limit);
  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor =
    rows.length > input.limit && lastRow
      ? encodeStoreCursor({ sortKey: lastRow.title, id: lastRow.id })
      : null;

  return {
    success: true,
    value: {
      items: pageRows.map((row) => ({
        documentKind: row.documentKind,
        entityId: row.entityId,
        publicSlug: row.publicSlug,
        title: row.title,
        summary: row.summary,
        organizationSlug: row.organizationSlug,
        organizationDisplayName: row.organizationDisplayName,
        organizationCountryCode: tradingOrganizationCountryCode(
          row.organizationCountryCode,
          row.entityId,
        ),
        categorySlug: row.categorySlug,
        providerKind: row.providerKind,
        priceInCents: row.priceInCents,
        currency: row.currency,
        minimumOrderQuantity: row.minimumOrderQuantity,
        stockState: row.stockState,
        samplePolicy: row.samplePolicy,
        condition: row.condition,
        providerVerificationState: row.providerVerificationState,
        leadTimeMaxDays: row.leadTimeMaxDays,
        updatedAt: row.updatedAt,
        relevanceScore: null,
      })),
      page: { nextCursor, hasMore: nextCursor !== null },
    },
  };
}

/**
 * Full-text relevance. Builds its own `tsQuery` because `ts_rank_cd` needs one; membership
 * still comes from the shared `textPredicate`, so this branch decides ORDER only.
 */
async function searchByRelevance(context: StoreSearchPageContext): Promise<
  Result<
    {
      readonly items: readonly StoreSearchHit[];
      readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
    },
    StoreSearchError
  >
> {
  const { input, decodedCursor, baseFilters, textPredicate, trimmedQuery } = context;

  /**
   * A39. RANKING ONLY. Membership is `textPredicate`, built once above and shared with the
   * other two sorts and with every facet count; this branch keeps its own `tsQuery` because
   * `ts_rank_cd` needs one, and ordering genuinely is the sort's business.
   */
  const tsQuery = sql`websearch_to_tsquery('english', ${trimmedQuery})`;
  const hasUsableTsQuery = sql`numnode(${tsQuery}) > 0`;
  const rankExpression = sql`
    CASE
      WHEN ${hasUsableTsQuery}
        THEN ts_rank_cd(${storeSearchDocument.searchDocument}, ${tsQuery}, 32)
      ELSE 0
    END
  `;

  let cursorPredicate = undefined;
  if (decodedCursor !== null) {
    const cursorRank = decodeRelevanceSortKey(decodedCursor.sortKey);
    if (cursorRank === null) {
      return { success: false, error: { type: "INVALID_CURSOR" } };
    }
    cursorPredicate = or(
      sql`(${rankExpression}) < ${cursorRank}`,
      and(sql`(${rankExpression}) = ${cursorRank}`, gt(storeSearchDocument.id, decodedCursor.id)),
    );
  }

  const rows = await db
    .select({
      documentKind: storeSearchDocument.documentKind,
      entityId: storeSearchDocument.entityId,
      publicSlug: storeSearchDocument.publicSlug,
      title: storeSearchDocument.title,
      summary: storeSearchDocument.summary,
      organizationSlug: storeSearchDocument.organizationSlug,
      organizationDisplayName: storeSearchDocument.organizationDisplayName,
      organizationCountryCode: storeSearchDocument.organizationCountryCode,
      categorySlug: storeSearchDocument.categorySlug,
      providerKind: storeSearchDocument.providerKind,
      priceInCents: storeSearchDocument.priceInCents,
      currency: storeSearchDocument.currency,
      minimumOrderQuantity: storeSearchDocument.minimumOrderQuantity,
      stockState: storeSearchDocument.stockState,
      samplePolicy: storeSearchDocument.samplePolicy,
      condition: storeSearchDocument.condition,
      providerVerificationState: storeSearchDocument.providerVerificationState,
      leadTimeMaxDays: storeSearchDocument.leadTimeMaxDays,
      updatedAt: storeSearchDocument.updatedAt,
      id: storeSearchDocument.id,
      relevanceScore: sql<number>`${rankExpression}`.mapWith(Number),
    })
    .from(storeSearchDocument)
    .where(and(...baseFilters, textPredicate, cursorPredicate))
    .orderBy(desc(rankExpression), asc(storeSearchDocument.id))
    .limit(input.limit + 1);

  const pageRows = rows.slice(0, input.limit);
  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor =
    rows.length > input.limit && lastRow
      ? encodeStoreCursor({
          sortKey: encodeRelevanceSortKey(lastRow.relevanceScore),
          id: lastRow.id,
        })
      : null;

  return {
    success: true,
    value: {
      items: pageRows.map((row) => ({
        documentKind: row.documentKind,
        entityId: row.entityId,
        publicSlug: row.publicSlug,
        title: row.title,
        summary: row.summary,
        organizationSlug: row.organizationSlug,
        organizationDisplayName: row.organizationDisplayName,
        organizationCountryCode: tradingOrganizationCountryCode(
          row.organizationCountryCode,
          row.entityId,
        ),
        categorySlug: row.categorySlug,
        providerKind: row.providerKind,
        priceInCents: row.priceInCents,
        currency: row.currency,
        minimumOrderQuantity: row.minimumOrderQuantity,
        stockState: row.stockState,
        samplePolicy: row.samplePolicy,
        condition: row.condition,
        providerVerificationState: row.providerVerificationState,
        leadTimeMaxDays: row.leadTimeMaxDays,
        updatedAt: row.updatedAt,
        relevanceScore: row.relevanceScore,
      })),
      page: { nextCursor, hasMore: nextCursor !== null },
    },
  };
}

export async function searchStoreDocuments(
  input: StoreSearchFilterInput & {
    readonly limit: number;
    readonly cursor?: string | undefined;
  },
): Promise<
  Result<
    {
      readonly items: readonly StoreSearchHit[];
      readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
    },
    StoreSearchError
  >
> {
  const decodedCursor = input.cursor === undefined ? null : decodeStoreCursor(input.cursor);
  if (input.cursor !== undefined && decodedCursor === null) {
    return { success: false, error: { type: "INVALID_CURSOR" } };
  }

  const trimmedQuery = input.query?.trim() ?? "";
  const hasQuery = trimmedQuery.length > 0;
  const useDiscovery = input.sort === "discovery";
  const useRelevance =
    !useDiscovery && hasQuery && (input.sort === undefined || input.sort === "relevance");

  const categorySlugs =
    input.categorySlug === undefined
      ? undefined
      : await listActiveCategorySubtreeSlugs(input.categorySlug);
  if (
    input.categorySlug !== undefined &&
    (categorySlugs === undefined || categorySlugs.length === 0)
  ) {
    return {
      success: true,
      value: { items: [], page: { nextCursor: null, hasMore: false } },
    };
  }

  // A39. The SAME builder every facet count uses — see `computeStoreSearchFacets`.
  const baseFilters = buildStoreSearchFilters(input, categorySlugs);
  const textPredicate = buildStoreSearchTextPredicate({ trimmedQuery, useRelevance });

  const context: StoreSearchPageContext = {
    input,
    decodedCursor,
    baseFilters,
    textPredicate,
    trimmedQuery,
  };

  if (useDiscovery) return await searchByDiscoveryRank(context);
  if (!useRelevance) return await searchByTitle(context);
  return await searchByRelevance(context);
}

export interface StoreSearchFacetBucket {
  readonly value: string;
  readonly count: number;
}

export interface StoreSearchFacets {
  readonly sellerCountryCodes: readonly StoreSearchFacetBucket[];
  readonly stockStates: readonly StoreSearchFacetBucket[];
  readonly samplePolicies: readonly StoreSearchFacetBucket[];
  readonly conditions: readonly StoreSearchFacetBucket[];
  readonly verificationStates: readonly StoreSearchFacetBucket[];
  readonly documentKinds: readonly StoreSearchFacetBucket[];
  readonly providerKinds: readonly StoreSearchFacetBucket[];
  /**
   * BUCKETED, not a min/max pair like price. A lead time is chosen from ranges — "within a
   * week", "within a month" — and a scalar min/max cannot be clicked.
   */
  readonly leadTimeMaxDays: readonly StoreSearchFacetBucket[];
  readonly priceRangesInCents: {
    readonly minInCents: number | null;
    readonly maxInCents: number | null;
    readonly count: number;
  };
}

const EMPTY_STORE_SEARCH_FACETS: StoreSearchFacets = {
  sellerCountryCodes: [],
  stockStates: [],
  samplePolicies: [],
  conditions: [],
  verificationStates: [],
  documentKinds: [],
  providerKinds: [],
  leadTimeMaxDays: [],
  priceRangesInCents: { minInCents: null, maxInCents: null, count: 0 },
};

/**
 * The lead-time ranges a buyer actually picks from, in days.
 *
 * Upper bounds, matching the `leadTimeMaxDays` filter's `<=`: clicking "30" asks for everything
 * that ships within 30 days, so the buckets NEST rather than partition. A document counted in
 * "7" is also counted in "30", which is what makes each count the honest answer to "how many
 * will I get if I click this".
 */
const LEAD_TIME_FACET_BUCKET_DAYS: readonly number[] = [7, 15, 30, 60, 90];

/** One grouped count over a nullable column, ordered count-desc then value-asc. */
async function countByColumn(
  column: PgColumn,
  filters: readonly (SQL | undefined)[],
  textPredicate: SQL | undefined,
): Promise<readonly StoreSearchFacetBucket[]> {
  const rows = await db
    .select({ value: column, count: sql<number>`count(*)::int`.mapWith(Number) })
    .from(storeSearchDocument)
    .where(and(...filters, textPredicate, isNotNull(column)))
    .groupBy(column)
    .orderBy(desc(sql`count(*)`), asc(column));

  // `isNotNull` above makes the non-string case unreachable. Narrowed rather than asserted,
  // per CLAUDE §2's ban on unchecked casts.
  return rows.flatMap((row) =>
    typeof row.value === "string" ? [{ value: row.value, count: row.count }] : [],
  );
}

/**
 * The counts beside the filters (Appendix A39).
 *
 * WHY THIS EXISTS. `getCategoryFacets` used to aggregate over `product` while every filter read
 * `store_search_document`, so the two answered from different tables — and not merely in
 * theory. The facet derived stock from the product row's `stock_quantity` while the card and
 * the document both derive it from the ACTIVE VARIANT SUM, so a category page could render
 * "In stock (12)" above twelve cards reading *Unavailable*. Same request, same products, two
 * answers. Price diverged the same way.
 *
 * ONE `WHERE`, BUILT ONCE. Every count below is `buildStoreSearchFilters` — the same function
 * `searchStoreDocuments` calls — so a count and its result set cannot disagree without the
 * shared builder being wrong for both.
 *
 * DRILL-DOWN, BLIND TO SELF. Each facet omits its OWN filter and applies every other, which is
 * what Amazon and Alibaba both do: after picking "In stock" the buyer still sees `low_stock (12)`
 * and can switch in one click. That is why this is N grouped queries rather than one shared
 * scan — the N differ from each other by exactly one predicate. Each hits a partial index this
 * table already carries, and they run concurrently.
 *
 * ZERO-COUNT VALUES ARE ABSENT, not padded to zero. That is the behaviour the four original
 * facets already had, so no wire shape changes; and neither a country code nor a price range
 * has a closed value set, so padding could never have been uniform across facets anyway.
 */
export async function computeStoreSearchFacets(
  input: StoreSearchFilterInput,
): Promise<StoreSearchFacets> {
  const trimmedQuery = input.query?.trim() ?? "";
  const useRelevance =
    input.sort !== "discovery" &&
    trimmedQuery.length > 0 &&
    (input.sort === undefined || input.sort === "relevance");

  const categorySlugs =
    input.categorySlug === undefined
      ? undefined
      : await listActiveCategorySubtreeSlugs(input.categorySlug);
  if (
    input.categorySlug !== undefined &&
    (categorySlugs === undefined || categorySlugs.length === 0)
  ) {
    return EMPTY_STORE_SEARCH_FACETS;
  }

  const textPredicate = buildStoreSearchTextPredicate({ trimmedQuery, useRelevance });
  const scopedFor = (omit: StoreSearchFacetDimension): readonly (SQL | undefined)[] =>
    buildStoreSearchFilters(input, categorySlugs, omit);

  const [
    sellerCountryCodes,
    stockStates,
    samplePolicies,
    conditions,
    verificationStates,
    documentKinds,
    providerKinds,
    leadTimeRows,
    priceRow,
  ] = await Promise.all([
    countByColumn(
      storeSearchDocument.organizationCountryCode,
      scopedFor("sellerCountryCode"),
      textPredicate,
    ),
    countByColumn(storeSearchDocument.stockState, scopedFor("stockState"), textPredicate),
    countByColumn(storeSearchDocument.samplePolicy, scopedFor("samplePolicy"), textPredicate),
    countByColumn(storeSearchDocument.condition, scopedFor("condition"), textPredicate),
    countByColumn(
      storeSearchDocument.providerVerificationState,
      scopedFor("verificationState"),
      textPredicate,
    ),
    countByColumn(storeSearchDocument.documentKind, scopedFor("documentKind"), textPredicate),
    countByColumn(storeSearchDocument.providerKind, scopedFor("providerKind"), textPredicate),
    /**
     * ONE ROW, one `count(*) FILTER` per bucket — a single scan rather than one per bucket,
     * because the buckets NEST and re-scanning for each would read the same rows five times.
     *
     * Aliased columns rather than `json_build_object`: the bucket bounds go into the query as
     * bound parameters, and Postgres cannot infer a type for one sitting in `json_build_object`'s
     * key position. An alias sidesteps the question entirely.
     */
    db
      .select(
        Object.fromEntries(
          LEAD_TIME_FACET_BUCKET_DAYS.map((days) => [
            `days${String(days)}`,
            sql<number>`count(*) FILTER (WHERE ${storeSearchDocument.leadTimeMaxDays} <= ${days})::int`.mapWith(
              Number,
            ),
          ]),
        ),
      )
      .from(storeSearchDocument)
      .where(and(...scopedFor("leadTimeMaxDays"), textPredicate)),
    db
      .select({
        minInCents: sql<number | null>`min(${storeSearchDocument.priceInCents})`.mapWith(Number),
        maxInCents: sql<number | null>`max(${storeSearchDocument.priceInCents})`.mapWith(Number),
        count: sql<number>`count(${storeSearchDocument.priceInCents})::int`.mapWith(Number),
      })
      .from(storeSearchDocument)
      .where(and(...scopedFor("price"), textPredicate)),
  ]);

  const leadTimeCounts = leadTimeRows[0] ?? {};
  const priceSummary = priceRow[0];

  return {
    sellerCountryCodes,
    stockStates,
    samplePolicies,
    conditions,
    verificationStates,
    documentKinds,
    providerKinds,
    leadTimeMaxDays: LEAD_TIME_FACET_BUCKET_DAYS.flatMap((days) => {
      const count = leadTimeCounts[`days${String(days)}`];
      // A bucket nobody matched is dropped, like every other facet here.
      return typeof count === "number" && count > 0 ? [{ value: String(days), count }] : [];
    }),
    priceRangesInCents: {
      minInCents: priceSummary?.minInCents ?? null,
      maxInCents: priceSummary?.maxInCents ?? null,
      count: priceSummary?.count ?? 0,
    },
  };
}

export async function refreshProductSearchDocument(productId: string): Promise<void> {
  const [row] = await db
    .select({
      id: product.id,
      publicSlug: product.publicSlug,
      title: product.title,
      description: product.description,
      brand: product.brand,
      priceInCents: product.priceInCents,
      currency: product.currency,
      status: product.status,
      moderationState: product.moderationState,
      publishedAt: product.publishedAt,
      // A25. The facet columns, read here so `/store/search` can filter on them.
      stockQuantity: product.stockQuantity,
      samplePolicy: product.samplePolicy,
      condition: product.condition,
      leadTimeMinDays: product.leadTimeMinDays,
      leadTimeMaxDays: product.leadTimeMaxDays,
      organizationId: commerceOrganization.id,
      organizationSlug: commerceOrganization.slug,
      organizationDisplayName: commerceOrganization.displayName,
      organizationCountryCode: commerceOrganization.countryCode,
      organizationTradeState: commerceOrganization.tradeState,
      organizationVisibility: commerceOrganization.visibility,
      categoryId: commerceCategory.id,
      categorySlug: commerceCategory.slug,
      categoryState: commerceCategory.state,
    })
    .from(product)
    .innerJoin(commerceOrganization, eq(commerceOrganization.id, product.sellerOrganizationId))
    .leftJoin(commerceCategory, eq(commerceCategory.id, product.categoryId))
    .where(eq(product.id, productId))
    .limit(1);

  if (!row || row.publicSlug === null || row.organizationId === null) {
    await db
      .delete(storeSearchDocument)
      .where(
        and(
          eq(storeSearchDocument.documentKind, "product"),
          eq(storeSearchDocument.entityId, productId),
        ),
      );
    return;
  }

  const [moqRow] = await db
    .select({
      minimumOrderQuantity: sql<number>`min(${productPricingTier.minimumOrderQuantity})`.mapWith(
        Number,
      ),
    })
    .from(productPricingTier)
    .where(eq(productPricingTier.productId, productId));

  /**
   * A1. Search must advertise the price a buyer can actually pay. Once a product
   * sells by variant, `product.priceInCents` is not that price — the cheapest active
   * variant is, and a facet or sort built on the stale column would rank the catalog
   * by a number nothing sells at.
   */
  const [variantPriceRow] = await db
    .select({
      lowestPriceInCents: sql<number | null>`min(${commerceProductVariant.priceInCents})`,
    })
    .from(commerceProductVariant)
    .where(
      and(
        eq(commerceProductVariant.productId, productId),
        eq(commerceProductVariant.state, "active"),
      ),
    );
  const searchPriceInCents = variantPriceRow?.lowestPriceInCents ?? row.priceInCents;

  const [specificationRows, variantNameRows, highlightRows, categorySynonymRow] = await Promise.all(
    [
      db
        .select({
          key: commerceProductSpecification.specificationKey,
          value: commerceProductSpecification.specificationValue,
          group: commerceProductSpecification.specificationGroup,
        })
        .from(commerceProductSpecification)
        .where(eq(commerceProductSpecification.productId, productId))
        .orderBy(asc(commerceProductSpecification.position)),
      db
        .select({
          name: commerceProductVariant.name,
          stockQuantity: commerceProductVariant.stockQuantity,
        })
        .from(commerceProductVariant)
        .where(
          and(
            eq(commerceProductVariant.productId, productId),
            eq(commerceProductVariant.state, "active"),
          ),
        )
        .orderBy(asc(commerceProductVariant.position)),
      db
        .select({ title: commerceProductHighlight.title })
        .from(commerceProductHighlight)
        .where(eq(commerceProductHighlight.productId, productId))
        .orderBy(asc(commerceProductHighlight.position)),
      row.categoryId === null
        ? Promise.resolve(undefined)
        : db
            .select({ searchSynonyms: commerceCategory.searchSynonyms })
            .from(commerceCategory)
            .where(eq(commerceCategory.id, row.categoryId))
            .limit(1)
            .then((rows) => rows[0]),
    ],
  );

  const isEligible =
    row.status === "active" &&
    row.moderationState === "approved" &&
    row.organizationTradeState === "active" &&
    row.organizationVisibility === "public" &&
    row.categoryState === "active" &&
    row.categoryId !== null;

  /**
   * A25. Variant-aware, exactly as `mapProductCard` is: a product whose variants are all
   * out of stock is unavailable even when the product row still carries stock. A card
   * saying "in stock" that the stock filter disagreed with would be the worse bug of the
   * two, because both come from this same denormalized column.
   */
  const searchStockState = deriveStockState({
    stockQuantity:
      variantNameRows.length > 0
        ? variantNameRows.reduce((total, variant) => total + variant.stockQuantity, 0)
        : row.stockQuantity,
    leadTimeMinDays: row.leadTimeMinDays,
    leadTimeMaxDays: row.leadTimeMaxDays,
  });

  const searchText = [
    row.title,
    row.brand,
    row.description,
    row.organizationDisplayName,
    ...(categorySynonymRow?.searchSynonyms ?? []),
    ...specificationRows.flatMap((specification) => [
      specification.key,
      specification.value,
      specification.group,
    ]),
    // "Sea blue" and a highlight title are things buyers type; both are public.
    ...variantNameRows.map((variant) => variant.name),
    ...highlightRows.map((highlight) => highlight.title),
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ");

  await db
    .insert(storeSearchDocument)
    .values({
      documentKind: "product",
      entityId: row.id,
      publicSlug: row.publicSlug,
      title: row.title,
      summary: row.description,
      organizationId: row.organizationId,
      organizationSlug: row.organizationSlug,
      organizationDisplayName: row.organizationDisplayName,
      organizationCountryCode: row.organizationCountryCode,
      categoryId: row.categoryId,
      categorySlug: row.categorySlug,
      providerKind: null,
      priceInCents: searchPriceInCents,
      currency: row.currency,
      minimumOrderQuantity: moqRow?.minimumOrderQuantity ?? null,
      stockState: searchStockState,
      samplePolicy: row.samplePolicy,
      condition: row.condition,
      providerVerificationState: null,
      leadTimeMaxDays: row.leadTimeMaxDays,
      searchText,
      isEligible,
      publishedAt: row.publishedAt,
    })
    .onConflictDoUpdate({
      target: [storeSearchDocument.documentKind, storeSearchDocument.entityId],
      set: {
        publicSlug: row.publicSlug,
        title: row.title,
        summary: row.description,
        organizationId: row.organizationId,
        organizationSlug: row.organizationSlug,
        organizationDisplayName: row.organizationDisplayName,
        organizationCountryCode: row.organizationCountryCode,
        categoryId: row.categoryId,
        categorySlug: row.categorySlug,
        priceInCents: searchPriceInCents,
        currency: row.currency,
        minimumOrderQuantity: moqRow?.minimumOrderQuantity ?? null,
        // Every A25 column is listed explicitly. This `set` block survives by style
        // rather than by guarantee — a column omitted here keeps a stale value forever
        // while the row around it updates, which is the drift `0081`'s trigger exists
        // to prevent on the two columns it owns.
        stockState: searchStockState,
        samplePolicy: row.samplePolicy,
        condition: row.condition,
        providerVerificationState: null,
        leadTimeMaxDays: row.leadTimeMaxDays,
        searchText,
        isEligible,
        publishedAt: row.publishedAt,
        updatedAt: new Date(),
      },
    });
}

export async function refreshOfferingSearchDocument(offeringId: string): Promise<void> {
  const [row] = await db
    .select({
      id: commerceServiceOffering.id,
      slug: commerceServiceOffering.slug,
      title: commerceServiceOffering.title,
      summary: commerceServiceOffering.summary,
      state: commerceServiceOffering.state,
      providerKind: commerceServiceOffering.providerKind,
      indicativePriceMinInCents: commerceServiceOffering.indicativePriceMinInCents,
      maximumLeadTimeDays: commerceServiceOffering.maximumLeadTimeDays,
      currency: commerceServiceOffering.currency,
      organizationId: commerceOrganization.id,
      organizationSlug: commerceOrganization.slug,
      organizationDisplayName: commerceOrganization.displayName,
      organizationCountryCode: commerceOrganization.countryCode,
      organizationTradeState: commerceOrganization.tradeState,
      organizationVisibility: commerceOrganization.visibility,
      profileVerificationState: commerceProviderProfile.verificationState,
      kindVerificationState: commerceProviderKindLink.verificationState,
    })
    .from(commerceServiceOffering)
    .innerJoin(
      commerceProviderProfile,
      eq(commerceProviderProfile.organizationId, commerceServiceOffering.providerOrganizationId),
    )
    .innerJoin(
      commerceOrganization,
      eq(commerceOrganization.id, commerceServiceOffering.providerOrganizationId),
    )
    .leftJoin(
      commerceProviderKindLink,
      and(
        eq(commerceProviderKindLink.organizationId, commerceServiceOffering.providerOrganizationId),
        eq(commerceProviderKindLink.providerKind, commerceServiceOffering.providerKind),
      ),
    )
    .where(eq(commerceServiceOffering.id, offeringId))
    .limit(1);

  if (!row) {
    await db
      .delete(storeSearchDocument)
      .where(
        and(
          eq(storeSearchDocument.documentKind, "provider_offering"),
          eq(storeSearchDocument.entityId, offeringId),
        ),
      );
    return;
  }

  const kindIsPubliclyVerified =
    row.kindVerificationState !== null &&
    row.kindVerificationState !== "rejected" &&
    row.kindVerificationState !== "suspended";

  const isEligible =
    row.state === "active" &&
    row.organizationTradeState === "active" &&
    row.organizationVisibility === "public" &&
    row.profileVerificationState !== "rejected" &&
    row.profileVerificationState !== "suspended" &&
    kindIsPubliclyVerified;

  const searchText = [row.title, row.summary, row.organizationDisplayName, row.providerKind]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ");

  await db
    .insert(storeSearchDocument)
    .values({
      documentKind: "provider_offering",
      entityId: row.id,
      publicSlug: row.slug,
      title: row.title,
      summary: row.summary,
      organizationId: row.organizationId,
      organizationSlug: row.organizationSlug,
      organizationDisplayName: row.organizationDisplayName,
      organizationCountryCode: row.organizationCountryCode,
      categoryId: null,
      categorySlug: null,
      providerKind: row.providerKind,
      priceInCents: row.indicativePriceMinInCents,
      currency: row.currency,
      minimumOrderQuantity: null,
      // A25. A service offering has no stock, no sample and no condition; it has a
      // verification state, which is the one facet a provider directory filters on.
      stockState: null,
      samplePolicy: null,
      condition: null,
      providerVerificationState: row.profileVerificationState,
      leadTimeMaxDays: row.maximumLeadTimeDays,
      searchText,
      isEligible,
      publishedAt: null,
    })
    .onConflictDoUpdate({
      target: [storeSearchDocument.documentKind, storeSearchDocument.entityId],
      set: {
        publicSlug: row.slug,
        title: row.title,
        summary: row.summary,
        organizationId: row.organizationId,
        organizationSlug: row.organizationSlug,
        organizationDisplayName: row.organizationDisplayName,
        organizationCountryCode: row.organizationCountryCode,
        providerKind: row.providerKind,
        priceInCents: row.indicativePriceMinInCents,
        currency: row.currency,
        stockState: null,
        samplePolicy: null,
        condition: null,
        providerVerificationState: row.profileVerificationState,
        leadTimeMaxDays: row.maximumLeadTimeDays,
        searchText,
        isEligible,
        updatedAt: new Date(),
      },
    });
}

/**
 * A25. The organization itself as a search document — the supplier directory.
 *
 * A buyer could reach one storefront by slug and could not browse or filter sellers at
 * all, while service providers had both a directory and a detail page. This closes that
 * asymmetry with the SAME public-eligibility rule products already answer to.
 *
 * The document carries no price, no MOQ, no category and no stock: an organization is
 * not a thing with a price. What it carries is the text a buyer would actually type —
 * the legal name as well as the display name, and the categories it sells into, so
 * "cold chain" finds the manufacturer and not only the freezer.
 */
export async function refreshOrganizationSearchDocument(organizationId: string): Promise<void> {
  const [row] = await db
    .select({
      id: commerceOrganization.id,
      slug: commerceOrganization.slug,
      legalName: commerceOrganization.legalName,
      displayName: commerceOrganization.displayName,
      summary: commerceOrganization.summary,
      countryCode: commerceOrganization.countryCode,
      tradeState: commerceOrganization.tradeState,
      visibility: commerceOrganization.visibility,
      createdAt: commerceOrganization.createdAt,
    })
    .from(commerceOrganization)
    .where(eq(commerceOrganization.id, organizationId))
    .limit(1);

  if (!row) {
    await db
      .delete(storeSearchDocument)
      .where(
        and(
          eq(storeSearchDocument.documentKind, "organization"),
          eq(storeSearchDocument.entityId, organizationId),
        ),
      );
    return;
  }

  /**
   * The category names this organization actually sells into, and only through products
   * the public can already see. Deriving them from ineligible listings would let a
   * suspended catalog keep steering supplier search.
   */
  const categoryNameRows = await db
    .selectDistinct({ name: commerceCategory.name })
    .from(storeSearchDocument)
    .innerJoin(commerceCategory, eq(commerceCategory.id, storeSearchDocument.categoryId))
    .where(
      and(
        eq(storeSearchDocument.organizationId, organizationId),
        eq(storeSearchDocument.documentKind, "product"),
        eq(storeSearchDocument.isEligible, true),
      ),
    );

  const isEligible = row.tradeState === "active" && row.visibility === "public";

  const searchText = [
    row.displayName,
    row.legalName,
    row.summary,
    ...categoryNameRows.map((category) => category.name),
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ");

  const documentValues = {
    publicSlug: row.slug,
    title: row.displayName,
    summary: row.summary,
    organizationId: row.id,
    organizationSlug: row.slug,
    organizationDisplayName: row.displayName,
    organizationCountryCode: row.countryCode,
    categoryId: null,
    categorySlug: null,
    providerKind: null,
    priceInCents: null,
    currency: null,
    minimumOrderQuantity: null,
    stockState: null,
    samplePolicy: null,
    condition: null,
    // A seller organization's own verification is per PROVIDER KIND and does not
    // describe it as a seller, so this stays null rather than borrowing a provider's.
    providerVerificationState: null,
    leadTimeMaxDays: null,
    searchText,
    isEligible,
    publishedAt: row.createdAt,
  } as const;

  await db
    .insert(storeSearchDocument)
    .values({ documentKind: "organization", entityId: row.id, ...documentValues })
    .onConflictDoUpdate({
      target: [storeSearchDocument.documentKind, storeSearchDocument.entityId],
      set: { ...documentValues, updatedAt: new Date() },
    });
}

/**
 * Recompute every search document owned by an organization — its products, its
 * offerings, and (A25) the organization document itself.
 *
 * The organization document is refreshed LAST, because its `searchText` reads the
 * category names off its own eligible product documents and would otherwise be built
 * from the previous generation of them.
 */
export async function refreshOrganizationSearchEligibility(organizationId: string): Promise<void> {
  const productIds = await db
    .select({ id: product.id })
    .from(product)
    .where(eq(product.sellerOrganizationId, organizationId));
  for (const row of productIds) {
    await refreshProductSearchDocument(row.id);
  }

  const offeringIds = await db
    .select({ id: commerceServiceOffering.id })
    .from(commerceServiceOffering)
    .where(eq(commerceServiceOffering.providerOrganizationId, organizationId));
  for (const row of offeringIds) {
    await refreshOfferingSearchDocument(row.id);
  }

  await refreshOrganizationSearchDocument(organizationId);
}

/** Newest eligible product cards for algorithmic rails, with optional cursor. */
export async function listNewestEligibleSearchProducts(input: {
  readonly limit: number;
  readonly cursor?: string | undefined;
}): Promise<
  Result<
    {
      readonly items: readonly {
        readonly entityId: string;
        readonly publicSlug: string;
        readonly title: string;
        readonly publishedAt: Date | null;
      }[];
      readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
    },
    StoreSearchError
  >
> {
  const decodedCursor = input.cursor === undefined ? null : decodeStoreCursor(input.cursor);
  if (input.cursor !== undefined && decodedCursor === null) {
    return { success: false, error: { type: "INVALID_CURSOR" } };
  }

  const cursorPredicate =
    decodedCursor === null
      ? undefined
      : or(
          sql`coalesce(${storeSearchDocument.publishedAt}, ${storeSearchDocument.createdAt}) < ${decodedCursor.sortKey}::timestamp`,
          and(
            sql`coalesce(${storeSearchDocument.publishedAt}, ${storeSearchDocument.createdAt}) = ${decodedCursor.sortKey}::timestamp`,
            gt(storeSearchDocument.id, decodedCursor.id),
          ),
        );

  const rows = await db
    .select({
      entityId: storeSearchDocument.entityId,
      publicSlug: storeSearchDocument.publicSlug,
      title: storeSearchDocument.title,
      publishedAt: storeSearchDocument.publishedAt,
      createdAt: storeSearchDocument.createdAt,
      id: storeSearchDocument.id,
    })
    .from(storeSearchDocument)
    .where(
      and(
        eq(storeSearchDocument.isEligible, true),
        eq(storeSearchDocument.documentKind, "product"),
        cursorPredicate,
      ),
    )
    .orderBy(
      desc(sql`coalesce(${storeSearchDocument.publishedAt}, ${storeSearchDocument.createdAt})`),
      asc(storeSearchDocument.id),
    )
    .limit(input.limit + 1);

  const pageRows = rows.slice(0, input.limit);
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
      items: pageRows.map((row) => ({
        entityId: row.entityId,
        publicSlug: row.publicSlug,
        title: row.title,
        publishedAt: row.publishedAt,
      })),
      page: { nextCursor, hasMore: nextCursor !== null },
    },
  };
}
