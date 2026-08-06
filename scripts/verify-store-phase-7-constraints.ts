/**
 * Verifies Store Phase 7 trust MVP database invariants after migrations 0052–0053.
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
  "commerce_completion_relationship_guard",
  "commerce_review_relationship_guard",
  "commerce_dispute_relationship_guard",
  "commerce_dispute_freeze_guard",
  "commerce_order_dispute_freeze_guard",
];

const EXPECTED_INDEXES: readonly string[] = [
  "commerce_completion_product_line_uidx",
  "commerce_completion_engagement_uidx",
  "commerce_review_completion_reviewer_uidx",
  "commerce_dispute_open_order_uidx",
  "commerce_dispute_event_sequence_uidx",
];

const EXPECTED_CONSTRAINTS: readonly {
  readonly tableName: string;
  readonly constraintName: string;
}[] = [
  {
    tableName: "commerce_engagement_deliverable_event",
    constraintName: "commerce_engagement_deliverable_event_evidence_document_id_fk",
  },
  {
    tableName: "commerce_engagement_deliverable_event",
    constraintName: "commerce_engagement_deliverable_event_result_snapshot_ck",
  },
  { tableName: "commerce_completion", constraintName: "commerce_completion_target_ck" },
  { tableName: "commerce_completion", constraintName: "commerce_completion_counterparty_ck" },
  { tableName: "commerce_review", constraintName: "commerce_review_rating_ck" },
  { tableName: "commerce_review", constraintName: "commerce_review_body_ck" },
  { tableName: "commerce_review", constraintName: "commerce_review_self_ck" },
  { tableName: "commerce_dispute", constraintName: "commerce_dispute_decision_ck" },
  { tableName: "commerce_dispute", constraintName: "commerce_dispute_parties_ck" },
  { tableName: "commerce_dispute", constraintName: "commerce_dispute_prior_state_ck" },
  { tableName: "commerce_dispute", constraintName: "commerce_dispute_prior_snapshot_ck" },
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
    label: "Phase 7 append-only and relationship triggers exist and are enabled",
    passed: triggerCount === EXPECTED_TRIGGERS.length,
    detail: `${String(triggerCount)}/${String(EXPECTED_TRIGGERS.length)}`,
  });

  const deferredFreezeTriggerCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM pg_trigger AS trigger_definition
       INNER JOIN pg_class AS target_table
         ON target_table.oid = trigger_definition.tgrelid
       INNER JOIN pg_namespace AS target_schema
         ON target_schema.oid = target_table.relnamespace
      WHERE NOT trigger_definition.tgisinternal
        AND target_schema.nspname = 'public'
        AND trigger_definition.tgenabled = 'O'
        AND trigger_definition.tgdeferrable
        AND trigger_definition.tginitdeferred
        AND trigger_definition.tgname = ANY($1)`,
    [["commerce_dispute_freeze_guard", "commerce_order_dispute_freeze_guard"]],
  );
  outcomes.push({
    label: "open-dispute freeze guards are deferred until transaction commit",
    passed: deferredFreezeTriggerCount === 2,
    detail: `${String(deferredFreezeTriggerCount)}/2`,
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

  const constraintCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM unnest($1::text[], $2::text[]) AS expected(table_name, constraint_name)
       INNER JOIN pg_class AS target_table
         ON target_table.relname = expected.table_name
       INNER JOIN pg_namespace AS target_schema
         ON target_schema.oid = target_table.relnamespace
       INNER JOIN pg_constraint AS constraint_definition
         ON constraint_definition.conrelid = target_table.oid
        AND constraint_definition.conname = expected.constraint_name
      WHERE target_schema.nspname = 'public'
        AND constraint_definition.convalidated`,
    [
      EXPECTED_CONSTRAINTS.map((expectedConstraint) => expectedConstraint.tableName),
      EXPECTED_CONSTRAINTS.map((expectedConstraint) => expectedConstraint.constraintName),
    ],
  );
  outcomes.push({
    label: "Phase 7 trust constraints exist",
    passed: constraintCount === EXPECTED_CONSTRAINTS.length,
    detail: `${String(constraintCount)}/${String(EXPECTED_CONSTRAINTS.length)}`,
  });

  const invalidCompletions = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_completion
      WHERE (target_kind = 'product_order_line'
              AND (
                order_product_line_id IS NULL
                OR service_engagement_id IS NOT NULL
                OR product_id IS NULL
              ))
         OR (target_kind = 'service_engagement'
              AND (
                service_engagement_id IS NULL
                OR order_product_line_id IS NOT NULL
                OR product_id IS NOT NULL
              ))`,
  );
  outcomes.push({
    label: "completions retain exactly one target source",
    passed: invalidCompletions === 0,
    detail: `${String(invalidCompletions)} invalid completion(s)`,
  });

  const inconsistentCompletionSources = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_completion AS completion
       INNER JOIN commerce_order
         ON commerce_order.id = completion.order_id
       LEFT JOIN commerce_order_product_line AS product_line
         ON product_line.id = completion.order_product_line_id
       LEFT JOIN commerce_service_engagement AS engagement
         ON engagement.id = completion.service_engagement_id
      WHERE completion.buyer_organization_id <> commerce_order.buyer_organization_id
         OR (
           commerce_order.state NOT IN (
             'confirmed',
             'in_fulfillment',
             'partially_completed',
             'completed'
           )
           AND NOT (
             commerce_order.state = 'disputed'
             AND EXISTS (
               SELECT 1
                 FROM commerce_dispute
                WHERE commerce_dispute.order_id = commerce_order.id
                  AND commerce_dispute.state = 'open'
                  AND commerce_dispute.prior_order_state IN (
                    'confirmed',
                    'in_fulfillment',
                    'partially_completed',
                    'completed'
                  )
             )
           )
         )
         OR (
           completion.target_kind = 'product_order_line'
           AND (
             completion.counterparty_organization_id <> commerce_order.counterparty_organization_id
             OR product_line.id IS NULL
             OR product_line.order_id <> completion.order_id
             OR product_line.product_id IS DISTINCT FROM completion.product_id
             OR product_line.quantity_fulfilled <= 0
             OR product_line.quantity_fulfilled + product_line.quantity_cancelled
                < product_line.quantity_ordered
           )
         )
         OR (
           completion.target_kind = 'service_engagement'
           AND (
             engagement.id IS NULL
             OR engagement.order_id <> completion.order_id
             OR engagement.buyer_organization_id <> completion.buyer_organization_id
             OR engagement.provider_organization_id <> completion.counterparty_organization_id
             OR engagement.state <> 'completed'
             OR engagement.execution_contract_state <> 'ready'
             OR engagement.requires_deliverable_normalization
             OR EXISTS (
               SELECT 1
                 FROM commerce_engagement_deliverable AS deliverable
                WHERE deliverable.engagement_id = engagement.id
                  AND deliverable.is_required
                  AND deliverable.state NOT IN ('accepted', 'waived')
             )
           )
         )`,
  );
  outcomes.push({
    label: "completion sources match authoritative orders and fulfillment records",
    passed: inconsistentCompletionSources === 0,
    detail: `${String(inconsistentCompletionSources)} inconsistent completion source(s)`,
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

  const inconsistentReviews = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_review AS review
       INNER JOIN commerce_completion AS completion
         ON completion.id = review.completion_id
       INNER JOIN commerce_organization_member AS reviewer_member
         ON reviewer_member.id = review.reviewer_member_id
      WHERE review.reviewer_organization_id <> completion.buyer_organization_id
         OR review.subject_organization_id <> completion.counterparty_organization_id
         OR review.product_id IS DISTINCT FROM completion.product_id
         OR reviewer_member.organization_id <> review.reviewer_organization_id`,
  );
  outcomes.push({
    label: "reviews retain completion subjects and reviewer membership",
    passed: inconsistentReviews === 0,
    detail: `${String(inconsistentReviews)} inconsistent review(s)`,
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

  const inconsistentDisputes = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_dispute AS dispute
       INNER JOIN commerce_order
         ON commerce_order.id = dispute.order_id
       INNER JOIN commerce_organization_member AS opener_member
         ON opener_member.id = dispute.opened_by_member_id
      WHERE dispute.opened_by_organization_id <> dispute.buyer_organization_id
         OR opener_member.organization_id <> dispute.opened_by_organization_id
         OR dispute.buyer_organization_id <> commerce_order.buyer_organization_id
         OR dispute.counterparty_organization_id <> commerce_order.counterparty_organization_id
         OR (dispute.order_snapshot_json::jsonb->>'state')
            IS DISTINCT FROM dispute.prior_order_state::text
         OR (dispute.state = 'open' AND commerce_order.state <> 'disputed')`,
  );
  outcomes.push({
    label: "disputes retain order parties, opener membership, and freeze state",
    passed: inconsistentDisputes === 0,
    detail: `${String(inconsistentDisputes)} inconsistent dispute(s)`,
  });

  const disputedOrdersWithoutOpenCases = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_order
      WHERE state = 'disputed'
        AND NOT EXISTS (
          SELECT 1
            FROM commerce_dispute
           WHERE commerce_dispute.order_id = commerce_order.id
             AND commerce_dispute.state = 'open'
        )`,
  );
  outcomes.push({
    label: "disputed orders always retain an open dispute case",
    passed: disputedOrdersWithoutOpenCases === 0,
    detail: `${String(disputedOrdersWithoutOpenCases)} orphan disputed order(s)`,
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

  const inconsistentDisputeTimelines = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_dispute AS dispute
       LEFT JOIN LATERAL (
         SELECT event.sequence, event.event_kind
           FROM commerce_dispute_event AS event
          WHERE event.dispute_id = dispute.id
          ORDER BY event.sequence ASC
          LIMIT 1
       ) AS first_event ON true
       LEFT JOIN LATERAL (
         SELECT event.sequence, event.event_kind
           FROM commerce_dispute_event AS event
          WHERE event.dispute_id = dispute.id
          ORDER BY event.sequence DESC
          LIMIT 1
       ) AS last_event ON true
      WHERE first_event.sequence IS DISTINCT FROM 0
         OR first_event.event_kind IS DISTINCT FROM 'opened'
         OR (
           dispute.state IN ('closed', 'dismissed')
           AND last_event.event_kind::text IS DISTINCT FROM dispute.state::text
         )`,
  );
  outcomes.push({
    label: "dispute timelines begin opened and end with terminal decisions",
    passed: inconsistentDisputeTimelines === 0,
    detail: `${String(inconsistentDisputeTimelines)} inconsistent timeline(s)`,
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
