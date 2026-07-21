import { truncateToUtcDayStart, truncateToUtcHourStart } from "#src/lib/as-of.js";
import { idempotencyKeyFor, JOB_NAMES, sendJob } from "#src/lib/jobs.js";

/**
 * The tick handlers: quantize "now", then enqueue the real job with an explicit `asOf`.
 *
 * WHY THESE EXIST AT ALL (R_AND_D_BACKEND_STRUCTURE.md §4c rule 3). `boss.schedule()`
 * sends a FIXED payload on a cron, so a directly-scheduled job cannot carry the run's
 * reference instant — it would have to read the clock inside the handler, which makes the
 * job a function of wall-clock time rather than of `(data, asOf)` and destroys
 * replayability.
 *
 * Splitting each scheduled job into a tick plus the real job buys three things:
 *   - the queued job row CARRIES its own asOf, so the run is replayable from the queue;
 *   - a double cron fire inside the same UTC day dedups to one job id, because the id is
 *     derived from the asOf;
 *   - an operator can replay any historical asOf with a single `send`, by hand.
 *
 * A tick does no domain work whatsoever. That is the point: the only thing that reads the
 * clock in this entire domain is these four lines.
 */

/**
 * `new Date()` IS called here, and this is the one place it is correct.
 *
 * Isolating the clock read into the tick — and immediately quantizing it — is what lets
 * every downstream handler be a pure function of its payload. Injected rather than
 * imported directly so a test can pin it.
 */
type ClockReader = () => Date;

const systemClock: ClockReader = () => new Date();

export async function handleRecomputeOpportunityScoresTick(
  _rawPayload: unknown,
  readClock: ClockReader = systemClock,
): Promise<void> {
  const asOf = truncateToUtcDayStart(readClock());
  const asOfIso = asOf.toISOString();

  const enqueueResult = await sendJob(
    JOB_NAMES.recomputeOpportunityScores,
    { asOf: asOfIso },
    { idempotencyKey: idempotencyKeyFor.recomputeOpportunityScores(asOfIso) },
  );

  if (!enqueueResult.success) {
    throw new Error(
      `recompute-opportunity-scores-tick: enqueue failed (${enqueueResult.error.type})`,
    );
  }
}

/** The demand window: the 30 days ending at `asOf`, as ABSOLUTE instants (§4c rule 3). */
const DEMAND_WINDOW_DAYS = 30;
const MILLISECONDS_PER_DAY = 86_400_000;

export async function handleRecomputeDemandSignalsTick(
  _rawPayload: unknown,
  readClock: ClockReader = systemClock,
): Promise<void> {
  const asOf = truncateToUtcDayStart(readClock());
  const asOfIso = asOf.toISOString();
  const windowStartsAt = new Date(asOf.getTime() - DEMAND_WINDOW_DAYS * MILLISECONDS_PER_DAY);

  const enqueueResult = await sendJob(
    JOB_NAMES.recomputeDemandSignals,
    {
      asOf: asOfIso,
      windowStartsAt: windowStartsAt.toISOString(),
      // The window ENDS at asOf, so the two are equal by construction. Stored separately
      // anyway because a future job may want a lagged window, and a row that records both
      // is readable a year later without knowing today's convention.
      windowEndsAt: asOfIso,
    },
    { idempotencyKey: idempotencyKeyFor.recomputeDemandSignals(asOfIso) },
  );

  if (!enqueueResult.success) {
    throw new Error(`recompute-demand-signals-tick: enqueue failed (${enqueueResult.error.type})`);
  }
}

export async function handleRefreshTalentProjectionsTick(
  _rawPayload: unknown,
  readClock: ClockReader = systemClock,
): Promise<void> {
  // Hourly rather than daily, so the directory is not a day stale — and quantized to the
  // hour so the same reasoning about replayability applies at that grain.
  const asOf = truncateToUtcHourStart(readClock());
  const asOfIso = asOf.toISOString();

  const enqueueResult = await sendJob(
    JOB_NAMES.refreshTalentProjections,
    { asOf: asOfIso },
    { idempotencyKey: idempotencyKeyFor.refreshTalentProjections(asOfIso) },
  );

  if (!enqueueResult.success) {
    throw new Error(
      `refresh-talent-projections-tick: enqueue failed (${enqueueResult.error.type})`,
    );
  }
}
