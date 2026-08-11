import express from "express";

import * as commerceFulfillmentController from "#src/controllers/commerce-fulfillment.controller.js";
import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody } from "#src/middleware/json-body.js";
import { commerceFulfillmentWriteLimiter } from "#src/middleware/rate-limit.js";
import { requireActiveCommerceOrganization } from "#src/middleware/require-active-commerce-organization.js";
import { requireAuth } from "#src/middleware/require-auth.js";

const router = express.Router();

router.get(
  "/orders/:orderId/fulfillment",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceFulfillmentController.getOrderFulfillment,
);

router.post(
  "/orders/:orderId/shipments",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceFulfillmentWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceFulfillmentController.createShipment,
);

/**
 * A29. The cross-order logistics queue, scoped to the active organization as the
 * ORDER's counterparty.
 *
 * The join is the whole point of the route. `commerce_shipment` carries no organization
 * column, so the only client-side workaround was to list the provider's orders and fetch
 * each one's shipments — one request per order fanned out from a browser, and it cannot
 * be correct anyway, because the client holds one page of orders and a shipment on
 * order-page two is missing from a view claiming to list all of them.
 */
router.get(
  "/provider/shipments",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceFulfillmentController.listCounterpartyShipments,
);

/**
 * A38. The buyer half A29 left out, and the same argument applies unchanged from the other
 * side of the order: a buyer waiting on twelve shipments across nine orders had no route that
 * listed them either.
 *
 * DECLARED BEFORE `/shipments/:shipmentId` below. Both are `/shipments` + at most one segment,
 * and while Express prefers the exact path regardless,
 * `commerce-phase-21-reads.routes.order.test.ts` asserts the ordering so a future insert cannot
 * make `/shipments` read as an id.
 */
router.get(
  "/shipments",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceFulfillmentController.listBuyerShipments,
);

router.get(
  "/shipments/:shipmentId",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceFulfillmentController.getShipment,
);

router.post(
  "/shipments/:shipmentId/events",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceFulfillmentWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceFulfillmentController.appendShipmentEvent,
);

router.post(
  "/shipment-legs/:legId/commands",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceFulfillmentWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceFulfillmentController.executeShipmentLegCommand,
);

router.get(
  "/shipment-legs/:legId/events",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceFulfillmentController.listShipmentLegEvents,
);

router.get(
  "/service-engagements",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceFulfillmentController.listServiceEngagements,
);

router.get(
  "/service-engagements/:engagementId",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceFulfillmentController.getServiceEngagement,
);

router.get(
  "/service-engagements/:engagementId/events",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceFulfillmentController.listServiceEngagementEvents,
);

router.post(
  "/service-engagements/:engagementId/commands",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceFulfillmentWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceFulfillmentController.executeServiceEngagementCommand,
);

router.post(
  "/service-engagements/:engagementId/transitions",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceFulfillmentWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceFulfillmentController.transitionServiceEngagement,
);

export default router;
