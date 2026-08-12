import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import { logger } from "#src/lib/logger.js";
import { rollupProductDailySignal } from "#src/modules/store/catalog/commerce-ranking.service.js";

/**
 * Rolls yesterday's product signals into the daily series (STORE Phase 13).
 *
 * THE SERIES REFINEMENT 6 CANNOT EXIST WITHOUT. The MAD spike baseline needs per-product
 * history; without this table the dynamic trigger would fall back to its minimum floors
 * forever while still appearing to be dynamic.
 */
export async function handleRollupCommerceProductDailySignal(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.rollupCommerceProductDailySignal,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.rollupCommerceProductDailySignal],
    rawPayload,
  );
  const asOf = new Date(payload.asOf);

  const result = await rollupProductDailySignal(asOf);
  logger.info("rollup-commerce-product-daily-signal: complete", {
    asOf: payload.asOf,
    rowsWritten: result.rowsWritten,
  });
}
