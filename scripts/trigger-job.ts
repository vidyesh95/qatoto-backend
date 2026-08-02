/**
 * Enqueue a scheduled job by hand (HOME_BACKEND_STRUCTURE.md §10).
 *
 * WHY THIS EXISTS. §10's verification list says "trigger each new job by hand and inspect
 * `scripts/inspect-job-failures.ts`" — and there was no way to do the first half. The only
 * routes were waiting for the cron (up to 24 hours for the nightly chain) or hand-writing a
 * `pgboss.send` in a throwaway script, which is what actually happened while phase 3 was
 * being verified. A verification step nobody can run is a verification step nobody runs.
 *
 *   pnpm jobs:trigger recompute-video-quality-scores
 *   pnpm jobs:trigger recompute-trending-videos
 *   pnpm jobs:trigger prune-engagement-data -- --as-of=2026-08-01T00:00:00.000Z
 *   pnpm jobs:trigger -- --list
 *
 * IT GOES THROUGH `sendJob`, NOT `boss.send`. That is the whole point of the indirection:
 * the payload is re-validated against the queue's own `.strict()` schema and the
 * idempotency key is derived the same way the tick derives it. So triggering a job by hand
 * for an `asOf` a tick has already fired is a NO-OP rather than a duplicate run — which is
 * exactly what an operator re-running a recompute needs it to be.
 *
 * THE asOf IS QUANTIZED, always. Passing a raw instant would create a run at a boundary no
 * tick will ever produce, and its snapshot rows would then be invisible to every "latest
 * as_of" read in the system. `--as-of` is truncated to the same UTC boundary the job's tick
 * uses, so a hand-triggered run is indistinguishable from a scheduled one.
 */
import "dotenv/config";
import { truncateToUtcDayStart, truncateToUtcHourStart } from "#src/lib/as-of.js";
import { idempotencyKeyFor, JOB_NAMES, sendJob, stopSendOnlyBoss } from "#src/lib/jobs.js";

/**
 * The jobs this script can start, and how each one's `asOf` is quantized.
 *
 * AN EXPLICIT ALLOWLIST, not `Object.values(JOB_DEFINITIONS)`. Most queues in the registry
 * take a payload naming a specific row — a submission id, a claim id, a notification id —
 * and starting one of those from a shell with a hand-typed id is a way to run a pipeline
 * against the wrong record. The jobs below are the ones whose payload is an `asOf` and
 * nothing else, so there is no id to get wrong.
 */
const TRIGGERABLE_JOBS = {
  [JOB_NAMES.recomputeVideoDurations]: {
    grain: "day",
    idempotencyKey: idempotencyKeyFor.recomputeVideoDurations,
  },
  [JOB_NAMES.recomputeVideoQualityScores]: {
    grain: "day",
    idempotencyKey: idempotencyKeyFor.recomputeVideoQualityScores,
  },
  [JOB_NAMES.recomputePlatformCategoryPopularity]: {
    grain: "day",
    idempotencyKey: idempotencyKeyFor.recomputePlatformCategoryPopularity,
  },
  [JOB_NAMES.recomputeUserAffinities]: {
    grain: "day",
    idempotencyKey: idempotencyKeyFor.recomputeUserAffinities,
  },
  // The one hourly job in the domain, and therefore the one whose asOf is an hour start.
  [JOB_NAMES.recomputeTrendingVideos]: {
    grain: "hour",
    idempotencyKey: idempotencyKeyFor.recomputeTrendingVideos,
  },
  [JOB_NAMES.revalidateYoutubeEmbeds]: {
    grain: "day",
    idempotencyKey: idempotencyKeyFor.revalidateYoutubeEmbeds,
  },
  [JOB_NAMES.pruneEngagementData]: {
    grain: "day",
    idempotencyKey: idempotencyKeyFor.pruneEngagementData,
  },
} as const satisfies Record<
  string,
  { readonly grain: "day" | "hour"; readonly idempotencyKey: (asOfIso: string) => string }
>;

type TriggerableJobName = keyof typeof TRIGGERABLE_JOBS;

/**
 * A type PREDICATE, not a `as` assertion (CLAUDE.md §2). The difference matters here: an
 * assertion would tell the compiler a string is a job name, whereas this checks it — and
 * the string came from `process.argv`, which is exactly the kind of input the rule exists
 * for.
 */
function isTriggerableJobName(candidate: string): candidate is TriggerableJobName {
  return Object.hasOwn(TRIGGERABLE_JOBS, candidate);
}

function readFlag(flagName: string): string | undefined {
  const prefix = `--${flagName}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function printUsage(): void {
  console.log("Usage: pnpm jobs:trigger <job-name> [-- --as-of=<ISO instant>]\n");
  console.log("Triggerable jobs:");
  for (const [jobName, definition] of Object.entries(TRIGGERABLE_JOBS)) {
    console.log(`  ${jobName.padEnd(42)} asOf quantized to the UTC ${definition.grain}`);
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--list")) {
    printUsage();
    return;
  }

  const requestedJobName = process.argv.slice(2).find((argument) => !argument.startsWith("--"));

  if (requestedJobName === undefined) {
    printUsage();
    throw new Error("trigger-job: no job name given");
  }

  if (!isTriggerableJobName(requestedJobName)) {
    printUsage();
    throw new Error(`trigger-job: ${requestedJobName} is not a triggerable job`);
  }

  const definition = TRIGGERABLE_JOBS[requestedJobName];

  const requestedAsOf = readFlag("as-of");
  // Rejected rather than silently defaulted: a typo'd instant that fell back to "now"
  // would run against a boundary the operator did not ask for and report success.
  if (requestedAsOf !== undefined && Number.isNaN(new Date(requestedAsOf).getTime())) {
    throw new Error(`trigger-job: --as-of=${requestedAsOf} is not a valid instant`);
  }

  const instant = requestedAsOf === undefined ? new Date() : new Date(requestedAsOf);
  const asOf =
    definition.grain === "hour" ? truncateToUtcHourStart(instant) : truncateToUtcDayStart(instant);
  const asOfIso = asOf.toISOString();

  const enqueueResult = await sendJob(
    requestedJobName,
    { asOf: asOfIso },
    { idempotencyKey: definition.idempotencyKey(asOfIso) },
  );

  if (!enqueueResult.success) {
    throw new Error(`trigger-job: enqueue failed (${enqueueResult.error.type})`);
  }

  // A NULL job id is a SUCCESS, not a failure: it means this asOf was already enqueued and
  // pg-boss deduplicated it. Reporting that plainly is better than an operator re-running
  // the command because it "looked like nothing happened".
  console.log(
    enqueueResult.value.jobId === null
      ? `${requestedJobName} @ ${asOfIso} — already queued for this asOf, deduplicated (no-op)`
      : `${requestedJobName} @ ${asOfIso} — enqueued as ${enqueueResult.value.jobId}`,
  );
  console.log("Watch the worker log; inspect failures with `pnpm jobs:inspect-failures`.");
}

main()
  .then(async () => {
    await stopSendOnlyBoss();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    await stopSendOnlyBoss();
    process.exit(1);
  });
