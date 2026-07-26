/**
 * Verifies that migration 0020's DATABASE-LEVEL guarantees are actually in force
 * (R_AND_D_BACKEND_STRUCTURE.md §17, §11i).
 *
 * WHY THIS IS A SCRIPT AND NOT A TEST, the same reason every sibling `verify-*` script
 * gives: the vitest suite mocks `#src/db/index.js` wholesale, so it can prove things about
 * TypeScript and nothing about Postgres. The claims that matter most in §11i are enforced
 * BY POSTGRES — the slug uniqueness that makes a duplicate listing a 409, the R1 `restrict`
 * on `product.research_project_id` that stops a shipped project being deleted out from
 * under its listing, and the `restrict` on the capability taxonomy that stops a curated
 * capability vanishing under a supplier that claims it. An unexercised constraint is
 * indistinguishable from an absent one.
 *
 * Read-only in effect: every write happens inside a transaction that is always rolled back.
 *
 *   pnpm db:verify-go-to-market-constraints
 *
 * Exits non-zero if any guarantee is missing, so it can gate a deploy.
 */
import "dotenv/config";
import { pool } from "#src/db/index.js";

interface CheckOutcome {
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

const EXPECTED_TABLES = [
  "supplier",
  "supplier_capability",
  "supplier_capability_link",
  "project_supplier_engagement",
] as const;

const EXPECTED_ENUMS = [
  "supplier_verification_state",
  "supplier_capability_kind",
  "supplier_contact_policy",
  "project_supplier_engagement_status",
] as const;

const EXPECTED_INDEXES = [
  "supplier_slug_unq",
  "supplier_active_name_idx",
  "supplier_capability_slug_unq",
  "supplier_capability_link_capabilityId_idx",
  "project_supplier_engagement_project_supplier_unq",
  "product_researchProjectId_idx",
  // Appendix B2's two, verified here because they ship in the same migration.
  "daily_log_feed_idx",
  "daily_log_ai_summary_chip_kind_logId_idx",
] as const;

const UNIQUE_VIOLATION_SQLSTATE = "23505";
const CHECK_VIOLATION_SQLSTATE = "23514";
const FOREIGN_KEY_VIOLATION_SQLSTATE = "23503";

function sqlStateOf(error: unknown): string | undefined {
  let candidate: unknown = error;
  for (let depth = 0; depth < 5 && candidate; depth += 1) {
    const code = (candidate as { code?: unknown }).code;
    if (typeof code === "string") return code;
    candidate = (candidate as { cause?: unknown }).cause;
  }
  return undefined;
}

async function countQuery(text: string, values: readonly unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(text, [...values]);
  return Number(rows[0]?.n ?? 0);
}

async function checkSchemaObjects(): Promise<readonly CheckOutcome[]> {
  const tableCount = await countQuery(
    `SELECT count(*) AS n FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [EXPECTED_TABLES],
  );
  const enumCount = await countQuery(
    `SELECT count(*) AS n FROM pg_type WHERE typtype = 'e' AND typname = ANY($1)`,
    [EXPECTED_ENUMS],
  );
  const indexCount = await countQuery(
    `SELECT count(*) AS n FROM pg_indexes WHERE indexname = ANY($1)`,
    [EXPECTED_INDEXES],
  );
  const productColumnCount = await countQuery(
    `SELECT count(*) AS n FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'product'
        AND column_name = 'research_project_id' AND is_nullable = 'YES'`,
  );
  // R1: every FK into research_project is `restrict`. `a` is NO ACTION and `r` is RESTRICT;
  // either refuses the delete, but the schema declares RESTRICT and the two must not drift.
  const productFkRestrictCount = await countQuery(
    `SELECT count(*) AS n FROM pg_constraint
      WHERE contype = 'f' AND conrelid = 'product'::regclass
        AND confrelid = 'research_project'::regclass AND confdeltype IN ('r', 'a')`,
  );
  const engagementFkRestrictCount = await countQuery(
    `SELECT count(*) AS n FROM pg_constraint
      WHERE contype = 'f' AND conrelid = 'project_supplier_engagement'::regclass
        AND confrelid = 'research_project'::regclass AND confdeltype IN ('r', 'a')`,
  );
  // The link cascades from the supplier and restricts on the taxonomy — the two halves of
  // `talent_profile_skill`'s shape, and getting either backwards is a silent data loss.
  const linkCascadeCount = await countQuery(
    `SELECT count(*) AS n FROM pg_constraint
      WHERE contype = 'f' AND conrelid = 'supplier_capability_link'::regclass
        AND confrelid = 'supplier'::regclass AND confdeltype = 'c'`,
  );
  const linkRestrictCount = await countQuery(
    `SELECT count(*) AS n FROM pg_constraint
      WHERE contype = 'f' AND conrelid = 'supplier_capability_link'::regclass
        AND confrelid = 'supplier_capability'::regclass AND confdeltype IN ('r', 'a')`,
  );
  const capabilityCount = await countQuery(`SELECT count(*) AS n FROM supplier_capability`);

  return [
    {
      label: "all 4 go-to-market tables exist",
      passed: tableCount === EXPECTED_TABLES.length,
      detail: `${tableCount}/${EXPECTED_TABLES.length}`,
    },
    {
      label: "all 4 go-to-market enums exist",
      passed: enumCount === EXPECTED_ENUMS.length,
      detail: `${enumCount}/${EXPECTED_ENUMS.length}`,
    },
    {
      label: "all 8 indexes exist",
      passed: indexCount === EXPECTED_INDEXES.length,
      detail: `${indexCount}/${EXPECTED_INDEXES.length}`,
    },
    {
      label: "product.research_project_id exists and is nullable",
      passed: productColumnCount === 1,
      detail: `${productColumnCount}/1`,
    },
    {
      label: "product → research_project FK is restrict (R1)",
      passed: productFkRestrictCount === 1,
      detail: `${productFkRestrictCount}/1`,
    },
    {
      label: "project_supplier_engagement → research_project FK is restrict (R1)",
      passed: engagementFkRestrictCount === 1,
      detail: `${engagementFkRestrictCount}/1`,
    },
    {
      label: "capability link cascades from supplier",
      passed: linkCascadeCount === 1,
      detail: `${linkCascadeCount}/1`,
    },
    {
      label: "capability link restricts on the taxonomy",
      passed: linkRestrictCount === 1,
      detail: `${linkRestrictCount}/1`,
    },
    {
      label: "supplier capabilities seeded",
      passed: capabilityCount > 0,
      detail: `${capabilityCount} rows — run \`pnpm db:seed-supplier-capabilities\` if 0`,
    },
  ];
}

