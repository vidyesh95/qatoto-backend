import express from "express";

import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody } from "#src/middleware/json-body.js";
import {
  commerceAddressRevealLimiter,
  commerceArrivalWindowReadLimiter,
  commerceOrderWriteLimiter,
} from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import * as commerceOrdersController from "#src/modules/store/orders/commerce-orders.controller.js";
import {
  requireActiveBuyerCommerceOrganization,
  requireActiveCommerceOrganization,
} from "#src/modules/store/organizations/require-active-commerce-organization.js";

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

/**
 * A15. Declared before `/orders/:orderId/cancel` only for readability — Express matches
 * the longer path on its own. Rate-limited harder than any other order read because it
 * is the one endpoint that returns another organization's decrypted PII.
 */
router.get(
  "/orders/:orderId/delivery-address",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceAddressRevealLimiter,
  commerceOrdersController.getOrderDeliveryAddress,
);

/**
 * §19.4. Each call RATES A LANE — scanning rate cards and their bands, then resolving a dwell
 * estimate — so it carries its own tighter limiter rather than riding the ordinary order read.
 *
 * `?mode=` is optional and nothing is auto-selected without it; see the controller's schema.
 */
router.get(
  "/orders/:orderId/arrival-window",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceArrivalWindowReadLimiter,
  commerceOrdersController.getOrderArrivalWindow,
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
