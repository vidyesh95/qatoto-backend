import express from "express";

import { attachOptionalUser } from "#src/middleware/attach-optional-user.js";
import { storeFactoryReadLimiter, storeReadLimiter } from "#src/middleware/rate-limit.js";
import * as categoryAttributesController from "#src/modules/store/catalog/commerce-category-attributes.controller.js";
import * as communityCofounderController from "#src/modules/store/community/community-cofounder.controller.js";
import * as communityForumController from "#src/modules/store/community/community-forum.controller.js";
import * as storeFactoriesController from "#src/modules/store/storefront/store-factories.controller.js";
import * as storeController from "#src/modules/store/storefront/store.controller.js";
import * as commerceProductQaController from "#src/modules/store/trust/commerce-product-qa.controller.js";

/**
 * Public buyer store surface (STORE_BACKEND_STRUCTURE.md §5).
 * `attachOptionalUser` precedes the limiter so signed-in viewers key by user id.
 */
const storeRouter = express.Router();

storeRouter.use(attachOptionalUser, storeReadLimiter);

storeRouter.get("/home", storeController.getHome);
storeRouter.get("/categories", storeController.listCategories);
storeRouter.get("/categories/:slug", storeController.getCategory);
/**
 * STORE §20. The RESOLVED attribute set for a category — its own definitions plus every
 * ancestor's. Public: the seller wizard needs it before a listing exists and the buyer's filter
 * row needs it before anyone signs in, and a definition is not a secret — it is the question the
 * category asks of every listing under it.
 *
 * Four segments, so it shadows nothing and nothing shadows it.
 */
storeRouter.get(
  "/categories/:slug/attributes",
  categoryAttributesController.getPublicCategoryAttributes,
);
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
/**
 * The manufacturer directory (§16, Appendix A32).
 *
 * These two carry a SECOND limiter on top of the router-wide `storeReadLimiter`, which is
 * the only place in this router that happens: the directory read fans out into five
 * batched queries plus a fulfillment-metrics aggregate over completed orders, so it is
 * several times the cost of a catalogue page.
 */
storeRouter.get("/factories", storeFactoryReadLimiter, storeFactoriesController.listFactories);
storeRouter.get(
  "/factories/:factorySlug",
  storeFactoryReadLimiter,
  storeFactoriesController.getFactory,
);
/**
 * The business forum's PUBLIC reads (§17, Appendix A33).
 *
 * `/store` IS A MOUNT POINT HERE, NOT A CONTEXT CLAIM (§1.1). A forum thread is community,
 * not commerce; it lives under this prefix because `/store` is what a signed-out visitor
 * browses, and the precedent is `commerceProductEngagementRouter`, which mounts at `/store`
 * while owning no store table. The WRITES are at `/community`.
 *
 * Neither read ever returns a `pending_review` thread.
 */
storeRouter.get("/forum/threads", communityForumController.listForumThreads);
storeRouter.get("/forum/threads/:threadSlug", communityForumController.getForumThread);
/**
 * The cofounder directory's PUBLIC reads (§18, Appendix A34). `published` only, and a
 * `not_looking` profile stays in the list — hiding one would make somebody who is
 * mid-conversation look as though they had left.
 */
storeRouter.get("/cofounder-profiles", communityCofounderController.listCofounderProfiles);
storeRouter.get(
  "/cofounder-profiles/:profileSlug",
  communityCofounderController.getCofounderProfile,
);

export default storeRouter;
