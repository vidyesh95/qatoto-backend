import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

/**
 * UNIT tests for the scheduled tick layer — the FIRST test file in `src/jobs/`.
 *
 * SCOPED TO THE SHOWCASE IMAGE SWEEP TICK on purpose, rather than opening with a sweep of all
 * ~30 ticks. That tick takes an INJECTABLE `readClock`, and the parameter exists for exactly this
 * reason and had no caller using it; the others read `systemClock` the same way and can be added
 * here as they grow cases of their own.
 *
 * WHAT A TICK IS FOR, and therefore what is worth asserting: a tick does not do the work. It
 * quantizes "now" to a stable instant and enqueues the real job under a key derived from that
 * instant, so a double cron fire collapses into one job and the job's own 24-hour cutoff is
 * measured from a calendar boundary rather than from whenever the scheduler happened to wake up.
 * Quantization and the key are the whole contract.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());

const sendJob = vi.fn<(...args: readonly unknown[]) => unknown>();

/**
 * `JOB_NAMES` and `idempotencyKeyFor` stay REAL — they are the two things under test here. Stubbing
 * them would let the tick enqueue the wrong job name under a key of the test's own making and still
 * pass.
 */
vi.mock("#src/lib/jobs.js", async () => {
  const actual = await vi.importActual<typeof import("#src/lib/jobs.js")>("#src/lib/jobs.js");
  return { ...actual, sendJob: (...args: readonly unknown[]) => sendJob(...args) };
});

/** A clock frozen at an instant, as `ClockReader` sees it. */
function clockAt(isoInstant: string): () => Date {
  return () => new Date(isoInstant);
}

function sentPayload(): { readonly asOf: string } {
  const [, payload] = sendJob.mock.calls[0] ?? [];
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return payload as { readonly asOf: string };
}

function sentOptions(): { readonly idempotencyKey: string } {
  const [, , options] = sendJob.mock.calls[0] ?? [];
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return options as { readonly idempotencyKey: string };
}

describe("handleSweepOrphanShowcaseImagesTick", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendJob.mockResolvedValue({ success: true, value: { jobId: "job_1" } });
  });

  it("enqueues the sweep job, not its own tick name", async () => {
    const { handleSweepOrphanShowcaseImagesTick } = await import("#src/jobs/scheduled-ticks.js");
    const { JOB_NAMES } = await import("#src/lib/jobs.js");

    await handleSweepOrphanShowcaseImagesTick({}, clockAt("2026-09-12T04:25:00.000Z"));

    expect(sendJob).toHaveBeenCalledTimes(1);
    expect(sendJob.mock.calls[0]?.[0]).toBe(JOB_NAMES.sweepOrphanShowcaseImages);
    expect(sendJob.mock.calls[0]?.[0]).not.toBe(JOB_NAMES.sweepOrphanShowcaseImagesTick);
  });

  /**
   * ROUNDS DOWN TO THE UTC DAY, never to the nearest one. The cron fires at 04:25 UTC, so an
   * unquantized `asOf` would differ every night and the sweep's cutoff would drift with it.
   */
  it("quantizes the clock down to the start of the UTC day", async () => {
    const { handleSweepOrphanShowcaseImagesTick } = await import("#src/jobs/scheduled-ticks.js");

    await handleSweepOrphanShowcaseImagesTick({}, clockAt("2026-09-12T23:59:59.999Z"));

    expect(sentPayload().asOf).toBe("2026-09-12T00:00:00.000Z");
  });

  it("quantizes the first instant of a day to that same day, not the one before", async () => {
    const { handleSweepOrphanShowcaseImagesTick } = await import("#src/jobs/scheduled-ticks.js");

    await handleSweepOrphanShowcaseImagesTick({}, clockAt("2026-09-12T00:00:00.000Z"));

    expect(sentPayload().asOf).toBe("2026-09-12T00:00:00.000Z");
  });

  /**
   * THE COLLAPSE, which is the point of quantizing at all: two firings inside one UTC day carry the
   * same idempotency key, so pg-boss keeps one job. Across midnight they must differ, or the sweep
   * would run once and never again.
   */
  it("derives one idempotency key for two firings inside the same UTC day", async () => {
    const { handleSweepOrphanShowcaseImagesTick } = await import("#src/jobs/scheduled-ticks.js");

    await handleSweepOrphanShowcaseImagesTick({}, clockAt("2026-09-12T04:25:00.000Z"));
    const firstKey = sentOptions().idempotencyKey;
    vi.clearAllMocks();
    sendJob.mockResolvedValue({ success: true, value: { jobId: "job_2" } });
    await handleSweepOrphanShowcaseImagesTick({}, clockAt("2026-09-12T04:26:30.000Z"));
    const secondKey = sentOptions().idempotencyKey;

    expect(secondKey).toBe(firstKey);
  });

  it("derives a different idempotency key across midnight", async () => {
    const { handleSweepOrphanShowcaseImagesTick } = await import("#src/jobs/scheduled-ticks.js");

    await handleSweepOrphanShowcaseImagesTick({}, clockAt("2026-09-12T23:59:00.000Z"));
    const beforeMidnightKey = sentOptions().idempotencyKey;
    vi.clearAllMocks();
    sendJob.mockResolvedValue({ success: true, value: { jobId: "job_2" } });
    await handleSweepOrphanShowcaseImagesTick({}, clockAt("2026-09-13T00:01:00.000Z"));
    const afterMidnightKey = sentOptions().idempotencyKey;

    expect(afterMidnightKey).not.toBe(beforeMidnightKey);
  });

  /** The tick's own payload carries nothing it needs — the clock is the only input. */
  it("ignores its own payload", async () => {
    const { handleSweepOrphanShowcaseImagesTick } = await import("#src/jobs/scheduled-ticks.js");

    await handleSweepOrphanShowcaseImagesTick(
      { asOf: "1999-01-01T00:00:00.000Z", nonsense: true },
      clockAt("2026-09-12T04:25:00.000Z"),
    );

    expect(sentPayload().asOf).toBe("2026-09-12T00:00:00.000Z");
  });

  /**
   * THROWS RATHER THAN LOGGING. A tick that swallows a failed enqueue reports success to pg-boss,
   * which then never retries, and the sweep silently stops running — the failure mode nobody
   * notices until Cloudinary is full of orphans.
   */
  it("throws when the enqueue fails, so pg-boss retries the tick", async () => {
    const { handleSweepOrphanShowcaseImagesTick } = await import("#src/jobs/scheduled-ticks.js");
    sendJob.mockResolvedValue({ success: false, error: { type: "JOB_QUEUE_UNAVAILABLE" } });

    await expect(handleSweepOrphanShowcaseImagesTick({}, clockAt("2026-09-12T04:25:00.000Z"))).rejects.toThrow(
      /sweep-orphan-showcase-images-tick: enqueue failed \(JOB_QUEUE_UNAVAILABLE\)/,
    );
  });
});
