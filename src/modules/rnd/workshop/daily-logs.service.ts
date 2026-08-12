import { and, asc, desc, eq, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
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
  researchProject,
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
import {
  decodeDailyLogFeedCursor,
  encodeDailyLogFeedCursor,
} from "#src/modules/rnd/daily-log-cursor.js";
import type { ProjectAccessError } from "#src/modules/rnd/projects/project-membership.service.js";
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
  | { type: "LOG_DATE_IN_FUTURE"; logDate: string }
  // The cross-project feed's keyset (Appendix B2). Already mapped to 422 by
  // `workshop-error-response.ts`, which the chat router reaches through the same switch.
  | { type: "CURSOR_MALFORMED" };

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

export interface UpdateDailyLogInput {
  readonly logDate?: string | undefined;
  readonly narrative?: string | undefined;
  /**
   * Explicit null detaches the video and returns the log to `videoSource = 'none'`;
   * absent leaves it alone. Declared as its own interface rather than
   * `Partial<CreateDailyLogInput>` because an intersection cannot WIDEN an optional
   * field to accept null — it narrows to `string | undefined` and the null is lost.
   */
  readonly youtubeUrl?: string | null | undefined;
}

interface VerifiedVideo {
  readonly youtubeVideoId: string;
  readonly thumbnailUrl: string | null;
}

/**
 * Parses and PROVES a pasted link before any row is written.
 *
 * Reused verbatim from the studio path (src/modules/studio/videos/videos.service.ts): parse to an id
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

// ---------------------------------------------------------------------------
// The CROSS-PROJECT feed (§11h, Appendix B2) — `/build-log`.
//
// THE VISIBILITY DECISION, and it is the whole design. A daily log is private to its
// project's members and the enforcement is real, not aspirational: every project-scoped
// read above runs `requireProjectRole(…, "contributor")` and fails 404. Making the surface
// cross-project could not be allowed to quietly relax that, so this feed is scoped to the
// caller's OWN memberships — Appendix B2 option (a). A logged-out visitor gets 401 and the
// page renders its explainer, its legend and the public leaderboard below with an empty
// feed. It must not render a fabricated one.
//
// THE MEMBERSHIP SET IS A SUBQUERY, NEVER A PARAMETER. There is no `?projectIds=` and
// there must never be one: a client-supplied project list on a private feed is a
// client-supplied authorization input (§0, §13). `?projectSlug=` narrows the caller's own
// set and can only ever shrink it.
// ---------------------------------------------------------------------------

/** Feed rows carry their project, so no client has to fabricate a project chip. */
export interface DailyLogFeedRow extends DailyLogView {
  readonly projectSlug: string;
  readonly projectName: string;
  /** The column is `coverImageUrl`; Appendix B called it `coverImageSrc`, which is not a thing. */
  readonly projectCoverImageUrl: string | null;
  readonly projectStage: (typeof researchProject.$inferSelect)["stage"];
}

export interface DailyLogFeedPage {
  readonly logs: readonly DailyLogFeedRow[];
  /** Opaque, and the only thing a client sends back. Null at the end of history. */
  readonly nextCursor: string | null;
}

export interface DailyLogFeedOptions {
  readonly projectSlug?: string | undefined;
  readonly chipKind?: (typeof dailyLogAiSummaryChip.$inferSelect)["kind"] | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

const FEED_DEFAULT_PAGE_SIZE = 20;
const FEED_MAX_PAGE_SIZE = 50;

/**
 * One page of the caller's cross-project feed.
 *
 * ORDERING IS THREE COLUMNS AND ENDS IN A UNIQUE ONE (§4c rule 4). `logDate` is the day
 * claimed and `submittedAt` is when it was filed; they differ on any backfilled log, so
 * neither substitutes for the other. `id` breaks the remaining ties — without it the
 * cursor skips rows whenever two members submit for the same day inside one millisecond.
 *
 * SUBMITTED LOGS ONLY. A draft is unfinished work belonging to one author, not a feed
 * item, and `daily_log_submitted_ck` guarantees `submittedAt` is NOT NULL exactly on the
 * rows this predicate admits — which is what lets the cursor address it at all.
 */
export async function listDailyLogFeed(
  callerUserId: string,
  options: DailyLogFeedOptions = {},
): Promise<Result<DailyLogFeedPage, DailyLogError>> {
  const pageSize = Math.min(
    Math.max(options.limit ?? FEED_DEFAULT_PAGE_SIZE, 1),
    FEED_MAX_PAGE_SIZE,
  );

  const decodedCursor =
    options.cursor === undefined ? null : decodeDailyLogFeedCursor(options.cursor);
  if (options.cursor !== undefined && decodedCursor === null) {
    return { success: false, error: { type: "CURSOR_MALFORMED" } };
  }

  // Derived server-side from `project_member`, in SQL, on every request. A membership
  // revoked a second ago stops returning rows on the next page, not on the next login.
  const callerProjectIds = db
    .select({ projectId: projectMember.projectId })
    .from(projectMember)
    .where(and(eq(projectMember.userId, callerUserId), eq(projectMember.status, "active")));

  const conditions = [
    inArray(dailyLog.projectId, callerProjectIds),
    eq(dailyLog.status, "submitted"),
    // Redundant against the CHECK, and deliberately kept: it is what makes the compiler's
    // `Date | null` narrow to `Date` for the cursor below without an assertion.
    isNotNull(dailyLog.submittedAt),
  ];

  if (options.projectSlug !== undefined) {
    // Resolved to an id in its own tiny query rather than joined, so the page query below
    // touches `daily_log` ALONE. A slug the caller is not a member of yields an EMPTY PAGE,
    // not a 404 — the catalogue convention (§6): a facet that 404s tells a stranger which
    // slugs exist. `inArray` over an empty set is a false predicate, which is exactly the
    // empty page an unknown slug should produce.
    const narrowedProjectIds = db
      .select({ id: researchProject.id })
      .from(researchProject)
      .where(eq(researchProject.slug, options.projectSlug));

    conditions.push(inArray(dailyLog.projectId, narrowedProjectIds));
  }

  if (options.chipKind !== undefined) {
    const requestedChipKind = options.chipKind;
    // Filtered IN SQL, never in the service after fetching — a predicate applied to one
    // fetched page silently returns short pages and breaks the cursor's page-size
    // contract. Backed by `daily_log_ai_summary_chip_kind_logId_idx`.
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${dailyLogAiSummaryChip}
                  WHERE ${dailyLogAiSummaryChip.dailyLogId} = ${dailyLog.id}
                    AND ${dailyLogAiSummaryChip.kind} = ${requestedChipKind})`,
    );
  }

  if (decodedCursor !== null) {
    // The standard row-comparison, one term per ordering column: strictly older day, OR
    // the same day filed earlier, OR the same day and instant with a smaller id.
    conditions.push(
      or(
        lt(dailyLog.logDate, decodedCursor.logDate),
        and(
          eq(dailyLog.logDate, decodedCursor.logDate),
          lt(dailyLog.submittedAt, decodedCursor.submittedAt),
        ),
        and(
          eq(dailyLog.logDate, decodedCursor.logDate),
          eq(dailyLog.submittedAt, decodedCursor.submittedAt),
          lt(dailyLog.id, decodedCursor.id),
        ),
      ) ?? sql`true`,
    );
  }

  /**
   * ORDER AND LIMIT OVER `daily_log` ALONE — no joins in this query, deliberately.
   *
   * The joined form (author name from `user`, project chip from `research_project`) is the
   * obvious way to write this and it is measurably wrong: `EXPLAIN ANALYZE` over a caller
   * in seven projects with 2,800 submitted logs showed the planner hash-joining **2,815
   * rows** through `project_member` and `user` before the top-N sort discarded all but 21.
   * The join cost scaled with the caller's whole history rather than with the page.
   *
   * The ORDER BY still sorts — `project_id IN (subquery)` becomes a semi-join, so Postgres
   * will not merge per-project index scans and `daily_log_feed_idx` serves the FILTER, not
   * the ordering. That is a bound worth stating honestly rather than papering over. What
   * this shape fixes is the part that was avoidable: only the page's rows are ever joined.
   */
  const pageLogs = await db
    .select()
    .from(dailyLog)
    .where(and(...conditions))
    .orderBy(desc(dailyLog.logDate), desc(dailyLog.submittedAt), desc(dailyLog.id))
    // One extra row, purely to answer "is there another page?" without a COUNT.
    .limit(pageSize + 1);

  const pageRows = pageLogs.slice(0, pageSize);
  const lastRow = pageRows.at(-1);
  const hasMore = pageLogs.length > pageSize && lastRow !== undefined;

  if (pageRows.length === 0) {
    return { success: true, value: { logs: [], nextCursor: null } };
  }

  // The author and project facts for THIS PAGE, in two bounded queries rather than a join
  // over the caller's whole history — the same "one extra query rather than N" shape
  // `attachCompensation` and `loadSkillsAndAsks` use. Name and avatar JOIN from `user`; a
  // copy drifts the moment someone changes their photo (§5).
  const [authorRows, projectRows] = await Promise.all([
    db
      .select({
        memberId: projectMember.id,
        authorName: user.name,
        authorAvatarImageUrl: user.image,
      })
      .from(projectMember)
      .innerJoin(user, eq(user.id, projectMember.userId))
      .where(
        inArray(
          projectMember.id,
          pageRows.map((row) => row.authorMemberId),
        ),
      ),
    db
      .select({
        projectId: researchProject.id,
        projectSlug: researchProject.slug,
        projectName: researchProject.name,
        projectCoverImageUrl: researchProject.coverImageUrl,
        projectStage: researchProject.stage,
      })
      .from(researchProject)
      .where(
        inArray(
          researchProject.id,
          pageRows.map((row) => row.projectId),
        ),
      ),
  ]);

  const authorsByMemberId = new Map(authorRows.map((row) => [row.memberId, row]));
  const projectsByProjectId = new Map(projectRows.map((row) => [row.projectId, row]));

  return {
    success: true,
    value: {
      logs: pageRows.flatMap((log) => {
        const author = authorsByMemberId.get(log.authorMemberId);
        const project = projectsByProjectId.get(log.projectId);
        // Both FKs are `restrict` and neither row is ever hard-deleted (§4f), so a miss
        // here is a broken invariant rather than a normal absence. Dropping the row keeps
        // the feed renderable instead of shipping a card with no author or no project.
        if (!author || !project) return [];

        return [
          {
            ...toLogView({
              log,
              authorName: author.authorName,
              authorAvatarImageUrl: author.authorAvatarImageUrl,
            }),
            projectSlug: project.projectSlug,
            projectName: project.projectName,
            projectCoverImageUrl: project.projectCoverImageUrl,
            projectStage: project.projectStage,
          },
        ];
      }),
      nextCursor:
        hasMore && lastRow.submittedAt !== null
          ? encodeDailyLogFeedCursor({
              logDate: lastRow.logDate,
              submittedAt: lastRow.submittedAt,
              id: lastRow.id,
            })
          : null,
    },
  };
}

export interface DailyLogStreakStanding {
  readonly projectSlug: string;
  readonly projectName: string;
  readonly projectCoverImageUrl: string | null;
  readonly projectStage: (typeof researchProject.$inferSelect)["stage"];
  readonly dailyLogStreakDays: number;
  readonly lastDailyLogDate: string | null;
  readonly projectTimeZone: string;
  /**
   * WHY THIS FIELD IS NOT OPTIONAL. A streak decays at midnight in the project's own zone
   * with NO WRITE — the nightly job is what notices, hours later. A leaderboard rendered
   * without an "as of" therefore asserts a number that may already be stale as if it were
   * live. The client renders the timestamp; the server refuses to imply it is now.
   */
  readonly statsComputedAt: Date | null;
}

const STREAK_LEADERBOARD_SIZE = 20;

/**
 * The public streak leaderboard behind `/build-log`.
 *
 * PUBLIC, unlike the feed above, and the asymmetry is the point: a streak count over an
 * already-public project is project metadata, while a log is a member's work record. No
 * person is named here and no log content appears.
 *
 * Nothing is computed on read. `dailyLogStreakDays` is written in the submit transaction
 * and decayed by `recompute-daily-log-streaks`; this endpoint only orders what is stored.
 */
export async function listDailyLogStreakLeaderboard(): Promise<readonly DailyLogStreakStanding[]> {
  const rows = await db
    .select({
      projectSlug: researchProject.slug,
      projectName: researchProject.name,
      projectCoverImageUrl: researchProject.coverImageUrl,
      projectStage: researchProject.stage,
      dailyLogStreakDays: projectStats.dailyLogStreakDays,
      lastDailyLogDate: projectStats.lastDailyLogDate,
      projectTimeZone: projectStats.projectTimeZone,
      statsComputedAt: projectStats.statsComputedAt,
    })
    .from(projectStats)
    .innerJoin(researchProject, eq(researchProject.id, projectStats.projectId))
    .where(
      and(
        // Drafts and archived projects are not public surfaces (§5).
        eq(researchProject.status, "active"),
        // NULL means "no job has computed this yet", which is not a zero-length streak.
        isNotNull(projectStats.dailyLogStreakDays),
      ),
    )
    // Ends in a unique column (§4c rule 4) — many projects share a streak length.
    .orderBy(desc(projectStats.dailyLogStreakDays), desc(projectStats.projectId))
    .limit(STREAK_LEADERBOARD_SIZE);

  return rows.flatMap((row) =>
    row.dailyLogStreakDays === null ? [] : [{ ...row, dailyLogStreakDays: row.dailyLogStreakDays }],
  );
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
