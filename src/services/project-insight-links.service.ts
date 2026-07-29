import { and, eq } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { marketInsight, marketInsightProjectLink, researchProject } from "#src/db/schema.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import { requirePlatformCapability } from "#src/services/platform-role.service.js";
import type { Result } from "#src/types/index.js";

/**
 * The project ↔ market-insight citation write path
 * (R_AND_D_BACKEND_STRUCTURE.md §11k.2).
 *
 * WHAT IT CLOSES. The project Overview tab's demand-evidence chips had nothing to read.
 * §11j.1 blamed the missing WRITE on `/discovery/admin/market-insights`; the actual cause was
 * that no table joined an insight to a project at all — `marketInsightRelations` carried
 * region, category and author and stopped there. Migration 0023 adds the relation and this
 * file is its only writer.
 *
 * A SEPARATE FILE FROM `research-projects.service.ts`, which owns the project row itself and
 * is already 1100 lines. The shape here is `problem-clusters.service.ts`'s link pair —
 * standing probed first and demoted to a boolean, one predicate over one row, a hard delete —
 * mounted project-side because the route is `/research-projects/:projectSlug/*`.
 *
 * THE ERROR UNION DELIBERATELY DOES NOT COMPOSE `PlatformAccessError`. This route never emits
 * a 403: the moderator probe is non-fatal, because a project's founder is legitimately not
 * staff. Composing the type would let a later edit return one without anybody noticing, which
 * is the rule `problem-clusters.service.ts` states for the same reason.
 */

export type ProjectInsightLinkError =
  | { type: "INSIGHT_LINK_DENIED" }
  | { type: "INSIGHT_ALREADY_LINKED" }
  | { type: "INSIGHT_LINK_NOT_FOUND" };

export interface ProjectInsightLinkView {
  readonly projectId: string;
  readonly projectSlug: string;
  readonly insightId: string;
  readonly headline: string;
  readonly linkedByUserId: string | null;
  readonly createdAt: Date;
}

/**
 * WHO MAY WRITE — the project's founder, or a moderator; and every refusal is ONE 404.
 *
 * Returned as a `Result` so both verbs share the decision rather than restating it, and so
 * neither can drift into a 403. Founder-ness cannot be decided without reading the project
 * slug, so a 403/404 split on this route would disclose whether that project exists to anyone
 * holding a session — §11i's 403 is legitimate precisely because it is decided BEFORE any id
 * is read, and that property does not hold here.
 *
 * `moderate_taxonomy` rather than `moderate_clusters`: an insight is authored editorial
 * content, which is the capability every `market_insight` write already uses.
 */
async function requireLinkAuthority(
  actorUserId: string,
  projectSlug: string,
): Promise<Result<{ readonly projectId: string }, ProjectInsightLinkError>> {
  // 1. STANDING FIRST, before any id is read — but NOT fatal.
  const staffResult = await requirePlatformCapability(actorUserId, "moderate_taxonomy");
  const isModerator = staffResult.success;

  // 2. Resource and access decided by ONE predicate over ONE row, so the two authorizations
  //    cannot disagree. "No such project" and "you are neither its founder nor staff" are the
  //    SAME error, which is `requireProjectRole`'s discipline.
  const [project] = await db
    .select({ id: researchProject.id, founderUserId: researchProject.founderUserId })
    .from(researchProject)
    .where(eq(researchProject.slug, projectSlug));

  const isFounder = project !== undefined && project.founderUserId === actorUserId;
  if (!project || !(isFounder || isModerator)) {
    return { success: false, error: { type: "INSIGHT_LINK_DENIED" } };
  }

  return { success: true, value: { projectId: project.id } };
}

/**
 * `POST /research-projects/:projectSlug/market-insight-links` (§11k.2).
 *
 * AN UNPUBLISHED INSIGHT IS REFUSED WITH THE SAME `INSIGHT_LINK_DENIED`, not a distinct
 * error. A draft is unreachable through every public read — `discovery-catalog.service.ts`
 * hard-filters `published_at IS NOT NULL`, which is why `/discovery/admin/market-insights`
 * had to exist at all — so a status or message separating "no such insight" from "that
 * insight is a draft" would make this route the oracle those filters exist to prevent.
 */