/** Exercises each guarantee against real rows, inside a transaction that is rolled back. */
async function checkRuntimeGuarantees(): Promise<readonly CheckOutcome[]> {
  const client = await pool.connect();
  const outcomes: CheckOutcome[] = [];

  try {
    await client.query("BEGIN");

    const [seedCapability] = (
      await client.query<{ id: string }>(`SELECT id FROM supplier_capability LIMIT 1`)
    ).rows;
    if (!seedCapability) {
      throw new Error(
        "No supplier_capability rows — run `pnpm db:seed-supplier-capabilities` first.",
      );
    }

    await client.query(
      `INSERT INTO supplier (id, slug, name) VALUES ('verify-supplier', 'verify-supplier', 'Verify')`,
    );

    // 1. The slug UNIQUE is the de-duplication mechanism: a second row for one supplier
    //    must be a 23505 the service turns into a 409, never a silently suffixed row.
    await client.query("SAVEPOINT before_duplicate_slug");
    try {
      await client.query(
        `INSERT INTO supplier (id, slug, name)
         VALUES ('verify-supplier-2', 'verify-supplier', 'Verify Again')`,
      );
      outcomes.push({
        label: "duplicate supplier slug rejected",
        passed: false,
        detail: "the INSERT SUCCEEDED — the directory can hold two rows for one supplier",
      });
    } catch (error) {
      const sqlState = sqlStateOf(error);
      outcomes.push({
        label: "duplicate supplier slug rejected",
        passed: sqlState === UNIQUE_VIOLATION_SQLSTATE,
        detail: `SQLSTATE ${sqlState ?? "unknown"}`,
      });
    }
    await client.query("ROLLBACK TO SAVEPOINT before_duplicate_slug");

    // 2. A slug that is not lowercase-hyphenated must be refused at the column, not merely
    //    by Zod — the schema catches one hostile payload, the CHECK catches every path.
    await client.query("SAVEPOINT before_bad_slug");
    try {
      await client.query(
        `INSERT INTO supplier (id, slug, name) VALUES ('verify-bad', 'Not A Slug', 'Verify')`,
      );
      outcomes.push({
        label: "malformed supplier slug rejected",
        passed: false,
        detail: "the INSERT SUCCEEDED — slugs are not constrained",
      });
    } catch (error) {
      const sqlState = sqlStateOf(error);
      outcomes.push({
        label: "malformed supplier slug rejected",
        passed: sqlState === CHECK_VIOLATION_SQLSTATE,
        detail: `SQLSTATE ${sqlState ?? "unknown"}`,
      });
    }
    await client.query("ROLLBACK TO SAVEPOINT before_bad_slug");

    // 3. A negative lead time is not a shorter lead time.
    await client.query("SAVEPOINT before_negative_lead_time");
    try {
      await client.query(
        `INSERT INTO supplier (id, slug, name, lead_time_days)
         VALUES ('verify-neg', 'verify-neg', 'Verify', -1)`,
      );
      outcomes.push({
        label: "negative lead_time_days rejected",
        passed: false,
        detail: "the INSERT SUCCEEDED",
      });
    } catch (error) {
      const sqlState = sqlStateOf(error);
      outcomes.push({
        label: "negative lead_time_days rejected",
        passed: sqlState === CHECK_VIOLATION_SQLSTATE,
        detail: `SQLSTATE ${sqlState ?? "unknown"}`,
      });
    }
    await client.query("ROLLBACK TO SAVEPOINT before_negative_lead_time");

    // 4. `direct_email` without a website is a contact route nobody can follow.
    await client.query("SAVEPOINT before_bad_contact");
    try {
      await client.query(
        `INSERT INTO supplier (id, slug, name, contact_policy)
         VALUES ('verify-contact', 'verify-contact', 'Verify', 'direct_email')`,
      );
      outcomes.push({
        label: "direct_email without a website rejected",
        passed: false,
        detail: "the INSERT SUCCEEDED",
      });
    } catch (error) {
      const sqlState = sqlStateOf(error);
      outcomes.push({
        label: "direct_email without a website rejected",
        passed: sqlState === CHECK_VIOLATION_SQLSTATE,
        detail: `SQLSTATE ${sqlState ?? "unknown"}`,
      });
    }
    await client.query("ROLLBACK TO SAVEPOINT before_bad_contact");

    // 5. A curated capability must not vanish out from under a listing that claims it.
    await client.query("SAVEPOINT before_capability_delete");
    try {
      await client.query(
        `INSERT INTO supplier_capability_link (supplier_id, capability_id)
         VALUES ('verify-supplier', $1)`,
        [seedCapability.id],
      );
      await client.query(`DELETE FROM supplier_capability WHERE id = $1`, [seedCapability.id]);
      outcomes.push({
        label: "capability DELETE blocked while a supplier claims it",
        passed: false,
        detail: "the DELETE SUCCEEDED — a listing can lose a capability silently",
      });
    } catch (error) {
      const sqlState = sqlStateOf(error);
      outcomes.push({
        label: "capability DELETE blocked while a supplier claims it",
        passed: sqlState === FOREIGN_KEY_VIOLATION_SQLSTATE,
        detail: `SQLSTATE ${sqlState ?? "unknown"}`,
      });
    }
    await client.query("ROLLBACK TO SAVEPOINT before_capability_delete");

    // 6. One engagement row per (project, supplier) pair. Re-approaching moves the status;
    //    it does not file a second row.
    const [seedProject] = (
      await client.query<{ id: string }>(`SELECT id FROM research_project LIMIT 1`)
    ).rows;
    const [seedMember] = (
      await client.query<{ id: string }>(
        `SELECT id FROM project_member WHERE project_id = $1 LIMIT 1`,
        [seedProject?.id ?? ""],
      )
    ).rows;

    if (seedProject && seedMember) {
      await client.query("SAVEPOINT before_duplicate_engagement");
      try {
        await client.query(
          `INSERT INTO project_supplier_engagement
             (id, project_id, supplier_id, created_by_member_id)
           VALUES ('verify-engagement-1', $1, 'verify-supplier', $2)`,
          [seedProject.id, seedMember.id],
        );
        await client.query(
          `INSERT INTO project_supplier_engagement
             (id, project_id, supplier_id, created_by_member_id)
           VALUES ('verify-engagement-2', $1, 'verify-supplier', $2)`,
          [seedProject.id, seedMember.id],
        );
        outcomes.push({
          label: "duplicate (project, supplier) engagement rejected",
          passed: false,
          detail: "the second INSERT SUCCEEDED",
        });
      } catch (error) {
        const sqlState = sqlStateOf(error);
        outcomes.push({
          label: "duplicate (project, supplier) engagement rejected",
          passed: sqlState === UNIQUE_VIOLATION_SQLSTATE,
          detail: `SQLSTATE ${sqlState ?? "unknown"}`,
        });
      }
      await client.query("ROLLBACK TO SAVEPOINT before_duplicate_engagement");
    } else {
      outcomes.push({
        label: "duplicate (project, supplier) engagement rejected",
        passed: false,
        detail: "SKIPPED — no research_project/project_member fixture in this database",
      });
    }

    // 7. R1 in force: a project that has shipped a listing cannot be deleted.
    const [seedProductProject] = (
      await client.query<{ id: string }>(`SELECT id FROM research_project LIMIT 1`)
    ).rows;
    const [seedSeller] = (await client.query<{ id: string }>(`SELECT id FROM "user" LIMIT 1`)).rows;

    if (seedProductProject && seedSeller) {
      await client.query("SAVEPOINT before_project_delete");
      try {
        await client.query(
          `INSERT INTO product (id, seller_id, research_project_id, title, category, price_in_cents)
           VALUES ('verify-product', $1, $2, 'Verify', 'home_kitchen', 100)`,
          [seedSeller.id, seedProductProject.id],
        );
        await client.query(`DELETE FROM research_project WHERE id = $1`, [seedProductProject.id]);
        outcomes.push({
          label: "research_project DELETE blocked by a linked product (R1)",
          passed: false,
          detail: "the DELETE SUCCEEDED — a listing can outlive its project",
        });
      } catch (error) {
        const sqlState = sqlStateOf(error);
        outcomes.push({
          label: "research_project DELETE blocked by a linked product (R1)",
          passed: sqlState === FOREIGN_KEY_VIOLATION_SQLSTATE,
          detail: `SQLSTATE ${sqlState ?? "unknown"}`,
        });
      }
      await client.query("ROLLBACK TO SAVEPOINT before_project_delete");
    } else {
      outcomes.push({
        label: "research_project DELETE blocked by a linked product (R1)",
        passed: false,
        detail: "SKIPPED — no research_project/user fixture in this database",
      });
    }

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
      ? `\nAll ${outcomes.length} go-to-market guarantees verified.`
      : `\n${failureCount} of ${outcomes.length} guarantees FAILED.`,
  );

  if (failureCount > 0) {
    process.exitCode = 1;
  }
}

main()
  .then(async () => {
    await pool.end();
    // Deliberately NOT process.exit(0): main() sets process.exitCode = 1 when a guarantee
    // failed, and exiting explicitly here would report success to a CI gate meant to block.
    return undefined;
  })
  .catch(async (error: unknown) => {
    console.error("Go-to-market constraint verification failed to run:", error);
    await pool.end();
    process.exit(1);
  });
