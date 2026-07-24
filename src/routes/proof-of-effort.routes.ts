import express from "express";

import * as proofOfEffortController from "#src/controllers/proof-of-effort.controller.js";
import { parseCompactJsonBody } from "#src/middleware/json-body.js";
import {
  chainVerifyLimiter,
  disputeLimiter,
  effortClaimLimiter,
  fairMarketRateLimiter,
} from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import { requireIdentifiedUser } from "#src/middleware/require-identified-user.js";
import { uploadPhysicalReceipt } from "#src/middleware/upload-physical-receipt.js";

const router = express.Router();

/**
 * Proof of Effort (R_AND_D_BACKEND_STRUCTURE.md §9, §11e).
 *
 * MOUNTED AT `/research-projects`, AFTER researchProjectsRouter and workshopRouter. No
 * collision: that router's `/:projectSlug` matches exactly one segment and never swallows
 * a deeper path, and this router owns `/:projectSlug/effort-claims/*`,
 * `/:projectSlug/equity/*`, `/:projectSlug/allocation-proposals/*`,
 * `/:projectSlug/disputes/*`, `/:projectSlug/audit-trail/*`, `/:projectSlug/slice-ledger`
 * and `/:projectSlug/proof-of-effort`.
 *
 * CHAIN ORDER, everywhere: auth → limiter → requireIdentifiedUser → parser → controller.
 * The limiter precedes `requireIdentifiedUser` so an unidentified caller cannot hammer
 * that guard's extra query, and both follow `requireAuth` because every limiter keys on
 * `req.user.id`.
 *
 * WHERE `requireIdentifiedUser` GOES, by §4a's structural rule rather than by feel: every
 * write that MINTS EQUITY or moves it. That is the whole of this router's mutation
 * surface — a rate proposal, a rate lock, a claim, a re-verification, a step override, a
 * dispute, a vote, a resolution — because `requireAuth` proves a session exists and an
 * anonymous sign-in creates a real session (§4a Layer 1). Equity minted by a throwaway
 * identity is the single worst outcome this domain has.
 *
 * NO SEPARATE AUTHORIZATION MIDDLEWARE. Membership and role are proven inside each
 * controller via `requireProjectRole`, because a middleware cannot return a `Result` and
 * so cannot participate in the exhaustive error switch (§4a Layer 2). Failure is 404, not
 * 403, so a stranger cannot probe which projects exist.
 *
 * ROUTE ORDER: literal segments before `/:id`, everywhere. `/audit-trail/verify` precedes
 * `/audit-trail/:entryId/hash-input`; `/fair-market-rate/lock` precedes
 * `/members/:memberUserId/fair-market-rate`; `/equity/snapshots` and
 * `/equity/open-role-projection` precede nothing but are declared before `/equity` for
 * readability.
 */

// --- Stakeholder reads. Members only; failure is 404.

/** GET /research-projects/:projectSlug/proof-of-effort — the page, in one round trip. */
router.get(
  "/:projectSlug/proof-of-effort",
  requireAuth,
  proofOfEffortController.getProofOfEffortSummary,
);

router.get(
  "/:projectSlug/equity/snapshots",
  requireAuth,
  proofOfEffortController.listEquitySnapshots,
);

/** The ghost segment that replaces the reserve pool (§9.5). Outside the denominator. */
router.get(
  "/:projectSlug/equity/open-role-projection",
  requireAuth,
  proofOfEffortController.getOpenRoleProjection,
);

router.get("/:projectSlug/equity", requireAuth, proofOfEffortController.getEquity);

router.get("/:projectSlug/slice-ledger", requireAuth, proofOfEffortController.listSliceLedger);

// --- The fair market rate. `/fair-market-rate/lock` is a LITERAL under :projectSlug and
// --- must precede the `/members/:memberUserId/...` family only in the sense that it is a
// --- different path entirely; declared first for prominence.

