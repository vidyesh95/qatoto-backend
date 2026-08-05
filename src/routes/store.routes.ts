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
storeRouter.get("/organizations/:organizationSlug", storeController.getOrganizationStorefront);
storeRouter.get("/providers", storeController.listProviders);
storeRouter.get("/providers/:organizationSlug", storeController.getProvider);
storeRouter.get("/services/:offeringSlug", storeController.getServiceOffering);
storeRouter.get("/pathways", storeController.listPathways);
storeRouter.get("/pathways/:pathwaySlug", storeController.getPathway);
storeRouter.get("/rails/:railSlug", storeController.getRail);

export default storeRouter;
