import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { effortClaim, projectMember, sliceAllocationProposal, user } from "#src/db/schema.js";
import { appendAuditEntry } from "#src/services/project-audit.service.js";
import type { ProjectAccessError } from "#src/services/project-membership.service.js";
import { writeLedgerEntry, type LedgerContribution } from "#src/services/slice-ledger.service.js";

/**
 * The 24-hour transparency window (R_AND_D_BACKEND_STRUCTURE.md §9.8;
 * PROOF_OF_EFFORT_SPEC.md §4's failsafe, which is social rather than algorithmic).
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: **no slices exist until a window locks.** The
 * window is not an annotation on an award — it is a PRECONDITION for one. `finalize-verdict`
 * opens a proposal with `proposedSlices` frozen ON THE PROPOSAL, outside `totalSlices`;
 * only the expiry sweep or a dispute resolution writes to the ledger.
 *
 * A `flagged_for_review` verdict STILL OPENS A WINDOW, at zero slices. The solar mock's
 * "960 slices withheld" entry is exactly that case: a flagged claim does not award, but it
 * does post to the transparency ledger. If flagged claims vanished silently, members would
 * lose contributions with no recourse and no way to know it had happened.
 *
 * `windowClosesAt` is computed in POSTGRES, in UTC, and shipped as an absolute instant.
 * The server never sends a duration — "Locks in 9h 14m" is client arithmetic against the
 * ISO value, and it is wrong the moment it is serialized.
 */

/** §9.8's window. A MINIMUM, never a maximum — a late sweep is always the safe direction. */
export const DISPUTE_WINDOW_HOURS = 24;

type DatabaseExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type ProposalStatus = (typeof sliceAllocationProposal.$inferSelect)["status"];

export type AllocationError =
  | ProjectAccessError
  | { type: "PROPOSAL_NOT_FOUND"; proposalId: string }
  | { type: "WINDOW_CLOSED"; status: ProposalStatus }
  | { type: "ALREADY_DISPUTED" };

export interface OpenProposalInput {
  readonly projectId: string;
  readonly claimId: string;
  readonly memberId: string;
  readonly runId: string;
  readonly verdict: "verified" | "flagged_for_review" | "unverified";
  readonly proposedSlices: number;
  readonly proposedSliceNumerator: bigint;
  /**
   * Frozen SEPARATELY because §9.2 prices time at 2× and cash at 4×, and §9.3 rounds once
   * per ledger entry. A day that was both worked and paid for out of pocket settles as two
   * entries; collapsing them into one numerator would round differently than the ledger.
   */
  readonly proposedTimeSliceNumerator: bigint;
  readonly proposedCashSliceNumerator: bigint;
  readonly fairMarketRateId: string | null;
  readonly actorRoleSnapshot: string;
}

/**
 * Opens the window. Called by `finalize-verdict`, and by NOTHING else — the ledger never
 * creates a proposal, and a proposal is never created by a request.
 *
 * The window closes at `now() + 24 hours` computed BY POSTGRES rather than by the worker's
 * clock: two workers on hosts a few seconds apart would otherwise give two members
 * measurably different windows for work filed at the same instant.
 */
export async function openAllocationProposal(
  tx: DatabaseExecutor,
  input: OpenProposalInput,
): Promise<{ readonly proposalId: string; readonly windowClosesAt: Date }> {
  const [inserted] = await tx
    .insert(sliceAllocationProposal)
    .values({
      projectId: input.projectId,
      claimId: input.claimId,
      memberId: input.memberId,
      runId: input.runId,
      verdict: input.verdict,
      proposedSlices: input.proposedSlices,
      proposedSliceNumerator: input.proposedSliceNumerator,
      proposedTimeSliceNumerator: input.proposedTimeSliceNumerator,
      proposedCashSliceNumerator: input.proposedCashSliceNumerator,
      fairMarketRateId: input.fairMarketRateId,
      status: "open",
      windowClosesAt: sql`now() + interval '${sql.raw(String(DISPUTE_WINDOW_HOURS))} hours'`,
    })
    .returning({
      id: sliceAllocationProposal.id,
      windowClosesAt: sliceAllocationProposal.windowClosesAt,
    });

  if (!inserted) {
    throw new Error("openAllocationProposal: insert returned no row");
  }

  await appendAuditEntry(tx, {
    projectId: input.projectId,
    // System-opened: the pipeline reached a verdict, no human acted.
    actorUserId: null,
    eventKind: "allocation_proposal_opened",
    actorRoleSnapshot: input.actorRoleSnapshot,
    actionLabel: "Opened a slice allocation window",
    targetLabel: `proposal ${inserted.id}`,
    payload: {
      proposalId: inserted.id,
      claimId: input.claimId,
      memberId: input.memberId,
      verdict: input.verdict,
      // FROZEN here, outside totalSlices, until the window locks.
      proposedSlices: BigInt(input.proposedSlices),
      proposedSliceNumerator: input.proposedSliceNumerator,
      windowClosesAt: inserted.windowClosesAt,
    },
    occurredAt: new Date(),
  });

  return { proposalId: inserted.id, windowClosesAt: inserted.windowClosesAt };
}

