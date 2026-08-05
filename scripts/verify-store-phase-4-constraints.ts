/**
 * Verifies Store Phase 4 database invariants after migration 0046.
 *
 *   npm run db:verify-store-phase-4-constraints
 */
import "dotenv/config";
import { pool } from "#src/db/index.js";

interface CheckOutcome {
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

const EXPECTED_TABLES: readonly string[] = [
  "commerce_cart",
  "commerce_cart_product_line",
  "commerce_checkout_prepare",
  "commerce_checkout_prepare_product_line",
  "commerce_checkout_prepare_currency_total",
  "commerce_inventory_reservation",
  "commerce_checkout_group",
  "commerce_checkout_group_currency_total",
  "commerce_service_engagement",
  "commerce_order_service_link",
  "commerce_shipment",
  "commerce_shipment_product_line",
  "commerce_shipment_event",
];

const EXPECTED_TRIGGERS: readonly string[] = [
  "commerce_shipment_event_append_only",
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
    label: "all store phase 4 tables exist",
    passed: tableCount === EXPECTED_TABLES.length,
    detail: `${String(tableCount)}/${String(EXPECTED_TABLES.length)}`,
  });

  const triggerCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM information_schema.triggers
      WHERE trigger_schema = 'public' AND trigger_name = ANY($1)`,
    [EXPECTED_TRIGGERS],
  );
  outcomes.push({
    label: "Phase 4 append-only triggers exist",
    passed: triggerCount === EXPECTED_TRIGGERS.length,
    detail: `${String(triggerCount)}/${String(EXPECTED_TRIGGERS.length)}`,
  });

  const checkoutGroupColumn = await countQuery(
    `SELECT count(*) AS row_count
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'commerce_order'
        AND column_name = 'checkout_group_id'`,
  );
  outcomes.push({
    label: "commerce_order.checkout_group_id exists",
    passed: checkoutGroupColumn === 1,
    detail: `${String(checkoutGroupColumn)}/1`,
  });

  const orphanDirectOrders = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_order
      WHERE source = 'direct_checkout'
        AND checkout_group_id IS NULL`,
  );
  outcomes.push({
    label: "direct_checkout orders retain checkout groups",
    passed: orphanDirectOrders === 0,
    detail: `${String(orphanDirectOrders)} orphan order(s)`,
  });

  const quoteOrdersWithCheckoutGroup = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_order
      WHERE source = 'accepted_quote'
        AND checkout_group_id IS NOT NULL`,
  );
  outcomes.push({
    label: "accepted_quote orders have no checkout group",
    passed: quoteOrdersWithCheckoutGroup === 0,
    detail: `${String(quoteOrdersWithCheckoutGroup)} mismatched order(s)`,
  });

  const prepareMoneyMismatch = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_checkout_prepare_currency_total
      WHERE total_in_cents <> (subtotal_in_cents + tax_in_cents + service_fee_in_cents
            + shipping_in_cents - discount_in_cents)`,
  );
  outcomes.push({
    label: "prepare currency totals reconcile",
    passed: prepareMoneyMismatch === 0,
    detail: `${String(prepareMoneyMismatch)} mismatched total(s)`,
  });

  const groupMoneyMismatch = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_checkout_group_currency_total
      WHERE total_in_cents <> (subtotal_in_cents + tax_in_cents + service_fee_in_cents
            + shipping_in_cents - discount_in_cents)`,
  );
  outcomes.push({
    label: "checkout group currency totals reconcile",
    passed: groupMoneyMismatch === 0,
    detail: `${String(groupMoneyMismatch)} mismatched total(s)`,
  });

  const missingEngagements = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_order_service_line AS osl
      WHERE NOT EXISTS (
        SELECT 1 FROM commerce_service_engagement AS se
         WHERE se.order_service_line_id = osl.id
      )`,
  );
  outcomes.push({
    label: "order service lines retain engagements",
    passed: missingEngagements === 0,
    detail: `${String(missingEngagements)} missing engagement(s)`,
  });

  const fulfillmentQtyViolations = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_order_product_line
      WHERE (quantity_fulfilled + quantity_cancelled) > quantity_ordered`,
  );
  outcomes.push({
    label: "order product line fulfillment quantities valid",
    passed: fulfillmentQtyViolations === 0,
    detail: `${String(fulfillmentQtyViolations)} violation(s)`,
  });

  const heldWithoutOwner = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_inventory_reservation
      WHERE state = 'held'
        AND checkout_prepare_id IS NULL
        AND order_id IS NULL`,
  );
  outcomes.push({
    label: "held reservations retain an owner",
    passed: heldWithoutOwner === 0,
    detail: `${String(heldWithoutOwner)} orphan reservation(s)`,
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
