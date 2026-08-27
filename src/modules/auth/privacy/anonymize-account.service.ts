import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";

import { config } from "#src/config/index.js";
import { db } from "#src/db/index.js";
import {
  accountDeletionRequest,
  anonymizationStepLog,
  handleReservation,
  user,
} from "#src/db/schema.js";
import { deleteUserAvatar } from "#src/lib/cloudinary.js";
import { PermanentJobError } from "#src/lib/jobs.js";
import { logger } from "#src/lib/logger.js";
import { readSqlStateCode } from "#src/lib/pg-errors.js";
import {
  ANONYMIZATION_MANIFEST,
  DELETE_ROW_KEYS,
  NULL_OUT_KEYS,
  parseUserReferenceKey,
  type UserReferenceKey,
} from "#src/modules/auth/privacy/anonymization-manifest.js";
import type { Result } from "#src/types/index.js";

/**
 * The erasure itself (Privacy Part 3 — GDPR Art. 17).
 *
 * ## ⚠️ THE SECOND DESTRUCTIVE SCHEDULED JOB IN THIS CODEBASE, AND THE FIRST IRREVERSIBLE ONE
 *
 * `prune-engagement-data` deletes rows a retention policy already declared expired, and
 * every counter it feeds survives. This deletes a named person's identity. There is no
 * re-derivation, no backfill and no second copy — so it is gated behind
 * `ACCOUNT_ANONYMIZATION_ENABLED`, which **defaults to false**. While false it runs the
 * full selection, logs the exact per-table counts it would touch, and writes nothing.
 *
 * ## WHY THIS ITERATES A MANIFEST INSTEAD OF NAMING TABLES
 *
 * Rule R2 classified all 157 foreign keys into `user` for a `DELETE FROM "user"` that
 * never happens — 73 are `restrict` and 54 tables carry BEFORE UPDATE OR DELETE triggers,
 * so the delete cannot succeed and account closure is an anonymization instead. The
 * consequence people miss: `ON DELETE cascade` and `ON DELETE set null` therefore FIRE
 * ZERO TIMES here. All 34 cascades and all 44 remaining set-nulls only happen because
 * this file issues the statement.
 *
 * So the step list is DERIVED from `anonymization-manifest.ts` and no table name is
 * written twice. That is what stops the manifest being right while the job is wrong, and
 * `pnpm db:verify-anonymization-coverage` is what stops the manifest going stale.
 *
 * ## WHY SEVERAL TRANSACTIONS AND NOT ONE
 *
 * One transaction across ~74 statements would hold locks on `video_view_session` and
 * `commerce_order` for the whole run, and would turn a single trigger rejection into a
 * total rollback that retries forever. Instead: one transaction per step, each idempotent,
 * each recorded in `anonymization_step_log`, whose `(request_id, step_name)` unique index
 * is what makes a retry SKIP what already landed rather than redo it.
 *
 * The cost is that a crash lands mid-way. That is why the `user` scrub is LAST — every
 * intermediate state is the same one: deactivated, request still `pending`, resumable.
 */

/**
 * `SET LOCAL` so one stuck lock cannot eat the job's `expireInSeconds` mid-transaction.
 *
 * INLINED AS A LITERAL, NOT BOUND. Postgres does not accept bind parameters in `SET` —
 * `SET LOCAL statement_timeout = $1` is a 42601 syntax error — so this goes through
 * `sql.raw`. Safe precisely because it is a constant in this file and can never be
 * anything else; if it ever becomes configurable it must be validated before it reaches
 * here, not merely passed differently.
 */
const STEP_STATEMENT_TIMEOUT_SQL = sql.raw("SET LOCAL statement_timeout = '30s'");