export interface SettlementOutcome {
  readonly proposalId: string;
  readonly projectId: string;
  readonly ledgerEntryIds: readonly string[];
  readonly slicesAwarded: number;
}

/**
 * How much of a settlement each contribution kind is worth.
 *
 * `settledFraction` is the whole of the difference between the three settlement paths, and
 * it is a RATIO OF THE FROZEN NUMERATORS rather than a fresh computation: `upheld` pays
 * what was proposed, `voided` pays zero, and only `re_verified` produces different
 * numerators — from a re-run of the formula, never from a number a resolver typed.
 */
interface SettlementAmounts {
  readonly timeNumerator: bigint;
  readonly cashNumerator: bigint;
}

/**
 * Settles ONE proposal: writes exactly one ledger entry and flips the proposal terminal.
 *
 * `settledSliceNumerator` is passed explicitly because the three settlement paths pay
 * different numbers and all three must come from the formula:
 *   - expiry            → the frozen `proposedSliceNumerator`
 *   - dispute `upheld`  → the same frozen number
 *   - dispute `voided`  → ZERO, and a zero-slice entry IS STILL WRITTEN (§9.8, §9.3)
 *   - dispute `re_verified` → the number a scoped re-verification re-derived
 *
 * Idempotent by construction: the caller re-asserts the proposal's status inside its own
 * transaction, and `slice_ledger_entry_proposalId_unq` rejects a second entry even if two
 * sweeps somehow raced past that.
 */
export async function settleProposal(
  tx: DatabaseExecutor,
  input: {
    readonly proposal: typeof sliceAllocationProposal.$inferSelect;
    readonly amounts: SettlementAmounts;
    readonly nextStatus: "locked" | "consensus_reached";
    readonly actorUserId: string | null;
    readonly actorRoleSnapshot: string;
    readonly auditActionLabel: string;
    readonly auditDetailNote?: string | undefined;
  },
): Promise<SettlementOutcome> {
  const { proposal } = input;

  const [claim] = await tx.select().from(effortClaim).where(eq(effortClaim.id, proposal.claimId));
  if (!claim) {
    throw new Error(`settleProposal: proposal ${proposal.id} points at a missing claim`);
  }

  // The rate pinned on the proposal, read back for its unpaid portion. Denormalized onto
  // the ledger entry so an auditor need not re-resolve effective dating years later.
  const unpaidRateRow =
    proposal.fairMarketRateId === null
      ? null
      : ((
          await tx.execute<{ unpaid: string }>(
            sql`SELECT GREATEST(fair_market_rate_cents_per_hour - paid_cash_rate_cents_per_hour, 0)::text AS unpaid
                  FROM member_fair_market_rate WHERE id = ${proposal.fairMarketRateId}`,
          )
        ).rows[0]?.unpaid ?? null);

  // The day CLAIMED, not the instant the sweep happened to run. A worker down six hours
  // must not move six hours of contributions into the wrong day.
  const occurredAt = new Date(`${claim.claimedForDate}T00:00:00.000Z`);

  const contributions: LedgerContribution[] = [];

  // A time entry is written whenever the claim RECORDED time, even at zero slices —
  // §9.3's anti-dust rule. A voided dispute settles to a visible zero rather than to
  // silence, which is the member's proof the claim was seen and decided.
  if (claim.groundedMinutes !== null || claim.overriddenMinutes !== null) {
    if (proposal.fairMarketRateId === null || unpaidRateRow === null) {
      throw new Error(
        `settleProposal: proposal ${proposal.id} settles time with no pinned fair market rate`,
      );
    }
    contributions.push({
      kind: "time",
      effortMinutes: claim.overriddenMinutes ?? claim.groundedMinutes ?? 0,
      unpaidRateCentsPerHour: BigInt(unpaidRateRow),
      fairMarketRateId: proposal.fairMarketRateId,
    });
  }

  if ((claim.groundedCashInCents ?? 0n) > 0n) {
    contributions.push({ kind: "cash", cashInCents: claim.groundedCashInCents ?? 0n });
  }

  const ledgerEntryIds: string[] = [];
  let slicesAwarded = 0;
  let lastEntryId: string | null = null;

  for (const contribution of contributions) {
    const entry = await writeLedgerEntry(tx, {
      projectId: proposal.projectId,
      memberId: proposal.memberId,
      claimId: proposal.claimId,
      proposalId: proposal.id,
      // The FROZEN numerator for this kind. Rounded independently, because the ledger
      // rounds once per entry (§9.3 rule 1).
      sliceNumerator:
        contribution.kind === "time" ? input.amounts.timeNumerator : input.amounts.cashNumerator,
      contribution,
      occurredAt,
      actorUserId: input.actorUserId,
      actorRoleSnapshot: input.actorRoleSnapshot,
      auditActionLabel: input.auditActionLabel,
      ...(input.auditDetailNote === undefined ? {} : { auditDetailNote: input.auditDetailNote }),
    });
    ledgerEntryIds.push(entry.id);
    slicesAwarded += entry.slicesAwarded;
    lastEntryId = entry.id;
  }

  if (lastEntryId === null) {
    // Unreachable in practice: `finalize-verdict` always records at least a grounded
    // minute count. Failing loudly beats writing a `locked` proposal whose CHECK requires
    // a settled entry it does not have.
    throw new Error(`settleProposal: proposal ${proposal.id} has nothing to settle`);
  }

  await tx
    .update(sliceAllocationProposal)
    .set({
      status: input.nextStatus,
      settledLedgerEntryId: lastEntryId,
      // Escrow is released by settling: the slices are in the ledger now, so nothing is
      // frozen. `proposal_escrow_zero` requires this to be 0 outside `disputed`.
      escrowedSlices: 0,
      activeDisputeId: null,
      ...(input.nextStatus === "locked"
        ? { lockedAt: new Date() }
        : { consensusReachedAt: new Date() }),
    })
    .where(eq(sliceAllocationProposal.id, proposal.id));

  return { proposalId: proposal.id, projectId: proposal.projectId, ledgerEntryIds, slicesAwarded };
}

