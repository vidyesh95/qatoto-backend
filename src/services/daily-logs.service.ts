import { and, asc, desc, eq, sql } from "drizzle-orm";
import { fromDrizzle } from "pg-boss";

import { config } from "#src/config/index.js";
import { db } from "#src/db/index.js";
import {
  dailyLog,
  dailyLogAiSummaryChip,
  dailyLogEvidenceLink,
  dailyLogExtractedClaim,
  dailyLogTranscriptSegment,
  projectStats,
  user,
  projectMember,
} from "#src/db/schema.js";
import { streakAfterLog, type IsoDate } from "#src/lib/daily-log-streak.js";
import { idempotencyKeyFor, JOB_NAMES, sendJob } from "#src/lib/jobs.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import {
  buildYoutubeEmbedUrl,
  extractYoutubeVideoId,
  verifyYoutubeVideo,
  type FetchImplementation,
  type YoutubeSourceError,
} from "#src/lib/youtube.js";
import type { ProjectAccessError } from "#src/services/project-membership.service.js";
import type { Result } from "#src/types/index.js";

/**
 * Daily logs (R_AND_D_BACKEND_STRUCTURE.md §8, §11d).
 *
 * A daily log is the input to the entire equity ledger, so three rules govern this file:
 *
 *  1. A SUBMITTED LOG IS FROZEN. Edits and deletes are refused once `status = 'submitted'`
 *     — at that point the row is effort evidence, and evidence that its author can still
 *     rewrite is not evidence. Corrections are a new log, never an edit.
 *
 *  2. NOTHING HERE PRODUCES A VERDICT. `effortVerificationStatus` belongs to §9 and is
 *     written by nothing in this file. Submit returns 202 and an `analysisStatus`, never
 *     an outcome — the UI must render "queued", not "verified".
 *
 *  3. THE VIDEO IS OPTIONAL, AND ITS FACTS ARE SERVER-DERIVED. A member sends a URL; the
 *     server parses it to an 11-character id, proves it with one oEmbed call, and stores
 *     THE ID. `videoSource`, `youtubeVideoId`, `youtubeThumbnailUrl` and `videoVerifiedAt`
 *     appear in no request body — `.strict()` refuses them (§0).
 */

export type DailyLogError =
  | ProjectAccessError
  | YoutubeSourceError
  | { type: "DAILY_LOG_NOT_FOUND"; logId: string }
  | { type: "DAILY_LOG_ALREADY_EXISTS"; logDate: string }
  | { type: "DAILY_LOG_ALREADY_SUBMITTED" }
  | { type: "DAILY_LOG_EMPTY" }
  | { type: "NOT_THE_AUTHOR" }
  | { type: "LOG_DATE_IN_FUTURE"; logDate: string };

export type DailyLogAnalysisStatus = (typeof dailyLog.$inferSelect)["analysisStatus"];
export type EffortVerificationStatus = (typeof dailyLog.$inferSelect)["effortVerificationStatus"];

export interface DailyLogView {
  readonly id: string;
  readonly authorMemberId: string;
  readonly authorName: string;
  readonly authorAvatarImageUrl: string | null;
  /** The day CLAIMED, date-only. Distinct from `submittedAt` and never collapsed (§8). */
  readonly logDate: string;
  readonly submittedAt: Date | null;
  readonly narrative: string | null;
  readonly status: (typeof dailyLog.$inferSelect)["status"];
  readonly videoSource: (typeof dailyLog.$inferSelect)["videoSource"];
  /** Rebuilt server-side from the stored id; a client string never becomes an iframe src. */
  readonly videoEmbedUrl: string | null;
  readonly videoThumbnailUrl: string | null;
  readonly analysisStatus: DailyLogAnalysisStatus;
  readonly analysisFailureReason: string | null;
  readonly analysisCompletedAt: Date | null;
  /**
   * §9's column, always `not_run` in this phase.
   *
   * `isEffortVerified` is DERIVED from it for the frontend's boolean, and is deliberately
   * not stored: storing both permits the contradictory pair (§8).
   */
  readonly effortVerificationStatus: EffortVerificationStatus;
  readonly isEffortVerified: boolean;
  readonly createdAt: Date;
}

