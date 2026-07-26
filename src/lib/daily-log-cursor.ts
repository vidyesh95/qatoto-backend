/**
 * The keyset cursor for the CROSS-PROJECT daily-log feed
 * (R_AND_D_BACKEND_STRUCTURE.md Appendix B2, §4c rule 4).
 *
 * WHY THIS IS A MODULE AND NOT A PRIVATE FUNCTION, unlike workshop chat's two-column
 * `(sentAt, id)` codec. The feed's ordering is THREE columns wide —
 * `(logDate DESC, submittedAt DESC, id DESC)` — and the first of them is a calendar DATE,
 * not an instant. `logDate` is the day a member CLAIMS they worked; `submittedAt` is when
 * they filed the log, often a different day and sometimes several days later. Collapsing
 * the two would reorder a backfilled log against the day it belongs to, so both travel in
 * the cursor and both appear in the predicate.
 *
 * WHY THE ORDERING NEEDS ALL THREE. `logDate` alone ties every time two members log the
 * same day. `(logDate, submittedAt)` still ties when two members submit inside the same
 * millisecond — Postgres stores microseconds, JS `Date` carries milliseconds — and a
 * cursor on a non-unique key SKIPS ROWS. Ending on `id` makes the tie total (§4c rule 4).
 *
 * OPAQUE BY CONVENTION, NOT BY ENCRYPTION, exactly as workshop chat's is: the cursor
 * carries no authorization and reveals nothing a member paging their own feed cannot
 * already see. The membership filter is re-derived from `project_member` on every request
 * and is never encoded here — a cursor that carried a project list would be a client-
 * supplied authorization input, which §0 forbids outright.
 */

/** `YYYY-MM-DD`, the §1 wire format for a date-only value. */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface DailyLogFeedCursor {
  /** Date-only ISO string, never a `Date` — reinterpreting it in a local zone shifts it. */
  readonly logDate: string;
  readonly submittedAt: Date;
  readonly id: string;
}

/**
 * `<logDate>_<submittedAtEpochMilliseconds>_<id>`.
 *
 * The id goes last and is never split on, so a uuid containing an underscore — or any
 * future id format that does — round-trips unharmed.
 */
export function encodeDailyLogFeedCursor(row: DailyLogFeedCursor): string {
  return `${row.logDate}_${String(row.submittedAt.getTime())}_${row.id}`;
}

/** Returns null for anything malformed; the caller answers `422 CURSOR_MALFORMED`. */
export function decodeDailyLogFeedCursor(rawCursor: string): DailyLogFeedCursor | null {
  const firstSeparatorIndex = rawCursor.indexOf("_");
  if (firstSeparatorIndex <= 0) return null;

  const secondSeparatorIndex = rawCursor.indexOf("_", firstSeparatorIndex + 1);
  if (secondSeparatorIndex <= firstSeparatorIndex + 1) return null;

  const logDate = rawCursor.slice(0, firstSeparatorIndex);
  const rawEpochMilliseconds = rawCursor.slice(firstSeparatorIndex + 1, secondSeparatorIndex);
  const id = rawCursor.slice(secondSeparatorIndex + 1);

  if (!ISO_DATE_PATTERN.test(logDate)) return null;
  if (id === "") return null;

  // `Number("")` is 0 and `Number(" 12 ")` is 12 — both would pass a bare isSafeInteger
  // check, so the digits are validated before the conversion rather than after it.
  if (!/^\d+$/.test(rawEpochMilliseconds)) return null;

  const epochMilliseconds = Number(rawEpochMilliseconds);
  if (!Number.isSafeInteger(epochMilliseconds)) return null;

  return { logDate, submittedAt: new Date(epochMilliseconds), id };
}
