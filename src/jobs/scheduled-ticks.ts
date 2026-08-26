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
/**
 * The scheduled-publish sweep's tick.
 *
 * Same second-truncation as the dispute sweep below, and for the same reason: the day and hour
 * as-of helpers are far too coarse for a per-minute sweep, and zeroing the milliseconds is what
 * makes two firings inside one second dedup on the idempotency key.
 *
 * The `asOf` is the CUTOFF, not a quantized bucket — the job publishes everything whose
 * `scheduled_publish_at` is at or before it.
 */
/**
 * The daily-log verification re-sweep's tick. Day-grained, because the job it enqueues is a nightly
 * repair pass rather than a per-minute promise.
 */
export async function handleResweepUnverifiedDailyLogsTick(
  _rawPayload: unknown,
  readClock: ClockReader = systemClock,
): Promise<void> {
  const asOfIso = truncateToUtcDayStart(readClock()).toISOString();

  const enqueueResult = await sendJob(
    JOB_NAMES.resweepUnverifiedDailyLogs,
    { asOf: asOfIso },
    { idempotencyKey: idempotencyKeyFor.resweepUnverifiedDailyLogs(asOfIso) },
  );

  if (!enqueueResult.success) {
    throw new Error(
      `resweep-unverified-daily-logs-tick: enqueue failed (${enqueueResult.error.type})`,
    );
  }
}

export async function handlePublishScheduledVideosTick(
  _rawPayload: unknown,
  readClock: ClockReader = systemClock,
): Promise<void> {
  const now = readClock();
  const asOf = new Date(Math.floor(now.getTime() / 1_000) * 1_000);
  const asOfIso = asOf.toISOString();

  const enqueueResult = await sendJob(
    JOB_NAMES.publishScheduledVideos,
    { asOf: asOfIso },
    { idempotencyKey: idempotencyKeyFor.publishScheduledVideos(asOfIso) },
  );

  if (!enqueueResult.success) {
    throw new Error(`publish-scheduled-videos-tick: enqueue failed (${enqueueResult.error.type})`);
  }
}

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

// ---------------------------------------------------------------------------
// HOME FEED RANKING (HOME_BACKEND_STRUCTURE.md §6)
//
// Six of the seven quantize to the UTC DAY; trending quantizes to the HOUR, because it is
// the one thing on this surface that claims to be current.
//
// All seven carry an asOf and nothing else. Every one of these jobs walks the whole
// catalog or the whole viewer set, so there is no scope to pass — and a payload with no
// editable field is a payload nobody can aim at a single row.
// ---------------------------------------------------------------------------

/** Must land before quality: completion rate has no denominator without a duration. */
export async function handleRecomputeVideoDurationsTick(
  _rawPayload: unknown,
  readClock: ClockReader = systemClock,
): Promise<void> {
  const asOfIso = truncateToUtcDayStart(readClock()).toISOString();

  const enqueueResult = await sendJob(
    JOB_NAMES.recomputeVideoDurations,
    { asOf: asOfIso },
    { idempotencyKey: idempotencyKeyFor.recomputeVideoDurations(asOfIso) },
  );

  if (!enqueueResult.success) {
    throw new Error(`recompute-video-durations-tick: enqueue failed (${enqueueResult.error.type})`);
  }
}

export async function handleRecomputeVideoQualityScoresTick(
  _rawPayload: unknown,
  readClock: ClockReader = systemClock,
): Promise<void> {
  const asOfIso = truncateToUtcDayStart(readClock()).toISOString();

  const enqueueResult = await sendJob(
    JOB_NAMES.recomputeVideoQualityScores,
    { asOf: asOfIso },
    { idempotencyKey: idempotencyKeyFor.recomputeVideoQualityScores(asOfIso) },
  );

  if (!enqueueResult.success) {
    throw new Error(
      `recompute-video-quality-scores-tick: enqueue failed (${enqueueResult.error.type})`,
    );
  }
}

