import { and, asc, between, desc, eq, gte, or, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  discoveryRegion,
  problemCluster,
  problemClusterProjectLink,
  problemClusterScoreSnapshot,
  problemSubmission,
  researchCategory,
  researchProject,
} from "#src/db/schema.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import {
  DISCOVERY_CATEGORY_REF_COLUMNS,
  DISCOVERY_REGION_REF_COLUMNS,
  type DiscoveryCategoryRef,
  type DiscoveryRegionRef,
} from "#src/services/discovery-catalog.service.js";
import { requirePlatformCapability } from "#src/services/platform-role.service.js";
import type { Result } from "#src/types/index.js";

/**
 * The Civic Pulse problem map (R_AND_D_BACKEND_STRUCTURE.md §6, §11b).
 *
 * A SUBMISSION IS NOT A REPORT. `ProblemReport.reportCount: 342` in the mocks means 342
 * DIFFERENT PEOPLE reported the same problem — so the mock's `ProblemReport` is a
 * CLUSTER, and one person's report is a `problem_submission`. Everything public on this
 * surface reads clusters; submissions are only ever visible to their own reporter.
 *
 * `mapPosition` DOES NOT EXIST HERE. The mocks carry `{ leftPercent, topPercent }`, which
 * is a CSS offset into one specific world_map.svg at one aspect ratio — not geography. It
 * cannot be rendered by MapKit, MapLibre or Google Maps, so both native clients would be
 * dead on arrival. This returns integer microdegrees and each client projects them.
 */

export type ProblemClusterError =
  | { type: "CLUSTER_NOT_FOUND"; clusterId: string }
  | { type: "SUBMISSION_NOT_FOUND"; submissionId: string }
  | { type: "CATEGORY_NOT_FOUND"; categoryId: string }
  | { type: "CATEGORY_NOT_APPROVED"; categoryId: string }
  | { type: "VIEWPORT_INCOMPLETE" };

/**
 * The cluster↔project link write path (§11j.1, §11j.4).
 *
 * A SEPARATE ERROR UNION FROM `ProblemClusterError`, and it deliberately does NOT compose
 * `PlatformAccessError`: this route never emits a 403, and composing the type would let a
 * later edit return one without anybody noticing.
 */
export type ProblemClusterLinkError =
  // Payload identical to `ProblemClusterError`'s — shared literal, shared shape.
  | { type: "CLUSTER_NOT_FOUND"; clusterId: string }
  | { type: "CLUSTER_NOT_LINKABLE"; status: "merged" | "hidden" }
  | { type: "LINK_DENIED" }
  | { type: "LINK_SOURCE_NOT_PERMITTED"; source: ProblemClusterLinkSource }
  | { type: "ALREADY_LINKED" }
  | { type: "ORIGIN_ALREADY_SET" }
  | { type: "LINK_NOT_FOUND" };

export type ProblemClusterLinkSource = (typeof problemClusterProjectLink.$inferSelect)["source"];

export interface ClusterProjectLinkInput {
  readonly projectId: string;
  readonly source: ProblemClusterLinkSource;
}

export interface ClusterProjectLinkView {
  readonly clusterId: string;
  readonly projectId: string;
  readonly projectSlug: string;
  readonly projectName: string;
  readonly source: ProblemClusterLinkSource;
  readonly linkedByUserId: string | null;
  readonly createdAt: Date;
}

/**
 * WHO MAY ASSERT WHICH `source` — one rule, used by both verbs.
 *
 * You may assert exactly the sources your standing produces. A founder writes `origin` or
 * `founder_declared`; a moderator writes `moderator`.
 *
 * A FOUNDER MAY ASSERT `origin`, and should: "this project was born from that cluster" is a
 * claim about the project's own history that nobody else is positioned to make. The partial
 * unique index `problem_cluster_project_link_origin_unq` is what bounds it to one, which is
 * precisely why the table exists instead of a scalar `research_project.originProblemClusterId`.
 *
 * A MODERATOR ASSERTING `origin` IS REFUSED, not silently downgraded — forging provenance
 * quietly is worse than refusing loudly. `discovery-moderation.service.ts` already demotes
 * `origin` → `founder_declared` when a merge repoints links, so the two writers agree about
 * who owns that claim.
 */
