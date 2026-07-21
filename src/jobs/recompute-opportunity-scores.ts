import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  problemCluster,
  problemClusterProjectLink,
  problemClusterScoreSnapshot,
  problemSubmission,
} from "#src/db/schema.js";
import { truncateToUtcDayStart, wholeDaysBetweenUtcDayStarts } from "#src/lib/as-of.js";
import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import { basisPointsOf } from "#src/lib/money.js";
import { computeOpportunityScorePoints } from "#src/lib/opportunity-score.js";

/**
 * The nightly Civic Pulse ranking (R_AND_D_BACKEND_STRUCTURE.md §6, §4e).
 *
 * Writes an append-only `problem_cluster_score_snapshot` per cluster and denormalizes the
 * result onto `problem_cluster` so `?minOpportunityScorePoints=` hits an index instead of
 * joining to the latest snapshot.
 *
 * WHY EVERY INPUT QUERY IS BOUNDED `created_at < asOf`. This is the single most important
 * line in the job and the one most easily forgotten. Without the exclusive upper bound, a
 * re-run three hours later sees rows the first run did not, and "byte-identical on replay"
 * becomes false immediately — which would make the whole determinism argument decorative.
 *
 * The scoring arithmetic itself lives in src/lib/opportunity-score.ts, which is pure and
 * unit-tested without a database. This file only gathers inputs and persists outputs.
 */

/** How far back the score's evidence window reaches. Stored ABSOLUTELY on every row. */
const SCORE_WINDOW_DAYS = 365;
const MILLISECONDS_PER_DAY = 86_400_000;

