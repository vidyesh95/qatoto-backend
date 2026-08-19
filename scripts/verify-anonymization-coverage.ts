/**
 * Proves that `anonymization-manifest.ts` still describes the DATABASE, not the database as it
 * was on the day it was written.
 *
 * WHY A SCRIPT AND NOT A TEST — the same reason every other `verify-*-constraints.ts` gives: the
 * vitest suite mocks `#src/db/index.js` wholesale, so it can prove things about TypeScript and
 * nothing about Postgres. A foreign key that exists in a migration and not in the manifest is
 * invisible to every test in the repo and to `tsc`.
 *
 * ## WHAT IS ACTUALLY AT STAKE
 *
 * Account closure is an ANONYMIZATION — nothing ever issues `DELETE FROM "user"` — so
 * `ON DELETE cascade` and `ON DELETE set null` never fire, and every one of the 151 columns
 * pointing at `user` is handled only because the manifest names it. The failure this script
 * exists for is therefore silent by construction:
 *
 *   Somebody adds a table next year with a `user_id` column. The scrub does not know about it.
 *   An account is anonymized. The new table keeps its rows, with a live foreign key to a row
 *   whose name now reads "Deleted user" — and nothing anywhere reports a problem, because from
 *   the job's point of view every step it knew about succeeded.
 *
 * There is no error, no log line, and no way to notice except by asking Postgres what actually
 * references `user`. That is this script.
 *
 * ## SIX CHECKS, AND THE LAST TWO ARE THE ONES THAT MATTER
 *
 *   1. Every FK into `user` appears in the manifest. Catches the new table above.
 *   2. Every manifest key still exists as an FK. Catches rot in the other direction — a
 *      dropped column leaves an entry that reads as coverage of something that is gone, and
 *      the scrub would then execute SQL against a table that no longer has that column.
 *   3. `null_out` only ever names a NULLABLE column. A `set null` foreign key on a NOT NULL
 *      column is a latent bug this catches for free, and it would surface as a 23502 at 05:30
 *      in the middle of an irreversible operation.
 *   4. `retain` carries a non-empty lawful basis. "We kept it" without a citation is the
 *      answer that loses an Art. 17 complaint.
 *   5. THE BEHAVIOURAL ONE. Seeds a throwaway user, runs the manifest's own delete and null
 *      steps against it inside a transaction, and then asks Postgres whether ANY column still
 *      references that id. Checks 1-4 compare two lists; this one proves the list is
 *      executable — that every statement the scrub will run actually parses, and that no
 *      trigger rejects it.
 *   6. Asks all 151 columns whether they still hold the probe id afterwards. Check 1 compares
 *      names; this asks Postgres, so it also catches a step that ran against the wrong column.
 *
 * Check 5 is where a `retain` on a trigger-protected table earns its keep: four columns are
 * `set null` in the schema and `retain` in the manifest precisely because a BEFORE UPDATE
 * trigger raises P0001 on them, and flipping one back to `null_out` fails here rather than at
 * 05:30 on a live account.
 *
 * Read-only in effect: every write happens inside a transaction that is always rolled back.
 *
 *   pnpm db:verify-anonymization-coverage
 *
 * Exits non-zero if any guarantee is missing, so it can gate a deploy. Run it after ANY
 * migration that adds a reference to `user`.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { pool } from "#src/db/index.js";
import {
  ANONYMIZATION_MANIFEST,
  DELETE_ROW_KEYS,
  NULL_OUT_KEYS,
  parseUserReferenceKey,
  type UserReferenceKey,
} from "#src/modules/auth/privacy/anonymization-manifest.js";

interface CheckOutcome {
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

interface UserReferenceRow {
  readonly table_name: string;
  readonly column_name: string;
  readonly delete_rule: string;
  readonly is_nullable: string;
}

/**
 * Every column in the public schema with a foreign key to `"user"(id)`, with the delete rule
 * and the column's nullability.
 *
 * `pg_constraint` rather than `information_schema.referential_constraints`: the latter needs
 * three joins to reach the referenced table and silently omits constraints the current role
 * cannot see, which would make a permissions problem look like full coverage — the exact
 * direction of error this script must never make.
 */
