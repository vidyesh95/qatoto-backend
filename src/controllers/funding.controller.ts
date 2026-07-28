import type { Request, Response } from "express";
import { z } from "zod";

import { respondFundingError } from "#src/controllers/funding-error-response.js";
import {
  firstParam,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/controllers/project-error-response.js";
import * as compensationService from "#src/services/compensation.service.js";
// NOTHING FROM escrow-releases, escrow-settlement OR escrow.service IS IMPORTED HERE ANY
// MORE (§7A.6, §11g). The nine escrow routes are retired; the services and their tables
// are still on disk, unreachable and uncalled, and the ledger design is preserved for the
// commerce domain in docs/ESCROW_LEDGER_STRUCTURE.md.
import * as roundsService from "#src/services/funding-rounds.service.js";
import * as confidenceService from "#src/services/investor-confidence.service.js";
import * as milestonesService from "#src/services/milestones.service.js";
import * as membershipService from "#src/services/project-membership.service.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * Funding and escrow (R_AND_D_BACKEND_STRUCTURE.md §7, §11c).
 *
 * ---------------------------------------------------------------------------
 * THE REJECTED-KEYS LIST. §7 enumerates 27 keys so a reviewer can grep for them on the
 * pledge body, and every one is ABSENT from every schema below — so `.strict()` turns each
 * into a 422 rather than a silent overwrite:
 *
 *   backerUserId · userId · projectId · currency · platformFeeInCents · netToEscrowInCents
 *   feeInCents · status · verificationStatus · equityBasisPoints · sliceCount · slices
 *   raisedAmountInCents · percentageFunded · percentageFundedBasisPoints · backersCount
 *   escrowAccountId · journalEntryId · ledgerEntryId · providerTransferId ·
 *   payoutDestinationId · paymentMethodId · occurredAt · createdAt · id
 *
 * `funding.controller.schemas.test.ts` asserts all of them, because a comment claiming a
 * key is rejected and a test proving it are different artifacts.
 *
 * THE PLEDGE BODY IS `{ amountInCents }`. THE ESCROW-RELEASE BODY CARRIES NO AMOUNT AT
 * ALL. Both are §7 verbatim, and both are the shape that makes the tampering test in §17
 * step 4 a non-event: there is no field to edit.
 * ---------------------------------------------------------------------------
 *
 * THE ONE NUMBER THAT LEGITIMATELY ENTERS THROUGH A BODY HERE is a founder's own
 * `goalAmountInCents` and the milestone amounts they set — negotiated INPUTS they own,
 * like a seller setting `priceInCents`, not server-computed outputs. Everything derived
 * from them (the fee, the net, the raised total, the percentage) is computed server-side
 * and has no field.
 *
 * NO AUTHORIZATION MIDDLEWARE. Membership and role are proven inside each handler via
 * `requireProjectRole`, because a middleware cannot return a `Result` and so cannot
 * participate in the exhaustive error switch (§4a Layer 2). Failure is 404, not 403.
 */

/**
 * Money in, as a decimal STRING rather than a JS number.
 *
 * `z.number()` would silently lose precision past 2^53 and, worse, would accept `120.5`
 * for a value that must be a whole number of cents. 15 digits caps a single request at
 * ~$10 trillion, which is above any real round and below the point where a typo becomes a
 * denial-of-service on the `bigint` arithmetic downstream.
 */
const CentsStringSchema = z
  .string()
  .regex(/^\d{1,15}$/, "Must be a whole number of cents, as a string");

const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be an ISO date (YYYY-MM-DD)");

const PaginationQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export const CreateFundingRoundSchema = z
  .object({
    type: z.enum(["crowdfunding", "equity", "venture"]),
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().max(2_000).optional(),
    goalAmountInCents: CentsStringSchema,
    minimumPledgeInCents: CentsStringSchema.optional(),
    maximumPledgeInCents: CentsStringSchema.optional(),
    opensAt: z.iso.datetime().optional(),
    closesAt: z.iso.datetime().optional(),
  })
  .strict();

/**
 * THE PLEDGE BODY. `{ amountInCents }` and nothing else — §7's own words.
 *
 * Every other figure a client might send is derived server-side from the round, and every
 * one of §7's 27 rejected keys is absent from this object, so `.strict()` answers 422.
 */
export const CreatePledgeSchema = z.object({ amountInCents: CentsStringSchema }).strict();

export const MilestoneSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(5_000).optional(),
    plannedPayoutInCents: CentsStringSchema,
    dueDate: IsoDateSchema.optional(),
  })
  .strict();

