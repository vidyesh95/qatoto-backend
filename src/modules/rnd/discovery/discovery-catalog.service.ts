import { and, asc, desc, eq, isNotNull, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  demandSignalSnapshot,
  discoveryRegion,
  discoverySkill,
  marketInsight,
  researchCategory,
} from "#src/db/schema.js";

/**
 * The knowledge hub's read side: the region and skill lookups, the market-insight cards,
 * and the demand-signal leaderboard (R_AND_D_BACKEND_STRUCTURE.md §6, §11b).
 *
 * EVERY FIGURE HERE IS A RAW INTEGER IN A NAMED UNIT (§1). The mocks ship pre-formatted
 * display strings — `"+34%"`, `"68M people"`, `"3× coverage"` — which cannot be sorted,
 * summed, or localized, and which ship USD and English to every device on earth. Three
 * first-class clients format these themselves.
 *
 * NONE of these functions returns a `Result`: a list with no rows is a SUCCESSFUL EMPTY
 * LIST, not a failure, and an unknown filter value yields an empty page rather than a 404
 * — a facet that 404s leaks which slugs exist and breaks the client's "no results" state.
 */

// --- Shared reference projections, so a category or region renders identically
//     everywhere it appears nested.

export interface DiscoveryCategoryRef {
  readonly id: string;
  readonly slug: string;
  readonly displayLabel: string;
  readonly pinIconKey: (typeof researchCategory.$inferSelect)["pinIconKey"];
}

export interface DiscoveryRegionRef {
  readonly id: string;
  readonly slug: string;
  readonly displayLabel: string;
  readonly kind: (typeof discoveryRegion.$inferSelect)["kind"];
  readonly countryCode: string | null;
  readonly parentRegionId: string | null;
}

export const DISCOVERY_CATEGORY_REF_COLUMNS = {
  id: researchCategory.id,
  slug: researchCategory.slug,
  displayLabel: researchCategory.label,
  pinIconKey: researchCategory.pinIconKey,
} as const;

export const DISCOVERY_REGION_REF_COLUMNS = {
  id: discoveryRegion.id,
  slug: discoveryRegion.slug,
  displayLabel: discoveryRegion.label,
  kind: discoveryRegion.kind,
  countryCode: discoveryRegion.countryCode,
  parentRegionId: discoveryRegion.parentRegionId,
} as const;

export interface DiscoverySkillView {
  readonly id: string;
  readonly slug: string;
  readonly displayLabel: string;
  readonly categoryId: string | null;
}

/**
 * Every region, unpaginated.
 *
 * §11b groups regions with insights and demand signals under a shared `?page=`, but that
 * is shorthand for the group: this is a small lookup table whose only job is to source a
 * `<select>`. Paginating a facet list forces every client to loop before it can render a
 * dropdown, so this returns an ApiResponse rather than a PaginatedResponse — the same
 * call `listResearchCategories` already makes.
 *
 * Ordered by kind then label so the tree renders grouped without a client-side sort, and
 * ending in the unique id per §4c rule 4.
 */
export async function listDiscoveryRegions(
  countryCode?: string,
): Promise<readonly DiscoveryRegionRef[]> {
  const whereClause = countryCode ? eq(discoveryRegion.countryCode, countryCode) : undefined;

  return db
    .select(DISCOVERY_REGION_REF_COLUMNS)
    .from(discoveryRegion)
    .where(whereClause)
    .orderBy(asc(discoveryRegion.kind), asc(discoveryRegion.label), asc(discoveryRegion.id));
}

/**
 * Every active skill, unpaginated, for the talent filter chips.
 *
 * These slugs are what the `?skill=` filter matches BY EQUALITY, which is the structural
 * fix for the live substring bug in `talent-filter-grid.tsx` where a "Water" chip matches
 * "Water Polo".
 */
