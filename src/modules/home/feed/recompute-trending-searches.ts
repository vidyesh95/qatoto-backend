import { sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { trendingSearchTerm } from "#src/db/schema.js";
import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import { logger } from "#src/lib/logger.js";
import { utcDayStringOf } from "#src/lib/utc-day.js";

/**
 * The hourly "Everyone is searching for" list, and the search log's retention.
 *
 * ## Two jobs in one transaction, on purpose
 *
 *   1. PRUNE: every `search_query_log` row older than 30 days is deleted, UNCONDITIONALLY. The
 *      privacy policy promises 30 days, and that promise cannot depend on `prune-engagement-data`,
 *      which is dry-run until `ENGAGEMENT_PRUNE_ENABLED` is set. Hourly is more often than
 *      needed, and that is the point: a missed run costs an hour, not a month.
 *   2. RANK: a term trends when at least `MINIMUM_DISTINCT_SEARCHERS` distinct fingerprints
 *      searched it in the last seven days and no moderator has suppressed it. The fingerprint's
 *      salt rotates WEEKLY, so one person counts at most twice across a Monday — never once per
 *      day they searched.
 *
 * `trending_search_term` is replaced wholesale: it is the current list, not a history, and holds
 * no fingerprint. A PURE FUNCTION OF `asOf` — every cutoff derives from the payload.
 */

const SEARCH_LOG_RETENTION_DAYS = 30;
const TRENDING_WINDOW_DAYS = 7;
const MINIMUM_DISTINCT_SEARCHERS = 5;
const TRENDING_SEARCH_LIMIT = 5;
const MILLISECONDS_PER_DAY = 86_400_000;

type TrendingSearchRow = { readonly term: string; readonly searcher_count: number };
type CountRow = { readonly affected_count: number };

export async function handleRecomputeTrendingSearches(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.recomputeTrendingSearches,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.recomputeTrendingSearches],
    rawPayload,
  );
  const asOf = new Date(payload.asOf);
  // `search_day` is a DATE, so the cutoffs are day strings — compared as dates by Postgres.
  const retentionCutoffDay = utcDayStringOf(
    new Date(asOf.getTime() - SEARCH_LOG_RETENTION_DAYS * MILLISECONDS_PER_DAY),
  );
  const windowStartDay = utcDayStringOf(
    new Date(asOf.getTime() - (TRENDING_WINDOW_DAYS - 1) * MILLISECONDS_PER_DAY),
  );

  const { prunedRowCount, trendingSearches } = await db.transaction(async (tx) => {
    const pruned = await tx.execute<CountRow>(sql`
      WITH deleted AS (
        DELETE FROM search_query_log WHERE search_day < ${retentionCutoffDay}::date RETURNING 1
      )
      SELECT count(*)::int AS affected_count FROM deleted
    `);

    const ranked = await tx.execute<TrendingSearchRow>(sql`
      SELECT log.normalized_term AS term,
             count(DISTINCT log.searcher_fingerprint)::int AS searcher_count
      FROM search_query_log AS log
      WHERE log.search_day >= ${windowStartDay}::date
        AND NOT EXISTS (
          SELECT 1 FROM search_term_suppression AS suppression
          WHERE suppression.term = log.normalized_term
        )
      GROUP BY log.normalized_term
      HAVING count(DISTINCT log.searcher_fingerprint) >= ${MINIMUM_DISTINCT_SEARCHERS}
      ORDER BY searcher_count DESC, term ASC
      LIMIT ${TRENDING_SEARCH_LIMIT}
    `);

    await tx.delete(trendingSearchTerm);
    if (ranked.rows.length > 0) {
      await tx.insert(trendingSearchTerm).values(
        ranked.rows.map((rankedRow, rankIndex) => ({
          rank: rankIndex + 1,
          term: rankedRow.term,
          searcherCount: rankedRow.searcher_count,
          asOf,
        })),
      );
    }

    return {
      prunedRowCount: pruned.rows[0]?.affected_count ?? 0,
      trendingSearches: ranked.rows,
    };
  });

  logger.info("recompute-trending-searches: complete", {
    asOf: payload.asOf,
    prunedRowCount,
    trendingSearchCount: trendingSearches.length,
  });
}
