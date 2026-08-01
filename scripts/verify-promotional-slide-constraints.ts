/**
 * Verifies that migration 0033's DATABASE-LEVEL guarantees are in force for
 * `promotional_slide`.
 *
 * WHY A SCRIPT AND NOT A TEST — the same reason `verify-platform-audit-constraints.ts`
 * gives: the vitest suite mocks `#src/db/index.js` wholesale, so it can prove things about
 * TypeScript and nothing about Postgres. And the central claim here is one TypeScript
 * cannot make at all — that an OPEN REDIRECT is unrepresentable as a row, even if a future
 * code path skips `parsePromotionalDestination` entirely.
 *
 * `//evil.tld/x` starts with "/" and is a protocol-relative URL. Any check written as
 * `startsWith("/")` accepts it, and the frontend then renders it as an `href` that sends
 * every visitor to the front page off-site. That row must be rejected by Postgres itself,
 * and a constraint nobody has watched fire is indistinguishable from an absent one — so
 * every guarantee below is EXERCISED against real rows.
 *
 * Read-only in effect: every write happens inside a transaction that is always rolled back.
 *
 *   pnpm db:verify-promotional-slide-constraints
 *
 * Exits non-zero if any guarantee is missing, so it can gate a deploy.
 */
import "dotenv/config";
import type { PoolClient } from "pg";

import { pool } from "#src/db/index.js";

