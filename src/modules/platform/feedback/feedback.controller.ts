import type { Request, Response } from "express";

import {
  CreatePlatformFeedbackSchema,
  EmptyPlatformFeedbackQuerySchema,
  ListPlatformFeedbackQuerySchema,
} from "#src/modules/platform/feedback/feedback.schemas.js";
import * as feedbackService from "#src/modules/platform/feedback/feedback.service.js";
import { respondValidationFailed } from "#src/modules/rnd/projects/project-error-response.js";
import type { ApiResponse } from "#src/types/index.js";

/** How many rows a page of the staff queue holds when the caller does not say. */
const DEFAULT_FEEDBACK_PAGE_SIZE = 20;

/**
 * The longest user agent this will store, matching `platform_feedback_user_agent_ck`.
 *
 * Real ones run to ~200 characters; the header is attacker-controlled and unbounded, so it
 * is cut here rather than allowed to reach a check constraint and turn one person's odd
 * browser into a 500.
 */
const USER_AGENT_MAX_LENGTH = 512;

function mapPlatformFeedbackError(
  res: Response,
  error: feedbackService.PlatformFeedbackError,
): void {
  switch (error.type) {
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
      throw new Error(`Unhandled platform feedback error: ${JSON.stringify(exhaustiveCheck)}`);
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

/** A stray query key is a 422 rather than an ignored parameter — the write is `.strict()`. */
function hasCleanQuery(req: Request, res: Response): boolean {
  const parsed = EmptyPlatformFeedbackQuerySchema.safeParse(req.query);
  if (parsed.success) return true;
  respondValidationFailed(res, parsed.error);
  return false;
}

/**
 * Reads the browser string off the request, never off the body.
 *
 * An empty header becomes NULL rather than an empty string: the column's check constraint
 * refuses a zero-length value, and "we do not know" is what null already means.
 */
function readBoundedUserAgent(req: Request): string | null {
  const headerValue = req.headers["user-agent"] ?? "";
  const bounded = headerValue.slice(0, USER_AGENT_MAX_LENGTH).trim();
  return bounded === "" ? null : bounded;
}

export async function createPlatformFeedback(req: Request, res: Response): Promise<void> {
  const authorUserId = requireSignedInUserId(req, res);
  if (!authorUserId) return;
  if (!hasCleanQuery(req, res)) return;

  const body = CreatePlatformFeedbackSchema.safeParse(req.body);
  if (!body.success) {
    respondValidationFailed(res, body.error);
    return;
  }

  const created = await feedbackService.createPlatformFeedback(authorUserId, {
    category: body.data.category,
    message: body.data.message,
    pagePath: body.data.pagePath,
    userAgent: readBoundedUserAgent(req),
  });

  // A 201 means a row exists — not that anybody has read it, and not that anything will
  // change because of it. No copy on this route may promise a reply or an outcome.
  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Feedback received. Thank you.",
    data: created,
  } satisfies ApiResponse);
}

export async function listPlatformFeedback(req: Request, res: Response): Promise<void> {
  const staffUserId = requireSignedInUserId(req, res);
  if (!staffUserId) return;

  const query = ListPlatformFeedbackQuerySchema.safeParse(req.query);
  if (!query.success) {
    respondValidationFailed(res, query.error);
    return;
  }

  const result = await feedbackService.listPlatformFeedback(staffUserId, {
    ...(query.data.status === undefined ? {} : { status: query.data.status }),
    limit: query.data.limit ?? DEFAULT_FEEDBACK_PAGE_SIZE,
    ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
  });
  if (!result.success) {
    mapPlatformFeedbackError(res, result.error);
    return;
  }

  // `nextCursor` as a SIBLING of `data`, not inside a pagination envelope: a keyset read has
  // no honest `total` to report.
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Feedback retrieved.",
    data: result.value.items,
    nextCursor: result.value.nextCursor,
  });
}
