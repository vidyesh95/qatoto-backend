import { and, asc, desc, eq } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  memberFairMarketRate,
  openRoleCompensation,
  projectMember,
  projectOpenRole,
  user,
} from "#src/db/schema.js";
import { listProjectPayments } from "#src/services/compensation-payments.service.js";

/**
 * `GET …/compensation` (R_AND_D_BACKEND_STRUCTURE.md §7, §11c).
 *
 * ---------------------------------------------------------------------------
 * THERE IS NO `project_member_compensation_rate` TABLE, AND THAT IS DELIBERATE.
 *
 * §7's "Remaining tables" list names one, described as "the locked fair-market rate that
 * §9's slice math depends on … effective-dated and requires the member's acceptance". §9
 * ALREADY SHIPPED exactly that table under a different name: `member_fair_market_rate`,
 * effective-dated, member-accepted, with a hand-written trigger in migration 0014 freezing
 * the numbers at acceptance and everything at lock.
 *
 * Building a second effective-dated rate table would put two answers to "what is this
 * member paid" in one database, with §9's slice math reading only one of them. That is a
 * drift source in the highest-stakes surface in the product, introduced to satisfy a name.
 *
 * So this file READS §9's table, and §11c's `PUT …/members/:id/compensation-rate` and
 * `POST …/compensation-rate/accept` are superseded by §9's shipped
 * `POST …/members/:memberUserId/fair-market-rate` and `…/accept`, which already do the
 * job and already have the trigger behind them.
 * ---------------------------------------------------------------------------
 *
 * WHAT THIS ENDPOINT ACTUALLY ANSWERS: what has each member been promised, and what has
 * actually been paid. Three sources, none of them writable here:
 *
 *   the locked rate      `member_fair_market_rate` (§9) — negotiated, member-accepted
 *   the advertised offer `open_role_compensation` (§5) — the founder's public promise
 *   the actual payments  `compensation_payment_record` (§7A) — attested and confirmed
 *
 * THE THIRD SOURCE CHANGED, AND THE CHANGE IS THE POINT. It used to read approved
 * `escrow_release` rows — "what left the pool". There is no pool: Qatoto holds no funds
 * (§7A.6 item 1), and escrow left this domain because custody is regulated in all three
 * target jurisdictions whether or not a fee is charged, and because an escrow release had
 * become the gate on cash compensation, which made a wage conditional on an algorithmic
 * verdict.
 *
 * So "paid" now means what it says on a payslip: the founder paid from their own bank and
 * BOTH SIDES recorded it. `confirmedByMemberAt` travels with every row precisely so a
 * client can render an unconfirmed payment as unconfirmed — a payment nobody has
 * acknowledged receiving is one party's claim, not a record (§7A).
 */

export interface MemberCompensationRateView {
  readonly rateId: string;
  readonly fairMarketRateCentsPerHour: string;
  readonly paidCashRateCentsPerHour: string;
  readonly currencyCode: string;
  readonly status: (typeof memberFairMarketRate.$inferSelect)["status"];
  readonly effectiveFrom: Date;
  readonly acceptedAt: Date | null;
  readonly lockedAt: Date | null;
}

export interface MemberCompensationView {
  readonly memberId: string;
  readonly userId: string;
  readonly name: string;
  readonly projectRole: (typeof projectMember.$inferSelect)["projectRole"];
  readonly roleTitle: string | null;
  /**
   * The rate in force. NULL when nothing is locked yet — and that is load-bearing, not a
   * gap: §9 refuses to price effort without a locked rate (`409 RATE_NOT_LOCKED`), so
   * rendering a proposed rate here as though it were binding would contradict the endpoint
   * that actually enforces it.
   */
  readonly lockedRate: MemberCompensationRateView | null;
  /** The full effective-dated history, newest first. Read-only. */
  readonly rateHistory: readonly MemberCompensationRateView[];
}

export interface AdvertisedCompensationView {
  readonly openRoleId: string;
  readonly roleTitle: string;
  readonly kind: (typeof openRoleCompensation.$inferSelect)["kind"];
  readonly salaryMinInCentsPerMonth: number | null;
  readonly salaryMaxInCentsPerMonth: number | null;
  readonly oneTimeMinInCents: number | null;
  readonly oneTimeMaxInCents: number | null;
  readonly equityBasisPointsMin: number | null;
  readonly equityBasisPointsMax: number | null;
  /**
   * The ENUM, never the free prose the mock shipped as `earnedAsLabel` (§4d). Shipping
   * English sentences from the server forces three native clients to render
   * un-localizable strings, and lets a founder write a payout promise the escrow engine
   * will not honour.
   */
  readonly earnedAsPolicy: (typeof openRoleCompensation.$inferSelect)["earnedAsPolicy"];
}

export interface PaidOutCompensationView {
  readonly paymentId: string;
  readonly memberUserId: string;
  readonly memberName: string;
  /** Which statement line this settled — `cash_retainer` or `cash_hourly`. */
  readonly lineKind: string;
  readonly periodStartDate: string;
  readonly amountInCents: string;
  readonly currency: string;
  /** The calendar day the payer says the money left. Never an invented instant. */
  readonly paidOnDate: string;
  readonly methodKey: string;
  /**
   * NULL until the member confirms receipt. **A client rendering an unconfirmed payment
   * as "paid" is telling someone they were paid on one party's word alone** (§7A).
   */
  readonly confirmedByMemberAt: Date | null;
}

