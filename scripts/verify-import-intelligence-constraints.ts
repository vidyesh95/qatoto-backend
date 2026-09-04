/**
 * Exercises migration 0162's database-level guarantees against real rows (§10A).
 *
 * WHY THIS IS NOT A VITEST FILE: the vitest suite mocks `#src/db/index.js` wholesale, so it
 * can prove things about TypeScript and nothing about Postgres. An unexercised constraint
 * is indistinguishable from an absent one — and two of the guarantees below (the pair of
 * partial unique indexes, and the component-sum CHECK) are exactly the kind that a schema
 * file can declare and a database can quietly not have.
 *
 * READ-ONLY IN EFFECT: every write happens inside a transaction that is always rolled back.
 *
 *   pnpm db:verify-import-intelligence-constraints
 */
import "dotenv/config";
import { pool } from "#src/db/index.js";

interface CheckOutcome {
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

const EXPECTED_TABLES = [
  "import_commodity",
  "commodity_trade_flow",
  "domestic_substitute_mapping",
  "localization_assessment",
  "localization_pathway_suggestion",
  "comtrade_sync_run",
] as const;

const EXPECTED_ENUMS = [
  "import_commodity_kind",
  "import_quantity_unit",
  "trade_flow_kind",
  "trade_period_kind",
  "trade_data_origin",
  "domestic_substitute_kind",
  "domestic_substitute_maturity",
  "localization_narrative_status",
  "localization_pathway_status",
  "comtrade_sync_status",
] as const;

const EXPECTED_INDEXES = [
  "import_commodity_hsCode_unq",
  "commodity_trade_flow_partnered_unq",
  "commodity_trade_flow_aggregate_unq",
  "domestic_substitute_mapping_cell_label_unq",
  "localization_assessment_asOf_cell_unq",
  "localization_assessment_asOf_region_rank_unq",
] as const;

const UNIQUE_VIOLATION_SQLSTATE = "23505";
const CHECK_VIOLATION_SQLSTATE = "23514";
const FOREIGN_KEY_VIOLATION_SQLSTATE = "23503";

/** Drizzle wraps pg errors, so the SQLSTATE can be a few `cause` links down. */
function sqlStateOf(error: unknown): string | undefined {
  let candidate: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof candidate === "object" && candidate !== null && "code" in candidate) {
      const { code } = candidate as { code?: unknown };
      if (typeof code === "string") return code;
    }
    if (typeof candidate === "object" && candidate !== null && "cause" in candidate) {
      candidate = (candidate as { cause?: unknown }).cause;
      continue;
    }
    return undefined;
  }
  return undefined;
}

async function countQuery(text: string, values: readonly unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(text, [...values]);
  return Number(rows[0]?.n ?? 0);
}

/** The fixture flow row every trade-flow guarantee below starts from. */
const insertFlow = (id: string, extra = ""): string =>
  `INSERT INTO commodity_trade_flow
       (id, commodity_id, reporter_region_id, partner_region_id, flow_kind, period_kind,
        period_starts_date, period_ends_date, trade_value_in_cents, currency,
        net_weight_milli_kilograms, quantity_milli, quantity_unit, quantity_unit_code,
        is_reported, is_aggregate, is_net_weight_estimated, is_quantity_estimated,
        source_name, source_retrieved_at, data_origin)
     VALUES ('${id}', 'verify-commodity', $1, NULL, 'import', 'annual',
             '2023-01-01', '2023-12-31', 1000, 'USD', 5000, 5000, 'kilograms', 8,
             false, true, false, false, 'verify', now(), 'seeded_fixture')${extra}`;

