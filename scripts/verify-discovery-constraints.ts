/**
 * Verifies that migration 0011's DATABASE-LEVEL guarantees are actually in force
 * (R_AND_D_BACKEND_STRUCTURE.md §17).
 *
 * WHY THIS IS A SCRIPT AND NOT A TEST. The vitest suite mocks `#src/db/index.js`
 * wholesale (there is no test database), so it can prove things about TypeScript and
 * nothing about Postgres. But the strongest correctness claims in §6 are enforced BY
 * POSTGRES, not by the service layer: the append-only triggers, the components-sum CHECK,
 * and the unordered-pair merge index. Service-layer discipline is not enforcement — §4f
 * says so explicitly — and an untested trigger is indistinguishable from an absent one.
 *
 * Read-only in effect: it writes temporary rows with a reserved id prefix and removes
 * them, and every write is inside a transaction that is rolled back.
 *
 *   pnpm db:verify-discovery-constraints
 *
 * Exits non-zero if any guarantee is missing, so it can gate a deploy.
 */
import "dotenv/config";
import { pool } from "#src/db/index.js";

interface CheckOutcome {
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

const EXPECTED_TABLES = [
  "discovery_region",
  "discovery_skill",
  "geocode_cache",
  "problem_submission",
  "problem_cluster",
  "problem_cluster_score_snapshot",
  "problem_cluster_merge_proposal",
  "problem_cluster_project_link",
  "market_insight",
  "market_insight_project_link",
  "demand_signal_snapshot",
  "talent_profile",
  "talent_profile_skill",
  "talent_compensation_ask",
  "job_failure",
] as const;

const EXPECTED_TRIGGERS = [
  "problem_cluster_score_snapshot_append_only",
  "problem_cluster_score_snapshot_no_truncate",
  "demand_signal_snapshot_append_only",
  "demand_signal_snapshot_no_truncate",
] as const;

/** Postgres raises this SQLSTATE from qatoto_reject_mutation() (migration 0010). */
const APPEND_ONLY_SQLSTATE = "QT001";
const CHECK_VIOLATION_SQLSTATE = "23514";

function sqlStateOf(error: unknown): string | undefined {
  let candidate: unknown = error;
  for (let depth = 0; depth < 5 && candidate; depth += 1) {
    const code = (candidate as { code?: unknown }).code;
    if (typeof code === "string") return code;
    candidate = (candidate as { cause?: unknown }).cause;
  }
  return undefined;
}

async function countQuery(text: string, values: readonly unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(text, [...values]);
  return Number(rows[0]?.n ?? 0);
}

async function checkSchemaObjects(): Promise<readonly CheckOutcome[]> {
  const tableCount = await countQuery(
    `SELECT count(*) AS n FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [EXPECTED_TABLES],
  );
  const triggerCount = await countQuery(
    `SELECT count(*) AS n FROM pg_trigger WHERE NOT tgisinternal AND tgname = ANY($1)`,
    [EXPECTED_TRIGGERS],
  );
  const pairIndexCount = await countQuery(
    `SELECT count(*) AS n FROM pg_indexes
      WHERE indexname = 'problem_cluster_merge_proposal_open_pair_unq'`,
  );
  const originIndexCount = await countQuery(
    `SELECT count(*) AS n FROM pg_indexes
      WHERE indexname = 'problem_cluster_project_link_origin_unq'`,
  );
  const regionCount = await countQuery(`SELECT count(*) AS n FROM discovery_region`);
  const skillCount = await countQuery(`SELECT count(*) AS n FROM discovery_skill`);
  const backfilledPinCount = await countQuery(
    `SELECT count(*) AS n FROM research_category WHERE pin_icon_key <> 'other'`,
  );

  return [
    {
      label: "all 15 discovery tables exist",
      passed: tableCount === EXPECTED_TABLES.length,
      detail: `${tableCount}/${EXPECTED_TABLES.length}`,
    },
    {
      label: "append-only triggers attached",
      passed: triggerCount === EXPECTED_TRIGGERS.length,
      detail: `${triggerCount}/${EXPECTED_TRIGGERS.length}`,
    },
    {
      label: "unordered-pair merge index exists",
      passed: pairIndexCount === 1,
      detail: `${pairIndexCount}`,
    },
    {
      label: "one-origin-per-project index exists",
      passed: originIndexCount === 1,
      detail: `${originIndexCount}`,
    },
    { label: "regions seeded", passed: regionCount > 0, detail: `${regionCount} rows` },
    { label: "skills seeded", passed: skillCount > 0, detail: `${skillCount} rows` },
    {
      label: "pin_icon_key backfilled on seeded categories",
      passed: backfilledPinCount === 8,
      detail: `${backfilledPinCount}/8`,
    },
  ];
}

/**
 * Exercises the runtime guarantees against real rows, inside a transaction that is always
 * rolled back. A guarantee nobody has seen fire is a guarantee nobody should trust.
 */
async function checkRuntimeGuarantees(): Promise<readonly CheckOutcome[]> {
  const client = await pool.connect();
  const outcomes: CheckOutcome[] = [];

  try {
    await client.query("BEGIN");

    const [seedCategory] = (
      await client.query<{ id: string }>(`SELECT id FROM research_category LIMIT 1`)
    ).rows;
    if (!seedCategory) {
      throw new Error("No research_category rows — run `pnpm db:seed-research-categories` first.");
    }

    // submission_count and distinct_reporter_count must be set explicitly: their column
    // defaults are 0, and problem_cluster_counts_ck requires
    // submission_count >= centroid_sample_count. A cluster whose centroid averages one
    // point but claims zero submissions is exactly the inconsistency that CHECK exists to
    // catch, so the fixture has to be internally consistent to get past it.
    await client.query(
      `INSERT INTO problem_cluster
         (id, title, description, category_id,
          centroid_latitude_microdegrees, centroid_longitude_microdegrees,
          centroid_latitude_sum_microdegrees, centroid_longitude_sum_microdegrees,
          centroid_sample_count, distinct_reporter_count, submission_count,
          first_reported_at, last_reported_at)
       VALUES ('verify-cluster', 'verify', 'verify', $1,
               1000000, 1000000, 1000000, 1000000, 1, 1, 1, now(), now())`,
      [seedCategory.id],
    );

    await client.query(
      `INSERT INTO problem_cluster_score_snapshot
         (id, cluster_id, as_of, window_starts_at, window_ends_at, opportunity_score_points,
          distinct_reporter_count, submission_count, distinct_region_count,
          category_share_basis_points, age_in_days, linked_project_count,
          reporter_component_points, spread_component_points, demand_component_points,
          recency_component_points, scarcity_component_points)
       VALUES ('verify-snapshot', 'verify-cluster', now(), now() - interval '1 day', now(),
               10, 1, 1, 1, 100, 0, 0, 2, 2, 3, 3, 0)`,
    );

    // 1. An UPDATE on an append-only table must raise QT001.
    await client.query("SAVEPOINT before_update");
    try {
      await client.query(
        `UPDATE problem_cluster_score_snapshot SET opportunity_score_points = 99
          WHERE id = 'verify-snapshot'`,
      );
      outcomes.push({
        label: "append-only UPDATE rejected",
        passed: false,
        detail: "the UPDATE SUCCEEDED — history is editable",
      });
    } catch (error) {
      const sqlState = sqlStateOf(error);
      outcomes.push({
        label: "append-only UPDATE rejected",
        passed: sqlState === APPEND_ONLY_SQLSTATE,
        detail: `SQLSTATE ${sqlState ?? "unknown"}`,
      });
    }
    await client.query("ROLLBACK TO SAVEPOINT before_update");

    // 2. A DELETE on an append-only table must raise QT001.
    await client.query("SAVEPOINT before_delete");
    try {
      await client.query(`DELETE FROM problem_cluster_score_snapshot WHERE id = 'verify-snapshot'`);
      outcomes.push({
        label: "append-only DELETE rejected",
        passed: false,
        detail: "the DELETE SUCCEEDED — history is erasable",
      });
    } catch (error) {
      const sqlState = sqlStateOf(error);
      outcomes.push({
        label: "append-only DELETE rejected",
        passed: sqlState === APPEND_ONLY_SQLSTATE,
        detail: `SQLSTATE ${sqlState ?? "unknown"}`,
      });
    }
    await client.query("ROLLBACK TO SAVEPOINT before_delete");

    // 3. Components that do not sum to the score must be rejected. This is the invariant
    //    that makes the stored subscores load-bearing rather than decorative.
    await client.query("SAVEPOINT before_bad_components");
    try {
      await client.query(
        `INSERT INTO problem_cluster_score_snapshot
           (id, cluster_id, as_of, window_starts_at, window_ends_at, opportunity_score_points,
            distinct_reporter_count, submission_count, distinct_region_count,
            category_share_basis_points, age_in_days, linked_project_count,
            reporter_component_points, spread_component_points, demand_component_points,
            recency_component_points, scarcity_component_points)
         VALUES ('verify-bad', 'verify-cluster', now() + interval '1 day', now(),
                 now() + interval '1 day', 50, 1, 1, 1, 100, 0, 0, 2, 2, 3, 3, 0)`,
      );
      outcomes.push({
        label: "components-sum CHECK rejects a mismatched score",
        passed: false,
        detail: "the INSERT SUCCEEDED — subscores need not equal the score",
      });
    } catch (error) {
      const sqlState = sqlStateOf(error);
      outcomes.push({
        label: "components-sum CHECK rejects a mismatched score",
        passed: sqlState === CHECK_VIOLATION_SQLSTATE,
        detail: `SQLSTATE ${sqlState ?? "unknown"}`,
      });
    }
    await client.query("ROLLBACK TO SAVEPOINT before_bad_components");

    // 4. A cluster cannot be merged into itself.
    await client.query("SAVEPOINT before_self_merge");
    try {
      await client.query(
        `INSERT INTO problem_cluster_merge_proposal
           (id, source_cluster_id, target_cluster_id, similarity_basis_points,
            centroid_distance_metres, as_of)
         VALUES ('verify-self-merge', 'verify-cluster', 'verify-cluster', 9000, 10, now())`,
      );
      outcomes.push({
        label: "self-merge proposal rejected",
        passed: false,
        detail: "the INSERT SUCCEEDED",
      });
    } catch (error) {
      const sqlState = sqlStateOf(error);
      outcomes.push({
        label: "self-merge proposal rejected",
        passed: sqlState === CHECK_VIOLATION_SQLSTATE,
        detail: `SQLSTATE ${sqlState ?? "unknown"}`,
      });
    }
    await client.query("ROLLBACK TO SAVEPOINT before_self_merge");

    // 5. A score outside 0..100 must be rejected.
    await client.query("SAVEPOINT before_bad_score");
    try {
      await client.query(
        `INSERT INTO problem_cluster_score_snapshot
           (id, cluster_id, as_of, window_starts_at, window_ends_at, opportunity_score_points,
            distinct_reporter_count, submission_count, distinct_region_count,
            category_share_basis_points, age_in_days, linked_project_count,
            reporter_component_points, spread_component_points, demand_component_points,
            recency_component_points, scarcity_component_points)
         VALUES ('verify-oob', 'verify-cluster', now() + interval '2 day', now(),
                 now() + interval '2 day', 101, 1, 1, 1, 100, 0, 0, 101, 0, 0, 0, 0)`,
      );
      outcomes.push({
        label: "out-of-range score rejected",
        passed: false,
        detail: "the INSERT SUCCEEDED",
      });
    } catch (error) {
      const sqlState = sqlStateOf(error);
      outcomes.push({
        label: "out-of-range score rejected",
        passed: sqlState === CHECK_VIOLATION_SQLSTATE,
        detail: `SQLSTATE ${sqlState ?? "unknown"}`,
      });
    }
    await client.query("ROLLBACK TO SAVEPOINT before_bad_score");

    return outcomes;
  } finally {
    // Always. Nothing this script writes is ever committed.
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

async function main(): Promise<void> {
  const outcomes = [...(await checkSchemaObjects()), ...(await checkRuntimeGuarantees())];

  for (const outcome of outcomes) {
    console.log(`${outcome.passed ? "PASS" : "FAIL"}  ${outcome.label} — ${outcome.detail}`);
  }

  const failureCount = outcomes.filter((outcome) => !outcome.passed).length;
  console.log(
    failureCount === 0
      ? `\nAll ${outcomes.length} discovery guarantees verified.`
      : `\n${failureCount} of ${outcomes.length} guarantees FAILED.`,
  );

  if (failureCount > 0) {
    process.exitCode = 1;
  }
}

main()
  .then(async () => {
    await pool.end();
    // Deliberately NOT process.exit(0): main() sets process.exitCode = 1 when a
    // guarantee failed, and exiting explicitly here would discard that and report
    // success to a CI gate that is meant to block on it.
    return undefined;
  })
  .catch(async (error: unknown) => {
    console.error("Discovery constraint verification failed to run:", error);
    await pool.end();
    process.exit(1);
  });