export async function linkMarketInsightToProject(
  actorUserId: string,
  projectSlug: string,
  insightId: string,
): Promise<Result<ProjectInsightLinkView, ProjectInsightLinkError>> {
  const authority = await requireLinkAuthority(actorUserId, projectSlug);
  if (!authority.success) {
    return authority;
  }

  // 3. The insight, and it must be PUBLISHED. Same refusal as above — see the note.
  const [insight] = await db
    .select({ id: marketInsight.id, publishedAt: marketInsight.publishedAt })
    .from(marketInsight)
    .where(eq(marketInsight.id, insightId));

  if (!insight || insight.publishedAt === null) {
    return { success: false, error: { type: "INSIGHT_LINK_DENIED" } };
  }

  try {
    await db.insert(marketInsightProjectLink).values({
      projectId: authority.value.projectId,
      insightId,
      linkedByUserId: actorUserId,
    });
  } catch (error: unknown) {
    if (isUniqueViolation(error)) {
      // ONE constraint can raise 23505 here — the composite PK — so unlike
      // `linkProjectToCluster` this needs no disambiguating re-read. The table carries no
      // partial unique index, because a citation has no `origin` to bound.
      return { success: false, error: { type: "INSIGHT_ALREADY_LINKED" } };
    }
    throw error;
  }

  const created = await findProjectInsightLink(authority.value.projectId, insightId);
  if (!created) {
    throw new Error("linkMarketInsightToProject: inserted link could not be read back");
  }
  return { success: true, value: created };
}

async function findProjectInsightLink(
  projectId: string,
  insightId: string,
): Promise<ProjectInsightLinkView | null> {
  const [row] = await db
    .select({
      projectId: marketInsightProjectLink.projectId,
      projectSlug: researchProject.slug,
      insightId: marketInsightProjectLink.insightId,
      headline: marketInsight.headline,
      linkedByUserId: marketInsightProjectLink.linkedByUserId,
      createdAt: marketInsightProjectLink.createdAt,
    })
    .from(marketInsightProjectLink)
    .innerJoin(researchProject, eq(researchProject.id, marketInsightProjectLink.projectId))
    .innerJoin(marketInsight, eq(marketInsight.id, marketInsightProjectLink.insightId))
    .where(
      and(
        eq(marketInsightProjectLink.projectId, projectId),
        eq(marketInsightProjectLink.insightId, insightId),
      ),
    );

  return row ?? null;
}

/**
 * `DELETE /research-projects/:projectSlug/market-insight-links/:insightId` (§11k.2).
 *
 * IT DOES NOT RE-CHECK `publishedAt`, and that asymmetry with the create is deliberate: an
 * insight can be unpublished AFTER being cited, and a citation nobody can retract because a
 * moderator withdrew the insight is a row stuck in the schema forever.
 *
 * EITHER PARTY MAY REMOVE EITHER PARTY'S LINK. `problem_cluster_project_link` can be stricter
 * — a founder cannot retract a moderator's curation link — only because its `source` column
 * records who claimed what. This table has no such column by design, so there is nothing to
 * attribute a row to, and deriving an owner from `linkedByUserId` would make the permission
 * rule depend on a nullable column that goes NULL when the account is deleted.
 *
 * A hard delete: the composite-PK row has no inbound FKs, and a retracted citation is not a
 * record worth keeping.
 */
export async function unlinkMarketInsightFromProject(
  actorUserId: string,
  projectSlug: string,
  insightId: string,
): Promise<Result<{ readonly deleted: true }, ProjectInsightLinkError>> {
  const authority = await requireLinkAuthority(actorUserId, projectSlug);
  if (!authority.success) {
    return authority;
  }

  const [deleted] = await db
    .delete(marketInsightProjectLink)
    .where(
      and(
        eq(marketInsightProjectLink.projectId, authority.value.projectId),
        eq(marketInsightProjectLink.insightId, insightId),
      ),
    )
    .returning({ insightId: marketInsightProjectLink.insightId });

  if (!deleted) {
    // Reachable only AFTER authorization passed, so naming it discloses nothing a caller who
    // can already read the project's chips does not know.
    return { success: false, error: { type: "INSIGHT_LINK_NOT_FOUND" } };
  }

  return { success: true, value: { deleted: true } };
}
