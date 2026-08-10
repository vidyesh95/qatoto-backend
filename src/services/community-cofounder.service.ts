import { and, asc, desc, eq, exists, inArray, isNotNull, lt, or, sql, type SQL } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  communityCofounderPriorVenture,
  communityCofounderProfile,
  communityCofounderProfileContribution,
  communityCofounderProfileLanguage,
  communityCofounderProfileSector,
  communityModerationAction,
} from "#src/db/schema.js";
import { isIdentifiedUser } from "#src/middleware/require-identified-user.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import { decodeTimestampStoreCursor, encodeStoreCursor } from "#src/lib/store-cursor.js";
import { appendPlatformAuditEntry } from "#src/services/platform-audit.service.js";
import { requirePlatformCapability } from "#src/services/platform-role.service.js";
import type { Result } from "#src/types/index.js";

/**
 * The cofounder directory (STORE_BACKEND_STRUCTURE.md §18, Appendix A34).
 *
 * FOUR RULES ENFORCED HERE, because a rule that lives only on the frontend is a comment on
 * code an attacker can edit:
 *
 * 1. A STATED CAPITAL RANGE IS NOT STORED AT ALL. §14 has not decided whether Qatoto may
 *    publish one beside an equity expectation, and its instruction is literal: until it
 *    does, the backend stores no capital figure it would then have to publish. Both wire
 *    fields therefore serve `null` — see `UNDECIDED_CAPITAL_DISCLOSURE` below.
 * 2. A PROFILE IS NOT AN OFFER AND QATOTO IS NOT A BROKER. There is no ranking anywhere in
 *    this file and the directory read takes no `sort` parameter, because a ranking here
 *    could read as a platform recommendation about a person. Ordering is deterministic and
 *    boring on purpose.
 * 3. THIS IS NOT EQUITY. Nothing here mints, holds, transfers or records a stake.
 * 4. `identity_verified` MEANS ONLY THAT THIS PERSON IS WHO THEY SAY THEY ARE. It is
 *    derived from `isIdentifiedUser` — the same predicate `requireIdentifiedUser` enforces
 *    — so there is exactly one definition of "identified" on this platform, and it says
 *    nothing about anybody's capital, track record or reach.
 */

type ProfileRow = typeof communityCofounderProfile.$inferSelect;
type ContributionKind =
  (typeof communityCofounderProfileContribution.$inferSelect)["contributionKind"];
type CommitmentLevel = ProfileRow["commitmentLevel"];
type EngagementState = ProfileRow["engagementState"];
type ProfileState = ProfileRow["state"];

export type CommunityCofounderError =
  | { type: "NOT_FOUND" }
  | { type: "INVALID_CURSOR" }
  | { type: "INVALID_STATE"; message: string }
  | { type: "CONFLICT"; message: string }
  | { type: "NAME_UNUSABLE" }
  | { type: "PROFILE_EXISTS" }
  | { type: "PLATFORM_CAPABILITY_REQUIRED"; capability: string };

/**
 * WHAT THIS SURFACE PUBLISHES ABOUT MONEY, AND IT IS NOTHING (§14).
 *
 * These two are `null` in every projection because the columns behind them DO NOT EXIST.
 * That is deliberate and load-bearing: a stored figure withheld by a projection is one
 * careless edit from being published, and the deferral is a legal question per market, not
 * a rendering preference.
 *
 * When §14 lands, this constant is what a reviewer greps for. Do not "fix" it into a column
 * read without that decision in hand.
 */
const UNDECIDED_CAPITAL_DISCLOSURE = {
  capitalRange: null,
  equityExpectationBasisPoints: null,
} as const;

const SLUG_ATTEMPTS = 12;
const MAXIMUM_SECTORS = 8;
const MAXIMUM_LANGUAGES = 8;
const MAXIMUM_PRIOR_VENTURES = 8;

function slugifyDisplayName(displayName: string): string {
  return displayName
    .normalize("NFD")
    .replaceAll(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 90)
    .replaceAll(/-+$/gu, "");
}

