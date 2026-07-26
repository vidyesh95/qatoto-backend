import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  discoveryRegion,
  product,
  projectStats,
  projectSupplierEngagement,
  researchProject,
  supplier,
  supplierCapability,
  supplierCapabilityLink,
} from "#src/db/schema.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import {
  requirePlatformCapability,
  type PlatformAccessError,
} from "#src/services/platform-role.service.js";
import type { Result } from "#src/types/index.js";

/**
 * The supplier / ODM directory (R_AND_D_BACKEND_STRUCTURE.md §11i, Appendix B4).
 *
 * A §6-FAMILY CATALOGUE. Server-side filtering, a curated vocabulary matched by slug
 * EQUALITY rather than substring, and an ordering that ends in a unique column — the same
 * three rules the talent directory and the cluster map follow.
 *
 * THE WRITE SIDE IS MODERATOR-ONLY, AND THE CAPABILITY IS CHECKED FIRST. Every mutation
 * below opens with `requirePlatformCapability(…, "moderate_taxonomy")` BEFORE any id is
 * read, which is what keeps its 403 from becoming an id oracle (§4a Layer 3). Reversing
 * those two steps would let a non-moderator distinguish "this supplier exists" from "it
 * does not" by watching which error came back.
 *
 * WHY `moderate_taxonomy` AND NOT A NEW CAPABILITY. This is a curated vocabulary of
 * third-party entities — the same kind of thing the category and skill taxonomies are, and
 * the same staff decide it. A capability set is not a rank ladder; adding a fourth
 * content capability that always travels with the other three would be a rank ladder
 * wearing a set's clothes.
 *
 * READS RETURN NO `Result`. An empty directory is a successful empty list, and an unknown
 * `?capability=` yields an empty page rather than a 404 — a facet that 404s leaks which
 * slugs exist (§6).
 */

export type SupplierError =
  | PlatformAccessError
  | { type: "SUPPLIER_NOT_FOUND"; supplierRef: string }
  | { type: "SUPPLIER_SLUG_TAKEN"; slug: string }
  | { type: "SUPPLIER_CAPABILITY_UNKNOWN"; capabilitySlugs: readonly string[] }
  | { type: "SUPPLIER_REGION_UNKNOWN"; regionSlug: string };

export interface SupplierCapabilityView {
  readonly id: string;
  readonly slug: string;
  /** DB column `label` → wire field `displayLabel`, the §6 convention everywhere. */
  readonly displayLabel: string;
  readonly kind: (typeof supplierCapability.$inferSelect)["kind"];
}

export interface SupplierView {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly summary: string | null;
  readonly regionSlug: string | null;
  readonly regionDisplayLabel: string | null;
  readonly verificationState: (typeof supplier.$inferSelect)["verificationState"];
  readonly contactPolicy: (typeof supplier.$inferSelect)["contactPolicy"];
  readonly websiteUrl: string | null;
  /** Integer days. No float, no currency, no derived duration (§4b). */
  readonly leadTimeDays: number | null;
  readonly minimumOrderQuantity: number | null;
  readonly capabilities: readonly SupplierCapabilityView[];
  readonly createdAt: Date;
}

export interface SupplierPage {
  readonly rows: readonly SupplierView[];
  readonly total: number;
}

export interface ListSuppliersFilter {
  /** Every slug must match — AND, not OR. A partial match is a different supplier. */
  readonly capabilitySlugs?: readonly string[] | undefined;
  readonly regionSlug?: string | undefined;
  readonly verificationState?: (typeof supplier.$inferSelect)["verificationState"] | undefined;
  readonly page: number;
  readonly limit: number;
}

export interface CreateSupplierInput {
  readonly slug: string;
  readonly name: string;
  readonly summary?: string | undefined;
  readonly regionSlug?: string | undefined;
  readonly contactPolicy?: (typeof supplier.$inferSelect)["contactPolicy"] | undefined;
  readonly websiteUrl?: string | undefined;
  readonly leadTimeDays?: number | undefined;
  readonly minimumOrderQuantity?: number | undefined;
  readonly capabilitySlugs: readonly string[];
}

