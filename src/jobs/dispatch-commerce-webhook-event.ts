import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import { processCommercePaymentOutboxRow } from "#src/services/commerce-payments.service.js";

/**
 * Dispatches one commerce payment outbox row to the provider adapter
 * (STORE_BACKEND_STRUCTURE.md §9 / Phase 5).
 *
 * The outbox id is the only payload field. Amounts, provider refs, and state are re-read
 * from authoritative rows so a retried job cannot forge a different charge.
 */
export async function handleDispatchCommerceWebhookEvent(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.dispatchCommerceWebhookEvent,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.dispatchCommerceWebhookEvent],
    rawPayload,
  );

  const result = await processCommercePaymentOutboxRow(payload.outboxId);
  if (!result.success) {
    throw new Error(
      `dispatch-commerce-webhook-event: ${result.error.type}${
        "reason" in result.error ? ` (${result.error.reason})` : ""
      }`,
    );
  }
}
