import express from "express";

import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody } from "#src/middleware/json-body.js";
import {
  commerceProductAnswerLimiter,
  commerceProductQuestionLimiter,
  commerceReviewVoteLimiter,
} from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import { requireIdentifiedUser } from "#src/middleware/require-identified-user.js";
import {
  requireActiveCommerceOrganization,
  requireActiveSellerCommerceOrganization,
} from "#src/modules/store/organizations/require-active-commerce-organization.js";
import * as commerceProductQaController from "#src/modules/store/trust/commerce-product-qa.controller.js";

/**
 * Product Q&A authoring (STORE Appendix A9).
 *
 * IDEMPOTENCY IS USER-SCOPED, never `active_organization`. The organization scope 400s
 * when `req.commerceOrganization` is absent, and every route here is legitimately
 * reachable by a caller with no organization at all — an asker always, and an answerer
 * whose standing the service resolves for itself.
 *
 * NO ORGANIZATION MIDDLEWARE ON THE AUTHORING ROUTES, for the same reason: the answer
 * route serves a seller and a verified buyer, whose organization requirements differ,
 * so a single guard would collapse two refusals into one and lose the distinction.
 * `requireIdentifiedUser` is the anti-sybil floor that does apply to all of them.
 *
 * THE A24 VOTE ROUTES ARE THE EXCEPTION, and it is not an inconsistency. A vote has
 * exactly one requirement — an active membership, because
 * `commerce_product_answer_vote` is keyed on the organization — so there is only one
 * refusal for a guard to collapse. They also carry no `idempotency()` and no
 * `compactBody`: PUT and DELETE of a boolean are idempotent by verb and neither has a
 * body, which is the reasoning `commerce-trust.routes.ts` records for the identical
 * review-vote pair.
 */
const commerceProductQaRouter = express.Router();

commerceProductQaRouter.post(
  "/products/:productId/questions",
  requireAuth,
  requireIdentifiedUser,
  commerceProductQuestionLimiter,
  compactBody,
  idempotency({ required: true, scope: "user" }),
  commerceProductQaController.askProductQuestion,
);

/**
 * Retraction keys on the question id alone, not `/products/:productId/questions/:id`.
 * A question id is already unique and the service authorizes it against the calling
 * author, so the product segment would be an unverified decoration — and the params
 * schema is `.strict()`, which would reject it rather than quietly ignore it.
 */
commerceProductQaRouter.delete(
  "/questions/:questionId",
  requireAuth,
  requireIdentifiedUser,
  commerceProductQuestionLimiter,
  commerceProductQaController.retractProductQuestion,
);

commerceProductQaRouter.post(
  "/questions/:questionId/answers",
  requireAuth,
  requireIdentifiedUser,
  commerceProductAnswerLimiter,
  compactBody,
  idempotency({ required: true, scope: "user" }),
  commerceProductQaController.answerProductQuestion,
);

commerceProductQaRouter.delete(
  "/answers/:answerId",
  requireAuth,
  requireIdentifiedUser,
  commerceProductAnswerLimiter,
  commerceProductQaController.retractProductAnswer,
);

/**
 * A24. Endorse an answer, and withdraw the endorsement. Reuses
 * `commerceReviewVoteLimiter` rather than minting a twin: the two surfaces are the same
 * action at the same cost, and one bucket is what makes a caller alternating between
 * them still bounded.
 */
commerceProductQaRouter.put(
  "/answers/:answerId/helpful",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceReviewVoteLimiter,
  commerceProductQaController.setAnswerHelpfulVote,
);

commerceProductQaRouter.delete(
  "/answers/:answerId/helpful",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceReviewVoteLimiter,
  commerceProductQaController.clearAnswerHelpfulVote,
);

/**
 * A38. The seller's cross-listing question queue — the first GET on this router.
 *
 * A9 shipped the answer write and only PUBLIC, PER-PRODUCT reads, so the only route to a
 * `questionId` was to walk one's own catalogue product by product from the browser. A seller
 * with two hundred listings could answer a question and could not find one.
 *
 * `requireActiveSellerCommerceOrganization`, not the generic guard: this list is defined by
 * listing ownership, and only a seller organization owns listings.
 */
commerceProductQaRouter.get(
  "/seller/questions",
  requireAuth,
  requireActiveSellerCommerceOrganization,
  commerceProductQaController.listSellerQuestionInbox,
);

export default commerceProductQaRouter;