export interface DailyLogDetailView extends DailyLogView {
  readonly transcriptSegments: readonly {
    readonly sequenceNumber: number;
    readonly startOffsetSeconds: number;
    readonly endOffsetSeconds: number | null;
    readonly speakerLabel: string | null;
    readonly segmentText: string;
  }[];
  readonly aiSummaryChips: readonly {
    readonly kind: (typeof dailyLogAiSummaryChip.$inferSelect)["kind"];
    readonly label: string;
    readonly confidenceBps: number | null;
  }[];
  readonly extractedClaims: readonly {
    readonly claimKind: (typeof dailyLogExtractedClaim.$inferSelect)["claimKind"];
    /** What the member SAID (§9.6). Not grounded, not paid on, not equity. */
    readonly extractedMinutes: number | null;
    readonly extractedCashInCents: string | null;
    readonly claimSummary: string;
    readonly confidenceBps: number | null;
  }[];
  readonly evidenceLinks: readonly {
    readonly provider: (typeof dailyLogEvidenceLink.$inferSelect)["provider"];
    readonly sourceKind: (typeof dailyLogEvidenceLink.$inferSelect)["sourceKind"];
    readonly externalUrl: string;
    readonly externalHost: string;
  }[];
  /** The provenance every AI-produced row above carries (§9.1). */
  readonly analysisModelName: string | null;
  readonly analysisModelVersion: string | null;
  readonly analysisPromptVersion: string | null;
}

export interface CreateDailyLogInput {
  readonly logDate: IsoDate;
  readonly narrative?: string | undefined;
  /** The member's pasted link. Parsed and verified here; never stored as sent. */
  readonly youtubeUrl?: string | undefined;
}

export type UpdateDailyLogInput = Partial<CreateDailyLogInput> & {
  /** Explicit null detaches the video and returns the log to `videoSource = 'none'`. */
  readonly youtubeUrl?: string | null | undefined;
};

interface VerifiedVideo {
  readonly youtubeVideoId: string;
  readonly thumbnailUrl: string | null;
}

/**
 * Parses and PROVES a pasted link before any row is written.
 *
 * Reused verbatim from the studio path (src/services/videos.service.ts): parse to an id
 * against the hostname allowlist, then one free oEmbed call that proves the video exists,
 * is public enough to embed, and is not deleted. The 422/502 split is load-bearing — the
 * first means the member must fix their link, the second means YouTube did not answer.
 */
async function parseAndVerifyYoutubeUrl(
  rawYoutubeUrl: string,
  fetchImplementation?: FetchImplementation,
): Promise<Result<VerifiedVideo, YoutubeSourceError>> {
  const youtubeVideoId = extractYoutubeVideoId(rawYoutubeUrl);
  if (!youtubeVideoId) {
    return { success: false, error: { type: "INVALID_YOUTUBE_URL" } };
  }

  const verified = await verifyYoutubeVideo(youtubeVideoId, {
    timeoutMs: config.YOUTUBE_OEMBED_TIMEOUT_MS,
    ...(fetchImplementation === undefined ? {} : { fetchImplementation }),
  });
  if (!verified.success) {
    return { success: false, error: verified.error };
  }

  return {
    success: true,
    value: { youtubeVideoId, thumbnailUrl: verified.value.thumbnailUrl },
  };
}

function toLogView(row: {
  readonly log: typeof dailyLog.$inferSelect;
  readonly authorName: string;
  readonly authorAvatarImageUrl: string | null;
}): DailyLogView {
  return {
    id: row.log.id,
    authorMemberId: row.log.authorMemberId,
    authorName: row.authorName,
    authorAvatarImageUrl: row.authorAvatarImageUrl,
    logDate: row.log.logDate,
    submittedAt: row.log.submittedAt,
    narrative: row.log.narrative,
    status: row.log.status,
    videoSource: row.log.videoSource,
    videoEmbedUrl:
      row.log.youtubeVideoId === null ? null : buildYoutubeEmbedUrl(row.log.youtubeVideoId),
    videoThumbnailUrl: row.log.youtubeThumbnailUrl,
    analysisStatus: row.log.analysisStatus,
    analysisFailureReason: row.log.analysisFailureReason,
    analysisCompletedAt: row.log.analysisCompletedAt,
    effortVerificationStatus: row.log.effortVerificationStatus,
    // Derived, never stored — the frontend's `isEffortVerified: boolean` (§8, §15).
    isEffortVerified: row.log.effortVerificationStatus === "verified",
    createdAt: row.log.createdAt,
  };
}

