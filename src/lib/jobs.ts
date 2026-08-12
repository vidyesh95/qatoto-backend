import type { Pool } from "pg";
// pg-boss v12 exports the class by NAME, not as a default — a v9-era
// `import PgBoss from "pg-boss"` fails to compile against these types.
import { PgBoss } from "pg-boss";
import type { Db as PgBossDb, Queue as PgBossQueue, SendOptions } from "pg-boss";
import { z } from "zod";

import { config } from "#src/config/index.js";
import { pool } from "#src/db/index.js";
import type { Result } from "#src/types/index.js";

/**
 * The background job registry (R_AND_D_BACKEND_STRUCTURE.md §4e).
 *
 * Nothing in this repository ran scheduled or async work before §6. Clustering,
 * geocoding and the two scoring jobs cannot run inside an HTTP request — geocoding alone
 * is a rate-limited network call to a third party — so they run here.
 *
 * WHY pg-boss: it is Postgres-backed, so it is the same database, enlisted in the same
 * transaction, with no new infrastructure to operate.
 *
 * THIS MODULE DECLARES NO HANDLERS, deliberately. Controllers import it to ENQUEUE, and
 * if it also imported the handlers (which import services, which import the database)
 * every controller would drag the entire scoring implementation into the API process's
 * module graph — and the handler modules import this one back for their payload types,
 * which is an import cycle. `src/worker.ts` is the only file that binds handlers.
 */

/**
 * Job names, as a const map so a typo is a compile error rather than a job that silently
 * never runs. The values are the queue names as they appear in Postgres.
 *
 * Each scheduled job is TWO queues: a `-tick` that cron fires, and the real job it
 * enqueues. See SCHEDULED_JOB_CRONS for why.
 */
