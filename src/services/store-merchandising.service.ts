import { and, asc, eq, or, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  storeHeroSlide,
  storePathway,
  storePathwayItem,
  storeRail,
  storeRailPlacement,
} from "#src/db/schema.js";
import { decodeStoreCursor, encodeStoreCursor } from "#src/lib/store-cursor.js";
import * as commerceProvidersService from "#src/services/commerce-providers.service.js";
import * as storeCatalogService from "#src/services/store-catalog.service.js";
import * as storeSearchService from "#src/services/store-search.service.js";
import type { Result } from "#src/types/index.js";

export type StoreMerchandisingError =
  | { type: "NOT_FOUND" }
  | { type: "INVALID_CURSOR" }
  | { type: "PROVIDER_DIRECTORY_FAILED" };

export type MerchandisingItemProjection =
  | {
      readonly entityKind: "product";
      readonly entityId: string;
      readonly product: storeCatalogService.StoreProductCardProjection;
    }
  | {
      readonly entityKind: "provider_offering";
      readonly entityId: string;
      readonly offering: commerceProvidersService.PublicOfferingCard;
      readonly provider: commerceProvidersService.PublicProviderCard;
    }
  /**
   * A19. `store_merchandising_entity_kind` has admitted these two since Phase 1 and
   * the projection dropped them silently, so a merchandiser could place a category
   * in a rail and see nothing rendered and no error raised.
   */
  | {
      readonly entityKind: "category";
      readonly entityId: string;
      readonly category: storeCatalogService.StoreCategoryProjection;
    }
  | {
      readonly entityKind: "organization";
      readonly entityId: string;
      readonly organization: storeCatalogService.StoreSellerProjection;
    };

function merchandisingWindowOpen(table: { readonly startsAt: unknown; readonly endsAt: unknown }) {
  return sql`(
    (${table.startsAt} IS NULL OR ${table.startsAt} <= now())
    AND (${table.endsAt} IS NULL OR ${table.endsAt} > now())
  )`;
}

async function resolveEligibleMerchandisingItems(
  placements: readonly {
    readonly entityKind: "product" | "category" | "organization" | "provider_offering";
    readonly entityId: string;
  }[],
): Promise<readonly MerchandisingItemProjection[]> {
  const productIds = placements
    .filter((placement) => placement.entityKind === "product")
    .map((placement) => placement.entityId);
  const offeringIds = placements
    .filter((placement) => placement.entityKind === "provider_offering")
    .map((placement) => placement.entityId);
  const categoryIds = placements
    .filter((placement) => placement.entityKind === "category")
    .map((placement) => placement.entityId);
  const organizationIds = placements
    .filter((placement) => placement.entityKind === "organization")
    .map((placement) => placement.entityId);

  const [products, offerings, categories, organizations] = await Promise.all([
    storeCatalogService.resolveEligibleProductCardsByIds(productIds),
    commerceProvidersService.resolveEligiblePublicOfferingsByIds(offeringIds),
    storeCatalogService.resolveEligibleCategoriesByIds(categoryIds),
    storeCatalogService.resolveEligibleOrganizationCardsByIds(organizationIds),
  ]);

  const productsById = new Map(products.map((productCard) => [productCard.id, productCard]));
  const offeringsById = new Map(offerings.map((entry) => [entry.offering.id, entry]));
  const categoriesById = new Map(categories.map((category) => [category.id, category]));
  const organizationsById = new Map(
    organizations.map((organization) => [organization.organizationId, organization]),
  );

  const resolved: MerchandisingItemProjection[] = [];
  for (const placement of placements) {
    switch (placement.entityKind) {
      case "product": {
        const productCard = productsById.get(placement.entityId);
        if (productCard === undefined) break;
        resolved.push({
          entityKind: "product",
          entityId: placement.entityId,
          product: productCard,
        });
        break;
      }
      case "provider_offering": {
        const offeringEntry = offeringsById.get(placement.entityId);
        if (offeringEntry === undefined) break;
        resolved.push({
          entityKind: "provider_offering",
          entityId: placement.entityId,
          offering: offeringEntry.offering,
          provider: offeringEntry.provider,
        });
        break;
      }
      case "category": {
        const category = categoriesById.get(placement.entityId);
        if (category === undefined) break;
        resolved.push({
          entityKind: "category",
          entityId: placement.entityId,
          category,
        });
        break;
      }
      case "organization": {
        const organization = organizationsById.get(placement.entityId);
        if (organization === undefined) break;
        resolved.push({
          entityKind: "organization",
          entityId: placement.entityId,
          organization,
        });
        break;
      }
      default: {
        const exhaustiveKind: never = placement.entityKind;
        void exhaustiveKind;
        break;
      }
    }
  }
  return resolved;
}

