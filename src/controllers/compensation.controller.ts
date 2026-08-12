import type { Request, Response } from "express";

import { respondCompensationError } from "#src/controllers/compensation-error-response.js";
import {
  firstParam,
  optionalBody,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/rnd/projects/project-error-response.js";
import * as membershipService from "#src/modules/rnd/projects/project-membership.service.js";
import {
  AgreementQuerySchema,
  CountersignPeriodSchema,
  DeclineAgreementSchema,
  ExportQuerySchema,
  FinalizePeriodSchema,
  GovernanceSummaryQuerySchema,
  PeriodListQuerySchema,
  ProposeCompensationAgreementSchema,
  RecordPaymentSchema,
  SupersedePeriodSchema,
  WithdrawAgreementSchema,
} from "#src/schemas/compensation.schemas.js";
import * as agreementsService from "#src/services/compensation-agreements.service.js";
import * as paymentsService from "#src/services/compensation-payments.service.js";
import * as periodsService from "#src/services/compensation-periods.service.js";
import * as governanceService from "#src/services/governance-summary.service.js";
import type { ApiResponse } from "#src/types/index.js";

interface CompensationCaller {
  readonly context: membershipService.ProjectMemberContext;
  readonly userId: string;
}

/**
 * Proves the caller is a member at or above `minimumRole`, or writes the response.
 *
 * Failure is 404, never 403 (§4a). A stranger must not be able to probe which project
 * slugs exist, and a distinguishable 403 is exactly that probe.
 */
async function requireRoleOrRespond(
  req: Request,
  res: Response,
  minimumRole: membershipService.ProjectMemberRole,
): Promise<CompensationCaller | null> {
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
    respondCompensationError(res, accessResult.error);
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

/**
 * `GET /research-projects/:projectSlug/compensation-agreements` — the full history.
 *
 * Readable by any member, not just the founder. §9's rate history follows the same rule
 * and for the same reason: a history only one party can see is a filing cabinet, not
 * transparency.
 */
export async function listCompensationAgreements(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  const parsedQuery = AgreementQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const history = await agreementsService.listAgreementHistory(
    caller.context.projectId,
    parsedQuery.data.memberId,
  );

  if (!history.success) {
    respondCompensationError(res, history.error);
    return;
  }
  respondOk(res, "Compensation agreements loaded.", history.value);
}

/** `POST …/members/:memberUserId/compensation-agreement` — founder proposes. */
export async function proposeCompensationAgreement(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "founder");
  if (!caller) return;

  const parsedBody = ProposeCompensationAgreementSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const memberUserId = firstParam(req.params.memberUserId ?? "");
  const created = await agreementsService.proposeCashAgreement(
    caller.context,
    memberUserId,
    caller.userId,
    caller.context.memberRole,
    {
      engagementKind: parsedBody.data.engagementKind,
      monthlyAmountInCents:
        parsedBody.data.monthlyAmountInCents === undefined
          ? null
          : BigInt(parsedBody.data.monthlyAmountInCents),
      hourlyRateCentsPerHour:
        parsedBody.data.hourlyRateCentsPerHour === undefined
          ? null
          : BigInt(parsedBody.data.hourlyRateCentsPerHour),
      effectiveFrom: new Date(parsedBody.data.effectiveFrom),
      rationaleNote: parsedBody.data.rationaleNote,
    },
  );

  if (!created.success) {
    respondCompensationError(res, created.error);
    return;
  }
  respondCreated(res, "Compensation agreement proposed.", created.value);
}

/**
 * `POST …/compensation-agreements/:agreementId/accept` — THE SUBJECT ONLY.
 *
 * `contributor` is the floor deliberately: the person being paid is usually the most
 * junior member on the project, and the service then checks they are the agreement's own
 * subject. A higher role floor would stop members accepting their own pay.
 */
/**
 * POST …/compensation-agreements/:agreementId/decline — THE SUBJECT ONLY (§11j.3).
 *
 * `contributor` is the floor for the same reason `accept` uses it: the person being paid is
 * usually the most junior member on the project. The service then proves they are the
 * agreement's subject and refuses anyone else with a 403.
 */
export async function declineCompensationAgreement(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  const parsedBody = DeclineAgreementSchema.safeParse(optionalBody(req));
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const agreementId = firstParam(req.params.agreementId ?? "");
  const declined = await agreementsService.declineCashAgreement(
    caller.context,
    agreementId,
    caller.userId,
    caller.context.memberRole,
    parsedBody.data.note,
  );

  if (!declined.success) {
    respondCompensationError(res, declined.error);
    return;
  }
  respondOk(
    res,
    // Says where the note went, because the client will not find it on the row.
    "Compensation agreement declined. The proposal is closed and your note is recorded in the audit trail.",
    declined.value,
  );
}

/**
 * POST …/compensation-agreements/:agreementId/withdraw — FOUNDER only (§11j.3).
 *
 * The endpoint that finally reaches `withdrawn`, a value shipped in the enum since §7A with
 * nothing able to produce it. Refused once accepted: a live agreement is superseded by a
 * later effective-dated one, never retracted.
 */
export async function withdrawCompensationAgreement(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "founder");
  if (!caller) return;

  const parsedBody = WithdrawAgreementSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const agreementId = firstParam(req.params.agreementId ?? "");
  const withdrawn = await agreementsService.withdrawCashAgreement(
    caller.context,
    agreementId,
    caller.userId,
    caller.context.memberRole,
    parsedBody.data.reasonNote,
  );

  if (!withdrawn.success) {
    respondCompensationError(res, withdrawn.error);
    return;
  }
  respondOk(res, "Compensation agreement withdrawn.", withdrawn.value);
}

