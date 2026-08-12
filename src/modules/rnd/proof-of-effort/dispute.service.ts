import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  artifactEvidence,
  dispute,
  disputeVote,
  effortClaim,
  projectMember,
  sliceAllocationProposal,
  user,
} from "#src/db/schema.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import { enqueueNotifications } from "#src/modules/platform/notifications/notifications.service.js";
import { settleProposal } from "#src/modules/rnd/funding/slice-allocation.service.js";
import { appendAuditEntry } from "#src/modules/rnd/projects/project-audit.service.js";
import type { ProjectAccessError } from "#src/modules/rnd/projects/project-membership.service.js";
import {
  createVerificationRun,
  enqueueGroundingInTransaction,
} from "#src/modules/rnd/proof-of-effort/verification.service.js";
import type { Result } from "#src/types/index.js";

/**
 * Disputes and consensus (R_AND_D_BACKEND_STRUCTURE.md §9.8; PROOF_OF_EFFORT_SPEC.md §4's
 * 24-hour transparency ledger).
 *
 * THE FAILSAFE IS SOCIAL, NOT ALGORITHMIC. The AI will occasionally be tricked, so the
 * last layer is the team: a proposed allocation posts publicly for 24 hours, and any
 * active member — including the claim's own subject — can freeze it. Disputed slices sit
 * in escrow, reported SEPARATELY from `totalSlices`, until the team reaches consensus.
 *
 * THE STATE MACHINE, and every rejection it owes a 409 to:
 *   open      → disputed          any active member, inside the window
 *   disputed  → open              WITHDRAWN by the raiser only, on the ORIGINAL clock
 *   disputed  → consensus_reached upheld / voided / re-verified
 *   locked    → nothing           terminal; corrected only by appending a reversal
 *
 * WITHDRAWAL RESUMES THE ORIGINAL CLOCK. `windowClosesAt` is never rewritten — without
 * that rule, serial withdraw-and-re-dispute holds a member's slices hostage forever.
 *
 * NO NUMBER EVER ENTERS THROUGH A RESOLUTION (§9.12, settled as option (a)). `re_verified`
 * accepts a narrowed ISO WINDOW and the server re-derives minutes from artifact overlap
 * inside it. There is no `consensusAdjustedMinutes` column and no request field that could
 * carry one — which is also why a claim whose evidence was purged can resolve `upheld` or
 * `voided` only, and `re_verified` returns 409 EVIDENCE_PURGED.
 */

export type DisputeResolution = (typeof dispute.$inferSelect)["resolution"];
export type DisputeVotePosition = (typeof disputeVote.$inferSelect)["position"];

export type DisputeError =
  | ProjectAccessError
  | { type: "PROPOSAL_NOT_FOUND"; proposalId: string }
  | { type: "DISPUTE_NOT_FOUND"; disputeId: string }
  | { type: "WINDOW_CLOSED"; status: string }
  | { type: "ALREADY_DISPUTED" }
  | { type: "DISPUTE_NOT_OPEN" }
  | { type: "NOT_THE_RAISER" }
  | { type: "ALREADY_VOTED" }
  | { type: "SCOPED_WINDOW_REQUIRED" }
  | { type: "SCOPED_WINDOW_INVALID" }
  | { type: "EVIDENCE_PURGED" }
  | { type: "NOT_AUTHORIZED_TO_RESOLVE" };

export interface DisputeView {
  readonly id: string;
  readonly proposalId: string;
  readonly raisedByMemberId: string;
  readonly raisedByName: string;
  readonly disputeNote: string;
  readonly status: (typeof dispute.$inferSelect)["status"];
  readonly quorumMemberCount: number;
  readonly resolution: DisputeResolution;
  readonly resolutionNote: string | null;
  readonly resolvedAt: Date | null;
  readonly scopedWindowStartsAt: Date | null;
  readonly scopedWindowEndsAt: Date | null;
  readonly createdAt: Date;
  readonly votes: readonly {
    readonly voterMemberId: string;
    readonly voterName: string;
    readonly position: DisputeVotePosition;
    readonly note: string | null;
    readonly castAt: Date;
  }[];
}

/** A simple majority of the roster FROZEN at raise time. */
function majorityThreshold(quorumMemberCount: number): number {
  return Math.floor(quorumMemberCount / 2) + 1;
}

