/**
 * Proves the blueprints hero carousel's constraints against a REAL database.
 *
 *   pnpm db:verify-blueprint-hero-constraints
 *
 * ⚠️ THE TABLE IS STILL CALLED `anime_hero_slide`. The vertical was retired and the router is now
 * `/blueprints`, but renaming the table costs a migration and buys a tidier grep. Read every
 * `anime_` name here as historical — `BLUEPRINTS_BACKEND_STRUCTURE.md` §0 says so at length.
 *
 * WHY A SCRIPT AND NOT A TEST — the same reason `verify-promotional-slide-constraints.ts` gives:
 * the vitest suite mocks `#src/db/index.js` wholesale, so it can prove things about TypeScript and
 * nothing about Postgres. `BLUEPRINTS_BACKEND_STRUCTURE.md` §7 carried a standing warning that this
 * table had no script at all, and the first thing writing one turned up was a CHECK that refused
 * `//evil.tld` and accepted `/\evil.tld` — the same value, in the spelling nobody tested.
 *
 * THIS FILE IS MODELLED ON THE PROMOTIONAL-SLIDE SCRIPT, NOT THE CASE-STUDY ONE, because that is
 * the sibling table: same shape, same carousel role, same open-redirect surface. It keeps that
 * file's structural tier — `EXPECTED_CONSTRAINTS` and `EXPECTED_INDEXES` checked against
 * `pg_constraint` and `pg_indexes` before any row is written — which the case-study script has no
 * equivalent of. A behavioural assertion proves a constraint WORKS; the structural tier proves it
 * is still THERE, and a dropped constraint is the failure a probe alone reads as a pass.
 *
 * THREE ASSERTIONS EARN THIS FILE ON THEIR OWN:
 *
 *   TWO SLIDES MAY SHARE A POSITION, and that is deliberate. `feed_spotlight_slot_position_uidx`
 *       makes the opposite choice on a neighbouring table, so the absence here looks like an
 *       oversight until somebody "fixes" it — at which point `reorderBlueprintHeroSlides` starts
 *       failing mid-loop inside its own transaction, because it rewrites positions one row at a
 *       time and transiently collides. Only a probe can record a deliberate ABSENCE.
 *
 *   A SITE-RELATIVE `image_url` IS LEGAL, also deliberately. Migration 0149 seeded four such rows
 *       because a migration cannot upload to Cloudinary, and the alternative — a hardcoded
 *       fallback slide in the component — is a mock on a wired surface. An https-only rule here
 *       would refuse the seed. `showcase_launch_heading_image_url_ck` IS https-only because that
 *       arm has no seeded population; do not harmonise the two.
 *
 *   BOTH SPELLINGS OF A PROTOCOL-RELATIVE URL ARE REFUSED. `//evil.tld` and `/\evil.tld` are read
 *       identically by a browser, and the original CHECK caught only the first.
 *
 * Read-only in effect: every write happens inside a transaction that is always rolled back.
 *
 * Exits non-zero on any failed assertion.
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
const FOREIGN_KEY_VIOLATION_SQLSTATE = "23503";

const EXPECTED_CONSTRAINTS = [
  "anime_hero_slide_position_ck",
  "anime_hero_slide_title_ck",
  "anime_hero_slide_image_url_ck",
  "anime_hero_slide_destination_ck",
  "anime_hero_slide_window_ck",
];

const EXPECTED_INDEXES = ["anime_hero_slide_live_idx", "anime_hero_slide_position_idx"];

/** A row that satisfies every constraint; each probe below varies exactly one field. */
const VALID_ROW = {
  imageUrl: "https://res.cloudinary.com/demo/image/upload/v1/hero-probe.avif",
  title: "Constraint probe",
  destinationPath: "/blueprints/teardowns",
  position: 0,
  isActive: true,
  startsAt: null as string | null,
  endsAt: null as string | null,
  createdByUserId: null as string | null,
} as const;

async function countQuery(text: string, values: readonly unknown[] = []): Promise<number> {
  const result = await pool.query<{ n: string }>(text, [...values]);
  return Number(result.rows[0]?.n ?? 0);
}