/**
 * `status` is deliberately ABSENT. It moves through `/complete`, which writes `completedAt`
 * in the same statement — a PATCH that could set `done` without a completion instant would
 * produce a milestone an escrow release could be approved against with no record of when
 * the work finished.
 */
export const UpdateMilestoneSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(5_000).nullable().optional(),
    plannedPayoutInCents: CentsStringSchema.optional(),
    dueDate: IsoDateSchema.nullable().optional(),
  })
  .strict();

/** Six typed integers (§15). `varianceBasisPoints` is absent — the server computes it. */
export const MilestoneVarianceSchema = z
  .object({
    plannedDurationDays: z.number().int().min(0).max(100_000),
    actualDurationDays: z.number().int().min(0).max(100_000),
    plannedCostInCents: CentsStringSchema,
    actualCostInCents: CentsStringSchema,
    plannedEffortMinutes: z.number().int().min(0).max(100_000_000),
    actualEffortMinutes: z.number().int().min(0).max(100_000_000),
  })
  .strict();

// THE THREE ESCROW BODIES ARE GONE, along with the routes that parsed them (§7A.6):
// RequestEscrowReleaseSchema, DecideEscrowReleaseSchema and SettleTransferSchema. Their
// assertions move to nothing rather than to another file — a schema with no route is not
// a boundary, and a test proving a dead schema rejects a key proves nothing about the API.
//
// Their rejected keys are not lost. `payoutDestinationId`, `destinationAccountId`,
// `accountNumber`, `iban` and `upiId` are all asserted against every §7A body in
// compensation.controller.schemas.test.ts, which is where a body could now carry one.

export const DealsQuerySchema = z
  .object({
    roundType: z.enum(["crowdfunding", "equity", "venture"]).optional(),
    stage: z
      .enum([
        "market_research",
        "problem_validation",
        "team_building",
        "building_mvp",
        "raising_funding",
        "go_to_market",
      ])
      .optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

interface FundingCaller {
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
): Promise<FundingCaller | null> {
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
    respondFundingError(res, accessResult.error);
    return null;
  }
  return { context: accessResult.value, userId: req.user.id };
}

/**
 * The same proof, for the routes keyed on a round/milestone/release id rather than a slug.
 *
 * The id is resolved to a project FIRST and the membership check runs against that — so a
 * caller who is a member of project A cannot act on project B's round by id. The failure
 * is the same 404 either way.
 */
async function requireRoleForProjectOrRespond(
  req: Request,
  res: Response,
  projectSlug: string | null,
  minimumRole: membershipService.ProjectMemberRole,
): Promise<FundingCaller | null> {
  if (!req.user) {
    respondUnauthenticated(res);
    return null;
  }
  if (projectSlug === null) {
    // Indistinguishable from "not a member of the project that owns it".
    respondFundingError(res, { type: "NOT_FOUND", projectRef: "unknown" });
    return null;
  }

  const accessResult = await membershipService.requireProjectRole(
    projectSlug,
    req.user.id,
    minimumRole,
  );

  if (!accessResult.success) {
    respondFundingError(res, accessResult.error);
    return null;
  }
  return { context: accessResult.value, userId: req.user.id };
}

function respondOk(res: Response, message: string, data: unknown): void {
  res.status(200).json({ status: "success", statusCode: 200, message, data } satisfies ApiResponse);
}

function respondCreated(res: Response, message: string, data: unknown): void {
  res.status(201).json({ status: "success", statusCode: 201, message, data } satisfies ApiResponse);
}

// ---------------------------------------------------------------------------
// Rounds
// ---------------------------------------------------------------------------

/** `POST /research-projects/:projectSlug/funding-rounds` — founder only. */
export async function createFundingRound(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "founder");
  if (!caller) return;

  const parsedBody = CreateFundingRoundSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const created = await roundsService.createFundingRound(caller.context, caller.userId, {
    type: parsedBody.data.type,
    title: parsedBody.data.title,
    ...(parsedBody.data.summary === undefined ? {} : { summary: parsedBody.data.summary }),
    goalAmountInCents: BigInt(parsedBody.data.goalAmountInCents),
    ...(parsedBody.data.minimumPledgeInCents === undefined
      ? {}
      : { minimumPledgeInCents: BigInt(parsedBody.data.minimumPledgeInCents) }),
    ...(parsedBody.data.maximumPledgeInCents === undefined
      ? {}
      : { maximumPledgeInCents: BigInt(parsedBody.data.maximumPledgeInCents) }),
    ...(parsedBody.data.opensAt === undefined
      ? {}
      : { opensAt: new Date(parsedBody.data.opensAt) }),
    ...(parsedBody.data.closesAt === undefined
      ? {}
      : { closesAt: new Date(parsedBody.data.closesAt) }),
  });

  if (!created.success) {
    respondFundingError(res, created.error);
    return;
  }
  respondCreated(res, "Funding round created.", created.value);
}

