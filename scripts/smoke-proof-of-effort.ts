/**
 * Drives one effort claim from submission to a settled cap table, against a REAL database
 * (R_AND_D_BACKEND_STRUCTURE.md §9, §17 steps 2, 3 and 6).
 *
 * WHAT THIS PROVES THAT NOTHING ELSE DOES. The unit tests prove the formula; the
 * constraint script proves the triggers; neither proves that a claim submitted through the
 * service layer ends up as the right number in the ledger, that the window actually
 * withholds it for 24 hours, or that re-running the sweep is genuinely a no-op. §17 step 6
 * asks for exactly this sequence:
 *
 *   verify a claim → confirm NOTHING is in the ledger
 *   expire the window → confirm exactly ONE settlement appears
 *   re-run the sweep → confirm it is a no-op
 *   dispute another → confirm slices show as escrowed and OUTSIDE totalSlices
 *
 * THIS SCRIPT LEAVES ITS ROWS BEHIND, AND THAT IS THE GUARANTEE RATHER THAN A LIMITATION.
 * `slice_ledger_entry` and `project_audit_entry` reject DELETE and TRUNCATE outright, so a
 * script that could clean up after itself would be a script proving the triggers do not
 * work. Every run uses a fresh, uniquely-slugged project. Run it against a DEVELOPMENT
 * database.
 *
 *   pnpm db:smoke-proof-of-effort
 *
 * Exits non-zero on the first failed assertion.
 */
import "dotenv/config";
import { and, eq } from "drizzle-orm";

import { db, pool } from "#src/db/index.js";
import {
  dailyLog,
  dailyLogEvidenceLink,
  dailyLogExtractedClaim,
  effortClaim,
  projectMember,
  researchCategory,
  researchProject,
  sliceAllocationProposal,
  user,
  verificationStep,
} from "#src/db/schema.js";
import { stopSendOnlyBoss } from "#src/lib/jobs.js";
import { castDisputeVote, raiseDispute } from "#src/services/dispute.service.js";
import {
  finalizeClaimVerdict,
  overrideVerificationStep,
  submitEffortClaim,
  type ClaimReceipt,
} from "#src/services/effort-claims.service.js";
import {
  findLatestSnapshot,
  recomputeEquitySnapshot,
} from "#src/services/equity-snapshot.service.js";
import {
  acceptFairMarketRate,
  lockFairMarketRate,
  proposeFairMarketRate,
  RATE_LOCK_ACKNOWLEDGEMENT,
} from "#src/services/fair-market-rate.service.js";
import { verifyAuditChain } from "#src/services/project-audit.service.js";
import {
  listAllocationProposals,
  sweepExpiredWindows,
  type SettlementOutcome,
} from "#src/services/slice-allocation.service.js";
import { listLedgerEntries } from "#src/services/slice-ledger.service.js";
import {
  runAnalyzeSubstance,
  runAnalyzeTemporal,
  runGroundArtifacts,
} from "#src/services/verification.service.js";

let failureCount = 0;

function check(label: string, passed: boolean, detail: string): void {
  console.log(`${passed ? "PASS" : "FAIL"}  ${label} — ${detail}`);
  if (!passed) failureCount += 1;
}

/**
 * The sweep takes the OLDEST window first, and every smoke script in this repo leaves its
 * rows behind on purpose, so foreign leftovers always sort ahead of this run's own two
 * windows. A batch of 50 could be filled entirely by them; 500 cannot, in any database a
 * smoke test runs against.
 */
const SMOKE_SWEEP_BATCH_SIZE = 500;

/**
 * The expiry sweep, with its result narrowed to THIS RUN'S project.
 *
 * `sweepExpiredWindows` is the production job and is deliberately project-agnostic (§9.8) —
 * it must lock every unchallenged window everywhere, and it still does here. But asserting
 * on its GLOBAL count couples this gate to whatever another script left in the database:
 * one expired-unlocked window from a `smoke-gemini-*` project is enough to turn "the sweep
 * NEVER pre-locks an open window" into a failure that says nothing about this run.
 *
 * So the sweep is unscoped and the ASSERTION is scoped. The foreign windows are still swept,
 * because that is what the job does; they are simply not this script's evidence.
 */
