/**
 * Proves the §10 constraints against a REAL database.
 *
 *   pnpm db:verify-research-program-constraints
 *
 * WHY THIS EXISTS SEPARATELY FROM THE VITEST SUITE. That suite mocks `#src/db/index.js`
 * wholesale, so it can prove things about arithmetic and nothing about Postgres. Every claim
 * below is a claim about the DATABASE — a CHECK, a partial unique index, a collation, a
 * cascade policy, a trigger — and the only way to prove one is to attempt the write and watch
 * it be refused. A guarantee nobody has seen fire is a guarantee nobody should trust.
 *
 * The two that most need proving, because both are invisible until they bite:
 *
 *   COLLATE "C" on `ancestor_path` — hand-written in migration 0029's tail, so drizzle-kit
 *       cannot see it and `pnpm db:generate` will never re-emit it. If it is ever lost, the
 *       branch tree's depth-first ordering silently stops matching what a client computes
 *       with `a < b`, and nothing errors.
 *
 *   THE APPEND-ONLY TRIGGERS on the three record tables. Service discipline is not the
 *       guarantee; the trigger is (§4f). A refactor that drops one leaves the invariant
 *       looking intact and enforced by nothing.
 *
 * EVERYTHING RUNS INSIDE ONE TRANSACTION THAT IS ALWAYS ROLLED BACK — the shape
 * `verify-discovery-constraints.ts` establishes. That is why there is no cleanup code: the
 * rollback is the cleanup, and it cannot be skipped by a failed assertion or a throw.
 *
 * Exits non-zero on any failed assertion.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";

import { pool } from "#src/db/index.js";

const PG_CHECK_VIOLATION = "23514";
const PG_UNIQUE_VIOLATION = "23505";
const PG_FOREIGN_KEY_VIOLATION = "23503";
const QATOTO_APPEND_ONLY_VIOLATION = "QT001";

interface Assertion {
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

const assertions: Assertion[] = [];

function check(label: string, passed: boolean, detail: string): void {
  assertions.push({ label, passed, detail });
  console.log(`${passed ? "  ok  " : " FAIL "} ${label} — ${detail}`);
}

/**
 * `id` has NO database default — drizzle's `$defaultFn(randomUUID)` is application-side, so
 * every raw-SQL insert in this file has to supply one. Worth knowing before writing another
 * script like this: the failure is a 23502 that looks nothing like a missing default.
 */
function newId(): string {
  return randomUUID();
}

function readSqlState(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate: { readonly code?: unknown } = error;
  return typeof candidate.code === "string" ? candidate.code : undefined;
}