async function checkSchemaObjects(): Promise<readonly CheckOutcome[]> {
  const outcomes: CheckOutcome[] = [];

  const tableCount = await countQuery(
    `SELECT count(*) AS n FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'anime_hero_slide'`,
  );
  outcomes.push({
    label: "the anime_hero_slide table exists (historical name, /blueprints surface)",
    passed: tableCount === 1,
    detail: `${String(tableCount)}/1`,
  });

  const constraintCount = await countQuery(
    `SELECT count(*) AS n FROM pg_constraint
      WHERE conrelid = 'anime_hero_slide'::regclass AND conname = ANY($1)`,
    [EXPECTED_CONSTRAINTS],
  );
  outcomes.push({
    label: "every CHECK constraint is installed",
    passed: constraintCount === EXPECTED_CONSTRAINTS.length,
    detail: `${String(constraintCount)}/${String(EXPECTED_CONSTRAINTS.length)}`,
  });

  const indexCount = await countQuery(
    `SELECT count(*) AS n FROM pg_indexes
      WHERE tablename = 'anime_hero_slide' AND indexname = ANY($1)`,
    [EXPECTED_INDEXES],
  );
  outcomes.push({
    label: "both ordering indexes exist",
    passed: indexCount === EXPECTED_INDEXES.length,
    detail: `${String(indexCount)}/${String(EXPECTED_INDEXES.length)}`,
  });

  /**
   * ⚠️ WITHOUT THIS, "the public read has a partial index" IS A CLAIM ABOUT A DIFFERENT OBJECT.
   * An index of the same name over the same columns but with no `WHERE` still satisfies the count
   * above, while the read it was built for scans every retired slide.
   */
  const partialIndexCount = await countQuery(
    `SELECT count(*) AS n FROM pg_indexes
      WHERE tablename = 'anime_hero_slide'
        AND indexname = 'anime_hero_slide_live_idx'
        AND indexdef ILIKE '%WHERE is_active%'`,
  );
  outcomes.push({
    label: "the live index is PARTIAL on is_active, not merely present",
    passed: partialIndexCount === 1,
    detail:
      partialIndexCount === 1
        ? "indexdef carries the WHERE clause"
        : "the index exists but is not partial — the public read scans retired slides",
  });

  /**
   * ⚠️ THE ABSENCE IS THE ASSERTION. A unique index on `position` would fire mid-loop inside
   * `reorderBlueprintHeroSlides`'s transaction, which rewrites positions one row at a time.
   */
  const positionUniqueCount = await countQuery(
    `SELECT count(*) AS n FROM pg_indexes
      WHERE tablename = 'anime_hero_slide' AND indexdef ILIKE 'CREATE UNIQUE%position%'`,
  );
  outcomes.push({
    label: "there is NO unique index on position — reorder rewrites positions one row at a time",
    passed: positionUniqueCount === 0,
    detail:
      positionUniqueCount === 0
        ? "no unique index, as the reorder transaction requires"
        : "a unique index exists — reorder will fail mid-loop",
  });

  const restrictingForeignKeys = await countQuery(
    `SELECT count(*) AS n FROM pg_constraint
      WHERE conrelid = 'anime_hero_slide'::regclass AND contype = 'f' AND confdeltype <> 'n'`,
  );
  outcomes.push({
    label: "both staff foreign keys are ON DELETE SET NULL, never RESTRICT",
    passed: restrictingForeignKeys === 0,
    detail:
      restrictingForeignKeys === 0
        ? "one hero slide cannot block a staff account deletion forever"
        : `${String(restrictingForeignKeys)} key(s) would block a deletion`,
  });

  return outcomes;
}

const INSERT_SLIDE = `
  INSERT INTO anime_hero_slide
    (id, image_url, title, destination_path, position, is_active, starts_at, ends_at, created_by_user_id)
  VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8)`;

function slideValues(overrides: Partial<Record<keyof typeof VALID_ROW, unknown>>): unknown[] {
  const row = { ...VALID_ROW, ...overrides };
  return [
    row.imageUrl,
    row.title,
    row.destinationPath,
    row.position,
    row.isActive,
    row.startsAt,
    row.endsAt,
    row.createdByUserId,
  ];
}

function readSqlState(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) return "unknown";
  const candidate: { readonly code?: unknown } = error;
  return typeof candidate.code === "string" ? candidate.code : "unknown";
}

async function expectRejected(
  client: PoolClient,
  label: string,
  overrides: Partial<Record<keyof typeof VALID_ROW, unknown>>,
  expectedSqlState: string = CHECK_VIOLATION_SQLSTATE,
): Promise<CheckOutcome> {
  await client.query("SAVEPOINT probe");
  try {
    await client.query(INSERT_SLIDE, slideValues(overrides));
    await client.query("ROLLBACK TO SAVEPOINT probe");
    return { label, passed: false, detail: "ACCEPTED — the constraint did not fire" };
  } catch (insertError: unknown) {
    await client.query("ROLLBACK TO SAVEPOINT probe");
    const sqlState = readSqlState(insertError);
    return {
      label,
      passed: sqlState === expectedSqlState,
      detail:
        sqlState === expectedSqlState
          ? `rejected with ${sqlState}`
          : `rejected, but with SQLSTATE ${sqlState} rather than ${expectedSqlState}`,
    };
  }
}

