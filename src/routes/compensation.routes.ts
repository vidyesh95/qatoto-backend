import express from "express";

import * as compensationController from "#src/controllers/compensation.controller.js";
import { parseCompactJsonBody } from "#src/middleware/json-body.js";
import {
  chainVerifyLimiter,
  compensationAgreementLimiter,
  compensationPeriodDecisionLimiter,
  paymentRecordLimiter,
} from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import { requireIdentifiedUser } from "#src/middleware/require-identified-user.js";

/**
 * Compensation statements (R_AND_D_BACKEND_STRUCTURE.md §7A, §11g).
 *
 * ONE ROUTER, mounted at `/research-projects` AFTER the projects, workshop, proof-of-effort
 * and funding routers. No collision: their `/:projectSlug` matches exactly one segment and
 * never swallows a deeper path. This one owns `/:projectSlug`'s
 * `/compensation-agreements/*`, `/compensation-periods/*`, `/compensation-period-lines/*`
 * and `/members/:memberUserId/compensation-agreement`.
 *
 * EVERYTHING IS PROJECT-SCOPED, deliberately — unlike §7's funding router, which has an
 * id-keyed half mounted at the root because a backer arriving from a deal-flow list holds
 * a round id and no project. Nobody reaches a compensation statement that way: every
 * reader is a member of the project whose statement it is, and scoping the path to the
 * slug means membership is proven from the URL rather than from a lookup.
 *
 * CHAIN ORDER, everywhere: auth → limiter → requireIdentifiedUser → parser → controller.
 * The limiter precedes `requireIdentifiedUser` so an unidentified caller cannot hammer that
 * guard's extra query, and both follow `requireAuth` because every limiter keys on
 * `req.user.id`.
 *
 * WHERE `requireIdentifiedUser` GOES, by §4a's structural rule rather than by feel: every
 * write that decides or attests to what someone is owed. `requireAuth` proves a session
 * exists, and `src/lib/auth.ts` registers the `anonymous()` plugin, so an anonymous
 * sign-in creates a real session — which must never be able to propose someone's pay,
 * accept it, freeze a statement, countersign one, or claim a payment was made.
 *
 * NO AUTHORIZATION MIDDLEWARE. Membership and role are proven inside each controller via
 * `requireProjectRole`, because a middleware cannot return a `Result` and so cannot
 * participate in the exhaustive error switch (§4a Layer 2). Failure is 404, not 403, so a
 * stranger cannot probe which projects exist.
 *
 * ROUTE ORDER: literal segments before `/:id`, everywhere. `/compensation-periods/:periodId
 * /verify` and `/export` are distinct trailing segments and cannot be swallowed, but the
 * rule is stated here so nobody later adds `/compensation-periods/:something` above them.
 *
 * **THERE IS NO `PATCH` ON A PERIOD OR A LINE, AND NO ENDPOINT THAT MARKS A LINE PAID.**
 * Both absences are §7A.5 verbatim. A finalized statement is corrected by superseding it,
 * and payment is an attestation plus a confirmation or it is not evidence.
 */

const router = express.Router();

// --- Agreements. What a member is paid in cash, effective-dated and member-accepted.

/** `GET /:projectSlug/compensation-agreements` — the full history, any member. */
router.get(
  "/:projectSlug/compensation-agreements",
  requireAuth,
  compensationController.listCompensationAgreements,
);

/** `POST /:projectSlug/members/:memberUserId/compensation-agreement` — founder proposes. */
router.post(
  "/:projectSlug/members/:memberUserId/compensation-agreement",
  requireAuth,
  compensationAgreementLimiter,
  requireIdentifiedUser,
  parseCompactJsonBody,
  compensationController.proposeCompensationAgreement,
);

/**
 * `POST /:projectSlug/compensation-agreements/:agreementId/accept` — THE SUBJECT ONLY.
 *
 * The service refuses anyone else with a 403. Acceptance is what makes "member-accepted"
 * true rather than decorative: without it the founder both sets and ratifies the number.
 */
router.post(
  "/:projectSlug/compensation-agreements/:agreementId/accept",
  requireAuth,
  compensationAgreementLimiter,
  requireIdentifiedUser,
  compensationController.acceptCompensationAgreement,
);

// --- Periods. An open one accrues; a finalized one is frozen and hash-chained.

router.get(
  "/:projectSlug/compensation-periods",
  requireAuth,
  compensationController.listCompensationPeriods,
);

router.get(
  "/:projectSlug/compensation-periods/:periodId",
  requireAuth,
  compensationController.getCompensationPeriod,
);

/**
 * `POST …/compensation-periods/:periodId/finalize` — `{ acknowledgement: "FINALIZE" }` and
 * NO AMOUNTS. There is no number in this body to tamper with (§17 step 4).
 */
router.post(
  "/:projectSlug/compensation-periods/:periodId/finalize",
  requireAuth,
  compensationPeriodDecisionLimiter,
  requireIdentifiedUser,
  parseCompactJsonBody,
  compensationController.finalizeCompensationPeriod,
);

/**
 * The four-eyes decision. Finalizer ≠ countersigner, checked in the service, EVEN FOR A
 * FOUNDER, and answered `422 SELF_COUNTERSIGN_FORBIDDEN`.
 */
router.post(
  "/:projectSlug/compensation-periods/:periodId/countersign",
  requireAuth,
  compensationPeriodDecisionLimiter,
  requireIdentifiedUser,
  parseCompactJsonBody,
  compensationController.countersignCompensationPeriod,
);

/** Corrections create a NEW period; nothing is ever edited (§4f). */
router.post(
  "/:projectSlug/compensation-periods/:periodId/supersede",
  requireAuth,
  compensationPeriodDecisionLimiter,
  requireIdentifiedUser,
  parseCompactJsonBody,
  compensationController.supersedeCompensationPeriod,
);

/** Gross amounts for the founder's payroll provider, with the §7A.6 notice in-band. */
router.get(
  "/:projectSlug/compensation-periods/:periodId/export",
  requireAuth,
  compensationController.exportCompensationPeriod,
);

/** A break returns `409 STATEMENT_CHAIN_BROKEN` — an emergency, not a 200 field. */
router.get(
  "/:projectSlug/compensation-periods/:periodId/verify",
  requireAuth,
  chainVerifyLimiter,
  compensationController.verifyCompensationChain,
);

// --- Payments. Attestations about money that moved somewhere else entirely.

/**
 * `POST …/compensation-period-lines/:lineId/payments` — founder or admin attests.
 *
 * Append-only. Records that a payment was made off-platform; moves nothing, changes no
 * line, and stores no account number, IBAN, UPI handle or card detail.
 */
router.post(
  "/:projectSlug/compensation-period-lines/:lineId/payments",
  requireAuth,
  paymentRecordLimiter,
  requireIdentifiedUser,
  parseCompactJsonBody,
  compensationController.recordCompensationPayment,
);

/**
 * `POST …/payments/:paymentId/confirm` — THE MEMBER ONLY.
 *
 * The other half of the evidence. Until this lands, every surface must show the payment as
 * unconfirmed and never as paid.
 */
router.post(
  "/:projectSlug/compensation-period-lines/:lineId/payments/:paymentId/confirm",
  requireAuth,
  paymentRecordLimiter,
  requireIdentifiedUser,
  compensationController.confirmCompensationPayment,
);

export default router;
