/**
 * Proves that `text-pii-register.ts` still describes the DATABASE, and that the dispositions
 * it claims are the ones the erasure actually executes.
 *
 * ## WHY A SECOND VERIFIER
 *
 * `db:verify-anonymization-coverage` finds its candidates by walking FOREIGN KEYS into
 * `user(id)`. Personal data held as free TEXT has no key to walk, so that script cannot see it
 * and cannot go red about it. The codebase already said so about `user.bio` in five places —
 * "if that line were deleted nothing would turn red" — and the gap turned out to be far wider:
 * `mintBuyerWorkspace` copies `user.name` into three columns of an auto-provisioned
 * `commerce_organization`, and the search indexer copies it into three more on
 * `store_search_document`. Neither table has a `user` reference at all.
 *
 * ## SEVEN CHECKS, AND THE LAST TWO ARE THE ONES THAT MATTER
 *
 *   1. Every person-shaped text column Postgres reports is in the register. This is the
 *      "somebody added a `contact_name` column next year" check, and it is why
 *      `not_personal_data` is a disposition instead of a regex exclusion: a column dropped by
 *      a pattern is reasoning nobody can read or disagree with.
 *   2. Every register key still exists as a column of that table. Rot in the other direction —
 *      a rename leaves an entry that reads as coverage of something that is gone.
 *   3. Every `scrub` entry's `stepName` is a step the job actually plans, resolved against
 *      `PLANNED_ANONYMIZATION_STEP_NAMES`, which the service DERIVES from its own step list.
 *      ⚠️ THIS IS THE CHECK THAT FINALLY GIVES `user.bio` A GUARD.
 *   4. Every `covered_by_row_delete` entry names a `delete_rows` key in
 *      `ANONYMIZATION_MANIFEST` whose table either IS this table or reaches it through
 *      `ON DELETE cascade` — asked of `pg_constraint`, not asserted in prose. A disposition
 *      flipped in one register reds the other.
 *   5. Every `retain` cites a lawful basis, and every other kind carries a note. "We kept it"
 *      without a citation is the answer that loses an Art. 17 complaint.
 *   6. THE BEHAVIOURAL ONE. Seeds a probe user and the rows the tombstone steps target, runs
 *      the REAL statements (imported, not restated) plus the REAL user-scrub column values,
 *      and then asks Postgres whether the probe's name, handle or address survived in any
 *      `scrub` column. Checks 1-5 compare lists; this one proves the list is executable — that
 *      every statement parses, that no trigger rejects it, and that each CHECK-satisfying
 *      replacement really satisfies its CHECK.
 *   7. THE CONTROL, WITHOUT WHICH CHECK 6 IS HALF A TEST. A `self_declared` organization is
 *      seeded beside the auto-provisioned one and must come out UNCHANGED. "Scrub everything
 *      named after this user" would pass check 6 and destroy a real company's name.
 *
 * Read-only in effect: every write happens inside a transaction that is always rolled back.
 *
 *   pnpm db:verify-text-pii-coverage
 *
 * Exits non-zero if any guarantee is missing, so it can gate a deploy. Run it after ANY
 * migration that adds a text column that could hold a person's name.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";

import { db, pool } from "#src/db/index.js";
import { user } from "#src/db/schema.js";
import { ANONYMIZATION_MANIFEST } from "#src/modules/auth/privacy/anonymization-manifest.js";
import {
  buildAnonymizedUserColumns,
  planFreeTextSteps,
  PLANNED_ANONYMIZATION_STEP_NAMES,
} from "#src/modules/auth/privacy/anonymize-account.service.js";
import {
  parseTextPiiColumnKey,
  SCRUBBED_TEXT_COLUMN_KEYS,
  TEXT_PII_REGISTER,
} from "#src/modules/auth/privacy/text-pii-register.js";

interface CheckOutcome {
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

/**
 * ⚠️ THE PATTERN LIVES HERE AND NOWHERE ELSE, so there is exactly one definition of
 * "person-shaped" to argue with.
 *
 * Token-anchored on `_` and the string ends rather than matched as a substring: `nameplate`
 * and `filename_prefix` are not person columns, and a substring match would drown the register
 * in noise until nobody read it. It over-matches on purpose in three places — `last`, `first`
 * and `address` catch `last_error`, `first_seen` and `delivery_address_id` — because a false
 * positive costs one register line and a false negative costs an erasure.
 */
const PERSON_SHAPED_COLUMN_PATTERN =
  "(^|_)(name|handle|email|phone|avatar|image|first|last|contact|address|dob|birth)(_|$)";

