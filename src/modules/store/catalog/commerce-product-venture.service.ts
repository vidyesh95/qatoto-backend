import { and, eq } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { projectStats, researchProject } from "#src/db/schema.js";

/**
 * THE R&D → STORE HANDOFF, READ SIDE (§11i, Appendix B4; frontend todo §19).
 *
 * `product.researchProjectId` (`src/db/schema/store.ts:2781`) has existed since the handoff landed and
 * until now reached NO wire at all. Its only two readers were a count inside
 * `launch-readiness.service.ts` and `suppliers.service.ts`, which selects it purely to group by
 * and then strips it (`suppliers.service.ts:576`). This module is what finally lets a BUYER see
 * it: the product page can say which venture built the thing, and link to the record.
 *
 * A READ CROSSING ONLY. The boundary comment on that column forbids a WRITE crossing — "a
 * research route that proxied a product create" — and says nothing against reads. The reverse
 * direction already exists: `launch-readiness.service.ts`, an R&D module, reads the `product`
 * table. Nothing here writes.
 *
 * THE ID NEVER LEAVES. The store holds a `researchProjectId` UUID, but every R&D read surface —
 * route, service view and the frontend schema — is addressed by SLUG and exposes no `id`
 * (`ResearchProjectListRow` and `ResearchProjectDetailView` both start at `slug`; there is no
 * by-id project route anywhere). Joining here, inside one backend, is what makes that survivable:
 * the projection carries `projectSlug` and the raw id is dropped at the call site, exactly the
 * discipline `suppliers.service.ts:576` follows.
 */

/**
 * The narrow, PUBLIC venture shape a buyer may see. Deliberately not `ResearchProjectDetailView`:
 * that read fires nine member-scoped child reads a buyer gets none of.
 *
 * WHAT IS ABSENT IS THE POINT:
 *   - `allocatedEquityBasisPoints` — public on `/launch-ready-projects`, which is an R&D surface
 *     addressed to contributors. Rendered on a buy page next to a price, an equity aggregate
 *     reads as a claim about the transaction. No slice numerator crosses to the store.
 *   - `pendingApplicationCount` — `projectStats` marks it founder-facing, never public.
 *   - milestones — `listProjectMilestones` is member-scoped (`requireRoleOrRespond(…, "contributor")`)
 *     and 404s for a buyer, and `milestone` rows carry `plannedPayoutInCents` besides. There is
 *     also no product→milestone link to hang "the milestone that shipped it" on; only the project FK.
 *   - `plannedPayoutInCents`, escrow state, anything `investor_only`.
 */
export interface ProductVentureProvenanceProjection {
  readonly projectSlug: string;
  readonly projectName: string;
  /** notNull on the column — a project cannot exist without one. */
  readonly projectTagline: string;
  readonly projectCoverImageUrl: string | null;
  readonly stage: (typeof researchProject.$inferSelect)["stage"];
  /**
   * NULL until §9's jobs have run, and rendered as an absence. Coercing either of these to 0
   * would assert "this venture has no verified effort" about a venture that is shipping — the
   * same rule `launch-ready-projects-rail.tsx` states on the R&D side.
   */
  readonly verifiedEffortMinutesTotal: number | null;
  /**
   * NULLABLE HERE THOUGH THE COLUMN IS `notNull`, because the JOIN is a LEFT one. `project_stats` is
   * a rebuildable cache (its own comment calls it that, and `reconcile-project-stats.ts` rebuilds
   * it); 15 of the 41 active projects have no row at all. An inner join would make the venture
   * block VANISH for those — the buyer would be told nothing built this listing because a counter
   * cache is missing, which is a worse lie than a missing count.
   */
  readonly teamMemberCount: number | null;
  /** So the client renders an "as of" and never implies live numbers. */
  readonly statsComputedAt: Date | null;
}

/**
 * Resolve the venture behind a listing, or `null`.
 *
 * `null` covers three cases the caller must NOT distinguish: the product has no venture (the
 * common one, and it costs no query), the venture is not `active`, or the row is gone.
 *
 * THE `status = 'active'` PREDICATE IS LOAD-BEARING. `findResearchProjectBySlug` 404s drafts for
 * non-members; without this the product page would become a side channel that names an
 * unpublished venture to anonymous buyers. An archived venture is excluded on the same rule —
 * it was withdrawn from public view, and a store page is public view.
 */
export async function loadProductVentureProvenance(
  researchProjectId: string | null,
): Promise<ProductVentureProvenanceProjection | null> {
  if (researchProjectId === null) return null;

  // The column choice is `suppliers.service.ts:523-536`'s, which is the proven public shape, minus
  // the equity term (see the interface note). The JOIN DIFFERS DELIBERATELY: that rail inner-joins
  // `projectStats` because a project missing its cache merely drops off a list of many. Here the
  // venture is the only one there is, so a missing cache must cost the COUNTS, not the credit.
  const [row] = await db
    .select({
      projectSlug: researchProject.slug,
      projectName: researchProject.name,
      projectTagline: researchProject.tagline,
      projectCoverImageUrl: researchProject.coverImageUrl,
      stage: researchProject.stage,
      verifiedEffortMinutesTotal: projectStats.verifiedEffortMinutesTotal,
      teamMemberCount: projectStats.teamMemberCount,
      statsComputedAt: projectStats.statsComputedAt,
    })
    .from(researchProject)
    .leftJoin(projectStats, eq(projectStats.projectId, researchProject.id))
    .where(and(eq(researchProject.id, researchProjectId), eq(researchProject.status, "active")))
    .limit(1);

  return row ?? null;
}
