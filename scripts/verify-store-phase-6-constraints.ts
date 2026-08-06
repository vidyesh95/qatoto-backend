/**
 * Verifies Store Phase 6 database invariants after migration 0048.
 *
 *   pnpm run db:verify-store-phase-6-constraints
 */
import "dotenv/config";
import { pool } from "#src/db/index.js";

interface CheckOutcome {
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

const EXPECTED_TABLES: readonly string[] = [
  "commerce_shipment_leg",
  "commerce_shipment_leg_event",
  "commerce_service_engagement_event",
  "commerce_fulfillment_command",
  "freight_engagement_detail",
  "customs_brokerage_engagement_detail",
  "insurance_engagement_detail",
  "inspection_engagement_detail",
  "testing_certification_engagement_detail",
  "marketing_engagement_detail",
  "warehouse_engagement_detail",
  "foreign_exchange_engagement_detail",
  "commerce_engagement_deliverable",
  "commerce_engagement_deliverable_event",
  "customs_brokerage_deliverable_detail",
  "insurance_deliverable_detail",
  "inspection_deliverable_detail",
  "testing_certification_deliverable_detail",
  "warehouse_deliverable_detail",
  "marketing_deliverable_detail",
  "foreign_exchange_deliverable_detail",
];

const EXPECTED_TRIGGERS: readonly string[] = [
  "commerce_shipment_leg_event_append_only",
  "commerce_shipment_leg_event_no_truncate",
  "commerce_service_engagement_event_append_only",
  "commerce_service_engagement_event_no_truncate",
  "commerce_fulfillment_command_append_only",
  "commerce_fulfillment_command_no_truncate",
  "commerce_engagement_deliverable_event_append_only",
  "commerce_engagement_deliverable_event_no_truncate",
  "freight_engagement_detail_append_only",
  "customs_brokerage_engagement_detail_append_only",
  "insurance_engagement_detail_append_only",
  "inspection_engagement_detail_append_only",
  "testing_certification_engagement_detail_append_only",
  "marketing_engagement_detail_append_only",
  "warehouse_engagement_detail_append_only",
  "foreign_exchange_engagement_detail_append_only",
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
    label: "all store phase 6 tables exist",
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
    label: "Phase 6 append-only triggers exist",
    passed: triggerCount === EXPECTED_TRIGGERS.length,
    detail: `${String(triggerCount)}/${String(EXPECTED_TRIGGERS.length)}`,
  });

  const orphanLegs = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_shipment_leg AS leg
      WHERE NOT EXISTS (
        SELECT 1 FROM commerce_shipment AS shipment
         WHERE shipment.id = leg.shipment_id
      )`,
  );
  outcomes.push({
    label: "shipment legs retain shipments",
    passed: orphanLegs === 0,
    detail: `${String(orphanLegs)} orphan leg(s)`,
  });

  const orphanLegEvents = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_shipment_leg_event AS event
      WHERE NOT EXISTS (
        SELECT 1 FROM commerce_shipment_leg AS leg
         WHERE leg.id = event.shipment_leg_id
      )`,
  );
  outcomes.push({
    label: "shipment leg events retain legs",
    passed: orphanLegEvents === 0,
    detail: `${String(orphanLegEvents)} orphan event(s)`,
  });

  const duplicateLegSequences = await countQuery(
    `SELECT count(*) AS row_count
       FROM (
         SELECT shipment_id, sequence
           FROM commerce_shipment_leg
          GROUP BY shipment_id, sequence
         HAVING count(*) > 1
       ) AS duplicates`,
  );
  outcomes.push({
    label: "shipment leg sequences are unique per shipment",
    passed: duplicateLegSequences === 0,
    detail: `${String(duplicateLegSequences)} duplicate sequence(s)`,
  });

  const mismatchedFreight = await countQuery(
    `SELECT count(*) AS row_count
       FROM freight_engagement_detail AS detail
       INNER JOIN commerce_service_engagement AS engagement
         ON engagement.id = detail.engagement_id
      WHERE engagement.provider_kind NOT IN ('freight_forwarder', 'logistics_operator')`,
  );
  outcomes.push({
    label: "freight engagement details match freight/logistics kinds",
    passed: mismatchedFreight === 0,
    detail: `${String(mismatchedFreight)} mismatch(es)`,
  });

  const mismatchedCustoms = await countQuery(
    `SELECT count(*) AS row_count
       FROM customs_brokerage_engagement_detail AS detail
       INNER JOIN commerce_service_engagement AS engagement
         ON engagement.id = detail.engagement_id
      WHERE engagement.provider_kind <> 'customs_broker'`,
  );
  outcomes.push({
    label: "customs engagement details match customs_broker",
    passed: mismatchedCustoms === 0,
    detail: `${String(mismatchedCustoms)} mismatch(es)`,
  });

  const readyWithoutDetail = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_service_engagement AS engagement
      WHERE engagement.execution_contract_state = 'ready'
        AND NOT EXISTS (SELECT 1 FROM freight_engagement_detail d WHERE d.engagement_id = engagement.id)
        AND NOT EXISTS (SELECT 1 FROM customs_brokerage_engagement_detail d WHERE d.engagement_id = engagement.id)
        AND NOT EXISTS (SELECT 1 FROM insurance_engagement_detail d WHERE d.engagement_id = engagement.id)
        AND NOT EXISTS (SELECT 1 FROM inspection_engagement_detail d WHERE d.engagement_id = engagement.id)
        AND NOT EXISTS (SELECT 1 FROM testing_certification_engagement_detail d WHERE d.engagement_id = engagement.id)
        AND NOT EXISTS (SELECT 1 FROM marketing_engagement_detail d WHERE d.engagement_id = engagement.id)
        AND NOT EXISTS (SELECT 1 FROM warehouse_engagement_detail d WHERE d.engagement_id = engagement.id)
        AND NOT EXISTS (SELECT 1 FROM foreign_exchange_engagement_detail d WHERE d.engagement_id = engagement.id)`,
  );
  outcomes.push({
    label: "ready engagements retain at least one typed detail snapshot",
    passed: readyWithoutDetail === 0,
    detail: `${String(readyWithoutDetail)} ready engagement(s) without snapshot`,
  });

  const legacyWithDetail = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_service_engagement AS engagement
      WHERE engagement.execution_contract_state = 'legacy_missing_snapshot'
        AND (
          EXISTS (SELECT 1 FROM freight_engagement_detail d WHERE d.engagement_id = engagement.id)
          OR EXISTS (SELECT 1 FROM customs_brokerage_engagement_detail d WHERE d.engagement_id = engagement.id)
          OR EXISTS (SELECT 1 FROM insurance_engagement_detail d WHERE d.engagement_id = engagement.id)
          OR EXISTS (SELECT 1 FROM inspection_engagement_detail d WHERE d.engagement_id = engagement.id)
          OR EXISTS (SELECT 1 FROM testing_certification_engagement_detail d WHERE d.engagement_id = engagement.id)
          OR EXISTS (SELECT 1 FROM marketing_engagement_detail d WHERE d.engagement_id = engagement.id)
          OR EXISTS (SELECT 1 FROM warehouse_engagement_detail d WHERE d.engagement_id = engagement.id)
          OR EXISTS (SELECT 1 FROM foreign_exchange_engagement_detail d WHERE d.engagement_id = engagement.id)
        )`,
  );
  outcomes.push({
    label: "legacy_missing_snapshot engagements do not invent typed snapshots",
    passed: legacyWithDetail === 0,
    detail: `${String(legacyWithDetail)} contradictory engagement(s)`,
  });

  const orphanDeliverables = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_engagement_deliverable AS deliverable
      WHERE NOT EXISTS (
        SELECT 1 FROM commerce_service_engagement AS engagement
         WHERE engagement.id = deliverable.engagement_id
      )`,
  );
  outcomes.push({
    label: "deliverables retain engagements",
    passed: orphanDeliverables === 0,
    detail: `${String(orphanDeliverables)} orphan deliverable(s)`,
  });

  const duplicateCommandKeys = await countQuery(
    `SELECT count(*) AS row_count
       FROM (
         SELECT actor_organization_id, idempotency_key
           FROM commerce_fulfillment_command
          GROUP BY actor_organization_id, idempotency_key
         HAVING count(*) > 1
       ) AS duplicates`,
  );
  outcomes.push({
    label: "fulfillment command idempotency keys are unique per organization",
    passed: duplicateCommandKeys === 0,
    detail: `${String(duplicateCommandKeys)} duplicate key(s)`,
  });

  const missingVersionColumns = await countQuery(
    `SELECT count(*) AS row_count
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (
          (table_name = 'commerce_shipment' AND column_name = 'version')
          OR (table_name = 'commerce_service_engagement' AND column_name = 'version')
          OR (table_name = 'commerce_service_engagement' AND column_name = 'execution_contract_state')
          OR (table_name = 'commerce_order_service_line' AND column_name = 'source_quote_service_line_id')
        )`,
  );
  outcomes.push({
    label: "Phase 6 columns exist on shipment, engagement, and order service line",
    passed: missingVersionColumns === 4,
    detail: `${String(missingVersionColumns)}/4 columns`,
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