/**
 * A TYPE ALIAS, NOT AN INTERFACE, and the difference is load-bearing here: `db.execute`'s
 * generic is constrained to `Record<string, unknown>`, and TypeScript infers an implicit index
 * signature for an object type alias but never for an interface.
 */
type TextColumnRow = {
  readonly table_name: string;
  readonly column_name: string;
};

/**
 * Every `text`/`varchar`/`citext` column in `public` whose NAME looks like it could hold a
 * person.
 *
 * `pg_attribute` rather than `information_schema.columns`: the latter silently omits anything
 * the current role cannot see, which would make a permissions problem look like full
 * coverage — the one direction of error this script must never make.
 */
async function readPersonShapedTextColumns(): Promise<readonly TextColumnRow[]> {
  const { rows } = await db.execute<TextColumnRow>(sql`
    SELECT c.relname AS table_name, a.attname AS column_name
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public'
      AND c.relkind = 'r'
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND format_type(a.atttypid, a.atttypmod) IN ('text', 'citext', 'character varying')
      AND a.attname ~ ${PERSON_SHAPED_COLUMN_PATTERN}
    ORDER BY c.relname, a.attname
  `);
  return rows;
}

/** Every `<table>.<column>` that exists at all, so check 2 can spot a renamed column. */
async function readEveryColumnKey(): Promise<ReadonlySet<string>> {
  const { rows } = await db.execute<TextColumnRow>(sql`
    SELECT c.relname AS table_name, a.attname AS column_name
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
  `);
  return new Set(rows.map((row) => `${row.table_name}.${row.column_name}`));
}

/**
 * Which tables a `DELETE` from a given table takes with it, following `ON DELETE cascade`
 * transitively.
 *
 * THIS IS WHAT MAKES `covered_by_row_delete` A CLAIM AND NOT A HOPE. `video_document.file_name`
 * says it is covered by `video.creator_id`; that is only true because `video_document.video_id`
 * cascades from `video`. If somebody changes that key to `restrict`, the filename starts
 * surviving erasures and this check is the only thing that would notice.
 */
async function readCascadeClosure(): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const { rows } = await db.execute<{ parent_table: string; child_table: string }>(sql`
    SELECT parent.relname AS parent_table, child.relname AS child_table
    FROM pg_constraint con
    JOIN pg_class child ON child.oid = con.conrelid
    JOIN pg_class parent ON parent.oid = con.confrelid
    JOIN pg_namespace ns ON ns.oid = child.relnamespace
    WHERE con.contype = 'f' AND con.confdeltype = 'c' AND ns.nspname = 'public'
  `);

  const childrenByParent = new Map<string, string[]>();
  for (const row of rows) {
    const children = childrenByParent.get(row.parent_table) ?? [];
    children.push(row.child_table);
    childrenByParent.set(row.parent_table, children);
  }

  const closureByTable = new Map<string, ReadonlySet<string>>();
  for (const parentTable of childrenByParent.keys()) {
    const reached = new Set<string>();
    const pending = [parentTable];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) break;
      for (const child of childrenByParent.get(current) ?? []) {
        if (reached.has(child)) continue;
        reached.add(child);
        pending.push(child);
      }
    }
    closureByTable.set(parentTable, reached);
  }
  return closureByTable;
}

