/**
 * Drives one daily log through a REAL Gemini call and on into a REAL §9 verdict, against a
 * REAL database (R_AND_D_BACKEND_STRUCTURE.md §8 "Analysis: one Gemini call", §9.7, §17).
 *
 * WHY THIS EXISTS. Every other proof in this repo stops short of the model.
 * `src/lib/gemini.test.ts` injects `fetch`, so it proves the parsing and the failure
 * classification and nothing about the provider. `pnpm db:smoke-workshop` submits a log and
 * asserts only that a receipt is not a verdict. `pnpm db:smoke-proof-of-effort` writes its
 * own `daily_log_extracted_claim` rows by hand — `generatedByModel = 'smoke'` — because §9's
 * formula, chain and dispute machine must stay deterministic and offline.
 *
 * The consequence, until this script existed, was that `daily_log_transcript_segment` and
 * `daily_log_ai_summary_chip` had never held a single row in any environment, and every
 * verdict in the database had been computed from hand-typed minutes. The formula was right;
 * its input was fabricated. This script closes exactly that gap and nothing else:
 *
 *   a real log → ONE real Gemini call → transcript + chips + claims + evidence links
 *              → an effort claim → the four pipeline stages → a verdict whose minutes
 *                trace back to what the MODEL extracted from what the MEMBER wrote.
 *
 *   pnpm db:smoke-daily-log-analysis
 *
 * NEEDS A GEMINI_API_KEY and refuses to run without one. A smoke test that passes by
 * recording `skipped_unconfigured` proves the opposite of what it claims to.
 *
 * Needs no worker: the job handler and the four pipeline stages are the same functions
 * pg-boss calls, invoked directly and in order — the only difference from production.
 *
 * COSTS QUOTA: two `generateContent` requests per run (one per log), plus one free oEmbed
 * call. Run it against a development database and a development key.
 *
 * THIS SCRIPT LEAVES ITS ROWS BEHIND, deliberately and for the same reason
 * scripts/smoke-proof-of-effort.ts does: `project_audit_entry` rejects DELETE outright, and
 * `effort_claim` holds a `restrict` FK into the daily log it priced. A run that could erase
 * itself would be a run proving those guarantees do not hold. Every run uses a freshly
 * suffixed slug, so runs never collide. The one thing it DOES clean up is its own pg-boss
 * rows — see the note at the bottom.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { config } from "#src/config/index.js";
import { db, pool } from "#src/db/index.js";
import {
  dailyLog,
  dailyLogAiSummaryChip,
  dailyLogEvidenceLink,
  dailyLogExtractedClaim,
  dailyLogTranscriptSegment,
  effortClaim,
  projectMember,
  projectStats,
  researchCategory,
  researchProject,
  user,
  verificationStep,
} from "#src/db/schema.js";
import { handleAnalyzeDailyLog } from "#src/jobs/analyze-daily-log.js";
import { parseExternalLink } from "#src/lib/external-link.js";
import { DAILY_LOG_ANALYSIS_PROMPT_VERSION } from "#src/lib/gemini.js";
import { stopSendOnlyBoss } from "#src/lib/jobs.js";
import * as logsService from "#src/services/daily-logs.service.js";
import {
  finalizeClaimVerdict,
  overrideVerificationStep,
  submitEffortClaim,
} from "#src/services/effort-claims.service.js";
import {
  acceptFairMarketRate,
  lockFairMarketRate,
  proposeFairMarketRate,
  RATE_LOCK_ACKNOWLEDGEMENT,
} from "#src/services/fair-market-rate.service.js";
import {
  runAnalyzeSubstance,
  runAnalyzeTemporal,
  runGroundArtifacts,
} from "#src/services/verification.service.js";

/**
 * The video the transcription leg runs against.
 *
 * "Me at the zoo" — the oldest video on YouTube, nineteen seconds long, public since 2005
 * and about as unlikely to be taken down as any third-party URL gets. Short on purpose:
 * the assertion is that the fileData branch reaches the model and comes back with real
 * timed segments, and a nineteen-second clip proves that for ~1.7k input tokens.
 */
const FIXTURE_VIDEO_URL = "https://www.youtube.com/watch?v=jNQXAC9IVRw";

/**
 * The text-only log's narrative, and the §9 leg's entire input.
 *
 * WRITTEN THE WAY A MEMBER WOULD WRITE IT, not as a payload: a stated duration in prose, a
 * blocker, and one link on an allowlisted host. Every number downstream — the claim's
 * minutes, the slices, the basis points — is whatever the model reads OUT of this sentence.
 * Nothing in this script asserts a hard-coded 180.
 */
