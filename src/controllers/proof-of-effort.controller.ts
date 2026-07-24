import type { Request, Response } from "express";
import { z } from "zod";

import {
  firstParam,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/controllers/project-error-response.js";
import { respondProofOfEffortError } from "#src/controllers/proof-of-effort-error-response.js";
import * as disputeService from "#src/services/dispute.service.js";
import * as claimsService from "#src/services/effort-claims.service.js";
import * as snapshotService from "#src/services/equity-snapshot.service.js";
import * as rateService from "#src/services/fair-market-rate.service.js";
import * as auditService from "#src/services/project-audit.service.js";
import * as membershipService from "#src/services/project-membership.service.js";
import * as allocationService from "#src/services/slice-allocation.service.js";
import * as ledgerService from "#src/services/slice-ledger.service.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * Proof of Effort (R_AND_D_BACKEND_STRUCTURE.md §9, §11e).
 *
 * THE FIELDS THAT DO NOT EXIST IN ANY SCHEMA HERE, and are therefore 422s rather than
 * silent overwrites (§13). Every one of them is formula-produced:
 *   groundedMinutes · slicesAwarded · sliceNumerator · proposedSlices · escrowedSlices ·
 *   equityBasisPoints · totalSlices · verdict · verificationStatus · entryHash ·
 *   sequenceNumber · windowClosesAt · consensusAdjustedMinutes · currencyCode
 *
 * The client sends **ids and intent**; the server looks every real value up in its own
 * rows. That is §0's answer to "what if the client edits the number and posts it back" —
 * there is no field to edit.
 *
 * THE TWO DELIBERATE EXCEPTIONS, both NEGOTIATED INPUTS rather than derived outputs, and
 * both documented as such in §0 and §13:
 *   1. `fairMarketRateCentsPerHour` + `paidCashRateCentsPerHour` on a rate proposal — a
 *      number two people agreed on, which the server does not own.
 *   2. `scopedWindowStartsAt` / `scopedWindowEndsAt` on a dispute resolution — a TIME
 *      RANGE, not a quantity. The server re-derives the minutes from artifact overlap
 *      inside it (§9.12 option (a)).
 *
 * `currencyCode` is deliberately absent from every schema below even though §11e's table
 * lists it: §4b says an amount's currency is derived from the project, never sent.
 */

const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be an ISO date (YYYY-MM-DD)");

/**
 * Money in, as a decimal STRING rather than a JS number.
 *
 * A rate is a `bigint` cent value; `z.number()` would silently lose precision past 2^53
 * and, worse, would accept `120.5` for a value that must be an integer number of cents.
 */
const CentsStringSchema = z
  .string()
  .regex(/^\d{1,15}$/, "Must be a whole number of cents, as a string");

const PaginationQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export const ProposeRateSchema = z
  .object({
    fairMarketRateCentsPerHour: CentsStringSchema,
    // Zero for the unpaid founder case, which is most of them. Required rather than
    // optional: §9.2 calls the missing paid portion the largest correctness gap in the
    // mock, and a defaulted field is one a founder never has to think about.
    paidCashRateCentsPerHour: CentsStringSchema,
    effectiveFrom: z.iso.datetime(),
    rationaleNote: z.string().trim().min(1).max(1_000),
  })
  .strict();

export const LockRateSchema = z.object({ rateId: z.uuid(), acknowledgement: z.string() }).strict();

export const SubmitClaimSchema = z
  .object({
    sourceKind: z.enum(["daily_log", "physical_receipt"]),
    dailyLogId: z.uuid().optional(),
    physicalReceiptIds: z.array(z.uuid()).max(20).default([]),
    claimedForDate: IsoDateSchema,
    narrative: z.string().trim().max(1_000).optional(),
    idempotencyKey: z.string().trim().min(8).max(128),
  })
  .strict();

export const ReverifySchema = z.object({ reason: z.string().trim().min(1).max(1_000) }).strict();

export const OverrideStepSchema = z
  .object({
    // `pending` is absent: an override that un-decides a step would leave the verdict
    // permanently incomplete, and the CHECK constraint rejects it anyway.
    overriddenStatus: z.enum(["passed", "flagged", "failed", "skipped"]),
    overrideReason: z.string().trim().min(1).max(1_000),
  })
  .strict();

export const RaiseDisputeSchema = z
  .object({ disputeNote: z.string().trim().min(1).max(2_000) })
  .strict();

export const CastVoteSchema = z
  .object({
    position: z.enum(["uphold", "void", "re_verify"]),
    note: z.string().trim().max(2_000).optional(),
  })
  .strict();

export const ResolveDisputeSchema = z
  .object({
    resolution: z.enum(["upheld", "voided", "re_verified"]),
    resolutionNote: z.string().trim().min(1).max(2_000),
    // A WINDOW, never a quantity (§9.12 option (a)).
    scopedWindowStartsAt: z.iso.datetime().optional(),
    scopedWindowEndsAt: z.iso.datetime().optional(),
  })
  .strict();

export const AuditTrailQuerySchema = z
  .object({
    fromSequence: z.coerce.number().int().min(1).optional(),
    toSequence: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export const ProposalListQuerySchema = z
  .object({
    status: z.enum(["open", "disputed", "locked", "consensus_reached"]).optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

interface ProofOfEffortCaller {
  readonly context: membershipService.ProjectMemberContext;
  readonly userId: string;
}

/**
 * Proves membership at `minimumRole`, or writes the response and returns null.
 *
 * Failure is 404 for every case — no such project, not a member, role too low — so a
 * stranger cannot probe which project slugs exist (§4a Layer 2).
 */
async function requireRoleOrRespond(
  req: Request,
  res: Response,
  minimumRole: membershipService.ProjectMemberRole,
): Promise<ProofOfEffortCaller | null> {
  if (!req.user) {
    respondUnauthenticated(res);
    return null;
  }

  const projectSlug = firstParam(req.params.projectSlug ?? "");
  const accessResult = await membershipService.requireProjectRole(
    projectSlug,
    req.user.id,
    minimumRole,
  );

  if (!accessResult.success) {
    respondProofOfEffortError(res, accessResult.error);
    return null;
  }
  return { context: accessResult.value, userId: req.user.id };
}

function respondOk(res: Response, message: string, data: unknown): void {
  res.status(200).json({ status: "success", statusCode: 200, message, data } satisfies ApiResponse);
}

// --- Stakeholder reads. Every §9 number a member can see, and not one of them writable.

/** `GET …/proof-of-effort` — the page's summary read, in one round trip. */
export async function getProofOfEffortSummary(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  const { projectId } = caller.context;
  const [snapshot, openProposals, recentLedger, projection] = await Promise.all([
    snapshotService.findLatestSnapshot(projectId),
    allocationService.listAllocationProposals(projectId, { status: "open", limit: 25 }),
    ledgerService.listLedgerEntries(projectId, { limit: 25 }),
    snapshotService.projectOpenRoleDilution(projectId),
  ]);

  respondOk(res, "Proof of Effort loaded.", {
    // NULL rather than a fabricated zero when no snapshot exists yet: a project with no
    // cap table has no cap table, and rendering 0% per member would be a made-up fact.
    equity: snapshot,
    openProposals,
    recentLedgerEntries: recentLedger,
    // Explicitly OUTSIDE the denominator, and labelled so a client cannot mistake it for
    // an allocation (§9.5).
    openRoleProjection: projection,
  });
}

/** `GET …/equity` — the current cap table. Shares sum to exactly 10000 unless degenerate. */
export async function getEquity(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  respondOk(
    res,
    "Equity loaded.",
    await snapshotService.findLatestSnapshot(caller.context.projectId),
  );
}

/** `GET …/equity/snapshots` — the history of nightly recalculations. */
export async function listEquitySnapshots(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  const parsedQuery = PaginationQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  respondOk(
    res,
    "Equity snapshots loaded.",
    await snapshotService.listSnapshots(caller.context.projectId, parsedQuery.data),
  );
}

/** `GET …/equity/open-role-projection` — the ghost segment that replaces the reserve pool. */
export async function getOpenRoleProjection(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  respondOk(
    res,
    "Open-role projection loaded.",
    await snapshotService.projectOpenRoleDilution(caller.context.projectId),
  );
}

/** `GET …/slice-ledger` — append-only history, ordered by sequenceNumber. */
export async function listSliceLedger(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  const parsedQuery = PaginationQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  respondOk(
    res,
    "Slice ledger loaded.",
    await ledgerService.listLedgerEntries(caller.context.projectId, parsedQuery.data),
  );
}

/** `GET …/allocation-proposals` — `windowClosesAt` is an ISO instant, never a countdown. */
export async function listAllocationProposals(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  const parsedQuery = ProposalListQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  respondOk(
    res,
    "Allocation proposals loaded.",
    await allocationService.listAllocationProposals(caller.context.projectId, parsedQuery.data),
  );
}

// --- The fair market rate. The one place a number legitimately enters via a body.

/** `POST …/members/:memberUserId/fair-market-rate` — founder only. */
export async function proposeFairMarketRate(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "founder");
  if (!caller) return;

  const parsedBody = ProposeRateSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const created = await rateService.proposeFairMarketRate(
    caller.context,
    firstParam(req.params.memberUserId ?? ""),
    // The proposer is the CALLER, from the session. There is no field to send (§13).
    caller.userId,
    caller.context.memberRole,
    {
      fairMarketRateCentsPerHour: BigInt(parsedBody.data.fairMarketRateCentsPerHour),
      paidCashRateCentsPerHour: BigInt(parsedBody.data.paidCashRateCentsPerHour),
      effectiveFrom: new Date(parsedBody.data.effectiveFrom),
      rationaleNote: parsedBody.data.rationaleNote,
    },
  );

  if (!created.success) {
    respondProofOfEffortError(res, created.error);
    return;
  }

  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Rate proposed. It prices nothing until the member accepts and it is locked.",
    data: created.value,
  } satisfies ApiResponse);
}

/** `GET …/members/:memberUserId/fair-market-rate` — the full history. THIS is the promise. */
export async function listFairMarketRateHistory(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  const history = await rateService.listFairMarketRateHistory(
    caller.context.projectId,
    firstParam(req.params.memberUserId ?? ""),
  );

  if (!history.success) {
    respondProofOfEffortError(res, history.error);
    return;
  }
  respondOk(res, "Rate history loaded.", history.value);
}

/**
 * `POST …/members/:memberUserId/fair-market-rate/:rateId/accept` — the subject only.
 *
 * NOT IN §11e's TABLE. Added because the lifecycle cannot complete without it: a rate must
 * be accepted before it can be locked, and §13 describes §0's exception as "a
 * member-ACCEPTED fair market rate". Without this step the founder both sets and ratifies
 * the number.
 */
export async function acceptFairMarketRate(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  const accepted = await rateService.acceptFairMarketRate(
    caller.context,
    firstParam(req.params.rateId ?? ""),
    caller.userId,
    caller.context.memberRole,
  );

  if (!accepted.success) {
    respondProofOfEffortError(res, accepted.error);
    return;
  }
  respondOk(res, "Rate accepted.", accepted.value);
}

/** `POST …/fair-market-rate/lock` — irreversible, and typed acknowledgement required. */
export async function lockFairMarketRate(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "founder");
  if (!caller) return;

  const parsedBody = LockRateSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const locked = await rateService.lockFairMarketRate(
    caller.context,
    parsedBody.data.rateId,
    parsedBody.data.acknowledgement,
    caller.userId,
    caller.context.memberRole,
  );

  if (!locked.success) {
    respondProofOfEffortError(res, locked.error);
    return;
  }
  respondOk(
    res,
    "Rate locked. It is now immutable and prices effort from its effective date.",
    locked.value,
  );
}

// --- Claims. No minutes, no cash, no verdict, no slices — ids and intent only.

/** `POST …/effort-claims` — **202**, a receipt, and a pipeline in flight. Never a verdict. */
export async function submitEffortClaim(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  const parsedBody = SubmitClaimSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const submitted = await claimsService.submitEffortClaim(
    // The claimant is the caller's OWN membership row (§13). There is no field to send.
    { projectId: caller.context.projectId, memberId: caller.context.memberId },
    caller.userId,
    caller.context.memberRole,
    parsedBody.data,
  );

  if (!submitted.success) {
    respondProofOfEffortError(res, submitted.error);
    return;
  }

  res.status(202).json({
    status: "success",
    statusCode: 202,
    message: "Claim accepted. Verification is queued; a 24-hour window opens when it finishes.",
    data: submitted.value,
  } satisfies ApiResponse);
}

/** `GET …/effort-claims/:claimId` — claim + all runs + steps in stepOrder + evidence. */
export async function getEffortClaim(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  const claimId = firstParam(req.params.claimId ?? "");
  const claim = await claimsService.findClaimDetail(caller.context.projectId, claimId);

  if (!claim) {
    respondProofOfEffortError(res, { type: "CLAIM_NOT_FOUND", claimId });
    return;
  }
  respondOk(res, "Effort claim loaded.", claim);
}

/** `POST …/effort-claims/:claimId/reverify` — a NEW run, never an edit. `202`. */
export async function reverifyEffortClaim(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  const parsedBody = ReverifySchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const requeued = await claimsService.requestReverification(
    caller.context,
    firstParam(req.params.claimId ?? ""),
    parsedBody.data.reason,
    caller.userId,
    caller.context.memberRole,
  );

  if (!requeued.success) {
    respondProofOfEffortError(res, requeued.error);
    return;
  }

  res.status(202).json({
    status: "success",
    statusCode: 202,
    message: "Re-verification queued.",
    data: requeued.value,
  } satisfies ApiResponse);
}

/**
 * `PATCH …/effort-claims/:claimId/steps/:stepId/override` — maintainer and above.
 *
 * **The only hand-edit in the domain, and it edits an AI judgement, not a number.** The
 * slice count is recomputed by the formula from the new verdict.
 */
export async function overrideVerificationStep(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "maintainer");
  if (!caller) return;

  const parsedBody = OverrideStepSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const overridden = await claimsService.overrideVerificationStep(
    caller.context,
    firstParam(req.params.claimId ?? ""),
    firstParam(req.params.stepId ?? ""),
    parsedBody.data,
    caller.userId,
    caller.context.memberRole,
  );

  if (!overridden.success) {
    respondProofOfEffortError(res, overridden.error);
    return;
  }
  respondOk(res, "Step overridden. The verdict is being recomputed.", overridden.value);
}

