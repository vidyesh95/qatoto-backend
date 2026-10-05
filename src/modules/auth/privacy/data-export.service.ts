import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { and, eq, inArray, lte, sql, type SQL } from "drizzle-orm";
import { fromDrizzle } from "pg-boss";

import { db } from "#src/db/index.js";
import { dataExportRequest, user } from "#src/db/schema.js";
import { idempotencyKeyFor, JOB_NAMES, sendJob } from "#src/lib/jobs.js";
import { logger } from "#src/lib/logger.js";
import {
  deleteDataExportArchive,
  uploadDataExportArchive,
  presignDataExportDownload,
} from "#src/lib/object-storage.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import type { Result } from "#src/types/index.js";

/**
 * Right of access and portability (Privacy Part 3 — GDPR Art. 15 and Art. 20).
 *
 * ## THE SHAPE, AND WHY IT IS ASYNCHRONOUS
 *
 * `POST` answers 202 with a row; a worker builds the archive; `GET` reports state and,
 * once ready, mints a five-minute link. The alternative — assemble it inside the request —
 * would hold a connection open across a walk of every table referencing the caller, on a
 * Postgres instance with `max_connections = 20`.
 *
 * ## ONE GZIPPED JSON DOCUMENT, NOT A ZIP
 *
 * There is no archive library in this repo and adding one for this would be the first.
 * `node:zlib` is built in, and the objection that would normally force streaming does not
 * apply here — RETENTION BOUNDS EVERY BEHAVIOURAL TABLE. `user_activity_hour` dies at 90
 * days (2,160 rows at absolute maximum), `user_watch_daily` at 762, `video_view_session`
 * at 90. `prune-engagement-data` is what keeps that true, so this is safe by argument
 * rather than by the current row counts happening to be small.
 *
 * ⚠️ **THAT ARGUMENT DOES NOT COVER THE SCHEMA-2 SECTIONS.** Orders, effort logs, daily logs and
 * effort claims are records, kept for as long as the account exists, and nothing prunes them. They
 * are bounded only by how much one person trades and works, which today is small. If a smoke run
 * ever shows the gzipped document approaching the job's memory, these sections are the ones to
 * stream first.
 *
 * ## WHAT THE FILE MUST CONTAIN IS DECIDED BY THE PANEL, NOT BY THIS FILE
 *
 * `data-and-privacy-panel.tsx` lists six categories under "What we hold about you". That
 * list is a promise made in shipped UI, and this export is the thing that can now falsify
 * it. So the keys below mirror those six by name, INCLUDING the one that is always empty:
 * omitting `settingsOnThisDevice` because it lives in `localStorage` would leave a user
 * comparing the panel to the download and finding a category missing with no explanation.
 */

/** How long a built archive survives before the reaper deletes it. */
const DATA_EXPORT_RETENTION_DAYS = 7;

const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * Bumped whenever the shape below changes.
 *
 * IN THE FILE, so a copy downloaded a year ago can be read without guessing which version
 * produced it. That is a portability obligation, not housekeeping: Art. 20 data is meant
 * to be usable somewhere that is not us.
 */
const EXPORT_SCHEMA_VERSION = 2;

export type RequestDataExportError =
  | { type: "EXPORT_ALREADY_IN_FLIGHT" }
  | { type: "USER_NOT_FOUND" };

export interface DataExportRequestView {
  readonly requestId: string;
  readonly state: "pending" | "running" | "ready" | "failed" | "expired";
  readonly requestedAt: Date;
  readonly completedAt: Date | null;
  readonly expiresAt: Date | null;
  /** Present only while `state === "ready"`. Minted per read, never stored. */
  readonly downloadUrl: string | null;
  readonly byteSize: number | null;
}

/**
 * Accepts a request, or returns the one already in flight.
 *
 * NO READ-THEN-WRITE. `data_export_request_active_uidx` permits one `pending`/`running`
 * row per user, so this inserts and reads the unique violation as "already in flight" —
 * two tabs cannot both queue a full-table walk.
 */
export async function requestDataExport(
  userId: string,
): Promise<Result<DataExportRequestView, RequestDataExportError>> {
  const [subject] = await db
    .select({ anonymizedAt: user.anonymizedAt })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  if (!subject || subject.anonymizedAt !== null) {
    return { success: false, error: { type: "USER_NOT_FOUND" } };
  }

  try {
    const inserted = await db.transaction(async (tx) => {
      const [row] = await tx.insert(dataExportRequest).values({ userId }).returning({
        id: dataExportRequest.id,
        state: dataExportRequest.state,
        requestedAt: dataExportRequest.requestedAt,
      });

      if (!row) {
        throw new Error(`requestDataExport: insert returned no row for ${userId}`);
      }

      /**
       * ENQUEUED INSIDE THE TRANSACTION, AND A FAILURE ROLLS THE ROW BACK.
       *
       * This is `enqueueNotifications`'s contract, not `scheduleDocumentScan`'s, and the
       * difference is whether a sweep exists to rescue a lost enqueue. Documents have one.
       * Exports do not — so a `pending` row with nothing queued would poll forever, and
       * the caller would sit watching a spinner for a job that does not exist. Better to
       * fail the request and let them press it again.
       */
      const enqueued = await sendJob(
        JOB_NAMES.assembleDataExport,
        { requestId: row.id },
        {
          idempotencyKey: idempotencyKeyFor.assembleDataExport(row.id),
          db: fromDrizzle(tx, sql),
        },
      );

      if (!enqueued.success) {
        throw new Error(`requestDataExport: could not queue the build (${enqueued.error.type})`);
      }

      return row;
    });

    return {
      success: true,
      value: {
        requestId: inserted.id,
        state: inserted.state,
        requestedAt: inserted.requestedAt,
        completedAt: null,
        expiresAt: null,
        downloadUrl: null,
        byteSize: null,
      },
    };
  } catch (error: unknown) {
    if (isUniqueViolation(error)) {
      return { success: false, error: { type: "EXPORT_ALREADY_IN_FLIGHT" } };
    }
    throw error;
  }
}

