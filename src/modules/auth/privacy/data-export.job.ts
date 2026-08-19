import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import { logger } from "#src/lib/logger.js";
import {
  assembleDataExport,
  pruneExpiredDataExports,
} from "#src/modules/auth/privacy/data-export.service.js";

/**
 * Building and reaping subject-access archives (Privacy Part 3).
 *
 * Thin parse-and-delegate shims, as every other job handler in this repo is — the
 * decisions live in `data-export.service.ts`.
 */

/**
 * One archive.
 *
 * A FAILURE MUST THROW so pg-boss retries. The service has already reverted the row to
 * `pending` before rethrowing, so the retry can re-claim it; swallowing here would leave a
 * request that polls forever with nothing building it.
 */
export async function handleAssembleDataExport(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.assembleDataExport,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.assembleDataExport],
    rawPayload,
  );

  await assembleDataExport(payload.requestId);
}

/**
 * Deletes archives past their seven-day retention.
 *
 * WHY A RETENTION SWEEP AT ALL, rather than a bucket lifecycle rule. A lifecycle rule
 * would delete the object and leave the row saying `ready` with a key that 404s — so the
 * panel would offer a download that cannot work. The row and the bucket have to agree, and
 * only something that writes both can make them.
 */
export async function handlePruneExpiredDataExports(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.pruneExpiredDataExports,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.pruneExpiredDataExports],
    rawPayload,
  );

  const prunedCount = await pruneExpiredDataExports(new Date(payload.asOf));
  logger.info("expired data export sweep finished", { asOf: payload.asOf, prunedCount });
}
