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

    // Every open report on the video, not only `reportId`.
    await transaction
      .update(videoContentReport)
      .set({
        status: input.decision,
        resolvedByUserId: moderatorUserId,
        resolvedAt: sql`now()`,
        ...(input.note === undefined ? {} : { resolutionNote: input.note }),
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
      actionKind: shouldHide ? "content_hidden" : "report_dismissed",
      videoId: targetVideo.id,
      reportId: report.id,
      moderatorUserId,
      moderatorRoleSnapshot,
      // NOT NULL on the column, so a decision with no stated reason is refused at rest.
      // The schema requires it; this is where the requirement is honoured.
      reasonNote: input.note ?? (shouldHide ? "Hidden after review." : "Report dismissed."),
      auditEntryId: auditEntry.id,
    });

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
    })
    .from(videoContentReport)
    .innerJoin(video, eq(video.id, videoContentReport.videoId))
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
