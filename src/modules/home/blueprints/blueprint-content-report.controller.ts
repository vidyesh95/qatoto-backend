import type { Request, Response } from "express";

import { respondBlueprintContentReportError } from "#src/modules/home/blueprints/blueprint-content-report-error-response.js";
import {
  BlueprintReportQueueQuerySchema,
  CreateBlueprintReportSchema,
  DismissBlueprintReportSchema,
} from "#src/modules/home/blueprints/blueprint-content-report.schemas.js";
import * as blueprintContentReportService from "#src/modules/home/blueprints/blueprint-content-report.service.js";
import {
  firstParam,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/home/blueprints/blueprint-engagement-error-response.js";
import type { BlueprintModerationArm } from "#src/modules/home/blueprints/blueprint-moderation-transitions.js";
import {
  requirePlatformCapability,
  type PlatformStaffContext,
} from "#src/modules/platform/roles/platform-role.service.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * The reader-report intake, the reporter's own list, and the moderator queue.
 *
 * ⚠️ THE ARM IS A ROUTE-TIME CONSTANT, closed over by a factory — the same rule the engagement
 * controller states. A `:targetKind` segment would be a client-supplied value deciding which table
 * a write lands in.
 */

function respondOk(res: Response, message: string, data: unknown): void {
  res.status(200).json({ status: "success", statusCode: 200, message, data } satisfies ApiResponse);
}

/**
 * ⚠️ RESOLVED BEFORE `req.params` IS READ AND BEFORE THE BODY IS PARSED — §3.6. Reversed, a 403
 * that only arrives for reports that exist is an existence oracle over the queue.
 */
async function resolveModerator(req: Request, res: Response): Promise<PlatformStaffContext | null> {
  const viewerId = req.user?.id;
  if (!viewerId) {
    respondUnauthenticated(res);
    return null;
  }
  const capabilityResult = await requirePlatformCapability(viewerId, "moderate_content");
  if (!capabilityResult.success) {
    res.status(403).json({
      status: "error",
      statusCode: 403,
      message: "You do not have permission to moderate content.",
    });
    return null;
  }
  return capabilityResult.value;
}

export function makeCreateReportHandler(arm: BlueprintModerationArm, parameterName: string) {
  return async function createBlueprintReport(req: Request, res: Response): Promise<void> {
    if (!req.user) {
      respondUnauthenticated(res);
      return;
    }

    const parsedBody = CreateBlueprintReportSchema.safeParse(req.body);
    if (!parsedBody.success) {
      respondValidationFailed(res, parsedBody.error);
      return;
    }

    const result = await blueprintContentReportService.createBlueprintContentReport({
      arm,
      slug: firstParam(req.params[parameterName] ?? ""),
      reporterUserId: req.user.id,
      reason: parsedBody.data.reason,
      detailText: parsedBody.data.detailText,
    });

    if (!result.success) {
      respondBlueprintContentReportError(res, result.error);
      return;
    }

    /*
     * ⚠️ 201 AND A REPORT ID, AND NOTHING ELSE. No count, no state, no "this will be hidden" — a
     * 201 is a receipt, not a verdict. Nothing is hidden automatically on this surface.
     */
    res.status(201).json({
      status: "success",
      statusCode: 201,
      message: "Reported. A moderator will look at it.",
      data: result.value,
    } satisfies ApiResponse);
  };
}

export async function listMyBlueprintReports(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }
  const rows = await blueprintContentReportService.listMyBlueprintReports(req.user.id);
  respondOk(res, "Your reports.", rows);
}

export async function listBlueprintReportQueue(req: Request, res: Response): Promise<void> {
  const staff = await resolveModerator(req, res);
  if (!staff) return;

  const parsedQuery = BlueprintReportQueueQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const result = await blueprintContentReportService.listBlueprintReportQueue({
    status: parsedQuery.data.status,
    targetKind: parsedQuery.data.targetKind,
    limit: parsedQuery.data.limit,
    cursor: parsedQuery.data.cursor,
    staff,
  });

  if (!result.success) {
    respondBlueprintContentReportError(res, result.error);
    return;
  }

  respondOk(res, "Reports awaiting an answer.", result.value);
}

export async function dismissBlueprintReport(req: Request, res: Response): Promise<void> {
  const staff = await resolveModerator(req, res);
  if (!staff) return;

  const parsedBody = DismissBlueprintReportSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const result = await blueprintContentReportService.dismissBlueprintContentReport({
    reportId: firstParam(req.params.reportId ?? ""),
    resolutionNote: parsedBody.data.resolutionNote,
    staff,
  });

  if (!result.success) {
    respondBlueprintContentReportError(res, result.error);
    return;
  }

  respondOk(res, "Dismissed.", result.value);
}