export interface UpdateSupplierInput {
  readonly name?: string | undefined;
  readonly summary?: string | null | undefined;
  readonly regionSlug?: string | null | undefined;
  readonly verificationState?: (typeof supplier.$inferSelect)["verificationState"] | undefined;
  readonly contactPolicy?: (typeof supplier.$inferSelect)["contactPolicy"] | undefined;
  readonly websiteUrl?: string | null | undefined;
  readonly leadTimeDays?: number | null | undefined;
  readonly minimumOrderQuantity?: number | null | undefined;
  readonly isActive?: boolean | undefined;
  readonly capabilitySlugs?: readonly string[] | undefined;
}

const SUPPLIER_VIEW_COLUMNS = {
  id: supplier.id,
  slug: supplier.slug,
  name: supplier.name,
  summary: supplier.summary,
  regionSlug: discoveryRegion.slug,
  regionDisplayLabel: discoveryRegion.label,
  verificationState: supplier.verificationState,
  contactPolicy: supplier.contactPolicy,
  websiteUrl: supplier.websiteUrl,
  leadTimeDays: supplier.leadTimeDays,
  minimumOrderQuantity: supplier.minimumOrderQuantity,
  createdAt: supplier.createdAt,
} as const;

/** The seeded capability vocabulary. `listSkills`'s shape — a facet list is not a feed. */
export async function listSupplierCapabilities(): Promise<readonly SupplierCapabilityView[]> {
  return db
    .select({
      id: supplierCapability.id,
      slug: supplierCapability.slug,
      displayLabel: supplierCapability.label,
      kind: supplierCapability.kind,
    })
    .from(supplierCapability)
    .where(eq(supplierCapability.isActive, true))
    .orderBy(asc(supplierCapability.label), asc(supplierCapability.id));
}

