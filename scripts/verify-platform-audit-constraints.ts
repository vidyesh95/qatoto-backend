/**
 * Verifies that migration 0025's DATABASE-LEVEL guarantees are in force
 * (R_AND_D_BACKEND_STRUCTURE.md §11l.2 item 2, §17).
 *
 * WHY A SCRIPT AND NOT A TEST — the same reason `verify-proof-of-effort-constraints.ts`
 * gives: the vitest suite mocks `#src/db/index.js` wholesale, so it can prove things about
 * TypeScript and nothing about Postgres. And the claim this chain makes is one TypeScript
 * cannot make at all — that a moderation entry cannot be edited or deleted by anyone,
 * including whoever wrote it and including a DBA with a psql prompt.
 *
 * A service that declines to write an UPDATE is not that guarantee. The trigger is. And a
 * hand-written trigger nobody has watched fire is indistinguishable from an absent one, so
 * every guarantee below is EXERCISED against real rows.
 *
 * Read-only in effect: every write happens inside a transaction that is always rolled back.
 *
 *   pnpm db:verify-platform-audit-constraints
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

/** The custom SQLSTATE `qatoto_reject_mutation()` raises (migration 0010). */
const APPEND_ONLY_SQLSTATE = "QT001";
const CHECK_VIOLATION_SQLSTATE = "23514";
const UNIQUE_VIOLATION_SQLSTATE = "23505";

const EXPECTED_TRIGGERS = ["platform_audit_entry_append_only", "platform_audit_entry_no_truncate"];

const SIXTY_FOUR_ZEROS = "0".repeat(64);

async function countQuery(text: string, values: readonly unknown[] = []): Promise<number> {
  const result = await pool.query<{ n: string }>(text, [...values]);
  return Number(result.rows[0]?.n ?? 0);
}

async function checkSchemaObjects(): Promise<readonly CheckOutcome[]> {
  const outcomes: CheckOutcome[] = [];

  const tableCount = await countQuery(
    `SELECT count(*) AS n FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [["platform_audit_entry", "platform_chain_head"]],
  );
  outcomes.push({
    label: "both platform audit tables exist",
    passed: tableCount === 2,
    detail: `${String(tableCount)}/2`,
  });

  const triggerCount = await countQuery(
    `SELECT count(*) AS n FROM pg_trigger
      WHERE NOT tgisinternal AND tgname = ANY($1)`,
    [EXPECTED_TRIGGERS],
  );
  outcomes.push({
    label: "the append-only trigger PAIR is installed",
    passed: triggerCount === EXPECTED_TRIGGERS.length,
    detail: `${String(triggerCount)}/${String(EXPECTED_TRIGGERS.length)} — a row trigger alone does not fire on TRUNCATE`,
  });

  // The head must be seeded, or the first appender races to create it under a lock it does
  // not yet hold.
  const headCount = await countQuery(`SELECT count(*) AS n FROM platform_chain_head`);
  outcomes.push({
    label: "the singleton chain head row is seeded",
    passed: headCount === 1,
    detail: `${String(headCount)} row(s); the CHECK pins the id to 'global'`,
  });

  return outcomes;
}

type TransactionClient = Pick<PoolClient, "query">;

async function expectRejection(
  client: TransactionClient,
  outcomes: CheckOutcome[],
  label: string,
  expectedSqlState: string,
  statement: () => Promise<unknown>,
): Promise<void> {
  const savepoint = `probe_${String(outcomes.length)}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    await statement();
    outcomes.push({ label, passed: false, detail: "the statement SUCCEEDED" });
  } catch (error) {
    const sqlState =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "unknown";
    outcomes.push({
      label,
      passed: sqlState === expectedSqlState,
      detail: `SQLSTATE ${sqlState} (expected ${expectedSqlState})`,
    });
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  }
}