async function sweepThisProject(
  asOf: Date,
  projectId: string,
): Promise<readonly SettlementOutcome[]> {
  const outcome = await sweepExpiredWindows(asOf, SMOKE_SWEEP_BATCH_SIZE);
  return outcome.settled.filter((settlement) => settlement.projectId === projectId);
}

/**
 * Runs the four pipeline stages inline.
 *
 * The worker is not running during a smoke test, so the stages are invoked directly rather
 * than through pg-boss. That is the ONLY difference from production: each stage is the
 * same function the job handler calls, in the same order, with the same idempotency.
 */
async function runPipelineInline(runId: string): Promise<void> {
  await runGroundArtifacts(runId);
  await runAnalyzeSubstance(runId);
  await runAnalyzeTemporal(runId);
  await finalizeClaimVerdict(runId);
}

interface Fixtures {
  readonly projectId: string;
  readonly projectSlug: string;
  readonly userId: string;
  readonly memberId: string;
  readonly secondUserId: string;
  readonly secondMemberId: string;
}

async function createFixtures(): Promise<Fixtures | null> {
  const [category] = await db
    .select({ id: researchCategory.id })
    .from(researchCategory)
    .where(eq(researchCategory.status, "approved"))
    .limit(1);

  if (!category) {
    console.error("No approved category — run `pnpm db:seed-research-categories` first.");
    return null;
  }

  // A unique suffix per run: the rows below cannot be deleted afterwards, so two runs must
  // not collide on the project slug's unique index.
  const runSuffix = Date.now().toString(36);
  const projectSlug = `smoke-poe-${runSuffix}`;
  const userId = `smoke-poe-founder-${runSuffix}`;
  const secondUserId = `smoke-poe-member-${runSuffix}`;

  await db.insert(user).values([
    { id: userId, name: "Smoke Founder", email: `${userId}@example.test`, emailVerified: true },
    {
      id: secondUserId,
      name: "Smoke Contributor",
      email: `${secondUserId}@example.test`,
      emailVerified: true,
    },
  ]);

  const [project] = await db
    .insert(researchProject)
    .values({
      slug: projectSlug,
      founderUserId: userId,
      name: "Solar Cold Storage (smoke)",
      tagline: "Proof-of-Effort pipeline smoke test",
      categoryId: category.id,
      status: "active",
      // `research_project_published_at_ck`: an active project has been published, and the
      // nightly snapshot job only visits active projects.
      publishedAt: new Date(),
    })
    .returning({ id: researchProject.id });

  if (!project) throw new Error("fixture project insert returned no row");

  const members = await db
    .insert(projectMember)
    .values([
      { projectId: project.id, userId, projectRole: "founder" },
      { projectId: project.id, userId: secondUserId, projectRole: "contributor" },
    ])
    .returning({ id: projectMember.id, userId: projectMember.userId });

  const founderMember = members.find((member) => member.userId === userId);
  const secondMember = members.find((member) => member.userId === secondUserId);
  if (!founderMember || !secondMember) throw new Error("fixture members were not created");

  return {
    projectId: project.id,
    projectSlug,
    userId,
    memberId: founderMember.id,
    secondUserId,
    secondMemberId: secondMember.id,
  };
}

/**
 * Runs the pipeline, then walks the flagged→override→verified path.
 *
 * THIS IS THE SHIPPED FLOW FOR A LINK-BACKED CLAIM, and it is worth being explicit about
 * why. Without a connected integration (9D), an evidence LINK has no independently
 * verifiable timestamp — the member could have pasted it at any time. Grounding therefore
 * resolves `flagged`, not `passed`, and the verdict is `flagged_for_review` at ZERO
 * slices: real evidence, withheld pending a human.
 *
 * The human is the override endpoint. A maintainer reviews the finding, overrides the
 * step, and the FORMULA recomputes the number — §9.1's correction model exactly: change an
 * input, never edit an output.
 */