async function expectAccepted(
  client: PoolClient,
  label: string,
  overrides: Partial<Record<keyof typeof VALID_ROW, unknown>>,
): Promise<CheckOutcome> {
  await client.query("SAVEPOINT probe");
  try {
    await client.query(INSERT_SLIDE, slideValues(overrides));
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

    // ⚠️ A DELIBERATE ABSENCE, PROVEN BY A WRITE. Two rows at one position must both store, or
    // `reorderBlueprintHeroSlides` cannot rewrite an ordering inside one transaction.
    await client.query("SAVEPOINT shared_position");
    await client.query(INSERT_SLIDE, slideValues({ position: 900 }));
    const sharedPosition = await expectAccepted(
      client,
      "two slides may share a position — reorder rewrites them one row at a time",
      { position: 900, title: "Second slide at the same position" },
    );
    await client.query("ROLLBACK TO SAVEPOINT shared_position");

    const outcomes = [
      sharedPosition,

      // --- position and title ---
      await expectRejected(client, "refuses a negative position", { position: -1 }),
      await expectAccepted(client, "accepts position 0", { position: 0 }),
      await expectRejected(client, "refuses an empty title", { title: "" }),
      await expectRejected(client, "refuses a 161-character title", { title: "T".repeat(161) }),

      // --- the image URL, and both spellings of the redirect ---
      await expectAccepted(client, "accepts an https Cloudinary image URL", {}),
      // ⚠️ THE SEED ARM. Migration 0149 wrote four rows in exactly this shape.
      await expectAccepted(client, "accepts a SITE-RELATIVE image path — the seed arm", {
        imageUrl: "/dummy/blueprint-hero-1.avif",
      }),
      await expectRejected(client, "refuses a protocol-relative //host image URL", {
        imageUrl: "//evil.test/x.avif",
      }),
      // ⚠️ THE SPELLING THAT USED TO BE ACCEPTED. A single leading slash, and a browser still
      // resolves it as "same scheme, different host".
      await expectRejected(client, "refuses a BACKSLASH protocol-relative image URL", {
        imageUrl: "/\\evil.test/x.avif",
      }),
      await expectRejected(client, "refuses a plain-http image URL", {
        imageUrl: "http://res.cloudinary.com/demo/x.avif",
      }),
      await expectRejected(client, "refuses whitespace inside an image URL", {
        imageUrl: "https://res.cloudinary.com/demo/a b.avif",
      }),

      // --- the destination path: same rule, minus the https arm ---
      await expectAccepted(client, "accepts a NULL destination — a decorative slide", {
        destinationPath: null,
      }),
      await expectRejected(client, "refuses a protocol-relative //host destination", {
        destinationPath: "//evil.test",
      }),
      await expectRejected(client, "refuses a BACKSLASH protocol-relative destination", {
        destinationPath: "/\\evil.test",
      }),
      // ⚠️ THE ONE PLACE THIS DIFFERS FROM `promotional_slide`, WHICH HAS AN EXTERNAL ARM. The hero
      // carousel never links off-site, so there is no https destination to allow.
      await expectRejected(
        client,
        "refuses an https destination — this surface never links off-site",
        {
          destinationPath: "https://evil.test",
        },
      ),
      await expectRejected(client, "refuses a destination that does not start with a slash", {
        destinationPath: "blueprints",
      }),
      await expectRejected(client, "refuses a 513-character destination", {
        destinationPath: `/${"a".repeat(513)}`,
      }),

      // --- the scheduling window ---
      await expectRejected(client, "refuses a window that ends before it starts", {
        startsAt: "2026-01-02T00:00:00Z",
        endsAt: "2026-01-01T00:00:00Z",
      }),
      await expectRejected(client, "refuses a zero-length window", {
        startsAt: "2026-01-01T00:00:00Z",
        endsAt: "2026-01-01T00:00:00Z",
      }),
      await expectAccepted(client, "accepts a one-sided window — unbounded in that direction", {
        startsAt: "2026-01-01T00:00:00Z",
      }),

      // --- the staff reference ---
      await expectRejected(
        client,
        "refuses a created_by_user_id naming nobody",
        { createdByUserId: "00000000-0000-4000-8000-000000000000" },
        FOREIGN_KEY_VIOLATION_SQLSTATE,
      ),
    ];

    return outcomes;
  } finally {
    // THE ROLLBACK IS THE CLEANUP, and it cannot be skipped by a failed assertion or a throw.
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
      ? `\nAll ${String(outcomes.length)} blueprint-hero guarantees are in force.`
      : `\n${String(failureCount)} of ${String(outcomes.length)} guarantees are MISSING.`,
  );

  await pool.end();
  process.exit(failureCount === 0 ? 0 : 1);
}

void main();
