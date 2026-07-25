/**
 * Verifies that migration 0016's DATABASE-LEVEL guarantees are actually in force
 * (R_AND_D_BACKEND_STRUCTURE.md §7, §17 steps 1 and 9).
 *
 * WHY THIS IS A SCRIPT AND NOT A TEST — the same reason
 * verify-proof-of-effort-constraints.ts is: the vitest suite mocks `#src/db/index.js`
 * wholesale, so it can prove things about TypeScript and nothing about Postgres. And §7
 * makes claims TypeScript cannot make at all:
 *
 *   "Service-layer discipline is not enforcement." (§7, "Append-only, enforced four ways")
 *   "The zero-sum invariant is a machine-checkable proof that no money was conjured." (§7)
 *
 * A service that declines to write an UPDATE is not the first claim. A service that adds
 * its postings up is not the second. The triggers are. And a hand-written trigger nobody
 * has watched fire is indistinguishable from an absent one, so every guarantee below is
 * EXERCISED against real rows rather than merely inspected in the catalog.
 *
 * THERE ARE POSITIVE CONTROLS, deliberately. A file that only ever asserts "this was
 * rejected" passes just as well against a database where EVERYTHING is rejected — which
 * is a broken deployment, not a safe one. The balanced-entry probe proves the zero-sum
 * trigger admits correct money as well as refusing incorrect money.
 *
 * Read-only in effect: every write happens inside a transaction that is always rolled
 * back.
 *
 *   pnpm db:verify-escrow-constraints
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

const EXPECTED_TABLES = [
  "funding_round",
  "funding_round_pledge",
  "escrow_account",
  "escrow_journal_entry",
  "escrow_posting",
  "provider_transfer",
  "provider_webhook_event",
  "reconciliation_discrepancy",
  "milestone",
  "milestone_variance",
  "escrow_release",
  "investor_confidence_snapshot",
] as const;

/**
 * Every §7 FK, with the `onDelete` §4f requires — the cascade sweep from §17 step 9,
 * expressed as data so adding a table without deciding its cascade policy fails here.
 *
 * `r` = RESTRICT, `c` = CASCADE, `n` = SET NULL (pg_constraint.confdeltype).
 *
 * §4f names this domain first and by name: two drafts wired
 * `user → research_project → milestone → escrow_release` as cascade, "which means
 * deleting one user account silently erases a financial ledger". There is NO `c` in this
 * list, and that absence is the policy.
 *
 * The four `n` rows are all on `escrow_journal_entry`'s link columns, and each is the
 * §7 rule stated at the column: deleting a milestone must never delete financial history,
 * so the history survives with a null pointer rather than vanishing with its parent.
 */
const EXPECTED_FK_ACTIONS: readonly {
  readonly table: string;
  readonly column: string;
  readonly action: "r" | "c" | "n";
  readonly why: string;
}[] = [
  { table: "funding_round", column: "project_id", action: "r", why: "financial" },
  { table: "funding_round", column: "created_by_user_id", action: "r", why: "financial" },
  { table: "funding_round_pledge", column: "round_id", action: "r", why: "financial" },
  { table: "funding_round_pledge", column: "project_id", action: "r", why: "financial" },
  { table: "funding_round_pledge", column: "backer_user_id", action: "r", why: "financial" },
  { table: "funding_round_pledge", column: "provider_transfer_id", action: "r", why: "financial" },
  { table: "escrow_account", column: "project_id", action: "r", why: "THE ledger" },
  { table: "escrow_journal_entry", column: "project_id", action: "r", why: "THE ledger" },
  // The four link columns. `set null` so a deleted milestone leaves the entry standing.
  { table: "escrow_journal_entry", column: "linked_milestone_id", action: "n", why: "§7 link" },
  { table: "escrow_journal_entry", column: "linked_pledge_id", action: "n", why: "§7 link" },
  { table: "escrow_journal_entry", column: "linked_release_id", action: "n", why: "§7 link" },
  { table: "escrow_journal_entry", column: "created_by_user_id", action: "n", why: "system actor" },
  {
    table: "escrow_journal_entry",
    column: "reverses_journal_entry_id",
    action: "r",
    why: "the ONLY correction mechanism",
  },
  { table: "escrow_posting", column: "journal_entry_id", action: "r", why: "THE ledger" },
  { table: "escrow_posting", column: "project_id", action: "r", why: "THE ledger" },
  { table: "escrow_posting", column: "account_id", action: "r", why: "THE ledger" },
  { table: "provider_transfer", column: "project_id", action: "r", why: "financial" },
  {
    table: "provider_transfer",
    column: "settlement_decided_by_user_id",
    action: "n",
    why: "auditor may be deleted; the settlement may not",
  },
  { table: "provider_webhook_event", column: "project_id", action: "r", why: "evidence" },
  { table: "provider_webhook_event", column: "provider_transfer_id", action: "r", why: "evidence" },
  { table: "reconciliation_discrepancy", column: "project_id", action: "r", why: "audit" },
  { table: "reconciliation_discrepancy", column: "journal_entry_id", action: "r", why: "audit" },
  { table: "milestone", column: "project_id", action: "r", why: "financial" },
  { table: "milestone", column: "created_by_user_id", action: "r", why: "financial" },
  { table: "milestone_variance", column: "milestone_id", action: "r", why: "financial" },
  { table: "milestone_variance", column: "project_id", action: "r", why: "financial" },
  { table: "escrow_release", column: "project_id", action: "r", why: "THE payout" },
  { table: "escrow_release", column: "milestone_id", action: "r", why: "THE payout" },
  { table: "escrow_release", column: "requested_by_user_id", action: "r", why: "four eyes" },
  { table: "escrow_release", column: "decided_by_user_id", action: "r", why: "four eyes" },
  { table: "escrow_release", column: "journal_entry_id", action: "r", why: "THE payout" },
  { table: "escrow_release", column: "provider_transfer_id", action: "r", why: "THE payout" },
  { table: "investor_confidence_snapshot", column: "project_id", action: "r", why: "signal" },
];

