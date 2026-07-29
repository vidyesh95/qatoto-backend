import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { discoveryRegion, marketInsight, researchCategory } from "#src/db/schema.js";
import { findStatViolations, type MarketInsightStat } from "#src/lib/market-insight-stat.js";
import { isForeignKeyViolation } from "#src/lib/pg-errors.js";
import {
  DISCOVERY_CATEGORY_REF_COLUMNS,
  DISCOVERY_REGION_REF_COLUMNS,
  type DiscoveryCategoryRef,
  type DiscoveryRegionRef,
} from "#src/services/discovery-catalog.service.js";
import {
  requirePlatformCapability,
  type PlatformAccessError,
} from "#src/services/platform-role.service.js";
import type { Result } from "#src/types/index.js";

/**
 * Market-insight AUTHORING — the moderator surface §11b never got
 * (R_AND_D_BACKEND_STRUCTURE.md §6, §11j.1, §11j.4).
 *
 * THE DEAD END THIS CLOSES. `market_insight` shipped with two readers —
 * `GET /discovery/market-insights` and the landing rail — and NO WRITER ANYWHERE: no route,
 * no job, no seed. `db:seed-discovery-lookups` writes only `discovery_region` and
 * `discovery_skill`. So `/knowledge-hub` and the landing insights rail rendered empty on
 * every environment, permanently, and looked built from the outside.
 *
 * A SEPARATE FILE FROM `discovery-catalog.service.ts`, whose header states as an invariant
 * that NONE of its functions returns a `Result` — an empty directory is a successful empty
 * list there. Authoring is the opposite: every function is capability-gated and every
 * failure is a typed refusal. It imports that module's ref columns and view type, which is
 * the same direction `problem-clusters.service.ts` already depends.
 *
 * CAPABILITY FIRST, RESOURCE SECOND, in every function. Reversed, `/discovery/admin/
 * market-insights/:insightId` becomes an id oracle: anyone holding a session could
 * distinguish "that insight exists" from "it does not" by the status code without being
 * staff at all. `moderate_taxonomy` rather than `moderate_clusters` — an insight is authored
 * editorial content in the curated-vocabulary family, the same argument `suppliers.service.ts`
 * records for the directory.
 *
 * THE STAT QUAD IS PROVEN BEFORE EVERY WRITE. Three CHECK constraints govern it and
 * `pg-errors.ts` deliberately exposes no `isCheckViolation`, so a violation reaching
 * Postgres is a 500 with nothing to tell the caller. `findStatViolations` is the same
 * predicate the Zod schema runs, which is what keeps the two from drifting.
 */

export type MarketInsightError =
  | PlatformAccessError
  | { type: "MARKET_INSIGHT_NOT_FOUND"; insightId: string }
  // Payloads identical to the variants already declared in `talent-profiles.service.ts` and
  // `problem-clusters.service.ts` — two variants sharing a `type` literal must share a
  // shape, or the mapper's exhaustive switch cannot read the field.
  | { type: "REGION_NOT_FOUND"; regionId: string }
  | { type: "CATEGORY_NOT_FOUND"; categoryId: string }
  | { type: "CATEGORY_NOT_APPROVED"; categoryId: string }
  | { type: "ALREADY_PUBLISHED" }
  | { type: "NOT_PUBLISHED" }
  // §11k.2 made `market_insight` a referenced parent for the first time. See the delete.
  | { type: "MARKET_INSIGHT_CITED" };

/**
 * The moderator's view of a row, which the PUBLIC view cannot express.
 *
 * `MarketInsightView.publishedAt` is a non-null `string` and its projection THROWS on a null
 * — correct there, because the public query filters `publishedAt IS NOT NULL`. A draft is
 * exactly the row that violates that, so the admin view widens the field and adds the
 * authorship trail a moderator queue needs.
 */