/**
 * Migration 0010's own append-only SQLSTATE, alongside Postgres's generic `RAISE`.
 *
 * BOTH, because the immutability triggers in this schema do not agree on which they use:
 * 0010's append-only guards raise `QT001` and the later ones raise `P0001`. Checking only
 * one would let half the trigger surface retry for hours against a rejection that can
 * never succeed.
 *
 * Deliberately NOT added as predicates to `src/lib/pg-errors.ts`: that file states, and is
 * right, that a constraint violation reaching the app is a bug to throw on rather than a
 * `Result` to branch on. Here it IS a domain outcome — it means the manifest is wrong —
 * so the check lives at the one call site that has that meaning.
 */
const TRIGGER_RAISE_SQLSTATES: readonly string[] = ["P0001", "QT001"];

export type AnonymizeAccountError =
  | { type: "REQUEST_NOT_FOUND" }
  | { type: "REQUEST_NOT_PENDING"; state: string }
  | { type: "REQUEST_NOT_DUE"; scheduledAnonymizationAt: Date }
  | { type: "STAFF_ACCOUNT_REQUIRES_MANUAL_REVIEW" };

export interface AnonymizeAccountOutcome {
  readonly requestId: string;
  readonly userId: string;
  /** False when `ACCOUNT_ANONYMIZATION_ENABLED` is off — counts only, nothing written. */
  readonly applied: boolean;
  readonly rowsByStep: Readonly<Record<string, number>>;
  readonly totalRowsAffected: number;
}

interface StepPlan {
  readonly stepName: string;
  readonly tableName: string;
  readonly countSql: ReturnType<typeof sql>;
  readonly applySql: ReturnType<typeof sql>;
}

/**
 * One manifest entry, as a pair of statements.
 *
 * IDENTIFIERS COME FROM THE MANIFEST AND NOWHERE ELSE — never a request — and go through
 * `sql.identifier()`; the user id is bound as a value. This is the idiom
 * `prune-engagement-data.ts:181-213` established and the only executing precedent for
 * table-and-column iteration in this repo.
 */
function planManifestStep(key: UserReferenceKey, userId: string): StepPlan {
  const { tableName, columnName } = parseUserReferenceKey(key);
  const disposition = ANONYMIZATION_MANIFEST[key];
  const table = sql.identifier(tableName);
  const column = sql.identifier(columnName);

  return {
    stepName: key,
    tableName,
    countSql: sql`SELECT count(*)::int AS affected_count FROM ${table} WHERE ${column} = ${userId}`,
    applySql:
      disposition.kind === "delete_rows"
        ? sql`DELETE FROM ${table} WHERE ${column} = ${userId}`
        : sql`UPDATE ${table} SET ${column} = NULL WHERE ${column} = ${userId}`,
  };
}

/**
 * Tombstones authored free text BEFORE the manifest severs its authorship.
 *
 * ORDER IS LOAD-BEARING. `video_comment.author_user_id` is a `null_out` in the manifest,
 * so once that step runs there is no way left to find this person's comments. Everything
 * that needs the author link must happen here, first.
 */
