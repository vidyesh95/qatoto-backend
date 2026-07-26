import type { Request, Response } from "express";
import { z } from "zod";

import { respondCompensationError } from "#src/controllers/compensation-error-response.js";
import {
  firstParam,
  optionalBody,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/controllers/project-error-response.js";
import * as agreementsService from "#src/services/compensation-agreements.service.js";
import * as paymentsService from "#src/services/compensation-payments.service.js";
import * as periodsService from "#src/services/compensation-periods.service.js";
import * as governanceService from "#src/services/governance-summary.service.js";
import * as membershipService from "#src/services/project-membership.service.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * Compensation statements (R_AND_D_BACKEND_STRUCTURE.md §7A, §11g).
 *
 * ---------------------------------------------------------------------------
 * THE REJECTED-KEYS LIST. §7A enumerates these so a reviewer can grep for them across
 * every §7 and §7A body, and every one is ABSENT from every schema below — so `.strict()`
 * turns each into a 422 rather than a silent overwrite:
 *
 *   backerUserId · userId · memberUserId · projectId · currency · currencyCode
 *   platformFeeInCents · feeInCents · status · verificationStatus · verdict
 *   equityBasisPoints · equityBasisPointsDelta · sliceCount · slices · grossAmountInCents
 *   effortMinutes · minutes · hours · raisedAmountInCents · percentageFunded
 *   percentageFundedBasisPoints · backersCount · statementHash · previousStatementHash
 *   sequenceNumber · finalizedAt · finalizedByUserId · countersignedByUserId
 *   payoutDestinationId · destinationAccountId · accountNumber · iban · upiId
 *   paymentMethodId · occurredAt · createdAt · id
 *
 * `compensation.controller.schemas.test.ts` asserts all of them, because a comment
 * claiming a key is rejected and a test proving it are different artifacts.
 *
 * THE THREE GROUPS ARE WORTH NAMING:
 *
 *   `grossAmountInCents`, `effortMinutes` and every equity field are COMPUTED OUTPUTS.
 *   There is no field to tamper with, which is the answer to §17 step 4's "what if the
 *   client edits the number and posts it back": the finalize body carries an
 *   acknowledgement string and nothing else.
 *
 *   `statementHash` and `sequenceNumber` are CHAIN INTEGRITY. A client-supplied hash is a
 *   forged chain.
 *
 *   `accountNumber`, `iban`, `upiId` and `destinationAccountId` are WIRE-FRAUD
 *   PRIMITIVES. This domain never stores a payment instrument, so a body carrying one is
 *   either a bug or an attack and both deserve a 422. The VALUE is checked too — see
 *   `containsPaymentInstrument` — because a rejected-key list is defeated by putting the
 *   number in a field that is allowed.
 * ---------------------------------------------------------------------------
 *
 * THE ONE NUMBER THAT LEGITIMATELY ENTERS THROUGH A BODY HERE is `paidAmountInCents` on a
 * payment record, and the agreement amounts a founder proposes. The first is an
 * ATTESTATION about the outside world; the second is a NEGOTIATED INPUT two humans agreed
 * to, in the same category as §9's fair market rate. Neither is a value the server owns.
 *
 * NO AUTHORIZATION MIDDLEWARE. Membership and role are proven inside each handler via
 * `requireProjectRole`, because a middleware cannot return a `Result` and so cannot
 * participate in the exhaustive error switch (§4a Layer 2). Failure is 404, not 403.
 */

/**
 * Money in, as a decimal STRING rather than a JS number.
 *
 * `z.number()` would silently lose precision past 2^53 and, worse, would accept `120.5`
 * for a value that must be a whole number of cents.
 */
const CentsStringSchema = z
  .string()
  .regex(/^\d{1,15}$/, "Must be a whole number of cents, as a string");

const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be an ISO date (YYYY-MM-DD)");

/**
 * THE AGREEMENT BODY. Exactly one basis — a flat monthly retainer OR an hourly rate.
 *
 * NO `currencyCode`. §4b: "there is no `currency` field in any request body — it is
 * derived from the round/project". A client-chosen currency would let a $6,000 retainer
 * be re-read as ¥6,000.
 *
 * NO `status`, NO `acceptedAt`, NO `acceptedByUserId`. The lifecycle is server-owned and
 * a founder marking their own proposal accepted is the founder fiat this exists to remove.
 */
export const ProposeCompensationAgreementSchema = z
  .object({
    engagementKind: z.enum(["employee", "independent_contractor", "unpaid_founder"]),
    monthlyAmountInCents: CentsStringSchema.optional(),
    hourlyRateCentsPerHour: CentsStringSchema.optional(),
    effectiveFrom: z.iso.datetime(),
    rationaleNote: z.string().trim().min(1).max(1_000),
  })
  .strict()
  // The CHECK constraint says the same thing, but failing here returns a 422 naming the
  // field rather than surfacing a constraint violation as a 500.
  .refine(
    (body) =>
      (body.monthlyAmountInCents === undefined) !== (body.hourlyRateCentsPerHour === undefined),
    {
      message: "Set exactly one of monthlyAmountInCents or hourlyRateCentsPerHour.",
      path: ["monthlyAmountInCents"],
    },
  );

/**
 * THE FINALIZE BODY. A typed acknowledgement and NOTHING ELSE.
 *
 * §17 step 4 asks what happens when a client edits an amount and posts it back. Here the
 * answer is that there is no amount: the statement is recomputed from the member's own
 * accepted agreement and their own recorded minutes, in the same transaction that freezes
 * it. The acknowledgement exists so an accidental double-click cannot reach the freeze.
 */
export const FinalizePeriodSchema = z.object({ acknowledgement: z.string() }).strict();

export const CountersignPeriodSchema = z
  .object({ note: z.string().trim().min(1).max(1_000).optional() })
  .strict();

export const SupersedePeriodSchema = z
  .object({ reasonNote: z.string().trim().min(1).max(2_000) })
  .strict();

/**
 * THE PAYMENT BODY. An ATTESTATION about a payment made somewhere else.
 *
 * `paidAmountInCents` is deliberately NOT validated against the line's gross: a partial
 * payment is a fact, and forcing them equal would make the record lie about what happened.
 *
 * `referenceNote` is a human note — a UTR, a payroll run id. Its VALUE is checked in the
 * service for anything shaped like a PAN or an IBAN, because this domain stores no payment
 * instruments and the key list alone would not stop someone pasting one here.
 */
export const RecordPaymentSchema = z
  .object({
    paidAmountInCents: CentsStringSchema,
    paidOnDate: IsoDateSchema,
    methodKey: z.enum([
      "bank_transfer",
      "sepa_transfer",
      "upi",
      "payroll_provider",
      "cash",
      "other",
    ]),
    referenceNote: z.string().trim().min(1).max(500).optional(),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();

export const AgreementQuerySchema = z
  .object({ memberId: z.string().trim().min(1).optional() })
  .strict();

export const PeriodListQuerySchema = z
  .object({
    status: z.enum(["open", "finalized", "superseded"]).optional(),
    limit: z.coerce.number().int().min(1).max(120).optional(),
    beforeSequenceNumber: z.coerce.number().int().min(1).optional(),
  })
  .strict();

export const ExportQuerySchema = z.object({ format: z.enum(["csv", "json"]).optional() }).strict();

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Agreements
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Governance — the CROSS-PROJECT read (§11h, Appendix B3)
// ---------------------------------------------------------------------------

/**
 * `GET /governance/summary` — aggregates, mechanics, and the caller's own lines.
 *
 * `attachOptionalUser`, NOT `requireAuth`, and that is deliberate: this page states the
 * three §7A.6 copy rules publicly, so it has to render for a signed-out visitor. What it
 * renders for them is aggregates and disclosure keys with an empty `callerOpenLines` — not
 * a fabricated example and not somebody else's row.
 *
 * NOTHING HERE NAMES A PERSON. The projection carries no member id, no user id, no name
 * and no per-member amount. The single exception is the caller's own lines, which reach
 * the response only through their own `project_member` rows.
 *
 * READ-ONLY. There is no finalize, countersign, payment or export on this router; each is
 * actor-scoped and stays where the actor's role is already resolved.
 */
export const GovernanceSummaryQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

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