/**
 * The caller's latest export, with a fresh link when there is something to link to.
 *
 * THE LINK IS MINTED HERE AND NOWHERE ELSE. `data_export_request` stores the object KEY,
 * never a URL: a presigned URL is a bearer credential, and one sitting in a database column
 * would be a five-minute password to a complete PII dump that outlives its own window.
 */
export async function readLatestDataExport(userId: string): Promise<DataExportRequestView | null> {
  const [latest] = await db
    .select()
    .from(dataExportRequest)
    .where(eq(dataExportRequest.userId, userId))
    .orderBy(sql`${dataExportRequest.requestedAt} DESC`)
    .limit(1);

  if (!latest) return null;

  const base: DataExportRequestView = {
    requestId: latest.id,
    state: latest.state,
    requestedAt: latest.requestedAt,
    completedAt: latest.completedAt,
    expiresAt: latest.expiresAt,
    downloadUrl: null,
    byteSize: latest.byteSize,
  };

  if (latest.state !== "ready" || latest.objectKey === null) return base;

  // AN ARCHIVE PAST ITS RETENTION READS AS `expired`, EVEN BEFORE THE REAPER RUNS. The
  // object may still exist for a few hours after `expires_at`; handing out a link to it
  // would quietly extend a retention period we told the user was seven days.
  if (latest.expiresAt !== null && latest.expiresAt <= new Date()) {
    return { ...base, state: "expired" };
  }

  const presigned = await presignDataExportDownload(latest.objectKey);
  if (!presigned.success) {
    logger.error("failed to presign a ready data export", {
      requestId: latest.id,
      cause: presigned.error.type,
    });
    return base;
  }

  return { ...base, downloadUrl: presigned.value.downloadUrl };
}

/**
 * Builds one archive and marks the request ready. Called from the worker.
 *
 * IDEMPOTENT BY PREDICATE: the claim below only moves a row that is still `pending`, so a
 * redelivered job whose predecessor finished does nothing rather than rebuilding.
 */
export async function assembleDataExport(requestId: string): Promise<void> {
  const [claimed] = await db
    .update(dataExportRequest)
    .set({
      state: "running",
      startedAt: new Date(),
      // COUNTED AT THE CLAIM, so the catch below can tell a first failure from a last one.
      // This column existed and was never written by anything — which is why a permanently
      // failing export had no way to reach its own terminal state.
      attemptCount: sql`${dataExportRequest.attemptCount} + 1`,
    })
    .where(and(eq(dataExportRequest.id, requestId), eq(dataExportRequest.state, "pending")))
    .returning({
      id: dataExportRequest.id,
      userId: dataExportRequest.userId,
      attemptCount: dataExportRequest.attemptCount,
    });

  if (!claimed) {
    logger.info("data export was already claimed or finished", { requestId });
    return;
  }

  try {
    const document = await buildExportDocument(claimed.userId);
    const archiveBytes = gzipSync(Buffer.from(JSON.stringify(document, null, 2), "utf8"));
    const contentSha256 = createHash("sha256").update(archiveBytes).digest("hex");

    const uploaded = await uploadDataExportArchive({
      userId: claimed.userId,
      requestId,
      archiveBytes,
      contentSha256,
    });

    if (!uploaded.success) {
      // Thrown so pg-boss retries: a storage outage is exactly the transient this job's
      // backoff exists for, and the row stays claimable because `markFailed` reverts it.
      throw new Error(`data export upload failed: ${uploaded.error.type}`);
    }

    const completedAt = new Date();
    await db
      .update(dataExportRequest)
      .set({
        state: "ready",
        completedAt,
        objectKey: uploaded.value.objectKey,
        byteSize: archiveBytes.byteLength,
        contentSha256,
        expiresAt: new Date(
          completedAt.getTime() + DATA_EXPORT_RETENTION_DAYS * MILLISECONDS_PER_DAY,
        ),
      })
      /**
       * `AND state = 'running'` IS NOT DECORATION. Without it, an export whose job was
       * still building when the owner's anonymization purged their archives would upload
       * the pre-erasure PII dump and then flip its own row back to `ready`, complete with
       * a live object key and a fresh seven-day expiry. Narrow, but it is a
       * PII-survives-erasure path and nothing downstream would report it.
       */
      .where(and(eq(dataExportRequest.id, requestId), eq(dataExportRequest.state, "running")));

    logger.info("data export ready", {
      requestId,
      byteSize: archiveBytes.byteLength,
    });
  } catch (error: unknown) {
    /**
     * `pending` WHILE RETRIES REMAIN, `failed` ON THE LAST ONE — and getting that second
     * half wrong is what made a single permanent failure unrecoverable.
     *
     * The old code reverted to `pending` on EVERY attempt including the final one. Because
     * `data_export_request_active_uidx` covers `('pending','running')`, that stuck row then
     * made every future `POST /users/me/export` from that person a 409 **forever**: their
     * Art. 15 right, bricked by one bad build, with `markDataExportFailed` sitting
     * uncalled two functions away and `failed` unreachable in the enum.
     */
    const isLastAttempt = claimed.attemptCount >= DATA_EXPORT_MAX_ATTEMPTS;

    if (isLastAttempt) {
      await markDataExportFailed(requestId, describeCause(error));
      logger.error("data export failed permanently", {
        requestId,
        attemptCount: claimed.attemptCount,
        cause: describeCause(error),
      });
      // NOT RETHROWN. The row is terminal and the panel can render it; throwing would only
      // buy a dead-letter entry for a failure already recorded where the user can see it.
      return;
    }

    await db
      .update(dataExportRequest)
      .set({ state: "pending", failureReason: describeCause(error).slice(0, 2000) })
      .where(eq(dataExportRequest.id, requestId));
    throw error;
  }
}

