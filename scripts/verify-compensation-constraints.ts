/**
 * Verifies that migration 0017's DATABASE-LEVEL guarantees are actually in force
 * (R_AND_D_BACKEND_STRUCTURE.md §7A, §17 steps 1, 5b, 5c and 9).
 *
 * WHY THIS IS A SCRIPT AND NOT A TEST — the same reason verify-escrow-constraints.ts is:
 * the vitest suite mocks `#src/db/index.js` wholesale, so it can prove things about
 * TypeScript and nothing about Postgres. And §7A makes claims TypeScript cannot make:
 *
 *   "A FINALIZED PERIOD IS FROZEN. Hash-chained. Two people signed it. It never changes."
 *   "No column in this domain holds an account number, IBAN, UPI handle or card detail."
 *   "The countersigner of a finalized period must not be the one who requested it."
 *
 * A service that declines to write an UPDATE is not the first claim. A comment is not the
 * second. The triggers and constraints are, and a hand-written trigger nobody has watched
 * fire is indistinguishable from an absent one — so every guarantee below is EXERCISED
 * against real rows rather than merely inspected in the catalog.
 *
 * THERE ARE POSITIVE CONTROLS, deliberately. A file that only ever asserts "this was
 * rejected" passes just as well against a database where EVERYTHING is rejected, which is
 * a broken deployment rather than a safe one.
 *
 * Read-only in effect: every write happens inside a transaction that is always rolled
 * back.
 *
 *   pnpm db:verify-compensation-constraints
 *
 * Exits non-zero if any guarantee is missing, so it can gate a deploy.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { pool } from "#src/db/index.js";

interface CheckOutcome {
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

type TransactionClient = PoolClient;

/** The application-defined SQLSTATE every §7A trigger raises. */
const TRIGGER_SQLSTATE = "QT001";
/** Postgres's own codes. */
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
/**
 * `feature_not_supported` — what Postgres raises for TRUNCATE on a table another table's
 * FK references, BEFORE any statement trigger gets a chance to fire.
 *
 * Accepted alongside the trigger's own code because it is a STRONGER refusal, not a weaker
 * one: the FK graph refuses the statement outright and the trigger never has to. Three of
 * §7A's four tables are referenced this way; `compensation_payment_record` is a leaf, so
 * it reaches its trigger and answers QT001. Both mean "you cannot truncate this".
 */
const TRUNCATE_BLOCKED_BY_FK = "0A000";

const EXPECTED_TABLES = [
  "member_cash_compensation_agreement",
  "compensation_period",
  "compensation_period_line",
  "compensation_payment_record",
] as const;

const EXPECTED_TRIGGERS = [
  "member_cash_compensation_agreement_accept_only",
  "member_cash_compensation_agreement_no_delete",
  "member_cash_compensation_agreement_no_truncate",
  "compensation_period_freeze",
  "compensation_period_no_delete",
  "compensation_period_no_truncate",
  "compensation_period_line_freeze",
  "compensation_period_line_no_truncate",
  "compensation_payment_record_confirm_only",
  "compensation_payment_record_no_delete",
  "compensation_payment_record_no_truncate",
] as const;

/**
 * Every §7A FK, with the `onDelete` §4f requires — §17 step 9's cascade sweep, extended
 * with this section's four tables as that step instructs.
 *
 * `r` = RESTRICT, `c` = CASCADE, `n` = SET NULL (pg_constraint.confdeltype).
 *
 * THERE IS NO `c` IN THIS LIST, AND THAT ABSENCE IS THE POLICY. §4f: "a finalized
 * statement is the evidence a wage was owed and paid, and a deleted user must not be able
 * to erase it." This holds even though no money moves.
 */
