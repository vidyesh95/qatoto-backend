import type { Request, Response } from "express";

import { config } from "#src/config/index.js";
import { decodeDateCursor } from "#src/lib/date-cursor.js";
import { exchangeCodeForToken, fetchViewerLogin } from "#src/lib/github-integration.js";
import { decodeInstantCursor } from "#src/lib/instant-cursor.js";
import * as snapshotService from "#src/modules/rnd/funding/equity-snapshot.service.js";
import * as rateService from "#src/modules/rnd/funding/fair-market-rate.service.js";
import * as bakeService from "#src/modules/rnd/funding/pie-bake.service.js";
import * as allocationService from "#src/modules/rnd/funding/slice-allocation.service.js";
import * as ledgerService from "#src/modules/rnd/funding/slice-ledger.service.js";
import * as auditService from "#src/modules/rnd/projects/project-audit.service.js";
import {
  firstParam,
  optionalBody,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/rnd/projects/project-error-response.js";
import * as membershipService from "#src/modules/rnd/projects/project-membership.service.js";
import * as disputeService from "#src/modules/rnd/proof-of-effort/dispute.service.js";
import * as claimsService from "#src/modules/rnd/proof-of-effort/effort-claims.service.js";
import * as integrationService from "#src/modules/rnd/proof-of-effort/integration-consent.service.js";
import * as receiptsService from "#src/modules/rnd/proof-of-effort/physical-receipts.service.js";
import { respondProofOfEffortError } from "#src/modules/rnd/proof-of-effort/proof-of-effort-error-response.js";
import {
  AuditTrailQuerySchema,
  AuthorizeIntegrationSchema,
  BakePieSchema,
  CastVoteSchema,
  CreateSuggestionSchema,
  DecideSuggestionSchema,
  DisputeListQuerySchema,
  EffortClaimListQuerySchema,
  IntegrationCallbackQuerySchema,
  IntegrationProviderSchema,
  LockRateSchema,
  OverrideQueueQuerySchema,
  OverrideStepSchema,
  PaginationQuerySchema,
  ProposalListQuerySchema,
  ProposeRateSchema,
  RaiseDisputeSchema,
  ResolveDisputeSchema,
  ReverifySchema,
  SequencePaginationQuerySchema,
  SubmitClaimSchema,
  UploadReceiptSchema,
} from "#src/modules/rnd/proof-of-effort/proof-of-effort.schemas.js";
import * as suggestionsService from "#src/services/optimization-suggestions.service.js";
import type { ApiResponse, PaginatedResponse } from "#src/types/index.js";

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
    // `.rows` on both: the ledger and the proposal read each gained a keyset envelope
    // (§11l.2 item 4). The SUMMARY's wire shape is unchanged — these stay bare arrays of
    // the newest entries, and a summary card does not page.
    openProposals: openProposals.rows,
    recentLedgerEntries: recentLedger.rows,
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

  const parsedQuery = SequencePaginationQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const ledger = await ledgerService.listLedgerEntries(caller.context.projectId, parsedQuery.data);

  // `data` STAYS THE ARRAY, and `nextSequence` rides alongside it — the shape
  // `PaginatedResponse` already uses for `pagination`. Moving the rows under an envelope
  // key would break every caller parsing this read today, which §11l is not allowed to do.
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Slice ledger loaded.",
    data: ledger.rows,
    nextSequence: ledger.nextSequence,
  });
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

  const { cursor: rawCursor, ...pageOptions } = parsedQuery.data;

  // Decoded HERE rather than in the service: CLAUDE.md §3.1 puts parsing of untrusted input
  // at the controller boundary, so the service receives a typed cursor or nothing at all.
  const decodedCursor = rawCursor === undefined ? undefined : decodeInstantCursor(rawCursor);
  if (rawCursor !== undefined && decodedCursor === null) {
    // 422 and NEVER a silent first page: a client that restarts a feed it thought it was
    // paging shows duplicates and reports them as a backend bug (§11h).
    res.status(422).json({
      status: "error",
      statusCode: 422,
      message: "Malformed cursor.",
    } satisfies ApiResponse);
    return;
  }

  const proposals = await allocationService.listAllocationProposals(caller.context.projectId, {
    ...pageOptions,
    ...(decodedCursor === null || decodedCursor === undefined ? {} : { cursor: decodedCursor }),
  });

  // `data` STAYS THE ARRAY and `nextCursor` rides alongside it, exactly as the slice ledger
  // does above. Moving the rows under an envelope key would break every client parsing this
  // read today, which §11l is not allowed to do.
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Allocation proposals loaded.",
    data: proposals.rows,
    nextCursor: proposals.nextCursor,
  });
}

