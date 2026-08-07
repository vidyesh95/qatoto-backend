import express from "express";

import * as commerceCartController from "#src/controllers/commerce-cart.controller.js";
import * as commerceCheckoutController from "#src/controllers/commerce-checkout.controller.js";
import * as commerceMerchandisingController from "#src/controllers/commerce-merchandising.controller.js";
import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody } from "#src/middleware/json-body.js";
import {
  commerceCartWriteLimiter,
  commerceCheckoutWriteLimiter,
} from "#src/middleware/rate-limit.js";
import { requireActiveBuyerCommerceOrganization } from "#src/middleware/require-active-commerce-organization.js";
import { requireAuth } from "#src/middleware/require-auth.js";

const router = express.Router();

router.get(
  "/cart",
  requireAuth,
  requireActiveBuyerCommerceOrganization,
  commerceCartController.getCart,
);

router.put(
  "/cart/items/:productId",
  requireAuth,
  requireActiveBuyerCommerceOrganization,
  commerceCartWriteLimiter,
  compactBody,
  idempotency({ scope: "active_organization" }),
  commerceCartController.setCartItem,
);

router.delete(
  "/cart/items/:productId",
  requireAuth,
  requireActiveBuyerCommerceOrganization,
  commerceCartWriteLimiter,
  compactBody,
  commerceCartController.removeCartItem,
);

/**
 * §15.4. Seeds the cart from a published guided set. Lives on the CART router rather
 * than the merchandising one because it is a buyer action on a buyer's cart — the
 * authoring routes belong to whoever composed the set, this one to whoever is buying it.
 */
router.post(
  "/cart/from-pathway/:pathwaySlug",
  requireAuth,
  requireActiveBuyerCommerceOrganization,
  commerceCartWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceMerchandisingController.seedCartFromPathway,
);

router.post(
  "/checkout/prepare",
  requireAuth,
  requireActiveBuyerCommerceOrganization,
  commerceCheckoutWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceCheckoutController.prepareCheckout,
);

router.post(
  "/checkout/confirm",
  requireAuth,
  requireActiveBuyerCommerceOrganization,
  commerceCheckoutWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceCheckoutController.confirmCheckout,
);

export default router;
