import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { fromDrizzle } from "pg-boss";

import { config } from "#src/config/index.js";
import { db } from "#src/db/index.js";
import {
  escrowJournalEntry,
  fundingRound,
  fundingRoundPledge,
  providerTransfer,
  researchProject,
  user,
} from "#src/db/schema.js";
import { idempotencyKeyFor, JOB_NAMES, sendJob } from "#src/lib/jobs.js";
import { BASIS_POINTS_TOTAL, divRoundHalfAwayFromZero } from "#src/lib/money.js";
import { createTransfer } from "#src/services/escrow-provider-adapter.service.js";
import { appendJournalEntry, appendReversingEntry } from "#src/services/escrow.service.js";
import { appendAuditEntry } from "#src/services/project-audit.service.js";
import type {
  ProjectAccessError,
  ProjectMemberContext,
} from "#src/services/project-membership.service.js";
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
  | { type: "NOT_THE_BACKER" };

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

/** The platform's cut, derived — never sent, never stored on a request. */
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
 * ORDER OF OPERATIONS, and every step of it is §7's:
 *
 *   1. re-bound the amount against the ROUND's own min/max — the client's copy of those
 *      numbers is not consulted;
 *   2. derive the fee from config basis points through src/lib/money.ts;
 *   3. resolve the currency from the round;
 *   4. write `provider_transfer` with OUR randomUUID idempotency key BEFORE any provider
 *      call exists to make;
 *   5. append `pledge_authorized` with settlement `pending`;
 *   6. enqueue the submission INSIDE this transaction, so a job never runs against a
 *      pledge that rolled back and a committed pledge is never left unqueued.
 *
 * The provider call itself happens in a WORKER, never in this request handler.
 *
 * `raisedAmountInCents` DOES NOT MOVE HERE. That is the property §17 step 4 tests.
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

  const platformFeeInCents = derivePlatformFeeInCents(input.amountInCents);
  const netToEscrowInCents = input.amountInCents - platformFeeInCents;
  const occurredAt = new Date();

  const created = await db.transaction(async (tx) => {
    const transfer = await createTransfer(tx, {
      projectId: round.projectId,
      direction: "inbound",
      amountInCents: input.amountInCents,
      currency: round.currency,
    });

    const [pledge] = await tx
      .insert(fundingRoundPledge)
      .values({
        roundId: round.id,
        projectId: round.projectId,
        backerUserId: input.backerUserId,
        amountInCents: input.amountInCents,
        platformFeeInCents,
        netToEscrowInCents,
        currency: round.currency,
        status: "pending",
        providerTransferId: transfer.id,
      })
      .returning();

    if (!pledge) {
      throw new Error("createPledge: insert returned no row");
    }

    await appendJournalEntry(tx, {
      projectId: round.projectId,
      currency: round.currency,
      kind: "pledge_authorized",
      // SERVER-COMPOSED prose. The one deliberate display string in this domain (§7),
      // written here rather than on three clients so web/Kotlin/Swift cannot drift.
      description: `Pledge authorized — ${round.currency} ${input.amountInCents.toString()} toward ${round.title}`,
      settlement: "pending",
      occurredAt,
      postings: [
        { accountKind: "provider_clearing", signedAmountInCents: -input.amountInCents },
        { accountKind: "escrow_held", signedAmountInCents: netToEscrowInCents },
        ...(platformFeeInCents === 0n
          ? []
          : [{ accountKind: "platform_fee" as const, signedAmountInCents: platformFeeInCents }]),
      ],
      linkedPledgeId: pledge.id,
      createdByUserId: input.backerUserId,
      auditEventKind: "pledge_recorded",
      actorRoleSnapshot: "backer",
      auditActionLabel: "Recorded a pledge",
      auditTargetLabel: `pledge ${pledge.id}`,
    });

    // Enlisted in THIS transaction. Outside it you get either a pledge nobody ever submits
    // (the enqueue failed after the commit, invisibly) or a job running against a row that
    // rolled back.
    const enqueued = await sendJob(
      JOB_NAMES.submitProviderTransfer,
      { transferId: transfer.id },
      {
        idempotencyKey: idempotencyKeyFor.submitProviderTransfer(transfer.id),
        // THE point of this whole transaction: the job row and the pledge commit or roll
        // back together.
        db: fromDrizzle(tx, sql),
      },
    );
    if (!enqueued.success) {
      // A pledge whose submission cannot be queued is a pledge that will sit `created`
      // forever with nobody watching. Roll the whole thing back and let the caller retry.
      throw new Error(`createPledge: could not enqueue submission (${enqueued.error.type})`);
    }

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

    const [authorizingEntry] = await tx
      .select({ id: escrowJournalEntry.id })
      .from(escrowJournalEntry)
      .where(
        and(
          eq(escrowJournalEntry.linkedPledgeId, pledge.id),
          eq(escrowJournalEntry.kind, "pledge_authorized"),
        ),
      )
      .orderBy(escrowJournalEntry.sequenceNumber)
      .limit(1);

    const cancelledAt = new Date();

    if (authorizingEntry) {
      await appendReversingEntry(tx, {
        projectId: pledge.projectId,
        reversesJournalEntryId: authorizingEntry.id,
        kind: "pledge_cancelled",
        description: `Pledge cancelled by the backer — authorization released`,
        // `failed` files with the pending bucket, which is where the authorization it
        // cancels lives. See the header of escrow.service.ts.
        settlement: "failed",
        occurredAt: cancelledAt,
        createdByUserId: backerUserId,
        auditEventKind: "pledge_cancelled",
        actorRoleSnapshot: "backer",
        auditActionLabel: "Cancelled a pledge",
        auditTargetLabel: `pledge ${pledge.id}`,
      });
    }

    await tx
      .update(fundingRoundPledge)
      .set({ status: "cancelled", cancelledAt })
      .where(eq(fundingRoundPledge.id, pledgeId));

    // The transfer never went anywhere; mark it so the submit worker skips it. Scoped to
    // the two non-terminal statuses because the identity trigger rejects a transition out
    // of `settled` — and a pledge that settled between the status read above and here is a
    // race we must lose loudly rather than silently un-settle.
    if (pledge.providerTransferId !== null) {
      await tx
        .update(providerTransfer)
        .set({ status: "cancelled" })
        .where(
          and(
            eq(providerTransfer.id, pledge.providerTransferId),
            inArray(providerTransfer.status, ["created", "submitted"]),
          ),
        );
    }

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
 * `GET /funding-rounds/:roundId/backers`.
 *
 * SETTLED PLEDGES ONLY. A pending authorization is not a backer — it is an intent that may
 * still decline — and listing it would let anyone inflate a public backer list for free by
 * pledging and never settling.
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
    .where(and(eq(fundingRoundPledge.roundId, roundId), eq(fundingRoundPledge.status, "settled")))
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