function permittedLinkSources(isFounder: boolean): readonly ProblemClusterLinkSource[] {
  return isFounder ? ["origin", "founder_declared"] : ["moderator"];
}

/**
 * `POST /discovery/problem-clusters/:clusterId/project-links` (§11j.1, §11j.4).
 *
 * THE SECOND DEAD END. `problem_cluster_project_link` had three readers — a cluster's linked
 * projects, `recompute-opportunity-scores` and `recompute-demand-signals` — and the only
 * writer was `discovery-moderation.service.ts`, which REPOINTS links that already exist when
 * a merge is decided. Nothing could create one, so every cluster's linked-project list was
 * empty, `relatedProjectCount` was always 0, and that input to the opportunity score was
 * dead weight in the formula.
 *
 * THE DUAL AUTHORIZATION, AND WHY IT IS 404 RATHER THAN §11j.4's STATED 403.
 * Staff standing is probed FIRST — still before any id is read — but its failure is demoted
 * to a boolean instead of returning, because a project's founder is legitimately not staff.
 * That keeps the ordering property that makes `/discovery/admin/*` safe while letting the
 * founder path run.
 *
 * A 403 cannot be correct here. Founder-ness cannot be decided without reading
 * `input.projectId`, so any 403/404 split on this route would disclose whether that project
 * exists to anyone holding a session. §11i's 403 is legitimate precisely BECAUSE it is
 * decided before any id is read; that property does not hold on this route, so the status
 * does not transfer. §11j.4 inherited the `403` from the row above it in the same table.
 * Recorded here as a correction rather than followed.
 */
export async function linkProjectToCluster(
  actorUserId: string,
  clusterId: string,
  input: ClusterProjectLinkInput,
): Promise<Result<ClusterProjectLinkView, ProblemClusterLinkError>> {
  // 1. STANDING FIRST, before any id is read — but NOT fatal. See the note above.
  const staffResult = await requirePlatformCapability(actorUserId, "moderate_clusters");
  const isModerator = staffResult.success;

  // 2. Resource and access decided by ONE predicate over ONE row, so the two
  //    authorizations cannot disagree. "No such project" and "you are neither its founder
  //    nor staff" are the SAME error, which is `requireProjectRole`'s discipline.
  const [project] = await db
    .select({ id: researchProject.id, founderUserId: researchProject.founderUserId })
    .from(researchProject)
    .where(eq(researchProject.id, input.projectId));

  const isFounder = project !== undefined && project.founderUserId === actorUserId;
  if (!project || !(isFounder || isModerator)) {
    return { success: false, error: { type: "LINK_DENIED" } };
  }

  // 3. The cluster. Its id and status are already public — `findProblemCluster` returns a
  //    merged cluster with a 200 and its `mergedIntoClusterId` — so naming them leaks
  //    nothing that a public read does not already give away.
  const [cluster] = await db
    .select({ status: problemCluster.status })
    .from(problemCluster)
    .where(eq(problemCluster.id, clusterId));

  if (!cluster) {
    return { success: false, error: { type: "CLUSTER_NOT_FOUND", clusterId } };
  }
  if (cluster.status !== "active") {
    // A merged cluster's links get REPOINTED by moderation, never added to; a hidden one is
    // withdrawn from the map and must not accrue new provenance.
    return { success: false, error: { type: "CLUSTER_NOT_LINKABLE", status: cluster.status } };
  }

  // 4. Source vocabulary.
  if (!permittedLinkSources(isFounder).includes(input.source)) {
    return { success: false, error: { type: "LINK_SOURCE_NOT_PERMITTED", source: input.source } };
  }

  try {
    await db.insert(problemClusterProjectLink).values({
      clusterId,
      projectId: input.projectId,
      source: input.source,
      linkedByUserId: actorUserId,
    });
  } catch (error: unknown) {
    if (isUniqueViolation(error)) {
      // TWO constraints raise 23505 on this insert: the composite PK (this exact pair is
      // already linked) and `problem_cluster_project_link_origin_unq` (this project already
      // has an origin cluster, a DIFFERENT one). Re-read to say which, rather than adding a
      // constraint-name reader to the shared pg-errors.ts — one extra query, on the failure
      // path only, and deterministic.
      const [existingPair] = await db
        .select({ projectId: problemClusterProjectLink.projectId })
        .from(problemClusterProjectLink)
        .where(
          and(
            eq(problemClusterProjectLink.clusterId, clusterId),
            eq(problemClusterProjectLink.projectId, input.projectId),
          ),
        );

      return {
        success: false,
        error: existingPair ? { type: "ALREADY_LINKED" } : { type: "ORIGIN_ALREADY_SET" },
      };
    }
    throw error;
  }

  const created = await findClusterProjectLink(clusterId, input.projectId);
  if (!created) {
    throw new Error("linkProjectToCluster: inserted link could not be read back");
  }
  return { success: true, value: created };
}

