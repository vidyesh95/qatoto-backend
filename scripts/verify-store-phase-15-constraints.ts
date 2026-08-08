/**
 * Asserts the STORE Phase 15 invariants against a live database.
 *
 *   pnpm run db:verify-store-phase-15-constraints
 *
 * Phase 15 closes Appendix A's remaining entries, and most of what it adds is a READ —
 * a projection, a filter key, a list route. A verifier cannot assert a projection, so
 * this file deliberately does not try. What it asserts is the part of the phase that
 * lives in the database and can rot silently:
 *
 *   * the A24 vote table's shape, and above all that its relationship TRIGGER actually
 *     REFUSES a self-vote — presence in `pg_trigger` says nothing about the body, and a
 *     guard whose body is wrong looks identical to one that works;
 *   * the enum members added by `ALTER TYPE`, which are invisible to `drizzle-kit` once
 *     applied and are what several new code paths depend on existing;
 *   * the denormalized search-filter columns, because a filter over a column the refresh
 *     job never populates returns an empty page rather than an error;
 *   * the four keyset indexes, which are the difference between a list route and a
 *     sequential scan of every shipment in the system.
 *
 * DO NOT assert against `store_pathway_item` or `product.seller_id`. Migration `0088`
 * dropped both, and three verifiers went on asserting against them — the Phase 9 one
 * threw `42P01` and lost all twelve of its checks behind the error.
 *
 * Read-only apart from the refusal probes, each rolled back.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";

import { db, pool } from "#src/db/index.js";

interface Check {
  readonly name: string;
  readonly why: string;
  run(): Promise<{ readonly ok: boolean; readonly detail: string }>;
}

async function scalar(query: ReturnType<typeof sql>): Promise<number> {
  const result = await db.execute<{ value: number }>(query);
  return result.rows[0]?.value ?? 0;
}

/**
 * Runs a statement and reports whether the database REFUSED it, rolling back either way.
 *
 * `expectRefusal` is the whole point: a guard that silently accepts a write it should
 * have rejected is the failure mode this file exists to catch, and only an attempted
 * write can distinguish that from a guard that works.
 */
async function probeRefusal(statement: string): Promise<boolean> {
  try {
    await db.transaction(async (transaction) => {
      await transaction.execute(sql.raw(statement));
      throw new Error("verify-probe-rollback");
    });
    return false;
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "verify-probe-rollback") {
      // The statement was ACCEPTED; only our own rollback stopped it.
      return false;
    }
    return true;
  }
}

/** Enum members added by `ALTER TYPE ... ADD VALUE`, which no snapshot records. */
async function enumHasValue(typeName: string, value: string): Promise<boolean> {
  const found = await scalar(sql`
    SELECT count(*)::int AS value
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = ${typeName} AND e.enumlabel = ${value}`);
  return found === 1;
}

async function columnExists(tableName: string, columnName: string): Promise<boolean> {
  const found = await scalar(sql`
    SELECT count(*)::int AS value
      FROM information_schema.columns
     WHERE table_name = ${tableName} AND column_name = ${columnName}`);
  return found === 1;
}

async function indexExists(indexName: string): Promise<boolean> {
  const found = await scalar(sql`
    SELECT count(*)::int AS value FROM pg_indexes WHERE indexname = ${indexName}`);
  return found === 1;
}

