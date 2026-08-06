import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import { reconcileCommercePayments } from "#src/services/commerce-payments.service.js";

/**
 * Reconciles commerce payment outbox rows and submitted transfers
 * (STORE_BACKEND_STRUCTURE.md §10 Phase 5).
 *
 * `asOf` comes from the payload, not a clock read here (§4c rule 3).
 */
export async function handleReconcileCommercePayments(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.reconcileCommercePayments,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.reconcileCommercePayments],
    rawPayload,
  );

  await reconcileCommercePayments(new Date(payload.asOf));
}
