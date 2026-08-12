import type { Request, Response } from "express";
import type { ZodError } from "zod";

import {
  firstParam,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/rnd/projects/project-error-response.js";
import {
  CommunityReportIdParamsSchema,
  CreateCommunityReportSchema,
  CreateForumReplySchema,
  CreateForumThreadSchema,
  DismissCommunityReportSchema,
  ForumReplyIdParamsSchema,
  ForumThreadIdParamsSchema,
  ForumThreadSlugParamsSchema,
  GetForumThreadQuerySchema,
  ListCommunityReportsQuerySchema,
  ListForumModerationQueueQuerySchema,
  ListForumThreadsQuerySchema,
  ListMyForumThreadsQuerySchema,
  ModerateForumReplySchema,
  ModerateForumThreadSchema,
  SetAcceptedReplySchema,
} from "#src/modules/store/community/community-forum.schemas.js";
import * as communityForumService from "#src/modules/store/community/community-forum.service.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * The business forum's HTTP boundary (§17).
 *
 * NO COPY HERE SAYS "POSTED", "LIVE" OR "PUBLISHED" ON A CREATE. `pending_review` is the
 * design, not a placeholder, and a success message that overstates it is the one way this
 * controller could reopen A10 on its own.
 */

function sendZodError(res: Response, error: ZodError): void {
  respondValidationFailed(res, error);
}

function mapForumError(res: Response, error: communityForumService.CommunityForumError): void {
  switch (error.type) {
    case "NOT_FOUND":
      res.status(404).json({ status: "error", statusCode: 404, message: "Thread not found." });
      return;
    case "FORBIDDEN":
      res
        .status(403)
        .json({ status: "error", statusCode: 403, message: "You cannot act on this thread." });
      return;
    case "INVALID_CURSOR":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "The pagination cursor could not be read.",
      });
      return;
    case "INVALID_STATE":
      res.status(409).json({ status: "error", statusCode: 409, message: error.message });
      return;
    case "CONFLICT":
      res.status(409).json({ status: "error", statusCode: 409, message: error.message });
      return;
    case "TITLE_UNUSABLE":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "This title has no letters or digits to build a link from.",
        errors: { title: ["Use a title with at least three letters or digits."] },
      });
      return;
    /**
     * 403 AND NEVER 404, and it names the capability rather than the role — the same shape
     * `PlatformAccessError` carries everywhere else. The refusal is decided before any id
     * is read, so it is byte-identical for a real thread id and a garbage one.
     */
    case "PLATFORM_CAPABILITY_REQUIRED":
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "Moderating community content requires the moderator or admin role.",
        data: { capability: error.capability },
      });
      return;
    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled community forum error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Public reads (mounted on /store)
// ---------------------------------------------------------------------------

