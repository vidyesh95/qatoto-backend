import type { WorkOptions } from "pg-boss";

import { JOB_NAMES, type JobName } from "#src/lib/jobs.js";

/**
 * How eagerly the worker polls each queue.
 *
 * WHY THIS EXISTS. pg-boss runs one poller per `localConcurrency` slot per queue, and each one
 * queries Postgres every `pollingIntervalSeconds` (default 2) whether or not there is work. With
 * 101 queues at concurrency 2 that was ~100 queries a second against an idle database, measured
 * on prod Aiven on 2026-11-16 (105 commits/s with zero users). It kept every worker connection
 * permanently busy on a 1 GB, 20-connection server.
 *
 * - `interactive` — a person is waiting on the result: the queue is enqueued from a request path
 *   (a controller or service), or it is a per-minute tick whose outcome a person sees on the
 *   minute (scheduled video publishing, dispute-window closing). Polled every 5 s.
 * - `background` — cron ticks and the jobs those ticks enqueue: nightly/hourly recomputes,
 *   sweeps, purges, syncs. A minute of extra latency changes nothing. Polled every 60 s.
 *
 * ⚠️ NO TICK HERE MAY BE MOVED NEAR A QUANTIZATION BOUNDARY. Tick handlers in
 * src/jobs/scheduled-ticks.ts truncate "now" to a day, hour or half hour. A `background` tick can
 * be picked up up to 60 s after cron fires, so a cron at :59 or :29 could land in the NEXT bucket.
 * Every current cron is at least 60 s clear of one.
 *
 * A `Record` over every `JobName`, not a list of exceptions: adding a queue without choosing a
 * tier is a compile error, so a new user-facing queue cannot silently inherit a 60 s delay.
 */
export type JobPollingTier = "interactive" | "background";

export const JOB_POLLING_TIERS: Readonly<Record<JobName, JobPollingTier>> = {
  [JOB_NAMES.geocodeAndClusterSubmission]: "interactive",
  [JOB_NAMES.recomputeOpportunityScoresTick]: "background",
  [JOB_NAMES.recomputeOpportunityScores]: "background",
  [JOB_NAMES.recomputeDemandSignalsTick]: "background",
  [JOB_NAMES.recomputeDemandSignals]: "background",
  [JOB_NAMES.refreshTalentProjectionsTick]: "background",
  [JOB_NAMES.refreshTalentProjections]: "background",
  [JOB_NAMES.analyzeDailyLog]: "interactive",
  [JOB_NAMES.recomputeDailyLogStreaksTick]: "background",
  [JOB_NAMES.recomputeDailyLogStreaks]: "background",
  [JOB_NAMES.sendDailyLogRemindersTick]: "background",
  [JOB_NAMES.sendDailyLogReminders]: "background",
  [JOB_NAMES.groundArtifacts]: "interactive",
  [JOB_NAMES.analyzeSubstance]: "interactive",
  [JOB_NAMES.analyzeTemporal]: "interactive",
  [JOB_NAMES.finalizeVerdict]: "interactive",
  [JOB_NAMES.sweepDisputeWindowsTick]: "interactive",
  [JOB_NAMES.sweepDisputeWindows]: "interactive",
  [JOB_NAMES.recomputeEquitySnapshotTick]: "background",
  [JOB_NAMES.recomputeEquitySnapshot]: "background",
  [JOB_NAMES.recomputeInvestorConfidenceTick]: "background",
  [JOB_NAMES.recomputeInvestorConfidence]: "background",
  [JOB_NAMES.recomputeCompensationDraftTick]: "background",
  [JOB_NAMES.recomputeCompensationDraft]: "background",
  [JOB_NAMES.closeCompensationPeriodTick]: "background",
  [JOB_NAMES.closeCompensationPeriod]: "background",
  [JOB_NAMES.recomputeProgramStatsTick]: "background",
  [JOB_NAMES.recomputeProgramStats]: "background",
  [JOB_NAMES.recomputeBranchSignalsTick]: "background",
  [JOB_NAMES.recomputeBranchSignals]: "background",
  [JOB_NAMES.verifyYoutubeVideo]: "interactive",
  [JOB_NAMES.deliverNotification]: "interactive",
  [JOB_NAMES.publishScheduledVideosTick]: "interactive",
  [JOB_NAMES.publishScheduledVideos]: "interactive",
  [JOB_NAMES.resweepUnverifiedDailyLogsTick]: "background",
  [JOB_NAMES.resweepUnverifiedDailyLogs]: "background",
  [JOB_NAMES.recomputeVideoDurationsTick]: "background",
  [JOB_NAMES.recomputeVideoDurations]: "background",
  [JOB_NAMES.recomputeVideoQualityScoresTick]: "background",
  [JOB_NAMES.recomputeVideoQualityScores]: "background",
  [JOB_NAMES.recomputePlatformCategoryPopularityTick]: "background",
  [JOB_NAMES.recomputePlatformCategoryPopularity]: "background",
  [JOB_NAMES.recomputeUserAffinitiesTick]: "background",
  [JOB_NAMES.recomputeUserAffinities]: "background",
  [JOB_NAMES.rollupUserWatchActivityTick]: "background",
  [JOB_NAMES.rollupUserWatchActivity]: "background",
  [JOB_NAMES.recomputeTrendingVideosTick]: "background",
  [JOB_NAMES.recomputeTrendingVideos]: "background",
  [JOB_NAMES.recomputeTrendingSearchesTick]: "background",
  [JOB_NAMES.recomputeTrendingSearches]: "background",
  [JOB_NAMES.recomputeProgramPostTrendingTick]: "background",
  [JOB_NAMES.recomputeProgramPostTrending]: "background",
  [JOB_NAMES.revalidateYoutubeEmbedsTick]: "background",
  [JOB_NAMES.revalidateYoutubeEmbeds]: "background",
  [JOB_NAMES.pruneEngagementDataTick]: "background",
  [JOB_NAMES.pruneEngagementData]: "background",
  [JOB_NAMES.anonymizeDueAccountsTick]: "background",
  [JOB_NAMES.anonymizeDueAccounts]: "background",
  [JOB_NAMES.anonymizeAccount]: "background",
  [JOB_NAMES.assembleDataExport]: "interactive",
  [JOB_NAMES.pruneExpiredDataExportsTick]: "background",
  [JOB_NAMES.pruneExpiredDataExports]: "background",
  [JOB_NAMES.refreshStoreSearchDocument]: "interactive",
  [JOB_NAMES.expireCommerceQuotesTick]: "background",
  [JOB_NAMES.expireCommerceQuotes]: "background",
  [JOB_NAMES.releaseExpiredInventoryReservationsTick]: "background",
  [JOB_NAMES.releaseExpiredInventoryReservations]: "background",
  [JOB_NAMES.dispatchCommerceWebhookEvent]: "interactive",
  [JOB_NAMES.reconcileCommercePaymentsTick]: "background",
  [JOB_NAMES.reconcileCommercePayments]: "background",
  [JOB_NAMES.deriveProductRelationsTick]: "background",
  [JOB_NAMES.deriveProductRelations]: "background",
  [JOB_NAMES.rollupCommerceProductDailySignalTick]: "background",
  [JOB_NAMES.rollupCommerceProductDailySignal]: "background",
  [JOB_NAMES.recomputeCommerceCategoryDemandTick]: "background",
  [JOB_NAMES.recomputeCommerceCategoryDemand]: "background",
  [JOB_NAMES.recomputeCommerceProductTrendingTick]: "background",
  [JOB_NAMES.recomputeCommerceProductTrending]: "background",
  [JOB_NAMES.dispatchConnectorCommand]: "interactive",
  [JOB_NAMES.reconcileConnectorStateTick]: "background",
  [JOB_NAMES.reconcileConnectorState]: "background",
  [JOB_NAMES.scanEncryptedDocument]: "interactive",
  [JOB_NAMES.sweepPendingDocumentScansTick]: "background",
  [JOB_NAMES.sweepPendingDocumentScans]: "background",
  [JOB_NAMES.sweepOrphanShowcaseImagesTick]: "background",
  [JOB_NAMES.sweepOrphanShowcaseImages]: "background",
  [JOB_NAMES.sweepOrphanTeardownUploadsTick]: "background",
  [JOB_NAMES.sweepOrphanTeardownUploads]: "background",
  [JOB_NAMES.sweepExpiredRightsClaimDetailsTick]: "background",
  [JOB_NAMES.sweepExpiredRightsClaimDetails]: "background",
  [JOB_NAMES.sweepOrphanProblemPhotosTick]: "background",
  [JOB_NAMES.sweepOrphanProblemPhotos]: "background",
  [JOB_NAMES.syncComtradeTradeFlowsTick]: "background",
  [JOB_NAMES.syncComtradeTradeFlows]: "background",
  [JOB_NAMES.recomputeLocalizationAssessmentsTick]: "background",
  [JOB_NAMES.recomputeLocalizationAssessments]: "background",
  [JOB_NAMES.generateLocalizationNarrative]: "interactive",
  [JOB_NAMES.syncWorldBankIndicatorsTick]: "background",
  [JOB_NAMES.syncWorldBankIndicators]: "background",
  [JOB_NAMES.recomputeFeasibilityReadoutsTick]: "background",
  [JOB_NAMES.recomputeFeasibilityReadouts]: "background",
};