/** Feeds §4.4's cold start, so it must land before the affinities that fall back to it. */
export async function handleRecomputePlatformCategoryPopularityTick(
  _rawPayload: unknown,
  readClock: ClockReader = systemClock,
): Promise<void> {
  const asOfIso = truncateToUtcDayStart(readClock()).toISOString();

  const enqueueResult = await sendJob(
    JOB_NAMES.recomputePlatformCategoryPopularity,
    { asOf: asOfIso },
    { idempotencyKey: idempotencyKeyFor.recomputePlatformCategoryPopularity(asOfIso) },
  );

  if (!enqueueResult.success) {
    throw new Error(
      `recompute-platform-category-popularity-tick: enqueue failed (${enqueueResult.error.type})`,
    );
  }
}

export async function handleRecomputeUserAffinitiesTick(
  _rawPayload: unknown,
  readClock: ClockReader = systemClock,
): Promise<void> {
  const asOfIso = truncateToUtcDayStart(readClock()).toISOString();

  const enqueueResult = await sendJob(
    JOB_NAMES.recomputeUserAffinities,
    { asOf: asOfIso },
    { idempotencyKey: idempotencyKeyFor.recomputeUserAffinities(asOfIso) },
  );

  if (!enqueueResult.success) {
    throw new Error(`recompute-user-affinities-tick: enqueue failed (${enqueueResult.error.type})`);
  }
}

/**
 * §3.3a — the nightly fold of `user_activity_hour` into its two durable outputs.
 *
 * Quantized to the DAY like its neighbours: the job re-aggregates whole UTC dates, so an hourly
 * `asOf` would enqueue 24 runs that all wrote identical rows.
 */
export async function handleRollupUserWatchActivityTick(
  _rawPayload: unknown,
  readClock: ClockReader = systemClock,
): Promise<void> {
  const asOfIso = truncateToUtcDayStart(readClock()).toISOString();

  const enqueueResult = await sendJob(
    JOB_NAMES.rollupUserWatchActivity,
    { asOf: asOfIso },
    { idempotencyKey: idempotencyKeyFor.rollupUserWatchActivity(asOfIso) },
  );

  if (!enqueueResult.success) {
    throw new Error(
      `rollup-user-watch-activity-tick: enqueue failed (${enqueueResult.error.type})`,
    );
  }
}

/**
 * THE HOUR, not the day — the one quantization difference in this block.
 *
 * `refresh-talent-projections` makes the same call for the same reason: a surface that
 * claims to show what is happening now cannot be built on a boundary that moves once a day.
 */
export async function handleRecomputeTrendingVideosTick(
  _rawPayload: unknown,
  readClock: ClockReader = systemClock,
): Promise<void> {
  const asOfIso = truncateToUtcHourStart(readClock()).toISOString();

  const enqueueResult = await sendJob(
    JOB_NAMES.recomputeTrendingVideos,
    { asOf: asOfIso },
    { idempotencyKey: idempotencyKeyFor.recomputeTrendingVideos(asOfIso) },
  );

  if (!enqueueResult.success) {
    throw new Error(`recompute-trending-videos-tick: enqueue failed (${enqueueResult.error.type})`);
  }
}

/** The §8.2 backstop, for videos with no viewers left to report a dead player. */
export async function handleRevalidateYoutubeEmbedsTick(
  _rawPayload: unknown,
  readClock: ClockReader = systemClock,
): Promise<void> {
  const asOfIso = truncateToUtcDayStart(readClock()).toISOString();

  const enqueueResult = await sendJob(
    JOB_NAMES.revalidateYoutubeEmbeds,
    { asOf: asOfIso },
    { idempotencyKey: idempotencyKeyFor.revalidateYoutubeEmbeds(asOfIso) },
  );

  if (!enqueueResult.success) {
    throw new Error(`revalidate-youtube-embeds-tick: enqueue failed (${enqueueResult.error.type})`);
  }
}

