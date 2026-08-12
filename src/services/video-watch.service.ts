import { and, asc, eq, lte, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  contentCategory,
  creatorStats,
  creatorSubscription,
  user,
  video,
  videoCategory,
  videoChapter,
  videoLike,
  videoSave,
  videoStats,
} from "#src/db/schema.js";
import { PUBLICLY_SERVABLE } from "#src/modules/studio/public-video-gate.js";
import type { Result } from "#src/types/index.js";

/**
 * `GET /feed/watch/:videoId` — the public watch payload (§5.2).
 *
 * This replaces the frontend's legacy `QATOTO_VIDEO_API_URL` path entirely. It is the
 * first route on the platform that serves a video to somebody who does not own it.
 *
 * ## Three rules it does not bend
 *
 * **It does not record a view.** Rule 4: `viewCount` moves only on the beacon's
 * counted-view transition. A client that expects loading the page to count as a view
 * must not be accommodated — that is precisely the conflation that gets a feed farmed.
 *
 * **`viewerState` is embedded, never a second round trip.** Three extra requests on the
 * highest-value page in the product is not a trade worth making, and the LEFT JOINs
 * below ride the reverse indexes that exist for exactly this.
 *
 * **404 covers the whole gate.** Unpublished, private, review-pending, upload failed,
 * source unverified — one indistinguishable answer, so this route cannot be used to
 * enumerate a creator's unreleased catalogue.
 */

export type VideoWatchError = { readonly type: "VIDEO_NOT_FOUND"; readonly videoId: string };

export interface WatchPayload {
  readonly videoId: string;
  readonly videoSource: (typeof video.$inferSelect)["videoSource"];
  readonly youtubeVideoId: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly thumbnailUrl: string | null;
  /** ISO on the wire. Never a pre-formatted label — the client owns presentation. */
  readonly publishedAt: Date | null;
  /**
   * NULL until `recompute-video-durations` (phase 3) has five independent samples.
   * DELIBERATELY not substituted with a client's `reportedDurationSeconds`: that number
   * comes from the hostile side and would be a fabricated fact on a public surface.
   */
  readonly durationSeconds: number | null;
  readonly videoType: (typeof video.$inferSelect)["videoType"];
  readonly areCommentsEnabled: boolean;
  readonly chapters: readonly { readonly startSeconds: number; readonly title: string }[];
  readonly creator: {
    readonly id: string;
    readonly handle: string | null;
    readonly name: string;
    readonly imageUrl: string | null;
    readonly subscriberCount: number;
  };
  readonly categories: readonly { readonly slug: string; readonly label: string }[];
  readonly stats: {
    readonly viewCount: number;
    readonly likeCount: number;
    readonly commentCount: number;
    readonly shareCount: number;
    readonly saveCount: number;
  };
  readonly viewerState: {
    readonly hasLiked: boolean;
    readonly hasSaved: boolean;
    readonly isSubscribedToCreator: boolean;
  };
  /** Always false (§5.3). Nothing backs live streaming and this doc says so. */
  readonly isChannelLive: false;
}

