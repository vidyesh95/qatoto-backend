import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import { recomputeBranchSignalsForProgram } from "#src/services/research-branch-signals.service.js";
import { listProgramIdsForRecompute } from "#src/services/research-program-stats.service.js";

/**
 * `recompute-branch-signals` — the two fields no request body may carry.
 *
 * `research_program_branch.status` and `.overlapping_group_count` are the §10 research map's
 * entire editorial claim: `missing` means "the crowd wants this answered and nobody is working
 * on it", and an overlap flag means "several groups are duplicating effort". A contributor able
 * to set either would make every node an assertion by whoever edited last. This job is the
 * only writer, and `research-branch-signals.service.ts` documents the derivation rule.
 *
 * RUNS BEFORE `recompute-program-stats` on the same day (03:20 vs 03:35), because that job
 * counts gaps and overlap flags FROM these statuses.
 *
 * `asOf` is parsed and deliberately UNUSED for the computation itself — the signals are
 * derived from current rows rather than from a window, so there is nothing to quantize
 * against. It stays in the payload because it is what makes the job's idempotency key
 * per-day, which is what dedups a double cron fire.
 */
export async function handleRecomputeBranchSignals(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.recomputeBranchSignals,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.recomputeBranchSignals],
    rawPayload,
  );

  const programIds =
    payload.programId === null ? await listProgramIdsForRecompute() : [payload.programId];

  const failures: string[] = [];

  for (const programId of programIds) {
    try {
      await recomputeBranchSignalsForProgram(programId);
    } catch (error: unknown) {
      failures.push(`${programId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `recompute-branch-signals: ${String(failures.length)} program(s) failed — ${failures.join("; ")}`,
    );
  }
}
