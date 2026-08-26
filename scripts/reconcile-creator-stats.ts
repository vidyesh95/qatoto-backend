/**
 * Reconciles the `creator_stats` counter cache against the rows it caches.
 *
 * WHY THIS EXISTS, and it is not hypothetical. `published_video_count` was incremented on publish
 * and decremented on unpublish, and NOTHING decremented it when a published video was deleted. So
 * it drifted upward by one for every published video a creator ever deleted — permanently, because
 * no job reconciled it either. `deleteVideo` now decrements it; this repairs the rows that drifted
 * before it did.
 *
 * It went unnoticed because the column had no reader. `GET /users/me/creator-summary` is its first
 * consumer anywhere in the codebase — a counter nobody reads is a counter nobody sees breaking,
 * which is the argument for running this on a schedule rather than only after a bug.
 *
 * `video` and `creator_subscription` REMAIN THE SOURCE OF TRUTH; `creator_stats` is a rebuildable
 * cache. That is what makes `--fix` safe.
 *
 * `total_view_count` IS REPORTED BUT NEVER REPAIRED, and the reason is that it is not derivable.
 * It is a LIFETIME counter incremented per counted view, and deleting a video does not un-happen
 * the views it had. Summing `video_stats.view_count` over surviving videos would therefore
 * "repair" it to a smaller, different number — retroactively erasing views that really occurred.
 * A mismatch here means the beacon transaction has a bug, which is a thing to investigate rather
 * than to overwrite. Same call `reconcile-project-stats` makes about `dailyLogStreakDays`.
 *
 *   pnpm db:reconcile-creator-stats           # report drift, change nothing
 *   pnpm db:reconcile-creator-stats -- --fix  # repair the derivable counters
 */
import "dotenv/config";
import { sql } from "drizzle-orm";

import { db, pool } from "#src/db/index.js";

interface DriftRow extends Record<string, unknown> {
  readonly user_id: string;
  readonly email: string | null;
  readonly stored_published: number;
  readonly actual_published: number;
  readonly stored_subscribers: number;
  readonly actual_subscribers: number;
  /**
   * A STRING, NOT A NUMBER. `total_view_count` is `bigint`, and node-postgres returns bigint as a
   * string rather than silently losing precision past 2^53. Comparing it to a `::int` count with
   * `!==` is always true — which is exactly the false positive this comment exists to stop the
   * next reader re-introducing. Coerce before comparing.
   */
  readonly stored_total_views: string;
  readonly summed_video_views: number;
}

async function main(): Promise<void> {
  const shouldFix = process.argv.includes("--fix");

  // One query, counted entirely in SQL. Counting in TypeScript would mean loading every video and
  // every subscription row for every creator on the platform.
  const drift = await db.execute<DriftRow>(sql`
    SELECT
      s.user_id                     AS user_id,
      u.email                       AS email,
      s.published_video_count       AS stored_published,
      (SELECT count(*) FROM video v
        WHERE v.creator_id = s.user_id AND v.publish_status = 'published')::int
                                    AS actual_published,
      s.subscriber_count            AS stored_subscribers,
      (SELECT count(*) FROM creator_subscription c WHERE c.creator_id = s.user_id)::int
                                    AS actual_subscribers,
      s.total_view_count            AS stored_total_views,
      (SELECT COALESCE(sum(st.view_count), 0) FROM video v
        JOIN video_stats st ON st.video_id = v.id
        WHERE v.creator_id = s.user_id)::int
                                    AS summed_video_views
    FROM creator_stats s
    JOIN "user" u ON u.id = s.user_id
    WHERE s.published_video_count <> (SELECT count(*) FROM video v
            WHERE v.creator_id = s.user_id AND v.publish_status = 'published')
       OR s.subscriber_count <> (SELECT count(*) FROM creator_subscription c
            WHERE c.creator_id = s.user_id)
       OR s.total_view_count <> (SELECT COALESCE(sum(st.view_count), 0) FROM video v
            JOIN video_stats st ON st.video_id = v.id WHERE v.creator_id = s.user_id)
    ORDER BY u.email
  `);

  if (drift.rows.length === 0) {
    console.log("No counter drift. creator_stats matches its source tables.");
    return;
  }

  console.log(`Found drift on ${String(drift.rows.length)} creator(s):`);
  let repairableCount = 0;
  for (const row of drift.rows) {
    console.log(`  ${row.email ?? row.user_id}`);
    if (row.stored_published !== row.actual_published) {
      repairableCount += 1;
      console.log(
        `    publishedVideoCount  ${String(row.stored_published)} → ${String(row.actual_published)}`,
      );
    }
    if (row.stored_subscribers !== row.actual_subscribers) {
      repairableCount += 1;
      console.log(
        `    subscriberCount      ${String(row.stored_subscribers)} → ${String(row.actual_subscribers)}`,
      );
    }
    if (Number(row.stored_total_views) !== row.summed_video_views) {
      // REPORTED, NOT REPAIRED — see the module comment. A lifetime view count legitimately
      // exceeds the sum over surviving videos, because a deleted video's views still happened.
      console.log(
        `    totalViewCount       ${row.stored_total_views} vs ${String(row.summed_video_views)} summed over surviving videos — expected to differ after a delete; INVESTIGATE only if lower`,
      );
    }
  }

  if (!shouldFix) {
    console.log("\nDry run. Re-run with `-- --fix` to repair.");
    return;
  }

  // The two derivable counters only. `total_view_count` is deliberately absent from this UPDATE.
  await db.execute(sql`
    UPDATE creator_stats s SET
      published_video_count = (SELECT count(*) FROM video v
        WHERE v.creator_id = s.user_id AND v.publish_status = 'published'),
      subscriber_count      = (SELECT count(*) FROM creator_subscription c
        WHERE c.creator_id = s.user_id)
  `);

  console.log(`\nRepaired ${String(repairableCount)} counter(s).`);
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error("Reconciling creator stats failed:", error);
    await pool.end();
    process.exit(1);
  });
