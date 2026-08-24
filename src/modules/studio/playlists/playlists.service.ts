import { and, asc, count, desc, eq, inArray, lte, or, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { playlist, playlistItem, video } from "#src/db/schema.js";
import type {
  CreatePlaylistInput,
  UpdatePlaylistInput,
} from "#src/modules/studio/playlists/playlists.schemas.js";
import { PUBLICLY_SERVABLE } from "#src/modules/studio/public-video-gate.js";
import type { Result } from "#src/types/index.js";

/**
 * Playlists (docs/STUDIO_BACKEND_STRUCTURE.md §6).
 *
 * THE PLAYLIST IS OWNED; THE VIDEOS IN IT ARE NOT. `creatorId` is always the session's,
 * `ownedPlaylistPredicate` carries it, and "missing" collapses with "not yours" into one
 * 404 so a stranger cannot probe which playlist ids exist. That has not changed.
 *
 * WHAT CHANGED: a playlist may now hold ANY publicly-servable video, not only the owner's
 * own uploads. The schema never assumed otherwise — `playlist_item` has no creator column
 * and `playlist_item_unq (playlist_id, video_id)` is the right key either way — so this
 * was a service-layer policy, and the `VIDEO_NOT_OWNED` arm that enforced it is gone.
 *
 * Two consequences that are NOT optional and are handled below and in videos.service.ts:
 *
 *   1. `loadOwnedPlaylist` must filter video visibility. Before, every row in a playlist
 *      belonged to the person reading it, so there was nothing to hide. Now a playlist
 *      would otherwise keep serving the title and thumbnail of a video its creator has
 *      since made private.
 *   2. `setVideoPlaylists` must scope its DELETE to the caller's own playlists, or a
 *      creator saving their own video's playlist picker evicts that video from every
 *      stranger's playlist. See the note there.
 */

export type PlaylistNotFoundError = { type: "PLAYLIST_NOT_FOUND"; playlistId: string };

export type PlaylistError =
  | PlaylistNotFoundError
  // Carries every offending id, so the picker can strike them all at once.
  | { type: "VIDEO_NOT_FOUND_FOR_PLAYLIST"; videoIds: readonly string[] };

type PlaylistRow = typeof playlist.$inferSelect;

export interface PlaylistVideoView {
  readonly videoId: string;
  readonly title: string;
  readonly thumbnailUrl: string | null;
  readonly position: number;
}

export interface PublicPlaylist {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly visibility: PlaylistRow["visibility"];
  readonly defaultVideoOrder: PlaylistRow["defaultVideoOrder"];
  readonly language: string | null;
  readonly videos: readonly PlaylistVideoView[];
  readonly videoCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Compact row for the playlists list and both pickers. */
export interface PlaylistListRow {
  readonly id: string;
  readonly title: string;
  readonly visibility: PlaylistRow["visibility"];
  readonly videoCount: number;
  readonly updatedAt: Date;
  /**
   * Whether this playlist already holds the video named by `?videoId=`.
   *
   * PRESENT ONLY WHEN THAT PARAMETER WAS SENT, and `undefined` otherwise — the same
   * key-absent-or-real convention `FeedVideoItem.watchedAt` uses. `false` would claim the
   * playlist does not contain the video, which is not a question anyone asked on a plain
   * list read, and a picker cannot tell an honest `false` from a defaulted one.
   */
  readonly containsVideo?: boolean;
}

export interface PlaylistPage {
  readonly rows: readonly PlaylistListRow[];
  readonly total: number;
}

function ownedPlaylistPredicate(creatorId: string, playlistId: string) {
  return and(eq(playlist.id, playlistId), eq(playlist.creatorId, creatorId));
}

async function loadOwnedPlaylist(
  creatorId: string,
  playlistId: string,
): Promise<PublicPlaylist | null> {
  const [row] = await db
    .select()
    .from(playlist)
    .where(ownedPlaylistPredicate(creatorId, playlistId))
    .limit(1);
  if (!row) return null;

  const videos = await db
    .select({
      videoId: playlistItem.videoId,
      title: video.title,
      thumbnailUrl: video.thumbnailUrl,
      position: playlistItem.position,
    })
    .from(playlistItem)
    .innerJoin(video, eq(video.id, playlistItem.videoId))
    .where(
      and(
        eq(playlistItem.playlistId, playlistId),
        // VISIBLE-OR-MINE, and it must be both halves.
        //
        // Without the first half a playlist becomes a way to keep reading the title and
        // thumbnail of a video its creator has since set to private, unpublished or had
        // rejected — the row survives the visibility change because nothing deletes it.
        //
        // Without the second half a creator stops seeing their OWN draft in their OWN
        // playlist, which is the case the picker exists for. Their video is not publicly
        // servable yet and does not need to be; they are the person who made it.
        //
        // A row filtered out here is silently absent rather than shown as a tombstone: the
        // playlist's owner did not remove it and may never have known it changed, so an
        // explanatory row would be explaining someone else's decision to the wrong person.
        or(PUBLICLY_SERVABLE, eq(video.creatorId, creatorId)),
      ),
    )
    .orderBy(asc(playlistItem.position));

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    visibility: row.visibility,
    defaultVideoOrder: row.defaultVideoOrder,
    language: row.language,
    videos,
    videoCount: videos.length,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Video ids the caller may NOT put in a playlist, order-preserved.
 *
 * REPLACES `findUnownedVideoIds`, and the difference is the whole feature: the question is
 * no longer "is this yours" but "may you see it at all". A publicly-servable video belongs
 * in anyone's playlist; your own unpublished draft belongs in yours.
 *
 * Still a real gate, not a formality. Without it a playlist is a place to park an id that
 * was never readable — a private video, a rejected one, an id that does not exist — and
 * `loadOwnedPlaylist` would then filter every one of them back out, leaving a playlist
 * whose `videoCount` a viewer cannot reconcile with what they see.
 */
async function findUnaddableVideoIds(
  creatorId: string,
  videoIds: readonly string[],
): Promise<readonly string[]> {
  if (videoIds.length === 0) return [];
  const addableRows = await db
    .select({ id: video.id })
    .from(video)
    .where(
      and(
        inArray(video.id, [...videoIds]),
        or(
          and(PUBLICLY_SERVABLE, lte(video.publishedAt, sql`now()`)),
          eq(video.creatorId, creatorId),
        ),
      ),
    );
  const addableIds = new Set(addableRows.map((row) => row.id));
  return videoIds.filter((videoId) => !addableIds.has(videoId));
}

/**
 * The next free position in a playlist.
 *
 * APPEND, NOT INSERT. The single-video routes know one video's membership and nothing about
 * the intended order, so they must not rewrite one they cannot see — the same reasoning
 * `setVideoPlaylists` records. `replacePlaylistVideos` is the only route that sets order.
 */
async function nextPlaylistPosition(
  executor: Pick<typeof db, "select">,
  playlistId: string,
): Promise<number> {
  const [tail] = await executor
    .select({ nextPosition: sql<number>`coalesce(max(${playlistItem.position}), -1) + 1` })
    .from(playlistItem)
    .where(eq(playlistItem.playlistId, playlistId));
  return tail?.nextPosition ?? 0;
}

export async function createPlaylist(
  creatorId: string,
  input: CreatePlaylistInput,
): Promise<Result<PublicPlaylist, PlaylistError>> {
  const [created] = await db
    .insert(playlist)
    .values({
      creatorId,
      title: input.title,
      description: input.description,
      visibility: input.visibility,
      defaultVideoOrder: input.defaultVideoOrder,
      language: input.language,
    })
    .returning({ id: playlist.id });

  if (!created) throw new Error("Insert returned no playlist row");

  const loaded = await loadOwnedPlaylist(creatorId, created.id);
  if (!loaded) {
    return { success: false, error: { type: "PLAYLIST_NOT_FOUND", playlistId: created.id } };
  }
  return { success: true, value: loaded };
}

/**
 * The caller's own playlists, newest-touched first. Pure read — always succeeds.
 *
 * `videoIdForMembership` IS THE PICKER'S WHOLE REASON FOR EXISTING. Without it a menu
 * showing "which of my playlists hold this video" is one request per playlist, and it
 * cannot render a checked state until all of them land. With it the answer arrives in the
 * same read as the list, out of `playlist_item_videoId_idx`.
 *
 * A `bool_or` over the existing LEFT JOIN rather than a second correlated subquery: the
 * join is already there for `videoCount`, and the aggregate collapses to `false` for a
 * playlist with no items, which is the right answer.
 */
export async function listMyPlaylists(
  creatorId: string,
  page: number,
  limit: number,
  videoIdForMembership?: string,
): Promise<PlaylistPage> {
  const offset = (page - 1) * limit;

  const [rows, totals] = await Promise.all([
    db
      .select({
        id: playlist.id,
        title: playlist.title,
        visibility: playlist.visibility,
        videoCount: count(playlistItem.id),
        updatedAt: playlist.updatedAt,
        containsVideo:
          videoIdForMembership === undefined
            ? sql<boolean | null>`NULL::boolean`
            : sql<boolean>`bool_or(${playlistItem.videoId} = ${videoIdForMembership})`,
      })
      .from(playlist)
      .leftJoin(playlistItem, eq(playlistItem.playlistId, playlist.id))
      .where(eq(playlist.creatorId, creatorId))
      .groupBy(playlist.id)
      .orderBy(desc(playlist.updatedAt))
      .limit(limit)
      .offset(offset),
    db.select({ value: count() }).from(playlist).where(eq(playlist.creatorId, creatorId)),
  ]);

  return {
    // The key is DROPPED, not defaulted, when membership was not asked for — see the note
    // on `PlaylistListRow.containsVideo`. `bool_or` over an all-NULL group is also NULL,
    // so the coalesce covers an empty playlist as well as an unasked question.
    rows: rows.map(({ containsVideo, ...playlistRow }) =>
      videoIdForMembership === undefined
        ? playlistRow
        : { ...playlistRow, containsVideo: containsVideo ?? false },
    ),
    total: totals[0]?.value ?? 0,
  };
}

export async function getPlaylist(
  creatorId: string,
  playlistId: string,
): Promise<Result<PublicPlaylist, PlaylistError>> {
  const loaded = await loadOwnedPlaylist(creatorId, playlistId);
  if (!loaded) return { success: false, error: { type: "PLAYLIST_NOT_FOUND", playlistId } };
  return { success: true, value: loaded };
}

export async function updatePlaylist(
  creatorId: string,
  playlistId: string,
  patch: UpdatePlaylistInput,
): Promise<Result<PublicPlaylist, PlaylistError>> {
  const scalarUpdates: Partial<typeof playlist.$inferInsert> = {};
  if (patch.title !== undefined) scalarUpdates.title = patch.title;
  if (patch.description !== undefined) scalarUpdates.description = patch.description;
  if (patch.visibility !== undefined) scalarUpdates.visibility = patch.visibility;
  if (patch.defaultVideoOrder !== undefined) {
    scalarUpdates.defaultVideoOrder = patch.defaultVideoOrder;
  }
  if (patch.language !== undefined) scalarUpdates.language = patch.language;

  if (Object.keys(scalarUpdates).length > 0) {
    const updated = await db
      .update(playlist)
      .set(scalarUpdates)
      .where(ownedPlaylistPredicate(creatorId, playlistId))
      .returning({ id: playlist.id });
    if (updated.length === 0) {
      return { success: false, error: { type: "PLAYLIST_NOT_FOUND", playlistId } };
    }
  }

  const loaded = await loadOwnedPlaylist(creatorId, playlistId);
  if (!loaded) return { success: false, error: { type: "PLAYLIST_NOT_FOUND", playlistId } };
  return { success: true, value: loaded };
}

export async function deletePlaylist(
  creatorId: string,
  playlistId: string,
): Promise<Result<{ deleted: true }, PlaylistError>> {
  const deleted = await db
    .delete(playlist)
    .where(ownedPlaylistPredicate(creatorId, playlistId))
    .returning({ id: playlist.id });

  if (deleted.length === 0) {
    return { success: false, error: { type: "PLAYLIST_NOT_FOUND", playlistId } };
  }
  // The items go with it via FK cascade. Deleting a playlist deletes the grouping, never
  // the videos in it.
  return { success: true, value: { deleted: true } };
}

/**
 * Replaces a playlist's membership AND its order.
 *
 * `position = index` here, deliberately, because this endpoint DOES know the intended
 * order — the client sent the whole list. `PUT /videos/:id/playlists` is the mirror
 * operation and appends instead, because it only knows one video's membership and must
 * not rewrite an ordering it cannot see.
 */
export async function replacePlaylistVideos(
  creatorId: string,
  playlistId: string,
  videoIds: readonly string[],
): Promise<Result<PublicPlaylist, PlaylistError>> {
  const [owned] = await db
    .select({ id: playlist.id })
    .from(playlist)
    .where(ownedPlaylistPredicate(creatorId, playlistId))
    .limit(1);
  if (!owned) return { success: false, error: { type: "PLAYLIST_NOT_FOUND", playlistId } };

  // Order-preserving dedupe: without it a repeated id hits playlist_item_unq as a raw
  // 23505 rather than a domain error.
  const uniqueVideoIds = [...new Set(videoIds)];
  const unaddableVideoIds = await findUnaddableVideoIds(creatorId, uniqueVideoIds);
  if (unaddableVideoIds.length > 0) {
    return {
      success: false,
      error: { type: "VIDEO_NOT_FOUND_FOR_PLAYLIST", videoIds: unaddableVideoIds },
    };
  }

  await db.transaction(async (tx) => {
    await tx.delete(playlistItem).where(eq(playlistItem.playlistId, playlistId));
    if (uniqueVideoIds.length > 0) {
      await tx
        .insert(playlistItem)
        .values(uniqueVideoIds.map((videoId, index) => ({ playlistId, videoId, position: index })));
    }
  });

  const loaded = await loadOwnedPlaylist(creatorId, playlistId);
  if (!loaded) return { success: false, error: { type: "PLAYLIST_NOT_FOUND", playlistId } };
  return { success: true, value: loaded };
}

/**
 * Adds ONE video to a playlist — the card menu's verb.
 *
 * `replacePlaylistVideos` above is the studio editor's verb and is wrong for a menu: it
 * takes up to 500 ids and sets order, so a card holding one video would have to send the
 * playlist's entire contents to add itself, and would overwrite any reordering done
 * meanwhile. This appends and touches nothing else.
 *
 * IDEMPOTENT VIA `playlist_item_unq`, not via a read-then-write. `onConflictDoNothing`
 * means a double-tapped menu row is a no-op rather than a 23505 climbing out as a 500 —
 * and checking membership first would be a race between the check and the insert.
 */
export async function addVideoToPlaylist(
  creatorId: string,
  playlistId: string,
  videoId: string,
): Promise<Result<PublicPlaylist, PlaylistError>> {
  const [owned] = await db
    .select({ id: playlist.id })
    .from(playlist)
    .where(ownedPlaylistPredicate(creatorId, playlistId))
    .limit(1);
  if (!owned) return { success: false, error: { type: "PLAYLIST_NOT_FOUND", playlistId } };

  const unaddableVideoIds = await findUnaddableVideoIds(creatorId, [videoId]);
  if (unaddableVideoIds.length > 0) {
    return {
      success: false,
      error: { type: "VIDEO_NOT_FOUND_FOR_PLAYLIST", videoIds: unaddableVideoIds },
    };
  }

  await db.transaction(async (tx) => {
    // Inside the transaction so two concurrent adds cannot read the same tail and collide
    // on `position`. The unique key protects membership; nothing protects ordering but this.
    const position = await nextPlaylistPosition(tx, playlistId);
    await tx.insert(playlistItem).values({ playlistId, videoId, position }).onConflictDoNothing();
  });

  const loadedAfterAdd = await loadOwnedPlaylist(creatorId, playlistId);
  if (!loadedAfterAdd) return { success: false, error: { type: "PLAYLIST_NOT_FOUND", playlistId } };
  return { success: true, value: loadedAfterAdd };
}

/**
 * Removes ONE video from a playlist.
 *
 * A MISSING ROW IS A SUCCESS, not a 404. The caller asked for the video not to be in the
 * playlist and it is not; answering 404 would make a double-tapped toggle render an error
 * for the state the viewer already has. The PLAYLIST still 404s when it is not yours —
 * that is an ownership answer, not an idempotency one.
 *
 * POSITIONS ARE LEFT WITH A HOLE. `position` only has to sort, and renumbering here would
 * rewrite every following row on a menu toggle. `replacePlaylistVideos` re-densifies them
 * whenever the editor next saves an order.
 */
export async function removeVideoFromPlaylist(
  creatorId: string,
  playlistId: string,
  videoId: string,
): Promise<Result<PublicPlaylist, PlaylistError>> {
  const [owned] = await db
    .select({ id: playlist.id })
    .from(playlist)
    .where(ownedPlaylistPredicate(creatorId, playlistId))
    .limit(1);
  if (!owned) return { success: false, error: { type: "PLAYLIST_NOT_FOUND", playlistId } };

  await db
    .delete(playlistItem)
    .where(and(eq(playlistItem.playlistId, playlistId), eq(playlistItem.videoId, videoId)));

  const loadedAfterRemove = await loadOwnedPlaylist(creatorId, playlistId);
  if (!loadedAfterRemove) {
    return { success: false, error: { type: "PLAYLIST_NOT_FOUND", playlistId } };
  }
  return { success: true, value: loadedAfterRemove };
}
