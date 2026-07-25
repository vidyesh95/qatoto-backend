import type { Response } from "express";

import type { CompensationAgreementError } from "#src/services/compensation-agreements.service.js";
import type { CompensationPaymentError } from "#src/services/compensation-payments.service.js";
import type { CompensationPeriodError } from "#src/services/compensation-periods.service.js";

/**
 * The §7A error mapper (R_AND_D_BACKEND_STRUCTURE.md §7A, §11g, §13).
 *
 * A FOURTH MAPPER beside project-, workshop-, proof-of-effort- and funding-error-response,
 * following the same precedent: §7A's services compose their own error union, and folding
 * them into another domain's exhaustive switch would make one function responsible for two
 * domains that ship on different schedules.
 *
 * THE STATUS POLICY, restated because this is the part a reviewer checks:
 *   404 — every authorization and lookup failure. "No such project", "not a member",
 *         "role below the minimum" and "that period belongs to another project" are
 *         indistinguishable, so a stranger cannot probe which ids exist. Never 403.
 *   403 — only where membership is ALREADY PROVEN and the refusal names a rule that
 *         reveals nothing new: NOT_THE_AGREEMENT_SUBJECT, NOT_THE_PAID_MEMBER,
 *         COUNTERSIGNER_NOT_AUTHORIZED.
 *   409 — lifecycle conflicts. A finalized period, a countersigned one, an accepted
 *         agreement: every terminal state in this domain is terminal by design.
 *   422 — parse failures, and cross-table validation a schema cannot express.
 *
 * TWO STATUSES ARE NOT NEGOTIABLE, AND BOTH ARE SPELLED OUT IN §7A:
 *
 *   `422 SELF_COUNTERSIGN_FORBIDDEN` — §7A.5's own words, EVEN FOR A FOUNDER. It is 422
 *   rather than 403 because the caller is authorized; the request is the problem. A 403
 *   would read as "you may not countersign", which is false and would send a founder
 *   looking for a permission to grant themselves — which is exactly the hole four-eyes
 *   exists to close.
 *
 *   `409 STATEMENT_CHAIN_BROKEN` — never `200 {valid:false}`, the same rule §9's audit
 *   verifier follows. A verification endpoint that answers "no" with a success status
 *   will be polled by a dashboard that renders a green tick for a 200. A broken statement
 *   chain is an operational emergency and must page.
 */

export type CompensationDomainError =
  | CompensationAgreementError
  | CompensationPeriodError
  | CompensationPaymentError;

