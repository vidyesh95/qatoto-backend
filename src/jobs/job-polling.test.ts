import { describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());

// Imported after the environment stub: `#src/lib/jobs.js` parses config at module load.
const { JOB_POLLING_TIERS, workOptionsForQueue } = await import("#src/jobs/job-polling.js");
const { JOB_NAMES, SCHEDULED_JOB_CRONS } = await import("#src/lib/jobs.js");

const EVERY_MINUTE_CRON = "* * * * *";

describe("job polling tiers", () => {
  it("assigns a tier to exactly the registered queues", () => {
    expect(Object.keys(JOB_POLLING_TIERS).toSorted()).toStrictEqual(Object.values(JOB_NAMES).toSorted());
  });

  it("polls every per-minute tick on the interactive tier", () => {
    const everyMinuteTickQueueNames = Object.entries(SCHEDULED_JOB_CRONS)
      .filter(([, cronExpression]) => cronExpression === EVERY_MINUTE_CRON)
      .map(([tickQueueName]) => tickQueueName);

    expect(everyMinuteTickQueueNames).toStrictEqual([
      JOB_NAMES.publishScheduledVideosTick,
      JOB_NAMES.sweepDisputeWindowsTick,
    ]);
    expect(JOB_POLLING_TIERS[JOB_NAMES.publishScheduledVideosTick]).toBe("interactive");
    expect(JOB_POLLING_TIERS[JOB_NAMES.sweepDisputeWindowsTick]).toBe("interactive");
  });

  it("gives an interactive queue a short poll and the configured concurrency", () => {
    expect(workOptionsForQueue(JOB_NAMES.deliverNotification, 3)).toStrictEqual({
      batchSize: 1,
      localConcurrency: 3,
      pollingIntervalSeconds: 5,
      burstWhenReadyExceeds: 1,
    });
  });

  it("gives a background queue a long poll and one job at a time", () => {
    expect(workOptionsForQueue(JOB_NAMES.recomputeOpportunityScoresTick, 3)).toStrictEqual({
      batchSize: 1,
      localConcurrency: 1,
      pollingIntervalSeconds: 60,
      burstWhenReadyExceeds: 1,
    });
  });
});
