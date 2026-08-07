import { and, asc, desc, eq, gt, inArray, or, sql } from "drizzle-orm";

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
import { decodeStoreCursor, encodeStoreCursor } from "#src/lib/store-cursor.js";
import type { Result } from "#src/types/index.js";

async function listActiveCategorySubtreeSlugs(
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

export type StoreSearchDocumentKind = "product" | "provider_offering";

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
  readonly relevanceScore: number | null;
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

export async function searchStoreDocuments(input: {
  readonly query?: string | undefined;
  readonly categorySlug?: string | undefined;
  readonly sellerCountryCode?: string | undefined;
  readonly providerKind?: StoreProviderKind | undefined;
  readonly documentKind?: StoreSearchDocumentKind | undefined;
  readonly minOrderQuantityMax?: number | undefined;
  /**
   * `discovery` is STORE Phase 13's ranked sort. IT NEVER TOUCHES `ts_rank_cd`, and
   * `relevance` never touches the discovery score — see `commerce-trending-score.ts` for
   * why the two must not blend. A combined sort would be a THIRD, explicitly named option
   * or it is not offered.
   */
  readonly sort?: "relevance" | "discovery" | undefined;
  readonly limit: number;
  readonly cursor?: string | undefined;
}): Promise<
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

  const baseFilters = [
    eq(storeSearchDocument.isEligible, true),
    input.documentKind === undefined
      ? undefined
      : eq(storeSearchDocument.documentKind, input.documentKind),
    categorySlugs === undefined
      ? undefined
      : inArray(storeSearchDocument.categorySlug, [...categorySlugs]),
    input.sellerCountryCode === undefined
      ? undefined
      : eq(storeSearchDocument.organizationCountryCode, input.sellerCountryCode),
    input.providerKind === undefined
      ? undefined
      : eq(storeSearchDocument.providerKind, input.providerKind),
    input.minOrderQuantityMax === undefined
      ? undefined
      : sql`(${storeSearchDocument.minimumOrderQuantity} IS NULL
            OR ${storeSearchDocument.minimumOrderQuantity} <= ${input.minOrderQuantityMax})`,
  ];

  if (useDiscovery) {
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
        discoveryScorePoints: storeSearchDocument.discoveryScorePoints,
      })
      .from(storeSearchDocument)
      .where(
        and(
          ...baseFilters,
          hasQuery
            ? sql`${storeSearchDocument.searchText} ILIKE ${`%${trimmedQuery}%`}`
            : undefined,
          cursorPredicate,
        ),
      )
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
          organizationCountryCode: row.organizationCountryCode,
          categorySlug: row.categorySlug,
          providerKind: row.providerKind,
          priceInCents: row.priceInCents,
          currency: row.currency,
          minimumOrderQuantity: row.minimumOrderQuantity,
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

  if (!useRelevance) {
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

    const likeFilter = !hasQuery
      ? undefined
      : sql`${storeSearchDocument.searchText} ILIKE ${`%${escapeLikePattern(trimmedQuery)}%`}`;

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
        id: storeSearchDocument.id,
      })
      .from(storeSearchDocument)
      .where(and(...baseFilters, likeFilter, cursorPredicate))
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
          organizationCountryCode: row.organizationCountryCode,
          categorySlug: row.categorySlug,
          providerKind: row.providerKind,
          priceInCents: row.priceInCents,
          currency: row.currency,
          minimumOrderQuantity: row.minimumOrderQuantity,
          relevanceScore: null,
        })),
        page: { nextCursor, hasMore: nextCursor !== null },
      },
    };
  }

  const tsQuery = sql`websearch_to_tsquery('english', ${trimmedQuery})`;
  const likePattern = `%${escapeLikePattern(trimmedQuery)}%`;
  const hasUsableTsQuery = sql`numnode(${tsQuery}) > 0`;
  const matchPredicate = sql`(
    (${hasUsableTsQuery} AND ${storeSearchDocument.searchDocument} @@ ${tsQuery})
    OR (NOT ${hasUsableTsQuery} AND ${storeSearchDocument.searchText} ILIKE ${likePattern})
  )`;
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
      id: storeSearchDocument.id,
      relevanceScore: sql<number>`${rankExpression}`.mapWith(Number),
    })
    .from(storeSearchDocument)
    .where(and(...baseFilters, matchPredicate, cursorPredicate))
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
        organizationCountryCode: row.organizationCountryCode,
        categorySlug: row.categorySlug,
        providerKind: row.providerKind,
        priceInCents: row.priceInCents,
        currency: row.currency,
        minimumOrderQuantity: row.minimumOrderQuantity,
        relevanceScore: row.relevanceScore,
      })),
      page: { nextCursor, hasMore: nextCursor !== null },
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
        .select({ name: commerceProductVariant.name })
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
        searchText,
        isEligible,
        updatedAt: new Date(),
      },
    });
}

/** Recompute eligibility for every search document owned by an organization. */
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
