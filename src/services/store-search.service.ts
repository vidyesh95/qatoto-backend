import { and, asc, desc, eq, gt, ilike, or, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceCategory,
  commerceOrganization,
  commerceProviderProfile,
  commerceServiceOffering,
  product,
  productPricingTier,
  storeSearchDocument,
} from "#src/db/schema.js";
import { decodeStoreCursor, encodeStoreCursor } from "#src/lib/store-cursor.js";
import type { Result } from "#src/types/index.js";

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
}

export type StoreSearchError = { type: "INVALID_CURSOR" };

type StoreProviderKind = NonNullable<(typeof storeSearchDocument.$inferSelect)["providerKind"]>;

export async function searchStoreDocuments(input: {
  readonly query?: string | undefined;
  readonly categorySlug?: string | undefined;
  readonly sellerCountryCode?: string | undefined;
  readonly providerKind?: StoreProviderKind | undefined;
  readonly documentKind?: StoreSearchDocumentKind | undefined;
  readonly minOrderQuantityMax?: number | undefined;
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
  const decodedCursor =
    input.cursor === undefined ? null : decodeStoreCursor(input.cursor);
  if (input.cursor !== undefined && decodedCursor === null) {
    return { success: false, error: { type: "INVALID_CURSOR" } };
  }

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

  const filters = [
    eq(storeSearchDocument.isEligible, true),
    input.documentKind === undefined
      ? undefined
      : eq(storeSearchDocument.documentKind, input.documentKind),
    input.categorySlug === undefined
      ? undefined
      : eq(storeSearchDocument.categorySlug, input.categorySlug),
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
    input.query === undefined || input.query.trim().length === 0
      ? undefined
      : ilike(storeSearchDocument.searchText, `%${input.query.trim()}%`),
    cursorPredicate,
  ];

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
    .where(and(...filters))
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
      })),
      page: { nextCursor, hasMore: nextCursor !== null },
    },
  };
}

export async function refreshProductSearchDocument(
  productId: string,
): Promise<void> {
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
    .innerJoin(
      commerceOrganization,
      eq(commerceOrganization.id, product.sellerOrganizationId),
    )
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

  const isEligible =
    row.status === "active" &&
    row.moderationState === "approved" &&
    row.organizationTradeState === "active" &&
    row.organizationVisibility === "public" &&
    row.categoryState === "active" &&
    row.categoryId !== null;

  const searchText = [row.title, row.brand, row.description, row.organizationDisplayName]
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
      priceInCents: row.priceInCents,
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
        priceInCents: row.priceInCents,
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

  const isEligible =
    row.state === "active" &&
    row.organizationTradeState === "active" &&
    row.organizationVisibility === "public" &&
    row.profileVerificationState !== "rejected" &&
    row.profileVerificationState !== "suspended";

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
export async function refreshOrganizationSearchEligibility(
  organizationId: string,
): Promise<void> {
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

/** Newest eligible product cards for algorithmic rails. */
export async function listNewestEligibleSearchProducts(limit: number): Promise<
  readonly {
    readonly entityId: string;
    readonly publicSlug: string;
    readonly title: string;
  }[]
> {
  return db
    .select({
      entityId: storeSearchDocument.entityId,
      publicSlug: storeSearchDocument.publicSlug,
      title: storeSearchDocument.title,
    })
    .from(storeSearchDocument)
    .where(
      and(
        eq(storeSearchDocument.isEligible, true),
        eq(storeSearchDocument.documentKind, "product"),
      ),
    )
    .orderBy(desc(storeSearchDocument.publishedAt), asc(storeSearchDocument.id))
    .limit(limit);
}