async function findClusterProjectLink(
  clusterId: string,
  projectId: string,
): Promise<ClusterProjectLinkView | null> {
  const [row] = await db
    .select({
      clusterId: problemClusterProjectLink.clusterId,
      projectId: problemClusterProjectLink.projectId,
      projectSlug: researchProject.slug,
      projectName: researchProject.name,
      source: problemClusterProjectLink.source,
      linkedByUserId: problemClusterProjectLink.linkedByUserId,
      createdAt: problemClusterProjectLink.createdAt,
    })
    .from(problemClusterProjectLink)
    .innerJoin(researchProject, eq(researchProject.id, problemClusterProjectLink.projectId))
    .where(
      and(
        eq(problemClusterProjectLink.clusterId, clusterId),
        eq(problemClusterProjectLink.projectId, projectId),
      ),
    );

  return row ?? null;
}

/**
 * `DELETE /discovery/problem-clusters/:clusterId/project-links/:projectId` (§11j.4).
 *
 * THE SAME PERMISSION RULE, INVERTED: you may remove a link whose `source` you would have
 * been permitted to assert. So a founder cannot delete a moderator's curation link, and a
 * moderator cannot delete a founder's `origin` claim out from under them — each party can
 * retract only its own statement.
 *
 * A hard delete: the composite-PK row has no inbound FKs, and a retracted claim about
 * provenance is not a record worth keeping.
 */
export async function unlinkProjectFromCluster(
  actorUserId: string,
  clusterId: string,
  projectId: string,
): Promise<Result<{ readonly deleted: true }, ProblemClusterLinkError>> {
  // 1. STANDING FIRST, non-fatal — same shape as the create.
  const staffResult = await requirePlatformCapability(actorUserId, "moderate_clusters");
  const isModerator = staffResult.success;

  const [project] = await db
    .select({ id: researchProject.id, founderUserId: researchProject.founderUserId })
    .from(researchProject)
    .where(eq(researchProject.id, projectId));

  const isFounder = project !== undefined && project.founderUserId === actorUserId;
  if (!project || !(isFounder || isModerator)) {
    return { success: false, error: { type: "LINK_DENIED" } };
  }

  const existing = await findClusterProjectLink(clusterId, projectId);
  if (!existing) {
    return { success: false, error: { type: "LINK_NOT_FOUND" } };
  }

  // The rule applied to the STORED source, not to anything the caller sent.
  if (!permittedLinkSources(isFounder).includes(existing.source)) {
    return {
      success: false,
      error: { type: "LINK_SOURCE_NOT_PERMITTED", source: existing.source },
    };
  }

  await db
    .delete(problemClusterProjectLink)
    .where(
      and(
        eq(problemClusterProjectLink.clusterId, clusterId),
        eq(problemClusterProjectLink.projectId, projectId),
      ),
    );

  return { success: true, value: { deleted: true } };
}

/**
 * Snaps a published centroid to a ~111 m grid.
 *
 * WHY THIS EXISTS. A singleton cluster's centroid IS one reporter's exact submitted
 * coordinates. Publishing it at 1-microdegree resolution (~11 cm) would disclose the home
 * address of someone who reported a problem there — a civic-reporting surface that
 * de-anonymizes its reporters is worse than no surface.
 *
 * Applied EXACTLY ONCE, at the read boundary, so the stored centroid stays exact for the
 * clustering job while the published one is not a street address.
 *
 * `Math.round` is banned on signed quantities (§4c) — it rounds -0.5 to -0 and disagrees
 * with Postgres — so this rounds half away from zero by hand and behaves identically in
 * the southern and western hemispheres.
 */
const CENTROID_PUBLIC_GRID_MICRODEGREES = 1_000;

