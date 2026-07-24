/**
 * Drives one pledge from authorization to a released milestone payout, against a REAL
 * database (R_AND_D_BACKEND_STRUCTURE.md §7, §12, §17 steps 1, 3, 4 and 5).
 *
 * WHAT THIS PROVES THAT NOTHING ELSE DOES. The unit tests prove the arithmetic;
 * `db:verify-escrow-constraints` proves the triggers; neither proves that a pledge made
 * through the service layer leaves `raisedAmountInCents` alone until an auditor settles it,
 * that a founder cannot approve their own payout, that editing a milestone after a request
 * changes nothing, or that a tampered ledger row is actually detected. §12's money path,
 * end to end:
 *
 *   POST …/pledges           → 201, raisedAmountInCents has NOT moved
 *   worker submits            → still not moved
 *   auditor settles           → moved, ONCE, and a replay writes nothing
 *   request a release         → the amount is snapshotted from the milestone
 *   edit the milestone        → the release still pays the snapshot
 *   founder self-approves     → SELF_APPROVAL_FORBIDDEN
 *   second person approves    → every gate re-derived and frozen
 *   tamper with a ledger row  → the chain breaks at that exact sequence
 *   re-run reconciliation     → a no-op
 *
 * THIS SCRIPT LEAVES ITS ROWS BEHIND, AND THAT IS THE GUARANTEE RATHER THAN A LIMITATION.
 * `escrow_journal_entry` and `escrow_posting` reject UPDATE, DELETE and TRUNCATE outright,
 * so a script that could clean up after itself would be a script proving the triggers do
 * not work. Every run uses a fresh, uniquely-slugged project. Run it against a DEVELOPMENT
 * database.
 *
 *   pnpm db:smoke-funding-escrow
 *
 * Exits non-zero on the first failed assertion.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { db, pool } from "#src/db/index.js";
import {
  escrowJournalEntry,
  fundingRound,
  milestone,
  projectMember,
  projectStats,
  providerTransfer,
  researchCategory,
  researchProject,
  user,
} from "#src/db/schema.js";
import { handleReconcileEscrowLedger } from "#src/jobs/reconcile-escrow-ledger.js";
import { stopSendOnlyBoss } from "#src/lib/jobs.js";
import { submitTransfer } from "#src/services/escrow-provider-adapter.service.js";
import {
  approveEscrowRelease,
  requestEscrowRelease,
} from "#src/services/escrow-releases.service.js";
import { decideSettlement } from "#src/services/escrow-settlement.service.js";
import {
  deriveAccountBalances,
  getEscrowSummary,
  listEscrowLedger,
  verifyEscrowChain,
} from "#src/services/escrow.service.js";
import { createPledge, getFundingRound } from "#src/services/funding-rounds.service.js";
import { completeMilestone, updateMilestone } from "#src/services/milestones.service.js";

let failureCount = 0;

function check(label: string, passed: boolean, detail: string): void {
  console.log(`${passed ? "PASS" : "FAIL"}  ${label} — ${detail}`);
  if (!passed) failureCount += 1;
}

interface Fixtures {
  readonly projectId: string;
  readonly projectSlug: string;
  readonly founderUserId: string;
  readonly backerUserId: string;
  readonly auditorUserId: string;
  readonly adminUserId: string;
  readonly roundId: string;
  readonly milestoneId: string;
}

const PLEDGE_AMOUNT_IN_CENTS = 500_000n;
/** The default 500 basis points of PLEDGE_AMOUNT_IN_CENTS. */
const EXPECTED_FEE_IN_CENTS = 25_000n;
const EXPECTED_NET_IN_CENTS = PLEDGE_AMOUNT_IN_CENTS - EXPECTED_FEE_IN_CENTS;
const MILESTONE_PAYOUT_IN_CENTS = 250_000n;