/**
 * `POST …/allocation-proposals/:id/dispute` — freezes the slices in escrow.
 *
 * `quorumMemberCount` is frozen HERE, at raise time. Computing it live would let the
 * roster changing mid-dispute move the majority threshold under a vote already in
 * progress — someone joining could retroactively invalidate a consensus already reached.
 */
export async function raiseDispute(
  context: { readonly projectId: string },
  proposalId: string,
  raisedByMemberId: string,
  disputeNote: string,
  actorUserId: string,
  actorRoleSnapshot: string,
): Promise<Result<DisputeView, DisputeError>> {
  const outcome = await db.transaction(async (tx) => {
    const [proposal] = await tx
      .select()
      .from(sliceAllocationProposal)
      .where(
        and(
          eq(sliceAllocationProposal.id, proposalId),
          eq(sliceAllocationProposal.projectId, context.projectId),
        ),
      )
      .for("update");

    if (!proposal) {
      return { kind: "not-found" } as const;
    }
    if (proposal.status === "disputed") {
      return { kind: "already-disputed" } as const;
    }
    // `locked` and `consensus_reached` are terminal. Correcting a settled allocation is a
    // reversal, not a dispute (§9.8).
    if (proposal.status !== "open") {
      return { kind: "closed", status: proposal.status } as const;
    }
    // Re-read inside the transaction: the sweep may have locked this window microseconds
    // ago, and the read above would not have seen it without the row lock.
    if (proposal.windowClosesAt <= new Date()) {
      return { kind: "closed", status: proposal.status } as const;
    }

    const [{ activeMemberCount }] = await tx
      .select({ activeMemberCount: sql<number>`count(*)::int` })
      .from(projectMember)
      .where(
        and(eq(projectMember.projectId, context.projectId), eq(projectMember.status, "active")),
      );

    // Whose allocation this is. Read from the PROPOSAL's member rather than passed in:
    // the person raising the dispute is usually not the person it is about.
    const [subject] = await tx
      .select({ userId: projectMember.userId })
      .from(projectMember)
      .where(eq(projectMember.id, proposal.memberId));
    const subjectUserId = subject?.userId ?? null;

    const [created] = await tx
      .insert(dispute)
      .values({
        projectId: context.projectId,
        proposalId,
        raisedByMemberId,
        disputeNote,
        status: "open",
        quorumMemberCount: Math.max(activeMemberCount ?? 1, 1),
      })
      .returning({ id: dispute.id });

    if (!created) {
      throw new Error("raiseDispute: insert returned no row");
    }

    await tx
      .update(sliceAllocationProposal)
      .set({
        status: "disputed",
        activeDisputeId: created.id,
        // Reported separately from totalSlices so the UI can say "frozen in escrow"
        // honestly rather than implying the slices are awarded or gone. Equal to the
        // proposed count INCLUDING when that is zero — a flagged-at-zero claim is exactly
        // the case a member most needs to be able to challenge.
        escrowedSlices: proposal.proposedSlices,
      })
      .where(eq(sliceAllocationProposal.id, proposalId));

    // THE MEMBER WHOSE SLICES JUST FROZE. This is the sharpest silence §11l.2 names: a
    // dispute moves someone else's equity into `escrowedSlices` and, until now, told them
    // nothing. `subjectUserId` is read from the proposal's member, not from the actor.
    if (subjectUserId !== null) {
      await enqueueNotifications(tx, actorUserId, [
        {
          recipientUserId: subjectUserId,
          kind: "dispute_raised",
          projectId: context.projectId,
          payload: { disputeId: created.id, proposalId, claimId: proposal.claimId },
        },
      ]);
    }

    await appendAuditEntry(tx, {
      projectId: context.projectId,
      eventKind: "allocation_disputed",
      actorUserId,
      actorRoleSnapshot,
      actionLabel: "Disputed a slice allocation",
      targetLabel: `proposal ${proposalId}`,
      detailNote: disputeNote,
      payload: {
        disputeId: created.id,
        proposalId,
        claimId: proposal.claimId,
        raisedByMemberId,
        escrowedSlices: BigInt(proposal.proposedSlices),
        quorumMemberCount: BigInt(Math.max(activeMemberCount ?? 1, 1)),
      },
      occurredAt: new Date(),
    });

    return { kind: "raised", disputeId: created.id } as const;
  });

  switch (outcome.kind) {
    case "not-found":
      return { success: false, error: { type: "PROPOSAL_NOT_FOUND", proposalId } };
    case "already-disputed":
      return { success: false, error: { type: "ALREADY_DISPUTED" } };
    case "closed":
      return { success: false, error: { type: "WINDOW_CLOSED", status: outcome.status } };
    case "raised": {
      const view = await findDispute(context.projectId, outcome.disputeId);
      if (!view) {
        throw new Error("raiseDispute: created dispute could not be read back");
      }
      return { success: true, value: view };
    }
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled raiseDispute outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * Withdrawal, by the raiser only, before the original window closes.
 *
 * THE ORIGINAL CLOCK RESUMES. `windowClosesAt` is deliberately not touched: restarting it
 * would let serial withdraw-and-re-dispute hold slices hostage indefinitely (§9.8). If the
 * window has already passed while the dispute was live, the next sweep locks it
 * immediately, which is the correct outcome — the challenge was dropped.
 */
export async function withdrawDispute(
  context: { readonly projectId: string },
  disputeId: string,
  actorMemberId: string,
  actorUserId: string,
  actorRoleSnapshot: string,
): Promise<Result<DisputeView, DisputeError>> {
  const outcome = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(dispute)
      .where(and(eq(dispute.id, disputeId), eq(dispute.projectId, context.projectId)))
      .for("update");

    if (!row) {
      return { kind: "not-found" } as const;
    }
    if (row.status !== "open") {
      return { kind: "not-open" } as const;
    }
    if (row.raisedByMemberId !== actorMemberId) {
      return { kind: "not-raiser" } as const;
    }

    const withdrawnAt = new Date();

    await tx
      .update(dispute)
      .set({ status: "withdrawn", withdrawnAt })
      .where(eq(dispute.id, disputeId));

    await tx
      .update(sliceAllocationProposal)
      .set({ status: "open", activeDisputeId: null, escrowedSlices: 0 })
      .where(eq(sliceAllocationProposal.id, row.proposalId));

    await appendAuditEntry(tx, {
      projectId: context.projectId,
      eventKind: "dispute_withdrawn",
      actorUserId,
      actorRoleSnapshot,
      actionLabel: "Withdrew a dispute",
      targetLabel: `dispute ${disputeId}`,
      payload: { disputeId, proposalId: row.proposalId },
      occurredAt: withdrawnAt,
    });

    return { kind: "withdrawn" } as const;
  });

  switch (outcome.kind) {
    case "not-found":
      return { success: false, error: { type: "DISPUTE_NOT_FOUND", disputeId } };
    case "not-open":
      return { success: false, error: { type: "DISPUTE_NOT_OPEN" } };
    case "not-raiser":
      return { success: false, error: { type: "NOT_THE_RAISER" } };
    case "withdrawn": {
      const view = await findDispute(context.projectId, disputeId);
      if (!view) {
        throw new Error("withdrawDispute: dispute could not be read back");
      }
      return { success: true, value: view };
    }
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled withdrawDispute outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export interface VoteOutcome {
  readonly dispute: DisputeView;
  /** Set when this vote reached a majority and resolved the dispute on the spot. */
  readonly autoResolvedAs: DisputeResolution;
}

/**
 * `POST …/disputes/:id/votes` — one vote per voter, and a majority auto-resolves.
 *
 * A `uphold` or `void` majority settles immediately: neither needs a number, so nothing is
 * left for a human to supply. A `re_verify` majority does NOT auto-resolve — re-derivation
 * requires a narrowed window (§9.12 option (a)), and no vote carries one. The founder then
 * calls `/resolve` with the window the team agreed on.
 */
export async function castDisputeVote(
  context: { readonly projectId: string },
  disputeId: string,
  voterMemberId: string,
  input: { readonly position: DisputeVotePosition; readonly note?: string | undefined },
  actorUserId: string,
  actorRoleSnapshot: string,
): Promise<Result<VoteOutcome, DisputeError>> {
  const [row] = await db
    .select()
    .from(dispute)
    .where(and(eq(dispute.id, disputeId), eq(dispute.projectId, context.projectId)));

  if (!row) {
    return { success: false, error: { type: "DISPUTE_NOT_FOUND", disputeId } };
  }
  if (row.status !== "open") {
    return { success: false, error: { type: "DISPUTE_NOT_OPEN" } };
  }

  try {
    await db.transaction(async (tx) => {
      await tx.insert(disputeVote).values({
        disputeId,
        voterMemberId,
        position: input.position,
        note: input.note ?? null,
      });

      await appendAuditEntry(tx, {
        projectId: context.projectId,
        eventKind: "dispute_vote_cast",
        actorUserId,
        actorRoleSnapshot,
        actionLabel: "Voted on a dispute",
        targetLabel: `dispute ${disputeId}`,
        ...(input.note === undefined ? {} : { detailNote: input.note }),
        payload: { disputeId, voterMemberId, position: input.position },
        occurredAt: new Date(),
      });
    });
  } catch (error: unknown) {
    // A vote that can be changed after the fact is not a consensus (§9.8), so the unique
    // index rejects the second one rather than overwriting the first.
    if (isUniqueViolation(error)) {
      return { success: false, error: { type: "ALREADY_VOTED" } };
    }
    throw error;
  }

  const tally = await tallyVotes(disputeId);
  const threshold = majorityThreshold(row.quorumMemberCount);

  if (tally.uphold >= threshold) {
    const resolved = await resolveDispute(
      context,
      disputeId,
      { resolution: "upheld", resolutionNote: "Resolved automatically by a majority vote." },
      actorUserId,
      actorRoleSnapshot,
      { isAutomatic: true },
    );
    if (!resolved.success) return resolved;
    return { success: true, value: { dispute: resolved.value, autoResolvedAs: "upheld" } };
  }

  if (tally.void >= threshold) {
    const resolved = await resolveDispute(
      context,
      disputeId,
      { resolution: "voided", resolutionNote: "Resolved automatically by a majority vote." },
      actorUserId,
      actorRoleSnapshot,
      { isAutomatic: true },
    );
    if (!resolved.success) return resolved;
    return { success: true, value: { dispute: resolved.value, autoResolvedAs: "voided" } };
  }

  const view = await findDispute(context.projectId, disputeId);
  if (!view) {
    throw new Error("castDisputeVote: dispute could not be read back");
  }
  return { success: true, value: { dispute: view, autoResolvedAs: null } };
}

async function tallyVotes(
  disputeId: string,
): Promise<{ readonly uphold: number; readonly void: number; readonly reVerify: number }> {
  const rows = await db
    .select({ position: disputeVote.position, tally: sql<number>`count(*)::int` })
    .from(disputeVote)
    .where(eq(disputeVote.disputeId, disputeId))
    .groupBy(disputeVote.position);

  const countFor = (position: DisputeVotePosition): number =>
    rows.find((row) => row.position === position)?.tally ?? 0;

  return {
    uphold: countFor("uphold"),
    void: countFor("void"),
    reVerify: countFor("re_verify"),
  };
}

export interface ResolveDisputeInput {
  readonly resolution: NonNullable<DisputeResolution>;
  readonly resolutionNote: string;
  /** REQUIRED for `re_verified`, and rejected for the other two. Never a minute count. */
  readonly scopedWindowStartsAt?: Date | undefined;
  readonly scopedWindowEndsAt?: Date | undefined;
}

/**
 * `POST …/disputes/:id/resolve` — founder, or an automatic majority.
 *
 * The three outcomes and what each pays (§9.8):
 *   `upheld`      → released at the FULL frozen amount.
 *   `voided`      → released at ZERO — and a zero-slice entry IS STILL WRITTEN, so the
 *                   sequence has no hole and the member can see the decision.
 *   `re_verified` → a scoped re-verification run settles at the RE-DERIVED number. The
 *                   only path that changes the amount, and it comes from the formula.
 *
 * `re_verified` returns **202**: the number does not exist yet, because the pipeline has
 * to run. The other two return 200 with the settlement done.
 */
export async function resolveDispute(
  context: { readonly projectId: string },
  disputeId: string,
  input: ResolveDisputeInput,
  actorUserId: string,
  actorRoleSnapshot: string,
  options: { readonly isAutomatic?: boolean | undefined } = {},
): Promise<Result<DisputeView, DisputeError>> {
  const [row] = await db
    .select()
    .from(dispute)
    .where(and(eq(dispute.id, disputeId), eq(dispute.projectId, context.projectId)));

  if (!row) {
    return { success: false, error: { type: "DISPUTE_NOT_FOUND", disputeId } };
  }
  if (row.status !== "open") {
    return { success: false, error: { type: "DISPUTE_NOT_OPEN" } };
  }

  if (input.resolution === "re_verified") {
    if (input.scopedWindowStartsAt === undefined || input.scopedWindowEndsAt === undefined) {
      return { success: false, error: { type: "SCOPED_WINDOW_REQUIRED" } };
    }
    if (input.scopedWindowEndsAt <= input.scopedWindowStartsAt) {
      return { success: false, error: { type: "SCOPED_WINDOW_INVALID" } };
    }
  } else if (input.scopedWindowStartsAt !== undefined || input.scopedWindowEndsAt !== undefined) {
    // A window on an uphold or a void would be a value with no effect — and a body field
    // that silently does nothing is how a client ends up believing it set something.
    return { success: false, error: { type: "SCOPED_WINDOW_INVALID" } };
  }

  const [proposal] = await db
    .select()
    .from(sliceAllocationProposal)
    .where(eq(sliceAllocationProposal.id, row.proposalId));

  if (!proposal) {
    return { success: false, error: { type: "PROPOSAL_NOT_FOUND", proposalId: row.proposalId } };
  }

  if (input.resolution === "re_verified") {
    // §9.10's consequence, stated as a rule a human must accept: a claim whose evidence
    // was purged by a consent revocation cannot re-derive a number, so it may resolve
    // `upheld` or `voided` ONLY.
    const [purged] = await db
      .select({ id: artifactEvidence.id })
      .from(artifactEvidence)
      .where(
        and(
          eq(artifactEvidence.claimId, proposal.claimId),
          eq(artifactEvidence.evidenceRetained, false),
        ),
      )
      .limit(1);

    if (purged) {
      return { success: false, error: { type: "EVIDENCE_PURGED" } };
    }
  }

  await db.transaction(async (tx) => {
    const resolvedAt = new Date();

    const [subject] = await tx
      .select({ userId: projectMember.userId })
      .from(projectMember)
      .where(eq(projectMember.id, proposal.memberId));
    const [raiser] = await tx
      .select({ userId: projectMember.userId })
      .from(projectMember)
      .where(eq(projectMember.id, row.raisedByMemberId));
    const subjectUserId = subject?.userId ?? null;
    const raiserUserId = raiser?.userId ?? null;

    await tx
      .update(dispute)
      .set({
        status: "consensus_reached",
        resolution: input.resolution,
        resolutionNote: input.resolutionNote,
        resolvedByUserId: actorUserId,
        resolvedAt,
        ...(input.scopedWindowStartsAt === undefined
          ? {}
          : { scopedWindowStartsAt: input.scopedWindowStartsAt }),
        ...(input.scopedWindowEndsAt === undefined
          ? {}
          : { scopedWindowEndsAt: input.scopedWindowEndsAt }),
      })
      .where(eq(dispute.id, disputeId));

    // BOTH SIDES: the member whose allocation was contested, and whoever raised it. A
    // resolution that only the resolver can see is the §9.8 human-oversight loop closing
    // in private. `enqueueNotifications` drops the actor's own row, so an automatic
    // resolution (actor null) reaches both and a manual one reaches the other party.
    await enqueueNotifications(
      tx,
      options.isAutomatic === true ? null : actorUserId,
      [subjectUserId, raiserUserId]
        .filter((userId): userId is string => userId !== null)
        .map((userId) => ({
          recipientUserId: userId,
          kind: "dispute_resolved" as const,
          projectId: context.projectId,
          payload: { disputeId, proposalId: row.proposalId, resolution: input.resolution },
        })),
    );

    await appendAuditEntry(tx, {
      projectId: context.projectId,
      eventKind: "dispute_resolved",
      actorUserId,
      actorRoleSnapshot,
      actionLabel: options.isAutomatic
        ? "Resolved a dispute by majority vote"
        : "Resolved a dispute",
      targetLabel: `dispute ${disputeId}`,
      detailNote: input.resolutionNote,
      payload: {
        disputeId,
        proposalId: row.proposalId,
        resolution: input.resolution,
        isAutomatic: options.isAutomatic === true,
        scopedWindowStartsAt: input.scopedWindowStartsAt ?? null,
        scopedWindowEndsAt: input.scopedWindowEndsAt ?? null,
      },
      occurredAt: resolvedAt,
    });

    if (input.resolution === "re_verified") {
      // The amount does not exist yet. A scoped run re-derives it from artifact overlap
      // inside the agreed window, and `finalizeClaimVerdict` settles the still-disputed
      // proposal at whatever the formula produces.
      const [claim] = await tx
        .select()
        .from(effortClaim)
        .where(eq(effortClaim.id, proposal.claimId));

      if (!claim) {
        throw new Error(`resolveDispute: dispute ${disputeId} points at a missing claim`);
      }

      const [{ latestAttempt }] = await tx
        .select({ latestAttempt: sql<number>`COALESCE(MAX(attempt_number), 0)::int` })
        .from(sql`claim_verification_run`)
        .where(sql`claim_id = ${proposal.claimId}`);

      const run = await createVerificationRun(tx, {
        claim,
        attemptNumber: (latestAttempt ?? 0) + 1,
        triggeredByUserId: actorUserId,
        triggerReason: `Dispute ${disputeId} resolved as re-verified.`,
        ...(input.scopedWindowStartsAt === undefined
          ? {}
          : { scopedWindowStartsAt: input.scopedWindowStartsAt }),
        ...(input.scopedWindowEndsAt === undefined
          ? {}
          : { scopedWindowEndsAt: input.scopedWindowEndsAt }),
      });

      await tx
        .update(dispute)
        .set({ reverificationRunId: run.runId })
        .where(eq(dispute.id, disputeId));

      await enqueueGroundingInTransaction(tx, run.runId);
      return;
    }

    // `upheld` pays the frozen numbers; `voided` pays zero — and STILL writes an entry, so
    // the sequence has no hole and the decision is visible (§9.8, §9.3's anti-dust rule).
    await settleProposal(tx, {
      proposal,
      amounts:
        input.resolution === "upheld"
          ? {
              timeNumerator: proposal.proposedTimeSliceNumerator,
              cashNumerator: proposal.proposedCashSliceNumerator,
            }
          : { timeNumerator: 0n, cashNumerator: 0n },
      nextStatus: "consensus_reached",
      actorUserId,
      actorRoleSnapshot,
      auditActionLabel:
        input.resolution === "upheld"
          ? "Released disputed slices in full"
          : "Voided a disputed allocation",
      auditDetailNote: input.resolutionNote,
    });
  });

  const view = await findDispute(context.projectId, disputeId);
  if (!view) {
    throw new Error("resolveDispute: dispute could not be read back");
  }
  return { success: true, value: view };
}

/** One dispute with its votes, ordered canonically. */
export interface ListDisputesFilter {
  readonly status?: (typeof dispute.$inferSelect)["status"] | undefined;
  readonly page: number;
  readonly limit: number;
}

export interface DisputePage {
  readonly rows: readonly DisputeView[];
  readonly total: number;
}

/**
 * `GET …/disputes` — the project's disputes, newest first (§11j.2).
 *
 * THE COMPLIANCE READ. Raise, vote, withdraw and resolve all shipped without it, which
 * left a dispute reachable only as an `activeDisputeId` on an allocation proposal — an id
 * and nothing else. §14 and §7A.6 name the dispute UI as the GDPR Art. 22 contestability
 * path and the EU AI Act Art. 14 human-oversight control, and neither can be built against
 * write-only endpoints.
 *
 * ONE QUERY FOR THE PAGE, ONE FOR ALL ITS VOTES. Calling `findDispute` per row would be
 * 2N+1 queries for a screen that shows every dispute on a project.
 *
 * No dedup is needed or wanted on a `status=open` filter: `dispute_proposalId_open_unq` is
 * a partial unique index over exactly that predicate, so at most one open dispute per
 * proposal exists by construction.
 */
export async function listDisputes(
  projectId: string,
  filter: ListDisputesFilter,
): Promise<DisputePage> {
  const conditions = [eq(dispute.projectId, projectId)];
  if (filter.status !== undefined) {
    conditions.push(eq(dispute.status, filter.status));
  }
  const predicate = and(...conditions);

  const [rows, [totalRow]] = await Promise.all([
    db
      .select({ dispute, raisedByName: user.name })
      .from(dispute)
      .innerJoin(projectMember, eq(projectMember.id, dispute.raisedByMemberId))
      .innerJoin(user, eq(user.id, projectMember.userId))
      .where(predicate)
      // §4c rule 4 — ends in a unique column so two disputes raised in the same
      // millisecond never swap places between pages.
      .orderBy(desc(dispute.createdAt), desc(dispute.id))
      .limit(filter.limit)
      .offset((filter.page - 1) * filter.limit),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(dispute)
      .where(predicate),
  ]);

  if (rows.length === 0) {
    return { rows: [], total: totalRow?.total ?? 0 };
  }

  const votes = await db
    .select({
      disputeId: disputeVote.disputeId,
      voterMemberId: disputeVote.voterMemberId,
      voterName: user.name,
      position: disputeVote.position,
      note: disputeVote.note,
      castAt: disputeVote.castAt,
    })
    .from(disputeVote)
    .innerJoin(projectMember, eq(projectMember.id, disputeVote.voterMemberId))
    .innerJoin(user, eq(user.id, projectMember.userId))
    .where(
      inArray(
        disputeVote.disputeId,
        rows.map((row) => row.dispute.id),
      ),
    )
    .orderBy(asc(disputeVote.castAt), asc(disputeVote.id));

  return {
    rows: rows.map((row) =>
      toDisputeView(
        row.dispute,
        row.raisedByName,
        votes.filter((vote) => vote.disputeId === row.dispute.id),
      ),
    ),
    total: totalRow?.total ?? 0,
  };
}

/** Shared by the list and the detail read so the two shapes cannot drift. */
function toDisputeView(
  row: typeof dispute.$inferSelect,
  raisedByName: string,
  votes: readonly DisputeView["votes"][number][],
): DisputeView {
  return {
    id: row.id,
    proposalId: row.proposalId,
    raisedByMemberId: row.raisedByMemberId,
    raisedByName,
    disputeNote: row.disputeNote,
    status: row.status,
    quorumMemberCount: row.quorumMemberCount,
    resolution: row.resolution,
    resolutionNote: row.resolutionNote,
    resolvedAt: row.resolvedAt,
    scopedWindowStartsAt: row.scopedWindowStartsAt,
    scopedWindowEndsAt: row.scopedWindowEndsAt,
    createdAt: row.createdAt,
    votes,
  };
}

/**
 * `GET …/disputes/:disputeId` — the `Result`-returning half of {@link findDispute}, so a
 * controller can hand a miss straight to the mapper (§11j.2).
 */
export async function getDispute(
  projectId: string,
  disputeId: string,
): Promise<Result<DisputeView, DisputeError>> {
  const found = await findDispute(projectId, disputeId);
  if (!found) {
    return { success: false, error: { type: "DISPUTE_NOT_FOUND", disputeId } };
  }
  return { success: true, value: found };
}

export async function findDispute(
  projectId: string,
  disputeId: string,
): Promise<DisputeView | null> {
  const [row] = await db
    .select({ dispute, raisedByName: user.name })
    .from(dispute)
    .innerJoin(projectMember, eq(projectMember.id, dispute.raisedByMemberId))
    .innerJoin(user, eq(user.id, projectMember.userId))
    .where(and(eq(dispute.id, disputeId), eq(dispute.projectId, projectId)));

  if (!row) return null;

  const votes = await db
    .select({
      voterMemberId: disputeVote.voterMemberId,
      voterName: user.name,
      position: disputeVote.position,
      note: disputeVote.note,
      castAt: disputeVote.castAt,
    })
    .from(disputeVote)
    .innerJoin(projectMember, eq(projectMember.id, disputeVote.voterMemberId))
    .innerJoin(user, eq(user.id, projectMember.userId))
    .where(eq(disputeVote.disputeId, disputeId))
    .orderBy(asc(disputeVote.castAt), asc(disputeVote.id));

  return toDisputeView(row.dispute, row.raisedByName, votes);
}
