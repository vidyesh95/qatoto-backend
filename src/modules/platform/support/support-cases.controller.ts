import type { Request, Response } from "express";

import {
  AddSupportCaseMessageSchema,
  DecideSupportCaseSchema,
  EmptySupportCaseQuerySchema,
  ListOwnSupportCasesQuerySchema,
  ListSupportCaseQueueQuerySchema,
  OpenSupportCaseSchema,
  SupportCaseIdParamsSchema,
} from "#src/modules/platform/support/support-cases.schemas.js";
import * as supportCasesService from "#src/modules/platform/support/support-cases.service.js";
import { respondValidationFailed } from "#src/modules/rnd/projects/project-error-response.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * ITS OWN ERROR MAP, like every other queue-bearing controller: `PLATFORM_CAPABILITY_REQUIRED`
 * has to carry the capability name in `data`, a shape no generic map has an arm for.
 *
 * ⚠️ **NO MESSAGE HERE PROMISES ANYTHING ABOUT MONEY.** A support case is a conversation.
 * Qatoto holds no funds, so "we will refund you", "we will recover it" and any wording that
 * implies either are refusals this platform cannot honour.
 */
function mapSupportCaseError(res: Response, error: supportCasesService.SupportCaseError): void {
  switch (error.type) {
    case "SUPPORT_CASE_NOT_FOUND":
      // ONE ANSWER FOR TWO CAUSES — no such case, and a case belonging to somebody else.
      // Distinguishing them would turn the route into an oracle for which case ids exist.
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "Not found.",
      } satisfies ApiResponse);
      return;
    case "INVALID_STATE":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: error.message,
      } satisfies ApiResponse);
      return;
    case "MESSAGE_LIMIT_REACHED":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "This case has reached its message limit. Please open a new one.",
        data: { limit: error.limit },
      } satisfies ApiResponse);
      return;
    case "LIVE_CASE_LIMIT_REACHED":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "You already have the maximum number of open cases. Please use one of those.",
        data: { limit: error.limit },
      } satisfies ApiResponse);
      return;
    case "REOPEN_WINDOW_CLOSED":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "This case was resolved too long ago to reopen. Please open a new one.",
      } satisfies ApiResponse);
      return;
    case "STAFF_IS_CASE_OPENER":
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "You cannot answer or decide your own support case.",
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
      throw new Error(`Unhandled support case error: ${JSON.stringify(exhaustiveCheck)}`);
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

/** A stray query key is a 422 rather than an ignored parameter — every write here is strict. */
function hasCleanQuery(req: Request, res: Response): boolean {
  const parsed = EmptySupportCaseQuerySchema.safeParse(req.query);
  if (parsed.success) return true;
  respondValidationFailed(res, parsed.error);
  return false;
}

export async function openSupportCase(req: Request, res: Response): Promise<void> {
  const openerUserId = requireSignedInUserId(req, res);
  if (!openerUserId) return;
  if (!hasCleanQuery(req, res)) return;

  const body = OpenSupportCaseSchema.safeParse(req.body);
  if (!body.success) {
    respondValidationFailed(res, body.error);
    return;
  }

  const result = await supportCasesService.openSupportCase(openerUserId, body.data);
  if (!result.success) {
    mapSupportCaseError(res, result.error);
    return;
  }

  // ⚠️ "OPENED", NEVER "SOLVED" OR "WE WILL FIX THIS". A 201 means the case exists and staff
  // have been told, not that anybody has read it — and no response time is promised anywhere,
  // because nothing here measures one.
  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Case opened. Support will reply here.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function listOwnSupportCases(req: Request, res: Response): Promise<void> {
  const openerUserId = requireSignedInUserId(req, res);
  if (!openerUserId) return;

  const query = ListOwnSupportCasesQuerySchema.safeParse(req.query);
  if (!query.success) {
    respondValidationFailed(res, query.error);
    return;
  }

  const result = await supportCasesService.listOwnSupportCases(openerUserId, {
    ...(query.data.state === undefined ? {} : { state: query.data.state }),
    ...(query.data.limit === undefined ? {} : { limit: query.data.limit }),
    ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
  });
  if (!result.success) {
    mapSupportCaseError(res, result.error);
    return;
  }

  // `nextCursor` as a SIBLING of `data`, not inside a pagination envelope: a keyset read has
  // no honest `total` to report.
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Support cases retrieved.",
    data: result.value.cases,
    nextCursor: result.value.nextCursor,
  });
}

