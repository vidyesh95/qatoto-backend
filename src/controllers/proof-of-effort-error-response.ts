import type { Response } from "express";

import type { DisputeError } from "#src/services/dispute.service.js";
import type { EffortClaimError } from "#src/services/effort-claims.service.js";
import type { EquitySnapshotError } from "#src/services/equity-snapshot.service.js";
import type { FairMarketRateError } from "#src/services/fair-market-rate.service.js";
import type { AuditChainError } from "#src/services/project-audit.service.js";
import type { AllocationError } from "#src/services/slice-allocation.service.js";
import type { LedgerError } from "#src/services/slice-ledger.service.js";

/**
 * The §9 error mapper (R_AND_D_BACKEND_STRUCTURE.md §9, §11e, §13).
 *
 * A THIRD MAPPER beside project-error-response.ts and workshop-error-response.ts,
 * following the same precedent: §9's services compose their own error union, and folding
 * them into another domain's exhaustive switch would make one function responsible for two
 * domains that ship on different schedules.
 *
 * THE STATUS POLICY, restated because this is the part a reviewer checks:
 *   404 — every authorization and lookup failure. "No such project", "not a member",
 *         "role below the minimum" and "that claim belongs to another project" are
 *         indistinguishable, so a stranger cannot probe which ids exist. Never 403.
 *   403 — only where membership is ALREADY PROVEN and the refusal names a rule that
 *         reveals nothing new (NOT_THE_RATE_SUBJECT, NOT_THE_RAISER).
 *   409 — lifecycle conflicts. This domain has more of them than any other, because
 *         almost every state here is terminal by design: a locked rate, a settled claim,
 *         a closed window, a baked pie.
 *   422 — parse failures and cross-table validation a schema cannot express.
 *
 * **409 CHAIN_BROKEN IS AN OPERATIONAL EMERGENCY, NOT A RESULT.** §9.9 is explicit that a
 * broken chain must page rather than return `200 {valid:false}` — a verification endpoint
 * that answers "no" with a success status will be polled by a dashboard that renders a
 * green tick for a 200.
 */
export type ProofOfEffortDomainError =
  | FairMarketRateError
  | EffortClaimError
  | AllocationError
  | DisputeError
  | AuditChainError
  | EquitySnapshotError
  | LedgerError;

