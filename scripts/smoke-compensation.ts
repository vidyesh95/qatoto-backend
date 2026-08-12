/**
 * Drives §12's compensation trace end to end against a REAL database
 * (R_AND_D_BACKEND_STRUCTURE.md §7A, §12, §17 steps 5, 5a and 5b).
 *
 * THE ASSERTION THIS FILE EXISTS FOR IS STEP 5a, AND IT HAS A STATUTE BEHIND IT. Two
 * members do identical work in the same month. One member's claims verify; the other's are
 * flagged for review. Their `cash_hourly` lines must be **byte-identical** — same minutes,
 * same gross, same currency — and only the `verificationNote` and the `equity_delta` line
 * may differ.
 *
 * That asymmetry is §0's first added rule and the whole legal difference between a
 * compensation engine and a wage-withholding machine. Conditioning earned wages on an
 * algorithm passing is unlawful withholding under the FLSA and state timely-payment law in
 * the US, under national wage statutes across the EU, and under §18 of India's Code on
 * Wages 2019, whose list of permitted deductions is exhaustive and does not include "the
 * AI found no commit". §9 withholds SLICES. It does not withhold wages.
 *
 * The rest of the trace:
 *
 *   propose → accept                 the SUBJECT accepts; a founder cannot accept for them
 *   nightly draft                    idempotent — re-run 20× and the lines are identical
 *   close                            the period stops accruing; the next one opens
 *   finalize                         frozen, hashed, one audit entry, next month opened
 *   countersign                      a DIFFERENT admin; the finalizer is refused
 *   record a payment                 an attestation; the line does not change
 *   confirm                          the member's half of the evidence
 *   tamper with a line               the statement chain breaks
 *   supersede                        a new period; nothing is ever edited
 *
 * THIS SCRIPT LEAVES ITS ROWS BEHIND, AND THAT IS THE GUARANTEE RATHER THAN A LIMITATION.
 * A finalized period and its lines reject UPDATE and DELETE outright, so a script that
 * could clean up after itself would be one proving the triggers do not work. Every run
 * uses a fresh, uniquely-slugged project. Run it against a DEVELOPMENT database.
 *
 *   pnpm db:smoke-compensation
 *
 * Exits non-zero on the first failed assertion.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { db, pool } from "#src/db/index.js";
import {
  compensationPeriod,
  compensationPeriodLine,
  effortClaim,
  memberFairMarketRate,
  projectMember,
  projectStats,
  researchCategory,
  researchProject,
  sliceLedgerEntry,
  user,
} from "#src/db/schema.js";
import { stopSendOnlyBoss } from "#src/lib/jobs.js";
import {
  monthBoundsAt,
  nextMonthBounds,
  periodWindow,
} from "#src/modules/rnd/compensation-period.js";
import {
  acceptCashAgreement,
  proposeCashAgreement,
} from "#src/modules/rnd/compensation/compensation-agreements.service.js";
import {
  confirmPayment,
  recordPayment,
} from "#src/modules/rnd/compensation/compensation-payments.service.js";
import {
  countersignPeriod,
  draftPeriodLines,
  ensurePeriodCovering,
  finalizePeriod,
  FINALIZE_ACKNOWLEDGEMENT,
  getPeriod,
  supersedePeriod,
  verifyStatementChain,
} from "#src/modules/rnd/compensation/compensation-periods.service.js";

let failureCount = 0;

function check(label: string, passed: boolean, detail: string): void {
  console.log(`${passed ? "PASS" : "FAIL"}  ${label} — ${detail}`);
  if (!passed) failureCount += 1;
}

/**
 * A month that has already ended, so the period is finalizable the moment it is drafted.
 * Fixed relative to "now" rather than hard-coded, so the script does not expire.
 */
