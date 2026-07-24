import express from "express";

import * as fundingController from "#src/controllers/funding.controller.js";
import { parseCompactJsonBody } from "#src/middleware/json-body.js";
import {
  chainVerifyLimiter,
  escrowReleaseLimiter,
  escrowSettlementLimiter,
  fundingRoundWriteLimiter,
  pledgeLimiter,
} from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import { requireIdentifiedUser } from "#src/middleware/require-identified-user.js";

/**
 * Funding and escrow (R_AND_D_BACKEND_STRUCTURE.md §7, §11c).
 *
 * TWO ROUTERS, exactly as proof-of-effort.routes.ts exports a default plus
 * `integrationCallbackRouter`:
 *
 *   default            mounted at "/" — /funding-rounds, /pledges, /milestones,
 *                      /escrow-releases, /provider-transfers, /funding/deals. These are
 *                      keyed on an INTERNAL id rather than a project slug, because a
 *                      backer arriving from a deal-flow list has a round id and no reason
 *                      to know which project owns it. Each handler resolves the id to a
 *                      project and proves membership against THAT.
 *   projectFundingRouter  mounted at "/research-projects", AFTER the three routers already
 *                      on that prefix. No collision: their "/:projectSlug" matches exactly
 *                      one segment and never swallows a deeper path.
 *
 * CHAIN ORDER, everywhere: auth → limiter → requireIdentifiedUser → parser → controller.
 * The limiter precedes `requireIdentifiedUser` so an unidentified caller cannot hammer that
 * guard's extra query, and both follow `requireAuth` because every limiter keys on
 * `req.user.id`.
 *
 * WHERE `requireIdentifiedUser` GOES, by §4a's structural rule rather than by feel: every
 * write that MOVES MONEY or commits to moving it. That is a pledge, a cancellation, a
 * release request, an approval, a rejection and a settlement — because `requireAuth` proves
 * a session exists and an anonymous sign-in creates a real session (§4a Layer 1). It is
 * NOT on round and milestone planning writes, which are already behind a project role that
 * an anonymous account cannot hold.
 *
 * NO AUTHORIZATION MIDDLEWARE. Membership and role are proven inside each controller via
 * `requireProjectRole`, because a middleware cannot return a `Result` and so cannot
 * participate in the exhaustive error switch (§4a Layer 2). Failure is 404, not 403, so a
 * stranger cannot probe which projects exist.
 *
 * ROUTE ORDER: literal segments before `/:id`, everywhere. `/pledges/mine` precedes
 * `/pledges/:pledgeId/cancel`; `/provider-transfers/pending` precedes
 * `/provider-transfers/:transferId/settle`; `/funding/deals` shares no prefix with
 * `/funding-rounds` at all, because Express matches whole segments.
 *
 * **THERE IS NO `POST /webhooks/payments/stripe`, AND NO RAW-BODY MOUNT.** §11: the three
 * providers that would have signed a webhook are all deferred (Appendix A), and adding a
 * raw-body branch for a route that does not exist is a security surface bought for nothing.
 * Settlement runs through `POST /provider-transfers/:transferId/settle` instead, gated on
 * the platform `audit_escrow` capability.
 */

const router = express.Router();

// --- Rounds. `/funding/deals` is declared FIRST because it is the most specific literal
// --- path in this file and shares no segment with the rest.

/** `GET /funding/deals` — investor deal flow, filtered by ENABLED_FUNDING_ROUND_TYPES. */
router.get("/funding/deals", requireAuth, fundingController.listFundingDeals);

/** `GET /funding-rounds/:roundId` — public for an open round; 404 for a draft. */
router.get("/funding-rounds/:roundId", requireAuth, fundingController.getFundingRound);

router.get("/funding-rounds/:roundId/backers", requireAuth, fundingController.listRoundBackers);

/** The bounds the server will enforce. Advisory: `createPledge` re-derives all of them. */
router.get(
  "/funding-rounds/:roundId/pledge-options",
  requireAuth,
  fundingController.getPledgeOptions,
);

router.post(
  "/funding-rounds/:roundId/open",
  requireAuth,
  fundingRoundWriteLimiter,
  fundingController.openFundingRound,
);

router.post(
  "/funding-rounds/:roundId/close",
  requireAuth,
  fundingRoundWriteLimiter,
  fundingController.closeFundingRound,
);

/**
 * `POST /funding-rounds/:roundId/pledges` — body `{ amountInCents }` and nothing else.
 *
 * 201, and `raisedAmountInCents` has NOT moved. §7's 27 rejected keys all 422 here.
 */
router.post(
  "/funding-rounds/:roundId/pledges",
  requireAuth,
  pledgeLimiter,
  requireIdentifiedUser,
  parseCompactJsonBody,
  fundingController.createPledge,
);

// --- Pledges. `/mine` is a LITERAL and MUST precede `/:pledgeId/…`.

router.get("/pledges/mine", requireAuth, fundingController.listMyPledges);

router.post(
  "/pledges/:pledgeId/cancel",
  requireAuth,
  pledgeLimiter,
  requireIdentifiedUser,
  fundingController.cancelPledge,
);

// --- Milestones, keyed on their own id. Creation and listing are project-scoped and live
// --- on the other router.