/** The project's log feed, newest claimed day first. */
export async function listDailyLogs(
  projectId: string,
  options: { readonly limit?: number | undefined } = {},
): Promise<readonly DailyLogView[]> {
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);

  const rows = await db
    .select({ log: dailyLog, authorName: user.name, authorAvatarImageUrl: user.image })
    .from(dailyLog)
    .innerJoin(projectMember, eq(projectMember.id, dailyLog.authorMemberId))
    // Name and avatar JOIN from `user` — a copy drifts the moment someone changes their
    // photo (§5).
    .innerJoin(user, eq(user.id, projectMember.userId))
    .where(eq(dailyLog.projectId, projectId))
    // Ends in a unique column (§4c rule 4): several members log the same day.
    .orderBy(desc(dailyLog.logDate), desc(dailyLog.id))
    .limit(limit);

  return rows.map(toLogView);
}

/** One log with everything the analysis produced, in stable order. */
export async function findDailyLogDetail(
  projectId: string,
  logId: string,
): Promise<DailyLogDetailView | null> {
  const [row] = await db
    .select({ log: dailyLog, authorName: user.name, authorAvatarImageUrl: user.image })
    .from(dailyLog)
    .innerJoin(projectMember, eq(projectMember.id, dailyLog.authorMemberId))
    .innerJoin(user, eq(user.id, projectMember.userId))
    .where(and(eq(dailyLog.id, logId), eq(dailyLog.projectId, projectId)));

  if (!row) {
    return null;
  }

  const [segments, chips, claims, evidence] = await Promise.all([
    db
      .select()
      .from(dailyLogTranscriptSegment)
      .where(eq(dailyLogTranscriptSegment.dailyLogId, logId))
      .orderBy(asc(dailyLogTranscriptSegment.sequenceNumber)),
    db
      .select()
      .from(dailyLogAiSummaryChip)
      .where(eq(dailyLogAiSummaryChip.dailyLogId, logId))
      .orderBy(asc(dailyLogAiSummaryChip.sequenceNumber)),
    db
      .select()
      .from(dailyLogExtractedClaim)
      .where(eq(dailyLogExtractedClaim.dailyLogId, logId))
      .orderBy(asc(dailyLogExtractedClaim.sequenceNumber)),
    db
      .select()
      .from(dailyLogEvidenceLink)
      .where(eq(dailyLogEvidenceLink.dailyLogId, logId))
      .orderBy(asc(dailyLogEvidenceLink.externalUrl)),
  ]);

  return {
    ...toLogView(row),
    transcriptSegments: segments.map((segment) => ({
      sequenceNumber: segment.sequenceNumber,
      startOffsetSeconds: segment.startOffsetSeconds,
      endOffsetSeconds: segment.endOffsetSeconds,
      speakerLabel: segment.speakerLabel,
      segmentText: segment.segmentText,
    })),
    aiSummaryChips: chips.map((chip) => ({
      kind: chip.kind,
      label: chip.label,
      confidenceBps: chip.confidenceBps,
    })),
    extractedClaims: claims.map((claim) => ({
      claimKind: claim.claimKind,
      extractedMinutes: claim.extractedMinutes,
      // bigint → decimal string on the wire: JSON has no integer type wide enough, and
      // §4b forbids a cents value that a client could round (§1).
      extractedCashInCents:
        claim.extractedCashInCents === null ? null : claim.extractedCashInCents.toString(),
      claimSummary: claim.claimSummary,
      confidenceBps: claim.confidenceBps,
    })),
    evidenceLinks: evidence.map((link) => ({
      provider: link.provider,
      sourceKind: link.sourceKind,
      externalUrl: link.externalUrl,
      externalHost: link.externalHost,
    })),
    analysisModelName: row.log.analysisModelName,
    analysisModelVersion: row.log.analysisModelVersion,
    analysisPromptVersion: row.log.analysisPromptVersion,
  };
}

