import { and, asc, eq, gte, isNotNull, isNull } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { dailyLog } from "#src/db/schema.js";
import {
  idempotencyKeyFor,
  JOB_NAMES,
  JOB_PAYLOAD_SCHEMAS,
  parseJobPayload,
  sendJob,
} from "#src/lib/jobs.js";
import { logger } from "#src/lib/logger.js";

/**
 * Re-checks daily logs whose YouTube video was never verified.
 *
 * WHY THIS EXISTS. Deferring verification (§8) changed the failure mode: a create used to hard-fail
 * on an oEmbed error and write NO ROW, so an unverified log could not exist. Now the id is stored
 * and `verify-youtube-video` proves it afterwards — which is right, because losing a member's day
 * of effort evidence to a YouTube blip was the worse trade. But it introduced a state nothing
 * cleaned up: if that job dead-letters, `video_verified_at` stays NULL and, before this sweep,
 * nothing ever looked again.
 *
 * THAT STATE IS NOT COSMETIC. A daily log is effort evidence — it feeds `effort_claim` and the
 * slice ledger — and `submitDailyLog` does not gate on verification, while `updateDailyLog` refuses
 * edits once submitted. So a member could be left with permanently unverified evidence and no route
 * to fix it. The only prior recovery was an operator reading `job_failure`.
 *
 * `revalidate-youtube-embeds` COULD NOT SERVE THIS. It filters `is_source_verified = true` on the
 * `video` table: it re-checks verified studio videos and has never touched `daily_log`.
 *
 * THE AGE BOUND IS THE GIVE-UP POLICY, AND IT IS DELIBERATE. A video that is genuinely deleted,
 * private or non-embeddable will never verify, and retrying it nightly forever is a queue that
 * never drains and an alert nobody reads. Past the window the log stays unverified,
 * `isVideoVerified: false` is the honest permanent answer the surface already renders, and
 * `job_failure` remains the operator's record of why.
 */

/** How long a row stays worth retrying. Beyond this the failure is treated as settled. */
const RESWEEP_WINDOW_DAYS = 7;

/** One night's worth, so a backlog cannot outrun the job's expiry. */
const RESWEEP_BATCH_LIMIT = 200;

export async function handleResweepUnverifiedDailyLogs(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.resweepUnverifiedDailyLogs,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.resweepUnverifiedDailyLogs],
    rawPayload,
  );
  const asOf = new Date(payload.asOf);
  const windowStartsAt = new Date(asOf.getTime() - RESWEEP_WINDOW_DAYS * 24 * 60 * 60 * 1_000);

  const staleRows = await db
    .select({ id: dailyLog.id, youtubeVideoId: dailyLog.youtubeVideoId })
    .from(dailyLog)
    .where(
      and(
        eq(dailyLog.videoSource, "youtube"),
        isNotNull(dailyLog.youtubeVideoId),
        isNull(dailyLog.videoVerifiedAt),
        gte(dailyLog.createdAt, windowStartsAt),
      ),
    )
    .orderBy(asc(dailyLog.createdAt), asc(dailyLog.id))
    .limit(RESWEEP_BATCH_LIMIT);

  let enqueuedCount = 0;
  for (const staleRow of staleRows) {
    if (staleRow.youtubeVideoId === null) continue;

    // The SAME key the create path mints, so a re-enqueue while the original is still in flight
    // dedups rather than racing it. No new verification logic — this only asks again.
    const enqueueResult = await sendJob(
      JOB_NAMES.verifyYoutubeVideo,
      { dailyLogId: staleRow.id },
      {
        idempotencyKey: idempotencyKeyFor.verifyDailyLogVideo(staleRow.id, staleRow.youtubeVideoId),
      },
    );

    // A failed enqueue is logged and skipped rather than thrown: one bad row must not abandon the
    // rest of the batch, and the next night's sweep will pick it up again regardless.
    if (enqueueResult.success) {
      enqueuedCount += 1;
    } else {
      logger.warn("resweep-unverified-daily-logs: enqueue failed", {
        dailyLogId: staleRow.id,
        reason: enqueueResult.error.type,
      });
    }
  }

  if (staleRows.length > 0) {
    logger.info("resweep-unverified-daily-logs: sweep complete", {
      staleCount: staleRows.length,
      enqueuedCount,
      windowDays: RESWEEP_WINDOW_DAYS,
      asOf: payload.asOf,
    });
  }
}
