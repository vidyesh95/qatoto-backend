import { and, asc, desc, eq, lte, or, isNull, gt } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  memberCashCompensationAgreement,
  memberFairMarketRate,
  projectMember,
  user,
} from "#src/db/schema.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import { appendAuditEntry } from "#src/services/project-audit.service.js";
import type { ProjectAccessError } from "#src/services/project-membership.service.js";
import type { Result } from "#src/types/index.js";

/**
 * What a member is paid in CASH (R_AND_D_BACKEND_STRUCTURE.md §7A.2, §11g).
 *
 * STRUCTURALLY A COPY OF fair-market-rate.service.ts, DELIBERATELY. Same lifecycle
 * (founder proposes → the SUBJECT accepts → the numbers freeze by trigger), same
 * effective-dating, same audit append inside the transaction. A second shape for the same
 * kind of object is how two sources of truth for "what is this person paid" come into
 * existence, and this domain cannot afford one.
 *
 * THE ONE NUMBER THAT LEGITIMATELY ARRIVES IN A BODY, and for the same reason §9's rate
 * does: it is a NEGOTIATED INPUT agreed between two people, not a value the server owns.
 * §0 forbids a body carrying a value the SERVER owns, and the server does not own what two
 * humans agreed to. Everything downstream of it — the gross on a statement line, the
 * proration, the minutes — is server-computed and appears in no body at all.
 *
 * FOUR RULES THIS FILE ENFORCES:
 *
 *  1. A FOUNDER PROPOSES; THE SUBJECT ACCEPTS. Nobody accepts on someone else's behalf,
 *     and nothing prices a statement line until the agreement is `active`. A founder who
 *     both sets and ratifies the number is the founder fiat this product exists to remove.
 *  2. NO RETROACTIVE RE-PRICING. A new agreement takes effect strictly after the newest
 *     ACTIVE one. Without this, a raise silently re-prices months that have already been
 *     drafted — and the bug stays invisible until someone gets a raise.
 *  3. ACCEPTED IS FROZEN. Enforced by `qatoto_cash_agreement_accept_only` (migration
 *     0017), not by this file: a service that declines to write an UPDATE is not the same
 *     claim as "the amount cannot change", because anyone with a psql prompt can step
 *     around a service.
 *  4. THE PIE AND THE PAYSLIP MUST NOT DISAGREE. An hourly agreement is validated against
 *     §9's `member_fair_market_rate.paidCashRateCentsPerHour` AT ACCEPTANCE. That column
 *     exists so the slice math can price the UNPAID portion of an hour; if it says the
 *     member is paid $40/h and this table says $60/h, one of the two is wrong and the
 *     member is either over-credited in equity or under-paid in cash.
 *
 * WHERE THIS DEVIATES FROM §11g's TABLE: `currencyCode` is NOT accepted in the body. §4b
 * is explicit that "there is no `currency` field in any request body — it is derived from
 * the round/project", and `research_project.currency` already holds it. A client-chosen
 * currency on an agreement would let a $6,000 retainer be re-read as ¥6,000.
 */

export type CompensationAgreementStatus =
  (typeof memberCashCompensationAgreement.$inferSelect)["status"];
export type EngagementKind =
  (typeof memberCashCompensationAgreement.$inferSelect)["engagementKind"];

export type CompensationAgreementError =
  | ProjectAccessError
  | { type: "AGREEMENT_NOT_FOUND"; agreementId: string }
  | { type: "AGREEMENT_SUBJECT_NOT_A_MEMBER"; memberUserId: string }
  | { type: "RETROACTIVE_AGREEMENT_CHANGE"; activeEffectiveFrom: Date }
  | { type: "AGREEMENT_EFFECTIVE_FROM_TAKEN"; effectiveFrom: Date }
  | { type: "AGREEMENT_ALREADY_ACCEPTED" }
  | { type: "AGREEMENT_NOT_PROPOSED"; status: CompensationAgreementStatus }
  | { type: "NOT_THE_AGREEMENT_SUBJECT" }
  | {
      type: "HOURLY_RATE_DISAGREES_WITH_PIE";
      agreementCentsPerHour: string;
      paidCashRateCentsPerHour: string;
    };

