/**
 * Verifies Store Phase 12 seller-profile database invariants after migrations 0069–0072
 * (Appendix A13).
 *
 *   pnpm run db:verify-store-phase-12-constraints
 *
 * TWO KINDS OF CHECK, and the second kind is new in this phase.
 *
 * The presence sweeps below match what Phases 9–11 verify: tables, columns, indexes,
 * constraints and enum values exist, and no stored row violates an invariant. That catches a
 * migration that did not run.
 *
 * It does NOT catch a constraint that exists and does not bite — a CHECK whose expression is
 * wrong still shows up in `pg_constraint`. So this script also ATTEMPTS each violation inside
 * a transaction it always rolls back, and fails if Postgres accepts one. A constraint nobody
 * has ever seen reject anything is a constraint nobody has tested.
 *
 * The attempt phase needs a real organization and user to satisfy foreign keys. When the
 * database has none it reports SKIP rather than PASS: a vacuous check that reads as green is
 * worse than an absent one.
 */
import "dotenv/config";
import type { PoolClient } from "pg";

import { pool } from "#src/db/index.js";

interface CheckOutcome {
  readonly label: string;
  readonly status: "pass" | "fail" | "skip";
  readonly detail: string;
}

const EXPECTED_TABLES: readonly string[] = [
  "commerce_seller_profile",
  "commerce_organization_media",
  "commerce_organization_site_access",
  "commerce_organization_stakeholder",
  "commerce_organization_capability",
  "commerce_organization_certification",
];

const EXPECTED_INDEXES: readonly string[] = [
  "commerce_seller_profile_businessType_idx",
  "commerce_organization_media_position_uidx",
  "commerce_organization_media_kind_idx",
  "commerce_organization_site_access_position_uidx",
  "commerce_organization_stakeholder_position_uidx",
  "commerce_organization_capability_kind_uidx",
  "commerce_organization_certification_public_idx",
  "commerce_organization_certification_identity_uidx",
  // A13 item 1. The partial index the on-time metric drives off.
  "commerce_order_promised_delivery_idx",
];

const EXPECTED_CONSTRAINTS: readonly {
  readonly tableName: string;
  readonly constraintName: string;
}[] = [
  {
    tableName: "commerce_seller_profile",
    constraintName: "commerce_seller_profile_year_founded_ck",
  },
  {
    tableName: "commerce_seller_profile",
    constraintName: "commerce_seller_profile_counts_ck",
  },
  {
    tableName: "commerce_seller_profile",
    constraintName: "commerce_seller_profile_response_ck",
  },
  {
    tableName: "commerce_organization_media",
    constraintName: "commerce_organization_media_dimensions_ck",
  },
  {
    tableName: "commerce_organization_media",
    constraintName: "commerce_organization_media_url_ck",
  },
  {
    tableName: "commerce_organization_site_access",
    constraintName: "commerce_organization_site_access_distance_ck",
  },
  {
    tableName: "commerce_organization_stakeholder",
    constraintName: "commerce_organization_stakeholder_text_ck",
  },
  {
    tableName: "commerce_organization_certification",
    constraintName: "commerce_organization_certification_validity_ck",
  },
  {
    tableName: "commerce_organization_certification",
    constraintName: "commerce_organization_certification_decision_ck",
  },
  {
    tableName: "commerce_organization_certification",
    constraintName: "commerce_organization_certification_reviewer_ck",
  },
  {
    tableName: "commerce_checkout_prepare_product_line",
    constraintName: "commerce_checkout_prepare_product_line_lead_time_ck",
  },
];

