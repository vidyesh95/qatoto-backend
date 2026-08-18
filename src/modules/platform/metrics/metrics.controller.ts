import type { Request, Response } from "express";

import {
  ActiveUsersQuerySchema,
  MetricsWindowQuerySchema,
  RetentionCohortsQuerySchema,
  ROLLING_DAYS_BY_WINDOW,
  UserSegmentQuerySchema,
} from "#src/modules/platform/metrics/metrics.schemas.js";
import * as platformMetricsService from "#src/modules/platform/metrics/platform-metrics.service.js";
import type { PlatformMetricsError } from "#src/modules/platform/metrics/platform-metrics.service.js";
import { requirePlatformCapability } from "#src/modules/platform/roles/platform-role.service.js";
import { respondValidationFailed } from "#src/modules/rnd/projects/project-error-response.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * Platform metrics reads — HOME_BACKEND_STRUCTURE.md §3.3a.
 *
 * NO CAPABILITY MIDDLEWARE, by the same reasoning as every other staff route in this codebase:
 * middleware cannot return a `Result`, so it could not take part in the exhaustive switch below.
 * The check runs first inside each service function instead.
 */

function respondMetricsError(res: Response, error: PlatformMetricsError): void {
  switch (error.type) {
    case "PLATFORM_CAPABILITY_REQUIRED":
      // Names no role and no resource, and is decided before any row is read — identical for a
      // caller with no staff role and a moderator without this capability.
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "This action requires a platform staff role.",
      } satisfies ApiResponse);
      return;
    default: {
      const exhaustiveCheck: never = error.type;
      throw new Error(`Unhandled platform metrics error: ${String(exhaustiveCheck)}`);
    }
  }
}

/** Every route here is `requireAuth`, so the session id is present by the time we run. */
function callerId(req: Request): string {
  const userId = req.user?.id;
  if (userId === undefined) throw new Error("metrics controller reached without a session");
  return userId;
}

export async function getActiveUsers(req: Request, res: Response): Promise<void> {
  const parsedQuery = ActiveUsersQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const result = await platformMetricsService.getActiveUsers(
    callerId(req),
    { fromDate: parsedQuery.data.fromDate, toDate: parsedQuery.data.toDate },
    ROLLING_DAYS_BY_WINDOW[parsedQuery.data.window],
  );
  if (!result.success) {
    respondMetricsError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Active users retrieved.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function getWatchTimeDistribution(req: Request, res: Response): Promise<void> {
  const parsedQuery = MetricsWindowQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const result = await platformMetricsService.getWatchTimeDistribution(
    callerId(req),
    parsedQuery.data,
  );
  if (!result.success) {
    respondMetricsError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Watch time retrieved.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function getActivityByHour(req: Request, res: Response): Promise<void> {
  const parsedQuery = MetricsWindowQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const result = await platformMetricsService.getActivityByHour(callerId(req), parsedQuery.data);
  if (!result.success) {
    respondMetricsError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    // The axis is UTC and the caller has to know: there is no per-user time zone on this
    // platform, so a "local hour" histogram would have to invent one.
    message: "Activity by hour of day (UTC) retrieved.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function getRetentionCohorts(req: Request, res: Response): Promise<void> {
  const parsedQuery = RetentionCohortsQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const result = await platformMetricsService.getRetentionCohorts(
    callerId(req),
    parsedQuery.data.months,
  );
  if (!result.success) {
    respondMetricsError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Retention cohorts retrieved.",
    data: result.value,
  } satisfies ApiResponse);
}

/**
 * The audited one. It needs the caller's ROLE as well as their id, because the audit entry
 * snapshots the role at the time — roles are revocable and a join would lie later — so the
 * capability is proved here first and the proven role handed down.
 */
export async function listUserSegment(req: Request, res: Response): Promise<void> {
  const parsedQuery = UserSegmentQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const staffUserId = callerId(req);
  const accessResult = await requirePlatformCapability(staffUserId, "view_platform_metrics");
  if (!accessResult.success) {
    respondMetricsError(res, accessResult.error);
    return;
  }

  const result = await platformMetricsService.listUserSegment(
    staffUserId,
    accessResult.value.platformRole,
    parsedQuery.data.segment,
    parsedQuery.data.limit,
  );
  if (!result.success) {
    respondMetricsError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "User segment retrieved.",
    data: result.value,
  } satisfies ApiResponse);
}
