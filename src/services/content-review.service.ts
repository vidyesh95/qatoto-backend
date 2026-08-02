import { and, count, desc, eq } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  animeEpisode,
  animeSeason,
  animeSeries,
  contentReviewAction,
  video,
} from "#src/db/schema.js";
import { appendPlatformAuditEntry } from "#src/services/platform-audit.service.js";
import {
  requirePlatformCapability,
  type PlatformAccessError,
} from "#src/services/platform-role.service.js";
import type { ContentReviewStatus, VideoNotFoundError } from "#src/services/videos.service.js";
import type { Result } from "#src/types/index.js";

/**
 * Staff moderation of anime episodes (docs/STUDIO_BACKEND_STRUCTURE.md §6, §10).
 *
 * THE CAPABILITY CHECK LIVES HERE, not in middleware and not in the controller. Middleware
 * cannot return a `Result`, so it could not take part in the controller's exhaustive error
 * switch — it would have to write a response or throw, which puts an authorization
 * decision outside the one place that maps domain errors to statuses. This is the same
 * reasoning discovery-moderation.service.ts records, and platform-role.service.ts states
 * it as the reason `requirePlatformCapability` is a service at all.
 *
 * AND IT RUNS BEFORE ANY ID IS READ. Reversed, every one of these routes becomes an id
 * oracle for anyone holding a session: a 404-vs-403 difference would tell a stranger
 * which video ids exist. Checked first, a non-staff caller gets an identical 403 for a
 * real id and a garbage one.
 *
 * NOTE §10's spec proposal is deliberately NOT followed: there is no `user.role` column,
 * no `requireRole` middleware and no admin seed script. `user.platformRole` and the
 * capability grants already exist, the rank ladder §10 proposes is the exact model
 * platform-role.service.ts rejects (auditor and moderator are disjoint, not ranked), and
 * putting a staff flag on the client-visible session is what schema.ts forbids by name.
 * Granting is `pnpm db:grant-platform-role`, a shell action, as it already was.
 */

export type ContentReviewError =
  | PlatformAccessError
  | VideoNotFoundError
  | { type: "NOT_AN_ANIME_EPISODE" }
  | { type: "REVIEW_NOT_PENDING"; reviewStatus: ContentReviewStatus }
  // Shares the literal AND the payload shape with videos.service.ts's arm, deliberately:
  // TypeScript only collapses two union members carrying the same `type` when their
  // payloads are identical, and the studio mapper switches over both unions at once.
  | { type: "SOURCE_NOT_VERIFIED"; youtubeVideoId: string | null };

/** One row of the moderation queue. */
export interface ReviewQueueRow {
  readonly videoId: string;
  readonly title: string;
  readonly thumbnailUrl: string | null;
  /** Rebuilt server-side so the reviewer watches the real video, never a client string. */
  readonly youtubeVideoId: string | null;
  readonly creatorId: string;
  readonly reviewStatus: ContentReviewStatus;
  readonly rejectionReason: string | null;
  readonly seriesTitle: string | null;
  readonly seasonLabel: string | null;
  readonly episodeNumber: number | null;
  readonly episodeTitle: string | null;
  readonly premiereDate: Date | null;
  readonly submittedAt: Date;
}

export interface ReviewQueuePage {
  readonly rows: readonly ReviewQueueRow[];
  readonly total: number;
}

/** The decision, plus enough context for the audit view to render it. */
export interface ReviewDecision {
  readonly videoId: string;
  readonly reviewStatus: ContentReviewStatus;
  readonly publishStatus: "draft" | "scheduled" | "published";
  readonly publishedAt: Date | null;
  readonly releasedAt: Date | null;
  readonly rejectionReason: string | null;
}

/**
 * The moderation queue: anime episodes in the requested review state.
 *
 * Ordered oldest-first, deliberately — a queue that surfaces the newest submission first
 * starves the oldest one, which is the submission that has already waited longest.
 */
