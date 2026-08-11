/**
 * Asserts the STORE Phase 22 invariants against a live database.
 *
 *   pnpm run db:verify-store-phase-22-constraints
 *
 * WHAT THIS FILE IS REALLY GUARDING is one sentence: the search document must say the same
 * thing about a product that the product itself says. Phase 22 moved the facet counts onto that
 * document, so from now on a stale column is not merely a stale search result — it is a COUNT
 * that disagrees with the cards printed underneath it.
 *
 * THE FIRST TWO CHECKS ARE THE ONES THAT WOULD HAVE CAUGHT THE BUG. `stock_state` and
 * `price_in_cents` are both variant-derived on the document and were both product-row-derived
 * in the old facet SQL, which is how "In stock (12)" came to sit above twelve cards reading
 * *Unavailable*. Nothing tested either, because every suite in this repo mocks the database.
 *
 * THE THIRD IS THE MODERATION BUG Phase 22a closed. `is_eligible` is frozen at write time, so
 * a suspended product stayed findable in `/store/search` until somebody enqueued a refresh.
 *
 * Nothing here writes. The refusal probes each roll back.
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

async function indexExists(indexName: string): Promise<boolean> {
  const found = await scalar(sql`
    SELECT count(*)::int AS value FROM pg_indexes WHERE indexname = ${indexName}`);
  return found === 1;
}

/**
 * `deriveStockState`, in SQL, over the SAME input the document uses — the active variant sum
 * where variants exist, the product row otherwise.
 *
 * Restated here on purpose. This is a verifier: expressing the rule independently is what makes
 * it capable of disagreeing with the implementation. Importing the function would only prove
 * the function equals itself.
 */
const EXPECTED_STOCK_STATE = sql`
  CASE
    WHEN COALESCE(variant_totals.total_stock, p.stock_quantity) <= 0
         AND p.lead_time_min_days IS NOT NULL
         AND p.lead_time_max_days IS NOT NULL
      THEN 'made_to_order'
    WHEN COALESCE(variant_totals.total_stock, p.stock_quantity) <= 0 THEN 'unavailable'
    WHEN COALESCE(variant_totals.total_stock, p.stock_quantity) <= 5 THEN 'low_stock'
    ELSE 'in_stock'
  END`;

const VARIANT_TOTALS = sql`
  LEFT JOIN (
    SELECT product_id,
           SUM(stock_quantity)::int AS total_stock,
           MIN(price_in_cents)::int AS min_price
      FROM commerce_product_variant
     WHERE state = 'active'
     GROUP BY product_id
  ) AS variant_totals ON variant_totals.product_id = p.id`;

