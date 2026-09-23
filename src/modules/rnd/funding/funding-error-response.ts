import type { Response } from "express";

import type { FundingError } from "#src/modules/rnd/funding/funding-rounds.service.js";
import type { InvestorConfidenceError } from "#src/modules/rnd/funding/investor-confidence.service.js";
import type { MilestoneError } from "#src/modules/rnd/funding/milestones.service.js";

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
export type FundingDomainError = FundingError | MilestoneError | InvestorConfidenceError;

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
    case "ROUND_TYPE_DISABLED":
      return {
        statusCode: 403,
        // §7's regulatory gate. PROOF_OF_EFFORT_SPEC.md §1 sequences equity crowdfunding
        // behind FINRA/SEC registration or a licensed broker-dealer partner, so this is a
        // fact about what this deployment is permitted to do — not about the caller.
        message: `${error.roundType} rounds are not enabled on this deployment.`,
        errors: { type: ["This round type is disabled by policy."] },
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
    // Only a DRAFT is editable. `status` here is never "draft" in practice — the guard also
    // refuses a draft carrying pledge counters, which is a data-repair case, not a client one.
    case "ROUND_NOT_EDITABLE":
      return {
        statusCode: 409,
        message: `A ${error.status} round can no longer be edited. Only a draft round can be changed.`,
      };
    // Named after ROLE_HAS_REFERENCES, and it points at the alternative rather than just
    // refusing: a round that has been opened is cancelled or closed, never deleted.
    // §11j.3 named a compensation_period_line citation here; no such FK exists — see
    // `deleteMilestone`. What actually blocks is an escrow_release row, which can survive
    // from migration 0016 even though those routes are retired.
    case "MILESTONE_HAS_REFERENCES":
      return {
        statusCode: 409,
        message: "This milestone is cited by an escrow release and cannot be deleted.",
      };
    case "ROUND_HAS_REFERENCES":
      return {
        statusCode: 409,
        message:
          "This round has been opened or carries a pledge, so it cannot be deleted. Close or cancel it instead.",
      };
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
    case "MILESTONE_TERMINAL":
      return { statusCode: 409, message: `A ${error.status} milestone can no longer be changed.` };
    case "MILESTONE_ALREADY_COMPLETE":
      return { statusCode: 409, message: "This milestone is already complete." };
    case "MILESTONE_ORDER_TAKEN":
      return {
        statusCode: 409,
        message: `Another milestone already occupies position ${error.orderIndex}.`,
      };
    // --- 422: validation a schema could not do alone.
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
    // The three CHECK constraints, proven in-service on the MERGED tuple so a partial patch
    // returns a typed 422 rather than a 23514 surfacing as a 500 (§11j.3).
    case "ROUND_GOAL_INVALID":
      return {
        statusCode: 422,
        message: "A funding goal must be greater than zero.",
        errors: { goalAmountInCents: ["Must be greater than zero."] },
      };
    case "ROUND_BOUNDS_INVALID":
      return {
        statusCode: 422,
        message: "The pledge bounds conflict.",
        errors: {
          // Both are named, because the conflict is between them: sending only a maximum
          // that falls below the STORED minimum is the case this exists for.
          minimumPledgeInCents: [`Resolved to ${error.minimumInCents}; must be at least 1.`],
          maximumPledgeInCents: [
            `Resolved to ${error.maximumInCents}; must be at least the minimum.`,
          ],
        },
      };
    case "ROUND_WINDOW_INVALID":
      return {
        statusCode: 422,
        message: "The round window closes before it opens.",
        errors: {
          closesAt: [
            `Resolved to ${error.closesAt.toISOString()}; must be after ${error.opensAt.toISOString()}.`,
          ],
        },
      };
    case "ROUND_INCOMPLETE_FOR_OPEN":
      return {
        statusCode: 422,
        message: "This round is not ready to open.",
        errors: { round: error.missing.map((field) => `${field} is required.`) },
      };
    // --- The chain. A break must PAGE, not render as a field in a 200 (§7, §9.9).
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