export interface ProposeAgreementInput {
  readonly engagementKind: EngagementKind;
  /** Exactly one of these two is set — the controller's schema and a CHECK both say so. */
  readonly monthlyAmountInCents: bigint | null;
  readonly hourlyRateCentsPerHour: bigint | null;
  readonly effectiveFrom: Date;
  readonly rationaleNote: string;
}

export interface CompensationAgreementView {
  readonly id: string;
  readonly memberId: string;
  readonly memberUserId: string;
  readonly memberName: string;
  readonly engagementKind: EngagementKind;
  /**
   * Money crosses the wire as a decimal STRING, never a JS number: a `bigint` cent value
   * past 2^53 loses precision the moment `JSON.stringify` touches it (§4b).
   */
  readonly monthlyAmountInCents: string | null;
  readonly hourlyRateCentsPerHour: string | null;
  readonly currencyCode: string;
  readonly status: CompensationAgreementStatus;
  readonly effectiveFrom: Date;
  readonly effectiveUntil: Date | null;
  readonly rationaleNote: string;
  readonly proposedByUserId: string;
  readonly acceptedAt: Date | null;
  readonly createdAt: Date;
}

type AgreementRow = typeof memberCashCompensationAgreement.$inferSelect;
type MemberIdentity = { readonly memberId: string; readonly userId: string; readonly name: string };

function toAgreementView(row: AgreementRow, member: MemberIdentity): CompensationAgreementView {
  return {
    id: row.id,
    memberId: row.memberId,
    memberUserId: member.userId,
    memberName: member.name,
    engagementKind: row.engagementKind,
    monthlyAmountInCents: row.monthlyAmountInCents?.toString() ?? null,
    hourlyRateCentsPerHour: row.hourlyRateCentsPerHour?.toString() ?? null,
    currencyCode: row.currencyCode,
    status: row.status,
    effectiveFrom: row.effectiveFrom,
    effectiveUntil: row.effectiveUntil,
    rationaleNote: row.rationaleNote,
    proposedByUserId: row.proposedByUserId,
    acceptedAt: row.acceptedAt,
    createdAt: row.createdAt,
  };
}

/** Resolves the target member from the PUBLIC user id used in the URL. */
async function findActiveMemberByUserId(
  projectId: string,
  memberUserId: string,
): Promise<MemberIdentity | null> {
  const [row] = await db
    .select({ memberId: projectMember.id, userId: projectMember.userId, name: user.name })
    .from(projectMember)
    .innerJoin(user, eq(user.id, projectMember.userId))
    .where(
      and(
        eq(projectMember.projectId, projectId),
        eq(projectMember.userId, memberUserId),
        // A departed member's historical agreements stay readable — the statements they
        // priced are still in the record — but a NEW one cannot be proposed for someone
        // who is no longer accruing.
        eq(projectMember.status, "active"),
      ),
    );

  return row ?? null;
}

/**
 * `POST …/members/:memberUserId/compensation-agreement` — founder only.
 *
 * Rejects an agreement whose `effectiveFrom` is not strictly after the newest ACTIVE one.
 * Compared against the active one only: an unaccepted proposal prices nothing, so
 * superseding it with a better-dated offer is a normal part of negotiating.
 */