const EXPECTED_ENUM_VALUES: readonly {
  readonly typeName: string;
  readonly value: string;
}[] = [
  { typeName: "commerce_seller_business_type", value: "manufacturer_trading" },
  { typeName: "commerce_organization_media_kind", value: "production_line" },
  { typeName: "commerce_site_access_mode", value: "rail" },
  { typeName: "commerce_organization_capability_kind", value: "in_house_rnd" },
  { typeName: "commerce_visit_policy", value: "by_appointment" },
  { typeName: "commerce_certification_state", value: "withdrawn" },
  { typeName: "commerce_document_kind", value: "certification_evidence" },
  {
    typeName: "commerce_organization_audit_event_kind",
    value: "seller_profile_updated",
  },
  {
    typeName: "commerce_organization_audit_event_kind",
    value: "organization_media_changed",
  },
  {
    typeName: "commerce_organization_audit_event_kind",
    value: "site_access_changed",
  },
  {
    typeName: "commerce_organization_audit_event_kind",
    value: "stakeholders_changed",
  },
  {
    typeName: "commerce_organization_audit_event_kind",
    value: "capabilities_changed",
  },
  {
    typeName: "commerce_organization_audit_event_kind",
    value: "certification_submitted",
  },
  {
    typeName: "commerce_organization_audit_event_kind",
    value: "certification_decided",
  },
];

/**
 * `commerce_certification_state` must NOT gain an `expired` value.
 *
 * Lapsing is `valid_until < current_date` at read time. A stored state would need a job to
 * flip it and would be wrong between ticks — publishing a lapsed certificate, which is the
 * failure A13 exists to prevent. If someone adds the value, the read filter silently stops
 * being the authority.
 */
const FORBIDDEN_ENUM_VALUES: readonly {
  readonly typeName: string;
  readonly value: string;
}[] = [{ typeName: "commerce_certification_state", value: "expired" }];

async function countQuery(
  queryText: string,
  values: readonly unknown[] = [],
): Promise<number> {
  const queryResult = await pool.query<{ readonly row_count: string }>(
    queryText,
    [...values],
  );
  return Number(queryResult.rows[0]?.row_count ?? 0);
}

/**
 * Runs one INSERT that MUST be rejected, inside a savepoint that is always released.
 *
 * Returns true when Postgres refused it — which is the passing outcome. A constraint that
 * accepts its own violation returns false and fails the run.
 */
async function violationIsRejected(
  client: PoolClient,
  statement: string,
  values: readonly unknown[],
): Promise<boolean> {
  await client.query("SAVEPOINT violation_attempt");
  try {
    await client.query(statement, [...values]);
    await client.query("ROLLBACK TO SAVEPOINT violation_attempt");
    return false;
  } catch {
    await client.query("ROLLBACK TO SAVEPOINT violation_attempt");
    return true;
  }
}