export interface ProjectCompensationView {
  readonly currency: string;
  readonly members: readonly MemberCompensationView[];
  readonly advertised: readonly AdvertisedCompensationView[];
  readonly paidOut: readonly PaidOutCompensationView[];
  /** Every attested payment, confirmed or not. */
  readonly totalPaidOutInCents: string;
  /**
   * The subtotal both sides agree on. Returned separately rather than as the only total,
   * because the gap between the two IS the thing worth showing: it is exactly the money a
   * founder says they sent and nobody has said they received.
   */
  readonly totalConfirmedPaidInCents: string;
}

function toRateView(row: typeof memberFairMarketRate.$inferSelect): MemberCompensationRateView {
  return {
    rateId: row.id,
    // Every bigint crosses the wire as a decimal string (§4b).
    fairMarketRateCentsPerHour: row.fairMarketRateCentsPerHour.toString(),
    paidCashRateCentsPerHour: row.paidCashRateCentsPerHour.toString(),
    currencyCode: row.currencyCode,
    status: row.status,
    effectiveFrom: row.effectiveFrom,
    acceptedAt: row.acceptedAt,
    lockedAt: row.lockedAt,
  };
}

/** `GET …/compensation` — promised, locked and paid, in one round trip. */
export async function getProjectCompensation(
  projectId: string,
  currency: string,
): Promise<ProjectCompensationView> {
  const [memberRows, rateRows, advertisedRows, payoutRows] = await Promise.all([
    db
      .select({
        memberId: projectMember.id,
        userId: projectMember.userId,
        name: user.name,
        projectRole: projectMember.projectRole,
        roleTitle: projectMember.roleTitle,
      })
      .from(projectMember)
      .innerJoin(user, eq(user.id, projectMember.userId))
      .where(and(eq(projectMember.projectId, projectId), eq(projectMember.status, "active")))
      // §4c rule 4: the ordering ends in a unique column, or two members who joined in the
      // same millisecond swap places between reads.
      .orderBy(asc(projectMember.joinedAt), asc(projectMember.id)),

    db
      .select()
      .from(memberFairMarketRate)
      .where(eq(memberFairMarketRate.projectId, projectId))
      .orderBy(desc(memberFairMarketRate.effectiveFrom), desc(memberFairMarketRate.id)),

    db
      .select({
        openRoleId: projectOpenRole.id,
        roleTitle: projectOpenRole.roleTitle,
        kind: openRoleCompensation.kind,
        salaryMinInCentsPerMonth: openRoleCompensation.salaryMinInCentsPerMonth,
        salaryMaxInCentsPerMonth: openRoleCompensation.salaryMaxInCentsPerMonth,
        oneTimeMinInCents: openRoleCompensation.oneTimeMinInCents,
        oneTimeMaxInCents: openRoleCompensation.oneTimeMaxInCents,
        equityBasisPointsMin: openRoleCompensation.equityBasisPointsMin,
        equityBasisPointsMax: openRoleCompensation.equityBasisPointsMax,
        earnedAsPolicy: openRoleCompensation.earnedAsPolicy,
      })
      .from(openRoleCompensation)
      .innerJoin(projectOpenRole, eq(projectOpenRole.id, openRoleCompensation.openRoleId))
      .where(eq(projectOpenRole.projectId, projectId))
      .orderBy(asc(projectOpenRole.id), asc(openRoleCompensation.id)),

    // Every attested payment, confirmed or not. Deliberately NOT filtered to confirmed:
    // hiding an unconfirmed payment would leave a founder unable to see what they have
    // already recorded, and they would record it twice.
    listProjectPayments(projectId),
  ]);

  const ratesByMember = new Map<string, (typeof memberFairMarketRate.$inferSelect)[]>();
  for (const rate of rateRows) {
    const bucket = ratesByMember.get(rate.memberId);
    if (bucket) {
      bucket.push(rate);
    } else {
      ratesByMember.set(rate.memberId, [rate]);
    }
  }

  const members = memberRows.map((member) => {
    const history = ratesByMember.get(member.memberId) ?? [];
    // The rates arrive newest-effective first, so the first LOCKED one is the one in
    // force. Anything merely `proposed` or `accepted` is not binding — §9 refuses to price
    // effort against it, and so does this read.
    const locked = history.find((rate) => rate.status === "locked");

    return {
      memberId: member.memberId,
      userId: member.userId,
      name: member.name,
      projectRole: member.projectRole,
      roleTitle: member.roleTitle,
      lockedRate: locked ? toRateView(locked) : null,
      rateHistory: history.map(toRateView),
    };
  });

  // Summed as `bigint`, never as a JS number: a project's lifetime payments can exceed
  // 2^53 cents in a currency with a small unit, and the moment one of these becomes a
  // float the total is silently wrong (§4b).
  let totalPaidOutInCents = 0n;
  let totalConfirmedPaidInCents = 0n;
  for (const payment of payoutRows) {
    const amount = BigInt(payment.paidAmountInCents);
    totalPaidOutInCents += amount;
    if (payment.confirmedByMemberAt !== null) {
      totalConfirmedPaidInCents += amount;
    }
  }

  return {
    currency,
    members,
    advertised: advertisedRows,
    paidOut: payoutRows.map((payment) => ({
      paymentId: payment.id,
      memberUserId: payment.memberUserId,
      memberName: payment.memberName,
      lineKind: payment.lineKind,
      periodStartDate: payment.periodStartDate,
      amountInCents: payment.paidAmountInCents,
      currency: payment.currency,
      paidOnDate: payment.paidOnDate,
      methodKey: payment.methodKey,
      confirmedByMemberAt: payment.confirmedByMemberAt,
    })),
    totalPaidOutInCents: totalPaidOutInCents.toString(),
    totalConfirmedPaidInCents: totalConfirmedPaidInCents.toString(),
  };
}
