import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import { logger } from "#src/lib/logger.js";
import {
  countPendingDocumentScans,
  sweepPendingDocumentScans,
} from "#src/modules/store/organizations/commerce-document-scan.service.js";

/**
 * Re-enqueues document scans whose original enqueue was lost (STORE Phase 14b).
 *
 * The per-document job is enqueued at upload, after the row commits. That enqueue is
 * deliberately allowed to fail without failing the upload — so something has to notice, and
 * this is it. It reports the total still pending as well as what it re-enqueued, because a
 * pending count that climbs run over run means the scanner itself is failing, which the
 * re-enqueue count alone would not show.
 */
export async function handleSweepPendingDocumentScans(rawPayload: unknown): Promise<void> {
  parseJobPayload(
    JOB_NAMES.sweepPendingDocumentScans,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.sweepPendingDocumentScans],
    rawPayload,
  );

  const swept = await sweepPendingDocumentScans();
  const stillPending = await countPendingDocumentScans();

  logger.info("sweep-pending-document-scans complete", {
    reEnqueued: swept.reEnqueued,
    stillPending,
  });
}