/**
 * The expiry sweep (§9.8). Locks every window whose 24 hours have elapsed with no dispute.
 *
 * THIS IS THE DEFAULT PATH, so it must be boring and reliable. Three properties that are
 * easy to get wrong and are all deliberate here:
 *
 *  - **Downtime loses nothing.** The sweep queries PERSISTED STATE, not a timer. A worker
 *    down six hours locks six hours of backlog on restart, all at correct amounts.
 *  - **24 hours is a minimum, never a maximum.** A late sweep leaves a window open longer,
 *    which is always the safe direction. NEVER pre-lock.
 *  - **`FOR UPDATE SKIP LOCKED`, and `status = 'open'` re-asserted INSIDE the
 *    transaction.** A dispute may land microseconds before the lock; without the
 *    re-assertion the sweep would settle a proposal that is no longer settleable.
 *
 * Each proposal settles in its OWN transaction. One row that cannot settle must not roll
 * back the other forty-nine in the batch.
 */
export async function sweepExpiredWindows(
  asOf: Date,
  batchSize = 50,
): Promise<{ readonly settled: readonly SettlementOutcome[]; readonly skipped: number }> {
  const candidates = await db
    .select({ id: sliceAllocationProposal.id })
    .from(sliceAllocationProposal)
    .where(
      and(
        eq(sliceAllocationProposal.status, "open"),
        lte(sliceAllocationProposal.windowClosesAt, asOf),
        isNull(sliceAllocationProposal.activeDisputeId),
      ),
    )
    // Canonical, total ordering: oldest window first, then a unique column (§4c rule 4).
    .orderBy(asc(sliceAllocationProposal.windowClosesAt), asc(sliceAllocationProposal.id))
    .limit(batchSize);

  const settled: SettlementOutcome[] = [];
  let skipped = 0;

  for (const candidate of candidates) {
    const outcome = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(sliceAllocationProposal)
        .where(eq(sliceAllocationProposal.id, candidate.id))
        .for("update", { skipLocked: true });

      // Another worker holds it, or a dispute landed between the scan and this lock.
      // Both are ordinary and both mean "not ours to settle".
      if (!locked || locked.status !== "open" || locked.activeDisputeId !== null) {
        return null;
      }
      if (locked.windowClosesAt > asOf) {
        return null;
      }

      return settleProposal(tx, {
        proposal: locked,
        // The FROZEN numbers. The window closing changes nothing about the amount — that
        // is the entire promise the transparency ledger makes.
        amounts: {
          timeNumerator: locked.proposedTimeSliceNumerator,
          cashNumerator: locked.proposedCashSliceNumerator,
        },
        nextStatus: "locked",
        actorUserId: null,
        actorRoleSnapshot: "system",
        auditActionLabel: "Locked an unchallenged allocation window",
        auditDetailNote: `Window closed at ${locked.windowClosesAt.toISOString()} with no dispute.`,
      });
    });

    if (outcome === null) {
      skipped += 1;
      continue;
    }
    settled.push(outcome);
  }

  return { settled, skipped };
}

