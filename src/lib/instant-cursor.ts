/**
 * A keyset cursor over `(instant, id)` — the two-column shape (§4c rule 4).
 *
 * WHY A SECOND CURSOR MODULE. `daily-log-cursor.ts` is three columns wide because a daily
 * log has two different timestamps that disagree on any backfilled row: `logDate` is the day
 * CLAIMED and `submittedAt` is when it was filed. Nothing else in the domain has that
 * problem — a notification, a ledger entry and a chat message each have exactly one instant
 * — so generalizing that codec would mean every caller passing a duplicate column.
 *
 * SAME THREE PROPERTIES as the three-column one, and each is load-bearing:
 *
 *   * **Plain text, not base64.** A cursor is not a secret and pretending otherwise
 *     encourages putting something in one that should be. It is also debuggable in a URL.
 *   * **Ends in a unique id.** Two rows can share a millisecond; a cursor keyed on a
 *     non-unique column skips whichever one loses the tie.
 *   * **Returns `null` rather than throwing** on anything malformed. The caller answers
 *     `422 CURSOR_MALFORMED`, which is the contract §11h already set — never a silent first
 *     page, because a client that silently restarts a feed shows duplicates and calls it a
 *     backend bug.
 */

export interface InstantCursor {
  readonly instant: Date;
  readonly id: string;
}

/**
 * `<epochMilliseconds>_<id>`.
 *
 * The id goes last and is never split on, so an id containing an underscore round-trips
 * unharmed.
 */
export function encodeInstantCursor(row: InstantCursor): string {
  return `${String(row.instant.getTime())}_${row.id}`;
}

/** Returns null for anything malformed; the caller answers `422 CURSOR_MALFORMED`. */
export function decodeInstantCursor(rawCursor: string): InstantCursor | null {
  const separatorIndex = rawCursor.indexOf("_");
  if (separatorIndex <= 0) return null;

  const rawEpochMilliseconds = rawCursor.slice(0, separatorIndex);
  const id = rawCursor.slice(separatorIndex + 1);

  if (id === "") return null;

  // `Number("")` is 0 and `Number(" 12 ")` is 12 — both would pass a bare isSafeInteger
  // check, so the digits are validated before the conversion rather than after it.
  if (!/^\d+$/.test(rawEpochMilliseconds)) return null;

  const epochMilliseconds = Number(rawEpochMilliseconds);
  if (!Number.isSafeInteger(epochMilliseconds)) return null;

  return { instant: new Date(epochMilliseconds), id };
}