/**
 * Terminal failure. Frees the partial unique index so the person can ask again.
 *
 * THE STATE MUST LEAVE `('pending','running')`, which is the whole point: while the row
 * sits in either, `data_export_request_active_uidx` refuses every new request from that
 * user with a 409.
 */
async function markDataExportFailed(requestId: string, reason: string): Promise<void> {
  await db
    .update(dataExportRequest)
    .set({ state: "failed", failureReason: reason.slice(0, 2000) })
    .where(eq(dataExportRequest.id, requestId));
}

/** How many builds one request gets before it is called permanently failed. */
const DATA_EXPORT_MAX_ATTEMPTS = 5;

/**
 * Deletes archives past their retention, and every archive of an anonymized account.
 *
 * THE SECOND CLAUSE IS THE ONE THAT MATTERS. An export built the day before somebody asked
 * to be deleted is a complete copy of everything the scrub then erased. Without this, the
 * database would read as fully anonymized while the bucket still held the original.
 */
export async function pruneExpiredDataExports(asOf: Date): Promise<number> {
  const expired = await db
    .select({ id: dataExportRequest.id, objectKey: dataExportRequest.objectKey })
    .from(dataExportRequest)
    .where(and(eq(dataExportRequest.state, "ready"), lte(dataExportRequest.expiresAt, asOf)));

  for (const row of expired) {
    if (row.objectKey === null) continue;
    const deleted = await deleteDataExportArchive(row.objectKey);
    if (!deleted.success) {
      logger.error("failed to delete an expired data export archive", {
        requestId: row.id,
        cause: deleted.error.type,
      });
    }
  }

  if (expired.length > 0) {
    await db
      .update(dataExportRequest)
      .set({ state: "expired", objectKey: null, contentSha256: null, byteSize: null })
      .where(
        inArray(
          dataExportRequest.id,
          expired.map((row) => row.id),
        ),
      );
  }

  return expired.length;
}

/**
 * How many archives this person has, without touching any of them.
 *
 * FOR THE DRY RUN, which must report what it WOULD delete and delete nothing. Without a
 * read-only counterpart the dry run would either lie (report zero) or not be dry.
 */
export async function countDataExportsForUser(userId: string): Promise<number> {
  const owned = await db
    .select({ id: dataExportRequest.id })
    .from(dataExportRequest)
    .where(eq(dataExportRequest.userId, userId));
  return owned.length;
}

/**
 * Removes every archive belonging to one user. Called by the anonymization scrub.
 *
 * Returns the count so the scrub can log it as one of its steps — an erasure that left
 * files behind should be visible as such rather than only in a bucket listing.
 */
export async function purgeDataExportsForUser(userId: string): Promise<number> {
  const owned = await db
    .select({ id: dataExportRequest.id, objectKey: dataExportRequest.objectKey })
    .from(dataExportRequest)
    .where(eq(dataExportRequest.userId, userId));

  for (const row of owned) {
    if (row.objectKey === null) continue;
    const deleted = await deleteDataExportArchive(row.objectKey);
    if (!deleted.success) {
      logger.error("failed to delete a data export archive during anonymization", {
        userId,
        requestId: row.id,
        cause: deleted.error.type,
      });
    }
  }

  if (owned.length > 0) {
    await db
      .update(dataExportRequest)
      .set({ state: "expired", objectKey: null, contentSha256: null, byteSize: null })
      .where(eq(dataExportRequest.userId, userId));
  }

  return owned.length;
}

