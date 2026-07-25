import type { Response } from "express";

import type { EscrowReleaseError } from "#src/services/escrow-releases.service.js";
import type { SettlementError } from "#src/services/escrow-settlement.service.js";
import type { EscrowError } from "#src/services/escrow.service.js";
import type { FundingError } from "#src/services/funding-rounds.service.js";
import type { InvestorConfidenceError } from "#src/services/investor-confidence.service.js";
import type { MilestoneError } from "#src/services/milestones.service.js";

/**
 * The §7 error mapper (R_AND_D_BACKEND_STRUCTURE.md §7, §11c, §13).
 *
 * A FOURTH MAPPER beside project-, workshop- and proof-of-effort-error-response.ts,
 * following the same precedent: §7's services compose their own error union, and folding
 * them into another domain's exhaustive switch would make one function responsible for two
 * domains that ship on different schedules.
 *
 * THE STATUS POLICY, restated because this is the part a reviewer checks:
 *   404 — every authorization and lookup failure. "No such project", "not a member",
 *         "that round belongs to another project" are indistinguishable, so a stranger
 *         cannot probe which ids exist. Never 403.
 *   403 — only where standing is ALREADY PROVEN and the refusal names a rule that reveals
 *         nothing new (NOT_THE_BACKER, APPROVER_NOT_AUTHORIZED), plus the two regulatory
 *         gates, which are facts about the DEPLOYMENT rather than about a resource.
 *   409 — lifecycle conflicts: a closed round, a decided release, a settled pledge.
 *   422 — parse failures and cross-table validation a schema cannot express. **Including
 *         SELF_APPROVAL_FORBIDDEN**, which §7 names as a 422 by number.
 *
 * **`SELF_APPROVAL_FORBIDDEN` IS A 422, NOT A 403, AND §7 SAYS SO EXPLICITLY.** It is not
 * a statement about who the caller is — they are, by construction, authorized to approve
 * releases in general. It is a statement about THIS request being unprocessable: the
 * approver and the requester are the same person, and no amount of extra permission would
 * make that acceptable.
 */
export type FundingDomainError =
  | FundingError
  | MilestoneError
  | EscrowError
  | EscrowReleaseError
  | SettlementError
  | InvestorConfidenceError;