export async function getOwnSupportCase(req: Request, res: Response): Promise<void> {
  const openerUserId = requireSignedInUserId(req, res);
  if (!openerUserId) return;

  const params = SupportCaseIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    respondValidationFailed(res, params.error);
    return;
  }

  const result = await supportCasesService.getOwnSupportCase(openerUserId, params.data.caseId);
  if (!result.success) {
    mapSupportCaseError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Support case retrieved.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function addOwnSupportCaseMessage(req: Request, res: Response): Promise<void> {
  const openerUserId = requireSignedInUserId(req, res);
  if (!openerUserId) return;
  if (!hasCleanQuery(req, res)) return;

  const params = SupportCaseIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    respondValidationFailed(res, params.error);
    return;
  }
  const body = AddSupportCaseMessageSchema.safeParse(req.body);
  if (!body.success) {
    respondValidationFailed(res, body.error);
    return;
  }

  const result = await supportCasesService.addOwnSupportCaseMessage(
    openerUserId,
    params.data.caseId,
    body.data,
  );
  if (!result.success) {
    mapSupportCaseError(res, result.error);
    return;
  }

  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Reply added.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function listSupportCaseQueue(req: Request, res: Response): Promise<void> {
  const staffUserId = requireSignedInUserId(req, res);
  if (!staffUserId) return;

  const query = ListSupportCaseQueueQuerySchema.safeParse(req.query);
  if (!query.success) {
    respondValidationFailed(res, query.error);
    return;
  }

  const result = await supportCasesService.listSupportCaseQueue(staffUserId, {
    ...(query.data.state === undefined ? {} : { state: query.data.state }),
    ...(query.data.category === undefined ? {} : { category: query.data.category }),
    ...(query.data.limit === undefined ? {} : { limit: query.data.limit }),
    ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
  });
  if (!result.success) {
    mapSupportCaseError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Support case queue retrieved.",
    data: result.value.cases,
    nextCursor: result.value.nextCursor,
  });
}

export async function getSupportCaseForStaff(req: Request, res: Response): Promise<void> {
  const staffUserId = requireSignedInUserId(req, res);
  if (!staffUserId) return;

  const params = SupportCaseIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    respondValidationFailed(res, params.error);
    return;
  }

  const result = await supportCasesService.getSupportCaseForStaff(staffUserId, params.data.caseId);
  if (!result.success) {
    mapSupportCaseError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Support case retrieved.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function addStaffSupportCaseMessage(req: Request, res: Response): Promise<void> {
  const staffUserId = requireSignedInUserId(req, res);
  if (!staffUserId) return;
  if (!hasCleanQuery(req, res)) return;

  const params = SupportCaseIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    respondValidationFailed(res, params.error);
    return;
  }
  const body = AddSupportCaseMessageSchema.safeParse(req.body);
  if (!body.success) {
    respondValidationFailed(res, body.error);
    return;
  }

  const result = await supportCasesService.addStaffSupportCaseMessage(
    staffUserId,
    params.data.caseId,
    body.data,
  );
  if (!result.success) {
    mapSupportCaseError(res, result.error);
    return;
  }

  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Reply sent.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function decideSupportCase(req: Request, res: Response): Promise<void> {
  const staffUserId = requireSignedInUserId(req, res);
  if (!staffUserId) return;
  if (!hasCleanQuery(req, res)) return;

  const params = SupportCaseIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    respondValidationFailed(res, params.error);
    return;
  }
  const body = DecideSupportCaseSchema.safeParse(req.body);
  if (!body.success) {
    respondValidationFailed(res, body.error);
    return;
  }

  const result = await supportCasesService.decideSupportCase(
    staffUserId,
    params.data.caseId,
    body.data,
  );
  if (!result.success) {
    mapSupportCaseError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message:
      body.data.decision === "resolved"
        ? "Case resolved. The person can still reply to reopen it."
        : "Case closed. Nobody can add to it.",
    data: result.value,
  } satisfies ApiResponse);
}
