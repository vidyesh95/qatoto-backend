/**
 * Reconciles the `project_stats` counter cache against the rows it caches.
 *
 * The four transactional counters are incremented inside the same transaction as the
 * write they describe, so they should never drift. "Should never" is exactly the claim
 * worth checking on a schedule: a bug, a manual SQL fix, or a crash between statements
 * would leave a number that renders as fact on a project card with nothing to catch it.
 *
 * `project_watcher` / `project_member` / `project_open_role` remain the SOURCE OF
 * TRUTH; project_stats is a rebuildable cache. That is why `--fix` is safe.
 *
 * THE DAILY-LOG COLUMNS ARE REPORTED BUT NEVER REPAIRED (§8). `lastDailyLogDate` is
 * derivable — it is `MAX(log_date)` over submitted logs — but `dailyLogStreakDays` is NOT:
 * the streak deliberately ignores back-dated logs, so recomputing it from the log table
 * would produce a DIFFERENT number than the fold that wrote it, and "repairing" a project
 * to that number would silently hand a member the 30-day streak that back-filling a month
 * is supposed to be unable to buy. Drift here means the submit transaction or the nightly
 * decay has a bug, and that is a thing to investigate rather than to overwrite.
 *
 * `verifiedEffortMinutesTotal` and `allocatedEquityBasisPoints` are untouched for the
 * older reason: they are NULL until §9 lands, and writing 0 would fabricate a number.
 *
 *   pnpm db:reconcile-project-stats           # report drift, change nothing
 *   pnpm db:reconcile-project-stats -- --fix  # repair from the source tables
 */
import "dotenv/config";
import { sql } from "drizzle-orm";

import { db, pool } from "#src/db/index.js";

interface DriftRow extends Record<string, unknown> {
  readonly project_id: string;
  readonly slug: string;
  readonly stored_watchers: number;
  readonly actual_watchers: number;
  readonly stored_members: number;
  readonly actual_members: number;
  readonly stored_open_roles: number;
  readonly actual_open_roles: number;
  readonly stored_pending_applications: number;
  readonly actual_pending_applications: number;
  readonly stored_last_log_date: string | null;
  readonly actual_last_log_date: string | null;
  readonly stored_streak_days: number | null;
}

async function main(): Promise<void> {
  const shouldFix = process.argv.includes("--fix");

  // One query, computed entirely in SQL: counting in TypeScript would mean loading
  // every watcher row for every project.
  const drift = await db.execute<DriftRow>(sql`
    SELECT
      p.id   AS project_id,
      p.slug AS slug,
      s.watchers_count             AS stored_watchers,
      (SELECT count(*) FROM project_watcher w WHERE w.project_id = p.id)::int
                                   AS actual_watchers,
      s.team_member_count          AS stored_members,
      (SELECT count(*) FROM project_member m
        WHERE m.project_id = p.id AND m.status = 'active')::int
                                   AS actual_members,
      s.open_role_count            AS stored_open_roles,
      (SELECT count(*) FROM project_open_role r
        WHERE r.project_id = p.id AND r.status = 'open')::int
                                   AS actual_open_roles,
      s.pending_application_count  AS stored_pending_applications,
      (SELECT count(*) FROM project_application a
        WHERE a.project_id = p.id AND a.status = 'pending')::int
                                   AS actual_pending_applications,
      s.last_daily_log_date        AS stored_last_log_date,
      (SELECT max(l.log_date) FROM daily_log l
        WHERE l.project_id = p.id AND l.status = 'submitted')
                                   AS actual_last_log_date,
      s.daily_log_streak_days      AS stored_streak_days
    FROM research_project p
    JOIN project_stats s ON s.project_id = p.id
    WHERE s.watchers_count            <> (SELECT count(*) FROM project_watcher w WHERE w.project_id = p.id)
       OR s.team_member_count         <> (SELECT count(*) FROM project_member m WHERE m.project_id = p.id AND m.status = 'active')
       OR s.open_role_count           <> (SELECT count(*) FROM project_open_role r WHERE r.project_id = p.id AND r.status = 'open')
       OR s.pending_application_count <> (SELECT count(*) FROM project_application a WHERE a.project_id = p.id AND a.status = 'pending')
       OR s.last_daily_log_date IS DISTINCT FROM
          (SELECT max(l.log_date) FROM daily_log l WHERE l.project_id = p.id AND l.status = 'submitted')
    ORDER BY p.slug
  `);

  if (drift.rows.length === 0) {
    console.log("No counter drift. project_stats matches its source tables.");
    return;
  }

  console.log(`Found drift on ${drift.rows.length} project(s):`);
  for (const row of drift.rows) {
    console.log(`  ${row.slug}`);
    if (row.stored_watchers !== row.actual_watchers) {
      console.log(`    watchersCount           ${row.stored_watchers} → ${row.actual_watchers}`);
    }
    if (row.stored_members !== row.actual_members) {
      console.log(`    teamMemberCount         ${row.stored_members} → ${row.actual_members}`);
    }
    if (row.stored_open_roles !== row.actual_open_roles) {
      console.log(
        `    openRoleCount           ${row.stored_open_roles} → ${row.actual_open_roles}`,
      );
    }
    if (row.stored_pending_applications !== row.actual_pending_applications) {
      console.log(
        `    pendingApplicationCount ${row.stored_pending_applications} → ${row.actual_pending_applications}`,
      );
    }
    if (row.stored_last_log_date !== row.actual_last_log_date) {
      // REPORTED, NOT REPAIRED — see the module comment. A mismatch here means the submit
      // transaction did not write both halves together, which is a bug in that path.
      console.log(
        `    lastDailyLogDate        ${row.stored_last_log_date ?? "null"} vs ${row.actual_last_log_date ?? "null"} (log table) — INVESTIGATE, not repaired`,
      );
      console.log(`    dailyLogStreakDays      ${row.stored_streak_days ?? "null"} (left alone)`);
    }
  }

  if (!shouldFix) {
    console.log("\nDry run. Re-run with `-- --fix` to repair.");
    return;
  }

  // The four transactional counters only. The daily-log columns are deliberately absent
  // from this UPDATE — see the module comment.
  await db.execute(sql`
    UPDATE project_stats s SET
      watchers_count            = (SELECT count(*) FROM project_watcher w WHERE w.project_id = s.project_id),
      team_member_count         = (SELECT count(*) FROM project_member m WHERE m.project_id = s.project_id AND m.status = 'active'),
      open_role_count           = (SELECT count(*) FROM project_open_role r WHERE r.project_id = s.project_id AND r.status = 'open'),
      pending_application_count = (SELECT count(*) FROM project_application a WHERE a.project_id = s.project_id AND a.status = 'pending')
  `);

  console.log(`\nRepaired ${drift.rows.length} project(s).`);
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error("Reconciling project stats failed:", error);
    await pool.end();
    process.exit(1);
  });
