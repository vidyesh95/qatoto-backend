/**
 * §10A end to end, against a real database: sync → assess → narrate.
 *
 * WHY THIS EXISTS ALONGSIDE THE VITEST SUITE. That suite mocks `#src/db/index.js`
 * wholesale, so it proves arithmetic and routing and nothing about the pipeline. The
 * failures that matter here are the ones only a real Postgres can produce: an ON CONFLICT
 * whose arbiter does not match a partial index, a `::text` cast that never happens, a
 * column name that exists in the schema file and not in the database.
 *
 * IT MAKES ONE REAL COMTRADE CALL and, if a model key is configured, one real Gemini call.
 * The Comtrade call is a CONNECTIVITY PROOF ONLY — its rows are asserted and discarded
 * rather than written, because a bulk ingest of 5,000 commodities is an operational
 * decision, not something a smoke test should make on somebody's behalf. The pipeline
 * itself runs over fixture rows this script creates and removes.
 *
 * IT CLEANS UP AFTER ITSELF, unlike `smoke-proof-of-effort`. Nothing in §10A is append-only
 * and nothing here is evidence about a person, so leaving rows behind would just be litter
 * in a shared database.
 *
 *   pnpm db:smoke-import-intelligence
 */
import "dotenv/config";
import { and, eq, inArray } from "drizzle-orm";

import { config } from "#src/config/index.js";
import { db, pool } from "#src/db/index.js";
import {
  commodityTradeFlow,
  discoveryRegion,
  importCommodity,
  localizationAssessment,
  localizationPathwaySuggestion,
  researchCategory,
} from "#src/db/schema.js";
import { stopSendOnlyBoss } from "#src/lib/jobs.js";
import { fetchAnnualTradeFlows } from "#src/modules/rnd/import-intelligence/comtrade.js";
import { handleGenerateLocalizationNarrative } from "#src/modules/rnd/import-intelligence/generate-localization-narrative.js";
import { handleRecomputeLocalizationAssessments } from "#src/modules/rnd/import-intelligence/recompute-localization-assessments.js";

const SMOKE_PREFIX = "smoke-import-intelligence";

