/**
 * The dead-letter drain (R_AND_D_BACKEND_STRUCTURE.md §11l.2 item 10, §4e).
 *
 * WHY THIS EXISTS. `src/worker.ts` has been telling operators to run
 * `pnpm jobs:inspect-failures` since §9 shipped, and there was no such script. Meanwhile
 * `jobs-install.ts` creates a `<queue>-dead` queue for all 27 queues and NOTHING subscribes
 * to any of them — deliberately, because an earlier version's per-DLQ workers exhausted a
 * 20-connection server (worker.ts records the incident). So a dead-lettered job left a
 * `job_failure` row and a message in a queue, and no way to look at either.
 *
 * That matters most for the jobs that move equity: a dead-lettered `finalize-verdict` is a
 * member's claim that never reaches a verdict, which means slices that are never proposed,
 * which means a cap table quietly missing somebody's work.
 *
 *   pnpm jobs:inspect-failures                       # unresolved failures + DLQ depths
 *   pnpm jobs:inspect-failures -- --queue=analyze-daily-log
 *   pnpm jobs:inspect-failures -- --replay=<jobFailureId>
 *   pnpm jobs:inspect-failures -- --resolve=<jobFailureId> --note="fixed by hand"
 *
 * REPLAY RE-ENQUEUES THE ORIGINAL PAYLOAD and marks the row resolved. It does not retry in
 * place: pg-boss has already exhausted the retry policy, and the payload is the only thing
 * worth keeping. Every handler is idempotent by contract (§4e), which is what makes a
 * replay safe rather than a second write.
 */
import "dotenv/config";
import { and, asc, count, desc, eq, isNull } from "drizzle-orm";

import { config } from "#src/config/index.js";
import { db, pool } from "#src/db/index.js";
import { jobFailure } from "#src/db/schema.js";
import {
  JOB_DEFINITIONS,
  sendJob,
  stopSendOnlyBoss,
  type JobName,
  type JobPayload,
} from "#src/lib/jobs.js";

/** Every queue name the registry knows, as a runtime list a string can be checked against. */
const KNOWN_QUEUE_NAMES: readonly JobName[] = Object.values(JOB_DEFINITIONS).map(
  (definition) => definition.name,
);