async function verifyThroughReview(
  fixtures: Fixtures,
  claim: ClaimReceipt,
  label: string,
): Promise<void> {
  await runPipelineInline(claim.runId);

  const [beforeOverride] = await db
    .select({ status: effortClaim.verificationStatus })
    .from(effortClaim)
    .where(eq(effortClaim.id, claim.claimId));

  check(
    `${label}: link-only evidence is FLAGGED for review, never auto-verified`,
    beforeOverride?.status === "flagged_for_review",
    beforeOverride?.status ?? "?",
  );

  const [groundingStep] = await db
    .select({ id: verificationStep.id })
    .from(verificationStep)
    .where(
      and(
        eq(verificationStep.runId, claim.runId),
        eq(verificationStep.stepKind, "artifact_grounding"),
      ),
    );

  if (!groundingStep) throw new Error(`${label}: grounding step not found`);

  const overridden = await overrideVerificationStep(
    { projectId: fixtures.projectId },
    claim.claimId,
    groundingStep.id,
    {
      overriddenStatus: "passed",
      overrideReason: "Reviewed the linked commits manually; the work is corroborated.",
    },
    fixtures.userId,
    "founder",
  );
  check(
    `${label}: a maintainer can override the AI judgement`,
    overridden.success,
    overridden.success
      ? `overriddenStatus ${overridden.value.overriddenStatus ?? "?"}`
      : overridden.error.type,
  );

  // The override re-enqueues finalization; the worker is not running, so it is invoked
  // here exactly as the job handler would.
  await finalizeClaimVerdict(claim.runId);
}

/** A submitted log with §8's extraction and evidence already written, as the job would. */
async function createSubmittedLog(
  fixtures: Fixtures,
  memberId: string,
  logDate: string,
  claimedMinutes: number,
): Promise<string> {
  const [log] = await db
    .insert(dailyLog)
    .values({
      projectId: fixtures.projectId,
      authorMemberId: memberId,
      logDate,
      narrative: "Refactored the compressor controller and closed the migration ticket.",
      status: "submitted",
      submittedAt: new Date(),
      analysisStatus: "succeeded",
      analysisModelName: "smoke",
      analysisPromptVersion: "smoke-v1",
      analysisCompletedAt: new Date(),
    })
    .returning({ id: dailyLog.id });

  if (!log) throw new Error("fixture daily log insert returned no row");

  await db.insert(dailyLogExtractedClaim).values({
    dailyLogId: log.id,
    sequenceNumber: 1,
    claimKind: "time_spent",
    extractedMinutes: claimedMinutes,
    claimSummary: `Claimed ${claimedMinutes} minutes.`,
    generatedByModel: "smoke",
    promptVersion: "smoke-v1",
  });

  // The evidence §8's analysis extracts from the transcript. Without at least one of
  // these, grounding FAILS outright and the claim earns zero — which is correct (SPEC §4
  // step 2) and is asserted separately below.
  await db.insert(dailyLogEvidenceLink).values({
    dailyLogId: log.id,
    provider: "github",
    sourceKind: "ai_extracted",
    externalUrl: `https://github.com/qatoto/solar-cold-storage/commit/${logDate.replaceAll("-", "")}${memberId.slice(0, 6)}`,
    externalHost: "github.com",
    externalId: `${logDate.replaceAll("-", "")}${memberId.slice(0, 6)}`,
    generatedByModel: "smoke",
    promptVersion: "smoke-v1",
  });

  return log.id;
}

/**
 * A submitted log with an extracted claim and NO evidence whatsoever.
 *
 * SPEC §4 step 2's case: "No digital receipts → flag Unverified, zero equity slices." The
 * member said they worked; nothing corroborates it; the pipeline awards nothing and says
 * so, rather than trusting the transcript.
 */
