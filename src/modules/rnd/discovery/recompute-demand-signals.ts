import { and, eq, gte, lt, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  demandSignalSnapshot,
  problemCluster,
  problemClusterProjectLink,
  problemSubmission,
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
