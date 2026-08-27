import { and, asc, count, desc, eq, gt, or, sql, type SQL } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { user, video, videoContentReport, videoModerationAction } from "#src/db/schema.js";
import { appendPlatformAuditEntry } from "#src/modules/platform/audit/platform-audit.service.js";
import {
  requirePlatformCapability,
  type PlatformStaffContext,
} from "#src/modules/platform/roles/platform-role.service.js";
import { findPublicVideo } from "#src/modules/studio/public-video-gate.js";
import type {
  DecideVideoReportInput,
  ListVideoReportsQuery,
  ReportVideoInput,
  RestoreVideoInput,
} from "#src/modules/studio/video-content-reports.schemas.js";
import {
  enqueueNotifications,
  type NotificationInput,
} from "#src/modules/platform/notifications/notifications.service.js";
import type { Result } from "#src/types/index.js";

/**
 * Video content reporting and the moderation queue behind it.
 *
 * ═══ THE CAPABILITY CHECK IS THE FIRST STATEMENT OF EVERY STAFF FUNCTION ═══
 *
 * Not middleware, and not the controller. Middleware cannot return a `Result`, so it could
 * not take part in the controller's exhaustive error switch — it would have to write a
 * response or throw, putting an authorization decision outside the one place that maps
 * domain errors to statuses. `content-review.service.ts` records the same reasoning for the
 * anime queue, and `platform-role.service.ts` states it as the reason
 * `requirePlatformCapability` is a service at all.
 *
 * AND IT RUNS BEFORE ANY ID IS READ. Reversed, every one of these routes is an id oracle for
 * anyone holding a session: a 404-vs-403 difference tells a stranger which video ids exist.
 * Checked first, a non-staff caller gets an identical 403 for a real id and a garbage one.
 *
 * ═══ NO AUTOMATIC HIDE ═══
 *
 * Commerce hides a review at three distinct reporters, counted inside the insert's own
 * transaction, and never does that to a product — "delisting a seller's listing is a
 * commercial action against their livelihood and requires a human to take it". A video is a
 * creator's livelihood by the same argument, so there is no threshold here at all.
 *
 * That absence is what makes this module shorter than the commerce one rather than a copy of
 * it: no distinct-reporter count, no `action_source`, no nullable moderator, and every action
 * row carries an audit-chain entry because every action has a human behind it.
 */

export type VideoContentReportError =
  | { readonly type: "VIDEO_REPORT_NOT_FOUND" }
  | { readonly type: "ALREADY_REPORTED" }
  | { readonly type: "REPORT_ALREADY_RESOLVED" }
  | { readonly type: "SELF_REPORT_FORBIDDEN" }
  | { readonly type: "MODERATOR_IS_CREATOR" }
  | { readonly type: "VIDEO_ALREADY_VISIBLE" }
  | { readonly type: "INVALID_CURSOR" }
  | {
      readonly type: "PLATFORM_CAPABILITY_REQUIRED";
      readonly capability: "moderate_content";
    };

export interface VideoReportRow {
  readonly id: string;
  readonly videoId: string;
  readonly videoTitle: string | null;
  readonly creatorId: string | null;
  readonly creatorName: string | null;
  readonly reason: string;
  readonly detailText: string | null;
  readonly reporterUserId: string | null;
  readonly status: "open" | "actioned" | "dismissed";
  readonly resolvedAt: Date | null;
  readonly resolutionNote: string | null;
  readonly createdAt: Date;
  /** How many OPEN reports this video carries in total. Context, never a threshold. */
  readonly openReportCount: number;
  readonly moderationVisibilityState: "visible" | "hidden_by_moderator";
}

export interface VideoReportPage {
  readonly rows: readonly VideoReportRow[];
  readonly nextCursor: string | null;
}

