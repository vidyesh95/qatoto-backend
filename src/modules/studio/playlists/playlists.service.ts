import { and, asc, count, desc, eq, inArray } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { playlist, playlistItem, video } from "#src/db/schema.js";
import type {
  CreatePlaylistInput,
  UpdatePlaylistInput,
} from "#src/modules/studio/playlists/playlists.schemas.js";
import type { Result } from "#src/types/index.js";

/**
 * Creator-owned playlists (docs/STUDIO_BACKEND_STRUCTURE.md §6).
 *
 * Same ownership discipline as videos.service.ts: `creatorId` is always the session's,
 * the predicate carries it, and "missing" collapses with "not yours" into one 404 so a
 * stranger cannot probe which playlist ids exist.
 */

export type PlaylistNotFoundError = { type: "PLAYLIST_NOT_FOUND"; playlistId: string };

export type PlaylistError =
  | PlaylistNotFoundError
  // Carries every offending id, so the picker can strike them all at once.
  | { type: "VIDEO_NOT_OWNED"; videoIds: readonly string[] };

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

/** Compact row for the playlists list and the upload modal's picker. */
export interface PlaylistListRow {
  readonly id: string;
  readonly title: string;
  readonly visibility: PlaylistRow["visibility"];
  readonly videoCount: number;
  readonly updatedAt: Date;
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
    .where(eq(playlistItem.playlistId, playlistId))
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

/** Video ids the caller does NOT own, order-preserved. */
async function findUnownedVideoIds(
  creatorId: string,
  videoIds: readonly string[],
): Promise<readonly string[]> {
  if (videoIds.length === 0) return [];
  const ownedRows = await db
    .select({ id: video.id })
    .from(video)
    .where(and(eq(video.creatorId, creatorId), inArray(video.id, [...videoIds])));
  const ownedIds = new Set(ownedRows.map((row) => row.id));
  return videoIds.filter((videoId) => !ownedIds.has(videoId));
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

/** The caller's own playlists, newest-touched first. Pure read — always succeeds. */
export async function listMyPlaylists(
  creatorId: string,
  page: number,
  limit: number,
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

  return { rows, total: totals[0]?.value ?? 0 };
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
  const unownedVideoIds = await findUnownedVideoIds(creatorId, uniqueVideoIds);
  if (unownedVideoIds.length > 0) {
    return { success: false, error: { type: "VIDEO_NOT_OWNED", videoIds: unownedVideoIds } };
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
