/**
 * A keyset cursor over a research programme's discussion feed, in the two orders it offers.
 *
 * The `showcase-feed-cursor.ts` shape, for the same reasons: `instant-cursor.ts` is `(instant, id)`,
 * which is exactly `newest` but cannot carry `trending`, whose leading key is the stored
 * `trending_score` with the instant demoted to a tie-break.
 *
 * THE SORT IS IN THE CURSOR. A cursor minted under `newest` and replayed under `?sort=trending`
 * (or the reverse) is REFUSED — resuming a score-ranked page from a date-ranked position skips and
 * repeats rows. The one-character prefix makes that refusal cost a comparison.
 *
 * Plain text, ends in the unique id (never split on, so an id with an underscore survives), and
 * `null` rather than a throw on anything malformed — the controller answers 422.
 */

export type ProgramPostFeedSort = "newest" | "trending";

export type ProgramPostFeedCursor =
  | { readonly sort: "newest"; readonly createdAt: Date; readonly id: string }
  | {
      readonly sort: "trending";
      readonly trendingScore: number;
      readonly createdAt: Date;
      readonly id: string;
    };

const SORT_PREFIXES: Readonly<Record<ProgramPostFeedSort, string>> = {
  newest: "n",
  trending: "t",
};

/** `n_<epochMilliseconds>_<id>` or `t_<trendingScore>_<epochMilliseconds>_<id>`. */
export function encodeProgramPostFeedCursor(cursor: ProgramPostFeedCursor): string {
  const createdAtEpoch = String(cursor.createdAt.getTime());
  switch (cursor.sort) {
    case "newest":
      return `${SORT_PREFIXES.newest}_${createdAtEpoch}_${cursor.id}`;
    case "trending":
      return `${SORT_PREFIXES.trending}_${String(cursor.trendingScore)}_${createdAtEpoch}_${cursor.id}`;
    default: {
      const exhaustiveCheck: never = cursor;
      throw new Error(`Unhandled programme post cursor: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/** Digits validated BEFORE `Number()`, which reads `""` as 0 — the `instant-cursor.ts` trap. */
function parseWholeNumber(rawValue: string): number | null {
  if (!/^\d+$/.test(rawValue)) return null;
  const parsedValue = Number(rawValue);
  return Number.isSafeInteger(parsedValue) ? parsedValue : null;
}

/** `null` for anything malformed OR minted under the other sort; the caller answers 422. */
export function decodeProgramPostFeedCursor(
  rawCursor: string,
  expectedSort: ProgramPostFeedSort,
): ProgramPostFeedCursor | null {
  const expectedPrefix = `${SORT_PREFIXES[expectedSort]}_`;
  if (!rawCursor.startsWith(expectedPrefix)) return null;
  const payload = rawCursor.slice(expectedPrefix.length);

  switch (expectedSort) {
    case "newest": {
      const separatorIndex = payload.indexOf("_");
      if (separatorIndex <= 0) return null;
      const createdAtEpoch = parseWholeNumber(payload.slice(0, separatorIndex));
      const id = payload.slice(separatorIndex + 1);
      if (createdAtEpoch === null || id === "") return null;
      return { sort: "newest", createdAt: new Date(createdAtEpoch), id };
    }
    case "trending": {
      const scoreSeparatorIndex = payload.indexOf("_");
      if (scoreSeparatorIndex <= 0) return null;
      const instantSeparatorIndex = payload.indexOf("_", scoreSeparatorIndex + 1);
      if (instantSeparatorIndex <= scoreSeparatorIndex + 1) return null;
      const trendingScore = parseWholeNumber(payload.slice(0, scoreSeparatorIndex));
      const createdAtEpoch = parseWholeNumber(
        payload.slice(scoreSeparatorIndex + 1, instantSeparatorIndex),
      );
      const id = payload.slice(instantSeparatorIndex + 1);
      if (trendingScore === null || createdAtEpoch === null || id === "") return null;
      return { sort: "trending", trendingScore, createdAt: new Date(createdAtEpoch), id };
    }
    default: {
      const exhaustiveCheck: never = expectedSort;
      throw new Error(`Unhandled programme post sort: ${String(exhaustiveCheck)}`);
    }
  }
}