const TEXT_LOG_NARRATIVE = [
  "Spent about 3 hours today wiring the compressor telemetry board and flashing the",
  "controller. Blocked on the missing CAN transceiver — the replacement ships Thursday.",
  "The work is up at https://github.com/qatoto/coldchain/pull/42 for review.",
].join(" ");

let failureCount = 0;

function check(label: string, passed: boolean, detail: string): void {
  console.log(`${passed ? "PASS" : "FAIL"}  ${label} — ${detail}`);
  if (!passed) failureCount += 1;
}

/** UTC day offsets, so the log dates are neither future-dated nor clock-fragile. */
function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Runs the four §9 stages inline, exactly as scripts/smoke-proof-of-effort.ts does.
 *
 * The worker is not running during a smoke test, so the stages are invoked directly rather
 * than through pg-boss. Same functions, same order, same idempotency.
 */
async function runPipelineInline(runId: string): Promise<void> {
  await runGroundArtifacts(runId);
  await runAnalyzeSubstance(runId);
  await runAnalyzeTemporal(runId);
  await finalizeClaimVerdict(runId);
}

interface AnalysisRowCounts {
  readonly segments: number;
  readonly chips: number;
  readonly claims: number;
  readonly links: number;
}

async function countAnalysisRows(dailyLogId: string): Promise<AnalysisRowCounts> {
  const [row] = await db
    .select({
      segments: sql<string>`(select count(*) from ${dailyLogTranscriptSegment} where ${dailyLogTranscriptSegment.dailyLogId} = ${dailyLogId})`,
      chips: sql<string>`(select count(*) from ${dailyLogAiSummaryChip} where ${dailyLogAiSummaryChip.dailyLogId} = ${dailyLogId})`,
      claims: sql<string>`(select count(*) from ${dailyLogExtractedClaim} where ${dailyLogExtractedClaim.dailyLogId} = ${dailyLogId})`,
      links: sql<string>`(select count(*) from ${dailyLogEvidenceLink} where ${dailyLogEvidenceLink.dailyLogId} = ${dailyLogId})`,
    })
    .from(sql`(select 1) as one`);

  return {
    segments: Number(row?.segments ?? "0"),
    chips: Number(row?.chips ?? "0"),
    claims: Number(row?.claims ?? "0"),
    links: Number(row?.links ?? "0"),
  };
}

async function readLog(dailyLogId: string): Promise<typeof dailyLog.$inferSelect> {
  const [row] = await db.select().from(dailyLog).where(eq(dailyLog.id, dailyLogId));
  if (!row) throw new Error(`daily log ${dailyLogId} vanished mid-run`);
  return row;
}

interface Fixtures {
  readonly projectId: string;
  readonly projectSlug: string;
  readonly userId: string;
  readonly memberId: string;
}

async function createFixtures(runSuffix: string): Promise<Fixtures | null> {
  const [category] = await db
    .select({ id: researchCategory.id })
    .from(researchCategory)
    .where(eq(researchCategory.status, "approved"))
    .limit(1);

  if (!category) {
    console.error("No approved category — run `pnpm db:seed-research-categories` first.");
    return null;
  }

  const projectSlug = `smoke-gemini-${runSuffix}`;
  const userId = `smoke-gemini-founder-${runSuffix}`;

  await db.insert(user).values({
    id: userId,
    name: "Smoke Founder",
    email: `${userId}@example.test`,
    emailVerified: true,
  });

  const [project] = await db
    .insert(researchProject)
    .values({
      slug: projectSlug,
      founderUserId: userId,
      name: "Cold Chain Telemetry (gemini smoke)",
      tagline: "One real daily log, one real analysis, one real verdict",
      categoryId: category.id,
      status: "active",
      publishedAt: new Date(),
    })
    .returning({ id: researchProject.id });

  if (!project) throw new Error("fixture project insert returned no row");

  const [member] = await db
    .insert(projectMember)
    .values({ projectId: project.id, userId, projectRole: "founder" })
    .returning({ id: projectMember.id });

  if (!member) throw new Error("fixture member insert returned no row");

  await db.insert(projectStats).values({ projectId: project.id });

  return { projectId: project.id, projectSlug, userId, memberId: member.id };
}

/**
 * Removes the pg-boss rows this run enqueued.
 *
 * NOT TIDINESS. `submitDailyLog` enlists a real `analyze-daily-log` enqueue in its
 * transaction, and this script then runs the handler inline — so the queued row is a
 * duplicate delivery waiting for a worker that will find the analysis already
 * `succeeded`. Harmless, but a smoke run that leaves queue rows behind is how the eleven
 * orphaned jobs currently sitting in `pgboss.job` got there (scripts/smoke-workshop-
 * pipeline.ts deletes its logs and leaves their jobs). Cleaning up after ourselves is
 * cheaper than explaining the backlog later.
 */