/** `GET /research-projects/:projectSlug/funding-rounds`. */
export async function listProjectFundingRounds(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  respondOk(
    res,
    "Funding rounds loaded.",
    await roundsService.listProjectFundingRounds(
      caller.context.projectId,
      caller.context.projectSlug,
    ),
  );
}

/**
 * `GET /funding-rounds/:roundId` — PUBLIC for an open round on an active project.
 *
 * Unlike everything else in this router, a funding round is a solicitation: a backer who
 * is not a member has to be able to read what they are being asked to fund. Draft and
 * cancelled rounds resolve to 404 for non-members, exactly like an unpublished project.
 */
export async function getFundingRound(req: Request, res: Response): Promise<void> {
  const roundId = firstParam(req.params.roundId ?? "");
  const found = await roundsService.getFundingRound(roundId);

  if (!found.success) {
    respondFundingError(res, found.error);
    return;
  }

  if (found.value.status === "open" || found.value.status === "closed") {
    respondOk(res, "Funding round loaded.", found.value);
    return;
  }

  // A draft round is founder-facing. Prove membership before revealing it exists.
  const caller = await requireRoleForProjectOrRespond(
    req,
    res,
    found.value.projectSlug,
    "contributor",
  );
  if (!caller) return;

  respondOk(res, "Funding round loaded.", found.value);
}

export async function openFundingRound(req: Request, res: Response): Promise<void> {
  const roundId = firstParam(req.params.roundId ?? "");
  const existing = await roundsService.findRoundWithProject(roundId);

  const caller = await requireRoleForProjectOrRespond(
    req,
    res,
    existing?.projectSlug ?? null,
    // Founder or admin (§11c). `admin` is the co-signer role, and opening a round is the
    // decision that makes money solicitable.
    "admin",
  );
  if (!caller) return;

  const opened = await roundsService.openFundingRound(roundId, caller.userId);
  if (!opened.success) {
    respondFundingError(res, opened.error);
    return;
  }
  respondOk(res, "Funding round opened.", opened.value);
}

export async function closeFundingRound(req: Request, res: Response): Promise<void> {
  const roundId = firstParam(req.params.roundId ?? "");
  const existing = await roundsService.findRoundWithProject(roundId);

  const caller = await requireRoleForProjectOrRespond(
    req,
    res,
    existing?.projectSlug ?? null,
    "admin",
  );
  if (!caller) return;

  const closed = await roundsService.closeFundingRound(roundId, caller.userId);
  if (!closed.success) {
    respondFundingError(res, closed.error);
    return;
  }
  respondOk(res, "Funding round closed.", closed.value);
}

/** `GET /funding-rounds/:roundId/backers` — settled pledges only. */
export async function listRoundBackers(req: Request, res: Response): Promise<void> {
  const parsedQuery = PaginationQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const roundId = firstParam(req.params.roundId ?? "");
  const found = await roundsService.getFundingRound(roundId);
  if (!found.success) {
    respondFundingError(res, found.error);
    return;
  }

  respondOk(
    res,
    "Backers loaded.",
    await roundsService.listRoundBackers(roundId, parsedQuery.data),
  );
}