function compareCoverage(
  scannedColumns: readonly TextColumnRow[],
  everyColumnKey: ReadonlySet<string>,
  cascadeClosure: ReadonlyMap<string, ReadonlySet<string>>,
): readonly CheckOutcome[] {
  // Both widened to `string`: one side comes from Postgres and the other from a
  // template-literal key type, and the job here is membership in both directions.
  const scannedKeys = new Set<string>(
    scannedColumns.map((row) => `${row.table_name}.${row.column_name}`),
  );
  const registerKeys = new Set<string>(Object.keys(TEXT_PII_REGISTER));

  const missing = [...scannedKeys].filter((key) => !registerKeys.has(key)).toSorted();
  const stale = [...registerKeys].filter((key) => !everyColumnKey.has(key)).toSorted();

  const unplannedScrubs = SCRUBBED_TEXT_COLUMN_KEYS.filter((key) => {
    const disposition = TEXT_PII_REGISTER[key];
    return (
      disposition?.kind === "scrub" &&
      !PLANNED_ANONYMIZATION_STEP_NAMES.includes(disposition.stepName)
    );
  }).toSorted();

  // A Map rather than index access: `Object.entries` hands back `string` keys and the manifest
  // is keyed on a template-literal type, so a lookup needs a structure that accepts `string`.
  const manifestByKey = new Map(Object.entries(ANONYMIZATION_MANIFEST));

  const brokenRowDeletes: string[] = [];
  for (const [key, disposition] of Object.entries(TEXT_PII_REGISTER)) {
    if (disposition.kind !== "covered_by_row_delete") continue;
    const manifestEntry = manifestByKey.get(disposition.manifestKey);
    if (manifestEntry === undefined) {
      brokenRowDeletes.push(`${key}: no manifest entry "${disposition.manifestKey}"`);
      continue;
    }
    if (manifestEntry.kind !== "delete_rows") {
      brokenRowDeletes.push(
        `${key}: "${disposition.manifestKey}" is ${manifestEntry.kind}, so no row is ever deleted`,
      );
      continue;
    }
    const { tableName: registerTable } = parseTextPiiColumnKey(key);
    const { tableName: manifestTable } = parseTextPiiColumnKey(disposition.manifestKey);
    if (registerTable === manifestTable) continue;
    if (cascadeClosure.get(manifestTable)?.has(registerTable) === true) continue;
    brokenRowDeletes.push(
      `${key}: "${manifestTable}" does not reach "${registerTable}" by ON DELETE cascade`,
    );
  }

  const unexplained = Object.entries(TEXT_PII_REGISTER)
    .filter(([, disposition]) =>
      disposition.kind === "retain"
        ? disposition.lawfulBasis.trim().length === 0 || disposition.note.trim().length === 0
        : disposition.note.trim().length === 0,
    )
    .map(([key]) => key)
    .toSorted();

  return [
    {
      label: "every person-shaped text column is in the register",
      passed: missing.length === 0,
      detail:
        missing.length === 0
          ? `all ${String(scannedKeys.size)} scanned columns classified (${String(registerKeys.size)} entries total)`
          : `UNCLASSIFIED free text that could survive an erasure: ${missing.join(", ")}`,
    },
    {
      label: "no register entry names a column that is gone",
      passed: stale.length === 0,
      detail:
        stale.length === 0
          ? `all ${String(registerKeys.size)} entries still exist in Postgres`
          : `stale entries reading as coverage of nothing: ${stale.join(", ")}`,
    },
    {
      label: "every scrub names a step the job plans",
      passed: unplannedScrubs.length === 0,
      detail:
        unplannedScrubs.length === 0
          ? `all ${String(SCRUBBED_TEXT_COLUMN_KEYS.length)} scrub entries resolve to a planned step`
          : `claimed as scrubbed by a step that does not exist: ${unplannedScrubs.join(", ")}`,
    },
    {
      label: "every covered_by_row_delete really deletes the row",
      passed: brokenRowDeletes.length === 0,
      detail:
        brokenRowDeletes.length === 0
          ? "each one resolves to a delete_rows manifest key that reaches the table"
          : brokenRowDeletes.join(" | "),
    },
    {
      label: "every disposition carries its reasoning",
      passed: unexplained.length === 0,
      detail:
        unexplained.length === 0
          ? "no retention without a lawful basis, no classification without a note"
          : `unexplained: ${unexplained.join(", ")}`,
    },
  ];
}

/** A sentinel that rolls the probe transaction back without reporting as a failure. */
const ROLLBACK_SENTINEL = "text-pii-coverage: rolling back the probe transaction";

interface ProbeIdentity {
  readonly userId: string;
  readonly name: string;
  readonly handle: string;
  readonly email: string;
  /**
   * ⚠️ DELIBERATELY NOT DERIVED FROM `name`, and getting this wrong made checks 6 and 7
   * contradict each other: check 6 demands the probe's name appear in no scrubbed column, and
   * check 7 demands the `self_declared` row keep its name. A control company named after the
   * person could not satisfy both — and a real declared company is not named after its owner
   * anyway, which is the whole reason `provisioning_origin` is the scope.
   */
  readonly declaredCompanyName: string;
}

/**
 * Checks 6 and 7. Seeds the rows the tombstone steps target, runs the REAL statements, and asks
 * Postgres what survived.
 *
 * THE PROBE'S NAME IS THE ASSERTION. Every seeded row carries one distinctive string, so
 * "did the scrub work" becomes "does this string appear anywhere it should not" — which also
 * catches a step that ran against the wrong column, or one whose WHERE matched nothing.
 */