function readFlag(flagName: string): string | undefined {
  const prefix = `--${flagName}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

/** Unresolved failures, oldest first — the order they should be worked in. */
async function listFailures(queueName: string | undefined): Promise<void> {
  const conditions = [isNull(jobFailure.resolvedAt)];
  if (queueName !== undefined) conditions.push(eq(jobFailure.queueName, queueName));

  const rows = await db
    .select()
    .from(jobFailure)
    .where(and(...conditions))
    .orderBy(asc(jobFailure.failedAt), asc(jobFailure.id))
    .limit(50);

  const [summary] = await db
    .select({ total: count() })
    .from(jobFailure)
    .where(and(...conditions));

  console.log(`\nUNRESOLVED JOB FAILURES: ${String(summary?.total ?? 0)}\n`);

  for (const row of rows) {
    console.log(
      `${row.failedAt.toISOString()}  ${row.queueName}  attempts=${String(row.attemptCount)}\n` +
        `  id       ${row.id}\n` +
        `  jobId    ${row.sourceJobId}\n` +
        `  error    ${row.errorMessage.slice(0, 300)}\n` +
        `  payload  ${row.payloadJson.slice(0, 300)}\n`,
    );
  }

  if (rows.length === 50) {
    // Never truncate silently: a capped list that says nothing reads as "that is all of
    // them", which is the failure mode this whole script exists to end.
    console.log("… 50 shown. Narrow with --queue=<name>.\n");
  }

  const byQueue = await db
    .select({ queueName: jobFailure.queueName, total: count() })
    .from(jobFailure)
    .where(isNull(jobFailure.resolvedAt))
    .groupBy(jobFailure.queueName)
    .orderBy(desc(count()));

  if (byQueue.length > 0) {
    console.log("BY QUEUE");
    for (const group of byQueue) {
      console.log(`  ${String(group.total).padStart(5)}  ${group.queueName}`);
    }
  }
}

/**
 * Depth of every `<queue>-dead` queue, straight from pg-boss's own table.
 *
 * Read with raw SQL because pg-boss owns that schema and this repo deliberately keeps it
 * out of `schema.ts` (`drizzle.config.ts` sets `schemaFilter: ["public"]`).
 */
async function reportDeadLetterDepths(): Promise<void> {
  const deadQueueNames = Object.values(JOB_DEFINITIONS).map(
    (definition) => `${definition.name}-dead`,
  );

  const result = await pool.query<{ name: string; total: string }>(
    `SELECT name, count(*)::text AS total
       FROM ${config.JOBS_SCHEMA}.job
      WHERE name = ANY($1)
      GROUP BY name
      ORDER BY count(*) DESC`,
    [deadQueueNames],
  );

  console.log("\nDEAD-LETTER QUEUE DEPTHS");
  if (result.rows.length === 0) {
    console.log("  all empty");
    return;
  }
  for (const row of result.rows) {
    console.log(`  ${row.total.padStart(5)}  ${row.name}`);
  }
}

/**
 * Re-enqueues a payload read back from `job_failure`.
 *
 * The signature is generic over the queue name so the payload type resolves per queue,
 * which is what lets a stored JSON string reach `sendJob` without an assertion at the call
 * site. `sendJob` re-validates against the queue's own `.strict()` schema regardless.
 */
async function enqueueStoredPayload<TName extends JobName>(
  queueName: TName,
  payloadJson: string,
): Promise<Awaited<ReturnType<typeof sendJob<TName>>>> {
  // The stored payload is JSON of unknown shape, and the queue's own `.strict()` schema
  // inside `sendJob` is what decides whether it is still valid — parsing it here only has
  // to produce a value. Validating it TWICE would mean importing the schema registry and
  // duplicating the decision `sendJob` already owns.
  const payload: JobPayload<TName> = JSON.parse(payloadJson);
  return sendJob(queueName, payload);
}

async function replay(failureId: string): Promise<void> {
  const [failure] = await db.select().from(jobFailure).where(eq(jobFailure.id, failureId));

  if (!failure) {
    throw new Error(`No job_failure row with id ${failureId}.`);
  }
  if (failure.resolvedAt !== null) {
    throw new Error(`${failureId} is already resolved (${failure.resolvedAt.toISOString()}).`);
  }

  // A runtime guard rather than an assertion: `job_failure.queue_name` is free text — the
  // row survives a queue being retired, which is exactly when a replay must refuse.
  const queueName = KNOWN_QUEUE_NAMES.find((name) => name === failure.queueName);
  if (queueName === undefined) {
    throw new Error(`${failure.queueName} is not a known queue — it may have been retired.`);
  }

  // `sendJob` validates the payload against the queue's schema on the way out, so a payload
  // that no longer matches a changed contract fails HERE rather than in a worker at 3am.
  // That runtime check is the real gate; the parse below only has to produce a value.
  const enqueued = await enqueueStoredPayload(queueName, failure.payloadJson);

  if (!enqueued.success) {
    throw new Error(`Re-enqueue refused: ${enqueued.error.type}`);
  }

  await db
    .update(jobFailure)
    .set({
      resolvedAt: new Date(),
      resolutionNote: `replayed as job ${enqueued.value.jobId ?? "(deduplicated)"}`,
    })
    .where(eq(jobFailure.id, failureId));

  console.log(`Replayed ${failure.queueName} — new job id ${enqueued.value.jobId ?? "(deduped)"}`);
}

async function resolve(failureId: string, note: string): Promise<void> {
  const updated = await db
    .update(jobFailure)
    .set({ resolvedAt: new Date(), resolutionNote: note })
    .where(and(eq(jobFailure.id, failureId), isNull(jobFailure.resolvedAt)))
    .returning({ id: jobFailure.id });

  if (updated.length === 0) {
    throw new Error(`No unresolved job_failure row with id ${failureId}.`);
  }
  console.log(`Marked ${failureId} resolved: ${note}`);
}

async function main(): Promise<void> {
  const replayId = readFlag("replay");
  const resolveId = readFlag("resolve");

  if (replayId !== undefined) {
    await replay(replayId);
    return;
  }

  if (resolveId !== undefined) {
    await resolve(resolveId, readFlag("note") ?? "resolved by hand");
    return;
  }

  await listFailures(readFlag("queue"));
  await reportDeadLetterDepths();
  console.log(
    "\nReplay one with:  pnpm jobs:inspect-failures -- --replay=<id>" +
      "\nEvery handler is idempotent by contract (§4e), so a replay is safe.\n",
  );
}

main()
  .then(async () => {
    await stopSendOnlyBoss();
    await pool.end();
    return undefined;
  })
  .catch(async (error: unknown) => {
    console.error("Job failure inspection failed:", error);
    await stopSendOnlyBoss();
    await pool.end();
    process.exit(1);
  });
