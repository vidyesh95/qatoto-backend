import { parseJobPayload, JOB_NAMES, JOB_PAYLOAD_SCHEMAS } from "#src/lib/jobs.js";
import { releaseExpiredInventoryReservations } from "#src/modules/store/orders/commerce-checkout.service.js";

/**
 * Releases expired checkout preparations and inventory holds (STORE Phase 4).
 *
 * The tick supplies an explicit `asOf`; this handler never reads the clock.
 */
export async function handleReleaseExpiredInventoryReservations(
  rawPayload: unknown,
): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.releaseExpiredInventoryReservations,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.releaseExpiredInventoryReservations],
    rawPayload,
  );
  await releaseExpiredInventoryReservations(new Date(payload.asOf));
}
