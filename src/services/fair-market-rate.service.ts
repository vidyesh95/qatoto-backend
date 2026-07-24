import { and, asc, desc, eq, lte } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { memberFairMarketRate, pieBakeEvent, projectMember, user } from "#src/db/schema.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import { unpaidRateCentsPerHour } from "#src/lib/slice-math.js";
import { appendAuditEntry } from "#src/services/project-audit.service.js";
import type { ProjectAccessError } from "#src/services/project-membership.service.js";
import type { Result } from "#src/types/index.js";

/**
 * The negotiated fair market rate (R_AND_D_BACKEND_STRUCTURE.md §9.6, §11e).
 *
 * THE MOST IMPORTANT TABLE IN THE DOMAIN, and the one place in the whole of §9 where a
 * number legitimately arrives in a request body. That is not a hole in §0 — it is §0's
 * own stated exception: the rate is a NEGOTIATED INPUT, agreed between two people, in the
 * same category as a founder's advertised equity band. What §0 forbids is a body carrying
 * a value the SERVER owns, and the server does not own what two humans agreed to.
 *
 * Everything downstream of it is server-owned and appears in no body: the unpaid portion,
 * the slice numerator, the slice count, the basis points.
 *
 * FOUR RULES THIS FILE ENFORCES:
 *
 *  1. A RATE IS PROPOSED BY THE FOUNDER, ACCEPTED BY ITS SUBJECT, THEN LOCKED. Nobody can
 *     accept their own proposal on someone else's behalf, and nothing prices effort until
 *     the lock. §13 says "a member-accepted fair market rate", and acceptance is what
 *     makes that phrase true rather than decorative.
 *  2. NO RETROACTIVE RE-PRICING. A new rate must take effect strictly after the newest
 *     locked one. Without this, a raise silently re-prices two years of logged effort —
 *     the founder-tweaks-the-spreadsheet failure mode SPEC §2 exists to prevent, and the
 *     bug stays invisible until someone gets a raise.
 *  3. LOCKED IS FOREVER. Enforced by a trigger, not by this file — §9.1's claim is
 *     "including a DBA", and a service that declines to write an UPDATE is not that.
 *  4. EVERY TRANSITION APPENDS TO THE HASH CHAIN, in the same transaction (§9.9).
 *
 * WHERE THIS DELIBERATELY DEVIATES FROM §11e's TABLE: `currencyCode` is NOT accepted in
 * the body. §4b is explicit that "there is no `currency` field in any request body — it is
 * derived from the round/project", and `research_project.currency` already holds it. A
 * client-chosen currency on a rate would let a $120/h rate be re-read as ¥120/h.
 */

export type FairMarketRateStatus = (typeof memberFairMarketRate.$inferSelect)["status"];

export type FairMarketRateError =
  | ProjectAccessError
  | { type: "RATE_NOT_FOUND"; rateId: string }
  | { type: "RATE_SUBJECT_NOT_A_MEMBER"; memberUserId: string }
  | { type: "RETROACTIVE_RATE_CHANGE"; lockedEffectiveFrom: Date }
  | { type: "RATE_EFFECTIVE_FROM_TAKEN"; effectiveFrom: Date }
  | { type: "RATE_ALREADY_LOCKED" }
  | { type: "RATE_NOT_ACCEPTED" }
  | { type: "RATE_ALREADY_ACCEPTED" }
  | { type: "NOT_THE_RATE_SUBJECT" }
  | { type: "ACKNOWLEDGEMENT_MISMATCH"; expected: string }
  | { type: "PIE_ALREADY_BAKED" };

/** The typed phrase `POST …/fair-market-rate/lock` requires. Compared byte-for-byte. */
export const RATE_LOCK_ACKNOWLEDGEMENT = "LOCK THIS RATE";

export interface ProposeRateInput {
  readonly fairMarketRateCentsPerHour: bigint;
  readonly paidCashRateCentsPerHour: bigint;
  readonly effectiveFrom: Date;
  readonly rationaleNote: string;
}