/** Attaches each supplier's capabilities in ONE extra query rather than N. */
async function attachCapabilities(
  rows: readonly Omit<SupplierView, "capabilities">[],
): Promise<readonly SupplierView[]> {
  if (rows.length === 0) return [];

  const capabilityRows = await db
    .select({
      supplierId: supplierCapabilityLink.supplierId,
      id: supplierCapability.id,
      slug: supplierCapability.slug,
      displayLabel: supplierCapability.label,
      kind: supplierCapability.kind,
    })
    .from(supplierCapabilityLink)
    .innerJoin(supplierCapability, eq(supplierCapability.id, supplierCapabilityLink.capabilityId))
    .where(
      inArray(
        supplierCapabilityLink.supplierId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(asc(supplierCapability.label), asc(supplierCapability.id));

  return rows.map((row) => ({
    ...row,
    capabilities: capabilityRows
      .filter((capability) => capability.supplierId === row.id)
      .map(({ supplierId: _supplierId, ...capability }) => capability),
  }));
}

/** One page of the directory. */
export async function listSuppliers(filter: ListSuppliersFilter): Promise<SupplierPage> {
  const conditions = [eq(supplier.isActive, true)];

  if (filter.regionSlug !== undefined) {
    conditions.push(eq(discoveryRegion.slug, filter.regionSlug));
  }
  if (filter.verificationState !== undefined) {
    conditions.push(eq(supplier.verificationState, filter.verificationState));
  }

  const requestedCapabilitySlugs = filter.capabilitySlugs ?? [];
  if (requestedCapabilitySlugs.length > 0) {
    // EVERY requested capability must be present, not any — the same
    // `GROUP BY … HAVING count(distinct …) = n` subquery the talent directory uses.
    // Slug EQUALITY, never a substring: that is the bug class §6 exists to remove.
    const matchingSupplierIds = db
      .select({ supplierId: supplierCapabilityLink.supplierId })
      .from(supplierCapabilityLink)
      .innerJoin(supplierCapability, eq(supplierCapability.id, supplierCapabilityLink.capabilityId))
      .where(inArray(supplierCapability.slug, [...requestedCapabilitySlugs]))
      .groupBy(supplierCapabilityLink.supplierId)
      .having(sql`count(distinct ${supplierCapability.slug}) = ${requestedCapabilitySlugs.length}`);

    conditions.push(inArray(supplier.id, matchingSupplierIds));
  }

  const predicate = and(...conditions);

  const [rows, [totalRow]] = await Promise.all([
    db
      .select(SUPPLIER_VIEW_COLUMNS)
      .from(supplier)
      .leftJoin(discoveryRegion, eq(discoveryRegion.id, supplier.regionId))
      .where(predicate)
      // Ends in a unique column (§4c rule 4): suppliers share names.
      .orderBy(asc(supplier.name), asc(supplier.id))
      .limit(filter.limit)
      .offset((filter.page - 1) * filter.limit),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(supplier)
      .leftJoin(discoveryRegion, eq(discoveryRegion.id, supplier.regionId))
      .where(predicate),
  ]);

  return { rows: await attachCapabilities(rows), total: totalRow?.total ?? 0 };
}

/** One supplier by its public slug. An inactive listing is a 404, not a tombstone. */
export async function findSupplierBySlug(
  supplierSlug: string,
): Promise<Result<SupplierView, SupplierError>> {
  const [row] = await db
    .select(SUPPLIER_VIEW_COLUMNS)
    .from(supplier)
    .leftJoin(discoveryRegion, eq(discoveryRegion.id, supplier.regionId))
    .where(and(eq(supplier.slug, supplierSlug), eq(supplier.isActive, true)))
    .limit(1);

  if (!row) {
    return { success: false, error: { type: "SUPPLIER_NOT_FOUND", supplierRef: supplierSlug } };
  }

  const [view] = await attachCapabilities([row]);
  if (!view) {
    throw new Error("findSupplierBySlug: capability attachment dropped the row");
  }
  return { success: true, value: view };
}

/** Resolves the whole requested capability set, or names the ones that do not exist. */
async function resolveCapabilityIds(
  capabilitySlugs: readonly string[],
): Promise<Result<readonly string[], SupplierError>> {
  if (capabilitySlugs.length === 0) return { success: true, value: [] };

  const rows = await db
    .select({ id: supplierCapability.id, slug: supplierCapability.slug })
    .from(supplierCapability)
    .where(
      and(
        inArray(supplierCapability.slug, [...capabilitySlugs]),
        eq(supplierCapability.isActive, true),
      ),
    );

  const resolvedSlugs = new Set(rows.map((row) => row.slug));
  const unknownSlugs = capabilitySlugs.filter((slug) => !resolvedSlugs.has(slug));

  if (unknownSlugs.length > 0) {
    return {
      success: false,
      // A WRITE names the unknown slugs; the READ path above silently yields an empty
      // page for the same input. The difference is deliberate: the writer is already a
      // moderator, so there is nothing to leak, and a silent drop on a write would create
      // a listing missing a capability the moderator believed they had set.
      error: { type: "SUPPLIER_CAPABILITY_UNKNOWN", capabilitySlugs: unknownSlugs },
    };
  }

  return { success: true, value: rows.map((row) => row.id) };
}

async function resolveRegionId(regionSlug: string): Promise<Result<string, SupplierError>> {
  const [row] = await db
    .select({ id: discoveryRegion.id })
    .from(discoveryRegion)
    .where(eq(discoveryRegion.slug, regionSlug))
    .limit(1);

  if (!row) {
    return { success: false, error: { type: "SUPPLIER_REGION_UNKNOWN", regionSlug } };
  }
  return { success: true, value: row.id };
}

/**
 * Creates a listing. MODERATOR ONLY.
 *
 * `verificationState` appears in NO input type and is therefore unwritable here: a new row
 * is always `unverified`, and only `updateSupplier` — also moderator-only — moves it. A
 * directory whose rows can assert their own trust level is worse than no directory.
 */
export async function createSupplier(
  actorUserId: string,
  input: CreateSupplierInput,
): Promise<Result<SupplierView, SupplierError>> {
  // 1. CAPABILITY FIRST — before any id or slug is read. See the module comment.
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_taxonomy");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  // 2. Resources second.
  const resolvedCapabilityIds = await resolveCapabilityIds(input.capabilitySlugs);
  if (!resolvedCapabilityIds.success) return resolvedCapabilityIds;

  let regionId: string | null = null;
  if (input.regionSlug !== undefined) {
    const resolvedRegion = await resolveRegionId(input.regionSlug);
    if (!resolvedRegion.success) return resolvedRegion;
    regionId = resolvedRegion.value;
  }

  try {
    await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(supplier)
        .values({
          slug: input.slug,
          name: input.name,
          summary: input.summary ?? null,
          regionId,
          contactPolicy: input.contactPolicy ?? "no_contact",
          websiteUrl: input.websiteUrl ?? null,
          leadTimeDays: input.leadTimeDays ?? null,
          minimumOrderQuantity: input.minimumOrderQuantity ?? null,
          createdByUserId: actorUserId,
        })
        .returning({ id: supplier.id });

      if (!inserted) {
        throw new Error("createSupplier: insert returned no row");
      }

      if (resolvedCapabilityIds.value.length > 0) {
        await tx.insert(supplierCapabilityLink).values(
          resolvedCapabilityIds.value.map((capabilityId) => ({
            supplierId: inserted.id,
            capabilityId,
          })),
        );
      }
    });
  } catch (error: unknown) {
    // The UNIQUE on `slug` IS the de-duplication mechanism; a collision is a 409, never a
    // silently suffixed second row for the same supplier.
    if (isUniqueViolation(error)) {
      return { success: false, error: { type: "SUPPLIER_SLUG_TAKEN", slug: input.slug } };
    }
    throw error;
  }

  return findSupplierBySlug(input.slug);
}

