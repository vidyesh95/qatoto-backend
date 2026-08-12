import express from "express";

import { attachOptionalUser } from "#src/middleware/attach-optional-user.js";
import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody, longFormBody } from "#src/middleware/json-body.js";
import {
  chainVerifyLimiter,
  compensationAgreementLimiter,
  compensationPeriodDecisionLimiter,
  paymentRecordLimiter,
} from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import { requireIdentifiedUser } from "#src/middleware/require-identified-user.js";
import * as compensationController from "#src/modules/rnd/compensation/compensation.controller.js";

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
  idempotency(),
  requireIdentifiedUser,
  compactBody,
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
  idempotency(),
  requireIdentifiedUser,
  compensationController.acceptCompensationAgreement,
);

/**
 * `POST …/compensation-agreements/:agreementId/decline` — THE SUBJECT ONLY (§11j.3).
 *
 * Propose and accept shipped without a way to say no, so a proposal the member did not want
 * sat `proposed` forever. `compactBody` because `{ note? }` is a body; `/accept`
 * has none.
 */
router.post(
  "/:projectSlug/compensation-agreements/:agreementId/decline",
  requireAuth,
  compensationAgreementLimiter,
  idempotency(),
  requireIdentifiedUser,
  compactBody,
  compensationController.declineCompensationAgreement,
);

/**
 * `POST …/compensation-agreements/:agreementId/withdraw` — FOUNDER only (§11j.3).
 *
 * The only endpoint that reaches `withdrawn`. Refused once accepted — a live agreement is
 * superseded, never retracted.
 */
router.post(
  "/:projectSlug/compensation-agreements/:agreementId/withdraw",
  requireAuth,
  compensationAgreementLimiter,
  idempotency(),
  requireIdentifiedUser,
  compactBody,
  compensationController.withdrawCompensationAgreement,
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
  idempotency(),
  requireIdentifiedUser,
  longFormBody,
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
  idempotency(),
  requireIdentifiedUser,
  compactBody,
  compensationController.countersignCompensationPeriod,
);

/** Corrections create a NEW period; nothing is ever edited (§4f). */
router.post(
  "/:projectSlug/compensation-periods/:periodId/supersede",
  requireAuth,
  compensationPeriodDecisionLimiter,
  idempotency(),
  requireIdentifiedUser,
  compactBody,
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
  compactBody,
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

/**
 * §7A's CROSS-PROJECT half, root-mounted (§11h, Appendix B3).
 *
 * A second router from this file rather than a second file, exactly as §7's funding domain
 * splits `fundingRouter` from `projectFundingRouter`: one domain, one route file, two
 * mounts. Root-mounted because someone arriving from the `/governance` stage page holds no
 * project slug and has not picked a project — that is the whole reason the page exists.
 *
 * `attachOptionalUser`, NOT `requireAuth`. This page publishes the three §7A.6 copy rules,
 * so it must render signed out. What a visitor gets is aggregates plus those rules, with
 * an empty `callerOpenLines` — never a fabricated example, never anyone else's figures.
 *
 * ONE ROUTE, AND IT IS A READ. `/finalize`, `/countersign`, `/payments`, `/confirm` and
 * `/export` are deliberately absent from this router: every one is actor-scoped and stays
 * on the project-scoped router above, where the actor's role is already resolved from the
 * slug. Re-exposing them here would mean re-deriving the actor from a body.
 */
export const governanceRouter = express.Router();

governanceRouter.get(
  "/governance/summary",
  attachOptionalUser,
  compensationController.getGovernanceSummary,
);

export default router;