/** POST …/fair-market-rate/lock — founder only, irreversible, typed acknowledgement. */
router.post(
  "/:projectSlug/fair-market-rate/lock",
  requireAuth,
  fairMarketRateLimiter,
  requireIdentifiedUser,
  parseCompactJsonBody,
  proofOfEffortController.lockFairMarketRate,
);

router.get(
  "/:projectSlug/members/:memberUserId/fair-market-rate",
  requireAuth,
  proofOfEffortController.listFairMarketRateHistory,
);

/**
 * POST …/members/:memberUserId/fair-market-rate — founder only.
 *
 * THE ONE PLACE A RATE LEGITIMATELY ENTERS VIA A BODY (§0, §13). A negotiated input, not a
 * derived value — and the only other exception in the domain is a founder's advertised
 * equity band in §5.
 */
router.post(
  "/:projectSlug/members/:memberUserId/fair-market-rate",
  requireAuth,
  fairMarketRateLimiter,
  requireIdentifiedUser,
  parseCompactJsonBody,
  proofOfEffortController.proposeFairMarketRate,
);

/** POST …/fair-market-rate/:rateId/accept — the SUBJECT only. Makes "member-accepted" true. */
router.post(
  "/:projectSlug/members/:memberUserId/fair-market-rate/:rateId/accept",
  requireAuth,
  fairMarketRateLimiter,
  requireIdentifiedUser,
  proofOfEffortController.acceptFairMarketRate,
);

// --- Claims. `/effort-claims/:claimId/steps/:stepId/override` and `/reverify` are more
// --- specific than `/effort-claims/:claimId`, and Express matches in declaration order.

/** POST …/effort-claims — no minutes, no cash, no verdict, no slices. 202. */
router.post(
  "/:projectSlug/effort-claims",
  requireAuth,
  effortClaimLimiter,
  requireIdentifiedUser,
  parseCompactJsonBody,
  proofOfEffortController.submitEffortClaim,
);

router.post(
  "/:projectSlug/effort-claims/:claimId/reverify",
  requireAuth,
  effortClaimLimiter,
  requireIdentifiedUser,
  parseCompactJsonBody,
  proofOfEffortController.reverifyEffortClaim,
);

/** The only hand-edit in the domain — and it edits an AI judgement, not a number. */
router.patch(
  "/:projectSlug/effort-claims/:claimId/steps/:stepId/override",
  requireAuth,
  effortClaimLimiter,
  requireIdentifiedUser,
  parseCompactJsonBody,
  proofOfEffortController.overrideVerificationStep,
);

router.get(
  "/:projectSlug/effort-claims/:claimId",
  requireAuth,
  proofOfEffortController.getEffortClaim,
);

// --- Allocation proposals and disputes.

router.get(
  "/:projectSlug/allocation-proposals",
  requireAuth,
  proofOfEffortController.listAllocationProposals,
);

/** POST …/allocation-proposals/:proposalId/dispute — any active member, inside the window. */
router.post(
  "/:projectSlug/allocation-proposals/:proposalId/dispute",
  requireAuth,
  disputeLimiter,
  requireIdentifiedUser,
  parseCompactJsonBody,
  proofOfEffortController.raiseDispute,
);

router.post(
  "/:projectSlug/disputes/:disputeId/votes",
  requireAuth,
  disputeLimiter,
  requireIdentifiedUser,
  parseCompactJsonBody,
  proofOfEffortController.castDisputeVote,
);

/** POST …/disputes/:disputeId/withdraw — the raiser only; the ORIGINAL clock resumes. */
router.post(
  "/:projectSlug/disputes/:disputeId/withdraw",
  requireAuth,
  disputeLimiter,
  requireIdentifiedUser,
  proofOfEffortController.withdrawDispute,
);

/** POST …/disputes/:disputeId/resolve — founder only. `re_verified` returns 202. */
router.post(
  "/:projectSlug/disputes/:disputeId/resolve",
  requireAuth,
  disputeLimiter,
  requireIdentifiedUser,
  parseCompactJsonBody,
  proofOfEffortController.resolveDispute,
);

// --- The audit chain. `/verify` is a LITERAL and MUST precede `/:entryId/hash-input`.