/** `GET /funding-rounds/:roundId/pledge-options` — the bounds the server will enforce. */
export async function getPledgeOptions(req: Request, res: Response): Promise<void> {
  const options = await roundsService.getPledgeOptions(firstParam(req.params.roundId ?? ""));
  if (!options.success) {
    respondFundingError(res, options.error);
    return;
  }
  respondOk(res, "Pledge options loaded.", options.value);
}

// ---------------------------------------------------------------------------
// Pledges
// ---------------------------------------------------------------------------

/**
 * `POST /funding-rounds/:roundId/pledges` — `201`, and `raisedAmountInCents` has NOT moved.
 *
 * ANY IDENTIFIED USER may pledge; there is no membership check, because a backer is by
 * definition an outsider. `requireIdentifiedUser` in the route chain is what stops an
 * anonymous session from minting backer counts (§4a Layer 1).
 */
export async function createPledge(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = CreatePledgeSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const created = await roundsService.createPledge({
    roundId: firstParam(req.params.roundId ?? ""),
    // FROM THE SESSION. There is no `backerUserId` field in any schema (§13).
    backerUserId: req.user.id,
    amountInCents: BigInt(parsedBody.data.amountInCents),
  });

  if (!created.success) {
    respondFundingError(res, created.error);
    return;
  }

  res.status(201).json({
    status: "success",
    statusCode: 201,
    // SAYS WHAT ACTUALLY HAPPENED. Appendix A3: no money moves in this phase, and a
    // client that tells a backer their card was charged is lying. The pledge is a
    // recorded intent until a settlement auditor decides it.
    message: "Pledge recorded. No funds have moved: it settles once an escrow auditor confirms it.",
    data: created.value,
  } satisfies ApiResponse);
}

/** `GET /pledges/mine` — the filter is `req.user.id`. No `userId` parameter exists. */
export async function listMyPledges(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedQuery = PaginationQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  respondOk(
    res,
    "Pledges loaded.",
    await roundsService.listMyPledges(req.user.id, parsedQuery.data),
  );
}

/** `POST /pledges/:pledgeId/cancel` — the backer's own, and only while pending. */
export async function cancelPledge(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const cancelled = await roundsService.cancelPledge(
    firstParam(req.params.pledgeId ?? ""),
    req.user.id,
  );

  if (!cancelled.success) {
    respondFundingError(res, cancelled.error);
    return;
  }
  respondOk(res, "Pledge cancelled.", cancelled.value);
}

/** `GET /funding/deals` — investor deal flow, filtered by the enabled round types. */
export async function listFundingDeals(req: Request, res: Response): Promise<void> {
  const parsedQuery = DealsQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  respondOk(res, "Deal flow loaded.", await roundsService.listFundingDeals(parsedQuery.data));
}

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

export async function listProjectMilestones(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  respondOk(
    res,
    "Milestones loaded.",
    await milestonesService.listProjectMilestones(caller.context.projectId),
  );
}

export async function createMilestone(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "maintainer");
  if (!caller) return;

  const parsedBody = MilestoneSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const created = await milestonesService.createMilestone(caller.context, caller.userId, {
    title: parsedBody.data.title,
    ...(parsedBody.data.description === undefined
      ? {}
      : { description: parsedBody.data.description }),
    plannedPayoutInCents: BigInt(parsedBody.data.plannedPayoutInCents),
    ...(parsedBody.data.dueDate === undefined ? {} : { dueDate: parsedBody.data.dueDate }),
  });

  if (!created.success) {
    respondFundingError(res, created.error);
    return;
  }
  respondCreated(res, "Milestone created.", created.value);
}

/**
 * GET /milestones/:milestoneId — member only (§11j.2).
 *
 * `contributor`, matching the project-scoped list rather than the maintainer floor the
 * writes use: the doc row says "member only", and a milestone is something every member
 * is meant to see. A nonexistent id and a milestone on a project the caller cannot see are
 * the same 404 — `requireRoleForProjectOrRespond` maps the `null` slug to one.
 */
