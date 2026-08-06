import express from "express";

import * as commerceTrustController from "#src/controllers/commerce-trust.controller.js";
import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody } from "#src/middleware/json-body.js";
import {
  commerceDisputeWriteLimiter,
  commerceReviewWriteLimiter,
  commerceTrustModerationLimiter,
} from "#src/middleware/rate-limit.js";
import {
  requireActiveBuyerCommerceOrganization,
  requireActiveCommerceOrganization,
} from "#src/middleware/require-active-commerce-organization.js";
import { requireAuth } from "#src/middleware/require-auth.js";

const router = express.Router();

router.post(
  "/completions/:completionId/reviews",
  requireAuth,
  requireActiveBuyerCommerceOrganization,
  commerceReviewWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceTrustController.createReview,
);

router.post(
  "/orders/:orderId/disputes",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceDisputeWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceTrustController.openDispute,
);

router.get(
  "/admin/disputes",
  requireAuth,
  commerceTrustModerationLimiter,
  commerceTrustController.listModeratorDisputes,
);

router.post(
  "/admin/disputes/:disputeId/decisions",
  requireAuth,
  commerceTrustModerationLimiter,
  compactBody,
  idempotency({ required: true, scope: "user" }),
  commerceTrustController.decideDispute,
);

export default router;
