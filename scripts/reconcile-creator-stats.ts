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
  /** Also a STRING — `::bigint`, for the same node-postgres reason as the field above. */
  readonly summed_video_views: string;
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
      -- ::bigint, NOT ::int. sum() over an integer column returns bigint, and a creator past
      -- 2.1 billion lifetime views would raise an integer-out-of-range error and take down the
      -- whole script, including the published_video_count repair that has nothing to do with views.
      (SELECT COALESCE(sum(st.view_count), 0) FROM video v
        JOIN video_stats st ON st.video_id = v.id
        WHERE v.creator_id = s.user_id)::bigint
                                    AS summed_video_views
    FROM creator_stats s
    JOIN "user" u ON u.id = s.user_id
    -- ONLY THE TWO DERIVABLE COUNTERS DECIDE WHAT IS "DRIFT". total_view_count is deliberately
    -- absent from this predicate: the module comment says it is EXPECTED to exceed the sum over
    -- surviving videos after any delete, so including it reported every creator who has ever
    -- deleted a video, on every run, forever — which is how a real mismatch gets lost in the noise.
    -- It is still SELECTed and still printed, as context on a row that drifted for another reason.
    WHERE s.published_video_count <> (SELECT count(*) FROM video v
            WHERE v.creator_id = s.user_id AND v.publish_status = 'published')
       OR s.subscriber_count <> (SELECT count(*) FROM creator_subscription c
            WHERE c.creator_id = s.user_id)
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
    if (Number(row.stored_total_views) !== Number(row.summed_video_views)) {
      // REPORTED, NOT REPAIRED — see the module comment. A lifetime view count legitimately
      // exceeds the sum over surviving videos, because a deleted video's views still happened.
      console.log(
        `    totalViewCount       ${row.stored_total_views} vs ${row.summed_video_views} summed over surviving videos — expected to differ after a delete; INVESTIGATE only if lower`,
      );
    }
  }

  if (!shouldFix) {
    console.log("\nDry run. Re-run with `-- --fix` to repair.");
    return;
  }

  // SCOPED TO THE DRIFTED ROWS, AND LOCKED FIRST. Both halves matter.
  //
  // An unscoped `UPDATE creator_stats SET x = (subquery)` rewrites every row from the statement's
  // snapshot, and that can INTRODUCE the drift this script exists to remove: a concurrent
  // `publishVideo` committing 5 -> 6 before the scan reaches that row is simply overwritten back
  // to 5, with no lock to wait on and no re-evaluation. Taking `FOR UPDATE` on the rows first
  // inverts it — the increment path's `UPDATE … SET x = x + 1` takes the same row lock, so it
  // blocks until this transaction commits and then applies on top of the corrected value.
  //
  // Scoping also means clean rows are not rewritten, which is the difference between one dead
  // tuple per drifted creator and one per creator on the platform.
  const repairedRowCount = await db.transaction(async (tx) => {
    const driftedUserIds = drift.rows.map((row) => row.user_id);
    await tx.execute(sql`
      SELECT 1 FROM creator_stats
      WHERE user_id IN (${sql.join(
        driftedUserIds.map((id) => sql`${id}`),
        sql`, `,
      )})
      FOR UPDATE
    `);
    await tx.execute(sql`
      UPDATE creator_stats s SET
        published_video_count = (SELECT count(*) FROM video v
          WHERE v.creator_id = s.user_id AND v.publish_status = 'published'),
        subscriber_count      = (SELECT count(*) FROM creator_subscription c
          WHERE c.creator_id = s.user_id)
      WHERE s.user_id IN (${sql.join(
        driftedUserIds.map((id) => sql`${id}`),
        sql`, `,
      )})
    `);
    return driftedUserIds.length;
  });

  // Rows, not columns — the previous count summed per-column mismatches and printed them as a
  // number of rows, which bore no relation to what the UPDATE touched.
  console.log(
    `\nRepaired ${String(repairedRowCount)} creator row(s); ${String(repairableCount)} counter(s) were wrong.`,
  );
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
