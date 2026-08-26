import { eq, sql, type SQL } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { creatorStats, creatorSubscription, user } from "#src/db/schema.js";
import { decodeInstantCursor, encodeInstantCursor } from "#src/lib/instant-cursor.js";
import {
  feedSelectClause,
  publicVideoPredicate,
  toFeedVideoItem,
  type FeedRow,
  type FeedVideoItem,
} from "#src/modules/home/feed/feed.service.js";
import type { Result } from "#src/types/index.js";

/**
 * The channel page — `GET /channels/:handle` and `GET /channels/:handle/videos`.
 *
 * WHY IT EXISTS, and it is a defect report rather than a feature request. `VideoCard` renders a
 * creator's avatar and name as two separate links to `/channel/{handle}`, and
 * `venture-video-reel.tsx` linked the same creator to `/@{handle}` — two shapes for one
 * destination, and NEITHER ROUTE EXISTED. Every card in every feed, on the home page and in the
 * watch page's recommended rail, carried two dead links; the library's subscriptions list had to
 * render creators as unclickable text rather than join them. This module is the destination.
 *
 * KEYED BY HANDLE, NOT BY USER ID. `user.handle` is `unique()`, so the lookup is one indexed
 * probe, and a handle is the only creator identifier that appears in a URL anywhere on this
 * platform. The consequence is deliberate: a creator who has never set a handle has NO channel
 * page, which is already true of every link — `toVideoCardProps` omits `channelHref` entirely
 * for them rather than building `/channel/null`.
 *
 * `/channels`, NOT `/creators/:handle`. `creatorRouter` already owns
 * `/creators/:creatorId/subscribe`, which takes an ID; hanging a HANDLE off the same prefix
 * would put two identifier types on one path, and the next person to add a route there would
 * have to guess which. Both routes here are two segments deep, which `engagement.routes.ts`
 * flags as load-bearing — the studio router mounts first and its `GET /:videoId` permanently
 * shadows any public single-segment route, producing a 401 that reads as an auth bug.
 *
 * NOTHING HERE PROJECTS A NEW PROJECTION. The video rows are the feed's own `FeedVideoItem`,
 * built by the feed's own select clause and row mapper, so a card on a channel page and the same
 * card on the home page cannot disagree. Only the WHERE and the ORDER BY are this file's.
 */

export type ChannelError =
  | { readonly type: "CHANNEL_NOT_FOUND"; readonly handle: string }
  | { readonly type: "CURSOR_MALFORMED" };

/**
 * The channel header.
 *
 * `subscriberCount` IS THE ONLY COUNTER, and it is not a new disclosure — every watch payload
 * already carries it for the video's creator. The two beside it in `creator_stats` are
 * deliberately absent:
 *
 *   `publishedVideoCount` counts `publish_status = 'published'` REGARDLESS OF VISIBILITY, so it
 *      would routinely exceed the number of videos this page lists. A header that says 12 over a
 *      grid of 9 reads as a bug, and explaining it would mean explaining which three are private.
 *   `totalViewCount` is a LIFETIME counter that includes views of videos since made private or
 *      deleted. It is therefore a fact about withdrawn content, which is the one thing every
 *      public read on this surface is built to avoid leaking.
 */
export interface ChannelProfile {
  readonly creatorId: string;
  readonly handle: string;
  readonly name: string;
  readonly imageUrl: string | null;
  readonly subscriberCount: number;
  readonly viewerState: {
    /** `false`, never null, for an anonymous viewer — definitionally true of them. */
    readonly isSubscribedToCreator: boolean;
  };
}

export interface ChannelVideoPage {
  readonly rows: readonly FeedVideoItem[];
  readonly nextCursor: string | null;
}

/**
 * `GET /channels/:handle`.
 *
 * ONE 404 FOR EVERYTHING — no such handle, and a handle nobody has claimed. Same policy the
 * watch payload states for videos, and for the same reason: a distinguishable answer turns this
 * into an oracle for which handles exist.
 *
 * `leftJoin(creatorStats)` + `COALESCE`, the pattern `video-watch.service.ts` uses. A creator
 * whose stats row has not been minted is a real creator with zero subscribers; an `innerJoin`
 * would 404 them, which is a page disappearing because of a cache row.
 */
