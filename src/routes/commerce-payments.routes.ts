import express from "express";

import * as commercePaymentsController from "#src/controllers/commerce-payments.controller.js";
import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody } from "#src/middleware/json-body.js";
import { commercePaymentWriteLimiter } from "#src/middleware/rate-limit.js";
import {
  requireActiveBuyerCommerceOrganization,
  requireActiveCommerceOrganization,
} from "#src/middleware/require-active-commerce-organization.js";
import { requireAuth } from "#src/middleware/require-auth.js";

const router = express.Router();

router.post(
  "/orders/:orderId/payment-intents",
  requireAuth,
  requireActiveBuyerCommerceOrganization,
  commercePaymentWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "active_organization" }),
  commercePaymentsController.createPaymentIntent,
);

router.get(
  "/payments/:paymentIntentId",
  requireAuth,
  requireActiveCommerceOrganization,
  commercePaymentsController.getPaymentIntent,
);

/**
 * A38. The read half of refunds. Declared before the create so the pair reads as a surface
 * rather than a write with an afterthought — until Phase 21 there was only the write, and a
 * requested refund was invisible to both parties from the moment it was requested.
 *
 * No `Idempotency-Key`: a retried list changes nothing and has no body to key on (§6.8's rule).
 */
router.get(
  "/refunds",
  requireAuth,
  requireActiveCommerceOrganization,
  commercePaymentsController.listRefunds,
);

router.post(
  "/orders/:orderId/refunds",
  requireAuth,
  requireActiveCommerceOrganization,
  commercePaymentWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "active_organization" }),
  commercePaymentsController.createRefund,
);

export default router;