export interface FairMarketRateView {
  readonly id: string;
  readonly memberId: string;
  readonly memberUserId: string;
  readonly memberName: string;
  readonly fairMarketRateCentsPerHour: string;
  readonly paidCashRateCentsPerHour: string;
  /**
   * The number the ledger actually prices, returned so nobody has to re-derive it and get
   * the subtraction backwards. Computed on read (§9.2) — there is no column.
   */
  readonly unpaidRateCentsPerHour: string;
  readonly currencyCode: string;
  readonly status: FairMarketRateStatus;
  readonly effectiveFrom: Date;
  readonly rationaleNote: string;
  readonly proposedByUserId: string;
  readonly acceptedAt: Date | null;
  readonly lockedAt: Date | null;
  readonly createdAt: Date;
}

type RateRow = typeof memberFairMarketRate.$inferSelect;

function toRateView(
  rate: RateRow,
  member: { readonly userId: string; readonly name: string },
): FairMarketRateView {
  return {
    id: rate.id,
    memberId: rate.memberId,
    memberUserId: member.userId,
    memberName: member.name,
    // Money crosses the wire as a decimal STRING, never a JS number: a `bigint` cent
    // value past 2^53 loses precision the moment JSON.stringify touches it (§4b).
    fairMarketRateCentsPerHour: rate.fairMarketRateCentsPerHour.toString(),
    paidCashRateCentsPerHour: rate.paidCashRateCentsPerHour.toString(),
    unpaidRateCentsPerHour: unpaidRateCentsPerHour(
      Number(rate.fairMarketRateCentsPerHour),
      Number(rate.paidCashRateCentsPerHour),
    ).toString(),
    currencyCode: rate.currencyCode,
    status: rate.status,
    effectiveFrom: rate.effectiveFrom,
    rationaleNote: rate.rationaleNote,
    proposedByUserId: rate.proposedByUserId,
    acceptedAt: rate.acceptedAt,
    lockedAt: rate.lockedAt,
    createdAt: rate.createdAt,
  };
}

/** Resolves the target member from the PUBLIC user id used in the URL. */
async function findMemberByUserId(
  projectId: string,
  memberUserId: string,
): Promise<{ readonly memberId: string; readonly userId: string; readonly name: string } | null> {
  const [row] = await db
    .select({ memberId: projectMember.id, userId: projectMember.userId, name: user.name })
    .from(projectMember)
    .innerJoin(user, eq(user.id, projectMember.userId))
    .where(
      and(
        eq(projectMember.projectId, projectId),
        eq(projectMember.userId, memberUserId),
        // A departed member's historical rates stay readable, but a NEW rate cannot be
        // proposed for someone who is not accruing.
        eq(projectMember.status, "active"),
      ),
    );

  return row ?? null;
}

async function isPieBaked(projectId: string): Promise<boolean> {
  const [baked] = await db
    .select({ id: pieBakeEvent.id })
    .from(pieBakeEvent)
    .where(eq(pieBakeEvent.projectId, projectId));
  return baked !== undefined;
}

/**
 * `POST …/members/:memberUserId/fair-market-rate` — founder only.
 *
 * Rejects a rate whose `effectiveFrom` is not strictly after the newest LOCKED rate.
 * Deliberately compared against the locked one only: an unlocked proposal prices nothing,
 * so superseding it with a better-dated offer is a normal part of negotiating.
 */
