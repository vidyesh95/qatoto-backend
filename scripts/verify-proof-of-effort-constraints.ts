/**
 * Verifies that migration 0014's DATABASE-LEVEL guarantees are actually in force
 * (R_AND_D_BACKEND_STRUCTURE.md §9, §17 steps 1 and 8).
 *
 * WHY THIS IS A SCRIPT AND NOT A TEST — the same reason verify-workshop-constraints.ts
 * is: the vitest suite mocks `#src/db/index.js` wholesale, so it can prove things about
 * TypeScript and nothing about Postgres. And the strongest claim §9 makes is one
 * TypeScript cannot make at all:
 *
 *   "Formula output is never hand-edited by anyone — including staff, including the
 *    founder, including a DBA." (§9.1)
 *
 * A service that declines to write an UPDATE is not that guarantee. The trigger is. And a
 * hand-written trigger nobody has watched fire is indistinguishable from an absent one,
 * so every guarantee below is EXERCISED against real rows rather than merely inspected in
 * the catalog.
 *
 * Read-only in effect: every write happens inside a transaction that is always rolled
 * back.
 *
 *   pnpm db:verify-proof-of-effort-constraints
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
  "member_fair_market_rate",
  "effort_claim",
  "claim_verification_run",
  "verification_step",
  "artifact_evidence",
  "integration_consent_grant",
  "physical_work_receipt",
  "receipt_forensics_check",
  "slice_allocation_proposal",
  "dispute",
  "dispute_vote",
  "slice_ledger_entry",
  "project_chain_head",
  "project_audit_entry",
  "equity_snapshot",
  "equity_snapshot_share",
  "pie_bake_event",
  "optimization_suggestion",
  "optimization_suggestion_evidence",
] as const;

/**
 * Every §9 FK, with the `onDelete` §4f requires — the cascade sweep from §17 step 8,
 * expressed as data so adding a table without deciding its cascade policy fails here.
 *
 * `r` = RESTRICT, `c` = CASCADE, `n` = SET NULL (pg_constraint.confdeltype).
 *
 * The shape of this list IS the policy: financial and audit tables are `restrict`
 * everywhere, without exception, because deleting one user account must not be able to
 * erase a ledger. Only two rows are anything else, and both are derivatives.
 */
const EXPECTED_FK_ACTIONS: readonly {
  readonly table: string;
  readonly column: string;
  readonly action: "r" | "c" | "n";
  readonly why: string;
}[] = [
  { table: "member_fair_market_rate", column: "project_id", action: "r", why: "rate history" },
  { table: "member_fair_market_rate", column: "member_id", action: "r", why: "rate history" },
  { table: "effort_claim", column: "project_id", action: "r", why: "financial" },
  { table: "effort_claim", column: "member_id", action: "r", why: "financial" },
  { table: "effort_claim", column: "daily_log_id", action: "r", why: "evidence" },
  { table: "effort_claim", column: "fair_market_rate_id", action: "r", why: "pinned rate" },
  { table: "claim_verification_run", column: "claim_id", action: "r", why: "audit" },
  { table: "verification_step", column: "run_id", action: "r", why: "audit" },
  { table: "artifact_evidence", column: "project_id", action: "r", why: "evidence" },
  { table: "artifact_evidence", column: "claim_id", action: "r", why: "evidence" },
  // The one deliberate `set null` on an evidence row: revoking consent must not delete
  // the proof, and §9.10 says so explicitly.
  { table: "artifact_evidence", column: "consent_grant_id", action: "n", why: "§9.10 revocation" },
  { table: "integration_consent_grant", column: "project_id", action: "r", why: "consent" },
  { table: "integration_consent_grant", column: "member_id", action: "r", why: "consent" },
  { table: "physical_work_receipt", column: "project_id", action: "r", why: "evidence" },
  { table: "physical_work_receipt", column: "member_id", action: "r", why: "evidence" },
  { table: "physical_work_receipt", column: "claim_id", action: "r", why: "evidence" },
  { table: "receipt_forensics_check", column: "receipt_id", action: "r", why: "audit" },
  { table: "slice_allocation_proposal", column: "project_id", action: "r", why: "financial" },
  { table: "slice_allocation_proposal", column: "claim_id", action: "r", why: "financial" },
  { table: "slice_allocation_proposal", column: "member_id", action: "r", why: "financial" },
  { table: "dispute", column: "project_id", action: "r", why: "audit" },
  { table: "dispute", column: "proposal_id", action: "r", why: "audit" },
  { table: "dispute", column: "raised_by_member_id", action: "r", why: "audit" },
  { table: "dispute_vote", column: "dispute_id", action: "r", why: "consensus" },
  { table: "dispute_vote", column: "voter_member_id", action: "r", why: "consensus" },
  { table: "slice_ledger_entry", column: "project_id", action: "r", why: "THE ledger" },
  { table: "slice_ledger_entry", column: "member_id", action: "r", why: "THE ledger" },
  { table: "slice_ledger_entry", column: "claim_id", action: "r", why: "THE ledger" },
  { table: "project_chain_head", column: "project_id", action: "r", why: "hash chain" },
  { table: "project_audit_entry", column: "project_id", action: "r", why: "hash chain" },
  { table: "project_audit_entry", column: "actor_user_id", action: "r", why: "hash chain" },
  { table: "equity_snapshot", column: "project_id", action: "r", why: "cap table" },
  { table: "equity_snapshot_share", column: "snapshot_id", action: "r", why: "cap table" },
  { table: "equity_snapshot_share", column: "member_id", action: "r", why: "cap table" },
  { table: "pie_bake_event", column: "project_id", action: "r", why: "once ever" },
  { table: "pie_bake_event", column: "snapshot_id", action: "r", why: "once ever" },
  // Derivatives. A suggestion is recomputable and must never be the reason a claim
  // cannot be archived.
  {
    table: "optimization_suggestion_evidence",
    column: "suggestion_id",
    action: "c",
    why: "derivative",
  },
  {
    table: "optimization_suggestion_evidence",
    column: "related_claim_id",
    action: "n",
    why: "derivative",
  },
];