const EXPECTED_FK_ACTIONS: readonly {
  readonly table: string;
  readonly column: string;
  readonly action: "r" | "c" | "n";
}[] = [
  { table: "member_cash_compensation_agreement", column: "project_id", action: "r" },
  { table: "member_cash_compensation_agreement", column: "member_id", action: "r" },
  { table: "member_cash_compensation_agreement", column: "proposed_by_user_id", action: "r" },
  { table: "member_cash_compensation_agreement", column: "accepted_by_user_id", action: "r" },
  { table: "compensation_period", column: "project_id", action: "r" },
  { table: "compensation_period", column: "finalized_by_user_id", action: "r" },
  { table: "compensation_period", column: "countersigned_by_user_id", action: "r" },
  { table: "compensation_period", column: "superseded_by_period_id", action: "r" },
  { table: "compensation_period_line", column: "period_id", action: "r" },
  { table: "compensation_period_line", column: "project_id", action: "r" },
  { table: "compensation_period_line", column: "member_id", action: "r" },
  { table: "compensation_period_line", column: "source_agreement_id", action: "r" },
  { table: "compensation_period_line", column: "source_rate_id", action: "r" },
  { table: "compensation_period_line", column: "start_snapshot_id", action: "r" },
  { table: "compensation_period_line", column: "end_snapshot_id", action: "r" },
  { table: "compensation_payment_record", column: "line_id", action: "r" },
  { table: "compensation_payment_record", column: "project_id", action: "r" },
  { table: "compensation_payment_record", column: "recorded_by_user_id", action: "r" },
  { table: "compensation_payment_record", column: "confirmed_by_user_id", action: "r" },
];

/**
 * The columns §7A forbids OUTRIGHT (§17 step 5c).
 *
 * Not a naming preference: storing a payment instrument would drag PCI-DSS scope into a
 * product that has none, create a PII breach surface with no upside, and hand an attacker
 * a wire-fraud primitive. The sweep is over the WHOLE public schema rather than §7A's four
 * tables, because the guarantee is about the domain and not about one section.
 */
/**
 * The RETIRED escrow tables, excluded from the sweep — and named here rather than skipped
 * silently, because the exclusion is the interesting part.
 *
 * `provider_transfer.payout_destination_id` is real and it is still in the database. It was
 * NEVER client-supplied (§7 resolved it server-side from the project's registered provider
 * account, and `payoutDestinationId` has been on the rejected-keys list since §7 shipped),
 * it is nullable, and nothing writes it now that the escrow subtree is retired — Qatoto
 * holds no funds and pays nobody, so there is no destination to resolve.
 *
 * It survives because migration 0016's rows survive. Dropping the column would mean
 * rewriting a table whose whole point is that it cannot be rewritten. What the sweep must
 * guarantee is that no LIVE surface grows one, which is what this exclusion scopes it to.
 */
const RETIRED_ESCROW_TABLES = [
  "escrow_account",
  "escrow_journal_entry",
  "escrow_posting",
  "escrow_release",
  "provider_transfer",
  "provider_webhook_event",
  "reconciliation_discrepancy",
] as const;

const FORBIDDEN_COLUMN_NAMES = [
  "account_number",
  "iban",
  "upi_id",
  "upi_handle",
  "card_number",
  "pan",
  "routing_number",
  "sort_code",
  "destination_account_id",
  "payout_destination_id",
  "payment_method_id",
] as const;