async function createBarrenLog(
  fixtures: Fixtures,
  memberId: string,
  logDate: string,
): Promise<string> {
  const [log] = await db
    .insert(dailyLog)
    .values({
      projectId: fixtures.projectId,
      authorMemberId: memberId,
      logDate,
      narrative: "Spent the day thinking about the compressor problem.",
      status: "submitted",
      submittedAt: new Date(),
      analysisStatus: "succeeded",
      analysisModelName: "smoke",
      analysisPromptVersion: "smoke-v1",
      analysisCompletedAt: new Date(),
    })
    .returning({ id: dailyLog.id });

  if (!log) throw new Error("fixture barren log insert returned no row");

  await db.insert(dailyLogExtractedClaim).values({
    dailyLogId: log.id,
    sequenceNumber: 1,
    claimKind: "time_spent",
    extractedMinutes: 300,
    claimSummary: "Claimed 300 minutes with nothing to point at.",
    generatedByModel: "smoke",
    promptVersion: "smoke-v1",
  });

  return log.id;
}

/**
 * Refuses to run while a WORKER is connected to the same database.
 *
 * WHY THIS GUARD EXISTS, learned the expensive way. This script drives the four pipeline
 * stages inline because the worker is supposed to be off (see `runPipelineInline`). With one
 * running, both race: the worker dequeues `ground-artifacts` for the same claims and its
 * `finalize-verdict` holds `SELECT … FOR UPDATE` on the allocation proposal — so the
 * script's sweep, which uses `SKIP LOCKED`, silently settles one window instead of two.
 *
 * The result is five assertions failing with numbers that look like a formula bug
 * ("1 entries; the verified one is ? slices") and nothing anywhere saying "a worker is
 * running". Diagnosing it from the output alone takes an hour; `pg_stat_activity` answers
 * it in a second.
 */
