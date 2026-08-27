import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { config } from "#src/config/index.js";
import { db } from "#src/db/index.js";
import { fundingRound, fundingRoundPledge, researchProject, user } from "#src/db/schema.js";
import { BASIS_POINTS_TOTAL, divRoundHalfAwayFromZero } from "#src/lib/money.js";
import { isForeignKeyViolation } from "#src/lib/pg-errors.js";
// NOTHING FROM escrow.service.ts OR escrow-provider-adapter.service.ts IS IMPORTED HERE
// ANY MORE, and the absence is the point (§7A.6). A pledge is a commitment: no journal
// entry, no posting, no provider transfer, no job. If a future edit needs one of those
// imports back, the change it is part of is a custody decision taken with counsel, not a
// refactor.
import { appendAuditEntry } from "#src/modules/rnd/projects/project-audit.service.js";
import type {
  ProjectAccessError,
  ProjectMemberContext,
} from "#src/modules/rnd/projects/project-membership.service.js";
import type { Result } from "#src/types/index.js";

/**
 * Funding rounds and pledges (R_AND_D_BACKEND_STRUCTURE.md §7, §11c).
 *
 * WHAT A PLEDGE BODY CARRIES: `{ amountInCents }`, and nothing else. §7 enumerates 27 keys
 * that `.strict()` turns into a 422 rather than a silent overwrite — `backerUserId`,
 * `currency`, `platformFeeInCents`, `netToEscrowInCents`, `raisedAmountInCents`,
 * `payoutDestinationId` among them. Every one of those is derived HERE, from rows the
 * server owns:
 *
 *   the backer      is `req.user.id`, from the session
 *   the currency    is the round's, which is the project's
 *   the bounds      are the round's own min/max, re-checked server-side
 *   the fee         is `PLATFORM_FEE_BASIS_POINTS` through src/lib/money.ts
 *   the destination is never involved in an inbound transfer at all
 *
 * There is no field for a client to edit, which is §0's actual answer to "what if the
 * client edits the number and posts it back".
 *
 * NOTHING HERE MOVES `raisedAmountInCents` OR `backersCount`. A pledge writes a
 * `pending` journal entry and returns 201; the counters move only in
 * escrow-settlement.service.ts, which is the whole point of the split.
 */

export type FundingRoundType = (typeof fundingRound.$inferSelect)["type"];
export type FundingRoundStatus = (typeof fundingRound.$inferSelect)["status"];

export type FundingError =
  | ProjectAccessError
  | { type: "ROUND_NOT_FOUND"; roundId: string }
  | { type: "PLEDGE_NOT_FOUND"; pledgeId: string }
  | { type: "ROUND_TYPE_DISABLED"; roundType: FundingRoundType }
  | { type: "ROUND_NOT_OPEN"; status: FundingRoundStatus }
  | { type: "ROUND_CLOSED_FOR_PLEDGES"; closesAt: Date }
  | { type: "ROUND_ALREADY_OPEN" }
  | { type: "ROUND_TERMINAL"; status: FundingRoundStatus }
  | { type: "ROUND_INCOMPLETE_FOR_OPEN"; missing: readonly string[] }
  | { type: "PLEDGE_BELOW_MINIMUM"; minimumInCents: string }
  | { type: "PLEDGE_ABOVE_MAXIMUM"; maximumInCents: string }
  | { type: "SELF_PLEDGE_FORBIDDEN" }
  | { type: "PLEDGE_NOT_CANCELLABLE"; status: (typeof fundingRoundPledge.$inferSelect)["status"] }
  | { type: "NOT_THE_BACKER" }
  | { type: "ROUND_NOT_EDITABLE"; status: FundingRoundStatus }
  | { type: "ROUND_HAS_REFERENCES" }
  | { type: "ROUND_GOAL_INVALID" }
  | { type: "ROUND_BOUNDS_INVALID"; minimumInCents: string; maximumInCents: string }
  | { type: "ROUND_WINDOW_INVALID"; opensAt: Date; closesAt: Date };

/**
 * `percentageFunded` IS NOT A COLUMN and not a request field (§7). Computed on read, so it
 * cannot be forged and cannot drift.
 *
 * FLOOR, not the half-away-from-zero rounding the rest of this domain uses, and the
 * difference is not pedantry: rounding would render 9,999.5 basis points as a funded round
 * before the goal was met. A progress figure must never round UP past a threshold somebody
 * is making a decision on. Both operands are non-negative here, so BigInt truncation IS
 * floor.
 *
 * MAY EXCEED 10000 when overfunded, deliberately. The client clamps the BAR WIDTH, not the
 * number — a round at 143% should say so.
 */
export function percentageFundedBasisPoints(
  raisedAmountInCents: bigint,
  goalAmountInCents: bigint,
): number {
  if (goalAmountInCents <= 0n) {
    // "What percentage of nothing" has no answer, and returning 0 would render as a
    // computed fact. The column CHECK forbids this, so it is an assertion, not a branch.
    throw new Error("percentageFundedBasisPoints: goal must be positive");
  }
  return Number((raisedAmountInCents * BigInt(BASIS_POINTS_TOTAL)) / goalAmountInCents);
}

/**
 * THE REGULATORY GATE (§7). Checked before creating a round, before opening one, before
 * accepting a pledge, and in the `/funding/deals` filter — four places, because a type
 * that is merely hidden in one of them is still reachable from `curl`.
 */
export function isRoundTypeEnabled(roundType: FundingRoundType): boolean {
  return config.ENABLED_FUNDING_ROUND_TYPES.includes(roundType);
}

