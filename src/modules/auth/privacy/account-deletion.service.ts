import { eq } from "drizzle-orm";

import { config } from "#src/config/index.js";
import { db } from "#src/db/index.js";
import { accountDeletionRequest, session, user } from "#src/db/schema.js";
import { sendTransactionalEmail } from "#src/lib/email.js";
import { logger } from "#src/lib/logger.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import type { Result } from "#src/types/index.js";

/**
 * Closing an account (Privacy Part 3 — GDPR Art. 17).
 *
 * ## THIS DEACTIVATES. IT DOES NOT DELETE, AND IT CANNOT.
 *
 * Cascade rule R2 (`src/db/schema/rnd.ts`) puts `restrict` foreign keys on 73 of the 151
 * columns pointing at `user`, and 54 tables carry BEFORE UPDATE OR DELETE triggers.
 * `DELETE FROM "user"` physically cannot succeed for anybody who has founded, joined or
 * applied to a project, transacted, moderated or voted — which is the POINT: it is what
 * stops one person's erasure destroying another person's financial record. The real
 * erasure is an ANONYMIZATION run 30 days later by `anonymize-account.ts`.
 *
 * ## WHAT THIS FUNCTION ACTUALLY GUARANTEES
 *
 * When it returns success, three things are durably true in one transaction: a `pending`
 * request row exists with the date the scrub is due, `user.deactivated_at` is stamped,
 * and EVERY session row for that user is gone. The caller's own cookie is dead by the
 * time they read the response.
 *
 * ## THERE IS NO CANCEL FUNCTION HERE, AND THAT IS NOT AN OMISSION
 *
 * Cancelling is signing in — `databaseHooks.session.create.before` in `src/lib/auth.ts`
 * clears `deactivated_at` and moves the row to `cancelled`. So no authenticated caller is
 * ever mid-deletion, which is why this module has one write and the router has one route
 * rather than the read/cancel pair an earlier design carried.
 *
 * ## NO JOB IS ENQUEUED HERE
 *
 * The nightly `anonymize-due-accounts` sweep finds due rows by index. Enqueueing per
 * request would add a failure mode with nothing to gain — a lost enqueue would be
 * invisible, whereas a missed sweep is one night's delay on a 30-day window.
 */

/** How long a deletion stays cancellable. The frontend's copy commits to this number. */
export const ACCOUNT_DELETION_GRACE_PERIOD_DAYS = 30;

const MILLISECONDS_PER_DAY = 86_400_000;

export type RequestAccountDeletionError =
  | { type: "USER_NOT_FOUND" }
  /**
   * A staff account cannot close itself. Silently dropping a `platformRole` would erase
   * an operator's identity from every moderation action and audit entry they signed —
   * and those rows are `restrict`, so they would outlive the name that explained them.
   * Staff closure is a DBA action, deliberately, exactly like the grant was.
   */
  | { type: "STAFF_ACCOUNT" }
  /** The partial unique index refused a second live row. Almost always a double-click. */
  | { type: "REQUEST_ALREADY_ACTIVE" };

export interface AccountDeletionRequestView {
  readonly requestId: string;
  readonly requestedAt: Date;
  readonly scheduledAnonymizationAt: Date;
  readonly gracePeriodDays: number;
}

