/**
 * Verifies Store Phase 9 guided-pathway database invariants after migrations 0057–0058.
 *
 *   pnpm run db:verify-store-phase-9-constraints
 */
import "dotenv/config";
import { pool } from "#src/db/index.js";

interface CheckOutcome {
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

const EXPECTED_TABLES: readonly string[] = ["store_pathway_slot", "store_pathway_slot_candidate"];

const EXPECTED_TRIGGERS: readonly string[] = [
  "store_pathway_slot_candidate_variant_guard",
  "store_pathway_slot_anchor_guard",
  "store_pathway_anchor_removal_guard",
];

const EXPECTED_INDEXES: readonly string[] = [
  "store_pathway_slot_order_uidx",
  "store_pathway_slot_candidate_uidx",
  "store_pathway_slot_candidate_rank_idx",
  "store_pathway_owner_idx",
  "store_pathway_moderation_queue_idx",
];

const EXPECTED_CONSTRAINTS: readonly {
  readonly tableName: string;
  readonly constraintName: string;
}[] = [
  { tableName: "store_pathway", constraintName: "store_pathway_images_ck" },
  { tableName: "store_pathway", constraintName: "store_pathway_review_ck" },
  { tableName: "store_pathway", constraintName: "store_pathway_review_note_ck" },
  { tableName: "store_pathway_slot", constraintName: "store_pathway_slot_role_label_ck" },
  { tableName: "store_pathway_slot", constraintName: "store_pathway_slot_quantity_ck" },
  { tableName: "store_pathway_slot", constraintName: "store_pathway_slot_window_ck" },
  {
    tableName: "store_pathway_slot_candidate",
    constraintName: "store_pathway_slot_candidate_rank_ck",
  },
  {
    tableName: "store_pathway_slot_candidate",
    constraintName: "store_pathway_slot_candidate_source_ck",
  },
];

const EXPECTED_ENUM_VALUES: readonly { readonly typeName: string; readonly value: string }[] = [
  { typeName: "store_merchandising_state", value: "pending_review" },
  { typeName: "store_merchandising_state", value: "rejected" },
  { typeName: "store_pathway_slot_candidate_source_kind", value: "curated" },
  { typeName: "store_pathway_slot_candidate_source_kind", value: "derived" },
  { typeName: "commerce_organization_audit_event_kind", value: "pathway_created" },
  { typeName: "commerce_organization_audit_event_kind", value: "pathway_moderated" },
  { typeName: "commerce_organization_audit_event_kind", value: "cart_seeded_from_pathway" },
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
    label: "all store phase 9 tables exist",
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
    label: "Phase 9 pathway guards exist and are enabled",
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
    label: "Phase 9 indexes exist",
    passed: indexCount === EXPECTED_INDEXES.length,
    detail: `${String(indexCount)}/${String(EXPECTED_INDEXES.length)}`,
  });

  /**
   * Asserted by DEFINITION, not by name — 0055's lesson. A candidate index that
   * forgot the variant expression would carry the right name and the wrong meaning,
   * and one product in two variants would stop being two candidates.
   */
  const variantAwareCandidateIndex = await countQuery(
    `SELECT count(*) AS row_count
       FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'store_pathway_slot_candidate_uidx'
        AND indexdef LIKE '%variant_id%'`,
  );
  outcomes.push({
    label: "slot candidate uniqueness is variant-aware",
    passed: variantAwareCandidateIndex === 1,
    detail: `${String(variantAwareCandidateIndex)}/1`,
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
    label: "Phase 9 pathway constraints exist",
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
      EXPECTED_ENUM_VALUES.map((expectedValue) => expectedValue.typeName),
      EXPECTED_ENUM_VALUES.map((expectedValue) => expectedValue.value),
    ],
  );
  outcomes.push({
    label: "Phase 9 enum values exist",
    passed: enumValueCount === EXPECTED_ENUM_VALUES.length,
    detail: `${String(enumValueCount)}/${String(EXPECTED_ENUM_VALUES.length)}`,
  });

  // A1's rule at the candidate: every variant reference belongs to its own product.
  const strandedCandidateVariants = await countQuery(
    `SELECT count(*) AS row_count
       FROM store_pathway_slot_candidate AS candidate
       INNER JOIN commerce_product_variant AS variant ON variant.id = candidate.variant_id
      WHERE variant.product_id <> candidate.product_id`,
  );
  outcomes.push({
    label: "every candidate variant belongs to its own product",
    passed: strandedCandidateVariants === 0,
    detail: `${String(strandedCandidateVariants)} mismatched candidate variant(s)`,
  });

  // A candidate naming no variant for a variant-bearing product is a piece the set
  // advertises and cannot sell.
  const candidatesMissingVariant = await countQuery(
    `SELECT count(*) AS row_count
       FROM store_pathway_slot_candidate AS candidate
      WHERE candidate.variant_id IS NULL
        AND EXISTS (
          SELECT 1 FROM commerce_product_variant AS variant
           WHERE variant.product_id = candidate.product_id AND variant.state = 'active'
        )`,
  );
  outcomes.push({
    label: "no candidate omits a variant for a variant-bearing product",
    passed: candidatesMissingVariant === 0,
    detail: `${String(candidatesMissingVariant)} candidate(s) missing a variant`,
  });

  const candidatesOnRetiredVariants = await countQuery(
    `SELECT count(*) AS row_count
       FROM store_pathway_slot_candidate AS candidate
       INNER JOIN commerce_product_variant AS variant ON variant.id = candidate.variant_id
      WHERE variant.state <> 'active'`,
  );
  outcomes.push({
    label: "no candidate points at a retired variant",
    passed: candidatesOnRetiredVariants === 0,
    detail: `${String(candidatesOnRetiredVariants)} retired-variant candidate(s)`,
  });

  const derivedSlotsWithoutAnchor = await countQuery(
    `SELECT count(*) AS row_count
       FROM store_pathway_slot AS slot
       INNER JOIN store_pathway AS pathway ON pathway.id = slot.pathway_id
      WHERE slot.derived_relation_kind IS NOT NULL
        AND pathway.anchor_product_id IS NULL`,
  );
  outcomes.push({
    label: "every derived slot belongs to an anchored pathway",
    passed: derivedSlotsWithoutAnchor === 0,
    detail: `${String(derivedSlotsWithoutAnchor)} stranded derived slot(s)`,
  });

  const storedDerivedCandidates = await countQuery(
    `SELECT count(*) AS row_count
       FROM store_pathway_slot_candidate
      WHERE source_kind <> 'curated'`,
  );
  outcomes.push({
    label: "no derived candidate was stored (they are read-time only)",
    passed: storedDerivedCandidates === 0,
    detail: `${String(storedDerivedCandidates)} stored derived candidate(s)`,
  });

  const inconsistentReviewAttribution = await countQuery(
    `SELECT count(*) AS row_count
       FROM store_pathway
      WHERE (reviewed_by_user_id IS NULL) <> (reviewed_at IS NULL)
         OR (reviewed_at IS NOT NULL AND state NOT IN ('active', 'rejected'))
         OR (
           owner_organization_id IS NOT NULL
           AND state IN ('active', 'rejected')
           AND reviewed_by_user_id IS NULL
         )`,
  );
  outcomes.push({
    label: "review attribution and pathway state agree in both directions",
    passed: inconsistentReviewAttribution === 0,
    detail: `${String(inconsistentReviewAttribution)} inconsistent pathway review(s)`,
  });

  /*
   * The backfill's own receipt — "every product pathway item became a slot" — used to
   * be asserted here against `store_pathway_item`. Migration `0088` dropped that table,
   * so the receipt is no longer computable and this script threw `42P01` against an
   * `0089` database, losing every check above it rather than just this one. The receipt
   * was verified while the source existed and `0058` is the record of it; a check that
   * cannot be evaluated is worse than an absent one, because it takes its neighbours
   * down with it.
   */

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
