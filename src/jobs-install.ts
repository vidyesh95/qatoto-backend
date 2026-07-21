import "dotenv/config";
import { PgBoss } from "pg-boss";

import { config } from "#src/config/index.js";
import { pool } from "#src/db/index.js";
import {
  createPgBossDbAdapter,
  deadLetterNameFor,
  JOB_DEFINITIONS,
  JOB_NAMES,
  SCHEDULED_JOB_CRONS,
} from "#src/lib/jobs.js";

/**
 * Creates pg-boss's schema, its queues and its cron schedules.
 *
 * THE ONLY PROCESS WITH `migrate: true`. Both runtime processes assert
 * `boss.isInstalled()` and refuse to start otherwise, rather than creating schema on boot.
 *
 * WHY THAT SPLIT MATTERS: a rolling deploy runs two workers concurrently, and relying on
 * a library's internal advisory lock to serialize a schema migration is exactly the kind
 * of implicit dependency this codebase writes long comments to avoid. Making installation
 * an ordered deploy step also means `createQueue` runs once rather than on every boot.
 *
 * Deploy order:
 *   pnpm db:migrate  →  pnpm jobs:install  →  pnpm start / pnpm start:worker
 *
 * THIS FILE LIVES IN src/, NOT scripts/, on purpose. `tsconfig.scripts.json` sets
 * `noEmit: true`, so a scripts/ file never reaches dist/ and could only run under tsx —
 * unacceptable for a step that gates production boot. Here it compiles to
 * dist/jobs-install.js like everything else.
 *
 * Idempotent: re-running it creates nothing that already exists.
 */
async function main(): Promise<void> {
  const boss = new PgBoss({
    db: createPgBossDbAdapter(),
    schema: config.JOBS_SCHEMA,
    migrate: true,
    createSchema: true,
    // Nothing is processed here — this process installs and exits.
    supervise: false,
    schedule: false,
  });

  boss.on("error", (error: unknown) => {
    console.error("pg-boss install error:", error);
  });

  await boss.start();

  const schemaVersion = await boss.schemaVersion();
  console.log(
    `pg-boss schema "${config.JOBS_SCHEMA}" ready (version ${schemaVersion ?? "unknown"}).`,
  );

  for (const definition of Object.values(JOB_DEFINITIONS)) {
    // The dead-letter queue must exist BEFORE the queue that references it, or the
    // reference dangles and a failed job has nowhere to land.
    const deadLetterQueue = deadLetterNameFor(definition.name);
    await boss.createQueue(deadLetterQueue, { policy: "standard" });
    await boss.createQueue(definition.name, definition.queueOptions);
    console.log(`  queue ${definition.name} (dead-letter ${deadLetterQueue})`);
  }

  for (const [tickQueueName, cronExpression] of Object.entries(SCHEDULED_JOB_CRONS)) {
    await boss.schedule(tickQueueName, cronExpression, {});
    console.log(`  schedule ${tickQueueName} @ ${cronExpression} (UTC)`);
  }

  console.log(
    `Installed ${Object.keys(JOB_NAMES).length} queues and ${Object.keys(SCHEDULED_JOB_CRONS).length} schedules.`,
  );

  await boss.stop({ graceful: false, close: false });
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error("Job queue installation failed:", error);
    await pool.end();
    process.exit(1);
  });
