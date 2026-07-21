import { and, between, eq, isNotNull, or, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { problemCluster, problemSubmission } from "#src/db/schema.js";
import {
  boundingBoxMicrodegrees,
  isWithinRadius,
  meanCentroidMicrodegrees,
  squaredDistanceScaled,
  type GeoPointMicrodegrees,
} from "#src/lib/geo.js";
import { resolveLocation } from "#src/lib/geocoding.js";
import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import { compareUtf8Bytes } from "#src/lib/ordering.js";
import {
  jaccardBasisPoints,
  normalizeToTokenSet,
  TEXT_SIMILARITY_THRESHOLD_BASIS_POINTS,
} from "#src/lib/text-similarity.js";

/**
 * Attaches one problem submission to a cluster, geocoding it first
 * (R_AND_D_BACKEND_STRUCTURE.md §6, §4e).
 *
 * This cannot run inside the HTTP request: geocoding is a rate-limited call to a third
 * party, and the candidate scan plus centroid recompute are database work proportional to
 * how many reports already exist nearby. `POST /discovery/problem-reports` returns 202 and
 * this runs after.
 *
 * DETERMINISM (§4c). Re-running this against the same submission produces byte-identical
 * output, which is what makes it safe to retry:
 *   - The geocode comes from `geocode_cache`, never a fresh provider call, so the
 *     coordinates cannot drift between runs.
 *   - Candidate ranking uses a TOTAL order ending in the cluster id, so ties cannot
 *     resolve differently on two machines.
 *   - The centroid is recomputed from the FULL member set rather than folded in
 *     incrementally, so attach order cannot change it.
 */

/** Two reports within this distance MAY describe the same problem. */
const CLUSTER_RADIUS_MILLIMETRES = 25_000_000; // 25 km

interface ClusterCandidate {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly centroidLatitudeMicrodegrees: number;
  readonly centroidLongitudeMicrodegrees: number;
}

interface ScoredCandidate {
  readonly candidate: ClusterCandidate;
  readonly similarityBasisPoints: number;
  readonly squaredDistanceScaled: bigint;
}

/**
 * Picks the best candidate under a TOTAL order:
 *   similarity DESC → distance ASC → cluster id ASC (byte-wise)
 *
 * The id is unique, so the order is total and no tie can survive to be broken by row
 * order — which is exactly what §4c rule 4 requires of anything a job depends on.
 */
export function selectBestCandidate(scored: readonly ScoredCandidate[]): ScoredCandidate | null {
  let best: ScoredCandidate | null = null;

  for (const current of scored) {
    if (best === null) {
      best = current;
      continue;
    }
    if (current.similarityBasisPoints !== best.similarityBasisPoints) {
      if (current.similarityBasisPoints > best.similarityBasisPoints) best = current;
      continue;
    }
    if (current.squaredDistanceScaled !== best.squaredDistanceScaled) {
      if (current.squaredDistanceScaled < best.squaredDistanceScaled) best = current;
      continue;
    }
    if (compareUtf8Bytes(current.candidate.id, best.candidate.id) < 0) {
      best = current;
    }
  }

  return best;
}

export async function handleGeocodeAndClusterSubmission(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.geocodeAndClusterSubmission,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.geocodeAndClusterSubmission],
    rawPayload,
  );

  const [submission] = await db
    .select({
      id: problemSubmission.id,
      title: problemSubmission.title,
      description: problemSubmission.description,
      categoryId: problemSubmission.categoryId,
      locationText: problemSubmission.locationText,
      status: problemSubmission.status,
      clusterId: problemSubmission.clusterId,
      reporterUserId: problemSubmission.reporterUserId,
      createdAt: problemSubmission.createdAt,
    })
    .from(problemSubmission)
    .where(eq(problemSubmission.id, payload.submissionId));

  if (!submission) {
    // The submission was hard-deleted between enqueue and run. Nothing to do, and
    // failing would just dead-letter a job about a row that no longer exists.
    return;
  }

  // IDEMPOTENCY GUARD, and the reason a re-run is a pure read: a submission belongs to
  // exactly one cluster forever, so once attached there is nothing left to decide.
  if (submission.clusterId !== null) {
    return;
  }

  const geocodeResult = await resolveLocation(submission.locationText);

  if (!geocodeResult.success) {
    if (geocodeResult.error.type === "GEOCODER_UNAVAILABLE") {
      // RETRYABLE. The network failed, which says nothing about whether the place exists
      // — throwing hands it back to pg-boss's exponential backoff.
      throw new Error(
        `geocode-and-cluster: provider unavailable for submission ${submission.id}: ${geocodeResult.error.detail}`,
      );
    }

    // TERMINAL for this submission: the location text does not resolve, and asking again
    // produces the same answer. Recorded on the row so the reporter can see WHY rather
    // than watching it sit "queued" forever, and so a human can correct it.
    await db
      .update(problemSubmission)
      .set({
        status: "geocode_failed",
        geocodeFailureReason:
          geocodeResult.error.type === "GEOCODER_NOT_CONFIGURED"
            ? "Geocoding is not configured on this deployment."
            : "That location could not be found.",
      })
      .where(eq(problemSubmission.id, submission.id));
    return;
  }

  const resolved = geocodeResult.value;
  const submissionPoint: GeoPointMicrodegrees = {
    latitudeMicrodegrees: resolved.latitudeMicrodegrees,
    longitudeMicrodegrees: resolved.longitudeMicrodegrees,
  };
  const submissionTokens = normalizeToTokenSet(`${submission.title} ${submission.description}`);

  // The index-friendly prefilter: one or two rectangles that strictly contain the circle.
  // Postgres does a plain BETWEEN on two int4 columns; the exact circle test runs in
  // TypeScript, where the arithmetic is bigint and reproducible.
  const boundingBoxes = boundingBoxMicrodegrees(submissionPoint, CLUSTER_RADIUS_MILLIMETRES);
  const boxPredicates = boundingBoxes.map((box) =>
    and(
      between(
        problemCluster.centroidLatitudeMicrodegrees,
        box.minLatitudeMicrodegrees,
        box.maxLatitudeMicrodegrees,
      ),
      between(
        problemCluster.centroidLongitudeMicrodegrees,
        box.minLongitudeMicrodegrees,
        box.maxLongitudeMicrodegrees,
      ),
    ),
  );

  const candidates: readonly ClusterCandidate[] = await db
    .select({
      id: problemCluster.id,
      title: problemCluster.title,
      description: problemCluster.description,
      centroidLatitudeMicrodegrees: problemCluster.centroidLatitudeMicrodegrees,
      centroidLongitudeMicrodegrees: problemCluster.centroidLongitudeMicrodegrees,
    })
    .from(problemCluster)
    .where(
      and(
        eq(problemCluster.categoryId, submission.categoryId),
        eq(problemCluster.status, "active"),
        boxPredicates.length === 1 ? boxPredicates[0] : or(...boxPredicates),
      ),
    );

  const scored: ScoredCandidate[] = [];
  for (const candidate of candidates) {
    const candidateCentroid: GeoPointMicrodegrees = {
      latitudeMicrodegrees: candidate.centroidLatitudeMicrodegrees,
      longitudeMicrodegrees: candidate.centroidLongitudeMicrodegrees,
    };

    // The CLUSTER CENTROID is the anchor — geo.ts's cosine band is taken from the anchor,
    // so passing the candidate consistently keeps every comparison in this round measured
    // against the same reference.
    if (!isWithinRadius(candidateCentroid, submissionPoint, CLUSTER_RADIUS_MILLIMETRES)) {
      continue;
    }

    const similarityBasisPoints = jaccardBasisPoints(
      submissionTokens,
      normalizeToTokenSet(`${candidate.title} ${candidate.description}`),
    );
    if (similarityBasisPoints < TEXT_SIMILARITY_THRESHOLD_BASIS_POINTS) {
      continue;
    }

    scored.push({
      candidate,
      similarityBasisPoints,
      squaredDistanceScaled: squaredDistanceScaled(candidateCentroid, submissionPoint),
    });
  }

  const best = selectBestCandidate(scored);

  await db.transaction(async (tx) => {
    // Re-assert the guard INSIDE the transaction: another worker may have attached this
    // submission between the read above and here.
    const [current] = await tx
      .select({ clusterId: problemSubmission.clusterId })
      .from(problemSubmission)
      .where(eq(problemSubmission.id, submission.id))
      .for("update");

    if (!current || current.clusterId !== null) {
      return;
    }

    const targetClusterId = best?.candidate.id ?? null;

    if (targetClusterId === null) {
      // No match: this submission founds a singleton cluster. Its title and description
      // seed the cluster's, which is why the cluster text is editable by a moderator
      // later — one person's phrasing should not permanently define a shared entity.
      const [createdCluster] = await tx
        .insert(problemCluster)
        .values({
          title: submission.title,
          description: submission.description,
          categoryId: submission.categoryId,
          centroidLatitudeMicrodegrees: resolved.latitudeMicrodegrees,
          centroidLongitudeMicrodegrees: resolved.longitudeMicrodegrees,
          centroidLatitudeSumMicrodegrees: resolved.latitudeMicrodegrees,
          centroidLongitudeSumMicrodegrees: resolved.longitudeMicrodegrees,
          centroidSampleCount: 1,
          countryCode: resolved.countryCode,
          regionId: resolved.regionId,
          locationLabel: resolved.resolvedLabel,
          distinctReporterCount: 1,
          submissionCount: 1,
          firstReportedAt: submission.createdAt,
          lastReportedAt: submission.createdAt,
        })
        .returning({ id: problemCluster.id });

      if (!createdCluster) {
        throw new Error("geocode-and-cluster: cluster insert returned no row");
      }

      await tx
        .update(problemSubmission)
        .set({
          status: "clustered",
          clusterId: createdCluster.id,
          clusteredAt: new Date(),
          clusterMatchBasisPoints: 10_000,
          latitudeMicrodegrees: resolved.latitudeMicrodegrees,
          longitudeMicrodegrees: resolved.longitudeMicrodegrees,
          countryCode: resolved.countryCode,
          regionId: resolved.regionId,
          geocodeFailureReason: null,
        })
        .where(eq(problemSubmission.id, submission.id));
      return;
    }

    await tx
      .update(problemSubmission)
      .set({
        status: "clustered",
        clusterId: targetClusterId,
        clusteredAt: new Date(),
        clusterMatchBasisPoints: best?.similarityBasisPoints ?? 0,
        latitudeMicrodegrees: resolved.latitudeMicrodegrees,
        longitudeMicrodegrees: resolved.longitudeMicrodegrees,
        countryCode: resolved.countryCode,
        regionId: resolved.regionId,
        geocodeFailureReason: null,
      })
      .where(eq(problemSubmission.id, submission.id));

    // RECOMPUTE THE CENTROID FROM THE FULL MEMBER SET, never fold the new point into a
    // running mean. §4c bans the running-mean update precisely because it is
    // order-dependent: two replicas replaying the same attaches in different orders would
    // drift apart. SQL aggregates the raw integers; TypeScript does the division.
    const memberPoints = await tx
      .select({
        latitudeMicrodegrees: problemSubmission.latitudeMicrodegrees,
        longitudeMicrodegrees: problemSubmission.longitudeMicrodegrees,
      })
      .from(problemSubmission)
      .where(
        and(
          eq(problemSubmission.clusterId, targetClusterId),
          isNotNull(problemSubmission.latitudeMicrodegrees),
        ),
      );

    const usablePoints: GeoPointMicrodegrees[] = [];
    for (const point of memberPoints) {
      if (point.latitudeMicrodegrees !== null && point.longitudeMicrodegrees !== null) {
        usablePoints.push({
          latitudeMicrodegrees: point.latitudeMicrodegrees,
          longitudeMicrodegrees: point.longitudeMicrodegrees,
        });
      }
    }

    const recomputedCentroid = meanCentroidMicrodegrees(usablePoints);

    // COUNTS come from SQL, which is what SQL is for. TIMESTAMPS deliberately do NOT.
    //
    // `sql<Date>\`min(created_at)\`` is a type ANNOTATION, not a parse instruction —
    // drizzle hands back whatever the driver produced, so the declared `Date` was simply
    // a claim the runtime never honoured, and the write then failed inside
    // PgTimestamp.mapToDriverValue with "value.toISOString is not a function". Aggregates
    // over an empty set also return NULL, which the annotation likewise denied.
    //
    // Folding the bounds in TypeScript is both safer and exact: attaching ONE submission
    // can only ever widen the range by that submission's own instant, and both operands
    // are already in hand as real Date objects.
    const [aggregates] = await tx
      .select({
        // COUNT(DISTINCT …) over IDENTIFIED submissions only, honouring the moderator's
        // strike flag. This single expression is the sybil resistance of the whole score.
        distinctReporterCount: sql<number>`count(distinct ${problemSubmission.reporterUserId}) filter (where ${problemSubmission.countsTowardDistinctReporters})::int`,
        submissionCount: sql<number>`count(*)::int`,
        // `::bigint` arrives as a STRING from node-postgres (values can exceed 2^53), so
        // it is converted explicitly rather than trusted to be a number.
        latitudeSum: sql<string>`coalesce(sum(${problemSubmission.latitudeMicrodegrees}), 0)::bigint`,
        longitudeSum: sql<string>`coalesce(sum(${problemSubmission.longitudeMicrodegrees}), 0)::bigint`,
      })
      .from(problemSubmission)
      .where(eq(problemSubmission.clusterId, targetClusterId));

    if (!aggregates) {
      throw new Error("geocode-and-cluster: cluster aggregate returned no row");
    }

    const [existingCluster] = await tx
      .select({
        firstReportedAt: problemCluster.firstReportedAt,
        lastReportedAt: problemCluster.lastReportedAt,
      })
      .from(problemCluster)
      .where(eq(problemCluster.id, targetClusterId));

    if (!existingCluster) {
      throw new Error(`geocode-and-cluster: cluster ${targetClusterId} vanished mid-transaction`);
    }

    const firstReportedAt =
      submission.createdAt < existingCluster.firstReportedAt
        ? submission.createdAt
        : existingCluster.firstReportedAt;
    const lastReportedAt =
      submission.createdAt > existingCluster.lastReportedAt
        ? submission.createdAt
        : existingCluster.lastReportedAt;

    await tx
      .update(problemCluster)
      .set({
        centroidLatitudeMicrodegrees: recomputedCentroid.latitudeMicrodegrees,
        centroidLongitudeMicrodegrees: recomputedCentroid.longitudeMicrodegrees,
        centroidLatitudeSumMicrodegrees: Number(aggregates.latitudeSum),
        centroidLongitudeSumMicrodegrees: Number(aggregates.longitudeSum),
        centroidSampleCount: usablePoints.length,
        distinctReporterCount: aggregates.distinctReporterCount,
        submissionCount: aggregates.submissionCount,
        firstReportedAt,
        lastReportedAt,
      })
      .where(eq(problemCluster.id, targetClusterId));
  });
}
