import type { Request, Response } from "express";

import {
  CreateUserReportSchema,
  DecideUserReportSchema,
  EmptyUserReportQuerySchema,
  ListUserReportsQuerySchema,
  ReportIdParamsSchema,
  RestoreUserProfileTextSchema,
  UserIdParamsSchema,
} from "#src/modules/auth/users/user-reports.schemas.js";
import * as userReportsService from "#src/modules/auth/users/user-reports.service.js";
import { respondValidationFailed } from "#src/modules/rnd/projects/project-error-response.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * ITS OWN ERROR MAP, not the users controller's.
 *
 * These errors are about SOMEBODY ELSE's profile and about a capability, and
 * `PLATFORM_CAPABILITY_REQUIRED` has to carry the capability name in `data` — a shape the generic
 * account map has no arm for. The same reason `video-content-reports.controller.ts` keeps its own.
 */
function mapUserReportError(res: Response, error: userReportsService.UserReportError): void {
  switch (error.type) {
    case "USER_REPORT_NOT_FOUND":
      // ONE ANSWER FOR SEVERAL CAUSES — no such person, no handle, no such report. Distinguishing
      // them would turn this route into an oracle for which account ids exist.
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "Not found.",
      } satisfies ApiResponse);
      return;
    case "ALREADY_REPORTED":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "You have already reported this profile.",
      } satisfies ApiResponse);
      return;
    case "REPORT_ALREADY_RESOLVED":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "This report has already been resolved.",
      } satisfies ApiResponse);
      return;
    case "SELF_REPORT_FORBIDDEN":
      // 422, NOT 403: the caller can plainly see their own profile, so nothing is being concealed.
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "You cannot report your own profile.",
      } satisfies ApiResponse);
      return;
    case "MODERATOR_IS_SUBJECT":
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "You cannot decide a report about your own profile.",
      } satisfies ApiResponse);
      return;
    case "PROFILE_TEXT_ALREADY_VISIBLE":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "That profile is not hidden.",
      } satisfies ApiResponse);
      return;
    case "INVALID_CURSOR":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "Invalid cursor.",
      } satisfies ApiResponse);
      return;
    case "PLATFORM_CAPABILITY_REQUIRED":
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "Platform capability required.",
        data: { capability: error.capability },
      } satisfies ApiResponse);
      return;
    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled user report error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

function requireSignedInUserId(req: Request, res: Response): string | null {
  if (req.user) return req.user.id;
  res.status(401).json({
    status: "error",
    statusCode: 401,
    message: "Please sign in.",
  } satisfies ApiResponse);
  return null;
}

/** A stray query key is a 422 rather than an ignored parameter — every write here is `.strict()`. */
function hasCleanQuery(req: Request, res: Response): boolean {
  const parsed = EmptyUserReportQuerySchema.safeParse(req.query);
  if (parsed.success) return true;
  respondValidationFailed(res, parsed.error);
  return false;
}

export async function reportUser(req: Request, res: Response): Promise<void> {
  const reporterUserId = requireSignedInUserId(req, res);
  if (!reporterUserId) return;
  if (!hasCleanQuery(req, res)) return;

  const params = UserIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    respondValidationFailed(res, params.error);
    return;
  }
  const body = CreateUserReportSchema.safeParse(req.body);
  if (!body.success) {
    respondValidationFailed(res, body.error);
    return;
  }

  const result = await userReportsService.createUserReport(
    reporterUserId,
    params.data.userId,
    body.data,
  );
  if (!result.success) {
    mapUserReportError(res, result.error);
    return;
  }

  // ⚠️ "RECEIVED", NEVER "REPORTED" OR "REMOVED". A 201 means a row exists, not that anybody has
  // looked at it — and a message that implies a verdict is a promise this system has not made.
  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Report received. Our team will review it.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function listUserReports(req: Request, res: Response): Promise<void> {
  const moderatorUserId = requireSignedInUserId(req, res);
  if (!moderatorUserId) return;

  const query = ListUserReportsQuerySchema.safeParse(req.query);
  if (!query.success) {
    respondValidationFailed(res, query.error);
    return;
  }

  const result = await userReportsService.listUserReports(moderatorUserId, {
    ...(query.data.status === undefined ? {} : { status: query.data.status }),
    limit: query.data.limit ?? 20,
    ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
  });
  if (!result.success) {
    mapUserReportError(res, result.error);
    return;
  }

  // `nextCursor` as a SIBLING of `data`, not inside a pagination envelope: a keyset read has no
  // honest `total` to report.
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "User reports retrieved.",
    data: result.value.items,
    nextCursor: result.value.nextCursor,
  });
}

export async function decideUserReport(req: Request, res: Response): Promise<void> {
  const moderatorUserId = requireSignedInUserId(req, res);
  if (!moderatorUserId) return;
  if (!hasCleanQuery(req, res)) return;

  const params = ReportIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    respondValidationFailed(res, params.error);
    return;
  }
  const body = DecideUserReportSchema.safeParse(req.body);
  if (!body.success) {
    respondValidationFailed(res, body.error);
    return;
  }

  const result = await userReportsService.decideUserReport(
    moderatorUserId,
    params.data.reportId,
    body.data,
  );
  if (!result.success) {
    mapUserReportError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message:
      body.data.decision === "actioned"
        ? "Profile text hidden."
        : "Report dismissed. Nothing was hidden.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function restoreUserProfileText(req: Request, res: Response): Promise<void> {
  const moderatorUserId = requireSignedInUserId(req, res);
  if (!moderatorUserId) return;
  if (!hasCleanQuery(req, res)) return;

  const body = RestoreUserProfileTextSchema.safeParse(req.body);
  if (!body.success) {
    respondValidationFailed(res, body.error);
    return;
  }

  const result = await userReportsService.restoreUserProfileText(moderatorUserId, body.data);
  if (!result.success) {
    mapUserReportError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Profile text restored.",
    data: result.value,
  } satisfies ApiResponse);
}

/**
 * `GET /users/me/profile-reports` — the reporter's own list.
 *
 * NO ERROR MAP NEEDED: the service is scoped to the caller and cannot fail to find a resource, so
 * an empty array is the honest answer to somebody who has reported nothing.
 */
export async function listMyProfileReports(req: Request, res: Response): Promise<void> {
  const reporterUserId = requireSignedInUserId(req, res);
  if (!reporterUserId) return;

  const rows = await userReportsService.listMyProfileReports(reporterUserId);
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Your profile reports retrieved.",
    data: rows,
  } satisfies ApiResponse);
}