export function mapFundingErrorToResponse(error: FundingDomainError): {
  readonly statusCode: number;
  readonly message: string;
  readonly errors?: Readonly<Record<string, readonly string[]>>;
} {
  switch (error.type) {
    // --- 404: every authorization and lookup failure, all indistinguishable.
    case "NOT_FOUND":
      return { statusCode: 404, message: "Project not found." };
    case "ROUND_NOT_FOUND":
      return { statusCode: 404, message: "Funding round not found." };
    case "PLEDGE_NOT_FOUND":
      return { statusCode: 404, message: "Pledge not found." };
    case "MILESTONE_NOT_FOUND":
      return { statusCode: 404, message: "Milestone not found." };
    case "RELEASE_NOT_FOUND":
      return { statusCode: 404, message: "Escrow release not found." };
    case "ESCROW_ENTRY_NOT_FOUND":
      return { statusCode: 404, message: "Ledger entry not found." };
    case "TRANSFER_NOT_FOUND":
      return { statusCode: 404, message: "Transfer not found." };
    case "CONFIDENCE_NOT_COMPUTED":
      return {
        statusCode: 404,
        // NOT a fabricated zero. A project the nightly job has never scored has no
        // confidence figure, and inventing one is exactly what the hardcoded 78 was.
        message: "No investor-confidence snapshot has been computed for this project yet.",
      };

    // --- 403: standing is proven, or the refusal is about the deployment.
    case "NOT_THE_BACKER":
      return { statusCode: 403, message: "Only the backer can cancel their own pledge." };
    case "APPROVER_NOT_AUTHORIZED":
      return {
        statusCode: 403,
        // Naming BOTH acceptable standings, because a founder reading this needs to know
        // that granting themselves `admin` is not one of them (§4a).
        message:
          "Approving an escrow release needs a platform escrow auditor, or a project admin whose role somebody else granted them.",
      };
    case "ROUND_TYPE_DISABLED":
      return {
        statusCode: 403,
        // §7's regulatory gate. PROOF_OF_EFFORT_SPEC.md §1 sequences equity crowdfunding
        // behind FINRA/SEC registration or a licensed broker-dealer partner, so this is a
        // fact about what this deployment is permitted to do — not about the caller.
        message: `${error.roundType} rounds are not enabled on this deployment.`,
        errors: { type: ["This round type is disabled by policy."] },
      };
    case "PLATFORM_CAPABILITY_REQUIRED":
      return {
        statusCode: 403,
        // The capability, never the role that would grant it: telling an attacker which
        // role they need is free reconnaissance (platform-role.service.ts).
        message: `This action requires the ${error.capability} capability.`,
      };

    // --- 409: the lifecycle conflicts.
    case "ROUND_NOT_OPEN":
      return {
        statusCode: 409,
        message: `This round is ${error.status} and is not taking pledges.`,
      };
    case "ROUND_ALREADY_OPEN":
      return { statusCode: 409, message: "This round is already open." };
    case "ROUND_TERMINAL":
      return { statusCode: 409, message: `A ${error.status} round can no longer be changed.` };
    case "ROUND_CLOSED_FOR_PLEDGES":
      return {
        statusCode: 409,
        message: `This round closed at ${error.closesAt.toISOString()}.`,
      };
    case "PLEDGE_NOT_CANCELLABLE":
      return {
        statusCode: 409,
        // Naming the alternative, because "settled" is not a dead end — it is a refund,
        // which is a different entry against a different account (§7).
        message: `A ${error.status} pledge cannot be cancelled. Settled money leaves escrow as a refund, not a cancellation.`,
      };
    case "PLEDGE_NOT_PENDING":
      return { statusCode: 409, message: `This pledge is already ${error.status}.` };
    case "TRANSFER_NOT_SUBMITTABLE":
      return { statusCode: 409, message: `A ${error.status} transfer cannot be submitted.` };
    case "TRANSFER_ALREADY_TERMINAL":
      return { statusCode: 409, message: `This transfer is already ${error.status}.` };
    case "MILESTONE_TERMINAL":
      return { statusCode: 409, message: `A ${error.status} milestone can no longer be changed.` };
    case "MILESTONE_ALREADY_COMPLETE":
      return { statusCode: 409, message: "This milestone is already complete." };
    case "MILESTONE_ORDER_TAKEN":
      return {
        statusCode: 409,
        message: `Another milestone already occupies position ${error.orderIndex}.`,
      };
    case "RELEASE_ALREADY_REQUESTED":
      return {
        statusCode: 409,
        message: "This milestone already has a release request or an approved payout.",
      };
    case "RELEASE_ALREADY_DECIDED":
      return {
        statusCode: 409,
        message: `That release was already ${error.status} and is immutable.`,
      };
    case "MILESTONE_NOT_DONE":
      return {
        statusCode: 409,
        message: `Escrow releases against a milestone that is ${error.status} are not approvable. Complete it first.`,
      };
    case "EFFORT_WINDOWS_OPEN":
      return {
        statusCode: 409,
        // §7's gate on §9. Naming the counts tells a founder what to wait for rather than
        // leaving them to guess which of two subsystems is blocking a payout.
        message: `${error.openCount} open and ${error.disputedCount} disputed Proof-of-Effort window(s) must settle before escrow can be released.`,
      };
    case "INSUFFICIENT_ESCROW":
      return {
        statusCode: 409,
        message: "The escrow balance is below this release's amount.",
        errors: {
          escrow: [
            `Held ${error.availableInCents} cents; the release needs ${error.requiredInCents}.`,
          ],
        },
      };

    // --- 422: validation a schema could not do alone.
    case "SELF_APPROVAL_FORBIDDEN":
      return {
        statusCode: 422,
        // THE FOUR-EYES RULE, and §7 pins this status by number. It applies EVEN TO A
        // FOUNDER: the whole point is that two distinct people sign a payout.
        message:
          "An escrow release must be approved by somebody other than the person who requested it.",
        errors: { approver: ["The requester and the approver must be two different people."] },
      };
    case "SELF_PLEDGE_FORBIDDEN":
      return {
        statusCode: 422,
        message: "A founder cannot pledge to their own project's round.",
        errors: {
          amountInCents: [
            "Backer counts and raised totals exist to tell an outsider whether strangers believe in this project.",
          ],
        },
      };
    case "PLEDGE_BELOW_MINIMUM":
      return {
        statusCode: 422,
        message: "That pledge is below this round's minimum.",
        errors: { amountInCents: [`Minimum ${error.minimumInCents} cents.`] },
      };
    case "PLEDGE_ABOVE_MAXIMUM":
      return {
        statusCode: 422,
        message: "That pledge is above this round's maximum.",
        errors: { amountInCents: [`Maximum ${error.maximumInCents} cents.`] },
      };
    case "ROUND_INCOMPLETE_FOR_OPEN":
      return {
        statusCode: 422,
        message: "This round is not ready to open.",
        errors: { round: error.missing.map((field) => `${field} is required.`) },
      };
    case "MILESTONE_HAS_NO_RELEASE_AMOUNT":
      return {
        statusCode: 422,
        message: "This milestone has no escrow release amount, so there is nothing to release.",
        errors: { milestone: ["Set plannedPayoutInCents above zero first."] },
      };
    case "AUTHORIZING_ENTRY_MISSING":
      return {
        statusCode: 422,
        // A pledge with no authorizing entry is a broken invariant, not a user mistake —
        // but it is recoverable state rather than a crash, so it surfaces as a refusal to
        // settle rather than as a 500 that leaves the transfer half-decided.
        message:
          "This pledge has no authorizing ledger entry, so it cannot be settled. This is a ledger inconsistency, not a client error.",
      };

    // --- The chain. A break must PAGE, not render as a field in a 200 (§7, §9.9).
    case "ESCROW_CHAIN_BROKEN":
      return {
        statusCode: 409,
        message: `Escrow ledger broken at sequence ${error.sequenceNumber} (${error.reason}).`,
        errors: {
          chain: [
            `Entry ${error.sequenceNumber} failed the ${error.reason} check. This is an operational emergency: the ledger can no longer be trusted from that point forward.`,
          ],
        },
      };

    default: {
      // Adding a variant to any §7 service union without handling it here breaks the
      // build, which is the point (CLAUDE.md §3.2).
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled funding error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export function respondFundingError(res: Response, error: FundingDomainError): void {
  const { statusCode, message, errors } = mapFundingErrorToResponse(error);
  res.status(statusCode).json({ status: "error", statusCode, message, errors });
}
