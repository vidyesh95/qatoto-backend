/**
 * Verifies migration 0040's database-level commerce foundation guarantees.
 *
 * Catalog/backfill checks are read-only. Runtime probes use disposable rows inside a
 * transaction that is always rolled back.
 *
 *   npm run db:verify-commerce-foundation-constraints
 */
import { randomUUID } from "node:crypto";

import "dotenv/config";
import type { PoolClient } from "pg";

import { pool } from "#src/db/index.js";

interface CheckOutcome {
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

type TransactionClient = Pick<PoolClient, "query">;

const CHECK_VIOLATION_SQLSTATE = "23514";
const UNIQUE_VIOLATION_SQLSTATE = "23505";
const APPEND_ONLY_SQLSTATE = "QT001";

const EXPECTED_TABLES: readonly string[] = [
  "commerce_organization",
  "commerce_organization_member",
  "commerce_organization_address",
  "commerce_encrypted_document",
  "commerce_organization_verification",
  "commerce_category",
  "commerce_organization_audit_entry",
];

const EXPECTED_ROOT_CATEGORY_IDS: readonly string[] = [
  "commerce_category_electronics",
  "commerce_category_fashion",
  "commerce_category_home_kitchen",
  "commerce_category_anime_collectibles",
  "commerce_category_digital_goods",
  "commerce_category_books_media",
  "commerce_category_sports_outdoors",
  "commerce_category_beauty_personal_care",
];

const EXPECTED_TRIGGERS: readonly string[] = [
  "commerce_category_reject_cycle",
  "commerce_organization_verification_document_scope",
  "commerce_organization_audit_entry_append_only",
  "commerce_organization_audit_entry_no_truncate",
  "commerce_organization_member_enforce_transition",
  /**
   * `commerce_product_fill_legacy_transition_keys` is deliberately ABSENT. Migration
   * 0063 dropped it: it existed so an application predating organization ownership
   * could still write a product mid-deploy, and the columns it derived are now NOT NULL.
   * Its replacement assertion is the nullability check below.
   */
];

function sqlStateOf(error: unknown): string | undefined {
  let currentError: unknown = error;

  for (let causeDepth = 0; causeDepth < 5 && currentError !== null; causeDepth += 1) {
    if (typeof currentError !== "object") return undefined;

    const codeDescriptor = Object.getOwnPropertyDescriptor(currentError, "code");
    if (typeof codeDescriptor?.value === "string") return codeDescriptor.value;

    const causeDescriptor = Object.getOwnPropertyDescriptor(currentError, "cause");
    currentError = causeDescriptor?.value;
  }

  return undefined;
}

async function countQuery(queryText: string, values: readonly unknown[] = []): Promise<number> {
  const queryResult = await pool.query<{ readonly row_count: string }>(queryText, [...values]);
  return Number(queryResult.rows[0]?.row_count ?? 0);
}

async function verifyCatalogAndBackfill(): Promise<readonly CheckOutcome[]> {
  const outcomes: CheckOutcome[] = [];

  const tableCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [EXPECTED_TABLES],
  );
  outcomes.push({
    label: "all commerce foundation tables exist",
    passed: tableCount === EXPECTED_TABLES.length,
    detail: `${String(tableCount)}/${String(EXPECTED_TABLES.length)}`,
  });

  const duplicateCurrentMembershipCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM (
         SELECT organization_id, user_id
         FROM commerce_organization_member
         WHERE state <> 'left'
         GROUP BY organization_id, user_id
         HAVING count(*) > 1
       ) AS duplicate_membership`,
  );
  outcomes.push({
    label: "one current membership exists per organization and user",
    passed: duplicateCurrentMembershipCount === 0,
    detail: `${String(duplicateCurrentMembershipCount)} duplicate pair(s)`,
  });

  const rootCategoryCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_category
      WHERE id = ANY($1)
        AND parent_category_id IS NULL
        AND state = 'active'`,
    [EXPECTED_ROOT_CATEGORY_IDS],
  );
  outcomes.push({
    label: "all deterministic root categories are active",
    passed: rootCategoryCount === EXPECTED_ROOT_CATEGORY_IDS.length,
    detail: `${String(rootCategoryCount)}/${String(EXPECTED_ROOT_CATEGORY_IDS.length)}`,
  });

  const unmigratedProductCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM product
      WHERE seller_organization_id IS NULL
         OR created_by_user_id IS NULL
         OR category_id IS NULL`,
  );
  outcomes.push({
    label: "every legacy product has transition ownership and category keys",
    passed: unmigratedProductCount === 0,
    detail: `${String(unmigratedProductCount)} incomplete product(s)`,
  });

  const incorrectlyMappedProductCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM product
      WHERE created_by_user_id <> seller_id
         OR seller_organization_id <> 'commerce_org_legacy_' || md5(seller_id)
         OR category_id <> CASE category
              WHEN 'electronics' THEN 'commerce_category_electronics'
              WHEN 'fashion' THEN 'commerce_category_fashion'
              WHEN 'home_kitchen' THEN 'commerce_category_home_kitchen'
              WHEN 'anime_collectibles' THEN 'commerce_category_anime_collectibles'
              WHEN 'digital_goods' THEN 'commerce_category_digital_goods'
              WHEN 'books_media' THEN 'commerce_category_books_media'
              WHEN 'sports_outdoors' THEN 'commerce_category_sports_outdoors'
              WHEN 'beauty_personal_care' THEN 'commerce_category_beauty_personal_care'
            END`,
  );
  outcomes.push({
    label: "legacy product mappings are deterministic",
    passed: incorrectlyMappedProductCount === 0,
    detail: `${String(incorrectlyMappedProductCount)} mismatched product(s)`,
  });

  const sellerWithoutOwnerMembershipCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM (SELECT DISTINCT seller_id, seller_organization_id FROM product) AS legacy_seller
       LEFT JOIN commerce_organization AS organization
         ON organization.id = legacy_seller.seller_organization_id
        AND organization.organization_type = 'sole_proprietor'
        AND organization.visibility = 'private'
       LEFT JOIN commerce_organization_member AS owner_member
         ON owner_member.organization_id = legacy_seller.seller_organization_id
        AND owner_member.user_id = legacy_seller.seller_id
        AND owner_member.role = 'owner'
        AND owner_member.state = 'active'
      WHERE organization.id IS NULL OR owner_member.id IS NULL`,
  );
  outcomes.push({
    label: "every migrated seller owns a private sole-proprietor organization",
    passed: sellerWithoutOwnerMembershipCount === 0,
    detail: `${String(sellerWithoutOwnerMembershipCount)} seller(s) missing organization ownership`,
  });

  const invalidSessionContextCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM session AS commerce_session
       LEFT JOIN commerce_organization_member AS active_member
         ON active_member.organization_id = commerce_session.active_organization_id
        AND active_member.user_id = commerce_session.user_id
        AND active_member.state = 'active'
      WHERE commerce_session.active_organization_id IS NOT NULL
        AND active_member.id IS NULL`,
  );
  outcomes.push({
    label: "every selected session organization has active membership",
    passed: invalidSessionContextCount === 0,
    detail: `${String(invalidSessionContextCount)} invalid session context(s)`,
  });

  const triggerCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM pg_trigger
      WHERE NOT tgisinternal AND tgname = ANY($1)`,
    [EXPECTED_TRIGGERS],
  );
  outcomes.push({
    label: "hierarchy, evidence-scope, and append-only triggers exist",
    passed: triggerCount === EXPECTED_TRIGGERS.length,
    detail: `${String(triggerCount)}/${String(EXPECTED_TRIGGERS.length)}`,
  });

  return outcomes;
}

async function expectSqlRejection(
  transactionClient: TransactionClient,
  outcomes: CheckOutcome[],
  label: string,
  expectedSqlState: string,
  rejectedStatement: () => Promise<unknown>,
): Promise<void> {
  const savepointName = `commerce_probe_${String(outcomes.length)}`;
  await transactionClient.query(`SAVEPOINT ${savepointName}`);

  try {
    await rejectedStatement();
    outcomes.push({ label, passed: false, detail: "statement unexpectedly succeeded" });
  } catch (error: unknown) {
    const actualSqlState = sqlStateOf(error) ?? "unknown";
    outcomes.push({
      label,
      passed: actualSqlState === expectedSqlState,
      detail: `SQLSTATE ${actualSqlState} (expected ${expectedSqlState})`,
    });
  } finally {
    await transactionClient.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
  }
}

async function verifyRuntimeConstraints(): Promise<readonly CheckOutcome[]> {
  const transactionClient = await pool.connect();
  const outcomes: CheckOutcome[] = [];
  const fixtureSuffix = randomUUID();
  const fixtureUserId = `verify-commerce-user-${fixtureSuffix}`;
  const primaryOrganizationId = `verify-commerce-org-a-${fixtureSuffix}`;
  const secondaryOrganizationId = `verify-commerce-org-b-${fixtureSuffix}`;
  const primaryDocumentId = `verify-commerce-document-${fixtureSuffix}`;
  const parentCategoryId = `verify-commerce-category-parent-${fixtureSuffix}`;
  const childCategoryId = `verify-commerce-category-child-${fixtureSuffix}`;
  const auditEntryId = `verify-commerce-audit-${fixtureSuffix}`;
  const invitedMemberId = `verify-commerce-member-${fixtureSuffix}`;
  // The legacy product probe and its derived organization id went with the fill trigger
  // in 0063; nothing inserts a product here any more.

  try {
    await transactionClient.query("BEGIN");
    await transactionClient.query(
      `INSERT INTO "user" (id, name, email, email_verified)
       VALUES ($1, 'Commerce verifier', $2, true)`,
      [fixtureUserId, `verify-commerce-${fixtureSuffix}@example.invalid`],
    );

    await transactionClient.query(
      `INSERT INTO commerce_organization
         (id, slug, legal_name, normalized_legal_name, display_name, organization_type,
          trade_state, visibility, country_code, created_by_user_id)
       VALUES
         ($1, $2, 'Verifier A', 'verifier a', 'Verifier A', 'company', 'active', 'private', 'ZZ', $3),
         ($4, $5, 'Verifier B', 'verifier b', 'Verifier B', 'company', 'active', 'private', 'ZZ', $3)`,
      [
        primaryOrganizationId,
        `verify-commerce-a-${fixtureSuffix}`,
        fixtureUserId,
        secondaryOrganizationId,
        `verify-commerce-b-${fixtureSuffix}`,
      ],
    );
    await transactionClient.query(
      `INSERT INTO commerce_organization_member
         (id, organization_id, user_id, role, state, invited_by_user_id)
       VALUES ($1, $2, $3, 'viewer', 'invited', $3)`,
      [invitedMemberId, primaryOrganizationId, fixtureUserId],
    );
    await expectSqlRejection(
      transactionClient,
      outcomes,
      "invited memberships cannot skip acceptance into suspension",
      CHECK_VIOLATION_SQLSTATE,
      () =>
        transactionClient.query(
          `UPDATE commerce_organization_member
              SET state = 'suspended', joined_at = now()
            WHERE id = $1`,
          [invitedMemberId],
        ),
    );
    await expectSqlRejection(
      transactionClient,
      outcomes,
      "a second current membership is rejected",
      UNIQUE_VIOLATION_SQLSTATE,
      () =>
        transactionClient.query(
          `INSERT INTO commerce_organization_member
             (id, organization_id, user_id, role, state, invited_by_user_id)
           VALUES ($1, $2, $3, 'buyer', 'invited', $3)`,
          [
            `verify-commerce-member-duplicate-${fixtureSuffix}`,
            primaryOrganizationId,
            fixtureUserId,
          ],
        ),
    );

    /**
     * CONTRACT PHASE (0063). This used to insert a product carrying only `seller_id` and
     * `category` and assert the fill trigger derived the rest. With the trigger dropped
     * and the columns NOT NULL, that insert now fails with `23502` — so the probe is
     * replaced by the assertion that supersedes it: the columns are mandatory, which is
     * a stronger guarantee than a trigger that could repair them after the fact.
     */
    const transitionNullabilityResult = await transactionClient.query<{
      readonly column_name: string;
      readonly is_nullable: string;
    }>(
      `SELECT column_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'product'
          AND column_name = ANY($1)`,
      [["seller_organization_id", "created_by_user_id", "category_id"]],
    );
    const mandatoryColumns = transitionNullabilityResult.rows.filter(
      (column) => column.is_nullable === "NO",
    );
    outcomes.push({
      label: "product ownership and category transition columns are NOT NULL",
      passed: mandatoryColumns.length === 3,
      detail: `${String(mandatoryColumns.length)}/3 mandatory`,
    });
    await transactionClient.query(
      `INSERT INTO commerce_encrypted_document
         (id, organization_id, document_kind, state, storage_provider, object_storage_key,
          media_type, file_byte_size, content_sha256, encryption_algorithm,
          encryption_key_version, encrypted_data_key, initialization_vector, uploaded_by_user_id)
       VALUES ($1, $2, 'business_registration', 'available', 'verification',
               $3, 'application/pdf', 100, $4, 'aes-256-gcm', 1,
               'encrypted-data-key', 'initialization-vector', $5)`,
      [
        primaryDocumentId,
        primaryOrganizationId,
        `verify-commerce/${fixtureSuffix}`,
        "0".repeat(64),
        fixtureUserId,
      ],
    );

    await expectSqlRejection(
      transactionClient,
      outcomes,
      "verification cannot borrow another organization's evidence",
      CHECK_VIOLATION_SQLSTATE,
      () =>
        transactionClient.query(
          `INSERT INTO commerce_organization_verification
             (id, organization_id, verification_kind, evidence_document_id, submitted_by_user_id)
           VALUES ($1, $2, 'business_registration', $3, $4)`,
          [
            `verify-commerce-verification-${fixtureSuffix}`,
            secondaryOrganizationId,
            primaryDocumentId,
            fixtureUserId,
          ],
        ),
    );

    await transactionClient.query(
      `INSERT INTO commerce_category (id, slug, name, sibling_order)
       SELECT $1, $2, 'Verifier parent', coalesce(max(sibling_order), -1) + 1
         FROM commerce_category
        WHERE parent_category_id IS NULL`,
      [parentCategoryId, `verify-commerce-parent-${fixtureSuffix}`],
    );
    await transactionClient.query(
      `INSERT INTO commerce_category (id, slug, name, parent_category_id, sibling_order)
       VALUES ($1, $2, 'Verifier child', $3, 0)`,
      [childCategoryId, `verify-commerce-child-${fixtureSuffix}`, parentCategoryId],
    );

    await expectSqlRejection(
      transactionClient,
      outcomes,
      "category hierarchy rejects multi-row cycles",
      CHECK_VIOLATION_SQLSTATE,
      () =>
        transactionClient.query(
          `UPDATE commerce_category SET parent_category_id = $1 WHERE id = $2`,
          [childCategoryId, parentCategoryId],
        ),
    );

    await transactionClient.query(
      `INSERT INTO commerce_organization_audit_entry
         (id, organization_id, event_kind, actor_user_id, actor_member_role_snapshot,
          target_entity_type, target_entity_id)
       VALUES ($1, $2, 'organization_created', $3, 'owner', 'organization', $2)`,
      [auditEntryId, primaryOrganizationId, fixtureUserId],
    );

    await expectSqlRejection(
      transactionClient,
      outcomes,
      "organization audit entries reject updates",
      APPEND_ONLY_SQLSTATE,
      () =>
        transactionClient.query(
          `UPDATE commerce_organization_audit_entry
              SET payload_json = '{"tampered":true}'
            WHERE id = $1`,
          [auditEntryId],
        ),
    );

    await expectSqlRejection(
      transactionClient,
      outcomes,
      "organization audit entries reject truncation",
      APPEND_ONLY_SQLSTATE,
      () => transactionClient.query("TRUNCATE commerce_organization_audit_entry"),
    );

    return outcomes;
  } finally {
    await transactionClient.query("ROLLBACK");
    transactionClient.release();
  }
}

async function main(): Promise<void> {
  const outcomes = [...(await verifyCatalogAndBackfill()), ...(await verifyRuntimeConstraints())];

  for (const outcome of outcomes) {
    console.log(`${outcome.passed ? "PASS" : "FAIL"}  ${outcome.label} — ${outcome.detail}`);
  }

  const failureCount = outcomes.filter((outcome) => !outcome.passed).length;
  console.log(
    failureCount === 0
      ? `\nAll ${String(outcomes.length)} commerce foundation guarantees are in force.`
      : `\n${String(failureCount)} of ${String(outcomes.length)} guarantees are missing.`,
  );

  if (failureCount > 0) process.exitCode = 1;
}

main()
  .then(async () => {
    await pool.end();
    return undefined;
  })
  .catch(async (error: unknown) => {
    console.error("Commerce foundation constraint verification failed:", error);
    await pool.end();
    process.exit(1);
  });
