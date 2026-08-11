import "dotenv/config";
import { PgBoss } from "pg-boss";
import type { Job } from "pg-boss";

import { config } from "#src/config/index.js";
import { createDedicatedPool, db, pool } from "#src/db/index.js";
import { jobFailure } from "#src/db/schema.js";
import { handleAnalyzeDailyLog } from "#src/jobs/analyze-daily-log.js";
import { handleCloseCompensationPeriod } from "#src/jobs/close-compensation-period.js";
import { handleDeliverNotification } from "#src/jobs/deliver-notification.js";
import { handleDeriveProductRelations } from "#src/jobs/derive-product-relations.js";
import { handleDispatchCommerceWebhookEvent } from "#src/jobs/dispatch-commerce-webhook-event.js";
import { handleDispatchConnectorCommand } from "#src/jobs/dispatch-connector-command.js";
import { handleExpireCommerceQuotes } from "#src/jobs/expire-commerce-quotes.js";
import { handleGeocodeAndClusterSubmission } from "#src/jobs/geocode-and-cluster-submission.js";
import { handlePruneEngagementData } from "#src/jobs/prune-engagement-data.js";
import { handleRecomputeBranchSignals } from "#src/jobs/recompute-branch-signals.js";
import { handleRecomputeCommerceCategoryDemand } from "#src/jobs/recompute-commerce-category-demand.js";
import { handleRecomputeCommerceProductTrending } from "#src/jobs/recompute-commerce-product-trending.js";
import { handleRecomputeCompensationDraft } from "#src/jobs/recompute-compensation-draft.js";
import { handleRecomputeDailyLogStreaks } from "#src/jobs/recompute-daily-log-streaks.js";
import { handleRecomputeDemandSignals } from "#src/jobs/recompute-demand-signals.js";
import { handleRecomputeEquitySnapshot } from "#src/jobs/recompute-equity-snapshot.js";
import { handleRecomputeInvestorConfidence } from "#src/jobs/recompute-investor-confidence.js";
import { handleRecomputeOpportunityScores } from "#src/jobs/recompute-opportunity-scores.js";
import { handleRecomputePlatformCategoryPopularity } from "#src/jobs/recompute-platform-category-popularity.js";
import { handleRecomputeProgramStats } from "#src/jobs/recompute-program-stats.js";
import { handleRecomputeTrendingVideos } from "#src/jobs/recompute-trending-videos.js";
import { handleRecomputeUserAffinities } from "#src/jobs/recompute-user-affinities.js";
import { handleRecomputeVideoDurations } from "#src/jobs/recompute-video-durations.js";
import { handleRecomputeVideoQualityScores } from "#src/jobs/recompute-video-quality-scores.js";
import { handleReconcileCommercePayments } from "#src/jobs/reconcile-commerce-payments.js";
import { handleReconcileConnectorState } from "#src/jobs/reconcile-connector-state.js";
import { handleRefreshStoreSearchDocument } from "#src/jobs/refresh-store-search-document.js";
import { handleRefreshTalentProjections } from "#src/jobs/refresh-talent-projections.js";
import { handleReleaseExpiredInventoryReservations } from "#src/jobs/release-expired-inventory-reservations.js";
import { handleRevalidateYoutubeEmbeds } from "#src/jobs/revalidate-youtube-embeds.js";
import { handleRollupCommerceProductDailySignal } from "#src/jobs/rollup-commerce-product-daily-signal.js";
import { handleScanEncryptedDocument } from "#src/jobs/scan-encrypted-document.js";
import {
  handleCloseCompensationPeriodTick,
  handleRecomputeCompensationDraftTick,
  handleRecomputeDailyLogStreaksTick,
  handleRecomputeDemandSignalsTick,
  handleRecomputeBranchSignalsTick,
  handleRecomputeEquitySnapshotTick,
  handleRecomputeProgramStatsTick,
  handleRecomputeInvestorConfidenceTick,
  handleRecomputeOpportunityScoresTick,
  handleRefreshTalentProjectionsTick,
  handleSweepDisputeWindowsTick,
  handlePruneEngagementDataTick,
  handleRecomputePlatformCategoryPopularityTick,
  handleRecomputeTrendingVideosTick,
  handleRecomputeUserAffinitiesTick,
  handleRecomputeVideoDurationsTick,
  handleRecomputeVideoQualityScoresTick,
  handleRevalidateYoutubeEmbedsTick,
  handleExpireCommerceQuotesTick,
  handleReleaseExpiredInventoryReservationsTick,
  handleDeriveProductRelationsTick,
  handleRecomputeCommerceCategoryDemandTick,
  handleRecomputeCommerceProductTrendingTick,
  handleRollupCommerceProductDailySignalTick,
  handleReconcileCommercePaymentsTick,
  handleReconcileConnectorStateTick,
  handleSweepPendingDocumentScansTick,
} from "#src/jobs/scheduled-ticks.js";
import { handleSweepDisputeWindows } from "#src/jobs/sweep-dispute-windows.js";
import { handleSweepPendingDocumentScans } from "#src/jobs/sweep-pending-document-scans.js";
import {
  handleAnalyzeSubstance,
  handleAnalyzeTemporal,
  handleFinalizeVerdict,
  handleGroundArtifacts,
} from "#src/jobs/verify-effort-claim.js";
import { handleVerifyYoutubeVideo } from "#src/jobs/verify-youtube-video.js";
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
  // `Promise<unknown>` rather than `Promise<void>`: several handlers return a run summary
  // that a script or a test reads directly (the reconciliation counts, the confidence
  // tallies). pg-boss discards a handler's return value, so widening the parameter costs
  // nothing here and saves every such handler from being wrapped at its call site.
  handler: (rawPayload: unknown) => Promise<unknown>,
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
async function recordJobFailure(queueName: string, job: Job, error: unknown): Promise<void> {
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

  await boss.work(
    JOB_NAMES.analyzeDailyLog,
    workOptions,
    runJob(JOB_NAMES.analyzeDailyLog, handleAnalyzeDailyLog),
  );
  await boss.work(
    JOB_NAMES.recomputeDailyLogStreaksTick,
    workOptions,
    runJob(JOB_NAMES.recomputeDailyLogStreaksTick, handleRecomputeDailyLogStreaksTick),
  );
  await boss.work(
    JOB_NAMES.recomputeDailyLogStreaks,
    workOptions,
    runJob(JOB_NAMES.recomputeDailyLogStreaks, handleRecomputeDailyLogStreaks),
  );

  // --- §9. The four pipeline stages, then the two schedules that settle and apportion
  // --- what they produce. Bound in pipeline order so the sequence reads as the flow.
  await boss.work(
    JOB_NAMES.groundArtifacts,
    workOptions,
    runJob(JOB_NAMES.groundArtifacts, handleGroundArtifacts),
  );
  await boss.work(
    JOB_NAMES.analyzeSubstance,
    workOptions,
    runJob(JOB_NAMES.analyzeSubstance, handleAnalyzeSubstance),
  );
  await boss.work(
    JOB_NAMES.analyzeTemporal,
    workOptions,
    runJob(JOB_NAMES.analyzeTemporal, handleAnalyzeTemporal),
  );
  await boss.work(
    JOB_NAMES.finalizeVerdict,
    workOptions,
    runJob(JOB_NAMES.finalizeVerdict, handleFinalizeVerdict),
  );
  await boss.work(
    JOB_NAMES.sweepDisputeWindowsTick,
    workOptions,
    runJob(JOB_NAMES.sweepDisputeWindowsTick, handleSweepDisputeWindowsTick),
  );
  await boss.work(
    JOB_NAMES.sweepDisputeWindows,
    workOptions,
    runJob(JOB_NAMES.sweepDisputeWindows, handleSweepDisputeWindows),
  );
  await boss.work(
    JOB_NAMES.recomputeEquitySnapshotTick,
    workOptions,
    runJob(JOB_NAMES.recomputeEquitySnapshotTick, handleRecomputeEquitySnapshotTick),
  );
  await boss.work(
    JOB_NAMES.recomputeEquitySnapshot,
    workOptions,
    runJob(JOB_NAMES.recomputeEquitySnapshot, handleRecomputeEquitySnapshot),
  );

  // §10 — research programs. Both compute fields no request body may carry: the branch
  // map's `status` + `overlappingGroupCount`, and the program's stat tiles. The SIGNALS
  // queue is bound before the STATS one only for readability; the actual ordering that
  // matters is by cron time (03:20 then 03:35), because the stats job counts gaps and
  // overlap flags from the statuses the signals job derives.
  await boss.work(
    JOB_NAMES.recomputeBranchSignalsTick,
    workOptions,
    runJob(JOB_NAMES.recomputeBranchSignalsTick, handleRecomputeBranchSignalsTick),
  );
  await boss.work(
    JOB_NAMES.recomputeBranchSignals,
    workOptions,
    runJob(JOB_NAMES.recomputeBranchSignals, handleRecomputeBranchSignals),
  );
  await boss.work(
    JOB_NAMES.recomputeProgramStatsTick,
    workOptions,
    runJob(JOB_NAMES.recomputeProgramStatsTick, handleRecomputeProgramStatsTick),
  );
  await boss.work(
    JOB_NAMES.recomputeProgramStats,
    workOptions,
    runJob(JOB_NAMES.recomputeProgramStats, handleRecomputeProgramStats),
  );

  // --- Home feed ranking (HOME_BACKEND_STRUCTURE.md §6).
  //
  // Fourteen bindings, seven tick/job pairs. The ORDER THEY RUN IN is set by their cron
  // slots, not by this list — durations before quality before popularity before
  // affinities. See SCHEDULED_JOB_CRONS.
  await boss.work(
    JOB_NAMES.recomputeVideoDurationsTick,
    workOptions,
    runJob(JOB_NAMES.recomputeVideoDurationsTick, handleRecomputeVideoDurationsTick),
  );
  await boss.work(
    JOB_NAMES.recomputeVideoDurations,
    workOptions,
    runJob(JOB_NAMES.recomputeVideoDurations, handleRecomputeVideoDurations),
  );
  await boss.work(
    JOB_NAMES.recomputeVideoQualityScoresTick,
    workOptions,
    runJob(JOB_NAMES.recomputeVideoQualityScoresTick, handleRecomputeVideoQualityScoresTick),
  );
  await boss.work(
    JOB_NAMES.recomputeVideoQualityScores,
    workOptions,
    runJob(JOB_NAMES.recomputeVideoQualityScores, handleRecomputeVideoQualityScores),
  );
  await boss.work(
    JOB_NAMES.recomputePlatformCategoryPopularityTick,
    workOptions,
    runJob(
      JOB_NAMES.recomputePlatformCategoryPopularityTick,
      handleRecomputePlatformCategoryPopularityTick,
    ),
  );
  await boss.work(
    JOB_NAMES.recomputePlatformCategoryPopularity,
    workOptions,
    runJob(
      JOB_NAMES.recomputePlatformCategoryPopularity,
      handleRecomputePlatformCategoryPopularity,
    ),
  );
  await boss.work(
    JOB_NAMES.recomputeUserAffinitiesTick,
    workOptions,
    runJob(JOB_NAMES.recomputeUserAffinitiesTick, handleRecomputeUserAffinitiesTick),
  );
  await boss.work(
    JOB_NAMES.recomputeUserAffinities,
    workOptions,
    runJob(JOB_NAMES.recomputeUserAffinities, handleRecomputeUserAffinities),
  );
  await boss.work(
    JOB_NAMES.recomputeTrendingVideosTick,
    workOptions,
    runJob(JOB_NAMES.recomputeTrendingVideosTick, handleRecomputeTrendingVideosTick),
  );
  await boss.work(
    JOB_NAMES.recomputeTrendingVideos,
    workOptions,
    runJob(JOB_NAMES.recomputeTrendingVideos, handleRecomputeTrendingVideos),
  );
  await boss.work(
    JOB_NAMES.revalidateYoutubeEmbedsTick,
    workOptions,
    runJob(JOB_NAMES.revalidateYoutubeEmbedsTick, handleRevalidateYoutubeEmbedsTick),
  );
  await boss.work(
    JOB_NAMES.revalidateYoutubeEmbeds,
    workOptions,
    runJob(JOB_NAMES.revalidateYoutubeEmbeds, handleRevalidateYoutubeEmbeds),
  );
  await boss.work(
    JOB_NAMES.pruneEngagementDataTick,
    workOptions,
    runJob(JOB_NAMES.pruneEngagementDataTick, handlePruneEngagementDataTick),
  );
  await boss.work(
    JOB_NAMES.pruneEngagementData,
    workOptions,
    runJob(JOB_NAMES.pruneEngagementData, handlePruneEngagementData),
  );

  // --- Creator Studio.
  //
  // ONE QUEUE, NO TICK. `verify-youtube-video` is enqueued in the same transaction as the
  // video row it verifies (HOME_BACKEND_STRUCTURE.md §8.3), so there is nothing for a cron
  // to sweep and no asOf to quantize.
  await boss.work(
    JOB_NAMES.verifyYoutubeVideo,
    workOptions,
    runJob(JOB_NAMES.verifyYoutubeVideo, handleVerifyYoutubeVideo),
  );

  // STORE Phase 1/2 — denormalized public search document refresh. ON DEMAND only;
  // mutations enqueue after commit so browse/search eligibility cannot drift silently.
  await boss.work(
    JOB_NAMES.refreshStoreSearchDocument,
    workOptions,
    runJob(JOB_NAMES.refreshStoreSearchDocument, handleRefreshStoreSearchDocument),
  );

  // STORE Phase 3 — expire submitted quotes and open RFQs past their deadlines.
  await boss.work(
    JOB_NAMES.expireCommerceQuotesTick,
    workOptions,
    runJob(JOB_NAMES.expireCommerceQuotesTick, handleExpireCommerceQuotesTick),
  );
  await boss.work(
    JOB_NAMES.expireCommerceQuotes,
    workOptions,
    runJob(JOB_NAMES.expireCommerceQuotes, handleExpireCommerceQuotes),
  );

  // STORE Phase 4 — release expired checkout preparations and inventory holds.
  await boss.work(
    JOB_NAMES.releaseExpiredInventoryReservationsTick,
    workOptions,
    runJob(
      JOB_NAMES.releaseExpiredInventoryReservationsTick,
      handleReleaseExpiredInventoryReservationsTick,
    ),
  );
  await boss.work(
    JOB_NAMES.releaseExpiredInventoryReservations,
    workOptions,
    runJob(
      JOB_NAMES.releaseExpiredInventoryReservations,
      handleReleaseExpiredInventoryReservations,
    ),
  );

  // STORE Phase 5 — payment outbox dispatch and reconciliation.
  await boss.work(
    JOB_NAMES.dispatchCommerceWebhookEvent,
    workOptions,
    runJob(JOB_NAMES.dispatchCommerceWebhookEvent, handleDispatchCommerceWebhookEvent),
  );
  await boss.work(
    JOB_NAMES.reconcileCommercePaymentsTick,
    workOptions,
    runJob(JOB_NAMES.reconcileCommercePaymentsTick, handleReconcileCommercePaymentsTick),
  );
  await boss.work(
    JOB_NAMES.reconcileCommercePayments,
    workOptions,
    runJob(JOB_NAMES.reconcileCommercePayments, handleReconcileCommercePayments),
  );

  // STORE Phase 14 — the external-connector substrate. One dispatcher for every connector
  // kind, and an hourly reconciler that re-enqueues stranded commands and polls escrow
  // sessions whose next event never arrived.
  await boss.work(
    JOB_NAMES.dispatchConnectorCommand,
    workOptions,
    runJob(JOB_NAMES.dispatchConnectorCommand, handleDispatchConnectorCommand),
  );
  await boss.work(
    JOB_NAMES.reconcileConnectorStateTick,
    workOptions,
    runJob(JOB_NAMES.reconcileConnectorStateTick, handleReconcileConnectorStateTick),
  );
  await boss.work(
    JOB_NAMES.reconcileConnectorState,
    workOptions,
    runJob(JOB_NAMES.reconcileConnectorState, handleReconcileConnectorState),
  );

  // STORE Phase 14b — malware scanning. Uploads enqueue the per-document job; the sweep
  // catches an enqueue that was lost, which is allowed to happen so an upload never 500s.
  await boss.work(
    JOB_NAMES.scanEncryptedDocument,
    workOptions,
    runJob(JOB_NAMES.scanEncryptedDocument, handleScanEncryptedDocument),
  );
  await boss.work(
    JOB_NAMES.sweepPendingDocumentScansTick,
    workOptions,
    runJob(JOB_NAMES.sweepPendingDocumentScansTick, handleSweepPendingDocumentScansTick),
  );
  await boss.work(
    JOB_NAMES.sweepPendingDocumentScans,
    workOptions,
    runJob(JOB_NAMES.sweepPendingDocumentScans, handleSweepPendingDocumentScans),
  );

  // STORE Phase 9 (§15.9) — nightly co-occurrence mining into the relation graph.
  // Never overwrites a seller-declared or moderator-curated edge; see the job.
  await boss.work(
    JOB_NAMES.deriveProductRelationsTick,
    workOptions,
    runJob(JOB_NAMES.deriveProductRelationsTick, handleDeriveProductRelationsTick),
  );
  await boss.work(
    JOB_NAMES.deriveProductRelations,
    workOptions,
    runJob(JOB_NAMES.deriveProductRelations, handleDeriveProductRelations),
  );

  // --- STORE Phase 13 ranking. The ORDER THEY RUN IN is set by their cron slots, not by
  // --- this list: 02:50 rollup, 03:00 category demand, and the hourly scoring run at :12.
  await boss.work(
    JOB_NAMES.rollupCommerceProductDailySignalTick,
    workOptions,
    runJob(
      JOB_NAMES.rollupCommerceProductDailySignalTick,
      handleRollupCommerceProductDailySignalTick,
    ),
  );
  await boss.work(
    JOB_NAMES.rollupCommerceProductDailySignal,
    workOptions,
    runJob(JOB_NAMES.rollupCommerceProductDailySignal, handleRollupCommerceProductDailySignal),
  );
  await boss.work(
    JOB_NAMES.recomputeCommerceCategoryDemandTick,
    workOptions,
    runJob(
      JOB_NAMES.recomputeCommerceCategoryDemandTick,
      handleRecomputeCommerceCategoryDemandTick,
    ),
  );
  await boss.work(
    JOB_NAMES.recomputeCommerceCategoryDemand,
    workOptions,
    runJob(JOB_NAMES.recomputeCommerceCategoryDemand, handleRecomputeCommerceCategoryDemand),
  );
  await boss.work(
    JOB_NAMES.recomputeCommerceProductTrendingTick,
    workOptions,
    runJob(
      JOB_NAMES.recomputeCommerceProductTrendingTick,
      handleRecomputeCommerceProductTrendingTick,
    ),
  );
  await boss.work(
    JOB_NAMES.recomputeCommerceProductTrending,
    workOptions,
    runJob(JOB_NAMES.recomputeCommerceProductTrending, handleRecomputeCommerceProductTrending),
  );

  // §7 — funding.
  //
  // THREE QUEUES ARE DELIBERATELY UNBOUND HERE: `submit-provider-transfer`,
  // `reconcile-escrow-ledger` and its tick. Escrow has left this domain (§7A.6) and
  // nothing enqueues them any more — `createPledge` records a commitment and stops. Their
  // handlers and queue definitions survive so migration 0016's rows stay explicable and
  // an operator can still drain anything left in flight by hand, but no worker subscribes
  // and no cron fires.
  await boss.work(
    JOB_NAMES.recomputeInvestorConfidenceTick,
    workOptions,
    runJob(JOB_NAMES.recomputeInvestorConfidenceTick, handleRecomputeInvestorConfidenceTick),
  );
  await boss.work(
    JOB_NAMES.recomputeInvestorConfidence,
    workOptions,
    runJob(JOB_NAMES.recomputeInvestorConfidence, handleRecomputeInvestorConfidence),
  );

  // §7A — compensation statements.
  //
  // FOUR MORE SUBSCRIPTIONS, ZERO MORE CONNECTIONS. Every `boss.work` here multiplexes
  // over the single dedicated pool created above, capped at WORKER_DATABASE_POOL_MAX (4).
  // The incident recorded below was caused by SEPARATE dead-letter subscriptions, not by
  // subscription count as such — worth stating, because the obvious reading of that note
  // is "never add a queue", and that is not what it says.
  //
  // ORDER MATTERS BETWEEN THESE TWO, and it is enforced by cron rather than here: the
  // close runs at 00:10 and the draft at 04:15. A draft that ran first would spend a day
  // writing an elapsed month's minutes into a period that should have stopped accruing.
  await boss.work(
    JOB_NAMES.closeCompensationPeriodTick,
    workOptions,
    runJob(JOB_NAMES.closeCompensationPeriodTick, handleCloseCompensationPeriodTick),
  );
  await boss.work(
    JOB_NAMES.closeCompensationPeriod,
    workOptions,
    runJob(JOB_NAMES.closeCompensationPeriod, handleCloseCompensationPeriod),
  );
  await boss.work(
    JOB_NAMES.recomputeCompensationDraftTick,
    workOptions,
    runJob(JOB_NAMES.recomputeCompensationDraftTick, handleRecomputeCompensationDraftTick),
  );
  await boss.work(
    JOB_NAMES.recomputeCompensationDraft,
    workOptions,
    runJob(JOB_NAMES.recomputeCompensationDraft, handleRecomputeCompensationDraft),
  );

  // --- §11l notifications. On demand, never scheduled: the row is written in the same
  // --- transaction as the fact it announces, and this job carries only the email copy.
  await boss.work(
    JOB_NAMES.deliverNotification,
    workOptions,
    runJob(JOB_NAMES.deliverNotification, handleDeliverNotification),
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
