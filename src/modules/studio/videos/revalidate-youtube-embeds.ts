import { and, eq, sql } from "drizzle-orm";

import { config } from "#src/config/index.js";
import { db } from "#src/db/index.js";
import { commerceReview, commerceReviewMedia, video } from "#src/db/schema.js";
import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import { logger } from "#src/lib/logger.js";
import { utcTimestamp } from "#src/lib/sql-time.js";
import { verifyYoutubeVideo } from "#src/lib/youtube.js";

/**
 * §8.2's backstop — the nightly re-check for videos nobody is watching.
 *
 * ## Why this exists when the fast path already does the job
 *
 * A creator can disable embedding on youtube.com at any moment, and Qatoto finds out only
 * by asking. The FAST path is the client: the IFrame API's `onError` fires, the player
 * POSTs the code to `/videos/:videoId/playback-error`, and at three distinct fingerprints
 * the row flips to `uploadStatus: "failed"` within seconds.
 *
 * That path needs viewers. A video sitting at the bottom of the catalog can be dead for
 * months with nobody there to report it, and it would still be served the day somebody
 * finally scrolls that far. This job is what covers that case, and only that case.
 *
 * ## Bounded per run, deliberately
 *
 * Every check is an outbound HTTP request to a third party. Walking the entire catalog in
 * one pass would be a self-inflicted rate limit and would make the job's runtime a
 * function of how successful the platform is. Least-recently-checked first, capped — so
 * the whole catalog is covered on a rotation rather than all at once.
 *
 * ## A YouTube outage must not empty the feed
 *
 * `YOUTUBE_VERIFY_FAILED` means YouTube did not answer. That is NOT evidence the video is
 * gone, and treating it as such during a provider outage would unpublish the catalog. Only
 * `YOUTUBE_VIDEO_UNAVAILABLE` — a definitive 4xx — flips a row.
 */

/** How many videos one run will ask YouTube about. */
const REVALIDATION_BATCH_SIZE = 200;

type RevalidationCandidateRow = {
  readonly id: string;
  readonly youtube_video_id: string;
};

