import express from "express";

import { compactBody } from "#src/middleware/json-body.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import * as notificationsController from "#src/modules/platform/notifications/notifications.controller.js";

const router = express.Router();

/**
 * Notifications (R_AND_D_BACKEND_STRUCTURE.md §11l.2 item 1).
 *
 * ROOT-MOUNTED, for the reason `applicationInboxRouter` is: a person's inbox holds no
 * project slug, and someone arriving from an email has not picked a project.
 *
 * EVERY ROUTE IS `requireAuth` AND CALLER-SCOPED IN SQL. There is no `?userId=`, no
 * `/notifications/:userId`, and no moderator view — an inbox is the one surface in this
 * codebase where "whose is it" has exactly one answer (§0).
 *
 * NO `requireIdentifiedUser`: reading your own notifications mints no equity and moves no
 * money, and an anonymous session that somehow accumulated notifications should still be
 * able to read them.
 *
 * ROUTE ORDER: `/notifications/unread-count` is a LITERAL and is declared before anything
 * parameterised under `/notifications`. There is no `/notifications/:notificationId` today;
 * if one is added it goes BELOW that line.
 *
 * NO DELETE, deliberately. A notification is marked read, not erased: "I have seen this"
 * and "this never happened" are different facts, and only one of them is true. If an inbox
 * ever needs pruning it is a retention job with a stated window, not a per-row verb.
 */

router.get(
  "/notifications/unread-count",
  requireAuth,
  notificationsController.getUnreadNotificationCount,
);

router.get("/notifications", requireAuth, notificationsController.listNotifications);

router.post(
  "/notifications/read",
  requireAuth,
  compactBody,
  notificationsController.markNotificationsRead,
);

export default router;
