import type { Request, Response } from "express";
import { z } from "zod";

import {
  firstParam,
  respondProjectError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/controllers/project-error-response.js";
import { respondWorkshopError } from "#src/controllers/workshop-error-response.js";
import * as logsService from "#src/services/daily-logs.service.js";
import * as membershipService from "#src/services/project-membership.service.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * Daily logs (R_AND_D_BACKEND_STRUCTURE.md §8, §11d).
 *
 * THE FIELDS THAT DO NOT EXIST IN ANY SCHEMA HERE, and are therefore 422s rather than
 * silent overwrites (§13). Every one of them is server-owned or §9-owned:
 *   authorMemberId · authorUserId · status · submittedAt · videoSource · youtubeVideoId ·
 *   youtubeThumbnailUrl · videoVerifiedAt · analysisStatus · analysisModelName ·
 *   analysisPromptVersion · effortVerificationStatus · isEffortVerified ·
 *   aiSummaryChips · transcriptSegments · extractedClaims · extractedMinutes ·
 *   dailyLogStreakDays · id · createdAt
 *
 * A member sends a `youtubeUrl`, and the server derives every video fact from it — that
 * is the difference between "the client tells us which video" and "the client tells us
 * what the video is".
 *
 * SUBMIT RETURNS 202 AND A RECEIPT, NEVER A VERDICT. The analysis runs in a worker, so
 * the response carries `analysisStatus` and an `effortVerificationStatus` that is always
 * `not_run` in this phase. A UI that renders "verified" from this response is wrong (§14
 * lists the async states the frontend still needs).
 */

const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be an ISO date (YYYY-MM-DD)");

/**
 * `youtubeUrl` is NOT wrapped in `z.url()`.
 *
 * src/lib/youtube.ts accepts a bare 11-character id and a schemeless link, both of which
 * the frontend's mirrored parser accepts too — and `z.url()` would reject them here after
 * the browser showed a green checkmark. The parse that matters happens in the service,
 * against a hostname allowlist.
 */
const YoutubeUrlSchema = z.string().trim().min(1).max(2_048);

export const CreateDailyLogSchema = z
  .object({
    logDate: IsoDateSchema,
    narrative: z.string().trim().max(10_000).optional(),
    youtubeUrl: YoutubeUrlSchema.optional(),
  })
  .strict();

export const UpdateDailyLogSchema = z
  .object({
    logDate: IsoDateSchema.optional(),
    narrative: z.string().trim().max(10_000).optional(),
    // Explicit null detaches the video; absent leaves it alone. The two must stay
    // distinguishable or a narrative-only PATCH silently drops a member's video.
    youtubeUrl: YoutubeUrlSchema.nullable().optional(),
  })
  .strict();

/**
 * The one client-supplied string this endpoint accepts.
 *
 * It is an opaque dedup token, not a value the server owns: a retried submit on a flaky
 * mobile connection must return the first receipt rather than file a second log (§14).
 */
export const SubmitDailyLogSchema = z
  .object({ idempotencyKey: z.string().trim().min(8).max(128) })
  .strict();

export const ListDailyLogsQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(100).optional() })
  .strict();

/**
 * The CROSS-PROJECT feed's query (§11h, Appendix B2).
 *
 * THE KEY THAT IS ABSENT IS THE POINT: there is no `projectIds`, no `userId`, and no
 * `includeAllProjects`. `.strict()` refuses all three with a 422 rather than letting one
 * become an authorization input (§0). The membership set is derived from `project_member`
 * inside the service; `projectSlug` can only NARROW the caller's own set.
 *
 * `chipKind` is the four-value `AiSummaryChipKind`, enumerated here so an unknown chip is
 * a 422 rather than an empty page a client would read as "no blockers this week".
 */
export const ListDailyLogFeedQuerySchema = z
  .object({
    projectSlug: z.string().trim().min(1).max(120).optional(),
    chipKind: z.enum(["blocker", "progress", "velocity", "suggestion"]).optional(),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();

interface DailyLogCaller {
  readonly context: membershipService.ProjectMemberContext;
  readonly userId: string;
}

async function requireMemberOrRespond(req: Request, res: Response): Promise<DailyLogCaller | null> {
  if (!req.user) {
    respondUnauthenticated(res);
    return null;
  }

  const projectSlug = firstParam(req.params.projectSlug ?? "");
  const accessResult = await membershipService.requireProjectRole(
    projectSlug,
    req.user.id,
    "contributor",
  );

  if (!accessResult.success) {
    respondProjectError(res, accessResult.error);
    return null;
  }
  return { context: accessResult.value, userId: req.user.id };
}

/** GET …/daily-logs — the project's feed, newest claimed day first. */
export async function listDailyLogs(req: Request, res: Response): Promise<void> {
  const caller = await requireMemberOrRespond(req, res);
  if (!caller) return;

  const parsedQuery = ListDailyLogsQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const logs = await logsService.listDailyLogs(caller.context.projectId, parsedQuery.data);

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Daily logs loaded.",
    data: logs,
  } satisfies ApiResponse);
}

/**
 * GET /daily-logs — the caller's CROSS-PROJECT feed, root-mounted (§11h).
 *
 * Root-mounted because a member arriving from the `/build-log` stage page holds no project
 * slug — the same reason `/open-roles` is root-mounted (§11).
 *
 * NO `requireProjectRole` HERE, and its absence is not a gap: there is no project in the
 * URL to prove membership against. The service derives the membership set from
 * `project_member` in SQL, so a caller with no memberships gets an empty page and a caller
 * with six gets exactly those six.
 */
