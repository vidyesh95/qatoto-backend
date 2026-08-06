/**
 * Verifies Store Phase 5 database invariants after migration 0047.
 *
 *   npm run db:verify-store-phase-5-constraints
 */
import "dotenv/config";
import { pool } from "#src/db/index.js";

interface CheckOutcome {
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

const EXPECTED_TABLES: readonly string[] = [
  "commerce_payment_intent",
  "commerce_provider_transfer",
  "commerce_refund",
  "commerce_journal_account",
  "commerce_journal_entry",
  "commerce_journal_line",
  "commerce_payment_outbox",
  "commerce_payment_webhook_event",
];

const EXPECTED_TRIGGERS: readonly string[] = [
  "commerce_journal_entry_append_only",
  "commerce_journal_entry_no_truncate",
  "commerce_journal_line_append_only",
  "commerce_journal_line_no_truncate",
  "commerce_journal_account_append_only",
  "commerce_journal_account_no_truncate",
  "commerce_payment_webhook_event_process_only",
  "commerce_payment_webhook_event_no_delete",
  "commerce_payment_webhook_event_no_truncate",
  "commerce_journal_line_zero_sum",
];

async function countQuery(queryText: string, values: readonly unknown[] = []): Promise<number> {
  const queryResult = await pool.query<{ readonly row_count: string }>(queryText, [...values]);
  return Number(queryResult.rows[0]?.row_count ?? 0);
}

async function verifyPhaseConstraints(): Promise<readonly CheckOutcome[]> {
  const outcomes: CheckOutcome[] = [];

  const tableCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [EXPECTED_TABLES],
  );
  outcomes.push({
    label: "all store phase 5 tables exist",
    passed: tableCount === EXPECTED_TABLES.length,
    detail: `${String(tableCount)}/${String(EXPECTED_TABLES.length)}`,
  });

  const triggerCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM pg_trigger AS t
       INNER JOIN pg_class AS c ON c.oid = t.tgrelid
       INNER JOIN pg_namespace AS n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal
        AND n.nspname = 'public'
        AND t.tgname = ANY($1)`,
    [EXPECTED_TRIGGERS],
  );
  outcomes.push({
    label: "Phase 5 journal and webhook triggers exist",
    passed: triggerCount === EXPECTED_TRIGGERS.length,
    detail: `${String(triggerCount)}/${String(EXPECTED_TRIGGERS.length)}`,
  });

  const unbalancedEntries = await countQuery(
    `SELECT count(*) AS row_count
       FROM (
         SELECT journal_entry_id
           FROM commerce_journal_line
          GROUP BY journal_entry_id
         HAVING count(*) < 2 OR sum(signed_amount_in_cents) <> 0
       ) AS unbalanced`,
  );
  outcomes.push({
    label: "commerce journal entries balance to zero",
    passed: unbalancedEntries === 0,
    detail: `${String(unbalancedEntries)} unbalanced entry(ies)`,
  });

  const orphanLines = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_journal_line AS line
      WHERE NOT EXISTS (
        SELECT 1 FROM commerce_journal_entry AS entry
         WHERE entry.id = line.journal_entry_id
      )`,
  );
  outcomes.push({
    label: "journal lines retain entries",
    passed: orphanLines === 0,
    detail: `${String(orphanLines)} orphan line(s)`,
  });

  const currencyMismatch = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_payment_intent AS intent
       INNER JOIN commerce_order AS ord ON ord.id = intent.order_id
      WHERE intent.currency <> ord.currency
         OR intent.amount_in_cents <> ord.total_in_cents`,
  );
  outcomes.push({
    label: "payment intents match order snapshots",
    passed: currencyMismatch === 0,
    detail: `${String(currencyMismatch)} mismatched intent(s)`,
  });

  const overRefunds = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_payment_intent AS intent
      WHERE (
        SELECT COALESCE(sum(refund.amount_in_cents), 0)
          FROM commerce_refund AS refund
         WHERE refund.payment_intent_id = intent.id
           AND refund.state IN ('created', 'processing', 'settled')
      ) > intent.amount_in_cents`,
  );
  outcomes.push({
    label: "refund totals do not exceed intent amounts",
    passed: overRefunds === 0,
    detail: `${String(overRefunds)} over-refunded intent(s)`,
  });

  const missingAccounts = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_journal_entry AS entry
      WHERE NOT EXISTS (
        SELECT 1 FROM commerce_journal_account AS account
         WHERE account.order_id = entry.order_id
      )`,
  );
  outcomes.push({
    label: "journal entries retain order accounts",
    passed: missingAccounts === 0,
    detail: `${String(missingAccounts)} entry(ies) without accounts`,
  });

  const sequenceGaps = await countQuery(
    `SELECT count(*) AS row_count
       FROM (
         SELECT order_id, sequence_number,
                lag(sequence_number) OVER (PARTITION BY order_id ORDER BY sequence_number) AS previous_sequence
           FROM commerce_journal_entry
       ) AS sequenced
      WHERE previous_sequence IS NOT NULL
        AND sequence_number <> previous_sequence + 1`,
  );
  outcomes.push({
    label: "journal sequence numbers are gapless per order",
    passed: sequenceGaps === 0,
    detail: `${String(sequenceGaps)} gap(s)`,
  });

  return outcomes;
}

async function main(): Promise<void> {
  const outcomes = await verifyPhaseConstraints();
  let failed = false;
  for (const outcome of outcomes) {
    const mark = outcome.passed ? "PASS" : "FAIL";
    console.log(`[${mark}] ${outcome.label} — ${outcome.detail}`);
    if (!outcome.passed) failed = true;
  }

  await pool.end();
  if (failed) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
  void pool.end();
});
