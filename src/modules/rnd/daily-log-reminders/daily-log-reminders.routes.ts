import express from "express";

import { compactBody } from "#src/middleware/json-body.js";
import {
  dailyLogReminderOffLimiter,
  dailyLogReminderPreferenceLimiter,
} from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import * as dailyLogRemindersController from "#src/modules/rnd/daily-log-reminders/daily-log-reminders.controller.js";

const router = express.Router();

/**
 * Daily log reminder settings. Root-mounted, like the notification inbox: a setting belongs to a
 * person, and there is no `?userId=`.
 *
 * `/off` IS THE ONE ROUTE WITH NO SESSION, because it is reached from an email. Its signed token
 * can do exactly one thing, which is turn a reminder off. It is a POST so that a mail scanner
 * following the link in an email cannot change anything.
 */
router.get("/daily-log-reminders/me", requireAuth, dailyLogRemindersController.getDailyLogReminder);

router.put(
  "/daily-log-reminders/me",
  requireAuth,
  dailyLogReminderPreferenceLimiter,
  compactBody,
  dailyLogRemindersController.updateDailyLogReminder,
);

router.post(
  "/daily-log-reminders/off",
  dailyLogReminderOffLimiter,
  compactBody,
  dailyLogRemindersController.turnOffDailyLogReminders,
);

export default router;
