/**
 * Verifies Store Phase 7 trust MVP database invariants after migration 0052.
 *
 *   pnpm run db:verify-store-phase-7-constraints
 */
import "dotenv/config";
import { pool } from "#src/db/index.js";

interface CheckOutcome {
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

const EXPECTED_TABLES: readonly string[] = [
  "commerce_completion",
  "commerce_review",
  "commerce_dispute",
  "commerce_dispute_event",
];

const EXPECTED_TRIGGERS: readonly string[] = [
  "commerce_completion_append_only",
  "commerce_completion_no_truncate",
  "commerce_dispute_event_append_only",
  "commerce_dispute_event_no_truncate",
];

const EXPECTED_INDEXES: readonly string[] = [
  "commerce_completion_product_line_uidx",
  "commerce_completion_engagement_uidx",
  "commerce_review_completion_reviewer_uidx",
  "commerce_dispute_open_order_uidx",
  "commerce_dispute_event_sequence_uidx",
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
    label: "all store phase 7 tables exist",
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
        AND t.tgenabled = 'O'
        AND t.tgname = ANY($1)`,
    [EXPECTED_TRIGGERS],
  );
  outcomes.push({
    label: "Phase 7 append-only triggers exist and are enabled",
    passed: triggerCount === EXPECTED_TRIGGERS.length,
    detail: `${String(triggerCount)}/${String(EXPECTED_TRIGGERS.length)}`,
  });

  const indexCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = ANY($1)`,
    [EXPECTED_INDEXES],
  );
  outcomes.push({
    label: "Phase 7 uniqueness indexes exist",
    passed: indexCount === EXPECTED_INDEXES.length,
    detail: `${String(indexCount)}/${String(EXPECTED_INDEXES.length)}`,
  });

  const invalidCompletions = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_completion
      WHERE (target_kind = 'product_order_line'
              AND (order_product_line_id IS NULL OR service_engagement_id IS NOT NULL))
         OR (target_kind = 'service_engagement'
              AND (service_engagement_id IS NULL OR order_product_line_id IS NOT NULL))`,
  );
  outcomes.push({
    label: "completions retain exactly one target source",
    passed: invalidCompletions === 0,
    detail: `${String(invalidCompletions)} invalid completion(s)`,
  });

  const orphanReviews = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_review AS review
      WHERE NOT EXISTS (
        SELECT 1 FROM commerce_completion AS completion
         WHERE completion.id = review.completion_id
      )`,
  );
  outcomes.push({
    label: "reviews retain completions",
    passed: orphanReviews === 0,
    detail: `${String(orphanReviews)} orphan review(s)`,
  });

  const selfReviews = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_review
      WHERE reviewer_organization_id = subject_organization_id`,
  );
  outcomes.push({
    label: "reviews never target the reviewer organization",
    passed: selfReviews === 0,
    detail: `${String(selfReviews)} self-review(s)`,
  });

  const duplicateOpenDisputes = await countQuery(
    `SELECT count(*) AS row_count
       FROM (
         SELECT order_id
           FROM commerce_dispute
          WHERE state = 'open'
          GROUP BY order_id
         HAVING count(*) > 1
       ) AS duplicates`,
  );
  outcomes.push({
    label: "at most one open dispute exists per order",
    passed: duplicateOpenDisputes === 0,
    detail: `${String(duplicateOpenDisputes)} duplicate open dispute(s)`,
  });

  const gaplessDisputeEvents = await countQuery(
    `SELECT count(*) AS row_count
       FROM (
         SELECT dispute_id
           FROM commerce_dispute_event
          GROUP BY dispute_id
         HAVING min(sequence) <> 0
             OR max(sequence) + 1 <> count(*)
       ) AS gapped`,
  );
  outcomes.push({
    label: "dispute event sequences are gapless from zero",
    passed: gaplessDisputeEvents === 0,
    detail: `${String(gaplessDisputeEvents)} gapped dispute(s)`,
  });

  const selfCounterpartyCompletions = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_completion
      WHERE buyer_organization_id = counterparty_organization_id`,
  );
  outcomes.push({
    label: "completions exclude self-counterparty relationships",
    passed: selfCounterpartyCompletions === 0,
    detail: `${String(selfCounterpartyCompletions)} self-counterparty completion(s)`,
  });

  return outcomes;
}

async function main(): Promise<void> {
  const outcomes = await verifyPhaseConstraints();
  let hasFailure = false;
  for (const outcome of outcomes) {
    const outcomeMark = outcome.passed ? "PASS" : "FAIL";
    console.log(`[${outcomeMark}] ${outcome.label} — ${outcome.detail}`);
    if (!outcome.passed) hasFailure = true;
  }

  await pool.end();
  if (hasFailure) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
  void pool.end();
});