export async function listReviewQueue(
  actorUserId: string,
  filters: {
    readonly status: ContentReviewStatus;
    readonly page: number;
    readonly limit: number;
  },
): Promise<Result<ReviewQueuePage, ContentReviewError>> {
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_content");
  if (!capabilityResult.success) return { success: false, error: capabilityResult.error };

  const predicate = and(
    eq(video.videoType, "anime_episode"),
    eq(video.reviewStatus, filters.status),
  );
  const offset = (filters.page - 1) * filters.limit;

  const [rows, totals] = await Promise.all([
    db
      .select({
        videoId: video.id,
        title: video.title,
        thumbnailUrl: video.thumbnailUrl,
        youtubeVideoId: video.youtubeVideoId,
        creatorId: video.creatorId,
        reviewStatus: video.reviewStatus,
        rejectionReason: video.rejectionReason,
        seriesTitle: animeSeries.title,
        seasonLabel: animeSeason.seasonLabel,
        episodeNumber: animeEpisode.episodeNumber,
        episodeTitle: animeEpisode.episodeTitle,
        premiereDate: animeEpisode.premiereDate,
        submittedAt: video.updatedAt,
      })
      .from(video)
      .leftJoin(animeEpisode, eq(animeEpisode.videoId, video.id))
      .leftJoin(animeSeason, eq(animeSeason.id, animeEpisode.seasonId))
      .leftJoin(animeSeries, eq(animeSeries.id, animeSeason.seriesId))
      .where(predicate)
      .orderBy(desc(video.updatedAt))
      .limit(filters.limit)
      .offset(offset),
    db.select({ value: count() }).from(video).where(predicate),
  ]);

  return { success: true, value: { rows, total: totals[0]?.value ?? 0 } };
}

/** Loads a pending anime episode for a decision, capability already proven. */
async function loadPendingEpisode(videoId: string): Promise<
  Result<
    {
      reviewStatus: ContentReviewStatus;
      premiereDate: Date | null;
      isSourceVerified: boolean;
      youtubeVideoId: string | null;
    },
    ContentReviewError
  >
> {
  const [row] = await db
    .select({
      videoType: video.videoType,
      reviewStatus: video.reviewStatus,
      isSourceVerified: video.isSourceVerified,
      youtubeVideoId: video.youtubeVideoId,
      premiereDate: animeEpisode.premiereDate,
      episodeId: animeEpisode.id,
    })
    .from(video)
    .leftJoin(animeEpisode, eq(animeEpisode.videoId, video.id))
    .where(eq(video.id, videoId))
    .limit(1);

  if (!row) return { success: false, error: { type: "VIDEO_NOT_FOUND", videoId } };
  if (row.videoType !== "anime_episode" || !row.episodeId) {
    return { success: false, error: { type: "NOT_AN_ANIME_EPISODE" } };
  }
  if (row.reviewStatus !== "pending") {
    return {
      success: false,
      error: { type: "REVIEW_NOT_PENDING", reviewStatus: row.reviewStatus },
    };
  }

  // NOT gated on isSourceVerified here: this loader serves the REJECT path too, and an
  // episode whose source could not be verified is one a moderator must still be able to
  // reject. The gate belongs on approve alone — see approveAnimeEpisode.
  return {
    success: true,
    value: {
      reviewStatus: row.reviewStatus,
      premiereDate: row.premiereDate,
      isSourceVerified: row.isSourceVerified,
      youtubeVideoId: row.youtubeVideoId,
    },
  };
}

/**
 * Approves an episode into /anime.
 *
 * AUTO-PUBLISH IS DATE-AWARE (§6). An episode with a future `premiereDate` becomes
 * `scheduled`, not `published`, and `releasedAt` stays null until it actually airs —
 * approving early must not put an embargoed episode on air. With no premiere date, or one
 * already past, it goes live now.
 *
 * All three writes are one transaction: a decision recorded without the state change it
 * describes, or a state change with no audit row, are both worse than neither.
 */
