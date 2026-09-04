/**
 * Runs the §10A Comtrade ingest by hand, over the same plan the weekly tick enqueues.
 *
 * WHY IT EXISTS: the tick fans out into pg-boss, and a first backfill should not wait for a
 * Monday — nor should it require the worker process to be running. This calls the job
 * HANDLER directly, in sequence, which is exactly what the worker would do.
 *
 * IT SPENDS ONE COMTRADE REQUEST PER CELL. The default plan is India, six years, both
 * directions — twelve requests against a 500/day free tier. Override with arguments:
 *
 *   pnpm db:sync-comtrade                       # the default plan
 *   pnpm db:sync-comtrade IN 2023 import        # one cell
 *
 * Idempotent: every cell upserts on its partial unique, so re-running replaces figures
 * rather than duplicating them.
 */
import "dotenv/config";
import { pool } from "#src/db/index.js";
import { handleSyncComtradeTradeFlows } from "#src/modules/rnd/import-intelligence/sync-comtrade-trade-flows.js";

const DEFAULT_COUNTRY_CODES = ["IN"] as const;
const DEFAULT_PERIOD_YEARS = [2019, 2020, 2021, 2022, 2023, 2024] as const;
const DEFAULT_FLOW_KINDS = ["import", "export"] as const;

/** Comtrade rate-limits per minute as well as per day, and the limit is undocumented. */
const PAUSE_BETWEEN_CALLS_MS = 1_500;

interface Cell {
  readonly reporterCountryCode: string;
  readonly periodYear: number;
  readonly flowKind: "import" | "export";
}

function parseFlowKinds(argument: string | undefined): readonly ("import" | "export")[] {
  if (argument === undefined) return DEFAULT_FLOW_KINDS;
  if (argument === "import" || argument === "export") return [argument];
  throw new Error(`flow kind must be "import" or "export", got "${argument}"`);
}

function planFromArguments(): readonly Cell[] {
  const [countryCode, periodYear, flowKind] = process.argv.slice(2);

  const countryCodes = countryCode === undefined ? DEFAULT_COUNTRY_CODES : [countryCode];
  const periodYears =
    periodYear === undefined ? DEFAULT_PERIOD_YEARS : [Number.parseInt(periodYear, 10)];
  // Narrowed by a guard rather than asserted: an argv value is a string until something
  // checks it, and `as` would let `pnpm db:sync-comtrade IN 2023 reexport` reach the API.
  const flowKinds = parseFlowKinds(flowKind);

  return countryCodes.flatMap((code) =>
    periodYears.flatMap((year) =>
      flowKinds.map((kind) => ({
        reporterCountryCode: code.toUpperCase(),
        periodYear: year,
        flowKind: kind,
      })),
    ),
  );
}

async function main(): Promise<void> {
  const plan = planFromArguments();
  console.log(`Syncing ${plan.length} cell(s).\n`);

  let failureCount = 0;
  for (const [index, cell] of plan.entries()) {
    const label = `${cell.reporterCountryCode} ${cell.periodYear} ${cell.flowKind}`;
    try {
      await handleSyncComtradeTradeFlows(cell);
      const { rows } = await pool.query<{
        status: string;
        fetched: number;
        upserted: number;
        detail: string | null;
      }>(
        `SELECT status::text, rows_fetched AS fetched, rows_upserted AS upserted, error_detail AS detail
         FROM comtrade_sync_run r
         JOIN discovery_region g ON g.id = r.reporter_region_id
         WHERE g.country_code = $1 AND r.period_year = $2 AND r.flow_kind = $3
         ORDER BY r.requested_at DESC LIMIT 1`,
        [cell.reporterCountryCode, cell.periodYear, cell.flowKind],
      );
      const run = rows[0];
      const passed = run?.status === "succeeded";
      if (!passed) failureCount += 1;
      console.log(
        `${passed ? "OK  " : "FAIL"} ${label} — ${run?.status ?? "no run row"}, ` +
          `${run?.upserted ?? 0} upserted of ${run?.fetched ?? 0} fetched` +
          (run?.detail === null || run?.detail === undefined ? "" : ` · ${run.detail}`),
      );
    } catch (error) {
      failureCount += 1;
      console.log(`FAIL ${label} — ${error instanceof Error ? error.message : "unknown failure"}`);
    }

    if (index < plan.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, PAUSE_BETWEEN_CALLS_MS));
    }
  }

  console.log(
    failureCount === 0
      ? `\nAll ${plan.length} cell(s) synced.`
      : `\n${failureCount} of ${plan.length} cell(s) FAILED.`,
  );
  if (failureCount > 0) process.exitCode = 1;
}

main()
  .then(async () => {
    await pool.end();
    return undefined;
  })
  .catch(async (error: unknown) => {
    console.error("Comtrade backfill failed to run:", error);
    await pool.end();
    process.exit(1);
  });
