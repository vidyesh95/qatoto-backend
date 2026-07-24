import { and, asc, desc, eq } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  escrowRelease,
  memberFairMarketRate,
  milestone,
  openRoleCompensation,
  projectMember,
  projectOpenRole,
  user,
} from "#src/db/schema.js";

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
 * actually been paid out. Three sources, none of them writable here:
 *
 *   the locked rate      `member_fair_market_rate` (§9) — negotiated, member-accepted
 *   the advertised offer `open_role_compensation` (§5) — the founder's public promise
 *   the actual payouts   approved `escrow_release` rows (§7) — what left the pool
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
  readonly releaseId: string;
  readonly milestoneTitle: string;
  readonly amountInCents: string;
  readonly currency: string;
  readonly paidAt: Date | null;
}

export interface ProjectCompensationView {
  readonly currency: string;
  readonly members: readonly MemberCompensationView[];
  readonly advertised: readonly AdvertisedCompensationView[];
  readonly paidOut: readonly PaidOutCompensationView[];
  readonly totalPaidOutInCents: string;
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

    db
      .select({
        releaseId: escrowRelease.id,
        milestoneTitle: milestone.title,
        amountInCents: escrowRelease.amountInCents,
        currency: escrowRelease.currency,
        paidAt: escrowRelease.decidedAt,
      })
      .from(escrowRelease)
      .innerJoin(milestone, eq(milestone.id, escrowRelease.milestoneId))
      // APPROVED ONLY. A requested release is a request; showing it as compensation would
      // tell a member they have been paid something nobody has approved.
      .where(and(eq(escrowRelease.projectId, projectId), eq(escrowRelease.status, "approved")))
      .orderBy(desc(escrowRelease.decidedAt), desc(escrowRelease.id)),
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

  const totalPaidOutInCents = payoutRows.reduce(
    (runningTotal, payout) => runningTotal + payout.amountInCents,
    0n,
  );

  return {
    currency,
    members,
    advertised: advertisedRows,
    paidOut: payoutRows.map((payout) => ({
      ...payout,
      amountInCents: payout.amountInCents.toString(),
    })),
    totalPaidOutInCents: totalPaidOutInCents.toString(),
  };
}
