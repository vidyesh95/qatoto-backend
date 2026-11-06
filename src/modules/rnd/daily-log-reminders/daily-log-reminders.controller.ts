import type { Request, Response } from "express";

import { readDailyLogReminderOffToken } from "#src/modules/rnd/daily-log-reminders/daily-log-reminder-token.js";
import {
  TurnOffDailyLogRemindersSchema,
  UpdateDailyLogReminderSchema,
} from "#src/modules/rnd/daily-log-reminders/daily-log-reminders.schemas.js";
import * as dailyLogRemindersService from "#src/modules/rnd/daily-log-reminders/daily-log-reminders.service.js";
import { respondValidationFailed } from "#src/modules/rnd/projects/project-error-response.js";
import type { ApiResponse } from "#src/types/index.js";

function respondSignInRequired(res: Response): void {
  res.status(401).json({
    status: "error",
    statusCode: 401,
    message: "Please sign in.",
  } satisfies ApiResponse);
}

/** `GET /daily-log-reminders/me`. */
export async function getDailyLogReminder(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondSignInRequired(res);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Reminder setting loaded.",
    data: await dailyLogRemindersService.readDailyLogReminder(req.user.id),
  } satisfies ApiResponse);
}

/** `PUT /daily-log-reminders/me`. */
export async function updateDailyLogReminder(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondSignInRequired(res);
    return;
  }

  const parsedBody = UpdateDailyLogReminderSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Reminder setting saved.",
    data: await dailyLogRemindersService.updateDailyLogReminder(req.user.id, parsedBody.data),
  } satisfies ApiResponse);
}

/** `POST /daily-log-reminders/off`. The signed token is the authorization. */
export async function turnOffDailyLogReminders(req: Request, res: Response): Promise<void> {
  const parsedBody = TurnOffDailyLogRemindersSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const userId = readDailyLogReminderOffToken(parsedBody.data.token);
  if (userId === null) {
    res.status(422).json({
      status: "error",
      statusCode: 422,
      message: "This link is not valid.",
    } satisfies ApiResponse);
    return;
  }

  await dailyLogRemindersService.updateDailyLogReminder(userId, { isEnabled: false });

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Daily log reminders are off.",
    data: { isEnabled: false },
  } satisfies ApiResponse);
}