export async function handleRecomputeOpportunityScores(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.recomputeOpportunityScores,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.recomputeOpportunityScores],
    rawPayload,
  );

  const asOf = new Date(payload.asOf);
  const windowEndsAt = asOf;
  const windowStartsAt = new Date(asOf.getTime() - SCORE_WINDOW_DAYS * MILLISECONDS_PER_DAY);

  // The denominator for every cluster's category share, computed ONCE so each cluster's
  // score is a share of the same whole. Bounded by asOf like everything else.
  const [totals] = await db
    .select({ submissionCount: sql<number>`count(*)::int` })
    .from(problemSubmission)
    .where(lt(problemSubmission.createdAt, asOf));

  const totalSubmissionCount = totals?.submissionCount ?? 0;

  if (totalSubmissionCount === 0) {
    // Nothing has been reported yet. Emitting zeros would publish a computed-looking fact
    // about an empty dataset — and `basisPointsOf` throws on a zero denominator anyway,
    // for the same reason.
    return;
  }

  const clusters = await db
    .select({
      id: problemCluster.id,
      categoryId: problemCluster.categoryId,
    })
    .from(problemCluster)
    .where(eq(problemCluster.status, "active"));

  for (const cluster of clusters) {
    // --- Inputs. Every one bounded `created_at < asOf`.
    const clusterMembershipFilter = and(
      eq(problemSubmission.clusterId, cluster.id),
      lt(problemSubmission.createdAt, asOf),
      eq(problemSubmission.status, "clustered"),
    );

    const [clusterAggregates] = await db
      .select({
        distinctReporterCount: sql<number>`count(distinct ${problemSubmission.reporterUserId}) filter (where ${problemSubmission.countsTowardDistinctReporters})::int`,
        submissionCount: sql<number>`count(*)::int`,
        distinctRegionCount: sql<number>`count(distinct ${problemSubmission.regionId})::int`,
      })
      .from(problemSubmission)
      .where(clusterMembershipFilter);

    // The most recent report, read as a REAL COLUMN rather than as `sql<Date>\`max(…)\``.
    // That annotation is a claim, not a parse instruction: drizzle returns whatever the
    // driver produced, so a declared `Date` silently arrives as something else and blows
    // up later in date arithmetic. Selecting the column itself goes through drizzle's own
    // timestamp mapping, which is the only path that actually yields a Date.
    const [mostRecentReport] = await db
      .select({ lastReportedAt: problemSubmission.createdAt })
      .from(problemSubmission)
      .where(clusterMembershipFilter)
      .orderBy(desc(problemSubmission.createdAt), desc(problemSubmission.id))
      .limit(1);

    if (!clusterAggregates || clusterAggregates.submissionCount === 0) {
      // A cluster whose every submission postdates `asOf` — real when replaying an older
      // asOf. It had no score at that instant, so it gets no snapshot.
      continue;
    }

    const [categoryTotals] = await db
      .select({ submissionCount: sql<number>`count(*)::int` })
      .from(problemSubmission)
      .where(
        and(eq(problemSubmission.categoryId, cluster.categoryId), lt(problemSubmission.createdAt, asOf)),
      );

    const [linkedProjects] = await db
      .select({ linkedProjectCount: sql<number>`count(*)::int` })
      .from(problemClusterProjectLink)
      .where(
        and(
          eq(problemClusterProjectLink.clusterId, cluster.id),
          lt(problemClusterProjectLink.createdAt, asOf),
        ),
      );

    const categoryShareBasisPoints = basisPointsOf(
      BigInt(categoryTotals?.submissionCount ?? 0),
      BigInt(totalSubmissionCount),
    );

    // Both operands truncated to UTC midnight, so the subtraction is an exact multiple of
    // a day and the division has no remainder — the quantization §6 asks for, applied
    // once, at the boundary. `exp(-age/halfLife)` never appears.
    const ageInDays = wholeDaysBetweenUtcDayStarts(
      truncateToUtcDayStart(mostRecentReport?.lastReportedAt ?? asOf),
      truncateToUtcDayStart(asOf),
    );

    const breakdown = computeOpportunityScorePoints({
      distinctReporterCount: clusterAggregates.distinctReporterCount,
      distinctRegionCount: clusterAggregates.distinctRegionCount,
      categoryShareBasisPoints,
      ageInDays,
      linkedProjectCount: linkedProjects?.linkedProjectCount ?? 0,
    });

    await db.transaction(async (tx) => {
      // ON CONFLICT DO NOTHING on (cluster_id, as_of): re-running the same asOf is a
      // no-op rather than a duplicate row or an UPDATE — the table is append-only and a
      // trigger would reject an UPDATE anyway (§4f).
      await tx
        .insert(problemClusterScoreSnapshot)
        .values({
          clusterId: cluster.id,
          asOf,
          windowStartsAt,
          windowEndsAt,
          opportunityScorePoints: breakdown.totalPoints,
          distinctReporterCount: clusterAggregates.distinctReporterCount,
          submissionCount: clusterAggregates.submissionCount,
          distinctRegionCount: clusterAggregates.distinctRegionCount,
          categoryShareBasisPoints,
          ageInDays,
          linkedProjectCount: linkedProjects?.linkedProjectCount ?? 0,
          reporterComponentPoints: breakdown.distinctReporterPoints,
          spreadComponentPoints: breakdown.geographicSpreadPoints,
          demandComponentPoints: breakdown.categoryDemandPoints,
          recencyComponentPoints: breakdown.recencyPoints,
          scarcityComponentPoints: breakdown.linkedProjectScarcityPoints,
        })
        .onConflictDoNothing({
          target: [problemClusterScoreSnapshot.clusterId, problemClusterScoreSnapshot.asOf],
        });

      // THE MONOTONIC GUARD. Without `scoreComputedAt IS NULL OR <= asOf`, an operator
      // replaying an old asOf for an audit would silently clobber today's published
      // scores with last month's — a destructive side effect of a read-only-looking
      // investigation.
      await tx
        .update(problemCluster)
        .set({
          currentOpportunityScorePoints: breakdown.totalPoints,
          scoreComputedAt: asOf,
        })
        .where(
          and(
            eq(problemCluster.id, cluster.id),
            or(isNull(problemCluster.scoreComputedAt), lt(problemCluster.scoreComputedAt, asOf)),
          ),
        );
    });
  }
}
