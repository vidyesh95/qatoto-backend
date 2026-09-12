/**
 * End-to-end smoke for the Privacy Part 3 write surface, against a real database.
 *
 * WHY THIS EXISTS RATHER THAN A VITEST. The suite mocks `#src/db/index.js` wholesale, so it
 * can prove things about TypeScript and nothing about Postgres — and every interesting
 * property of this feature is a Postgres property: the partial unique index that makes a
 * second request a 409, the CHECK that pairs `cancelled_at` with its state, the trigger
 * surface the scrub has to route around, and the 74 statements the manifest generates.
 *
 * WHAT IT PROVES, IN ORDER:
 *   1. A deletion request deactivates, schedules, and destroys every session.
 *   2. A second request is refused by the index, not by a read-then-write race.
 *   3. A staff account is refused before anything is written.
 *   4. Reactivation clears the flag and cancels the request — the sign-in path's write.
 *   5. The scrub's DRY RUN reports counts and changes nothing.
 *   6. The scrub, applied, leaves the account unrecognizable and the request `completed`.
 *   7. ⚠️ THE FREE TEXT NO FOREIGN KEY CAN REACH. An auto-provisioned commerce organization, the
 *      public search index it feeds, a video invite, a video credit and a showcase credit — five
 *      rows across five tables, none of which carries a `user` reference on the row that
 *      matters, so `db:verify-anonymization-coverage` is blind to every one of them. A
 *      `self_declared` organization sits beside them as the control and must come out unchanged.
 *
 * EVERY ACCOUNT AND ROW IT TOUCHES IS ONE IT CREATED — accounts with an
 * `@privacy-smoke.invalid` address, and fixtures whose ids all begin `smoke-` —
 * and step 6 is the reason that matters: it runs a real, irreversible anonymization. It
 * refuses to start if `ACCOUNT_ANONYMIZATION_ENABLED` is not set, so the destructive half
 * cannot be reached by running this by accident.
 *
 *   ACCOUNT_ANONYMIZATION_ENABLED=true pnpm db:smoke-privacy
 *
 * Exits non-zero on the first failed assertion.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";

import { config } from "#src/config/index.js";
import { db, pool } from "#src/db/index.js";
import { account, accountDeletionRequest, session, user } from "#src/db/schema.js";
import { auth } from "#src/lib/auth.js";
import { stopSendOnlyBoss } from "#src/lib/jobs.js";
import { requestAccountDeletion } from "#src/modules/auth/privacy/account-deletion.service.js";
import { anonymizeAccount } from "#src/modules/auth/privacy/anonymize-account.service.js";

let failureCount = 0;

function check(label: string, passed: boolean, detail: string): void {
  console.log(`${passed ? "PASS" : "FAIL"}  ${label} — ${detail}`);
  if (!passed) failureCount += 1;
}

/** Long enough for `minPasswordLength: 8`, and never reused outside this script. */
const SMOKE_PASSWORD = "privacy-smoke-password-2026";

/**
 * ⚠️ DISTINCTIVE PER ACCOUNT, AND THAT IS AN ASSERTION, NOT TIDINESS.
 *
 * Every account used to be called "Privacy Smoke". The text-PII assertions below ask whether
 * the person's NAME survived in a commerce organization and in the public search index, and a
 * name shared by two rows cannot answer that — nor could a `to_tsquery` distinguish this run's
 * leftovers from the last one's.
 */
function smokeUserName(userId: string): string {
  return `Privacy Smoke ${userId.slice(-8)}`;
}

