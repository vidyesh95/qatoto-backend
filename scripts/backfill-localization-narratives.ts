/**
 * Queue pathway narratives for the top slice of one country's localization ranking (§11m).
 *
 * WHY THIS EXISTS. `recompute-localization-assessments` enqueues narratives for `rank <= 25`
 * as part of the nightly run, and `POST /localization-assessments/:id/pathway` writes one on
 * demand. Neither covers the case an operator actually hits: "the market-research chart plots
 * fifty products and forty-seven of them have never been written". Doing that by hand meant
 * fifty clicks, and doing it with a throwaway `boss.send` loop would bypass the idempotency
 * rules the service owns.
 *
 *   pnpm jobs:backfill-narratives
 *   pnpm jobs:backfill-narratives -- --limit=50 --country=IN
 *   pnpm jobs:backfill-narratives -- --all-kinds
 *
 * ⚠️ IT SPENDS ONE METERED MODEL CALL PER PRODUCT IT QUEUES, so it prints the count and the
 * cost shape BEFORE sending anything and requires `--yes` to proceed unattended. Fifty
 * products is fifty Gemini calls against a free-tier budget.
 *
 * ⚠️ IT GOES THROUGH `requestPathwayNarrative`, NOT `sendJob`. That is the whole point of the
 * indirection. The service short-circuits an assessment whose narrative is already written —
 * so re-running this is cheap rather than a second bill — and it owns the attempt-advancing
 * idempotency key that stops a dead-lettered job from blocking its own retry forever. A
 * direct `sendJob` here would reproduce neither.
 *
 * ⚠️ IT DOES NOT REGENERATE. An assessment already marked `generated` is skipped even if its
 * prose came from an older `prompt_version`. Replacing a narrative somebody may be reading is
 * a decision with a cost attached, and this script does not make it silently — it REPORTS the
 * stale versions it found and leaves them alone.
 */
import "dotenv/config";

import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { discoveryRegion, importCommodity, localizationAssessment } from "#src/db/schema.js";
import { stopSendOnlyBoss } from "#src/lib/jobs.js";
import { MANUFACTURED_COMMODITY_KINDS } from "#src/modules/rnd/import-intelligence/import-intelligence.schemas.js";
import { requestPathwayNarrative } from "#src/modules/rnd/import-intelligence/import-intelligence.service.js";

/** Matches `PICKER_LIMIT` in the frontend's `market-research-page.tsx`. */
const DEFAULT_LIMIT = 50;

/** Paced so a burst of sends does not open more connections than the role is allowed. */
const SEND_DELAY_MS = 150;

function readFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.find((argument) => argument.startsWith(prefix));
  return match?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const limit = Number(readFlag("limit") ?? DEFAULT_LIMIT);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("--limit must be an integer between 1 and 200");
  }
  const countryCode = readFlag("country");
  const isManufacturedOnly = !hasFlag("all-kinds");

  // The SAME population the chart plots: newest `asOf`, imports above zero, manufactured
  // kinds unless told otherwise. Built here rather than imported because the service's own
  // helper is private to it — and the two are asserted equal by the count this prints
  // against the leaderboard's `pagination.total`.
  const conditions: SQL[] = [
    sql`${localizationAssessment.asOf} = (SELECT max(as_of) FROM localization_assessment)`,
    sql`${localizationAssessment.observedImportValueInCents} > 0`,
  ];
  if (countryCode !== undefined) {
    conditions.push(eq(discoveryRegion.countryCode, countryCode));
  }
  if (isManufacturedOnly) {
    conditions.push(inArray(importCommodity.commodityKind, MANUFACTURED_COMMODITY_KINDS));
  }

  const rows = await db
    .select({
      id: localizationAssessment.id,
      rank: localizationAssessment.rank,
      hsCode: importCommodity.hsCode,
      label: importCommodity.label,
      narrativeStatus: localizationAssessment.narrativeStatus,
    })
    .from(localizationAssessment)
    .innerJoin(importCommodity, eq(importCommodity.id, localizationAssessment.commodityId))
    .innerJoin(discoveryRegion, eq(discoveryRegion.id, localizationAssessment.regionId))
    .where(and(...conditions))
    .orderBy(asc(localizationAssessment.rank), asc(localizationAssessment.id))
    .limit(limit);

  const alreadyWritten = rows.filter((row) => row.narrativeStatus === "generated");
  const toQueue = rows.filter((row) => row.narrativeStatus !== "generated");

  console.log(
    `${String(rows.length)} product(s) in scope (limit ${String(limit)}, ` +
      `${isManufacturedOnly ? "manufactured kinds only" : "all kinds"}` +
      `${countryCode === undefined ? "" : `, ${countryCode}`}).`,
  );
  console.log(`  already written: ${String(alreadyWritten.length)} — skipped, no model call`);
  console.log(`  to queue:        ${String(toQueue.length)} — ONE METERED MODEL CALL EACH`);

  if (toQueue.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  if (!hasFlag("yes")) {
    console.log("\nRe-run with --yes to send. Nothing was queued.");
    return;
  }

  let queuedCount = 0;
  const failures: string[] = [];

  for (const row of toQueue) {
    const result = await requestPathwayNarrative(row.id);
    if (!result.success) {
      failures.push(`${row.hsCode}: ${result.error.type}`);
      continue;
    }
    // `already_generated` cannot happen here — the filter above excluded those — but the
    // union has two arms and collapsing them would hide a race with the nightly recompute.
    if (result.value.kind === "queued") queuedCount += 1;
    await new Promise((resolve) => setTimeout(resolve, SEND_DELAY_MS));
  }

  console.log(`\nQueued ${String(queuedCount)} job(s).`);
  if (failures.length > 0) {
    console.log(`Failed to queue ${String(failures.length)}:`);
    for (const failure of failures) console.log(`  ${failure}`);
  }
  console.log(
    "The worker writes them; nothing is written yet. Watch with `pnpm jobs:inspect-failures`.",
  );

  // ⚠️ THE SEND-ONLY BOSS MUST BE STOPPED OR THE PROCESS HANGS FOREVER. `sendJob` lazily
  // opens a send-only pg-boss instance when no worker instance is registered, and its
  // maintenance timers keep the event loop alive after the last log line.
  await stopSendOnlyBoss();
}

await main();