export function quantizePublishedMicrodegrees(microdegrees: number): number {
  const half = CENTROID_PUBLIC_GRID_MICRODEGREES / 2;
  const shifted = microdegrees >= 0 ? microdegrees + half : microdegrees - half;
  return shifted - (shifted % CENTROID_PUBLIC_GRID_MICRODEGREES);
}

export interface ProblemClusterView {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly category: DiscoveryCategoryRef;
  readonly region: DiscoveryRegionRef | null;
  /** ISO 3166-1 alpha-2, SERVER-GEOCODED. Never client-claimed (§6). */
  readonly countryCode: string | null;
  /** Reverse-geocoded from the centroid, e.g. "Nakuru County, Kenya". */
  readonly locationLabel: string | null;
  /** Integer microdegrees (degrees × 1e6), quantized for publication. */
  readonly centroidLatitudeMicrodegrees: number;
  readonly centroidLongitudeMicrodegrees: number;
  /**
   * COUNT(DISTINCT reporterUserId) over identified submissions only. Was `reportCount`.
   *
   * Renamed because "342 reports" and "342 people" are different claims, and only the
   * second one is evidence of demand.
   */
  readonly distinctReporterCount: number;
  /** Total submissions. Always >= distinctReporterCount; the gap is the sybil signal. */
  readonly submissionCount: number;
  /** Integer 0..100. NULL until the first scoring run — never defaulted to 0 (§6). */
  readonly opportunityScorePoints: number | null;
  /** ISO-8601 UTC. NULL exactly when the score is. */
  readonly scoreComputedAt: string | null;
  /** ISO-8601 UTC. Replaces the mocks' single `reportedDate`. */
  readonly firstReportedAt: string;
  readonly lastReportedAt: string;
  readonly status: (typeof problemCluster.$inferSelect)["status"];
  readonly mergedIntoClusterId: string | null;
}

const PROBLEM_CLUSTER_SORTS = ["opportunity", "recent", "reporters"] as const;
export type ProblemClusterSort = (typeof PROBLEM_CLUSTER_SORTS)[number];

export interface ProblemClusterFilter {
  readonly categorySlug?: string;
  readonly regionSlug?: string;
  readonly minOpportunityScorePoints?: number;
  readonly minLatitudeMicrodegrees?: number;
  readonly maxLatitudeMicrodegrees?: number;
  readonly minLongitudeMicrodegrees?: number;
  readonly maxLongitudeMicrodegrees?: number;
  readonly sort: ProblemClusterSort;
  readonly page: number;
  readonly limit: number;
}

export interface ProblemClusterPage {
  readonly rows: readonly ProblemClusterView[];
  readonly total: number;
}

const PROBLEM_CLUSTER_VIEW_COLUMNS = {
  id: problemCluster.id,
  title: problemCluster.title,
  description: problemCluster.description,
  category: DISCOVERY_CATEGORY_REF_COLUMNS,
  region: DISCOVERY_REGION_REF_COLUMNS,
  countryCode: problemCluster.countryCode,
  locationLabel: problemCluster.locationLabel,
  centroidLatitudeMicrodegrees: problemCluster.centroidLatitudeMicrodegrees,
  centroidLongitudeMicrodegrees: problemCluster.centroidLongitudeMicrodegrees,
  distinctReporterCount: problemCluster.distinctReporterCount,
  submissionCount: problemCluster.submissionCount,
  opportunityScorePoints: problemCluster.currentOpportunityScorePoints,
  scoreComputedAt: problemCluster.scoreComputedAt,
  firstReportedAt: problemCluster.firstReportedAt,
  lastReportedAt: problemCluster.lastReportedAt,
  status: problemCluster.status,
  mergedIntoClusterId: problemCluster.mergedIntoClusterId,
} as const;

/**
 * The row shape the two cluster queries return.
 *
 * `region` is nullable because it comes from a LEFT JOIN — a cluster has no region until
 * the geocoding job resolves one. Drizzle nulls the ENTIRE nested object rather than each
 * of its fields, so this projects straight through with no per-field guarding.
 */
