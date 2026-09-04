/**
 * Writes one assessment's LLM pathway narrative (§10A).
 *
 * ON-DEMAND, NEVER SCHEDULED — enqueued by `recompute-localization-assessments` for the
 * top slice of each country's ranking. The same shape `analyze-daily-log` has, and for the
 * same reason: a scheduled narrative job would either rewrite prose nobody asked for or
 * sit idle, and neither is a schedule.
 *
 * THE MODEL IS HANDED THE ARITHMETIC. Every figure in the prompt is read from the
 * assessment row that already exists — the score, its five components, the trade values.
 * Nothing here recomputes any of them, and the response schema has no field the model
 * could put a competing number in.
 *
 * FAILURE IS A STATE ON THE ROW, not a lost job. `narrative_status` moves to `generated`,
 * `failed` or `skipped_unconfigured`, so a surface can say "we have not written this yet"
 * rather than rendering an assessment that silently lacks prose.
 */
import { eq, sql } from "drizzle-orm";

import { config } from "#src/config/index.js";
import { db } from "#src/db/index.js";
import { localizationAssessment, localizationPathwaySuggestion } from "#src/db/schema.js";
import {
  JOB_NAMES,
  JOB_PAYLOAD_SCHEMAS,
  parseJobPayload,
  PermanentJobError,
} from "#src/lib/jobs.js";
import { writeLocalizationNarrative } from "#src/modules/rnd/import-intelligence/localization-narrative.js";

/** The prose is capped by the column CHECK; this keeps the join inside it. */
const MAX_BODY_TEXT_LENGTH = 6000;

interface AssessmentContextRow {
  readonly [column: string]: unknown;
  readonly hs_code: string;
  readonly commodity_label: string;
  readonly country_name: string;
  readonly feasibility_score_points: number;
  readonly import_dependency_points: number;
  readonly export_capability_points: number;
  readonly substitute_availability_points: number;
  readonly supplier_capacity_points: number;
  readonly lead_time_advantage_points: number;
  readonly observed_import_value_in_cents: string;
  readonly observed_export_value_in_cents: string;
  readonly currency: string;
  readonly matched_supplier_count: number;
  readonly median_supplier_lead_time_days: number | null;
  readonly narrative_status: string;
  /**
   * A STRING, not a Date.
   *
   * ⚠️ `db.execute` DOES NOT APPLY THE GLOBAL `pg` TYPE PARSER. The parser registered in
   * `src/db/index.ts` for OID 1114 turns every `timestamp` into a UTC `Date`, and it
   * applies to `db.select` — but a raw `sql` query comes back with the driver's own
   * string, `"2026-01-05 00:00:00"`. Typing this as `Date` compiles and then throws
   * `value.toISOString is not a function` at the first insert that uses it.
   */
  readonly as_of: string;
}

/**
 * Rebuilds the UTC instant from a `db.execute` timestamp string.
 *
 * ⚠️ THE `Z` IS LOAD-BEARING. Postgres hands back `"2026-01-05 00:00:00"` with no zone,
 * and `new Date()` on that reads it as LOCAL time — on a UTC+5:30 machine the instant
 * moves by five and a half hours. `src/db/index.ts` documents the same hazard for the
 * parser it registers, and this is the identical conversion for the path that parser does
 * not cover. §4c compares persisted `asOf` values for byte-identity, so an offset one is
 * not a cosmetic error.
 */
function parseUtcTimestamp(rawValue: string): Date {
  return new Date(`${rawValue.replace(" ", "T")}Z`);
}

/**
 * Formats cents as a whole-dollar label for the prompt.
 *
 * A DISPLAY STRING FOR THE MODEL, never stored and never sent to a client — the wire
 * carries integer cents and a currency, and the frontend composes its own label (§11).
 * Whole dollars because cent precision on a $140bn figure is noise the model would
 * faithfully repeat.
 */
function formatWholeDollars(valueInCents: string, currency: string): string {
  const wholeUnits = BigInt(valueInCents) / 100n;
  return `${currency} ${wholeUnits.toLocaleString("en-US")}`;
}

