import { and, eq, lte, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { accountDeletionRequest } from "#src/db/schema.js";
import {
  idempotencyKeyFor,
  JOB_NAMES,
  JOB_PAYLOAD_SCHEMAS,
  parseJobPayload,
  PermanentJobError,
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
    /**
     * ADVANCED HERE, AT ENQUEUE, AND NOT IN THE HANDLER — which is where it used to live
     * and where it could not do its job.
     *
     * The key below is `requestId:attemptCount` and becomes pg-boss's job id. If the
     * counter only moved when the handler RAN, then any enqueue whose handler never
     * executed — worker down all night, `expireInSeconds` elapsed, payload parse threw —
     * left the counter untouched, so tomorrow's sweep minted the IDENTICAL key, pg-boss
     * deduplicated it, and `sendJob` returned `{ jobId: null }`, which this codebase
     * documents as success. The account was silently skipped until pg-boss reaped the old
     * job row a week later.
     *
     * Incrementing at enqueue makes every night's key distinct by construction, whether or
     * not anything ran.
     */
    const [bumped] = await db
      .update(accountDeletionRequest)
      .set({
        attemptCount: sql`${accountDeletionRequest.attemptCount} + 1`,
        lastAttemptAt: asOf,
      })
      .where(eq(accountDeletionRequest.id, request.id))
      .returning({ attemptCount: accountDeletionRequest.attemptCount });

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
        idempotencyKey: idempotencyKeyFor.anonymizeAccount(
          request.id,
          bumped?.attemptCount ?? request.attemptCount,
        ),
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

  // THE COUNTER IS NOT TOUCHED HERE. It is advanced by the sweep at enqueue time, so that
  // a job which never reaches this handler still rotates tomorrow's idempotency key.
  let outcome: Awaited<ReturnType<typeof anonymizeAccount>>;

  try {
    outcome = await anonymizeAccount(payload.requestId);
  } catch (error: unknown) {
    if (!(error instanceof PermanentJobError)) throw error;

    /**
     * A TRIGGER REFUSED A STEP, AND NO RETRY CAN CHANGE THAT — so this is where the retry
     * ladder stops.
     *
     * `runJob` does NOT stop it: it writes a `job_failure` row and then rethrows
     * unconditionally, so pg-boss applies this queue's full backoff (1h → 2h → 4h) to a
     * rejection that is structural. Four attempts, seven hours, and the same doomed
     * statement every time. Catching it here and returning normally means the step is
     * attempted exactly once.
     *
     * The request is marked `failed` with the reason, because the fix is a manifest change
     * — that entry becomes `retain` with a lawful basis — and a human has to make it. The
     * account stays deactivated in the meantime, which is the correct holding state.
     */
    await db
      .update(accountDeletionRequest)
      .set({ state: "failed", failureReason: error.message.slice(0, 2000) })
      .where(
        and(
          eq(accountDeletionRequest.id, payload.requestId),
          eq(accountDeletionRequest.state, "pending"),
        ),
      );

    logger.error("anonymization refused by a trigger; the manifest needs a change", {
      requestId: payload.requestId,
      reason: error.reason,
      cause: error.message,
    });
    return;
  }

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