/** The triggers that carry §7's "enforced four ways" claim. */
const EXPECTED_TRIGGERS: readonly { readonly table: string; readonly trigger: string }[] = [
  { table: "escrow_journal_entry", trigger: "escrow_journal_entry_append_only" },
  { table: "escrow_journal_entry", trigger: "escrow_journal_entry_no_truncate" },
  { table: "escrow_posting", trigger: "escrow_posting_append_only" },
  { table: "escrow_posting", trigger: "escrow_posting_no_truncate" },
  { table: "escrow_posting", trigger: "escrow_posting_zero_sum" },
  { table: "provider_webhook_event", trigger: "provider_webhook_event_process_only" },
  { table: "provider_webhook_event", trigger: "provider_webhook_event_no_delete" },
  { table: "provider_webhook_event", trigger: "provider_webhook_event_no_truncate" },
  { table: "escrow_release", trigger: "escrow_release_decide_only" },
  { table: "escrow_release", trigger: "escrow_release_no_delete" },
  { table: "escrow_release", trigger: "escrow_release_no_truncate" },
  { table: "provider_transfer", trigger: "provider_transfer_identity_frozen" },
  { table: "provider_transfer", trigger: "provider_transfer_no_delete" },
  { table: "provider_transfer", trigger: "provider_transfer_no_truncate" },
];

/** The unique and partial indexes that are load-bearing rather than decorative. */
const EXPECTED_INDEXES = [
  "escrow_journal_entry_project_seq_unq",
  "escrow_posting_entry_index_unq",
  "escrow_account_projectId_kind_unq",
  "provider_transfer_idempotencyKey_unq",
  "provider_webhook_event_provider_eventId_unq",
  "funding_round_pledge_providerTransferId_unq",
  "escrow_release_milestone_requested_unq",
  "escrow_release_milestone_approved_unq",
  "milestone_projectId_orderIndex_unq",
  "reconciliation_discrepancy_project_account_asOf_unq",
  "investor_confidence_snapshot_project_asOf_unq",
] as const;

/** The CHECK constraints that encode a rule rather than a range. */
const EXPECTED_CHECKS = [
  "escrow_journal_entry_link_ck",
  "escrow_journal_entry_hash_ck",
  "escrow_journal_entry_reversal_ck",
  "escrow_posting_amount_ck",
  "escrow_release_four_eyes_ck",
  "escrow_release_decision_ck",
  "escrow_release_journal_ck",
  "funding_round_pledge_amounts_ck",
  "funding_round_bounds_ck",
  "provider_transfer_destination_ck",
  "reconciliation_discrepancy_delta_ck",
  "milestone_completed_at_ck",
  "project_member_role_granted_by_ck",
] as const;

