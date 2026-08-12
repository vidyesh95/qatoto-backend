/**
 * A keyset cursor over `(calendarDate, id)` — the two-column shape whose first column is a
 * DATE rather than an instant (§4c rule 4).
 *
 * WHY A THIRD CURSOR MODULE. `instant-cursor.ts` is `(Date, id)` and `daily-log-cursor.ts` is
 * `(date, Date, id)`. Neither fits `listClaims`, which orders
 * `(claimedForDate DESC, id DESC)` where `claimedForDate` is a Postgres `date` read in
 * `mode: "string"` — a `YYYY-MM-DD` value that never becomes a `Date` on this side of the
 * wire. Reusing `InstantCursor` would mean parsing that string into a `Date` purely to
 * serialize it back, and a date-only value put through a `Date` is exactly how a day shifts
 * by one in a non-UTC zone. Reusing the three-column codec would mean every caller passing a
 * duplicate column.
 *
 * NO PRECISION HAZARD HERE, and that is the point of keeping this separate from
 * `instant-cursor.ts`. The other two codecs encode `Date.getTime()` and therefore depend on
 * their column being declared `timestamp(3)` — a cursor coarser than its column cannot
 * express a boundary and silently skips rows. A calendar date has no sub-unit to lose: the
 * string in the cursor is byte-identical to the string in the column.
 *
 * SAME THREE PROPERTIES as its two siblings, and each is load-bearing:
 *
 *   * **Plain text, not base64.** A cursor is not a secret and pretending otherwise
 *     encourages putting something in one that should be. It is also debuggable in a URL.
 *   * **Ends in a unique id.** Many claims share one `claimedForDate` — it is the day the
 *     work is claimed FOR, so a team of six filing for Monday produces six ties. A cursor
 *     keyed on the date alone would skip whichever rows lost the tie.
 *   * **Returns `null` rather than throwing** on anything malformed. The caller answers
 *     `422 CURSOR_MALFORMED`, which is the contract §11h already set — never a silent first
 *     page, because a client that silently restarts a feed shows duplicates and calls it a
 *     backend bug.
 */

/** `YYYY-MM-DD`, the §1 wire format for a date-only value. */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface DateCursor {
  /** Date-only ISO string, never a `Date` — reinterpreting it in a local zone shifts it. */
  readonly calendarDate: string;
  readonly id: string;
}

/**
 * `<calendarDate>_<id>`.
 *
 * The id goes last and is never split on, so a uuid containing an underscore — or any future
 * id format that does — round-trips unharmed.
 */
export function encodeDateCursor(row: DateCursor): string {
  return `${row.calendarDate}_${row.id}`;
}

/** Returns null for anything malformed; the caller answers `422 CURSOR_MALFORMED`. */
export function decodeDateCursor(rawCursor: string): DateCursor | null {
  const separatorIndex = rawCursor.indexOf("_");
  if (separatorIndex <= 0) return null;

  const calendarDate = rawCursor.slice(0, separatorIndex);
  const id = rawCursor.slice(separatorIndex + 1);

  // The pattern is a SHAPE check, not a calendar one: `2026-02-31` passes here and simply
  // matches no row. Rejecting it would mean reimplementing month lengths and leap years to
  // turn "returns nothing" into "returns 422", which is not a distinction a client can act on.
  if (!ISO_DATE_PATTERN.test(calendarDate)) return null;
  if (id === "") return null;

  return { calendarDate, id };
}