export async function handleGenerateLocalizationNarrative(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.generateLocalizationNarrative,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.generateLocalizationNarrative],
    rawPayload,
  );

  const context = await db.execute<AssessmentContextRow>(sql`
    SELECT c.hs_code, c.label AS commodity_label, r.label AS country_name,
           a.feasibility_score_points, a.import_dependency_points, a.export_capability_points,
           a.substitute_availability_points, a.supplier_capacity_points,
           a.lead_time_advantage_points,
           a.observed_import_value_in_cents, a.observed_export_value_in_cents, a.currency,
           a.matched_supplier_count, a.median_supplier_lead_time_days,
           a.narrative_status::text AS narrative_status, a.as_of
    FROM localization_assessment AS a
    JOIN import_commodity AS c ON c.id = a.commodity_id
    JOIN discovery_region AS r ON r.id = a.region_id
    WHERE a.id = ${payload.assessmentId}
    LIMIT 1
  `);

  const assessment = context.rows[0];
  if (assessment === undefined) {
    throw new PermanentJobError(
      "LOCALIZATION_ASSESSMENT_MISSING",
      `no localization_assessment ${payload.assessmentId}`,
    );
  }

  // Already written. A re-enqueue must not spend a second metered request producing a
  // second opinion about the same row.
  if (assessment.narrative_status !== "pending") {
    return;
  }

  // The published substitutes, named for the prompt so the model can talk about them
  // rather than about substitution in the abstract.
  const substituteRows = await db.execute<{
    readonly [column: string]: unknown;
    readonly substitute_label: string;
  }>(sql`
    SELECT s.substitute_label
    FROM domestic_substitute_mapping AS s
    JOIN localization_assessment AS a
      ON a.commodity_id = s.commodity_id AND a.region_id = s.region_id
    WHERE a.id = ${payload.assessmentId} AND s.published_at IS NOT NULL
    ORDER BY s.substitute_label
    LIMIT 20
  `);

  const written = await writeLocalizationNarrative(
    {
      hsCode: assessment.hs_code,
      commodityLabel: assessment.commodity_label,
      countryName: assessment.country_name,
      feasibilityScorePoints: assessment.feasibility_score_points,
      importDependencyPoints: assessment.import_dependency_points,
      exportCapabilityPoints: assessment.export_capability_points,
      substituteAvailabilityPoints: assessment.substitute_availability_points,
      supplierCapacityPoints: assessment.supplier_capacity_points,
      leadTimeAdvantagePoints: assessment.lead_time_advantage_points,
      importValueLabel: formatWholeDollars(
        assessment.observed_import_value_in_cents,
        assessment.currency,
      ),
      exportValueLabel: formatWholeDollars(
        assessment.observed_export_value_in_cents,
        assessment.currency,
      ),
      substituteLabels: substituteRows.rows.map((row) => row.substitute_label),
      matchedSupplierCount: assessment.matched_supplier_count,
      medianSupplierLeadTimeDays: assessment.median_supplier_lead_time_days,
    },
    {
      apiKey: config.GEMINI_API_KEY,
      model: config.GEMINI_MODEL,
      timeoutMs: config.GEMINI_TIMEOUT_MS,
      maxOutputTokens: config.GEMINI_MAX_OUTPUT_TOKENS,
    },
  );

  if (!written.success) {
    // No key configured is an OPERATOR FACT, not a failure: the assessment keeps its real
    // score and simply has no prose. Rendering it as `failed` would put a red state on a
    // row where nothing went wrong.
    if (written.error.type === "GEMINI_NOT_CONFIGURED") {
      await db
        .update(localizationAssessment)
        .set({ narrativeStatus: "skipped_unconfigured" })
        .where(eq(localizationAssessment.id, payload.assessmentId));
      return;
    }

    // Retryable: throw, and pg-boss backs off (§4e). The row stays `pending`, which is
    // true — nobody has written it yet.
    if (written.error.type === "GEMINI_UNAVAILABLE") {
      throw new Error(`generate-localization-narrative: ${written.error.detail}`);
    }

    // Permanent: a refusal, a truncation, or output that would not parse after one repair.
    await db
      .update(localizationAssessment)
      .set({ narrativeStatus: "failed" })
      .where(eq(localizationAssessment.id, payload.assessmentId));
    return;
  }

  const { narrative } = written.value;
  const bodyText = [
    narrative.summary,
    ...narrative.pathwaySteps.map((step) => `${step.headline}: ${step.detail}`),
    ...(narrative.keyRisks.length === 0 ? [] : [`Risks: ${narrative.keyRisks.join(" ")}`]),
  ]
    .join("\n\n")
    .slice(0, MAX_BODY_TEXT_LENGTH);

  await db.transaction(async (transaction) => {
    await transaction.insert(localizationPathwaySuggestion).values({
      assessmentId: payload.assessmentId,
      title: narrative.title,
      bodyText,
      modelName: written.value.modelName,
      modelVersion: written.value.modelVersion,
      promptVersion: written.value.promptVersion,
      // NULL when the model recorded none. Not coerced to zero — that would publish "no
      // confidence" as a finding rather than as an absence.
      confidenceBps: narrative.confidenceBps,
      // The capital band, or nothing. `localization-narrative.ts` has already refused a
      // partial one, so these three are null together or present together — which is what
      // `localization_pathway_suggestion_capital_ck` also demands.
      //
      // ⚠️ BigInt, not Number, at the column boundary: the column is `bigint` in cents and
      // the mode is `bigint`. The schema bounds the model's answer at MAX_SAFE_INTEGER, so
      // this conversion is exact.
      estimatedCapitalMinInCents:
        narrative.estimatedCapitalMinInCents === null
          ? null
          : BigInt(narrative.estimatedCapitalMinInCents),
      estimatedCapitalMaxInCents:
        narrative.estimatedCapitalMaxInCents === null
          ? null
          : BigInt(narrative.estimatedCapitalMaxInCents),
      capitalBasisText: narrative.capitalBasisText,
      asOf: parseUtcTimestamp(assessment.as_of),
    });
    await transaction
      .update(localizationAssessment)
      .set({ narrativeStatus: "generated" })
      .where(eq(localizationAssessment.id, payload.assessmentId));
  });
}