export async function getWatchPayload(
  videoId: string,
  viewerUserId: string | null,
): Promise<Result<WatchPayload, VideoWatchError>> {
  // `EXISTS` rather than a LEFT JOIN for the three viewer flags: each one is an index-
  // only probe on a reverse index, and a join would multiply the row before the
  // aggregate had a chance to collapse it.
  const viewerLiked =
    viewerUserId === null
      ? sql<boolean>`false`
      : sql<boolean>`EXISTS (
            SELECT 1 FROM ${videoLike}
            WHERE ${videoLike.videoId} = ${video.id} AND ${videoLike.userId} = ${viewerUserId}
          )`;
  const viewerSaved =
    viewerUserId === null
      ? sql<boolean>`false`
      : sql<boolean>`EXISTS (
            SELECT 1 FROM ${videoSave}
            WHERE ${videoSave.videoId} = ${video.id} AND ${videoSave.userId} = ${viewerUserId}
          )`;
  const viewerSubscribed =
    viewerUserId === null
      ? sql<boolean>`false`
      : sql<boolean>`EXISTS (
            SELECT 1 FROM ${creatorSubscription}
            WHERE ${creatorSubscription.creatorId} = ${video.creatorId}
              AND ${creatorSubscription.subscriberId} = ${viewerUserId}
          )`;

  const [row] = await db
    .select({
      videoId: video.id,
      videoSource: video.videoSource,
      youtubeVideoId: video.youtubeVideoId,
      title: video.title,
      description: video.description,
      thumbnailUrl: video.thumbnailUrl,
      publishedAt: video.publishedAt,
      durationSeconds: video.durationSeconds,
      videoType: video.videoType,
      areCommentsEnabled: video.areCommentsEnabled,
      creatorId: user.id,
      creatorHandle: user.handle,
      creatorName: user.name,
      creatorImageUrl: user.image,
      // COALESCE, because a creator whose stats row predates phase 2 has none. Zero is
      // the true statement here: no subscription has ever been recorded.
      subscriberCount: sql<number>`COALESCE(${creatorStats.subscriberCount}, 0)`,
      viewCount: sql<number>`COALESCE(${videoStats.viewCount}, 0)`,
      likeCount: sql<number>`COALESCE(${videoStats.likeCount}, 0)`,
      commentCount: sql<number>`COALESCE(${videoStats.commentCount}, 0)`,
      shareCount: sql<number>`COALESCE(${videoStats.shareCount}, 0)`,
      saveCount: sql<number>`COALESCE(${videoStats.saveCount}, 0)`,
      hasLiked: viewerLiked,
      hasSaved: viewerSaved,
      isSubscribedToCreator: viewerSubscribed,
    })
    .from(video)
    .innerJoin(user, eq(user.id, video.creatorId))
    .leftJoin(videoStats, eq(videoStats.videoId, video.id))
    .leftJoin(creatorStats, eq(creatorStats.userId, video.creatorId))
    .where(and(eq(video.id, videoId), PUBLICLY_SERVABLE, lte(video.publishedAt, sql`now()`)))
    .limit(1);

  if (!row) {
    return { success: false, error: { type: "VIDEO_NOT_FOUND", videoId } };
  }

  // Two small ordered reads rather than json aggregation in the main query: both are
  // index scans on `video_id`, and keeping them separate keeps the row above flat.
  const [categories, chapters] = await Promise.all([
    db
      .select({ slug: contentCategory.slug, label: contentCategory.label })
      .from(videoCategory)
      .innerJoin(contentCategory, eq(contentCategory.id, videoCategory.categoryId))
      .where(eq(videoCategory.videoId, videoId))
      .orderBy(asc(contentCategory.sortOrder), asc(contentCategory.slug)),
    db
      .select({ startSeconds: videoChapter.startSeconds, title: videoChapter.title })
      .from(videoChapter)
      .where(eq(videoChapter.videoId, videoId))
      .orderBy(asc(videoChapter.position)),
  ]);

  return {
    success: true,
    value: {
      videoId: row.videoId,
      videoSource: row.videoSource,
      youtubeVideoId: row.youtubeVideoId,
      title: row.title,
      description: row.description,
      thumbnailUrl: row.thumbnailUrl,
      publishedAt: row.publishedAt,
      durationSeconds: row.durationSeconds,
      videoType: row.videoType,
      areCommentsEnabled: row.areCommentsEnabled,
      chapters,
      creator: {
        id: row.creatorId,
        handle: row.creatorHandle,
        name: row.creatorName,
        imageUrl: row.creatorImageUrl,
        // Every counter here is int4, which node-pg parses as a number. No coercion:
        // the bigint columns (`total_watched_seconds`, `completion_bp_sum`) would come
        // back as strings and DO need care — which is exactly why neither is selected
        // on this route.
        subscriberCount: row.subscriberCount,
      },
      categories,
      stats: {
        viewCount: row.viewCount,
        likeCount: row.likeCount,
        commentCount: row.commentCount,
        shareCount: row.shareCount,
        saveCount: row.saveCount,
      },
      // `false`, not `null`, for an anonymous viewer — and that is NOT a fabricated
      // zero. An anonymous viewer definitionally has no `video_like` row, so "has not
      // liked" is a true statement about them, not a stand-in for a missing one.
      viewerState: {
        hasLiked: row.hasLiked,
        hasSaved: row.hasSaved,
        isSubscribedToCreator: row.isSubscribedToCreator,
      },
      isChannelLive: false,
    },
  };
}

/**
 * WHAT IS DELIBERATELY ABSENT FROM THE PAYLOAD ABOVE, so nobody adds it back by reflex:
 *
 *   `visibility`, `publishStatus`, `reviewStatus`, `uploadStatus`, `isSourceVerified` —
 *      lifecycle facts the public has no claim on, and several of them are exactly what
 *      the 404-not-403 policy exists to hide.
 *   `commentModeration`, `commentSortOrder` — §8.4: unbacked preference columns.
 *      Shipping them would imply they work.
 *   `creator.isVerified` — §5.1's feed item lists it, but NO creator verification
 *      concept exists in the schema (`talent_profile_skill.is_verified` is a skill
 *      badge on a different subsystem). Omitted rather than hard-coded, because a
 *      constant `false` on a trust signal is a claim we cannot support.
 *   `products` — the studio owns `PUT /videos/:videoId/products`; surfacing them here
 *      is a follow-up, and saying so beats a silently missing key.
 */
