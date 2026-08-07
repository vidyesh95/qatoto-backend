import express from "express";

import * as commerceProductQaController from "#src/controllers/commerce-product-qa.controller.js";
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
/**
 * A8. Reviews were write-only until this route existed — a buyer could post one and
 * nothing could ever display it.
 */
storeRouter.get("/products/:productSlug/reviews", storeController.listProductReviews);
/**
 * A9. The question list embeds at most ONE answer per question, seller's first; the
 * full answer list is its own paginated route, because a cursor over a computed
 * preference rank is how pagination starts skipping rows.
 */
storeRouter.get(
  "/products/:productSlug/questions",
  commerceProductQaController.listProductQuestions,
);
storeRouter.get(
  "/products/:productSlug/questions/:questionId/answers",
  commerceProductQaController.listProductQuestionAnswers,
);
storeRouter.get("/organizations/:organizationSlug", storeController.getOrganizationStorefront);
/**
 * A8. Not redundant with the product route: `commerce_review.productId` is nullable
 * because a service-engagement completion has no product, so reviews of a freight
 * forwarder or a testing lab are reachable ONLY here.
 */
storeRouter.get(
  "/organizations/:organizationSlug/reviews",
  storeController.listOrganizationReviews,
);
storeRouter.get("/providers", storeController.listProviders);
storeRouter.get("/providers/:organizationSlug", storeController.getProvider);
storeRouter.get("/services/:offeringSlug", storeController.getServiceOffering);
storeRouter.get("/pathways", storeController.listPathways);
storeRouter.get("/pathways/:pathwaySlug", storeController.getPathway);
storeRouter.get("/rails/:railSlug", storeController.getRail);

export default storeRouter;
