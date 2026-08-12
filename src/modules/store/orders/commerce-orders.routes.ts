import express from "express";

import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody } from "#src/middleware/json-body.js";
import {
  commerceAddressRevealLimiter,
  commerceArrivalWindowReadLimiter,
  commerceOrderWriteLimiter,
} from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import * as commerceEarningsController from "#src/modules/store/orders/commerce-earnings.controller.js";
import * as commerceOrdersController from "#src/modules/store/orders/commerce-orders.controller.js";
import * as commerceSettlementAttestationController from "#src/modules/store/orders/commerce-settlement-attestation.controller.js";
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

/**
 * Phase 25. What this seller has been paid.
 *
 * DECLARED BEFORE `/orders/:orderId` for readability only — `/provider/earnings` cannot collide
 * with it, since the two differ in their first segment. It sits beside `/provider/orders`
 * because it answers the other half of the same question that page asks.
 *
 * A READ, so no idempotency and no body. It carries no rate limiter of its own: it is six
 * indexed aggregates against one organization's own rows, which is cheaper than the order list
 * beside it, and a seller refreshing their own revenue page is not an abuse pattern.
 */
router.get(
  "/provider/earnings",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceEarningsController.getSellerEarnings,
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

/**
 * Phase 25. The `direct_offline` rail's only record that money moved.
 *
 * BOTH PARTIES, not seller-only — the buyer attests `payment_sent` and the seller
 * `payment_received`, and the kind is derived from which side of the order the caller is on
 * rather than taken from the body. `requireActiveCommerceOrganization` is therefore the right
 * guard: the service, not the middleware, decides which claim this caller may make.
 *
 * The read is declared first so the pair reads as a surface rather than a write with an
 * afterthought, matching the refund routes' ordering and for the same stated reason.
 */
router.get(
  "/orders/:orderId/settlement-attestations",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceSettlementAttestationController.listSettlementAttestations,
);

router.post(
  "/orders/:orderId/settlement-attestations",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceOrderWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceSettlementAttestationController.recordSettlementAttestation,
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