export const JOB_NAMES = {
  geocodeAndClusterSubmission: "geocode-and-cluster-submission",
  recomputeOpportunityScoresTick: "recompute-opportunity-scores-tick",
  recomputeOpportunityScores: "recompute-opportunity-scores",
  recomputeDemandSignalsTick: "recompute-demand-signals-tick",
  recomputeDemandSignals: "recompute-demand-signals",
  refreshTalentProjectionsTick: "refresh-talent-projections-tick",
  refreshTalentProjections: "refresh-talent-projections",
  analyzeDailyLog: "analyze-daily-log",
  recomputeDailyLogStreaksTick: "recompute-daily-log-streaks-tick",
  recomputeDailyLogStreaks: "recompute-daily-log-streaks",
  // §9's verification pipeline. Each handler enqueues its successor; a `failed` or
  // `flagged` step STILL enqueues finalize-verdict, because the pipeline must always
  // reach a verdict rather than stall silently (§9.7).
  groundArtifacts: "ground-artifacts",
  analyzeSubstance: "analyze-substance",
  analyzeTemporal: "analyze-temporal",
  finalizeVerdict: "finalize-verdict",
  sweepDisputeWindowsTick: "sweep-dispute-windows-tick",
  sweepDisputeWindows: "sweep-dispute-windows",
  recomputeEquitySnapshotTick: "recompute-equity-snapshot-tick",
  recomputeEquitySnapshot: "recompute-equity-snapshot",
  // THESE THREE ARE RETIRED (§7A.6). Nothing enqueues them, no worker subscribes to them
  // and no cron fires them: escrow left this domain, `createPledge` records a commitment
  // and stops, and there is no provider balance left to reconcile against. The names
  // survive so migration 0016's queue rows stay explicable and an operator can drain
  // anything still in flight by hand. **Do not re-bind them** — putting Qatoto back in
  // the position of holding someone else's money is a licensing decision taken with
  // counsel, not a code change.
  submitProviderTransfer: "submit-provider-transfer",
  reconcileEscrowLedgerTick: "reconcile-escrow-ledger-tick",
  reconcileEscrowLedger: "reconcile-escrow-ledger",
  recomputeInvestorConfidenceTick: "recompute-investor-confidence-tick",
  recomputeInvestorConfidence: "recompute-investor-confidence",
  // §7A's two jobs. Both are DAILY ticks, including the close — a period is a calendar
  // month in the PROJECT'S own time zone (§7A.3), so "the month rolled over" lands on a
  // different UTC instant for every project and a monthly cron would have to pick one of
  // them and be wrong for everyone else.
  recomputeCompensationDraftTick: "recompute-compensation-draft-tick",
  recomputeCompensationDraft: "recompute-compensation-draft",
  closeCompensationPeriodTick: "close-compensation-period-tick",
  closeCompensationPeriod: "close-compensation-period",
  // §11l.2's fan-out. ON DEMAND, never scheduled: a notification is queued in the same
  // transaction as the fact it announces, so there is no window for a tick to sweep. The
  // job exists at all because delivery talks to an email provider, and a third-party HTTP
  // call inside the transaction that finalizes a compensation statement is not a trade
  // anyone should make.
  // §10's two jobs. Both DAILY, and both compute the fields no request body may carry:
  // a program's stat tiles, and the branch map's `status` + `overlappingGroupCount`. That
  // second one is the load-bearing case — a contributor able to mark their own branch
  // `active`, or a rival's `missing`, would make the research map worthless, so the signals
  // are derived here and nowhere else.
  recomputeProgramStatsTick: "recompute-program-stats-tick",
  recomputeProgramStats: "recompute-program-stats",
  recomputeBranchSignalsTick: "recompute-branch-signals-tick",
  recomputeBranchSignals: "recompute-branch-signals",
  // HOME_BACKEND_STRUCTURE.md §8.3's deferred source verification. ON DEMAND, never
  // scheduled: it is enqueued in the SAME TRANSACTION as the video row whose id it
  // carries, so there is no window for a tick to sweep and no asOf to quantize.
  //
  // It exists because a YouTube outage used to throw away the creator's upload — the
  // oEmbed call was synchronous inside createVideo and a network blip meant a 502. Now
  // the 11-character id is stored regardless (the charset CHECK still closes SSRF at the
  // storage layer), the row is born an unverified draft, and this job retries until it
  // can prove the video exists and embeds. Publish is refused in the meantime.
  verifyYoutubeVideo: "verify-youtube-video",
  deliverNotification: "deliver-notification",
  // --- Home feed ranking (HOME_BACKEND_STRUCTURE.md §6). ORDERING IS EXPRESSED BY CRON
  // --- TIME, NOT BY CODE — see SCHEDULED_JOB_CRONS below. Durations must precede quality
  // --- (completion has no denominator without one), quality must precede popularity, and
  // --- popularity must precede affinities.
  recomputeVideoDurationsTick: "recompute-video-durations-tick",
  recomputeVideoDurations: "recompute-video-durations",
  recomputeVideoQualityScoresTick: "recompute-video-quality-scores-tick",
  recomputeVideoQualityScores: "recompute-video-quality-scores",
  recomputePlatformCategoryPopularityTick: "recompute-platform-category-popularity-tick",
  recomputePlatformCategoryPopularity: "recompute-platform-category-popularity",
  recomputeUserAffinitiesTick: "recompute-user-affinities-tick",
  recomputeUserAffinities: "recompute-user-affinities",
  // The ONE hourly job in this domain. A "trending" chip recomputed nightly is a lie
  // about what the word means.
  recomputeTrendingVideosTick: "recompute-trending-videos-tick",
  recomputeTrendingVideos: "recompute-trending-videos",
  revalidateYoutubeEmbedsTick: "revalidate-youtube-embeds-tick",
  revalidateYoutubeEmbeds: "revalidate-youtube-embeds",
  pruneEngagementDataTick: "prune-engagement-data-tick",
  pruneEngagementData: "prune-engagement-data",
  // STORE Phase 1/2 — refresh denormalized public search documents after mutations.
  refreshStoreSearchDocument: "refresh-store-search-document",
  // STORE Phase 3 — expire submitted quotes and open RFQs past their deadlines.
  expireCommerceQuotesTick: "expire-commerce-quotes-tick",
  expireCommerceQuotes: "expire-commerce-quotes",
  // STORE Phase 4 — release expired checkout preparations and inventory holds.
  releaseExpiredInventoryReservationsTick: "release-expired-inventory-reservations-tick",
  releaseExpiredInventoryReservations: "release-expired-inventory-reservations",
  // STORE Phase 5 — commerce payment outbox dispatch and reconciliation.
  dispatchCommerceWebhookEvent: "dispatch-commerce-webhook-event",
  reconcileCommercePaymentsTick: "reconcile-commerce-payments-tick",
  reconcileCommercePayments: "reconcile-commerce-payments",
  // STORE Phase 9 (§15.9) — nightly co-occurrence mining into the relation graph.
  deriveProductRelationsTick: "derive-product-relations-tick",
  deriveProductRelations: "derive-product-relations",
  // STORE Phase 13 — the ranking engine. Three pairs: a nightly per-product signal rollup,
  // a nightly per-category demand recompute, and the hourly scoring run that reads both.
  rollupCommerceProductDailySignalTick: "rollup-commerce-product-daily-signal-tick",
  rollupCommerceProductDailySignal: "rollup-commerce-product-daily-signal",
  recomputeCommerceCategoryDemandTick: "recompute-commerce-category-demand-tick",
  recomputeCommerceCategoryDemand: "recompute-commerce-category-demand",
  recomputeCommerceProductTrendingTick: "recompute-commerce-product-trending-tick",
  recomputeCommerceProductTrending: "recompute-commerce-product-trending",
  // STORE Phase 14 — the external-connector substrate. One on-demand dispatcher shared by
  // every connector kind, and one hourly reconciler that re-enqueues whatever was left
  // pending by a worker that died mid-flight or an enqueue that failed after its row
  // committed.
  dispatchConnectorCommand: "dispatch-connector-command",
  reconcileConnectorStateTick: "reconcile-connector-state-tick",
  reconcileConnectorState: "reconcile-connector-state",
  // STORE Phase 14b — malware scanning for private commerce documents. Uploads enqueue the
  // per-document job directly; the sweep exists only to catch an enqueue that was lost.
  scanEncryptedDocument: "scan-encrypted-document",
  sweepPendingDocumentScansTick: "sweep-pending-document-scans-tick",
  sweepPendingDocumentScans: "sweep-pending-document-scans",
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

/**
 * An ISO-8601 instant that must be EXACTLY a quantized reference point.
 *
 * §4c rule 3: every job is a pure function of `(data, asOf)`. Carrying the asOf in the
 * payload rather than reading the clock inside the handler is what makes a job replayable
 * — an operator can re-run any historical asOf and get byte-identical output.
 */
const AsOfSchema = z.iso.datetime();

/**
 * Payload schemas. Every one is `.strict()`, for the same reason request bodies are:
 * an unexpected key means the enqueuer and the handler disagree about the contract.
 */
const GeocodeAndClusterSubmissionPayloadSchema = z
  .object({
    // The submission id and NOTHING else. `createdAt`, the coordinates and the category
    // are all read from the row inside the handler, because the server owns them — a
    // payload is exactly as forgeable as a request body, and a payload carrying a
    // timestamp would be a field an operator could edit to move a report into a
    // different cluster. There is no field to edit.
    submissionId: z.uuid(),
  })
  .strict();

const AsOfOnlyPayloadSchema = z.object({ asOf: AsOfSchema }).strict();

const AnalyzeDailyLogPayloadSchema = z
  .object({
    // The log id and NOTHING else, for the same reason the clustering payload carries
    // only a submission id: everything the handler needs — the video id, the narrative,
    // the claimed date — is server-owned and is read from the row. A payload carrying the
    // YouTube id would be a field an operator could edit to point the analysis at a
    // different video.
    dailyLogId: z.uuid(),
  })
  .strict();

const WindowedAsOfPayloadSchema = z
  .object({
    asOf: AsOfSchema,
    // ABSOLUTE window bounds, never a day count (§4c rule 3). A row that records
    // "30 days" is unreadable a year later; a row that records two instants is
    // self-describing and re-derivable.
    windowStartsAt: AsOfSchema,
    windowEndsAt: AsOfSchema,
  })
  .strict();

const DeliverNotificationPayloadSchema = z
  .object({
    // The notification id and NOTHING else. The recipient, the kind and the payload are
    // read from the row — a job payload carrying an email address would be a field an
    // operator could edit to redirect somebody else's statement notification.
    notificationId: z.uuid(),
  })
  .strict();

const TickPayloadSchema = z.object({}).strict();

/**
 * Every §9 pipeline stage carries the RUN id and nothing else, for the same reason the
 * clustering payload carries only a submission id: the claim, the member, the rate, the
 * claimed date and the evidence are all server-owned and are read from rows. A payload
 * carrying a minute count would be a field an operator could edit to mint equity.
 */
const VerificationStagePayloadSchema = z.object({ runId: z.uuid() }).strict();

/**
 * `projectId` is REQUIRED and explicitly nullable rather than optional: null means "every
 * project", which the nightly tick wants, and a named project is what the dispute sweep
 * enqueues after it locks a window. An optional key would make "absent" and "null"
 * two spellings of the same intent, and only one of them would be tested.
 */
const RecomputeEquitySnapshotPayloadSchema = z
  .object({ asOf: AsOfSchema, projectId: z.uuid().nullable() })
  .strict();

/**
 * The transfer id and NOTHING else — the same rule as every payload above, and it matters
 * most here. The amount, the currency, the destination and the idempotency key are all
 * read from the row inside the handler, so there is no field an operator with a queue
 * dashboard could edit to move a different sum to a different place.
 */
const SubmitProviderTransferPayloadSchema = z.object({ transferId: z.uuid() }).strict();

/** Same `projectId: nullable` shape as the equity snapshot, for the same reason. */
const ProjectScopedAsOfPayloadSchema = z
  .object({ asOf: AsOfSchema, projectId: z.uuid().nullable() })
  .strict();

/**
 * §10's payload. `programId: null` means "every published program", which is what the tick
 * enqueues; a single id is for an on-demand recompute.
 *
 * SERVER-OWNED IDS ONLY, like every other payload here — a payload is exactly as forgeable
 * as a request body.
 */
const ProgramScopedAsOfPayloadSchema = z
  .object({ asOf: AsOfSchema, programId: z.uuid().nullable() })
  .strict();

/**
 * The video id and NOTHING else — the same rule as every payload above.
 *
 * The 11-character YouTube id is read from the ROW inside the handler. Carrying it in the
 * payload would put a forgeable field between the id we stored and the id we verify, and an
 * operator with a queue dashboard could edit it to mark one video verified on the strength
 * of a different video's proof. `video.id` is a randomUUID, so `z.uuid()` is exact.
 */
const VerifyYoutubeVideoPayloadSchema = z.object({ videoId: z.uuid() }).strict();

/**
 * Store search document refresh. Carries the target identity only — eligibility and
 * projection fields are re-read from authoritative rows inside the handler.
 */
const RefreshStoreSearchDocumentPayloadSchema = z.discriminatedUnion("targetKind", [
  z
    .object({
      targetKind: z.literal("product"),
      productId: z.string().trim().min(1).max(200),
    })
    .strict(),
  z
    .object({
      targetKind: z.literal("provider_offering"),
      offeringId: z.string().trim().min(1).max(200),
    })
    .strict(),
  z
    .object({
      targetKind: z.literal("organization"),
      organizationId: z.string().trim().min(1).max(200),
    })
    .strict(),
]);

/**
 * Commerce payment outbox dispatch. Carries the outbox row id only — amounts, provider
 * refs, and state are re-read from authoritative rows inside the handler.
 */
const DispatchCommerceWebhookEventPayloadSchema = z
  .object({
    outboxId: z.string().trim().min(1).max(200),
  })
  .strict();

/**
 * STORE Phase 14 connector dispatch. Carries the outbox row id only, for the same reason
 * the payment dispatcher does: amounts, provider references and state are re-read from
 * authoritative rows inside the handler, so a payload that sat in a queue for an hour
 * cannot act on a stale copy of anything.
 */
const DispatchConnectorCommandPayloadSchema = z
  .object({
    outboxId: z.string().trim().min(1).max(200),
  })
  .strict();

/** STORE Phase 14b. The document id only; its state is re-read inside the handler. */
const ScanEncryptedDocumentPayloadSchema = z
  .object({
    documentId: z.string().trim().min(1).max(200),
  })
  .strict();

/**
 * One definition per job: its payload contract and its queue policy.
 *
 * `retryDelay: 30` with `retryBackoff` and `retryDelayMax: 1800` reproduces §9.7's
 * `min(2^attempt × 30s, 30min)` exactly, so the two documents cannot drift.
 */
interface JobDefinition {
  readonly name: JobName;
  readonly payloadSchema: z.ZodType;
  readonly queueOptions: Omit<PgBossQueue, "name">;
}

/** Every queue gets one, so a permanently failing job is captured rather than deleted. */
export function deadLetterNameFor(jobName: JobName): string {
  return `${jobName}-dead`;
}

const STANDARD_RETRY = {
  retryLimit: 5,
  retryDelay: 30,
  retryBackoff: true,
  retryDelayMax: 1_800,
} as const;

const RECOMPUTE_RETRY = {
  retryLimit: 3,
  retryDelay: 300,
  retryBackoff: true,
  retryDelayMax: 1_800,
} as const;

/**
 * Longer and more patient than STANDARD_RETRY, on purpose.
 *
 * This job's whole reason to exist is that YouTube did not answer, and a provider outage
 * routinely outlasts the ~1 hour STANDARD_RETRY covers. Ten attempts backing off to a
 * one-hour ceiling spans roughly nine hours; after that the row dead-letters and stays an
 * unpublishable draft, which is the honest outcome — the creator's work is still there and
 * an operator can re-enqueue. Giving up after 5 attempts would strand uploads over a long
 * outage for no reason.
 */
const SOURCE_VERIFY_RETRY = {
  retryLimit: 10,
  retryDelay: 60,
  retryBackoff: true,
  retryDelayMax: 3_600,
} as const;

/**
 * The queue options every home-feed tick shares.
 *
 * A FUNCTION rather than a spreadable constant, because `deadLetter` is derived from the
 * queue's own name and there is no way to spell that in a shared literal. Seven ticks with
 * seven hand-copied option blocks is seven chances to paste the wrong dead-letter name —
 * which would route one queue's failures into another's, silently.
 *
 * `exclusive`: a tick's only job is to enqueue, so a second concurrent one would mint a
 * duplicate that the idempotency key then discards. Cheaper to never start it.
 */
function RANKING_TICK_QUEUE_OPTIONS(tickJobName: JobName): {
  readonly policy: "exclusive";
  readonly retryLimit: number;
  readonly retryDelay: number;
  readonly retryBackoff: boolean;
  readonly retryDelayMax: number;
  readonly expireInSeconds: number;
  readonly deadLetter: string;
} {
  return {
    policy: "exclusive",
    retryLimit: 2,
    retryDelay: 60,
    retryBackoff: true,
    retryDelayMax: 600,
    // A tick does one INSERT. If it has not finished in a minute, something is wrong that
    // waiting will not fix.
    expireInSeconds: 60,
    deadLetter: deadLetterNameFor(tickJobName),
  };
}

export const JOB_DEFINITIONS = {
  [JOB_NAMES.geocodeAndClusterSubmission]: {
    name: JOB_NAMES.geocodeAndClusterSubmission,
    payloadSchema: GeocodeAndClusterSubmissionPayloadSchema,
    queueOptions: {
      policy: "standard",
      ...STANDARD_RETRY,
      // Generous: the handler makes a rate-limited external geocoding call and may wait
      // on the 1 req/s budget behind other submissions.
      expireInSeconds: 300,
      deadLetter: deadLetterNameFor(JOB_NAMES.geocodeAndClusterSubmission),
    },
  },
  [JOB_NAMES.recomputeOpportunityScoresTick]: {
    name: JOB_NAMES.recomputeOpportunityScoresTick,
    payloadSchema: TickPayloadSchema,
    queueOptions: {
      policy: "exclusive",
      retryLimit: 2,
      retryDelay: 60,
      retryBackoff: true,
      retryDelayMax: 600,
      expireInSeconds: 60,
      deadLetter: deadLetterNameFor(JOB_NAMES.recomputeOpportunityScoresTick),
    },
  },
  [JOB_NAMES.recomputeOpportunityScores]: {
    name: JOB_NAMES.recomputeOpportunityScores,
    payloadSchema: AsOfOnlyPayloadSchema,
    queueOptions: {
      // `singleton` — max one active, unlimited queued. Two concurrent full recomputes
      // writing the same (cluster_id, as_of) rows is a deadlock generator, and there is
      // no scenario in which running two helps.
      policy: "singleton",
      ...RECOMPUTE_RETRY,
      expireInSeconds: 1_800,
      deadLetter: deadLetterNameFor(JOB_NAMES.recomputeOpportunityScores),
    },
  },
  [JOB_NAMES.recomputeDemandSignalsTick]: {
    name: JOB_NAMES.recomputeDemandSignalsTick,
    payloadSchema: TickPayloadSchema,
    queueOptions: {
      policy: "exclusive",
      retryLimit: 2,
      retryDelay: 60,
      retryBackoff: true,
      retryDelayMax: 600,
      expireInSeconds: 60,
      deadLetter: deadLetterNameFor(JOB_NAMES.recomputeDemandSignalsTick),
    },
  },
  [JOB_NAMES.recomputeDemandSignals]: {
    name: JOB_NAMES.recomputeDemandSignals,
    payloadSchema: WindowedAsOfPayloadSchema,
    queueOptions: {
      policy: "singleton",
      ...RECOMPUTE_RETRY,
      expireInSeconds: 1_800,
      deadLetter: deadLetterNameFor(JOB_NAMES.recomputeDemandSignals),
    },
  },
  [JOB_NAMES.refreshTalentProjectionsTick]: {
    name: JOB_NAMES.refreshTalentProjectionsTick,
    payloadSchema: TickPayloadSchema,
    queueOptions: {
      policy: "exclusive",
      retryLimit: 2,
      retryDelay: 60,
      retryBackoff: true,
      retryDelayMax: 600,
      expireInSeconds: 60,
      deadLetter: deadLetterNameFor(JOB_NAMES.refreshTalentProjectionsTick),
    },
  },
  [JOB_NAMES.refreshTalentProjections]: {
    name: JOB_NAMES.refreshTalentProjections,
    payloadSchema: AsOfOnlyPayloadSchema,
    queueOptions: {
      policy: "singleton",
      retryLimit: 3,
      retryDelay: 120,
      retryBackoff: true,
      retryDelayMax: 1_800,
      expireInSeconds: 900,
      deadLetter: deadLetterNameFor(JOB_NAMES.refreshTalentProjections),
    },
  },
  [JOB_NAMES.analyzeDailyLog]: {
    name: JOB_NAMES.analyzeDailyLog,
    payloadSchema: AnalyzeDailyLogPayloadSchema,
    queueOptions: {
      policy: "standard",
      ...STANDARD_RETRY,
      // The model watches a whole video. This must exceed GEMINI_TIMEOUT_MS with room to
      // spare, or pg-boss reclaims a job that is still legitimately in flight and a
      // second worker starts the same expensive call against a free-tier budget.
      expireInSeconds: 900,
      deadLetter: deadLetterNameFor(JOB_NAMES.analyzeDailyLog),
    },
  },
  [JOB_NAMES.recomputeDailyLogStreaksTick]: {
    name: JOB_NAMES.recomputeDailyLogStreaksTick,
    payloadSchema: TickPayloadSchema,
    queueOptions: {
      policy: "exclusive",
      retryLimit: 2,
      retryDelay: 60,
      retryBackoff: true,
      retryDelayMax: 600,
      expireInSeconds: 60,
      deadLetter: deadLetterNameFor(JOB_NAMES.recomputeDailyLogStreaksTick),
    },
  },
  [JOB_NAMES.recomputeDailyLogStreaks]: {
    name: JOB_NAMES.recomputeDailyLogStreaks,
    payloadSchema: AsOfOnlyPayloadSchema,
    queueOptions: {
      policy: "singleton",
      ...RECOMPUTE_RETRY,
      expireInSeconds: 1_800,
      deadLetter: deadLetterNameFor(JOB_NAMES.recomputeDailyLogStreaks),
    },
  },

  // --- §9. The four pipeline stages share one policy: `standard` (many claims verify
  // --- concurrently; they touch disjoint rows) and the §9.7 backoff STANDARD_RETRY
  // --- already encodes. Only the expiry differs, by how long each stage can legitimately
  // --- take.
  [JOB_NAMES.groundArtifacts]: {
    name: JOB_NAMES.groundArtifacts,
    payloadSchema: VerificationStagePayloadSchema,
    queueOptions: {
      policy: "standard",
      ...STANDARD_RETRY,
      // A fan-out across providers with their own rate limits.
      expireInSeconds: 600,
      deadLetter: deadLetterNameFor(JOB_NAMES.groundArtifacts),
    },
  },
  [JOB_NAMES.analyzeSubstance]: {
    name: JOB_NAMES.analyzeSubstance,
    payloadSchema: VerificationStagePayloadSchema,
    queueOptions: {
      policy: "standard",
      ...STANDARD_RETRY,
      expireInSeconds: 600,
      deadLetter: deadLetterNameFor(JOB_NAMES.analyzeSubstance),
    },
  },
  [JOB_NAMES.analyzeTemporal]: {
    name: JOB_NAMES.analyzeTemporal,
    payloadSchema: VerificationStagePayloadSchema,
    queueOptions: {
      policy: "standard",
      ...STANDARD_RETRY,
      // Pure integer arithmetic over rows already fetched; nothing here waits on a
      // network.
      expireInSeconds: 120,
      deadLetter: deadLetterNameFor(JOB_NAMES.analyzeTemporal),
    },
  },
  [JOB_NAMES.finalizeVerdict]: {
    name: JOB_NAMES.finalizeVerdict,
    payloadSchema: VerificationStagePayloadSchema,
    queueOptions: {
      policy: "standard",
      ...STANDARD_RETRY,
      expireInSeconds: 120,
      deadLetter: deadLetterNameFor(JOB_NAMES.finalizeVerdict),
    },
  },

  [JOB_NAMES.sweepDisputeWindowsTick]: {
    name: JOB_NAMES.sweepDisputeWindowsTick,
    payloadSchema: TickPayloadSchema,
    queueOptions: {
      policy: "exclusive",
      retryLimit: 2,
      retryDelay: 30,
      retryBackoff: false,
      expireInSeconds: 45,
      deadLetter: deadLetterNameFor(JOB_NAMES.sweepDisputeWindowsTick),
    },
  },
  [JOB_NAMES.sweepDisputeWindows]: {
    name: JOB_NAMES.sweepDisputeWindows,
    payloadSchema: AsOfOnlyPayloadSchema,
    queueOptions: {
      // `singleton` — one sweep at a time. Two concurrent sweeps are safe (the dequeue
      // takes FOR UPDATE SKIP LOCKED and re-asserts status inside the transaction) but
      // pointless, and they would contend on the same chain-head locks.
      policy: "singleton",
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: false,
      expireInSeconds: 300,
      deadLetter: deadLetterNameFor(JOB_NAMES.sweepDisputeWindows),
    },
  },
  [JOB_NAMES.recomputeEquitySnapshotTick]: {
    name: JOB_NAMES.recomputeEquitySnapshotTick,
    payloadSchema: TickPayloadSchema,
    queueOptions: {
      policy: "exclusive",
      retryLimit: 2,
      retryDelay: 60,
      retryBackoff: true,
      retryDelayMax: 600,
      expireInSeconds: 60,
      deadLetter: deadLetterNameFor(JOB_NAMES.recomputeEquitySnapshotTick),
    },
  },
  [JOB_NAMES.recomputeEquitySnapshot]: {
    name: JOB_NAMES.recomputeEquitySnapshot,
    payloadSchema: RecomputeEquitySnapshotPayloadSchema,
    queueOptions: {
      policy: "singleton",
      ...RECOMPUTE_RETRY,
      expireInSeconds: 1_800,
      deadLetter: deadLetterNameFor(JOB_NAMES.recomputeEquitySnapshot),
    },
  },
  [JOB_NAMES.submitProviderTransfer]: {
    name: JOB_NAMES.submitProviderTransfer,
    payloadSchema: SubmitProviderTransferPayloadSchema,
    queueOptions: {
      policy: "standard",
      ...STANDARD_RETRY,
      // Generous, because against a real card network this is an outbound HTTPS call.
      // Against the internal adapter it is a status flip; the ceiling costs nothing and
      // does not have to change when Appendix A3 lands.
      expireInSeconds: 120,
      deadLetter: deadLetterNameFor(JOB_NAMES.submitProviderTransfer),
    },
  },
  [JOB_NAMES.reconcileEscrowLedgerTick]: {
    name: JOB_NAMES.reconcileEscrowLedgerTick,
    payloadSchema: TickPayloadSchema,
    queueOptions: {
      policy: "exclusive",
      retryLimit: 2,
      retryDelay: 60,
      retryBackoff: true,
      retryDelayMax: 600,
      expireInSeconds: 60,
      deadLetter: deadLetterNameFor(JOB_NAMES.reconcileEscrowLedgerTick),
    },
  },
  [JOB_NAMES.reconcileEscrowLedger]: {
    name: JOB_NAMES.reconcileEscrowLedger,
    payloadSchema: ProjectScopedAsOfPayloadSchema,
    queueOptions: {
      // `singleton` — one reconciliation at a time. Two concurrent runs would both see a
      // discrepancy, both post a suspense entry for it, and double-count the delta.
      policy: "singleton",
      ...RECOMPUTE_RETRY,
      expireInSeconds: 1_800,
      deadLetter: deadLetterNameFor(JOB_NAMES.reconcileEscrowLedger),
    },
  },
  [JOB_NAMES.recomputeInvestorConfidenceTick]: {
    name: JOB_NAMES.recomputeInvestorConfidenceTick,
    payloadSchema: TickPayloadSchema,
    queueOptions: {
      policy: "exclusive",
      retryLimit: 2,
      retryDelay: 60,
      retryBackoff: true,
      retryDelayMax: 600,
      expireInSeconds: 60,
      deadLetter: deadLetterNameFor(JOB_NAMES.recomputeInvestorConfidenceTick),
    },
  },
  [JOB_NAMES.recomputeInvestorConfidence]: {
    name: JOB_NAMES.recomputeInvestorConfidence,
    payloadSchema: ProjectScopedAsOfPayloadSchema,
    queueOptions: {
      policy: "singleton",
      ...RECOMPUTE_RETRY,
      expireInSeconds: 1_800,
      deadLetter: deadLetterNameFor(JOB_NAMES.recomputeInvestorConfidence),
    },
  },
  [JOB_NAMES.closeCompensationPeriodTick]: {
    name: JOB_NAMES.closeCompensationPeriodTick,
    payloadSchema: TickPayloadSchema,
    queueOptions: {
      policy: "exclusive",
      retryLimit: 2,
      retryDelay: 60,
      retryBackoff: true,
      retryDelayMax: 600,
      expireInSeconds: 60,
      deadLetter: deadLetterNameFor(JOB_NAMES.closeCompensationPeriodTick),
    },
  },
  [JOB_NAMES.closeCompensationPeriod]: {
    name: JOB_NAMES.closeCompensationPeriod,
    payloadSchema: ProjectScopedAsOfPayloadSchema,
    queueOptions: {
      // `singleton` for the same reason the reconciliation job is: two runs racing the
      // same boundary would both walk a project forward. The chain-head lock and the
      // partial unique index already make that safe, but two writers competing for one
      // lock is wasted work rather than a race worth relying on.
      policy: "singleton",
      ...RECOMPUTE_RETRY,
      expireInSeconds: 1_800,
      deadLetter: deadLetterNameFor(JOB_NAMES.closeCompensationPeriod),
    },
  },
  [JOB_NAMES.recomputeCompensationDraftTick]: {
    name: JOB_NAMES.recomputeCompensationDraftTick,
    payloadSchema: TickPayloadSchema,
    queueOptions: {
      policy: "exclusive",
      retryLimit: 2,
      retryDelay: 60,
      retryBackoff: true,
      retryDelayMax: 600,
      expireInSeconds: 60,
      deadLetter: deadLetterNameFor(JOB_NAMES.recomputeCompensationDraftTick),
    },
  },
  [JOB_NAMES.recomputeCompensationDraft]: {
    name: JOB_NAMES.recomputeCompensationDraft,
    payloadSchema: ProjectScopedAsOfPayloadSchema,
    queueOptions: {
      policy: "singleton",
      ...RECOMPUTE_RETRY,
      expireInSeconds: 1_800,
      deadLetter: deadLetterNameFor(JOB_NAMES.recomputeCompensationDraft),
    },
  },
  [JOB_NAMES.recomputeProgramStatsTick]: {
    name: JOB_NAMES.recomputeProgramStatsTick,
    payloadSchema: TickPayloadSchema,
    queueOptions: {
      policy: "exclusive",
      retryLimit: 2,
      retryDelay: 60,
      retryBackoff: true,
      retryDelayMax: 600,
      expireInSeconds: 60,
      deadLetter: deadLetterNameFor(JOB_NAMES.recomputeProgramStatsTick),
    },
  },
  [JOB_NAMES.recomputeProgramStats]: {
    name: JOB_NAMES.recomputeProgramStats,
    payloadSchema: ProgramScopedAsOfPayloadSchema,
    queueOptions: {
      policy: "singleton",
      ...RECOMPUTE_RETRY,
      expireInSeconds: 1_800,
      deadLetter: deadLetterNameFor(JOB_NAMES.recomputeProgramStats),
    },
  },
  [JOB_NAMES.recomputeBranchSignalsTick]: {
    name: JOB_NAMES.recomputeBranchSignalsTick,
    payloadSchema: TickPayloadSchema,
    queueOptions: {
      policy: "exclusive",
      retryLimit: 2,
      retryDelay: 60,
      retryBackoff: true,
      retryDelayMax: 600,
      expireInSeconds: 60,
      deadLetter: deadLetterNameFor(JOB_NAMES.recomputeBranchSignalsTick),
    },
  },
  [JOB_NAMES.recomputeBranchSignals]: {
    name: JOB_NAMES.recomputeBranchSignals,
    payloadSchema: ProgramScopedAsOfPayloadSchema,
    queueOptions: {
      policy: "singleton",
      ...RECOMPUTE_RETRY,
      // Longer than the other recomputes: the overlap pass is O(branches²) in Jaccard
      // comparisons per program, and a 500-node tree is 125,000 integer set intersections.
      // Still trivial work, but the ceiling should not be the thing that kills the job.
      expireInSeconds: 3_600,
      deadLetter: deadLetterNameFor(JOB_NAMES.recomputeBranchSignals),
    },
  },
  [JOB_NAMES.verifyYoutubeVideo]: {
    name: JOB_NAMES.verifyYoutubeVideo,
    payloadSchema: VerifyYoutubeVideoPayloadSchema,
    queueOptions: {
      // `standard`, not `singleton`: two videos are two disjoint rows with nothing to
      // serialize. The per-row idempotency key collapses a retried enqueue of the same one.
      policy: "standard",
      ...SOURCE_VERIFY_RETRY,
      // One oEmbed call bounded by YOUTUBE_OEMBED_TIMEOUT_MS, plus one UPDATE.
      expireInSeconds: 60,
      deadLetter: deadLetterNameFor(JOB_NAMES.verifyYoutubeVideo),
    },
  },
  [JOB_NAMES.deliverNotification]: {
    name: JOB_NAMES.deliverNotification,
    payloadSchema: DeliverNotificationPayloadSchema,
    queueOptions: {
      // `standard`, not `singleton`: two notifications are two disjoint rows and there is
      // no reason to serialize them. The per-row idempotency key is what collapses a
      // retried enqueue of the SAME notification.
      policy: "standard",
      ...STANDARD_RETRY,
      expireInSeconds: 300,
      deadLetter: deadLetterNameFor(JOB_NAMES.deliverNotification),
    },
  },

  // --- Home feed ranking (HOME_BACKEND_STRUCTURE.md §6). Every real job is `singleton`
  // --- for the reason the R&D recomputes are: two concurrent full recomputes writing the
  // --- same `(scope, as_of)` rows is a deadlock generator, and there is no scenario in
  // --- which running two helps.
  [JOB_NAMES.recomputeVideoDurationsTick]: {
    name: JOB_NAMES.recomputeVideoDurationsTick,
    payloadSchema: TickPayloadSchema,
    queueOptions: { ...RANKING_TICK_QUEUE_OPTIONS(JOB_NAMES.recomputeVideoDurationsTick) },
  },
  [JOB_NAMES.recomputeVideoDurations]: {
    name: JOB_NAMES.recomputeVideoDurations,
    payloadSchema: AsOfOnlyPayloadSchema,
    queueOptions: {
      policy: "singleton",
      ...RECOMPUTE_RETRY,
      expireInSeconds: 1_800,
      deadLetter: deadLetterNameFor(JOB_NAMES.recomputeVideoDurations),
    },
  },
  [JOB_NAMES.recomputeVideoQualityScoresTick]: {
    name: JOB_NAMES.recomputeVideoQualityScoresTick,
    payloadSchema: TickPayloadSchema,
    queueOptions: { ...RANKING_TICK_QUEUE_OPTIONS(JOB_NAMES.recomputeVideoQualityScoresTick) },
  },
  [JOB_NAMES.recomputeVideoQualityScores]: {
    name: JOB_NAMES.recomputeVideoQualityScores,
    payloadSchema: AsOfOnlyPayloadSchema,
    queueOptions: {
      policy: "singleton",
      ...RECOMPUTE_RETRY,
      // Longer than its siblings: it walks every published video and reads the whole
      // engagement sidecar for each.
      expireInSeconds: 3_600,
      deadLetter: deadLetterNameFor(JOB_NAMES.recomputeVideoQualityScores),
    },
  },
  [JOB_NAMES.recomputePlatformCategoryPopularityTick]: {
    name: JOB_NAMES.recomputePlatformCategoryPopularityTick,
    payloadSchema: TickPayloadSchema,
    queueOptions: {
      ...RANKING_TICK_QUEUE_OPTIONS(JOB_NAMES.recomputePlatformCategoryPopularityTick),
    },
  },
  [JOB_NAMES.recomputePlatformCategoryPopularity]: {
    name: JOB_NAMES.recomputePlatformCategoryPopularity,
    payloadSchema: AsOfOnlyPayloadSchema,
    queueOptions: {
      policy: "singleton",
      ...RECOMPUTE_RETRY,
      expireInSeconds: 900,
      deadLetter: deadLetterNameFor(JOB_NAMES.recomputePlatformCategoryPopularity),
    },
  },
  [JOB_NAMES.recomputeUserAffinitiesTick]: {
    name: JOB_NAMES.recomputeUserAffinitiesTick,
    payloadSchema: TickPayloadSchema,
    queueOptions: { ...RANKING_TICK_QUEUE_OPTIONS(JOB_NAMES.recomputeUserAffinitiesTick) },
  },
  [JOB_NAMES.recomputeUserAffinities]: {
    name: JOB_NAMES.recomputeUserAffinities,
    payloadSchema: AsOfOnlyPayloadSchema,
    queueOptions: {
      policy: "singleton",
      ...RECOMPUTE_RETRY,
      // The widest scan in the domain — every signed-in viewer's watch history, twice
      // (once grouped by category, once by creator).
      expireInSeconds: 3_600,
      deadLetter: deadLetterNameFor(JOB_NAMES.recomputeUserAffinities),
    },
  },
  [JOB_NAMES.recomputeTrendingVideosTick]: {
    name: JOB_NAMES.recomputeTrendingVideosTick,
    payloadSchema: TickPayloadSchema,
    queueOptions: { ...RANKING_TICK_QUEUE_OPTIONS(JOB_NAMES.recomputeTrendingVideosTick) },
  },
  [JOB_NAMES.recomputeTrendingVideos]: {
    name: JOB_NAMES.recomputeTrendingVideos,
    payloadSchema: AsOfOnlyPayloadSchema,
    queueOptions: {
      policy: "singleton",
      ...RECOMPUTE_RETRY,
      // Must finish inside its own hour, or the next tick queues behind it forever.
      expireInSeconds: 1_800,
      deadLetter: deadLetterNameFor(JOB_NAMES.recomputeTrendingVideos),
    },
  },
  [JOB_NAMES.revalidateYoutubeEmbedsTick]: {
    name: JOB_NAMES.revalidateYoutubeEmbedsTick,
    payloadSchema: TickPayloadSchema,
    queueOptions: { ...RANKING_TICK_QUEUE_OPTIONS(JOB_NAMES.revalidateYoutubeEmbedsTick) },
  },
  [JOB_NAMES.revalidateYoutubeEmbeds]: {
    name: JOB_NAMES.revalidateYoutubeEmbeds,
    payloadSchema: AsOfOnlyPayloadSchema,
    queueOptions: {
      policy: "singleton",
      ...RECOMPUTE_RETRY,
      // It talks to youtube.com, one video at a time, rate-limited. Slow by design.
      expireInSeconds: 3_600,
      deadLetter: deadLetterNameFor(JOB_NAMES.revalidateYoutubeEmbeds),
    },
  },
  [JOB_NAMES.pruneEngagementDataTick]: {
    name: JOB_NAMES.pruneEngagementDataTick,
    payloadSchema: TickPayloadSchema,
    queueOptions: { ...RANKING_TICK_QUEUE_OPTIONS(JOB_NAMES.pruneEngagementDataTick) },
  },
  [JOB_NAMES.pruneEngagementData]: {
    name: JOB_NAMES.pruneEngagementData,
    payloadSchema: AsOfOnlyPayloadSchema,
    queueOptions: {
      policy: "singleton",
      ...RECOMPUTE_RETRY,
      expireInSeconds: 1_800,
      deadLetter: deadLetterNameFor(JOB_NAMES.pruneEngagementData),
    },
  },
  [JOB_NAMES.refreshStoreSearchDocument]: {
    name: JOB_NAMES.refreshStoreSearchDocument,
    payloadSchema: RefreshStoreSearchDocumentPayloadSchema,
    queueOptions: {
      policy: "standard",
      ...STANDARD_RETRY,
      expireInSeconds: 300,
      deadLetter: deadLetterNameFor(JOB_NAMES.refreshStoreSearchDocument),
    },
  },
  [JOB_NAMES.expireCommerceQuotesTick]: {
    name: JOB_NAMES.expireCommerceQuotesTick,
    payloadSchema: TickPayloadSchema,
    queueOptions: {
      policy: "exclusive",
      retryLimit: 2,
      retryDelay: 60,
      retryBackoff: true,
      retryDelayMax: 600,
      expireInSeconds: 60,
      deadLetter: deadLetterNameFor(JOB_NAMES.expireCommerceQuotesTick),
    },
  },
  [JOB_NAMES.expireCommerceQuotes]: {
    name: JOB_NAMES.expireCommerceQuotes,
    payloadSchema: AsOfOnlyPayloadSchema,
    queueOptions: {
      policy: "singleton",
      ...RECOMPUTE_RETRY,
      expireInSeconds: 900,
      deadLetter: deadLetterNameFor(JOB_NAMES.expireCommerceQuotes),
    },
  },
  [JOB_NAMES.releaseExpiredInventoryReservationsTick]: {
    name: JOB_NAMES.releaseExpiredInventoryReservationsTick,
    payloadSchema: TickPayloadSchema,
    queueOptions: {
      policy: "exclusive",
      retryLimit: 2,
      retryDelay: 60,
      retryBackoff: true,
      retryDelayMax: 600,
      expireInSeconds: 60,
      deadLetter: deadLetterNameFor(JOB_NAMES.releaseExpiredInventoryReservationsTick),
    },
  },
  [JOB_NAMES.releaseExpiredInventoryReservations]: {
    name: JOB_NAMES.releaseExpiredInventoryReservations,
    payloadSchema: AsOfOnlyPayloadSchema,
    queueOptions: {
      policy: "singleton",
      ...RECOMPUTE_RETRY,
      expireInSeconds: 900,
      deadLetter: deadLetterNameFor(JOB_NAMES.releaseExpiredInventoryReservations),
    },
  },
  [JOB_NAMES.dispatchCommerceWebhookEvent]: {
    name: JOB_NAMES.dispatchCommerceWebhookEvent,
    payloadSchema: DispatchCommerceWebhookEventPayloadSchema,
    queueOptions: {
      policy: "standard",
      ...STANDARD_RETRY,
      expireInSeconds: 300,
      deadLetter: deadLetterNameFor(JOB_NAMES.dispatchCommerceWebhookEvent),
    },
  },
  [JOB_NAMES.reconcileCommercePaymentsTick]: {
    name: JOB_NAMES.reconcileCommercePaymentsTick,
    payloadSchema: TickPayloadSchema,
    queueOptions: {
      policy: "exclusive",
      retryLimit: 2,
      retryDelay: 60,
      retryBackoff: true,
      retryDelayMax: 600,
      expireInSeconds: 60,
      deadLetter: deadLetterNameFor(JOB_NAMES.reconcileCommercePaymentsTick),
    },
  },
  [JOB_NAMES.reconcileCommercePayments]: {
    name: JOB_NAMES.reconcileCommercePayments,
    payloadSchema: AsOfOnlyPayloadSchema,
    queueOptions: {
      policy: "singleton",
      ...RECOMPUTE_RETRY,
      expireInSeconds: 900,
      deadLetter: deadLetterNameFor(JOB_NAMES.reconcileCommercePayments),
    },
  },
  /**
   * STORE Phase 14. `standard` rather than `singleton`: several connector commands for
   * different orders are legitimately in flight at once, and the row lock in
   * `claimConnectorOutboxRow` is what serialises work on any single row.
   */
  [JOB_NAMES.dispatchConnectorCommand]: {
    name: JOB_NAMES.dispatchConnectorCommand,
    payloadSchema: DispatchConnectorCommandPayloadSchema,
    queueOptions: {
      policy: "standard",
      ...STANDARD_RETRY,
      expireInSeconds: 300,
      deadLetter: deadLetterNameFor(JOB_NAMES.dispatchConnectorCommand),
    },
  },
  [JOB_NAMES.reconcileConnectorStateTick]: {
    name: JOB_NAMES.reconcileConnectorStateTick,
    payloadSchema: TickPayloadSchema,
    queueOptions: {
      policy: "exclusive",
      retryLimit: 2,
      retryDelay: 60,
      retryBackoff: true,
      retryDelayMax: 600,
      expireInSeconds: 60,
      deadLetter: deadLetterNameFor(JOB_NAMES.reconcileConnectorStateTick),
    },
  },
  [JOB_NAMES.reconcileConnectorState]: {
    name: JOB_NAMES.reconcileConnectorState,
    payloadSchema: AsOfOnlyPayloadSchema,
    queueOptions: {
      policy: "singleton",
      ...RECOMPUTE_RETRY,
      expireInSeconds: 900,
      deadLetter: deadLetterNameFor(JOB_NAMES.reconcileConnectorState),
    },
  },
  /**
   * STORE Phase 14b. `standard`, because several buyers upload artwork at once and the
   * per-document guard is the `pending_scan` predicate on the UPDATE, not queue serialization.
   */
  [JOB_NAMES.scanEncryptedDocument]: {
    name: JOB_NAMES.scanEncryptedDocument,
    payloadSchema: ScanEncryptedDocumentPayloadSchema,
    queueOptions: {
      policy: "standard",
      ...STANDARD_RETRY,
      expireInSeconds: 300,
      deadLetter: deadLetterNameFor(JOB_NAMES.scanEncryptedDocument),
    },
  },
  [JOB_NAMES.sweepPendingDocumentScansTick]: {
    name: JOB_NAMES.sweepPendingDocumentScansTick,
    payloadSchema: TickPayloadSchema,
    queueOptions: {
      policy: "exclusive",
      retryLimit: 2,
      retryDelay: 60,
      retryBackoff: true,
      retryDelayMax: 600,
      expireInSeconds: 60,
      deadLetter: deadLetterNameFor(JOB_NAMES.sweepPendingDocumentScansTick),
    },
  },
  [JOB_NAMES.sweepPendingDocumentScans]: {
    name: JOB_NAMES.sweepPendingDocumentScans,
    payloadSchema: AsOfOnlyPayloadSchema,
    queueOptions: {
      policy: "singleton",
      ...RECOMPUTE_RETRY,
      expireInSeconds: 900,
      deadLetter: deadLetterNameFor(JOB_NAMES.sweepPendingDocumentScans),
    },
  },
  [JOB_NAMES.deriveProductRelationsTick]: {
    name: JOB_NAMES.deriveProductRelationsTick,
    payloadSchema: TickPayloadSchema,
    queueOptions: {
      policy: "exclusive",
      retryLimit: 2,
      retryDelay: 60,
      retryBackoff: true,
      retryDelayMax: 600,
      expireInSeconds: 60,
      deadLetter: deadLetterNameFor(JOB_NAMES.deriveProductRelationsTick),
    },
  },
  [JOB_NAMES.deriveProductRelations]: {
    name: JOB_NAMES.deriveProductRelations,
    payloadSchema: AsOfOnlyPayloadSchema,
    queueOptions: {
      policy: "singleton",
      ...RECOMPUTE_RETRY,
      // A full scan of completed order lines; generous, and still bounded.
      expireInSeconds: 1800,
      deadLetter: deadLetterNameFor(JOB_NAMES.deriveProductRelations),
    },
  },
  [JOB_NAMES.rollupCommerceProductDailySignalTick]: {
    name: JOB_NAMES.rollupCommerceProductDailySignalTick,
    payloadSchema: TickPayloadSchema,
    queueOptions: {
      policy: "exclusive",
      retryLimit: 2,
      retryDelay: 60,
      retryBackoff: true,
      retryDelayMax: 600,
      expireInSeconds: 60,
      deadLetter: deadLetterNameFor(JOB_NAMES.rollupCommerceProductDailySignalTick),
    },
  },
  [JOB_NAMES.rollupCommerceProductDailySignal]: {
    name: JOB_NAMES.rollupCommerceProductDailySignal,
    payloadSchema: AsOfOnlyPayloadSchema,
    queueOptions: {
      policy: "singleton",
      ...RECOMPUTE_RETRY,
      // One day's signals, aggregated per product. Small, and the series it builds is what
      // the MAD spike baseline is measured against.
      expireInSeconds: 1800,
      deadLetter: deadLetterNameFor(JOB_NAMES.rollupCommerceProductDailySignal),
    },
  },
  [JOB_NAMES.recomputeCommerceCategoryDemandTick]: {
    name: JOB_NAMES.recomputeCommerceCategoryDemandTick,
    payloadSchema: TickPayloadSchema,
    queueOptions: {
      policy: "exclusive",
      retryLimit: 2,
      retryDelay: 60,
      retryBackoff: true,
      retryDelayMax: 600,
      expireInSeconds: 60,
      deadLetter: deadLetterNameFor(JOB_NAMES.recomputeCommerceCategoryDemandTick),
    },
  },
  [JOB_NAMES.recomputeCommerceCategoryDemand]: {
    name: JOB_NAMES.recomputeCommerceCategoryDemand,
    payloadSchema: AsOfOnlyPayloadSchema,
    queueOptions: {
      policy: "singleton",
      ...RECOMPUTE_RETRY,
      // Percentiles over a 30-day qualified sample, per category per currency.
      expireInSeconds: 1800,
      deadLetter: deadLetterNameFor(JOB_NAMES.recomputeCommerceCategoryDemand),
    },
  },
  [JOB_NAMES.recomputeCommerceProductTrendingTick]: {
    name: JOB_NAMES.recomputeCommerceProductTrendingTick,
    payloadSchema: TickPayloadSchema,
    queueOptions: {
      policy: "exclusive",
      retryLimit: 2,
      retryDelay: 60,
      retryBackoff: true,
      retryDelayMax: 600,
      expireInSeconds: 60,
      deadLetter: deadLetterNameFor(JOB_NAMES.recomputeCommerceProductTrendingTick),
    },
  },
  [JOB_NAMES.recomputeCommerceProductTrending]: {
    name: JOB_NAMES.recomputeCommerceProductTrending,
    payloadSchema: AsOfOnlyPayloadSchema,
    queueOptions: {
      policy: "singleton",
      ...RECOMPUTE_RETRY,
      // MUST finish inside its own hour, or the next tick queues behind it forever.
      expireInSeconds: 1800,
      deadLetter: deadLetterNameFor(JOB_NAMES.recomputeCommerceProductTrending),
    },
  },
  // `satisfies` rather than a plain annotation: this is what makes a job name with no
  // definition a COMPILE error, not merely a misspelled key.
} as const satisfies Record<JobName, JobDefinition>;

/** The payload type of a job, inferred from its schema — never hand-written. */
export type JobPayload<TName extends JobName> = z.infer<
  (typeof JOB_DEFINITIONS)[TName]["payloadSchema"]
>;

/**
 * The cron schedule for each tick queue. 5-field, UTC (pg-boss defaults to UTC and every
 * process here asserts TZ=UTC anyway).
 *
 * WHY A TICK QUEUE AND NOT A DIRECT SCHEDULE. `boss.schedule()` sends a FIXED payload, so
 * a scheduled job cannot carry the run's `asOf` — which breaks §4c rule 3 outright. The
 * tick handler's only job is to quantize "now" and enqueue the real job with an explicit
 * asOf and a deterministic id derived from it. That buys three things: the stored job row
 * carries its own asOf so the run is replayable from the queue itself; a double cron fire
 * inside the same UTC day dedups to one job id; and an operator can replay any historical
 * asOf with a single `send`.
 */
export const SCHEDULED_JOB_CRONS: Readonly<Record<string, string>> = {
  [JOB_NAMES.recomputeOpportunityScoresTick]: "15 2 * * *",
  [JOB_NAMES.recomputeDemandSignalsTick]: "45 2 * * *",
  [JOB_NAMES.refreshTalentProjectionsTick]: "5 * * * *",
  // After the other nightlies, so a slow recompute cannot delay the streak decay past
  // the hour a project card is first read in the earliest timezone.
  [JOB_NAMES.recomputeDailyLogStreaksTick]: "25 3 * * *",
  // EVERY MINUTE (§9.8). The 24-hour window is a MINIMUM, never a maximum: a late sweep
  // leaves a window open longer, which is always the safe direction, and the sweep reads
  // persisted state rather than a timer — so a worker down six hours locks six hours of
  // backlog on restart, all at correct amounts. NEVER pre-lock.
  [JOB_NAMES.sweepDisputeWindowsTick]: "* * * * *",
  // After the streak decay, so the nightly cap table is computed over a settled ledger.
  [JOB_NAMES.recomputeEquitySnapshotTick]: "45 3 * * *",
  // `reconcile-escrow-ledger-tick` IS NO LONGER SCHEDULED (§7A.6). Nothing in this domain
  // has a provider balance to disagree with any more, so there is nothing to reconcile.
  // The queue definition survives so migration 0016's rows stay explicable; the schedule
  // does not, because a cron firing hourly against a retired surface is noise an operator
  // will learn to ignore.
  // After the equity snapshot at 03:45, because investor confidence reads the cap table's
  // dispute history and a signal computed over a half-recomputed ledger is a signal that
  // changes when nothing changed.
  [JOB_NAMES.recomputeInvestorConfidenceTick]: "5 4 * * *",
  // DAILY, not monthly (§7A.3). A period is one calendar month in the PROJECT'S own zone,
  // so the roll-over lands on a different UTC instant for every project — 1 April begins
  // in Kiritimati fourteen hours before it begins in Honolulu. A monthly cron would have
  // to pick one instant and be wrong for everyone else, and the error would be a whole
  // day of somebody's wages in the wrong statement.
  //
  // At 00:10 UTC, EARLY: the close must run before the draft, or the draft spends a whole
  // day writing the elapsed month's minutes into a period that should already have
  // stopped accruing.
  [JOB_NAMES.closeCompensationPeriodTick]: "10 0 * * *",
  // After the equity snapshot at 03:45, because `equity_delta` reads the cap table and a
  // statement drafted over a half-recomputed ledger is a statement that changes when
  // nothing changed.
  [JOB_NAMES.recomputeCompensationDraftTick]: "15 4 * * *",
  // §10, and the ORDER between these two is load-bearing rather than incidental:
  // `recompute-program-stats` counts `openGapCount` and `overlapFlagCount` FROM the branch
  // statuses, so the signals pass must land first or the tiles report yesterday's map.
  // Ordering here is by cron time, not by code — the same arrangement §7A's close-then-draft
  // pair relies on.
  [JOB_NAMES.recomputeBranchSignalsTick]: "20 3 * * *",
  [JOB_NAMES.recomputeProgramStatsTick]: "35 3 * * *",

  // --- Home feed ranking (HOME_BACKEND_STRUCTURE.md §6).
  //
  // THE 01:00 HOUR IS A DEPENDENCY CHAIN EXPRESSED IN CRON, not in code, exactly as the
  // 03:20/03:35 pair above is. Read downward:
  //
  //   05  durations   — completion rate has no denominator until this writes one, and
  //                     `video.duration_seconds` is NULL on every YouTube row because
  //                     oEmbed returns no duration.
  //   25  quality     — needs durations. Also writes `unique_viewer_count`, which is the
  //                     engagement denominator.
  //   40  popularity  — needs quality, and feeds cold start.
  //   50  affinities  — needs popularity for its fallback.
  //
  // Twenty minutes between each is not a measurement; it is room for a slow night on a
  // catalog that has not grown yet. If any of these starts overrunning its gap, the answer
  // is to chain them by enqueue rather than to shave the interval.
  //
  // ## ON COLLISIONS, honestly
  //
  // §6 claims these slots "do not collide with the 11 existing crons". That claim is not
  // achievable and was never true: `sweep-dispute-windows-tick` runs `* * * * *`, so EVERY
  // cron on this platform shares its minute with that one, always.
  //
  // Sharing a minute is also not the thing worth avoiding. A tick does ONE INSERT and each
  // queue is its own `singleton`; two ticks firing together cost nothing. What is worth
  // avoiding is landing a tick on a HEAVY NIGHTLY RECOMPUTE, where the real job it enqueues
  // then contends for the same connections. These slots are chosen for that:
  //
  //   * `8 1` rather than `5 1` — `refresh-talent-projections-tick` is `5 * * * *`, so 01:05
  //     already has an hourly job on it.
  //   * `18 * * * *` rather than `35 * * * *` — `:35` is `recompute-program-stats-tick`
  //     (03:35), and an hourly job must not meet a nightly one 365 times a year. `:18` is
  //     unoccupied at every hour.
  [JOB_NAMES.recomputeVideoDurationsTick]: "8 1 * * *",
  [JOB_NAMES.recomputeVideoQualityScoresTick]: "25 1 * * *",
  [JOB_NAMES.recomputePlatformCategoryPopularityTick]: "40 1 * * *",
  [JOB_NAMES.recomputeUserAffinitiesTick]: "50 1 * * *",
  // HOURLY, and the only job in this domain that is. A "trending" chip recomputed nightly
  // is a lie about what the word means — §6 says so and this is where it is enforced.
  [JOB_NAMES.recomputeTrendingVideosTick]: "18 * * * *",
  // The §8.2 backstop, for videos nobody happens to be watching. The fast path is the
  // client's playback-error report at three distinct fingerprints; this is what catches a
  // dead player on a video with no viewers left to report it.
  [JOB_NAMES.revalidateYoutubeEmbedsTick]: "10 5 * * *",
  // Runs BEFORE the 05:10 revalidation and well after the 01:xx chain, so a night's
  // recomputes are complete before anything is removed.
  [JOB_NAMES.pruneEngagementDataTick]: "55 4 * * *",
  // STORE Phase 3 — hourly quote/RFQ expiry. Minute :20 is lightly occupied (branch
  // signals is daily at 03:20 only); tick work is a single enqueue so sharing is fine.
  [JOB_NAMES.expireCommerceQuotesTick]: "20 * * * *",
  // STORE Phase 4 — hourly inventory hold release. Minute :35 avoids the quote expiry tick.
  [JOB_NAMES.releaseExpiredInventoryReservationsTick]: "35 * * * *",
  // STORE Phase 5 — hourly payment reconciliation. Minute :50 avoids inventory/quote ticks.
  [JOB_NAMES.reconcileCommercePaymentsTick]: "50 * * * *",
  // STORE Phase 14 — hourly connector reconciliation. Minute :05 keeps it clear of the
  // :20/:35/:50 commerce ticks, and puts it a comfortable distance after the top-of-hour
  // trending run at :12 rather than contending with it.
  [JOB_NAMES.reconcileConnectorStateTick]: "5 * * * *",
  // STORE Phase 14b — the lost-enqueue sweep. Every fifteen minutes rather than hourly:
  // a buyer waiting on artwork to become attachable is blocked until it runs.
  [JOB_NAMES.sweepPendingDocumentScansTick]: "*/15 * * * *",
  // STORE Phase 9 — nightly relation derivation. 02:40 UTC sits after the 01:xx
  // recompute chain and well before the 04:55 prune, so a night's completed orders are
  // settled before their co-occurrence is mined.
  [JOB_NAMES.deriveProductRelationsTick]: "40 2 * * *",
  // STORE Phase 13 — nightly signal rollup at 02:50, after relation derivation at 02:40 and
  // before the category demand recompute that reads nothing from it but shares its window.
  [JOB_NAMES.rollupCommerceProductDailySignalTick]: "50 2 * * *",
  // STORE Phase 13 — nightly category demand at 03:00, clear of the 03:20-03:45 chain.
  [JOB_NAMES.recomputeCommerceCategoryDemandTick]: "0 3 * * *",
  // STORE Phase 13 — hourly scoring. Minute :12 is unoccupied at EVERY hour: :05, :18, :20,
  // :35 and :50 already carry hourly ticks, and an hourly job must not meet a nightly one
  // 365 times a year.
  [JOB_NAMES.recomputeCommerceProductTrendingTick]: "12 * * * *",
};

export type JobEnqueueError =
  | { type: "JOB_PAYLOAD_INVALID"; jobName: JobName; issues: readonly string[] }
  | { type: "JOB_QUEUE_UNAVAILABLE"; jobName: JobName };

/**
 * Marks an error as PERMANENT — retrying it can never succeed.
 *
 * The canonical case is a payload that fails its schema. A rolling deploy guarantees
 * old-shaped payloads are in flight while new-shaped code is running, so this is a real
 * runtime condition rather than a theoretical one; burning five exponential backoff
 * attempts on a payload that will never parse just delays the dead-letter signal by half
 * an hour. §9.7 draws the same line for schema-invalid LLM output.
 */
export class PermanentJobError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = "PermanentJobError";
    this.reason = reason;
  }
}