/** The triggers that carry §9.1's "not even a DBA" claim. */
const EXPECTED_TRIGGERS: readonly { readonly table: string; readonly trigger: string }[] = [
  { table: "slice_ledger_entry", trigger: "slice_ledger_entry_append_only" },
  { table: "slice_ledger_entry", trigger: "slice_ledger_entry_no_truncate" },
  { table: "project_audit_entry", trigger: "project_audit_entry_append_only" },
  { table: "project_audit_entry", trigger: "project_audit_entry_no_truncate" },
  { table: "equity_snapshot_share", trigger: "equity_snapshot_share_append_only" },
  { table: "equity_snapshot_share", trigger: "equity_snapshot_share_no_truncate" },
  { table: "dispute_vote", trigger: "dispute_vote_append_only" },
  { table: "dispute_vote", trigger: "dispute_vote_no_truncate" },
  { table: "pie_bake_event", trigger: "pie_bake_event_append_only" },
  { table: "pie_bake_event", trigger: "pie_bake_event_no_truncate" },
  { table: "member_fair_market_rate", trigger: "member_fair_market_rate_lock_only" },
  { table: "member_fair_market_rate", trigger: "member_fair_market_rate_no_delete" },
  { table: "member_fair_market_rate", trigger: "member_fair_market_rate_no_truncate" },
  { table: "artifact_evidence", trigger: "artifact_evidence_purge_only" },
  { table: "artifact_evidence", trigger: "artifact_evidence_no_delete" },
  { table: "artifact_evidence", trigger: "artifact_evidence_no_truncate" },
];

/** The partial and plain unique indexes that are load-bearing rather than decorative. */
const EXPECTED_INDEXES = [
  "artifact_evidence_project_claim_unq",
  "physical_work_receipt_content_unq",
  "effort_claim_dailyLogId_unq",
  "dispute_proposalId_open_unq",
  "slice_ledger_entry_projectId_sequence_unq",
  "slice_ledger_entry_proposalId_kind_unq",
  "project_audit_entry_projectId_sequence_unq",
  "pie_bake_event_project_unq",
  "equity_snapshot_projectId_baked_unq",
  "integration_consent_grant_triple_unq",
  "slice_allocation_proposal_sweep_idx",
] as const;

/** The CHECK constraints that encode a rule rather than a range. */
const EXPECTED_CHECKS = [
  "proposal_locked_shape",
  "proposal_consensus_shape",
  "proposal_disputed_shape",
  "proposal_escrow_zero",
  "slice_ledger_entry_sign_ck",
  "slice_ledger_entry_reversal_ck",
  "slice_ledger_entry_inputs_ck",
  "project_audit_entry_hash_ck",
  "project_audit_entry_link_ck",
  "equity_snapshot_degenerate_ck",
  "member_fair_market_rate_lifecycle_ck",
  "effort_claim_override_ck",
  "verification_step_override_ck",
  "integration_consent_grant_lifecycle_ck",
  "artifact_evidence_retention_ck",
] as const;

