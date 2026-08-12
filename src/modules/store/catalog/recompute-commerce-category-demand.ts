import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import { logger } from "#src/lib/logger.js";
import { recomputeCategoryDemand } from "#src/modules/store/catalog/commerce-ranking.service.js";

/**
 * Recomputes per-category demand statistics (STORE Phase 13).
 *
 * Produces the priors, the medians and the p90 gates every scoring run reads, keyed by
 * (category, currency) because this backend has no FX quote and a cross-currency median
 * would be a fabricated conversion.
 */
export async function handleRecomputeCommerceCategoryDemand(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.recomputeCommerceCategoryDemand,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.recomputeCommerceCategoryDemand],
    rawPayload,
  );
  const asOf = new Date(payload.asOf);

  const result = await recomputeCategoryDemand(asOf);
  logger.info("recompute-commerce-category-demand: complete", {
    asOf: payload.asOf,
    rowsWritten: result.rowsWritten,
  });
}