/**
 * The platform's cut, derived — never sent, never stored on a request.
 *
 * **IT IS ZERO, AND IT STAYS ZERO** (§0). `PLATFORM_FEE_BASIS_POINTS` defaults to 0:
 * Qatoto charges nobody — not a founder, an employee, an employer or an investor. The
 * function survives because migration 0016's historical rows were priced with a nonzero
 * value and must remain explicable, and because the callers already omit the fee posting
 * entirely at zero rather than writing a row of zeros.
 *
 * A nonzero value is not a knob to turn: in several US states the money-transmitter
 * definition turns partly on being compensated for the service (§7A.6 item 1).
 */
export function derivePlatformFeeInCents(amountInCents: bigint): bigint {
  return divRoundHalfAwayFromZero(
    amountInCents * BigInt(config.PLATFORM_FEE_BASIS_POINTS),
    BigInt(BASIS_POINTS_TOTAL),
  );
}

export interface FundingRoundView {
  readonly id: string;
  readonly projectId: string;
  readonly projectSlug: string | null;
  readonly type: FundingRoundType;
  readonly status: FundingRoundStatus;
  readonly title: string;
  readonly summary: string | null;
  readonly currency: string;
  readonly goalAmountInCents: string;
  readonly raisedAmountInCents: string;
  /** Computed on read. May exceed 10000. Never stored. */
  readonly percentageFundedBasisPoints: number;
  readonly backersCount: number;
  readonly minimumPledgeInCents: string;
  readonly maximumPledgeInCents: string | null;
  readonly opensAt: Date | null;
  readonly closesAt: Date | null;
  readonly closedAt: Date | null;
  readonly createdAt: Date;
}

