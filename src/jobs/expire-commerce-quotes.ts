import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import { expireCommerceQuotesAndRfqs } from "#src/services/commerce-messages.service.js";

/**
 * Expires submitted quotes past their latest revision validity deadline and open RFQs
 * past responseDeadlineAt (STORE_BACKEND_STRUCTURE.md §10).
 *
 * `asOf` comes from the payload, not a clock read here (§4c rule 3). Handlers re-check
 * current state with guarded UPDATEs so retries and late ticks are harmless.
 */
export async function handleExpireCommerceQuotes(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.expireCommerceQuotes,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.expireCommerceQuotes],
    rawPayload,
  );

  const asOf = new Date(payload.asOf);
  await expireCommerceQuotesAndRfqs(asOf);
}
