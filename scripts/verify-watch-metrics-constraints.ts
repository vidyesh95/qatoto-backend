/**
 * Verifies that §3.3a's three rollup tables landed in the DATABASE with the bounds the schema file
 * claims, not merely in the schema file.
 *
 * WHY A SCRIPT AND NOT A TEST — the same reason every other `verify-*-constraints.ts` gives: the
 * vitest suite mocks `#src/db/index.js` wholesale, so it can prove things about TypeScript and
 * nothing about Postgres. A CHECK constraint that exists in `home.ts` and not in the applied
 * migration is invisible to every test in the repo and to `tsc`, and the first thing it lets
 * through is an `activity_hour` of 25.
 *
 * WHAT IS ACTUALLY AT STAKE HERE. These are counters on the hottest write path on the platform,
 * accumulated by `ON CONFLICT DO UPDATE`, and the three upserts fail in two different ways:
 *
 *   * MISSING ENTIRELY IS THE LOUD CASE. The beacon infers its conflict target from the column
 *     list, so no primary key over exactly those columns means 42P10 and a 500 on every signed-in
 *     beacon; the rollup names its constraints literally, so a key created under Postgres's
 *     generated `_pkey` name means 42704. Both stop the world, which is the good outcome.
 *   * PRESENT BUT WRONGLY SCOPED IS THE SILENT ONE. A unique index over the wrong columns still
 *     resolves the target, and the upsert then INSERTS a second row instead of adding to the
 *     first. Watch time multiplies by beacon count rather than summing. Nothing errors. The
 *     number just becomes fiction, in the direction that looks like success.
 *
 * That second case is why checking that the names EXIST is not enough, and why the accumulation
 * probe at the end writes real rows and reads the total back.
 *
 * Read-only in effect: every write happens inside a transaction that is always rolled back.
 *
 *   pnpm db:verify-watch-metrics-constraints
 *
 * Exits non-zero if any guarantee is missing, so it can gate a deploy.
 */
import "dotenv/config";
import type { PoolClient } from "pg";

import { pool } from "#src/db/index.js";