const NOW = new Date();
const WORK_MONTH = monthBoundsAt(new Date(NOW.getFullYear(), NOW.getMonth() - 2, 15), "UTC");
const WORK_WINDOW = periodWindow(WORK_MONTH);
/** Somewhere safely inside the month, whichever month it is. */
const WORKED_AT = new Date(WORK_WINDOW.startsAt.getTime() + 5 * 86_400_000);

const HOURLY_RATE_CENTS = 12_000n;
const WORKED_MINUTES = 1_250;
/** 1250 × 12000 / 60, applied once at the end. */
const EXPECTED_GROSS_IN_CENTS = "250000";

interface Fixtures {
  readonly projectId: string;
  readonly projectSlug: string;
  readonly founderUserId: string;
  readonly adminUserId: string;
  readonly verifiedUserId: string;
  readonly flaggedUserId: string;
  readonly verifiedMemberId: string;
  readonly flaggedMemberId: string;
}

/**
 * Two members, identical work, opposite verdicts.
 *
 * The §9 rows are written BY HAND rather than driven through the verification pipeline, on
 * purpose: this script is about what §7A does with a verdict, not about how §9 reaches
 * one. `db:smoke-proof-of-effort` covers the pipeline.
 */
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

  const founderUserId = `smoke-comp-founder-${runId}`;
  const adminUserId = `smoke-comp-admin-${runId}`;
  const verifiedUserId = `smoke-comp-verified-${runId}`;
  const flaggedUserId = `smoke-comp-flagged-${runId}`;

  const people: readonly (readonly [string, string])[] = [
    [founderUserId, "Smoke Founder"],
    [adminUserId, "Smoke Admin"],
    [verifiedUserId, "Smoke Verified"],
    [flaggedUserId, "Smoke Flagged"],
  ];
  await db.insert(user).values(
    people.map(([id, name]) => ({
      id,
      name,
      email: `${id}@example.test`,
      emailVerified: true,
    })),
  );

  const projectSlug = `smoke-comp-${runId}`;
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
      currency: "USD",
    })
    .returning({ id: researchProject.id });

  if (!project) throw new Error("smoke: project insert returned no row");

  await db.insert(projectStats).values({ projectId: project.id, projectTimeZone: "UTC" });

  const [founderMember, adminMember, verifiedMember, flaggedMember] = await db
    .insert(projectMember)
    .values([
      { projectId: project.id, userId: founderUserId, projectRole: "founder" },
      // GRANTED BY THE FOUNDER, never self-granted — the CHECK rejects a self-grant and
      // `resolveSecondSignatoryStanding` refuses an un-provenanced admin.
      {
        projectId: project.id,
        userId: adminUserId,
        projectRole: "admin",
        roleGrantedByUserId: founderUserId,
      },
      {
        projectId: project.id,
        userId: verifiedUserId,
        projectRole: "contributor",
        joinedAt: WORK_WINDOW.startsAt,
      },
      {
        projectId: project.id,
        userId: flaggedUserId,
        projectRole: "contributor",
        joinedAt: WORK_WINDOW.startsAt,
      },
    ])
    .returning({ id: projectMember.id, userId: projectMember.userId });

  if (!founderMember || !adminMember || !verifiedMember || !flaggedMember) {
    throw new Error("smoke: member insert returned too few rows");
  }

  // §9's locked rate, for both. `finalize` refuses an hourly line whose member has none,
  // and `acceptCashAgreement` validates the two against each other.
  for (const member of [verifiedMember, flaggedMember]) {
    await db.insert(memberFairMarketRate).values({
      projectId: project.id,
      memberId: member.id,
      fairMarketRateCentsPerHour: 20_000n,
      paidCashRateCentsPerHour: HOURLY_RATE_CENTS,
      currencyCode: "USD",
      status: "locked",
      effectiveFrom: WORK_WINDOW.startsAt,
      rationaleNote: "Smoke rate",
      proposedByUserId: founderUserId,
      acceptedAt: WORK_WINDOW.startsAt,
      acceptedByUserId: member.userId,
      lockedAt: WORK_WINDOW.startsAt,
      lockedByUserId: founderUserId,
    });
  }

  // IDENTICAL LEDGER ENTRIES. Same minutes, same instant, same kind — the only thing that
  // will differ between these two people is a verdict.
  let sequenceNumber = 0;
  for (const member of [verifiedMember, flaggedMember]) {
    sequenceNumber += 1;
    await db.insert(sliceLedgerEntry).values({
      projectId: project.id,
      sequenceNumber,
      memberId: member.id,
      entryKind: "award",
      contributionKind: "time",
      sliceNumerator: 1n,
      slicesAwarded: 1,
      unpaidRateCentsPerHour: 8_000n,
      effortMinutes: WORKED_MINUTES,
      occurredAt: WORKED_AT,
    });
  }

  // THE ONLY DIFFERENCE: one claim verified, one flagged for review.
  const claimedForDate = WORK_MONTH.periodStartDate;
  await db.insert(effortClaim).values([
    {
      projectId: project.id,
      memberId: verifiedMember.id,
      sourceKind: "physical_receipt",
      claimSummary: "Wired the cold-chain telemetry endpoint.",
      claimedForDate,
      verificationStatus: "verified",
      // A terminal verdict names WHEN it was reached — `effort_claim_verdict_ck` pairs the
      // two, so a claim cannot claim to be settled without saying when.
      verdictReachedAt: WORKED_AT,
      idempotencyKey: `smoke-claim-verified-${runId}`,
    },
    {
      projectId: project.id,
      memberId: flaggedMember.id,
      sourceKind: "physical_receipt",
      // WORD FOR WORD THE SAME WORK. The only difference between these two people is the
      // verdict, which is what makes the §17 step 5a assertion meaningful.
      claimSummary: "Wired the cold-chain telemetry endpoint.",
      claimedForDate,
      verificationStatus: "flagged_for_review",
      verdictReachedAt: WORKED_AT,
      idempotencyKey: `smoke-claim-flagged-${runId}`,
    },
  ]);

  return {
    projectId: project.id,
    projectSlug,
    founderUserId,
    adminUserId,
    verifiedUserId,
    flaggedUserId,
    verifiedMemberId: verifiedMember.id,
    flaggedMemberId: flaggedMember.id,
  };
}

