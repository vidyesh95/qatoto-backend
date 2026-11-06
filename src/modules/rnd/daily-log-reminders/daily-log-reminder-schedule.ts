import { calendarDateIn, type IsoDate } from "#src/lib/daily-log-streak.js";

/**
 * The rules for who gets a reminder, as pure functions, so they can be read and replayed against
 * any instant without a database.
 */

/** The zone before a browser reports one. Qatoto's first audience is in India. */
export const FALLBACK_REMINDER_TIME_ZONE = "Asia/Kolkata";

const REMINDER_LOCAL_HOUR = 19;
const REMINDER_WINDOW_MINUTES = 30;
/** Three unanswered reminders is a person who has stepped away, and a fourth is spam. */
const MAXIMUM_UNANSWERED_REMINDERS = 3;
/** Covers a log written late last night that was dated for the day before. */
const RECENT_LOG_MILLISECONDS = 20 * 60 * 60 * 1_000;

export function isTimeZoneValid(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

/** Whether `instant` falls inside this zone's 19:00 to 19:29. */
export function isInsideReminderWindow(instant: Date, timeZone: string): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);

  const readPart = (partType: "hour" | "minute"): number =>
    Number(parts.find((part) => part.type === partType)?.value);

  return readPart("hour") === REMINDER_LOCAL_HOUR && readPart("minute") < REMINDER_WINDOW_MINUTES;
}

export type ReminderDecision =
  | { readonly outcome: "send"; readonly reminderDate: IsoDate }
  | { readonly outcome: "already_logged" }
  | { readonly outcome: "already_reminded" }
  | { readonly outcome: "paused" };

export function decideDailyLogReminder(input: {
  readonly asOf: Date;
  readonly timeZone: string;
  /** The newest submitted log's claimed day. Drafts never count: nobody has seen a draft. */
  readonly latestLogDate: IsoDate | null;
  readonly latestSubmittedAt: Date | null;
  readonly reminderDates: readonly IsoDate[];
}): ReminderDecision {
  const { asOf, timeZone, latestLogDate, latestSubmittedAt, reminderDates } = input;
  const reminderDate = calendarDateIn(asOf, timeZone);

  // `>=`, not `===`: the date is typed by the person, and a log dated tomorrow in a project's UTC
  // day can be tonight's log for somebody west of Greenwich.
  const hasLoggedForToday = latestLogDate !== null && latestLogDate >= reminderDate;
  const hasLoggedRecently =
    latestSubmittedAt !== null &&
    asOf.getTime() - latestSubmittedAt.getTime() < RECENT_LOG_MILLISECONDS;
  if (hasLoggedForToday || hasLoggedRecently) return { outcome: "already_logged" };

  if (reminderDates.includes(reminderDate)) return { outcome: "already_reminded" };

  // A log filed late for an old day still answers the reminders before it, so the day it was
  // SUBMITTED counts as well as the day it claims.
  const submittedDate =
    latestSubmittedAt === null ? null : calendarDateIn(latestSubmittedAt, timeZone);
  const lastActivityDate = [latestLogDate, submittedDate].reduce<IsoDate | null>(
    (latestSoFar, candidate) =>
      candidate !== null && (latestSoFar === null || candidate > latestSoFar)
        ? candidate
        : latestSoFar,
    null,
  );

  const unansweredReminderCount = reminderDates.filter(
    (date) => lastActivityDate === null || date > lastActivityDate,
  ).length;
  if (unansweredReminderCount >= MAXIMUM_UNANSWERED_REMINDERS) return { outcome: "paused" };

  return { outcome: "send", reminderDate };
}