interface ProblemClusterQueryRow {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly category: DiscoveryCategoryRef;
  readonly region: DiscoveryRegionRef | null;
  readonly countryCode: string | null;
  readonly locationLabel: string | null;
  readonly centroidLatitudeMicrodegrees: number;
  readonly centroidLongitudeMicrodegrees: number;
  readonly distinctReporterCount: number;
  readonly submissionCount: number;
  readonly opportunityScorePoints: number | null;
  readonly scoreComputedAt: Date | null;
  readonly firstReportedAt: Date;
  readonly lastReportedAt: Date;
  readonly status: (typeof problemCluster.$inferSelect)["status"];
  readonly mergedIntoClusterId: string | null;
}

function toProblemClusterView(row: ProblemClusterQueryRow): ProblemClusterView {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    region: row.region,
    countryCode: row.countryCode,
    locationLabel: row.locationLabel,
    centroidLatitudeMicrodegrees: quantizePublishedMicrodegrees(row.centroidLatitudeMicrodegrees),
    centroidLongitudeMicrodegrees: quantizePublishedMicrodegrees(row.centroidLongitudeMicrodegrees),
    distinctReporterCount: row.distinctReporterCount,
    submissionCount: row.submissionCount,
    opportunityScorePoints: row.opportunityScorePoints,
    scoreComputedAt: row.scoreComputedAt?.toISOString() ?? null,
    firstReportedAt: row.firstReportedAt.toISOString(),
    lastReportedAt: row.lastReportedAt.toISOString(),
    status: row.status,
    mergedIntoClusterId: row.mergedIntoClusterId,
  };
}

/**
 * The public map + landing teaser.
 *
 * ONLY `active` CLUSTERS. A merged cluster's rows now live on its survivor, and a hidden
 * one was hidden by a moderator; either appearing in a list would double-count the map.
 */
export async function listProblemClusters(
  filter: ProblemClusterFilter,
): Promise<ProblemClusterPage> {
  const conditions = [eq(problemCluster.status, "active")];

  if (filter.categorySlug) conditions.push(eq(researchCategory.slug, filter.categorySlug));
  if (filter.regionSlug) conditions.push(eq(discoveryRegion.slug, filter.regionSlug));
  if (filter.minOpportunityScorePoints !== undefined) {
    conditions.push(
      gte(problemCluster.currentOpportunityScorePoints, filter.minOpportunityScorePoints),
    );
  }

  // The viewport filter. All four bounds or none — the controller rejects a partial box
  // before this runs, so reaching here with a partial box is impossible.
  if (
    filter.minLatitudeMicrodegrees !== undefined &&
    filter.maxLatitudeMicrodegrees !== undefined &&
    filter.minLongitudeMicrodegrees !== undefined &&
    filter.maxLongitudeMicrodegrees !== undefined
  ) {
    conditions.push(
      between(
        problemCluster.centroidLatitudeMicrodegrees,
        filter.minLatitudeMicrodegrees,
        filter.maxLatitudeMicrodegrees,
      ),
    );
    // A viewport that crosses the antimeridian arrives with min > max, which `BETWEEN`
    // would read as an empty range and silently return nothing. Split it into two ranges
    // instead: [min, +180] OR [-180, max].
    conditions.push(
      filter.minLongitudeMicrodegrees <= filter.maxLongitudeMicrodegrees
        ? between(
            problemCluster.centroidLongitudeMicrodegrees,
            filter.minLongitudeMicrodegrees,
            filter.maxLongitudeMicrodegrees,
          )
        : (or(
            between(
              problemCluster.centroidLongitudeMicrodegrees,
              filter.minLongitudeMicrodegrees,
              180_000_000,
            ),
            between(
              problemCluster.centroidLongitudeMicrodegrees,
              -180_000_000,
              filter.maxLongitudeMicrodegrees,
            ),
          ) ?? sql`true`),
    );
  }

  const whereClause = and(...conditions);

  // NULLS LAST is load-bearing on every score sort. Postgres puts NULLs FIRST under
  // DESC, and the score is NULL until the first job run — so the naive ordering would
  // float every UNSCORED cluster to the top of the map, which is exactly the set with
  // the least evidence behind it. Every branch ends in the unique id (§4c rule 4).
  const orderBy =
    filter.sort === "opportunity"
      ? [
          sql`${problemCluster.currentOpportunityScorePoints} DESC NULLS LAST`,
          desc(problemCluster.lastReportedAt),
          desc(problemCluster.id),
        ]
      : filter.sort === "reporters"
        ? [
            desc(problemCluster.distinctReporterCount),
            desc(problemCluster.lastReportedAt),
            desc(problemCluster.id),
          ]
        : [desc(problemCluster.lastReportedAt), desc(problemCluster.id)];

  const [rows, [totalRow]] = await Promise.all([
    db
      .select(PROBLEM_CLUSTER_VIEW_COLUMNS)
      .from(problemCluster)
      .innerJoin(researchCategory, eq(problemCluster.categoryId, researchCategory.id))
      .leftJoin(discoveryRegion, eq(problemCluster.regionId, discoveryRegion.id))
      .where(whereClause)
      .orderBy(...orderBy)
      .limit(filter.limit)
      .offset((filter.page - 1) * filter.limit),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(problemCluster)
      .innerJoin(researchCategory, eq(problemCluster.categoryId, researchCategory.id))
      .leftJoin(discoveryRegion, eq(problemCluster.regionId, discoveryRegion.id))
      .where(whereClause),
  ]);

  return { rows: rows.map(toProblemClusterView), total: totalRow?.total ?? 0 };
}

