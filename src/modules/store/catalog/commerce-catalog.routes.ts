import express from "express";

import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody, longFormBody } from "#src/middleware/json-body.js";
import { commerceProductRelationWriteLimiter } from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import * as commerceCatalogController from "#src/modules/store/catalog/commerce-catalog.controller.js";
import { requireActiveSellerCommerceOrganization } from "#src/modules/store/organizations/require-active-commerce-organization.js";

/**
 * The product relation graph's authoring surface (STORE_BACKEND_STRUCTURE.md §15.8).
 *
 * Public reads live on the store router; only writes are here. `moderate_commerce`
 * is checked INSIDE the service rather than in this chain, matching
 * `commerce-trust.routes.ts` — the capability is not probeable from the route table.
 */
const router = express.Router();

router.put(
  "/products/:productId/relations",
  requireAuth,
  requireActiveSellerCommerceOrganization,
  commerceProductRelationWriteLimiter,
  longFormBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceCatalogController.replaceProductRelations,
);

router.post(
  "/admin/product-relations/:relationId/verify",
  requireAuth,
  commerceProductRelationWriteLimiter,
  compactBody,
  // Scoped to the user, not an organization: a moderator acts for the platform and
  // may not even belong to a commerce organization.
  idempotency({ required: true, scope: "user" }),
  commerceCatalogController.verifyProductRelation,
);

export default router;