interface CheckOutcome {
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

const CHECK_VIOLATION_SQLSTATE = "23514";
const NOT_NULL_VIOLATION_SQLSTATE = "23502";

const EXPECTED_TABLES = [
  "user_activity_hour",
  "user_watch_daily",
  "platform_activity_hour_daily",
] as const;

const EXPECTED_PRIMARY_KEYS = [
  "user_activity_hour_pk",
  "user_watch_daily_pk",
  "platform_activity_hour_daily_pk",
] as const;

const EXPECTED_CHECKS = [
  "user_activity_hour_bounds_ck",
  "user_watch_daily_bounds_ck",
  "platform_activity_hour_daily_bounds_ck",
] as const;

/**
 * The read paths' indexes. Checked because an index is exactly the kind of object that can be
 * dropped from a migration without any test going red — nothing is incorrect without it, the
 * queries just start sequentially scanning a table that grows by one row per active user per
 * hour. `verify-discovery-constraints.ts` checks its two the same way.
 *
 * `platform_activity_hour_daily` is absent on purpose: it has no index beyond its primary key,
 * which the check above already covers.
 */
/**
 * What each primary key must span, as Postgres itself renders it. Kept beside the names rather
 * than derived, so the expectation is stated independently of the catalog it is checked against.
 */
const EXPECTED_PRIMARY_KEY_DEFINITIONS: readonly (readonly [string, string])[] = [
  ["user_activity_hour_pk", "PRIMARY KEY (user_id, activity_date, activity_hour)"],
  ["user_watch_daily_pk", "PRIMARY KEY (user_id, watch_date)"],
  ["platform_activity_hour_daily_pk", "PRIMARY KEY (activity_date, activity_hour)"],
] as const;

const EXPECTED_INDEXES = [
  "user_activity_hour_date_idx",
  "user_watch_daily_recent_idx",
  "user_watch_daily_date_idx",
] as const;

async function countQuery(text: string, values: readonly unknown[] = []): Promise<number> {
  const result = await pool.query<{ n: string }>(text, [...values]);
  return Number(result.rows[0]?.n ?? 0);
}

async function checkSchemaObjects(): Promise<readonly CheckOutcome[]> {
  const outcomes: CheckOutcome[] = [];

  const tableCount = await countQuery(
    `SELECT count(*) AS n FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [[...EXPECTED_TABLES]],
  );
  outcomes.push({
    label: "all three watch-metrics tables exist",
    passed: tableCount === EXPECTED_TABLES.length,
    detail: `${String(tableCount)}/${String(EXPECTED_TABLES.length)}`,
  });

  // NAMED primary keys, checked by name. A composite PK that exists under a generated name would
  // still enforce uniqueness, but `ON CONFLICT ON CONSTRAINT <name>` in the rollup job names these
  // explicitly and would fail at runtime rather than at deploy.
  const primaryKeyCount = await countQuery(
    `SELECT count(*) AS n FROM pg_constraint
      WHERE contype = 'p' AND conname = ANY($1)`,
    [[...EXPECTED_PRIMARY_KEYS]],
  );
  outcomes.push({
    label: "all three composite primary keys exist under their declared names",
    passed: primaryKeyCount === EXPECTED_PRIMARY_KEYS.length,
    detail: `${String(primaryKeyCount)}/${String(EXPECTED_PRIMARY_KEYS.length)}`,
  });

  const checkCount = await countQuery(
    `SELECT count(*) AS n FROM pg_constraint WHERE contype = 'c' AND conname = ANY($1)`,
    [[...EXPECTED_CHECKS]],
  );
  outcomes.push({
    label: "all three bounds CHECK constraints exist",
    passed: checkCount === EXPECTED_CHECKS.length,
    detail: `${String(checkCount)}/${String(EXPECTED_CHECKS.length)}`,
  });

  // The hour column must be an integer, not a smallint that a future 0..23 assumption outgrows,
  // and not text. `generate_series(0, 23)` joins against it in the histogram read.
  const hourColumnCount = await countQuery(
    `SELECT count(*) AS n FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY($1)
        AND column_name = 'activity_hour'
        AND data_type = 'integer'`,
    [["user_activity_hour", "platform_activity_hour_daily"]],
  );
  outcomes.push({
    label: "activity_hour is an integer on both hour tables",
    passed: hourColumnCount === 2,
    detail: `${String(hourColumnCount)}/2`,
  });

  /**
   * THE COLUMN LISTS, not just the names. A primary key called `user_activity_hour_pk` that
   * spans (user_id, activity_date) alone would satisfy every check above and still be the silent
   * failure this script exists to catch — the beacon's inferred target would stop resolving to
   * it, or worse, resolve to something narrower and let a second row in. `pg_get_constraintdef`
   * is compared verbatim so a reordering shows up too: the order decides which prefix scans the
   * index can serve, even where it does not change what the key enforces.
   */
  const primaryKeyDefinitions = await pool.query<{ conname: string; definition: string }>(
    `SELECT conname, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE contype = 'p' AND conname = ANY($1)`,
    [[...EXPECTED_PRIMARY_KEYS]],
  );
  const definitionByName = new Map(
    primaryKeyDefinitions.rows.map((row) => [row.conname, row.definition]),
  );
  const mismatchedKeys = EXPECTED_PRIMARY_KEY_DEFINITIONS.filter(
    ([name, expected]) => definitionByName.get(name) !== expected,
  );
  outcomes.push({
    label: "each primary key spans exactly the declared columns, in order",
    passed: mismatchedKeys.length === 0,
    detail:
      mismatchedKeys.length === 0
        ? "all three match"
        : mismatchedKeys
            .map(
              ([name, expected]) =>
                `${name}: ${definitionByName.get(name) ?? "ABSENT"} (expected ${expected})`,
            )
            .join("; "),
  });

  const indexCount = await countQuery(
    `SELECT count(*) AS n FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1)`,
    [[...EXPECTED_INDEXES]],
  );
  outcomes.push({
    label: "all three read-path indexes exist",
    passed: indexCount === EXPECTED_INDEXES.length,
    detail: `${String(indexCount)}/${String(EXPECTED_INDEXES.length)}`,
  });

  return outcomes;
}

function sqlStateOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error;
    return typeof code === "string" ? code : "unknown";
  }
  return "unknown";
}

/**
 * Runs one write that MUST be refused, and reports which SQLSTATE refused it.
 *
 * THE SAVEPOINT IS NOT OPTIONAL, and leaving it out is why this script could not pass. Every
 * probe below is a deliberate constraint violation, and a violation puts the enclosing
 * transaction into the aborted state: from that point Postgres answers EVERY further statement
 * with 25P02 (`current transaction is aborted`). Without a savepoint the first probe therefore
 * makes the remaining probes report 25P02 instead of the code they were testing for, and makes
 * the accumulation check below — the one that actually matters — throw rather than run. The
 * script would fail against a perfectly correct database.
 *
 * `verify-discovery-constraints.ts` brackets each of its hostile writes the same way. This does
 * it INSIDE the helper rather than at the call sites so that a probe added later cannot forget.
 * The savepoint name is reused deliberately: each probe rolls back to it before the next issues
 * a fresh one, so only one is ever live.
 */
async function expectRejection(
  client: PoolClient,
  outcomes: CheckOutcome[],
  label: string,
  expectedSqlState: string,
  attempt: () => Promise<unknown>,
): Promise<void> {
  await client.query("SAVEPOINT rejection_probe");
  try {
    await attempt();
    outcomes.push({ label, passed: false, detail: "the write was ACCEPTED" });
  } catch (error: unknown) {
    const sqlState = sqlStateOf(error);
    outcomes.push({
      label,
      passed: sqlState === expectedSqlState,
      detail: `SQLSTATE ${sqlState} (expected ${expectedSqlState})`,
    });
  } finally {
    // Whether the write was refused (transaction now aborted) or wrongly accepted (a row now
    // exists), the transaction has to be returned to the state the next probe expects.
    await client.query("ROLLBACK TO SAVEPOINT rejection_probe");
  }
}

/**
 * Exercises the bounds against real rows.
 *
 * A CONSTRAINT NOBODY HAS WATCHED REFUSE ANYTHING is indistinguishable from an absent one — the
 * same argument `verify-platform-audit-constraints.ts` makes about its triggers. Every statement
 * below runs inside one transaction, and that transaction is always rolled back.
 */
async function checkRuntimeGuarantees(): Promise<readonly CheckOutcome[]> {
  const outcomes: CheckOutcome[] = [];
  const client: PoolClient = await pool.connect();

  try {
    await client.query("BEGIN");

    // A real account to hang the rows off, so the foreign keys are exercised too rather than
    // dodged with a fabricated id.
    const subject = await client.query<{ id: string }>(
      `SELECT id FROM "user" ORDER BY created_at LIMIT 1`,
    );
    const subjectUserId = subject.rows[0]?.id;

    if (subjectUserId === undefined) {
      outcomes.push({
        label: "a user row exists to attach test rows to",
        passed: false,
        detail: "the user table is empty — run this against a seeded database",
      });
      return outcomes;
    }

    await expectRejection(
      client,
      outcomes,
      "hour 24 is refused on user_activity_hour",
      CHECK_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `INSERT INTO user_activity_hour (user_id, activity_date, activity_hour) VALUES ($1, '2026-01-01', 24)`,
          [subjectUserId],
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "negative watched_seconds is refused on user_activity_hour",
      CHECK_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `INSERT INTO user_activity_hour (user_id, activity_date, activity_hour, watched_seconds)
           VALUES ($1, '2026-01-02', 3, -1)`,
          [subjectUserId],
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "negative watched_seconds is refused on user_watch_daily",
      CHECK_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `INSERT INTO user_watch_daily (user_id, watch_date, watched_seconds)
           VALUES ($1, '2026-01-03', -5)`,
          [subjectUserId],
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "a null activity_hour is refused on platform_activity_hour_daily",
      NOT_NULL_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `INSERT INTO platform_activity_hour_daily (activity_date, activity_hour) VALUES ('2026-01-04', NULL)`,
        ),
    );

    /**
     * THE ONE THAT MATTERS MOST. Two inserts for the same (user, date, hour) must ADD, because
     * that is precisely what the beacon path does 240 times an hour per active viewer. If the
     * conflict target fails to resolve, this reads 30 instead of 45 — or the second insert
     * succeeds as a second row and every total on the platform doubles.
     */
    const upsertSql = `
      INSERT INTO user_activity_hour (user_id, activity_date, activity_hour, watched_seconds, beacon_count)
      VALUES ($1, '2026-01-05', 7, $2, 1)
      ON CONFLICT ON CONSTRAINT user_activity_hour_pk DO UPDATE SET
        watched_seconds = user_activity_hour.watched_seconds + EXCLUDED.watched_seconds,
        beacon_count    = user_activity_hour.beacon_count + 1
    `;
    await client.query(upsertSql, [subjectUserId, 15]);
    await client.query(upsertSql, [subjectUserId, 15]);
    await client.query(upsertSql, [subjectUserId, 15]);

    const accumulated = await client.query<{ watched_seconds: number; beacon_count: number }>(
      `SELECT watched_seconds, beacon_count FROM user_activity_hour
        WHERE user_id = $1 AND activity_date = '2026-01-05' AND activity_hour = 7`,
      [subjectUserId],
    );
    const accumulatedRow = accumulated.rows[0];
    outcomes.push({
      label: "three upserts on the same (user, date, hour) accumulate rather than replace",
      passed:
        accumulated.rowCount === 1 &&
        accumulatedRow?.watched_seconds === 45 &&
        accumulatedRow.beacon_count === 3,
      detail: `${String(accumulated.rowCount)} row(s), ${String(accumulatedRow?.watched_seconds)}s over ${String(accumulatedRow?.beacon_count)} beacons (expected 1 row, 45s, 3)`,
    });

    return outcomes;
  } finally {
    // Always. Nothing this script writes is meant to survive. Guarded so a failing ROLLBACK
    // cannot mask the error that caused it, matching verify-discovery-constraints.ts.
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
      ? `\nAll ${String(outcomes.length)} watch-metrics guarantees are in force.`
      : `\n${String(failureCount)} of ${String(outcomes.length)} guarantees are MISSING.`,
  );

  if (failureCount > 0) {
    process.exitCode = 1;
  }
}

main()
  .then(async () => {
    await pool.end();
    return undefined;
  })
  .catch(async (error: unknown) => {
    console.error("Watch metrics constraint verification failed:", error);
    await pool.end();
    process.exit(1);
  });