export async function listDailyLogFeed(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedQuery = ListDailyLogFeedQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const feed = await logsService.listDailyLogFeed(req.user.id, parsedQuery.data);
  if (!feed.success) {
    respondWorkshopError(res, feed.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Build log loaded.",
    data: feed.value,
  } satisfies ApiResponse);
}

/**
 * GET /daily-logs/streak-leaderboard — public, and deliberately so.
 *
 * A streak count over an already-public project is project metadata; a log is a member's
 * work record. The feed above is members-only for that reason and this is not.
 *
 * Every row carries `statsComputedAt`. A streak decays at midnight with no write, so a
 * leaderboard that implies live numbers is lying (§5).
 */
export async function listDailyLogStreakLeaderboard(_req: Request, res: Response): Promise<void> {
  const standings = await logsService.listDailyLogStreakLeaderboard();

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Streak leaderboard loaded.",
    data: standings,
  } satisfies ApiResponse);
}

/** GET …/daily-logs/:logId — the log plus everything the analysis produced. */
export async function getDailyLog(req: Request, res: Response): Promise<void> {
  const caller = await requireMemberOrRespond(req, res);
  if (!caller) return;

  const logId = firstParam(req.params.logId ?? "");
  const log = await logsService.findDailyLogDetail(caller.context.projectId, logId);

  if (!log) {
    respondWorkshopError(res, { type: "DAILY_LOG_NOT_FOUND", logId });
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Daily log loaded.",
    data: log,
  } satisfies ApiResponse);
}

/**
 * GET …/daily-logs/:logId/transcript — the analysis output on its own.
 *
 * A separate endpoint from the detail read because the transcript is the part a client
 * POLLS while `analysisStatus` is `queued` or `running`, and re-fetching the whole log to
 * watch one field change is wasteful on a mobile connection.
 */
export async function getDailyLogTranscript(req: Request, res: Response): Promise<void> {
  const caller = await requireMemberOrRespond(req, res);
  if (!caller) return;

  const logId = firstParam(req.params.logId ?? "");
  const log = await logsService.findDailyLogDetail(caller.context.projectId, logId);

  if (!log) {
    respondWorkshopError(res, { type: "DAILY_LOG_NOT_FOUND", logId });
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Transcript loaded.",
    data: {
      analysisStatus: log.analysisStatus,
      analysisFailureReason: log.analysisFailureReason,
      analysisCompletedAt: log.analysisCompletedAt,
      analysisModelName: log.analysisModelName,
      analysisModelVersion: log.analysisModelVersion,
      analysisPromptVersion: log.analysisPromptVersion,
      transcriptSegments: log.transcriptSegments,
      aiSummaryChips: log.aiSummaryChips,
      extractedClaims: log.extractedClaims,
      evidenceLinks: log.evidenceLinks,
    },
  } satisfies ApiResponse);
}

/** POST …/daily-logs — creates a DRAFT. The video, if any, is verified before the write. */
export async function createDailyLog(req: Request, res: Response): Promise<void> {
  const caller = await requireMemberOrRespond(req, res);
  if (!caller) return;

  const parsedBody = CreateDailyLogSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const created = await logsService.createDailyLog(
    caller.context.projectId,
    // The author is the caller's OWN membership row (§13). There is no field to send.
    caller.context.memberId,
    parsedBody.data,
  );
  if (!created.success) {
    respondWorkshopError(res, created.error);
    return;
  }

  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Draft log created.",
    data: created.value,
  } satisfies ApiResponse);
}

/** PATCH …/daily-logs/:logId — drafts only; a submitted log is frozen evidence. */
export async function updateDailyLog(req: Request, res: Response): Promise<void> {
  const caller = await requireMemberOrRespond(req, res);
  if (!caller) return;

  const parsedBody = UpdateDailyLogSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const updated = await logsService.updateDailyLog(
    caller.context.projectId,
    firstParam(req.params.logId ?? ""),
    caller.context.memberId,
    parsedBody.data,
  );
  if (!updated.success) {
    respondWorkshopError(res, updated.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Draft log updated.",
    data: updated.value,
  } satisfies ApiResponse);
}

/** DELETE …/daily-logs/:logId — drafts only. */
export async function deleteDailyLog(req: Request, res: Response): Promise<void> {
  const caller = await requireMemberOrRespond(req, res);
  if (!caller) return;

  const deleted = await logsService.deleteDailyLog(
    caller.context.projectId,
    firstParam(req.params.logId ?? ""),
    caller.context.memberId,
  );
  if (!deleted.success) {
    respondWorkshopError(res, deleted.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Draft log deleted.",
    data: deleted.value,
  } satisfies ApiResponse);
}

/**
 * POST …/daily-logs/:logId/submit — freezes the log and queues its analysis.
 *
 * **202, not 200**, and the difference is the contract: the work is accepted, not
 * finished. The receipt carries `analysisStatus` so a client knows whether to poll
 * (`queued`) or stop (`skipped_unconfigured`), and an `effortVerificationStatus` that is
 * always `not_run` — §9 is what moves it, and §9 does not exist yet.
 */
export async function submitDailyLog(req: Request, res: Response): Promise<void> {
  const caller = await requireMemberOrRespond(req, res);
  if (!caller) return;

  const parsedBody = SubmitDailyLogSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const submitted = await logsService.submitDailyLog(
    caller.context.projectId,
    firstParam(req.params.logId ?? ""),
    caller.context.memberId,
    parsedBody.data.idempotencyKey,
  );
  if (!submitted.success) {
    respondWorkshopError(res, submitted.error);
    return;
  }

  res.status(202).json({
    status: "success",
    statusCode: 202,
    message:
      submitted.value.analysisStatus === "queued"
        ? "Log submitted. Analysis is queued."
        : "Log submitted.",
    data: submitted.value,
  } satisfies ApiResponse);
}
