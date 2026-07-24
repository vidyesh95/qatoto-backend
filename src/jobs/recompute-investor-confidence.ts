import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import {
  CONFIDENCE_WINDOW_DAYS,
  listProjectsForConfidence,
  recomputeInvestorConfidence,
} from "#src/services/investor-confidence.service.js";

/**
 * The nightly deal-flow signal (R_AND_D_BACKEND_STRUCTURE.md §7, §4e).
 *
 * Replaces `INVESTOR_CONFIDENCE_PERCENT = 78`, a constant the frontend rendered to
 * investors as though it were a measurement.
 *
 * A PURE FUNCTION OF `(data, asOf)` (§4c rule 3): the reference instant arrives in the
 * payload, the window is stored as ABSOLUTE BOUNDS rather than a day count, and re-running
 * any historical `asOf` reproduces that night's numbers exactly. Idempotent on
 * `(projectId, asOf)` — a second run inserts nothing.
 *
 * PROJECTS WITH NO SIGNAL GET NO ROW. A project with no milestones, no logs and no
 * disputes has no confidence to report, and writing 0 would render "we have no data" as
 * "this project is worthless" on a surface investors use to allocate money.
 */
const MILLISECONDS_PER_DAY = 86_400_000;

export interface ConfidenceRunOutcome {
  readonly projectsConsidered: number;
  readonly snapshotsWritten: number;
  readonly projectsWithNoSignal: number;
}

export async function handleRecomputeInvestorConfidence(
  rawPayload: unknown,
): Promise<ConfidenceRunOutcome> {
  const payload = parseJobPayload(
    JOB_NAMES.recomputeInvestorConfidence,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.recomputeInvestorConfidence],
    rawPayload,
  );

  const asOf = new Date(payload.asOf);
  const windowStartsAt = new Date(asOf.getTime() - CONFIDENCE_WINDOW_DAYS * MILLISECONDS_PER_DAY);

  const projectIds =
    payload.projectId === null ? await listProjectsForConfidence() : [payload.projectId];

  let snapshotsWritten = 0;
  let projectsWithNoSignal = 0;

  for (const projectId of projectIds) {
    const snapshot = await recomputeInvestorConfidence(projectId, asOf, windowStartsAt);
    if (snapshot === null) {
      projectsWithNoSignal += 1;
      continue;
    }
    snapshotsWritten += 1;
  }

  return {
    projectsConsidered: projectIds.length,
    snapshotsWritten,
    projectsWithNoSignal,
  };
}