/**
 * Creates a DRAFT log.
 *
 * `logDate` may be back-dated (filing Monday's work on Tuesday is ordinary) but never
 * FUTURE-dated: a log for a day that has not happened is not a record of work, and §9
 * would price it. The bound is generous by a day because the project's own zone may be
 * ahead of the server's UTC.
 */
export async function createDailyLog(
  projectId: string,
  authorMemberId: string,
  input: CreateDailyLogInput,
  fetchImplementation?: FetchImplementation,
): Promise<Result<DailyLogView, DailyLogError>> {
  const futureBound = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);
  if (input.logDate > futureBound) {
    return { success: false, error: { type: "LOG_DATE_IN_FUTURE", logDate: input.logDate } };
  }

  let verifiedVideo: VerifiedVideo | null = null;
  if (input.youtubeUrl !== undefined && input.youtubeUrl !== "") {
    const verified = await parseAndVerifyYoutubeUrl(input.youtubeUrl, fetchImplementation);
    if (!verified.success) {
      return { success: false, error: verified.error };
    }
    verifiedVideo = verified.value;
  }

  try {
    const [inserted] = await db
      .insert(dailyLog)
      .values({
        projectId,
        authorMemberId,
        logDate: input.logDate,
        narrative: input.narrative ?? null,
        ...(verifiedVideo === null
          ? { videoSource: "none" as const }
          : {
              videoSource: "youtube" as const,
              youtubeVideoId: verifiedVideo.youtubeVideoId,
              youtubeThumbnailUrl: verifiedVideo.thumbnailUrl,
              videoVerifiedAt: new Date(),
            }),
      })
      .returning();

    if (!inserted) {
      throw new Error("createDailyLog: insert returned no row");
    }
    return { success: true, value: await attachAuthor(inserted) };
  } catch (error: unknown) {
    // UNIQUE (project_id, author_member_id, log_date): one log per member per claimed
    // day. This is what makes the streak countable and stops one day funding two claims.
    if (isUniqueViolation(error)) {
      return {
        success: false,
        error: { type: "DAILY_LOG_ALREADY_EXISTS", logDate: input.logDate },
      };
    }
    throw error;
  }
}

/** Re-reads a written row with its author's display fields joined. */
async function attachAuthor(log: typeof dailyLog.$inferSelect): Promise<DailyLogView> {
  const [author] = await db
    .select({ name: user.name, image: user.image })
    .from(projectMember)
    .innerJoin(user, eq(user.id, projectMember.userId))
    .where(eq(projectMember.id, log.authorMemberId));

  return toLogView({
    log,
    authorName: author?.name ?? "",
    authorAvatarImageUrl: author?.image ?? null,
  });
}

/**
 * Edits a DRAFT. Refused once submitted, and refused for anyone but the author.
 *
 * `youtubeUrl: null` detaches the video; omitting the key leaves it alone. The two must
 * stay distinguishable or a narrative-only PATCH would silently drop a member's video.
 */
export async function updateDailyLog(
  projectId: string,
  logId: string,
  authorMemberId: string,
  patch: UpdateDailyLogInput,
  fetchImplementation?: FetchImplementation,
): Promise<Result<DailyLogView, DailyLogError>> {
  const [existing] = await db
    .select()
    .from(dailyLog)
    .where(and(eq(dailyLog.id, logId), eq(dailyLog.projectId, projectId)));

  if (!existing) {
    return { success: false, error: { type: "DAILY_LOG_NOT_FOUND", logId } };
  }
  if (existing.authorMemberId !== authorMemberId) {
    return { success: false, error: { type: "NOT_THE_AUTHOR" } };
  }
  if (existing.status === "submitted") {
    return { success: false, error: { type: "DAILY_LOG_ALREADY_SUBMITTED" } };
  }

  let videoPatch: Partial<typeof dailyLog.$inferInsert> = {};
  if (patch.youtubeUrl === null || patch.youtubeUrl === "") {
    videoPatch = {
      videoSource: "none",
      youtubeVideoId: null,
      youtubeThumbnailUrl: null,
      videoVerifiedAt: null,
    };
  } else if (patch.youtubeUrl !== undefined) {
    const parsedId = extractYoutubeVideoId(patch.youtubeUrl);
    if (parsedId === null) {
      return { success: false, error: { type: "INVALID_YOUTUBE_URL" } };
    }
    // Re-verify only when the id actually changed: re-pasting the same link on an
    // unrelated edit must not spend an oEmbed round trip.
    if (parsedId !== existing.youtubeVideoId) {
      const verified = await parseAndVerifyYoutubeUrl(patch.youtubeUrl, fetchImplementation);
      if (!verified.success) {
        return { success: false, error: verified.error };
      }
      videoPatch = {
        videoSource: "youtube",
        youtubeVideoId: verified.value.youtubeVideoId,
        youtubeThumbnailUrl: verified.value.thumbnailUrl,
        videoVerifiedAt: new Date(),
      };
    }
  }

  const [updated] = await db
    .update(dailyLog)
    .set({
      ...(patch.logDate === undefined ? {} : { logDate: patch.logDate }),
      ...(patch.narrative === undefined ? {} : { narrative: patch.narrative }),
      ...videoPatch,
    })
    .where(eq(dailyLog.id, logId))
    .returning();

  if (!updated) {
    return { success: false, error: { type: "DAILY_LOG_NOT_FOUND", logId } };
  }
  return { success: true, value: await attachAuthor(updated) };
}