export interface LinkedProjectView {
  /** The PUBLIC identity (§11) — never the internal id. */
  readonly slug: string;
  readonly name: string;
  readonly stage: (typeof researchProject.$inferSelect)["stage"];
  readonly coverImageUrl: string | null;
  readonly linkSource: (typeof problemClusterProjectLink.$inferSelect)["source"];
}

export interface ClusterScoreHistoryPoint {
  readonly asOf: string;
  readonly opportunityScorePoints: number;
  readonly distinctReporterCount: number;
}

export interface ProblemClusterDetailView extends ProblemClusterView {
  readonly linkedProjects: readonly LinkedProjectView[];
  readonly scoreHistory: readonly ClusterScoreHistoryPoint[];
  /** Caller-dependent, NOT a row property. False for anonymous readers. */
  readonly viewerHasReported: boolean;
}

const SCORE_HISTORY_LIMIT = 12;

/**
 * Cluster detail.
 *
 * A `merged` or `hidden` cluster STILL RESOLVES with 200 and carries
 * `mergedIntoClusterId`, so a bookmarked or shared link follows the merge rather than
 * dying. Merging is a housekeeping action and must not 404 links people already sent
 * each other.
 */
export async function findProblemCluster(
  clusterId: string,
  viewerUserId: string | null,
): Promise<ProblemClusterDetailView | null> {
  const [row] = await db
    .select(PROBLEM_CLUSTER_VIEW_COLUMNS)
    .from(problemCluster)
    .innerJoin(researchCategory, eq(problemCluster.categoryId, researchCategory.id))
    .leftJoin(discoveryRegion, eq(problemCluster.regionId, discoveryRegion.id))
    .where(eq(problemCluster.id, clusterId));

  if (!row) return null;

  const [linkedProjects, scoreHistory, viewerReportRows] = await Promise.all([
    db
      .select({
        slug: researchProject.slug,
        name: researchProject.name,
        stage: researchProject.stage,
        coverImageUrl: researchProject.coverImageUrl,
        linkSource: problemClusterProjectLink.source,
      })
      .from(problemClusterProjectLink)
      .innerJoin(researchProject, eq(problemClusterProjectLink.projectId, researchProject.id))
      .where(
        and(
          eq(problemClusterProjectLink.clusterId, clusterId),
          // Only PUBLISHED projects. A draft is visible to its founder alone (§5), and
          // surfacing one here would leak an unpublished idea to the whole map.
          eq(researchProject.status, "active"),
        ),
      )
      .orderBy(asc(researchProject.name), asc(researchProject.slug)),
    db
      .select({
        asOf: problemClusterScoreSnapshot.asOf,
        opportunityScorePoints: problemClusterScoreSnapshot.opportunityScorePoints,
        distinctReporterCount: problemClusterScoreSnapshot.distinctReporterCount,
      })
      .from(problemClusterScoreSnapshot)
      .where(eq(problemClusterScoreSnapshot.clusterId, clusterId))
      .orderBy(desc(problemClusterScoreSnapshot.asOf), desc(problemClusterScoreSnapshot.id))
      .limit(SCORE_HISTORY_LIMIT),
    viewerUserId
      ? db
          .select({ id: problemSubmission.id })
          .from(problemSubmission)
          .where(
            and(
              eq(problemSubmission.clusterId, clusterId),
              eq(problemSubmission.reporterUserId, viewerUserId),
            ),
          )
          .limit(1)
      : Promise.resolve([]),
  ]);

  return {
    ...toProblemClusterView(row),
    linkedProjects,
    scoreHistory: scoreHistory.map((point) => ({
      ...point,
      asOf: point.asOf.toISOString(),
    })),
    viewerHasReported: viewerReportRows.length > 0,
  };
}