/**
 * The retention sweep (§3.2, §6, §8.1).
 *
 * Enqueued unconditionally. The `ENGAGEMENT_PRUNE_ENABLED` gate lives in the HANDLER, not
 * here, so that the job runs its selection and logs what it would remove even while the
 * deletion is off — a tick that skipped the enqueue would report nothing at all.
 */
export async function handlePruneEngagementDataTick(
  _rawPayload: unknown,
  readClock: ClockReader = systemClock,
): Promise<void> {
  const asOfIso = truncateToUtcDayStart(readClock()).toISOString();

  const enqueueResult = await sendJob(
    JOB_NAMES.pruneEngagementData,
    { asOf: asOfIso },
    { idempotencyKey: idempotencyKeyFor.pruneEngagementData(asOfIso) },
  );

  if (!enqueueResult.success) {
    throw new Error(`prune-engagement-data-tick: enqueue failed (${enqueueResult.error.type})`);
  }
}

/**
 * The hourly commerce quote/RFQ expiry tick (STORE_BACKEND_STRUCTURE.md §10).
 *
 * Quantized to the HOUR so a double cron fire inside the same UTC hour collapses to one
 * real job. The handler never reads the clock — only this tick does.
 */
export async function handleExpireCommerceQuotesTick(
  _rawPayload: unknown,
  readClock: ClockReader = systemClock,
): Promise<void> {
  const asOfIso = truncateToUtcHourStart(readClock()).toISOString();

  const enqueueResult = await sendJob(
    JOB_NAMES.expireCommerceQuotes,
    { asOf: asOfIso },
    { idempotencyKey: idempotencyKeyFor.expireCommerceQuotes(asOfIso) },
  );

  if (!enqueueResult.success) {
    throw new Error(`expire-commerce-quotes-tick: enqueue failed (${enqueueResult.error.type})`);
  }
}

/**
 * The hourly inventory-reservation release tick (STORE Phase 4).
 *
 * Quantized to the HOUR so a double cron fire collapses to one real job. Releases
 * expired checkout preparations and their held stock reservations.
 */
export async function handleReleaseExpiredInventoryReservationsTick(
  _rawPayload: unknown,
  readClock: ClockReader = systemClock,
): Promise<void> {
  const asOfIso = truncateToUtcHourStart(readClock()).toISOString();

  const enqueueResult = await sendJob(
    JOB_NAMES.releaseExpiredInventoryReservations,
    { asOf: asOfIso },
    { idempotencyKey: idempotencyKeyFor.releaseExpiredInventoryReservations(asOfIso) },
  );

  if (!enqueueResult.success) {
    throw new Error(
      `release-expired-inventory-reservations-tick: enqueue failed (${enqueueResult.error.type})`,
    );
  }
}

/**
 * The nightly product-relation derivation tick (STORE Phase 9, §15.9).
 *
 * Quantized to the UTC DAY, not the hour: the job mines a full history of completed
 * orders, so two fires on one day would recompute the same graph twice for nothing.
 */
export async function handleDeriveProductRelationsTick(
  _rawPayload: unknown,
  readClock: ClockReader = systemClock,
): Promise<void> {
  const asOfIso = truncateToUtcDayStart(readClock()).toISOString();

  const enqueueResult = await sendJob(
    JOB_NAMES.deriveProductRelations,
    { asOf: asOfIso },
    { idempotencyKey: idempotencyKeyFor.deriveProductRelations(asOfIso) },
  );

  if (!enqueueResult.success) {
    throw new Error(`derive-product-relations-tick: enqueue failed (${enqueueResult.error.type})`);
  }
}

/**
 * STORE Phase 13 — nightly. Quantized to the UTC DAY: it aggregates yesterday, so two fires
 * in one day would recompute the same answer twice for nothing.
 */
