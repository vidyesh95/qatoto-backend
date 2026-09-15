import "dotenv/config";
import { randomUUID } from "node:crypto";

import { pool } from "#src/db/index.js";
import {
  PG_CHECK_VIOLATION,
  PG_FOREIGN_KEY_VIOLATION,
  readSqlStateCode,
} from "#src/lib/pg-errors.js";
import { BLUEPRINT_DRAFT_DOCUMENT_MAXIMUM_CHARACTERS } from "#src/modules/home/blueprints/blueprint-draft.schemas.js";

/**
 * Proves the draft store's constraints against a REAL database.
 *
 *   pnpm db:verify-blueprint-draft-constraints
 *
 * WHY THIS EXISTS SEPARATELY FROM THE VITEST SUITE, in the words the other four use: that suite
 * mocks `#src/db/index.js` wholesale, so no test in this repository can prove anything about
 * Postgres. Every claim below is a claim about the DATABASE, and the only way to prove one is to
 * attempt the write and watch it be refused.
 *
 * ⚠️ THE ONE THAT MATTERS MOST IS THE OWNER CASCADE. A draft holds free text this server never
 * parses — a case-study draft can carry a company name its author meant to withhold — so
 * `text-pii-register.ts` cannot reach inside it, and `delete_rows` on the owner is the only
 * disposition that provably does. If that cascade were ever `set null`, an erasure would leave the
 * document behind with nobody to attribute it to, and nothing else would notice.
 */

let failureCount = 0;

function check(label: string, passed: boolean, detail: string): void {
  if (!passed) failureCount += 1;
  console.log(`  ${passed ? "ok  " : "FAIL"} ${label} — ${detail}`);
}