router.get("/:projectSlug/audit-trail", requireAuth, proofOfEffortController.listAuditTrail);

/** A break returns 409 CHAIN_BROKEN — an operational emergency, not a field in a 200. */
router.get(
  "/:projectSlug/audit-trail/verify",
  requireAuth,
  chainVerifyLimiter,
  proofOfEffortController.verifyAuditChain,
);

/** The anti-theatre endpoint: the canonical bytes, so a client can check our arithmetic. */
router.get(
  "/:projectSlug/audit-trail/:entryId/hash-input",
  requireAuth,
  proofOfEffortController.getAuditHashInput,
);

// --- Physical receipts. The ONLY multipart route in this router; `uploadPhysicalReceipt`
// --- runs INSIDE the route so the global express.json() never touches a multipart body.

router.get(
  "/:projectSlug/physical-receipts",
  requireAuth,
  proofOfEffortController.listPhysicalReceipts,
);

/** POST …/physical-receipts — server-measured in every field. 202, 409, 413. */
router.post(
  "/:projectSlug/physical-receipts",
  requireAuth,
  effortClaimLimiter,
  requireIdentifiedUser,
  uploadPhysicalReceipt,
  proofOfEffortController.uploadPhysicalReceipt,
);

// --- Integration consent. A (project, member, provider) triple; revoke is SELF-ONLY.

router.get("/:projectSlug/integrations", requireAuth, proofOfEffortController.listIntegrations);

router.post(
  "/:projectSlug/integrations/:provider/authorize-url",
  requireAuth,
  fairMarketRateLimiter,
  requireIdentifiedUser,
  parseCompactJsonBody,
  proofOfEffortController.createIntegrationAuthorizeUrl,
);

router.delete(
  "/:projectSlug/integrations/:provider",
  requireAuth,
  fairMarketRateLimiter,
  requireIdentifiedUser,
  proofOfEffortController.revokeIntegration,
);

// --- Baking the pie. Irreversible, once ever, and there is no unbake route below.

router.get("/:projectSlug/pie-bake", requireAuth, proofOfEffortController.getPieBake);

router.post(
  "/:projectSlug/pie-bake",
  requireAuth,
  fairMarketRateLimiter,
  requireIdentifiedUser,
  parseCompactJsonBody,
  proofOfEffortController.bakePie,
);

// --- Optimization suggestions. `/accept` and `/dismiss` are literals under :suggestionId.

router.get(
  "/:projectSlug/optimization-suggestions",
  requireAuth,
  proofOfEffortController.listOptimizationSuggestions,
);

router.post(
  "/:projectSlug/optimization-suggestions",
  requireAuth,
  effortClaimLimiter,
  parseCompactJsonBody,
  proofOfEffortController.createOptimizationSuggestion,
);

router.post(
  "/:projectSlug/optimization-suggestions/:suggestionId/accept",
  requireAuth,
  effortClaimLimiter,
  parseCompactJsonBody,
  proofOfEffortController.decideOptimizationSuggestion("accepted"),
);

router.post(
  "/:projectSlug/optimization-suggestions/:suggestionId/dismiss",
  requireAuth,
  effortClaimLimiter,
  parseCompactJsonBody,
  proofOfEffortController.decideOptimizationSuggestion("dismissed"),
);

/**
 * The provider callback, mounted at the ROOT rather than under `/research-projects`.
 *
 * A provider's redirect URI is registered once with the app and cannot vary per project,
 * so this path carries no slug — the project comes out of the signed `state`, which is
 * also the only trustworthy statement of WHO started the flow (§11e).
 */
export const integrationCallbackRouter = express.Router();

integrationCallbackRouter.get(
  "/integrations/:provider/callback",
  // NO `requireAuth`. The caller is a provider redirect, and requiring a session here
  // would break the flow for anyone whose cookies did not survive the round trip — while
  // proving nothing, because the identity is in the signed state either way.
  proofOfEffortController.handleIntegrationCallback,
);

export default router;
