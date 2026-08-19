import { and, eq, lte, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { accountDeletionRequest } from "#src/db/schema.js";
import {
  idempotencyKeyFor,
  JOB_NAMES,
  JOB_PAYLOAD_SCHEMAS,
  parseJobPayload,
  sendJob,
} from "#src/lib/jobs.js";
import { logger } from "#src/lib/logger.js";
import { anonymizeAccount } from "#src/modules/auth/privacy/anonymize-account.service.js";

/**
 * The two halves of the erasure schedule (Privacy Part 3).
 *
 * A SWEEP THAT FANS OUT, RATHER THAN ONE JOB THAT LOOPS. Each account's scrub is ~74
 * statements across as many tables, and a single job walking every due account in one
 * process would let one trigger rejection or one lock take the whole night's batch with
 * it. Per-account jobs fail per account, retry per account, and dead-letter per account.
 *
 * NOTHING IS ENQUEUED WHEN THE REQUEST IS MADE. `POST /users/me/deletion-request` writes a
 * row and stops; this sweep finds it 30 days later by the
 * `account_deletion_request_due_idx` partial index. A lost enqueue at request time would
 * be invisible for a month, whereas a missed sweep costs one night on a thirty-day window.
 */

export async function handleAnonymizeDueAccounts(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.anonymizeDueAccounts,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.anonymizeDueAccounts],
    rawPayload,
  );
  const asOf = new Date(payload.asOf);

  const due = await db
    .select({
      id: accountDeletionRequest.id,
      attemptCount: accountDeletionRequest.attemptCount,
    })
    .from(accountDeletionRequest)
    .where(
      and(
        eq(accountDeletionRequest.state, "pending"),
        lte(accountDeletionRequest.scheduledAnonymizationAt, asOf),
      ),
    );

  logger.info("anonymization sweep found due accounts", { asOf: payload.asOf, count: due.length });

  for (const request of due) {
    const enqueued = await sendJob(
      JOB_NAMES.anonymizeAccount,
      { requestId: request.id },
      {
        /**
         * SCOPED TO THE ATTEMPT, not the row alone. `dispatchCommerceWebhookEvent` records
         * the reason at `jobs.ts:1767`: the key becomes pg-boss's job id, so a key derived
         * only from the request would deduplicate a retry against the send that ALREADY
         * FAILED — and the retry would silently never run at all.
         */
        idempotencyKey: idempotencyKeyFor.anonymizeAccount(request.id, request.attemptCount),
      },
    );

    if (!enqueued.success) {
      // Logged, not thrown. One account failing to enqueue must not abandon the rest of
      // the night's batch, and tomorrow's sweep finds it again — the row is still pending.
      logger.error("failed to enqueue an account anonymization; the next sweep will retry", {
        requestId: request.id,
        enqueueError: enqueued.error.type,
      });
    }
  }
}

/**
 * One account.
 *
 * A THIN SHIM OVER THE SERVICE, as every other per-row handler in this repo is. The
 * decision-making lives in `anonymize-account.service.ts`; this parses, delegates, records
 * the attempt, and turns a domain refusal into the right kind of failure.
 */
export async function handleAnonymizeAccount(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.anonymizeAccount,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.anonymizeAccount],
    rawPayload,
  );

  /**
   * Stamped BEFORE the work, so the count is honest about attempts that crashed rather
   * than only those that returned. It is also what the next sweep's idempotency key is
   * built from, so a failed attempt gets a fresh job id rather than deduplicating away.
   */
  await db
    .update(accountDeletionRequest)
    .set({
      attemptCount: sqlIncrement(),
      lastAttemptAt: new Date(),
    })
    .where(eq(accountDeletionRequest.id, payload.requestId));

  const outcome = await anonymizeAccount(payload.requestId);

  if (outcome.success) return;

  switch (outcome.error.type) {
    case "REQUEST_NOT_PENDING":
    case "REQUEST_NOT_DUE":
      /**
       * NOT FAILURES. A redelivered job for a request that a sign-in already cancelled, or
       * that a previous attempt completed, is the system working — the guard refused
       * exactly as designed. Throwing here would dead-letter a correct outcome and page
       * somebody about a race that resolved itself.
       */
      logger.info("anonymization skipped", {
        requestId: payload.requestId,
        reason: outcome.error.type,
      });
      return;

    case "REQUEST_NOT_FOUND":
    case "STAFF_ACCOUNT_REQUIRES_MANUAL_REVIEW":
      /**
       * BOTH NEED A HUMAN, so both throw. A missing request means somebody deleted a row
       * that is supposed to be permanent; a staff role granted inside the grace window
       * means two decisions collided and only a person can say which one wins.
       *
       * Recorded on the row as well as thrown, so the state is visible in the database
       * rather than only in a worker log nobody is tailing.
       */
      await db
        .update(accountDeletionRequest)
        .set({ state: "failed", failureReason: outcome.error.type })
        .where(
          and(
            eq(accountDeletionRequest.id, payload.requestId),
            eq(accountDeletionRequest.state, "pending"),
          ),
        );

      throw new Error(`anonymize-account: ${outcome.error.type} for ${payload.requestId}`);

    default: {
      const exhaustiveCheck: never = outcome.error;
      throw new Error(`Unhandled anonymization error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/** `attempt_count + 1`, in SQL, so two workers cannot both read 3 and both write 4. */
function sqlIncrement() {
  return sql`${accountDeletionRequest.attemptCount} + 1`;
}