/**
 * `GET …/override-queue` — the steps a human has been asked to look at and has not answered.
 *
 * The oversight surface the EU AI Act Art. 14 control needs to be REACHABLE (§9.8, §11l).
 * `?status=flagged_for_review` on the claims list approximates it and cannot express the
 * distinction that matters: a claim can have one step already answered and another still
 * waiting, and the reviewer needs the step.
 *
 * Member-scoped like every other §9 read — the whole team can see what is waiting on a
 * human, which is the same transparency posture the slice ledger and the claims list take.
 */
export async function listOverrideQueue(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  const parsedQuery = OverrideQueueQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  respondOk(
    res,
    "Override queue loaded.",
    await claimsService.listOverrideQueue(caller.context.projectId, {
      limit: parsedQuery.data.limit,
    }),
  );
}

/**
 * `GET …/allocation-proposals/:proposalId` — one proposal, member only.
 *
 * A dispute names its proposal by id and nothing more, so without this the dispute tab can
 * only match the two by eye (Appendix D4). Absent and belonging-to-another-project are the
 * same `404`: the service scopes the lookup by project, so this read cannot be used to learn
 * that a proposal exists somewhere else.
 */
export async function getAllocationProposal(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  const proposalId = firstParam(req.params.proposalId ?? "");
  const proposal = await allocationService.findAllocationProposalView(
    caller.context.projectId,
    proposalId,
  );

  if (!proposal) {
    respondProofOfEffortError(res, { type: "PROPOSAL_NOT_FOUND", proposalId });
    return;
  }
  respondOk(res, "Allocation proposal loaded.", proposal);
}

/**
 * GET /research-projects/:projectSlug/disputes — member only (§11j.2).
 *
 * The read half of a domain that shipped raise, vote, withdraw and resolve without one.
 * §14 and §7A.6 name this the GDPR Art. 22 contestability path and the EU AI Act Art. 14
 * human-oversight control; neither is buildable against write-only endpoints.
 */
export async function listDisputes(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  const parsedQuery = DisputeListQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const { page, limit, status } = parsedQuery.data;
  const disputePage = await disputeService.listDisputes(caller.context.projectId, {
    ...(status === undefined ? {} : { status }),
    page,
    limit,
  });

  const response: PaginatedResponse = {
    status: "success",
    statusCode: 200,
    message: "Disputes loaded.",
    data: [...disputePage.rows],
    pagination: {
      page,
      limit,
      total: disputePage.total,
      totalPages: Math.ceil(disputePage.total / limit),
    },
  };
  res.status(200).json(response);
}

/** GET /research-projects/:projectSlug/disputes/:disputeId — member only (§11j.2). */
export async function getDispute(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  const disputeId = firstParam(req.params.disputeId ?? "");
  const found = await disputeService.getDispute(caller.context.projectId, disputeId);

  if (!found.success) {
    respondProofOfEffortError(res, found.error);
    return;
  }
  respondOk(res, "Dispute loaded.", found.value);
}

/**
 * GET /research-projects/:projectSlug/effort-claims — member only (§11j.2).
 *
 * Any member may list any member's claims, matching the allocation-proposal read above and
 * §9's transparency posture: people sharing one pie can audit what each was credited for.
 */