export async function listDiscoverySkills(): Promise<readonly DiscoverySkillView[]> {
  return db
    .select({
      id: discoverySkill.id,
      slug: discoverySkill.slug,
      displayLabel: discoverySkill.label,
      categoryId: discoverySkill.categoryId,
    })
    .from(discoverySkill)
    .where(eq(discoverySkill.isActive, true))
    .orderBy(asc(discoverySkill.label), asc(discoverySkill.id));
}

export interface MarketInsightView {
  readonly id: string;
  readonly headline: string;
  readonly summary: string | null;
  /** What SORT of magnitude this is — see the schema's marketInsightStatKindEnum. */
  readonly statKind: (typeof marketInsight.$inferSelect)["statKind"];
  /**
   * The magnitude × 1000. `"+34%"` is `34000`; `"250K tonnes"` is `250_000_000`.
   *
   * Milli-units rather than whole units so a client can render one decimal place without
   * the server having decided how many to show.
   */
  readonly statValueMilli: number;
  readonly statUnitKey: (typeof marketInsight.$inferSelect)["statUnitKey"];
  readonly trendDirection: (typeof marketInsight.$inferSelect)["trendDirection"];
  readonly category: DiscoveryCategoryRef;
  readonly region: DiscoveryRegionRef;
  /** `sourceNote` split into three (§15) — an attribution, a citation and a date. */
  readonly sourceName: string;
  readonly sourceUrl: string | null;
  /** ISO-8601 date-only, `YYYY-MM-DD`. */
  readonly sourcePublishedDate: string;
  /** ISO-8601 UTC. */
  readonly publishedAt: string;
}

export interface MarketInsightFilter {
  readonly regionSlug?: string;
  readonly categorySlug?: string;
  readonly statKind?: (typeof marketInsight.$inferSelect)["statKind"];
  readonly page: number;
  readonly limit: number;
}

export interface MarketInsightPage {
  readonly rows: readonly MarketInsightView[];
  readonly total: number;
}

/**
 * The one projection both the list and the detail read select. Stated once because the two
 * must not drift: a chip on a project's Overview tab and the row behind it on the knowledge
 * hub are the same insight, and a field present on one and absent on the other reads to a
 * client as a data problem rather than the two-queries problem it is.
 */
const MARKET_INSIGHT_VIEW_COLUMNS = {
  id: marketInsight.id,
  headline: marketInsight.headline,
  summary: marketInsight.summary,
  statKind: marketInsight.statKind,
  statValueMilli: marketInsight.statValueMilli,
  statUnitKey: marketInsight.statUnitKey,
  trendDirection: marketInsight.trendDirection,
  category: DISCOVERY_CATEGORY_REF_COLUMNS,
  region: DISCOVERY_REGION_REF_COLUMNS,
  sourceName: marketInsight.sourceName,
  sourceUrl: marketInsight.sourceUrl,
  sourcePublishedDate: marketInsight.sourcePublishedDate,
  publishedAt: marketInsight.publishedAt,
} as const;

/**
 * `publishedAt` is nullable on the column and NOT NULL on the wire, because every read here
 * filters `IS NOT NULL`. A null reaching this function means the query and the projection
 * have drifted apart. Throw rather than substitute a fallback: a fabricated epoch would ship
 * "Jan 1 1970" to three clients and look like a data problem rather than the code problem it
 * actually is (CLAUDE.md §3.3 — unrecoverable programmer error).
 */
function toMarketInsightView(
  row: { readonly publishedAt: Date | null } & Omit<MarketInsightView, "publishedAt">,
  caller: string,
): MarketInsightView {
  if (row.publishedAt === null) {
    throw new Error(
      `${caller}: insight ${row.id} passed the published filter with a null publishedAt`,
    );
  }
  return { ...row, publishedAt: row.publishedAt.toISOString() };
}

/**
 * Published market insights, newest first.
 *
 * Only rows with a non-null `publishedAt` are visible: an unpublished draft is editorial
 * work in progress, and the partial index this query rides is declared on exactly that
 * predicate.
 */
