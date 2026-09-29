/**
 * Pulls World Bank GDP per capita (PPP) for every seeded country, by hand.
 *
 * WHY IT EXISTS: the job is weekly (Monday 01:40 UTC), and after a first deploy somebody needs
 * the purchasing-power pillar before next Monday. It calls the same function the job handler
 * calls, so it exercises the real path. Keyless — there is nothing to configure.
 *
 * IDEMPOTENT: an upsert on (region, indicator, year).
 *
 *   pnpm db:sync-world-bank
 */
import "dotenv/config";
import { pool } from "#src/db/index.js";
import { syncWorldBankIndicators } from "#src/modules/rnd/discovery/sync-world-bank-indicators.js";

async function main(): Promise<void> {
  const summary = await syncWorldBankIndicators();
  console.log(
    `World Bank: ${String(summary.observationsUpserted)} observations upserted across ${String(summary.countryCount)} countries.`,
  );
  if (summary.countriesWithNoValue.length > 0) {
    console.log(`No published value for: ${summary.countriesWithNoValue.join(", ")}`);
  }
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error("World Bank sync failed:", error);
    await pool.end();
    process.exit(1);
  });
