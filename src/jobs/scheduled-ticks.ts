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

/**
 * The streak decay's tick.
 *
 * Quantized to the UTC DAY even though each project's decay is evaluated in its OWN zone
 * (see the handler): the asOf is the reference INSTANT, and the handler converts it per
 * project. Quantizing to the hour instead would produce 24 distinct job ids a day for a
 * job that must run once, and quantizing per zone would need the tick to read every
 * project — which is the handler's job, not the clock's.
 */
export async function handleRecomputeDailyLogStreaksTick(
  _rawPayload: unknown,
  readClock: ClockReader = systemClock,
): Promise<void> {
  const asOf = truncateToUtcDayStart(readClock());
  const asOfIso = asOf.toISOString();

  const enqueueResult = await sendJob(
    JOB_NAMES.recomputeDailyLogStreaks,
    { asOf: asOfIso },
    { idempotencyKey: idempotencyKeyFor.recomputeDailyLogStreaks(asOfIso) },
  );

  if (!enqueueResult.success) {
    throw new Error(
      `recompute-daily-log-streaks-tick: enqueue failed (${enqueueResult.error.type})`,
    );
  }
}

/**
 * The dispute-window sweep's tick, quantized to the MINUTE.
 *
 * Deliberately finer than every other tick in this file, because the sweep runs every 60
 * seconds and a day-quantized asOf would dedup 1,439 of the day's 1,440 firings into
 * nothing. The minute is also the right grain semantically: `windowClosesAt` is compared
 * against this instant, and the 24-hour window is a MINIMUM (§9.8), so a slightly stale
 * asOf can only ever leave a window open a little longer — the safe direction.
 */
export async function handleSweepDisputeWindowsTick(
  _rawPayload: unknown,
  readClock: ClockReader = systemClock,
): Promise<void> {
  // Truncated to whole seconds rather than through the as-of helpers: those quantize to a
  // day or an hour, both of which are far too coarse for a per-minute sweep. Zeroing the
  // milliseconds is what makes two firings inside the same second dedup.
  const now = readClock();
  const asOf = new Date(Math.floor(now.getTime() / 1_000) * 1_000);
  const asOfIso = asOf.toISOString();

  const enqueueResult = await sendJob(
    JOB_NAMES.sweepDisputeWindows,
    { asOf: asOfIso },
    { idempotencyKey: idempotencyKeyFor.sweepDisputeWindows(asOfIso) },
  );

  if (!enqueueResult.success) {
    throw new Error(`sweep-dispute-windows-tick: enqueue failed (${enqueueResult.error.type})`);
  }
}

/**
 * The nightly cap-table recomputation's tick.
 *
 * `projectId: null` means "every active project". The dispute sweep enqueues the SAME job
 * for one named project the instant slices land, so this nightly pass is a backstop that
 * catches projects whose ledger moved without a sweep — a reversal, a dispute resolved by
 * consensus — rather than the only thing keeping the cap table fresh.
 */
export async function handleRecomputeEquitySnapshotTick(
  _rawPayload: unknown,
  readClock: ClockReader = systemClock,
): Promise<void> {
  const asOf = truncateToUtcDayStart(readClock());
  const asOfIso = asOf.toISOString();

  const enqueueResult = await sendJob(
    JOB_NAMES.recomputeEquitySnapshot,
    { asOf: asOfIso, projectId: null },
    { idempotencyKey: idempotencyKeyFor.recomputeEquitySnapshot(asOfIso, null) },
  );

  if (!enqueueResult.success) {
    throw new Error(`recompute-equity-snapshot-tick: enqueue failed (${enqueueResult.error.type})`);
  }
}

/**
 * The hourly reconciliation tick (§7).
 *
 * Quantized to the HOUR, not the day: reconciliation runs hourly, and a day-quantized asOf
 * would make all 24 runs share one idempotency key so 23 of them would dedup into nothing.
 *
 * `projectId: null` means every project. There is no per-project trigger for this one —
 * unlike the equity snapshot, nothing in the request path knows that a provider's balance
 * has drifted, because drift is by definition something we learn by looking.
 */
export async function handleReconcileEscrowLedgerTick(
  _rawPayload: unknown,
  readClock: ClockReader = systemClock,
): Promise<void> {
  const asOf = truncateToUtcHourStart(readClock());
  const asOfIso = asOf.toISOString();

  const enqueueResult = await sendJob(
    JOB_NAMES.reconcileEscrowLedger,
    { asOf: asOfIso, projectId: null },
    { idempotencyKey: idempotencyKeyFor.reconcileEscrowLedger(asOfIso, null) },
  );

  if (!enqueueResult.success) {
    throw new Error(`reconcile-escrow-ledger-tick: enqueue failed (${enqueueResult.error.type})`);
  }
}

/**
 * The nightly investor-confidence tick (§7).
 *
 * Scheduled AFTER the equity snapshot, because the signal reads the cap table's dispute
 * history: computed over a half-recomputed ledger it would move when nothing moved, which
 * is the worst property a trend arrow can have.
 */
