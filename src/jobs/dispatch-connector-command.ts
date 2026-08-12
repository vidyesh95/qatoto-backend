import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import { processConnectorOutboxRow } from "#src/modules/store/orders/commerce-escrow.service.js";

/**
 * Dispatches one connector outbox row to its provider adapter (STORE Phase 14).
 *
 * The outbox id is the only payload field. The provider, the amounts and the current state
 * are re-read from authoritative rows inside the handler, so a job that sat in the queue
 * while an order changed cannot act on the copy it was enqueued with.
 *
 * A COMMAND IS NOT A SETTLEMENT. Success here means the provider accepted an instruction.
 * Nothing in this path posts to the ledger — only a normalized provider event does that.
 */
export async function handleDispatchConnectorCommand(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.dispatchConnectorCommand,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.dispatchConnectorCommand],
    rawPayload,
  );

  const result = await processConnectorOutboxRow(payload.outboxId);
  if (!result.success) {
    throw new Error(
      `dispatch-connector-command: ${result.error.type}${
        "reason" in result.error ? ` (${result.error.reason})` : ""
      }`,
    );
  }
}
