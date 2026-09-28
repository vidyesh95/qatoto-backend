import { sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { video } from "#src/db/schema.js";
import { utcTimestamp } from "#src/lib/sql-time.js";
import { PUBLICLY_SERVABLE } from "#src/modules/studio/public-video-gate.js";

/**
 * Trending TAGS — the watch page's "Trending tags:" line. Platform-wide, not about any one video.
 *
 * ## A projection of the hourly job, not a job of its own
 *
 * `recompute-trending-videos` already ranks the catalogue every hour and stores each ranked
 * video's score in `trending_video_snapshot`. Which tags are trending is a question about THAT
 * ranking, so it is answered by aggregating the latest snapshot at read time: no second job, no
 * table, no migration, and no data about any viewer beyond what the video ranking already holds.
 *
 * ## What it is NOT: search terms
 *
 * The line used to read "Everyone is searching for:". Nothing stores what anyone searches for —
 * `request-log.ts` drops the query string on purpose and the privacy policy discloses no such
 * collection — so these are the tags CREATORS put on trending videos, and the copy says so.
 *
 * ## ⚠️ `video.tags` WERE NEVER PUBLIC BEFORE THIS, AND THE FLOOR IS WHAT MAKES THEM PUBLISHABLE
 *
 * Tags are free text a creator types and, until now, only fed search. A tag reaches this list
 * only when at least `TRENDING_TAG_MINIMUM_DISTINCT_CREATORS` DIFFERENT creators put it on
 * currently trending videos, so no single creator can place a word on every watch page. If
 * abuse appears anyway, per-tag moderation is the next control, not a lower floor.
 *
 * ## Re-gated at read time, and stale means empty
 *
 * The snapshot can be up to an hour old, so each video is re-checked against the CURRENT public
 * gate: a video made private or moderated since the last run cannot leak its tags. And if the
 * newest snapshot is older than `TRENDING_TAG_MAXIMUM_SNAPSHOT_AGE_HOURS`, the job has stalled;
 * the list is empty rather than an old answer presented as what is trending now.
 */

/** How many tags the watch page shows. */
const TRENDING_TAG_LIMIT = 5;

/** The anti-gaming floor: different creators, not different videos. */
const TRENDING_TAG_MINIMUM_DISTINCT_CREATORS = 2;

/** The job runs hourly; three missed runs is a stalled job, not a quiet hour. */
const TRENDING_TAG_MAXIMUM_SNAPSHOT_AGE_HOURS = 3;

type TrendingTagRow = { readonly tag: string };

export async function listTrendingTags(): Promise<readonly string[]> {
  const oldestAcceptableSnapshotAt = new Date(
    Date.now() - TRENDING_TAG_MAXIMUM_SNAPSHOT_AGE_HOURS * 60 * 60 * 1_000,
  );

  // `video` is NOT aliased: `PUBLICLY_SERVABLE` is written against its qualified columns.
  // Each video contributes a tag ONCE (the DISTINCT inside the lateral), however many times its
  // creator typed it, and a tag's score is the sum of its videos' trending scores.
  const trendingTagRows = await db.execute<TrendingTagRow>(sql`
    WITH latest_snapshot AS (
      SELECT max(as_of) AS as_of FROM trending_video_snapshot
    )
    SELECT video_tag.tag AS tag
    FROM latest_snapshot
    JOIN trending_video_snapshot AS snapshot ON snapshot.as_of = latest_snapshot.as_of
    JOIN ${video} ON ${video.id} = snapshot.video_id
    CROSS JOIN LATERAL (
      SELECT DISTINCT lower(btrim(raw_tag)) AS tag
      FROM unnest(${video.tags}) AS raw_tag
      WHERE btrim(raw_tag) <> ''
    ) AS video_tag
    WHERE latest_snapshot.as_of >= ${utcTimestamp(oldestAcceptableSnapshotAt)}
      AND ${PUBLICLY_SERVABLE}
      AND ${video.publishedAt} IS NOT NULL
      AND ${video.publishedAt} <= now()
    GROUP BY video_tag.tag
    HAVING count(DISTINCT ${video.creatorId}) >= ${TRENDING_TAG_MINIMUM_DISTINCT_CREATORS}
    ORDER BY sum(snapshot.trending_score_points) DESC, video_tag.tag ASC
    LIMIT ${TRENDING_TAG_LIMIT}
  `);

  return trendingTagRows.rows.map((trendingTagRow) => trendingTagRow.tag);
}
