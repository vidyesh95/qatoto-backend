import type { Request, Response } from "express";
import { z } from "zod";

import { respondValidationFailed } from "#src/modules/rnd/projects/project-error-response.js";
import {
  AppendMessageBodySchema,
  CreateThreadBodySchema,
  ListMessagesQuerySchema,
  ListThreadsQuerySchema,
  ThreadParamsSchema,
} from "#src/schemas/commerce-messages.schemas.js";
import * as commerceMessagesService from "#src/services/commerce-messages.service.js";
import type { ApiResponse } from "#src/types/index.js";

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

function requireCommerceContext(
  req: Request,
  res: Response,
): {
  readonly userId: string;
  readonly organizationId: string;
  readonly memberId: string;
} | null {
  // §14. Messaging runs on a possibly-`pending` workspace since Phase 21. Thread scoping is
  // unchanged — `assertThreadParticipant` still proves membership of the specific thread.
  const messagingActor = req.buyerCommerceWorkspace ?? req.commerceOrganization;
  if (!req.user || !messagingActor) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return null;
  }

  return {
    userId: req.user.id,
    organizationId: messagingActor.organizationId,
    memberId: messagingActor.memberId,
  };
}

function mapMessagesError(
  res: Response,
  error: commerceMessagesService.CommerceMessagesError,
): void {
  switch (error.type) {
    case "NOT_FOUND":
    case "FORBIDDEN":
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "Not found.",
      } satisfies ApiResponse);
      return;
    case "VALIDATION_FAILED":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: error.message,
      } satisfies ApiResponse);
      return;
    case "DOCUMENT_NOT_OWNED":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "One or more attachments are not available to this organization.",
      } satisfies ApiResponse);
      return;
    default: {
      const exhaustiveError: never = error;
      throw new Error(`Unhandled commerce messages error: ${JSON.stringify(exhaustiveError)}`);
    }
  }
}

export async function createOrGetThread(req: Request, res: Response): Promise<void> {
  const commerceContext = requireCommerceContext(req, res);
  if (!commerceContext) return;

  const parsedBody = CreateThreadBodySchema.safeParse(req.body);
  if (!parsedBody.success) {
    sendZodError(res, parsedBody.error);
    return;
  }

  const result = await commerceMessagesService.createOrGetThread({
    resourceKind: parsedBody.data.resourceKind,
    resourceId: parsedBody.data.resourceId,
    organizationId: commerceContext.organizationId,
    memberId: commerceContext.memberId,
    actorUserId: commerceContext.userId,
  });
  if (!result.success) {
    mapMessagesError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Commerce thread ready.",
    data: result.value,
  } satisfies ApiResponse);
}

/**
 * GET /commerce/threads — the inbox (Appendix A38).
 *
 * The read that made messaging buildable. `POST /commerce/threads` returned a `threadId` and
 * nothing else ever yielded one, so a reload lost every conversation. It also unblocks §14's
 * settlement agreements, whose routes are keyed on the same id.
 */
export async function listThreads(req: Request, res: Response): Promise<void> {
  const commerceContext = requireCommerceContext(req, res);
  if (!commerceContext) return;

  const parsedQuery = ListThreadsQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    sendZodError(res, parsedQuery.error);
    return;
  }

  const result = await commerceMessagesService.listThreadsForOrganization({
    organizationId: commerceContext.organizationId,
    resourceKind: parsedQuery.data.resourceKind,
    cursor: parsedQuery.data.cursor,
    limit: parsedQuery.data.limit,
  });
  if (!result.success) {
    mapMessagesError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Commerce threads listed.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function listMessages(req: Request, res: Response): Promise<void> {
  const commerceContext = requireCommerceContext(req, res);
  if (!commerceContext) return;

  const parsedParams = ThreadParamsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    sendZodError(res, parsedParams.error);
    return;
  }

  const parsedQuery = ListMessagesQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    sendZodError(res, parsedQuery.error);
    return;
  }

  const result = await commerceMessagesService.listMessages({
    threadId: parsedParams.data.threadId,
    organizationId: commerceContext.organizationId,
    cursor: parsedQuery.data.cursor,
    limit: parsedQuery.data.limit,
  });
  if (!result.success) {
    mapMessagesError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Commerce messages listed.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function appendMessage(req: Request, res: Response): Promise<void> {
  const commerceContext = requireCommerceContext(req, res);
  if (!commerceContext) return;

  const parsedParams = ThreadParamsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    sendZodError(res, parsedParams.error);
    return;
  }

  const parsedBody = AppendMessageBodySchema.safeParse(req.body);
  if (!parsedBody.success) {
    sendZodError(res, parsedBody.error);
    return;
  }

  const result = await commerceMessagesService.appendMessage({
    threadId: parsedParams.data.threadId,
    organizationId: commerceContext.organizationId,
    memberId: commerceContext.memberId,
    bodyText: parsedBody.data.bodyText,
    encryptedDocumentIds: parsedBody.data.encryptedDocumentIds,
  });
  if (!result.success) {
    mapMessagesError(res, result.error);
    return;
  }

  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Commerce message appended.",
    data: result.value,
  } satisfies ApiResponse);
}