export async function requestAccountDeletion(
  userId: string,
): Promise<Result<AccountDeletionRequestView, RequestAccountDeletionError>> {
  const requestedAt = new Date();
  const scheduledAnonymizationAt = new Date(
    requestedAt.getTime() + ACCOUNT_DELETION_GRACE_PERIOD_DAYS * MILLISECONDS_PER_DAY,
  );

  let outcome: Result<AccountDeletionRequestView, RequestAccountDeletionError>;

  try {
    outcome = await db.transaction(async (tx) => {
      /**
       * Locked for the duration, so a concurrent sign-in's reactivation hook cannot read
       * `deactivated_at` as NULL, decide it has nothing to do, and hand back a session
       * for an account this transaction is about to deactivate.
       */
      const [subject] = await tx
        .select({
          email: user.email,
          name: user.name,
          platformRole: user.platformRole,
          anonymizedAt: user.anonymizedAt,
        })
        .from(user)
        .where(eq(user.id, userId))
        .for("update");

      if (!subject || subject.anonymizedAt !== null) {
        return { success: false, error: { type: "USER_NOT_FOUND" } } as const;
      }

      if (subject.platformRole !== null) {
        return { success: false, error: { type: "STAFF_ACCOUNT" } } as const;
      }

      // INSERTED FIRST, AND NOT PRECEDED BY A "DOES ONE EXIST" SELECT. The partial unique
      // index `account_deletion_request_active_uidx` is the authority; a read-then-write
      // would let two tabs both see "none" and both proceed.
      const [inserted] = await tx
        .insert(accountDeletionRequest)
        .values({ userId, requestedAt, scheduledAnonymizationAt })
        .returning({ id: accountDeletionRequest.id });

      if (!inserted) {
        // Unreachable: an INSERT that violates nothing returns its row. Named rather than
        // asserted, because `!` here would be the one place this file lies to itself.
        throw new Error(`requestAccountDeletion: insert returned no row for ${userId}`);
      }

      await tx.update(user).set({ deactivatedAt: requestedAt }).where(eq(user.id, userId));

      /**
       * SIGNED OUT EVERYWHERE, INCLUDING THE TAB THAT ASKED. Deleting the rows rather
       * than marking them expired is deliberate: `session` is our table, nothing in this
       * repo calls a Better Auth revoke API, and a row that still exists is a row some
       * future code path could honour.
       *
       * This also takes `ip_address` and `user_agent` with it — the only raw-IP column in
       * the schema — 30 days before the scrub would have.
       */
      await tx.delete(session).where(eq(session.userId, userId));

      return {
        success: true,
        value: {
          requestId: inserted.id,
          requestedAt,
          scheduledAnonymizationAt,
          gracePeriodDays: ACCOUNT_DELETION_GRACE_PERIOD_DAYS,
        },
      } as const;
    });
  } catch (error: unknown) {
    // `isUniqueViolation` and never `error.code`: drizzle 0.45 wraps driver errors in
    // DrizzleQueryError and the SQLSTATE hangs off `.cause` (see src/lib/pg-errors.ts).
    if (isUniqueViolation(error)) {
      return { success: false, error: { type: "REQUEST_ALREADY_ACTIVE" } };
    }
    throw error;
  }

  if (outcome.success) {
    /**
     * BEST EFFORT, AND AFTER THE COMMIT. The deactivation is already durable and the
     * caller is already signed out; a Brevo outage must not turn a completed closure into
     * a 500 that invites them to press it again.
     *
     * The address is read inside the transaction above and used here rather than
     * re-queried, because by now the caller has no session to re-authorize a read with.
     */
    await sendDeletionScheduledEmail(userId, outcome.value).catch((emailError: unknown) => {
      logger.error("failed to send the deletion-scheduled email", {
        userId,
        cause: emailError instanceof Error ? emailError.message : String(emailError),
      });
    });
  }

  return outcome;
}

/**
 * The one message that carries the deadline.
 *
 * IT MUST NAME THE DATE AND THE WAY BACK, because nothing else does. The app cannot: the
 * person is signed out, and the sign-in page has no authenticated source for a date. If
 * this email is lost they still hold the right to return — signing in is the whole
 * mechanism — they simply will not know how long they have.
 */
async function sendDeletionScheduledEmail(
  userId: string,
  view: AccountDeletionRequestView,
): Promise<void> {
  const [recipient] = await db
    .select({ email: user.email, name: user.name })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  if (!recipient) return;

  const deadline = view.scheduledAnonymizationAt.toISOString().slice(0, 10);
  const signInUrl = `${config.FRONTEND_URL}/sign-in`;

  await sendTransactionalEmail({
    toEmail: recipient.email,
    subject: "Your Qatoto account is scheduled for deletion",
    htmlContent:
      `<p>Hello ${escapeHtmlForEmail(recipient.name)},</p>` +
      `<p>Your Qatoto account has been deactivated and is scheduled to be permanently ` +
      `erased on <strong>${deadline}</strong>. You have been signed out on every device.</p>` +
      `<p><strong>Changed your mind?</strong> Just <a href="${signInUrl}">sign in again</a> ` +
      `before that date and your account comes back exactly as it was. There is nothing ` +
      `else to do.</p>` +
      `<p>After that date your name, email address, photo and handle are erased and cannot ` +
      `be restored. Records we are required to keep — orders, payments, and the shared ` +
      `equity records of work done with other people — stay, without your name attached.</p>` +
      `<p>If you did not ask for this, sign in now to cancel it and change your password.</p>`,
    textContent:
      `Hello ${recipient.name},\n\n` +
      `Your Qatoto account has been deactivated and is scheduled to be permanently erased ` +
      `on ${deadline}. You have been signed out on every device.\n\n` +
      `Changed your mind? Just sign in again at ${signInUrl} before that date and your ` +
      `account comes back exactly as it was. There is nothing else to do.\n\n` +
      `After that date your name, email address, photo and handle are erased and cannot be ` +
      `restored. Records we are required to keep — orders, payments, and the shared equity ` +
      `records of work done with other people — stay, without your name attached.\n\n` +
      `If you did not ask for this, sign in now to cancel it and change your password.\n`,
  });
}

/** Local copy, for the reason `src/lib/auth.ts`'s twin states. */
function escapeHtmlForEmail(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