export function mapProofOfEffortErrorToResponse(error: ProofOfEffortDomainError): {
  readonly statusCode: number;
  readonly message: string;
  readonly errors?: Readonly<Record<string, readonly string[]>>;
} {
  switch (error.type) {
    // --- 404: every authorization and lookup failure, all indistinguishable.
    case "NOT_FOUND":
      return { statusCode: 404, message: "Project not found." };
    case "RATE_NOT_FOUND":
      return { statusCode: 404, message: "Rate not found." };
    case "CLAIM_NOT_FOUND":
      return { statusCode: 404, message: "Effort claim not found." };
    case "STEP_NOT_FOUND":
      return { statusCode: 404, message: "Verification step not found." };
    case "DAILY_LOG_NOT_FOUND":
      return { statusCode: 404, message: "Daily log not found." };
    case "PROPOSAL_NOT_FOUND":
      return { statusCode: 404, message: "Allocation proposal not found." };
    case "DISPUTE_NOT_FOUND":
      return { statusCode: 404, message: "Dispute not found." };
    case "AUDIT_ENTRY_NOT_FOUND":
      return { statusCode: 404, message: "Audit entry not found." };
    case "SNAPSHOT_NOT_FOUND":
      return { statusCode: 404, message: "Equity snapshot not found." };
    case "LEDGER_ENTRY_NOT_FOUND":
      return { statusCode: 404, message: "Ledger entry not found." };
    case "RECEIPT_NOT_FOUND":
      return { statusCode: 404, message: "Receipt not found." };

    // --- 403: membership is proven; the refusal names a rule.
    case "NOT_THE_RATE_SUBJECT":
      return { statusCode: 403, message: "Only the member this rate is for can accept it." };
    case "NOT_THE_AUTHOR":
      return { statusCode: 403, message: "Only the log's author can claim effort for it." };
    case "NOT_THE_RAISER":
      return { statusCode: 403, message: "Only the member who raised a dispute can withdraw it." };
    case "NOT_AUTHORIZED_TO_RESOLVE":
      return { statusCode: 403, message: "Only the founder can resolve this dispute." };

    // --- 409: the lifecycle conflicts, which this domain is largely made of.
    case "RETROACTIVE_RATE_CHANGE":
      return {
        statusCode: 409,
        // Naming the locked date tells the founder what to change, and the refusal exists
        // because a raise must not re-price two years of logged effort (§9.6).
        message: `A rate is already locked from ${error.lockedEffectiveFrom.toISOString()}. A new rate must take effect after it.`,
      };
    case "RATE_EFFECTIVE_FROM_TAKEN":
      return {
        statusCode: 409,
        message: "This member already has a rate effective from that instant.",
      };
    case "RATE_ALREADY_LOCKED":
      return { statusCode: 409, message: "That rate is locked and can no longer be changed." };
    case "RATE_ALREADY_ACCEPTED":
      return { statusCode: 409, message: "That rate has already been accepted." };
    case "RATE_NOT_ACCEPTED":
      return {
        statusCode: 409,
        message: "The member has not accepted this rate yet, so it cannot be locked.",
      };
    case "RATE_NOT_LOCKED":
      return {
        statusCode: 409,
        // The gate §11e names. Without a locked rate there is no price for the effort, and
        // guessing one is the founder fiat this product exists to remove.
        message: `No locked fair market rate covers ${error.claimedForDate}. Lock a rate before claiming effort.`,
      };
    case "CLAIM_ALREADY_EXISTS":
      return {
        statusCode: 409,
        message: "This daily log already has an effort claim. Re-verify it instead.",
      };
    case "CLAIM_SETTLED":
      return {
        statusCode: 409,
        message: "This claim is settled. Corrections are made by appending a reversal.",
      };
    case "DAILY_LOG_NOT_SUBMITTED":
      return { statusCode: 409, message: "Submit the daily log before claiming effort for it." };
    case "RECEIPT_ALREADY_CLAIMED":
      return { statusCode: 409, message: "That receipt is already attached to another claim." };
    case "WINDOW_CLOSED":
      return {
        statusCode: 409,
        message: `This allocation window is ${error.status} and can no longer be disputed.`,
      };
    case "ALREADY_DISPUTED":
      return { statusCode: 409, message: "This allocation is already under dispute." };
    case "DISPUTE_NOT_OPEN":
      return { statusCode: 409, message: "That dispute has already been resolved or withdrawn." };
    case "ALREADY_VOTED":
      return {
        statusCode: 409,
        // A vote that can be changed after the fact is not a consensus (§9.8).
        message: "You have already voted on this dispute.",
      };
    case "EVIDENCE_PURGED":
      return {
        statusCode: 409,
        // §9.10's consequence, surfaced where a human meets it: revocation destroyed the
        // source data, so no number can be re-derived. Uphold or void instead.
        message:
          "This claim's evidence was purged when its integration consent was revoked, so it cannot be re-verified. Uphold or void it instead.",
      };
    case "PIE_ALREADY_BAKED":
      return {
        statusCode: 409,
        message: "This project's pie is baked. Equity is frozen and no longer accrues.",
      };

    // --- 422: validation a schema could not do alone.
    case "ACKNOWLEDGEMENT_MISMATCH":
      return {
        statusCode: 422,
        message: "The typed acknowledgement did not match.",
        errors: { acknowledgement: [`Type exactly: ${error.expected}`] },
      };
    case "RATE_SUBJECT_NOT_A_MEMBER":
      return {
        statusCode: 422,
        message: "That person is not an active member of this project.",
        errors: { memberUserId: ["Not an active member."] },
      };
    case "RECEIPTS_REQUIRED":
      return {
        statusCode: 422,
        message: "A physical-work claim needs at least one uploaded receipt.",
        errors: { physicalReceiptIds: ["Attach at least one receipt."] },
      };
    case "CLAIM_DATE_IN_FUTURE":
      return {
        statusCode: 422,
        message: "Effort cannot be claimed for a day that has not happened.",
        errors: { claimedForDate: [`${error.claimedForDate} is in the future.`] },
      };
    case "SCOPED_WINDOW_REQUIRED":
      return {
        statusCode: 422,
        // §9.12 option (a): the resolver narrows a WINDOW and the server re-derives the
        // minutes. There is no field for a minute count and there never will be.
        message:
          "Re-verification needs the time window the team agreed on. The server re-derives the minutes from the artifacts inside it.",
        errors: { scopedWindowStartsAt: ["Required when resolution is re_verified."] },
      };
    case "SCOPED_WINDOW_INVALID":
      return {
        statusCode: 422,
        message: "That re-verification window is not valid.",
        errors: {
          scopedWindowEndsAt: [
            "Must end after it starts, and may only be sent with resolution re_verified.",
          ],
        },
      };

    // --- The chain. A break must PAGE, not render as a field in a 200 (§9.9).
    case "CHAIN_BROKEN":
      return {
        statusCode: 409,
        message: `Audit chain broken at sequence ${error.sequenceNumber} (${error.reason}).`,
        errors: {
          chain: [
            `Entry ${error.sequenceNumber} failed the ${error.reason} check. This is an operational emergency: the trail can no longer be trusted from that point forward.`,
          ],
        },
      };

    default: {
      // Adding a variant to any §9 service union without handling it here breaks the
      // build, which is the point (CLAUDE.md §3.2).
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled proof-of-effort error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export function respondProofOfEffortError(res: Response, error: ProofOfEffortDomainError): void {
  const { statusCode, message, errors } = mapProofOfEffortErrorToResponse(error);
  res.status(statusCode).json({ status: "error", statusCode, message, errors });
}
