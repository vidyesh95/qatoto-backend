import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  discoveryRegion,
  discoverySkill,
  talentCompensationAsk,
  talentProfile,
  talentProfileSkill,
  user,
} from "#src/db/schema.js";
import {
  DISCOVERY_REGION_REF_COLUMNS,
  type DiscoveryRegionRef,
} from "#src/services/discovery-catalog.service.js";
import type { Result } from "#src/types/index.js";

/**
 * The opt-in talent directory (R_AND_D_BACKEND_STRUCTURE.md §6, §11b).
 *
 * A PROJECTION OF `user`, NOT A PARALLEL IDENTITY. `name` and `avatarImageUrl` are JOINED
 * from `user` on every read and never copied into `talent_profile` — a copy drifts the
 * moment someone changes their photo, which is the same rule `project_member` follows for
 * TeamMember.name.
 *
 * VISIBILITY IS NEVER A SIDE EFFECT OF AN EDIT. A profile is created `private` and only
 * `publish` moves it, so a directory listing can never appear because someone tweaked
 * their headline.
 */

export type TalentProfileError =
  | { type: "TALENT_PROFILE_NOT_FOUND" }
  | { type: "SKILL_NOT_FOUND"; skillSlugs: readonly string[] }
  | { type: "REGION_NOT_FOUND"; regionId: string }
  | { type: "DUPLICATE_COMPENSATION_KIND"; kind: string }
  | { type: "COMPENSATION_RANGE_INVALID"; kind: string }
  | { type: "INCOMPLETE_FOR_PUBLISH"; missing: readonly string[] }
  | { type: "ALREADY_PUBLISHED" }
  | { type: "NOT_PUBLISHED" };

export interface TalentSkillView {
  readonly slug: string;
  readonly displayLabel: string;
  /**
   * Job-written only. Means §9 recorded verified effort on a project tagged with this
   * skill — if a request could set it the badge would mean nothing, which IS the column's
   * entire purpose.
   */
  readonly isVerified: boolean;
}

/**
 * Mirrors §5's open_role_compensation as a DISCRIMINATED UNION rather than a bag of
 * optionals, so an equity ask carrying a salary range is unrepresentable on the wire.
 */
export type TalentCompensationAskView =
  | {
      readonly kind: "salary";
      readonly salaryMinInCentsPerMonth: number;
      readonly salaryMaxInCentsPerMonth: number | null;
      readonly currency: string;
    }
  | {
      readonly kind: "one_time";
      readonly oneTimeMinInCents: number;
      readonly oneTimeMaxInCents: number | null;
      readonly currency: string;
    }
  | {
      readonly kind: "equity";
      readonly equityBasisPointsMin: number;
      readonly equityBasisPointsMax: number | null;
    };

export interface TalentProfileView {
  readonly userId: string;
  readonly name: string;
  readonly handle: string | null;
  readonly avatarImageUrl: string | null;
  readonly headlineRole: string;
  readonly bio: string | null;
  readonly availability: (typeof talentProfile.$inferSelect)["availability"];
  readonly commitment: (typeof talentProfile.$inferSelect)["commitment"];
  readonly locationLabel: string | null;
  readonly region: DiscoveryRegionRef | null;
  readonly skills: readonly TalentSkillView[];
  readonly compensationAsks: readonly TalentCompensationAskView[];
  /** Integer MINUTES. Was `effortHoursLogged: 148`. NULL until §9 exists — never 0. */
  readonly verifiedEffortMinutes: number | null;
  readonly projectsCompletedCount: number | null;
  /** ISO-8601 UTC. Returned so clients render "as of" rather than implying live data. */
  readonly projectionComputedAt: string | null;
  readonly profileUpdatedAt: string;
}

export interface TalentProfileMeView extends TalentProfileView {
  readonly isPublished: boolean;
  readonly publishedAt: string | null;
  /**
   * A HINT for the client's publish button, never the check. `publishTalentProfile`
   * re-derives this server-side at request time (§0) — the client's copy exists only so
   * the button can be disabled before the round trip.
   */
  readonly completeness: {
    readonly isPublishable: boolean;
    readonly missing: readonly string[];
  };
}

