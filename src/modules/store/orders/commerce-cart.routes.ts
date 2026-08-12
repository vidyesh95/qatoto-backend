import express from "express";

import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody } from "#src/middleware/json-body.js";
import {
  commerceCartWriteLimiter,
  commerceCheckoutWriteLimiter,
} from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import * as commerceMerchandisingController from "#src/modules/store/catalog/commerce-merchandising.controller.js";
import * as commerceCartController from "#src/modules/store/orders/commerce-cart.controller.js";
import * as commerceCheckoutController from "#src/modules/store/orders/commerce-checkout.controller.js";
/**
 * §14. Every route here but `checkout/confirm` runs on a PENDING buyer workspace. The
 * confirm keeps `requireActiveBuyerCommerceOrganization` because that is one of the four
 * places §14 said the trust gate still earns something — a cart is a draft, an order is not.
 */
import {
  requireActiveBuyerCommerceOrganization,
  requireProvisionedBuyerCommerceWorkspace,
} from "#src/modules/store/organizations/require-active-commerce-organization.js";

const router = express.Router();

router.get(
  "/cart",
  requireAuth,
  requireProvisionedBuyerCommerceWorkspace,
  commerceCartController.getCart,
);

router.put(
  "/cart/items/:productId",
  requireAuth,
  requireProvisionedBuyerCommerceWorkspace,
  commerceCartWriteLimiter,
  compactBody,
  idempotency({ scope: "active_organization" }),
  commerceCartController.setCartItem,
);

router.delete(
  "/cart/items/:productId",
  requireAuth,
  requireProvisionedBuyerCommerceWorkspace,
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
  requireProvisionedBuyerCommerceWorkspace,
  commerceCartWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceMerchandisingController.seedCartFromPathway,
);

router.post(
  "/checkout/prepare",
  requireAuth,
  requireProvisionedBuyerCommerceWorkspace,
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
