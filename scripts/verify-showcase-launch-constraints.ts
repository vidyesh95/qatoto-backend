/**
 * Proves the showcase-launch tables' constraints against a REAL database.
 *
 *   pnpm db:verify-showcase-launch-constraints
 *
 * WHY THIS EXISTS SEPARATELY FROM THE VITEST SUITE. That suite mocks `#src/db/index.js` wholesale,
 * so no test in this repository can prove anything about Postgres. Every claim below is a claim
 * about the DATABASE — a CHECK, a generated column, a partial unique index, a foreign key's
 * disposition — and the only way to prove one is to attempt the write and watch it be refused.
 * A guarantee nobody has seen fire is a guarantee nobody should trust.
 *
 * ⚠️ THIS ARM WENT UNPROVEN LONGER THAN THE OTHER THREE. `BLUEPRINTS_BACKEND_STRUCTURE.md` §7
 * carried a standing warning that neither `showcase_launch` nor the hero table had a script, and
 * the first thing writing one turned up was `showcase_launch_tags_ck` accepting a NULL array
 * element — a public chip with no label. That is the argument for the file in one sentence.
 *
 * SIX OF THESE INVARIANTS EXIST ONLY IN SQL, and they are why the file is worth its length:
 *
 *   THE GENERATED TITLE AND ITS PARTIAL INDEX. `title_normalized` is `GENERATED ALWAYS`, and the
 *       service's duplicate pre-check runs THE SAME EXPRESSION IN SQL rather than a JavaScript
 *       copy, because POSIX `[[:space:]]` and `\s` disagree. That pre-check is also a read that
 *       races; only the index refuses the second concurrent submit. Both halves are asserted, in
 *       both directions across the two states the predicate spans — plus a probe that writing the
 *       generated column directly is refused, which is the only proof it is generated at all.
 *
 *   `showcase_launch_decision_ck`. Five biconditionals over five columns. `decideShowcaseLaunch`
 *       satisfies it branch by branch; no TypeScript expression STATES it, so a second writer
 *       would not inherit the branches.
 *
 *   THE TEAM HANDLE'S ASCII PREMISE. `handle_normalized` is `lower(handle)`, and the schema says
 *       `lower()` equals `toLowerCase()` ONLY BECAUSE the CHECK admits ASCII alone. Nothing but a
 *       probe on a non-ASCII handle proves the premise the JavaScript duplicate rule rests on.
 *
 *   THE BLUR CHECK'S `chr(59)`. drizzle-kit cuts a CHECK body at its first literal `;`, so the
 *       natural spelling generated a truncated, unterminated statement. If that ever ships
 *       truncated the constraint is ABSENT from the database while the schema file still reads
 *       correct. Only a write can tell the difference. Both arms are probed.
 *
 *   THE STATS SIDECAR IS `integer`, NOT `bigint`. `2147483648` must be refused with 22003 rather
 *       than 23514 — a different mechanism entirely. node-postgres hands `int8` back as a STRING,
 *       so a bigint behind a `sql<number>` projection would be a type that lies about its value.
 *
 *   TWO OPPOSITE FOREIGN-KEY DISPOSITIONS ON ONE TABLE. `author_user_id` is `cascade` and
 *       `reviewed_by_user_id` is `restrict`. Both are one option away from each other, and
 *       `db:verify-anonymization-coverage` can see that the keys exist but not which direction was
 *       intended.
 *
 * ⚠️ TWO RULES ARE DELIBERATELY *NOT* ENFORCED BY THE DATABASE, and there are assertions recording
 * that: the five-minute launch-date skew window lives in the write gate, and the write-up's
 * image-count, markup-length and nesting-depth limits live in the Markdown parser. A CHECK cannot
 * parse Markdown. Writing the absence down is what stops somebody assuming the table holds it.
 *
 * EVERYTHING RUNS INSIDE ONE TRANSACTION THAT IS ALWAYS ROLLED BACK. That is why there is no
 * cleanup code: the rollback is the cleanup, and it cannot be skipped by a failed assertion.
 *
 * Exits non-zero on any failed assertion.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";

import { pool } from "#src/db/index.js";
import { SHOWCASE_LAUNCH_RESERVED_SLUGS } from "#src/db/schema.js";

const PG_CHECK_VIOLATION = "23514";
const PG_UNIQUE_VIOLATION = "23505";
const PG_FOREIGN_KEY_VIOLATION = "23503";
const PG_NUMERIC_OUT_OF_RANGE = "22003";
const PG_GENERATED_COLUMN_WRITE = "428C9";

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

const TAGLINE = "A disposable launch for the verifier";
const SUMMARY =
  "A disposable showcase launch used to prove the constraints, long enough to clear the forty-character floor.";
const HEADING_IMAGE_URL = "https://res.cloudinary.com/demo/image/upload/v1/verify-heading.avif";
const BLUR_PREFIX = "data:image/webp;base64,";

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

  /**
   * The columns a launch cannot be inserted without. `$8` is the moderation state, `$9` the public
   * slug, `$10` the reviewer and `$11` the review time — the four the decision CHECK binds
   * together, parameterised so every arm of it can be walked.
   */
  const INSERT_LAUNCH = `
    INSERT INTO showcase_launch (
      id, author_user_id, title, tagline, summary, launched_at, difficulty,
      accepted_launch_statement_ids, heading_image_url, heading_image_public_id,
      moderation_state, public_slug, reviewed_by_user_id, reviewed_at, moderator_note)
    VALUES (
      $1, $2, $3, $4, $5, now(), 'intermediate',
      ARRAY['built_it_ourselves', 'results_are_our_own']::text[], $6, $7,
      $8, $9, $10, $11, $12)`;

  try {
    await client.query("BEGIN");

    // A real account to own the probe rows. `author_user_id` is NOT NULL with a real FK, so the
    // suite cannot run against an invented id — and the cascade probe needs a user it may delete.
    const authorId = randomUUID();
    const reviewerId = randomUUID();
    await client.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1, 'Showcase Verifier', $2, true, now(), now()),
              ($3, 'Showcase Reviewer', $4, true, now(), now())`,
      [
        authorId,
        `showcase-verify-${suffix}@example.test`,
        reviewerId,
        `showcase-review-${suffix}@example.test`,
      ],
    );

    function launchParameters(overrides: {
      readonly id?: string;
      readonly title?: string;
      readonly tagline?: string;
      readonly summary?: string;
      readonly headingImageUrl?: string;
      readonly headingImagePublicId?: string;
      readonly moderationState?: string;
      readonly publicSlug?: string | null;
      readonly reviewedByUserId?: string | null;
      readonly reviewedAt?: string | null;
      readonly moderatorNote?: string | null;
    }): readonly unknown[] {
      return [
        overrides.id ?? randomUUID(),
        authorId,
        overrides.title ?? `Verifier launch ${randomUUID().slice(0, 8)}`,
        overrides.tagline ?? TAGLINE,
        overrides.summary ?? SUMMARY,
        overrides.headingImageUrl ?? HEADING_IMAGE_URL,
        overrides.headingImagePublicId ?? `verify/heading-${randomUUID().slice(0, 8)}`,
        overrides.moderationState ?? "pending_review",
        overrides.publicSlug ?? null,
        overrides.reviewedByUserId ?? null,
        overrides.reviewedAt ?? null,
        overrides.moderatorNote ?? null,
      ];
    }

    console.log("\n--- 1. identity, the generated title and the live-title index ---");

    const pendingId = randomUUID();
    const pendingTitle = `The verifier launch ${suffix}`;
    await client.query(INSERT_LAUNCH, [
      ...launchParameters({ id: pendingId, title: pendingTitle }),
    ]);
    check("a pending launch inserts with no slug and no reviewer", true, pendingTitle);

    const publishedId = randomUUID();
    const publishedTitle = `A published verifier launch ${suffix}`;
    const publishedSlug = `verify-showcase-${suffix}`;
    await client.query(INSERT_LAUNCH, [
      ...launchParameters({
        id: publishedId,
        title: publishedTitle,
        moderationState: "published",
        publicSlug: publishedSlug,
        reviewedByUserId: reviewerId,
        reviewedAt: new Date().toISOString(),
      }),
    ]);
    check(
      "a published launch inserts with a slug, a reviewer and a review time",
      true,
      publishedSlug,
    );

    await expectRefused(
      "a duplicate public slug is refused (showcase_launch_public_slug_unique)",
      PG_UNIQUE_VIOLATION,
      INSERT_LAUNCH,
      launchParameters({
        moderationState: "published",
        publicSlug: publishedSlug,
        reviewedByUserId: reviewerId,
        reviewedAt: new Date().toISOString(),
      }),
    );

    await expectRefused(
      "a duplicate heading image public id is refused (showcase_launch_heading_image_public_id_unique)",
      PG_UNIQUE_VIOLATION,
      `INSERT INTO showcase_launch (
         id, author_user_id, title, tagline, summary, launched_at, difficulty,
         accepted_launch_statement_ids, heading_image_url, heading_image_public_id, moderation_state)
       SELECT $1, author_user_id, $2, tagline, summary, launched_at, difficulty,
              accepted_launch_statement_ids, heading_image_url, heading_image_public_id, 'pending_review'
         FROM showcase_launch WHERE id = $3`,
      [randomUUID(), `Another launch ${suffix}`, pendingId],
    );

    // ⚠️ ONE PROBE, TWO GUARANTEES: that `title_normalized` really collapses case AND internal
    // whitespace, and that the index really refuses the result. A JavaScript copy of the
    // expression would pass the first and say nothing about the second.
    await expectRefused(
      "a title differing only in case and inner spacing is refused (showcase_launch_title_live_uidx)",
      PG_UNIQUE_VIOLATION,
      INSERT_LAUNCH,
      launchParameters({ title: `  THE   VERIFIER    LAUNCH   ${suffix.toUpperCase()}  ` }),
    );

    await expectRefused(
      "a pending launch cannot take a published launch's title",
      PG_UNIQUE_VIOLATION,
      INSERT_LAUNCH,
      launchParameters({ title: publishedTitle }),
    );

    // ⚠️ THE OTHER DIRECTION. The predicate spans TWO states, so "taken" has to be walked both
    // ways — a one-directional proof would miss a predicate narrowed to one of them.
    await expectRefused(
      "a published launch cannot take a pending launch's title",
      PG_UNIQUE_VIOLATION,
      INSERT_LAUNCH,
      launchParameters({
        title: pendingTitle,
        moderationState: "published",
        publicSlug: `verify-showcase-other-${suffix}`,
        reviewedByUserId: reviewerId,
        reviewedAt: new Date().toISOString(),
      }),
    );

    await client.query(`SAVEPOINT rejected_title`);
    // ⚠️ A REJECTION IS FOUR COLUMNS, NOT ONE. `showcase_launch_decision_ck` binds the state to the
    // reviewer, the review time and the note all at once, so setting the state alone is refused —
    // which is exactly the property section 4 walks arm by arm.
    await client.query(
      `UPDATE showcase_launch
          SET moderation_state = 'rejected', public_slug = NULL,
              reviewed_by_user_id = $2, reviewed_at = now(),
              moderator_note = 'Sent back by the verifier.'
        WHERE id = $1`,
      [pendingId, reviewerId],
    );
    await expectAccepted(
      "a rejection frees the title for a fresh submission",
      INSERT_LAUNCH,
      launchParameters({ title: pendingTitle }),
    );
    await client.query(`ROLLBACK TO SAVEPOINT rejected_title`);

    // ⚠️ THE ONLY PROOF THE COLUMN IS GENERATED AT ALL. A trigger-filled column would accept this
    // write and every assertion above would still pass.
    await expectRefused(
      "writing title_normalized directly is refused — the column is GENERATED ALWAYS",
      PG_GENERATED_COLUMN_WRITE,
      `UPDATE showcase_launch SET title_normalized = 'hand written' WHERE id = $1`,
      [pendingId],
    );

    console.log("\n--- 2. the public slug, and the list it reserves ---");

    for (const [label, slug] of [
      ["a reserved public slug is refused", SHOWCASE_LAUNCH_RESERVED_SLUGS[0]],
      ["an uppercase public slug is refused", "Verify-Showcase"],
      ["a two-character public slug is refused", "ab"],
      ["a public slug with a trailing dash is refused", "verify-showcase-"],
    ] as const) {
      await expectRefused(
        label,
        PG_CHECK_VIOLATION,
        INSERT_LAUNCH,
        launchParameters({
          moderationState: "published",
          publicSlug: slug,
          reviewedByUserId: reviewerId,
          reviewedAt: new Date().toISOString(),
        }),
      );
    }

    // ⚠️ DERIVED FROM THE EXPORTED LIST, NOT RETYPED. A new reserved word added in TypeScript but
    // not in the CHECK is a slug the router shadows and the database still mints.
    const constraintDefinition = await client.query<{ readonly definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint WHERE conname = 'showcase_launch_public_slug_ck'`,
    );
    const slugCheckBody = constraintDefinition.rows[0]?.definition ?? "";
    const missingReservations = SHOWCASE_LAUNCH_RESERVED_SLUGS.filter(
      (reserved) => !slugCheckBody.includes(`'${reserved}'`),
    );
    check(
      "showcase_launch_public_slug_ck reserves every slug SHOWCASE_LAUNCH_RESERVED_SLUGS does",
      missingReservations.length === 0,
      missingReservations.length === 0
        ? `all ${String(SHOWCASE_LAUNCH_RESERVED_SLUGS.length)} reserved words are in the CHECK`
        : `the CHECK is missing ${missingReservations.join(", ")}`,
    );

    console.log("\n--- 3. the three states this arm can reach ---");

    // ⚠️ `flagged` AND `quarantined` ARE REFUSED BY DECISION, NOT BY OVERSIGHT. The teardown and
    // case-study arms admit `flagged`; this one does not, and no flag/quarantine/restore verb is
    // built for showcases. If that changes, these two assertions are the ones to edit — which is
    // the point of asserting them rather than leaving the absence implicit.
    for (const [label, state] of [
      ["a draft launch is refused — a draft lives in the browser", "draft"],
      ["a flagged launch is refused — this arm has no flag verb", "flagged"],
      ["a quarantined launch is refused — this arm has no files to withhold", "quarantined"],
      ["a removed launch is refused", "removed"],
    ] as const) {
      await expectRefused(
        label,
        PG_CHECK_VIOLATION,
        INSERT_LAUNCH,
        launchParameters({ moderationState: state }),
      );
    }

    console.log("\n--- 4. the decision columns move together ---");

    const reviewTime = new Date().toISOString();
    await expectRefused(
      "a pending launch carrying a review time is refused",
      PG_CHECK_VIOLATION,
      INSERT_LAUNCH,
      launchParameters({ reviewedAt: reviewTime, reviewedByUserId: reviewerId }),
    );
    await expectRefused(
      "a reviewer with no review time is refused",
      PG_CHECK_VIOLATION,
      INSERT_LAUNCH,
      launchParameters({
        moderationState: "published",
        publicSlug: `verify-a-${suffix}`,
        reviewedByUserId: reviewerId,
      }),
    );
    await expectRefused(
      "a review time with no reviewer is refused",
      PG_CHECK_VIOLATION,
      INSERT_LAUNCH,
      launchParameters({
        moderationState: "published",
        publicSlug: `verify-b-${suffix}`,
        reviewedAt: reviewTime,
      }),
    );
    await expectRefused(
      "a pending launch carrying a moderator note is refused",
      PG_CHECK_VIOLATION,
      INSERT_LAUNCH,
      launchParameters({ moderatorNote: "Premature." }),
    );
    await expectRefused(
      "a rejection with no moderator note is refused — the note is the maker's whole remedy",
      PG_CHECK_VIOLATION,
      INSERT_LAUNCH,
      launchParameters({
        moderationState: "rejected",
        reviewedByUserId: reviewerId,
        reviewedAt: reviewTime,
      }),
    );
    await expectRefused(
      "a published launch with no public slug is refused",
      PG_CHECK_VIOLATION,
      INSERT_LAUNCH,
      launchParameters({
        moderationState: "published",
        reviewedByUserId: reviewerId,
        reviewedAt: reviewTime,
      }),
    );
    await expectRefused(
      "a rejected launch carrying a public slug is refused",
      PG_CHECK_VIOLATION,
      INSERT_LAUNCH,
      launchParameters({
        moderationState: "rejected",
        publicSlug: `verify-c-${suffix}`,
        reviewedByUserId: reviewerId,
        reviewedAt: reviewTime,
        moderatorNote: "Sent back.",
      }),
    );
    // ⚠️ THE EXACT INVERSE OF THE CASE-STUDY SCRIPT, WHICH ASSERTS THE PERMISSION. That arm seeds
    // ten published rows nobody reviewed, so its CHECK must admit a reviewer-less publish; this
    // arm has no seed, so every published launch was decided by a human. The asymmetry is
    // load-bearing and only an assertion on each side records it.
    await expectRefused(
      "a published launch with no reviewer is refused — unlike the case-study arm, which seeds ten",
      PG_CHECK_VIOLATION,
      INSERT_LAUNCH,
      launchParameters({
        moderationState: "published",
        publicSlug: `verify-d-${suffix}`,
      }),
    );

    console.log("\n--- 5. text lengths, the tag ceiling and the NULL element guard ---");

    for (const [label, overrides] of [
      ["a seven-character title is refused", { title: "Seven01" }],
      ["a 121-character title is refused", { title: "T".repeat(121) }],
      ["a nine-character tagline is refused", { tagline: "Nine char" }],
      ["an 81-character tagline is refused", { tagline: "T".repeat(81) }],
      ["a 39-character summary is refused", { summary: "S".repeat(39) }],
      ["a 1001-character summary is refused", { summary: "S".repeat(1001) }],
    ] as const) {
      await expectRefused(label, PG_CHECK_VIOLATION, INSERT_LAUNCH, launchParameters(overrides));
    }

    await expectRefused(
      "an empty-string write-up is refused — NULL means none, never the empty string",
      PG_CHECK_VIOLATION,
      `INSERT INTO showcase_launch (
         id, author_user_id, title, tagline, summary, write_up, launched_at, difficulty,
         accepted_launch_statement_ids, heading_image_url, heading_image_public_id, moderation_state)
       VALUES ($1, $2, $3, $4, $5, '', now(), 'intermediate',
               ARRAY['built_it_ourselves','results_are_our_own']::text[], $6, $7, 'pending_review')`,
      [
        randomUUID(),
        authorId,
        `Empty write-up ${suffix}`,
        TAGLINE,
        SUMMARY,
        HEADING_IMAGE_URL,
        `verify/heading-empty-${suffix}`,
      ],
    );

    await expectRefused(
      "an eleventh tag is refused (showcase_launch_tags_ck)",
      PG_CHECK_VIOLATION,
      `INSERT INTO showcase_launch (
         id, author_user_id, title, tagline, summary, tags, launched_at, difficulty,
         accepted_launch_statement_ids, heading_image_url, heading_image_public_id, moderation_state)
       VALUES ($1, $2, $3, $4, $5,
               ARRAY['a','b','c','d','e','f','g','h','i','j','k']::text[], now(), 'intermediate',
               ARRAY['built_it_ourselves','results_are_our_own']::text[], $6, $7, 'pending_review')`,
      [
        randomUUID(),
        authorId,
        `Eleven tags ${suffix}`,
        TAGLINE,
        SUMMARY,
        HEADING_IMAGE_URL,
        `verify/heading-tags-${suffix}`,
      ],
    );

    // ⚠️ THE ASSERTION THIS FILE WAS MOST WORTH WRITING FOR. `cardinality(tags) <= 10` tests no
    // membership at all, so this row STORED until the guard landed. A tag renders as a public chip
    // and is a facet key; a NULL element is a chip with no label and a facet nothing can select.
    await expectRefused(
      "a NULL tag element is refused (showcase_launch_tags_ck) — this used to store",
      PG_CHECK_VIOLATION,
      `INSERT INTO showcase_launch (
         id, author_user_id, title, tagline, summary, tags, launched_at, difficulty,
         accepted_launch_statement_ids, heading_image_url, heading_image_public_id, moderation_state)
       VALUES ($1, $2, $3, $4, $5, ARRAY['solar', NULL]::text[], now(), 'intermediate',
               ARRAY['built_it_ourselves','results_are_our_own']::text[], $6, $7, 'pending_review')`,
      [
        randomUUID(),
        authorId,
        `Null tag ${suffix}`,
        TAGLINE,
        SUMMARY,
        HEADING_IMAGE_URL,
        `verify/heading-null-tag-${suffix}`,
      ],
    );

    console.log("\n--- 6. the statement pair ---");

    for (const [label, statements] of [
      ["one statement only is refused", `ARRAY['built_it_ourselves']::text[]`],
      [
        "an unknown third statement is refused",
        `ARRAY['built_it_ourselves','results_are_our_own','we_made_it_up']::text[]`,
      ],
      [
        "the same statement ticked twice is refused — `@>` is containment, not set equality",
        `ARRAY['built_it_ourselves','built_it_ourselves']::text[]`,
      ],
    ] as const) {
      await expectRefused(
        label,
        PG_CHECK_VIOLATION,
        `INSERT INTO showcase_launch (
           id, author_user_id, title, tagline, summary, launched_at, difficulty,
           accepted_launch_statement_ids, heading_image_url, heading_image_public_id, moderation_state)
         VALUES ($1, $2, $3, $4, $5, now(), 'intermediate', ${statements}, $6, $7, 'pending_review')`,
        [
          randomUUID(),
          authorId,
          `Statements ${randomUUID().slice(0, 8)}`,
          TAGLINE,
          SUMMARY,
          HEADING_IMAGE_URL,
          `verify/heading-st-${randomUUID().slice(0, 8)}`,
        ],
      );
    }

    console.log("\n--- 7. the cost triple ---");

    const COST_INSERT = `
      INSERT INTO showcase_launch (
        id, author_user_id, title, tagline, summary, launched_at, difficulty,
        accepted_launch_statement_ids, heading_image_url, heading_image_public_id, moderation_state,
        bill_of_materials_minimum_cents, bill_of_materials_maximum_cents, bill_of_materials_currency)
      VALUES ($1, $2, $3, $4, $5, now(), 'intermediate',
              ARRAY['built_it_ourselves','results_are_our_own']::text[], $6, $7, 'pending_review',
              $8, $9, $10)`;

    function costParameters(
      minimum: number | null,
      maximum: number | null,
      currency: string | null,
    ): readonly unknown[] {
      const unique = randomUUID().slice(0, 8);
      return [
        randomUUID(),
        authorId,
        `Cost ${unique}`,
        TAGLINE,
        SUMMARY,
        HEADING_IMAGE_URL,
        `verify/heading-cost-${unique}`,
        minimum,
        maximum,
        currency,
      ];
    }

    await expectRefused(
      "an amount with no currency is refused",
      PG_CHECK_VIOLATION,
      COST_INSERT,
      costParameters(1000, 2000, null),
    );
    await expectRefused(
      "a currency with no amounts is refused",
      PG_CHECK_VIOLATION,
      COST_INSERT,
      costParameters(null, null, "USD"),
    );
    await expectRefused(
      "only the minimum set is refused",
      PG_CHECK_VIOLATION,
      COST_INSERT,
      costParameters(1000, null, "USD"),
    );
    await expectRefused(
      "a non-USD currency is refused",
      PG_CHECK_VIOLATION,
      COST_INSERT,
      costParameters(1000, 2000, "EUR"),
    );
    await expectRefused(
      "a maximum below the minimum is refused",
      PG_CHECK_VIOLATION,
      COST_INSERT,
      costParameters(2000, 1000, "USD"),
    );
    await expectRefused(
      "a negative minimum is refused",
      PG_CHECK_VIOLATION,
      COST_INSERT,
      costParameters(-1, 2000, "USD"),
    );
    await expectAccepted(
      "all three NULL is accepted — a launch need not price its bill of materials",
      COST_INSERT,
      costParameters(null, null, null),
    );

    console.log("\n--- 8. the heading image and the call to action ---");

    // ⚠️ https-ONLY HERE, UNLIKE `teardown_thumbnail_url_ck` AND `anime_hero_slide_image_url_ck`,
    // both of which accept a site-relative path because they have SEEDED populations. This arm has
    // no seed, so every heading image is an upload. Do not harmonise the three.
    await expectRefused(
      "a site-relative heading image is refused — this arm has no seeded population",
      PG_CHECK_VIOLATION,
      INSERT_LAUNCH,
      launchParameters({ headingImageUrl: "/dummy/heading.avif" }),
    );
    await expectRefused(
      "a plain-http heading image is refused",
      PG_CHECK_VIOLATION,
      INSERT_LAUNCH,
      launchParameters({ headingImageUrl: "http://res.cloudinary.com/demo/x.avif" }),
    );
    await expectRefused(
      "a heading image containing whitespace is refused",
      PG_CHECK_VIOLATION,
      INSERT_LAUNCH,
      launchParameters({ headingImageUrl: "https://res.cloudinary.com/demo/a b.avif" }),
    );
    await expectRefused(
      "a 2049-character heading image URL is refused",
      PG_CHECK_VIOLATION,
      INSERT_LAUNCH,
      launchParameters({ headingImageUrl: `https://x.test/${"a".repeat(2040)}` }),
    );

    const CTA_INSERT = `
      INSERT INTO showcase_launch (
        id, author_user_id, title, tagline, summary, launched_at, difficulty,
        accepted_launch_statement_ids, heading_image_url, heading_image_public_id, moderation_state,
        call_to_action_label, call_to_action_url)
      VALUES ($1, $2, $3, $4, $5, now(), 'intermediate',
              ARRAY['built_it_ourselves','results_are_our_own']::text[], $6, $7, 'pending_review',
              $8, $9)`;

    function ctaParameters(label: string | null, url: string | null): readonly unknown[] {
      const unique = randomUUID().slice(0, 8);
      return [
        randomUUID(),
        authorId,
        `Cta ${unique}`,
        TAGLINE,
        SUMMARY,
        HEADING_IMAGE_URL,
        `verify/heading-cta-${unique}`,
        label,
        url,
      ];
    }

    await expectRefused(
      "a call-to-action label with no URL is refused",
      PG_CHECK_VIOLATION,
      CTA_INSERT,
      ctaParameters("Back it", null),
    );
    await expectRefused(
      "a call-to-action URL with no label is refused",
      PG_CHECK_VIOLATION,
      CTA_INSERT,
      ctaParameters(null, "https://example.test/back"),
    );
    await expectRefused(
      "a plain-http call-to-action URL is refused",
      PG_CHECK_VIOLATION,
      CTA_INSERT,
      ctaParameters("Back it", "http://example.test/back"),
    );
    await expectRefused(
      "a 41-character call-to-action label is refused",
      PG_CHECK_VIOLATION,
      CTA_INSERT,
      ctaParameters("L".repeat(41), "https://example.test/back"),
    );

    console.log("\n--- 9. built_from_blueprint_slug, and what it deliberately is not ---");

    const BUILT_FROM_INSERT = `
      INSERT INTO showcase_launch (
        id, author_user_id, title, tagline, summary, launched_at, difficulty,
        accepted_launch_statement_ids, heading_image_url, heading_image_public_id, moderation_state,
        built_from_blueprint_slug)
      VALUES ($1, $2, $3, $4, $5, now(), 'intermediate',
              ARRAY['built_it_ourselves','results_are_our_own']::text[], $6, $7, 'pending_review', $8)`;

    function builtFromParameters(slug: string): readonly unknown[] {
      const unique = randomUUID().slice(0, 8);
      return [
        randomUUID(),
        authorId,
        `Built ${unique}`,
        TAGLINE,
        SUMMARY,
        HEADING_IMAGE_URL,
        `verify/heading-bf-${unique}`,
        slug,
      ];
    }

    await expectRefused(
      "an uppercase built-from slug is refused",
      PG_CHECK_VIOLATION,
      BUILT_FROM_INSERT,
      builtFromParameters("Solar-Refrigeration"),
    );
    await expectRefused(
      "a two-character built-from slug is refused",
      PG_CHECK_VIOLATION,
      BUILT_FROM_INSERT,
      builtFromParameters("ab"),
    );
    // ⚠️ FREE TEXT WITH A SLUG SHAPE, AND NO FOREIGN KEY — deliberately. A maker may name a
    // teardown that was later removed, and an FK would refuse the launch rather than let the link
    // go quietly dead. The column's own comment used to say "there is no teardown table yet",
    // which is no longer the reason; this assertion is.
    await expectAccepted(
      "a built-from slug naming no teardown is ACCEPTED — the column carries no foreign key",
      BUILT_FROM_INSERT,
      builtFromParameters(`no-such-teardown-${suffix}`),
    );

    console.log("\n--- 10. the moderator note ---");

    await expectRefused(
      "an empty-string moderator note is refused",
      PG_CHECK_VIOLATION,
      INSERT_LAUNCH,
      launchParameters({
        moderationState: "rejected",
        reviewedByUserId: reviewerId,
        reviewedAt: reviewTime,
        moderatorNote: "",
      }),
    );
    await expectRefused(
      "a 2001-character moderator note is refused",
      PG_CHECK_VIOLATION,
      INSERT_LAUNCH,
      launchParameters({
        moderationState: "rejected",
        reviewedByUserId: reviewerId,
        reviewedAt: reviewTime,
        moderatorNote: "N".repeat(2001),
      }),
    );

    console.log("\n--- 11. the team members ---");

    const TEAM_INSERT = `
      INSERT INTO showcase_launch_team_member (id, launch_id, position, display_name, handle, role)
      VALUES ($1, $2, $3, $4, $5, $6)`;

    await client.query(TEAM_INSERT, [
      randomUUID(),
      publishedId,
      0,
      "Ada Lovelace",
      `ada_${suffix}`,
      "Lead",
    ]);
    check("a team member inserts at position 0", true, `ada_${suffix}`);

    await expectRefused(
      "two members at one position are refused (showcase_launch_team_member_position_uidx)",
      PG_UNIQUE_VIOLATION,
      TEAM_INSERT,
      [randomUUID(), publishedId, 0, "Grace Hopper", `grace_${suffix}`, "Firmware"],
    );
    // ⚠️ ONE PROBE PROVING `handle_normalized` REALLY IS `lower(handle)`.
    await expectRefused(
      "two handles differing only in case are refused (showcase_launch_team_member_handle_uidx)",
      PG_UNIQUE_VIOLATION,
      TEAM_INSERT,
      [randomUUID(), publishedId, 1, "Ada Again", `ADA_${suffix.toUpperCase()}`, "Lead"],
    );
    await expectRefused(
      "position 12 is refused — a team is at most twelve people",
      PG_CHECK_VIOLATION,
      TEAM_INSERT,
      [randomUUID(), publishedId, 12, "Twelve", `twelve_${suffix}`, "Extra"],
    );
    await expectRefused("a handle containing @ is refused", PG_CHECK_VIOLATION, TEAM_INSERT, [
      randomUUID(),
      publishedId,
      2,
      "At Sign",
      `@ada_${suffix}`,
      "Lead",
    ]);
    // ⚠️ THE ASSERTION THAT MAKES THE JAVASCRIPT DUPLICATE RULE SAFE. `handle_normalized` is
    // `lower(handle)`, and `lower()` agrees with `toLowerCase()` ONLY over ASCII. The service
    // compares handles in JavaScript; this CHECK is the premise that comparison rests on.
    await expectRefused(
      "a non-ASCII handle is refused — the premise the JavaScript duplicate rule rests on",
      PG_CHECK_VIOLATION,
      TEAM_INSERT,
      [randomUUID(), publishedId, 3, "Ada", `adaİ_${suffix}`, "Lead"],
    );
    await expectRefused("an empty display name is refused", PG_CHECK_VIOLATION, TEAM_INSERT, [
      randomUUID(),
      publishedId,
      4,
      "",
      `empty_${suffix}`,
      "Lead",
    ]);
    await expectRefused("a 61-character role is refused", PG_CHECK_VIOLATION, TEAM_INSERT, [
      randomUUID(),
      publishedId,
      5,
      "Long Role",
      `role_${suffix}`,
      "R".repeat(61),
    ]);
    await expectAccepted(
      "two members sharing a display name are accepted — only the handle is unique",
      TEAM_INSERT,
      [randomUUID(), publishedId, 6, "Ada Lovelace", `ada2_${suffix}`, "Second"],
    );

    console.log("\n--- 12. the write-up images ---");

    const IMAGE_INSERT = `
      INSERT INTO showcase_launch_write_up_image (
        id, launch_id, uploaded_by_user_id, public_id, url, width_px, height_px, blur_data_url)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;

    const validBlur = `${BLUR_PREFIX}UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4H`;
    const claimedImageId = randomUUID();
    await client.query(IMAGE_INSERT, [
      claimedImageId,
      publishedId,
      authorId,
      `verify/img-${suffix}`,
      `https://res.cloudinary.com/demo/image/upload/v1/verify-${suffix}.avif`,
      1200,
      800,
      validBlur,
    ]);
    check("a claimed write-up image inserts", true, `verify/img-${suffix}`);

    // ⚠️ UNCLAIMED IS LEGAL, AND A NOT NULL "FIX" WOULD BREAK THE UPLOAD FLOW. The form uploads an
    // image the moment it is added to the write-up, which is before any launch exists.
    await expectAccepted(
      "an image with a NULL launch_id is ACCEPTED — upload happens before the launch exists",
      IMAGE_INSERT,
      [
        randomUUID(),
        null,
        authorId,
        `verify/unclaimed-${suffix}`,
        `https://res.cloudinary.com/demo/image/upload/v1/unclaimed-${suffix}.avif`,
        640,
        480,
        validBlur,
      ],
    );

    await expectRefused("a zero width is refused", PG_CHECK_VIOLATION, IMAGE_INSERT, [
      randomUUID(),
      publishedId,
      authorId,
      `verify/zero-${suffix}`,
      `https://res.cloudinary.com/demo/zero-${suffix}.avif`,
      0,
      480,
      validBlur,
    ]);
    await expectRefused("an 8193-pixel height is refused", PG_CHECK_VIOLATION, IMAGE_INSERT, [
      randomUUID(),
      publishedId,
      authorId,
      `verify/tall-${suffix}`,
      `https://res.cloudinary.com/demo/tall-${suffix}.avif`,
      640,
      8193,
      validBlur,
    ]);
    await expectRefused("a site-relative image URL is refused", PG_CHECK_VIOLATION, IMAGE_INSERT, [
      randomUUID(),
      publishedId,
      authorId,
      `verify/rel-${suffix}`,
      `/dummy/rel-${suffix}.avif`,
      640,
      480,
      validBlur,
    ]);
    await expectRefused("a duplicate image URL is refused", PG_UNIQUE_VIOLATION, IMAGE_INSERT, [
      randomUUID(),
      publishedId,
      authorId,
      `verify/dupe-url-${suffix}`,
      `https://res.cloudinary.com/demo/image/upload/v1/verify-${suffix}.avif`,
      640,
      480,
      validBlur,
    ]);
    await expectRefused(
      "a duplicate image public id is refused",
      PG_UNIQUE_VIOLATION,
      IMAGE_INSERT,
      [
        randomUUID(),
        publishedId,
        authorId,
        `verify/img-${suffix}`,
        `https://res.cloudinary.com/demo/other-${suffix}.avif`,
        640,
        480,
        validBlur,
      ],
    );
    // ⚠️ THESE TWO TOGETHER ARE WHAT PROVE THE MIGRATION DID NOT SHIP TRUNCATED. drizzle-kit cuts
    // a CHECK body at its first literal `;`, which is why the constraint is written with `chr(59)`.
    // A truncated constraint would be ABSENT while the schema file still read correct.
    await expectRefused(
      "a non-webp blur value is refused (showcase_launch_write_up_image_blur_ck)",
      PG_CHECK_VIOLATION,
      IMAGE_INSERT,
      [
        randomUUID(),
        publishedId,
        authorId,
        `verify/blur-a-${suffix}`,
        `https://res.cloudinary.com/demo/blur-a-${suffix}.avif`,
        640,
        480,
        "data:image/png;base64,iVBORw0KGgo=",
      ],
    );
    await expectRefused(
      "a blur value with a literal semicolon in its base64 tail is refused",
      PG_CHECK_VIOLATION,
      IMAGE_INSERT,
      [
        randomUUID(),
        publishedId,
        authorId,
        `verify/blur-b-${suffix}`,
        `https://res.cloudinary.com/demo/blur-b-${suffix}.avif`,
        640,
        480,
        `${BLUR_PREFIX}UklGR;hoAAABXRUJQ`,
      ],
    );

    console.log("\n--- 13. the stats sidecar ---");

    const STATS_INSERT = `
      INSERT INTO showcase_launch_stats (launch_id, view_count, like_count, upvote_count, comment_count)
      VALUES ($1, $2, $3, $4, $5)`;

    await expectAccepted("a stats row inserts for a launch", STATS_INSERT, [
      publishedId,
      10,
      3,
      4,
      2,
    ]);

    for (const [label, counts] of [
      ["a negative view count is refused", [-1, 0, 0, 0]],
      ["a negative like count is refused", [0, -1, 0, 0]],
      ["a negative upvote count is refused", [0, 0, -1, 0]],
      ["a negative comment count is refused", [0, 0, 0, -1]],
    ] as const) {
      await expectRefused(label, PG_CHECK_VIOLATION, STATS_INSERT, [publishedId, ...counts]);
    }

    // ⚠️ 22003, NOT 23514 — a DIFFERENT MECHANISM. These counters are `integer` rather than
    // `bigint` on purpose: node-postgres hands `int8` back as a STRING, so a bigint behind a
    // `sql<number>` projection would be a type that lies about its own value. The out-of-range
    // refusal is what proves the column is still int4.
    await expectRefused(
      "2147483648 is refused with 22003 — these counters are integer, not bigint",
      PG_NUMERIC_OUT_OF_RANGE,
      STATS_INSERT,
      [publishedId, 2147483648, 0, 0, 0],
    );

    await client.query(`SAVEPOINT stats_probe`);
    await client.query(STATS_INSERT, [publishedId, 1, 1, 1, 1]);
    await expectRefused(
      "a second stats row for one launch is refused (primary key)",
      PG_UNIQUE_VIOLATION,
      STATS_INSERT,
      [publishedId, 2, 2, 2, 2],
    );
    await client.query(`ROLLBACK TO SAVEPOINT stats_probe`);

    await expectRefused(
      "a stats row naming no launch is refused",
      PG_FOREIGN_KEY_VIOLATION,
      STATS_INSERT,
      [randomUUID(), 0, 0, 0, 0],
    );

    console.log("\n--- 14. the cascades, and the one restrict ---");

    await client.query(`SAVEPOINT cascade_probe`);
    await client.query(STATS_INSERT, [publishedId, 5, 5, 5, 5]);
    await client.query(`DELETE FROM showcase_launch WHERE id = $1`, [publishedId]);
    const orphans = await client.query<{ readonly table_name: string }>(
      `SELECT 'showcase_launch_team_member' AS table_name FROM showcase_launch_team_member WHERE launch_id = $1
       UNION ALL
       SELECT 'showcase_launch_stats' FROM showcase_launch_stats WHERE launch_id = $1`,
      [publishedId],
    );
    check(
      "deleting a launch leaves no orphan in its team-member or stats tables",
      orphans.rowCount === 0,
      orphans.rowCount === 0
        ? "no orphans in two child tables"
        : `orphans remain in ${orphans.rows.map((row) => row.table_name).join(", ")}`,
    );
    // ⚠️ AND THE WRITE-UP IMAGE IS THE EXCEPTION: `launch_id` is nullable and `set null` would lose
    // the asset. It cascades too, which is why the sweep only has to chase NEVER-claimed rows.
    const imageOrphans = await client.query(
      `SELECT 1 FROM showcase_launch_write_up_image WHERE id = $1`,
      [claimedImageId],
    );
    check(
      "deleting a launch also takes its claimed write-up images",
      imageOrphans.rowCount === 0,
      imageOrphans.rowCount === 0 ? "the claimed image went with the launch" : "the image survived",
    );
    await client.query(`ROLLBACK TO SAVEPOINT cascade_probe`);

    await client.query(`SAVEPOINT author_cascade`);
    await client.query(`DELETE FROM "user" WHERE id = $1`, [authorId]);
    const authorLaunches = await client.query(
      `SELECT 1 FROM showcase_launch WHERE author_user_id = $1`,
      [authorId],
    );
    check(
      "deleting the author account takes its launches (author_user_id ON DELETE cascade)",
      authorLaunches.rowCount === 0,
      authorLaunches.rowCount === 0 ? "the launches went with the account" : "launches survived",
    );
    await client.query(`ROLLBACK TO SAVEPOINT author_cascade`);

    // ⚠️ THE OPPOSITE DISPOSITION ON THE SAME TABLE. A moderation decision stays attributable for
    // as long as the launch exists — `verify-anonymization-coverage` can see that this key exists
    // but not that `restrict` rather than `set null` was the intent.
    await expectRefused(
      "deleting the reviewer account is refused (reviewed_by_user_id ON DELETE restrict)",
      PG_FOREIGN_KEY_VIOLATION,
      `DELETE FROM "user" WHERE id = $1`,
      [reviewerId],
    );

    await expectRefused(
      "an author_user_id naming nobody is refused",
      PG_FOREIGN_KEY_VIOLATION,
      `INSERT INTO showcase_launch (
         id, author_user_id, title, tagline, summary, launched_at, difficulty,
         accepted_launch_statement_ids, heading_image_url, heading_image_public_id, moderation_state)
       VALUES ($1, $2, $3, $4, $5, now(), 'intermediate',
               ARRAY['built_it_ourselves','results_are_our_own']::text[], $6, $7, 'pending_review')`,
      [
        randomUUID(),
        randomUUID(),
        `Ghost author ${suffix}`,
        TAGLINE,
        SUMMARY,
        HEADING_IMAGE_URL,
        `verify/heading-ghost-${suffix}`,
      ],
    );

    console.log("\n--- 15. what the database deliberately does NOT enforce ---");

    // ⚠️ THE SKEW WINDOW IS THE WRITE GATE'S, AND NO CHECK HOLDS IT. Writing that down is what
    // stops somebody assuming the table is holding it and relaxing the gate.
    await expectAccepted(
      "a launch date three years in the future is ACCEPTED — the skew window lives in the write gate",
      `INSERT INTO showcase_launch (
         id, author_user_id, title, tagline, summary, launched_at, difficulty,
         accepted_launch_statement_ids, heading_image_url, heading_image_public_id, moderation_state)
       VALUES ($1, $2, $3, $4, $5, now() + interval '3 years', 'intermediate',
               ARRAY['built_it_ourselves','results_are_our_own']::text[], $6, $7, 'pending_review')`,
      [
        randomUUID(),
        authorId,
        `Future launch ${suffix}`,
        TAGLINE,
        SUMMARY,
        HEADING_IMAGE_URL,
        `verify/heading-future-${suffix}`,
      ],
    );

    check(
      "the write-up's image-count, markup-length and nesting-depth limits are the gate's, not the table's",
      true,
      "a CHECK cannot parse Markdown — see showcase-write-up-nesting.ts",
    );
  } finally {
    // THE ROLLBACK IS THE CLEANUP, and it cannot be skipped by a failed assertion or a throw.
    await client.query("ROLLBACK");
    client.release();
    console.log("\n  (transaction rolled back — nothing was persisted)");
  }

  const failureCount = assertions.filter((assertion) => !assertion.passed).length;
  console.log(
    failureCount === 0
      ? `\nAll ${String(assertions.length)} showcase-launch constraint assertions passed.`
      : `\n${String(failureCount)} of ${String(assertions.length)} showcase-launch constraint assertions FAILED.`,
  );
  if (failureCount > 0) process.exitCode = 1;
}

main()
  .then(async () => {
    await pool.end();
    return undefined;
  })
  .catch(async (error: unknown) => {
    console.error("Showcase launch constraint verification failed to run:", error);
    await pool.end();
    process.exit(1);
  });