// --- Disputes. Any active member, including the claim's own subject.

/** `POST …/allocation-proposals/:proposalId/dispute` — freezes the slices in escrow. */
export async function raiseDispute(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  const parsedBody = RaiseDisputeSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const raised = await disputeService.raiseDispute(
    caller.context,
    firstParam(req.params.proposalId ?? ""),
    caller.context.memberId,
    parsedBody.data.disputeNote,
    caller.userId,
    caller.context.memberRole,
  );

  if (!raised.success) {
    respondProofOfEffortError(res, raised.error);
    return;
  }

  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Dispute raised. These slices are frozen in escrow until the team agrees.",
    data: raised.value,
  } satisfies ApiResponse);
}

/**
 * `POST …/disputes/:disputeId/withdraw` — the raiser only.
 *
 * NOT IN §11e's TABLE but required by §9.8's state machine. The original window resumes on
 * its ORIGINAL clock: restarting it would let serial withdraw-and-re-dispute hold slices
 * hostage forever.
 */
export async function withdrawDispute(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  const withdrawn = await disputeService.withdrawDispute(
    caller.context,
    firstParam(req.params.disputeId ?? ""),
    caller.context.memberId,
    caller.userId,
    caller.context.memberRole,
  );

  if (!withdrawn.success) {
    respondProofOfEffortError(res, withdrawn.error);
    return;
  }
  respondOk(
    res,
    "Dispute withdrawn. The original window resumes on its original clock.",
    withdrawn.value,
  );
}

