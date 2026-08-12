/**
 * Drives a funding round's commitment path against a REAL database
 * (R_AND_D_BACKEND_STRUCTURE.md §7, §12, §17 steps 1 and 4).
 *
 * REPLACES `smoke-funding-escrow.ts`. That script drove one pledge from authorization
 * through provider submission, auditor settlement and a four-eyes milestone release. Six
 * of its nine steps described machinery that no longer exists: escrow has left this domain
 * on legal grounds (§7A.6), so there is no authorization, no provider transfer, no
 * settlement and no release. What survives is the half that was always the product —
 * a pledge is a COMMITMENT, and the server owns every number attached to it.
 *
 * WHAT THIS PROVES THAT NOTHING ELSE DOES. The unit tests prove the schemas reject
 * tampered keys; they cannot prove that a pledge made through the SERVICE layer re-bounds
 * a hostile amount against the round's own limits, that a founder cannot inflate their own
 * backer count, that withdrawing a commitment takes the counters back down, or that the
 * audit chain actually breaks when a row is edited underneath it.
 *
 *   POST …/pledges              → 201, a COMMITMENT. No charge, no hold, no fee.
 *   raisedAmountInCents          → moves by the gross, in the pledge's own transaction
 *   founder pledges to own round → SELF_PLEDGE_FORBIDDEN
 *   pledge below the minimum     → re-bound against the ROUND, not the client's copy
 *   backer withdraws             → both counters come back down
 *   tamper with an audit row      → the chain breaks at that exact sequence
 *
 * THE PLATFORM FEE IS ZERO AND THIS SCRIPT ASSERTS IT (§0). Qatoto charges nobody, and a
 * regression that reintroduced a take-rate would change the legal analysis as well as the
 * arithmetic.
 *
 * THIS SCRIPT LEAVES ITS ROWS BEHIND, AND THAT IS THE GUARANTEE RATHER THAN A LIMITATION.
 * `project_audit_entry` rejects UPDATE, DELETE and TRUNCATE outright, so a script that
 * could clean up after itself would be a script proving the triggers do not work. Every
 * run uses a fresh, uniquely-slugged project. Run it against a DEVELOPMENT database.
 *
 *   pnpm db:smoke-funding
 *
 * Exits non-zero on the first failed assertion.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { db, pool } from "#src/db/index.js";
import {
  fundingRound,
  milestone,
  projectAuditEntry,
  projectMember,
  projectStats,
  researchCategory,
  researchProject,
  user,
} from "#src/db/schema.js";
import { stopSendOnlyBoss } from "#src/lib/jobs.js";
import {
  cancelPledge,
  createPledge,
  getFundingRound,
  listRoundBackers,
} from "#src/modules/rnd/funding/funding-rounds.service.js";
import { verifyAuditChain } from "#src/modules/rnd/projects/project-audit.service.js";

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
  readonly roundId: string;
}

const PLEDGE_AMOUNT_IN_CENTS = 500_000n;
const MINIMUM_PLEDGE_IN_CENTS = 1_000n;
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

  const founderUserId = `smoke-funding-founder-${runId}`;
  const backerUserId = `smoke-funding-backer-${runId}`;

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
  ]);

  const projectSlug = `smoke-funding-${runId}`;
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
  await db
    .insert(projectMember)
    .values({ projectId: project.id, userId: founderUserId, projectRole: "founder" });

  const [round] = await db
    .insert(fundingRound)
    .values({
      projectId: project.id,
      type: "crowdfunding",
      status: "open",
      title: "Seed round",
      goalAmountInCents: 1_000_000n,
      minimumPledgeInCents: MINIMUM_PLEDGE_IN_CENTS,
      currency: "USD",
      opensAt: new Date(),
      closesAt: new Date(Date.now() + 30 * 86_400_000),
      createdByUserId: founderUserId,
    })
    .returning({ id: fundingRound.id });

  if (!round) throw new Error("smoke: round insert returned no row");

  // A milestone with a PLANNED PAYOUT — a plan the founder pays from their own bank and
  // records through §7A, never an instruction to a payment rail (§7).
  await db.insert(milestone).values({
    projectId: project.id,
    title: "400-vendor demand survey",
    status: "in_progress",
    plannedPayoutInCents: MILESTONE_PAYOUT_IN_CENTS,
    currency: "USD",
    orderIndex: 0,
    createdByUserId: founderUserId,
  });

  return { projectId: project.id, projectSlug, founderUserId, backerUserId, roundId: round.id };
}

async function readRound(
  roundId: string,
): Promise<{ readonly raisedInCents: bigint; readonly backersCount: number }> {
  const found = await getFundingRound(roundId);
  if (!found.success) {
    return { raisedInCents: -1n, backersCount: -1 };
  }
  return {
    raisedInCents: BigInt(found.value.raisedAmountInCents),
    backersCount: found.value.backersCount,
  };
}

async function main(): Promise<void> {
  const fixtures = await createFixtures();
  console.log(`Fixtures: project ${fixtures.projectSlug}\n`);

  // --- 1. THE PLEDGE IS A COMMITMENT. No card is charged, no funds are held, no fee is
  // --- taken — and the response must never imply otherwise (§7).

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
    "NO FEE IS TAKEN — Qatoto charges nobody (§0)",
    pledged.value.platformFeeInCents === "0",
    `fee ${pledged.value.platformFeeInCents}`,
  );

  check(
    "no provider transfer is minted — there is nothing to submit and nobody to submit to",
    pledged.value.providerTransferId === null,
    `providerTransferId ${String(pledged.value.providerTransferId)}`,
  );

  const afterPledge = await readRound(fixtures.roundId);
  check(
    "raisedAmountInCents moves on the COMMITMENT, by the gross",
    afterPledge.raisedInCents === PLEDGE_AMOUNT_IN_CENTS,
    `raised ${afterPledge.raisedInCents}, expected ${PLEDGE_AMOUNT_IN_CENTS}`,
  );
  check(
    "backersCount moves with it",
    afterPledge.backersCount === 1,
    `${afterPledge.backersCount}`,
  );

  const backers = await listRoundBackers(fixtures.roundId);
  check(
    "a committed backer appears in the public list",
    backers.length === 1 && backers[0]?.pledgeId === pledged.value.id,
    `${backers.length} backer(s)`,
  );

  // --- 2. A FOUNDER CANNOT PLEDGE TO THEIR OWN ROUND. Those three numbers exist to tell
  // --- an outsider whether STRANGERS believe in this project.

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

  // --- 3. THE RE-BOUND (§17 step 4). The client's copy of the round's limits is never
  // --- consulted: the server reads its own row and enforces that.

  const tooSmall = await createPledge({
    roundId: fixtures.roundId,
    backerUserId: fixtures.backerUserId,
    amountInCents: MINIMUM_PLEDGE_IN_CENTS - 1n,
  });
  check(
    "an amount below the round's own minimum is refused",
    !tooSmall.success && tooSmall.error.type === "PLEDGE_BELOW_MINIMUM",
    !tooSmall.success ? tooSmall.error.type : "it was ACCEPTED",
  );

  check(
    "the refused pledge moved nothing",
    (await readRound(fixtures.roundId)).raisedInCents === PLEDGE_AMOUNT_IN_CENTS,
    `raised ${(await readRound(fixtures.roundId)).raisedInCents}`,
  );

  // --- 4. WITHDRAWING TAKES THE COUNTERS BACK DOWN. A withdrawn commitment that left
  // --- `raisedAmountInCents` where it was would tell an outsider strangers still back
  // --- this project when one of them has said they do not.

  const cancelled = await cancelPledge(pledged.value.id, fixtures.backerUserId);
  check(
    "a backer can withdraw their own commitment",
    cancelled.success && cancelled.value.status === "cancelled",
    cancelled.success ? cancelled.value.status : JSON.stringify(cancelled.error),
  );

  const afterCancel = await readRound(fixtures.roundId);
  check(
    "raisedAmountInCents comes back down on withdrawal",
    afterCancel.raisedInCents === 0n,
    `raised ${afterCancel.raisedInCents}`,
  );
  check(
    "backersCount comes back down with it",
    afterCancel.backersCount === 0,
    `${afterCancel.backersCount}`,
  );

  const backersAfterCancel = await listRoundBackers(fixtures.roundId);
  check(
    "a withdrawn commitment leaves the public backer list",
    backersAfterCancel.length === 0,
    `${backersAfterCancel.length} backer(s)`,
  );

  const strangerCancel = await cancelPledge(pledged.value.id, fixtures.founderUserId);
  check(
    "somebody else's pledge cannot be withdrawn",
    !strangerCancel.success &&
      (strangerCancel.error.type === "NOT_THE_BACKER" ||
        strangerCancel.error.type === "PLEDGE_NOT_CANCELLABLE"),
    !strangerCancel.success ? strangerCancel.error.type : "it was ACCEPTED",
  );

  // --- 5. THE AUDIT CHAIN IS TAMPER-EVIDENT. Both the pledge and the withdrawal appended
  // --- to it, in the same transactions that recorded them.

  const beforeTamper = await verifyAuditChain(fixtures.projectId);
  check(
    "the audit chain verifies before tampering",
    beforeTamper.success && beforeTamper.value.entriesChecked >= 2,
    beforeTamper.success
      ? `${beforeTamper.value.entriesChecked} entries`
      : JSON.stringify(beforeTamper.error),
  );

  const [targetEntry] = await db
    .select({ sequenceNumber: projectAuditEntry.sequenceNumber })
    .from(projectAuditEntry)
    .where(
      and(
        eq(projectAuditEntry.projectId, fixtures.projectId),
        eq(projectAuditEntry.eventKind, "pledge_recorded"),
      ),
    )
    .limit(1);

  if (!targetEntry) {
    check("a pledge_recorded entry exists to tamper with", false, "none found");
    return;
  }

  // WITH THE APPEND-ONLY TRIGGER DISABLED, which is the HONEST shape of the threat: the
  // attacker this chain defends against is someone with a psql prompt, and they would
  // disable the trigger too. Leaving it on would prove only that the trigger works, which
  // `db:verify-escrow-constraints` already proves.
  await db.execute(
    sql`ALTER TABLE "project_audit_entry" DISABLE TRIGGER "project_audit_entry_append_only"`,
  );
  try {
    await db
      .update(projectAuditEntry)
      .set({ detailNote: "tampered by the smoke test" })
      .where(
        and(
          eq(projectAuditEntry.projectId, fixtures.projectId),
          eq(projectAuditEntry.sequenceNumber, targetEntry.sequenceNumber),
        ),
      );
  } finally {
    await db.execute(
      sql`ALTER TABLE "project_audit_entry" ENABLE TRIGGER "project_audit_entry_append_only"`,
    );
  }

  const afterTamper = await verifyAuditChain(fixtures.projectId);
  check(
    "the chain breaks at the EXACT tampered sequence",
    !afterTamper.success &&
      afterTamper.error.type === "CHAIN_BROKEN" &&
      afterTamper.error.sequenceNumber === targetEntry.sequenceNumber &&
      afterTamper.error.reason === "hash-mismatch",
    !afterTamper.success && afterTamper.error.type === "CHAIN_BROKEN"
      ? `broke at ${afterTamper.error.sequenceNumber} (${afterTamper.error.reason}), expected ${targetEntry.sequenceNumber}`
      : "the chain still verified",
  );

  console.log(
    `\nThe project ${fixtures.projectSlug} is left behind ON PURPOSE, with a deliberately ` +
      "broken audit chain. Append-only tables cannot be cleaned up, and a script that " +
      "could clean up after itself would be one proving the triggers do not work.",
  );
}

try {
  await main();
} finally {
  await stopSendOnlyBoss();
  await pool.end();
}

if (failureCount > 0) {
  console.error(`\n${failureCount} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll assertions passed.");