async function createFixtures(): Promise<Fixtures> {
  const runId = randomUUID().slice(0, 8);

  const [category] = await db
    .select({ id: researchCategory.id })
    .from(researchCategory)
    .where(eq(researchCategory.status, "approved"))
    .limit(1);

  if (!category) {
    throw new Error("No approved category — run `pnpm db:seed-research-categories` first.");
  }

  const founderUserId = `smoke-escrow-founder-${runId}`;
  const backerUserId = `smoke-escrow-backer-${runId}`;
  const auditorUserId = `smoke-escrow-auditor-${runId}`;
  const adminUserId = `smoke-escrow-admin-${runId}`;

  await db.insert(user).values([
    {
      id: founderUserId,
      name: "Smoke Founder",
      email: `${founderUserId}@example.test`,
      emailVerified: true,
    },
    {
      id: backerUserId,
      name: "Smoke Backer",
      email: `${backerUserId}@example.test`,
      emailVerified: true,
    },
    {
      id: auditorUserId,
      name: "Smoke Auditor",
      email: `${auditorUserId}@example.test`,
      emailVerified: true,
      // The staff role that gates settlement AND is one of the two acceptable approver
      // standings for a release (§7).
      platformRole: "auditor",
    },
    {
      id: adminUserId,
      name: "Smoke Admin",
      email: `${adminUserId}@example.test`,
      emailVerified: true,
    },
  ]);

  const projectSlug = `smoke-escrow-${runId}`;
  const [project] = await db
    .insert(researchProject)
    .values({
      slug: projectSlug,
      founderUserId,
      name: "SolarChill",
      tagline: "Solar cold rooms",
      problemStatement: "Produce spoils in transit",
      categoryId: category.id,
      status: "active",
      publishedAt: new Date(),
    })
    .returning({ id: researchProject.id });

  if (!project) throw new Error("smoke: project insert returned no row");

  await db.insert(projectStats).values({ projectId: project.id });

  await db.insert(projectMember).values([
    { projectId: project.id, userId: founderUserId, projectRole: "founder" },
    // GRANTED BY THE FOUNDER, not by themselves — the CHECK constraint rejects a
    // self-grant, and `resolveApproverStanding` refuses an un-provenanced admin.
    {
      projectId: project.id,
      userId: adminUserId,
      projectRole: "admin",
      roleGrantedByUserId: founderUserId,
    },
  ]);

  const [round] = await db
    .insert(fundingRound)
    .values({
      projectId: project.id,
      type: "crowdfunding",
      status: "open",
      title: "Seed round",
      goalAmountInCents: 1_000_000n,
      currency: "USD",
      opensAt: new Date(),
      closesAt: new Date(Date.now() + 30 * 86_400_000),
      createdByUserId: founderUserId,
    })
    .returning({ id: fundingRound.id });

  if (!round) throw new Error("smoke: round insert returned no row");

  const [milestoneRow] = await db
    .insert(milestone)
    .values({
      projectId: project.id,
      title: "400-vendor demand survey",
      status: "in_progress",
      escrowReleaseAmountInCents: MILESTONE_PAYOUT_IN_CENTS,
      currency: "USD",
      orderIndex: 0,
      createdByUserId: founderUserId,
    })
    .returning({ id: milestone.id });

  if (!milestoneRow) throw new Error("smoke: milestone insert returned no row");

  return {
    projectId: project.id,
    projectSlug,
    founderUserId,
    backerUserId,
    auditorUserId,
    adminUserId,
    roundId: round.id,
    milestoneId: milestoneRow.id,
  };
}

async function readRaisedAmount(roundId: string): Promise<bigint> {
  const found = await getFundingRound(roundId);
  return found.success ? BigInt(found.value.raisedAmountInCents) : -1n;
}