export interface CofounderProfileCardProjection {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly headline: string;
  readonly countryCode: string;
  readonly avatarUrl: string | null;
  readonly contributionKinds: readonly ContributionKind[];
  readonly commitmentLevel: CommitmentLevel;
  readonly engagementState: EngagementState;
  readonly identityState: "unverified" | "identity_verified";
  /** Always `null`. See `UNDECIDED_CAPITAL_DISCLOSURE`. */
  readonly capitalRange: null;
  /** Always `null`. See `UNDECIDED_CAPITAL_DISCLOSURE`. */
  readonly equityExpectationBasisPoints: null;
  readonly sectors: readonly string[];
}

export interface CofounderPriorVentureProjection {
  readonly id: string;
  readonly name: string;
  readonly roleLabel: string;
  readonly yearsActiveLabel: string;
  readonly outcomeSummary: string | null;
}

export interface CofounderProfileDetailProjection {
  readonly profile: CofounderProfileCardProjection;
  readonly bio: string;
  readonly lookingFor: string;
  readonly priorVentures: readonly CofounderPriorVentureProjection[];
  readonly languages: readonly string[];
  readonly publishedAt: Date | null;
}

/** The owner's view. Adds the lifecycle the public read has no business seeing. */
export interface OwnedCofounderProfileProjection extends CofounderProfileDetailProjection {
  readonly state: ProfileState;
  readonly decisionReason: string | null;
  readonly createdAt: Date;
}

