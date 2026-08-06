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
