import { sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { platformCategoryPopularitySnapshot } from "#src/db/schema.js";
import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import { logger } from "#src/lib/logger.js";

/**
 * §4.4 — what the platform as a whole watches, per category.
 *
 * ## Its only consumer is cold start
 *
 * A signed-in viewer with no watch history has no topic affinity, and Rule 5 forbids
 * scoring that as zero — a category somebody has never seen is not a category they
 * dislike. §4.4's answer is this distribution, damped to 60%, so a new account gets a
 * sensible feed that is not *claiming* to be personalized.
 *
 * ## Why the score is a share of the leader, not a share of the whole
 *
 * A share of total views would put every category in single digits the moment the taxonomy
 * has 23 entries, and the affinity ladder that reads it would then never leave its bottom
 * rung. Scoring each category against the MOST-watched one spreads the values across the
 * band the ladder was built for. It is a relative statement either way; this one is
 * legible.
 */

type CategoryPopularityRow = {
  readonly category_id: string;
  readonly counted_view_count: number;
  readonly published_video_count: number;
};

export async function handleRecomputePlatformCategoryPopularity(
  rawPayload: unknown,
): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.recomputePlatformCategoryPopularity,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.recomputePlatformCategoryPopularity],
    rawPayload,
  );
  const asOf = new Date(payload.asOf);

  // EVERY active category, including the ones nobody has watched — a LEFT JOIN, not an
  // inner one. A category with no views is a real answer (0 points), and dropping the row
  // would make the feed unable to distinguish "unpopular" from "not yet computed".
  const rows = await db.execute<CategoryPopularityRow>(sql`
    SELECT
      c.id AS category_id,
      COALESCE(counts.counted_view_count, 0)::int    AS counted_view_count,
      COALESCE(counts.published_video_count, 0)::int AS published_video_count
    FROM content_category AS c
    LEFT JOIN (
      SELECT
        vc.category_id,
        count(DISTINCT s.id)      AS counted_view_count,
        count(DISTINCT v.id)      AS published_video_count
      FROM video_category AS vc
      JOIN video AS v ON v.id = vc.video_id
        AND v.publish_status = 'published'
        AND v.published_at IS NOT NULL
        AND v.published_at < ${asOf}
      LEFT JOIN video_view_session AS s ON s.video_id = v.id
        AND s.is_counted_view
        AND s.first_beacon_at < ${asOf}
      GROUP BY vc.category_id
    ) AS counts ON counts.category_id = c.id
    WHERE c.is_active
    ORDER BY c.id
  `);

  if (rows.rows.length === 0) {
    logger.info("recompute-platform-category-popularity: no active categories", {
      asOf: payload.asOf,
    });
    return;
  }

  const highestViewCount = rows.rows.reduce(
    (runningMax, row) => Math.max(runningMax, row.counted_view_count),
    0,
  );

  await db.transaction(async (tx) => {
    await tx
      .insert(platformCategoryPopularitySnapshot)
      .values(
        rows.rows.map((row) => ({
          categoryId: row.category_id,
          asOf,
          // Integer division against the leader. When nothing has been watched at all,
          // every category scores 0 — which is true, and which the cold-start damping
          // then leaves at 0 rather than inventing a preference.
          popularityPoints:
            highestViewCount === 0
              ? 0
              : Math.floor((row.counted_view_count * 100) / highestViewCount),
          countedViewCount: row.counted_view_count,
          publishedVideoCount: row.published_video_count,
        })),
      )
      .onConflictDoNothing({
        target: [
          platformCategoryPopularitySnapshot.categoryId,
          platformCategoryPopularitySnapshot.asOf,
        ],
      });
  });

  logger.info("recompute-platform-category-popularity: complete", {
    asOf: payload.asOf,
    categoryCount: rows.rows.length,
    highestViewCount,
  });
}
