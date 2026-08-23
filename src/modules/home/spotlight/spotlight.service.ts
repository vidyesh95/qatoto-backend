/**
 * Home-page Spotlight — up to three admin-picked catalogue videos under the category tiles.
 *
 * PLATFORM-OWNED, like promotions. No member owner; the entire gate is `manage_promotions`,
 * checked before any id is read (platform-role.service.ts ordering rule).
 *
 * WHY REUSE `manage_promotions` AND NOT A NEW CAPABILITY. Spotlight is the same blast
 * radius as the carousel — a front-page placement every visitor sees — and inventing a
 * second admin-only grant for the same staff act would just multiply role ceremony.
 *
 * THE ONLY WRITE IS A WHOLE-SET REPLACE. A partial list is never a merge: the body is the
 * new ordered set of 0..3 unique video ids. That is what stops a stale admin console from
 * silently dropping a slot it had not fetched.
 */

import { asc, eq, inArray, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { feedSpotlightSlot, video } from "#src/db/schema.js";
import { recordPlatformAction } from "#src/modules/platform/audit/platform-audit.service.js";
import {
  requirePlatformCapability,
  type PlatformAccessError,
} from "#src/modules/platform/roles/platform-role.service.js";
import type { Result } from "#src/types/index.js";

/** Hard ceiling — the expanding-tile layout has left / center / right and nothing else. */
export const MAX_SPOTLIGHT_SLOTS = 3;

export type SpotlightError =
  | PlatformAccessError
  | { type: "SPOTLIGHT_VIDEO_NOT_ELIGIBLE"; videoId: string }
  | { type: "SPOTLIGHT_DUPLICATE_VIDEO"; videoId: string }
  | { type: "SPOTLIGHT_TOO_MANY_SLOTS"; limit: number };

/**
 * What a visitor sees. Array order IS the left → center → right contract; `position` is
 * absent so a client cannot re-sort against the admin's intent.
 */
export interface PublicSpotlightVideo {
  readonly videoId: string;
  readonly title: string;
  readonly thumbnailUrl: string | null;
}

/** What the admin console sees — every stored slot, including ones whose video later left the feed. */
export interface AdminSpotlightSlot {
  readonly position: number;
  readonly videoId: string;
  readonly title: string;
  readonly thumbnailUrl: string | null;
  readonly updatedByUserId: string | null;
  readonly updatedAt: Date;
}

/**
 * Byte-identical to `publicVideoPredicate` in feed.service.ts / `video_feed_candidate_idx`.
 * A Spotlight slot that fails this must not reach a visitor — otherwise the rail links to a
 * watch page that 404s.
 */
function publicVideoPredicateSql(): ReturnType<typeof sql> {
  return sql`v.publish_status = 'published'
        AND v.visibility = 'public'
        AND v.upload_status = 'ready'
        AND v.is_source_verified = true
        AND v.review_status IN ('not_required', 'approved')
        AND v.moderation_visibility_state = 'visible'
        AND v.published_at IS NOT NULL AND v.published_at <= now()`;
}

/**
 * `GET /spotlight/videos` — THE ONLY UNAUTHENTICATED FUNCTION IN THIS FILE.
 *
 * Joins through `video` and applies the feed's public predicate, so a slot whose video was
 * later unpublished silently drops out of the rail rather than linking to a 404.
 */
export async function listActiveSpotlightVideos(): Promise<readonly PublicSpotlightVideo[]> {
  const rows = await db.execute<{
    video_id: string;
    title: string;
    thumbnail_url: string | null;
  }>(sql`
    SELECT v.id AS video_id, v.title, v.thumbnail_url
    FROM feed_spotlight_slot AS s
    JOIN video AS v ON v.id = s.video_id
    WHERE ${publicVideoPredicateSql()}
    ORDER BY s.position ASC, s.id ASC
  `);

  return rows.rows.map((row) => ({
    videoId: row.video_id,
    title: row.title,
    thumbnailUrl: row.thumbnail_url,
  }));
}

/** `GET /spotlight/admin/slots` — every stored slot, even if the video is no longer listable. */
export async function listSpotlightSlotsForStaff(
  actorUserId: string,
): Promise<Result<readonly AdminSpotlightSlot[], SpotlightError>> {
  const capabilityResult = await requirePlatformCapability(actorUserId, "manage_promotions");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  const rows = await db
    .select({
      position: feedSpotlightSlot.position,
      videoId: feedSpotlightSlot.videoId,
      title: video.title,
      thumbnailUrl: video.thumbnailUrl,
      updatedByUserId: feedSpotlightSlot.updatedByUserId,
      updatedAt: feedSpotlightSlot.updatedAt,
    })
    .from(feedSpotlightSlot)
    .innerJoin(video, eq(feedSpotlightSlot.videoId, video.id))
    .orderBy(asc(feedSpotlightSlot.position), asc(feedSpotlightSlot.id));

  return { success: true, value: rows };
}

/**
 * `PUT /spotlight/admin/slots` — replace the whole rail.
 *
 * `videoIds` is the new ordered set (0..3, unique). Empty clears the rail. Videos that are
 * not currently feed-eligible are refused with `SPOTLIGHT_VIDEO_NOT_ELIGIBLE` rather than
 * being stored and then silently dropped from the public read.
 */
export async function replaceSpotlightSlots(
  actorUserId: string,
  videoIds: readonly string[],
): Promise<Result<readonly AdminSpotlightSlot[], SpotlightError>> {
  const capabilityResult = await requirePlatformCapability(actorUserId, "manage_promotions");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  if (videoIds.length > MAX_SPOTLIGHT_SLOTS) {
    return {
      success: false,
      error: { type: "SPOTLIGHT_TOO_MANY_SLOTS", limit: MAX_SPOTLIGHT_SLOTS },
    };
  }

  const seenVideoIds = new Set<string>();
  for (const videoId of videoIds) {
    if (seenVideoIds.has(videoId)) {
      return { success: false, error: { type: "SPOTLIGHT_DUPLICATE_VIDEO", videoId } };
    }
    seenVideoIds.add(videoId);
  }

  if (videoIds.length > 0) {
    const eligibilityRows = await db.execute<{ id: string }>(sql`
      SELECT v.id
      FROM video AS v
      WHERE v.id IN (${sql.join(
        videoIds.map((videoId) => sql`${videoId}`),
        sql`, `,
      )})
        AND ${publicVideoPredicateSql()}
    `);
    const eligibleIds = new Set(eligibilityRows.rows.map((row) => row.id));
    for (const videoId of videoIds) {
      if (!eligibleIds.has(videoId)) {
        return { success: false, error: { type: "SPOTLIGHT_VIDEO_NOT_ELIGIBLE", videoId } };
      }
    }
  }

  await recordPlatformAction(
    async (tx) => {
      await tx.delete(feedSpotlightSlot);
      if (videoIds.length === 0) return videoIds;
      await tx.insert(feedSpotlightSlot).values(
        videoIds.map((videoId, position) => ({
          position,
          videoId,
          updatedByUserId: actorUserId,
        })),
      );
      return videoIds;
    },
    (replacedVideoIds) => ({
      eventKind: "spotlight_slots_replaced",
      actorUserId,
      actorRoleSnapshot: capabilityResult.value.platformRole,
      actionLabel: "Replaced the home Spotlight videos",
      targetLabel:
        replacedVideoIds.length === 0
          ? "spotlight (cleared)"
          : `spotlight (${String(replacedVideoIds.length)} video${replacedVideoIds.length === 1 ? "" : "s"})`,
      payload: { videoIds: [...replacedVideoIds] },
      occurredAt: new Date(),
    }),
  );

  // Re-read through the same join the admin list uses so the response matches a subsequent GET.
  if (videoIds.length === 0) {
    return { success: true, value: [] };
  }

  const rows = await db
    .select({
      position: feedSpotlightSlot.position,
      videoId: feedSpotlightSlot.videoId,
      title: video.title,
      thumbnailUrl: video.thumbnailUrl,
      updatedByUserId: feedSpotlightSlot.updatedByUserId,
      updatedAt: feedSpotlightSlot.updatedAt,
    })
    .from(feedSpotlightSlot)
    .innerJoin(video, eq(feedSpotlightSlot.videoId, video.id))
    .where(inArray(feedSpotlightSlot.videoId, [...videoIds]))
    .orderBy(asc(feedSpotlightSlot.position), asc(feedSpotlightSlot.id));

  return { success: true, value: rows };
}