interface CheckOutcome {
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

const CHECK_VIOLATION_SQLSTATE = "23514";

const EXPECTED_CONSTRAINTS = [
  "promotional_slide_position_ck",
  "promotional_slide_alt_text_ck",
  "promotional_slide_image_url_ck",
  "promotional_slide_image_dimensions_ck",
  "promotional_slide_window_ck",
  "promotional_slide_destination_ck",
];

const EXPECTED_INDEXES = ["promotional_slide_live_idx", "promotional_slide_position_idx"];

/** A row that satisfies every constraint; each probe below varies exactly one field. */
const VALID_ROW = {
  imageUrl: "https://res.cloudinary.com/demo/image/upload/v1/probe.avif",
  imageWidthPx: 2400,
  imageHeightPx: 1000,
  altText: "Constraint probe",
  destinationKind: "internal_path",
  destinationValue: "/store",
  position: 0,
} as const;

async function countQuery(text: string, values: readonly unknown[] = []): Promise<number> {
  const result = await pool.query<{ n: string }>(text, [...values]);
  return Number(result.rows[0]?.n ?? 0);
}

async function checkSchemaObjects(): Promise<readonly CheckOutcome[]> {
  const outcomes: CheckOutcome[] = [];

  const tableCount = await countQuery(
    `SELECT count(*) AS n FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'promotional_slide'`,
  );
  outcomes.push({
    label: "the promotional_slide table exists",
    passed: tableCount === 1,
    detail: `${String(tableCount)}/1`,
  });

  const constraintCount = await countQuery(
    `SELECT count(*) AS n FROM pg_constraint
      WHERE conrelid = 'promotional_slide'::regclass AND conname = ANY($1)`,
    [EXPECTED_CONSTRAINTS],
  );
  outcomes.push({
    label: "every CHECK constraint is installed",
    passed: constraintCount === EXPECTED_CONSTRAINTS.length,
    detail: `${String(constraintCount)}/${String(EXPECTED_CONSTRAINTS.length)}`,
  });

  const indexCount = await countQuery(
    `SELECT count(*) AS n FROM pg_indexes
      WHERE tablename = 'promotional_slide' AND indexname = ANY($1)`,
    [EXPECTED_INDEXES],
  );
  outcomes.push({
    label: "both ordering indexes exist",
    passed: indexCount === EXPECTED_INDEXES.length,
    detail: `${String(indexCount)}/${String(EXPECTED_INDEXES.length)} — the live one is partial on is_active`,
  });

  const enumLabelCount = await countQuery(
    `SELECT count(*) AS n FROM pg_enum
      WHERE enumtypid = 'promotional_destination_kind'::regtype
        AND enumlabel = ANY($1)`,
    [["internal_path", "external_url"]],
  );
  outcomes.push({
    label: "the destination-kind enum carries both snake_case labels",
    passed: enumLabelCount === 2,
    detail: `${String(enumLabelCount)}/2 — kebab spellings would be a different, absent label`,
  });

  return outcomes;
}

/**
 * Attempts one INSERT inside the caller's transaction and reports whether Postgres refused
 * it with a CHECK violation. The caller always rolls back, so nothing survives.
 */
async function expectRejected(
  client: PoolClient,
  label: string,
  overrides: Partial<Record<keyof typeof VALID_ROW, unknown>>,
): Promise<CheckOutcome> {
  const row = { ...VALID_ROW, ...overrides };
  await client.query("SAVEPOINT probe");
  try {
    await client.query(
      `INSERT INTO promotional_slide
         (id, image_url, image_width_px, image_height_px, alt_text,
          destination_kind, destination_value, position)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7)`,
      [
        row.imageUrl,
        row.imageWidthPx,
        row.imageHeightPx,
        row.altText,
        row.destinationKind,
        row.destinationValue,
        row.position,
      ],
    );
    await client.query("ROLLBACK TO SAVEPOINT probe");
    return { label, passed: false, detail: "ACCEPTED — the constraint did not fire" };
  } catch (insertError: unknown) {
    await client.query("ROLLBACK TO SAVEPOINT probe");
    const sqlState =
      typeof insertError === "object" && insertError !== null && "code" in insertError
        ? String((insertError as { code?: unknown }).code)
        : "unknown";
    return {
      label,
      passed: sqlState === CHECK_VIOLATION_SQLSTATE,
      detail:
        sqlState === CHECK_VIOLATION_SQLSTATE
          ? "rejected by a CHECK constraint"
          : `rejected, but with SQLSTATE ${sqlState} rather than a CHECK violation`,
    };
  }
}

async function expectAccepted(
  client: PoolClient,
  label: string,
  overrides: Partial<Record<keyof typeof VALID_ROW, unknown>>,
): Promise<CheckOutcome> {
  const row = { ...VALID_ROW, ...overrides };
  await client.query("SAVEPOINT probe");
  try {
    await client.query(
      `INSERT INTO promotional_slide
         (id, image_url, image_width_px, image_height_px, alt_text,
          destination_kind, destination_value, position)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7)`,
      [
        row.imageUrl,
        row.imageWidthPx,
        row.imageHeightPx,
        row.altText,
        row.destinationKind,
        row.destinationValue,
        row.position,
      ],
    );
    await client.query("ROLLBACK TO SAVEPOINT probe");
    return { label, passed: true, detail: "accepted, as it should be" };
  } catch (insertError: unknown) {
    await client.query("ROLLBACK TO SAVEPOINT probe");
    const message = insertError instanceof Error ? insertError.message : String(insertError);
    return { label, passed: false, detail: `REJECTED a legitimate row — ${message}` };
  }
}

async function checkRowLevelGuarantees(): Promise<readonly CheckOutcome[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const outcomes = [
      // THE OPEN-REDIRECT SUITE. Every one of these starts with "/" and would pass a
      // naive startsWith("/") check.
      await expectRejected(client, "refuses a protocol-relative //host path", {
        destinationValue: "//evil.tld/x",
      }),
      await expectRejected(client, "refuses an absolute URL claimed as an internal path", {
        destinationValue: "https://evil.tld/x",
      }),
      await expectRejected(client, "refuses a javascript: payload as an internal path", {
        destinationValue: "javascript:alert(1)",
      }),
      await expectRejected(client, "refuses whitespace inside a destination", {
        destinationValue: "/store /x",
      }),
      await expectRejected(client, "refuses a path that does not start with a slash", {
        destinationValue: "store",
      }),
      // The external arm.
      await expectRejected(client, "refuses a non-https external destination", {
        destinationKind: "external_url",
        destinationValue: "http://advertiser.example/campaign",
      }),
      await expectRejected(client, "refuses a relative path claimed as an external URL", {
        destinationKind: "external_url",
        destinationValue: "/store",
      }),
      // The remaining constraints.
      await expectRejected(client, "refuses a negative position", { position: -1 }),
      await expectRejected(client, "refuses empty alt text", { altText: "" }),
      await expectRejected(client, "refuses a non-https image URL", {
        imageUrl: "http://res.cloudinary.com/demo/x.avif",
      }),
      await expectRejected(client, "refuses a zero image dimension", { imageWidthPx: 0 }),
      // And the legitimate rows, so the constraints are proven not to be blanket refusals.
      await expectAccepted(client, "accepts a plain internal path", {}),
      await expectAccepted(client, "accepts an internal path with a query and a hash", {
        destinationValue: "/store/product/abc?variant=2#specs",
      }),
      await expectAccepted(client, "accepts an https external URL", {
        destinationKind: "external_url",
        destinationValue: "https://advertiser.example/campaign?utm_source=qatoto",
      }),
    ];

    return outcomes;
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function main(): Promise<void> {
  const outcomes = [...(await checkSchemaObjects()), ...(await checkRowLevelGuarantees())];

  for (const outcome of outcomes) {
    console.log(`${outcome.passed ? "PASS" : "FAIL"}  ${outcome.label} — ${outcome.detail}`);
  }

  const failureCount = outcomes.filter((outcome) => !outcome.passed).length;
  console.log(
    failureCount === 0
      ? `\nAll ${String(outcomes.length)} promotional-slide guarantees are in force.`
      : `\n${String(failureCount)} of ${String(outcomes.length)} guarantees are MISSING.`,
  );

  await pool.end();
  process.exit(failureCount === 0 ? 0 : 1);
}

void main();