export async function proposeCashAgreement(
  context: { readonly projectId: string; readonly currency: string },
  memberUserId: string,
  proposedByUserId: string,
  actorRoleSnapshot: string,
  input: ProposeAgreementInput,
): Promise<Result<CompensationAgreementView, CompensationAgreementError>> {
  const member = await findActiveMemberByUserId(context.projectId, memberUserId);
  if (!member) {
    return { success: false, error: { type: "AGREEMENT_SUBJECT_NOT_A_MEMBER", memberUserId } };
  }

  const [newestActive] = await db
    .select({ effectiveFrom: memberCashCompensationAgreement.effectiveFrom })
    .from(memberCashCompensationAgreement)
    .where(
      and(
        eq(memberCashCompensationAgreement.memberId, member.memberId),
        eq(memberCashCompensationAgreement.status, "active"),
      ),
    )
    .orderBy(desc(memberCashCompensationAgreement.effectiveFrom))
    .limit(1);

  if (newestActive && input.effectiveFrom <= newestActive.effectiveFrom) {
    return {
      success: false,
      error: {
        type: "RETROACTIVE_AGREEMENT_CHANGE",
        activeEffectiveFrom: newestActive.effectiveFrom,
      },
    };
  }

  try {
    const created = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(memberCashCompensationAgreement)
        .values({
          projectId: context.projectId,
          memberId: member.memberId,
          engagementKind: input.engagementKind,
          monthlyAmountInCents: input.monthlyAmountInCents,
          hourlyRateCentsPerHour: input.hourlyRateCentsPerHour,
          // SERVER-DERIVED from the project, never from the body (§4b).
          currencyCode: context.currency,
          status: "proposed",
          effectiveFrom: input.effectiveFrom,
          rationaleNote: input.rationaleNote,
          proposedByUserId,
        })
        .returning();

      if (!inserted) {
        throw new Error("proposeCashAgreement: insert returned no row");
      }

      await appendAuditEntry(tx, {
        projectId: context.projectId,
        eventKind: "compensation_agreement_proposed",
        actorUserId: proposedByUserId,
        actorRoleSnapshot,
        actionLabel: "Proposed a cash compensation agreement",
        targetLabel: `agreement ${inserted.id}`,
        detailNote: input.rationaleNote,
        payload: {
          agreementId: inserted.id,
          memberId: member.memberId,
          engagementKind: input.engagementKind,
          monthlyAmountInCents: input.monthlyAmountInCents,
          hourlyRateCentsPerHour: input.hourlyRateCentsPerHour,
          currencyCode: context.currency,
          effectiveFrom: input.effectiveFrom,
        },
        occurredAt: inserted.createdAt,
      });

      return inserted;
    });

    return { success: true, value: toAgreementView(created, member) };
  } catch (error: unknown) {
    // The (member_id, effective_from) unique. Two agreements claiming the same instant
    // make "what is this person paid" ambiguous, and an ambiguous agreement silently
    // re-prices a month.
    if (isUniqueViolation(error)) {
      return {
        success: false,
        error: { type: "AGREEMENT_EFFECTIVE_FROM_TAKEN", effectiveFrom: input.effectiveFrom },
      };
    }
    throw error;
  }
}

/**
 * The locked §9 rate in force for a member at an instant, if there is one.
 *
 * Read at acceptance to enforce rule 4. Returns null when nothing is locked yet, which is
 * NOT a failure: a project may agree what it pays someone in cash long before it locks a
 * fair market rate for the equity side, and refusing the agreement for that would gate
 * cash on an equity artifact — the exact coupling §0's first added rule forbids.
 */
async function findLockedPaidCashRate(memberId: string, at: Date): Promise<bigint | null> {
  const [row] = await db
    .select({ paidCashRateCentsPerHour: memberFairMarketRate.paidCashRateCentsPerHour })
    .from(memberFairMarketRate)
    .where(
      and(
        eq(memberFairMarketRate.memberId, memberId),
        eq(memberFairMarketRate.status, "locked"),
        lte(memberFairMarketRate.effectiveFrom, at),
      ),
    )
    // Ends in a unique column so a recompute a year later resolves the same row.
    .orderBy(desc(memberFairMarketRate.effectiveFrom), desc(memberFairMarketRate.id))
    .limit(1);

  return row?.paidCashRateCentsPerHour ?? null;
}

/**
 * `POST …/compensation-agreements/:agreementId/accept` — THE SUBJECT ONLY.
 *
 * Three things happen in one transaction, and the middle one is easy to miss: the newly
 * accepted agreement becomes `active`, ANY previously active agreement for the same member
 * is closed off at the new one's `effectiveFrom` and marked `superseded`, and an audit
 * entry is appended. Without the middle step the partial unique index rejects the write —
 * which is the index doing its job, but the correct resolution is to close the old
 * interval rather than to refuse the new agreement.
 */