export async function handleRevalidateYoutubeEmbeds(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.revalidateYoutubeEmbeds,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.revalidateYoutubeEmbeds],
    rawPayload,
  );
  const asOf = new Date(payload.asOf);

  // Least-recently-updated first, ending in a unique column so a partial failure re-runs
  // in the same order. `updated_at` is the closest thing to "when did we last touch this"
  // that exists today; a dedicated `lastRevalidatedAt` would be a better signal and is
  // deliberately not being added for a backstop that runs on a rotation anyway.
  const candidates = await db.execute<RevalidationCandidateRow>(sql`
    SELECT v.id, v.youtube_video_id
    FROM video AS v
    WHERE v.publish_status = 'published'
      AND v.visibility = 'public'
      AND v.upload_status = 'ready'
      AND v.is_source_verified = true
      AND v.review_status IN ('not_required', 'approved')
      AND v.video_source = 'youtube'
      AND v.youtube_video_id IS NOT NULL
      AND v.published_at IS NOT NULL
      AND v.published_at < ${utcTimestamp(asOf)}
    ORDER BY v.updated_at ASC, v.id ASC
    LIMIT ${REVALIDATION_BATCH_SIZE}
  `);

  let checkedCount = 0;
  let failedCount = 0;
  let unreachableCount = 0;

  for (const candidate of candidates.rows) {
    const verification = await verifyYoutubeVideo(candidate.youtube_video_id, {
      timeoutMs: config.YOUTUBE_OEMBED_TIMEOUT_MS,
    });
    checkedCount += 1;

    if (verification.success) continue;

    switch (verification.error.type) {
      case "YOUTUBE_VIDEO_UNAVAILABLE":
      case "INVALID_YOUTUBE_URL": {
        // The `upload_status = 'ready'` guard makes this idempotent AND stops it
        // resurrecting a row an operator has since fixed by hand.
        const [flipped] = await db
          .update(video)
          .set({ uploadStatus: "failed" })
          .where(and(eq(video.id, candidate.id), eq(video.uploadStatus, "ready")))
          .returning({ id: video.id });

        if (flipped) {
          failedCount += 1;
          logger.warn("revalidate-youtube-embeds: video is no longer embeddable", {
            videoId: candidate.id,
            youtubeVideoId: candidate.youtube_video_id,
            reason: verification.error.type,
          });
        }
        break;
      }
      case "YOUTUBE_VERIFY_FAILED":
        // YouTube did not answer. NOT evidence of anything about the video — leave the
        // row alone and let the next rotation ask again.
        unreachableCount += 1;
        break;
      default: {
        const exhaustiveCheck: never = verification.error;
        throw new Error(
          `revalidate-youtube-embeds: unhandled verification error ${JSON.stringify(exhaustiveCheck)}`,
        );
      }
    }
  }

  /**
   * A40. The SECOND candidate set, sharing this job rather than getting one of its own.
   *
   * `attachReviewVideo` stores a well-formed YouTube id without checking it resolves, so a
   * review rendered a dead player indefinitely — on the surface a buyer reads to decide whether
   * to trust a seller. Its own docblock has admitted this since Phase 15.
   *
   * FOLDED IN rather than given a second cron: same schedule, same dead-letter queue, same
   * outage guard below, and `verifyYoutubeVideo`'s per-run cache means a video that appears both
   * as a `video` row and in a review is asked about once.
   */
  const reviewMedia = await revalidateReviewMedia(asOf);
  checkedCount += reviewMedia.checkedCount;
  unreachableCount += reviewMedia.unreachableCount;

  logger.info("revalidate-youtube-embeds: complete", {
    asOf: payload.asOf,
    checkedCount,
    flippedToFailedCount: failedCount,
    youtubeUnreachableCount: unreachableCount,
    reviewMediaHiddenCount: reviewMedia.hiddenCount,
    reviewMediaRestoredCount: reviewMedia.restoredCount,
  });

  // A run where YouTube answered NOTHING is an outage, not a clean pass. Throwing makes it
  // retry rather than logging a green line over a night where nothing was verified.
  if (checkedCount > 0 && unreachableCount === checkedCount) {
    throw new Error(
      `revalidate-youtube-embeds: YouTube was unreachable for all ${String(checkedCount)} checks`,
    );
  }
}

type ReviewMediaCandidateRow = {
  readonly id: string;
  readonly review_id: string;
  readonly youtube_video_id: string;
  readonly state: "visible" | "unavailable_upstream";
};

interface ReviewMediaRevalidationTotals {
  readonly checkedCount: number;
  readonly unreachableCount: number;
  readonly hiddenCount: number;
  readonly restoredCount: number;
}

/**
 * A40. Re-checks review video embeds, hiding the dead and restoring the returned.
 *
 * BOTH DIRECTIONS, and the second is not an afterthought: a creator who flips a video from
 * unlisted back to public has fixed it, and a hide that could never be undone would make this
 * job a one-way ratchet against a buyer's own testimony.
 *
 * EVERY WRITE PAIRS THE STATE WITH THE COUNTER, in one transaction. `commerce_review.media_count`
 * counts VISIBLE media from Phase 23 on, so a state flip without the matching counter move
 * leaves a review advertising media it will not show — or hiding media it would.
 */
