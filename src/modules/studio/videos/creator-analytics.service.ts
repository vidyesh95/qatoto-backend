import { count, desc, eq } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { creatorStats, video, videoStats } from "#src/db/schema.js";

/**
 * THE CREATOR'S OWN NUMBERS — `/studio/analytics` (STUDIO §6, HOME §3.3).
 *
 * NO NEW TABLE AND NO NEW JOB. Every figure below was already being written and simply had no
 * reader: `creator_stats.published_video_count` and `creator_stats.total_view_count` are
 * maintained by three services and, before this file, were selected NOWHERE in the codebase.
 * `video_stats` is the same story per video. The gap was the read.
 *
 * THESE ARE QATOTO-SIDE NUMBERS AND THE UI MUST SAY SO. A YouTube-hosted video's own view count
 * lives in the creator's YouTube Studio; `video_stats` counts watching that happened HERE, through
 * the §3.3 beacon. The two will never agree, and a creator who is not told why will assume one is
 * broken. (STUDIO §5.1 still claims we have no first-party watch data at all — that is stale, the
 * beacon shipped after it.)
 *
 * WHAT IS DELIBERATELY ABSENT: a time series. Every rollup this codebase has —
 * `user_activity_hour`, `user_watch_daily`, `platform_activity_hour_daily` — is keyed by VIEWER or
 * is platform-wide, and none can be narrowed to a creator. The per-video snapshots that could back
 * one are pruned at 14 days. "Views per day" therefore needs a new creator-keyed table and a
 * nightly job, and inventing one here to fill a chart would mean serving a number nothing computes.
 */

export interface CreatorSummary {
  readonly subscriberCount: number;
  readonly publishedVideoCount: number;
  readonly totalViewCount: number;
}

/**
 * Lifetime totals for one creator, straight from the counter cache.
 *
 * ZERO ON A MISSING ROW, AND HERE THAT IS THE TRUE ANSWER — the opposite call to §3.3a's
 * watch-time read, so the divergence is worth stating rather than leaving to look like an
 * inconsistency.
 *
 * `/users/me/watch-time` returns `null` for an account with no rows because zero would claim "we
 * watched you watch nothing" — an assertion about a VIEWER's behaviour that we may simply never
 * have observed. These three are counts of the creator's OWN artefacts, and the row is minted on
 * their first publish, first subscriber or first counted view. Its absence therefore means none of
 * those has ever happened, which is a fact we do know. `video-watch.service.ts` already makes this
 * exact argument for `subscriberCount`.
 *
 * `publishedVideoCount` IS READ FROM THE CACHE, and briefly was not. Building this read exposed
 * two paths that changed a video's published state without maintaining the counter — `deleteVideo`
 * removed a published video without decrementing, and `content-review.service.ts` published an
 * approved anime episode without incrementing. Those drifted the number in OPPOSITE directions,
 * so on one account they could even have cancelled out. Both are fixed at the source now and the
 * drifted rows were repaired by `scripts/reconcile-creator-stats.ts`, which is also the standing
 * check: a counter cache with no reconciler is one nobody can prove is right.
 *
 * That is why this counts nothing live. A cache the page refuses to trust is a cache that never
 * gets fixed — and this read being its FIRST consumer anywhere is precisely how the drift stayed
 * invisible for as long as it did.
 */
export async function getCreatorSummary(creatorUserId: string): Promise<CreatorSummary> {
  const [row] = await db
    .select({
      subscriberCount: creatorStats.subscriberCount,
      publishedVideoCount: creatorStats.publishedVideoCount,
      totalViewCount: creatorStats.totalViewCount,
    })
    .from(creatorStats)
    .where(eq(creatorStats.userId, creatorUserId))
    .limit(1);

  return {
    subscriberCount: row?.subscriberCount ?? 0,
    publishedVideoCount: row?.publishedVideoCount ?? 0,
    totalViewCount: row?.totalViewCount ?? 0,
  };
}

export interface VideoAnalyticsRow {
  readonly videoId: string;
  readonly title: string;
  readonly thumbnailUrl: string | null;
  readonly publishStatus: (typeof video.$inferSelect)["publishStatus"];
  readonly publishedAt: Date | null;
  readonly viewCount: number;
  readonly likeCount: number;
  readonly commentCount: number;
  readonly shareCount: number;
  readonly saveCount: number;
  readonly totalWatchedSeconds: number;
  /**
   * BOTH NULLABLE, AND NEITHER MAY BE COERCED TO ZERO.
   *
   * `recompute-video-quality-scores` computes them nightly, so they are null before it has first
   * run — and null again once `prune-engagement-data` removes the underlying sessions at 90 days
   * (`engagement-retention.ts`, `mayHavePrunedSessions`). Zero here would assert "nobody watched"
   * about a video whose evidence was merely aged out, which is the precise fabrication the
   * nullable columns exist to prevent.
   */
  readonly uniqueViewerCount: number | null;
  readonly countedViewsFirst48Hours: number | null;
  /**
   * Mean completion in basis points, or null when nothing has been sampled.
   *
   * DERIVED IN TYPESCRIPT, NEVER IN SQL (§4c rule 3): a Postgres `numeric` and a JS `number` are
   * not the same value domain, so the division happens once, here, with a stated rounding rule
   * rather than twice with two answers.
   *
   * NULL RATHER THAN 0 WHEN `completionSampleCount` IS 0. An unmeasured completion rate is not a
   * completion rate of nothing — same rule as the two fields above.
   */
  readonly meanCompletionBasisPoints: number | null;
}