/** Deletes a DRAFT. A submitted log is evidence and is never removed. */
export async function deleteDailyLog(
  projectId: string,
  logId: string,
  authorMemberId: string,
): Promise<Result<{ readonly logId: string }, DailyLogError>> {
  const [existing] = await db
    .select({
      id: dailyLog.id,
      authorMemberId: dailyLog.authorMemberId,
      status: dailyLog.status,
    })
    .from(dailyLog)
    .where(and(eq(dailyLog.id, logId), eq(dailyLog.projectId, projectId)));

  if (!existing) {
    return { success: false, error: { type: "DAILY_LOG_NOT_FOUND", logId } };
  }
  if (existing.authorMemberId !== authorMemberId) {
    return { success: false, error: { type: "NOT_THE_AUTHOR" } };
  }
  if (existing.status === "submitted") {
    return { success: false, error: { type: "DAILY_LOG_ALREADY_SUBMITTED" } };
  }

  await db.delete(dailyLog).where(eq(dailyLog.id, logId));
  return { success: true, value: { logId } };
}

export interface SubmitDailyLogReceipt {
  readonly logId: string;
  readonly submittedAt: Date;
  readonly analysisStatus: DailyLogAnalysisStatus;
  /** Always `not_run` here. Submit returns a receipt, never a verdict (§8). */
  readonly effortVerificationStatus: EffortVerificationStatus;
  readonly dailyLogStreakDays: number;
}

/**
 * Submits a draft: freezes it, moves the streak, and enqueues its analysis — ALL IN ONE
 * TRANSACTION.
 *
 * The enqueue is enlisted in the transaction through pg-boss's `fromDrizzle` for the
 * reason src/lib/jobs.ts exists to explain: a committed submit whose job was never queued
 * has NO ERROR SURFACE ANYWHERE. The member sees "queued" forever and no operator ever
 * learns why. Conversely a job that runs against a rolled-back row finds nothing.
 *
 * With no `GEMINI_API_KEY` configured the log lands `skipped_unconfigured` and no job is
 * queued at all. That is an operator fact, not a failure, and above all not a chip.
 *
 * Idempotent on the caller's key: a retry from a flaky mobile connection returns the same
 * receipt rather than filing a second time.
 */