function planFreeTextSteps(userId: string): readonly StepPlan[] {
  return [
    {
      /**
       * `video_comment` ALREADY HAS THE MECHANISM and a CHECK that enforces it —
       * `video_comment_body_ck` permits a body only while `is_deleted` is false, and
       * demands the empty string once it is true. So the text genuinely leaves the table
       * rather than being hidden by a rendering convention the next reader can forget.
       */
      stepName: "tombstone:video_comment",
      tableName: "video_comment",
      countSql: sql`SELECT count(*)::int AS affected_count FROM video_comment
                    WHERE author_user_id = ${userId} AND is_deleted = false`,
      applySql: sql`UPDATE video_comment
                    SET is_deleted = true, deleted_at = now(), body_text = ''
                    WHERE author_user_id = ${userId} AND is_deleted = false`,
    },
    {
      /**
       * `community_forum_reply` HAS NO TOMBSTONE, and cannot be given one from a job.
       * `body` is NOT NULL with `char_length BETWEEN 2 AND 10000`, so it cannot be
       * emptied; and its `hidden` state is paired by CHECK with a `hidden_by_user_id`
       * that a scheduled job does not have and must not invent.
       *
       * `'[removed]'` is therefore the honest maximum here. A proper `removed` state that
       * needs no moderator is a follow-up, and until it exists this asymmetry with
       * `video_comment` above is real rather than an oversight.
       */
      stepName: "tombstone:community_forum_reply",
      tableName: "community_forum_reply",
      countSql: sql`SELECT count(*)::int AS affected_count FROM community_forum_reply
                    WHERE author_user_id = ${userId} AND body <> '[removed]'`,
      applySql: sql`UPDATE community_forum_reply SET body = '[removed]'
                    WHERE author_user_id = ${userId} AND body <> '[removed]'`,
    },
    {
      /**
       * THE ORIGINAL POST, AND THE ONE THIS FILE ORIGINALLY MISSED.
       *
       * `community_forum_thread.author_user_id` is a `null_out` in the manifest like the
       * two above, so the same "find it before the link is severed" rule applies — but it
       * was not in this list, which meant a departing person's opening posts kept their
       * `title` and `body` forever. Threads are worse than replies for this: longer, more
       * self-identifying, and the title is duplicated into a UNIQUE, publicly-routable
       * `slug`, so leaving it would keep the text in a URL as well as in a column.
       *
       * THREE COLUMNS, THREE DIFFERENT CONSTRAINTS, and each literal below is chosen to
       * satisfy one:
       *   - `title` — CHECK `char_length BETWEEN 8 AND 200`. `'[removed]'` is 9.
       *   - `body`  — CHECK `char_length BETWEEN 20 AND 20000`, so `'[removed]'` is too
       *     short and a sentence is required.
       *   - `slug`  — UNIQUE globally, CHECK `^[a-z0-9]+(-[a-z0-9]+)*$`, 3..120 chars.
       *     Derived from the row's own uuid, which is already lowercase hex and hyphens:
       *     unique by construction, valid by construction, and it carries none of the
       *     title it replaces.
       */
      stepName: "tombstone:community_forum_thread",
      tableName: "community_forum_thread",
      countSql: sql`SELECT count(*)::int AS affected_count FROM community_forum_thread
                    WHERE author_user_id = ${userId} AND title <> '[removed]'`,
      applySql: sql`UPDATE community_forum_thread
                    SET title = '[removed]',
                        body = '[This post was removed at its author''s request.]',
                        slug = 'removed-' || id
                    WHERE author_user_id = ${userId} AND title <> '[removed]'`,
    },
  ];
}

type CountRow = { readonly affected_count: number };