/** `POST …/disputes/:disputeId/votes` — one per voter; a majority auto-resolves. */
export async function castDisputeVote(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  const parsedBody = CastVoteSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const voted = await disputeService.castDisputeVote(
    caller.context,
    firstParam(req.params.disputeId ?? ""),
    caller.context.memberId,
    parsedBody.data,
    caller.userId,
    caller.context.memberRole,
  );

  if (!voted.success) {
    respondProofOfEffortError(res, voted.error);
    return;
  }

  res.status(201).json({
    status: "success",
    statusCode: 201,
    message:
      voted.value.autoResolvedAs === null
        ? "Vote recorded."
        : `Vote recorded. A majority resolved this dispute as ${voted.value.autoResolvedAs}.`,
    data: voted.value,
  } satisfies ApiResponse);
}

/**
 * `POST …/disputes/:disputeId/resolve` — founder only.
 *
 * `re_verified` returns **202**, not 200: the number does not exist yet, because a scoped
 * re-verification has to run first (§9.12 option (a)).
 */
export async function resolveDispute(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "founder");
  if (!caller) return;

  const parsedBody = ResolveDisputeSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const resolved = await disputeService.resolveDispute(
    caller.context,
    firstParam(req.params.disputeId ?? ""),
    {
      resolution: parsedBody.data.resolution,
      resolutionNote: parsedBody.data.resolutionNote,
      ...(parsedBody.data.scopedWindowStartsAt === undefined
        ? {}
        : { scopedWindowStartsAt: new Date(parsedBody.data.scopedWindowStartsAt) }),
      ...(parsedBody.data.scopedWindowEndsAt === undefined
        ? {}
        : { scopedWindowEndsAt: new Date(parsedBody.data.scopedWindowEndsAt) }),
    },
    caller.userId,
    caller.context.memberRole,
  );

  if (!resolved.success) {
    respondProofOfEffortError(res, resolved.error);
    return;
  }

  const isPending = parsedBody.data.resolution === "re_verified";
  res.status(isPending ? 202 : 200).json({
    status: "success",
    statusCode: isPending ? 202 : 200,
    message: isPending
      ? "Re-verification queued. The server re-derives the minutes from artifacts inside the agreed window."
      : "Dispute resolved and the allocation settled.",
    data: resolved.value,
  } satisfies ApiResponse);
}