export interface TalentProfileInput {
  readonly headlineRole: string;
  readonly availability: (typeof talentProfile.$inferSelect)["availability"];
  readonly commitment?: (typeof talentProfile.$inferSelect)["commitment"];
  readonly locationLabel?: string | null;
  readonly regionId?: string | null;
  readonly bio?: string | null;
  readonly skillSlugs: readonly string[];
  readonly compensationAsks: readonly TalentCompensationAskInput[];
}

export type TalentCompensationAskInput =
  | {
      readonly kind: "salary";
      readonly salaryMinInCentsPerMonth: number;
      readonly salaryMaxInCentsPerMonth?: number;
    }
  | {
      readonly kind: "one_time";
      readonly oneTimeMinInCents: number;
      readonly oneTimeMaxInCents?: number;
    }
  | {
      readonly kind: "equity";
      readonly equityBasisPointsMin: number;
      readonly equityBasisPointsMax?: number;
    };

/** What a profile must have before it may appear in the directory. */
function findMissingPublishRequirements(profile: {
  readonly headlineRole: string;
  readonly skillCount: number;
}): readonly string[] {
  const missing: string[] = [];
  if (profile.headlineRole.trim().length === 0) missing.push("headlineRole");
  // At least one skill, or the profile is unfindable by the only filter that matters.
  if (profile.skillCount === 0) missing.push("skills");
  return missing;
}

