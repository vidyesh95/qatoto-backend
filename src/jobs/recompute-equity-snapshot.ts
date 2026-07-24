import { asc, eq } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { researchProject } from "#src/db/schema.js";
import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import { recomputeEquitySnapshot } from "#src/services/equity-snapshot.service.js";

/**
 * The nightly cap-table recomputation (R_AND_D_BACKEND_STRUCTURE.md §9.4, §4e).
 *
 * A PURE FUNCTION OF `(ledger prefix, asOf)`. The `asOf` arrives in the payload rather
 * than being read from a clock here (§4c rule 3), and the snapshot records the ledger
 * sequence number it covered — so replaying a historical `asOf` reproduces the historical
 * cap table byte for byte, which is what §17 step 2's determinism suite asserts.
 *
 * TWO MODES, one handler: `projectId: null` is the nightly sweep over every active
 * project; a named project is what the dispute sweep enqueues the instant slices land, so
 * a member who just watched their window lock sees the bar move rather than waiting for
 * 03:45 UTC.
 *
 * ONE PROJECT'S FAILURE MUST NOT STOP THE OTHERS. A nightly run over hundreds of projects
 * that aborts on the first bad row leaves every later project stale, and the staleness is
 * invisible. Each project is therefore recomputed independently and failures are counted.
 */
export async function handleRecomputeEquitySnapshot(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.recomputeEquitySnapshot,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.recomputeEquitySnapshot],
    rawPayload,
  );

  const asOf = new Date(payload.asOf);

  const projectIds =
    payload.projectId === null
      ? (
          await db
            .select({ id: researchProject.id })
            .from(researchProject)
            .where(eq(researchProject.status, "active"))
            // Ends in a unique column, so a re-run visits projects in the same order and
            // a partial failure is reproducible (§4c rule 4).
            .orderBy(asc(researchProject.id))
        ).map((project) => project.id)
      : [payload.projectId];

  const failures: string[] = [];

  for (const projectId of projectIds) {
    try {
      // A null return means the pie is baked: dynamic calculation has STOPPED and
      // percentages are frozen permanently (§9.11). Recomputing would silently un-bake it,
      // so the job treats it as a successful no-op rather than as work to do.
      await recomputeEquitySnapshot(projectId, asOf);
    } catch (error: unknown) {
      failures.push(`${projectId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length > 0) {
    // Rethrown so pg-boss retries and, past the retry limit, dead-letters into
    // `job_failure` where an operator can see it. A cap table silently stuck a week behind
    // is worse than a loud failure.
    throw new Error(
      `recompute-equity-snapshot: ${failures.length} project(s) failed — ${failures.join("; ")}`,
    );
  }
}