const CHECKS: readonly Check[] = [
  {
    name: "A39 · every eligible product document agrees with live variant stock",
    why: "THE CHECK THAT WOULD HAVE CAUGHT THE PHASE 22 BUG. The facets now COUNT this column, so a document out of step with its variants does not merely return a stale row — it prints a count above cards that contradict it.",
    async run() {
      const disagreeing = await scalar(sql`
        SELECT count(*)::int AS value
          FROM store_search_document d
          INNER JOIN product p ON p.id = d.entity_id
          ${VARIANT_TOTALS}
         WHERE d.document_kind = 'product'
           AND d.is_eligible = true
           AND d.stock_state::text IS DISTINCT FROM ${EXPECTED_STOCK_STATE}`);
      return {
        ok: disagreeing === 0,
        detail: `${String(disagreeing)} document(s) whose stock_state disagrees with their variants`,
      };
    },
  },
  {
    name: "A39 · every eligible product document agrees with live variant price",
    why: "The price facet publishes min/max from this column. A document carrying the product-row price for a variant-priced product reports a range no listing actually sells at.",
    async run() {
      const disagreeing = await scalar(sql`
        SELECT count(*)::int AS value
          FROM store_search_document d
          INNER JOIN product p ON p.id = d.entity_id
          ${VARIANT_TOTALS}
         WHERE d.document_kind = 'product'
           AND d.is_eligible = true
           AND d.price_in_cents IS DISTINCT FROM COALESCE(variant_totals.min_price, p.price_in_cents)`);
      return {
        ok: disagreeing === 0,
        detail: `${String(disagreeing)} document(s) whose price disagrees with their variants`,
      };
    },
  },
  {
    name: "A39 · no eligible document belongs to a product the catalog would hide",
    why: "THE PHASE 22a BUG. `is_eligible` is frozen at write time, so a moderator-suspended, unpublished, or unapproved listing stayed findable in search until something enqueued a refresh. Moderation is the case that matters: a listing taken down for cause is exactly the one that must not still be searchable.",
    async run() {
      const leaked = await scalar(sql`
        SELECT count(*)::int AS value
          FROM store_search_document d
          INNER JOIN product p ON p.id = d.entity_id
          INNER JOIN commerce_organization o ON o.id = p.seller_organization_id
          LEFT JOIN commerce_category c ON c.id = p.category_id
         WHERE d.document_kind = 'product'
           AND d.is_eligible = true
           AND (p.status <> 'active'
                OR p.moderation_state <> 'approved'
                OR p.public_slug IS NULL
                OR o.trade_state <> 'active'
                OR o.visibility <> 'public'
                OR c.state IS DISTINCT FROM 'active')`);
      return {
        ok: leaked === 0,
        detail: `${String(leaked)} eligible document(s) for a product no public catalog read would return`,
      };
    },
  },
  {
    name: "A39 · no INELIGIBLE document belongs to a product the catalog would show",
    why: "The same staleness pointing the other way. A restored listing stuck out of search while the catalog shows it is the moderation bug inverted, and it is silent — nobody reports a product they cannot find.",
    async run() {
      const hidden = await scalar(sql`
        SELECT count(*)::int AS value
          FROM store_search_document d
          INNER JOIN product p ON p.id = d.entity_id
          INNER JOIN commerce_organization o ON o.id = p.seller_organization_id
          INNER JOIN commerce_category c ON c.id = p.category_id
         WHERE d.document_kind = 'product'
           AND d.is_eligible = false
           AND p.status = 'active'
           AND p.moderation_state = 'approved'
           AND p.public_slug IS NOT NULL
           AND o.trade_state = 'active'
           AND o.visibility = 'public'
           AND c.state = 'active'`);
      return {
        ok: hidden === 0,
        detail: `${String(hidden)} ineligible document(s) for a product the catalog would return`,
      };
    },
  },
  {
    name: "A39 · every eligible product document carries the category slug it is filtered by",
    why: "Both the filters and the facets scope on `category_slug`. A document whose slug drifted from its category row drops out of its own category's counts AND its results together, so the page looks consistent while being wrong.",
    async run() {
      const drifted = await scalar(sql`
        SELECT count(*)::int AS value
          FROM store_search_document d
          INNER JOIN product p ON p.id = d.entity_id
          INNER JOIN commerce_category c ON c.id = p.category_id
         WHERE d.document_kind = 'product'
           AND d.is_eligible = true
           AND d.category_slug IS DISTINCT FROM c.slug`);
      return {
        ok: drifted === 0,
        detail: `${String(drifted)} document(s) whose category_slug drifted from its category`,
      };
    },
  },
  {
    name: "A39 · the facet scan index exists by name",
    why: "Every facet groups a category's eligible rows. Without the partial index they fall back to a sequential scan of the whole table, once per facet, on a page a buyer waits for.",
    async run() {
      const present = await indexExists("store_search_document_eligible_category_idx");
      return { ok: present, detail: present ? "present" : "missing — 0114 was not applied" };
    },
  },
  {
    name: "A39 · no eligible document is missing the columns its facets count",
    why: "A product document with no stock state or no price cannot appear in either facet, so it is invisible to a filter while visible in the results — the divergence Phase 22 closed, reintroduced one row at a time.",
    async run() {
      const incomplete = await scalar(sql`
        SELECT count(*)::int AS value
          FROM store_search_document
         WHERE document_kind = 'product'
           AND is_eligible = true
           AND (stock_state IS NULL OR price_in_cents IS NULL)`);
      return {
        ok: incomplete === 0,
        detail: `${String(incomplete)} eligible product document(s) with no stock state or no price`,
      };
    },
  },
];

async function main(): Promise<void> {
  console.log("verify-store-phase-22-constraints\n");
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