const INTERACTIVE_POLLING_INTERVAL_SECONDS = 5;
const BACKGROUND_POLLING_INTERVAL_SECONDS = 60;

/**
 * Drain a backlog without waiting a full poll interval per job.
 *
 * Without this, a queue holding N jobs drains at one job per interval per poller, so a fan-out
 * (an anonymization run enqueueing one `anonymize-account` per due account) would take N minutes
 * on a `background` queue. With it, pg-boss fetches continuously while its cached ready count
 * (refreshed every 60 s) exceeds 1 and the last fetch came back full, then falls back to the poll.
 */
const BURST_WHEN_READY_EXCEEDS = 1;

/**
 * The `boss.work()` options for one queue.
 *
 * `interactiveConcurrency` is `config.WORKER_CONCURRENCY`, which also bounds concurrent Gemini
 * requests for `analyze-daily-log` (see .env.example). Background queues always run one job at a
 * time: they are full-table recomputes that share a small connection budget with the API.
 */
export function workOptionsForQueue(
  queueName: JobName,
  interactiveConcurrency: number,
): WorkOptions {
  const pollingTier = JOB_POLLING_TIERS[queueName];

  switch (pollingTier) {
    case "interactive":
      return {
        batchSize: 1,
        localConcurrency: interactiveConcurrency,
        pollingIntervalSeconds: INTERACTIVE_POLLING_INTERVAL_SECONDS,
        burstWhenReadyExceeds: BURST_WHEN_READY_EXCEEDS,
      };
    case "background":
      return {
        batchSize: 1,
        localConcurrency: 1,
        pollingIntervalSeconds: BACKGROUND_POLLING_INTERVAL_SECONDS,
        burstWhenReadyExceeds: BURST_WHEN_READY_EXCEEDS,
      };
    default: {
      const unhandledPollingTier: never = pollingTier;
      throw new Error(`Unhandled job polling tier: ${JSON.stringify(unhandledPollingTier)}`);
    }
  }
}