export async function submitDailyLog(
  projectId: string,
  logId: string,
  authorMemberId: string,
  idempotencyKey: string,
): Promise<Result<SubmitDailyLogReceipt, DailyLogError>> {
  const analysisIsConfigured = config.GEMINI_API_KEY !== undefined;

  const outcome = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(dailyLog)
      .where(and(eq(dailyLog.id, logId), eq(dailyLog.projectId, projectId)))
      .for("update");

    if (!existing) {
      return { kind: "not-found" } as const;
    }
    if (existing.authorMemberId !== authorMemberId) {
      return { kind: "not-author" } as const;
    }
    if (existing.status === "submitted") {
      // A replayed submit with the SAME key is the retry this endpoint promises to
      // absorb; a different key on an already-submitted log is a real conflict.
      if (existing.submitIdempotencyKey === idempotencyKey && existing.submittedAt !== null) {
        return { kind: "replayed", log: existing } as const;
      }
      return { kind: "already-submitted" } as const;
    }
    // A log with neither words nor video claims nothing and can be analyzed by nothing.
    if ((existing.narrative ?? "").trim() === "" && existing.videoSource === "none") {
      return { kind: "empty" } as const;
    }

    const submittedAt = new Date();
    const nextAnalysisStatus = analysisIsConfigured ? "queued" : "skipped_unconfigured";

    const [updated] = await tx
      .update(dailyLog)
      .set({
        status: "submitted",
        submittedAt,
        submitIdempotencyKey: idempotencyKey,
        analysisStatus: nextAnalysisStatus,
        ...(analysisIsConfigured
          ? {}
          : {
              analysisCompletedAt: submittedAt,
              analysisFailureReason: "No analysis provider is configured for this environment.",
            }),
      })
      .where(eq(dailyLog.id, logId))
      .returning();

    if (!updated) {
      throw new Error("submitDailyLog: update returned no row");
    }

    // The streak moves in the SAME transaction as the submit. Anything else lets a
    // crash between the two leave a submitted log that never counted.
    const [stats] = await tx
      .select({
        lastDailyLogDate: projectStats.lastDailyLogDate,
        dailyLogStreakDays: projectStats.dailyLogStreakDays,
      })
      .from(projectStats)
      .where(eq(projectStats.projectId, projectId))
      .for("update");

    const nextStreak = streakAfterLog(
      {
        lastDailyLogDate: stats?.lastDailyLogDate ?? null,
        dailyLogStreakDays: stats?.dailyLogStreakDays ?? 0,
      },
      existing.logDate,
    );

    await tx
      .update(projectStats)
      .set({
        lastDailyLogDate: nextStreak.lastDailyLogDate,
        dailyLogStreakDays: nextStreak.dailyLogStreakDays,
        statsComputedAt: submittedAt,
      })
      .where(eq(projectStats.projectId, projectId));

    if (analysisIsConfigured) {
      const enqueued = await sendJob(
        JOB_NAMES.analyzeDailyLog,
        { dailyLogId: logId },
        {
          idempotencyKey: idempotencyKeyFor.analyzeDailyLog(logId),
          // THE point of this whole transaction: the job row and the submit commit or
          // roll back together.
          db: fromDrizzle(tx, sql),
        },
      );

      if (!enqueued.success) {
        // Roll the submit back rather than promise processing that will not happen. The
        // member retries with the same idempotency key and loses nothing.
        throw new Error(
          `submitDailyLog: log ${logId} could not enqueue analysis (${enqueued.error.type})`,
        );
      }
    }

    return {
      kind: "submitted",
      log: updated,
      streakDays: nextStreak.dailyLogStreakDays,
    } as const;
  });

  switch (outcome.kind) {
    case "not-found":
      return { success: false, error: { type: "DAILY_LOG_NOT_FOUND", logId } };
    case "not-author":
      return { success: false, error: { type: "NOT_THE_AUTHOR" } };
    case "already-submitted":
      return { success: false, error: { type: "DAILY_LOG_ALREADY_SUBMITTED" } };
    case "empty":
      return { success: false, error: { type: "DAILY_LOG_EMPTY" } };
    case "replayed": {
      const [stats] = await db
        .select({ dailyLogStreakDays: projectStats.dailyLogStreakDays })
        .from(projectStats)
        .where(eq(projectStats.projectId, projectId));
      return {
        success: true,
        value: {
          logId,
          // Non-null: the `replayed` branch asserts it.
          submittedAt: outcome.log.submittedAt ?? new Date(0),
          analysisStatus: outcome.log.analysisStatus,
          effortVerificationStatus: outcome.log.effortVerificationStatus,
          dailyLogStreakDays: stats?.dailyLogStreakDays ?? 0,
        },
      };
    }
    case "submitted":
      return {
        success: true,
        value: {
          logId,
          submittedAt: outcome.log.submittedAt ?? new Date(),
          analysisStatus: outcome.log.analysisStatus,
          effortVerificationStatus: outcome.log.effortVerificationStatus,
          dailyLogStreakDays: outcome.streakDays,
        },
      };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled submitDailyLog outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}
