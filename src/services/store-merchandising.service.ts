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
import * as storeCatalogService from "#src/services/store-catalog.service.js";
import * as storeSearchService from "#src/services/store-search.service.js";
import type { Result } from "#src/types/index.js";

export type StoreMerchandisingError =
  | { type: "NOT_FOUND" }
  | { type: "INVALID_CURSOR" };

function merchandisingWindowOpen<
  TTable extends {
    readonly startsAt: unknown;
    readonly endsAt: unknown;
  },
>(table: TTable) {
  return sql`(
    (${table.startsAt} IS NULL OR ${table.startsAt} <= now())
    AND (${table.endsAt} IS NULL OR ${table.endsAt} > now())
  )`;
}

export async function getStoreHome(): Promise<{
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
  readonly rails: readonly {
    readonly slug: string;
    readonly title: string;
    readonly strategy: string;
    readonly items: readonly {
      readonly entityKind: string;
      readonly entityId: string;
      readonly publicSlug?: string;
      readonly title?: string;
    }[];
  }[];
}> {
  const [heroSlides, categoriesResult, pathways, rails] = await Promise.all([
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
  ]);

  const railProjections = await Promise.all(
    rails.map(async (rail) => {
      const items = await resolveRailItems(rail.id, rail.strategy, 12);
      return {
        slug: rail.slug,
        title: rail.title,
        strategy: rail.strategy,
        items,
      };
    }),
  );

  return {
    heroSlides,
    categories: categoriesResult.items,
    pathways,
    rails: railProjections,
  };
}

async function resolveRailItems(
  railId: string,
  strategy: (typeof storeRail.$inferSelect)["strategy"],
  limit: number,
): Promise<
  readonly {
    readonly entityKind: string;
    readonly entityId: string;
    readonly publicSlug?: string;
    readonly title?: string;
  }[]
> {
  switch (strategy) {
    case "curated": {
      const placements = await db
        .select({
          entityKind: storeRailPlacement.entityKind,
          entityId: storeRailPlacement.entityId,
        })
        .from(storeRailPlacement)
        .where(
          and(
            eq(storeRailPlacement.railId, railId),
            sql`(
              (${storeRailPlacement.startsAt} IS NULL OR ${storeRailPlacement.startsAt} <= now())
              AND (${storeRailPlacement.endsAt} IS NULL OR ${storeRailPlacement.endsAt} > now())
            )`,
          ),
        )
        .orderBy(asc(storeRailPlacement.position), asc(storeRailPlacement.id))
        .limit(limit);
      return placements;
    }
    case "newest": {
      const newest = await storeSearchService.listNewestEligibleSearchProducts(limit);
      return newest.map((item) => ({
        entityKind: "product" as const,
        entityId: item.entityId,
        publicSlug: item.publicSlug,
        title: item.title,
      }));
    }
    case "trending_placeholder":
      return [];
    default: {
      const exhaustiveStrategy: never = strategy;
      void exhaustiveStrategy;
      return [];
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
      readonly items: readonly {
        readonly entityKind: string;
        readonly entityId: string;
        readonly position: number;
      }[];
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

  const items = await db
    .select({
      entityKind: storePathwayItem.entityKind,
      entityId: storePathwayItem.entityId,
      position: storePathwayItem.position,
    })
    .from(storePathwayItem)
    .where(eq(storePathwayItem.pathwayId, pathway.id))
    .orderBy(asc(storePathwayItem.position), asc(storePathwayItem.id));

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
      readonly items: readonly {
        readonly entityKind: string;
        readonly entityId: string;
        readonly publicSlug?: string;
        readonly title?: string;
      }[];
      readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
    },
    StoreMerchandisingError
  >
> {
  const decodedCursor =
    input.cursor === undefined ? null : decodeStoreCursor(input.cursor);
  if (input.cursor !== undefined && decodedCursor === null) {
    return { success: false, error: { type: "INVALID_CURSOR" } };
  }

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

  if (rail.strategy === "curated") {
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
          eq(storeRailPlacement.railId, rail.id),
          sql`(
            (${storeRailPlacement.startsAt} IS NULL OR ${storeRailPlacement.startsAt} <= now())
            AND (${storeRailPlacement.endsAt} IS NULL OR ${storeRailPlacement.endsAt} > now())
          )`,
          cursorPredicate,
        ),
      )
      .orderBy(asc(storeRailPlacement.position), asc(storeRailPlacement.id))
      .limit(input.limit + 1);

    const pageRows = rows.slice(0, input.limit);
    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor =
      rows.length > input.limit && lastRow
        ? encodeStoreCursor({
            sortKey: String(lastRow.position),
            id: lastRow.id,
          })
        : null;

    return {
      success: true,
      value: {
        rail: { slug: rail.slug, title: rail.title, strategy: rail.strategy },
        items: pageRows.map((row) => ({
          entityKind: row.entityKind,
          entityId: row.entityId,
        })),
        page: { nextCursor, hasMore: nextCursor !== null },
      },
    };
  }

  const items = await resolveRailItems(rail.id, rail.strategy, input.limit);
  return {
    success: true,
    value: {
      rail: { slug: rail.slug, title: rail.title, strategy: rail.strategy },
      items,
      page: { nextCursor: null, hasMore: false },
    },
  };
}