export async function acceptCashAgreement(
  context: { readonly projectId: string },
  agreementId: string,
  acceptingUserId: string,
  actorRoleSnapshot: string,
): Promise<Result<CompensationAgreementView, CompensationAgreementError>> {
  const [row] = await db
    .select({
      agreement: memberCashCompensationAgreement,
      memberUserId: projectMember.userId,
      name: user.name,
    })
    .from(memberCashCompensationAgreement)
    .innerJoin(projectMember, eq(projectMember.id, memberCashCompensationAgreement.memberId))
    .innerJoin(user, eq(user.id, projectMember.userId))
    .where(
      // BOTH columns: an agreement id from another project must be indistinguishable from
      // a nonexistent one, or this becomes a cross-tenant probe.
      and(
        eq(memberCashCompensationAgreement.id, agreementId),
        eq(memberCashCompensationAgreement.projectId, context.projectId),
      ),
    );

  if (!row) {
    return { success: false, error: { type: "AGREEMENT_NOT_FOUND", agreementId } };
  }
  if (row.memberUserId !== acceptingUserId) {
    return { success: false, error: { type: "NOT_THE_AGREEMENT_SUBJECT" } };
  }
  if (row.agreement.status === "active" || row.agreement.status === "superseded") {
    return { success: false, error: { type: "AGREEMENT_ALREADY_ACCEPTED" } };
  }
  if (row.agreement.status !== "proposed") {
    return {
      success: false,
      error: { type: "AGREEMENT_NOT_PROPOSED", status: row.agreement.status },
    };
  }

  // RULE 4. An hourly agreement must agree with §9's view of what this member is paid per
  // hour, or the pie and the payslip are pricing two different people.
  const hourlyRate = row.agreement.hourlyRateCentsPerHour;
  if (hourlyRate !== null) {
    const paidCashRate = await findLockedPaidCashRate(
      row.agreement.memberId,
      row.agreement.effectiveFrom,
    );
    if (paidCashRate !== null && paidCashRate !== hourlyRate) {
      return {
        success: false,
        error: {
          type: "HOURLY_RATE_DISAGREES_WITH_PIE",
          agreementCentsPerHour: hourlyRate.toString(),
          paidCashRateCentsPerHour: paidCashRate.toString(),
        },
      };
    }
  }

  const updated = await db.transaction(async (tx) => {
    const acceptedAt = new Date();

    // Close the outgoing agreement's open interval FIRST. `effectiveUntil` is exclusive,
    // so setting it to the incoming agreement's `effectiveFrom` leaves no gap and no
    // overlap: `coveredDaysInPeriod` reads the two as one continuous coverage.
    await tx
      .update(memberCashCompensationAgreement)
      .set({ status: "superseded", effectiveUntil: row.agreement.effectiveFrom })
      .where(
        and(
          eq(memberCashCompensationAgreement.memberId, row.agreement.memberId),
          eq(memberCashCompensationAgreement.status, "active"),
        ),
      );

    const [next] = await tx
      .update(memberCashCompensationAgreement)
      .set({ status: "active", acceptedAt, acceptedByUserId: acceptingUserId })
      .where(
        // Re-asserted inside the transaction: a concurrent accept may have landed between
        // the read above and this write, and the partial unique index would then reject
        // with a 500 rather than a 409.
        and(
          eq(memberCashCompensationAgreement.id, agreementId),
          eq(memberCashCompensationAgreement.status, "proposed"),
        ),
      )
      .returning();

    if (!next) {
      return null;
    }

    await appendAuditEntry(tx, {
      projectId: context.projectId,
      eventKind: "compensation_agreement_accepted",
      actorUserId: acceptingUserId,
      actorRoleSnapshot,
      actionLabel: "Accepted their cash compensation agreement",
      targetLabel: `agreement ${agreementId}`,
      payload: {
        agreementId,
        memberId: next.memberId,
        engagementKind: next.engagementKind,
        monthlyAmountInCents: next.monthlyAmountInCents,
        hourlyRateCentsPerHour: next.hourlyRateCentsPerHour,
        currencyCode: next.currencyCode,
        effectiveFrom: next.effectiveFrom,
      },
      occurredAt: acceptedAt,
    });

    return next;
  });

  if (!updated) {
    return { success: false, error: { type: "AGREEMENT_ALREADY_ACCEPTED" } };
  }

  return {
    success: true,
    value: toAgreementView(updated, {
      memberId: updated.memberId,
      userId: row.memberUserId,
      name: row.name,
    }),
  };
}