export async function listEffortClaims(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  const parsedQuery = EffortClaimListQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const { page, limit, status, memberUserId, cursor: rawCursor } = parsedQuery.data;

  // Decoded HERE rather than in the service: CLAUDE.md §3.1 puts parsing of untrusted input
  // at the controller boundary, so the service receives a typed cursor or nothing at all.
  const decodedCursor = rawCursor === undefined ? undefined : decodeDateCursor(rawCursor);
  if (rawCursor !== undefined && decodedCursor === null) {
    // 422 and NEVER a silent first page, the same contract the inbox and the proposal ledger
    // answer with (§11h).
    res.status(422).json({
      status: "error",
      statusCode: 422,
      message: "Malformed cursor.",
    } satisfies ApiResponse);
    return;
  }

  const claimPage = await claimsService.listClaims(caller.context.projectId, {
    ...(status === undefined ? {} : { status }),
    ...(memberUserId === undefined ? {} : { memberUserId }),
    ...(decodedCursor === null || decodedCursor === undefined ? {} : { cursor: decodedCursor }),
    page,
    limit,
  });

  // KEYSET MODE DROPS `pagination` RATHER THAN FAKING IT. The block's `total`/`totalPages`
  // require the COUNT this mode deliberately skips, and emitting zeroes would render as "no
  // claims" beneath a list of claims.
  //
  // OFFSET MODE CARRIES `nextCursor` TOO, and that is what makes keyset mode reachable. It
  // used to omit it, which left the cursor with no entrance: a first request carries no
  // cursor by definition, so a client could never obtain the one it needed to send. Both
  // fields are honest together here — offset mode runs the COUNT, so `total` is real, and the
  // service fetches one extra row, so `nextCursor` is real. Adding a field is additive: a
  // client parsing `data` and `pagination` does not see it.
  if (claimPage.total === null) {
    res.status(200).json({
      status: "success",
      statusCode: 200,
      message: "Effort claims loaded.",
      data: [...claimPage.rows],
      nextCursor: claimPage.nextCursor,
    });
    return;
  }

  const response: PaginatedResponse & { nextCursor: string | null } = {
    status: "success",
    statusCode: 200,
    message: "Effort claims loaded.",
    data: [...claimPage.rows],
    pagination: {
      page,
      limit,
      total: claimPage.total,
      totalPages: Math.ceil(claimPage.total / limit),
    },
    nextCursor: claimPage.nextCursor,
  };
  res.status(200).json(response);
}

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
 * `GET …/:projectSlug/fair-market-rates` — every active member's current rate, one request.
 *
 * The roster panel the slice ledger wanted (Appendix D2). Member-scoped like the per-member
 * history beside it: §11e's transparency promise is that every member sees every rate, so
 * this exposes no more than one call per teammate already would.
 */
export async function listProjectFairMarketRates(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  respondOk(
    res,
    "Fair market rates loaded.",
    await rateService.listProjectFairMarketRates(caller.context.projectId),
  );
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

/** `GET …/audit-trail` — every hashed column, so a client can canonicalize it itself. */
export async function listAuditTrail(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  const parsedQuery = AuditTrailQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const trail = await auditService.listAuditTrail(caller.context.projectId, parsedQuery.data);

  // `data` stays the array; `nextSequence` rides alongside so a client can tell the end of
  // the chain from the end of a page (§11l.2 item 4).
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Audit trail loaded.",
    data: trail.rows,
    nextSequence: trail.nextSequence,
  });
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

/**
 * `POST …/physical-receipts` — multipart, **202**.
 *
 * 202 rather than 201 because a receipt is EVIDENCE AWAITING A CLAIM, not a claim: nothing
 * is priced until a member cites it. `sizeBytes`, dimensions, both hashes and the capture
 * time are all measured here and appear in no request field.
 */
export async function uploadPhysicalReceipt(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  const parsedBody = UploadReceiptSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  if (!req.file) {
    respondProofOfEffortError(res, { type: "RECEIPT_FILE_MISSING" });
    return;
  }

  const uploaded = await receiptsService.uploadReceipt(
    { projectId: caller.context.projectId, memberId: caller.context.memberId },
    req.file.buffer,
    parsedBody.data,
  );

  if (!uploaded.success) {
    respondProofOfEffortError(res, uploaded.error);
    return;
  }

  res.status(202).json({
    status: "success",
    statusCode: 202,
    message: "Receipt stored and analyzed. Cite it in an effort claim to have it priced.",
    data: uploaded.value,
  } satisfies ApiResponse);
}

/** `GET …/physical-receipts` — the caller's OWN unclaimed receipts. */
export async function listPhysicalReceipts(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  respondOk(
    res,
    "Receipts loaded.",
    await receiptsService.listUnclaimedReceipts(
      caller.context.projectId,
      // Scoped to the caller: a receipt is evidence about one person's work, and listing
      // everyone's would tell a member which photographs to cite.
      caller.context.memberId,
    ),
  );
}

/**
 * DELETE …/physical-receipts/:receiptId — the uploader only (§11j.3).
 *
 * Uploader scoping is a WHERE predicate in the service, so another member's receipt answers
 * the same 404 as one that never existed. A receipt already cited by an effort claim is a
 * 409: at that point the bytes are evidence.
 */
