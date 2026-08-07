import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import { logger } from "#src/lib/logger.js";
import { recomputeProductTrending } from "#src/services/commerce-ranking.service.js";

/**
 * The hourly scoring run (STORE Phase 13).
 *
 * ENFORCEMENT IS OFF HERE, deliberately and by default. The circuit breaker evaluates every
 * candidate and records what it WOULD have done, so the would-fire rate is countable before
 * anything is suppressed. Turning this on is a stage-5 decision that should be justified by
 * that observed rate rather than by confidence in the design.
 */
export async function handleRecomputeCommerceProductTrending(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.recomputeCommerceProductTrending,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.recomputeCommerceProductTrending],
    rawPayload,
  );
  const asOf = new Date(payload.asOf);

  const result = await recomputeProductTrending(asOf, { enforcementEnabled: false });

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