export async function getStoreHome(): Promise<
  Result<
    {
      readonly heroSlides: readonly {
        readonly id: string;
        readonly title: string;
        readonly subtitle: string | null;
        readonly accent: string;
        readonly imageUrl: string | null;
        readonly linkTargetKind: string | null;
        readonly linkTargetSlug: string | null;
      }[];
      readonly categories: Awaited<
        ReturnType<typeof storeCatalogService.listActiveCategories>
      >["items"];
      readonly pathways: readonly {
        readonly id: string;
        readonly slug: string;
        readonly title: string;
        readonly summary: string | null;
        readonly accent: string;
      }[];
      readonly providerShortcuts: readonly commerceProvidersService.PublicProviderCard[];
      readonly rails: readonly {
        readonly slug: string;
        readonly title: string;
        readonly strategy: string;
        readonly items: readonly MerchandisingItemProjection[];
      }[];
    },
    StoreMerchandisingError
  >
> {
  const [heroSlides, categoriesResult, pathways, rails, providersResult] = await Promise.all([
    db
      .select({
        id: storeHeroSlide.id,
        title: storeHeroSlide.title,
        subtitle: storeHeroSlide.subtitle,
        accent: storeHeroSlide.accent,
        imageUrl: storeHeroSlide.imageUrl,
        linkTargetKind: storeHeroSlide.linkTargetKind,
        linkTargetSlug: storeHeroSlide.linkTargetSlug,
      })
      .from(storeHeroSlide)
      .where(and(eq(storeHeroSlide.state, "active"), merchandisingWindowOpen(storeHeroSlide)))
      .orderBy(asc(storeHeroSlide.siblingOrder), asc(storeHeroSlide.id))
      .limit(12),
    storeCatalogService.listActiveCategories({ parentCategoryId: null }),
    db
      .select({
        id: storePathway.id,
        slug: storePathway.slug,
        title: storePathway.title,
        summary: storePathway.summary,
        accent: storePathway.accent,
      })
      .from(storePathway)
      .where(and(eq(storePathway.state, "active"), merchandisingWindowOpen(storePathway)))
      .orderBy(asc(storePathway.title), asc(storePathway.id))
      .limit(24),
    db
      .select({
        id: storeRail.id,
        slug: storeRail.slug,
        title: storeRail.title,
        strategy: storeRail.strategy,
      })
      .from(storeRail)
      .where(and(eq(storeRail.state, "active"), merchandisingWindowOpen(storeRail)))
      .orderBy(asc(storeRail.title), asc(storeRail.id))
      .limit(12),
    commerceProvidersService.listPublicProviders({ limit: 8 }),
  ]);

  if (!providersResult.success) {
    return { success: false, error: { type: "PROVIDER_DIRECTORY_FAILED" } };
  }

  const railProjections = await Promise.all(
    rails.map(async (rail) => {
      const itemsResult = await resolveRailItemsPage({
        railId: rail.id,
        strategy: rail.strategy,
        limit: 12,
      });
      return {
        slug: rail.slug,
        title: rail.title,
        strategy: rail.strategy,
        items: itemsResult.items,
      };
    }),
  );

  return {
    success: true,
    value: {
      heroSlides,
      categories: categoriesResult.items,
      pathways,
      providerShortcuts: providersResult.value.items,
      rails: railProjections,
    },
  };
}

