/**
 * Asserts the STORE Phase 27 invariants against a live database.
 *
 *   pnpm run db:verify-store-phase-27-constraints
 *
 * WHAT PHASE 27 ADDED, and why each piece is worth an assertion of its own:
 *
 *   A43 — legs can be added to an existing shipment and re-pointed at a forwarder. No migration:
 *         it rides `commerce_shipment_leg`, which already had everything it needed.
 *   A44 — `product.sourcing_quote_product_line_id`, the ONLY cost-of-goods record in this backend.
 *   A45 — `commerce_checkout_prepare.requested_freight_mode` and the order's snapshot of it.
 *   A46 — `GET /commerce/sourcing/quote-lines`, a read with no schema of its own.
 *
 * ⚠️ **THE MODE COLUMNS MUST BE `commerce_shipment_leg_mode`, AND THAT IS THE CHECK MOST WORTH
 * HAVING.** `freight_transport_mode` has five members including `multimodal`; the leg enum has
 * four. Both would accept every value the application currently writes, so picking the wrong one
 * fails NOTHING — until the day something writes `multimodal` into a column the shipment rail
 * cannot represent. §19.2 says it in as many words: do not mint a second mode enum.
 *
 * ⚠️ **THE INDEX MUST BE PARTIAL.** A full index over `sourcing_quote_product_line_id` answers
 * every query correctly and is therefore invisible to any functional test — it just carries a row
 * per listing for a column almost every listing leaves null. Only the catalog can tell you.
 *
 * ⚠️ **NULLABILITY IS ASSERTED, NOT ASSUMED.** All three columns are nullable by design: a listing
 * sourced outside Qatoto has no quote, and a buyer who never picked a mode has no mode. A future
 * `NOT NULL` would be a silent product change — it would make "not asked" unrepresentable.
 *
 * Nothing here writes. Every check is catalog or aggregate introspection.
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

async function columnFacts(
  tableName: string,
  columnName: string,
): Promise<{ readonly udtName: string | null; readonly isNullable: string | null }> {
  const result = await db.execute<{ udt_name: string; is_nullable: string }>(sql`
    SELECT udt_name, is_nullable
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ${tableName} AND column_name = ${columnName}`);
  const row = result.rows[0];
  return { udtName: row?.udt_name ?? null, isNullable: row?.is_nullable ?? null };
}

/** One assertion covering existence, type and nullability — the three ways a column can be wrong. */
function columnCheck(
  label: string,
  tableName: string,
  columnName: string,
  expectedUdtName: string,
  why: string,
): Check {
  return {
    name: label,
    why,
    async run() {
      const facts = await columnFacts(tableName, columnName);
      if (facts.udtName === null) {
        return { ok: false, detail: `${tableName}.${columnName} does not exist` };
      }
      const ok = facts.udtName === expectedUdtName && facts.isNullable === "YES";
      return {
        ok,
        detail: `${tableName}.${columnName} is ${facts.udtName}, nullable=${facts.isNullable ?? "?"} (expected ${expectedUdtName}, nullable=YES)`,
      };
    },
  };
}

