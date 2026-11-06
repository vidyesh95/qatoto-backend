import { z } from "zod";

import { isTimeZoneValid } from "#src/modules/rnd/daily-log-reminders/daily-log-reminder-schedule.js";

/**
 * Both fields are optional because two callers want one each: the switch sends `isEnabled`, and
 * the log composer sends `timeZone` alone after a submit.
 */
export const UpdateDailyLogReminderSchema = z
  .object({
    isEnabled: z.boolean().optional(),
    timeZone: z.string().trim().min(1).max(64).refine(isTimeZoneValid).optional(),
  })
  .strict()
  .refine((input) => input.isEnabled !== undefined || input.timeZone !== undefined);

export const TurnOffDailyLogRemindersSchema = z
  .object({ token: z.string().trim().min(1).max(300) })
  .strict();

export type UpdateDailyLogReminderInput = z.infer<typeof UpdateDailyLogReminderSchema>;
