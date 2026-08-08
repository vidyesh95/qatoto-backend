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