export async function deletePhysicalReceipt(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  const receiptId = firstParam(req.params.receiptId ?? "");
  const deleted = await receiptsService.deleteReceipt(
    caller.context.projectId,
    caller.context.memberId,
    receiptId,
  );

  if (!deleted.success) {
    respondProofOfEffortError(res, deleted.error);
    return;
  }
  respondOk(res, "Receipt deleted.", deleted.value);
}

/**
 * GET …/physical-receipts/:receiptId — the caller's OWN receipt (§11j.2).
 *
 * Scoped to `memberId` for the same reason the list is: another member's receipt reads as
 * absent, so this cannot be used to discover which photographs exist to cite.
 */
export async function getPhysicalReceipt(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  const receiptId = firstParam(req.params.receiptId ?? "");
  const receipt = await receiptsService.findOwnReceipt(
    caller.context.projectId,
    caller.context.memberId,
    receiptId,
  );

  if (!receipt) {
    respondProofOfEffortError(res, { type: "RECEIPT_NOT_FOUND", receiptId });
    return;
  }
  respondOk(res, "Receipt loaded.", receipt);
}

/** `GET …/integrations` — the caller's own grants, never anyone else's, never a token. */
export async function listIntegrations(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  respondOk(
    res,
    "Integrations loaded.",
    await integrationService.listGrants(caller.context.projectId, caller.context.memberId),
  );
}

/**
 * `GET …/integrations/available` — the provider catalogue behind the consent screen.
 *
 * Closes the circularity §11l records: the grants read alone cannot tell a member whether a
 * provider they have never connected is even configured here, and the authorize-url call
 * cannot be made without knowing that. Same membership gate as the grants read — the
 * response carries the caller's own grants and nobody else's.
 */
export async function listAvailableIntegrations(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  respondOk(
    res,
    "Available integrations loaded.",
    await integrationService.listAvailableProviders(
      caller.context.projectId,
      caller.context.memberId,
    ),
  );
}

/** `POST …/integrations/:provider/authorize-url` — `503` when the provider is unconfigured. */
export async function createIntegrationAuthorizeUrl(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  const parsedProvider = IntegrationProviderSchema.safeParse(req.params.provider);
  if (!parsedProvider.success) {
    respondValidationFailed(res, parsedProvider.error);
    return;
  }

  const parsedBody = AuthorizeIntegrationSchema.safeParse(optionalBody(req));
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const authorizeUrl = await integrationService.buildAuthorizeUrl(
    { projectId: caller.context.projectId, memberId: caller.context.memberId },
    parsedProvider.data,
    parsedBody.data.requestedResourceIds,
  );

  if (!authorizeUrl.success) {
    respondProofOfEffortError(res, authorizeUrl.error);
    return;
  }
  respondOk(res, "Authorization link created.", authorizeUrl.value);
}

/**
 * `DELETE …/integrations/:provider` — SELF ONLY, and it never touches equity.
 *
 * The response names how many claims can no longer be re-checked, because §9.10 asks for
 * exactly that sentence at the moment of revocation: "Revoking means these 47 claims can no
 * longer be re-checked if challenged."
 */
export async function revokeIntegration(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  const parsedProvider = IntegrationProviderSchema.safeParse(req.params.provider);
  if (!parsedProvider.success) {
    respondValidationFailed(res, parsedProvider.error);
    return;
  }

  const revoked = await integrationService.revokeGrant(
    { projectId: caller.context.projectId, memberId: caller.context.memberId },
    parsedProvider.data,
    caller.userId,
    caller.context.memberRole,
  );

  if (!revoked.success) {
    respondProofOfEffortError(res, revoked.error);
    return;
  }

  respondOk(
    res,
    `Connection revoked. ${revoked.value.claimsNoLongerReVerifiable} claim(s) can no longer be re-verified if challenged. No slices were reversed.`,
    revoked.value,
  );
}

/** `GET …/pie-bake` — the frozen cap table, or null while equity is still dynamic. */
export async function getPieBake(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  respondOk(res, "Pie bake loaded.", await bakeService.findPieBake(caller.context.projectId));
}