export async function proposeFairMarketRate(
  context: { readonly projectId: string; readonly currency: string },
  memberUserId: string,
  proposedByUserId: string,
  actorRoleSnapshot: string,
  input: ProposeRateInput,
): Promise<Result<FairMarketRateView, FairMarketRateError>> {
  if (await isPieBaked(context.projectId)) {
    return { success: false, error: { type: "PIE_ALREADY_BAKED" } };
  }

  const member = await findMemberByUserId(context.projectId, memberUserId);
  if (!member) {
    return { success: false, error: { type: "RATE_SUBJECT_NOT_A_MEMBER", memberUserId } };
  }

  const [newestLocked] = await db
    .select({ effectiveFrom: memberFairMarketRate.effectiveFrom })
    .from(memberFairMarketRate)
    .where(
      and(
        eq(memberFairMarketRate.memberId, member.memberId),
        eq(memberFairMarketRate.status, "locked"),
      ),
    )
    .orderBy(desc(memberFairMarketRate.effectiveFrom))
    .limit(1);

  if (newestLocked && input.effectiveFrom <= newestLocked.effectiveFrom) {
    return {
      success: false,
      error: { type: "RETROACTIVE_RATE_CHANGE", lockedEffectiveFrom: newestLocked.effectiveFrom },
    };
  }

  try {
    const created = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(memberFairMarketRate)
        .values({
          projectId: context.projectId,
          memberId: member.memberId,
          fairMarketRateCentsPerHour: input.fairMarketRateCentsPerHour,
          paidCashRateCentsPerHour: input.paidCashRateCentsPerHour,
          // SERVER-DERIVED from the project, never from the body (§4b).
          currencyCode: context.currency,
          status: "proposed",
          effectiveFrom: input.effectiveFrom,
          rationaleNote: input.rationaleNote,
          proposedByUserId,
        })
        .returning();

      if (!inserted) {
        throw new Error("proposeFairMarketRate: insert returned no row");
      }

      await appendAuditEntry(tx, {
        projectId: context.projectId,
        eventKind: "rate_proposed",
        actorUserId: proposedByUserId,
        actorRoleSnapshot,
        actionLabel: "Proposed a fair market rate",
        targetLabel: `rate ${inserted.id}`,
        detailNote: input.rationaleNote,
        payload: {
          rateId: inserted.id,
          memberId: member.memberId,
          fairMarketRateCentsPerHour: input.fairMarketRateCentsPerHour,
          paidCashRateCentsPerHour: input.paidCashRateCentsPerHour,
          currencyCode: context.currency,
          effectiveFrom: input.effectiveFrom,
        },
        occurredAt: inserted.createdAt,
      });

      return inserted;
    });

    return { success: true, value: toRateView(created, member) };
  } catch (error: unknown) {
    // The (member_id, effective_from) unique. Two rates claiming the same instant make
    // "the rate in force" ambiguous, and an ambiguous rate silently re-prices a claim.
    if (isUniqueViolation(error)) {
      return {
        success: false,
        error: { type: "RATE_EFFECTIVE_FROM_TAKEN", effectiveFrom: input.effectiveFrom },
      };
    }
    throw error;
  }
}

/**
 * `POST …/members/:memberUserId/fair-market-rate/:rateId/accept` — the SUBJECT only.
 *
 * NOT IN §11e's TABLE, and added because the schema's lifecycle cannot complete without
 * it: a rate must be `accepted` before it can be `locked`, and §13 describes the
 * exception §0 grants as "a member-ACCEPTED fair market rate". Without an accept step the
 * founder both sets and ratifies the number, which is precisely the founder fiat this
 * product exists to remove.
 */
