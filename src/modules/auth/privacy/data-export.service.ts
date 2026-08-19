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
 * ## WHAT THE FILE MUST CONTAIN IS DECIDED BY THE PANEL, NOT BY THIS FILE
 *
 * `data-and-privacy-panel.tsx` lists six categories under "What we hold about you". That
 * list is a promise made in shipped UI, and this export is the thing that can now falsify
 * it. So the keys below mirror those six by name, INCLUDING the one that is always empty:
 * omitting `settingsOnThisDevice` because it lives in `localStorage` would leave a user
 * comparing the panel to the download and finding a category missing with no explanation.
 */

/** How long a built archive survives before the reaper deletes it. */
export const DATA_EXPORT_RETENTION_DAYS = 7;

const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * Bumped whenever the shape below changes.
 *
 * IN THE FILE, so a copy downloaded a year ago can be read without guessing which version
 * produced it. That is a portability obligation, not housekeeping: Art. 20 data is meant
 * to be usable somewhere that is not us.
 */
const EXPORT_SCHEMA_VERSION = 1;

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
export async function markDataExportFailed(requestId: string, reason: string): Promise<void> {
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
    sql`SELECT id, name, email, image, handle, location_label, created_at
        FROM "user" WHERE id = ${userId}`,
  );

  const howYouSignIn = {
    // NEVER `password`, `access_token`, `refresh_token` or `id_token`. Those are
    // CREDENTIALS, not personal data about the subject, and Art. 15 does not ask for them
    // — handing them out in a file that travels by email would be the single most
    // dangerous line in this module.
    linkedAccounts: await collect(
      "linkedAccounts",
      sql`SELECT provider_id, issuer, email, created_at FROM account WHERE user_id = ${userId}`,
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
      ],
    },
    whoYouAre,
    howYouSignIn,
    whatYouDoHere,
    howMuchYouWatch,
    workYouHaveDone,
    /**
     * PRESENT AND EMPTY, ON PURPOSE. The panel lists "Settings on this device" as one of
     * six categories; a download missing one of the six reads as data withheld. It is
     * empty because these values genuinely never leave the browser.
     */
    settingsOnThisDevice: {
      rows: [],
      note: "Your language, browse country and AI assist preference are stored in your browser's local storage and are never sent to us, so we have no copy to include. Clear them from Settings → Your data & privacy.",
    },
  };
}
