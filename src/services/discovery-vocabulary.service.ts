import { asc, count, eq } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  discoveryRegion,
  discoverySkill,
  researchCategory,
  talentProfile,
  talentProfileSkill,
} from "#src/db/schema.js";
import { isForeignKeyViolation, isUniqueViolation } from "#src/lib/pg-errors.js";
import {
  requirePlatformCapability,
  type PlatformAccessError,
} from "#src/services/platform-role.service.js";
import type { Result } from "#src/types/index.js";

/**
 * Authoring for the two CONTROLLED VOCABULARIES — `discovery_skill` and `discovery_region`
 * (R_AND_D_BACKEND_STRUCTURE.md §6, §11j.4).
 *
 * §11j.4 CALLS THIS ROW "lower priority, and arguably not a defect", and it is right: both
 * tables are seeded by `db:seed-discovery-lookups` and having no runtime write path is a
 * legitimate answer for a controlled vocabulary — exactly why `supplier_capability`
 * deliberately has no POST either. What this adds is the ability to correct and extend them
 * without a deploy. It does NOT open them to users; every function here is moderator-gated.
 *
 * KEPT OUT OF `discovery-moderation.service.ts`, which is about DECIDING user-minted rows —
 * a category somebody submitted, a merge a job proposed. Authoring curated rows is a
 * different job with a different failure surface.
 *
 * WHAT `DELETE` MEANS HERE, because the two tables answer differently and the doc's
 * "retirement is `isActive`, not DELETE" needs reading carefully:
 *
 *   SKILL — has `isActive`. RETIREMENT is `PATCH { isActive: false }`: the row survives, the
 *   chips stop offering it, and published profiles that cite it keep rendering. DELETE is
 *   the mistake-eraser for a typo nobody has used yet, and `talent_profile_skill`'s
 *   `restrict` FK is what makes "nobody has used it" a fact rather than a hope.
 *
 *   REGION — has NO `isActive`, AND IS NOT GETTING ONE. A country does not stop existing,
 *   and adding the column would be a migration in service of a state the domain has no
 *   meaning for. So a region is either referenced (undeletable) or unreferenced (a mistake,
 *   deletable). That is the honest reading of the rule for a table with no such flag.
 *
 * THE REGION DELETE NEEDS AN EXPLICIT PRE-COUNT, and this is the sharp edge in this file.
 * Seven FKs into `discovery_region` are `restrict` and Postgres refuses those outright — but
 * `talent_profile.regionId` is `ON DELETE SET NULL`, the only one that is not. A hard delete
 * therefore SUCCEEDS and silently blanks the region on every profile that used it, dropping
 * them out of the `?region=` facet with nothing raised anywhere. The FK cannot protect what
 * it is configured to overwrite, so the count has to.
 */

export type DiscoveryVocabularyError =
  | PlatformAccessError
  // NOT `SKILL_NOT_FOUND`: that literal already exists in `talent-profiles.service.ts` with
  // the payload `{ skillSlugs: readonly string[] }`, and two variants sharing a literal must
  // share a shape or the mapper's exhaustive switch cannot read the field.
  | { type: "DISCOVERY_SKILL_NOT_FOUND"; skillId: string }
  | { type: "SKILL_SLUG_TAKEN"; slug: string }
  | { type: "SKILL_HAS_REFERENCES"; profileCount: number }
  | { type: "DISCOVERY_REGION_NOT_FOUND"; regionId: string }
  | { type: "REGION_SLUG_TAKEN"; slug: string }
  | { type: "REGION_HAS_REFERENCES" }
  // Reused verbatim from the existing discovery unions.
  | { type: "CATEGORY_NOT_FOUND"; categoryId: string }
  | { type: "CATEGORY_NOT_APPROVED"; categoryId: string };

export interface DiscoverySkillAdminView {
  readonly id: string;
  readonly slug: string;
  readonly displayLabel: string;
  readonly categoryId: string | null;
  readonly isActive: boolean;
  readonly createdAt: Date;
}

export interface DiscoveryRegionAdminView {
  readonly id: string;
  readonly slug: string;
  readonly displayLabel: string;
  readonly kind: (typeof discoveryRegion.$inferSelect)["kind"];
  readonly countryCode: string | null;
  readonly parentRegionId: string | null;
  readonly createdAt: Date;
}