export interface CreateProblemSubmissionInput {
  readonly title: string;
  readonly categoryId: string;
  readonly description: string;
  readonly locationText: string;
}

export interface ProblemSubmissionReceiptView {
  readonly submissionId: string;
  /** Always "queued" here — geocoding and clustering are async (§4e). */
  readonly clusteringStatus: (typeof problemSubmission.$inferSelect)["status"];
  /** Always null on the 202. The client polls /problem-reports/mine (§14). */
  readonly clusterId: null;
  readonly submittedAt: string;
}

/**
 * Accepts one person's problem report and queues it for geocoding + clustering.
 *
 * RETURNS A RECEIPT, NOT A CLUSTER. There is deliberately no `opportunityScorePoints`,
 * no `distinctReporterCount` and no `countryCode` in the response: none of them exists
 * yet at 202 time, and returning a placeholder is exactly the fabrication §6 exists to
 * stop — the current report-problem-sheet invents all four client-side.
 *
 * NO IDEMPOTENCY KEY, on purpose. §14 asks for keys on claim submit, receipt upload and
 * dispute raise; a retried problem report is harmless HERE BY CONSTRUCTION, because
 * `distinctReporterCount` is a COUNT(DISTINCT reporterUserId) — a duplicate from the same
 * account moves `submissionCount` and nothing that feeds the score. Adding a key would
 * imply the count is retry-sensitive when it is the one number specifically designed not
 * to be.
 *
 * The caller is responsible for enqueuing the clustering job IN THE SAME TRANSACTION —
 * see the `db` parameter, which accepts a transaction handle.
 */
export async function createProblemSubmission(
  reporterUserId: string,
  input: CreateProblemSubmissionInput,
): Promise<ProblemSubmissionReceiptView> {
  const [created] = await db
    .insert(problemSubmission)
    .values({
      reporterUserId,
      title: input.title,
      categoryId: input.categoryId,
      description: input.description,
      locationText: input.locationText,
      // Everything else falls to its column default: status='queued', coordinates NULL,
      // countryCode NULL. There is no field here a client could supply for any of them.
    })
    .returning({
      id: problemSubmission.id,
      status: problemSubmission.status,
      createdAt: problemSubmission.createdAt,
    });

  if (!created) {
    throw new Error("createProblemSubmission: insert returned no row");
  }

  return {
    submissionId: created.id,
    clusteringStatus: created.status,
    clusterId: null,
    submittedAt: created.createdAt.toISOString(),
  };
}

/**
 * Confirms a category exists AND is approved.
 *
 * The approval check is not redundant with the FK: a `pending`, user-minted category is a
 * real row, so the FK would accept it — but letting a report attach to an unreviewed
 * category makes the moderation queue decorative and gives a spammer a way to seed the
 * taxonomy AND the map in one request.
 */
export async function checkCategoryUsable(
  categoryId: string,
): Promise<
  { readonly usable: true } | { readonly usable: false; readonly error: ProblemClusterError }
> {
  const [row] = await db
    .select({ status: researchCategory.status })
    .from(researchCategory)
    .where(eq(researchCategory.id, categoryId));

  if (!row) {
    return { usable: false, error: { type: "CATEGORY_NOT_FOUND", categoryId } };
  }
  if (row.status !== "approved") {
    return { usable: false, error: { type: "CATEGORY_NOT_APPROVED", categoryId } };
  }
  return { usable: true };
}

