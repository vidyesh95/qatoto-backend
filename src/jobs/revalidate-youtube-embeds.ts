import { and, eq, sql } from "drizzle-orm";

import { config } from "#src/config/index.js";
import { db } from "#src/db/index.js";
import { video } from "#src/db/schema.js";
import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import { logger } from "#src/lib/logger.js";
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
      AND v.published_at < ${asOf}
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

  logger.info("revalidate-youtube-embeds: complete", {
    asOf: payload.asOf,
    checkedCount,
    flippedToFailedCount: failedCount,
    youtubeUnreachableCount: unreachableCount,
  });

  // A run where YouTube answered NOTHING is an outage, not a clean pass. Throwing makes it
  // retry rather than logging a green line over a night where nothing was verified.
  if (checkedCount > 0 && unreachableCount === checkedCount) {
    throw new Error(
      `revalidate-youtube-embeds: YouTube was unreachable for all ${String(checkedCount)} checks`,
    );
  }
}
