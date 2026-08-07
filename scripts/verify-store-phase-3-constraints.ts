/**
 * Verifies Store Phase 3 database invariants after migration 0045.
 *
 *   npm run db:verify-store-phase-3-constraints
 */
import "dotenv/config";
import { pool } from "#src/db/index.js";

interface CheckOutcome {
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

const EXPECTED_TABLES: readonly string[] = [
  "commerce_rfq",
  "commerce_rfq_product_line",
  "commerce_rfq_service_line",
  "commerce_rfq_invitation",
  "commerce_rfq_document",
  "freight_rfq_requirement_detail",
  "customs_brokerage_rfq_requirement_detail",
  "insurance_rfq_requirement_detail",
  "inspection_rfq_requirement_detail",
  "testing_certification_rfq_requirement_detail",
  "marketing_rfq_requirement_detail",
  "warehouse_rfq_requirement_detail",
  "foreign_exchange_rfq_requirement_detail",
  "commerce_quote",
  "commerce_quote_revision",
  "commerce_quote_product_line",
  "commerce_quote_service_line",
  "freight_quote_service_detail",
  "customs_brokerage_quote_service_detail",
  "insurance_quote_service_detail",
  "inspection_quote_service_detail",
  "testing_certification_quote_service_detail",
  "marketing_quote_service_detail",
  "warehouse_quote_service_detail",
  "foreign_exchange_quote_service_detail",
  "commerce_order",
  "commerce_order_product_line",
  "commerce_order_service_line",
  "commerce_thread",
  "commerce_thread_participant",
  "commerce_message",
  "commerce_message_attachment",
];

const EXPECTED_TRIGGERS: readonly string[] = [
  "commerce_quote_revision_append_only",
  "commerce_message_append_only",
  "commerce_order_snapshot_append_only",
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
    label: "all store phase 3 tables exist",
    passed: tableCount === EXPECTED_TABLES.length,
    detail: `${String(tableCount)}/${String(EXPECTED_TABLES.length)}`,
  });

  const triggerCount = await countQuery(
    /**
     * `pg_trigger`, NOT `information_schema.triggers`.
     *
     * The information-schema view emits ONE ROW PER TRIGGERING EVENT, so an append-only
     * trigger declared `BEFORE UPDATE OR DELETE` counted twice and this check reported
     * 6/3. It fails in the other direction too: three triggers that each fired on only
     * one event would also total three and pass while doing half the job.
     */
    `SELECT count(*) AS row_count
       FROM pg_trigger AS trigger_definition
       INNER JOIN pg_class AS target_table
         ON target_table.oid = trigger_definition.tgrelid
       INNER JOIN pg_namespace AS target_schema
         ON target_schema.oid = target_table.relnamespace
      WHERE NOT trigger_definition.tgisinternal
        AND target_schema.nspname = 'public'
        AND trigger_definition.tgname = ANY($1)`,
    [EXPECTED_TRIGGERS],
  );
  outcomes.push({
    label: "append-only Phase 3 triggers exist",
    passed: triggerCount === EXPECTED_TRIGGERS.length,
    detail: `${String(triggerCount)}/${String(EXPECTED_TRIGGERS.length)}`,
  });

  const auditEnumValues = await countQuery(
    `SELECT count(*) AS row_count
       FROM pg_enum AS e
       JOIN pg_type AS t ON t.oid = e.enumtypid
      WHERE t.typname = 'commerce_organization_audit_event_kind'
        AND e.enumlabel = ANY($1)`,
    [
      [
        "rfq_opened",
        "rfq_closed",
        "rfq_awarded",
        "quote_submitted",
        "quote_accepted",
        "quote_declined",
        "quote_withdrawn",
        "order_created_from_quote",
      ],
    ],
  );
  outcomes.push({
    label: "Phase 3 audit event kinds registered",
    passed: auditEnumValues === 8,
    detail: `${String(auditEnumValues)}/8`,
  });

  const duplicateInvitations = await countQuery(
    `SELECT count(*) AS row_count
       FROM (
         SELECT rfq_id, provider_organization_id
         FROM commerce_rfq_invitation
         GROUP BY rfq_id, provider_organization_id
         HAVING count(*) > 1
       ) AS duplicates`,
  );
  outcomes.push({
    label: "RFQ invitations unique per provider",
    passed: duplicateInvitations === 0,
    detail: `${String(duplicateInvitations)} duplicate(s)`,
  });

  const duplicateQuotes = await countQuery(
    `SELECT count(*) AS row_count
       FROM (
         SELECT rfq_id, provider_organization_id
         FROM commerce_quote
         GROUP BY rfq_id, provider_organization_id
         HAVING count(*) > 1
       ) AS duplicates`,
  );
  outcomes.push({
    label: "quotes unique per provider/RFQ",
    passed: duplicateQuotes === 0,
    detail: `${String(duplicateQuotes)} duplicate(s)`,
  });

  const duplicateRevisionNumbers = await countQuery(
    `SELECT count(*) AS row_count
       FROM (
         SELECT quote_id, revision_number
         FROM commerce_quote_revision
         GROUP BY quote_id, revision_number
         HAVING count(*) > 1
       ) AS duplicates`,
  );
  outcomes.push({
    label: "quote revision numbers unique",
    passed: duplicateRevisionNumbers === 0,
    detail: `${String(duplicateRevisionNumbers)} duplicate(s)`,
  });

  const moneyMismatchCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_quote_revision
      WHERE total_in_cents <> (subtotal_in_cents + tax_in_cents + service_fee_in_cents
            + shipping_in_cents - discount_in_cents)`,
  );
  outcomes.push({
    label: "quote revision totals reconcile",
    passed: moneyMismatchCount === 0,
    detail: `${String(moneyMismatchCount)} mismatched revision(s)`,
  });

  const orderMoneyMismatchCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_order
      WHERE total_in_cents <> (subtotal_in_cents + tax_in_cents + service_fee_in_cents
            + shipping_in_cents - discount_in_cents)`,
  );
  outcomes.push({
    label: "order snapshot totals reconcile",
    passed: orderMoneyMismatchCount === 0,
    detail: `${String(orderMoneyMismatchCount)} mismatched order(s)`,
  });

  const orphanAcceptedOrders = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_order AS o
       LEFT JOIN commerce_quote AS q ON q.id = o.accepted_quote_id
      WHERE o.source = 'accepted_quote'
        AND (o.accepted_quote_id IS NULL OR o.accepted_quote_revision_id IS NULL OR q.id IS NULL)`,
  );
  outcomes.push({
    label: "accepted-quote orders retain quote references",
    passed: orphanAcceptedOrders === 0,
    detail: `${String(orphanAcceptedOrders)} orphan order(s)`,
  });

  const multiAcceptedQuotes = await countQuery(
    `SELECT count(*) AS row_count
       FROM (
         SELECT accepted_quote_id
         FROM commerce_order
         WHERE accepted_quote_id IS NOT NULL
         GROUP BY accepted_quote_id
         HAVING count(*) > 1
       ) AS duplicates`,
  );
  outcomes.push({
    label: "at most one order per accepted quote",
    passed: multiAcceptedQuotes === 0,
    detail: `${String(multiAcceptedQuotes)} quote(s) with multiple orders`,
  });

  const serviceLinesMissingRequirements = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_rfq_service_line AS line
       JOIN commerce_rfq AS rfq ON rfq.id = line.rfq_id
      WHERE rfq.state IN ('open', 'closed', 'awarded')
        AND NOT EXISTS (
          SELECT 1 FROM freight_rfq_requirement_detail d WHERE d.service_line_id = line.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM customs_brokerage_rfq_requirement_detail d WHERE d.service_line_id = line.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM insurance_rfq_requirement_detail d WHERE d.service_line_id = line.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM inspection_rfq_requirement_detail d WHERE d.service_line_id = line.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM testing_certification_rfq_requirement_detail d WHERE d.service_line_id = line.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM marketing_rfq_requirement_detail d WHERE d.service_line_id = line.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM warehouse_rfq_requirement_detail d WHERE d.service_line_id = line.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM foreign_exchange_rfq_requirement_detail d WHERE d.service_line_id = line.id
        )`,
  );
  outcomes.push({
    label: "opened RFQ service lines retain typed requirements",
    passed: serviceLinesMissingRequirements === 0,
    detail: `${String(serviceLinesMissingRequirements)} missing requirement row(s)`,
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
    return;
  }
  console.log("Store Phase 3 constraints verified.");
}

main().catch(async (error: unknown) => {
  console.error(error);
  await pool.end().catch(() => undefined);
  process.exitCode = 1;
});