export interface MyProblemSubmissionView {
  readonly submissionId: string;
  readonly title: string;
  readonly description: string;
  readonly category: DiscoveryCategoryRef;
  /** What the reporter typed — their own words, never authoritative geography. */
  readonly locationText: string;
  /** Server-geocoded. NULL until the job has run. */
  readonly countryCode: string | null;
  readonly latitudeMicrodegrees: number | null;
  readonly longitudeMicrodegrees: number | null;
  readonly clusteringStatus: (typeof problemSubmission.$inferSelect)["status"];
  readonly clusterId: string | null;
  readonly clusterTitle: string | null;
  readonly geocodeFailureReason: string | null;
  readonly submittedAt: string;
}

export interface MyProblemSubmissionFilter {
  readonly clusteringStatus?: (typeof problemSubmission.$inferSelect)["status"];
  readonly page: number;
  readonly limit: number;
}

export interface MyProblemSubmissionPage {
  readonly rows: readonly MyProblemSubmissionView[];
  readonly total: number;
}

/** Shared by the list and the detail read so the two shapes cannot drift. */
const MY_PROBLEM_SUBMISSION_COLUMNS = {
  submissionId: problemSubmission.id,
  title: problemSubmission.title,
  description: problemSubmission.description,
  category: DISCOVERY_CATEGORY_REF_COLUMNS,
  locationText: problemSubmission.locationText,
  countryCode: problemSubmission.countryCode,
  latitudeMicrodegrees: problemSubmission.latitudeMicrodegrees,
  longitudeMicrodegrees: problemSubmission.longitudeMicrodegrees,
  clusteringStatus: problemSubmission.status,
  clusterId: problemSubmission.clusterId,
  clusterTitle: problemCluster.title,
  geocodeFailureReason: problemSubmission.geocodeFailureReason,
  submittedAt: problemSubmission.createdAt,
} as const;

/**
 * `GET /discovery/problem-reports/:submissionId` — the caller's OWN report (§11j.2).
 *
 * THE `reporterUserId` PREDICATE IS THE AUTHORIZATION. It sits in the WHERE clause, so
 * someone else's submission reads as absent and answers the same 404 as an id that never
 * existed — there is no 403 to distinguish the two, and therefore no way to probe which
 * submission ids exist. Same rule and same reason as the list below.
 */
export async function findMyProblemSubmission(
  reporterUserId: string,
  submissionId: string,
): Promise<MyProblemSubmissionView | null> {
  const [row] = await db
    .select(MY_PROBLEM_SUBMISSION_COLUMNS)
    .from(problemSubmission)
    .innerJoin(researchCategory, eq(problemSubmission.categoryId, researchCategory.id))
    .leftJoin(problemCluster, eq(problemSubmission.clusterId, problemCluster.id))
    .where(
      and(
        eq(problemSubmission.id, submissionId),
        eq(problemSubmission.reporterUserId, reporterUserId),
      ),
    );

  return row ? { ...row, submittedAt: row.submittedAt.toISOString() } : null;
}

/**
 * The caller's own reports.
 *
 * THERE IS NO `userId` PARAMETER, and there must never be one (§13): the filter is
 * `req.user.id` and nothing else, so there is no field an attacker could supply to read
 * someone else's reports. Coordinates are returned UNQUANTIZED here — the reporter
 * submitted the location themselves, so there is nothing to protect them from.
 */
export async function listMyProblemSubmissions(
  reporterUserId: string,
  filter: MyProblemSubmissionFilter,
): Promise<MyProblemSubmissionPage> {
  const conditions = [eq(problemSubmission.reporterUserId, reporterUserId)];
  if (filter.clusteringStatus) {
    conditions.push(eq(problemSubmission.status, filter.clusteringStatus));
  }
  const whereClause = and(...conditions);

  const [rows, [totalRow]] = await Promise.all([
    db
      .select(MY_PROBLEM_SUBMISSION_COLUMNS)
      .from(problemSubmission)
      .innerJoin(researchCategory, eq(problemSubmission.categoryId, researchCategory.id))
      .leftJoin(problemCluster, eq(problemSubmission.clusterId, problemCluster.id))
      .where(whereClause)
      .orderBy(desc(problemSubmission.createdAt), desc(problemSubmission.id))
      .limit(filter.limit)
      .offset((filter.page - 1) * filter.limit),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(problemSubmission)
      .where(whereClause),
  ]);

  return {
    rows: rows.map((row) => ({ ...row, submittedAt: row.submittedAt.toISOString() })),
    total: totalRow?.total ?? 0,
  };
}