/**
 * The pg-boss adapter over the EXISTING pool from src/db/index.ts.
 *
 * Sharing the pool is not convenience — it is what makes a transactional enqueue
 * possible. `POST /discovery/problem-reports` inserts a submission AND enqueues its
 * clustering job; if those are not one transaction you get either a submission nobody
 * ever clusters (the enqueue failed after the commit, and it is invisible — no error
 * surface anywhere) or a job running against a row that rolled back. pg-boss's
 * `fromDrizzle(tx)` covers the in-transaction case and only works when pg-boss executes
 * on OUR connection.
 *
 * The API's instance is send-only (`supervise: false, schedule: false`), so it issues one
 * INSERT per enqueue and holds no persistent connection — `useListenNotify` defaults to
 * false, so pg-boss polls rather than holding a LISTEN session.
 *
 * `pool.end()` ownership stays in src/db/index.ts; every `stop()` here passes
 * `close: false` so pg-boss never closes a pool it does not own.
 */
export function createPgBossDbAdapter(targetPool: Pool = pool): PgBossDb {
  return {
    executeSql: async (text: string, values?: unknown[]) => targetPool.query(text, values ?? []),
  };
}

let sendOnlyBossPromise: Promise<PgBoss> | null = null;

/**
 * The API process's send-only pg-boss instance, started lazily on first enqueue.
 *
 * `migrate: false` — neither runtime process owns schema creation. `pnpm jobs:install`
 * does, as an ordered deploy step after `pnpm db:migrate`. A rolling deploy runs two
 * instances concurrently, and relying on a library's internal advisory lock to serialize
 * a schema migration is the kind of implicit dependency this codebase writes long
 * comments to avoid.
 */