export async function acceptFairMarketRate(
  context: { readonly projectId: string },
  rateId: string,
  acceptingUserId: string,
  actorRoleSnapshot: string,
): Promise<Result<FairMarketRateView, FairMarketRateError>> {
  const [row] = await db
    .select({ rate: memberFairMarketRate, memberUserId: projectMember.userId, name: user.name })
    .from(memberFairMarketRate)
    .innerJoin(projectMember, eq(projectMember.id, memberFairMarketRate.memberId))
    .innerJoin(user, eq(user.id, projectMember.userId))
    .where(
      // BOTH columns: a rate id from another project must be indistinguishable from a
      // nonexistent one.
      and(
        eq(memberFairMarketRate.id, rateId),
        eq(memberFairMarketRate.projectId, context.projectId),
      ),
    );

  if (!row) {
    return { success: false, error: { type: "RATE_NOT_FOUND", rateId } };
  }
  if (row.memberUserId !== acceptingUserId) {
    return { success: false, error: { type: "NOT_THE_RATE_SUBJECT" } };
  }
  if (row.rate.status === "locked") {
    return { success: false, error: { type: "RATE_ALREADY_LOCKED" } };
  }
  if (row.rate.status === "accepted") {
    return { success: false, error: { type: "RATE_ALREADY_ACCEPTED" } };
  }

  const updated = await db.transaction(async (tx) => {
    const acceptedAt = new Date();
    const [next] = await tx
      .update(memberFairMarketRate)
      .set({ status: "accepted", acceptedAt, acceptedByUserId: acceptingUserId })
      .where(
        // Re-asserted inside the transaction: a lock may have landed between the read
        // above and this write, and the trigger would then reject with a 500 rather than
        // a 409.
        and(eq(memberFairMarketRate.id, rateId), eq(memberFairMarketRate.status, "proposed")),
      )
      .returning();

    if (!next) {
      return null;
    }

    await appendAuditEntry(tx, {
      projectId: context.projectId,
      eventKind: "rate_accepted",
      actorUserId: acceptingUserId,
      actorRoleSnapshot,
      actionLabel: "Accepted their fair market rate",
      targetLabel: `rate ${rateId}`,
      payload: {
        rateId,
        memberId: next.memberId,
        fairMarketRateCentsPerHour: next.fairMarketRateCentsPerHour,
        paidCashRateCentsPerHour: next.paidCashRateCentsPerHour,
      },
      occurredAt: acceptedAt,
    });

    return next;
  });

  if (!updated) {
    return { success: false, error: { type: "RATE_ALREADY_ACCEPTED" } };
  }

  return {
    success: true,
    value: toRateView(updated, { userId: row.memberUserId, name: row.name }),
  };
}

/**
 * `POST …/fair-market-rate/lock` — founder only, and irreversible.
 *
 * Requires the typed acknowledgement for the same reason `pie-bake` does: this is the
 * moment a negotiated number becomes the permanent basis of someone's equity, and an
 * accidental double-click must not be able to reach it.
 */
export async function lockFairMarketRate(
  context: { readonly projectId: string },
  rateId: string,
  acknowledgement: string,
  lockedByUserId: string,
  actorRoleSnapshot: string,
): Promise<Result<FairMarketRateView, FairMarketRateError>> {
  if (acknowledgement !== RATE_LOCK_ACKNOWLEDGEMENT) {
    return {
      success: false,
      error: { type: "ACKNOWLEDGEMENT_MISMATCH", expected: RATE_LOCK_ACKNOWLEDGEMENT },
    };
  }

  const [row] = await db
    .select({ rate: memberFairMarketRate, memberUserId: projectMember.userId, name: user.name })
    .from(memberFairMarketRate)
    .innerJoin(projectMember, eq(projectMember.id, memberFairMarketRate.memberId))
    .innerJoin(user, eq(user.id, projectMember.userId))
    .where(
      and(
        eq(memberFairMarketRate.id, rateId),
        eq(memberFairMarketRate.projectId, context.projectId),
      ),
    );

  if (!row) {
    return { success: false, error: { type: "RATE_NOT_FOUND", rateId } };
  }
  if (row.rate.status === "locked") {
    return { success: false, error: { type: "RATE_ALREADY_LOCKED" } };
  }
  if (row.rate.status !== "accepted") {
    return { success: false, error: { type: "RATE_NOT_ACCEPTED" } };
  }

  const updated = await db.transaction(async (tx) => {
    const lockedAt = new Date();
    const [next] = await tx
      .update(memberFairMarketRate)
      .set({ status: "locked", lockedAt, lockedByUserId })
      .where(and(eq(memberFairMarketRate.id, rateId), eq(memberFairMarketRate.status, "accepted")))
      .returning();

    if (!next) {
      return null;
    }

    await appendAuditEntry(tx, {
      projectId: context.projectId,
      eventKind: "rate_locked",
      actorUserId: lockedByUserId,
      actorRoleSnapshot,
      actionLabel: "Locked a fair market rate",
      targetLabel: `rate ${rateId}`,
      detailNote: next.rationaleNote,
      payload: {
        rateId,
        memberId: next.memberId,
        fairMarketRateCentsPerHour: next.fairMarketRateCentsPerHour,
        paidCashRateCentsPerHour: next.paidCashRateCentsPerHour,
        currencyCode: next.currencyCode,
        effectiveFrom: next.effectiveFrom,
        acknowledgement,
      },
      occurredAt: lockedAt,
    });

    return next;
  });

  if (!updated) {
    return { success: false, error: { type: "RATE_ALREADY_LOCKED" } };
  }

  return {
    success: true,
    value: toRateView(updated, { userId: row.memberUserId, name: row.name }),
  };
}

