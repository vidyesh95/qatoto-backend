import express from "express";

import * as storeController from "#src/controllers/store.controller.js";
import { attachOptionalUser } from "#src/middleware/attach-optional-user.js";
import { storeReadLimiter } from "#src/middleware/rate-limit.js";

/**
 * Public buyer store surface (STORE_BACKEND_STRUCTURE.md §5).
 * `attachOptionalUser` precedes the limiter so signed-in viewers key by user id.
 */
const storeRouter = express.Router();

storeRouter.use(attachOptionalUser, storeReadLimiter);

storeRouter.get("/home", storeController.getHome);
storeRouter.get("/categories", storeController.listCategories);
storeRouter.get("/categories/:slug", storeController.getCategory);
storeRouter.get("/search", storeController.search);
storeRouter.get("/products/:productSlug", storeController.getProduct);
/**
 * Relation-graph companions for a product detail page (§15.7). Declared after the
 * detail route; Express matches the longer path on its own, and keeping them
 * adjacent makes the pair obvious.
 */
storeRouter.get("/products/:productSlug/companions", storeController.getProductCompanions);
/**
 * A16. Indicative only, and never a promise — see the controller. The destination is a
 * query parameter because the buyer has not chosen an address yet on a product page.
 */
storeRouter.get(
  "/products/:productSlug/delivery-estimate",
  storeController.getProductDeliveryEstimate,
);
storeRouter.get("/organizations/:organizationSlug", storeController.getOrganizationStorefront);
storeRouter.get("/providers", storeController.listProviders);
storeRouter.get("/providers/:organizationSlug", storeController.getProvider);
storeRouter.get("/services/:offeringSlug", storeController.getServiceOffering);
storeRouter.get("/pathways", storeController.listPathways);
storeRouter.get("/pathways/:pathwaySlug", storeController.getPathway);
storeRouter.get("/rails/:railSlug", storeController.getRail);

export default storeRouter;