export async function listMarketInsights(filter: MarketInsightFilter): Promise<MarketInsightPage> {
  const conditions = [isNotNull(marketInsight.publishedAt)];
  if (filter.regionSlug) conditions.push(eq(discoveryRegion.slug, filter.regionSlug));
  if (filter.categorySlug) conditions.push(eq(researchCategory.slug, filter.categorySlug));
  if (filter.statKind) conditions.push(eq(marketInsight.statKind, filter.statKind));

  const whereClause = and(...conditions);

  const [rows, [totalRow]] = await Promise.all([
    db
      .select(MARKET_INSIGHT_VIEW_COLUMNS)
      .from(marketInsight)
      .innerJoin(researchCategory, eq(marketInsight.categoryId, researchCategory.id))
      .innerJoin(discoveryRegion, eq(marketInsight.regionId, discoveryRegion.id))
      .where(whereClause)
      // Ends in the unique id, so a page boundary can neither duplicate nor skip a row.
      .orderBy(desc(marketInsight.publishedAt), desc(marketInsight.id))
      .limit(filter.limit)
      .offset((filter.page - 1) * filter.limit),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(marketInsight)
      .innerJoin(researchCategory, eq(marketInsight.categoryId, researchCategory.id))
      .innerJoin(discoveryRegion, eq(marketInsight.regionId, discoveryRegion.id))
      .where(whereClause),
  ]);

  return {
    rows: rows.map((row) => toMarketInsightView(row, "listMarketInsights")),
    total: totalRow?.total ?? 0,
  };
}

/**
 * One published market insight.
 *
 * The read behind a demand-evidence chip (§11k.2). A chip cites an insight so a reader can
 * check it; without this the citation is a headline the reader cannot open, which is worse
 * than not citing at all.
 *
 * **Published-only, and the filter is the authorization.** An unpublished draft is a
 * moderator's work in progress and reads as absent here — `/discovery/admin/market-insights`
 * is where a draft is visible, behind a platform capability. `/unpublish` moving a cited
 * insight back to NULL therefore closes this read too, which is deliberate: the chip goes
 * dark rather than the draft leaking (§11k, the post-citation unpublish window).
 *
 * Returns `null` rather than a `Result` — the whole of this file does, and the controller
 * synthesizes the 404 (see this module's header).
 */
export async function findMarketInsight(insightId: string): Promise<MarketInsightView | null> {
  const [row] = await db
    .select(MARKET_INSIGHT_VIEW_COLUMNS)
    .from(marketInsight)
    .innerJoin(researchCategory, eq(marketInsight.categoryId, researchCategory.id))
    .innerJoin(discoveryRegion, eq(marketInsight.regionId, discoveryRegion.id))
    .where(and(eq(marketInsight.id, insightId), isNotNull(marketInsight.publishedAt)))
    .limit(1);

  return row ? toMarketInsightView(row, "findMarketInsight") : null;
}

export interface DemandSignalView {
  readonly rank: number;
  readonly category: DiscoveryCategoryRef;
  readonly region: DiscoveryRegionRef;
  /** Integer, range 0..100. */
  readonly demandScorePoints: number;
  readonly previousDemandScorePoints: number | null;
  readonly trendDirection: (typeof demandSignalSnapshot.$inferSelect)["trendDirection"];
  readonly clusterCount: number;
  readonly distinctReporterCount: number;
  readonly relatedProjectCount: number;
  readonly openRoleCount: number;
  /**
   * The store's evidence for this cell: units sold and visible reviews in the window, on
   * listings the cell's ventures actually shipped.
   *
   * NOT part of `demandScorePoints`, deliberately — see `ScoredDemandCell` in
   * `recompute-demand-signals.ts` for why the weighting question was left open. A reader can
   * see them and weigh them; the rank does not.
   *
   * 0 is a real zero on every row written before this landed: nothing looked, so nothing was
   * attributed. It is not a null dressed up as a number.
   */
  readonly soldUnitCount: number;
  readonly productReviewCount: number;
  /** ISO-8601 UTC. Returned so clients render "as of" and never imply live numbers. */
  readonly asOf: string;
}

