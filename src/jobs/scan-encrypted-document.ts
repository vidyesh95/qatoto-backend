import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import { scanEncryptedDocument } from "#src/services/commerce-document-scan.service.js";

/**
 * Scans one private commerce document and records the verdict (STORE Phase 14b).
 *
 * The document id is the only payload field; its state is re-read inside the handler, so a
 * redelivered job cannot re-open a verdict a human already gave.
 *
 * A FAILURE HERE MUST THROW so pg-boss retries. Leaving a document `pending_scan` is safe —
 * nothing can attach it — but it also blocks the buyer who uploaded it, so a transient
 * storage or scanner outage should be retried rather than swallowed.
 */
export async function handleScanEncryptedDocument(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.scanEncryptedDocument,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.scanEncryptedDocument],
    rawPayload,
  );

  const result = await scanEncryptedDocument(payload.documentId);
  if (!result.success) {
    throw new Error(
      `scan-encrypted-document: ${result.error.type}${
        "reason" in result.error ? ` (${result.error.reason})` : ""
      }`,
    );
  }
}