export async function listForumThreads(req: Request, res: Response): Promise<void> {
  const query = ListForumThreadsQuerySchema.safeParse(req.query);
  if (!query.success) {
    sendZodError(res, query.error);
    return;
  }

  const result = await communityForumService.listForumThreads(query.data);
  if (!result.success) {
    mapForumError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Forum threads loaded.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function getForumThread(req: Request, res: Response): Promise<void> {
  const params = ForumThreadSlugParamsSchema.safeParse({
    threadSlug: firstParam(req.params.threadSlug),
  });
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const query = GetForumThreadQuerySchema.safeParse(req.query);
  if (!query.success) {
    sendZodError(res, query.error);
    return;
  }

  const result = await communityForumService.getForumThreadBySlug({
    threadSlug: params.data.threadSlug,
    /**
     * `attachOptionalUser` runs on the whole store router, so this resolves for a signed-in
     * reader and stays `null` otherwise — which is what makes the reply's `viewer` member
     * `null` rather than a defaulted `false`.
     */
    viewerUserId: req.user?.id ?? null,
    replyLimit: query.data.replyLimit,
    replyCursor: query.data.replyCursor,
  });
  if (!result.success) {
    mapForumError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Forum thread loaded.",
    data: result.value,
  } satisfies ApiResponse);
}

// ---------------------------------------------------------------------------
// Authenticated writes (mounted on /community)
// ---------------------------------------------------------------------------

export async function createForumThread(req: Request, res: Response): Promise<void> {
  const user = req.user;
  if (!user) {
    respondUnauthenticated(res);
    return;
  }

  const body = CreateForumThreadSchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await communityForumService.createForumThread({
    authorUserId: user.id,
    activeOrganizationId: req.authSession?.activeOrganizationId ?? null,
    board: body.data.board,
    title: body.data.title,
    body: body.data.body,
  });
  if (!result.success) {
    mapForumError(res, result.error);
    return;
  }

  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Thread queued for review.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function createForumReply(req: Request, res: Response): Promise<void> {
  const user = req.user;
  if (!user) {
    respondUnauthenticated(res);
    return;
  }

  const params = ForumThreadIdParamsSchema.safeParse({
    threadId: firstParam(req.params.threadId),
  });
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = CreateForumReplySchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await communityForumService.createForumReply({
    threadId: params.data.threadId,
    authorUserId: user.id,
    activeOrganizationId: req.authSession?.activeOrganizationId ?? null,
    body: body.data.body,
  });
  if (!result.success) {
    mapForumError(res, result.error);
    return;
  }

  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Reply posted.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function setAcceptedReply(req: Request, res: Response): Promise<void> {
  const user = req.user;
  if (!user) {
    respondUnauthenticated(res);
    return;
  }

  const params = ForumThreadIdParamsSchema.safeParse({
    threadId: firstParam(req.params.threadId),
  });
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = SetAcceptedReplySchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await communityForumService.setAcceptedReply({
    threadId: params.data.threadId,
    authorUserId: user.id,
    replyId: body.data.replyId,
  });
  if (!result.success) {
    mapForumError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Answer accepted.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function clearAcceptedReply(req: Request, res: Response): Promise<void> {
  const user = req.user;
  if (!user) {
    respondUnauthenticated(res);
    return;
  }

  const params = ForumThreadIdParamsSchema.safeParse({
    threadId: firstParam(req.params.threadId),
  });
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }

  const result = await communityForumService.setAcceptedReply({
    threadId: params.data.threadId,
    authorUserId: user.id,
    replyId: null,
  });
  if (!result.success) {
    mapForumError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Accepted answer cleared.",
    data: result.value,
  } satisfies ApiResponse);
}

/** `PUT` and `DELETE` share one handler because they differ by exactly one boolean. */
async function respondToHelpfulVote(
  req: Request,
  res: Response,
  isHelpful: boolean,
): Promise<void> {
  const user = req.user;
  if (!user) {
    respondUnauthenticated(res);
    return;
  }

  const params = ForumReplyIdParamsSchema.safeParse({ replyId: firstParam(req.params.replyId) });
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }

  const result = await communityForumService.setReplyHelpfulVote({
    replyId: params.data.replyId,
    userId: user.id,
    isHelpful,
  });
  if (!result.success) {
    mapForumError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: isHelpful ? "Reply endorsed." : "Endorsement withdrawn.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function endorseReply(req: Request, res: Response): Promise<void> {
  await respondToHelpfulVote(req, res, true);
}

export async function withdrawReplyEndorsement(req: Request, res: Response): Promise<void> {
  await respondToHelpfulVote(req, res, false);
}

export async function listMyForumThreads(req: Request, res: Response): Promise<void> {
  const user = req.user;
  if (!user) {
    respondUnauthenticated(res);
    return;
  }

  const query = ListMyForumThreadsQuerySchema.safeParse(req.query);
  if (!query.success) {
    sendZodError(res, query.error);
    return;
  }

  const result = await communityForumService.listMyForumThreads({
    authorUserId: user.id,
    limit: query.data.limit,
    cursor: query.data.cursor,
  });
  if (!result.success) {
    mapForumError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Your threads loaded.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function createCommunityReport(req: Request, res: Response): Promise<void> {
  const user = req.user;
  if (!user) {
    respondUnauthenticated(res);
    return;
  }

  const body = CreateCommunityReportSchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await communityForumService.createCommunityContentReport({
    targetKind: body.data.targetKind,
    targetId: body.data.targetId,
    reason: body.data.reason,
    detailText: body.data.detailText ?? null,
    reporterUserId: user.id,
  });
  if (!result.success) {
    mapForumError(res, result.error);
    return;
  }

  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Report received.",
    data: result.value,
  } satisfies ApiResponse);
}

// ---------------------------------------------------------------------------
// Moderation (§17.4)
// ---------------------------------------------------------------------------

export async function listForumModerationQueue(req: Request, res: Response): Promise<void> {
  const user = req.user;
  if (!user) {
    respondUnauthenticated(res);
    return;
  }

  const query = ListForumModerationQueueQuerySchema.safeParse(req.query);
  if (!query.success) {
    sendZodError(res, query.error);
    return;
  }

  const result = await communityForumService.listForumModerationQueue({
    moderatorUserId: user.id,
    limit: query.data.limit,
    cursor: query.data.cursor,
  });
  if (!result.success) {
    mapForumError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Moderation queue loaded.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function moderateForumThread(req: Request, res: Response): Promise<void> {
  const user = req.user;
  if (!user) {
    respondUnauthenticated(res);
    return;
  }

  const params = ForumThreadIdParamsSchema.safeParse({
    threadId: firstParam(req.params.threadId),
  });
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = ModerateForumThreadSchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await communityForumService.moderateForumThread({
    moderatorUserId: user.id,
    threadId: params.data.threadId,
    decision: body.data.decision,
    reasonNote: body.data.reasonNote,
  });
  if (!result.success) {
    mapForumError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Thread decision recorded.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function moderateForumReply(req: Request, res: Response): Promise<void> {
  const user = req.user;
  if (!user) {
    respondUnauthenticated(res);
    return;
  }

  const params = ForumReplyIdParamsSchema.safeParse({ replyId: firstParam(req.params.replyId) });
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = ModerateForumReplySchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await communityForumService.moderateForumReply({
    moderatorUserId: user.id,
    replyId: params.data.replyId,
    decision: body.data.decision,
    reasonNote: body.data.reasonNote,
  });
  if (!result.success) {
    mapForumError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Reply decision recorded.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function listCommunityReports(req: Request, res: Response): Promise<void> {
  const user = req.user;
  if (!user) {
    respondUnauthenticated(res);
    return;
  }

  const query = ListCommunityReportsQuerySchema.safeParse(req.query);
  if (!query.success) {
    sendZodError(res, query.error);
    return;
  }

  const result = await communityForumService.listCommunityContentReports({
    moderatorUserId: user.id,
    status: query.data.status,
    limit: query.data.limit,
    cursor: query.data.cursor,
  });
  if (!result.success) {
    mapForumError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Community reports loaded.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function dismissCommunityReport(req: Request, res: Response): Promise<void> {
  const user = req.user;
  if (!user) {
    respondUnauthenticated(res);
    return;
  }

  const params = CommunityReportIdParamsSchema.safeParse({
    reportId: firstParam(req.params.reportId),
  });
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = DismissCommunityReportSchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await communityForumService.dismissCommunityContentReport({
    moderatorUserId: user.id,
    reportId: params.data.reportId,
    reasonNote: body.data.reasonNote,
  });
  if (!result.success) {
    mapForumError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Report dismissed.",
    data: result.value,
  } satisfies ApiResponse);
}
