import { sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import { logger } from "#src/lib/logger.js";
import { utcTimestamp } from "#src/lib/sql-time.js";

/**
 * The hourly `?sort=trending` score for a research programme's discussion feed.
 *
 * `trending_score = reactions in the last 7 days + 2 × visible replies in the last 7 days`, on
 * TOP-LEVEL posts only (replies are never listed in the feed). A reply counts double because it is
 * more effort than a tap; a HIDDEN reply counts for nothing, because hiding it was a judgement that
 * it should not draw attention.
 *
 * STORED rather than computed per request: the feed is keyset-paginated, and a key that changes
 * between two page fetches skips or repeats rows (see `research_program_post.trending_score`).
 *
 * ONLY ROWS WHOSE SCORE CHANGES ARE WRITTEN, including a post falling back to 0 when its activity
 * leaves the window — the `recompute-branch-signals` guard, so a quiet hour writes nothing.
 * `trending_scored_at` therefore records when the score last CHANGED. `updated_at` is not touched:
 * a score is not an edit to the post.
 *
 * A PURE FUNCTION OF `asOf` — the window derives from the payload, never the clock.
 */

const TRENDING_WINDOW_DAYS = 7;
const REPLY_WEIGHT = 2;

type CountRow = { readonly affected_count: number };

export async function handleRecomputeProgramPostTrending(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.recomputeProgramPostTrending,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.recomputeProgramPostTrending],
    rawPayload,
  );
  const asOf = new Date(payload.asOf);
  const windowStartsAt = new Date(asOf.getTime() - TRENDING_WINDOW_DAYS * 86_400_000);

  const updated = await db.transaction(async (tx) =>
    tx.execute<CountRow>(sql`
      WITH window_reaction AS (
        SELECT reaction.post_id, count(*)::int AS reaction_count
        FROM research_program_post_reaction AS reaction
        WHERE reaction.created_at >= ${utcTimestamp(windowStartsAt)}
          AND reaction.created_at < ${utcTimestamp(asOf)}
        GROUP BY reaction.post_id
      ), window_reply AS (
        SELECT reply.parent_post_id AS post_id, count(*)::int AS reply_count
        FROM research_program_post AS reply
        WHERE reply.depth = 1 AND NOT reply.is_hidden
          AND reply.created_at >= ${utcTimestamp(windowStartsAt)}
          AND reply.created_at < ${utcTimestamp(asOf)}
        GROUP BY reply.parent_post_id
      ), computed AS (
        SELECT post.id,
               coalesce(window_reaction.reaction_count, 0)
                 + ${REPLY_WEIGHT} * coalesce(window_reply.reply_count, 0) AS trending_score
        FROM research_program_post AS post
        LEFT JOIN window_reaction ON window_reaction.post_id = post.id
        LEFT JOIN window_reply ON window_reply.post_id = post.id
        WHERE post.depth = 0
          AND (window_reaction.post_id IS NOT NULL
               OR window_reply.post_id IS NOT NULL
               OR post.trending_score <> 0)
      ), changed AS (
        UPDATE research_program_post AS target
        SET trending_score = computed.trending_score,
            trending_scored_at = ${utcTimestamp(asOf)}
        FROM computed
        WHERE target.id = computed.id AND target.trending_score <> computed.trending_score
        RETURNING 1
      )
      SELECT count(*)::int AS affected_count FROM changed
    `),
  );

  logger.info("recompute-program-post-trending: complete", {
    asOf: payload.asOf,
    windowStartsAt: windowStartsAt.toISOString(),
    changedPostCount: updated.rows[0]?.affected_count ?? 0,
  });
}