/**
 * Edits a listing. MODERATOR ONLY.
 *
 * The slug is absent from `UpdateSupplierInput` and unwritable: it is the public identity
 * a client has already linked to, and renaming it silently breaks every stored reference.
 */
export async function updateSupplier(
  actorUserId: string,
  supplierId: string,
  input: UpdateSupplierInput,
): Promise<Result<SupplierView, SupplierError>> {
  // 1. Capability first, again before any id is read.
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_taxonomy");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  // 2. Resource second.
  const [existing] = await db
    .select({ id: supplier.id, slug: supplier.slug })
    .from(supplier)
    .where(eq(supplier.id, supplierId))
    .limit(1);

  if (!existing) {
    return { success: false, error: { type: "SUPPLIER_NOT_FOUND", supplierRef: supplierId } };
  }

  let regionId: string | null | undefined;
  if (input.regionSlug === null) {
    regionId = null;
  } else if (input.regionSlug !== undefined) {
    const resolvedRegion = await resolveRegionId(input.regionSlug);
    if (!resolvedRegion.success) return resolvedRegion;
    regionId = resolvedRegion.value;
  }

  const resolvedCapabilityIds =
    input.capabilitySlugs === undefined ? null : await resolveCapabilityIds(input.capabilitySlugs);
  if (resolvedCapabilityIds !== null && !resolvedCapabilityIds.success) {
    return resolvedCapabilityIds;
  }

  await db.transaction(async (tx) => {
    await tx
      .update(supplier)
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.summary === undefined ? {} : { summary: input.summary }),
        ...(regionId === undefined ? {} : { regionId }),
        ...(input.verificationState === undefined
          ? {}
          : { verificationState: input.verificationState }),
        ...(input.contactPolicy === undefined ? {} : { contactPolicy: input.contactPolicy }),
        ...(input.websiteUrl === undefined ? {} : { websiteUrl: input.websiteUrl }),
        ...(input.leadTimeDays === undefined ? {} : { leadTimeDays: input.leadTimeDays }),
        ...(input.minimumOrderQuantity === undefined
          ? {}
          : { minimumOrderQuantity: input.minimumOrderQuantity }),
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
      })
      .where(eq(supplier.id, supplierId));

    if (resolvedCapabilityIds !== null && resolvedCapabilityIds.success) {
      // Replaced wholesale rather than diffed: the join row carries nothing but the pair,
      // so a delete-and-reinsert loses no information and cannot drift from the input.
      await tx
        .delete(supplierCapabilityLink)
        .where(eq(supplierCapabilityLink.supplierId, supplierId));

      if (resolvedCapabilityIds.value.length > 0) {
        await tx
          .insert(supplierCapabilityLink)
          .values(
            resolvedCapabilityIds.value.map((capabilityId) => ({ supplierId, capabilityId })),
          );
      }
    }
  });

  return findSupplierBySlug(existing.slug);
}