export async function handleRecomputeInvestorConfidenceTick(
  _rawPayload: unknown,
  readClock: ClockReader = systemClock,
): Promise<void> {
  const asOf = truncateToUtcDayStart(readClock());
  const asOfIso = asOf.toISOString();

  const enqueueResult = await sendJob(
    JOB_NAMES.recomputeInvestorConfidence,
    { asOf: asOfIso, projectId: null },
    { idempotencyKey: idempotencyKeyFor.recomputeInvestorConfidence(asOfIso, null) },
  );

  if (!enqueueResult.success) {
    throw new Error(
      `recompute-investor-confidence-tick: enqueue failed (${enqueueResult.error.type})`,
    );
  }
}

/**
 * The daily period roll-over tick (§7A.5).
 *
 * DAILY, NOT MONTHLY, and the quantization is why. A period is one calendar month in the
 * PROJECT'S own zone (§7A.3), so the roll-over lands on a different UTC instant for every
 * project — 1 April begins in Kiritimati fourteen hours before it begins in Honolulu. A
 * monthly cron would have to pick one instant and be wrong for every project outside it.
 *
 * `truncateToUtcDayStart` rather than the hour, so a double fire inside the same UTC day
 * dedups to one job id. The handler asks each project's own zone whether its month has
 * elapsed, so running daily costs one cheap comparison per project on the 29 days out of
 * 30 when nothing has.
 *
 * SCHEDULED BEFORE THE DRAFT. If the draft ran first, it would spend a whole day writing
 * the elapsed month's minutes into a period that should already have stopped accruing.
 */
export async function handleCloseCompensationPeriodTick(
  _rawPayload: unknown,
  readClock: ClockReader = systemClock,
): Promise<void> {
  const asOf = truncateToUtcDayStart(readClock());
  const asOfIso = asOf.toISOString();

  const enqueueResult = await sendJob(
    JOB_NAMES.closeCompensationPeriod,
    { asOf: asOfIso, projectId: null },
    { idempotencyKey: idempotencyKeyFor.closeCompensationPeriod(asOfIso, null) },
  );

  if (!enqueueResult.success) {
    throw new Error(`close-compensation-period-tick: enqueue failed (${enqueueResult.error.type})`);
  }
}

/**
 * The nightly statement redraw tick (§7A.5).
 *
 * Scheduled AFTER the equity snapshot, because an `equity_delta` line reads the cap table:
 * drafted over a half-recomputed ledger it would move when nothing moved, and a member
 * watching their own statement cannot tell that apart from someone out-contributing them.
 */
export async function handleRecomputeCompensationDraftTick(
  _rawPayload: unknown,
  readClock: ClockReader = systemClock,
): Promise<void> {
  const asOf = truncateToUtcDayStart(readClock());
  const asOfIso = asOf.toISOString();

  const enqueueResult = await sendJob(
    JOB_NAMES.recomputeCompensationDraft,
    { asOf: asOfIso, projectId: null },
    { idempotencyKey: idempotencyKeyFor.recomputeCompensationDraft(asOfIso, null) },
  );

  if (!enqueueResult.success) {
    throw new Error(
      `recompute-compensation-draft-tick: enqueue failed (${enqueueResult.error.type})`,
    );
  }
}

/**
 * The §10 branch-signal tick.
 *
 * `programId: null` means "every published program". There is deliberately NO per-program
 * trigger in the request path: the signals depend on inter-branch SIMILARITY, so adding one
 * branch can change its neighbours' overlap counts too, and a targeted recompute would have
 * to walk the whole program anyway. A nightly full pass is both simpler and honest about
 * being nightly — the branch map is not a live view and the UI says so.
 *
 * FIRES BEFORE the stats tick (03:20 vs 03:35), because `recompute-program-stats` counts
 * gaps and overlap flags from the statuses this pass derives.
 */
export async function handleRecomputeBranchSignalsTick(
  _rawPayload: unknown,
  readClock: ClockReader = systemClock,
): Promise<void> {
  const asOf = truncateToUtcDayStart(readClock());
  const asOfIso = asOf.toISOString();

  const enqueueResult = await sendJob(
    JOB_NAMES.recomputeBranchSignals,
    { asOf: asOfIso, programId: null },
    { idempotencyKey: idempotencyKeyFor.recomputeBranchSignals(asOfIso, null) },
  );

  if (!enqueueResult.success) {
    throw new Error(`recompute-branch-signals-tick: enqueue failed (${enqueueResult.error.type})`);
  }
}

/**
 * The §10 program-stats tick.
 *
 * Quantized to the UTC day, like the other recomputes. Unlike §7A's compensation close there
 * is no per-program time zone to respect: a stat tile is a count as of a moment, not a
 * calendar boundary, so one global day start is the correct quantization.
 */
export async function handleRecomputeProgramStatsTick(
  _rawPayload: unknown,
  readClock: ClockReader = systemClock,
): Promise<void> {
  const asOf = truncateToUtcDayStart(readClock());
  const asOfIso = asOf.toISOString();

  const enqueueResult = await sendJob(
    JOB_NAMES.recomputeProgramStats,
    { asOf: asOfIso, programId: null },
    { idempotencyKey: idempotencyKeyFor.recomputeProgramStats(asOfIso, null) },
  );

  if (!enqueueResult.success) {
    throw new Error(`recompute-program-stats-tick: enqueue failed (${enqueueResult.error.type})`);
  }
}