// --- The audit chain. Independently verifiable, or it is decoration.

/** `GET …/audit-trail` — every hashed column, so a client can canonicalize it itself. */
export async function listAuditTrail(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  const parsedQuery = AuditTrailQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  respondOk(
    res,
    "Audit trail loaded.",
    await auditService.listAuditTrail(caller.context.projectId, parsedQuery.data),
  );
}

/**
 * `GET …/audit-trail/verify` — re-walks the chain.
 *
 * A break returns **409 CHAIN_BROKEN**, never `200 {valid:false}` (§9.9). A dashboard
 * polling this endpoint renders a green tick for any 200, so a "successful" failure would
 * be invisible exactly when it matters.
 */
export async function verifyAuditChain(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  const verified = await auditService.verifyAuditChain(caller.context.projectId);
  if (!verified.success) {
    respondProofOfEffortError(res, verified.error);
    return;
  }
  respondOk(res, "Audit chain verified.", verified.value);
}

/**
 * `GET …/audit-trail/:entryId/hash-input` — the anti-theatre endpoint.
 *
 * Returns the exact RFC 8785 bytes that were hashed, so any client can SHA-256 them in
 * five lines and check our arithmetic. A server that grades its own homework proves
 * nothing (§9.9).
 */
export async function getAuditHashInput(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  const hashInput = await auditService.buildHashInputDocument(
    caller.context.projectId,
    firstParam(req.params.entryId ?? ""),
  );

  if (!hashInput.success) {
    respondProofOfEffortError(res, hashInput.error);
    return;
  }
  respondOk(res, "Hash input loaded.", hashInput.value);
}