export async function getChannelProfile(input: {
  readonly handle: string;
  readonly viewerUserId: string | null;
}): Promise<Result<ChannelProfile, ChannelError>> {
  const isSubscribed: SQL<boolean> =
    input.viewerUserId === null
      ? sql<boolean>`false`
      : sql<boolean>`EXISTS (
            SELECT 1 FROM ${creatorSubscription}
            WHERE ${creatorSubscription.creatorId} = ${user.id}
              AND ${creatorSubscription.subscriberId} = ${input.viewerUserId}
          )`;

  const [row] = await db
    .select({
      creatorId: user.id,
      handle: user.handle,
      name: user.name,
      imageUrl: user.image,
      subscriberCount: sql<number>`COALESCE(${creatorStats.subscriberCount}, 0)`,
      isSubscribedToCreator: isSubscribed,
    })
    .from(user)
    .leftJoin(creatorStats, eq(creatorStats.userId, user.id))
    .where(eq(user.handle, input.handle))
    .limit(1);

  // `row.handle` is nullable on the table and cannot be null here — the WHERE matched it — but
  // narrowing it explicitly is what lets `ChannelProfile.handle` be a plain string rather than
  // pushing a null the client would have to branch on into a field that is the page's own key.
  if (!row || row.handle === null) {
    return { success: false, error: { type: "CHANNEL_NOT_FOUND", handle: input.handle } };
  }

  return {
    success: true,
    value: {
      creatorId: row.creatorId,
      handle: row.handle,
      name: row.name,
      imageUrl: row.imageUrl,
      subscriberCount: row.subscriberCount,
      viewerState: { isSubscribedToCreator: row.isSubscribedToCreator },
    },
  };
}

/**
 * `GET /channels/:handle/videos` — that creator's public videos, newest first.
 *
 * NOT THE FEED, and the difference is the point. `listFeedVideos` is a personalized ranker: it
 * excludes what the viewer already watched, drops the viewer's own uploads, applies a recency
 * window and relaxes each of those in stages. Every one of those is wrong here. A channel is a
 * CATALOGUE — it shows what the creator published, in the order they published it, to everybody
 * the same. The one thing it borrows is the projection.
 *
 * NO `creator_mute` OR `video_not_interested` EXCLUSION EITHER. Those two suppress a creator
 * from a FEED, which is a recommendation. Arriving at a channel page is an explicit request for
 * that creator, and `GET /feed/search` already makes the same call for the same reason: hiding a
 * result somebody asked for by name reads as broken rather than as a preference honoured.
 *
 * KEYSET ON `(published_at, id)`. `publicVideoPredicate` guarantees `published_at IS NOT NULL`,
 * which is what makes the cursor total — an unpublished row has no position in this order.
 */
export async function listChannelVideos(input: {
  readonly handle: string;
  readonly viewerUserId: string | null;
  readonly limit: number;
  readonly cursor: string | null;
}): Promise<Result<ChannelVideoPage, ChannelError>> {
  const decodedCursor = input.cursor === null ? null : decodeInstantCursor(input.cursor);
  if (input.cursor !== null && decodedCursor === null) {
    return { success: false, error: { type: "CURSOR_MALFORMED" } };
  }

  const [creator] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.handle, input.handle))
    .limit(1);

  if (!creator) {
    return { success: false, error: { type: "CHANNEL_NOT_FOUND", handle: input.handle } };
  }

  // Both columns sort the same direction as the ORDER BY below; a cursor whose two columns
  // disagree with it skips rows at every page boundary.
  const cursorCondition =
    decodedCursor === null
      ? sql`true`
      : sql`(v.published_at, v.id) < (${decodedCursor.instant.toISOString()}::timestamp, ${decodedCursor.id})`;

  // ONE EXTRA ROW as the has-next-page proof, rather than a COUNT over the creator's catalogue.
  const pageQuery = sql`
    SELECT ${feedSelectClause(input.viewerUserId)}
    FROM video AS v
    JOIN "user" AS u ON u.id = v.creator_id
    LEFT JOIN video_stats AS vs ON vs.video_id = v.id
    WHERE ${publicVideoPredicate()}
      AND v.creator_id = ${creator.id}
      AND ${cursorCondition}
    ORDER BY v.published_at DESC, v.id DESC
    LIMIT ${input.limit + 1}
  `;

  const result = await db.execute<FeedRow>(pageQuery);
  const rows = result.rows.map(toFeedVideoItem);
  const pageRows = rows.slice(0, input.limit);
  const lastRow = pageRows.at(-1);
  const nextCursor =
    rows.length > input.limit && lastRow !== undefined && lastRow.publishedAt !== null
      ? encodeInstantCursor({ instant: lastRow.publishedAt, id: lastRow.videoId })
      : null;

  return { success: true, value: { rows: pageRows, nextCursor } };
}