export interface CofounderDirectoryPage {
  readonly items: readonly CofounderProfileCardProjection[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

interface ProfileSideLoads {
  readonly contributionsByProfile: ReadonlyMap<string, ContributionKind[]>;
  readonly sectorsByProfile: ReadonlyMap<string, string[]>;
  readonly identityByUserId: ReadonlyMap<string, boolean>;
}

async function loadProfileSides(rows: readonly ProfileRow[]): Promise<ProfileSideLoads> {
  const profileIds = rows.map((row) => row.id);
  const userIds = [...new Set(rows.map((row) => row.userId))];

  const [contributionRows, sectorRows, identityFlags] = await Promise.all([
    profileIds.length === 0
      ? Promise.resolve([])
      : db
          .select()
          .from(communityCofounderProfileContribution)
          .where(inArray(communityCofounderProfileContribution.profileId, profileIds))
          .orderBy(
            asc(communityCofounderProfileContribution.profileId),
            asc(communityCofounderProfileContribution.contributionKind),
          ),
    profileIds.length === 0
      ? Promise.resolve([])
      : db
          .select()
          .from(communityCofounderProfileSector)
          .where(inArray(communityCofounderProfileSector.profileId, profileIds))
          .orderBy(
            asc(communityCofounderProfileSector.profileId),
            asc(communityCofounderProfileSector.sectorLabel),
          ),
    /**
     * ONE `isIdentifiedUser` CALL PER DISTINCT AUTHOR, not per row, and deliberately not
     * cached — a cache stale in the wrong direction would publish a badge the predicate no
     * longer supports.
     */
    Promise.all(userIds.map(async (userId) => [userId, await isIdentifiedUser(userId)] as const)),
  ]);

  const contributionsByProfile = new Map<string, ContributionKind[]>();
  for (const row of contributionRows) {
    const existing = contributionsByProfile.get(row.profileId) ?? [];
    existing.push(row.contributionKind);
    contributionsByProfile.set(row.profileId, existing);
  }
  const sectorsByProfile = new Map<string, string[]>();
  for (const row of sectorRows) {
    const existing = sectorsByProfile.get(row.profileId) ?? [];
    existing.push(row.sectorLabel);
    sectorsByProfile.set(row.profileId, existing);
  }

  return {
    contributionsByProfile,
    sectorsByProfile,
    identityByUserId: new Map(identityFlags),
  };
}

function projectCard(row: ProfileRow, sides: ProfileSideLoads): CofounderProfileCardProjection {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    headline: row.headline,
    countryCode: row.countryCode,
    avatarUrl: row.avatarUrl,
    contributionKinds: sides.contributionsByProfile.get(row.id) ?? [],
    commitmentLevel: row.commitmentLevel,
    engagementState: row.engagementState,
    identityState:
      sides.identityByUserId.get(row.userId) === true ? "identity_verified" : "unverified",
    ...UNDECIDED_CAPITAL_DISCLOSURE,
    sectors: sides.sectorsByProfile.get(row.id) ?? [],
  };
}

async function projectCards(
  rows: readonly ProfileRow[],
): Promise<CofounderProfileCardProjection[]> {
  if (rows.length === 0) return [];
  const sides = await loadProfileSides(rows);
  return rows.map((row) => projectCard(row, sides));
}

async function projectDetail(row: ProfileRow): Promise<CofounderProfileDetailProjection> {
  const [cards, ventureRows, languageRows] = await Promise.all([
    projectCards([row]),
    db
      .select()
      .from(communityCofounderPriorVenture)
      .where(eq(communityCofounderPriorVenture.profileId, row.id))
      .orderBy(asc(communityCofounderPriorVenture.position)),
    db
      .select()
      .from(communityCofounderProfileLanguage)
      .where(eq(communityCofounderProfileLanguage.profileId, row.id))
      .orderBy(asc(communityCofounderProfileLanguage.languageCode)),
  ]);

  const card = cards[0];
  if (!card) throw new Error("Cofounder card projection vanished after its own row was read.");

  return {
    profile: card,
    bio: row.bio,
    lookingFor: row.lookingFor,
    priorVentures: ventureRows.map((venture) => ({
      id: venture.id,
      name: venture.name,
      roleLabel: venture.roleLabel,
      yearsActiveLabel: venture.yearsActiveLabel,
      outcomeSummary: venture.outcomeSummary,
    })),
    languages: languageRows.map((language) => language.languageCode),
    publishedAt: row.publishedAt,
  };
}

// ---------------------------------------------------------------------------
// Public reads
// ---------------------------------------------------------------------------

export interface ListCofounderProfilesInput {
  readonly contributionKind?: ContributionKind;
  readonly commitmentLevel?: CommitmentLevel;
  readonly countryCode?: string;
  readonly limit: number;
  readonly cursor?: string;
}

/**
 * `GET /store/cofounder-profiles`.
 *
 * NO `sort` KEY AND NO `state` KEY, and both absences are rules rather than omissions.
 * Ordering is newest-published first and nothing else, because a ranking could read as a
 * recommendation; and `not_looking` profiles STAY IN THE LIST, because a profile is also a
 * record and hiding one makes a person who is mid-conversation look as though they had left.
 */
export async function listCofounderProfiles(
  input: ListCofounderProfilesInput,
): Promise<Result<CofounderDirectoryPage, CommunityCofounderError>> {
  const decodedCursor =
    input.cursor === undefined ? null : decodeTimestampStoreCursor(input.cursor);
  if (input.cursor !== undefined && decodedCursor === null) {
    return { success: false, error: { type: "INVALID_CURSOR" } };
  }

  const filters: SQL[] = [
    eq(communityCofounderProfile.state, "published"),
    /** The CHECK guarantees this, and the keyset needs it non-null to be total. */
    isNotNull(communityCofounderProfile.publishedAt),
  ];
  if (input.commitmentLevel !== undefined) {
    filters.push(eq(communityCofounderProfile.commitmentLevel, input.commitmentLevel));
  }
  if (input.countryCode !== undefined) {
    filters.push(eq(communityCofounderProfile.countryCode, input.countryCode));
  }
  if (input.contributionKind !== undefined) {
    const contributionKind = input.contributionKind;
    filters.push(
      exists(
        db
          .select({ present: sql`1` })
          .from(communityCofounderProfileContribution)
          .where(
            and(
              eq(
                communityCofounderProfileContribution.profileId,
                communityCofounderProfile.id,
              ),
              eq(communityCofounderProfileContribution.contributionKind, contributionKind),
            ),
          ),
      ),
    );
  }
  if (decodedCursor !== null) {
    const keyset = or(
      lt(communityCofounderProfile.publishedAt, decodedCursor.sortKey),
      and(
        eq(communityCofounderProfile.publishedAt, decodedCursor.sortKey),
        lt(communityCofounderProfile.id, decodedCursor.id),
      ),
    );
    if (keyset) filters.push(keyset);
  }

  const rows = await db
    .select()
    .from(communityCofounderProfile)
    .where(and(...filters))
    .orderBy(desc(communityCofounderProfile.publishedAt), desc(communityCofounderProfile.id))
    .limit(input.limit + 1);

  const pageRows = rows.slice(0, input.limit);
  const lastRow = pageRows[pageRows.length - 1];
  const hasMore = rows.length > input.limit;
  const nextCursor =
    hasMore && lastRow?.publishedAt
      ? encodeStoreCursor({ sortKey: lastRow.publishedAt.toISOString(), id: lastRow.id })
      : null;

  return {
    success: true,
    value: { items: await projectCards(pageRows), page: { nextCursor, hasMore } },
  };
}

/** `GET /store/cofounder-profiles/:profileSlug`. `published` only. */
export async function getCofounderProfileBySlug(
  profileSlug: string,
): Promise<Result<CofounderProfileDetailProjection, CommunityCofounderError>> {
  const [row] = await db
    .select()
    .from(communityCofounderProfile)
    .where(
      and(
        eq(communityCofounderProfile.slug, profileSlug),
        eq(communityCofounderProfile.state, "published"),
      ),
    )
    .limit(1);
  if (!row) return { success: false, error: { type: "NOT_FOUND" } };
  return { success: true, value: await projectDetail(row) };
}

// ---------------------------------------------------------------------------
// The owner's lifecycle (§18.3)
// ---------------------------------------------------------------------------

export interface CofounderProfileWriteInput {
  readonly displayName: string;
  readonly headline: string;
  readonly bio: string;
  readonly lookingFor: string;
  readonly countryCode: string;
  readonly avatarUrl: string | null;
  readonly commitmentLevel: CommitmentLevel;
  readonly contributionKinds: readonly ContributionKind[];
  readonly sectors: readonly string[];
  readonly languages: readonly string[];
  readonly priorVentures: readonly {
    readonly name: string;
    readonly roleLabel: string;
    readonly yearsActiveLabel: string;
    readonly outcomeSummary: string | null;
  }[];
}

function validateCollectionSizes(
  input: CofounderProfileWriteInput,
): CommunityCofounderError | null {
  if (input.sectors.length > MAXIMUM_SECTORS) {
    return { type: "CONFLICT", message: `At most ${String(MAXIMUM_SECTORS)} sectors are allowed.` };
  }
  if (input.languages.length > MAXIMUM_LANGUAGES) {
    return {
      type: "CONFLICT",
      message: `At most ${String(MAXIMUM_LANGUAGES)} languages are allowed.`,
    };
  }
  if (input.priorVentures.length > MAXIMUM_PRIOR_VENTURES) {
    return {
      type: "CONFLICT",
      message: `At most ${String(MAXIMUM_PRIOR_VENTURES)} prior ventures are allowed.`,
    };
  }
  if (input.contributionKinds.length === 0) {
    return {
      type: "CONFLICT",
      message: "State at least one contribution — it is the thing a founder is short of.",
    };
  }
  return null;
}

/** Delete-then-insert inside the caller's transaction, the `replaceSiteAccess` idiom. */
async function replaceProfileCollections(
  transaction: Parameters<Parameters<typeof db.transaction>[0]>[0],
  profileId: string,
  input: CofounderProfileWriteInput,
): Promise<void> {
  await transaction
    .delete(communityCofounderProfileContribution)
    .where(eq(communityCofounderProfileContribution.profileId, profileId));
  await transaction
    .delete(communityCofounderProfileSector)
    .where(eq(communityCofounderProfileSector.profileId, profileId));
  await transaction
    .delete(communityCofounderProfileLanguage)
    .where(eq(communityCofounderProfileLanguage.profileId, profileId));
  await transaction
    .delete(communityCofounderPriorVenture)
    .where(eq(communityCofounderPriorVenture.profileId, profileId));

  const contributionKinds = [...new Set(input.contributionKinds)];
  if (contributionKinds.length > 0) {
    await transaction
      .insert(communityCofounderProfileContribution)
      .values(contributionKinds.map((contributionKind) => ({ profileId, contributionKind })));
  }
  /** Normalized so "SaaS" and "saas" cannot become two chips on one profile. */
  const sectors = [...new Set(input.sectors.map((sector) => sector.trim().toLowerCase()))];
  if (sectors.length > 0) {
    await transaction
      .insert(communityCofounderProfileSector)
      .values(sectors.map((sectorLabel) => ({ profileId, sectorLabel })));
  }
  const languages = [...new Set(input.languages.map((language) => language.toLowerCase()))];
  if (languages.length > 0) {
    await transaction
      .insert(communityCofounderProfileLanguage)
      .values(languages.map((languageCode) => ({ profileId, languageCode })));
  }
  if (input.priorVentures.length > 0) {
    await transaction.insert(communityCofounderPriorVenture).values(
      input.priorVentures.map((venture, index) => ({
        profileId,
        name: venture.name,
        roleLabel: venture.roleLabel,
        yearsActiveLabel: venture.yearsActiveLabel,
        outcomeSummary: venture.outcomeSummary,
        position: index,
      })),
    );
  }
}

async function projectOwned(row: ProfileRow): Promise<OwnedCofounderProfileProjection> {
  const detail = await projectDetail(row);
  return {
    ...detail,
    state: row.state,
    decisionReason: row.decisionReason,
    createdAt: row.createdAt,
  };
}

/**
 * `POST /community/cofounder-profiles`. ANSWERS `draft`.
 *
 * ONE PROFILE PER PERSON, enforced by the unique index rather than a check-then-insert —
 * two tabs submitting at once must not both pass a check and then collide.
 */
export async function createCofounderProfile(input: {
  readonly userId: string;
  readonly profile: CofounderProfileWriteInput;
}): Promise<Result<OwnedCofounderProfileProjection, CommunityCofounderError>> {
  const sizeError = validateCollectionSizes(input.profile);
  if (sizeError) return { success: false, error: sizeError };

  const baseSlug = slugifyDisplayName(input.profile.displayName);
  if (baseSlug.length < 3) return { success: false, error: { type: "NAME_UNUSABLE" } };

  const [existing] = await db
    .select({ id: communityCofounderProfile.id })
    .from(communityCofounderProfile)
    .where(eq(communityCofounderProfile.userId, input.userId))
    .limit(1);
  if (existing) return { success: false, error: { type: "PROFILE_EXISTS" } };

  for (let attempt = 1; attempt <= SLUG_ATTEMPTS; attempt += 1) {
    const candidateSlug = attempt === 1 ? baseSlug : `${baseSlug}-${String(attempt)}`;
    try {
      const created = await db.transaction(async (transaction) => {
        const [row] = await transaction
          .insert(communityCofounderProfile)
          .values({
            slug: candidateSlug,
            userId: input.userId,
            displayName: input.profile.displayName,
            headline: input.profile.headline,
            bio: input.profile.bio,
            lookingFor: input.profile.lookingFor,
            countryCode: input.profile.countryCode,
            avatarUrl: input.profile.avatarUrl,
            commitmentLevel: input.profile.commitmentLevel,
            state: "draft",
          })
          .returning();
        if (!row) throw new Error("Cofounder profile insert returned no row.");
        await replaceProfileCollections(transaction, row.id, input.profile);
        return row;
      });
      return { success: true, value: await projectOwned(created) };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      /**
       * The `user_id` unique index and the `slug` one raise the same SQLSTATE, so a
       * retry loop that assumed "slug" would spin twelve times on a duplicate profile.
       * Re-read once and stop if the person is the collision.
       */
      const [raced] = await db
        .select({ id: communityCofounderProfile.id })
        .from(communityCofounderProfile)
        .where(eq(communityCofounderProfile.userId, input.userId))
        .limit(1);
      if (raced) return { success: false, error: { type: "PROFILE_EXISTS" } };
    }
  }

  return {
    success: false,
    error: { type: "CONFLICT", message: "Could not mint a unique link for this name." },
  };
}

/** `GET /community/cofounder-profiles/mine`. Any state, including `draft`. */
export async function getMyCofounderProfile(
  userId: string,
): Promise<Result<OwnedCofounderProfileProjection, CommunityCofounderError>> {
  const [row] = await db
    .select()
    .from(communityCofounderProfile)
    .where(eq(communityCofounderProfile.userId, userId))
    .limit(1);
  if (!row) return { success: false, error: { type: "NOT_FOUND" } };
  return { success: true, value: await projectOwned(row) };
}

/**
 * `PATCH /community/cofounder-profiles/mine`.
 *
 * EDITABLE ONLY WHILE `draft` OR `withdrawn`. Everything on this row is content a moderator
 * approved, so changing it after approval must go back through `submit` — otherwise the
 * approval is of text nobody can see any more. The one exception is the engagement state,
 * which has its own route for exactly that reason.
 */
export async function updateMyCofounderProfile(input: {
  readonly userId: string;
  readonly profile: CofounderProfileWriteInput;
}): Promise<Result<OwnedCofounderProfileProjection, CommunityCofounderError>> {
  const sizeError = validateCollectionSizes(input.profile);
  if (sizeError) return { success: false, error: sizeError };

  const outcome = await db.transaction(async (transaction) => {
    const [existing] = await transaction
      .select()
      .from(communityCofounderProfile)
      .where(eq(communityCofounderProfile.userId, input.userId))
      .for("update");
    if (!existing) return { status: "not_found" as const };
    if (existing.state !== "draft" && existing.state !== "withdrawn") {
      return { status: "invalid_state" as const, state: existing.state };
    }

    const [row] = await transaction
      .update(communityCofounderProfile)
      .set({
        displayName: input.profile.displayName,
        headline: input.profile.headline,
        bio: input.profile.bio,
        lookingFor: input.profile.lookingFor,
        countryCode: input.profile.countryCode,
        avatarUrl: input.profile.avatarUrl,
        commitmentLevel: input.profile.commitmentLevel,
        updatedAt: new Date(),
      })
      .where(eq(communityCofounderProfile.id, existing.id))
      .returning();
    if (!row) throw new Error("Cofounder profile update returned no row.");
    await replaceProfileCollections(transaction, row.id, input.profile);
    return { status: "updated" as const, row };
  });

  if (outcome.status === "not_found") return { success: false, error: { type: "NOT_FOUND" } };
  if (outcome.status === "invalid_state") {
    return {
      success: false,
      error: {
        type: "INVALID_STATE",
        message: `A profile in state ${outcome.state} must be withdrawn before it can be edited.`,
      },
    };
  }
  return { success: true, value: await projectOwned(outcome.row) };
}

/** `draft` or `withdrawn` → `pending_review`. */
export async function submitMyCofounderProfile(
  userId: string,
): Promise<Result<OwnedCofounderProfileProjection, CommunityCofounderError>> {
  const outcome = await db.transaction(async (transaction) => {
    const [existing] = await transaction
      .select()
      .from(communityCofounderProfile)
      .where(eq(communityCofounderProfile.userId, userId))
      .for("update");
    if (!existing) return { status: "not_found" as const };
    if (existing.state !== "draft" && existing.state !== "withdrawn") {
      return { status: "invalid_state" as const, state: existing.state };
    }

    const [row] = await transaction
      .update(communityCofounderProfile)
      .set({ state: "pending_review", updatedAt: new Date() })
      .where(eq(communityCofounderProfile.id, existing.id))
      .returning();
    if (!row) throw new Error("Cofounder profile submit returned no row.");
    return { status: "submitted" as const, row };
  });

  if (outcome.status === "not_found") return { success: false, error: { type: "NOT_FOUND" } };
  if (outcome.status === "invalid_state") {
    return {
      success: false,
      error: {
        type: "INVALID_STATE",
        message: `A profile in state ${outcome.state} is already with a reviewer or live.`,
      },
    };
  }
  return { success: true, value: await projectOwned(outcome.row) };
}

/**
 * Out of the directory, REVERSIBLY.
 *
 * The row survives and keeps its `publishedAt`, so resubmitting later goes back through
 * review rather than reappearing on an old approval.
 */
export async function withdrawMyCofounderProfile(
  userId: string,
): Promise<Result<OwnedCofounderProfileProjection, CommunityCofounderError>> {
  const outcome = await db.transaction(async (transaction) => {
    const [existing] = await transaction
      .select()
      .from(communityCofounderProfile)
      .where(eq(communityCofounderProfile.userId, userId))
      .for("update");
    if (!existing) return { status: "not_found" as const };
    if (existing.state !== "published" && existing.state !== "pending_review") {
      return { status: "invalid_state" as const, state: existing.state };
    }
    /**
     * A `pending_review` profile that was never approved has no `publishedAt`, and the
     * CHECK requires one for `withdrawn`. Such a profile goes back to `draft` instead —
     * "withdrawn" would claim it had once been in the directory.
     */
    const nextState: ProfileState = existing.publishedAt === null ? "draft" : "withdrawn";

    const [row] = await transaction
      .update(communityCofounderProfile)
      .set({ state: nextState, updatedAt: new Date() })
      .where(eq(communityCofounderProfile.id, existing.id))
      .returning();
    if (!row) throw new Error("Cofounder profile withdraw returned no row.");
    return { status: "withdrawn" as const, row };
  });

  if (outcome.status === "not_found") return { success: false, error: { type: "NOT_FOUND" } };
  if (outcome.status === "invalid_state") {
    return {
      success: false,
      error: {
        type: "INVALID_STATE",
        message: `A profile in state ${outcome.state} is not in the directory.`,
      },
    };
  }
  return { success: true, value: await projectOwned(outcome.row) };
}

/**
 * The ONE edit a published profile may make without re-entering moderation.
 *
 * It is its own route rather than a field on the PATCH for exactly that reason: everything
 * else is content a moderator approved, and moving between "open to introductions" and
 * "already in conversation" changes no approved text.
 */
export async function setMyEngagementState(input: {
  readonly userId: string;
  readonly engagementState: EngagementState;
}): Promise<Result<OwnedCofounderProfileProjection, CommunityCofounderError>> {
  const [row] = await db
    .update(communityCofounderProfile)
    .set({ engagementState: input.engagementState, updatedAt: new Date() })
    .where(eq(communityCofounderProfile.userId, input.userId))
    .returning();
  if (!row) return { success: false, error: { type: "NOT_FOUND" } };
  return { success: true, value: await projectOwned(row) };
}

// ---------------------------------------------------------------------------
// Moderation (§18.3)
// ---------------------------------------------------------------------------

async function requireCommunityModerator(
  userId: string,
): Promise<Result<{ platformRole: string }, CommunityCofounderError>> {
  const capability = await requirePlatformCapability(userId, "moderate_content");
  if (!capability.success) {
    return {
      success: false,
      error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_content" },
    };
  }
  return { success: true, value: { platformRole: capability.value.platformRole } };
}

export async function listCofounderModerationQueue(input: {
  readonly moderatorUserId: string;
  readonly limit: number;
  readonly cursor?: string;
}): Promise<Result<CofounderDirectoryPage, CommunityCofounderError>> {
  const staff = await requireCommunityModerator(input.moderatorUserId);
  if (!staff.success) return staff;

  const decodedCursor =
    input.cursor === undefined ? null : decodeTimestampStoreCursor(input.cursor);
  if (input.cursor !== undefined && decodedCursor === null) {
    return { success: false, error: { type: "INVALID_CURSOR" } };
  }

  const filters: SQL[] = [eq(communityCofounderProfile.state, "pending_review")];
  if (decodedCursor !== null) {
    const keyset = or(
      lt(communityCofounderProfile.createdAt, decodedCursor.sortKey),
      and(
        eq(communityCofounderProfile.createdAt, decodedCursor.sortKey),
        lt(communityCofounderProfile.id, decodedCursor.id),
      ),
    );
    if (keyset) filters.push(keyset);
  }

  const rows = await db
    .select()
    .from(communityCofounderProfile)
    .where(and(...filters))
    .orderBy(asc(communityCofounderProfile.createdAt), asc(communityCofounderProfile.id))
    .limit(input.limit + 1);

  const pageRows = rows.slice(0, input.limit);
  const lastRow = pageRows[pageRows.length - 1];
  const hasMore = rows.length > input.limit;
  const nextCursor =
    hasMore && lastRow
      ? encodeStoreCursor({ sortKey: lastRow.createdAt.toISOString(), id: lastRow.id })
      : null;

  return {
    success: true,
    value: { items: await projectCards(pageRows), page: { nextCursor, hasMore } },
  };
}

/**
 * Publishes or rejects a profile.
 *
 * A REJECTED PROFILE GOES BACK TO `draft` WITH ITS REASON, not into a fourth state: the
 * author can then edit and resubmit, which is the whole point of telling them why. The
 * platform audit entry is appended in the same transaction and its id stored on the action
 * row, so no decision exists without an accountable human attached.
 */
export async function moderateCofounderProfile(input: {
  readonly moderatorUserId: string;
  readonly profileId: string;
  readonly decision: "publish" | "reject";
  readonly reasonNote: string;
}): Promise<Result<CofounderProfileCardProjection, CommunityCofounderError>> {
  const staff = await requireCommunityModerator(input.moderatorUserId);
  if (!staff.success) return staff;
  const moderatorRole = staff.value.platformRole;

  const outcome = await db.transaction(async (transaction) => {
    const occurredAt = new Date();
    const [existing] = await transaction
      .select()
      .from(communityCofounderProfile)
      .where(eq(communityCofounderProfile.id, input.profileId))
      .for("update");
    if (!existing) return { status: "not_found" as const };
    if (existing.state !== "pending_review") {
      return { status: "invalid_state" as const, state: existing.state };
    }

    const auditEntry = await appendPlatformAuditEntry(transaction, {
      eventKind:
        input.decision === "publish"
          ? "community_cofounder_profile_published"
          : "community_cofounder_profile_rejected",
      actorUserId: input.moderatorUserId,
      actorRoleSnapshot: moderatorRole,
      actionLabel:
        input.decision === "publish"
          ? "community_cofounder_profile_published"
          : "community_cofounder_profile_rejected",
      targetLabel: `community_cofounder_profile:${existing.id}`,
      detailNote: input.reasonNote,
      payload: { profileId: existing.id },
      occurredAt,
    });

    const [row] = await transaction
      .update(communityCofounderProfile)
      .set({
        state: input.decision === "publish" ? "published" : "draft",
        publishedAt:
          input.decision === "publish" ? (existing.publishedAt ?? occurredAt) : existing.publishedAt,
        moderatedByUserId: input.moderatorUserId,
        moderatedAt: occurredAt,
        decisionReason: input.reasonNote,
        updatedAt: occurredAt,
      })
      .where(eq(communityCofounderProfile.id, existing.id))
      .returning();
    if (!row) throw new Error("Cofounder profile moderation returned no row.");

    await transaction.insert(communityModerationAction).values({
      actionKind:
        input.decision === "publish" ? "cofounder_profile_published" : "cofounder_profile_rejected",
      cofounderProfileId: row.id,
      moderatorUserId: input.moderatorUserId,
      moderatorRoleSnapshot: moderatorRole,
      reasonNote: input.reasonNote,
      auditEntryId: auditEntry.id,
      createdAt: occurredAt,
    });

    return { status: "moderated" as const, row };
  });

  if (outcome.status === "not_found") return { success: false, error: { type: "NOT_FOUND" } };
  if (outcome.status === "invalid_state") {
    return {
      success: false,
      error: {
        type: "INVALID_STATE",
        message: `A profile in state ${outcome.state} is not awaiting review.`,
      },
    };
  }

  const cards = await projectCards([outcome.row]);
  const card = cards[0];
  if (!card) throw new Error("Cofounder card projection returned no row.");
  return { success: true, value: card };
}