export async function approveAnimeEpisode(
  actorUserId: string,
  videoId: string,
): Promise<Result<ReviewDecision, ContentReviewError>> {
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_content");
  if (!capabilityResult.success) return { success: false, error: capabilityResult.error };

  const pending = await loadPendingEpisode(videoId);
  if (!pending.success) return { success: false, error: pending.error };

  // THE SECOND DOOR INTO PUBLISH (HOME_BACKEND_STRUCTURE.md §8.3). `publishVideo` is the
  // obvious one and it is gated there; approving an episode publishes it too, and a gate
  // on only one of the two doors is not a gate. An unverified episode stays pending until
  // `verify-youtube-video` proves its source, and the moderator can still reject it.
  if (!pending.value.isSourceVerified) {
    return {
      success: false,
      error: { type: "SOURCE_NOT_VERIFIED", youtubeVideoId: pending.value.youtubeVideoId },
    };
  }

  const now = new Date();
  const premiereDate = pending.value.premiereDate;
  const isEmbargoed = premiereDate !== null && premiereDate.getTime() > now.getTime();

  const decision = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(video)
      .set(
        isEmbargoed
          ? {
              reviewStatus: "approved",
              rejectionReason: null,
              publishStatus: "scheduled",
              scheduledPublishAt: premiereDate,
            }
          : {
              reviewStatus: "approved",
              rejectionReason: null,
              publishStatus: "published",
              publishedAt: now,
            },
      )
      .where(eq(video.id, videoId))
      .returning({
        reviewStatus: video.reviewStatus,
        publishStatus: video.publishStatus,
        publishedAt: video.publishedAt,
        rejectionReason: video.rejectionReason,
      });

    const [releasedEpisode] = await tx
      .update(animeEpisode)
      .set({ releasedAt: isEmbargoed ? null : now })
      .where(eq(animeEpisode.videoId, videoId))
      .returning({ releasedAt: animeEpisode.releasedAt });

    await tx.insert(contentReviewAction).values({
      videoId,
      reviewerId: capabilityResult.value.staffUserId,
      action: "approve",
    });

    await appendPlatformAuditEntry(tx, {
      eventKind: "content_review_approved",
      actorUserId,
      actorRoleSnapshot: capabilityResult.value.platformRole,
      actionLabel: "Approved a video in review",
      targetLabel: `video ${videoId}`,
      payload: { videoId },
      occurredAt: new Date(),
    });

    return { updated, releasedAt: releasedEpisode?.releasedAt ?? null };
  });

  if (!decision.updated) return { success: false, error: { type: "VIDEO_NOT_FOUND", videoId } };

  return {
    success: true,
    value: {
      videoId,
      reviewStatus: decision.updated.reviewStatus,
      publishStatus: decision.updated.publishStatus,
      publishedAt: decision.updated.publishedAt,
      releasedAt: decision.releasedAt,
      rejectionReason: decision.updated.rejectionReason,
    },
  };
}

/**
 * Rejects an episode with a reason.
 *
 * `publishStatus` is untouched: a pending episode is already `draft`, because publish
 * routes an episode to review rather than to air (§10). The reason is REQUIRED at the
 * schema level — a rejection with no reason is unactionable for the creator and
 * unauditable for the next moderator, and the DB CHECK enforces the same thing.
 */
export async function rejectAnimeEpisode(
  actorUserId: string,
  videoId: string,
  reason: string,
): Promise<Result<ReviewDecision, ContentReviewError>> {
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_content");
  if (!capabilityResult.success) return { success: false, error: capabilityResult.error };

  const pending = await loadPendingEpisode(videoId);
  if (!pending.success) return { success: false, error: pending.error };

  const decision = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(video)
      .set({ reviewStatus: "rejected", rejectionReason: reason })
      .where(eq(video.id, videoId))
      .returning({
        reviewStatus: video.reviewStatus,
        publishStatus: video.publishStatus,
        publishedAt: video.publishedAt,
        rejectionReason: video.rejectionReason,
      });

    await tx.insert(contentReviewAction).values({
      videoId,
      reviewerId: capabilityResult.value.staffUserId,
      action: "reject",
      reason,
    });

    // `content_review_action` is this domain's record of record and stays so. The
    // platform chain records it a second time for a different reader: one log that
    // answers "what has this moderator done", across taxonomy, directory and content,
    // rather than three tables somebody has to know to join (§11l.2).
    await appendPlatformAuditEntry(tx, {
      eventKind: "content_review_rejected",
      actorUserId,
      actorRoleSnapshot: capabilityResult.value.platformRole,
      actionLabel: "Rejected a video in review",
      targetLabel: `video ${videoId}`,
      detailNote: reason,
      payload: { videoId },
      occurredAt: new Date(),
    });

    return updated;
  });

  if (!decision) return { success: false, error: { type: "VIDEO_NOT_FOUND", videoId } };

  return {
    success: true,
    value: {
      videoId,
      reviewStatus: decision.reviewStatus,
      publishStatus: decision.publishStatus,
      publishedAt: decision.publishedAt,
      releasedAt: null,
      rejectionReason: decision.rejectionReason,
    },
  };
}
