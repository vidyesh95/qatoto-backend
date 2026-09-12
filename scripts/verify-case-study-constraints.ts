/**
 * Proves the case-study tables' constraints against a REAL database.
 *
 *   pnpm db:verify-case-study-constraints
 *
 * WHY THIS EXISTS SEPARATELY FROM THE VITEST SUITE. That suite mocks `#src/db/index.js` wholesale,
 * so no test in this repository can prove anything about Postgres. Every claim below is a claim
 * about the DATABASE — a CHECK, a composite foreign key, a generated column, a partial unique index
 * — and the only way to prove one is to attempt the write and watch it be refused. A guarantee
 * nobody has seen fire is a guarantee nobody should trust.
 *
 * FIVE OF THESE EXIST ONLY IN SQL, and they are why the file is worth its length:
 *
 *   THE ARRAY-ELEMENT NULL GUARD. `text[] NOT NULL` says nothing about its ELEMENTS, so
 *       `ARRAY['was_part_of_it', NULL] @> ARRAY[...]` is NULL, `false OR NULL` is NULL, and a NULL
 *       CHECK PASSES. That is migration 0172's bug in a new disguise — every constraint 0172 fixed
 *       was a scalar arm, so recognising the scalar shape does not catch this one. Two assertions
 *       below exist for exactly this and nothing else.
 *
 *   THE WITHHOLDING COMPOSITE FOREIGN KEY. `case_study_evidence_company.author_relationship` is
 *       denormalised so a per-row CHECK can read it, and the key is what forces it to agree with
 *       the parent. Nothing in TypeScript holds that pairing, and the key's `ON UPDATE RESTRICT`
 *       also makes the parent's answer append-only — which is asserted here, because it is a
 *       property somebody could delete by changing one option.
 *
 *   THE PARTIAL TITLE INDEX. Taken while in review or readable, FREED by a rejection. Both halves
 *       are asserted, because "unique" and "unique except when rejected" look identical until one
 *       of them refuses a resubmission.
 *
 *   THE AUTHOR ARM, AND WHY A `null_out` IS ILLEGAL. `db:verify-anonymization-coverage` cannot see
 *       this: it flags a `null_out` on a NOT NULL column and this column is nullable. So the
 *       refusal is proven here instead.
 *
 *   THE RELATED-LESSON FOREIGN KEY onto `public_slug`, which is what makes a dangling edge
 *       impossible — and, conversely, why visibility had to stay OUT of that key.
 *
 * ⚠️ ONE RULE IS DELIBERATELY *NOT* ENFORCED BY THE DATABASE, and there is an assertion recording
 * that: a `public_sources` case study needs at least one source. A CHECK cannot assert the existence
 * of a sibling row, so it lives in the write gate. Writing the absence down is what stops somebody
 * assuming the table is holding it.
 *
 * EVERYTHING RUNS INSIDE ONE TRANSACTION THAT IS ALWAYS ROLLED BACK. That is why there is no
 * cleanup code: the rollback is the cleanup, and it cannot be skipped by a failed assertion.
 *
 * ⚠️ THIS SCRIPT PRINTS REFUSED STATEMENTS ON FAILURE, into a terminal and a CI log, and the
 * fixtures it writes include a withheld company name. Every name here is invented for this file.
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

const SUMMARY =
  "A disposable case study used to prove the constraints, long enough to clear the forty-character floor.";
const LESSON_TITLE = "Prove the constraints before trusting them";
const PROBLEM = "The constraints had never been watched firing.";
const CONTEXT = "A verification script, run by an operator against a real database.";

async function main(): Promise<void> {
  const client = await pool.connect();
  const suffix = randomUUID().slice(0, 8);

  /**
   * Runs a write that MUST be refused.
   *
   * Each attempt gets its own SAVEPOINT, because a failed statement poisons the enclosing
   * transaction in Postgres — without one, the first expected refusal would abort every later
   * assertion with "current transaction is aborted".
   */
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

  /** Runs a write that must be ACCEPTED, then rolls it back. The other half of every refusal. */
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

  /** The columns a case study cannot be inserted without, on the first-hand arm. */
  const INSERT_CASE_STUDY = `
    INSERT INTO case_study (
      id, public_slug, title, one_line_action, summary, problem, context, discipline, sector,
      author_relationship, accepted_statement_ids, author_display_name, moderation_state, created_at)
    VALUES (
      $1, $2, $3, 'Prove every constraint you rely on.', $4, $5, $6, 'tooling', 'Hardware',
      'first_hand', ARRAY['was_part_of_it', 'figures_from_records']::text[], 'Verifier', $7, now())`;

  try {
    await client.query("BEGIN");

    console.log("\n--- 1. identity, the title index and the slug ---");

    const caseStudyId = randomUUID();
    const publicSlug = `verify-case-study-${suffix}`;
    await client.query(INSERT_CASE_STUDY, [
      caseStudyId,
      publicSlug,
      `${LESSON_TITLE} ${suffix}`,
      SUMMARY,
      PROBLEM,
      CONTEXT,
      "published",
    ]);
    check("a published case study inserts with a byline and no reviewer", true, publicSlug);

    await expectRefused(
      "a duplicate public slug is refused (case_study_public_slug_unique)",
      PG_UNIQUE_VIOLATION,
      INSERT_CASE_STUDY,
      [
        randomUUID(),
        publicSlug,
        `Another lesson entirely ${suffix}`,
        SUMMARY,
        PROBLEM,
        CONTEXT,
        "published",
      ],
    );

    /**
     * ⚠️ THE TITLE IS TAKEN AFTER NORMALISING — trimmed, inner whitespace collapsed, lowercased —
     * which is the generated column's whole job. A title differing only in case and spacing is the
     * same lesson.
     */
    await expectRefused(
      "a title differing only in case and spacing is refused (case_study_title_live_uidx)",
      PG_UNIQUE_VIOLATION,
      INSERT_CASE_STUDY,
      [
        randomUUID(),
        `${publicSlug}-2`,
        `  ${LESSON_TITLE.toUpperCase()}   ${suffix}  `,
        SUMMARY,
        PROBLEM,
        CONTEXT,
        "published",
      ],
    );

    /** A pending row takes the title too, which is what makes the submit race impossible. */
    await expectRefused(
      "a PENDING row cannot take a live title (case_study_title_live_uidx)",
      PG_UNIQUE_VIOLATION,
      `INSERT INTO case_study (
         id, title, one_line_action, summary, problem, context, discipline, sector,
         author_relationship, accepted_statement_ids, author_display_name, moderation_state, created_at)
       VALUES ($1, $2, 'Prove every constraint.', $3, $4, $5, 'tooling', 'Hardware', 'first_hand',
               ARRAY['was_part_of_it', 'figures_from_records']::text[], 'Verifier', 'pending_review', now())`,
      [randomUUID(), `${LESSON_TITLE} ${suffix}`, SUMMARY, PROBLEM, CONTEXT],
    );

    /**
     * ⚠️ AND A REJECTION FREES IT, which is the other half and the one that would go unnoticed. A
     * writer who was sent back must be able to resubmit under the same title.
     */
    await client.query(`SAVEPOINT rejected_title`);
    await client.query(
      `UPDATE case_study SET moderation_state = 'rejected', public_slug = NULL,
         moderator_note = 'Needs a source.', reviewed_at = now(),
         reviewed_by_user_id = (SELECT id FROM "user" LIMIT 1)
       WHERE id = $1`,
      [caseStudyId],
    );
    await expectAccepted(
      "a rejected row frees its title (case_study_title_live_uidx)",
      `INSERT INTO case_study (
         id, title, one_line_action, summary, problem, context, discipline, sector,
         author_relationship, accepted_statement_ids, author_display_name, moderation_state, created_at)
       VALUES ($1, $2, 'Prove every constraint.', $3, $4, $5, 'tooling', 'Hardware', 'first_hand',
               ARRAY['was_part_of_it', 'figures_from_records']::text[], 'Verifier', 'pending_review', now())`,
      [randomUUID(), `${LESSON_TITLE} ${suffix}`, SUMMARY, PROBLEM, CONTEXT],
    );
    await client.query(`ROLLBACK TO SAVEPOINT rejected_title`);

    await expectRefused(
      "a reserved slug is refused (case_study_slug_ck)",
      PG_CHECK_VIOLATION,
      INSERT_CASE_STUDY,
      [
        randomUUID(),
        "mine",
        `A different lesson ${suffix}`,
        SUMMARY,
        PROBLEM,
        CONTEXT,
        "published",
      ],
    );

    await expectRefused(
      "a quarantined case study is refused (case_study_moderation_state_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE case_study SET moderation_state = 'quarantined' WHERE id = $1`,
      [caseStudyId],
    );

    console.log("\n--- 2. the decision columns, and the clause deliberately absent ---");

    await expectRefused(
      "a reviewer with no review time is refused (case_study_decision_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE case_study SET reviewed_by_user_id = (SELECT id FROM "user" LIMIT 1) WHERE id = $1`,
      [caseStudyId],
    );

    await expectRefused(
      "a rejection with no note is refused (case_study_decision_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE case_study SET moderation_state = 'rejected', public_slug = NULL WHERE id = $1`,
      [caseStudyId],
    );

    await expectRefused(
      "a published row with no public slug is refused (case_study_decision_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE case_study SET public_slug = NULL WHERE id = $1`,
      [caseStudyId],
    );

    await expectRefused(
      "a pending row carrying a slug is refused (case_study_decision_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE case_study SET moderation_state = 'pending_review' WHERE id = $1`,
      [caseStudyId],
    );

    /**
     * ⚠️ THE ABSENT CLAUSE, ASSERTED AS PRESENT-AND-ALLOWED. `showcase_launch_decision_ck` ties
     * `published` to a reviewer; this one must NOT, because the seed publishes ten rows nobody
     * reviewed. If somebody "fixes" that asymmetry, the seed breaks — so the permission is proven.
     */
    await expectAccepted(
      "a published row with NO reviewer is accepted (case_study_decision_ck, by design)",
      `UPDATE case_study SET summary = $2 WHERE id = $1 AND reviewed_by_user_id IS NULL`,
      [caseStudyId, `${SUMMARY} Reworded.`],
    );

    console.log("\n--- 3. the author arm, and why a null_out is illegal ---");

    await expectRefused(
      "a row with neither an account nor a byline is refused (case_study_author_arm_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE case_study SET author_display_name = NULL WHERE id = $1`,
      [caseStudyId],
    );

    await expectRefused(
      "a byline beside an account is refused (case_study_author_arm_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE case_study SET author_user_id = (SELECT id FROM "user" LIMIT 1) WHERE id = $1`,
      [caseStudyId],
    );

    /**
     * ⚠️ THE ASSERTION `db:verify-anonymization-coverage` CANNOT MAKE. It flags a `null_out` on a
     * NOT NULL column; this column is nullable, so it would go green on the one disposition that
     * raises 23514 in the middle of an erasure job. Here is the proof, on an account-authored row.
     */
    const accountAuthoredId = randomUUID();
    const [existingUser] = (await client.query<{ id: string }>(`SELECT id FROM "user" LIMIT 1`))
      .rows;
    if (existingUser) {
      await client.query(
        `INSERT INTO case_study (
           id, title, one_line_action, summary, problem, context, discipline, sector,
           author_relationship, accepted_statement_ids, author_user_id, moderation_state, created_at)
         VALUES ($1, $2, 'Prove every constraint.', $3, $4, $5, 'quality', 'Hardware', 'public_sources',
                 ARRAY['figures_in_linked_sources', 'says_only_what_sources_say']::text[], $6,
                 'pending_review', now())`,
        [
          accountAuthoredId,
          `An account-authored lesson ${suffix}`,
          SUMMARY,
          PROBLEM,
          CONTEXT,
          existingUser.id,
        ],
      );
      check("an account-authored case study inserts with no byline text", true, "case_study");

      await expectRefused(
        "clearing author_user_id on an account-authored row is refused (case_study_author_arm_ck)",
        PG_CHECK_VIOLATION,
        `UPDATE case_study SET author_user_id = NULL WHERE id = $1`,
        [accountAuthoredId],
      );
    } else {
      check("clearing author_user_id is refused", false, "no user row to author with — skipped");
    }

    console.log(
      "\n--- 4. the array-element NULL guard: migration 0172's bug in a new disguise ---",
    );

    /**
     * ⚠️ THE TWO ASSERTIONS THIS FILE WAS MOST WORTH WRITING FOR.
     *
     * Without `array_position(..., NULL) IS NULL`, the `@>` containment test evaluates to NULL for
     * an array holding a NULL element, `false OR NULL` is NULL, and Postgres ACCEPTS a NULL CHECK.
     * `text[] NOT NULL` does not forbid NULL elements.
     */
    await expectRefused(
      "a NULL element in accepted_statement_ids is refused (case_study_statements_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE case_study SET accepted_statement_ids = ARRAY['was_part_of_it', NULL]::text[] WHERE id = $1`,
      [caseStudyId],
    );

    await expectRefused(
      "a NULL element in tags is refused (case_study_tags_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE case_study SET tags = ARRAY['tooling', NULL]::text[] WHERE id = $1`,
      [caseStudyId],
    );

    /** Containment is not set equality, so the cardinality is what makes `@>` exact. */
    await expectRefused(
      "the same statement ticked twice is refused (case_study_statements_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE case_study SET accepted_statement_ids = ARRAY['was_part_of_it', 'was_part_of_it']::text[] WHERE id = $1`,
      [caseStudyId],
    );

    await expectRefused(
      "a statement belonging to the other relationship is refused (case_study_statements_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE case_study SET accepted_statement_ids = ARRAY['was_part_of_it', 'says_only_what_sources_say']::text[] WHERE id = $1`,
      [caseStudyId],
    );

    await expectRefused(
      "an eleventh tag is refused (case_study_tags_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE case_study SET tags = (SELECT array_agg('tag-' || generate_series::text) FROM generate_series(1, 11)) WHERE id = $1`,
      [caseStudyId],
    );

    console.log("\n--- 5. money, and the capital-raised pair ---");

    await expectRefused(
      "an amount with no currency is refused (case_study_capital_raised_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE case_study SET capital_raised_amount_cents = 25000000 WHERE id = $1`,
      [caseStudyId],
    );

    await expectRefused(
      "a currency with no amount is refused (case_study_capital_raised_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE case_study SET capital_raised_currency = 'USD' WHERE id = $1`,
      [caseStudyId],
    );

    await expectRefused(
      "an unlisted currency is refused (case_study_capital_raised_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE case_study SET capital_raised_amount_cents = 100, capital_raised_currency = 'EUR' WHERE id = $1`,
      [caseStudyId],
    );

    /** ₹1 crore in paise — the figure `bigint` exists for. int4 caps two rupees above it. */
    await expectAccepted(
      "one crore of paise is accepted (bigint, not integer)",
      `UPDATE case_study SET capital_raised_amount_cents = 1000000000, capital_raised_currency = 'INR' WHERE id = $1`,
      [caseStudyId],
    );

    console.log("\n--- 6. the withholding composite foreign key ---");

    const companyId = randomUUID();
    await client.query(
      `INSERT INTO case_study_evidence_company
         (id, case_study_id, position, name, is_name_withheld, author_relationship, location_label, year_label)
       VALUES ($1, $2, 0, 'Kvarnby Mouldworks', true, 'first_hand', 'Gothenburg', '2024')`,
      [companyId, caseStudyId],
    );
    check(
      "a first-hand case study may withhold a company's name",
      true,
      "case_study_evidence_company",
    );

    /** ⚠️ THE RULE: only a first-hand writer may withhold, and a per-row CHECK can say so. */
    await expectRefused(
      "a public-sources company may not withhold its name (case_study_evidence_company_withheld_ck)",
      PG_CHECK_VIOLATION,
      `INSERT INTO case_study_evidence_company
         (id, case_study_id, position, name, is_name_withheld, author_relationship, location_label, year_label)
       VALUES ($1, $2, 1, 'Another Shop', true, 'public_sources', 'Bergen', '2024')`,
      [randomUUID(), accountAuthoredId],
    );

    /** ⚠️ THE KEY: a company may not disagree with its parent's answer. */
    await expectRefused(
      "a company disagreeing with its parent's relationship is refused (composite fk)",
      PG_FOREIGN_KEY_VIOLATION,
      `INSERT INTO case_study_evidence_company
         (id, case_study_id, position, name, is_name_withheld, author_relationship, location_label, year_label)
       VALUES ($1, $2, 2, 'Wrong Arm Ltd', false, 'public_sources', 'Bergen', '2024')`,
      [randomUUID(), caseStudyId],
    );

    /**
     * ⚠️ AND THE KEY MAKES THE PARENT'S ANSWER APPEND-ONLY, which is a property somebody could
     * delete by changing `onUpdate` to `cascade`. Changing the answer would edit a writer's sworn
     * statement and silently invalidate the two statement ids they ticked.
     */
    await expectRefused(
      "changing author_relationship on a row with companies is refused (ON UPDATE RESTRICT)",
      PG_FOREIGN_KEY_VIOLATION,
      `UPDATE case_study
         SET author_relationship = 'public_sources',
             accepted_statement_ids = ARRAY['figures_in_linked_sources', 'says_only_what_sources_say']::text[]
       WHERE id = $1`,
      [caseStudyId],
    );

    await expectRefused(
      "two companies with the same name on one case study is refused (name uidx)",
      PG_UNIQUE_VIOLATION,
      `INSERT INTO case_study_evidence_company
         (id, case_study_id, position, name, is_name_withheld, author_relationship, location_label, year_label)
       VALUES ($1, $2, 3, '  kvarnby mouldworks  ', false, 'first_hand', 'Gothenburg', '2023')`,
      [randomUUID(), caseStudyId],
    );

    console.log("\n--- 7. the figures and the sources ---");

    await expectAccepted(
      "a negative percentage is accepted — a figure can go down",
      `INSERT INTO case_study_outcome_metric (id, case_study_id, position, label, kind, basis_points)
       VALUES ($1, $2, 0, 'Returns', 'percentage', -1200)`,
      [randomUUID(), caseStudyId],
    );

    await expectRefused(
      "a count figure carrying a currency is refused (case_study_outcome_metric_kind_ck)",
      PG_CHECK_VIOLATION,
      `INSERT INTO case_study_outcome_metric
         (id, case_study_id, position, label, kind, count_amount, money_currency)
       VALUES ($1, $2, 1, 'Units', 'count', 10, 'USD')`,
      [randomUUID(), caseStudyId],
    );

    await expectRefused(
      "a money figure with no currency is refused (case_study_outcome_metric_kind_ck)",
      PG_CHECK_VIOLATION,
      `INSERT INTO case_study_outcome_metric
         (id, case_study_id, position, label, kind, money_amount_cents)
       VALUES ($1, $2, 2, 'Spend', 'money', 500)`,
      [randomUUID(), caseStudyId],
    );

    await expectRefused(
      "a percentage figure with no basis points is refused (case_study_outcome_metric_kind_ck)",
      PG_CHECK_VIOLATION,
      `INSERT INTO case_study_outcome_metric (id, case_study_id, position, label, kind)
       VALUES ($1, $2, 3, 'Scrap', 'percentage')`,
      [randomUUID(), caseStudyId],
    );

    /** Unconditional, unlike the form's version — no honest figure is called this. */
    await expectRefused(
      "a figure labelled as a withheld company is refused (case_study_outcome_metric_label_ck)",
      PG_CHECK_VIOLATION,
      `INSERT INTO case_study_outcome_metric (id, case_study_id, position, label, kind, count_amount)
       VALUES ($1, $2, 4, 'Name withheld (2)', 'count', 3)`,
      [randomUUID(), caseStudyId],
    );

    await expectRefused(
      "a site-relative source URL is refused (case_study_source_url_ck)",
      PG_CHECK_VIOLATION,
      `INSERT INTO case_study_source (id, case_study_id, position, label, publisher_label, url)
       VALUES ($1, $2, 0, 'A breakdown', 'A log', '/dummy/source.pdf')`,
      [randomUUID(), caseStudyId],
    );

    /**
     * ⚠️ THE SOURCE URL INDEX IS CASE-SENSITIVE, DELIBERATELY LAXER THAN THE FORM. A URL path is
     * case-sensitive, so two addresses differing in case are two addresses; the write gate compares
     * them case-insensitively and refuses earlier with a better message.
     */
    await client.query(
      `INSERT INTO case_study_source (id, case_study_id, position, label, publisher_label, url)
       VALUES ($1, $2, 1, 'A breakdown', 'A log', 'https://example.test/Qatoto/Run-Costs')`,
      [randomUUID(), caseStudyId],
    );
    await expectAccepted(
      "two source URLs differing only in case are two addresses (case_study_source_url_uidx)",
      `INSERT INTO case_study_source (id, case_study_id, position, label, publisher_label, url)
       VALUES ($1, $2, 2, 'Another', 'A log', 'https://example.test/qatoto/run-costs')`,
      [randomUUID(), caseStudyId],
    );
    await expectRefused(
      "the same source URL twice is refused (case_study_source_url_uidx)",
      PG_UNIQUE_VIOLATION,
      `INSERT INTO case_study_source (id, case_study_id, position, label, publisher_label, url)
       VALUES ($1, $2, 3, 'Another', 'A log', 'https://example.test/Qatoto/Run-Costs')`,
      [randomUUID(), caseStudyId],
    );

    /**
     * ⚠️ THE ASSERTION THAT CORRECTED THE SCHEMA. This index was originally written as
     * `btrim(url)`, by analogy with the text lists — and this probe showed the `btrim` was dead
     * code, because the URL CHECK refuses whitespace ANYWHERE in the value and so a padded URL is a
     * 23514 that never reaches the index. The index is now a plain column index, and this is the
     * assertion that says why it can be.
     */
    await expectRefused(
      "a space-padded URL is refused by the URL CHECK, not the index (case_study_source_url_ck)",
      PG_CHECK_VIOLATION,
      `INSERT INTO case_study_source (id, case_study_id, position, label, publisher_label, url)
       VALUES ($1, $2, 4, 'Padded', 'A log', '  https://example.test/padded  ')`,
      [randomUUID(), caseStudyId],
    );

    console.log("\n--- 8. the steps, the pitfalls and the related-lesson foreign key ---");

    await client.query(
      `INSERT INTO case_study_action_step (id, case_study_id, position, body)
       VALUES ($1, $2, 0, 'Quoted a bridge tool')`,
      [randomUUID(), caseStudyId],
    );
    await expectRefused(
      "a step repeated modulo case and space is refused (body uidx)",
      PG_UNIQUE_VIOLATION,
      `INSERT INTO case_study_action_step (id, case_study_id, position, body)
       VALUES ($1, $2, 1, '  QUOTED A BRIDGE TOOL  ')`,
      [randomUUID(), caseStudyId],
    );

    await expectRefused(
      "two children at the same position are refused (position uidx)",
      PG_UNIQUE_VIOLATION,
      `INSERT INTO case_study_action_step (id, case_study_id, position, body)
       VALUES ($1, $2, 0, 'A different step entirely')`,
      [randomUUID(), caseStudyId],
    );

    /** ⚠️ THE EDGE IS A REAL FOREIGN KEY, so a dangling related lesson cannot be written at all. */
    await expectRefused(
      "a related lesson naming no case study is refused (related_public_slug fk)",
      PG_FOREIGN_KEY_VIOLATION,
      `INSERT INTO case_study_related_lesson (id, case_study_id, position, related_public_slug)
       VALUES ($1, $2, 0, $3)`,
      [randomUUID(), caseStudyId, `no-such-lesson-${suffix}`],
    );

    /**
     * ⚠️ AND VISIBILITY IS DELIBERATELY *NOT* IN THAT KEY. A flagged target keeps its slug and its
     * edge, and the resolver drops it — because a composite key on `(public_slug, moderation_state)`
     * with a cascade would turn "flag a popular lesson" into a 23514 in a moderator's transaction.
     * This assertion is what would fail if somebody added it.
     */
    await client.query(`SAVEPOINT flagged_edge`);
    await client.query(
      `INSERT INTO case_study_related_lesson (id, case_study_id, position, related_public_slug)
       VALUES ($1, $2, 1, $3)`,
      [randomUUID(), caseStudyId, publicSlug],
    );
    await expectAccepted(
      "flagging a case study that others link to is accepted (visibility is not in the key)",
      `UPDATE case_study SET moderation_state = 'flagged' WHERE id = $1`,
      [caseStudyId],
    );
    await client.query(`ROLLBACK TO SAVEPOINT flagged_edge`);

    console.log("\n--- 9. what the database deliberately does NOT enforce ---");

    /**
     * ⚠️ WRITTEN DOWN SO NOBODY ASSUMES THE TABLE IS HOLDING IT. A CHECK cannot assert the EXISTENCE
     * of a sibling row, so "a public-sources case study needs at least one source" lives in
     * `case-study-submission.schemas.ts`. This assertion passes when the database accepts the row —
     * which is the honest state of affairs, not a defect.
     */
    await expectAccepted(
      "a public-sources case study with NO source is accepted by the database (the gate holds this rule)",
      `UPDATE case_study SET summary = $2 WHERE id = $1`,
      [accountAuthoredId, `${SUMMARY} Still sourceless.`],
    );
    check(
      "the ≥1-source rule is the write gate's, not the table's",
      true,
      "a CHECK cannot count sibling rows — see case-study-submission.schemas.ts",
    );

    console.log("\n--- 10. the cascade ---");

    await client.query(`SAVEPOINT cascade_probe`);
    await client.query(`DELETE FROM case_study WHERE id = $1`, [caseStudyId]);
    const survivors = await client.query<{ table_name: string; remaining: string }>(
      `SELECT 'company' AS table_name, count(*)::text AS remaining
         FROM case_study_evidence_company WHERE case_study_id = $1
       UNION ALL SELECT 'step', count(*)::text FROM case_study_action_step WHERE case_study_id = $1
       UNION ALL SELECT 'metric', count(*)::text FROM case_study_outcome_metric WHERE case_study_id = $1
       UNION ALL SELECT 'source', count(*)::text FROM case_study_source WHERE case_study_id = $1
       UNION ALL SELECT 'related', count(*)::text FROM case_study_related_lesson WHERE case_study_id = $1`,
      [caseStudyId],
    );
    const orphans = survivors.rows.filter((row) => row.remaining !== "0");
    check(
      "deleting a case study cascades to every child table",
      orphans.length === 0,
      orphans.length === 0
        ? "no orphans in five child tables"
        : `orphans remain in ${orphans.map((row) => row.table_name).join(", ")}`,
    );
    await client.query(`ROLLBACK TO SAVEPOINT cascade_probe`);
  } finally {
    // THE ROLLBACK IS THE CLEANUP, and it cannot be skipped by a failed assertion or a throw.
    await client.query("ROLLBACK");
    client.release();
    console.log("\n  (transaction rolled back — nothing was persisted)");
  }

  const failureCount = assertions.filter((assertion) => !assertion.passed).length;
  console.log(
    failureCount === 0
      ? `\nAll ${String(assertions.length)} case-study constraint assertions passed.`
      : `\n${String(failureCount)} of ${String(assertions.length)} case-study constraint assertions FAILED.`,
  );
  if (failureCount > 0) process.exitCode = 1;
}

main()
  .then(async () => {
    await pool.end();
    return undefined;
  })
  .catch(async (error: unknown) => {
    console.error("Case study constraint verification failed to run:", error);
    await pool.end();
    process.exit(1);
  });
