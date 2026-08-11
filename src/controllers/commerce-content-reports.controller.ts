import type { Request, Response } from "express";
import { z } from "zod";

import { respondValidationFailed } from "#src/controllers/project-error-response.js";
import {
  CreateContentReportSchema,
  DecideContentReportSchema,
  ListContentReportsQuerySchema,
  ReportIdParamsSchema,
  RestoreContentSchema,
} from "#src/schemas/commerce-content-reports.schemas.js";
import * as commerceContentReportsService from "#src/services/commerce-content-reports.service.js";
import type { CommerceContentReportsError } from "#src/services/commerce-content-reports.service.js";
import { resolveActiveCommerceOrganization } from "#src/services/commerce-organization-access.service.js";
import type { ApiResponse } from "#src/types/index.js";

const EmptyObjectSchema = z.object({}).strict();

function sendZodError(res: Response, error: z.ZodError): void {
  /**
   * Delegates to the ONE shared responder (§0).
   *
   * This used to build its own body, and got two things wrong that only showed up in the browser:
   * it forwarded `fieldErrors` alone, so `.strict()`'s `unrecognized_keys` — the way EVERY rejected
   * server-owned field arrives — vanished into an empty object; and it put the payload under `data`,
   * which the client's envelope reader never looks at. The result was a 422 that said "Validation
   * failed." and named nothing.
   */
  respondValidationFailed(res, error);
}

function parseNoQuery(req: Request, res: Response): boolean {
  const parsed = EmptyObjectSchema.safeParse(req.query);
  if (!parsed.success) {
    sendZodError(res, parsed.error);
    return false;
  }
  return true;
}

function requireUserId(req: Request, res: Response): string | null {
  if (!req.user) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return null;
  }
  return req.user.id;
}

function mapReportsError(res: Response, error: CommerceContentReportsError): void {
  switch (error.type) {
    case "NOT_FOUND":
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
        message: "You have already reported this.",
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
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "You cannot report your own organization's content.",
      } satisfies ApiResponse);
      return;
    case "MODERATOR_IS_PARTY":
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "A member of the reported organization cannot decide this report.",
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
      throw new Error(`Unhandled content report error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export async function createContentReport(req: Request, res: Response): Promise<void> {
  const reporterUserId = requireUserId(req, res);
  if (!reporterUserId) return;
  if (!parseNoQuery(req, res)) return;

  const body = CreateContentReportSchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  /**
   * The reporter's organization is CONTEXT, not a requirement — anyone signed in may
   * report, and belonging to an organization only sharpens the self-report check.
   *
   * RESOLVED HERE, not read from `req.commerceOrganization`. This route deliberately
   * carries no organization middleware, so that property is ALWAYS undefined on it and
   * reading it made the self-report guard dead code: a seller could report its own
   * listing and get a 201. Caught by `db:smoke-store-phase-10`, which is the only place
   * the empty middleware chain and the guard meet.
   */
  const activeOrganization = req.authSession?.activeOrganizationId
    ? await resolveActiveCommerceOrganization({
        userId: reporterUserId,
        activeOrganizationId: req.authSession.activeOrganizationId,
      })
    : null;

  const result = await commerceContentReportsService.createContentReport(
    {
      reporterUserId,
      reporterOrganizationId: activeOrganization?.success
        ? activeOrganization.value.organizationId
        : null,
    },
    body.data,
  );
  if (!result.success) {
    mapReportsError(res, result.error);
    return;
  }
  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Report received.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function listContentReports(req: Request, res: Response): Promise<void> {
  const moderatorUserId = requireUserId(req, res);
  if (!moderatorUserId) return;

  const query = ListContentReportsQuerySchema.safeParse(req.query);
  if (!query.success) {
    sendZodError(res, query.error);
    return;
  }

  const result = await commerceContentReportsService.listContentReports(
    moderatorUserId,
    query.data,
  );
  if (!result.success) {
    mapReportsError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Content reports.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function decideContentReport(req: Request, res: Response): Promise<void> {
  const moderatorUserId = requireUserId(req, res);
  if (!moderatorUserId) return;
  if (!parseNoQuery(req, res)) return;

  const params = ReportIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = DecideContentReportSchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commerceContentReportsService.decideContentReport(
    moderatorUserId,
    params.data.reportId,
    body.data,
  );
  if (!result.success) {
    mapReportsError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Report decided.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function restoreContent(req: Request, res: Response): Promise<void> {
  const moderatorUserId = requireUserId(req, res);
  if (!moderatorUserId) return;
  if (!parseNoQuery(req, res)) return;

  const body = RestoreContentSchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commerceContentReportsService.restoreContent(moderatorUserId, body.data);
  if (!result.success) {
    mapReportsError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Content restored.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function listModerationActions(req: Request, res: Response): Promise<void> {
  const moderatorUserId = requireUserId(req, res);
  if (!moderatorUserId) return;

  const query = ListContentReportsQuerySchema.safeParse(req.query);
  if (!query.success) {
    sendZodError(res, query.error);
    return;
  }

  const result = await commerceContentReportsService.listModerationActions(
    moderatorUserId,
    query.data,
  );
  if (!result.success) {
    mapReportsError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Moderation actions.",
    data: result.value,
  } satisfies ApiResponse);
}
