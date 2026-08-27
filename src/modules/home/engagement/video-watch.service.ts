import { and, asc, eq, lte, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  contentCategory,
  creatorStats,
  creatorSubscription,
  researchProject,
  user,
  video,
  videoAttachedProduct,
  videoCategory,
  videoChapter,
  videoDocument,
  videoLike,
  videoOpenRole,
  videoSave,
  videoStats,
} from "#src/db/schema.js";
import {
  listOpenRolesByIds,
  type OpenRoleView,
} from "#src/modules/rnd/projects/project-roles.service.js";
import {
  resolveEligibleProductCardsByIds,
  type StoreProductCardProjection,
} from "#src/modules/store/catalog/store-catalog.service.js";
import { PUBLICLY_SERVABLE } from "#src/modules/studio/public-video-gate.js";
import {
  loadPublicSeasonsForVideo,
  type PublicSeasonSummary,
} from "#src/modules/studio/series/public-series.service.js";
import { videoDocumentDownloadPath } from "#src/modules/studio/videos/videos.service.js";
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
  /**
   * THE VENTURE BEHIND THIS VIDEO (§11i), or null — the watch-page half of the R&D link.
   *
   * A BADGE, NOT A CARD. The store's product page carries proof counts because a buyer is
   * deciding whether to spend money; a viewer is deciding whether to click through, so this
   * carries identity and nothing else. No counts, no equity, no roster.
   *
   * SLUG ONLY, never the id — same rule as every other R&D read. Null covers three cases the
   * client must not distinguish: no venture, a venture that is not `active`, and a row that
   * is gone. A draft venture must not be nameable from a public watch page.
   */
  readonly builtInTheOpen: {
    readonly projectSlug: string;
    readonly projectName: string;
    readonly stage: (typeof researchProject.$inferSelect)["stage"];
  } | null;
  /**
   * THE RECRUITING BLOCK — what the video says it is hiring for (§12).
   *
   * `roleTitle` is what the creator typed and is always present. `linkedRole` is the REAL
   * `projectOpenRole` behind it when the creator picked one, carrying the skills, commitment
   * and remaining slots the R&D surface renders — which is what lets a viewer apply from here
   * rather than read a label. Null means free text: anime, unaffiliated videos, and every row
   * written before the link existed.
   *
   * A CLOSED OR FULL ROLE STILL APPEARS, with its real `status` and slot counts. Hiding it
   * would leave the creator's own blurb on screen with nothing behind it; showing the true
   * state is what tells a viewer the door is shut.
   */
  readonly openRoles: readonly {
    readonly roleTitle: string;
    readonly roleDescription: string | null;
    readonly linkedRole: OpenRoleView | null;
  }[];
  /**
   * THE SERIES THIS EPISODE BELONGS TO, or `null` when the video is not an anime episode.
   *
   * `null` AND `[]` ARE BOTH REACHABLE AND MEAN DIFFERENT THINGS. Null is "not part of a
   * series" — every pitch, demo and unaffiliated video. An empty array is a series none of
   * whose episodes are public yet. The client hides the picker for the first and renders an
   * empty catalogue for the second, so a single sentinel would lose a real distinction.
   *
   * Only publicly-servable episodes appear, so episode numbers can have gaps. See
   * `loadPublicSeasonsForVideo` for why that visible consequence is the intended one.
   */
  readonly seasons: readonly PublicSeasonSummary[] | null;
  /**
   * THE SHOPPABLE PRODUCTS UNDER THE PLAYER. Written by `PUT /videos/:videoId/products`, which
   * re-verifies the creator owns each product; this is the read half, which had never existed —
   * the note at the bottom of this file called it a follow-up and this is it.
   *
   * `[]` RATHER THAN `null`, unlike `seasons` directly above, and the asymmetry is deliberate.
   * Every video CAN carry attached products, so "none" is an empty list rather than an absent
   * capability; there is no second state for a sentinel to distinguish.
   *
   * EACH ENTRY IS RE-CHECKED FOR PUBLIC ELIGIBILITY AT READ TIME, not trusted from the join
   * row. A creator can attach a product and the seller can then unpublish it, delist the
   * organization or have the listing moderated down — none of which touches
   * `video_attached_product`. `resolveEligibleProductCardsByIds` drops those ids, so the list
   * gets shorter rather than growing a dead card. The join row survives, so re-publishing the
   * product brings the card straight back.
   */
  readonly attachedProducts: readonly {
    readonly product: StoreProductCardProjection;
    readonly pinnedAtSeconds: number | null;
  }[];
  /**
   * THE DECK OR WHITEPAPER SHOWN AS A DOWNLOAD UNDER THE VIDEO (§11j).
   *
   * WHY IT IS HERE AT ALL. `video_document` was read by the STUDIO owner projection and by nothing
   * else, so even a populated row rendered nowhere a viewer could see. That is half of why the
   * studio's "Attach documents" control was a promise nothing kept — the other half was that
   * nothing wrote the table.
   *
   * ⚠️ `downloadPath` IS A PATH ON THIS API, NOT A LINK TO THE BYTES, and it must stay that way.
   * The bucket is private and `object_storage_key` never leaves the server; every fetch of this
   * path re-runs the same six-term public gate this payload was built under. Sending a presigned
   * storage URL here instead would be a link that keeps working after the video is unpublished —
   * `video_document` has no `url` column precisely so that shortcut is unavailable.
   *
   * `[]` RATHER THAN `null`, for the same reason as `attachedProducts` above: every video can
   * carry documents, so "none" is an empty list rather than an absent capability.
   *
   * NO RE-ELIGIBILITY PASS, unlike `attachedProducts`. A document has no independent publication
   * state that could drift out from under the join — it exists or it does not, and it dies with
   * its video by cascade.
   */
  readonly documents: readonly {
    readonly id: string;
    readonly fileName: string;
    readonly byteSize: number;
    readonly downloadPath: string;
  }[];
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
      ventureSlug: researchProject.slug,
      ventureName: researchProject.name,
      ventureStage: researchProject.stage,
    })
    .from(video)
    .innerJoin(user, eq(user.id, video.creatorId))
    .leftJoin(videoStats, eq(videoStats.videoId, video.id))
    .leftJoin(creatorStats, eq(creatorStats.userId, video.creatorId))
    // THE STATUS TERM BELONGS IN THE JOIN, NOT THE WHERE. In a WHERE it would filter the
    // VIDEO out whenever its venture is a draft, 404ing a perfectly public video because of
    // a fact about something else. Here it only nulls the venture columns, which is exactly
    // the intended answer: the video renders, the badge does not.
    .leftJoin(
      researchProject,
      and(eq(researchProject.id, video.researchProjectId), eq(researchProject.status, "active")),
    )
    .where(and(eq(video.id, videoId), PUBLICLY_SERVABLE, lte(video.publishedAt, sql`now()`)))
    .limit(1);

  if (!row) {
    return { success: false, error: { type: "VIDEO_NOT_FOUND", videoId } };
  }

  // Small ordered reads rather than json aggregation in the main query: each is an index scan
  // on `video_id`, and keeping them separate keeps the row above flat.
  //
  // `loadPublicSeasonsForVideo` RIDES IN THE SAME `Promise.all`, not after it. It is two
  // queries of its own and depends on nothing the others return, so awaiting it separately
  // would add its full latency to a route that already refuses a second round trip on
  // principle.
  const [categories, chapters, openRoleRows, attachedProductRows, seasons, documentRows] =
    await Promise.all([
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
    db
      .select({
        roleTitle: videoOpenRole.roleTitle,
        roleDescription: videoOpenRole.roleDescription,
        openRoleId: videoOpenRole.openRoleId,
      })
      .from(videoOpenRole)
      .where(eq(videoOpenRole.videoId, videoId))
      .orderBy(asc(videoOpenRole.position)),
    db
      .select({
        productId: videoAttachedProduct.productId,
        pinnedAtSeconds: videoAttachedProduct.pinnedAtSeconds,
      })
      .from(videoAttachedProduct)
      .where(eq(videoAttachedProduct.videoId, videoId))
      // The creator's order, which is what `PUT /videos/:videoId/products` stored. No
      // server-side re-sort: rearranging somebody's carousel is a change they did not ask for.
      .orderBy(asc(videoAttachedProduct.position)),
    loadPublicSeasonsForVideo(videoId),
    // ⚠️ `objectStorageKey` IS SELECTED NOWHERE. It is an internal address into a private bucket,
    // and a public payload is the last place it may appear. The path below is composed from ids.
    db
      .select({
        id: videoDocument.id,
        fileName: videoDocument.fileName,
        byteSize: videoDocument.byteSize,
      })
      .from(videoDocument)
      .where(eq(videoDocument.videoId, videoId))
      .orderBy(asc(videoDocument.position)),
  ]);

  // Resolved in ONE query rather than per blurb. Every id here was scoped to this video's own
  // venture when it was written, which is why the batch read does not re-scope it.
  const linkedRoles = await listOpenRolesByIds(
    openRoleRows
      .map((openRoleRow) => openRoleRow.openRoleId)
      .filter((openRoleId): openRoleId is string => openRoleId !== null),
  );
  const linkedRolesById = new Map(linkedRoles.map((linkedRole) => [linkedRole.id, linkedRole]));

  // ONE batch read for the whole carousel, and it applies the store's own eligibility rule
  // rather than a copy of it — `publicProductEligibility` covers active, approved, slugged, the
  // organization trading and public, and the category active. Ineligible ids are dropped and
  // the caller's order is preserved, which is exactly the contract this helper exists to give.
  const productCards = await resolveEligibleProductCardsByIds(
    attachedProductRows.map((attachedProductRow) => attachedProductRow.productId),
  );
  const pinnedSecondsByProductId = new Map(
    attachedProductRows.map((attachedProductRow) => [
      attachedProductRow.productId,
      attachedProductRow.pinnedAtSeconds,
    ]),
  );

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
      openRoles: openRoleRows.map((openRoleRow) => ({
        roleTitle: openRoleRow.roleTitle,
        roleDescription: openRoleRow.roleDescription,
        // Null when the blurb is free text, AND when the linked row has since been deleted —
        // the FK is `restrict` so that should not happen, but the fallback is the text either
        // way rather than a half-rendered apply control.
        linkedRole:
          openRoleRow.openRoleId === null
            ? null
            : (linkedRolesById.get(openRoleRow.openRoleId) ?? null),
      })),
      // Null unless the join found an ACTIVE venture — see the join comment above.
      builtInTheOpen:
        row.ventureSlug === null || row.ventureName === null || row.ventureStage === null
          ? null
          : {
              projectSlug: row.ventureSlug,
              projectName: row.ventureName,
              stage: row.ventureStage,
            },
      seasons,
      // Mapped from the CARDS, not from the join rows, so the two lists cannot disagree about
      // what survived the eligibility filter. `?? null` covers a product whose card came back
      // without a matching join row, which the ordered resolve makes impossible today and which
      // would otherwise be an unpinned card rather than a crash.
      attachedProducts: productCards.map((productCard) => ({
        product: productCard,
        pinnedAtSeconds: pinnedSecondsByProductId.get(productCard.id) ?? null,
      })),
      documents: documentRows.map((documentRow) => ({
        ...documentRow,
        downloadPath: videoDocumentDownloadPath(videoId, documentRow.id),
      })),
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
 *   `isPremium` on an episode — the column exists on `anime_episode`; no entitlement model,
 *      tier or paywall does. A lock icon over an episode that plays for free is a claim this
 *      backend cannot support. `loadPublicSeasonsForVideo` records the same rule.
 *   `transcript`, `isPremium` on the video, product reviews, trending search terms — each
 *      needs a table, a job or a model that does not exist, not a projection.
 *
 * `products` LEFT THIS LIST. It was recorded here as a follow-up and is now `attachedProducts`
 * above, read through the store's own eligibility helper.
 */
