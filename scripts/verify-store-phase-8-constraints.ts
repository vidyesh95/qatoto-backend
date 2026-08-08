/**
 * Verifies Store Phase 8 catalog-depth database invariants after migration 0054.
 *
 *   pnpm run db:verify-store-phase-8-constraints
 */
import "dotenv/config";
import { pool } from "#src/db/index.js";

interface CheckOutcome {
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

const EXPECTED_TABLES: readonly string[] = [
  "commerce_product_variant",
  "commerce_product_highlight",
  "commerce_product_relation",
];

const EXPECTED_TRIGGERS: readonly string[] = [
  "commerce_cart_product_line_variant_guard",
  "commerce_order_product_line_variant_guard",
  "commerce_inventory_reservation_variant_guard",
  "product_image_variant_guard",
  "product_pricing_tier_variant_guard",
];

const EXPECTED_INDEXES: readonly string[] = [
  "commerce_product_variant_slug_uidx",
  "commerce_product_variant_sku_uidx",
  "commerce_product_variant_position_uidx",
  "commerce_product_highlight_position_uidx",
  "commerce_product_relation_edge_uidx",
  // A19: two rows could claim position 0, the main image by convention.
  "product_image_position_uidx",
  // Variant-aware replacements for their Phase 4 predecessors.
  "commerce_cart_product_line_uidx",
  "commerce_inventory_reservation_prepare_product_held_uidx",
];

const EXPECTED_CONSTRAINTS: readonly {
  readonly tableName: string;
  readonly constraintName: string;
}[] = [
  { tableName: "commerce_product_variant", constraintName: "commerce_product_variant_slug_ck" },
  { tableName: "commerce_product_variant", constraintName: "commerce_product_variant_name_ck" },
  { tableName: "commerce_product_variant", constraintName: "commerce_product_variant_money_ck" },
  {
    tableName: "commerce_product_highlight",
    constraintName: "commerce_product_highlight_image_ck",
  },
  { tableName: "commerce_product_relation", constraintName: "commerce_product_relation_self_ck" },
  {
    tableName: "commerce_product_relation",
    constraintName: "commerce_product_relation_verified_ck",
  },
  { tableName: "product", constraintName: "product_package_dimensions_ck" },
  { tableName: "product", constraintName: "product_package_mass_ck" },
  { tableName: "product", constraintName: "product_units_per_package_ck" },
  { tableName: "product_image", constraintName: "product_image_dimensions_ck" },
  {
    tableName: "commerce_product_specification",
    constraintName: "commerce_product_specification_group_ck",
  },
  { tableName: "store_hero_slide", constraintName: "store_hero_slide_link_target_ck" },
  // A19's fourth fix put a time window on `store_pathway_item`. Phase 9 carried that
  // window onto `store_pathway_slot` and migration `0088` dropped the item table, so
  // `store_pathway_slot_window_ck` is where the assertion lives now.
  { tableName: "store_pathway_slot", constraintName: "store_pathway_slot_window_ck" },
  {
    tableName: "commerce_order_product_line",
    constraintName: "commerce_order_product_line_variant_ck",
  },
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
    label: "all store phase 8 tables exist",
    passed: tableCount === EXPECTED_TABLES.length,
    detail: `${String(tableCount)}/${String(EXPECTED_TABLES.length)}`,
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
    label: "Phase 8 variant relationship triggers exist and are enabled",
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
    label: "Phase 8 uniqueness indexes exist",
    passed: indexCount === EXPECTED_INDEXES.length,
    detail: `${String(indexCount)}/${String(EXPECTED_INDEXES.length)}`,
  });

  /**
   * The two rewritten indexes must be the variant-aware expression form, not the
   * Phase 4 pair they replaced — same name, different meaning, so a name check
   * alone would pass against the old definition.
   */
  const variantAwareIndexCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = ANY($1)
        AND indexdef LIKE '%variant_id%'`,
    [
      [
        "commerce_cart_product_line_uidx",
        "commerce_inventory_reservation_prepare_product_held_uidx",
        "product_image_position_uidx",
      ],
    ],
  );
  outcomes.push({
    label: "cart, reservation, and image uniqueness is variant-aware",
    passed: variantAwareIndexCount === 3,
    detail: `${String(variantAwareIndexCount)}/3`,
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
    label: "Phase 8 catalog constraints exist",
    passed: constraintCount === EXPECTED_CONSTRAINTS.length,
    detail: `${String(constraintCount)}/${String(EXPECTED_CONSTRAINTS.length)}`,
  });

  const strandedVariantChildren = await countQuery(
    `SELECT count(*) AS row_count
       FROM (
         SELECT child.id
           FROM product_image AS child
           INNER JOIN commerce_product_variant AS variant ON variant.id = child.variant_id
          WHERE variant.product_id <> child.product_id
         UNION ALL
         SELECT child.id
           FROM product_pricing_tier AS child
           INNER JOIN commerce_product_variant AS variant ON variant.id = child.variant_id
          WHERE variant.product_id <> child.product_id
         UNION ALL
         SELECT child.id
           FROM commerce_cart_product_line AS child
           INNER JOIN commerce_product_variant AS variant ON variant.id = child.variant_id
          WHERE variant.product_id <> child.product_id
         UNION ALL
         SELECT child.id
           FROM commerce_inventory_reservation AS child
           INNER JOIN commerce_product_variant AS variant ON variant.id = child.variant_id
          WHERE variant.product_id <> child.product_id
         UNION ALL
         SELECT child.id
           FROM commerce_order_product_line AS child
           INNER JOIN commerce_product_variant AS variant ON variant.id = child.variant_id
          WHERE variant.product_id IS DISTINCT FROM child.product_id
       ) AS stranded`,
  );
  outcomes.push({
    label: "every variant reference belongs to its own product",
    passed: strandedVariantChildren === 0,
    detail: `${String(strandedVariantChildren)} stranded variant reference(s)`,
  });

  /**
   * The rule the whole of A1 rests on: once a product has an active variant, a
   * cart line that does not name one is not a buyable line.
   */
  const variantlessCartLines = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_cart_product_line AS line
      WHERE line.variant_id IS NULL
        AND EXISTS (
          SELECT 1
            FROM commerce_product_variant AS variant
           WHERE variant.product_id = line.product_id
             AND variant.state = 'active'
        )`,
  );
  outcomes.push({
    label: "cart lines name a variant whenever the product has one",
    passed: variantlessCartLines === 0,
    detail: `${String(variantlessCartLines)} variantless cart line(s)`,
  });

  const retiredVariantCartLines = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_cart_product_line AS line
       INNER JOIN commerce_product_variant AS variant ON variant.id = line.variant_id
      WHERE variant.state <> 'active'`,
  );
  outcomes.push({
    label: "cart lines never reference retired variants",
    passed: retiredVariantCartLines === 0,
    detail: `${String(retiredVariantCartLines)} retired-variant cart line(s)`,
  });

  const unsnapshottedOrderVariants = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_order_product_line
      WHERE (variant_id IS NULL) <> (variant_name_snapshot IS NULL)`,
  );
  outcomes.push({
    label: "order lines snapshot the variant name whenever they name a variant",
    passed: unsnapshottedOrderVariants === 0,
    detail: `${String(unsnapshottedOrderVariants)} unsnapshotted order line(s)`,
  });

  const duplicateImagePositions = await countQuery(
    `SELECT count(*) AS row_count
       FROM (
         SELECT product_id, coalesce(variant_id, '') AS variant_key, position
           FROM product_image
          GROUP BY product_id, coalesce(variant_id, ''), position
         HAVING count(*) > 1
       ) AS duplicates`,
  );
  outcomes.push({
    label: "one image claims each gallery position",
    passed: duplicateImagePositions === 0,
    detail: `${String(duplicateImagePositions)} duplicate position(s)`,
  });

  /**
   * §15.3: only `moderator_curated` earns confirmatory language, and it may only
   * claim that with a reviewer behind it.
   */
  const unattributedCuratedRelations = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_product_relation
      WHERE (source_kind = 'moderator_curated')
            <> (verified_by_user_id IS NOT NULL AND verified_at IS NOT NULL)`,
  );
  outcomes.push({
    label: "curated relations carry moderator attribution and others do not",
    passed: unattributedCuratedRelations === 0,
    detail: `${String(unattributedCuratedRelations)} unattributed relation(s)`,
  });

  const selfRelations = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_product_relation
      WHERE from_product_id = to_product_id`,
  );
  outcomes.push({
    label: "no product relates to itself",
    passed: selfRelations === 0,
    detail: `${String(selfRelations)} self-relation(s)`,
  });

  const partialHeroLinkTargets = await countQuery(
    `SELECT count(*) AS row_count
       FROM store_hero_slide
      WHERE NOT (
        (link_target_kind IS NULL AND link_target_id IS NULL AND link_target_slug IS NULL)
        OR (link_target_kind IS NOT NULL AND link_target_id IS NOT NULL
            AND link_target_slug IS NOT NULL)
      )`,
  );
  outcomes.push({
    label: "hero slides carry a whole link target or none",
    passed: partialHeroLinkTargets === 0,
    detail: `${String(partialHeroLinkTargets)} partial hero link target(s)`,
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
