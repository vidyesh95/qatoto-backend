import { and, eq, isNull, ne, or, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { video } from "#src/db/schema.js";
import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import { logger } from "#src/lib/logger.js";

/**
 * `video.duration_seconds`, by consensus — HOME_BACKEND_STRUCTURE.md §3.3.
 *
 * ## The problem this solves
 *
 * Completion rate is the single most predictive signal in a short-form ranker and it
 * carries 40 of quality's 100 points. It needs a denominator. `video.duration_seconds` is
 * NULL on every row on the platform, because YouTube's oEmbed response does not include a
 * duration and the bytes live on someone else's CDN.
 *
 * The only source is `reportedDurationSeconds`, pinned on the first beacon of each viewing
 * session — and that number comes from the hostile side.
 *
 * ## Why a median, and why five
 *
 * A median over five independent untrusted clients is not trustworthy in the cryptographic
 * sense. It is trustworthy enough to divide by. An attacker who wants to move it has to
 * out-number the honest sessions, and `videoViewSession`'s unique index means each of those
 * costs them a distinct fingerprint for the day.
 *
 * `percentile_disc`, NOT `percentile_cont`: the discrete variant returns a value that was
 * actually observed. The continuous one interpolates and returns a FLOAT, which Rule 2
 * forbids and which would put a half-second into a column no client ever reported.
 *
 * Below five samples the column stays NULL. Rule 5: absence is not zero, and a wrong
 * denominator is worse than no denominator — it would silently scale every completion
 * measurement on that video.
 */

/** §3.3's threshold. Fewer than this and the median is one person's opinion. */
const MINIMUM_DURATION_SAMPLES = 5;

type MedianDurationRow = {
  readonly video_id: string;
  readonly median_duration_seconds: number;
  readonly sample_count: number;
};

export async function handleRecomputeVideoDurations(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.recomputeVideoDurations,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.recomputeVideoDurations],
    rawPayload,
  );
  const asOf = new Date(payload.asOf);

  // BOUNDED BY asOf, like every input to every recompute in this codebase. Without it the
  // job is a function of wall-clock time and replaying a historical asOf for an audit
  // produces a different answer than the original run did.
  const medians = await db.execute<MedianDurationRow>(sql`
    SELECT
      video_id,
      percentile_disc(0.5) WITHIN GROUP (ORDER BY pinned_duration_seconds)::int
        AS median_duration_seconds,
      count(*)::int AS sample_count
    FROM video_view_session
    WHERE first_beacon_at < ${asOf}
    GROUP BY video_id
    HAVING count(*) >= ${MINIMUM_DURATION_SAMPLES}
    ORDER BY video_id
  `);

  let updatedCount = 0;

  for (const row of medians.rows) {
    const [updated] = await db
      .update(video)
      .set({ durationSeconds: row.median_duration_seconds })
      .where(
        and(
          eq(video.id, row.video_id),
          // Skip the write when nothing moved, so `updated_at` stays honest and a nightly
          // pass over a settled catalog produces no WAL churn. Same guard
          // `recompute-branch-signals` uses.
          or(
            isNull(video.durationSeconds),
            ne(video.durationSeconds, row.median_duration_seconds),
          ),
        ),
      )
      .returning({ id: video.id });

    if (updated) updatedCount += 1;
  }

  logger.info("recompute-video-durations: complete", {
    asOf: payload.asOf,
    eligibleVideoCount: medians.rows.length,
    updatedVideoCount: updatedCount,
  });
}