async function checkSchemaObjects(): Promise<readonly CheckOutcome[]> {
  const outcomes: CheckOutcome[] = [];

  const tableCount = await countQuery(
    `SELECT count(*) AS n FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [[...EXPECTED_TABLES]],
  );
  outcomes.push({
    label: "all §10A tables exist",
    passed: tableCount === EXPECTED_TABLES.length,
    detail: `${tableCount}/${EXPECTED_TABLES.length}`,
  });

  const enumCount = await countQuery(
    `SELECT count(*) AS n FROM pg_type WHERE typtype = 'e' AND typname = ANY($1)`,
    [[...EXPECTED_ENUMS]],
  );
  outcomes.push({
    label: "all §10A enums exist",
    passed: enumCount === EXPECTED_ENUMS.length,
    detail: `${enumCount}/${EXPECTED_ENUMS.length}`,
  });

  const indexCount = await countQuery(
    `SELECT count(*) AS n FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1)`,
    [[...EXPECTED_INDEXES]],
  );
  outcomes.push({
    label: "all §10A unique indexes exist",
    passed: indexCount === EXPECTED_INDEXES.length,
    detail: `${indexCount}/${EXPECTED_INDEXES.length}`,
  });

  // The two partial uniques must actually carry their predicates, or the aggregate row
  // can be inserted twice.
  const partialCount = await countQuery(
    `SELECT count(*) AS n FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname IN ('commodity_trade_flow_partnered_unq', 'commodity_trade_flow_aggregate_unq')
       AND indexdef LIKE '%WHERE%partner_region_id%'`,
  );
  outcomes.push({
    label: "both trade-flow uniques are PARTIAL on partner_region_id",
    passed: partialCount === 2,
    detail: `${partialCount}/2 carry a WHERE clause`,
  });

  // Twelve enum values, every one observed in the live feed across six years of ingest.
  const quantityUnitCount = await countQuery(
    `SELECT count(*) AS n FROM pg_enum e
     JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'import_quantity_unit'`,
  );
  outcomes.push({
    label: "import_quantity_unit carries all twelve observed units",
    passed: quantityUnitCount === 12,
    detail: `${quantityUnitCount}/12`,
  });

  // Cascade policy: nothing in this domain may cascade-delete evidence.
  const restrictCount = await countQuery(
    `SELECT count(*) AS n FROM pg_constraint
     WHERE contype = 'f'
       AND conrelid IN ('commodity_trade_flow'::regclass, 'localization_assessment'::regclass,
                        'localization_pathway_suggestion'::regclass, 'domestic_substitute_mapping'::regclass)
       AND confdeltype NOT IN ('r', 'a', 'n')`,
  );
  outcomes.push({
    label: "no FK in §10A cascades",
    passed: restrictCount === 0,
    detail: `${restrictCount} cascading FK(s) found`,
  });

  return outcomes;
}

async function checkRuntimeGuarantees(): Promise<readonly CheckOutcome[]> {
  const client = await pool.connect();
  const outcomes: CheckOutcome[] = [];

  try {
    await client.query("BEGIN");

    const [category] = (
      await client.query<{ id: string }>(`SELECT id FROM research_category LIMIT 1`)
    ).rows;
    if (!category) {
      throw new Error("No research_category rows — run `pnpm db:seed-research-categories` first.");
    }
    const [region] = (
      await client.query<{ id: string }>(
        `SELECT id FROM discovery_region WHERE kind = 'country' LIMIT 1`,
      )
    ).rows;
    if (!region) {
      throw new Error("No country discovery_region rows — run `pnpm db:seed-discovery-lookups`.");
    }

    await client.query(
      `INSERT INTO import_commodity
         (id, hs_code, label, commodity_kind, research_category_id, default_quantity_unit)
       VALUES ('verify-commodity', '999901', 'Verification commodity', 'metal', $1, 'kilograms')`,
      [category.id],
    );

    // --- 1. The HS code must be six digits.
    await client.query("SAVEPOINT before_bad_hs_code");
    try {
      await client.query(
        `INSERT INTO import_commodity
           (id, hs_code, label, commodity_kind, research_category_id, default_quantity_unit)
         VALUES ('verify-commodity-2', 'abc', 'Bad code', 'metal', $1, 'kilograms')`,
        [category.id],
      );
      outcomes.push({
        label: "non-numeric HS code rejected",
        passed: false,
        detail: "the INSERT SUCCEEDED — a commodity can carry a code that is not an HS code",
      });
    } catch (error) {
      const sqlState = sqlStateOf(error);
      outcomes.push({
        label: "non-numeric HS code rejected",
        passed: sqlState === CHECK_VIOLATION_SQLSTATE,
        detail: `SQLSTATE ${sqlState ?? "unknown"}`,
      });
    }
    await client.query("ROLLBACK TO SAVEPOINT before_bad_hs_code");

    // --- 2. The HS code is unique.
    await client.query("SAVEPOINT before_duplicate_hs_code");
    try {
      await client.query(
        `INSERT INTO import_commodity
           (id, hs_code, label, commodity_kind, research_category_id, default_quantity_unit)
         VALUES ('verify-commodity-3', '999901', 'Duplicate', 'metal', $1, 'kilograms')`,
        [category.id],
      );
      outcomes.push({
        label: "duplicate HS code rejected",
        passed: false,
        detail: "the INSERT SUCCEEDED — two rows can describe one commodity",
      });
    } catch (error) {
      const sqlState = sqlStateOf(error);
      outcomes.push({
        label: "duplicate HS code rejected",
        passed: sqlState === UNIQUE_VIOLATION_SQLSTATE,
        detail: `SQLSTATE ${sqlState ?? "unknown"}`,
      });
    }
    await client.query("ROLLBACK TO SAVEPOINT before_duplicate_hs_code");

    await client.query(insertFlow("verify-flow-1"), [region.id]);

    // --- 3. THE PARTIAL UNIQUE. A NULL partner does not collide with a NULL partner in a
    //        plain unique index, so this is the guarantee most likely to be silently absent.
    await client.query("SAVEPOINT before_duplicate_aggregate");
    try {
      await client.query(insertFlow("verify-flow-2"), [region.id]);
      outcomes.push({
        label: "duplicate all-partners aggregate rejected",
        passed: false,
        detail: "the INSERT SUCCEEDED — every sync run would add another copy of the same figure",
      });
    } catch (error) {
      const sqlState = sqlStateOf(error);
      outcomes.push({
        label: "duplicate all-partners aggregate rejected",
        passed: sqlState === UNIQUE_VIOLATION_SQLSTATE,
        detail: `SQLSTATE ${sqlState ?? "unknown"}`,
      });
    }
    await client.query("ROLLBACK TO SAVEPOINT before_duplicate_aggregate");

    // --- 4. An estimation flag about a value that is not there.
    await client.query("SAVEPOINT before_orphan_estimate");
    try {
      await client.query(
        `INSERT INTO commodity_trade_flow
           (id, commodity_id, reporter_region_id, partner_region_id, flow_kind, period_kind,
            period_starts_date, period_ends_date, trade_value_in_cents, currency,
            net_weight_milli_kilograms, quantity_milli, quantity_unit, quantity_unit_code,
            is_reported, is_aggregate, is_net_weight_estimated, is_quantity_estimated,
            source_name, source_retrieved_at, data_origin)
         VALUES ('verify-flow-3', 'verify-commodity', $1, NULL, 'export', 'annual',
                 '2023-01-01', '2023-12-31', 1000, 'USD', NULL, NULL, 'kilograms', 8,
                 false, true, true, false, 'verify', now(), 'seeded_fixture')`,
        [region.id],
      );
      outcomes.push({
        label: "estimated flag on an absent weight rejected",
        passed: false,
        detail: "the INSERT SUCCEEDED — a row can claim an estimate of nothing",
      });
    } catch (error) {
      const sqlState = sqlStateOf(error);
      outcomes.push({
        label: "estimated flag on an absent weight rejected",
        passed: sqlState === CHECK_VIOLATION_SQLSTATE,
        detail: `SQLSTATE ${sqlState ?? "unknown"}`,
      });
    }
    await client.query("ROLLBACK TO SAVEPOINT before_orphan_estimate");

    // --- 5. THE COMPONENT SUM. Without it the sub-scores are decoration and a UI could
    //        render "27 of 35" beside a total that contradicts it.
    await client.query("SAVEPOINT before_bad_component_sum");
    try {
      await client.query(
        `INSERT INTO localization_assessment
           (id, as_of, window_starts_at, window_ends_at, commodity_id, region_id,
            feasibility_score_points, rank, trend_direction,
            import_dependency_points, export_capability_points, substitute_availability_points,
            supplier_capacity_points, lead_time_advantage_points,
            observed_import_value_in_cents, observed_export_value_in_cents, currency,
            substitute_count, matched_supplier_count, verified_supplier_count)
         VALUES ('verify-assessment-bad', '2026-01-02', '2025-01-02', '2026-01-01',
                 'verify-commodity', $1,
                 99, 1, 'flat',
                 10, 5, 3, 2, 1,
                 1000, 0, 'USD', 0, 0, 0)`,
        [region.id],
      );
      outcomes.push({
        label: "components that do not sum to the total rejected",
        passed: false,
        detail: "the INSERT SUCCEEDED — a score can contradict its own breakdown",
      });
    } catch (error) {
      const sqlState = sqlStateOf(error);
      outcomes.push({
        label: "components that do not sum to the total rejected",
        passed: sqlState === CHECK_VIOLATION_SQLSTATE,
        detail: `SQLSTATE ${sqlState ?? "unknown"}`,
      });
    }
    await client.query("ROLLBACK TO SAVEPOINT before_bad_component_sum");

    // --- 6. The trend arrow must agree with its own evidence.
    await client.query("SAVEPOINT before_bad_trend");
    try {
      await client.query(
        `INSERT INTO localization_assessment
           (id, as_of, window_starts_at, window_ends_at, commodity_id, region_id,
            feasibility_score_points, previous_feasibility_score_points, rank, trend_direction,
            import_dependency_points, export_capability_points, substitute_availability_points,
            supplier_capacity_points, lead_time_advantage_points,
            observed_import_value_in_cents, observed_export_value_in_cents, currency,
            substitute_count, matched_supplier_count, verified_supplier_count)
         VALUES ('verify-assessment-trend', '2026-01-02', '2025-01-02', '2026-01-01',
                 'verify-commodity', $1,
                 21, 10, 1, 'down',
                 21, 0, 0, 0, 0,
                 1000, 0, 'USD', 0, 0, 0)`,
        [region.id],
      );
      outcomes.push({
        label: "a 'down' arrow on a rising score rejected",
        passed: false,
        detail: "the INSERT SUCCEEDED — the arrow and the evidence can disagree",
      });
    } catch (error) {
      const sqlState = sqlStateOf(error);
      outcomes.push({
        label: "a 'down' arrow on a rising score rejected",
        passed: sqlState === CHECK_VIOLATION_SQLSTATE,
        detail: `SQLSTATE ${sqlState ?? "unknown"}`,
      });
    }
    await client.query("ROLLBACK TO SAVEPOINT before_bad_trend");

    // A good assessment, so the suggestion checks have a parent.
    await client.query(
      `INSERT INTO localization_assessment
         (id, as_of, window_starts_at, window_ends_at, commodity_id, region_id,
          feasibility_score_points, rank, trend_direction,
          import_dependency_points, export_capability_points, substitute_availability_points,
          supplier_capacity_points, lead_time_advantage_points,
          observed_import_value_in_cents, observed_export_value_in_cents, currency,
          substitute_count, matched_supplier_count, verified_supplier_count)
       VALUES ('verify-assessment', '2026-01-02', '2025-01-02', '2026-01-01',
               'verify-commodity', $1, 21, 1, 'flat', 21, 0, 0, 0, 0,
               1000, 0, 'USD', 0, 0, 0)`,
      [region.id],
    );

    // --- 7. An open suggestion cannot carry a decision timestamp.
    await client.query("SAVEPOINT before_bad_decision");
    try {
      await client.query(
        `INSERT INTO localization_pathway_suggestion
           (id, assessment_id, title, body_text, status, model_name, prompt_version, as_of,
            decided_at)
         VALUES ('verify-suggestion-bad', 'verify-assessment', 'T', 'B', 'open',
                 'test-model', 'v1', '2026-01-02', now())`,
      );
      outcomes.push({
        label: "an 'open' suggestion with a decision timestamp rejected",
        passed: false,
        detail: "the INSERT SUCCEEDED — a suggestion can be open and decided at once",
      });
    } catch (error) {
      const sqlState = sqlStateOf(error);
      outcomes.push({
        label: "an 'open' suggestion with a decision timestamp rejected",
        passed: sqlState === CHECK_VIOLATION_SQLSTATE,
        detail: `SQLSTATE ${sqlState ?? "unknown"}`,
      });
    }
    await client.query("ROLLBACK TO SAVEPOINT before_bad_decision");

    // --- 8. Confidence stays inside basis points.
    await client.query("SAVEPOINT before_bad_confidence");
    try {
      await client.query(
        `INSERT INTO localization_pathway_suggestion
           (id, assessment_id, title, body_text, status, model_name, prompt_version, as_of,
            confidence_bps)
         VALUES ('verify-suggestion-conf', 'verify-assessment', 'T', 'B', 'open',
                 'test-model', 'v1', '2026-01-02', 20000)`,
      );
      outcomes.push({
        label: "a confidence above 10000 bps rejected",
        passed: false,
        detail: "the INSERT SUCCEEDED — confidence is not bounded to basis points",
      });
    } catch (error) {
      const sqlState = sqlStateOf(error);
      outcomes.push({
        label: "a confidence above 10000 bps rejected",
        passed: sqlState === CHECK_VIOLATION_SQLSTATE,
        detail: `SQLSTATE ${sqlState ?? "unknown"}`,
      });
    }
    await client.query("ROLLBACK TO SAVEPOINT before_bad_confidence");

    // --- 9. A commodity cited by a flow cannot be deleted.
    await client.query("SAVEPOINT before_delete_commodity");
    try {
      await client.query(`DELETE FROM import_commodity WHERE id = 'verify-commodity'`);
      outcomes.push({
        label: "deleting a commodity cited by a trade flow refused",
        passed: false,
        detail: "the DELETE SUCCEEDED — a flow row can be orphaned",
      });
    } catch (error) {
      const sqlState = sqlStateOf(error);
      outcomes.push({
        label: "deleting a commodity cited by a trade flow refused",
        passed: sqlState === FOREIGN_KEY_VIOLATION_SQLSTATE,
        detail: `SQLSTATE ${sqlState ?? "unknown"}`,
      });
    }
    await client.query("ROLLBACK TO SAVEPOINT before_delete_commodity");

    // --- 10. One assessment per (asOf, commodity, region).
    await client.query("SAVEPOINT before_duplicate_assessment");
    try {
      await client.query(
        `INSERT INTO localization_assessment
           (id, as_of, window_starts_at, window_ends_at, commodity_id, region_id,
            feasibility_score_points, rank, trend_direction,
            import_dependency_points, export_capability_points, substitute_availability_points,
            supplier_capacity_points, lead_time_advantage_points,
            observed_import_value_in_cents, observed_export_value_in_cents, currency,
            substitute_count, matched_supplier_count, verified_supplier_count)
         VALUES ('verify-assessment-dup', '2026-01-02', '2025-01-02', '2026-01-01',
                 'verify-commodity', $1, 21, 2, 'flat', 21, 0, 0, 0, 0,
                 1000, 0, 'USD', 0, 0, 0)`,
        [region.id],
      );
      outcomes.push({
        label: "duplicate assessment for one (asOf, commodity, region) rejected",
        passed: false,
        detail: "the INSERT SUCCEEDED — a cell can be scored twice for one night",
      });
    } catch (error) {
      const sqlState = sqlStateOf(error);
      outcomes.push({
        label: "duplicate assessment for one (asOf, commodity, region) rejected",
        passed: sqlState === UNIQUE_VIOLATION_SQLSTATE,
        detail: `SQLSTATE ${sqlState ?? "unknown"}`,
      });
    }
    await client.query("ROLLBACK TO SAVEPOINT before_duplicate_assessment");

    return outcomes;
  } finally {
    // Always. Nothing this script writes is ever committed.
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

async function main(): Promise<void> {
  const outcomes = [...(await checkSchemaObjects()), ...(await checkRuntimeGuarantees())];

  for (const outcome of outcomes) {
    console.log(`${outcome.passed ? "PASS" : "FAIL"}  ${outcome.label} — ${outcome.detail}`);
  }

  const failureCount = outcomes.filter((outcome) => !outcome.passed).length;
  console.log(
    failureCount === 0
      ? `\nAll ${outcomes.length} import-intelligence guarantees verified.`
      : `\n${failureCount} of ${outcomes.length} guarantees FAILED.`,
  );
  if (failureCount > 0) process.exitCode = 1;
}

main()
  .then(async () => {
    await pool.end();
    // Deliberately NOT process.exit(0): main() sets process.exitCode = 1 when a guarantee
    // failed, and exiting explicitly here would report success to a CI gate meant to block.
    return undefined;
  })
  .catch(async (error: unknown) => {
    console.error("Import-intelligence constraint verification failed to run:", error);
    await pool.end();
    process.exit(1);
  });
