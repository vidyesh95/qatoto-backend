import { and, eq } from "drizzle-orm";

import { config } from "#src/config/index.js";
import { db } from "#src/db/index.js";
import { video } from "#src/db/schema.js";
import {
  JOB_NAMES,
  JOB_PAYLOAD_SCHEMAS,
  parseJobPayload,
  PermanentJobError,
} from "#src/lib/jobs.js";
import { verifyYoutubeVideo } from "#src/lib/youtube.js";

/**
 * Deferred YouTube source verification (HOME_BACKEND_STRUCTURE.md §8.3).
 *
 * WHY THIS JOB EXISTS. `createVideo` used to call oEmbed synchronously and hard-fail with
 * `502 YOUTUBE_VERIFY_FAILED` when the call did not come back. That is the correct trade
 * against storing an unverified id — but it means a network blip at YouTube throws away the
 * creator's work. Now the 11-character id is parsed and stored regardless (the charset CHECK
 * still closes SSRF at the storage layer, so nothing about safety is deferred), the row is
 * created as an unverified draft, and this job retries with backoff until it can prove the
 * video exists and embeds.
 *
 * The invariant "no unverified id in a published row" is preserved by the three READERS of
 * the flag — publish, review-approve, and the §4.5 candidate pool — not by refusing the
 * upload.
 *
 * WHAT COUNTS AS RETRYABLE, and the distinction is the whole design:
 *   YOUTUBE_VERIFY_FAILED     → rethrow. YouTube did not answer. This is the case the job
 *                               was built for; pg-boss backs off up to ~9 hours.
 *   YOUTUBE_VIDEO_UNAVAILABLE → PermanentJobError. The video is deleted, private, or has
 *   INVALID_YOUTUBE_URL         embedding disabled. Retrying can never change that, so it
 *                               dead-letters immediately rather than burning ten attempts.
 *                               `runJob` records it in `job_failure`, which is how an
 *                               operator answers "why is this draft stuck".
 */
export async function handleVerifyYoutubeVideo(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.verifyYoutubeVideo,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.verifyYoutubeVideo],
    rawPayload,
  );

  const [existingVideoRow] = await db
    .select({
      id: video.id,
      videoSource: video.videoSource,
      youtubeVideoId: video.youtubeVideoId,
      isSourceVerified: video.isSourceVerified,
      hasCustomThumbnail: video.hasCustomThumbnail,
    })
    .from(video)
    .where(eq(video.id, payload.videoId))
    .limit(1);

  // Deleted between enqueue and dequeue. Nothing to verify and nothing to alarm about —
  // the same call `deliver-notification` makes for a cascaded row.
  if (!existingVideoRow) {
    return;
  }

  // Already terminal. A retry after a successful verify must not re-ask YouTube, and the
  // flag never goes back to false, so this is a genuine early exit rather than a race.
  if (existingVideoRow.isSourceVerified) {
    return;
  }

  // A hosted row has no YouTube id to prove. Nothing produces one today; this is here so
  // that when Appendix A lands, an enqueue for the wrong source is a no-op and not a crash.
  if (existingVideoRow.videoSource !== "youtube" || !existingVideoRow.youtubeVideoId) {
    return;
  }

  const youtubeVideoId = existingVideoRow.youtubeVideoId;
  const verificationResult = await verifyYoutubeVideo(youtubeVideoId, {
    timeoutMs: config.YOUTUBE_OEMBED_TIMEOUT_MS,
  });

  if (!verificationResult.success) {
    switch (verificationResult.error.type) {
      case "YOUTUBE_VERIFY_FAILED":
        throw new Error(
          `verify-youtube-video: YouTube did not answer for video ${existingVideoRow.id}`,
        );
      case "YOUTUBE_VIDEO_UNAVAILABLE":
        throw new PermanentJobError(
          "YOUTUBE_VIDEO_UNAVAILABLE",
          `verify-youtube-video: ${youtubeVideoId} is deleted, private, or not embeddable ` +
            `(video ${existingVideoRow.id})`,
        );
      case "INVALID_YOUTUBE_URL":
        throw new PermanentJobError(
          "INVALID_YOUTUBE_URL",
          `verify-youtube-video: stored id ${youtubeVideoId} is not a well-formed YouTube id ` +
            `(video ${existingVideoRow.id})`,
        );
      default: {
        const exhaustiveCheck: never = verificationResult.error;
        throw new Error(
          `verify-youtube-video: unhandled verification error ${JSON.stringify(exhaustiveCheck)}`,
        );
      }
    }
  }

  await db
    .update(video)
    .set({
      isSourceVerified: true,
      // Only when the creator has not supplied their own. `hasCustomThumbnail` is what tells
      // DELETE whether we own the Cloudinary asset, so overwriting a custom thumbnail here
      // would both discard the creator's choice and orphan the asset.
      ...(existingVideoRow.hasCustomThumbnail || !verificationResult.value.thumbnailUrl
        ? {}
        : { thumbnailUrl: verificationResult.value.thumbnailUrl }),
    })
    // THE SECOND PREDICATE IS LOAD-BEARING. The creator may have PATCHed the URL between
    // the SELECT above and this UPDATE. Without it we would mark a NEW id verified on the
    // strength of an OLD id's proof — and the new id's own job, keyed on (video, youtubeId),
    // would then find the flag already true and return early, so nothing would ever check it.
    .where(and(eq(video.id, existingVideoRow.id), eq(video.youtubeVideoId, youtubeVideoId)));
}