const CHECK_VIOLATION_SQLSTATE = "23514";
const UNIQUE_VIOLATION_SQLSTATE = "23505";
/** Migration 0010's custom SQLSTATE for an append-only violation. */
const APPEND_ONLY_SQLSTATE = "QT001";
/** Migration 0016's own, for a ledger entry whose postings do not sum to zero. */
const ZERO_SUM_SQLSTATE = "QT002";

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
    label: `all ${EXPECTED_TABLES.length} funding and escrow tables exist`,
    passed: tableCount === EXPECTED_TABLES.length,
    detail: `${tableCount}/${EXPECTED_TABLES.length}`,
  });

  const { rows: triggerRows } = await pool.query<{ table_name: string; trigger_name: string }>(
    `SELECT t.relname AS table_name, g.tgname AS trigger_name
       FROM pg_trigger g
       JOIN pg_class t ON t.oid = g.tgrelid
      WHERE NOT g.tgisinternal AND g.tgname = ANY($1)`,
    [EXPECTED_TRIGGERS.map((expected) => expected.trigger)],
  );
  const missingTriggers = EXPECTED_TRIGGERS.filter(
    (expected) =>
      !triggerRows.some(
        (row) => row.trigger_name === expected.trigger && row.table_name === expected.table,
      ),
  );
  outcomes.push({
    label: "every hand-written §7 trigger is attached to its table",
    passed: missingTriggers.length === 0,
    detail:
      missingTriggers.length === 0
        ? `${EXPECTED_TRIGGERS.length} checked`
        : `missing: ${missingTriggers.map((trigger) => trigger.trigger).join(", ")}`,
  });

  // The zero-sum trigger MUST be deferred. A non-deferred one fires after the first
  // posting insert, sees a one-sided entry, and rejects every correct entry ever written
  // — so "the constraint exists" is not the guarantee; "the constraint exists AND is
  // deferred" is.
  const deferredZeroSum = await countQuery(
    `SELECT count(*) AS n FROM pg_constraint
      WHERE conname = 'escrow_posting_zero_sum' AND condeferrable AND condeferred`,
  );
  outcomes.push({
    label: "the zero-sum trigger is DEFERRABLE INITIALLY DEFERRED",
    passed: deferredZeroSum === 1,
    detail:
      deferredZeroSum === 1
        ? "deferred to commit"
        : "NOT deferred — it would reject every correct entry",
  });

  const indexCount = await countQuery(
    `SELECT count(*) AS n FROM pg_class WHERE relkind = 'i' AND relname = ANY($1)`,
    [EXPECTED_INDEXES],
  );
  outcomes.push({
    label: "the load-bearing unique and partial indexes exist",
    passed: indexCount === EXPECTED_INDEXES.length,
    detail: `${indexCount}/${EXPECTED_INDEXES.length}`,
  });

  const checkCount = await countQuery(
    `SELECT count(*) AS n FROM pg_constraint WHERE contype = 'c' AND conname = ANY($1)`,
    [EXPECTED_CHECKS],
  );
  outcomes.push({
    label: "the §7 CHECK constraints are attached",
    passed: checkCount === EXPECTED_CHECKS.length,
    detail: `${checkCount}/${EXPECTED_CHECKS.length}`,
  });

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
    label: "every §7 foreign key has its §4f onDelete action",
    passed: mismatches.length === 0,
    detail:
      mismatches.length === 0
        ? `${EXPECTED_FK_ACTIONS.length} checked`
        : mismatches.map((fk) => `${fk.table}.${fk.column} (${fk.why})`).join(", "),
  });

  // Run against the CATALOG rather than the list above, so a table added later without
  // updating EXPECTED_FK_ACTIONS is still caught. §4f names exactly this failure.
  const strayCascades = fkRows.filter((row) => row.confdeltype === "c");
  outcomes.push({
    label: "no funding or escrow table has a cascading foreign key",
    passed: strayCascades.length === 0,
    detail:
      strayCascades.length === 0
        ? `${EXPECTED_TABLES.length} tables swept`
        : strayCascades.map((fk) => `${fk.table_name}.${fk.column_name}`).join(", "),
  });

  return outcomes;
}

interface Fixtures {
  readonly projectId: string;
  readonly userId: string;
  readonly otherUserId: string;
  readonly roundId: string;
  readonly milestoneId: string;
  /** A SECOND milestone. The re-point probe needs somewhere else to point. */
  readonly otherMilestoneId: string;
  readonly heldAccountId: string;
  readonly clearingAccountId: string;
  readonly entryId: string;
  readonly transferId: string;
  readonly releaseId: string;
}

/**
 * Written as `PoolClient` rather than `Awaited<ReturnType<typeof pool.connect>>`: pg
 * declares `connect` with a callback overload, so `ReturnType` resolves to the LAST
 * signature and yields `void`.
 */
type TransactionClient = PoolClient;

/**
 * Records the outcome of a probe that MUST be rejected by the database.
 *
 * The success branch is the failure: if the statement went through, the guarantee is not
 * in force no matter what the catalog says.
 */
async function expectRejection(
  client: TransactionClient,
  outcomes: CheckOutcome[],
  label: string,
  expectedSqlState: string,
  statement: () => Promise<unknown>,
): Promise<void> {
  const savepoint = `probe_${outcomes.length}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    await statement();
    outcomes.push({ label, passed: false, detail: "the statement SUCCEEDED" });
  } catch (error) {
    const sqlState = sqlStateOf(error);
    outcomes.push({
      label,
      passed: sqlState === expectedSqlState,
      detail: `SQLSTATE ${sqlState ?? "unknown"} (expected ${expectedSqlState})`,
    });
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
}

/**
 * THE POSITIVE CONTROL. A guard that rejects everything is not a guard, it is an outage,
 * and a file full of `expectRejection` cannot tell the two apart.
 */
async function expectAcceptance(
  client: TransactionClient,
  outcomes: CheckOutcome[],
  label: string,
  statement: () => Promise<unknown>,
): Promise<void> {
  const savepoint = `probe_${outcomes.length}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    await statement();
    outcomes.push({ label, passed: true, detail: "accepted, as it must be" });
  } catch (error) {
    outcomes.push({
      label,
      passed: false,
      detail: `REJECTED with ${sqlStateOf(error) ?? "unknown"} — correct money was refused`,
    });
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
}