/**
 * `GET …/compensation-agreements` — the FULL effective-dated history.
 *
 * This read IS the transparency promise, the same way §9's rate history is: every member
 * sees every agreement, including superseded and withdrawn proposals. A history only the
 * founder can see is not transparency, it is a filing cabinet.
 */
export async function listAgreementHistory(
  projectId: string,
  memberUserId?: string,
): Promise<Result<readonly CompensationAgreementView[], CompensationAgreementError>> {
  const memberFilters = [eq(projectMember.projectId, projectId)];
  if (memberUserId !== undefined) {
    memberFilters.push(eq(projectMember.userId, memberUserId));
  }

  const rows = await db
    .select({
      agreement: memberCashCompensationAgreement,
      memberUserId: projectMember.userId,
      name: user.name,
    })
    .from(memberCashCompensationAgreement)
    // No membership status filter: a departed member's history stays readable, because the
    // statements it priced are still in the record.
    .innerJoin(projectMember, eq(projectMember.id, memberCashCompensationAgreement.memberId))
    .innerJoin(user, eq(user.id, projectMember.userId))
    .where(and(eq(memberCashCompensationAgreement.projectId, projectId), ...memberFilters))
    // Newest first, ending in a unique column so two agreements sharing an instant never
    // swap places between reads (§4c rule 4).
    .orderBy(
      desc(memberCashCompensationAgreement.effectiveFrom),
      desc(memberCashCompensationAgreement.id),
    );

  if (memberUserId !== undefined && rows.length === 0) {
    const member = await findActiveMemberByUserId(projectId, memberUserId);
    if (!member) {
      return { success: false, error: { type: "AGREEMENT_SUBJECT_NOT_A_MEMBER", memberUserId } };
    }
  }

  return {
    success: true,
    value: rows.map((row) =>
      toAgreementView(row.agreement, {
        memberId: row.agreement.memberId,
        userId: row.memberUserId,
        name: row.name,
      }),
    ),
  };
}

export interface EffectiveAgreement {
  readonly agreementId: string;
  readonly engagementKind: EngagementKind;
  readonly monthlyAmountInCents: bigint | null;
  readonly hourlyRateCentsPerHour: bigint | null;
  readonly currencyCode: string;
  readonly effectiveFrom: Date;
  readonly effectiveUntil: Date | null;
}

/**
 * Every agreement that overlapped `[windowStart, windowEnd)` for one member — the draft's
 * entry point into this table, and the reason effective-dating exists at all.
 *
 * RETURNS A LIST, NOT ONE ROW, and that is the whole subtlety of proration: a member whose
 * retainer changed mid-month is owed part of the old amount and part of the new one. A
 * single "the agreement in force" lookup would silently price the whole month at whichever
 * one the query happened to pick.
 *
 * `active` and `superseded` only. A `proposed` agreement prices nothing — the member has
 * not agreed to it — and a `withdrawn` one never did.
 */
export async function listAgreementsOverlapping(
  memberId: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<readonly EffectiveAgreement[]> {
  const rows = await db
    .select()
    .from(memberCashCompensationAgreement)
    .where(
      and(
        eq(memberCashCompensationAgreement.memberId, memberId),
        or(
          eq(memberCashCompensationAgreement.status, "active"),
          eq(memberCashCompensationAgreement.status, "superseded"),
        ),
        // Overlap, in the standard half-open form: it began before the window ended AND
        // it had not already ended when the window began.
        lte(memberCashCompensationAgreement.effectiveFrom, windowEnd),
        or(
          isNull(memberCashCompensationAgreement.effectiveUntil),
          gt(memberCashCompensationAgreement.effectiveUntil, windowStart),
        ),
      ),
    )
    // Ends in a unique column, so a redraw a year later reads them in the same order and
    // produces byte-identical lines (§4c rule 4).
    .orderBy(
      asc(memberCashCompensationAgreement.effectiveFrom),
      asc(memberCashCompensationAgreement.id),
    );

  return rows.map((row) => ({
    agreementId: row.id,
    engagementKind: row.engagementKind,
    monthlyAmountInCents: row.monthlyAmountInCents,
    hourlyRateCentsPerHour: row.hourlyRateCentsPerHour,
    currencyCode: row.currencyCode,
    effectiveFrom: row.effectiveFrom,
    effectiveUntil: row.effectiveUntil,
  }));
}