router.patch(
  "/milestones/:milestoneId",
  requireAuth,
  fundingRoundWriteLimiter,
  parseCompactJsonBody,
  fundingController.updateMilestone,
);

router.post(
  "/milestones/:milestoneId/complete",
  requireAuth,
  fundingRoundWriteLimiter,
  fundingController.completeMilestone,
);

router.put(
  "/milestones/:milestoneId/variance",
  requireAuth,
  fundingRoundWriteLimiter,
  parseCompactJsonBody,
  fundingController.putMilestoneVariance,
);

/** `POST /milestones/:milestoneId/escrow-releases` — `{ requestNote? }`, NO amount field. */
router.post(
  "/milestones/:milestoneId/escrow-releases",
  requireAuth,
  escrowReleaseLimiter,
  requireIdentifiedUser,
  parseCompactJsonBody,
  fundingController.requestEscrowRelease,
);

// --- The four-eyes decision. Requester ≠ approver, checked in the service, EVEN FOR A
// --- FOUNDER, and answered 422 SELF_APPROVAL_FORBIDDEN.

router.post(
  "/escrow-releases/:releaseId/approve",
  requireAuth,
  escrowReleaseLimiter,
  requireIdentifiedUser,
  parseCompactJsonBody,
  fundingController.approveEscrowRelease,
);

router.post(
  "/escrow-releases/:releaseId/reject",
  requireAuth,
  escrowReleaseLimiter,
  requireIdentifiedUser,
  parseCompactJsonBody,
  fundingController.rejectEscrowRelease,
);

// --- Settlement. THE STAND-IN FOR THE STRIPE WEBHOOK (Appendix A3). `/pending` is a
// --- LITERAL and MUST precede `/:transferId/…`.

/** The settlement auditor's work queue. `audit_escrow` only. */
router.get("/provider-transfers/pending", requireAuth, fundingController.listPendingSettlements);

/**
 * The ONE path that moves `raisedAmountInCents`, `backersCount` and the settled balances.
 *
 * A HUMAN holding `audit_escrow`, never a timer and never the submitting worker: the
 * moment settlement becomes automatic, the audit story is that the system agreed with
 * itself. The capability is checked BEFORE the transfer is loaded, or the route becomes an
 * id oracle.
 */
router.post(
  "/provider-transfers/:transferId/settle",
  requireAuth,
  escrowSettlementLimiter,
  requireIdentifiedUser,
  parseCompactJsonBody,
  fundingController.decideSettlement("settled"),
);

router.post(
  "/provider-transfers/:transferId/fail",
  requireAuth,
  escrowSettlementLimiter,
  requireIdentifiedUser,
  parseCompactJsonBody,
  fundingController.decideSettlement("failed"),
);

/**
 * The project-scoped half, mounted at `/research-projects` AFTER the projects, workshop and
 * proof-of-effort routers. This one owns `/:projectSlug/funding-rounds`,
 * `/:projectSlug/milestones`, `/:projectSlug/escrow/*`, `/:projectSlug/compensation` and
 * `/:projectSlug/investor-confidence`.
 *
 * `/:projectSlug/audit-trail` is NOT here — §9's router already owns it, and the escrow
 * journal's own chain is exposed at `/escrow/verify` beside the ledger it verifies.
 */
export const projectFundingRouter = express.Router();

projectFundingRouter.get(
  "/:projectSlug/funding-rounds",
  requireAuth,
  fundingController.listProjectFundingRounds,
);

projectFundingRouter.post(
  "/:projectSlug/funding-rounds",
  requireAuth,
  fundingRoundWriteLimiter,
  parseCompactJsonBody,
  fundingController.createFundingRound,
);

projectFundingRouter.get(
  "/:projectSlug/milestones",
  requireAuth,
  fundingController.listProjectMilestones,
);

projectFundingRouter.post(
  "/:projectSlug/milestones",
  requireAuth,
  fundingRoundWriteLimiter,
  parseCompactJsonBody,
  fundingController.createMilestone,
);

// --- Escrow reads. `/escrow/verify` is a LITERAL and MUST precede
// --- `/escrow/ledger/:entryId/hash-input`; they are different paths, but the ordering
// --- rule is stated here so nobody later adds `/escrow/:something` above them.

projectFundingRouter.get(
  "/:projectSlug/escrow/summary",
  requireAuth,
  fundingController.getEscrowSummary,
);

/** A break returns 409 ESCROW_CHAIN_BROKEN — an operational emergency, not a 200 field. */
projectFundingRouter.get(
  "/:projectSlug/escrow/verify",
  requireAuth,
  chainVerifyLimiter,
  fundingController.verifyEscrowChain,
);

/** The anti-theatre endpoint: the canonical bytes, so a client can check our arithmetic. */
projectFundingRouter.get(
  "/:projectSlug/escrow/ledger/:entryId/hash-input",
  requireAuth,
  fundingController.getEscrowHashInput,
);

projectFundingRouter.get(
  "/:projectSlug/escrow/ledger",
  requireAuth,
  fundingController.listEscrowLedger,
);

projectFundingRouter.get(
  "/:projectSlug/compensation",
  requireAuth,
  fundingController.getProjectCompensation,
);

projectFundingRouter.get(
  "/:projectSlug/investor-confidence",
  requireAuth,
  fundingController.getInvestorConfidence,
);

export default router;
