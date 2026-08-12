import {
  idempotencyKeyFor,
  JOB_NAMES,
  JOB_PAYLOAD_SCHEMAS,
  parseJobPayload,
  sendJob,
} from "#src/lib/jobs.js";
import { sweepExpiredWindows } from "#src/modules/rnd/funding/slice-allocation.service.js";

/**
 * The expiry sweep (R_AND_D_BACKEND_STRUCTURE.md §9.8, §4e).
 *
 * THIS IS THE DEFAULT PATH FOR EVERY CLAIM — most windows close with no dispute at all —
 * so it must be boring and reliable rather than clever. Runs every 60 seconds.
 *
 * THREE PROPERTIES, all of which are easy to get wrong and all of which are deliberate:
 *
 *  1. **Downtime loses nothing.** The sweep queries PERSISTED STATE, not a timer. A worker
 *     down six hours locks six hours of backlog on restart, all at correct amounts,
 *     because the amount was frozen on the proposal at verdict time.
 *  2. **24 hours is a minimum, never a maximum.** A late sweep leaves a window open
 *     longer, which is always the safe direction. It NEVER pre-locks.
 *  3. **Re-running it is a no-op.** Every settlement re-asserts `status = 'open'` inside
 *     its own transaction under `FOR UPDATE SKIP LOCKED`, and
 *     `slice_ledger_entry_proposalId_kind_unq` rejects a duplicate entry even if two
 *     sweeps somehow raced past that. §17 step 6 tests exactly this.
 *
 * `asOf` comes from the payload, not from a clock read here (§4c rule 3), so an operator
 * can replay any historical sweep and get the historical result.
 */
export async function handleSweepDisputeWindows(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.sweepDisputeWindows,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.sweepDisputeWindows],
    rawPayload,
  );

  const asOf = new Date(payload.asOf);
  const outcome = await sweepExpiredWindows(asOf);

  if (outcome.settled.length === 0) {
    return;
  }

  // The cap table moves the moment slices land, not at the next nightly tick — otherwise
  // a member who watched their window lock would see an unchanged equity bar for hours
  // and reasonably conclude the ledger had lost their work.
  const touchedProjectIds = [
    ...new Set(outcome.settled.map((settlement) => settlement.projectId)),
  ].toSorted();

  for (const projectId of touchedProjectIds) {
    const enqueued = await sendJob(
      JOB_NAMES.recomputeEquitySnapshot,
      { asOf: asOf.toISOString(), projectId },
      { idempotencyKey: idempotencyKeyFor.recomputeEquitySnapshot(asOf.toISOString(), projectId) },
    );

    if (!enqueued.success) {
      // Deliberately not fatal: the slices ARE in the ledger, which is the part that must
      // not be lost. A missed recompute is corrected by the nightly tick, so failing the
      // whole sweep here would re-run settlements that already succeeded for no gain.
      console.error(
        `sweep-dispute-windows: could not enqueue a snapshot recompute for project ${projectId} (${enqueued.error.type})`,
      );
    }
  }
}