export interface AllocationProposalView {
  readonly id: string;
  readonly claimId: string;
  readonly memberId: string;
  readonly memberName: string;
  readonly verdict: (typeof sliceAllocationProposal.$inferSelect)["verdict"];
  readonly proposedSlices: number;
  readonly proposedSliceNumerator: string;
  readonly status: ProposalStatus;
  readonly windowOpensAt: Date;
  /** An ISO instant, NEVER a countdown string. The client counts down (§1). */
  readonly windowClosesAt: Date;
  readonly escrowedSlices: number;
  readonly activeDisputeId: string | null;
  readonly settledLedgerEntryId: string | null;
  readonly claimSummary: string;
  readonly claimedForDate: string;
}

const DEFAULT_PROPOSAL_PAGE_SIZE = 25;
const MAXIMUM_PROPOSAL_PAGE_SIZE = 100;

/** `GET …/allocation-proposals` — the transparency ledger the team actually watches. */
export async function listAllocationProposals(
  projectId: string,
  options: {
    readonly status?: ProposalStatus | undefined;
    readonly page?: number | undefined;
    readonly limit?: number | undefined;
  } = {},
): Promise<readonly AllocationProposalView[]> {
  const limit = Math.min(options.limit ?? DEFAULT_PROPOSAL_PAGE_SIZE, MAXIMUM_PROPOSAL_PAGE_SIZE);
  const page = Math.max(options.page ?? 1, 1);

  const filters = [eq(sliceAllocationProposal.projectId, projectId)];
  if (options.status !== undefined) {
    filters.push(eq(sliceAllocationProposal.status, options.status));
  }

  const rows = await db
    .select({
      id: sliceAllocationProposal.id,
      claimId: sliceAllocationProposal.claimId,
      memberId: sliceAllocationProposal.memberId,
      memberName: user.name,
      verdict: sliceAllocationProposal.verdict,
      proposedSlices: sliceAllocationProposal.proposedSlices,
      proposedSliceNumerator: sliceAllocationProposal.proposedSliceNumerator,
      status: sliceAllocationProposal.status,
      windowOpensAt: sliceAllocationProposal.windowOpensAt,
      windowClosesAt: sliceAllocationProposal.windowClosesAt,
      escrowedSlices: sliceAllocationProposal.escrowedSlices,
      activeDisputeId: sliceAllocationProposal.activeDisputeId,
      settledLedgerEntryId: sliceAllocationProposal.settledLedgerEntryId,
      claimSummary: effortClaim.claimSummary,
      claimedForDate: effortClaim.claimedForDate,
    })
    .from(sliceAllocationProposal)
    .innerJoin(effortClaim, eq(effortClaim.id, sliceAllocationProposal.claimId))
    .innerJoin(projectMember, eq(projectMember.id, sliceAllocationProposal.memberId))
    .innerJoin(user, eq(user.id, projectMember.userId))
    .where(and(...filters))
    // Newest window first, ending in a unique column so a page boundary is stable.
    .orderBy(sql`${sliceAllocationProposal.windowClosesAt} DESC`, asc(sliceAllocationProposal.id))
    .limit(limit)
    .offset((page - 1) * limit);

  return rows.map((row) => ({
    ...row,
    proposedSliceNumerator: row.proposedSliceNumerator.toString(),
  }));
}

/** One proposal, scoped to its project so an id from elsewhere reads as absent. */
export async function findProposal(
  projectId: string,
  proposalId: string,
): Promise<typeof sliceAllocationProposal.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(sliceAllocationProposal)
    .where(
      and(
        eq(sliceAllocationProposal.id, proposalId),
        eq(sliceAllocationProposal.projectId, projectId),
      ),
    );

  return row ?? null;
}