async function main(): Promise<void> {
  const client = await pool.connect();

  async function expectRefused(
    label: string,
    expectedSqlState: string,
    statement: string,
    parameters: readonly unknown[] = [],
  ): Promise<void> {
    await client.query("SAVEPOINT probe");
    try {
      await client.query(statement, [...parameters]);
      await client.query("ROLLBACK TO SAVEPOINT probe");
      check(label, false, "the write SUCCEEDED — the constraint is missing");
    } catch (error: unknown) {
      await client.query("ROLLBACK TO SAVEPOINT probe");
      const code = readSqlStateCode(error);
      check(
        label,
        code === expectedSqlState,
        code === expectedSqlState
          ? `refused with ${code}`
          : `refused with ${String(code)}, expected ${expectedSqlState}`,
      );
    }
  }

  async function expectAccepted(
    label: string,
    statement: string,
    parameters: readonly unknown[] = [],
  ): Promise<void> {
    await client.query("SAVEPOINT probe");
    try {
      await client.query(statement, [...parameters]);
      await client.query("ROLLBACK TO SAVEPOINT probe");
      check(label, true, "accepted");
    } catch (error: unknown) {
      await client.query("ROLLBACK TO SAVEPOINT probe");
      check(label, false, `refused with ${String(readSqlStateCode(error))} — too strict`);
    }
  }

  const INSERT_DRAFT = `
    INSERT INTO blueprint_draft (id, owner_user_id, arm, label, document_json, document_schema_version, revision)
    VALUES ($1, $2, $3, $4, $5, $6, $7)`;

  try {
    await client.query("BEGIN");

    const ownerRow = await client.query<{ id: string }>(`SELECT id FROM "user" LIMIT 1`);
    const ownerUserId = ownerRow.rows[0]?.id;
    if (ownerUserId === undefined) {
      throw new Error("No user rows exist. Seed an account before running this verifier.");
    }

    console.log("\n--- 1. the document is a JSON object, and it is bounded ---");

    await expectAccepted("an object document is accepted", INSERT_DRAFT, [
      randomUUID(),
      ownerUserId,
      "teardown",
      "Cordless drill",
      '{"title":"half-typed"}',
      1,
      1,
    ]);

    /*
     * ⚠️ THE HALF-ANSWERED DOCUMENT IS THE POINT OF THE TABLE. A draft that only accepted
     * submittable documents would refuse exactly the drafts worth saving.
     */
    await expectAccepted(
      "an almost-empty object is accepted — a draft is unvalidated",
      INSERT_DRAFT,
      [randomUUID(), ownerUserId, "case_study", null, "{}", 1, 1],
    );

    for (const [label, document] of [
      ["an array document is refused", "[1,2]"],
      ["a bare scalar document is refused", '"hello"'],
      ["a null document is refused", "null"],
    ] as const) {
      await expectRefused(label, PG_CHECK_VIOLATION, INSERT_DRAFT, [
        randomUUID(),
        ownerUserId,
        "teardown",
        null,
        document,
        1,
        1,
      ]);
    }

    /*
     * ⚠️ THE COLUMN BOUND AND THE ZOD BOUND ARE ONE NUMBER, DERIVED RATHER THAN RETYPED. The first
     * spelling of this pair used the column's own 262,144 and `json-body-budget.test.ts` refused it:
     * `estimateBodyBytes` counts four bytes per character, so the CHECK was unreachable through
     * `longFormBody` and therefore decorative. Reading the constant here is what keeps them agreeing.
     */
    await expectAccepted("a document at exactly the shared maximum is accepted", INSERT_DRAFT, [
      randomUUID(),
      ownerUserId,
      "showcase_launch",
      null,
      `{"x":"${"y".repeat(BLUEPRINT_DRAFT_DOCUMENT_MAXIMUM_CHARACTERS - 10)}"}`,
      1,
      1,
    ]);
    await expectRefused(
      "one character past it is refused — the CHECK is reachable, not decoration",
      PG_CHECK_VIOLATION,
      INSERT_DRAFT,
      [
        randomUUID(),
        ownerUserId,
        "showcase_launch",
        null,
        `{"x":"${"y".repeat(BLUEPRINT_DRAFT_DOCUMENT_MAXIMUM_CHARACTERS)}"}`,
        1,
        1,
      ],
    );

    console.log("\n--- 2. the scalars ---");

    await expectRefused("a zero revision is refused", PG_CHECK_VIOLATION, INSERT_DRAFT, [
      randomUUID(),
      ownerUserId,
      "teardown",
      null,
      "{}",
      1,
      0,
    ]);
    await expectRefused("a zero schema version is refused", PG_CHECK_VIOLATION, INSERT_DRAFT, [
      randomUUID(),
      ownerUserId,
      "teardown",
      null,
      "{}",
      0,
      1,
    ]);
    await expectRefused("an empty label is refused", PG_CHECK_VIOLATION, INSERT_DRAFT, [
      randomUUID(),
      ownerUserId,
      "teardown",
      "",
      "{}",
      1,
      1,
    ]);
    await expectRefused(
      "a draft owned by nobody is refused",
      PG_FOREIGN_KEY_VIOLATION,
      INSERT_DRAFT,
      [randomUUID(), randomUUID(), "teardown", null, "{}", 1, 1],
    );

    console.log("\n--- 3. the owner cascade, and the images a draft holds ---");

    await client.query("SAVEPOINT cascade_probe");
    const scratchUserId = randomUUID();
    await client.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1, 'Draft Verifier', $2, true, now(), now())`,
      [scratchUserId, `draft-verify-${scratchUserId}@example.test`],
    );
    const draftId = randomUUID();
    await client.query(INSERT_DRAFT, [draftId, scratchUserId, "showcase_launch", null, "{}", 1, 1]);
    await client.query(
      `INSERT INTO showcase_launch_write_up_image
         (id, uploaded_by_user_id, draft_id, public_id, url, width_px, height_px, blur_data_url)
       VALUES ($1, $2, $3, $4, $5, 900, 600, 'data:image/webp;base64,AAAA')`,
      [
        randomUUID(),
        scratchUserId,
        draftId,
        `verify/draft-${draftId}`,
        `https://x.test/${draftId}.avif`,
      ],
    );

    await client.query(`DELETE FROM "user" WHERE id = $1`, [scratchUserId]);
    const survivingDrafts = await client.query(`SELECT 1 FROM blueprint_draft WHERE id = $1`, [
      draftId,
    ]);
    check(
      "deleting the owner takes the draft — the only thing that reaches an opaque document",
      survivingDrafts.rowCount === 0,
      survivingDrafts.rowCount === 0 ? "the draft went with the account" : "THE DRAFT SURVIVED",
    );
    await client.query("ROLLBACK TO SAVEPOINT cascade_probe");

    console.log("\n--- 4. the sweeper's predicate ---");

    /*
     * ⚠️ THE PARTIAL INDEX IS READ BACK RATHER THAN RETYPED. A resumed draft's images all carry a
     * NULL `launch_id`, so an index — and a sweeper — predicated on that alone would delete every
     * one of them after a day, silently. This is the assertion that keeps the index, the sweeper and
     * the staging cap saying the same thing.
     */
    const unclaimedIndex = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'showcase_launch_write_up_image_unclaimed_idx'`,
    );
    const predicate = unclaimedIndex.rows[0]?.indexdef ?? "";
    check(
      "the unclaimed-image index excludes drafts, not just launches",
      predicate.includes("draft_id IS NULL") && predicate.includes("launch_id IS NULL"),
      predicate || "the index is missing",
    );

    await client.query("ROLLBACK");
  } finally {
    client.release();
    await pool.end();
  }

  console.log(
    failureCount === 0
      ? "\n  (transaction rolled back — nothing was persisted)\n\nAll blueprint-draft constraint assertions passed."
      : `\n${String(failureCount)} assertion(s) FAILED.`,
  );
  process.exit(failureCount === 0 ? 0 : 1);
}

void main();