async function getSendOnlyBoss(): Promise<PgBoss> {
  sendOnlyBossPromise ??= (async () => {
    const boss = new PgBoss({
      db: createPgBossDbAdapter(),
      schema: config.JOBS_SCHEMA,
      migrate: false,
      supervise: false,
      schedule: false,
    });

    boss.on("error", (error: unknown) => {
      console.error("pg-boss (send-only) error:", error);
    });

    await boss.start();
    return boss;
  })();

  return sendOnlyBossPromise;
}

/** Closes the API's send-only instance. Called from the HTTP process's shutdown path. */
export async function stopSendOnlyBoss(): Promise<void> {
  if (!sendOnlyBossPromise) return;

  const boss = await sendOnlyBossPromise;
  sendOnlyBossPromise = null;
  // close: false — the pool belongs to src/db/index.ts, which ends it itself.
  await boss.stop({ graceful: false, close: false });
}

/**
 * Builds a deterministic, valid UUID from an idempotency key.
 *
 * pg-boss's job id column is `uuid`, so an arbitrary string cannot be used directly.
 * SHA-256 the key, take the first 16 bytes, and stamp the RFC 4122 version and variant
 * bits. Enqueuing the same logical work twice then collides on the primary key and the
 * second send is dropped.
 *
 * BE HONEST ABOUT THE LIMIT: pg-boss deletes completed jobs after `deleteAfterSeconds`
 * (7 days by default), after which the id is free again. This is a DEDUP WINDOW, not a
 * guarantee — which is why every handler is also idempotent by construction, and that is
 * the layer actually relied upon.
 */