async function revalidateReviewMedia(asOf: Date): Promise<ReviewMediaRevalidationTotals> {
  /**
   * Both states, because this job is what moves rows in either direction. Ordered
   * least-recently-created first and ending in the unique id, so a run that dies part way
   * resumes in the same order — the reasoning the `video` query above states.
   */
  const candidates = await db.execute<ReviewMediaCandidateRow>(sql`
    SELECT media.id, media.review_id, media.youtube_video_id, media.state::text AS state
    FROM commerce_review_media AS media
    INNER JOIN commerce_review AS review ON review.id = media.review_id
    WHERE media.media_kind = 'youtube_video'
      AND media.youtube_video_id IS NOT NULL
      AND review.visibility = 'visible'
      AND media.created_at < ${utcTimestamp(asOf)}
    ORDER BY media.created_at ASC, media.id ASC
    LIMIT ${REVALIDATION_BATCH_SIZE}
  `);

  let checkedCount = 0;
  let unreachableCount = 0;
  let hiddenCount = 0;
  let restoredCount = 0;

  for (const candidate of candidates.rows) {
    const verification = await verifyYoutubeVideo(candidate.youtube_video_id, {
      timeoutMs: config.YOUTUBE_OEMBED_TIMEOUT_MS,
    });
    checkedCount += 1;

    if (verification.success) {
      if (candidate.state !== "unavailable_upstream") continue;
      const restored = await setReviewMediaState(candidate.id, candidate.review_id, "visible");
      if (restored) {
        restoredCount += 1;
        logger.info("revalidate-youtube-embeds: review video is embeddable again", {
          reviewMediaId: candidate.id,
          youtubeVideoId: candidate.youtube_video_id,
        });
      }
      continue;
    }

    switch (verification.error.type) {
      case "YOUTUBE_VIDEO_UNAVAILABLE":
      case "INVALID_YOUTUBE_URL": {
        if (candidate.state === "unavailable_upstream") break;
        const hidden = await setReviewMediaState(
          candidate.id,
          candidate.review_id,
          "unavailable_upstream",
        );
        if (hidden) {
          hiddenCount += 1;
          logger.warn("revalidate-youtube-embeds: review video is no longer embeddable", {
            reviewMediaId: candidate.id,
            youtubeVideoId: candidate.youtube_video_id,
            reason: verification.error.type,
          });
        }
        break;
      }
      case "YOUTUBE_VERIFY_FAILED":
        // YouTube did not answer. NOT evidence of anything about the video.
        unreachableCount += 1;
        break;
      default: {
        const exhaustiveCheck: never = verification.error;
        throw new Error(
          `revalidate-youtube-embeds: unhandled verification error ${JSON.stringify(exhaustiveCheck)}`,
        );
      }
    }
  }

  return { checkedCount, unreachableCount, hiddenCount, restoredCount };
}

/**
 * Moves one media row between states and its review's counter with it, atomically.
 *
 * The `state` guard in the WHERE is what the `video` branch's `upload_status = 'ready'` guard is:
 * it makes the write idempotent AND stops the job undoing a change somebody else made between
 * the read and this update. Zero rows updated means somebody won that race, and the counter must
 * not move for a state flip that did not happen.
 */
async function setReviewMediaState(
  mediaId: string,
  reviewId: string,
  nextState: "visible" | "unavailable_upstream",
): Promise<boolean> {
  const hiding = nextState === "unavailable_upstream";

  return db.transaction(async (transaction) => {
    const [moved] = await transaction
      .update(commerceReviewMedia)
      .set({
        state: nextState,
        unavailableAt: hiding ? new Date() : null,
      })
      .where(
        and(
          eq(commerceReviewMedia.id, mediaId),
          eq(commerceReviewMedia.state, hiding ? "visible" : "unavailable_upstream"),
        ),
      )
      .returning({ id: commerceReviewMedia.id });

    if (!moved) return false;

    /**
     * `media_count` counts VISIBLE media (A40). `GREATEST(… - 1, 0)` and `LEAST(… + 1, 6)` keep
     * it inside `commerce_review_media_count_ck` even if the counter has drifted, because a job
     * that cannot run is worse than a counter that is briefly wrong — and
     * `verify-store-phase-10-constraints` reports the drift either way.
     */
    await transaction
      .update(commerceReview)
      .set({
        mediaCount: hiding
          ? sql`GREATEST(${commerceReview.mediaCount} - 1, 0)`
          : sql`LEAST(${commerceReview.mediaCount} + 1, 6)`,
      })
      .where(eq(commerceReview.id, reviewId));

    return true;
  });
}