async function main(): Promise<void> {
  const fixtures = await createFixtures();
  console.log(
    `Fixtures: project ${fixtures.projectSlug}, work month ${WORK_MONTH.periodStartDate}\n`,
  );

  const context = { projectId: fixtures.projectId, currency: "USD" };

  // --- 1. THE AGREEMENT. A founder proposes; the SUBJECT accepts.

  const proposed = await proposeCashAgreement(
    context,
    fixtures.verifiedUserId,
    fixtures.founderUserId,
    "founder",
    {
      engagementKind: "employee",
      monthlyAmountInCents: null,
      hourlyRateCentsPerHour: HOURLY_RATE_CENTS,
      effectiveFrom: WORK_WINDOW.startsAt,
      rationaleNote: "Market rate for a senior backend engineer.",
    },
  );
  check(
    "a founder proposes a cash agreement",
    proposed.success,
    proposed.success ? proposed.value.status : JSON.stringify(proposed.error),
  );
  if (!proposed.success) return;

  const founderAccepts = await acceptCashAgreement(
    context,
    proposed.value.id,
    fixtures.founderUserId,
    "founder",
  );
  check(
    "a FOUNDER cannot accept an agreement on the member's behalf",
    !founderAccepts.success && founderAccepts.error.type === "NOT_THE_AGREEMENT_SUBJECT",
    !founderAccepts.success ? founderAccepts.error.type : "it was ACCEPTED",
  );

  const accepted = await acceptCashAgreement(
    context,
    proposed.value.id,
    fixtures.verifiedUserId,
    "contributor",
  );
  check(
    "the member accepts their own agreement",
    accepted.success && accepted.value.status === "active",
    accepted.success ? accepted.value.status : JSON.stringify(accepted.error),
  );

  // The second member, flagged, on the SAME terms.
  const flaggedProposed = await proposeCashAgreement(
    context,
    fixtures.flaggedUserId,
    fixtures.founderUserId,
    "founder",
    {
      engagementKind: "employee",
      monthlyAmountInCents: null,
      hourlyRateCentsPerHour: HOURLY_RATE_CENTS,
      effectiveFrom: WORK_WINDOW.startsAt,
      rationaleNote: "Identical terms, deliberately.",
    },
  );
  if (!flaggedProposed.success) {
    check("the second agreement is proposed", false, JSON.stringify(flaggedProposed.error));
    return;
  }
  await acceptCashAgreement(
    context,
    flaggedProposed.value.id,
    fixtures.flaggedUserId,
    "contributor",
  );

  // --- 2. THE PERIOD OPENS AND THE NIGHTLY DRAFT REDRAWS IT.

  // OPENED THROUGH THE SERVICE, not by hand. A hand-written row would take sequence
  // number 1 while `project_chain_head` still said 0, and the next service-opened period
  // would collide with it — the gapless sequence and the chain head have to be allocated
  // by the same code that owns them.
  const opened = await ensurePeriodCovering(fixtures.projectId, WORKED_AT);
  const openedPeriod = opened.accruing;
  check(
    "the period covering the work month is opened by the service",
    openedPeriod.periodStartDate === WORK_MONTH.periodStartDate,
    `${openedPeriod.periodStartDate} (sequence ${openedPeriod.sequenceNumber})`,
  );

  const drafted = await draftPeriodLines(fixtures.projectId, openedPeriod.id, NOW);
  check(
    "the nightly draft writes the period's lines",
    drafted.success && drafted.value.lineCount > 0,
    drafted.success ? `${drafted.value.lineCount} lines` : JSON.stringify(drafted.error),
  );

  // --- 3. §17 STEP 5b: THE DRAFT IS IDEMPOTENT.

  const firstPass = await getPeriod(fixtures.projectId, openedPeriod.id);
  if (!firstPass.success) {
    check("the drafted period reads back", false, JSON.stringify(firstPass.error));
    return;
  }
  const firstSnapshot = JSON.stringify(firstPass.value.lines);

  for (let run = 0; run < 20; run += 1) {
    await draftPeriodLines(fixtures.projectId, openedPeriod.id, NOW);
  }

  const afterRedraws = await getPeriod(fixtures.projectId, openedPeriod.id);
  check(
    "20 redraws produce BYTE-IDENTICAL lines (§17 step 5b)",
    afterRedraws.success && JSON.stringify(afterRedraws.value.lines) === firstSnapshot,
    afterRedraws.success
      ? `${afterRedraws.value.lines.length} lines, unchanged`
      : JSON.stringify(afterRedraws.error),
  );

  // --- 4. §17 STEP 5a: THE RULE WITH A STATUTE BEHIND IT.

  if (!afterRedraws.success) return;
  const lines = afterRedraws.value.lines;

  const verifiedCash = lines.find(
    (line) => line.memberId === fixtures.verifiedMemberId && line.kind === "cash_hourly",
  );
  const flaggedCash = lines.find(
    (line) => line.memberId === fixtures.flaggedMemberId && line.kind === "cash_hourly",
  );

  check(
    "both members have a cash_hourly line — a flagged verdict does not remove one",
    verifiedCash !== undefined && flaggedCash !== undefined,
    `verified ${verifiedCash === undefined ? "MISSING" : "present"}, flagged ${flaggedCash === undefined ? "MISSING" : "present"}`,
  );

  if (!verifiedCash || !flaggedCash) return;

  check(
    "the gross is 1250 minutes at $120/h = exactly $2,500, with 60 applied once",
    verifiedCash.grossAmountInCents === EXPECTED_GROSS_IN_CENTS,
    `${verifiedCash.grossAmountInCents}, expected ${EXPECTED_GROSS_IN_CENTS}`,
  );

  check(
    "**A FLAGGED VERDICT CHANGES NO CASH NUMBER** (§0, §7A.6 item 2)",
    flaggedCash.grossAmountInCents === verifiedCash.grossAmountInCents &&
      flaggedCash.effortMinutes === verifiedCash.effortMinutes &&
      flaggedCash.currency === verifiedCash.currency,
    `flagged ${flaggedCash.grossAmountInCents}/${flaggedCash.effortMinutes}min vs verified ${verifiedCash.grossAmountInCents}/${verifiedCash.effortMinutes}min`,
  );

  check(
    "the verdict ANNOTATES the flagged member's line and nothing else",
    flaggedCash.verificationNote !== null && verifiedCash.verificationNote === null,
    `flagged note ${flaggedCash.verificationNote === null ? "MISSING" : "present"}, verified note ${verifiedCash.verificationNote === null ? "absent (correct)" : "PRESENT (wrong)"}`,
  );

  // --- 5. FINALIZE. Frozen, hashed, and the next month opens in the same transaction.

  const wrongAcknowledgement = await finalizePeriod(
    context,
    openedPeriod.id,
    "yes please",
    fixtures.founderUserId,
    "founder",
    NOW,
  );
  check(
    "a mistyped acknowledgement cannot reach the freeze",
    !wrongAcknowledgement.success && wrongAcknowledgement.error.type === "ACKNOWLEDGEMENT_MISMATCH",
    !wrongAcknowledgement.success ? wrongAcknowledgement.error.type : "it FROZE",
  );

  const finalized = await finalizePeriod(
    context,
    openedPeriod.id,
    FINALIZE_ACKNOWLEDGEMENT,
    fixtures.founderUserId,
    "founder",
    NOW,
  );
  check(
    "the founder finalizes the statement",
    finalized.success && finalized.value.status === "finalized",
    finalized.success ? finalized.value.status : JSON.stringify(finalized.error),
  );
  if (!finalized.success) return;

  check(
    "the statement hash is a FULL 64 hex characters, chained from genesis",
    /^[0-9a-f]{64}$/.test(finalized.value.statementHash ?? "") &&
      finalized.value.previousStatementHash === "genesis",
    `${finalized.value.statementHash?.slice(0, 12)}… after ${finalized.value.previousStatementHash}`,
  );

  const nextMonth = nextMonthBounds(WORK_MONTH);
  const [successor] = await db
    .select({ id: compensationPeriod.id })
    .from(compensationPeriod)
    .where(
      and(
        eq(compensationPeriod.projectId, fixtures.projectId),
        eq(compensationPeriod.periodStartDate, nextMonth.periodStartDate),
      ),
    );
  check(
    "finalizing opens the NEXT month — a project with no open period loses effort",
    successor !== undefined,
    successor === undefined ? "no successor" : "successor opened",
  );

  // --- 6. FOUR EYES (§17 step 5, ported from the escrow release).

  const selfCountersign = await countersignPeriod(
    context,
    openedPeriod.id,
    fixtures.founderUserId,
    "founder",
    null,
  );
  check(
    "THE FINALIZER CANNOT COUNTERSIGN, even a founder",
    !selfCountersign.success && selfCountersign.error.type === "SELF_COUNTERSIGN_FORBIDDEN",
    !selfCountersign.success ? selfCountersign.error.type : "it was SIGNED",
  );

  const outsiderCountersign = await countersignPeriod(
    context,
    openedPeriod.id,
    fixtures.verifiedUserId,
    "contributor",
    null,
  );
  check(
    "a plain contributor is not a second pair of eyes",
    !outsiderCountersign.success &&
      outsiderCountersign.error.type === "COUNTERSIGNER_NOT_AUTHORIZED",
    !outsiderCountersign.success ? outsiderCountersign.error.type : "it was SIGNED",
  );

  const countersigned = await countersignPeriod(
    context,
    openedPeriod.id,
    fixtures.adminUserId,
    "admin",
    "Checked against the ledger.",
  );
  check(
    "a second, non-self-granted admin countersigns",
    countersigned.success && countersigned.value.countersignedAt !== null,
    countersigned.success ? "countersigned" : JSON.stringify(countersigned.error),
  );

  // --- 7. A PAYMENT IS AN ATTESTATION, AND IT CHANGES NO LINE.

  const equityLine = lines.find(
    (line) => line.memberId === fixtures.verifiedMemberId && line.kind === "equity_delta",
  );
  if (equityLine) {
    const payEquity = await recordPayment(
      context,
      equityLine.id,
      fixtures.founderUserId,
      "founder",
      {
        paidAmountInCents: 1n,
        paidOnDate: WORK_MONTH.periodEndDate,
        methodKey: "bank_transfer",
        referenceNote: null,
        idempotencyKey: `smoke-equity-${randomUUID().slice(0, 8)}`,
      },
    );
    check(
      "an EQUITY line cannot be paid — nothing here issues a share",
      !payEquity.success && payEquity.error.type === "LINE_IS_NOT_CASH",
      !payEquity.success ? payEquity.error.type : "it was PAID",
    );
  }

  const cardShaped = await recordPayment(
    context,
    verifiedCash.id,
    fixtures.founderUserId,
    "founder",
    {
      paidAmountInCents: 250_000n,
      paidOnDate: WORK_MONTH.periodEndDate,
      methodKey: "bank_transfer",
      referenceNote: "sent from card 4111 1111 1111 1111",
      idempotencyKey: `smoke-card-${randomUUID().slice(0, 8)}`,
    },
  );
  check(
    "a reference note containing a card number is refused (§17 step 5c)",
    !cardShaped.success && cardShaped.error.type === "PAYMENT_INSTRUMENT_IN_REFERENCE_NOTE",
    !cardShaped.success ? cardShaped.error.type : "it was STORED",
  );

  const idempotencyKey = `smoke-pay-${randomUUID().slice(0, 8)}`;
  const paid = await recordPayment(context, verifiedCash.id, fixtures.founderUserId, "founder", {
    paidAmountInCents: 250_000n,
    paidOnDate: WORK_MONTH.periodEndDate,
    methodKey: "bank_transfer",
    referenceNote: "UTR 302145987",
    idempotencyKey,
  });
  check(
    "the founder records a payment made off-platform",
    paid.success && paid.value.confirmedByMemberAt === null,
    paid.success ? "recorded, UNCONFIRMED" : JSON.stringify(paid.error),
  );
  if (!paid.success) return;

  const replayed = await recordPayment(
    context,
    verifiedCash.id,
    fixtures.founderUserId,
    "founder",
    {
      paidAmountInCents: 250_000n,
      paidOnDate: WORK_MONTH.periodEndDate,
      methodKey: "bank_transfer",
      referenceNote: "UTR 302145987",
      idempotencyKey,
    },
  );
  check(
    "a retried POST returns the SAME payment rather than recording a second",
    replayed.success && replayed.value.id === paid.value.id,
    replayed.success ? "deduplicated" : JSON.stringify(replayed.error),
  );

  const founderConfirms = await confirmPayment(
    context,
    verifiedCash.id,
    paid.value.id,
    fixtures.founderUserId,
    "founder",
  );
  check(
    "the founder cannot confirm receipt on the member's behalf",
    !founderConfirms.success && founderConfirms.error.type === "NOT_THE_PAID_MEMBER",
    !founderConfirms.success ? founderConfirms.error.type : "it was CONFIRMED",
  );

  const confirmed = await confirmPayment(
    context,
    verifiedCash.id,
    paid.value.id,
    fixtures.verifiedUserId,
    "contributor",
  );
  check(
    "THE MEMBER confirms receipt — the other half of the evidence",
    confirmed.success && confirmed.value.confirmedByMemberAt !== null,
    confirmed.success ? "confirmed" : JSON.stringify(confirmed.error),
  );

  // --- 8. THE STATEMENT CHAIN IS TAMPER-EVIDENT (§17 step 5b).

  const beforeTamper = await verifyStatementChain(fixtures.projectId);
  check(
    "the statement chain verifies before tampering",
    beforeTamper.success && beforeTamper.value.periodsChecked === 1,
    beforeTamper.success
      ? `${beforeTamper.value.periodsChecked} finalized period(s)`
      : JSON.stringify(beforeTamper.error),
  );

  // WITH THE FREEZE TRIGGER DISABLED, which is the HONEST shape of the threat: the attacker
  // this chain defends against has a psql prompt and would disable the trigger too.
  // `db:verify-compensation-constraints` already proves the trigger itself fires.
  await db.execute(
    sql`ALTER TABLE "compensation_period_line" DISABLE TRIGGER "compensation_period_line_freeze"`,
  );
  try {
    await db
      .update(compensationPeriodLine)
      .set({ grossAmountInCents: 999_999_999n })
      .where(eq(compensationPeriodLine.id, verifiedCash.id));
  } finally {
    await db.execute(
      sql`ALTER TABLE "compensation_period_line" ENABLE TRIGGER "compensation_period_line_freeze"`,
    );
  }

  const afterTamper = await verifyStatementChain(fixtures.projectId);
  check(
    "editing a frozen line BREAKS the statement chain, naming the period",
    !afterTamper.success &&
      afterTamper.error.type === "STATEMENT_CHAIN_BROKEN" &&
      afterTamper.error.reason === "hash-mismatch",
    !afterTamper.success && afterTamper.error.type === "STATEMENT_CHAIN_BROKEN"
      ? `broke at sequence ${afterTamper.error.sequenceNumber} (${afterTamper.error.reason})`
      : "the chain still verified",
  );

  // --- 9. CORRECTIONS SUPERSEDE; THEY NEVER EDIT (§4f).

  const superseded = await supersedePeriod(
    context,
    openedPeriod.id,
    "Minutes were double counted in the source ledger.",
    fixtures.founderUserId,
    "founder",
    NOW,
  );
  check(
    "a wrong statement is corrected by SUPERSEDING it, never by editing",
    superseded.success && superseded.value.status === "open",
    superseded.success
      ? `replacement period ${superseded.value.sequenceNumber} opened`
      : JSON.stringify(superseded.error),
  );

  const [oldPeriod] = await db
    .select({
      status: compensationPeriod.status,
      successor: compensationPeriod.supersededByPeriodId,
    })
    .from(compensationPeriod)
    .where(eq(compensationPeriod.id, openedPeriod.id));
  check(
    "the superseded statement points at its replacement and stays readable",
    oldPeriod?.status === "superseded" && oldPeriod.successor !== null,
    `${oldPeriod?.status ?? "missing"}, successor ${oldPeriod?.successor === null ? "MISSING" : "set"}`,
  );

  const ensured = await ensurePeriodCovering(fixtures.projectId, NOW);
  check(
    "the close job keeps a period covering today, whatever else happened",
    ensured.accruing.status === "open",
    `accruing period ${ensured.accruing.sequenceNumber}, opened ${ensured.openedPeriodIds.length} more`,
  );

  console.log(
    `\nThe project ${fixtures.projectSlug} is left behind ON PURPOSE, with a deliberately ` +
      "broken statement chain. A finalized period rejects UPDATE and DELETE, so a script " +
      "that could clean up after itself would be one proving the triggers do not work.",
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