export async function handleRollupCommerceProductDailySignalTick(
  _rawPayload: unknown,
  readClock: ClockReader = systemClock,
): Promise<void> {
  const asOfIso = truncateToUtcDayStart(readClock()).toISOString();

  const enqueueResult = await sendJob(
    JOB_NAMES.rollupCommerceProductDailySignal,
    { asOf: asOfIso },
    { idempotencyKey: idempotencyKeyFor.rollupCommerceProductDailySignal(asOfIso) },
  );

  if (!enqueueResult.success) {
    throw new Error(
      `rollup-commerce-product-daily-signal-tick: enqueue failed (${enqueueResult.error.type})`,
    );
  }
}

/** STORE Phase 13 — nightly. Percentiles over a 30-day window move slowly. */
export async function handleRecomputeCommerceCategoryDemandTick(
  _rawPayload: unknown,
  readClock: ClockReader = systemClock,
): Promise<void> {
  const asOfIso = truncateToUtcDayStart(readClock()).toISOString();

  const enqueueResult = await sendJob(
    JOB_NAMES.recomputeCommerceCategoryDemand,
    { asOf: asOfIso },
    { idempotencyKey: idempotencyKeyFor.recomputeCommerceCategoryDemand(asOfIso) },
  );

  if (!enqueueResult.success) {
    throw new Error(
      `recompute-commerce-category-demand-tick: enqueue failed (${enqueueResult.error.type})`,
    );
  }
}

/**
 * STORE Phase 13 — hourly. The HOUR, not the day: a surface claiming to show what is rising
 * now cannot be built on a boundary that moves once a day.
 */
export async function handleRecomputeCommerceProductTrendingTick(
  _rawPayload: unknown,
  readClock: ClockReader = systemClock,
): Promise<void> {
  const asOfIso = truncateToUtcHourStart(readClock()).toISOString();

  const enqueueResult = await sendJob(
    JOB_NAMES.recomputeCommerceProductTrending,
    { asOf: asOfIso },
    { idempotencyKey: idempotencyKeyFor.recomputeCommerceProductTrending(asOfIso) },
  );

  if (!enqueueResult.success) {
    throw new Error(
      `recompute-commerce-product-trending-tick: enqueue failed (${enqueueResult.error.type})`,
    );
  }
}

/**
 * The hourly commerce payment reconciliation tick (STORE Phase 5).
 *
 * Quantized to the HOUR so a double cron fire collapses to one real job. Re-enqueues
 * pending outbox rows and re-checks submitted transfers against the provider adapter.
 */
export async function handleReconcileCommercePaymentsTick(
  _rawPayload: unknown,
  readClock: ClockReader = systemClock,
): Promise<void> {
  const asOfIso = truncateToUtcHourStart(readClock()).toISOString();

  const enqueueResult = await sendJob(
    JOB_NAMES.reconcileCommercePayments,
    { asOf: asOfIso },
    { idempotencyKey: idempotencyKeyFor.reconcileCommercePayments(asOfIso) },
  );

  if (!enqueueResult.success) {
    throw new Error(
      `reconcile-commerce-payments-tick: enqueue failed (${enqueueResult.error.type})`,
    );
  }
}

/**
 * The quarter-hourly document-scan sweep tick (STORE Phase 14b).
 *
 * Quantized to the QUARTER HOUR rather than the hour, because a buyer whose artwork is not
 * yet attachable is blocked until this runs.
 */
export async function handleSweepPendingDocumentScansTick(
  _rawPayload: unknown,
  readClock: ClockReader = systemClock,
): Promise<void> {
  /**
   * Quantized inline rather than through the as-of helpers, which only offer a day and an
   * hour — both far too coarse for a job that runs four times an hour and would dedup three
   * of every four firings into nothing. Same reasoning, and the same shape, as the
   * per-minute dispute-window tick above.
   */
  const QUARTER_HOUR_MS = 15 * 60 * 1000;
  const now = readClock();
  const asOfIso = new Date(
    Math.floor(now.getTime() / QUARTER_HOUR_MS) * QUARTER_HOUR_MS,
  ).toISOString();

  const enqueueResult = await sendJob(
    JOB_NAMES.sweepPendingDocumentScans,
    { asOf: asOfIso },
    { idempotencyKey: idempotencyKeyFor.sweepPendingDocumentScans(asOfIso) },
  );

  if (!enqueueResult.success) {
    throw new Error(
      `sweep-pending-document-scans-tick: enqueue failed (${enqueueResult.error.type})`,
    );
  }
}