const CHECKS: readonly Check[] = [
  columnCheck(
    "A44 · product.sourcing_quote_product_line_id exists and is nullable text",
    "product",
    "sourcing_quote_product_line_id",
    "text",
    "Without it the listing editor has nowhere to record a cost basis, and `sourcingCost` on the earnings read is permanently empty. NOT NULL would be worse than absent: it would demand a Qatoto quote behind every listing.",
  ),
  columnCheck(
    "A45 · commerce_checkout_prepare.requested_freight_mode uses the LEG mode enum",
    "commerce_checkout_prepare",
    "requested_freight_mode",
    "commerce_shipment_leg_mode",
    "`freight_transport_mode` would also accept every value written today, and would silently admit `multimodal` — which a shipment leg cannot represent. §19.2 forbids a second mode enum for exactly this reason.",
  ),
  columnCheck(
    "A45 · commerce_order.requested_freight_mode_snapshot uses the LEG mode enum",
    "commerce_order",
    "requested_freight_mode_snapshot",
    "commerce_shipment_leg_mode",
    "Same enum, same reason. It is also the column a seller reads to learn what the buyer asked for, so a wrong type here is wrong on a commercial record.",
  ),
  {
    name: "A44 · the sourcing FK exists and is ON DELETE RESTRICT",
    why: "A quote line that priced a listing's goods must not be deletable out from under it — `restrict` is what makes the cost basis a durable record rather than a dangling id. `cascade` here would silently erase a seller's cost history; `set null` would erase it loudly but just as permanently.",
    async run() {
      const result = await db.execute<{ confdeltype: string }>(sql`
        SELECT confdeltype
          FROM pg_constraint
         WHERE conname = 'product_sourcing_quote_product_line_id_commerce_quote_product_line_id_fk'`);
      const deleteAction = result.rows[0]?.confdeltype ?? null;
      return {
        ok: deleteAction === "r",
        detail:
          deleteAction === null
            ? "constraint not found"
            : `confdeltype=${deleteAction} (expected 'r' for RESTRICT)`,
      };
    },
  },
  {
    name: "A44 · product_sourcing_quote_line_idx exists AND is partial",
    why: "A full index answers every query correctly, so nothing functional can detect the difference — it just carries a row per listing for a column nearly every listing leaves null. The partial predicate is the whole point of the index, and only the catalog can confirm it survived.",
    async run() {
      const result = await db.execute<{ indexdef: string }>(sql`
        SELECT indexdef FROM pg_indexes WHERE indexname = 'product_sourcing_quote_line_idx'`);
      const definition = result.rows[0]?.indexdef ?? null;
      if (definition === null) return { ok: false, detail: "index not found" };
      const isPartial = definition.includes("WHERE (sourcing_quote_product_line_id IS NOT NULL)");
      return {
        ok: isPartial,
        detail: isPartial ? "partial, as specified" : `NOT partial — ${definition}`,
      };
    },
  },
  {
    name: "A44 · every recorded cost basis points at an ACCEPTED revision",
    why: "`assertSourcingQuoteLineUsable` enforces this on write and `listSourcingQuoteLines` offers only lines that satisfy it — but neither is a database constraint, and no CHECK can express a four-table join. A row that fails here means a listing is claiming a cost from a quote nobody accepted, which would feed a wrong number into the earnings read.",
    async run() {
      const wrong = await scalar(sql`
        SELECT count(*)::int AS value
          FROM product p
          JOIN commerce_quote_product_line line ON line.id = p.sourcing_quote_product_line_id
          JOIN commerce_quote_revision revision ON revision.id = line.revision_id
          JOIN commerce_quote quote ON quote.id = revision.quote_id
         WHERE quote.accepted_revision_number IS DISTINCT FROM revision.revision_number`);
      return {
        ok: wrong === 0,
        detail: `${String(wrong)} listing(s) linked to a non-accepted revision`,
      };
    },
  },
  {
    name: "A44 · every recorded cost basis belongs to the listing's own organization",
    why: "The seller must have been the BUYER of that quote. Buyer identity lives on `commerce_rfq`, one hop past the quote, so a mistake here is a listing quietly carrying another organization's negotiated price — a cross-tenant read by way of a foreign key.",
    async run() {
      const wrong = await scalar(sql`
        SELECT count(*)::int AS value
          FROM product p
          JOIN commerce_quote_product_line line ON line.id = p.sourcing_quote_product_line_id
          JOIN commerce_quote_revision revision ON revision.id = line.revision_id
          JOIN commerce_quote quote ON quote.id = revision.quote_id
          JOIN commerce_rfq rfq ON rfq.id = quote.rfq_id
         WHERE rfq.buyer_organization_id IS DISTINCT FROM p.seller_organization_id`);
      return {
        ok: wrong === 0,
        detail: `${String(wrong)} listing(s) linked to another organization's quote`,
      };
    },
  },
  {
    name: "A45 · no order carries a requested mode the leg enum cannot represent",
    why: "Trivially true while the column is the leg enum — which is exactly why it is worth asserting beside the type check rather than instead of it. If the type check ever regresses to `freight_transport_mode`, this is the assertion that shows a real `multimodal` row arriving.",
    async run() {
      const wrong = await scalar(sql`
        SELECT count(*)::int AS value
          FROM commerce_order
         WHERE requested_freight_mode_snapshot IS NOT NULL
           AND requested_freight_mode_snapshot::text NOT IN ('air', 'sea', 'land', 'rail')`);
      return { ok: wrong === 0, detail: `${String(wrong)} order(s) with an unrepresentable mode` };
    },
  },
];

async function main(): Promise<void> {
  console.log("verify-store-phase-27-constraints\n");
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
