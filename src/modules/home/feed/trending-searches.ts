import { asc, notExists, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { searchTermSuppression, trendingSearchTerm } from "#src/db/schema.js";

/**
 * "Everyone is searching for" — the current list `recompute-trending-searches` wrote, at most five.
 *
 * RE-FILTERED AGAINST SUPPRESSIONS AT READ TIME. The hourly job already excludes suppressed terms,
 * but a moderator who blocks a term expects it gone on the next page load, not within the hour.
 * Five rows against a primary-key probe each, so the second check costs nothing.
 */
export async function listTrendingSearches(): Promise<readonly string[]> {
  const trendingRows = await db
    .select({ term: trendingSearchTerm.term })
    .from(trendingSearchTerm)
    .where(
      notExists(
        db
          .select({ suppressedTerm: searchTermSuppression.term })
          .from(searchTermSuppression)
          .where(sql`${searchTermSuppression.term} = ${trendingSearchTerm.term}`),
      ),
    )
    .orderBy(asc(trendingSearchTerm.rank));
  return trendingRows.map((trendingRow) => trendingRow.term);
}