/** `POST …/pie-bake` — founder only. There is no unbake endpoint. */
export async function bakePie(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "founder");
  if (!caller) return;

  const parsedBody = BakePieSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const baked = await bakeService.bakePie(
    caller.context,
    {
      trigger: parsedBody.data.trigger,
      triggerEvidenceNote: parsedBody.data.triggerEvidenceNote,
      ...(parsedBody.data.valuationCents === undefined
        ? {}
        : { valuationCents: BigInt(parsedBody.data.valuationCents) }),
      acknowledgement: parsedBody.data.acknowledgement,
      expectedSnapshotId: parsedBody.data.expectedSnapshotId,
    },
    caller.userId,
    caller.context.memberRole,
  );

  if (!baked.success) {
    respondProofOfEffortError(res, baked.error);
    return;
  }

  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "The pie is baked. Equity is frozen permanently and no longer accrues.",
    data: baked.value,
  } satisfies ApiResponse);
}

export async function listOptimizationSuggestions(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  respondOk(
    res,
    "Suggestions loaded.",
    await suggestionsService.listSuggestions(caller.context.projectId),
  );
}

export async function createOptimizationSuggestion(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "maintainer");
  if (!caller) return;

  const parsedBody = CreateSuggestionSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const created = await suggestionsService.createSuggestion(caller.context, parsedBody.data);
  if (!created.success) {
    respondProofOfEffortError(res, created.error);
    return;
  }

  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Suggestion recorded.",
    data: created.value,
  } satisfies ApiResponse);
}

/** `POST …/:id/accept` and `…/:id/dismiss` — one decision, recorded once. */
export function decideOptimizationSuggestion(
  decision: "accepted" | "dismissed",
): (req: Request, res: Response) => Promise<void> {
  return async (req: Request, res: Response): Promise<void> => {
    const caller = await requireRoleOrRespond(req, res, "maintainer");
    if (!caller) return;

    const parsedBody = DecideSuggestionSchema.safeParse(optionalBody(req));
    if (!parsedBody.success) {
      respondValidationFailed(res, parsedBody.error);
      return;
    }

    const decided = await suggestionsService.decideSuggestion(
      caller.context,
      firstParam(req.params.suggestionId ?? ""),
      decision,
      caller.userId,
      parsedBody.data.note ?? null,
    );

    if (!decided.success) {
      respondProofOfEffortError(res, decided.error);
      return;
    }
    respondOk(res, `Suggestion ${decision}.`, decided.value);
  };
}

/**
 * `GET /integrations/:provider/callback` — the provider redirect. Mounted at the ROOT,
 * because a provider redirect URI is fixed at app-registration time and cannot carry a
 * project slug.
 *
 * **IDENTITY COMES FROM THE SIGNED `state`, NOT FROM A SESSION** (§11e). The browser
 * arriving here carries whatever cookies it had — possibly a different member's, possibly
 * none — so the only trustworthy statement of who started this flow is the HMAC this
 * server minted ten minutes ago.
 *
 * ALWAYS REDIRECTS, NEVER RENDERS JSON. The user is in a browser mid-OAuth; an error
 * envelope would strand them on a blank page. The outcome travels as a query parameter the
 * frontend renders.
 */
export async function handleIntegrationCallback(req: Request, res: Response): Promise<void> {
  const parsedQuery = IntegrationCallbackQuerySchema.safeParse(req.query);
  const redirectTo = new URL(`${config.FRONTEND_URL}/research-and-development`);

  if (!parsedQuery.success) {
    redirectTo.searchParams.set("integration", "failed");
    res.redirect(302, redirectTo.toString());
    return;
  }

  const claims = integrationService.verifyOauthState(parsedQuery.data.state);
  if (!claims.success) {
    redirectTo.searchParams.set("integration", "state-invalid");
    res.redirect(302, redirectTo.toString());
    return;
  }

  const token = await exchangeCodeForToken(parsedQuery.data.code);
  if (!token.success) {
    redirectTo.searchParams.set("integration", "exchange-failed");
    res.redirect(302, redirectTo.toString());
    return;
  }

  // The connected account's login, stored as the grant's label AND used as the commit
  // author filter during grounding — so a member can only ever ground their own work.
  const login = await fetchViewerLogin(token.value.accessToken);

  const completed = await integrationService.completeGrant(
    claims.value,
    token.value.accessToken,
    login.success ? login.value : null,
    // The actor is the member the STATE names, not whoever happens to hold the session.
    claims.value.memberId,
  );

  redirectTo.searchParams.set("integration", completed.success ? "connected" : "failed");
  res.redirect(302, redirectTo.toString());
}