export async function acceptCompensationAgreement(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  const agreementId = firstParam(req.params.agreementId ?? "");
  const accepted = await agreementsService.acceptCashAgreement(
    caller.context,
    agreementId,
    caller.userId,
    caller.context.memberRole,
  );

  if (!accepted.success) {
    respondCompensationError(res, accepted.error);
    return;
  }
  respondOk(res, "Compensation agreement accepted.", accepted.value);
}

/** `GET …/compensation-periods` — keyset-paginated, newest first. */
export async function listCompensationPeriods(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  const parsedQuery = PeriodListQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  respondOk(
    res,
    "Compensation periods loaded.",
    await periodsService.listPeriods(caller.context.projectId, {
      status: parsedQuery.data.status,
      limit: parsedQuery.data.limit,
      beforeSequenceNumber: parsedQuery.data.beforeSequenceNumber,
    }),
  );
}

/** `GET …/compensation-periods/:periodId` — lines, payments and the hash. */
export async function getCompensationPeriod(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  const periodId = firstParam(req.params.periodId ?? "");
  const found = await periodsService.getPeriod(caller.context.projectId, periodId);

  if (!found.success) {
    respondCompensationError(res, found.error);
    return;
  }

  respondOk(res, "Compensation period loaded.", {
    ...found.value,
    payments: await paymentsService.listPaymentsForPeriod(periodId),
  });
}

/**
 * `POST …/compensation-periods/:periodId/finalize` — founder only.
 *
 * `new Date()` IS called here, and this is one of the few places it is correct: finalizing
 * is a human act at a wall-clock instant, not a replayable job. The instant is passed
 * INTO the service rather than read inside it, so the freeze stays a pure function of its
 * arguments and a test can pin it (§4c rule 3).
 */
export async function finalizeCompensationPeriod(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "founder");
  if (!caller) return;

  const parsedBody = FinalizePeriodSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const periodId = firstParam(req.params.periodId ?? "");
  const finalized = await periodsService.finalizePeriod(
    caller.context,
    periodId,
    parsedBody.data.acknowledgement,
    caller.userId,
    caller.context.memberRole,
    new Date(),
  );

  if (!finalized.success) {
    respondCompensationError(res, finalized.error);
    return;
  }
  respondOk(res, "Compensation statement finalized.", finalized.value);
}

/**
 * `POST …/compensation-periods/:periodId/countersign` — a DIFFERENT admin or auditor.
 *
 * `contributor` is the route's floor and the service does the real check, because the
 * countersigner may be a platform auditor who holds no project role at all — a higher
 * floor here would lock out exactly the party four-eyes is meant to admit.
 */
export async function countersignCompensationPeriod(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  const parsedBody = CountersignPeriodSchema.safeParse(optionalBody(req));
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const periodId = firstParam(req.params.periodId ?? "");
  const signed = await periodsService.countersignPeriod(
    caller.context,
    periodId,
    caller.userId,
    caller.context.memberRole,
    parsedBody.data.note ?? null,
  );

  if (!signed.success) {
    respondCompensationError(res, signed.error);
    return;
  }
  respondOk(res, "Compensation statement countersigned.", signed.value);
}