export interface DemandSignalFilter {
  readonly regionSlug?: string;
  readonly categorySlug?: string;
  readonly page: number;
  readonly limit: number;
}

export interface DemandSignalPage {
  readonly rows: readonly DemandSignalView[];
  readonly total: number;
  /** NULL when no run has ever completed — the leaderboard is empty, not zeroed. */
  readonly asOf: string | null;
}

/**
 * The demand leaderboard for the MOST RECENT completed run.
 *
 * RESOLVING `MAX(asOf)` FIRST IS LOAD-BEARING, not an optimization. Without it a query
 * running while tonight's job is mid-insert interleaves last night's rows with tonight's
 * and shows two rank-3s. Pinning one `asOf` makes the leaderboard internally consistent
 * even mid-run, and the job's single-transaction insert means a pinned run is always
 * whole.
 */
export async function listDemandSignals(filter: DemandSignalFilter): Promise<DemandSignalPage> {
  const [latestRun] = await db
    .select({ asOf: demandSignalSnapshot.asOf })
    .from(demandSignalSnapshot)
    .orderBy(desc(demandSignalSnapshot.asOf))
    .limit(1);

  if (!latestRun) {
    return { rows: [], total: 0, asOf: null };
  }

  const conditions = [eq(demandSignalSnapshot.asOf, latestRun.asOf)];
  if (filter.regionSlug) conditions.push(eq(discoveryRegion.slug, filter.regionSlug));
  if (filter.categorySlug) conditions.push(eq(researchCategory.slug, filter.categorySlug));

  const whereClause = and(...conditions);

  const [rows, [totalRow]] = await Promise.all([
    db
      .select({
        rank: demandSignalSnapshot.rank,
        category: DISCOVERY_CATEGORY_REF_COLUMNS,
        region: DISCOVERY_REGION_REF_COLUMNS,
        demandScorePoints: demandSignalSnapshot.demandScorePoints,
        previousDemandScorePoints: demandSignalSnapshot.previousDemandScorePoints,
        trendDirection: demandSignalSnapshot.trendDirection,
        clusterCount: demandSignalSnapshot.clusterCount,
        distinctReporterCount: demandSignalSnapshot.distinctReporterCount,
        relatedProjectCount: demandSignalSnapshot.relatedProjectCount,
        openRoleCount: demandSignalSnapshot.openRoleCount,
        soldUnitCount: demandSignalSnapshot.soldUnitCount,
        productReviewCount: demandSignalSnapshot.productReviewCount,
        asOf: demandSignalSnapshot.asOf,
      })
      .from(demandSignalSnapshot)
      .innerJoin(researchCategory, eq(demandSignalSnapshot.categoryId, researchCategory.id))
      .innerJoin(discoveryRegion, eq(demandSignalSnapshot.regionId, discoveryRegion.id))
      .where(whereClause)
      // `rank` is unique within an asOf (demand_signal_snapshot_asOf_rank_unq), so this
      // ordering is already total — the id is belt-and-braces against a future schema
      // change dropping that index.
      .orderBy(asc(demandSignalSnapshot.rank), asc(demandSignalSnapshot.id))
      .limit(filter.limit)
      .offset((filter.page - 1) * filter.limit),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(demandSignalSnapshot)
      .innerJoin(researchCategory, eq(demandSignalSnapshot.categoryId, researchCategory.id))
      .innerJoin(discoveryRegion, eq(demandSignalSnapshot.regionId, discoveryRegion.id))
      .where(whereClause),
  ]);

  return {
    rows: rows.map((row) => ({ ...row, asOf: row.asOf.toISOString() })),
    total: totalRow?.total ?? 0,
    asOf: latestRun.asOf.toISOString(),
  };
}
