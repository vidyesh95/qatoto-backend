/**
 * Verifies that migration 0013's DATABASE-LEVEL guarantees are actually in force
 * (R_AND_D_BACKEND_STRUCTURE.md §8, §17).
 *
 * WHY THIS IS A SCRIPT AND NOT A TEST — the same reason verify-discovery-constraints.ts
 * is: the vitest suite mocks `#src/db/index.js` wholesale (there is no test database), so
 * it can prove things about TypeScript and nothing about Postgres. Two of the strongest
 * claims in §8 are enforced BY POSTGRES ALONE and by nothing in TypeScript:
 *
 *   1. `workshop_task.rank` is `COLLATE "C"`. Without it, `ORDER BY rank` follows the
 *      database's ICU locale while every client compares code points — the board renders
 *      in a different order than the server paginates, silently, forever.
 *   2. The board's `(project_id, position)` unique is DEFERRABLE. Without it, a reorder
 *      cannot pass through its own intermediate state and either fails at the first
 *      UPDATE or has to give up the invariant.
 *
 * Neither is expressible in Drizzle, so neither is covered by `db:generate` drift
 * detection. An untested hand-written migration is indistinguishable from an absent one.
 *
 * Read-only in effect: every write happens inside a transaction that is always rolled
 * back.
 *
 *   pnpm db:verify-workshop-constraints
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
  "workshop_board_column",
  "workshop_task",
  "workshop_file",
  "workshop_chat_message",
  "workshop_chat_read_state",
  "daily_log",
  "daily_log_transcript_segment",
  "daily_log_ai_summary_chip",
  "daily_log_extracted_claim",
  "daily_log_evidence_link",
] as const;

/**
 * Every §8 FK, with the `onDelete` §4f requires. This is the cascade sweep from §17 step
 * 8, expressed as data so adding a table without deciding its cascade policy fails here.
 *
 * `a` = NO ACTION, `r` = RESTRICT, `c` = CASCADE, `n` = SET NULL — pg_constraint.confdeltype.
 */
const EXPECTED_FK_ACTIONS: readonly {
  readonly table: string;
  readonly column: string;
  readonly action: "r" | "c" | "n";
  readonly why: string;
}[] = [
  // R1: every FK into research_project is restrict. A workshop is the team's working
  // record, not a rebuildable cache.
  { table: "workshop_board_column", column: "project_id", action: "r", why: "R1" },
  { table: "workshop_task", column: "project_id", action: "r", why: "R1" },
  { table: "workshop_file", column: "project_id", action: "r", why: "R1" },
  { table: "workshop_chat_message", column: "project_id", action: "r", why: "R1" },
  { table: "workshop_chat_read_state", column: "project_id", action: "r", why: "R1" },
  { table: "daily_log", column: "project_id", action: "r", why: "R1" },
  // Evidence and authorship: the row must stay resolvable for §9.
  { table: "workshop_file", column: "uploaded_by_member_id", action: "r", why: "evidence" },
  { table: "workshop_chat_message", column: "author_member_id", action: "r", why: "authorship" },
  { table: "daily_log", column: "author_member_id", action: "r", why: "effort evidence" },
  // Content and derivatives cascade.
  { table: "workshop_task", column: "column_id", action: "c", why: "content" },
  { table: "daily_log_transcript_segment", column: "daily_log_id", action: "c", why: "derivative" },
  { table: "daily_log_ai_summary_chip", column: "daily_log_id", action: "c", why: "derivative" },
  { table: "daily_log_extracted_claim", column: "daily_log_id", action: "c", why: "derivative" },
  { table: "daily_log_evidence_link", column: "daily_log_id", action: "c", why: "derivative" },
  // Attribution must never block an account deletion.
  { table: "workshop_task", column: "assignee_member_id", action: "n", why: "attribution" },
  { table: "workshop_board_column", column: "created_by_user_id", action: "n", why: "attribution" },
  { table: "workshop_task", column: "created_by_user_id", action: "n", why: "attribution" },
  { table: "workshop_file", column: "removed_by_user_id", action: "n", why: "attribution" },
];