const CHECK_VIOLATION_SQLSTATE = "23514";
const UNIQUE_VIOLATION_SQLSTATE = "23505";
/** Migration 0010's custom SQLSTATE for an append-only violation. */
const APPEND_ONLY_SQLSTATE = "QT001";

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
    label: `all ${EXPECTED_TABLES.length} Proof-of-Effort tables exist`,
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
    label: "every hand-written §9 trigger is attached to its table",
    passed: missingTriggers.length === 0,
    detail:
      missingTriggers.length === 0
        ? `${EXPECTED_TRIGGERS.length} checked`
        : `missing: ${missingTriggers.map((trigger) => trigger.trigger).join(", ")}`,
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
    label: "the §9 CHECK constraints are attached",
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
    label: "every §9 foreign key has its §4f onDelete action",
    passed: mismatches.length === 0,
    detail:
      mismatches.length === 0
        ? `${EXPECTED_FK_ACTIONS.length} checked`
        : mismatches.map((fk) => `${fk.table}.${fk.column} (${fk.why})`).join(", "),
  });

  // A cascade ANYWHERE into a financial or audit table would defeat every restrict above
  // — this is the sweep §17 step 8 asks for, run against the catalog rather than against
  // a list someone maintains by hand.
  const financialTables = [
    "slice_ledger_entry",
    "project_audit_entry",
    "effort_claim",
    "artifact_evidence",
    "member_fair_market_rate",
    "equity_snapshot_share",
    "dispute_vote",
    "pie_bake_event",
  ];
  const strayCascades = fkRows.filter(
    (row) => financialTables.includes(row.table_name) && row.confdeltype === "c",
  );
  outcomes.push({
    label: "no financial or audit table has a cascading foreign key",
    passed: strayCascades.length === 0,
    detail:
      strayCascades.length === 0
        ? `${financialTables.length} tables swept`
        : strayCascades.map((fk) => `${fk.table_name}.${fk.column_name}`).join(", "),
  });

  return outcomes;
}

