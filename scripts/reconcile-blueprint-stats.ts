/**
 * Reconciles the three blueprint counter caches against the rows they cache.
 *
 * Every counter on this surface is incremented inside the same transaction as the write it
 * describes, so it should never drift. "Should never" is exactly the claim worth checking on a
 * schedule — and on this surface there is a SECOND, ROUTINE source of drift that the video path
 * has too and nobody wrote down: an account erasure.
 *
 * ⚠️ ERASURE DRIFTS THESE COUNTERS BY DESIGN. `anonymization-manifest.ts` disposes of a departing
 * account's likes, upvotes and saves with `delete_rows`, which is raw SQL with no counter update.
 * Removing somebody's likes therefore leaves `like_count` high on every row they touched. This
 * script is the designated repair, and the manifest names it — the same relationship
 * `reconcile-creator-stats.ts` documents for `published_video_count`.
 *
 *   pnpm db:reconcile-blueprint-stats           # report drift, change nothing
 *   pnpm db:reconcile-blueprint-stats -- --fix  # repair from the source tables
 *
 * ⚠️ SCOPED TO `author_user_id IS NOT NULL`, AND THE SCOPE IS THE WHOLE REASON THIS FILE NEEDS A
 * DOCBLOCK. Two populations share the teardown and case-study tables, and
 * `anonymization-manifest.ts` already names the discriminator: "the twelve seeded rows name no
 * account and survive; an authored row names one and dies whole with it." Those seeded rows carry
 * INVENTED figures the fixtures state — one seeded teardown reads 48,210 views and 3,104 likes —
 * with no source rows behind them at all. An unscoped `--fix` would "repair" every one of those to
 * zero and destroy the seed's fiction in a single run.
 *
 * The showcase arm is reconciled UNCONDITIONALLY: `showcase_launch.author_user_id` is NOT NULL, so
 * that arm has no seeded population, and it mints no stats row on publish either.
 *
 * ⚠️ `view_count` IS REPORTED BUT NEVER REPAIRED, and it is excluded from the drift predicate.
 * That is the call `reconcile-creator-stats.ts` makes about `total_view_count`, for the same
 * reason: `prune-engagement-data` deletes view sessions at 90 days, so re-deriving a count from the
 * surviving rows would retroactively erase views that really happened. Including it in the
 * predicate would also report every row on every run forever, which is how a real mismatch gets
 * lost in the noise. It is still SELECTed and printed as context.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";

import { db, pool } from "#src/db/index.js";

interface ShowcaseDriftRow extends Record<string, unknown> {
  readonly launch_id: string;
  readonly public_slug: string | null;
  readonly stored_likes: number;
  readonly actual_likes: number;
  readonly stored_upvotes: number;
  readonly actual_upvotes: number;
  readonly stored_comments: number;
  readonly actual_comments: number;
  readonly stored_views: number;
  readonly actual_view_sessions: number;
}

interface TeardownDriftRow extends Record<string, unknown> {
  readonly teardown_id: string;
  readonly slug: string;
  readonly stored_likes: number;
  readonly actual_likes: number;
  readonly stored_saves: number;
  readonly actual_saves: number;
  readonly stored_comments: number;
  readonly actual_comments: number;
  readonly stored_views: number;
  readonly actual_view_sessions: number;
}

interface CaseStudyDriftRow extends Record<string, unknown> {
  readonly case_study_id: string;
  readonly public_slug: string | null;
  readonly stored_likes: number;
  readonly actual_likes: number;
  readonly stored_views: number;
  readonly actual_view_sessions: number;
}

function reportCounter(label: string, stored: number, actual: number): boolean {
  if (stored === actual) return false;
  console.log(`    ${label.padEnd(14)} ${String(stored)} → ${String(actual)}`);
  return true;
}

async function main(): Promise<void> {
  const shouldFix = process.argv.includes("--fix");
  let driftingRowCount = 0;

  /*
   * ⚠️ `comment_count` COUNTS WHAT IS RENDERED AS A COMMENT, so every count below filters
   * `is_deleted = false`. A tombstone survives so its replies keep their anchor, but it is not a
   * comment any reader sees — and the delete path decrements for exactly that reason.
   */

  console.log("--- showcase launches (every row; this arm has no seeded population) ---");
  const showcaseDrift = await db.execute<ShowcaseDriftRow>(sql`
    SELECT
      l.id AS launch_id,
      l.public_slug,
      s.like_count    AS stored_likes,
      (SELECT count(*) FROM showcase_launch_like    x WHERE x.launch_id = l.id)::int AS actual_likes,
      s.upvote_count  AS stored_upvotes,
      (SELECT count(*) FROM showcase_launch_upvote  x WHERE x.launch_id = l.id)::int AS actual_upvotes,
      s.comment_count AS stored_comments,
      (SELECT count(*) FROM showcase_launch_comment x
         WHERE x.launch_id = l.id AND x.is_deleted = false)::int AS actual_comments,
      s.view_count    AS stored_views,
      (SELECT count(*) FROM showcase_launch_view_session x WHERE x.launch_id = l.id)::int
                      AS actual_view_sessions
    FROM showcase_launch l
    JOIN showcase_launch_stats s ON s.launch_id = l.id
    WHERE s.like_count    <> (SELECT count(*) FROM showcase_launch_like    x WHERE x.launch_id = l.id)
       OR s.upvote_count  <> (SELECT count(*) FROM showcase_launch_upvote  x WHERE x.launch_id = l.id)
       OR s.comment_count <> (SELECT count(*) FROM showcase_launch_comment x
                                WHERE x.launch_id = l.id AND x.is_deleted = false)
    ORDER BY l.public_slug NULLS LAST
  `);
  driftingRowCount += showcaseDrift.rows.length;
  for (const row of showcaseDrift.rows) {
    console.log(`  ${row.public_slug ?? row.launch_id}`);
    reportCounter("likeCount", row.stored_likes, row.actual_likes);
    reportCounter("upvoteCount", row.stored_upvotes, row.actual_upvotes);
    reportCounter("commentCount", row.stored_comments, row.actual_comments);
    console.log(
      `    viewCount      ${String(row.stored_views)} (sessions on file: ${String(row.actual_view_sessions)}) — context only, never repaired`,
    );
  }
  if (showcaseDrift.rows.length === 0) console.log("  no drift");

  console.log("\n--- teardowns (authored rows only; the seeded twelve carry invented figures) ---");
  const teardownDrift = await db.execute<TeardownDriftRow>(sql`
    SELECT
      t.id AS teardown_id,
      t.slug,
      s.like_count    AS stored_likes,
      (SELECT count(*) FROM teardown_like x WHERE x.teardown_id = t.id)::int AS actual_likes,
      s.save_count    AS stored_saves,
      (SELECT count(*) FROM teardown_save x WHERE x.teardown_id = t.id)::int AS actual_saves,
      s.comment_count AS stored_comments,
      (SELECT count(*) FROM teardown_comment x
         WHERE x.teardown_id = t.id AND x.is_deleted = false)::int AS actual_comments,
      s.view_count    AS stored_views,
      (SELECT count(*) FROM teardown_view_session x WHERE x.teardown_id = t.id)::int
                      AS actual_view_sessions
    FROM teardown t
    JOIN teardown_stats s ON s.teardown_id = t.id
    WHERE t.author_user_id IS NOT NULL
      AND (s.like_count    <> (SELECT count(*) FROM teardown_like x WHERE x.teardown_id = t.id)
        OR s.save_count    <> (SELECT count(*) FROM teardown_save x WHERE x.teardown_id = t.id)
        OR s.comment_count <> (SELECT count(*) FROM teardown_comment x
                                 WHERE x.teardown_id = t.id AND x.is_deleted = false))
    ORDER BY t.slug
  `);
  driftingRowCount += teardownDrift.rows.length;
  for (const row of teardownDrift.rows) {
    console.log(`  ${row.slug}`);
    reportCounter("likeCount", row.stored_likes, row.actual_likes);
    reportCounter("saveCount", row.stored_saves, row.actual_saves);
    reportCounter("commentCount", row.stored_comments, row.actual_comments);
    console.log(
      `    viewCount      ${String(row.stored_views)} (sessions on file: ${String(row.actual_view_sessions)}) — context only, never repaired`,
    );
  }
  if (teardownDrift.rows.length === 0) console.log("  no drift");

  console.log("\n--- case studies (authored rows only; the seeded ten carry invented figures) ---");
  const caseStudyDrift = await db.execute<CaseStudyDriftRow>(sql`
    SELECT
      c.id AS case_study_id,
      c.public_slug,
      s.like_count AS stored_likes,
      (SELECT count(*) FROM case_study_like x WHERE x.case_study_id = c.id)::int AS actual_likes,
      s.view_count AS stored_views,
      (SELECT count(*) FROM case_study_view_session x WHERE x.case_study_id = c.id)::int
                   AS actual_view_sessions
    FROM case_study c
    JOIN case_study_stats s ON s.case_study_id = c.id
    WHERE c.author_user_id IS NOT NULL
      AND s.like_count <> (SELECT count(*) FROM case_study_like x WHERE x.case_study_id = c.id)
    ORDER BY c.public_slug NULLS LAST
  `);
  driftingRowCount += caseStudyDrift.rows.length;
  for (const row of caseStudyDrift.rows) {
    console.log(`  ${row.public_slug ?? row.case_study_id}`);
    reportCounter("likeCount", row.stored_likes, row.actual_likes);
    console.log(
      `    viewCount      ${String(row.stored_views)} (sessions on file: ${String(row.actual_view_sessions)}) — context only, never repaired`,
    );
  }
  if (caseStudyDrift.rows.length === 0) console.log("  no drift");

  if (driftingRowCount === 0) {
    console.log("\nNo counter drift. Every blueprint sidecar matches its source tables.");
    return;
  }

  if (!shouldFix) {
    console.log(
      `\nFound drift on ${String(driftingRowCount)} row(s). Re-run with \`-- --fix\` to repair.`,
    );
    return;
  }

  // ⚠️ `view_count` IS ABSENT FROM ALL THREE UPDATES, deliberately. See the module comment.
  await db.execute(sql`
    UPDATE showcase_launch_stats s SET
      like_count    = (SELECT count(*) FROM showcase_launch_like    x WHERE x.launch_id = s.launch_id),
      upvote_count  = (SELECT count(*) FROM showcase_launch_upvote  x WHERE x.launch_id = s.launch_id),
      comment_count = (SELECT count(*) FROM showcase_launch_comment x
                         WHERE x.launch_id = s.launch_id AND x.is_deleted = false),
      updated_at    = now()
  `);
  await db.execute(sql`
    UPDATE teardown_stats s SET
      like_count    = (SELECT count(*) FROM teardown_like x WHERE x.teardown_id = s.teardown_id),
      save_count    = (SELECT count(*) FROM teardown_save x WHERE x.teardown_id = s.teardown_id),
      comment_count = (SELECT count(*) FROM teardown_comment x
                         WHERE x.teardown_id = s.teardown_id AND x.is_deleted = false),
      updated_at    = now()
    FROM teardown t
    WHERE t.id = s.teardown_id AND t.author_user_id IS NOT NULL
  `);
  await db.execute(sql`
    UPDATE case_study_stats s SET
      like_count = (SELECT count(*) FROM case_study_like x WHERE x.case_study_id = s.case_study_id),
      updated_at = now()
    FROM case_study c
    WHERE c.id = s.case_study_id AND c.author_user_id IS NOT NULL
  `);

  console.log(
    `\nRepaired ${String(driftingRowCount)} row(s). view_count was left alone on every one.`,
  );
}

main()
  .then(async () => {
    await pool.end();
    return undefined;
  })
  .catch(async (error: unknown) => {
    console.error("Blueprint stats reconciliation failed:", error);
    await pool.end();
    process.exit(1);
  });