async function checkStepsAreExecutable(): Promise<readonly CheckOutcome[]> {
  const outcomes: CheckOutcome[] = [];
  const probeSuffix = randomUUID();
  const probe: ProbeIdentity = {
    userId: `text-pii-probe-${probeSuffix}`,
    name: `Zarquon Probe ${probeSuffix.slice(0, 8)}`,
    handle: `zarquonprobe${probeSuffix.slice(0, 8)}`,
    email: `text-pii-probe-${probeSuffix}@coverage.invalid`,
    declaredCompanyName: `Norrfall Bracketworks ${probeSuffix.slice(0, 8)}`,
  };

  try {
    await db.transaction(async (tx) => {
      await seedProbeRows(tx, probe);

      const stepFailures: string[] = [];
      for (const step of planFreeTextSteps(probe.userId)) {
        /**
         * ⚠️ A SAVEPOINT PER STEP, WITHOUT WHICH THIS SCRIPT IS USELESS WHEN IT MATTERS. A
         * failing statement aborts the whole transaction, after which Postgres answers every
         * later statement with `25P02 current transaction is aborted` — so the first genuinely
         * broken step would produce one true error and a cascade of fabricated ones, and the
         * surviving-text assertions below would report nothing at all.
         * `verify-anonymization-coverage.ts` brackets its probes the same way, after the same bug.
         */
        await tx
          .transaction(async (savepoint) => {
            try {
              await savepoint.execute(step.applySql);
            } catch (error) {
              stepFailures.push(
                `${step.stepName}: ${error instanceof Error ? error.message : String(error)}`,
              );
              throw error;
            }
          })
          .catch(() => undefined);
      }

      await tx
        .transaction(async (savepoint) => {
          await savepoint
            .update(user)
            .set(buildAnonymizedUserColumns(probe.userId))
            .where(eq(user.id, probe.userId));
        })
        .catch((error: unknown) => {
          stepFailures.push(
            `scrub_user: ${error instanceof Error ? error.message : String(error)}`,
          );
        });

      outcomes.push({
        label: "every free-text step executes",
        passed: stepFailures.length === 0,
        detail:
          stepFailures.length === 0
            ? `${String(planFreeTextSteps(probe.userId).length)} tombstone steps and the user scrub all legal`
            : `statements the erasure would fail on: ${stepFailures.join(" | ")}`,
      });

      outcomes.push(await checkNoScrubColumnHoldsTheProbe(tx, probe));
      outcomes.push(await checkSelfDeclaredOrganizationSurvived(tx, probe));

      throw new Error(ROLLBACK_SENTINEL);
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ROLLBACK_SENTINEL) throw error;
  }

  return outcomes;
}

type ProbeTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The rows each tombstone step needs in order to be more than a syntax check.
 *
 * THE VIDEO AND THE LAUNCH BELONG TO SOMEBODY ELSE, which is the only configuration that
 * exercises these steps at all: a video or launch the probe OWNED would be deleted outright by
 * the manifest's `delete_rows`, and the free-text credit on it would go with it. What survives
 * an erasure today is the probe's name on another person's row.
 */
async function seedProbeRows(tx: ProbeTransaction, probe: ProbeIdentity): Promise<void> {
  const otherUserId = `text-pii-probe-other-${randomUUID()}`;
  const autoOrganizationId = `text-pii-auto-${randomUUID()}`;
  const selfDeclaredOrganizationId = `text-pii-self-${randomUUID()}`;
  const videoId = `text-pii-video-${randomUUID()}`;
  const launchId = `text-pii-launch-${randomUUID()}`;

  await tx.execute(sql`
    INSERT INTO "user" (id, name, email, email_verified, handle, bio, location_label,
                        is_channel_listed, deactivated_at, created_at, updated_at)
    VALUES (${probe.userId}, ${probe.name}, ${probe.email}, false, ${probe.handle},
            ${`A bio mentioning ${probe.name}.`}, ${probe.name}, true, now(), now(), now()),
           (${otherUserId}, 'Coverage probe owner', ${`${otherUserId}@coverage.invalid`}, false,
            NULL, NULL, NULL, false, NULL, now(), now())`);

  /**
   * TWO ORGANIZATIONS, DIFFERING ONLY IN `provisioning_origin`. The auto-provisioned one is the
   * shell `mintBuyerWorkspace` mints, holding the person's name in all three name columns; the
   * self_declared one is a real company and is check 7's control.
   *
   * `commerce_organization_auto_provisioned_owner_uidx` is why only one of them can be
   * `auto_provisioned` for the same owner — which is also why the scrub's fixed literal is safe.
   */
  await tx.execute(sql`
    INSERT INTO commerce_organization
      (id, slug, legal_name, normalized_legal_name, display_name, organization_type,
       trade_state, visibility, provisioning_origin, created_by_user_id, created_at, updated_at)
    VALUES (${autoOrganizationId}, ${`buyer-${probeSlug(autoOrganizationId)}`},
            ${probe.name}, ${probe.name.toLowerCase()}, ${probe.name},
            'sole_proprietor', 'pending', 'private', 'auto_provisioned',
            ${probe.userId}, now(), now()),
           (${selfDeclaredOrganizationId}, ${`seller-${probeSlug(selfDeclaredOrganizationId)}`},
            ${probe.declaredCompanyName}, ${probe.declaredCompanyName.toLowerCase()},
            ${probe.declaredCompanyName},
            'company', 'pending', 'private', 'self_declared',
            ${probe.userId}, now(), now())`);

  /**
   * THE ORGANIZATION SEARCH DOCUMENT, built the way `refreshOrganizationSearchDocument` builds
   * it: `title` and `organization_display_name` are the display name, and `search_text` is the
   * display name plus the legal name. A category term is appended so check 6 can also prove the
   * `search_text` replace is TARGETED — a wholesale overwrite would lose it.
   */
  await tx.execute(sql`
    INSERT INTO store_search_document
      (id, document_kind, entity_id, public_slug, title, organization_id, organization_slug,
       organization_display_name, search_text, is_eligible, created_at, updated_at)
    VALUES (${`text-pii-doc-${randomUUID()}`}, 'organization', ${autoOrganizationId},
            ${`buyer-${probeSlug(autoOrganizationId)}`}, ${probe.name}, ${autoOrganizationId},
            ${`buyer-${probeSlug(autoOrganizationId)}`}, ${probe.name},
            ${`${probe.name} ${probe.name} precision gaskets`}, false, now(), now())`);

  /**
   * `video_source` defaults to `'youtube'`, and `video_source_id_ck` then demands an 11-character
   * `youtube_video_id` matching `^[A-Za-z0-9_-]{11}$` — the charset that closes SSRF at the
   * storage layer. A fixed literal is fine; nothing here ever resolves it.
   */
  await tx.execute(sql`
    INSERT INTO video (id, creator_id, title, youtube_video_id)
    VALUES (${videoId}, ${otherUserId}, 'Coverage probe video', 'covProbe001')`);

  /**
   * TWO COLLABORATOR ROWS, because the step has two arms and one row could only prove one. The
   * first is a linked collaborator; the second is an invite that was NEVER ACCEPTED, so its
   * `user_id` is NULL and no foreign-key walk in this codebase can see it.
   */
  await tx.execute(sql`
    INSERT INTO video_collaborator (id, video_id, invited_email, user_id, status)
    VALUES (${`text-pii-collab-${randomUUID()}`}, ${videoId}, ${probe.email}, ${probe.userId}, 'accepted')`);
  await tx.execute(sql`
    INSERT INTO video (id, creator_id, title, youtube_video_id)
    VALUES (${`${videoId}-b`}, ${otherUserId}, 'Coverage probe video B', 'covProbe002')`);
  await tx.execute(sql`
    INSERT INTO video_collaborator (id, video_id, invited_email, user_id, status)
    VALUES (${`text-pii-collab-${randomUUID()}`}, ${`${videoId}-b`}, ${probe.email}, NULL, 'invited')`);

  await tx.execute(sql`
    INSERT INTO video_team_member (id, video_id, member_name, linked_user_id, position)
    VALUES (${`text-pii-credit-${randomUUID()}`}, ${videoId}, ${probe.name}, ${probe.userId}, 0)`);

  await tx.execute(sql`
    INSERT INTO showcase_launch
      (id, author_user_id, title, tagline, summary, launched_at, difficulty,
       accepted_launch_statement_ids, heading_image_url, heading_image_public_id)
    VALUES (${launchId}, ${otherUserId}, 'A coverage probe launch',
            'A tagline of a workable length',
            'A summary long enough to satisfy the forty character floor this table sets.',
            now(), 'beginner',
            ARRAY['built_it_ourselves', 'results_are_our_own']::text[],
            'https://example.invalid/coverage-probe.png', 'coverage/probe')`);

  await tx.execute(sql`
    INSERT INTO showcase_launch_team_member (id, launch_id, position, display_name, handle, role)
    VALUES (${`text-pii-member-${randomUUID()}`}, ${launchId}, 0, ${probe.name}, ${probe.handle}, 'Engineer')`);
}

/** `commerce_organization_slug_ck` admits lowercase alphanumerics and hyphens only. */
function probeSlug(sourceId: string): string {
  return sourceId
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .slice(0, 90);
}

/**
 * Check 6, from the other end: ask every `scrub` column whether the probe's name, handle or
 * address is still in it.
 *
 * ⚠️ IT ASKS POSTGRES RATHER THAN COMPARING TO AN EXPECTED LITERAL, on purpose. An assertion
 * that a column equals `'Former member'` would pass on a step that wrote the constant into the
 * wrong row; "the probe's name is nowhere" is the property that actually matters, and it is the
 * one a reader of a public page would notice being false.
 */
async function checkNoScrubColumnHoldsTheProbe(
  tx: ProbeTransaction,
  probe: ProbeIdentity,
): Promise<CheckOutcome> {
  const survivors: string[] = [];

  for (const key of SCRUBBED_TEXT_COLUMN_KEYS) {
    const { tableName, columnName } = parseTextPiiColumnKey(key);
    const table = sql.identifier(tableName);
    const column = sql.identifier(columnName);
    /**
     * `::text` because two of these are not `text` — `invited_email` is `citext` and
     * `is_channel_listed` is a boolean — and a register that could only check `text` columns
     * would quietly skip exactly the entries somebody added to close a blind spot.
     */
    const { rows } = await tx.execute<{ surviving: string }>(sql`
      SELECT count(*)::text AS surviving FROM ${table}
      WHERE ${column}::text = ANY(ARRAY[${probe.name}, ${probe.handle}, ${probe.email}]::text[])
         OR ${column}::text LIKE ${`%${probe.name}%`}`);
    const surviving = rows[0]?.surviving ?? "0";
    if (surviving !== "0") survivors.push(`${key} (${surviving} rows)`);
  }

  return {
    label: "no scrubbed column still holds the probe's identity",
    passed: survivors.length === 0,
    detail:
      survivors.length === 0
        ? `${String(SCRUBBED_TEXT_COLUMN_KEYS.length)} scrub columns checked, none naming the probe`
        : `text survived the erasure: ${survivors.join(", ")}`,
  };
}

/**
 * Check 7 — the control, and the reason check 6 is not half a test.
 *
 * A `self_declared` organization is a real company other people trade with, whose name is not
 * one member's to erase. "Scrub every row this user created" would pass check 6 and destroy it,
 * and nothing else in this repo would have noticed.
 */
async function checkSelfDeclaredOrganizationSurvived(
  tx: ProbeTransaction,
  probe: ProbeIdentity,
): Promise<CheckOutcome> {
  const { rows } = await tx.execute<{ display_name: string; provisioning_origin: string }>(sql`
    SELECT display_name, provisioning_origin FROM commerce_organization
    WHERE created_by_user_id = ${probe.userId} AND provisioning_origin = 'self_declared'`);

  const expected = probe.declaredCompanyName;
  const survived = rows.length === 1 && rows[0]?.display_name === expected;

  return {
    label: "a self_declared organization is left alone",
    passed: survived,
    detail: survived
      ? "the scope really is provisioning_origin, not ownership"
      : `expected exactly one row named "${expected}", got ${JSON.stringify(rows)}`,
  };
}

async function main(): Promise<void> {
  const [scannedColumns, everyColumnKey, cascadeClosure] = await Promise.all([
    readPersonShapedTextColumns(),
    readEveryColumnKey(),
    readCascadeClosure(),
  ]);

  const outcomes: readonly CheckOutcome[] = [
    ...compareCoverage(scannedColumns, everyColumnKey, cascadeClosure),
    ...(await checkStepsAreExecutable()),
  ];

  for (const outcome of outcomes) {
    console.log(`${outcome.passed ? "PASS" : "FAIL"}  ${outcome.label} — ${outcome.detail}`);
  }

  const failureCount = outcomes.filter((outcome) => !outcome.passed).length;
  console.log(
    failureCount === 0
      ? `\nAll ${String(outcomes.length)} text-PII guarantees are in force.`
      : `\n${String(failureCount)} of ${String(outcomes.length)} guarantees are MISSING.`,
  );

  if (failureCount > 0) process.exitCode = 1;
}

main()
  .then(async () => {
    await pool.end();
    return undefined;
  })
  .catch(async (error: unknown) => {
    console.error("Text-PII coverage verification failed:", error);
    await pool.end();
    process.exit(1);
  });
