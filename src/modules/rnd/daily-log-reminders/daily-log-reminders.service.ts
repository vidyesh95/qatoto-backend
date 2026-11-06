import { eq } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { dailyLogReminderPreference } from "#src/db/schema.js";
import type { UpdateDailyLogReminderInput } from "#src/modules/rnd/daily-log-reminders/daily-log-reminders.schemas.js";

export interface DailyLogReminderView {
  readonly isEnabled: boolean;
  readonly timeZone: string | null;
}

/** A person with no row has never changed anything, and the default is on. */
export async function readDailyLogReminder(userId: string): Promise<DailyLogReminderView> {
  const [row] = await db
    .select({
      isEnabled: dailyLogReminderPreference.isEnabled,
      timeZone: dailyLogReminderPreference.timeZone,
    })
    .from(dailyLogReminderPreference)
    .where(eq(dailyLogReminderPreference.userId, userId));

  return row ?? { isEnabled: true, timeZone: null };
}

/** An omitted field keeps its value, so a composer saving a zone can never switch reminders back on. */
export async function updateDailyLogReminder(
  userId: string,
  input: UpdateDailyLogReminderInput,
): Promise<DailyLogReminderView> {
  const changedFields = {
    ...(input.isEnabled === undefined ? {} : { isEnabled: input.isEnabled }),
    ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
  };

  await db
    .insert(dailyLogReminderPreference)
    .values({ userId, ...changedFields })
    .onConflictDoUpdate({ target: dailyLogReminderPreference.userId, set: changedFields });

  return readDailyLogReminder(userId);
}
