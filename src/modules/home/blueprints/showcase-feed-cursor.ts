/**
 * A keyset cursor over the public showcase feed, in the two orders that feed offers.
 *
 * WHY A FOURTH CURSOR MODULE, when `instant-cursor.ts`, `daily-log-cursor.ts` and
 * `store-cursor.ts` already exist. Neither of the close ones fits:
 *
 *   * `instant-cursor.ts` is `(instant, id)`, which is exactly the `newest` order — but it cannot
 *     carry the `top` order, whose leading key is an integer vote count with the instant demoted to
 *     a tie-break. A three-column cursor with a sometimes-ignored column is a cursor that lies
 *     about which order minted it.
 *   * `decodeTimestampStoreCursor` pins its sort key to an ISO string with a regex, and `top`'s
 *     leading key is a plain integer.
 *
 * THE SORT IS IN THE CURSOR, and that is the point rather than a detail. The two orders are not
 * interchangeable, so a cursor minted under `newest` and replayed under `?sort=top` has to be
 * REFUSED, not silently honoured — resuming a vote-ranked page from a date-ranked position skips
 * and repeats rows, and the reader sees a feed that duplicates and calls it a backend bug. The
 * leading discriminator means that refusal costs one character comparison, before any digit is
 * parsed and without a database round trip.
 *
 * SAME THREE PROPERTIES the sibling codecs state, each load-bearing:
 *
 *   * **Plain text, not base64.** A cursor is not a secret, and pretending otherwise encourages
 *     putting something in one that should be. It is also debuggable in a URL.
 *   * **Ends in a unique id.** Two launches can share a millisecond, and thousands can share a vote
 *     count; a cursor keyed on a non-unique column skips whichever row loses the tie.
 *   * **Returns `null` rather than throwing** on anything malformed. The caller answers 422 — never
 *     a silent first page.
 */

/** Matches the frontend's `SHOWCASE_SORTS`, which is why these are the wire values. */
export type ShowcaseFeedSort = "newest" | "top";

export type ShowcaseFeedCursor =
  | { readonly sort: "newest"; readonly launchedAt: Date; readonly id: string }
  | {
      readonly sort: "top";
      readonly upvoteCount: number;
      readonly launchedAt: Date;
      readonly id: string;
    };

/**
 * One character per sort, so the discriminator can never collide with a digit and the arity of the
 * rest of the cursor is known before it is split.
 */
const SORT_PREFIXES: Readonly<Record<ShowcaseFeedSort, string>> = { newest: "n", top: "t" };

/**
 * `n_<epochMilliseconds>_<id>` or `t_<upvoteCount>_<epochMilliseconds>_<id>`.
 *
 * The id goes last and is never split on, so an id containing an underscore round-trips unharmed.
 */
export function encodeShowcaseFeedCursor(cursor: ShowcaseFeedCursor): string {
  const launchedAtEpoch = String(cursor.launchedAt.getTime());

  switch (cursor.sort) {
    case "newest":
      return `${SORT_PREFIXES.newest}_${launchedAtEpoch}_${cursor.id}`;
    case "top":
      return `${SORT_PREFIXES.top}_${String(cursor.upvoteCount)}_${launchedAtEpoch}_${cursor.id}`;
    default: {
      const exhaustiveCheck: never = cursor;
      throw new Error(`Unhandled showcase feed cursor: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * `Number("")` is 0 and `Number(" 12 ")` is 12, so the digits are validated BEFORE the conversion
 * rather than after it — the trap `instant-cursor.ts` documents.
 */
function parseWholeNumber(rawValue: string): number | null {
  if (!/^\d+$/.test(rawValue)) return null;
  const parsedValue = Number(rawValue);
  return Number.isSafeInteger(parsedValue) ? parsedValue : null;
}

/**
 * Returns `null` for anything malformed OR minted under a different sort; the caller answers 422.
 *
 * `expectedSort` is required rather than inferred from the cursor, so a cursor carrying a sort the
 * request did not ask for is a refusal rather than a silent change of ordering.
 */
export function decodeShowcaseFeedCursor(
  rawCursor: string,
  expectedSort: ShowcaseFeedSort,
): ShowcaseFeedCursor | null {
  const expectedPrefix = `${SORT_PREFIXES[expectedSort]}_`;
  if (!rawCursor.startsWith(expectedPrefix)) return null;
  const payload = rawCursor.slice(expectedPrefix.length);

  switch (expectedSort) {
    case "newest": {
      const separatorIndex = payload.indexOf("_");
      if (separatorIndex <= 0) return null;

      const launchedAtEpoch = parseWholeNumber(payload.slice(0, separatorIndex));
      const id = payload.slice(separatorIndex + 1);
      if (launchedAtEpoch === null || id === "") return null;

      return { sort: "newest", launchedAt: new Date(launchedAtEpoch), id };
    }
    case "top": {
      const voteSeparatorIndex = payload.indexOf("_");
      if (voteSeparatorIndex <= 0) return null;
      const instantSeparatorIndex = payload.indexOf("_", voteSeparatorIndex + 1);
      if (instantSeparatorIndex <= voteSeparatorIndex + 1) return null;

      const upvoteCount = parseWholeNumber(payload.slice(0, voteSeparatorIndex));
      const launchedAtEpoch = parseWholeNumber(
        payload.slice(voteSeparatorIndex + 1, instantSeparatorIndex),
      );
      const id = payload.slice(instantSeparatorIndex + 1);
      if (upvoteCount === null || launchedAtEpoch === null || id === "") return null;

      return { sort: "top", upvoteCount, launchedAt: new Date(launchedAtEpoch), id };
    }
    default: {
      const exhaustiveCheck: never = expectedSort;
      throw new Error(`Unhandled showcase feed sort: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}