async function verifyPresence(): Promise<readonly CheckOutcome[]> {
  const outcomes: CheckOutcome[] = [];

  const tableCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [EXPECTED_TABLES],
  );
  outcomes.push({
    label: "all store phase 12 tables exist",
    status: tableCount === EXPECTED_TABLES.length ? "pass" : "fail",
    detail: `${String(tableCount)}/${String(EXPECTED_TABLES.length)}`,
  });

  // A13 item 1. The three columns the promise rides. Absent any one of them, the on-time
  // rate silently returns to being permanently null.
  const promiseColumnCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND ((table_name = 'commerce_order' AND column_name = 'promised_delivery_at')
          OR (table_name = 'commerce_order_product_line' AND column_name = 'promised_delivery_at')
          OR (table_name = 'commerce_checkout_prepare_product_line'
              AND column_name = 'lead_time_max_days_snapshot'))`,
  );
  outcomes.push({
    label: "the promised-delivery chain has all three columns",
    status: promiseColumnCount === 3 ? "pass" : "fail",
    detail: `${String(promiseColumnCount)}/3`,
  });

  const indexCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = ANY($1)`,
    [EXPECTED_INDEXES],
  );
  outcomes.push({
    label: "all store phase 12 indexes exist",
    status: indexCount === EXPECTED_INDEXES.length ? "pass" : "fail",
    detail: `${String(indexCount)}/${String(EXPECTED_INDEXES.length)}`,
  });

  const constraintCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM pg_constraint AS constraint_row
       INNER JOIN pg_class AS table_class ON table_class.oid = constraint_row.conrelid
      WHERE (table_class.relname, constraint_row.conname) IN (
        SELECT unnest($1::text[]), unnest($2::text[])
      )`,
    [
      EXPECTED_CONSTRAINTS.map((entry) => entry.tableName),
      EXPECTED_CONSTRAINTS.map((entry) => entry.constraintName),
    ],
  );
  outcomes.push({
    label: "all store phase 12 constraints exist",
    status: constraintCount === EXPECTED_CONSTRAINTS.length ? "pass" : "fail",
    detail: `${String(constraintCount)}/${String(EXPECTED_CONSTRAINTS.length)}`,
  });

  const enumValueCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM pg_type AS enum_type
       INNER JOIN pg_enum AS enum_value ON enum_value.enumtypid = enum_type.oid
      WHERE (enum_type.typname, enum_value.enumlabel) IN (
        SELECT unnest($1::text[]), unnest($2::text[])
      )`,
    [
      EXPECTED_ENUM_VALUES.map((entry) => entry.typeName),
      EXPECTED_ENUM_VALUES.map((entry) => entry.value),
    ],
  );
  outcomes.push({
    label: "all store phase 12 enum values exist",
    status: enumValueCount === EXPECTED_ENUM_VALUES.length ? "pass" : "fail",
    detail: `${String(enumValueCount)}/${String(EXPECTED_ENUM_VALUES.length)}`,
  });

  const forbiddenEnumCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM pg_type AS enum_type
       INNER JOIN pg_enum AS enum_value ON enum_value.enumtypid = enum_type.oid
      WHERE (enum_type.typname, enum_value.enumlabel) IN (
        SELECT unnest($1::text[]), unnest($2::text[])
      )`,
    [
      FORBIDDEN_ENUM_VALUES.map((entry) => entry.typeName),
      FORBIDDEN_ENUM_VALUES.map((entry) => entry.value),
    ],
  );
  outcomes.push({
    label:
      "certification state has no `expired` value (lapsing is a read-time comparison)",
    status: forbiddenEnumCount === 0 ? "pass" : "fail",
    detail: `${String(forbiddenEnumCount)} forbidden value(s)`,
  });

  /**
   * The identity index must stay PARTIAL. Without `WHERE state <> 'rejected'` a seller whose
   * certificate number was rejected for a typo could never resubmit the corrected one.
   */
  const partialIdentityIndex = await countQuery(
    `SELECT count(*) AS row_count
       FROM pg_indexes
      WHERE indexname = 'commerce_organization_certification_identity_uidx'
        AND indexdef LIKE '%WHERE (state <> %'`,
  );
  outcomes.push({
    label: "certification identity index excludes rejected rows",
    status: partialIdentityIndex === 1 ? "pass" : "fail",
    detail: `${String(partialIdentityIndex)}/1`,
  });

  return outcomes;
}

async function verifyStoredData(): Promise<readonly CheckOutcome[]> {
  const outcomes: CheckOutcome[] = [];

  /**
   * A13 item 6. The rule that makes a certification worth more than a declared capability:
   * nobody approves their own. The CHECK enforces it; this proves no row slipped past.
   */
  const selfApproved = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_organization_certification
      WHERE reviewed_by_user_id IS NOT NULL
        AND reviewed_by_user_id = submitted_by_user_id`,
  );
  outcomes.push({
    label: "no certification was approved by its own submitter",
    status: selfApproved === 0 ? "pass" : "fail",
    detail: `${String(selfApproved)} self-approved certification(s)`,
  });

  const approvedWithoutReviewer = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_organization_certification
      WHERE state = 'approved' AND (reviewed_by_user_id IS NULL OR decided_at IS NULL)`,
  );
  outcomes.push({
    label: "every approved certification names a reviewer and a decision time",
    status: approvedWithoutReviewer === 0 ? "pass" : "fail",
    detail: `${String(approvedWithoutReviewer)} unattributed approval(s)`,
  });

  /**
   * The public projection filters on `state = 'approved' AND valid_until >= current_date`.
   * This reports how many approved certificates have lapsed — not a failure, but the number
   * that would be wrongly published if the read filter were ever dropped.
   */
  const lapsedApproved = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_organization_certification
      WHERE state = 'approved' AND valid_until < current_date`,
  );
  outcomes.push({
    label:
      "lapsed-but-approved certifications are known (read filter must exclude them)",
    status: "pass",
    detail: `${String(lapsedApproved)} lapsed approval(s) held back by the read filter`,
  });

  const certificationEvidenceMismatch = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_organization_certification AS certification
       INNER JOIN commerce_encrypted_document AS evidence
         ON evidence.id = certification.evidence_document_id
      WHERE evidence.document_kind <> 'certification_evidence'
         OR evidence.organization_id <> certification.organization_id`,
  );
  outcomes.push({
    label:
      "every certification's evidence is its own organization's certification document",
    status: certificationEvidenceMismatch === 0 ? "pass" : "fail",
    detail: `${String(certificationEvidenceMismatch)} mismatched evidence row(s)`,
  });

  /**
   * A13 item 1. An order line promised for a date its own order does not cover would make
   * the aggregate promise a lie — `commerce_order.promised_delivery_at` is the LATEST line
   * promise, so no line may exceed it.
   */
  const linePromiseExceedsOrder = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_order_product_line AS order_line
       INNER JOIN commerce_order AS parent_order ON parent_order.id = order_line.order_id
      WHERE order_line.promised_delivery_at IS NOT NULL
        AND (parent_order.promised_delivery_at IS NULL
             OR order_line.promised_delivery_at > parent_order.promised_delivery_at)`,
  );
  outcomes.push({
    label: "no order line is promised later than its order",
    status: linePromiseExceedsOrder === 0 ? "pass" : "fail",
    detail: `${String(linePromiseExceedsOrder)} inconsistent line promise(s)`,
  });

  const orphanedMediaPublicId = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_organization_media
      WHERE cloudinary_public_id = '' OR image_url NOT LIKE 'https://%'`,
  );
  outcomes.push({
    label: "every company photo has an https url and a destroyable public id",
    status: orphanedMediaPublicId === 0 ? "pass" : "fail",
    detail: `${String(orphanedMediaPublicId)} unusable media row(s)`,
  });

  /**
   * A13 item 4. The stakeholder table must never grow a way to contact the person named —
   * that absence is the whole reason the rows are publishable.
   */
  const stakeholderContactColumns = await countQuery(
    `SELECT count(*) AS row_count
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'commerce_organization_stakeholder'
        AND (column_name LIKE '%email%' OR column_name LIKE '%phone%'
             OR column_name LIKE '%contact%')`,
  );
  outcomes.push({
    label:
      "stakeholders carry no contact column (the absence is the safety argument)",
    status: stakeholderContactColumns === 0 ? "pass" : "fail",
    detail: `${String(stakeholderContactColumns)} contact column(s)`,
  });

  return outcomes;
}

/**
 * Attempts every new violation and requires Postgres to refuse it.
 *
 * Everything runs in ONE transaction that is rolled back unconditionally, so the database is
 * unchanged whether the checks pass or fail.
 */
async function verifyViolationsAreRejected(): Promise<readonly CheckOutcome[]> {
  const outcomes: CheckOutcome[] = [];
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const anchorResult = await client.query<{
      readonly organization_id: string;
      readonly user_id: string;
    }>(
      `SELECT organization.id AS organization_id, organization.created_by_user_id AS user_id
         FROM commerce_organization AS organization
        ORDER BY organization.created_at
        LIMIT 1`,
    );
    const anchor = anchorResult.rows[0];
    if (!anchor) {
      outcomes.push({
        label: "constraint violation attempts",
        status: "skip",
        detail: "no commerce_organization row to hang foreign keys on",
      });
      return outcomes;
    }
    const organizationId = anchor.organization_id;

    const yearFoundedRejected = await violationIsRejected(
      client,
      `INSERT INTO commerce_seller_profile (organization_id, year_founded) VALUES ($1, 1700)`,
      [organizationId],
    );
    outcomes.push({
      label: "a founding year of 1700 is rejected",
      status: yearFoundedRejected ? "pass" : "fail",
      detail: yearFoundedRejected
        ? "refused"
        : "ACCEPTED — the CHECK does not bite",
    });

    const negativeCountRejected = await violationIsRejected(
      client,
      `INSERT INTO commerce_seller_profile (organization_id, factory_count) VALUES ($1, -1)`,
      [organizationId],
    );
    outcomes.push({
      label: "a negative factory count is rejected",
      status: negativeCountRejected ? "pass" : "fail",
      detail: negativeCountRejected
        ? "refused"
        : "ACCEPTED — the CHECK does not bite",
    });

    const zeroDimensionRejected = await violationIsRejected(
      client,
      `INSERT INTO commerce_organization_media
         (id, organization_id, media_kind, image_url, cloudinary_public_id, width_px, height_px, position)
       VALUES (gen_random_uuid()::text, $1, 'factory', 'https://example.test/a.avif', 'k', 0, 100, 0)`,
      [organizationId],
    );
    outcomes.push({
      label: "a company photo with zero width is rejected",
      status: zeroDimensionRejected ? "pass" : "fail",
      detail: zeroDimensionRejected
        ? "refused"
        : "ACCEPTED — the CHECK does not bite",
    });

    const httpMediaRejected = await violationIsRejected(
      client,
      `INSERT INTO commerce_organization_media
         (id, organization_id, media_kind, image_url, cloudinary_public_id, width_px, height_px, position)
       VALUES (gen_random_uuid()::text, $1, 'factory', 'http://example.test/a.avif', 'k', 10, 10, 0)`,
      [organizationId],
    );
    outcomes.push({
      label: "a plain-http company photo url is rejected",
      status: httpMediaRejected ? "pass" : "fail",
      detail: httpMediaRejected
        ? "refused"
        : "ACCEPTED — the CHECK does not bite",
    });

    /**
     * The uniqueness attempts need a KNOWN starting state, so they clear this
     * organization's rows first. Safe because the enclosing transaction is always rolled
     * back — and necessary, because otherwise the setup insert collides with whatever the
     * smoke script or a real seller already wrote and the script dies before asserting
     * anything. It did exactly that once.
     */
    await client.query(
      `DELETE FROM commerce_organization_stakeholder WHERE organization_id = $1`,
      [organizationId],
    );
    await client.query(
      `DELETE FROM commerce_organization_capability WHERE organization_id = $1`,
      [organizationId],
    );

    // The position uniqueness that lets the PUT-replace writes skip A2's re-packing dance.
    await client.query(
      `INSERT INTO commerce_organization_stakeholder
         (id, organization_id, full_name, role_title, position)
       VALUES (gen_random_uuid()::text, $1, 'First Officer', 'Director', 900)`,
      [organizationId],
    );
    const duplicatePositionRejected = await violationIsRejected(
      client,
      `INSERT INTO commerce_organization_stakeholder
         (id, organization_id, full_name, role_title, position)
       VALUES (gen_random_uuid()::text, $1, 'Second Officer', 'Director', 900)`,
      [organizationId],
    );
    outcomes.push({
      label: "two stakeholders cannot share a position",
      status: duplicatePositionRejected ? "pass" : "fail",
      detail: duplicatePositionRejected
        ? "refused"
        : "ACCEPTED — the index does not bite",
    });

    await client.query(
      `INSERT INTO commerce_organization_capability
         (id, organization_id, capability_kind, position)
       VALUES (gen_random_uuid()::text, $1, 'oem', 900)`,
      [organizationId],
    );
    const duplicateCapabilityRejected = await violationIsRejected(
      client,
      `INSERT INTO commerce_organization_capability
         (id, organization_id, capability_kind, position)
       VALUES (gen_random_uuid()::text, $1, 'oem', 901)`,
      [organizationId],
    );
    outcomes.push({
      label: "a capability cannot be declared twice",
      status: duplicateCapabilityRejected ? "pass" : "fail",
      detail: duplicateCapabilityRejected
        ? "refused"
        : "ACCEPTED — the index does not bite",
    });

    /**
     * The certification attempts need an evidence document. Reuse any existing one rather
     * than synthesising the twenty-column encrypted-document row; SKIP when there is none,
     * because a check that silently does not run must not read as green.
     */
    const documentResult = await client.query<{ readonly id: string }>(
      `SELECT id FROM commerce_encrypted_document ORDER BY created_at LIMIT 1`,
    );
    const evidenceDocumentId = documentResult.rows[0]?.id;
    if (evidenceDocumentId === undefined) {
      outcomes.push({
        label: "certification constraint violation attempts",
        status: "skip",
        detail: "no commerce_encrypted_document row to reference as evidence",
      });
      return outcomes;
    }

    const invalidValidityRejected = await violationIsRejected(
      client,
      `INSERT INTO commerce_organization_certification
         (id, organization_id, standard_name, issuer_name, certificate_number,
          valid_from, valid_until, evidence_document_id, submitted_by_user_id)
       VALUES (gen_random_uuid()::text, $1, 'ISO 9001:2015', 'Verifier', 'VERIFY-1',
               '2027-01-01', '2026-01-01', $2, $3)`,
      [organizationId, evidenceDocumentId, anchor.user_id],
    );
    outcomes.push({
      label: "a certificate valid until before it is valid from is rejected",
      status: invalidValidityRejected ? "pass" : "fail",
      detail: invalidValidityRejected
        ? "refused"
        : "ACCEPTED — the CHECK does not bite",
    });

    const selfApprovalRejected = await violationIsRejected(
      client,
      `INSERT INTO commerce_organization_certification
         (id, organization_id, standard_name, issuer_name, certificate_number,
          valid_from, valid_until, evidence_document_id, submitted_by_user_id,
          state, reviewed_by_user_id, decided_at)
       VALUES (gen_random_uuid()::text, $1, 'ISO 9001:2015', 'Verifier', 'VERIFY-2',
               '2026-01-01', '2027-01-01', $2, $3, 'approved', $3, now())`,
      [organizationId, evidenceDocumentId, anchor.user_id],
    );
    outcomes.push({
      label: "a certification approved by its own submitter is rejected",
      status: selfApprovalRejected ? "pass" : "fail",
      detail: selfApprovalRejected
        ? "refused"
        : "ACCEPTED — the CHECK does not bite",
    });

    const approvalWithoutReviewerRejected = await violationIsRejected(
      client,
      `INSERT INTO commerce_organization_certification
         (id, organization_id, standard_name, issuer_name, certificate_number,
          valid_from, valid_until, evidence_document_id, submitted_by_user_id, state)
       VALUES (gen_random_uuid()::text, $1, 'ISO 9001:2015', 'Verifier', 'VERIFY-3',
               '2026-01-01', '2027-01-01', $2, $3, 'approved')`,
      [organizationId, evidenceDocumentId, anchor.user_id],
    );
    outcomes.push({
      label: "an approved certification with no reviewer is rejected",
      status: approvalWithoutReviewerRejected ? "pass" : "fail",
      detail: approvalWithoutReviewerRejected
        ? "refused"
        : "ACCEPTED — the CHECK does not bite",
    });

    return outcomes;
  } finally {
    // Unconditional. Nothing this function attempted is meant to survive.
    await client.query("ROLLBACK");
    client.release();
  }
}

async function main(): Promise<void> {
  const outcomes = [
    ...(await verifyPresence()),
    ...(await verifyStoredData()),
    ...(await verifyViolationsAreRejected()),
  ];

  let hasFailure = false;
  let hasSkip = false;
  for (const outcome of outcomes) {
    const outcomeMark =
      outcome.status === "pass"
        ? "PASS"
        : outcome.status === "skip"
          ? "SKIP"
          : "FAIL";
    console.log(`[${outcomeMark}] ${outcome.label} — ${outcome.detail}`);
    if (outcome.status === "fail") hasFailure = true;
    if (outcome.status === "skip") hasSkip = true;
  }
  if (hasSkip) {
    console.log(
      "\nSKIP means the check did not run, not that it passed. Seed the store demo data " +
        "(pnpm db:seed-store-demo) and re-run to exercise it.",
    );
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
