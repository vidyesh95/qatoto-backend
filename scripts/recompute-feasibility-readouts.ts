/**
 * Runs the nightly feasibility readout by hand, for today's UTC day.
 *
 * WHY IT EXISTS: the job runs at 04:10 UTC, and after the first World Bank pull somebody needs a
 * readout before tomorrow — a scheduled job an operator cannot trigger cannot be tested. It
 * calls the same function the job handler calls.
 *
 * IDEMPOTENT: `ON CONFLICT DO NOTHING` on (asOf, region, domain), and `asOf` is the UTC day, so a
 * second run the same day writes nothing new.
 *
 *   pnpm db:recompute-feasibility
 */
import "dotenv/config";
import { pool } from "#src/db/index.js";
import { recomputeFeasibilityReadouts } from "#src/modules/rnd/discovery/recompute-feasibility-readouts.js";

function truncateToUtcDayStart(instant: Date): Date {
  return new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()));
}

async function main(): Promise<void> {
  const asOf = truncateToUtcDayStart(new Date());
  console.log(`Recomputing feasibility readouts as of ${asOf.toISOString()} …`);
  const summary = await recomputeFeasibilityReadouts(asOf);
  console.log(
    `${String(summary.cellCount)} (country, domain) cells: ${String(summary.cellsWithNeedDensity)} with need density, ${String(summary.countriesWithPurchasingPower)} countries with purchasing power, ${String(summary.cellsWithManufacturing)} with manufacturing, ${String(summary.countriesWithRegulatoryFramework)} countries with a regulatory framework score.`,
  );
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error("Feasibility readout recompute failed:", error);
    await pool.end();
    process.exit(1);
  });
