import { eq } from "drizzle-orm";

import { config, isNotificationEmailEnabled } from "#src/config/index.js";
import { db } from "#src/db/index.js";
import { notification, researchProject, user } from "#src/db/schema.js";
import { sendTransactionalEmail } from "#src/lib/email.js";
import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";

/**
 * Notification delivery (R_AND_D_BACKEND_STRUCTURE.md §11l.2 item 1, §4e).
 *
 * WHY DELIVERY IS A JOB AT ALL. The notification itself is written synchronously, in the
 * same transaction as the fact it announces — that part must not be deferred, or the row
 * can announce a state that was rolled back. Email is the opposite: it is an HTTP call to a
 * third party, and putting one inside the transaction that finalizes a compensation
 * statement means a Brevo outage can fail a finalize. So the row lands, the job carries the
 * rest, and a member who never receives the email still has the notification.
 *
 * THE IN-APP ROW IS THE NOTIFICATION. Email is a copy. That ordering is why this handler
 * never writes anything except `email_status` and `email_sent_at`: it cannot invent,
 * suppress or edit what a person was told.
 *
 * FAILURE POLICY, matching §9.7 and `analyze-daily-log`:
 *   unconfigured → `skipped_unconfigured`, and RETURN. Not an error: a deployment with no
 *                  BREVO_API_KEY is a deployment that does not send email, and dead-lettering
 *                  every notification would bury a real failure under thousands of expected
 *                  ones.
 *   provider 5xx / network → `failed`, then RETHROW so pg-boss backs off and retries.
 *   provider 4xx           → `failed`, and return. A rejected recipient is not retryable,
 *                            and there is nothing a human can do at 3am that the row does
 *                            not already record.
 */

/**
 * The subject line, per kind.
 *
 * THE ONE PLACE PROSE IS ALLOWED, and it is worth saying why the rule bends here. §1 and
 * §4d ban server-rendered strings because three first-class clients must localize
 * themselves — but an email has no client. Something has to compose the sentence, and the
 * alternative is a notification the server can store and never send.
 *
 * Deliberately terse and free of numbers: an amount in a subject line is an amount in a
 * mail server's logs and on a lock screen. The email says something happened and points at
 * the app; the app says what.
 */
const SUBJECT_BY_KIND: Readonly<Record<(typeof notification.$inferSelect)["kind"], string>> = {
  project_invite_received: "You have been invited to a project on Qatoto",
  project_invite_revoked: "A project invitation was withdrawn",
  project_invite_accepted: "Your invitation was accepted",
  project_invite_declined: "Your invitation was declined",
  project_application_received: "Someone applied to your project",
  project_application_accepted: "Your application was accepted",
  project_application_declined: "Your application was declined",
  compensation_agreement_proposed: "A compensation agreement is waiting for you",
  compensation_agreement_accepted: "A compensation agreement was accepted",
  compensation_agreement_declined: "A compensation agreement was declined",
  compensation_agreement_withdrawn: "A compensation agreement was withdrawn",
  compensation_period_finalized: "Your statement for this period is ready",
  compensation_period_countersigned: "A statement was countersigned",
  compensation_period_superseded: "A statement was superseded by a correction",
  compensation_payment_recorded: "A payment was recorded against your statement",
  compensation_payment_confirmed: "A payment you recorded was confirmed",
  dispute_raised: "A dispute was raised on an allocation",
  dispute_resolved: "A dispute was resolved",
  effort_claim_verdict_reached: "Your effort claim has a verdict",
  // §10. "Reviewed" rather than "approved" on the paper line, because one kind carries
  // all three verdicts and a subject that guesses which is a subject that is sometimes
  // wrong on a lock screen.
  research_program_published: "Your research program is now public",
  research_program_rejected: "Your research program was not published",
  research_program_paper_moderated: "Your research paper was reviewed",
  // §4a. Neither names the role: a subject line is the one part of this that lands on a
  // lock screen and in a mail server's logs, and which staff powers an account holds is
  // not a fact to put there. The app says what changed.
  platform_role_change_proposed: "A staff role change is waiting for your countersignature",
  platform_role_changed: "Your staff access on Qatoto changed",
};

