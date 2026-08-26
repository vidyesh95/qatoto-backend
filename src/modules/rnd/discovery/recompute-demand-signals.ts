import { and, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceOrder,
  commerceOrderProductLine,
  commerceReview,
  demandSignalSnapshot,
  problemCluster,
  problemClusterProjectLink,
  problemSubmission,
  product,
  projectOpenRole,
  researchProject,
} from "#src/db/schema.js";
import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import { compareUtf8Bytes } from "#src/lib/ordering.js";
import { computeDemandScorePoints, deriveTrendDirection } from "#src/modules/rnd/demand-score.js";

/**
 * The nightly knowledge-hub demand leaderboard (R_AND_D_BACKEND_STRUCTURE.md §6, §4e),
 * one row per (region, category) cell.
 *
 * THE WHOLE JOB IS THE ORDERING. `rank` is unique within an `asOf` — the schema enforces
 * it — so the sort must be TOTAL before the insert or the unique index rejects the run.
 * The chain ends in (regionId, categoryId), which IS the cell's unique key, so no two rows
 * can tie and `rank = index + 1` is a total function. That is what makes the
 * competition-versus-dense-ranking question (1,2,2,4 vs 1,2,2,3) impossible to even ask
 * here, and it should stay that way: do not "fix" this later by adding tie handling.
 *
 * THE ENTIRE RUN IS ONE TRANSACTION. A reader resolving `MAX(asOf)` mid-run must never
 * see a half-written leaderboard with two rank-3s; uncommitted rows are invisible, so a
 * pinned asOf is always a whole run. This is why there is no run-header table.
 */

interface DemandCellInputs {
  readonly regionId: string;
  readonly categoryId: string;
  readonly clusterCount: number;
  readonly distinctReporterCount: number;
  readonly relatedProjectCount: number;
  readonly openRoleCount: number;
}

interface ScoredDemandCell extends DemandCellInputs {
  readonly demandScorePoints: number;
  /**
   * THE STORE'S EVIDENCE — units sold and visible reviews in the window, on listings this
   * cell's ventures actually shipped (Appendix B4).
   *
   * On the SCORED cell rather than on `DemandCellInputs`, and that placement is the decision.
   * These two counts are written to the row and rendered on the leaderboard, but they do not
   * feed `computeDemandScorePoints` — so they are not score inputs, and putting them in that
   * function's input type would say they were.
   *
   * WHY THEY ARE NOT SCORED, since the obvious next question is why not. Finding a sale 15 or
   * 20 points means taking them from the four component budgets, which are this module's
   * editorial claim about what "demand" means — asserted at module load, pinned by every
   * ladder's top rung, and covered by a test suite that checks each component directly.
   * Re-weighting reranks every cell on the board; that is a product decision, not a side
   * effect of teaching this job a new join. There is also a real argument the weight should be
   * small or zero: this hub surfaces demand that is NOT YET SERVED, and a cell with heavy
   * sales is being served — the inverted scarcity component already docks it for that.
   *
   * So the numbers reach the surface as evidence a reader can weigh, and the question of what
   * they are WORTH stays open and visible.
   */
  readonly soldUnitCount: number;
  readonly productReviewCount: number;
}

/**
 * Ranks cells under a total order:
 *   score DESC → distinct reporters DESC → clusters DESC → regionId ASC → categoryId ASC
 *
 * The last two keys are the cell's own composite unique key, so the comparator can never
 * return 0 for two distinct cells. String comparison is BYTE-WISE via `compareUtf8Bytes`,
 * never `<`: JavaScript compares UTF-16 code units while Postgres `COLLATE "C"` compares
 * bytes, and they disagree on astral-plane characters — a ranking that disagrees with the
 * database's own ordering is a ranking nobody can paginate.
 */
export function rankDemandCells(cells: readonly ScoredDemandCell[]): readonly ScoredDemandCell[] {
  return cells.toSorted((left, right) => {
    if (left.demandScorePoints !== right.demandScorePoints) {
      return right.demandScorePoints - left.demandScorePoints;
    }
    if (left.distinctReporterCount !== right.distinctReporterCount) {
      return right.distinctReporterCount - left.distinctReporterCount;
    }
    if (left.clusterCount !== right.clusterCount) {
      return right.clusterCount - left.clusterCount;
    }
    const byRegion = compareUtf8Bytes(left.regionId, right.regionId);
    if (byRegion !== 0) return byRegion;
    return compareUtf8Bytes(left.categoryId, right.categoryId);
  });
}