export async function anonymizeAccount(
  requestId: string,
): Promise<Result<AnonymizeAccountOutcome, AnonymizeAccountError>> {
  const isEnabled = config.ACCOUNT_ANONYMIZATION_ENABLED;

  // --- 1. The guard.
  const guarded = await db.transaction(async (tx) => {
    /**
     * `FOR UPDATE` HERE SETTLES ALMOST NOTHING, AND AN EARLIER VERSION OF THIS COMMENT
     * CLAIMED OTHERWISE. The lock is released when this transaction commits, a few
     * milliseconds from now — every one of the 74 steps below runs unlocked. So the
     * sign-in hook can still cancel this request mid-run.
     *
     * What actually protects the account is the `assertStillPending` check before each
     * step, plus the predicate on the final `user` UPDATE. This lock only makes the
     * ENTRY decision atomic: two concurrent deliveries of the same job cannot both read
     * `pending` and both start.
     */
    const [request] = await tx
      .select({
        id: accountDeletionRequest.id,
        userId: accountDeletionRequest.userId,
        state: accountDeletionRequest.state,
        scheduledAnonymizationAt: accountDeletionRequest.scheduledAnonymizationAt,
      })
      .from(accountDeletionRequest)
      .where(eq(accountDeletionRequest.id, requestId))
      .for("update");

    if (!request) return { success: false, error: { type: "REQUEST_NOT_FOUND" } } as const;

    if (request.state !== "pending") {
      // Redelivery after a completed run, or a sign-in that cancelled it. Neither is an
      // error worth retrying, and re-running a completed scrub must be impossible.
      return {
        success: false,
        error: { type: "REQUEST_NOT_PENDING", state: request.state },
      } as const;
    }

    if (request.scheduledAnonymizationAt > new Date()) {
      return {
        success: false,
        error: {
          type: "REQUEST_NOT_DUE",
          scheduledAnonymizationAt: request.scheduledAnonymizationAt,
        },
      } as const;
    }

    const [subject] = await tx
      .select({ platformRole: user.platformRole, handle: user.handle, email: user.email })
      .from(user)
      .where(eq(user.id, request.userId))
      .limit(1);

    if (!subject) return { success: false, error: { type: "REQUEST_NOT_FOUND" } } as const;

    if (subject.platformRole !== null) {
      /**
       * The route already refuses staff, so reaching here means a platform role was
       * GRANTED during the grace window. Scrubbing anyway would silently drop it, and
       * with it the only named actor on every moderation action and audit entry that
       * person signed — rows which are `restrict` and therefore outlive the name.
       */
      return { success: false, error: { type: "STAFF_ACCOUNT_REQUIRES_MANUAL_REVIEW" } } as const;
    }

    return {
      success: true,
      value: { userId: request.userId, handle: subject.handle, email: subject.email },
    } as const;
  });

  if (!guarded.success) return guarded;

  const { userId, handle: originalHandle, email: originalEmail } = guarded.value;

  // --- 2. The step list. Free text first, then the manifest.
  const steps: readonly StepPlan[] = [
    ...planFreeTextSteps(userId),
    ...[...DELETE_ROW_KEYS, ...NULL_OUT_KEYS].map((key) => planManifestStep(key, userId)),
  ];

  const completedSteps = await readCompletedSteps(requestId);

  /**
   * THE DRY RUN REPORTS ONCE, THEN LEAVES THE ACCOUNT ALONE.
   *
   * With the flag off nothing is written, so the request stays `pending` and keeps matching
   * `account_deletion_request_due_idx` — which meant the sweep re-enqueued it EVERY NIGHT
   * FOREVER, re-running ~76 `count(*)` scans against `video_view_session` and
   * `commerce_order` per due account, with the set only ever growing. A year of dry-run
   * operation would mean every account that ever asked to be deleted re-scanned nightly.
   *
   * The step log is the marker: a dry run records one row saying it reported, and every
   * later dry run for the same request sees it and returns immediately. Turning the flag on
   * ignores this entirely — `isEnabled` runs the real steps, which have their own log rows.
   */
  const DRY_RUN_MARKER = "dry_run_reported";
  if (!isEnabled && completedSteps.has(DRY_RUN_MARKER)) {
    logger.info("account anonymization DRY RUN already reported; skipping", { requestId, userId });
    return {
      success: true,
      value: { requestId, userId, applied: false, rowsByStep: {}, totalRowsAffected: 0 },
    };
  }

  const rowsByStep: Record<string, number> = {};

  for (const step of steps) {
    if (completedSteps.has(step.stepName)) continue;

    /**
     * ⚠️ THE CHECK THAT STOPS A CANCELLED DELETION FROM ERASING ANYWAY.
     *
     * The guard's row lock is long gone (see its comment), so between any two steps the
     * subject may have signed in and had this request moved to `cancelled`. Without this
     * read, the loop would keep deleting — and the account would end up half-erased,
     * marked `cancelled`, with the retry logging "anonymization skipped". The system
     * would report success over destroyed data.
     *
     * One indexed primary-key read per step. That is the correct price for an operation
     * with no undo, and it is the only thing standing between a mid-run sign-in and
     * irreversible loss.
     */
    const stillPending = await assertStillPending(requestId);
    if (!stillPending.success) return stillPending;

    const affected = await runStep(requestId, step, isEnabled);
    // NON-ZERO ONLY. Most of the 74 steps touch nothing for most accounts, and a summary
    // listing them all buries the handful that mattered. `anonymization_step_log` keeps
    // the complete record, zeros included — this is the line a human reads.
    if (affected > 0) rowsByStep[step.stepName] = affected;
  }

  // --- 3. Burn the handle, and only now — the manifest's `handle_reservations.user_id`
  //        delete above has just cleared this user's own reservations, so a tombstone
  //        written earlier would have been deleted by it.
  if (originalHandle !== null && !completedSteps.has("burn_handle")) {
    rowsByStep["burn_handle"] = await burnHandle(requestId, userId, originalHandle, isEnabled);
  }

  /**
   * --- 4. The archives, BEFORE the point of no return.
   *
   * THIS USED TO RUN AFTER `scrubUserAndComplete`, WHICH MADE IT SKIPPABLE. Once the
   * request reads `completed`, every retry aborts at the guard — so a worker that crashed
   * or a pod that rotated between the scrub and this call meant the purge NEVER ran, and a
   * complete PII dump (name, email, IP addresses, user agents, watch history, comment
   * bodies) sat in the bucket forever while every row in the database read as correctly
   * anonymized. Precisely the failure this step exists to prevent.
   *
   * Now it is a logged, resumable step like the other 75, positioned so that "the request
   * is still pending" and "the archives are gone" cannot disagree.
   */
  if (!completedSteps.has("purge_data_exports")) {
    const stillPending = await assertStillPending(requestId);
    if (!stillPending.success) return stillPending;

    rowsByStep["purge_data_exports"] = await purgeExportArchives(requestId, userId, isEnabled);
  }

  // --- 5. The identity itself, last.
  if (isEnabled) {
    await scrubUserAndComplete(requestId, userId);
  }

  const totalRowsAffected = Object.values(rowsByStep).reduce((sum, count) => sum + count, 0);

  // The marker that stops tomorrow's sweep re-scanning this account. Written only in dry
  // run; a real run leaves `state = 'completed'`, which the guard refuses on its own.
  if (!isEnabled) {
    await db.insert(anonymizationStepLog).values({
      requestId,
      stepName: DRY_RUN_MARKER,
      tableName: "(dry run)",
      rowsAffected: totalRowsAffected,
    });
  }

  logger.info(isEnabled ? "account anonymized" : "account anonymization DRY RUN", {
    requestId,
    userId,
    applied: isEnabled,
    totalRowsAffected,
    steps: JSON.stringify(rowsByStep),
  });

  if (isEnabled) {
    // Post-commit and best effort. A CDN or mailer outage must not unwind an erasure that
    // has already happened — a half-rolled-back scrub is strictly worse than an orphaned
    // avatar. Each is logged so an operator can finish it by hand.
    await sendCompletionEmail(originalEmail).catch((emailError: unknown) => {
      logger.error("failed to send the anonymization-complete email", {
        requestId,
        cause: describeCause(emailError),
      });
    });

    const avatarDeleted = await deleteUserAvatar(userId);
    if (!avatarDeleted.success) {
      logger.error("failed to delete the avatar of an anonymized account", {
        userId,
        cause: avatarDeleted.error.type,
      });
    }

    // THE ARCHIVE PURGE IS NOT HERE ANY MORE. It used to be, after the request was already
    // `completed` — which meant a crash at the wrong moment skipped it forever and left a
    // full PII dump in the bucket. It is now step 4 above: logged, resumable, and executed
    // while the request is still `pending`.
  }

  return {
    success: true,
    value: { requestId, userId, applied: isEnabled, rowsByStep, totalRowsAffected },
  };
}

