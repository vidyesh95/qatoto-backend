import { and, count, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  marketInsight,
  marketInsightProjectLink,
  openRoleCompensation,
  problemCluster,
  problemClusterProjectLink,
  projectMember,
  projectMemberInterval,
  projectOpenRole,
  projectStageTransition,
  projectStats,
  projectWatcher,
  researchCategory,
  researchProject,
} from "#src/db/schema.js";
import {
  deleteProjectCover,
  uploadProjectCover,
  type CloudinaryError,
} from "#src/lib/cloudinary.js";
import { validateAndNormalizeImage, type ImageValidationError } from "#src/lib/image.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import {
  findProjectStats,
  listProjectTeam,
  type ProjectAccessError,
  type ProjectStatsView,
  type ProjectTeamMemberView,
} from "#src/modules/rnd/projects/project-membership.service.js";
import type { Result } from "#src/types/index.js";

/** Project covers are re-encoded to AVIF and downscaled into this box. */
const COVER_IMAGE_OUTPUT_MAX_DIMENSION_PX = 1600;

/**
 * Slug segments the router owns. A project that slugified to one of these would be
 * unreachable, because `/research-projects/mine` matches the literal route declared
 * before `/:projectSlug`.
 */
const RESERVED_PROJECT_SLUGS: ReadonlySet<string> = new Set(["mine", "slugs", "new"]);

/** Max collision suffixes tried before giving up (-2 … -50). */
const MAX_SLUG_ATTEMPTS = 50;

export type ResearchProjectError =
  | ProjectAccessError
  | { type: "CATEGORY_NOT_FOUND"; categoryId: string }
  | { type: "EQUITY_BAND_INVALID"; minBasisPoints: number | null; maxBasisPoints: number | null }
  | { type: "INCOMPLETE_FOR_PUBLISH"; missing: readonly string[] }
  | { type: "ALREADY_PUBLISHED" }
  | { type: "NOT_PUBLISHED" }
  | { type: "PROJECT_ARCHIVED" }
  | { type: "SLUG_EXHAUSTED"; attempted: string }
  | { type: "COVER_REQUIRED_WHILE_PUBLISHED" }
  | { type: "STAGE_UNCHANGED" }
  | ImageValidationError
  | CloudinaryError;

/**
 * Turns a project name into a URL slug.
 *
 * Deliberately lossy and ASCII-only: the slug is a URL identity and a
 * `generateStaticParams` value on three clients, not a display string — `name` carries
 * the real text. Diacritics fold (NFD + strip combining marks) so "Café Solaire"
 * becomes "cafe-solaire" rather than percent-encoding into an unreadable URL.
 *
 * Returns null when nothing usable survives (a name of pure emoji or pure CJK, which
 * strips to empty); the caller then falls back to a generated slug rather than
 * producing "" and colliding with every other such project.
 */
export function slugifyProjectName(name: string): string | null {
  const asciiFolded = name
    .normalize("NFD")
    // Strip combining marks left by NFD, so é → e rather than é → e + U+0301.
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    // Keep URLs and index entries bounded; the collision suffix is appended after.
    .slice(0, 60)
    .replace(/-+$/g, "");

  if (asciiFolded.length === 0) {
    return null;
  }

  // A name that slugifies to a router literal would be permanently unreachable.
  return RESERVED_PROJECT_SLUGS.has(asciiFolded) ? `${asciiFolded}-project` : asciiFolded;
}