interface Assertion {
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

const assertions: Assertion[] = [];

function record(label: string, passed: boolean, detail: string): void {
  assertions.push({ label, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${label} — ${detail}`);
}

/** India, 2023, imports — the exact cell the pinned query was verified against. */
const CONNECTIVITY_REPORTER_CODE = 699;
const CONNECTIVITY_PERIOD_YEAR = 2023;

async function proveComtradeConnectivity(): Promise<void> {
  if (
    config.COMTRADE_DEVELOPER_UN_ORG_PRIMARY_KEY === undefined ||
    config.COMTRADE_DEVELOPER_UN_ORG_PRIMARY_KEY === ""
  ) {
    // A smoke test that passes by recording "not configured" proves the opposite of what
    // it claims to.
    record(
      "Comtrade connectivity",
      false,
      "SKIPPED — COMTRADE_DEVELOPER_UN_ORG_PRIMARY_KEY is not set, so the feed is unproven",
    );
    return;
  }

  const fetched = await fetchAnnualTradeFlows(
    {
      reporterCode: CONNECTIVITY_REPORTER_CODE,
      periodYear: CONNECTIVITY_PERIOD_YEAR,
      flowKind: "import",
    },
    {
      subscriptionKey: config.COMTRADE_DEVELOPER_UN_ORG_PRIMARY_KEY,
      timeoutMs: config.COMTRADE_TIMEOUT_MS,
    },
  );

  if (!fetched.success) {
    record("Comtrade connectivity", false, `the live API answered ${fetched.error.type}`);
    return;
  }

  record(
    "Comtrade connectivity",
    fetched.value.rows.length > 1_000,
    `${fetched.value.rows.length} HS6 leaves from ${fetched.value.rowsReceived} rows`,
  );

  // Every value is an integer after conversion — the one place a float could leak in.
  const nonInteger = fetched.value.rows.filter(
    (row) =>
      !Number.isSafeInteger(row.tradeValueInCents) ||
      (row.netWeightMilliKilograms !== null && !Number.isSafeInteger(row.netWeightMilliKilograms)),
  );
  record(
    "every live figure converts to a safe integer",
    nonInteger.length === 0,
    `${nonInteger.length} non-integer row(s) of ${fetched.value.rows.length}`,
  );

  // Null-is-not-zero, observed live rather than asserted in a comment.
  const missingWeight = fetched.value.rows.filter((row) => row.netWeightMilliKilograms === null);
  record(
    "rows with no reported weight stay NULL",
    missingWeight.length > 0,
    `${missingWeight.length} row(s) carry no net weight`,
  );
}

async function main(): Promise<void> {
  await proveComtradeConnectivity();

  // DIGITS, not a UUID slice. An HS code is six digits and the column CHECK enforces it —
  // a hex slice containing a letter is rejected, which is how this was found.
  const runId = String(Math.floor(Math.random() * 90) + 10);
  const commodityIds: string[] = [];
  let assessmentIds: string[] = [];

  try {
    const [category] = await db.select({ id: researchCategory.id }).from(researchCategory).limit(1);
    if (category === undefined) {
      throw new Error("No research_category rows — run `pnpm db:seed-research-categories` first.");
    }
    const [region] = await db
      .select({ id: discoveryRegion.id, label: discoveryRegion.label })
      .from(discoveryRegion)
      .where(eq(discoveryRegion.kind, "country"))
      .limit(1);
    if (region === undefined) {
      throw new Error("No country discovery_region rows — run `pnpm db:seed-discovery-lookups`.");
    }

    // --- Fixture commodities. Chapter 99 codes so they cannot collide with real HS6 data.
    const fixtures = [
      { hsCode: `9911${runId}`, importCents: 14_038_629_964_550, exportCents: 0 },
      {
        hsCode: `9912${runId}`,
        importCents: 1_186_299_084_219,
        exportCents: 50_000_000_000,
      },
      { hsCode: `9913${runId}`, importCents: 0, exportCents: 0 },
    ];

    for (const fixture of fixtures) {
      const [inserted] = await db
        .insert(importCommodity)
        .values({
          hsCode: fixture.hsCode,
          label: `${SMOKE_PREFIX} ${fixture.hsCode}`,
          commodityKind: "other_manufactured",
          researchCategoryId: category.id,
          defaultQuantityUnit: "kilograms",
        })
        .returning({ id: importCommodity.id });
      if (inserted === undefined) throw new Error("commodity insert returned no row");
      commodityIds.push(inserted.id);

      for (const [flowKind, valueInCents] of [
        ["import", fixture.importCents],
        ["export", fixture.exportCents],
      ] as const) {
        if (valueInCents === 0 && flowKind === "export") continue;
        await db.insert(commodityTradeFlow).values({
          commodityId: inserted.id,
          reporterRegionId: region.id,
          partnerRegionId: null,
          flowKind,
          periodKind: "annual",
          periodStartsDate: "2023-01-01",
          periodEndsDate: "2023-12-31",
          tradeValueInCents: valueInCents,
          currency: "USD",
          netWeightMilliKilograms: null,
          quantityMilli: null,
          quantityUnit: "not_applicable",
          quantityUnitCode: -1,
          isReported: false,
          isAggregate: true,
          isNetWeightEstimated: false,
          isQuantityEstimated: false,
          legacyEstimationFlag: null,
          sourceName: SMOKE_PREFIX,
          sourceRetrievedAt: new Date(),
          dataOrigin: "seeded_fixture",
        });
      }
    }
    record("fixture commodities and flows written", true, `${fixtures.length} commodities`);

    // --- THE ASSESSMENT JOB, called inline. This is the step the vitest suite cannot run.
    const asOf = new Date(Date.UTC(2026, 0, 2));
    const payload = {
      asOf: asOf.toISOString(),
      windowStartsAt: new Date(Date.UTC(2025, 0, 2)).toISOString(),
      windowEndsAt: asOf.toISOString(),
      regionId: region.id,
    };
    await handleRecomputeLocalizationAssessments(payload);

    const written = await db
      .select({
        id: localizationAssessment.id,
        commodityId: localizationAssessment.commodityId,
        total: localizationAssessment.feasibilityScorePoints,
        rank: localizationAssessment.rank,
        asOf: localizationAssessment.asOf,
        narrativeStatus: localizationAssessment.narrativeStatus,
        importDependencyPoints: localizationAssessment.importDependencyPoints,
        exportCapabilityPoints: localizationAssessment.exportCapabilityPoints,
        substituteAvailabilityPoints: localizationAssessment.substituteAvailabilityPoints,
        supplierCapacityPoints: localizationAssessment.supplierCapacityPoints,
        leadTimeAdvantagePoints: localizationAssessment.leadTimeAdvantagePoints,
      })
      .from(localizationAssessment)
      .where(
        and(
          eq(localizationAssessment.asOf, asOf),
          inArray(localizationAssessment.commodityId, commodityIds),
        ),
      );
    assessmentIds = written.map((row) => row.id);

    record(
      "an assessment exists for every fixture commodity",
      written.length === fixtures.length,
      `${written.length}/${fixtures.length}`,
    );

    const componentsAgree = written.every(
      (row) =>
        row.importDependencyPoints +
          row.exportCapabilityPoints +
          row.substituteAvailabilityPoints +
          row.supplierCapacityPoints +
          row.leadTimeAdvantagePoints ===
        row.total,
    );
    record(
      "every stored breakdown sums to its own total",
      componentsAgree,
      `${written.length} rows`,
    );

    const asOfRoundTrips = written.every((row) => row.asOf.getTime() === asOf.getTime());
    record("asOf round-trips byte-identically", asOfRoundTrips, asOf.toISOString());

    const ranks = written.map((row) => row.rank).toSorted((left, right) => left - right);
    record(
      "ranks are dense and start at 1",
      ranks.every((rank, index) => rank === index + 1),
      `ranks ${ranks.join(", ")}`,
    );

    const topCommodity = written.find((row) => row.rank === 1);
    record(
      "the $140bn import line outranks the empty one",
      topCommodity !== undefined && topCommodity.total > 0,
      `rank 1 scored ${topCommodity?.total ?? "n/a"}`,
    );

    // --- IDEMPOTENCY. Re-running the same asOf must not double the rows.
    await handleRecomputeLocalizationAssessments(payload);
    const afterRerun = await db
      .select({ id: localizationAssessment.id })
      .from(localizationAssessment)
      .where(
        and(
          eq(localizationAssessment.asOf, asOf),
          inArray(localizationAssessment.commodityId, commodityIds),
        ),
      );
    record(
      "re-running the same asOf is a no-op",
      afterRerun.length === written.length,
      `${written.length} before, ${afterRerun.length} after`,
    );

    // --- THE NARRATIVE JOB.
    const narrativeTarget = written.find((row) => row.rank === 1);
    if (narrativeTarget === undefined) {
      record("narrative job", false, "no rank-1 assessment to narrate");
    } else {
      await handleGenerateLocalizationNarrative({ assessmentId: narrativeTarget.id });

      const [afterNarrative] = await db
        .select({ narrativeStatus: localizationAssessment.narrativeStatus })
        .from(localizationAssessment)
        .where(eq(localizationAssessment.id, narrativeTarget.id))
        .limit(1);
      const suggestions = await db
        .select({
          id: localizationPathwaySuggestion.id,
          modelName: localizationPathwaySuggestion.modelName,
          promptVersion: localizationPathwaySuggestion.promptVersion,
          status: localizationPathwaySuggestion.status,
        })
        .from(localizationPathwaySuggestion)
        .where(eq(localizationPathwaySuggestion.assessmentId, narrativeTarget.id));

      const hasModelKey = config.GEMINI_API_KEY !== undefined && config.GEMINI_API_KEY !== "";

      if (hasModelKey) {
        record(
          "the narrative was generated by the live model",
          afterNarrative?.narrativeStatus === "generated" && suggestions.length === 1,
          `status ${afterNarrative?.narrativeStatus ?? "missing"}, ${suggestions.length} suggestion(s)`,
        );
        record(
          "the suggestion carries real provenance, not a fixture",
          suggestions[0] !== undefined &&
            suggestions[0].modelName === config.GEMINI_MODEL &&
            suggestions[0].promptVersion.startsWith("localization-narrative-"),
          `model ${suggestions[0]?.modelName ?? "n/a"}, prompt ${suggestions[0]?.promptVersion ?? "n/a"}`,
        );
        record(
          "a fresh suggestion is OPEN — the model decides nothing",
          suggestions[0]?.status === "open",
          `status ${suggestions[0]?.status ?? "n/a"}`,
        );
      } else {
        // An operator fact, and the row must say so rather than reading as a failure.
        record(
          "no model key records skipped_unconfigured, NOT failed",
          afterNarrative?.narrativeStatus === "skipped_unconfigured",
          `status ${afterNarrative?.narrativeStatus ?? "missing"} (set GEMINI_API_KEY to prove the model path)`,
        );
      }

      // Re-running must not spend a second metered request.
      await handleGenerateLocalizationNarrative({ assessmentId: narrativeTarget.id });
      const afterSecondRun = await db
        .select({ id: localizationPathwaySuggestion.id })
        .from(localizationPathwaySuggestion)
        .where(eq(localizationPathwaySuggestion.assessmentId, narrativeTarget.id));
      record(
        "re-running the narrative writes no second suggestion",
        afterSecondRun.length === suggestions.length,
        `${suggestions.length} before, ${afterSecondRun.length} after`,
      );
    }
  } finally {
    // Innermost first.
    if (assessmentIds.length > 0) {
      await db
        .delete(localizationPathwaySuggestion)
        .where(inArray(localizationPathwaySuggestion.assessmentId, assessmentIds));
    }
    if (commodityIds.length > 0) {
      await db
        .delete(localizationAssessment)
        .where(inArray(localizationAssessment.commodityId, commodityIds));
      await db
        .delete(commodityTradeFlow)
        .where(inArray(commodityTradeFlow.commodityId, commodityIds));
      await db.delete(importCommodity).where(inArray(importCommodity.id, commodityIds));
    }
  }

  const failureCount = assertions.filter((assertion) => !assertion.passed).length;
  console.log(
    failureCount === 0
      ? `\nAll ${assertions.length} import-intelligence smoke assertions passed.`
      : `\n${failureCount} of ${assertions.length} smoke assertions FAILED.`,
  );
  if (failureCount > 0) process.exitCode = 1;
}

main()
  .then(async () => {
    // ⚠️ REQUIRED, and its absence is a HANG rather than an error. The assessment job
    // enqueues narratives through `sendJob`, which starts the API's send-only pg-boss
    // instance — and that instance holds an open handle that keeps the process alive after
    // every assertion has passed. `smoke-daily-log-analysis.ts` carries the same two lines
    // for the same reason.
    await stopSendOnlyBoss();
    await pool.end();
    return undefined;
  })
  .catch(async (error: unknown) => {
    console.error("Import-intelligence smoke failed to run:", error);
    await stopSendOnlyBoss().catch(() => undefined);
    await pool.end();
    process.exit(1);
  });