/**
 * Deletes every subject-access archive this person ever had built, and records it.
 *
 * WHY THIS IS A STEP AND NOT A POST-COMMIT COURTESY. An archive is a complete copy of
 * everything the other 75 steps just erased. If it survives, the erasure did not happen —
 * it merely stopped being visible through the database. So it gets the same treatment as
 * every destructive step: a `pending` precondition, a step-log row, and resumability.
 *
 * The import stays lazy so a dry-run worker never constructs an S3 client it will not use.
 */
async function purgeExportArchives(
  requestId: string,
  userId: string,
  isEnabled: boolean,
): Promise<number> {
  const { purgeDataExportsForUser, countDataExportsForUser } =
    await import("#src/modules/auth/privacy/data-export.service.js");

  if (!isEnabled) return countDataExportsForUser(userId);

  const purgedArchiveCount = await purgeDataExportsForUser(userId);

  await db.insert(anonymizationStepLog).values({
    requestId,
    stepName: "purge_data_exports",
    tableName: "data_export_request",
    rowsAffected: purgedArchiveCount,
  });

  if (purgedArchiveCount > 0) {
    logger.info("purged data export archives during anonymization", {
      userId,
      purgedArchiveCount,
    });
  }

  return purgedArchiveCount;
}

/**
 * Is this request still ours to act on?
 *
 * Called before EVERY step, because the guard's `FOR UPDATE` lock does not outlive the
 * guard's own transaction and the sign-in hook can cancel a request at any moment. The
 * returned error is the same shape the guard produces, so the caller's abort path is one
 * branch rather than two.
 */
