import type { Response } from "express";

import { describeUnsupportedImageFormat } from "#src/lib/image.js";
import type { AuditChainError } from "#src/modules/rnd/projects/project-audit.service.js";
import type { DisputeError } from "#src/modules/rnd/proof-of-effort/dispute.service.js";
import type { EffortClaimError } from "#src/modules/rnd/proof-of-effort/effort-claims.service.js";
import type { IntegrationError } from "#src/modules/rnd/proof-of-effort/integration-consent.service.js";
import type { PhysicalReceiptError } from "#src/modules/rnd/proof-of-effort/physical-receipts.service.js";
import type { EquitySnapshotError } from "#src/services/equity-snapshot.service.js";
import type { FairMarketRateError } from "#src/services/fair-market-rate.service.js";
import type { OptimizationSuggestionError } from "#src/services/optimization-suggestions.service.js";
import type { PieBakeError } from "#src/services/pie-bake.service.js";
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
  | LedgerError
  | PhysicalReceiptError
  | IntegrationError
  | PieBakeError
  | OptimizationSuggestionError;

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
    // Reached from TWO unions with one payload — `EffortClaimError` (a claim cited a
    // receipt id that is not citable) and `PhysicalReceiptError` (the uploader-scoped
    // detail read). Another member's receipt lands here too: the read is scoped to
    // `memberId`, so someone else's is indistinguishable from one that never existed.
    case "RECEIPT_NOT_FOUND":
      return { statusCode: 404, message: "Receipt not found." };
    case "GRANT_NOT_FOUND":
      return { statusCode: 404, message: `No ${error.provider} connection on this project.` };
    case "SUGGESTION_NOT_FOUND":
      return { statusCode: 404, message: "Suggestion not found." };

    // --- 403: membership is proven; the refusal names a rule.
    case "NOT_THE_RATE_SUBJECT":
      return { statusCode: 403, message: "Only the member this rate is for can accept it." };
    case "NOT_THE_AUTHOR":
      return { statusCode: 403, message: "Only the log's author can claim effort for it." };
    case "NOT_THE_RAISER":
      return { statusCode: 403, message: "Only the member who raised a dispute can withdraw it." };
    case "NOT_AUTHORIZED_TO_RESOLVE":
      return { statusCode: 403, message: "Only the founder can resolve this dispute." };
    case "GRANT_NOT_YOURS":
      return {
        statusCode: 403,
        // §9.10: revoke is SELF-ONLY. A founder who could revoke someone else's consent
        // could force a re-verification to fail — founder fiat through a side door.
        message: "Only the member who connected an integration can revoke it.",
      };

    // --- 409: the lifecycle conflicts, which this domain is largely made of.
    // Once a claim cites a receipt the bytes are evidence behind a slice award, and
    // deleting them would leave a verified claim pointing at nothing (§11j.3).
    case "RECEIPT_CITED":
      return {
        statusCode: 409,
        message: `That receipt is cited by effort claim ${error.claimId} and is now part of its evidence.`,
      };
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
    case "DUPLICATE_RECEIPT":
      return {
        statusCode: 409,
        // The same bytes cannot fund two receipts (§9.6). Naming the hash lets a client
        // point at the receipt that already exists.
        message: "This exact file has already been uploaded as a receipt on this project.",
        errors: { receipt: [`sha256 ${error.contentSha256}`] },
      };
    case "SNAPSHOT_STALE":
      return {
        statusCode: 409,
        // §9.11: a founder must not bake a cap table they have not seen.
        message:
          "The cap table has changed since you reviewed it. Re-read the current snapshot before baking.",
        errors: { expectedSnapshotId: [`The latest snapshot is ${error.latestSnapshotId}.`] },
      };
    case "UNSETTLED_ALLOCATIONS":
      return {
        statusCode: 409,
        message: `${error.openCount} open and ${error.disputedCount} disputed allocation window(s) must settle before the pie can be baked.`,
      };
    case "SUGGESTION_ALREADY_DECIDED":
      return { statusCode: 409, message: `That suggestion was already ${error.status}.` };

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

    // --- 422/413/503: uploads and third parties.
    case "RECEIPT_FILE_MISSING":
      return {
        statusCode: 422,
        message: "No receipt file was attached.",
        errors: { receipt: ["Send the image in a multipart field named `receipt`."] },
      };
    case "NOT_AN_IMAGE":
      return { statusCode: 422, message: "That file is not a readable image." };
    case "UNSUPPORTED_FORMAT":
      // The sentence lives in `image.ts` beside the allowlist it describes — six mappers
      // spelling it out themselves is six copies to update, and the one that got missed
      // would be telling users the wrong thing.
      return { statusCode: 422, message: describeUnsupportedImageFormat(error.detected) };
    case "DIMENSIONS_TOO_SMALL":
      return {
        statusCode: 422,
        message: `Receipt is too small (${error.width}×${error.height}). Minimum 64×64.`,
      };
    case "DIMENSIONS_TOO_LARGE":
      return {
        statusCode: 422,
        message: `Receipt is too large (${error.width}×${error.height}). Maximum 8192×8192.`,
      };
    case "OAUTH_STATE_INVALID":
      return {
        statusCode: 422,
        // The state IS the identity on a provider callback (§11e), so a bad one is not a
        // recoverable hiccup — the connection has to be started again.
        message: "That connection link has expired or was tampered with. Start again.",
      };
    case "INTEGRATION_UNCONFIGURED":
      return {
        statusCode: 503,
        message: `${error.provider} integration is not configured on this deployment.`,
      };
    case "NOT_CONFIGURED":
      return { statusCode: 503, message: "Receipt storage is not configured." };
    case "UPLOAD_FAILED":
      return { statusCode: 502, message: "Receipt upload failed. Please try again." };
    case "DELETE_FAILED":
      return { statusCode: 502, message: "Receipt deletion failed. Please try again." };

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
