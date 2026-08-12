import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import { finalizeClaimVerdict } from "#src/modules/rnd/proof-of-effort/effort-claims.service.js";
import {
  runAnalyzeSubstance,
  runAnalyzeTemporal,
  runGroundArtifacts,
} from "#src/modules/rnd/proof-of-effort/verification.service.js";

/**
 * The four stages of §9's verification pipeline, as pg-boss handlers
 * (R_AND_D_BACKEND_STRUCTURE.md §9.7, §4e).
 *
 * ONE FILE FOR FOUR HANDLERS, deliberately: they are one pipeline, each enqueues its
 * successor, and splitting them into four files with three identical five-line bodies
 * would hide that.
 *
 * ```text
 * submit claim (202) → ground-artifacts → analyze-substance → analyze-temporal
 *                    → finalize-verdict → a 24-hour window opens
 * ```
 *
 * EVERY HANDLER IS IDEMPOTENT AND EVERY HANDLER IS A NO-OP ON A COMPLETED RUN. pg-boss
 * redelivers on a worker restart, an operator replays by hand, and a rolling deploy runs
 * two workers at once — none of which may produce a second verdict or a second window.
 *
 * NOTHING HERE DOES DOMAIN WORK. Each body parses its payload and delegates, so the
 * pipeline's logic stays in services where it is testable without a queue.
 */

export async function handleGroundArtifacts(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.groundArtifacts,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.groundArtifacts],
    rawPayload,
  );
  await runGroundArtifacts(payload.runId);
}

export async function handleAnalyzeSubstance(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.analyzeSubstance,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.analyzeSubstance],
    rawPayload,
  );
  await runAnalyzeSubstance(payload.runId);
}

export async function handleAnalyzeTemporal(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.analyzeTemporal,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.analyzeTemporal],
    rawPayload,
  );
  await runAnalyzeTemporal(payload.runId);
}

/**
 * The terminal stage. Writes the verdict, moves `daily_log.effortVerificationStatus` off
 * `not_run` for the first time in the codebase's history, and opens the 24-hour window.
 *
 * **It writes nothing to the ledger.** No slices exist until a window locks (§9.8).
 */
export async function handleFinalizeVerdict(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.finalizeVerdict,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.finalizeVerdict],
    rawPayload,
  );
  await finalizeClaimVerdict(payload.runId);
}
