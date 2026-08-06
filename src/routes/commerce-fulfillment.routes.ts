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