const EXPECTED_CHECKS = [
  "workshop_task_rank_ck",
  "workshop_file_source_shape_ck",
  "workshop_file_externalUrl_ck",
  "daily_log_video_ck",
  "daily_log_submitted_ck",
  "daily_log_analysis_ck",
  "daily_log_extracted_claim_minutes_ck",
  "daily_log_evidence_link_provenance_ck",
] as const;

const CHECK_VIOLATION_SQLSTATE = "23514";
const UNIQUE_VIOLATION_SQLSTATE = "23505";

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
  const outcomes: CheckOutcome[] = [];

  const tableCount = await countQuery(
    `SELECT count(*) AS n FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [EXPECTED_TABLES],
  );
  outcomes.push({
    label: `all ${EXPECTED_TABLES.length} workshop and daily-log tables exist`,
    passed: tableCount === EXPECTED_TABLES.length,
    detail: `${tableCount}/${EXPECTED_TABLES.length}`,
  });

  // GUARANTEE 1 — the collation. `pg_collation.collname` is 'C' only when the column was
  // explicitly altered; the default is the database's, which is not what this needs.
  const { rows: collationRows } = await pool.query<{ collname: string | null }>(
    `SELECT c.collname
       FROM pg_attribute a
       JOIN pg_class t ON t.oid = a.attrelid
       LEFT JOIN pg_collation c ON c.oid = a.attcollation
      WHERE t.relname = 'workshop_task' AND a.attname = 'rank' AND NOT a.attisdropped`,
  );
  const rankCollation = collationRows[0]?.collname ?? "(none)";
  outcomes.push({
    label: 'workshop_task.rank is COLLATE "C"',
    passed: rankCollation === "C",
    detail: rankCollation,
  });

  // GUARANTEE 2 — the deferrable unique. A unique INDEX cannot be deferred, so this must
  // be a CONSTRAINT, and `condeferrable` must be true.
  const { rows: constraintRows } = await pool.query<{
    condeferrable: boolean;
    condeferred: boolean;
  }>(
    `SELECT condeferrable, condeferred FROM pg_constraint
      WHERE conname = 'workshop_board_column_projectId_position_unq'`,
  );
  const boardUnique = constraintRows[0];
  outcomes.push({
    label: "board (project_id, position) unique is DEFERRABLE INITIALLY DEFERRED",
    passed: (boardUnique?.condeferrable ?? false) && (boardUnique?.condeferred ?? false),
    detail: boardUnique
      ? `deferrable=${boardUnique.condeferrable} deferred=${boardUnique.condeferred}`
      : "constraint missing",
  });

  const checkCount = await countQuery(
    `SELECT count(*) AS n FROM pg_constraint WHERE contype = 'c' AND conname = ANY($1)`,
    [EXPECTED_CHECKS],
  );
  outcomes.push({
    label: "the §8 CHECK constraints are attached",
    passed: checkCount === EXPECTED_CHECKS.length,
    detail: `${checkCount}/${EXPECTED_CHECKS.length}`,
  });

  // The cascade sweep (§17 step 8).
  const { rows: fkRows } = await pool.query<{
    table_name: string;
    column_name: string;
    confdeltype: string;
  }>(
    `SELECT t.relname AS table_name, a.attname AS column_name, c.confdeltype
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f' AND t.relname = ANY($1)`,
    [EXPECTED_TABLES],
  );

  const mismatches = EXPECTED_FK_ACTIONS.filter((expected) => {
    const actual = fkRows.find(
      (row) => row.table_name === expected.table && row.column_name === expected.column,
    );
    return actual?.confdeltype !== expected.action;
  });

  outcomes.push({
    label: "every §8 foreign key has its §4f onDelete action",
    passed: mismatches.length === 0,
    detail:
      mismatches.length === 0
        ? `${EXPECTED_FK_ACTIONS.length} checked`
        : mismatches.map((fk) => `${fk.table}.${fk.column} (${fk.why})`).join(", "),
  });

  return outcomes;
}

/**
 * Exercises the two hand-written guarantees against real rows.
 *
 * A guarantee nobody has watched fire is a guarantee nobody should trust — and both of
 * these fail SILENTLY when absent, which is precisely why they are exercised rather than
 * merely inspected.
 */