async function assertNoWorkerIsRunning(): Promise<boolean> {
  const result = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND query LIKE '%pgboss.job%'
        AND query LIKE '%FROM pgboss.job_common j%'`,
  );

  if (Number(result.rows[0]?.n ?? 0) > 0) {
    console.error(
      "\nREFUSING TO RUN: a pg-boss worker is connected to this database.\n\n" +
        "  This script invokes the §9 pipeline stages INLINE. A running worker dequeues the\n" +
        "  same jobs and holds row locks the sweep then skips, which fails five assertions\n" +
        "  with numbers that look like a formula bug.\n\n" +
        "  Stop `pnpm dev:worker` and run this again.\n",
    );
    process.exitCode = 1;
    return false;
  }
  return true;
}

async function main(): Promise<void> {
  const fixtures = await createFixtures();
  if (!fixtures) {
    process.exitCode = 1;
    return;
  }

  console.log(`\nProject ${fixtures.projectSlug}\n`);

  const projectContext = { projectId: fixtures.projectId, currency: "USD" };

  // --- 1. THE GATE: no claim exists until a rate is LOCKED.
  const beforeRate = await submitEffortClaim(
    { projectId: fixtures.projectId, memberId: fixtures.memberId },
    fixtures.userId,
    "founder",
    {
      sourceKind: "daily_log",
      dailyLogId: "00000000-0000-4000-8000-000000000000",
      physicalReceiptIds: [],
      claimedForDate: "2026-07-01",
      idempotencyKey: "smoke-before-rate",
    },
  );
  check(
    "a claim is refused before any rate is locked",
    !beforeRate.success && beforeRate.error.type === "RATE_NOT_LOCKED",
    beforeRate.success ? "the claim was ACCEPTED" : beforeRate.error.type,
  );

  // --- 2. Rate lifecycle: propose → accept → lock. $120/h market, $0 paid.
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
  check(
    "a rate can be proposed",
    proposed.success,
    proposed.success ? proposed.value.id : proposed.error.type,
  );
  if (!proposed.success) return;

  const lockedTooEarly = await lockFairMarketRate(
    projectContext,
    proposed.value.id,
    RATE_LOCK_ACKNOWLEDGEMENT,
    fixtures.userId,
    "founder",
  );
  check(
    "a rate cannot be locked before its subject accepts it",
    !lockedTooEarly.success && lockedTooEarly.error.type === "RATE_NOT_ACCEPTED",
    lockedTooEarly.success ? "it LOCKED" : lockedTooEarly.error.type,
  );

  const accepted = await acceptFairMarketRate(
    projectContext,
    proposed.value.id,
    fixtures.userId,
    "founder",
  );
  check(
    "the subject can accept their own rate",
    accepted.success,
    accepted.success ? accepted.value.status : accepted.error.type,
  );

  const wrongPhrase = await lockFairMarketRate(
    projectContext,
    proposed.value.id,
    "lock it",
    fixtures.userId,
    "founder",
  );
  check(
    "the lock refuses a mistyped acknowledgement",
    !wrongPhrase.success && wrongPhrase.error.type === "ACKNOWLEDGEMENT_MISMATCH",
    wrongPhrase.success ? "it LOCKED" : wrongPhrase.error.type,
  );

  const locked = await lockFairMarketRate(
    projectContext,
    proposed.value.id,
    RATE_LOCK_ACKNOWLEDGEMENT,
    fixtures.userId,
    "founder",
  );
  check("the rate locks", locked.success, locked.success ? locked.value.status : locked.error.type);

  // --- 3. A claim over a daily log. 480 minutes at $120/h unpaid.
  const logId = await createSubmittedLog(fixtures, fixtures.memberId, "2026-07-01", 480);
  const claim = await submitEffortClaim(
    { projectId: fixtures.projectId, memberId: fixtures.memberId },
    fixtures.userId,
    "founder",
    {
      sourceKind: "daily_log",
      dailyLogId: logId,
      physicalReceiptIds: [],
      claimedForDate: "2026-07-01",
      idempotencyKey: `smoke-claim-1-${fixtures.projectSlug}`,
    },
  );
  check(
    "the claim is accepted and returns a receipt, not a verdict",
    claim.success && claim.value.verificationStatus === "queued",
    claim.success ? claim.value.verificationStatus : claim.error.type,
  );
  if (!claim.success) return;

  const replay = await submitEffortClaim(
    { projectId: fixtures.projectId, memberId: fixtures.memberId },
    fixtures.userId,
    "founder",
    {
      sourceKind: "daily_log",
      dailyLogId: logId,
      physicalReceiptIds: [],
      claimedForDate: "2026-07-01",
      idempotencyKey: `smoke-claim-1-${fixtures.projectSlug}`,
    },
  );
  check(
    "a replayed idempotency key returns the ORIGINAL receipt",
    replay.success && replay.value.claimId === claim.value.claimId,
    replay.success ? replay.value.claimId : replay.error.type,
  );

  // A claim with NO evidence at all fails grounding outright — SPEC §4 step 2.
  const barrenLogId = await createBarrenLog(fixtures, fixtures.memberId, "2026-06-30");
  const barrenClaim = await submitEffortClaim(
    { projectId: fixtures.projectId, memberId: fixtures.memberId },
    fixtures.userId,
    "founder",
    {
      sourceKind: "daily_log",
      dailyLogId: barrenLogId,
      physicalReceiptIds: [],
      claimedForDate: "2026-06-30",
      idempotencyKey: `smoke-barren-${fixtures.projectSlug}`,
    },
  );
  if (barrenClaim.success) {
    await runPipelineInline(barrenClaim.value.runId);
    const [barrenRow] = await db
      .select({ status: effortClaim.verificationStatus, grounded: effortClaim.groundedMinutes })
      .from(effortClaim)
      .where(eq(effortClaim.id, barrenClaim.value.claimId));
    check(
      "a claim with NO digital receipts is unverified and earns zero",
      barrenRow?.status === "unverified" && barrenRow.grounded === 0,
      `${barrenRow?.status ?? "?"}, grounded ${barrenRow?.grounded ?? "?"}`,
    );
  } else {
    check("the evidence-free claim submits", false, barrenClaim.error.type);
  }

  await verifyThroughReview(fixtures, claim.value, "claim 1");

  // --- 4. §17 step 6: a verdict is reached and NOTHING is in the ledger.
  const proposalsAfterVerdict = (await listAllocationProposals(fixtures.projectId)).rows;
  const ledgerAfterVerdict = (await listLedgerEntries(fixtures.projectId)).rows;
  check(
    "EVERY verdict opens a window, including the unverified one",
    proposalsAfterVerdict.length === 2 &&
      proposalsAfterVerdict.every((proposal) => proposal.status === "open"),
    `${proposalsAfterVerdict.length} proposal(s): ${proposalsAfterVerdict.map((proposal) => `${proposal.verdict}@${proposal.proposedSlices}`).join(", ")}`,
  );
  check(
    "NOTHING is written to the ledger before the window closes",
    ledgerAfterVerdict.length === 0,
    `${ledgerAfterVerdict.length} entries`,
  );

  const [claimRow] = await db
    .select({ status: effortClaim.verificationStatus, grounded: effortClaim.groundedMinutes })
    .from(effortClaim)
    .where(eq(effortClaim.id, claim.value.claimId));
  check(
    "the reviewed claim is verified, priced on GROUNDED minutes",
    claimRow?.status === "verified" && claimRow.grounded === 480,
    `status ${claimRow?.status ?? "?"}, grounded ${claimRow?.grounded ?? "?"} minutes`,
  );

  const [logRow] = await db
    .select({ status: dailyLog.effortVerificationStatus })
    .from(dailyLog)
    .where(eq(dailyLog.id, logId));
  check(
    "daily_log.effortVerificationStatus finally moved off `not_run`",
    logRow?.status !== "not_run",
    logRow?.status ?? "?",
  );

  // --- 5. The sweep does not pre-lock, then locks exactly once.
  const earlySweep = await sweepThisProject(new Date(), fixtures.projectId);
  check(
    "the sweep NEVER pre-locks an open window",
    earlySweep.length === 0,
    `${earlySweep.length} settled in this project`,
  );

  const afterWindow = new Date(Date.now() + 25 * 3_600_000);
  const firstSweep = await sweepThisProject(afterWindow, fixtures.projectId);
  check(
    "every expired window locks, including the zero-slice one",
    firstSweep.length === 2,
    `${firstSweep.length} settled in this project`,
  );

  const secondSweep = await sweepThisProject(afterWindow, fixtures.projectId);
  check(
    "re-running the sweep is a NO-OP",
    secondSweep.length === 0,
    `${secondSweep.length} settled in this project`,
  );

  // --- 6. The number. 480 min × 12000 cents / 3000 = 1,920 slices.
  const ledger = (await listLedgerEntries(fixtures.projectId)).rows;
  const verifiedEntry = ledger.find((entry) => entry.claimId === claim.value.claimId);
  check(
    "the verified claim posts at the formula's number",
    verifiedEntry?.slicesAwarded === 1_920,
    `${ledger.length} entries; the verified one is ${verifiedEntry?.slicesAwarded ?? "?"} slices (expected 1920)`,
  );
  check(
    "the exact rational is retained beside the rounded count",
    verifiedEntry?.sliceNumerator === "5760000",
    `numerator ${verifiedEntry?.sliceNumerator ?? "?"} (expected 5760000)`,
  );
  check(
    "the unverified claim posts a ZERO entry rather than vanishing (anti-dust)",
    ledger.filter((entry) => entry.slicesAwarded === 0).length === 1,
    `${ledger.filter((entry) => entry.slicesAwarded === 0).length} zero-slice entry/entries`,
  );

  // --- 7. A second member's claim, disputed. Slices freeze OUTSIDE totalSlices.
  const secondRate = await proposeFairMarketRate(
    projectContext,
    fixtures.secondUserId,
    fixtures.userId,
    "founder",
    {
      fairMarketRateCentsPerHour: 6_000n,
      paidCashRateCentsPerHour: 0n,
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      rationaleNote: "Fabricator, market rate.",
    },
  );
  if (!secondRate.success) {
    check("the second member's rate proposes", false, secondRate.error.type);
    return;
  }
  await acceptFairMarketRate(
    projectContext,
    secondRate.value.id,
    fixtures.secondUserId,
    "contributor",
  );
  await lockFairMarketRate(
    projectContext,
    secondRate.value.id,
    RATE_LOCK_ACKNOWLEDGEMENT,
    fixtures.userId,
    "founder",
  );

  const secondLogId = await createSubmittedLog(
    fixtures,
    fixtures.secondMemberId,
    "2026-07-02",
    480,
  );
  const secondClaim = await submitEffortClaim(
    { projectId: fixtures.projectId, memberId: fixtures.secondMemberId },
    fixtures.secondUserId,
    "contributor",
    {
      sourceKind: "daily_log",
      dailyLogId: secondLogId,
      physicalReceiptIds: [],
      claimedForDate: "2026-07-02",
      idempotencyKey: `smoke-claim-2-${fixtures.projectSlug}`,
    },
  );
  if (!secondClaim.success) {
    check("the second claim submits", false, secondClaim.error.type);
    return;
  }
  await verifyThroughReview(fixtures, secondClaim.value, "claim 2");

  const [secondProposal] = await db
    .select({ id: sliceAllocationProposal.id, proposed: sliceAllocationProposal.proposedSlices })
    .from(sliceAllocationProposal)
    .where(eq(sliceAllocationProposal.claimId, secondClaim.value.claimId));

  if (!secondProposal) {
    check("the second claim opened a window", false, "no proposal");
    return;
  }

  const disputed = await raiseDispute(
    { projectId: fixtures.projectId },
    secondProposal.id,
    fixtures.memberId,
    "The team was on site that day; this needs a second look.",
    fixtures.userId,
    "founder",
  );
  check(
    "any active member can dispute",
    disputed.success,
    disputed.success ? disputed.value.status : disputed.error.type,
  );
  if (!disputed.success) return;

  const secondDispute = await raiseDispute(
    { projectId: fixtures.projectId },
    secondProposal.id,
    fixtures.memberId,
    "Again.",
    fixtures.userId,
    "founder",
  );
  check(
    "a proposal cannot carry two live disputes",
    !secondDispute.success && secondDispute.error.type === "ALREADY_DISPUTED",
    secondDispute.success ? "a SECOND dispute was accepted" : secondDispute.error.type,
  );

  const disputedProposals = (
    await listAllocationProposals(fixtures.projectId, { status: "disputed" })
  ).rows;
  const ledgerDuringDispute = (await listLedgerEntries(fixtures.projectId)).rows;
  check(
    "disputed slices are reported as escrowed, and stay OUT of the ledger",
    disputedProposals.length === 1 &&
      disputedProposals[0]?.escrowedSlices === secondProposal.proposed &&
      // The two settled earlier; the disputed one has added nothing.
      ledgerDuringDispute.length === 2,
    `${disputedProposals[0]?.escrowedSlices ?? "?"} escrowed and outside the ledger, which still holds ${ledgerDuringDispute.length} entries`,
  );

  const sweepDuringDispute = await sweepThisProject(
    new Date(Date.now() + 48 * 3_600_000),
    fixtures.projectId,
  );
  check(
    "the sweep never settles a DISPUTED window, however late it runs",
    sweepDuringDispute.length === 0,
    `${sweepDuringDispute.length} settled in this project`,
  );

  // A single-vote majority: the roster is two, so a majority is two — one vote is not
  // enough, which is the point of freezing the quorum at raise time.
  const vote = await castDisputeVote(
    { projectId: fixtures.projectId },
    disputed.value.id,
    fixtures.memberId,
    { position: "uphold" },
    fixtures.userId,
    "founder",
  );
  check(
    "one vote of a two-member quorum does not resolve anything",
    vote.success && vote.value.autoResolvedAs === null,
    vote.success ? `autoResolvedAs ${String(vote.value.autoResolvedAs)}` : vote.error.type,
  );

  const secondVote = await castDisputeVote(
    { projectId: fixtures.projectId },
    disputed.value.id,
    fixtures.secondMemberId,
    { position: "uphold" },
    fixtures.secondUserId,
    "contributor",
  );
  check(
    "a majority auto-resolves the dispute and releases the slices",
    secondVote.success && secondVote.value.autoResolvedAs === "upheld",
    secondVote.success ? String(secondVote.value.autoResolvedAs) : secondVote.error.type,
  );

  const ledgerAfterConsensus = (await listLedgerEntries(fixtures.projectId)).rows;
  const releasedEntry = ledgerAfterConsensus.find(
    (entry) => entry.claimId === secondClaim.value.claimId,
  );
  check(
    "the released allocation posts to the ledger at its frozen number",
    releasedEntry?.slicesAwarded === 960,
    `${ledgerAfterConsensus.length} entries; the released one is ${releasedEntry?.slicesAwarded ?? "?"} slices (expected 960)`,
  );

  // --- 8. The cap table. 1920 + 960 = 2880 slices → 6667 / 3333 basis points.
  const asOf = new Date("2026-07-03T00:00:00.000Z");
  await recomputeEquitySnapshot(fixtures.projectId, asOf);
  const snapshot = await findLatestSnapshot(fixtures.projectId);
  const shareTotal = (snapshot?.shares ?? []).reduce(
    (runningSum, share) => runningSum + share.equityBasisPoints,
    0,
  );
  check(
    "the cap table sums to EXACTLY 10000 basis points",
    shareTotal === 10_000,
    `${shareTotal} bps across ${snapshot?.shares.length ?? 0} members, ${snapshot?.totalSlices ?? "?"} slices`,
  );

  // Determinism: the same asOf must return the SAME snapshot, not a divergent second one.
  await recomputeEquitySnapshot(fixtures.projectId, asOf);
  const repeated = await findLatestSnapshot(fixtures.projectId);
  check(
    "recomputing the same asOf is idempotent",
    repeated?.id === snapshot?.id,
    repeated?.id === snapshot?.id ? "same snapshot" : "a SECOND snapshot was written",
  );

  // --- 9. The chain. Every mutation above appended to it.
  const chain = await verifyAuditChain(fixtures.projectId);
  check(
    "the audit chain verifies end to end",
    chain.success,
    chain.success
      ? `${chain.value.entriesChecked} entries, head ${chain.value.headEntryHash?.slice(0, 12) ?? "none"}…`
      : chain.error.type,
  );

  // §17 step 3: tamper with one row IN SQL and confirm the break is caught.
  //
  // The append-only trigger has to be DISABLED to do it, which is the honest shape of the
  // threat: an outsider cannot reach this, and someone who owns the database can. That is
  // precisely the limit §9.9 states — a hash chain is tamper-EVIDENT, not tamper-proof, and
  // only an external anchor closes the rest.
  await pool.query(
    `ALTER TABLE project_audit_entry DISABLE TRIGGER project_audit_entry_append_only`,
  );
  await pool.query(
    `UPDATE project_audit_entry SET detail_note = 'tampered'
      WHERE project_id = $1 AND sequence_number = 2`,
    [fixtures.projectId],
  );
  await pool.query(
    `ALTER TABLE project_audit_entry ENABLE TRIGGER project_audit_entry_append_only`,
  );
  const tampered = await verifyAuditChain(fixtures.projectId);
  check(
    "tampering with a detailNote in SQL breaks the chain at that exact sequence",
    !tampered.success &&
      tampered.error.type === "CHAIN_BROKEN" &&
      tampered.error.sequenceNumber === 2,
    tampered.success
      ? "the chain still VERIFIED"
      : `broken at ${"sequenceNumber" in tampered.error ? tampered.error.sequenceNumber : "?"}`,
  );
}

assertNoWorkerIsRunning()
  .then(async (isClear) => {
    if (!isClear) return false;
    await main();
    return true;
  })
  .then(async (didRun) => {
    // Only report when the suite actually ran. Printing "verified end to end" after the
    // guard refused would be the exact false green this script exists to prevent.
    if (didRun) {
      console.log(
        failureCount === 0
          ? "\nProof-of-Effort pipeline verified end to end."
          : `\n${failureCount} assertion(s) FAILED.`,
      );
      if (failureCount > 0) process.exitCode = 1;
    }
    await stopSendOnlyBoss();
    await pool.end();
    return undefined;
  })
  .catch(async (error: unknown) => {
    console.error("Proof-of-Effort smoke test failed to run:", error);
    await stopSendOnlyBoss().catch(() => undefined);
    await pool.end();
    process.exit(1);
  });
