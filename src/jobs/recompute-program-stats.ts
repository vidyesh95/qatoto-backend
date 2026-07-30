import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import {
  listProgramIdsForRecompute,
  recomputeProgramStats,
} from "#src/services/research-program-stats.service.js";

/**
 * `recompute-program-stats` — the §10 hero tiles.
 *
 * MUST RUN AFTER `recompute-branch-signals` for the same day. `openGapCount` and
 * `overlapFlagCount` are read from the branch statuses that job derives, so the ordering is
 * load-bearing rather than cosmetic. It is enforced by cron time (03:20 then 03:35), the same
 * arrangement §7A's close-then-draft pair relies on — see `SCHEDULED_JOB_CRONS`.
 *
 * `asOf` comes from the PAYLOAD, never from a clock: the tick quantizes "now" to a UTC day
 * start and passes it, which is what makes a re-run land on the same snapshot row instead of
 * appending a second one a millisecond later.
 */
export async function handleRecomputeProgramStats(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.recomputeProgramStats,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.recomputeProgramStats],
    rawPayload,
  );

  const asOf = new Date(payload.asOf);

  const programIds =
    payload.programId === null ? await listProgramIdsForRecompute() : [payload.programId];

  const failures: string[] = [];

  // Per-program try/catch with an aggregate throw at the end, so one bad program cannot
  // leave every later one stale — the shape `recompute-equity-snapshot` establishes.
  for (const programId of programIds) {
    try {
      await recomputeProgramStats(programId, asOf);
    } catch (error: unknown) {
      failures.push(`${programId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `recompute-program-stats: ${String(failures.length)} program(s) failed — ${failures.join("; ")}`,
    );
  }
}
