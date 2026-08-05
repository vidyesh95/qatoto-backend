/**
 * Verifies Store Phase 1/2 database invariants after migrations 0043–0044.
 *
 * Also backfills missing `store_search_document` rows for eligible products and
 * active provider offerings when `--backfill` is passed.
 *
 *   npm run db:verify-store-phase-1-2-constraints
 *   npm run db:backfill-store-search-documents
 */
import "dotenv/config";
import { pool } from "#src/db/index.js";
import {
  refreshOfferingSearchDocument,
  refreshProductSearchDocument,
} from "#src/services/store-search.service.js";

interface CheckOutcome {
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

const EXPECTED_PROVIDER_KIND_COUNT = 9;

const EXPECTED_TABLES: readonly string[] = [
  "commerce_provider_kind",
  "commerce_provider_profile",
  "commerce_provider_kind_link",
  "commerce_service_offering",
  "commerce_service_coverage",
  "store_search_document",
  "store_hero_slide",
  "store_pathway",
  "store_pathway_item",
  "store_rail",
  "store_rail_placement",
  "commerce_product_specification",
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
    label: "all store phase 1/2 tables exist",
    passed: tableCount === EXPECTED_TABLES.length,
    detail: `${String(tableCount)}/${String(EXPECTED_TABLES.length)}`,
  });

  const providerKindCount = await countQuery(
    `SELECT count(*) AS row_count FROM commerce_provider_kind`,
  );
  outcomes.push({
    label: "provider kinds are seeded",
    passed: providerKindCount === EXPECTED_PROVIDER_KIND_COUNT,
    detail: `${String(providerKindCount)}/${String(EXPECTED_PROVIDER_KIND_COUNT)}`,
  });

  const duplicatePublicSlugCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM (
         SELECT public_slug
         FROM product
         WHERE public_slug IS NOT NULL
         GROUP BY public_slug
         HAVING count(*) > 1
       ) AS duplicate_slugs`,
  );
  outcomes.push({
    label: "public slugs are unique",
    passed: duplicatePublicSlugCount === 0,
    detail: `${String(duplicatePublicSlugCount)} duplicate slug(s)`,
  });

  const orphanOwnershipCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM product
      WHERE status = 'active'
        AND (seller_organization_id IS NULL OR created_by_user_id IS NULL OR category_id IS NULL)`,
  );
  outcomes.push({
    label: "active products retain org ownership and category",
    passed: orphanOwnershipCount === 0,
    detail: `${String(orphanOwnershipCount)} orphan active product(s)`,
  });

  const ftsColumnCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'store_search_document'
        AND column_name = 'search_document'`,
  );
  outcomes.push({
    label: "store_search_document.search_document FTS column exists",
    passed: ftsColumnCount === 1,
    detail: `${String(ftsColumnCount)} column(s)`,
  });

  const eligibleProductCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM product AS p
       JOIN commerce_organization AS o ON o.id = p.seller_organization_id
       JOIN commerce_category AS c ON c.id = p.category_id
      WHERE p.status = 'active'
        AND p.moderation_state = 'approved'
        AND p.public_slug IS NOT NULL
        AND o.trade_state = 'active'
        AND o.visibility = 'public'
        AND c.state = 'active'`,
  );
  const eligibleSearchProductCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM store_search_document
      WHERE document_kind = 'product' AND is_eligible`,
  );
  outcomes.push({
    label: "eligible products have search documents",
    passed: eligibleSearchProductCount >= eligibleProductCount,
    detail: `search=${String(eligibleSearchProductCount)} eligible_products=${String(eligibleProductCount)}`,
  });

  const staleEligibleDocuments = await countQuery(
    `SELECT count(*) AS row_count
       FROM store_search_document AS s
       LEFT JOIN product AS p
         ON p.id = s.entity_id AND s.document_kind = 'product'
       LEFT JOIN commerce_organization AS o ON o.id = s.organization_id
      WHERE s.document_kind = 'product'
        AND s.is_eligible
        AND (
          p.id IS NULL
          OR p.status <> 'active'
          OR p.moderation_state <> 'approved'
          OR p.public_slug IS NULL
          OR o.trade_state <> 'active'
          OR o.visibility <> 'public'
        )`,
  );
  outcomes.push({
    label: "no stale eligible product search documents",
    passed: staleEligibleDocuments === 0,
    detail: `${String(staleEligibleDocuments)} stale row(s)`,
  });

  return outcomes;
}

async function backfillSearchDocuments(): Promise<{
  readonly productsRefreshed: number;
  readonly offeringsRefreshed: number;
}> {
  const productRows = await pool.query<{ readonly id: string }>(
    `SELECT id
       FROM product
      WHERE seller_organization_id IS NOT NULL
        AND public_slug IS NOT NULL`,
  );
  for (const row of productRows.rows) {
    await refreshProductSearchDocument(row.id);
  }

  const offeringRows = await pool.query<{ readonly id: string }>(
    `SELECT id FROM commerce_service_offering`,
  );
  for (const row of offeringRows.rows) {
    await refreshOfferingSearchDocument(row.id);
  }

  return {
    productsRefreshed: productRows.rows.length,
    offeringsRefreshed: offeringRows.rows.length,
  };
}

async function main(): Promise<void> {
  const shouldBackfill = process.argv.includes("--backfill");
  if (shouldBackfill) {
    const backfill = await backfillSearchDocuments();
    console.log(
      `Backfilled search documents: products=${String(backfill.productsRefreshed)} offerings=${String(backfill.offeringsRefreshed)}`,
    );
  }

  const outcomes = await verifyPhaseConstraints();
  let failed = 0;
  for (const outcome of outcomes) {
    const mark = outcome.passed ? "PASS" : "FAIL";
    if (!outcome.passed) failed += 1;
    console.log(`[${mark}] ${outcome.label} (${outcome.detail})`);
  }

  if (failed > 0) {
    throw new Error(`${String(failed)} store phase 1/2 constraint check(s) failed.`);
  }
  console.log("Store Phase 1/2 constraints verified.");
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error(error);
    await pool.end();
    process.exit(1);
  });