export function mapCompensationErrorToResponse(error: CompensationDomainError): {
  readonly statusCode: number;
  readonly message: string;
  readonly errors?: Readonly<Record<string, readonly string[]>>;
} {
  switch (error.type) {
    // --- 404: every authorization and lookup failure, all indistinguishable.
    case "NOT_FOUND":
      return { statusCode: 404, message: "Project not found." };
    case "AGREEMENT_NOT_FOUND":
      return { statusCode: 404, message: "Compensation agreement not found." };
    case "AGREEMENT_SUBJECT_NOT_A_MEMBER":
      return { statusCode: 404, message: "That member is not on this project." };
    case "PERIOD_NOT_FOUND":
      return { statusCode: 404, message: "Compensation period not found." };
    case "LINE_NOT_FOUND":
      return { statusCode: 404, message: "Statement line not found." };
    case "PAYMENT_NOT_FOUND":
      return { statusCode: 404, message: "Payment record not found." };

    // --- 403: membership already proven; the refusal names a rule and reveals nothing.
    case "NOT_THE_AGREEMENT_SUBJECT":
      return {
        statusCode: 403,
        message: "Only the member this agreement is for can accept it.",
      };
    case "NOT_THE_PAID_MEMBER":
      return {
        statusCode: 403,
        message: "Only the member this payment is for can confirm they received it.",
      };
    case "COUNTERSIGNER_NOT_AUTHORIZED":
      return {
        statusCode: 403,
        message:
          "Countersigning needs a platform auditor, or a project admin whose role was " +
          "granted by someone else. A self-granted admin role is not a second pair of eyes.",
      };

    // --- 409: lifecycle conflicts.
    case "AGREEMENT_ALREADY_ACCEPTED":
      return { statusCode: 409, message: "That agreement has already been accepted." };
    case "AGREEMENT_NOT_PROPOSED":
      return {
        statusCode: 409,
        message: `That agreement is ${error.status} and can no longer be accepted.`,
      };
    case "RETROACTIVE_AGREEMENT_CHANGE":
      return {
        statusCode: 409,
        message:
          "A new agreement must take effect after the active one. Re-pricing months that " +
          "have already been drafted is not something this service will do.",
        errors: { effectiveFrom: [`Must be after ${error.activeEffectiveFrom.toISOString()}.`] },
      };
    case "AGREEMENT_EFFECTIVE_FROM_TAKEN":
      return {
        statusCode: 409,
        message: "This member already has an agreement effective at that instant.",
        errors: { effectiveFrom: [error.effectiveFrom.toISOString()] },
      };
    case "PERIOD_ALREADY_FINALIZED":
      return {
        statusCode: 409,
        message: "That period is already finalized. Correct it by superseding it.",
      };
    case "PERIOD_NOT_FINALIZED":
      return {
        statusCode: 409,
        message: `That period is ${error.status}; finalize it first.`,
      };
    case "PERIOD_ALREADY_COUNTERSIGNED":
      return { statusCode: 409, message: "That statement has already been countersigned." };
    case "PERIOD_ALREADY_SUPERSEDED":
      return { statusCode: 409, message: "That statement has already been superseded." };
    case "PERIOD_NOT_READY":
      return {
        statusCode: 409,
        message: "That period is still accruing and cannot be finalized yet.",
        errors: { period: [`Ends ${error.periodEndDate}, in the project's own time zone.`] },
      };
    case "RATE_NOT_LOCKED":
      return {
        statusCode: 409,
        message:
          "Every member with hourly work in this period needs a locked fair market rate " +
          "before the statement can be frozen.",
        errors: { members: error.memberUserIds },
      };
    case "LINE_NOT_FINALIZED":
      return {
        statusCode: 409,
        message:
          "That line belongs to an open period. Its amount is redrawn nightly, so a " +
          "payment recorded against it would attest to a number that changes overnight.",
      };
    case "PAYMENT_ALREADY_CONFIRMED":
      return { statusCode: 409, message: "That payment has already been confirmed." };

    // --- 409 STATEMENT_CHAIN_BROKEN. An emergency, never a 200 field.
    case "STATEMENT_CHAIN_BROKEN":
      return {
        statusCode: 409,
        message: "The statement chain is broken. This is an integrity failure, not a result.",
        errors: {
          chain: [`Break at sequence ${error.sequenceNumber} (${error.reason}).`],
        },
      };

    // --- 422: the caller is authorized; the request is the problem.
    case "SELF_COUNTERSIGN_FORBIDDEN":
      return {
        statusCode: 422,
        message:
          "The person who finalized a statement cannot countersign it, founder included. " +
          "Two signatures from one person is one signature.",
      };
    case "ACKNOWLEDGEMENT_MISMATCH":
      return {
        statusCode: 422,
        message: "Type the acknowledgement exactly to confirm.",
        errors: { acknowledgement: [`Expected "${error.expected}".`] },
      };
    case "HOURLY_RATE_DISAGREES_WITH_PIE":
      return {
        statusCode: 422,
        message:
          "This hourly rate disagrees with the locked fair market rate's paid-cash figure. " +
          "The equity formula and the payslip would price the same hour differently.",
        errors: {
          hourlyRateCentsPerHour: [
            `Agreement says ${error.agreementCentsPerHour}; the locked rate says ` +
              `${error.paidCashRateCentsPerHour}.`,
          ],
        },
      };
    case "LINE_IS_NOT_CASH":
      return {
        statusCode: 422,
        message:
          "An equity line is a statement of entitlement, not an amount owed. Nothing here " +
          "issues a share, so there is nothing to pay.",
        errors: { kind: [error.kind] },
      };
    case "PAYMENT_INSTRUMENT_IN_REFERENCE_NOTE":
      return {
        statusCode: 422,
        message:
          "The reference note looks like it contains an account or card number. This " +
          "domain stores no payment instruments. Use a transaction reference instead.",
        errors: { referenceNote: ["Remove the account, IBAN or card number."] },
      };

    default: {
      // Adding an error variant without handling it breaks the build, which is the point
      // (CLAUDE.md §3.2).
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled compensation error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/** Writes the mapped response. Kept separate so the mapper stays a pure function. */
export function respondCompensationError(res: Response, error: CompensationDomainError): void {
  const mapped = mapCompensationErrorToResponse(error);
  res.status(mapped.statusCode).json({
    status: "error",
    statusCode: mapped.statusCode,
    message: mapped.message,
    ...(mapped.errors === undefined ? {} : { errors: mapped.errors }),
  });
}
