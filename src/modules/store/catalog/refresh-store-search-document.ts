import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import {
  refreshOfferingSearchDocument,
  refreshOrganizationSearchEligibility,
  refreshProductSearchDocument,
} from "#src/modules/store/catalog/store-search.service.js";

/**
 * Refreshes denormalized `/store/search` documents after product, offering, or
 * organization mutations (STORE_BACKEND_STRUCTURE.md §9 / §10).
 *
 * Handlers re-read authoritative rows so a delayed job always projects current
 * eligibility rather than a forgeable payload snapshot.
 */
export async function handleRefreshStoreSearchDocument(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.refreshStoreSearchDocument,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.refreshStoreSearchDocument],
    rawPayload,
  );

  switch (payload.targetKind) {
    case "product":
      await refreshProductSearchDocument(payload.productId);
      return;
    case "provider_offering":
      await refreshOfferingSearchDocument(payload.offeringId);
      return;
    case "organization":
      await refreshOrganizationSearchEligibility(payload.organizationId);
      return;
    default: {
      const exhaustiveTarget: never = payload;
      throw new Error(`Unhandled store search refresh target: ${JSON.stringify(exhaustiveTarget)}`);
    }
  }
}