async function assertStillPending(requestId: string): Promise<Result<true, AnonymizeAccountError>> {
  const [request] = await db
    .select({ state: accountDeletionRequest.state })
    .from(accountDeletionRequest)
    .where(eq(accountDeletionRequest.id, requestId))
    .limit(1);

  if (!request) return { success: false, error: { type: "REQUEST_NOT_FOUND" } };
  if (request.state !== "pending") {
    return { success: false, error: { type: "REQUEST_NOT_PENDING", state: request.state } };
  }
  return { success: true, value: true };
}

/** Which steps a previous attempt already committed. Empty on a first run. */
async function readCompletedSteps(requestId: string): Promise<ReadonlySet<string>> {
  const rows = await db
    .select({ stepName: anonymizationStepLog.stepName })
    .from(anonymizationStepLog)
    .where(eq(anonymizationStepLog.requestId, requestId));
  return new Set(rows.map((row) => row.stepName));
}

/**
 * One step, one transaction: count, act, record.
 *
 * COUNTED BEFORE IT ACTS so the number is legible even in a dry run — and so the log says
 * what was there rather than what the driver reported afterwards. `0` is a real answer and
 * is recorded as one; most of the 74 steps touch nothing for most accounts.
 */
async function runStep(requestId: string, step: StepPlan, isEnabled: boolean): Promise<number> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(STEP_STATEMENT_TIMEOUT_SQL);

      const [counted] = (await tx.execute<CountRow>(step.countSql)).rows;
      const affectedCount = counted?.affected_count ?? 0;

      if (!isEnabled) return affectedCount;

      if (affectedCount > 0) await tx.execute(step.applySql);

      await tx.insert(anonymizationStepLog).values({
        requestId,
        stepName: step.stepName,
        tableName: step.tableName,
        rowsAffected: affectedCount,
      });

      return affectedCount;
    });
  } catch (error: unknown) {
    const sqlState = readSqlStateCode(error);

    if (sqlState !== undefined && TRIGGER_RAISE_SQLSTATES.includes(sqlState)) {
      /**
       * AN IMMUTABILITY TRIGGER REFUSED THE WRITE, AND NO RETRY CAN CHANGE THAT.
       *
       * `PermanentJobError` makes `runJob` write a `job_failure` row naming this step.
       *
       * IT DOES NOT SKIP THE RETRIES — an earlier version of this comment claimed it did.
       * `runJob` records the failure and then rethrows UNCONDITIONALLY, so pg-boss applies
       * the queue's full ladder regardless. What stops the ladder here is the handler:
       * `anonymize-account.job.ts` catches this error, marks the request `failed`, and
       * returns without throwing, so the doomed step is attempted exactly once.
       *
       * THE FIX IS ALWAYS A MANIFEST CHANGE — this entry becomes `retain` with a lawful
       * basis — and NEVER a trigger change. The triggers are what make the ledgers and
       * the hash chains worth anything.
       */
      throw new PermanentJobError(
        "ANONYMIZATION_STEP_REFUSED_BY_TRIGGER",
        `anonymize-account: ${step.stepName} raised ${sqlState}; the manifest entry must ` +
          `become "retain" with a lawful basis. Original: ${describeCause(error)}`,
      );
    }

    throw error;
  }
}

