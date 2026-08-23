import type { Request, Response } from "express";

import {
  firstParam,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/studio/studio-error-response.js";
import {
  DecideVideoReportSchema,
  EmptyQuerySchema,
  ListVideoReportsQuerySchema,
  ReportIdParamsSchema,
  ReportVideoSchema,
  RestoreVideoSchema,
  VideoIdParamsSchema,
} from "#src/modules/studio/video-content-reports.schemas.js";
import * as reportsService from "#src/modules/studio/video-content-reports.service.js";
import type { VideoContentReportError } from "#src/modules/studio/video-content-reports.service.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * Video content reporting — the reporter's write, the staff queue, and the reporter's own
 * history.
 *
 * ITS OWN ERROR MAP RATHER THAN `respondStudioError`. `StudioDomainError` is the creator
 * surface's union and every one of its lookup failures is a 404 about a video the CALLER
 * owns. These errors are about someone else's video and about a capability, and
 * `PLATFORM_CAPABILITY_REQUIRED` has to carry the capability name in `data` — a shape the
 * studio map has no arm for. Commerce keeps its own `mapReportsError` for the same reason.
 */
function mapReportError(error: VideoContentReportError): {
  readonly statusCode: number;
  readonly message: string;
  readonly data?: Readonly<Record<string, unknown>>;
} {
  switch (error.type) {
    case "VIDEO_REPORT_NOT_FOUND":
      // ONE ANSWER FOR FOUR CAUSES: no such video, no such report, the video is not public,
      // or it is already hidden. Distinguishing them would make this route an oracle for
      // which ids exist — the §5.4 status policy applied to a surface where the caller does
      // not own the thing they are asking about.
      return { statusCode: 404, message: "Not found." };
    case "ALREADY_REPORTED":
      return { statusCode: 409, message: "You have already reported this video." };
    case "REPORT_ALREADY_RESOLVED":
      return { statusCode: 409, message: "This report has already been resolved." };
    case "SELF_REPORT_FORBIDDEN":
      // 422 rather than 403: the caller CAN see the video, so nothing is being concealed —
      // the request simply does not make sense. Reporting your own video is a route to the
      // studio, not to moderation.
      return { statusCode: 422, message: "You cannot report your own video." };
    case "MODERATOR_IS_CREATOR":
      return {
        statusCode: 403,
        message: "You cannot decide a report about your own video.",
      };
    case "VIDEO_ALREADY_VISIBLE":
      return { statusCode: 409, message: "That video is not hidden." };
    case "INVALID_CURSOR":
      return { statusCode: 422, message: "Invalid cursor." };
    case "PLATFORM_CAPABILITY_REQUIRED":
      // The CAPABILITY, never the caller's role. Telling someone which role they would need
      // is free reconnaissance; telling them which permission is missing is actionable.
      return {
        statusCode: 403,
        message: "Platform capability required.",
        data: { capability: error.capability },
      };
    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled video report error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

function respondReportError(res: Response, error: VideoContentReportError): void {
  const { statusCode, message, data } = mapReportError(error);
  res.status(statusCode).json({ status: "error", statusCode, message, ...(data ? { data } : {}) });
}

/** Rejects a stray query param on a write rather than ignoring it. */
function hasCleanQuery(req: Request, res: Response): boolean {
  const parsedQuery = EmptyQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return false;
  }
  return true;
}

/** `POST /videos/:videoId/reports` */
export async function reportVideo(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }
  if (!hasCleanQuery(req, res)) return;

  const parsedParams = VideoIdParamsSchema.safeParse({
    videoId: firstParam(req.params.videoId ?? ""),
  });
  if (!parsedParams.success) {
    respondValidationFailed(res, parsedParams.error);
    return;
  }

  const parsedBody = ReportVideoSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const reportResult = await reportsService.createVideoReport(
    req.user.id,
    parsedParams.data.videoId,
    parsedBody.data,
  );
  if (!reportResult.success) {
    respondReportError(res, reportResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 201,
    // NOT "we have removed this". Nothing has happened to the video and saying otherwise
    // would promise an outcome a moderator has not decided yet.
    message: "Report received. Our team will review it.",
    data: reportResult.value,
  };
  res.status(201).json(response);
}

/** `GET /videos/admin/content-reports` */
export async function listVideoReports(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedQuery = ListVideoReportsQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const listResult = await reportsService.listVideoReports(req.user.id, parsedQuery.data);
  if (!listResult.success) {
    respondReportError(res, listResult.error);
    return;
  }

  // `data` plus a `nextCursor` SIBLING, not a `PaginatedResponse` — a keyset read has no
  // honest `total`, and inventing one means a COUNT over the whole queue on every page.
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Video content reports.",
    data: listResult.value.rows,
    nextCursor: listResult.value.nextCursor,
  });
}

/** `POST /videos/admin/content-reports/:reportId/decisions` */
export async function decideVideoReport(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }
  if (!hasCleanQuery(req, res)) return;

  const parsedParams = ReportIdParamsSchema.safeParse({
    reportId: firstParam(req.params.reportId ?? ""),
  });
  if (!parsedParams.success) {
    respondValidationFailed(res, parsedParams.error);
    return;
  }

  const parsedBody = DecideVideoReportSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const decideResult = await reportsService.decideVideoReport(
    req.user.id,
    parsedParams.data.reportId,
    parsedBody.data,
  );
  if (!decideResult.success) {
    respondReportError(res, decideResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: parsedBody.data.decision === "actioned" ? "Video hidden." : "Report dismissed.",
    data: decideResult.value,
  };
  res.status(200).json(response);
}

/** `POST /videos/admin/content/restore` */
export async function restoreVideo(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }
  if (!hasCleanQuery(req, res)) return;

  const parsedBody = RestoreVideoSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const restoreResult = await reportsService.restoreVideo(req.user.id, parsedBody.data);
  if (!restoreResult.success) {
    respondReportError(res, restoreResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Video restored.",
    data: restoreResult.value,
  };
  res.status(200).json(response);
}

/** `GET /users/me/video-reports` — the reporter's own, on the users router. */
export async function listMyVideoReports(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const myReports = await reportsService.listMyVideoReports(req.user.id);

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Your reports.",
    data: myReports,
  };
  res.status(200).json(response);
}
