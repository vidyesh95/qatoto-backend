/**
 * Verifies Store Phase 11 buyer-logistics database invariants after migrations
 * 0059–0062.
 *
 *   pnpm run db:verify-store-phase-11-constraints
 */
import "dotenv/config";
import { pool } from "#src/db/index.js";

interface CheckOutcome {
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

const EXPECTED_TABLES: readonly string[] = [
  "commerce_sample_credit",
  "commerce_product_customization_option",
  "commerce_cart_line_customization",
  "commerce_checkout_prepare_line_customization",
  "commerce_order_line_customization",
];

const EXPECTED_TRIGGERS: readonly string[] = [
  "commerce_cart_line_customization_option_guard",
  "commerce_prepare_line_customization_option_guard",
];

const EXPECTED_INDEXES: readonly string[] = [
  "commerce_order_delivery_address_idx",
  "commerce_service_coverage_route_idx",
  "commerce_sample_credit_source_order_uidx",
  "commerce_sample_credit_spendable_idx",
  "commerce_product_customization_option_slot_uidx",
  "commerce_product_customization_option_position_uidx",
  "commerce_cart_line_customization_slot_uidx",
  "commerce_checkout_prepare_line_customization_slot_uidx",
  "commerce_order_line_customization_slot_uidx",
];

const EXPECTED_CONSTRAINTS: readonly {
  readonly tableName: string;
  readonly constraintName: string;
}[] = [
  { tableName: "commerce_sample_credit", constraintName: "commerce_sample_credit_amount_ck" },
  { tableName: "commerce_sample_credit", constraintName: "commerce_sample_credit_parties_ck" },
  {
    tableName: "commerce_sample_credit",
    constraintName: "commerce_sample_credit_consumption_ck",
  },
  {
    tableName: "commerce_product_customization_option",
    constraintName: "commerce_product_customization_option_kind_ck",
  },
  {
    tableName: "commerce_product_customization_option",
    constraintName: "commerce_product_customization_option_moq_ck",
  },
  {
    tableName: "commerce_cart_line_customization",
    constraintName: "commerce_cart_line_customization_supply_ck",
  },
  {
    tableName: "commerce_order_line_customization",
    constraintName: "commerce_order_line_customization_supply_ck",
  },
];

const EXPECTED_ENUM_VALUES: readonly { readonly typeName: string; readonly value: string }[] = [
  { typeName: "commerce_organization_address_kind", value: "delivery" },
  { typeName: "commerce_document_kind", value: "customization_artwork" },
  { typeName: "commerce_organization_audit_event_kind", value: "delivery_address_revealed" },
  { typeName: "commerce_organization_audit_event_kind", value: "sample_credit_minted" },
  { typeName: "commerce_organization_audit_event_kind", value: "sample_credit_consumed" },
  { typeName: "commerce_sample_credit_state", value: "available" },
  { typeName: "commerce_product_customization_kind", value: "file_upload" },
  { typeName: "commerce_product_customization_option_state", value: "retired" },
];

/**
 * Asserted BY DEFINITION TEXT, not by name. All three keep the names they had before
 * Phase 11 and change meaning, so a name-only check passes against the old definition —
 * the trap migration 0055 documented and this phase walks into again.
 */
const SAMPLE_AWARE_INDEXES: readonly string[] = [
  "commerce_cart_product_line_uidx",
  "commerce_checkout_prepare_product_line_uidx",
  "commerce_inventory_reservation_prepare_product_held_uidx",
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
    label: "all store phase 11 tables exist",
    passed: tableCount === EXPECTED_TABLES.length,
    detail: `${String(tableCount)}/${String(EXPECTED_TABLES.length)}`,
  });

  const orderColumnCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND ((table_name = 'commerce_order' AND column_name = 'delivery_address_id')
          OR (table_name = 'commerce_cart_product_line' AND column_name = 'is_sample')
          OR (table_name = 'commerce_checkout_prepare_product_line' AND column_name = 'is_sample')
          OR (table_name = 'commerce_order_product_line' AND column_name = 'is_sample')
          OR (table_name = 'commerce_inventory_reservation' AND column_name = 'is_sample'))`,
  );
  outcomes.push({
    label: "Phase 11 columns exist on order, cart, prepare and reservation",
    passed: orderColumnCount === 5,
    detail: `${String(orderColumnCount)}/5`,
  });

  const triggerCount = await countQuery(
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
    [EXPECTED_TRIGGERS],
  );
  outcomes.push({
    label: "customization option guards exist and are enabled",
    passed: triggerCount === EXPECTED_TRIGGERS.length,
    detail: `${String(triggerCount)}/${String(EXPECTED_TRIGGERS.length)}`,
  });

  const indexCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = ANY($1)`,
    [EXPECTED_INDEXES],
  );
  outcomes.push({
    label: "Phase 11 indexes exist",
    passed: indexCount === EXPECTED_INDEXES.length,
    detail: `${String(indexCount)}/${String(EXPECTED_INDEXES.length)}`,
  });

  const sampleAwareIndexCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = ANY($1)
        AND indexdef LIKE '%is_sample%'`,
    [SAMPLE_AWARE_INDEXES],
  );
  outcomes.push({
    label: "cart, prepare and reservation uniqueness is sample-aware",
    passed: sampleAwareIndexCount === SAMPLE_AWARE_INDEXES.length,
    detail: `${String(sampleAwareIndexCount)}/${String(SAMPLE_AWARE_INDEXES.length)}`,
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
      EXPECTED_CONSTRAINTS.map((expected) => expected.tableName),
      EXPECTED_CONSTRAINTS.map((expected) => expected.constraintName),
    ],
  );
  outcomes.push({
    label: "Phase 11 constraints exist",
    passed: constraintCount === EXPECTED_CONSTRAINTS.length,
    detail: `${String(constraintCount)}/${String(EXPECTED_CONSTRAINTS.length)}`,
  });

  const enumValueCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM unnest($1::text[], $2::text[]) AS expected(type_name, enum_value)
       INNER JOIN pg_type AS enum_type ON enum_type.typname = expected.type_name
       INNER JOIN pg_enum AS enum_label
         ON enum_label.enumtypid = enum_type.oid
        AND enum_label.enumlabel = expected.enum_value`,
    [
      EXPECTED_ENUM_VALUES.map((expected) => expected.typeName),
      EXPECTED_ENUM_VALUES.map((expected) => expected.value),
    ],
  );
  outcomes.push({
    label: "Phase 11 enum values exist",
    passed: enumValueCount === EXPECTED_ENUM_VALUES.length,
    detail: `${String(enumValueCount)}/${String(EXPECTED_ENUM_VALUES.length)}`,
  });

  // A15. An order that points at a billing address is one nobody can ship to.
  const nonDeliveryOrderAddresses = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_order AS placed_order
       INNER JOIN commerce_organization_address AS delivery_address
         ON delivery_address.id = placed_order.delivery_address_id
      WHERE delivery_address.address_kind <> 'delivery'`,
  );
  outcomes.push({
    label: "every order delivery address is of kind delivery",
    passed: nonDeliveryOrderAddresses === 0,
    detail: `${String(nonDeliveryOrderAddresses)} order(s) pointing at a non-delivery address`,
  });

  const foreignOrderAddresses = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_order AS placed_order
       INNER JOIN commerce_organization_address AS delivery_address
         ON delivery_address.id = placed_order.delivery_address_id
      WHERE delivery_address.organization_id <> placed_order.buyer_organization_id`,
  );
  outcomes.push({
    label: "every order delivery address belongs to the order's buyer",
    passed: foreignOrderAddresses === 0,
    detail: `${String(foreignOrderAddresses)} order(s) pointing at another organization's address`,
  });

  // A17. A sample line must price from the sample price, never the tier ladder.
  const mispricedSampleLines = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_order_product_line AS order_line
       INNER JOIN product AS listed_product ON listed_product.id = order_line.product_id
      WHERE order_line.is_sample
        AND (listed_product.sample_price_in_cents IS NULL
             OR order_line.unit_price_in_cents <> listed_product.sample_price_in_cents)`,
  );
  outcomes.push({
    label: "every sample order line priced from the sample price",
    passed: mispricedSampleLines === 0,
    detail: `${String(mispricedSampleLines)} mispriced sample line(s)`,
  });

  const inconsistentCredits = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_sample_credit
      WHERE (state = 'consumed' AND (consumed_by_order_id IS NULL OR consumed_at IS NULL))
         OR (state <> 'consumed' AND (consumed_by_order_id IS NOT NULL OR consumed_at IS NOT NULL))`,
  );
  outcomes.push({
    label: "sample credit consumption and state agree in both directions",
    passed: inconsistentCredits === 0,
    detail: `${String(inconsistentCredits)} inconsistent credit(s)`,
  });

  const selfDealingCredits = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_sample_credit
      WHERE buyer_organization_id = seller_organization_id`,
  );
  outcomes.push({
    label: "no sample credit is owed by an organization to itself",
    passed: selfDealingCredits === 0,
    detail: `${String(selfDealingCredits)} self-dealing credit(s)`,
  });

  /**
   * A18. A selection naming another product's slot would carry that seller's minimum
   * order quantity onto this line. The triggers stop it going in; this proves none did.
   */
  const strayCartCustomizations = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_cart_line_customization AS selection
       INNER JOIN commerce_cart_product_line AS cart_line
         ON cart_line.id = selection.cart_product_line_id
       INNER JOIN commerce_product_customization_option AS slot_option
         ON slot_option.id = selection.customization_option_id
      WHERE slot_option.product_id <> cart_line.product_id`,
  );
  outcomes.push({
    label: "no cart customization names another product's slot",
    passed: strayCartCustomizations === 0,
    detail: `${String(strayCartCustomizations)} stray cart selection(s)`,
  });

  const unscannedArtwork = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_order_line_customization AS selection
       INNER JOIN commerce_encrypted_document AS artwork
         ON artwork.id = selection.encrypted_document_id
      WHERE artwork.state <> 'available'
         OR artwork.document_kind <> 'customization_artwork'`,
  );
  outcomes.push({
    label: "every ordered customization asset is scanned artwork",
    passed: unscannedArtwork === 0,
    detail: `${String(unscannedArtwork)} unscanned or wrong-kind asset(s)`,
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