/**
 * Parks the released handle forever, rather than freeing it.
 *
 * `expires_at = 'infinity'` because `handle.service.ts` reads availability as
 * `expires_at > now()`, so an infinite reservation reads as permanently taken through the
 * existing code path — no new branch, no new column.
 *
 * WHY BURN RATHER THAN RELEASE. Every historical `@handle` mention in every comment, post
 * and thread still says that string. Handing it to the next claimant gives a stranger the
 * accumulated identity of somebody who left, which is the opposite of what erasing them
 * was for.
 */
async function burnHandle(
  requestId: string,
  userId: string,
  originalHandle: string,
  isEnabled: boolean,
): Promise<number> {
  if (!isEnabled) return 1;

  return db.transaction(async (tx) => {
    const reserved = await tx
      .insert(handleReservation)
      .values({
        reservedHandle: originalHandle,
        /**
         * STILL OWNED BY THE ANONYMIZED ROW, because `handle_reservations.user_id` is NOT
         * NULL. That is not a compromise: the row it points at is now "Deleted user" with
         * an unroutable address, so the reservation names nobody while remaining a valid
         * foreign key.
         *
         * `onConflictDoNothing` because a retry re-reaches this after the manifest's own
         * `handle_reservations.user_id` delete step has been skipped as already-done.
         */
        userId,
        expiresAt: sql`'infinity'::timestamp`,
      })
      .onConflictDoNothing()
      .returning({ reservedHandle: handleReservation.reservedHandle });

    /**
     * THE REAL COUNT, NOT A HARDCODED 1. `onConflictDoNothing` means this can legitimately
     * write nothing — and `anonymization_step_log` is the table the schema calls "THE ONLY
     * EVIDENCE", where "`rows_affected` of 0 is a real answer and is recorded as one".
     * This step was the single one lying to it.
     */
    const rowsAffected = reserved.length;

    await tx.insert(anonymizationStepLog).values({
      requestId,
      stepName: "burn_handle",
      tableName: "handle_reservations",
      rowsAffected,
    });

    return rowsAffected;
  });
}

/**
 * The identity, and the request's terminal state, in one transaction.
 *
 * LAST, ALWAYS. Every step before this is resumable because the account still reads as
 * "deactivated, request pending"; the moment `anonymized_at` is stamped that stops being
 * true. Doing it first would leave a crash halfway with an unrecognizable row and no way
 * to tell what had already been cleaned.
 */