export interface LaunchReadyProjectView {
  readonly projectSlug: string;
  readonly projectName: string;
  readonly projectCoverImageUrl: string | null;
  readonly projectTagline: string;
  /** NULL until §9's jobs have run. Never coerced to 0 — that would assert a fact. */
  readonly verifiedEffortMinutesTotal: number | null;
  readonly allocatedEquityBasisPoints: number | null;
  readonly statsComputedAt: Date | null;
  /** What the project actually launched, via `product.researchProjectId` (§11i). */
  readonly launchedProducts: readonly {
    readonly productId: string;
    readonly title: string;
    readonly status: (typeof product.$inferSelect)["status"];
  }[];
}

export interface LaunchReadyProjectPage {
  readonly rows: readonly LaunchReadyProjectView[];
  readonly total: number;
}

/**
 * The launch-ready rail: active projects at the `go_to_market` stage, and what each one
 * has actually listed.
 *
 * The product join is the ONLY thing the new FK unlocks publicly, and it is why the column
 * exists: without it the rail can name a project but not what it shipped.
 */
export async function listLaunchReadyProjects(filter: {
  readonly page: number;
  readonly limit: number;
}): Promise<LaunchReadyProjectPage> {
  const predicate = and(
    eq(researchProject.status, "active"),
    eq(researchProject.stage, "go_to_market"),
  );

  const [rows, [totalRow]] = await Promise.all([
    db
      .select({
        projectId: researchProject.id,
        projectSlug: researchProject.slug,
        projectName: researchProject.name,
        projectCoverImageUrl: researchProject.coverImageUrl,
        projectTagline: researchProject.tagline,
        verifiedEffortMinutesTotal: projectStats.verifiedEffortMinutesTotal,
        allocatedEquityBasisPoints: projectStats.allocatedEquityBasisPoints,
        statsComputedAt: projectStats.statsComputedAt,
      })
      .from(researchProject)
      .innerJoin(projectStats, eq(projectStats.projectId, researchProject.id))
      .where(predicate)
      // Ends in a unique column (§4c rule 4).
      .orderBy(asc(researchProject.name), asc(researchProject.id))
      .limit(filter.limit)
      .offset((filter.page - 1) * filter.limit),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(researchProject)
      .where(predicate),
  ]);

  if (rows.length === 0) {
    return { rows: [], total: totalRow?.total ?? 0 };
  }

  // One extra query rather than N, the same shape `attachCompensation` uses.
  const productRows = await db
    .select({
      researchProjectId: product.researchProjectId,
      productId: product.id,
      title: product.title,
      status: product.status,
    })
    .from(product)
    .where(
      and(
        inArray(
          product.researchProjectId,
          rows.map((row) => row.projectId),
        ),
        // Draft listings are visible only to their seller (STORE §4); this rail is public.
        eq(product.status, "active"),
      ),
    )
    .orderBy(asc(product.title), asc(product.id));

  return {
    rows: rows.map(({ projectId, ...project }) => ({
      ...project,
      launchedProducts: productRows
        .filter((row) => row.researchProjectId === projectId)
        .map(({ researchProjectId: _researchProjectId, ...launched }) => launched),
    })),
    total: totalRow?.total ?? 0,
  };
}

/** How many suppliers a project has on record. Feeds the readiness checklist. */
export async function countProjectSupplierEngagements(projectId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(projectSupplierEngagement)
    .where(eq(projectSupplierEngagement.projectId, projectId));

  return row?.total ?? 0;
}