async function main(): Promise<void> {
  const fixtures = await createFixtures();
  console.log(`Fixtures: project ${fixtures.projectSlug}\n`);

  // --- 1. THE PLEDGE. §7: a pledge body carries `{ amountInCents }` and nothing else, and
  // --- `raisedAmountInCents` MUST NOT MOVE.

  const pledged = await createPledge({
    roundId: fixtures.roundId,
    backerUserId: fixtures.backerUserId,
    amountInCents: PLEDGE_AMOUNT_IN_CENTS,
  });

  check("a pledge is accepted", pledged.success, pledged.success ? "201" : JSON.stringify(pledged));
  if (!pledged.success) {
    return;
  }

  check(
    "the fee is derived server-side, never sent",
    pledged.value.platformFeeInCents === EXPECTED_FEE_IN_CENTS.toString() &&
      pledged.value.netToEscrowInCents === EXPECTED_NET_IN_CENTS.toString(),
    `fee ${pledged.value.platformFeeInCents}, net ${pledged.value.netToEscrowInCents}`,
  );

  const raisedAfterPledge = await readRaisedAmount(fixtures.roundId);
  check(
    "raisedAmountInCents has NOT moved on a pledge",
    raisedAfterPledge === 0n,
    `raised ${raisedAfterPledge}`,
  );

  const balancesAfterPledge = await deriveAccountBalances(fixtures.projectId);
  check(
    "the authorization sits in the PENDING bucket, not the settled one",
    balancesAfterPledge.get("escrow_held")?.settledInCents === 0n &&
      balancesAfterPledge.get("escrow_held")?.pendingInCents === EXPECTED_NET_IN_CENTS,
    `settled ${balancesAfterPledge.get("escrow_held")?.settledInCents}, pending ${balancesAfterPledge.get("escrow_held")?.pendingInCents}`,
  );

  // --- 2. A FOUNDER CANNOT PLEDGE TO THEIR OWN ROUND.

  const selfPledge = await createPledge({
    roundId: fixtures.roundId,
    backerUserId: fixtures.founderUserId,
    amountInCents: PLEDGE_AMOUNT_IN_CENTS,
  });
  check(
    "a founder cannot pledge to their own round",
    !selfPledge.success && selfPledge.error.type === "SELF_PLEDGE_FORBIDDEN",
    !selfPledge.success ? selfPledge.error.type : "it was ACCEPTED",
  );

  // --- 3. THE WORKER SUBMITS. Still nothing moves.

  const transferId = pledged.value.providerTransferId;
  if (transferId === null) {
    check("the pledge minted a transfer", false, "providerTransferId was null");
    return;
  }

  const submitted = await submitTransfer(transferId);
  check(
    "the worker submits the transfer",
    submitted.success && submitted.value.status === "submitted",
    submitted.success ? submitted.value.status : JSON.stringify(submitted.error),
  );

  const resubmitted = await submitTransfer(transferId);
  check(
    "re-submitting is a no-op rather than a second submission",
    resubmitted.success && resubmitted.value.status === "submitted",
    resubmitted.success ? "still submitted" : JSON.stringify(resubmitted.error),
  );

  check(
    "raisedAmountInCents STILL has not moved after submission",
    (await readRaisedAmount(fixtures.roundId)) === 0n,
    `raised ${await readRaisedAmount(fixtures.roundId)}`,
  );

  // --- 4. SETTLEMENT. The ONE path that moves the counters, and it needs a human.

  const settled = await decideSettlement({
    transferId,
    outcome: "settled",
    decidedByUserId: fixtures.auditorUserId,
    note: "Smoke settlement",
  });

  check(
    "an auditor settles the transfer",
    settled.success && settled.value.outcome === "settled" && !settled.value.deduplicated,
    settled.success ? `raised ${settled.value.raisedAmountInCents}` : JSON.stringify(settled.error),
  );

  const raisedAfterSettle = await readRaisedAmount(fixtures.roundId);
  check(
    "raisedAmountInCents moves at settlement, by the GROSS pledge",
    raisedAfterSettle === PLEDGE_AMOUNT_IN_CENTS,
    `raised ${raisedAfterSettle}, expected ${PLEDGE_AMOUNT_IN_CENTS}`,
  );

  // THE DEDUPE. §7's webhook discipline: a replay returns success and writes nothing.
  const replayed = await decideSettlement({
    transferId,
    outcome: "settled",
    decidedByUserId: fixtures.auditorUserId,
    note: "Replay",
  });
  check(
    "a replayed settlement is deduplicated, not counted twice",
    replayed.success && replayed.value.deduplicated,
    replayed.success ? "deduplicated" : JSON.stringify(replayed.error),
  );
  check(
    "the replay did not move raisedAmountInCents a second time",
    (await readRaisedAmount(fixtures.roundId)) === PLEDGE_AMOUNT_IN_CENTS,
    `raised ${await readRaisedAmount(fixtures.roundId)}`,
  );

  const balancesAfterSettle = await deriveAccountBalances(fixtures.projectId);
  check(
    "the pending bucket returned to zero without any row being edited",
    balancesAfterSettle.get("escrow_held")?.pendingInCents === 0n,
    `pending ${balancesAfterSettle.get("escrow_held")?.pendingInCents}`,
  );
  check(
    "the settled pool holds the NET, and the fee is in its own account",
    balancesAfterSettle.get("escrow_held")?.settledInCents === EXPECTED_NET_IN_CENTS &&
      balancesAfterSettle.get("platform_fee")?.settledInCents === EXPECTED_FEE_IN_CENTS,
    `held ${balancesAfterSettle.get("escrow_held")?.settledInCents}, fee ${balancesAfterSettle.get("platform_fee")?.settledInCents}`,
  );

  const summaryAfterSettle = await getEscrowSummary(fixtures.projectId);
  check(
    "the books balance across all six accounts",
    summaryAfterSettle.booksBalance,
    `booksBalance ${summaryAfterSettle.booksBalance}`,
  );

  // --- 5. THE RELEASE SNAPSHOT. §7's specific attack: edit the milestone between request
  // --- and approval to inflate the payout.

  await completeMilestone(fixtures.projectId, fixtures.milestoneId);

  const requested = await requestEscrowRelease({
    projectId: fixtures.projectId,
    milestoneId: fixtures.milestoneId,
    requestedByUserId: fixtures.founderUserId,
    requesterRoleSnapshot: "founder",
    requestNote: "Survey delivered",
  });

  check(
    "a release request snapshots the milestone's amount",
    requested.success && requested.value.amountInCents === MILESTONE_PAYOUT_IN_CENTS.toString(),
    requested.success ? requested.value.amountInCents : JSON.stringify(requested.error),
  );
  if (!requested.success) return;

  // THE ATTACK. Raise the milestone to 400,000 after the request is in.
  await updateMilestone(fixtures.projectId, fixtures.milestoneId, {
    escrowReleaseAmountInCents: 400_000n,
  });

  const [releaseAfterEdit] = await db
    .select({ amountInCents: sql<string>`amount_in_cents` })
    .from(sql`escrow_release`)
    .where(sql`id = ${requested.value.id}`);

  check(
    "editing the milestone does NOT change the snapshotted release amount",
    releaseAfterEdit?.amountInCents === MILESTONE_PAYOUT_IN_CENTS.toString(),
    `release still ${releaseAfterEdit?.amountInCents}, milestone now 400000`,
  );

  // --- 6. THE FOUR-EYES RULE. §17 step 5.

  const selfApproved = await approveEscrowRelease({
    releaseId: requested.value.id,
    approverUserId: fixtures.founderUserId,
    note: "Approving my own request",
  });
  check(
    "a founder cannot approve their own release request",
    !selfApproved.success && selfApproved.error.type === "SELF_APPROVAL_FORBIDDEN",
    !selfApproved.success ? selfApproved.error.type : "it was APPROVED",
  );

  const strangerApproved = await approveEscrowRelease({
    releaseId: requested.value.id,
    approverUserId: fixtures.backerUserId,
    note: "I am nobody here",
  });
  check(
    "a project outsider cannot approve a release",
    !strangerApproved.success && strangerApproved.error.type === "APPROVER_NOT_AUTHORIZED",
    !strangerApproved.success ? strangerApproved.error.type : "it was APPROVED",
  );

  const approved = await approveEscrowRelease({
    releaseId: requested.value.id,
    approverUserId: fixtures.adminUserId,
    note: "Verified against the survey",
  });
  check(
    "a second, non-self-granted admin CAN approve it",
    approved.success,
    approved.success ? "approved" : JSON.stringify(approved.error),
  );

  if (approved.success) {
    check(
      "the payout is the snapshot, not the edited milestone amount",
      approved.value.amountInCents === MILESTONE_PAYOUT_IN_CENTS.toString(),
      `paid ${approved.value.amountInCents}, milestone says 400000`,
    );
    check(
      "the evidence is frozen into verificationSnapshot",
      (approved.value.verificationSnapshot ?? "").includes("approverBasis"),
      approved.value.verificationSnapshot === null ? "NULL" : "canonical JSON recorded",
    );
  }

  const balancesAfterRelease = await deriveAccountBalances(fixtures.projectId);
  check(
    "the pool fell by the payout and released_to_project rose by it",
    balancesAfterRelease.get("escrow_held")?.settledInCents ===
      EXPECTED_NET_IN_CENTS - MILESTONE_PAYOUT_IN_CENTS &&
      balancesAfterRelease.get("released_to_project")?.settledInCents === MILESTONE_PAYOUT_IN_CENTS,
    `held ${balancesAfterRelease.get("escrow_held")?.settledInCents}, released ${balancesAfterRelease.get("released_to_project")?.settledInCents}`,
  );

  // --- 7. THE CHAIN. §17 step 3.

  const verifiedBeforeTamper = await verifyEscrowChain(fixtures.projectId);
  check(
    "the escrow chain verifies before tampering",
    verifiedBeforeTamper.success,
    verifiedBeforeTamper.success
      ? `${verifiedBeforeTamper.value.entriesChecked} entries, booksBalance ${verifiedBeforeTamper.value.booksBalance}`
      : JSON.stringify(verifiedBeforeTamper.error),
  );

  const ledger = await listEscrowLedger(fixtures.projectId, { limit: 100 });
  check(
    "the ledger reads back the pledge as direction `in` and the release as `out`",
    ledger.some((entry) => entry.kind === "pledge_settled" && entry.direction === "in") &&
      ledger.some((entry) => entry.kind === "milestone_release" && entry.direction === "out"),
    `${ledger.length} entries`,
  );

  // TAMPER. With the append-only trigger disabled — which is the HONEST SHAPE OF THE
  // THREAT: an attacker with database access disables the trigger first. A test that could
  // not do this would only be proving the trigger exists, which the constraint script
  // already does.
  const targetEntry = ledger.find((entry) => entry.kind === "milestone_release");
  if (!targetEntry) {
    check("a milestone_release entry exists to tamper with", false, "none found");
  } else {
    await db.execute(
      sql`ALTER TABLE escrow_journal_entry DISABLE TRIGGER escrow_journal_entry_append_only`,
    );
    try {
      await db
        .update(escrowJournalEntry)
        .set({ description: "Milestone release — TAMPERED" })
        .where(eq(escrowJournalEntry.id, targetEntry.id));
    } finally {
      await db.execute(
        sql`ALTER TABLE escrow_journal_entry ENABLE TRIGGER escrow_journal_entry_append_only`,
      );
    }

    const verifiedAfterTamper = await verifyEscrowChain(fixtures.projectId);
    check(
      "the chain breaks at the EXACT tampered sequence",
      !verifiedAfterTamper.success &&
        verifiedAfterTamper.error.type === "ESCROW_CHAIN_BROKEN" &&
        verifiedAfterTamper.error.sequenceNumber === targetEntry.sequenceNumber &&
        verifiedAfterTamper.error.reason === "hash-mismatch",
      !verifiedAfterTamper.success && verifiedAfterTamper.error.type === "ESCROW_CHAIN_BROKEN"
        ? `broken at ${verifiedAfterTamper.error.sequenceNumber} (${verifiedAfterTamper.error.reason}), tampered ${targetEntry.sequenceNumber}`
        : "the chain still verified — tampering was NOT detected",
    );

    // Put it back, so the rest of the run — and anyone reading this project afterwards —
    // sees a chain that verifies. The tamper proved its point in the assertion above.
    await db.execute(
      sql`ALTER TABLE escrow_journal_entry DISABLE TRIGGER escrow_journal_entry_append_only`,
    );
    try {
      await db
        .update(escrowJournalEntry)
        .set({ description: targetEntry.description })
        .where(eq(escrowJournalEntry.id, targetEntry.id));
    } finally {
      await db.execute(
        sql`ALTER TABLE escrow_journal_entry ENABLE TRIGGER escrow_journal_entry_append_only`,
      );
    }

    const verifiedAfterRestore = await verifyEscrowChain(fixtures.projectId);
    check(
      "restoring the byte restores the chain — the break was the HASH, not a flag",
      verifiedAfterRestore.success,
      verifiedAfterRestore.success ? "verifies again" : JSON.stringify(verifiedAfterRestore.error),
    );
  }

  // --- 8. RECONCILIATION. Idempotent, and it asserts the zero-sum identity.

  const asOf = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
  const firstRun = await handleReconcileEscrowLedger({
    asOf: asOf.toISOString(),
    projectId: fixtures.projectId,
  });
  check(
    "reconciliation finds no discrepancy and the books balance",
    firstRun.discrepanciesOpened === 0 && firstRun.zeroSumHolds,
    `${firstRun.discrepanciesOpened} discrepancies, zeroSumHolds ${firstRun.zeroSumHolds}`,
  );

  const secondRun = await handleReconcileEscrowLedger({
    asOf: asOf.toISOString(),
    projectId: fixtures.projectId,
  });
  check(
    "re-running reconciliation is a no-op",
    secondRun.discrepanciesOpened === 0,
    `${secondRun.discrepanciesOpened} discrepancies on the second run`,
  );

  // --- 9. THE APPEND-ONLY GUARANTEE, exercised through the live connection rather than a
  // --- rolled-back probe: this is the trigger the service depends on, in production shape.

  let updateWasRejected = false;
  try {
    await db
      .update(escrowJournalEntry)
      .set({ description: "Rewritten through the app's own pool" })
      .where(eq(escrowJournalEntry.projectId, fixtures.projectId));
  } catch {
    updateWasRejected = true;
  }
  check(
    "the application's own connection cannot rewrite a ledger entry",
    updateWasRejected,
    updateWasRejected ? "rejected" : "the UPDATE SUCCEEDED",
  );

  // --- 10. The transfer is terminal.

  const [finalTransfer] = await db
    .select({ status: providerTransfer.status })
    .from(providerTransfer)
    .where(and(eq(providerTransfer.id, transferId), eq(providerTransfer.status, "settled")));

  check(
    "the settled transfer stayed settled",
    finalTransfer !== undefined,
    finalTransfer?.status ?? "not settled",
  );

  console.log(
    failureCount === 0
      ? `\nThe §12 money path holds end to end. Project ${fixtures.projectSlug} left in place for inspection.`
      : `\n${failureCount} assertion(s) FAILED.`,
  );

  if (failureCount > 0) {
    process.exitCode = 1;
  }
}

main()
  .then(async () => {
    await stopSendOnlyBoss();
    await pool.end();
    return undefined;
  })
  .catch(async (error: unknown) => {
    console.error("Funding and escrow smoke test failed to run:", error);
    await stopSendOnlyBoss();
    await pool.end();
    process.exit(1);
  });
