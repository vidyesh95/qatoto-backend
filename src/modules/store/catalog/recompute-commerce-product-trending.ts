import { config } from "#src/config/index.js";
import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import { logger } from "#src/lib/logger.js";
import { recomputeProductTrending } from "#src/modules/store/catalog/commerce-ranking.service.js";

/**
 * The hourly scoring run (STORE Phase 13).
 *
 * ENFORCEMENT IS OFF BY DEFAULT. The circuit breaker evaluates every candidate and records
 * what it WOULD have done, so the would-fire rate is countable before anything is
 * suppressed. `COMMERCE_RANKING_ENFORCEMENT_ENABLED` turns it on, and the precondition for
 * doing so is on that config field rather than left to judgement.
 *
 * Note that the flag is necessary and not sufficient: at launch the kill-switch's fourth
 * clause has no definable input, so the guard returns `not_evaluated` and nothing fires
 * however this is set.
 */
export async function handleRecomputeCommerceProductTrending(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.recomputeCommerceProductTrending,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.recomputeCommerceProductTrending],
    rawPayload,
  );
  const asOf = new Date(payload.asOf);

  const result = await recomputeProductTrending(asOf, {
    enforcementEnabled: config.COMMERCE_RANKING_ENFORCEMENT_ENABLED,
  });

  if (result.gated) {
    // A LOGGED REFUSAL, NOT AN ERROR. Before fourteen days of confirmation history exist,
    // W2 measures a period that did not happen — so the rows are written at algorithm
    // version 0, which every read path refuses.
    logger.warn(
      "recompute-commerce-product-trending: ran before the 14-day confirmation window; rows written at algorithm version 0 and refused by every read path",
      { asOf: payload.asOf, scored: result.scored },
    );
    return;
  }

  logger.info("recompute-commerce-product-trending: complete", {
    asOf: payload.asOf,
    scored: result.scored,
    ranked: result.ranked,
  });
}