function toCompensationAskView(
  row: typeof talentCompensationAsk.$inferSelect,
  currency: string,
): TalentCompensationAskView | null {
  // The CHECK constraint guarantees the kind-appropriate column is non-null, so a null
  // here means the row violates its own constraint — skip rather than emit a broken
  // strand, and let the reconciliation script find it.
  switch (row.kind) {
    case "salary":
      return row.salaryMinInCentsPerMonth === null
        ? null
        : {
            kind: "salary",
            salaryMinInCentsPerMonth: row.salaryMinInCentsPerMonth,
            salaryMaxInCentsPerMonth: row.salaryMaxInCentsPerMonth,
            currency,
          };
    case "one_time":
      return row.oneTimeMinInCents === null
        ? null
        : {
            kind: "one_time",
            oneTimeMinInCents: row.oneTimeMinInCents,
            oneTimeMaxInCents: row.oneTimeMaxInCents,
            currency,
          };
    case "equity":
      return row.equityBasisPointsMin === null
        ? null
        : {
            kind: "equity",
            equityBasisPointsMin: row.equityBasisPointsMin,
            equityBasisPointsMax: row.equityBasisPointsMax,
          };
    default: {
      // A new compensation kind without a projection here breaks the build, which is the
      // point (CLAUDE.md §3.2).
      const exhaustiveCheck: never = row.kind;
      throw new Error(`Unhandled compensation kind: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

const TALENT_PROFILE_COLUMNS = {
  userId: talentProfile.userId,
  headlineRole: talentProfile.headlineRole,
  bio: talentProfile.bio,
  availability: talentProfile.availability,
  commitment: talentProfile.commitment,
  locationLabel: talentProfile.locationLabel,
  visibility: talentProfile.visibility,
  publishedAt: talentProfile.publishedAt,
  currency: talentProfile.currency,
  cachedEffortMinutesLogged: talentProfile.cachedEffortMinutesLogged,
  cachedProjectsCompletedCount: talentProfile.cachedProjectsCompletedCount,
  projectionComputedAt: talentProfile.projectionComputedAt,
  updatedAt: talentProfile.updatedAt,
  // Joined from `user`, never stored — a copy drifts on the next avatar change.
  name: user.name,
  handle: user.handle,
  avatarImageUrl: user.image,
  region: DISCOVERY_REGION_REF_COLUMNS,
} as const;

async function loadSkillsAndAsks(
  profileUserIds: readonly string[],
): Promise<{
  readonly skillsByUser: Map<string, TalentSkillView[]>;
  readonly askRowsByUser: Map<string, (typeof talentCompensationAsk.$inferSelect)[]>;
}> {
  if (profileUserIds.length === 0) {
    return { skillsByUser: new Map(), askRowsByUser: new Map() };
  }

  const [skillRows, askRows] = await Promise.all([
    db
      .select({
        talentProfileUserId: talentProfileSkill.talentProfileUserId,
        slug: discoverySkill.slug,
        displayLabel: discoverySkill.label,
        isVerified: talentProfileSkill.isVerified,
      })
      .from(talentProfileSkill)
      .innerJoin(discoverySkill, eq(talentProfileSkill.skillId, discoverySkill.id))
      .where(inArray(talentProfileSkill.talentProfileUserId, [...profileUserIds]))
      .orderBy(asc(discoverySkill.label), asc(discoverySkill.slug)),
    db
      .select()
      .from(talentCompensationAsk)
      .where(inArray(talentCompensationAsk.talentProfileUserId, [...profileUserIds]))
      .orderBy(asc(talentCompensationAsk.kind), asc(talentCompensationAsk.id)),
  ]);

  const skillsByUser = new Map<string, TalentSkillView[]>();
  for (const row of skillRows) {
    const existing = skillsByUser.get(row.talentProfileUserId) ?? [];
    existing.push({ slug: row.slug, displayLabel: row.displayLabel, isVerified: row.isVerified });
    skillsByUser.set(row.talentProfileUserId, existing);
  }

  const askRowsByUser = new Map<string, (typeof talentCompensationAsk.$inferSelect)[]>();
  for (const row of askRows) {
    const existing = askRowsByUser.get(row.talentProfileUserId) ?? [];
    existing.push(row);
    askRowsByUser.set(row.talentProfileUserId, existing);
  }

  return { skillsByUser, askRowsByUser };
}

interface TalentProfileRow {
  readonly userId: string;
  readonly headlineRole: string;
  readonly bio: string | null;
  readonly availability: (typeof talentProfile.$inferSelect)["availability"];
  readonly commitment: (typeof talentProfile.$inferSelect)["commitment"];
  readonly locationLabel: string | null;
  readonly visibility: (typeof talentProfile.$inferSelect)["visibility"];
  readonly publishedAt: Date | null;
  readonly currency: string;
  readonly cachedEffortMinutesLogged: number | null;
  readonly cachedProjectsCompletedCount: number | null;
  readonly projectionComputedAt: Date | null;
  readonly updatedAt: Date;
  readonly name: string;
  readonly handle: string | null;
  readonly avatarImageUrl: string | null;
  readonly region: DiscoveryRegionRef | null;
}

function toTalentProfileView(
  row: TalentProfileRow,
  skills: readonly TalentSkillView[],
  askRows: readonly (typeof talentCompensationAsk.$inferSelect)[],
): TalentProfileView {
  const compensationAsks: TalentCompensationAskView[] = [];
  for (const askRow of askRows) {
    const view = toCompensationAskView(askRow, row.currency);
    if (view) compensationAsks.push(view);
  }

  return {
    userId: row.userId,
    name: row.name,
    handle: row.handle,
    avatarImageUrl: row.avatarImageUrl,
    headlineRole: row.headlineRole,
    bio: row.bio,
    availability: row.availability,
    commitment: row.commitment,
    locationLabel: row.locationLabel,
    region: row.region,
    skills,
    compensationAsks,
    verifiedEffortMinutes: row.cachedEffortMinutesLogged,
    projectsCompletedCount: row.cachedProjectsCompletedCount,
    projectionComputedAt: row.projectionComputedAt?.toISOString() ?? null,
    profileUpdatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The caller's own profile, or null when they have not opted in.
 *
 * NULL RATHER THAN AN ERROR is deliberate: this is an opt-in surface where "you have no
 * profile" is a perfectly normal successful state, and 404ing it would force every client
 * to treat an error status as success.
 */
export async function findMyTalentProfile(userId: string): Promise<TalentProfileMeView | null> {
  const [row] = await db
    .select(TALENT_PROFILE_COLUMNS)
    .from(talentProfile)
    .innerJoin(user, eq(talentProfile.userId, user.id))
    .leftJoin(discoveryRegion, eq(talentProfile.regionId, discoveryRegion.id))
    .where(eq(talentProfile.userId, userId));

  if (!row) return null;

  const { skillsByUser, askRowsByUser } = await loadSkillsAndAsks([userId]);
  const skills = skillsByUser.get(userId) ?? [];
  const missing = findMissingPublishRequirements({
    headlineRole: row.headlineRole,
    skillCount: skills.length,
  });

  return {
    ...toTalentProfileView(row, skills, askRowsByUser.get(userId) ?? []),
    isPublished: row.visibility === "published",
    publishedAt: row.publishedAt?.toISOString() ?? null,
    completeness: { isPublishable: missing.length === 0, missing },
  };
}

const TALENT_SORTS = ["recent", "effort"] as const;
export type TalentSort = (typeof TALENT_SORTS)[number];

export interface TalentListFilter {
  readonly commitment?: (typeof talentProfile.$inferSelect)["commitment"];
  readonly skillSlugs?: readonly string[];
  readonly availability?: (typeof talentProfile.$inferSelect)["availability"];
  readonly regionSlug?: string;
  readonly sort: TalentSort;
  readonly page: number;
  readonly limit: number;
}

export interface TalentListPage {
  readonly rows: readonly TalentProfileView[];
  readonly total: number;
}

/**
 * The public directory.
 *
 * `visibility = 'published'` is HARD-CODED, not derived from a query parameter — so there
 * is no param a caller could supply that surfaces an unpublished profile.
 *
 * Multiple `?skill=` values are ANDed via GROUP BY … HAVING COUNT(DISTINCT) = n, which is
 * what a row of filter chips means. Matching is on SLUG EQUALITY, which is the structural
 * fix for the live substring bug where a "Water" chip matched "Water Polo".
 */
export async function listTalentProfiles(filter: TalentListFilter): Promise<TalentListPage> {
  const conditions = [eq(talentProfile.visibility, "published")];
  if (filter.commitment) conditions.push(eq(talentProfile.commitment, filter.commitment));
  if (filter.availability) conditions.push(eq(talentProfile.availability, filter.availability));
  if (filter.regionSlug) conditions.push(eq(discoveryRegion.slug, filter.regionSlug));

  const requestedSkillSlugs = filter.skillSlugs ?? [];
  if (requestedSkillSlugs.length > 0) {
    const matchingUserIds = db
      .select({ userId: talentProfileSkill.talentProfileUserId })
      .from(talentProfileSkill)
      .innerJoin(discoverySkill, eq(talentProfileSkill.skillId, discoverySkill.id))
      .where(inArray(discoverySkill.slug, [...requestedSkillSlugs]))
      .groupBy(talentProfileSkill.talentProfileUserId)
      .having(sql`count(distinct ${discoverySkill.slug}) = ${requestedSkillSlugs.length}`);

    conditions.push(inArray(talentProfile.userId, matchingUserIds));
  }

  const whereClause = and(...conditions);

  // NULLS LAST on the effort sort, for the same reason as the cluster score: the column is
  // NULL until §9's ledger exists, and Postgres would otherwise float every unmeasured
  // profile to the top. Both branches end in the unique userId (§4c rule 4).
  const orderBy =
    filter.sort === "effort"
      ? [
          sql`${talentProfile.cachedEffortMinutesLogged} DESC NULLS LAST`,
          desc(talentProfile.updatedAt),
          desc(talentProfile.userId),
        ]
      : [desc(talentProfile.updatedAt), desc(talentProfile.userId)];

  const [rows, [totalRow]] = await Promise.all([
    db
      .select(TALENT_PROFILE_COLUMNS)
      .from(talentProfile)
      .innerJoin(user, eq(talentProfile.userId, user.id))
      .leftJoin(discoveryRegion, eq(talentProfile.regionId, discoveryRegion.id))
      .where(whereClause)
      .orderBy(...orderBy)
      .limit(filter.limit)
      .offset((filter.page - 1) * filter.limit),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(talentProfile)
      .innerJoin(user, eq(talentProfile.userId, user.id))
      .leftJoin(discoveryRegion, eq(talentProfile.regionId, discoveryRegion.id))
      .where(whereClause),
  ]);

  const { skillsByUser, askRowsByUser } = await loadSkillsAndAsks(rows.map((row) => row.userId));

  return {
    rows: rows.map((row) =>
      toTalentProfileView(row, skillsByUser.get(row.userId) ?? [], askRowsByUser.get(row.userId) ?? []),
    ),
    total: totalRow?.total ?? 0,
  };
}

/** Cross-field validation a Zod schema cannot express: max must not undercut min. */
function findCompensationRangeError(
  asks: readonly TalentCompensationAskInput[],
): TalentProfileError | null {
  const seenKinds = new Set<string>();

  for (const ask of asks) {
    if (seenKinds.has(ask.kind)) {
      return { type: "DUPLICATE_COMPENSATION_KIND", kind: ask.kind };
    }
    seenKinds.add(ask.kind);

    switch (ask.kind) {
      case "salary":
        if (
          ask.salaryMaxInCentsPerMonth !== undefined &&
          ask.salaryMaxInCentsPerMonth < ask.salaryMinInCentsPerMonth
        ) {
          return { type: "COMPENSATION_RANGE_INVALID", kind: ask.kind };
        }
        break;
      case "one_time":
        if (ask.oneTimeMaxInCents !== undefined && ask.oneTimeMaxInCents < ask.oneTimeMinInCents) {
          return { type: "COMPENSATION_RANGE_INVALID", kind: ask.kind };
        }
        break;
      case "equity":
        if (
          ask.equityBasisPointsMax !== undefined &&
          ask.equityBasisPointsMax < ask.equityBasisPointsMin
        ) {
          return { type: "COMPENSATION_RANGE_INVALID", kind: ask.kind };
        }
        break;
      default: {
        const exhaustiveCheck: never = ask;
        throw new Error(`Unhandled compensation ask: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  }

  return null;
}

/**
 * Creates or replaces the caller's profile, wholesale.
 *
 * PUT rather than PATCH because the profile is a value object: "remove my equity ask" and
 * "clear my location" are only expressible as a full replacement. Skills and asks are
 * therefore deleted and re-inserted inside the transaction rather than diffed.
 *
 * A FIRST CREATE ALWAYS LANDS `private`. Publishing is a separate explicit action.
 */
export async function upsertTalentProfile(
  userId: string,
  input: TalentProfileInput,
): Promise<Result<TalentProfileMeView, TalentProfileError>> {
  const rangeError = findCompensationRangeError(input.compensationAsks);
  if (rangeError) {
    return { success: false, error: rangeError };
  }

  // Skills are validated as a SUBSET of the canonical vocabulary, so an unknown slug is a
  // typed 422 naming the offenders rather than a silent taxonomy insert.
  const requestedSlugs = [...new Set(input.skillSlugs)];
  const knownSkills =
    requestedSlugs.length === 0
      ? []
      : await db
          .select({ id: discoverySkill.id, slug: discoverySkill.slug })
          .from(discoverySkill)
          .where(and(inArray(discoverySkill.slug, requestedSlugs), eq(discoverySkill.isActive, true)));

  if (knownSkills.length !== requestedSlugs.length) {
    const knownSlugSet = new Set(knownSkills.map((skill) => skill.slug));
    return {
      success: false,
      error: {
        type: "SKILL_NOT_FOUND",
        skillSlugs: requestedSlugs.filter((slug) => !knownSlugSet.has(slug)),
      },
    };
  }

  if (input.regionId) {
    const [region] = await db
      .select({ id: discoveryRegion.id })
      .from(discoveryRegion)
      .where(eq(discoveryRegion.id, input.regionId));
    if (!region) {
      return { success: false, error: { type: "REGION_NOT_FOUND", regionId: input.regionId } };
    }
  }

  await db.transaction(async (tx) => {
    await tx
      .insert(talentProfile)
      .values({
        userId,
        headlineRole: input.headlineRole,
        bio: input.bio ?? null,
        locationLabel: input.locationLabel ?? null,
        regionId: input.regionId ?? null,
        availability: input.availability,
        commitment: input.commitment ?? null,
        // `visibility` and `currency` are absent from the input by construction — the
        // first is its own action, the second is server-owned (§4b).
      })
      .onConflictDoUpdate({
        target: talentProfile.userId,
        set: {
          headlineRole: input.headlineRole,
          bio: input.bio ?? null,
          locationLabel: input.locationLabel ?? null,
          regionId: input.regionId ?? null,
          availability: input.availability,
          commitment: input.commitment ?? null,
        },
      });

    // Wholesale replacement, matching the PUT semantics.
    await tx.delete(talentProfileSkill).where(eq(talentProfileSkill.talentProfileUserId, userId));
    if (knownSkills.length > 0) {
      await tx.insert(talentProfileSkill).values(
        knownSkills.map((skill) => ({
          talentProfileUserId: userId,
          skillId: skill.id,
          // isVerified is job-written and deliberately not carried over: a re-verified
          // badge must be re-earned from §9's ledger, never preserved through an edit.
        })),
      );
    }

    await tx
      .delete(talentCompensationAsk)
      .where(eq(talentCompensationAsk.talentProfileUserId, userId));
    if (input.compensationAsks.length > 0) {
      await tx.insert(talentCompensationAsk).values(
        input.compensationAsks.map((ask) => ({
          talentProfileUserId: userId,
          kind: ask.kind,
          salaryMinInCentsPerMonth: ask.kind === "salary" ? ask.salaryMinInCentsPerMonth : null,
          salaryMaxInCentsPerMonth:
            ask.kind === "salary" ? (ask.salaryMaxInCentsPerMonth ?? null) : null,
          oneTimeMinInCents: ask.kind === "one_time" ? ask.oneTimeMinInCents : null,
          oneTimeMaxInCents: ask.kind === "one_time" ? (ask.oneTimeMaxInCents ?? null) : null,
          equityBasisPointsMin: ask.kind === "equity" ? ask.equityBasisPointsMin : null,
          equityBasisPointsMax: ask.kind === "equity" ? (ask.equityBasisPointsMax ?? null) : null,
        })),
      );
    }
  });

  const saved = await findMyTalentProfile(userId);
  if (!saved) {
    throw new Error("upsertTalentProfile: profile vanished immediately after write");
  }
  return { success: true, value: saved };
}

/** Removes the caller from the directory entirely. A content table, so a real delete. */
export async function deleteTalentProfile(
  userId: string,
): Promise<Result<{ readonly deleted: true }, TalentProfileError>> {
  const deleted = await db
    .delete(talentProfile)
    .where(eq(talentProfile.userId, userId))
    .returning({ userId: talentProfile.userId });

  if (deleted.length === 0) {
    return { success: false, error: { type: "TALENT_PROFILE_NOT_FOUND" } };
  }
  return { success: true, value: { deleted: true } };
}

/**
 * Publishes or unpublishes the caller's profile.
 *
 * THE PUBLISH GATE IS RE-DERIVED HERE, server-side, at request time. The
 * `completeness` block on the GET is a hint for disabling a button; this is the check
 * (§0 — the client's copy is never the authority).
 */
export async function setTalentProfilePublished(
  userId: string,
  shouldPublish: boolean,
): Promise<Result<TalentProfileMeView, TalentProfileError>> {
  const existing = await findMyTalentProfile(userId);
  if (!existing) {
    return { success: false, error: { type: "TALENT_PROFILE_NOT_FOUND" } };
  }

  if (shouldPublish && existing.isPublished) {
    return { success: false, error: { type: "ALREADY_PUBLISHED" } };
  }
  if (!shouldPublish && !existing.isPublished) {
    return { success: false, error: { type: "NOT_PUBLISHED" } };
  }

  if (shouldPublish && !existing.completeness.isPublishable) {
    return {
      success: false,
      error: { type: "INCOMPLETE_FOR_PUBLISH", missing: existing.completeness.missing },
    };
  }

  await db
    .update(talentProfile)
    .set({
      visibility: shouldPublish ? "published" : "private",
      // talent_profile_published_at_ck ties these two together, so they move as a pair.
      publishedAt: shouldPublish ? new Date() : null,
    })
    .where(eq(talentProfile.userId, userId));

  const updated = await findMyTalentProfile(userId);
  if (!updated) {
    throw new Error("setTalentProfilePublished: profile vanished immediately after write");
  }
  return { success: true, value: updated };
}