export async function handleRecomputeDemandSignals(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.recomputeDemandSignals,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.recomputeDemandSignals],
    rawPayload,
  );

  const asOf = new Date(payload.asOf);
  const windowStartsAt = new Date(payload.windowStartsAt);
  const windowEndsAt = new Date(payload.windowEndsAt);

  // One row per (region, category) that has any evidence inside the window. Bounded by
  // the ABSOLUTE window instants carried on the payload, never by a day count computed
  // here — that is what makes a replay of this asOf reproduce this exact set.
  const cellRows = await db
    .select({
      regionId: problemCluster.regionId,
      categoryId: problemCluster.categoryId,
      clusterCount: sql<number>`count(distinct ${problemCluster.id})::int`,
      distinctReporterCount: sql<number>`count(distinct ${problemSubmission.reporterUserId}) filter (where ${problemSubmission.countsTowardDistinctReporters})::int`,
    })
    .from(problemCluster)
    .innerJoin(problemSubmission, eq(problemSubmission.clusterId, problemCluster.id))
    .where(
      and(
        eq(problemCluster.status, "active"),
        sql`${problemCluster.regionId} is not null`,
        gte(problemSubmission.createdAt, windowStartsAt),
        lt(problemSubmission.createdAt, windowEndsAt),
      ),
    )
    .groupBy(problemCluster.regionId, problemCluster.categoryId);

  if (cellRows.length === 0) {
    return;
  }

  const scoredCells: ScoredDemandCell[] = [];

  for (const cell of cellRows) {
    if (cell.regionId === null) continue;

    const [projectCounts] = await db
      .select({
        relatedProjectCount: sql<number>`count(distinct ${problemClusterProjectLink.projectId})::int`,
      })
      .from(problemClusterProjectLink)
      .innerJoin(problemCluster, eq(problemClusterProjectLink.clusterId, problemCluster.id))
      .where(
        and(
          eq(problemCluster.regionId, cell.regionId),
          eq(problemCluster.categoryId, cell.categoryId),
          lt(problemClusterProjectLink.createdAt, windowEndsAt),
        ),
      );

    const [openRoleCounts] = await db
      .select({ openRoleCount: sql<number>`count(*)::int` })
      .from(projectOpenRole)
      .innerJoin(researchProject, eq(projectOpenRole.projectId, researchProject.id))
      .where(
        and(
          eq(researchProject.categoryId, cell.categoryId),
          eq(researchProject.status, "active"),
          eq(projectOpenRole.status, "open"),
          lt(projectOpenRole.createdAt, windowEndsAt),
        ),
      );

    // THE STORE'S CONTRIBUTION. Attributed through the CLUSTER, not the store taxonomy:
    // `problem_cluster` carries both the region and the category, while `commerce_category` has
    // no mapping to `research_category` and the store has no region concept at all. This is the
    // same join `relatedProjectCount` above already walks, one table further along.
    //
    // `completed_at`, NOT `confirmed_at` — the schema calls the first the order-level roll-up
    // clock, and the second is NULL for every order predating Phase 13 with nothing backfilling
    // it. `quantity_fulfilled` rather than `quantity_ordered`: a unit that was cancelled or
    // never shipped is not evidence anybody received anything.
    const [soldUnitCounts] = await db
      .select({
        soldUnitCount: sql<number>`COALESCE(sum(${commerceOrderProductLine.quantityFulfilled}), 0)::int`,
      })
      .from(commerceOrderProductLine)
      .innerJoin(commerceOrder, eq(commerceOrder.id, commerceOrderProductLine.orderId))
      .innerJoin(product, eq(product.id, commerceOrderProductLine.productId))
      .innerJoin(researchProject, eq(researchProject.id, product.researchProjectId))
      .innerJoin(
        problemClusterProjectLink,
        eq(problemClusterProjectLink.projectId, researchProject.id),
      )
      .innerJoin(problemCluster, eq(problemCluster.id, problemClusterProjectLink.clusterId))
      .where(
        and(
          eq(problemCluster.regionId, cell.regionId),
          eq(problemCluster.categoryId, cell.categoryId),
          inArray(commerceOrder.state, ["completed", "partially_completed"]),
          isNotNull(commerceOrder.completedAt),
          gte(commerceOrder.completedAt, windowStartsAt),
          lt(commerceOrder.completedAt, windowEndsAt),
        ),
      );

    // Visible reviews on those same listings. Recorded, displayed, and deliberately NOT scored —
    // see the column comment: a review corroborates a sale already counted above.
    const [reviewCounts] = await db
      .select({ productReviewCount: sql<number>`count(*)::int` })
      .from(commerceReview)
      .innerJoin(product, eq(product.id, commerceReview.productId))
      .innerJoin(researchProject, eq(researchProject.id, product.researchProjectId))
      .innerJoin(
        problemClusterProjectLink,
        eq(problemClusterProjectLink.projectId, researchProject.id),
      )
      .innerJoin(problemCluster, eq(problemCluster.id, problemClusterProjectLink.clusterId))
      .where(
        and(
          eq(problemCluster.regionId, cell.regionId),
          eq(problemCluster.categoryId, cell.categoryId),
          // Every public read filters on this; a hidden review is not evidence.
          eq(commerceReview.visibility, "visible"),
          gte(commerceReview.createdAt, windowStartsAt),
          lt(commerceReview.createdAt, windowEndsAt),
        ),
      );

    const inputs: DemandCellInputs = {
      regionId: cell.regionId,
      categoryId: cell.categoryId,
      clusterCount: cell.clusterCount,
      distinctReporterCount: cell.distinctReporterCount,
      relatedProjectCount: projectCounts?.relatedProjectCount ?? 0,
      openRoleCount: openRoleCounts?.openRoleCount ?? 0,
    };

    scoredCells.push({
      ...inputs,
      // RECORDED, NOT SCORED, and kept out of `computeDemandScorePoints`'s argument entirely
      // rather than passed and ignored — a value that cannot affect a result does not belong
      // in that function's input type. See the columns' own comments for why the weighting
      // question was left open instead of answered here.
      soldUnitCount: soldUnitCounts?.soldUnitCount ?? 0,
      productReviewCount: reviewCounts?.productReviewCount ?? 0,
      demandScorePoints: computeDemandScorePoints(inputs).totalPoints,
    });
  }

  const ranked = rankDemandCells(scoredCells);

  // The PREVIOUS run is read at a FIXED prior asOf, not as "the most recent snapshot".
  // Reading "the latest" would make this job's output depend on what else has run since,
  // so a replay would produce a different trendDirection than the original — the same
  // class of bug as omitting the `< asOf` bound.
  const previousAsOf = new Date(
    asOf.getTime() - (windowEndsAt.getTime() - windowStartsAt.getTime()),
  );
  const previousRows = await db
    .select({
      regionId: demandSignalSnapshot.regionId,
      categoryId: demandSignalSnapshot.categoryId,
      demandScorePoints: demandSignalSnapshot.demandScorePoints,
    })
    .from(demandSignalSnapshot)
    .where(eq(demandSignalSnapshot.asOf, previousAsOf));

  const previousScoreByCell = new Map<string, number>(
    previousRows.map((row) => [`${row.regionId}:${row.categoryId}`, row.demandScorePoints]),
  );

  await db.transaction(async (tx) => {
    await tx
      .insert(demandSignalSnapshot)
      .values(
        ranked.map((cell, rankIndex) => {
          const previousScore =
            previousScoreByCell.get(`${cell.regionId}:${cell.categoryId}`) ?? null;
          return {
            asOf,
            windowStartsAt,
            windowEndsAt,
            categoryId: cell.categoryId,
            regionId: cell.regionId,
            // Total order above guarantees no ties, so this is a total function.
            rank: rankIndex + 1,
            demandScorePoints: cell.demandScorePoints,
            previousDemandScorePoints: previousScore,
            trendDirection: deriveTrendDirection(cell.demandScorePoints, previousScore),
            clusterCount: cell.clusterCount,
            distinctReporterCount: cell.distinctReporterCount,
            relatedProjectCount: cell.relatedProjectCount,
            openRoleCount: cell.openRoleCount,
            soldUnitCount: cell.soldUnitCount,
            productReviewCount: cell.productReviewCount,
            // scoreAlgorithmVersion stays at its default of 1, deliberately: the two counts
            // above are recorded evidence, not score inputs, so the formula did NOT change and
            // these rows remain comparable to every row before them. See `DemandScoreInputs`.
          };
        }),
      )
      // Re-running the same asOf is a no-op, not a duplicate run (§4e).
      .onConflictDoNothing({
        target: [
          demandSignalSnapshot.asOf,
          demandSignalSnapshot.categoryId,
          demandSignalSnapshot.regionId,
        ],
      });
  });
}