export async function getMilestone(req: Request, res: Response): Promise<void> {
  const milestoneId = firstParam(req.params.milestoneId ?? "");
  const existing = await milestonesService.findMilestoneWithProject(milestoneId);

  const caller = await requireRoleForProjectOrRespond(
    req,
    res,
    existing?.projectSlug ?? null,
    "contributor",
  );
  if (!caller) return;

  const found = await milestonesService.getMilestone(caller.context.projectId, milestoneId);
  if (!found.success) {
    respondFundingError(res, found.error);
    return;
  }
  respondOk(res, "Milestone loaded.", found.value);
}

export async function updateMilestone(req: Request, res: Response): Promise<void> {
  const milestoneId = firstParam(req.params.milestoneId ?? "");
  const existing = await milestonesService.findMilestoneWithProject(milestoneId);

  const caller = await requireRoleForProjectOrRespond(
    req,
    res,
    existing?.projectSlug ?? null,
    "maintainer",
  );
  if (!caller) return;

  const parsedBody = UpdateMilestoneSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const updated = await milestonesService.updateMilestone(caller.context.projectId, milestoneId, {
    ...(parsedBody.data.title === undefined ? {} : { title: parsedBody.data.title }),
    ...(parsedBody.data.description === undefined
      ? {}
      : { description: parsedBody.data.description }),
    ...(parsedBody.data.plannedPayoutInCents === undefined
      ? {}
      : { plannedPayoutInCents: BigInt(parsedBody.data.plannedPayoutInCents) }),
    ...(parsedBody.data.dueDate === undefined ? {} : { dueDate: parsedBody.data.dueDate }),
  });

  if (!updated.success) {
    respondFundingError(res, updated.error);
    return;
  }
  respondOk(res, "Milestone updated.", updated.value);
}

export async function completeMilestone(req: Request, res: Response): Promise<void> {
  const milestoneId = firstParam(req.params.milestoneId ?? "");
  const existing = await milestonesService.findMilestoneWithProject(milestoneId);

  const caller = await requireRoleForProjectOrRespond(
    req,
    res,
    existing?.projectSlug ?? null,
    "maintainer",
  );
  if (!caller) return;

  const completed = await milestonesService.completeMilestone(
    caller.context.projectId,
    milestoneId,
  );

  if (!completed.success) {
    respondFundingError(res, completed.error);
    return;
  }
  respondOk(res, "Milestone completed.", completed.value);
}

export async function putMilestoneVariance(req: Request, res: Response): Promise<void> {
  const milestoneId = firstParam(req.params.milestoneId ?? "");
  const existing = await milestonesService.findMilestoneWithProject(milestoneId);

  const caller = await requireRoleForProjectOrRespond(
    req,
    res,
    existing?.projectSlug ?? null,
    "maintainer",
  );
  if (!caller) return;

  const parsedBody = MilestoneVarianceSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const stored = await milestonesService.putMilestoneVariance(
    caller.context.projectId,
    milestoneId,
    caller.context.currency,
    {
      plannedDurationDays: parsedBody.data.plannedDurationDays,
      actualDurationDays: parsedBody.data.actualDurationDays,
      plannedCostInCents: BigInt(parsedBody.data.plannedCostInCents),
      actualCostInCents: BigInt(parsedBody.data.actualCostInCents),
      plannedEffortMinutes: parsedBody.data.plannedEffortMinutes,
      actualEffortMinutes: parsedBody.data.actualEffortMinutes,
    },
  );

  if (!stored.success) {
    respondFundingError(res, stored.error);
    return;
  }
  respondOk(res, "Milestone variance recorded.", stored.value);
}

// ---------------------------------------------------------------------------
// Compensation and investor confidence
// ---------------------------------------------------------------------------

/** `GET …/compensation` — reads §9's rate table; there is no second one (§7 divergence). */
export async function getProjectCompensation(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  respondOk(
    res,
    "Compensation loaded.",
    await compensationService.getProjectCompensation(
      caller.context.projectId,
      caller.context.currency,
    ),
  );
}

/** `GET …/investor-confidence` — returns its `asOf`, or 404 when never computed. */
export async function getInvestorConfidence(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  const found = await confidenceService.getLatestInvestorConfidence(caller.context.projectId);
  if (!found.success) {
    respondFundingError(res, found.error);
    return;
  }
  respondOk(res, "Investor confidence loaded.", found.value);
}
