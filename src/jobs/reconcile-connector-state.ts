import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import { logger } from "#src/lib/logger.js";
import { reconcileConnectorOutbox } from "#src/services/commerce-connector.service.js";
import { reconcileExternalEscrowSessions } from "#src/services/commerce-escrow.service.js";

/**
 * Hourly connector reconciliation (STORE Phase 14).
 *
 * Two jobs in one pass, because both answer the same question — what did we start and never
 * hear the end of:
 *
 *   1. Outbox rows still pending past their availability, left by a worker that died
 *      mid-flight or an enqueue that failed after its row had committed.
 *   2. Escrow sessions that have been waiting on an event long enough to be suspicious.
 *      These are POLLED through the adapter, and any state the provider reports is applied
 *      through the same function a webhook would use.
 *
 * That last point is the one worth protecting. A poll and a webhook must not be two ways of
 * moving money, or the two will disagree in exactly the cases that matter — a redelivery
 * racing a reconciliation. There is one apply function; this job merely fetches the event
 * the webhook did not bring.
 */
export async function handleReconcileConnectorState(rawPayload: unknown): Promise<void> {
  parseJobPayload(
    JOB_NAMES.reconcileConnectorState,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.reconcileConnectorState],
    rawPayload,
  );

  const outbox = await reconcileConnectorOutbox();
  const sessions = await reconcileExternalEscrowSessions();

  logger.info("reconcile-connector-state complete", {
    reEnqueuedCommands: outbox.reEnqueued,
    polledSessions: sessions.polled,
    appliedEvents: sessions.applied,
  });
}