/** What the reporter sees on `/report-history` — no moderator identity, ever. */
export interface MyVideoReportRow {
  readonly id: string;
  readonly videoId: string;
  readonly videoTitle: string | null;
  readonly reason: string;
  readonly detailText: string | null;
  readonly status: "open" | "actioned" | "dismissed";
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
  /**
   * The moderator's message to THIS reporter, or `null` when they wrote none.
   *
   * ⚠️ THIS IS `video_content_report.resolutionNote` AND IT IS NOT
   * `videoModerationAction.reasonNote`. The two look interchangeable and are opposites:
   * `reasonNote` is the staff record, hash-chained into the audit entry, and may name other
   * reporters or a commercial motive behind a claim. It must never be selected here. A
   * moderator who writes nothing sends a bare outcome, which is the honest default — a
   * template pretending to be a considered reply is worse than silence.
   */
  readonly resolutionNote: string | null;
  /**
   * What was actually done, which the bare `status` cannot say.
   *
   * `redirected_to_source` and `report_dismissed` BOTH close the report as `dismissed` — no
   * content action was taken in either case — but they mean opposite things to the person who
   * filed it. One is "we looked, the claim does not hold"; the other is "the claim may well
   * hold and Qatoto is not who can act on it, because the bytes are on youtube.com". Rendering
   * the status alone files every redirect as a rejection.
   *
   * `null` while the report is open, and also on rows decided before this column was joined.
   */
  readonly outcomeKind:
    | "content_hidden"
    | "content_restored"
    | "report_dismissed"
    | "redirected_to_source"
    | null;
}

/**
 * `moderate_content`, NOT a new capability.
 *
 * It already exists, is held by `moderator` and `admin`, and is described in
 * `platform-role.service.ts` as being about "DECIDING user-submitted content — approve this
 * video, hide that post", which is exactly this. `community-forum.service.ts` set the
 * precedent for reusing rather than minting: "minting a capability for one surface is how a
 * permission model stops being readable."
 *
 * Returns `PlatformStaffContext` because the caller needs `platformRole` for the snapshot
 * every action row and audit entry carries.
 */
async function requireVideoModerator(
  userId: string,
): Promise<Result<PlatformStaffContext, VideoContentReportError>> {
  const capability = await requirePlatformCapability(userId, "moderate_content");
  if (!capability.success) {
    return {
      success: false,
      error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_content" },
    };
  }
  return { success: true, value: capability.value };
}

/*
 * KEYSET, NOT OFFSET, and the cursor is opaque.
 *
 * A moderation queue is worked from the front while new reports arrive at the back, so an
 * offset silently repeats and skips rows as the list shifts under the reader. The sort key
 * is `(createdAt, id)` — `createdAt` alone is not unique, and a keyset over a non-unique
 * column drops rows that share a timestamp.
 */
const CURSOR_SEPARATOR = "|";

function encodeQueueCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}${CURSOR_SEPARATOR}${id}`, "utf8").toString(
    "base64url",
  );
}

function decodeQueueCursor(cursor: string): { createdAt: Date; id: string } | null {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const separatorIndex = decoded.indexOf(CURSOR_SEPARATOR);
  if (separatorIndex <= 0) return null;
  const timestampText = decoded.slice(0, separatorIndex);
  const id = decoded.slice(separatorIndex + 1);
  if (id.length === 0) return null;
  const createdAt = new Date(timestampText);
  if (Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id };
}

/**
 * Files a report.
 *
 * GATED ON `findPublicVideo`, so a private, unpublished or non-existent id is one
 * indistinguishable 404 rather than a stored row pointing at something nobody can see. It
 * also means a video ALREADY HIDDEN cannot be reported again — `PUBLICLY_SERVABLE` now
 * carries the visibility term — which is correct: there is nothing left to ask for.
 *
 * THE SELF-REPORT GUARD IS A PLAIN USER-ID COMPARISON. Commerce resolves the reporter's
 * active organization here and compares organizations, because its targets belong to
 * sellers; a video belongs to a person. That whole block collapses to one `===`.
 *
 * `onConflictDoNothing` AGAINST THE PARTIAL UNIQUE INDEX rather than a membership check:
 * one report per person per video, decided by the database, so two concurrent submissions
 * cannot both pass a check-then-insert. An empty `returning()` is the duplicate.
 */
export async function createVideoReport(
  reporterUserId: string,
  videoId: string,
  input: ReportVideoInput,
): Promise<Result<{ readonly reportId: string }, VideoContentReportError>> {
  const publicVideo = await findPublicVideo(db, videoId);
  if (publicVideo === null) {
    return { success: false, error: { type: "VIDEO_REPORT_NOT_FOUND" } };
  }

  if (publicVideo.creatorId === reporterUserId) {
    return { success: false, error: { type: "SELF_REPORT_FORBIDDEN" } };
  }

  const inserted = await db
    .insert(videoContentReport)
    .values({
      videoId,
      reporterUserId,
      reason: input.reason,
      ...(input.detailText === undefined ? {} : { detailText: input.detailText }),
    })
    .onConflictDoNothing()
    .returning({ id: videoContentReport.id });

  const reportId = inserted[0]?.id;
  if (reportId === undefined) {
    return { success: false, error: { type: "ALREADY_REPORTED" } };
  }

  return { success: true, value: { reportId } };
}

/**
 * The staff queue.
 *
 * CAPABILITY BEFORE ANY ID IS READ — including before the cursor is decoded, so a non-staff
 * caller cannot learn whether their cursor was well formed.
 */
export async function listVideoReports(
  moderatorUserId: string,
  query: ListVideoReportsQuery,
): Promise<Result<VideoReportPage, VideoContentReportError>> {
  const moderator = await requireVideoModerator(moderatorUserId);
  if (!moderator.success) return { success: false, error: moderator.error };

  const filters: SQL[] = [];
  if (query.status !== undefined) {
    filters.push(eq(videoContentReport.status, query.status));
  }
  if (query.cursor !== undefined) {
    const decodedCursor = decodeQueueCursor(query.cursor);
    if (decodedCursor === null) {
      return { success: false, error: { type: "INVALID_CURSOR" } };
    }
    // Strictly after (createdAt, id), which is why the tiebreak is in the key at all.
    const keyset = or(
      gt(videoContentReport.createdAt, decodedCursor.createdAt),
      and(
        eq(videoContentReport.createdAt, decodedCursor.createdAt),
        gt(videoContentReport.id, decodedCursor.id),
      ),
    );
    if (keyset) filters.push(keyset);
  }

  const rows = await db
    .select({
      id: videoContentReport.id,
      videoId: videoContentReport.videoId,
      videoTitle: video.title,
      creatorId: video.creatorId,
      creatorName: user.name,
      reason: videoContentReport.reason,
      detailText: videoContentReport.detailText,
      reporterUserId: videoContentReport.reporterUserId,
      status: videoContentReport.status,
      resolvedAt: videoContentReport.resolvedAt,
      resolutionNote: videoContentReport.resolutionNote,
      createdAt: videoContentReport.createdAt,
      moderationVisibilityState: video.moderationVisibilityState,
      // Context for the reviewer — "this is the fourth person to flag it" changes how a
      // borderline case reads. It is NOT a threshold: nothing acts on this number.
      openReportCount: sql<number>`(
        SELECT count(*)::int FROM ${videoContentReport} AS sibling
        WHERE sibling.video_id = ${videoContentReport.videoId} AND sibling.status = 'open'
      )`,
    })
    .from(videoContentReport)
    // INNER JOIN is safe: `video_id` is NOT NULL with a cascade, so a report whose video is
    // gone is gone too. The action log is the table that outlives its subject.
    .innerJoin(video, eq(video.id, videoContentReport.videoId))
    .innerJoin(user, eq(user.id, video.creatorId))
    .where(filters.length === 0 ? undefined : and(...filters))
    .orderBy(asc(videoContentReport.createdAt), asc(videoContentReport.id))
    .limit(query.limit + 1);

  // Fetch one extra to know whether there is a next page, without a second COUNT.
  const hasMore = rows.length > query.limit;
  const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
  const lastRow = pageRows.at(-1);

  return {
    success: true,
    value: {
      rows: pageRows,
      nextCursor:
        hasMore && lastRow !== undefined ? encodeQueueCursor(lastRow.createdAt, lastRow.id) : null,
    },
  };
}

/**
 * Decides a report: `actioned` hides the video, `dismissed` leaves it alone.
 *
 * ACTIONING CLOSES EVERY OPEN REPORT ON THAT VIDEO, not just the one clicked — the precedent
 * research-program and commerce moderation both set. Leaving siblings open means the next
 * reviewer re-decides a settled case and the queue never drains.
 *
 * DISMISSING DOES NOT RESTORE ANYTHING, and this is where the fork diverges from commerce
 * most sharply. There, dismissal must un-hide, because a threshold could have hidden the
 * content with no human involved and three griefers would otherwise silence it permanently.
 * Here nothing hides a video except a moderator deciding to, so a dismissal has nothing to
 * undo — and quietly restoring a video a DIFFERENT moderator hid would overturn their
 * decision as a side effect of closing an unrelated report. `restoreVideo` is the route that
 * reverses a hide, deliberately and by itself.
 *
 * THE CAPABILITY CHECK IS OUTSIDE THE TRANSACTION, and its result is carried in: the role
 * snapshot must be the role at decision time, and re-reading it inside would be a second
 * query for a value already in hand.
 */
export async function decideVideoReport(
  moderatorUserId: string,
  reportId: string,
  input: DecideVideoReportInput,
): Promise<Result<{ readonly reportId: string }, VideoContentReportError>> {
  const moderator = await requireVideoModerator(moderatorUserId);
  if (!moderator.success) return { success: false, error: moderator.error };
  const moderatorRoleSnapshot = moderator.value.platformRole;

  const shouldHide = input.decision === "actioned";
  /**
   * ⚠️ `redirected_to_source` CLOSES THE REPORT AS `dismissed`. No content action was taken, and a
   * fourth report status would ripple through `video_content_report_resolution_ck` and every queue
   * filter for nothing. The ACTION KIND below carries the distinction, and it is the action kind
   * the reporter's page renders — not this status.
   */
  const reportStatus = input.decision === "actioned" ? "actioned" : ("dismissed" as const);
  const actionKind =
    input.decision === "actioned"
      ? ("content_hidden" as const)
      : input.decision === "redirected_to_source"
        ? ("redirected_to_source" as const)
        : ("report_dismissed" as const);
  const occurredAt = new Date();

  const outcome = await db.transaction(async (transaction) => {
    // FOR UPDATE so two moderators cannot decide the same report at once and write two
    // audit entries for one decision.
    const [report] = await transaction
      .select({
        id: videoContentReport.id,
        videoId: videoContentReport.videoId,
        status: videoContentReport.status,
      })
      .from(videoContentReport)
      .where(eq(videoContentReport.id, reportId))
      .for("update")
      .limit(1);

    if (!report) return { kind: "missing" } as const;
    if (report.status !== "open") return { kind: "already_resolved" } as const;

    const [targetVideo] = await transaction
      .select({ id: video.id, creatorId: video.creatorId, title: video.title })
      .from(video)
      .where(eq(video.id, report.videoId))
      .limit(1);

    if (!targetVideo) return { kind: "missing" } as const;

    // A PARTY TO THE CONTENT CANNOT RULE ON IT. Commerce refuses a moderator who belongs to
    // the reported organization; the video equivalent is the creator themselves.
    if (targetVideo.creatorId === moderatorUserId) {
      return { kind: "moderator_is_creator" } as const;
    }

    if (shouldHide) {
      await transaction
        .update(video)
        .set({ moderationVisibilityState: "hidden_by_moderator" })
        .where(eq(video.id, targetVideo.id));
    }

    // CAPTURED BEFORE THE UPDATE, because the update below closes exactly these rows and there is
    // no clean way to ask afterwards which ones it touched. Every open report on the video is
    // closed, not only `reportId`, so every one of their authors is owed an answer.
    const openReporterRows = await transaction
      .select({ reporterUserId: videoContentReport.reporterUserId })
      .from(videoContentReport)
      .where(
        and(eq(videoContentReport.videoId, targetVideo.id), eq(videoContentReport.status, "open")),
      );

    // Every open report on the video, not only `reportId`.
    await transaction
      .update(videoContentReport)
      .set({
        status: reportStatus,
        resolvedByUserId: moderatorUserId,
        resolvedAt: sql`now()`,
        // ⚠️ `reporterNote`, NOT `note`. This column is PUBLISHED to whoever filed the report, and
        // it used to be fed from the same value as the staff audit note below — so the first read
        // that surfaced it would have published every internal note ever written. Two inputs now,
        // because one field cannot be both an internal record and a message somebody reads.
        ...(input.reporterNote === undefined ? {} : { resolutionNote: input.reporterNote }),
      })
      .where(
        and(eq(videoContentReport.videoId, targetVideo.id), eq(videoContentReport.status, "open")),
      );

    const auditEntry = await appendPlatformAuditEntry(transaction, {
      eventKind: shouldHide ? "video_content_hidden" : "video_content_report_dismissed",
      actorUserId: moderatorUserId,
      actorRoleSnapshot: moderatorRoleSnapshot,
      actionLabel: shouldHide ? "video_content_hidden" : "video_content_report_dismissed",
      targetLabel: `video:${targetVideo.id}`,
      ...(input.note === undefined ? {} : { detailNote: input.note }),
      payload: { videoId: targetVideo.id, reportId: report.id },
      occurredAt,
    });

    await transaction.insert(videoModerationAction).values({
      actionKind,
      videoId: targetVideo.id,
      reportId: report.id,
      moderatorUserId,
      moderatorRoleSnapshot,
      // NOT NULL on the column, so a decision with no stated reason is refused at rest.
      // The schema requires it; this is where the requirement is honoured.
      // STAFF-ONLY, and never `reporterNote`. NOT NULL on the column, so a decision with no stated
      // reason is refused at rest; the schema requires it and this is where that is honoured.
      reasonNote:
        input.note ??
        (shouldHide
          ? "Hidden after review."
          : actionKind === "redirected_to_source"
            ? "Closed: the host platform owns this content."
            : "Report dismissed."),
      auditEntryId: auditEntry.id,
    });

    /**
     * ⚠️ ENQUEUED INSIDE THIS TRANSACTION, per the house rule that the notification row is written
     * in the caller's transaction. An enqueue after the commit can be lost, which here means a
     * decision nobody is ever told about — the exact gap this whole change exists to close.
     *
     * ## Who is told, and who is not
     *
     * **Every reporter on this video** gets `video_report_decided`. The update above closes EVERY
     * open report on the video, not just `reportId`, so notifying only the one report's author
     * would leave the others closed and unanswered.
     *
     * **The creator** gets `video_content_actioned` ONLY when their content actually moved.
     *
     * ⚠️ NOT ON A DISMISSAL OR A REDIRECT. Nothing happened to their video, and "you were reported
     * and we let it go" hands somebody a grievance plus a very small suspect pool — the same
     * retaliation risk that keeps reporter identity hidden from moderators in the first place.
     *
     * ## What the payload may not carry
     *
     * No reporter identity, no moderator identity, and **never `input.note`** — the staff note.
     * `reporterNote` is the only free text that may travel, because it is the only one written to
     * be read. The actor is passed as the moderator so `enqueueNotifications` suppresses a
     * self-notification if a moderator ever reports something themselves.
     */
    const notificationInputs: NotificationInput[] = [];
    // DEDUPED: one person cannot file twice on a video (`ALREADY_REPORTED`), but an anonymized
    // reporter is a NULL and several of those must not become several notifications to nobody.
    const notifiedReporterIds = new Set<string>();
    for (const reporterRow of openReporterRows) {
      if (reporterRow.reporterUserId === null) continue;
      if (notifiedReporterIds.has(reporterRow.reporterUserId)) continue;
      notifiedReporterIds.add(reporterRow.reporterUserId);
      notificationInputs.push({
        recipientUserId: reporterRow.reporterUserId,
        kind: "video_report_decided",
        // UNATTRIBUTED, and not an oversight: `null` overrides the moderator passed as the
        // actor below. A moderator whose verdicts carry their name is a moderator who can be
        // lobbied — the same rule the R&D verdict kinds state, and the reason a reporter sees
        // "Qatoto reviewed this" rather than a person to argue with.
        actorUserId: null,
        payload: {
          videoId: targetVideo.id,
          outcome: actionKind,
          ...(input.reporterNote === undefined ? {} : { reporterNote: input.reporterNote }),
        },
      });
    }

    if (actionKind === "content_hidden") {
      notificationInputs.push({
        recipientUserId: targetVideo.creatorId,
        kind: "video_content_actioned",
        // Unattributed for the same reason as above, and one more that is sharper here: this
        // is the notification that goes to the person who was acted AGAINST.
        actorUserId: null,
        payload: { videoId: targetVideo.id, outcome: actionKind },
      });
    }

    await enqueueNotifications(transaction, moderatorUserId, notificationInputs);

    return { kind: "decided", reportId: report.id } as const;
  });

  switch (outcome.kind) {
    case "missing":
      return { success: false, error: { type: "VIDEO_REPORT_NOT_FOUND" } };
    case "already_resolved":
      return { success: false, error: { type: "REPORT_ALREADY_RESOLVED" } };
    case "moderator_is_creator":
      return { success: false, error: { type: "MODERATOR_IS_CREATOR" } };
    case "decided":
      return { success: true, value: { reportId: outcome.reportId } };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`decideVideoReport: unhandled outcome ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * Puts a hidden video back.
 *
 * ITS OWN ROUTE RATHER THAN A DISMISSAL, and the reason is a state a dismissal cannot reach:
 * a video is hidden, its reports are all actioned and closed, and a later reconsideration
 * has nothing left to act on. Without this the video is hidden forever — commerce hit
 * exactly this and built the same escape hatch.
 *
 * `reasonNote` IS REQUIRED HERE, unlike a decision note. An un-hide with no stated reason is
 * not a record: the hide named a human and gave a reason, and reversing it silently would
 * leave the audit log showing a takedown and no account of why it ended.
 *
 * TOUCHES NO REPORT ROWS. The reports were decided; that history stands. Restoring the video
 * is a new decision, not a retraction of the old one.
 */