async function resolveRailItemsPage(input: {
  readonly railId: string;
  readonly strategy: (typeof storeRail.$inferSelect)["strategy"];
  readonly limit: number;
  readonly cursor?: string | undefined;
}): Promise<{
  readonly items: readonly MerchandisingItemProjection[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
  readonly error?: StoreMerchandisingError;
}> {
  switch (input.strategy) {
    case "curated": {
      const decodedCursor = input.cursor === undefined ? null : decodeStoreCursor(input.cursor);
      if (input.cursor !== undefined && decodedCursor === null) {
        return {
          items: [],
          page: { nextCursor: null, hasMore: false },
          error: { type: "INVALID_CURSOR" },
        };
      }

      // Over-fetch then filter ineligible placements so the page stays dense.
      const fetchLimit = Math.min(input.limit * 4, 96);
      const cursorPredicate =
        decodedCursor === null
          ? undefined
          : or(
              sql`${storeRailPlacement.position} > ${Number(decodedCursor.sortKey)}`,
              and(
                eq(storeRailPlacement.position, Number(decodedCursor.sortKey)),
                sql`${storeRailPlacement.id} > ${decodedCursor.id}`,
              ),
            );

      const rows = await db
        .select({
          id: storeRailPlacement.id,
          entityKind: storeRailPlacement.entityKind,
          entityId: storeRailPlacement.entityId,
          position: storeRailPlacement.position,
        })
        .from(storeRailPlacement)
        .where(
          and(
            eq(storeRailPlacement.railId, input.railId),
            sql`(
              (${storeRailPlacement.startsAt} IS NULL OR ${storeRailPlacement.startsAt} <= now())
              AND (${storeRailPlacement.endsAt} IS NULL OR ${storeRailPlacement.endsAt} > now())
            )`,
            cursorPredicate,
          ),
        )
        .orderBy(asc(storeRailPlacement.position), asc(storeRailPlacement.id))
        .limit(fetchLimit);

      const resolved = await resolveEligibleMerchandisingItems(rows);
      const pageItems = resolved.slice(0, input.limit);
      const lastIncludedPlacement = rows.find(
        (row) => pageItems[pageItems.length - 1]?.entityId === row.entityId,
      );
      const scannedPastPage = rows.length > 0 && resolved.length > input.limit;
      const nextCursor =
        scannedPastPage && lastIncludedPlacement
          ? encodeStoreCursor({
              sortKey: String(lastIncludedPlacement.position),
              id: lastIncludedPlacement.id,
            })
          : null;

      return {
        items: pageItems,
        page: { nextCursor, hasMore: nextCursor !== null },
      };
    }
    case "newest": {
      const newestResult = await storeSearchService.listNewestEligibleSearchProducts({
        limit: input.limit,
        cursor: input.cursor,
      });
      if (!newestResult.success) {
        return {
          items: [],
          page: { nextCursor: null, hasMore: false },
          error: { type: "INVALID_CURSOR" },
        };
      }
      const products = await storeCatalogService.resolveEligibleProductCardsByIds(
        newestResult.value.items.map((item) => item.entityId),
      );
      return {
        items: products.map((product) => ({
          entityKind: "product" as const,
          entityId: product.id,
          product,
        })),
        page: newestResult.value.page,
      };
    }
    case "trending_placeholder":
      return {
        items: [],
        page: { nextCursor: null, hasMore: false },
      };
    default: {
      const exhaustiveStrategy: never = input.strategy;
      void exhaustiveStrategy;
      return {
        items: [],
        page: { nextCursor: null, hasMore: false },
      };
    }
  }
}

export async function listPathways(): Promise<{
  readonly items: readonly {
    readonly id: string;
    readonly slug: string;
    readonly title: string;
    readonly summary: string | null;
    readonly accent: string;
  }[];
}> {
  const items = await db
    .select({
      id: storePathway.id,
      slug: storePathway.slug,
      title: storePathway.title,
      summary: storePathway.summary,
      accent: storePathway.accent,
    })
    .from(storePathway)
    .where(and(eq(storePathway.state, "active"), merchandisingWindowOpen(storePathway)))
    .orderBy(asc(storePathway.title), asc(storePathway.id));
  return { items };
}

export async function getPathwayBySlug(pathwaySlug: string): Promise<
  Result<
    {
      readonly pathway: {
        readonly id: string;
        readonly slug: string;
        readonly title: string;
        readonly summary: string | null;
        readonly accent: string;
      };
      readonly items: readonly MerchandisingItemProjection[];
    },
    StoreMerchandisingError
  >
> {
  const [pathway] = await db
    .select({
      id: storePathway.id,
      slug: storePathway.slug,
      title: storePathway.title,
      summary: storePathway.summary,
      accent: storePathway.accent,
    })
    .from(storePathway)
    .where(
      and(
        eq(storePathway.slug, pathwaySlug),
        eq(storePathway.state, "active"),
        merchandisingWindowOpen(storePathway),
      ),
    )
    .limit(1);

  if (!pathway) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }

  const placements = await db
    .select({
      entityKind: storePathwayItem.entityKind,
      entityId: storePathwayItem.entityId,
      position: storePathwayItem.position,
    })
    .from(storePathwayItem)
    // A19: pathway items now carry the same scheduling window rail placements have
    // had since Phase 1, so a seasonal member can be scheduled in and out.
    .where(
      and(eq(storePathwayItem.pathwayId, pathway.id), merchandisingWindowOpen(storePathwayItem)),
    )
    .orderBy(asc(storePathwayItem.position), asc(storePathwayItem.id));

  const items = await resolveEligibleMerchandisingItems(placements);
  return { success: true, value: { pathway, items } };
}

export async function getRailBySlug(input: {
  readonly railSlug: string;
  readonly limit: number;
  readonly cursor?: string | undefined;
}): Promise<
  Result<
    {
      readonly rail: {
        readonly slug: string;
        readonly title: string;
        readonly strategy: string;
      };
      readonly items: readonly MerchandisingItemProjection[];
      readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
    },
    StoreMerchandisingError
  >
> {
  const [rail] = await db
    .select({
      id: storeRail.id,
      slug: storeRail.slug,
      title: storeRail.title,
      strategy: storeRail.strategy,
    })
    .from(storeRail)
    .where(
      and(
        eq(storeRail.slug, input.railSlug),
        eq(storeRail.state, "active"),
        merchandisingWindowOpen(storeRail),
      ),
    )
    .limit(1);

  if (!rail) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }

  const resolved = await resolveRailItemsPage({
    railId: rail.id,
    strategy: rail.strategy,
    limit: input.limit,
    cursor: input.cursor,
  });
  if (resolved.error !== undefined) {
    return { success: false, error: resolved.error };
  }

  return {
    success: true,
    value: {
      rail: { slug: rail.slug, title: rail.title, strategy: rail.strategy },
      items: resolved.items,
      page: resolved.page,
    },
  };
}
