import type { Request, Response } from "express";

import {
  CreateAssistantReplySchema,
  EmptyAssistantQuerySchema,
} from "#src/modules/assistant/assistant.schemas.js";
import * as assistantService from "#src/modules/assistant/assistant.service.js";
import { respondValidationFailed } from "#src/modules/rnd/projects/project-error-response.js";
import type { ApiResponse } from "#src/types/index.js";

function mapAssistantReplyError(res: Response, error: assistantService.AssistantReplyError): void {
  switch (error.type) {
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

  const result = await assistantService.createAssistantReply(body.data);
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