async function main(): Promise<void> {
  const client = await pool.connect();
  const suffix = randomUUID().slice(0, 8);

  /**
   * Runs a write that MUST be refused.
   *
   * Each attempt gets its own SAVEPOINT, because a failed statement poisons the enclosing
   * transaction in Postgres — without one, the first expected refusal would abort every later
   * assertion with "current transaction is aborted".
   */
  async function expectRefused(
    label: string,
    expectedSqlState: string,
    statement: string,
    parameters: readonly unknown[] = [],
  ): Promise<void> {
    await client.query(`SAVEPOINT probe`);
    try {
      await client.query(statement, [...parameters]);
      await client.query(`ROLLBACK TO SAVEPOINT probe`);
      check(label, false, "the write SUCCEEDED — the constraint is missing");
    } catch (error: unknown) {
      await client.query(`ROLLBACK TO SAVEPOINT probe`);
      const code = readSqlState(error);
      check(
        label,
        code === expectedSqlState,
        code === expectedSqlState
          ? `refused with ${code}`
          : `refused with ${String(code)}, expected ${expectedSqlState}`,
      );
    }
  }

  try {
    await client.query("BEGIN");

    console.log("\n--- 1. research_program CHECKs ---");

    const programSlug = `verify-rnd-program-${suffix}`;
    const [createdProgram] = (
      await client.query<{ id: string }>(
        `INSERT INTO research_program (id, slug, title, tagline, mission_statement, status)
         VALUES ($5, $1, $2, $3, $4, 'pending') RETURNING id`,
        [
          programSlug,
          `Verify Program ${suffix}`,
          "A disposable program used to prove the §10 constraints.",
          "Created by pnpm db:verify-research-program-constraints inside a transaction that is always rolled back.",
          newId(),
        ],
      )
    ).rows;
    if (!createdProgram) throw new Error("verify: program insert returned no row");
    const programId = createdProgram.id;
    check("a pending program inserts with no reviewer and no publishedAt", true, programSlug);

    const [staffUser] = (
      await client.query<{ id: string }>(
        `SELECT id FROM "user" WHERE platform_role IS NOT NULL LIMIT 1`,
      )
    ).rows;

    await expectRefused(
      "published WITHOUT publishedAt is refused (research_program_published_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE research_program
         SET status = 'published', published_at = NULL, reviewed_at = now(), reviewed_by_user_id = $2
       WHERE id = $1`,
      [programId, staffUser?.id ?? null],
    );

    await expectRefused(
      "a reviewedAt with no reviewer is refused (research_program_review_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE research_program SET reviewed_at = now(), reviewed_by_user_id = NULL WHERE id = $1`,
      [programId],
    );

    await expectRefused(
      "a slug with uppercase or underscores is refused (research_program_slug_ck)",
      PG_CHECK_VIOLATION,
      `INSERT INTO research_program (id, slug, title, tagline, mission_statement)
       VALUES ($2, $1, 'Bad slug', 'Should not insert.', 'Long enough to pass the length CHECK on its own, comfortably.')`,
      [`Bad_Slug_${suffix}`, newId()],
    );

    console.log("\n--- 2. research_program_branch: COLLATE and CHECKs ---");

    const rootPath = `verify-root-${suffix}`;
    const [rootBranch] = (
      await client.query<{ id: string }>(
        `INSERT INTO research_program_branch (id, program_id, title, summary, ancestor_path)
         VALUES ($5, $1, $2, $3, $4) RETURNING id`,
        [
          programId,
          "Verify root branch",
          "A disposable branch used to prove the tree constraints.",
          rootPath,
          newId(),
        ],
      )
    ).rows;
    if (!rootBranch) throw new Error("verify: branch insert returned no row");
    const rootBranchId = rootBranch.id;

    /**
     * THE COLLATION ASSERTION.
     *
     * `ORDER BY ancestor_path` must be BYTE order so the service's depth-first guarantee
     * matches what a JS/Kotlin/Swift client computes. Asserted two ways, because the
     * catalogue and the behaviour can disagree if a later migration alters the column.
     */
    const [collationRow] = (
      await client.query<{ collation_name: string | null }>(
        `SELECT collation_name FROM information_schema.columns
         WHERE table_name = 'research_program_branch' AND column_name = 'ancestor_path'`,
      )
    ).rows;
    check(
      'ancestor_path is COLLATE "C" (migration 0029 tail — drizzle-kit cannot see it)',
      collationRow?.collation_name === "C",
      `collation_name = ${String(collationRow?.collation_name)}`,
    );

    // Behavioural proof: under a locale collation 'a/b' sorts first; under COLLATE "C",
    // uppercase 'B' (0x42) precedes lowercase 'a' (0x61).
    const orderingRows = (
      await client.query<{ probe_value: string }>(
        `SELECT probe_value FROM (VALUES ('B/a'), ('a/b')) AS probe(probe_value)
         ORDER BY probe_value COLLATE "C"`,
      )
    ).rows;
    check(
      "the column's collation really is byte order, not locale order",
      orderingRows[0]?.probe_value === "B/a",
      `sorted as [${orderingRows.map((row) => row.probe_value).join(", ")}]`,
    );

    await expectRefused(
      "a branch that is its own parent is refused (no_self_parent_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE research_program_branch SET parent_branch_id = id WHERE id = $1`,
      [rootBranchId],
    );

    await expectRefused(
      "half a pinned coordinate is refused (branch_pin_ck: both or neither)",
      PG_CHECK_VIOLATION,
      `UPDATE research_program_branch SET pinned_left_permille = 500, pinned_top_permille = NULL WHERE id = $1`,
      [rootBranchId],
    );

    await expectRefused(
      "a pinned per-mille above 1000 is refused (branch_pin_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE research_program_branch SET pinned_left_permille = 1001, pinned_top_permille = 500 WHERE id = $1`,
      [rootBranchId],
    );

    await expectRefused(
      "two branches sharing an ancestorPath in one program are refused (path_unq)",
      PG_UNIQUE_VIOLATION,
      `INSERT INTO research_program_branch (id, program_id, title, summary, ancestor_path)
       VALUES ($3, $1, 'Duplicate path', 'Should not insert — the path is taken in this program.', $2)`,
      [programId, rootPath, newId()],
    );

    // `restrict`, not cascade: deleting a mid-tree branch must not silently take its subtree
    // — and every paper, claim and opportunity hanging off it — with it.
    await client.query(
      `INSERT INTO research_program_branch (id, program_id, parent_branch_id, title, summary, ancestor_path)
       VALUES ($4, $1, $2, 'Verify child branch', 'A child, proving the parent FK is restrict.', $3)`,
      [programId, rootBranchId, `${rootPath}/child-${suffix}`, newId()],
    );
    await expectRefused(
      "deleting a branch that still has children is refused (parent FK is restrict, not cascade)",
      PG_FOREIGN_KEY_VIOLATION,
      `DELETE FROM research_program_branch WHERE id = $1`,
      [rootBranchId],
    );

    console.log("\n--- 3. research_program_post: depth, title and counter CHECKs ---");

    const [createdPost] = (
      await client.query<{ id: string }>(
        `INSERT INTO research_program_post (id, program_id, track, depth, parent_post_id, title, body_text)
         VALUES ($3, $1, 'idea', 0, NULL, NULL, $2) RETURNING id`,
        [programId, "A disposable idea used to prove the post constraints.", newId()],
      )
    ).rows;
    if (!createdPost) throw new Error("verify: post insert returned no row");
    const postId = createdPost.id;
    check("a depth-0 idea with no title and no parent inserts", true, "ok");

    await expectRefused(
      "an idea carrying a title is refused (post_title_ck)",
      PG_CHECK_VIOLATION,
      `INSERT INTO research_program_post (id, program_id, track, depth, title, body_text)
       VALUES ($2, $1, 'idea', 0, 'Ideas must not have titles', 'Should not insert.')`,
      [programId, newId()],
    );

    await expectRefused(
      "an informal paper with NO title is refused (post_title_ck)",
      PG_CHECK_VIOLATION,
      `INSERT INTO research_program_post (id, program_id, track, depth, title, body_text)
       VALUES ($2, $1, 'informal_paper', 0, NULL, 'Should not insert.')`,
      [programId, newId()],
    );

    await expectRefused(
      "depth 2 is refused — the reply cap is one level (post_depth_ck)",
      PG_CHECK_VIOLATION,
      `INSERT INTO research_program_post (id, program_id, track, depth, parent_post_id, body_text)
       VALUES ($3, $1, 'idea', 2, $2, 'Should not insert — replies only go one level deep.')`,
      [programId, postId, newId()],
    );

    await expectRefused(
      "depth 0 WITH a parent is refused (post_depth_ck ties the two together)",
      PG_CHECK_VIOLATION,
      `INSERT INTO research_program_post (id, program_id, track, depth, parent_post_id, body_text)
       VALUES ($3, $1, 'idea', 0, $2, 'Should not insert.')`,
      [programId, postId, newId()],
    );

    await expectRefused(
      "a negative reaction count is refused (post_counts_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE research_program_post SET reaction_count = -1 WHERE id = $1`,
      [postId],
    );

    await expectRefused(
      "isHidden true with no hiddenAt is refused (post_hidden_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE research_program_post SET is_hidden = true, hidden_at = NULL WHERE id = $1`,
      [postId],
    );

    await expectRefused(
      "a depth-0 post claiming a reply count while depth-1 is refused (post_leaf_ck)",
      PG_CHECK_VIOLATION,
      `INSERT INTO research_program_post (id, program_id, track, depth, parent_post_id, body_text, reply_count)
       VALUES ($3, $1, 'idea', 1, $2, 'A reply cannot itself have replies.', 3)`,
      [programId, postId, newId()],
    );

    console.log("\n--- 4. Append-only triggers (§4f) ---");

    const [functionRow] = (
      await client.query<{ function_count: string }>(
        `SELECT COUNT(*)::text AS function_count FROM pg_proc WHERE proname = 'qatoto_reject_mutation'`,
      )
    ).rows;
    check(
      "the shared qatoto_reject_mutation() function exists (migration 0010)",
      Number(functionRow?.function_count ?? 0) === 1,
      `${functionRow?.function_count ?? "0"} function(s)`,
    );

    for (const tableName of [
      "research_program_moderation_action",
      "research_effort_log",
      "research_contribution_ledger_entry",
    ]) {
      const [triggerRow] = (
        await client.query<{ trigger_count: string }>(
          `SELECT COUNT(DISTINCT trigger_name)::text AS trigger_count
           FROM information_schema.triggers
           WHERE event_object_table = $1 AND trigger_name LIKE '%append_only%'`,
          [tableName],
        )
      ).rows;
      check(
        `${tableName} carries its append-only trigger`,
        Number(triggerRow?.trigger_count ?? 0) >= 1,
        `${triggerRow?.trigger_count ?? "0"} matching trigger(s)`,
      );

      /**
       * The TRUNCATE guard has to be read from `pg_trigger`, NOT `information_schema.triggers`.
       *
       * That view implements the SQL standard, which knows only INSERT/UPDATE/DELETE — TRUNCATE
       * is a Postgres extension, so a statement-level TRUNCATE trigger is simply absent from it
       * and a check written against the view reports zero for a trigger that is present and
       * working. Worth knowing before writing another one of these: the view's silence is not
       * evidence.
       *
       * `tgtype & 32` is the TRUNCATE bit (the observed value for these is 34 = BEFORE +
       * TRUNCATE + STATEMENT).
       */
      const [truncateRow] = (
        await client.query<{ trigger_count: string }>(
          `SELECT COUNT(*)::text AS trigger_count
           FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
           WHERE NOT t.tgisinternal AND c.relname = $1 AND (t.tgtype & 32) <> 0`,
          [tableName],
        )
      ).rows;
      // A BEFORE UPDATE OR DELETE *row* trigger does NOT fire on TRUNCATE, so the second
      // trigger is not redundant — without it the table is append-only against statements
      // and wide open to one.
      check(
        `${tableName} also blocks TRUNCATE (a row trigger does not)`,
        Number(truncateRow?.trigger_count ?? 0) >= 1,
        `${truncateRow?.trigger_count ?? "0"} TRUNCATE trigger(s) in pg_trigger`,
      );
    }

    // Prove one of them actually FIRES, rather than trusting the catalogue. The effort log is
    // the cheapest: it needs a participant, which needs a user, and nothing else.
    const [anyUser] = (await client.query<{ id: string }>(`SELECT id FROM "user" LIMIT 1`)).rows;
    if (anyUser) {
      const [participant] = (
        await client.query<{ id: string }>(
          `INSERT INTO research_program_participant
             (id, program_id, user_id, role, compensation_preference)
           VALUES ($3, $1, $2, 'researcher', 'equity') RETURNING id`,
          [programId, anyUser.id, newId()],
        )
      ).rows;

      if (participant) {
        const [effortLog] = (
          await client.query<{ id: string }>(
            `INSERT INTO research_effort_log
               (id, program_id, participant_id, minutes, logged_for_date, note, idempotency_key)
             VALUES ($4, $1, $2, 60, CURRENT_DATE, 'Proving the append-only trigger fires.', $3)
             RETURNING id`,
            [programId, participant.id, `verify-effort-${suffix}`, newId()],
          )
        ).rows;

        if (effortLog) {
          await expectRefused(
            "UPDATING a research_effort_log row is refused by the trigger (QT001)",
            QATOTO_APPEND_ONLY_VIOLATION,
            `UPDATE research_effort_log SET minutes = 999 WHERE id = $1`,
            [effortLog.id],
          );
          await expectRefused(
            "DELETING a research_effort_log row is refused by the trigger (QT001)",
            QATOTO_APPEND_ONLY_VIOLATION,
            `DELETE FROM research_effort_log WHERE id = $1`,
            [effortLog.id],
          );
        }
      }
    } else {
      console.log("  -- skipped the live trigger probe: no user rows to attribute a log to.");
    }

    console.log("\n--- 5. Partial unique indexes ---");

    const partialIndexRows = (
      await client.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
         WHERE tablename IN ('research_program_paper', 'research_program_content_report')
           AND indexdef LIKE '%WHERE%'`,
      )
    ).rows;
    const partialIndexNames = new Set(partialIndexRows.map((row) => row.indexname));

    for (const expectedIndex of [
      "research_program_paper_doi_unq",
      "research_program_paper_content_unq",
      "research_program_content_report_post_unq",
      "research_program_content_report_paper_unq",
    ]) {
      check(
        `${expectedIndex} exists and is PARTIAL`,
        partialIndexNames.has(expectedIndex),
        partialIndexNames.has(expectedIndex) ? "present with a WHERE clause" : "MISSING",
      );
    }

    console.log("\n--- 6. research_program_stat_snapshot CHECKs ---");

    await expectRefused(
      "openGapCount above branchCount is refused (stat_snapshot_counts_ck)",
      PG_CHECK_VIOLATION,
      `INSERT INTO research_program_stat_snapshot
         (id, program_id, as_of, participant_count, paper_count, branch_count, post_count,
          open_gap_count, overlap_flag_count, total_effort_minutes)
       VALUES ($2, $1, now(), 0, 0, 3, 0, 4, 0, 0)`,
      [programId, newId()],
    );

    await expectRefused(
      "a negative effort total is refused (stat_snapshot_counts_ck)",
      PG_CHECK_VIOLATION,
      `INSERT INTO research_program_stat_snapshot
         (id, program_id, as_of, participant_count, paper_count, branch_count, post_count,
          open_gap_count, overlap_flag_count, total_effort_minutes)
       VALUES ($2, $1, now(), 0, 0, 0, 0, 0, 0, -1)`,
      [programId, newId()],
    );

    console.log("\n--- 7. research_contribution_ledger_entry: the money CHECK ---");

    await expectRefused(
      "a non-cash contribution carrying an amount is refused (contribution_amount_ck)",
      PG_CHECK_VIOLATION,
      `INSERT INTO research_contribution_ledger_entry
         (id, program_id, participant_id, kind, amount_in_cents, currency_code, description, idempotency_key)
       SELECT $3, $1, id, 'material', 50000, 'USD', 'Materials do not carry an amount.', $2
       FROM research_program_participant WHERE program_id = $1 LIMIT 1`,
      [programId, `verify-contrib-${suffix}`, newId()],
    );

    await expectRefused(
      "a cash commitment with no currency is refused (contribution_amount_ck)",
      PG_CHECK_VIOLATION,
      `INSERT INTO research_contribution_ledger_entry
         (id, program_id, participant_id, kind, amount_in_cents, currency_code, description, idempotency_key)
       SELECT $3, $1, id, 'cash_commitment', 50000, NULL, 'An amount never travels without a currency.', $2
       FROM research_program_participant WHERE program_id = $1 LIMIT 1`,
      [programId, `verify-contrib2-${suffix}`, newId()],
    );
  } finally {
    // THE ROLLBACK IS THE CLEANUP, and it cannot be skipped by a failed assertion or a throw.
    await client.query("ROLLBACK");
    client.release();
    console.log("\n  (transaction rolled back — nothing was persisted)");
  }

  const failureCount = assertions.filter((assertion) => !assertion.passed).length;
  console.log(
    failureCount === 0
      ? `\nAll ${String(assertions.length)} research-program constraint assertions passed.`
      : `\n${String(failureCount)} of ${String(assertions.length)} research-program constraint assertions FAILED.`,
  );
  if (failureCount > 0) process.exitCode = 1;
}

main()
  .then(async () => {
    await pool.end();
    return undefined;
  })
  .catch(async (error: unknown) => {
    console.error("Research program constraint verification failed to run:", error);
    await pool.end();
    process.exit(1);
  });