export interface VideoAnalyticsPage {
  readonly rows: readonly VideoAnalyticsRow[];
  readonly total: number;
}

/**
 * Per-video counters for the caller's own videos.
 *
 * LEFT JOIN, because a video can exist before its `video_stats` row does — `ensureVideoStatsRows`
 * mints that row on the first engagement, so a freshly published video with no viewer yet has
 * none. An inner join would silently drop exactly the videos a creator is most anxious about.
 *
 * NO `?sort=`. `video_stats` has a primary key and no secondary index, so ordering by view count
 * sorts after the join with nothing to support it. This file will not offer a control the storage
 * cannot serve — the same refusal `ListVideoCommentsQuerySchema` makes about `?sort=top`.
 *
 * Ordered by `publishedAt` with `id` as the tiebreak, so the page boundary is total. Drafts have a
 * null `publishedAt` and sort last under `desc` — correct, since a draft has no numbers yet.
 */
export async function listVideoAnalytics(
  creatorUserId: string,
  filters: { readonly page: number; readonly limit: number },
): Promise<VideoAnalyticsPage> {
  const predicate = eq(video.creatorId, creatorUserId);

  const [rows, [totals]] = await Promise.all([
    db
      .select({
        videoId: video.id,
        title: video.title,
        thumbnailUrl: video.thumbnailUrl,
        publishStatus: video.publishStatus,
        publishedAt: video.publishedAt,
        viewCount: videoStats.viewCount,
        likeCount: videoStats.likeCount,
        commentCount: videoStats.commentCount,
        shareCount: videoStats.shareCount,
        saveCount: videoStats.saveCount,
        totalWatchedSeconds: videoStats.totalWatchedSeconds,
        uniqueViewerCount: videoStats.uniqueViewerCount,
        countedViewsFirst48Hours: videoStats.countedViewsFirst48Hours,
        completionBasisPointsSum: videoStats.completionBasisPointsSum,
        completionSampleCount: videoStats.completionSampleCount,
      })
      .from(video)
      .leftJoin(videoStats, eq(videoStats.videoId, video.id))
      .where(predicate)
      .orderBy(desc(video.publishedAt), desc(video.id))
      .limit(filters.limit)
      .offset((filters.page - 1) * filters.limit),
    db.select({ value: count() }).from(video).where(predicate),
  ]);

  return {
    rows: rows.map((row) => ({
      videoId: row.videoId,
      title: row.title,
      thumbnailUrl: row.thumbnailUrl,
      publishStatus: row.publishStatus,
      publishedAt: row.publishedAt,
      // The counters are `NOT NULL DEFAULT 0` columns, so a `?? 0` here fills only the LEFT JOIN
      // miss — a video with no stats row has recorded no engagement, and zero says exactly that.
      viewCount: row.viewCount ?? 0,
      likeCount: row.likeCount ?? 0,
      commentCount: row.commentCount ?? 0,
      shareCount: row.shareCount ?? 0,
      saveCount: row.saveCount ?? 0,
      totalWatchedSeconds: row.totalWatchedSeconds ?? 0,
      // No `?? 0` on these three, deliberately — see the field docs above.
      uniqueViewerCount: row.uniqueViewerCount,
      countedViewsFirst48Hours: row.countedViewsFirst48Hours,
      meanCompletionBasisPoints: meanCompletionBasisPoints(
        row.completionBasisPointsSum,
        row.completionSampleCount,
      ),
    })),
    total: totals?.value ?? 0,
  };
}

/**
 * Sum ÷ count, rounded half away from zero, or null when there is no sample.
 *
 * Both inputs are non-negative by CHECK, so the rounding rule only ever has to name what happens
 * at exactly .5 — it is stated rather than left to `Math.round`'s half-up-toward-positive-infinity
 * so the answer does not change if a signed input is ever introduced.
 */
function meanCompletionBasisPoints(
  completionBasisPointsSum: number | null,
  completionSampleCount: number | null,
): number | null {
  if (completionBasisPointsSum === null || completionSampleCount === null) return null;
  if (completionSampleCount === 0) return null;
  return Math.round(completionBasisPointsSum / completionSampleCount);
}
