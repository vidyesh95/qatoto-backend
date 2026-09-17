/**
 * Runs every `*.bench.ts` suite, in one process, in a declared order.
 *
 * WHY AN EXPLICIT LIST RATHER THAN A GLOB. The list is the contract with CI: a suite that is not
 * on it is not measured, and a suite that is measured under one name on `main` and another name on
 * a branch is a benchmark CodSpeed cannot compare. Both failures are silent with a glob — a file
 * renamed by a refactor simply stops being reported — and both are a compile error here.
 *
 * WHY ONE PROCESS. Under `codspeed run` each task is measured individually (the plugin warms the
 * function up, then instruments exactly one call), so process startup is not inside any
 * measurement. Spawning a process per suite would only multiply Node's boot cost by nine.
 *
 *   pnpm bench                            # locally: real sampling, a table per suite
 *   codspeed run --mode simulation -- pnpm bench   # in CI: instrumented, one sample per task
 *
 * The suites are deliberately free of I/O — no database, no network, no filesystem. Everything
 * measured here is pure computation, which is what makes the CPU simulation instrument the right
 * one for this repository.
 */
import { canonicalHashBenchmarks } from "#src/lib/canonical-hash.bench.js";
import { dailyLogStreakBenchmarks } from "#src/lib/daily-log-streak.bench.js";
import { feedScoreBenchmarks } from "#src/lib/feed-score.bench.js";
import { moneyBenchmarks } from "#src/lib/money.bench.js";
import { orderingBenchmarks } from "#src/lib/ordering.bench.js";
import { youtubeBenchmarks } from "#src/lib/youtube.bench.js";
import { affinityScoreBenchmarks } from "#src/modules/home/affinity-score.bench.js";
import { showcaseLaunchMarkdownBenchmarks } from "#src/modules/home/blueprints/showcase-launch-markdown.bench.js";
import { viewBeaconClampBenchmarks } from "#src/modules/home/view-beacon-clamp.bench.js";

const BENCHMARK_SUITES = [
  moneyBenchmarks,
  orderingBenchmarks,
  canonicalHashBenchmarks,
  feedScoreBenchmarks,
  affinityScoreBenchmarks,
  viewBeaconClampBenchmarks,
  dailyLogStreakBenchmarks,
  youtubeBenchmarks,
  showcaseLaunchMarkdownBenchmarks,
];

async function main(): Promise<void> {
  for (const suite of BENCHMARK_SUITES) {
    await suite.run();

    // Under CodSpeed the tasks carry no sampled result — the instrument holds the measurement —
    // so there is nothing to tabulate and the runner prints its own per-task lines instead.
    const rows = suite.table().filter((row) => row !== null);
    if (rows.length > 0) {
      console.log(`\n${suite.name ?? "benchmarks"}`);
      console.table(rows);
    }
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error("Running benchmarks failed:", error);
    process.exit(1);
  });