/**
 * The hourly external-connector reconciliation tick (STORE Phase 14).
 *
 * Quantized to the HOUR like its siblings, so a double cron fire collapses to one real job.
 * Re-enqueues stranded connector commands and polls escrow sessions whose next event has
 * not arrived.
 */
export async function handleReconcileConnectorStateTick(
  _rawPayload: unknown,
  readClock: ClockReader = systemClock,
): Promise<void> {
  const asOfIso = truncateToUtcHourStart(readClock()).toISOString();

  const enqueueResult = await sendJob(
    JOB_NAMES.reconcileConnectorState,
    { asOf: asOfIso },
    { idempotencyKey: idempotencyKeyFor.reconcileConnectorState(asOfIso) },
  );

  if (!enqueueResult.success) {
    throw new Error(`reconcile-connector-state-tick: enqueue failed (${enqueueResult.error.type})`);
  }
}

/**
 * The §Privacy Part 3 erasure tick.
 *
 * Quantized to the UTC DAY like its neighbours. The sweep selects requests whose
 * `scheduled_anonymization_at` has passed, so a day-grained `asOf` is exactly the right
 * grain: finer would enqueue 24 identical sweeps, and coarser does not exist.
 *
 * A LATE OR MISSED RUN IS SAFE BY CONSTRUCTION and that is worth stating, because it is
 * what lets this be daily rather than hourly. The 30-day window is a MINIMUM promised to a
 * person; running late leaves an account deactivated slightly longer, which is the
 * direction that cannot hurt anybody. Running early is the one that could, and a day-start
 * `asOf` compared against a stored timestamp cannot.
 */
export async function handleAnonymizeDueAccountsTick(
  _rawPayload: unknown,
  readClock: ClockReader = systemClock,
): Promise<void> {
  const asOf = truncateToUtcDayStart(readClock());
  const asOfIso = asOf.toISOString();

  const enqueueResult = await sendJob(
    JOB_NAMES.anonymizeDueAccounts,
    { asOf: asOfIso },
    { idempotencyKey: idempotencyKeyFor.anonymizeDueAccounts(asOfIso) },
  );

  if (!enqueueResult.success) {
    throw new Error(`anonymize-due-accounts-tick: enqueue failed (${enqueueResult.error.type})`);
  }
}

/**
 * The data-export retention tick (Privacy Part 3).
 *
 * Quantized to the UTC DAY: archives live seven days, so a finer grain would enqueue 24
 * sweeps to delete the same handful of objects. Running late costs a few extra hours of
 * an archive existing, which is the direction that cannot expose anything new — the link
 * to it expires in five minutes regardless, and `readLatestDataExport` already refuses to
 * mint one past `expires_at`.
 */
export async function handlePruneExpiredDataExportsTick(
  _rawPayload: unknown,
  readClock: ClockReader = systemClock,
): Promise<void> {
  const asOfIso = truncateToUtcDayStart(readClock()).toISOString();

  const enqueueResult = await sendJob(
    JOB_NAMES.pruneExpiredDataExports,
    { asOf: asOfIso },
    { idempotencyKey: idempotencyKeyFor.pruneExpiredDataExports(asOfIso) },
  );

  if (!enqueueResult.success) {
    throw new Error(
      `prune-expired-data-exports-tick: enqueue failed (${enqueueResult.error.type})`,
    );
  }
}
