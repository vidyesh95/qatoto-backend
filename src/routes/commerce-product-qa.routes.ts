import express from "express";

import * as commerceProductQaController from "#src/controllers/commerce-product-qa.controller.js";
import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody } from "#src/middleware/json-body.js";
import {
  commerceProductAnswerLimiter,
  commerceProductQuestionLimiter,
} from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import { requireIdentifiedUser } from "#src/middleware/require-identified-user.js";

/**
 * Product Q&A authoring (STORE Appendix A9).
 *
 * IDEMPOTENCY IS USER-SCOPED, never `active_organization`. The organization scope 400s
 * when `req.commerceOrganization` is absent, and every route here is legitimately
 * reachable by a caller with no organization at all — an asker always, and an answerer
 * whose standing the service resolves for itself.
 *
 * NO ORGANIZATION MIDDLEWARE anywhere in this file, for the same reason: the answer
 * route serves a seller and a verified buyer, whose organization requirements differ,
 * so a single guard would collapse two refusals into one and lose the distinction.
 * `requireIdentifiedUser` is the anti-sybil floor that does apply to all of them.
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

export default commerceProductQaRouter;