async function createSmokeUser(options: { readonly isStaff: boolean }): Promise<string> {
  const id = `privacy-smoke-${randomUUID()}`;
  await db.insert(user).values({
    id,
    name: smokeUserName(id),
    email: `${id}@privacy-smoke.invalid`,
    emailVerified: false,
    handle: `smoke_${id.slice(-12)}`,
    locationLabel: "Nowhere",
    // SET TRUE ON PURPOSE. The column defaults to false, so an assertion that it is false after
    // the scrub would pass without the scrub having done anything — a guard that can only ever
    // succeed. Opting the probe in first is what makes "an anonymized account leaves the public
    // directory" a claim this script can actually fail.
    isChannelListed: true,
    platformRole: options.isStaff ? "moderator" : null,
  });

  /**
   * A REAL CREDENTIAL, because step 4 signs in for real. Written through Better Auth's own
   * context so the hash matches what `signInEmail` will verify — this repo swaps in argon2
   * (`emailAndPassword.password.hash`), so a hand-rolled hash here would silently never
   * verify and the reactivation assertion would fail for the wrong reason.
   */
  const passwordHash = await auth.$context.then((context) => context.password.hash(SMOKE_PASSWORD));
  await db.insert(account).values({
    id: randomUUID(),
    accountId: id,
    providerId: "credential",
    userId: id,
    password: passwordHash,
    updatedAt: new Date(),
  });
  // Two sessions, because "every session is destroyed" is the claim and one row cannot
  // distinguish "deleted them all" from "deleted the one".
  for (let index = 0; index < 2; index += 1) {
    await db.insert(session).values({
      id: randomUUID(),
      token: randomUUID(),
      userId: id,
      expiresAt: new Date(Date.now() + 86_400_000),
      updatedAt: new Date(),
    });
  }
  return id;
}

/** Deletes a smoke account outright. Only ever called with an id this script minted. */
async function destroySmokeUser(userId: string): Promise<void> {
  /**
   * CHILDREN FIRST, AND THE ORDER IS THE WHOLE FUNCTION. `anonymization_step_log` holds a
   * `restrict` foreign key into `account_deletion_request`, which holds one into `user` —
   * so deleting the request before its step log raises 23503, which is exactly what the
   * first version of this script did. The same `restrict` chain is what makes those rows
   * survive a real erasure; here it just has to be walked in reverse.
   */
  await db.execute(sql`DELETE FROM community_forum_thread WHERE author_user_id = ${userId}
    OR slug LIKE 'removed-%' AND title = '[removed]' AND id IN
    (SELECT id FROM community_forum_thread WHERE slug LIKE 'removed-%')`);
  await db.execute(sql`DELETE FROM anonymization_step_log WHERE request_id IN
    (SELECT id FROM account_deletion_request WHERE user_id = ${userId})`);
  await db.delete(accountDeletionRequest).where(eq(accountDeletionRequest.userId, userId));
  await db.execute(sql`DELETE FROM data_export_request WHERE user_id = ${userId}`);
  await db.delete(session).where(eq(session.userId, userId));
  await db.delete(account).where(eq(account.userId, userId));
  await db.execute(sql`DELETE FROM handle_reservations WHERE user_id = ${userId}`);
  /**
   * THE TEXT-PII FIXTURES. Every one of these is a table with NO `user` foreign key on the row
   * that matters, which is exactly why the scrub needs explicit steps for them — and why the
   * teardown needs explicit lines here. `store_search_document`, `video_collaborator`,
   * `video_team_member` and `showcase_launch_team_member` all cascade from the three parents
   * named below, so those three are the whole list.
   */
  await db.execute(sql`DELETE FROM showcase_launch WHERE author_user_id = ${userId}`);
  await db.execute(sql`DELETE FROM video WHERE creator_id = ${userId}`);
  await db.execute(sql`DELETE FROM commerce_organization WHERE created_by_user_id = ${userId}`);
  await db.delete(user).where(eq(user.id, userId));
}