async function scrubUserAndComplete(requestId: string, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(STEP_STATEMENT_TIMEOUT_SQL);

    /**
     * RE-ASSERTED INSIDE THIS TRANSACTION, so the request row and the `user` row are
     * decided together rather than separately. Locked, because between this read and the
     * UPDATE below the sign-in hook could otherwise slip in and cancel.
     */
    const [stillPending] = await tx
      .select({ state: accountDeletionRequest.state })
      .from(accountDeletionRequest)
      .where(eq(accountDeletionRequest.id, requestId))
      .for("update");

    if (stillPending?.state !== "pending") {
      throw new Error(
        `anonymize-account: refusing to scrub ${userId} — request ${requestId} is ` +
          `${stillPending?.state ?? "missing"}, not pending. A sign-in cancelled it mid-run.`,
      );
    }

    const scrubbed = await tx
      .update(user)
      .set({
        name: "Deleted user",
        /**
         * `email` is citext NOT NULL UNIQUE, so it needs a VALUE rather than a NULL.
         * Derived from the id, which is already opaque, so uniqueness is free; `.invalid`
         * is RFC 2606's reserved TLD, so a misconfigured mailer fails to resolve it
         * rather than delivering somebody's erasure notice to a real stranger.
         *
         * The real address is released by this, which is correct: the person may sign up
         * again, and they inherit nothing when they do.
         */
        email: sql`'anonymized+' || ${userId} || '@deleted.qatoto.invalid'`,
        emailVerified: false,
        nameSetByUser: false,
        image: null,
        imageSource: null,
        handle: null,
        handleUpdatedAt: null,
        handleChangeCount: 0,
        handleWindowStartedAt: null,
        locationLabel: null,
        anonymizedAt: new Date(),
      })
      /**
       * THE PREDICATE IS THE LAST LINE OF DEFENCE, and its absence was the defect this
       * whole function was rewritten for.
       *
       * `user_lifecycle_ck` forbids `anonymized_at` on a row whose `deactivated_at` is
       * NULL. Without these two clauses, a sign-in that cleared `deactivated_at` mid-run
       * made this UPDATE raise 23514 — which aborted THIS transaction while leaving the
       * 74 destructive steps already committed. Half-erased account, request reading
       * `cancelled`, retry logging "skipped": data destroyed and success reported.
       *
       * Matching zero rows is now the signal, not an exception, and the check below turns
       * it into a loud failure before the request is marked `completed`.
       */
      .where(and(eq(user.id, userId), isNotNull(user.deactivatedAt), isNull(user.anonymizedAt)))
      .returning({ id: user.id });

    if (scrubbed.length === 0) {
      throw new Error(
        `anonymize-account: the scrub matched no row for ${userId} — it was reactivated or ` +
          `already anonymized. Refusing to mark ${requestId} completed.`,
      );
    }

    await tx
      .update(accountDeletionRequest)
      .set({ state: "completed", completedAt: new Date() })
      .where(
        and(eq(accountDeletionRequest.id, requestId), eq(accountDeletionRequest.state, "pending")),
      );

    await tx.insert(anonymizationStepLog).values({
      requestId,
      stepName: "scrub_user",
      tableName: "user",
      rowsAffected: 1,
    });
  });
}

/**
 * The last message this address will ever receive.
 *
 * SENT FROM AN ADDRESS CAPTURED BEFORE THE SCRUB, because after it there is none — the
 * column holds an `@deleted.qatoto.invalid` placeholder that resolves nowhere.
 */
async function sendCompletionEmail(originalEmail: string): Promise<void> {
  const { sendTransactionalEmail } = await import("#src/lib/email.js");

  await sendTransactionalEmail({
    toEmail: originalEmail,
    subject: "Your Qatoto account has been deleted",
    htmlContent:
      `<p>Your Qatoto account has been permanently deleted, as you asked.</p>` +
      `<p>Your name, email address, photo and handle have been erased and cannot be ` +
      `restored. Records we are required to keep — orders, payments, and the shared ` +
      `equity records of work done with other people — remain, with no name attached.</p>` +
      `<p>This address is now free. If you sign up again it will be a new account, ` +
      `carrying nothing from this one.</p>`,
    textContent:
      `Your Qatoto account has been permanently deleted, as you asked.\n\n` +
      `Your name, email address, photo and handle have been erased and cannot be ` +
      `restored. Records we are required to keep — orders, payments, and the shared ` +
      `equity records of work done with other people — remain, with no name attached.\n\n` +
      `This address is now free. If you sign up again it will be a new account, carrying ` +
      `nothing from this one.\n`,
  });
}

function describeCause(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}