function toRoundView(
  row: typeof fundingRound.$inferSelect,
  projectSlug: string | null,
): FundingRoundView {
  return {
    id: row.id,
    projectId: row.projectId,
    projectSlug,
    type: row.type,
    status: row.status,
    title: row.title,
    summary: row.summary,
    currency: row.currency,
    // Every bigint crosses the wire as a decimal string: a goal past 2^53 loses precision
    // the moment JSON.stringify touches it (§4b).
    goalAmountInCents: row.goalAmountInCents.toString(),
    raisedAmountInCents: row.raisedAmountInCents.toString(),
    percentageFundedBasisPoints: percentageFundedBasisPoints(
      row.raisedAmountInCents,
      row.goalAmountInCents,
    ),
    backersCount: row.backersCount,
    minimumPledgeInCents: row.minimumPledgeInCents.toString(),
    maximumPledgeInCents: row.maximumPledgeInCents?.toString() ?? null,
    opensAt: row.opensAt,
    closesAt: row.closesAt,
    closedAt: row.closedAt,
    createdAt: row.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Rounds
// ---------------------------------------------------------------------------

export interface CreateFundingRoundInput {
  readonly type: FundingRoundType;
  readonly title: string;
  readonly summary?: string | undefined;
  readonly goalAmountInCents: bigint;
  readonly minimumPledgeInCents?: bigint | undefined;
  readonly maximumPledgeInCents?: bigint | undefined;
  readonly opensAt?: Date | undefined;
  readonly closesAt?: Date | undefined;
}

/** `POST …/funding-rounds` — founder only, gated by `ENABLED_FUNDING_ROUND_TYPES`. */
export async function createFundingRound(
  context: ProjectMemberContext,
  actorUserId: string,
  input: CreateFundingRoundInput,
): Promise<Result<FundingRoundView, FundingError>> {
  if (!isRoundTypeEnabled(input.type)) {
    return { success: false, error: { type: "ROUND_TYPE_DISABLED", roundType: input.type } };
  }

  const [created] = await db
    .insert(fundingRound)
    .values({
      projectId: context.projectId,
      type: input.type,
      status: "draft",
      title: input.title,
      summary: input.summary ?? null,
      goalAmountInCents: input.goalAmountInCents,
      // The currency is the PROJECT's, never the body's (§4b).
      currency: context.currency,
      ...(input.minimumPledgeInCents === undefined
        ? {}
        : { minimumPledgeInCents: input.minimumPledgeInCents }),
      maximumPledgeInCents: input.maximumPledgeInCents ?? null,
      opensAt: input.opensAt ?? null,
      closesAt: input.closesAt ?? null,
      createdByUserId: actorUserId,
    })
    .returning();

  if (!created) {
    throw new Error("createFundingRound: insert returned no row");
  }
  return { success: true, value: toRoundView(created, context.projectSlug) };
}

/** A round with its project, for the routes that are keyed on `roundId` rather than a slug. */
export interface RoundWithProject {
  readonly round: typeof fundingRound.$inferSelect;
  readonly projectSlug: string;
  readonly founderUserId: string;
}

export async function findRoundWithProject(roundId: string): Promise<RoundWithProject | null> {
  const [row] = await db
    .select({
      round: fundingRound,
      projectSlug: researchProject.slug,
      founderUserId: researchProject.founderUserId,
    })
    .from(fundingRound)
    .innerJoin(researchProject, eq(researchProject.id, fundingRound.projectId))
    .where(eq(fundingRound.id, roundId));

  return row ?? null;
}

/**
 * `POST /funding-rounds/:roundId/open` — the gate a client cannot bypass.
 *
 * Re-checks `ENABLED_FUNDING_ROUND_TYPES` even though creation already did: a type can be
 * disabled by an operator between the two calls, and a round created under a permissive
 * config must not become pledgeable under a restrictive one.
 */
export async function openFundingRound(
  roundId: string,
  actorUserId: string,
): Promise<Result<FundingRoundView, FundingError>> {
  const existing = await findRoundWithProject(roundId);
  if (!existing) {
    return { success: false, error: { type: "ROUND_NOT_FOUND", roundId } };
  }
  if (!isRoundTypeEnabled(existing.round.type)) {
    return {
      success: false,
      error: { type: "ROUND_TYPE_DISABLED", roundType: existing.round.type },
    };
  }
  if (existing.round.status === "open") {
    return { success: false, error: { type: "ROUND_ALREADY_OPEN" } };
  }
  if (existing.round.status !== "draft") {
    return { success: false, error: { type: "ROUND_TERMINAL", status: existing.round.status } };
  }

  // A round cannot open without a close date. "Open until we decide otherwise" is an
  // indefinite solicitation, and the backer-facing countdown has nothing to count to.
  const missing: string[] = [];
  if (existing.round.closesAt === null) missing.push("closesAt");
  if (missing.length > 0) {
    return { success: false, error: { type: "ROUND_INCOMPLETE_FOR_OPEN", missing } };
  }

  // ONE transaction for the state change and its audit entry. An audit trail that can lag
  // the thing it records is worse than none (§9.9) — it produces a record that looks
  // complete and is not, and nothing downstream can tell the difference.
  const opened = await db.transaction(async (tx) => {
    const openedAt = new Date();
    // The status predicate in the WHERE is the concurrency control: two founders clicking
    // open at once, and only one UPDATE matches.
    const [row] = await tx
      .update(fundingRound)
      .set({ status: "open", opensAt: existing.round.opensAt ?? openedAt })
      .where(and(eq(fundingRound.id, roundId), eq(fundingRound.status, "draft")))
      .returning();

    if (!row) {
      return null;
    }

    await appendAuditEntry(tx, {
      projectId: row.projectId,
      eventKind: "funding_round_opened",
      actorUserId,
      actorRoleSnapshot: "founder",
      actionLabel: "Opened a funding round",
      targetLabel: `round ${row.title}`,
      payload: {
        roundId: row.id,
        roundType: row.type,
        goalAmountInCents: row.goalAmountInCents,
        currency: row.currency,
        closesAt: row.closesAt,
      },
      occurredAt: openedAt,
    });

    return row;
  });

  if (!opened) {
    return { success: false, error: { type: "ROUND_TERMINAL", status: existing.round.status } };
  }
  return { success: true, value: toRoundView(opened, existing.projectSlug) };
}

/** `POST /funding-rounds/:roundId/close` — terminal for pledging; pledges keep settling. */
export interface UpdateFundingRoundInput {
  readonly title?: string | undefined;
  readonly summary?: string | null | undefined;
  readonly goalAmountInCents?: bigint | undefined;
  readonly minimumPledgeInCents?: bigint | undefined;
  readonly maximumPledgeInCents?: bigint | null | undefined;
  readonly opensAt?: Date | null | undefined;
  readonly closesAt?: Date | null | undefined;
}

/**
 * `PATCH /funding-rounds/:roundId` — corrects a DRAFT round (§11j.3).
 *
 * Create, open and close all shipped and no update existed, so a typo in a goal amount was
 * permanent.
 *
 * "EVER OPENED" IS `status !== "draft"`, NOT A TIMESTAMP TEST. There is no `openedAt`
 * column, and `opensAt` cannot stand in for one: `createFundingRound` writes it straight
 * from the body, so a round that was never opened can carry a non-null `opensAt` — and a
 * scheduled round would then be uneditable for the wrong reason. `openFundingRound` is the
 * only writer that leaves `draft` and nothing returns a round to it, so `draft` ⟺ never
 * opened. The counters are checked too, belt and braces: they move only in
 * `escrow-settlement.service.ts`, so a non-zero one on a `draft` row means something has
 * already happened that an edit must not silently re-price.
 *
 * THE THREE CHECKS ARE RE-DERIVED ON THE MERGED TUPLE, not on the input. Sending only
 * `maximumPledgeInCents`, below the STORED minimum, satisfies every per-field rule and still
 * violates `funding_round_bounds_ck` — which would surface as an unhandled 23514 and a 500.
 * Each is proven here so the caller gets a typed 422 naming the pair that conflicts:
 *   `funding_round_goal_ck`   — goal > 0. `"0"` passes CentsStringSchema, so Zod cannot.
 *   `funding_round_bounds_ck` — minimum >= 1 AND (maximum IS NULL OR maximum >= minimum).
 *   `funding_round_window_ck` — closesAt > opensAt when both are present.
 */
export async function updateFundingRound(
  roundId: string,
  input: UpdateFundingRoundInput,
): Promise<Result<FundingRoundView, FundingError>> {
  const existing = await findRoundWithProject(roundId);
  if (!existing) {
    return { success: false, error: { type: "ROUND_NOT_FOUND", roundId } };
  }

  const current = existing.round;
  if (current.status !== "draft" || current.raisedAmountInCents > 0n || current.backersCount > 0) {
    return { success: false, error: { type: "ROUND_NOT_EDITABLE", status: current.status } };
  }

  // The tuple as it WOULD be after the patch — every CHECK is about the row, not the input.
  const mergedGoal = input.goalAmountInCents ?? current.goalAmountInCents;
  const mergedMinimum = input.minimumPledgeInCents ?? current.minimumPledgeInCents;
  const mergedMaximum =
    input.maximumPledgeInCents === undefined
      ? current.maximumPledgeInCents
      : input.maximumPledgeInCents;
  const mergedOpensAt = input.opensAt === undefined ? current.opensAt : input.opensAt;
  const mergedClosesAt = input.closesAt === undefined ? current.closesAt : input.closesAt;

  if (mergedGoal <= 0n) {
    return { success: false, error: { type: "ROUND_GOAL_INVALID" } };
  }
  if (mergedMinimum < 1n || (mergedMaximum !== null && mergedMaximum < mergedMinimum)) {
    return {
      success: false,
      error: {
        type: "ROUND_BOUNDS_INVALID",
        minimumInCents: mergedMinimum.toString(),
        maximumInCents: mergedMaximum?.toString() ?? "null",
      },
    };
  }
  if (mergedOpensAt !== null && mergedClosesAt !== null && mergedClosesAt <= mergedOpensAt) {
    return {
      success: false,
      error: { type: "ROUND_WINDOW_INVALID", opensAt: mergedOpensAt, closesAt: mergedClosesAt },
    };
  }

  const [updated] = await db
    .update(fundingRound)
    .set({
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      goalAmountInCents: mergedGoal,
      minimumPledgeInCents: mergedMinimum,
      maximumPledgeInCents: mergedMaximum,
      opensAt: mergedOpensAt,
      closesAt: mergedClosesAt,
    })
    // Re-asserted: the round must still be a draft when the write lands.
    .where(and(eq(fundingRound.id, roundId), eq(fundingRound.status, "draft")))
    .returning();

  if (!updated) {
    return { success: false, error: { type: "ROUND_NOT_EDITABLE", status: current.status } };
  }
  return { success: true, value: toRoundView(updated, existing.projectSlug) };
}

/**
 * `DELETE /funding-rounds/:roundId` — withdraws a DRAFT round (§11j.3).
 *
 * A round that has ever opened is CANCELLED OR CLOSED, never deleted: people saw it, and
 * some of them may have decided something because of it. Only a draft nobody could pledge
 * against can be taken back.
 *
 * REFUSED TWO WAYS, and the second is the one that actually holds. The explicit count is
 * for the message; `funding_round_pledge.round_id` is `restrict`, so a pledge landing
 * between the count and the delete still cannot orphan itself — the FK violation is
 * translated to the same 409. Pledges of EVERY status count, `cancelled` and `failed`
 * included: §11j.3 says "carries a pledge", and a cancelled pledge is still a record that
 * somebody committed and changed their mind.
 */
export async function deleteFundingRound(
  roundId: string,
): Promise<Result<{ readonly deleted: true }, FundingError>> {
  const existing = await findRoundWithProject(roundId);
  if (!existing) {
    return { success: false, error: { type: "ROUND_NOT_FOUND", roundId } };
  }
  if (existing.round.status !== "draft") {
    return { success: false, error: { type: "ROUND_HAS_REFERENCES" } };
  }

  const [pledgeCount] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(fundingRoundPledge)
    .where(eq(fundingRoundPledge.roundId, roundId));

  if ((pledgeCount?.total ?? 0) > 0) {
    return { success: false, error: { type: "ROUND_HAS_REFERENCES" } };
  }

  try {
    const [deleted] = await db
      .delete(fundingRound)
      .where(and(eq(fundingRound.id, roundId), eq(fundingRound.status, "draft")))
      .returning({ id: fundingRound.id });

    if (!deleted) {
      return { success: false, error: { type: "ROUND_HAS_REFERENCES" } };
    }
  } catch (error: unknown) {
    // A pledge landed between the count and the delete. `restrict` caught it.
    if (isForeignKeyViolation(error)) {
      return { success: false, error: { type: "ROUND_HAS_REFERENCES" } };
    }
    throw error;
  }

  return { success: true, value: { deleted: true } };
}

export async function closeFundingRound(
  roundId: string,
  actorUserId: string,
): Promise<Result<FundingRoundView, FundingError>> {
  const existing = await findRoundWithProject(roundId);
  if (!existing) {
    return { success: false, error: { type: "ROUND_NOT_FOUND", roundId } };
  }
  if (existing.round.status !== "open") {
    return { success: false, error: { type: "ROUND_NOT_OPEN", status: existing.round.status } };
  }

  const closed = await db.transaction(async (tx) => {
    const closedAt = new Date();
    const [row] = await tx
      .update(fundingRound)
      .set({ status: "closed", closedAt })
      .where(and(eq(fundingRound.id, roundId), eq(fundingRound.status, "open")))
      .returning();

    if (!row) {
      return null;
    }

    await appendAuditEntry(tx, {
      projectId: row.projectId,
      eventKind: "funding_round_closed",
      actorUserId,
      actorRoleSnapshot: "founder",
      actionLabel: "Closed a funding round",
      targetLabel: `round ${row.title}`,
      payload: {
        roundId: row.id,
        // The final figures, frozen into the chain at the moment of closing, so "what did
        // this round actually raise" is answerable from the audit trail alone even if the
        // round row is later archived.
        raisedAmountInCents: row.raisedAmountInCents,
        backersCount: BigInt(row.backersCount),
        goalAmountInCents: row.goalAmountInCents,
      },
      occurredAt: closedAt,
    });

    return row;
  });

  if (!closed) {
    return { success: false, error: { type: "ROUND_NOT_OPEN", status: existing.round.status } };
  }
  return { success: true, value: toRoundView(closed, existing.projectSlug) };
}

export async function getFundingRound(
  roundId: string,
): Promise<Result<FundingRoundView, FundingError>> {
  const existing = await findRoundWithProject(roundId);
  if (!existing) {
    return { success: false, error: { type: "ROUND_NOT_FOUND", roundId } };
  }
  return { success: true, value: toRoundView(existing.round, existing.projectSlug) };
}

export async function listProjectFundingRounds(
  projectId: string,
  projectSlug: string,
): Promise<readonly FundingRoundView[]> {
  const rows = await db
    .select()
    .from(fundingRound)
    .where(eq(fundingRound.projectId, projectId))
    // §4c rule 4: the ordering ends in a unique column, or a cursor skips rows.
    .orderBy(desc(fundingRound.createdAt), desc(fundingRound.id));

  return rows.map((row) => toRoundView(row, projectSlug));
}

/**
 * `GET /funding-rounds/:roundId/pledge-options` — the bounds the server will enforce.
 *
 * Shipped so a client can render a helpful form, NOT so it can validate: every value here
 * is re-derived inside `createPledge` from the same rows. A client that ignores this
 * endpoint entirely gets identical outcomes, which is the test of whether a read like this
 * is advisory or load-bearing.
 */
export interface PledgeOptionsView {
  readonly currency: string;
  readonly minimumPledgeInCents: string;
  readonly maximumPledgeInCents: string | null;
  readonly platformFeeBasisPoints: number;
  readonly acceptingPledges: boolean;
  readonly closesAt: Date | null;
}

export async function getPledgeOptions(
  roundId: string,
): Promise<Result<PledgeOptionsView, FundingError>> {
  const existing = await findRoundWithProject(roundId);
  if (!existing) {
    return { success: false, error: { type: "ROUND_NOT_FOUND", roundId } };
  }

  const { round } = existing;
  return {
    success: true,
    value: {
      currency: round.currency,
      minimumPledgeInCents: round.minimumPledgeInCents.toString(),
      maximumPledgeInCents: round.maximumPledgeInCents?.toString() ?? null,
      platformFeeBasisPoints: config.PLATFORM_FEE_BASIS_POINTS,
      acceptingPledges:
        round.status === "open" &&
        isRoundTypeEnabled(round.type) &&
        (round.closesAt === null || round.closesAt > new Date()),
      closesAt: round.closesAt,
    },
  };
}

// ---------------------------------------------------------------------------
// Pledges
// ---------------------------------------------------------------------------

export interface PledgeView {
  readonly id: string;
  readonly roundId: string;
  readonly projectId: string;
  readonly amountInCents: string;
  readonly platformFeeInCents: string;
  readonly netToEscrowInCents: string;
  readonly currency: string;
  readonly status: (typeof fundingRoundPledge.$inferSelect)["status"];
  readonly providerTransferId: string | null;
  readonly settledAt: Date | null;
  readonly createdAt: Date;
}

function toPledgeView(row: typeof fundingRoundPledge.$inferSelect): PledgeView {
  return {
    id: row.id,
    roundId: row.roundId,
    projectId: row.projectId,
    amountInCents: row.amountInCents.toString(),
    platformFeeInCents: row.platformFeeInCents.toString(),
    netToEscrowInCents: row.netToEscrowInCents.toString(),
    currency: row.currency,
    status: row.status,
    providerTransferId: row.providerTransferId,
    settledAt: row.settledAt,
    createdAt: row.createdAt,
  };
}

/**
 * `POST /funding-rounds/:roundId/pledges` — body `{ amountInCents }` and nothing else.
 *
 * **A PLEDGE IS A COMMITMENT, NOT A CHARGE** (§7, "What survives here"). No card is
 * charged, no funds are held, no fee is taken, and no client copy may imply otherwise:
 * the response says a commitment was recorded, never that a payment succeeded. A client
 * that says otherwise is lying to a backer about where their money is.
 *
 * ORDER OF OPERATIONS:
 *
 *   1. re-bound the amount against the ROUND's own min/max — the client's copy of those
 *      numbers is not consulted;
 *   2. resolve the currency from the round;
 *   3. record the pledge and move `raisedAmountInCents` / `backersCount` in ONE
 *      transaction;
 *   4. append the audit entry in that same transaction.
 *
 * WHAT USED TO BE HERE AND IS GONE: a `provider_transfer` row, a `pledge_authorized`
 * journal entry with its escrow postings, a platform-fee posting, and a
 * `submit-provider-transfer` job. All of it existed to move money into a pool Qatoto
 * controlled, and Qatoto controls no pool — custody is regulated in all three target
 * jurisdictions whether or not a fee is charged (§7A.6 item 1).
 *
 * `raisedAmountInCents` DOES MOVE HERE NOW, and that is a change from the escrow design
 * rather than a regression. `escrow-settlement.service.ts` used to be its only writer,
 * gated on an auditor settling a transfer; with no settlement step, leaving it there
 * would freeze every funding page at zero raised forever. §7 defines the counter as a sum
 * of COMMITTED pledges and every read projection labels it so.
 *
 * §17 step 4's tampering test is unaffected: the amount is still re-bound against the
 * round's own min/max, and every one of §7's rejected keys still 422s.
 */
export async function createPledge(input: {
  readonly roundId: string;
  readonly backerUserId: string;
  readonly amountInCents: bigint;
}): Promise<Result<PledgeView, FundingError>> {
  const existing = await findRoundWithProject(input.roundId);
  if (!existing) {
    return { success: false, error: { type: "ROUND_NOT_FOUND", roundId: input.roundId } };
  }

  const { round } = existing;

  if (!isRoundTypeEnabled(round.type)) {
    return { success: false, error: { type: "ROUND_TYPE_DISABLED", roundType: round.type } };
  }
  if (round.status !== "open") {
    return { success: false, error: { type: "ROUND_NOT_OPEN", status: round.status } };
  }
  if (round.closesAt !== null && round.closesAt <= new Date()) {
    return {
      success: false,
      error: { type: "ROUND_CLOSED_FOR_PLEDGES", closesAt: round.closesAt },
    };
  }

  // NOT IN §7, AND ADDED DELIBERATELY. No money moves in this phase, so a founder pledging
  // to their own round costs nothing and inflates `raisedAmountInCents`, `backersCount`
  // and — through them — the investor-confidence signal §7 computes nightly. Those three
  // numbers exist to tell an outsider whether strangers believe in this project. A round
  // its own founder funded is not that, and the frontend has no way to tell.
  if (existing.founderUserId === input.backerUserId) {
    return { success: false, error: { type: "SELF_PLEDGE_FORBIDDEN" } };
  }

  // THE RE-BOUND. §17 step 4: edit `amountInCents` in DevTools to another currency's
  // magnitude, replay, and assert the server charges its own value.
  if (input.amountInCents < round.minimumPledgeInCents) {
    return {
      success: false,
      error: {
        type: "PLEDGE_BELOW_MINIMUM",
        minimumInCents: round.minimumPledgeInCents.toString(),
      },
    };
  }
  if (round.maximumPledgeInCents !== null && input.amountInCents > round.maximumPledgeInCents) {
    return {
      success: false,
      error: {
        type: "PLEDGE_ABOVE_MAXIMUM",
        maximumInCents: round.maximumPledgeInCents.toString(),
      },
    };
  }

  // Zero, and it stays zero (§0). Retained on the row so a pledge recorded today is
  // shaped like migration 0016's historical ones and a single query still reads both.
  const platformFeeInCents = derivePlatformFeeInCents(input.amountInCents);
  const occurredAt = new Date();

  const created = await db.transaction(async (tx) => {
    const [pledge] = await tx
      .insert(fundingRoundPledge)
      .values({
        roundId: round.id,
        projectId: round.projectId,
        backerUserId: input.backerUserId,
        amountInCents: input.amountInCents,
        platformFeeInCents,
        // No fee is taken, so the whole commitment is the commitment. The column keeps
        // its name because 0016's rows use it; nothing reads it as "money in a pool" any
        // more, because there is no pool.
        netToEscrowInCents: input.amountInCents - platformFeeInCents,
        currency: round.currency,
        // `pending` NOW MEANS COMMITTED, not authorized-and-awaiting-capture. No card is
        // charged and no funds are held, so there is nothing for a later state to
        // transition to — `settled` is reserved for migration 0016's historical rows,
        // which really did pass through a settlement step.
        status: "pending",
        // NO PROVIDER TRANSFER. Qatoto holds no funds and operates no payout rail
        // (§7A.6), so there is nothing to submit and nobody to submit it to.
        providerTransferId: null,
      })
      .returning();

    if (!pledge) {
      throw new Error("createPledge: insert returned no row");
    }

    // THE COUNTERS MOVE HERE NOW, and this is the one behavioural change that came with
    // retiring escrow. `escrow_settlement.service.ts` used to be the sole writer of these
    // two columns, gated on an auditor settling a provider transfer. With no custody
    // there is no settlement step, and leaving them to it would freeze every funding page
    // at zero raised, forever.
    //
    // §7's "What survives here" is explicit that they are sums of COMMITTED pledges, and
    // every read projection labels them so. They are not money received.
    await tx
      .update(fundingRound)
      .set({
        raisedAmountInCents: sql`${fundingRound.raisedAmountInCents} + ${input.amountInCents}`,
        backersCount: sql`${fundingRound.backersCount} + 1`,
      })
      .where(eq(fundingRound.id, round.id));

    // The audit chain still records it. A commitment is a fact about who backed what and
    // when, and §9's chain is where this domain keeps facts.
    await appendAuditEntry(tx, {
      projectId: round.projectId,
      eventKind: "pledge_recorded",
      actorUserId: input.backerUserId,
      actorRoleSnapshot: "backer",
      actionLabel: "Recorded a pledge commitment",
      targetLabel: `pledge ${pledge.id}`,
      // SERVER-COMPOSED prose. The one deliberate display string in this domain (§7),
      // written here rather than on three clients so web/Kotlin/Swift cannot drift.
      detailNote: `Commitment recorded — ${round.currency} ${input.amountInCents.toString()} toward ${round.title}. No funds were charged or held.`,
      payload: {
        pledgeId: pledge.id,
        roundId: round.id,
        amountInCents: input.amountInCents,
        currency: round.currency,
      },
      occurredAt,
    });

    return pledge;
  });

  return { success: true, value: toPledgeView(created) };
}

/** `GET /pledges/mine` — the filter is `req.user.id`. There is no `userId` parameter (§11c). */
export async function listMyPledges(
  backerUserId: string,
  options: { readonly page?: number | undefined; readonly limit?: number | undefined } = {},
): Promise<
  readonly (PledgeView & { readonly projectSlug: string; readonly roundTitle: string })[]
> {
  const limit = Math.min(options.limit ?? 25, 100);
  const page = Math.max(options.page ?? 1, 1);

  const rows = await db
    .select({
      pledge: fundingRoundPledge,
      projectSlug: researchProject.slug,
      roundTitle: fundingRound.title,
    })
    .from(fundingRoundPledge)
    .innerJoin(fundingRound, eq(fundingRound.id, fundingRoundPledge.roundId))
    .innerJoin(researchProject, eq(researchProject.id, fundingRoundPledge.projectId))
    .where(eq(fundingRoundPledge.backerUserId, backerUserId))
    .orderBy(desc(fundingRoundPledge.createdAt), desc(fundingRoundPledge.id))
    .limit(limit)
    .offset((page - 1) * limit);

  return rows.map((row) => ({
    ...toPledgeView(row.pledge),
    projectSlug: row.projectSlug,
    roundTitle: row.roundTitle,
  }));
}

/**
 * `GET /funding-rounds/mine` — every round across every project the caller FOUNDS.
 *
 * WHY IT EXISTS, and it is a gap the studio's own placeholder page named before this shipped:
 * `listProjectFundingRounds` above is scoped to ONE project and `listMyPledges` below is
 * BACKER-side, so a founder with three ventures raising at once had no way to see them together —
 * they opened three project pages. `/studio/funding` promised "pledges and backers across all of
 * your projects at once" and had nothing behind it.
 *
 * FOUNDER ONLY, VIA `researchProject.founderUserId`, and that is the same gate the round WRITES
 * use — `createFundingRound` is founder-only. A read that showed maintainers rounds they cannot
 * open, close or edit would be a second, looser rule wearing the same name, and the account-level
 * framing ("your projects") is a claim about ownership rather than membership.
 *
 * PAGINATED, unlike `listProjectFundingRounds`, and the asymmetry is the point: a per-project list
 * is bounded by one project, an account-level one is bounded by nothing.
 *
 * `projectName` RIDES ALONG BECAUSE THE SLUG IS NOT A LABEL. Every other funding read is reached
 * THROUGH a project, so the reader already knows which one they are looking at; here a row is
 * meaningless without saying which venture it belongs to, and rendering `solar-cold-storage` as a
 * heading would be showing a URL where a name belongs.
 */
export async function listMyFoundedFundingRounds(
  founderUserId: string,
  options: { readonly page?: number | undefined; readonly limit?: number | undefined } = {},
): Promise<readonly (FundingRoundView & { readonly projectName: string })[]> {
  const limit = Math.min(options.limit ?? 25, 100);
  const page = Math.max(options.page ?? 1, 1);

  const rows = await db
    .select({
      round: fundingRound,
      projectSlug: researchProject.slug,
      projectName: researchProject.name,
    })
    .from(fundingRound)
    .innerJoin(researchProject, eq(researchProject.id, fundingRound.projectId))
    .where(eq(researchProject.founderUserId, founderUserId))
    // §4c rule 4: the ordering ends in a unique column, or a page skips rows. Newest first, which
    // for an account-level list means the round most likely to be acted on is at the top.
    .orderBy(desc(fundingRound.createdAt), desc(fundingRound.id))
    .limit(limit)
    .offset((page - 1) * limit);

  return rows.map((row) => ({
    ...toRoundView(row.round, row.projectSlug),
    projectName: row.projectName,
  }));
}

/**
 * `POST /pledges/:id/cancel` — the backer's own, and only while it is still pending.
 *
 * A settled pledge is not cancellable and never becomes so: money that reached the pool
 * leaves it as a REFUND, which is a different entry, a different account
 * (`refunds_payable`) and a different decision. Collapsing the two would let a backer
 * withdraw funds a project has already been told it has.
 */
export async function cancelPledge(
  pledgeId: string,
  backerUserId: string,
): Promise<Result<PledgeView, FundingError>> {
  const outcome = await db.transaction(async (tx) => {
    const [pledge] = await tx
      .select()
      .from(fundingRoundPledge)
      .where(eq(fundingRoundPledge.id, pledgeId))
      .for("update");

    if (!pledge) {
      return { kind: "not-found" } as const;
    }
    // The caller's own pledge only. Checked before anything else is read back, so a
    // stranger learns nothing about a pledge that is not theirs.
    if (pledge.backerUserId !== backerUserId) {
      return { kind: "not-yours" } as const;
    }
    if (pledge.status !== "pending") {
      return { kind: "not-cancellable", status: pledge.status } as const;
    }

    const cancelledAt = new Date();

    await tx
      .update(fundingRoundPledge)
      .set({ status: "cancelled", cancelledAt })
      .where(eq(fundingRoundPledge.id, pledgeId));

    // THE COUNTERS COME BACK DOWN, in the same transaction that cancelled the pledge.
    // A withdrawn commitment that left `raisedAmountInCents` where it was would tell an
    // outsider that strangers still back this project when one of them has said they do
    // not — which is precisely the number `SELF_PLEDGE_FORBIDDEN` exists to protect.
    await tx
      .update(fundingRound)
      .set({
        raisedAmountInCents: sql`${fundingRound.raisedAmountInCents} - ${pledge.amountInCents}`,
        backersCount: sql`GREATEST(${fundingRound.backersCount} - 1, 0)`,
      })
      .where(eq(fundingRound.id, pledge.roundId));

    // No reversing journal entry and no provider transfer to cancel: nothing was held and
    // nothing was submitted (§7A.6). The audit chain still records the withdrawal,
    // because who withdrew and when is a fact this domain keeps.
    await appendAuditEntry(tx, {
      projectId: pledge.projectId,
      eventKind: "pledge_cancelled",
      actorUserId: backerUserId,
      actorRoleSnapshot: "backer",
      actionLabel: "Withdrew a pledge commitment",
      targetLabel: `pledge ${pledge.id}`,
      payload: {
        pledgeId: pledge.id,
        roundId: pledge.roundId,
        amountInCents: pledge.amountInCents,
        currency: pledge.currency,
      },
      occurredAt: cancelledAt,
    });

    const [updated] = await tx
      .select()
      .from(fundingRoundPledge)
      .where(eq(fundingRoundPledge.id, pledgeId));

    return { kind: "cancelled", pledge: updated } as const;
  });

  switch (outcome.kind) {
    case "not-found":
      return { success: false, error: { type: "PLEDGE_NOT_FOUND", pledgeId } };
    case "not-yours":
      return { success: false, error: { type: "NOT_THE_BACKER" } };
    case "not-cancellable":
      return { success: false, error: { type: "PLEDGE_NOT_CANCELLABLE", status: outcome.status } };
    case "cancelled": {
      if (!outcome.pledge) {
        throw new Error("cancelPledge: cancelled row disappeared");
      }
      return { success: true, value: toPledgeView(outcome.pledge) };
    }
    default: {
      // Adding an outcome without handling it breaks the build, which is the point
      // (CLAUDE.md §3.2).
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled cancel outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export interface RoundBackerView {
  readonly pledgeId: string;
  readonly backerName: string;
  readonly backerHandle: string | null;
  readonly amountInCents: string;
  readonly currency: string;
  readonly status: (typeof fundingRoundPledge.$inferSelect)["status"];
  readonly pledgedAt: Date;
}

/**
 * `GET /funding-rounds/:roundId/backers` — everyone whose commitment still stands.
 *
 * COMMITTED AND HISTORICALLY SETTLED, never `cancelled`, `failed` or `refunded`. The old
 * rule was "settled only", which made sense when a pledge passed through a card network
 * that could decline it; with no custody there is no settlement step, and filtering to
 * `settled` would show an empty backer list on every round created from now on while
 * still showing migration 0016's historical rows — the worst of both.
 *
 * A withdrawn commitment leaves the list because `cancelPledge` moves it to `cancelled`
 * and decrements the counters in the same transaction, so the list and
 * `backersCount` cannot disagree.
 *
 * **THESE ARE COMMITMENTS, NOT PAYMENTS**, and every client rendering this list must say
 * so (§7). Nobody here has been charged anything.
 */
export async function listRoundBackers(
  roundId: string,
  options: { readonly page?: number | undefined; readonly limit?: number | undefined } = {},
): Promise<readonly RoundBackerView[]> {
  const limit = Math.min(options.limit ?? 25, 100);
  const page = Math.max(options.page ?? 1, 1);

  const rows = await db
    .select({
      pledgeId: fundingRoundPledge.id,
      backerName: user.name,
      backerHandle: user.handle,
      amountInCents: fundingRoundPledge.amountInCents,
      currency: fundingRoundPledge.currency,
      status: fundingRoundPledge.status,
      pledgedAt: fundingRoundPledge.createdAt,
    })
    .from(fundingRoundPledge)
    .innerJoin(user, eq(user.id, fundingRoundPledge.backerUserId))
    .where(
      and(
        eq(fundingRoundPledge.roundId, roundId),
        inArray(fundingRoundPledge.status, ["pending", "settled"]),
      ),
    )
    .orderBy(desc(fundingRoundPledge.settledAt), desc(fundingRoundPledge.id))
    .limit(limit)
    .offset((page - 1) * limit);

  return rows.map((row) => ({ ...row, amountInCents: row.amountInCents.toString() }));
}

export interface FundingDealView extends FundingRoundView {
  readonly projectName: string;
  readonly projectStage: (typeof researchProject.$inferSelect)["stage"];
  readonly projectTagline: string;
}

/**
 * `GET /funding/deals` — investor deal flow.
 *
 * FILTERED BY `ENABLED_FUNDING_ROUND_TYPES` IN SQL, not after the fact: a disabled type
 * must be invisible, and post-filtering a page leaves a page that is short by however many
 * rows were dropped, which is a paging bug that looks like an empty result.
 */
export async function listFundingDeals(options: {
  readonly roundType?: FundingRoundType | undefined;
  readonly stage?: (typeof researchProject.$inferSelect)["stage"] | undefined;
  readonly page?: number | undefined;
  readonly limit?: number | undefined;
}): Promise<readonly FundingDealView[]> {
  const limit = Math.min(options.limit ?? 25, 100);
  const page = Math.max(options.page ?? 1, 1);

  const enabledTypes = options.roundType
    ? config.ENABLED_FUNDING_ROUND_TYPES.filter((type) => type === options.roundType)
    : config.ENABLED_FUNDING_ROUND_TYPES;

  if (enabledTypes.length === 0) {
    return [];
  }

  const filters = [
    eq(fundingRound.status, "open"),
    eq(researchProject.status, "active"),
    // Parameterized, not interpolated. These values come from a Zod enum so a literal
    // would be safe today, but "safe because of where it came from" is a property that
    // survives exactly until someone changes where it comes from.
    inArray(fundingRound.type, [...enabledTypes]),
  ];
  if (options.stage !== undefined) {
    filters.push(eq(researchProject.stage, options.stage));
  }

  const rows = await db
    .select({
      round: fundingRound,
      projectSlug: researchProject.slug,
      projectName: researchProject.name,
      projectStage: researchProject.stage,
      projectTagline: researchProject.tagline,
    })
    .from(fundingRound)
    .innerJoin(researchProject, eq(researchProject.id, fundingRound.projectId))
    .where(and(...filters))
    .orderBy(fundingRound.closesAt, fundingRound.id)
    .limit(limit)
    .offset((page - 1) * limit);

  return rows.map((row) => ({
    ...toRoundView(row.round, row.projectSlug),
    projectName: row.projectName,
    projectStage: row.projectStage,
    projectTagline: row.projectTagline,
  }));
}