async function readUserReferences(client: PoolClient): Promise<readonly UserReferenceRow[]> {
  const { rows } = await client.query<UserReferenceRow>(`
    SELECT child.relname          AS table_name,
           att.attname            AS column_name,
           CASE con.confdeltype
             WHEN 'a' THEN 'no action'
             WHEN 'r' THEN 'restrict'
             WHEN 'c' THEN 'cascade'
             WHEN 'n' THEN 'set null'
             WHEN 'd' THEN 'set default'
           END                    AS delete_rule,
           CASE WHEN att.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable
    FROM pg_constraint con
    JOIN pg_class  child  ON child.oid  = con.conrelid
    JOIN pg_class  parent ON parent.oid = con.confrelid
    JOIN pg_namespace ns  ON ns.oid     = child.relnamespace
    JOIN unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE
    JOIN pg_attribute att  ON att.attrelid = child.oid AND att.attnum = k.attnum
    WHERE con.contype = 'f'
      AND parent.relname = 'user'
      AND ns.nspname = 'public'
    ORDER BY child.relname, att.attname
  `);
  return rows;
}

function keyOf(row: UserReferenceRow): UserReferenceKey {
  return `${row.table_name}.${row.column_name}`;
}

function compareCoverage(references: readonly UserReferenceRow[]): readonly CheckOutcome[] {
  // Both widened to `string`: one side comes from Postgres and the other from a template-literal
  // key type, and the whole job here is to compare them for membership in both directions.
  const liveKeys = new Set<string>(references.map(keyOf));
  const manifestKeys = new Set<string>(Object.keys(ANONYMIZATION_MANIFEST));

  const missing = [...liveKeys].filter((key) => !manifestKeys.has(key)).toSorted();
  const stale = [...manifestKeys].filter((key) => !liveKeys.has(key)).toSorted();

  const nullableByKey = new Map(references.map((row) => [keyOf(row), row.is_nullable === "YES"]));
  const notNullNullOuts = NULL_OUT_KEYS.filter(
    (key) => nullableByKey.get(key) === false,
  ).toSorted();

  const basisFreeRetains = Object.entries(ANONYMIZATION_MANIFEST)
    .filter(
      ([, disposition]) =>
        disposition.kind === "retain" && disposition.lawfulBasis.trim().length === 0,
    )
    .map(([key]) => key)
    .toSorted();

  return [
    {
      label: "every user reference is in the manifest",
      passed: missing.length === 0,
      detail:
        missing.length === 0
          ? `all ${String(liveKeys.size)} references classified`
          : `UNCLASSIFIED, and their PII survives an erasure: ${missing.join(", ")}`,
    },
    {
      label: "no manifest entry names a reference that is gone",
      passed: stale.length === 0,
      detail:
        stale.length === 0
          ? `all ${String(manifestKeys.size)} entries still exist`
          : `stale entries — the scrub would run SQL against them: ${stale.join(", ")}`,
    },
    {
      label: "every null_out column is nullable",
      passed: notNullNullOuts.length === 0,
      detail:
        notNullNullOuts.length === 0
          ? `all ${String(NULL_OUT_KEYS.length)} null_out columns accept NULL`
          : `NOT NULL, so the scrub would raise 23502 mid-erasure: ${notNullNullOuts.join(", ")}`,
    },
    {
      label: "every retain cites a lawful basis",
      passed: basisFreeRetains.length === 0,
      detail:
        basisFreeRetains.length === 0
          ? "no unexplained retentions"
          : `retained without a citation: ${basisFreeRetains.join(", ")}`,
    },
  ];
}

/**
 * Check 5. Seeds a user, runs every manifest step against it, and asks whether anything still
 * points at the id.
 *
 * The user is seeded with NO child rows on purpose. This is not a test that the scrub erases
 * data — it is a test that every statement the scrub will issue is legal: that the table and
 * column exist, that the types line up, and above all that no trigger rejects the write. A
 * `null_out` on a BEFORE UPDATE table fails here with P0001 even against zero rows.
 */