async function checkRuntimeGuarantees(): Promise<readonly CheckOutcome[]> {
  const client = await pool.connect();
  const outcomes: CheckOutcome[] = [];

  try {
    await client.query("BEGIN");

    const actorResult = await client.query<{ id: string }>(`SELECT id FROM "user" LIMIT 1`);
    const actorUserId = actorResult.rows[0]?.id;

    if (actorUserId === undefined) {
      return [
        {
          label: "runtime probes",
          passed: false,
          detail: "no user rows — sign someone up first, the actor FK is NOT NULL",
        },
      ];
    }

    // A genesis entry to probe against. Sequence 1 with no predecessor, which is the one
    // shape `platform_audit_entry_link_ck` permits.
    await client.query(
      `INSERT INTO platform_audit_entry
         (id, sequence_number, event_kind, actor_user_id, actor_role_snapshot,
          action_label, target_label, detail_note, payload_json, occurred_at,
          previous_entry_hash, entry_hash, hash_algorithm_version)
       VALUES ('verify-platform-audit', 1, 'taxonomy_category_approved', $1, 'moderator',
               'Approved a category', 'category probe', '', '{}', now(), NULL, $2,
               'sha256-jcs-v1')`,
      [actorUserId, SIXTY_FOUR_ZEROS],
    );

    await expectRejection(
      client,
      outcomes,
      "a moderation entry cannot be edited after the fact",
      APPEND_ONLY_SQLSTATE,
      () =>
        client.query(
          `UPDATE platform_audit_entry SET detail_note = 'tampered' WHERE id = 'verify-platform-audit'`,
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "a moderation entry cannot be deleted to hide a decision",
      APPEND_ONLY_SQLSTATE,
      () => client.query(`DELETE FROM platform_audit_entry WHERE id = 'verify-platform-audit'`),
    );

    // Only sequence 1 may have no predecessor. Without this a forged chain could start
    // anywhere and every surviving hash would still be self-consistent.
    await expectRejection(
      client,
      outcomes,
      "only the genesis entry may have a null previousEntryHash",
      CHECK_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `INSERT INTO platform_audit_entry
             (id, sequence_number, event_kind, actor_user_id, actor_role_snapshot,
              action_label, target_label, payload_json, occurred_at,
              previous_entry_hash, entry_hash, hash_algorithm_version)
           VALUES ('verify-platform-audit-2', 2, 'supplier_created', $1, 'moderator',
                   'Created a supplier', 'supplier probe', '{}', now(), NULL, $2,
                   'sha256-jcs-v1')`,
          [actorUserId, SIXTY_FOUR_ZEROS],
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "two entries cannot share a sequence number",
      UNIQUE_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `INSERT INTO platform_audit_entry
             (id, sequence_number, event_kind, actor_user_id, actor_role_snapshot,
              action_label, target_label, payload_json, occurred_at,
              previous_entry_hash, entry_hash, hash_algorithm_version)
           VALUES ('verify-platform-audit-dup', 1, 'supplier_updated', $1, 'moderator',
                   'Updated a supplier', 'supplier probe', '{}', now(), NULL, $2,
                   'sha256-jcs-v1')`,
          [actorUserId, SIXTY_FOUR_ZEROS],
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "an entry hash must be 64 lowercase hex characters",
      CHECK_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `INSERT INTO platform_audit_entry
             (id, sequence_number, event_kind, actor_user_id, actor_role_snapshot,
              action_label, target_label, payload_json, occurred_at,
              previous_entry_hash, entry_hash, hash_algorithm_version)
           VALUES ('verify-platform-audit-hash', 2, 'supplier_updated', $1, 'moderator',
                   'Updated a supplier', 'supplier probe', '{}', now(), $2, 'NOT-A-HASH',
                   'sha256-jcs-v1')`,
          [actorUserId, SIXTY_FOUR_ZEROS],
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "a second chain head row is refused",
      CHECK_VIOLATION_SQLSTATE,
      () => client.query(`INSERT INTO platform_chain_head (id) VALUES ('shadow')`),
    );

    return outcomes;
  } finally {
    // Always. Nothing this script writes is meant to survive.
    await client.query("ROLLBACK");
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
      ? `\nAll ${String(outcomes.length)} platform-audit guarantees are in force.`
      : `\n${String(failureCount)} of ${String(outcomes.length)} guarantees are MISSING.`,
  );

  if (failureCount > 0) {
    process.exitCode = 1;
  }
}

main()
  .then(async () => {
    await pool.end();
    // Deliberately NOT process.exit(0) — the exit code is set above, and forcing it here
    // would truncate a pending stdout flush. Same tail as the other verify-* scripts.
    return undefined;
  })
  .catch(async (error: unknown) => {
    console.error("Platform audit constraint verification failed:", error);
    await pool.end();
    process.exit(1);
  });