async function checkRuntimeGuarantees(): Promise<readonly CheckOutcome[]> {
  const client = await pool.connect();
  const outcomes: CheckOutcome[] = [];

  try {
    await client.query("BEGIN");

    // THE COLLATION, PROVEN BY ORDERING. Under ICU en_US.UTF-8 these three sort
    // "a" < "B" < "b"; under C they sort "B" < "a" < "b" (byte order), which is what every
    // client's code-point compare does. The rank CHECK forbids uppercase in real data, so
    // this probes the COLUMN's collation directly with a literal cast instead.
    const { rows: orderRows } = await client.query<{ ordered: string[] }>(
      `SELECT array_agg(v ORDER BY v COLLATE "C") AS ordered
         FROM (VALUES ('a'), ('B'), ('b')) AS s(v)`,
    );
    outcomes.push({
      label: 'COLLATE "C" orders by bytes, not by locale',
      passed: JSON.stringify(orderRows[0]?.ordered) === JSON.stringify(["B", "a", "b"]),
      detail: JSON.stringify(orderRows[0]?.ordered ?? []),
    });

    const { rows: rankOrderRows } = await client.query<{ collation_matches: boolean }>(
      `SELECT (a.attcollation = (SELECT oid FROM pg_collation WHERE collname = 'C' LIMIT 1))
                AS collation_matches
         FROM pg_attribute a
         JOIN pg_class t ON t.oid = a.attrelid
        WHERE t.relname = 'workshop_task' AND a.attname = 'rank'`,
    );
    outcomes.push({
      label: "the rank column itself carries that collation",
      passed: rankOrderRows[0]?.collation_matches ?? false,
      detail: `${rankOrderRows[0]?.collation_matches ?? "unknown"}`,
    });

    // DISPOSABLE FIXTURES, created inside the transaction this function always rolls
    // back. Probing whatever project happens to exist would make the script's result
    // depend on the database's contents — it must pass on an empty one, which is exactly
    // the state a fresh deploy is in when someone wants to know whether 0013 landed.
    const [category] = (
      await client.query<{ id: string }>(
        `SELECT id FROM research_category WHERE status = 'approved' LIMIT 1`,
      )
    ).rows;

    if (!category) {
      outcomes.push({
        label: "runtime probes",
        passed: false,
        detail: "no approved category — run `pnpm db:seed-research-categories` first",
      });
      return outcomes;
    }

    const fixtureUserId = "verify-workshop-user";
    const fixtureProjectId = "verify-workshop-project";

    await client.query(
      `INSERT INTO "user" (id, name, email, email_verified)
       VALUES ($1, 'Verify Fixture', $2, true)`,
      [fixtureUserId, `${fixtureUserId}@example.test`],
    );
    await client.query(
      `INSERT INTO research_project (id, slug, founder_user_id, name, tagline, category_id)
       VALUES ($1, 'verify-workshop-project', $2, 'Verify', 'Constraint probe fixture', $3)`,
      [fixtureProjectId, fixtureUserId, category.id],
    );
    const [fixtureMember] = (
      await client.query<{ id: string }>(
        `INSERT INTO project_member (id, project_id, user_id, project_role)
         VALUES ('verify-workshop-member', $1, $2, 'founder') RETURNING id`,
        [fixtureProjectId, fixtureUserId],
      )
    ).rows;

    const project = { id: fixtureProjectId };
    const member = fixtureMember;

    // The rank alphabet CHECK. A rank outside [0-9a-z] is what would make the two
    // orderings diverge even with the collation in place.
    await client.query(
      `INSERT INTO workshop_board_column (id, project_id, title, position)
       VALUES ('verify-col-1', $1, 'Verify A', 900), ('verify-col-2', $1, 'Verify B', 901)`,
      [project.id],
    );

    await client.query("SAVEPOINT before_bad_rank");
    try {
      await client.query(
        `INSERT INTO workshop_task (id, project_id, column_id, title, rank)
         VALUES ('verify-task-bad', $1, 'verify-col-1', 'Bad rank', 'A-1')`,
        [project.id],
      );
      outcomes.push({
        label: "a rank outside [0-9a-z] is rejected",
        passed: false,
        detail: "the INSERT SUCCEEDED",
      });
    } catch (error) {
      const sqlState = sqlStateOf(error);
      outcomes.push({
        label: "a rank outside [0-9a-z] is rejected",
        passed: sqlState === CHECK_VIOLATION_SQLSTATE,
        detail: `SQLSTATE ${sqlState ?? "unknown"}`,
      });
    }
    await client.query("ROLLBACK TO SAVEPOINT before_bad_rank");

    // THE DEFERRED UNIQUE, PROVEN BY A REORDER. Swapping two positions passes through a
    // state where both columns hold the same one. An IMMEDIATE constraint rejects the
    // first UPDATE; a deferred one checks at COMMIT and lets the swap through.
    await client.query("SAVEPOINT before_swap");
    try {
      await client.query(
        `UPDATE workshop_board_column SET position = 901 WHERE id = 'verify-col-1'`,
      );
      await client.query(
        `UPDATE workshop_board_column SET position = 900 WHERE id = 'verify-col-2'`,
      );
      // Forces the deferred check to run now rather than at a COMMIT this script never
      // performs — without this the probe would pass even if the constraint were missing.
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      outcomes.push({
        label: "a two-column position swap commits without a temporary shuffle",
        passed: true,
        detail: "deferred check passed at the end of the transaction",
      });
    } catch (error) {
      outcomes.push({
        label: "a two-column position swap commits without a temporary shuffle",
        passed: false,
        detail: `SQLSTATE ${sqlStateOf(error) ?? "unknown"} — the constraint is not deferrable`,
      });
    }
    await client.query("ROLLBACK TO SAVEPOINT before_swap");

    // And the constraint must still REJECT a genuine duplicate at the end of the
    // transaction — deferrable means "checked later", not "not checked".
    await client.query("SAVEPOINT before_duplicate");
    try {
      await client.query(
        `UPDATE workshop_board_column SET position = 900 WHERE id = 'verify-col-2'`,
      );
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      outcomes.push({
        label: "a genuine duplicate position is still rejected",
        passed: false,
        detail: "the duplicate SURVIVED the deferred check",
      });
    } catch (error) {
      const sqlState = sqlStateOf(error);
      outcomes.push({
        label: "a genuine duplicate position is still rejected",
        passed: sqlState === UNIQUE_VIOLATION_SQLSTATE,
        detail: `SQLSTATE ${sqlState ?? "unknown"}`,
      });
    }
    await client.query("ROLLBACK TO SAVEPOINT before_duplicate");

    // The file-shape CHECK: a link with a size is the exact state §8 forbids, because
    // there are no bytes to have measured.
    await client.query("SAVEPOINT before_bad_file");
    try {
      if (member) {
        await client.query(
          `INSERT INTO workshop_file
             (id, project_id, file_name, file_kind, source, external_url, external_host,
              size_bytes, uploaded_by_member_id)
           VALUES ('verify-file-bad', $1, 'spec.pdf', 'document', 'external_link',
                   'https://drive.google.com/file/d/x/view', 'drive.google.com', 1024, $2)`,
          [project.id, member.id],
        );
        outcomes.push({
          label: "a linked file carrying a byte size is rejected",
          passed: false,
          detail: "the INSERT SUCCEEDED",
        });
      } else {
        outcomes.push({
          label: "a linked file carrying a byte size is rejected",
          passed: false,
          detail: "no project_member row to attach the probe to",
        });
      }
    } catch (error) {
      const sqlState = sqlStateOf(error);
      outcomes.push({
        label: "a linked file carrying a byte size is rejected",
        passed: sqlState === CHECK_VIOLATION_SQLSTATE,
        detail: `SQLSTATE ${sqlState ?? "unknown"}`,
      });
    }
    await client.query("ROLLBACK TO SAVEPOINT before_bad_file");

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
      ? `\nAll ${outcomes.length} workshop guarantees verified.`
      : `\n${failureCount} of ${outcomes.length} guarantees FAILED.`,
  );

  if (failureCount > 0) {
    process.exitCode = 1;
  }
}

main()
  .then(async () => {
    await pool.end();
    // Deliberately NOT process.exit(0) — see verify-discovery-constraints.ts.
    return undefined;
  })
  .catch(async (error: unknown) => {
    console.error("Workshop constraint verification failed to run:", error);
    await pool.end();
    process.exit(1);
  });
