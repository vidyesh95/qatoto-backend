/**
 * Runs the §10A feasibility assessment by hand, over every country that has trade flows.
 *
 * WHY IT EXISTS: the job is scheduled for 03:50 UTC, and after a first ingest somebody
 * needs a ranking before tomorrow. `db:reconcile-project-stats` and
 * `db:expire-stale-project-requests` exist for the same reason — a scheduled job an
 * operator cannot trigger is a scheduled job that cannot be tested.
 *
 * It calls the job HANDLER directly, which is exactly what the worker would do, so this
 * exercises the real path rather than a copy of it.
 *
 * IDEMPOTENT. The insert is `ON CONFLICT DO NOTHING` on `(asOf, commodity, region)` and
 * `asOf` is quantized to the UTC day, so running it twice in one day is a no-op rather than
 * a duplicate ranking.
 *
 *   pnpm db:recompute-localization
 */
import "dotenv/config";
import { pool } from "#src/db/index.js";
import { stopSendOnlyBoss } from "#src/lib/jobs.js";
import { handleRecomputeLocalizationAssessments } from "#src/modules/rnd/import-intelligence/recompute-localization-assessments.js";

/** The window the nightly tick uses: the twelve months ending at `asOf`. */
const WINDOW_DAYS = 365;
const MILLISECONDS_PER_DAY = 86_400_000;

function truncateToUtcDayStart(instant: Date): Date {
  return new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()));
}

async function main(): Promise<void> {
  const asOf = truncateToUtcDayStart(new Date());
  const windowStartsAt = new Date(asOf.getTime() - WINDOW_DAYS * MILLISECONDS_PER_DAY);

  console.log(`Recomputing assessments as of ${asOf.toISOString()} …`);

  await handleRecomputeLocalizationAssessments({
    asOf: asOf.toISOString(),
    windowStartsAt: windowStartsAt.toISOString(),
    windowEndsAt: asOf.toISOString(),
    // Every country that has flows. The handler fans out.
    regionId: null,
  });

  const { rows } = await pool.query<{
    region: string;
    scored: number;
    narrated: number;
    top_score: number;
  }>(
    `SELECT g.label AS region,
            count(*)::int AS scored,
            count(*) FILTER (WHERE a.narrative_status <> 'pending')::int AS narrated,
            max(a.feasibility_score_points)::int AS top_score
     FROM localization_assessment a
     JOIN discovery_region g ON g.id = a.region_id
     WHERE a.as_of = $1
     GROUP BY g.label
     ORDER BY g.label`,
    [asOf],
  );

  for (const row of rows) {
    console.log(
      `  ${row.region}: ${row.scored} commodities scored, top score ${row.top_score}, ` +
        `${row.narrated} narrative(s) already written`,
    );
  }
  console.log(rows.length === 0 ? "\nNothing scored — is there any trade data?" : "\nDone.");
}

main()
  .then(async () => {
    // The handler enqueues narratives, which starts the send-only pg-boss instance. Without
    // this the process hangs after every row is written.
    await stopSendOnlyBoss();
    await pool.end();
    return undefined;
  })
  .catch(async (error: unknown) => {
    console.error("Assessment recompute failed to run:", error);
    await stopSendOnlyBoss().catch(() => undefined);
    await pool.end();
    process.exit(1);
  });
