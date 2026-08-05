import express from "express";

import * as commerceOrdersController from "#src/controllers/commerce-orders.controller.js";
import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody } from "#src/middleware/json-body.js";
import { commerceOrderWriteLimiter } from "#src/middleware/rate-limit.js";
import {
  requireActiveBuyerCommerceOrganization,
  requireActiveCommerceOrganization,
} from "#src/middleware/require-active-commerce-organization.js";
import { requireAuth } from "#src/middleware/require-auth.js";

const router = express.Router();

router.get(
  "/orders",
  requireAuth,
  requireActiveBuyerCommerceOrganization,
  commerceOrdersController.listBuyerOrders,
);

router.get(
  "/provider/orders",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceOrdersController.listCounterpartyOrders,
);

router.get(
  "/orders/:orderId",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceOrdersController.getOrder,
);

router.post(
  "/orders/:orderId/cancel",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceOrderWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceOrdersController.cancelOrder,
);

export default router;
