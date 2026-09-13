/**
 * Proves the twelve blueprint engagement tables' constraints against a REAL database.
 *
 *   pnpm db:verify-blueprint-engagement-constraints
 *
 * WHY THIS EXISTS SEPARATELY FROM THE VITEST SUITE. That suite mocks `#src/db/index.js` wholesale,
 * so no test in this repository can prove anything about Postgres. Every claim below is a claim
 * about the DATABASE — a CHECK, a composite primary key, a partial unique index, a foreign key's
 * disposition — and the only way to prove one is to attempt the write and watch it be refused.
 *
 * FOUR OF THESE EXIST ONLY IN SQL, and they are why the file is worth its length:
 *
 *   THE ANTI-REPLAY BOUNDARY. `*_view_session_unq` on `(target, fingerprint, day)` is the ONLY
 *       reason `view_count` means anything. The service inserts `ON CONFLICT DO NOTHING` and moves
 *       the counter only when a row appeared; if that index were ever dropped, every reload would
 *       increment and nothing in TypeScript would notice.
 *
 *   THE TOMBSTONE'S BODY PAIR. `*_comment_body_ck` permits a body only while `is_deleted` is false
 *       and DEMANDS the empty string once it is true. That second arm is what the privacy erasure
 *       stands on: without it, "deleted" is a rendering convention the next reader can forget, and
 *       the text sits in the table forever. Both arms are probed.
 *
 *   THE VIEW SESSION'S `set null` VERSUS THE LIKE'S `cascade`. Two opposite dispositions on two
 *       neighbouring tables, both one option away from each other, and
 *       `db:verify-anonymization-coverage` can see that the keys exist but not which direction was
 *       intended. Deleting a user must NULL a view session and DELETE a like.
 *
 *   THE COMPOSITE PRIMARY KEYS. They are the idempotence mechanism that makes the toggle routes
 *       `PUT`/`DELETE` rather than `POST`/`DELETE`, and the reason those routes carry no
 *       idempotency key. A duplicate must be refused by the database, not by a service pre-check.
 *
 * ⚠️ ONE ASSERTION IS ABOUT A DELIBERATE ABSENCE: a stats row must NOT exist for a freshly
 * published showcase launch, and must appear on the first engagement. That is the invariant the
 * upsert exists for, and a bare `UPDATE` would pass every other test in this file while silently
 * losing the count.
 *
 * EVERYTHING RUNS INSIDE ONE TRANSACTION THAT IS ALWAYS ROLLED BACK.
 *
 * Exits non-zero on any failed assertion.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";

import { pool } from "#src/db/index.js";

const PG_CHECK_VIOLATION = "23514";
const PG_UNIQUE_VIOLATION = "23505";
const PG_FOREIGN_KEY_VIOLATION = "23503";

interface Assertion {
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

const assertions: Assertion[] = [];

function check(label: string, passed: boolean, detail: string): void {
  assertions.push({ label, passed, detail });
  console.log(`${passed ? "  ok  " : " FAIL "} ${label} — ${detail}`);
}

function readSqlState(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate: { readonly code?: unknown } = error;
  return typeof candidate.code === "string" ? candidate.code : undefined;
}

const FINGERPRINT = "0".repeat(64);

async function main(): Promise<void> {
  const client = await pool.connect();
  const suffix = randomUUID().slice(0, 8);

  async function expectRefused(
    label: string,
    expectedSqlState: string,
    statement: string,
    parameters: readonly unknown[] = [],
  ): Promise<void> {
    await client.query(`SAVEPOINT probe`);
    try {
      await client.query(statement, [...parameters]);
      await client.query(`ROLLBACK TO SAVEPOINT probe`);
      check(label, false, "the write SUCCEEDED — the constraint is missing");
    } catch (error: unknown) {
      await client.query(`ROLLBACK TO SAVEPOINT probe`);
      const code = readSqlState(error);
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
    await client.query(`SAVEPOINT probe`);
    try {
      await client.query(statement, [...parameters]);
      await client.query(`ROLLBACK TO SAVEPOINT probe`);
      check(label, true, "accepted");
    } catch (error: unknown) {
      await client.query(`ROLLBACK TO SAVEPOINT probe`);
      check(label, false, `refused with ${String(readSqlState(error))} — the CHECK is too strict`);
    }
  }

  try {
    await client.query("BEGIN");

    // --- fixtures: an account, and one published row on each arm. ---
    const viewerId = randomUUID();
    await client.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1, 'Engagement Verifier', $2, true, now(), now())`,
      [viewerId, `engagement-verify-${suffix}@example.test`],
    );

    const [teardownRow] = (
      await client.query<{ id: string }>(
        `SELECT id FROM teardown WHERE moderation_state = 'published' LIMIT 1`,
      )
    ).rows;
    if (!teardownRow) {
      console.error("No published teardown exists. Run `pnpm db:seed-blueprint-teardowns` first.");
      process.exit(1);
    }
    const teardownId = teardownRow.id;

    const [caseStudyRow] = (
      await client.query<{ id: string }>(
        `SELECT id FROM case_study WHERE moderation_state = 'published' LIMIT 1`,
      )
    ).rows;
    const caseStudyId = caseStudyRow?.id;

    console.log("\n--- 1. the anti-replay boundary ---");

    const INSERT_VIEW = `
      INSERT INTO teardown_view_session (id, teardown_id, viewer_user_id, viewer_fingerprint, view_day_bucket)
      VALUES ($1, $2, $3, $4, $5)`;

    await client.query(INSERT_VIEW, [
      randomUUID(),
      teardownId,
      viewerId,
      FINGERPRINT,
      "2026-03-01",
    ]);
    check("a view session inserts", true, "one row per viewer per UTC day");

    await expectRefused(
      "a SECOND session for the same (teardown, fingerprint, day) is refused — THE anti-replay boundary",
      PG_UNIQUE_VIOLATION,
      INSERT_VIEW,
      [randomUUID(), teardownId, viewerId, FINGERPRINT, "2026-03-01"],
    );

    await expectAccepted(
      "the same fingerprint on the NEXT day is accepted — the bucket is per-day by design",
      INSERT_VIEW,
      [randomUUID(), teardownId, viewerId, FINGERPRINT, "2026-03-02"],
    );

    await expectRefused(
      "a non-hex fingerprint is refused — it is server-computed, so a bad one means something stopped hashing",
      PG_CHECK_VIOLATION,
      INSERT_VIEW,
      [randomUUID(), teardownId, viewerId, "not-a-sha256-digest", "2026-03-03"],
    );
    await expectRefused("a 63-character fingerprint is refused", PG_CHECK_VIOLATION, INSERT_VIEW, [
      randomUUID(),
      teardownId,
      viewerId,
      "0".repeat(63),
      "2026-03-04",
    ]);

    await expectAccepted(
      "an ANONYMOUS view session is accepted — viewer_user_id is nullable and the beacon takes no session",
      INSERT_VIEW,
      [randomUUID(), teardownId, null, "f".repeat(64), "2026-03-05"],
    );

    console.log("\n--- 2. the composite primary keys, which ARE the idempotence ---");

    await client.query(`INSERT INTO teardown_like (teardown_id, user_id) VALUES ($1, $2)`, [
      teardownId,
      viewerId,
    ]);
    check("a like inserts", true, "one row per (teardown, user)");

    await expectRefused(
      "a duplicate like is refused by the primary key — this is why the route is PUT, not POST",
      PG_UNIQUE_VIOLATION,
      `INSERT INTO teardown_like (teardown_id, user_id) VALUES ($1, $2)`,
      [teardownId, viewerId],
    );

    await expectRefused(
      "a save naming nobody is refused",
      PG_FOREIGN_KEY_VIOLATION,
      `INSERT INTO teardown_save (teardown_id, user_id) VALUES ($1, $2)`,
      [teardownId, randomUUID()],
    );
    await expectRefused(
      "a like naming no teardown is refused",
      PG_FOREIGN_KEY_VIOLATION,
      `INSERT INTO teardown_like (teardown_id, user_id) VALUES ($1, $2)`,
      [randomUUID(), viewerId],
    );

    if (caseStudyId !== undefined) {
      await expectAccepted(
        "a case-study like inserts — the only engagement that arm takes",
        `INSERT INTO case_study_like (case_study_id, user_id) VALUES ($1, $2)`,
        [caseStudyId, viewerId],
      );
    }

    console.log("\n--- 3. the comment tree, and the five CHECKs that shape it ---");

    const INSERT_COMMENT = `
      INSERT INTO teardown_comment (id, teardown_id, parent_comment_id, depth, author_user_id, body_text, is_deleted, deleted_at, reply_count)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;

    const rootCommentId = randomUUID();
    await client.query(INSERT_COMMENT, [
      rootCommentId,
      teardownId,
      null,
      0,
      viewerId,
      "The gearbox comes out in one piece.",
      false,
      null,
      0,
    ]);
    check("a top-level comment inserts at depth 0", true, rootCommentId);

    await expectAccepted("a reply inserts at depth 1", INSERT_COMMENT, [
      randomUUID(),
      teardownId,
      rootCommentId,
      1,
      viewerId,
      "Agreed.",
      false,
      null,
      0,
    ]);

    await expectRefused(
      "depth 1 with no parent is refused — depth and parenthood are one fact stated twice",
      PG_CHECK_VIOLATION,
      INSERT_COMMENT,
      [randomUUID(), teardownId, null, 1, viewerId, "Orphan reply.", false, null, 0],
    );
    await expectRefused(
      "depth 0 WITH a parent is refused — the other direction of the same CHECK",
      PG_CHECK_VIOLATION,
      INSERT_COMMENT,
      [randomUUID(), teardownId, rootCommentId, 0, viewerId, "Confused reply.", false, null, 0],
    );
    await expectRefused(
      "depth 2 is refused — one level of threading only",
      PG_CHECK_VIOLATION,
      INSERT_COMMENT,
      [randomUUID(), teardownId, rootCommentId, 2, viewerId, "Too deep.", false, null, 0],
    );
    await expectRefused(
      "a reply carrying replies of its own is refused (leaf_ck)",
      PG_CHECK_VIOLATION,
      INSERT_COMMENT,
      [randomUUID(), teardownId, rootCommentId, 1, viewerId, "Has replies.", false, null, 1],
    );
    await expectRefused("a negative reply count is refused", PG_CHECK_VIOLATION, INSERT_COMMENT, [
      randomUUID(),
      teardownId,
      null,
      0,
      viewerId,
      "Negative.",
      false,
      null,
      -1,
    ]);

    console.log("\n--- 4. the tombstone pair, which the privacy erasure stands on ---");

    await expectRefused(
      "is_deleted with no deleted_at is refused",
      PG_CHECK_VIOLATION,
      INSERT_COMMENT,
      [randomUUID(), teardownId, null, 0, viewerId, "", true, null, 0],
    );
    await expectRefused(
      "a deleted_at with is_deleted false is refused — the other direction",
      PG_CHECK_VIOLATION,
      INSERT_COMMENT,
      [randomUUID(), teardownId, null, 0, viewerId, "Still here.", false, new Date(), 0],
    );
    // ⚠️ THE TWO ARMS THAT MAKE THE ERASURE REAL RATHER THAN CONVENTIONAL.
    await expectRefused(
      "a TOMBSTONE that still carries its text is refused — this is what makes the scrub real",
      PG_CHECK_VIOLATION,
      INSERT_COMMENT,
      [randomUUID(), teardownId, null, 0, viewerId, "Not actually erased.", true, new Date(), 0],
    );
    await expectRefused(
      "a LIVE comment with an empty body is refused — the other arm of the same pair",
      PG_CHECK_VIOLATION,
      INSERT_COMMENT,
      [randomUUID(), teardownId, null, 0, viewerId, "", false, null, 0],
    );
    await expectAccepted(
      "a tombstone with an EMPTY body is accepted — the shape the erasure writes",
      INSERT_COMMENT,
      [randomUUID(), teardownId, null, 0, viewerId, "", true, new Date(), 0],
    );
    await expectRefused("a 2001-character body is refused", PG_CHECK_VIOLATION, INSERT_COMMENT, [
      randomUUID(),
      teardownId,
      null,
      0,
      viewerId,
      "b".repeat(2001),
      false,
      null,
      0,
    ]);

    await expectRefused(
      "a duplicate comment like is refused by the primary key",
      PG_UNIQUE_VIOLATION,
      `INSERT INTO teardown_comment_like (comment_id, user_id)
       VALUES ($1, $2), ($1, $2)`,
      [rootCommentId, viewerId],
    );

    console.log("\n--- 5. the two opposite user dispositions ---");

    await client.query(`SAVEPOINT user_delete`);
    await client.query(`DELETE FROM "user" WHERE id = $1`, [viewerId]);

    const survivingSessions = await client.query<{ viewer_user_id: string | null }>(
      `SELECT viewer_user_id FROM teardown_view_session
        WHERE teardown_id = $1 AND view_day_bucket = '2026-03-01'`,
      [teardownId],
    );
    check(
      "deleting the account NULLS the view session rather than deleting it",
      survivingSessions.rowCount === 1 && survivingSessions.rows[0]?.viewer_user_id === null,
      survivingSessions.rowCount === 1
        ? "the row survived with a NULL viewer"
        : "the row was deleted — the replay window reopens",
    );

    const survivingLikes = await client.query(
      `SELECT 1 FROM teardown_like WHERE teardown_id = $1`,
      [teardownId],
    );
    check(
      "deleting the account DELETES the like — the opposite disposition, one table away",
      survivingLikes.rowCount === 0,
      survivingLikes.rowCount === 0 ? "the like went with the account" : "the like survived",
    );

    const survivingComments = await client.query<{ author_user_id: string | null }>(
      `SELECT author_user_id FROM teardown_comment WHERE id = $1`,
      [rootCommentId],
    );
    check(
      "deleting the account NULLS the comment's author but keeps the thread",
      survivingComments.rowCount === 1 && survivingComments.rows[0]?.author_user_id === null,
      survivingComments.rowCount === 1
        ? "the comment survived with a NULL author"
        : "the thread was erased under the people who replied to it",
    );
    await client.query(`ROLLBACK TO SAVEPOINT user_delete`);

    console.log("\n--- 6. the cascades off the blueprint itself ---");

    await client.query(`SAVEPOINT target_delete`);
    await client.query(`DELETE FROM teardown WHERE id = $1`, [teardownId]);
    const orphans = await client.query<{ table_name: string }>(
      `SELECT 'teardown_view_session' AS table_name FROM teardown_view_session WHERE teardown_id = $1
       UNION ALL SELECT 'teardown_like'    FROM teardown_like    WHERE teardown_id = $1
       UNION ALL SELECT 'teardown_save'    FROM teardown_save    WHERE teardown_id = $1
       UNION ALL SELECT 'teardown_comment' FROM teardown_comment WHERE teardown_id = $1`,
      [teardownId],
    );
    check(
      "deleting a teardown leaves no orphan in any of its four engagement tables",
      orphans.rowCount === 0,
      orphans.rowCount === 0
        ? "no orphans in four child tables"
        : `orphans remain in ${orphans.rows.map((row) => row.table_name).join(", ")}`,
    );
    await client.query(`ROLLBACK TO SAVEPOINT target_delete`);

    console.log("\n--- 7. the stats sidecars still refuse a negative ---");

    await expectRefused(
      "a negative teardown save count is refused",
      PG_CHECK_VIOLATION,
      `UPDATE teardown_stats SET save_count = -1 WHERE teardown_id = $1`,
      [teardownId],
    );
    /*
     * ⚠️ A PURPOSE-MADE LAUNCH, NOT `SELECT ... LIMIT 1`. The first spelling of this assertion was
     * `INSERT ... SELECT id, -1 FROM showcase_launch LIMIT 1`, which inserts ZERO ROWS and
     * SUCCEEDS on a database with no launches — so it reported a missing constraint that was
     * present, and would equally have reported a present one that was missing. An assertion whose
     * subject might not exist is not an assertion.
     */
    const probeLaunchId = randomUUID();
    await client.query(
      `INSERT INTO showcase_launch (
         id, author_user_id, title, tagline, summary, launched_at, difficulty,
         accepted_launch_statement_ids, heading_image_url, heading_image_public_id, moderation_state)
       VALUES ($1, $2, $3, 'A probe launch for the verifier', $4, now(), 'intermediate',
               ARRAY['built_it_ourselves','results_are_our_own']::text[], $5, $6, 'pending_review')`,
      [
        probeLaunchId,
        viewerId,
        `Engagement probe launch ${suffix}`,
        "A disposable launch used to prove the stats sidecar still refuses a negative counter.",
        "https://res.cloudinary.com/demo/image/upload/v1/probe.avif",
        `verify/engagement-${suffix}`,
      ],
    );

    await expectRefused(
      "a negative showcase upvote count is refused",
      PG_CHECK_VIOLATION,
      `INSERT INTO showcase_launch_stats (launch_id, upvote_count) VALUES ($1, -1)`,
      [probeLaunchId],
    );

    /*
     * ⚠️ THE DELIBERATE ABSENCE. A freshly created launch has NO stats row — the publish path mints
     * none, the reads left-join and coalesce, and the upsert in the engagement service is what
     * makes the first like land somewhere. A bare `UPDATE` would pass every other assertion in
     * this file and silently lose the count.
     */
    const statsBeforeEngagement = await client.query(
      `SELECT 1 FROM showcase_launch_stats WHERE launch_id = $1`,
      [probeLaunchId],
    );
    check(
      "a launch has NO stats row until something engages with it",
      statsBeforeEngagement.rowCount === 0,
      statsBeforeEngagement.rowCount === 0
        ? "no row, which is why every counter write is an upsert"
        : "a row was minted before any engagement",
    );

    await expectAccepted(
      "and the upsert's INSERT half is legal — the first engagement mints it",
      `INSERT INTO showcase_launch_stats (launch_id, upvote_count) VALUES ($1, 1)
       ON CONFLICT (launch_id) DO UPDATE SET upvote_count = showcase_launch_stats.upvote_count + 1`,
      [probeLaunchId],
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
    console.log("\n  (transaction rolled back — nothing was persisted)");
  }

  const failureCount = assertions.filter((assertion) => !assertion.passed).length;
  console.log(
    failureCount === 0
      ? `\nAll ${String(assertions.length)} blueprint-engagement constraint assertions passed.`
      : `\n${String(failureCount)} of ${String(assertions.length)} blueprint-engagement constraint assertions FAILED.`,
  );
  if (failureCount > 0) process.exitCode = 1;
}

main()
  .then(async () => {
    await pool.end();
    return undefined;
  })
  .catch(async (error: unknown) => {
    console.error("Blueprint engagement constraint verification failed to run:", error);
    await pool.end();
    process.exit(1);
  });
