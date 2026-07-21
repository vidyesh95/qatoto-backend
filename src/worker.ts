import "dotenv/config";

import { PgBoss } from "pg-boss";
import type { Job } from "pg-boss";

import { config } from "#src/config/index.js";
import { createDedicatedPool, db, pool } from "#src/db/index.js";
import { jobFailure } from "#src/db/schema.js";
import { handleGeocodeAndClusterSubmission } from "#src/jobs/geocode-and-cluster-submission.js";
import { handleRecomputeDemandSignals } from "#src/jobs/recompute-demand-signals.js";
import { handleRecomputeOpportunityScores } from "#src/jobs/recompute-opportunity-scores.js";
import { handleRefreshTalentProjections } from "#src/jobs/refresh-talent-projections.js";
import {
  handleRecomputeDemandSignalsTick,
  handleRecomputeOpportunityScoresTick,
  handleRefreshTalentProjectionsTick,
} from "#src/jobs/scheduled-ticks.js";
import {
  createPgBossDbAdapter,
  JOB_NAMES,
  PermanentJobError,
  stopSendOnlyBoss,
  type JobName,
} from "#src/lib/jobs.js";

/**
 * The background worker process (R_AND_D_BACKEND_STRUCTURE.md §4e).
 *
 * WHY A SEPARATE ENTRYPOINT AND NOT IN-PROCESS WITH EXPRESS. Three reasons, and the
 * first is decisive:
 *
 *   1. `pnpm build` is a bare `tsc` with rootDir ./src and outDir ./dist, so a file HERE
 *      compiles to dist/worker.js with no build-config change. `tsconfig.scripts.json`
 *      sets `noEmit: true`, so anything under scripts/ is never built into dist/ and
 *      could only ever run under tsx — not acceptable for a production worker.
 *   2. CPU isolation. The recompute jobs scan every cluster, and §9's verification
 *      pipeline will be CPU-bound; sharing the API's event loop makes every run a p99
 *      latency spike on every in-flight request.
 *   3. Independent lifecycle. A worker OOM must not drop in-flight HTTP requests, and a
 *      deploy that only changes a scoring ladder must not cycle the API.
 *
 * The deploy shape is unchanged: same image, same dist/, different command — which is
 * what kept "no new infrastructure to operate" true when pg-boss was chosen over Redis.
 */

// STRICTER THAN THE API's PRODUCTION-ONLY CHECK, deliberately. src/config/index.ts asserts
// TZ=UTC only in production, which is right for the API — a developer's laptop must boot.
// It is NOT right here: a job's `asOf` is PERSISTED and later compared for byte-identity,
// so a worker on a non-UTC host writes values a UTC host can never reproduce, and the
// divergence is silent. src/db/index.ts pins the timestamp PARSER to UTC, which fixes
// reads; this pins the process that WRITES them.
if (process.env.TZ !== "UTC") {
  throw new Error(
    `Worker requires TZ="UTC" (received ${process.env.TZ ?? "unset"}). ` +
      "Job asOf values are persisted and compared byte-for-byte; a non-UTC worker " +
      "produces values that cannot be reproduced elsewhere.",
  );
}

/**
 * The worker's OWN pool, separate from the API's.
 *
 * pg-boss polls every queue on a fixed interval, so its connection demand is steady and
 * concurrent rather than request-shaped. Sharing the API's pool means a burst of polls
 * competes with HTTP handlers for the same scarce connections — and on a server capped at
 * twenty TOTAL, that is how a background job takes down the request path.
 */
const workerPool = createDedicatedPool(config.WORKER_DATABASE_POOL_MAX);

workerPool.on("error", (error: unknown) => {
  console.error("Unexpected error on idle worker database client", error);
});

const boss = new PgBoss({
  db: createPgBossDbAdapter(workerPool),
  schema: config.JOBS_SCHEMA,
  // Neither runtime process migrates. `pnpm jobs:install` owns that, as an ordered deploy
  // step — see the isInstalled() assertion below.
  migrate: false,
  supervise: true,
  schedule: true,
});

boss.on("error", (error: unknown) => {
  console.error("pg-boss worker error:", error);
});

/**
 * Wraps a handler so every failure is classified and recorded.
 *
 * A `PermanentJobError` (a payload that cannot parse) is rethrown after being written to
 * `job_failure`, because retrying it can never succeed. Everything else is rethrown
 * unwrapped so pg-boss applies its exponential backoff.
 */
function runJob(
  jobName: JobName,
  handler: (rawPayload: unknown) => Promise<void>,
): (jobs: Job[]) => Promise<void> {
  return async (jobs: Job[]): Promise<void> => {
    // pg-boss v10+ ALWAYS hands the handler an array, even at batchSize 1. Writing this
    // as `async (job) => …` compiles and then silently treats an array as a job.
    for (const job of jobs) {
      try {
        await handler(job.data);
      } catch (error: unknown) {
        const isPermanent = error instanceof PermanentJobError;
        console.error(
          `job ${jobName} ${job.id} failed (${isPermanent ? "permanent" : "retryable"}):`,
          error,
        );

        if (isPermanent) {
          await recordJobFailure(jobName, job, error);
        }
        throw error;
      }
    }
  };
}