/** `POST …/compensation-periods/:periodId/supersede` — corrections never edit (§4f). */
export async function supersedeCompensationPeriod(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "founder");
  if (!caller) return;

  const parsedBody = SupersedePeriodSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const periodId = firstParam(req.params.periodId ?? "");
  const replaced = await periodsService.supersedePeriod(
    caller.context,
    periodId,
    parsedBody.data.reasonNote,
    caller.userId,
    caller.context.memberRole,
    new Date(),
  );

  if (!replaced.success) {
    respondCompensationError(res, replaced.error);
    return;
  }
  respondCreated(
    res,
    "Replacement period opened; the old statement is superseded.",
    replaced.value,
  );
}

/**
 * `GET …/compensation-periods/:periodId/export` — bytes for a payroll provider.
 *
 * The "no withholding computed, not payroll or tax advice" notice travels IN-BAND, in both
 * formats (§7A.6 item 3). A CSV that arrives without it is one paste away from being
 * treated as a payslip.
 */
export async function exportCompensationPeriod(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "admin");
  if (!caller) return;

  const parsedQuery = ExportQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const periodId = firstParam(req.params.periodId ?? "");
  const found = await periodsService.getPeriod(caller.context.projectId, periodId);

  if (!found.success) {
    respondCompensationError(res, found.error);
    return;
  }

  const exported = periodsService.buildPeriodExport(found.value, parsedQuery.data.format ?? "csv");
  res.status(200).type(exported.contentType).send(exported.body);
}

/**
 * `GET …/compensation-periods/:periodId/verify` — re-walks the statement chain.
 *
 * A break is `409 STATEMENT_CHAIN_BROKEN`, never `200 {valid:false}` — §9's audit verifier
 * follows the same rule, because a dashboard polling this renders a green tick for a 200.
 *
 * Scoped by `:periodId` in the path for symmetry with the rest of the subtree, but the
 * chain is PROJECT-wide: verifying one link in isolation proves nothing about the ones
 * around it, and a gap is invisible unless the whole chain is walked.
 */
export async function verifyCompensationChain(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  const verified = await periodsService.verifyStatementChain(caller.context.projectId);

  if (!verified.success) {
    respondCompensationError(res, verified.error);
    return;
  }
  respondOk(res, "Statement chain verified.", verified.value);
}

/**
 * `POST …/compensation-period-lines/:lineId/payments` — founder or admin ATTESTS.
 *
 * Recording a payment does not move money and does not change the line. The response says
 * a payment was RECORDED, never that one was made — a client that says otherwise is
 * telling a member they were paid on one party's word alone.
 */
export async function recordCompensationPayment(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "admin");
  if (!caller) return;

  const parsedBody = RecordPaymentSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const lineId = firstParam(req.params.lineId ?? "");
  const recorded = await paymentsService.recordPayment(
    caller.context,
    lineId,
    caller.userId,
    caller.context.memberRole,
    {
      paidAmountInCents: BigInt(parsedBody.data.paidAmountInCents),
      paidOnDate: parsedBody.data.paidOnDate,
      methodKey: parsedBody.data.methodKey,
      referenceNote: parsedBody.data.referenceNote ?? null,
      idempotencyKey: parsedBody.data.idempotencyKey,
    },
  );

  if (!recorded.success) {
    respondCompensationError(res, recorded.error);
    return;
  }
  respondCreated(
    res,
    "Payment recorded. It is unconfirmed until the member confirms it.",
    recorded.value,
  );
}

/** `POST …/payments/:paymentId/confirm` — THE MEMBER ONLY. */
export async function confirmCompensationPayment(req: Request, res: Response): Promise<void> {
  const caller = await requireRoleOrRespond(req, res, "contributor");
  if (!caller) return;

  const lineId = firstParam(req.params.lineId ?? "");
  const paymentId = firstParam(req.params.paymentId ?? "");
  const confirmed = await paymentsService.confirmPayment(
    caller.context,
    lineId,
    paymentId,
    caller.userId,
    caller.context.memberRole,
  );

  if (!confirmed.success) {
    respondCompensationError(res, confirmed.error);
    return;
  }
  respondOk(res, "Payment receipt confirmed.", confirmed.value);
}

export async function getGovernanceSummary(req: Request, res: Response): Promise<void> {
  const parsedQuery = GovernanceSummaryQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  // `attachOptionalUser` leaves `req.user` undefined for a visitor; the service takes null
  // and returns no caller lines. There is no request field that supplies a user id.
  const summary = await governanceService.getGovernanceSummary(
    req.user?.id ?? null,
    parsedQuery.data,
  );

  respondOk(res, "Governance summary loaded.", summary);
}
