import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import { submitTransfer } from "#src/modules/rnd/funding/escrow-provider-adapter.service.js";

/**
 * Hands a pledge's transfer to the provider adapter (R_AND_D_BACKEND_STRUCTURE.md §7, §4e).
 *
 * §7: "the provider call happens in a WORKER, never in the request handler". Against the
 * internal adapter this is a status flip and would be fast enough to inline; against
 * Stripe it is an outbound HTTPS call that can hang, and an Express worker holding a
 * socket while a card network thinks about it is how a checkout page takes down an API.
 * Building it here now means switching Appendix A3 on changes the adapter and not this
 * file, this queue, or the pledge path that enqueues it.
 *
 * IDEMPOTENT BY CONSTRUCTION, which is §4e's "a job that cannot be safely re-run is a
 * bug" applied where re-running would eventually cost real money: the transfer row already
 * carries OUR randomUUID idempotency key, written before this job existed, and
 * `submitTransfer` returns the row unchanged when it is already `submitted`.
 *
 * **SUBMITTING IS NOT SETTLING.** This job moves the transfer to `submitted` and stops.
 * Nothing about `raisedAmountInCents`, `backersCount` or any account balance moves until a
 * human holding `audit_escrow` decides the settlement — see
 * escrow-settlement.service.ts, which is the only writer of those three.
 */
export async function handleSubmitProviderTransfer(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.submitProviderTransfer,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.submitProviderTransfer],
    rawPayload,
  );

  const outcome = await submitTransfer(payload.transferId);

  if (outcome.success) {
    return;
  }

  switch (outcome.error.type) {
    case "TRANSFER_NOT_FOUND":
      // The pledge transaction rolled back after the enqueue committed, which
      // `fromDrizzle(tx)` is specifically arranged to prevent — so this means someone
      // enqueued by hand, or the row was removed out of band. Throwing sends it to the
      // dead-letter queue where an operator can see it, which is the correct destination
      // for "the queue and the database disagree".
      throw new Error(`submit-provider-transfer: transfer ${payload.transferId} does not exist`);
    case "TRANSFER_NOT_SUBMITTABLE":
      // Already settled, failed or cancelled. NOT an error and NOT a retry: the work this
      // job exists to do has been overtaken by a decision, and re-submitting a settled
      // transfer is the one thing that must never happen.
      return;
    case "TRANSFER_ALREADY_TERMINAL":
      return;
    default: {
      // Adding a variant to ProviderTransferError without handling it here breaks the
      // build, which is the point (CLAUDE.md §3.2).
      const exhaustiveCheck: never = outcome.error;
      throw new Error(`submit-provider-transfer: unhandled ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}