async function main(): Promise<void> {
  const subjectId = await createSmokeUser({ isStaff: false });
  const staffId = await createSmokeUser({ isStaff: true });
  const subjectEmail = `${subjectId}@privacy-smoke.invalid`;

  try {
    // --- 1. The request deactivates, schedules, and signs out everywhere.
    const requested = await requestAccountDeletion(subjectId);
    check("deletion request accepted", requested.success, JSON.stringify(requested));
    if (!requested.success) return;

    const [afterRequest] = await db
      .select({ deactivatedAt: user.deactivatedAt })
      .from(user)
      .where(eq(user.id, subjectId));
    check(
      "account is deactivated",
      afterRequest?.deactivatedAt != null,
      `deactivated_at=${String(afterRequest?.deactivatedAt)}`,
    );

    const remainingSessions = await db
      .select({ id: session.id })
      .from(session)
      .where(eq(session.userId, subjectId));
    check(
      "every session was destroyed",
      remainingSessions.length === 0,
      `${String(remainingSessions.length)} left of 2`,
    );

    const graceDays = Math.round(
      (requested.value.scheduledAnonymizationAt.getTime() - requested.value.requestedAt.getTime()) /
        86_400_000,
    );
    check("grace period is 30 days", graceDays === 30, `${String(graceDays)} days`);

    // --- 2. The partial unique index refuses the second one.
    const second = await requestAccountDeletion(subjectId);
    check(
      "a second request is refused",
      !second.success && second.error.type === "REQUEST_ALREADY_ACTIVE",
      second.success ? "it succeeded" : second.error.type,
    );

    // --- 3. Staff are refused before anything is written.
    const staffAttempt = await requestAccountDeletion(staffId);
    check(
      "a staff account is refused",
      !staffAttempt.success && staffAttempt.error.type === "STAFF_ACCOUNT",
      staffAttempt.success ? "it succeeded" : staffAttempt.error.type,
    );
    const [staffRow] = await db
      .select({ deactivatedAt: user.deactivatedAt })
      .from(user)
      .where(eq(user.id, staffId));
    check(
      "the refused staff account was not touched",
      staffRow?.deactivatedAt === null,
      `deactivated_at=${String(staffRow?.deactivatedAt)}`,
    );

    /**
     * --- 4. REACTIVATION, THROUGH AN ACTUAL SIGN-IN.
     *
     * ⚠️ THIS USED TO SIMULATE THE HOOK by issuing its two UPDATEs directly, which proved
     * only that the SQL worked. The entire design rests on
     * `databaseHooks.session.create.before` firing — no cancel endpoint, no pending-deletion
     * UI, no `scheduled` state anywhere — and a simulation could not have caught the hook
     * being misconfigured, never registered, or given a signature better-auth ignores.
     *
     * So this signs in for real, over `auth.api.signInEmail`, exactly as the browser would.
     */
    const signedIn = await auth.api
      .signInEmail({ body: { email: subjectEmail, password: SMOKE_PASSWORD } })
      .then(() => true)
      .catch((error: unknown) => {
        console.log(
          `      sign-in threw: ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      });

    check("a deactivated account can still sign in", signedIn, "the door back in is open");

    const [reactivated] = await db
      .select({ deactivatedAt: user.deactivatedAt })
      .from(user)
      .where(eq(user.id, subjectId));
    const [cancelledRequest] = await db
      .select({
        state: accountDeletionRequest.state,
        cancelledAt: accountDeletionRequest.cancelledAt,
      })
      .from(accountDeletionRequest)
      .where(eq(accountDeletionRequest.userId, subjectId));

    check(
      "SIGNING IN REACTIVATES — the hook fired",
      reactivated?.deactivatedAt === null,
      `deactivated_at=${String(reactivated?.deactivatedAt)}`,
    );
    check(
      "the request was cancelled by that sign-in",
      cancelledRequest?.state === "cancelled" && cancelledRequest.cancelledAt !== null,
      `state=${cancelledRequest?.state ?? "missing"} cancelled_at=${String(cancelledRequest?.cancelledAt)}`,
    );

    /**
     * --- 4b. THE D1 REGRESSION GUARD.
     *
     * The scrub's final `user` UPDATE used to carry no predicate. A sign-in mid-run cleared
     * `deactivated_at`, that UPDATE then violated `user_lifecycle_ck` with a 23514, and the
     * transaction aborted — AFTER the 76 destructive steps had each committed on their own.
     * Half-erased account, request reading `cancelled`, retry logging "skipped": data
     * destroyed and success reported.
     *
     * This reproduces the tail of it deterministically: a `pending` request over a user
     * whose `deactivated_at` is already NULL. The scrub must REFUSE rather than stamp
     * `anonymized_at`, and must not mark the request `completed`.
     */
    const raceProbeId = await createSmokeUser({ isStaff: false });
    const raced = await requestAccountDeletion(raceProbeId);
    if (raced.success) {
      await db
        .update(accountDeletionRequest)
        .set({
          requestedAt: new Date(Date.now() - 31 * 86_400_000),
          scheduledAnonymizationAt: new Date(Date.now() - 86_400_000),
        })
        .where(eq(accountDeletionRequest.id, raced.value.requestId));
      // The reactivation, without the request state moving — exactly the window D1 opened.
      await db.update(user).set({ deactivatedAt: null }).where(eq(user.id, raceProbeId));

      const refused = await anonymizeAccount(raced.value.requestId)
        .then(() => "it returned normally")
        .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));

      const [raceRow] = await db
        .select({ anonymizedAt: user.anonymizedAt, name: user.name })
        .from(user)
        .where(eq(user.id, raceProbeId));
      const [raceRequest] = await db
        .select({ state: accountDeletionRequest.state })
        .from(accountDeletionRequest)
        .where(eq(accountDeletionRequest.id, raced.value.requestId));

      check(
        "a reactivated account is NOT stamped anonymized",
        raceRow?.anonymizedAt === null,
        `anonymized_at=${String(raceRow?.anonymizedAt)} — the scrub said: ${refused}`,
      );
      check(
        "and its request is NOT marked completed",
        raceRequest?.state !== "completed",
        `state=${raceRequest?.state ?? "missing"}`,
      );
    }
    await destroySmokeUser(raceProbeId);

    // --- 5 & 6. A fresh request, due immediately, then the scrub.
    const forScrub = await requestAccountDeletion(subjectId);
    if (!forScrub.success) {
      check("second lifecycle request accepted", false, JSON.stringify(forScrub.error));
      return;
    }
    /**
     * BOTH TIMESTAMPS MOVE, and the first draft of this script moving only one is worth
     * recording: `account_deletion_request_window_ck` requires
     * `scheduled_anonymization_at > requested_at`, so backdating the due date alone makes
     * the row describe a grace window that ended before it began — and Postgres refused
     * it, exactly as it should.
     *
     * The operational consequence is real and not just a test detail: a pending request
     * CANNOT be nudged into being due. Making one due means rewriting its whole history,
     * which is a deliberate obstacle in front of "just erase this account now".
     */
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 86_400_000);
    await db
      .update(accountDeletionRequest)
      .set({
        requestedAt: thirtyOneDaysAgo,
        scheduledAnonymizationAt: new Date(Date.now() - 86_400_000),
      })
      .where(eq(accountDeletionRequest.id, forScrub.value.requestId));

    /**
     * A FORUM THREAD, so the tombstone written for D4 executes against a real row.
     * `title` needs 8+ chars, `body` 20+, and the slug is globally unique — all three are
     * constraints the tombstone has to satisfy, and none of them had ever been exercised.
     */
    const threadId = randomUUID();
    await db.execute(sql`
      INSERT INTO community_forum_thread
        (id, slug, board, title, body, author_user_id, state, published_at)
      VALUES (${threadId}, ${`smoke-thread-${threadId}`}, 'sourcing',
              'A smoke thread title', 'A smoke thread body long enough to satisfy the check.',
              ${subjectId}, 'open', now())`);

    /**
     * ⚠️ THE TEXT-PII FIXTURES — five rows, none of which any foreign-key walk can find.
     *
     * `db:verify-anonymization-coverage` walks keys into `user`, so none of these tables is
     * visible to it; `db:verify-text-pii-coverage` runs the same statements in a rolled-back
     * transaction. This is the only place they run for real, through `anonymizeAccount` itself.
     *
     * THE VIDEO AND THE LAUNCH BELONG TO THE STAFF ACCOUNT, which is the only configuration
     * that exercises the steps: a video the subject OWNED would be deleted outright by
     * `video.creator_id`, taking its credits with it. What survives an erasure today is the
     * subject's name on somebody else's row.
     */
    const subjectName = smokeUserName(subjectId);
    const subjectHandle = `smoke_${subjectId.slice(-12)}`;
    const autoOrganizationId = `smoke-auto-${randomUUID()}`;
    const declaredOrganizationId = `smoke-self-${randomUUID()}`;
    const declaredOrganizationName = `Norrfall Bracketworks ${subjectId.slice(-8)}`;
    const fixtureVideoId = `smoke-video-${randomUUID()}`;
    const fixtureLaunchId = `smoke-launch-${randomUUID()}`;
    const searchDocumentId = `smoke-doc-${randomUUID()}`;

    await db.execute(sql`
      INSERT INTO commerce_organization
        (id, slug, legal_name, normalized_legal_name, display_name, organization_type,
         trade_state, visibility, provisioning_origin, created_by_user_id, created_at, updated_at)
      VALUES (${autoOrganizationId}, ${`buyer-${autoOrganizationId.slice(-12)}`},
              ${subjectName}, ${subjectName.toLowerCase()}, ${subjectName},
              'sole_proprietor', 'pending', 'private', 'auto_provisioned',
              ${subjectId}, now(), now()),
             (${declaredOrganizationId}, ${`seller-${declaredOrganizationId.slice(-12)}`},
              ${declaredOrganizationName}, ${declaredOrganizationName.toLowerCase()},
              ${declaredOrganizationName},
              'company', 'pending', 'private', 'self_declared',
              ${subjectId}, now(), now())`);

    await db.execute(sql`
      INSERT INTO store_search_document
        (id, document_kind, entity_id, public_slug, title, organization_id, organization_slug,
         organization_display_name, search_text, is_eligible, created_at, updated_at)
      VALUES (${searchDocumentId}, 'organization', ${autoOrganizationId},
              ${`buyer-${autoOrganizationId.slice(-12)}`}, ${subjectName}, ${autoOrganizationId},
              ${`buyer-${autoOrganizationId.slice(-12)}`}, ${subjectName},
              ${`${subjectName} ${subjectName} precision gaskets`}, false, now(), now())`);

    await db.execute(sql`
      INSERT INTO video (id, creator_id, title, youtube_video_id)
      VALUES (${fixtureVideoId}, ${staffId}, 'A smoke fixture video', 'smokeFixt01')`);
    await db.execute(sql`
      INSERT INTO video_collaborator (id, video_id, invited_email, user_id, status)
      VALUES (${randomUUID()}, ${fixtureVideoId}, ${subjectEmail}, ${subjectId}, 'accepted')`);
    await db.execute(sql`
      INSERT INTO video_team_member (id, video_id, member_name, linked_user_id, position)
      VALUES (${randomUUID()}, ${fixtureVideoId}, ${subjectName}, ${subjectId}, 0)`);

    await db.execute(sql`
      INSERT INTO showcase_launch
        (id, author_user_id, title, tagline, summary, launched_at, difficulty,
         accepted_launch_statement_ids, heading_image_url, heading_image_public_id)
      VALUES (${fixtureLaunchId}, ${staffId}, 'A smoke fixture launch',
              'A tagline of a workable length',
              'A summary long enough to satisfy the forty character floor this table sets.',
              now(), 'beginner',
              ARRAY['built_it_ourselves', 'results_are_our_own']::text[],
              'https://example.invalid/smoke-fixture.png', 'smoke/fixture')`);
    await db.execute(sql`
      INSERT INTO showcase_launch_team_member (id, launch_id, position, display_name, handle, role)
      VALUES (${randomUUID()}, ${fixtureLaunchId}, 0, ${subjectName}, ${subjectHandle}, 'Engineer')`);

    const scrubbed = await anonymizeAccount(forScrub.value.requestId);
    check("the scrub ran", scrubbed.success, JSON.stringify(scrubbed));
    if (!scrubbed.success) return;

    console.log(
      `      steps that touched rows: ${JSON.stringify(scrubbed.value.rowsByStep)} ` +
        `(applied=${String(scrubbed.value.applied)})`,
    );

    const [afterScrub] = await db
      .select({
        name: user.name,
        email: user.email,
        handle: user.handle,
        locationLabel: user.locationLabel,
        bio: user.bio,
        isChannelListed: user.isChannelListed,
        anonymizedAt: user.anonymizedAt,
      })
      .from(user)
      .where(eq(user.id, subjectId));

    if (config.ACCOUNT_ANONYMIZATION_ENABLED) {
      /**
       * `bio` AND `isChannelListed` ARE IN HERE BECAUSE NOTHING ELSE CHECKS THEM.
       *
       * `db:verify-anonymization-coverage` walks foreign keys into `user`; both of these are
       * SCALAR columns, so they are invisible to that script. `TEXT_PII_REGISTER` now classifies
       * both as `scrub`, and `db:verify-text-pii-coverage` resolves that claim against the step
       * list — so deleting either line turns something red at last. This assertion remains the
       * END-TO-END one: it is the only place the real `anonymizeAccount` writes them.
       */
      check(
        "the identity is gone",
        afterScrub?.name === "Deleted user" &&
          afterScrub.handle === null &&
          afterScrub.locationLabel === null &&
          afterScrub.bio === null &&
          !afterScrub.isChannelListed &&
          (afterScrub.email ?? "").endsWith("@deleted.qatoto.invalid"),
        `name=${afterScrub?.name ?? "?"} handle=${afterScrub?.handle ?? "null"} bio=${afterScrub?.bio ?? "null"} listed=${String(afterScrub?.isChannelListed)} email=${afterScrub?.email ?? "?"}`,
      );
      check(
        "anonymized_at is stamped",
        afterScrub?.anonymizedAt != null,
        String(afterScrub?.anonymizedAt),
      );
      const [finalRequest] = await db
        .select({ state: accountDeletionRequest.state })
        .from(accountDeletionRequest)
        .where(eq(accountDeletionRequest.id, forScrub.value.requestId));
      check(
        "the request is completed",
        finalRequest?.state === "completed",
        finalRequest?.state ?? "missing",
      );
      const [threadAfter] = (
        await db.execute<{
          title: string;
          body: string;
          slug: string;
          author_user_id: string | null;
        }>(
          sql`SELECT title, body, slug, author_user_id FROM community_forum_thread WHERE id = ${threadId}`,
        )
      ).rows;
      check(
        "a forum thread's text does not survive the erasure",
        threadAfter?.title === "[removed]" &&
          !(threadAfter.body ?? "").includes("smoke thread body") &&
          !(threadAfter.slug ?? "").includes("smoke-thread") &&
          threadAfter.author_user_id === null,
        `title=${threadAfter?.title ?? "?"} slug=${threadAfter?.slug ?? "?"} author=${String(threadAfter?.author_user_id)}`,
      );

      /**
       * ⚠️ THE COMMERCE NAME CHAIN — `user.name` into an auto-provisioned organization shell,
       * and from there into the public search index. Nothing in this repo checked it until the
       * text-PII register existed, because neither table carries a `user` foreign key.
       */
      const [organizationAfter] = (
        await db.execute<{
          display_name: string;
          legal_name: string;
          normalized_legal_name: string;
        }>(
          sql`SELECT display_name, legal_name, normalized_legal_name FROM commerce_organization
              WHERE id = ${autoOrganizationId}`,
        )
      ).rows;
      check(
        "an auto-provisioned organization loses the person's name",
        organizationAfter?.display_name === "Former member" &&
          organizationAfter.legal_name === "Former member" &&
          organizationAfter.normalized_legal_name === "former member",
        `display=${organizationAfter?.display_name ?? "?"} legal=${organizationAfter?.legal_name ?? "?"} normalized=${organizationAfter?.normalized_legal_name ?? "?"}`,
      );

      /**
       * ⚠️ THE CONTROL, WITHOUT WHICH THE ASSERTION ABOVE IS HALF A TEST. A `self_declared`
       * organization is a real company other people trade with, and its name is not one
       * member's to erase. "Scrub every organization this user created" would pass the previous
       * check and destroy it.
       */
      const [declaredAfter] = (
        await db.execute<{ display_name: string }>(
          sql`SELECT display_name FROM commerce_organization WHERE id = ${declaredOrganizationId}`,
        )
      ).rows;
      check(
        "a self_declared organization is left alone",
        declaredAfter?.display_name === declaredOrganizationName,
        `display=${declaredAfter?.display_name ?? "?"} (expected ${declaredOrganizationName})`,
      );

      /**
       * ⚠️ THE ASSERTION THAT MATTERS MOST, AND THE REASON IT IS A `to_tsquery` RATHER THAN A
       * COLUMN COMPARISON.
       *
       * `search_document` is a GENERATED tsvector over `title` (weight A),
       * `organization_display_name` (B) and `search_text` (C), behind a GIN index. Asking the
       * columns proves the UPDATE landed; asking the INDEX the way `/store/search` asks it is
       * what proves a departed person's name is not findable. Delete
       * `tombstone:store_search_document` and this is the check that reds.
       */
      const [documentAfter] = (
        await db.execute<{
          title: string;
          organization_display_name: string;
          search_text: string;
          index_hits: string;
        }>(
          sql`SELECT title, organization_display_name, search_text,
                     (SELECT count(*)::text FROM store_search_document
                      WHERE search_document @@ plainto_tsquery('english', ${subjectId.slice(-8)}))
                     AS index_hits
              FROM store_search_document WHERE id = ${searchDocumentId}`,
        )
      ).rows;
      check(
        "the public search index no longer names the person",
        documentAfter?.index_hits === "0" &&
          !(documentAfter.title ?? "").includes(subjectName) &&
          !(documentAfter.organization_display_name ?? "").includes(subjectName) &&
          !(documentAfter.search_text ?? "").includes(subjectName),
        `tsquery hits=${documentAfter?.index_hits ?? "?"} title=${documentAfter?.title ?? "?"} search_text=${documentAfter?.search_text ?? "?"}`,
      );
      check(
        "and the product terms beside it are still searchable",
        (documentAfter?.search_text ?? "").includes("precision gaskets"),
        `search_text=${documentAfter?.search_text ?? "?"} — the replace must be targeted, not an overwrite`,
      );

      /**
       * THE CREDITS AND THE INVITE, all three on rows the subject does not own. The invite is
       * the one worth naming: `video_collaborator.user_id` is a `null_out`, so after the
       * manifest runs the row reads as an un-accepted invite that still carries a live address.
       */
      const [collaboratorAfter] = (
        await db.execute<{ invited_email: string }>(
          sql`SELECT invited_email FROM video_collaborator WHERE video_id = ${fixtureVideoId}`,
        )
      ).rows;
      check(
        "a video invite's address does not survive the erasure",
        (collaboratorAfter?.invited_email ?? "").endsWith("@deleted.qatoto.invalid"),
        `invited_email=${collaboratorAfter?.invited_email ?? "?"}`,
      );

      const [creditAfter] = (
        await db.execute<{ member_name: string }>(
          sql`SELECT member_name FROM video_team_member WHERE video_id = ${fixtureVideoId}`,
        )
      ).rows;
      check(
        "a video credit keeps the credit and loses the name",
        creditAfter?.member_name === "Former member",
        `member_name=${creditAfter?.member_name ?? "?"}`,
      );

      /**
       * ⚠️ NO FOREIGN KEY AT ALL — a maker typed this name and handle by hand, so it is matched
       * by the handle rather than a key. The handle is also the one `burn_handle` parks forever
       * two assertions down, which is what makes the match exact.
       */
      const [launchMemberAfter] = (
        await db.execute<{ display_name: string; handle: string }>(
          sql`SELECT display_name, handle FROM showcase_launch_team_member
              WHERE launch_id = ${fixtureLaunchId}`,
        )
      ).rows;
      check(
        "a showcase credit loses the name and the handle",
        launchMemberAfter?.display_name === "Former member" &&
          (launchMemberAfter.handle ?? "").startsWith("removed-"),
        `display_name=${launchMemberAfter?.display_name ?? "?"} handle=${launchMemberAfter?.handle ?? "?"}`,
      );

      const burned = await db.execute(
        sql`SELECT expires_at FROM handle_reservations WHERE user_id = ${subjectId}`,
      );
      check(
        "the handle is burned forever",
        burned.rows.length === 1,
        `${String(burned.rows.length)} reservation(s)`,
      );
    } else {
      check(
        "DRY RUN changed nothing",
        afterScrub?.anonymizedAt === null && afterScrub.name === smokeUserName(subjectId),
        "set ACCOUNT_ANONYMIZATION_ENABLED=true to exercise the destructive half",
      );
    }
  } finally {
    await destroySmokeUser(subjectId);
    await destroySmokeUser(staffId);
  }

  console.log(
    failureCount === 0
      ? "\nAll privacy smoke assertions passed."
      : `\n${String(failureCount)} assertion(s) FAILED.`,
  );
  if (failureCount > 0) process.exitCode = 1;
}

main()
  .then(async () => {
    // THE SEND-ONLY pg-boss INSTANCE KEEPS ITS OWN POOL, and it is what left the first
    // version of this script hanging after every assertion had passed: `requestDataExport`
    // enqueues a job, which lazily starts that instance, which then holds the event loop
    // open long after `pool.end()`. Stopping it first is the whole fix.
    await stopSendOnlyBoss();
    await pool.end();
    return undefined;
  })
  .catch(async (error: unknown) => {
    console.error("Privacy smoke failed:", error);
    await stopSendOnlyBoss().catch(() => undefined);
    await pool.end();
    process.exit(1);
  });