export interface MarketInsightAdminView {
  readonly id: string;
  readonly headline: string;
  readonly summary: string | null;
  readonly statKind: (typeof marketInsight.$inferSelect)["statKind"];
  readonly statValueMilli: number;
  readonly statUnitKey: (typeof marketInsight.$inferSelect)["statUnitKey"];
  readonly trendDirection: (typeof marketInsight.$inferSelect)["trendDirection"];
  readonly category: DiscoveryCategoryRef;
  readonly region: DiscoveryRegionRef;
  readonly sourceName: string;
  readonly sourceUrl: string | null;
  readonly sourcePublishedDate: string;
  /** NULL means DRAFT. That is the whole difference from the public view. */
  readonly publishedAt: string | null;
  readonly createdByUserId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateMarketInsightInput {
  readonly headline: string;
  readonly summary?: string | undefined;
  readonly stat: MarketInsightStat;
  readonly regionId: string;
  readonly categoryId: string;
  readonly sourceName: string;
  readonly sourceUrl?: string | undefined;
  readonly sourcePublishedDate: string;
}

export interface UpdateMarketInsightInput {
  readonly headline?: string | undefined;
  readonly summary?: string | null | undefined;
  readonly stat?: MarketInsightStat | undefined;
  readonly regionId?: string | undefined;
  readonly categoryId?: string | undefined;
  readonly sourceName?: string | undefined;
  readonly sourceUrl?: string | null | undefined;
  readonly sourcePublishedDate?: string | undefined;
}

export interface MarketInsightAdminFilter {
  readonly status: "draft" | "published" | "all";
  readonly regionSlug?: string | undefined;
  readonly categorySlug?: string | undefined;
  readonly page: number;
  readonly limit: number;
}

const ADMIN_VIEW_COLUMNS = {
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
  createdByUserId: marketInsight.createdByUserId,
  createdAt: marketInsight.createdAt,
  updatedAt: marketInsight.updatedAt,
} as const;

type AdminRow = {
  readonly publishedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
} & Omit<MarketInsightAdminView, "publishedAt" | "createdAt" | "updatedAt">;

function toAdminView(row: AdminRow): MarketInsightAdminView {
  return {
    ...row,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function findAdminView(insightId: string): Promise<MarketInsightAdminView | null> {
  const [row] = await db
    .select(ADMIN_VIEW_COLUMNS)
    .from(marketInsight)
    .innerJoin(researchCategory, eq(marketInsight.categoryId, researchCategory.id))
    .innerJoin(discoveryRegion, eq(marketInsight.regionId, discoveryRegion.id))
    .where(eq(marketInsight.id, insightId));

  return row ? toAdminView(row) : null;
}

/**
 * Resolves the two required FKs.
 *
 * The category must be `approved`: a `pending` user-minted row is a real row, so the FK
 * alone would accept it and one submission could seed the taxonomy AND the knowledge hub.
 * The same gate `createProblemSubmission` applies, for the same reason.
 */
async function resolveReferences(
  regionId: string,
  categoryId: string,
): Promise<Result<true, MarketInsightError>> {
  const [region] = await db
    .select({ id: discoveryRegion.id })
    .from(discoveryRegion)
    .where(eq(discoveryRegion.id, regionId));

  if (!region) {
    return { success: false, error: { type: "REGION_NOT_FOUND", regionId } };
  }

  const [category] = await db
    .select({ status: researchCategory.status })
    .from(researchCategory)
    .where(eq(researchCategory.id, categoryId));

  if (!category) {
    return { success: false, error: { type: "CATEGORY_NOT_FOUND", categoryId } };
  }
  if (category.status !== "approved") {
    return { success: false, error: { type: "CATEGORY_NOT_APPROVED", categoryId } };
  }

  return { success: true, value: true };
}

/**
 * Asserts the stat quad would satisfy all three CHECKs.
 *
 * THROWS rather than returning an error, and that is deliberate: this is unreachable
 * through a controller, because `MarketInsightStatSchema` runs the SAME predicate and 422s
 * first. Reaching it means a caller inside the process built an invalid quad, which is a
 * programmer error — and CLAUDE.md §3.3 reserves `throw` for exactly that.
 */
function assertStatIsStorable(stat: MarketInsightStat, operation: string): void {
  const violations = findStatViolations(stat);
  if (violations.length > 0) {
    throw new Error(`${operation}: stat violates ${violations.join(", ")}`);
  }
}

/**
 * `GET /discovery/admin/market-insights` — the moderator queue, drafts included.
 *
 * NOT OPTIONAL, and not a convenience. `listMarketInsights` hard-filters
 * `publishedAt IS NOT NULL`, so without this read a moderator who creates a draft can never
 * see it again — the only route back to it is the id in the `201` body. That would make
 * `/publish` unreachable in practice and rebuild §11j.1's dead end one layer up.
 *
 * A SEPARATE FUNCTION rather than an `includeDrafts` flag on the public read: that read
 * promises never to return a `Result`, and its three supporting indexes are all declared
 * `WHERE published_at IS NOT NULL`. The public path stays byte-identical.
 */
export async function listMarketInsightsForModerator(
  actorUserId: string,
  filter: MarketInsightAdminFilter,
): Promise<
  Result<
    { readonly rows: readonly MarketInsightAdminView[]; readonly total: number },
    MarketInsightError
  >
> {
  // 1. CAPABILITY FIRST — before any id is read. See the module comment.
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_taxonomy");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  // 2. Resources second.
  const conditions = [];
  if (filter.status === "draft") conditions.push(isNull(marketInsight.publishedAt));
  if (filter.status === "published") conditions.push(isNotNull(marketInsight.publishedAt));
  if (filter.regionSlug) conditions.push(eq(discoveryRegion.slug, filter.regionSlug));
  if (filter.categorySlug) conditions.push(eq(researchCategory.slug, filter.categorySlug));
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, [totalRow]] = await Promise.all([
    db
      .select(ADMIN_VIEW_COLUMNS)
      .from(marketInsight)
      .innerJoin(researchCategory, eq(marketInsight.categoryId, researchCategory.id))
      .innerJoin(discoveryRegion, eq(marketInsight.regionId, discoveryRegion.id))
      .where(whereClause)
      // NOT by publishedAt: it is NULL on exactly the rows this queue exists to surface,
      // and every draft would sort together at one end. `createdAt` is present on every
      // row, and the tiebreak ends in the unique id (§4c rule 4).
      .orderBy(desc(marketInsight.createdAt), desc(marketInsight.id))
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
    success: true,
    value: { rows: rows.map(toAdminView), total: totalRow?.total ?? 0 },
  };
}

/**
 * `POST /discovery/admin/market-insights` — creates a DRAFT.
 *
 * `publishedAt` is absent from the input type, so a new row is always unpublished and
 * `/publish` is the only thing that can change that. Visibility is never a side effect of
 * authoring — the same rule `talent_profile` follows, and for the same reason: an insight
 * appearing on the landing page because someone fixed a typo is not something an editor
 * asked for.
 */
export async function createMarketInsight(
  actorUserId: string,
  input: CreateMarketInsightInput,
): Promise<Result<MarketInsightAdminView, MarketInsightError>> {
  // 1. CAPABILITY FIRST — before any id is read.
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_taxonomy");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  // 2. Resources second.
  const references = await resolveReferences(input.regionId, input.categoryId);
  if (!references.success) {
    return { success: false, error: references.error };
  }

  assertStatIsStorable(input.stat, "createMarketInsight");

  const [inserted] = await db
    .insert(marketInsight)
    .values({
      headline: input.headline,
      summary: input.summary ?? null,
      statKind: input.stat.statKind,
      statValueMilli: input.stat.statValueMilli,
      statUnitKey: input.stat.statUnitKey,
      trendDirection: input.stat.trendDirection,
      regionId: input.regionId,
      categoryId: input.categoryId,
      sourceName: input.sourceName,
      sourceUrl: input.sourceUrl ?? null,
      sourcePublishedDate: input.sourcePublishedDate,
      createdByUserId: actorUserId,
    })
    .returning({ id: marketInsight.id });

  if (!inserted) {
    throw new Error("createMarketInsight: insert returned no row");
  }

  const created = await findAdminView(inserted.id);
  if (!created) {
    throw new Error("createMarketInsight: inserted row could not be read back");
  }
  return { success: true, value: created };
}

/**
 * `PATCH /discovery/admin/market-insights/:insightId` — corrects a row, published or not.
 *
 * THE STAT QUAD MOVES AS ONE OR NOT AT ALL. `market_insight_trend_agreement_ck` is
 * cross-field, so a partial edit setting only `trendDirection: "up"` against a stored
 * `statValueMilli: -22000` is a guaranteed 23514. The input carries `stat` as a single
 * nested value, which makes that partial UNREPRESENTABLE rather than merely refused
 * (CLAUDE.md §3.2) — there is no shape to send that would express it.
 *
 * Editing does not publish and does not unpublish: `publishedAt` is untouched here.
 */
export async function updateMarketInsight(
  actorUserId: string,
  insightId: string,
  input: UpdateMarketInsightInput,
): Promise<Result<MarketInsightAdminView, MarketInsightError>> {
  // 1. CAPABILITY FIRST — before the id is read.
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_taxonomy");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  // 2. Resources second.
  const existing = await findAdminView(insightId);
  if (!existing) {
    return { success: false, error: { type: "MARKET_INSIGHT_NOT_FOUND", insightId } };
  }

  const nextRegionId = input.regionId ?? existing.region.id;
  const nextCategoryId = input.categoryId ?? existing.category.id;
  if (input.regionId !== undefined || input.categoryId !== undefined) {
    const references = await resolveReferences(nextRegionId, nextCategoryId);
    if (!references.success) {
      return { success: false, error: references.error };
    }
  }

  if (input.stat !== undefined) {
    assertStatIsStorable(input.stat, "updateMarketInsight");
  }

  const [updated] = await db
    .update(marketInsight)
    .set({
      ...(input.headline === undefined ? {} : { headline: input.headline }),
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      ...(input.stat === undefined
        ? {}
        : {
            statKind: input.stat.statKind,
            statValueMilli: input.stat.statValueMilli,
            statUnitKey: input.stat.statUnitKey,
            trendDirection: input.stat.trendDirection,
          }),
      ...(input.regionId === undefined ? {} : { regionId: input.regionId }),
      ...(input.categoryId === undefined ? {} : { categoryId: input.categoryId }),
      ...(input.sourceName === undefined ? {} : { sourceName: input.sourceName }),
      ...(input.sourceUrl === undefined ? {} : { sourceUrl: input.sourceUrl }),
      ...(input.sourcePublishedDate === undefined
        ? {}
        : { sourcePublishedDate: input.sourcePublishedDate }),
    })
    .where(eq(marketInsight.id, insightId))
    .returning({ id: marketInsight.id });

  if (!updated) {
    return { success: false, error: { type: "MARKET_INSIGHT_NOT_FOUND", insightId } };
  }

  const view = await findAdminView(updated.id);
  if (!view) {
    throw new Error("updateMarketInsight: updated row could not be read back");
  }
  return { success: true, value: view };
}

/**
 * `POST …/:insightId/publish` · `/unpublish` — the ONLY thing that moves `publishedAt`.
 *
 * A SERVER-OWNED TIMESTAMP, never a body field, which is why these are separate routes
 * rather than a key on the PATCH. `talent-profiles.service.ts`'s `setTalentProfilePublished`
 * is the precedent, and the schema comment beside `talentProfileVisibilityEnum` states the
 * rule this follows: visibility is never a side effect of an edit.
 *
 * No completeness gate — every field the public read requires is NOT NULL on the table, so
 * a row that exists is publishable by construction.
 */
export async function setMarketInsightPublished(
  actorUserId: string,
  insightId: string,
  shouldPublish: boolean,
): Promise<Result<MarketInsightAdminView, MarketInsightError>> {
  // 1. CAPABILITY FIRST — before the id is read.
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_taxonomy");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  // 2. Resources second.
  const existing = await findAdminView(insightId);
  if (!existing) {
    return { success: false, error: { type: "MARKET_INSIGHT_NOT_FOUND", insightId } };
  }

  const isPublished = existing.publishedAt !== null;
  if (shouldPublish && isPublished) {
    return { success: false, error: { type: "ALREADY_PUBLISHED" } };
  }
  if (!shouldPublish && !isPublished) {
    return { success: false, error: { type: "NOT_PUBLISHED" } };
  }

  await db
    .update(marketInsight)
    .set({ publishedAt: shouldPublish ? new Date() : null })
    .where(eq(marketInsight.id, insightId));

  const view = await findAdminView(insightId);
  if (!view) {
    throw new Error("setMarketInsightPublished: row could not be read back");
  }
  return { success: true, value: view };
}

/**
 * `DELETE /discovery/admin/market-insights/:insightId` — a HARD delete.
 *
 * STILL A HARD DELETE, BUT NO LONGER AN UNCONDITIONAL ONE. This comment used to open
 * "nothing in the schema has an FK into `market_insight`", and §11k.2 ended that:
 * `market_insight_project_link.insight_id` is `ON DELETE restrict`, so an insight a project
 * cites cannot be erased. That FK is the point — a cited insight IS evidence about somebody's
 * work now, and erasing it would silently rewrite the basis a project stated publicly.
 * `deleteTalentProfile` remains the precedent for the uncited case ("a content table, so a
 * real delete").
 *
 * TRANSLATED, NOT PRE-COUNTED. The 23503 is the race-safe authority; a `SELECT count(*)`
 * before the delete would still lose to a citation committed between the two statements.
 *
 * NO GATE ON A PUBLISHED ROW, deliberately. `/unpublish` exists to take an insight off the
 * page while KEEPING the editorial work; delete is for discarding it. Making delete refuse
 * published rows would just mean two calls to do one thing.
 */
export async function deleteMarketInsight(
  actorUserId: string,
  insightId: string,
): Promise<Result<{ readonly deleted: true }, MarketInsightError>> {
  // 1. CAPABILITY FIRST — before the id is read.
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_taxonomy");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  // 2. Resources second.
  try {
    const [deleted] = await db
      .delete(marketInsight)
      .where(eq(marketInsight.id, insightId))
      .returning({ id: marketInsight.id });

    if (!deleted) {
      return { success: false, error: { type: "MARKET_INSIGHT_NOT_FOUND", insightId } };
    }
  } catch (error: unknown) {
    if (isForeignKeyViolation(error)) {
      // The only inbound FK is §11k.2's citation link, so this code has exactly one meaning.
      return { success: false, error: { type: "MARKET_INSIGHT_CITED" } };
    }
    throw error;
  }

  return { success: true, value: { deleted: true } };
}
