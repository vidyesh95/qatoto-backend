import express from "express";

import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody, longFormBody } from "#src/middleware/json-body.js";
import { fundingRoundWriteLimiter, pledgeLimiter } from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import { requireIdentifiedUser } from "#src/middleware/require-identified-user.js";
import * as fundingController from "#src/modules/rnd/funding/funding.controller.js";

/**
 * Funding as a record of intent (R_AND_D_BACKEND_STRUCTURE.md §7, §11g).
 *
 * ESCROW IS GONE FROM THIS FILE. What remains is rounds, pledges and milestones, with the
 * custody removed from underneath them. A pledge is a COMMITMENT: no card is charged, no
 * funds are held, no fee is taken, and no client copy may imply otherwise.
 *
 * TWO ROUTERS, exactly as proof-of-effort.routes.ts exports a default plus
 * `integrationCallbackRouter`:
 *
 *   default            mounted at "/" — /funding-rounds, /pledges, /milestones and
 *                      /funding/deals. These are
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
 * write that COMMITS someone to something. That is a pledge and its cancellation, because
 * `requireAuth` proves a session exists and an anonymous sign-in creates a real session
 * (§4a Layer 1) — and `raisedAmountInCents`, `backersCount` and the investor-confidence
 * signal are exactly the numbers unlimited throwaway identities would inflate. It is NOT
 * on round and milestone planning writes, which are already behind a project role that an
 * anonymous account cannot hold.
 *
 * NO AUTHORIZATION MIDDLEWARE. Membership and role are proven inside each controller via
 * `requireProjectRole`, because a middleware cannot return a `Result` and so cannot
 * participate in the exhaustive error switch (§4a Layer 2). Failure is 404, not 403, so a
 * stranger cannot probe which projects exist.
 *
 * ROUTE ORDER: literal segments before `/:id`, everywhere. `/pledges/mine` precedes
 * `/pledges/:pledgeId/cancel`; `/funding/deals` shares no prefix with `/funding-rounds` at
 * all, because Express matches whole segments.
 *
 * **THERE IS NO `POST /webhooks/payments/stripe`, AND NO RAW-BODY MOUNT.** §11, and it is
 * now permanent rather than deferred: this domain moves no money at all, so there is no
 * provider to sign a webhook and nothing for one to say.
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
  // MONEY. A retried POST on a flaky connection must not record two commitments
  // (§11l.2 item 3). Honour-if-present: a caller sending no key gets today's behaviour.
  "/funding-rounds/:roundId/pledges",
  requireAuth,
  pledgeLimiter,
  idempotency(),
  requireIdentifiedUser,
  compactBody,
  fundingController.createPledge,
);

/**
 * PATCH · DELETE /funding-rounds/:roundId — founder only; drafts only (§11j.3).
 *
 * No `requireIdentifiedUser`, matching `createFundingRound` and the milestone writes: this
 * router's rule (see the header) puts that guard on writes that COMMIT someone — pledges —
 * not on round planning, which is already behind a project role an anonymous account cannot
 * hold. Declared after the `/open`, `/close`, `/backers`, `/pledge-options` and `/pledges`
 * routes, all of which are one segment deeper and cannot collide.
 */
router.patch(
  "/funding-rounds/:roundId",
  requireAuth,
  fundingRoundWriteLimiter,
  compactBody,
  fundingController.updateFundingRound,
);

router.delete(
  "/funding-rounds/:roundId",
  requireAuth,
  fundingRoundWriteLimiter,
  fundingController.deleteFundingRound,
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
//
// There is no literal under `/milestones/` today. A `GET /milestones/mine` added later
// MUST be declared above the read below, exactly as `/pledges/mine` is above
// `/pledges/:pledgeId/cancel`, or it resolves as a milestone whose id is "mine".

/** GET /milestones/:milestoneId — member only (§11j.2). */
router.get("/milestones/:milestoneId", requireAuth, fundingController.getMilestone);

router.patch(
  "/milestones/:milestoneId",
  requireAuth,
  fundingRoundWriteLimiter,
  longFormBody,
  fundingController.updateMilestone,
);

router.post(
  "/milestones/:milestoneId/complete",
  requireAuth,
  fundingRoundWriteLimiter,
  fundingController.completeMilestone,
);

/** DELETE /milestones/:milestoneId — refused once done, cancelled, or cited (§11j.3). */
router.delete(
  "/milestones/:milestoneId",
  requireAuth,
  fundingRoundWriteLimiter,
  fundingController.deleteMilestone,
);

router.put(
  "/milestones/:milestoneId/variance",
  requireAuth,
  fundingRoundWriteLimiter,
  compactBody,
  fundingController.putMilestoneVariance,
);

// --- THE ESCROW SUBTREE IS RETIRED (§7A.6, §11g).
//
// Nine routes are gone from this file: /milestones/:id/escrow-releases,
// /escrow-releases/:id/approve and /reject, /provider-transfers/pending, /settle and
// /fail, and the four /:projectSlug/escrow/* reads below. They return 404 now.
//
// NOT A COST DECISION AND NOT REVERSIBLE BY A BUDGET. Holding funds for later payout
// requires payment-institution authorisation under PSD2 in the EU, state
// money-transmitter licensing plus FinCEN registration in the US, and RBI
// payment-aggregator authorisation with a 15-crore net-worth floor in India — none of
// which turns on whether a fee is charged. Worse, escrow release had become the gate on
// cash compensation, which made a wage conditional on an algorithmic verdict: unlawful
// withholding under the FLSA, national EU wage law and 18 of India's Code on Wages 2019.
//
// What replaces them is compensation.routes.ts (7A): Qatoto computes what is owed,
// freezes it, and records the payment the parties make between themselves.
//
// The tables, services and migration 0016 are still on disk and in the database,
// unreachable and uncalled. The ledger design is preserved for the commerce domain in
// docs/ESCROW_LEDGER_STRUCTURE.md, where a buyer-seller hold is a real requirement.

/**
 * The project-scoped half, mounted at `/research-projects` AFTER the projects, workshop and
 * proof-of-effort routers. This one owns `/:projectSlug/funding-rounds`,
 * `/:projectSlug/milestones`, `/:projectSlug/compensation` and
 * `/:projectSlug/investor-confidence`.
 *
 * `/:projectSlug/audit-trail` is NOT here — §9's router already owns it. §7A's statement
 * chain is verified at `/:projectSlug/compensation-periods/:periodId/verify`, on the
 * compensation router.
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
  compactBody,
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
  longFormBody,
  fundingController.createMilestone,
);

// --- The four `/:projectSlug/escrow/*` reads are RETIRED. See the note above.

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
