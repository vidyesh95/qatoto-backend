import type { Request, Response } from "express";

import * as cloudAccessService from "#src/modules/assistant/assistant-cloud-access.service.js";
import {
  CloudAccessUserIdParamsSchema,
  CreateAssistantReplySchema,
  EmptyAssistantQuerySchema,
  GrantCloudAccessSchema,
  ListCloudAccessGrantsQuerySchema,
} from "#src/modules/assistant/assistant.schemas.js";
import * as assistantService from "#src/modules/assistant/assistant.service.js";
import { respondValidationFailed } from "#src/modules/rnd/projects/project-error-response.js";
import type { ApiResponse } from "#src/types/index.js";

function mapAssistantReplyError(res: Response, error: assistantService.AssistantReplyError): void {
  switch (error.type) {
    case "ASSISTANT_PREMIUM_REQUIRED":
      // 403 like the anonymous-account refusal, told apart by `data.reason` so the panel can say
      // "this needs premium" rather than "finish signing up".
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "Cloud answers are for Premium AI accounts.",
        data: { reason: "premium_required" },
      } satisfies ApiResponse);
      return;
    case "ASSISTANT_UNAVAILABLE":
      res.status(503).json({
        status: "error",
        statusCode: 503,
        message: "The assistant is unavailable right now.",
      } satisfies ApiResponse);
      return;
    case "ASSISTANT_INPUT_REJECTED":
      // 422 rather than 400: the request was well-formed, the provider declined its content.
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "The assistant could not answer that. Try asking it another way.",
      } satisfies ApiResponse);
      return;
    case "ASSISTANT_REPLY_UNREADABLE":
      res.status(502).json({
        status: "error",
        statusCode: 502,
        message: "The assistant's answer was not readable. Try again.",
      } satisfies ApiResponse);
      return;
    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled assistant reply error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export async function createAssistantReply(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return;
  }

  const query = EmptyAssistantQuerySchema.safeParse(req.query);
  if (!query.success) {
    respondValidationFailed(res, query.error);
    return;
  }

  const body = CreateAssistantReplySchema.safeParse(req.body);
  if (!body.success) {
    respondValidationFailed(res, body.error);
    return;
  }

  const result = await assistantService.createAssistantReply(req.user.id, body.data);
  if (!result.success) {
    mapAssistantReplyError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Reply ready.",
    data: result.value,
  } satisfies ApiResponse);
}

// ---- Premium AI: the viewer's own answer, and the admin queue ----

const DEFAULT_CLOUD_ACCESS_PAGE_SIZE = 20;

function respondSignInRequired(res: Response): void {
  res.status(401).json({
    status: "error",
    statusCode: 401,
    message: "Please sign in.",
  } satisfies ApiResponse);
}

function mapCloudAccessAdminError(
  res: Response,
  error: cloudAccessService.AssistantCloudAccessAdminError,
): void {
  switch (error.type) {
    case "PLATFORM_CAPABILITY_REQUIRED":
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "Platform capability required.",
        data: { capability: error.capability },
      } satisfies ApiResponse);
      return;
    case "INVALID_CURSOR":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "Invalid cursor.",
      } satisfies ApiResponse);
      return;
    case "USER_NOT_FOUND":
      // The capability was already proved, so naming the miss leaks nothing to a stranger.
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "No account uses that email.",
      } satisfies ApiResponse);
      return;
    case "ALREADY_GRANTED":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "That account already has Premium AI.",
      } satisfies ApiResponse);
      return;
    case "NOT_GRANTED":
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "That account does not have Premium AI.",
      } satisfies ApiResponse);
      return;
    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled Premium AI admin error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * `GET /assistant/cloud-access` — does the CALLER have Premium AI? The panel asks once, on open,
 * to decide whether chat is available when the browser has no on-device model.
 */
export async function getOwnCloudAccess(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondSignInRequired(res);
    return;
  }
  const query = EmptyAssistantQuerySchema.safeParse(req.query);
  if (!query.success) {
    respondValidationFailed(res, query.error);
    return;
  }
  const hasCloudAccess = await cloudAccessService.hasActiveCloudAccess(req.user.id);
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: hasCloudAccess ? "Premium AI is active." : "No Premium AI.",
    data: { hasCloudAccess },
  } satisfies ApiResponse);
}

export async function listCloudAccessGrants(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondSignInRequired(res);
    return;
  }
  const query = ListCloudAccessGrantsQuerySchema.safeParse(req.query);
  if (!query.success) {
    respondValidationFailed(res, query.error);
    return;
  }
  const result = await cloudAccessService.listActiveCloudAccessGrants(req.user.id, {
    limit: query.data.limit ?? DEFAULT_CLOUD_ACCESS_PAGE_SIZE,
    ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
  });
  if (!result.success) {
    mapCloudAccessAdminError(res, result.error);
    return;
  }
  // `nextCursor` as a SIBLING of `data`, the shape every keyset staff queue here answers with.
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Premium AI grants.",
    data: result.value.items,
    nextCursor: result.value.nextCursor,
  });
}

export async function grantCloudAccess(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondSignInRequired(res);
    return;
  }
  const query = EmptyAssistantQuerySchema.safeParse(req.query);
  if (!query.success) {
    respondValidationFailed(res, query.error);
    return;
  }
  const body = GrantCloudAccessSchema.safeParse(req.body);
  if (!body.success) {
    respondValidationFailed(res, body.error);
    return;
  }
  const result = await cloudAccessService.grantCloudAccess(req.user.id, body.data);
  if (!result.success) {
    mapCloudAccessAdminError(res, result.error);
    return;
  }
  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Premium AI granted.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function revokeCloudAccess(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondSignInRequired(res);
    return;
  }
  const params = CloudAccessUserIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    respondValidationFailed(res, params.error);
    return;
  }
  const query = EmptyAssistantQuerySchema.safeParse(req.query);
  if (!query.success) {
    respondValidationFailed(res, query.error);
    return;
  }
  const result = await cloudAccessService.revokeCloudAccess(req.user.id, params.data.userId);
  if (!result.success) {
    mapCloudAccessAdminError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Premium AI revoked.",
    data: result.value,
  } satisfies ApiResponse);
}