/** Candidate slug for attempt N: the base, then base-2, base-3, … */
function slugCandidate(baseSlug: string, attempt: number): string {
  return attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`;
}

/** The input the wizard sends. Every server-owned field is absent by construction. */
export interface CreateResearchProjectInput {
  readonly name: string;
  readonly tagline: string;
  readonly categoryId: string;
  readonly description?: string | undefined;
  readonly problemStatement?: string | undefined;
  readonly solutionSummary?: string | undefined;
  readonly targetRegion?: string | undefined;
  readonly demandEvidenceNotes?: string | undefined;
  readonly seedRolesNeeded?: readonly string[] | undefined;
  readonly offeredEquityBasisPointsMin?: number | undefined;
  readonly offeredEquityBasisPointsMax?: number | undefined;
  readonly expectedCommitment?: "full_time" | "part_time" | "hobby" | undefined;
}

export type UpdateResearchProjectInput = Partial<Omit<CreateResearchProjectInput, "name">> & {
  readonly name?: string | undefined;
};

/** Full project projection for the detail route. Raw integers in named units (§1). */
export interface ResearchProjectDetailView {
  readonly slug: string;
  readonly name: string;
  readonly tagline: string;
  readonly description: string | null;
  readonly problemStatement: string | null;
  readonly solutionSummary: string | null;
  readonly targetRegion: string | null;
  readonly demandEvidenceNotes: string | null;
  readonly category: { readonly slug: string; readonly label: string };
  readonly stage: (typeof researchProject.$inferSelect)["stage"];
  readonly status: (typeof researchProject.$inferSelect)["status"];
  readonly currency: string;
  readonly coverImageUrl: string | null;
  readonly seedRolesNeeded: readonly string[];
  readonly offeredEquityBasisPointsMin: number | null;
  readonly offeredEquityBasisPointsMax: number | null;
  readonly expectedCommitment: (typeof researchProject.$inferSelect)["expectedCommitment"];
  readonly founderUserId: string;
  readonly publishedAt: Date | null;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly stats: ProjectStatsView | null;
  readonly team: readonly ProjectTeamMemberView[];
  /**
   * "Born from Civic Pulse" (§11k.1). NOT a column — the project's origin is the
   * `problem_cluster_project_link` row whose `source` is `'origin'`, and the partial unique
   * index `problem_cluster_project_link_origin_unq` is what makes it at most one.
   * R_AND_D_STRUCTURE.md §18 names a scalar `originProblemReportId`; that column does not
   * exist and must not be added, because storing one fact in two writable places is what the
   * link table's own header comment rejects.
   *
   * Carries the cluster id and no slug: clusters have none — §11b addresses them by id — so a
   * client links with the id exactly as `/problem-map` does.
   */
  readonly originCluster: { readonly clusterId: string; readonly title: string } | null;
  /**
   * The demand-evidence chips (§11k.2) — moderated insights this project cites, PUBLISHED
   * ONES ONLY. Distinct from `demandEvidenceNotes` above, which is founder-authored prose
   * citing nothing a reader can open.
   */
  readonly relatedInsights: readonly { readonly insightId: string; readonly headline: string }[];
  /** Computed per request from the viewer, never a column. */
  readonly isWatchedByViewer: boolean;
  readonly viewerProjectRole: string | null;
}

/** Compact row for feeds and rails. */
export interface ResearchProjectListRow {
  readonly slug: string;
  readonly name: string;
  readonly tagline: string;
  readonly categorySlug: string;
  readonly categoryLabel: string;
  readonly stage: (typeof researchProject.$inferSelect)["stage"];
  readonly status: (typeof researchProject.$inferSelect)["status"];
  readonly coverImageUrl: string | null;
  readonly watchersCount: number;
  readonly teamMemberCount: number;
  readonly openRoleCount: number;
  readonly publishedAt: Date | null;
  readonly updatedAt: Date;
}

export interface ResearchProjectPage {
  readonly rows: readonly ResearchProjectListRow[];
  readonly total: number;
}

const PROJECT_LIST_COLUMNS = {
  slug: researchProject.slug,
  name: researchProject.name,
  tagline: researchProject.tagline,
  categorySlug: researchCategory.slug,
  categoryLabel: researchCategory.label,
  stage: researchProject.stage,
  status: researchProject.status,
  coverImageUrl: researchProject.coverImageUrl,
  watchersCount: projectStats.watchersCount,
  teamMemberCount: projectStats.teamMemberCount,
  openRoleCount: projectStats.openRoleCount,
  publishedAt: researchProject.publishedAt,
  updatedAt: researchProject.updatedAt,
} as const;

/**
 * Counter deltas, defined ONCE and used at every site.
 *
 * The clamp in `decrement` is the one that matters: a counter that goes negative is
 * both wrong and un-recoverable by the reconcile script's `GREATEST` guard. Inlining
 * `col - 1` at five call sites guarantees one of them eventually omits it.
 */
function increment(column: typeof projectStats.watchersCount): ReturnType<typeof sql> {
  return sql`${column} + 1`;
}

function decrement(column: typeof projectStats.watchersCount): ReturnType<typeof sql> {
  return sql`GREATEST(${column} - 1, 0)`;
}

/**
 * Creates a draft project, its founder membership, its first membership interval, its
 * stats sidecar and a genesis stage-transition row — all in ONE transaction.
 *
 * SLUG RACE. Uniqueness is enforced by `research_project_slug_unq`, not by a
 * check-then-insert (which is a TOCTOU race). The retry loop WRAPS `db.transaction`
 * rather than sitting inside it: a 23505 aborts the whole transaction, and any further
 * statement on an aborted transaction fails with 25P02, so retrying inside would just
 * fail differently. Each attempt therefore opens a fresh transaction.
 */
export async function createResearchProject(
  founderUserId: string,
  input: CreateResearchProjectInput,
): Promise<Result<ResearchProjectDetailView, ResearchProjectError>> {
  const equityBandError = validateEquityBand(
    input.offeredEquityBasisPointsMin ?? null,
    input.offeredEquityBasisPointsMax ?? null,
  );
  if (equityBandError) {
    return { success: false, error: equityBandError };
  }

  // Re-derive the category server-side: the client sends an id, and an id for a
  // rejected or nonexistent category must not become a project.
  const [category] = await db
    .select({ id: researchCategory.id, status: researchCategory.status })
    .from(researchCategory)
    .where(eq(researchCategory.id, input.categoryId));

  if (!category || category.status === "rejected") {
    return { success: false, error: { type: "CATEGORY_NOT_FOUND", categoryId: input.categoryId } };
  }

  const baseSlug = slugifyProjectName(input.name) ?? `project-${Date.now().toString(36)}`;

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
    const candidateSlug = slugCandidate(baseSlug, attempt);

    try {
      const createdProjectId = await db.transaction(async (tx) => {
        const [createdProject] = await tx
          .insert(researchProject)
          .values({
            slug: candidateSlug,
            // Stamped from the session. There is no founderUserId field in any request
            // schema (§0) — `.strict()` rejects one.
            founderUserId,
            name: input.name,
            tagline: input.tagline,
            categoryId: input.categoryId,
            description: input.description ?? null,
            problemStatement: input.problemStatement ?? null,
            solutionSummary: input.solutionSummary ?? null,
            targetRegion: input.targetRegion ?? null,
            demandEvidenceNotes: input.demandEvidenceNotes ?? null,
            seedRolesNeeded: [...(input.seedRolesNeeded ?? [])],
            offeredEquityBasisPointsMin: input.offeredEquityBasisPointsMin ?? null,
            offeredEquityBasisPointsMax: input.offeredEquityBasisPointsMax ?? null,
            expectedCommitment: input.expectedCommitment ?? null,
            // status and stage take their column defaults ('draft', 'market_research').
            // No request schema can set either.
          })
          .returning({ id: researchProject.id });

        if (!createdProject) {
          throw new Error("createResearchProject: insert returned no row");
        }

        // The founder membership. `founder` is written HERE and nowhere else — it is
        // absent from every request schema and unassignable via PATCH.
        const [founderMember] = await tx
          .insert(projectMember)
          .values({
            projectId: createdProject.id,
            userId: founderUserId,
            projectRole: "founder",
            roleTitle: "Founder",
          })
          .returning({ id: projectMember.id });

        if (!founderMember) {
          throw new Error("createResearchProject: founder membership insert returned no row");
        }

        // The founder's first stint. §9 accrues over [joinedAt, leftAt) per interval.
        await tx.insert(projectMemberInterval).values({ memberId: founderMember.id });

        // teamMemberCount defaults to 1 for exactly this founder row.
        await tx.insert(projectStats).values({ projectId: createdProject.id });

        // Genesis audit row: NULL → market_research, so the history is replayable
        // without knowing what the column default was on the day of the insert.
        await tx.insert(projectStageTransition).values({
          projectId: createdProject.id,
          fromStage: null,
          toStage: "market_research",
          changedByUserId: founderUserId,
          note: "Project created",
        });

        return createdProject.id;
      });

      const detail = await loadProjectDetail(createdProjectId, founderUserId);
      if (!detail) {
        throw new Error("createResearchProject: created project could not be read back");
      }
      return { success: true, value: detail };
    } catch (error: unknown) {
      // Only a slug collision is retryable. Everything else is a real fault and
      // re-throws (CLAUDE.md §3.3).
      if (isUniqueViolation(error)) {
        continue;
      }
      throw error;
    }
  }

  return { success: false, error: { type: "SLUG_EXHAUSTED", attempted: baseSlug } };
}

function isBasisPointsOutOfRange(value: number | null): boolean {
  return value !== null && (!Number.isInteger(value) || value < 0 || value > 10_000);
}

/** Bounds the founder's advertised band. Returns an error variant or null. */
function validateEquityBand(
  minBasisPoints: number | null,
  maxBasisPoints: number | null,
): ResearchProjectError | null {
  if (isBasisPointsOutOfRange(minBasisPoints) || isBasisPointsOutOfRange(maxBasisPoints)) {
    return { type: "EQUITY_BAND_INVALID", minBasisPoints, maxBasisPoints };
  }
  if (minBasisPoints !== null && maxBasisPoints !== null && minBasisPoints > maxBasisPoints) {
    return { type: "EQUITY_BAND_INVALID", minBasisPoints, maxBasisPoints };
  }
  return null;
}

/** Loads the full detail projection for a known project id. */
async function loadProjectDetail(
  projectId: string,
  viewerUserId: string | null,
): Promise<ResearchProjectDetailView | null> {
  const [row] = await db
    .select({
      id: researchProject.id,
      slug: researchProject.slug,
      name: researchProject.name,
      tagline: researchProject.tagline,
      description: researchProject.description,
      problemStatement: researchProject.problemStatement,
      solutionSummary: researchProject.solutionSummary,
      targetRegion: researchProject.targetRegion,
      demandEvidenceNotes: researchProject.demandEvidenceNotes,
      categorySlug: researchCategory.slug,
      categoryLabel: researchCategory.label,
      stage: researchProject.stage,
      status: researchProject.status,
      currency: researchProject.currency,
      coverImageUrl: researchProject.coverImageUrl,
      seedRolesNeeded: researchProject.seedRolesNeeded,
      offeredEquityBasisPointsMin: researchProject.offeredEquityBasisPointsMin,
      offeredEquityBasisPointsMax: researchProject.offeredEquityBasisPointsMax,
      expectedCommitment: researchProject.expectedCommitment,
      founderUserId: researchProject.founderUserId,
      publishedAt: researchProject.publishedAt,
      archivedAt: researchProject.archivedAt,
      createdAt: researchProject.createdAt,
      updatedAt: researchProject.updatedAt,
    })
    .from(researchProject)
    .innerJoin(researchCategory, eq(researchCategory.id, researchProject.categoryId))
    .where(eq(researchProject.id, projectId));

  if (!row) {
    return null;
  }

  const [stats, team, originCluster, relatedInsights] = await Promise.all([
    findProjectStats(projectId),
    listProjectTeam(projectId),
    findOriginCluster(projectId),
    findRelatedInsights(projectId),
  ]);

  // Both are properties of the VIEWER, not of the row, so they are computed per
  // request and never stored (§10 makes the same call for isUploadedByViewer).
  const viewerMembership = viewerUserId
    ? team.find((member) => member.userId === viewerUserId)
    : undefined;
  const isWatchedByViewer = viewerUserId ? await hasWatched(projectId, viewerUserId) : false;

  return {
    slug: row.slug,
    name: row.name,
    tagline: row.tagline,
    description: row.description,
    problemStatement: row.problemStatement,
    solutionSummary: row.solutionSummary,
    targetRegion: row.targetRegion,
    demandEvidenceNotes: row.demandEvidenceNotes,
    category: { slug: row.categorySlug, label: row.categoryLabel },
    stage: row.stage,
    status: row.status,
    currency: row.currency,
    coverImageUrl: row.coverImageUrl,
    seedRolesNeeded: row.seedRolesNeeded,
    offeredEquityBasisPointsMin: row.offeredEquityBasisPointsMin,
    offeredEquityBasisPointsMax: row.offeredEquityBasisPointsMax,
    expectedCommitment: row.expectedCommitment,
    founderUserId: row.founderUserId,
    publishedAt: row.publishedAt,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    stats,
    team,
    originCluster,
    relatedInsights,
    isWatchedByViewer,
    viewerProjectRole: viewerMembership?.projectRole ?? null,
  };
}

/**
 * The cluster this project was BORN from, or null (§11k.1).
 *
 * `ne(status, "hidden")` IS REQUIRED, NOT DEFENSIVE. This read is public — the detail route
 * gates `draft` and nothing else — and `hidden` means moderator-hidden and excluded from
 * public reads. Without the filter, the project detail becomes the one endpoint in the domain
 * that discloses a withdrawn cluster.
 *
 * `merged` NEEDS NO HANDLING. `discovery-moderation.service.ts` re-points links to the
 * surviving cluster when a merge is approved and downgrades `origin` → `founder_declared` as
 * it does — an absorbed cluster is not what the project was born from — so this correctly
 * returns null afterwards. Do NOT chase `mergedIntoClusterId` to keep the link alive.
 *
 * `.limit(1)` is exact rather than a guess: `problem_cluster_project_link_origin_unq` is a
 * partial unique index on `(project_id) WHERE source = 'origin'`.
 */
async function findOriginCluster(
  projectId: string,
): Promise<{ readonly clusterId: string; readonly title: string } | null> {
  const [row] = await db
    .select({ clusterId: problemCluster.id, title: problemCluster.title })
    .from(problemClusterProjectLink)
    .innerJoin(problemCluster, eq(problemCluster.id, problemClusterProjectLink.clusterId))
    .where(
      and(
        eq(problemClusterProjectLink.projectId, projectId),
        eq(problemClusterProjectLink.source, "origin"),
        ne(problemCluster.status, "hidden"),
      ),
    )
    .limit(1);

  return row ?? null;
}

/**
 * The insights this project cites (§11k.2).
 *
 * `isNotNull(publishedAt)` IS NOT REDUNDANT with the write path's published-only check. An
 * insight can be UNPUBLISHED after it was cited — `…/market-insights/:insightId/unpublish`
 * moves `published_at` back to NULL and leaves the link row alone — so without this filter
 * the project detail becomes the single place in the domain where a draft insight leaks. The
 * link surviving the unpublish is deliberate: republishing restores the chip rather than
 * making the founder cite it again.
 *
 * ORDERED, because an unordered read of a set the client renders as a row of chips
 * reshuffles between requests (§4c rule 4). `publishedAt desc, id desc` is the order
 * `discovery-catalog.service.ts` already gives the knowledge hub, and `publishedAt` is
 * non-null on every row this filter admits.
 */
async function findRelatedInsights(
  projectId: string,
): Promise<readonly { readonly insightId: string; readonly headline: string }[]> {
  return db
    .select({ insightId: marketInsight.id, headline: marketInsight.headline })
    .from(marketInsightProjectLink)
    .innerJoin(marketInsight, eq(marketInsight.id, marketInsightProjectLink.insightId))
    .where(
      and(eq(marketInsightProjectLink.projectId, projectId), isNotNull(marketInsight.publishedAt)),
    )
    .orderBy(desc(marketInsight.publishedAt), desc(marketInsight.id));
}

async function hasWatched(projectId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ projectId: projectWatcher.projectId })
    .from(projectWatcher)
    .where(and(eq(projectWatcher.projectId, projectId), eq(projectWatcher.userId, userId)))
    .limit(1);
  return row !== undefined;
}

/**
 * Detail by public slug, with draft visibility enforced server-side.
 *
 * A `draft` project is visible ONLY to an active member — to everyone else it is
 * indistinguishable from a nonexistent slug (404, never 403). `archived` stays readable
 * on the detail route so external links and prebuilt static pages keep resolving; it is
 * excluded from the feed and from /slugs instead.
 */
export async function findResearchProjectBySlug(
  projectSlug: string,
  viewerUserId: string | null,
): Promise<Result<ResearchProjectDetailView, ProjectAccessError>> {
  const [row] = await db
    .select({ id: researchProject.id, status: researchProject.status })
    .from(researchProject)
    .where(eq(researchProject.slug, projectSlug));

  if (!row) {
    return { success: false, error: { type: "NOT_FOUND", projectRef: projectSlug } };
  }

  if (row.status === "draft") {
    const isMember =
      viewerUserId !== null &&
      (await db
        .select({ id: projectMember.id })
        .from(projectMember)
        .where(
          and(
            eq(projectMember.projectId, row.id),
            eq(projectMember.userId, viewerUserId),
            eq(projectMember.status, "active"),
          ),
        )
        .limit(1)
        .then((rows) => rows.length > 0));

    if (!isMember) {
      return { success: false, error: { type: "NOT_FOUND", projectRef: projectSlug } };
    }
  }

  const detail = await loadProjectDetail(row.id, viewerUserId);
  if (!detail) {
    return { success: false, error: { type: "NOT_FOUND", projectRef: projectSlug } };
  }
  return { success: true, value: detail };
}

export interface ListProjectsFilter {
  readonly categorySlug?: string | undefined;
  readonly stage?: (typeof researchProject.$inferSelect)["stage"] | undefined;
  readonly page: number;
  readonly limit: number;
}

/** The public feed: `active` projects only. Drafts and archives never appear. */
export async function listPublicProjects(filter: ListProjectsFilter): Promise<ResearchProjectPage> {
  const conditions = [eq(researchProject.status, "active")];
  if (filter.categorySlug) {
    conditions.push(eq(researchCategory.slug, filter.categorySlug));
  }
  if (filter.stage) {
    conditions.push(eq(researchProject.stage, filter.stage));
  }
  const predicate = and(...conditions);
  const offset = (filter.page - 1) * filter.limit;

  const rows = await db
    .select(PROJECT_LIST_COLUMNS)
    .from(researchProject)
    .innerJoin(researchCategory, eq(researchCategory.id, researchProject.categoryId))
    .innerJoin(projectStats, eq(projectStats.projectId, researchProject.id))
    .where(predicate)
    // §4c rule 4: ends in a unique column, or a cursor silently skips rows.
    .orderBy(desc(researchProject.publishedAt), desc(researchProject.id))
    .limit(filter.limit)
    .offset(offset);

  const [totals] = await db
    .select({ value: count() })
    .from(researchProject)
    .innerJoin(researchCategory, eq(researchCategory.id, researchProject.categoryId))
    .where(predicate);

  return { rows, total: totals?.value ?? 0 };
}

/** Slug list for `generateStaticParams`. Active only — a draft has no public page. */
export async function listPublicProjectSlugs(): Promise<readonly string[]> {
  const rows = await db
    .select({ slug: researchProject.slug })
    .from(researchProject)
    .where(eq(researchProject.status, "active"))
    .orderBy(researchProject.slug);

  return rows.map((row) => row.slug);
}

/** The caller's own projects, drafts included. Filtered by session id, never a param. */
export async function listMyProjects(
  founderUserId: string,
  filter: {
    readonly status?: (typeof researchProject.$inferSelect)["status"] | undefined;
    readonly page: number;
    readonly limit: number;
  },
): Promise<ResearchProjectPage> {
  const conditions = [eq(researchProject.founderUserId, founderUserId)];
  if (filter.status) {
    conditions.push(eq(researchProject.status, filter.status));
  }
  const predicate = and(...conditions);
  const offset = (filter.page - 1) * filter.limit;

  const rows = await db
    .select(PROJECT_LIST_COLUMNS)
    .from(researchProject)
    .innerJoin(researchCategory, eq(researchCategory.id, researchProject.categoryId))
    .innerJoin(projectStats, eq(projectStats.projectId, researchProject.id))
    .where(predicate)
    .orderBy(desc(researchProject.updatedAt), desc(researchProject.id))
    .limit(filter.limit)
    .offset(offset);

  const [totals] = await db.select({ value: count() }).from(researchProject).where(predicate);

  return { rows, total: totals?.value ?? 0 };
}

/**
 * Partial update. `status`, `stage`, `slug` and every counter are absent from the input
 * type by construction — they have their own endpoints or no endpoint at all.
 *
 * The equity band is re-validated against the MERGED row under `FOR UPDATE`, not
 * against the payload alone: a client can otherwise invert the band across two separate
 * PATCHes, each individually valid. (The CHECK constraint is the backstop; this returns
 * a typed 422 instead of a 500.)
 */
export async function updateResearchProject(
  projectId: string,
  input: UpdateResearchProjectInput,
): Promise<Result<ResearchProjectDetailView, ResearchProjectError>> {
  if (input.categoryId !== undefined) {
    const [category] = await db
      .select({ id: researchCategory.id, status: researchCategory.status })
      .from(researchCategory)
      .where(eq(researchCategory.id, input.categoryId));
    if (!category || category.status === "rejected") {
      return {
        success: false,
        error: { type: "CATEGORY_NOT_FOUND", categoryId: input.categoryId },
      };
    }
  }

  const outcome = await db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        status: researchProject.status,
        publishedAt: researchProject.publishedAt,
        slug: researchProject.slug,
        name: researchProject.name,
        offeredEquityBasisPointsMin: researchProject.offeredEquityBasisPointsMin,
        offeredEquityBasisPointsMax: researchProject.offeredEquityBasisPointsMax,
      })
      .from(researchProject)
      .where(eq(researchProject.id, projectId))
      .for("update");

    if (!current) {
      return { kind: "not-found" } as const;
    }
    if (current.status === "archived") {
      return { kind: "archived" } as const;
    }

    const mergedMin =
      input.offeredEquityBasisPointsMin === undefined
        ? current.offeredEquityBasisPointsMin
        : input.offeredEquityBasisPointsMin;
    const mergedMax =
      input.offeredEquityBasisPointsMax === undefined
        ? current.offeredEquityBasisPointsMax
        : input.offeredEquityBasisPointsMax;

    const bandError = validateEquityBand(mergedMin, mergedMax);
    if (bandError) {
      return { kind: "band-invalid", error: bandError } as const;
    }

    await tx
      .update(researchProject)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.tagline !== undefined ? { tagline: input.tagline } : {}),
        ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.problemStatement !== undefined
          ? { problemStatement: input.problemStatement }
          : {}),
        ...(input.solutionSummary !== undefined ? { solutionSummary: input.solutionSummary } : {}),
        ...(input.targetRegion !== undefined ? { targetRegion: input.targetRegion } : {}),
        ...(input.demandEvidenceNotes !== undefined
          ? { demandEvidenceNotes: input.demandEvidenceNotes }
          : {}),
        ...(input.seedRolesNeeded !== undefined
          ? { seedRolesNeeded: [...input.seedRolesNeeded] }
          : {}),
        ...(input.expectedCommitment !== undefined
          ? { expectedCommitment: input.expectedCommitment }
          : {}),
        offeredEquityBasisPointsMin: mergedMin,
        offeredEquityBasisPointsMax: mergedMax,
      })
      .where(eq(researchProject.id, projectId));

    return { kind: "updated" } as const;
  });

  if (outcome.kind === "not-found") {
    return { success: false, error: { type: "NOT_FOUND", projectRef: projectId } };
  }
  if (outcome.kind === "archived") {
    return { success: false, error: { type: "PROJECT_ARCHIVED" } };
  }
  if (outcome.kind === "band-invalid") {
    return { success: false, error: outcome.error };
  }

  const detail = await loadProjectDetail(projectId, null);
  if (!detail) {
    return { success: false, error: { type: "NOT_FOUND", projectRef: projectId } };
  }
  return { success: true, value: detail };
}

/**
 * The publish gate, enforced SERVER-SIDE (§0). "Save draft" vs "Publish" is UX; the
 * server decides whether a draft is complete enough to go live, exactly as
 * `POST /products/:id/publish` does.
 *
 * Also materializes one `project_open_role` per `seedRolesNeeded` entry and CLEARS the
 * array, which makes a replay safe: the second call sees an empty array and an `active`
 * status, so it returns 409 without creating a second set of roles.
 *
 * FREEZES THE SLUG. After publishedAt is set, a rename no longer moves the slug — a
 * live slug change 404s every external link and every prebuilt static page.
 */
export async function publishResearchProject(
  projectId: string,
  actorUserId: string,
): Promise<Result<ResearchProjectDetailView, ResearchProjectError>> {
  const outcome = await db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        status: researchProject.status,
        name: researchProject.name,
        tagline: researchProject.tagline,
        categoryId: researchProject.categoryId,
        problemStatement: researchProject.problemStatement,
        coverImageUrl: researchProject.coverImageUrl,
        seedRolesNeeded: researchProject.seedRolesNeeded,
        expectedCommitment: researchProject.expectedCommitment,
      })
      .from(researchProject)
      .where(eq(researchProject.id, projectId))
      .for("update");

    if (!current) {
      return { kind: "not-found" } as const;
    }
    if (current.status === "archived") {
      return { kind: "archived" } as const;
    }
    if (current.status === "active") {
      return { kind: "already-published" } as const;
    }

    // Re-derived from the row, never trusted from the client.
    const missing: string[] = [];
    if (current.name.trim().length === 0) missing.push("name");
    if (current.tagline.trim().length === 0) missing.push("tagline");
    if (!current.categoryId) missing.push("categoryId");
    if (!current.problemStatement || current.problemStatement.trim().length === 0) {
      missing.push("problemStatement");
    }
    if (!current.coverImageUrl) missing.push("coverImage");

    if (missing.length > 0) {
      return { kind: "incomplete", missing } as const;
    }

    const seedRoles = current.seedRolesNeeded.filter((roleTitle) => roleTitle.trim().length > 0);
    if (seedRoles.length > 0) {
      await tx.insert(projectOpenRole).values(
        seedRoles.map((roleTitle) => ({
          projectId,
          roleTitle,
          commitment: current.expectedCommitment ?? ("part_time" as const),
        })),
      );
      await tx
        .update(projectStats)
        .set({ openRoleCount: sql`${projectStats.openRoleCount} + ${seedRoles.length}` })
        .where(eq(projectStats.projectId, projectId));
    }

    await tx
      .update(researchProject)
      .set({
        status: "active",
        publishedAt: new Date(),
        // Cleared once materialized — the column is historical from here on, and
        // clearing it is what makes a replay create zero extra roles.
        seedRolesNeeded: [],
      })
      .where(eq(researchProject.id, projectId));

    await tx.insert(projectStageTransition).values({
      projectId,
      fromStage: null,
      toStage: "market_research",
      changedByUserId: actorUserId,
      note: "Project published",
    });

    return { kind: "published" } as const;
  });

  switch (outcome.kind) {
    case "not-found":
      return { success: false, error: { type: "NOT_FOUND", projectRef: projectId } };
    case "archived":
      return { success: false, error: { type: "PROJECT_ARCHIVED" } };
    case "already-published":
      return { success: false, error: { type: "ALREADY_PUBLISHED" } };
    case "incomplete":
      return {
        success: false,
        error: { type: "INCOMPLETE_FOR_PUBLISH", missing: outcome.missing },
      };
    case "published":
      break;
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled publish outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }

  const detail = await loadProjectDetail(projectId, actorUserId);
  if (!detail) {
    return { success: false, error: { type: "NOT_FOUND", projectRef: projectId } };
  }
  return { success: true, value: detail };
}

/** active → draft. The transition that genuinely hides a project from the public. */
export async function unpublishResearchProject(
  projectId: string,
  actorUserId: string,
): Promise<Result<ResearchProjectDetailView, ResearchProjectError>> {
  const [current] = await db
    .select({ status: researchProject.status })
    .from(researchProject)
    .where(eq(researchProject.id, projectId));

  if (!current) {
    return { success: false, error: { type: "NOT_FOUND", projectRef: projectId } };
  }
  if (current.status === "archived") {
    return { success: false, error: { type: "PROJECT_ARCHIVED" } };
  }
  if (current.status !== "active") {
    return { success: false, error: { type: "NOT_PUBLISHED" } };
  }

  // publishedAt is deliberately NOT cleared: the CHECK only requires it for `active`,
  // and keeping it preserves "first published on" across an unpublish/republish cycle.
  await db
    .update(researchProject)
    .set({ status: "draft" })
    .where(eq(researchProject.id, projectId));

  const detail = await loadProjectDetail(projectId, actorUserId);
  if (!detail) {
    return { success: false, error: { type: "NOT_FOUND", projectRef: projectId } };
  }
  return { success: true, value: detail };
}

/** Archive is TERMINAL — there is no un-archive endpoint. */
export async function archiveResearchProject(
  projectId: string,
  actorUserId: string,
): Promise<Result<ResearchProjectDetailView, ResearchProjectError>> {
  const [current] = await db
    .select({ status: researchProject.status })
    .from(researchProject)
    .where(eq(researchProject.id, projectId));

  if (!current) {
    return { success: false, error: { type: "NOT_FOUND", projectRef: projectId } };
  }
  if (current.status === "archived") {
    return { success: false, error: { type: "PROJECT_ARCHIVED" } };
  }

  await db
    .update(researchProject)
    .set({ status: "archived", archivedAt: new Date() })
    .where(eq(researchProject.id, projectId));

  const detail = await loadProjectDetail(projectId, actorUserId);
  if (!detail) {
    return { success: false, error: { type: "NOT_FOUND", projectRef: projectId } };
  }
  return { success: true, value: detail };
}

/**
 * Stage change. A DEDICATED endpoint rather than a field on the general PATCH,
 * because every transition writes an append-only `project_stage_transition` row in the
 * same transaction — an audit trail that can be skipped is not an audit trail.
 */
export async function changeProjectStage(
  projectId: string,
  actorUserId: string,
  toStage: (typeof researchProject.$inferSelect)["stage"],
  note: string | null,
): Promise<Result<ResearchProjectDetailView, ResearchProjectError>> {
  const outcome = await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ status: researchProject.status, stage: researchProject.stage })
      .from(researchProject)
      .where(eq(researchProject.id, projectId))
      .for("update");

    if (!current) {
      return { kind: "not-found" } as const;
    }
    if (current.status === "archived") {
      return { kind: "archived" } as const;
    }
    // The CHECK `from_stage IS DISTINCT FROM to_stage` would raise 23514 here; return a
    // typed domain error instead of letting a constraint produce a 500.
    if (current.stage === toStage) {
      return { kind: "unchanged" } as const;
    }

    await tx
      .update(researchProject)
      .set({ stage: toStage })
      .where(eq(researchProject.id, projectId));

    await tx.insert(projectStageTransition).values({
      projectId,
      fromStage: current.stage,
      toStage,
      changedByUserId: actorUserId,
      note,
    });

    return { kind: "changed" } as const;
  });

  switch (outcome.kind) {
    case "not-found":
      return { success: false, error: { type: "NOT_FOUND", projectRef: projectId } };
    case "archived":
      return { success: false, error: { type: "PROJECT_ARCHIVED" } };
    case "unchanged":
      return { success: false, error: { type: "STAGE_UNCHANGED" } };
    case "changed":
      break;
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled stage outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }

  const detail = await loadProjectDetail(projectId, actorUserId);
  if (!detail) {
    return { success: false, error: { type: "NOT_FOUND", projectRef: projectId } };
  }
  return { success: true, value: detail };
}

/** The stage history behind the audit tab. Append-only, so this is the whole truth. */
export async function listProjectStageTransitions(
  projectId: string,
): Promise<readonly (typeof projectStageTransition.$inferSelect)[]> {
  return (
    db
      .select()
      .from(projectStageTransition)
      .where(eq(projectStageTransition.projectId, projectId))
      // Never ORDER BY createdAt alone: two rows share a millisecond and replica clocks
      // skew, so the tiebreak on a unique column is what makes the order total (§4c).
      .orderBy(projectStageTransition.createdAt, projectStageTransition.id)
  );
}

/**
 * Watch / unwatch. IDEMPOTENT BY CONSTRUCTION: the counter moves only when the write
 * actually changed a row, so a double-tap (or a retried request on a flaky mobile
 * connection) cannot inflate `watchersCount`.
 */
export async function watchProject(projectId: string, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(projectWatcher)
      .values({ projectId, userId })
      .onConflictDoNothing()
      .returning({ projectId: projectWatcher.projectId });

    // Gate the delta on a row ACTUALLY being inserted.
    if (inserted.length > 0) {
      await tx
        .update(projectStats)
        .set({ watchersCount: increment(projectStats.watchersCount) })
        .where(eq(projectStats.projectId, projectId));
    }
  });
}

export async function unwatchProject(projectId: string, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const removed = await tx
      .delete(projectWatcher)
      .where(and(eq(projectWatcher.projectId, projectId), eq(projectWatcher.userId, userId)))
      .returning({ projectId: projectWatcher.projectId });

    if (removed.length > 0) {
      await tx
        .update(projectStats)
        .set({ watchersCount: decrement(projectStats.watchersCount) })
        .where(eq(projectStats.projectId, projectId));
    }
  });
}

/**
 * Cover upload. Reuses the proven product-image pipeline verbatim: sharp decodes to
 * prove the bytes are a real raster, strips EXIF, re-encodes to AVIF, then Cloudinary
 * stores it at a DETERMINISTIC public id so a re-upload overwrites rather than
 * accumulating orphans.
 *
 * There is no coverImageUrl field in any JSON body — a client-supplied URL is an SSRF
 * and hotlink vector (§5).
 */
export async function setProjectCover(
  projectId: string,
  imageBytes: Buffer,
): Promise<Result<{ readonly coverImageUrl: string }, ResearchProjectError>> {
  const normalized = await validateAndNormalizeImage(imageBytes, {
    outputMaxDimensionPx: COVER_IMAGE_OUTPUT_MAX_DIMENSION_PX,
    outputFormat: "avif",
  });
  if (!normalized.success) {
    return { success: false, error: normalized.error };
  }

  const uploaded = await uploadProjectCover(projectId, normalized.value.buffer);
  if (!uploaded.success) {
    return { success: false, error: uploaded.error };
  }

  await db
    .update(researchProject)
    .set({
      coverImageUrl: uploaded.value.secureUrl,
      coverImagePublicId: `qatoto/research-projects/${projectId}/cover`,
    })
    .where(eq(researchProject.id, projectId));

  return { success: true, value: { coverImageUrl: uploaded.value.secureUrl } };
}

/**
 * Removes the cover. Refused while the project is published, because the cover is part
 * of the publish completeness gate — allowing it would leave an `active` project in a
 * state that could not be re-published.
 */
export async function removeProjectCover(
  projectId: string,
): Promise<Result<{ readonly deleted: boolean }, ResearchProjectError>> {
  const [current] = await db
    .select({ status: researchProject.status, coverImageUrl: researchProject.coverImageUrl })
    .from(researchProject)
    .where(eq(researchProject.id, projectId));

  if (!current) {
    return { success: false, error: { type: "NOT_FOUND", projectRef: projectId } };
  }
  if (current.status === "active") {
    return { success: false, error: { type: "COVER_REQUIRED_WHILE_PUBLISHED" } };
  }
  if (!current.coverImageUrl) {
    return { success: true, value: { deleted: false } };
  }

  const deleted = await deleteProjectCover(projectId);
  if (!deleted.success) {
    return { success: false, error: deleted.error };
  }

  await db
    .update(researchProject)
    .set({ coverImageUrl: null, coverImagePublicId: null })
    .where(eq(researchProject.id, projectId));

  return { success: true, value: { deleted: true } };
}

/**
 * Roles a project advertises, with their compensation strands.
 * `OpenRole.projectName` is NOT stored — it joins from research_project.name (§5).
 */
export async function listProjectOpenRolesWithCompensation(projectId: string): Promise<
  ReadonlyArray<
    typeof projectOpenRole.$inferSelect & {
      readonly compensation: readonly (typeof openRoleCompensation.$inferSelect)[];
    }
  >
> {
  const roles = await db
    .select()
    .from(projectOpenRole)
    .where(eq(projectOpenRole.projectId, projectId))
    .orderBy(projectOpenRole.createdAt, projectOpenRole.id);

  if (roles.length === 0) {
    return [];
  }

  const strands = await db
    .select()
    .from(openRoleCompensation)
    .where(
      inArray(
        openRoleCompensation.openRoleId,
        roles.map((role) => role.id),
      ),
    )
    .orderBy(openRoleCompensation.kind);

  return roles.map((role) => ({
    ...role,
    compensation: strands.filter((strand) => strand.openRoleId === role.id),
  }));
}