async function checkStepsAreExecutable(
  client: PoolClient,
  references: readonly UserReferenceRow[],
): Promise<readonly CheckOutcome[]> {
  const outcomes: CheckOutcome[] = [];
  const probeUserId = `anonymization-coverage-probe-${randomUUID()}`;

  await client.query(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ($1, 'Coverage probe', $2, false, now(), now())`,
    [probeUserId, `${probeUserId}@coverage.invalid`],
  );

  const failures: string[] = [];

  /**
   * ⚠️ THE SAVEPOINT IS NOT OPTIONAL, and leaving it out made this script useless in the one
   * situation it exists for.
   *
   * Every probe below runs inside `main`'s single transaction. A failing statement puts that
   * transaction into the aborted state, after which Postgres answers EVERY later statement
   * with `25P02 current transaction is aborted`. So the first genuinely-wrong manifest entry
   * used to produce one true error followed by ~150 fabricated ones, and it destroyed check 6
   * as well — the output became unreadable at exactly the moment it mattered.
   *
   * `verify-watch-metrics-constraints.ts` brackets its probes the same way, for the same
   * reason, after the same bug (commit `0ca2098`). The savepoint name is reused deliberately:
   * each probe rolls back to it before the next issues its own.
   */
  const probeStatement = async (key: string, statement: string): Promise<void> => {
    await client.query("SAVEPOINT coverage_probe");
    try {
      await client.query(statement, [probeUserId]);
      await client.query("RELEASE SAVEPOINT coverage_probe");
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT coverage_probe");
      failures.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  for (const key of DELETE_ROW_KEYS) {
    const { tableName, columnName } = parseUserReferenceKey(key);
    // Identifiers come from this repo's own manifest, never a request; the VALUE is bound.
    await probeStatement(key, `DELETE FROM "${tableName}" WHERE "${columnName}" = $1`);
  }

  for (const key of NULL_OUT_KEYS) {
    const { tableName, columnName } = parseUserReferenceKey(key);
    await probeStatement(
      key,
      `UPDATE "${tableName}" SET "${columnName}" = NULL WHERE "${columnName}" = $1`,
    );
  }

  outcomes.push({
    label: "every manifest step executes",
    passed: failures.length === 0,
    detail:
      failures.length === 0
        ? `${String(DELETE_ROW_KEYS.length)} deletes and ${String(NULL_OUT_KEYS.length)} null-outs all legal`
        : `statements the scrub would fail on: ${failures.join(" | ")}`,
  });

  outcomes.push(await checkNothingStillReferences(client, references, probeUserId));

  return outcomes;
}

/**
 * Check 6 — the same defect as check 1, proved from the other end.
 *
 * Asks every column that references `user` whether it still holds the probe id, AFTER the
 * manifest's steps have run. Check 1 compares two lists of names and can only catch a column
 * the manifest never heard of; this asks the database directly, so it also catches a step that
 * ran against the wrong column, or one whose WHERE clause did not match what it was supposed to.
 *
 * With a probe that starts with no children this can only fail if a `retain` column was seeded
 * — which is the point at which someone has extended this script and should be reading it.
 */
async function checkNothingStillReferences(
  client: PoolClient,
  references: readonly UserReferenceRow[],
  probeUserId: string,
): Promise<CheckOutcome> {
  const stillReferencing: string[] = [];

  for (const reference of references) {
    const { rows } = await client.query<{ remaining: string }>(
      `SELECT count(*)::text AS remaining
       FROM "${reference.table_name}" WHERE "${reference.column_name}" = $1`,
      [probeUserId],
    );
    if ((rows[0]?.remaining ?? "0") !== "0") {
      stillReferencing.push(`${keyOf(reference)} (${rows[0]?.remaining ?? "?"} rows)`);
    }
  }

  return {
    label: "nothing references the probe user afterwards",
    passed: stillReferencing.length === 0,
    detail:
      stillReferencing.length === 0
        ? `${String(references.length)} columns checked, none still pointing at the probe`
        : `rows survived the scrub: ${stillReferencing.join(", ")}`,
  };
}

async function main(): Promise<void> {
  const client = await pool.connect();
  let outcomes: readonly CheckOutcome[] = [];

  try {
    await client.query("BEGIN");
    const references = await readUserReferences(client);
    outcomes = [
      ...compareCoverage(references),
      ...(await checkStepsAreExecutable(client, references)),
    ];
  } finally {
    // Always. Nothing this script writes is meant to survive. Guarded so a failing ROLLBACK
    // cannot mask the error that caused it, matching verify-discovery-constraints.ts.
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }

  for (const outcome of outcomes) {
    console.log(`${outcome.passed ? "PASS" : "FAIL"}  ${outcome.label} — ${outcome.detail}`);
  }

  const failureCount = outcomes.filter((outcome) => !outcome.passed).length;
  console.log(
    failureCount === 0
      ? `\nAll ${String(outcomes.length)} anonymization-coverage guarantees are in force.`
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
    console.error("Anonymization coverage verification failed:", error);
    await pool.end();
    process.exit(1);
  });
