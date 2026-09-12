/**
 * Proves the teardown tables' constraints against a REAL database.
 *
 *   pnpm db:verify-teardown-constraints
 *
 * WHY THIS EXISTS SEPARATELY FROM THE VITEST SUITE. That suite mocks `#src/db/index.js` wholesale,
 * so no test in this repository can prove anything about Postgres. Every claim below is a claim
 * about the DATABASE — a CHECK, a composite foreign key, a partial unique index, a cascade — and
 * the only way to prove one is to attempt the write and watch it be refused. A guarantee nobody has
 * seen fire is a guarantee nobody should trust.
 *
 * FOUR OF THESE EXIST ONLY IN SQL, and they are the reason the file is worth its length:
 *
 *   THE PROVENANCE TRUTH TABLE — three arms, each refusing both the missing required field and the
 *       present forbidden one. It is duplicated in `teardown-import.schemas.ts` on purpose; if the
 *       CHECK were quietly dropped, the schema would still pass and nothing would notice until
 *       somebody wrote a row by another path.
 *
 *   ARM EXCLUSIVITY VIA A COMPOSITE FOREIGN KEY — `teardown_part.assembly_kind` is denormalised so
 *       that `(assembly_id, assembly_kind)` can be forced to agree with the parent assembly, which
 *       is what lets a per-row CHECK say "a composite part names a node and carries no model".
 *       Nothing in TypeScript enforces that pairing.
 *
 *   TWO-HOP PART RESOLUTION — a step's focused part and a material's part must belong to THIS
 *       teardown's assembly, proven by `(teardown_id, assembly_id)` then `(assembly_id, part_id)`.
 *       A single-column reference would have let a step focus a part of somebody else's teardown.
 *
 *   THE `source = 'youtube'` PIN — the column reuses the shared `video_source` enum, which carries
 *       `hosted`, while the frontend's video shape is a one-arm union. Without the CHECK, a
 *       `hosted` row is a detail page that will not parse.
 *
 * EVERYTHING RUNS INSIDE ONE TRANSACTION THAT IS ALWAYS ROLLED BACK — the shape
 * `verify-research-program-constraints.ts` establishes. That is why there is no cleanup code: the
 * rollback is the cleanup, and it cannot be skipped by a failed assertion or a throw.
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

/** A backslash, built rather than written — the same escaping trap the schema's CHECKs document. */
const BACKSLASH = String.fromCharCode(92);