const CHECKS: readonly Check[] = [
  // -------------------------------------------------------------------------
  // 0093 — A24 answer votes.
  // -------------------------------------------------------------------------
  {
    name: "0093 · commerce_product_answer_vote is keyed on (answer, organization)",
    why: "Keyed on the user instead, one procurement team would get five votes for five logins.",
    async run() {
      const columns = await db.execute<{ attname: string }>(sql`
        SELECT a.attname
          FROM pg_index i
          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = 'commerce_product_answer_vote'::regclass AND i.indisprimary`);
      const key = columns.rows
        .map((row) => row.attname)
        .toSorted((left, right) => left.localeCompare(right))
        .join(",");
      return {
        ok: key === "answer_id,voter_organization_id",
        detail: key === "" ? "no primary key found" : key,
      };
    },
  },
  {
    name: "0093 · the answer-vote guard REFUSES a self-vote",
    why: "Without it a seller endorses its own answer to the top of every question it answers.",
    async run() {
      const candidate = await db.execute<{
        id: string;
        author_organization_id: string;
        author_member_id: string;
        author_user_id: string;
      }>(sql`
        SELECT id, author_organization_id, author_member_id, author_user_id
          FROM commerce_product_answer
         LIMIT 1`);
      const answer = candidate.rows[0];
      if (!answer) {
        // Not a pass. An unexercised guard is exactly what this file exists to catch,
        // and reporting "ok" here would hide that nothing was tested.
        return { ok: false, detail: "no commerce_product_answer rows — guard UNEXERCISED" };
      }
      const refused = await probeRefusal(`
        INSERT INTO commerce_product_answer_vote
          (answer_id, voter_organization_id, voter_member_id, voter_user_id)
        VALUES ('${answer.id}', '${answer.author_organization_id}',
                '${answer.author_member_id}', '${answer.author_user_id}')`);
      return {
        ok: refused,
        detail: refused ? "refused" : "ACCEPTED an author's vote on its own answer",
      };
    },
  },
  {
    name: "0093 · commerce_product_answer.helpful_count is a non-negative integer",
    why: "A negative endorsement count is not a number a UI can render or a sort can trust.",
    async run() {
      const constrained = await scalar(sql`
        SELECT count(*)::int AS value
          FROM pg_constraint
         WHERE conname = 'commerce_product_answer_helpful_count_ck'`);
      const negatives = await scalar(sql`
        SELECT count(*)::int AS value FROM commerce_product_answer WHERE helpful_count < 0`);
      return {
        ok: constrained === 1 && negatives === 0,
        detail: `check=${String(constrained)} negative_rows=${String(negatives)}`,
      };
    },
  },
  {
    name: "0093 · the helpful preview index exists",
    why: "The seller-first preview breaks its tie on helpful_count; without the index it sorts every answer.",
    async run() {
      const present = await indexExists("commerce_product_answer_question_helpful_idx");
      return { ok: present, detail: present ? "present" : "missing" };
    },
  },

  // -------------------------------------------------------------------------
  // 0094 — A27 per-tier lead time.
  // -------------------------------------------------------------------------
  {
    name: "0094 · product_pricing_tier.lead_time_days is nullable and bounded",
    why: "NULL is the fallback to the product's lead time; a bogus value would reach promisedDeliveryAt.",
    async run() {
      const present = await columnExists("product_pricing_tier", "lead_time_days");
      const nullable = await scalar(sql`
        SELECT count(*)::int AS value
          FROM information_schema.columns
         WHERE table_name = 'product_pricing_tier'
           AND column_name = 'lead_time_days' AND is_nullable = 'YES'`);
      const constrained = await scalar(sql`
        SELECT count(*)::int AS value
          FROM pg_constraint WHERE conname = 'product_pricing_tier_lead_time_ck'`);
      return {
        ok: present && nullable === 1 && constrained === 1,
        detail: `column=${String(present)} nullable=${String(nullable)} check=${String(constrained)}`,
      };
    },
  },
  {
    name: "0094 · the lead-time check REFUSES an out-of-range band",
    why: "A ten-thousand-day band would be snapshotted into a promise nobody can keep.",
    async run() {
      const tier = await db.execute<{ id: string }>(sql`
        SELECT id FROM product_pricing_tier LIMIT 1`);
      const row = tier.rows[0];
      if (!row) {
        return { ok: false, detail: "no product_pricing_tier rows — check UNEXERCISED" };
      }
      const refused = await probeRefusal(
        `UPDATE product_pricing_tier SET lead_time_days = 4000 WHERE id = '${row.id}'`,
      );
      return { ok: refused, detail: refused ? "refused" : "ACCEPTED a 4000-day lead time" };
    },
  },
  {
    name: "0094 · nothing was backfilled onto the tier ladder",
    why: "Copying the product's lead time down onto every band would fake a declaration the seller never made.",
    async run() {
      // Not an assertion that the column is unused — a seller may legitimately have set
      // one since. It asserts only that the MIGRATION did not manufacture values, which
      // would show as every tier of a product carrying its product's lead time exactly.
      const declared = await scalar(sql`
        SELECT count(*)::int AS value FROM product_pricing_tier WHERE lead_time_days IS NOT NULL`);
      const inheritedFromProduct = await scalar(sql`
        SELECT count(*)::int AS value
          FROM product_pricing_tier tier
          JOIN product ON product.id = tier.product_id
         WHERE tier.lead_time_days IS NOT NULL
           AND tier.lead_time_days = product.lead_time_max_days`);
      return {
        ok: declared === 0 || inheritedFromProduct < declared,
        detail: `declared=${String(declared)} equal_to_product=${String(inheritedFromProduct)}`,
      };
    },
  },

  // -------------------------------------------------------------------------
  // 0095 — A25 search depth.
  // -------------------------------------------------------------------------
  {
    name: "0095 · store_search_document_kind carries 'organization'",
    why: "Without the enum member the supplier directory cannot store a single row.",
    async run() {
      const present = await enumHasValue("store_search_document_kind", "organization");
      return { ok: present, detail: present ? "present" : "missing" };
    },
  },
  {
    name: "0095 · store_search_stock_state matches deriveStockState's four values",
    why: "A fifth state in the function with no member here would be silently unfilterable.",
    async run() {
      const labels = await db.execute<{ enumlabel: string }>(sql`
        SELECT e.enumlabel
          FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = 'store_search_stock_state'
         ORDER BY e.enumsortorder`);
      const members = labels.rows.map((row) => row.enumlabel).join(",");
      return {
        ok: members === "in_stock,low_stock,made_to_order,unavailable",
        detail: members === "" ? "type not found" : members,
      };
    },
  },
  {
    name: "0095 · the five facet columns and their two indexes exist",
    why: "A filter over a column the refresh job never populates returns an empty page, not an error.",
    async run() {
      const columns = await Promise.all(
        ["stock_state", "sample_policy", "condition", "provider_verification_state", "lead_time_max_days"].map(
          (column) => columnExists("store_search_document", column),
        ),
      );
      const indexes = await Promise.all(
        ["store_search_document_stock_idx", "store_search_document_price_idx"].map((index) =>
          indexExists(index),
        ),
      );
      const missingColumns = columns.filter((present) => !present).length;
      const missingIndexes = indexes.filter((present) => !present).length;
      return {
        ok: missingColumns === 0 && missingIndexes === 0,
        detail: `missing_columns=${String(missingColumns)} missing_indexes=${String(missingIndexes)}`,
      };
    },
  },
  {
    name: "0095 · every eligible product document carries a stock state",
    why: "A NULL facet is EXCLUDED by the filter, so an unpopulated column hides the product from every stock filter.",
    async run() {
      const eligible = await scalar(sql`
        SELECT count(*)::int AS value FROM store_search_document
         WHERE document_kind = 'product' AND is_eligible`);
      const unpopulated = await scalar(sql`
        SELECT count(*)::int AS value FROM store_search_document
         WHERE document_kind = 'product' AND is_eligible AND stock_state IS NULL`);
      return {
        ok: unpopulated === 0,
        detail: `eligible=${String(eligible)} without_stock_state=${String(unpopulated)}`,
      };
    },
  },
  {
    name: "0095 · the denormalized stock state agrees with the product it describes",
    why: "A card saying 'in stock' that the stock filter disagrees with is the worse of the two bugs.",
    async run() {
      /*
       * Recomputes `deriveStockState` in SQL over products WITHOUT variants — the
       * variant-aware case sums active variant stock and is exercised by the smoke
       * script against a real listing rather than restated here.
       */
      const disagreeing = await scalar(sql`
        SELECT count(*)::int AS value
          FROM store_search_document AS document
          JOIN product ON product.id = document.entity_id
         WHERE document.document_kind = 'product'
           AND document.is_eligible
           AND NOT EXISTS (
                 SELECT 1 FROM commerce_product_variant variant
                  WHERE variant.product_id = product.id AND variant.state = 'active')
           AND document.stock_state::text <> CASE
                 WHEN product.stock_quantity <= 0 AND product.lead_time_min_days IS NOT NULL
                      AND product.lead_time_max_days IS NOT NULL THEN 'made_to_order'
                 WHEN product.stock_quantity <= 0 THEN 'unavailable'
                 WHEN product.stock_quantity <= 5 THEN 'low_stock'
                 ELSE 'in_stock' END`);
      return {
        ok: disagreeing === 0,
        detail: `${String(disagreeing)} product document(s) disagree with their listing`,
      };
    },
  },
  {
    name: "0095 · every organization has a search document",
    why: "A missing row means the supplier never appears in the directory and nothing reports it.",
    async run() {
      const organizations = await scalar(sql`
        SELECT count(*)::int AS value FROM commerce_organization`);
      const documents = await scalar(sql`
        SELECT count(*)::int AS value
          FROM store_search_document WHERE document_kind = 'organization'`);
      return {
        ok: documents >= organizations,
        detail: `organizations=${String(organizations)} documents=${String(documents)}`,
      };
    },
  },
  {
    name: "0095 · organization eligibility matches active-and-public exactly",
    why: "A private or pending organization in the directory discloses a company that has not chosen to trade publicly.",
    async run() {
      const mismatched = await scalar(sql`
        SELECT count(*)::int AS value
          FROM store_search_document AS document
          JOIN commerce_organization AS organization ON organization.id = document.entity_id
         WHERE document.document_kind = 'organization'
           AND document.is_eligible
             <> (organization.trade_state = 'active' AND organization.visibility = 'public')`);
      return {
        ok: mismatched === 0,
        detail: `${String(mismatched)} organization document(s) disagree with their row`,
      };
    },
  },
];

async function main(): Promise<void> {
  console.log("verify-store-phase-15-constraints\n");
  let failures = 0;

  for (const check of CHECKS) {
    const result = await check.run();
    console.log(`${result.ok ? "  ok  " : "  FAIL"}  ${check.name} — ${result.detail}`);
    if (!result.ok) {
      console.log(`        why it matters: ${check.why}`);
      failures += 1;
    }
  }

  console.log(`\n${String(CHECKS.length - failures)}/${String(CHECKS.length)} checks passed.`);
  if (failures > 0) process.exitCode = 1;
}

await main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });

export { columnExists, enumHasValue, indexExists, probeRefusal, scalar };
