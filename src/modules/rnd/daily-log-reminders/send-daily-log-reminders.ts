import { and, eq, exists, gte, inArray, isNull, lt, max, or } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  dailyLog,
  dailyLogReminderPreference,
  dailyLogReminderSend,
  projectMember,
  researchProject,
  user,
} from "#src/db/schema.js";
import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import { enqueueNotifications } from "#src/modules/platform/notifications/notifications.service.js";
import {
  decideDailyLogReminder,
  FALLBACK_REMINDER_TIME_ZONE,
  isInsideReminderWindow,
  isTimeZoneValid,
  type ReminderDecision,
} from "#src/modules/rnd/daily-log-reminders/daily-log-reminder-schedule.js";

/** Rows answered this long ago no longer decide anything. Unanswered ones are the pause record. */
const ANSWERED_SEND_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;

export interface DailyLogReminderCandidate {
  readonly projectMemberId: string;
  readonly userId: string;
  readonly projectId: string;
  readonly timeZone: string;
  readonly decision: ReminderDecision;
}

/**
 * Everyone whose 7 pm is now, and what should happen to each of them.
 *
 * READ-ONLY AND SEPARATE FROM THE WRITES, so an operator can ask "who would this reach at this
 * instant" against real data without sending anything.
 */
export async function selectDailyLogReminderCandidates(
  asOf: Date,
): Promise<readonly DailyLogReminderCandidate[]> {
  const memberRows = await db
    .select({
      projectMemberId: projectMember.id,
      userId: projectMember.userId,
      projectId: projectMember.projectId,
      savedTimeZone: dailyLogReminderPreference.timeZone,
    })
    .from(projectMember)
    .innerJoin(researchProject, eq(researchProject.id, projectMember.projectId))
    .innerJoin(user, eq(user.id, projectMember.userId))
    .leftJoin(
      dailyLogReminderPreference,
      eq(dailyLogReminderPreference.userId, projectMember.userId),
    )
    .where(
      and(
        eq(projectMember.status, "active"),
        eq(researchProject.status, "active"),
        isNull(user.deactivatedAt),
        // No row means the default, which is on.
        or(
          isNull(dailyLogReminderPreference.userId),
          eq(dailyLogReminderPreference.isEnabled, true),
        ),
      ),
    );

  const dueMembers = memberRows.flatMap((memberRow) => {
    // A stored zone was valid when written, but `Intl` data changes. One retired zone must not
    // stop every other member's reminder.
    const timeZone =
      memberRow.savedTimeZone !== null && isTimeZoneValid(memberRow.savedTimeZone)
        ? memberRow.savedTimeZone
        : FALLBACK_REMINDER_TIME_ZONE;
    return isInsideReminderWindow(asOf, timeZone) ? [{ ...memberRow, timeZone }] : [];
  });
  if (dueMembers.length === 0) return [];

  const dueMemberIds = dueMembers.map((dueMember) => dueMember.projectMemberId);

  const latestLogRows = await db
    .select({
      projectMemberId: dailyLog.authorMemberId,
      latestLogDate: max(dailyLog.logDate),
      latestSubmittedAt: max(dailyLog.submittedAt),
    })
    .from(dailyLog)
    .where(and(inArray(dailyLog.authorMemberId, dueMemberIds), eq(dailyLog.status, "submitted")))
    .groupBy(dailyLog.authorMemberId);
  const latestLogByMember = new Map(latestLogRows.map((row) => [row.projectMemberId, row]));

  const sendRows = await db
    .select({
      projectMemberId: dailyLogReminderSend.projectMemberId,
      reminderDate: dailyLogReminderSend.reminderDate,
    })
    .from(dailyLogReminderSend)
    .where(inArray(dailyLogReminderSend.projectMemberId, dueMemberIds));

  return dueMembers.map((dueMember) => {
    const latestLog = latestLogByMember.get(dueMember.projectMemberId);
    return {
      projectMemberId: dueMember.projectMemberId,
      userId: dueMember.userId,
      projectId: dueMember.projectId,
      timeZone: dueMember.timeZone,
      decision: decideDailyLogReminder({
        asOf,
        timeZone: dueMember.timeZone,
        latestLogDate: latestLog?.latestLogDate ?? null,
        latestSubmittedAt: latestLog?.latestSubmittedAt ?? null,
        reminderDates: sendRows
          .filter((sendRow) => sendRow.projectMemberId === dueMember.projectMemberId)
          .map((sendRow) => sendRow.reminderDate),
      }),
    };
  });
}

/**
 * The daily log reminder run.
 *
 * It nudges and nothing more: it writes no effort, no slices and no streak, and no reader of a
 * reminder row exists outside this module. Whether anyone logged has no effect on their pay.
 *
 * IDEMPOTENT: the send row's primary key makes a replay of the same `asOf` a no-op. The row and the
 * notification share a transaction, so a person is never recorded as reminded without being told.
 */
export async function handleSendDailyLogReminders(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.sendDailyLogReminders,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.sendDailyLogReminders],
    rawPayload,
  );
  const asOf = new Date(payload.asOf);

  for (const candidate of await selectDailyLogReminderCandidates(asOf)) {
    const { decision } = candidate;
    if (decision.outcome !== "send") continue;

    await db.transaction(async (tx) => {
      const [insertedSend] = await tx
        .insert(dailyLogReminderSend)
        .values({
          projectMemberId: candidate.projectMemberId,
          reminderDate: decision.reminderDate,
        })
        .onConflictDoNothing()
        .returning({ projectMemberId: dailyLogReminderSend.projectMemberId });
      if (!insertedSend) return;

      await enqueueNotifications(tx, null, [
        {
          recipientUserId: candidate.userId,
          kind: "daily_log_reminder",
          projectId: candidate.projectId,
          payload: { reminderDate: decision.reminderDate },
        },
      ]);
    });
  }

  // Only rows a later log has answered. Deleting by age alone would quietly lift the pause on
  // somebody who stopped logging a month ago and start reminding them again.
  const retentionCutoffDate = new Date(asOf.getTime() - ANSWERED_SEND_RETENTION_MILLISECONDS)
    .toISOString()
    .slice(0, 10);
  await db.delete(dailyLogReminderSend).where(
    and(
      lt(dailyLogReminderSend.reminderDate, retentionCutoffDate),
      exists(
        db
          .select({ id: dailyLog.id })
          .from(dailyLog)
          .where(
            and(
              eq(dailyLog.authorMemberId, dailyLogReminderSend.projectMemberId),
              eq(dailyLog.status, "submitted"),
              gte(dailyLog.logDate, dailyLogReminderSend.reminderDate),
            ),
          ),
      ),
    ),
  );
}