/** The columns a teardown cannot be inserted without, with the reverse-engineered arm. */
function insertTeardownStatement(columns: string, values: string): string {
  return `INSERT INTO teardown (
            id, slug, title, summary, thumbnail_url, author_display_name, difficulty,
            subject_kind, moderation_state, provenance_kind, provenance_subject_product_name,
            provenance_unit_acquisition, provenance_survey_methods, provenance_surveyed_at,
            provenance_attestation_accepted_at, created_at${columns})
          VALUES (
            $1, $2, 'Verify teardown fixture', $3, '/dummy/teardowns/verify.avif', 'Verifier',
            'intermediate', 'existing_physical_product', 'published',
            'community_reverse_engineered', 'Subject product', 'retail_purchase',
            ARRAY['dimensional_survey']::teardown_survey_method[], now(), now(), now()${values})`;
}

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

  const SUMMARY =
    "A disposable teardown used to prove the constraints, long enough to clear the forty-character floor.";

  try {
    await client.query("BEGIN");

    console.log("\n--- 1. teardown identity and shape ---");

    const teardownId = randomUUID();
    const teardownSlug = `verify-teardown-${suffix}`;
    await client.query(insertTeardownStatement("", ""), [teardownId, teardownSlug, SUMMARY]);
    check(
      "a reverse-engineered teardown inserts with neither licence nor note",
      true,
      teardownSlug,
    );

    await expectRefused(
      "a duplicate slug is refused (teardown_slug_unique)",
      PG_UNIQUE_VIOLATION,
      insertTeardownStatement("", ""),
      [randomUUID(), teardownSlug, SUMMARY],
    );

    await expectRefused(
      "a reserved slug is refused (teardown_slug_ck)",
      PG_CHECK_VIOLATION,
      insertTeardownStatement("", ""),
      [randomUUID(), "options", SUMMARY],
    );

    await expectRefused(
      "an uppercase slug is refused (teardown_slug_ck)",
      PG_CHECK_VIOLATION,
      insertTeardownStatement("", ""),
      [randomUUID(), `Verify-Teardown-${suffix}`, SUMMARY],
    );

    await expectRefused(
      "a proposed-design subject kind is refused (teardown_subject_kind_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE teardown SET subject_kind = 'proposed_design' WHERE id = $1`,
      [teardownId],
    );

    await expectRefused(
      "a draft teardown is refused (teardown_moderation_state_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE teardown SET moderation_state = 'draft' WHERE id = $1`,
      [teardownId],
    );

    await expectRefused(
      "a removed teardown is refused (teardown_moderation_state_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE teardown SET moderation_state = 'removed' WHERE id = $1`,
      [teardownId],
    );

    await expectRefused(
      "a zero part count is refused (teardown_part_count_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE teardown SET part_count = 0 WHERE id = $1`,
      [teardownId],
    );

    console.log("\n--- 2. the asset and external URL predicates ---");

    /*
     * A SITE-RELATIVE ASSET IS LEGAL AND A PROTOCOL-RELATIVE ONE IS NOT, in both spellings.
     * `//evil.test/x` and `/\evil.test/x` are read as an absolute URL by a browser, so a teardown
     * could point its model at another origin while looking same-site in the column.
     */
    await expectAccepted(
      "a site-relative asset URL is accepted (teardown_thumbnail_url_ck)",
      `UPDATE teardown SET thumbnail_url = '/dummy/teardowns/other.avif' WHERE id = $1`,
      [teardownId],
    );

    await expectAccepted(
      "an https asset URL is accepted (teardown_thumbnail_url_ck)",
      `UPDATE teardown SET thumbnail_url = 'https://cdn.test/other.avif' WHERE id = $1`,
      [teardownId],
    );

    await expectRefused(
      "a protocol-relative asset URL is refused (teardown_thumbnail_url_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE teardown SET thumbnail_url = '//evil.test/x.avif' WHERE id = $1`,
      [teardownId],
    );

    await expectRefused(
      "the backslash spelling of a protocol-relative URL is refused (teardown_thumbnail_url_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE teardown SET thumbnail_url = $2 WHERE id = $1`,
      [teardownId, `/${BACKSLASH}evil.test/x.avif`],
    );

    await expectRefused(
      "a plain-http asset URL is refused (teardown_thumbnail_url_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE teardown SET thumbnail_url = 'http://cdn.test/x.avif' WHERE id = $1`,
      [teardownId],
    );

    console.log("\n--- 3. the provenance truth table, all three arms, both directions ---");

    await expectRefused(
      "a reverse-engineered teardown may not carry a licence (teardown_provenance_permission_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE teardown
         SET provenance_licence_name = 'CERN-OHL-S-2.0',
             provenance_licence_url = 'https://licence.test/ohl'
       WHERE id = $1`,
      [teardownId],
    );

    await expectRefused(
      "a reverse-engineered teardown may not carry an authorization note (teardown_provenance_permission_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE teardown SET provenance_authorization_note = 'Signed off by the vendor.' WHERE id = $1`,
      [teardownId],
    );

    await expectRefused(
      "an open-source teardown without a licence is refused (teardown_provenance_permission_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE teardown SET provenance_kind = 'licensed_open_source' WHERE id = $1`,
      [teardownId],
    );

    await expectAccepted(
      "an open-source teardown WITH a licence is accepted (teardown_provenance_permission_ck)",
      `UPDATE teardown
         SET provenance_kind = 'licensed_open_source',
             provenance_licence_name = 'CERN-OHL-S-2.0',
             provenance_licence_url = 'https://licence.test/ohl'
       WHERE id = $1`,
      [teardownId],
    );

    await expectRefused(
      "an authorized teardown without its note is refused (teardown_provenance_permission_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE teardown SET provenance_kind = 'authorized_by_manufacturer' WHERE id = $1`,
      [teardownId],
    );

    await expectAccepted(
      "an authorized teardown WITH its note is accepted (teardown_provenance_permission_ck)",
      `UPDATE teardown
         SET provenance_kind = 'authorized_by_manufacturer',
             provenance_authorization_note = 'Written permission from the manufacturer, on file.'
       WHERE id = $1`,
      [teardownId],
    );

    /** Outbound, so https only — there is no same-site licence. */
    await expectRefused(
      "a site-relative licence URL is refused (teardown_provenance_licence_url_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE teardown
         SET provenance_kind = 'licensed_open_source',
             provenance_licence_name = 'CERN-OHL-S-2.0',
             provenance_licence_url = '/dummy/licence.txt'
       WHERE id = $1`,
      [teardownId],
    );

    console.log("\n--- 4. repairability, telemetry and the walkthrough video ---");

    await expectRefused(
      "a repairability score above ten is refused (teardown_repairability_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE teardown
         SET repairability_fastener_uniformity_score = 11,
             repairability_fastener_uniformity_note = 'note',
             repairability_tool_accessibility_score = 5,
             repairability_tool_accessibility_note = 'note',
             repairability_disassembly_step_count_score = 5,
             repairability_disassembly_step_count_note = 'note',
             repairability_modular_independence_score = 5,
             repairability_modular_independence_note = 'note',
             repairability_overall_score = 5
       WHERE id = $1`,
      [teardownId],
    );

    await expectRefused(
      "half a repairability index is refused (teardown_repairability_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE teardown SET repairability_overall_score = 7 WHERE id = $1`,
      [teardownId],
    );

    await expectRefused(
      "five of six telemetry figures is refused (teardown_telemetry_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE teardown
         SET telemetry_factor_of_safety = 2.4,
             telemetry_peak_von_mises_stress_megapascals = 38.2,
             telemetry_max_displacement_micrometres = 120,
             telemetry_thermal_delta_kelvin = -4.5,
             telemetry_rated_load_newtons = 220
       WHERE id = $1`,
      [teardownId],
    );

    /** ⚠️ A SIGNED THERMAL DELTA IS LEGAL — a delta can be a drop, and only this one may be. */
    await expectAccepted(
      "a negative thermal delta is accepted (teardown_telemetry_ck)",
      `UPDATE teardown
         SET telemetry_factor_of_safety = 2.4,
             telemetry_peak_von_mises_stress_megapascals = 38.2,
             telemetry_max_displacement_micrometres = 120,
             telemetry_thermal_delta_kelvin = -4.5,
             telemetry_rated_load_newtons = 220,
             telemetry_source = 'author_reported'
       WHERE id = $1`,
      [teardownId],
    );

    /**
     * ⚠️ THE PIN. `video_source` carries `hosted`; the frontend's video shape is a one-arm union, so
     * a hosted row is a page that will not parse rather than a field it ignores.
     */
    await expectRefused(
      "a hosted walkthrough video is refused (teardown_walkthrough_video_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE teardown
         SET walkthrough_video_source = 'hosted',
             walkthrough_youtube_video_id = 'abcdefghijk',
             walkthrough_poster_url = '/dummy/poster.avif'
       WHERE id = $1`,
      [teardownId],
    );

    await expectAccepted(
      "a youtube walkthrough with no duration is accepted (teardown_walkthrough_video_ck)",
      `UPDATE teardown
         SET walkthrough_video_source = 'youtube',
             walkthrough_youtube_video_id = 'abcdefghijk',
             walkthrough_poster_url = '/dummy/poster.avif',
             walkthrough_duration_seconds = NULL
       WHERE id = $1`,
      [teardownId],
    );

    await expectRefused(
      "a ten-character youtube id is refused (teardown_walkthrough_video_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE teardown
         SET walkthrough_video_source = 'youtube',
             walkthrough_youtube_video_id = 'abcdefghij',
             walkthrough_poster_url = '/dummy/poster.avif'
       WHERE id = $1`,
      [teardownId],
    );

    /*
     * ⚠️ SECTION 4b IS THE ONE THIS SCRIPT WAS WORTH WRITING FOR.
     *
     * A CHECK passes on NULL as well as on true, so an arm that COMPARES a nullable column rather
     * than testing its presence evaluates to NULL for a half-filled row — and `false OR NULL` is
     * NULL, which Postgres accepts. The first run of this file wrote five of six telemetry figures
     * and the constraint did not fire. Eight sibling CHECKs had the same hole; migration 0172
     * closed all nine, and each probe below is the one that would have caught it.
     */
    console.log("\n--- 4b. the NULL-propagation holes migration 0172 closed ---");

    await expectRefused(
      "five of six telemetry figures with a null source is refused (teardown_telemetry_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE teardown
         SET telemetry_factor_of_safety = 2.4,
             telemetry_peak_von_mises_stress_megapascals = 38.2,
             telemetry_max_displacement_micrometres = 120,
             telemetry_thermal_delta_kelvin = -4.5,
             telemetry_rated_load_newtons = 220,
             telemetry_source = NULL
       WHERE id = $1`,
      [teardownId],
    );

    await expectRefused(
      "four repairability notes with no scores is refused (teardown_repairability_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE teardown
         SET repairability_fastener_uniformity_note = 'note',
             repairability_tool_accessibility_note = 'note',
             repairability_disassembly_step_count_note = 'note',
             repairability_modular_independence_note = 'note'
       WHERE id = $1`,
      [teardownId],
    );

    await expectRefused(
      "a cost range with no currency is refused (teardown_cost_range_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE teardown
         SET bill_of_materials_minimum_cents = 4500,
             bill_of_materials_maximum_cents = 9900,
             bill_of_materials_currency = NULL
       WHERE id = $1`,
      [teardownId],
    );

    await expectRefused(
      "a product class slug with no label is refused (teardown_store_product_class_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE teardown SET store_product_class_category_slug = 'cold-chain-controllers' WHERE id = $1`,
      [teardownId],
    );

    await expectRefused(
      "a video id and poster with no source is refused (teardown_walkthrough_video_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE teardown
         SET walkthrough_youtube_video_id = 'abcdefghijk',
             walkthrough_poster_url = '/dummy/poster.avif'
       WHERE id = $1`,
      [teardownId],
    );

    console.log("\n--- 5. the assembly arms and the composite foreign key ---");

    const assemblyId = randomUUID();
    await client.query(
      `INSERT INTO teardown_assembly (id, teardown_id, kind, model_url, model_byte_size)
       VALUES ($1, $2, 'composite', '/dummy/models/verify.glb', 482000)`,
      [assemblyId, teardownId],
    );
    check("a composite assembly inserts with its model", true, "teardown_assembly");

    await expectRefused(
      "a second assembly on one teardown is refused (teardown_assembly_teardown_uidx)",
      PG_UNIQUE_VIOLATION,
      `INSERT INTO teardown_assembly (id, teardown_id, kind, model_url, model_byte_size)
       VALUES ($1, $2, 'composite', '/dummy/models/second.glb', 1000)`,
      [randomUUID(), teardownId],
    );

    await expectRefused(
      "an individual-parts assembly carrying a model is refused (teardown_assembly_kind_shape_ck)",
      PG_CHECK_VIOLATION,
      `INSERT INTO teardown_assembly (id, teardown_id, kind, model_url, model_byte_size)
       VALUES ($1, $2, 'individual_parts', '/dummy/models/wrong.glb', 1000)`,
      [randomUUID(), randomUUID()],
    );

    await expectRefused(
      "a composite assembly whose model has no byte size is refused (teardown_assembly_kind_shape_ck)",
      PG_CHECK_VIOLATION,
      `INSERT INTO teardown_assembly (id, teardown_id, kind, model_url, model_byte_size)
       VALUES ($1, $2, 'composite', '/dummy/models/sizeless.glb', NULL)`,
      [randomUUID(), randomUUID()],
    );

    await expectRefused(
      "a zero explosion axis is refused (teardown_assembly_explosion_axis_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE teardown_assembly
         SET explosion_axis_x = 0, explosion_axis_y = 0, explosion_axis_z = 0
       WHERE id = $1`,
      [assemblyId],
    );

    const partId = `part-${suffix}`;
    await client.query(
      `INSERT INTO teardown_part
         (id, assembly_id, assembly_kind, position, label, material, manufacturing_method, node_name)
       VALUES ($1, $2, 'composite', 0, 'Housing shell', '6063-T5 aluminium', 'sheet_metal', $3)`,
      [partId, assemblyId, `housing_${suffix}`],
    );
    check("a composite part inserts with a node name and no model", true, "teardown_part");

    /**
     * ⚠️ THE COMPOSITE FOREIGN KEY. The part claims `individual_parts` while its assembly is
     * `composite`, and `(assembly_id, assembly_kind)` refuses the pair. Nothing in TypeScript is
     * holding this; without the FK the per-row arm CHECK could be satisfied by simply lying about
     * the kind.
     */
    await expectRefused(
      "a part disagreeing with its assembly's kind is refused (teardown_part_assembly_kind_fk)",
      PG_FOREIGN_KEY_VIOLATION,
      `INSERT INTO teardown_part
         (id, assembly_id, assembly_kind, position, label, material, manufacturing_method,
          model_url, model_byte_size)
       VALUES ($1, $2, 'individual_parts', 1, 'Wrong arm', 'steel', 'cnc_milled',
               '/dummy/models/part.glb', 1000)`,
      [`wrong-arm-${suffix}`, assemblyId],
    );

    await expectRefused(
      "a composite part carrying a model is refused (teardown_part_arm_shape_ck)",
      PG_CHECK_VIOLATION,
      `INSERT INTO teardown_part
         (id, assembly_id, assembly_kind, position, label, material, manufacturing_method,
          node_name, model_url, model_byte_size)
       VALUES ($1, $2, 'composite', 2, 'Both at once', 'steel', 'cnc_milled', $3,
               '/dummy/models/part.glb', 1000)`,
      [`both-${suffix}`, assemblyId, `both_${suffix}`],
    );

    await expectRefused(
      "an individual part whose model has no byte size is refused (teardown_part_arm_shape_ck)",
      PG_CHECK_VIOLATION,
      `INSERT INTO teardown_part
         (id, assembly_id, assembly_kind, position, label, material, manufacturing_method,
          model_url, model_byte_size)
       VALUES ($1, $2, 'individual_parts', 5, 'Sizeless', 'steel', 'cnc_milled',
               '/dummy/models/part.glb', NULL)`,
      [`sizeless-${suffix}`, assemblyId],
    );

    await expectRefused(
      "a composite part with no node name is refused (teardown_part_arm_shape_ck)",
      PG_CHECK_VIOLATION,
      `INSERT INTO teardown_part
         (id, assembly_id, assembly_kind, position, label, material, manufacturing_method)
       VALUES ($1, $2, 'composite', 3, 'Nameless', 'steel', 'cnc_milled')`,
      [`nameless-${suffix}`, assemblyId],
    );

    await expectRefused(
      "a duplicate node name in one assembly is refused (teardown_part_node_name_uidx)",
      PG_UNIQUE_VIOLATION,
      `INSERT INTO teardown_part
         (id, assembly_id, assembly_kind, position, label, material, manufacturing_method, node_name)
       VALUES ($1, $2, 'composite', 4, 'Twin', 'steel', 'cnc_milled', $3)`,
      [`twin-${suffix}`, assemblyId, `housing_${suffix}`],
    );

    await expectRefused(
      "a part that is its own parent is refused (teardown_part_not_own_parent_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE teardown_part SET parent_part_id = id WHERE assembly_id = $1 AND id = $2`,
      [assemblyId, partId],
    );

    await expectRefused(
      "a stress rating above one is refused (teardown_part_scalars_ck)",
      PG_CHECK_VIOLATION,
      `UPDATE teardown_part SET stress_rating = 1.5 WHERE assembly_id = $1 AND id = $2`,
      [assemblyId, partId],
    );

    /** Zero and duplicates are BOTH legal — three buttons can share one plane. */
    await expectAccepted(
      "a zero layer index is accepted (teardown_part_scalars_ck)",
      `UPDATE teardown_part SET layer_index = 0 WHERE assembly_id = $1 AND id = $2`,
      [assemblyId, partId],
    );

    console.log(
      "\n--- 6. two-hop resolution: a step and a material name a part of THIS teardown ---",
    );

    await client.query(
      `INSERT INTO teardown_assembly_step
         (id, teardown_id, step_number, title, description, assembly_id, focused_part_id)
       VALUES ($1, $2, 1, 'Remove the lid', 'Back out the eight M3 torx screws.', $3, $4)`,
      [randomUUID(), teardownId, assemblyId, partId],
    );
    check("a step focusing a part of this teardown inserts", true, "teardown_assembly_step");

    await expectRefused(
      "a duplicate step number is refused (teardown_assembly_step_number_uidx)",
      PG_UNIQUE_VIOLATION,
      `INSERT INTO teardown_assembly_step (id, teardown_id, step_number, title, description)
       VALUES ($1, $2, 1, 'Second first step', 'There can only be one step one.')`,
      [randomUUID(), teardownId],
    );

    await expectRefused(
      "a focused part with no assembly is refused (teardown_assembly_step_focus_ck)",
      PG_CHECK_VIOLATION,
      `INSERT INTO teardown_assembly_step
         (id, teardown_id, step_number, title, description, assembly_id, focused_part_id)
       VALUES ($1, $2, 2, 'Half a focus', 'A focused part needs the assembly it lives in.', NULL, $3)`,
      [randomUUID(), teardownId, partId],
    );

    /** ⚠️ THE SECOND HOP: the part id is well-formed but belongs to no part of this assembly. */
    await expectRefused(
      "a step focusing a part that does not exist is refused (teardown_assembly_step_part_fk)",
      PG_FOREIGN_KEY_VIOLATION,
      `INSERT INTO teardown_assembly_step
         (id, teardown_id, step_number, title, description, assembly_id, focused_part_id)
       VALUES ($1, $2, 3, 'Foreign focus', 'That part belongs to somebody else.', $3, $4)`,
      [randomUUID(), teardownId, assemblyId, `no-such-part-${suffix}`],
    );

    const materialId = `material-${suffix}`;
    await client.query(
      `INSERT INTO teardown_material
         (id, teardown_id, position, applies_to_label, designation, designation_source,
          material_class, assembly_id, part_id)
       VALUES ($1, $2, 0, 'Housing shell', '6063-T5', 'measured_spectroscopy', 'metal_alloy', $3, $4)`,
      [materialId, teardownId, assemblyId, partId],
    );
    check("a material naming a part of this teardown inserts", true, "teardown_material");

    await expectRefused(
      "a material naming a part that does not exist is refused (teardown_material_part_fk)",
      PG_FOREIGN_KEY_VIOLATION,
      `INSERT INTO teardown_material
         (id, teardown_id, position, applies_to_label, designation, designation_source,
          material_class, assembly_id, part_id)
       VALUES ($1, $2, 1, 'Foreign', 'Unknown', 'contributor_freetext', 'other', $3, $4)`,
      [`material-foreign-${suffix}`, teardownId, assemblyId, `no-such-part-${suffix}`],
    );

    await expectRefused(
      "a material with a part and no assembly is refused (teardown_material_part_ck)",
      PG_CHECK_VIOLATION,
      `INSERT INTO teardown_material
         (id, teardown_id, position, applies_to_label, designation, designation_source,
          material_class, assembly_id, part_id)
       VALUES ($1, $2, 2, 'Half a hop', 'Unknown', 'contributor_freetext', 'other', NULL, $3)`,
      [`material-half-${suffix}`, teardownId, partId],
    );

    console.log("\n--- 7. composition elements ---");

    await expectAccepted(
      "an unquantified element inserts with a null range (teardown_material_element_range_ck)",
      `INSERT INTO teardown_material_element
         (id, material_id, position, symbol, analysis_method)
       VALUES ($1, $2, 0, 'Fe', 'declared_not_measured')`,
      [randomUUID(), materialId],
    );

    await expectRefused(
      "half a weight range is refused (teardown_material_element_range_ck)",
      PG_CHECK_VIOLATION,
      `INSERT INTO teardown_material_element
         (id, material_id, position, symbol, minimum_percent, analysis_method)
       VALUES ($1, $2, 4, 'Mg', 0.4, 'xrf')`,
      [randomUUID(), materialId],
    );

    await expectRefused(
      "an inverted weight range is refused (teardown_material_element_range_ck)",
      PG_CHECK_VIOLATION,
      `INSERT INTO teardown_material_element
         (id, material_id, position, symbol, minimum_percent, maximum_percent, analysis_method)
       VALUES ($1, $2, 1, 'Al', 99.0, 97.0, 'xrf')`,
      [randomUUID(), materialId],
    );

    /**
     * ⚠️ AN INSTRUMENT MAY ONLY ACCOMPANY A MEASUREMENT. Naming a spectrometer beside
     * `declared_not_measured` claims it read a number nobody measured.
     */
    await expectRefused(
      "an instrument beside a declared method is refused (teardown_material_element_instrument_ck)",
      PG_CHECK_VIOLATION,
      `INSERT INTO teardown_material_element
         (id, material_id, position, symbol, analysis_method, instrument_label)
       VALUES ($1, $2, 2, 'Cu', 'declared_not_measured', 'Niton XL2')`,
      [randomUUID(), materialId],
    );

    await expectAccepted(
      "a measured element may leave the instrument unnamed (teardown_material_element_instrument_ck)",
      `INSERT INTO teardown_material_element
         (id, material_id, position, symbol, analysis_method)
       VALUES ($1, $2, 3, 'Si', 'xrf')`,
      [randomUUID(), materialId],
    );

    console.log("\n--- 8. documents, manufacturing files and fasteners ---");

    await expectRefused(
      "a zero-byte manufacturing file is refused (teardown_manufacturing_file_scalars_ck)",
      PG_CHECK_VIOLATION,
      `INSERT INTO teardown_manufacturing_file (id, teardown_id, position, kind, title, url, byte_size)
       VALUES ($1, $2, 0, 'step', 'Empty', '/dummy/manufacturing/empty.step', 0)`,
      [`mfg-empty-${suffix}`, teardownId],
    );

    /** `>= 0` here against `> 0` above — the contract draws that distinction and the CHECKs mirror it. */
    await expectAccepted(
      "a zero-byte document is accepted (teardown_document_scalars_ck)",
      `INSERT INTO teardown_document (id, teardown_id, position, kind, title, url, byte_size)
       VALUES ($1, $2, 0, 'schematic', 'Empty', '/dummy/documents/empty.pdf', 0)`,
      [`doc-empty-${suffix}`, teardownId],
    );

    await expectRefused(
      "a zero page count is refused (teardown_document_scalars_ck)",
      PG_CHECK_VIOLATION,
      `INSERT INTO teardown_document
         (id, teardown_id, position, kind, title, url, byte_size, page_count)
       VALUES ($1, $2, 1, 'schematic', 'Pageless', '/dummy/documents/x.pdf', 100, 0)`,
      [`doc-pageless-${suffix}`, teardownId],
    );

    await expectRefused(
      "a supplier label with no link is refused (teardown_fastener_supplier_ck)",
      PG_CHECK_VIOLATION,
      `INSERT INTO teardown_fastener
         (id, teardown_id, position, size_label, drive, quantity, supplier_label)
       VALUES ($1, $2, 0, 'M3 × 8', 'torx', 8, 'Fastenal')`,
      [randomUUID(), teardownId],
    );

    await expectRefused(
      "a supplier link with no label is refused (teardown_fastener_supplier_ck)",
      PG_CHECK_VIOLATION,
      `INSERT INTO teardown_fastener
         (id, teardown_id, position, size_label, drive, quantity, supplier_url)
       VALUES ($1, $2, 2, 'M3 × 8', 'torx', 8, 'https://fastenal.test/m3x8')`,
      [randomUUID(), teardownId],
    );

    /** Outbound, so https only — there is no same-site supplier. */
    await expectRefused(
      "a site-relative supplier URL is refused (teardown_fastener_supplier_url_ck)",
      PG_CHECK_VIOLATION,
      `INSERT INTO teardown_fastener
         (id, teardown_id, position, size_label, drive, quantity, supplier_label, supplier_url)
       VALUES ($1, $2, 1, 'M3 × 8', 'torx', 8, 'Fastenal', '/dummy/supplier')`,
      [randomUUID(), teardownId],
    );

    console.log("\n--- 9. the cascade ---");

    /*
     * DELETING THE TEARDOWN TAKES THE WHOLE TREE, which is what makes the seed's delete-and-replace
     * one statement rather than a reconciliation across eight tables.
     */
    await client.query(`SAVEPOINT cascade_probe`);
    await client.query(`DELETE FROM teardown WHERE id = $1`, [teardownId]);
    const survivors = await client.query<{ table_name: string; remaining: string }>(
      `SELECT 'teardown_assembly' AS table_name, count(*)::text AS remaining
         FROM teardown_assembly WHERE teardown_id = $1
       UNION ALL SELECT 'teardown_part', count(*)::text FROM teardown_part WHERE assembly_id = $2
       UNION ALL SELECT 'teardown_assembly_step', count(*)::text
         FROM teardown_assembly_step WHERE teardown_id = $1
       UNION ALL SELECT 'teardown_material', count(*)::text
         FROM teardown_material WHERE teardown_id = $1
       UNION ALL SELECT 'teardown_material_element', count(*)::text
         FROM teardown_material_element WHERE material_id = $3`,
      [teardownId, assemblyId, materialId],
    );
    const orphans = survivors.rows.filter((row) => row.remaining !== "0");
    check(
      "deleting a teardown cascades to every child table",
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
      ? `\nAll ${String(assertions.length)} teardown constraint assertions passed.`
      : `\n${String(failureCount)} of ${String(assertions.length)} teardown constraint assertions FAILED.`,
  );
  if (failureCount > 0) process.exitCode = 1;
}

main()
  .then(async () => {
    await pool.end();
    return undefined;
  })
  .catch(async (error: unknown) => {
    console.error("Teardown constraint verification failed to run:", error);
    await pool.end();
    process.exit(1);
  });