export interface CreateDiscoverySkillInput {
  readonly slug: string;
  readonly displayLabel: string;
  readonly categoryId?: string | undefined;
}

export interface UpdateDiscoverySkillInput {
  readonly displayLabel?: string | undefined;
  readonly categoryId?: string | null | undefined;
  readonly isActive?: boolean | undefined;
}

export type CreateDiscoveryRegionInput =
  | {
      readonly kind: "country";
      readonly slug: string;
      readonly displayLabel: string;
      readonly countryCode: string;
      readonly parentRegionId: string;
    }
  | {
      readonly kind: "macro_region";
      readonly slug: string;
      readonly displayLabel: string;
      readonly parentRegionId: string;
    };

const SKILL_VIEW_COLUMNS = {
  id: discoverySkill.id,
  slug: discoverySkill.slug,
  displayLabel: discoverySkill.label,
  categoryId: discoverySkill.categoryId,
  isActive: discoverySkill.isActive,
  createdAt: discoverySkill.createdAt,
} as const;

const REGION_VIEW_COLUMNS = {
  id: discoveryRegion.id,
  slug: discoveryRegion.slug,
  displayLabel: discoveryRegion.label,
  kind: discoveryRegion.kind,
  countryCode: discoveryRegion.countryCode,
  parentRegionId: discoveryRegion.parentRegionId,
  createdAt: discoveryRegion.createdAt,
} as const;

