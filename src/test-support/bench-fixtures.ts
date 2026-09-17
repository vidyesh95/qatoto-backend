/**
 * Deterministic inputs for the `*.bench.ts` suites.
 *
 * WHY A SEEDED GENERATOR RATHER THAN `Math.random()`. CodSpeed compares a benchmark against the
 * same benchmark on another commit, so the only difference between the two runs must be the code
 * under measurement. A random fixture moves the amount of work — a feed page whose rows happen to
 * share a creator takes a different branch in `applyDiversityCaps` than one whose rows do not —
 * and the report then reads as a regression that no commit caused.
 *
 * The generators are therefore pure functions of a seed, and every seed is written at the call
 * site. Two runs of the same commit build byte-identical fixtures.
 *
 * FIXTURES ARE BUILT OUTSIDE THE MEASURED CALLBACK, always. `bench()` measures what its callback
 * does; building a thousand rows inside one would measure this file instead of the code it exists
 * to exercise.
 */

/**
 * The tinybench settings every suite shares.
 *
 * THEY ONLY MATTER OUTSIDE CodSpeed. Under `codspeed run` the plugin replaces the sampling loop
 * outright — it warms the function up, then measures ONE instrumented call — so the sampling
 * budget below changes nothing about what CI reports. Locally it is what keeps `pnpm bench` to a
 * few seconds while still producing numbers stable enough to compare two local edits.
 *
 * `throws` is not a convenience: a task that throws is otherwise recorded as an error on the task
 * and the run still exits 0, which is how a benchmark quietly stops measuring anything.
 */
export const BENCHMARK_OPTIONS = {
  time: 200,
  warmupTime: 100,
  throws: true,
} as const;

/**
 * How many times a single-call benchmark repeats its call.
 *
 * THERE IS A FLOOR UNDER WHAT CAN BE PROFILED. A benchmark that finishes in tens of microseconds
 * is measured fine, but CodSpeed collects no execution profile for it — there are not enough
 * samples to build a flame graph from, and the report says so. The functions worth measuring on
 * their own here are genuinely that small (a clamp, a regex test), so the ones that would fall
 * under the floor repeat instead, which costs nothing in comparability: the repeat count is fixed,
 * so the number moves only when the function does.
 */
export const MICRO_BENCHMARK_REPEATS = 1000;

/**
 * Mulberry32 — 32 bits of state, uniform output, and short enough to read in one sitting.
 *
 * Not cryptographic and not meant to be: the only property required here is that the same seed
 * produces the same sequence on every platform the benchmarks run on.
 */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A uniformly distributed integer in `[0, bound)`. */
export function seededInteger(random: () => number, bound: number): number {
  return Math.floor(random() * bound);
}

/**
 * The row shape the two post-rank feed passes read — `RankedFeedRow` in `#src/lib/feed-score.js`,
 * restated structurally so this module stays free of production imports.
 */
export interface BenchmarkFeedRow {
  readonly videoId: string;
  readonly creatorId: string;
  readonly categorySlugs: readonly string[];
}

const BENCHMARK_CATEGORY_SLUGS = [
  "electronics",
  "machining",
  "textiles",
  "packaging",
  "agri-processing",
  "mobility",
] as const;

/**
 * A ranked feed's worth of rows, with the two distributions that decide how much work the
 * post-rank passes actually do:
 *
 *   - a SMALL creator pool, so the per-creator cap is breached repeatedly rather than never;
 *   - zero, one or two category slugs per row, so the untagged fast path is exercised too.
 */
export function buildRankedFeedRows(rowCount: number, seed = 1): readonly BenchmarkFeedRow[] {
  const random = createSeededRandom(seed);
  const creatorPoolSize = Math.max(1, Math.floor(rowCount / 8));
  const rows: BenchmarkFeedRow[] = [];

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const slugCount = seededInteger(random, 3);
    const slugs = new Set<string>();
    for (let slotIndex = 0; slotIndex < slugCount; slotIndex += 1) {
      slugs.add(
        BENCHMARK_CATEGORY_SLUGS[seededInteger(random, BENCHMARK_CATEGORY_SLUGS.length)] ??
          "electronics",
      );
    }

    rows.push({
      videoId: `video-${String(rowIndex).padStart(6, "0")}`,
      creatorId: `creator-${String(seededInteger(random, creatorPoolSize)).padStart(4, "0")}`,
      categorySlugs: [...slugs],
    });
  }

  return rows;
}
