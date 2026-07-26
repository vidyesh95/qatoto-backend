import { and, eq, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  pieBakeEvent,
  product,
  projectStats,
  projectSupplierEngagement,
  researchProject,
} from "#src/db/schema.js";

/**
 * Launch readiness (R_AND_D_BACKEND_STRUCTURE.md §11i, Appendix B4).
 *
 * DERIVED, NOT STORED. There is no readiness table and there must not be one: every input
 * below already exists somewhere authoritative, and a stored copy would be a second answer
 * to a question that already has one — stale the moment a stage changes or a job runs.
 *
 * THE TRI-STATE IS AUTHORED HERE. Appendix B says the checklist "reuses the `met` /
 * `not_met` / `waived` shape §9.11's pre-bake checklist already established". §9.11
 * established no such thing — it specifies a typed acknowledgement, an `expectedSnapshotId`
 * and a `409 UNSETTLED_ALLOCATIONS` refusal, and `pie-bake.service.ts` implements those as
 * three sequential gates returning an error union. `met`/`not_met`/`waived` appears nowhere
 * in the codebase. So this file introduces it rather than inheriting it, and the
 * instruction that mattered is honoured: THREE STATES, NOT FOUR.
 *
 * `waived` IS REPRESENTABLE AND CURRENTLY UNREACHABLE. There is no waiver table and no
 * endpoint that grants one, so nothing in this phase produces it. It stays in the union
 * because the surface renders three states and because a waiver, when it lands, is a
 * recorded decision by a named person — not a fourth flavour of `met`.
 *
 * NULL IS `not_met`, NEVER A FABRICATED ZERO. `project_stats`'s job-computed columns are
 * nullable with no default precisely so that "no job has run" stays distinguishable from
 * "the job ran and found nothing" (§5). A checklist that read NULL as 0 would report
 * "no verified effort" as a finding about the project rather than about the pipeline.
 */

export type LaunchReadinessState = "met" | "not_met" | "waived";

export type LaunchReadinessKey =
  | "stage_is_go_to_market"
  | "verified_effort_recorded"
  | "equity_allocated"
  | "cap_table_baked"
  | "supplier_engaged"
  | "store_listing_exists";

export interface LaunchReadinessItem {
  readonly key: LaunchReadinessKey;
  readonly state: LaunchReadinessState;
  /**
   * The integer the state was decided from, or null when the underlying signal has never
   * been computed. INTEGERS ONLY — no prose, so three clients localize their own copy
   * rather than rendering an English sentence the server invented (§4d).
   */
  readonly observedCount: number | null;
}

export interface LaunchReadinessView {
  readonly projectSlug: string;
  readonly stage: (typeof researchProject.$inferSelect)["stage"];
  readonly items: readonly LaunchReadinessItem[];
  readonly metCount: number;
  readonly totalCount: number;
  /**
   * `project_stats.statsComputedAt`, or null before any job has written it.
   *
   * Two of the six items read job-computed columns that decay or advance with no write, so
   * a checklist rendered without an "as of" asserts freshness it does not have.
   */
  readonly asOf: Date | null;
}

/** NULL means "never computed" and is `not_met`; a positive count is `met`. */
function stateFromCount(observedCount: number | null): LaunchReadinessState {
  return observedCount !== null && observedCount > 0 ? "met" : "not_met";
}

/**
 * The six-item checklist for one project.
 *
 * Returns null when the project does not exist. The caller has already proven membership
 * from the slug, so there is no id to probe here.
 */
export async function computeLaunchReadiness(
  projectId: string,
  projectSlug: string,
): Promise<LaunchReadinessView | null> {
  const [projectRow] = await db
    .select({
      stage: researchProject.stage,
      verifiedEffortMinutesTotal: projectStats.verifiedEffortMinutesTotal,
      allocatedEquityBasisPoints: projectStats.allocatedEquityBasisPoints,
      statsComputedAt: projectStats.statsComputedAt,
    })
    .from(researchProject)
    .innerJoin(projectStats, eq(projectStats.projectId, researchProject.id))
    .where(eq(researchProject.id, projectId))
    .limit(1);

  if (!projectRow) return null;

  const [bakeRow, engagementRow, listingRow] = await Promise.all([
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(pieBakeEvent)
      .where(eq(pieBakeEvent.projectId, projectId)),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(projectSupplierEngagement)
      .where(eq(projectSupplierEngagement.projectId, projectId)),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(product)
      .where(and(eq(product.researchProjectId, projectId), eq(product.status, "active"))),
  ]);

  const items: readonly LaunchReadinessItem[] = [
    {
      key: "stage_is_go_to_market",
      state: projectRow.stage === "go_to_market" ? "met" : "not_met",
      // A stage is not a count. `1`/`0` here is the honest integer encoding of a boolean
      // signal, and the key is what a client reads — never this number's magnitude.
      observedCount: projectRow.stage === "go_to_market" ? 1 : 0,
    },
    {
      key: "verified_effort_recorded",
      state: stateFromCount(projectRow.verifiedEffortMinutesTotal),
      observedCount: projectRow.verifiedEffortMinutesTotal,
    },
    {
      key: "equity_allocated",
      state: stateFromCount(projectRow.allocatedEquityBasisPoints),
      observedCount: projectRow.allocatedEquityBasisPoints,
    },
    {
      key: "cap_table_baked",
      // `pie_bake_event_project_unq` guarantees at most one, ever — so this count is 0 or 1
      // and never needs interpreting.
      state: stateFromCount(bakeRow[0]?.total ?? 0),
      observedCount: bakeRow[0]?.total ?? 0,
    },
    {
      key: "supplier_engaged",
      state: stateFromCount(engagementRow[0]?.total ?? 0),
      observedCount: engagementRow[0]?.total ?? 0,
    },
    {
      key: "store_listing_exists",
      state: stateFromCount(listingRow[0]?.total ?? 0),
      observedCount: listingRow[0]?.total ?? 0,
    },
  ];

  return {
    projectSlug,
    stage: projectRow.stage,
    items,
    // `waived` counts as met when it exists; today nothing produces it, and writing the
    // predicate now means the count does not silently under-report on the day one lands.
    metCount: items.filter((item) => item.state === "met" || item.state === "waived").length,
    totalCount: items.length,
    asOf: projectRow.statsComputedAt,
  };
}