export async function restoreVideo(
  moderatorUserId: string,
  input: RestoreVideoInput,
): Promise<Result<{ readonly videoId: string }, VideoContentReportError>> {
  const moderator = await requireVideoModerator(moderatorUserId);
  if (!moderator.success) return { success: false, error: moderator.error };
  const moderatorRoleSnapshot = moderator.value.platformRole;

  const occurredAt = new Date();

  const outcome = await db.transaction(async (transaction) => {
    const [targetVideo] = await transaction
      .select({
        id: video.id,
        creatorId: video.creatorId,
        moderationVisibilityState: video.moderationVisibilityState,
      })
      .from(video)
      .where(eq(video.id, input.videoId))
      .for("update")
      .limit(1);

    if (!targetVideo) return { kind: "missing" } as const;

    // Refused rather than treated as a no-op: "restore" on a visible video means the
    // moderator is looking at a stale queue, and a silent 200 would confirm an action that
    // never needed taking while writing an audit entry describing one.
    if (targetVideo.moderationVisibilityState === "visible") {
      return { kind: "already_visible" } as const;
    }
    if (targetVideo.creatorId === moderatorUserId) {
      return { kind: "moderator_is_creator" } as const;
    }

    await transaction
      .update(video)
      .set({ moderationVisibilityState: "visible" })
      .where(eq(video.id, targetVideo.id));

    const auditEntry = await appendPlatformAuditEntry(transaction, {
      eventKind: "video_content_restored",
      actorUserId: moderatorUserId,
      actorRoleSnapshot: moderatorRoleSnapshot,
      actionLabel: "video_content_restored",
      targetLabel: `video:${targetVideo.id}`,
      detailNote: input.reasonNote,
      payload: { videoId: targetVideo.id },
      occurredAt,
    });

    await transaction.insert(videoModerationAction).values({
      actionKind: "content_restored",
      videoId: targetVideo.id,
      moderatorUserId,
      moderatorRoleSnapshot,
      reasonNote: input.reasonNote,
      auditEntryId: auditEntry.id,
    });

    return { kind: "restored", videoId: targetVideo.id } as const;
  });

  switch (outcome.kind) {
    case "missing":
      return { success: false, error: { type: "VIDEO_REPORT_NOT_FOUND" } };
    case "already_visible":
      return { success: false, error: { type: "VIDEO_ALREADY_VISIBLE" } };
    case "moderator_is_creator":
      return { success: false, error: { type: "MODERATOR_IS_CREATOR" } };
    case "restored":
      return { success: true, value: { videoId: outcome.videoId } };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`restoreVideo: unhandled outcome ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * The reporter's own reports — `GET /users/me/video-reports`, behind `/report-history`.
 *
 * NO CAPABILITY CHECK AND NO ERROR ARM. It is scoped to `reporterUserId` and answers an
 * empty list to someone who has reported nothing, which is the honest answer rather than a
 * 404 — there is no resource here that can fail to exist.
 *
 * NO PRECEDENT: commerce, community and R&D all lack a reporter-side read. What that means
 * in practice is that nobody has decided before what a reporter may see, so this projection
 * is deliberately narrow — the moderator's identity, their note and the sibling reports are
 * ALL ABSENT. A reporter learns that their report was actioned or dismissed, and nothing
 * about who decided or who else complained. Disclosing the moderator would make a takedown
 * personal; disclosing the count would make brigading measurable.
 *
 * UNPAGINATED, LIKE THE MUTED-CREATORS LIST. Bounded by how many videos one person reported
 * by hand, capped below so a pathological account cannot make this an unbounded read.
 */
const MY_REPORTS_LIMIT = 200;

export async function listMyVideoReports(
  reporterUserId: string,
): Promise<readonly MyVideoReportRow[]> {
  const rows = await db
    .select({
      id: videoContentReport.id,
      videoId: videoContentReport.videoId,
      videoTitle: video.title,
      reason: videoContentReport.reason,
      detailText: videoContentReport.detailText,
      status: videoContentReport.status,
      createdAt: videoContentReport.createdAt,
      resolvedAt: videoContentReport.resolvedAt,
      resolutionNote: videoContentReport.resolutionNote,
      outcomeKind: videoModerationAction.actionKind,
    })
    .from(videoContentReport)
    .innerJoin(video, eq(video.id, videoContentReport.videoId))
    // LEFT, and joined on `reportId` rather than `videoId`: an open report has no action at
    // all, and joining on the video would hand this reporter the outcome of somebody else's
    // report on the same video.
    .leftJoin(videoModerationAction, eq(videoModerationAction.reportId, videoContentReport.id))
    .where(eq(videoContentReport.reporterUserId, reporterUserId))
    .orderBy(desc(videoContentReport.createdAt))
    .limit(MY_REPORTS_LIMIT);

  return rows;
}

/** How many reports are waiting, for the admin console's queue badge. */
export async function countOpenVideoReports(
  moderatorUserId: string,
): Promise<Result<{ readonly openCount: number }, VideoContentReportError>> {
  const moderator = await requireVideoModerator(moderatorUserId);
  if (!moderator.success) return { success: false, error: moderator.error };

  const [row] = await db
    .select({ value: count() })
    .from(videoContentReport)
    .where(eq(videoContentReport.status, "open"));

  return { success: true, value: { openCount: row?.value ?? 0 } };
}