async function deleteEnqueuedAnalysisJobs(dailyLogIds: readonly string[]): Promise<void> {
  for (const dailyLogId of dailyLogIds) {
    await db.execute(
      sql`delete from ${sql.identifier(config.JOBS_SCHEMA)}.job
          where name = 'analyze-daily-log' and data->>'dailyLogId' = ${dailyLogId}`,
    );
  }
}

async function main(): Promise<void> {
  if (config.GEMINI_API_KEY === undefined) {
    console.error(
      "GEMINI_API_KEY is not set. This script proves the REAL analysis path; without a key " +
        "it could only prove `skipped_unconfigured`, which is the opposite of the claim.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(`\nModel ${config.GEMINI_MODEL} · prompt ${DAILY_LOG_ANALYSIS_PROMPT_VERSION}\n`);

  const fixtures = await createFixtures(randomUUID().slice(0, 8));
  if (!fixtures) {
    process.exitCode = 1;
    return;
  }

  console.log(`Project ${fixtures.projectSlug}\n`);

  const videoLogDate = isoDaysAgo(2);
  const textLogDate = isoDaysAgo(1);

  // --- §8.1 Two logs: one with a video, one text-only.

  const videoLog = await logsService.createDailyLog(fixtures.projectId, fixtures.memberId, {
    logDate: videoLogDate,
    narrative: "Walked the enclosure prototype on camera before the bench test.",
    youtubeUrl: FIXTURE_VIDEO_URL,
  });
  check(
    "a pasted YouTube URL is parsed and oEmbed-verified into a stored id",
    videoLog.success && videoLog.value.videoSource === "youtube",
    videoLog.success ? videoLog.value.videoSource : videoLog.error.type,
  );
  if (!videoLog.success) return;

  const textLog = await logsService.createDailyLog(fixtures.projectId, fixtures.memberId, {
    logDate: textLogDate,
    narrative: TEXT_LOG_NARRATIVE,
  });
  check(
    "a text-only log is a first-class log",
    textLog.success && textLog.value.videoSource === "none",
    textLog.success ? textLog.value.videoSource : textLog.error.type,
  );
  if (!textLog.success) return;

  // --- §8.2 Submit. With a key configured this QUEUES; it never decides anything.

  for (const [label, logId] of [
    ["video", videoLog.value.id],
    ["text-only", textLog.value.id],
  ] as const) {
    const submitted = await logsService.submitDailyLog(
      fixtures.projectId,
      logId,
      fixtures.memberId,
      `smoke-gemini-${logId}`,
    );
    check(
      `submitting the ${label} log returns a receipt, never a verdict`,
      submitted.success &&
        submitted.value.analysisStatus === "queued" &&
        submitted.value.effortVerificationStatus === "not_run",
      submitted.success
        ? `analysis=${submitted.value.analysisStatus} verdict=${submitted.value.effortVerificationStatus}`
        : submitted.error.type,
    );
  }

  // --- §8.3 THE REAL CALL. One request per log, the same handler pg-boss runs.

  console.log("\ncalling the model…\n");
  await handleAnalyzeDailyLog({ dailyLogId: videoLog.value.id });
  await handleAnalyzeDailyLog({ dailyLogId: textLog.value.id });

  const videoRow = await readLog(videoLog.value.id);
  const textRow = await readLog(textLog.value.id);
  const videoCounts = await countAnalysisRows(videoLog.value.id);
  const textCounts = await countAnalysisRows(textLog.value.id);

  for (const [label, row] of [
    ["video", videoRow],
    ["text-only", textRow],
  ] as const) {
    check(
      `the ${label} log's analysis succeeded against the live provider`,
      row.analysisStatus === "succeeded",
      row.analysisStatus === "succeeded"
        ? "succeeded"
        : `${row.analysisStatus}: ${row.analysisFailureReason ?? "no reason recorded"}`,
    );
    // §9.1's left column is only reviewable if you can tell WHICH model and WHICH
    // instruction produced the row a human is about to override.
    check(
      `the ${label} log records the model and prompt that produced it`,
      row.analysisModelName === config.GEMINI_MODEL &&
        row.analysisModelVersion !== null &&
        row.analysisPromptVersion === DAILY_LOG_ANALYSIS_PROMPT_VERSION,
      `${row.analysisModelName ?? "?"} / ${row.analysisModelVersion ?? "?"} / ${row.analysisPromptVersion ?? "?"}`,
    );
    // The whole point of §8's status split. A transcript is not a verdict, and the
    // analysis job must not have touched §9's column on its way past.
    check(
      `the ${label} log's verdict column is untouched by analysis`,
      row.effortVerificationStatus === "not_run",
      row.effortVerificationStatus,
    );
  }

  check(
    "the video log produces a real timed transcript",
    videoCounts.segments > 0,
    `${videoCounts.segments} segments`,
  );
  // Asserted rather than assumed: the prompt forbids transcribing a written narrative into
  // segments, and a model that ignores that would invent a spoken record of a text log.
  check(
    "the text-only log produces NO transcript segments",
    textCounts.segments === 0,
    `${textCounts.segments} segments`,
  );
  check(
    "the text-only log produces summary chips and extracted claims",
    textCounts.chips > 0 && textCounts.claims > 0,
    `${textCounts.chips} chips, ${textCounts.claims} claims`,
  );

  const [firstSegment] = await db
    .select()
    .from(dailyLogTranscriptSegment)
    .where(eq(dailyLogTranscriptSegment.dailyLogId, videoLog.value.id))
    .limit(1);
  check(
    "transcript offsets are integer seconds, never floats (§4c)",
    firstSegment !== undefined && Number.isInteger(firstSegment.startOffsetSeconds),
    firstSegment === undefined
      ? "no segment"
      : `${firstSegment.startOffsetSeconds}s: ${firstSegment.segmentText.slice(0, 48)}…`,
  );

  const extractedClaims = await db
    .select()
    .from(dailyLogExtractedClaim)
    .where(eq(dailyLogExtractedClaim.dailyLogId, textLog.value.id));
  const modelMinutes = extractedClaims.reduce(
    (total, claim) => total + (claim.extractedMinutes ?? 0),
    0,
  );
  check(
    "the claims carry the real model's provenance, not a fixture's",
    extractedClaims.every(
      (claim) =>
        claim.generatedByModel !== null &&
        claim.generatedByModel !== "smoke" &&
        claim.promptVersion === DAILY_LOG_ANALYSIS_PROMPT_VERSION,
    ),
    extractedClaims.map((claim) => claim.generatedByModel).join(", ") || "none",
  );
  check(
    "the model read a duration out of the member's own prose",
    modelMinutes > 0,
    `${modelMinutes} minutes across ${extractedClaims.length} claims`,
  );

  const evidenceLinks = await db
    .select()
    .from(dailyLogEvidenceLink)
    .where(eq(dailyLogEvidenceLink.dailyLogId, textLog.value.id));
  check(
    "every extracted URL survived the host allowlist (§0 applied to a model)",
    evidenceLinks.length > 0 &&
      evidenceLinks.every((link) => parseExternalLink(link.externalUrl).success),
    evidenceLinks.map((link) => link.externalHost).join(", ") || "none",
  );

  // --- §8.4 Re-running the job spends nothing and changes nothing.

  const completedBefore = textRow.analysisCompletedAt?.toISOString() ?? "";
  await handleAnalyzeDailyLog({ dailyLogId: textLog.value.id });
  const textRowAfter = await readLog(textLog.value.id);
  const textCountsAfter = await countAnalysisRows(textLog.value.id);
  check(
    "re-running the analysis job is a no-op, not a second free-tier request",
    (textRowAfter.analysisCompletedAt?.toISOString() ?? "") === completedBefore &&
      textCountsAfter.claims === textCounts.claims &&
      textCountsAfter.chips === textCounts.chips,
    `${textCountsAfter.claims} claims, ${textCountsAfter.chips} chips, completedAt unchanged`,
  );

  // --- §9.1 The rate gate: propose → accept → lock.

  const projectContext = { projectId: fixtures.projectId, currency: "USD" };
  const proposed = await proposeFairMarketRate(
    projectContext,
    fixtures.userId,
    fixtures.userId,
    "founder",
    {
      fairMarketRateCentsPerHour: 12_000n,
      paidCashRateCentsPerHour: 0n,
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      rationaleNote: "Senior hardware engineer, market rate.",
    },
  );
  if (!proposed.success) {
    check("a rate can be proposed", false, proposed.error.type);
    return;
  }
  await acceptFairMarketRate(projectContext, proposed.value.id, fixtures.userId, "founder");
  const locked = await lockFairMarketRate(
    projectContext,
    proposed.value.id,
    RATE_LOCK_ACKNOWLEDGEMENT,
    fixtures.userId,
    "founder",
  );
  check(
    "the member-accepted rate locks",
    locked.success,
    locked.success ? locked.value.status : locked.error.type,
  );

  // --- §9.2 A claim over the analyzed log. The numbers come from the model.

  const claim = await submitEffortClaim(
    { projectId: fixtures.projectId, memberId: fixtures.memberId },
    fixtures.userId,
    "founder",
    {
      sourceKind: "daily_log",
      dailyLogId: textLog.value.id,
      physicalReceiptIds: [],
      claimedForDate: textLogDate,
      idempotencyKey: `smoke-gemini-claim-${fixtures.projectSlug}`,
    },
  );
  check(
    "the claim is accepted and returns a receipt, not a verdict",
    claim.success && claim.value.verificationStatus === "queued",
    claim.success ? claim.value.verificationStatus : claim.error.type,
  );
  if (!claim.success) return;

  const [claimRow] = await db
    .select()
    .from(effortClaim)
    .where(eq(effortClaim.id, claim.value.claimId));
  // THE ASSERTION THIS WHOLE SCRIPT EXISTS FOR: the minutes the pipeline is about to price
  // are the minutes the model read out of the member's sentence — not a fixture, not a
  // request body, not a founder's opinion.
  check(
    "the claim's minutes ARE the model's extracted minutes",
    claimRow?.extractedMinutes === Math.min(modelMinutes, 1_440),
    `claim=${claimRow?.extractedMinutes ?? "?"} model=${modelMinutes}`,
  );

  // --- §9.3 The pipeline, then the documented degraded path.

  await runPipelineInline(claim.value.runId);

  const [afterPipeline] = await db
    .select({ status: effortClaim.verificationStatus })
    .from(effortClaim)
    .where(eq(effortClaim.id, claim.value.claimId));
  // With no connected integration a link has no independently verifiable timestamp, so
  // grounding resolves `flagged` — real evidence, withheld pending a human. Not a bug:
  // src/services/verification.service.ts states this outcome as the shipped one.
  check(
    "link-only evidence is FLAGGED for review, never auto-verified",
    afterPipeline?.status === "flagged_for_review",
    afterPipeline?.status ?? "?",
  );

  const [groundingStep] = await db
    .select({ id: verificationStep.id })
    .from(verificationStep)
    .where(
      and(
        eq(verificationStep.runId, claim.value.runId),
        eq(verificationStep.stepKind, "artifact_grounding"),
      ),
    );
  if (!groundingStep) throw new Error("grounding step not found");

  const overridden = await overrideVerificationStep(
    { projectId: fixtures.projectId },
    claim.value.claimId,
    groundingStep.id,
    {
      overriddenStatus: "passed",
      overrideReason: "Reviewed the linked pull request manually; the work is corroborated.",
    },
    fixtures.userId,
    "founder",
  );
  check(
    "a maintainer can override the AI judgement",
    overridden.success,
    overridden.success ? "overridden" : overridden.error.type,
  );
  await finalizeClaimVerdict(claim.value.runId);

  const [settled] = await db
    .select({
      status: effortClaim.verificationStatus,
      groundedMinutes: effortClaim.groundedMinutes,
    })
    .from(effortClaim)
    .where(eq(effortClaim.id, claim.value.claimId));
  check(
    "the override re-runs the FORMULA rather than editing its output",
    settled?.status === "verified" && (settled.groundedMinutes ?? 0) > 0,
    `${settled?.status ?? "?"} at ${settled?.groundedMinutes ?? 0} grounded minutes`,
  );

  const settledLog = await readLog(textLog.value.id);
  check(
    "the verdict reaches the daily log, written by §9 and by nothing else",
    settledLog.effortVerificationStatus === "verified",
    settledLog.effortVerificationStatus,
  );

  await deleteEnqueuedAnalysisJobs([videoLog.value.id, textLog.value.id]);
}

main()
  .then(async () => {
    console.log(
      failureCount === 0
        ? "\nAll assertions passed. The transcript, the chips, the claims and the verdict are the model's.\n"
        : `\n${failureCount} assertion(s) FAILED.\n`,
    );
    if (failureCount > 0) process.exitCode = 1;
    // The submit path starts the API's send-only pg-boss instance, and that instance
    // polls. Without this the script prints every assertion and then hangs forever.
    await stopSendOnlyBoss();
    await pool.end();
    return undefined;
  })
  .catch(async (error: unknown) => {
    console.error("\nDaily-log analysis smoke test failed to run:", error);
    await stopSendOnlyBoss().catch(() => undefined);
    await pool.end();
    process.exit(1);
  });