/**
 * Captures a dead-lettered job for a human.
 *
 * NOT OPTIONAL. pg-boss deletes completed and failed jobs after `deleteAfterSeconds`
 * (7 days by default), so a dead-lettered job nobody drains becomes indistinguishable
 * from a job that never existed — a report whose clustering failed would simply vanish,
 * with the reporter seeing "queued" forever and no operator surface showing why.
 */
async function recordJobFailure(
  queueName: string,
  job: Job,
  error: unknown,
): Promise<void> {
  try {
    await db
      .insert(jobFailure)
      .values({
        queueName,
        sourceJobId: job.id,
        payloadJson: JSON.stringify(job.data),
        errorMessage: error instanceof Error ? error.message : String(error),
        // pg-boss exposes the retry count only on the metadata-bearing handler shape;
        // 0 is honest here rather than guessed.
        attemptCount: 0,
      })
      .onConflictDoNothing({ target: jobFailure.sourceJobId });
  } catch (recordError: unknown) {
    // Never let the audit write mask the original failure.
    console.error("failed to record job failure:", recordError);
  }
}

async function startWorker(): Promise<void> {
  await boss.start();

  if (!(await boss.isInstalled())) {
    throw new Error(
      "pg-boss schema is not installed — run `pnpm jobs:install` after `pnpm db:migrate`.",
    );
  }

  const workOptions = { batchSize: 1, localConcurrency: config.WORKER_CONCURRENCY } as const;

  await boss.work(
    JOB_NAMES.geocodeAndClusterSubmission,
    workOptions,
    runJob(JOB_NAMES.geocodeAndClusterSubmission, handleGeocodeAndClusterSubmission),
  );
  await boss.work(
    JOB_NAMES.recomputeOpportunityScoresTick,
    workOptions,
    runJob(JOB_NAMES.recomputeOpportunityScoresTick, handleRecomputeOpportunityScoresTick),
  );
  await boss.work(
    JOB_NAMES.recomputeOpportunityScores,
    workOptions,
    runJob(JOB_NAMES.recomputeOpportunityScores, handleRecomputeOpportunityScores),
  );
  await boss.work(
    JOB_NAMES.recomputeDemandSignalsTick,
    workOptions,
    runJob(JOB_NAMES.recomputeDemandSignalsTick, handleRecomputeDemandSignalsTick),
  );
  await boss.work(
    JOB_NAMES.recomputeDemandSignals,
    workOptions,
    runJob(JOB_NAMES.recomputeDemandSignals, handleRecomputeDemandSignals),
  );
  await boss.work(
    JOB_NAMES.refreshTalentProjectionsTick,
    workOptions,
    runJob(JOB_NAMES.refreshTalentProjectionsTick, handleRefreshTalentProjectionsTick),
  );
  await boss.work(
    JOB_NAMES.refreshTalentProjections,
    workOptions,
    runJob(JOB_NAMES.refreshTalentProjections, handleRefreshTalentProjections),
  );

  // THE DEAD-LETTER QUEUES DELIBERATELY HAVE NO ALWAYS-ON WORKERS.
  //
  // An earlier version subscribed one worker per dead-letter queue, which doubled the
  // polling worker count to fourteen and exhausted the server's connection limit outright
  // (`FATAL: sorry, too many clients already`) — the managed instance allows twenty
  // connections FOR THE WHOLE SERVER, shared with the API and every script.
  //
  // Nothing is lost by dropping them. Failed jobs still LAND in their dead-letter queue
  // and persist there for pg-boss's retention window, and `runJob` above already records
  // every permanent failure into `job_failure` at the moment it happens. Draining the
  // queues is an operator action, not a background one: `pnpm jobs:inspect-failures`.
  console.log(
    `Worker running [${config.NODE_ENV}] — ${Object.keys(JOB_NAMES).length} queues, ` +
      `concurrency ${config.WORKER_CONCURRENCY}, pool ${config.WORKER_DATABASE_POOL_MAX}`,
  );
}

// The force-exit timer MUST exceed the boss stop timeout. Copying src/index.ts's 10s
// verbatim would process.exit(1) fifteen seconds into a twenty-five second drain, killing
// in-flight jobs — which is survivable only because every handler is idempotent, and
// should not be relied on.
const BOSS_STOP_TIMEOUT_MS = 25_000;
const FORCE_EXIT_MS = 30_000;

async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`\n${signal} received. Draining jobs...`);

  const forceExit = setTimeout(() => {
    console.error("Forced shutdown after timeout.");
    process.exit(1);
  }, FORCE_EXIT_MS);

  try {
    // close: false — pg-boss must not close a pool it does not own.
    await boss.stop({ graceful: true, timeout: BOSS_STOP_TIMEOUT_MS, close: false });
    console.log("Workers drained.");
    await stopSendOnlyBoss();
    // Both pools: the dedicated worker pool created above, and the shared one the
    // handlers use through `db`.
    await workerPool.end();
    await pool.end();
    console.log("Database pools closed.");
  } catch (error: unknown) {
    console.error("Error during worker shutdown:", error);
  }

  clearTimeout(forceExit);
  process.exit(0);
}

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

startWorker().catch((error: unknown) => {
  console.error("Worker failed to start:", error);
  process.exit(1);
});
