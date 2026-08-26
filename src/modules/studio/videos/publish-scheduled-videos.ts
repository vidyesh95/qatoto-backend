import { and, asc, eq, isNotNull, lte, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { animeEpisode, creatorStats, video } from "#src/db/schema.js";
import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import { logger } from "#src/lib/logger.js";
import { assertGatingSupported } from "#src/modules/studio/videos/videos.service.js";

/**
 * Publishes videos whose scheduled time has arrived.
 *
 * WHY THIS EXISTS. Two paths set `publish_status = 'scheduled'` with a future
 * `scheduled_publish_at` — `publishVideo` when a creator picks a future date, and
 * `approveAnimeEpisode` when a moderator approves an episode with a later premiere date — and
 * until this job, NOTHING ever moved one on. A scheduled video sat there permanently invisible:
 * `PUBLICLY_SERVABLE` requires `publish_status = 'published'`, so it was in no feed, on no
 * channel and reachable by no link. The scheduling UI worked; the schedule did not.
 *
 * IT RE-RUNS THE PUBLISH GATES RATHER THAN TRUSTING THE SCHEDULE. Time passes between scheduling
 * and firing, and a row can stop qualifying in that gap — a moderator can hide it, an edit can
 * send an episode back to review, a re-verification can fail. `publishVideo` refuses those cases
 * at the creator's request and this must refuse them at the clock's, or the schedule becomes a
 * way to publish something that would be rejected if asked for directly.
 *
 * A ROW THAT NO LONGER QUALIFIES IS LEFT SCHEDULED, NOT FAILED AND NOT DRAFTED. The condition is
 * usually temporary — an episode back in review will be approved again — and silently draughting
 * a creator's video because a sweep found it mid-review would be worse than the delay. It is
 * logged, and it stays visible to the next sweep.
 *
 * THE COUNTER MOVES IN THE SAME TRANSACTION AS THE STATUS, which is the whole lesson of the
 * `published_video_count` drift: two paths published videos without maintaining it and the number
 * was wrong for months because nothing read it. This is a third door into publish and it maintains
 * what the other two maintain.
 */
/**
 * One tick's worth. The cron runs every minute, so this drains 3,000 an hour — fast enough that a
 * backlog is temporary, small enough that one run cannot exceed the queue's 300-second expiry.
 */
const PUBLISH_BATCH_LIMIT = 50;

export async function handlePublishScheduledVideos(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.publishScheduledVideos,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.publishScheduledVideos],
    rawPayload,
  );
  const asOf = new Date(payload.asOf);

  // BOUNDED AND ORDERED, and both matter for a backlog.
  //
  // Each row costs its own transaction — BEGIN, SELECT FOR UPDATE, two to four UPDATEs, an INSERT,
  // COMMIT — so an unbounded sweep over a large backlog runs past this job's 300-second expiry,
  // gets reclaimed mid-loop, and after three retries dead-letters. `singleton` means no second
  // worker arrives to help.
  //
  // Oldest first, so a backlog drains in the order it was promised and each run makes deterministic
  // forward progress: published rows leave the predicate, so the next tick picks up where this one
  // stopped rather than re-scanning the same head.
  const dueRows = await db
    .select({ id: video.id })
    .from(video)
    .where(
      and(
        eq(video.publishStatus, "scheduled"),
        isNotNull(video.scheduledPublishAt),
        lte(video.scheduledPublishAt, asOf),
      ),
    )
    .orderBy(asc(video.scheduledPublishAt), asc(video.id))
    .limit(PUBLISH_BATCH_LIMIT);

  let publishedCount = 0;
  let skippedCount = 0;
  // Counted separately from `skippedCount`: a row someone else holds is a row this sweep will see
  // again next minute, whereas a `notQualified` row needs a human. Folding them together hid a
  // sweep that skipped every row behind a log line that never fired.
  let lockedCount = 0;

  for (const dueRow of dueRows) {
    // ONE TRANSACTION PER VIDEO, not one for the batch. A single row that cannot publish must
    // not roll back the ones already published beside it, and a long sweep should release its
    // locks as it goes.
    const outcome = await db.transaction(async (tx) => {
      // `FOR UPDATE SKIP LOCKED`: a concurrent sweep, or a creator publishing or deleting this
      // very row, takes the lock instead and this one moves on. Re-reading INSIDE the lock is
      // what makes the status assertion below meaningful — the row may have changed since the
      // unlocked select above.
      const [lockedRow] = await tx
        .select({
          id: video.id,
          creatorId: video.creatorId,
          publishStatus: video.publishStatus,
          scheduledPublishAt: video.scheduledPublishAt,
          uploadStatus: video.uploadStatus,
          isSourceVerified: video.isSourceVerified,
          reviewStatus: video.reviewStatus,
          moderationVisibilityState: video.moderationVisibilityState,
          videoType: video.videoType,
          visibility: video.visibility,
          isNdaRequired: video.isNdaRequired,
          videoSource: video.videoSource,
          youtubeVideoId: video.youtubeVideoId,
          title: video.title,
          isMadeForKids: video.isMadeForKids,
        })
        .from(video)
        .where(eq(video.id, dueRow.id))
        .for("update", { skipLocked: true })
        .limit(1);

      if (!lockedRow) return "skipped" as const;

      // Re-asserted under the lock: another sweep may have published it between the select and
      // here, and publishing twice would double-count the creator's published-video counter.
      if (lockedRow.publishStatus !== "scheduled") return "skipped" as const;
      if (lockedRow.scheduledPublishAt === null) return "skipped" as const;
      if (lockedRow.scheduledPublishAt.getTime() > asOf.getTime()) return "skipped" as const;

      // The publish gates, re-run. `publishVideo` refuses each of these at the creator's
      // request; the clock does not get a weaker gate than the creator does.
      if (lockedRow.uploadStatus !== "ready") return "notQualified" as const;
      if (!lockedRow.isSourceVerified) return "notQualified" as const;
      // An episode edited back into review must not go on air because its old premiere date
      // arrived. `not_required` is every non-anime video; `approved` is a cleared episode.
      if (lockedRow.reviewStatus !== "not_required" && lockedRow.reviewStatus !== "approved") {
        return "notQualified" as const;
      }
      // A moderator hid it after it was scheduled. Publishing would undo a takedown on a timer.
      if (lockedRow.moderationVisibilityState !== "visible") return "notQualified" as const;

      // `publishVideo` calls this "the backstop re-check … even if some future write path sets the
      // columns", and this file promises the clock gets no weaker gate than the creator. It was
      // missing. Unreachable today because `video_gating_ck` refuses the same combination at the
      // storage layer, but a stated invariant with a hole in it is how the next one gets through.
      if (
        assertGatingSupported(lockedRow.videoSource, lockedRow.visibility, lockedRow.isNdaRequired)
      ) {
        return "notQualified" as const;
      }

      // THE COMPLETENESS LIST, re-run for the same reason as the gates above: a PATCH between
      // scheduling and firing can empty a title or clear `isMadeForKids`, and `publishVideo`
      // answers INCOMPLETE_FOR_PUBLISH to a creator who tries it in that state.
      if (lockedRow.title.trim() === "") return "notQualified" as const;
      if (lockedRow.videoSource === "youtube" && !lockedRow.youtubeVideoId) {
        return "notQualified" as const;
      }
      if (lockedRow.isMadeForKids === null) return "notQualified" as const;

      // An anime episode with no episode row is the one completeness check that needs a query,
      // and it is not hypothetical: without it this sweep would publish into /anime a video that
      // has no season, no number and no place in a series.
      if (lockedRow.videoType === "anime_episode") {
        const [linkedEpisode] = await tx
          .select({ id: animeEpisode.id })
          .from(animeEpisode)
          .where(eq(animeEpisode.videoId, lockedRow.id))
          .limit(1);
        if (!linkedEpisode) return "notQualified" as const;
      }

      await tx
        .update(video)
        .set({
          publishStatus: "published",
          // THE ANNOUNCED INSTANT, NOT THE SWEEP'S. A creator told an audience 09:00; pinning
          // `publishedAt` to the sweep that happened to run at 09:00:37 would order the feed by
          // cron jitter and disagree with what was promised. It is always in the past here, so
          // the `published_at <= now()` half of the public gate still holds.
          publishedAt: lockedRow.scheduledPublishAt,
        })
        .where(eq(video.id, lockedRow.id));

      // An embargoed episode is approved with `released_at` NULL precisely so that approving
      // early does not put it on air. This is the moment it airs, so this is where that gets
      // filled in — otherwise the episode would be live with no release date behind it.
      if (lockedRow.videoType === "anime_episode") {
        await tx
          .update(animeEpisode)
          .set({ releasedAt: lockedRow.scheduledPublishAt })
          .where(eq(animeEpisode.videoId, lockedRow.id));
      }

      // Same transaction as the status change, same shape as the other two publish doors.
      await tx.insert(creatorStats).values({ userId: lockedRow.creatorId }).onConflictDoNothing();
      await tx
        .update(creatorStats)
        .set({ publishedVideoCount: sql`${creatorStats.publishedVideoCount} + 1` })
        .where(eq(creatorStats.userId, lockedRow.creatorId));

      return "published" as const;
    });

    if (outcome === "published") publishedCount += 1;
    if (outcome === "skipped") lockedCount += 1;
    if (outcome === "notQualified") {
      skippedCount += 1;
      // Named rather than counted silently: a video stuck past its own publish time is a thing
      // a creator will ask about, and the reason has to be findable.
      logger.warn("publish-scheduled-videos: due but no longer qualifies; left scheduled", {
        videoId: dueRow.id,
      });
    }
  }

  if (publishedCount > 0 || skippedCount > 0 || lockedCount > 0) {
    logger.info("publish-scheduled-videos: sweep complete", {
      publishedCount,
      skippedCount,
      lockedCount,
      dueCount: dueRows.length,
      // A full batch means there is more behind it; the next tick continues from here.
      hasMoreLikely: dueRows.length === PUBLISH_BATCH_LIMIT,
      asOf: payload.asOf,
    });
  }
}