interface Fixtures {
  readonly projectId: string;
  readonly memberId: string;
  readonly userId: string;
  readonly rateId: string;
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

async function insertFixtures(client: TransactionClient): Promise<Fixtures | null> {
  const [category] = (
    await client.query<{ id: string }>(
      `SELECT id FROM research_category WHERE status = 'approved' LIMIT 1`,
    )
  ).rows;
  if (!category) return null;

  const userId = "verify-poe-user";
  const projectId = "verify-poe-project";
  const memberId = "verify-poe-member";
  const rateId = "verify-poe-rate";

  await client.query(
    `INSERT INTO "user" (id, name, email, email_verified)
     VALUES ($1, 'Verify Fixture', $2, true)`,
    [userId, `${userId}@example.test`],
  );
  await client.query(
    `INSERT INTO research_project (id, slug, founder_user_id, name, tagline, category_id)
     VALUES ($1, 'verify-poe-project', $2, 'Verify', 'Constraint probe fixture', $3)`,
    [projectId, userId, category.id],
  );
  await client.query(
    `INSERT INTO project_member (id, project_id, user_id, project_role)
     VALUES ($1, $2, $3, 'founder')`,
    [memberId, projectId, userId],
  );
  await client.query(
    `INSERT INTO member_fair_market_rate
       (id, project_id, member_id, fair_market_rate_cents_per_hour, paid_cash_rate_cents_per_hour,
        currency_code, status, effective_from, rationale_note, proposed_by_user_id)
     VALUES ($1, $2, $3, 12000, 0, 'USD', 'proposed', now(), 'Probe fixture', $4)`,
    [rateId, projectId, memberId, userId],
  );

  return { projectId, memberId, userId, rateId };
}

/**
 * Exercises every hand-written guarantee against real rows.
 *
 * Fixtures are created inside the transaction this function always rolls back — probing
 * whatever project happens to exist would make the result depend on the database's
 * contents, and this must pass on an empty one, which is exactly the state a fresh deploy
 * is in when someone wants to know whether 0014 landed.
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

    // --- THE LEDGER IS APPEND-ONLY (§9.1 enforcement 3). The claim that carries the
    // --- product's entire commercial argument, exercised rather than assumed.
    await client.query(
      `INSERT INTO slice_ledger_entry
         (id, project_id, sequence_number, member_id, entry_kind, contribution_kind,
          slice_numerator, slices_awarded, unpaid_rate_cents_per_hour, effort_minutes,
          occurred_at)
       VALUES ('verify-poe-entry', $1, 1, $2, 'award', 'time', 106560000, 35520, 12000, 8880, now())`,
      [fixtures.projectId, fixtures.memberId],
    );

    await expectRejection(
      client,
      outcomes,
      "a DBA cannot UPDATE slicesAwarded on a ledger entry",
      APPEND_ONLY_SQLSTATE,
      () =>
        client.query(
          `UPDATE slice_ledger_entry SET slices_awarded = 99999 WHERE id = 'verify-poe-entry'`,
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "a DBA cannot DELETE a ledger entry",
      APPEND_ONLY_SQLSTATE,
      () => client.query(`DELETE FROM slice_ledger_entry WHERE id = 'verify-poe-entry'`),
    );

    // An award with a negative slice count would read as a legitimate correction.
    await expectRejection(
      client,
      outcomes,
      "an `award` entry cannot carry a negative slice count",
      CHECK_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `INSERT INTO slice_ledger_entry
             (id, project_id, sequence_number, member_id, entry_kind, contribution_kind,
              slice_numerator, slices_awarded, unpaid_rate_cents_per_hour, effort_minutes,
              occurred_at)
           VALUES ('verify-poe-entry-neg', $1, 2, $2, 'award', 'time', -100, -100, 12000, 60, now())`,
          [fixtures.projectId, fixtures.memberId],
        ),
    );

    // A reversal must NAME the entry it reverses, or the correction is untraceable.
    await expectRejection(
      client,
      outcomes,
      "a `reversal` entry must name the entry it reverses",
      CHECK_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `INSERT INTO slice_ledger_entry
             (id, project_id, sequence_number, member_id, entry_kind, contribution_kind,
              slice_numerator, slices_awarded, unpaid_rate_cents_per_hour, effort_minutes,
              occurred_at)
           VALUES ('verify-poe-entry-rev', $1, 2, $2, 'reversal', 'time', -100, -100, 12000, 60, now())`,
          [fixtures.projectId, fixtures.memberId],
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "two ledger entries cannot share a sequence number",
      UNIQUE_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `INSERT INTO slice_ledger_entry
             (id, project_id, sequence_number, member_id, entry_kind, contribution_kind,
              slice_numerator, slices_awarded, cash_in_cents, occurred_at)
           VALUES ('verify-poe-entry-dup', $1, 1, $2, 'award', 'cash', 120, 0, 1, now())`,
          [fixtures.projectId, fixtures.memberId],
        ),
    );

    // --- THE HASH CHAIN (§9.9).
    await client.query(
      `INSERT INTO project_audit_entry
         (id, project_id, sequence_number, event_kind, actor_user_id, actor_name_snapshot,
          actor_role_snapshot, action_label, target_label, detail_note, payload_json,
          occurred_at, previous_entry_hash, entry_hash, hash_algorithm_version)
       VALUES ('verify-poe-audit', $1, 1, 'slices_awarded', $2, 'member-7f3a', 'founder',
               'Awarded slices', 'entry 1', '', '{}', now(), NULL,
               '0000000000000000000000000000000000000000000000000000000000000000', 'sha256-v1')`,
      [fixtures.projectId, fixtures.userId],
    );

    await expectRejection(
      client,
      outcomes,
      "an audit entry's detailNote cannot be edited after the fact",
      APPEND_ONLY_SQLSTATE,
      () =>
        client.query(
          `UPDATE project_audit_entry SET detail_note = 'tampered' WHERE id = 'verify-poe-audit'`,
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "an audit entry cannot be deleted to hide a gap",
      APPEND_ONLY_SQLSTATE,
      () => client.query(`DELETE FROM project_audit_entry WHERE id = 'verify-poe-audit'`),
    );

    // Only sequence 1 may have no predecessor. Without this, a forged chain could start
    // anywhere and every surviving hash would still be self-consistent.
    await expectRejection(
      client,
      outcomes,
      "only the genesis entry may have a null previousEntryHash",
      CHECK_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `INSERT INTO project_audit_entry
             (id, project_id, sequence_number, event_kind, actor_name_snapshot,
              actor_role_snapshot, action_label, target_label, payload_json, occurred_at,
              previous_entry_hash, entry_hash, hash_algorithm_version)
           VALUES ('verify-poe-audit-2', $1, 2, 'slices_awarded', 'member-7f3a', 'founder',
                   'Awarded', 'entry 2', '{}', now(), NULL,
                   '1111111111111111111111111111111111111111111111111111111111111111', 'sha256-v1')`,
          [fixtures.projectId],
        ),
    );

    // A truncated 6-character hash is a RENDERING, never a stored value (§4c).
    await expectRejection(
      client,
      outcomes,
      "a truncated 6-character hash cannot be stored",
      CHECK_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `INSERT INTO project_audit_entry
             (id, project_id, sequence_number, event_kind, actor_name_snapshot,
              actor_role_snapshot, action_label, target_label, payload_json, occurred_at,
              entry_hash, hash_algorithm_version)
           VALUES ('verify-poe-audit-3', $1, 1, 'pie_baked', 'member-7f3a', 'founder',
                   'Baked', 'pie', '{}', now(), 'c7d9a1', 'sha256-v1')`,
          [fixtures.projectId],
        ),
    );

    // --- THE RATE LOCK (§9.6).
    await client.query(
      `UPDATE member_fair_market_rate
          SET status = 'accepted', accepted_at = now(), accepted_by_user_id = $2
        WHERE id = $1`,
      [fixtures.rateId, fixtures.userId],
    );

    await expectRejection(
      client,
      outcomes,
      "an ACCEPTED rate's number cannot be edited before locking",
      APPEND_ONLY_SQLSTATE,
      () =>
        client.query(
          `UPDATE member_fair_market_rate SET fair_market_rate_cents_per_hour = 99999 WHERE id = $1`,
          [fixtures.rateId],
        ),
    );

    await client.query(
      `UPDATE member_fair_market_rate
          SET status = 'locked', locked_at = now(), locked_by_user_id = $2
        WHERE id = $1`,
      [fixtures.rateId, fixtures.userId],
    );

    await expectRejection(
      client,
      outcomes,
      "a LOCKED rate is immutable in every column",
      APPEND_ONLY_SQLSTATE,
      () =>
        client.query(
          `UPDATE member_fair_market_rate SET rationale_note = 'changed my mind' WHERE id = $1`,
          [fixtures.rateId],
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "a rate cannot be deleted out from under the entries that pin it",
      APPEND_ONLY_SQLSTATE,
      () => client.query(`DELETE FROM member_fair_market_rate WHERE id = $1`, [fixtures.rateId]),
    );

    // --- EVIDENCE: REVOCATION PURGES, IT DOES NOT ERASE (§9.10).
    await client.query(
      `INSERT INTO effort_claim
         (id, project_id, member_id, source_kind, claimed_for_date, claim_summary,
          verification_status, idempotency_key)
       VALUES ('verify-poe-claim', $1, $2, 'physical_receipt', CURRENT_DATE,
               'Probe claim', 'queued', 'verify-poe-key-1')`,
      [fixtures.projectId, fixtures.memberId],
    );
    await client.query(
      `INSERT INTO artifact_evidence
         (id, project_id, claim_id, provider, external_id, label, payload_sha256,
          raw_payload_json, signature_status, artifact_occurred_at)
       VALUES ('verify-poe-evidence', $1, 'verify-poe-claim', 'github', 'abc123', 'commit abc123',
               '9f2e00000000000000000000000000000000000000000000000000000000abcd',
               '{"message":"probe"}', 'valid', now())`,
      [fixtures.projectId],
    );

    // The permitted direction: NULL the payload, flip the flag. Everything else frozen.
    await client.query("SAVEPOINT probe_purge_allowed");
    try {
      await client.query(
        `UPDATE artifact_evidence
            SET raw_payload_json = NULL, evidence_retained = false
          WHERE id = 'verify-poe-evidence'`,
      );
      outcomes.push({
        label: "a consent revocation may NULL rawPayloadJson",
        passed: true,
        detail: "purge permitted, as §9.10 requires",
      });
    } catch (error) {
      outcomes.push({
        label: "a consent revocation may NULL rawPayloadJson",
        passed: false,
        detail: `SQLSTATE ${sqlStateOf(error) ?? "unknown"} — the purge path is blocked`,
      });
    }
    await client.query("ROLLBACK TO SAVEPOINT probe_purge_allowed");

    await expectRejection(
      client,
      outcomes,
      "the proof columns survive a revocation — payloadSha256 is frozen",
      APPEND_ONLY_SQLSTATE,
      () =>
        client.query(
          `UPDATE artifact_evidence
              SET payload_sha256 = '0000000000000000000000000000000000000000000000000000000000000000'
            WHERE id = 'verify-poe-evidence'`,
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "evidence cannot be deleted, only purged",
      APPEND_ONLY_SQLSTATE,
      () => client.query(`DELETE FROM artifact_evidence WHERE id = 'verify-poe-evidence'`),
    );

    // ONE COMMIT MUST NOT FUND TWO MEMBERS' CLAIMS (§9.6).
    await client.query(
      `INSERT INTO effort_claim
         (id, project_id, member_id, source_kind, claimed_for_date, claim_summary,
          verification_status, idempotency_key)
       VALUES ('verify-poe-claim-2', $1, $2, 'physical_receipt', CURRENT_DATE,
               'Second probe claim', 'queued', 'verify-poe-key-2')`,
      [fixtures.projectId, fixtures.memberId],
    );
    await expectRejection(
      client,
      outcomes,
      "the same commit cannot fund a second claim",
      UNIQUE_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `INSERT INTO artifact_evidence
             (id, project_id, claim_id, provider, external_id, label, payload_sha256,
              signature_status, artifact_occurred_at)
           VALUES ('verify-poe-evidence-dup', $1, 'verify-poe-claim-2', 'github', 'abc123',
                   'commit abc123 again',
                   '9f2e00000000000000000000000000000000000000000000000000000000abcd',
                   'valid', now())`,
          [fixtures.projectId],
        ),
    );

    // --- THE PROPOSAL STATE MACHINE (§9.6, §9.8).
    await client.query(
      `INSERT INTO claim_verification_run (id, claim_id, attempt_number, started_at)
       VALUES ('verify-poe-run', 'verify-poe-claim', 1, now())`,
    );

    await expectRejection(
      client,
      outcomes,
      "a `locked` proposal without a settled ledger entry is rejected",
      CHECK_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `INSERT INTO slice_allocation_proposal
             (id, project_id, claim_id, member_id, run_id, verdict, proposed_slices,
              proposed_slice_numerator, proposed_time_slice_numerator, status, window_closes_at, locked_at)
           VALUES ('verify-poe-proposal-bad', $1, 'verify-poe-claim', $2, 'verify-poe-run',
                   'verified', 100, 300000, 300000, 'locked', now() + interval '1 day', now())`,
          [fixtures.projectId, fixtures.memberId],
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "a non-disputed proposal cannot hold slices in escrow",
      CHECK_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `INSERT INTO slice_allocation_proposal
             (id, project_id, claim_id, member_id, run_id, verdict, proposed_slices,
              proposed_slice_numerator, proposed_time_slice_numerator, status, window_closes_at, escrowed_slices)
           VALUES ('verify-poe-proposal-esc', $1, 'verify-poe-claim', $2, 'verify-poe-run',
                   'verified', 100, 300000, 300000, 'open', now() + interval '1 day', 100)`,
          [fixtures.projectId, fixtures.memberId],
        ),
    );

    // A flagged verdict STILL opens a window, at zero slices — the solar mock's
    // "960 slices withheld" case (§9.8). This must be insertable.
    await client.query("SAVEPOINT probe_flagged_proposal");
    try {
      await client.query(
        `INSERT INTO slice_allocation_proposal
           (id, project_id, claim_id, member_id, run_id, verdict, proposed_slices,
            proposed_slice_numerator, status, window_closes_at)
         VALUES ('verify-poe-proposal-flagged', $1, 'verify-poe-claim', $2, 'verify-poe-run',
                 'flagged_for_review', 0, 0, 'open', now() + interval '1 day')`,
        [fixtures.projectId, fixtures.memberId],
      );
      outcomes.push({
        label: "a flagged-at-zero verdict still opens a transparency window",
        passed: true,
        detail: "proposal accepted at 0 slices",
      });
    } catch (error) {
      outcomes.push({
        label: "a flagged-at-zero verdict still opens a transparency window",
        passed: false,
        detail: `SQLSTATE ${sqlStateOf(error) ?? "unknown"}`,
      });
    }
    await client.query("ROLLBACK TO SAVEPOINT probe_flagged_proposal");

    // --- CONSENSUS. A vote that can be changed after the fact is not a consensus.
    await client.query(
      `INSERT INTO slice_allocation_proposal
         (id, project_id, claim_id, member_id, run_id, verdict, proposed_slices,
          proposed_slice_numerator, proposed_time_slice_numerator, status, window_closes_at)
       VALUES ('verify-poe-proposal', $1, 'verify-poe-claim', $2, 'verify-poe-run',
               'verified', 100, 300000, 300000, 'open', now() + interval '1 day')`,
      [fixtures.projectId, fixtures.memberId],
    );
    await client.query(
      `INSERT INTO dispute
         (id, project_id, proposal_id, raised_by_member_id, dispute_note, status,
          quorum_member_count)
       VALUES ('verify-poe-dispute', $1, 'verify-poe-proposal', $2, 'Probe dispute', 'open', 3)`,
      [fixtures.projectId, fixtures.memberId],
    );
    await client.query(
      `INSERT INTO dispute_vote (id, dispute_id, voter_member_id, position)
       VALUES ('verify-poe-vote', 'verify-poe-dispute', $1, 'uphold')`,
      [fixtures.memberId],
    );

    await expectRejection(
      client,
      outcomes,
      "a cast vote cannot be changed",
      APPEND_ONLY_SQLSTATE,
      () => client.query(`UPDATE dispute_vote SET position = 'void' WHERE id = 'verify-poe-vote'`),
    );

    await expectRejection(
      client,
      outcomes,
      "one member cannot vote twice on the same dispute",
      UNIQUE_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `INSERT INTO dispute_vote (id, dispute_id, voter_member_id, position)
           VALUES ('verify-poe-vote-2', 'verify-poe-dispute', $1, 'void')`,
          [fixtures.memberId],
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "a proposal cannot carry two live disputes",
      UNIQUE_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `INSERT INTO dispute
             (id, project_id, proposal_id, raised_by_member_id, dispute_note, status,
              quorum_member_count)
           VALUES ('verify-poe-dispute-2', $1, 'verify-poe-proposal', $2, 'Second', 'open', 3)`,
          [fixtures.projectId, fixtures.memberId],
        ),
    );

    // --- THE CAP TABLE. A snapshot with slices cannot claim to be degenerate, and a
    // --- degenerate one is the ONLY case where shares may not sum to 10000 (§9.4).
    await expectRejection(
      client,
      outcomes,
      "a snapshot holding slices cannot be marked degenerate",
      CHECK_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `INSERT INTO equity_snapshot
             (id, project_id, as_of, total_slices, member_count,
              through_ledger_sequence_number, is_degenerate)
           VALUES ('verify-poe-snapshot-bad', $1, now(), 35520, 1, 1, true)`,
          [fixtures.projectId],
        ),
    );

    await client.query(
      `INSERT INTO equity_snapshot
         (id, project_id, as_of, total_slices, member_count, through_ledger_sequence_number,
          is_degenerate)
       VALUES ('verify-poe-snapshot', $1, now(), 35520, 1, 1, false)`,
      [fixtures.projectId],
    );
    await client.query(
      `INSERT INTO equity_snapshot_share
         (id, snapshot_id, member_id, member_user_id, slices, equity_basis_points)
       VALUES ('verify-poe-share', 'verify-poe-snapshot', $1, $2, 35520, 10000)`,
      [fixtures.memberId, fixtures.userId],
    );

    await expectRejection(
      client,
      outcomes,
      "an apportioned share cannot be hand-edited",
      APPEND_ONLY_SQLSTATE,
      () =>
        client.query(
          `UPDATE equity_snapshot_share SET equity_basis_points = 5000 WHERE id = 'verify-poe-share'`,
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "a share above 100% is rejected",
      CHECK_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `INSERT INTO equity_snapshot_share
             (id, snapshot_id, member_id, member_user_id, slices, equity_basis_points)
           VALUES ('verify-poe-share-bad', 'verify-poe-snapshot', $1, $2, 1, 10001)`,
          [fixtures.memberId, fixtures.userId],
        ),
    );

    // --- THE PIE BAKES ONCE, EVER (§9.11).
    await client.query(
      `INSERT INTO pie_bake_event
         (id, project_id, snapshot_id, trigger, trigger_evidence_note, acknowledgement,
          baked_by_user_id)
       VALUES ('verify-poe-bake', $1, 'verify-poe-snapshot', 'priced_round',
               'Probe evidence', 'BAKE THE PIE', $2)`,
      [fixtures.projectId, fixtures.userId],
    );

    await expectRejection(
      client,
      outcomes,
      "a project cannot bake its pie twice",
      UNIQUE_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `INSERT INTO pie_bake_event
             (id, project_id, snapshot_id, trigger, trigger_evidence_note, acknowledgement,
              baked_by_user_id)
           VALUES ('verify-poe-bake-2', $1, 'verify-poe-snapshot', 'priced_round',
                   'Second attempt', 'BAKE THE PIE', $2)`,
          [fixtures.projectId, fixtures.userId],
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "there is no unbake: the bake event cannot be deleted",
      APPEND_ONLY_SQLSTATE,
      () => client.query(`DELETE FROM pie_bake_event WHERE id = 'verify-poe-bake'`),
    );

    // --- CONSENT. A revoked grant that still holds ciphertext is not revoked (§9.10).
    await expectRejection(
      client,
      outcomes,
      "a revoked consent grant cannot keep its token",
      CHECK_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `INSERT INTO integration_consent_grant
             (id, project_id, member_id, provider, status, encrypted_access_token,
              token_key_version, granted_at, revoked_at, revoked_by_user_id)
           VALUES ('verify-poe-grant-bad', $1, $2, 'github', 'revoked', 'ciphertext',
                   'v1', now(), now(), $3)`,
          [fixtures.projectId, fixtures.memberId, fixtures.userId],
        ),
    );

    // ONE grant per (project, member, provider) — never a pair (§9.10).
    await client.query(
      `INSERT INTO integration_consent_grant
         (id, project_id, member_id, provider, status, encrypted_access_token,
          token_key_version, granted_at)
       VALUES ('verify-poe-grant', $1, $2, 'github', 'active', 'ciphertext', 'v1', now())`,
      [fixtures.projectId, fixtures.memberId],
    );
    await expectRejection(
      client,
      outcomes,
      "consent is a (project, member, provider) triple, not a pair",
      UNIQUE_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `INSERT INTO integration_consent_grant
             (id, project_id, member_id, provider, status)
           VALUES ('verify-poe-grant-2', $1, $2, 'github', 'pending')`,
          [fixtures.projectId, fixtures.memberId],
        ),
    );

    // --- RECEIPTS. The same bytes cannot fund two receipts (§9.6).
    await client.query(
      `INSERT INTO physical_work_receipt
         (id, project_id, member_id, receipt_kind, content_sha256, perceptual_hash,
          size_bytes, idempotency_key)
       VALUES ('verify-poe-receipt', $1, $2, 'photo_of_work',
               'aaaa000000000000000000000000000000000000000000000000000000000000',
               'p:0f0f0f0f', 2048, 'verify-poe-receipt-key')`,
      [fixtures.projectId, fixtures.memberId],
    );
    await expectRejection(
      client,
      outcomes,
      "the same bytes cannot fund two receipts",
      UNIQUE_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `INSERT INTO physical_work_receipt
             (id, project_id, member_id, receipt_kind, content_sha256, perceptual_hash,
              size_bytes, idempotency_key)
           VALUES ('verify-poe-receipt-2', $1, $2, 'photo_of_work',
                   'aaaa000000000000000000000000000000000000000000000000000000000000',
                   'p:0f0f0f0f', 2048, 'verify-poe-receipt-key-2')`,
          [fixtures.projectId, fixtures.memberId],
        ),
    );

    // --- ONE CLAIM PER DAILY LOG, EVER. Two claims over one log pay the same day twice.
    await client.query(
      `INSERT INTO daily_log (id, project_id, author_member_id, log_date, status, narrative)
       VALUES ('verify-poe-log', $1, $2, CURRENT_DATE, 'draft', 'Probe log')`,
      [fixtures.projectId, fixtures.memberId],
    );
    await client.query(
      `INSERT INTO effort_claim
         (id, project_id, member_id, source_kind, daily_log_id, claimed_for_date,
          claim_summary, verification_status, idempotency_key)
       VALUES ('verify-poe-claim-log', $1, $2, 'daily_log', 'verify-poe-log', CURRENT_DATE,
               'Log-backed claim', 'queued', 'verify-poe-key-3')`,
      [fixtures.projectId, fixtures.memberId],
    );
    await expectRejection(
      client,
      outcomes,
      "one daily log cannot fund two claims",
      UNIQUE_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `INSERT INTO effort_claim
             (id, project_id, member_id, source_kind, daily_log_id, claimed_for_date,
              claim_summary, verification_status, idempotency_key)
           VALUES ('verify-poe-claim-log-2', $1, $2, 'daily_log', 'verify-poe-log', CURRENT_DATE,
                   'Duplicate', 'queued', 'verify-poe-key-4')`,
          [fixtures.projectId, fixtures.memberId],
        ),
    );

    // --- THE OVERRIDE QUARTET. An unattributed edit to a number someone is paid on.
    await expectRejection(
      client,
      outcomes,
      "an overridden minute count must name its author and reason",
      CHECK_VIOLATION_SQLSTATE,
      () =>
        client.query(
          `UPDATE effort_claim SET overridden_minutes = 240 WHERE id = 'verify-poe-claim'`,
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
  const outcomes = [...(await checkSchemaObjects()), ...(await checkRuntimeGuarantees())];

  for (const outcome of outcomes) {
    console.log(`${outcome.passed ? "PASS" : "FAIL"}  ${outcome.label} — ${outcome.detail}`);
  }

  const failureCount = outcomes.filter((outcome) => !outcome.passed).length;
  console.log(
    failureCount === 0
      ? `\nAll ${outcomes.length} Proof-of-Effort guarantees verified.`
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
    console.error("Proof-of-Effort constraint verification failed to run:", error);
    await pool.end();
    process.exit(1);
  });