/** The category a skill may be filed under must exist AND be approved (§6). */
async function requireApprovedCategory(
  categoryId: string,
): Promise<Result<true, DiscoveryVocabularyError>> {
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

// --- Skills.

/**
 * `POST /discovery/admin/skills` — mints a vocabulary entry.
 *
 * The slug is the `?skill=` filter key, matched by EQUALITY — which is the structural fix §6
 * made when it retired the `skills.some(s => s.includes(…))` substring bug. A collision is a
 * 409, never an auto-suffixed second row: two near-identical slugs for one skill splits the
 * facet and every profile behind it.
 */
export async function createDiscoverySkill(
  actorUserId: string,
  input: CreateDiscoverySkillInput,
): Promise<Result<DiscoverySkillAdminView, DiscoveryVocabularyError>> {
  // 1. CAPABILITY FIRST — before any id or slug is read.
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_taxonomy");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  // 2. Resources second.
  if (input.categoryId !== undefined) {
    const category = await requireApprovedCategory(input.categoryId);
    if (!category.success) return { success: false, error: category.error };
  }

  try {
    const [inserted] = await db
      .insert(discoverySkill)
      .values({
        slug: input.slug,
        label: input.displayLabel,
        categoryId: input.categoryId ?? null,
      })
      .returning(SKILL_VIEW_COLUMNS);

    if (!inserted) {
      throw new Error("createDiscoverySkill: insert returned no row");
    }
    return { success: true, value: inserted };
  } catch (error: unknown) {
    if (isUniqueViolation(error)) {
      return { success: false, error: { type: "SKILL_SLUG_TAKEN", slug: input.slug } };
    }
    throw error;
  }
}

/**
 * `PATCH /discovery/admin/skills/:skillId` — relabel, re-file, or RETIRE.
 *
 * `slug` IS FROZEN and appears in no input type. It is the public filter key clients have
 * already stored in saved searches and links; renaming it silently breaks every one of them.
 * Identical reasoning to `supplier.slug` and to `research_project`'s freeze at publish.
 *
 * `isActive: false` IS the retirement mechanism — the row survives, `listDiscoverySkills`
 * stops offering it (its index is partial on `is_active`), and profiles citing it keep
 * rendering.
 */
export async function updateDiscoverySkill(
  actorUserId: string,
  skillId: string,
  input: UpdateDiscoverySkillInput,
): Promise<Result<DiscoverySkillAdminView, DiscoveryVocabularyError>> {
  // 1. CAPABILITY FIRST.
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_taxonomy");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  // 2. Resources second.
  if (input.categoryId !== undefined && input.categoryId !== null) {
    const category = await requireApprovedCategory(input.categoryId);
    if (!category.success) return { success: false, error: category.error };
  }

  const [updated] = await db
    .update(discoverySkill)
    .set({
      ...(input.displayLabel === undefined ? {} : { label: input.displayLabel }),
      ...(input.categoryId === undefined ? {} : { categoryId: input.categoryId }),
      ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
    })
    .where(eq(discoverySkill.id, skillId))
    .returning(SKILL_VIEW_COLUMNS);

  if (!updated) {
    return { success: false, error: { type: "DISCOVERY_SKILL_NOT_FOUND", skillId } };
  }
  return { success: true, value: updated };
}

/**
 * `DELETE /discovery/admin/skills/:skillId` — erases a typo nobody used.
 *
 * NOT the retirement path: that is `isActive: false`. This is for the entry created with a
 * misspelled slug ten seconds ago. `talent_profile_skill.skill_id` is `restrict` — the ONLY
 * inbound FK — so Postgres decides whether "nobody used it" is true, and the count exists
 * only so the refusal can name a number.
 */
export async function deleteDiscoverySkill(
  actorUserId: string,
  skillId: string,
): Promise<Result<{ readonly deleted: true }, DiscoveryVocabularyError>> {
  // 1. CAPABILITY FIRST.
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_taxonomy");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  // 2. Resources second.
  try {
    const [deleted] = await db
      .delete(discoverySkill)
      .where(eq(discoverySkill.id, skillId))
      .returning({ id: discoverySkill.id });

    if (!deleted) {
      return { success: false, error: { type: "DISCOVERY_SKILL_NOT_FOUND", skillId } };
    }
  } catch (error: unknown) {
    if (isForeignKeyViolation(error)) {
      // Counted only on the failure path, and only so the refusal can name a number —
      // "3 profiles cite this skill" tells a moderator what to do next; "it is in use"
      // does not.
      const [citing] = await db
        .select({ total: count() })
        .from(talentProfileSkill)
        .where(eq(talentProfileSkill.skillId, skillId));

      return {
        success: false,
        error: { type: "SKILL_HAS_REFERENCES", profileCount: citing?.total ?? 0 },
      };
    }
    throw error;
  }

  return { success: true, value: { deleted: true } };
}

// --- Regions.

/**
 * `POST /discovery/admin/regions` — mints a region.
 *
 * `global` IS NOT AN ACCEPTED `kind`, and that closes a hole rather than merely declining to
 * open one. `discovery_region_root_ck` enforces `kind = 'global' ⇔ parent IS NULL`; it does
 * NOT make `global` unique, so the schema's stated assumption — "exactly one root, and it is
 * the global row" — is enforced by nothing. Omitting the branch from the wire makes a second
 * root unrepresentable, with no query and no migration.
 */
export async function createDiscoveryRegion(
  actorUserId: string,
  input: CreateDiscoveryRegionInput,
): Promise<Result<DiscoveryRegionAdminView, DiscoveryVocabularyError>> {
  // 1. CAPABILITY FIRST.
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_taxonomy");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  // 2. Resources second. Resolved here so a bad parent is a typed 422 rather than a 23503.
  const [parent] = await db
    .select({ id: discoveryRegion.id })
    .from(discoveryRegion)
    .where(eq(discoveryRegion.id, input.parentRegionId));

  if (!parent) {
    return {
      success: false,
      error: { type: "DISCOVERY_REGION_NOT_FOUND", regionId: input.parentRegionId },
    };
  }

  try {
    const [inserted] = await db
      .insert(discoveryRegion)
      .values({
        slug: input.slug,
        label: input.displayLabel,
        kind: input.kind,
        countryCode: input.kind === "country" ? input.countryCode : null,
        parentRegionId: input.parentRegionId,
      })
      .returning(REGION_VIEW_COLUMNS);

    if (!inserted) {
      throw new Error("createDiscoveryRegion: insert returned no row");
    }
    return { success: true, value: inserted };
  } catch (error: unknown) {
    // Two unique indexes: the slug, and the partial one on `country_code`.
    if (isUniqueViolation(error)) {
      return { success: false, error: { type: "REGION_SLUG_TAKEN", slug: input.slug } };
    }
    throw error;
  }
}

/**
 * `PATCH /discovery/admin/regions/:regionId` — the DISPLAY LABEL, and nothing else.
 *
 * A region's identity is not editable, and each frozen field has its own reason:
 *   `slug`                 the public `?region=` filter key clients have stored.
 *   `kind` / `countryCode` inputs to two cross-field CHECKs, so a partial edit re-creates
 *                          the 23514-as-500 trap the market-insight quad avoids by nesting.
 *   `parentRegionId`       self-referential, so a re-parent is the ONE operation on this
 *                          table that could create a cycle — and it silently re-aggregates
 *                          the macro-region rollup the demand leaderboard groups by.
 *                          Freezing makes the cycle question unrepresentable instead of
 *                          needing an ancestor walk on every write.
 */
export async function updateDiscoveryRegionLabel(
  actorUserId: string,
  regionId: string,
  displayLabel: string,
): Promise<Result<DiscoveryRegionAdminView, DiscoveryVocabularyError>> {
  // 1. CAPABILITY FIRST.
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_taxonomy");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  // 2. Resources second.
  const [updated] = await db
    .update(discoveryRegion)
    .set({ label: displayLabel })
    .where(eq(discoveryRegion.id, regionId))
    .returning(REGION_VIEW_COLUMNS);

  if (!updated) {
    return { success: false, error: { type: "DISCOVERY_REGION_NOT_FOUND", regionId } };
  }
  return { success: true, value: updated };
}

/**
 * `DELETE /discovery/admin/regions/:regionId` — erases an unreferenced region.
 *
 * THE PRE-COUNT ON `talent_profile` IS NOT BELT-AND-BRACES, it is the only protection.
 * Seven FKs into this table are `restrict` and Postgres refuses those. `talent_profile.regionId`
 * is `ON DELETE SET NULL` — so without this check the delete SUCCEEDS, silently blanks the
 * region on every profile that used it, and drops them out of the `?region=` facet with
 * nothing raised anywhere. An FK configured to overwrite cannot also protect.
 *
 * Everything else is left to `restrict` and translated on the way out.
 */
export async function deleteDiscoveryRegion(
  actorUserId: string,
  regionId: string,
): Promise<Result<{ readonly deleted: true }, DiscoveryVocabularyError>> {
  // 1. CAPABILITY FIRST.
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_taxonomy");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  // 2. Resources second — and the SET NULL reference before anything else.
  const [citingProfiles] = await db
    .select({ total: count() })
    .from(talentProfile)
    .where(eq(talentProfile.regionId, regionId));

  if ((citingProfiles?.total ?? 0) > 0) {
    return { success: false, error: { type: "REGION_HAS_REFERENCES" } };
  }

  try {
    const [deleted] = await db
      .delete(discoveryRegion)
      .where(eq(discoveryRegion.id, regionId))
      .returning({ id: discoveryRegion.id });

    if (!deleted) {
      return { success: false, error: { type: "DISCOVERY_REGION_NOT_FOUND", regionId } };
    }
  } catch (error: unknown) {
    // The other seven, including the self-referential parent link.
    if (isForeignKeyViolation(error)) {
      return { success: false, error: { type: "REGION_HAS_REFERENCES" } };
    }
    throw error;
  }

  return { success: true, value: { deleted: true } };
}

/** `GET /discovery/admin/skills` — the full vocabulary, retired entries included. */
export async function listDiscoverySkillsForModerator(
  actorUserId: string,
): Promise<Result<readonly DiscoverySkillAdminView[], DiscoveryVocabularyError>> {
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_taxonomy");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  // The public read filters `isActive`; a moderator needs to see what they retired, or
  // reactivating it is impossible.
  const rows = await db
    .select(SKILL_VIEW_COLUMNS)
    .from(discoverySkill)
    .orderBy(asc(discoverySkill.label), asc(discoverySkill.id));

  return { success: true, value: rows };
}

/** Regions that have lost their parent are impossible; this is a plain ordered read. */
export async function listDiscoveryRegionsForModerator(
  actorUserId: string,
): Promise<Result<readonly DiscoveryRegionAdminView[], DiscoveryVocabularyError>> {
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_taxonomy");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  const rows = await db
    .select(REGION_VIEW_COLUMNS)
    .from(discoveryRegion)
    .orderBy(asc(discoveryRegion.kind), asc(discoveryRegion.label), asc(discoveryRegion.id));

  return { success: true, value: rows };
}