/** Appends one balanced entry with two postings. Returns the entry id. */
async function insertBalancedEntry(
  client: TransactionClient,
  fixtures: Pick<Fixtures, "projectId" | "heldAccountId" | "clearingAccountId">,
  options: {
    readonly entryId: string;
    readonly sequenceNumber: number;
    readonly previousEntryHash: string;
    readonly amountInCents: number;
    readonly settlement?: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO escrow_journal_entry
       (id, project_id, sequence_number, kind, description, currency, occurred_at,
        settlement, entry_hash, previous_entry_hash)
     VALUES ($1, $2, $3, 'pledge_authorized', 'Probe entry', 'USD', now(), $4, $5, $6)`,
    [
      options.entryId,
      fixtures.projectId,
      options.sequenceNumber,
      options.settlement ?? "pending",
      "a".repeat(64),
      options.previousEntryHash,
    ],
  );
  await client.query(
    `INSERT INTO escrow_posting
       (id, journal_entry_id, project_id, account_id, account_kind, signed_amount_in_cents,
        posting_index)
     VALUES ($1, $2, $3, $4, 'provider_clearing', $5, 0),
            ($6, $2, $3, $7, 'escrow_held', $8, 1)`,
    [
      `${options.entryId}-p0`,
      options.entryId,
      fixtures.projectId,
      fixtures.clearingAccountId,
      -options.amountInCents,
      `${options.entryId}-p1`,
      fixtures.heldAccountId,
      options.amountInCents,
    ],
  );
}

async function insertFixtures(client: TransactionClient): Promise<Fixtures | null> {
  const [category] = (
    await client.query<{ id: string }>(
      `SELECT id FROM research_category WHERE status = 'approved' LIMIT 1`,
    )
  ).rows;
  if (!category) return null;

  const userId = "verify-escrow-user";
  const otherUserId = "verify-escrow-approver";
  const projectId = "verify-escrow-project";
  const roundId = "verify-escrow-round";
  const milestoneId = "verify-escrow-milestone";
  const otherMilestoneId = "verify-escrow-milestone-other";
  const heldAccountId = "verify-escrow-account-held";
  const clearingAccountId = "verify-escrow-account-clearing";
  const entryId = "verify-escrow-entry";
  const transferId = "verify-escrow-transfer";
  const releaseId = "verify-escrow-release";

  await client.query(
    `INSERT INTO "user" (id, name, email, email_verified)
     VALUES ($1, 'Escrow Fixture', $2, true), ($3, 'Escrow Approver', $4, true)`,
    [userId, `${userId}@example.test`, otherUserId, `${otherUserId}@example.test`],
  );
  await client.query(
    `INSERT INTO research_project (id, slug, founder_user_id, name, tagline, category_id)
     VALUES ($1, 'verify-escrow-project', $2, 'Verify', 'Escrow probe fixture', $3)`,
    [projectId, userId, category.id],
  );
  await client.query(
    `INSERT INTO project_member (id, project_id, user_id, project_role)
     VALUES ('verify-escrow-member', $1, $2, 'founder')`,
    [projectId, userId],
  );
  await client.query(
    `INSERT INTO funding_round
       (id, project_id, type, status, goal_amount_in_cents, currency, title, created_by_user_id)
     VALUES ($1, $2, 'crowdfunding', 'draft', 500000, 'USD', 'Probe round', $3)`,
    [roundId, projectId, userId],
  );
  await client.query(
    `INSERT INTO escrow_account (id, project_id, kind, currency)
     VALUES ($1, $2, 'escrow_held', 'USD'), ($3, $2, 'provider_clearing', 'USD')`,
    [heldAccountId, projectId, clearingAccountId],
  );
  await client.query(
    `INSERT INTO milestone
       (id, project_id, title, status, planned_payout_in_cents, currency, order_index,
        created_by_user_id, completed_at)
     VALUES ($1, $2, 'Probe milestone', 'done', 250000, 'USD', 0, $3, now()),
            ($4, $2, 'Probe milestone two', 'planned', 900000, 'USD', 1, $3, NULL)`,
    [milestoneId, projectId, userId, otherMilestoneId],
  );
  await client.query(
    `INSERT INTO provider_transfer
       (id, project_id, direction, status, amount_in_cents, currency, idempotency_key)
     VALUES ($1, $2, 'inbound', 'created', 500000, 'USD', 'verify-escrow-key-1')`,
    [transferId, projectId],
  );

  // Genesis entry, sequence 1. Balanced, so the deferred trigger is satisfied at commit
  // even though this transaction never reaches one.
  await insertBalancedEntry(
    client,
    { projectId, heldAccountId, clearingAccountId },
    { entryId, sequenceNumber: 1, previousEntryHash: "genesis", amountInCents: 500000 },
  );

  await client.query(
    `INSERT INTO escrow_release
       (id, project_id, milestone_id, amount_in_cents, currency, status, requested_by_user_id)
     VALUES ($1, $2, $3, 250000, 'USD', 'requested', $4)`,
    [releaseId, projectId, milestoneId, userId],
  );

  return {
    projectId,
    userId,
    otherUserId,
    roundId,
    milestoneId,
    otherMilestoneId,
    heldAccountId,
    clearingAccountId,
    entryId,
    transferId,
    releaseId,
  };
}

/**
 * The TRUNCATE guards, in a transaction that has written NOTHING.
 *
 * These cannot share the fixture transaction, and the reason is worth writing down
 * because the first version of this file got it wrong and looked like it passed until the
 * SQLSTATE was read: Postgres refuses `TRUNCATE` with **55006 object_in_use** when the
 * current session has already touched the table, before any trigger runs. The probe then
 * proves that the fixtures exist — not that the guard does. A statement blocked for the
 * wrong reason is indistinguishable from a guard that works, which is the exact class of
 * false confidence this whole script exists to remove.
 *
 * Run first, on a clean transaction, so the ONLY thing that can reject a TRUNCATE is
 * `qatoto_reject_mutation()`. A `BEFORE UPDATE OR DELETE` row trigger does not fire on
 * TRUNCATE at all, so without these four statement triggers the entire ledger is one
 * command away from empty.
 */
async function checkTruncateGuards(): Promise<readonly CheckOutcome[]> {
  const client = await pool.connect();
  const outcomes: CheckOutcome[] = [];

  try {
    await client.query("BEGIN");

    for (const tableName of [
      "escrow_journal_entry",
      "escrow_posting",
      "escrow_release",
      "provider_transfer",
      "provider_webhook_event",
    ]) {
      await expectRejection(
        client,
        outcomes,
        `${tableName} cannot be TRUNCATEd`,
        APPEND_ONLY_SQLSTATE,
        // CASCADE, not RESTRICT: an attacker emptying a ledger would use CASCADE, and a
        // probe that only tests the easier form tests the wrong thing.
        () => client.query(`TRUNCATE TABLE "${tableName}" CASCADE`),
      );
    }

    return outcomes;
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

/**
 * Exercises every hand-written guarantee against real rows.
 *
 * Fixtures are created inside the transaction this function always rolls back — probing
 * whatever project happens to exist would make the result depend on the database's
 * contents, and this must pass on an empty one, which is exactly the state a fresh deploy
 * is in when someone wants to know whether 0016 landed.
 */
async function checkRuntimeGuarantees(): Promise<readonly CheckOutcome[]> {
  const client = await pool.connect();
  const outcomes: CheckOutcome[] = [];

  try {
    await client.query("BEGIN");

    const fixtures = await insertFixtures(client);
    if (!fixtures) {
      return [
        {
          label: "runtime probes",
          passed: false,
          detail: "no approved category — run `pnpm db:seed-research-categories` first",
        },
      ];
    }

    // --- 1. THE LEDGER IS APPEND-ONLY (§7 enforcement 2). Four verbs, four refusals.

    await expectRejection(
      client,
      outcomes,
      "a journal entry cannot be UPDATEd — not even its settlement",
      APPEND_ONLY_SQLSTATE,
      () =>
        client.query(`UPDATE escrow_journal_entry SET settlement = 'settled' WHERE id = $1`, [
          fixtures.entryId,
        ]),
    );

    await expectRejection(
      client,
      outcomes,
      "a journal entry cannot be DELETEd",
      APPEND_ONLY_SQLSTATE,
      () => client.query(`DELETE FROM escrow_journal_entry WHERE id = $1`, [fixtures.entryId]),
    );

    await expectRejection(
      client,
      outcomes,
      "a posting's amount cannot be UPDATEd",
      APPEND_ONLY_SQLSTATE,
      () =>
        client.query(
          `UPDATE escrow_posting SET signed_amount_in_cents = 999999 WHERE journal_entry_id = $1`,
          [fixtures.entryId],
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "a posting cannot be DELETEd",
      APPEND_ONLY_SQLSTATE,
      () =>
        client.query(`DELETE FROM escrow_posting WHERE journal_entry_id = $1`, [fixtures.entryId]),
    );

    // (The TRUNCATE probes cannot live here — see checkTruncateGuards below.)

    // --- 2. THE ZERO-SUM INVARIANT (§7, "no money was conjured").
    //
    // `SET CONSTRAINTS … IMMEDIATE` forces the deferred trigger to run NOW rather than at
    // a commit this transaction never reaches. That is the only way to exercise a
    // deferred constraint inside a rolled-back probe.

    await expectRejection(
      client,
      outcomes,
      "an entry whose postings do not sum to zero is rejected",
      ZERO_SUM_SQLSTATE,
      async () => {
        await client.query(
          `INSERT INTO escrow_journal_entry
             (id, project_id, sequence_number, kind, description, currency, occurred_at,
              entry_hash, previous_entry_hash)
           VALUES ('verify-escrow-unbalanced', $1, 2, 'pledge_authorized', 'Conjured money',
                   'USD', now(), $2, $3)`,
          [fixtures.projectId, "b".repeat(64), "a".repeat(64)],
        );
        await client.query(
          `INSERT INTO escrow_posting
             (id, journal_entry_id, project_id, account_id, account_kind,
              signed_amount_in_cents, posting_index)
           VALUES ('verify-escrow-unbalanced-p0', 'verify-escrow-unbalanced', $1, $2,
                   'provider_clearing', -100000, 0),
                  ('verify-escrow-unbalanced-p1', 'verify-escrow-unbalanced', $1, $3,
                   'escrow_held', 100001, 1)`,
          [fixtures.projectId, fixtures.clearingAccountId, fixtures.heldAccountId],
        );
        return client.query(`SET CONSTRAINTS escrow_posting_zero_sum IMMEDIATE`);
      },
    );

    await expectRejection(
      client,
      outcomes,
      "a single-sided entry is rejected — double entry needs two postings",
      ZERO_SUM_SQLSTATE,
      async () => {
        await client.query(
          `INSERT INTO escrow_journal_entry
             (id, project_id, sequence_number, kind, description, currency, occurred_at,
              entry_hash, previous_entry_hash)
           VALUES ('verify-escrow-onesided', $1, 3, 'pledge_authorized', 'One-sided',
                   'USD', now(), $2, $3)`,
          [fixtures.projectId, "c".repeat(64), "a".repeat(64)],
        );
        await client.query(
          `INSERT INTO escrow_posting
             (id, journal_entry_id, project_id, account_id, account_kind,
              signed_amount_in_cents, posting_index)
           VALUES ('verify-escrow-onesided-p0', 'verify-escrow-onesided', $1, $2,
                   'escrow_held', 100000, 0)`,
          [fixtures.projectId, fixtures.heldAccountId],
        );
        return client.query(`SET CONSTRAINTS escrow_posting_zero_sum IMMEDIATE`);
      },
    );

    // THE POSITIVE CONTROL. Everything above proves the trigger refuses; this proves it
    // does not refuse everything, which is the failure mode a rejection-only suite hides.
    await expectAcceptance(
      client,
      outcomes,
      "a BALANCED entry is accepted (positive control)",
      async () => {
        await insertBalancedEntry(client, fixtures, {
          entryId: "verify-escrow-balanced",
          sequenceNumber: 4,
          previousEntryHash: "a".repeat(64),
          amountInCents: 123456,
        });
        return client.query(`SET CONSTRAINTS escrow_posting_zero_sum IMMEDIATE`);
      },
    );

    await expectRejection(
      client,
      outcomes,
      "a zero-amount posting is rejected — every posting moves something",
      CHECK_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `INSERT INTO escrow_posting
             (id, journal_entry_id, project_id, account_id, account_kind,
              signed_amount_in_cents, posting_index)
           VALUES ('verify-escrow-zero', $1, $2, $3, 'escrow_held', 0, 9)`,
          [fixtures.entryId, fixtures.projectId, fixtures.heldAccountId],
        ),
    );

    // --- 3. THE CHAIN (§7). A gap or a reorder must be impossible to write, not merely
    // --- detectable afterwards.

    await expectRejection(
      client,
      outcomes,
      "two entries cannot share a sequence number",
      UNIQUE_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `INSERT INTO escrow_journal_entry
             (id, project_id, sequence_number, kind, description, currency, occurred_at,
              entry_hash, previous_entry_hash)
           VALUES ('verify-escrow-dup-seq', $1, 1, 'pledge_authorized', 'Duplicate sequence',
                   'USD', now(), $2, 'genesis')`,
          [fixtures.projectId, "d".repeat(64)],
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "only sequence 1 may claim the genesis predecessor",
      CHECK_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `INSERT INTO escrow_journal_entry
             (id, project_id, sequence_number, kind, description, currency, occurred_at,
              entry_hash, previous_entry_hash)
           VALUES ('verify-escrow-false-genesis', $1, 5, 'pledge_authorized', 'False genesis',
                   'USD', now(), $2, 'genesis')`,
          [fixtures.projectId, "e".repeat(64)],
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "a truncated 6-character hash cannot be stored as an entry hash",
      CHECK_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `INSERT INTO escrow_journal_entry
             (id, project_id, sequence_number, kind, description, currency, occurred_at,
              entry_hash, previous_entry_hash)
           VALUES ('verify-escrow-short-hash', $1, 6, 'pledge_authorized', 'Short hash',
                   'USD', now(), 'c7d9a1', $2)`,
          [fixtures.projectId, "a".repeat(64)],
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "a reversal must name the entry it reverses",
      CHECK_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `INSERT INTO escrow_journal_entry
             (id, project_id, sequence_number, kind, description, currency, occurred_at,
              entry_hash, previous_entry_hash)
           VALUES ('verify-escrow-orphan-reversal', $1, 7, 'reversal', 'Reverses nothing',
                   'USD', now(), $2, $3)`,
          [fixtures.projectId, "f".repeat(64), "a".repeat(64)],
        ),
    );

    // --- 4. THE FOUR-EYES RULE (§7). The rule the whole release surface exists for.

    await expectRejection(
      client,
      outcomes,
      "a release cannot be approved by the person who requested it",
      CHECK_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `UPDATE escrow_release
              SET status = 'approved', decided_by_user_id = requested_by_user_id,
                  decided_at = now(), verification_snapshot = '{}', journal_entry_id = $2
            WHERE id = $1`,
          [fixtures.releaseId, fixtures.entryId],
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "an approval that recorded no evidence is rejected",
      CHECK_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `UPDATE escrow_release
              SET status = 'approved', decided_by_user_id = $2, decided_at = now(),
                  journal_entry_id = $3
            WHERE id = $1`,
          [fixtures.releaseId, fixtures.otherUserId, fixtures.entryId],
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "an approval that posted no journal entry is rejected",
      CHECK_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `UPDATE escrow_release
              SET status = 'approved', decided_by_user_id = $2, decided_at = now(),
                  verification_snapshot = '{}'
            WHERE id = $1`,
          [fixtures.releaseId, fixtures.otherUserId],
        ),
    );

    // --- 5. THE SNAPSHOT (§7). The reason a release carries no amount field at all.

    await expectRejection(
      client,
      outcomes,
      "the snapshotted release amount cannot be edited after the request",
      APPEND_ONLY_SQLSTATE,
      () =>
        client.query(`UPDATE escrow_release SET amount_in_cents = 9900000 WHERE id = $1`, [
          fixtures.releaseId,
        ]),
    );

    await expectRejection(
      client,
      outcomes,
      "a release cannot be re-pointed at another milestone",
      APPEND_ONLY_SQLSTATE,
      () =>
        client.query(`UPDATE escrow_release SET milestone_id = $2 WHERE id = $1`, [
          fixtures.releaseId,
          // A DIFFERENT milestone — one worth 900,000 rather than 250,000. Re-pointing a
          // requested release at a richer milestone is the snapshot bypass §7 describes,
          // taking the long way round.
          fixtures.otherMilestoneId,
        ]),
    );

    await expectRejection(
      client,
      outcomes,
      "a release cannot be DELETEd",
      APPEND_ONLY_SQLSTATE,
      () => client.query(`DELETE FROM escrow_release WHERE id = $1`, [fixtures.releaseId]),
    );

    await expectRejection(
      client,
      outcomes,
      "one milestone cannot carry two open release requests",
      UNIQUE_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `INSERT INTO escrow_release
             (id, project_id, milestone_id, amount_in_cents, currency, status,
              requested_by_user_id)
           VALUES ('verify-escrow-release-2', $1, $2, 250000, 'USD', 'requested', $3)`,
          [fixtures.projectId, fixtures.milestoneId, fixtures.userId],
        ),
    );

    // The double-payout bug, expressed as a row. Approve the fixture properly first, then
    // try to approve a second release on the same milestone.
    await client.query(
      `UPDATE escrow_release
          SET status = 'approved', decided_by_user_id = $2, decided_at = now(),
              verification_snapshot = '{"probe":true}', journal_entry_id = $3
        WHERE id = $1`,
      [fixtures.releaseId, fixtures.otherUserId, fixtures.entryId],
    );
    await expectRejection(
      client,
      outcomes,
      "one milestone cannot be paid out twice",
      UNIQUE_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `INSERT INTO escrow_release
             (id, project_id, milestone_id, amount_in_cents, currency, status,
              requested_by_user_id, decided_by_user_id, decided_at, verification_snapshot,
              journal_entry_id)
           VALUES ('verify-escrow-release-3', $1, $2, 250000, 'USD', 'approved', $3, $4, now(),
                   '{}', $5)`,
          [
            fixtures.projectId,
            fixtures.milestoneId,
            fixtures.userId,
            fixtures.otherUserId,
            fixtures.entryId,
          ],
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "a decided release is immutable",
      APPEND_ONLY_SQLSTATE,
      () =>
        client.query(`UPDATE escrow_release SET decision_note = 'changed my mind' WHERE id = $1`, [
          fixtures.releaseId,
        ]),
    );

    // --- 6. THE PROVIDER TRANSFER (§7). Our idempotency key, our amount, our decision.

    await expectRejection(
      client,
      outcomes,
      "a transfer's idempotency key cannot be edited",
      APPEND_ONLY_SQLSTATE,
      () =>
        client.query(`UPDATE provider_transfer SET idempotency_key = 'rewritten' WHERE id = $1`, [
          fixtures.transferId,
        ]),
    );

    await expectRejection(
      client,
      outcomes,
      "a transfer's amount cannot be edited after it is created",
      APPEND_ONLY_SQLSTATE,
      () =>
        client.query(`UPDATE provider_transfer SET amount_in_cents = 1 WHERE id = $1`, [
          fixtures.transferId,
        ]),
    );

    await expectRejection(
      client,
      outcomes,
      "two transfers cannot share an idempotency key",
      UNIQUE_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `INSERT INTO provider_transfer
             (id, project_id, direction, status, amount_in_cents, currency, idempotency_key)
           VALUES ('verify-escrow-transfer-2', $1, 'inbound', 'created', 500000, 'USD',
                   'verify-escrow-key-1')`,
          [fixtures.projectId],
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "an inbound transfer cannot name a payout destination",
      CHECK_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `INSERT INTO provider_transfer
             (id, project_id, direction, status, amount_in_cents, currency, idempotency_key,
              payout_destination_id)
           VALUES ('verify-escrow-transfer-3', $1, 'inbound', 'created', 500000, 'USD',
                   'verify-escrow-key-2', 'acct_attacker')`,
          [fixtures.projectId],
        ),
    );

    // Settlement is terminal. A transfer that can be re-settled is a pledge that can be
    // counted twice, which is the single worst bug this domain has.
    await client.query(
      `UPDATE provider_transfer
          SET status = 'settled', submitted_at = now(), settled_at = now()
        WHERE id = $1`,
      [fixtures.transferId],
    );
    await expectRejection(
      client,
      outcomes,
      "a settled transfer cannot be moved back to submitted",
      APPEND_ONLY_SQLSTATE,
      () =>
        client.query(`UPDATE provider_transfer SET status = 'submitted' WHERE id = $1`, [
          fixtures.transferId,
        ]),
    );

    // --- 7. THE WEBHOOK DEDUPE (§7). The constraint that makes a replay a no-op.

    await client.query(
      `INSERT INTO provider_webhook_event
         (id, provider, provider_event_id, event_type, project_id, provider_transfer_id,
          payload_json)
       VALUES ('verify-escrow-event', 'internal_adapter', 'evt_probe_1', 'transfer.settled',
               $1, $2, '{"probe":true}')`,
      [fixtures.projectId, fixtures.transferId],
    );
    await expectRejection(
      client,
      outcomes,
      "a replayed provider event collides instead of processing twice",
      UNIQUE_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `INSERT INTO provider_webhook_event
             (id, provider, provider_event_id, event_type, payload_json)
           VALUES ('verify-escrow-event-2', 'internal_adapter', 'evt_probe_1',
                   'transfer.settled', '{"probe":true}')`,
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "a stored provider payload cannot be rewritten",
      APPEND_ONLY_SQLSTATE,
      () =>
        client.query(
          `UPDATE provider_webhook_event SET payload_json = '{"forged":true}' WHERE id = $1`,
          ["verify-escrow-event"],
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "a provider event cannot be DELETEd",
      APPEND_ONLY_SQLSTATE,
      () =>
        client.query(`DELETE FROM provider_webhook_event WHERE id = $1`, ["verify-escrow-event"]),
    );

    // Marking one processed is the ONE legitimate update, and it must still work.
    await expectAcceptance(
      client,
      outcomes,
      "a provider event can still be marked processed (positive control)",
      () =>
        client.query(`UPDATE provider_webhook_event SET processed_at = now() WHERE id = $1`, [
          "verify-escrow-event",
        ]),
    );

    // --- 8. THE MONEY ARITHMETIC. Constraints that catch a wrong number, not a wrong verb.

    await expectRejection(
      client,
      outcomes,
      "a pledge whose net does not equal amount minus fee is rejected",
      CHECK_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `INSERT INTO funding_round_pledge
             (id, round_id, project_id, backer_user_id, amount_in_cents, platform_fee_in_cents,
              net_to_escrow_in_cents, currency)
           VALUES ('verify-escrow-pledge-bad', $1, $2, $3, 500000, 25000, 500000, 'USD')`,
          [fixtures.roundId, fixtures.projectId, fixtures.userId],
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "a fee larger than the pledge is rejected",
      CHECK_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `INSERT INTO funding_round_pledge
             (id, round_id, project_id, backer_user_id, amount_in_cents, platform_fee_in_cents,
              net_to_escrow_in_cents, currency)
           VALUES ('verify-escrow-pledge-fee', $1, $2, $3, 1000, 2000, -1000, 'USD')`,
          [fixtures.roundId, fixtures.projectId, fixtures.userId],
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "a round whose maximum pledge is below its minimum is rejected",
      CHECK_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `UPDATE funding_round SET minimum_pledge_in_cents = 5000,
                                    maximum_pledge_in_cents = 100
            WHERE id = $1`,
          [fixtures.roundId],
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "a milestone marked done without a completion instant is rejected",
      CHECK_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `INSERT INTO milestone
             (id, project_id, title, status, planned_payout_in_cents, currency,
              order_index, created_by_user_id)
           VALUES ('verify-escrow-milestone-2', $1, 'Undated', 'done', 1000, 'USD', 1, $2)`,
          [fixtures.projectId, fixtures.userId],
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "a reconciliation delta that does not equal provider minus ledger is rejected",
      CHECK_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `INSERT INTO reconciliation_discrepancy
             (id, project_id, account_kind, as_of, ledger_balance_in_cents,
              provider_balance_in_cents, delta_in_cents)
           VALUES ('verify-escrow-discrepancy', $1, 'escrow_held', now(), 1000, 1500, 900)`,
          [fixtures.projectId],
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "a project cannot hold two accounts of the same kind",
      UNIQUE_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `INSERT INTO escrow_account (id, project_id, kind, currency)
           VALUES ('verify-escrow-account-dup', $1, 'escrow_held', 'USD')`,
          [fixtures.projectId],
        ),
    );

    // --- 9. THE SELF-GRANT (§4a, §7). The other half of the four-eyes rule: an admin who
    // --- granted themselves the role is not a second pair of eyes.

    await expectRejection(
      client,
      outcomes,
      "an admin cannot have granted themselves the role that co-signs a payout",
      CHECK_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `INSERT INTO project_member (id, project_id, user_id, project_role,
                                       role_granted_by_user_id)
           VALUES ('verify-escrow-self-admin', $1, $2, 'admin', $2)`,
          [fixtures.projectId, fixtures.otherUserId],
        ),
    );

    await expectAcceptance(
      client,
      outcomes,
      "an admin granted by SOMEONE ELSE is accepted (positive control)",
      () =>
        client.query(
          `INSERT INTO project_member (id, project_id, user_id, project_role,
                                       role_granted_by_user_id)
           VALUES ('verify-escrow-other-admin', $1, $2, 'admin', $3)`,
          [fixtures.projectId, fixtures.otherUserId, fixtures.userId],
        ),
    );

    return outcomes;
  } finally {
    // Always. Nothing this script writes is ever committed.
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

async function main(): Promise<void> {
  const outcomes = [
    ...(await checkSchemaObjects()),
    ...(await checkTruncateGuards()),
    ...(await checkRuntimeGuarantees()),
  ];

  for (const outcome of outcomes) {
    console.log(`${outcome.passed ? "PASS" : "FAIL"}  ${outcome.label} — ${outcome.detail}`);
  }

  const failureCount = outcomes.filter((outcome) => !outcome.passed).length;
  console.log(
    failureCount === 0
      ? `\nAll ${outcomes.length} funding and escrow guarantees verified.`
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
    console.error("Escrow constraint verification failed to run:", error);
    await pool.end();
    process.exit(1);
  });
