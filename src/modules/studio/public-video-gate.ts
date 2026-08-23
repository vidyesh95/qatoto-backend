import { and, eq, lte, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { video } from "#src/db/schema.js";

/**
 * "Is this video one the public may touch at all?" — the read gate every public
 * engagement route runs before it does anything else.
 *
 * ONE HELPER, NOT SIX COPIES, because the failure mode of a divergent copy is a route
 * that serves or accepts writes against a draft. This is the same predicate as §4.5's
 * candidate pool and as `video_feed_candidate_idx` (`schema.ts:9622`), minus the
 * per-viewer terms that only make sense when ranking.
 *
 * EVERY FAILURE IS ONE INDISTINGUISHABLE `VIDEO_NOT_FOUND`. Unpublished, private,
 * pending review, upload failed, source unverified — a caller learns the same thing
 * from all of them, which is nothing. Splitting them into 403s would turn this into an
 * oracle that enumerates a creator's unreleased catalogue by id.
 *
 * THE LITERALS ARE DELIBERATE. Postgres uses a partial index only when it can PROVE the
 * query's WHERE implies the index predicate, and that proof works against literals, not
 * bound parameters. `review_status = ANY($1)` does not imply
 * `review_status IN ('not_required','approved')` as far as the planner is concerned.
 * Written as `sql` fragments here so the terms byte-match the index, because getting it
 * wrong produces no error — just a sequential scan.
 */
const PUBLICLY_SERVABLE = sql`${video.publishStatus} = 'published'
    AND ${video.visibility} = 'public'
    AND ${video.uploadStatus} = 'ready'
    AND ${video.isSourceVerified} = true
    AND ${video.reviewStatus} IN ('not_required', 'approved')
    AND ${video.moderationVisibilityState} = 'visible'`;

/** The little the engagement services need to know about a video they may write to. */
export interface PublicVideoGateRow {
  readonly id: string;
  readonly creatorId: string;
  readonly areCommentsEnabled: boolean;
}

/**
 * `publishedAt <= now()` is checked alongside the status, not instead of it: a
 * `scheduled` row flips to `published` by job, but a row whose `publishedAt` is in the
 * future must not be readable in the window between the two.
 *
 * Takes the transaction so a caller can hold the gate and its write in one atomic unit
 * — otherwise a video unpublished between the check and the insert accepts the write.
 */
export async function findPublicVideo(
  executor: Pick<typeof db, "select">,
  videoId: string,
): Promise<PublicVideoGateRow | null> {
  const [row] = await executor
    .select({
      id: video.id,
      creatorId: video.creatorId,
      areCommentsEnabled: video.areCommentsEnabled,
    })
    .from(video)
    .where(and(eq(video.id, videoId), PUBLICLY_SERVABLE, lte(video.publishedAt, sql`now()`)))
    .limit(1);

  return row ?? null;
}

export { PUBLICLY_SERVABLE };