export async function handleDeliverNotification(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.deliverNotification,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.deliverNotification],
    rawPayload,
  );

  const [row] = await db
    .select({
      id: notification.id,
      kind: notification.kind,
      emailStatus: notification.emailStatus,
      recipientEmail: user.email,
      recipientName: user.name,
      projectName: researchProject.name,
      projectSlug: researchProject.slug,
    })
    .from(notification)
    .innerJoin(user, eq(user.id, notification.recipientUserId))
    .leftJoin(researchProject, eq(researchProject.id, notification.projectId))
    .where(eq(notification.id, payload.notificationId));

  if (!row) {
    // The recipient's account was deleted between enqueue and dequeue, and the row went
    // with it (`cascade`). Nothing to deliver and nothing to alarm about.
    return;
  }

  // Already terminal. A retry after a successful send must not send twice — the row is the
  // dedup record, and `queued` is the only state this handler acts on.
  if (row.emailStatus !== "queued") return;

  // NOT CONFIGURED, or configured and deliberately switched off for this environment.
  //
  // The second half is what stops a smoke run from emailing: fixture users carry addresses
  // like `<uuid>@x.test`, every fixture claim and dispute fans out a notification, and a
  // worker running against the same database with a real key will happily post all of them
  // to a live provider. Bounces to fabricated domains cost sending reputation, and no
  // amount of deleting rows afterwards gets it back. `skipped_unconfigured` covers both
  // cases honestly: this deployment is not set up to send.
  if (!isNotificationEmailEnabled || !config.BREVO_API_KEY || !config.BREVO_SENDER_EMAIL) {
    await db
      .update(notification)
      .set({ emailStatus: "skipped_unconfigured" })
      .where(eq(notification.id, row.id));
    return;
  }

  const subject = SUBJECT_BY_KIND[row.kind];
  const projectSuffix = row.projectName === null ? "" : ` — ${row.projectName}`;
  const deepLink =
    row.projectSlug === null
      ? `${config.FRONTEND_URL}/research-and-development`
      : `${config.FRONTEND_URL}/research-and-development/project/${row.projectSlug}`;

  const sent = await sendTransactionalEmail({
    toEmail: row.recipientEmail,
    subject: `${subject}${projectSuffix}`,
    // No amounts, no member names, no verdicts. The email is a doorbell; the app is the
    // door. That keeps personal data — and pay data especially (§7A.6, §11h) — out of mail
    // servers Qatoto does not control.
    htmlContent:
      `<p>Hello ${escapeHtml(row.recipientName)},</p>` +
      `<p>${escapeHtml(subject)}${escapeHtml(projectSuffix)}.</p>` +
      `<p><a href="${deepLink}">Open Qatoto</a> to see it.</p>`,
    textContent: `Hello ${row.recipientName},\n\n${subject}${projectSuffix}.\n\nOpen ${deepLink} to see it.\n`,
  });

  if (sent.success) {
    await db
      .update(notification)
      .set({ emailStatus: "sent", emailSentAt: new Date() })
      .where(eq(notification.id, row.id));
    return;
  }

  await db.update(notification).set({ emailStatus: "failed" }).where(eq(notification.id, row.id));

  switch (sent.error.type) {
    case "NETWORK_ERROR":
      // Retryable. Rethrow so pg-boss backs off; the status flips back to `sent` if a later
      // attempt succeeds, because the update above runs before every send.
      throw new Error(`deliver-notification: network error sending ${row.id}`);
    case "PROVIDER_REJECTED":
      // 5xx is the provider's problem and worth retrying; 4xx is a rejected recipient and
      // is not. Both leave `failed` behind, which is what an operator queries.
      if (sent.error.status >= 500) {
        throw new Error(
          `deliver-notification: provider ${String(sent.error.status)} sending ${row.id}`,
        );
      }
      return;
    case "NOT_CONFIGURED":
      // Unreachable — the config gate above ran first — but the exhaustive switch is what
      // makes a fourth error variant a compile error rather than a silent fall-through.
      await db
        .update(notification)
        .set({ emailStatus: "skipped_unconfigured" })
        .where(eq(notification.id, row.id));
      return;
    default: {
      const exhaustiveCheck: never = sent.error;
      throw new Error(`deliver-notification: unhandled ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/** The four characters that turn a name into markup. Names are the only interpolation here. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