function sqlStateOf(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

async function countQuery(text: string, values: readonly unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(text, [...values]);
  return Number(rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Catalog checks — is the object there at all?
// ---------------------------------------------------------------------------

async function checkSchemaObjects(): Promise<readonly CheckOutcome[]> {
  const outcomes: CheckOutcome[] = [];

  for (const table of EXPECTED_TABLES) {
    const found = await countQuery(
      `SELECT COUNT(*) AS n FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1`,
      [table],
    );
    outcomes.push({
      label: `table ${table} exists`,
      passed: found === 1,
      detail: found === 1 ? "present" : "MISSING",
    });
  }

  for (const trigger of EXPECTED_TRIGGERS) {
    const found = await countQuery(
      `SELECT COUNT(*) AS n FROM pg_trigger WHERE NOT tgisinternal AND tgname = $1`,
      [trigger],
    );
    outcomes.push({
      label: `trigger ${trigger} is attached`,
      passed: found === 1,
      detail: found === 1 ? "attached" : "MISSING",
    });
  }

  for (const expected of EXPECTED_FK_ACTIONS) {
    const { rows } = await pool.query<{ action: string }>(
      `SELECT c.confdeltype AS action
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = c.conkey[1]
        WHERE c.contype = 'f' AND t.relname = $1 AND a.attname = $2
          AND array_length(c.conkey, 1) = 1`,
      [expected.table, expected.column],
    );
    const action = rows[0]?.action;
    outcomes.push({
      label: `${expected.table}.${expected.column} is ON DELETE ${expected.action === "r" ? "RESTRICT" : expected.action === "n" ? "SET NULL" : "CASCADE"}`,
      passed: action === expected.action,
      detail: action === undefined ? "FK MISSING" : `confdeltype ${action}`,
    });
  }

  // THE SWEEP THAT CATCHES A TABLE ADDED LATER. §17 step 9 asks for the expectation list
  // AND a catalog sweep, so a §7A table added next quarter without updating this file
  // still fails rather than passing by omission.
  const cascadeCount = await countQuery(
    `SELECT COUNT(*) AS n
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
      WHERE c.contype = 'f' AND c.confdeltype = 'c'
        AND t.relname IN ('member_cash_compensation_agreement', 'compensation_period',
                          'compensation_period_line', 'compensation_payment_record')`,
  );
  outcomes.push({
    label: "NO §7A foreign key cascades, including any added since this list was written",
    passed: cascadeCount === 0,
    detail: cascadeCount === 0 ? "zero cascades" : `${cascadeCount} CASCADE FK(s) found`,
  });

  // §17 step 5c's schema sweep.
  const { rows: forbidden } = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = ANY($1::text[])
        AND table_name <> ALL($2::text[])`,
    [[...FORBIDDEN_COLUMN_NAMES], [...RETIRED_ESCROW_TABLES]],
  );
  outcomes.push({
    label: "NO LIVE column holds an account number, IBAN, UPI handle or card detail",
    passed: forbidden.length === 0,
    detail:
      forbidden.length === 0
        ? "zero payment-instrument columns"
        : forbidden.map((row) => `${row.table_name}.${row.column_name}`).join(", "),
  });

  // The exclusion above is only honest if it is BOUNDED. Report what it hides, so a reader
  // sees the one legacy column rather than trusting a list they would have to go and check.
  const { rows: excluded } = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = ANY($1::text[])
        AND table_name = ANY($2::text[])`,
    [[...FORBIDDEN_COLUMN_NAMES], [...RETIRED_ESCROW_TABLES]],
  );
  outcomes.push({
    label: "the excluded retired-escrow columns are exactly the ones expected",
    passed: excluded.every((row) => row.table_name === "provider_transfer"),
    detail:
      excluded.length === 0
        ? "none"
        : excluded
            .map((row) => `${row.table_name}.${row.column_name} (retired, unwritten)`)
            .join(", "),
  });

  return outcomes;
}

// ---------------------------------------------------------------------------
// Runtime probes — does the guard actually fire?
// ---------------------------------------------------------------------------

async function expectRejection(
  client: TransactionClient,
  outcomes: CheckOutcome[],
  label: string,
  expectedSqlStates: string | readonly string[],
  statement: () => Promise<unknown>,
): Promise<void> {
  const accepted = typeof expectedSqlStates === "string" ? [expectedSqlStates] : expectedSqlStates;
  const savepoint = `probe_${outcomes.length}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    await statement();
    outcomes.push({ label, passed: false, detail: "the statement SUCCEEDED" });
  } catch (error) {
    const sqlState = sqlStateOf(error);
    outcomes.push({
      label,
      passed: sqlState !== undefined && accepted.includes(sqlState),
      detail: `SQLSTATE ${sqlState ?? "unknown"} (expected ${accepted.join(" or ")})`,
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
      detail: `REJECTED with ${sqlStateOf(error) ?? "unknown"} — a legitimate write was refused`,
    });
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
}

interface Fixtures {
  readonly projectId: string;
  readonly founderUserId: string;
  readonly memberUserId: string;
  readonly adminUserId: string;
  readonly memberId: string;
  readonly agreementId: string;
  readonly openPeriodId: string;
  readonly finalizedPeriodId: string;
  readonly openLineId: string;
  readonly finalizedLineId: string;
  readonly paymentId: string;
}

const SIXTY_FOUR_HEX = "a".repeat(64);
const OTHER_HEX = "b".repeat(64);

async function insertFixtures(client: TransactionClient): Promise<Fixtures | null> {
  const runId = randomUUID().slice(0, 8);

  const { rows: categoryRows } = await client.query<{ id: string }>(
    `SELECT id FROM research_category WHERE status = 'approved' LIMIT 1`,
  );
  const categoryId = categoryRows[0]?.id;
  if (categoryId === undefined) {
    return null;
  }

  const founderUserId = `verify-comp-founder-${runId}`;
  const memberUserId = `verify-comp-member-${runId}`;
  const adminUserId = `verify-comp-admin-${runId}`;

  for (const [id, name] of [
    [founderUserId, "Verify Founder"],
    [memberUserId, "Verify Member"],
    [adminUserId, "Verify Admin"],
  ] as const) {
    await client.query(
      `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)`,
      [id, name, `${id}@example.test`],
    );
  }

  const projectId = randomUUID();
  await client.query(
    `INSERT INTO research_project
       (id, slug, founder_user_id, name, tagline, problem_statement, category_id, status,
        published_at)
     VALUES ($1, $2, $3, 'VerifyChill', 'Verifying', 'Things break', $4, 'active', now())`,
    [projectId, `verify-comp-${runId}`, founderUserId, categoryId],
  );
  await client.query(`INSERT INTO project_stats (project_id) VALUES ($1)`, [projectId]);

  const memberId = randomUUID();
  await client.query(
    `INSERT INTO project_member (id, project_id, user_id, project_role)
     VALUES ($1, $2, $3, 'contributor')`,
    [memberId, projectId, memberUserId],
  );

  // A PROPOSED agreement — the accept-only trigger permits edits in this state.
  const agreementId = randomUUID();
  await client.query(
    `INSERT INTO member_cash_compensation_agreement
       (id, project_id, member_id, engagement_kind, monthly_amount_in_cents, currency_code,
        status, effective_from, rationale_note, proposed_by_user_id)
     VALUES ($1, $2, $3, 'employee', 600000, 'USD', 'proposed', now(), 'Market rate', $4)`,
    [agreementId, projectId, memberId, founderUserId],
  );

  const openPeriodId = randomUUID();
  await client.query(
    `INSERT INTO compensation_period
       (id, project_id, sequence_number, period_start_date, period_end_date, time_zone, status)
     VALUES ($1, $2, 1, '2026-03-01', '2026-04-01', 'UTC', 'open')`,
    [openPeriodId, projectId],
  );

  const finalizedPeriodId = randomUUID();
  await client.query(
    `INSERT INTO compensation_period
       (id, project_id, sequence_number, period_start_date, period_end_date, time_zone, status,
        finalized_at, finalized_by_user_id, statement_hash, previous_statement_hash, hash_version)
     VALUES ($1, $2, 2, '2026-04-01', '2026-05-01', 'UTC', 'finalized',
             now(), $3, $4, 'genesis', 'sha256-jcs-v1')`,
    [finalizedPeriodId, projectId, founderUserId, SIXTY_FOUR_HEX],
  );

  const openLineId = randomUUID();
  await client.query(
    `INSERT INTO compensation_period_line
       (id, period_id, project_id, member_id, kind, gross_amount_in_cents, currency)
     VALUES ($1, $2, $3, $4, 'cash_retainer', 600000, 'USD')`,
    [openLineId, openPeriodId, projectId, memberId],
  );

  const finalizedLineId = randomUUID();
  await client.query(
    `INSERT INTO compensation_period_line
       (id, period_id, project_id, member_id, kind, gross_amount_in_cents, currency)
     VALUES ($1, $2, $3, $4, 'cash_retainer', 600000, 'USD')`,
    [finalizedLineId, finalizedPeriodId, projectId, memberId],
  );

  const paymentId = randomUUID();
  await client.query(
    `INSERT INTO compensation_payment_record
       (id, line_id, project_id, paid_amount_in_cents, currency, paid_on_date, method_key,
        recorded_by_user_id, idempotency_key)
     VALUES ($1, $2, $3, 600000, 'USD', '2026-05-03', 'bank_transfer', $4, 'verify-key-0001')`,
    [paymentId, finalizedLineId, projectId, founderUserId],
  );

  return {
    projectId,
    founderUserId,
    memberUserId,
    adminUserId,
    memberId,
    agreementId,
    openPeriodId,
    finalizedPeriodId,
    openLineId,
    finalizedLineId,
    paymentId,
  };
}

async function checkTruncateGuards(): Promise<readonly CheckOutcome[]> {
  const outcomes: CheckOutcome[] = [];
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    for (const table of EXPECTED_TABLES) {
      // TRUNCATE is checked separately from the row triggers because a BEFORE UPDATE OR
      // DELETE *row* trigger does not fire on TRUNCATE at all — which is exactly the gap
      // an attacker with a psql prompt would use.
      await expectRejection(
        client,
        outcomes,
        `TRUNCATE ${table} is rejected`,
        [TRIGGER_SQLSTATE, TRUNCATE_BLOCKED_BY_FK],
        () => client.query(`TRUNCATE TABLE "${table}"`),
      );
    }
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }

  return outcomes;
}

async function checkRuntimeGuarantees(): Promise<readonly CheckOutcome[]> {
  const outcomes: CheckOutcome[] = [];
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const fixtures = await insertFixtures(client);

    if (!fixtures) {
      outcomes.push({
        label: "fixtures",
        passed: false,
        detail: "no approved research_category — run `pnpm db:seed-research-categories`",
      });
      return outcomes;
    }

    // --- 1. THE AGREEMENT: proposed is editable, accepted is frozen (§7A.2).

    await expectAcceptance(
      client,
      outcomes,
      "a PROPOSED agreement's amount is still editable — the negotiation is not over",
      () =>
        client.query(
          `UPDATE member_cash_compensation_agreement SET monthly_amount_in_cents = 700000 WHERE id = $1`,
          [fixtures.agreementId],
        ),
    );

    await client.query(
      `UPDATE member_cash_compensation_agreement
          SET status = 'active', accepted_at = now(), accepted_by_user_id = $2
        WHERE id = $1`,
      [fixtures.agreementId, fixtures.memberUserId],
    );

    await expectRejection(
      client,
      outcomes,
      "an ACCEPTED agreement's amount is frozen — a founder cannot rewrite what someone agreed to",
      TRIGGER_SQLSTATE,
      () =>
        client.query(
          `UPDATE member_cash_compensation_agreement SET monthly_amount_in_cents = 1 WHERE id = $1`,
          [fixtures.agreementId],
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "an accepted agreement's currency is frozen",
      TRIGGER_SQLSTATE,
      () =>
        client.query(
          `UPDATE member_cash_compensation_agreement SET currency_code = 'JPY' WHERE id = $1`,
          [fixtures.agreementId],
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "acceptance is recorded once and never rewritten",
      TRIGGER_SQLSTATE,
      () =>
        client.query(
          `UPDATE member_cash_compensation_agreement SET accepted_by_user_id = $2 WHERE id = $1`,
          [fixtures.agreementId, fixtures.founderUserId],
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "an agreement cannot be re-pointed at another member",
      TRIGGER_SQLSTATE,
      () =>
        client.query(`UPDATE member_cash_compensation_agreement SET member_id = $2 WHERE id = $1`, [
          fixtures.agreementId,
          randomUUID(),
        ]),
    );

    await expectRejection(
      client,
      outcomes,
      "an agreement cannot be DELETEd — a finalized line pins it",
      TRIGGER_SQLSTATE,
      () =>
        client.query(`DELETE FROM member_cash_compensation_agreement WHERE id = $1`, [
          fixtures.agreementId,
        ]),
    );

    await expectRejection(
      client,
      outcomes,
      "an agreement needs EXACTLY ONE basis — monthly XOR hourly",
      CHECK_VIOLATION,
      () =>
        client.query(
          `INSERT INTO member_cash_compensation_agreement
             (id, project_id, member_id, engagement_kind, monthly_amount_in_cents,
              hourly_rate_cents_per_hour, currency_code, status, effective_from,
              rationale_note, proposed_by_user_id)
           VALUES ($1, $2, $3, 'employee', 600000, 12000, 'USD', 'proposed',
                   now() + interval '1 day', 'Both bases', $4)`,
          [randomUUID(), fixtures.projectId, fixtures.memberId, fixtures.founderUserId],
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "at most ONE active agreement per member — two would make their pay ambiguous",
      UNIQUE_VIOLATION,
      () =>
        client.query(
          `INSERT INTO member_cash_compensation_agreement
             (id, project_id, member_id, engagement_kind, monthly_amount_in_cents, currency_code,
              status, effective_from, rationale_note, proposed_by_user_id, accepted_at,
              accepted_by_user_id)
           VALUES ($1, $2, $3, 'employee', 700000, 'USD', 'active', now() + interval '1 day',
                   'A second active one', $4, now(), $5)`,
          [
            randomUUID(),
            fixtures.projectId,
            fixtures.memberId,
            fixtures.founderUserId,
            fixtures.memberUserId,
          ],
        ),
    );

    // --- 2. THE PERIOD: open is redrawable, finalized is frozen (§7A.3, §7A.5).

    await expectAcceptance(
      client,
      outcomes,
      "an OPEN period's line is still writable — that is what the nightly redraw does",
      () =>
        client.query(
          `UPDATE compensation_period_line SET gross_amount_in_cents = 650000 WHERE id = $1`,
          [fixtures.openLineId],
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "a FINALIZED period's line is frozen — §17 step 5b's UPDATE probe",
      TRIGGER_SQLSTATE,
      () =>
        client.query(
          `UPDATE compensation_period_line SET gross_amount_in_cents = 1 WHERE id = $1`,
          [fixtures.finalizedLineId],
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "a finalized period's line cannot be DELETEd either",
      TRIGGER_SQLSTATE,
      () =>
        client.query(`DELETE FROM compensation_period_line WHERE id = $1`, [
          fixtures.finalizedLineId,
        ]),
    );

    await expectRejection(
      client,
      outcomes,
      "a finalized period's statement hash is frozen",
      TRIGGER_SQLSTATE,
      () =>
        client.query(`UPDATE compensation_period SET statement_hash = $2 WHERE id = $1`, [
          fixtures.finalizedPeriodId,
          OTHER_HEX,
        ]),
    );

    await expectRejection(
      client,
      outcomes,
      "a finalized period cannot be REOPENED",
      TRIGGER_SQLSTATE,
      () =>
        client.query(`UPDATE compensation_period SET status = 'open' WHERE id = $1`, [
          fixtures.finalizedPeriodId,
        ]),
    );

    await expectAcceptance(
      client,
      outcomes,
      "a finalized period still accepts a COUNTERSIGNATURE — the one write the freeze allows",
      () =>
        client.query(
          `UPDATE compensation_period
              SET countersigned_at = now(), countersigned_by_user_id = $2
            WHERE id = $1`,
          [fixtures.finalizedPeriodId, fixtures.adminUserId],
        ),
    );

    // --- 3. FOUR EYES, AT THE COLUMN LEVEL (§4a, §7A.5). The service refuses this first
    // --- with a 422; this proves a psql prompt cannot step around it.

    await expectRejection(
      client,
      outcomes,
      "THE FINALIZER CANNOT COUNTERSIGN THEIR OWN STATEMENT, founder included",
      CHECK_VIOLATION,
      () =>
        client.query(
          `UPDATE compensation_period
              SET countersigned_at = now(), countersigned_by_user_id = $2
            WHERE id = $1`,
          [fixtures.finalizedPeriodId, fixtures.founderUserId],
        ),
    );

    await expectRejection(client, outcomes, "a period cannot be DELETEd", TRIGGER_SQLSTATE, () =>
      client.query(`DELETE FROM compensation_period WHERE id = $1`, [fixtures.openPeriodId]),
    );

    await expectRejection(
      client,
      outcomes,
      "one OPEN period per project per month — a second would double-count the same minutes",
      UNIQUE_VIOLATION,
      () =>
        client.query(
          `INSERT INTO compensation_period
             (id, project_id, sequence_number, period_start_date, period_end_date, time_zone,
              status)
           VALUES ($1, $2, 3, '2026-03-01', '2026-04-01', 'UTC', 'open')`,
          [randomUUID(), fixtures.projectId],
        ),
    );

    await expectAcceptance(
      client,
      outcomes,
      "a DIFFERENT month may be open at the same time — an unfinalized March beside an accruing April",
      () =>
        client.query(
          `INSERT INTO compensation_period
             (id, project_id, sequence_number, period_start_date, period_end_date, time_zone,
              status)
           VALUES ($1, $2, 4, '2026-05-01', '2026-06-01', 'UTC', 'open')`,
          [randomUUID(), fixtures.projectId],
        ),
    );

    // --- 4. EQUITY IS NOT MONEY (§7A.3). A cash line carries an amount and no basis
    // --- points; an equity line carries basis points and no amount.

    await expectRejection(
      client,
      outcomes,
      "an equity line cannot carry a money amount — equity and cash must never be summed",
      CHECK_VIOLATION,
      () =>
        client.query(
          `INSERT INTO compensation_period_line
             (id, period_id, project_id, member_id, kind, gross_amount_in_cents, currency,
              equity_basis_points_at_start, equity_basis_points_at_end, equity_basis_points_delta)
           VALUES ($1, $2, $3, $4, 'equity_delta', 100, 'USD', 0, 100, 100)`,
          [randomUUID(), fixtures.openPeriodId, fixtures.projectId, fixtures.memberId],
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "a period cannot owe NEGATIVE wages — an overpayment is corrected by superseding",
      CHECK_VIOLATION,
      () =>
        client.query(
          `UPDATE compensation_period_line SET gross_amount_in_cents = -1 WHERE id = $1`,
          [fixtures.openLineId],
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "the equity delta must BE the subtraction — a transcription error fails loudly",
      CHECK_VIOLATION,
      () =>
        client.query(
          `INSERT INTO compensation_period_line
             (id, period_id, project_id, member_id, kind,
              equity_basis_points_at_start, equity_basis_points_at_end, equity_basis_points_delta)
           VALUES ($1, $2, $3, $4, 'equity_delta', 100, 400, 999)`,
          [randomUUID(), fixtures.openPeriodId, fixtures.projectId, fixtures.memberId],
        ),
    );

    await expectAcceptance(
      client,
      outcomes,
      "a NEGATIVE equity delta is accepted — a share falls when others out-contribute you",
      () =>
        client.query(
          `INSERT INTO compensation_period_line
             (id, period_id, project_id, member_id, kind,
              equity_basis_points_at_start, equity_basis_points_at_end, equity_basis_points_delta)
           VALUES ($1, $2, $3, $4, 'equity_delta', 400, 100, -300)`,
          [randomUUID(), fixtures.openPeriodId, fixtures.projectId, fixtures.memberId],
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "one line per member per kind per period — a redraw is a no-op, not a duplicate",
      UNIQUE_VIOLATION,
      () =>
        client.query(
          `INSERT INTO compensation_period_line
             (id, period_id, project_id, member_id, kind, gross_amount_in_cents, currency)
           VALUES ($1, $2, $3, $4, 'cash_retainer', 1, 'USD')`,
          [randomUUID(), fixtures.openPeriodId, fixtures.projectId, fixtures.memberId],
        ),
    );

    // --- 5. A PAYMENT IS AN ATTESTATION, AND ATTESTATIONS ARE NOT EDITED (§7A).

    await expectRejection(
      client,
      outcomes,
      "a recorded payment's amount cannot be revised",
      TRIGGER_SQLSTATE,
      () =>
        client.query(
          `UPDATE compensation_payment_record SET paid_amount_in_cents = 1 WHERE id = $1`,
          [fixtures.paymentId],
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "a recorded payment cannot be DELETEd",
      TRIGGER_SQLSTATE,
      () =>
        client.query(`DELETE FROM compensation_payment_record WHERE id = $1`, [fixtures.paymentId]),
    );

    await expectAcceptance(
      client,
      outcomes,
      "the MEMBER's confirmation is the one write allowed after the fact",
      () =>
        client.query(
          `UPDATE compensation_payment_record
              SET confirmed_by_member_at = now(), confirmed_by_user_id = $2
            WHERE id = $1`,
          [fixtures.paymentId, fixtures.memberUserId],
        ),
    );

    await client.query(
      `UPDATE compensation_payment_record
          SET confirmed_by_member_at = now(), confirmed_by_user_id = $2
        WHERE id = $1`,
      [fixtures.paymentId, fixtures.memberUserId],
    );

    await expectRejection(
      client,
      outcomes,
      "a confirmation is recorded once and never CLEARED",
      TRIGGER_SQLSTATE,
      () =>
        client.query(
          `UPDATE compensation_payment_record
              SET confirmed_by_member_at = NULL, confirmed_by_user_id = NULL
            WHERE id = $1`,
          [fixtures.paymentId],
        ),
    );

    await expectRejection(
      client,
      outcomes,
      "a retried POST cannot record the same payment twice",
      UNIQUE_VIOLATION,
      () =>
        client.query(
          `INSERT INTO compensation_payment_record
             (id, line_id, project_id, paid_amount_in_cents, currency, paid_on_date, method_key,
              recorded_by_user_id, idempotency_key)
           VALUES ($1, $2, $3, 600000, 'USD', '2026-05-03', 'bank_transfer', $4,
                   'verify-key-0001')`,
          [randomUUID(), fixtures.finalizedLineId, fixtures.projectId, fixtures.founderUserId],
        ),
    );

    // --- 6. §4f, EXERCISED. A user with statement history cannot be hard-deleted.

    await expectRejection(
      client,
      outcomes,
      "a user with statement history CANNOT be deleted — §17 step 9's loud failure",
      FOREIGN_KEY_VIOLATION,
      () => client.query(`DELETE FROM "user" WHERE id = $1`, [fixtures.founderUserId]),
    );

    await expectRejection(
      client,
      outcomes,
      "a project with statement history cannot be deleted either",
      FOREIGN_KEY_VIOLATION,
      () => client.query(`DELETE FROM research_project WHERE id = $1`, [fixtures.projectId]),
    );
  } finally {
    // Always. Nothing this script writes is ever committed.
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }

  return outcomes;
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
      ? `\nAll ${outcomes.length} compensation guarantees verified.`
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
    console.error("Compensation constraint verification failed to run:", error);
    await pool.end();
    process.exit(1);
  });