/**
 * `GET …/members/:memberUserId/fair-market-rate` — the FULL effective-dated history.
 *
 * This read IS the transparency promise (§11e). Every member sees every rate, including
 * superseded proposals: SPEC §2's pitch is "valuation rules locked in and transparent to
 * everyone", and a history only the founder can see is not that.
 */
export async function listFairMarketRateHistory(
  projectId: string,
  memberUserId: string,
): Promise<Result<readonly FairMarketRateView[], FairMarketRateError>> {
  const [member] = await db
    .select({ memberId: projectMember.id, userId: projectMember.userId, name: user.name })
    .from(projectMember)
    .innerJoin(user, eq(user.id, projectMember.userId))
    // No status filter: a departed member's rate history stays readable, because the
    // slices it priced are still in the ledger.
    .where(and(eq(projectMember.projectId, projectId), eq(projectMember.userId, memberUserId)));

  if (!member) {
    return { success: false, error: { type: "RATE_SUBJECT_NOT_A_MEMBER", memberUserId } };
  }

  const rows = await db
    .select()
    .from(memberFairMarketRate)
    .where(eq(memberFairMarketRate.memberId, member.memberId))
    // Ends in a unique column so two rates sharing an instant never swap between reads.
    .orderBy(asc(memberFairMarketRate.effectiveFrom), asc(memberFairMarketRate.id));

  return { success: true, value: rows.map((rate) => toRateView(rate, member)) };
}

export interface EffectiveRate {
  readonly rateId: string;
  readonly fairMarketRateCentsPerHour: bigint;
  readonly paidCashRateCentsPerHour: bigint;
  readonly unpaidRateCentsPerHour: bigint;
  readonly currencyCode: string;
  readonly effectiveFrom: Date;
}

/**
 * The rate in force for a member at an instant — the pipeline's entry point into this
 * table, and the reason effective-dating exists at all.
 *
 * `locked` only: a proposal prices nothing, and an accepted-but-unlocked rate is still
 * editable by the founder. Returns null when no locked rate covers the instant, which the
 * claim path surfaces as `409 RATE_NOT_LOCKED` rather than guessing a number.
 */
export async function findEffectiveRate(memberId: string, at: Date): Promise<EffectiveRate | null> {
  const [row] = await db
    .select()
    .from(memberFairMarketRate)
    .where(
      and(
        eq(memberFairMarketRate.memberId, memberId),
        eq(memberFairMarketRate.status, "locked"),
        lte(memberFairMarketRate.effectiveFrom, at),
      ),
    )
    // The NEWEST rate that had already taken effect. Ends in a unique column, so a
    // recompute a year later resolves the same row (§4c rule 4).
    .orderBy(desc(memberFairMarketRate.effectiveFrom), desc(memberFairMarketRate.id))
    .limit(1);

  if (!row) {
    return null;
  }

  return {
    rateId: row.id,
    fairMarketRateCentsPerHour: row.fairMarketRateCentsPerHour,
    paidCashRateCentsPerHour: row.paidCashRateCentsPerHour,
    unpaidRateCentsPerHour: unpaidRateCentsPerHour(
      Number(row.fairMarketRateCentsPerHour),
      Number(row.paidCashRateCentsPerHour),
    ),
    currencyCode: row.currencyCode,
    effectiveFrom: row.effectiveFrom,
  };
}
