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
  // §7's funding and escrow jobs. `submit-provider-transfer` is enqueued INSIDE the
  // pledge transaction, because §7 puts the provider call in a worker and never in the
  // request handler — a hanging card network must not hold an Express worker.
  submitProviderTransfer: "submit-provider-transfer",
  reconcileEscrowLedgerTick: "reconcile-escrow-ledger-tick",
  reconcileEscrowLedger: "reconcile-escrow-ledger",
  recomputeInvestorConfidenceTick: "recompute-investor-confidence-tick",
  recomputeInvestorConfidence: "recompute-investor-confidence",
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
  // HOURLY (§4e). Reconciliation is a comparison, not a correction: it never patches the
  // ledger, it posts the delta into `reconciliation_suspense` and alarms. Running it often
  // is cheap and shortens the window in which a discrepancy is invisible.
  [JOB_NAMES.reconcileEscrowLedgerTick]: "20 * * * *",
  // After the equity snapshot at 03:45, because investor confidence reads the cap table's
  // dispute history and a signal computed over a half-recomputed ledger is a signal that
  // changes when nothing changed.
  [JOB_NAMES.recomputeInvestorConfidenceTick]: "5 4 * * *",
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
} as const;