export async function deterministicJobId(idempotencyKey: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const digest = createHash("sha256").update(idempotencyKey, "utf8").digest();

  const bytes = Uint8Array.prototype.slice.call(digest, 0, 16);
  // Version 4 (random) and RFC 4122 variant, so the value is a well-formed UUID even
  // though it is derived rather than random.
  const versionByte = bytes[6];
  const variantByte = bytes[8];
  if (versionByte === undefined || variantByte === undefined) {
    throw new Error("deterministicJobId: SHA-256 digest was shorter than 16 bytes");
  }
  bytes[6] = (versionByte & 0x0f) | 0x40;
  bytes[8] = (variantByte & 0x3f) | 0x80;

  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface SendJobOptions {
  /**
   * Deduplicates this enqueue. Two sends with the same key inside the retention window
   * produce ONE job.
   */
  readonly idempotencyKey?: string;
  /**
   * A pg-boss database adapter to run the INSERT on — pass `fromDrizzle(tx)` to enlist
   * the enqueue in an open transaction. Omit to use the API's send-only instance.
   */
  readonly db?: PgBossDb;
  /** Delays the job. Used by the tick handlers for jitter, never for correctness. */
  readonly startAfterSeconds?: number;
}

/**
 * Enqueues a job, validating the payload ON THE WAY OUT as well as on the way in.
 *
 * Enqueue-side validation is not redundant: it fails at the CALL SITE, where the stack
 * trace names the controller that built the bad payload, instead of six hours later in a
 * worker log with no context about who sent it.
 */
export async function sendJob<TName extends JobName>(
  jobName: TName,
  payload: JobPayload<TName>,
  options: SendJobOptions = {},
): Promise<Result<{ readonly jobId: string | null }, JobEnqueueError>> {
  const definition = JOB_DEFINITIONS[jobName];
  const parsedPayload = definition.payloadSchema.safeParse(payload);

  if (!parsedPayload.success) {
    return {
      success: false,
      error: {
        type: "JOB_PAYLOAD_INVALID",
        jobName,
        issues: parsedPayload.error.issues.map(
          (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
        ),
      },
    };
  }

  const sendOptions: SendOptions = {};
  if (options.idempotencyKey !== undefined) {
    sendOptions.id = await deterministicJobId(options.idempotencyKey);
  }
  if (options.startAfterSeconds !== undefined) {
    sendOptions.startAfter = options.startAfterSeconds;
  }
  if (options.db !== undefined) {
    sendOptions.db = options.db;
  }

  const boss = await getSendOnlyBoss();

  // pg-boss signals a DEDUPLICATED send by resolving null rather than throwing, so a
  // null jobId is a success — the work is already queued — and callers must not treat it
  // as a failure.
  //
  // `payload` is sent rather than `parsedPayload.data` purely to keep the call
  // assertion-free: the parse above already proved the two are equivalent, and the
  // caller's value carries the precise JobPayload<TName> type that pg-boss accepts.
  const jobId = await boss.send(jobName, payload, sendOptions);

  return { success: true, value: { jobId } };
}

/**
 * The payload schemas, exported so a handler can parse with ITS OWN schema.
 *
 * WHY HANDLERS PASS THE SCHEMA rather than just the job name: indexing
 * `JOB_DEFINITIONS[jobName].payloadSchema` inside a generic function yields the UNION of
 * every job's output type, and TypeScript cannot narrow that back to one job's payload
 * without a type assertion — which CLAUDE.md §2 bans. Threading the schema through keeps
 * the return type exact and assertion-free.
 */
export const JOB_PAYLOAD_SCHEMAS = {
  [JOB_NAMES.geocodeAndClusterSubmission]: GeocodeAndClusterSubmissionPayloadSchema,
  [JOB_NAMES.recomputeOpportunityScoresTick]: TickPayloadSchema,
  [JOB_NAMES.recomputeOpportunityScores]: AsOfOnlyPayloadSchema,
  [JOB_NAMES.recomputeDemandSignalsTick]: TickPayloadSchema,
  [JOB_NAMES.recomputeDemandSignals]: WindowedAsOfPayloadSchema,
  [JOB_NAMES.refreshTalentProjectionsTick]: TickPayloadSchema,
  [JOB_NAMES.refreshTalentProjections]: AsOfOnlyPayloadSchema,
  [JOB_NAMES.analyzeDailyLog]: AnalyzeDailyLogPayloadSchema,
  [JOB_NAMES.recomputeDailyLogStreaksTick]: TickPayloadSchema,
  [JOB_NAMES.recomputeDailyLogStreaks]: AsOfOnlyPayloadSchema,
  [JOB_NAMES.groundArtifacts]: VerificationStagePayloadSchema,
  [JOB_NAMES.analyzeSubstance]: VerificationStagePayloadSchema,
  [JOB_NAMES.analyzeTemporal]: VerificationStagePayloadSchema,
  [JOB_NAMES.finalizeVerdict]: VerificationStagePayloadSchema,
  [JOB_NAMES.sweepDisputeWindowsTick]: TickPayloadSchema,
  [JOB_NAMES.sweepDisputeWindows]: AsOfOnlyPayloadSchema,
  [JOB_NAMES.recomputeEquitySnapshotTick]: TickPayloadSchema,
  [JOB_NAMES.recomputeEquitySnapshot]: RecomputeEquitySnapshotPayloadSchema,
  [JOB_NAMES.submitProviderTransfer]: SubmitProviderTransferPayloadSchema,
  [JOB_NAMES.reconcileEscrowLedgerTick]: TickPayloadSchema,
  [JOB_NAMES.reconcileEscrowLedger]: ProjectScopedAsOfPayloadSchema,
  [JOB_NAMES.recomputeInvestorConfidenceTick]: TickPayloadSchema,
  [JOB_NAMES.recomputeInvestorConfidence]: ProjectScopedAsOfPayloadSchema,
  [JOB_NAMES.closeCompensationPeriodTick]: TickPayloadSchema,
  [JOB_NAMES.closeCompensationPeriod]: ProjectScopedAsOfPayloadSchema,
  [JOB_NAMES.recomputeCompensationDraftTick]: TickPayloadSchema,
  [JOB_NAMES.recomputeCompensationDraft]: ProjectScopedAsOfPayloadSchema,
  [JOB_NAMES.recomputeProgramStatsTick]: TickPayloadSchema,
  [JOB_NAMES.recomputeProgramStats]: ProgramScopedAsOfPayloadSchema,
  [JOB_NAMES.recomputeBranchSignalsTick]: TickPayloadSchema,
  [JOB_NAMES.recomputeBranchSignals]: ProgramScopedAsOfPayloadSchema,
  [JOB_NAMES.verifyYoutubeVideo]: VerifyYoutubeVideoPayloadSchema,
  [JOB_NAMES.deliverNotification]: DeliverNotificationPayloadSchema,
  // --- Home feed ranking. Every real job takes an asOf and NOTHING else: each one walks
  // --- the whole catalog or the whole viewer set, so there is no scope to carry, and a
  // --- payload with no editable field is a payload nobody can aim.
  [JOB_NAMES.recomputeVideoDurationsTick]: TickPayloadSchema,
  [JOB_NAMES.recomputeVideoDurations]: AsOfOnlyPayloadSchema,
  [JOB_NAMES.recomputeVideoQualityScoresTick]: TickPayloadSchema,
  [JOB_NAMES.recomputeVideoQualityScores]: AsOfOnlyPayloadSchema,
  [JOB_NAMES.recomputePlatformCategoryPopularityTick]: TickPayloadSchema,
  [JOB_NAMES.recomputePlatformCategoryPopularity]: AsOfOnlyPayloadSchema,
  [JOB_NAMES.recomputeUserAffinitiesTick]: TickPayloadSchema,
  [JOB_NAMES.recomputeUserAffinities]: AsOfOnlyPayloadSchema,
  [JOB_NAMES.recomputeTrendingVideosTick]: TickPayloadSchema,
  [JOB_NAMES.recomputeTrendingVideos]: AsOfOnlyPayloadSchema,
  [JOB_NAMES.revalidateYoutubeEmbedsTick]: TickPayloadSchema,
  [JOB_NAMES.revalidateYoutubeEmbeds]: AsOfOnlyPayloadSchema,
  [JOB_NAMES.pruneEngagementDataTick]: TickPayloadSchema,
  [JOB_NAMES.pruneEngagementData]: AsOfOnlyPayloadSchema,
  [JOB_NAMES.refreshStoreSearchDocument]: RefreshStoreSearchDocumentPayloadSchema,
  [JOB_NAMES.expireCommerceQuotesTick]: TickPayloadSchema,
  [JOB_NAMES.expireCommerceQuotes]: AsOfOnlyPayloadSchema,
  [JOB_NAMES.releaseExpiredInventoryReservationsTick]: TickPayloadSchema,
  [JOB_NAMES.releaseExpiredInventoryReservations]: AsOfOnlyPayloadSchema,
  [JOB_NAMES.dispatchCommerceWebhookEvent]: DispatchCommerceWebhookEventPayloadSchema,
  [JOB_NAMES.dispatchConnectorCommand]: DispatchConnectorCommandPayloadSchema,
  [JOB_NAMES.reconcileConnectorStateTick]: TickPayloadSchema,
  [JOB_NAMES.reconcileConnectorState]: AsOfOnlyPayloadSchema,
  [JOB_NAMES.scanEncryptedDocument]: ScanEncryptedDocumentPayloadSchema,
  [JOB_NAMES.sweepPendingDocumentScansTick]: TickPayloadSchema,
  [JOB_NAMES.sweepPendingDocumentScans]: AsOfOnlyPayloadSchema,
  [JOB_NAMES.reconcileCommercePaymentsTick]: TickPayloadSchema,
  [JOB_NAMES.reconcileCommercePayments]: AsOfOnlyPayloadSchema,
  [JOB_NAMES.deriveProductRelationsTick]: TickPayloadSchema,
  [JOB_NAMES.deriveProductRelations]: AsOfOnlyPayloadSchema,
  [JOB_NAMES.rollupCommerceProductDailySignalTick]: TickPayloadSchema,
  [JOB_NAMES.rollupCommerceProductDailySignal]: AsOfOnlyPayloadSchema,
  [JOB_NAMES.recomputeCommerceCategoryDemandTick]: TickPayloadSchema,
  [JOB_NAMES.recomputeCommerceCategoryDemand]: AsOfOnlyPayloadSchema,
  [JOB_NAMES.recomputeCommerceProductTrendingTick]: TickPayloadSchema,
  [JOB_NAMES.recomputeCommerceProductTrending]: AsOfOnlyPayloadSchema,
} as const satisfies Record<JobName, z.ZodType>;

/**
 * Parses a payload arriving at a HANDLER.
 *
 * §0 applied to job data. `job.data` is JSON from a database row that may have been
 * written by a PREVIOUS DEPLOY whose payload shape differs, by a hand-run script, or by
 * an operator in a dashboard — so it is untrusted input in exactly the sense CLAUDE.md §2
 * means, and it gets parsed at the boundary before any logic runs.
 *
 * @throws PermanentJobError — a malformed payload can never succeed on retry, so it must
 *         dead-letter immediately rather than burn five exponential backoff attempts.
 */
export function parseJobPayload<TSchema extends z.ZodType>(
  jobName: JobName,
  schema: TSchema,
  rawPayload: unknown,
): z.infer<TSchema> {
  const parsed = schema.safeParse(rawPayload);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new PermanentJobError(
      "PAYLOAD_SCHEMA_INVALID",
      `${jobName}: payload failed its schema (${issues})`,
    );
  }

  return parsed.data;
}

/** Idempotency keys, built in one place so an enqueuer and a replayer agree. */
export const idempotencyKeyFor = {
  geocodeAndClusterSubmission: (submissionId: string): string =>
    `${JOB_NAMES.geocodeAndClusterSubmission}:${submissionId}`,
  recomputeOpportunityScores: (asOfIso: string): string =>
    `${JOB_NAMES.recomputeOpportunityScores}:${asOfIso}`,
  recomputeDemandSignals: (asOfIso: string): string =>
    `${JOB_NAMES.recomputeDemandSignals}:${asOfIso}`,
  refreshTalentProjections: (asOfIso: string): string =>
    `${JOB_NAMES.refreshTalentProjections}:${asOfIso}`,
  // Keyed on the log alone, NOT on an attempt counter: a double-submit inside the
  // retention window must collapse to one analysis, because each one spends a request
  // against a free-tier budget. Re-analysis after an override is an explicit re-enqueue
  // with its own key (§9), not a repeat of this one.
  analyzeDailyLog: (dailyLogId: string): string => `${JOB_NAMES.analyzeDailyLog}:${dailyLogId}`,
  recomputeDailyLogStreaks: (asOfIso: string): string =>
    `${JOB_NAMES.recomputeDailyLogStreaks}:${asOfIso}`,
  // Keyed on the RUN, not the claim: a re-verification is a new run and must genuinely
  // re-run the pipeline, while a retried enqueue of the SAME run must collapse to one.
  // An override re-enqueues finalize-verdict for a run that has already reached a
  // verdict once, so that stage additionally keys on the override generation.
  groundArtifacts: (runId: string): string => `${JOB_NAMES.groundArtifacts}:${runId}`,
  analyzeSubstance: (runId: string): string => `${JOB_NAMES.analyzeSubstance}:${runId}`,
  analyzeTemporal: (runId: string): string => `${JOB_NAMES.analyzeTemporal}:${runId}`,
  finalizeVerdict: (runId: string, generation: number): string =>
    `${JOB_NAMES.finalizeVerdict}:${runId}:${generation}`,
  sweepDisputeWindows: (asOfIso: string): string => `${JOB_NAMES.sweepDisputeWindows}:${asOfIso}`,
  recomputeEquitySnapshot: (asOfIso: string, projectId: string | null): string =>
    `${JOB_NAMES.recomputeEquitySnapshot}:${asOfIso}:${projectId ?? "all"}`,
  // Keyed on the TRANSFER alone. A retried pledge request that somehow reaches the enqueue
  // twice must submit once — this is the one job in the registry where a duplicate would
  // cost money once a real card network is behind it.
  submitProviderTransfer: (transferId: string): string =>
    `${JOB_NAMES.submitProviderTransfer}:${transferId}`,
  reconcileEscrowLedger: (asOfIso: string, projectId: string | null): string =>
    `${JOB_NAMES.reconcileEscrowLedger}:${asOfIso}:${projectId ?? "all"}`,
  recomputeInvestorConfidence: (asOfIso: string, projectId: string | null): string =>
    `${JOB_NAMES.recomputeInvestorConfidence}:${asOfIso}:${projectId ?? "all"}`,
  // Keyed on `(asOf, project)` like the other recomputes. A double cron fire inside the
  // same UTC day dedups to one job, and both jobs are idempotent anyway — the close looks
  // a period up before allocating a sequence number, and the draft upserts.
  closeCompensationPeriod: (asOfIso: string, projectId: string | null): string =>
    `${JOB_NAMES.closeCompensationPeriod}:${asOfIso}:${projectId ?? "all"}`,
  recomputeCompensationDraft: (asOfIso: string, projectId: string | null): string =>
    `${JOB_NAMES.recomputeCompensationDraft}:${asOfIso}:${projectId ?? "all"}`,
  // Keyed on the NOTIFICATION row, which is already unique per recipient per event. A
  // retried enqueue inside the same transaction collapses; two genuinely different
  // notifications never do, even for the same event and the same recipient.
  // Keyed on `(asOf, program)` like the other recomputes. A double cron fire inside the
  // same UTC day dedups to one job, and both jobs are idempotent anyway — the stats job's
  // unique index on `(programId, asOf)` makes a re-run a no-op, and the signals job
  // recomputes from current rows rather than accumulating.
  recomputeProgramStats: (asOfIso: string, programId: string | null): string =>
    `${JOB_NAMES.recomputeProgramStats}:${asOfIso}:${programId ?? "all"}`,
  recomputeBranchSignals: (asOfIso: string, programId: string | null): string =>
    `${JOB_NAMES.recomputeBranchSignals}:${asOfIso}:${programId ?? "all"}`,
  deliverNotification: (notificationId: string): string =>
    `${JOB_NAMES.deliverNotification}:${notificationId}`,
  // Keyed on the video AND the youtube id being verified, not on the video alone. A creator
  // whose upload landed unverified during an outage may PATCH the URL rather than wait —
  // that is a genuinely different thing to prove and needs its own job. Keying on the video
  // alone would dedup the new enqueue against the old one for the whole retention window
  // and leave the row unverifiable with nothing in the queue. Same shape as
  // finalizeVerdict's `generation`, for the same reason.
  verifyYoutubeVideo: (videoId: string, youtubeVideoId: string): string =>
    `${JOB_NAMES.verifyYoutubeVideo}:${videoId}:${youtubeVideoId}`,
  // --- Home feed ranking. Keyed on the asOf alone, because each job is global: two ticks
  // --- firing for the same UTC boundary (a redeploy, a clock nudge) must produce ONE run.
  recomputeVideoDurations: (asOfIso: string): string =>
    `${JOB_NAMES.recomputeVideoDurations}:${asOfIso}`,
  recomputeVideoQualityScores: (asOfIso: string): string =>
    `${JOB_NAMES.recomputeVideoQualityScores}:${asOfIso}`,
  recomputePlatformCategoryPopularity: (asOfIso: string): string =>
    `${JOB_NAMES.recomputePlatformCategoryPopularity}:${asOfIso}`,
  recomputeUserAffinities: (asOfIso: string): string =>
    `${JOB_NAMES.recomputeUserAffinities}:${asOfIso}`,
  // Quantized to the HOUR rather than the day, so 24 distinct runs a day dedup correctly.
  recomputeTrendingVideos: (asOfIso: string): string =>
    `${JOB_NAMES.recomputeTrendingVideos}:${asOfIso}`,
  revalidateYoutubeEmbeds: (asOfIso: string): string =>
    `${JOB_NAMES.revalidateYoutubeEmbeds}:${asOfIso}`,
  pruneEngagementData: (asOfIso: string): string => `${JOB_NAMES.pruneEngagementData}:${asOfIso}`,
  // Include a generation so successive mutations inside the retention window each refresh.
  refreshStoreSearchDocumentProduct: (productId: string, generation: string): string =>
    `${JOB_NAMES.refreshStoreSearchDocument}:product:${productId}:${generation}`,
  refreshStoreSearchDocumentOffering: (offeringId: string, generation: string): string =>
    `${JOB_NAMES.refreshStoreSearchDocument}:offering:${offeringId}:${generation}`,
  refreshStoreSearchDocumentOrganization: (organizationId: string, generation: string): string =>
    `${JOB_NAMES.refreshStoreSearchDocument}:organization:${organizationId}:${generation}`,
  // Quantized to the HOUR: a double cron fire inside the same UTC hour dedups to one run.
  expireCommerceQuotes: (asOfIso: string): string => `${JOB_NAMES.expireCommerceQuotes}:${asOfIso}`,
  releaseExpiredInventoryReservations: (asOfIso: string): string =>
    `${JOB_NAMES.releaseExpiredInventoryReservations}:${asOfIso}`,
  /**
   * A41. SCOPED TO THE ATTEMPT, because this key becomes pg-boss's job id: keyed on the outbox row
   * alone, a retry deduplicates against the send that already failed and never runs at all.
   */
  dispatchCommerceWebhookEvent: (outboxId: string, attemptCount: number): string =>
    `${JOB_NAMES.dispatchCommerceWebhookEvent}:${outboxId}:${String(attemptCount)}`,
  // Keyed on the row, not the attempt: a re-enqueue from the reconciler must collapse into
  // the dispatch that is already queued rather than doubling it.
  dispatchConnectorCommand: (outboxId: string): string =>
    `${JOB_NAMES.dispatchConnectorCommand}:${outboxId}`,
  reconcileConnectorState: (asOfIso: string): string =>
    `${JOB_NAMES.reconcileConnectorState}:${asOfIso}`,
  // Keyed on the document, so an upload enqueue and a sweep re-enqueue collapse into one.
  scanEncryptedDocument: (documentId: string): string =>
    `${JOB_NAMES.scanEncryptedDocument}:${documentId}`,
  sweepPendingDocumentScans: (asOfIso: string): string =>
    `${JOB_NAMES.sweepPendingDocumentScans}:${asOfIso}`,
  reconcileCommercePayments: (asOfIso: string): string =>
    `${JOB_NAMES.reconcileCommercePayments}:${asOfIso}`,
  deriveProductRelations: (asOfIso: string): string =>
    `${JOB_NAMES.deriveProductRelations}:${asOfIso}`,
  rollupCommerceProductDailySignal: (asOfIso: string): string =>
    `${JOB_NAMES.rollupCommerceProductDailySignal}:${asOfIso}`,
  recomputeCommerceCategoryDemand: (asOfIso: string): string =>
    `${JOB_NAMES.recomputeCommerceCategoryDemand}:${asOfIso}`,
  recomputeCommerceProductTrending: (asOfIso: string): string =>
    `${JOB_NAMES.recomputeCommerceProductTrending}:${asOfIso}`,
} as const;