function describeCause(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/**
 * Everything we hold about one person, in the six categories the panel names.
 *
 * WHY RAW SQL RATHER THAN THE DRIZZLE QUERY BUILDER. Every statement here is a flat
 * `SELECT … WHERE <column> = $1` over a table whose columns this file must choose
 * explicitly, and going through the builder would mean importing thirty table objects to
 * express thirty identical shapes. The identifiers are literals in this file, never input.
 */
async function buildExportDocument(userId: string): Promise<Record<string, unknown>> {
  const rowCounts: Record<string, number> = {};

  /**
   * THE USER ID IS BOUND, NEVER INTERPOLATED.
   *
   * Every statement below is a `sql` template, so `${userId}` becomes a placeholder and a
   * parameter rather than text spliced into the query. It arrives from the session and is
   * a uuid, so nothing here is currently hostile — but "the value happens to be safe" is
   * not a property that survives a refactor, and `sql.raw` on a string carrying a user
   * value is the exact shape this codebase must never contain (CLAUDE.md §1.1).
   *
   * Column and table names ARE literal in this file, which is the other half of the rule:
   * identifiers are ours, values are bound.
   */
  const collect = async (label: string, statement: SQL): Promise<readonly unknown[]> => {
    const result = await db.execute(statement);
    rowCounts[label] = result.rows.length;
    return result.rows;
  };

  const whoYouAre = await collect(
    "whoYouAre",
    sql`SELECT id, name, email, image, handle, location_label, bio, created_at
        FROM "user" WHERE id = ${userId}`,
  );

  /**
   * The external links on the channel profile.
   *
   * THEY BELONG HERE FOR THE SAME REASON `bio` DOES — a person wrote them about themselves, so
   * Art. 15 asks for them and Art. 20 asks for them in a portable form. They were nearly missed
   * because the bio is a column on `user` and these are a table, so adding one did not surface the
   * other.
   */
  const yourChannelLinks = await collect(
    "yourChannelLinks",
    sql`SELECT label, url, sort_order, created_at
        FROM user_profile_link WHERE user_id = ${userId} ORDER BY sort_order`,
  );

  /**
   * The decks and whitepapers attached to the subject's own videos.
   *
   * FILE NAMES AND SIZES, NOT BYTES. Art. 15 asks what is held about the subject, and the metadata
   * answers that; embedding up to 25 MB per document would turn a JSON archive into a multi-hundred
   * megabyte one that the seven-day-retention purge then has to move around. `objectStorageKey` is
   * deliberately NOT listed either — it is an internal address, not personal data, and printing it
   * into a file that travels by email would hand out a pointer into the bucket.
   *
   * FOUND THE SAME WAY `yourChannelLinks` WAS: by asking what a new table means for this file
   * rather than only for the scrub. The two obligations are separate and neither implies the other.
   */
  const yourVideoDocuments = await collect(
    "yourVideoDocuments",
    sql`SELECT d.video_id, d.file_name, d.byte_size, d.position, d.created_at
        FROM video_document AS d
        JOIN video AS v ON v.id = d.video_id
        WHERE v.creator_id = ${userId}
        ORDER BY d.video_id, d.position`,
  );

  const howYouSignIn = {
    // NEVER `password`, `access_token`, `refresh_token` or `id_token`. Those are
    // CREDENTIALS, not personal data about the subject, and Art. 15 does not ask for them
    // — handing them out in a file that travels by email would be the single most
    // dangerous line in this module.
    linkedAccounts: await collect(
      "linkedAccounts",
      sql`SELECT provider_id, email, created_at FROM account WHERE user_id = ${userId}`,
    ),
    // `public_key` excluded for the same reason.
    passkeys: await collect(
      "passkeys",
      sql`SELECT name, device_type, backed_up, created_at FROM passkey WHERE user_id = ${userId}`,
    ),
    // The panel explicitly promises "each signed-in device, with the IP address and
    // browser it signed in from", so these two columns are in scope by prior commitment.
    signedInDevices: await collect(
      "signedInDevices",
      sql`SELECT ip_address, user_agent, created_at, expires_at FROM session WHERE user_id = ${userId}`,
    ),
  };

  const whatYouDoHere = {
    videosWatched: await collect(
      "videosWatched",
      sql`SELECT video_id, view_day_bucket, watched_seconds, first_beacon_at
          FROM video_view_session WHERE viewer_id = ${userId}`,
    ),
    likes: await collect(
      "likes",
      sql`SELECT video_id, created_at FROM video_like WHERE user_id = ${userId}`,
    ),
    saves: await collect(
      "saves",
      sql`SELECT video_id, created_at FROM video_save WHERE user_id = ${userId}`,
    ),
    comments: await collect(
      "comments",
      sql`SELECT video_id, body_text, is_deleted, created_at
          FROM video_comment WHERE author_user_id = ${userId}`,
    ),
    playlists: await collect(
      "playlists",
      sql`SELECT id, title, created_at FROM playlist WHERE creator_id = ${userId}`,
    ),
    subscriptions: await collect(
      "subscriptions",
      sql`SELECT creator_id, created_at FROM creator_subscription WHERE subscriber_id = ${userId}`,
    ),
    /**
     * BOTH HALVES OF A FORUM CONVERSATION. Replies were exported and THREADS WERE NOT —
     * an Art. 15 completeness gap that came from the same oversight as the missing thread
     * tombstone in `anonymize-account.service.ts`: the opening post is the longer, more
     * self-identifying half, and it was the one being left out of both.
     */
    forumThreads: await collect(
      "forumThreads",
      sql`SELECT id, board, title, body, state, created_at
          FROM community_forum_thread WHERE author_user_id = ${userId}`,
    ),
    forumReplies: await collect(
      "forumReplies",
      sql`SELECT thread_id, body, created_at FROM community_forum_reply WHERE author_user_id = ${userId}`,
    ),
  };

  const howMuchYouWatch = {
    byHour: await collect(
      "activityByHour",
      sql`SELECT activity_date, activity_hour, watched_seconds
          FROM user_activity_hour WHERE user_id = ${userId}`,
    ),
    byDay: await collect(
      "watchByDay",
      sql`SELECT watch_date, watched_seconds, distinct_video_count
          FROM user_watch_daily WHERE user_id = ${userId}`,
    ),
  };

  /**
   * PRODUCT PAGES THE SUBJECT OPENED WHILE SIGNED IN.
   *
   * ⚠️ **ADDED WITH THE PRODUCT VIEW BEACON, AND IT HAD TO BE.** Until the beacon shipped nothing
   * called the route, so the table held no production rows and its absence here cost nothing. The
   * moment a signed-in reader opens a listing, `commerce_product_view_session.viewer_id` carries
   * their account id and Art. 15 asks for the row — an export missing it is silently incomplete,
   * which is worse than one that never had it.
   *
   * ⚠️ **`viewer_fingerprint` AND `subnet_hash` ARE DELIBERATELY NOT SELECTED**, on the same
   * reasoning the watch fingerprint is excluded below: they are salted hashes that exist to stop
   * one person counting as many, they are not identifiers anyone here can read back, and printing
   * them would tell the subject nothing about themselves while handing out the shape of an
   * anti-fraud control. `notIncluded` says so in the document.
   *
   * Anonymisation is already handled elsewhere — `anonymization-manifest.ts` nulls `viewer_id`,
   * which leaves the row as anonymous traffic rather than deleting a seller's view count.
   */
  const productPagesYouLookedAt = await collect(
    "productPagesYouLookedAt",
    sql`SELECT product_id, view_day_bucket, view_source, dwell_seconds, is_counted_view,
               first_beacon_at, last_beacon_at
        FROM commerce_product_view_session
        WHERE viewer_id = ${userId}
        ORDER BY view_day_bucket DESC`,
  );

  /**
   * SUPPORT CASES THE SUBJECT OPENED, AND THE WHOLE THREAD OF EACH.
   *
   * ⚠️ **ADDED WITH THE TABLE, because the scrub alone would not have covered it.** The
   * manifest deletes these rows on erasure, which is the Art. 17 half; this is the Art. 15
   * half, and `yourChannelLinks` above records how easily one ships without the other. A case
   * is somebody describing their own problem in their own words — squarely their personal
   * data, and squarely portable.
   *
   * BOTH SIDES OF THE THREAD, and that is not a slip against the "things other people wrote
   * about you" exclusion below. A staff reply is correspondence WITH this person, already
   * delivered to them and readable in the app; withholding it would hand back half a
   * conversation. `author_user_id` is deliberately NOT selected — the person learns that
   * support answered, never which staff member did, exactly as the app shows it.
   */
  const supportCasesYouOpened = await collect(
    "supportCasesYouOpened",
    sql`SELECT id, category, state, subject, description, order_reference,
               decision_note, created_at, decided_at
        FROM support_case WHERE opened_by_user_id = ${userId}
        ORDER BY created_at DESC`,
  );

  const supportCaseMessages = await collect(
    "supportCaseMessages",
    sql`SELECT m.case_id, m.sequence, m.author_kind, m.body, m.created_at
        FROM support_case_message AS m
        JOIN support_case AS c ON c.id = m.case_id
        WHERE c.opened_by_user_id = ${userId}
        ORDER BY m.case_id, m.sequence`,
  );

  /**
   * FEEDBACK THE SUBJECT SENT ABOUT THE PRODUCT.
   *
   * ⚠️ **THE THIRD TABLE TO SHIP WITH THE SCRUB AND WITHOUT THE EXPORT.** `yourChannelLinks`
   * and `yourVideoDocuments` above both record being "nearly missed" the same way, and this
   * one was missed outright: `platform_feedback.user_id` has been in the anonymization
   * manifest since the table shipped — the Art. 17 half — with nothing here to answer Art. 15.
   * A note somebody wrote in their own words about their own experience is squarely their
   * personal data and squarely portable.
   *
   * `user_agent` IS DELIBERATELY NOT SELECTED. The server read it off a request header, so
   * handing it back describes the browser they were already using rather than telling them
   * anything they did not know, and it is the one column here they did not author.
   *
   * `status` IS selected. It is a staff triage flag, but it is also the only thing on the row
   * that changes after they send it, and the app already shows it to them.
   */
  const feedbackYouSent = await collect(
    "feedbackYouSent",
    sql`SELECT id, category, message, page_path, status, created_at
        FROM platform_feedback WHERE user_id = ${userId}
        ORDER BY created_at DESC`,
  );

  /**
   * PREMIUM AI GRANTS ON THE SUBJECT'S OWN ACCOUNT: when it was granted and, if so, revoked.
   *
   * The staff member's identity and the admin's note are NOT selected: both are internal
   * decisions about the account rather than data the person provided, and the note is written
   * for the next admin. What is theirs is the fact and its dates.
   */
  const premiumAiAccess = await collect(
    "premiumAiAccess",
    sql`SELECT granted_at, revoked_at
        FROM assistant_cloud_entitlement WHERE user_id = ${userId}
        ORDER BY granted_at DESC`,
  );

  /**
   * ORDERS THE SUBJECT PLACED, AND THE CART OF THEIR OWN BUYER WORKSPACE (schema 2).
   *
   * ⚠️ **AN ORDER BELONGS TO AN ORGANIZATION, NOT A PERSON, SO "YOURS" HAS TO BE DECIDED.** The
   * rule is: orders whose `created_by_member_id` is one of the subject's memberships, in ANY
   * organization. Not every order of every organization they belong to — that would hand a junior
   * buyer the whole company's order book, which is the company's record and not their personal data.
   * Orders a colleague placed are listed under `manifest.exclusions` for that reason.
   *
   * WHAT IS LEFT OUT OF AN ORDER, AND WHY:
   *  - `counterparty_address_snapshot` — the seller's address is the seller's data. Their legal name
   *    stays: it is who the subject traded with, and the order page already shows it.
   *  - `buyer_qualification_state` / `_reasons` — an anti-fraud assessment; printing it hands out
   *    the shape of the control. Listed in the exclusions.
   *  - Internal ids (`delivery_address_id`, `checkout_group_id`, quote ids, `created_by_member_id`)
   *    — pointers, not information about the subject.
   *  - From payments: `idempotency_key`, `provider_payment_ref`, `settlement_account_ref` and
   *    `application_fee_in_cents` — internal references, the seller's processor account and
   *    Qatoto's fee. The amount, state and dates are the subject's.
   *  - Customization artwork BYTES and their document ids — `has_document` says one was attached,
   *    for the reason `yourVideoDocuments` gives sizes rather than files.
   */
  const ordersYouPlaced = await collect(
    "ordersYouPlaced",
    sql`SELECT o.id, o.source, o.state, o.currency, o.subtotal_in_cents, o.tax_in_cents,
               o.service_fee_in_cents, o.shipping_in_cents, o.discount_in_cents, o.total_in_cents,
               o.payment_terms_snapshot, o.incoterm_snapshot, o.requested_freight_mode_snapshot,
               o.buyer_legal_name_snapshot, o.buyer_address_snapshot,
               o.counterparty_legal_name_snapshot, o.promised_delivery_at, o.confirmed_at,
               o.completed_at, o.cancelled_at, o.settlement_rail, o.created_at
        FROM commerce_order AS o
        WHERE o.created_by_member_id IN
              (SELECT id FROM commerce_organization_member WHERE user_id = ${userId})
        ORDER BY o.created_at DESC`,
  );

  const orderLines = await collect(
    "orderLines",
    sql`SELECT l.order_id, l.product_id, l.title_snapshot, l.variant_name_snapshot,
               l.specification_snapshot, l.is_sample, l.quantity_ordered, l.quantity_fulfilled,
               l.quantity_cancelled, l.quantity_refunded, l.unit_price_in_cents,
               l.line_total_in_cents, l.promised_delivery_at, l.lead_time_min_days_snapshot,
               l.created_at
        FROM commerce_order_product_line AS l
        JOIN commerce_order AS o ON o.id = l.order_id
        WHERE o.created_by_member_id IN
              (SELECT id FROM commerce_organization_member WHERE user_id = ${userId})
        ORDER BY l.order_id, l.sibling_order`,
  );

  const orderServiceLines = await collect(
    "orderServiceLines",
    sql`SELECT l.order_id, l.provider_kind, l.title_snapshot, l.scope_snapshot, l.fee_in_cents,
               l.created_at
        FROM commerce_order_service_line AS l
        JOIN commerce_order AS o ON o.id = l.order_id
        WHERE o.created_by_member_id IN
              (SELECT id FROM commerce_organization_member WHERE user_id = ${userId})
        ORDER BY l.order_id, l.sibling_order`,
  );

  const orderLineChoices = await collect(
    "orderLineChoices",
    sql`SELECT l.order_id, c.slot_key_snapshot, c.label_snapshot, c.choice_value,
               (c.encrypted_document_id IS NOT NULL) AS has_document, c.created_at
        FROM commerce_order_line_customization AS c
        JOIN commerce_order_product_line AS l ON l.id = c.order_product_line_id
        JOIN commerce_order AS o ON o.id = l.order_id
        WHERE o.created_by_member_id IN
              (SELECT id FROM commerce_organization_member WHERE user_id = ${userId})
        ORDER BY l.order_id, c.created_at`,
  );

  const orderPayments = await collect(
    "orderPayments",
    sql`SELECT p.order_id, p.provider, p.state, p.amount_in_cents, p.currency, p.failure_reason,
               p.authorized_at, p.settled_at, p.failed_at, p.cancelled_at, p.created_at
        FROM commerce_payment_intent AS p
        JOIN commerce_order AS o ON o.id = p.order_id
        WHERE o.created_by_member_id IN
              (SELECT id FROM commerce_organization_member WHERE user_id = ${userId})
        ORDER BY p.order_id, p.created_at`,
  );

  /**
   * Cover, test reports and storage the subject DECLARED on an order — rows they wrote, so theirs
   * whichever side they were on. A declaration the other party made is that party's statement.
   * `evidence_document_id` is a pointer, not a fact, and is not selected.
   */
  const orderDeclarationsYouMade = await collect(
    "orderDeclarationsYouMade",
    sql`SELECT d.order_id, d.kind, d.declared_by_side, d.issuer, d.reference, d.coverage_class,
               d.standard, d.coverage_amount_in_cents, d.coverage_currency, d.valid_from,
               d.valid_until, d.issued_on, d.note, d.disclaimer_version, d.withdrawn_at,
               d.created_at
        FROM commerce_order_third_party_declaration AS d
        WHERE d.declared_by_member_id IN
              (SELECT id FROM commerce_organization_member WHERE user_id = ${userId})
        ORDER BY d.created_at DESC`,
  );

  /**
   * THE CART OF THE SUBJECT'S OWN BUYER WORKSPACE ONLY. A cart is one per organization and its
   * lines carry no member, so in a shared company cart there is no way to say which lines are
   * this person's. The auto-provisioned workspace is the one cart that is theirs alone. A plain
   * SELECT, never `getCart`: that read creates a cart when none exists and re-prices every line,
   * and an export must not write. Prices are not stored on a cart line, so none are given.
   */
  const cartLines = await collect(
    "cartLines",
    sql`SELECT l.product_id, p.title AS product_title, l.variant_id, l.quantity, l.is_sample,
               l.created_at, l.updated_at
        FROM commerce_cart_product_line AS l
        JOIN commerce_cart AS c ON c.id = l.cart_id
        JOIN commerce_organization AS org ON org.id = c.buyer_organization_id
        LEFT JOIN product AS p ON p.id = l.product_id
        WHERE org.provisioning_origin = 'auto_provisioned'
          AND org.created_by_user_id = ${userId}
        ORDER BY l.created_at`,
  );

  const cartLineChoices = await collect(
    "cartLineChoices",
    sql`SELECT l.product_id, ch.slot_key_snapshot, ch.label_snapshot, ch.choice_value,
               (ch.encrypted_document_id IS NOT NULL) AS has_document, ch.created_at
        FROM commerce_cart_line_customization AS ch
        JOIN commerce_cart_product_line AS l ON l.id = ch.cart_product_line_id
        JOIN commerce_cart AS c ON c.id = l.cart_id
        JOIN commerce_organization AS org ON org.id = c.buyer_organization_id
        WHERE org.provisioning_origin = 'auto_provisioned'
          AND org.created_by_user_id = ${userId}
        ORDER BY l.created_at, ch.created_at`,
  );

  /**
   * EFFORT THE SUBJECT LOGGED AND CLAIMED (schema 2), on both R&D surfaces.
   *
   * Research PROGRAMMES reach the person through `research_program_participant`; PROJECTS through
   * `project_member`. Both are self-reported records written by the subject, so both are theirs.
   * Excluded throughout: idempotency keys (request plumbing), the daily log's analysis-pipeline
   * internals (model names, prompt versions, failure text), and on an effort claim the reviewer's
   * id and override reason — what a reviewer wrote about the work falls under the "things other
   * people wrote about you" exclusion. The overridden MINUTES stay: they are what the claim now says.
   */
  const programmeParticipations = await collect(
    "programmeParticipations",
    sql`SELECT program_id, role, compensation_preference, contribution_summary, joined_at
        FROM research_program_participant WHERE user_id = ${userId}
        ORDER BY joined_at`,
  );

  const programmeEffort = await collect(
    "programmeEffort",
    sql`SELECT e.program_id, e.branch_id, e.minutes, e.logged_for_date, e.note, e.created_at
        FROM research_effort_log AS e
        JOIN research_program_participant AS p ON p.id = e.participant_id
        WHERE p.user_id = ${userId}
        ORDER BY e.logged_for_date DESC, e.created_at DESC`,
  );

  const programmeContributions = await collect(
    "programmeContributions",
    sql`SELECT e.program_id, e.kind, e.amount_in_cents, e.currency_code, e.description,
               e.created_at
        FROM research_contribution_ledger_entry AS e
        JOIN research_program_participant AS p ON p.id = e.participant_id
        WHERE p.user_id = ${userId}
        ORDER BY e.created_at DESC`,
  );

  const projectDailyLogs = await collect(
    "projectDailyLogs",
    sql`SELECT d.project_id, d.log_date, d.narrative, d.status, d.submitted_at, d.video_source,
               d.youtube_video_id, d.effort_verification_status, d.created_at
        FROM daily_log AS d
        JOIN project_member AS m ON m.id = d.author_member_id
        WHERE m.user_id = ${userId}
        ORDER BY d.log_date DESC, d.created_at DESC`,
  );

  const projectEffortClaims = await collect(
    "projectEffortClaims",
    sql`SELECT c.project_id, c.source_kind, c.claimed_for_date, c.claim_summary,
               c.extracted_minutes, c.extracted_cash_in_cents, c.grounded_minutes,
               c.grounded_cash_in_cents, c.overridden_minutes, c.overridden_at,
               c.verification_status, c.verdict_reached_at, c.created_at
        FROM effort_claim AS c
        JOIN project_member AS m ON m.id = c.member_id
        WHERE m.user_id = ${userId}
        ORDER BY c.claimed_for_date DESC, c.created_at DESC`,
  );

  const workYouHaveDone = {
    projectsFounded: await collect(
      "projectsFounded",
      sql`SELECT id, name, slug, stage, status, created_at
          FROM research_project WHERE founder_user_id = ${userId}`,
    ),
    memberships: await collect(
      "memberships",
      sql`SELECT project_id, project_role, role_title, status, joined_at, left_at
          FROM project_member WHERE user_id = ${userId}`,
    ),
    applications: await collect(
      "applications",
      sql`SELECT project_id, kind, status, short_pitch, created_at
          FROM project_application WHERE applicant_user_id = ${userId}`,
    ),
    programmeParticipations,
    programmeEffort,
    programmeContributions,
    projectDailyLogs,
    projectEffortClaims,
  };

  return {
    readme:
      "This file is your Qatoto data export, provided under Articles 15 and 20 of the " +
      "GDPR (the right of access and the right to data portability). It is a gzipped JSON " +
      "document. Each top-level key matches a category shown in Settings → Your data & " +
      "privacy. Anything that category holds but this file omits is listed in `manifest." +
      "exclusions`, with the reason.",
    manifest: {
      generatedAt: new Date().toISOString(),
      schemaVersion: EXPORT_SCHEMA_VERSION,
      rowCounts,
      exclusions: [
        {
          what: "Passwords, passkey public keys, and OAuth access/refresh tokens",
          why: "These are credentials that authenticate you, not information about you. Including them in a downloadable file would put your account at more risk than the export protects.",
        },
        {
          what: "The per-day viewer fingerprint on watch rows",
          why: "A salted hash used to stop view-count fraud, not an identifier we can read back. It is deleted with the row at 90 days.",
        },
        {
          what: "Things other people wrote about you — reports, moderation notes, reviews of your work",
          why: "GDPR Article 15(4): a copy provided to you must not adversely affect the rights and freedoms of others.",
        },
        {
          what: "The platform-wide hour-by-hour activity total",
          why: "It carries no account id at all, so there is no way to say which part of it is yours.",
        },
        {
          what: "The per-day code and blunted network address stored beside each product-page view",
          why: "Salted hashes that stop one person's reloads counting as many shoppers. They are not identifiers we can read back, so printing them would tell you nothing about yourself.",
        },
        {
          what: "Who granted or revoked Premium AI on your account, and their note",
          why: "Internal staff decisions about the account rather than data you provided. The fact and its dates are included under premiumAiAccess.",
        },
        {
          what: "Product pages you opened while signed out",
          why: "They carry no account id, so there is no way to say which of them were yours.",
        },
        {
          what: "Orders a colleague placed for a company you belong to",
          why: "Those are the company's records, not your personal data. whatYouBought lists the orders you placed yourself, in any company.",
        },
        {
          what: "Carts of companies you belong to",
          why: "A company has one shared cart and its lines do not record who added them, so there is no way to say which are yours. The cart of your own buyer workspace is included.",
        },
        {
          what: "The seller's address on your orders, and the other party's declarations",
          why: "They are the other party's data (GDPR Article 15(4)). The seller's name, and every declaration you made yourself, are included.",
        },
        {
          what: "The fraud-screening assessment on your orders",
          why: "Printing it would hand out the shape of an anti-fraud control.",
        },
        {
          what: "Payment processor references, the seller's settlement account and Qatoto's fee",
          why: "Internal references and other parties' data. The amount, state and dates of each payment are included.",
        },
        {
          what: "Artwork and documents you attached to customized lines",
          why: "The files themselves are not copied into this document; has_document says one was attached, as with your video documents.",
        },
      ],
    },
    whoYouAre,
    yourChannelLinks,
    yourVideoDocuments,
    howYouSignIn,
    whatYouDoHere,
    howMuchYouWatch,
    productPagesYouLookedAt,
    supportYouAskedFor: { cases: supportCasesYouOpened, messages: supportCaseMessages },
    feedbackYouSent,
    premiumAiAccess,
    whatYouBought: {
      orders: ordersYouPlaced,
      orderLines,
      orderServiceLines,
      orderLineChoices,
      payments: orderPayments,
      declarationsYouMade: orderDeclarationsYouMade,
      cart: { lines: cartLines, choices: cartLineChoices },
    },
    workYouHaveDone,
    /**
     * PRESENT AND EMPTY, ON PURPOSE. The panel lists "Settings on this device" as one of
     * six categories; a download missing one of the six reads as data withheld. It is
     * empty because these values genuinely never leave the browser.
     */
    settingsOnThisDevice: {
      rows: [],
      note: "Your language, browse country, AI assist preference, where the assistant sits and its size and speed, and the notes you asked it to remember are stored in your browser's local storage. We store none of them, so we have no copy to include. (With Premium AI, the notes travel with a question to produce an answer and are not kept.) Clear them from Settings → Your data & privacy.",
    },
  };
}
