import express from "express";

import * as commerceFulfillmentController from "#src/controllers/commerce-fulfillment.controller.js";
import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody } from "#src/middleware/json-body.js";
import { commerceFulfillmentWriteLimiter } from "#src/middleware/rate-limit.js";
import { requireActiveCommerceOrganization } from "#src/middleware/require-active-commerce-organization.js";
import { requireAuth } from "#src/middleware/require-auth.js";

const router = express.Router();

router.post(
  "/orders/:orderId/shipments",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceFulfillmentWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceFulfillmentController.createShipment,
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

router.get(
  "/service-engagements",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceFulfillmentController.listServiceEngagements,
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
