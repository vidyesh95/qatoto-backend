import type { Request, Response } from "express";
import { z } from "zod";

import * as notificationsService from "#src/services/notifications.service.js";
import type { NotificationError } from "#src/services/notifications.service.js";
import type { ApiResponse } from "#src/types/index.js";
import { respondValidationFailed } from "#src/controllers/project-error-response.js";

/**
 * The caller's notification inbox (R_AND_D_BACKEND_STRUCTURE.md §11l.2 item 1).
 *
 * ROOT-MOUNTED AND CALLER-SCOPED, for the same reason `/applications/mine` and
 * `/invites/mine` are: a person's inbox belongs to a person, not to a project, and someone
 * arriving from an email holds no slug. The recipient is `req.user.id` in the WHERE clause
 * — there is no `?userId=` on any route here and there must never be one (§0).
 *
 * THE MAPPER IS LOCAL AND TINY. Two variants, both of which mean "that row is not yours or
 * does not exist"; a shared mapper would drag in four domains' unions to answer one 404.
 */

/**
 * `limit` is capped in the schema AND again in the service. The duplication is deliberate:
 * the schema protects the HTTP surface and the service protects every other caller of it,
 * including a future job.
 */
export const ListNotificationsQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

/**
 * THROUGH an id, never a list of ids. A client that has scrolled past a row has seen
 * everything above it, and a list grows with the backlog while racing anything that arrived
 * meanwhile. `throughMessageId` is what the workshop chat read state already calls this.
 */
export const MarkNotificationsReadSchema = z.object({ throughNotificationId: z.uuid() }).strict();

function respondNotificationError(res: Response, error: NotificationError): void {
  switch (error.type) {
    case "CURSOR_MALFORMED":
      // 422 and NEVER a silent first page: a client that restarts a feed it thought it was
      // paging shows duplicates and reports them as a backend bug (§11h).
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "Malformed cursor.",
      } satisfies ApiResponse);
      return;
    case "NOTIFICATION_NOT_FOUND":
      // Another person's notification id lands here too — the lookup is scoped to the
      // caller, so someone else's is indistinguishable from one that never existed.
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "Notification not found.",
      } satisfies ApiResponse);
      return;
    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled notification error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/** `GET /notifications` — keyset-paginated, newest first, with the unread badge. */
export async function listNotifications(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return;
  }

  const parsedQuery = ListNotificationsQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const page = await notificationsService.listNotifications(req.user.id, {
    cursor: parsedQuery.data.cursor,
    limit: parsedQuery.data.limit,
  });

  if (!page.success) {
    respondNotificationError(res, page.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Notifications loaded.",
    data: page.value,
  } satisfies ApiResponse);
}

/** `GET /notifications/unread-count` — the badge alone, on its own partial index. */
export async function getUnreadNotificationCount(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Unread notification count loaded.",
    data: { unreadCount: await notificationsService.countUnread(req.user.id) },
  } satisfies ApiResponse);
}

/** `POST /notifications/read` — marks everything through one notification read. */
export async function markNotificationsRead(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return;
  }

  const parsedBody = MarkNotificationsReadSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const marked = await notificationsService.markReadThrough(
    req.user.id,
    parsedBody.data.throughNotificationId,
  );

  if (!marked.success) {
    respondNotificationError(res, marked.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Notifications marked read.",
    data: marked.value,
  } satisfies ApiResponse);
}
