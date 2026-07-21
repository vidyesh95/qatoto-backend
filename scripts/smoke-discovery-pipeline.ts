/**
 * End-to-end smoke test for the §6 discovery pipeline, against a REAL database and a REAL
 * geocoding provider.
 *
 * WHY THIS EXISTS. The vitest suite mocks `#src/db/index.js` wholesale, so it can prove
 * things about arithmetic and nothing about the pipeline: whether a submission actually
 * geocodes, whether clustering attaches it, whether the scoring job produces a snapshot
 * that satisfies its own CHECK constraints. Those are exactly the failures that matter and
 * exactly the ones unit tests cannot see.
 *
 * Creates a disposable user and submission, runs the job handlers INLINE (no worker
 * needed), asserts the outcome, and removes everything it created.
 *
 *   pnpm db:smoke-discovery
 *
 * Requires network access for geocoding. Exits non-zero on any failed assertion.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";

import { db, pool } from "#src/db/index.js";
import {
  geocodeCache,
  problemCluster,
  problemClusterScoreSnapshot,
  problemSubmission,
  researchCategory,
  user,
} from "#src/db/schema.js";
import { handleGeocodeAndClusterSubmission } from "#src/jobs/geocode-and-cluster-submission.js";
import { handleRecomputeOpportunityScores } from "#src/jobs/recompute-opportunity-scores.js";
import { truncateToUtcDayStart } from "#src/lib/as-of.js";

const SMOKE_PREFIX = "smoke-discovery";

interface Assertion {
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

const assertions: Assertion[] = [];

function record(label: string, passed: boolean, detail: string): void {
  assertions.push({ label, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${label} — ${detail}`);
}

async function main(): Promise<void> {
  const [category] = await db
    .select({ id: researchCategory.id })
    .from(researchCategory)
    .where(eq(researchCategory.status, "approved"))
    .limit(1);

  if (!category) {
    throw new Error("No approved category — run `pnpm db:seed-research-categories` first.");
  }

  const reporterUserId = `${SMOKE_PREFIX}-user-${randomUUID()}`;
  const createdSubmissionIds: string[] = [];
  let createdClusterId: string | null = null;

  try {
    await db.insert(user).values({
      id: reporterUserId,
      name: "Smoke Reporter",
      email: `${reporterUserId}@example.invalid`,
      emailVerified: true,
    });

    // Two reports of the SAME problem in the SAME place, worded differently. The second
    // must attach to the cluster the first founded — that is the whole point of §6's
    // "a submission is not a report" split.
    const [firstSubmission] = await db
      .insert(problemSubmission)
      .values({
        reporterUserId,
        title: "Fresh produce spoils before reaching market",
        description:
          "Vendors lose a third of tomatoes and leafy greens in transit because there is no affordable cold storage between the farms and the city market.",
        categoryId: category.id,
        locationText: "Nakuru, Kenya",
      })
      .returning({ id: problemSubmission.id });

    if (!firstSubmission) throw new Error("first submission insert returned no row");
    createdSubmissionIds.push(firstSubmission.id);

    await handleGeocodeAndClusterSubmission({ submissionId: firstSubmission.id });

    const [afterFirst] = await db
      .select({
        status: problemSubmission.status,
        clusterId: problemSubmission.clusterId,
        countryCode: problemSubmission.countryCode,
        latitudeMicrodegrees: problemSubmission.latitudeMicrodegrees,
        regionId: problemSubmission.regionId,
        failureReason: problemSubmission.geocodeFailureReason,
      })
      .from(problemSubmission)
      .where(eq(problemSubmission.id, firstSubmission.id));

    if (!afterFirst) throw new Error("first submission vanished");

    if (afterFirst.status === "geocode_failed") {
      // Distinguish "the pipeline is broken" from "this machine has no network".
      record(
        "geocoding resolved the location",
        false,
        `geocode_failed: ${afterFirst.failureReason ?? "unknown"} (network or provider issue?)`,
      );
      return;
    }

    record(
      "submission clustered",
      afterFirst.status === "clustered" && afterFirst.clusterId !== null,
      `status=${afterFirst.status} clusterId=${afterFirst.clusterId ?? "null"}`,
    );
    record(
      "countryCode server-derived, never client-supplied",
      afterFirst.countryCode === "KE",
      `countryCode=${afterFirst.countryCode ?? "null"}`,
    );
    record(
      "coordinates resolved to integer microdegrees",
      Number.isSafeInteger(afterFirst.latitudeMicrodegrees ?? Number.NaN),
      `lat=${afterFirst.latitudeMicrodegrees ?? "null"}`,
    );
    record(
      "region resolved from country code",
      afterFirst.regionId !== null,
      `regionId=${afterFirst.regionId ?? "null"}`,
    );

    createdClusterId = afterFirst.clusterId;

    // The second report, worded differently, in the same place.
    const [secondSubmission] = await db
      .insert(problemSubmission)
      .values({
        reporterUserId,
        title: "Tomatoes and greens rot on the way to the city market",
        description:
          "Produce spoils in transit for lack of affordable cold storage between farm aggregation points and the wholesale market.",
        categoryId: category.id,
        locationText: "Nakuru, Kenya",
      })
      .returning({ id: problemSubmission.id });

    if (!secondSubmission) throw new Error("second submission insert returned no row");
    createdSubmissionIds.push(secondSubmission.id);

    await handleGeocodeAndClusterSubmission({ submissionId: secondSubmission.id });

    const [afterSecond] = await db
      .select({ clusterId: problemSubmission.clusterId })
      .from(problemSubmission)
      .where(eq(problemSubmission.id, secondSubmission.id));

    record(
      "second report joined the SAME cluster (dedup works)",
      afterSecond?.clusterId === createdClusterId && createdClusterId !== null,
      `first=${createdClusterId ?? "null"} second=${afterSecond?.clusterId ?? "null"}`,
    );

    // The geocode must have come from the CACHE the second time — that cache is what makes
    // the job deterministic on replay.
    const cacheRows = await db
      .select({ normalizedQuery: geocodeCache.normalizedQuery })
      .from(geocodeCache)
      .where(eq(geocodeCache.normalizedQuery, "nakuru, kenya"));
    record(
      "geocode cached for replay determinism",
      cacheRows.length === 1,
      `rows=${cacheRows.length}`,
    );

    if (createdClusterId) {
      const [cluster] = await db
        .select({
          distinctReporterCount: problemCluster.distinctReporterCount,
          submissionCount: problemCluster.submissionCount,
          centroidSampleCount: problemCluster.centroidSampleCount,
          scorePoints: problemCluster.currentOpportunityScorePoints,
        })
        .from(problemCluster)
        .where(eq(problemCluster.id, createdClusterId));

      record(
        "distinctReporterCount counts PEOPLE, not submissions",
        cluster?.distinctReporterCount === 1 && cluster.submissionCount === 2,
        `distinctReporters=${cluster?.distinctReporterCount} submissions=${cluster?.submissionCount}`,
      );
      record(
        "score is NULL before any scoring run, never 0",
        cluster?.scorePoints === null,
        `score=${String(cluster?.scorePoints)}`,
      );
    }

    // --- The scoring job.
    //
    // asOf is TOMORROW's UTC midnight, not today's, and that is not a workaround. Every
    // input query is bounded `created_at < asOf` (§4c), so a run at today's midnight
    // deliberately scores only COMPLETE days and excludes anything reported since — which
    // is exactly what the 02:15 UTC nightly run does, and why a report filed today is
    // scored tomorrow. The submissions above were created moments ago, so tomorrow's
    // boundary is the first asOf that includes them.
    const asOf = new Date(truncateToUtcDayStart(new Date()).getTime() + 86_400_000);
    await handleRecomputeOpportunityScores({ asOf: asOf.toISOString() });

    if (createdClusterId) {
      const [snapshot] = await db
        .select({
          opportunityScorePoints: problemClusterScoreSnapshot.opportunityScorePoints,
          reporterComponentPoints: problemClusterScoreSnapshot.reporterComponentPoints,
          spreadComponentPoints: problemClusterScoreSnapshot.spreadComponentPoints,
          demandComponentPoints: problemClusterScoreSnapshot.demandComponentPoints,
          recencyComponentPoints: problemClusterScoreSnapshot.recencyComponentPoints,
          scarcityComponentPoints: problemClusterScoreSnapshot.scarcityComponentPoints,
          asOf: problemClusterScoreSnapshot.asOf,
        })
        .from(problemClusterScoreSnapshot)
        .where(eq(problemClusterScoreSnapshot.clusterId, createdClusterId));

      record(
        "scoring job wrote a snapshot",
        snapshot !== undefined,
        `found=${snapshot !== undefined}`,
      );

      if (snapshot) {
        const componentSum =
          snapshot.reporterComponentPoints +
          snapshot.spreadComponentPoints +
          snapshot.demandComponentPoints +
          snapshot.recencyComponentPoints +
          snapshot.scarcityComponentPoints;
        record(
          "components sum to the score (the invariant is real, not decorative)",
          componentSum === snapshot.opportunityScorePoints,
          `${componentSum} === ${snapshot.opportunityScorePoints}`,
        );
        record(
          "score in range 0..100",
          snapshot.opportunityScorePoints >= 0 && snapshot.opportunityScorePoints <= 100,
          `score=${snapshot.opportunityScorePoints}`,
        );
        record(
          "asOf round-trips as an exact UTC day boundary",
          snapshot.asOf.getTime() === asOf.getTime(),
          `${snapshot.asOf.toISOString()} === ${asOf.toISOString()}`,
        );
      }

      // IDEMPOTENCY: re-running the same asOf must add nothing.
      await handleRecomputeOpportunityScores({ asOf: asOf.toISOString() });
      const snapshotsAfterRerun = await db
        .select({ id: problemClusterScoreSnapshot.id })
        .from(problemClusterScoreSnapshot)
        .where(eq(problemClusterScoreSnapshot.clusterId, createdClusterId));
      record(
        "re-running the same asOf is a no-op (§4e)",
        snapshotsAfterRerun.length === 1,
        `snapshots=${snapshotsAfterRerun.length}`,
      );

      const [scoredCluster] = await db
        .select({ scorePoints: problemCluster.currentOpportunityScorePoints })
        .from(problemCluster)
        .where(eq(problemCluster.id, createdClusterId));
      record(
        "denormalized score published to the cluster row",
        scoredCluster?.scorePoints !== null && scoredCluster?.scorePoints !== undefined,
        `score=${String(scoredCluster?.scorePoints)}`,
      );
    }
  } finally {
    // Teardown, innermost first. The score snapshot is append-only and its trigger rejects
    // DELETE, so it is removed with the trigger disabled — the one legitimate use of that,
    // and the reason this runs as an owner-privileged script rather than through the API.
    if (createdClusterId) {
      await pool.query(`ALTER TABLE problem_cluster_score_snapshot DISABLE TRIGGER USER`);
      await db
        .delete(problemClusterScoreSnapshot)
        .where(eq(problemClusterScoreSnapshot.clusterId, createdClusterId));
      await pool.query(`ALTER TABLE problem_cluster_score_snapshot ENABLE TRIGGER USER`);
    }
    if (createdSubmissionIds.length > 0) {
      await db.delete(problemSubmission).where(inArray(problemSubmission.id, createdSubmissionIds));
    }
    if (createdClusterId) {
      await db.delete(problemCluster).where(eq(problemCluster.id, createdClusterId));
    }
    await db.delete(user).where(and(eq(user.id, reporterUserId)));
  }

  const failureCount = assertions.filter((assertion) => !assertion.passed).length;
  console.log(
    failureCount === 0
      ? `\nAll ${assertions.length} pipeline assertions passed.`
      : `\n${failureCount} of ${assertions.length} pipeline assertions FAILED.`,
  );
  if (failureCount > 0) {
    process.exitCode = 1;
  }
}

main()
  .then(async () => {
    await pool.end();
    return undefined;
  })
  .catch(async (error: unknown) => {
    console.error("Discovery pipeline smoke test failed to run:", error);
    await pool.end();
    process.exit(1);
  });
