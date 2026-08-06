/**
 * Verifies Store Phase 6 database invariants after migrations 0048–0051.
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
  "freight_deliverable_detail",
  "customs_brokerage_deliverable_detail",
  "insurance_deliverable_detail",
  "inspection_deliverable_detail",
  "testing_certification_deliverable_detail",
  "warehouse_deliverable_detail",
  "marketing_deliverable_detail",
  "foreign_exchange_deliverable_detail",
  "commerce_quote_service_deliverable_plan",
];

const EXPECTED_SNAPSHOT_TRUNCATE_TRIGGERS: readonly string[] = [
  "freight_engagement_detail_no_truncate",
  "customs_brokerage_engagement_detail_no_truncate",
  "insurance_engagement_detail_no_truncate",
  "inspection_engagement_detail_no_truncate",
  "testing_certification_engagement_detail_no_truncate",
  "marketing_engagement_detail_no_truncate",
  "warehouse_engagement_detail_no_truncate",
  "foreign_exchange_engagement_detail_no_truncate",
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
  ...EXPECTED_SNAPSHOT_TRUNCATE_TRIGGERS,
];

const EXPECTED_CONSTRAINTS: readonly string[] = [
  "commerce_quote_service_deliverable_plan_pkey",
  "commerce_quote_service_deliverable_plan_quote_service_line_id_commerce_quote_service_line_id_fk",
  "commerce_quote_service_deliverable_plan_sequence_ck",
  "commerce_quote_service_deliverable_plan_title_ck",
  "freight_deliverable_detail_pkey",
  "freight_deliverable_detail_deliverable_id_commerce_engagement_deliverable_id_fk",
  "freight_deliverable_detail_summary_ck",
  "insurance_quote_service_detail_amount_currency_pair_ck",
  "foreign_exchange_quote_service_detail_notional_currency_pair_ck",
  "insurance_engagement_detail_amount_currency_pair_ck",
  "foreign_exchange_engagement_detail_notional_currency_pair_ck",
  "insurance_deliverable_detail_amount_currency_pair_ck",
];

const EXPECTED_INDEXES: readonly string[] = [
  "commerce_quote_service_deliverable_plan_sequence_uidx",
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
    label: "Phase 6 mutation-rejection triggers exist",
    passed: triggerCount === EXPECTED_TRIGGERS.length,
    detail: `${String(triggerCount)}/${String(EXPECTED_TRIGGERS.length)}`,
  });

  const snapshotTruncateTriggerCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM pg_trigger AS trigger_definition
       INNER JOIN pg_class AS target_table
         ON target_table.oid = trigger_definition.tgrelid
       INNER JOIN pg_namespace AS target_schema
         ON target_schema.oid = target_table.relnamespace
      WHERE NOT trigger_definition.tgisinternal
        AND target_schema.nspname = 'public'
        AND trigger_definition.tgname = ANY($1)
        AND pg_get_triggerdef(trigger_definition.oid) LIKE '%BEFORE TRUNCATE%'`,
    [EXPECTED_SNAPSHOT_TRUNCATE_TRIGGERS],
  );
  outcomes.push({
    label: "all immutable engagement snapshots reject truncate",
    passed: snapshotTruncateTriggerCount === EXPECTED_SNAPSHOT_TRUNCATE_TRIGGERS.length,
    detail: `${String(snapshotTruncateTriggerCount)}/${String(
      EXPECTED_SNAPSHOT_TRUNCATE_TRIGGERS.length,
    )}`,
  });

  const constraintCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM pg_constraint AS constraint_definition
      WHERE constraint_definition.conname = ANY($1)`,
    [EXPECTED_CONSTRAINTS],
  );
  outcomes.push({
    label: "Phase 6 hardening constraints exist",
    passed: constraintCount === EXPECTED_CONSTRAINTS.length,
    detail: `${String(constraintCount)}/${String(EXPECTED_CONSTRAINTS.length)}`,
  });

  const indexCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = ANY($1)`,
    [EXPECTED_INDEXES],
  );
  outcomes.push({
    label: "Phase 6 hardening indexes exist",
    passed: indexCount === EXPECTED_INDEXES.length,
    detail: `${String(indexCount)}/${String(EXPECTED_INDEXES.length)}`,
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

  const invalidReadySnapshots = await countQuery(
    `WITH typed_snapshots AS (
       SELECT engagement_id, 'freight' AS snapshot_kind FROM freight_engagement_detail
       UNION ALL
       SELECT engagement_id, 'customs_brokerage' FROM customs_brokerage_engagement_detail
       UNION ALL
       SELECT engagement_id, 'insurance' FROM insurance_engagement_detail
       UNION ALL
       SELECT engagement_id, 'inspection' FROM inspection_engagement_detail
       UNION ALL
       SELECT engagement_id, 'testing_certification'
         FROM testing_certification_engagement_detail
       UNION ALL
       SELECT engagement_id, 'marketing' FROM marketing_engagement_detail
       UNION ALL
       SELECT engagement_id, 'warehouse' FROM warehouse_engagement_detail
       UNION ALL
       SELECT engagement_id, 'foreign_exchange' FROM foreign_exchange_engagement_detail
     )
     SELECT count(*) AS row_count
       FROM (
         SELECT engagement.id
           FROM commerce_service_engagement AS engagement
           LEFT JOIN typed_snapshots AS snapshot
             ON snapshot.engagement_id = engagement.id
          WHERE engagement.execution_contract_state = 'ready'
          GROUP BY engagement.id, engagement.provider_kind
         HAVING count(snapshot.snapshot_kind) <> 1
             OR NOT coalesce(
               bool_or(
                 CASE
                   WHEN engagement.provider_kind IN (
                     'freight_forwarder',
                     'logistics_operator'
                   ) THEN snapshot.snapshot_kind = 'freight'
                   WHEN engagement.provider_kind = 'customs_broker'
                     THEN snapshot.snapshot_kind = 'customs_brokerage'
                   WHEN engagement.provider_kind = 'insurance_provider'
                     THEN snapshot.snapshot_kind = 'insurance'
                   WHEN engagement.provider_kind = 'inspection_agency'
                     THEN snapshot.snapshot_kind = 'inspection'
                   WHEN engagement.provider_kind = 'testing_certification_lab'
                     THEN snapshot.snapshot_kind = 'testing_certification'
                   WHEN engagement.provider_kind = 'marketing_agency'
                     THEN snapshot.snapshot_kind = 'marketing'
                   WHEN engagement.provider_kind = 'warehouse_provider'
                     THEN snapshot.snapshot_kind = 'warehouse'
                   WHEN engagement.provider_kind = 'foreign_exchange_facilitator'
                     THEN snapshot.snapshot_kind = 'foreign_exchange'
                   ELSE false
                 END
               ),
               false
             )
       ) AS invalid_ready_engagements`,
  );
  outcomes.push({
    label: "ready engagements have exactly one kind-matched typed snapshot",
    passed: invalidReadySnapshots === 0,
    detail: `${String(invalidReadySnapshots)} invalid ready engagement(s)`,
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

  const inconsistentSnapshotSources = await countQuery(
    `WITH typed_snapshots AS (
       SELECT engagement_id, source_quote_service_line_id
         FROM freight_engagement_detail
       UNION ALL
       SELECT engagement_id, source_quote_service_line_id
         FROM customs_brokerage_engagement_detail
       UNION ALL
       SELECT engagement_id, source_quote_service_line_id
         FROM insurance_engagement_detail
       UNION ALL
       SELECT engagement_id, source_quote_service_line_id
         FROM inspection_engagement_detail
       UNION ALL
       SELECT engagement_id, source_quote_service_line_id
         FROM testing_certification_engagement_detail
       UNION ALL
       SELECT engagement_id, source_quote_service_line_id
         FROM marketing_engagement_detail
       UNION ALL
       SELECT engagement_id, source_quote_service_line_id
         FROM warehouse_engagement_detail
       UNION ALL
       SELECT engagement_id, source_quote_service_line_id
         FROM foreign_exchange_engagement_detail
     )
     SELECT count(*) AS row_count
       FROM typed_snapshots AS snapshot
       INNER JOIN commerce_service_engagement AS engagement
         ON engagement.id = snapshot.engagement_id
       INNER JOIN commerce_order_service_line AS order_service_line
         ON order_service_line.id = engagement.order_service_line_id
       INNER JOIN commerce_order
         ON commerce_order.id = engagement.order_id
       LEFT JOIN commerce_quote_service_line AS quote_service_line
         ON quote_service_line.id = snapshot.source_quote_service_line_id
      WHERE engagement.order_id <> order_service_line.order_id
         OR engagement.provider_kind <> order_service_line.provider_kind
         OR (
           engagement.execution_contract_provenance = 'accepted_quote'
           AND (
             snapshot.source_quote_service_line_id IS NULL
             OR order_service_line.source_quote_service_line_id IS DISTINCT FROM
                snapshot.source_quote_service_line_id
             OR quote_service_line.id IS NULL
             OR quote_service_line.provider_kind <> engagement.provider_kind
             OR (
               commerce_order.source = 'accepted_quote'
               AND quote_service_line.revision_id IS DISTINCT FROM
                   commerce_order.accepted_quote_revision_id
             )
           )
         )
         OR (
           engagement.execution_contract_provenance = 'operator_initialized'
           AND snapshot.source_quote_service_line_id IS NOT NULL
         )
         OR (
           engagement.execution_contract_state = 'ready'
           AND engagement.execution_contract_provenance IS NULL
         )
         OR (
           engagement.execution_contract_state = 'legacy_missing_snapshot'
           AND engagement.execution_contract_provenance IS NOT NULL
         )`,
  );
  outcomes.push({
    label: "typed snapshot sources match engagement provenance and order service lines",
    passed: inconsistentSnapshotSources === 0,
    detail: `${String(inconsistentSnapshotSources)} inconsistent source link(s)`,
  });

  const enabledAppendOnlyTriggers = await countQuery(
    `SELECT count(*) AS row_count
       FROM pg_trigger AS trigger_definition
       INNER JOIN pg_class AS target_table
         ON target_table.oid = trigger_definition.tgrelid
       INNER JOIN pg_namespace AS target_schema
         ON target_schema.oid = target_table.relnamespace
      WHERE NOT trigger_definition.tgisinternal
        AND target_schema.nspname = 'public'
        AND trigger_definition.tgenabled = 'O'
        AND trigger_definition.tgname = ANY($1)`,
    [
      [
        "freight_engagement_detail_append_only",
        "customs_brokerage_engagement_detail_append_only",
        "insurance_engagement_detail_append_only",
        "inspection_engagement_detail_append_only",
        "testing_certification_engagement_detail_append_only",
        "marketing_engagement_detail_append_only",
        "warehouse_engagement_detail_append_only",
        "foreign_exchange_engagement_detail_append_only",
        "commerce_shipment_leg_event_append_only",
        "commerce_service_engagement_event_append_only",
        "commerce_fulfillment_command_append_only",
        "commerce_engagement_deliverable_event_append_only",
      ],
    ],
  );
  outcomes.push({
    label: "immutable Phase 6 append-only triggers remain enabled",
    passed: enabledAppendOnlyTriggers === 12,
    detail: `${String(enabledAppendOnlyTriggers)}/12 enabled`,
  });

  const historicalDeliverableGaps = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_service_engagement AS engagement
       INNER JOIN commerce_order_service_line AS order_service_line
         ON order_service_line.id = engagement.order_service_line_id
       INNER JOIN commerce_quote_service_line AS quote_service_line
         ON quote_service_line.id = order_service_line.source_quote_service_line_id
      WHERE quote_service_line.deliverable_snapshot IS NOT NULL
        AND char_length(btrim(quote_service_line.deliverable_snapshot)) > 0
        AND NOT EXISTS (
          SELECT 1
            FROM commerce_engagement_deliverable AS deliverable
           WHERE deliverable.engagement_id = engagement.id
        )
        AND NOT EXISTS (
          SELECT 1
            FROM commerce_quote_service_deliverable_plan AS deliverable_plan
           WHERE deliverable_plan.quote_service_line_id = quote_service_line.id
        )
        AND engagement.requires_deliverable_normalization = false
        AND engagement.state <> 'cancelled'`,
  );
  outcomes.push({
    label: "historical free-text deliverable obligations are marked for normalization",
    passed: historicalDeliverableGaps === 0,
    detail: `${String(historicalDeliverableGaps)} unmarked obligation(s)`,
  });

  const gaplessEngagementEvents = await countQuery(
    `SELECT count(*) AS row_count
       FROM (
         SELECT engagement_id
           FROM commerce_service_engagement_event
          GROUP BY engagement_id
         HAVING min(sequence) <> 0
             OR max(sequence) + 1 <> count(*)
       ) AS gapped_engagements`,
  );
  outcomes.push({
    label: "service engagement event sequences are gapless from zero",
    passed: gaplessEngagementEvents === 0,
    detail: `${String(gaplessEngagementEvents)} gapped engagement(s)`,
  });

  const provenanceColumnCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'commerce_service_engagement'
        AND column_name = ANY($1)`,
    [["execution_contract_provenance", "requires_deliverable_normalization"]],
  );
  outcomes.push({
    label: "Phase 6 correctness columns exist on service engagement",
    passed: provenanceColumnCount === 2,
    detail: `${String(provenanceColumnCount)}/2 columns`,
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

  const orphanDeliverablePlans = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_quote_service_deliverable_plan AS deliverable_plan
      WHERE NOT EXISTS (
        SELECT 1
          FROM commerce_quote_service_line AS quote_service_line
         WHERE quote_service_line.id = deliverable_plan.quote_service_line_id
      )`,
  );
  outcomes.push({
    label: "quote deliverable plans retain quote service lines",
    passed: orphanDeliverablePlans === 0,
    detail: `${String(orphanDeliverablePlans)} orphan plan(s)`,
  });

  const duplicateDeliverablePlans = await countQuery(
    `SELECT count(*) AS row_count
       FROM (
         SELECT id
           FROM commerce_quote_service_deliverable_plan
          GROUP BY id
         HAVING count(*) > 1
         UNION ALL
         SELECT quote_service_line_id || ':' || sequence::text
           FROM commerce_quote_service_deliverable_plan
          GROUP BY quote_service_line_id, sequence
         HAVING count(*) > 1
       ) AS duplicate_plans`,
  );
  outcomes.push({
    label: "quote deliverable plan identities and sequences are unique",
    passed: duplicateDeliverablePlans === 0,
    detail: `${String(duplicateDeliverablePlans)} duplicate plan key(s)`,
  });

  const pairedCurrencyViolations = await countQuery(
    `SELECT count(*) AS row_count
       FROM (
         SELECT quote_service_line_id AS entity_id
           FROM insurance_quote_service_detail
          WHERE (coverage_limit_in_cents IS NULL) <> (currency IS NULL)
         UNION ALL
         SELECT quote_service_line_id AS entity_id
           FROM foreign_exchange_quote_service_detail
          WHERE (notional_amount_in_cents IS NULL) <> (notional_currency IS NULL)
         UNION ALL
         SELECT engagement_id AS entity_id
           FROM insurance_engagement_detail
          WHERE (coverage_limit_minor_units IS NULL) <> (currency IS NULL)
         UNION ALL
         SELECT engagement_id AS entity_id
           FROM foreign_exchange_engagement_detail
          WHERE (notional_amount_minor_units IS NULL) <> (notional_currency IS NULL)
         UNION ALL
         SELECT deliverable_id AS entity_id
           FROM insurance_deliverable_detail
          WHERE (insured_value_minor_units IS NOT NULL
                 OR coverage_limit_minor_units IS NOT NULL)
                <> (currency IS NOT NULL)
       ) AS currency_violations`,
  );
  outcomes.push({
    label: "optional monetary amounts retain paired currencies",
    passed: pairedCurrencyViolations === 0,
    detail: `${String(pairedCurrencyViolations)} pairing violation(s)`,
  });

  const nullableCurrencyColumnCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND is_nullable = 'YES'
        AND column_default IS NULL
        AND (
          (table_name = 'insurance_engagement_detail' AND column_name = 'currency')
          OR (table_name = 'insurance_quote_service_detail' AND column_name = 'currency')
          OR (
            table_name = 'foreign_exchange_engagement_detail'
            AND column_name = 'notional_currency'
          )
          OR (
            table_name = 'foreign_exchange_quote_service_detail'
            AND column_name = 'notional_currency'
          )
          OR (table_name = 'insurance_deliverable_detail' AND column_name = 'currency')
        )`,
  );
  outcomes.push({
    label: "optional currencies are nullable without defaults",
    passed: nullableCurrencyColumnCount === 5,
    detail: `${String(nullableCurrencyColumnCount)}/5 columns`,
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

  const phaseColumnCount = await countQuery(
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
    passed: phaseColumnCount === 4,
    detail: `${String(phaseColumnCount)}/4 columns`,
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
