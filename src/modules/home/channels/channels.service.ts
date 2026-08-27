import { asc, eq, sql, type SQL } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { creatorStats, creatorSubscription, user, userProfileLink } from "#src/db/schema.js";
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
 * THE THREE COUNTERS, AND WHY TWO OF THEM ARE COMPUTED RATHER THAN READ.
 *
 * `subscriberCount` comes from `creator_stats`, which is right: it is derivable from
 * `creator_subscription`, it is reconciled, and it is not a new disclosure — every watch payload
 * already carries it for the video's creator.
 *
 * `publicVideoCount` AND `publicViewCount` DO NOT COME FROM `creator_stats`, and that is the
 * important part. Its `published_video_count` and `total_view_count` were deliberately withheld
 * from this projection, for two reasons that both still hold:
 *
 *   - `published_video_count` counts `publish_status = 'published'` REGARDLESS OF VISIBILITY, so
 *     it routinely exceeds the number of videos this page lists. A header saying 12 over a grid
 *     of 9 reads as a bug, and explaining it would mean explaining which three are private.
 *   - `total_view_count` is a LIFETIME counter including views of videos since made private or
 *     deleted. It is a fact about withdrawn content, which is the one thing every public read on
 *     this surface is built to avoid leaking — a viewer could diff it against the visible grid and
 *     infer that deleted videos existed and roughly how large they were. It is also never
 *     repaired and is EXPECTED to disagree with the sum over surviving videos
 *     (`scripts/reconcile-creator-stats.ts`).
 *
 * So both are aggregated HERE over `publicVideoPredicate()` — the very predicate the video list
 * below uses. That is what makes them publishable: the count cannot exceed what the grid shows,
 * because it is a count of exactly those rows. A creator with private videos has no discrepancy
 * to explain, and neither number says anything about content that was withdrawn.
 *
 * `joinedAt` IS A NEW PUBLIC DISCLOSURE, stated rather than left to ride in. `user.created_at` has
 * until now appeared only in the staff-only user listing. It dates the account, which is mild on
 * its own; it is published because "joined" is what makes the other three legible as a rate rather
 * than as bare totals.
 */
export interface ChannelProfile {
  readonly creatorId: string;
  readonly handle: string;
  readonly name: string;
  readonly imageUrl: string | null;
  readonly subscriberCount: number;
  /**
   * The creator's own description, or null.
   *
   * NULL ALSO MEANS "A MODERATOR HID IT" — see the read below. The client is deliberately not told
   * which, because a channel page that says "this description was hidden" hands a reporter a
   * receipt and the subject a notification, neither of which this surface owes anybody.
   */
  readonly bio: string | null;
  /** The creator's external links, in their chosen order. Empty when hidden or unset. */
  readonly links: readonly { readonly label: string; readonly url: string }[];
  /** Videos this page would list — counted over the grid's own predicate, never the cache. */
  readonly publicVideoCount: number;
  /** Views of those videos only. Deliberately not `creator_stats.total_view_count`. */
  readonly publicViewCount: number;
  readonly joinedAt: Date;
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

  // BOTH AGGREGATES ARE CORRELATED SUBQUERIES OVER `publicVideoPredicate()`, aliasing the video
  // table as `v` because that predicate is written against that alias — it is shared verbatim with
  // the feed and the video list below precisely so the three cannot drift apart.
  //
  // THE SUM IS CAST TO `bigint`, NOT `int`, AND ARRIVES AS A STRING. `video_stats.view_count` sums
  // past 2^31 on a large enough catalogue, and `::int` would answer `integer out of range` — the
  // exact failure `scripts/reconcile-creator-stats.ts` documents having hit. node-postgres hands
  // back `int8` as a string to avoid a lossy `Number`, so it is coerced once, below, where the
  // conversion is visible.
  const publicVideoCount = sql<number>`(
    SELECT COUNT(*)::int
      FROM video AS v
     WHERE v.creator_id = ${user.id}
       AND ${publicVideoPredicate()}
  )`;
  const publicViewCount = sql<string>`(
    SELECT COALESCE(SUM(vs.view_count), 0)::bigint
      FROM video AS v
      LEFT JOIN video_stats AS vs ON vs.video_id = v.id
     WHERE v.creator_id = ${user.id}
       AND ${publicVideoPredicate()}
  )`;

  const [row] = await db
    .select({
      creatorId: user.id,
      handle: user.handle,
      name: user.name,
      imageUrl: user.image,
      subscriberCount: sql<number>`COALESCE(${creatorStats.subscriberCount}, 0)`,
      bio: user.bio,
      profileModerationState: user.profileModerationState,
      publicVideoCount,
      publicViewCount,
      joinedAt: user.createdAt,
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

  /**
   * THE MODERATION GATE, and it is one place on purpose.
   *
   * `bio` and `links` are the only fields a moderator can hide, so this read is their only public
   * consumer and therefore the only place the state has to be honoured. That is what makes the
   * lever cheap: hiding a whole ACCOUNT would mean auditing every public read of a user across the
   * feed, spotlight, comments, the store and R&D — with nothing failing if one were missed.
   *
   * Hidden reads as ABSENT rather than as a tombstone. The links query is skipped entirely, so a
   * hidden profile costs one query fewer rather than fetching rows to throw away.
   */
  const isProfileTextVisible = row.profileModerationState === "visible";

  const links = isProfileTextVisible
    ? await db
        .select({ label: userProfileLink.label, url: userProfileLink.url })
        .from(userProfileLink)
        .where(eq(userProfileLink.userId, row.creatorId))
        .orderBy(asc(userProfileLink.sortOrder))
    : [];

  return {
    success: true,
    value: {
      creatorId: row.creatorId,
      handle: row.handle,
      name: row.name,
      imageUrl: row.imageUrl,
      subscriberCount: row.subscriberCount,
      bio: isProfileTextVisible ? row.bio : null,
      links,
      publicVideoCount: row.publicVideoCount,
      // The one coercion, and the reason the field above it is typed `string` on the way out of
      // the driver. `Number` is safe here in a way `::int` was not: it is lossless to 2^53.
      publicViewCount: Number(row.publicViewCount),
      joinedAt: row.joinedAt,
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
